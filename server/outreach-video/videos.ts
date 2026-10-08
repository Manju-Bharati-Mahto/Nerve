/**
 * The video lifecycle: upload and submission (§9, §9.1), the Draft → Submitted
 * → Published transitions (§7), captions (§17) and publishing (§15).
 *
 * Everything lives in the Drive Workflow Data Store; nothing is mirrored into
 * Postgres (§28). Ordering matters throughout: §29 requires that a submission
 * is never reported successful until the Drive upload actually succeeded, so
 * the Drive write always happens before the store write, and a failure leaves
 * no half-made record behind.
 */
import { randomUUID } from "node:crypto";
import { getDriveClient, type DriveFileMeta } from "./drive-client.js";
import {
  ensureDriveStructure, mutateWorkflow, readWorkflow, VIDEOS_FOLDER,
} from "./drive-store.js";
import { activityEntry, listActiveUsers } from "./users.js";
import { assetFoldersFor, campaignAssetName, getCampaign } from "./campaigns.js";
import { mirrorVideo } from "./drive-mirror.js";
import { alreadyNotified, notify } from "./notifications.js";
import type {
  CampaignRecord, LiveUrlPlatform, VideoRecord, VideoStatus, VideoUser, WorkflowStoreDoc,
} from "./types.js";

export class VideoNotFoundError extends Error {
  constructor(id: string) {
    super(`Video ${id} was not found.`);
    this.name = "VideoNotFoundError";
  }
}

export class InvalidTransitionError extends Error {
  constructor(from: VideoStatus, to: VideoStatus) {
    super(`A video cannot go from ${from} to ${to}.`);
    this.name = "InvalidTransitionError";
  }
}

export class NotYourVideoError extends Error {
  constructor() {
    super("Editors can only act on their own videos.");
    this.name = "NotYourVideoError";
  }
}

/**
 * §11 — the only legal moves.
 *
 *   Uploaded → Under Review → Approved → Scheduled → Published
 *   Rejected → Editor Revision → Under Review
 *
 * Two notes on the shape of this.
 *
 * Approved reaches Published directly as well as through Scheduled. §11 draws
 * one line, but §4 gives the Publisher BOTH "schedule content and record
 * posting date/time" AND "mark content as Published" as separate abilities,
 * so requiring a schedule before anything can go out would make half of §4
 * unreachable. Scheduling is a step the Publisher may take, not a toll.
 *
 * There is still no path back from Published. Rejection belongs before
 * something is public; undoing a post is not a status change, it is a
 * different act with consequences outside this system.
 */
const TRANSITIONS: Record<VideoStatus, VideoStatus[]> = {
  uploaded: ["under_review"],
  under_review: ["approved", "rejected"],
  approved: ["scheduled", "published"],
  scheduled: ["published"],
  rejected: ["revision"],
  revision: ["under_review"],
  published: [],
};

/** Everything a Publisher can still act on — approved work, scheduled or not. */
export const PUBLISHABLE_STATUSES: VideoStatus[] = ["approved", "scheduled"];

/**
 * §9.1 — reserves the next sequential number for a campaign, atomically.
 *
 * Done as its own store mutation (which is serialised) rather than derived from
 * the existing videos at write time: two editors uploading to the same campaign
 * at once must never be handed the same number. A reserved number that later
 * fails to upload simply leaves a gap, which the PRD tolerates — a clash, which
 * it explicitly forbids, cannot happen.
 */
async function reserveSequence(client: string, campaignId: string | null): Promise<number> {
  /* A campaign record is counted by its id. Counting by the name text gave a
     renamed campaign a second "Video 1" under its new name, and handed a NEW
     campaign that took the old name the renamed one's numbering. Only an
     upload with no campaign record — typed-in text, as before campaigns —
     is still counted by name. The prefix keeps the two kinds of key apart. */
  const key = campaignId ? `campaign:${campaignId}` : client.trim().toLowerCase();
  return mutateWorkflow<number>(doc => {
    const sequences = doc.sequences ?? (doc.sequences = {});
    /* A campaign's first id-keyed reservation picks up after the highest
       number its videos already carry, so the switch from name keys neither
       repeats a number nor restarts at 1. Reservations still in flight under
       a name key are not lost by this: they live only in memory, and the
       restart that brings this code in forgets them. */
    const start = sequences[key] ?? (campaignId
      ? Math.max(0, ...doc.videos.filter(v => v.campaignId === campaignId).map(v => v.sequence ?? 0))
      : 0);
    const next = start + 1;
    sequences[key] = next;
    return { doc, result: next };
  });
}

