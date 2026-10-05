// @vitest-environment node
/**
 * What the outreach team sees when they open the Drive folder.
 *
 * They asked for every video to be there WITH its description and every
 * remark the workflow's users made on it. So these tests do what a person
 * would: walk a video through the workflow, then open the file in Drive and
 * read it. Every assertion is about the text on disk, not about the record.
 *
 * The other half is §9's Published/ folder: a video that goes out moves there.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { config } from "../config.js";
import { resetDriveClient } from "./drive-client.js";
import { resetStoreState, readWorkflow } from "./drive-store.js";
import { addUser } from "./users.js";
import { createCampaign } from "./campaigns.js";
import {
  approveVideo, getVideo, publishVideo, rejectVideo, resyncAllToDrive, scheduleVideo,
  startRevision, submitVideo, updateCaption, uploadVideo,
} from "./videos.js";
import { formatIst, videoDetailsBody, videoNumberOf } from "./drive-mirror.js";
import type { VideoUser } from "./types.js";

let tmpRoot: string;
let editor: VideoUser;
let manager: VideoUser;
let publisher: VideoUser;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nerve-ov-mirror-"));
  (config.drive as { localRoot: string }).localRoot = tmpRoot;
  (config.drive as { rootFolderId: string }).rootFolderId = "";
  (config.drive as { serviceAccountEmail: string }).serviceAccountEmail = "";
  (config.drive as { oauthClientId: string }).oauthClientId = "";
  resetDriveClient();
  resetStoreState();
  editor = await addUser({ name: "Om Editor", email: "om@a.com", role: "editor" });
  manager = await addUser({ name: "Rahul Manager", email: "rahul@a.com", role: "manager" });
  publisher = await addUser({ name: "Amit Publisher", email: "amit@a.com", role: "publisher" });
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  resetDriveClient();
  resetStoreState();
});

const folder = (campaign: string, sub: string) =>
  path.join(tmpRoot, "Social Media Campaigns", campaign, sub);

/** Opens the video's details file the way a person would — by name, in Captions/. */
const readDetails = async (title: string, campaign = "VLF 2027") =>
  fs.readFile(path.join(folder(campaign, "Captions"), `${title}.txt`), "utf8");

async function uploadOne(notes = "Opening reel for the festival, 30s cut.") {
  const campaign = await createCampaign(manager, {
    name: "VLF 2027", startDate: "2027-01-01", endDate: "2027-03-31",
  }).catch(async () => (await import("./campaigns.js")).findCampaignByName("VLF 2027").then(c => c!));
  const local = path.join(tmpRoot, `${Math.random().toString(36).slice(2)}.mp4`);
  await fs.writeFile(local, "bytes", "utf8");
  return uploadVideo({
    editor, client: "x", campaignId: campaign.id, editorTitle: "Opening reel",
    caption: "Join us at VLF 2027!", notes, platform: "Instagram",
    socialPageIds: ["pg1"], pageNames: ["@paruluniversity"],
    localPath: local, originalName: "clip.mp4", mimeType: "video/mp4", sizeBytes: 5,
  });
}

describe("the details file a person opens in Drive", () => {
  it("is written beside the video at upload, named exactly like it", async () => {
    const v = await uploadOne();
    expect(await fs.readdir(folder("VLF 2027", "Videos"))).toContain("VLF 2027 - Video 1.mp4");
    expect(await fs.readdir(folder("VLF 2027", "Captions"))).toContain("VLF 2027 - Video 1.txt");
    expect(v.captionFileId).toBeTruthy();
  });

  it("opens with exactly what §10 asks for", async () => {
    const v = await uploadOne();
    const lines = (await readDetails(v.title)).split("\n");
    expect(lines[0]).toBe("Campaign: VLF 2027");
    expect(lines[1]).toBe("Video Number: 1");
    expect(lines[2]).toBe("Platform/Page: @paruluniversity");
  });

  it("carries the complete caption", async () => {
    const v = await uploadOne();
    expect(await readDetails(v.title)).toContain("Join us at VLF 2027!");
  });

  it("carries the editor's description", async () => {
    const v = await uploadOne("Opening reel for the festival, 30s cut.");
    const body = await readDetails(v.title);
    expect(body).toContain("DESCRIPTION / NOTES");
    expect(body).toContain("Opening reel for the festival, 30s cut.");
  });

  it("says who uploaded it", async () => {
    const v = await uploadOne();
    expect(await readDetails(v.title)).toContain("Uploaded by: Om Editor");
  });
});

