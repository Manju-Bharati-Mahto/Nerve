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
import { activityEntry } from "./users.js";
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
 * §7 — the only legal moves. There is deliberately no path back from published,
 * and no approval/revision states to pass through.
 */
const TRANSITIONS: Record<VideoStatus, VideoStatus[]> = {
  draft: ["submitted"],
  submitted: ["published"],
  published: [],
};

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
  const folders = await ensureDriveStructure();

  const campaign = input.client.trim();
  if (!campaign) throw new Error("Client / project name is required.");
  if (!input.editorTitle.trim()) throw new Error("Video title is required.");
  if (!input.caption.trim()) throw new Error("Social media caption is required.");

  // §9.1 — the campaign folder is created on demand, before the upload.
  const campaignFolderId = await client.ensureFolder(safeFileName(campaign), folders.videos);

  const sequence = await reserveSequence(campaign);
  const autoName = campaignVideoName(campaign, sequence);
  const extension = input.originalName.includes(".")
    ? input.originalName.slice(input.originalName.lastIndexOf("."))
    : "";

  // §29 — the Drive upload has to succeed before any record claims it exists.
  const uploaded = await client.uploadBinaryFile(
    safeFileName(autoName + extension), campaignFolderId, input.localPath, input.mimeType,
  );

  // §9.1 — the caption file's name must match the video's exactly, so the two
  // can never be paired up wrongly when read back off Drive by a human.
  let captionFileId: string | null = null;
  try {
    const caption = await client.createTextFile(
      safeFileName(`${autoName}.txt`), campaignFolderId, input.caption,
    );
    captionFileId = caption.id;
  } catch {
    // The caption's authoritative copy is on the record itself; a failed
    // sidecar file must not cost the editor their upload.
    captionFileId = null;
  }

  const now = new Date().toISOString();
  const record: VideoRecord = {
    id: randomUUID(),
    title: autoName,
    editorTitle: input.editorTitle.trim(),
    client: campaign,
    editorId: input.editor.id,
    caption: input.caption,
    status: "draft",
    currentVersion: 1,
    driveFileId: uploaded.id,
    driveFileName: uploaded.name,
    captionFileId,
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
    activity: [activityEntry(input.editor, "video.uploaded", { newStatus: "draft" })],
  };

  return mutateWorkflow<VideoRecord>(doc => {
    doc.videos.push(record);
    return { doc, result: record };
  });
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
    if (video.status !== "draft") {
      throw new Error("The caption can only be changed while the video is still a draft.");
    }
    video.caption = caption;
    video.activity.push(activityEntry(actor, "video.caption_updated"));
    return { ...video };
  });

  // Keep the §9.1 sidecar in step. Best-effort: the record holds the real copy.
  try {
    const { client } = getDriveClient();
    if (updated.captionFileId) {
      const { revisionId } = await client.readTextFile(updated.captionFileId);
      await client.updateTextFile(updated.captionFileId, caption, revisionId);
    }
  } catch {
    // Sidecar drift is recoverable; failing the edit is not worth it.
  }
  return updated;
}

/** §9 step 8 — Draft → Submitted, which is what puts it in the Publisher's queue. */
export async function submitVideo(id: string, actor: Pick<VideoUser, "id" | "name" | "email" | "role">): Promise<VideoRecord> {
  return updateVideo(id, video => {
    if (video.editorId !== actor.id && actor.role !== "admin") throw new NotYourVideoError();
    if (!TRANSITIONS[video.status].includes("submitted")) {
      throw new InvalidTransitionError(video.status, "submitted");
    }
    video.status = "submitted";
    video.submittedAt = new Date().toISOString();
    video.activity.push(activityEntry(actor, "video.submitted", { previousStatus: "draft", newStatus: "submitted" }));
    return { ...video };
  });
}

/** §14 — the Publisher's queue is exactly the submitted videos, oldest first. */
export async function publishingQueue(): Promise<VideoRecord[]> {
  const doc = await readWorkflow();
  return doc.videos
    .filter(v => v.status === "submitted")
    .sort((a, b) => (a.submittedAt ?? a.createdAt).localeCompare(b.submittedAt ?? b.createdAt));
}

/**
 * §15 — Submitted → Published, optionally recording the live URLs (§15.1).
 * Publishing is what removes it from the active queue (§28).
 */
export async function publishVideo(
  id: string,
  actor: Pick<VideoUser, "id" | "name" | "email" | "role">,
  liveUrls: Partial<Record<LiveUrlPlatform, string>> = {},
): Promise<VideoRecord> {
  return updateVideo(id, video => {
    if (!TRANSITIONS[video.status].includes("published")) {
      throw new InvalidTransitionError(video.status, "published");
    }
    const cleaned: Partial<Record<LiveUrlPlatform, string>> = {};
    for (const [platform, url] of Object.entries(liveUrls)) {
      const trimmed = (url ?? "").trim();
      if (trimmed) cleaned[platform as LiveUrlPlatform] = trimmed;
    }
    video.status = "published";
    video.publishedBy = actor.id;
    video.publishedAt = new Date().toISOString();
    video.liveUrls = { ...video.liveUrls, ...cleaned };
    video.activity.push(activityEntry(actor, "video.published", {
      previousStatus: "submitted",
      newStatus: "published",
      notes: Object.keys(cleaned).length ? `Live: ${Object.values(cleaned).join(", ")}` : null,
    }));
    return { ...video };
  });
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
  return updateVideo(id, video => {
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
}
