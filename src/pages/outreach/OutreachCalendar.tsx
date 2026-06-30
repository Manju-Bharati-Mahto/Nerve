import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Calendar as CalendarIcon, ChevronLeft, ChevronRight } from 'lucide-react'
import {
  useOutreachData, formatLocalDate, campaignDateStatus,
  type CampaignDateStatus,
} from '@/lib/outreach-data'

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

// Spec 1.5 colour coding: Active = yellow, Completed (end date passed) = green,
// Upcoming (not started) = neutral. Derived from dates so the calendar updates
// automatically as time passes — independent of the manual campaign status.
const STATUS_STYLE: Record<CampaignDateStatus, { chip: string; dot: string; label: string }> = {
  active:    { chip: 'bg-yellow-300 text-yellow-950 hover:bg-yellow-400', dot: 'bg-yellow-300', label: 'Active' },
  completed: { chip: 'bg-emerald-500 text-white hover:bg-emerald-600',    dot: 'bg-emerald-500', label: 'Completed' },
  upcoming:  { chip: 'bg-slate-400 text-white hover:bg-slate-500',        dot: 'bg-slate-400', label: 'Upcoming' },
}

export default function OutreachCalendar() {
  const { campaigns } = useOutreachData()
  const [view, setView] = useState<'month' | 'week'>('month')
  const [cursor, setCursor] = useState(() => new Date())

  const month = cursor.getMonth()
  const year = cursor.getFullYear()
  const today = formatLocalDate(new Date())

  const cells = useMemo(() => {
    if (view === 'month') {
      const firstDay = new Date(year, month, 1).getDay()
      const daysInMonth = new Date(year, month + 1, 0).getDate()
      const out: { date: string | null; isToday: boolean }[] = []
      for (let i = 0; i < firstDay; i++) out.push({ date: null, isToday: false })
      for (let d = 1; d <= daysInMonth; d++) {
        const iso = formatLocalDate(new Date(year, month, d))
        out.push({ date: iso, isToday: iso === today })
      }
      while (out.length % 7 !== 0) out.push({ date: null, isToday: false })
      return out
    } else {
      const start = new Date(cursor)
      start.setDate(cursor.getDate() - cursor.getDay())
      return Array.from({ length: 7 }, (_, i) => {
        const d = new Date(start)
        d.setDate(start.getDate() + i)
        const iso = formatLocalDate(d)
        return { date: iso, isToday: iso === today }
      })
    }
  }, [view, year, month, cursor, today])

  // Only campaigns appear on the calendar (spec: individual post dates must NOT
  // show). Each campaign spans every cell between its start and end date.
  const placeable = useMemo(
    () => campaigns
      .filter(c => c.startDate)
      .map(c => ({ c, status: campaignDateStatus(c), end: c.endDate || c.startDate })),
    [campaigns],
  )

  function campaignsOn(date: string) {
    return placeable.filter(({ c, end }) => date >= c.startDate && date <= end)
  }

  const monthLabel = cursor.toLocaleString('en-US', { month: 'long', year: 'numeric' })

  function shift(dir: -1 | 1) {
    const d = new Date(cursor)
    if (view === 'month') d.setMonth(d.getMonth() + dir)
    else d.setDate(d.getDate() + dir * 7)
    setCursor(d)
  }

  const maxPerCell = view === 'week' ? 14 : 5

  return (
    <div className="animate-fade-in space-y-5">

      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-orange-100 flex items-center justify-center">
            <CalendarIcon className="w-5 h-5 text-orange-600" />
          </div>
          <div>
            <h1 className="text-2xl font-serif text-foreground">Calendar</h1>
            <p className="text-sm text-muted-foreground">Campaign schedules. Each bar spans a campaign's start → end date.</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {/* Colour legend */}
          <div className="hidden sm:flex items-center gap-3 mr-1">
            {(['active', 'completed', 'upcoming'] as CampaignDateStatus[]).map(s => (
              <span key={s} className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <span className={`w-3 h-3 rounded ${STATUS_STYLE[s].dot}`} /> {STATUS_STYLE[s].label}
              </span>
            ))}
          </div>
          <div className="inline-flex bg-card border border-border rounded-lg overflow-hidden text-xs">
            {(['month', 'week'] as const).map(v => (
              <button key={v} onClick={() => setView(v)}
                className={`px-3 py-1.5 transition-colors capitalize ${view === v ? 'bg-orange-100 text-orange-700 font-medium' : 'text-muted-foreground hover:bg-accent'}`}>
                {v}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="hub-card">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-foreground">{monthLabel}</h2>
          <div className="flex items-center gap-1">
            <button onClick={() => shift(-1)} className="p-1.5 rounded-lg hover:bg-accent text-muted-foreground"><ChevronLeft className="w-4 h-4" /></button>
            <button onClick={() => setCursor(new Date())} className="text-xs px-2 py-1 rounded-lg hover:bg-accent text-muted-foreground">Today</button>
            <button onClick={() => shift(1)} className="p-1.5 rounded-lg hover:bg-accent text-muted-foreground"><ChevronRight className="w-4 h-4" /></button>
          </div>
        </div>

        <div className="grid grid-cols-7 gap-1 mb-2">
          {WEEKDAYS.map(d => (
            <div key={d} className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground text-center py-1">{d}</div>
          ))}
        </div>

        <div className={`grid grid-cols-7 gap-1 ${view === 'week' ? 'auto-rows-[220px]' : 'auto-rows-[120px]'}`}>
          {cells.map((c, i) => {
            const events = c.date ? campaignsOn(c.date) : []
            return (
              <div key={i}
                className={`rounded-lg border p-1.5 overflow-hidden flex flex-col gap-0.5 ${
                  c.date === null ? 'border-transparent'
                    : c.isToday ? 'border-orange-300 bg-orange-50' : 'border-border'
                }`}>
                {c.date && (
                  <div className="text-[11px] font-medium text-foreground/80 mb-0.5">
                    {parseInt(c.date.slice(8, 10), 10)}
                  </div>
                )}
                <div className="flex-1 overflow-y-auto space-y-0.5">
                  {events.slice(0, maxPerCell).map(({ c: camp, status, end }) => {
                    const style = STATUS_STYLE[status]
                    // Mark the first/last covered day so the band reads as a bar.
                    const isStart = c.date === camp.startDate
                    const isEnd = c.date === end
                    return (
                      <Link key={camp.id} to={`/outreach/campaigns/${camp.id}`}
                        title={`${camp.name} · ${camp.startDate} → ${end} · ${style.label}${camp.state ? ` · ${camp.state}` : ''}`}
                        className={`block px-1.5 py-0.5 text-[10px] truncate transition-colors ${style.chip} ${
                          isStart && isEnd ? 'rounded' : isStart ? 'rounded-l rounded-r-none' : isEnd ? 'rounded-r rounded-l-none' : 'rounded-none'
                        }`}>
                        {isStart ? camp.name : ' '}
                      </Link>
                    )
                  })}
                  {events.length > maxPerCell && (
                    <p className="text-[10px] text-muted-foreground px-1">+{events.length - maxPerCell} more</p>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {campaigns.length === 0 && (
        <div className="hub-card text-center py-12">
          <p className="text-sm text-muted-foreground">No campaigns yet. <Link to="/outreach/campaigns" className="text-orange-600 hover:underline">Create one</Link> to see it on the calendar.</p>
        </div>
      )}

    </div>
  )
}
