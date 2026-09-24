// @vitest-environment node
/**
 * §16 Activity Logging — the merged, chronological feed.
 *
 * What matters here is that the feed says the same thing the per-record
 * timelines do (it's derived, so it can't drift), that it stays complete after
 * a user is deleted (§28: no workflow action erases historical activity), and
 * that an editor's view is scoped by whose record it is rather than by who
 * acted — otherwise an editor would stop seeing the publisher's action on
 * their own video.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { config } from "../config.js";
import { resetDriveClient } from "./drive-client.js";
import { resetStoreState } from "./drive-store.js";
import { addUser, deleteUser } from "./users.js";
import { uploadVideo, submitVideo, publishVideo } from "./videos.js";
import { createEvent, assignEvent, completeEvent } from "./events.js";
import { activityFeed, activityActors } from "./activity.js";
import type { VideoUser } from "./types.js";

let tmpRoot: string;
let scratch: string;
let manager: VideoUser;
let editorA: VideoUser;
let editorB: VideoUser;
let publisher: VideoUser;

let counter = 0;
async function upload(who: VideoUser, client: string) {
  const p = path.join(scratch, `f${counter++}.mp4`);
  await fs.writeFile(p, "video-bytes", "utf8");
  return uploadVideo({
    editor: who, client, editorTitle: "A title", caption: "A caption",
    localPath: p, originalName: "clip.mp4", mimeType: "video/mp4", sizeBytes: 11,
  });
}

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nerve-activity-"));
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), "nerve-activity-scratch-"));
  (config.drive as { localRoot: string }).localRoot = tmpRoot;
  (config.drive as { rootFolderId: string }).rootFolderId = "";
  (config.drive as { serviceAccountEmail: string }).serviceAccountEmail = "";
  (config.drive as { oauthClientId: string }).oauthClientId = "";
  resetDriveClient();
  resetStoreState();
  manager = await addUser({ name: "The Manager", email: "m@agency.com", role: "manager" });
  editorA = await addUser({ name: "Alice Editor", email: "a@agency.com", role: "editor" });
  editorB = await addUser({ name: "Bob Editor", email: "b@agency.com", role: "editor" });
  publisher = await addUser({ name: "Pat Publisher", email: "p@agency.com", role: "publisher" });
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  await fs.rm(scratch, { recursive: true, force: true });
  resetDriveClient();
  resetStoreState();
});

describe("§16 — the merged activity feed", () => {
  it("is empty rather than broken when nothing has happened", async () => {
    expect(await activityFeed()).toEqual([]);
  });

  it("carries both video and event activity, newest first", async () => {
    const v = await upload(editorA, "Client A");
    await submitVideo(v.id, editorA);
    const e = await createEvent(manager, { title: "Shoot", description: "", date: "2099-01-01", client: null });
    await assignEvent(e.id, editorA.id, manager);

    const feed = await activityFeed();
    expect(feed.map(f => f.subject.type)).toContain("video");
    expect(feed.map(f => f.subject.type)).toContain("event");
    const times = feed.map(f => f.timestamp);
    expect([...times].sort((a, b) => b.localeCompare(a))).toEqual(times);
  });

  it("names the subject so the entry can be linked back to it", async () => {
    const v = await upload(editorA, "Client A");
    const [entry] = await activityFeed({ subjectType: "video" });
    expect(entry.subject).toEqual({ type: "video", id: v.id, title: "Client A Video 1" });
  });

  it("can narrow to videos or to events", async () => {
    await upload(editorA, "Client A");
    await createEvent(manager, { title: "Shoot", description: "", date: "2099-01-01", client: null });

    expect((await activityFeed({ subjectType: "video" })).every(e => e.subject.type === "video")).toBe(true);
    expect((await activityFeed({ subjectType: "event" })).every(e => e.subject.type === "event")).toBe(true);
  });

  it("filters by who acted", async () => {
    const v = await upload(editorA, "Client A");
    await submitVideo(v.id, editorA);
    await publishVideo(v.id, publisher, {});

    const byPublisher = await activityFeed({ userId: publisher.id });
    expect(byPublisher).toHaveLength(1);
    expect(byPublisher[0].userName).toBe("Pat Publisher");
  });

  it("searches the action, the actor and the subject title", async () => {
    const v = await upload(editorA, "Convocation");
    await submitVideo(v.id, editorA);

    expect((await activityFeed({ q: "convocation" })).length).toBeGreaterThan(0);
    expect((await activityFeed({ q: "alice" })).length).toBeGreaterThan(0);
    expect((await activityFeed({ q: "submitted" })).length).toBeGreaterThan(0);
    expect(await activityFeed({ q: "no such thing" })).toEqual([]);
  });

  it("records the status change on a transition (§16 previous/new status)", async () => {
    const v = await upload(editorA, "Client A");
    await submitVideo(v.id, editorA);

    const submitted = (await activityFeed()).find(e => e.action.includes("submitted"));
    expect(submitted?.previousStatus).toBe("draft");
    expect(submitted?.newStatus).toBe("submitted");
  });

  it("caps the feed, and honours a smaller limit", async () => {
    for (let i = 0; i < 5; i++) await upload(editorA, `Client ${i}`);
    expect(await activityFeed({ limit: 2 })).toHaveLength(2);
  });
});

describe("§25 — an editor's scope", () => {
  it("shows an editor their own video's history but not another editor's", async () => {
    await upload(editorA, "Client A");
    await upload(editorB, "Client B");

    const feed = await activityFeed({}, { onlyEditorId: editorA.id });
    expect(feed.map(e => e.subject.title)).toEqual(["Client A Video 1"]);
  });

  it("still shows the publisher's action on the editor's own video", async () => {
    const v = await upload(editorA, "Client A");
    await submitVideo(v.id, editorA);
    await publishVideo(v.id, publisher, {});

    const feed = await activityFeed({}, { onlyEditorId: editorA.id });
    expect(feed.some(e => e.userId === publisher.id)).toBe(true);
  });

  it("shows only the events assigned to that editor", async () => {
    const mine = await createEvent(manager, { title: "Mine", description: "", date: "2099-01-01", client: null });
    const theirs = await createEvent(manager, { title: "Theirs", description: "", date: "2099-01-02", client: null });
    await assignEvent(mine.id, editorA.id, manager);
    await assignEvent(theirs.id, editorB.id, manager);
    await completeEvent(mine.id, editorA);

    const feed = await activityFeed({ subjectType: "event" }, { onlyEditorId: editorA.id });
    expect(new Set(feed.map(e => e.subject.title))).toEqual(new Set(["Mine"]));
  });
});

describe("§28 — history survives", () => {
  it("keeps a deleted user's entries, still carrying their name", async () => {
    const v = await upload(editorA, "Client A");
    await submitVideo(v.id, editorA);
    await deleteUser(editorA.id);

    const feed = await activityFeed();
    expect(feed.length).toBeGreaterThan(0);
    expect(feed.every(e => e.userName === "Alice Editor")).toBe(true);
  });

  it("lists everyone who appears in the feed, deleted or not", async () => {
    const v = await upload(editorA, "Client A");
    await submitVideo(v.id, editorA);
    await publishVideo(v.id, publisher, {});
    await deleteUser(editorA.id);

    const actors = await activityActors();
    expect(actors.map(a => a.name)).toEqual(["Alice Editor", "Pat Publisher"]);
  });
});
