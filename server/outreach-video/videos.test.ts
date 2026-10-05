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
  approveVideo, rejectVideo, startRevision, scheduleVideo, reviewQueue,
  InvalidTransitionError, NotYourVideoError, VideoNotFoundError,
} from "./videos.js";
import type { VideoUser } from "./types.js";

let tmpRoot: string;
let scratch: string;
let editor: VideoUser;
let otherEditor: VideoUser;
let publisher: VideoUser;
/** §11 — the reviewer who approves or rejects. */
let manager: VideoUser;

/** A stand-in for the multer temp file an upload would arrive with. */
async function fakeVideoFile(name = "clip.mp4", bytes = "video-bytes"): Promise<string> {
  const p = path.join(scratch, name);
  await fs.writeFile(p, bytes, "utf8");
  return p;
}

/** §11 — submit, then approve, which is what releases work to a publisher. */
async function readyToPublish(id: string) {
  await submitVideo(id, editor);
  return approveVideo(id, manager);
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
  manager = await addUser({ name: "Manager", email: "mgr@agency.com", role: "manager" });
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  await fs.rm(scratch, { recursive: true, force: true });
  resetDriveClient();
  resetStoreState();
});

/** Where the PRD §9 tree puts a campaign's things, under the Drive root. */
const tree = (campaign: string, sub: "Videos" | "Captions" | "Published") =>
  path.join(tmpRoot, "Social Media Campaigns", campaign, sub);

