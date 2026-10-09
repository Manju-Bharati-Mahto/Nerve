// @vitest-environment node
/**
 * The outreach video HTTP surface when Google Drive misbehaves, and the
 * through-the-server upload's handling of the file.
 *
 * THE BUG THIS ENCODES. With the outreach Drive's refresh token revoked,
 * every endpoint answered a bare 500 "Internal server error." — the users
 * store is read from Drive before any route logic runs, outside any try. The
 * Users page simply broke, with nothing saying why or who could fix it. Every
 * Drive failure must now come back as JSON naming the problem and the fix,
 * whichever line it escaped from.
 *
 * Runs the real routes on an ephemeral port over the local Drive adapter;
 * only the two store reads below are made to fail on demand.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import multer from "multer";
import { promises as fs } from "node:fs";
import net, { type AddressInfo } from "node:net";
import { once } from "node:events";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";

const hooks = vi.hoisted(() => ({
  findUser: null as null | (() => Promise<never>),
  getCampaign: null as null | (() => Promise<never>),
  /** The Nerve accounts, by email, that the role-change route reads and writes. */
  nerveAccounts: new Map<string, { id: string; role: string; team: string | null }>(),
}));
vi.mock("../db.js", async () => {
  const real = await vi.importActual<typeof import("../db.js")>("../db.js");
  return {
    ...real,
    getUserByEmail: async (email: string) => hooks.nerveAccounts.get(email.toLowerCase()) ?? null,
    updateUser: async (id: string, input: { role?: string; team?: string | null }) => {
      const account = [...hooks.nerveAccounts.values()].find(a => a.id === id);
      if (!account) return null;
      Object.assign(account, input);
      return account;
    },
  };
});
vi.mock("./users.js", async () => {
  const real = await vi.importActual<typeof import("./users.js")>("./users.js");
  return { ...real, findUserByEmail: (email: string) => hooks.findUser ? hooks.findUser() : real.findUserByEmail(email) };
});
vi.mock("./campaigns.js", async () => {
  const real = await vi.importActual<typeof import("./campaigns.js")>("./campaigns.js");
  return { ...real, getCampaign: (id: string) => hooks.getCampaign ? hooks.getCampaign() : real.getCampaign(id) };
});

import { config } from "../config.js";
import { DriveAuthError, DriveUnavailableError, resetDriveClient } from "./drive-client.js";
import { resetStoreState } from "./drive-store.js";
import { DRIVE_RECONNECT_MESSAGE } from "./drive-errors.js";
import { VideoFileRejectedError, listVideos, uploadVideo } from "./videos.js";
import { UploadVerificationError } from "./upload-sessions.js";
import { isAcceptedVideoUpload, registerOutreachVideoApi, sweepVideoStaging, uploadOrigin, videoFileName } from "./routes.js";

let server: Server;
let base: string;
let tmpRoot: string;
let staging: string;
/** The Nerve role the next request is made as. */
let actingRole = "outreach_editor";

