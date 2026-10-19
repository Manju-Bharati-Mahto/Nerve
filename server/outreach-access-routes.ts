/**
 * The API behind the Add / Edit User tab grid and the State window
 * (Account Tabs & State-wise Analytics requirements, §1 and §2).
 *
 *   GET  /api/outreach/access                 — what the signed-in person may open, and which states
 *   GET  /api/outreach/access/users           — every outreach person's tabs and states (the Users tab)
 *   PUT  /api/outreach/access/users/:id       — save one person's tabs and states (admins)
 *   PATCH /api/outreach/access/users/:id      — change their role, or disable / enable them (admins)
 *   PUT  /api/outreach/access/users/:id/states — change only their states: the State window (admins)
 *   DELETE /api/outreach/access/users/:id     — remove them, releasing their email (admins)
 *
 * "Admins" are the outreach admins — super_admin and outreach_manager — the
 * only people who choose anyone's tabs or states. Everything here is outreach
 * only: it reads and writes outreach-owned tables, and a target outside the
 * outreach team is refused rather than touched.
 */
import type express from "express";
import { pool, listUserCapabilities } from "./db.js";
import { getUserAccess, listAllUserStates, saveUserAccess, saveUserStates } from "./outreach-db.js";
import { hasTab, isOutreachAdmin, resolveOutreachAccess, OUTREACH_STATE_USER_ROLE } from "./outreach-scope.js";
import { cleanTabLevels, defaultTabLevels } from "./outreach-tabs.js";
import { canonicalState } from "./outreach-states.js";
import { randomBytes } from "node:crypto";

interface Handlers {
  asyncHandler: (fn: (req: express.Request, res: express.Response, next: express.NextFunction) => Promise<unknown>) =>
    (req: express.Request, res: express.Response, next: express.NextFunction) => void;
  sendError: (res: express.Response, status: number, message: string) => void;
  getSingleParam: (v: string | string[]) => string;
}

interface CurrentUser { id: string; role: string; team: string | null; full_name?: string; email?: string }

/** The roles an admin configures. Super admin and outreach manager always have everything. */
const CONFIGURABLE = new Set(["admin", "outreach_editor", "outreach_publisher", OUTREACH_STATE_USER_ROLE]);

/** The roles an outreach manager may give an existing account; a super admin may also give "admin". */
const ACCOUNT_ROLES = ["outreach_manager", "outreach_editor", "outreach_publisher", OUTREACH_STATE_USER_ROLE];

interface Target { id: string; full_name: string; email: string; role: string; team: string | null; status: string | null; created_at?: string }

async function outreachTarget(id: string): Promise<Target | null> {
  const { rows } = await pool.query<Target>(
    `SELECT id, full_name, email, role, team, status FROM users WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

/** "All States", or a list of canonical names — refusing anything off the master list by name. */
function parseStates(body: Record<string, unknown>): { ok: true; allStates: boolean; states: string[] } | { ok: false; problem: string } {
  const allStates = body.allStates === true;
  const raw = Array.isArray(body.states) ? body.states : [];
  const states: string[] = [];
  for (const value of raw) {
    const canonical = canonicalState(String(value));
    if (!canonical) return { ok: false, problem: `"${String(value)}" is not an Indian state or union territory.` };
    if (!states.includes(canonical)) states.push(canonical);
  }
  return { ok: true, allStates, states: allStates ? [] : states.sort() };
}

async function recordAccessChange(
  actor: CurrentUser, target: Target, action: string, detail: Record<string, unknown>,
): Promise<void> {
  /* The audit is a record, not a gate: a failure to write it is logged and
     the change the admin made still stands. */
  try {
    await pool.query(
      `INSERT INTO outreach_user_audit (actor_id, actor_email, action, target_user_id, target_email, detail)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [actor.id, actor.email ?? null, action, target.id, target.email, JSON.stringify(detail)]);
  } catch (err) {
    console.error("Outreach: could not record an access change in outreach_user_audit:", err);
  }
}

