// @vitest-environment node
/**
 * §20 KPI dashboard, §11.3 / §14.1 Editor Video Log and §18 search.
 *
 * These are the parts people will quote at each other in a meeting, so the
 * cases worth pinning down are the ones where a plausible-looking number would
 * be wrong: a mean taken over videos that never made the transition, "this
 * week" quietly meaning "the last seven days", a month boundary computed in UTC
 * for a team that isn't, and a search filter that an editor could widen.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { config } from "../config.js";
import { resetDriveClient } from "./drive-client.js";
import { mutateWorkflow, resetStoreState } from "./drive-store.js";
import { addUser, deleteUser } from "./users.js";
import { uploadVideo, submitVideo, publishVideo } from "./videos.js";
import { createEvent, assignEvent, completeEvent } from "./events.js";
import { workflowKpis, editorVideoLog } from "./reports.js";
import { search, filterOptions } from "./search.js";
import type { VideoUser } from "./types.js";

let tmpRoot: string;
let scratch: string;
let manager: VideoUser;
let editorA: VideoUser;
let editorB: VideoUser;
let publisher: VideoUser;

let counter = 0;
async function fakeVideoFile(): Promise<string> {
  const p = path.join(scratch, `f${counter++}.mp4`);
  await fs.writeFile(p, "video-bytes", "utf8");
  return p;
}

async function upload(who: VideoUser, client: string, title = "A title") {
  return uploadVideo({
    editor: who, client, editorTitle: title, caption: "A caption",
    localPath: await fakeVideoFile(), originalName: "clip.mp4",
    mimeType: "video/mp4", sizeBytes: 11,
  });
}

/** Rewrites a video's timestamps so a test can place it in time deliberately. */
async function backdate(id: string, patch: Partial<Record<"createdAt" | "submittedAt" | "publishedAt", string>>) {
  await mutateWorkflow<void>(doc => {
    const v = doc.videos.find(v => v.id === id);
    if (v) Object.assign(v, patch);
    return { doc, result: undefined };
  });
}

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nerve-reports-"));
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), "nerve-reports-scratch-"));
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

describe("§20 — video KPIs", () => {
  it("counts an empty workflow as zeros rather than failing", async () => {
    const k = await workflowKpis();
    expect(k.totalVideos).toBe(0);
    expect(k.publishedThisWeek).toBe(0);
    expect(k.videosByEditor).toEqual([]);
  });

  it("counts each status separately", async () => {
    await upload(editorA, "Client A");
    const b = await upload(editorA, "Client A");
    const c = await upload(editorB, "Client B");
    await submitVideo(b.id, editorA);
    await submitVideo(c.id, editorB);
    await publishVideo(c.id, publisher, {});

    const k = await workflowKpis();
    expect(k.totalVideos).toBe(3);
    expect(k.draftVideos).toBe(1);
    expect(k.submittedVideos).toBe(1);
    expect(k.publishedVideos).toBe(1);
  });

  it("averages only the videos that actually made the transition", async () => {
    const a = await upload(editorA, "Client A");
    await upload(editorA, "Client A"); // never submitted — must not count as 0 hours
    await submitVideo(a.id, editorA);
    await backdate(a.id, { createdAt: "2026-09-01T00:00:00.000Z", submittedAt: "2026-09-01T06:00:00.000Z" });

    const k = await workflowKpis();
    expect(k.avgDraftToSubmittedHours).toBe(6);
    // Nothing has been published, so there is no mean to report — not zero.
    expect(k.avgSubmittedToPublishedHours).toBeNull();
  });

  it("means across several videos rather than taking the newest", async () => {
    const a = await upload(editorA, "Client A");
    const b = await upload(editorA, "Client A");
    await submitVideo(a.id, editorA);
    await submitVideo(b.id, editorA);
    await backdate(a.id, { createdAt: "2026-09-01T00:00:00.000Z", submittedAt: "2026-09-01T02:00:00.000Z" });
    await backdate(b.id, { createdAt: "2026-09-01T00:00:00.000Z", submittedAt: "2026-09-01T08:00:00.000Z" });

    expect((await workflowKpis()).avgDraftToSubmittedHours).toBe(5);
  });

  it("counts this week from Monday, not from seven days ago", async () => {
    // Wednesday 16 September 2026, local.
    const wednesday = new Date(2026, 8, 16, 12, 0, 0);
    const a = await upload(editorA, "Client A");
    const b = await upload(editorA, "Client A");
    await submitVideo(a.id, editorA);
    await submitVideo(b.id, editorA);
    await publishVideo(a.id, publisher, {});
    await publishVideo(b.id, publisher, {});

    // Monday of that week, and the Friday before it — both inside "last 7 days",
    // only one inside "this week".
    await backdate(a.id, { publishedAt: new Date(2026, 8, 14, 9, 0, 0).toISOString() });
    await backdate(b.id, { publishedAt: new Date(2026, 8, 11, 9, 0, 0).toISOString() });

    const k = await workflowKpis(wednesday);
    expect(k.publishedThisWeek).toBe(1);
    expect(k.publishedThisMonth).toBe(2);
  });

  it("excludes last month from this month", async () => {
    const a = await upload(editorA, "Client A");
    await submitVideo(a.id, editorA);
    await publishVideo(a.id, publisher, {});
    await backdate(a.id, { publishedAt: new Date(2026, 7, 30, 9, 0, 0).toISOString() });

    expect((await workflowKpis(new Date(2026, 8, 16))).publishedThisMonth).toBe(0);
  });

  it("breaks videos down by editor and by client, busiest first", async () => {
    await upload(editorA, "Client A");
    await upload(editorA, "Client A");
    await upload(editorB, "Client B");

    const k = await workflowKpis();
    expect(k.videosByEditor.map(r => [r.label, r.count])).toEqual([
      ["Alice Editor", 2], ["Bob Editor", 1],
    ]);
    expect(k.videosByClient.map(r => [r.label, r.count])).toEqual([
      ["Client A", 2], ["Client B", 1],
    ]);
  });

  it("still names a deleted editor in the breakdown (§4.6)", async () => {
    await upload(editorA, "Client A");
    await deleteUser(editorA.id);

    const k = await workflowKpis();
    expect(k.videosByEditor).toEqual([{ key: editorA.id, label: "Alice Editor", count: 1 }]);
  });
});

