// @vitest-environment node
/**
 * §14 — the two notices raised by time passing rather than by anyone acting.
 *
 * The behaviour worth testing is not that they fire. It is that they fire
 * ONCE. This runs on a few-minute tick, so a campaign ending on Friday is
 * equally "approaching its deadline" on every tick between now and Friday —
 * several hundred of them. A notifier that cannot hold its tongue makes every
 * notification in the product worth ignoring, including the ones that matter.
 *
 * So most of this file runs the job twice and checks the second run is quiet.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { config } from "../config.js";
import { resetDriveClient } from "./drive-client.js";
import { resetStoreState } from "./drive-store.js";
import { addUser } from "./users.js";
import { listNotifications } from "./notifications.js";
import { createCampaign } from "./campaigns.js";
import { approveVideo, scheduleVideo, submitVideo, uploadVideo } from "./videos.js";
import { runOutreachVideoAutomations } from "./automations.js";
import type { VideoUser } from "./types.js";

let tmpRoot: string;
let editor: VideoUser;
let manager: VideoUser;
let publisher: VideoUser;

const ACTOR = () => manager;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nerve-ov-auto-"));
  (config.drive as { localRoot: string }).localRoot = tmpRoot;
  (config.drive as { rootFolderId: string }).rootFolderId = "";
  (config.drive as { serviceAccountEmail: string }).serviceAccountEmail = "";
  (config.drive as { oauthClientId: string }).oauthClientId = "";
  resetDriveClient();
  resetStoreState();
  editor = await addUser({ name: "Ed", email: "ed@a.com", role: "editor" });
  manager = await addUser({ name: "Mel", email: "mel@a.com", role: "manager" });
  publisher = await addUser({ name: "Pat", email: "pat@a.com", role: "publisher" });
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  resetDriveClient();
  resetStoreState();
});

async function fakeVideo(name: string): Promise<string> {
  const p = path.join(tmpRoot, name);
  await fs.writeFile(p, "bytes", "utf8");
  return p;
}

/** A video scheduled for `when`, which is as far as the workflow takes it. */
async function scheduledVideo(when: string) {
  const campaign = await createCampaign(ACTOR(), {
    name: `C${Math.random().toString(36).slice(2, 8)}`,
    startDate: "2027-01-01", endDate: "2027-12-31",
  });
  const v = await uploadVideo({
    editor, client: "x", campaignId: campaign.id, editorTitle: "t", caption: "c",
    localPath: await fakeVideo(`${Math.random().toString(36).slice(2)}.mp4`),
    originalName: "v.mp4", mimeType: "video/mp4", sizeBytes: 5,
  });
  await submitVideo(v.id, editor);
  await approveVideo(v.id, manager);
  await scheduleVideo(v.id, publisher, when);
  return v;
}

const kinds = async (userId: string) =>
  (await listNotifications(userId)).map(n => n.kind);

describe("§14 Publisher — content due to be posted", () => {
  it("tells the publisher when a scheduled slot has arrived", async () => {
    await scheduledVideo("2020-01-01T09:00:00.000Z");
    const r = await runOutreachVideoAutomations();
    expect(r.postingDue).toBeGreaterThan(0);
    expect(await kinds(publisher.id)).toContain("posting_due");
  });

  it("says it once, however many times the tick runs", async () => {
    await scheduledVideo("2020-01-01T09:00:00.000Z");
    await runOutreachVideoAutomations();
    const second = await runOutreachVideoAutomations();
    const third = await runOutreachVideoAutomations();

    expect(second.postingDue).toBe(0);
    expect(third.postingDue).toBe(0);
    expect((await kinds(publisher.id)).filter(k => k === "posting_due")).toHaveLength(1);
  });

  it("says nothing about a slot still in the future", async () => {
    await scheduledVideo("2099-01-01T09:00:00.000Z");
    const r = await runOutreachVideoAutomations();
    expect(r.postingDue).toBe(0);
    expect(await kinds(publisher.id)).not.toContain("posting_due");
  });

  it("does not pester the editor about publishing", async () => {
    await scheduledVideo("2020-01-01T09:00:00.000Z");
    await runOutreachVideoAutomations();
    expect(await kinds(editor.id)).not.toContain("posting_due");
  });
});

describe("§14 Manager — campaign deadlines", () => {
  const soon = (days: number) => {
    const d = new Date();
    d.setDate(d.getDate() + days);
    return d.toISOString().slice(0, 10);
  };

  it("tells the manager about a campaign ending within a few days", async () => {
    await createCampaign(ACTOR(), { name: "Ending Soon", startDate: "2020-01-01", endDate: soon(1) });
    const r = await runOutreachVideoAutomations();
    expect(r.campaignDeadlines).toBeGreaterThan(0);
    expect(await kinds(manager.id)).toContain("campaign_deadline");
  });

  it("says it once, however many times the tick runs", async () => {
    await createCampaign(ACTOR(), { name: "Ending Soon", startDate: "2020-01-01", endDate: soon(1) });
    await runOutreachVideoAutomations();
    const second = await runOutreachVideoAutomations();
    expect(second.campaignDeadlines).toBe(0);
    expect((await kinds(manager.id)).filter(k => k === "campaign_deadline")).toHaveLength(1);
  });

  it("stays quiet about a campaign with months to run", async () => {
    await createCampaign(ACTOR(), { name: "Far Off", startDate: "2020-01-01", endDate: soon(90) });
    const r = await runOutreachVideoAutomations();
    expect(r.campaignDeadlines).toBe(0);
  });

  it("stays quiet about one already marked completed", async () => {
    await createCampaign(ACTOR(), {
      name: "Done", startDate: "2020-01-01", endDate: soon(1), status: "completed",
    });
    const r = await runOutreachVideoAutomations();
    expect(r.campaignDeadlines).toBe(0);
  });

  it("still speaks up about one that is overdue and unfinished", async () => {
    await createCampaign(ACTOR(), { name: "Overdue", startDate: "2020-01-01", endDate: soon(-5) });
    const r = await runOutreachVideoAutomations();
    expect(r.campaignDeadlines).toBeGreaterThan(0);
  });

  it("does not tell the editor about campaign deadlines", async () => {
    await createCampaign(ACTOR(), { name: "Ending Soon", startDate: "2020-01-01", endDate: soon(1) });
    await runOutreachVideoAutomations();
    expect(await kinds(editor.id)).not.toContain("campaign_deadline");
  });
});

describe("with nothing to say", () => {
  it("is quiet and reports nothing, rather than erroring", async () => {
    const r = await runOutreachVideoAutomations();
    expect(r).toMatchObject({ postingDue: 0, campaignDeadlines: 0 });
  });
});
