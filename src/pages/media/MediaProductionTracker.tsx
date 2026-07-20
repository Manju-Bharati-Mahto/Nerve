/**
 * M4 — Production Tracker: the four Excel worksheets as one structured
 * tracker. Category tabs → month-grouped project lists → expandable detail
 * with the deliverable checklist (status + Drive link + assignees +
 * completion date) and the Social Media Posting block (FR-PR-01..08).
 */
import { useEffect, useMemo, useState } from 'react'
import {
  Plus, X, ExternalLink, Trash2, ChevronDown, ChevronRight, Check, Share2, Filter as FilterIcon,
} from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'
import { mediaApi } from '@/lib/media-api'
import {
  MEDIA_PROJECT_CATEGORIES, MEDIA_CATEGORY_META, MEDIA_SHOOT_TYPES, MEDIA_EVENT_TYPES, MEDIA_ORGANIZATIONS,
  type MediaProject, type MediaProjectCategory, type MediaProjectInput, type MediaProjectStatus,
  type MediaMaster, type MediaMember, type MediaDeliverableStatus,
} from '@/lib/media-types'

const GREEN = '#1a472a'
const STATUS_META: Record<MediaProjectStatus, { label: string; cls: string }> = {
  upcoming: { label: 'Upcoming', cls: 'bg-blue-100 text-blue-700' },
  running: { label: 'Running', cls: 'bg-amber-100 text-amber-800' },
  completed: { label: 'Completed', cls: 'bg-emerald-100 text-emerald-700' },
  archived: { label: 'Archived', cls: 'bg-gray-100 text-gray-500' },
}
const DELIVERABLE_STATUSES: { value: MediaDeliverableStatus; label: string }[] = [
  { value: 'pending', label: 'Pending' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'done', label: 'Done' },
]

const inputCls = 'w-full text-sm border border-gray-200 rounded-xl px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-green-200'
const labelCls = 'text-[11px] font-bold uppercase tracking-wide mb-1 block text-gray-500'

