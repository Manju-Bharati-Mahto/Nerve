/**
 * §18 Search & Filtering.
 *
 * One free-text term plus a set of exact filters, applied server-side so an
 * editor's scoping can't be widened by a client that simply stops filtering —
 * the caller passes the scope in, and it is intersected with whatever the user
 * asked for rather than replaced by it.
 *
 * The §18 search list spans both stores (video title, client, editor, status,
 * video ID, event title), so this searches videos and events together and
 * returns them separately for the UI to lay out.
 */
import { readEvents, readWorkflow } from "./drive-store.js";
import { listAllUsers } from "./users.js";
import type {
  EventRecord, EventStatus, VideoRecord, VideoStatus,
} from "./types.js";

export interface SearchQuery {
  /** §18 free text. Matched case-insensitively against every searchable field. */
  q?: string;
  status?: VideoStatus;
  eventStatus?: EventStatus;
  client?: string;
  /** Video editor, and for events the assigned editor (§18 lists both). */
  editorId?: string;
  publisherId?: string;
  platform?: string;
  /** Inclusive calendar-day range, YYYY-MM-DD. */
  from?: string;
  to?: string;
}

export interface SearchResult {
  videos: VideoRecord[];
  events: EventRecord[];
}

/** The scope the caller is allowed to see, intersected with the query. */
export interface SearchScope {
  /** Restricts videos to this editor and events to this assignee. */
  onlyEditorId?: string;
}

function dayOf(iso: string): string {
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

function inRange(day: string, from?: string, to?: string): boolean {
  if (from && day < from) return false;
  if (to && day > to) return false;
  return true;
}

function matches(haystack: (string | null | undefined)[], needle: string): boolean {
  return haystack.some(value => (value ?? "").toLowerCase().includes(needle));
}

export async function search(query: SearchQuery, scope: SearchScope = {}): Promise<SearchResult> {
  const [workflow, eventsDoc, users] = await Promise.all([readWorkflow(), readEvents(), listAllUsers()]);
  const names = new Map(users.map(u => [u.id, `${u.name} ${u.email}`]));
  const q = (query.q ?? "").trim().toLowerCase();

  // An editor's own id always wins over a requested one, so a hand-crafted
  // `editor_id` can't be used to read another editor's work (§25).
  const videoEditorId = scope.onlyEditorId ?? query.editorId;

  const videos = workflow.videos
    .filter(v => !videoEditorId || v.editorId === videoEditorId)
    .filter(v => !query.status || v.status === query.status)
    .filter(v => !query.client || v.client === query.client)
    .filter(v => !query.publisherId || v.publishedBy === query.publisherId)
    .filter(v => !query.platform || (v.platform ?? "") === query.platform)
    .filter(v => inRange(dayOf(v.createdAt), query.from, query.to))
    .filter(v => !q || matches([
      v.title, v.editorTitle, v.client, v.id, v.status, v.caption,
      v.notes, v.platform, names.get(v.editorId), ...(v.tags ?? []),
    ], q))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const events = eventsDoc.events
    .filter(e => !videoEditorId || e.assignedEditorId === videoEditorId)
    .filter(e => !query.eventStatus || e.status === query.eventStatus)
    .filter(e => !query.client || (e.client ?? "") === query.client)
    .filter(e => inRange(e.date, query.from, query.to))
    .filter(e => !q || matches([
      e.title, e.description, e.client, e.id, e.status,
      e.assignedEditorId ? names.get(e.assignedEditorId) : null,
    ], q))
    .sort((a, b) => b.date.localeCompare(a.date));

  return { videos, events };
}

/** The distinct values the UI offers in its filter dropdowns. */
export async function filterOptions(): Promise<{
  clients: string[]; platforms: string[];
  editors: { id: string; name: string }[];
  publishers: { id: string; name: string }[];
}> {
  const [workflow, eventsDoc, users] = await Promise.all([readWorkflow(), readEvents(), listAllUsers()]);
  const clients = new Set<string>();
  for (const v of workflow.videos) if (v.client) clients.add(v.client);
  for (const e of eventsDoc.events) if (e.client) clients.add(e.client);
  const platforms = new Set<string>();
  for (const v of workflow.videos) if (v.platform) platforms.add(v.platform);

  // Deleted users stay listed: their historical videos are still filterable by
  // them, which is the whole point of the §4.6 tombstone.
  const pick = (role: string) => users
    .filter(u => u.role === role)
    .map(u => ({ id: u.id, name: u.name || u.email }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    clients: [...clients].sort((a, b) => a.localeCompare(b)),
    platforms: [...platforms].sort((a, b) => a.localeCompare(b)),
    editors: pick("editor"),
    publishers: pick("publisher"),
  };
}
