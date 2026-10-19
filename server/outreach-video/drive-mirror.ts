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

// ── The video file's own Drive description ─────────────────────────────────
//
// The team asked for the description and remarks to be "in the Drive folder
// itself". The details file in Captions/ does that, but it is a separate file
// in a separate folder; whoever opens Videos/ and clicks on the video sees
// nothing. Drive has a place for exactly this — a file's description, shown in
// its details panel — so the same story is written there too.

/**
 * Drive caps a description at a few thousand characters (and counts bytes in
 * places). 4000 UTF-8 bytes is under every limit, including for captions in
 * Gujarati or full of emoji, where a character is three or four bytes.
 */
export const DRIVE_DESCRIPTION_LIMIT = 4000;

const byteLength = (text: string): number => Buffer.byteLength(text, "utf8");

/** Cuts `text` to at most `maxBytes`, on a character boundary, marking the cut. */
function fitBytes(text: string, maxBytes: number): string {
  if (byteLength(text) <= maxBytes) return text;
  const chars = Array.from(text);
  let out = "";
  let used = byteLength("…");
  for (const c of chars) {
    const b = byteLength(c);
    if (used + b > maxBytes) break;
    out += c;
    used += b;
  }
  return `${out}…`;
}

/**
 * The text set as the video file's Drive description: title, campaign,
 * editor, caption, the editor's description/notes, and every remark with who
 * and when.
 *
 * Remarks are what grows, so they are what gives way: when everything does not
 * fit, the NEWEST remarks are kept (they are what someone opening the file
 * needs) and a line says where the full history is. The fixed part is capped
 * first so a novel-length caption cannot crowd out every remark.
 */
export function videoDriveDescription(video: VideoRecord, limit = DRIVE_DESCRIPTION_LIMIT): string {
  const uploaded = video.activity.find(e => e.action === "video.uploaded");
  const editor = uploaded ? `${uploaded.userName}${uploaded.userEmail ? ` (${uploaded.userEmail})` : ""}` : "—";
  const head = [
    `${video.title} — ${STATUS_LABEL[video.status] ?? video.status}`,
    `Title: ${video.editorTitle || "—"}`,
    `Campaign: ${video.client}`,
    `Editor: ${editor}`,
    `Uploaded: ${formatIst(video.createdAt)}`,
    "",
    "Caption:",
    fitBytes(video.caption.trim() || "—", Math.floor(limit * 0.3)),
    "",
    "Description / notes:",
    fitBytes(video.notes?.trim() || "—", Math.floor(limit * 0.2)),
  ];
  const rejection = video.status === "rejected" || video.status === "revision" ? video.rejectionReason?.trim() : "";
  if (rejection) head.push("", "Why it was sent back:", fitBytes(rejection, Math.floor(limit * 0.1)));
  const top = `${head.join("\n")}\n\nRemarks:\n`;
  const footer = "\n\nFull history: Captions/ beside this video. Kept up to date by NERVE.";

  const lines = video.activity.map(remarkLine);
  /* Room is held back for the "(N earlier remarks not shown)" line, so adding
     it can never push the result over the limit. */
  const omittedNote = (n: number) => `(${n} earlier remark${n === 1 ? "" : "s"} not shown)`;
  const budget = limit - byteLength(top) - byteLength(footer) - byteLength(`${omittedNote(lines.length)}\n`);
  const kept: string[] = [];
  let used = 0;
  // Newest first until the space runs out; shown oldest-first as everywhere else.
  for (let i = lines.length - 1; i >= 0; i--) {
    const cost = byteLength(lines[i]) + 1;
    if (used + cost > budget) break;
    kept.unshift(lines[i]);
    used += cost;
  }
  const dropped = lines.length - kept.length;
  const remarks = [
    ...(dropped > 0 ? [omittedNote(dropped)] : []),
    ...kept,
    ...(lines.length ? [] : ["—"]),
  ].join("\n");
  return fitBytes(`${top}${remarks}${footer}`, limit);
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

  // ── The video's own description ─────────────────────────────────────────
  /* Last, and on its own: the details file and the move above are what the
     workflow depends on, and a description that will not save must not undo
     them or fail the step. Logged so a persistent failure is visible. */
  const fileId = update.driveFileId ?? video.driveFileId;
  try {
    await client.setDescription(fileId, videoDriveDescription(video));
  } catch (err) {
    console.error(`Outreach video: could not set the Drive description of “${video.title}”`, err);
  }
  return update;
}
