/**
 * The Google Drive an Admin connects IN THE APP for casting photos.
 *
 * The environment can configure Drive for casting (GOOGLE_DRIVE_CASTING_FOLDER_ID
 * plus credentials — see config.ts), but that asks the Casting Manager to visit
 * the OAuth Playground and edit server files. This module is the button
 * instead: an Admin signs in with Google once, Nerve keeps the refresh token
 * (sealed), and creates a "NERVE Casting Registrations" folder in that Drive.
 *
 * What still has to come from Google Cloud Console is the OAuth CLIENT — an id
 * and secret that identify this Nerve to Google. It can be set in the
 * environment (GOOGLE_OAUTH_CLIENT_ID / _SECRET, shared with the Outreach
 * video workflow) or pasted into the dialog and sealed here. The redirect URI
 * Google must be told is `${APP_BASE_URL}/api/v1/media/casting-drive/callback`;
 * Google accepts http only for localhost, and never a bare IP address.
 *
 * Nothing here is reached by anyone but an Admin (see the routes in
 * mediaops-api.ts), and nothing here decides who may see a photo.
 */
import { createHmac, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { pool } from "./db.js";
import { config } from "./config.js";
import { openSecret, sealSecret } from "./secret-box.js";
import { DRIVE_FOLDER_MIME, GoogleDriveClient, type OAuthCredentials } from "./integrations/google-drive.js";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";
/* Full Drive scope, not drive.file: the Admin may point Nerve at a folder they
   already have, which drive.file could never see. userinfo.email is only so
   the dialog can say WHICH account is connected. */
const SCOPES = ["https://www.googleapis.com/auth/drive", "https://www.googleapis.com/auth/userinfo.email"];
export const DEFAULT_FOLDER_NAME = "NERVE Casting Registrations";
const STATE_TTL_MS = 10 * 60 * 1000;
const SEAL = "casting-drive";

export const castingDriveRedirectUri = (): string =>
  `${config.appBaseUrl.replace(/\/+$/, "")}/api/v1/media/casting-drive/callback`;

export const driveFolderLink = (folderId: string): string =>
  `https://drive.google.com/drive/folders/${encodeURIComponent(folderId)}`;

/**
 * A folder id out of whatever the Admin pasted: the bare id, or any of the
 * shapes a Drive folder URL takes. Null when nothing id-like is in there.
 */
export function parseDriveFolderId(input: string): string | null {
  const s = String(input ?? "").trim();
  if (!s) return null;
  if (/^[A-Za-z0-9_-]{10,}$/.test(s)) return s;
  let u: URL;
  try { u = new URL(s); } catch { return null; }
  if (!/(^|\.)google\.com$/i.test(u.hostname)) return null;
  const m = u.pathname.match(/\/folders\/([A-Za-z0-9_-]{10,})/);
  if (m) return m[1];
  const q = u.searchParams.get("id");
  return q && /^[A-Za-z0-9_-]{10,}$/.test(q) ? q : null;
}

// ── The row ────────────────────────────────────────────────────────────────

interface DriveRow {
  oauth_client_id: string | null;
  oauth_client_secret_enc: string | null;
  refresh_token_enc: string | null;
  account_email: string | null;
  folder_id: string | null;
  folder_name: string | null;
  folder_url: string | null;
  connected_by: string | null;
  connected_at: string | null;
  connected_by_name?: string | null;
}

async function row(): Promise<DriveRow | null> {
  const r = await pool.query(
    `SELECT d.*, u.full_name AS connected_by_name
       FROM mo_casting_drive d LEFT JOIN users u ON u.id = d.connected_by WHERE d.id = 1`);
  return (r.rows[0] as DriveRow | undefined) ?? null;
}

/* The OAuth client: environment first (the deployer's choice wins and is never
   overwritten from the app), else what an Admin saved. */
type ClientCreds = { clientId: string; clientSecret: string; source: "env" | "app" };
function clientOf(r: DriveRow | null): ClientCreds | null {
  const d = config.drive;
  if (d.oauthClientId && d.oauthClientSecret) return { clientId: d.oauthClientId, clientSecret: d.oauthClientSecret, source: "env" };
  const secret = openSecret(r?.oauth_client_secret_enc, SEAL);
  if (r?.oauth_client_id && secret) return { clientId: r.oauth_client_id, clientSecret: secret, source: "app" };
  return null;
}

function connectionOf(r: DriveRow | null): (OAuthCredentials & { accountEmail: string | null }) | null {
  const client = clientOf(r);
  const refreshToken = openSecret(r?.refresh_token_enc, SEAL);
  if (!client || !refreshToken) return null;
  return { clientId: client.clientId, clientSecret: client.clientSecret, refreshToken, accountEmail: r?.account_email ?? null };
}

/** What casting-photos.ts needs to use this Drive, or null when not connected. */
export async function loadCastingDriveConnection(): Promise<(OAuthCredentials & { folderId: string; accountEmail: string | null }) | null> {
  const r = await row();
  const c = connectionOf(r);
  if (!c || !r?.folder_id) return null;
  return { ...c, folderId: r.folder_id };
}

export interface CastingDriveStatus {
  client: "env" | "app" | "none";
  client_id: string | null;
  redirect_uri: string;
  connected: boolean;
  account_email: string | null;
  folder: { id: string; name: string | null; url: string | null } | null;
  connected_at: string | null;
  connected_by: string | null;
  connected_by_name: string | null;
  default_folder_name: string;
}

export async function castingDriveStatus(): Promise<CastingDriveStatus> {
  const r = await row();
  const client = clientOf(r);
  return {
    client: client?.source ?? "none",
    client_id: client?.clientId ?? null,
    redirect_uri: castingDriveRedirectUri(),
    connected: !!connectionOf(r),
    account_email: r?.account_email ?? null,
    folder: r?.folder_id ? { id: r.folder_id, name: r.folder_name, url: r.folder_url } : null,
    connected_at: r?.connected_at ?? null,
    connected_by: r?.connected_by ?? null,
    connected_by_name: r?.connected_by_name ?? null,
    default_folder_name: DEFAULT_FOLDER_NAME,
  };
}

export async function saveCastingDriveClient(clientId: string, clientSecret: string): Promise<void> {
  await pool.query(
    `INSERT INTO mo_casting_drive (id, oauth_client_id, oauth_client_secret_enc, updated_at)
     VALUES (1, $1, $2, NOW())
     ON CONFLICT (id) DO UPDATE SET oauth_client_id = EXCLUDED.oauth_client_id,
       oauth_client_secret_enc = EXCLUDED.oauth_client_secret_enc, updated_at = NOW()`,
    [clientId.trim(), sealSecret(clientSecret.trim(), SEAL)]);
}

// ── The OAuth dance ────────────────────────────────────────────────────────

/* `state` ties the callback to the Admin who pressed the button: signed, so a
   crafted callback cannot connect somebody else's Drive to this Nerve, and
   short-lived, so a stale popup is refused rather than honoured. */
const stateKey = () => createHash("sha256").update(`${config.sessionSecret}\u0000casting-drive-state`).digest();
const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const sign = (payload: string) => b64u(createHmac("sha256", stateKey()).update(payload).digest());

export function signDriveState(userId: string, now: number = Date.now()): string {
  const payload = b64u(JSON.stringify({ u: userId, e: now + STATE_TTL_MS, n: randomBytes(8).toString("hex") }));
  return `${payload}.${sign(payload)}`;
}

/** True when `state` was signed here for this user and has not expired. */
export function verifyDriveState(state: string, userId: string, now: number = Date.now()): boolean {
  const [payload, mac] = String(state ?? "").split(".");
  if (!payload || !mac) return false;
  const want = Buffer.from(sign(payload)), got = Buffer.from(mac);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return false;
  try {
    const p = JSON.parse(Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")) as { u?: string; e?: number };
    return p.u === userId && typeof p.e === "number" && p.e > now;
  } catch {
    return false;
  }
}

export class CastingDriveError extends Error {
  constructor(message: string, readonly status = 400) { super(message); this.name = "CastingDriveError"; }
}

/** Where to send the Admin's browser. Needs an OAuth client. */
export async function castingDriveAuthUrl(userId: string): Promise<string> {
  const client = clientOf(await row());
  if (!client) throw new CastingDriveError("Add the Google Cloud OAuth client (id and secret) before connecting.");
  const q = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: castingDriveRedirectUri(),
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",      // a refresh token, not just an hour's access
    prompt: "consent",           // Google only returns a refresh token on a consent screen
    include_granted_scopes: "true",
    state: signDriveState(userId),
  });
  return `${AUTH_URL}?${q.toString()}`;
}

