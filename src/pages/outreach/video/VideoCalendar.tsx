import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Calendar as CalendarIcon, ChevronLeft, ChevronRight, Plus, X, AlertCircle, List, Grid3x3, Film,
} from 'lucide-react'
import {
  listEvents, createEvent, eventCounts, listVideos, listCampaigns, listSocialPages, listPublishers,
  localDay, formatWhen, calendarStatusOf,
  CALENDAR_STATUS, CONTENT_TYPES,
  type EventRecord, type EventCounts, type VideoRecord, type Campaign, type CalendarStatus,
} from '@/lib/outreach-video-data'

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/**
 * The Campaign/Event Calendar (Campaign & Content Management PRD §5).
 *
 * Two kinds of entry share the grid:
 *   - EVENTS — shoots, deadlines and planned posts a Manager adds; and
 *   - POSTINGS — the campaign's actual videos, on the day they are scheduled
 *     to go out or went out.
 * §5 asks the calendar to "show which campaign postings are pending,
 * running/scheduled, and completed", which the events alone never could.
 *
 * Every entry is shown under §5's four statuses (Upcoming, Running/Scheduled,
 * Pending, Completed) and carries the six things §5 lists: campaign name,
 * social media page, content type, posting date/time, assigned publisher and
 * status. Campaign progress sits above the grid.
 */

/** One row the calendar draws, whichever kind it came from. */
interface Entry {
  key: string
  kind: 'event' | 'posting'
  date: string
  title: string
  to: string
  campaign: string | null
  page: string | null
  contentType: string | null
  when: string | null
  publisher: string | null
  status: CalendarStatus
}

