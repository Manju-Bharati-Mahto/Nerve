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

export function driveIsConfigured(): boolean {
  const d = config.drive;
  const hasGoogle = !!d.rootFolderId && googleDriveCredentialsConfigured();
  return hasGoogle || !!d.localRoot;
}

/** True when running against the filesystem adapter rather than real Drive. */
export function driveIsLocal(): boolean {
  const d = config.drive;
  const hasGoogle = !!d.rootFolderId && googleDriveCredentialsConfigured();
  return !hasGoogle && !!d.localRoot;
}

let cached: { client: DriveClient; rootId: string } | null = null;

/**
 * The configured client plus the id of the "Agency Video Workflow" root.
 * Real credentials always win over DRIVE_LOCAL_ROOT.
 */
export function getDriveClient(): { client: DriveClient; rootId: string } {
  if (cached) return cached;
  if (!driveIsConfigured()) throw new DriveNotConfiguredError();
  cached = driveIsLocal()
    ? { client: new LocalDriveClient(config.drive.localRoot), rootId: "root" }
    : { client: new GoogleDriveClient(), rootId: config.drive.rootFolderId };
  return cached;
}

/** Test seam — drops the memoised client so config changes take effect. */
export function resetDriveClient(): void {
  cached = null;
}