export default function MediaProductionTracker() {
  const { role } = useAuth()
  const isLead = role === 'super_admin' || role === 'admin' || role === 'sub_admin'
  const isAdmin = role === 'super_admin' || role === 'admin'
  const canSocial = isLead || role === 'social_media'

  const [category, setCategory] = useState<MediaProjectCategory>('academic_cultural')
  const [projects, setProjects] = useState<MediaProject[]>([])
  const [deliverableTypes, setDeliverableTypes] = useState<MediaMaster[]>([])
  const [members, setMembers] = useState<MediaMember[]>([])
  const [statusFilter, setStatusFilter] = useState<MediaProjectStatus | ''>('')
  const [notPostedOnly, setNotPostedOnly] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [editing, setEditing] = useState<MediaProject | 'new' | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    mediaApi.getMasters().then(m => setDeliverableTypes(m.deliverable_types)).catch(() => {})
    mediaApi.getTeam().then(r => setMembers(r.members)).catch(() => {})
  }, [])

  const reload = () => mediaApi.getProjects(category)
    .then(r => setProjects(r.projects))
    .catch(e => setError(e instanceof Error ? e.message : 'Failed to load.'))
  useEffect(() => { void reload() }, [category]) // eslint-disable-line react-hooks/exhaustive-deps

  const typeName = useMemo(() => new Map(deliverableTypes.map(t => [t.id, t.name])), [deliverableTypes])
  const memberName = useMemo(() => new Map(members.map(m => [m.id, m.full_name || m.email])), [members])

  const visible = useMemo(() => projects.filter(p => {
    if (statusFilter && p.status !== statusFilter) return false
    // FR-PR-05: the social desk's "not posted yet" worklist.
    if (notPostedOnly && !p.social_posts.some(s => !s.is_posted)) return false
    return true
  }), [projects, statusFilter, notPostedOnly])

  // FR-PR-09: month grouping mirrors the workbook's month rows.
  const byMonth = useMemo(() => {
    const g = new Map<string, MediaProject[]>()
    for (const p of visible) {
      const key = p.month || (p.start_date ? new Date(p.start_date + 'T00:00:00').toLocaleString('en-US', { month: 'long' }) : 'Unscheduled')
      const arr = g.get(key) ?? []
      arr.push(p)
      g.set(key, arr)
    }
    return Array.from(g.entries())
  }, [visible])

  async function patchProject(id: string, patch: Partial<MediaProjectInput>) {
    try {
      const { project } = await mediaApi.updateProject(id, patch)
      setProjects(ps => ps.map(p => p.id === project.id ? project : p))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update.')
    }
  }

  return (
    <div className="max-w-6xl mx-auto space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-extrabold font-serif" style={{ color: GREEN }}>Production Tracker</h1>
          <p className="text-sm text-gray-500">Every event, tour and shoot with its deliverables and Drive links.</p>
        </div>
        {isLead && (
          <button onClick={() => setEditing('new')}
            className="px-4 py-2.5 rounded-xl text-sm font-semibold text-white inline-flex items-center gap-1.5"
            style={{ background: GREEN }}>
            <Plus className="w-4 h-4" /> New {MEDIA_CATEGORY_META[category].short.replace(/s$/, '')} Project
          </button>
        )}
      </div>

      {/* Category tabs */}
      <div className="flex flex-wrap gap-1.5">
        {MEDIA_PROJECT_CATEGORIES.map(c => (
          <button key={c} onClick={() => { setCategory(c); setExpanded(null) }}
            className={`px-3.5 py-2 rounded-xl text-[13px] font-semibold transition-colors ${
              category === c ? 'text-white' : 'bg-white border border-gray-200 text-gray-500 hover:bg-gray-50'
            }`}
            style={category === c ? { background: GREEN } : undefined}>
            {MEDIA_CATEGORY_META[c].label}
          </button>
        ))}
      </div>

      {/* Filters */}
      <div className="flex items-center gap-2 flex-wrap">
        <FilterIcon className="w-4 h-4 text-gray-400" />
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value as MediaProjectStatus | '')}
          className="text-xs border border-gray-200 rounded-xl px-2.5 py-1.5 bg-white">
          <option value="">Any status</option>
          {Object.entries(STATUS_META).map(([v, m]) => <option key={v} value={v}>{m.label}</option>)}
        </select>
        {canSocial && (
          <label className="inline-flex items-center gap-1.5 text-xs text-gray-600 cursor-pointer">
            <input type="checkbox" checked={notPostedOnly} onChange={e => setNotPostedOnly(e.target.checked)} />
            Not posted yet
          </label>
        )}
        <span className="text-xs text-gray-400 ml-auto">{visible.length} project{visible.length === 1 ? '' : 's'}</span>
      </div>

      {error && <div className="bg-rose-50 border border-rose-200 rounded-xl px-4 py-2.5 text-sm text-rose-700">{error}</div>}

      {byMonth.length === 0 ? (
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm py-16 text-center text-sm text-gray-400">
          No {MEDIA_CATEGORY_META[category].label} yet{isLead ? ' — create the first one.' : '.'}
        </div>
      ) : byMonth.map(([month, ps]) => (
        <div key={month} className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
          <p className="px-4 py-2.5 text-xs font-bold uppercase tracking-widest bg-green-50/60" style={{ color: GREEN }}>{month}</p>
          <div className="divide-y divide-gray-100">
            {ps.map(p => {
              const open = expanded === p.id
              const doneCount = p.deliverables.filter(d => d.status === 'done').length
              return (
                <div key={p.id}>
                  <button type="button" onClick={() => setExpanded(open ? null : p.id)}
                    className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-gray-50 transition-colors">
                    {open ? <ChevronDown className="w-4 h-4 text-gray-400 shrink-0" /> : <ChevronRight className="w-4 h-4 text-gray-400 shrink-0" />}
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold text-gray-800 truncate">{p.name}</p>
                      <p className="text-[11px] text-gray-400 truncate">
                        {p.date_label || p.start_date || 'No date'}
                        {p.faculty_or_department && ` · ${p.faculty_or_department}`}
                        {p.city && ` · ${p.city}`}
                        {p.member_ids.length > 0 && ` · ${p.member_ids.map(id => memberName.get(id) ?? '?').join(', ')}`}
                      </p>
                    </div>
                    <span className="text-[11px] font-mono text-gray-400 shrink-0">{doneCount}/{p.deliverables.length} deliverables</span>
                    <span className={`text-[10px] px-2 py-0.5 rounded-full font-semibold shrink-0 ${STATUS_META[p.status].cls}`}>{STATUS_META[p.status].label}</span>
                  </button>

                  {open && (
                    <ProjectDetail
                      project={p}
                      typeName={typeName}
                      deliverableTypes={deliverableTypes}
                      members={members}
                      memberName={memberName}
                      isLead={isLead}
                      isAdmin={isAdmin}
                      canSocial={canSocial}
                      onPatch={patch => void patchProject(p.id, patch)}
                      onEdit={() => setEditing(p)}
                      onChanged={() => void reload()}
                      onError={setError}
                    />
                  )}
                </div>
              )
            })}
          </div>
        </div>
      ))}

      {editing && (
        <ProjectModal
          category={category}
          existing={editing === 'new' ? null : editing}
          members={members}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); void reload() }}
        />
      )}
    </div>
  )
}

