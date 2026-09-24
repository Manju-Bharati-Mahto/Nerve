import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { History, AlertCircle, Film, Calendar, Search, X } from 'lucide-react'
import {
  listActivity, listActivityActors, formatWhen, describeAction,
  type FeedEntry, type ActivityActor,
} from '@/lib/outreach-video-data'
import { useAuth } from '@/hooks/useAuth'

/**
 * §16 — the chronological activity timeline across every video and event.
 *
 * Derived from the per-record histories rather than stored separately, so it
 * can't drift from what a video's own timeline says. There is no delete here
 * by design: §28 requires that no workflow action erases historical activity.
 */
export default function VideoActivity() {
  const { role } = useAuth()
  const isEditor = role === 'outreach_editor'

  const [entries, setEntries] = useState<FeedEntry[]>([])
  const [actors, setActors] = useState<ActivityActor[]>([])
  const [text, setText] = useState('')
  const [userId, setUserId] = useState('')
  const [subject, setSubject] = useState<'' | 'video' | 'event'>('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (isEditor) return
    listActivityActors().then(r => setActors(r.actors)).catch(() => setActors([]))
  }, [isEditor])

  const run = useCallback(async () => {
    setLoading(true)
    try {
      const r = await listActivity({
        q: text.trim() || undefined,
        userId: userId || undefined,
        subject: subject || undefined,
        from: from || undefined,
        to: to || undefined,
      })
      setEntries(r.entries)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the activity log.')
    } finally {
      setLoading(false)
    }
  }, [text, userId, subject, from, to])

  useEffect(() => {
    const id = window.setTimeout(() => { void run() }, 300)
    return () => window.clearTimeout(id)
  }, [run])

  const active = [text.trim(), userId, subject, from, to].filter(Boolean).length

  return (
    <div className="animate-fade-in space-y-5">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-orange-100 flex items-center justify-center">
          <History className="w-5 h-5 text-orange-600" />
        </div>
        <div>
          <h1 className="text-2xl font-serif text-foreground">Activity</h1>
          <p className="text-sm text-muted-foreground">
            {isEditor ? 'Everything that happened to your videos and assigned events.'
              : 'Every action across the video workflow, newest first.'}
          </p>
        </div>
      </div>

      <div className="hub-card space-y-3">
        <div className="relative">
          <Search className="w-4 h-4 text-muted-foreground absolute left-3 top-1/2 -translate-y-1/2" />
          <input className="hub-input pl-9" placeholder="Search by action, person or title…"
            value={text} onChange={e => setText(e.target.value)} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select className="hub-input py-1.5 text-xs w-auto" value={subject}
            onChange={e => setSubject(e.target.value as '' | 'video' | 'event')}>
            <option value="">Everything</option>
            <option value="video">Videos only</option>
            <option value="event">Events only</option>
          </select>
          {!isEditor && (
            <select className="hub-input py-1.5 text-xs w-auto" value={userId}
              onChange={e => setUserId(e.target.value)}>
              <option value="">Anyone</option>
              {actors.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          )}
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            From
            <input type="date" className="hub-input py-1.5 text-xs w-auto"
              value={from} onChange={e => setFrom(e.target.value)} />
          </label>
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            To
            <input type="date" className="hub-input py-1.5 text-xs w-auto"
              value={to} onChange={e => setTo(e.target.value)} />
          </label>
          {active > 0 && (
            <button onClick={() => { setText(''); setUserId(''); setSubject(''); setFrom(''); setTo('') }}
              className="text-xs px-2.5 py-1.5 rounded-lg border border-border text-muted-foreground hover:bg-accent inline-flex items-center gap-1">
              <X className="w-3 h-3" /> Clear {active}
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="hub-card bg-rose-50 border-rose-200 flex items-start gap-2 text-sm text-rose-900">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" /> <span>{error}</span>
        </div>
      )}

      {loading ? (
        <div className="hub-card text-center py-12 text-sm text-muted-foreground">Loading…</div>
      ) : entries.length === 0 ? (
        <div className="hub-card text-center py-12">
          <p className="text-sm text-muted-foreground">
            {active > 0 ? 'Nothing matches those filters.' : 'No activity recorded yet.'}
          </p>
        </div>
      ) : (
        <div className="hub-card">
          <ol className="space-y-4">
            {entries.map(entry => (
              <li key={entry.id} className="flex gap-3">
                <div className="mt-0.5 w-7 h-7 rounded-lg bg-muted flex items-center justify-center shrink-0">
                  {entry.subject.type === 'video'
                    ? <Film className="w-3.5 h-3.5 text-muted-foreground" />
                    : <Calendar className="w-3.5 h-3.5 text-muted-foreground" />}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-foreground">
                    <span className="font-medium">{entry.userName}</span>
                    {' · '}
                    {describeAction(entry.action.replace(/^event\./, ''))}
                    {entry.previousStatus && entry.newStatus && (
                      <span className="text-muted-foreground">
                        {' '}({entry.previousStatus} → {entry.newStatus})
                      </span>
                    )}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    <Link className="hover:underline"
                      to={entry.subject.type === 'video'
                        ? `/outreach/video/videos/${entry.subject.id}`
                        : `/outreach/video/events/${entry.subject.id}`}>
                      {entry.subject.title}
                    </Link>
                    {' · '}{formatWhen(entry.timestamp)}
                  </p>
                  {entry.notes && <p className="text-xs text-muted-foreground mt-0.5">{entry.notes}</p>}
                </div>
                <span className="text-[11px] text-muted-foreground shrink-0 capitalize">{entry.userRole}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  )
}
