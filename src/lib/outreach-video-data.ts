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

/** §11 — Uploaded → Under Review → Approved → Scheduled → Published,
    with Rejected → Editor Revision → Under Review as the loop back. */
export type VideoStatus =
  | 'uploaded' | 'under_review' | 'approved' | 'scheduled' | 'published'
  | 'rejected' | 'revision'

/** How each status is written for a person, in the PRD's own words. */
export const VIDEO_STATUS_LABEL: Record<VideoStatus, string> = {
  uploaded: 'Uploaded',
  under_review: 'Under Review',
  approved: 'Approved',
  scheduled: 'Scheduled',
  published: 'Published',
  rejected: 'Rejected',
  revision: 'Editor Revision',
}

/** The order the statuses are worked through, for filters and counts. */
export const VIDEO_STATUS_ORDER: VideoStatus[] = [
  'uploaded', 'under_review', 'approved', 'scheduled', 'published', 'rejected', 'revision',
]
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
  /** §11 — what the reviewer said, for the editor to act on. */
  rejectionReason?: string | null
  approvedBy?: string | null
  approvedAt?: string | null
  rejectedBy?: string | null
  rejectedAt?: string | null
  /** §4 — the intended posting time, ISO. */
  scheduledFor?: string | null
  scheduledBy?: string | null
  /** §17 — the campaign this belongs to; null on records from before. */
  campaignId?: string | null
  /** §3 — the pages chosen at upload, and their handles as they were then. */
  socialPageIds?: string[]
  socialPageNames?: string[]
  /** §10 — the N in "<campaign> - Video N". */
  sequence?: number | null
  liveUrls?: Partial<Record<LiveUrlPlatform, string>>
  activity: ActivityEntry[]
}

export interface WorkflowUser {
  id: string
  name: string
  email: string
  role: VideoRole
  active: boolean
  /** §4.2 "Date Added". */
  createdAt?: string
  updatedAt?: string
  lastActivityAt?: string | null
  /** §4.6 — set on a deleted user, whose history stays intact. */
  deletedAt?: string | null
}