// ── Project detail (deliverables + social) ─────────────────────────────────

function ProjectDetail({ project: p, typeName, deliverableTypes, members, memberName, isLead, isAdmin, canSocial, onPatch, onEdit, onChanged, onError }: {
  project: MediaProject
  typeName: Map<string, string>
  deliverableTypes: MediaMaster[]
  members: MediaMember[]
  memberName: Map<string, string>
  isLead: boolean
  isAdmin: boolean
  canSocial: boolean
  onPatch: (patch: Partial<MediaProjectInput>) => void
  onEdit: () => void
  onChanged: () => void
  onError: (msg: string) => void
}) {
  const { profile } = useAuth()
  const [newType, setNewType] = useState('')
  const [newPlatform, setNewPlatform] = useState('')

  async function run(fn: () => Promise<unknown>) {
    try { await fn(); onChanged() }
    catch (e) { onError(e instanceof Error ? e.message : 'Failed.') }
  }

  const canTouchDeliverable = (assigned: string[]) =>
    isLead || (profile?.id ? assigned.includes(profile.id) : false)

  return (
    <div className="px-4 pb-4 pl-11 space-y-4">
      {(p.creative_concept || p.hooks || p.remarks) && (
        <div className="text-xs text-gray-500 space-y-0.5">
          {p.creative_concept && <p><strong>Concept:</strong> {p.creative_concept}</p>}
          {p.hooks && <p><strong>Hooks:</strong> {p.hooks}</p>}
          {p.remarks && <p><strong>Remarks:</strong> {p.remarks}</p>}
        </div>
      )}

      {/* Deliverable checklist */}
      <div>
        <p className="text-[11px] font-bold uppercase tracking-widest text-gray-400 mb-1.5">Deliverables</p>
        <div className="space-y-1.5">
          {p.deliverables.map(d => {
            const editable = canTouchDeliverable(d.assigned_user_ids)
            return (
              <div key={d.id} className="flex items-center gap-2 flex-wrap border border-gray-100 rounded-xl px-3 py-2">
                <span className="text-sm font-semibold text-gray-700 w-40 truncate">{typeName.get(d.type_id) ?? '?'}{d.quantity ? ` × ${d.quantity}` : ''}</span>
                <select value={d.status} disabled={!editable}
                  onChange={e => void run(() => mediaApi.updateDeliverable(d.id, { status: e.target.value as MediaDeliverableStatus }))}
                  className={`text-xs border border-gray-200 rounded-lg px-2 py-1 ${d.status === 'done' ? 'bg-emerald-50 text-emerald-700' : d.status === 'in_progress' ? 'bg-amber-50 text-amber-700' : 'bg-white text-gray-600'}`}>
                  {DELIVERABLE_STATUSES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                </select>
                <input defaultValue={d.drive_link} disabled={!editable} placeholder="Paste Drive link…"
                  onBlur={e => { if (e.target.value.trim() !== d.drive_link) void run(() => mediaApi.updateDeliverable(d.id, { drive_link: e.target.value })) }}
                  className="flex-1 min-w-[160px] text-xs border border-gray-200 rounded-lg px-2 py-1" />
                {d.drive_link && (
                  <a href={d.drive_link} target="_blank" rel="noreferrer" className="p-1 rounded-md text-blue-600 hover:bg-blue-50" title="Open in Drive">
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                )}
                {isLead && (
                  <select value="" onChange={e => {
                    if (!e.target.value) return
                    const next = d.assigned_user_ids.includes(e.target.value)
                      ? d.assigned_user_ids.filter(x => x !== e.target.value)
                      : [...d.assigned_user_ids, e.target.value]
                    void run(() => mediaApi.updateDeliverable(d.id, { assigned_user_ids: next }))
                  }} className="text-xs border border-gray-200 rounded-lg px-2 py-1 w-28 text-gray-500">
                    <option value="">Assign…</option>
                    {members.map(m => (
                      <option key={m.id} value={m.id}>
                        {d.assigned_user_ids.includes(m.id) ? '✓ ' : ''}{m.full_name || m.email}
                      </option>
                    ))}
                  </select>
                )}
                {d.assigned_user_ids.length > 0 && (
                  <span className="text-[11px] text-gray-400">{d.assigned_user_ids.map(id => memberName.get(id) ?? '?').join(', ')}</span>
                )}
                {d.completed_at && <span className="text-[11px] text-emerald-600">done {new Date(d.completed_at).toLocaleDateString('en-US', { day: 'numeric', month: 'short' })}</span>}
                {isLead && (
                  <button onClick={() => void run(() => mediaApi.deleteDeliverable(d.id))}
                    className="p-1 rounded-md text-gray-300 hover:bg-rose-50 hover:text-rose-600" title="Remove row">
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            )
          })}
        </div>
        {isLead && (
          <div className="flex items-center gap-2 mt-2">
            <select value={newType} onChange={e => setNewType(e.target.value)} className="text-xs border border-gray-200 rounded-lg px-2 py-1.5">
              <option value="">Add deliverable…</option>
              {deliverableTypes.filter(t => t.is_active).map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
            {newType && (
              <button onClick={() => { void run(() => mediaApi.addDeliverable(p.id, newType)); setNewType('') }}
                className="text-xs px-2.5 py-1.5 rounded-lg text-white font-semibold" style={{ background: GREEN }}>
                Add
              </button>
            )}
          </div>
        )}
      </div>

      {/* Social media posting block */}
      <div>
        <p className="text-[11px] font-bold uppercase tracking-widest text-gray-400 mb-1.5 inline-flex items-center gap-1">
          <Share2 className="w-3 h-3" /> Social Media Posting
        </p>
        {p.social_posts.length === 0 && <p className="text-xs text-gray-400 mb-1.5">No platform rows yet.</p>}
        <div className="space-y-1.5">
          {p.social_posts.map(s => (
            <div key={s.id} className="flex items-center gap-2 flex-wrap border border-gray-100 rounded-xl px-3 py-2">
              <span className="text-sm font-semibold text-gray-700 w-32 truncate">{s.platform}</span>
              <button disabled={!canSocial}
                onClick={() => void run(() => mediaApi.updateSocial(s.id, { is_posted: !s.is_posted }))}
                className={`text-[11px] px-2.5 py-1 rounded-full font-semibold inline-flex items-center gap-1 ${
                  s.is_posted ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-500'
                } ${canSocial ? 'hover:opacity-80' : 'cursor-default'}`}>
                {s.is_posted && <Check className="w-3 h-3" />}{s.is_posted ? 'Posted' : 'Mark as Posted'}
              </button>
              <input defaultValue={s.post_link} disabled={!canSocial} placeholder="Published post link…"
                onBlur={e => { if (e.target.value.trim() !== s.post_link) void run(() => mediaApi.updateSocial(s.id, { post_link: e.target.value })) }}
                className="flex-1 min-w-[160px] text-xs border border-gray-200 rounded-lg px-2 py-1" />
              {s.posted_by && <span className="text-[11px] text-gray-400">by {memberName.get(s.posted_by) ?? '?'}</span>}
              {isLead && (
                <button onClick={() => void run(() => mediaApi.deleteSocial(s.id))}
                  className="p-1 rounded-md text-gray-300 hover:bg-rose-50 hover:text-rose-600" title="Remove row">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          ))}
        </div>
        {canSocial && (
          <div className="flex items-center gap-2 mt-2">
            <input value={newPlatform} onChange={e => setNewPlatform(e.target.value)} placeholder="Platform / output (e.g. Instagram Reel)"
              className="text-xs border border-gray-200 rounded-lg px-2 py-1.5 w-56" />
            {newPlatform.trim() && (
              <button onClick={() => { void run(() => mediaApi.addSocial(p.id, newPlatform.trim())); setNewPlatform('') }}
                className="text-xs px-2.5 py-1.5 rounded-lg text-white font-semibold" style={{ background: GREEN }}>
                Add
              </button>
            )}
          </div>
        )}
      </div>

      {/* Actions */}
      {isLead && (
        <div className="flex items-center gap-2 flex-wrap pt-1">
          <button onClick={onEdit} className="text-xs px-3 py-1.5 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 font-semibold">Edit details</button>
          {p.status !== 'completed' && (
            <button onClick={() => onPatch({ status: 'completed' })}
              className="text-xs px-3 py-1.5 rounded-lg bg-emerald-100 text-emerald-700 hover:opacity-80 font-semibold">Mark Completed</button>
          )}
          {p.status === 'upcoming' && (
            <button onClick={() => onPatch({ status: 'running' })}
              className="text-xs px-3 py-1.5 rounded-lg bg-amber-100 text-amber-800 hover:opacity-80 font-semibold">Mark Running</button>
          )}
          {isAdmin && (
            <button onClick={() => { if (confirm(`Delete "${p.name}" and its deliverables? This cannot be undone.`)) void (async () => { await mediaApi.deleteProject(p.id); onChanged() })() }}
              className="text-xs px-3 py-1.5 rounded-lg bg-rose-100 text-rose-700 hover:opacity-80 font-semibold">Delete</button>
          )}
        </div>
      )}
    </div>
  )
}

// ── Create / edit modal (category drives the field set — Appendix A.2) ─────

function ProjectModal({ category, existing, members, onClose, onSaved }: {
  category: MediaProjectCategory
  existing: MediaProject | null
  members: MediaMember[]
  onClose: () => void
  onSaved: () => void
}) {
  const cat = existing?.category ?? category
  const [form, setForm] = useState<MediaProjectInput>(() => existing ? {
    category: existing.category,
    name: existing.name,
    month: existing.month,
    faculty_or_department: existing.faculty_or_department,
    event_type: existing.event_type,
    organization: existing.organization,
    city: existing.city,
    occasion: existing.occasion,
    shoot_type: existing.shoot_type,
    creative_concept: existing.creative_concept,
    hooks: existing.hooks,
    output: existing.output,
    date_label: existing.date_label,
    start_date: existing.start_date,
    end_date: existing.end_date,
    status: existing.status,
    remarks: existing.remarks,
    member_ids: existing.member_ids,
  } : { category: cat, name: '', member_ids: [], status: 'upcoming' })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const set = (patch: Partial<MediaProjectInput>) => setForm(f => ({ ...f, ...patch }))

  async function save() {
    if (!form.name?.trim()) { setError('Project name is required.'); return }
    setSaving(true)
    setError(null)
    try {
      if (existing) await mediaApi.updateProject(existing.id, form)
      else await mediaApi.createProject(form)
      onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save.')
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl border border-gray-100 w-full max-w-xl max-h-[90vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <div>
            <h2 className="text-base font-extrabold font-serif" style={{ color: GREEN }}>
              {existing ? 'Edit project' : `New ${MEDIA_CATEGORY_META[cat].label.replace(/s$/, '')}`}
            </h2>
            <p className="text-xs text-gray-400">{MEDIA_CATEGORY_META[cat].label} · default deliverables auto-attach on create</p>
          </div>
          <button onClick={onClose} className="p-2 rounded-lg hover:bg-gray-50 text-gray-400"><X className="w-4 h-4" /></button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-3">
          <div>
            <label className={labelCls}>Name *</label>
            <input className={inputCls} value={form.name} onChange={e => set({ name: e.target.value })}
              placeholder={cat === 'branding_content' ? 'e.g. Makar Sankranti Reel' : 'e.g. YEEP 2026'} />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Month</label>
              <input className={inputCls} value={form.month ?? ''} onChange={e => set({ month: e.target.value })} placeholder="e.g. July" />
            </div>
            <div>
              <label className={labelCls}>Date label (verbatim)</label>
              <input className={inputCls} value={form.date_label ?? ''} onChange={e => set({ date_label: e.target.value })} placeholder='e.g. 9th - 25th July 2026' />
            </div>
            <div>
              <label className={labelCls}>Start date</label>
              <input type="date" className={inputCls} value={form.start_date ?? ''} onChange={e => set({ start_date: e.target.value || null })} />
            </div>
            <div>
              <label className={labelCls}>End date</label>
              <input type="date" className={inputCls} value={form.end_date ?? ''} onChange={e => set({ end_date: e.target.value || null })} />
            </div>
          </div>

          <div>
            <label className={labelCls}>Department / Faculty</label>
            <input className={inputCls} value={form.faculty_or_department ?? ''} onChange={e => set({ faculty_or_department: e.target.value })} placeholder="e.g. CIRR" />
          </div>

          {cat === 'academic_cultural' && (
            <div>
              <label className={labelCls}>Event type</label>
              <select className={inputCls} value={form.event_type ?? ''} onChange={e => set({ event_type: e.target.value })}>
                <option value="">Select…</option>
                {MEDIA_EVENT_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
          )}

          {cat === 'educational_tour' && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelCls}>Organization</label>
                <select className={inputCls} value={form.organization ?? ''} onChange={e => set({ organization: e.target.value })}>
                  <option value="">Select…</option>
                  {MEDIA_ORGANIZATIONS.map(o => <option key={o} value={o}>{o}</option>)}
                </select>
              </div>
              <div>
                <label className={labelCls}>City</label>
                <input className={inputCls} value={form.city ?? ''} onChange={e => set({ city: e.target.value })} placeholder="e.g. Bengaluru" />
              </div>
            </div>
          )}

          {cat === 'branding_content' && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={labelCls}>Occasion / Series</label>
                  <input className={inputCls} value={form.occasion ?? ''} onChange={e => set({ occasion: e.target.value })} placeholder="e.g. Makar Sankranti" />
                </div>
                <div>
                  <label className={labelCls}>Shoot type</label>
                  <select className={inputCls} value={form.shoot_type ?? ''} onChange={e => set({ shoot_type: e.target.value })}>
                    <option value="">Select…</option>
                    {MEDIA_SHOOT_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                  </select>
                </div>
              </div>
              <div>
                <label className={labelCls}>Creative concept</label>
                <input className={inputCls} value={form.creative_concept ?? ''} onChange={e => set({ creative_concept: e.target.value })} />
              </div>
              <div>
                <label className={labelCls}>Hooks / content ideas</label>
                <input className={inputCls} value={form.hooks ?? ''} onChange={e => set({ hooks: e.target.value })} />
              </div>
              <div>
                <label className={labelCls}>Output</label>
                <input className={inputCls} value={form.output ?? ''} onChange={e => set({ output: e.target.value })} />
              </div>
            </>
          )}

          <div>
            <label className={labelCls}>Deputed members</label>
            <div className="border border-gray-200 rounded-xl max-h-36 overflow-y-auto divide-y divide-gray-50">
              {members.length === 0 ? (
                <p className="px-3 py-4 text-xs text-gray-400 text-center">No Media Crew members yet.</p>
              ) : members.map(m => (
                <label key={m.id} className="flex items-center gap-2.5 px-3 py-2 hover:bg-gray-50 cursor-pointer">
                  <input type="checkbox" checked={(form.member_ids ?? []).includes(m.id)}
                    onChange={() => {
                      const cur = form.member_ids ?? []
                      set({ member_ids: cur.includes(m.id) ? cur.filter(x => x !== m.id) : [...cur, m.id] })
                    }} />
                  <span className="text-sm text-gray-700">{m.full_name || m.email}</span>
                </label>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Status</label>
              <select className={inputCls} value={form.status ?? 'upcoming'} onChange={e => set({ status: e.target.value as MediaProjectStatus })}>
                {Object.entries(STATUS_META).map(([v, m]) => <option key={v} value={v}>{m.label}</option>)}
              </select>
            </div>
            <div>
              <label className={labelCls}>Remarks</label>
              <input className={inputCls} value={form.remarks ?? ''} onChange={e => set({ remarks: e.target.value })} />
            </div>
          </div>
        </div>

        {error && <div className="px-5 py-2 text-xs text-rose-700 bg-rose-50 border-t border-rose-100">{error}</div>}
        <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-gray-100">
          <button onClick={onClose} disabled={saving}
            className="px-4 py-2 rounded-xl border border-gray-200 text-sm font-semibold text-gray-500 hover:bg-gray-50 disabled:opacity-50">Cancel</button>
          <button onClick={() => void save()} disabled={saving}
            className="px-5 py-2 rounded-xl text-sm font-semibold text-white disabled:opacity-50" style={{ background: GREEN }}>
            {saving ? 'Saving…' : existing ? 'Save changes' : 'Create project'}
          </button>
        </div>
      </div>
    </div>
  )
}
