import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Film, Upload, Send, AlertCircle, Loader2, X, CheckCircle2, CloudOff, RotateCcw,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  getVideoConfig, listVideos, uploadVideo, submitVideo, startRevision,
  listCampaigns, listSocialPages, type Campaign,
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
    uploaded: videos.filter(v => v.status === 'uploaded').length,
    underReview: videos.filter(v => v.status === 'under_review').length,
    published: videos.filter(v => v.status === 'published').length,
    /* §12 Editor — "Rejected". Revision counts here too: both mean the work
       is back with this editor and nobody else is waiting on anything. */
    needsMe: videos.filter(v => v.status === 'rejected' || v.status === 'revision').length,
  }), [videos])

  const shown = useMemo(
    () => filter === 'all' ? videos : videos.filter(v => v.status === filter),
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
        <Kpi label="Uploaded" value={counts.uploaded} onClick={() => setFilter('uploaded')} active={filter === 'uploaded'} />
        <Kpi label="Under review" value={counts.underReview} onClick={() => setFilter('under_review')} active={filter === 'under_review'} />
        <Kpi label="Published" value={counts.published} onClick={() => setFilter('published')} active={filter === 'published'} />
      </div>
      {counts.needsMe > 0 && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <Kpi label="Needs your changes" value={counts.needsMe}
            onClick={() => setFilter('rejected')} active={filter === 'rejected'} />
        </div>
      )}

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
                  {/* §11 — the same act from either side of a rejection. */}
                  {(v.status === 'uploaded' || v.status === 'revision') && (
                    <button onClick={() => handleSubmit(v)}
                      className="text-xs px-2.5 py-1.5 rounded-lg bg-orange-100 text-orange-700 hover:opacity-80 inline-flex items-center gap-1">
                      <Send className="w-3 h-3" /> Submit
                    </button>
                  )}
                  {v.status === 'rejected' && (
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

  useEffect(() => {
    void listCampaigns().then(r => setCampaigns(r.campaigns)).catch(() => setCampaigns([]))
    void listSocialPages().then(r => setPages(r.pages)).catch(() => setPages([]))
  }, [])

  const chosenCampaign = campaigns.find(c => c.id === campaignId) ?? null
  /* Only the pages this campaign posts to (§7/§8). A campaign that names none
     offers all of them rather than nothing, because an empty list reads as a
     broken form rather than as a campaign nobody has configured. */
  const offeredPages = chosenCampaign?.socialPageIds.length
    ? pages.filter(p => chosenCampaign.socialPageIds.includes(p.id))
    : pages

  // §9 required fields — either a chosen campaign or a typed name identifies it.
  const canSubmit = !!file && (campaignId || client.trim()) && title.trim() && caption.trim() && !uploading

  async function submit() {
    if (!canSubmit || !file) return
    setUploading(true)
    setError(null)
    try {
      const form = new FormData()
      form.append('video', file)
      form.append('client', client.trim())
      if (campaignId) form.append('campaignId', campaignId)
      if (pageIds.length) form.append('socialPageIds', pageIds.join(','))
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
                {/* §2 Editor — "Add description/notes". It goes into the video's
                    file in Google Drive, so it is worth writing for a reader. */}
                <label className="hub-label">Description / notes</label>
                <textarea className="hub-input min-h-20" value={notes} onChange={e => setNotes(e.target.value)}
                  placeholder="What this video is, where it was shot, anything the reviewer and publisher should know" />
                <p className="text-[11px] text-muted-foreground mt-1">Saved with the video, and in its file in Google Drive.</p>
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