describe("remarks from the workflow's users reach Drive", () => {
  it("shows the reviewer's reason when a video is sent back", async () => {
    const v = await uploadOne();
    await submitVideo(v.id, editor);
    await rejectVideo(v.id, manager, "Logo in the last 3 seconds is the old one");

    const body = await readDetails(v.title);
    expect(body).toContain("Status: Rejected");
    expect(body).toContain("WHY IT WAS SENT BACK");
    expect(body).toContain("Logo in the last 3 seconds is the old one");
    expect(body).toMatch(/Rahul Manager: Sent back for changes — “Logo in the last 3 seconds is the old one”/);
  });

  it("shows the reviewer's note on approval", async () => {
    const v = await uploadOne();
    await submitVideo(v.id, editor);
    await approveVideo(v.id, manager, "Great pacing — use for the launch post");
    const body = await readDetails(v.title);
    expect(body).toContain("Status: Approved");
    expect(body).toContain("Rahul Manager: Approved — “Great pacing — use for the launch post”");
  });

  it("shows the publisher's remark and the live link", async () => {
    const v = await uploadOne();
    await submitVideo(v.id, editor);
    await approveVideo(v.id, manager);
    await publishVideo(v.id, publisher, { instagram: "https://instagram.com/p/ABC" }, "Posted with the collab tag");
    const body = await readDetails(v.title);
    expect(body).toContain("Status: Published");
    expect(body).toContain("Published by: Amit Publisher");
    expect(body).toContain("instagram: https://instagram.com/p/ABC");
    expect(body).toContain("Posted with the collab tag");
  });

  it("keeps the whole history, in order — the PRD's own audit example", async () => {
    // "Om uploaded … → Rahul approved it → Priya scheduled it → Amit marked it Published."
    const v = await uploadOne();
    await submitVideo(v.id, editor);
    await approveVideo(v.id, manager);
    await scheduleVideo(v.id, publisher, "2027-02-01T04:00:00.000Z");
    await publishVideo(v.id, publisher);

    const history = (await readDetails(v.title)).split("REMARKS & HISTORY")[1];
    const order = ["Om Editor: Uploaded", "Om Editor: Submitted for review", "Rahul Manager: Approved",
      "Amit Publisher: Scheduled", "Amit Publisher: Published"];
    let at = -1;
    for (const step of order) {
      const i = history.indexOf(step);
      expect(i, step).toBeGreaterThan(at);
      at = i;
    }
  });

  it("writes times in IST, not UTC", async () => {
    const v = await uploadOne();
    await submitVideo(v.id, editor);
    await approveVideo(v.id, manager);
    await scheduleVideo(v.id, publisher, "2027-02-01T04:00:00.000Z");   // 09:30 IST
    const body = await readDetails(v.title);
    expect(body).toContain("Scheduled for: 1 Feb 2027, 9:30 am IST");
  });

  it("follows a revision: the fixed caption replaces the old one, and the reason clears", async () => {
    const v = await uploadOne();
    await submitVideo(v.id, editor);
    await rejectVideo(v.id, manager, "Caption has a typo");
    await startRevision(v.id, editor);
    await updateCaption(v.id, "Join us at VLF 2027 — corrected!", editor);
    await submitVideo(v.id, editor);

    const body = await readDetails(v.title);
    expect(body).toContain("Status: Under Review");
    expect(body).not.toContain("WHY IT WAS SENT BACK");
    expect(body.split("CAPTION")[1]).toContain("Join us at VLF 2027 — corrected!");
    // …while the history still remembers why it went back.
    expect(body).toContain("Caption has a typo");
  });
});