describe("§9/§10 campaign folders and naming", () => {
  it("files the video under Social Media Campaigns/<campaign>/Videos", async () => {
    const v = await upload(editor, "Client A");
    const files = await fs.readdir(tree("Client A", "Videos"));
    expect(files).toContain(`${v.title}.mp4`);
  });

  it("creates the whole tree — Videos, Captions and Published", async () => {
    await upload(editor, "Client A");
    for (const sub of ["Videos", "Captions", "Published"] as const) {
      expect((await fs.stat(tree("Client A", sub))).isDirectory(), sub).toBe(true);
    }
  });

  it("names files the §10 way, sequentially per campaign", async () => {
    const first = await upload(editor, "Client A");
    const second = await upload(editor, "Client A");
    expect(first.title).toBe("Client A - Video 1");
    expect(second.title).toBe("Client A - Video 2");
    expect(first.sequence).toBe(1);
  });

  it("numbers each campaign independently", async () => {
    await upload(editor, "Client A");
    const otherCampaign = await upload(editor, "Client B");
    expect(otherCampaign.title).toBe("Client B - Video 1");
  });

  it("stores the auto-generated name as the Title, keeping the editor's wording too", async () => {
    const v = await upload(editor, "Client A", "Diwali teaser cut 3");
    expect(v.title).toBe("Client A - Video 1");
    expect(v.editorTitle).toBe("Diwali teaser cut 3");
  });

  it("never hands out the same name twice under concurrent uploads to one campaign", async () => {
    // The clash §10 forbids. Without atomic reservation these collide.
    const uploads = await Promise.all(
      Array.from({ length: 8 }, () => upload(editor, "Busy Client")),
    );
    const names = uploads.map(v => v.title);
    expect(new Set(names).size).toBe(names.length);
  });

  it("creates exactly one campaign folder under concurrent uploads", async () => {
    // Folder creation is find-then-create; on Google Drive two simultaneous
    // creates would leave two "Busy Client" folders. Locally the filesystem
    // would hide that, so the check is that every file landed in ONE folder.
    await Promise.all(Array.from({ length: 6 }, () => upload(editor, "Busy Client")));
    const campaigns = await fs.readdir(path.join(tmpRoot, "Social Media Campaigns"));
    expect(campaigns.filter(c => c === "Busy Client")).toHaveLength(1);
    expect((await fs.readdir(tree("Busy Client", "Videos"))).filter(f => f.endsWith(".mp4"))).toHaveLength(6);
  });

  it("writes the caption file into Captions/, named exactly like the video", async () => {
    const v = await upload(editor, "Client A", "t", "the caption text");
    const body = await fs.readFile(path.join(tree("Client A", "Captions"), `${v.title}.txt`), "utf8");
    // §10: campaign, video number, platform/page and the complete caption.
    expect(body).toContain("Campaign: Client A");
    expect(body).toContain("Video Number: 1");
    expect(body).toContain("Platform/Page:");
    expect(body).toContain("the caption text");
    expect(v.captionFileId).toBeTruthy();
  });

  it("still builds the older name shape, for records from before", () => {
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

describe("§11 status transitions", () => {
  it("lands in Uploaded so the caption can still be edited", async () => {
    const v = await upload(editor, "Client A");
    expect(v.status).toBe("uploaded");
  });

  it("submits for review rather than straight to the publisher", async () => {
    const v = await upload(editor, "Client A");
    const submitted = await submitVideo(v.id, editor);
    expect(submitted.status).toBe("under_review");
    expect(submitted.submittedAt).toBeTruthy();
    // The whole point of §11: it is NOT publishable yet.
    expect(await publishingQueue()).toHaveLength(0);
    expect((await reviewQueue()).map(q => q.id)).toEqual([v.id]);
  });

  it("reaches the publisher's queue only once approved", async () => {
    const v = await upload(editor, "Client A");
    await readyToPublish(v.id);
    expect((await publishingQueue()).map(q => q.id)).toEqual([v.id]);
    expect(await reviewQueue()).toHaveLength(0);
  });

  it("refuses to submit twice", async () => {
    const v = await upload(editor, "Client A");
    await submitVideo(v.id, editor);
    await expect(submitVideo(v.id, editor)).rejects.toBeInstanceOf(InvalidTransitionError);
  });

  it("refuses to publish something nobody has reviewed", async () => {
    const v = await upload(editor, "Client A");
    await expect(publishVideo(v.id, publisher)).rejects.toBeInstanceOf(InvalidTransitionError);
    await submitVideo(v.id, editor);
    await expect(publishVideo(v.id, publisher)).rejects.toBeInstanceOf(InvalidTransitionError);
  });

  it("has no route back out of published", async () => {
    const v = await upload(editor, "Client A");
    await readyToPublish(v.id);
    await publishVideo(v.id, publisher);
    await expect(submitVideo(v.id, editor)).rejects.toBeInstanceOf(InvalidTransitionError);
    await expect(rejectVideo(v.id, manager, "too late")).rejects.toBeInstanceOf(InvalidTransitionError);
  });

  it("drops a published video out of the active queue (§28)", async () => {
    const v = await upload(editor, "Client A");
    await readyToPublish(v.id);
    await publishVideo(v.id, publisher);
    expect(await publishingQueue()).toHaveLength(0);
  });
});

describe("§11 the rejection loop", () => {
  it("sends work back with a reason the editor can read", async () => {
    const v = await upload(editor, "Client A");
    await submitVideo(v.id, editor);
    const rejected = await rejectVideo(v.id, manager, "Logo is the old one");
    expect(rejected.status).toBe("rejected");
    expect(rejected.rejectionReason).toBe("Logo is the old one");
  });

  it("will not let a reviewer reject without saying why", async () => {
    const v = await upload(editor, "Client A");
    await submitVideo(v.id, editor);
    await expect(rejectVideo(v.id, manager, "   ")).rejects.toThrow(/reason is required/i);
  });

  it("walks rejected → revision → under review, and the reason stops applying", async () => {
    const v = await upload(editor, "Client A");
    await submitVideo(v.id, editor);
    await rejectVideo(v.id, manager, "Logo is the old one");

    const revising = await startRevision(v.id, editor);
    expect(revising.status).toBe("revision");
    expect(revising.currentVersion).toBe(2);

    const resubmitted = await submitVideo(v.id, editor);
    expect(resubmitted.status).toBe("under_review");
    // Stale complaints about work already redone would mislead the editor.
    expect(resubmitted.rejectionReason).toBeNull();
  });

  it("lets the editor fix the caption while revising, but not while under review", async () => {
    const v = await upload(editor, "Client A");
    await submitVideo(v.id, editor);
    await expect(updateCaption(v.id, "sneaky edit", editor))
      .rejects.toThrow(/only be changed/i);

    await rejectVideo(v.id, manager, "Caption wrong");
    await startRevision(v.id, editor);
    const fixed = await updateCaption(v.id, "corrected caption", editor);
    expect(fixed.caption).toBe("corrected caption");
  });

  it("refuses to revise something that was never rejected", async () => {
    const v = await upload(editor, "Client A");
    await expect(startRevision(v.id, editor)).rejects.toBeInstanceOf(InvalidTransitionError);
  });
});

describe("§4 scheduling", () => {
  it("records the posting time a publisher sets on approved work", async () => {
    const v = await upload(editor, "Client A");
    await readyToPublish(v.id);
    const scheduled = await scheduleVideo(v.id, publisher, "2027-02-01T09:30:00.000Z");
    expect(scheduled.status).toBe("scheduled");
    expect(scheduled.scheduledFor).toBe("2027-02-01T09:30:00.000Z");
  });

  it("keeps scheduled work in the publisher's queue — it has not gone out yet", async () => {
    const v = await upload(editor, "Client A");
    await readyToPublish(v.id);
    await scheduleVideo(v.id, publisher, "2027-02-01T09:30:00.000Z");
    expect((await publishingQueue()).map(q => q.id)).toEqual([v.id]);
  });

  it("allows rescheduling without a status change", async () => {
    const v = await upload(editor, "Client A");
    await readyToPublish(v.id);
    await scheduleVideo(v.id, publisher, "2027-02-01T09:30:00.000Z");
    const moved = await scheduleVideo(v.id, publisher, "2027-02-03T09:30:00.000Z");
    expect(moved.scheduledFor).toBe("2027-02-03T09:30:00.000Z");
  });

  it("refuses a schedule that is not a real date", async () => {
    const v = await upload(editor, "Client A");
    await readyToPublish(v.id);
    await expect(scheduleVideo(v.id, publisher, "next tuesday")).rejects.toThrow(/valid posting date/i);
  });

  it("refuses to schedule work nobody approved", async () => {
    const v = await upload(editor, "Client A");
    await expect(scheduleVideo(v.id, publisher, "2027-02-01T09:30:00.000Z"))
      .rejects.toBeInstanceOf(InvalidTransitionError);
  });

  it("lets an approved video be published without ever being scheduled (§4)", async () => {
    const v = await upload(editor, "Client A");
    await readyToPublish(v.id);
    const published = await publishVideo(v.id, publisher);
    expect(published.status).toBe("published");
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
  it("can be rewritten before submission, and updates the Drive caption file", async () => {
    const v = await upload(editor, "Client A", "t", "first");
    await updateCaption(v.id, "second", editor);
    expect((await getVideo(v.id)).caption).toBe("second");
    const body = await fs.readFile(
      path.join(tmpRoot, "Social Media Campaigns", "Client A", "Captions", `${v.title}.txt`), "utf8");
    expect(body).toContain("second");
    expect(body).not.toContain("\nfirst\n");
  });

  it("is frozen once submitted — it is what the publisher is about to post", async () => {
    const v = await upload(editor, "Client A");
    await submitVideo(v.id, editor);
    await expect(updateCaption(v.id, "too late", editor)).rejects.toThrow(/only be changed/i);
  });

  it("survives publication (§17 'the final caption remains stored')", async () => {
    const v = await upload(editor, "Client A", "t", "the caption");
    await submitVideo(v.id, editor);
    await approveVideo(v.id, manager);
    await publishVideo(v.id, publisher);
    expect((await getVideo(v.id)).caption).toBe("the caption");
  });
});

describe("§15.1 live URLs", () => {
  it("records them at publish time and notes the publisher", async () => {
    const v = await upload(editor, "Client A");
    await submitVideo(v.id, editor);
    await approveVideo(v.id, manager);
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
    await approveVideo(v.id, manager);
    const published = await publishVideo(v.id, publisher);
    expect(published.status).toBe("published");
    expect(published.liveUrls).toEqual({});
  });

  it("accepts a URL added later, for a platform posted after the fact", async () => {
    const v = await upload(editor, "Client A");
    await submitVideo(v.id, editor);
    await approveVideo(v.id, manager);
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
    await approveVideo(v.id, manager);
    await publishVideo(v.id, publisher, { instagram: "https://www.instagram.com/p/A/" });
    const updated = await setLiveUrls(v.id, publisher, { instagram: "" });
    expect(updated.liveUrls?.instagram).toBeUndefined();
  });
});

describe("§16 activity trail", () => {
  it("records every step with the actor snapshotted, and never rewrites history", async () => {
    const v = await upload(editor, "Client A");
    await submitVideo(v.id, editor);
    await approveVideo(v.id, manager);
    await publishVideo(v.id, publisher);

    const actions = (await getVideo(v.id)).activity.map(a => a.action);
    // §11 put a review step between submission and publication, so the trail
    // has one more entry than it used to — and it is the approval.
    expect(actions).toEqual([
      "video.uploaded", "video.submitted", "video.approved", "video.published",
    ]);

    const submitEntry = (await getVideo(v.id)).activity.find(a => a.action === "video.submitted")!;
    expect(submitEntry.userName).toBe("Editor One");
    expect(submitEntry.previousStatus).toBe("uploaded");
    expect(submitEntry.newStatus).toBe("under_review");

    const approveEntry = (await getVideo(v.id)).activity.find(a => a.action === "video.approved")!;
    expect(approveEntry.userName).toBe("Manager");
    expect(approveEntry.previousStatus).toBe("under_review");
    expect(approveEntry.newStatus).toBe("approved");
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
    expect(await listVideos({ status: "under_review" })).toHaveLength(1);
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
