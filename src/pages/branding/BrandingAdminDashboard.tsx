import { useState, useEffect, useCallback, useMemo, useRef, Fragment, type ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import { useAuth } from '@/hooks/useAuth'
import { useAppData } from '@/hooks/useAppData'
import { brandingApi } from '@/lib/branding-api'
import { MONTHS } from '@/lib/branding-types'
import type {
  WorkCategory, KraParameter, KraReport,
  AdminKraScore, PeerMarking, BrandingLeave,
} from '@/lib/branding-types'
import {
  Plus, Trash2, Edit3,
  ChevronDown, ChevronUp, ChevronLeft, ChevronRight, Check, AlertTriangle, Lock,
  Download, Users, Filter, X,
  GripVertical, CalendarOff, ArrowLeft,
} from 'lucide-react'
import BrandingAdminOverview from './BrandingAdminOverview'
import BrandingAdminShell from './BrandingAdminShell'
import {
  DS, cx, Badge, Modal, EmptyState, Avatar, Spinner, toneForStatus,
  PeriodBar, Segmented, BlockHeader, CardHead, InfoNote, MiniStat, StatusPill,
  kraTone, ScorePips,
} from './ds'
import { toast } from 'sonner'

// ── Helpers ────────────────────────────────────────────────────────────────

// Roles whose members manage the team rather than submit daily reports.
// Used to filter the admin dashboard's user surfaces so admins don't
// appear in cards, KRA cubes, top contributors, etc.
const NON_SUBMITTING_ROLES = new Set(['super_admin', 'admin', 'branding_reports_admin'])

const INP = DS.input

function scoreAvg(scores: Record<string, number> | null | undefined, params: KraParameter[]): number | null {
  if (!scores || params.length === 0) return null
  const vals = params.map(p => scores[p.id]).filter(v => v !== undefined) as number[]
  if (vals.length === 0) return null
  return Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10
}

/** Stored score → 1–5 pip level. A 5-scale value is its own level; a
 *  10-scale value maps down (7/10 → level 4). */
function kraLevel(v: number | null | undefined, scale: number): number | undefined {
  if (v === null || v === undefined) return undefined
  return scale === 5 ? v : Math.round((v / scale) * 5)
}

/** Pip level → stored value on the parameter's own scale (level 4 on a
 *  10-scale writes 8). On a 5-scale the level is written as-is. */
function kraFromLevel(level: number, scale: number): number {
  return Math.round((level * scale) / 5)
}

/** One KRA parameter tile — the same tile the Self Appraisal page uses:
 *  tinted by its score, name, description, pips on the left, score on the
 *  right. Read-only when no onSelect is given. */
function KraParamTile({ p, value, onSelect }: {
  p: KraParameter; value: number | null | undefined; onSelect?: (v: number) => void
}) {
  const scale = p.max_score || 5
  const tone = kraTone(value, scale)
  return (
    <div className={cx('flex flex-col rounded-[6px] border p-4 transition-colors', tone?.card ?? 'border-[#C5CAD1] bg-[#F9FAFB] hover:border-[#9CA3AF]')}>
      <p className="text-sm font-semibold text-[#111827] tracking-tight">{p.name}</p>
      {p.description && <p className="mt-1 text-xs leading-relaxed text-[#6B7280]">{p.description}</p>}
      <div className="mt-auto pt-4 flex items-center justify-between gap-x-3 gap-y-2 flex-wrap">
        <ScorePips
          value={kraLevel(value, scale)}
          label={p.name}
          onSelect={onSelect ? lvl => onSelect(kraFromLevel(lvl, scale)) : undefined}
        />
        <span className={cx('shrink-0 text-sm font-semibold tabular-nums', tone?.score ?? 'text-[#111827]')}>
          {value ?? <span className="text-[#9CA3AF]">&ndash;</span>}
          <span className="text-xs font-semibold text-[#9CA3AF]">/{scale}</span>
        </span>
      </div>
    </div>
  )
}

/** The Self Appraisal parameter grid: three per row from xl, two at md, one on a phone. */
function KraParamGrid({ params, scores, onChange }: {
  params: KraParameter[]; scores: Record<string, number> | null | undefined
  onChange?: (id: string, v: number) => void
}) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      {params.map(p => (
        <KraParamTile key={p.id} p={p} value={scores?.[p.id]} onSelect={onChange ? v => onChange(p.id, v) : undefined} />
      ))}
    </div>
  )
}

/** Team member tile — ChoiceTile's exact surface with an Avatar where the
 *  icon sits (ChoiceTile's icon slot takes a lucide component, not a node). */
function MemberTile({ active, avatarUrl, name, desc, trailing, onClick }: {
  active: boolean; avatarUrl?: string | null; name: string; desc: ReactNode; trailing?: ReactNode; onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cx(
        'rounded-[6px] p-4 text-left border transition-all hover:shadow-sm w-full cursor-pointer',
        active ? 'border-bp-600 bg-bp-50' : 'bg-white border-[#C5CAD1] hover:border-bp-300',
      )}
    >
      <div className="flex items-center gap-2 mb-1">
        <Avatar url={avatarUrl} name={name} size="sm" className={active ? 'ring-2 ring-bp-200' : ''} />
        <span className={cx('text-sm font-semibold tracking-tight truncate', active ? 'text-[#111827]' : 'text-[#6B7280]')}>{name}</span>
        {trailing && <span className="ml-auto shrink-0">{trailing}</span>}
      </div>
      <p className="text-xs font-medium text-[#6B7280]">{desc}</p>
    </button>
  )
}

// ── Manage Categories Tab ─────────────────────────────────────────────────