/** §9.1 — "<Campaign> Video <n>", the Drive file name and the record's Title. */
export function campaignVideoName(client: string, sequence: number): string {
  return `${client.trim()} Video ${sequence}`;
}

/** Strips characters Drive/most filesystems dislike, without changing the name's shape. */
function safeFileName(name: string): string {
  return name.replace(/[/\\:*?"<>|]/g, "-").trim();
}

// ── What may be uploaded ──────────────────────────────────────────────────

/** The largest video accepted, through either upload path. */
export const MAX_VIDEO_BYTES = 2 * 1024 * 1024 * 1024;

/** Video types accepted as the browser reports them. */
export const VIDEO_MIME_ALLOWLIST = [
  "video/mp4", "video/quicktime", "video/x-m4v", "video/webm", "video/x-msvideo", "video/mpeg",
  "video/3gpp", "video/3gpp2", "video/x-matroska", "video/avi", "video/mp2t",
];

/**
 * The type each known video extension really is. Browsers often do not know:
 * a .mkv or .mts on Windows, or a .mov from some phones, arrives as
 * application/octet-stream or with no type at all. Refusing those refused real
 * videos, so the extension decides instead — and Drive is told the proper
 * type, so it still previews the file as a video.
 */
const VIDEO_EXTENSIONS: Record<string, string> = {
  ".mp4": "video/mp4", ".m4v": "video/x-m4v", ".mov": "video/quicktime", ".qt": "video/quicktime",
  ".webm": "video/webm", ".avi": "video/x-msvideo", ".mpg": "video/mpeg", ".mpeg": "video/mpeg",
  ".3gp": "video/3gpp", ".3g2": "video/3gpp2", ".mkv": "video/x-matroska",
  ".ts": "video/mp2t", ".mts": "video/mp2t", ".m2ts": "video/mp2t",
};

/** For refusal messages: what a person may pick instead. */
export const ACCEPTED_VIDEO_TYPES_LABEL = "MP4, MOV, M4V, WEBM, AVI, MPEG, 3GP, MKV or MTS/TS";

const extensionOf = (name: string): string => {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot).toLowerCase() : "";
};

/**
 * The MIME type to store a file under, or null when it is not a video we
 * accept. A recognised video type is kept as reported; an unknown or generic
 * one is accepted only on a known video extension.
 */
export function acceptedVideoType(mimeType: string | null | undefined, fileName: string): string | null {
  const type = String(mimeType ?? "").trim().toLowerCase();
  if (VIDEO_MIME_ALLOWLIST.includes(type)) return type;
  if (type === "" || type === "application/octet-stream" || type === "binary/octet-stream") {
    return VIDEO_EXTENSIONS[extensionOf(fileName)] ?? null;
  }
  return null;
}

/** Thrown when a file is not an acceptable video; the route maps it to 400/413. */
export class VideoFileRejectedError extends Error {
  constructor(message: string, readonly status: 400 | 413 = 400) {
    super(message);
    this.name = "VideoFileRejectedError";
  }
}

/** The type and size checks both upload paths share. Returns the Drive MIME type. */
export function checkVideoFile(fileName: string, mimeType: string | null | undefined, sizeBytes: number): string {
  const type = acceptedVideoType(mimeType, fileName);
  if (!type) throw new VideoFileRejectedError(`That file is not a video we can accept. Upload ${ACCEPTED_VIDEO_TYPES_LABEL}.`);
  /* The size comes from the browser on a direct upload, so it is a claim, not
     a measurement: NaN, a fraction or a number past 2^53 would open a Drive
     session nobody can complete (and make the size check at the end
     meaningless). Only a whole, positive, exactly representable count passes. */
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
    throw new VideoFileRejectedError("That video file is empty or its size could not be read.");
  }
  if (sizeBytes > MAX_VIDEO_BYTES) throw new VideoFileRejectedError("That video is larger than 2 GB.", 413);
  return type;
}

