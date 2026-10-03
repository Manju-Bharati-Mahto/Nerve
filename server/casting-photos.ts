/**
 * Casting registration photos — where an applicant's photo lives, and nothing
 * else about casting.
 *
 * The public registration form uploads a photo; this module puts it in a
 * Google Drive folder, in a sub-folder named after the request (CR-00012/),
 * and hands back the ids Nerve stores. Nerve keeps the ids and streams the
 * bytes on demand; it never keeps a copy of the image (Media Ops D5: "media
 * stays in Drive, we store links").
 *
 * WHICH Drive, in order:
 *   1. the one an Admin connected in the app (casting-drive.ts) — the button;
 *   2. the environment: GOOGLE_DRIVE_CASTING_FOLDER_ID plus the shared
 *      credentials in config.drive;
 *   3. with DRIVE_LOCAL_ROOT and no Google credentials, the filesystem
 *      adapter, so the whole intake runs in dev and tests.
 * The Drive client classes themselves are shared with the Outreach video
 * workflow (integrations/google-drive.ts). What is decided HERE is the root
 * folder and the naming.
 */
import { config } from "./config.js";
import {
  GoogleDriveClient, LocalDriveClient, googleDriveCredentialsConfigured,
  type DriveClient, type OAuthCredentials,
} from "./integrations/google-drive.js";

/* Raster photo types only, and the on-disk/Drive extension comes from the
   validated MIME — never from the uploaded filename, which the applicant
   controls. SVG is excluded on purpose: served same-origin it is a stored-XSS
   vector. GIF is excluded because this is a casting photo, not an animation. */
export const CASTING_PHOTO_MIME: Record<string, string> = {
  "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp",
};
export const CASTING_PHOTO_MAX_BYTES = 8 * 1024 * 1024;   // 8 MB — a phone photo, not a RAW
/** Sub-folder of DRIVE_LOCAL_ROOT used by the filesystem adapter. */
export const LOCAL_CASTING_FOLDER = "casting-photos";

export class CastingPhotosNotConfiguredError extends Error {
  constructor() {
    super("Photo upload is not configured. Set GOOGLE_DRIVE_CASTING_FOLDER_ID plus either service-account or OAuth credentials (or DRIVE_LOCAL_ROOT for local development).");
    this.name = "CastingPhotosNotConfiguredError";
  }
}

export type CastingPhotoSource = "app" | "env" | "local";
type Source = { kind: CastingPhotoSource; client: DriveClient; rootId: string; local: boolean };

/* The app-connected Drive is read from the database through this loader. It is
   a seam so the unit tests, and suites that only mean to exercise the local
   adapter, can say "no app connection" without a database row. */
export type AppConnectionLoader = () => Promise<(OAuthCredentials & { folderId: string }) | null>;
const defaultLoader: AppConnectionLoader = async () => (await import("./casting-drive.js")).loadCastingDriveConnection();
let loader: AppConnectionLoader = defaultLoader;
export function useCastingDriveLoader(fn: AppConnectionLoader | null): void { loader = fn ?? defaultLoader; resolved = undefined; }

/* Memoised once resolved — until resetCastingPhotoClient(), which every change
   to the connection calls. A loader FAILURE (database hiccup) is not memoised:
   the call falls through to the environment this once and asks again next time. */
let resolved: Source | null | undefined;
async function resolve(): Promise<Source | null> {
  if (resolved !== undefined) return resolved;
  let app: Awaited<ReturnType<AppConnectionLoader>> = null, loaderOk = true;
  try { app = await loader(); } catch (err) { loaderOk = false; console.error("Casting Drive connection could not be read", err); }
  let src: Source | null;
  if (app) src = { kind: "app", client: new GoogleDriveClient(app), rootId: app.folderId, local: false };
  /* Real credentials always win over DRIVE_LOCAL_ROOT, so a leftover dev
     setting cannot redirect production photos onto the server's disk. */
  else if (googleDriveCredentialsConfigured())
    src = config.drive.castingFolderId ? { kind: "env", client: new GoogleDriveClient(), rootId: config.drive.castingFolderId, local: false } : null;
  else if (config.drive.localRoot) src = { kind: "local", client: new LocalDriveClient(config.drive.localRoot), rootId: LOCAL_CASTING_FOLDER, local: true };
  else src = null;
  if (loaderOk) resolved = src;
  return src;
}

/** True when the public form should offer an upload rather than ask for a link. */
export async function castingPhotosConfigured(): Promise<boolean> { return !!(await resolve()); }
/** Which Drive photos would go to right now. */
export async function castingPhotoSource(): Promise<CastingPhotoSource | "none"> { return (await resolve())?.kind ?? "none"; }

async function drive(): Promise<Source> {
  const d = await resolve();
  if (!d) throw new CastingPhotosNotConfiguredError();
  return d;
}
/** Drops the memoised resolution so config or connection changes take effect. */
export function resetCastingPhotoClient(): void { resolved = undefined; }

/* A request code is the folder name AND, under the local adapter, a path
   segment. It is minted by the server (CR-00012), so anything else reaching
   here is a bug — refuse rather than let it become a path. */
const REQUEST_CODE = /^[A-Z]{1,8}-\d{1,12}$/;

export const castingPhotoExtension = (mimeType: string): string | null =>
  CASTING_PHOTO_MIME[mimeType] ?? null;

/** `CR-00012-photo-20261004-093012.jpg` — sortable, and says whose it is when
    seen on its own in Drive. A re-submission adds a new file beside the old. */
export function castingPhotoFileName(requestCode: string, mimeType: string, at: Date = new Date()): string {
  const stamp = at.toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
  return `${requestCode}-photo-${stamp}${CASTING_PHOTO_MIME[mimeType] ?? ".bin"}`;
}

export const driveFileUrl = (fileId: string): string => `https://drive.google.com/file/d/${encodeURIComponent(fileId)}/view`;
export const driveFolderUrl = (folderId: string): string => `https://drive.google.com/drive/folders/${encodeURIComponent(folderId)}`;

export interface StoredCastingPhoto {
  fileId: string;
  folderId: string;
  mimeType: string;
  /** Drive web links; null under the local adapter, where ids are paths. */
  webViewUrl: string | null;
  folderUrl: string | null;
}

/**
 * Puts one staged photo in `<casting root>/<requestCode>/`, creating the
 * request's folder on first use. The caller owns the staged file and removes
 * it afterwards whatever happens here.
 */
export async function storeCastingPhoto(args: { requestCode: string; localPath: string; mimeType: string }): Promise<StoredCastingPhoto> {
  if (!REQUEST_CODE.test(args.requestCode)) throw new Error(`Not a casting request code: ${args.requestCode}`);
  if (!CASTING_PHOTO_MIME[args.mimeType]) throw new Error(`Unsupported casting photo type: ${args.mimeType}`);
  const d = await drive();
  const folderId = await d.client.ensureFolder(args.requestCode, d.rootId);
  const meta = await d.client.uploadBinaryFile(
    castingPhotoFileName(args.requestCode, args.mimeType), folderId, args.localPath, args.mimeType);
  return {
    fileId: meta.id, folderId, mimeType: args.mimeType,
    webViewUrl: d.local ? null : driveFileUrl(meta.id),
    folderUrl: d.local ? null : driveFolderUrl(folderId),
  };
}

/** The photo's bytes, for streaming to an authorised browser. */
export async function openCastingPhoto(fileId: string): Promise<{
  body: ReadableStream<Uint8Array> | null; status: number; headers: Headers;
}> {
  return (await drive()).client.openStream(fileId);
}
