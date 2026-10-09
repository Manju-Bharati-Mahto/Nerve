// @vitest-environment node
/**
 * Campaigns — §7, §9, §10 and §17 of the Campaign & Content Management PRD.
 *
 * §17 ("One Campaign = One Centralized Workspace") is the property worth
 * testing, and it is mostly a question of identity: a campaign has to be ONE
 * thing. The free-text field this replaces failed exactly there — "VLF 2027"
 * and "vlf  2027" were two campaigns, so nothing could be counted reliably
 * against either. Most of what follows is about near-duplicates, because that
 * is the failure that silently splits a workspace in two.
 *
 * The other theme is the Drive layout. §9's tree applies to NEW campaigns
 * only; assets uploaded before it existed stay where they are, under links
 * people already hold. `driveFolders: null` is how a record says "I am from
 * before", and the fallback it triggers is the correct path for that
 * campaign, not a degraded one.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { claimNameOnlyVideos, listVideos, renameCampaignOnVideos, uploadVideo } from "./videos.js";

import { config } from "../config.js";
import { resetDriveClient } from "./drive-client.js";
import { resetStoreState } from "./drive-store.js";
import {
  CAMPAIGN_SUBFOLDERS, CampaignExistsError, CampaignInUseError, CampaignNotFoundError,
  assetFoldersFor, campaignAssetName, campaignProgress, captionFileBody,
  createCampaign, deleteCampaign, findCampaignByName, getCampaign, isCalendarDate, listCampaigns, updateCampaign,
} from "./campaigns.js";
import type { VideoUser } from "./types.js";

const ACTOR: VideoUser = {
  id: "u-admin", name: "Test Admin", email: "admin@test.local", role: "admin",
  active: true, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
};

const base = {
  startDate: "2027-01-01",
  endDate: "2027-03-31",
};

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nerve-campaigns-"));
  (config.drive as { localRoot: string }).localRoot = tmpRoot;
  (config.drive as { rootFolderId: string }).rootFolderId = "";
  (config.drive as { serviceAccountEmail: string }).serviceAccountEmail = "";
  (config.drive as { oauthClientId: string }).oauthClientId = "";
  resetDriveClient();
  resetStoreState();
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  resetDriveClient();
  resetStoreState();
});

describe("a campaign is one thing (§17)", () => {
  it("is created with everything §7 asks for", async () => {
    const c = await createCampaign(ACTOR, {
      ...base, name: "VLF 2027", description: "Annual festival",
      campaignManagerId: "u-manager", socialPageIds: ["pg1", "pg2"],
      requiredPosts: 40, notes: "Priority",
    });
    expect(c.name).toBe("VLF 2027");
    expect(c.description).toBe("Annual festival");
    expect(c.startDate).toBe("2027-01-01");
    expect(c.endDate).toBe("2027-03-31");
    expect(c.campaignManagerId).toBe("u-manager");
    expect(c.socialPageIds).toEqual(["pg1", "pg2"]);
    expect(c.requiredPosts).toBe(40);
    expect(c.notes).toBe("Priority");
    expect(c.status).toBe("upcoming");
  });

  it("refuses a second campaign with the same name", async () => {
    await createCampaign(ACTOR, { ...base, name: "VLF 2027" });
    await expect(createCampaign(ACTOR, { ...base, name: "VLF 2027" }))
      .rejects.toThrow(CampaignExistsError);
  });

  it("treats near-duplicate spellings as the same campaign", async () => {
    await createCampaign(ACTOR, { ...base, name: "VLF 2027" });
    for (const nearly of ["vlf 2027", "  VLF 2027  ", "VLF  2027", "Vlf 2027"]) {
      await expect(createCampaign(ACTOR, { ...base, name: nearly }), nearly)
        .rejects.toThrow(CampaignExistsError);
    }
    expect(await listCampaigns()).toHaveLength(1);
  });

  it("finds a campaign by name however it is typed", async () => {
    const made = await createCampaign(ACTOR, { ...base, name: "MS Dhoni Event" });
    for (const typed of ["MS Dhoni Event", "ms dhoni event", " MS  Dhoni Event "]) {
      expect((await findCampaignByName(typed))?.id, typed).toBe(made.id);
    }
  });

  it("lets exactly one of two simultaneous creations win", async () => {
    const attempt = () => createCampaign(ACTOR, { ...base, name: "Race Campaign" });
    const results = await Promise.allSettled([attempt(), attempt(), attempt()]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(await listCampaigns()).toHaveLength(1);
  });
});

describe("what a campaign will not accept", () => {
  it("requires a name", async () => {
    await expect(createCampaign(ACTOR, { ...base, name: "   " })).rejects.toThrow(/name is required/i);
  });

  it("requires real dates", async () => {
    await expect(createCampaign(ACTOR, { ...base, name: "X", startDate: "01-01-2027" }))
      .rejects.toThrow(/valid start date/i);
  });

  it("refuses a date that does not exist on the calendar", async () => {
    // Shaped like a date, so the old check let it through and it was saved.
    await expect(createCampaign(ACTOR, { name: "X", startDate: "2026-02-31", endDate: "2026-03-05" }))
      .rejects.toThrow(/valid start date/i);
    await expect(createCampaign(ACTOR, { name: "X", startDate: "2026-01-01", endDate: "2026-13-01" }))
      .rejects.toThrow(/valid end date/i);
    const c = await createCampaign(ACTOR, { ...base, name: "Real" });
    await expect(updateCampaign(ACTOR, c.id, { endDate: "2027-04-31" })).rejects.toThrow(/valid end date/i);
  });

  it("knows which dates exist", () => {
    expect(isCalendarDate("2028-02-29")).toBe(true);
    expect(isCalendarDate("2027-02-29")).toBe(false);
    expect(isCalendarDate("2026-04-31")).toBe(false);
    expect(isCalendarDate("2026-00-10")).toBe(false);
    expect(isCalendarDate("2026-1-10")).toBe(false);
  });

  it("refuses a backwards date range", async () => {
    await expect(createCampaign(ACTOR, { name: "X", startDate: "2027-03-31", endDate: "2027-01-01" }))
      .rejects.toThrow(/cannot be before/i);
  });

  it("refuses a negative or fractional posting requirement", async () => {
    for (const n of [-1, 2.5]) {
      await expect(createCampaign(ACTOR, { ...base, name: `X${n}`, requiredPosts: n }), String(n))
        .rejects.toThrow(/whole number/i);
    }
  });
});

describe("editing a campaign", () => {
  it("records what changed, in words", async () => {
    const c = await createCampaign(ACTOR, { ...base, name: "VLF 2027", requiredPosts: 10 });
    const updated = await updateCampaign(ACTOR, c.id, { status: "running", requiredPosts: 25 });
    expect(updated.status).toBe("running");
    expect(updated.requiredPosts).toBe(25);
    const last = updated.activity[updated.activity.length - 1];
    expect(last.action).toBe("Campaign updated");
    expect(last.notes).toContain("upcoming → running");
    expect(last.notes).toContain("10 → 25");
  });

  it("will not rename a campaign onto another one's name", async () => {
    await createCampaign(ACTOR, { ...base, name: "VLF 2027" });
    const other = await createCampaign(ACTOR, { ...base, name: "MS Dhoni Event" });
    await expect(updateCampaign(ACTOR, other.id, { name: "vlf 2027" }))
      .rejects.toThrow(CampaignExistsError);
  });

  it("lets a campaign keep its own name while editing something else", async () => {
    const c = await createCampaign(ACTOR, { ...base, name: "VLF 2027" });
    const updated = await updateCampaign(ACTOR, c.id, { name: "VLF 2027", notes: "unchanged name" });
    expect(updated.notes).toBe("unchanged name");
  });

  it("refuses to edit a campaign that does not exist", async () => {
    await expect(updateCampaign(ACTOR, "nope", { notes: "x" })).rejects.toThrow(CampaignNotFoundError);
  });
});

describe("deleting a campaign", () => {
  it("removes one that owns nothing", async () => {
    const c = await createCampaign(ACTOR, { ...base, name: "Empty" });
    await deleteCampaign(ACTOR, c.id, 0);
    expect(await getCampaign(c.id)).toBeNull();
  });

  it("refuses to orphan videos", async () => {
    const c = await createCampaign(ACTOR, { ...base, name: "Busy" });
    await expect(deleteCampaign(ACTOR, c.id, 3)).rejects.toThrow(CampaignInUseError);
    expect(await getCampaign(c.id)).not.toBeNull();
  });

  it("says what can be done instead, not something the app cannot do", async () => {
    // It used to say "Move or remove them first", and nothing moves or removes a video.
    const c = await createCampaign(ACTOR, { ...base, name: "Busy" });
    const refusal = await deleteCampaign(ACTOR, c.id, 1).catch((err: Error) => err.message);
    expect(refusal).toMatch(/holds 1 video,/);
    expect(refusal).toMatch(/cannot be deleted/i);
    expect(refusal).toMatch(/Completed/);
    expect(refusal).not.toMatch(/move or remove/i);
  });
});

describe("the Drive layout (§9)", () => {
  it("gives a new campaign the three folders the PRD names", async () => {
    const c = await createCampaign(ACTOR, { ...base, name: "VLF 2027" });
    expect(c.driveFolders).toBeTruthy();
    expect(Object.keys(c.driveFolders!).sort()).toEqual(["captions", "published", "videos"]);
    expect(CAMPAIGN_SUBFOLDERS).toEqual(["Videos", "Captions", "Published"]);
  });

  it("uses those folders for a campaign that has them", async () => {
    const c = await createCampaign(ACTOR, { ...base, name: "VLF 2027" });
    expect(await assetFoldersFor(c)).toEqual(c.driveFolders);
  });

  it("builds the full §9 tree for a campaign that has no folders recorded", async () => {
    /* There is one layout now. A name with no record (or a record whose
       folder creation failed earlier) gets the same three folders as any
       other campaign, rather than a second, older location. */
    const folders = await assetFoldersFor({ name: "Old Campaign", driveFolders: null });
    expect(folders.videos).toContain(path.join("Social Media Campaigns", "Old Campaign", "Videos"));
    expect(folders.captions).toContain(path.join("Old Campaign", "Captions"));
    expect(folders.published).toContain(path.join("Old Campaign", "Published"));
  });

  it("never files a new campaign into a folder another campaign holds", async () => {
    /* A rename leaves the folder under the old name, so a new campaign
       given that name used to land in the same folder as the renamed one. */
    const first = await createCampaign(ACTOR, { ...base, name: "VLF 2027" });
    await updateCampaign(ACTOR, first.id, { name: "VLF 2027 old" });
    const second = await createCampaign(ACTOR, { ...base, name: "VLF 2027" });
    expect(second.driveFolders?.videos).not.toBe(first.driveFolders?.videos);
    expect(second.driveFolders?.videos).toContain(path.join("Social Media Campaigns", "VLF 2027 (2)", "Videos"));
    // The renamed campaign keeps the folder its files are already in.
    expect((await getCampaign(first.id))?.driveFolders).toEqual(first.driveFolders);
  });

  it("does not lend a campaign with no folders recorded another campaign's tree", async () => {
    const holder = await createCampaign(ACTOR, { ...base, name: "VLF 2027" });
    await updateCampaign(ACTOR, holder.id, { name: "Renamed" });
    const folders = await assetFoldersFor({ id: "another-campaign", name: "VLF 2027", driveFolders: null });
    expect(folders.videos).not.toBe(holder.driveFolders?.videos);
    // …while the campaign itself still resolves to its own.
    expect(await assetFoldersFor({ id: holder.id, name: "VLF 2027", driveFolders: null }))
      .toEqual(holder.driveFolders);
  });

  it("returns the same folders for the same campaign however it is typed", async () => {
    const a = await assetFoldersFor({ name: "VLF 2027", driveFolders: null });
    const b = await assetFoldersFor({ name: "vlf  2027", driveFolders: null });
    expect(b).toEqual(a);
  });
});

