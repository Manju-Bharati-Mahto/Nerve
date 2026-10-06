// @vitest-environment node
/**
 * Direct uploads — the browser sends the video straight to Drive and Nerve
 * only records it (upload-sessions.ts).
 *
 * The file id that completes an upload comes from the browser, so the tests
 * that matter most are the refusals: a file in another folder, under another
 * name, or of another size must never be recorded as the editor's video.
 * And completing twice — a browser that lost the first answer — must give the
 * same video, not a second one.
 *
 * Runs on the local Drive adapter with a stand-in for Google's session call:
 * the "browser" then writes the file where the session said it would go.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { config } from "../config.js";
import { getDriveClient, GoogleDriveClient, LocalDriveClient, resetDriveClient } from "./drive-client.js";
import { readWorkflow, resetStoreState } from "./drive-store.js";
import { addUser } from "./users.js";
import {
  cancelDirectUpload, completeDirectUpload, pendingUploadCount, resetUploadSessions, startDirectUpload,
  sweepUploadSessions, DIRECT_UPLOAD_CHUNK_BYTES,
  UploadSessionNotFoundError, UploadSessionNotYoursError, UploadVerificationError,
} from "./upload-sessions.js";
import { VideoFileRejectedError, type UploadDetails } from "./videos.js";
import type { VideoUser } from "./types.js";

let tmpRoot: string;
let scratch: string;
let editor: VideoUser;
let other: VideoUser;
/** Where the stand-in Google session said the file goes. */
let opened: Array<{ name: string; parentId: string; mimeType: string; size: number; origin: string }>;

function details(over: Partial<UploadDetails> = {}): UploadDetails {
  return {
    editor, client: "VLF 2027", editorTitle: "Opening", caption: "Come along", originalName: "clip.mp4",
    mimeType: "video/mp4", sizeBytes: 11, notes: "Cut to 30s", ...over,
  };
}

/** Turns on "direct" mode on the local adapter, the way real Drive has it. */
function enableDirect() {
  const { client } = getDriveClient();
  (client as LocalDriveClient & { createUploadSession: unknown }).createUploadSession =
    async (name: string, parentId: string, mimeType: string, size: number, origin: string) => {
      opened.push({ name, parentId, mimeType, size, origin });
      return `https://upload.example/${opened.length}`;
    };
}

/** What the browser's PUTs achieve: the file, in Drive, where the session put it. */
async function browserUploads(content = "video-bytes", at = opened[opened.length - 1]) {
  const local = path.join(scratch, `${Math.random().toString(36).slice(2)}.mp4`);
  await fs.writeFile(local, content);
  const { client } = getDriveClient();
  return client.uploadBinaryFile(at.name, at.parentId, local, at.mimeType);
}

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nerve-direct-"));
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), "nerve-direct-src-"));
  (config.drive as { localRoot: string }).localRoot = tmpRoot;
  (config.drive as { rootFolderId: string }).rootFolderId = "";
  (config.drive as { serviceAccountEmail: string }).serviceAccountEmail = "";
  (config.drive as { oauthClientId: string }).oauthClientId = "";
  resetDriveClient();
  resetStoreState();
  resetUploadSessions();
  opened = [];
  editor = await addUser({ name: "Om Editor", email: "om@a.com", role: "editor" });
  other = await addUser({ name: "Ria Editor", email: "ria@a.com", role: "editor" });
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  await fs.rm(scratch, { recursive: true, force: true });
  resetDriveClient();
  resetStoreState();
  resetUploadSessions();
});

