/**
 * The outreach team's own Google Drive connection.
 *
 * The video workflow keeps everything in Google Drive (Campaign & Content
 * Management PRD §9): one folder per campaign with Videos, Captions and
 * Published inside. This module is how that Drive gets connected — from the
 * outreach video workflow itself, by the outreach Admin or Manager, with a
 * "Sign in with Google" button.
 *
 * It is deliberately separate from the Casting Drive connection in Media Ops.
 * They are different teams with different Google accounts: casting photos go
 * to whoever runs casting, outreach videos go to the outreach account
 * (outreach.socialintern@paruluniversity.ac.in). Sharing one connection meant
 * the outreach team could only be set up from inside Media Ops, by a Media
 * Ops admin, into whatever account casting happened to use.
 *
 * WHICH ACCOUNT. The connection is pinned to an expected Google account. If
 * somebody signs in with a different one — easy to do, when a browser has a
 * personal account signed in as well — the sign-in is refused and the token
 * thrown away, rather than quietly filing every video into the wrong person's
 * Drive. Google is also asked to preselect that account (`login_hint`).
 *
 * What still has to come from Google Cloud Console is the OAuth CLIENT — the
 * id and secret that identify Nerve to Google — with this module's redirect
 * URI registered on it. It can come from the environment
 * (GOOGLE_OAUTH_CLIENT_ID / _SECRET) or be pasted into the dialog, where it is
 * stored sealed.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { pool } from "../db.js";
import { config } from "../config.js";
import { openSecret, sealSecret } from "../secret-box.js";
import { DRIVE_FOLDER_MIME, GoogleDriveClient, type OAuthCredentials } from "../integrations/google-drive.js";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";
/* Full Drive scope, not drive.file: the team may point Nerve at a folder they
   already have, which drive.file could never see. userinfo.email is how the
   sign-in is checked against the expected account. */
const SCOPES = ["https://www.googleapis.com/auth/drive", "https://www.googleapis.com/auth/userinfo.email"];
const STATE_TTL_MS = 10 * 60 * 1000;
const SEAL = "outreach-drive";

/** The account the outreach team asked for. Changeable from the dialog. */
export const DEFAULT_EXPECTED_ACCOUNT = "outreach.socialintern@paruluniversity.ac.in";
/** The workflow's folder in that account's My Drive, created on first connect. */
export const DEFAULT_ROOT_FOLDER = "Outreach Video Workflow";

export const outreachDriveRedirectUri = (): string =>
  `${config.appBaseUrl.replace(/\/+$/, "")}/api/outreach/video/drive/callback`;

export const driveFolderLink = (folderId: string): string =>
  `https://drive.google.com/drive/folders/${encodeURIComponent(folderId)}`;

/** A folder id out of whatever was pasted: the bare id, or a Drive folder URL. */
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

export class OutreachDriveError extends Error {
  constructor(message: string, readonly status = 400) { super(message); this.name = "OutreachDriveError"; }
}

// ── The row ────────────────────────────────────────────────────────────────

interface Row {
  oauth_client_id: string | null;
  oauth_client_secret_enc: string | null;
  refresh_token_enc: string | null;
  account_email: string | null;
  expected_email: string | null;
  folder_id: string | null;
  folder_name: string | null;
  folder_url: string | null;
  connected_by: string | null;
  connected_at: string | null;
  connected_by_name?: string | null;
}

/* Created on first use rather than in a boot migration, so this module is
   self-contained: nothing else has to know the table exists. One row, id 1. */
let tableReady: Promise<void> | null = null;
function ensureTable(): Promise<void> {
  tableReady ??= pool.query(`
    CREATE TABLE IF NOT EXISTS ov_drive_connection (
      id                      INTEGER PRIMARY KEY CHECK (id = 1),
      oauth_client_id         TEXT,
      oauth_client_secret_enc TEXT,
      refresh_token_enc       TEXT,
      account_email           TEXT,
      expected_email          TEXT,
      folder_id               TEXT,
      folder_name             TEXT,
      folder_url              TEXT,
      connected_by            TEXT,
      connected_at            TIMESTAMPTZ,
      updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`).then(() => undefined).catch(err => { tableReady = null; throw err; });
  return tableReady;
}

