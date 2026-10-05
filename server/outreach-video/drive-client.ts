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
//   2. THE OUTREACH CONNECTION — the Google account the outreach Admin or
//      Manager connected from Video Workflow → Google Drive (see
//      drive-connection.ts). This is the normal way: no server files, no
//      OAuth Playground, just a sign-in.
//   3. DRIVE_LOCAL_ROOT — the dev/test filesystem adapter. Last, so a leftover
//      dev setting can never redirect production onto the server's disk.
//
// The app connection lives in Postgres and has to be read asynchronously, but
// every call site below is synchronous. So it is resolved ahead of time by
// ensureDriveResolved() — called at the module's three entry points — and
// cached here for the synchronous checks to read.

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
      // touches the database unless the outreach connection is actually wanted.
      const { loadOutreachDriveConnection } = await import("./drive-connection.js");
      const connection = await loadOutreachDriveConnection();
      if (!connection) return;

      const client = new GoogleDriveClient({
        clientId: connection.clientId,
        clientSecret: connection.clientSecret,
        refreshToken: connection.refreshToken,
      });
      // The folder was settled when the account was connected.
      appSource = { client, rootId: connection.folderId, accountEmail: connection.accountEmail };
      cached = null;
    } catch (err) {
      console.error("Outreach video: the outreach Drive connection could not be used", err);
    } finally {
      checkedAt = Date.now();
      resolving = null;
    }
  })();
  return resolving;
}

/** Forget the connection — called when it is connected, changed or disconnected. */
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
