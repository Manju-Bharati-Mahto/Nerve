// @vitest-environment node
/* ═══════════════════════════════════════════════════════════════════════════
   INTEGRATION — an Admin connects Google Drive for casting photos from the app.

   Real route handlers on a throwaway express app; a FAKE Google behind
   globalThis.fetch for accounts.google.com and googleapis.com, so the whole
   round trip — sign-in URL, callback, folder, upload, stream, disconnect — is
   exercised without credentials. Everything else on the network is real.
   Synthetic `zkd-` fixtures and the single mo_casting_drive row, removed
   afterwards. Skips cleanly when no database is reachable.
   ═══════════════════════════════════════════════════════════════════════════ */
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectTestDatabase } from "./test-db.js";

const PX = "zkd";
let dbUp = false;
let pool: import("pg").Pool;
let api: typeof import("./mediaops-api.js");
let drive: typeof import("./casting-drive.js");
let photos: typeof import("./casting-photos.js");
let config: typeof import("./config.js").config;
let server: Server;
let root = "";
let tmpRoot = "";
let savedDrive: Record<string, string>;

const A = {
  admin: { id: `${PX}-admin`, role: "admin", team: "media" },
  mgr:   { id: `${PX}-mgr`,   role: "user",  team: "media" },   // casting_manager duty — NOT enough here
  emp:   { id: `${PX}-emp`,   role: "user",  team: "media" },
} as const;
type ActorName = keyof typeof A;

const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0300050001" +
  "ff8b7b1e0000000049454e44ae426082", "hex");
const FOLDER = "application/vnd.google-apps.folder";

{
  const t = await connectTestDatabase(); pool = t.pool; dbUp = t.dbUp;
  ({ config } = await import("./config.js"));
  drive = await import("./casting-drive.js");
  photos = await import("./casting-photos.js");
}
const maybe = dbUp ? describe : describe.skip;

