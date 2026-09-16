/**
 * Outreach video workflow — record shapes.
 *
 * These are the documents held inside the Google Drive data stores (PRD §6):
 *   User Data Store     → VideoUser[]        (§6.2)
 *   Workflow Data Store → VideoRecord[]      (§6.1, §22.1)
 *   Event Data Store    → EventRecord[]      (§6.3, §22.2)
 *
 * Drive is the source of truth for all of it (§28) — nothing here is mirrored
 * into Postgres. Every record carries its own activity history (§16) so that
 * deleting a user can never erase workflow history (§4.6): entries snapshot the
 * actor's name/email at the time they acted.
 */

/** §7 — the whole status set. There is deliberately no approval/revision state. */
export const VIDEO_STATUSES = ["draft", "submitted", "published"] as const;
export type VideoStatus = typeof VIDEO_STATUSES[number];

/** §22.2 — an event is Unassigned until a Manager picks an editor. */
export const EVENT_STATUSES = ["unassigned", "open", "completed"] as const;
export type EventStatus = typeof EVENT_STATUSES[number];

/**
 * §3 — the workflow's own roles. These map onto Nerve roles rather than
 * replacing them: Admin = super_admin/admin, Manager = outreach_manager,
 * Editor = outreach_editor, Publisher = outreach_publisher.
 */
export const VIDEO_ROLES = ["admin", "editor", "manager", "publisher"] as const;
export type VideoRole = typeof VIDEO_ROLES[number];

/** §15.1 — live URLs are optional, and only these platforms are offered. */
export const LIVE_URL_PLATFORMS = ["instagram", "facebook"] as const;
export type LiveUrlPlatform = typeof LIVE_URL_PLATFORMS[number];

/**
 * §16 — one entry per meaningful action, on the record it happened to.
 * `userName`/`userEmail` are snapshots, not references: §4.6 requires history to
 * survive the user being deleted.
 */
export interface ActivityEntry {
  id: string;
  userId: string;
  userName: string;
  userEmail: string;
  userRole: VideoRole;
  action: string;
  timestamp: string;
  previousStatus?: string | null;
  newStatus?: string | null;
  /** Set when the action concerns an event rather than the record it sits on. */
  relatedEventId?: string | null;
  notes?: string | null;
}

/** §6.2 / §4.2 — a registered user of the video workflow. */
export interface VideoUser {
  id: string;
  name: string;
  email: string;
  role: VideoRole;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  /** §4.2 "Last Activity" column. */
  lastActivityAt?: string | null;
  /**
   * §4.6 — a deleted user leaves the active list but their row is retained as a
   * tombstone so historical records can still resolve a name/email. Tombstoned
   * users are excluded from every listing and can never authenticate.
   */
  deletedAt?: string | null;
}

/** §22.1 */
export interface VideoRecord {
  id: string;
  title: string;
  /** §9.1 — the campaign; also the Drive sub-folder name under Videos/. */
  client: string;
  editorId: string;
  caption: string;
  status: VideoStatus;
  currentVersion: number;
  /** §23 — always the Drive file id, never just a filename. */
  driveFileId: string;
  /** Kept alongside the id purely for display/debugging. */
  driveFileName: string;
  platform?: string | null;
  notes?: string | null;
  tags?: string[];
  createdAt: string;
  updatedAt: string;
  submittedAt?: string | null;
  publishedBy?: string | null;
  publishedAt?: string | null;
  liveUrls?: Partial<Record<LiveUrlPlatform, string>>;
  activity: ActivityEntry[];
}

/** §22.2 */
export interface EventRecord {
  id: string;
  title: string;
  description: string;
  /** Calendar day, YYYY-MM-DD. */
  date: string;
  client?: string | null;
  assignedEditorId?: string | null;
  assignedBy?: string | null;
  status: EventStatus;
  createdAt: string;
  updatedAt: string;
  completedAt?: string | null;
  activity: ActivityEntry[];
}

/**
 * The three Drive data stores, each a single JSON document. Wrapped in an
 * object (rather than a bare array) so a schema version can be carried
 * alongside the rows without another migration later.
 */
export interface UserStoreDoc { version: 1; users: VideoUser[] }
export interface WorkflowStoreDoc { version: 1; videos: VideoRecord[] }
export interface EventStoreDoc { version: 1; events: EventRecord[] }

export const EMPTY_USER_STORE: UserStoreDoc = { version: 1, users: [] };
export const EMPTY_WORKFLOW_STORE: WorkflowStoreDoc = { version: 1, videos: [] };
export const EMPTY_EVENT_STORE: EventStoreDoc = { version: 1, events: [] };
