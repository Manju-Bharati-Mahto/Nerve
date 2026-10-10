import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Send, Download, Copy, Check, AlertCircle, Loader2, X, Inbox, CalendarClock,
} from 'lucide-react'
import {
  publishingQueue, publishVideo, scheduleVideo, listVideos, localDay, videoDownloadUrl, videoStreamUrl,
  formatWhen, loadFailureOf, type VideoRecord, type LiveUrlPlatform, type LoadFailure,
} from '@/lib/outreach-video-data'
import { useAuth } from '@/hooks/useAuth'
import DriveProblemNotice from './DriveProblemNotice'
import { useMayPublishVideos } from './workflow-roles'

/**
 * §4/§11 — the Publisher's queue: approved videos, scheduled or not. (Before
 * the review step existed this was described as the "Submitted" videos.)
 *
 * §14 — the Publisher's queue, which "must display only videos with Submitted
 * status", with everything needed to post them: preview, caption to copy, the
 * file to download, and the Mark as Published action (§15).
 *
 * Publishing is what removes a video from this queue (§28), so the list is
 * refetched after each one rather than patched locally — with several people
 * working the same queue, what's on screen should be what's actually left.
 *
 * A Manager (or anyone granted the tab) watches this queue too, but the API
 * leaves scheduling and publishing to Publishers and Admins. For everyone
 * else the queue is read-only rather than a set of buttons that each end in
 * "Your role cannot perform that action."
 */
