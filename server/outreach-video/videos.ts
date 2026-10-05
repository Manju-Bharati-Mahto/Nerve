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
import { getDriveClient } from "./drive-client.js";
import {
  ensureDriveStructure, mutateWorkflow, readWorkflow, VIDEOS_FOLDER,
} from "./drive-store.js";
import { activityEntry, listActiveUsers } from "./users.js";
import { assetFoldersFor, campaignAssetName, getCampaign } from "./campaigns.js";
import { mirrorVideo } from "./drive-mirror.js";
import { notify } from "./notifications.js";
import type {
  LiveUrlPlatform, VideoRecord, VideoStatus, VideoUser, WorkflowStoreDoc,
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
async function reserveSequence(client: string): Promise<number> {
  const key = client.trim().toLowerCase();
  return mutateWorkflow<number>(doc => {
    const sequences = doc.sequences ?? (doc.sequences = {});
    const next = (sequences[key] ?? 0) + 1;
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

export interface UploadInput {
  editor: Pick<VideoUser, "id" | "name" | "email" | "role">;
  /** §9 required fields. */
  client: string;
  editorTitle: string;
  caption: string;
  /** The multer temp file. */
  localPath: string;
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

/**
 * §9 steps 1–7 plus §9.1: reserves the campaign number, ensures the campaign
 * folder, uploads the video under its auto-generated name, writes the matching
 * caption file, then records the video as a Draft.
 *
 * Lands in Draft rather than Submitted so §17 ("editor can update the caption
 * before it is submitted") and the §8 Draft KPI both have something to act on;
 * `submitVideo` performs step 8.
 */
export async function uploadVideo(input: UploadInput): Promise<VideoRecord> {
  const { client } = getDriveClient();

  /* A real campaign decides three things: its own name wins over whatever was
     typed, its §9 folders receive the files, and its §10 naming is used. An
     upload with no campaign record keeps every one of those as it was, which
     is what makes older campaigns carry on unchanged. */
  const campaignRecord = input.campaignId ? await getCampaign(input.campaignId) : null;
  if (input.campaignId && !campaignRecord) throw new Error("That campaign was not found.");

  const campaign = (campaignRecord?.name ?? input.client).trim();
  if (!campaign) throw new Error("Client / project name is required.");
  if (!input.editorTitle.trim()) throw new Error("Video title is required.");
  if (!input.caption.trim()) throw new Error("Social media caption is required.");

  /* §9 — every upload is filed into its campaign's tree,
     Social Media Campaigns/<campaign>/Videos, whether or not the campaign is a
     record yet; and §10 — named "<campaign> - Video N". */
  const folders = await assetFoldersFor(
    campaignRecord ?? { name: campaign, driveFolders: null },
  );

  const sequence = await reserveSequence(campaign);
  const autoName = campaignAssetName(campaign, sequence);
  const extension = input.originalName.includes(".")
    ? input.originalName.slice(input.originalName.lastIndexOf("."))
    : "";

  // §29 — the Drive upload has to succeed before any record claims it exists.
  const uploaded = await client.uploadBinaryFile(
    safeFileName(autoName + extension), folders.videos, input.localPath, input.mimeType,
  );

  const now = new Date().toISOString();
  const record: VideoRecord = {
    id: randomUUID(),
    title: autoName,
    editorTitle: input.editorTitle.trim(),
    client: campaign,
    campaignId: campaignRecord?.id ?? null,
    socialPageIds: input.socialPageIds ?? [],
    socialPageNames: input.pageNames ?? [],
    sequence,
    driveFolders: folders,
    editorId: input.editor.id,
    caption: input.caption,
    status: "uploaded",
    currentVersion: 1,
    driveFileId: uploaded.id,
    driveFileName: uploaded.name,
    // Written by the mirror once the record exists — see below.
    captionFileId: null,
    sizeBytes: input.sizeBytes,
    mimeType: input.mimeType,
    platform: input.platform?.trim() || null,
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
    return video;
  }
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
  await notify(reviewers.map(p => p.id), "video_submitted", { type: "video", id }, `“${video.title}”`);
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
  return mirrorSafely(video);
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
