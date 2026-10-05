/**
 * Google Drive for the Outreach video workflow (PRD §23): which folder the
 * workflow lives beneath, and whether it is configured at all.
 *
 * The client classes themselves — GoogleDriveClient, LocalDriveClient and the
 * DriveClient interface — are shared with other Drive-backed workflows and live
 * in server/integrations/google-drive.ts. They are re-exported here so nothing
 * in this module (or its tests) has to know they moved.
 */
import { config } from "../config.js";
import {
  DriveNotConfiguredError, GoogleDriveClient, LocalDriveClient, googleDriveCredentialsConfigured,
  type DriveClient,
} from "../integrations/google-drive.js";

export {
  DRIVE_FOLDER_MIME, DriveNotConfiguredError, RevisionMismatchError,
  GoogleDriveClient, LocalDriveClient, googleDriveCredentialsConfigured,
  type DriveFileMeta, type DriveClient,
} from "../integrations/google-drive.js";

// ── Selection ──────────────────────────────────────────────────────────────
//
// Three ways Drive can be configured, in this order of precedence:
//
//   1. ENVIRONMENT — GOOGLE_DRIVE_ROOT_FOLDER_ID plus credentials. What a
//      deployer set explicitly for this workflow always wins.
//   2. THE APP CONNECTION — the Google account an Admin connected with the
//      "Sign in with Google" button in Casting Management. Before this, the
//      video workflow ignored that connection entirely, so getting it working
//      meant editing the server's env file and minting a refresh token in the
//      OAuth Playground even when the same Drive was already connected in the
//      app. Now one click covers both.
//   3. DRIVE_LOCAL_ROOT — the dev/test filesystem adapter. Last, so a leftover
//      dev setting can never redirect production onto the server's disk.
//
// The app connection lives in Postgres and has to be read asynchronously, but
// every call site below is synchronous. So it is resolved ahead of time by
// ensureDriveResolved() — called at the module's three entry points — and
// cached here for the synchronous checks to read.

/** The folder the workflow creates in a connected account's My Drive. */
export const APP_CONNECTION_ROOT_FOLDER = "NERVE Agency Video Workflow";
const ROOT_FOLDER_SETTING = "outreach_video.drive_root";

/** A negative answer is re-checked after this long, so connecting picks up. */
const RECHECK_MS = 60_000;

let appSource: { client: DriveClient; rootId: string; accountEmail: string | null } | null = null;
let checkedAt = 0;
let resolving: Promise<void> | null = null;

function envConfigured(): boolean {
  const d = config.drive;
  return !!d.rootFolderId && googleDriveCredentialsConfigured();
}

export function driveIsConfigured(): boolean {
  return envConfigured() || !!appSource || !!config.drive.localRoot;
}

/** True when running against the filesystem adapter rather than real Drive. */
export function driveIsLocal(): boolean {
  return !envConfigured() && !appSource && !!config.drive.localRoot;
}

/** Where Drive is coming from, for the status line. */
export function driveSource(): "env" | "app" | "local" | "none" {
  if (envConfigured()) return "env";
  if (appSource) return "app";
  if (config.drive.localRoot) return "local";
  return "none";
}

/**
 * Picks up the app connection if there is one. Cheap to call on every
 * request: it does nothing when the environment already configures Drive, and
 * otherwise reads the database at most once a minute until it finds one.
 *
 * Never throws. A database or Drive hiccup here must not take the module
 * down — the worst outcome is the "not connected" message, which is true.
 */
export async function ensureDriveResolved(): Promise<void> {
  if (envConfigured()) return;
  if (appSource) return;
  if (Date.now() - checkedAt < RECHECK_MS) return;
  if (resolving) return resolving;

  resolving = (async () => {
    try {
      // Imported lazily so this module, and every test that loads it, never
      // touches the database unless the app connection is actually wanted.
      const { loadCastingDriveConnection } = await import("../casting-drive.js");
      const connection = await loadCastingDriveConnection();
      if (!connection) return;

      const client = new GoogleDriveClient({
        clientId: connection.clientId,
        clientSecret: connection.clientSecret,
        refreshToken: connection.refreshToken,
      });
      const rootId = await rootFolderFor(client, connection.accountEmail);
      appSource = { client, rootId, accountEmail: connection.accountEmail };
      cached = null;
    } catch (err) {
      console.error("Outreach video: the app's Drive connection could not be used", err);
    } finally {
      checkedAt = Date.now();
      resolving = null;
    }
  })();
  return resolving;
}

/**
 * The workflow's own folder in the connected account — never the casting
 * folder, which holds applicant photos and has no place for workflow data.
 *
 * Remembered per account. Reconnecting a DIFFERENT Google account must not
 * reuse a folder id from the old one, which the new account cannot see.
 */
async function rootFolderFor(client: DriveClient, accountEmail: string | null): Promise<string> {
  const { getSetting, setSetting } = await import("../settings-db.js");
  const account = accountEmail ?? "";
  try {
    const saved = JSON.parse((await getSetting(ROOT_FOLDER_SETTING)) ?? "null") as
      { account: string; folderId: string } | null;
    if (saved?.folderId && saved.account === account) return saved.folderId;
  } catch { /* unreadable setting: fall through and find or create the folder */ }

  // 'root' is Drive's alias for the account's own My Drive.
  const folderId = await client.ensureFolder(APP_CONNECTION_ROOT_FOLDER, "root");
  await setSetting(ROOT_FOLDER_SETTING, JSON.stringify({ account, folderId }));
  return folderId;
}

/** Forget the app connection — called when an Admin connects, changes or disconnects it. */
export function resetAppDriveConnection(): void {
  appSource = null;
  checkedAt = 0;
  cached = null;
}

let cached: { client: DriveClient; rootId: string } | null = null;

/**
 * The configured client plus the id of the "Agency Video Workflow" root.
 * Real credentials always win over DRIVE_LOCAL_ROOT.
 */
export function getDriveClient(): { client: DriveClient; rootId: string } {
  if (cached) return cached;
  if (!driveIsConfigured()) throw new DriveNotConfiguredError();
  const source = driveSource();
  cached = source === "env"
    ? { client: new GoogleDriveClient(), rootId: config.drive.rootFolderId }
    : source === "app" && appSource
      ? { client: appSource.client, rootId: appSource.rootId }
      : { client: new LocalDriveClient(config.drive.localRoot), rootId: "root" };
  return cached;
}

/** Test seam — drops the memoised client so config changes take effect. */
export function resetDriveClient(): void {
  cached = null;
  appSource = null;
  checkedAt = 0;
}