export default function VideoCalendar() {
  const [events, setEvents] = useState<EventRecord[]>([])
  const [videos, setVideos] = useState<VideoRecord[]>([])
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [pages, setPages] = useState<Array<{ id: string; handle: string; platform: string }>>([])
  const [publishers, setPublishers] = useState<Array<{ id: string; name: string }>>([])
  const [counts, setCounts] = useState<EventCounts | null>(null)
  const [view, setView] = useState<'month' | 'list'>('month')
  const [cursor, setCursor] = useState(() => new Date())
  const [creating, setCreating] = useState<string | null>(null)   // the clicked day
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    try {
      const [{ events }, { counts }, { videos }] = await Promise.all([
        listEvents(), eventCounts(), listVideos(),
      ])
      setEvents(events)
      setCounts(counts)
      setVideos(videos)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the calendar.')
    } finally {
      setLoading(false)
    }
    /* The lookups that label entries. Each is allowed to fail on its own —
       a missing page name must not blank the whole calendar. */
    listCampaigns().then(r => setCampaigns(r.campaigns)).catch(() => setCampaigns([]))
    listSocialPages().then(r => setPages(r.pages)).catch(() => setPages([]))
    listPublishers().then(r => setPublishers(r.publishers)).catch(() => setPublishers([]))
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const entries = useMemo<Entry[]>(() => {
    const campaignName = new Map(campaigns.map(c => [c.id, c.name]))
    const pageName = new Map(pages.map(p => [p.id, `@${p.handle}`]))
    const publisherName = new Map(publishers.map(p => [p.id, p.name]))
    const now = new Date()

    const fromEvents: Entry[] = events.map(e => ({
      key: `e-${e.id}`,
      kind: 'event',
      date: e.date,
      title: e.title,
      to: `/outreach/video/events/${e.id}`,
      campaign: (e.campaignId && campaignName.get(e.campaignId)) || e.client || null,
      page: (e.socialPageId && pageName.get(e.socialPageId)) || null,
      contentType: e.contentType ?? null,
      when: e.postingAt ?? null,
      publisher: (e.assignedPublisherId && publisherName.get(e.assignedPublisherId)) || null,
      status: calendarStatusOf({ kind: 'event', status: e.status, date: e.date }, now),
    }))

    /* A posting is a video with a slot: scheduled to go out, or gone out. */
    const fromVideos: Entry[] = videos
      .filter(v => (v.status === 'scheduled' && v.scheduledFor) || (v.status === 'published' && v.publishedAt))
      .map(v => {
        const when = (v.status === 'published' ? v.publishedAt : v.scheduledFor) as string
        const publishedBy = v.publishedBy ? publisherName.get(v.publishedBy) : null
        const scheduledBy = v.scheduledBy ? publisherName.get(v.scheduledBy) : null
        return {
          key: `v-${v.id}`,
          kind: 'posting' as const,
          date: localDay(new Date(when)),
          title: v.title,
          to: `/outreach/video/videos/${v.id}`,
          campaign: v.client,
          page: v.socialPageNames?.length ? v.socialPageNames.join(', ') : v.platform ?? null,
          contentType: 'Video',
          when,
          publisher: publishedBy ?? scheduledBy ?? null,
          status: calendarStatusOf({ kind: 'posting', status: v.status, when }, now),
        }
      })

    return [...fromEvents, ...fromVideos].sort((a, b) =>
      a.date.localeCompare(b.date) || (a.when ?? '').localeCompare(b.when ?? ''))
  }, [events, videos, campaigns, pages, publishers])

  const month = cursor.getMonth()
  const year = cursor.getFullYear()
  const today = localDay()

  const byDate = useMemo(() => {
    const map = new Map<string, Entry[]>()
    for (const e of entries) map.set(e.date, [...(map.get(e.date) ?? []), e])
    return map
  }, [entries])

  const cells = useMemo(() => {
    const firstDay = new Date(year, month, 1).getDay()
    const daysInMonth = new Date(year, month + 1, 0).getDate()
    const out: (string | null)[] = Array(firstDay).fill(null)
    for (let d = 1; d <= daysInMonth; d++) out.push(localDay(new Date(year, month, d)))
    while (out.length % 7 !== 0) out.push(null)
    return out
  }, [year, month])

  const { upcoming, past } = useMemo(() => ({
    upcoming: entries.filter(e => e.date >= today),
    past: entries.filter(e => e.date < today).reverse(),
  }), [entries, today])

  /* §5 — the four calendar statuses, counted across events and postings. */
  const tally = useMemo(() => {
    const t: Record<CalendarStatus, number> = { upcoming: 0, scheduled: 0, pending: 0, completed: 0 }
    for (const e of entries) t[e.status]++
    return t
  }, [entries])

  const running = campaigns.filter(c => c.status === 'running' || c.status === 'upcoming')

  return (
    <div className="animate-fade-in space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-orange-100 flex items-center justify-center">
            <CalendarIcon className="w-5 h-5 text-orange-600" />
          </div>
          <div>
            <h1 className="text-2xl font-serif text-foreground">Campaign &amp; Event Calendar</h1>
            <p className="text-sm text-muted-foreground">
              Shoots and planned posts, with every scheduled and published video on its day.
            </p>
          </div>
        </div>
        <button onClick={() => setCreating(today)}
          className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium bg-orange-600 text-white hover:opacity-90">
          <Plus className="w-4 h-4" /> New event
        </button>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {(Object.keys(CALENDAR_STATUS) as CalendarStatus[]).map(st => (
          <Kpi key={st} label={CALENDAR_STATUS[st].label} value={tally[st]} accent={st === 'pending' && tally[st] > 0} />
        ))}
      </div>
      {counts && counts.unassigned > 0 && (
        <p className="text-[12px] text-amber-700">
          {counts.unassigned} event{counts.unassigned === 1 ? ' has' : 's have'} no editor yet.
        </p>
      )}

      {/* §5 — "Campaign progress should show total required posts, published
          posts and remaining posts." */}
      {running.length > 0 && (
        <div className="hub-card space-y-2">
          <h2 className="text-sm font-semibold text-foreground">Campaign progress</h2>
          <div className="grid sm:grid-cols-2 gap-x-6 gap-y-3">
            {running.map(c => <CampaignProgressRow key={c.id} campaign={c} />)}
          </div>
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
        <div className="flex items-center gap-1.5 flex-wrap">
          {(Object.keys(CALENDAR_STATUS) as CalendarStatus[]).map(st => (
            <span key={st} className={`hub-badge text-[10px] ${CALENDAR_STATUS[st].cls}`}>{CALENDAR_STATUS[st].label}</span>
          ))}
        </div>
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
                        <Link key={e.key} to={e.to} onClick={ev => ev.stopPropagation()}
                          title={describe(e)}
                          className={`flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded truncate ${CALENDAR_STATUS[e.status].cls} hover:opacity-80`}>
                          {e.kind === 'posting' && <Film className="w-2.5 h-2.5 shrink-0" />}
                          <span className="truncate">{e.title}</span>
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
          <p className="text-[11px] text-muted-foreground mt-2">
            Click a day to add an event. <Film className="w-3 h-3 inline -mt-0.5" /> marks a video posting.
            Hover any entry for its details, or switch to List for all of them at once.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          <EntryList title="Upcoming" entries={upcoming} empty="Nothing ahead." />
          <EntryList title="Past" entries={past} empty="Nothing in the past." />
        </div>
      )}

      {creating && (
        <CreateEventDialog date={creating} campaigns={campaigns} pages={pages} publishers={publishers}
          onClose={() => setCreating(null)}
          onDone={async () => { setCreating(null); await refresh() }} />
      )}
    </div>
  )
}

