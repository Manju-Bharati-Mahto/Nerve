/**
 * Keeps Google Drive showing what the workflow knows about each video.
 *
 * Campaign & Content Management PRD §9 makes Drive the place campaign assets
 * live, and §10 gives every video a caption file beside it. The outreach team
 * asked for more than the caption: whoever opens the Drive folder should see
 * each video WITH its description and every remark the workflow's users made
 * on it — the reviewer's reason for sending it back, the note on approval,
 * when it was scheduled and who published it.
 *
 * So the caption file is a details file, rewritten after every step a video
 * takes. It still opens with exactly what §10 asks for — campaign, video
 * number, platform/page and the complete caption — and continues with the
 * rest. And when a video is published it moves from Videos/ into Published/,
 * which is what that folder in the §9 tree is for.
 *
 * NEVER FATAL. Every function here is called after the workflow has already
 * done its real work and saved it. If Drive is slow, down, or someone has
 * moved a file by hand, the approval or the publication still stands and the
 * mirror catches up on the next step, or on "Sync everything to Drive".
 */
import { getDriveClient } from "./drive-client.js";
import type { ActivityEntry, VideoRecord, VideoStatus } from "./types.js";

/** Files a person opens in Drive should open as text, not as JSON. */
export const TEXT_MIME = "text/plain";

const STATUS_LABEL: Record<VideoStatus, string> = {
  uploaded: "Uploaded",
  under_review: "Under Review",
  approved: "Approved",
  scheduled: "Scheduled",
  published: "Published",
  rejected: "Rejected",
  revision: "Editor Revision",
};

/** How each recorded action reads to a person. */
const ACTION_LABEL: Record<string, string> = {
  "video.uploaded": "Uploaded",
  "video.submitted": "Submitted for review",
  "video.approved": "Approved",
  "video.rejected": "Sent back for changes",
  "video.revision_started": "Started revising",
  "video.caption_updated": "Edited the caption",
  "video.scheduled": "Scheduled",
  "video.rescheduled": "Rescheduled",
  "video.published": "Published",
  "video.live_url_updated": "Updated the live link",
};

/* Indian Standard Time, because these files are read by the outreach team,
   not by servers; a UTC timestamp in a Drive file is just a puzzle. */
const when = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric",
  hour: "numeric", minute: "2-digit", hour12: true,
});
export const formatIst = (iso: string | null | undefined): string => {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : `${when.format(d)} IST`;
};

/** The N in "VLF 2027 - Video N", from the record or, for older ones, its title. */
export function videoNumberOf(video: Pick<VideoRecord, "sequence" | "title">): number | null {
  if (typeof video.sequence === "number") return video.sequence;
  const m = /Video\s+(\d+)\s*$/i.exec(video.title);
  return m ? Number(m[1]) : null;
}

function remarkLine(e: ActivityEntry): string {
  const label = ACTION_LABEL[e.action] ?? e.action.replace(/^video\./, "").replace(/_/g, " ");
  let note = e.notes?.trim() ?? "";
  // A schedule is recorded as an ISO time; show it the way the rest reads.
  if ((e.action === "video.scheduled" || e.action === "video.rescheduled") && note) note = formatIst(note);
  const who = e.userName?.trim() || e.userEmail || "Someone";
  return `• ${formatIst(e.timestamp)} — ${who}: ${label}${note ? ` — “${note}”` : ""}`;
}

/**
 * The text of a video's details file.
 *
 * Pure, so the exact content is easy to test and read back. The first four
 * lines plus the caption are §10's requirement; everything after them is what
 * the team asked for on top.
 */