// ── Upload ─────────────────────────────────────────────────────────────────

/** Everything about an upload except the bytes — what both paths start from. */
export interface UploadDetails {
  editor: Pick<VideoUser, "id" | "name" | "email" | "role">;
  /** §9 required fields. */
  client: string;
  editorTitle: string;
  caption: string;
  /** The name the file had on the editor's machine; only its extension is kept. */
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  /** §9 optional fields. */
  platform?: string | null;
  notes?: string | null;
  tags?: string[];
  /**
   * §17 — the campaign this belongs to, when the editor picked a real one.
   * Absent for an upload that only carries a typed campaign name, which is
   * how everything worked before campaigns were records.
   */
  campaignId?: string | null;
  /** §3 — the pages this video is destined for. */
  socialPageIds?: string[];
  /**
   * §10 — those pages' handles, for the caption file's "Platform/Page" line.
   * Resolved by the caller: this module's data lives in Drive, and reaching
   * into Postgres for display text is not its job.
   */
  pageNames?: string[];
}

export interface UploadInput extends UploadDetails {
  /** The multer temp file. */
  localPath: string;
}

/**
 * An upload that has been checked and given its place: the campaign, its
 * folders, its number and the file name it will have in Drive. Nothing has
 * been sent yet.
 */
export interface PreparedUpload {
  details: UploadDetails;
  campaignId: string | null;
  /** The campaign name the record carries. */
  campaign: string;
  folders: { videos: string; captions: string; published: string };
  sequence: number;
  /** "<Campaign> - Video N" — the record's title. */
  title: string;
  /** The Drive file name: the title plus the original extension. */
  fileName: string;
  /** The MIME type the file is stored under. */
  mimeType: string;
}

/** What validateUploadFields settles: the type to store, and the campaign. */
export interface ValidatedUpload {
  mimeType: string;
  campaignRecord: CampaignRecord | null;
  /** The campaign name the record will carry. */
  campaign: string;
}

/**
 * Every check an upload must pass — the file's type and size, the campaign,
 * title and caption — and nothing else: no folders created, no number
 * reserved. So a caller that may not go on to upload (a direct-upload request
 * that falls back to sending the file through the server) can still refuse a
 * bad request up front, without leaving a gap in the numbering.
 */
export async function validateUploadFields(details: UploadDetails): Promise<ValidatedUpload> {
  const mimeType = checkVideoFile(details.originalName, details.mimeType, details.sizeBytes);

  /* A real campaign decides three things: its own name wins over whatever was
     typed, its §9 folders receive the files, and its §10 naming is used. An
     upload with no campaign record keeps every one of those as it was, which
     is what makes older campaigns carry on unchanged. */
  const campaignRecord = details.campaignId ? await getCampaign(details.campaignId) : null;
  if (details.campaignId && !campaignRecord) throw new Error("That campaign was not found.");

  const campaign = (campaignRecord?.name ?? details.client ?? "").trim();
  if (!campaign) throw new Error("Client / project name is required.");
  if (!(details.editorTitle ?? "").trim()) throw new Error("Video title is required.");
  if (!(details.caption ?? "").trim()) throw new Error("Social media caption is required.");
  return { mimeType, campaignRecord, campaign };
}

/**
 * Step one of an upload, shared by both paths (through the server, and
 * straight from the browser to Drive): validates the fields and the file
 * (validateUploadFields), ensures the campaign's §9 folders and reserves its
 * §9.1 number.
 *
 * Reserving the number here, before any bytes move, is deliberate: a direct
 * upload needs the final file name to open its Drive session. A reservation
 * that is never used leaves a gap, which the PRD tolerates; a clash it forbids.
 */