export default function VideoQueue() {
  const canPublish = useMayPublishVideos()
  const [videos, setVideos] = useState<VideoRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<LoadFailure | null>(null)
  const [publishing, setPublishing] = useState<VideoRecord | null>(null)
  const [scheduling, setScheduling] = useState<VideoRecord | null>(null)
  const [publishedToday, setPublishedToday] = useState(0)

  const refresh = useCallback(async () => {
    try {
      const [{ videos }, published] = await Promise.all([
        publishingQueue(), listVideos({ status: 'published' }),
      ])
      setVideos(videos)
      const today = localDay()
      setPublishedToday(published.videos.filter(v => v.publishedAt && localDay(new Date(v.publishedAt)) === today).length)
      setError(null)
    } catch (err) {
      setError(loadFailureOf(err, 'Could not load the queue.'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  return (
    <div className="animate-fade-in space-y-5">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-orange-100 flex items-center justify-center">
          <Inbox className="w-5 h-5 text-orange-600" />
        </div>
        <div>
          <h1 className="text-2xl font-serif text-foreground">Publishing Queue</h1>
          <p className="text-sm text-muted-foreground">
            {canPublish
              ? 'Approved videos waiting to go live — schedule a posting time, or mark one as published.'
              : 'Approved videos waiting to go live. The publishers schedule and post them.'}
          </p>
        </div>
      </div>

      {/* §12 Publisher — "Today's Posts, Pending Publishing, Published Today". */}
      {!loading && !error && (
        <div className="grid grid-cols-3 gap-3">
          <Stat label="Today's posts" value={
            videos.filter(v => v.scheduledFor && localDay(new Date(v.scheduledFor)) === localDay()).length + publishedToday} />
          <Stat label="Pending publishing" value={videos.length} />
          <Stat label="Published today" value={publishedToday} />
        </div>
      )}

      {error && <DriveProblemNotice message={error.message} code={error.code} />}

      {/* "Nothing waiting" over a queue that was never read would tell a
          publisher the day's work is done. */}
      {error ? null : loading ? (
        <div className="hub-card text-center py-12 text-sm text-muted-foreground">Loading…</div>
      ) : videos.length === 0 ? (
        <div className="hub-card text-center py-12">
          <p className="text-sm text-muted-foreground">
            Nothing waiting. Videos appear here once a reviewer approves them.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {videos.map(v => (
            <QueueCard key={v.id} video={v} canPublish={canPublish}
              onPublish={() => setPublishing(v)} onSchedule={() => setScheduling(v)} />
          ))}
        </div>
      )}

      {scheduling && (
        <ScheduleDialog
          video={scheduling}
          onClose={() => setScheduling(null)}
          onDone={async () => { setScheduling(null); await refresh() }}
        />
      )}

      {publishing && (
        <PublishDialog
          video={publishing}
          onClose={() => setPublishing(null)}
          onDone={async () => { setPublishing(null); await refresh() }}
        />
      )}
    </div>
  )
}

function QueueCard({ video, canPublish, onPublish, onSchedule }: {
  video: VideoRecord; canPublish: boolean; onPublish: () => void; onSchedule: () => void
}) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="hub-card">
      <div className="grid grid-cols-1 md:grid-cols-[260px_1fr] gap-4">
        <video controls preload="metadata" className="w-full rounded-lg bg-black max-h-48"
          src={videoStreamUrl(video.id)} />
        <div className="min-w-0 space-y-2">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div className="min-w-0">
              <Link to={`/outreach/video/videos/${video.id}`}
                className="text-sm font-medium text-foreground hover:underline">
                {video.title}
              </Link>
              <p className="text-xs text-muted-foreground">
                {video.client} · submitted {formatWhen(video.submittedAt)}
                {/* §4 — the posting time, when one has been set. */}
                {video.scheduledFor && <> · <b className="text-violet-700">scheduled for {formatWhen(video.scheduledFor)}</b></>}
              </p>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <button
                onClick={async () => {
                  await navigator.clipboard.writeText(video.caption)
                  setCopied(true)
                  setTimeout(() => setCopied(false), 1500)
                }}
                className="text-xs px-2.5 py-1.5 rounded-lg bg-muted text-muted-foreground hover:bg-accent inline-flex items-center gap-1">
                {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                {copied ? 'Copied' : 'Copy caption'}
              </button>
              <a href={videoDownloadUrl(video.id)}
                className="text-xs px-2.5 py-1.5 rounded-lg bg-blue-100 text-blue-700 hover:opacity-80 inline-flex items-center gap-1">
                <Download className="w-3 h-3" /> Download
              </a>
              {canPublish && (
                <>
                  <button onClick={onSchedule}
                    className="text-xs px-2.5 py-1.5 rounded-lg bg-violet-100 text-violet-700 hover:opacity-80 inline-flex items-center gap-1">
                    <CalendarClock className="w-3 h-3" /> {video.scheduledFor ? 'Reschedule' : 'Schedule'}
                  </button>
                  <button onClick={onPublish}
                    className="text-xs px-2.5 py-1.5 rounded-lg bg-emerald-600 text-white hover:opacity-90 inline-flex items-center gap-1">
                    <Send className="w-3 h-3" /> Mark as published
                  </button>
                </>
              )}
            </div>
          </div>
          <p className="text-xs text-foreground whitespace-pre-wrap bg-muted/40 rounded-lg p-2.5 max-h-32 overflow-y-auto">
            {video.caption}
          </p>
        </div>
      </div>
    </div>
  )
}

/** §15 steps 5–7, with the optional live URLs of §15.1. */
function PublishDialog({ video, onClose, onDone }: {
  video: VideoRecord
  onClose: () => void
  onDone: () => Promise<void>
}) {
  const [instagram, setInstagram] = useState('')
  const [facebook, setFacebook] = useState('')
  const [remark, setRemark] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function publish() {
    setBusy(true)
    setError(null)
    try {
      const liveUrls: Partial<Record<LiveUrlPlatform, string>> = {}
      if (instagram.trim()) liveUrls.instagram = instagram.trim()
      if (facebook.trim()) liveUrls.facebook = facebook.trim()
      await publishVideo(video.id, liveUrls, remark.trim())
      await onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not publish.')
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4 animate-fade-in">
      <div className="bg-card rounded-xl border border-border w-full max-w-md">
        <div className="flex items-start justify-between p-4 border-b border-border">
          <div>
            <h2 className="text-base font-serif text-foreground">Mark as published</h2>
            <p className="text-xs text-muted-foreground truncate max-w-xs">{video.title}</p>
          </div>
          <button onClick={onClose} disabled={busy}
            className="p-2 rounded-lg hover:bg-accent text-muted-foreground disabled:opacity-40">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 space-y-3">
          <p className="text-xs text-muted-foreground">
            Post the video, then record where it went. Both links are optional and can be
            added later.
          </p>
          <div>
            <label className="hub-label">Instagram link</label>
            <input className="hub-input" value={instagram} onChange={e => setInstagram(e.target.value)}
              placeholder="https://www.instagram.com/p/…" />
          </div>
          <div>
            <label className="hub-label">Facebook link</label>
            <input className="hub-input" value={facebook} onChange={e => setFacebook(e.target.value)}
              placeholder="https://www.facebook.com/…" />
          </div>
          <div>
            <label className="hub-label">Remark</label>
            <textarea className="hub-input min-h-16" value={remark} onChange={e => setRemark(e.target.value)}
              placeholder="Optional — anything worth knowing about this post" />
            <p className="text-[11px] text-muted-foreground mt-1">Saved with the video, and in its file in Google Drive.</p>
          </div>
          {error && (
            <div className="hub-card bg-rose-50 border-rose-200 flex items-start gap-2 text-xs text-rose-900">
              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" /> <span>{error}</span>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 p-4 border-t border-border">
          <button onClick={onClose} disabled={busy}
            className="px-4 py-2 rounded-lg border border-border text-sm text-muted-foreground hover:bg-accent disabled:opacity-40">
            Cancel
          </button>
          <button onClick={publish} disabled={busy}
            className="px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:opacity-90 disabled:opacity-40 inline-flex items-center gap-2">
            {busy && <Loader2 className="w-4 h-4 animate-spin" />}
            {busy ? 'Publishing…' : 'Mark as published'}
          </button>
        </div>
      </div>
    </div>
  )
}

/** §4 — the Publisher records when approved content is due to go out. */
function ScheduleDialog({ video, onClose, onDone }: {
  video: VideoRecord
  onClose: () => void
  onDone: () => Promise<void>
}) {
  /* A datetime-local input speaks the browser's local time, which for the
     outreach team is IST; converting with Date keeps it exact either way. */
  const initial = video.scheduledFor ? toLocalInput(video.scheduledFor) : ''
  const [when, setWhen] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save() {
    setBusy(true)
    setError(null)
    try {
      await scheduleVideo(video.id, new Date(when).toISOString())
      await onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not schedule.')
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4 animate-fade-in">
      <div className="bg-card rounded-xl border border-border w-full max-w-md max-h-full flex flex-col">
        <div className="flex items-start justify-between p-4 border-b border-border shrink-0">
          <div>
            <h2 className="text-base font-serif text-foreground">{initial ? 'Reschedule' : 'Schedule'} posting</h2>
            <p className="text-xs text-muted-foreground truncate max-w-xs">{video.title}</p>
          </div>
          <button onClick={onClose} disabled={busy}
            className="p-2 rounded-lg hover:bg-accent text-muted-foreground disabled:opacity-40">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-4 space-y-3 overflow-y-auto">
          <div>
            <label className="hub-label">Posting date and time</label>
            <input className="hub-input" type="datetime-local" value={when} onChange={e => setWhen(e.target.value)} />
          </div>
          <p className="text-xs text-muted-foreground">
            Nothing posts automatically. When the time comes the publishers are reminded, and the
            video stays here until someone marks it published.
          </p>
          {error && <p className="text-xs text-rose-600">{error}</p>}
        </div>
        <div className="flex items-center justify-end gap-2 p-4 border-t border-border shrink-0">
          <button onClick={onClose} disabled={busy}
            className="px-4 py-2 rounded-lg border border-border text-sm text-muted-foreground hover:bg-accent disabled:opacity-40">
            Cancel
          </button>
          <button onClick={save} disabled={busy || !when}
            className="px-4 py-2 rounded-lg bg-violet-600 text-white text-sm font-medium hover:opacity-90 disabled:opacity-40">
            {busy ? 'Saving…' : 'Save schedule'}
          </button>
        </div>
      </div>
    </div>
  )
}

/** An ISO time as the value a datetime-local input expects, in local time. */
function toLocalInput(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="hub-card py-3">
      <div className="text-2xl font-serif text-foreground leading-none">{value}</div>
      <div className="text-[11px] text-muted-foreground mt-1">{label}</div>
    </div>
  )
}