/** §8.2 — what an editor is allowed to see about a page. */
export interface EditorVisiblePage {
  id: string
  handle: string
  platform: string
  connected: boolean
  /* §8 — present for everyone except an editor, whose projection is an
     allowlist on purpose (§25) and carries none of these. */
  page_link?: string
  contact_person?: string
  status?: string
  assigned_campaigns?: string[]
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

// ── §11 review loop ────────────────────────────────────────────────────────

export const reviewQueue = () => request<{ videos: VideoRecord[] }>('/review-queue')

export const approveVideo = (id: string, note = '') =>
  request<{ video: VideoRecord }>(`/videos/${id}/approve`, {
    method: 'POST', body: JSON.stringify({ note }),
  }).then(r => r.video)

/** The reason is required — an editor cannot act on silence. */
export const rejectVideo = (id: string, reason: string) =>
  request<{ video: VideoRecord }>(`/videos/${id}/reject`, {
    method: 'POST', body: JSON.stringify({ reason }),
  }).then(r => r.video)

export const startRevision = (id: string) =>
  request<{ video: VideoRecord }>(`/videos/${id}/revise`, { method: 'POST' }).then(r => r.video)

/** §4 — `scheduledFor` is an ISO datetime. */
export const scheduleVideo = (id: string, scheduledFor: string) =>
  request<{ video: VideoRecord }>(`/videos/${id}/schedule`, {
    method: 'POST', body: JSON.stringify({ scheduledFor }),
  }).then(r => r.video)

// ── Google Drive connection (§9) ───────────────────────────────────────────

/** Where the workflow's Drive is configured from, and how it stands. */
export interface DriveStatus {
  /** Where the Google OAuth client comes from. */
  client: 'env' | 'app' | 'none'
  client_id: string | null
  /** What must be registered on the OAuth client in Google Cloud Console. */
  redirect_uri: string
  connected: boolean
  account_email: string | null
  /** The Google account the Drive must belong to. */
  expected_email: string
  folder: { id: string; name: string | null; url: string | null } | null
  connected_at: string | null
  connected_by_name: string | null
  default_folder_name: string
  /** env = set on the server (wins); app = connected here; local = dev folder. */
  source: 'env' | 'app' | 'local' | 'none'
}

export const getDriveStatus = () => request<DriveStatus>('/drive')

export const saveDriveClient = (clientId: string, clientSecret: string) =>
  request<DriveStatus>('/drive/client', {
    method: 'POST', body: JSON.stringify({ client_id: clientId, client_secret: clientSecret }),
  })

export const setDriveAccount = (email: string) =>
  request<DriveStatus>('/drive/account', { method: 'POST', body: JSON.stringify({ email }) })

/** Returns Google's sign-in URL, to open in a popup. */
export const startDriveConnect = () =>
  request<{ url: string }>('/drive/connect', { method: 'POST' }).then(r => r.url)

export const chooseDriveFolder = (folder: string) =>
  request<DriveStatus>('/drive/folder', { method: 'POST', body: JSON.stringify({ folder }) })

export const disconnectDrive = () => request<DriveStatus>('/drive', { method: 'DELETE' })

export const syncAllToDrive = () =>
  request<{ synced: number; failed: Array<{ title: string; error: string }> }>('/drive/sync', { method: 'POST' })

// ── §7 campaigns ───────────────────────────────────────────────────────────

export interface CampaignProgress { required: number; published: number; remaining: number }

export interface Campaign {
  id: string
  name: string
  description: string
  startDate: string
  endDate: string
  campaignManagerId?: string | null
  socialPageIds: string[]
  status: 'upcoming' | 'running' | 'completed'
  requiredPosts: number
  notes: string
  createdAt: string
  updatedAt: string
  progress?: CampaignProgress
}

export const CAMPAIGN_STATUS_LABEL: Record<Campaign['status'], string> = {
  upcoming: 'Upcoming', running: 'Running', completed: 'Completed',
}

export const listCampaigns = () => request<{ campaigns: Campaign[] }>('/campaigns')

export const getCampaign = (id: string) =>
  request<{ campaign: Campaign; progress: CampaignProgress; videos: VideoRecord[] }>(`/campaigns/${id}`)

export const createCampaign = (input: Partial<Campaign>) =>
  request<{ campaign: Campaign }>('/campaigns', {
    method: 'POST', body: JSON.stringify(input),
  }).then(r => r.campaign)

export const updateCampaign = (id: string, patch: Partial<Campaign>) =>
  request<{ campaign: Campaign }>(`/campaigns/${id}`, {
    method: 'PATCH', body: JSON.stringify(patch),
  }).then(r => r.campaign)

export const deleteCampaign = (id: string) =>
  request<{ deleted: boolean }>(`/campaigns/${id}`, { method: 'DELETE' })

export const publishVideo = (id: string, liveUrls: Partial<Record<LiveUrlPlatform, string>> = {}, remark = '') =>
  request<{ video: VideoRecord }>(`/videos/${id}/publish`, {
    method: 'POST', body: JSON.stringify({ live_urls: liveUrls, remark }),
  }).then(r => r.video)

export const setLiveUrls = (id: string, liveUrls: Partial<Record<LiveUrlPlatform, string>>) =>
  request<{ video: VideoRecord }>(`/videos/${id}/live-urls`, {
    method: 'PATCH', body: JSON.stringify({ live_urls: liveUrls }),
  }).then(r => r.video)

export const listSocialPages = () =>
  request<{ pages: EditorVisiblePage[]; analytics_visible: boolean }>('/social-pages')

/**
 * §8 — the details a person maintains on a page. Deliberately narrow: every
 * other field comes from the sync, and editing those here would mean the next
 * sync silently undid the edit.
 */
export const updateSocialPage = (
  id: string, patch: { page_link?: string; contact_person?: string; status?: 'active' | 'inactive' },
) => request<{ page: unknown }>(`/social-pages/${id}`, {
  method: 'PATCH', body: JSON.stringify(patch),
}).then(r => r.page)

/** Streamed through the API so access is checked on the bytes themselves (§25). */
export const videoStreamUrl = (id: string) => `${BASE}/videos/${id}/stream`
export const videoDownloadUrl = (id: string) => `${BASE}/videos/${id}/download`

// ── Display helpers ────────────────────────────────────────────────────────

/* §11 — one entry per status. Rejection and revision are rose and orange
   because they are the two that ask somebody to do something. */
export const STATUS_STYLE: Record<VideoStatus, { label: string; cls: string }> = {
  uploaded:     { label: 'Uploaded',        cls: 'bg-slate-100 text-slate-700' },
  under_review: { label: 'Under Review',    cls: 'bg-amber-100 text-amber-800' },
  approved:     { label: 'Approved',        cls: 'bg-sky-100 text-sky-800' },
  scheduled:    { label: 'Scheduled',       cls: 'bg-violet-100 text-violet-800' },
  published:    { label: 'Published',       cls: 'bg-emerald-100 text-emerald-700' },
  rejected:     { label: 'Rejected',        cls: 'bg-rose-100 text-rose-700' },
  revision:     { label: 'Editor Revision', cls: 'bg-orange-100 text-orange-800' },
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

// ── Events (§11, §12) ──────────────────────────────────────────────────────

export type EventStatus = 'unassigned' | 'open' | 'completed'

export interface EventRecord {
  id: string
  title: string
  description: string
  date: string
  client?: string | null
  assignedEditorId?: string | null
  assignedBy?: string | null
  /* §5 — what each calendar entry must show. All optional: an event goes in
     the calendar before any of it is decided. */
  campaignId?: string | null
  socialPageId?: string | null
  contentType?: string | null
  /** ISO time of the planned posting; `date` is the day. */
  postingAt?: string | null
  assignedPublisherId?: string | null
  status: EventStatus
  createdAt: string
  updatedAt: string
  completedAt?: string | null
  activity: ActivityEntry[]
}

/** §5 — the content types a calendar entry offers. Free text is allowed too. */
export const CONTENT_TYPES = ['Reel', 'Post', 'Story', 'Short', 'Carousel', 'Live'] as const

/** §5 "Calendar statuses: Upcoming, Running/Scheduled, Pending, Completed." */
export type CalendarStatus = 'upcoming' | 'scheduled' | 'pending' | 'completed'

export const CALENDAR_STATUS: Record<CalendarStatus, { label: string; cls: string }> = {
  upcoming:  { label: 'Upcoming',          cls: 'bg-sky-100 text-sky-800' },
  scheduled: { label: 'Running/Scheduled', cls: 'bg-violet-100 text-violet-800' },
  pending:   { label: 'Pending',           cls: 'bg-amber-100 text-amber-800' },
  completed: { label: 'Completed',         cls: 'bg-emerald-100 text-emerald-700' },
}

/**
 * Places an event or a posting on §5's four calendar statuses.
 *
 * The workflow's own statuses are finer than the calendar's, so this is the
 * one place they are folded together. The rule that matters: anything whose
 * date has passed without being done is PENDING — overdue — rather than
 * still "upcoming", because a missed slot is what a manager looks at a
 * calendar to find.
 */
export function calendarStatusOf(
  entry:
    | { kind: 'event'; status: EventStatus; date: string }
    | { kind: 'posting'; status: VideoStatus; when: string },
  now: Date = new Date(),
): CalendarStatus {
  if (entry.kind === 'event') {
    if (entry.status === 'completed') return 'completed'
    return entry.date < localDay(now) ? 'pending' : 'upcoming'
  }
  if (entry.status === 'published') return 'completed'
  return new Date(entry.when).getTime() < now.getTime() ? 'pending' : 'scheduled'
}

export interface EventCounts {
  total: number; upcoming: number; past: number; unassigned: number; completed: number
}

export const EVENT_STATUS_STYLE: Record<EventStatus, { label: string; cls: string; dot: string }> = {
  unassigned: { label: 'Unassigned', cls: 'bg-slate-100 text-slate-700',   dot: 'bg-slate-400' },
  open:       { label: 'Open',       cls: 'bg-amber-100 text-amber-800',   dot: 'bg-amber-400' },
  completed:  { label: 'Completed',  cls: 'bg-emerald-100 text-emerald-700', dot: 'bg-emerald-500' },
}

export const listEvents = (params: { status?: EventStatus; from?: string; to?: string; editorId?: string } = {}) => {
  const q = new URLSearchParams()
  if (params.status) q.set('status', params.status)
  if (params.from) q.set('from', params.from)
  if (params.to) q.set('to', params.to)
  if (params.editorId) q.set('editor_id', params.editorId)
  const qs = q.toString()
  return request<{ events: EventRecord[] }>(`/events${qs ? `?${qs}` : ''}`)
}

export const getEvent = (id: string) => request<{ event: EventRecord }>(`/events/${id}`)

export const eventCounts = () => request<{ counts: EventCounts }>('/events/counts')

/** §5 — the calendar entry's own details. */
export interface EventDetailsInput {
  title: string; description?: string; date: string; client?: string | null
  campaignId?: string | null; socialPageId?: string | null; contentType?: string | null
  postingAt?: string | null; assignedPublisherId?: string | null
}

export const createEvent = (input: EventDetailsInput) =>
  request<{ event: EventRecord }>('/events', { method: 'POST', body: JSON.stringify(input) }).then(r => r.event)

export const updateEvent = (id: string, patch: Partial<EventDetailsInput>) =>
  request<{ event: EventRecord }>(`/events/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }).then(r => r.event)

export const assignEvent = (id: string, editorId: string) =>
  request<{ event: EventRecord }>(`/events/${id}/assign`, {
    method: 'POST', body: JSON.stringify({ editor_id: editorId }),
  }).then(r => r.event)

export const completeEvent = (id: string) =>
  request<{ event: EventRecord }>(`/events/${id}/complete`, { method: 'POST' }).then(r => r.event)

export const listEditors = () => request<{ editors: WorkflowUser[] }>('/editors')

/** §5 — who an event can be assigned to publish. */
export const listPublishers = () =>
  request<{ publishers: Array<{ id: string; name: string; email: string }> }>('/publishers')

// ── Notifications (§19) ────────────────────────────────────────────────────

export interface WorkflowNotification {
  id: string
  kind:
    | 'video_submitted' | 'event_assigned' | 'event_reassigned' | 'event_completed'
    | 'video_approved' | 'video_rejected' | 'posting_due' | 'campaign_deadline'
    | 'campaign_completed' | 'user_created' | 'system_issue'
  message: string
  createdAt: string
  readAt?: string | null
  subject?: { type: 'video' | 'event' | 'campaign' | 'system'; id: string } | null
}

export const listNotifications = () =>
  request<{ notifications: WorkflowNotification[]; unread: number }>('/notifications')

export const markNotificationsRead = (ids?: string[]) =>
  request<{ marked: number }>('/notifications/read', {
    method: 'POST', body: JSON.stringify(ids?.length ? { ids } : {}),
  })

/** Local calendar day as YYYY-MM-DD — never via toISOString, which shifts. */
export function localDay(d: Date = new Date()): string {
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10)
}

// ── §18 search & filtering ─────────────────────────────────────────────────

export interface SearchParams {
  q?: string
  status?: VideoStatus
  eventStatus?: EventStatus
  client?: string
  editorId?: string
  publisherId?: string
  platform?: string
  /** §13 — a social media page's id. */
  pageId?: string
  /** §13 — Reel, Post, Story… or "Video" for workflow videos. */
  contentType?: string
  from?: string
  to?: string
}

export interface FilterOptions {
  clients: string[]
  platforms: string[]
  editors: { id: string; name: string }[]
  publishers: { id: string; name: string }[]
  pages?: { id: string; name: string }[]
  contentTypes?: string[]
}

export const searchWorkflow = (params: SearchParams = {}) => {
  const q = new URLSearchParams()
  const map: Record<string, string | undefined> = {
    q: params.q, status: params.status, event_status: params.eventStatus,
    client: params.client, editor_id: params.editorId, publisher_id: params.publisherId,
    platform: params.platform, page_id: params.pageId, content_type: params.contentType,
    from: params.from, to: params.to,
  }
  for (const [key, value] of Object.entries(map)) if (value) q.set(key, value)
  const qs = q.toString()
  return request<{ videos: VideoRecord[]; events: EventRecord[] }>(`/search${qs ? `?${qs}` : ''}`)
}

export const getFilterOptions = () => request<FilterOptions>('/filter-options')

// ── §20 KPI dashboard ──────────────────────────────────────────────────────

export interface CountRow { key: string; label: string; count: number }

export interface WorkflowKpis {
  totalVideos: number
  uploadedVideos: number
  underReviewVideos: number
  approvedVideos: number
  scheduledVideos: number
  rejectedVideos: number
  inRevisionVideos: number
  needsEditorVideos: number
  pendingPublishingVideos: number
  publishedVideos: number
  pendingContentVideos: number
  todaysPosts: number
  publishedToday: number
  /* §5 / §12 — added by the route from the campaigns, pages and team. */
  campaignsTotal?: number
  campaignsRunning?: number
  campaignsUpcoming?: number
  campaignsCompleted?: number
  totalSocialPages?: number | null
  totalUsers?: number
  avgUploadedToSubmittedHours: number | null
  avgSubmittedToPublishedHours: number | null
  publishedThisWeek: number
  publishedThisMonth: number
  videosByEditor: CountRow[]
  videosByClient: CountRow[]
  totalEvents: number
  upcomingEvents: number
  pastEvents: number
  unassignedEvents: number
  completedEvents: number
  eventsByEditor: CountRow[]
}

export const getKpis = () => request<{ kpis: WorkflowKpis }>('/kpis').then(r => r.kpis)

/** Turns 31.5 hours into "1d 8h" — a KPI card nobody has to do arithmetic on. */
export function formatHours(hours: number | null): string {
  if (hours === null) return '—'
  if (hours < 1) return `${Math.round(hours * 60)} min`
  if (hours < 24) return `${Math.round(hours * 10) / 10} h`
  const days = Math.floor(hours / 24)
  const rest = Math.round(hours % 24)
  return rest ? `${days}d ${rest}h` : `${days}d`
}

// ── §11.3 / §14.1 Editor Video Log (monthly) ───────────────────────────────

export interface VideoLogEntry {
  videoId: string
  editorId: string
  editorName: string
  title: string
  editorTitle: string
  client: string
  status: VideoStatus
  date: string
}

export interface EditorVideoLog {
  month: string
  entries: VideoLogEntry[]
  byEditor: { editorId: string; editorName: string; entries: VideoLogEntry[] }[]
  availableMonths: string[]
}

export const getEditorLog = (params: { month?: string; client?: string } = {}) => {
  const q = new URLSearchParams()
  if (params.month) q.set('month', params.month)
  if (params.client) q.set('client', params.client)
  const qs = q.toString()
  return request<{ log: EditorVideoLog }>(`/editor-log${qs ? `?${qs}` : ''}`).then(r => r.log)
}

/** "2026-09" → "September 2026". */
export function formatMonth(month: string): string {
  const [year, m] = month.split('-').map(Number)
  if (!year || !m) return month
  return new Date(year, m - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
}

// ── §4.2 Admin user management ─────────────────────────────────────────────

export const listWorkflowUsers = () => request<{ users: WorkflowUser[] }>('/users')

export const addWorkflowUser = (input: { name: string; email: string; role: VideoRole; active?: boolean }) =>
  request<{ user: WorkflowUser }>('/users', { method: 'POST', body: JSON.stringify(input) }).then(r => r.user)

export const updateWorkflowUser = (id: string, patch: { role?: VideoRole; active?: boolean }) =>
  request<{ user: WorkflowUser }>(`/users/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }).then(r => r.user)

export const deleteWorkflowUser = (id: string) =>
  request<{ deleted: boolean }>(`/users/${id}`, { method: 'DELETE' })

export const ROLE_LABEL: Record<VideoRole, string> = {
  admin: 'Admin', editor: 'Editor', manager: 'Manager', publisher: 'Publisher',
}

// ── §16 Activity log ───────────────────────────────────────────────────────

export interface FeedEntry extends ActivityEntry {
  userEmail?: string
  relatedEventId?: string | null
  subject: { type: 'video' | 'event'; id: string; title: string }
}

export interface ActivityActor { id: string; name: string; role: VideoRole }

export const listActivity = (params: {
  q?: string; userId?: string; subject?: 'video' | 'event'; from?: string; to?: string
} = {}) => {
  const q = new URLSearchParams()
  if (params.q) q.set('q', params.q)
  if (params.userId) q.set('user_id', params.userId)
  if (params.subject) q.set('subject', params.subject)
  if (params.from) q.set('from', params.from)
  if (params.to) q.set('to', params.to)
  const qs = q.toString()
  return request<{ entries: FeedEntry[] }>(`/activity${qs ? `?${qs}` : ''}`)
}

export const listActivityActors = () => request<{ actors: ActivityActor[] }>('/activity/actors')
