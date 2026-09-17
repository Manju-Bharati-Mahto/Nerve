import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ClipboardList, AlertCircle, Users, Rows3 } from 'lucide-react'
import {
  getEditorLog, getFilterOptions, formatMonth, STATUS_STYLE,
  type EditorVideoLog, type VideoLogEntry, type FilterOptions,
} from '@/lib/outreach-video-data'

/**
 * §11.3 (Manager) and §14.1 (Publisher) — the monthly log of which editor
 * edited which video.
 *
 * Both sections describe the same table, so it's one page: §11.3 adds the
 * optional client filter and the grouped-by-editor view, which the Publisher
 * gets too rather than being handed a deliberately poorer version.
 */
export default function VideoEditorLog() {
  const [log, setLog] = useState<EditorVideoLog | null>(null)
  const [options, setOptions] = useState<FilterOptions | null>(null)
  const [month, setMonth] = useState<string>('')
  const [client, setClient] = useState<string>('')
  const [grouped, setGrouped] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => { getFilterOptions().then(setOptions).catch(() => setOptions(null)) }, [])

  const load = useCallback(async (month?: string, client?: string) => {
    setLoading(true)
    try {
      const l = await getEditorLog({ month: month || undefined, client: client || undefined })
      setLog(l)
      // The server picks the newest month with data when none was asked for;
      // reflect that back so the picker isn't showing a different month.
      setMonth(m => m || l.month)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the log.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load(month, client) }, [load, month, client])

  return (
    <div className="animate-fade-in space-y-5">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-orange-100 flex items-center justify-center">
            <ClipboardList className="w-5 h-5 text-orange-600" />
          </div>
          <div>
            <h1 className="text-2xl font-serif text-foreground">Editor Video Log</h1>
            <p className="text-sm text-muted-foreground">Who edited what, month by month.</p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <select className="hub-input py-1.5 text-xs w-auto" value={month} onChange={e => setMonth(e.target.value)}>
            {(log?.availableMonths.length ? log.availableMonths : [month || new Date().toISOString().slice(0, 7)])
              .map(m => <option key={m} value={m}>{formatMonth(m)}</option>)}
          </select>
          <select className="hub-input py-1.5 text-xs w-auto" value={client} onChange={e => setClient(e.target.value)}>
            <option value="">All clients</option>
            {(options?.clients ?? []).map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <div className="flex rounded-lg border border-border overflow-hidden">
            <Toggle active={!grouped} onClick={() => setGrouped(false)} icon={Rows3} label="List" />
            <Toggle active={grouped} onClick={() => setGrouped(true)} icon={Users} label="By editor" />
          </div>
        </div>
      </div>

      {error && (
        <div className="hub-card bg-rose-50 border-rose-200 flex items-start gap-2 text-sm text-rose-900">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" /> <span>{error}</span>
        </div>
      )}

      {loading ? (
        <div className="hub-card text-center py-12 text-sm text-muted-foreground">Loading…</div>
      ) : !log || log.entries.length === 0 ? (
        <div className="hub-card text-center py-12">
          <p className="text-sm text-muted-foreground">
            No videos were uploaded in {formatMonth(month)}{client && ` for ${client}`}.
          </p>
        </div>
      ) : grouped ? (
        <div className="space-y-4">
          {log.byEditor.map(group => (
            <div key={group.editorId} className="hub-card">
              <div className="flex items-baseline justify-between gap-3 mb-3">
                <h2 className="text-sm font-semibold text-foreground">{group.editorName}</h2>
                <span className="text-xs text-muted-foreground">
                  {group.entries.length} video{group.entries.length === 1 ? '' : 's'}
                </span>
              </div>
              <LogTable entries={group.entries} showEditor={false} />
            </div>
          ))}
        </div>
      ) : (
        <div className="hub-card">
          <LogTable entries={log.entries} showEditor />
        </div>
      )}
    </div>
  )
}

function Toggle({ active, onClick, icon: Icon, label }: {
  active: boolean; onClick: () => void; icon: React.ElementType; label: string
}) {
  return (
    <button onClick={onClick}
      className={`px-2.5 py-1.5 text-xs inline-flex items-center gap-1 ${
        active ? 'bg-orange-100 text-orange-700' : 'text-muted-foreground hover:bg-accent'}`}>
      <Icon className="w-3.5 h-3.5" /> {label}
    </button>
  )
}

/** §11.3 — "Editor, Video title, Client/Project, Status, and Date". */
function LogTable({ entries, showEditor }: { entries: VideoLogEntry[]; showEditor: boolean }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-muted-foreground border-b border-border">
            {showEditor && <th className="py-2 pr-3 font-medium">Editor</th>}
            <th className="py-2 pr-3 font-medium">Video title</th>
            <th className="py-2 pr-3 font-medium">Client / project</th>
            <th className="py-2 pr-3 font-medium">Status</th>
            <th className="py-2 font-medium">Date</th>
          </tr>
        </thead>
        <tbody>
          {entries.map(e => (
            <tr key={e.videoId} className="border-b border-border/60 last:border-0">
              {showEditor && <td className="py-2 pr-3 text-foreground">{e.editorName}</td>}
              <td className="py-2 pr-3">
                <Link to={`/outreach/video/videos/${e.videoId}`}
                  className="text-foreground hover:underline">{e.title}</Link>
              </td>
              <td className="py-2 pr-3 text-muted-foreground">{e.client}</td>
              <td className="py-2 pr-3">
                <span className={`hub-badge ${STATUS_STYLE[e.status].cls}`}>{STATUS_STYLE[e.status].label}</span>
              </td>
              <td className="py-2 text-muted-foreground whitespace-nowrap">{e.date}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