describe("naming and the caption sidecar (§10)", () => {
  it("names a video the way the PRD writes it", () => {
    expect(campaignAssetName("VLF 2027", 1)).toBe("VLF 2027 - Video 1");
    expect(campaignAssetName("  VLF 2027  ", 12)).toBe("VLF 2027 - Video 12");
  });

  it("writes a caption file that stands on its own in Drive", () => {
    const body = captionFileBody({
      campaign: "VLF 2027", sequence: 3, platform: "Instagram — @paruluniversity",
      caption: "Two lines\nof caption",
    });
    expect(body).toContain("Campaign: VLF 2027");
    expect(body).toContain("Video Number: 3");
    expect(body).toContain("Platform/Page: Instagram — @paruluniversity");
    expect(body).toContain("Two lines\nof caption");
  });

  it("says so plainly when no platform was recorded", () => {
    const body = captionFileBody({ campaign: "X", sequence: 1, platform: null, caption: "c" });
    expect(body).toContain("Platform/Page: —");
  });
});

describe("campaign progress (§5)", () => {
  it("counts published against the target and shows what is left", () => {
    expect(campaignProgress({ requiredPosts: 40 }, 12)).toEqual({ required: 40, published: 12, remaining: 28 });
  });

  it("never reports negative remaining when a campaign overdelivers", () => {
    expect(campaignProgress({ requiredPosts: 10 }, 14)).toEqual({ required: 10, published: 14, remaining: 0 });
  });

  it("treats no target as nothing outstanding, not as everything outstanding", () => {
    expect(campaignProgress({ requiredPosts: 0 }, 5)).toEqual({ required: 0, published: 5, remaining: 0 });
  });
});

