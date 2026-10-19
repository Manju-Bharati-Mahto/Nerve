/**
 * Google Drive REST client, shared by every Nerve workflow that keeps media in
 * Drive — the Outreach video workflow (PRD §23) and casting registration photos.
 *
 * Deliberately written against the raw Drive v3 REST API with `fetch` and Node's
 * built-in crypto rather than pulling in `googleapis` — the same choice already
 * made for the Apify integration, and it keeps a heavyweight dependency (and its
 * transitive surface) out of the server for the handful of calls we make.
 *
 * Two implementations satisfy one interface:
 *   - GoogleDriveClient — the real thing, for production.
 *   - LocalDriveClient  — a filesystem adapter with the same semantics
 *     (including revision ids), so every workflow built on it is fully runnable
 *     and testable in dev and CI without Google credentials. A caller only ever
 *     selects it when no real credentials are present, so it cannot silently
 *     shadow production.
 *
 * Credentials are read from config.drive and are the same for every workflow;
 * what differs per workflow is the ROOT FOLDER it works beneath, which is why
 * folder selection lives with each caller (outreach-video/drive-client.ts,
 * casting-photos.ts) and not here.
 *
 * Concurrency: every content write takes an expected revision id and fails with
 * RevisionMismatchError if the stored file moved on. That is what makes PRD §24
 * ("never blindly overwrite stale data") enforceable — see
 * outreach-video/drive-store.ts for the read-modify-write loop built on top.
 */
import { createSign } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { config } from "../config.js";

/** True when either supported credential shape is fully present. */
export function googleDriveCredentialsConfigured(): boolean {
  const d = config.drive;
  return (!!d.serviceAccountEmail && !!d.serviceAccountKey)
    || (!!d.oauthClientId && !!d.oauthClientSecret && !!d.oauthRefreshToken);
}

export const DRIVE_FOLDER_MIME = "application/vnd.google-apps.folder";

export class DriveNotConfiguredError extends Error {
  constructor() {
    super("Google Drive is not configured. Set GOOGLE_DRIVE_ROOT_FOLDER_ID plus either service-account or OAuth credentials (or DRIVE_LOCAL_ROOT for local development).");
    this.name = "DriveNotConfiguredError";
  }
}

/**
 * Google no longer accepts the credentials: the refresh token was revoked or
 * expired (`invalid_grant`), the OAuth client was deleted or its secret
 * rotated (`invalid_client`), or Drive itself answered 401.
 *
 * A separate class because it is the one Drive failure that waiting does not
 * fix — somebody has to sign in again — so the workflow tells people exactly
 * that instead of "try again".
 */
export class DriveAuthError extends Error {
  constructor(message: string, readonly status: number | null = null) {
    super(message);
    this.name = "DriveAuthError";
  }
}

/**
 * Drive is there in principle but did not do what was asked: a 403 (quota,
 * permission), a 404 (the folder or file is gone), a 429 or 5xx, or no answer
 * at all. Usually temporary; `status` is null when the request never got a
 * response.
 */
export class DriveUnavailableError extends Error {
  constructor(message: string, readonly status: number | null = null) {
    super(message);
    this.name = "DriveUnavailableError";
  }
}

/** The OAuth error codes that mean "these credentials are dead", not "try later". */
const DEAD_GRANT = /invalid_grant|invalid_client|unauthorized_client|admin_policy_enforced/;

/**
 * Turns a refused token request into the right error. Exported for the tests;
 * nothing else should need it.
 */
export function tokenFailure(status: number, text: string): Error {
  const detail = text.replace(/\s+/g, " ").slice(0, 200);
  if (((status === 400 || status === 401) && DEAD_GRANT.test(text)) || status === 401) {
    return new DriveAuthError(`Google refused the Drive sign-in (HTTP ${status}): ${detail}`, status);
  }
  return new DriveUnavailableError(`Google's sign-in service failed (HTTP ${status}): ${detail}`, status);
}

/** Turns a refused Drive API call into the right error. */
export function driveFailure(status: number, what: string, text: string): Error {
  const detail = text.replace(/\s+/g, " ").slice(0, 300);
  const message = `Drive ${what} failed (HTTP ${status}): ${detail}`;
  if (status === 401) return new DriveAuthError(message, status);
  if (status === 403 || status === 404 || status === 408 || status === 429 || status >= 500) {
    return new DriveUnavailableError(message, status);
  }
  return new Error(message);
}

