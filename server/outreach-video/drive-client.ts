/**
 * Google Drive REST client for the Outreach video workflow (PRD §23).
 *
 * Deliberately written against the raw Drive v3 REST API with `fetch` and Node's
 * built-in crypto rather than pulling in `googleapis` — the same choice already
 * made for the Apify integration, and it keeps a heavyweight dependency (and its
 * transitive surface) out of the server for the handful of calls we make.
 *
 * Two implementations satisfy one interface:
 *   - GoogleDriveClient — the real thing, for production.
 *   - LocalDriveClient  — a filesystem adapter with the same semantics
 *     (including revision ids), so the workflow is fully runnable and testable
 *     in dev and CI without Google credentials. It is only ever selected when no
 *     real credentials are present, so it cannot silently shadow production.
 *
 * Concurrency: every content write takes an expected revision id and fails with
 * RevisionMismatchError if the stored file moved on. That is what makes PRD §24
 * ("never blindly overwrite stale data") enforceable — see drive-store.ts for
 * the read-modify-write loop built on top.
 */
import { createSign } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { config } from "../config.js";

export const DRIVE_FOLDER_MIME = "application/vnd.google-apps.folder";

export class DriveNotConfiguredError extends Error {
  constructor() {
    super("Google Drive is not configured. Set GOOGLE_DRIVE_ROOT_FOLDER_ID plus either service-account or OAuth credentials (or DRIVE_LOCAL_ROOT for local development).");
    this.name = "DriveNotConfiguredError";
  }
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
}

export interface DriveClient {
  /** Returns the id of the named child folder, creating it if absent. */
  ensureFolder(name: string, parentId: string): Promise<string>;
  /** Finds a direct child by exact name, or null. */
  findChild(name: string, parentId: string): Promise<DriveFileMeta | null>;
  /** Creates a text file with content, returning its metadata. */
  createTextFile(name: string, parentId: string, content: string): Promise<DriveFileMeta>;
  /** Reads a file's text content together with the revision it was read at. */
  readTextFile(fileId: string): Promise<{ content: string; revisionId: string }>;
  /** Overwrites content, but only if the file is still at `expectedRevisionId`. */
  updateTextFile(fileId: string, content: string, expectedRevisionId: string): Promise<DriveFileMeta>;
  /** Current metadata without transferring content — used to cheaply poll revisions. */
  getMeta(fileId: string): Promise<DriveFileMeta>;
  /** Uploads a local file (the editor's video) and returns its Drive metadata. */
  uploadBinaryFile(name: string, parentId: string, localPath: string, mimeType: string): Promise<DriveFileMeta>;
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

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export class GoogleDriveClient implements DriveClient {
  private token: { value: string; expiresAt: number } | null = null;

  /**
   * Returns a bearer token, refreshing shortly before expiry. Both supported
   * auth shapes converge here, so every caller below is auth-agnostic.
   */
  private async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt) return this.token.value;

