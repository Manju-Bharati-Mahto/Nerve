/**
 * Campaigns (Campaign & Content Management PRD §7, §9, §17).
 *
 * §17 is the reason this module exists: "One Campaign = One Centralized
 * Workspace". A campaign used to be whatever an editor typed into a box, so it
 * could not be assigned a manager, given a posting target, counted against, or
 * reliably matched — "VLF 2027" and "VLF2027" were two campaigns. Everything
 * the PRD asks a Manager to monitor (§5) and the dashboards to total (§12)
 * needs the campaign to exist on its own, which is what this provides.
 *
 * THE DRIVE LAYOUT (§9) APPLIES TO NEW CAMPAIGNS ONLY. The specification asks
 * for `Social Media Campaigns/<Campaign>/{Videos,Captions,Published}`; what is
 * already in Drive sits under `Videos/<campaign>/` with names of its own, and
 * people hold links to those files. So a campaign created here gets the §9
 * tree and records the folder ids on itself, and anything older keeps working
 * exactly where it is. `driveFolders` being null is how a record says "I am
 * from before" — see `assetFoldersFor`.
 */
import { randomUUID } from "node:crypto";
import { getDriveClient } from "./drive-client.js";
import { ensureDriveStructure, mutateCampaigns, readCampaigns } from "./drive-store.js";
import { activityEntry } from "./users.js";
import {
  CAMPAIGN_STATUSES,
  type ActivityEntry, type CampaignRecord, type CampaignStatus, type VideoUser,
} from "./types.js";

/** §9 — the root the PRD names, created beside the existing folders. */
export const CAMPAIGNS_ROOT_FOLDER = "Social Media Campaigns";
/** §9 — the three sub-folders every campaign gets. */
export const CAMPAIGN_SUBFOLDERS = ["Videos", "Captions", "Published"] as const;

export class CampaignNotFoundError extends Error {
  constructor(id: string) { super(`Campaign ${id} was not found.`); this.name = "CampaignNotFoundError"; }
}
export class CampaignExistsError extends Error {
  constructor(name: string) {
    super(`A campaign called "${name}" already exists.`);
    this.name = "CampaignExistsError";
  }
}
export class CampaignInUseError extends Error {
  constructor(name: string, count: number) {
    super(`"${name}" still has ${count} video${count === 1 ? "" : "s"}. Move or remove them first.`);
    this.name = "CampaignInUseError";
  }
}

/** Drive rejects some characters outright; the same rule the video upload uses. */
function safeFolderName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "-").trim();
}

/** Campaign names are matched case- and space-insensitively, so near-duplicates collide. */
function normaliseName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

export async function listCampaigns(): Promise<CampaignRecord[]> {
  const doc = await readCampaigns();
  return [...doc.campaigns].sort((a, b) => a.name.localeCompare(b.name));
}

export async function getCampaign(id: string): Promise<CampaignRecord | null> {
  const doc = await readCampaigns();
  return doc.campaigns.find(c => c.id === id) ?? null;
}

export async function findCampaignByName(name: string): Promise<CampaignRecord | null> {
  const wanted = normaliseName(name);
  const doc = await readCampaigns();
  return doc.campaigns.find(c => normaliseName(c.name) === wanted) ?? null;
}

export interface CampaignInput {
  name: string;
  description?: string;
  startDate: string;
  endDate: string;
  campaignManagerId?: string | null;
  socialPageIds?: string[];
  status?: CampaignStatus;
  requiredPosts?: number;
  notes?: string;
}

function validate(input: CampaignInput): void {
  if (!input.name.trim()) throw new Error("A campaign name is required.");
  for (const [label, value] of [["start", input.startDate], ["end", input.endDate]] as const) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`A valid ${label} date is required.`);
  }
  if (input.endDate < input.startDate) throw new Error("The end date cannot be before the start date.");
  if (input.status && !CAMPAIGN_STATUSES.includes(input.status)) {
    throw new Error("Pick one of Upcoming, Running or Completed.");
  }
  if (input.requiredPosts !== undefined && (!Number.isInteger(input.requiredPosts) || input.requiredPosts < 0)) {
    throw new Error("Posting requirement must be a whole number, or 0 for no target.");
  }
}