describe("an upload with and without a campaign record", () => {
  const editor: VideoUser = {
    id: "u-editor", name: "Ed", email: "ed@test.local", role: "editor",
    active: true, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  };

  async function fakeVideo(name: string): Promise<string> {
    const p = path.join(tmpRoot, name);
    await fs.writeFile(p, "not-really-a-video", "utf8");
    return p;
  }

  it("names a campaign's video the §10 way and files it under the campaign's folders", async () => {
    const campaign = await createCampaign(ACTOR, { ...base, name: "VLF 2027" });
    const v = await uploadVideo({
      editor, client: "ignored — the campaign's own name wins", campaignId: campaign.id,
      editorTitle: "Opening reel", caption: "Hello", platform: "Instagram",
      localPath: await fakeVideo("a.mp4"), originalName: "a.mp4", mimeType: "video/mp4", sizeBytes: 18,
    });

    expect(v.title).toBe("VLF 2027 - Video 1");
    expect(v.client).toBe("VLF 2027");
    expect(v.campaignId).toBe(campaign.id);
  });

  it("files and names an upload with no campaign record the same §9/§10 way", async () => {
    const v = await uploadVideo({
      editor, client: "Typed Campaign", editorTitle: "No record", caption: "Hello",
      localPath: await fakeVideo("b.mp4"), originalName: "b.mp4", mimeType: "video/mp4", sizeBytes: 18,
    });
    // Same naming and the same tree; only the link to a record is missing.
    expect(v.title).toBe("Typed Campaign - Video 1");
    expect(v.campaignId).toBeNull();
    expect(v.driveFolders?.videos).toContain(path.join("Social Media Campaigns", "Typed Campaign", "Videos"));
  });

  it("keeps numbering a campaign by its id across a rename, and starts a new one with the old name at 1", async () => {
    const original = await createCampaign(ACTOR, { ...base, name: "VLF 2027" });
    const upload = async (campaignId: string, file: string) => uploadVideo({
      editor, client: "", campaignId, editorTitle: "t", caption: "c",
      localPath: await fakeVideo(file), originalName: "a.mp4", mimeType: "video/mp4", sizeBytes: 18,
    });

    expect((await upload(original.id, "1.mp4")).title).toBe("VLF 2027 - Video 1");
    await updateCampaign(ACTOR, original.id, { name: "VLF 2027 old" });
    const reused = await createCampaign(ACTOR, { ...base, name: "VLF 2027" });

    // Used to be "VLF 2027 - Video 2", carrying on the renamed campaign's count…
    const fresh = await upload(reused.id, "2.mp4");
    expect(fresh.title).toBe("VLF 2027 - Video 1");
    // …and the renamed campaign started again at a second "Video 1".
    const next = await upload(original.id, "3.mp4");
    expect(next.title).toBe("VLF 2027 old - Video 2");
    // Two campaigns, two folders.
    expect(fresh.driveFolders?.videos).not.toBe(next.driveFolders?.videos);
  });

  it("carries a rename onto the campaign's videos, and only its own", async () => {
    const campaign = await createCampaign(ACTOR, { ...base, name: "VLF 2027" });
    const mine = await uploadVideo({
      editor, client: "", campaignId: campaign.id, editorTitle: "t", caption: "c",
      localPath: await fakeVideo("m.mp4"), originalName: "m.mp4", mimeType: "video/mp4", sizeBytes: 18,
    });
    /* Typed as a name no campaign has. (Typing the campaign's own name now
       files the upload under the campaign, so it would follow too.) */
    const typed = await uploadVideo({
      editor, client: "VLF 2028", editorTitle: "t", caption: "c",
      localPath: await fakeVideo("t.mp4"), originalName: "t.mp4", mimeType: "video/mp4", sizeBytes: 18,
    });
    const renamed = await updateCampaign(ACTOR, campaign.id, { name: "VLF 2027 old" });
    expect(await renameCampaignOnVideos(renamed.id, renamed.name)).toBe(1);
    const byId = new Map((await listVideos()).map(v => [v.id, v]));
    expect(byId.get(mine.id)?.client).toBe("VLF 2027 old");
    // A typed-in name has no campaign behind it to follow.
    expect(byId.get(typed.id)?.client).toBe("VLF 2028");
    // Nothing left to change, so nothing is written.
    expect(await renameCampaignOnVideos(renamed.id, renamed.name)).toBe(0);
  });

  it("numbers typed-in work, then the campaign made for it, as one sequence in one folder", async () => {
    const typed = async (file: string, client = "FIXR legacy") => uploadVideo({
      editor, client, editorTitle: "t", caption: "c",
      localPath: await fakeVideo(file), originalName: "a.mp4", mimeType: "video/mp4", sizeBytes: 18,
    });
    const picked = async (campaignId: string, file: string) => uploadVideo({
      editor, client: "", campaignId, editorTitle: "t", caption: "c",
      localPath: await fakeVideo(file), originalName: "a.mp4", mimeType: "video/mp4", sizeBytes: 18,
    });

    expect((await typed("1.mp4")).title).toBe("FIXR legacy - Video 1");
    expect((await typed("2.mp4")).title).toBe("FIXR legacy - Video 2");
    const campaign = await createCampaign(ACTOR, { ...base, name: "FIXR legacy" });

    /* Used to be a second "Video 1", written over the typed-in Video 1's file
       in the same folder; then typed and picked uploads each kept their own
       count, so 3 and 2 came round twice more. */
    const third = await picked(campaign.id, "3.mp4");
    expect(third.title).toBe("FIXR legacy - Video 3");
    const fourth = await typed("4.mp4", "fixr  LEGACY");
    expect(fourth.title).toBe("FIXR legacy - Video 4");
    // Typing the campaign's name files the upload under the campaign itself.
    expect(fourth.campaignId).toBe(campaign.id);
    expect((await picked(campaign.id, "5.mp4")).title).toBe("FIXR legacy - Video 5");

    const all = await listVideos();
    expect(all.map(v => v.sequence).sort()).toEqual([1, 2, 3, 4, 5]);
    expect(new Set(all.map(v => v.driveFileId)).size).toBe(5);
    expect(new Set(all.map(v => v.driveFolders?.videos)).size).toBe(1);
  });

  it("never files a typed-in name into the folder a renamed campaign still holds under it", async () => {
    const campaign = await createCampaign(ACTOR, { ...base, name: "VLF 2027" });
    const mine = await uploadVideo({
      editor, client: "", campaignId: campaign.id, editorTitle: "t", caption: "c",
      localPath: await fakeVideo("m.mp4"), originalName: "m.mp4", mimeType: "video/mp4", sizeBytes: 18,
    });
    await updateCampaign(ACTOR, campaign.id, { name: "VLF 2027 old" });
    // No campaign is called this any more; the renamed one's folder still is.
    const typed = await uploadVideo({
      editor, client: "VLF 2027", editorTitle: "t", caption: "c",
      localPath: await fakeVideo("t.mp4"), originalName: "t.mp4", mimeType: "video/mp4", sizeBytes: 18,
    });
    expect(typed.campaignId).toBeNull();
    expect(typed.driveFolders?.videos).not.toBe(mine.driveFolders?.videos);
    expect(typed.driveFileId).not.toBe(mine.driveFileId);
  });

  it("ties typed-in videos a campaign owns by name to it, so a rename takes them along", async () => {
    const typed = await uploadVideo({
      editor, client: "VLF 2027", editorTitle: "t", caption: "c",
      localPath: await fakeVideo("t.mp4"), originalName: "t.mp4", mimeType: "video/mp4", sizeBytes: 18,
    });
    const other = await uploadVideo({
      editor, client: "VLF 2028", editorTitle: "t", caption: "c",
      localPath: await fakeVideo("o.mp4"), originalName: "o.mp4", mimeType: "video/mp4", sizeBytes: 18,
    });
    const campaign = await createCampaign(ACTOR, { ...base, name: "VLF 2027" });
    expect(await claimNameOnlyVideos(campaign.id, campaign.name)).toBe(1);
    const renamed = await updateCampaign(ACTOR, campaign.id, { name: "VLF 2027 old" });
    await renameCampaignOnVideos(renamed.id, renamed.name);

    const byId = new Map((await listVideos()).map(v => [v.id, v]));
    expect(byId.get(typed.id)).toMatchObject({ campaignId: campaign.id, client: "VLF 2027 old" });
    // Another name's typed-in work is not the campaign's.
    expect(byId.get(other.id)).toMatchObject({ campaignId: null, client: "VLF 2028" });
    expect(await claimNameOnlyVideos(campaign.id, "VLF 2027")).toBe(0);
  });

  it("refuses an upload naming a campaign that does not exist", async () => {
    await expect(uploadVideo({
      editor, client: "X", campaignId: "no-such-campaign", editorTitle: "t", caption: "c",
      localPath: await fakeVideo("c.mp4"), originalName: "c.mp4", mimeType: "video/mp4", sizeBytes: 18,
    })).rejects.toThrow(/campaign was not found/i);
  });
});