function ManageCategoriesTab() {
  const [categories, setCategories] = useState<WorkCategory[]>([])
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [editingCat, setEditingCat] = useState<{ id: string; name: string } | null>(null)
  const [editingSub, setEditingSub] = useState<{ id: string; name: string } | null>(null)
  const [newCatName, setNewCatName] = useState('')
  const [newSubName, setNewSubName] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)

  const load = useCallback(() => {
    setLoading(true)
    brandingApi.getCategories()
      .then(r => setCategories(r.categories))
      .catch(() => toast.error('Failed to load categories'))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { load() }, [load])

  async function addCategory() {
    const name = newCatName.trim()
    if (!name) return
    try {
      await brandingApi.createCategory(name)
      setNewCatName('')
      load()
      toast.success('Category added')
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed') }
  }

  async function saveCategory(id: string, name: string) {
    try {
      await brandingApi.updateCategory(id, name)
      setEditingCat(null)
      load()
      toast.success('Category updated')
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed') }
  }

  async function deleteCategory(id: string, name: string) {
    if (!confirm(`Delete category "${name}"? Historical report data using this category will be preserved but it will not appear in new reports.`)) return
    try {
      await brandingApi.deleteCategory(id)
      load()
      toast.success('Category deleted')
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed') }
  }

  async function addSubCategory(catId: string) {
    const name = (newSubName[catId] || '').trim()
    if (!name) return
    try {
      await brandingApi.createSubCategory(catId, name)
      setNewSubName(p => ({ ...p, [catId]: '' }))
      load()
      toast.success('Sub-category added')
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed') }
  }

  async function saveSubCategory(id: string, name: string) {
    try {
      await brandingApi.updateSubCategory(id, name)
      setEditingSub(null)
      load()
      toast.success('Updated')
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed') }
  }

  async function deleteSubCategory(id: string, name: string) {
    if (!confirm(`Delete sub-category "${name}"?`)) return
    try {
      await brandingApi.deleteSubCategory(id)
      load()
      toast.success('Deleted')
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed') }
  }

  // Reorder by dragging a row's grip onto another row: the dragged
  // category takes that row's position and the rest shift.
  const [dragId, setDragId] = useState<string | null>(null)
  const [dragOverId, setDragOverId] = useState<string | null>(null)
  async function dropCategory(targetId: string) {
    const from = categories.findIndex(c => c.id === dragId)
    const to = categories.findIndex(c => c.id === targetId)
    setDragId(null); setDragOverId(null)
    if (from < 0 || to < 0 || from === to) return
    const newOrder = [...categories]
    const [moved] = newOrder.splice(from, 1)
    newOrder.splice(to, 0, moved)
    setCategories(newOrder)
    await brandingApi.reorderCategories(newOrder.map(c => c.id))
  }

  if (loading) return <div className="flex items-center justify-center gap-2 py-10 text-sm text-[#6B7280] font-medium"><Spinner /> Loading categories…</div>

  return (
    <div className="space-y-4">
      <div>
        <BlockHeader
          title="Categories"
          subtitle="Work categories and sub-categories the team reports against"
          chip={`${categories.length} categor${categories.length === 1 ? 'y' : 'ies'}`}
        />
        {/* Add-new-category panel — a wide bar above the grid so it's discoverable. */}
        <div className={cx(DS.card, DS.cardPad, 'space-y-4')}>
          <CardHead title="Add New Category" subtitle='A default "Others" sub-category is automatically added to every new category.' />
          <div className="flex gap-2">
            <input value={newCatName} onChange={e => setNewCatName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') void addCategory() }}
              placeholder="Category name…" className={INP + ' flex-1'} />
            <button onClick={() => void addCategory()}
              className={cx(DS.btn, DS.btnPrimary)}>
              <Plus className="w-4 h-4" /> Add
            </button>
          </div>
        </div>
      </div>

      {/* Table — one row per category in report order. Drag the grip to
          reorder; the sub-category count opens an inline editor row beneath. */}
      {categories.length === 0 ? (
        <div className={DS.card}><EmptyState icon={Filter} title="No categories yet." body="Add a category above to get started." /></div>
      ) : (
        <div className={cx(DS.card, 'overflow-hidden')}>
          <div className="overflow-x-auto">
            <table className={cx(DS.table, 'min-w-[640px]')}>
              <thead className={DS.thead}>
                <tr>
                  <th className={cx(DS.th, 'w-10 !px-3')} aria-label="Reorder" />
                  <th className={cx(DS.th, 'w-12')}>#</th>
                  <th className={DS.th}>Category</th>
                  <th className={DS.th}>Sub-categories</th>
                  <th className={cx(DS.th, 'w-32 !text-right')}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {categories.map((cat, catIdx) => {
                  const isExpanded = expanded.has(cat.id)
                  const isEditing = editingCat?.id === cat.id
                  const cell = cx(DS.td, '!py-2 align-middle')
                  return (
                    <Fragment key={cat.id}>
                      <tr
                        draggable
                        onDragStart={e => { setDragId(cat.id); e.dataTransfer.effectAllowed = 'move' }}
                        onDragOver={e => { e.preventDefault(); if (dragOverId !== cat.id) setDragOverId(cat.id) }}
                        onDragLeave={() => { if (dragOverId === cat.id) setDragOverId(null) }}
                        onDrop={e => { e.preventDefault(); void dropCategory(cat.id) }}
                        onDragEnd={() => { setDragId(null); setDragOverId(null) }}
                        className={cx(
                          'group border-t border-[#C5CAD1] transition-colors',
                          dragOverId === cat.id && dragId !== cat.id ? 'bg-[var(--nerve-primary-soft)]' : DS.trHover,
                          dragId === cat.id && 'opacity-50',
                        )}
                      >
                        <td className={cx(cell, '!px-3 text-[#9CA3AF] cursor-grab active:cursor-grabbing')} title="Drag to reorder">
                          <GripVertical className="w-4 h-4" strokeWidth={1.75} />
                        </td>
                        <td className={cx(cell, 'text-[12px] text-[#9CA3AF] tabular-nums')}>{catIdx + 1}</td>
                        <td className={cell}>
                          {isEditing ? (
                            <div className="flex items-center gap-1.5 max-w-sm">
                              <input value={editingCat!.name}
                                onChange={e => setEditingCat(p => p ? { ...p, name: e.target.value } : p)}
                                onKeyDown={e => { if (e.key === 'Enter') void saveCategory(cat.id, editingCat!.name); if (e.key === 'Escape') setEditingCat(null) }}
                                className={cx(INP, '!h-8 font-semibold')} autoFocus />
                              <button onClick={() => void saveCategory(cat.id, editingCat!.name)}
                                className={cx(DS.iconBtnSm, '!bg-[var(--nerve-primary)] !border-[var(--nerve-primary)] !text-[var(--nerve-on-primary)]')} title="Save" aria-label="Save">
                                <Check className="w-3.5 h-3.5" />
                              </button>
                              <button onClick={() => setEditingCat(null)} className={DS.iconBtnSm} title="Cancel" aria-label="Cancel">
                                <X className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          ) : (
                            <span className="text-[13px] font-semibold text-[#111827]">{cat.name}</span>
                          )}
                        </td>
                        <td className={cell}>
                          <button
                            onClick={() => setExpanded(p => { const n = new Set(p); if (n.has(cat.id)) n.delete(cat.id); else n.add(cat.id); return n })}
                            className={DS.link}
                            aria-expanded={isExpanded}>
                            {cat.sub_categories.length} sub-categor{cat.sub_categories.length === 1 ? 'y' : 'ies'}
                            {isExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                          </button>
                        </td>
                        <td className={cx(cell, '!text-right')}>
                          {!isEditing && (
                            <div className="inline-flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                              <button onClick={() => setEditingCat({ id: cat.id, name: cat.name })}
                                className={DS.iconBtnSm} title="Rename" aria-label="Rename">
                                <Edit3 className="w-3.5 h-3.5" />
                              </button>
                              <button onClick={() => void deleteCategory(cat.id, cat.name)}
                                className={cx(DS.iconBtnSm, '!text-[#DC2626] hover:!bg-[#FEF2F2] hover:!border-[#FECACA]')} title="Delete" aria-label="Delete">
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          )}
                        </td>
                      </tr>

                      {/* Sub-categories — an inline editor row beneath the category. */}
                      {isExpanded && (
                        <tr className="border-t border-[#C5CAD1] bg-[#F9FAFB]">
                          <td colSpan={5} className="px-4 py-3">
                            <div className="pl-10">
                              <div className="divide-y divide-[#E5E7EB] rounded-[6px] border border-[#C5CAD1] bg-white">
                                {cat.sub_categories.map(sub => (
                                  <div key={sub.id} className="flex items-center gap-2 h-10 px-3 group/sub">
                                    {editingSub?.id === sub.id ? (
                                      <div className="flex items-center gap-1.5 flex-1">
                                        <input value={editingSub.name}
                                          onChange={e => setEditingSub(p => p ? { ...p, name: e.target.value } : p)}
                                          onKeyDown={e => { if (e.key === 'Enter') void saveSubCategory(sub.id, editingSub.name); if (e.key === 'Escape') setEditingSub(null) }}
                                          className={cx(INP, '!h-8 max-w-sm')} autoFocus />
                                        <button onClick={() => void saveSubCategory(sub.id, editingSub.name)}
                                          className={cx(DS.iconBtnSm, '!bg-[var(--nerve-primary)] !border-[var(--nerve-primary)] !text-[var(--nerve-on-primary)]')} title="Save" aria-label="Save">
                                          <Check className="w-3.5 h-3.5" />
                                        </button>
                                        <button onClick={() => setEditingSub(null)} className={DS.iconBtnSm} title="Cancel" aria-label="Cancel">
                                          <X className="w-3.5 h-3.5" />
                                        </button>
                                      </div>
                                    ) : (
                                      <>
                                        <span className="text-[13px] text-[#111827] flex-1 truncate">{sub.name}</span>
                                        {sub.is_others ? (
                                          <Badge tone="neutral">default</Badge>
                                        ) : (
                                          <div className="flex items-center gap-1 opacity-0 group-hover/sub:opacity-100 focus-within:opacity-100 transition-opacity">
                                            <button onClick={() => setEditingSub({ id: sub.id, name: sub.name })}
                                              className={DS.iconBtnSm} title="Rename" aria-label="Rename">
                                              <Edit3 className="w-3.5 h-3.5" />
                                            </button>
                                            <button onClick={() => void deleteSubCategory(sub.id, sub.name)}
                                              className={cx(DS.iconBtnSm, '!text-[#DC2626] hover:!bg-[#FEF2F2] hover:!border-[#FECACA]')} title="Delete" aria-label="Delete">
                                              <Trash2 className="w-3.5 h-3.5" />
                                            </button>
                                          </div>
                                        )}
                                      </>
                                    )}
                                  </div>
                                ))}
                                {cat.name !== 'Others' && (
                                  <div className="flex gap-2 p-2">
                                    <input
                                      value={newSubName[cat.id] || ''}
                                      onChange={e => setNewSubName(p => ({ ...p, [cat.id]: e.target.value }))}
                                      onKeyDown={e => { if (e.key === 'Enter') void addSubCategory(cat.id) }}
                                      placeholder="Add sub-category…"
                                      className={cx(INP, '!h-8 max-w-sm')} />
                                    <button onClick={() => void addSubCategory(cat.id)}
                                      className={cx(DS.btn, DS.btnPrimary, DS.btnSm)}>
                                      <Plus className="w-3.5 h-3.5" /> Add
                                    </button>
                                  </div>
                                )}
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

// ── KRA Management Tab ─────────────────────────────────────────────────────

function KraManagementTab({ brandingUsers }: { brandingUsers: { id: string; full_name: string; email: string; avatar_url: string | null }[] }) {
  const { profile } = useAuth()
  const [month, setMonth] = useState(new Date().getMonth() + 1)
  const [year, setYear]   = useState(new Date().getFullYear())
  const [dashboard, setDashboard]     = useState<KraReport[]>([])
  const [params, setParams]           = useState<KraParameter[]>([])
  const [peerEnabled, setPeerEnabled] = useState(false)
  const [selectedUser, setSelectedUser] = useState<string | null>(null)
  // On phones and tablets the scoring panel opens inline, so it behaves like
  // a page: opening it pushes a history entry and the device's Back button
  // (or the panel's own Back) closes it instead of leaving KRA Management.
  const panelPushedRef = useRef(false)
  useEffect(() => {
    const small = window.matchMedia('(max-width: 1023px)').matches
    if (!selectedUser || !small) return
    if (!panelPushedRef.current) {
      window.history.pushState({ kraPanel: true }, '')
      panelPushedRef.current = true
    }
    const onPop = () => { panelPushedRef.current = false; setSelectedUser(null) }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [selectedUser])
  const closePanel = () => {
    if (panelPushedRef.current) window.history.back()
    else setSelectedUser(null)
  }
  const [adminScores, setAdminScores] = useState<Record<string, number>>({})
  const [adminSaving, setAdminSaving] = useState(false)
  const [loading, setLoading]         = useState(false)
  const [finalPushState, setFinalPushState] = useState<'idle' | 'confirm1' | 'confirm2'>('idle')
  const [peerMarkings, setPeerMarkings] = useState<PeerMarking[]>([])
  const [showPeerMarkings, setShowPeerMarkings] = useState(false)
  const [userPeerMarkings, setUserPeerMarkings] = useState<PeerMarking[]>([])
  const [userPeerLoading, setUserPeerLoading] = useState(false)
  const [detailTab, setDetailTab] = useState<'admin' | 'self' | 'peer'>('admin')
  // Manual penalty modal state
  const [penaltyOpen, setPenaltyOpen] = useState(false)
  const [penaltyPct, setPenaltyPct] = useState('0')
  const [penaltyReason, setPenaltyReason] = useState('')
  const [penaltySaving, setPenaltySaving] = useState(false)
  // Total-penalty override modal state
  const [overrideOpen, setOverrideOpen] = useState(false)
  const [overrideEnabled, setOverrideEnabled] = useState(false)
  const [overridePct, setOverridePct] = useState('0')
  const [overrideReason, setOverrideReason] = useState('')
  const [overrideSaving, setOverrideSaving] = useState(false)

  const load = useCallback(() => {
    setLoading(true)
    Promise.all([
      brandingApi.getAdminKraDashboard(month, year),
      brandingApi.getKraParameters(),
      brandingApi.getPeerMarkingEnabled(),
    ])
      .then(([d, p, e]) => {
        setDashboard(d.dashboard)
        setParams(p.parameters)
        setPeerEnabled(e.enabled)
      })
      .catch(() => toast.error('Failed to load KRA data'))
      .finally(() => setLoading(false))
  }, [month, year])

  useEffect(() => { load() }, [load])

  // Load admin scores + peer markings when selecting a user
  useEffect(() => {
    if (!selectedUser) return
    brandingApi.getAdminScore(selectedUser, month, year)
      .then(r => setAdminScores(r.score?.scores || Object.fromEntries(params.map(p => [p.id, 5]))))
      .catch(() => {})
    setUserPeerLoading(true)
    brandingApi.getUserPeerMarkings(selectedUser, month, year)
      .then(r => setUserPeerMarkings(r.markings))
      .catch(() => {})
      .finally(() => setUserPeerLoading(false))
  }, [selectedUser, month, year, params])

  async function togglePeer(enabled: boolean) {
    try {
      await brandingApi.togglePeerMarking(enabled)
      setPeerEnabled(enabled)
      toast.success(enabled ? 'Peer marking enabled' : 'Peer marking disabled')
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed') }
  }

  async function saveAdminScore() {
    if (!selectedUser) return
    setAdminSaving(true)
    try {
      await brandingApi.setAdminScore(selectedUser, month, year, adminScores)
      load()
      toast.success('Admin score saved')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed')
    } finally {
      setAdminSaving(false)
    }
  }

  function openPenaltyModal() {
    if (!selectedUser) return
    const cur = dashboard.find(d => d.user_id === selectedUser)
    setPenaltyPct(String(cur?.manual_penalty_percent ?? 0))
    setPenaltyReason(cur?.manual_penalty_reason ?? '')
    setPenaltyOpen(true)
  }

  async function saveManualPenalty() {
    if (!selectedUser) return
    const pct = Number(penaltyPct)
    if (Number.isNaN(pct) || pct < 0 || pct > 100) {
      toast.error('Penalty must be between 0 and 100.')
      return
    }
    setPenaltySaving(true)
    try {
      await brandingApi.setAdminPenalty(selectedUser, month, year, pct, penaltyReason.trim())
      await load()
      toast.success(pct === 0 ? 'Penalty cleared.' : `Penalty of −${pct}% applied.`)
      setPenaltyOpen(false)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed')
    } finally {
      setPenaltySaving(false)
    }
  }

  function openOverrideModal() {
    if (!selectedUser) return
    const cur = dashboard.find(d => d.user_id === selectedUser)
    const ov = cur?.total_penalty_override ?? null
    setOverrideEnabled(ov !== null)
    setOverridePct(String(ov ?? cur?.total_penalty_percent ?? 0))
    setOverrideReason(cur?.total_penalty_override_reason ?? '')
    setOverrideOpen(true)
  }

  async function saveTotalOverride() {
    if (!selectedUser) return
    const pct = overrideEnabled ? Number(overridePct) : null
    if (overrideEnabled && (Number.isNaN(pct as number) || (pct as number) < 0 || (pct as number) > 100)) {
      toast.error('Total penalty must be between 0 and 100.')
      return
    }
    setOverrideSaving(true)
    try {
      await brandingApi.setTotalPenaltyOverride(selectedUser, month, year, pct, overrideReason.trim())
      await load()
      toast.success(pct === null
        ? 'Total-penalty override removed. Reverted to auto + manual.'
        : `Total penalty set to −${pct}%.`)
      setOverrideOpen(false)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed')
    } finally {
      setOverrideSaving(false)
    }
  }

  async function doFinalPush() {
    if (!selectedUser) return
    try {
      await brandingApi.finalPush(selectedUser, month, year)
      setFinalPushState('idle')
      setSelectedUser(null)
      load()
      toast.success('KRA Final Push completed! User can now download their report.')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed')
      setFinalPushState('idle')
    }
  }

  async function loadPeerMarkings() {
    brandingApi.getAllPeerMarkings(month, year)
      .then(r => { setPeerMarkings(r.markings); setShowPeerMarkings(true) })
      .catch(() => toast.error('Failed to load peer markings'))
  }

  const selectedReport = dashboard.find(r => r.user_id === selectedUser)

  // Filter out KRA entries for non-submitting roles (admins / reports
  // admins) so only graded employees appear in the cube grid.
  const kraMembers = useMemo(() => {
    const ids = new Set(brandingUsers.map(b => b.id))
    return dashboard.filter(r => ids.has(r.user_id))
  }, [dashboard, brandingUsers])

  function downloadKraCsv() {
    const rows: string[][] = [['User', 'Self Score', 'Peer Score', 'Admin Score', 'Composite', 'Missed Days', 'Auto Penalty %', 'Manual Penalty %', 'Total Penalty %', 'Final Score', 'Status']]
    for (const r of dashboard) {
      const self  = scoreAvg(r.self_appraisal?.scores || null, params)
      const peer  = scoreAvg(r.peer_average, params)
      const admin = scoreAvg(r.admin_score?.scores || null, params)
      rows.push([
        r.user_name,
        self?.toFixed(1) ?? '—',
        peer?.toFixed(1) ?? '—',
        admin?.toFixed(1) ?? '—',
        r.composite_score?.toFixed(1) ?? '—',
        String(r.missed_report_days ?? 0),
        `-${r.penalty_percent ?? 0}%`,
        `-${r.manual_penalty_percent ?? 0}%`,
        `-${r.total_penalty_percent ?? 0}%`,
        r.composite_score_after_penalty?.toFixed(1) ?? '—',
        r.is_final_pushed ? 'Published' : 'Pending',
      ])
    }
    const csv = rows.map(r => r.map(c => `"${c}"`).join(',')).join('\n')
    const a = document.createElement('a')
    a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv)
    a.download = `kra-${MONTHS[month - 1]}-${year}.csv`
    a.click()
    toast.success('KRA CSV downloaded')
  }

  // Period guard: months after the current one in the current year are not
  // selectable (the selects used to disable them; the handlers still refuse them).
  const now = new Date()
  const curYear = now.getFullYear()
  const curMonth = now.getMonth() + 1
  const years = Array.from({ length: curYear - 2023 }, (_, i) => 2024 + i)

  const selectedAvatar = selectedReport ? brandingUsers.find(b => b.id === selectedReport.user_id)?.avatar_url : null

  // The scoring panel for the selected member. Rendered once in whichever
  // slot fits the screen: the right column on desktop, inline under the
  // member tile on smaller screens.
  const detailPanel = selectedReport ? (
              <div className={cx(DS.card, DS.cardPad, 'space-y-4')}>
                <CardHead
                  title={<><Avatar url={selectedAvatar} name={selectedReport.user_name} size="md" /><span>{selectedReport.user_name}</span></>}
                  subtitle={selectedReport.team_joined_at
                    ? `Member since ${new Date(selectedReport.team_joined_at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })} · ${MONTHS[month - 1]} ${year}`
                    : `${MONTHS[month - 1]} ${year}`}
                  action={selectedReport.is_final_pushed
                    ? <Badge tone="success"><Lock className="w-3 h-3" /> Final Published</Badge>
                    : undefined}
                />

                {/* Score overview */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  <MiniStat dot="bg-slate-400"   n={scoreAvg(selectedReport.self_appraisal?.scores || null, params)?.toFixed(1) ?? '—'} label="Self score"  sub="out of 5" />
                  <MiniStat dot="bg-bp-500"      n={scoreAvg(selectedReport.peer_average, params)?.toFixed(1) ?? '—'}                   label="Peer score"  sub="out of 5" />
                  <MiniStat dot="bg-bp-700"      n={scoreAvg(adminScores, params)?.toFixed(1) ?? '—'}                                   label="Admin score" sub="out of 5" />
                  <MiniStat dot="bg-emerald-500" n={selectedReport.composite_score?.toFixed(1) ?? '—'}                                   label="Composite"   sub="out of 5" />
                </div>

                {/* Penalty note — auto + manual combined */}
                {(selectedReport.expected_report_days > 0 || selectedReport.manual_penalty_percent > 0) && (() => {
                  // Window was clamped to team-join when join date is later than month-start
                  const monthStartIso = `${selectedReport.year}-${String(selectedReport.month).padStart(2, '0')}-01`
                  const clamped = selectedReport.kra_window_start > monthStartIso
                  return (
                    <InfoNote tone="warning">
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                        <span className="font-semibold">Daily report attendance</span>
                        <span>
                          Submitted <span className="font-semibold">{selectedReport.submitted_report_days}</span>
                          {' / '}
                          Expected <span className="font-semibold">{selectedReport.expected_report_days}</span>
                        </span>
                        {clamped && (
                          <span className="text-[10px] italic">
                            (from join: {new Date(selectedReport.kra_window_start).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })})
                          </span>
                        )}
                        <span>
                          Missed: <span className="font-semibold">{selectedReport.missed_report_days}</span> day(s)
                        </span>
                        <span className="text-rose-700 font-semibold">
                          Auto: −{selectedReport.penalty_percent}%
                        </span>
                        {selectedReport.manual_penalty_percent > 0 && (
                          <span className="text-rose-700 font-semibold">
                            Manual: −{selectedReport.manual_penalty_percent}%
                          </span>
                        )}
                        <span className="text-rose-800 font-semibold">
                          Total: −{selectedReport.total_penalty_percent}%
                        </span>
                        {selectedReport.total_penalty_override !== null && (
                          <Badge tone="warning" className="uppercase tracking-wider">Admin override</Badge>
                        )}
                        <span className="ml-auto text-emerald-700 font-semibold tabular-nums">
                          Final: {selectedReport.composite_score_after_penalty?.toFixed(1) ?? '—'}<span className="text-[10px] font-normal opacity-60">/5</span>
                        </span>
                      </div>
                      {selectedReport.manual_penalty_reason && (
                        <p className="mt-1.5 text-[11px] italic">Manual penalty reason: {selectedReport.manual_penalty_reason}</p>
                      )}
                      {selectedReport.total_penalty_override !== null && selectedReport.total_penalty_override_reason && (
                        <p className="mt-1 text-[11px] italic">Override reason: {selectedReport.total_penalty_override_reason}</p>
                      )}
                    </InfoNote>
                  )
                })()}

                {/* Detail sub-tabs */}
                <Segmented<'admin' | 'self' | 'peer'>
                  round={false}
                  ariaLabel="Score view"
                  value={detailTab}
                  onChange={setDetailTab}
                  options={[
                    { id: 'admin', label: 'Admin Score' },
                    { id: 'self',  label: 'Self Score' },
                    { id: 'peer',  label: `Peer Scores (${userPeerMarkings.length})` },
                  ]}
                />

                {/* Admin Scoring */}
                {detailTab === 'admin' && !selectedReport.is_final_pushed && params.length > 0 && (
                  <div className="space-y-4">
                    <InfoNote>
                      Pick a level on each parameter. The admin score is averaged with the member's self and peer scores into the composite.
                    </InfoNote>
                    <KraParamGrid
                      params={params}
                      scores={adminScores}
                      onChange={(id, v) => setAdminScores(prev => ({ ...prev, [id]: v }))}
                    />
                    <button onClick={() => void saveAdminScore()} disabled={adminSaving}
                      className={cx(DS.btn, DS.btnPrimary, 'w-full !py-3')}>
                      {adminSaving ? 'Saving…' : 'Save Admin Score'}
                    </button>
                    {/* Manual penalty — applied on top of the auto missed-report penalty */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      <button onClick={openPenaltyModal} className={cx(DS.btn, DS.btnOutlineDanger, 'w-full')}>
                        <AlertTriangle className="w-4 h-4" />
                        {selectedReport.manual_penalty_percent > 0
                          ? `Edit Penalty (currently −${selectedReport.manual_penalty_percent}%)`
                          : 'Add Penalty'}
                      </button>
                      <button onClick={openOverrideModal} className={cx(DS.btn, DS.btnSecondary, 'w-full')}>
                        <Edit3 className="w-4 h-4" />
                        Modify Penalty
                        {selectedReport.total_penalty_override !== null ? (
                          <span className="text-[11px] font-medium text-[#6B7280]">
                            (override: −{selectedReport.total_penalty_override}%)
                          </span>
                        ) : (selectedReport.total_penalty_percent ?? 0) > 0 && (
                          <span className="text-[11px] font-medium text-[#6B7280]">
                            (total currently −{selectedReport.total_penalty_percent}%)
                          </span>
                        )}
                      </button>
                    </div>
                  </div>
                )}
                {detailTab === 'admin' && selectedReport.is_final_pushed && (
                  <EmptyState icon={Lock} title="KRA is final-published." body="Admin scores are locked." compact />
                )}

                {/* Self Score Detail */}
                {detailTab === 'self' && (
                  <div>
                    {!selectedReport.self_appraisal ? (
                      <EmptyState title="Member has not submitted self-appraisal yet." compact />
                    ) : (
                      <div className="space-y-4">
                        <KraParamGrid params={params} scores={selectedReport.self_appraisal.scores} />
                        <p className={DS.muted}>
                          Submitted: {new Date(selectedReport.self_appraisal.submitted_at).toLocaleDateString()}
                        </p>
                      </div>
                    )}
                  </div>
                )}

                {/* Peer Scores Detail */}
                {detailTab === 'peer' && (
                  <div>
                    {userPeerLoading ? (
                      <div className="flex items-center justify-center gap-2 py-6 text-sm text-[#6B7280] font-medium"><Spinner /> Loading peer markings…</div>
                    ) : userPeerMarkings.length === 0 ? (
                      <EmptyState icon={Users} title="No peer markings received for this period." compact />
                    ) : (
                      <div className="space-y-4">
                        {userPeerMarkings.map(pm => {
                          const avg = (Object.values(pm.scores).reduce((a, b) => a + b, 0) / Math.max(Object.keys(pm.scores).length, 1)).toFixed(1)
                          return (
                            <div key={pm.id} className="rounded-[6px] border border-[#C5CAD1] bg-[#F9FAFB] p-4 space-y-3">
                              <CardHead
                                title={<><Avatar name={pm.reviewer_name || pm.reviewer_id} size="sm" /><span>{pm.reviewer_name || pm.reviewer_id}</span></>}
                                action={<span className={DS.chip}>Avg {avg}</span>}
                              />
                              <div className="divide-y divide-[#C5CAD1]">
                                {params.map(p => {
                                  const score = pm.scores[p.id] ?? null
                                  const scale = p.max_score || 5
                                  const tone = kraTone(score, scale)
                                  return (
                                    <div key={p.id} className="flex items-center justify-between gap-3 py-2">
                                      <span className="text-xs font-medium text-[#374151] truncate flex-1">{p.name}</span>
                                      <ScorePips value={kraLevel(score, scale)} label={p.name} />
                                      <span className={cx('w-10 text-right text-sm font-semibold tabular-nums shrink-0', tone?.score ?? 'text-[#111827]')}>
                                        {score ?? <span className="text-[#9CA3AF]">&ndash;</span>}
                                      </span>
                                    </div>
                                  )
                                })}
                              </div>
                            </div>
                          )
                        })}
                        <p className={DS.muted}>
                          Average peer score shown in the summary above is averaged across all {userPeerMarkings.length} reviewer{userPeerMarkings.length !== 1 ? 's' : ''}.
                        </p>
                      </div>
                    )}
                  </div>
                )}

                {/* Final Push */}
                {!selectedReport.is_final_pushed && (
                  <div className={cx(DS.divider, 'pt-4')}>
                    {finalPushState === 'idle' && (
                      <button onClick={() => setFinalPushState('confirm1')}
                        className={cx(DS.btn, DS.btnPrimary, 'w-full !py-3')}>
                        <Check className="w-4 h-4" /> Proceed to Final Push
                      </button>
                    )}
                    {finalPushState === 'confirm1' && (
                      <InfoNote tone="warning">
                        <p className="text-sm font-semibold">Review all scores before proceeding</p>
                        <p className="mt-1">
                          Self: {scoreAvg(selectedReport.self_appraisal?.scores || null, params)?.toFixed(1) ?? '—'} ·
                          Peer: {scoreAvg(selectedReport.peer_average, params)?.toFixed(1) ?? '—'} ·
                          Admin: {scoreAvg(adminScores, params)?.toFixed(1) ?? '—'} ·
                          Composite: {selectedReport.composite_score?.toFixed(1) ?? '—'}
                        </p>
                        <div className="flex gap-2 mt-3 flex-wrap">
                          <button onClick={() => setFinalPushState('confirm2')} className={cx(DS.btn, DS.btnPrimary, 'flex-1')}>
                            Confirm
                          </button>
                          <button onClick={() => setFinalPushState('idle')} className={cx(DS.btn, DS.btnSecondary)}>
                            Cancel
                          </button>
                        </div>
                      </InfoNote>
                    )}
                    {finalPushState === 'confirm2' && (
                      <InfoNote tone="danger">
                        <p className="text-sm font-semibold">Final confirmation — this action is irreversible</p>
                        <p className="mt-1">
                          Once you confirm, the KRA for <strong>{selectedReport.user_name}</strong> ({MONTHS[month - 1]} {year}) will be permanently locked and published to the user. No further edits possible.
                        </p>
                        <div className="flex gap-2 mt-3 flex-wrap">
                          <button onClick={() => void doFinalPush()} className={cx(DS.btn, DS.btnPrimary, 'flex-1')}>
                            Yes, I have reviewed and approve this KRA
                          </button>
                          <button onClick={() => setFinalPushState('idle')} className={cx(DS.btn, DS.btnSecondary)}>
                            Cancel
                          </button>
                        </div>
                      </InfoNote>
                    )}
                  </div>
                )}
              </div>
  ) : null

  return (
    <div className="space-y-4">
      {/* Period strip */}
      <PeriodBar
        month={month} year={year}
        onMonth={m => { if (year === curYear && m > curMonth) return; setMonth(m) }}
        onYear={y => { setYear(y); if (y === curYear && month > curMonth) setMonth(curMonth) }}
        months={MONTHS} years={years}
        trailing={<>
          <span className="inline-flex items-center gap-2 whitespace-nowrap">
            <span className="text-[13px] font-semibold text-[#111827]">Peer marking</span>
            <Segmented<'on' | 'off'>
              round
              className="!flex-nowrap"
              ariaLabel="Peer marking"
              value={peerEnabled ? 'on' : 'off'}
              onChange={v => void togglePeer(v === 'on')}
              options={[{ id: 'on', label: 'On' }, { id: 'off', label: 'Off' }]}
            />
          </span>
          <button onClick={() => void loadPeerMarkings()} className={cx(DS.btn, DS.btnSecondary, DS.btnSm)}>
            <Users className="w-3.5 h-3.5" /> View Peer Markings
          </button>
          <button onClick={downloadKraCsv} className={cx(DS.btn, DS.btnOutline, DS.btnSm)}>
            <Download className="w-3.5 h-3.5" /> Export CSV
          </button>
        </>}
      />

      {loading && <div className="flex items-center justify-center gap-2 py-10 text-sm text-[#6B7280] font-medium"><Spinner /> Loading KRA data…</div>}

      {!loading && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Team Members — choice tiles pinned to the left column.
              Clicking populates the scoring panel on the right. */}
          <div>
            <BlockHeader title="Team Members" subtitle="Pick a member to review and score" chip={`${kraMembers.length} member${kraMembers.length === 1 ? '' : 's'}`} />
            {/* Restrict KRA tiles to people in `brandingUsers` so the
                team-admin / reports-admin entries the API may return
                don't get scored — they aren't graded employees. */}
            {kraMembers.length === 0 && <div className={DS.card}><EmptyState icon={Users} title="No team members found." compact /></div>}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {kraMembers.map(r => {
                const composite = r.composite_score
                const final = r.composite_score_after_penalty
                const u = brandingUsers.find(b => b.id === r.user_id)
                const isSelected = selectedUser === r.user_id
                return (
                  <Fragment key={r.user_id}>
                  <MemberTile
                    active={isSelected}
                    avatarUrl={u?.avatar_url}
                    name={r.user_name}
                    onClick={() => { setSelectedUser(r.user_id); setFinalPushState('idle'); setDetailTab('admin') }}
                    trailing={
                      <Badge tone={r.is_final_pushed ? 'success' : 'warning'}>
                        {r.is_final_pushed ? 'Published' : 'Pending'}
                      </Badge>
                    }
                    desc={<>
                      {composite !== null ? (
                        <span className="font-semibold text-[#111827] tabular-nums">
                          {final !== null && final !== composite && <span className="line-through text-[#9CA3AF] font-medium mr-1">{composite}</span>}
                          {final !== null && final !== composite ? final : composite}
                          <span className="text-[#9CA3AF] font-semibold">/5</span>
                        </span>
                      ) : (
                        <span className="text-[#9CA3AF]">No score</span>
                      )}
                      <span className="text-[#9CA3AF]"> · </span>
                      {r.self_appraisal ? '✓' : '○'} Self
                      <span className="text-[#9CA3AF]"> · </span>
                      {r.peer_count > 0 ? `✓ ${r.peer_count}` : '○'} Peers
                      {(r.total_penalty_percent ?? 0) > 0 && (
                        <span className="text-rose-600 font-semibold"> · −{r.total_penalty_percent}%</span>
                      )}
                    </>}
                  />
                  {isSelected && (
                    <div className="sm:col-span-2 lg:hidden space-y-2">
                      <button type="button" onClick={closePanel} className={cx(DS.btn, DS.btnSecondary, DS.btnSm)}>
                        <ArrowLeft className="w-3.5 h-3.5" strokeWidth={1.75} /> Back to members
                      </button>
                      {detailPanel}
                    </div>
                  )}
                  </Fragment>
                )
              })}
            </div>
          </div>

          {/* KRA Scoring Panel — beside the tile grid on desktop. On phones
              and tablets the same panel renders inline under the selected
              member instead (see the tile grid above). */}
          <div className="hidden lg:block">
            {!selectedUser ? (
              <div className={cx(DS.card, 'flex items-center justify-center h-full min-h-[300px]')}>
                <EmptyState icon={Users} title="Select a team member" body="Select a team member to view and edit their KRA" />
              </div>
            ) : detailPanel}
          </div>
        </div>
      )}

      {/* Peer Markings Modal */}
      {showPeerMarkings && (
        <Modal title={`Peer Markings — ${MONTHS[month - 1]} ${year}`} onClose={() => setShowPeerMarkings(false)} size="lg">
          {peerMarkings.length === 0 ? (
            <EmptyState icon={Users} title="No peer markings for this period." compact />
          ) : (
            <div className={cx(DS.card, 'overflow-hidden')}>
              <table className={DS.table}>
                <thead className={DS.thead}>
                  <tr>
                    <th className={DS.th}>Reviewer</th>
                    <th className={DS.th}>Reviewee</th>
                    <th className={cx(DS.th, '!text-right')}>Avg Score</th>
                  </tr>
                </thead>
                <tbody className={DS.tbody}>
                  {peerMarkings.map(m => (
                    <tr key={m.id} className={DS.trHover}>
                      <td className={DS.td}>{m.reviewer_name || m.reviewer_id}</td>
                      <td className={DS.td}>{m.reviewee_name || m.reviewee_id}</td>
                      <td className={cx(DS.td, 'text-right font-semibold text-[#111827] tabular-nums')}>
                        {(Object.values(m.scores).reduce((a, b) => a + b, 0) / Math.max(Object.keys(m.scores).length, 1)).toFixed(1)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Modal>
      )}

      {/* Manual penalty modal */}
      {penaltyOpen && (
        <Modal
          title={<span className="inline-flex items-center gap-2"><AlertTriangle className="w-5 h-5 text-rose-600" /> Add Manual Penalty</span>}
          subtitle="Applied on top of the auto missed-report penalty. Final score = composite × (1 − total %). Set to 0 to clear."
          onClose={() => setPenaltyOpen(false)} size="sm"
          footer={<>
            <button onClick={() => setPenaltyOpen(false)} className={cx(DS.btn, DS.btnSecondary)}>
              Cancel
            </button>
            <button onClick={() => void saveManualPenalty()} disabled={penaltySaving}
              className={cx(DS.btn, DS.btnDanger)}>
              {penaltySaving ? 'Saving…' : 'Apply Penalty'}
            </button>
          </>}>
          <div className="space-y-4">
            <div>
              <label className={DS.label}>Penalty (%)</label>
              <input type="number" min={0} max={100} step={0.5}
                value={penaltyPct}
                onChange={e => setPenaltyPct(e.target.value)}
                className={INP} autoFocus />
            </div>
            <div>
              <label className={DS.label}>Reason (optional)</label>
              <textarea value={penaltyReason} onChange={e => setPenaltyReason(e.target.value)}
                rows={3} placeholder="e.g. Repeated late submissions, missed deadline on Project X…"
                className={cx(DS.textarea, 'resize-none')} />
            </div>
          </div>
        </Modal>
      )}

      {/* Total-penalty override modal */}
      {overrideOpen && selectedReport && (
        <Modal
          title={<span className="inline-flex items-center gap-2"><Edit3 className="w-5 h-5 text-amber-600" /> Modify Total Penalty</span>}
          subtitle="Replaces the auto (late-submission) and manual penalties with a single total you choose. Final score = composite × (1 − total %)."
          onClose={() => setOverrideOpen(false)} size="sm"
          footer={<>
            <button onClick={() => setOverrideOpen(false)} className={cx(DS.btn, DS.btnSecondary)}>
              Cancel
            </button>
            <button onClick={() => void saveTotalOverride()} disabled={overrideSaving}
              className={cx(DS.btn, DS.btnPrimary)}>
              {overrideSaving ? 'Saving…' : (overrideEnabled ? 'Save Override' : 'Clear Override')}
            </button>
          </>}>
          <div className="space-y-4">
            <div className="rounded-[6px] bg-[#F9FAFB] border border-[#C5CAD1] p-3 text-xs space-y-0.5">
              <div className="flex justify-between"><span className="text-[#6B7280] font-medium">Auto (late submissions)</span><span className="font-semibold text-rose-700">−{selectedReport.penalty_percent}%</span></div>
              <div className="flex justify-between"><span className="text-[#6B7280] font-medium">Manual</span><span className="font-semibold text-rose-700">−{selectedReport.manual_penalty_percent}%</span></div>
              <div className="flex justify-between border-t border-[#C5CAD1] pt-1 mt-1"><span className="text-[#111827] font-semibold">Current total</span><span className="font-semibold text-rose-800">−{selectedReport.total_penalty_percent}%</span></div>
            </div>

            <label className="flex items-center gap-2 text-sm font-medium text-[#111827] cursor-pointer">
              <input type="checkbox" checked={overrideEnabled}
                onChange={e => setOverrideEnabled(e.target.checked)}
                className="accent-bp-700 w-4 h-4" />
              <span>Override total penalty</span>
            </label>

            <div className={overrideEnabled ? '' : 'opacity-50 pointer-events-none'}>
              <label className={DS.label}>Total Penalty (%)</label>
              <input type="number" min={0} max={100} step={0.5}
                value={overridePct}
                onChange={e => setOverridePct(e.target.value)}
                disabled={!overrideEnabled}
                className={INP} autoFocus />
              <div className="mt-3">
                <label className={DS.label}>Reason (optional)</label>
                <textarea value={overrideReason} onChange={e => setOverrideReason(e.target.value)}
                  rows={3} placeholder="e.g. Overriding to account for approved leave on missed days…"
                  className={cx(DS.textarea, 'resize-none')} />
              </div>
            </div>

            {!overrideEnabled && selectedReport.total_penalty_override !== null && (
              <InfoNote tone="warning">
                Unchecking and saving will remove the override; auto + manual will be used again.
              </InfoNote>
            )}
          </div>
        </Modal>
      )}
    </div>
  )
}

// ── Leave Management Tab ───────────────────────────────────────────────────

type LeaveFilter = 'all' | 'pending' | 'approved' | 'rejected'

function LeaveManagementTab() {
  const [leaves, setLeaves] = useState<BrandingLeave[]>([])
  const [loading, setLoading] = useState(false)
  const [statusFilter, setStatusFilter] = useState<LeaveFilter>('pending')
  const [transferEdit, setTransferEdit] = useState<string | null>(null)
  const [transferVal, setTransferVal] = useState('')

  const load = useCallback(() => {
    setLoading(true)
    brandingApi.getLeaves(statusFilter === 'all' ? undefined : statusFilter)
      .then(r => setLeaves(r.leaves))
      .catch(() => toast.error('Failed to load leaves'))
      .finally(() => setLoading(false))
  }, [statusFilter])

  useEffect(() => { load() }, [load])

  async function handleReview(id: string, status: 'approved' | 'rejected') {
    try {
      const res = await brandingApi.reviewLeave(id, status)
      setLeaves(prev => prev.map(l => l.id === id ? res.leave : l).filter(l => statusFilter === 'all' || l.status === statusFilter || l.id === id))
      // Reload to reflect filter
      load()
      toast.success(status === 'approved' ? 'Leave approved.' : 'Leave rejected.')
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed') }
  }

  async function handleTransferSave(id: string) {
    try {
      const res = await brandingApi.updateLeaveTransfer(id, transferVal || null)
      setLeaves(prev => prev.map(l => l.id === id ? res.leave : l))
      setTransferEdit(null)
      toast.success('Transfer date updated.')
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed') }
  }

  const today = new Date().toISOString().split('T')[0]

  return (
    <div className="space-y-4">
      {/* Filter bar */}
      <div className={cx(DS.card, DS.cardPad, 'flex items-center justify-between gap-3 flex-wrap')}>
        <CardHead icon={CalendarOff} title="Leave Requests" subtitle="Approve, reject and reassign team leaves" />
        <Segmented<LeaveFilter>
          round
          ariaLabel="Leave status"
          value={statusFilter}
          onChange={setStatusFilter}
          options={[
            { id: 'pending',  label: 'Pending' },
            { id: 'approved', label: 'Approved' },
            { id: 'rejected', label: 'Rejected' },
            { id: 'all',      label: 'All' },
          ]}
        />
      </div>

      {loading && <div className="flex items-center justify-center gap-2 py-10 text-sm text-[#6B7280] font-medium"><Spinner /> Loading…</div>}

      {!loading && leaves.length === 0 && (
        <div className={DS.card}>
          <EmptyState icon={CalendarOff} title={`No ${statusFilter === 'all' ? '' : statusFilter} leave requests.`} />
        </div>
      )}

      {!loading && leaves.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {leaves.map(lv => {
            const name = lv.user_name || lv.user_email || lv.user_id
            const statusLabel = lv.status.charAt(0).toUpperCase() + lv.status.slice(1)
            return (
              <div key={lv.id} className={cx(DS.card, DS.cardPad, 'flex flex-col gap-3')}>
                {/* Header: avatar + name + status pill */}
                <div className="flex items-start gap-3">
                  <Avatar name={name} email={lv.user_email} size="md" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-[#111827] truncate">{name}</p>
                    <p className="text-[13px] font-medium text-[#6B7280] truncate">{lv.user_email}</p>
                  </div>
                  <StatusPill tone={toneForStatus(lv.status)} className="shrink-0">{statusLabel}</StatusPill>
                </div>

                {/* Date + half-day */}
                <div className="text-sm font-semibold text-[#111827] flex items-center gap-1.5 flex-wrap">
                  <span>{lv.leave_date}</span>
                  {lv.is_half_day && lv.half_day_period && (
                    <Badge tone="warning">{lv.half_day_period === 'first' ? 'First half' : 'Second half'}</Badge>
                  )}
                  <span className="text-[#9CA3AF]">·</span>
                  <span className="text-[13px] font-medium text-[#6B7280]">
                    {new Date(lv.start_at).toLocaleString([], { hour: 'numeric', minute: '2-digit', hour12: true })}
                    {' – '}
                    {new Date(lv.end_at).toLocaleString([], { hour: 'numeric', minute: '2-digit', hour12: true })}
                  </span>
                </div>

                {/* Reason — FieldTile's shape, but allowed to wrap. */}
                <div className="rounded-[6px] bg-[#F9FAFB] border border-[#C5CAD1] p-3">
                  <p className="text-[10px] font-semibold uppercase tracking-widest text-[#9CA3AF] mb-0.5">Reason</p>
                  <p className="text-sm font-semibold text-[#111827] break-words">{lv.reason || '—'}</p>
                </div>

                {/* Transfer day */}
                <div className="flex items-center gap-2 text-[13px]">
                  <span className="font-semibold text-[#6B7280] shrink-0">Transfer day:</span>
                  {transferEdit === lv.id ? (
                    <div className="flex items-center gap-1.5 flex-1">
                      <input type="date" value={transferVal} min={today}
                        onChange={e => setTransferVal(e.target.value)}
                        className={cx(DS.input, 'flex-1 !text-xs !px-2 !py-1')} />
                      <button onClick={() => void handleTransferSave(lv.id)} className={DS.link}>Save</button>
                      <button onClick={() => setTransferEdit(null)} className={cx(DS.btn, DS.btnGhost, DS.btnXs)}>Cancel</button>
                    </div>
                  ) : (
                    <span className="font-semibold flex-1 text-[#111827] flex items-center gap-2">
                      {lv.transfer_date || <span className="text-[#9CA3AF] font-medium">Not set</span>}
                      <button onClick={() => { setTransferEdit(lv.id); setTransferVal(lv.transfer_date || '') }} className={DS.link}>
                        <Edit3 className="w-3 h-3" /> Edit
                      </button>
                    </span>
                  )}
                </div>

                {/* Approve / Reject — only for pending */}
                {lv.status === 'pending' && (
                  <div className={cx(DS.divider, 'flex gap-2 mt-auto pt-3')}>
                    <button onClick={() => void handleReview(lv.id, 'approved')}
                      className={cx(DS.btn, DS.btnSuccess, DS.btnSm, 'flex-1')}>
                      Approve
                    </button>
                    <button onClick={() => void handleReview(lv.id, 'rejected')}
                      className={cx(DS.btn, DS.btnOutlineDanger, DS.btnSm, 'flex-1')}>
                      Reject
                    </button>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── Main Component ─────────────────────────────────────────────────────────

type AdminSection = 'reports' | 'kra' | 'leaves' | 'categories' | 'leave-calendar'

const SECTION_BY_PATH: Record<string, AdminSection> = {
  '/branding/dashboard':      'reports',
  '/branding/kra':            'kra',
  '/branding/leaves':         'leaves',
  '/branding/categories':     'categories',
  '/branding/leave-calendar': 'leave-calendar',
}

const SECTION_META: Record<AdminSection, { title: string; subtitle: string }> = {
  reports:          { title: 'Daily Reports',     subtitle: 'Team activity, hours and collaboration' },
  kra:              { title: 'KRA Management',    subtitle: 'Self, peer and admin scoring with final publish' },
  leaves:           { title: 'Leave Requests',    subtitle: 'Approve, reject and reassign team leaves' },
  categories:       { title: 'Manage Categories', subtitle: 'Work categories and sub-categories' },
  'leave-calendar': { title: 'Leave Calendar',    subtitle: 'All leave requests by day — submitted and approved' },
}

export default function BrandingAdminDashboard() {
  const { users } = useAppData()
  const location = useLocation()
  const section: AdminSection = SECTION_BY_PATH[location.pathname] ?? 'reports'
  const meta = SECTION_META[section]

  // Only people who actually submit daily reports belong in the admin
  // dashboard's user surfaces (cards, KRA cubes, Team Summary, top-4,
  // collaboration map). Roles like `admin` and `branding_reports_admin`
  // exist to manage the team, not to log work, so they're excluded.
  const brandingUsers = useMemo(() =>
    users.filter(u => u.team === 'branding' && !NON_SUBMITTING_ROLES.has(u.role))
      .map(u => ({ id: u.id, full_name: u.full_name, email: u.email, avatar_url: u.avatar_url ?? null })),
    [users]
  )

  return (
    <BrandingAdminShell title={meta.title} subtitle={meta.subtitle}>
      {section === 'reports'    && <BrandingAdminOverview brandingUsers={brandingUsers} />}
      {section === 'kra'        && <KraManagementTab   brandingUsers={brandingUsers} />}
      {section === 'leaves'     && <LeaveManagementTab />}
      {section === 'categories' && <ManageCategoriesTab />}
      {section === 'leave-calendar' && <LeaveCalendarTab />}
    </BrandingAdminShell>
  )
}

// ── Leave Calendar (req 1) ──────────────────────────────────────────────────
// Month grid of every leave request, with per-day submitted + approved counts.
// Click a day to see that day's requests.

const LC_WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function lcLocalDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** One colour per person, chosen to carry white text. Fixed rather than taken
    from the primary colour, because the point is telling people apart. */
const LC_STRIP_COLORS = ['#1D4ED8', '#6D28D9', '#BE123C', '#B45309', '#0F766E', '#A21CAF', '#4D7C0F', '#334155']

/** First and last calendar day of a leave. Day strings use the same UTC-slice
    convention the server uses when it derives leave_date from start_at. */
function lcLeaveDays(l: BrandingLeave): { start: string; end: string } {
  const start = l.leave_date
  if (!l.end_at) return { start, end: start }
  const e = new Date(l.end_at)
  if (Number.isNaN(e.getTime())) return { start, end: start }
  const iso = e.toISOString().slice(0, 10)
  return { start, end: iso > start ? iso : start }
}

function lcShortDate(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

interface LeaveStrip {
  leave: BrandingLeave
  color: string
  /** Column it starts in (0 = Sunday) and how many days it covers this week. */
  col: number
  span: number
  lane: number
  /** False when the leave carries on from, or into, another week or month. */
  startsHere: boolean
  endsHere: boolean
  firstDay: string
}

function LeaveCalendarTab() {
  const [leaves, setLeaves] = useState<BrandingLeave[]>([])
  const [cursor, setCursor] = useState(() => new Date())
  const [selectedDay, setSelectedDay] = useState<string | null>(null)

  useEffect(() => { brandingApi.getLeaves().then(r => setLeaves(r.leaves)).catch(() => {}) }, [])

  const month = cursor.getMonth()
  const year = cursor.getFullYear()
  const today = lcLocalDate(new Date())

  const byDate = useMemo(() => {
    const m = new Map<string, { submitted: number; approved: number; items: BrandingLeave[] }>()
    const add = (day: string, l: BrandingLeave) => {
      const cur = m.get(day) ?? { submitted: 0, approved: 0, items: [] }
      cur.submitted++
      if (l.status === 'approved') cur.approved++
      cur.items.push(l)
      m.set(day, cur)
    }
    for (const l of leaves) {
      // A leave spans [start_at, end_at]: every day in the range counts, not
      // just the recorded leave_date (which is only the start day).
      const { start: startDay, end: endDay } = lcLeaveDays(l)
      if (endDay === startDay) { add(startDay, l); continue }
      const d = new Date(`${startDay}T00:00:00Z`)
      // Hard cap guards against a bad end_at (e.g. year-long span) flooding the map.
      for (let i = 0; i < 62; i++) {
        const day = d.toISOString().slice(0, 10)
        add(day, l)
        if (day >= endDay) break
        d.setUTCDate(d.getUTCDate() + 1)
      }
    }
    return m
  }, [leaves])

  const cells = useMemo(() => {
    const firstDay = new Date(year, month, 1).getDay()
    const daysInMonth = new Date(year, month + 1, 0).getDate()
    const out: { date: string | null; isToday: boolean }[] = []
    for (let i = 0; i < firstDay; i++) out.push({ date: null, isToday: false })
    for (let d = 1; d <= daysInMonth; d++) {
      const iso = lcLocalDate(new Date(year, month, d))
      out.push({ date: iso, isToday: iso === today })
    }
    while (out.length % 7 !== 0) out.push({ date: null, isToday: false })
    return out
  }, [year, month, today])

  const monthLabel = cursor.toLocaleString('en-US', { month: 'long', year: 'numeric' })

  // Each leave becomes one strip per week it touches. Strips in a week are
  // stacked into lanes so overlapping leaves never cover each other, and the
  // week's row grows to fit them. Rejected leaves were not taken, so they stay
  // off the calendar; they still appear in the day's detail list.
  const weeks = useMemo(() => {
    const colorOf = new Map<string, string>()
    Array.from(new Set(leaves.map(l => l.user_id))).sort().forEach((id, i) => {
      colorOf.set(id, LC_STRIP_COLORS[i % LC_STRIP_COLORS.length])
    })
    const active = leaves.filter(l => l.status !== 'rejected')
    const out: { cells: typeof cells; strips: LeaveStrip[]; lanes: number }[] = []
    for (let i = 0; i < cells.length; i += 7) {
      const week = cells.slice(i, i + 7)
      const found: Omit<LeaveStrip, 'lane'>[] = []
      for (const l of active) {
        const { start, end } = lcLeaveDays(l)
        const cols = week.flatMap((c, col) => (c.date && c.date >= start && c.date <= end ? [col] : []))
        if (cols.length === 0) continue
        found.push({
          leave: l,
          color: colorOf.get(l.user_id) ?? LC_STRIP_COLORS[0],
          col: cols[0],
          span: cols.length,
          startsHere: week[cols[0]].date === start,
          endsHere: week[cols[cols.length - 1]].date === end,
          firstDay: week[cols[0]].date as string,
        })
      }
      found.sort((a, b) => a.col - b.col || b.span - a.span)
      const laneEnds: number[] = []
      const strips = found.map(st => {
        let lane = laneEnds.findIndex(endCol => st.col > endCol)
        if (lane === -1) { lane = laneEnds.length; laneEnds.push(0) }
        laneEnds[lane] = st.col + st.span - 1
        return { ...st, lane }
      })
      out.push({ cells: week, strips, lanes: laneEnds.length })
    }
    return out
  }, [cells, leaves])
  const monthTotals = useMemo(() => {
    // Count distinct leaves (not leave-days) — a 3-day leave expanded across
    // three cells still counts once in the header totals.
    const submitted = new Set<string>(), approved = new Set<string>()
    for (const c of cells) {
      if (!c.date) continue
      const e = byDate.get(c.date)
      if (!e) continue
      for (const l of e.items) {
        submitted.add(l.id)
        if (l.status === 'approved') approved.add(l.id)
      }
    }
    return { submitted: submitted.size, approved: approved.size }
  }, [cells, byDate])

  function shift(dir: -1 | 1) {
    const d = new Date(cursor); d.setMonth(d.getMonth() + dir); setCursor(d); setSelectedDay(null)
  }

  const selected = selectedDay ? byDate.get(selectedDay) : undefined

  return (
    <div className="space-y-4">
      <div className={cx(DS.card, DS.cardPad)}>
        <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
          <div className="min-w-0">
            <p className={cx(DS.eyebrow, 'mb-1')}>Month</p>
            <h2 className="text-[16px] font-semibold text-[#111827] tracking-[-0.01em]">{monthLabel}</h2>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            {/* Month totals as quiet chips, the same height as the controls. */}
            <div className="flex items-center gap-1.5">
              <Badge tone="info" dot className="!h-8 !px-3 !text-[12px]">{monthTotals.submitted} submitted</Badge>
              <Badge tone="success" dot className="!h-8 !px-3 !text-[12px]">{monthTotals.approved} approved</Badge>
            </div>
            <div className="flex items-center gap-1.5">
              <button onClick={() => shift(-1)} className={DS.iconBtnSm} aria-label="Previous month"><ChevronLeft className="w-4 h-4" /></button>
              <button onClick={() => { setCursor(new Date()); setSelectedDay(null) }} className={cx(DS.btn, DS.btnSecondary, DS.btnXs, '!h-8')}>Today</button>
              <button onClick={() => shift(1)} className={DS.iconBtnSm} aria-label="Next month"><ChevronRight className="w-4 h-4" /></button>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-7 gap-1 sm:gap-1.5 mb-1.5">
          {LC_WEEKDAYS.map((d, i) => (
            <div key={d} className={cx('text-[10px] font-semibold uppercase tracking-[0.14em] text-center py-1', i === 0 || i === 6 ? 'text-[#9CA3AF]' : 'text-[#6B7280]')}>{d}</div>
          ))}
        </div>

        {/* One row per week: the day cells, with the leave strips laid over
            them on a matching seven-column grid. Rows grow to fit their strips. */}
        <div className="space-y-1 sm:space-y-1.5">
          {weeks.map((week, wi) => (
            <div
              key={wi}
              className="relative grid grid-cols-7 gap-1 sm:gap-1.5 min-h-[max(44px,var(--strip-h))] sm:min-h-[max(84px,var(--strip-h))]"
              style={{ '--strip-h': `${30 + week.lanes * 22}px` } as React.CSSProperties}
            >
              {week.cells.map((c, i) => {
                const isSel = c.date && c.date === selectedDay
                return (
                  <button key={i} type="button" disabled={!c.date}
                    onClick={() => c.date && setSelectedDay(c.date === selectedDay ? null : c.date)}
                    className={cx(
                      'rounded-[6px] border p-1 sm:p-1.5 text-left flex flex-col transition-colors',
                      c.date === null ? 'border-transparent'
                        : isSel ? 'bg-bp-50 border-bp-600 cursor-pointer'
                        : c.isToday ? 'bg-white border-[#C5CAD1] ring-2 ring-bp-200 hover:bg-[#F9FAFB] cursor-pointer'
                        : 'bg-white border-[#C5CAD1] hover:bg-[#F9FAFB] hover:border-bp-300 cursor-pointer',
                    )}>
                    {c.date && <span className={cx('text-[11px] font-semibold', c.isToday ? 'text-bp-700' : 'text-[#6B7280]')}>{parseInt(c.date.slice(8, 10), 10)}</span>}
                  </button>
                )
              })}

              {week.strips.length > 0 && (
                <div className="pointer-events-none absolute inset-x-0 top-[24px] grid grid-cols-7 gap-x-1 sm:gap-x-1.5 gap-y-0.5 auto-rows-[20px]">
                  {week.strips.map(st => {
                    const { start, end } = lcLeaveDays(st.leave)
                    const name = st.leave.user_name || st.leave.user_email || 'Team member'
                    const dates = start === end ? lcShortDate(start) : `${lcShortDate(start)} – ${lcShortDate(end)}`
                    const pending = st.leave.status === 'pending'
                    return (
                      <button
                        key={`${st.leave.id}-${st.firstDay}`}
                        type="button"
                        onClick={() => setSelectedDay(st.firstDay === selectedDay ? null : st.firstDay)}
                        title={`${name} · ${dates} · ${st.leave.status}${st.leave.reason ? ` · ${st.leave.reason}` : ''}`}
                        aria-label={`${name}, leave ${dates}, ${st.leave.status}`}
                        style={{
                          gridColumn: `${st.col + 1} / span ${st.span}`,
                          gridRow: st.lane + 1,
                          ...(pending
                            ? { backgroundColor: `color-mix(in srgb, ${st.color} 12%, white)`, color: st.color, borderColor: st.color }
                            : { backgroundColor: st.color, color: '#FFFFFF', borderColor: st.color }),
                        }}
                        className={cx(
                          'pointer-events-auto h-5 min-w-0 flex items-center px-1 sm:px-1.5 border text-[11px] font-medium cursor-pointer hover:opacity-90 transition-opacity',
                          pending && 'border-dashed',
                          st.startsHere ? 'ml-1 rounded-l-[5px]' : 'border-l-0',
                          st.endsHere ? 'mr-1 rounded-r-[5px]' : 'border-r-0',
                        )}
                      >
                        <span className="truncate">
                          <span className="hidden sm:inline">{name}</span>
                          {/* A single phone-width day only has room for initials. */}
                          <span className="sm:hidden">
                            {st.span === 1 ? name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase() : name.split(' ')[0]}
                          </span>
                          {st.leave.is_half_day && <span className="hidden sm:inline"> · ½ day</span>}
                        </span>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="mt-3 flex items-center gap-4 flex-wrap text-[12px] text-[#6B7280]">
          <span className="inline-flex items-center gap-1.5">
            <span className="w-5 h-3 rounded-[3px] bg-[#6B7280]" aria-hidden="true" /> Approved
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="w-5 h-3 rounded-[3px] border border-dashed border-[#6B7280] bg-[#6B7280]/10" aria-hidden="true" /> Pending
          </span>
          <span>Each person keeps one colour. Click a strip for details.</span>
        </div>
      </div>

      {selectedDay && (
        <div className={cx(DS.card, DS.cardPad, 'space-y-4')}>
          <CardHead
            title={new Date(selectedDay + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
            subtitle={`${selected?.submitted ?? 0} submitted, ${selected?.approved ?? 0} approved`}
          />
          {!selected || selected.items.length === 0 ? (
            <EmptyState icon={CalendarOff} title="No leave requests on this day." compact />
          ) : (
            <ul className="divide-y divide-[#C5CAD1]">
              {selected.items.map(l => (
                <li key={l.id} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
                  <Avatar name={l.user_name} email={l.user_email} size="sm" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-[#111827] truncate">{l.user_name || l.user_id}</p>
                    <p className="text-[13px] font-medium text-[#6B7280] truncate">{l.is_half_day ? 'Half day' : 'Full day'}{l.reason ? ` — ${l.reason}` : ''}</p>
                  </div>
                  <StatusPill tone={toneForStatus(l.status)} className="capitalize shrink-0">{l.status}</StatusPill>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