/** A request that never got an answer — DNS, reset, timeout. */
function unreachable(what: string, err: unknown): DriveUnavailableError {
  const reason = err instanceof Error
    ? (err.name === "TimeoutError" || err.name === "AbortError" ? "timed out" : (err.cause instanceof Error ? err.cause.message : err.message))
    : String(err);
  return new DriveUnavailableError(`${what} could not be reached (${reason}).`, null);
}

/** Thrown when a write's expected revision no longer matches what Drive holds. */
export class RevisionMismatchError extends Error {
  constructor(readonly fileId: string) {
    super(`Drive file ${fileId} changed since it was read.`);
    this.name = "RevisionMismatchError";
  }
}

export interface DriveFileMeta {
  id: string;
  name: string;
  /** Changes on every content write — the concurrency token for §24. */
  revisionId: string;
  mimeType: string;
  modifiedTime: string;
  /** The folders holding it. Only filled where the call asked for it (getMeta does). */
  parents?: string[];
  /** Bytes, for a binary file; absent for folders and Google Docs. */
  size?: number;
}

export interface DriveClient {
  /** Returns the id of the named child folder, creating it if absent. */
  ensureFolder(name: string, parentId: string): Promise<string>;
  /** Finds a direct child by exact name, or null. */
  findChild(name: string, parentId: string): Promise<DriveFileMeta | null>;
  /**
   * Creates a text file with content, returning its metadata. `mimeType`
   * defaults to JSON, which is what the data stores are; a file meant for a
   * person to open in Drive (a caption, say) passes "text/plain" so Drive
   * shows it as text rather than as a JSON document.
   */
  createTextFile(name: string, parentId: string, content: string, mimeType?: string): Promise<DriveFileMeta>;
  /** Reads a file's text content together with the revision it was read at. */
  readTextFile(fileId: string): Promise<{ content: string; revisionId: string }>;
  /** Overwrites content, but only if the file is still at `expectedRevisionId`. */
  updateTextFile(fileId: string, content: string, expectedRevisionId: string, mimeType?: string): Promise<DriveFileMeta>;
  /**
   * Moves a file into another folder and returns its metadata afterwards.
   * Callers must use the RETURNED id: on Google Drive a move keeps the id,
   * but the local adapter's ids are paths, so moving one changes it.
   */
  moveFile(fileId: string, newParentId: string): Promise<DriveFileMeta>;
  /** Current metadata without transferring content — used to cheaply poll revisions. */
  getMeta(fileId: string): Promise<DriveFileMeta>;
  /**
   * Whether `id` is shaped like one of this Drive's file ids. For an id that
   * came from outside (a browser reporting what it uploaded), checked before
   * it goes anywhere near a request URL.
   */
  isFileId(id: string): boolean;
  /** Uploads a local file (the editor's video) and returns its Drive metadata. */
  uploadBinaryFile(name: string, parentId: string, localPath: string, mimeType: string): Promise<DriveFileMeta>;
  /**
   * Opens a resumable upload session that a BROWSER will send the bytes to,
   * and returns the session URL. `origin` is the page's origin: Google only
   * answers the browser's cross-origin PUTs when the session was opened with
   * it. Absent on the local adapter, which has no URL a browser could reach —
   * callers fall back to sending the file through the server.
   */
  createUploadSession?(name: string, parentId: string, mimeType: string, sizeBytes: number, origin: string): Promise<string>;
  /**
   * Sets the file's own Drive description — the text Drive shows in a file's
   * details panel, so the remarks are visible on the video itself.
   */
  setDescription(fileId: string, description: string): Promise<void>;
  /**
   * Opens a file's bytes for streaming to the browser. `range` is passed
   * straight through so the video player can seek without pulling the whole
   * file. Returns the upstream status so a 206 stays a 206.
   */
  openStream(fileId: string, range?: string): Promise<{
    body: ReadableStream<Uint8Array> | null;
    status: number;
    headers: Headers;
  }>;
}

// ── Google implementation ──────────────────────────────────────────────────

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";
/** Requested on every call so Shared Drives behave like My Drive folders. */
const SHARED_DRIVE_PARAMS = "supportsAllDrives=true&includeItemsFromAllDrives=true";