/** The §5 fields in one line, for a hover title. */
function describe(e: Entry): string {
  return [
    e.title,
    `Campaign: ${e.campaign ?? '—'}`,
    `Page: ${e.page ?? '—'}`,
    `Type: ${e.contentType ?? '—'}`,
    `When: ${e.when ? formatWhen(e.when) : e.date}`,
    `Publisher: ${e.publisher ?? '—'}`,
    `Status: ${CALENDAR_STATUS[e.status].label}`,
  ].join('\n')
}

function CampaignProgressRow({ campaign }: { campaign: Campaign }) {
  const p = campaign.progress
  const pct = p && p.required > 0 ? Math.min(100, Math.round((p.published / p.required) * 100)) : 0
  return (
    <div>
      <div className="flex items-center justify-between text-xs mb-1 gap-2">
        <span className="text-foreground truncate">{campaign.name}</span>
        <span className="text-muted-foreground whitespace-nowrap">
          {!p ? '—' : p.required === 0
            ? `${p.published} published · no target`
            : `${p.published}/${p.required} published · ${p.remaining} left`}
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-muted overflow-hidden">
        <div className="h-full bg-orange-500" style={{ width: `${pct}%` }} />
      </div>
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

/** The list view: every entry with all six §5 fields as columns. */
function EntryList({ title, entries, empty }: { title: string; entries: Entry[]; empty: string }) {
  return (
    <div className="hub-card p-0 overflow-hidden">
      <div className="px-4 py-2.5 border-b border-border">
        <h2 className="text-sm font-semibold text-foreground">
          {title} <span className="text-xs text-muted-foreground font-normal">({entries.length})</span>
        </h2>
      </div>
      {entries.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-muted-foreground">{empty}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-widest text-muted-foreground border-b border-border">
                <th className="px-4 py-2 font-medium">Posting date/time</th>
                <th className="px-3 py-2 font-medium">Entry</th>
                <th className="px-3 py-2 font-medium">Campaign</th>
                <th className="px-3 py-2 font-medium">Social media page</th>
                <th className="px-3 py-2 font-medium">Content type</th>
                <th className="px-3 py-2 font-medium">Publisher</th>
                <th className="px-3 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {entries.map(e => (
                <tr key={e.key} className="border-b border-border last:border-0 hover:bg-accent/40">
                  <td className="px-4 py-2.5 text-xs text-muted-foreground whitespace-nowrap">
                    {e.when ? formatWhen(e.when) : e.date}
                  </td>
                  <td className="px-3 py-2.5">
                    <Link to={e.to} className="text-xs font-medium text-foreground hover:underline inline-flex items-center gap-1">
                      {e.kind === 'posting' && <Film className="w-3 h-3" />} {e.title}
                    </Link>
                  </td>
                  <td className="px-3 py-2.5 text-xs text-muted-foreground">{e.campaign ?? '—'}</td>
                  <td className="px-3 py-2.5 text-xs text-muted-foreground">{e.page ?? '—'}</td>
                  <td className="px-3 py-2.5 text-xs text-muted-foreground">{e.contentType ?? '—'}</td>
                  <td className="px-3 py-2.5 text-xs text-muted-foreground">{e.publisher ?? '—'}</td>
                  <td className="px-3 py-2.5">
                    <span className={`hub-badge ${CALENDAR_STATUS[e.status].cls}`}>{CALENDAR_STATUS[e.status].label}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function CreateEventDialog({ date, campaigns, pages, publishers, onClose, onDone }: {
  date: string
  campaigns: Campaign[]
  pages: Array<{ id: string; handle: string; platform: string }>
  publishers: Array<{ id: string; name: string }>
  onClose: () => void
  onDone: () => Promise<void>
}) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [when, setWhen] = useState(date)
  const [time, setTime] = useState('')
  const [campaignId, setCampaignId] = useState('')
  const [pageId, setPageId] = useState('')
  const [contentType, setContentType] = useState('')
  const [publisherId, setPublisherId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /* Narrow the pages to the chosen campaign's, when it names any. */
  const campaign = campaigns.find(c => c.id === campaignId)
  const offeredPages = campaign?.socialPageIds.length
    ? pages.filter(p => campaign.socialPageIds.includes(p.id))
    : pages

  async function save() {
    setBusy(true)
    setError(null)
    try {
      await createEvent({
        title, description, date: when,
        client: campaign?.name ?? null,
        campaignId: campaignId || null,
        socialPageId: pageId || null,
        contentType: contentType || null,
        // A time is optional; with one, it becomes the planned posting moment.
        postingAt: time ? new Date(`${when}T${time}`).toISOString() : null,
        assignedPublisherId: publisherId || null,
      })
      await onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the event.')
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4 animate-fade-in">
      <div className="bg-card rounded-xl border border-border w-full max-w-lg max-h-full flex flex-col">
        <div className="flex items-start justify-between p-4 border-b border-border shrink-0">
          <div>
            <h2 className="text-base font-serif text-foreground">New event</h2>
            <p className="text-xs text-muted-foreground">Assign it to an editor once it's created.</p>
          </div>
          <button onClick={onClose} disabled={busy}
            className="p-2 rounded-lg hover:bg-accent text-muted-foreground disabled:opacity-40"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-4 space-y-3 overflow-y-auto">
          <div>
            <label className="hub-label">Title *</label>
            <input className="hub-input" value={title} onChange={e => setTitle(e.target.value)}
              placeholder="Convocation shoot — main hall" autoFocus />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="hub-label">Date *</label>
              <input type="date" className="hub-input" value={when} onChange={e => setWhen(e.target.value)} />
            </div>
            <div>
              <label className="hub-label">Posting time</label>
              <input type="time" className="hub-input" value={time} onChange={e => setTime(e.target.value)} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="hub-label">Campaign</label>
              <select className="hub-input" value={campaignId}
                onChange={e => { setCampaignId(e.target.value); setPageId('') }}>
                <option value="">—</option>
                {campaigns.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div>
              <label className="hub-label">Social media page</label>
              <select className="hub-input" value={pageId} onChange={e => setPageId(e.target.value)}>
                <option value="">—</option>
                {offeredPages.map(p => <option key={p.id} value={p.id}>@{p.handle} · {p.platform}</option>)}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="hub-label">Content type</label>
              <input className="hub-input" list="ov-content-types" value={contentType}
                onChange={e => setContentType(e.target.value)} placeholder="Reel, Post, Story…" />
              <datalist id="ov-content-types">
                {CONTENT_TYPES.map(t => <option key={t} value={t} />)}
              </datalist>
            </div>
            <div>
              <label className="hub-label">Assigned publisher</label>
              <select className="hub-input" value={publisherId} onChange={e => setPublisherId(e.target.value)}>
                <option value="">—</option>
                {publishers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
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
        <div className="flex items-center justify-end gap-2 p-4 border-t border-border shrink-0">
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