/**
 * Removes a person from outreach completely (PRD 6.2), in one transaction:
 *
 *   - their email is released: it is rewritten to an address nobody owns, so
 *     a new account can be created with the real one. This was the bug —
 *     the Users tab "deleted" only the video workflow's own record, the Nerve
 *     account stayed, and re-creating outreach1@… was refused as "already
 *     exists". The original email is kept in the audit row;
 *   - they cannot sign in: the address they would sign in with no longer
 *     exists, and the password hash is replaced with one nothing matches;
 *   - they are signed out everywhere, now: their sessions are deleted;
 *   - their outreach tabs, states and grants are removed;
 *   - the account itself is kept, marked archived — the way Media Ops removes
 *     people — because hundreds of rows across Nerve point at a user id, and
 *     history must keep resolving to a name.
 * The video workflow's record is then tombstoned, best effort: with no Drive
 * connected there is none to touch, and the person is already removed.
 */
async function removeOutreachAccount(actor: CurrentUser, target: Target): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const placeholder = `removed.${target.id}.${Date.now()}@removed.invalid`;
    await client.query(
      `UPDATE users SET email = $2, password_hash = $3, status = 'archived',
              deactivated_at = NOW(), deactivated_by = $4, deactivation_reason = 'Removed from outreach',
              updated_at = NOW()
        WHERE id = $1`,
      [target.id, placeholder, `removed:${randomBytes(24).toString("hex")}`, actor.id]);
    await client.query(`DELETE FROM user_capabilities WHERE user_id = $1`, [target.id]);
    await client.query(`DELETE FROM outreach_user_tabs WHERE user_id = $1`, [target.id]);
    await client.query(`DELETE FROM outreach_user_states WHERE user_id = $1`, [target.id]);
    await client.query(`DELETE FROM outreach_user_access WHERE user_id = $1`, [target.id]);
    await client.query(`DELETE FROM outreach_disabled_logins WHERE user_id = $1`, [target.id]);
    await client.query(`DELETE FROM session WHERE sess->>'userId' = $1`, [target.id]);
    await client.query(
      `INSERT INTO outreach_user_audit (actor_id, actor_email, action, target_user_id, target_email, detail)
       VALUES ($1, $2, 'user.removed', $3, $4, $5::jsonb)`,
      [actor.id, actor.email ?? null, target.id, target.email,
       JSON.stringify({ role: target.role, name: target.full_name, releasedEmail: target.email })]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  try {
    const { driveIsConfigured, ensureDriveResolved } = await import("./outreach-video/drive-client.js");
    await ensureDriveResolved();
    if (!driveIsConfigured()) return;
    const { findUserByEmail, deleteUser } = await import("./outreach-video/users.js");
    const record = await findUserByEmail(target.email);
    if (record && !record.deletedAt) await deleteUser(record.id);
  } catch (err) {
    console.error("Outreach: account removed, but its video workflow record could not be tombstoned:", err);
  }
}