/** Google requires every chunk but the last to be a multiple of 256 KiB. */
export const UPLOAD_GRANULARITY = 256 * 1024;
/** Server-side upload chunks: big enough to keep request overhead low, small
    enough that a retry resends seconds of work, not minutes. */
const UPLOAD_CHUNK_BYTES = 32 * 1024 * 1024;
const UPLOAD_CHUNK_TIMEOUT_MS = 5 * 60 * 1000;
const UPLOAD_CHUNK_RETRIES = 3;
/** Ordinary metadata calls: Google answers these in well under a second. */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * How many bytes a resumable session holds, from a 308's `Range: bytes=0-N`.
 * No Range header means nothing has been stored yet.
 */
export function storedBytes(res: Pick<Response, "headers">): number {
  const m = /bytes=0-(\d+)/.exec(res.headers.get("range") ?? "");
  return m ? Number(m[1]) + 1 : 0;
}

/** Google Drive file ids: URL-safe base64-ish, never a slash, dot or query. */
const DRIVE_FILE_ID = /^[A-Za-z0-9_-]{10,200}$/;

/** True when `id` could be a Google Drive file id. */
export function isDriveFileId(id: string): boolean {
  return DRIVE_FILE_ID.test(id);
}

/** A file id as a URL path segment. Ids are URL-safe already; this keeps it so. */
const seg = (fileId: string) => encodeURIComponent(fileId);

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** An OAuth refresh-token grant for one Google account, when it is not the
    one in the environment — e.g. the account an Admin connected in the app. */
export interface OAuthCredentials { clientId: string; clientSecret: string; refreshToken: string }

export class GoogleDriveClient implements DriveClient {
  private token: { value: string; expiresAt: number } | null = null;

  /**
   * With no `oauth`, credentials come from config.drive (the environment).
   * `tuning` exists for the tests, which cannot wait out real chunk sizes and
   * back-off delays.
   */
  constructor(
    private readonly oauth?: OAuthCredentials,
    tuning: { chunkBytes?: number; retryDelayMs?: number } = {},
  ) {
    this.chunkBytes = tuning.chunkBytes ?? UPLOAD_CHUNK_BYTES;
    this.retryDelayMs = tuning.retryDelayMs ?? 1000;
  }

  private readonly chunkBytes: number;
  private readonly retryDelayMs: number;