async function googleJson<T>(res: Response, what: string): Promise<T> {
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new CastingDriveError(`Google refused the ${what} (HTTP ${res.status}): ${text.slice(0, 200)}`, 502);
  }
  return res.json() as Promise<T>;
}

/**
 * The callback: code → refresh token → which account → stored → a folder.
 * Returns what the popup should say.
 */
export async function completeCastingDriveConnect(code: string, userId: string): Promise<{ email: string; folder: { id: string; name: string; url: string } }> {
  const current = await row();
  const client = clientOf(current);
  if (!client) throw new CastingDriveError("The OAuth client is no longer configured.");

  const tok = await googleJson<{ access_token?: string; refresh_token?: string }>(await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code, client_id: client.clientId, client_secret: client.clientSecret,
      redirect_uri: castingDriveRedirectUri(), grant_type: "authorization_code",
    }).toString(),
  }), "sign-in");
  if (!tok.refresh_token || !tok.access_token)
    throw new CastingDriveError("Google did not return a long-lived token. Remove NERVE under myaccount.google.com → Security → Third-party access, then connect again.", 502);

  const who = await googleJson<{ email?: string }>(await fetch(USERINFO_URL, {
    headers: { Authorization: `Bearer ${tok.access_token}` },
  }), "account lookup");
  const email = String(who.email ?? "").toLowerCase();

  await pool.query(
    `INSERT INTO mo_casting_drive (id, refresh_token_enc, account_email, connected_by, connected_at, updated_at)
     VALUES (1, $1, $2, $3, NOW(), NOW())
     ON CONFLICT (id) DO UPDATE SET refresh_token_enc = EXCLUDED.refresh_token_enc,
       account_email = EXCLUDED.account_email, connected_by = EXCLUDED.connected_by,
       connected_at = NOW(), updated_at = NOW()`,
    [sealSecret(tok.refresh_token, SEAL), email || null, userId]);

  /* A folder to put photos in. The one already configured is kept if THIS
     account can still see it (a reconnect); otherwise a fresh one is created
     in the account's My Drive, so connecting is never "connected, but
     nowhere to put anything". */
  const drive = new GoogleDriveClient({ clientId: client.clientId, clientSecret: client.clientSecret, refreshToken: tok.refresh_token });
  let folder: { id: string; name: string } | null = null;
  if (current?.folder_id) {
    try {
      const meta = await drive.getMeta(current.folder_id);
      if (meta.mimeType === DRIVE_FOLDER_MIME) folder = { id: meta.id, name: meta.name || current.folder_name || DEFAULT_FOLDER_NAME };
    } catch { folder = null; }
  }
  if (!folder) folder = { id: await drive.ensureFolder(DEFAULT_FOLDER_NAME, "root"), name: DEFAULT_FOLDER_NAME };
  const url = driveFolderLink(folder.id);
  await pool.query(
    `UPDATE mo_casting_drive SET folder_id = $1, folder_name = $2, folder_url = $3, updated_at = NOW() WHERE id = 1`,
    [folder.id, folder.name, url]);
  return { email, folder: { ...folder, url } };
}

