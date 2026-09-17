import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { ListChecks, CheckCircle2, AlertCircle, Circle } from 'lucide-react'
import {
  listEvents, completeEvent, localDay,
  EVENT_STATUS_STYLE, type EventRecord,
} from '@/lib/outreach-video-data'

/**
 * §8.1 — the editor's To-Do List: every event the Manager has assigned to them,
 * with title, description, date, client and Open/Completed, and the ability to
 * mark one done.
 *
 * The API already scopes this to the signed-in editor, so there is no "whose
 * list is this" question to get wrong here.
 */
export default function VideoTodo() {
  const [events, setEvents] = useState<EventRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const { events } = await listEvents()
      setEvents(events)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load your To-Do List.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const today = localDay()
  const { open, completed } = useMemo(() => ({
    open: events.filter(e => e.status === 'open'),
    completed: events.filter(e => e.status === 'completed'),
  }), [events])

  async function markDone(event: EventRecord) {
    setBusyId(event.id)
    try {
      await completeEvent(event.id)
      await refresh()
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Could not mark it completed.')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="animate-fade-in space-y-5">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-orange-100 flex items-center justify-center">
          <ListChecks className="w-5 h-5 text-orange-600" />
        </div>
        <div>
          <h1 className="text-2xl font-serif text-foreground">To-Do List</h1>
          <p className="text-sm text-muted-foreground">Events your manager has assigned to you.</p>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
        <Kpi label="Open" value={open.length} accent={open.length > 0} />
        <Kpi label="Completed" value={completed.length} />
        <Kpi label="Due today or overdue" value={open.filter(e => e.date <= today).length}
          accent={open.some(e => e.date <= today)} />
      </div>

      {error && (
        <div className="hub-card bg-rose-50 border-rose-200 flex items-start gap-2 text-sm text-rose-900">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" /> <span>{error}</span>
        </div>
      )}

      {loading ? (
        <div className="hub-card text-center py-12 text-sm text-muted-foreground">Loading…</div>
      ) : events.length === 0 ? (
        <div className="hub-card text-center py-12">
          <p className="text-sm text-muted-foreground">
            Nothing assigned to you yet. Events appear here when your manager assigns one.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {open.map(e => (
            <TodoCard key={e.id} event={e} today={today} busy={busyId === e.id} onDone={() => markDone(e)} />
          ))}
          {completed.length > 0 && (
            <>
              <p className="text-[11px] uppercase tracking-widest text-muted-foreground pt-2">Completed</p>
              {completed.map(e => (
                <TodoCard key={e.id} event={e} today={today} busy={false} onDone={() => {}} />
              ))}
            </>
          )}
        </div>
      )}
    </div>
  )
}

function Kpi({ label, value, accent }: { label: string; value: number; accent?: boolean }) {
  return (
    <div className={`hub-card py-3 ${accent ? 'border-amber-300 bg-amber-50/50' : ''}`}>
      <div className="text-2xl font-serif text-foreground leading-none">{value}</div>
      <div className="text-[11px] text-muted-foreground mt-1">{label}</div>
    </div>
  )
}

function TodoCard({ event, today, busy, onDone }: {
  event: EventRecord; today: string; busy: boolean; onDone: () => void
}) {
  const overdue = event.status === 'open' && event.date < today
  const isToday = event.date === today
  return (
    <div className={`hub-card ${event.status === 'completed' ? 'opacity-70' : ''}`}>
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-start gap-3 min-w-0">
          {event.status === 'completed'
            ? <CheckCircle2 className="w-4 h-4 text-emerald-600 mt-0.5 shrink-0" />
            : <Circle className="w-4 h-4 text-amber-500 mt-0.5 shrink-0" />}
          <div className="min-w-0">
            <Link to={`/outreach/video/events/${event.id}`}
              className="text-sm font-medium text-foreground hover:underline">{event.title}</Link>
            <p className="text-xs text-muted-foreground">
              {event.date}
              {isToday && <span className="text-orange-600 font-medium"> · today</span>}
              {overdue && <span className="text-rose-600 font-medium"> · overdue</span>}
              {event.client && ` · ${event.client}`}
            </p>
            {event.description && (
              <p className="text-xs text-muted-foreground mt-1 whitespace-pre-wrap">{event.description}</p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className={`hub-badge ${EVENT_STATUS_STYLE[event.status].cls}`}>
            {EVENT_STATUS_STYLE[event.status].label}
          </span>
          {event.status === 'open' && (
            <button onClick={onDone} disabled={busy}
              className="text-xs px-2.5 py-1.5 rounded-lg bg-emerald-600 text-white hover:opacity-90 disabled:opacity-40 inline-flex items-center gap-1">
              <CheckCircle2 className="w-3 h-3" /> {busy ? 'Saving…' : 'Mark completed'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
