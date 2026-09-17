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

import { driveIsConfigured, driveIsLocal, getDriveClient, DriveNotConfiguredError } from "./drive-client.js";
import {
  addUser, deleteUser, findUserByEmail, listActiveEditors, listUsers,
  setUserActive, setUserRole, touchLastActivity, videoRoleForNerveRole,
  UserExistsError,
} from "./users.js";
import {
  getVideo, listVideos, publishVideo, publishingQueue, setLiveUrls,
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
    if (!driveIsConfigured()) {
      sendError(res, 503, "The video workflow is not connected to Google Drive yet. Ask an administrator to finish the Drive setup.");
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
    const created = await addUser({ name: u.full_name ?? email, email, role });
    return created;
  }

  function requireRole(res: express.Response, user: VideoUser, allowed: VideoRole[]): boolean {
    if (allowed.includes(user.role)) return true;
    sendError(res, 403, "Your role cannot perform that action.");
    return false;
  }

  /** Maps a domain error onto the right status, so the UI can say something useful. */
  function fail(res: express.Response, err: unknown): void {
    if (err instanceof VideoNotFoundError) return sendError(res, 404, err.message);
    if (err instanceof NotYourVideoError) return sendError(res, 403, err.message);
    if (err instanceof EventNotFoundError) return sendError(res, 404, err.message);
    if (err instanceof NotYourEventError) return sendError(res, 403, err.message);
    if (err instanceof EventNotOpenError) return sendError(res, 409, err.message);
    if (err instanceof UserExistsError) return sendError(res, 409, err.message);
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
    res.json({ configured: driveIsConfigured(), local: driveIsLocal(), role });
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
    try {
      const video = await uploadVideo({
        editor: user,
        client: body.client ?? "",
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

  app.get(`${P}/queue`, asyncHandler(async (_req, res) => {
    const user = await requireVideoUser(res); if (!user) return;
    if (!requireRole(res, user, ["publisher", "manager", "admin"])) return;
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
    if (!requireRole(res, user, ["manager", "admin"])) return;
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
    if (!requireRole(res, user, ["admin", "manager"])) return;
    res.json({ users: await listUsers() });
  }));

  /** §11.2 — the dropdown of active editors a Manager assigns events from. */
  app.get(`${P}/editors`, asyncHandler(async (_req, res) => {
    const user = await requireVideoUser(res); if (!user) return;
    if (!requireRole(res, user, ["admin", "manager"])) return;
    res.json({ editors: await listActiveEditors() });
  }));

  /**
   * §4.3 — Admin registers a user by email; §5 matches that email at sign-in.
   * Admin-only: §25 "Restrict Admin privileges to explicitly configured Admin
   * accounts", so a Manager cannot reach any of the four writes below.
   */
  app.post(`${P}/users`, asyncHandler(async (req, res) => {
    const user = await requireVideoUser(res); if (!user) return;
    if (!requireRole(res, user, ["admin"])) return;
    const b = req.body as Record<string, unknown>;
    const name = String(b.name ?? "").trim();
    const email = String(b.email ?? "").trim();
    const role = String(b.role ?? "") as VideoRole;
    if (!name) return sendError(res, 400, "A full name is required.");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return sendError(res, 400, "A valid email address is required.");
    if (!VIDEO_ROLES.includes(role)) return sendError(res, 400, "Pick one of Admin, Editor, Manager or Publisher.");
    try {
      res.status(201).json({ user: await addUser({ name, email, role, active: b.active !== false }) });
    } catch (err) { fail(res, err); }
  }));

  /** §4.4 — takes effect on the user's next authenticated session. */
  app.patch(`${P}/users/:id`, asyncHandler(async (req, res) => {
    const user = await requireVideoUser(res); if (!user) return;
    if (!requireRole(res, user, ["admin"])) return;
    const id = getSingleParam(req.params.id);
    const b = req.body as Record<string, unknown>;
    let updated = null;
    if (b.role !== undefined) {
      const role = String(b.role) as VideoRole;
      if (!VIDEO_ROLES.includes(role)) return sendError(res, 400, "Pick one of Admin, Editor, Manager or Publisher.");
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
    if (!requireRole(res, user, ["admin"])) return;
    const id = getSingleParam(req.params.id);
    if (id === user.id) return sendError(res, 400, "You cannot delete your own account.");
    if (!await deleteUser(id)) return sendError(res, 404, "That user was not found.");
    res.json({ deleted: true });
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

  // ── §20 KPI dashboard and §11.3 / §14.1 Editor Video Log ─────────────────

  /** §20 — "Admin and Manager should have access to overall workflow KPIs". */
  app.get(`${P}/kpis`, asyncHandler(async (_req, res) => {
    const user = await requireVideoUser(res); if (!user) return;
    if (!requireRole(res, user, ["admin", "manager"])) return;
    res.json({ kpis: await workflowKpis() });
  }));

  /** §11.3 Manager and §14.1 Publisher both get the monthly editor log. */
  app.get(`${P}/editor-log`, asyncHandler(async (req, res) => {
    const user = await requireVideoUser(res); if (!user) return;
    if (!requireRole(res, user, ["admin", "manager", "publisher"])) return;
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
    const { pages, analyticsVisible } = socialPagesForRole(await listPages(), user.role);
    res.json({ pages, analytics_visible: analyticsVisible });
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
