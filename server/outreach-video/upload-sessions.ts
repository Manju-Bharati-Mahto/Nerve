/**
 * Direct uploads: the editor's browser sends the video straight to Google
 * Drive, and Nerve only records it.
 *
 * WHY. The outreach team asked for exactly this — "when the video is being
 * uploaded it should directly be uploaded to drive and not on our tool nerve,
 * it should not use our database". Sending a 2 GB file through the API meant
 * it crossed the network twice, sat on the server's disk, and failed at the
 * first proxy with a body limit in the way. Now:
 *
 *   1. upload-session — the browser describes the file. The server runs the
 *      same checks as any upload (prepareUpload: role, campaign, title,
 *      caption, type, size), reserves the file's number and final name, and
 *      opens a Google resumable upload session for it in the campaign's
 *      Videos folder, on behalf of the browser's origin.
 *   2. The browser PUTs the bytes to that session URL in chunks. Nerve never
 *      sees them.
 *   3. complete — the browser reports the Drive file id. The server checks the
 *      file really is the one this session was for (right folder, right name,
 *      right size, not already recorded) and records it exactly as the
 *      through-the-server path does.
 *
 * WHERE THE PENDING SESSION LIVES. In this Map, in memory, and nowhere else —
 * never Postgres. It holds who is uploading, the details they typed and where
 * the file is going, for at most a day (Google keeps a resumable session for a
 * week). A restart forgets it; the editor then simply uploads again, and the
 * orphaned file, if the bytes did arrive, is visible in the Videos folder.
 */
import { randomUUID } from "node:crypto";
import { getDriveClient } from "./drive-client.js";
import {
  prepareUpload, recordUpload, validateUploadFields, videoForDriveFile,
  type PreparedUpload, type UploadDetails,
} from "./videos.js";
import type { VideoRecord } from "./types.js";

/** Chunks the browser sends: a multiple of Google's 256 KiB granularity. */
export const DIRECT_UPLOAD_CHUNK_BYTES = 16 * 1024 * 1024;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const SWEEP_EVERY_MS = 30 * 60 * 1000;

export class UploadSessionNotFoundError extends Error {
  constructor() {
    super("That upload session has expired or was not found. Please upload the video again.");
    this.name = "UploadSessionNotFoundError";
  }
}

export class UploadSessionNotYoursError extends Error {
  constructor() {
    super("That upload was started by someone else.");
    this.name = "UploadSessionNotYoursError";
  }
}

/** The file Drive holds is not the one this session was opened for. */
export class UploadVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UploadVerificationError";
  }
}

interface PendingUpload {
  id: string;
  userId: string;
  prepared: PreparedUpload;
  createdAt: number;
  /** Set once recorded, so a repeated complete answers the same video. */
  result?: VideoRecord;
  /** A complete in progress, so two at once record the video once. */
  completing?: Promise<VideoRecord>;
}

const sessions = new Map<string, PendingUpload>();
let sweeper: ReturnType<typeof setInterval> | null = null;

/** Forgets sessions older than the TTL. Exported for the tests. */
export function sweepUploadSessions(now = Date.now()): void {
  for (const [id, s] of sessions) {
    if (now - s.createdAt > SESSION_TTL_MS) sessions.delete(id);
  }
}

function startSweeper(): void {
  if (sweeper) return;
  sweeper = setInterval(() => sweepUploadSessions(), SWEEP_EVERY_MS);
  // Never the reason the process stays alive.
  sweeper.unref?.();
}

function live(sessionId: string): PendingUpload {
  const s = sessions.get(sessionId);
  if (!s || Date.now() - s.createdAt > SESSION_TTL_MS) {
    sessions.delete(sessionId);
    throw new UploadSessionNotFoundError();
  }
  return s;
}

export type StartedUpload =
  | { mode: "direct"; sessionId: string; uploadUrl: string; chunkBytes: number }
  | { mode: "proxy" };

/**
 * Step 1. On a Drive with no URL a browser could reach (the local dev
 * adapter), answers `proxy` without reserving anything: the browser then
 * sends the file through the server as before. The fields are still checked
 * first, so a request that would be refused is refused now — not after the
 * browser has sent the whole file through the server to find out.
 */
export async function startDirectUpload(details: UploadDetails, origin: string): Promise<StartedUpload> {
  const { client } = getDriveClient();
  if (!client.createUploadSession) {
    await validateUploadFields(details);
    return { mode: "proxy" };
  }

  const prepared = await prepareUpload(details);
  const uploadUrl = await client.createUploadSession(
    prepared.fileName, prepared.folders.videos, prepared.mimeType, details.sizeBytes, origin,
  );
  const id = randomUUID();
  sessions.set(id, { id, userId: details.editor.id, prepared, createdAt: Date.now() });
  startSweeper();
  return { mode: "direct", sessionId: id, uploadUrl, chunkBytes: DIRECT_UPLOAD_CHUNK_BYTES };
}

/**
 * Step 3. Idempotent: a browser that lost the first answer and asks again
 * gets the same video, not a second record.
 */
export async function completeDirectUpload(sessionId: string, userId: string, fileId: string): Promise<VideoRecord> {
  const session = live(sessionId);
  if (session.userId !== userId) throw new UploadSessionNotYoursError();
  if (session.result) return session.result;
  if (session.completing) return session.completing;

  const run = (async () => {
    const { prepared } = session;
    const id = String(fileId ?? "").trim();
    const { client } = getDriveClient();
    // From the browser, so it must look like a Drive file id before it goes
    // into a request URL — never a path, a query, or another API's address.
    if (!id || !client.isFileId(id)) throw new UploadVerificationError("Drive did not report the uploaded file.");

    const meta = await client.getMeta(id);
    /* The file id comes from the browser, so it proves nothing on its own:
       it must be the file this session created — in this campaign's Videos
       folder, under the reserved name, at the size declared. Anything else
       (another video's id, a file elsewhere in Drive, a truncated upload) is
       refused rather than recorded. */
    if (!meta.parents?.includes(prepared.folders.videos)) {
      throw new UploadVerificationError("That file is not in this campaign's Videos folder in Drive.");
    }
    if (meta.name !== prepared.fileName) {
      throw new UploadVerificationError("That file is not the one this upload was started for.");
    }
    if (meta.size !== prepared.details.sizeBytes) {
      throw new UploadVerificationError(
        `The file in Drive is ${meta.size ?? "of unknown"} bytes, but ${prepared.details.sizeBytes} were expected. The upload did not finish — please try again.`);
    }
    const existing = await videoForDriveFile(meta.id);
    if (existing) {
      if (existing.editorId === userId) return existing;
      throw new UploadVerificationError("That file already belongs to another video.");
    }
    return recordUpload(prepared, meta);
  })();

  session.completing = run;
  try {
    const video = await run;
    session.result = video;
    return video;
  } finally {
    // A failure leaves the session open, so the browser may try again.
    session.completing = undefined;
  }
}

/** Forgets a session the browser abandoned. Best effort; unknown ids are fine. */
export function cancelDirectUpload(sessionId: string, userId: string): void {
  const s = sessions.get(sessionId);
  if (s && s.userId === userId && !s.result) sessions.delete(sessionId);
}

/** Test seam. */
export function resetUploadSessions(): void {
  sessions.clear();
}

/** Test seam: how many sessions are pending. */
export function pendingUploadCount(): number {
  return sessions.size;
}