async function connectedDrive(): Promise<{ drive: GoogleDriveClient; email: string | null }> {
  const c = connectionOf(await row());
  if (!c) throw new CastingDriveError("Google Drive is not connected. Sign in with Google first.", 409);
  return { drive: new GoogleDriveClient(c), email: c.accountEmail };
}

/** Point casting photos at a folder the Admin already has, by link or id. */
export async function useCastingDriveFolder(input: string): Promise<{ id: string; name: string; url: string }> {
  const id = parseDriveFolderId(input);
  if (!id) throw new CastingDriveError("Paste a Google Drive folder link, or the folder's id.");
  const { drive, email } = await connectedDrive();
  let meta;
  try { meta = await drive.getMeta(id); }
  catch { throw new CastingDriveError(`Google Drive could not open that folder. Check the link, and that ${email ?? "the connected account"} can access it.`); }
  if (meta.mimeType !== DRIVE_FOLDER_MIME) throw new CastingDriveError("That link is a file, not a folder.");
  const url = driveFolderLink(meta.id);
  await pool.query(
    `UPDATE mo_casting_drive SET folder_id = $1, folder_name = $2, folder_url = $3, updated_at = NOW() WHERE id = 1`,
    [meta.id, meta.name || null, url]);
  return { id: meta.id, name: meta.name, url };
}

/** Create a folder in the connected account's My Drive and point photos at it. */
export async function createCastingDriveFolder(name: string): Promise<{ id: string; name: string; url: string }> {
  const clean = String(name ?? "").trim().slice(0, 120) || DEFAULT_FOLDER_NAME;
  const { drive } = await connectedDrive();
  const id = await drive.ensureFolder(clean, "root");
  const url = driveFolderLink(id);
  await pool.query(
    `UPDATE mo_casting_drive SET folder_id = $1, folder_name = $2, folder_url = $3, updated_at = NOW() WHERE id = 1`,
    [id, clean, url]);
  return { id, name: clean, url };
}

/** Can the connected account still see the configured folder? */
export async function checkCastingDrive(): Promise<{ ok: boolean; folder_name?: string; error?: string }> {
  const r = await row();
  const c = connectionOf(r);
  if (!c) return { ok: false, error: "Google Drive is not connected." };
  if (!r?.folder_id) return { ok: false, error: "No folder is configured yet." };
  try {
    const meta = await new GoogleDriveClient(c).getMeta(r.folder_id);
    if (meta.mimeType !== DRIVE_FOLDER_MIME) return { ok: false, error: "The configured id is not a folder." };
    return { ok: true, folder_name: meta.name };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Forget the connection. The folder and its photos stay in Drive; the OAuth
    client is kept so reconnecting is one click. Revocation is best effort. */
export async function disconnectCastingDrive(): Promise<void> {
  const c = connectionOf(await row());
  if (c) {
    await fetch(`${REVOKE_URL}?token=${encodeURIComponent(c.refreshToken)}`, { method: "POST" }).catch(() => undefined);
  }
  await pool.query(
    `UPDATE mo_casting_drive SET refresh_token_enc = NULL, account_email = NULL, connected_by = NULL,
       connected_at = NULL, updated_at = NOW() WHERE id = 1`);
}
