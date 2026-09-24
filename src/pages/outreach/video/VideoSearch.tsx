import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Search, AlertCircle, Film, Calendar, X } from 'lucide-react'
import {
  searchWorkflow, getFilterOptions, formatWhen,
  STATUS_STYLE, EVENT_STATUS_STYLE,
  type SearchParams, type FilterOptions, type VideoRecord, type EventRecord,
} from '@/lib/outreach-video-data'
import { useAuth } from '@/hooks/useAuth'

/**
 * §18 Search & Filtering, and the §27 "All Videos" view it doubles as.
 *
 * The filtering runs on the server, not on an already-fetched list, so what an
 * editor can reach here is the same set they can reach anywhere else (§25) —
 * removing a filter in the UI cannot widen it.
 */
export default function VideoSearch() {
  const { role } = useAuth()
  const isEditor = role === 'outreach_editor'

  const [params, setParams] = useState<SearchParams>({})
  const [text, setText] = useState('')
  const [options, setOptions] = useState<FilterOptions | null>(null)
  const [videos, setVideos] = useState<VideoRecord[]>([])
  const [events, setEvents] = useState<EventRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    getFilterOptions().then(setOptions).catch(() => setOptions(null))
  }, [])

  const run = useCallback(async (next: SearchParams) => {
    setLoading(true)
    try {
      const r = await searchWorkflow(next)
      setVideos(r.videos)
      setEvents(r.events)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed.')
    } finally {
      setLoading(false)
    }
  }, [])

  // Debounced so typing doesn't fire a Drive-backed search on every keystroke.
  useEffect(() => {
    const id = window.setTimeout(() => { void run({ ...params, q: text.trim() || undefined }) }, 300)
    return () => window.clearTimeout(id)
  }, [params, text, run])

  const set = (patch: Partial<SearchParams>) => setParams(p => ({ ...p, ...patch }))
  const activeCount = useMemo(
    () => Object.values(params).filter(Boolean).length + (text.trim() ? 1 : 0),
    [params, text],
  )

  function clearAll() {
    setParams({})
    setText('')
  }

  return (
    <div className="animate-fade-in space-y-5">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-orange-100 flex items-center justify-center">
          <Search className="w-5 h-5 text-orange-600" />
        </div>
        <div>
          <h1 className="text-2xl font-serif text-foreground">{isEditor ? 'My Work' : 'All Videos'}</h1>
          <p className="text-sm text-muted-foreground">
            Search videos and events by title, client, editor, status or ID.
          </p>
        </div>
      </div>

      <div className="hub-card space-y-3">
        <div className="relative">
          <Search className="w-4 h-4 text-muted-foreground absolute left-3 top-1/2 -translate-y-1/2" />
          <input className="hub-input pl-9" placeholder="Search videos and events…"
            value={text} onChange={e => setText(e.target.value)} />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Select label="Video status" value={params.status ?? ''}
            onChange={v => set({ status: (v || undefined) as SearchParams['status'] })}
            options={[['draft', 'Draft'], ['submitted', 'Submitted'], ['published', 'Published']]} />
          <Select label="Event status" value={params.eventStatus ?? ''}
            onChange={v => set({ eventStatus: (v || undefined) as SearchParams['eventStatus'] })}
            options={[['unassigned', 'Unassigned'], ['open', 'Open'], ['completed', 'Completed']]} />
          <Select label="Client" value={params.client ?? ''} onChange={v => set({ client: v || undefined })}
            options={(options?.clients ?? []).map(c => [c, c] as [string, string])} />
          {/* An editor's results are pinned to them, so an editor picker here
              would be a control that does nothing. */}
          {!isEditor && (
            <Select label="Editor" value={params.editorId ?? ''} onChange={v => set({ editorId: v || undefined })}
              options={(options?.editors ?? []).map(e => [e.id, e.name] as [string, string])} />
          )}
          {!isEditor && (
            <Select label="Publisher" value={params.publisherId ?? ''} onChange={v => set({ publisherId: v || undefined })}
              options={(options?.publishers ?? []).map(p => [p.id, p.name] as [string, string])} />
          )}
          {(options?.platforms.length ?? 0) > 0 && (
            <Select label="Platform" value={params.platform ?? ''} onChange={v => set({ platform: v || undefined })}
              options={(options?.platforms ?? []).map(p => [p, p] as [string, string])} />
          )}
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            From
            <input type="date" className="hub-input py-1.5 text-xs w-auto"
              value={params.from ?? ''} onChange={e => set({ from: e.target.value || undefined })} />
          </label>
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            To
            <input type="date" className="hub-input py-1.5 text-xs w-auto"
              value={params.to ?? ''} onChange={e => set({ to: e.target.value || undefined })} />
          </label>
          {activeCount > 0 && (
            <button onClick={clearAll}
              className="text-xs px-2.5 py-1.5 rounded-lg border border-border text-muted-foreground hover:bg-accent inline-flex items-center gap-1">
              <X className="w-3 h-3" /> Clear {activeCount}
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="hub-card bg-rose-50 border-rose-200 flex items-start gap-2 text-sm text-rose-900">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" /> <span>{error}</span>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <section className="space-y-2">
          <h2 className="text-[11px] uppercase tracking-widest text-muted-foreground flex items-center gap-1.5">
            <Film className="w-3.5 h-3.5" /> Videos ({videos.length})
          </h2>
          {loading ? (
            <div className="hub-card text-center py-8 text-sm text-muted-foreground">Searching…</div>
          ) : videos.length === 0 ? (
            <div className="hub-card text-center py-8 text-sm text-muted-foreground">No videos match.</div>
          ) : videos.map(v => (
            <Link key={v.id} to={`/outreach/video/videos/${v.id}`}
              className="hub-card block hover:border-orange-300 transition-colors">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground truncate">{v.title}</p>
                  <p className="text-xs text-muted-foreground truncate">
                    {v.client}{v.editorTitle && ` · ${v.editorTitle}`}
                  </p>
                  <p className="text-[11px] text-muted-foreground">{formatWhen(v.createdAt)}</p>
                </div>
                <span className={`hub-badge shrink-0 ${STATUS_STYLE[v.status].cls}`}>
                  {STATUS_STYLE[v.status].label}
                </span>
              </div>
            </Link>
          ))}
        </section>

        <section className="space-y-2">
          <h2 className="text-[11px] uppercase tracking-widest text-muted-foreground flex items-center gap-1.5">
            <Calendar className="w-3.5 h-3.5" /> Events ({events.length})
          </h2>
          {loading ? (
            <div className="hub-card text-center py-8 text-sm text-muted-foreground">Searching…</div>
          ) : events.length === 0 ? (
            <div className="hub-card text-center py-8 text-sm text-muted-foreground">No events match.</div>
          ) : events.map(e => (
            <Link key={e.id} to={`/outreach/video/events/${e.id}`}
              className="hub-card block hover:border-orange-300 transition-colors">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground truncate">{e.title}</p>
                  <p className="text-xs text-muted-foreground truncate">
                    {e.date}{e.client && ` · ${e.client}`}
                  </p>
                </div>
                <span className={`hub-badge shrink-0 ${EVENT_STATUS_STYLE[e.status].cls}`}>
                  {EVENT_STATUS_STYLE[e.status].label}
                </span>
              </div>
            </Link>
          ))}
        </section>
      </div>
    </div>
  )
}

function Select({ label, value, onChange, options }: {
  label: string; value: string; onChange: (v: string) => void; options: [string, string][]
}) {
  return (
    <select className="hub-input py-1.5 text-xs w-auto" value={value} onChange={e => onChange(e.target.value)}>
      <option value="">{label}: any</option>
      {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </select>
  )
}
