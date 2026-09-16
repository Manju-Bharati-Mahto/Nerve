import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Film, Upload, Send, AlertCircle, Loader2, X, CheckCircle2, CloudOff,
} from 'lucide-react'
import {
  getVideoConfig, listVideos, uploadVideo, submitVideo,
  STATUS_STYLE, formatBytes, formatWhen,
  type VideoRecord, type VideoStatus,
} from '@/lib/outreach-video-data'

/**
 * §8 — the editor's own work. KPI cards for Total / Draft / Submitted /
 * Published, the list itself, and the §9 upload form.
 *
 * The API scopes an editor to their own videos, so this shows "mine" without
 * having to ask for it; a manager or admin opening the same page sees the
 * department's, which is what §27 gives them under "All Videos".
 */
export default function VideoMyVideos() {
  const [videos, setVideos] = useState<VideoRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [driveReady, setDriveReady] = useState<boolean | null>(null)
  const [uploading, setUploading] = useState(false)
  const [filter, setFilter] = useState<VideoStatus | 'all'>('all')

  const refresh = useCallback(async () => {
    try {
      const { videos } = await listVideos()
      setVideos(videos)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load videos.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    getVideoConfig()
      .then(c => setDriveReady(c.configured))
      .catch(() => setDriveReady(false))
    void refresh()
  }, [refresh])

  const counts = useMemo(() => ({
    total: videos.length,
    draft: videos.filter(v => v.status === 'draft').length,
    submitted: videos.filter(v => v.status === 'submitted').length,
    published: videos.filter(v => v.status === 'published').length,
  }), [videos])

  const shown = useMemo(
    () => filter === 'all' ? videos : videos.filter(v => v.status === filter),
    [videos, filter],
  )

  async function handleSubmit(video: VideoRecord) {
    if (!confirm(`Submit "${video.title}" to the publisher? The caption can't be changed afterwards.`)) return
    try {
      await submitVideo(video.id)
      await refresh()
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Could not submit.')
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
        <UploadButton disabled={driveReady === false || uploading} onUploaded={refresh}
          uploading={uploading} setUploading={setUploading} />
      </div>

      {driveReady === false && (
        <div className="hub-card bg-amber-50 border-amber-200 flex items-start gap-2 text-sm text-amber-900">
          <CloudOff className="w-4 h-4 mt-0.5 shrink-0" />
          <span>
            Google Drive isn't connected yet, so uploads are unavailable. An administrator
            needs to finish the Drive setup before this workflow can be used.
          </span>
        </div>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Kpi label="Total videos" value={counts.total} onClick={() => setFilter('all')} active={filter === 'all'} />
        <Kpi label="Draft" value={counts.draft} onClick={() => setFilter('draft')} active={filter === 'draft'} />
        <Kpi label="Submitted" value={counts.submitted} onClick={() => setFilter('submitted')} active={filter === 'submitted'} />
        <Kpi label="Published" value={counts.published} onClick={() => setFilter('published')} active={filter === 'published'} />
      </div>

      {error && (
        <div className="hub-card bg-rose-50 border-rose-200 flex items-start gap-2 text-sm text-rose-900">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" /> <span>{error}</span>
        </div>
      )}

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
                {videos.length === 0 ? 'No videos yet — upload your first cut.' : 'No videos with that status.'}
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
                  {v.status === 'draft' && (
                    <button onClick={() => handleSubmit(v)}
                      className="text-xs px-2.5 py-1.5 rounded-lg bg-orange-100 text-orange-700 hover:opacity-80 inline-flex items-center gap-1">
                      <Send className="w-3 h-3" /> Submit
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

function Kpi({ label, value, onClick, active }: { label: string; value: number; onClick: () => void; active: boolean }) {
  return (
    <button onClick={onClick}
      className={`hub-card text-left py-3 transition-colors ${active ? 'ring-2 ring-orange-400' : 'hover:bg-accent/40'}`}>
      <div className="text-2xl font-serif text-foreground leading-none">{value}</div>
      <div className="text-[11px] text-muted-foreground mt-1">{label}</div>
    </button>
  )
}

// ── §9 Upload ──────────────────────────────────────────────────────────────

function UploadButton({ disabled, uploading, setUploading, onUploaded }: {
  disabled: boolean
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
          uploading={uploading}
          setUploading={setUploading}
          onClose={() => setOpen(false)}
          onDone={async () => { await onUploaded() }}
        />
      )}
    </>
  )
}

function UploadDialog({ onClose, onDone, uploading, setUploading }: {
  onClose: () => void
  onDone: () => Promise<void>
  uploading: boolean
  setUploading: (v: boolean) => void
}) {
  const [file, setFile] = useState<File | null>(null)
  const [client, setClient] = useState('')
  const [title, setTitle] = useState('')
  const [caption, setCaption] = useState('')
  const [platform, setPlatform] = useState('')
  const [notes, setNotes] = useState('')
  const [tags, setTags] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)

  // §9 required fields — the optional ones below are genuinely optional.
  const canSubmit = !!file && client.trim() && title.trim() && caption.trim() && !uploading

  async function submit() {
    if (!canSubmit || !file) return
    setUploading(true)
    setError(null)
    try {
      const form = new FormData()
      form.append('video', file)
      form.append('client', client.trim())
      form.append('title', title.trim())
      form.append('caption', caption.trim())
      if (platform.trim()) form.append('platform', platform.trim())
      if (notes.trim()) form.append('notes', notes.trim())
      if (tags.trim()) form.append('tags', tags.trim())
      const video = await uploadVideo(form)
      // §9.1 — the name is assigned by the system, so show the editor what it
      // actually became rather than leaving them to guess.
      setSaved(video.title)
      await onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed.')
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4 animate-fade-in">
      <div className="bg-card rounded-xl border border-border w-full max-w-lg max-h-[90vh] flex flex-col">
        <div className="flex items-start justify-between p-4 border-b border-border">
          <div>
            <h2 className="text-base font-serif text-foreground">Upload video</h2>
            <p className="text-xs text-muted-foreground">
              The file is stored in the campaign's Google Drive folder and named automatically.
            </p>
          </div>
          <button onClick={onClose} disabled={uploading}
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
            <>
              <div>
                <label className="hub-label">Video file *</label>
                <input type="file" accept="video/*" className="hub-input"
                  onChange={e => setFile(e.target.files?.[0] ?? null)} />
                {file && <p className="text-[11px] text-muted-foreground mt-1">{formatBytes(file.size)}</p>}
              </div>
              <div>
                <label className="hub-label">Client / project *</label>
                <input className="hub-input" value={client} onChange={e => setClient(e.target.value)}
                  placeholder="Diwali Campaign" />
                <p className="text-[11px] text-muted-foreground mt-1">
                  Its Drive folder is created automatically if it doesn't exist.
                </p>
              </div>
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
                <label className="hub-label">Notes</label>
                <textarea className="hub-input" value={notes} onChange={e => setNotes(e.target.value)} />
              </div>
            </>
          )}

          {error && (
            <div className="hub-card bg-rose-50 border-rose-200 flex items-start gap-2 text-xs text-rose-900">
              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" /> <span>{error}</span>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 p-4 border-t border-border">
          <button onClick={onClose} disabled={uploading}
            className="px-4 py-2 rounded-lg border border-border text-sm text-muted-foreground hover:bg-accent disabled:opacity-40">
            {saved ? 'Done' : 'Cancel'}
          </button>
          {!saved && (
            <button onClick={submit} disabled={!canSubmit}
              className="px-4 py-2 rounded-lg bg-orange-600 text-white text-sm font-medium hover:opacity-90 disabled:opacity-40 inline-flex items-center gap-2">
              {uploading && <Loader2 className="w-4 h-4 animate-spin" />}
              {uploading ? 'Uploading to Drive…' : 'Upload'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