beforeAll(async () => {
  staging = await fs.mkdtemp(path.join(os.tmpdir(), "nerve-ov-staging-"));
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.locals.currentUser = { id: `u-${actingRole}`, role: actingRole, team: "outreach", full_name: "Om", email: `${actingRole}@a.com` };
    next();
  });
  const videoUpload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, staging),
      filename: (_req, file, cb) => cb(null, videoFileName(file.originalname)),
    }),
    limits: { fileSize: 64 },
    fileFilter: (_req, file, cb) => {
      if (isAcceptedVideoUpload(file.mimetype, file.originalname)) return cb(null, true);
      cb(new Error("Only video files can be uploaded here."));
    },
  });
  registerOutreachVideoApi(app, {
    asyncHandler: fn => (req, res, next) => { void fn(req, res, next).catch(next); },
    sendError: (res, status, message) => { res.status(status).json({ message }); },
    getSingleParam: v => (Array.isArray(v) ? v[0] : v),
    videoUpload,
    videoStagingDir: staging,
  });
  // What index.ts ends with: the global handler a Drive failure must never reach.
  app.use(((_err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ message: "Internal server error." });
  }) as express.ErrorRequestHandler);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/outreach/video`;
});

afterAll(async () => {
  server.close();
  await fs.rm(staging, { recursive: true, force: true });
});

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nerve-ov-routes-"));
  (config.drive as { localRoot: string }).localRoot = tmpRoot;
  (config.drive as { rootFolderId: string }).rootFolderId = "";
  (config.drive as { serviceAccountEmail: string }).serviceAccountEmail = "";
  (config.drive as { oauthClientId: string }).oauthClientId = "";
  resetDriveClient();
  resetStoreState();
  actingRole = "outreach_editor";
  hooks.findUser = null;
  hooks.getCampaign = null;
  hooks.nerveAccounts.clear();
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  resetDriveClient();
  resetStoreState();
});

const get = (p: string) => fetch(`${base}${p}`);
const post = (p: string, body: unknown) => fetch(`${base}${p}`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});
const stagedFiles = async () => (await fs.readdir(staging)).filter(n => !n.startsWith("."));

describe("a Drive failure on any endpoint", () => {
  it("a revoked token answers 503 drive_reconnect, not a bare 500", async () => {
    actingRole = "admin";
    hooks.findUser = () => Promise.reject(new DriveAuthError("Google refused the Drive sign-in (HTTP 400): invalid_grant", 400));
    const res = await get("/users");
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ message: DRIVE_RECONNECT_MESSAGE, code: "drive_reconnect" });
  });

  it("Google not answering is 502 drive_unavailable, with a short reason", async () => {
    hooks.findUser = () => Promise.reject(new DriveUnavailableError("Drive file lookup failed (HTTP 503): busy", 503));
    const res = await get("/videos");
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.code).toBe("drive_unavailable");
    expect(body.message).toMatch(/^Google Drive did not answer \(HTTP 503\)/);
  });

  it("is caught even when it escapes a handler", async () => {
    // GET /campaigns/:id reads the campaign outside any try.
    hooks.getCampaign = () => Promise.reject(new DriveUnavailableError("Google Drive could not be reached (timed out).", null));
    const res = await get("/campaigns/c1");
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ code: "drive_unavailable", message: expect.stringContaining("(timed out)") });
  });

  it("a DriveAuthError that escapes a handler is 503 drive_reconnect, never the global handler's answer", async () => {
    // Google's own status on the error (400 for invalid_grant) must not leak
    // out as the response status, and the global handler must never see it.
    hooks.getCampaign = () => Promise.reject(new DriveAuthError("Google refused the Drive sign-in (HTTP 400): invalid_grant", 400));
    const res = await get("/campaigns/c1");
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ message: DRIVE_RECONNECT_MESSAGE, code: "drive_reconnect" });
  });

  it("this module's typed errors are answered with their status when they escape", async () => {
    hooks.getCampaign = () => Promise.reject(new VideoFileRejectedError("That video is larger than 2 GB.", 413));
    let res = await get("/campaigns/c1");
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ message: "That video is larger than 2 GB." });
    hooks.getCampaign = () => Promise.reject(new UploadVerificationError("Drive did not report the uploaded file."));
    res = await get("/campaigns/c1");
    expect(res.status).toBe(400);
  });

  it("leaves everything else to the global handler", async () => {
    hooks.getCampaign = () => Promise.reject(new Error("a real bug"));
    const res = await get("/campaigns/c1");
    expect(res.status).toBe(500);
  });

  it("an unconnected Drive says who can connect it, with a code", async () => {
    (config.drive as { localRoot: string }).localRoot = "";
    resetDriveClient();
    const res = await get("/videos");
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "drive_not_connected", message: expect.stringContaining("Video Workflow → Google Drive") });
  });
});

describe("changing someone's role in the Users tab", () => {
  const patch = (p: string, body: unknown) => fetch(`${base}${p}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  async function addMember(email: string, nerve: { role: string; team: string | null }) {
    hooks.nerveAccounts.set(email, { id: `n-${email}`, ...nerve });
    const res = await post("/users", { name: "FIX member", email, role: "editor" });
    return (await res.json()).user as { id: string };
  }

  it("changes the Nerve account, which is what the person actually is", async () => {
    // It used to change only the workflow record, which requireVideoUser
    // reset from the untouched Nerve role on the person's next request.
    actingRole = "outreach_manager";
    const member = await addMember("fix.member@a.com", { role: "outreach_editor", team: "outreach" });
    const res = await patch(`/users/${member.id}`, { role: "publisher" });
    expect(res.status).toBe(200);
    expect((await res.json()).user.role).toBe("publisher");
    expect(hooks.nerveAccounts.get("fix.member@a.com")).toMatchObject({ role: "outreach_publisher", team: "outreach" });
  });

  it("changes nothing anywhere when Nerve's rules refuse", async () => {
    actingRole = "outreach_manager";
    const member = await addMember("fix.designer@a.com", { role: "user", team: "branding" });
    const res = await patch(`/users/${member.id}`, { role: "publisher" });
    expect(res.status).toBe(403);
    expect((await res.json()).message).toMatch(/own team/);
    expect(hooks.nerveAccounts.get("fix.designer@a.com")?.role).toBe("user");
    const listed = (await (await get("/users")).json()).users as Array<{ id: string; role: string }>;
    expect(listed.find(u => u.id === member.id)?.role).toBe("editor");
  });

  it("still keeps a Manager from making anyone an Admin", async () => {
    actingRole = "outreach_manager";
    const member = await addMember("fix.climber@a.com", { role: "outreach_editor", team: "outreach" });
    expect((await patch(`/users/${member.id}`, { role: "admin" })).status).toBe(403);
    expect(hooks.nerveAccounts.get("fix.climber@a.com")?.role).toBe("outreach_editor");
  });
});