/**
 * §9 — builds this campaign's folder tree and returns the three ids.
 *
 * Failing to create folders must not cost the administrator the campaign: the
 * record is the authority, and uploads fall back to the original layout when
 * `driveFolders` is null. So the caller treats this as best-effort.
 */
async function createCampaignFolders(
  name: string,
): Promise<CampaignRecord["driveFolders"]> {
  const { client, rootId } = getDriveClient();
  const root = await client.ensureFolder(CAMPAIGNS_ROOT_FOLDER, rootId);
  const campaignFolder = await client.ensureFolder(safeFolderName(name), root);
  const [videos, captions, published] = await Promise.all(
    CAMPAIGN_SUBFOLDERS.map(sub => client.ensureFolder(sub, campaignFolder)),
  );
  return { videos, captions, published };
}

export async function createCampaign(actor: VideoUser, input: CampaignInput): Promise<CampaignRecord> {
  validate(input);
  const existing = await findCampaignByName(input.name);
  if (existing) throw new CampaignExistsError(input.name.trim());

  let driveFolders: CampaignRecord["driveFolders"] = null;
  try {
    driveFolders = await createCampaignFolders(input.name);
  } catch {
    // Recorded as "from before" and served by the original layout until an
    // upload or a later edit creates the tree.
    driveFolders = null;
  }

  const now = new Date().toISOString();
  const campaign: CampaignRecord = {
    id: randomUUID(),
    name: input.name.trim(),
    description: input.description?.trim() ?? "",
    startDate: input.startDate,
    endDate: input.endDate,
    campaignManagerId: input.campaignManagerId ?? null,
    socialPageIds: input.socialPageIds ?? [],
    status: input.status ?? "upcoming",
    requiredPosts: input.requiredPosts ?? 0,
    notes: input.notes?.trim() ?? "",
    driveFolders,
    createdAt: now,
    updatedAt: now,
    activity: [activityEntry(actor, "Campaign created", { notes: input.name.trim() })],
  };

  return mutateCampaigns(doc => {
    // Re-checked inside the write: findCampaignByName ran against a read that
    // another request could have moved on from.
    if (doc.campaigns.some(c => normaliseName(c.name) === normaliseName(campaign.name))) {
      throw new CampaignExistsError(campaign.name);
    }
    return { doc: { ...doc, campaigns: [...doc.campaigns, campaign] }, result: campaign };
  });
}

export async function updateCampaign(
  actor: VideoUser, id: string, patch: Partial<CampaignInput>,
): Promise<CampaignRecord> {
  const current = await getCampaign(id);
  if (!current) throw new CampaignNotFoundError(id);
  const merged: CampaignInput = {
    name: patch.name ?? current.name,
    startDate: patch.startDate ?? current.startDate,
    endDate: patch.endDate ?? current.endDate,
    status: patch.status ?? current.status,
    requiredPosts: patch.requiredPosts ?? current.requiredPosts,
  };
  validate(merged);

  const renamed = normaliseName(merged.name) !== normaliseName(current.name);

  return mutateCampaigns(doc => {
    const idx = doc.campaigns.findIndex(c => c.id === id);
    if (idx === -1) throw new CampaignNotFoundError(id);
    if (renamed && doc.campaigns.some(c => c.id !== id && normaliseName(c.name) === normaliseName(merged.name))) {
      throw new CampaignExistsError(merged.name);
    }
    const before = doc.campaigns[idx];
    const changes: string[] = [];
    if (renamed) changes.push(`renamed to "${merged.name.trim()}"`);
    if (patch.status && patch.status !== before.status) changes.push(`status ${before.status} → ${patch.status}`);
    if (patch.requiredPosts !== undefined && patch.requiredPosts !== before.requiredPosts) {
      changes.push(`target ${before.requiredPosts} → ${patch.requiredPosts}`);
    }
    if (patch.campaignManagerId !== undefined && patch.campaignManagerId !== before.campaignManagerId) {
      changes.push("campaign manager changed");
    }

    const updated: CampaignRecord = {
      ...before,
      name: merged.name.trim(),
      description: patch.description?.trim() ?? before.description,
      startDate: merged.startDate,
      endDate: merged.endDate,
      campaignManagerId: patch.campaignManagerId !== undefined ? patch.campaignManagerId : before.campaignManagerId,
      socialPageIds: patch.socialPageIds ?? before.socialPageIds,
      status: merged.status ?? before.status,
      requiredPosts: merged.requiredPosts ?? before.requiredPosts,
      notes: patch.notes?.trim() ?? before.notes,
      updatedAt: new Date().toISOString(),
      activity: [
        ...before.activity,
        activityEntry(actor, "Campaign updated", { notes: changes.join("; ") || "details edited" }),
      ],
    };
    const campaigns = [...doc.campaigns];
    campaigns[idx] = updated;
    return { doc: { ...doc, campaigns }, result: updated };
  });
}