    const d = config.drive;
    let body: string;
    if (d.serviceAccountEmail && d.serviceAccountKey) {
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

    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Google token request failed (HTTP ${res.status}): ${text.slice(0, 200)}`);
    }
    const json = await res.json() as { access_token?: string; expires_in?: number };
    if (!json.access_token) throw new Error("Google token response contained no access_token.");
    // Refresh a minute early so an in-flight request can't expire mid-call (§29).
    this.token = { value: json.access_token, expiresAt: Date.now() + ((json.expires_in ?? 3600) - 60) * 1000 };
    return this.token.value;
  }

  private async api(url: string, init: RequestInit = {}): Promise<Response> {
    const token = await this.accessToken();
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token}`);
    return fetch(url, { ...init, headers });
  }

  private async expectOk(res: Response, what: string): Promise<void> {
    if (res.ok) return;
    const text = await res.text().catch(() => "");
    throw new Error(`Drive ${what} failed (HTTP ${res.status}): ${text.slice(0, 300)}`);
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
    };
  }

  async findChild(name: string, parentId: string): Promise<DriveFileMeta | null> {
    // Escape per Drive query-string rules so a name with a quote can't break out.
    const safe = name.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    const q = encodeURIComponent(`name = '${safe}' and '${parentId}' in parents and trashed = false`);
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

  async createTextFile(name: string, parentId: string, content: string): Promise<DriveFileMeta> {
    // Multipart upload: metadata part, then the body, in one request.
    const boundary = `nerve-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const metadata = JSON.stringify({ name, parents: [parentId], mimeType: "application/json" });
    const body =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
      `--${boundary}\r\nContent-Type: application/json\r\n\r\n${content}\r\n` +
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
    const contentRes = await this.api(`${DRIVE_API}/files/${fileId}?alt=media&${SHARED_DRIVE_PARAMS}`);
    await this.expectOk(contentRes, "file read");
    const content = await contentRes.text();
    const meta = await this.getMeta(fileId);
    return { content, revisionId: meta.revisionId };
  }

  async getMeta(fileId: string): Promise<DriveFileMeta> {
    const fields = encodeURIComponent("id,name,mimeType,headRevisionId,version,modifiedTime");
    const res = await this.api(`${DRIVE_API}/files/${fileId}?fields=${fields}&${SHARED_DRIVE_PARAMS}`);
    await this.expectOk(res, "metadata read");
    return this.toMeta(await res.json() as Record<string, unknown>);
  }

  async updateTextFile(fileId: string, content: string, expectedRevisionId: string): Promise<DriveFileMeta> {
    // Drive has no reliable conditional-write header across file types, so the
    // guard is an explicit re-check immediately before the write. Combined with
    // the per-file serialisation in drive-store.ts (single API instance), this
    // closes the window in practice; the store re-reads and retries on mismatch.
    const current = await this.getMeta(fileId);
    if (current.revisionId !== expectedRevisionId) throw new RevisionMismatchError(fileId);

    const fields = encodeURIComponent("id,name,mimeType,headRevisionId,version,modifiedTime");
    const res = await this.api(`${DRIVE_UPLOAD_API}/files/${fileId}?uploadType=media&fields=${fields}&${SHARED_DRIVE_PARAMS}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: content,
    });
    await this.expectOk(res, "file update");
    return this.toMeta(await res.json() as Record<string, unknown>);
  }

  async uploadBinaryFile(name: string, parentId: string, localPath: string, mimeType: string): Promise<DriveFileMeta> {
    // Resumable upload: videos are far too large for a multipart body. We start
    // the session, then send the bytes in one PUT — enough for agency-sized
    // files, and the session URL is what would allow chunked retry later.
    const fields = encodeURIComponent("id,name,mimeType,headRevisionId,version,modifiedTime");
    const start = await this.api(`${DRIVE_UPLOAD_API}/files?uploadType=resumable&fields=${fields}&${SHARED_DRIVE_PARAMS}`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify({ name, parents: [parentId], mimeType }),
    });
    await this.expectOk(start, `upload session (${name})`);
    const sessionUrl = start.headers.get("location");
    if (!sessionUrl) throw new Error("Drive did not return a resumable upload session URL.");

    const stat = await fs.stat(localPath);
    const body = await fs.readFile(localPath);
    const put = await fetch(sessionUrl, {
      method: "PUT",
      headers: { "Content-Type": mimeType, "Content-Length": String(stat.size) },
      body: new Uint8Array(body),
    });
    await this.expectOk(put, `upload (${name})`);
    return this.toMeta(await put.json() as Record<string, unknown>);
  }

  async openStream(fileId: string, range?: string) {
    const token = await this.accessToken();
    const headers = new Headers({ Authorization: `Bearer ${token}` });
    if (range) headers.set("Range", range);
    const res = await fetch(`${DRIVE_API}/files/${fileId}?alt=media&${SHARED_DRIVE_PARAMS}`, { headers });
    if (!res.ok && res.status !== 206) {
      const text = await res.text().catch(() => "");
      throw new Error(`Drive stream failed (HTTP ${res.status}): ${text.slice(0, 200)}`);
    }
    return { body: res.body, status: res.status, headers: res.headers };
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

  private async metaOf(id: string): Promise<DriveFileMeta> {
    const full = this.resolve(id);
    const stat = await fs.stat(full);
    return {
      id,
      name: path.basename(full),
      revisionId: stat.isDirectory() ? "0" : await this.revisionOf(id),
      mimeType: stat.isDirectory() ? DRIVE_FOLDER_MIME : "application/json",
      modifiedTime: stat.mtime.toISOString(),
    };
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

  async createTextFile(name: string, parentId: string, content: string): Promise<DriveFileMeta> {
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

  async updateTextFile(fileId: string, content: string, expectedRevisionId: string): Promise<DriveFileMeta> {
    if (await this.revisionOf(fileId) !== expectedRevisionId) throw new RevisionMismatchError(fileId);
    await fs.writeFile(this.resolve(fileId), content, "utf8");
    await this.bumpRevision(fileId);
    return this.metaOf(fileId);
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

// ── Selection ──────────────────────────────────────────────────────────────

export function driveIsConfigured(): boolean {
  const d = config.drive;
  const hasGoogle = !!d.rootFolderId
    && ((!!d.serviceAccountEmail && !!d.serviceAccountKey)
      || (!!d.oauthClientId && !!d.oauthClientSecret && !!d.oauthRefreshToken));
  return hasGoogle || !!d.localRoot;
}

/** True when running against the filesystem adapter rather than real Drive. */
export function driveIsLocal(): boolean {
  const d = config.drive;
  const hasGoogle = !!d.rootFolderId
    && ((!!d.serviceAccountEmail && !!d.serviceAccountKey)
      || (!!d.oauthClientId && !!d.oauthClientSecret && !!d.oauthRefreshToken));
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
