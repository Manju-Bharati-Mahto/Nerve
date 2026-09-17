import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft, UserCheck, CheckCircle2, AlertCircle, Pencil, X } from 'lucide-react'
import {
  getEvent, assignEvent, completeEvent, updateEvent, listEditors,
  EVENT_STATUS_STYLE, formatWhen, describeAction,
  type EventRecord, type WorkflowUser,
} from '@/lib/outreach-video-data'
import { useAuth } from '@/hooks/useAuth'

/**
 * §11.2 — the event detail view: full details, assign or reassign to an editor,
 * and whether the assigned editor has marked it Completed.
 *
 * The assign control only renders for a manager or admin (§28 "Only the Manager
 * (or Admin) can assign or reassign"), and completion only for the editor it
 * belongs to. The API enforces both regardless.
 */
export default function VideoEventDetail() {
  const { eventId } = useParams<{ eventId: string }>()
  const { role } = useAuth()
  const [event, setEvent] = useState<EventRecord | null>(null)
  const [editors, setEditors] = useState<WorkflowUser[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState(false)

  const canAssign = role === 'outreach_manager' || role === 'super_admin' || role === 'admin'
  const isEditor = role === 'outreach_editor'

  const refresh = useCallback(async () => {
    if (!eventId) return
    try {
      const { event } = await getEvent(eventId)
      setEvent(event)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load this event.')
    } finally {
      setLoading(false)
    }
  }, [eventId])

  useEffect(() => { void refresh() }, [refresh])

  useEffect(() => {
    if (!canAssign) return
    listEditors().then(r => setEditors(r.editors)).catch(() => setEditors([]))
  }, [canAssign])

  if (loading) return <div className="hub-card text-center py-12 text-sm text-muted-foreground">Loading…</div>
  if (error || !event) {
    return (
      <div className="animate-fade-in space-y-4">
        <Back isEditor={isEditor} />
        <div className="hub-card bg-rose-50 border-rose-200 flex items-start gap-2 text-sm text-rose-900">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" /> <span>{error ?? 'Not found.'}</span>
        </div>
      </div>
    )
  }

  const assignedEditor = editors.find(e => e.id === event.assignedEditorId)

  return (
    <div className="animate-fade-in space-y-5">
      <Back isEditor={isEditor} />

      <div className="hub-card">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-xl font-serif text-foreground">{event.title}</h1>
            <p className="text-sm text-muted-foreground">
              {event.date}{event.client && ` · ${event.client}`}
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`hub-badge ${EVENT_STATUS_STYLE[event.status].cls}`}>
              {EVENT_STATUS_STYLE[event.status].label}
            </span>
            {canAssign && (
              <button onClick={() => setEditing(true)}
                className="text-xs px-2.5 py-1.5 rounded-lg bg-violet-100 text-violet-700 hover:opacity-80 inline-flex items-center gap-1">
                <Pencil className="w-3 h-3" /> Edit
              </button>
            )}
            {/* §28 — an editor completes their own assigned event. */}
            {isEditor && event.status === 'open' && (
              <CompleteButton event={event} onDone={refresh} />
            )}
          </div>
        </div>
        {event.description && (
          <p className="text-sm text-foreground whitespace-pre-wrap mt-3">{event.description}</p>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <div className="lg:col-span-2 space-y-5">
          {canAssign && (
            <AssignPanel event={event} editors={editors} onDone={refresh} />
          )}

          {event.status === 'completed' && (
            <div className="hub-card bg-emerald-50 border-emerald-200 flex items-start gap-2 text-sm text-emerald-900">
              <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />
              <span>Marked completed {formatWhen(event.completedAt)}.</span>
            </div>
          )}
        </div>

        <div className="space-y-5">
          <div className="hub-card">
            <h2 className="text-sm font-semibold text-foreground mb-3">Details</h2>
            <dl className="space-y-2 text-xs">
              <Row label="Date" value={event.date} />
              <Row label="Client / project" value={event.client || '—'} />
              <Row label="Status" value={EVENT_STATUS_STYLE[event.status].label} />
              <Row label="Assigned to" value={assignedEditor?.name ?? (event.assignedEditorId ? 'An editor' : 'Nobody yet')} />
              <Row label="Created" value={formatWhen(event.createdAt)} />
              <Row label="Completed" value={formatWhen(event.completedAt)} />
            </dl>
          </div>

          {/* §12 step 15 — creation, assignment, reassignment and completion. */}
          <div className="hub-card">
            <h2 className="text-sm font-semibold text-foreground mb-3">Activity</h2>
            <ol className="space-y-3">
              {event.activity.map(a => (
                <li key={a.id} className="flex gap-2.5">
                  <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-orange-400 shrink-0" />
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-foreground">
                      {describeAction(a.action.replace(/^event\./, ''))}
                    </p>
                    <p className="text-[11px] text-muted-foreground">{a.userName} · {formatWhen(a.timestamp)}</p>
                    {a.notes && <p className="text-[11px] text-muted-foreground">{a.notes}</p>}
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </div>

      {editing && (
        <EditEventDialog event={event} onClose={() => setEditing(false)}
          onDone={async () => { setEditing(false); await refresh() }} />
      )}
    </div>
  )
}

function Back({ isEditor }: { isEditor: boolean }) {
  return (
    <Link to={isEditor ? '/outreach/video/todo' : '/outreach/video/calendar'}
      className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
      <ArrowLeft className="w-4 h-4" /> {isEditor ? 'Back to To-Do List' : 'Back to calendar'}
    </Link>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-muted-foreground shrink-0">{label}</dt>
      <dd className="text-foreground text-right break-words min-w-0">{value}</dd>
    </div>
  )
}

function CompleteButton({ event, onDone }: { event: EventRecord; onDone: () => Promise<void> }) {
  const [busy, setBusy] = useState(false)
  return (
    <button disabled={busy}
      onClick={async () => {
        setBusy(true)
        try { await completeEvent(event.id); await onDone() }
        catch (err) { alert(err instanceof Error ? err.message : 'Could not complete.') }
        finally { setBusy(false) }
      }}
      className="text-xs px-2.5 py-1.5 rounded-lg bg-emerald-600 text-white hover:opacity-90 disabled:opacity-40 inline-flex items-center gap-1">
      <CheckCircle2 className="w-3 h-3" /> {busy ? 'Saving…' : 'Mark completed'}
    </button>
  )
}

/** §11.2 — assign from a dropdown of active editors, or reassign to another. */
function AssignPanel({ event, editors, onDone }: {
  event: EventRecord; editors: WorkflowUser[]; onDone: () => Promise<void>
}) {
  const [picked, setPicked] = useState(event.assignedEditorId ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => { setPicked(event.assignedEditorId ?? '') }, [event.assignedEditorId])

  const reassigning = !!event.assignedEditorId && picked !== event.assignedEditorId

  async function assign() {
    setBusy(true)
    setError(null)
    try {
      await assignEvent(event.id, picked)
      await onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not assign.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="hub-card">
      <h2 className="text-sm font-semibold text-foreground mb-1 flex items-center gap-2">
        <UserCheck className="w-4 h-4 text-muted-foreground" /> Assigned editor
      </h2>
      <p className="text-xs text-muted-foreground mb-3">
        Assigning adds this event to that editor's To-Do List and notifies them.
      </p>
      {editors.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No active editors to assign to yet.
        </p>
      ) : (
        <div className="flex items-center gap-2 flex-wrap">
          <select className="hub-input py-1.5 text-xs max-w-xs" value={picked}
            onChange={e => setPicked(e.target.value)}>
            <option value="">— Pick an editor —</option>
            {editors.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
          <button onClick={assign} disabled={busy || !picked || picked === event.assignedEditorId}
            className="text-xs px-3 py-1.5 rounded-lg bg-orange-600 text-white hover:opacity-90 disabled:opacity-40">
            {busy ? 'Saving…' : reassigning ? 'Reassign' : 'Assign'}
          </button>
        </div>
      )}
      {error && <p className="text-xs text-rose-600 mt-2">{error}</p>}
    </div>
  )
}

function EditEventDialog({ event, onClose, onDone }: {
  event: EventRecord; onClose: () => void; onDone: () => Promise<void>
}) {
  const [title, setTitle] = useState(event.title)
  const [description, setDescription] = useState(event.description)
  const [date, setDate] = useState(event.date)
  const [client, setClient] = useState(event.client ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save() {
    setBusy(true)
    setError(null)
    try {
      await updateEvent(event.id, { title, description, date, client: client || null })
      await onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save.')
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4 animate-fade-in">
      <div className="bg-card rounded-xl border border-border w-full max-w-md">
        <div className="flex items-start justify-between p-4 border-b border-border">
          <h2 className="text-base font-serif text-foreground">Edit event</h2>
          <button onClick={onClose} disabled={busy}
            className="p-2 rounded-lg hover:bg-accent text-muted-foreground disabled:opacity-40"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-4 space-y-3">
          <div><label className="hub-label">Title *</label>
            <input className="hub-input" value={title} onChange={e => setTitle(e.target.value)} /></div>
          <div><label className="hub-label">Date *</label>
            <input type="date" className="hub-input" value={date} onChange={e => setDate(e.target.value)} /></div>
          <div><label className="hub-label">Client / project</label>
            <input className="hub-input" value={client} onChange={e => setClient(e.target.value)} /></div>
          <div><label className="hub-label">Description</label>
            <textarea className="hub-input" value={description} onChange={e => setDescription(e.target.value)} /></div>
          {error && <p className="text-xs text-rose-600">{error}</p>}
        </div>
        <div className="flex items-center justify-end gap-2 p-4 border-t border-border">
          <button onClick={onClose} disabled={busy}
            className="px-4 py-2 rounded-lg border border-border text-sm text-muted-foreground hover:bg-accent disabled:opacity-40">Cancel</button>
          <button onClick={save} disabled={busy || !title.trim()}
            className="px-4 py-2 rounded-lg bg-orange-600 text-white text-sm font-medium hover:opacity-90 disabled:opacity-40">
            {busy ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </div>
    </div>
  )
}
