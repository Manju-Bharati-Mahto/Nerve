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
import type express from "express";
import type multer from "multer";
import { Readable } from "node:stream";

import {
  driveIsConfigured, driveIsLocal, driveSource, ensureDriveResolved, getDriveClient, DriveNotConfiguredError,
} from "./drive-client.js";
import { listUserCapabilities } from "../db.js";
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
  approveVideo, rejectVideo, startRevision, scheduleVideo, reviewQueue,
  submitVideo, updateCaption, uploadVideo,
  InvalidTransitionError, NotYourVideoError, VideoNotFoundError,
} from "./videos.js";
import { socialPagesForRole } from "./social-pages.js";
import {
  assignEvent, completeEvent, createEvent, eventCounts, getEvent, listEvents,
  todoFor, updateEventDetails, EventNotFoundError, EventNotOpenError, NotYourEventError,
} from "./events.js";
import { listNotifications, markRead } from "./notifications.js";
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
}

export function registerOutreachVideoApi(app: express.Express, h: Handlers) {
  const { asyncHandler, sendError, getSingleParam, videoUpload } = h;
  const P = "/api/outreach/video";

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
      sendError(res, 503, "The video workflow is not connected to Google Drive yet. A Super Admin can connect it in Media Ops → Casting Management → Google Drive — one Google sign-in covers both.");
      return null;
    }

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
      return await addUser({ name: u.full_name ?? email, email, role });
    } catch (err) {
      if (err instanceof UserExistsError) {
        const raced = await findUserByEmail(email);
        if (raced) return raced;
      }
      throw err;
    }
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

  /** Maps a domain error onto the right status, so the UI can say something useful. */
  function fail(res: express.Response, err: unknown): void {
    if (err instanceof VideoNotFoundError) return sendError(res, 404, err.message);
    if (err instanceof NotYourVideoError) return sendError(res, 403, err.message);
    if (err instanceof EventNotFoundError) return sendError(res, 404, err.message);
    if (err instanceof NotYourEventError) return sendError(res, 403, err.message);
    if (err instanceof EventNotOpenError) return sendError(res, 409, err.message);
    if (err instanceof UserExistsError) return sendError(res, 409, err.message);
    if (err instanceof CampaignNotFoundError) return sendError(res, 404, err.message);
    if (err instanceof CampaignExistsError) return sendError(res, 409, err.message);
    if (err instanceof CampaignInUseError) return sendError(res, 409, err.message);
    if (err instanceof InvalidTransitionError) return sendError(res, 409, err.message);
    if (err instanceof DriveNotConfiguredError) return sendError(res, 503, err.message);
    const msg = err instanceof Error ? err.message : "Something went wrong.";
    // §29 — a Drive problem is temporary and retryable; say so rather than
    // reporting a generic failure the user can't act on.
    const isDrive = /drive|google|upload/i.test(msg);
    return sendError(res, isDrive ? 502 : 400, msg);
  }

  // ── Setup state ──────────────────────────────────────────────────────────

  app.get(`${P}/config`, asyncHandler(async (_req, res) => {
    const u = res.locals.currentUser as CurrentUser;
    const role = videoRoleForNerveRole(u?.role ?? "");
    if (!role) return sendError(res, 403, "This area is for the video workflow team only.");
    await ensureDriveResolved();
    res.json({ configured: driveIsConfigured(), local: driveIsLocal(), source: driveSource(), role });
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

  /** §9 — upload. Multipart: the file plus the required and optional fields. */
  app.post(`${P}/videos`, videoUpload.single("video"), asyncHandler(async (req, res) => {
    const user = await requireVideoUser(res); if (!user) return;
    if (!requireRole(res, user, ["editor", "admin"])) return;

    const file = req.file;
    if (!file) return sendError(res, 400, "A video file is required.");

    const body = req.body as Record<string, string>;

    /* §3 — the pages the editor picked, sent as a comma-separated list
       because the upload is multipart form data. Their handles are resolved
       here so the §10 caption file can name them. */
    const pageIds = body.socialPageIds
      ? String(body.socialPageIds).split(",").map(x => x.trim()).filter(Boolean)
      : [];
    let pageNames: string[] = [];
    if (pageIds.length) {
      const { listPages } = await import("../outreach-db.js");
      const byId = new Map((await listPages()).map(pg => [pg.id, pg.handle]));
      pageNames = pageIds.map(id => byId.get(id)).filter((h): h is string => !!h);
    }

    try {
      const video = await uploadVideo({
        editor: user,
        client: body.client ?? "",
        /* §17 — when the editor picks a real campaign, it decides the name,
           the Drive folders and the file naming. Absent on an upload that
           only carries typed-in text, which is the older path. */
        campaignId: body.campaignId || null,
        /* §3 — the pages the editor picked, sent as a comma-separated list
           because the upload is multipart form data. */
        socialPageIds: pageIds,
        pageNames,
        editorTitle: body.title ?? "",
        caption: body.caption ?? "",
        localPath: file.path,
        originalName: file.originalname,
        mimeType: file.mimetype,
        sizeBytes: file.size,
        platform: body.platform ?? null,
        notes: body.notes ?? null,
        tags: body.tags ? String(body.tags).split(",").map(t => t.trim()).filter(Boolean) : [],
      });
      res.status(201).json({ video });
    } catch (err) {
      fail(res, err);
    } finally {
      // The bytes now live in Drive (or the upload failed outright); either way
      // the temp file has no further use.
      await fsp.unlink(file.path).catch(() => {});
    }
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
    const body = req.body as { live_urls?: Record<string, string> };
    try {
      const video = await publishVideo(getSingleParam(req.params.id), user, body.live_urls ?? {});
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
      res.status(201).json({ user: await addUser({ name, email, role, active: b.active !== false }) });
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
    res.json({ kpis: await workflowKpis() });
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
}

/** Used by index.ts to build the multer instance with video-appropriate limits. */
export const VIDEO_MIME_ALLOWLIST = [
  "video/mp4", "video/quicktime", "video/x-m4v", "video/webm", "video/x-msvideo", "video/mpeg",
];

export function videoFileName(original: string): string {
  const dot = original.lastIndexOf(".");
  const ext = dot >= 0 ? original.slice(dot).toLowerCase().replace(/[^a-z0-9.]/g, "") : ".mp4";
  return `${randomUUID()}${ext}`;
}
