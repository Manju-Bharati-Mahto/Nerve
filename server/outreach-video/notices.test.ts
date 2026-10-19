// @vitest-environment node
/**
 * §14's remaining notices, and what keeps them from being noise.
 *
 *   Manager — "campaign completion": raised by the publication that brings a
 *   campaign to its target, ONCE. Overdelivering must not re-announce it.
 *
 *   Admin — "major publishing/system issues": a Drive that cannot be written.
 *   When Drive is down, every step on every video fails; the Admin must hear
 *   it once, not once per step.
 *
 *   Manager — "pending posts": a post whose slot has passed reaches the
 *   managers as well as the publishers.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { config } from "../config.js";
import { resetDriveClient } from "./drive-client.js";
import { resetStoreState } from "./drive-store.js";
import { addUser } from "./users.js";
import { listNotifications } from "./notifications.js";
import { createCampaign } from "./campaigns.js";
import { approveVideo, publishVideo, scheduleVideo, submitVideo, uploadVideo } from "./videos.js";
import { runOutreachVideoAutomations } from "./automations.js";
import type { VideoUser } from "./types.js";

let tmpRoot: string;
let admin: VideoUser, manager: VideoUser, editor: VideoUser, publisher: VideoUser;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nerve-ov-notices-"));
  (config.drive as { localRoot: string }).localRoot = tmpRoot;
  (config.drive as { rootFolderId: string }).rootFolderId = "";
  (config.drive as { serviceAccountEmail: string }).serviceAccountEmail = "";
  (config.drive as { oauthClientId: string }).oauthClientId = "";
  resetDriveClient();
  resetStoreState();
  admin = await addUser({ name: "Ada Admin", email: "ada@a.com", role: "admin" });
  manager = await addUser({ name: "Mel Manager", email: "mel@a.com", role: "manager" });
  editor = await addUser({ name: "Ed Editor", email: "ed@a.com", role: "editor" });
  publisher = await addUser({ name: "Pat Publisher", email: "pat@a.com", role: "publisher" });
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  resetDriveClient();
  resetStoreState();
});

const kinds = async (u: VideoUser) => (await listNotifications(u.id)).map(n => n.kind);

async function publishOne(campaignId: string) {
  const local = path.join(tmpRoot, `${Math.random().toString(36).slice(2)}.mp4`);
  await fs.writeFile(local, "bytes", "utf8");
  const v = await uploadVideo({
    editor, client: "x", campaignId, editorTitle: "t", caption: "c",
    localPath: local, originalName: "v.mp4", mimeType: "video/mp4", sizeBytes: 5,
  });
  await submitVideo(v.id, editor);
  await approveVideo(v.id, manager);
  return publishVideo(v.id, publisher);
}

describe("§14 Manager — campaign completion", () => {
  it("is announced by the publication that reaches the target", async () => {
    const c = await createCampaign(manager, { name: "Two Posts", startDate: "2027-01-01", endDate: "2027-12-31", requiredPosts: 2 });
    await publishOne(c.id);
    expect(await kinds(manager)).not.toContain("campaign_completed");
    await publishOne(c.id);
    expect(await kinds(manager)).toContain("campaign_completed");
    expect(await kinds(admin)).toContain("campaign_completed");
  });

  it("is not announced again when the campaign overdelivers", async () => {
    const c = await createCampaign(manager, { name: "One Post", startDate: "2027-01-01", endDate: "2027-12-31", requiredPosts: 1 });
    await publishOne(c.id);
    await publishOne(c.id);
    await publishOne(c.id);
    expect((await kinds(manager)).filter(k => k === "campaign_completed")).toHaveLength(1);
  });

  it("tells the campaign's own manager even when they are not a Manager by role", async () => {
    const c = await createCampaign(manager, {
      name: "Owned", startDate: "2027-01-01", endDate: "2027-12-31", requiredPosts: 1,
      campaignManagerId: publisher.id,
    });
    await publishOne(c.id);
    expect(await kinds(publisher)).toContain("campaign_completed");
  });

  it("says nothing for a campaign with no target", async () => {
    const c = await createCampaign(manager, { name: "Open Ended", startDate: "2027-01-01", endDate: "2027-12-31" });
    await publishOne(c.id);
    expect(await kinds(manager)).not.toContain("campaign_completed");
  });

  it("does not tell the editor", async () => {
    const c = await createCampaign(manager, { name: "Done", startDate: "2027-01-01", endDate: "2027-12-31", requiredPosts: 1 });
    await publishOne(c.id);
    expect(await kinds(editor)).not.toContain("campaign_completed");
  });
});

describe("§14 Admin — a Drive that cannot be written", () => {
  it("is reported to the Admin once, however many steps fail", async () => {
    const c = await createCampaign(manager, { name: "Broken", startDate: "2027-01-01", endDate: "2027-12-31" });
    const local = path.join(tmpRoot, "v.mp4");
    await fs.writeFile(local, "bytes", "utf8");
    const v = await uploadVideo({
      editor, client: "x", campaignId: c.id, editorTitle: "t", caption: "c",
      localPath: local, originalName: "v.mp4", mimeType: "video/mp4", sizeBytes: 5,
    });
    // Break Drive for this campaign: Captions/ becomes a file.
    const captions = path.join(tmpRoot, "Social Media Campaigns", "Broken", "Captions");
    await fs.rm(captions, { recursive: true });
    await fs.writeFile(captions, "not a folder");
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});

    await submitVideo(v.id, editor);
    await approveVideo(v.id, manager);
    await publishVideo(v.id, publisher);
    quiet.mockRestore();

    const issues = (await listNotifications(admin.id)).filter(n => n.kind === "system_issue");
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toMatch(/Google Drive could not be updated/);
    expect(issues[0].subject).toEqual({ type: "system", id: "drive" });
  });

  it("does not trouble anyone but Admins with it", async () => {
    const c = await createCampaign(manager, { name: "Broken Two", startDate: "2027-01-01", endDate: "2027-12-31" });
    const local = path.join(tmpRoot, "w.mp4");
    await fs.writeFile(local, "bytes", "utf8");
    const v = await uploadVideo({
      editor, client: "x", campaignId: c.id, editorTitle: "t", caption: "c",
      localPath: local, originalName: "w.mp4", mimeType: "video/mp4", sizeBytes: 5,
    });
    const captions = path.join(tmpRoot, "Social Media Campaigns", "Broken Two", "Captions");
    await fs.rm(captions, { recursive: true });
    await fs.writeFile(captions, "not a folder");
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    await submitVideo(v.id, editor);
    quiet.mockRestore();
    for (const u of [manager, editor, publisher]) expect(await kinds(u)).not.toContain("system_issue");
  });
});

describe("§14 Manager — pending posts", () => {
  it("tells the managers about a post whose slot has passed, as well as the publishers", async () => {
    const c = await createCampaign(manager, { name: "Late", startDate: "2020-01-01", endDate: "2099-12-31" });
    const local = path.join(tmpRoot, "x.mp4");
    await fs.writeFile(local, "bytes", "utf8");
    const v = await uploadVideo({
      editor, client: "x", campaignId: c.id, editorTitle: "t", caption: "c",
      localPath: local, originalName: "x.mp4", mimeType: "video/mp4", sizeBytes: 5,
    });
    await submitVideo(v.id, editor);
    await approveVideo(v.id, manager);
    await scheduleVideo(v.id, publisher, "2020-01-01T09:00:00.000Z");
    await runOutreachVideoAutomations();
    expect(await kinds(manager)).toContain("posting_due");
    expect(await kinds(publisher)).toContain("posting_due");
  });

  it("tells an Admin once, though they are both a publisher-recipient and a manager-recipient", async () => {
    const c = await createCampaign(manager, { name: "Late Two", startDate: "2020-01-01", endDate: "2099-12-31" });
    const local = path.join(tmpRoot, "y.mp4");
    await fs.writeFile(local, "bytes", "utf8");
    const v = await uploadVideo({
      editor, client: "x", campaignId: c.id, editorTitle: "t", caption: "c",
      localPath: local, originalName: "y.mp4", mimeType: "video/mp4", sizeBytes: 5,
    });
    await submitVideo(v.id, editor);
    await approveVideo(v.id, manager);
    await scheduleVideo(v.id, publisher, "2020-01-01T09:00:00.000Z");
    await runOutreachVideoAutomations();
    expect((await kinds(admin)).filter(k => k === "posting_due")).toHaveLength(1);
  });
});