export async function prepareUpload(details: UploadDetails): Promise<PreparedUpload> {
  const { mimeType, campaignRecord, campaign } = await validateUploadFields(details);

  /* §9 — every upload is filed into its campaign's tree,
     Social Media Campaigns/<campaign>/Videos, whether or not the campaign is a
     record yet; and §10 — named "<campaign> - Video N". */
  const folders = await assetFoldersFor(
    campaignRecord ?? { name: campaign, driveFolders: null },
  );

  const sequence = await reserveSequence(campaign, campaignRecord?.id ?? null);
  const title = campaignAssetName(campaign, sequence);
  const extension = details.originalName.includes(".")
    ? details.originalName.slice(details.originalName.lastIndexOf("."))
    : "";

  return {
    details: { ...details, mimeType },
    campaignId: campaignRecord?.id ?? null,
    campaign,
    folders,
    sequence,
    title,
    fileName: safeFileName(title + extension),
    mimeType,
  };
}

/**
 * Step two, once the file exists in Drive: records the video as uploaded and
 * writes its caption file and Drive description. The same for both paths, so
 * a video that went straight from the browser is indistinguishable from one
 * that came through the server.
 */
export async function recordUpload(prepared: PreparedUpload, uploaded: DriveFileMeta): Promise<VideoRecord> {
  const input = prepared.details;
  const now = new Date().toISOString();
  const record: VideoRecord = {
    id: randomUUID(),
    title: prepared.title,
    editorTitle: input.editorTitle.trim(),
    client: prepared.campaign,
    campaignId: prepared.campaignId,
    socialPageIds: input.socialPageIds ?? [],
    socialPageNames: input.pageNames ?? [],
    sequence: prepared.sequence,
    driveFolders: prepared.folders,
    editorId: input.editor.id,
    caption: input.caption,
    status: "uploaded",
    currentVersion: 1,
    driveFileId: uploaded.id,
    driveFileName: uploaded.name,
    // Written by the mirror once the record exists — see below.
    captionFileId: null,
    sizeBytes: input.sizeBytes,
    mimeType: prepared.mimeType,
    // Lower-cased so "Instagram" and "instagram" are one platform: the upload
    // dialog sends lower case, other callers did not, and the All Videos
    // filter listed both and matched each to half the videos.
    platform: input.platform?.trim().toLowerCase() || null,
    notes: input.notes?.trim() || null,
    tags: input.tags?.filter(Boolean) ?? [],
    createdAt: now,
    updatedAt: now,
    submittedAt: null,
    publishedBy: null,
    publishedAt: null,
    liveUrls: {},
    activity: [activityEntry(input.editor, "video.uploaded", { newStatus: "uploaded" })],
  };

  const saved = await mutateWorkflow<VideoRecord>(doc => {
    doc.videos.push(record);
    return { doc, result: record };
  });
  // §10 — the caption file beside it, carrying the description and remarks too.
  return mirrorSafely(saved);
}

/**
 * §9 steps 1–7 plus §9.1 through the server: prepare, send the staged file to
 * Drive, record. Lands in Draft rather than Submitted so §17 ("editor can
 * update the caption before it is submitted") and the §8 Draft KPI both have
 * something to act on; `submitVideo` performs step 8.
 */
export async function uploadVideo(input: UploadInput): Promise<VideoRecord> {
  const { client } = getDriveClient();
  const prepared = await prepareUpload(input);
  // §29 — the Drive upload has to succeed before any record claims it exists.
  const uploaded = await client.uploadBinaryFile(
    prepared.fileName, prepared.folders.videos, input.localPath, prepared.mimeType,
  );
  return recordUpload(prepared, uploaded);
}

/** True when a video record already points at this Drive file. */
export async function videoForDriveFile(fileId: string): Promise<VideoRecord | null> {
  const doc = await readWorkflow();
  return doc.videos.find(v => v.driveFileId === fileId) ?? null;
}

/**
 * Brings Drive in line with a video after a workflow step, and returns the
 * record as it now stands.
 *
 * Never throws. By the time this runs the step has happened and been saved;
 * a Drive hiccup must not turn a successful approval into an error on
 * screen. The next step, or "Sync everything to Drive", catches it up.
 */
