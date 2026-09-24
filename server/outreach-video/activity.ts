/**
 * §16 Activity Logging — the chronological timeline across the whole workflow.
 *
 * Every video and event already carries its own activity history; this merges
 * them into one feed so §27's "Activity" (and the Admin's "Activity Logs") has
 * something to show. Nothing is stored twice — the feed is derived on read, so
 * it can never disagree with the per-record timeline it came from.
 *
 * §28: "No workflow action should permanently erase historical activity." That
 * makes this read-only by construction — there is no delete path here at all.
 */
import { readEvents, readWorkflow } from "./drive-store.js";
import type { ActivityEntry, VideoRole } from "./types.js";

export interface FeedEntry extends ActivityEntry {
  /** What the action happened to, so the UI can link back to it. */
  subject: { type: "video" | "event"; id: string; title: string };
}

export interface FeedQuery {
  /** Free text over the action, the actor and the subject's title. */
  q?: string;
  userId?: string;
  /** "video" or "event"; omitted means both. */
  subjectType?: "video" | "event";
  /** Inclusive calendar-day range, YYYY-MM-DD, against the entry timestamp. */
  from?: string;
  to?: string;
  limit?: number;
}

/** The slice of the feed the caller may see. */
export interface FeedScope {
  /**
   * An editor sees the history of their own videos and the events assigned to
   * them, and nothing else — the same boundary as everywhere else in the module
   * (§25), applied to the record rather than to the entry's actor, so an editor
   * still sees the publisher's action on their own video.
   */
  onlyEditorId?: string;
}

const DEFAULT_LIMIT = 200;

function dayOf(iso: string): string {
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

export async function activityFeed(query: FeedQuery = {}, scope: FeedScope = {}): Promise<FeedEntry[]> {
  const [workflow, eventsDoc] = await Promise.all([readWorkflow(), readEvents()]);
  const entries: FeedEntry[] = [];

  if (query.subjectType !== "event") {
    for (const video of workflow.videos) {
      if (scope.onlyEditorId && video.editorId !== scope.onlyEditorId) continue;
      for (const entry of video.activity ?? []) {
        entries.push({ ...entry, subject: { type: "video", id: video.id, title: video.title } });
      }
    }
  }

  if (query.subjectType !== "video") {
    for (const event of eventsDoc.events) {
      if (scope.onlyEditorId && event.assignedEditorId !== scope.onlyEditorId) continue;
      for (const entry of event.activity ?? []) {
        entries.push({ ...entry, subject: { type: "event", id: event.id, title: event.title } });
      }
    }
  }

  const q = (query.q ?? "").trim().toLowerCase();

  return entries
    .filter(e => !query.userId || e.userId === query.userId)
    .filter(e => {
      const day = dayOf(e.timestamp);
      if (query.from && day < query.from) return false;
      if (query.to && day > query.to) return false;
      return true;
    })
    .filter(e => !q || [e.action, e.userName, e.userEmail, e.subject.title, e.notes]
      .some(v => (v ?? "").toLowerCase().includes(q)))
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .slice(0, Math.min(Math.max(query.limit ?? DEFAULT_LIMIT, 1), 1000));
}

/** Everyone who appears in the feed, for the "filter by user" dropdown. */
export async function activityActors(): Promise<{ id: string; name: string; role: VideoRole }[]> {
  const [workflow, eventsDoc] = await Promise.all([readWorkflow(), readEvents()]);
  const actors = new Map<string, { id: string; name: string; role: VideoRole }>();
  const collect = (entries: ActivityEntry[] = []) => {
    for (const e of entries) {
      if (!actors.has(e.userId)) actors.set(e.userId, { id: e.userId, name: e.userName, role: e.userRole });
    }
  };
  for (const v of workflow.videos) collect(v.activity);
  for (const e of eventsDoc.events) collect(e.activity);
  return [...actors.values()].sort((a, b) => a.name.localeCompare(b.name));
}
