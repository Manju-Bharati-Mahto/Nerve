import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Film, Upload, Send, AlertCircle, Loader2, X, CheckCircle2, CloudOff, RotateCcw,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  getVideoConfig, listVideos, uploadVideo, submitVideo, startRevision,
  createUploadSession, completeUpload, cancelUpload, driveProblemOf,
  loadPendingFinish, storePendingFinish, type PendingFinish,
  listCampaigns, listSocialPages, type Campaign,
  STATUS_STYLE, formatBytes, formatWhen,
  type VideoRecord, type VideoStatus, type VideoUploadFields, type DriveErrorCode,
} from '@/lib/outreach-video-data'
import { DirectUploadBlockedError, uploadToDrive } from '@/lib/drive-upload'
import { HttpError } from '@/lib/http'
import { useAuth } from '@/hooks/useAuth'
import DriveProblemNotice from './DriveProblemNotice'
import { mayUploadVideos } from './workflow-roles'

/**
 * §8 — the editor's own work. KPI cards for Total / Draft / Submitted /
 * Published, the list itself, and the §9 upload form.
 *
 * The API scopes an editor to their own videos, so this shows "mine" without
 * having to ask for it; a manager or admin opening the same page sees the
 * department's, which is what §27 gives them under "All Videos".
 */
/**
 * §12's editor groups. Rejected includes Editor Revision, because both mean
 * the work is back with the editor; Approved includes everything that passed
 * review, scheduled and published alike.
 */
type EditorFilter = 'all' | 'under_review' | 'approved' | 'rejected' | 'not_submitted'
const EDITOR_GROUPS: Record<Exclude<EditorFilter, 'all'>, VideoStatus[]> = {
  under_review: ['under_review'],
  approved: ['approved', 'scheduled', 'published'],
  rejected: ['rejected', 'revision'],
  not_submitted: ['uploaded'],
}

