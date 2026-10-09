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
import { mutateCampaigns, onDriveReset, readCampaigns } from "./drive-store.js";
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
/*
 * The message used to say "Move or remove them first", but nothing in the app
 * moves or removes a video — so a campaign that had received a single upload
 * sent people looking for a button that does not exist. What they can do is
 * close it, and the message says so.
 */
export class CampaignInUseError extends Error {
  constructor(name: string, count: number) {
    super(`"${name}" holds ${count} video${count === 1 ? "" : "s"}, and a campaign that holds videos `
      + "cannot be deleted. Set its status to Completed to close it instead.");
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

/**
 * Whether `value` is a YYYY-MM-DD date that exists on the calendar.
 *
 * The shape alone let "2026-02-31" through, and campaigns live as JSON in
 * Drive, so no database column refuses it either: it was saved, shown, and
 * compared as a string against real dates for status and progress. A date
 * that does not exist does not survive a round trip through Date.
 */
export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function validate(input: CampaignInput): void {
  if (!input.name.trim()) throw new Error("A campaign name is required.");
  for (const [label, value] of [["start", input.startDate], ["end", input.endDate]] as const) {
    if (typeof value !== "string" || !isCalendarDate(value)) throw new Error(`A valid ${label} date is required.`);
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
/*
 * Folder creation is find-then-create, which is not atomic: two uploads to the
 * same campaign arriving together would each find nothing and each create a
 * "VLF 2027" folder, and Google Drive happily keeps both. So every folder
 * lookup goes through one queue, and a resolved tree is remembered for the
 * life of the process. Nerve runs a single API container, so an in-process
 * queue covers the real deployment.
 */
let folderQueue: Promise<unknown> = Promise.resolve();
const folderCache = new Map<string, NonNullable<CampaignRecord["driveFolders"]>>();

function serialised<T>(fn: () => Promise<T>): Promise<T> {
  const run = folderQueue.then(fn, fn);
  folderQueue = run.catch(() => undefined);
  return run;
}

/** Drops remembered folder ids — the Drive they belong to has changed. */
export function resetCampaignFolderCache(): void {
  folderCache.clear();
}
onDriveReset(resetCampaignFolderCache);

/**
 * §9 — `Social Media Campaigns/<name>/{Videos, Captions, Published}`, created
 * where missing and returned as three ids. Safe to call repeatedly.
 *
 * Keyed on the folder NAME, so two callers asking for one name get one tree.
 * Whether that tree is free for a particular campaign is foldersOwnedBy's
 * question, not this one's.
 */
async function createCampaignFolders(
  name: string,
): Promise<NonNullable<CampaignRecord["driveFolders"]>> {
  const key = normaliseName(name);
  const known = folderCache.get(key);
  if (known) return known;
  return serialised(async () => {
    const again = folderCache.get(key);
    if (again) return again;
    const { client, rootId } = getDriveClient();
    const root = await client.ensureFolder(CAMPAIGNS_ROOT_FOLDER, rootId);
    const campaignFolder = await client.ensureFolder(safeFolderName(name), root);
    // One at a time, for the same reason as above.
    const videos = await client.ensureFolder(CAMPAIGN_SUBFOLDERS[0], campaignFolder);
    const captions = await client.ensureFolder(CAMPAIGN_SUBFOLDERS[1], campaignFolder);
    const published = await client.ensureFolder(CAMPAIGN_SUBFOLDERS[2], campaignFolder);
    const tree = { videos, captions, published };
    folderCache.set(key, tree);
    return tree;
  });
}

/** How many "<name> (n)" folder names to try before giving up. */
const MAX_FOLDER_SUFFIX = 50;

/**
 * The §9 tree for campaign `campaignId`, never one another campaign already
 * holds.
 *
 * A Drive folder is found by its name, and a rename leaves the renamed
 * campaign's folder where it was (still under the old name — the Drive client
 * has no rename). So a new campaign given that old name used to resolve to the
 * same folder: two campaigns' videos mixed together, numbered as one. When the
 * plain name's tree belongs to another campaign record, this files the new one
 * under "<name> (2)", "<name> (3)"… instead.
 *
 * Folders that no campaign record holds are free to take: they are the work a
 * typed-in campaign name collected before campaigns were records, and a
 * campaign created for that name is meant to pick it up.
 */
async function foldersOwnedBy(
  campaignId: string | null, name: string,
): Promise<NonNullable<CampaignRecord["driveFolders"]>> {
  const doc = await readCampaigns();
  const taken = new Set(doc.campaigns
    .filter(c => c.id !== campaignId && c.driveFolders?.videos)
    .map(c => c.driveFolders!.videos));
  for (let n = 1; n <= MAX_FOLDER_SUFFIX; n += 1) {
    const tree = await createCampaignFolders(n === 1 ? name : `${name.trim()} (${n})`);
    if (!taken.has(tree.videos)) return tree;
  }
  throw new Error(`Google Drive already holds too many folders named "${name.trim()}".`);
}

export async function createCampaign(actor: VideoUser, input: CampaignInput): Promise<CampaignRecord> {
  validate(input);
  const existing = await findCampaignByName(input.name);
  if (existing) throw new CampaignExistsError(input.name.trim());

  let driveFolders: CampaignRecord["driveFolders"] = null;
  try {
    driveFolders = await foldersOwnedBy(null, input.name);
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
 * Where a campaign's assets belong in Drive: always the §9 tree.
 *
 * Every upload goes here — a campaign record's own folders when it has them,
 * otherwise the tree is created for the campaign's name. There used to be a
 * second, older layout (`Videos/<campaign>/`) kept for files already filed
 * that way, but the outreach Drive is a fresh one with nothing in the old
 * layout, so keeping two layouts would only have meant new uploads landing in
 * the wrong place.
 */
export async function assetFoldersFor(
  campaign: Pick<CampaignRecord, "name" | "driveFolders"> & { id?: string },
): Promise<{ videos: string; captions: string; published: string }> {
  if (campaign.driveFolders?.published) return campaign.driveFolders;
  // Neither a record whose folders were never made nor a typed-in name with
  // no record may borrow another campaign's tree just because the names
  // match. A typed-in name used to resolve to the folder a since-renamed
  // campaign still holds under that name, where its "Video 1" landed on top
  // of the renamed campaign's "Video 1".
  return foldersOwnedBy(campaign.id ?? null, campaign.name);
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