describe("§9 Published/", () => {
  it("moves a video into Published/ when it is published", async () => {
    const v = await uploadOne();
    await submitVideo(v.id, editor);
    await approveVideo(v.id, manager);
    await publishVideo(v.id, publisher);

    expect(await fs.readdir(folder("VLF 2027", "Published"))).toContain("VLF 2027 - Video 1.mp4");
    expect(await fs.readdir(folder("VLF 2027", "Videos"))).not.toContain("VLF 2027 - Video 1.mp4");
  });

  it("keeps the record pointing at the moved file, so it still plays", async () => {
    const v = await uploadOne();
    await submitVideo(v.id, editor);
    await approveVideo(v.id, manager);
    await publishVideo(v.id, publisher);

    const after = await getVideo(v.id);
    await expect(fs.stat(path.join(tmpRoot, after.driveFileId))).resolves.toBeTruthy();
  });

  it("leaves the caption file in Captions/", async () => {
    const v = await uploadOne();
    await submitVideo(v.id, editor);
    await approveVideo(v.id, manager);
    await publishVideo(v.id, publisher);
    expect(await fs.readdir(folder("VLF 2027", "Captions"))).toContain("VLF 2027 - Video 1.txt");
  });

  it("leaves unpublished work in Videos/", async () => {
    const v = await uploadOne();
    await submitVideo(v.id, editor);
    await approveVideo(v.id, manager);
    expect(await fs.readdir(folder("VLF 2027", "Videos"))).toContain(`${v.title}.mp4`);
  });
});

describe("never at the workflow's expense", () => {
  it("recreates a details file somebody deleted in Drive, at the next step", async () => {
    const v = await uploadOne();
    await fs.rm(path.join(folder("VLF 2027", "Captions"), `${v.title}.txt`));
    await submitVideo(v.id, editor);
    expect(await readDetails(v.title)).toContain("Status: Under Review");
  });

  it("still completes the step when Drive cannot be written", async () => {
    const v = await uploadOne();
    // Make Captions/ unwritable by replacing it with a plain file.
    await fs.rm(folder("VLF 2027", "Captions"), { recursive: true });
    await fs.writeFile(folder("VLF 2027", "Captions"), "not a folder");
    const spy = (await import("vitest")).vi.spyOn(console, "error").mockImplementation(() => {});

    const submitted = await submitVideo(v.id, editor);
    expect(submitted.status).toBe("under_review");
    spy.mockRestore();
  });
});

describe("a Drive failure never escapes", () => {
  it("leaves no unhandled rejection behind — which in Node can crash the API", async () => {
    const v = await uploadOne();
    await fs.rm(folder("VLF 2027", "Captions"), { recursive: true });
    await fs.writeFile(folder("VLF 2027", "Captions"), "not a folder");
    // The record says it has a file there; make the rewrite fail too.
    const doc = await readWorkflow();
    doc.videos.find(x => x.id === v.id)!.captionFileId = "gone/missing.txt";

    const escaped: unknown[] = [];
    const onUnhandled = (reason: unknown) => { escaped.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    const quiet = (await import("vitest")).vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await submitVideo(v.id, editor);
      await approveVideo(v.id, manager);
      // Give any stray rejection a few turns of the event loop to surface.
      await new Promise(r => setTimeout(r, 50));
    } finally {
      process.off("unhandledRejection", onUnhandled);
      quiet.mockRestore();
    }
    expect(escaped).toEqual([]);
  });
});

describe("Sync everything to Drive", () => {
  it("writes any missing details file and reports what it did", async () => {
    const v = await uploadOne();
    await fs.rm(path.join(folder("VLF 2027", "Captions"), `${v.title}.txt`));
    const r = await resyncAllToDrive();
    expect(r.synced).toBe(1);
    expect(r.failed).toEqual([]);
    expect(await readDetails(v.title)).toContain("Campaign: VLF 2027");
  });

  it("gives a record from before videos remembered their folders a home", async () => {
    const v = await uploadOne();
    // Simulate an older record: no folders, and its file somewhere else.
    const doc = await readWorkflow();
    const rec = doc.videos.find(x => x.id === v.id)!;
    rec.driveFolders = null;
    const r = await resyncAllToDrive();
    expect(r.failed).toEqual([]);
    expect((await getVideo(v.id)).driveFolders?.published).toBeTruthy();
  });
});

describe("the details text itself", () => {
  it("reads the video number from older titles that predate the stored number", () => {
    expect(videoNumberOf({ sequence: null, title: "Client A Video 7" })).toBe(7);
    expect(videoNumberOf({ sequence: 3, title: "anything" })).toBe(3);
  });

  it("formats times for India and says so", () => {
    expect(formatIst("2027-02-01T04:00:00.000Z")).toBe("1 Feb 2027, 9:30 am IST");
  });

  it("names the platform when no page was picked", async () => {
    const v = await uploadOne();
    const body = videoDetailsBody({ ...(await getVideo(v.id)), socialPageNames: [], platform: "Facebook" });
    expect(body.split("\n")[2]).toBe("Platform/Page: Facebook");
  });
});