export default function VideoMyVideos() {
  /* A Manager reaches this page as the department's list, and a tab grant
     can open it to anyone — but only Editors and Admins may upload, submit
     or start a revision (the API refuses everyone else). Offering those to
     a Manager meant filling in the whole upload form to be told "Your role
     cannot perform that action." */
  const { role } = useAuth()
  const canUpload = mayUploadVideos(role)
  const [videos, setVideos] = useState<VideoRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<{ message: string; code: DriveErrorCode | null } | null>(null)
  const [driveReady, setDriveReady] = useState<boolean | null>(null)
  /* Whether this Drive can take a file straight from the browser. Learned
     from the config; the upload dialog still falls back on its own if the
     browser turns out not to be able to reach Google. */
  const [directUpload, setDirectUpload] = useState(false)
  const [uploading, setUploading] = useState(false)
  /* A filter is one of §12's groups rather than a raw status: "Approved" to
     an editor means it passed review, whatever happened next. */
  const [filter, setFilter] = useState<EditorFilter>('all')

  const refresh = useCallback(async () => {
    try {
      const { videos } = await listVideos()
      setVideos(videos)
      setError(null)
    } catch (err) {
      setError({ message: err instanceof Error ? err.message : 'Could not load videos.', code: driveProblemOf(err) })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    getVideoConfig()
      .then(c => { setDriveReady(c.configured); setDirectUpload(c.directUpload === true) })
      .catch(() => setDriveReady(false))
    void refresh()
  }, [refresh])

  /* §12 Editor — "My Uploads, Under Review, Approved, Rejected". */
  const counts = useMemo(() => ({
    total: videos.length,
    underReview: videos.filter(v => EDITOR_GROUPS.under_review.includes(v.status)).length,
    approved: videos.filter(v => EDITOR_GROUPS.approved.includes(v.status)).length,
    rejected: videos.filter(v => EDITOR_GROUPS.rejected.includes(v.status)).length,
    notSubmitted: videos.filter(v => EDITOR_GROUPS.not_submitted.includes(v.status)).length,
  }), [videos])

  /* Counted from a list that was never read, the tiles would say "0 My
     uploads" over a notice saying the list could not be read. */
  const known = !loading && !error

  const shown = useMemo(
    () => filter === 'all' ? videos : videos.filter(v => EDITOR_GROUPS[filter].includes(v.status)),
    [videos, filter],
  )

  async function handleSubmit(video: VideoRecord) {
    if (!confirm(`Send "${video.title}" for review? The caption can't be changed while it is being reviewed.`)) return
    try {
      await submitVideo(video.id)
      await refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not submit.')
    }
  }

  /** §11 — picking rejected work back up, which reopens the caption. */
  async function handleRevise(video: VideoRecord) {
    try {
      await startRevision(video.id)
      await refresh()
      toast.success('Reopened for changes.')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not reopen that video.')
    }
  }

  return (
    <div className="animate-fade-in space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-orange-100 flex items-center justify-center">
            <Film className="w-5 h-5 text-orange-600" />
          </div>
          <div>
            <h1 className="text-2xl font-serif text-foreground">My Videos</h1>
            <p className="text-sm text-muted-foreground">
              Upload a cut, write its caption, then submit it for publishing.
            </p>
          </div>
        </div>
        {canUpload && (
          <UploadButton disabled={driveReady === false || uploading} onUploaded={refresh}
            directUpload={directUpload} uploading={uploading} setUploading={setUploading} />
        )}
      </div>

      {/* When the list itself failed for a Drive reason, DriveProblemNotice
          below already says what is wrong and who fixes it; a second banner
          with different advice only contradicts it. */}
      {canUpload && driveReady === false && !error?.code && (
        <div className="hub-card bg-amber-50 border-amber-200 flex items-start gap-2 text-sm text-amber-900">
          <CloudOff className="w-4 h-4 mt-0.5 shrink-0" />
          <span>
            Google Drive isn't connected yet, so uploads are unavailable. An outreach Admin or
            Manager can connect it under Video Workflow → Google Drive.
          </span>
        </div>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Kpi label="My uploads" value={known ? counts.total : null} onClick={() => setFilter('all')} active={filter === 'all'} />
        <Kpi label="Under review" value={known ? counts.underReview : null} onClick={() => setFilter('under_review')} active={filter === 'under_review'} />
        <Kpi label="Approved" value={known ? counts.approved : null} onClick={() => setFilter('approved')} active={filter === 'approved'} />
        <Kpi label="Rejected" value={known ? counts.rejected : null} onClick={() => setFilter('rejected')} active={filter === 'rejected'} />
      </div>
      {known && counts.notSubmitted > 0 && (
        <button onClick={() => setFilter('not_submitted')}
          className="text-[12px] text-amber-700 hover:underline">
          {counts.notSubmitted} video{counts.notSubmitted === 1 ? ' has' : 's have'} not been sent for review yet.
        </button>
      )}

      {error && <DriveProblemNotice message={error.message} code={error.code} />}

      <div className="hub-card p-0 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-widest text-muted-foreground border-b border-border">
              <th className="px-3 py-2">Video</th>
              <th className="px-3 py-2">Client / Project</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Uploaded</th>
              <th className="px-3 py-2 text-right">Size</th>
              <th className="px-3 py-2 w-24"></th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={6} className="px-3 py-12 text-center text-sm text-muted-foreground">Loading…</td></tr>
            ) : shown.length === 0 ? (
              <tr><td colSpan={6} className="px-3 py-12 text-center text-sm text-muted-foreground">
                {error && videos.length === 0
                  ? 'The videos could not be loaded — see the message above.'
                  : videos.length === 0
                    ? (canUpload ? 'No videos yet — upload your first cut.' : 'No videos yet.')
                    : 'No videos with that status.'}
              </td></tr>
            ) : shown.map(v => (
              <tr key={v.id} className="border-b border-border last:border-0 hover:bg-accent/40">
                <td className="px-3 py-2.5">
                  <Link to={`/outreach/video/videos/${v.id}`} className="text-xs font-medium text-foreground hover:underline">
                    {v.title}
                  </Link>
                  {v.editorTitle && v.editorTitle !== v.title && (
                    <div className="text-[11px] text-muted-foreground truncate max-w-[280px]">{v.editorTitle}</div>
                  )}
                </td>
                <td className="px-3 py-2.5 text-xs text-muted-foreground">{v.client}</td>
                <td className="px-3 py-2.5">
                  <span className={`hub-badge ${STATUS_STYLE[v.status].cls}`}>{STATUS_STYLE[v.status].label}</span>
                </td>
                <td className="px-3 py-2.5 text-xs text-muted-foreground">{formatWhen(v.createdAt)}</td>
                <td className="px-3 py-2.5 text-right text-xs font-mono tabular-nums text-muted-foreground">
                  {formatBytes(v.sizeBytes)}
                </td>
                <td className="px-3 py-2.5 text-right">
                  {/* §11 — the same act from either side of a rejection. */}
                  {canUpload && (v.status === 'uploaded' || v.status === 'revision') && (
                    <button onClick={() => handleSubmit(v)}
                      className="text-xs px-2.5 py-1.5 rounded-lg bg-orange-100 text-orange-700 hover:opacity-80 inline-flex items-center gap-1">
                      <Send className="w-3 h-3" /> Submit
                    </button>
                  )}
                  {canUpload && v.status === 'rejected' && (
                    <button onClick={() => handleRevise(v)}
                      className="text-xs px-2.5 py-1.5 rounded-lg bg-rose-100 text-rose-700 hover:opacity-80 inline-flex items-center gap-1">
                      <RotateCcw className="w-3 h-3" /> Start revision
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/** `null` is "not known": a dash, never a zero. */
function Kpi({ label, value, onClick, active }: { label: string; value: number | null; onClick: () => void; active: boolean }) {
  return (
    <button onClick={onClick}
      className={`hub-card text-left py-3 transition-colors ${active ? 'ring-2 ring-orange-400' : 'hover:bg-accent/40'}`}>
      <div className="text-2xl font-serif text-foreground leading-none">{value ?? '—'}</div>
      <div className="text-[11px] text-muted-foreground mt-1">{label}</div>
    </button>
  )
}

// ── §9 Upload ──────────────────────────────────────────────────────────────

/* The video types the server accepts, by extension and by type. Checked here
   first so a wrong file is refused in a second rather than after minutes of
   uploading. Both, because browsers report no type at all for .mkv or .mts,
   and the extension is then the only thing to go on. */
const VIDEO_TYPES: Record<string, string> = {
  mp4: 'video/mp4', mov: 'video/quicktime', m4v: 'video/x-m4v', webm: 'video/webm',
  avi: 'video/x-msvideo', mpeg: 'video/mpeg', mpg: 'video/mpeg', mkv: 'video/x-matroska',
  '3gp': 'video/3gpp', mts: 'video/mp2t', m2ts: 'video/mp2t',
}
const VIDEO_MIME_TYPES = new Set(Object.values(VIDEO_TYPES))
/** The server's limit, for both upload paths. */
const MAX_VIDEO_BYTES = 2 * 1024 ** 3
const ACCEPT = ['video/*', ...Object.keys(VIDEO_TYPES).map(ext => `.${ext}`)].join(',')

/** The type to upload the file as, or null when it is not a video the workflow takes. */
function videoMimeType(file: File): string | null {
  if (VIDEO_MIME_TYPES.has(file.type)) return file.type
  const dot = file.name.lastIndexOf('.')
  const ext = dot >= 0 ? file.name.slice(dot + 1).toLowerCase() : ''
  return VIDEO_TYPES[ext] ?? null
}

function checkVideoFile(file: File): string | null {
  if (!videoMimeType(file)) {
    return `"${file.name}" is not a video type the workflow accepts. Use MP4, MOV, M4V, WEBM, AVI, MPEG, MKV, 3GP or MTS.`
  }
  if (file.size === 0) return `"${file.name}" is empty.`
  if (file.size > MAX_VIDEO_BYTES) {
    return `"${file.name}" is ${formatBytes(file.size)}; the limit is 2 GB. Export a smaller file and try again.`
  }
  return null
}

const isAbort = (err: unknown) => err instanceof DOMException && err.name === 'AbortError'

/** Where an upload has got to, for the progress line. */
type Phase =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'drive' | 'nerve'; sent: number; total: number }
  | { kind: 'finishing' }

function UploadButton({ disabled, directUpload, uploading, setUploading, onUploaded }: {
  disabled: boolean
  directUpload: boolean
  uploading: boolean
  setUploading: (v: boolean) => void
  onUploaded: () => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button onClick={() => setOpen(true)} disabled={disabled}
        className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium bg-orange-600 text-white hover:opacity-90 disabled:opacity-40">
        <Upload className="w-4 h-4" /> Upload video
      </button>
      {open && (
        <UploadDialog
          directUpload={directUpload}
          uploading={uploading}
          setUploading={setUploading}
          onClose={() => setOpen(false)}
          onDone={async () => { await onUploaded() }}
        />
      )}
    </>
  )
}

/**
 * The §9 upload. The file goes from this browser straight into the
 * campaign's Google Drive folder — Nerve only opens the upload and, once
 * Google has every byte, records the video and writes its description and
 * remarks onto the Drive file. Nothing of the video is stored in Nerve.
 *
 * Two fallbacks, both through Nerve's multipart upload: a Drive that cannot
 * take direct uploads (the local development folder), and a browser that
 * cannot reach Google at all — which is how a Content-Security-Policy that
 * does not list googleapis.com shows up.
 */
function UploadDialog({ onClose, onDone, directUpload, uploading, setUploading }: {
  onClose: () => void
  onDone: () => Promise<void>
  directUpload: boolean
  uploading: boolean
  setUploading: (v: boolean) => void
}) {
  const [file, setFile] = useState<File | null>(null)
  const [client, setClient] = useState('')
  /* §3 — the campaign and the pages it posts to. Campaigns are records now
     (§17), so this is a choice rather than typing a name; the free-text box
     below stays for work that belongs to no campaign. */
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [campaignId, setCampaignId] = useState('')
  const [pageIds, setPageIds] = useState<string[]>([])
  const [pages, setPages] = useState<Array<{ id: string; handle: string; platform: string }>>([])
  const [title, setTitle] = useState('')
  const [caption, setCaption] = useState('')
  const [platform, setPlatform] = useState('')
  const [notes, setNotes] = useState('')
  const [tags, setTags] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  /* Set when the browser could not reach Google and the file went through
     Nerve instead, so the progress line says where it is really going. */
  const [viaNerve, setViaNerve] = useState(false)
  const { user } = useAuth()
  const userId = user?.id ?? null
  /* The file reached Drive but recording it failed. Trying again then only
     finishes the record — the server keeps the session for a day and
     answers a repeat with the same video — instead of uploading 2 GB again.
     Remembered per user in sessionStorage, so reopening the dialog offers it. */
  const [pendingFinish, setPendingFinishState] = useState<PendingFinish | null>(() => loadPendingFinish(userId))
  const setPendingFinish = (pending: PendingFinish | null) => {
    setPendingFinishState(pending)
    storePendingFinish(userId, pending)
  }
  const abortRef = useRef<AbortController | null>(null)
  /** The Drive session the bytes are going to, until they have all arrived. */
  const sessionRef = useRef<string | null>(null)

  useEffect(() => {
    void listCampaigns().then(r => setCampaigns(r.campaigns)).catch(() => setCampaigns([]))
    void listSocialPages().then(r => setPages(r.pages)).catch(() => setPages([]))
  }, [])

  /* Leaving the page mid-upload abandons it, so the browser asks first; and
     if the dialog goes away regardless (navigating inside the app), the
     upload is stopped rather than left running with nobody to finish it. */
  useEffect(() => {
    if (!uploading) return
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault() }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [uploading])
  useEffect(() => () => abortRef.current?.abort(), [])

  const chosenCampaign = campaigns.find(c => c.id === campaignId) ?? null
  /* Only the pages this campaign posts to (§7/§8). A campaign that names none
     offers all of them rather than nothing, because an empty list reads as a
     broken form rather than as a campaign nobody has configured. */
  const offeredPages = chosenCampaign?.socialPageIds.length
    ? pages.filter(p => chosenCampaign.socialPageIds.includes(p.id))
    : pages

  /* §9 required fields — either a chosen campaign or a typed name identifies
     it. Finishing a file already in Drive needs none of them: they went with
     it, and after a reopen the form is empty anyway. */
  const canSubmit = !uploading
    && (!!pendingFinish || (!!file && !!(campaignId || client.trim()) && !!title.trim() && !!caption.trim()))
  const fileProblem = file ? checkVideoFile(file) : null

  function onPickFile(picked: File | null) {
    setFile(picked)
    setError(null)
  }

  /** Bytes straight to Drive. Null when the browser cannot reach Google, so the caller falls back. */
  async function sendDirect(
    session: { sessionId: string; uploadUrl: string; chunkBytes: number }, chosen: File, signal: AbortSignal,
  ): Promise<VideoRecord | null> {
    sessionRef.current = session.sessionId
    setPhase({ kind: 'drive', sent: 0, total: chosen.size })
    let fileId: string
    try {
      fileId = await uploadToDrive({
        file: chosen,
        uploadUrl: session.uploadUrl,
        chunkBytes: session.chunkBytes,
        signal,
        onProgress: (sent, total) => setPhase({ kind: 'drive', sent, total }),
      })
    } catch (err) {
      if (!(err instanceof DirectUploadBlockedError)) throw err
      sessionRef.current = null
      void cancelUpload(session.sessionId).catch(() => { /* it expires on its own */ })
      return null
    }
    sessionRef.current = null
    setPendingFinish({ sessionId: session.sessionId, fileId, title: title.trim() })
    setPhase({ kind: 'finishing' })
    return completeUpload(session.sessionId, fileId)
  }

  /** The fallback: multipart through Nerve, which passes the file on to Drive. */
  function sendThroughNerve(fields: VideoUploadFields, chosen: File, mimeType: string, signal: AbortSignal) {
    const form = new FormData()
    /* Re-typed when the browser left the type blank (.mkv, .mts), so the
       server's type check sees a video. A File over the same bytes — nothing
       is copied. */
    form.append('video', chosen.type === mimeType ? chosen : new File([chosen], chosen.name, { type: mimeType }))
    form.append('client', fields.client)
    if (fields.campaignId) form.append('campaignId', fields.campaignId)
    if (fields.socialPageIds.length) form.append('socialPageIds', fields.socialPageIds.join(','))
    form.append('title', fields.title)
    form.append('caption', fields.caption)
    if (fields.platform) form.append('platform', fields.platform)
    if (fields.notes) form.append('notes', fields.notes)
    if (fields.tags.length) form.append('tags', fields.tags.join(','))
    setPhase({ kind: 'nerve', sent: 0, total: chosen.size })
    return uploadVideo(form, (sent, total) => setPhase({ kind: 'nerve', sent, total }), signal)
  }

  async function submit() {
    if (!canSubmit) return
    if (pendingFinish) return finishPending(pendingFinish)
    if (!file) return
    const problem = checkVideoFile(file)
    const mimeType = videoMimeType(file)
    if (problem || !mimeType) { setError(problem); return }

    const fields: VideoUploadFields = {
      client: client.trim(),
      campaignId: campaignId || null,
      socialPageIds: pageIds,
      title: title.trim(),
      caption: caption.trim(),
      platform: platform.trim() || null,
      notes: notes.trim() || null,
      tags: tags.split(',').map(t => t.trim()).filter(Boolean),
    }
    const controller = new AbortController()
    abortRef.current = controller
    setUploading(true)
    setError(null)
    try {
      let video: VideoRecord | null = null
      if (directUpload && !viaNerve) {
        setPhase({ kind: 'starting' })
        const session = await createUploadSession({
          ...fields, fileName: file.name, mimeType, sizeBytes: file.size,
        })
        if (session.mode === 'direct') {
          video = await sendDirect(session, file, controller.signal)
          if (!video) setViaNerve(true)
        }
      }
      if (!video) video = await sendThroughNerve(fields, file, mimeType, controller.signal)
      setPendingFinish(null)
      // §9.1 — the name is assigned by the system, so show the editor what it
      // actually became rather than leaving them to guess.
      setSaved(video.title)
      await onDone()
    } catch (err) {
      /* A half-sent Drive upload is let go of, so the server is not left
         holding a session nobody will finish. */
      const openSession = sessionRef.current
      sessionRef.current = null
      if (openSession) void cancelUpload(openSession).catch(() => { /* it expires on its own */ })
      dropPendingIfFinal(err)
      setError(isAbort(err)
        ? 'Upload cancelled. Nothing was saved.'
        : err instanceof Error ? err.message : 'Upload failed.')
    } finally {
      abortRef.current = null
      setPhase({ kind: 'idle' })
      setUploading(false)
    }
  }

  /** "Finish saving": record a file that is already in Drive, without sending it again. */
  async function finishPending(pending: PendingFinish) {
    setUploading(true)
    setError(null)
    setPhase({ kind: 'finishing' })
    try {
      const video = await completeUpload(pending.sessionId, pending.fileId)
      setPendingFinish(null)
      setSaved(video.title)
      await onDone()
    } catch (err) {
      dropPendingIfFinal(err)
      setError(err instanceof Error ? err.message : 'Could not finish saving.')
    } finally {
      setPhase({ kind: 'idle' })
      setUploading(false)
    }
  }

  /* A file already in Drive is kept for "Finish saving" only while trying
     again can help — a dropped connection, a Drive hiccup. When the server
     says no outright (the session expired, the size did not match) the way
     forward is a fresh upload. */
  function dropPendingIfFinal(err: unknown) {
    if (err instanceof HttpError && err.status >= 400 && err.status < 500
      && ![401, 408, 429].includes(err.status)) {
      setPendingFinish(null)
    }
  }

  /* Stopping is allowed while bytes are moving; not once every byte has been
     sent (the server or Google may already have the whole file, so "Nothing
     was saved" would be untrue), nor while the record is being written. */
  const finishing = phase.kind === 'finishing'
    || ((phase.kind === 'nerve' || phase.kind === 'drive') && phase.total > 0 && phase.sent >= phase.total)

  /* Closing with a file in Drive but not in the workflow leaves it for later
     (it is remembered for "Finish saving"), but only once the editor has
     said so. */
  function close() {
    if (pendingFinish && !saved
      && !confirm('The video is already in Google Drive but not saved in the workflow yet. Close anyway?')) return
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4 animate-fade-in">
      <div className="bg-card rounded-xl border border-border w-full max-w-lg max-h-[90vh] flex flex-col">
        <div className="flex items-start justify-between p-4 border-b border-border">
          <div>
            <h2 className="text-base font-serif text-foreground">Upload video</h2>
            <p className="text-xs text-muted-foreground">
              {directUpload
                ? 'The file goes straight from your computer to the campaign\'s Google Drive folder and is named automatically.'
                : 'The file is stored in the campaign\'s Google Drive folder and named automatically.'}
              {' '}Its caption, description and remarks are saved with the file in Drive.
            </p>
          </div>
          <button onClick={close} disabled={uploading} aria-label="Close"
            className="p-2 rounded-lg hover:bg-accent text-muted-foreground disabled:opacity-40">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {saved ? (
            <div className="hub-card bg-emerald-50 border-emerald-200 flex items-start gap-2 text-sm text-emerald-900">
              <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />
              <span>Saved to Drive as <strong>{saved}</strong>. It's a draft — you can still edit the caption before submitting.</span>
            </div>
          ) : (
            /* Locked while uploading, and once the file is in Drive: the
               details were sent with it, so editing them now would be a
               change that silently did not apply. */
            <fieldset disabled={uploading || !!pendingFinish} className="space-y-3 disabled:opacity-70">
              <div>
                <label className="hub-label">Video file *</label>
                <input type="file" accept={ACCEPT} className="hub-input"
                  onChange={e => onPickFile(e.target.files?.[0] ?? null)} />
                {file && (
                  <p className={`text-[11px] mt-1 ${fileProblem ? 'text-rose-600' : 'text-muted-foreground'}`}>
                    {fileProblem ?? `${formatBytes(file.size)} · up to 2 GB`}
                  </p>
                )}
              </div>
              <div>
                <label className="hub-label">Campaign *</label>
                <select className="hub-input" value={campaignId}
                  onChange={e => { setCampaignId(e.target.value); setPageIds([]) }}>
                  <option value="">— pick a campaign —</option>
                  {campaigns.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
                <p className="text-[11px] text-muted-foreground mt-1">
                  The campaign decides where the file is filed in Drive and what it is called.
                </p>
              </div>
              {!campaignId && (
                <div>
                  <label className="hub-label">…or type a client / project *</label>
                  <input className="hub-input" value={client} onChange={e => setClient(e.target.value)}
                    placeholder="Diwali Campaign" />
                  <p className="text-[11px] text-muted-foreground mt-1">
                    For work that belongs to no campaign. Its Drive folder is created if it doesn't exist.
                  </p>
                </div>
              )}
              {offeredPages.length > 0 && (
                <div>
                  <label className="hub-label">Social media page(s)</label>
                  <div className="space-y-1 max-h-32 overflow-y-auto pr-1 mt-1">
                    {offeredPages.map(pg => (
                      <label key={pg.id}
                        className="flex items-center gap-2 px-2 py-1.5 rounded-lg border border-border cursor-pointer hover:bg-accent/40">
                        <input type="checkbox" checked={pageIds.includes(pg.id)}
                          onChange={() => setPageIds(cur =>
                            cur.includes(pg.id) ? cur.filter(x => x !== pg.id) : [...cur, pg.id])} />
                        <span className="text-xs text-foreground">{pg.handle}</span>
                        <span className="text-[11px] text-muted-foreground">{pg.platform}</span>
                      </label>
                    ))}
                  </div>
                  <p className="text-[11px] text-muted-foreground mt-1">
                    Named in the caption file that goes to Drive alongside the video.
                  </p>
                </div>
              )}
              <div>
                <label className="hub-label">Video title *</label>
                <input className="hub-input" value={title} onChange={e => setTitle(e.target.value)}
                  placeholder="Diwali teaser cut 3" />
              </div>
              <div>
                <label className="hub-label">Social media caption *</label>
                <textarea className="hub-input min-h-24" value={caption} onChange={e => setCaption(e.target.value)}
                  placeholder="The caption the publisher will post with this video." />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="hub-label">Platform</label>
                  <select className="hub-input" value={platform} onChange={e => setPlatform(e.target.value)}>
                    <option value="">—</option>
                    <option value="instagram">Instagram</option>
                    <option value="facebook">Facebook</option>
                    <option value="both">Both</option>
                  </select>
                </div>
                <div>
                  <label className="hub-label">Tags</label>
                  <input className="hub-input" value={tags} onChange={e => setTags(e.target.value)}
                    placeholder="teaser, festive" />
                </div>
              </div>
              <div>
                {/* §2 Editor — "Add description/notes". It is written onto the
                    video's own file in Google Drive, so it is worth writing for
                    a reader. */}
                <label className="hub-label">Description / remarks</label>
                <textarea className="hub-input min-h-20" value={notes} onChange={e => setNotes(e.target.value)}
                  placeholder="What this video is, where it was shot, anything the reviewer and publisher should know" />
                <p className="text-[11px] text-muted-foreground mt-1">
                  Saved as the description of the video file in Google Drive, and in its caption file there.
                </p>
              </div>
            </fieldset>
          )}

          {phase.kind !== 'idle' && <UploadProgress phase={phase} viaNerve={viaNerve} />}

          {pendingFinish && !uploading && !saved && (
            <p className="text-[11px] text-muted-foreground">
              {pendingFinish.title ? <>“{pendingFinish.title}” is</> : 'The file is'} already in Google Drive.
              {' '}<b>Finish saving</b> records it without uploading it again.
              {' '}<button type="button" className="underline hover:text-foreground"
                onClick={() => {
                  if (confirm('Forget this file and start a new upload? It stays in Google Drive but will not be in the workflow.')) {
                    setPendingFinish(null)
                    setError(null)
                  }
                }}>
                Start a new upload instead
              </button>
            </p>
          )}

          {error && (
            <div className="hub-card bg-rose-50 border-rose-200 flex items-start gap-2 text-xs text-rose-900">
              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" /> <span>{error}</span>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 p-4 border-t border-border">
          {uploading ? (
            <button onClick={() => abortRef.current?.abort()} disabled={finishing}
              className="px-4 py-2 rounded-lg border border-rose-200 text-sm text-rose-600 hover:bg-rose-50 disabled:opacity-40">
              Cancel upload
            </button>
          ) : (
            <button onClick={close}
              className="px-4 py-2 rounded-lg border border-border text-sm text-muted-foreground hover:bg-accent">
              {saved ? 'Done' : 'Close'}
            </button>
          )}
          {!saved && (
            <button onClick={submit} disabled={!canSubmit || !!fileProblem}
              className="px-4 py-2 rounded-lg bg-orange-600 text-white text-sm font-medium hover:opacity-90 disabled:opacity-40 inline-flex items-center gap-2">
              {uploading && <Loader2 className="w-4 h-4 animate-spin" />}
              {uploading ? 'Uploading…' : pendingFinish ? 'Finish saving' : 'Upload'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function UploadProgress({ phase, viaNerve }: { phase: Phase; viaNerve: boolean }) {
  let label: string
  let pct: number | null = null
  let detail: string | null = null
  if (phase.kind === 'drive' || phase.kind === 'nerve') {
    pct = phase.total ? Math.min(100, Math.floor((phase.sent / phase.total) * 100)) : 0
    detail = `${pct}% · ${phase.sent ? formatBytes(phase.sent) : '0 MB'} of ${formatBytes(phase.total)}`
    /* Through Nerve, the bar reaching the end only means Nerve has the file;
       it still has to pass it on to Drive, which is a wait with no bar. */
    if (phase.kind === 'nerve' && phase.sent >= phase.total) {
      label = 'Sending to Google Drive…'
      pct = null
      detail = null
    } else {
      label = phase.kind === 'drive' ? 'Uploading to Google Drive…' : 'Uploading…'
    }
  } else if (phase.kind === 'starting') {
    label = 'Preparing the Google Drive upload…'
  } else {
    label = 'Saving the details and remarks in Google Drive…'
  }

  return (
    <div className="hub-card bg-orange-50 border-orange-200 space-y-2" role="status" aria-live="polite">
      <div className="flex items-center justify-between gap-2 text-xs text-orange-900">
        <span className="inline-flex items-center gap-1.5">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> {label}
        </span>
        {detail && <span className="font-mono tabular-nums">{detail}</span>}
      </div>
      <div className="h-2 rounded-full bg-orange-100 overflow-hidden">
        {pct === null
          ? <div className="h-full w-1/3 bg-orange-400 animate-pulse rounded-full" />
          : <div className="h-full bg-orange-500 transition-[width] duration-300" style={{ width: `${pct}%` }} />}
      </div>
      {viaNerve && phase.kind === 'nerve' && (
        <p className="text-[11px] text-orange-900/80">
          This browser could not reach Google Drive directly, so the file is going through Nerve on its way there.
        </p>
      )}
    </div>
  )
}