export function registerOutreachAccessApi(app: express.Express, h: Handlers): void {
  const { asyncHandler, sendError, getSingleParam } = h;

  function requireAdmin(res: express.Response): CurrentUser | null {
    const u = res.locals.currentUser as CurrentUser | undefined;
    if (u && isOutreachAdmin(u)) return u;
    sendError(res, 403, "Only the outreach manager can add or remove users, or choose their tabs and states.");
    return null;
  }

  /** Who may this tab grid be saved for? Answers and returns null when nobody should touch them. */
  async function configurableTarget(res: express.Response, actor: CurrentUser, id: string): Promise<Target | null> {
    const target = await outreachTarget(id);
    if (!target || target.team !== "outreach") {
      sendError(res, 404, "That outreach user was not found.");
      return null;
    }
    if (!CONFIGURABLE.has(target.role)) {
      sendError(res, 400, "Outreach managers and super admins always have every tab and every state.");
      return null;
    }
    // The same ceiling as a role change or removal: the Admin is the super admin's to limit.
    if (target.role === "admin" && actor.role !== "super_admin") {
      sendError(res, 403, "Only a super admin can choose the video workflow Admin's tabs and states.");
      return null;
    }
    return target;
  }

  app.get("/api/outreach/access", asyncHandler(async (_req, res) => {
    const u = res.locals.currentUser as CurrentUser;
    const access = await resolveOutreachAccess(u);
    if (!access) return sendError(res, 403, "This area is for the outreach team.");
    res.json({ access });
  }));

  /* Read by the Users tab, so anyone holding that tab sees the list; adding,
     changing and removing people stays with the admins (every write below). */
  app.get("/api/outreach/access/users", asyncHandler(async (_req, res) => {
    const viewer = res.locals.currentUser as CurrentUser | undefined;
    const access = viewer ? await resolveOutreachAccess(viewer) : null;
    if (!access || !hasTab(access, ["users"], "view")) {
      return sendError(res, 403, "The Users tab has not been given to you. Ask your outreach manager.");
    }
    const { rows: users } = await pool.query<Target>(
      `SELECT id, full_name, email, role, team, status, created_at FROM users
        WHERE team = 'outreach' AND COALESCE(status, 'active') <> 'archived'
        ORDER BY lower(full_name)`);
    const saved = new Map((await listAllUserStates()).map(r => [r.userId, r]));
    const out = [];
    for (const user of users) {
      const admin = !CONFIGURABLE.has(user.role);
      const access = admin ? null : await getUserAccess(user.id);
      const legacy = admin || access ? [] : (await listUserCapabilities(user.id)).filter(k => k.startsWith("outreach:"));
      const states = saved.get(user.id);
      out.push({
        id: user.id, name: user.full_name, email: user.email, role: user.role,
        active: user.status !== "inactive",
        createdAt: user.created_at,
        admin,
        configured: !!access,
        tabs: admin ? null : access ? access.tabs : defaultTabLevels(user.role, legacy),
        allStates: admin ? true : states?.allStates ?? false,
        states: admin ? [] : states?.states ?? [],
      });
    }
    res.json({ users: out });
  }));

  app.put("/api/outreach/access/users/:id", asyncHandler(async (req, res) => {
    const actor = requireAdmin(res); if (!actor) return;
    const target = await configurableTarget(res, actor, getSingleParam(req.params.id)); if (!target) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const parsed = parseStates(body);
    if (!parsed.ok) return sendError(res, 400, parsed.problem);
    const tabs = cleanTabLevels((body.tabs ?? {}) as Record<string, string>, target.role);
    await saveUserAccess(target.id, { tabs, allStates: parsed.allStates, states: parsed.states }, actor.id);
    await recordAccessChange(actor, target, "access.saved", { tabs, allStates: parsed.allStates, states: parsed.states });
    res.json({ access: await resolveOutreachAccess({ id: target.id, role: target.role, team: target.team }) });
  }));

  /**
   * PRD 6.2. Admins only, with the same ceilings as the rest of user
   * management: nobody removes themselves or a super admin, and only a super
   * admin removes the video workflow's Admin.
   */
  app.delete("/api/outreach/access/users/:id", asyncHandler(async (req, res) => {
    const actor = requireAdmin(res); if (!actor) return;
    const target = await outreachTarget(getSingleParam(req.params.id));
    if (!target || target.team !== "outreach" || target.status === "archived") {
      return sendError(res, 404, "That outreach user was not found.");
    }
    if (target.id === actor.id) return sendError(res, 400, "You cannot remove your own account.");
    if (target.role === "super_admin") return sendError(res, 403, "A super admin cannot be removed here.");
    if (target.role === "admin" && actor.role !== "super_admin") {
      return sendError(res, 403, "Only a super admin can remove the video workflow's Admin.");
    }
    await removeOutreachAccount(actor, target);
    res.json({ removed: true, email: target.email });
  }));

  /**
   * The Users table's role and Disable / Enable (PRD §4.4, §4.5), on the Nerve
   * account itself — so they work with or without Google Drive connected. The
   * video workflow's record follows, best effort, as it does on removal.
   *
   * Disabled is marked "inactive", signed out at once, and locked out at
   * sign-in by setting the password aside (outreach_disabled_logins) — Nerve's
   * shared status check alone does not stop a sign-in.
   */
  app.patch("/api/outreach/access/users/:id", asyncHandler(async (req, res) => {
    const actor = requireAdmin(res); if (!actor) return;
    const target = await outreachTarget(getSingleParam(req.params.id));
    if (!target || target.team !== "outreach" || target.status === "archived") {
      return sendError(res, 404, "That outreach user was not found.");
    }
    if (target.id === actor.id) return sendError(res, 400, "You cannot change your own role or disable yourself.");
    if (target.role === "super_admin") return sendError(res, 403, "A super admin is managed from Nerve's user management, not here.");
    if (target.role === "admin" && actor.role !== "super_admin") {
      return sendError(res, 403, "Only a super admin can change the video workflow's Admin.");
    }
    const body = (req.body ?? {}) as Record<string, unknown>;

    let role = target.role;
    if (body.role !== undefined) {
      role = String(body.role);
      const allowed = actor.role === "super_admin" ? [...ACCOUNT_ROLES, "admin"] : ACCOUNT_ROLES;
      if (!allowed.includes(role)) {
        return sendError(res, 400, actor.role === "super_admin"
          ? "Pick one of Admin, Manager, Editor, Publisher or State User."
          : "Pick one of Manager, Editor, Publisher or State User. Only a super admin can make someone an Admin.");
      }
    }
    const active = body.active === undefined ? target.status !== "inactive" : body.active !== false;
    /* A State User has no video workflow role, so a saved grid loses its
       video tabs when someone becomes one — the same rule the grid itself
       applies (cleanTabLevels). */
    const saved = role !== target.role && CONFIGURABLE.has(role) ? await getUserAccess(target.id) : null;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE users SET role = $2, status = $3, updated_at = NOW() WHERE id = $1`,
        [target.id, role, active ? "active" : "inactive"]);
      if (saved) {
        await client.query(`DELETE FROM outreach_user_tabs WHERE user_id = $1`, [target.id]);
        for (const [tab, level] of Object.entries(cleanTabLevels(saved.tabs, role))) {
          await client.query(
            `INSERT INTO outreach_user_tabs (user_id, tab, level) VALUES ($1, $2, $3)`, [target.id, tab, level]);
        }
      }
      if (!active) {
        /* Locked out at sign-in, signed out now. The password is kept, not
           lost: Enable restores it (see outreach_disabled_logins). */
        await client.query(
          `INSERT INTO outreach_disabled_logins (user_id, password_hash)
           SELECT id, password_hash FROM users WHERE id = $1 AND password_hash NOT LIKE 'disabled:%'
           ON CONFLICT (user_id) DO NOTHING`, [target.id]);
        await client.query(
          `UPDATE users SET password_hash = $2 WHERE id = $1 AND password_hash NOT LIKE 'disabled:%'`,
          [target.id, `disabled:${randomBytes(24).toString("hex")}`]);
        await client.query(`DELETE FROM session WHERE sess->>'userId' = $1`, [target.id]);
      } else {
        // Only the placeholder is replaced: a password reset while disabled wins.
        await client.query(
          `UPDATE users u SET password_hash = d.password_hash
             FROM outreach_disabled_logins d
            WHERE u.id = d.user_id AND u.id = $1 AND u.password_hash LIKE 'disabled:%'`, [target.id]);
        await client.query(`DELETE FROM outreach_disabled_logins WHERE user_id = $1`, [target.id]);
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    if (role !== target.role) await recordAccessChange(actor, target, "role.changed", { from: target.role, to: role });
    if (active !== (target.status !== "inactive")) await recordAccessChange(actor, target, active ? "user.enabled" : "user.disabled", {});

    try {
      const { driveIsConfigured, ensureDriveResolved } = await import("./outreach-video/drive-client.js");
      await ensureDriveResolved();
      if (driveIsConfigured()) {
        const { findUserByEmail, setUserRole, setUserActive, videoRoleForNerveRole } = await import("./outreach-video/users.js");
        const record = await findUserByEmail(target.email);
        if (record && !record.deletedAt) {
          const videoRole = videoRoleForNerveRole(role, "outreach");
          if (videoRole && videoRole !== record.role) await setUserRole(record.id, videoRole);
          if (record.active !== (active && !!videoRole)) await setUserActive(record.id, active && !!videoRole);
        }
      }
    } catch (err) {
      console.error("Outreach: account updated, but its video workflow record could not follow:", err);
    }
    res.json({ updated: true, role, active });
  }));

  app.put("/api/outreach/access/users/:id/states", asyncHandler(async (req, res) => {
    const actor = requireAdmin(res); if (!actor) return;
    const target = await configurableTarget(res, actor, getSingleParam(req.params.id)); if (!target) return;
    const parsed = parseStates((req.body ?? {}) as Record<string, unknown>);
    if (!parsed.ok) return sendError(res, 400, parsed.problem);
    /* Choosing someone's states for the first time configures them; their
       tabs are carried over as they effectively were, so picking states never
       takes a tab away. */
    const legacy = (await listUserCapabilities(target.id)).filter(k => k.startsWith("outreach:"));
    await saveUserStates(target.id, { allStates: parsed.allStates, states: parsed.states },
      defaultTabLevels(target.role, legacy), actor.id);
    await recordAccessChange(actor, target, "states.saved", { allStates: parsed.allStates, states: parsed.states });
    res.json({ access: await resolveOutreachAccess({ id: target.id, role: target.role, team: target.team }) });
  }));
}
