/**
 * HTTP surface for the Outreach video workflow.
 *
 * §25 is the governing section here: every request verifies the authenticated
 * user, checks they are registered and active, and checks the action is one
 * their role may perform — on the server, not just in the UI. In particular
 * "Editors can never retrieve social media analytics data through the API, even
 * by direct request" (§25, §8.2) is enforced by serving editors a deliberately
 * reduced page shape, rather than by hiding fields in the frontend.
 */
import { randomUUID } from "node:crypto";
import { promises as fsp } from "node:fs";
import path from "node:path";
import type express from "express";
import type multer from "multer";
import { Readable } from "node:stream";

import { config } from "../config.js";
import {
  driveIsConfigured, driveIsLocal, driveSource, ensureDriveResolved, getDriveClient,
  resetAppDriveConnection, DriveAuthError,
} from "./drive-client.js";
import {
  cachedDriveHealth, driveErrorResponse, probeDrive, resetDriveHealth,
  DRIVE_NOT_CONNECTED_MESSAGE, UNKNOWN_HEALTH,
} from "./drive-errors.js";
import {
  cancelDirectUpload, completeDirectUpload, startDirectUpload,
  UploadSessionNotFoundError, UploadSessionNotYoursError, UploadVerificationError,
} from "./upload-sessions.js";
import { listUserCapabilities } from "../db.js";
import {
  completeOutreachDriveConnect, disconnectOutreachDrive, outreachDriveAuthUrl, outreachDriveStatus,
  saveOutreachDriveClient, setExpectedAccount, useOutreachDriveFolder, verifyOutreachDriveState,
  OutreachDriveError,
} from "./drive-connection.js";
import { resetForDriveChange } from "./drive-store.js";
import {
  campaignProgress, createCampaign, deleteCampaign, getCampaign, listCampaigns, updateCampaign,
  CampaignExistsError, CampaignInUseError, CampaignNotFoundError, type CampaignInput,
} from "./campaigns.js";
import type { OvCapability } from "../capabilities.js";
import {
  addUser, deleteUser, findUserByEmail, findUserById, listActiveEditors, listUsers,
  mayAssignRole, mayModifyUserWithRole,
  setUserActive, setUserRole, touchLastActivity, videoRoleForNerveRole,
  UserExistsError,
} from "./users.js";
import {
  getVideo, listVideos, publishVideo, publishingQueue, setLiveUrls,
  approveVideo, rejectVideo, startRevision, scheduleVideo, reviewQueue, resyncAllToDrive,
  submitVideo, updateCaption, uploadVideo, acceptedVideoType, checkVideoFile,
  InvalidTransitionError, NotYourVideoError, VideoNotFoundError, VideoFileRejectedError,
  ACCEPTED_VIDEO_TYPES_LABEL, VIDEO_MIME_ALLOWLIST, type UploadDetails,
} from "./videos.js";
import { socialPagesForRole } from "./social-pages.js";
import {
  assignEvent, completeEvent, createEvent, eventCounts, getEvent, listEvents,
  todoFor, updateEventDetails, EventNotFoundError, EventNotOpenError, NotYourEventError,
} from "./events.js";
import { listNotifications, markRead, notify } from "./notifications.js";
import { editorVideoLog, workflowKpis } from "./reports.js";
import { filterOptions, search } from "./search.js";
import { activityActors, activityFeed } from "./activity.js";
import { VIDEO_ROLES, type VideoRole, type VideoUser } from "./types.js";

interface CurrentUser { id: string; role: string; team: string | null; full_name?: string; email?: string }

interface Handlers {
  asyncHandler: (fn: (req: express.Request, res: express.Response, next: express.NextFunction) => Promise<unknown>) =>
    (req: express.Request, res: express.Response, next: express.NextFunction) => void;
  sendError: (res: express.Response, status: number, message: string) => void;
  getSingleParam: (v: string | string[]) => string;
  videoUpload: multer.Multer;
  /** Where multer stages videos; swept for leftovers. Defaults to index.ts's. */
  videoStagingDir?: string;
}