describe("campaigns and the videos they hold", () => {
  const patch = (p: string, body: unknown) => fetch(`${base}${p}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const editor = {
    id: "u-fix-editor", name: "FIX editor", email: "fix.editor@a.com", role: "editor" as const,
  };
  async function uploadTo(campaignId: string) {
    const file = path.join(tmpRoot, `${Math.random().toString(36).slice(2)}.mp4`);
    await fs.writeFile(file, "video-bytes", "utf8");
    return uploadVideo({
      editor, client: "", campaignId, editorTitle: "t", caption: "c",
      localPath: file, originalName: "clip.mp4", mimeType: "video/mp4", sizeBytes: 11,
    });
  }

  it("lists how many videos each campaign holds, whatever their status", async () => {
    actingRole = "outreach_manager";
    const { campaign } = await (await post("/campaigns", {
      name: "FIX campaign", startDate: "2027-01-01", endDate: "2027-03-31",
    })).json();
    await uploadTo(campaign.id);
    const listed = (await (await get("/campaigns")).json()).campaigns as Array<{ id: string; videoCount: number; progress: { published: number } }>;
    // Nothing published, so judging by progress alone said it could be deleted.
    expect(listed.find(c => c.id === campaign.id)).toMatchObject({ videoCount: 1, progress: { published: 0 } });
    const del = await fetch(`${base}/campaigns/${campaign.id}`, { method: "DELETE" });
    expect(del.status).toBe(409);
    expect((await del.json()).message).toMatch(/Set its status to Completed/);
  });

  it("refuses a campaign date that does not exist", async () => {
    actingRole = "outreach_manager";
    const res = await post("/campaigns", { name: "FIX bad date", startDate: "2026-02-31", endDate: "2026-03-05" });
    expect(res.status).toBe(400);
    expect((await res.json()).message).toBe("A valid start date is required.");
  });

  it("carries a rename onto the campaign's videos", async () => {
    actingRole = "outreach_manager";
    const { campaign } = await (await post("/campaigns", {
      name: "FIX campaign", startDate: "2027-01-01", endDate: "2027-03-31",
    })).json();
    const video = await uploadTo(campaign.id);
    expect((await patch(`/campaigns/${campaign.id}`, { name: "FIX campaign renamed" })).status).toBe(200);
    expect((await listVideos()).find(v => v.id === video.id)?.client).toBe("FIX campaign renamed");
  });

  it("keeps typed-in videos a campaign owns by name when it is renamed", async () => {
    actingRole = "outreach_manager";
    const file = path.join(tmpRoot, "typed.mp4");
    await fs.writeFile(file, "video-bytes", "utf8");
    // Uploaded before the campaign existed, so it holds the name and no id.
    const typed = await uploadVideo({
      editor, client: "FIX legacy", editorTitle: "t", caption: "c",
      localPath: file, originalName: "clip.mp4", mimeType: "video/mp4", sizeBytes: 11,
    });
    const { campaign } = await (await post("/campaigns", {
      name: "FIX legacy", startDate: "2027-01-01", endDate: "2027-03-31",
    })).json();
    await uploadTo(campaign.id);
    const count = async () => ((await (await get("/campaigns")).json()).campaigns as Array<{ id: string; videoCount: number }>)
      .find(c => c.id === campaign.id)?.videoCount;
    expect(await count()).toBe(2);

    expect((await patch(`/campaigns/${campaign.id}`, { name: "FIX legacy renamed" })).status).toBe(200);
    // Used to drop to 1, the typed-in video left behind under the old name.
    expect(await count()).toBe(2);
    expect((await listVideos()).find(v => v.id === typed.id))
      .toMatchObject({ campaignId: campaign.id, client: "FIX legacy renamed" });
  });
});

describe("config", () => {
  it("offers direct upload only on real Google Drive", async () => {
    const body = await (await get("/config")).json();
    expect(body).toMatchObject({ configured: true, local: true, source: "local", directUpload: false });
  });
});

describe("uploading through the server", () => {
  const form = (name: string, type: string, bytes = "video-bytes") => {
    const f = new FormData();
    f.set("video", new Blob([bytes], { type }), name);
    f.set("client", "VLF 2027");
    f.set("title", "Opening");
    f.set("caption", "Come along");
    f.set("socialPageIds", "");
    return f;
  };
  const upload = (f: FormData) => fetch(`${base}/videos`, { method: "POST", body: f });

  it("refuses a role that cannot upload before reading the file", async () => {
    actingRole = "outreach_publisher";
    const res = await upload(form("v.mp4", "video/mp4")).catch(() => null);
    // The refusal may close the connection mid-body; either way nothing is staged.
    if (res) expect(res.status).toBe(403);
    expect(await stagedFiles()).toEqual([]);
  });

  it("keeps reading a refused body before closing, so the refusal is not lost to a reset", async () => {
    /* Without a buffering proxy in front, Node closing the socket while the
       browser is still sending turns into a TCP reset, and the browser shows
       a network error instead of the refusal. So the server must keep reading
       (and discarding) the body after answering, and close only once it has
       all arrived. Raw socket, because fetch hides when the close happens. */
    actingRole = "outreach_publisher";
    const total = 4 * 1024 * 1024;
    const sock = net.connect((server.address() as AddressInfo).port, "127.0.0.1");
    await once(sock, "connect");
    sock.on("error", () => {});
    let received = "";
    sock.on("data", d => { received += d.toString("latin1"); });
    let sent = 0;
    let closedAfter = -1;
    const closed = new Promise<void>(resolve => sock.on("close", () => { closedAfter = sent; resolve(); }));
    const send = (n: number) => new Promise<void>(resolve => { sock.write(Buffer.alloc(n), () => resolve()); sent += n; });

    sock.write(`POST /api/outreach/video/videos HTTP/1.1\r\nHost: x\r\nContent-Type: application/octet-stream\r\nContent-Length: ${total}\r\n\r\n`);
    await send(64 * 1024);
    await vi.waitFor(() => expect(received).toContain("Your role cannot perform that action."));
    expect(received).toMatch(/^HTTP\/1\.1 403/);
    expect(received.toLowerCase()).toContain("connection: close");

    // The answer is in; the rest of the body must still be accepted.
    while (sent < total && closedAfter < 0) await send(Math.min(256 * 1024, total - sent));
    await closed;
    expect(closedAfter).toBe(total);
    expect(await stagedFiles()).toEqual([]);
  });

  it("answers a file over the limit with 413 JSON", async () => {
    const res = await upload(form("v.mp4", "video/mp4", "x".repeat(200)));
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ message: "That video is larger than 2 GB." });
    expect(await stagedFiles()).toEqual([]);
  });

  it("answers a file that is not a video with 400 naming the accepted types", async () => {
    const res = await upload(form("notes.pdf", "application/pdf"));
    expect(res.status).toBe(400);
    expect((await res.json()).message).toMatch(/MP4, MOV/);
  });

  it("accepts a video the browser could not type, and never leaves the staged file behind", async () => {
    const res = await upload(form("take.mkv", "application/octet-stream"));
    expect(res.status).toBe(201);
    const { video } = await res.json();
    expect(video).toMatchObject({ title: "VLF 2027 - Video 1", mimeType: "video/x-matroska" });
    expect(await stagedFiles()).toEqual([]);
  });

  it("deletes the staged file when the upload then fails", async () => {
    const f = form("v.mp4", "video/mp4");
    f.set("caption", " ");
    const res = await upload(f);
    expect(res.status).toBe(400);
    expect(await stagedFiles()).toEqual([]);
  });
});

describe("direct upload endpoints", () => {
  const session = {
    fileName: "v.mp4", mimeType: "video/mp4", sizeBytes: 11, client: "VLF 2027", campaignId: null,
    socialPageIds: [], title: "Opening", caption: "Come along", platform: null, notes: null, tags: [],
  };

  it("answers proxy on the local adapter", async () => {
    const res = await post("/videos/upload-session", session);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ mode: "proxy" });
  });

  it("refuses a non-video or an oversized file up front", async () => {
    expect((await post("/videos/upload-session", { ...session, fileName: "a.pdf", mimeType: "application/pdf" })).status).toBe(400);
    expect((await post("/videos/upload-session", { ...session, sizeBytes: 3 * 1024 ** 3 })).status).toBe(413);
  });

  it("answers an unknown session with 404 JSON", async () => {
    const res = await post("/videos/complete", { sessionId: "nope", fileId: "x" });
    expect(res.status).toBe(404);
    expect((await res.json()).message).toMatch(/expired or was not found/);
  });

  it("cancels with 204, known session or not", async () => {
    expect((await post("/videos/upload-session/nope/cancel", {})).status).toBe(204);
  });

  it("is for editors and admins only", async () => {
    actingRole = "outreach_publisher";
    expect((await post("/videos/upload-session", session)).status).toBe(403);
  });
});

describe("the origin a direct upload is opened for", () => {
  it("is the page's own origin when that is Nerve's", () => {
    expect(uploadOrigin("https://nerve.example", "https://nerve.example/", "production")).toBe("https://nerve.example");
  });
  it("accepts localhost only outside production", () => {
    expect(uploadOrigin("http://localhost:5173", "https://nerve.example", "development")).toBe("http://localhost:5173");
    expect(uploadOrigin("http://localhost:5173", "https://nerve.example", "production")).toBe("https://nerve.example");
  });
  it("falls back to APP_BASE_URL for anything else", () => {
    expect(uploadOrigin("https://evil.example", "https://nerve.example", "development")).toBe("https://nerve.example");
    expect(uploadOrigin(undefined, "https://nerve.example/app", "production")).toBe("https://nerve.example");
  });
});

describe("the staging sweep", () => {
  it("removes staged files older than six hours and keeps fresh ones", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nerve-sweep-"));
    try {
      await fs.writeFile(path.join(dir, "old.mp4"), "x");
      await fs.writeFile(path.join(dir, "new.mp4"), "x");
      const sevenHoursAgo = new Date(Date.now() - 7 * 60 * 60 * 1000);
      await fs.utimes(path.join(dir, "old.mp4"), sevenHoursAgo, sevenHoursAgo);
      expect(await sweepVideoStaging(dir)).toBe(1);
      expect(await fs.readdir(dir)).toEqual(["new.mp4"]);
      expect(await sweepVideoStaging(path.join(dir, "missing"))).toBe(0);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
