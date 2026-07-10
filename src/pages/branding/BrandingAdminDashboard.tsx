import { useState, useEffect, useCallback, useMemo } from 'react'
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
  Download, Users, Filter, ToggleLeft, ToggleRight, X,
  ArrowUp, ArrowDown, CalendarOff,
} from 'lucide-react'
import BrandingAdminOverview from './BrandingAdminOverview'
import BrandingAdminShell from './BrandingAdminShell'
import { toast } from 'sonner'

// ── Helpers ────────────────────────────────────────────────────────────────

// Roles whose members manage the team rather than submit daily reports.
// Used to filter the admin dashboard's user surfaces so admins don't
// appear in cards, KRA cubes, top contributors, etc.
const NON_SUBMITTING_ROLES = new Set(['super_admin', 'admin', 'branding_reports_admin'])

const INP = 'w-full text-sm px-3 py-2 rounded-lg border border-border bg-background focus:outline-none focus:ring-2 focus:ring-green-300 transition-all'
const SEL = 'text-sm px-3 py-2 rounded-lg border border-border bg-background focus:outline-none focus:ring-2 focus:ring-green-300 transition-all cursor-pointer'

function scoreAvg(scores: Record<string, number> | null | undefined, params: KraParameter[]): number | null {
  if (!scores || params.length === 0) return null
  const vals = params.map(p => scores[p.id]).filter(v => v !== undefined) as number[]
  if (vals.length === 0) return null
  return Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10
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

  async function moveCategory(id: string, dir: 'up' | 'down') {
    const idx = categories.findIndex(c => c.id === id)
    if (idx < 0) return
    const newOrder = [...categories]
    const swapIdx = dir === 'up' ? idx - 1 : idx + 1
    if (swapIdx < 0 || swapIdx >= newOrder.length) return
    ;[newOrder[idx], newOrder[swapIdx]] = [newOrder[swapIdx], newOrder[idx]]
    setCategories(newOrder)
    await brandingApi.reorderCategories(newOrder.map(c => c.id))
  }

  if (loading) return <p className="text-sm text-muted-foreground text-center py-10 animate-pulse">Loading categories…</p>

  return (
    <div className="space-y-5">
      {/* Add-new-category panel — same as before, kept as a wide bar above
          the grid so it's discoverable. */}
      <div className="rounded-2xl border-2 border-green-700 bg-gradient-to-br from-white to-green-50/40 p-5">
        <h2 className="text-sm font-extrabold font-serif mb-3" style={{ color: '#1a472a' }}>Add New Category</h2>
        <div className="flex gap-2">
          <input value={newCatName} onChange={e => setNewCatName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') void addCategory() }}
            placeholder="Category name…" className={INP + ' flex-1'} />
          <button onClick={() => void addCategory()}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#1a472a] text-white text-sm font-medium hover:bg-[#143620] transition-colors">
            <Plus className="w-4 h-4" /> Add
          </button>
        </div>
        <p className="text-xs text-muted-foreground mt-2">
          A default "Others" sub-category is automatically added to every new category.
        </p>
      </div>

      {/* Card grid — each category gets its own tile with reorder, rename,
          delete, and an expandable sub-category list with inline add/edit. */}
      {categories.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-10">No categories yet.</p>
      ) : (
        // `items-start` keeps each card sized to its own content so
        // expanding one card's sub-categories doesn't visually stretch
        // the other cards in the same row.
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 items-start">
          {categories.map((cat, catIdx) => {
            const isExpanded = expanded.has(cat.id)
            const isEditing = editingCat?.id === cat.id
            return (
              <div key={cat.id}
                className="group relative rounded-2xl border-2 border-green-700 bg-white hover:border-green-800 hover:shadow-md transition-all flex flex-col self-start">
                {/* Card header — colour-banded so it reads as a tile. The
                    rounded-t-2xl matches the parent corners now that the
                    card no longer clips its overflow (so the dropdown can
                    float free of the row). */}
                <div className={`px-4 pt-3 pb-2 bg-gradient-to-br from-green-50 to-white rounded-t-2xl ${isExpanded ? '' : 'rounded-b-2xl'}`}>
                  <div className="flex items-start gap-2">
                    <div className="flex flex-col gap-0.5 shrink-0 pt-0.5">
                      <button onClick={() => void moveCategory(cat.id, 'up')} disabled={catIdx === 0}
                        className="p-0.5 rounded hover:bg-green-100 disabled:opacity-25 transition-colors" title="Move up">
                        <ArrowUp className="w-3 h-3 text-green-800" />
                      </button>
                      <button onClick={() => void moveCategory(cat.id, 'down')} disabled={catIdx === categories.length - 1}
                        className="p-0.5 rounded hover:bg-green-100 disabled:opacity-25 transition-colors" title="Move down">
                        <ArrowDown className="w-3 h-3 text-green-800" />
                      </button>
                    </div>
                    {isEditing ? (
                      <div className="flex items-center gap-1.5 flex-1 min-w-0">
                        <input value={editingCat!.name}
                          onChange={e => setEditingCat(p => p ? { ...p, name: e.target.value } : p)}
                          onKeyDown={e => { if (e.key === 'Enter') void saveCategory(cat.id, editingCat!.name) }}
                          className={INP + ' flex-1 py-1 font-bold'} autoFocus />
                        <button onClick={() => void saveCategory(cat.id, editingCat!.name)}
                          className="p-1.5 rounded-lg bg-green-700 text-white hover:bg-green-800" title="Save">
                          <Check className="w-3.5 h-3.5" />
                        </button>
                        <button onClick={() => setEditingCat(null)}
                          className="p-1.5 rounded-lg bg-gray-100 text-gray-500 hover:bg-gray-200" title="Cancel">
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ) : (
                      <>
                        <h3 className="text-base font-extrabold font-serif flex-1 truncate" style={{ color: '#1a472a' }}>{cat.name}</h3>
                        <div className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                          <button onClick={() => setEditingCat({ id: cat.id, name: cat.name })}
                            className="p-1.5 rounded-lg text-green-700 hover:bg-green-100" title="Rename">
                            <Edit3 className="w-3.5 h-3.5" />
                          </button>
                          <button onClick={() => void deleteCategory(cat.id, cat.name)}
                            className="p-1.5 rounded-lg text-rose-600 hover:bg-rose-50" title="Delete">
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                  <button onClick={() => setExpanded(p => { const s = new Set(p); if (s.has(cat.id)) s.delete(cat.id); else s.add(cat.id); return s })}
                    className="mt-2 ml-5 flex items-center gap-1 text-[11px] font-semibold hover:underline" style={{ color: '#52b788' }}>
                    {cat.sub_categories.length} sub-categor{cat.sub_categories.length === 1 ? 'y' : 'ies'}
                    {isExpanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                  </button>
                </div>

                {/* Sub-categories body — floats below the header as a
                    dropdown so expanding it does NOT grow the card or
                    push the surrounding grid row. */}
                {isExpanded && (
                  <div className="absolute top-full left-0 right-0 mt-1 p-3 space-y-1 bg-white border-2 border-green-700 rounded-2xl shadow-xl z-30 max-h-72 overflow-y-auto">
                    {cat.sub_categories.map(sub => (
                      <div key={sub.id} className="flex items-center gap-2 py-1 px-2 rounded-lg hover:bg-green-50/40 group/sub">
                        {editingSub?.id === sub.id ? (
                          <div className="flex items-center gap-1.5 flex-1">
                            <input value={editingSub.name}
                              onChange={e => setEditingSub(p => p ? { ...p, name: e.target.value } : p)}
                              onKeyDown={e => { if (e.key === 'Enter') void saveSubCategory(sub.id, editingSub.name) }}
                              className={INP + ' flex-1 py-1 text-xs'} autoFocus />
                            <button onClick={() => void saveSubCategory(sub.id, editingSub.name)}
                              className="p-1 rounded bg-green-700 text-white">
                              <Check className="w-3 h-3" />
                            </button>
                            <button onClick={() => setEditingSub(null)}
                              className="p-1 rounded bg-gray-100 text-gray-500">
                              <X className="w-3 h-3" />
                            </button>
                          </div>
                        ) : (
                          <>
                            <span className="text-sm flex-1 truncate" style={{ color: '#1a472a' }}>{sub.name}</span>
                            {sub.is_others ? (
                              <span className="text-[10px] text-muted-foreground bg-muted px-2 py-0.5 rounded-full shrink-0">default</span>
                            ) : (
                              <div className="flex items-center gap-0.5 opacity-0 group-hover/sub:opacity-100 transition-opacity">
                                <button onClick={() => setEditingSub({ id: sub.id, name: sub.name })}
                                  className="p-1 rounded text-green-700 hover:bg-green-100">
                                  <Edit3 className="w-3 h-3" />
                                </button>
                                <button onClick={() => void deleteSubCategory(sub.id, sub.name)}
                                  className="p-1 rounded text-rose-600 hover:bg-rose-50">
                                  <Trash2 className="w-3 h-3" />
                                </button>
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    ))}

                    {cat.name !== 'Others' && (
                      <div className="flex gap-2 mt-2 pt-2 border-t-2 border-green-700/30">
                        <input
                          value={newSubName[cat.id] || ''}
                          onChange={e => setNewSubName(p => ({ ...p, [cat.id]: e.target.value }))}
                          onKeyDown={e => { if (e.key === 'Enter') void addSubCategory(cat.id) }}
                          placeholder="Add sub-category…"
                          className={INP + ' flex-1 py-1 text-xs'} />
                        <button onClick={() => void addSubCategory(cat.id)}
                          className="flex items-center gap-1 px-3 py-1 rounded-lg bg-green-700 text-white text-xs font-semibold hover:bg-green-800">
                          <Plus className="w-3.5 h-3.5" /> Add
                        </button>
                      </div>
                    )}
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

// ── KRA Management Tab ─────────────────────────────────────────────────────

function KraManagementTab({ brandingUsers }: { brandingUsers: { id: string; full_name: string; email: string; avatar_url: string | null }[] }) {
  const { profile } = useAuth()
  const [month, setMonth] = useState(new Date().getMonth() + 1)
  const [year, setYear]   = useState(new Date().getFullYear())
  const [dashboard, setDashboard]     = useState<KraReport[]>([])
  const [params, setParams]           = useState<KraParameter[]>([])
  const [peerEnabled, setPeerEnabled] = useState(false)
  const [selectedUser, setSelectedUser] = useState<string | null>(null)
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

  return (
    <div className="space-y-5">
      {/* Controls */}
      <div className="hub-card flex items-center justify-between flex-wrap gap-4">
        <div className="flex items-center gap-3">
          {(() => {
            const now = new Date()
            const curYear = now.getFullYear()
            const curMonth = now.getMonth() + 1
            const years = Array.from({ length: curYear - 2023 }, (_, i) => 2024 + i)
            return (
              <>
                <select value={month} onChange={e => {
                  const m = parseInt(e.target.value)
                  if (year === curYear && m > curMonth) return
                  setMonth(m)
                }} className={SEL}>
                  {MONTHS.map((m, i) => (
                    <option key={m} value={i + 1} disabled={year === curYear && i + 1 > curMonth}>{m}</option>
                  ))}
                </select>
                <select value={year} onChange={e => {
                  const y = parseInt(e.target.value)
                  setYear(y)
                  if (y === curYear && month > curMonth) setMonth(curMonth)
                }} className={SEL}>
                  {years.map(y => <option key={y} value={y}>{y}</option>)}
                </select>
              </>
            )
          })()}
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="text-sm font-bold font-serif" style={{ color: '#1a472a' }}>Peer Marking:</span>
            <button onClick={() => void togglePeer(!peerEnabled)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${peerEnabled ? 'bg-green-100 text-green-700 hover:bg-green-200' : 'bg-muted text-muted-foreground hover:bg-accent'}`}>
              {peerEnabled ? <ToggleRight className="w-4 h-4" /> : <ToggleLeft className="w-4 h-4" />}
              {peerEnabled ? 'Enabled' : 'Disabled'}
            </button>
          </div>
          <button onClick={() => void loadPeerMarkings()}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-muted text-muted-foreground text-xs font-medium hover:bg-accent">
            <Users className="w-3.5 h-3.5" /> View Peer Markings
          </button>
          <button onClick={downloadKraCsv}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-muted text-muted-foreground text-xs font-medium hover:bg-accent">
            <Download className="w-3.5 h-3.5" /> Export CSV
          </button>
        </div>
      </div>

      {loading && <p className="text-sm text-muted-foreground text-center py-10 animate-pulse">Loading KRA data…</p>}

      {!loading && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          {/* Team Members — cube grid, three per row, pinned to the left
              column. Selected cube has a strong ring; clicking populates
              the scoring panel on the right. */}
          <div>
            <h3 className="text-base font-extrabold font-serif mb-3" style={{ color: '#1a472a' }}>Team Members</h3>
            {/* Restrict KRA cubes to people in `brandingUsers` so the
                team-admin / reports-admin entries the API may return
                don't get scored — they aren't graded employees. */}
            {kraMembers.length === 0 && <p className="text-sm text-gray-400 py-4">No team members found.</p>}
            <div className="grid grid-cols-3 gap-3">
              {kraMembers.map(r => {
                const composite = r.composite_score
                const final = r.composite_score_after_penalty
                const u = brandingUsers.find(b => b.id === r.user_id)
                const isSelected = selectedUser === r.user_id
                return (
                  <button key={r.user_id}
                    onClick={() => { setSelectedUser(r.user_id); setFinalPushState('idle'); setDetailTab('admin') }}
                    className={`relative aspect-square flex flex-col items-center justify-center gap-2 p-3 rounded-2xl border-2 text-center transition-all ${isSelected
                      ? 'border-green-700 bg-gradient-to-br from-green-50 to-green-100 shadow-md ring-2 ring-green-700/40'
                      : 'border-green-100 bg-white hover:border-green-400 hover:bg-green-50/60 hover:shadow-sm'}`}>
                    {/* status pill in the top-right corner */}
                    <span className={`absolute top-2 right-2 text-[9px] font-bold px-1.5 py-0.5 rounded-full ${r.is_final_pushed
                      ? 'bg-green-700 text-white' : 'bg-amber-100 text-amber-700'}`}>
                      {r.is_final_pushed ? 'Published' : 'Pending'}
                    </span>
                    {u?.avatar_url ? (
                      <img src={u.avatar_url} alt={r.user_name}
                        className={`w-12 h-12 rounded-full object-cover shrink-0 ring-2 ${isSelected ? 'ring-green-600' : 'ring-green-200'}`} />
                    ) : (
                      <div className={`w-12 h-12 rounded-full flex items-center justify-center shrink-0 ring-2 ${isSelected ? 'bg-green-200 ring-green-600' : 'bg-green-100 ring-green-200'}`}>
                        <span className="text-sm font-bold text-green-800">{r.user_name[0]?.toUpperCase()}</span>
                      </div>
                    )}
                    <p className="text-xs font-bold font-serif leading-tight line-clamp-2" style={{ color: '#1a472a' }}>{r.user_name}</p>
                    <div className="flex items-baseline gap-1">
                      {composite !== null ? (
                        <>
                          {final !== null && final !== composite ? (
                            <>
                              <span className="line-through text-gray-400 text-[10px]">{composite}</span>
                              <span className="text-base font-extrabold" style={{ color: '#1a472a' }}>{final}</span>
                            </>
                          ) : (
                            <span className="text-base font-extrabold" style={{ color: '#1a472a' }}>{composite}</span>
                          )}
                          <span className="text-[10px] text-gray-400 font-semibold">/5</span>
                        </>
                      ) : (
                        <span className="text-[10px] text-gray-400 italic">No score</span>
                      )}
                    </div>
                    <p className="text-[10px] font-semibold" style={{ color: '#52b788' }}>
                      {r.self_appraisal ? '✓' : '○'} Self · {r.peer_count > 0 ? `✓ ${r.peer_count}` : '○'} Peers
                      {(r.total_penalty_percent ?? 0) > 0 && (
                        <span className="ml-1 text-red-600">· −{r.total_penalty_percent}%</span>
                      )}
                    </p>
                  </button>
                )
              })}
            </div>
          </div>

          {/* KRA Scoring Panel — sits to the right of the cube grid */}
          <div>
            {!selectedUser ? (
              <div className="hub-card flex items-center justify-center h-full min-h-[300px] text-sm font-semibold" style={{ color: '#52b788' }}>
                Select a team member to view and edit their KRA
              </div>
            ) : selectedReport && (
              <div className="hub-card space-y-5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    {(() => {
                      const su = brandingUsers.find(b => b.id === selectedReport.user_id)
                      return su?.avatar_url ? (
                        <img src={su.avatar_url} alt={selectedReport.user_name}
                          className="w-12 h-12 rounded-full object-cover shrink-0 ring-2 ring-green-200" />
                      ) : (
                        <div className="w-12 h-12 rounded-full bg-green-100 ring-2 ring-green-200 flex items-center justify-center shrink-0">
                          <span className="text-base font-bold text-green-800">{selectedReport.user_name[0]?.toUpperCase()}</span>
                        </div>
                      )
                    })()}
                    <div>
                      <h3 className="text-xl font-extrabold font-serif" style={{ color: '#1a472a' }}>{selectedReport.user_name}</h3>
                      {selectedReport.team_joined_at && (
                        <p className="text-[11px] font-semibold mt-0.5" style={{ color: '#52b788' }}>
                          Member since {new Date(selectedReport.team_joined_at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {selectedReport.is_final_pushed && (
                      <span className="flex items-center gap-1 text-xs text-green-700 bg-green-50 px-3 py-1 rounded-full">
                        <Lock className="w-3 h-3" /> Final Published
                      </span>
                    )}
                  </div>
                </div>

                {/* Score overview cards */}
                <div className="grid grid-cols-4 gap-2">
                  {[
                    { label: 'Self Score',   value: scoreAvg(selectedReport.self_appraisal?.scores || null, params)?.toFixed(1) ?? '—', bg: 'bg-green-50 text-green-800' },
                    { label: 'Peer Score',   value: scoreAvg(selectedReport.peer_average, params)?.toFixed(1) ?? '—', bg: 'bg-blue-50 text-blue-700' },
                    { label: 'Admin Score',  value: scoreAvg(adminScores, params)?.toFixed(1) ?? '—', bg: 'bg-purple-50 text-purple-700' },
                    { label: 'Composite',    value: selectedReport.composite_score?.toFixed(1) ?? '—', bg: 'bg-green-50 text-green-700' },
                  ].map(s => (
                    <div key={s.label} className={`p-3 rounded-xl text-center ${s.bg}`}>
                      <p className="text-xs font-medium opacity-70">{s.label}</p>
                      <p className="text-2xl font-serif mt-0.5">{s.value}<span className="text-xs font-normal opacity-60">/5</span></p>
                    </div>
                  ))}
                </div>

                {/* Penalty bar — auto + manual combined */}
                {(selectedReport.expected_report_days > 0 || selectedReport.manual_penalty_percent > 0) && (() => {
                  // Window was clamped to team-join when join date is later than month-start
                  const monthStartIso = `${selectedReport.year}-${String(selectedReport.month).padStart(2, '0')}-01`
                  const clamped = selectedReport.kra_window_start > monthStartIso
                  return (
                  <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 space-y-2">
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                      <span className="font-bold text-amber-800">Daily Report Attendance</span>
                      <span className="text-amber-700">
                        Submitted <span className="font-semibold">{selectedReport.submitted_report_days}</span>
                        {' / '}
                        Expected <span className="font-semibold">{selectedReport.expected_report_days}</span>
                      </span>
                      {clamped && (
                        <span className="text-amber-700 text-[10px] italic">
                          (from join: {new Date(selectedReport.kra_window_start).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })})
                        </span>
                      )}
                      <span className="text-amber-700">
                        Missed: <span className="font-semibold">{selectedReport.missed_report_days}</span> day(s)
                      </span>
                      <span className="text-red-700 font-semibold">
                        Auto: −{selectedReport.penalty_percent}%
                      </span>
                      {selectedReport.manual_penalty_percent > 0 && (
                        <span className="text-red-700 font-semibold">
                          Manual: −{selectedReport.manual_penalty_percent}%
                        </span>
                      )}
                      <span className="text-red-800 font-bold">
                        Total: −{selectedReport.total_penalty_percent}%
                      </span>
                      {selectedReport.total_penalty_override !== null && (
                        <span className="text-[10px] font-semibold uppercase tracking-wider bg-amber-200 text-amber-900 px-1.5 py-0.5 rounded">
                          Admin Override
                        </span>
                      )}
                      <span className="ml-auto text-green-800 font-bold">
                        Final: {selectedReport.composite_score_after_penalty?.toFixed(1) ?? '—'}<span className="text-[10px] font-normal opacity-60">/5</span>
                      </span>
                    </div>
                    {selectedReport.manual_penalty_reason && (
                      <p className="text-[11px] text-amber-700 italic">
                        Manual penalty reason: {selectedReport.manual_penalty_reason}
                      </p>
                    )}
                    {selectedReport.total_penalty_override !== null && selectedReport.total_penalty_override_reason && (
                      <p className="text-[11px] text-amber-700 italic">
                        Override reason: {selectedReport.total_penalty_override_reason}
                      </p>
                    )}
                  </div>
                  )
                })()}

                {/* Detail sub-tabs */}
                <div className="flex gap-1 bg-gray-50 p-1 rounded-lg w-fit">
                  {([
                    { key: 'admin', label: 'Admin Score' },
                    { key: 'self',  label: 'Self Score' },
                    { key: 'peer',  label: `Peer Scores (${userPeerMarkings.length})` },
                  ] as const).map(t => (
                    <button key={t.key} onClick={() => setDetailTab(t.key)}
                      className={`px-3 py-1.5 rounded-md text-xs font-bold font-serif transition-all ${
                        detailTab === t.key ? 'bg-white shadow-sm' : 'hover:text-gray-700'
                      }`}
                      style={detailTab === t.key
                        ? { color: '#1a472a' }
                        : { color: '#52b788' }}>
                      {t.label}
                    </button>
                  ))}
                </div>

                {/* Admin Scoring */}
                {detailTab === 'admin' && !selectedReport.is_final_pushed && params.length > 0 && (
                  <div>
                    <div className="space-y-3">
                      {params.map(p => (
                        <div key={p.id} className="flex items-center gap-3">
                          <span className="text-xs text-foreground w-40 shrink-0">{p.name}</span>
                          <input type="range" min={0} max={p.max_score} step={1}
                            value={adminScores[p.id] ?? 5}
                            onChange={e => setAdminScores(prev => ({ ...prev, [p.id]: parseInt(e.target.value) }))}
                            className="flex-1 accent-purple-500" />
                          <span className="text-sm font-semibold text-purple-600 w-8 text-right">
                            {adminScores[p.id] ?? 5}
                          </span>
                        </div>
                      ))}
                    </div>
                    <button onClick={() => void saveAdminScore()} disabled={adminSaving}
                      className="mt-4 w-full py-2 rounded-lg bg-purple-600 text-white text-sm font-medium hover:bg-purple-700 disabled:opacity-50 transition-colors">
                      {adminSaving ? 'Saving…' : 'Save Admin Score'}
                    </button>
                    {/* Manual penalty — applied on top of the auto missed-report penalty */}
                    <button onClick={openPenaltyModal}
                      className="mt-2 w-full py-2 rounded-lg border border-red-300 text-red-700 text-sm font-medium hover:bg-red-50 transition-colors flex items-center justify-center gap-2">
                      <AlertTriangle className="w-4 h-4" />
                      {selectedReport.manual_penalty_percent > 0
                        ? `Edit Penalty (currently −${selectedReport.manual_penalty_percent}%)`
                        : 'Add Penalty'}
                    </button>
                    <button onClick={openOverrideModal}
                      className="mt-2 w-full py-2 rounded-lg border border-amber-300 text-amber-700 text-sm font-medium hover:bg-amber-50 transition-colors flex items-center justify-center gap-2">
                      <Edit3 className="w-4 h-4" />
                      Modify Penalty
                      {selectedReport.total_penalty_override !== null ? (
                        <span className="text-[11px] font-normal text-muted-foreground">
                          (override: −{selectedReport.total_penalty_override}%)
                        </span>
                      ) : (selectedReport.total_penalty_percent ?? 0) > 0 && (
                        <span className="text-[11px] font-normal text-muted-foreground">
                          (total currently −{selectedReport.total_penalty_percent}%)
                        </span>
                      )}
                    </button>
                  </div>
                )}
                {detailTab === 'admin' && selectedReport.is_final_pushed && (
                  <p className="text-xs text-muted-foreground text-center py-4">KRA is final-published. Admin scores are locked.</p>
                )}

                {/* Self Score Detail */}
                {detailTab === 'self' && (
                  <div>
                    {!selectedReport.self_appraisal ? (
                      <p className="text-sm text-muted-foreground text-center py-6">Member has not submitted self-appraisal yet.</p>
                    ) : (
                      <div className="space-y-3">
                        {params.map(p => {
                          const score = selectedReport.self_appraisal?.scores[p.id] ?? null
                          return (
                            <div key={p.id} className="flex items-center gap-3">
                              <div className="flex-1 min-w-0">
                                <p className="text-xs font-medium text-foreground">{p.name}</p>
                                {p.description && <p className="text-[10px] text-muted-foreground">{p.description}</p>}
                              </div>
                              <div className="w-32 h-2 bg-muted rounded-full shrink-0">
                                <div className="h-full bg-green-500 rounded-full transition-all"
                                  style={{ width: score !== null ? `${(score / (p.max_score || 5)) * 100}%` : '0%' }} />
                              </div>
                              <span className="text-sm font-semibold text-green-800 w-10 text-right shrink-0">
                                {score ?? '—'}<span className="text-xs text-muted-foreground font-normal">/{p.max_score}</span>
                              </span>
                            </div>
                          )
                        })}
                        <p className="text-[10px] text-muted-foreground pt-1">
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
                      <p className="text-sm text-muted-foreground text-center py-6 animate-pulse">Loading peer markings…</p>
                    ) : userPeerMarkings.length === 0 ? (
                      <p className="text-sm text-muted-foreground text-center py-6">No peer markings received for this period.</p>
                    ) : (
                      <div className="space-y-4">
                        {userPeerMarkings.map(pm => (
                          <div key={pm.id} className="border border-border rounded-xl p-3 space-y-2">
                            <p className="text-xs font-semibold text-foreground">
                              From: {pm.reviewer_name || pm.reviewer_id}
                              <span className="ml-2 text-muted-foreground font-normal">
                                · Avg: {(Object.values(pm.scores).reduce((a, b) => a + b, 0) / Math.max(Object.keys(pm.scores).length, 1)).toFixed(1)}
                              </span>
                            </p>
                            {params.map(p => {
                              const score = pm.scores[p.id] ?? null
                              return (
                                <div key={p.id} className="flex items-center gap-3">
                                  <span className="text-xs text-muted-foreground flex-1 truncate">{p.name}</span>
                                  <div className="w-24 h-1.5 bg-muted rounded-full shrink-0">
                                    <div className="h-full bg-blue-500 rounded-full transition-all"
                                      style={{ width: score !== null ? `${(score / (p.max_score || 5)) * 100}%` : '0%' }} />
                                  </div>
                                  <span className="text-xs font-semibold text-blue-600 w-8 text-right shrink-0">
                                    {score ?? '—'}
                                  </span>
                                </div>
                              )
                            })}
                          </div>
                        ))}
                        <p className="text-[10px] text-muted-foreground">
                          Average peer score shown in the summary card above is averaged across all {userPeerMarkings.length} reviewer{userPeerMarkings.length !== 1 ? 's' : ''}.
                        </p>
                      </div>
                    )}
                  </div>
                )}

                {/* Final Push */}
                {!selectedReport.is_final_pushed && (
                  <div className="border-t border-border pt-4">
                    {finalPushState === 'idle' && (
                      <button onClick={() => setFinalPushState('confirm1')}
                        className="w-full py-2.5 rounded-lg bg-green-600 text-white text-sm font-medium hover:bg-green-700 transition-colors flex items-center justify-center gap-2">
                        <Check className="w-4 h-4" /> Proceed to Final Push
                      </button>
                    )}
                    {finalPushState === 'confirm1' && (
                      <div className="p-4 bg-amber-50 border border-amber-200 rounded-xl space-y-3">
                        <div className="flex items-start gap-2">
                          <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
                          <div>
                            <p className="text-sm font-semibold text-amber-800">Review all scores before proceeding</p>
                            <p className="text-xs text-amber-700 mt-1">
                              Self: {scoreAvg(selectedReport.self_appraisal?.scores || null, params)?.toFixed(1) ?? '—'} ·
                              Peer: {scoreAvg(selectedReport.peer_average, params)?.toFixed(1) ?? '—'} ·
                              Admin: {scoreAvg(adminScores, params)?.toFixed(1) ?? '—'} ·
                              Composite: {selectedReport.composite_score?.toFixed(1) ?? '—'}
                            </p>
                          </div>
                        </div>
                        <div className="flex gap-3">
                          <button onClick={() => setFinalPushState('confirm2')}
                            className="flex-1 py-2 rounded-lg bg-amber-600 text-white text-sm font-medium hover:bg-amber-700">
                            Proceed to Final Push
                          </button>
                          <button onClick={() => setFinalPushState('idle')}
                            className="px-4 py-2 rounded-lg border border-border text-sm text-muted-foreground hover:bg-accent">
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}
                    {finalPushState === 'confirm2' && (
                      <div className="p-4 bg-red-50 border border-red-200 rounded-xl space-y-3">
                        <div className="flex items-start gap-2">
                          <AlertTriangle className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
                          <div>
                            <p className="text-sm font-semibold text-red-800">FINAL CONFIRMATION — This action is irreversible</p>
                            <p className="text-xs text-red-700 mt-1">
                              Once you click "Yes, I have reviewed and approve this KRA", the KRA for <strong>{selectedReport.user_name}</strong> ({MONTHS[month - 1]} {year}) will be permanently locked and published to the user. No further edits possible.
                            </p>
                          </div>
                        </div>
                        <div className="flex gap-3">
                          <button onClick={() => void doFinalPush()}
                            className="flex-1 py-2 rounded-lg bg-red-600 text-white text-sm font-medium hover:bg-red-700">
                            Yes, I have reviewed and approve this KRA
                          </button>
                          <button onClick={() => setFinalPushState('idle')}
                            className="px-4 py-2 rounded-lg border border-border text-sm text-muted-foreground hover:bg-accent">
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Peer Markings Modal */}
      {showPeerMarkings && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <div className="bg-card border border-border rounded-2xl shadow-xl max-w-2xl w-full max-h-[80vh] flex flex-col">
            <div className="flex items-center justify-between p-4 border-b border-border">
              <h3 className="text-base font-extrabold font-serif" style={{ color: '#1a472a' }}>Peer Markings — {MONTHS[month - 1]} {year}</h3>
              <button onClick={() => setShowPeerMarkings(false)} className="p-1 rounded-lg hover:bg-accent">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="overflow-y-auto flex-1 p-4">
              {peerMarkings.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-6">No peer markings for this period.</p>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="text-left pb-2 pr-4 text-xs font-semibold text-muted-foreground">Reviewer</th>
                      <th className="text-left pb-2 pr-4 text-xs font-semibold text-muted-foreground">Reviewee</th>
                      <th className="text-right pb-2 text-xs font-semibold text-muted-foreground">Avg Score</th>
                    </tr>
                  </thead>
                  <tbody>
                    {peerMarkings.map(m => (
                      <tr key={m.id} className="border-b border-border/50 last:border-0">
                        <td className="py-2 pr-4">{m.reviewer_name || m.reviewer_id}</td>
                        <td className="py-2 pr-4">{m.reviewee_name || m.reviewee_id}</td>
                        <td className="py-2 text-right font-medium text-green-800">
                          {(Object.values(m.scores).reduce((a, b) => a + b, 0) / Math.max(Object.keys(m.scores).length, 1)).toFixed(1)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Manual penalty modal */}
      {penaltyOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.45)' }}
          onClick={() => setPenaltyOpen(false)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6 space-y-4" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold text-foreground flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-red-600" /> Add Manual Penalty
              </h3>
              <button onClick={() => setPenaltyOpen(false)} className="p-1.5 rounded-lg hover:bg-muted text-muted-foreground"><X className="w-4 h-4" /></button>
            </div>
            <p className="text-xs text-muted-foreground">
              Applied on top of the auto missed-report penalty. Final score = composite × (1 − total %).
              Set to 0 to clear.
            </p>
            <div>
              <label className="text-xs font-bold uppercase tracking-wide mb-1 block text-foreground">Penalty (%)</label>
              <input type="number" min={0} max={100} step={0.5}
                value={penaltyPct}
                onChange={e => setPenaltyPct(e.target.value)}
                className={INP} autoFocus />
            </div>
            <div>
              <label className="text-xs font-bold uppercase tracking-wide mb-1 block text-foreground">Reason (optional)</label>
              <textarea value={penaltyReason} onChange={e => setPenaltyReason(e.target.value)}
                rows={3} placeholder="e.g. Repeated late submissions, missed deadline on Project X…"
                className={INP + ' resize-none'} />
            </div>
            <div className="flex gap-3 pt-1">
              <button onClick={() => void saveManualPenalty()} disabled={penaltySaving}
                className="flex-1 py-2 rounded-lg bg-red-600 text-white text-sm font-semibold hover:bg-red-700 disabled:opacity-50">
                {penaltySaving ? 'Saving…' : 'Apply Penalty'}
              </button>
              <button onClick={() => setPenaltyOpen(false)}
                className="px-4 py-2 rounded-lg border border-border text-sm text-muted-foreground hover:bg-muted">
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Total-penalty override modal */}
      {overrideOpen && selectedReport && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.45)' }}
          onClick={() => setOverrideOpen(false)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6 space-y-4" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold text-foreground flex items-center gap-2">
                <Edit3 className="w-4 h-4 text-amber-600" /> Modify Total Penalty
              </h3>
              <button onClick={() => setOverrideOpen(false)} className="p-1.5 rounded-lg hover:bg-muted text-muted-foreground"><X className="w-4 h-4" /></button>
            </div>
            <p className="text-xs text-muted-foreground">
              Replaces the auto (late-submission) and manual penalties with a single total you choose.
              Final score = composite × (1 − total %).
            </p>

            <div className="rounded-lg bg-muted/40 p-3 text-xs space-y-0.5">
              <div className="flex justify-between"><span className="text-muted-foreground">Auto (late submissions)</span><span className="font-semibold text-red-700">−{selectedReport.penalty_percent}%</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Manual</span><span className="font-semibold text-red-700">−{selectedReport.manual_penalty_percent}%</span></div>
              <div className="flex justify-between border-t border-border pt-1 mt-1"><span className="text-foreground font-medium">Current total</span><span className="font-bold text-red-800">−{selectedReport.total_penalty_percent}%</span></div>
            </div>

            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input type="checkbox" checked={overrideEnabled}
                onChange={e => setOverrideEnabled(e.target.checked)}
                className="accent-amber-500 w-4 h-4" />
              <span>Override total penalty</span>
            </label>

            <div className={overrideEnabled ? '' : 'opacity-50 pointer-events-none'}>
              <label className="text-xs font-bold uppercase tracking-wide mb-1 block text-foreground">Total Penalty (%)</label>
              <input type="number" min={0} max={100} step={0.5}
                value={overridePct}
                onChange={e => setOverridePct(e.target.value)}
                disabled={!overrideEnabled}
                className={INP} autoFocus />
              <div className="mt-3">
                <label className="text-xs font-bold uppercase tracking-wide mb-1 block text-foreground">Reason (optional)</label>
                <textarea value={overrideReason} onChange={e => setOverrideReason(e.target.value)}
                  rows={3} placeholder="e.g. Overriding to account for approved leave on missed days…"
                  className={INP + ' resize-none'} />
              </div>
            </div>

            {!overrideEnabled && selectedReport.total_penalty_override !== null && (
              <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-2">
                Unchecking and saving will remove the override; auto + manual will be used again.
              </p>
            )}

            <div className="flex gap-3 pt-1">
              <button onClick={() => void saveTotalOverride()} disabled={overrideSaving}
                className="flex-1 py-2 rounded-lg bg-amber-600 text-white text-sm font-semibold hover:bg-amber-700 disabled:opacity-50">
                {overrideSaving ? 'Saving…' : (overrideEnabled ? 'Save Override' : 'Clear Override')}
              </button>
              <button onClick={() => setOverrideOpen(false)}
                className="px-4 py-2 rounded-lg border border-border text-sm text-muted-foreground hover:bg-muted">
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Leave Management Tab ───────────────────────────────────────────────────

function LeaveManagementTab() {
  const [leaves, setLeaves] = useState<BrandingLeave[]>([])
  const [loading, setLoading] = useState(false)
  const [statusFilter, setStatusFilter] = useState<'all' | 'pending' | 'approved' | 'rejected'>('pending')
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

  const statusBadgeCls = (s: BrandingLeave['status']) =>
    s === 'approved' ? 'bg-green-100 text-green-800'
    : s === 'rejected' ? 'bg-red-50 text-red-600'
    : 'bg-amber-100 text-amber-700'

  return (
    <div className="space-y-5">
      {/* Filter bar */}
      <div className="bg-white rounded-2xl border border-gray-100 p-4 flex items-center gap-3 flex-wrap">
        <span className="text-sm font-extrabold font-serif flex items-center gap-2" style={{ color: '#1a472a' }}>
          <CalendarOff className="w-4 h-4" /> Leave Requests
        </span>
        <div className="flex gap-1 bg-gray-50 p-1 rounded-xl ml-auto">
          {(['pending', 'approved', 'rejected', 'all'] as const).map(s => (
            <button key={s} onClick={() => setStatusFilter(s)}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold capitalize transition-all ${
                statusFilter === s ? 'text-white shadow-sm' : 'text-gray-500 hover:text-gray-700'
              }`}
              style={statusFilter === s ? { background: '#1a472a' } : {}}>
              {s === 'all' ? 'All' : s}
            </button>
          ))}
        </div>
      </div>

      {loading && <p className="text-sm text-gray-400 text-center py-10 animate-pulse">Loading…</p>}

      {!loading && leaves.length === 0 && (
        <p className="text-sm text-gray-400 text-center py-10">
          No {statusFilter === 'all' ? '' : statusFilter} leave requests.
        </p>
      )}

      {!loading && leaves.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {leaves.map(lv => {
            const name = lv.user_name || lv.user_email || lv.user_id
            const initials = name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase()
            return (
              <div key={lv.id} className="rounded-2xl border border-gray-100 bg-white p-5 flex flex-col gap-3 relative overflow-hidden">
                {/* Subtle top stripe colored by status */}
                <div className="absolute top-0 left-0 right-0 h-1" style={{
                  background: lv.status === 'approved' ? '#1a472a'
                    : lv.status === 'rejected' ? '#dc2626' : '#f59e0b'
                }} />

                {/* Header: avatar + name + status pill */}
                <div className="flex items-start gap-3">
                  <div className="w-10 h-10 rounded-full bg-green-100 flex items-center justify-center text-sm font-bold text-green-800 shrink-0">
                    {initials}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-bold font-serif truncate" style={{ color: '#1a472a' }}>{name}</p>
                    <p className="text-[11px] text-gray-400 truncate">{lv.user_email}</p>
                  </div>
                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full shrink-0 ${statusBadgeCls(lv.status)}`}>
                    {lv.status.charAt(0).toUpperCase() + lv.status.slice(1)}
                  </span>
                </div>

                {/* Date + half-day */}
                <div className="text-xs font-semibold flex items-center gap-1.5 flex-wrap" style={{ color: '#52b788' }}>
                  <span className="font-bold" style={{ color: '#1a472a' }}>{lv.leave_date}</span>
                  {lv.is_half_day && lv.half_day_period && (
                    <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-amber-50 text-amber-700">
                      {lv.half_day_period === 'first' ? 'First half' : 'Second half'}
                    </span>
                  )}
                  <span className="text-gray-300">·</span>
                  <span className="text-gray-500 font-normal">
                    {new Date(lv.start_at).toLocaleString([], { hour: 'numeric', minute: '2-digit', hour12: true })}
                    {' – '}
                    {new Date(lv.end_at).toLocaleString([], { hour: 'numeric', minute: '2-digit', hour12: true })}
                  </span>
                </div>

                {/* Reason */}
                <div className="rounded-xl bg-gray-50 p-3">
                  <p className="text-[10px] font-bold uppercase tracking-wider mb-1" style={{ color: '#52b788' }}>Reason</p>
                  <p className="text-xs text-gray-700">{lv.reason || '—'}</p>
                </div>

                {/* Transfer day */}
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-bold" style={{ color: '#52b788' }}>Transfer day:</span>
                  {transferEdit === lv.id ? (
                    <div className="flex items-center gap-1.5 flex-1">
                      <input type="date" value={transferVal} min={today}
                        onChange={e => setTransferVal(e.target.value)}
                        className="flex-1 text-xs px-2 py-1 rounded-lg border border-gray-200 focus:outline-none focus:border-green-700" />
                      <button onClick={() => void handleTransferSave(lv.id)}
                        className="text-xs font-bold text-green-700 hover:text-green-900">Save</button>
                      <button onClick={() => setTransferEdit(null)}
                        className="text-xs text-gray-400 hover:text-gray-600">Cancel</button>
                    </div>
                  ) : (
                    <span className="text-xs font-bold flex-1" style={{ color: '#1a472a' }}>
                      {lv.transfer_date || <span className="text-gray-400 font-normal">Not set</span>}
                      <button onClick={() => { setTransferEdit(lv.id); setTransferVal(lv.transfer_date || '') }}
                        className="ml-2 text-[10px] text-gray-400 underline hover:text-gray-600 font-normal">edit</button>
                    </span>
                  )}
                </div>

                {/* Approve / Reject — only for pending */}
                {lv.status === 'pending' && (
                  <div className="flex gap-2 mt-auto pt-2 border-t border-gray-50">
                    <button onClick={() => void handleReview(lv.id, 'approved')}
                      className="flex-1 px-3 py-2 text-xs font-bold text-white rounded-lg transition-colors hover:opacity-90"
                      style={{ background: '#1a472a' }}>
                      Approve
                    </button>
                    <button onClick={() => void handleReview(lv.id, 'rejected')}
                      className="flex-1 px-3 py-2 text-xs font-bold text-red-600 border border-red-200 rounded-lg hover:bg-red-50 transition-colors">
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
    <BrandingAdminShell>
      <div>
        <h1 className="text-3xl font-extrabold font-serif" style={{ color: '#1a472a' }}>{meta.title}</h1>
        <p className="text-sm font-semibold mt-0.5" style={{ color: '#52b788' }}>{meta.subtitle}</p>
      </div>
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
      // A leave spans [start_at, end_at]: highlight EVERY day in the range,
      // not just the recorded leave_date (which is only the start day). Day
      // strings use the same UTC-slice convention the server uses when it
      // derives leave_date from start_at.
      const startDay = l.leave_date
      let endDay = startDay
      if (l.end_at) {
        const e = new Date(l.end_at)
        if (!Number.isNaN(e.getTime())) {
          const iso = e.toISOString().slice(0, 10)
          if (iso > startDay) endDay = iso
        }
      }
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
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
        <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
          <h2 className="text-sm font-bold" style={{ color: '#1a472a' }}>{monthLabel}</h2>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-3 text-[11px] text-gray-500">
              <span className="inline-flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full" style={{ background: '#1a472a' }} /> {monthTotals.submitted} submitted</span>
              <span className="inline-flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full" style={{ background: '#52b788' }} /> {monthTotals.approved} approved</span>
            </div>
            <div className="flex items-center gap-1">
              <button onClick={() => shift(-1)} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-500"><ChevronLeft className="w-4 h-4" /></button>
              <button onClick={() => { setCursor(new Date()); setSelectedDay(null) }} className="text-xs px-2 py-1 rounded-lg hover:bg-gray-100 text-gray-500">Today</button>
              <button onClick={() => shift(1)} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-500"><ChevronRight className="w-4 h-4" /></button>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-7 gap-1 mb-1">
          {LC_WEEKDAYS.map(d => (
            <div key={d} className="text-[10px] font-bold uppercase tracking-widest text-gray-400 text-center py-1">{d}</div>
          ))}
        </div>

        <div className="grid grid-cols-7 gap-1 auto-rows-[84px]">
          {cells.map((c, i) => {
            const e = c.date ? byDate.get(c.date) : undefined
            const isSel = c.date && c.date === selectedDay
            return (
              <button key={i} type="button" disabled={!c.date}
                onClick={() => c.date && setSelectedDay(c.date === selectedDay ? null : c.date)}
                className={`rounded-lg border p-1.5 text-left flex flex-col transition-colors ${
                  c.date === null ? 'border-transparent'
                    : isSel ? 'border-[#1a472a] bg-green-50'
                    : c.isToday ? 'border-green-300 bg-green-50/40'
                    : 'border-gray-100 hover:bg-gray-50'
                }`}>
                {c.date && <span className="text-[11px] font-medium text-gray-600">{parseInt(c.date.slice(8, 10), 10)}</span>}
                {e && (
                  <div className="mt-auto space-y-0.5">
                    <span className="block text-[10px] font-semibold text-white rounded px-1 py-0.5" style={{ background: '#1a472a' }}>{e.submitted} leave{e.submitted === 1 ? '' : 's'}</span>
                    {e.approved > 0 && <span className="block text-[10px] font-semibold rounded px-1 py-0.5" style={{ background: '#e6f4ea', color: '#1a472a' }}>{e.approved} approved</span>}
                  </div>
                )}
              </button>
            )
          })}
        </div>
      </div>

      {selectedDay && (
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
          <h3 className="text-sm font-bold mb-3" style={{ color: '#1a472a' }}>
            {new Date(selectedDay + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
            {' · '}{selected?.submitted ?? 0} submitted, {selected?.approved ?? 0} approved
          </h3>
          {!selected || selected.items.length === 0 ? (
            <p className="text-sm text-gray-400">No leave requests on this day.</p>
          ) : (
            <div className="space-y-2">
              {selected.items.map(l => (
                <div key={l.id} className="flex items-center gap-3 border border-gray-100 rounded-xl px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-gray-800 truncate">{l.user_name || l.user_id}</p>
                    <p className="text-[11px] text-gray-500 truncate">{l.is_half_day ? 'Half day' : 'Full day'}{l.reason ? ` — ${l.reason}` : ''}</p>
                  </div>
                  <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full shrink-0"
                    style={l.status === 'approved' ? { background: '#e6f4ea', color: '#1a472a' }
                      : l.status === 'rejected' ? { background: '#fde8e8', color: '#b91c1c' }
                      : { background: '#fef3c7', color: '#92400e' }}>
                    {l.status}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