async function mirrorSafely(video: VideoRecord, options: { relocate?: boolean } = {}): Promise<VideoRecord> {
  try {
    const update = await mirrorVideo(video, options);
    if (!Object.keys(update).length) return video;
    return await updateVideo(video.id, v => { Object.assign(v, update); return { ...v }; });
  } catch (err) {
    console.error(`Outreach video: could not mirror “${video.title}” to Drive`, err);
    await reportDriveProblem(video, err);
    return video;
  }
}

/**
 * §14 Admin — "major publishing/system issues". A Drive that cannot be
 * written is exactly that: the workflow carries on, but what the team sees in
 * Drive is falling behind. Once a day at most, whatever the number of
 * failures — when Drive is down every step fails, and one notice says it.
 */
async function reportDriveProblem(video: VideoRecord, err: unknown): Promise<void> {
  try {
    const admins = (await listActiveUsers()).filter(u => u.role === "admin");
    const reason = err instanceof Error ? err.message : String(err);
    for (const a of admins) {
      if (await alreadyNotified(a.id, "system_issue", "drive")) continue;
      await notify([a.id], "system_issue", { type: "system", id: "drive" },
        `Google Drive could not be updated (latest: “${video.title}” — ${reason.slice(0, 160)}). ` +
        `Check Video Workflow → Google Drive, then use Sync now.`);
    }
  } catch { /* a notice about a failure must never become a failure of its own */ }
}

/**
 * §14 Manager — "campaign completion". Raised by the publication that brings
 * a campaign to its posting target, once: a campaign that overdelivers does
 * not announce itself again with every extra post.
 */
async function announceIfCampaignComplete(video: VideoRecord): Promise<void> {
  try {
    const campaign = video.campaignId ? await getCampaign(video.campaignId) : null;
    if (!campaign || campaign.requiredPosts <= 0) return;
    const doc = await readWorkflow();
    const published = doc.videos.filter(v => v.status === "published" && v.campaignId === campaign.id).length;
    if (published !== campaign.requiredPosts) return;
    const recipients = (await listActiveUsers())
      .filter(u => u.role === "manager" || u.role === "admin" || u.id === campaign.campaignManagerId);
    for (const r of recipients) {
      if (await alreadyNotified(r.id, "campaign_completed", campaign.id, 24 * 365)) continue;
      await notify([r.id], "campaign_completed", { type: "campaign", id: campaign.id },
        `“${campaign.name}” has published all ${campaign.requiredPosts} of its required posts.`);
    }
  } catch { /* best effort, like every notice */ }
}

/**
 * Re-mirrors every video: writes any missing details file, refreshes the
 * rest, and puts each video file in the folder its status says it belongs
 * in. For after connecting a Drive, or after a stretch when Drive was down.
 */
