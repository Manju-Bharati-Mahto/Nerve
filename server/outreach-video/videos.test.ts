// @vitest-environment node
/**
 * §9 / §9.1 upload and auto-naming, §7 transitions, §15 publishing.
 *
 * The naming tests carry the most weight: §9.1 says numbering must be tracked
 * "so names never clash", and with Drive as the database that guarantee is
 * entirely ours to keep — two editors uploading to one campaign at the same
 * moment is exactly where a naive implementation hands out the same name twice.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { config } from "../config.js";
import { resetDriveClient } from "./drive-client.js";
import { resetStoreState, VIDEOS_FOLDER, readWorkflow } from "./drive-store.js";
import { addUser } from "./users.js";
import {
  uploadVideo, submitVideo, publishVideo, updateCaption, setLiveUrls,
  listVideos, getVideo, publishingQueue, campaignVideoName,
  InvalidTransitionError, NotYourVideoError, VideoNotFoundError,
} from "./videos.js";
import type { VideoUser } from "./types.js";

let tmpRoot: string;
let scratch: string;
let editor: VideoUser;
let otherEditor: VideoUser;
let publisher: VideoUser;

/** A stand-in for the multer temp file an upload would arrive with. */
async function fakeVideoFile(name = "clip.mp4", bytes = "video-bytes"): Promise<string> {
  const p = path.join(scratch, name);
  await fs.writeFile(p, bytes, "utf8");
  return p;
}

async function upload(who: VideoUser, client: string, title = "My title", caption = "A caption") {
  return uploadVideo({
    editor: who, client, editorTitle: title, caption,
    localPath: await fakeVideoFile(`${randomName()}.mp4`),
    originalName: "clip.mp4", mimeType: "video/mp4", sizeBytes: 11,
  });
}

let counter = 0;
function randomName() { return `f${counter++}`; }

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nerve-videos-"));
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), "nerve-scratch-"));
  (config.drive as { localRoot: string }).localRoot = tmpRoot;
  (config.drive as { rootFolderId: string }).rootFolderId = "";
  (config.drive as { serviceAccountEmail: string }).serviceAccountEmail = "";
  (config.drive as { oauthClientId: string }).oauthClientId = "";
  resetDriveClient();
  resetStoreState();
  editor = await addUser({ name: "Editor One", email: "e1@agency.com", role: "editor" });
  otherEditor = await addUser({ name: "Editor Two", email: "e2@agency.com", role: "editor" });
  publisher = await addUser({ name: "Publisher", email: "pub@agency.com", role: "publisher" });
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  await fs.rm(scratch, { recursive: true, force: true });
  resetDriveClient();
  resetStoreState();
});

describe("§9.1 campaign folder and auto-naming", () => {
  it("creates the campaign folder under Videos/ and puts the file in it", async () => {
    await upload(editor, "Client A");
    const stat = await fs.stat(path.join(tmpRoot, VIDEOS_FOLDER, "Client A"));
    expect(stat.isDirectory()).toBe(true);
  });

  it("names files sequentially per campaign", async () => {
    const first = await upload(editor, "Client A");
    const second = await upload(editor, "Client A");
    expect(first.title).toBe("Client A Video 1");
    expect(second.title).toBe("Client A Video 2");
  });

  it("numbers each campaign independently", async () => {
    await upload(editor, "Client A");
    const otherCampaign = await upload(editor, "Client B");
    expect(otherCampaign.title).toBe("Client B Video 1");
  });

  it("stores the auto-generated name as the Title, keeping the editor's wording too", async () => {
    const v = await upload(editor, "Client A", "Diwali teaser cut 3");
    expect(v.title).toBe("Client A Video 1");       // §9.1
    expect(v.editorTitle).toBe("Diwali teaser cut 3"); // §9
  });

  it("never hands out the same name twice under concurrent uploads to one campaign", async () => {
    // The clash §9.1 forbids. Without atomic reservation these collide.
    const uploads = await Promise.all(
      Array.from({ length: 8 }, () => upload(editor, "Busy Client")),
    );
    const names = uploads.map(v => v.title);
    expect(new Set(names).size).toBe(names.length);
  });

  it("writes a caption sidecar whose name matches the video's exactly", async () => {
    const v = await upload(editor, "Client A", "t", "the caption text");
    const captionPath = path.join(tmpRoot, VIDEOS_FOLDER, "Client A", `${v.title}.txt`);
    expect(await fs.readFile(captionPath, "utf8")).toBe("the caption text");
    expect(v.captionFileId).toBeTruthy();
  });

  it("builds names in the documented shape", () => {
    expect(campaignVideoName("Client A", 3)).toBe("Client A Video 3");
  });
});

