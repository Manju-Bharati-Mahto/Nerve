/**
 * Project page (W4): header with BR-1 status transitions, progress ring
 * (deliverable-weighted per D3), tabs — Overview / Deliverables / Team /
 * Files & Links / Activity. Deliverables embed the version → review → deliver
 * workflow (FR-4.2/4.4/4.5, BR-5/BR-6) inline.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft, Plus, Trash2, ExternalLink, Check, XCircle, Send, UserPlus, Link as LinkIcon } from 'lucide-react'
import { toast } from 'sonner'
import { useAuth } from '@/hooks/useAuth'
import { mediaApi, type ProjectDetailPayload } from '@/lib/media-api'
import { useMedia } from './MediaShell'
import {
  MEDIA_GREEN, PROJECT_STATUS_META, DELIVERABLE_STATUS_META, MEDIA_PROJECT_STATUSES, fmtMinutes,
  type MediaDeliverable,
} from '@/lib/media-types'

const inputCls = 'w-full text-sm border border-gray-200 rounded-xl px-3 py-2.5 bg-white focus:outline-none focus:ring-2 focus:ring-green-200'
const labelCls = 'text-xs font-bold uppercase tracking-wide mb-1 block'

type Tab = 'overview' | 'deliverables' | 'team' | 'files' | 'activity'

export default function MediaProjectDetail() {
  const { projectId } = useParams<{ projectId: string }>()
  const { mediaRole, lookups, team } = useMedia()
  const { profile } = useAuth()
  const [detail, setDetail] = useState<ProjectDetailPayload | null>(null)
  const [tab, setTab] = useState<Tab>('overview')
  const [addingDeliverable, setAddingDeliverable] = useState(false)
  const [addingMember, setAddingMember] = useState(false)
  const [addingLink, setAddingLink] = useState(false)

  const load = useCallback(() => {
    if (projectId) mediaApi.getProject(projectId).then(setDetail).catch(() => setDetail(null))
  }, [projectId])
  useEffect(load, [load])

  const isLead = mediaRole !== 'employee'
  const isOwnerOrPm = !!detail && (detail.project.owner_id === profile?.id ||
    detail.assignments.some(a => a.user_id === profile?.id && a.is_project_manager))
  const canManage = isLead || isOwnerOrPm

  const typeById = useMemo(() => new Map(lookups.project_types.map(t => [t.id, t])), [lookups])
  const userById = useMemo(() => new Map(team.map(u => [u.id, u.full_name])), [team])

  if (!detail) {
    return <div className="space-y-4">{[1, 2].map(i => <div key={i} className="bg-white rounded-2xl border border-gray-100 h-40 animate-pulse" />)}</div>
  }

  const p = detail.project
  const sm = PROJECT_STATUS_META[p.status]
  const t = typeById.get(p.project_type_id)

  async function changeStatus(to: string) {
    try {
      await mediaApi.setProjectStatus(p.id, to)
      toast.success(`Status → ${PROJECT_STATUS_META[to as keyof typeof PROJECT_STATUS_META]?.label ?? to}`)
      load()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Transition not allowed.') }
  }

  return (
    <div className="space-y-5">
      <Link to="/media/projects" className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700">
        <ArrowLeft className="w-4 h-4" /> All projects
      </Link>

      {/* Header (W4) */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-lg font-extrabold font-serif" style={{ color: MEDIA_GREEN }}>{p.name}</h1>
              <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full" style={{ background: `${t?.color ?? '#6b7280'}18`, color: t?.color ?? '#6b7280' }}>{t?.name}</span>
              <span className={`text-[10px] font-bold uppercase ${p.priority === 'urgent' ? 'text-rose-600' : p.priority === 'high' ? 'text-amber-600' : 'text-gray-400'}`}>{p.priority}</span>
            </div>
            <p className="text-xs text-gray-400 font-mono mt-0.5">{p.code}{p.faculty_served ? ` · ${p.faculty_served}` : ''}{p.start_date ? ` · ${p.start_date}${p.end_date ? ` → ${p.end_date}` : ''}` : ''}</p>
            <p className="text-[11px] text-gray-500 mt-1">Owner: <span className="font-semibold">{userById.get(p.owner_id) ?? '—'}</span> · {fmtMinutes(p.logged_minutes ?? 0)} logged</p>
          </div>
          <div className="flex items-center gap-3">
            <ProgressRing pct={p.progress ?? 0} />
            {canManage ? (
              <select value={p.status} onChange={e => changeStatus(e.target.value)} title="Change status (allowed transitions enforced)"
                className="text-[11px] font-bold uppercase px-2 py-1.5 rounded-full border-0 cursor-pointer"
                style={{ background: sm.bg, color: sm.fg }}>
                {MEDIA_PROJECT_STATUSES.map(s => <option key={s} value={s}>{PROJECT_STATUS_META[s].label}</option>)}
              </select>
            ) : (
              <span className="text-[11px] font-bold uppercase px-2.5 py-1.5 rounded-full" style={{ background: sm.bg, color: sm.fg }}>{sm.label}</span>
            )}
          </div>
        </div>
        {p.status === 'proposed' && isLead && (
          <div className="mt-3 bg-violet-50 border border-violet-200 rounded-xl p-3 flex items-center justify-between gap-3">
            <p className="text-xs text-violet-800">This proposal is awaiting approval — it can't be reported against yet.</p>
            <button onClick={() => changeStatus('approved')} className="text-xs font-bold px-3 py-1.5 rounded-lg text-white shrink-0" style={{ background: '#6d28d9' }}>Approve</button>
          </div>
        )}
        {p.description && <p className="text-sm text-gray-600 mt-3">{p.description}</p>}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-white rounded-2xl border border-gray-100 shadow-sm p-1.5">
        {(['overview', 'deliverables', 'team', 'files', 'activity'] as Tab[]).map(k => (
          <button key={k} onClick={() => setTab(k)}
            className={`flex-1 py-2 rounded-xl text-xs font-bold capitalize transition-colors ${tab === k ? 'text-white' : 'text-gray-500 hover:bg-gray-50'}`}
            style={tab === k ? { background: MEDIA_GREEN } : undefined}>
            {k === 'files' ? 'Files & Links' : k}
          </button>
        ))}
      </div>

      {tab === 'overview' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4">
            <h2 className="text-sm font-bold mb-3" style={{ color: MEDIA_GREEN }}>Deliverable status</h2>
            {detail.deliverables.length === 0 ? <p className="text-sm text-gray-400 py-4 text-center">None yet.</p> : (
              <div className="space-y-2">
                {detail.deliverables.map(d => {
                  const dm = DELIVERABLE_STATUS_META[d.status]
                  return (
                    <div key={d.id} className="flex items-center justify-between gap-2">
                      <p className="text-xs text-gray-700 truncate">{d.title}{d.due_date && <span className="text-gray-400"> · due {d.due_date}</span>}</p>
                      <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded-full shrink-0" style={{ background: dm.bg, color: dm.fg }}>{dm.label}</span>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4">
            <h2 className="text-sm font-bold mb-3" style={{ color: MEDIA_GREEN }}>Logged hours by member</h2>
            {detail.memberHours.length === 0 ? <p className="text-sm text-gray-400 py-4 text-center">No task logs yet.</p> : (
              <div className="space-y-2">
                {detail.memberHours.map(h => (
                  <div key={h.user_id} className="flex items-center justify-between">
                    <p className="text-xs text-gray-700">{h.full_name}</p>
                    <p className="text-xs font-mono tabular-nums text-gray-500">{fmtMinutes(h.minutes)}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {tab === 'deliverables' && (
        <div className="space-y-3">
          {canManage && (
            <div className="flex justify-end">
              <button onClick={() => setAddingDeliverable(true)}
                className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-bold text-white" style={{ background: MEDIA_GREEN }}>
                <Plus className="w-3.5 h-3.5" /> Add deliverable
              </button>
            </div>
          )}
          {detail.deliverables.length === 0 ? (
            <div className="bg-white rounded-2xl border border-gray-100 p-10 text-center text-sm text-gray-400">No deliverables yet.</div>
          ) : detail.deliverables.map(d => (
            <DeliverableCard key={d.id} deliverable={d} canManage={canManage} onChanged={load} userById={userById} />
          ))}
        </div>
      )}

      {tab === 'team' && (
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-bold" style={{ color: MEDIA_GREEN }}>Assigned crew</h2>
            {isLead && (
              <button onClick={() => setAddingMember(true)} className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-bold text-white" style={{ background: MEDIA_GREEN }}>
                <UserPlus className="w-3.5 h-3.5" /> Assign member
              </button>
            )}
          </div>
          {detail.assignments.length === 0 ? <p className="text-sm text-gray-400 py-6 text-center">Nobody assigned yet.</p> : (
            <div className="divide-y divide-gray-50">
              {detail.assignments.map(a => (
                <div key={a.id} className="flex items-center justify-between py-2.5">
                  <div>
                    <p className="text-xs font-semibold text-gray-800">{a.full_name}{a.is_project_manager && <span className="ml-1.5 text-[9px] font-bold text-white px-1.5 py-0.5 rounded" style={{ background: MEDIA_GREEN }}>PM</span>}</p>
                    <p className="text-[11px] text-gray-400">{a.capacity_role_name ?? 'Crew'}</p>
                  </div>
                  {isLead && (
                    <button onClick={async () => { await mediaApi.removeAssignment(p.id, a.user_id); load() }}
                      className="p-1.5 rounded-lg text-gray-400 hover:text-rose-600 hover:bg-rose-50"><Trash2 className="w-3.5 h-3.5" /></button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'files' && (
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-bold" style={{ color: MEDIA_GREEN }}>Drive links</h2>
            <button onClick={() => setAddingLink(true)} className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-bold text-white" style={{ background: MEDIA_GREEN }}>
              <LinkIcon className="w-3.5 h-3.5" /> Add link
            </button>
          </div>
          {detail.links.length === 0 ? <p className="text-sm text-gray-400 py-6 text-center">No links yet — every asset lives in Drive, linked here.</p> : (
            <div className="divide-y divide-gray-50">
              {detail.links.map(l => (
                <a key={l.id} href={l.url} target="_blank" rel="noreferrer" className="flex items-center justify-between py-2.5 group">
                  <div className="min-w-0">
                    <p className="text-xs font-semibold text-gray-800 group-hover:underline truncate">{l.label || l.url}</p>
                    <p className="text-[11px] text-gray-400">{l.added_by_name ?? ''} · {new Date(l.created_at).toLocaleDateString('en-IN')}</p>
                  </div>
                  <ExternalLink className="w-3.5 h-3.5 text-gray-400 shrink-0" />
                </a>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'activity' && (
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4">
          <h2 className="text-sm font-bold mb-3" style={{ color: MEDIA_GREEN }}>Activity</h2>
          {detail.activity.length === 0 ? <p className="text-sm text-gray-400 py-6 text-center">No activity yet.</p> : (
            <div className="space-y-2">
              {detail.activity.map((a, i) => (
                <p key={i} className="text-xs text-gray-500">
                  <span className="font-semibold text-gray-700">{a.actor_name ?? 'System'}</span>{' '}
                  {a.action.replace(/\./g, ' ').replace(/_/g, ' ')}
                  <span className="text-gray-300"> · {new Date(a.occurred_at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
                </p>
              ))}
            </div>
          )}
        </div>
      )}

      {addingDeliverable && <AddDeliverableModal projectId={p.id} onClose={() => setAddingDeliverable(false)} onSaved={() => { setAddingDeliverable(false); load() }} />}
      {addingMember && <AssignMemberModal projectId={p.id} onClose={() => setAddingMember(false)} onSaved={() => { setAddingMember(false); load() }} />}
      {addingLink && <AddLinkModal projectId={p.id} onClose={() => setAddingLink(false)} onSaved={() => { setAddingLink(false); load() }} />}
    </div>
  )
}

function ProgressRing({ pct }: { pct: number }) {
  const r = 20, c = 2 * Math.PI * r
  return (
    <div className="relative w-12 h-12" title={`Deliverable-weighted progress: ${pct}%`}>
      <svg viewBox="0 0 48 48" className="w-12 h-12 -rotate-90">
        <circle cx="24" cy="24" r={r} strokeWidth="5" fill="none" stroke="#e5e7eb" />
        <circle cx="24" cy="24" r={r} strokeWidth="5" fill="none" stroke={MEDIA_GREEN}
          strokeDasharray={`${(pct / 100) * c} ${c}`} strokeLinecap="round" />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center text-[10px] font-bold" style={{ color: MEDIA_GREEN }}>{pct}%</span>
    </div>
  )
}

// ── Deliverable card with versions workflow (W5) ────────────────────────────

function DeliverableCard({ deliverable: d, canManage, onChanged, userById }: {
  deliverable: MediaDeliverable
  canManage: boolean
  onChanged: () => void
  userById: Map<string, string>
}) {
  const { profile } = useAuth()
  const { team } = useMedia()
  const [open, setOpen] = useState(false)
  const [full, setFull] = useState<MediaDeliverable | null>(null)
  const [driveUrl, setDriveUrl] = useState('')
  const [note, setNote] = useState('')
  const [reviewComment, setReviewComment] = useState('')

  const dm = DELIVERABLE_STATUS_META[d.status]
  const isOwner = d.owner_id === profile?.id

  useEffect(() => {
    if (open) mediaApi.getDeliverable(d.id).then(r => setFull(r.deliverable))
  }, [open, d.id])

  async function act(fn: () => Promise<unknown>, success: string) {
    try { await fn(); toast.success(success); onChanged(); setFull(null); if (open) mediaApi.getDeliverable(d.id).then(r => setFull(r.deliverable)) }
    catch (e) { toast.error(e instanceof Error ? e.message : 'Action failed.') }
  }

  const latest = full?.versions?.[0]

  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4">
      <button className="w-full flex items-center justify-between gap-3 text-left" onClick={() => setOpen(o => !o)}>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-gray-800 truncate">{d.title}</p>
          <p className="text-[11px] text-gray-400">
            {d.owner_id ? (userById.get(d.owner_id) ?? 'Assigned') : 'Unowned'}
            {d.due_date && ` · due ${d.due_date}`}
            {d.quantity_target != null && ` · target ${d.quantity_target} ${d.unit ?? ''}`}
            {` · ${d.version_count ?? 0} version${(d.version_count ?? 0) === 1 ? '' : 's'}`}
          </p>
        </div>
        <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded-full shrink-0" style={{ background: dm.bg, color: dm.fg }}>{dm.label}</span>
      </button>

      {open && (
        <div className="mt-3 pt-3 border-t border-gray-50 space-y-3">
          {/* Owner + delivery metadata (FR-4.5) */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <select className={`${inputCls} py-1.5 text-xs`} value={d.owner_id ?? ''} disabled={!canManage && !isOwner}
              onChange={e => act(() => mediaApi.updateDeliverable(d.id, { owner_id: e.target.value || null }), 'Owner updated.')}>
              <option value="">Unowned</option>
              {team.map(u => <option key={u.id} value={u.id}>{u.full_name}</option>)}
            </select>
            <select className={`${inputCls} py-1.5 text-xs`} value={d.social_status}
              onChange={e => act(() => mediaApi.updateDeliverable(d.id, { social_status: e.target.value }), 'Social status updated.')}>
              <option value="na">Social: N/A</option><option value="scheduled">Social: Scheduled</option><option value="posted">Social: Posted</option>
            </select>
            <select className={`${inputCls} py-1.5 text-xs`} value={d.mail_status}
              onChange={e => act(() => mediaApi.updateDeliverable(d.id, { mail_status: e.target.value }), 'Mail status updated.')}>
              <option value="na">Mail: N/A</option><option value="pending">Mail: Pending</option><option value="sent">Mail: Sent</option>
            </select>
          </div>

          {/* Versions timeline */}
          <div className="space-y-2">
            {(full?.versions ?? []).map(v => (
              <div key={v.id} className="flex items-start justify-between gap-2 bg-gray-50 rounded-xl px-3 py-2">
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-gray-800">
                    v{v.version_no} · {v.review_status === 'pending' ? 'awaiting review' : v.review_status === 'approved' ? 'approved' : 'changes requested'}
                  </p>
                  {v.note && <p className="text-[11px] text-gray-500">{v.note}</p>}
                  {v.review_comment && <p className="text-[11px] text-amber-700">↳ {v.review_comment}</p>}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <a href={v.drive_url} target="_blank" rel="noreferrer" className="p-1.5 rounded-lg text-gray-400 hover:text-green-800 hover:bg-green-50" title="Open Drive link">
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                  {v.review_status === 'pending' && v.submitted_by !== profile?.id && canManage && (
                    <>
                      <button title="Approve" onClick={() => act(() => mediaApi.reviewVersion(v.id, { outcome: 'approved', comment: reviewComment || undefined }), 'Version approved.')}
                        className="p-1.5 rounded-lg text-green-700 hover:bg-green-50"><Check className="w-3.5 h-3.5" /></button>
                      <button title="Request changes" onClick={() => {
                        if (!reviewComment.trim()) { toast.error('Add a comment describing the changes first.'); return }
                        void act(() => mediaApi.reviewVersion(v.id, { outcome: 'changes_requested', comment: reviewComment }), 'Changes requested.')
                      }} className="p-1.5 rounded-lg text-rose-600 hover:bg-rose-50"><XCircle className="w-3.5 h-3.5" /></button>
                    </>
                  )}
                </div>
              </div>
            ))}
            {latest?.review_status === 'pending' && canManage && latest.submitted_by !== profile?.id && (
              <input className={`${inputCls} py-1.5 text-xs`} value={reviewComment} onChange={e => setReviewComment(e.target.value)} placeholder="Review comment (required for change requests)…" />
            )}
          </div>

          {/* Submit new version */}
          {!['delivered', 'not_required', 'cancelled'].includes(d.status) && (
            <div className="flex gap-2">
              <input className={`${inputCls} py-1.5 text-xs flex-1`} value={driveUrl} onChange={e => setDriveUrl(e.target.value)} placeholder="Drive link for the next version…" />
              <input className={`${inputCls} py-1.5 text-xs w-40`} value={note} onChange={e => setNote(e.target.value)} placeholder="Note" />
              <button onClick={() => {
                if (!driveUrl.trim()) { toast.error('Paste the Drive link first.'); return }
                void act(async () => { await mediaApi.submitVersion(d.id, { drive_url: driveUrl.trim(), note }); setDriveUrl(''); setNote('') }, 'Version submitted for review.')
              }} className="px-3 py-1.5 rounded-xl text-xs font-bold text-white shrink-0 flex items-center gap-1" style={{ background: MEDIA_GREEN }}>
                <Send className="w-3 h-3" /> Submit
              </button>
            </div>
          )}

          {/* Deliver (BR-6) */}
          {d.status === 'approved' && (canManage || isOwner) && (
            <button onClick={() => act(() => mediaApi.markDelivered(d.id), 'Marked delivered. 🎉')}
              className="w-full py-2 rounded-xl text-xs font-bold text-white" style={{ background: MEDIA_GREEN }}>
              Mark Delivered
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// ── Modals ─────────────────────────────────────────────────────────────────

function AddDeliverableModal({ projectId, onClose, onSaved }: { projectId: string; onClose: () => void; onSaved: () => void }) {
  const { lookups, team } = useMedia()
  const [typeId, setTypeId] = useState('')
  const [title, setTitle] = useState('')
  const [ownerId, setOwnerId] = useState('')
  const [due, setDue] = useState('')
  const [qty, setQty] = useState('')
  const [saving, setSaving] = useState(false)

  async function save() {
    if (!typeId) { toast.error('Pick a type.'); return }
    if (!title.trim()) { toast.error('Title is required.'); return }
    setSaving(true)
    try {
      await mediaApi.createDeliverable(projectId, {
        deliverable_type_id: typeId, title: title.trim(), owner_id: ownerId || null,
        due_date: due || null, quantity_target: qty ? parseInt(qty, 10) : null,
      })
      toast.success('Deliverable added.'); onSaved()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed.') } finally { setSaving(false) }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl w-full max-w-md p-5 space-y-3" onClick={e => e.stopPropagation()}>
        <h2 className="text-base font-extrabold font-serif" style={{ color: MEDIA_GREEN }}>Add deliverable</h2>
        <select className={inputCls} value={typeId} onChange={e => { setTypeId(e.target.value); if (!title) setTitle(lookups.deliverable_types.find(t => t.id === e.target.value)?.name ?? '') }}>
          <option value="">Type…</option>
          {lookups.deliverable_types.filter(t => t.is_active).map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        <input className={inputCls} value={title} onChange={e => setTitle(e.target.value)} placeholder="Title" />
        <div className="grid grid-cols-2 gap-3">
          <select className={inputCls} value={ownerId} onChange={e => setOwnerId(e.target.value)}>
            <option value="">Unowned</option>
            {team.map(u => <option key={u.id} value={u.id}>{u.full_name}</option>)}
          </select>
          <input type="date" className={inputCls} value={due} onChange={e => setDue(e.target.value)} />
        </div>
        <input type="number" min={1} className={inputCls} value={qty} onChange={e => setQty(e.target.value)} placeholder="Quantity target (optional)" />
        <div className="flex gap-2">
          <button onClick={onClose} className="flex-1 py-2.5 rounded-xl border border-gray-200 text-sm font-semibold text-gray-600">Cancel</button>
          <button onClick={save} disabled={saving} className="flex-1 py-2.5 rounded-xl text-sm font-bold text-white disabled:opacity-50" style={{ background: MEDIA_GREEN }}>{saving ? 'Adding…' : 'Add'}</button>
        </div>
      </div>
    </div>
  )
}

function AssignMemberModal({ projectId, onClose, onSaved }: { projectId: string; onClose: () => void; onSaved: () => void }) {
  const { lookups, team } = useMedia()
  const [userId, setUserId] = useState('')
  const [roleId, setRoleId] = useState('')
  const [pm, setPm] = useState(false)
  const [saving, setSaving] = useState(false)

  async function save() {
    if (!userId) { toast.error('Pick a member.'); return }
    setSaving(true)
    try {
      await mediaApi.addAssignment(projectId, { user_id: userId, capacity_role_id: roleId || null, is_project_manager: pm })
      toast.success('Assigned.'); onSaved()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed.') } finally { setSaving(false) }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl w-full max-w-md p-5 space-y-3" onClick={e => e.stopPropagation()}>
        <h2 className="text-base font-extrabold font-serif" style={{ color: MEDIA_GREEN }}>Assign member</h2>
        <select className={inputCls} value={userId} onChange={e => setUserId(e.target.value)}>
          <option value="">Member…</option>
          {team.filter(u => ['admin', 'sub_admin', 'user'].includes(u.role)).map(u => <option key={u.id} value={u.id}>{u.full_name}</option>)}
        </select>
        <select className={inputCls} value={roleId} onChange={e => setRoleId(e.target.value)}>
          <option value="">Capacity role…</option>
          {lookups.capacity_roles.filter(r => r.is_active).map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
        <label className="flex items-center gap-2 text-sm text-gray-600">
          <input type="checkbox" checked={pm} onChange={e => setPm(e.target.checked)} />
          Project Manager (duty flag — one per project)
        </label>
        <div className="flex gap-2">
          <button onClick={onClose} className="flex-1 py-2.5 rounded-xl border border-gray-200 text-sm font-semibold text-gray-600">Cancel</button>
          <button onClick={save} disabled={saving} className="flex-1 py-2.5 rounded-xl text-sm font-bold text-white disabled:opacity-50" style={{ background: MEDIA_GREEN }}>{saving ? 'Assigning…' : 'Assign'}</button>
        </div>
      </div>
    </div>
  )
}

function AddLinkModal({ projectId, onClose, onSaved }: { projectId: string; onClose: () => void; onSaved: () => void }) {
  const [label, setLabel] = useState('')
  const [url, setUrl] = useState('')
  const [saving, setSaving] = useState(false)

  async function save() {
    if (!url.trim()) { toast.error('Paste the Drive URL.'); return }
    setSaving(true)
    try {
      await mediaApi.addProjectLink(projectId, { label: label.trim(), url: url.trim() })
      toast.success('Link added.'); onSaved()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Only Google Drive / Docs links are accepted.') } finally { setSaving(false) }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl w-full max-w-md p-5 space-y-3" onClick={e => e.stopPropagation()}>
        <h2 className="text-base font-extrabold font-serif" style={{ color: MEDIA_GREEN }}>Add Drive link</h2>
        <input className={inputCls} value={label} onChange={e => setLabel(e.target.value)} placeholder="Label (e.g. Raw photos — Day 1)" />
        <input className={inputCls} value={url} onChange={e => setUrl(e.target.value)} placeholder="https://drive.google.com/…" />
        <div className="flex gap-2">
          <button onClick={onClose} className="flex-1 py-2.5 rounded-xl border border-gray-200 text-sm font-semibold text-gray-600">Cancel</button>
          <button onClick={save} disabled={saving} className="flex-1 py-2.5 rounded-xl text-sm font-bold text-white disabled:opacity-50" style={{ background: MEDIA_GREEN }}>{saving ? 'Adding…' : 'Add'}</button>
        </div>
      </div>
    </div>
  )
}
