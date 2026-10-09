import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { CalendarClock, Loader2, Clock } from 'lucide-react'
import {
  publishingQueue, formatWhen, loadFailureOf, STATUS_STYLE, type VideoRecord, type LoadFailure,
} from '@/lib/outreach-video-data'
import DriveProblemNotice from './DriveProblemNotice'

/**
 * §4 — approved content with a posting time set, in the order it is due.
 *
 * Reads the publisher's queue and shows the scheduled half of it. Scheduled
 * work is still in that queue because it has not gone out yet: a schedule is
 * an intention, not a publication, and nothing in this system posts on its
 * own. Anything whose time has passed is called out, because an unnoticed
 * missed slot is the failure this page exists to prevent.
 */
export default function VideoScheduled() {
  const [videos, setVideos] = useState<VideoRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<LoadFailure | null>(null)

  const refresh = useCallback(async () => {
    try {
      const { videos } = await publishingQueue()
      setVideos(videos)
      setError(null)
    } catch (err) {
      setError(loadFailureOf(err, 'Could not load the schedule.'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const scheduled = useMemo(
    () => videos.filter(v => v.status === 'scheduled' && v.scheduledFor)
      .sort((a, b) => (a.scheduledFor ?? '').localeCompare(b.scheduledFor ?? '')),
    [videos],
  )
  const now = Date.now()

  return (
    <div className="animate-fade-in space-y-5">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-violet-100 flex items-center justify-center">
          <CalendarClock className="w-5 h-5 text-violet-600" />
        </div>
        <div>
          <h1 className="text-xl font-serif text-foreground">Scheduled</h1>
          <p className="text-sm text-muted-foreground">
            Approved content with a posting time. Nothing posts automatically — these still
            need publishing when their slot comes.
          </p>
        </div>
      </div>

      {error && <DriveProblemNotice message={error.message} code={error.code} />}

      {/* "Nothing is scheduled" is the wrong answer to a schedule nobody read. */}
      {error ? null : loading ? (
        <div className="hub-card text-center py-12 text-sm text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin inline mr-2" /> Loading…
        </div>
      ) : scheduled.length === 0 ? (
        <div className="hub-card text-center py-12">
          <CalendarClock className="w-8 h-8 text-muted-foreground/40 mx-auto mb-2" />
          <p className="text-sm text-muted-foreground">Nothing is scheduled.</p>
          <p className="text-xs text-muted-foreground mt-1">
            Approved content can be given a posting time from the publishing queue.
          </p>
        </div>
      ) : (
        <div className="hub-card overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-widest text-muted-foreground border-b border-border">
                <th className="px-3 py-2.5 font-medium">Due</th>
                <th className="px-3 py-2.5 font-medium">Video</th>
                <th className="px-3 py-2.5 font-medium">Campaign</th>
                <th className="px-3 py-2.5 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {scheduled.map(v => {
                const overdue = new Date(v.scheduledFor as string).getTime() < now
                return (
                  <tr key={v.id} className="border-b border-border/60 last:border-0">
                    <td className="px-3 py-2.5 whitespace-nowrap">
                      <span className={overdue ? 'text-rose-600 font-medium' : 'text-foreground'}>
                        {formatWhen(v.scheduledFor as string)}
                      </span>
                      {overdue && (
                        <span className="ml-2 text-[11px] text-rose-600 inline-flex items-center gap-1">
                          <Clock className="w-3 h-3" /> past due
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      <Link to={`/outreach/video/videos/${v.id}`}
                        className="text-foreground hover:underline">{v.title}</Link>
                    </td>
                    <td className="px-3 py-2.5 text-muted-foreground">{v.client}</td>
                    <td className="px-3 py-2.5">
                      <span className={`hub-badge ${STATUS_STYLE[v.status].cls}`}>
                        {STATUS_STYLE[v.status].label}
                      </span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