export async function resyncAllToDrive(): Promise<{ synced: number; failed: Array<{ title: string; error: string }> }> {
  const doc = await readWorkflow();
  let synced = 0;
  const failed: Array<{ title: string; error: string }> = [];
  for (const original of doc.videos) {
    try {
      let video = original;
      // A record from before videos remembered their folders gets them now.
      if (!video.driveFolders?.published) {
        const campaign = video.campaignId ? await getCampaign(video.campaignId) : null;
        const folders = await assetFoldersFor(campaign ?? { name: video.client, driveFolders: null });
        video = await updateVideo(video.id, v => { v.driveFolders = folders; return { ...v }; });
      }
      const update = await mirrorVideo(video, { relocate: true });
      if (Object.keys(update).length) {
        await updateVideo(video.id, v => { Object.assign(v, update); return { ...v }; });
      }
      synced++;
    } catch (err) {
      failed.push({ title: original.title, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { synced, failed };
}

/** Loads one video, or throws. */
export async function getVideo(id: string): Promise<VideoRecord> {
  const doc = await readWorkflow();
  const video = doc.videos.find(v => v.id === id);
  if (!video) throw new VideoNotFoundError(id);
  return video;
}

export async function listVideos(filter: { editorId?: string; status?: VideoStatus; client?: string } = {}): Promise<VideoRecord[]> {
  const doc = await readWorkflow();
  return doc.videos
    .filter(v => !filter.editorId || v.editorId === filter.editorId)
    .filter(v => !filter.status || v.status === filter.status)
    .filter(v => !filter.client || v.client === filter.client)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Applies a mutation to one video, keeping the store write atomic. */
async function updateVideo<R>(
  id: string,
  apply: (video: VideoRecord, doc: WorkflowStoreDoc) => R,
): Promise<R> {
  return mutateWorkflow<R>(doc => {
    const video = doc.videos.find(v => v.id === id);
    if (!video) throw new VideoNotFoundError(id);
    const result = apply(video, doc);
    video.updatedAt = new Date().toISOString();
    return { doc, result };
  });
}

/**
 * Makes every video filed under `campaignId` carry the campaign's current
 * name, and returns how many changed.
 *
 * `client` is what the dashboard's "Videos by client", the Campaign filter and
 * the editor log group by. A rename used to leave it on the old text, so the
 * renamed campaign's videos were reported under a name it no longer had — and
 * under a NEW campaign's name once someone reused it. Only videos tied to the
 * campaign by id move; a typed-in name with no record behind it is left alone.
 *
 * Reads first and writes only when something differs, so calling this after
 * every campaign edit costs nothing when there was no rename, and a rename
 * whose follow-up failed is put right by the next edit.
 */
export async function renameCampaignOnVideos(campaignId: string, name: string): Promise<number> {
  const wanted = name.trim();
  const stale = (doc: WorkflowStoreDoc) =>
    doc.videos.filter(v => v.campaignId === campaignId && v.client !== wanted);
  if (stale(await readWorkflow()).length === 0) return 0;
  return mutateWorkflow<number>(doc => {
    const videos = stale(doc);
    for (const v of videos) v.client = wanted;
    return { doc, result: videos.length };
  });
}

/**
 * §17 — the caption can be rewritten while the video is still a Draft. Once
 * submitted it is what the Publisher is about to post, so it is frozen.
 */
export async function updateCaption(id: string, caption: string, actor: Pick<VideoUser, "id" | "name" | "email" | "role">): Promise<VideoRecord> {
  const updated = await updateVideo(id, video => {
    if (video.editorId !== actor.id && actor.role !== "admin") throw new NotYourVideoError();
    /* §11 — the caption is editable while the work is still the editor's:
       before it is submitted, and again while they are acting on a rejection.
       Once it is under review or past it, changing the text underneath the
       reviewer is what the review step exists to prevent. */
    if (video.status !== "uploaded" && video.status !== "revision") {
      throw new Error("The caption can only be changed before the video is submitted, or while it is being revised.");
    }
    video.caption = caption;
    video.activity.push(activityEntry(actor, "video.caption_updated"));
    return { ...video };
  });

  // The details file carries the caption, so it is rewritten with it.
  return mirrorSafely(updated);
}

/**
 * §11 — the editor sends work for review. Reachable from Uploaded and, after
 * a rejection, from Editor Revision: the same act either way.
 */
export async function submitVideo(id: string, actor: Pick<VideoUser, "id" | "name" | "email" | "role">): Promise<VideoRecord> {
  const video = await updateVideo(id, video => {
    if (video.editorId !== actor.id && actor.role !== "admin") throw new NotYourVideoError();
    const from = video.status;
    if (!TRANSITIONS[from].includes("under_review")) {
      throw new InvalidTransitionError(from, "under_review");
    }
    video.status = "under_review";
    video.submittedAt = new Date().toISOString();
    /* A resubmission answers the rejection, so the reason stops applying —
       leaving it set would show the editor a stale complaint about work they
       have already redone. The activity log keeps the history. */
    video.rejectionReason = null;
    video.activity.push(activityEntry(actor, "video.submitted", { previousStatus: from, newStatus: "under_review" }));
    return { ...video };
  });

  // §14 — the reviewers are the people who can approve: managers and admins.
  const reviewers = (await listActiveUsers()).filter(u => u.role === "manager" || u.role === "admin");
  // Not video_submitted: that one tells publishers the work is ready to post,
  // and a submission has not been approved by anyone yet.
  await notify(reviewers.map(p => p.id), "video_review_requested", { type: "video", id }, `“${video.title}”`);
  return mirrorSafely(video);
}

/** §11 — everything waiting on a reviewer, oldest first. */
export async function reviewQueue(): Promise<VideoRecord[]> {
  const doc = await readWorkflow();
  return doc.videos
    .filter(v => v.status === "under_review")
    .sort((a, b) => (a.submittedAt ?? a.createdAt).localeCompare(b.submittedAt ?? b.createdAt));
}

/** §11 — approving releases the work to the Publisher. */
export async function approveVideo(
  id: string, actor: Pick<VideoUser, "id" | "name" | "email" | "role">, note = "",
): Promise<VideoRecord> {
  const video = await updateVideo(id, video => {
    if (!TRANSITIONS[video.status].includes("approved")) {
      throw new InvalidTransitionError(video.status, "approved");
    }
    const from = video.status;
    video.status = "approved";
    video.approvedBy = actor.id;
    video.approvedAt = new Date().toISOString();
    video.rejectionReason = null;
    video.activity.push(activityEntry(actor, "video.approved", {
      previousStatus: from, newStatus: "approved", notes: note.trim() || null,
    }));
    return { ...video };
  });

  const publishers = (await listActiveUsers()).filter(u => u.role === "publisher");
  await notify(publishers.map(p => p.id), "video_submitted", { type: "video", id }, `“${video.title}”`);
  // §14 Editor — "Video approved". The person who made it hears the outcome.
  await notify([video.editorId], "video_approved", { type: "video", id }, `“${video.title}”`);
  return mirrorSafely(video);
}

/**
 * §11 — rejecting sends it back with a reason.
 *
 * The reason is required. "Editors should be able to see the reason when
 * content is rejected" is unsatisfiable if a reviewer can reject with
 * nothing, and a rejection without one just reads as silence to the person
 * who has to act on it.
 */
export async function rejectVideo(
  id: string, actor: Pick<VideoUser, "id" | "name" | "email" | "role">, reason: string,
): Promise<VideoRecord> {
  const trimmed = reason.trim();
  if (!trimmed) throw new Error("A reason is required when rejecting content, so the editor knows what to change.");

  const video = await updateVideo(id, video => {
    if (!TRANSITIONS[video.status].includes("rejected")) {
      throw new InvalidTransitionError(video.status, "rejected");
    }
    const from = video.status;
    video.status = "rejected";
    video.rejectionReason = trimmed;
    video.rejectedBy = actor.id;
    video.rejectedAt = new Date().toISOString();
    video.activity.push(activityEntry(actor, "video.rejected", {
      previousStatus: from, newStatus: "rejected", notes: trimmed,
    }));
    return { ...video };
  });

  // §14 Editor — "Video rejected", with the reason attached.
  await notify([video.editorId], "video_rejected", { type: "video", id },
    `“${video.title}”: ${trimmed}`);
  return mirrorSafely(video);
}

/** §11 — the editor picks rejected work back up. */
export async function startRevision(
  id: string, actor: Pick<VideoUser, "id" | "name" | "email" | "role">,
): Promise<VideoRecord> {
  const video = await updateVideo(id, video => {
    if (video.editorId !== actor.id && actor.role !== "admin") throw new NotYourVideoError();
    if (!TRANSITIONS[video.status].includes("revision")) {
      throw new InvalidTransitionError(video.status, "revision");
    }
    video.status = "revision";
    video.currentVersion += 1;
    video.activity.push(activityEntry(actor, "video.revision_started", {
      previousStatus: "rejected", newStatus: "revision",
    }));
    return { ...video };
  });
  return mirrorSafely(video);
}

/** §4 — the Publisher records when approved content is due to go out. */
export async function scheduleVideo(
  id: string, actor: Pick<VideoUser, "id" | "name" | "email" | "role">, when: string,
): Promise<VideoRecord> {
  const at = new Date(when);
  if (Number.isNaN(at.getTime())) throw new Error("A valid posting date and time is required.");

  const video = await updateVideo(id, video => {
    /* Rescheduling something already scheduled is an edit, not a move, so it
       is allowed without the status having to change. */
    if (video.status !== "scheduled" && !TRANSITIONS[video.status].includes("scheduled")) {
      throw new InvalidTransitionError(video.status, "scheduled");
    }
    const from = video.status;
    video.status = "scheduled";
    video.scheduledFor = at.toISOString();
    video.scheduledBy = actor.id;
    video.activity.push(activityEntry(actor, from === "scheduled" ? "video.rescheduled" : "video.scheduled", {
      previousStatus: from, newStatus: "scheduled", notes: at.toISOString(),
    }));
    return { ...video };
  });
  return mirrorSafely(video);
}

/**
 * §14 — what the Publisher works from: approved content, whether or not a
 * posting time has been set. Scheduled items sort by when they are due;
 * unscheduled ones by how long they have been waiting.
 */
export async function publishingQueue(): Promise<VideoRecord[]> {
  const doc = await readWorkflow();
  return doc.videos
    .filter(v => PUBLISHABLE_STATUSES.includes(v.status))
    .sort((a, b) => (a.scheduledFor ?? a.submittedAt ?? a.createdAt)
      .localeCompare(b.scheduledFor ?? b.submittedAt ?? b.createdAt));
}

/**
 * §15 — Submitted → Published, optionally recording the live URLs (§15.1).
 * Publishing is what removes it from the active queue (§28).
 */
export async function publishVideo(
  id: string,
  actor: Pick<VideoUser, "id" | "name" | "email" | "role">,
  liveUrls: Partial<Record<LiveUrlPlatform, string>> = {},
  /** The publisher's own remark, recorded with the step and shown in Drive. */
  remark = "",
): Promise<VideoRecord> {
  const video = await updateVideo(id, video => {
    if (!TRANSITIONS[video.status].includes("published")) {
      throw new InvalidTransitionError(video.status, "published");
    }
    const cleaned: Partial<Record<LiveUrlPlatform, string>> = {};
    for (const [platform, url] of Object.entries(liveUrls)) {
      const trimmed = (url ?? "").trim();
      if (trimmed) cleaned[platform as LiveUrlPlatform] = trimmed;
    }
    const from = video.status;
    video.status = "published";
    video.publishedBy = actor.id;
    video.publishedAt = new Date().toISOString();
    video.liveUrls = { ...video.liveUrls, ...cleaned };
    video.activity.push(activityEntry(actor, "video.published", {
      previousStatus: from,
      newStatus: "published",
      notes: [
        remark.trim(),
        Object.keys(cleaned).length ? `Live: ${Object.values(cleaned).join(", ")}` : "",
      ].filter(Boolean).join(" · ") || null,
    }));
    return { ...video };
  });
  const mirrored = await mirrorSafely(video);
  await announceIfCampaignComplete(mirrored);
  return mirrored;
}

/**
 * Adds or replaces live URLs after publication — the Publisher may post to the
 * second platform later, and §15.1 treats both as optional throughout.
 */
export async function setLiveUrls(
  id: string,
  actor: Pick<VideoUser, "id" | "name" | "email" | "role">,
  liveUrls: Partial<Record<LiveUrlPlatform, string>>,
): Promise<VideoRecord> {
  const video = await updateVideo(id, video => {
    const cleaned: Partial<Record<LiveUrlPlatform, string>> = { ...video.liveUrls };
    for (const [platform, url] of Object.entries(liveUrls)) {
      const trimmed = (url ?? "").trim();
      if (trimmed) cleaned[platform as LiveUrlPlatform] = trimmed;
      else delete cleaned[platform as LiveUrlPlatform];
    }
    video.liveUrls = cleaned;
    video.activity.push(activityEntry(actor, "video.live_url_updated"));
    return { ...video };
  });
  return mirrorSafely(video);
}