export function registerOutreachVideoApi(app: express.Express, h: Handlers) {
  const { asyncHandler, sendError, getSingleParam, videoUpload } = h;
  const P = "/api/outreach/video";
  startStagingSweep(h.videoStagingDir ?? path.resolve("uploads/outreach-video"));

  /**
   * Answers a Drive failure with the JSON the client understands (see
   * drive-errors.ts) and returns true; false when `err` is not one.
   *
   * A dead grant also drops the cached app connection and health, so the
   * Drive dialog's next status check probes afresh and a reconnect is picked
   * up at once rather than after the cache would have expired.
   */
  function sendDriveError(res: express.Response, err: unknown): boolean {
    const answer = driveErrorResponse(err);
    if (!answer) return false;
    if (err instanceof DriveAuthError) {
      console.error("Outreach video: Google refused the Drive credentials —", err.message);
      resetAppDriveConnection();
      resetDriveHealth();
    } else if (answer.code === "drive_unavailable") {
      console.error("Outreach video: Google Drive did not answer —", err instanceof Error ? err.message : err);
    }
    res.status(answer.status).json({ message: answer.message, code: answer.code });
    return true;
  }

  /**
   * Resolves the acting user's workflow identity (§5).
   *
   * Their Nerve role is what grants access — an admin assigning `outreach_editor`
   * IS the §4.3 act of registering them — so a first-time user is registered in
   * the Drive store on the spot. A record that exists but is disabled or deleted
   * is refused, which is what §5's "disabled accounts receive an access-denied
   * message" asks for.
   */
  async function requireVideoUser(res: express.Response): Promise<VideoUser | null> {
    const u = res.locals.currentUser as CurrentUser;
    const role = videoRoleForNerveRole(u?.role ?? "");
    if (!role) { sendError(res, 403, "This area is for the video workflow team only."); return null; }
    // Picks up a Drive an Admin connected in the app, if the env names none.
    await ensureDriveResolved();
    if (!driveIsConfigured()) {
      /* Say who can fix it and where. "Ask an administrator" sent people
         looking for an outreach admin, who cannot reach the setting at all. */
      res.status(503).json({ message: DRIVE_NOT_CONNECTED_MESSAGE, code: "drive_not_connected" });
      return null;
    }

    /* Everything below reads the users store, which lives in Drive. With a
       dead refresh token this is where every request used to die with a bare
       500 — so a Drive failure is answered here, saying what is wrong and who
       can fix it, and the route goes no further. */
    try {
      return await resolveVideoUser(res, u, role);
    } catch (err) {
      if (sendDriveError(res, err)) return null;
      throw err;
    }
  }

  /** requireVideoUser's Drive half: find, refuse, or register the person. */
  async function resolveVideoUser(res: express.Response, u: CurrentUser, role: VideoRole): Promise<VideoUser | null> {
    const email = (u.email ?? "").trim().toLowerCase();
    const existing = await findUserByEmail(email);
    if (existing?.deletedAt) { sendError(res, 403, "This account no longer has access to the video workflow."); return null; }
    if (existing && !existing.active) { sendError(res, 403, "This account has been disabled."); return null; }

    if (existing) {
      // Keep the workflow role in step with the Nerve role, which is the
      // authority (§4.4 "takes effect on the user's next authenticated session").
      if (existing.role !== role) existing.role = role;
      void touchLastActivity(existing.id);
      return existing;
    }
    /* First authenticated request for someone who has a Nerve account but no
       workflow record yet. A page load fires several of these at once, and
       they all reach this line together: each one looked, each one found
       nothing, and each one now tries to create the same person. Exactly one
       wins and the rest are told the user already exists — which is not an
       error here, it is the answer. Re-read and carry on.

       This became reachable in normal use once the outreach manager could
       create accounts directly: before that, people were pre-registered in
       the workflow table and arrived with a record already waiting. */
    try {
      const created = await addUser({ name: u.full_name ?? email, email, role });
      // Someone whose account was made elsewhere has just joined the workflow.
      await announceNewMember(created, null);
      return created;
    } catch (err) {
      if (err instanceof UserExistsError) {
        const raced = await findUserByEmail(email);
        if (raced) return raced;
      }
      throw err;
    }
  }

  /**
   * §14 Admin — "new user creation". Every Admin hears about a new member of
   * the team, except whoever added them. Never fails the add.
   */
  async function announceNewMember(member: VideoUser, addedBy: VideoUser | null): Promise<void> {
    try {
      // Never the person who added them, and never the member themselves —
      // an Admin's own first sign-in is not news to them.
      const admins = (await listUsers()).filter(u =>
        u.role === "admin" && u.active && !u.deletedAt && u.id !== addedBy?.id && u.id !== member.id);
      const label = { admin: "Admin", manager: "Manager", editor: "Editor", publisher: "Publisher" }[member.role];
      await notify(admins.map(a => a.id), "user_created", null,
        addedBy ? `${member.name} (${label}) was added by ${addedBy.name}.` : `${member.name} (${label}) signed in for the first time.`);
    } catch { /* a notice never fails the action it reports */ }
  }

  function requireRole(res: express.Response, user: VideoUser, allowed: VideoRole[]): boolean {
    if (allowed.includes(user.role)) return true;
    sendError(res, 403, "Your role cannot perform that action.");
    return false;
  }

  /**
   * A role-gated READ that a granted tab also opens.
   *
   * The outreach manager switches tabs on per person (PRD §6), and a tab that
   * opens in the browser while its data is refused by the API is not a
   * permission — it is an empty screen. So the capability is checked here too,
   * against the same key the route guard uses.
   *
   * Deliberately reads only. A tab grant says what someone may SEE; it does
   * not say they may act. Who publishes, who assigns an event and who
   * administers the team stay role questions, answered by requireRole as
   * before — so granting an editor the publishing queue shows them the queue
   * without making them a publisher.
   */
  async function requireRoleOrGrant(
    res: express.Response, user: VideoUser, allowed: VideoRole[], capability: OvCapability,
  ): Promise<boolean> {
    if (allowed.includes(user.role)) return true;
    const u = res.locals.currentUser as CurrentUser;
    const held = await listUserCapabilities(u.id);
    if (held.includes(capability)) return true;
    sendError(res, 403, "Your role cannot perform that action.");
    return false;
  }

  /**
   * Applies the two escalation rules (mayAssignRole / mayModifyUserWithRole)
   * to one request, answering with the right message when either refuses.
   * Returns true when the action may proceed.
   */
  async function managerMayActOn(
    res: express.Response, actor: VideoUser, targetId: string | null, targetRole: VideoRole | null,
  ): Promise<boolean> {
    if (actor.role === "admin") return true;
    if (targetRole !== null && !mayAssignRole(actor.role, targetRole)) {
      sendError(res, 403, "A Manager can assign Editor, Publisher or Manager — not Admin.");
      return false;
    }
    if (targetId !== null) {
      const target = await findUserById(targetId);
      if (target && !mayModifyUserWithRole(actor.role, target.role)) {
        sendError(res, 403, "A Manager cannot modify an Admin account.");
        return false;
      }
    }
    return true;
  }

  /**
   * Answers one of this module's own errors — a Drive failure or a typed
   * domain error — with its proper status and returns true; false for
   * anything else. Shared by `fail` and the module's error middleware, so an
   * error answers the same whether a handler caught it or it escaped.
   */
  function sendKnownError(res: express.Response, err: unknown): boolean {
    if (sendDriveError(res, err)) return true;
    const status = knownErrorStatus(err);
    if (status === null) return false;
    sendError(res, status, (err as Error).message);
    return true;
  }

  /** Maps a domain error onto the right status, so the UI can say something useful. */
  function fail(res: express.Response, err: unknown): void {
    if (sendKnownError(res, err)) return;
    const msg = err instanceof Error ? err.message : "Something went wrong.";
    // §29 — a Drive problem is temporary and retryable; say so rather than
    // reporting a generic failure the user can't act on.
    const isDrive = /drive|google|upload/i.test(msg);
    return sendError(res, isDrive ? 502 : 400, msg);
  }

  /** The status for one of this module's typed errors, or null. */
  function knownErrorStatus(err: unknown): number | null {
    if (err instanceof VideoFileRejectedError) return err.status;
    if (err instanceof UploadSessionNotFoundError) return 404;
    if (err instanceof UploadSessionNotYoursError) return 403;
    if (err instanceof UploadVerificationError) return 400;
    if (err instanceof VideoNotFoundError) return 404;
    if (err instanceof NotYourVideoError) return 403;
    if (err instanceof EventNotFoundError) return 404;
    if (err instanceof NotYourEventError) return 403;
    if (err instanceof EventNotOpenError) return 409;
    if (err instanceof UserExistsError) return 409;
    if (err instanceof CampaignNotFoundError) return 404;
    if (err instanceof CampaignExistsError) return 409;
    if (err instanceof CampaignInUseError) return 409;
    if (err instanceof InvalidTransitionError) return 409;
    return null;
  }

  // ── Setup state ──────────────────────────────────────────────────────────

  app.get(`${P}/config`, asyncHandler(async (_req, res) => {
    const u = res.locals.currentUser as CurrentUser;
    const role = videoRoleForNerveRole(u?.role ?? "");
    if (!role) return sendError(res, 403, "This area is for the video workflow team only.");
    await ensureDriveResolved();
    const source = driveSource();
    res.json({
      configured: driveIsConfigured(), local: driveIsLocal(), source, role,
      /* Real Google Drive can take the bytes from the browser directly (see
         upload-sessions.ts); the local adapter has no URL a browser could
         reach, so there the file goes through the server. */
      directUpload: source === "env" || source === "app",
    });
  }));

  // ── Videos ───────────────────────────────────────────────────────────────

  app.get(`${P}/videos`, asyncHandler(async (req, res) => {
    const user = await requireVideoUser(res); if (!user) return;
    const q = req.query as Record<string, string>;
    // §8 — an editor's lists are their own work; everyone else sees the
    // department's (§27 gives Manager/Admin "All Videos").
    const editorId = user.role === "editor" ? user.id : (q.editor_id || undefined);
    const videos = await listVideos({
      editorId,
      status: (q.status as never) || undefined,
      client: q.client || undefined,
    });
    res.json({ videos });
  }));

  app.get(`${P}/videos/:id`, asyncHandler(async (req, res) => {
    const user = await requireVideoUser(res); if (!user) return;
    try {
      const video = await getVideo(getSingleParam(req.params.id));
      if (user.role === "editor" && video.editorId !== user.id) {
        return sendError(res, 403, "That video belongs to another editor.");
      }
      res.json({ video });
    } catch (err) { fail(res, err); }
  }));

  /**
   * §3 — the handles of the pages the editor picked, so the §10 caption file
   * can name them. Read from Postgres (the outreach department's own page
   * list); a hiccup there costs the names, never the upload.
   */
  async function pageNamesFor(pageIds: string[]): Promise<string[]> {
    if (!pageIds.length) return [];
    try {
      const { listPages } = await import("../outreach-db.js");
      const byId = new Map((await listPages()).map(pg => [pg.id, pg.handle]));
      return pageIds.map(id => byId.get(id)).filter((h): h is string => !!h);
    } catch {
      return [];
    }
  }

  /** A list field: a JSON array, or the comma-separated text a multipart form sends. */
  const listField = (v: unknown): string[] =>
    (Array.isArray(v) ? v.map(String) : typeof v === "string" ? v.split(",") : [])
      .map(x => x.trim()).filter(Boolean);
  const textOrNull = (v: unknown): string | null => (v === undefined || v === null ? null : String(v));

  /** The upload's details from a request body — the same fields for both paths. */
  async function uploadDetailsFrom(
    user: VideoUser, b: Record<string, unknown>,
    file: { originalName: string; mimeType: string; sizeBytes: number },
  ): Promise<UploadDetails> {
    const socialPageIds = listField(b.socialPageIds);
    return {
      editor: user,
      client: String(b.client ?? ""),
      /* §17 — when the editor picks a real campaign, it decides the name,
         the Drive folders and the file naming. Absent on an upload that
         only carries typed-in text, which is the older path. */
      campaignId: b.campaignId ? String(b.campaignId) : null,
      socialPageIds,
      pageNames: await pageNamesFor(socialPageIds),
      editorTitle: String(b.title ?? ""),
      caption: String(b.caption ?? ""),
      originalName: file.originalName,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes,
      platform: textOrNull(b.platform),
      notes: textOrNull(b.notes),
      tags: listField(b.tags),
    };
  }

  /**
   * Runs multer for the one "video" field and answers its refusals as JSON:
   * too large → 413, not a video → 400 naming what is accepted. Resolves true
   * when the file (if any) is on disk and the route should carry on.
   */
  function receiveVideo(req: express.Request, res: express.Response): Promise<boolean> {
    return new Promise(resolve => {
      videoUpload.single("video")(req, res, (err?: unknown) => {
        if (!err) return resolve(true);
        const e = err as { name?: string; code?: string; message?: string };
        if (e.code === "LIMIT_FILE_SIZE") sendError(res, 413, "That video is larger than 2 GB.");
        else if (e.name === "MulterError") sendError(res, 400, e.message || "The upload could not be read.");
        else if (/video/i.test(e.message ?? "")) {
          sendError(res, 400, `That file is not a video we can accept. Upload ${ACCEPTED_VIDEO_TYPES_LABEL}.`);
        } else sendError(res, 400, `The upload did not arrive complete (${e.message ?? "unknown error"}). Please try again.`);
        resolve(false);
      });
    });
  }

  /**
   * §9 — upload through the server (the "proxy" path). Multipart: the file
   * plus the required and optional fields. Used where Drive cannot take the
   * bytes from the browser directly (local Drive, or a browser that could not
   * reach Google); see upload-session below for the direct path.
   *
   * Who may upload is settled BEFORE the body is read: otherwise a publisher
   * or a disconnected Drive would only be refused after a 2 GB file had
   * streamed onto the server's disk. Until the file has been taken, refusals
   * also close the connection, so the browser stops sending.
   */
  app.post(`${P}/videos`, asyncHandler(async (req, res) => {
    res.setHeader("Connection", "close");
    const release = holdCloseUntilDrained(req, res);
    const user = await requireVideoUser(res); if (!user) return;
    if (!requireRole(res, user, ["editor", "admin"])) return;
    if (!await receiveVideo(req, res)) return;
    release();
    res.removeHeader("Connection");

    const file = req.file;
    try {
      if (!file) return sendError(res, 400, "A video file is required.");
      const details = await uploadDetailsFrom(user, req.body as Record<string, unknown>, {
        originalName: file.originalname, mimeType: file.mimetype, sizeBytes: file.size,
      });
      const video = await uploadVideo({ ...details, localPath: file.path });
      res.status(201).json({ video });
    } catch (err) {
      fail(res, err);
    } finally {
      // The bytes now live in Drive (or the upload failed outright); either way
      // the staged file has no further use, whichever way this ended.
      if (file) await fsp.unlink(file.path).catch(() => {});
    }
  }));

  /**
   * Direct upload, step 1 (see upload-sessions.ts): the browser describes the
   * file; the answer is a Google upload URL to send it to, or `proxy` when
   * this Drive cannot take it from the browser.
   */
  app.post(`${P}/videos/upload-session`, asyncHandler(async (req, res) => {
    const user = await requireVideoUser(res); if (!user) return;
    if (!requireRole(res, user, ["editor", "admin"])) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    try {
      const fileName = String(b.fileName ?? "");
      const sizeBytes = Number(b.sizeBytes);
      // Refused before anything is reserved, whichever path the file then takes.
      const mimeType = checkVideoFile(fileName, String(b.mimeType ?? ""), sizeBytes);
      const details = await uploadDetailsFrom(user, b, { originalName: fileName, mimeType, sizeBytes });
      res.json(await startDirectUpload(details, uploadOrigin(req.headers.origin, config.appBaseUrl, process.env.NODE_ENV)));
    } catch (err) { fail(res, err); }
  }));

  /** Direct upload, step 3: the bytes are in Drive; record the video. */
  app.post(`${P}/videos/complete`, asyncHandler(async (req, res) => {
    const user = await requireVideoUser(res); if (!user) return;
    if (!requireRole(res, user, ["editor", "admin"])) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const sessionId = String(b.sessionId ?? "");
    if (!sessionId) return sendError(res, 400, "The upload session is missing.");
    try {
      res.status(201).json({ video: await completeDirectUpload(sessionId, user.id, String(b.fileId ?? "")) });
    } catch (err) { fail(res, err); }
  }));

  /** The browser gave up on a direct upload; forget it. */
  app.post(`${P}/videos/upload-session/:sessionId/cancel`, asyncHandler(async (req, res) => {
    const user = await requireVideoUser(res); if (!user) return;
    cancelDirectUpload(getSingleParam(req.params.sessionId), user.id);
    res.status(204).end();
  }));

  app.patch(`${P}/videos/:id/caption`, asyncHandler(async (req, res) => {
    const user = await requireVideoUser(res); if (!user) return;
    if (!requireRole(res, user, ["editor", "admin"])) return;
    const caption = String((req.body as Record<string, unknown>).caption ?? "").trim();
    if (!caption) return sendError(res, 400, "A caption is required.");
    try {
      res.json({ video: await updateCaption(getSingleParam(req.params.id), caption, user) });
    } catch (err) { fail(res, err); }
  }));

  app.post(`${P}/videos/:id/submit`, asyncHandler(async (req, res) => {
    const user = await requireVideoUser(res); if (!user) return;
    if (!requireRole(res, user, ["editor", "admin"])) return;
    try {
      res.json({ video: await submitVideo(getSingleParam(req.params.id), user) });
    } catch (err) { fail(res, err); }
  }));

  // ── Publishing (§14, §15) ────────────────────────────────────────────────

  // ── §11 review loop ──────────────────────────────────────────────────────

  /** Everything waiting on a reviewer. Managers and admins review. */
  app.get(`${P}/review-queue`, asyncHandler(async (_req, res) => {
    const user = await requireVideoUser(res); if (!user) return;
    if (!await requireRoleOrGrant(res, user, ["manager", "admin"], "outreach:review")) return;
    res.json({ videos: await reviewQueue() });
  }));

  app.post(`${P}/videos/:id/approve`, asyncHandler(async (req, res) => {
    const user = await requireVideoUser(res); if (!user) return;
    if (!requireRole(res, user, ["manager", "admin"])) return;
    const note = String((req.body as Record<string, unknown>)?.note ?? "");
    try {
      res.json({ video: await approveVideo(getSingleParam(req.params.id), user, note) });
    } catch (err) { fail(res, err); }
  }));

  /** §11 — the reason is required; an editor cannot act on silence. */
  app.post(`${P}/videos/:id/reject`, asyncHandler(async (req, res) => {
    const user = await requireVideoUser(res); if (!user) return;
    if (!requireRole(res, user, ["manager", "admin"])) return;
    const reason = String((req.body as Record<string, unknown>)?.reason ?? "").trim();
    if (!reason) return sendError(res, 400, "A reason is required when rejecting content.");
    try {
      res.json({ video: await rejectVideo(getSingleParam(req.params.id), user, reason) });
    } catch (err) { fail(res, err); }
  }));

  /** §11 — the editor picks rejected work back up. */
  app.post(`${P}/videos/:id/revise`, asyncHandler(async (req, res) => {
    const user = await requireVideoUser(res); if (!user) return;
    if (!requireRole(res, user, ["editor", "admin"])) return;
    try {
      res.json({ video: await startRevision(getSingleParam(req.params.id), user) });
    } catch (err) { fail(res, err); }
  }));

  /** §4 — the Publisher records when approved content is due to go out. */
  app.post(`${P}/videos/:id/schedule`, asyncHandler(async (req, res) => {
    const user = await requireVideoUser(res); if (!user) return;
    if (!requireRole(res, user, ["publisher", "admin"])) return;
    const when = String((req.body as Record<string, unknown>)?.scheduledFor ?? "").trim();
    if (!when) return sendError(res, 400, "A posting date and time is required.");
    try {
      res.json({ video: await scheduleVideo(getSingleParam(req.params.id), user, when) });
    } catch (err) { fail(res, err); }
  }));

  app.get(`${P}/queue`, asyncHandler(async (_req, res) => {
    const user = await requireVideoUser(res); if (!user) return;
    if (!await requireRoleOrGrant(res, user, ["publisher", "manager", "admin"], "outreach:queue")) return;
    res.json({ videos: await publishingQueue() });
  }));

  app.post(`${P}/videos/:id/publish`, asyncHandler(async (req, res) => {
    const user = await requireVideoUser(res); if (!user) return;
    if (!requireRole(res, user, ["publisher", "admin"])) return;
    const body = req.body as { live_urls?: Record<string, string>; remark?: string };
    try {
      const video = await publishVideo(
        getSingleParam(req.params.id), user, body.live_urls ?? {}, String(body.remark ?? ""));
      res.json({ video });
    } catch (err) { fail(res, err); }
  }));

  app.patch(`${P}/videos/:id/live-urls`, asyncHandler(async (req, res) => {
    const user = await requireVideoUser(res); if (!user) return;
    if (!requireRole(res, user, ["publisher", "admin"])) return;
    const body = req.body as { live_urls?: Record<string, string> };
    try {
      res.json({ video: await setLiveUrls(getSingleParam(req.params.id), user, body.live_urls ?? {}) });
    } catch (err) { fail(res, err); }
  }));

  // ── Preview + download (§10, §14) ────────────────────────────────────────

  /**
   * Streams the video through the API rather than exposing a Drive link, so
   * §25's "every API request must verify the authenticated user" still holds for
   * the bytes themselves. Range headers pass straight through so the player can
   * seek.
   */
  async function streamVideo(req: express.Request, res: express.Response, asAttachment: boolean) {
    const user = await requireVideoUser(res); if (!user) return;
    try {
      const video = await getVideo(getSingleParam(req.params.id));
      if (user.role === "editor" && video.editorId !== user.id) {
        return sendError(res, 403, "That video belongs to another editor.");
      }
      const { client } = getDriveClient();
      const range = req.headers.range;
      const upstream = await client.openStream(video.driveFileId, range);

      res.status(upstream.status);
      res.setHeader("Content-Type", video.mimeType || "video/mp4");
      for (const header of ["content-length", "content-range", "accept-ranges"]) {
        const value = upstream.headers.get(header);
        if (value) res.setHeader(header, value);
      }
      if (asAttachment) {
        // Quote the filename: auto-generated names contain spaces.
        res.setHeader("Content-Disposition", `attachment; filename="${video.driveFileName.replace(/"/g, "")}"`);
      }
      if (!upstream.body) return res.end();
      Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]).pipe(res);
    } catch (err) { fail(res, err); }
  }

  app.get(`${P}/videos/:id/stream`, asyncHandler(async (req, res) => { await streamVideo(req, res, false); }));
  app.get(`${P}/videos/:id/download`, asyncHandler(async (req, res) => { await streamVideo(req, res, true); }));

  // ── Events (§11, §12) ────────────────────────────────────────────────────

  app.get(`${P}/events`, asyncHandler(async (req, res) => {
    const user = await requireVideoUser(res); if (!user) return;
    const q = req.query as Record<string, string>;
    // §8.1 — an editor's view of the calendar is their own To-Do List.
    if (user.role === "editor") return res.json({ events: await todoFor(user.id) });
    res.json({
      events: await listEvents({
        editorId: q.editor_id || undefined,
        status: (q.status as never) || undefined,
        from: q.from || undefined,
        to: q.to || undefined,
        client: q.client || undefined,
      }),
    });
  }));

  app.get(`${P}/events/counts`, asyncHandler(async (_req, res) => {
    const user = await requireVideoUser(res); if (!user) return;
    if (!await requireRoleOrGrant(res, user, ["manager", "admin"], "outreach:calendar")) return;
    // The calendar day in the viewer's own terms, not UTC's.
    const today = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    res.json({ counts: await eventCounts(today) });
  }));

  app.get(`${P}/events/:id`, asyncHandler(async (req, res) => {
    const user = await requireVideoUser(res); if (!user) return;
    try {
      const event = await getEvent(getSingleParam(req.params.id));
      if (user.role === "editor" && event.assignedEditorId !== user.id) {
        return sendError(res, 403, "That event is assigned to another editor.");
      }
      res.json({ event });
    } catch (err) { fail(res, err); }
  }));

  /** §11.1 — only a Manager (or Admin) maintains the calendar (§28). */
  app.post(`${P}/events`, asyncHandler(async (req, res) => {
    const user = await requireVideoUser(res); if (!user) return;
    if (!requireRole(res, user, ["manager", "admin"])) return;
    const b = req.body as Record<string, string>;
    try {
      const event = await createEvent(user, {
        title: b.title ?? "", description: b.description ?? "",
        date: b.date ?? "", client: b.client ?? null,
        // §5 — the rest of what a calendar entry shows.
        campaignId: b.campaignId ?? null,
        socialPageId: b.socialPageId ?? null,
        contentType: b.contentType ?? null,
        postingAt: b.postingAt ?? null,
        assignedPublisherId: b.assignedPublisherId ?? null,
      });
      res.status(201).json({ event });
    } catch (err) { fail(res, err); }
  }));

  app.patch(`${P}/events/:id`, asyncHandler(async (req, res) => {
    const user = await requireVideoUser(res); if (!user) return;
    if (!requireRole(res, user, ["manager", "admin"])) return;
    const b = req.body as Record<string, string | null>;
    try {
      res.json({ event: await updateEventDetails(getSingleParam(req.params.id), user, {
        title: b.title as string | undefined,
        description: b.description as string | undefined,
        date: b.date as string | undefined,
        client: b.client as string | null | undefined,
        campaignId: b.campaignId as string | null | undefined,
        socialPageId: b.socialPageId as string | null | undefined,
        contentType: b.contentType as string | null | undefined,
        postingAt: b.postingAt as string | null | undefined,
        assignedPublisherId: b.assignedPublisherId as string | null | undefined,
      }) });
    } catch (err) { fail(res, err); }
  }));

  /** §11.2 / §28 — "Only the Manager (or Admin) can assign or reassign". */
  app.post(`${P}/events/:id/assign`, asyncHandler(async (req, res) => {
    const user = await requireVideoUser(res); if (!user) return;
    if (!requireRole(res, user, ["manager", "admin"])) return;
    const editorId = String((req.body as Record<string, unknown>).editor_id ?? "");
    if (!editorId) return sendError(res, 400, "Pick an editor to assign this event to.");
    try {
      res.json({ event: await assignEvent(getSingleParam(req.params.id), editorId, user) });
    } catch (err) { fail(res, err); }
  }));

  /** §28 — "Editors can mark their own assigned events as Completed." */
  app.post(`${P}/events/:id/complete`, asyncHandler(async (req, res) => {
    const user = await requireVideoUser(res); if (!user) return;
    if (!requireRole(res, user, ["editor", "admin"])) return;
    try {
      res.json({ event: await completeEvent(getSingleParam(req.params.id), user) });
    } catch (err) { fail(res, err); }
  }));

  // ── Notifications (§19) ──────────────────────────────────────────────────

  app.get(`${P}/notifications`, asyncHandler(async (_req, res) => {
    const user = await requireVideoUser(res); if (!user) return;
    const notifications = await listNotifications(user.id);
    res.json({ notifications, unread: notifications.filter(n => !n.readAt).length });
  }));

  app.post(`${P}/notifications/read`, asyncHandler(async (req, res) => {
    const user = await requireVideoUser(res); if (!user) return;
    const ids = (req.body as { ids?: string[] }).ids;
    res.json({ marked: await markRead(user.id, Array.isArray(ids) && ids.length ? ids : undefined) });
  }));

  // ── People ───────────────────────────────────────────────────────────────

  app.get(`${P}/users`, asyncHandler(async (_req, res) => {
    const user = await requireVideoUser(res); if (!user) return;
    if (!await requireRoleOrGrant(res, user, ["admin", "manager"], "outreach:users")) return;
    res.json({ users: await listUsers() });
  }));

  /** §11.2 — the dropdown of active editors a Manager assigns events from. */
  app.get(`${P}/editors`, asyncHandler(async (_req, res) => {
    const user = await requireVideoUser(res); if (!user) return;
    if (!await requireRoleOrGrant(res, user, ["admin", "manager"], "outreach:calendar")) return;
    res.json({ editors: await listActiveEditors() });
  }));

  /**
   * §5 — the publishers an event can be assigned to. Separate from /users,
   * which is the administration list: someone given only the calendar tab
   * must be able to fill in the event form without seeing the whole team.
   */
  app.get(`${P}/publishers`, asyncHandler(async (_req, res) => {
    const user = await requireVideoUser(res); if (!user) return;
    if (!await requireRoleOrGrant(res, user, ["admin", "manager"], "outreach:calendar")) return;
    const users = await listUsers();
    res.json({
      publishers: users
        .filter(u => u.active && !u.deletedAt && u.role === "publisher")
        .map(u => ({ id: u.id, name: u.name, email: u.email })),
    });
  }));

  /**
   * §4.3 — registers a user by email; §5 matches that email at sign-in.
   *
   * Managers administer their own team. The earlier specification confined
   * these writes to Admin, on the reading that administration is an Admin
   * activity; the current one makes the outreach Manager the administrator of
   * outreach, so a Manager reaches all four writes below — bounded by
   * managerMayActOn(), which keeps them from creating an Admin or editing one.
   */
  app.post(`${P}/users`, asyncHandler(async (req, res) => {
    const user = await requireVideoUser(res); if (!user) return;
    if (!requireRole(res, user, ["admin", "manager"])) return;
    const b = req.body as Record<string, unknown>;
    const name = String(b.name ?? "").trim();
    const email = String(b.email ?? "").trim();
    const role = String(b.role ?? "") as VideoRole;
    if (!name) return sendError(res, 400, "A full name is required.");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return sendError(res, 400, "A valid email address is required.");
    if (!VIDEO_ROLES.includes(role)) return sendError(res, 400, "Pick one of Admin, Editor, Manager or Publisher.");
    if (!await managerMayActOn(res, user, null, role)) return;
    try {
      const created = await addUser({ name, email, role, active: b.active !== false });
      await announceNewMember(created, user);
      res.status(201).json({ user: created });
    } catch (err) { fail(res, err); }
  }));

  /** §4.4 — takes effect on the user's next authenticated session. */
  app.patch(`${P}/users/:id`, asyncHandler(async (req, res) => {
    const user = await requireVideoUser(res); if (!user) return;
    if (!requireRole(res, user, ["admin", "manager"])) return;
    const id = getSingleParam(req.params.id);
    const b = req.body as Record<string, unknown>;
    if (!await managerMayActOn(res, user, id, null)) return;
    let updated = null;
    if (b.role !== undefined) {
      const role = String(b.role) as VideoRole;
      if (!VIDEO_ROLES.includes(role)) return sendError(res, 400, "Pick one of Admin, Editor, Manager or Publisher.");
      if (!await managerMayActOn(res, user, id, role)) return;
      // §25 — an admin demoting themselves would lock the last door behind them.
      if (id === user.id && role !== "admin") return sendError(res, 400, "You cannot change your own role.");
      updated = await setUserRole(id, role);
    }
    if (b.active !== undefined) {
      if (id === user.id && b.active === false) return sendError(res, 400, "You cannot disable your own account.");
      updated = await setUserActive(id, b.active !== false);
    }
    if (!updated) return sendError(res, 404, "That user was not found.");
    res.json({ user: updated });
  }));

  /**
   * §4.6 — removes the user from the active list. Their videos, events and
   * activity stay exactly as they were, with their name and email snapshotted
   * on every historical entry.
   */
  app.delete(`${P}/users/:id`, asyncHandler(async (req, res) => {
    const user = await requireVideoUser(res); if (!user) return;
    if (!requireRole(res, user, ["admin", "manager"])) return;
    const id = getSingleParam(req.params.id);
    if (id === user.id) return sendError(res, 400, "You cannot delete your own account.");
    if (!await managerMayActOn(res, user, id, null)) return;
    if (!await deleteUser(id)) return sendError(res, 404, "That user was not found.");
    res.json({ deleted: true });
  }));

  // ── Google Drive connection (§9) ──────────────────────────────────────────
  //
  // The outreach team connects its own Drive here, from inside the video
  // workflow. Admin or Manager: the outreach Manager administers outreach.
  // These deliberately do NOT go through requireVideoUser, which refuses
  // every request while Drive is unconnected — the one thing these exist to
  // fix.

  function requireDriveAdmin(res: express.Response): CurrentUser | null {
    const u = res.locals.currentUser as CurrentUser;
    const role = videoRoleForNerveRole(u?.role ?? "");
    if (role !== "admin" && role !== "manager") {
      sendError(res, 403, "Only an outreach Admin or Manager can set up Google Drive.");
      return null;
    }
    return u;
  }

  function driveFailed(res: express.Response, err: unknown): void {
    if (err instanceof OutreachDriveError) return sendError(res, err.status, err.message);
    if (sendDriveError(res, err)) return;
    console.error("Outreach Drive operation failed", err);
    sendError(res, 502, "Google Drive did not answer. Please try again.");
  }

  /**
   * The Drive dialog's status: the stored connection, where Drive comes from,
   * and whether Google actually still answers (drive-errors.ts) — "connected"
   * alone used to stay true long after the token behind it had died.
   */
  async function driveStatusPayload() {
    await ensureDriveResolved();
    const source = driveSource();
    let health = UNKNOWN_HEALTH;
    if (source === "env" || source === "app") {
      const { client, rootId } = getDriveClient();
      health = await cachedDriveHealth(`${source}:${rootId}`, () => probeDrive(client, rootId));
    }
    return { ...(await outreachDriveStatus()), source, ...health };
  }

  /** Everything about a connection change that the rest of the module caches. */
  function driveChanged(): void {
    resetForDriveChange();
    resetDriveHealth();
  }

  app.get(`${P}/drive`, asyncHandler(async (_req, res) => {
    if (!requireDriveAdmin(res)) return;
    res.json(await driveStatusPayload());
  }));

  app.post(`${P}/drive/client`, asyncHandler(async (req, res) => {
    if (!requireDriveAdmin(res)) return;
    const b = req.body as Record<string, unknown>;
    try {
      await saveOutreachDriveClient(String(b.client_id ?? ""), String(b.client_secret ?? ""));
      driveChanged();
      res.json(await driveStatusPayload());
    } catch (err) { driveFailed(res, err); }
  }));

  /** Which Google account the Drive must belong to. */
  app.post(`${P}/drive/account`, asyncHandler(async (req, res) => {
    if (!requireDriveAdmin(res)) return;
    try {
      await setExpectedAccount(String((req.body as Record<string, unknown>).email ?? ""));
      res.json(await driveStatusPayload());
    } catch (err) { driveFailed(res, err); }
  }));

  app.post(`${P}/drive/connect`, asyncHandler(async (_req, res) => {
    const u = requireDriveAdmin(res); if (!u) return;
    try { res.json({ url: await outreachDriveAuthUrl(u.id) }); }
    catch (err) { driveFailed(res, err); }
  }));

  /* Google sends the browser here, in the popup the page opened. The answer
     is a small page that tells the opener what happened and closes; nothing
     about the token ever reaches the browser. */
  const htmlEsc = (v: string) => v.replace(/[&<>"']/g, c => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
  const drivePopup = (ok: boolean, message: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Google Drive — Outreach</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#F7F9FC;color:#0F172A;font:15px/1.5 system-ui,sans-serif}
.c{background:#fff;border:1px solid #E3E9F2;border-radius:12px;padding:26px 28px;max-width:440px;text-align:center}
h1{font-size:18px;margin:0 0 8px}p{margin:0;color:#475569;font-size:14px}.ok{color:#15803D}.bad{color:#B91C1C}</style></head>
<body><div class="c"><h1 class="${ok ? "ok" : "bad"}">${ok ? "Google Drive connected" : "Google Drive was not connected"}</h1>
<p>${htmlEsc(message)}</p><p style="margin-top:14px">You can close this window.</p></div>
<script>try{if(window.opener)window.opener.postMessage({type:'nerve-outreach-drive',ok:${ok ? "true" : "false"},message:${JSON.stringify(message)}},window.location.origin);}catch(e){}
${ok ? "setTimeout(function(){window.close()},1500);" : ""}</script></body></html>`;

  app.get(`${P}/drive/callback`, asyncHandler(async (req, res) => {
    const u = res.locals.currentUser as CurrentUser;
    const role = videoRoleForNerveRole(u?.role ?? "");
    if (role !== "admin" && role !== "manager") {
      return void res.status(403).type("html").send(drivePopup(false, "Only an outreach Admin or Manager can connect Google Drive."));
    }
    const q = req.query as Record<string, string | undefined>;
    if (q.error) {
      return void res.status(400).type("html").send(drivePopup(false, q.error === "access_denied"
        ? "You cancelled the Google sign-in, or did not allow access to Drive." : `Google reported: ${q.error}`));
    }
    if (!q.code || !q.state || !verifyOutreachDriveState(String(q.state), u.id)) {
      return void res.status(400).type("html").send(drivePopup(false,
        "This sign-in link is not valid or has expired. Close this window and press Connect again."));
    }
    try {
      const out = await completeOutreachDriveConnect(String(q.code), u.id);
      driveChanged();
      res.type("html").send(drivePopup(true, `${out.email} — videos will be kept in “${out.folder.name}”.`));
    } catch (err) {
      console.error("Outreach Drive connect failed", err);
      res.status(err instanceof OutreachDriveError ? err.status : 502).type("html")
        .send(drivePopup(false, err instanceof OutreachDriveError ? err.message : "Google Drive did not answer. Please try again."));
    }
  }));

  /** Use a folder the connected account already has, by link or id. */
  app.post(`${P}/drive/folder`, asyncHandler(async (req, res) => {
    if (!requireDriveAdmin(res)) return;
    try {
      await useOutreachDriveFolder(String((req.body as Record<string, unknown>).folder ?? ""));
      driveChanged();
      res.json(await driveStatusPayload());
    } catch (err) { driveFailed(res, err); }
  }));

  app.delete(`${P}/drive`, asyncHandler(async (_req, res) => {
    if (!requireDriveAdmin(res)) return;
    try {
      await disconnectOutreachDrive();
      driveChanged();
      res.json(await driveStatusPayload());
    } catch (err) { driveFailed(res, err); }
  }));

  /**
   * Re-mirrors every video into Drive — missing details files written, the
   * rest refreshed, each file in the folder its status says. For after
   * connecting, or after a stretch when Drive was unreachable.
   */
  app.post(`${P}/drive/sync`, asyncHandler(async (_req, res) => {
    const user = await requireVideoUser(res); if (!user) return;
    if (!requireRole(res, user, ["admin", "manager"])) return;
    try { res.json(await resyncAllToDrive()); }
    catch (err) { fail(res, err); }
  }));

  // ── Campaigns (§7, §17) ──────────────────────────────────────────────────

  /**
   * §5 — the list a Manager monitors, each campaign carrying its progress.
   *
   * Progress is computed here rather than stored, because the only honest
   * source is the videos themselves: a stored counter drifts the moment
   * anything is published, deleted or moved.
   */
  app.get(`${P}/campaigns`, asyncHandler(async (_req, res) => {
    const user = await requireVideoUser(res); if (!user) return;
    const [campaigns, videos] = await Promise.all([listCampaigns(), listVideos()]);
    const publishedByCampaign = new Map<string, number>();
    for (const v of videos) {
      if (v.status !== "published") continue;
      const key = v.campaignId ?? `name:${v.client.trim().toLowerCase()}`;
      publishedByCampaign.set(key, (publishedByCampaign.get(key) ?? 0) + 1);
    }
    res.json({
      campaigns: campaigns.map(c => ({
        ...c,
        /* Count by id, and fall back to the name so a campaign created for
           work that predates it still shows the progress it actually made. */
        progress: campaignProgress(c, publishedByCampaign.get(c.id)
          ?? publishedByCampaign.get(`name:${c.name.trim().toLowerCase()}`) ?? 0),
      })),
    });
  }));

  app.get(`${P}/campaigns/:id`, asyncHandler(async (req, res) => {
    const user = await requireVideoUser(res); if (!user) return;
    const campaign = await getCampaign(getSingleParam(req.params.id));
    if (!campaign) return sendError(res, 404, "That campaign was not found.");
    const videos = await listVideos();
    const mine = videos.filter(v => v.campaignId === campaign.id
      || (!v.campaignId && v.client.trim().toLowerCase() === campaign.name.trim().toLowerCase()));
    res.json({
      campaign,
      progress: campaignProgress(campaign, mine.filter(v => v.status === "published").length),
      videos: mine,
    });
  }));

  app.post(`${P}/campaigns`, asyncHandler(async (req, res) => {
    const user = await requireVideoUser(res); if (!user) return;
    if (!requireRole(res, user, ["admin", "manager"])) return;
    try {
      res.status(201).json({ campaign: await createCampaign(user, req.body as CampaignInput) });
    } catch (err) { fail(res, err); }
  }));

  app.patch(`${P}/campaigns/:id`, asyncHandler(async (req, res) => {
    const user = await requireVideoUser(res); if (!user) return;
    if (!requireRole(res, user, ["admin", "manager"])) return;
    try {
      const campaign = await updateCampaign(user, getSingleParam(req.params.id), req.body as CampaignInput);
      res.json({ campaign });
    } catch (err) { fail(res, err); }
  }));

  /** Refused while the campaign still owns videos — §17 would orphan them. */
  app.delete(`${P}/campaigns/:id`, asyncHandler(async (req, res) => {
    const user = await requireVideoUser(res); if (!user) return;
    if (!requireRole(res, user, ["admin", "manager"])) return;
    const id = getSingleParam(req.params.id);
    const campaign = await getCampaign(id);
    if (!campaign) return sendError(res, 404, "That campaign was not found.");
    const videos = await listVideos();
    const owned = videos.filter(v => v.campaignId === id
      || (!v.campaignId && v.client.trim().toLowerCase() === campaign.name.trim().toLowerCase())).length;
    try {
      await deleteCampaign(user, id, owned);
      res.json({ deleted: true });
    } catch (err) { fail(res, err); }
  }));

  // ── §18 Search & filtering ───────────────────────────────────────────────

  app.get(`${P}/search`, asyncHandler(async (req, res) => {
    const user = await requireVideoUser(res); if (!user) return;
    const q = req.query as Record<string, string>;
    // §25 — an editor searches their own work only, whatever they ask for.
    const scope = user.role === "editor" ? { onlyEditorId: user.id } : {};
    res.json(await search({
      q: q.q || undefined,
      status: (q.status as never) || undefined,
      eventStatus: (q.event_status as never) || undefined,
      client: q.client || undefined,
      editorId: q.editor_id || undefined,
      publisherId: q.publisher_id || undefined,
      platform: q.platform || undefined,
      pageId: q.page_id || undefined,
      contentType: q.content_type || undefined,
      from: q.from || undefined,
      to: q.to || undefined,
    }, scope));
  }));

  app.get(`${P}/filter-options`, asyncHandler(async (_req, res) => {
    const user = await requireVideoUser(res); if (!user) return;
    res.json(await filterOptions());
  }));

  // ── §16 Activity logging ─────────────────────────────────────────────────

  /**
   * §27 gives every role an "Activity" view (the Admin's is "Activity Logs").
   * An editor's is scoped to their own videos and assigned events — they still
   * see the publisher's actions on their work, just not anyone else's work.
   */
  app.get(`${P}/activity`, asyncHandler(async (req, res) => {
    const user = await requireVideoUser(res); if (!user) return;
    const q = req.query as Record<string, string>;
    const scope = user.role === "editor" ? { onlyEditorId: user.id } : {};
    res.json({
      entries: await activityFeed({
        q: q.q || undefined,
        userId: q.user_id || undefined,
        subjectType: (q.subject as "video" | "event") || undefined,
        from: q.from || undefined,
        to: q.to || undefined,
        limit: q.limit ? Number(q.limit) : undefined,
      }, scope),
    });
  }));

  app.get(`${P}/activity/actors`, asyncHandler(async (_req, res) => {
    const user = await requireVideoUser(res); if (!user) return;
    if (!await requireRoleOrGrant(res, user, ["admin", "manager", "publisher"], "outreach:activity")) return;
    res.json({ actors: await activityActors() });
  }));

  // ── §20 KPI dashboard and §11.3 / §14.1 Editor Video Log ─────────────────

  /** §20 — "Admin and Manager should have access to overall workflow KPIs". */
  app.get(`${P}/kpis`, asyncHandler(async (_req, res) => {
    const user = await requireVideoUser(res); if (!user) return;
    if (!await requireRoleOrGrant(res, user, ["admin", "manager"], "outreach:video_dashboard")) return;
    const [kpis, campaigns, users] = await Promise.all([workflowKpis(), listCampaigns(), listUsers()]);
    /* §5 "Total social media pages" — the ones still posted to. Read from
       Postgres, so a database hiccup costs this one number, not the page. */
    let totalSocialPages: number | null = null;
    try {
      const { listPages } = await import("../outreach-db.js");
      totalSocialPages = (await listPages()).filter(pg => (pg as { status?: string }).status !== "inactive").length;
    } catch { totalSocialPages = null; }
    res.json({
      kpis: {
        ...kpis,
        // §5 Manager and §12 Admin — campaign totals.
        campaignsTotal: campaigns.length,
        campaignsRunning: campaigns.filter(c => c.status === "running").length,
        campaignsUpcoming: campaigns.filter(c => c.status === "upcoming").length,
        campaignsCompleted: campaigns.filter(c => c.status === "completed").length,
        totalSocialPages,
        // §12 Admin — "Total Users": the workflow team, active members only.
        totalUsers: users.filter(u => u.active && !u.deletedAt).length,
      },
    });
  }));

  /** §11.3 Manager and §14.1 Publisher both get the monthly editor log. */
  app.get(`${P}/editor-log`, asyncHandler(async (req, res) => {
    const user = await requireVideoUser(res); if (!user) return;
    if (!await requireRoleOrGrant(res, user, ["admin", "manager", "publisher"], "outreach:editor_log")) return;
    const q = req.query as Record<string, string>;
    res.json({ log: await editorVideoLog(q.month || undefined, q.client || undefined) });
  }));

  // ── §8.2 Social media pages ──────────────────────────────────────────────

  /**
   * Editors get platform, handle and connected status and nothing else — no
   * follower counts, no engagement, no performance data. §25 requires that to
   * be true of the API itself, so the reduced shape is built here rather than
   * filtered in the browser, where a direct request would bypass it.
   *
   * Reads the pages the Outreach department already maintains, so there is no
   * second list of social accounts to keep in step.
   */
  app.get(`${P}/social-pages`, asyncHandler(async (_req, res) => {
    const user = await requireVideoUser(res); if (!user) return;
    const { listPages } = await import("../outreach-db.js");
    const all = await listPages();
    const { pages, analyticsVisible } = socialPagesForRole(all, user.role);

    /* §8 — which campaigns each page is assigned to. Built here rather than
       stored on the page, because the campaign already names its pages and
       keeping the reverse copy in step would be one more thing to get wrong.

       Only for people who may see campaigns at all. The editor projection in
       socialPagesForRole() is an allowlist on purpose (§25), so nothing is
       attached to it here — a field added to a page must stay invisible to an
       editor by default, and that includes this one. */
    if (user.role === "editor") {
      return res.json({ pages, analytics_visible: analyticsVisible });
    }
    const campaigns = await listCampaigns();
    const byPage = new Map<string, string[]>();
    for (const c of campaigns) {
      for (const pageId of c.socialPageIds) {
        byPage.set(pageId, [...(byPage.get(pageId) ?? []), c.name]);
      }
    }
    res.json({
      pages: (pages as Array<{ id: string }>).map(pg => ({
        ...pg, assigned_campaigns: byPage.get(pg.id) ?? [],
      })),
      analytics_visible: analyticsVisible,
    });
  }));

  /**
   * §8 — the page details a person maintains: the link, who to contact, and
   * whether we still post there.
   *
   * Deliberately narrow. Everything else on a page comes from the sync, and
   * letting this edit those fields would mean the next sync silently undid
   * the edit.
   */
  app.patch(`${P}/social-pages/:id`, asyncHandler(async (req, res) => {
    const user = await requireVideoUser(res); if (!user) return;
    if (!requireRole(res, user, ["admin", "manager"])) return;
    const b = req.body as Record<string, unknown>;
    const patch: Record<string, string> = {};
    if (b.page_link !== undefined) patch.page_link = String(b.page_link).trim();
    if (b.contact_person !== undefined) patch.contact_person = String(b.contact_person).trim();
    if (b.status !== undefined) {
      const status = String(b.status);
      if (status !== "active" && status !== "inactive") {
        return sendError(res, 400, "A page is either active or inactive.");
      }
      patch.status = status;
    }
    if (!Object.keys(patch).length) return sendError(res, 400, "Nothing to change.");

    const { updatePage } = await import("../outreach-db.js");
    const updated = await updatePage(getSingleParam(req.params.id), patch);
    if (!updated) return sendError(res, 404, "That page was not found.");
    res.json({ page: updated });
  }));

  /*
   * Last, so it sees every error the routes above pass on. A Drive failure
   * or one of this module's typed errors that escaped a handler (a store read
   * outside any try) is answered here, as the JSON the client understands.
   * None of them may reach the global handler: it passes a 4xx through only
   * for body-parser style errors, so a DriveAuthError (whose `status` is
   * Google's, e.g. 400 for invalid_grant) would come out as a bare 500.
   * Anything else — a real bug — carries on to that handler.
   */
  app.use(P, ((err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (res.headersSent) return next(err);
    if (sendKnownError(res, err)) return;
    next(err);
  }) as express.ErrorRequestHandler);
}

/** How much of a refused upload's body is read and discarded before closing. */
export const REFUSAL_DRAIN_BYTES = 64 * 1024 * 1024;
const REFUSAL_DRAIN_MS = 60_000;

/**
 * For a request refused before its body was read: lets the refusal reach the
 * browser before the connection closes.
 *
 * With `Connection: close`, Node closes the socket as soon as the response is
 * written. If the browser is still sending the file, the unread bytes make
 * that close a TCP reset, and the browser reports a network error instead of
 * the JSON it was sent. So until `release()` is called (once the body has
 * been taken), ending the response is held back: the JSON is written at once,
 * the rest of the body is read and thrown away — up to REFUSAL_DRAIN_BYTES,
 * or REFUSAL_DRAIN_MS — and only then is the response ended and the socket
 * closed. Past that bound the connection closes anyway; a browser sending
 * gigabytes to a refusal is not worth holding a socket open for.
 *
 * In production this is moot: nginx buffers the whole request body before
 * passing it on (proxy_request_buffering), so it — not the browser — is what
 * Node's close cuts off, and nginx relays the JSON intact. It matters when
 * Node is reached directly (local development, a misconfigured proxy).
 */
export function holdCloseUntilDrained(req: express.Request, res: express.Response): () => void {
  const end = res.end.bind(res) as (...args: unknown[]) => express.Response;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    res.end = end as express.Response["end"];
  };

  res.end = ((...args: unknown[]) => {
    release();
    if (req.complete || req.readableEnded || req.destroyed) return end(...args);
    // Express's send() ends with (chunk, encoding); write it now so the
    // browser has the whole answer (Content-Length is already set).
    const cb = typeof args[args.length - 1] === "function" ? args.pop() as () => void : undefined;
    const [chunk, encoding] = args as [unknown, BufferEncoding | undefined];
    if (chunk !== undefined && chunk !== null) res.write(chunk as Buffer | string, encoding ?? "utf8");
    else res.flushHeaders();

    let seen = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (timer === undefined) return;
      clearTimeout(timer);
      timer = undefined;
      req.off("data", onData).off("end", finish).off("error", finish).off("close", finish);
      end(cb);
    };
    const onData = (c: Buffer) => {
      seen += c.length;
      if (seen > REFUSAL_DRAIN_BYTES) finish();
    };
    timer = setTimeout(finish, REFUSAL_DRAIN_MS);
    timer.unref?.();
    req.on("data", onData).on("end", finish).on("error", finish).on("close", finish);
    req.resume();
    return res;
  }) as express.Response["end"];

  return release;
}

/**
 * The origin a direct upload session is opened for. Google answers the
 * browser's PUTs only from the origin the session names, so it must be the
 * page's real origin — but it is taken from a request header, so only Nerve's
 * own origin (APP_BASE_URL) is believed, plus localhost while developing.
 * Anything else falls back to APP_BASE_URL's origin.
 */
export function uploadOrigin(originHeader: string | undefined, appBaseUrl: string, nodeEnv: string | undefined): string {
  let base: string;
  try { base = new URL(appBaseUrl).origin; } catch { base = appBaseUrl.replace(/\/+$/, ""); }
  const origin = String(originHeader ?? "").trim();
  if (origin && origin === base) return origin;
  if (nodeEnv !== "production" && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return origin;
  return base;
}

// ── The staging directory ──────────────────────────────────────────────────
//
// The through-the-server path stages each video on disk while it goes to
// Drive, and the handler deletes it on every path. A process killed mid-upload
// cannot, so whatever is left is swept: anything older than six hours is an
// upload nobody is waiting for any more.

const STAGING_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const STAGING_SWEEP_EVERY_MS = 60 * 60 * 1000;
let stagingSweeper: ReturnType<typeof setInterval> | null = null;

/** Deletes staged files older than `maxAgeMs`; returns how many. Never throws. */
export async function sweepVideoStaging(dir: string, maxAgeMs = STAGING_MAX_AGE_MS, now = Date.now()): Promise<number> {
  let removed = 0;
  let names: string[];
  try { names = await fsp.readdir(dir); } catch { return 0; }
  for (const name of names) {
    const full = path.join(dir, name);
    try {
      const stat = await fsp.stat(full);
      if (stat.isFile() && now - stat.mtimeMs > maxAgeMs) {
        await fsp.unlink(full);
        removed++;
      }
    } catch { /* gone already, or not ours to remove */ }
  }
  return removed;
}

function startStagingSweep(dir: string): void {
  if (stagingSweeper) return;
  const sweep = () => {
    void sweepVideoStaging(dir).then(n => {
      if (n) console.log(`Outreach video: removed ${n} abandoned staged upload${n === 1 ? "" : "s"}.`);
    });
  };
  sweep();
  stagingSweeper = setInterval(sweep, STAGING_SWEEP_EVERY_MS);
  stagingSweeper.unref?.();

  // Staging used to live under uploads/outreach-video, which /uploads serves
  // publicly. Anything a killed process left there is cleared once at start,
  // whatever its age — nothing waits on that folder any more.
  const legacy = path.resolve("uploads/outreach-video");
  if (path.resolve(dir) !== legacy) {
    void sweepVideoStaging(legacy, 0).then(n => {
      if (n) console.log(`Outreach video: removed ${n} file${n === 1 ? "" : "s"} left in the old public staging folder.`);
    });
  }
}

/** Used by index.ts to build the multer instance with video-appropriate limits. */
export { VIDEO_MIME_ALLOWLIST };

/**
 * For index.ts's multer fileFilter: a recognised video type, or a generic
 * one (application/octet-stream, none) on a known video extension.
 */
export function isAcceptedVideoUpload(mimeType: string, originalName: string): boolean {
  return acceptedVideoType(mimeType, originalName) !== null;
}

export function videoFileName(original: string): string {
  const dot = original.lastIndexOf(".");
  const ext = dot >= 0 ? original.slice(dot).toLowerCase().replace(/[^a-z0-9.]/g, "") : ".mp4";
  return `${randomUUID()}${ext}`;
}