describe("§9 required fields", () => {
  it("refuses an upload with no caption", async () => {
    await expect(uploadVideo({
      editor, client: "Client A", editorTitle: "t", caption: "  ",
      localPath: await fakeVideoFile(), originalName: "c.mp4", mimeType: "video/mp4", sizeBytes: 1,
    })).rejects.toThrow(/caption is required/i);
  });

  it("refuses an upload with no client / project", async () => {
    await expect(uploadVideo({
      editor, client: "   ", editorTitle: "t", caption: "c",
      localPath: await fakeVideoFile(), originalName: "c.mp4", mimeType: "video/mp4", sizeBytes: 1,
    })).rejects.toThrow(/client \/ project/i);
  });
});

describe("§7 status transitions", () => {
  it("lands in Draft so the caption can still be edited (§17)", async () => {
    const v = await upload(editor, "Client A");
    expect(v.status).toBe("draft");
  });

  it("submits a draft, which is what puts it in the publisher's queue", async () => {
    const v = await upload(editor, "Client A");
    const submitted = await submitVideo(v.id, editor);
    expect(submitted.status).toBe("submitted");
    expect(submitted.submittedAt).toBeTruthy();
    expect((await publishingQueue()).map(q => q.id)).toEqual([v.id]);
  });

  it("refuses to submit twice", async () => {
    const v = await upload(editor, "Client A");
    await submitVideo(v.id, editor);
    await expect(submitVideo(v.id, editor)).rejects.toBeInstanceOf(InvalidTransitionError);
  });

  it("refuses to publish something still in draft — the queue is submitted-only", async () => {
    const v = await upload(editor, "Client A");
    await expect(publishVideo(v.id, publisher)).rejects.toBeInstanceOf(InvalidTransitionError);
  });

  it("has no route back out of published", async () => {
    const v = await upload(editor, "Client A");
    await submitVideo(v.id, editor);
    await publishVideo(v.id, publisher);
    await expect(submitVideo(v.id, editor)).rejects.toBeInstanceOf(InvalidTransitionError);
  });

  it("drops a published video out of the active queue (§28)", async () => {
    const v = await upload(editor, "Client A");
    await submitVideo(v.id, editor);
    await publishVideo(v.id, publisher);
    expect(await publishingQueue()).toHaveLength(0);
  });
});

describe("ownership", () => {
  it("stops an editor submitting someone else's video", async () => {
    const v = await upload(editor, "Client A");
    await expect(submitVideo(v.id, otherEditor)).rejects.toBeInstanceOf(NotYourVideoError);
  });

  it("stops an editor rewriting someone else's caption", async () => {
    const v = await upload(editor, "Client A");
    await expect(updateCaption(v.id, "hijacked", otherEditor)).rejects.toBeInstanceOf(NotYourVideoError);
  });

  it("raises a clear error for a video that doesn't exist", async () => {
    await expect(getVideo("nope")).rejects.toBeInstanceOf(VideoNotFoundError);
  });
});

