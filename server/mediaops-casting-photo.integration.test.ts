// @vitest-environment node
/* ═══════════════════════════════════════════════════════════════════════════
   INTEGRATION — the applicant's photo goes to Google Drive, the ids come back,
   and only the right people can look.

   Real route handlers on a throwaway express app, the server's own multer
   shape, and the filesystem Drive adapter in a temp directory — the same
   semantics as Drive, no credentials. Synthetic `zkp-` fixtures, removed
   afterwards. Skips cleanly when no database is reachable.
   ═══════════════════════════════════════════════════════════════════════════ */
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectTestDatabase } from "./test-db.js";

const PX = "zkp";
let dbUp = false;
let pool: import("pg").Pool;
let api: typeof import("./mediaops-api.js");
let server: Server;
let root = "";
let tmpRoot = "";
let staging = "";
/* Loaded AFTER connectTestDatabase() has pointed DATABASE_URL at the test
   database: server/config.ts reads the url at import time, and db.js reads
   config — a static import here would freeze the wrong url into the pool and
   the suite would silently skip. */
let config: typeof import("./config.js").config;
let photos: typeof import("./casting-photos.js");
let savedDrive: Record<string, string>;

const A = {
  admin: { id: `${PX}-admin`, role: "admin", team: "media" },
  mgr:   { id: `${PX}-mgr`,   role: "user",  team: "media" },   // holds the casting_manager duty
  emp:   { id: `${PX}-emp`,   role: "user",  team: "media" },   // ordinary crew: Preview only
} as const;
type ActorName = keyof typeof A;

/* A real 1×1 PNG, so the bytes that come back can be compared to what went in. */
const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0300050001" +
  "ff8b7b1e0000000049454e44ae426082", "hex");