export function videoDetailsBody(video: VideoRecord): string {
  const pages = video.socialPageNames?.length
    ? video.socialPageNames.join(", ")
    : video.platform?.trim() || "—";
  const uploaded = video.activity.find(e => e.action === "video.uploaded");
  const published = [...video.activity].reverse().find(e => e.action === "video.published");
  const live = Object.entries(video.liveUrls ?? {}).filter(([, url]) => !!url);
  const rejection = video.status === "rejected" || video.status === "revision" ? video.rejectionReason?.trim() : "";

  const lines = [
    `Campaign: ${video.client}`,
    `Video Number: ${videoNumberOf(video) ?? "—"}`,
    `Platform/Page: ${pages}`,
    `Status: ${STATUS_LABEL[video.status] ?? video.status}`,
    "",
    `File: ${video.driveFileName || video.title}`,
    `Editor's title: ${video.editorTitle || "—"}`,
    `Uploaded by: ${uploaded?.userName ?? "—"} on ${formatIst(video.createdAt)}`,
    `Version: ${video.currentVersion}`,
  ];
  if (video.scheduledFor) lines.push(`Scheduled for: ${formatIst(video.scheduledFor)}`);
  if (published) lines.push(`Published by: ${published.userName} on ${formatIst(video.publishedAt ?? published.timestamp)}`);
  if (live.length) {
    lines.push("Live links:");
    for (const [platform, url] of live) lines.push(`  ${platform}: ${url}`);
  }
  if (video.tags?.length) lines.push(`Tags: ${video.tags.join(", ")}`);

  // The editor's description is the part people look for first after the caption.
  lines.push("", "DESCRIPTION / NOTES", video.notes?.trim() || "—");
  if (rejection) lines.push("", "WHY IT WAS SENT BACK", rejection);
  lines.push("", "CAPTION", video.caption.trim() || "—");
  lines.push("", "REMARKS & HISTORY");
  lines.push(...(video.activity.length ? video.activity.map(remarkLine) : ["—"]));
  lines.push("", "—", "Kept up to date by NERVE. Edits made here are overwritten at the next workflow step.", "");
  return lines.join("\n");
}

/** What changed on the record because of mirroring, for the caller to save. */
export interface MirrorUpdate {
  captionFileId?: string;
  driveFileId?: string;
  driveFileName?: string;
}

/*
 * One mirror at a time per video. Two quick steps on the same video would
 * otherwise race to rewrite the same file, and the loser would fail its
 * revision check and leave the older text in place.
 */
const queues = new Map<string, Promise<unknown>>();

/**
 * Brings one video's Drive files in line with its record: writes or rewrites
 * the details file, and moves a published video into Published/. Returns any
 * file ids that changed. Throws on a Drive failure — `mirrorSafely` is the
 * never-fatal wrapper the workflow calls.
 */
export function mirrorVideo(video: VideoRecord, options: { relocate?: boolean } = {}): Promise<MirrorUpdate> {
  const prior = queues.get(video.id) ?? Promise.resolve();
  const run = prior.then(() => mirrorNow(video, options));
  /* What is queued is a promise that never rejects. Queuing `run` itself
     would leave a second copy of any Drive failure that nobody awaits — an
     unhandled rejection, which in Node can bring the whole API process down.
     The caller still receives `run`, failure and all. */
  const settled: Promise<void> = run.then(() => undefined, () => undefined);
  queues.set(video.id, settled);
  void settled.then(() => {
    if (queues.get(video.id) === settled) queues.delete(video.id);
  });
  return run;
}

async function mirrorNow(video: VideoRecord, options: { relocate?: boolean }): Promise<MirrorUpdate> {
  const { client } = getDriveClient();
  const update: MirrorUpdate = {};
  const body = videoDetailsBody(video);
  const folders = video.driveFolders ?? null;

  // ── The details file ──────────────────────────────────────────────────────
  let wrote = false;
  if (video.captionFileId) {
    try {
      const { revisionId } = await client.readTextFile(video.captionFileId);
      await client.updateTextFile(video.captionFileId, body, revisionId, TEXT_MIME);
      wrote = true;
    } catch {
      // Gone (deleted or moved by hand) — recreated below rather than lost.
      wrote = false;
    }
  }
  if (!wrote && folders) {
    const name = `${(video.driveFileName || video.title).replace(/\.[^.]+$/, "")}.txt`;
    const existing = await client.findChild(name, folders.captions);
    if (existing) {
      const { revisionId } = await client.readTextFile(existing.id);
      await client.updateTextFile(existing.id, body, revisionId, TEXT_MIME);
      update.captionFileId = existing.id;
    } else {
      const made = await client.createTextFile(name, folders.captions, body, TEXT_MIME);
      update.captionFileId = made.id;
    }
  }

  // ── Published/ ────────────────────────────────────────────────────────────
  /* §9: a published video belongs in Published/, everything else in Videos/.
     Publishing is the only step that changes which, so an ordinary step only
     moves a published video; `relocate` (the full resync) checks every one,
     which costs a Drive call per video and so is not done on every step. */
  const target = video.status === "published" ? folders?.published : folders?.videos;
  if (target && (video.status === "published" || options.relocate)) {
    const moved = await client.moveFile(video.driveFileId, target);
    if (moved.id !== video.driveFileId) update.driveFileId = moved.id;
  }
  return update;
}
