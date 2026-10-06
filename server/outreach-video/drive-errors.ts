/**
 * What to tell someone when Google Drive lets the video workflow down.
 *
 * Every piece of workflow data — users, videos, activity — lives in Drive
 * (drive-store.ts), so a Drive failure is not one broken feature, it is every
 * screen at once. Before this module, a revoked refresh token surfaced as a
 * plain Error deep inside the token refresh, nothing recognised it, and every
 * endpoint answered a bare 500 "Internal server error." — the Users page
 * simply stopped working with nothing to say why or who could fix it.
 *
 * Three answers, each naming who can act:
 *   - drive_reconnect   (503) the grant is dead; an Admin/Manager signs in again
 *   - drive_unavailable (502) Google did not answer; usually try again
 *   - drive_not_connected (503) nobody has connected a Drive yet
 *
 * Kept free of Express so the mapping is testable on its own.
 */
import {
  DRIVE_FOLDER_MIME, DriveAuthError, DriveNotConfiguredError, DriveUnavailableError, type DriveClient,
} from "./drive-client.js";

export const DRIVE_NOT_CONNECTED_MESSAGE =
  "The video workflow is not connected to Google Drive yet. An outreach Admin or Manager can connect it under Video Workflow → Google Drive.";
export const DRIVE_RECONNECT_MESSAGE =
  "The outreach Google Drive connection has expired or was revoked. An outreach Admin or Manager must reconnect it under Video Workflow → Google Drive.";

export type DriveErrorCode = "drive_reconnect" | "drive_unavailable" | "drive_not_connected";

export interface DriveErrorResponse { status: number; message: string; code: DriveErrorCode }

/** A few words on why Drive did not answer, for the end of the message. */
export function shortReason(err: DriveUnavailableError): string {
  const s = err.status;
  if (s === 403) return "HTTP 403 — access refused or quota exceeded";
  if (s === 404) return "HTTP 404 — the folder or file was not found";
  if (s === 408) return "HTTP 408 — the request timed out";
  if (s === 429) return "HTTP 429 — too many requests";
  if (s !== null) return `HTTP ${s}`;
  // "Google Drive could not be reached (timed out)." → "timed out"
  const m = /\(([^()]+)\)\.?$/.exec(err.message);
  return m ? m[1] : "no answer";
}

/** The JSON answer for a Drive failure, or null when `err` is not one. */
export function driveErrorResponse(err: unknown): DriveErrorResponse | null {
  if (err instanceof DriveAuthError) {
    return { status: 503, message: DRIVE_RECONNECT_MESSAGE, code: "drive_reconnect" };
  }
  if (err instanceof DriveUnavailableError) {
    return {
      status: 502,
      message: `Google Drive did not answer (${shortReason(err)}). Please try again; if it keeps happening, reconnect under Video Workflow → Google Drive.`,
      code: "drive_unavailable",
    };
  }
  if (err instanceof DriveNotConfiguredError) {
    return { status: 503, message: DRIVE_NOT_CONNECTED_MESSAGE, code: "drive_not_connected" };
  }
  return null;
}

// ── Health ─────────────────────────────────────────────────────────────────
//
// The Drive dialog used to say "Connected" for as long as a refresh token was
// stored, whether or not Google still honoured it. So the status payload now
// carries the result of actually asking: read the workflow's root folder, the
// cheapest call that exercises the token, the account's access and the
// folder all at once.

export type DriveProblem = "expired" | "folder_missing" | "unreachable";

export interface DriveHealth {
  /** null when there is no real Drive to ask (not connected, or the local adapter). */
  healthy: boolean | null;
  problem: DriveProblem | null;
  problemMessage: string | null;
}

export const UNKNOWN_HEALTH: DriveHealth = { healthy: null, problem: null, problemMessage: null };

/**
 * Asks Drive for the root folder's metadata, within `timeoutMs`. Never throws:
 * the answer to "is Drive working" is a value, not an exception.
 */
export async function probeDrive(client: DriveClient, rootId: string, timeoutMs = 8_000): Promise<DriveHealth> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DriveUnavailableError("Google Drive could not be reached (timed out).")), timeoutMs);
  });
  try {
    const meta = await Promise.race([client.getMeta(rootId), deadline]);
    if (meta.mimeType !== DRIVE_FOLDER_MIME) {
      return { healthy: false, problem: "folder_missing", problemMessage: "The workflow's Drive folder is not a folder any more. Choose the folder again under Video Workflow → Google Drive." };
    }
    return { healthy: true, problem: null, problemMessage: null };
  } catch (err) {
    if (err instanceof DriveAuthError) {
      return { healthy: false, problem: "expired", problemMessage: DRIVE_RECONNECT_MESSAGE };
    }
    if (err instanceof DriveUnavailableError && err.status === 404) {
      return { healthy: false, problem: "folder_missing", problemMessage: "The connected account cannot see the workflow's Drive folder (it was deleted, moved to Trash, or unshared). Choose the folder again, or reconnect, under Video Workflow → Google Drive." };
    }
    const reason = err instanceof DriveUnavailableError ? shortReason(err) : (err instanceof Error ? err.message : String(err));
    return { healthy: false, problem: "unreachable", problemMessage: `Google Drive did not answer (${reason}).` };
  } finally {
    clearTimeout(timer);
  }
}

const HEALTH_TTL_MS = 60_000;
let cachedHealth: { at: number; key: string; value: DriveHealth } | null = null;

/**
 * probeDrive, remembered for a minute per Drive (`key` names which one), so a
 * dialog left open and polling does not turn into a stream of Drive calls.
 */
export async function cachedDriveHealth(key: string, probe: () => Promise<DriveHealth>): Promise<DriveHealth> {
  if (cachedHealth && cachedHealth.key === key && Date.now() - cachedHealth.at < HEALTH_TTL_MS) return cachedHealth.value;
  const value = await probe();
  cachedHealth = { at: Date.now(), key, value };
  return value;
}

/** Forget the last probe — after a connect, a disconnect, or a fresh auth failure. */
export function resetDriveHealth(): void {
  cachedHealth = null;
}