describe("§17 captions", () => {
  it("can be rewritten while still a draft, and updates the Drive sidecar", async () => {
    const v = await upload(editor, "Client A", "t", "first");
    await updateCaption(v.id, "second", editor);
    expect((await getVideo(v.id)).caption).toBe("second");
    const captionPath = path.join(tmpRoot, VIDEOS_FOLDER, "Client A", `${v.title}.txt`);
    expect(await fs.readFile(captionPath, "utf8")).toBe("second");
  });

  it("is frozen once submitted — it is what the publisher is about to post", async () => {
    const v = await upload(editor, "Client A");
    await submitVideo(v.id, editor);
    await expect(updateCaption(v.id, "too late", editor)).rejects.toThrow(/still a draft/i);
  });

  it("survives publication (§17 'the final caption remains stored')", async () => {
    const v = await upload(editor, "Client A", "t", "the caption");
    await submitVideo(v.id, editor);
    await publishVideo(v.id, publisher);
    expect((await getVideo(v.id)).caption).toBe("the caption");
  });
});

describe("§15.1 live URLs", () => {
  it("records them at publish time and notes the publisher", async () => {
    const v = await upload(editor, "Client A");
    await submitVideo(v.id, editor);
    const published = await publishVideo(v.id, publisher, {
      instagram: "https://www.instagram.com/p/ABC123/",
    });
    expect(published.liveUrls?.instagram).toBe("https://www.instagram.com/p/ABC123/");
    expect(published.publishedBy).toBe(publisher.id);
    expect(published.publishedAt).toBeTruthy();
  });

  it("treats both platforms as optional — publishing without any URL is fine", async () => {
    const v = await upload(editor, "Client A");
    await submitVideo(v.id, editor);
    const published = await publishVideo(v.id, publisher);
    expect(published.status).toBe("published");
    expect(published.liveUrls).toEqual({});
  });

  it("accepts a URL added later, for a platform posted after the fact", async () => {
    const v = await upload(editor, "Client A");
    await submitVideo(v.id, editor);
    await publishVideo(v.id, publisher, { instagram: "https://www.instagram.com/p/A/" });
    const updated = await setLiveUrls(v.id, publisher, { facebook: "https://www.facebook.com/reel/1/" });
    expect(updated.liveUrls).toEqual({
      instagram: "https://www.instagram.com/p/A/",
      facebook: "https://www.facebook.com/reel/1/",
    });
  });

  it("removes a URL when it is cleared", async () => {
    const v = await upload(editor, "Client A");
    await submitVideo(v.id, editor);
    await publishVideo(v.id, publisher, { instagram: "https://www.instagram.com/p/A/" });
    const updated = await setLiveUrls(v.id, publisher, { instagram: "" });
    expect(updated.liveUrls?.instagram).toBeUndefined();
  });
});

describe("§16 activity trail", () => {
  it("records every step with the actor snapshotted, and never rewrites history", async () => {
    const v = await upload(editor, "Client A");
    await submitVideo(v.id, editor);
    await publishVideo(v.id, publisher);

    const actions = (await getVideo(v.id)).activity.map(a => a.action);
    expect(actions).toEqual(["video.uploaded", "video.submitted", "video.published"]);

    const submitEntry = (await getVideo(v.id)).activity.find(a => a.action === "video.submitted")!;
    expect(submitEntry.userName).toBe("Editor One");
    expect(submitEntry.previousStatus).toBe("draft");
    expect(submitEntry.newStatus).toBe("submitted");
  });
});

describe("listing", () => {
  it("scopes to one editor's own videos", async () => {
    await upload(editor, "Client A");
    await upload(otherEditor, "Client A");
    const mine = await listVideos({ editorId: editor.id });
    expect(mine).toHaveLength(1);
    expect(mine[0].editorId).toBe(editor.id);
  });

  it("filters by status and by campaign", async () => {
    const a = await upload(editor, "Client A");
    await upload(editor, "Client B");
    await submitVideo(a.id, editor);
    expect(await listVideos({ status: "submitted" })).toHaveLength(1);
    expect(await listVideos({ client: "Client B" })).toHaveLength(1);
  });
});

describe("store integrity", () => {
  it("keeps the per-campaign counter in the store, so a gap never becomes a clash", async () => {
    await upload(editor, "Client A");
    await upload(editor, "Client A");
    const doc = await readWorkflow();
    expect(doc.sequences?.["client a"]).toBe(2);
  });
});
