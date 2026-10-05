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

import { uploadVideo } from "./videos.js";

import { config } from "../config.js";
import { resetDriveClient } from "./drive-client.js";
import { resetStoreState } from "./drive-store.js";
import {
  CAMPAIGN_SUBFOLDERS, CampaignExistsError, CampaignInUseError, CampaignNotFoundError,
  assetFoldersFor, campaignAssetName, campaignProgress, captionFileBody,
  createCampaign, deleteCampaign, findCampaignByName, getCampaign, listCampaigns, updateCampaign,
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

  it("falls back to the original location for a campaign from before", async () => {
    /* driveFolders: null is a record predating §9. Its files are already under
       Videos/<name>, so that is where to look — and `published` is null
       because no such folder was ever created for it. */
    const folders = await assetFoldersFor({ name: "Old Campaign", driveFolders: null });
    expect(folders.videos).toBeTruthy();
    expect(folders.captions).toBe(folders.videos);
    expect(folders.published).toBeNull();
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

describe("an upload against a real campaign vs one from before", () => {
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

  it("leaves an upload with no campaign record exactly as it was", async () => {
    const v = await uploadVideo({
      editor, client: "Old Campaign", editorTitle: "Legacy", caption: "Hello",
      localPath: await fakeVideo("b.mp4"), originalName: "b.mp4", mimeType: "video/mp4", sizeBytes: 18,
    });

    // The original naming, and no campaign — which is what marks it legacy.
    expect(v.title).toBe("Old Campaign Video 1");
    expect(v.campaignId).toBeNull();
  });

  it("refuses an upload naming a campaign that does not exist", async () => {
    await expect(uploadVideo({
      editor, client: "X", campaignId: "no-such-campaign", editorTitle: "t", caption: "c",
      localPath: await fakeVideo("c.mp4"), originalName: "c.mp4", mimeType: "video/mp4", sizeBytes: 18,
    })).rejects.toThrow(/campaign was not found/i);
  });
});