/* ── A Google that answers the way Google does, for the calls Nerve makes ── */
const realFetch = globalThis.fetch;
type Hit = { url: string; method: string; body: string | null };
const hits: Hit[] = [];
let googleDown = false;
const createdNames: Record<string, string> = {};
const json = (o: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", ...headers } });
function fakeGoogle(url: string, init?: RequestInit): Response | null {
  const u = new URL(url);
  if (!/(^|\.)googleapis\.com$|(^|\.)accounts\.google\.com$/.test(u.hostname)) return null;
  const method = (init?.method ?? "GET").toUpperCase();
  const body = typeof init?.body === "string" ? init.body : null;
  hits.push({ url, method, body });
  if (googleDown) return new Response("down", { status: 503 });
  if (u.pathname === "/token") {
    const p = new URLSearchParams(body ?? "");
    if (p.get("grant_type") === "authorization_code")
      return p.get("code") === "good-code" ? json({ access_token: "at-1", refresh_token: "rt-1", expires_in: 3600 })
                                            : json({ error: "invalid_grant" }, 400);
    return json({ access_token: "at-2", expires_in: 3600 });
  }
  if (u.pathname === "/revoke") return json({});
  if (u.pathname === "/oauth2/v3/userinfo") return json({ email: "Casting.Manager@paruluniversity.ac.in" });
  if (u.pathname === "/drive/v3/files" && method === "GET") return json({ files: [] });          // findChild: nothing yet
  if (u.pathname === "/drive/v3/files" && method === "POST") {
    const b = JSON.parse(body ?? "{}") as { name: string };
    const id = `created-${b.name.replace(/\W+/g, "-")}`;
    createdNames[id] = b.name;
    return json({ id });
  }
  const one = u.pathname.match(/^\/drive\/v3\/files\/([^/]+)$/);
  if (one && method === "GET") {
    const id = decodeURIComponent(one[1]);
    if (u.searchParams.get("alt") === "media")
      return new Response(new Uint8Array(PNG), { status: 200, headers: { "content-type": "image/png", "content-length": String(PNG.length) } });
    if (createdNames[id]) return json({ id, name: createdNames[id], mimeType: FOLDER, version: "1", modifiedTime: "2026-10-04T00:00:00Z" });
    if (id === "existingFolder123") return json({ id, name: "Casting 2026", mimeType: FOLDER, version: "1" });
    if (id === "aFileNotAFolder1") return json({ id, name: "photo.jpg", mimeType: "image/jpeg", version: "1" });
    return json({ error: { code: 404, message: "File not found" } }, 404);
  }
  if (u.pathname === "/upload/drive/v3/files" && method === "POST")
    return new Response("", { status: 200, headers: { location: "https://www.googleapis.com/upload/drive/v3/session/abc" } });
  if (u.pathname === "/upload/drive/v3/session/abc" && method === "PUT")
    return json({ id: "uploaded-file-1", name: "photo.png", mimeType: "image/png", version: "1" });
  return new Response(`unexpected ${method} ${url}`, { status: 500 });
}

async function boot() {
  const express = (await import("express")).default;
  const multer = (await import("multer")).default;
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const a = A[(req.headers["x-actor"] as ActorName)];
    res.locals.currentUser = a ? { id: a.id, role: a.role, team: a.team } : { id: "", role: "user", team: null };
    next();
  });
  const noLimit = (_q: unknown, _s: unknown, n: () => void) => n();
  const staging = path.join(tmpRoot, "staging");
  await fs.mkdir(staging, { recursive: true });
  const castingPhotoUpload = multer({
    storage: multer.diskStorage({
      destination: (_q, _f, cb) => cb(null, staging),
      filename: (_q, _f, cb) => cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}`),
    }),
    limits: { fileSize: 1024 * 1024, files: 1 },
    fileFilter: (_q, f, cb) => { if (photos.CASTING_PHOTO_MIME[f.mimetype]) return cb(null, true); cb(new Error("Please upload a JPG, PNG or WEBP photo.")); },
  }).single("photo");
  api.registerMediaOpsApi(app as never, {
    asyncHandler: (fn) => (req, res, next) => { void fn(req, res, next).catch(next); },
    sendError: (res, status, message) => { res.status(status).json({ message }); },
    getSingleParam: (v) => (Array.isArray(v) ? v[0] : v),
    otpSendLimiter: noLimit as never,
    otpVerifyLimiter: noLimit as never,
    castingPhotoUpload,
  });
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  root = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
}

async function as(actor: ActorName | "anon", method: string, p: string, body?: unknown) {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (actor !== "anon") h["x-actor"] = actor;
  const r = await realFetch(root + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => null)) as Record<string, unknown> };
}
async function page(actor: ActorName, p: string) {
  const r = await realFetch(root + p, { headers: { "x-actor": actor } });
  return { status: r.status, type: r.headers.get("content-type") ?? "", html: await r.text() };
}
async function look(actor: ActorName, p: string) {
  const r = await realFetch(root + p, { headers: { "x-actor": actor } });
  return { status: r.status, type: r.headers.get("content-type"), bytes: Buffer.from(await r.arrayBuffer()) };
}
async function submitWith(token: string, payload: Record<string, unknown>, file: { name: string; type: string; bytes: Buffer }) {
  const fd = new FormData();
  fd.append("payload", JSON.stringify(payload));
  fd.append("photo", new Blob([new Uint8Array(file.bytes)], { type: file.type }), file.name);
  const r = await realFetch(`${root}/public/casting/${token}/submit`, { method: "POST", body: fd });
  return { status: r.status, body: (await r.json().catch(() => null)) as Record<string, unknown> };
}
const status = async () => (await as("admin", "GET", "/media/casting-drive")).body;
const CLIENT = { client_id: "1234-abc.apps.googleusercontent.com", client_secret: "GOCSPX-test-secret-value" };

async function cleanup() {
  await pool.query(`DELETE FROM mo_casting_drive`);
  await pool.query(`DELETE FROM mo_casting_requests WHERE link_id IN
                      (SELECT id FROM mo_casting_links WHERE name LIKE $1)`, [`${PX} %`]);
  await pool.query(`DELETE FROM mo_notifications WHERE user_id LIKE $1`, [`${PX}-%`]);
  await pool.query(`DELETE FROM mo_audit_logs WHERE actor_id LIKE $1`, [`${PX}-%`]);
  await pool.query(`DELETE FROM mo_casting_links WHERE name LIKE $1`, [`${PX} %`]);
  await pool.query(`DELETE FROM mo_user_duties WHERE user_id LIKE $1`, [`${PX}-%`]);
  await pool.query(`DELETE FROM mo_user_profiles WHERE user_id LIKE $1`, [`${PX}-%`]);
  await pool.query(`DELETE FROM users WHERE id LIKE $1`, [`${PX}-%`]);
}

beforeAll(async () => {
  if (!dbUp) return;
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nerve-casting-drive-it-"));
  savedDrive = { ...config.drive };
  /* No environment Drive of any kind: what this suite proves is the app
     connection, and a developer's shell must not leak into it. */
  Object.assign(config.drive, {
    localRoot: "", rootFolderId: "", castingFolderId: "",
    serviceAccountEmail: "", serviceAccountKey: "", oauthClientId: "", oauthClientSecret: "", oauthRefreshToken: "",
  });
  photos.useCastingDriveLoader(null);
  photos.resetCastingPhotoClient();
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const r = fakeGoogle(url, init);
    return r ? Promise.resolve(r) : realFetch(input as never, init);
  }) as typeof fetch;
  api = await import("./mediaops-api.js");
  const { bootstrapMediaOpsDatabase } = await import("./mediaops-db.js");
  await bootstrapMediaOpsDatabase();
  await cleanup();
  for (const a of Object.values(A))
    await pool.query(
      `INSERT INTO users (id, full_name, email, role, team, status, password_hash, department)
       VALUES ($1,$2,$3,$4,$5,'active','x','') ON CONFLICT (id) DO UPDATE
         SET role=EXCLUDED.role, team=EXCLUDED.team, status='active'`,
      [a.id, `ZCD ${a.id}`, `${a.id}@x.invalid`, a.role, a.team]);
  for (const id of [A.mgr.id, A.emp.id])
    await pool.query(`INSERT INTO mo_user_profiles (user_id, designation, mo_role) VALUES ($1,'ZCD','employee')
                      ON CONFLICT (user_id) DO NOTHING`, [id]);
  await pool.query(
    `INSERT INTO mo_user_duties (user_id, duty_flag_id, granted_at)
     SELECT $1, id, CURRENT_DATE FROM mo_duty_flags WHERE code='casting_manager' ON CONFLICT DO NOTHING`, [A.mgr.id]);
  await boot();
});
afterAll(async () => {
  globalThis.fetch = realFetch;
  if (server) await new Promise((r) => server.close(r));
  if (dbUp) await cleanup();
  if (savedDrive) Object.assign(config.drive, savedDrive);
  photos.resetCastingPhotoClient();
  if (tmpRoot) await fs.rm(tmpRoot, { recursive: true, force: true });
});

maybe("connecting Google Drive for casting photos from the app", () => {
  it("is the Admin's alone — the Casting Manager duty does not reach it", async () => {
    expect((await as("mgr", "GET", "/media/casting-drive")).status).toBe(403);
    expect((await as("emp", "GET", "/media/casting-drive")).status).toBe(403);
    expect((await as("mgr", "POST", "/media/casting-drive/connect", {})).status).toBe(403);
    const st = await status();
    expect(st.client).toBe("none");
    expect(st.connected).toBe(false);
    expect(st.source).toBe("none");
    expect(String(st.redirect_uri)).toMatch(/\/api\/v1\/media\/casting-drive\/callback$/);
  });

  it("cannot connect until an OAuth client exists, and checks the client id's shape", async () => {
    const r = await as("admin", "POST", "/media/casting-drive/connect", {});
    expect(r.status).toBe(400);
    expect(String(r.body.message)).toMatch(/OAuth client/);
    expect((await as("admin", "POST", "/media/casting-drive/client", { client_id: "nope", client_secret: "x".repeat(20) })).status).toBe(400);
    expect((await as("admin", "POST", "/media/casting-drive/client", { ...CLIENT, client_secret: "short" })).status).toBe(400);
  });

  it("saves the client sealed, and builds the Google sign-in URL for a popup", async () => {
    const saved = await as("admin", "POST", "/media/casting-drive/client", CLIENT);
    expect(saved.status).toBe(200);
    expect(saved.body.client).toBe("app");
    expect(saved.body.client_id).toBe(CLIENT.client_id);
    const row = (await pool.query(`SELECT oauth_client_secret_enc FROM mo_casting_drive WHERE id=1`)).rows[0];
    expect(String(row.oauth_client_secret_enc)).toMatch(/^v1\./);
    expect(String(row.oauth_client_secret_enc)).not.toContain("test-secret");

    const r = await as("admin", "POST", "/media/casting-drive/connect", {});
    expect(r.status).toBe(200);
    const u = new URL(String(r.body.url));
    expect(u.origin + u.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(u.searchParams.get("client_id")).toBe(CLIENT.client_id);
    expect(u.searchParams.get("redirect_uri")).toBe(drive.castingDriveRedirectUri());
    expect(u.searchParams.get("access_type")).toBe("offline");
    expect(u.searchParams.get("prompt")).toBe("consent");
    expect(u.searchParams.get("scope")).toContain("https://www.googleapis.com/auth/drive");
    expect(drive.verifyDriveState(String(u.searchParams.get("state")), A.admin.id)).toBe(true);
  });

  it("the callback refuses a state it did not sign for THIS admin, and anyone who is not an Admin", async () => {
    const bogus = await page("admin", "/media/casting-drive/callback?code=good-code&state=bogus");
    expect(bogus.status).toBe(400);
    expect(bogus.type).toContain("text/html");
    expect(bogus.html).toContain("not valid");
    const theirs = drive.signDriveState(A.mgr.id);
    expect((await page("admin", `/media/casting-drive/callback?code=good-code&state=${encodeURIComponent(theirs)}`)).status).toBe(400);
    expect((await page("mgr", `/media/casting-drive/callback?code=good-code&state=${encodeURIComponent(theirs)}`)).status).toBe(403);
    const cancelled = await page("admin", "/media/casting-drive/callback?error=access_denied");
    expect(cancelled.status).toBe(400);
    expect(cancelled.html).toContain("cancelled");
    expect((await status()).connected).toBe(false);
  });

  it("a bad code is reported in the popup, not swallowed", async () => {
    const st = drive.signDriveState(A.admin.id);
    const r = await page("admin", `/media/casting-drive/callback?code=bad-code&state=${encodeURIComponent(st)}`);
    expect(r.status).toBe(502);
    expect(r.html).toContain("Google refused");
    expect((await status()).connected).toBe(false);
  });

  it("the callback stores the connection, sealed, and creates the folder in the account's My Drive", async () => {
    const st = drive.signDriveState(A.admin.id);
    const r = await page("admin", `/media/casting-drive/callback?code=good-code&state=${encodeURIComponent(st)}`);
    expect(r.status).toBe(200);
    expect(r.html).toContain("Google Drive connected");
    expect(r.html).toContain("NERVE Casting Registrations");
    expect(r.html).toContain("nerve-casting-drive");                 // tells the opener

    const s = await status();
    expect(s.connected).toBe(true);
    expect(s.source).toBe("app");
    expect(s.account_email).toBe("casting.manager@paruluniversity.ac.in");
    expect(s.connected_by).toBe(A.admin.id);
    expect(s.folder).toEqual({ id: "created-NERVE-Casting-Registrations", name: "NERVE Casting Registrations",
                               url: "https://drive.google.com/drive/folders/created-NERVE-Casting-Registrations" });
    const row = (await pool.query(`SELECT refresh_token_enc FROM mo_casting_drive WHERE id=1`)).rows[0];
    expect(String(row.refresh_token_enc)).toMatch(/^v1\./);
    expect(String(row.refresh_token_enc)).not.toContain("rt-1");
    // The folder was created at the root of My Drive.
    const create = hits.find((h) => h.method === "POST" && h.url.includes("/drive/v3/files?") && (h.body ?? "").includes("NERVE Casting Registrations"));
    expect(create).toBeTruthy();
    expect(JSON.parse(create!.body!).parents).toEqual(["root"]);
  });

  it("the public form now offers upload, and a photo goes through the connected Drive and back", async () => {
    const link = (await as("admin", "POST", "/media/casting-links", { name: `${PX} Drive`, require_otp: false })).body.link as Record<string, unknown>;
    expect((await as("anon", "GET", `/public/casting/${link.token}`)).body.photo_upload).toBe(true);

    hits.length = 0;
    const sub = await submitWith(link.token, { name: "Asha Patel", applicant_type: "Student", mobile_phone: "9876543210", consent: true, email: "p@example.com" },
      { name: "me.png", type: "image/png", bytes: PNG });
    expect(sub.status).toBe(201);
    const code = String(sub.body.request_id);
    const row = (await pool.query(`SELECT * FROM mo_casting_requests WHERE request_id=$1`, [code])).rows[0];
    expect(row.photo_file_id).toBe("uploaded-file-1");
    expect(row.photo_folder_id).toBe(`created-${code}`);
    expect(row.photo_mime).toBe("image/png");
    expect(row.photo_url).toBe("https://drive.google.com/file/d/uploaded-file-1/view");
    // The request's folder was created INSIDE the configured folder.
    const mk = hits.find((h) => h.method === "POST" && h.url.includes("/drive/v3/files?") && (h.body ?? "").includes(code));
    expect(JSON.parse(mk!.body!).parents).toEqual(["created-NERVE-Casting-Registrations"]);
    expect(hits.some((h) => h.method === "PUT" && h.url.includes("/upload/drive/v3/session/"))).toBe(true);

    const seen = await look("mgr", `/media/casting-requests/${row.id}/photo`);
    expect(seen.status).toBe(200);
    expect(seen.type).toBe("image/png");
    expect(seen.bytes.equals(PNG)).toBe(true);
  });

  it("a folder the Admin already has can be used, by link — a file, a missing folder or a non-link cannot", async () => {
    const ok = await as("admin", "POST", "/media/casting-drive/folder", { folder: "https://drive.google.com/drive/folders/existingFolder123?usp=sharing" });
    expect(ok.status).toBe(200);
    expect((ok.body.folder as Record<string, unknown>).name).toBe("Casting 2026");
    const file = await as("admin", "POST", "/media/casting-drive/folder", { folder: "aFileNotAFolder1" });
    expect(file.status).toBe(400);
    expect(String(file.body.message)).toMatch(/file, not a folder/);
    const missing = await as("admin", "POST", "/media/casting-drive/folder", { folder: "https://drive.google.com/drive/folders/doesNotExist0000" });
    expect(missing.status).toBe(400);
    expect(String(missing.body.message)).toMatch(/could not open/);
    expect((await as("admin", "POST", "/media/casting-drive/folder", { folder: "https://drive.google.com/file/d/aFileNotAFolder1/view" })).status).toBe(400);
    expect(((await status()).folder as Record<string, unknown>).id).toBe("existingFolder123");
  });

  it("or a new folder is created on request, in My Drive", async () => {
    const r = await as("admin", "POST", "/media/casting-drive/folder", { create: "Casting Drive 2027" });
    expect(r.status).toBe(200);
    expect(r.body.folder).toEqual({ id: "created-Casting-Drive-2027", name: "Casting Drive 2027",
                                    url: "https://drive.google.com/drive/folders/created-Casting-Drive-2027" });
  });

  it("Check connection asks Google and says what it heard", async () => {
    const ok = await as("admin", "POST", "/media/casting-drive/check", {});
    expect(ok.body).toEqual({ ok: true, folder_name: "Casting Drive 2027" });
    googleDown = true;
    try {
      const down = await as("admin", "POST", "/media/casting-drive/check", {});
      expect(down.body.ok).toBe(false);
      expect(String(down.body.error)).toMatch(/503/);
    } finally { googleDown = false; }
  });

  it("disconnecting revokes the token, keeps the folder and the client, and stops uploads; reconnecting keeps the folder", async () => {
    hits.length = 0;
    const r = await as("admin", "DELETE", "/media/casting-drive");
    expect(r.status).toBe(200);
    expect(r.body.connected).toBe(false);
    expect(r.body.client).toBe("app");
    expect((r.body.folder as Record<string, unknown>).id).toBe("created-Casting-Drive-2027");
    expect(r.body.source).toBe("none");
    expect(hits.some((h) => h.method === "POST" && h.url.startsWith("https://oauth2.googleapis.com/revoke"))).toBe(true);
    const link = (await as("admin", "POST", "/media/casting-links", { name: `${PX} Drive after`, require_otp: false })).body.link as Record<string, unknown>;
    expect((await as("anon", "GET", `/public/casting/${link.token}`)).body.photo_upload).toBe(false);

    const st = drive.signDriveState(A.admin.id);
    expect((await page("admin", `/media/casting-drive/callback?code=good-code&state=${encodeURIComponent(st)}`)).status).toBe(200);
    const again = await status();
    expect(again.connected).toBe(true);
    expect((again.folder as Record<string, unknown>).id).toBe("created-Casting-Drive-2027");   // still visible: kept
    expect((again.folder as Record<string, unknown>).name).toBe("Casting Drive 2027");
  });
});