describe("§20 — event KPIs", () => {
  it("splits upcoming from past on today's date", async () => {
    await createEvent(manager, { title: "Past", description: "", date: "2020-01-01", client: null });
    await createEvent(manager, { title: "Future", description: "", date: "2099-01-01", client: null });

    const k = await workflowKpis();
    expect(k.totalEvents).toBe(2);
    expect(k.pastEvents).toBe(1);
    expect(k.upcomingEvents).toBe(1);
  });

  it("counts unassigned and completed, and attributes events to editors", async () => {
    const one = await createEvent(manager, { title: "One", description: "", date: "2099-01-01", client: null });
    await createEvent(manager, { title: "Two", description: "", date: "2099-01-02", client: null });
    await assignEvent(one.id, editorA.id, manager);
    await completeEvent(one.id, editorA);

    const k = await workflowKpis();
    expect(k.unassignedEvents).toBe(1);
    expect(k.completedEvents).toBe(1);
    expect(k.eventsByEditor).toEqual([{ key: editorA.id, label: "Alice Editor", count: 1 }]);
  });
});

describe("§11.3 / §14.1 — monthly editor video log", () => {
  it("defaults to the newest month that has videos", async () => {
    const a = await upload(editorA, "Client A");
    await backdate(a.id, { createdAt: new Date(2026, 4, 10, 9, 0, 0).toISOString() });
    const b = await upload(editorB, "Client B");
    await backdate(b.id, { createdAt: new Date(2026, 7, 10, 9, 0, 0).toISOString() });

    const log = await editorVideoLog();
    expect(log.month).toBe("2026-08");
    expect(log.entries).toHaveLength(1);
    expect(log.availableMonths).toEqual(["2026-08", "2026-05"]);
  });

  it("filters to the month asked for", async () => {
    const a = await upload(editorA, "Client A");
    await backdate(a.id, { createdAt: new Date(2026, 4, 10, 9, 0, 0).toISOString() });
    const b = await upload(editorB, "Client B");
    await backdate(b.id, { createdAt: new Date(2026, 7, 10, 9, 0, 0).toISOString() });

    const log = await editorVideoLog("2026-05");
    expect(log.entries.map(e => e.editorName)).toEqual(["Alice Editor"]);
  });

  it("uses the local calendar month, not UTC", async () => {
    // 23:30 on 31 August local is 1 September in UTC east of Greenwich; the log
    // must say August, which is when the editor actually uploaded it.
    const a = await upload(editorA, "Client A");
    await backdate(a.id, { createdAt: new Date(2026, 7, 31, 23, 30, 0).toISOString() });

    const log = await editorVideoLog("2026-08");
    expect(log.entries).toHaveLength(1);
  });

  it("carries editor, title, client, status and date on every row (§11.3)", async () => {
    const a = await upload(editorA, "Client A", "My cut");
    await submitVideo(a.id, editorA);

    const [row] = (await editorVideoLog()).entries;
    expect(row).toMatchObject({
      editorName: "Alice Editor", client: "Client A",
      editorTitle: "My cut", status: "submitted",
    });
    expect(row.title).toBe("Client A Video 1");
    expect(row.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("groups by editor, busiest first", async () => {
    await upload(editorB, "Client B");
    await upload(editorA, "Client A");
    await upload(editorA, "Client A");

    const log = await editorVideoLog();
    expect(log.byEditor.map(g => [g.editorName, g.entries.length])).toEqual([
      ["Alice Editor", 2], ["Bob Editor", 1],
    ]);
  });

  it("can narrow to one client without losing the month", async () => {
    await upload(editorA, "Client A");
    await upload(editorB, "Client B");

    const log = await editorVideoLog(undefined, "Client B");
    expect(log.entries.map(e => e.client)).toEqual(["Client B"]);
    expect(log.month).toMatch(/^\d{4}-\d{2}$/);
  });

  it("reports an empty month as empty rather than falling back to another", async () => {
    await upload(editorA, "Client A");
    const log = await editorVideoLog("2001-01");
    expect(log.month).toBe("2001-01");
    expect(log.entries).toEqual([]);
  });
});

describe("§18 — search and filtering", () => {
  it("matches a video by title, client, caption or id", async () => {
    const a = await upload(editorA, "Convocation", "Stage wide");

    expect((await search({ q: "convocation" })).videos).toHaveLength(1);
    expect((await search({ q: "stage wide" })).videos).toHaveLength(1);
    expect((await search({ q: a.id })).videos).toHaveLength(1);
    expect((await search({ q: "nothing like it" })).videos).toHaveLength(0);
  });

  it("matches a video by its editor's name", async () => {
    await upload(editorA, "Client A");
    await upload(editorB, "Client B");

    const found = await search({ q: "alice" });
    expect(found.videos.map(v => v.client)).toEqual(["Client A"]);
  });

  it("matches an event by title (§18 'Event title')", async () => {
    await createEvent(manager, { title: "Sports meet", description: "", date: "2099-01-01", client: null });
    await createEvent(manager, { title: "Graduation", description: "", date: "2099-01-02", client: null });

    expect((await search({ q: "sports" })).events.map(e => e.title)).toEqual(["Sports meet"]);
  });

  it("filters videos by status, client and publisher", async () => {
    const a = await upload(editorA, "Client A");
    await upload(editorB, "Client B");
    await submitVideo(a.id, editorA);
    await publishVideo(a.id, publisher, {});

    expect((await search({ status: "published" })).videos).toHaveLength(1);
    expect((await search({ client: "Client B" })).videos).toHaveLength(1);
    expect((await search({ publisherId: publisher.id })).videos).toHaveLength(1);
    expect((await search({ publisherId: editorA.id })).videos).toHaveLength(0);
  });

  it("filters events by their own status, separately from video status", async () => {
    const one = await createEvent(manager, { title: "One", description: "", date: "2099-01-01", client: null });
    await createEvent(manager, { title: "Two", description: "", date: "2099-01-02", client: null });
    await assignEvent(one.id, editorA.id, manager);

    expect((await search({ eventStatus: "open" })).events.map(e => e.title)).toEqual(["One"]);
    expect((await search({ eventStatus: "unassigned" })).events.map(e => e.title)).toEqual(["Two"]);
  });

  it("filters by an inclusive date range", async () => {
    await createEvent(manager, { title: "Early", description: "", date: "2026-03-01", client: null });
    await createEvent(manager, { title: "Middle", description: "", date: "2026-03-15", client: null });
    await createEvent(manager, { title: "Late", description: "", date: "2026-04-01", client: null });

    const found = await search({ from: "2026-03-01", to: "2026-03-15" });
    expect(found.events.map(e => e.title).sort()).toEqual(["Early", "Middle"]);
  });

  it("pins an editor to their own work however the query is built (§25)", async () => {
    await upload(editorA, "Client A");
    await upload(editorB, "Client B");
    const one = await createEvent(manager, { title: "For B", description: "", date: "2099-01-01", client: null });
    await assignEvent(one.id, editorB.id, manager);

    // Editor A asks explicitly for editor B's work; the scope wins.
    const found = await search({ editorId: editorB.id }, { onlyEditorId: editorA.id });
    expect(found.videos.map(v => v.client)).toEqual(["Client A"]);
    expect(found.events).toEqual([]);
  });

  it("offers the distinct clients, editors and publishers for the filter dropdowns", async () => {
    await upload(editorA, "Client A");
    await upload(editorA, "Client A");
    await createEvent(manager, { title: "E", description: "", date: "2099-01-01", client: "Client C" });

    const options = await filterOptions();
    expect(options.clients).toEqual(["Client A", "Client C"]);
    expect(options.editors.map(e => e.name)).toEqual(["Alice Editor", "Bob Editor"]);
    expect(options.publishers.map(p => p.name)).toEqual(["Pat Publisher"]);
  });
});