{
  const t = await connectTestDatabase(); pool = t.pool; dbUp = t.dbUp;
  ({ config } = await import("./config.js"));
  photos = await import("./casting-photos.js");
}
const maybe = dbUp ? describe : describe.skip;

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
  staging = path.join(tmpRoot, "staging");
  await fs.mkdir(staging, { recursive: true });
  /* The server's own multer shape, with a deliberately tiny size cap so the
     "too large" path is exercised without pushing 8 MB through a test. */
  const castingPhotoUpload = multer({
    storage: multer.diskStorage({
      destination: (_q, _f, cb) => cb(null, staging),
      filename: (_q, _f, cb) => cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}`),
    }),
    limits: { fileSize: 16 * 1024, files: 1 },
    fileFilter: (_q, f, cb) => {
      if (photos.CASTING_PHOTO_MIME[f.mimetype]) return cb(null, true);
      cb(new Error("Please upload a JPG, PNG or WEBP photo."));
    },
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
  const r = await fetch(root + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => null)) as Record<string, unknown> };
}
/* The photo routes answer with bytes, not JSON. */
async function look(actor: ActorName, p: string) {
  const r = await fetch(root + p, { headers: { "x-actor": actor } });
  return { status: r.status, type: r.headers.get("content-type"), cache: r.headers.get("cache-control"),
           bytes: Buffer.from(await r.arrayBuffer()) };
}
/* What the form sends when a photo is attached: the JSON in `payload`, the file in `photo`. */
async function submitWith(token: string, payload: Record<string, unknown>, file?: { name: string; type: string; bytes: Buffer }) {
  const fd = new FormData();
  fd.append("payload", JSON.stringify(payload));
  if (file) fd.append("photo", new Blob([new Uint8Array(file.bytes)], { type: file.type }), file.name);
  const r = await fetch(`${root}/public/casting/${token}/submit`, { method: "POST", body: fd });
  return { status: r.status, body: (await r.json().catch(() => null)) as Record<string, unknown> };
}

/* Verification off (Admin only), so the suite needs no mailbox: the photo
   rules are the same either way, and the OTP suite owns the identity rules. */
const mkLink = async (extra: Record<string, unknown> = {}) =>
  ((await as("admin", "POST", "/media/casting-links", { name: `${PX} Drive`, require_otp: false, ...extra })).body.link as Record<string, unknown>);
const form = (extra: Record<string, unknown> = {}) => ({
  name: "Asha Patel", applicant_type: "Student", mobile_phone: "9876543210", consent: true, ...extra,
});
const requestRow = async (code: string) =>
  (await pool.query(`SELECT * FROM mo_casting_requests WHERE request_id=$1`, [code])).rows[0] as Record<string, unknown>;

async function cleanup() {
  await pool.query(`DELETE FROM mo_casting_records WHERE created_by LIKE $1`, [`${PX}-%`]);
  await pool.query(`DELETE FROM mo_casting_requests WHERE link_id IN
                      (SELECT id FROM mo_casting_links WHERE name LIKE $1)`, [`${PX} %`]);
  await pool.query(`DELETE FROM mo_notifications WHERE user_id LIKE $1`, [`${PX}-%`]);
  await pool.query(`DELETE FROM mo_portal_sessions WHERE token LIKE $1`, [`${PX}-%`]);
  await pool.query(`DELETE FROM mo_audit_logs WHERE actor_id LIKE $1`, [`${PX}-%`]);
  await pool.query(`DELETE FROM mo_casting_links WHERE name LIKE $1`, [`${PX} %`]);
  await pool.query(`DELETE FROM mo_user_duties WHERE user_id LIKE $1`, [`${PX}-%`]);
  await pool.query(`DELETE FROM mo_user_profiles WHERE user_id LIKE $1`, [`${PX}-%`]);
  await pool.query(`DELETE FROM users WHERE id LIKE $1`, [`${PX}-%`]);
}

beforeAll(async () => {
  if (!dbUp) return;
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nerve-casting-photo-it-"));
  savedDrive = { ...config.drive };
  Object.assign(config.drive, {
    localRoot: tmpRoot, rootFolderId: "", castingFolderId: "",
    serviceAccountEmail: "", serviceAccountKey: "", oauthClientId: "", oauthClientSecret: "", oauthRefreshToken: "",
  });
  photos.useCastingDriveLoader(async () => null);   // the local adapter is what this suite is about
  photos.resetCastingPhotoClient();
  api = await import("./mediaops-api.js");
  const { bootstrapMediaOpsDatabase } = await import("./mediaops-db.js");
  await bootstrapMediaOpsDatabase();
  await cleanup();
  for (const a of Object.values(A))
    await pool.query(
      `INSERT INTO users (id, full_name, email, role, team, status, password_hash, department)
       VALUES ($1,$2,$3,$4,$5,'active','x','') ON CONFLICT (id) DO UPDATE
         SET role=EXCLUDED.role, team=EXCLUDED.team, status='active'`,
      [a.id, `ZCP ${a.id}`, `${a.id}@x.invalid`, a.role, a.team]);
  for (const id of [A.mgr.id, A.emp.id])
    await pool.query(
      `INSERT INTO mo_user_profiles (user_id, designation, mo_role) VALUES ($1,'ZCP','employee')
       ON CONFLICT (user_id) DO NOTHING`, [id]);
  await pool.query(
    `INSERT INTO mo_user_duties (user_id, duty_flag_id, granted_at)
     SELECT $1, id, CURRENT_DATE FROM mo_duty_flags WHERE code='casting_manager'
     ON CONFLICT DO NOTHING`, [A.mgr.id]);
  await boot();
});
afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (dbUp) await cleanup();
  if (savedDrive) Object.assign(config.drive, savedDrive);
  photos.useCastingDriveLoader(null);
  photos.resetCastingPhotoClient();
  if (tmpRoot) await fs.rm(tmpRoot, { recursive: true, force: true });
});

maybe("casting registration photo upload", () => {
  it("the public page says a photo can be uploaded when the server can store one", async () => {
    const link = await mkLink();
    const pub = await as("anon", "GET", `/public/casting/${link.token}`);
    expect(pub.status).toBe(200);
    expect(pub.body.photo_upload).toBe(true);
  });

  it("a first submission needs a photo, and says 'upload' rather than 'link'", async () => {
    const link = await mkLink();
    const r = await as("anon", "POST", `/public/casting/${link.token}/submit`, form({ email: "nophoto@example.com" }));
    expect(r.status).toBe(400);
    expect(String(r.body.message)).toMatch(/upload your photo/i);
  });

  it("puts the photo in Drive under the request's own folder and keeps the ids on the row", async () => {
    const link = await mkLink();
    const r = await submitWith(link.token, form({ email: "p1@example.com" }), { name: "me.png", type: "image/png", bytes: PNG });
    expect(r.status).toBe(201);
    const code = String(r.body.request_id);
    expect(code).toMatch(/^CR-\d{5}$/);

    const row = await requestRow(code);
    expect(row.photo_mime).toBe("image/png");
    expect(row.photo_folder_id).toBe(path.join(photos.LOCAL_CASTING_FOLDER, code));
    expect(String(row.photo_file_id)).toMatch(new RegExp(`^${photos.LOCAL_CASTING_FOLDER}/${code}/${code}-photo-\\d{8}-\\d{6}\\.png$`));
    expect(row.photo_url).toBeNull();                    // the local adapter has no web links

    const inDrive = (await fs.readdir(path.join(tmpRoot, photos.LOCAL_CASTING_FOLDER, code))).filter((f) => f.endsWith(".png"));
    expect(inDrive).toHaveLength(1);
    // The staged copy is gone: Drive has the photo, the server's disk does not.
    expect(await fs.readdir(staging)).toEqual([]);
  });

  it("refuses a file that is not a photo, or too large, with a message the applicant can act on — and keeps no row", async () => {
    const link = await mkLink();
    const notImage = await submitWith(link.token, form({ email: "txt@example.com" }),
      { name: "cv.txt", type: "text/plain", bytes: Buffer.from("hello") });
    expect(notImage.status).toBe(400);
    expect(String(notImage.body.message)).toMatch(/JPG, PNG or WEBP/);

    const tooBig = await submitWith(link.token, form({ email: "big@example.com" }),
      { name: "big.png", type: "image/png", bytes: Buffer.alloc(40 * 1024, 1) });
    expect(tooBig.status).toBe(400);
    expect(String(tooBig.body.message)).toMatch(/larger than 8 MB/);

    const { rows } = await pool.query(
      `SELECT 1 FROM mo_casting_requests WHERE link_id=$1 AND applicant_email IN ('txt@example.com','big@example.com')`, [link.id]);
    expect(rows).toHaveLength(0);
    expect(await fs.readdir(staging)).toEqual([]);
  });

  it("still takes a pasted Drive link as plain JSON, so an older page keeps working", async () => {
    const link = await mkLink();
    const r = await as("anon", "POST", `/public/casting/${link.token}/submit`,
      form({ email: "link@example.com", photo_url: "https://drive.google.com/file/d/abc/view" }));
    expect(r.status).toBe(201);
    const row = await requestRow(String(r.body.request_id));
    expect(row.photo_url).toBe("https://drive.google.com/file/d/abc/view");
    expect(row.photo_file_id).toBeNull();
  });

  it("streams the photo to the Casting Manager, and to nobody else", async () => {
    const link = await mkLink();
    const sub = await submitWith(link.token, form({ email: "look@example.com" }), { name: "me.png", type: "image/png", bytes: PNG });
    const row = await requestRow(String(sub.body.request_id));

    const mgr = await look("mgr", `/media/casting-requests/${row.id}/photo`);
    expect(mgr.status).toBe(200);
    expect(mgr.type).toBe("image/png");
    expect(mgr.cache).toBe("private, max-age=300");
    expect(mgr.bytes.equals(PNG)).toBe(true);

    expect((await look("admin", `/media/casting-requests/${row.id}/photo`)).status).toBe(200);
    expect((await look("emp", `/media/casting-requests/${row.id}/photo`)).status).toBe(403);

    // A request with a pasted link has nothing to stream.
    const linked = await as("anon", "POST", `/public/casting/${link.token}/submit`,
      form({ email: "linked@example.com", photo_url: "https://drive.google.com/file/d/abc/view" }));
    const linkedRow = await requestRow(String(linked.body.request_id));
    expect((await look("mgr", `/media/casting-requests/${linkedRow.id}/photo`)).status).toBe(404);
  });

  it("approval carries the photo to the casting record, where the crew can see it — until the record leaves Preview", async () => {
    const link = await mkLink();
    const sub = await submitWith(link.token, form({ email: "approve@example.com" }), { name: "me.png", type: "image/png", bytes: PNG });
    const row = await requestRow(String(sub.body.request_id));

    const ok = await as("mgr", "POST", `/media/casting-requests/${row.id}/review`, { status: "approved" });
    expect(ok.status).toBe(200);
    const rec = ok.body.record as Record<string, unknown>;
    expect(rec.photo_file_id).toBe(row.photo_file_id);
    expect(rec.photo_mime).toBe("image/png");
    expect(rec.drive_url).toBeNull();                    // no web link under the local adapter

    const emp = await look("emp", `/media/casting/${rec.id}/photo`);
    expect(emp.status).toBe(200);
    expect(emp.type).toBe("image/png");
    expect(emp.bytes.equals(PNG)).toBe(true);

    // Archived records leave Casting Preview; so does their photo. The manager still sees it.
    expect((await as("mgr", "DELETE", `/media/casting/${rec.id}`)).status).toBe(200);
    expect((await look("emp", `/media/casting/${rec.id}/photo`)).status).toBe(404);
    expect((await look("mgr", `/media/casting/${rec.id}/photo`)).status).toBe(200);
  });

  it("a verified re-submission keeps the photo on file unless a new one is sent; a new one replaces the pointer and the old file stays", async () => {
    // Verification ON, as every link is by default. The session row is what
    // the OTP flow would have minted; the OTP suite owns how it gets minted.
    const link = (await as("mgr", "POST", "/media/casting-links", { name: `${PX} Drive verified` })).body.link as Record<string, unknown>;
    const email = "resub@paruluniversity.ac.in";
    await pool.query(
      `INSERT INTO mo_portal_sessions (token, kind, link_token, email, expires_at)
       VALUES ($1,'casting',$2,$3,NOW() + interval '1 hour')`, [`${PX}-session-1`, link.token, email]);
    const sess = { portal_session: `${PX}-session-1` };

    const first = await submitWith(link.token, form(sess), { name: "me.png", type: "image/png", bytes: PNG });
    expect(first.status).toBe(201);
    const code = String(first.body.request_id);
    const before = await requestRow(code);
    expect(before.email_verified).toBe(true);

    const lookup = await as("anon", "POST", `/public/casting/${link.token}/lookup`, sess);
    expect((lookup.body.existing as Record<string, unknown>).has_photo).toBe(true);

    // No photo this time: the one on file stays, everything else updates.
    const keep = await as("anon", "POST", `/public/casting/${link.token}/submit`, form({ ...sess, name: "Asha P. Patel" }));
    expect(keep.status).toBe(200);
    expect(keep.body.updated).toBe(true);
    const kept = await requestRow(code);
    expect(kept.applicant_name).toBe("Asha P. Patel");
    expect(kept.photo_file_id).toBe(before.photo_file_id);

    // A new photo replaces the pointer; the earlier file stays in the folder.
    await new Promise((r) => setTimeout(r, 1100));          // the file name carries seconds
    const replace = await submitWith(link.token, form(sess), { name: "new.png", type: "image/png", bytes: PNG });
    expect(replace.status).toBe(200);
    const replaced = await requestRow(code);
    expect(replaced.photo_file_id).not.toBe(before.photo_file_id);
    expect(replaced.photo_folder_id).toBe(before.photo_folder_id);
    const inDrive = (await fs.readdir(path.join(tmpRoot, photos.LOCAL_CASTING_FOLDER, code))).filter((f) => f.endsWith(".png"));
    expect(inDrive).toHaveLength(2);
  });

  it("approval of a pasted-link request carries the link across as before, with nothing to stream", async () => {
    const link = await mkLink();
    const sub = await as("anon", "POST", `/public/casting/${link.token}/submit`,
      form({ email: "oldstyle@example.com", photo_url: "https://drive.google.com/file/d/xyz/view" }));
    const row = await requestRow(String(sub.body.request_id));
    const ok = await as("mgr", "POST", `/media/casting-requests/${row.id}/review`, { status: "approved" });
    const rec = ok.body.record as Record<string, unknown>;
    expect(rec.drive_url).toBe("https://drive.google.com/file/d/xyz/view");
    expect(rec.photo_file_id).toBeNull();
    expect((await look("emp", `/media/casting/${rec.id}/photo`)).status).toBe(404);
  });
});