describe("§3 — the pages a video is for", () => {
  const editor: VideoUser = {
    id: "u-ed2", name: "Ed Two", email: "ed2@test.local", role: "editor",
    active: true, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  };

  async function fakeVideo(name: string): Promise<string> {
    const p = path.join(tmpRoot, name);
    await fs.writeFile(p, "not-really-a-video", "utf8");
    return p;
  }

  it("records the pages the editor picked", async () => {
    const campaign = await createCampaign(ACTOR, { ...base, name: "Pages Campaign" });
    const v = await uploadVideo({
      editor, client: "x", campaignId: campaign.id, editorTitle: "t", caption: "c",
      socialPageIds: ["pg-a", "pg-b"], pageNames: ["@paruluniversity", "@parulsports"],
      localPath: await fakeVideo("p.mp4"), originalName: "p.mp4", mimeType: "video/mp4", sizeBytes: 18,
    });
    expect(v.socialPageIds).toEqual(["pg-a", "pg-b"]);
  });

  it("names those pages in the §10 caption sidecar", () => {
    const body = captionFileBody({
      campaign: "Pages Campaign", sequence: 1,
      platform: ["@paruluniversity", "@parulsports"].join(", "), caption: "hello",
    });
    expect(body).toContain("Platform/Page: @paruluniversity, @parulsports");
  });

  it("leaves the list empty when no page was picked", async () => {
    const campaign = await createCampaign(ACTOR, { ...base, name: "No Pages Campaign" });
    const v = await uploadVideo({
      editor, client: "x", campaignId: campaign.id, editorTitle: "t", caption: "c",
      localPath: await fakeVideo("q.mp4"), originalName: "q.mp4", mimeType: "video/mp4", sizeBytes: 18,
    });
    expect(v.socialPageIds).toEqual([]);
  });
});