/**
 * Removes a campaign that owns nothing.
 *
 * A campaign with videos is never deleted. §17 makes the campaign the thing
 * everything else hangs off, so removing one that still owns content would
 * orphan it — and the Drive folder would survive anyway, leaving assets with
 * nothing in the app pointing at them. The caller supplies the count rather
 * than this module reading the workflow store, so the two stores stay
 * independent.
 */
export async function deleteCampaign(actor: VideoUser, id: string, videoCount: number): Promise<void> {
  const current = await getCampaign(id);
  if (!current) throw new CampaignNotFoundError(id);
  if (videoCount > 0) throw new CampaignInUseError(current.name, videoCount);
  await mutateCampaigns(doc => ({
    doc: { ...doc, campaigns: doc.campaigns.filter(c => c.id !== id) },
    result: undefined,
  }));
  void actor;
}

/**
 * Where a campaign's assets belong in Drive.
 *
 * New campaigns carry their §9 folders. A campaign from before this existed,
 * or one whose folder creation failed, falls back to the original
 * `Videos/<campaign>/` location — which is where its files already are, so the
 * fallback is not a degraded path, it is the correct one for that campaign.
 */
export async function assetFoldersFor(
  campaign: Pick<CampaignRecord, "name" | "driveFolders">,
): Promise<{ videos: string; captions: string; published: string | null }> {
  if (campaign.driveFolders) return campaign.driveFolders;
  const { client } = getDriveClient();
  const folders = await ensureDriveStructure();
  const legacy = await client.ensureFolder(safeFolderName(campaign.name), folders.videos);
  return { videos: legacy, captions: legacy, published: null };
}

/**
 * §10 — the file name for a campaign's nth video: "VLF 2027 - Video 3".
 *
 * Only for campaigns created with the §9 layout. Everything older keeps
 * `<Campaign> Video <n>`, because those files are already named that way in
 * Drive and renaming them would break links people hold.
 */
export function campaignAssetName(campaignName: string, sequence: number): string {
  return `${campaignName.trim()} - Video ${sequence}`;
}

/**
 * §10 — the caption sidecar's contents.
 *
 * The PRD asks for more than the caption itself: campaign, video number and
 * the platform or page, so the file is readable on its own in Drive by
 * somebody who is not looking at the app.
 */
export function captionFileBody(input: {
  campaign: string; sequence: number; platform?: string | null; caption: string;
}): string {
  return [
    `Campaign: ${input.campaign.trim()}`,
    `Video Number: ${input.sequence}`,
    `Platform/Page: ${input.platform?.trim() || "—"}`,
    "",
    input.caption.trim(),
    "",
  ].join("\n");
}

/** §5 — progress for one campaign: what was asked for, what went out, what is left. */
export function campaignProgress(
  campaign: Pick<CampaignRecord, "requiredPosts">, publishedCount: number,
): { required: number; published: number; remaining: number } {
  const required = campaign.requiredPosts;
  return {
    required,
    published: publishedCount,
    // A target of 0 means none was set, so nothing is outstanding against it.
    remaining: required === 0 ? 0 : Math.max(0, required - publishedCount),
  };
}

export type { ActivityEntry };
