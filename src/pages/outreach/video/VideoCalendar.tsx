import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Calendar as CalendarIcon, ChevronLeft, ChevronRight, Plus, X, AlertCircle, List, Grid3x3,
} from 'lucide-react'
import {
  listEvents, createEvent, eventCounts, localDay,
  EVENT_STATUS_STYLE, type EventRecord, type EventCounts,
} from '@/lib/outreach-video-data'

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/**
 * §11.1 — the Manager's event calendar: a month grid and a list, both showing
 * every event with its date, upcoming and past alike, plus create-from-calendar.
 *
 * Deliberately mirrors the existing Outreach campaign calendar's shape so the
 * two read as the same product rather than two different calendars.
 */
export default function VideoCalendar() {
  const [events, setEvents] = useState<EventRecord[]>([])
  const [counts, setCounts] = useState<EventCounts | null>(null)
  const [view, setView] = useState<'month' | 'list'>('month')
  const [cursor, setCursor] = useState(() => new Date())
  const [creating, setCreating] = useState<string | null>(null)   // the clicked day
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    try {
      const [{ events }, { counts }] = await Promise.all([listEvents(), eventCounts()])
      setEvents(events)
      setCounts(counts)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the calendar.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const month = cursor.getMonth()
  const year = cursor.getFullYear()
  const today = localDay()

  const byDate = useMemo(() => {
    const map = new Map<string, EventRecord[]>()
    for (const e of events) {
      const list = map.get(e.date) ?? []
      list.push(e)
      map.set(e.date, list)
    }
    return map
  }, [events])

  const cells = useMemo(() => {
    const firstDay = new Date(year, month, 1).getDay()
    const daysInMonth = new Date(year, month + 1, 0).getDate()
    const out: (string | null)[] = Array(firstDay).fill(null)
    for (let d = 1; d <= daysInMonth; d++) out.push(localDay(new Date(year, month, d)))
    while (out.length % 7 !== 0) out.push(null)
    return out
  }, [year, month])

  const { upcoming, past } = useMemo(() => ({
    upcoming: events.filter(e => e.date >= today),
    past: events.filter(e => e.date < today).reverse(),
  }), [events, today])

  return (
    <div className="animate-fade-in space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-orange-100 flex items-center justify-center">
            <CalendarIcon className="w-5 h-5 text-orange-600" />
          </div>
          <div>
            <h1 className="text-2xl font-serif text-foreground">Event Calendar</h1>
            <p className="text-sm text-muted-foreground">
              Shoots, deadlines and deliverables — assign each one to an editor.
            </p>
          </div>
        </div>
        <button onClick={() => setCreating(today)}
          className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium bg-orange-600 text-white hover:opacity-90">
          <Plus className="w-4 h-4" /> New event
        </button>
      </div>

      {counts && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <Kpi label="Upcoming events" value={counts.upcoming} />
          <Kpi label="Past events" value={counts.past} />
          <Kpi label="Unassigned" value={counts.unassigned} accent={counts.unassigned > 0} />
          <Kpi label="Completed" value={counts.completed} />
        </div>
      )}

      {error && (
        <div className="hub-card bg-rose-50 border-rose-200 flex items-start gap-2 text-sm text-rose-900">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" /> <span>{error}</span>
        </div>
      )}

      <div className="hub-card py-3 flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-1">
          <button onClick={() => setCursor(new Date(year, month - 1, 1))}
            className="p-1.5 rounded-lg hover:bg-accent text-muted-foreground"><ChevronLeft className="w-4 h-4" /></button>
          <span className="text-sm font-medium text-foreground min-w-[150px] text-center">
            {cursor.toLocaleString(undefined, { month: 'long', year: 'numeric' })}
          </span>
          <button onClick={() => setCursor(new Date(year, month + 1, 1))}
            className="p-1.5 rounded-lg hover:bg-accent text-muted-foreground"><ChevronRight className="w-4 h-4" /></button>
        </div>
        <button onClick={() => setCursor(new Date())}
          className="text-xs px-2.5 py-1.5 rounded-lg border border-border hover:bg-accent">Today</button>
        <div className="ml-auto flex items-center gap-1">
          <ViewTab active={view === 'month'} onClick={() => setView('month')} icon={Grid3x3} label="Month" />
          <ViewTab active={view === 'list'} onClick={() => setView('list')} icon={List} label="List" />
        </div>
      </div>

      {loading ? (
        <div className="hub-card text-center py-12 text-sm text-muted-foreground">Loading…</div>
      ) : view === 'month' ? (
        <div className="hub-card">
          <div className="grid grid-cols-7 gap-px mb-1">
            {WEEKDAYS.map(d => (
              <div key={d} className="text-[10px] uppercase tracking-widest text-muted-foreground text-center py-1">{d}</div>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-px bg-border rounded-lg overflow-hidden">
            {cells.map((date, i) => (
              <div key={i} className={`bg-card min-h-24 p-1.5 ${date ? 'cursor-pointer hover:bg-accent/40' : ''}`}
                onClick={() => date && setCreating(date)}>
                {date && (
                  <>
                    <div className={`text-[11px] mb-1 ${date === today
                      ? 'font-bold text-orange-600' : 'text-muted-foreground'}`}>
                      {Number(date.slice(-2))}
                    </div>
                    <div className="space-y-1">
                      {(byDate.get(date) ?? []).slice(0, 3).map(e => (
                        <Link key={e.id} to={`/outreach/video/events/${e.id}`}
                          onClick={ev => ev.stopPropagation()}
                          className={`block text-[10px] px-1.5 py-0.5 rounded truncate ${EVENT_STATUS_STYLE[e.status].cls} hover:opacity-80`}>
                          {e.title}
                        </Link>
                      ))}
                      {(byDate.get(date) ?? []).length > 3 && (
                        <span className="text-[10px] text-muted-foreground">
                          +{(byDate.get(date) ?? []).length - 3} more
                        </span>
                      )}
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>
          <p className="text-[11px] text-muted-foreground mt-2">Click a day to add an event.</p>
        </div>
      ) : (
        <div className="space-y-4">
          <EventList title="Upcoming" events={upcoming} empty="Nothing scheduled ahead." />
          <EventList title="Past" events={past} empty="No past events." />
        </div>
      )}

      {creating && (
        <CreateEventDialog date={creating} onClose={() => setCreating(null)}
          onDone={async () => { setCreating(null); await refresh() }} />
      )}
    </div>
  )
}

function ViewTab({ active, onClick, icon: Icon, label }: {
  active: boolean; onClick: () => void; icon: React.ElementType; label: string
}) {
  return (
    <button onClick={onClick}
      className={`text-xs px-2.5 py-1.5 rounded-lg inline-flex items-center gap-1.5 ${
        active ? 'bg-orange-100 text-orange-700 font-medium' : 'text-muted-foreground hover:bg-accent'}`}>
      <Icon className="w-3.5 h-3.5" /> {label}
    </button>
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

/** §11.1 — the list view, with upcoming and past clearly separated. */
function EventList({ title, events, empty }: { title: string; events: EventRecord[]; empty: string }) {
  return (
    <div className="hub-card p-0 overflow-hidden">
      <div className="px-4 py-2.5 border-b border-border">
        <h2 className="text-sm font-semibold text-foreground">{title} <span className="text-xs text-muted-foreground font-normal">({events.length})</span></h2>
      </div>
      {events.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-muted-foreground">{empty}</p>
      ) : (
        <table className="w-full text-sm">
          <tbody>
            {events.map(e => (
              <tr key={e.id} className="border-b border-border last:border-0 hover:bg-accent/40">
                <td className="px-4 py-2.5 w-28 text-xs text-muted-foreground whitespace-nowrap">{e.date}</td>
                <td className="px-3 py-2.5">
                  <Link to={`/outreach/video/events/${e.id}`}
                    className="text-xs font-medium text-foreground hover:underline">{e.title}</Link>
                  {e.client && <div className="text-[11px] text-muted-foreground">{e.client}</div>}
                </td>
                <td className="px-3 py-2.5 w-32">
                  <span className={`hub-badge ${EVENT_STATUS_STYLE[e.status].cls}`}>
                    {EVENT_STATUS_STYLE[e.status].label}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

function CreateEventDialog({ date, onClose, onDone }: {
  date: string; onClose: () => void; onDone: () => Promise<void>
}) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [when, setWhen] = useState(date)
  const [client, setClient] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save() {
    setBusy(true)
    setError(null)
    try {
      await createEvent({ title, description, date: when, client: client || null })
      await onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the event.')
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4 animate-fade-in">
      <div className="bg-card rounded-xl border border-border w-full max-w-md">
        <div className="flex items-start justify-between p-4 border-b border-border">
          <div>
            <h2 className="text-base font-serif text-foreground">New event</h2>
            <p className="text-xs text-muted-foreground">Assign it to an editor once it's created.</p>
          </div>
          <button onClick={onClose} disabled={busy}
            className="p-2 rounded-lg hover:bg-accent text-muted-foreground disabled:opacity-40"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-4 space-y-3">
          <div>
            <label className="hub-label">Title *</label>
            <input className="hub-input" value={title} onChange={e => setTitle(e.target.value)}
              placeholder="Convocation shoot — main hall" autoFocus />
          </div>
          <div>
            <label className="hub-label">Date *</label>
            <input type="date" className="hub-input" value={when} onChange={e => setWhen(e.target.value)} />
          </div>
          <div>
            <label className="hub-label">Client / project</label>
            <input className="hub-input" value={client} onChange={e => setClient(e.target.value)}
              placeholder="Convocation 2026" />
          </div>
          <div>
            <label className="hub-label">Description</label>
            <textarea className="hub-input" value={description} onChange={e => setDescription(e.target.value)}
              placeholder="Call time, location, what's needed." />
          </div>
          {error && (
            <div className="hub-card bg-rose-50 border-rose-200 flex items-start gap-2 text-xs text-rose-900">
              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" /> <span>{error}</span>
            </div>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 p-4 border-t border-border">
          <button onClick={onClose} disabled={busy}
            className="px-4 py-2 rounded-lg border border-border text-sm text-muted-foreground hover:bg-accent disabled:opacity-40">Cancel</button>
          <button onClick={save} disabled={busy || !title.trim() || !when}
            className="px-4 py-2 rounded-lg bg-orange-600 text-white text-sm font-medium hover:opacity-90 disabled:opacity-40">
            {busy ? 'Creating…' : 'Create event'}
          </button>
        </div>
      </div>
    </div>
  )
}
