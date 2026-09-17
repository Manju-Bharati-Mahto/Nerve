import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  ArrowLeft, Send, Download, Copy, Check, AlertCircle, ExternalLink, Pencil,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  getVideo, submitVideo, updateCaption, videoStreamUrl, videoDownloadUrl,
  STATUS_STYLE, formatBytes, formatWhen, describeAction,
  type VideoRecord,
} from '@/lib/outreach-video-data'

/**
 * §10 — "the video detail page should show the video player, client, title,
 * status, uploader, upload date, caption, and activity timeline."
 *
 * The player streams through the API rather than a Drive link, so access is
 * checked on the bytes themselves (§25).
 */
export default function VideoDetail() {
  const { videoId } = useParams<{ videoId: string }>()
  const [video, setVideo] = useState<VideoRecord | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    if (!videoId) return
    try {
      const { video } = await getVideo(videoId)
      setVideo(video)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load this video.')
    } finally {
      setLoading(false)
    }
  }, [videoId])

  useEffect(() => { void refresh() }, [refresh])

  if (loading) return <div className="hub-card text-center py-12 text-sm text-muted-foreground">Loading…</div>
  if (error || !video) {
    return (
      <div className="animate-fade-in space-y-4">
        <BackLink />
        <div className="hub-card bg-rose-50 border-rose-200 flex items-start gap-2 text-sm text-rose-900">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" /> <span>{error ?? 'Not found.'}</span>
        </div>
      </div>
    )
  }

  return (
    <div className="animate-fade-in space-y-5">
      <BackLink />

      <div className="hub-card">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-xl font-serif text-foreground">{video.title}</h1>
            <p className="text-sm text-muted-foreground">
              {video.client}
              {video.editorTitle && video.editorTitle !== video.title && ` · ${video.editorTitle}`}
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`hub-badge ${STATUS_STYLE[video.status].cls}`}>{STATUS_STYLE[video.status].label}</span>
            {video.status === 'draft' && <SubmitButton video={video} onDone={refresh} />}
            <a href={videoDownloadUrl(video.id)}
              className="text-xs px-2.5 py-1.5 rounded-lg bg-blue-100 text-blue-700 hover:opacity-80 inline-flex items-center gap-1">
              <Download className="w-3 h-3" /> Download
            </a>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <div className="lg:col-span-2 space-y-5">
          {/* §10 — in-app preview, streamed via the API. */}
          <div className="hub-card p-0 overflow-hidden bg-black">
            <video
              key={video.id}
              controls
              preload="metadata"
              className="w-full max-h-[460px] bg-black"
              src={videoStreamUrl(video.id)}
            />
          </div>

          <CaptionPanel video={video} onDone={refresh} />
        </div>

        <div className="space-y-5">
          <div className="hub-card">
            <h2 className="text-sm font-semibold text-foreground mb-3">Details</h2>
            <dl className="space-y-2 text-xs">
              <Row label="Client / project" value={video.client} />
              <Row label="Status" value={STATUS_STYLE[video.status].label} />
              <Row label="Uploaded" value={formatWhen(video.createdAt)} />
              <Row label="Submitted" value={formatWhen(video.submittedAt)} />
              <Row label="Published" value={formatWhen(video.publishedAt)} />
              <Row label="File" value={video.driveFileName} />
              <Row label="Size" value={formatBytes(video.sizeBytes)} />
              {video.platform && <Row label="Platform" value={video.platform} />}
              {!!video.tags?.length && <Row label="Tags" value={video.tags.join(', ')} />}
              {video.notes && <Row label="Notes" value={video.notes} />}
            </dl>
          </div>

          {!!Object.keys(video.liveUrls ?? {}).length && (
            <div className="hub-card">
              <h2 className="text-sm font-semibold text-foreground mb-3">Live links</h2>
              <div className="space-y-1.5">
                {Object.entries(video.liveUrls ?? {}).map(([platform, url]) => (
                  <a key={platform} href={url} target="_blank" rel="noreferrer"
                    className="flex items-center gap-1.5 text-xs text-orange-600 hover:underline">
                    <ExternalLink className="w-3 h-3 shrink-0" />
                    <span className="capitalize">{platform}</span>
                  </a>
                ))}
              </div>
            </div>
          )}

          {/* §16 — the immutable trail, newest last so it reads as a story. */}
          <div className="hub-card">
            <h2 className="text-sm font-semibold text-foreground mb-3">Activity</h2>
            <ol className="space-y-3">
              {video.activity.map(a => (
                <li key={a.id} className="flex gap-2.5">
                  <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-orange-400 shrink-0" />
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-foreground">{describeAction(a.action)}</p>
                    <p className="text-[11px] text-muted-foreground">
                      {a.userName} · {formatWhen(a.timestamp)}
                    </p>
                    {a.previousStatus && a.newStatus && (
                      <p className="text-[11px] text-muted-foreground">{a.previousStatus} → {a.newStatus}</p>
                    )}
                    {a.notes && <p className="text-[11px] text-muted-foreground">{a.notes}</p>}
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </div>
    </div>
  )
}

function BackLink() {
  return (
    <Link to="/outreach/video/my-videos"
      className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
      <ArrowLeft className="w-4 h-4" /> Back to videos
    </Link>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-muted-foreground shrink-0">{label}</dt>
      <dd className="text-foreground text-right break-words min-w-0">{value}</dd>
    </div>
  )
}

function SubmitButton({ video, onDone }: { video: VideoRecord; onDone: () => Promise<void> }) {
  const [busy, setBusy] = useState(false)
  return (
    <button
      disabled={busy}
      onClick={async () => {
        if (!confirm(`Submit "${video.title}" to the publisher? The caption can't be changed afterwards.`)) return
        setBusy(true)
        try { await submitVideo(video.id); await onDone() }
        catch (err) { toast.error(err instanceof Error ? err.message : 'Could not submit.') }
        finally { setBusy(false) }
      }}
      className="text-xs px-2.5 py-1.5 rounded-lg bg-orange-600 text-white hover:opacity-90 disabled:opacity-40 inline-flex items-center gap-1">
      <Send className="w-3 h-3" /> {busy ? 'Submitting…' : 'Submit'}
    </button>
  )
}

/** §17 — editable while draft, and copyable by the publisher afterwards. */
function CaptionPanel({ video, onDone }: { video: VideoRecord; onDone: () => Promise<void> }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(video.caption)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => { setDraft(video.caption) }, [video.caption])

  async function save() {
    setBusy(true)
    setError(null)
    try {
      await updateCaption(video.id, draft.trim())
      setEditing(false)
      await onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the caption.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="hub-card">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-foreground">Social media caption</h2>
        <div className="flex items-center gap-2">
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
          {video.status === 'draft' && !editing && (
            <button onClick={() => setEditing(true)}
              className="text-xs px-2.5 py-1.5 rounded-lg bg-violet-100 text-violet-700 hover:opacity-80 inline-flex items-center gap-1">
              <Pencil className="w-3 h-3" /> Edit
            </button>
          )}
        </div>
      </div>

      {editing ? (
        <div className="space-y-2">
          <textarea className="hub-input min-h-32" value={draft} onChange={e => setDraft(e.target.value)} />
          {error && <p className="text-xs text-rose-600">{error}</p>}
          <div className="flex justify-end gap-2">
            <button onClick={() => { setEditing(false); setDraft(video.caption) }} disabled={busy}
              className="px-3 py-1.5 rounded-lg border border-border text-xs text-muted-foreground hover:bg-accent">
              Cancel
            </button>
            <button onClick={save} disabled={busy || !draft.trim()}
              className="px-3 py-1.5 rounded-lg bg-orange-600 text-white text-xs font-medium hover:opacity-90 disabled:opacity-40">
              {busy ? 'Saving…' : 'Save caption'}
            </button>
          </div>
        </div>
      ) : (
        <>
          <p className="text-sm text-foreground whitespace-pre-wrap">{video.caption}</p>
          {video.status !== 'draft' && (
            <p className="text-[11px] text-muted-foreground mt-2">
              Captions are locked once a video is submitted — this is what gets posted.
            </p>
          )}
        </>
      )}
    </div>
  )
}
