/**
 * The §20 KPI dashboard and the §11.3 / §14.1 monthly Editor Video Log.
 *
 * Both read the whole workflow and event stores and reduce them in memory.
 * That's the right shape here: the stores are single JSON documents in Drive,
 * so there is nothing to push a query down into, and the read cache means a
 * dashboard of a dozen cards costs one fetch rather than twelve.
 *
 * Names are resolved through the user store and then snapshotted into the
 * result, so a KPI row still reads correctly for an editor who has since been
 * deleted (§4.6 keeps the tombstone precisely so this works).
 */
import { readEvents, readWorkflow } from "./drive-store.js";
import { listAllUsers } from "./users.js";
import type { EventRecord, VideoRecord, VideoStatus } from "./types.js";

export interface CountRow { key: string; label: string; count: number }

export interface WorkflowKpis {
  // §20 videos
  totalVideos: number;
  draftVideos: number;
  submittedVideos: number;
  publishedVideos: number;
  /** Hours, mean over videos that actually made the transition. Null when none have. */
  avgDraftToSubmittedHours: number | null;
  avgSubmittedToPublishedHours: number | null;
  publishedThisWeek: number;
  publishedThisMonth: number;
  videosByEditor: CountRow[];
  videosByClient: CountRow[];
  // §20 events
  totalEvents: number;
  upcomingEvents: number;
  pastEvents: number;
  unassignedEvents: number;
  completedEvents: number;
  eventsByEditor: CountRow[];
}

/** §11.3 / §14.1 — one row per video in the chosen month. */
export interface VideoLogEntry {
  videoId: string;
  editorId: string;
  editorName: string;
  title: string;
  editorTitle: string;
  client: string;
  status: VideoStatus;
  /** The upload date — the day the editor's output actually landed. */
  date: string;
}

export interface EditorVideoLog {
  month: string;
  entries: VideoLogEntry[];
  /** §11.3 "grouped by editor to see each editor's monthly output at a glance". */
  byEditor: { editorId: string; editorName: string; entries: VideoLogEntry[] }[];
  /** Every month that has at least one video, newest first, for the picker. */
  availableMonths: string[];
}

/** Local calendar day for an ISO timestamp — never via toISOString, which shifts. */
function dayOf(iso: string): string {
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

function hoursBetween(from: string, to: string): number {
  return (new Date(to).getTime() - new Date(from).getTime()) / 3_600_000;
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10;
}

/** Descending by count, then by label, so the order doesn't jitter between loads. */
function tally(rows: { key: string; label: string }[]): CountRow[] {
  const counts = new Map<string, CountRow>();
  for (const row of rows) {
    const existing = counts.get(row.key);
    if (existing) existing.count += 1;
    else counts.set(row.key, { key: row.key, label: row.label, count: 1 });
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

/**
 * The first moment of the ISO week (Monday) and of the month containing `today`,
 * in local terms. "This week" that silently means "the last seven days" is the
 * kind of quiet wrongness a KPI card gets trusted for, so it's spelled out.
 */
function periodStarts(today: Date): { week: number; month: number } {
  const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const isoDayIndex = (startOfDay.getDay() + 6) % 7; // Monday = 0
  const week = new Date(startOfDay);
  week.setDate(week.getDate() - isoDayIndex);
  return { week: week.getTime(), month: new Date(today.getFullYear(), today.getMonth(), 1).getTime() };
}

/**
 * Editor id → display name, deleted users included: §4.6 keeps the tombstone so
 * their past work is still attributed to them rather than to "Unknown editor".
 */
async function editorNames(): Promise<Map<string, string>> {
  const users = await listAllUsers();
  return new Map(users.map(u => [u.id, u.name || u.email]));
}

export async function workflowKpis(now: Date = new Date()): Promise<WorkflowKpis> {
  const [workflow, eventsDoc, names] = await Promise.all([readWorkflow(), readEvents(), editorNames()]);
  const videos: VideoRecord[] = workflow.videos;
  const events: EventRecord[] = eventsDoc.events;
  const { week, month } = periodStarts(now);
  const today = dayOf(now.toISOString());

  const publishedAt = videos
    .filter(v => v.status === "published" && v.publishedAt)
    .map(v => new Date(v.publishedAt as string).getTime());

  return {
    totalVideos: videos.length,
    draftVideos: videos.filter(v => v.status === "draft").length,
    submittedVideos: videos.filter(v => v.status === "submitted").length,
    publishedVideos: videos.filter(v => v.status === "published").length,

    avgDraftToSubmittedHours: mean(
      videos.filter(v => v.submittedAt).map(v => hoursBetween(v.createdAt, v.submittedAt as string)),
    ),
    avgSubmittedToPublishedHours: mean(
      videos.filter(v => v.submittedAt && v.publishedAt)
        .map(v => hoursBetween(v.submittedAt as string, v.publishedAt as string)),
    ),

    publishedThisWeek: publishedAt.filter(t => t >= week).length,
    publishedThisMonth: publishedAt.filter(t => t >= month).length,

    videosByEditor: tally(videos.map(v => ({
      key: v.editorId, label: names.get(v.editorId) ?? "Unknown editor",
    }))),
    videosByClient: tally(videos.map(v => ({ key: v.client, label: v.client }))),

    totalEvents: events.length,
    upcomingEvents: events.filter(e => e.date >= today).length,
    pastEvents: events.filter(e => e.date < today).length,
    unassignedEvents: events.filter(e => e.status === "unassigned").length,
    completedEvents: events.filter(e => e.status === "completed").length,
    eventsByEditor: tally(
      events.filter(e => e.assignedEditorId).map(e => ({
        key: e.assignedEditorId as string,
        label: names.get(e.assignedEditorId as string) ?? "Unknown editor",
      })),
    ),
  };
}

/**
 * §11.3 / §14.1 — "which editor edited which video" for one month.
 *
 * `month` is YYYY-MM; anything else falls back to the current month rather than
 * returning an empty log, which would read as "nobody did anything".
 */
export async function editorVideoLog(month?: string, client?: string): Promise<EditorVideoLog> {
  const [workflow, names] = await Promise.all([readWorkflow(), editorNames()]);
  const videos = workflow.videos;

  const availableMonths = [...new Set(videos.map(v => dayOf(v.createdAt).slice(0, 7)))]
    .sort((a, b) => b.localeCompare(a));

  const wanted = /^\d{4}-\d{2}$/.test(month ?? "")
    ? month as string
    : (availableMonths[0] ?? new Date().toISOString().slice(0, 7));

  const entries: VideoLogEntry[] = videos
    .filter(v => dayOf(v.createdAt).startsWith(wanted))
    .filter(v => !client || v.client === client)
    .map(v => ({
      videoId: v.id,
      editorId: v.editorId,
      editorName: names.get(v.editorId) ?? "Unknown editor",
      title: v.title,
      editorTitle: v.editorTitle,
      client: v.client,
      status: v.status,
      date: dayOf(v.createdAt),
    }))
    .sort((a, b) => b.date.localeCompare(a.date) || a.editorName.localeCompare(b.editorName));

  const grouped = new Map<string, { editorId: string; editorName: string; entries: VideoLogEntry[] }>();
  for (const entry of entries) {
    const bucket = grouped.get(entry.editorId)
      ?? { editorId: entry.editorId, editorName: entry.editorName, entries: [] };
    bucket.entries.push(entry);
    grouped.set(entry.editorId, bucket);
  }

  return {
    month: wanted,
    entries,
    byEditor: [...grouped.values()].sort((a, b) => b.entries.length - a.entries.length
      || a.editorName.localeCompare(b.editorName)),
    availableMonths,
  };
}
