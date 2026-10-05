import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  ShieldCheck, Download, Copy, Check, AlertCircle, Loader2, X, ThumbsUp, ThumbsDown,
} from 'lucide-react'
import {
  reviewQueue, approveVideo, rejectVideo, videoDownloadUrl, videoStreamUrl,
  formatWhen, type VideoRecord,
} from '@/lib/outreach-video-data'

/**
 * §11 — the review step: content waiting to be approved or sent back.
 *
 * This is the gate the workflow did not previously have. Nothing reaches a
 * publisher without passing through here, which is the whole substance of
 * §11 — so the two actions are deliberately given equal weight on screen
 * rather than making approval the obvious one-click default.
 *
 * Rejecting requires a reason. §11 says the editor must be able to see why,
 * and a rejection with nothing attached reads as silence to the person who
 * has to act on it, so the dialog will not submit without one.
 */
export default function VideoReview() {
  const [videos, setVideos] = useState<VideoRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [rejecting, setRejecting] = useState<VideoRecord | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const { videos } = await reviewQueue()
      setVideos(videos)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the review queue.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  async function approve(video: VideoRecord, remark: string) {
    setBusyId(video.id)
    setError(null)
    try {
      await approveVideo(video.id, remark.trim())
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not approve that video.')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="animate-fade-in space-y-5">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-amber-100 flex items-center justify-center">
          <ShieldCheck className="w-5 h-5 text-amber-600" />
        </div>
        <div>
          <h1 className="text-xl font-serif text-foreground">Review queue</h1>
          <p className="text-sm text-muted-foreground">
            Content waiting on you. Approving releases it to the publishers.
          </p>
        </div>
      </div>

      {error && (
        <div className="hub-card flex items-start gap-2 text-sm text-rose-600">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" /> {error}
        </div>
      )}

      {loading ? (
        <div className="hub-card text-center py-12 text-sm text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin inline mr-2" /> Loading…
        </div>
      ) : videos.length === 0 ? (
        <div className="hub-card text-center py-12">
          <ShieldCheck className="w-8 h-8 text-muted-foreground/40 mx-auto mb-2" />
          <p className="text-sm text-muted-foreground">Nothing is waiting for review.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {videos.map(v => (
            <ReviewCard key={v.id} video={v} busy={busyId === v.id}
              onApprove={remark => approve(v, remark)} onReject={() => setRejecting(v)} />
          ))}
        </div>
      )}

      {rejecting && (
        <RejectDialog video={rejecting}
          onClose={() => setRejecting(null)}
          onDone={async () => { setRejecting(null); await refresh() }} />
      )}
    </div>
  )
}

function ReviewCard({ video, busy, onApprove, onReject }: {
  video: VideoRecord; busy: boolean; onApprove: (remark: string) => void; onReject: () => void
}) {
  const [copied, setCopied] = useState(false)
  const [remark, setRemark] = useState('')

  return (
    <div className="hub-card space-y-3">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <Link to={`/outreach/video/videos/${video.id}`}
            className="text-sm font-medium text-foreground hover:underline">
            {video.title}
          </Link>
          <p className="text-xs text-muted-foreground mt-0.5">
            {video.client}
            {video.submittedAt && ` · submitted ${formatWhen(video.submittedAt)}`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <a href={videoDownloadUrl(video.id)}
            className="text-xs px-2.5 py-1.5 rounded-lg bg-blue-100 text-blue-700 hover:opacity-80 inline-flex items-center gap-1">
            <Download className="w-3 h-3" /> Download
          </a>
          <button onClick={onReject} disabled={busy}
            className="text-xs px-2.5 py-1.5 rounded-lg bg-rose-100 text-rose-700 hover:opacity-80 disabled:opacity-40 inline-flex items-center gap-1">
            <ThumbsDown className="w-3 h-3" /> Send back
          </button>
          <button onClick={() => onApprove(remark)} disabled={busy}
            className="text-xs px-2.5 py-1.5 rounded-lg bg-emerald-600 text-white hover:opacity-90 disabled:opacity-40 inline-flex items-center gap-1">
            <ThumbsUp className="w-3 h-3" /> {busy ? 'Approving…' : 'Approve'}
          </button>
        </div>
      </div>

      <video src={videoStreamUrl(video.id)} controls preload="metadata"
        className="w-full max-h-72 rounded-lg bg-black" />

      <div>
        <div className="flex items-center justify-between gap-2 mb-1">
          <p className="text-[11px] uppercase tracking-widest text-muted-foreground">Caption</p>
          <button
            onClick={() => { void navigator.clipboard.writeText(video.caption); setCopied(true); setTimeout(() => setCopied(false), 1500) }}
            className="text-xs px-2 py-1 rounded-lg border border-border text-muted-foreground hover:bg-accent inline-flex items-center gap-1">
            {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
        <p className="text-sm text-foreground whitespace-pre-wrap">{video.caption}</p>
      </div>

      {video.notes && (
        <div>
          <p className="text-[11px] uppercase tracking-widest text-muted-foreground mb-1">Editor's description</p>
          <p className="text-sm text-foreground whitespace-pre-wrap">{video.notes}</p>
        </div>
      )}

      <div>
        <label className="hub-label">Remark on approval (optional)</label>
        <input className="hub-input" value={remark} onChange={e => setRemark(e.target.value)}
          placeholder="e.g. Use this one for the launch post" />
        <p className="text-[11px] text-muted-foreground mt-1">
          Saved with the video and in its file in Google Drive. Sending it back asks for a reason instead.
        </p>
      </div>
    </div>
  )
}

/** §11 — a rejection carries a reason, so this dialog cannot be submitted without one. */
function RejectDialog({ video, onClose, onDone }: {
  video: VideoRecord; onClose: () => void; onDone: () => Promise<void>
}) {
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function send() {
    setBusy(true)
    setError(null)
    try {
      await rejectVideo(video.id, reason.trim())
      await onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send that back.')
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4 animate-fade-in">
      <div className="bg-card rounded-xl border border-border w-full max-w-md max-h-full flex flex-col">
        <div className="flex items-start justify-between p-4 border-b border-border shrink-0">
          <h2 className="text-base font-serif text-foreground">Send back for changes</h2>
          <button onClick={onClose} disabled={busy}
            className="p-2 rounded-lg hover:bg-accent text-muted-foreground disabled:opacity-40">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-4 space-y-3 overflow-y-auto">
          <p className="text-sm text-muted-foreground">
            “{video.title}” goes back to the editor. They will see exactly what you write here.
          </p>
          <div>
            <label className="hub-label">What needs changing? *</label>
            <textarea className="hub-input min-h-28" value={reason} autoFocus
              onChange={e => setReason(e.target.value)}
              placeholder="e.g. The logo in the last three seconds is the old one." />
          </div>
          {error && <p className="text-xs text-rose-600">{error}</p>}
        </div>
        <div className="flex items-center justify-end gap-2 p-4 border-t border-border shrink-0">
          <button onClick={onClose} disabled={busy}
            className="px-4 py-2 rounded-lg border border-border text-sm text-muted-foreground hover:bg-accent disabled:opacity-40">
            Cancel
          </button>
          <button onClick={send} disabled={busy || !reason.trim()}
            className="px-4 py-2 rounded-lg bg-rose-600 text-white text-sm font-medium hover:opacity-90 disabled:opacity-40">
            {busy ? 'Sending…' : 'Send back'}
          </button>
        </div>
      </div>
    </div>
  )
}
