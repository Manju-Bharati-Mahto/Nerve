/**
 * Client for the Outreach video workflow API.
 *
 * Unlike the rest of the Outreach module there is no in-memory store here: the
 * data lives in Google Drive, reads are comparatively expensive, and the
 * workflow is a queue several people act on at once. Each screen fetches what
 * it needs and refetches after it changes something, which keeps what's on
 * screen honest rather than quietly stale.
 */
const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/$/, '')
const BASE = `${API_BASE_URL}/outreach/video`

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
    ...init,
  })
  const payload = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((payload as { message?: string }).message || 'Request failed.')
  return payload as T
}

// ── Types (mirroring the server records) ───────────────────────────────────

export type VideoStatus = 'draft' | 'submitted' | 'published'
export type VideoRole = 'admin' | 'editor' | 'manager' | 'publisher'
export type LiveUrlPlatform = 'instagram' | 'facebook'

export interface ActivityEntry {
  id: string
  userName: string
  userRole: VideoRole
  action: string
  timestamp: string
  previousStatus?: string | null
  newStatus?: string | null
  notes?: string | null
}

export interface VideoRecord {
  id: string
  /** §9.1 auto-generated name — also the Drive file name. */
  title: string
  /** What the editor typed (§9). */
  editorTitle: string
  client: string
  editorId: string
  caption: string
  status: VideoStatus
  driveFileId: string
  driveFileName: string
  sizeBytes?: number | null
  mimeType?: string | null
  platform?: string | null
  notes?: string | null
  tags?: string[]
  createdAt: string
  updatedAt: string
  submittedAt?: string | null
  publishedBy?: string | null
  publishedAt?: string | null
  liveUrls?: Partial<Record<LiveUrlPlatform, string>>
  activity: ActivityEntry[]
}

export interface WorkflowUser {
  id: string
  name: string
  email: string
  role: VideoRole
  active: boolean
  lastActivityAt?: string | null
}

/** §8.2 — what an editor is allowed to see about a page. */
export interface EditorVisiblePage {
  id: string
  handle: string
  platform: string
  connected: boolean
}

// ── Calls ──────────────────────────────────────────────────────────────────

export const getVideoConfig = () =>
  request<{ configured: boolean; local: boolean; role: VideoRole }>('/config')

export const listVideos = (params: { status?: VideoStatus; client?: string } = {}) => {
  const q = new URLSearchParams()
  if (params.status) q.set('status', params.status)
  if (params.client) q.set('client', params.client)
  const qs = q.toString()
  return request<{ videos: VideoRecord[] }>(`/videos${qs ? `?${qs}` : ''}`)
}

export const getVideo = (id: string) => request<{ video: VideoRecord }>(`/videos/${id}`)

/** Multipart — deliberately not through `request`, which forces a JSON body. */
export async function uploadVideo(form: FormData): Promise<VideoRecord> {
  const res = await fetch(`${BASE}/videos`, { method: 'POST', credentials: 'include', body: form })
  const payload = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((payload as { message?: string }).message || 'Upload failed.')
  return (payload as { video: VideoRecord }).video
}

export const updateCaption = (id: string, caption: string) =>
  request<{ video: VideoRecord }>(`/videos/${id}/caption`, {
    method: 'PATCH', body: JSON.stringify({ caption }),
  }).then(r => r.video)

export const submitVideo = (id: string) =>
  request<{ video: VideoRecord }>(`/videos/${id}/submit`, { method: 'POST' }).then(r => r.video)

export const publishingQueue = () => request<{ videos: VideoRecord[] }>('/queue')

export const publishVideo = (id: string, liveUrls: Partial<Record<LiveUrlPlatform, string>> = {}) =>
  request<{ video: VideoRecord }>(`/videos/${id}/publish`, {
    method: 'POST', body: JSON.stringify({ live_urls: liveUrls }),
  }).then(r => r.video)

export const setLiveUrls = (id: string, liveUrls: Partial<Record<LiveUrlPlatform, string>>) =>
  request<{ video: VideoRecord }>(`/videos/${id}/live-urls`, {
    method: 'PATCH', body: JSON.stringify({ live_urls: liveUrls }),
  }).then(r => r.video)

export const listSocialPages = () =>
  request<{ pages: EditorVisiblePage[]; analytics_visible: boolean }>('/social-pages')

/** Streamed through the API so access is checked on the bytes themselves (§25). */
export const videoStreamUrl = (id: string) => `${BASE}/videos/${id}/stream`
export const videoDownloadUrl = (id: string) => `${BASE}/videos/${id}/download`

// ── Display helpers ────────────────────────────────────────────────────────

export const STATUS_STYLE: Record<VideoStatus, { label: string; cls: string }> = {
  draft:     { label: 'Draft',     cls: 'bg-slate-100 text-slate-700' },
  submitted: { label: 'Submitted', cls: 'bg-amber-100 text-amber-800' },
  published: { label: 'Published', cls: 'bg-emerald-100 text-emerald-700' },
}

export function formatBytes(bytes?: number | null): string {
  if (!bytes) return '—'
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`
  return `${(bytes / 1024).toFixed(0)} KB`
}

export function formatWhen(iso?: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString(undefined, {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

/** Turns "video.caption_updated" into "Caption updated" for the §16 timeline. */
export function describeAction(action: string): string {
  const tail = action.replace(/^video\./, '').replace(/_/g, ' ')
  return tail.charAt(0).toUpperCase() + tail.slice(1)
}