async function row(): Promise<Row | null> {
  await ensureTable();
  const r = await pool.query(
    `SELECT d.*, u.full_name AS connected_by_name
       FROM ov_drive_connection d LEFT JOIN users u ON u.id = d.connected_by WHERE d.id = 1`);
  return (r.rows[0] as Row | undefined) ?? null;
}

async function upsert(fields: Record<string, unknown>): Promise<void> {
  await ensureTable();
  const keys = Object.keys(fields);
  const cols = keys.join(", ");
  const vals = keys.map((_, i) => `$${i + 1}`).join(", ");
  const sets = keys.map(k => `${k} = EXCLUDED.${k}`).join(", ");
  await pool.query(
    `INSERT INTO ov_drive_connection (id, ${cols}, updated_at) VALUES (1, ${vals}, NOW())
     ON CONFLICT (id) DO UPDATE SET ${sets}, updated_at = NOW()`,
    keys.map(k => fields[k]));
}

/* The OAuth client: environment first (the deployer's choice wins), else
   what an Admin pasted into the dialog. */
type ClientCreds = { clientId: string; clientSecret: string; source: "env" | "app" };
function clientOf(r: Row | null): ClientCreds | null {
  const d = config.drive;
  if (d.oauthClientId && d.oauthClientSecret) return { clientId: d.oauthClientId, clientSecret: d.oauthClientSecret, source: "env" };
  const secret = openSecret(r?.oauth_client_secret_enc, SEAL);
  if (r?.oauth_client_id && secret) return { clientId: r.oauth_client_id, clientSecret: secret, source: "app" };
  return null;
}

const expectedOf = (r: Row | null): string =>
  (r?.expected_email?.trim() || DEFAULT_EXPECTED_ACCOUNT).toLowerCase();

function connectionOf(r: Row | null): (OAuthCredentials & { accountEmail: string | null }) | null {
  const client = clientOf(r);
  const refreshToken = openSecret(r?.refresh_token_enc, SEAL);
  if (!client || !refreshToken) return null;
  return { clientId: client.clientId, clientSecret: client.clientSecret, refreshToken, accountEmail: r?.account_email ?? null };
}

/** What drive-client.ts needs to use this Drive, or null when not connected. */
export async function loadOutreachDriveConnection(): Promise<(OAuthCredentials & { folderId: string; accountEmail: string | null }) | null> {
  const r = await row();
  const c = connectionOf(r);
  if (!c || !r?.folder_id) return null;
  return { ...c, folderId: r.folder_id };
}

export interface OutreachDriveStatus {
  client: "env" | "app" | "none";
  client_id: string | null;
  redirect_uri: string;
  connected: boolean;
  account_email: string | null;
  expected_email: string;
  folder: { id: string; name: string | null; url: string | null } | null;
  connected_at: string | null;
  connected_by_name: string | null;
  default_folder_name: string;
}

export async function outreachDriveStatus(): Promise<OutreachDriveStatus> {
  const r = await row();
  const client = clientOf(r);
  return {
    client: client?.source ?? "none",
    client_id: client?.clientId ?? null,
    redirect_uri: outreachDriveRedirectUri(),
    connected: !!connectionOf(r) && !!r?.folder_id,
    account_email: r?.account_email ?? null,
    expected_email: expectedOf(r),
    folder: r?.folder_id ? { id: r.folder_id, name: r.folder_name, url: r.folder_url } : null,
    connected_at: r?.connected_at ?? null,
    connected_by_name: r?.connected_by_name ?? null,
    default_folder_name: DEFAULT_ROOT_FOLDER,
  };
}