describe("starting a direct upload", () => {
  it("answers proxy on a Drive a browser cannot reach, reserving nothing", async () => {
    expect(await startDirectUpload(details(), "http://localhost:5173")).toEqual({ mode: "proxy" });
    expect(pendingUploadCount()).toBe(0);
    expect((await readWorkflow()).sequences ?? {}).toEqual({});
  });

  it("still refuses bad fields in proxy mode, before the browser sends the file", async () => {
    await expect(startDirectUpload(details({ caption: " " }), "o")).rejects.toThrow(/caption is required/);
    await expect(startDirectUpload(details({ editorTitle: "" }), "o")).rejects.toThrow(/title is required/);
    await expect(startDirectUpload(details({ campaignId: "nope" }), "o")).rejects.toThrow(/campaign was not found/);
    await expect(startDirectUpload(details({ sizeBytes: 1.5 }), "o")).rejects.toBeInstanceOf(VideoFileRejectedError);
    expect(pendingUploadCount()).toBe(0);
    expect((await readWorkflow()).sequences ?? {}).toEqual({});
  });

  it("opens a session for the final name in the campaign's Videos folder", async () => {
    enableDirect();
    const started = await startDirectUpload(details(), "https://nerve.example");
    expect(started).toMatchObject({ mode: "direct", uploadUrl: "https://upload.example/1", chunkBytes: DIRECT_UPLOAD_CHUNK_BYTES });
    expect(DIRECT_UPLOAD_CHUNK_BYTES % (256 * 1024)).toBe(0);
    expect(opened[0]).toMatchObject({ name: "VLF 2027 - Video 1.mp4", mimeType: "video/mp4", size: 11, origin: "https://nerve.example" });
    expect(opened[0].parentId).toMatch(/VLF 2027[/\\]Videos$/);
  });

  it("refuses what the multipart upload refuses", async () => {
    enableDirect();
    await expect(startDirectUpload(details({ originalName: "notes.pdf", mimeType: "application/pdf" }), "o"))
      .rejects.toBeInstanceOf(VideoFileRejectedError);
    await expect(startDirectUpload(details({ sizeBytes: 3 * 1024 ** 3 }), "o")).rejects.toMatchObject({ status: 413 });
    await expect(startDirectUpload(details({ caption: " " }), "o")).rejects.toThrow(/caption is required/);
    expect(pendingUploadCount()).toBe(0);
  });

  it("accepts a generic type on a video extension, stored as the real type", async () => {
    enableDirect();
    await startDirectUpload(details({ originalName: "take.mkv", mimeType: "application/octet-stream" }), "o");
    expect(opened[0]).toMatchObject({ name: "VLF 2027 - Video 1.mkv", mimeType: "video/x-matroska" });
  });
});

