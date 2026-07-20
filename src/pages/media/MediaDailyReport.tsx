/**
 * M3 — Daily Reporting (PRD core module). One report per person per day:
 * locked header (today + logged-in user), N task cards via "+ Add Another
 * Task" (no reloads), footer (summary / blockers / tomorrow), draft auto-save
 * every 30s, submit → approval flow. Approved reports lock.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Plus, Trash2, Clock, Send, Save, CheckCircle, AlertCircle } from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'
import { mediaApi } from '@/lib/media-api'
import {
  MEDIA_CATEGORY_META,
  type MediaMaster, type MediaProject, type MediaDailyReport, type MediaTaskInput,
} from '@/lib/media-types'

const GREEN = '#1a472a'

function todayLocal(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

interface CardState extends MediaTaskInput {
  key: string
}

function emptyCard(): CardState {
  return {
    key: `card-${Math.random().toString(36).slice(2)}`,
    project_id: null,
    task_category_id: '',
    description: '',
    start_time: '',
    end_time: '',
    progress_before: null,
    progress_after: null,
    deliverable_type_id: null,
    quantity: null,
    evidence_link: '',
  }
}

function cardHours(c: CardState): number {
  const m = (s: string) => {
    const match = /^(\d{1,2}):(\d{2})$/.exec(s.trim())
    return match ? parseInt(match[1], 10) * 60 + parseInt(match[2], 10) : null
  }
  const a = m(c.start_time), b = m(c.end_time)
  if (a == null || b == null || b <= a) return 0
  return Math.round(((b - a) / 60) * 10) / 10
}

const PCT_STEPS = Array.from({ length: 21 }, (_, i) => i * 5)

export default function MediaDailyReport() {
  const { profile } = useAuth()
  const date = todayLocal()

  const [taskCategories, setTaskCategories] = useState<MediaMaster[]>([])
  const [deliverableTypes, setDeliverableTypes] = useState<MediaMaster[]>([])
  const [projects, setProjects] = useState<MediaProject[]>([])
  const [report, setReport] = useState<MediaDailyReport | null>(null)
  const [loaded, setLoaded] = useState(false)

  const [cards, setCards] = useState<CardState[]>([emptyCard()])
  const [summary, setSummary] = useState('')
  const [blockers, setBlockers] = useState('')
  const [tomorrow, setTomorrow] = useState('')
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState<string | null>(null)

  useEffect(() => {
    Promise.all([mediaApi.getMasters(), mediaApi.getProjects(), mediaApi.getMyReport(date)])
      .then(([m, p, r]) => {
        setTaskCategories(m.task_categories.filter(x => x.is_active))
        setDeliverableTypes(m.deliverable_types.filter(x => x.is_active))
        setProjects(p.projects.filter(x => x.status === 'upcoming' || x.status === 'running'))
        if (r.report) hydrate(r.report)
        setLoaded(true)
      })
      .catch(e => { setError(e instanceof Error ? e.message : 'Failed to load.'); setLoaded(true) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function hydrate(r: MediaDailyReport) {
    setReport(r)
    setSummary(r.summary)
    setBlockers(r.blockers)
    setTomorrow(r.tomorrow_priority)
    if (r.tasks.length > 0) {
      setCards(r.tasks.map(t => ({
        key: t.id,
        project_id: t.project_id,
        task_category_id: t.task_category_id,
        description: t.description,
        start_time: t.start_time,
        end_time: t.end_time,
        progress_before: t.progress_before,
        progress_after: t.progress_after,
        deliverable_type_id: t.deliverable_type_id,
        quantity: t.quantity,
        evidence_link: t.evidence_link,
      })))
    }
  }

  const locked = report?.status === 'approved'
  const totalHours = useMemo(() => Math.round(cards.reduce((s, c) => s + cardHours(c), 0) * 10) / 10, [cards])
  const projectsByCategory = useMemo(() => {
    const g = new Map<string, MediaProject[]>()
    for (const p of projects) {
      const arr = g.get(p.category) ?? []
      arr.push(p)
      g.set(p.category, arr)
    }
    return g
  }, [projects])

  function patchCard(key: string, patch: Partial<CardState>) {
    setCards(cs => cs.map(c => c.key === key ? { ...c, ...patch } : c))
    setDirty(true)
  }

  const validCards = useCallback(
    () => cards.filter(c => c.task_category_id && c.description.trim()),
    [cards],
  )

  const save = useCallback(async (silent = false) => {
    if (locked || saving) return null
    const tasks = validCards()
    if (tasks.length === 0) {
      if (!silent) setError('Add at least one task card with a category and description.')
      return null
    }
    setSaving(true)
    setError(null)
    try {
      const { report: r } = await mediaApi.saveMyReport({
        date, summary, blockers, tomorrow_priority: tomorrow,
        tasks: tasks.map(({ key: _key, ...t }) => t),
      })
      setReport(r)
      setDirty(false)
      setSavedAt(new Date().toLocaleTimeString())
      return r
    } catch (e) {
      if (!silent) setError(e instanceof Error ? e.message : 'Failed to save.')
      return null
    } finally {
      setSaving(false)
    }
  }, [locked, saving, validCards, date, summary, blockers, tomorrow])

  // FR-DR-04: auto-save every 30 seconds while there are unsaved edits.
  const saveRef = useRef(save)
  useEffect(() => { saveRef.current = save }, [save])
  const dirtyRef = useRef(dirty)
  useEffect(() => { dirtyRef.current = dirty }, [dirty])
  useEffect(() => {
    const t = setInterval(() => { if (dirtyRef.current) void saveRef.current(true) }, 30_000)
    return () => clearInterval(t)
  }, [])

  async function submit() {
    if (submitting) return
    setSubmitting(true)
    setError(null)
    try {
      const saved = await save()
      if (!saved) return
      const { report: r } = await mediaApi.submitMyReport(date)
      setReport(r)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to submit.')
    } finally {
      setSubmitting(false)
    }
  }

  if (!loaded) return <p className="text-sm text-gray-400 py-12 text-center">Loading…</p>

  const statusBadge =
    report?.status === 'approved' ? { label: 'Approved', cls: 'bg-emerald-100 text-emerald-700' }
    : report?.status === 'submitted' ? { label: 'Submitted — awaiting review', cls: 'bg-blue-100 text-blue-700' }
    : report?.status === 'sent_back' ? { label: 'Sent back — edit and resubmit', cls: 'bg-amber-100 text-amber-800' }
    : { label: 'Draft', cls: 'bg-gray-100 text-gray-600' }

  const inputCls = 'w-full text-sm border border-gray-200 rounded-xl px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-green-200'
  const labelCls = 'text-[11px] font-bold uppercase tracking-wide mb-1 block text-gray-500'

  return (
    <div className="max-w-4xl mx-auto space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-extrabold font-serif" style={{ color: GREEN }}>My Daily Report</h1>
          <p className="text-sm text-gray-500">
            {new Date(date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
            {' · '}{profile?.full_name || profile?.email}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className={`text-[11px] px-2.5 py-1 rounded-full font-semibold ${statusBadge.cls}`}>{statusBadge.label}</span>
          <span className="inline-flex items-center gap-1 text-xs font-mono text-gray-500">
            <Clock className="w-3.5 h-3.5" /> {totalHours}h total
          </span>
        </div>
      </div>

      {report?.status === 'sent_back' && report.approver_comment && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm text-amber-900 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
          <span><strong>Sent back:</strong> {report.approver_comment}</span>
        </div>
      )}

      {cards.map((c, idx) => (
        <div key={c.key} className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4 space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-xs font-bold uppercase tracking-widest" style={{ color: GREEN }}>Task {idx + 1}</p>
            <div className="flex items-center gap-3">
              <span className="text-xs font-mono text-gray-400">{cardHours(c)}h</span>
              {!locked && cards.length > 1 && (
                <button onClick={() => { setCards(cs => cs.filter(x => x.key !== c.key)); setDirty(true) }}
                  className="p-1 rounded-md text-gray-400 hover:bg-rose-50 hover:text-rose-600" title="Remove this task">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Project</label>
              <select className={inputCls} disabled={locked} value={c.project_id ?? ''}
                onChange={e => patchCard(c.key, { project_id: e.target.value || null })}>
                <option value="">General / Department Work</option>
                {Array.from(projectsByCategory.entries()).map(([cat, ps]) => (
                  <optgroup key={cat} label={MEDIA_CATEGORY_META[cat as keyof typeof MEDIA_CATEGORY_META]?.label ?? cat}>
                    {ps.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </optgroup>
                ))}
              </select>
            </div>
            <div>
              <label className={labelCls}>Task Category *</label>
              <select className={inputCls} disabled={locked} value={c.task_category_id}
                onChange={e => patchCard(c.key, { task_category_id: e.target.value })}>
                <option value="">Select category…</option>
                {taskCategories.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
          </div>

          <div>
            <label className={labelCls}>What was done *</label>
            <input className={inputCls} disabled={locked} maxLength={280} value={c.description}
              placeholder="e.g. Shot the Fine Art conference inauguration"
              onChange={e => patchCard(c.key, { description: e.target.value })} />
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div>
              <label className={labelCls}>Start</label>
              <input type="time" className={inputCls} disabled={locked} value={c.start_time}
                onChange={e => patchCard(c.key, { start_time: e.target.value })} />
            </div>
            <div>
              <label className={labelCls}>End</label>
              <input type="time" className={inputCls} disabled={locked} value={c.end_time}
                onChange={e => patchCard(c.key, { end_time: e.target.value })} />
            </div>
            <div>
              <label className={labelCls}>Progress before</label>
              <select className={inputCls} disabled={locked} value={c.progress_before ?? ''}
                onChange={e => patchCard(c.key, { progress_before: e.target.value === '' ? null : Number(e.target.value) })}>
                <option value="">—</option>
                {PCT_STEPS.map(p => <option key={p} value={p}>{p}%</option>)}
              </select>
            </div>
            <div>
              <label className={labelCls}>Progress after</label>
              <select className={inputCls} disabled={locked} value={c.progress_after ?? ''}
                onChange={e => patchCard(c.key, { progress_after: e.target.value === '' ? null : Number(e.target.value) })}>
                <option value="">—</option>
                {PCT_STEPS.map(p => <option key={p} value={p}>{p}%</option>)}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div>
              <label className={labelCls}>Deliverable produced</label>
              <select className={inputCls} disabled={locked} value={c.deliverable_type_id ?? ''}
                onChange={e => patchCard(c.key, { deliverable_type_id: e.target.value || null })}>
                <option value="">None</option>
                {deliverableTypes.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
            <div>
              <label className={labelCls}>Quantity</label>
              <input type="number" min={1} className={inputCls} disabled={locked || !c.deliverable_type_id}
                value={c.quantity ?? ''} placeholder="e.g. 120"
                onChange={e => patchCard(c.key, { quantity: e.target.value === '' ? null : Number(e.target.value) })} />
            </div>
            <div>
              <label className={labelCls}>Evidence (Drive link)</label>
              <input type="url" className={inputCls} disabled={locked} value={c.evidence_link}
                placeholder="https://drive.google.com/…"
                onChange={e => patchCard(c.key, { evidence_link: e.target.value })} />
            </div>
          </div>
        </div>
      ))}

      {!locked && (
        <button onClick={() => { setCards(cs => [...cs, emptyCard()]); setDirty(true) }}
          className="w-full py-3 rounded-2xl border-2 border-dashed border-green-200 text-sm font-semibold hover:bg-green-50 transition-colors"
          style={{ color: GREEN }}>
          <Plus className="w-4 h-4 inline mr-1" /> Add Another Task
        </button>
      )}

      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4 space-y-3">
        <div>
          <label className={labelCls}>Today's summary</label>
          <textarea className={`${inputCls} resize-none`} rows={2} disabled={locked} value={summary}
            placeholder="One or two lines on the day overall"
            onChange={e => { setSummary(e.target.value); setDirty(true) }} />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label className={labelCls}>Blockers (optional)</label>
            <input className={inputCls} disabled={locked} value={blockers}
              onChange={e => { setBlockers(e.target.value); setDirty(true) }} />
          </div>
          <div>
            <label className={labelCls}>Tomorrow's priority (optional)</label>
            <input className={inputCls} disabled={locked} value={tomorrow}
              onChange={e => { setTomorrow(e.target.value); setDirty(true) }} />
          </div>
        </div>
      </div>

      {error && <div className="bg-rose-50 border border-rose-200 rounded-xl px-4 py-2.5 text-sm text-rose-700">{error}</div>}

      {locked ? (
        <div className="bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3 text-sm text-emerald-800 flex items-center gap-2">
          <CheckCircle className="w-4 h-4" /> Approved and locked. Ask an admin to unlock if something needs a correction.
        </div>
      ) : (
        <div className="flex items-center justify-between flex-wrap gap-3">
          <span className="text-xs text-gray-400">
            {saving ? 'Saving…' : savedAt ? `Draft saved at ${savedAt}` : 'Not saved yet'}
            {dirty && !saving && ' · unsaved changes'}
          </span>
          <div className="flex items-center gap-2">
            <button onClick={() => void save()} disabled={saving}
              className="px-4 py-2.5 rounded-xl border border-gray-200 text-sm font-semibold text-gray-600 hover:bg-gray-50 disabled:opacity-50 inline-flex items-center gap-1.5">
              <Save className="w-4 h-4" /> Save Draft
            </button>
            <button onClick={() => void submit()} disabled={submitting || saving}
              className="px-5 py-2.5 rounded-xl text-sm font-semibold text-white disabled:opacity-50 inline-flex items-center gap-1.5"
              style={{ background: GREEN }}>
              <Send className="w-4 h-4" /> {report?.status === 'submitted' ? 'Update Submission' : 'Submit Report'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