export async function saveOutreachDriveClient(clientId: string, clientSecret: string): Promise<void> {
  const id = clientId.trim(), secret = clientSecret.trim();
  if (!/^[\w.-]+\.apps\.googleusercontent\.com$/.test(id)) {
    throw new OutreachDriveError("That does not look like a Google OAuth client id (it ends in .apps.googleusercontent.com).");
  }
  if (secret.length < 8) throw new OutreachDriveError("Paste the OAuth client secret as well.");
  await upsert({ oauth_client_id: id, oauth_client_secret_enc: sealSecret(secret, SEAL) });
}

/** Which Google account the workflow's Drive must belong to. */
export async function setExpectedAccount(email: string): Promise<void> {
  const clean = String(email ?? "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(clean)) throw new OutreachDriveError("Enter the Google account's email address.");
  await upsert({ expected_email: clean });
}

// ── The OAuth dance ────────────────────────────────────────────────────────

/* `state` ties the callback to the person who pressed the button: signed, so
   a crafted callback cannot connect somebody else's Drive, and short-lived, so
   a stale popup is refused. Keyed separately from casting's, so a casting
   state can never complete an outreach connection or the other way round. */
const stateKey = () => createHash("sha256").update(`${config.sessionSecret}\u0000outreach-drive-state`).digest();
const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const sign = (payload: string) => b64u(createHmac("sha256", stateKey()).update(payload).digest());

export function signOutreachDriveState(userId: string, now: number = Date.now()): string {
  const payload = b64u(JSON.stringify({ u: userId, e: now + STATE_TTL_MS, n: randomBytes(8).toString("hex") }));
  return `${payload}.${sign(payload)}`;
}

export function verifyOutreachDriveState(state: string, userId: string, now: number = Date.now()): boolean {
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

/** Where to send the browser. Needs an OAuth client. */
export async function outreachDriveAuthUrl(userId: string): Promise<string> {
  const r = await row();
  const client = clientOf(r);
  if (!client) throw new OutreachDriveError("Add the Google Cloud OAuth client (id and secret) before connecting.");
  const q = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: outreachDriveRedirectUri(),
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",      // a refresh token, not just an hour's access
    prompt: "consent",           // Google only returns a refresh token on a consent screen
    include_granted_scopes: "true",
    // Preselect the outreach account so the right one is the obvious click.
    login_hint: expectedOf(r),
    state: signOutreachDriveState(userId),
  });
  return `${AUTH_URL}?${q.toString()}`;
}

async function googleJson<T>(res: Response, what: string): Promise<T> {
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new OutreachDriveError(`Google refused the ${what} (HTTP ${res.status}): ${text.slice(0, 200)}`, 502);
  }
  return res.json() as Promise<T>;
}

const revoke = (token: string) =>
  fetch(`${REVOKE_URL}?token=${encodeURIComponent(token)}`, { method: "POST" }).catch(() => undefined);

/**
 * The callback: code → token → which account → checked → stored → a folder.
 * Returns what the popup should say.
 */