describe("completing a direct upload", () => {
  it("records the video once the file is verified, with its Drive description", async () => {
    enableDirect();
    const started = await startDirectUpload(details(), "o") as { sessionId: string };
    const file = await browserUploads();
    const video = await completeDirectUpload(started.sessionId, editor.id, file.id);

    expect(video).toMatchObject({ title: "VLF 2027 - Video 1", driveFileId: file.id, status: "uploaded", editorId: editor.id, sizeBytes: 11 });
    expect((await readWorkflow()).videos.map(v => v.id)).toEqual([video.id]);
    const { client } = getDriveClient();
    const description = await (client as LocalDriveClient).readDescription(file.id);
    expect(description).toContain("Come along");
    expect(description).toContain("Cut to 30s");
    expect(description).toContain("Om Editor");
  });

  it("is idempotent: completing again answers the same video", async () => {
    enableDirect();
    const started = await startDirectUpload(details(), "o") as { sessionId: string };
    const file = await browserUploads();
    const [a, b] = await Promise.all([
      completeDirectUpload(started.sessionId, editor.id, file.id),
      completeDirectUpload(started.sessionId, editor.id, file.id),
    ]);
    const c = await completeDirectUpload(started.sessionId, editor.id, file.id);
    expect(b.id).toBe(a.id);
    expect(c.id).toBe(a.id);
    expect((await readWorkflow()).videos).toHaveLength(1);
  });

  it("refuses a file whose size is not what was declared", async () => {
    enableDirect();
    const started = await startDirectUpload(details(), "o") as { sessionId: string };
    const file = await browserUploads("short");
    await expect(completeDirectUpload(started.sessionId, editor.id, file.id)).rejects.toBeInstanceOf(UploadVerificationError);
    expect((await readWorkflow()).videos).toHaveLength(0);
  });

  it("refuses a file that is not in the session's folder or not under its name", async () => {
    enableDirect();
    const started = await startDirectUpload(details(), "o") as { sessionId: string };
    const elsewhere = await browserUploads("video-bytes", { ...opened[0], parentId: "root" });
    await expect(completeDirectUpload(started.sessionId, editor.id, elsewhere.id)).rejects.toThrow(/Videos folder/);
    const renamed = await browserUploads("video-bytes", { ...opened[0], name: "Other.mp4" });
    await expect(completeDirectUpload(started.sessionId, editor.id, renamed.id)).rejects.toThrow(/not the one/);
    // The session stays open, so the real file can still complete it.
    const real = await browserUploads();
    expect((await completeDirectUpload(started.sessionId, editor.id, real.id)).driveFileId).toBe(real.id);
  });

  it("refuses a file id that is not shaped like a Drive id, without asking Drive", async () => {
    enableDirect();
    const { client } = getDriveClient();
    // Judge ids the way real Drive does; the local adapter's are paths.
    (client as LocalDriveClient).isFileId = GoogleDriveClient.prototype.isFileId;
    const asked: string[] = [];
    const getMeta = client.getMeta.bind(client);
    client.getMeta = async (id: string) => { asked.push(id); return getMeta(id); };
    const started = await startDirectUpload(details(), "o") as { sessionId: string };
    for (const bad of ["", "short", "../../etc/passwd", "abcdefghij?alt=media", "abcdefghij/../x", "a".repeat(201)]) {
      await expect(completeDirectUpload(started.sessionId, editor.id, bad), bad).rejects.toThrow("Drive did not report the uploaded file.");
    }
    expect(asked).toEqual([]);
    // A Drive-shaped id gets as far as asking Drive.
    await completeDirectUpload(started.sessionId, editor.id, "1AbC_dEf-GhIjKlMn").catch(() => undefined);
    expect(asked).toEqual(["1AbC_dEf-GhIjKlMn"]);
  });

  it("refuses an id the local adapter would resolve outside its root", async () => {
    enableDirect();
    const started = await startDirectUpload(details(), "o") as { sessionId: string };
    await expect(completeDirectUpload(started.sessionId, editor.id, "../../etc/passwd")).rejects.toBeInstanceOf(UploadVerificationError);
  });

  it("refuses another person's session", async () => {
    enableDirect();
    const started = await startDirectUpload(details(), "o") as { sessionId: string };
    const file = await browserUploads();
    await expect(completeDirectUpload(started.sessionId, other.id, file.id)).rejects.toBeInstanceOf(UploadSessionNotYoursError);
  });

  it("does not know a session it never opened, one cancelled, or one past a day old", async () => {
    enableDirect();
    await expect(completeDirectUpload("nope", editor.id, "x")).rejects.toBeInstanceOf(UploadSessionNotFoundError);

    const cancelled = await startDirectUpload(details(), "o") as { sessionId: string };
    cancelDirectUpload(cancelled.sessionId, other.id); // not theirs to cancel
    expect(pendingUploadCount()).toBe(1);
    cancelDirectUpload(cancelled.sessionId, editor.id);
    await expect(completeDirectUpload(cancelled.sessionId, editor.id, "x")).rejects.toBeInstanceOf(UploadSessionNotFoundError);

    const old = await startDirectUpload(details(), "o") as { sessionId: string };
    sweepUploadSessions(Date.now() + 25 * 60 * 60 * 1000);
    await expect(completeDirectUpload(old.sessionId, editor.id, "x")).rejects.toBeInstanceOf(UploadSessionNotFoundError);
  });
});