  /**
   * Returns a bearer token, refreshing shortly before expiry. Every supported
   * auth shape converges here, so every caller below is auth-agnostic.
   */
  private async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt) return this.token.value;

    const d = config.drive;
    let body: string;
    if (this.oauth) {
      body = new URLSearchParams({
        client_id: this.oauth.clientId,
        client_secret: this.oauth.clientSecret,
        refresh_token: this.oauth.refreshToken,
        grant_type: "refresh_token",
      }).toString();
    } else if (d.serviceAccountEmail && d.serviceAccountKey) {
      const now = Math.floor(Date.now() / 1000);
      const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
      const claims = base64url(JSON.stringify({
        iss: d.serviceAccountEmail,
        scope: DRIVE_SCOPE,
        aud: TOKEN_URL,
        iat: now,
        exp: now + 3600,
      }));
      const signer = createSign("RSA-SHA256");
      signer.update(`${header}.${claims}`);
      const signature = base64url(signer.sign(d.serviceAccountKey));
      body = new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: `${header}.${claims}.${signature}`,
      }).toString();
    } else if (d.oauthClientId && d.oauthClientSecret && d.oauthRefreshToken) {
      body = new URLSearchParams({
        client_id: d.oauthClientId,
        client_secret: d.oauthClientSecret,
        refresh_token: d.oauthRefreshToken,
        grant_type: "refresh_token",
      }).toString();
    } else {
      throw new DriveNotConfiguredError();
    }

    let res: Response;
    try {
      res = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw unreachable("Google's sign-in service", err);
    }
    if (!res.ok) throw tokenFailure(res.status, await res.text().catch(() => ""));
    const json = await res.json() as { access_token?: string; expires_in?: number };
    if (!json.access_token) throw new DriveUnavailableError("Google's token response contained no access token.");
    // Refresh a minute early so an in-flight request can't expire mid-call (§29).
    this.token = { value: json.access_token, expiresAt: Date.now() + ((json.expires_in ?? 3600) - 60) * 1000 };
    return this.token.value;
  }

  /**
   * One authorised Drive call. A request that never gets an answer becomes a
   * DriveUnavailableError, and a 401 a DriveAuthError — after one retry with a
   * fresh token, because a cached token can be revoked or expire between our
   * clock check and Google's. Bodies passed here are strings or byte arrays,
   * so sending one twice is safe.
   */
  private async api(url: string, init: RequestInit = {}, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const hadToken = !!this.token;
      const token = await this.accessToken();
      const headers = new Headers(init.headers);
      headers.set("Authorization", `Bearer ${token}`);
      let res: Response;
      try {
        res = await fetch(url, { ...init, headers, signal: init.signal ?? AbortSignal.timeout(timeoutMs) });
      } catch (err) {
        throw unreachable("Google Drive", err);
      }
      if (res.status !== 401) return res;
      this.token = null;
      if (attempt === 0 && hadToken) continue;
      const text = await res.text().catch(() => "");
      throw driveFailure(401, "request", text);
    }
  }

  private async expectOk(res: Response, what: string): Promise<void> {
    if (res.ok) return;
    throw driveFailure(res.status, what, await res.text().catch(() => ""));
  }

  private toMeta(raw: Record<string, unknown>): DriveFileMeta {
    return {
      id: String(raw.id),
      name: String(raw.name ?? ""),
      // A folder has no headRevisionId; version increments on any change and is
      // an equally valid concurrency token.
      revisionId: String(raw.headRevisionId ?? raw.version ?? ""),
      mimeType: String(raw.mimeType ?? ""),
      modifiedTime: String(raw.modifiedTime ?? ""),
      ...(Array.isArray(raw.parents) ? { parents: raw.parents.map(String) } : {}),
      ...(raw.size !== undefined && raw.size !== null ? { size: Number(raw.size) } : {}),
    };
  }

  async findChild(name: string, parentId: string): Promise<DriveFileMeta | null> {
    // Escape per Drive query-string rules so a name with a quote can't break out.
    const safe = name.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    const parent = parentId.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    const q = encodeURIComponent(`name = '${safe}' and '${parent}' in parents and trashed = false`);
    const fields = encodeURIComponent("files(id,name,mimeType,headRevisionId,version,modifiedTime)");
    const res = await this.api(`${DRIVE_API}/files?q=${q}&fields=${fields}&${SHARED_DRIVE_PARAMS}`);
    await this.expectOk(res, "file lookup");
    const json = await res.json() as { files?: Record<string, unknown>[] };
    const first = json.files?.[0];
    return first ? this.toMeta(first) : null;
  }

  async ensureFolder(name: string, parentId: string): Promise<string> {
    const existing = await this.findChild(name, parentId);
    if (existing) return existing.id;
    const res = await this.api(`${DRIVE_API}/files?fields=id&${SHARED_DRIVE_PARAMS}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, mimeType: DRIVE_FOLDER_MIME, parents: [parentId] }),
    });
    await this.expectOk(res, `folder create (${name})`);
    const json = await res.json() as { id: string };
    return json.id;
  }

  async createTextFile(name: string, parentId: string, content: string, mimeType = "application/json"): Promise<DriveFileMeta> {
    // Multipart upload: metadata part, then the body, in one request.
    const boundary = `nerve-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const metadata = JSON.stringify({ name, parents: [parentId], mimeType });
    const body =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
      `--${boundary}\r\nContent-Type: ${mimeType}; charset=UTF-8\r\n\r\n${content}\r\n` +
      `--${boundary}--`;
    const fields = encodeURIComponent("id,name,mimeType,headRevisionId,version,modifiedTime");
    const res = await this.api(`${DRIVE_UPLOAD_API}/files?uploadType=multipart&fields=${fields}&${SHARED_DRIVE_PARAMS}`, {
      method: "POST",
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body,
    });
    await this.expectOk(res, `file create (${name})`);
    return this.toMeta(await res.json() as Record<string, unknown>);
  }

  async readTextFile(fileId: string): Promise<{ content: string; revisionId: string }> {
    // Content and metadata are two calls; read metadata SECOND so a write that
    // lands between them yields a stale-looking revision and is caught by the
    // guard on write, rather than a newer revision paired with older content.
    const contentRes = await this.api(`${DRIVE_API}/files/${seg(fileId)}?alt=media&${SHARED_DRIVE_PARAMS}`);
    await this.expectOk(contentRes, "file read");
    const content = await contentRes.text();
    const meta = await this.getMeta(fileId);
    return { content, revisionId: meta.revisionId };
  }

  isFileId(id: string): boolean {
    return isDriveFileId(id);
  }

  async getMeta(fileId: string): Promise<DriveFileMeta> {
    const fields = encodeURIComponent("id,name,mimeType,headRevisionId,version,modifiedTime,parents,size");
    const res = await this.api(`${DRIVE_API}/files/${seg(fileId)}?fields=${fields}&${SHARED_DRIVE_PARAMS}`);
    await this.expectOk(res, "metadata read");
    return this.toMeta(await res.json() as Record<string, unknown>);
  }

  async updateTextFile(fileId: string, content: string, expectedRevisionId: string, mimeType = "application/json"): Promise<DriveFileMeta> {
    // Drive has no reliable conditional-write header across file types, so the
    // guard is an explicit re-check immediately before the write. Combined with
    // the per-file serialisation in drive-store.ts (single API instance), this
    // closes the window in practice; the store re-reads and retries on mismatch.
    const current = await this.getMeta(fileId);
    if (current.revisionId !== expectedRevisionId) throw new RevisionMismatchError(fileId);

    const fields = encodeURIComponent("id,name,mimeType,headRevisionId,version,modifiedTime");
    const res = await this.api(`${DRIVE_UPLOAD_API}/files/${seg(fileId)}?uploadType=media&fields=${fields}&${SHARED_DRIVE_PARAMS}`, {
      method: "PATCH",
      // The body's type must match the file's, or Drive re-types the file.
      headers: { "Content-Type": mimeType === "application/json" ? mimeType : `${mimeType}; charset=UTF-8` },
      body: content,
    });
    await this.expectOk(res, "file update");
    return this.toMeta(await res.json() as Record<string, unknown>);
  }

  async moveFile(fileId: string, newParentId: string): Promise<DriveFileMeta> {
    // Drive models a folder as a parent, so a move is "add this parent,
    // remove the others" — which needs the current parents first.
    const parentsRes = await this.api(`${DRIVE_API}/files/${seg(fileId)}?fields=parents&${SHARED_DRIVE_PARAMS}`);
    await this.expectOk(parentsRes, "parent lookup");
    const { parents = [] } = await parentsRes.json() as { parents?: string[] };
    if (parents.length === 1 && parents[0] === newParentId) return this.getMeta(fileId);

    const fields = encodeURIComponent("id,name,mimeType,headRevisionId,version,modifiedTime");
    const remove = parents.filter(p => p !== newParentId).join(",");
    const res = await this.api(
      `${DRIVE_API}/files/${seg(fileId)}?addParents=${encodeURIComponent(newParentId)}` +
      `${remove ? `&removeParents=${encodeURIComponent(remove)}` : ""}&fields=${fields}&${SHARED_DRIVE_PARAMS}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
    await this.expectOk(res, "file move");
    return this.toMeta(await res.json() as Record<string, unknown>);
  }

  /**
   * Opens a resumable upload session and returns its URL. With `origin`, the
   * session is opened on behalf of a browser on that origin: Google then
   * answers that page's cross-origin PUTs (with CORS headers), which is what
   * lets a video go from the editor's browser straight into Drive without
   * passing through Nerve. The session URL itself is the credential for the
   * upload, so the browser never sees a token.
   */
  async createUploadSession(name: string, parentId: string, mimeType: string, sizeBytes: number, origin?: string): Promise<string> {
    const fields = encodeURIComponent("id,name,mimeType,headRevisionId,version,modifiedTime,parents,size");
    const headers: Record<string, string> = {
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Type": mimeType,
      "X-Upload-Content-Length": String(sizeBytes),
    };
    if (origin) headers.Origin = origin;
    const start = await this.api(`${DRIVE_UPLOAD_API}/files?uploadType=resumable&fields=${fields}&${SHARED_DRIVE_PARAMS}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name, parents: [parentId], mimeType }),
    });
    await this.expectOk(start, `upload session (${name})`);
    const sessionUrl = start.headers.get("location");
    if (!sessionUrl) throw new DriveUnavailableError("Drive did not return a resumable upload session URL.");
    return sessionUrl;
  }

  /**
   * Uploads a file from disk in chunks over a resumable session.
   *
   * Never holds more than one chunk in memory: a 2 GB video read whole into
   * a Buffer is 2 GB of heap in a container that has far less, which is how a
   * large upload used to take the API down. Each chunk is read from the file
   * handle, sent with its Content-Range, and Google's 308 says how much it now
   * holds. A chunk that fails (no answer, a 5xx, a timeout) is retried from
   * whatever Google says it actually stored, up to UPLOAD_CHUNK_RETRIES times.
   */
  async uploadBinaryFile(name: string, parentId: string, localPath: string, mimeType: string): Promise<DriveFileMeta> {
    const { size } = await fs.stat(localPath);
    const sessionUrl = await this.createUploadSession(name, parentId, mimeType, size);
    const handle = await fs.open(localPath, "r");
    try {
      return await this.sendChunks(sessionUrl, handle, size, mimeType, name);
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  private async sendChunks(sessionUrl: string, handle: fs.FileHandle, size: number, mimeType: string, name: string): Promise<DriveFileMeta> {
    const chunkSize = Math.max(UPLOAD_GRANULARITY, Math.floor(this.chunkBytes / UPLOAD_GRANULARITY) * UPLOAD_GRANULARITY);
    const buffer = Buffer.allocUnsafe(Math.max(1, Math.min(chunkSize, size)));
    let offset = 0;
    /* Attempts in a row that moved nothing forward. Only real progress — a
       308 holding more bytes than before — resets it, so a session that keeps
       answering 308 without storing anything still runs out of retries. */
    let failures = 0;

    for (;;) {
      let problem: unknown = null;

      if (size > 0 && offset >= size) {
        /* Google says it holds every byte but has not handed back the file.
           Sending again would mean an empty Content-Range, which Google
           rejects; ask the session for its answer instead. */
        const status = await this.uploadStatus(sessionUrl, size);
        if (status.done) return status.done;
        if (status.offset >= 0 && status.offset < size) offset = status.offset;
        problem = new DriveUnavailableError(`Drive holds all of ${name} but did not confirm the file.`, null);
      } else {
        const end = Math.min(offset + chunkSize, size);
        const length = end - offset;
        if (length > 0) await handle.read(buffer, 0, length, offset);

        let res: Response | null = null;
        try {
          res = await fetch(sessionUrl, {
            method: "PUT",
            headers: {
              "Content-Type": mimeType,
              "Content-Range": size === 0 ? "bytes */0" : `bytes ${offset}-${end - 1}/${size}`,
            },
            body: new Uint8Array(buffer.buffer, buffer.byteOffset, length),
            signal: AbortSignal.timeout(UPLOAD_CHUNK_TIMEOUT_MS),
          });
        } catch (err) {
          problem = unreachable("Google Drive", err);
        }

        if (res && (res.status === 200 || res.status === 201)) {
          return this.toMeta(await res.json() as Record<string, unknown>);
        }
        if (res?.status === 308) {
          const stored = storedBytes(res);
          if (stored > offset) {
            offset = stored;
            // Progress. A 308 claiming the whole file is not yet success:
            // the top of the loop asks for the file, and that is bounded by
            // the retries still owed.
            if (stored < size) failures = 0;
            continue;
          }
          // Google kept none of the chunk (or forgot some it had): resend
          // from where it says it is, as a failed attempt.
          offset = stored;
          problem = new DriveUnavailableError(`Drive accepted none of the last chunk of ${name}.`, 308);
        } else if (res) {
          const text = await res.text().catch(() => "");
          // A 4xx other than a timeout or rate limit will not change on retry.
          if (res.status < 500 && res.status !== 408 && res.status !== 429) throw driveFailure(res.status, `upload (${name})`, text);
          problem = driveFailure(res.status, `upload (${name})`, text);
        }
      }

      if (++failures > UPLOAD_CHUNK_RETRIES) throw problem;
      await new Promise(r => setTimeout(r, this.retryDelayMs * failures));
      // Ask Google how much of the file it really has before sending more.
      const status = await this.uploadStatus(sessionUrl, size);
      if (status.done) return status.done;
      if (status.offset >= 0) offset = status.offset;
    }
  }

  /**
   * Asks a resumable session how much it holds: `Content-Range: bytes STAR/total`.
   * `offset: -1` means "no answer worth acting on" — the request failed, timed
   * out, or Google was busy (5xx, 408, 429) — so the caller resends from where
   * it was and lets its retry count decide when to stop. Only an answer that
   * waiting cannot change throws: 404/410 (the session is gone) or another 4xx.
   */
  private async uploadStatus(sessionUrl: string, size: number): Promise<{ offset: number; done?: DriveFileMeta }> {
    let res: Response;
    try {
      res = await fetch(sessionUrl, {
        method: "PUT",
        headers: { "Content-Range": `bytes */${size}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      return { offset: -1 };
    }
    if (res.status === 200 || res.status === 201) return { offset: size, done: this.toMeta(await res.json() as Record<string, unknown>) };
    if (res.status === 308) return { offset: storedBytes(res) };
    const text = await res.text().catch(() => "");
    if (res.status >= 500 || res.status === 408 || res.status === 429) return { offset: -1 };
    throw driveFailure(res.status, "upload status", text);
  }

  async setDescription(fileId: string, description: string): Promise<void> {
    const res = await this.api(`${DRIVE_API}/files/${seg(fileId)}?fields=id&${SHARED_DRIVE_PARAMS}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify({ description }),
    });
    await this.expectOk(res, "description update");
  }

  async openStream(fileId: string, range?: string) {
    // No overall timeout: a long video legitimately streams for minutes. The
    // headers arrive quickly or not at all, which the API call still bounds.
    const controller = new AbortController();
    const headersDeadline = setTimeout(() => controller.abort(new DOMException("timed out", "TimeoutError")), REQUEST_TIMEOUT_MS);
    try {
      const res = await this.api(`${DRIVE_API}/files/${seg(fileId)}?alt=media&${SHARED_DRIVE_PARAMS}`, {
        headers: range ? { Range: range } : {},
        signal: controller.signal,
      });
      if (!res.ok && res.status !== 206) throw driveFailure(res.status, "stream", await res.text().catch(() => ""));
      return { body: res.body, status: res.status, headers: res.headers };
    } finally {
      clearTimeout(headersDeadline);
    }
  }
}

// ── Local filesystem implementation ────────────────────────────────────────

/**
 * Mirrors GoogleDriveClient's semantics onto a directory tree, so every layer
 * above can be exercised without Google credentials. Folder ids are relative
 * paths; revision ids are a monotonic counter kept in a sidecar file, which
 * reproduces Drive's "revision changes on write" behaviour that §24 depends on.
 */
export class LocalDriveClient implements DriveClient {
  constructor(private readonly root: string) {}

  private resolve(id: string): string {
    // Ids are relative paths; refuse anything that climbs out of the root.
    const full = path.resolve(this.root, id === "root" ? "." : id);
    const rootFull = path.resolve(this.root);
    if (full !== rootFull && !full.startsWith(rootFull + path.sep)) {
      throw new Error(`Refusing to access a path outside the local Drive root: ${id}`);
    }
    return full;
  }

  private revPath(id: string): string {
    const full = this.resolve(id);
    return path.join(path.dirname(full), `.${path.basename(full)}.rev`);
  }

  private async bumpRevision(id: string): Promise<string> {
    const revFile = this.revPath(id);
    const current = Number(await fs.readFile(revFile, "utf8").catch(() => "0")) || 0;
    const next = String(current + 1);
    await fs.writeFile(revFile, next, "utf8");
    return next;
  }

  private async revisionOf(id: string): Promise<string> {
    return (await fs.readFile(this.revPath(id), "utf8").catch(() => "1")) || "1";
  }

  private descPath(id: string): string {
    const full = this.resolve(id);
    return path.join(path.dirname(full), `.${path.basename(full)}.description`);
  }

  private async metaOf(id: string): Promise<DriveFileMeta> {
    const full = this.resolve(id);
    const stat = await fs.stat(full);
    const parent = path.dirname(id);
    return {
      id,
      name: path.basename(full),
      revisionId: stat.isDirectory() ? "0" : await this.revisionOf(id),
      mimeType: stat.isDirectory() ? DRIVE_FOLDER_MIME : "application/json",
      modifiedTime: stat.mtime.toISOString(),
      parents: [parent === "." ? "root" : parent],
      ...(stat.isDirectory() ? {} : { size: stat.size }),
    };
  }

  /** Kept beside the file, the way the revision marker is. */
  async setDescription(fileId: string, description: string): Promise<void> {
    await fs.stat(this.resolve(fileId));
    await fs.writeFile(this.descPath(fileId), description, "utf8");
  }

  /** Test and dev helper: what setDescription stored, or null. */
  async readDescription(fileId: string): Promise<string | null> {
    return fs.readFile(this.descPath(fileId), "utf8").catch(() => null);
  }

  async ensureFolder(name: string, parentId: string): Promise<string> {
    const id = parentId === "root" ? name : path.join(parentId, name);
    await fs.mkdir(this.resolve(id), { recursive: true });
    return id;
  }

  async findChild(name: string, parentId: string): Promise<DriveFileMeta | null> {
    const id = parentId === "root" ? name : path.join(parentId, name);
    try {
      return await this.metaOf(id);
    } catch {
      return null;
    }
  }

  async createTextFile(name: string, parentId: string, content: string, _mimeType?: string): Promise<DriveFileMeta> {
    const id = parentId === "root" ? name : path.join(parentId, name);
    await fs.mkdir(path.dirname(this.resolve(id)), { recursive: true });
    await fs.writeFile(this.resolve(id), content, "utf8");
    await this.bumpRevision(id);
    return this.metaOf(id);
  }

  async readTextFile(fileId: string): Promise<{ content: string; revisionId: string }> {
    const content = await fs.readFile(this.resolve(fileId), "utf8");
    return { content, revisionId: await this.revisionOf(fileId) };
  }

  async getMeta(fileId: string): Promise<DriveFileMeta> {
    return this.metaOf(fileId);
  }

  /** Ids here are relative paths, valid when they stay inside the root. */
  isFileId(id: string): boolean {
    if (!id || id.length > 1024) return false;
    try {
      this.resolve(id);
      return true;
    } catch {
      return false;
    }
  }

  async updateTextFile(fileId: string, content: string, expectedRevisionId: string, _mimeType?: string): Promise<DriveFileMeta> {
    if (await this.revisionOf(fileId) !== expectedRevisionId) throw new RevisionMismatchError(fileId);
    await fs.writeFile(this.resolve(fileId), content, "utf8");
    await this.bumpRevision(fileId);
    return this.metaOf(fileId);
  }

  async moveFile(fileId: string, newParentId: string): Promise<DriveFileMeta> {
    const newId = newParentId === "root" ? path.basename(fileId) : path.join(newParentId, path.basename(fileId));
    if (newId === fileId) return this.metaOf(fileId);
    await fs.mkdir(path.dirname(this.resolve(newId)), { recursive: true });
    await fs.rename(this.resolve(fileId), this.resolve(newId));
    // The revision marker travels with the file, so a later conditional write
    // against the moved file still has a revision to compare.
    await fs.rename(this.revPath(fileId), this.revPath(newId)).catch(() => undefined);
    await fs.rename(this.descPath(fileId), this.descPath(newId)).catch(() => undefined);
    return this.metaOf(newId);
  }

  async uploadBinaryFile(name: string, parentId: string, localPath: string, _mimeType: string): Promise<DriveFileMeta> {
    const id = parentId === "root" ? name : path.join(parentId, name);
    await fs.mkdir(path.dirname(this.resolve(id)), { recursive: true });
    await fs.copyFile(localPath, this.resolve(id));
    await this.bumpRevision(id);
    return this.metaOf(id);
  }

  async openStream(fileId: string, range?: string) {
    const full = this.resolve(fileId);
    const stat = await fs.stat(full);
    const buf = await fs.readFile(full);

    // Honour Range the same way Drive does, so the player's seeking behaviour
    // is identical in dev and production.
    const match = range?.match(/bytes=(\d*)-(\d*)/);
    if (match) {
      const start = match[1] ? Number(match[1]) : 0;
      const end = match[2] ? Number(match[2]) : stat.size - 1;
      const slice = buf.subarray(start, end + 1);
      return {
        body: new Blob([new Uint8Array(slice)]).stream() as ReadableStream<Uint8Array>,
        status: 206,
        headers: new Headers({
          "Content-Range": `bytes ${start}-${end}/${stat.size}`,
          "Content-Length": String(slice.length),
          "Accept-Ranges": "bytes",
        }),
      };
    }
    return {
      body: new Blob([new Uint8Array(buf)]).stream() as ReadableStream<Uint8Array>,
      status: 200,
      headers: new Headers({ "Content-Length": String(stat.size), "Accept-Ranges": "bytes" }),
    };
  }
}