export async function completeOutreachDriveConnect(
  code: string, userId: string,
): Promise<{ email: string; folder: { id: string; name: string; url: string } }> {
  const current = await row();
  const client = clientOf(current);
  if (!client) throw new OutreachDriveError("The OAuth client is no longer configured.");

  const tok = await googleJson<{ access_token?: string; refresh_token?: string }>(await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code, client_id: client.clientId, client_secret: client.clientSecret,
      redirect_uri: outreachDriveRedirectUri(), grant_type: "authorization_code",
    }).toString(),
  }), "sign-in");
  if (!tok.refresh_token || !tok.access_token) {
    throw new OutreachDriveError("Google did not return a long-lived token. Remove NERVE under myaccount.google.com → Security → Third-party access, then connect again.", 502);
  }

  const who = await googleJson<{ email?: string }>(await fetch(USERINFO_URL, {
    headers: { Authorization: `Bearer ${tok.access_token}` },
  }), "account lookup");
  const email = String(who.email ?? "").toLowerCase();

  /* The wrong account is refused BEFORE anything is stored, and its token is
     revoked so the grant does not linger on an account that was never meant
     to hold the workflow. */
  const expected = expectedOf(current);
  if (email !== expected) {
    await revoke(tok.refresh_token);
    throw new OutreachDriveError(
      `You signed in as ${email || "an unknown account"}, but the outreach Drive is ${expected}. ` +
      `Press Connect again and choose ${expected} on Google's account screen.`, 403);
  }

  const drive = new GoogleDriveClient({ clientId: client.clientId, clientSecret: client.clientSecret, refreshToken: tok.refresh_token });

  /* A folder to keep everything in. The one already configured is kept if
     this account can still see it (a reconnect); otherwise one is created in
     the account's My Drive, so connecting is never "connected, but nowhere to
     put anything". */
  let folder: { id: string; name: string } | null = null;
  if (current?.folder_id) {
    try {
      const meta = await drive.getMeta(current.folder_id);
      if (meta.mimeType === DRIVE_FOLDER_MIME) folder = { id: meta.id, name: meta.name || current.folder_name || DEFAULT_ROOT_FOLDER };
    } catch { folder = null; }
  }
  if (!folder) folder = { id: await drive.ensureFolder(DEFAULT_ROOT_FOLDER, "root"), name: DEFAULT_ROOT_FOLDER };
  const url = driveFolderLink(folder.id);

  // An old token for a previous connection is no longer wanted.
  const previous = openSecret(current?.refresh_token_enc, SEAL);
  if (previous && previous !== tok.refresh_token) await revoke(previous);

  await upsert({
    refresh_token_enc: sealSecret(tok.refresh_token, SEAL),
    account_email: email,
    connected_by: userId,
    connected_at: new Date().toISOString(),
    folder_id: folder.id,
    folder_name: folder.name,
    folder_url: url,
  });
  return { email, folder: { ...folder, url } };
}

async function connectedDrive(): Promise<{ drive: GoogleDriveClient; email: string | null }> {
  const c = connectionOf(await row());
  if (!c) throw new OutreachDriveError("Google Drive is not connected. Sign in with Google first.", 409);
  return { drive: new GoogleDriveClient(c), email: c.accountEmail };
}

/** Point the workflow at a folder the account already has, by link or id. */
export async function useOutreachDriveFolder(input: string): Promise<{ id: string; name: string; url: string }> {
  const id = parseDriveFolderId(input);
  if (!id) throw new OutreachDriveError("Paste a Google Drive folder link, or the folder's id.");
  const { drive, email } = await connectedDrive();
  let meta;
  try { meta = await drive.getMeta(id); }
  catch { throw new OutreachDriveError(`Google Drive could not open that folder. Check the link, and that ${email ?? "the connected account"} can access it.`); }
  if (meta.mimeType !== DRIVE_FOLDER_MIME) throw new OutreachDriveError("That link is a file, not a folder.");
  const url = driveFolderLink(meta.id);
  await upsert({ folder_id: meta.id, folder_name: meta.name || null, folder_url: url });
  return { id: meta.id, name: meta.name, url };
}

/**
 * Forget the connection. The folder and everything in it stay in Drive; the
 * OAuth client and the expected account are kept so reconnecting is one
 * click. Revocation is best effort.
 */
export async function disconnectOutreachDrive(): Promise<void> {
  const c = connectionOf(await row());
  if (c) await revoke(c.refreshToken);
  await ensureTable();
  await pool.query(
    `UPDATE ov_drive_connection SET refresh_token_enc = NULL, account_email = NULL, connected_by = NULL,
       connected_at = NULL, updated_at = NOW() WHERE id = 1`);
}
