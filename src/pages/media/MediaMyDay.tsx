/**
 * My Day — the P3 field-creator screen (W2/W3): log-as-you-go task cards (D1),
 * smart time defaults (start = last task's end), and one-click review-and-
 * submit of the accumulated day (FR-2.1/2.2/2.3, NFR-4: submit ≤ 3 taps).
 */
import { useEffect, useMemo, useState } from 'react'
import { Plus, Trash2, Send, CheckCircle, AlertTriangle, Link as LinkIcon } from 'lucide-react'
import { toast } from 'sonner'
import { mediaApi } from '@/lib/media-api'
import { useMedia } from './MediaShell'
import {
  MEDIA_GREEN, REPORT_STATUS_META, fmtMinutes, todayISO,
  type MediaDailyReport, type MediaProject,
} from '@/lib/media-types'

const inputCls = 'w-full text-sm border border-gray-200 rounded-xl px-3 py-2.5 bg-white focus:outline-none focus:ring-2 focus:ring-green-200'
const labelCls = 'text-xs font-bold uppercase tracking-wide mb-1 block'

export default function MediaMyDay() {
  const [date, setDate] = useState(todayISO())
  const [report, setReport] = useState<MediaDailyReport | null>(null)
  const [projects, setProjects] = useState<MediaProject[]>([])
  const [logOpen, setLogOpen] = useState(false)
  const [submitOpen, setSubmitOpen] = useState(false)

  useEffect(() => { mediaApi.myReport(date).then(r => setReport(r.report)) }, [date])
  useEffect(() => { mediaApi.listProjects().then(r => setProjects(r.projects)) }, [])

  // BR-11: proposed/closed projects are non-reportable.
  const reportable = useMemo(
    () => projects.filter(p => !['proposed', 'cancelled', 'archived', 'completed'].includes(p.status)),
    [projects],
  )

  const tasks = report?.tasks ?? []
  const editable = !report || ['draft', 'returned'].includes(report.status)
  const statusMeta = report ? REPORT_STATUS_META[report.status] : REPORT_STATUS_META.draft

  async function removeTask(taskId: string) {
    try {
      const r = await mediaApi.deleteTask(taskId)
      setReport(r.report)
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to delete task.') }
  }

  return (
    <div className="space-y-5 max-w-3xl">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-lg font-extrabold font-serif" style={{ color: MEDIA_GREEN }}>My Day</h1>
          <p className="text-sm text-gray-500">Log tasks as you work — your daily report assembles itself.</p>
        </div>
        <div className="flex items-center gap-2">
          <input type="date" className={`${inputCls} w-auto py-2`} value={date} max={todayISO()} onChange={e => setDate(e.target.value)} />
          <span className="text-[10px] font-bold uppercase px-2.5 py-1.5 rounded-full" style={{ background: statusMeta.bg, color: statusMeta.fg }}>
            {statusMeta.label}{tasks.length > 0 && ` — ${tasks.length} task${tasks.length === 1 ? '' : 's'}`}
          </span>
        </div>
      </div>

      {report?.status === 'returned' && report.review_comment && (
        <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 text-sm text-amber-900 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <div><span className="font-semibold">Returned by your lead:</span> {report.review_comment}</div>
        </div>
      )}
      {report?.status === 'flagged' && (
        <div className="bg-rose-50 border border-rose-200 rounded-2xl p-4 text-sm text-rose-900 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <div><span className="font-semibold">Flagged for review:</span> {report.flagged_reason}</div>
        </div>
      )}

      {/* Task list */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-bold" style={{ color: MEDIA_GREEN }}>
            Task log {report && <span className="text-gray-400 font-normal">· {fmtMinutes(report.total_minutes)} total</span>}
          </h2>
          {editable && (
            <button onClick={() => setLogOpen(true)}
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-sm font-semibold text-white hover:opacity-90" style={{ background: MEDIA_GREEN }}>
              <Plus className="w-4 h-4" /> Log Task
            </button>
          )}
        </div>
        {tasks.length === 0 ? (
          <p className="text-sm text-gray-400 py-10 text-center">Nothing logged for {date} yet.</p>
        ) : (
          <div className="space-y-2">
            {tasks.map(t => (
              <div key={t.id} className="border border-gray-100 rounded-xl p-3 flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-semibold text-gray-800">
                    {t.project_name} <span className="text-gray-400 font-normal">· {t.category_name}</span>
                    {t.deliverable_title && <span className="text-gray-400 font-normal"> → {t.deliverable_title}</span>}
                  </p>
                  <p className="text-xs text-gray-600 mt-0.5">{t.description}</p>
                  <p className="text-[11px] text-gray-400 mt-1">
                    {t.start_time && t.end_time ? `${t.start_time.slice(0, 5)}–${t.end_time.slice(0, 5)} · ` : ''}
                    {fmtMinutes(t.minutes)}
                    {t.quantity ? ` · ${t.quantity} ${t.unit ?? ''}` : ''}
                    {t.status !== 'done' && <span className={`ml-1 font-semibold ${t.status === 'blocked' ? 'text-rose-600' : 'text-sky-600'}`}>· {t.status === 'blocked' ? `Blocked: ${t.blocker_note}` : 'In progress'}</span>}
                  </p>
                </div>
                {t.evidence_url && (
                  <a href={t.evidence_url} target="_blank" rel="noreferrer" title="Evidence link"
                    className="p-1.5 rounded-lg text-gray-400 hover:text-green-800 hover:bg-green-50"><LinkIcon className="w-3.5 h-3.5" /></a>
                )}
                {editable && (
                  <button onClick={() => removeTask(t.id)} title="Delete task"
                    className="p-1.5 rounded-lg text-gray-400 hover:text-rose-600 hover:bg-rose-50"><Trash2 className="w-3.5 h-3.5" /></button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Submit bar (W2 §3) */}
      {editable && tasks.length > 0 && (
        <button onClick={() => setSubmitOpen(true)}
          className="w-full py-3 rounded-2xl text-sm font-bold text-white shadow-sm hover:opacity-90 flex items-center justify-center gap-2"
          style={{ background: MEDIA_GREEN }}>
          <Send className="w-4 h-4" /> Review & submit {date === todayISO() ? "today's" : date} report
        </button>
      )}
      {report && !editable && (
        <div className="flex items-center justify-center gap-2 text-sm text-gray-500 py-2">
          <CheckCircle className="w-4 h-4" style={{ color: MEDIA_GREEN }} />
          Submitted {report.submitted_at ? new Date(report.submitted_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : ''} — {statusMeta.label}
        </div>
      )}

      {logOpen && (
        <LogTaskSheet
          date={date}
          projects={reportable}
          lastEnd={tasks.length > 0 ? tasks[tasks.length - 1].end_time : null}
          onSaved={r => { setReport(r); setLogOpen(false) }}
          onClose={() => setLogOpen(false)}
        />
      )}

      {submitOpen && report && (
        <SubmitSheet report={report} date={date}
          onSubmitted={r => { setReport(r); setSubmitOpen(false) }}
          onClose={() => setSubmitOpen(false)} />
      )}
    </div>
  )
}

// ── Log task sheet (W3) ─────────────────────────────────────────────────────

function LogTaskSheet({ date, projects, lastEnd, onSaved, onClose }: {
  date: string
  projects: MediaProject[]
  lastEnd: string | null
  onSaved: (r: MediaDailyReport) => void
  onClose: () => void
}) {
  const { lookups } = useMedia()
  const [projectId, setProjectId] = useState('')
  const [categoryId, setCategoryId] = useState('')
  const [description, setDescription] = useState('')
  // Smart default (W3): start = last logged task's end.
  const [start, setStart] = useState(lastEnd ? lastEnd.slice(0, 5) : '')
  const [end, setEnd] = useState('')
  const [deliverableId, setDeliverableId] = useState('')
  const [deliverables, setDeliverables] = useState<Array<{ id: string; title: string }>>([])
  const [quantity, setQuantity] = useState('')
  const [unit, setUnit] = useState('')
  const [evidence, setEvidence] = useState('')
  const [status, setStatus] = useState<'done' | 'in_progress' | 'blocked'>('done')
  const [blockerNote, setBlockerNote] = useState('')
  const [saving, setSaving] = useState(false)

  // Deliverable picker filtered to the chosen project (FR-2.2).
  useEffect(() => {
    if (!projectId) { setDeliverables([]); setDeliverableId(''); return }
    mediaApi.listDeliverables({ project: projectId }).then(r =>
      setDeliverables(r.deliverables.filter(d => !['delivered', 'not_required', 'cancelled'].includes(d.status)).map(d => ({ id: d.id, title: d.title }))),
    )
  }, [projectId])

  async function save() {
    if (!projectId) { toast.error('Pick a project.'); return }
    if (!categoryId) { toast.error('Pick a task category.'); return }
    if (!description.trim()) { toast.error('Describe what you did.'); return }
    if (status === 'blocked' && !blockerNote.trim()) { toast.error('Blocked tasks need a blocker note.'); return }
    setSaving(true)
    try {
      const r = await mediaApi.addTask(date, {
        project_id: projectId,
        task_category_id: categoryId,
        deliverable_id: deliverableId || null,
        description: description.trim(),
        start_time: start || null,
        end_time: end || null,
        quantity: quantity ? parseInt(quantity, 10) : null,
        unit: unit || null,
        status,
        blocker_note: blockerNote || null,
        evidence_url: evidence || null,
      })
      onSaved(r.report)
      toast.success('Task logged.')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to log task.')
    } finally { setSaving(false) }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={onClose}>
      <div className="bg-white rounded-t-2xl sm:rounded-2xl w-full sm:max-w-lg max-h-[92vh] overflow-y-auto p-5 space-y-3" onClick={e => e.stopPropagation()}>
        <h2 className="text-base font-extrabold font-serif" style={{ color: MEDIA_GREEN }}>Log task — {date}</h2>

        <div>
          <label className={labelCls} style={{ color: MEDIA_GREEN }}>Project *</label>
          <select className={inputCls} value={projectId} onChange={e => setProjectId(e.target.value)}>
            <option value="">Select project…</option>
            {projects.map(p => <option key={p.id} value={p.id}>{p.name} ({p.code})</option>)}
          </select>
        </div>

        <div>
          <label className={labelCls} style={{ color: MEDIA_GREEN }}>Category *</label>
          <div className="flex flex-wrap gap-1.5">
            {lookups.task_categories.filter(c => c.is_active).map(c => (
              <button key={c.id} type="button" onClick={() => setCategoryId(c.id)}
                className={`text-xs px-2.5 py-1.5 rounded-lg border transition-colors ${categoryId === c.id ? 'text-white border-transparent' : 'border-gray-200 text-gray-600 hover:bg-gray-50'}`}
                style={categoryId === c.id ? { background: MEDIA_GREEN } : undefined}>
                {c.name}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className={labelCls} style={{ color: MEDIA_GREEN }}>What did you do? *</label>
          <textarea className={`${inputCls} resize-none`} rows={2} value={description} onChange={e => setDescription(e.target.value)}
            placeholder="e.g. Covered convocation morning session — stage + crowd" />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelCls} style={{ color: MEDIA_GREEN }}>Start</label>
            <input type="time" className={inputCls} value={start} onChange={e => setStart(e.target.value)} />
          </div>
          <div>
            <label className={labelCls} style={{ color: MEDIA_GREEN }}>End</label>
            <input type="time" className={inputCls} value={end} onChange={e => setEnd(e.target.value)} />
          </div>
        </div>

        {deliverables.length > 0 && (
          <div>
            <label className={labelCls} style={{ color: MEDIA_GREEN }}>Deliverable (optional)</label>
            <select className={inputCls} value={deliverableId} onChange={e => setDeliverableId(e.target.value)}>
              <option value="">—</option>
              {deliverables.map(d => <option key={d.id} value={d.id}>{d.title}</option>)}
            </select>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelCls} style={{ color: MEDIA_GREEN }}>Quantity</label>
            <input type="number" min={1} className={inputCls} value={quantity} onChange={e => setQuantity(e.target.value)} placeholder="e.g. 1800" />
          </div>
          <div>
            <label className={labelCls} style={{ color: MEDIA_GREEN }}>Unit</label>
            <input className={inputCls} value={unit} onChange={e => setUnit(e.target.value)} placeholder="photos / reels / min" />
          </div>
        </div>

        <div>
          <label className={labelCls} style={{ color: MEDIA_GREEN }}>Evidence link (Drive)</label>
          <input className={inputCls} value={evidence} onChange={e => setEvidence(e.target.value)} placeholder="https://drive.google.com/…" />
        </div>

        <div>
          <label className={labelCls} style={{ color: MEDIA_GREEN }}>Status</label>
          <div className="grid grid-cols-3 gap-1.5">
            {(['done', 'in_progress', 'blocked'] as const).map(s => (
              <button key={s} type="button" onClick={() => setStatus(s)}
                className={`text-xs px-2 py-2 rounded-lg border font-semibold transition-colors ${status === s ? 'text-white border-transparent' : 'border-gray-200 text-gray-600 hover:bg-gray-50'}`}
                style={status === s ? { background: s === 'blocked' ? '#b91c1c' : s === 'in_progress' ? '#0369a1' : MEDIA_GREEN } : undefined}>
                {s === 'done' ? 'Done' : s === 'in_progress' ? 'In progress' : 'Blocked'}
              </button>
            ))}
          </div>
        </div>
        {status === 'blocked' && (
          <input className={inputCls} value={blockerNote} onChange={e => setBlockerNote(e.target.value)} placeholder="What's blocking you?" />
        )}

        <div className="flex gap-2 pt-1">
          <button onClick={onClose} className="flex-1 py-2.5 rounded-xl border border-gray-200 text-sm font-semibold text-gray-600 hover:bg-gray-50">Cancel</button>
          <button onClick={save} disabled={saving}
            className="flex-1 py-2.5 rounded-xl text-sm font-bold text-white disabled:opacity-50" style={{ background: MEDIA_GREEN }}>
            {saving ? 'Saving…' : 'Save task'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Submit sheet ────────────────────────────────────────────────────────────

function SubmitSheet({ report, date, onSubmitted, onClose }: {
  report: MediaDailyReport
  date: string
  onSubmitted: (r: MediaDailyReport) => void
  onClose: () => void
}) {
  const [note, setNote] = useState(report.note ?? '')
  const [submitting, setSubmitting] = useState(false)

  async function submit() {
    setSubmitting(true)
    try {
      const r = await mediaApi.submitReport(date, note)
      onSubmitted(r.report)
      toast.success(r.report.status === 'flagged' ? 'Submitted — flagged for lead review.' : 'Report submitted.')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to submit.')
    } finally { setSubmitting(false) }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={onClose}>
      <div className="bg-white rounded-t-2xl sm:rounded-2xl w-full sm:max-w-md p-5 space-y-3" onClick={e => e.stopPropagation()}>
        <h2 className="text-base font-extrabold font-serif" style={{ color: MEDIA_GREEN }}>Submit report — {date}</h2>
        <div className="bg-gray-50 rounded-xl p-3 space-y-1 max-h-52 overflow-y-auto">
          {(report.tasks ?? []).map(t => (
            <p key={t.id} className="text-xs text-gray-600">
              <span className="font-semibold text-gray-800">{t.project_code}</span> · {t.description} <span className="text-gray-400">({fmtMinutes(t.minutes)})</span>
            </p>
          ))}
          <p className="text-xs font-bold pt-1" style={{ color: MEDIA_GREEN }}>Total: {fmtMinutes(report.total_minutes)}</p>
        </div>
        <textarea className={`${inputCls} resize-none`} rows={2} value={note} onChange={e => setNote(e.target.value)} placeholder="Optional note for your lead…" />
        <div className="flex gap-2">
          <button onClick={onClose} className="flex-1 py-2.5 rounded-xl border border-gray-200 text-sm font-semibold text-gray-600 hover:bg-gray-50">Back</button>
          <button onClick={submit} disabled={submitting}
            className="flex-1 py-2.5 rounded-xl text-sm font-bold text-white disabled:opacity-50" style={{ background: MEDIA_GREEN }}>
            {submitting ? 'Submitting…' : 'Submit'}
          </button>
        </div>
        <p className="text-[10px] text-gray-400 text-center">One report per day — it auto-approves in 48h unless flagged.</p>
      </div>
    </div>
  )
}
