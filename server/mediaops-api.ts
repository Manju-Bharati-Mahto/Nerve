// ═══════════════════════════════════════════════════════════════════════════
// NERVE MEDIA OPS — REST API  (/api/v1/media/*)   PRD/SRS v1.0 §13
// ═══════════════════════════════════════════════════════════════════════════
// Phase 1 (kills WhatsApp + Excel): Projects, Deliverables (+versions/approvals),
// Daily Reporting (+review queue), Dashboard, and the reference lookups the
// prototype needs. Business rules (BR-*) and validation (VR-*) are enforced here,
// server-side, per the §16 deny-by-default permission model.
//
// Identity: res.locals.currentUser is the authenticated Nerve user. A Media Ops
// "user" is a Nerve user with team = 'media'; role maps admin→admin,
// sub_admin→team_lead, user→employee (super_admin sees everything).
// ═══════════════════════════════════════════════════════════════════════════
import type express from "express";
import { pool } from "./db.js";
import { hashPassword, verifyPassword } from "./password.js";

type Handlers = {
  asyncHandler: (fn: (req: express.Request, res: express.Response, next: express.NextFunction) => Promise<unknown>) =>
    (req: express.Request, res: express.Response, next: express.NextFunction) => void;
  sendError: (res: express.Response, status: number, message: string) => void;
  getSingleParam: (v: string | string[]) => string;
};

interface CurrentUser { id: string; role: string; team: string | null; full_name?: string; email?: string; }

// ── §16 role mapping + permission model ─────────────────────────────────────
type MoRole = "admin" | "team_lead" | "employee" | null;
function moRoleOf(u: CurrentUser): MoRole {
  if (u.role === "super_admin") return "admin";      // platform superuser → full media-ops access
  if (u.team !== "media") return null;               // not on the media crew
  if (u.role === "admin") return "admin";
  if (u.role === "sub_admin") return "team_lead";
  return "employee";                                  // 'user'
}
const isMoAdmin = (u: CurrentUser) => moRoleOf(u) === "admin";
const isMoTL = (u: CurrentUser) => moRoleOf(u) === "team_lead";

export function registerMediaOpsApi(app: express.Express, h: Handlers) {
  const { asyncHandler, sendError, getSingleParam } = h;
  const P = "/api/v1/media";

  // Guard: every media-ops route requires a media-team member (or super admin).
  function requireMedia(res: express.Response): CurrentUser | null {
    const u = res.locals.currentUser as CurrentUser;
    if (!moRoleOf(u)) { sendError(res, 403, "Media Crew access only."); return null; }
    return u;
  }

  // Per-user module access (allowed_modules). Admins bypass; NULL = unrestricted
  // (role-based). Backend defense-in-depth behind the client's nav/route gating.
  async function requireModule(res: express.Response, u: CurrentUser, key: string): Promise<boolean> {
    if (isMoAdmin(u)) return true;
    const row = (await pool.query(`SELECT allowed_modules FROM mo_user_profiles WHERE user_id=$1`, [u.id])).rows[0];
    const am = row?.allowed_modules;
    if (!Array.isArray(am) || am.includes(key)) return true;
    sendError(res, 403, `Your account has no access to the "${key}" module.`);
    return false;
  }

  // Append-only audit (FR-13). Never throws into the request path.
  async function audit(actor: CurrentUser, action: string, entityType: string, entityId: number | null,
                       before: unknown, after: unknown, req: express.Request) {
    try {
      await pool.query(
        `INSERT INTO mo_audit_logs (actor_id, actor_role, action, entity_type, entity_id, before, after, ip, user_agent)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [actor.id, actor.role, action, entityType, entityId,
         before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null,
         req.ip ?? null, (req.headers["user-agent"] as string) ?? null],
      );
    } catch { /* audit must never break the request */ }
  }

  // ── Reference lookups (one call powers all pickers) ───────────────────────
  app.get(`${P}/lookups`, asyncHandler(async (_req, res) => {
    if (!requireMedia(res)) return;
    const q = (t: string, order = "id") => pool.query(`SELECT * FROM ${t} ORDER BY ${order}`);
    const [types, dtypes, tcats, ecats, ltypes, caps, skills, duties, ay, campuses, depts, autos] = await Promise.all([
      q("mo_project_types", "sort_order"), q("mo_deliverable_types", "sort_order"), q("mo_task_categories", "sort_order"),
      q("mo_equipment_categories", "sort_order"), q("mo_leave_types"), q("mo_capacity_roles"), q("mo_skills"),
      q("mo_duty_flags"), q("mo_academic_years"), q("mo_campuses"), q("mo_departments"), q("mo_automation_rules"),
    ]);
    // Media-team roster (people pickers). Reuses the global users table.
    const people = await pool.query(
      `SELECT u.id, u.full_name, u.email, u.role, u.avatar_url,
              p.designation, p.mo_role, p.color
         FROM users u LEFT JOIN mo_user_profiles p ON p.user_id = u.id
        WHERE u.team = 'media' ORDER BY u.full_name`);
    res.json({
      project_types: types.rows, deliverable_types: dtypes.rows, task_categories: tcats.rows,
      equipment_categories: ecats.rows, leave_types: ltypes.rows, capacity_roles: caps.rows, skills: skills.rows,
      duty_flags: duties.rows, academic_years: ay.rows, campuses: campuses.rows, departments: depts.rows,
      automation_rules: autos.rows, people: people.rows,
    });
  }));

  // ── Bulk state (Part B hydration) ─────────────────────────────────────────
  // Returns the Phase-1 transactional dataset in the prototype's exact shape so
  // the client can overlay it onto its seed on boot. User-ref columns are emitted
  // as the prototype's INTEGER ids (media crew live in the shared users table as
  // 'mo-uN'); to_jsonb keeps DATE/timestamp columns as clean strings (no tz drift).
  const uidToInt = (v: unknown) =>
    typeof v === "string" && v.startsWith("mo-u") ? parseInt(v.slice(4), 10) : v;
  const STATE: [string, string, string | null, string[]][] = [
    ["projects", "mo_projects", "deleted_at IS NULL", ["owner_id", "created_by"]],
    ["project_assignments", "mo_project_assignments", "removed_at IS NULL", ["user_id", "assigned_by"]],
    ["deliverables", "mo_deliverables", "deleted_at IS NULL", ["owner_id"]],
    ["deliverable_versions", "mo_deliverable_versions", null, ["submitted_by", "reviewed_by"]],
    ["drive_links", "mo_drive_links", null, ["added_by"]],
    ["daily_reports", "mo_daily_reports", null, ["user_id", "reviewed_by"]],
    ["report_tasks", "mo_report_tasks", null, []],
    // Phase 2 — equipment, shoots, leave
    ["vendors", "mo_vendors", null, []],
    ["equipment_categories", "mo_equipment_categories", null, []],
    ["equipment_items", "mo_equipment_items", "deleted_at IS NULL", []],
    ["equipment_kits", "mo_equipment_kits", null, []],
    ["kit_items", "mo_kit_items", null, []],
    ["equipment_bookings", "mo_equipment_bookings", null, ["user_id", "created_by"]],
    ["equipment_transactions", "mo_equipment_transactions", null, ["holder_id", "recorded_by"]],
    ["maintenance_records", "mo_maintenance_records", null, ["reported_by"]],
    ["shoots", "mo_shoots", null, []],
    ["shoot_crew", "mo_shoot_crew", null, ["user_id", "replaced_user_id"]],
    ["leave_types", "mo_leave_types", null, []],
    ["leave_requests", "mo_leave_requests", null, ["user_id", "decided_by"]],
    ["leave_replacements", "mo_leave_replacements", null, ["replacement_user_id"]],
    ["holidays", "mo_holidays", null, []],
    // Phase 3 — boards, KRA, analytics, comments (cards handled separately below)
    ["labels", "mo_labels", null, []],
    ["boards", "mo_boards", null, ["created_by"]],
    ["board_columns", "mo_board_columns", null, []],
    ["kra_cycles", "mo_kra_cycles", null, []],
    ["kras", "mo_kras", null, ["user_id"]],
    ["kra_reviews", "mo_kra_reviews", null, ["reviewer_id"]],
    ["performance_snapshots", "mo_performance_snapshots", null, ["user_id"]],
    ["comments", "mo_comments", null, ["user_id"]],
    ["saved_views", "mo_saved_views", null, ["user_id"]],
    ["automation_rules", "mo_automation_rules", null, ["updated_by"]],
    // Org structure (§11.1) — drives real TL scoping (team_members) + custodian duty (user_duties).
    ["teams", "mo_teams", null, ["lead_user_id"]],
    ["team_members", "mo_team_members", null, ["user_id"]],
    ["duty_flags", "mo_duty_flags", null, []],
    ["user_duties", "mo_user_duties", null, ["user_id", "granted_by"]],
    ["skills", "mo_skills", null, []],
    ["user_skills", "mo_user_skills", null, ["user_id"]],
  ];
  app.get(`${P}/state`, asyncHandler(async (_req, res) => {
    const u = requireMedia(res); if (!u) return;
    // Stable {real user id → prototype integer id} map for the media crew (+ the
    // current user if they aren't on the media team, e.g. super_admin). Used for
    // BOTH the user-ref columns and the roster, so identities line up even for real
    // (non-'mo-uN') users. This roster REPLACES the prototype's seed users.
    const crew = (await pool.query(
      `SELECT u.id, u.full_name, u.email, u.role, u.avatar_url, u.created_at,
              p.designation, p.joined_on, p.allowed_modules FROM users u LEFT JOIN mo_user_profiles p ON p.user_id=u.id
        WHERE u.team='media' ORDER BY u.id`)).rows as Array<Record<string, unknown>>;
    if (!crew.some((r) => r.id === u.id))
      crew.unshift({ id: u.id, full_name: u.full_name ?? "You", email: u.email ?? "", role: u.role, avatar_url: null });
    let ctr = 900;
    const idMap = new Map<string, number>();
    for (const r of crew) { const m = /^mo-u(\d+)$/.exec(String(r.id)); idMap.set(String(r.id), m ? Number(m[1]) : ctr++); }
    const toInt = (v: unknown) => (typeof v === "string" && idMap.has(v)) ? idMap.get(v)! : uidToInt(v);
    const roleMap: Record<string, string> = { super_admin: "admin", admin: "admin", sub_admin: "team_lead", user: "employee" };

    const out: Record<string, unknown> = {};
    for (const [key, table, where, refs] of STATE) {
      const { rows } = await pool.query(`SELECT to_jsonb(t) AS row FROM ${table} t${where ? " WHERE " + where : ""}`);
      out[key] = rows.map((r) => {
        const o = r.row as Record<string, unknown>;
        for (const f of refs) o[f] = toInt(o[f]);
        return o;
      });
    }
    // Kanban cards — reassemble the prototype's embedded arrays from child tables.
    const cards = await pool.query(`
      SELECT to_jsonb(c) || jsonb_build_object(
        'assignees', COALESCE((SELECT jsonb_agg(a.user_id) FROM mo_card_assignees a WHERE a.card_id=c.id),'[]'::jsonb),
        'labels',    COALESCE((SELECT jsonb_agg(cl.label_id) FROM mo_card_labels cl WHERE cl.card_id=c.id),'[]'::jsonb),
        'checklist', COALESCE((SELECT jsonb_agg(jsonb_build_object('text',ci.text,'is_done',ci.is_done) ORDER BY ci.sort_order)
                               FROM mo_card_checklist_items ci WHERE ci.card_id=c.id),'[]'::jsonb)
      ) AS row FROM mo_cards c WHERE c.archived_at IS NULL`);
    out.cards = cards.rows.map((r) => {
      const o = r.row as Record<string, unknown>;
      o.created_by = toInt(o.created_by);
      o.assignees = (o.assignees as unknown[]).map(toInt);
      return o;
    });
    // Task/Assignment layer — embed the assignee list (like cards).
    const assigns = await pool.query(`
      SELECT to_jsonb(a) || jsonb_build_object(
        'assignees', COALESCE((SELECT jsonb_agg(au.user_id) FROM mo_assignment_users au WHERE au.assignment_id=a.id),'[]'::jsonb)
      ) AS row FROM mo_assignments a`);
    out.assignments = assigns.rows.map((r) => {
      const o = r.row as Record<string, unknown>;
      o.assigned_by = toInt(o.assigned_by);
      o.assignees = (o.assignees as unknown[]).map(toInt);
      return o;
    });
    // Real roster (replaces the prototype's seed users) + the current identity.
    out.users = crew.map((r) => {
      const name = String(r.full_name ?? "User");
      return {
        id: idMap.get(String(r.id)), real_id: r.id, full_name: name, email: r.email ?? "",
        role: roleMap[String(r.role)] ?? "employee",
        initials: (name.split(/\s+/).map((w) => w[0] || "").join("").slice(0, 2).toUpperCase()) || "?",
        color: "#3B9B76", avatar_url: r.avatar_url ?? null, is_active: true,
        designation: r.designation ?? "", joined_on: r.joined_on ?? (r.created_at ? String(r.created_at).slice(0, 10) : null),
        allowed_modules: Array.isArray(r.allowed_modules) ? r.allowed_modules : null,
      };
    });
    out.me = idMap.get(u.id);
    // Server-persisted notifications for this user (written by the automation engine).
    const notifs = await pool.query(`SELECT * FROM mo_notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50`, [u.id]);
    out.notifications = notifs.rows.map((n) => ({ ...n, user_id: idMap.get(u.id) }));
    // The prototype expects a tags array on each project (seed had one); real
    // projects have none — default to [] so viewProject's `p.tags.map` never crashes.
    for (const p of (out.projects as Array<Record<string, unknown>>)) if (!Array.isArray(p.tags)) p.tags = [];
    res.json(out);
  }));

  // ═════════════════════════ PROJECTS (§7.3) ══════════════════════════════
  const PROJ_TRANSITIONS: Record<string, string[]> = {
    proposed: ["approved", "cancelled"], approved: ["planning", "in_production", "on_hold", "cancelled"],
    planning: ["in_production", "on_hold", "cancelled"], in_production: ["in_review", "delivered", "on_hold", "cancelled"],
    in_review: ["in_production", "delivered", "on_hold", "cancelled"], delivered: ["completed", "in_review"],
    completed: ["archived"], archived: [], on_hold: ["planning", "in_production", "cancelled"], cancelled: [],
  };

  app.get(`${P}/projects`, asyncHandler(async (_req, res) => {
    if (!requireMedia(res)) return;
    const { rows } = await pool.query(`
      SELECT p.*, t.name AS type_name, t.color AS type_color, t.icon AS type_icon,
        (SELECT json_agg(pa.user_id) FROM mo_project_assignments pa WHERE pa.project_id=p.id AND pa.removed_at IS NULL) AS assignee_ids
      FROM mo_projects p JOIN mo_project_types t ON t.id=p.project_type_id
      WHERE p.deleted_at IS NULL ORDER BY p.created_at DESC`);
    res.json({ projects: rows });
  }));

  app.get(`${P}/projects/:id`, asyncHandler(async (req, res) => {
    if (!requireMedia(res)) return;
    const id = parseInt(getSingleParam(req.params.id), 10);
    const { rows } = await pool.query(`SELECT * FROM mo_projects WHERE id=$1 AND deleted_at IS NULL`, [id]);
    if (!rows[0]) return sendError(res, 404, "Project not found.");
    const [assignments, deliverables, shoots] = await Promise.all([
      pool.query(`SELECT * FROM mo_project_assignments WHERE project_id=$1 AND removed_at IS NULL`, [id]),
      pool.query(`SELECT * FROM mo_deliverables WHERE project_id=$1 AND deleted_at IS NULL ORDER BY due_date`, [id]),
      pool.query(`SELECT * FROM mo_shoots WHERE project_id=$1 ORDER BY shoot_date`, [id]),
    ]);
    res.json({ project: rows[0], assignments: assignments.rows, deliverables: deliverables.rows, shoots: shoots.rows });
  }));

  app.post(`${P}/projects`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    const b = req.body as Record<string, unknown>;
    const name = String(b.name ?? "").trim();
    if (name.length < 3 || name.length > 120) return sendError(res, 400, "VR-6: name must be 3–120 characters.");
    const typeId = Number(b.project_type_id);
    if (!typeId) return sendError(res, 400, "Project type is required.");
    const start = (b.start_date as string) || null, end = (b.end_date as string) || null;
    if (start && end && end < start) return sendError(res, 400, "VR-6: end date must be on or after start date.");
    // BR-11: employees create into 'proposed'; TL/Admin create active immediately.
    const gated = !(isMoAdmin(u) || isMoTL(u));
    const ay = await pool.query(`SELECT id FROM mo_academic_years WHERE is_current LIMIT 1`);
    const ins = await pool.query(
      `INSERT INTO mo_projects (department_id, campus_id, academic_year_id, project_type_id, code, name, description,
         faculty_served, status, priority, owner_id, created_by, start_date, end_date, type_meta, source)
       VALUES (1,1,$1,$2,'PENDING',$3,$4,$5,$6,$7,$8,$8,$9,$10,$11,'app') RETURNING id`,
      [ay.rows[0]?.id ?? null, typeId, name, String(b.description ?? ""), (b.faculty_served as string) || null,
       gated ? "proposed" : "planning", (b.priority as string) || "normal", u.id, start, end,
       JSON.stringify(b.type_meta ?? {})]);
    const id = Number(ins.rows[0].id); // pg returns BIGINT as a string — coerce before arithmetic
    const code = `MC-2627-${100 + id}`;
    await pool.query(`UPDATE mo_projects SET code=$1 WHERE id=$2`, [code, id]);
    // Creator becomes owner + PM (BR-2).
    await pool.query(
      `INSERT INTO mo_project_assignments (project_id, user_id, capacity_role_id, is_project_manager, assigned_by)
       VALUES ($1,$2,(SELECT id FROM mo_capacity_roles WHERE name='Coordinator' LIMIT 1),true,$2)`, [id, u.id]);
    // #8/#10: assign additional crew (real user ids) — only a TL/Admin may assign others.
    const assignees = Array.isArray(b.assignees) ? (b.assignees as unknown[]).map(String) : [];
    if (assignees.length && (isMoAdmin(u) || isMoTL(u))) {
      for (const uid of assignees) {
        if (uid === u.id) continue; // creator already assigned
        await pool.query(`INSERT INTO mo_project_assignments (project_id, user_id, assigned_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [id, uid, u.id]);
      }
    }
    // FR-3.2: create deliverables from the SELECTED template items (#2 — per-item
    // checkboxes), or the whole set if no selection was sent. template_config (the
    // richer form: per-item owners/priority/estimated hours) supersedes template_items
    // and ALSO auto-generates one mo_assignments record per owner, so the work lands
    // in each owner's My Day → Today's Assignments — no manual assignment step.
    let made = 0, assignmentsMade = 0;
    type TplCfg = { id: number; owners: string[]; priority: string; est_hours: number | null };
    const cfg: TplCfg[] | null = Array.isArray(b.template_config)
      ? (b.template_config as Array<Record<string, unknown>>).map((c) => ({
          id: Number(c.id),
          owners: Array.isArray(c.owners) ? (c.owners as unknown[]).map(String) : [],
          priority: ["urgent", "high", "normal", "low"].includes(String(c.priority)) ? String(c.priority) : "normal",
          est_hours: c.est_hours != null && !Number.isNaN(Number(c.est_hours)) ? Number(c.est_hours) : null,
        }))
      : null;
    const picked = cfg ? cfg.map((c) => c.id) : (Array.isArray(b.template_items) ? (b.template_items as unknown[]).map(Number) : null);
    const tmpl = b.apply_template === false ? { rows: [] as Array<{ id: number }> }
      : await pool.query(`SELECT id FROM mo_project_templates WHERE project_type_id=$1 AND is_active LIMIT 1`, [typeId]);
    if (tmpl.rows[0]) {
      let items = (await pool.query(`SELECT * FROM mo_template_deliverables WHERE template_id=$1`, [tmpl.rows[0].id])).rows;
      if (picked) items = items.filter((it: { id: number }) => picked.includes(Number(it.id)));
      for (const it of items) {
        const c = cfg?.find((x) => x.id === Number(it.id));
        const due = end ? addDays(end, it.days_offset_due) : null;
        const dl = await pool.query(
          `INSERT INTO mo_deliverables (project_id, deliverable_type_id, title, owner_id, due_date, unit, weight, status)
           SELECT $1,$2,$3,$4,$5, dt.default_unit, $6,'not_started' FROM mo_deliverable_types dt WHERE dt.id=$2
           RETURNING id, title`,
          [id, it.deliverable_type_id, String(it.title_pattern).replace("{project}", name),
           c?.owners[0] || u.id, due, it.default_weight]);
        made++;
        // One assignment per owner (independent status per person).
        for (const owner of (c?.owners ?? [])) {
          const asg = await pool.query(
            `INSERT INTO mo_assignments (project_id, deliverable_id, title, assigned_by, priority, status, start_date, due_date, estimated_hours)
             VALUES ($1,$2,$3,$4,$5,'not_started',$6,$7,$8) RETURNING id`,
            [id, dl.rows[0].id, dl.rows[0].title, u.id, c?.priority ?? "normal", start ?? null, due, c?.est_hours ?? null]);
          await pool.query(`INSERT INTO mo_assignment_users (assignment_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [asg.rows[0].id, owner]);
          assignmentsMade++;
        }
      }
    }
    await audit(u, "project.created", "project", id, null,
      { name, status: gated ? "proposed" : "planning", deliverables_created: made, assignments_created: assignmentsMade }, req);
    const { rows } = await pool.query(`SELECT * FROM mo_projects WHERE id=$1`, [id]);
    res.status(201).json({ project: rows[0], deliverables_created: made });
  }));

  app.post(`${P}/projects/:id/status`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    const id = parseInt(getSingleParam(req.params.id), 10);
    const to = String((req.body as Record<string, unknown>).status ?? "");
    const cur = await pool.query(`SELECT status, owner_id FROM mo_projects WHERE id=$1`, [id]);
    if (!cur.rows[0]) return sendError(res, 404, "Project not found.");
    const from = cur.rows[0].status as string;
    if (!(PROJ_TRANSITIONS[from] ?? []).includes(to))
      return sendError(res, 400, `BR-1: ${from} → ${to} is not a valid transition.`);
    // §16: TL/Admin (or PM/owner) may move status; only Admin may archive.
    const isOwnerPM = cur.rows[0].owner_id === u.id;
    if (to === "archived" && !isMoAdmin(u)) return sendError(res, 403, "Only Admin may archive (BR-1).");
    if (!(isMoAdmin(u) || isMoTL(u) || isOwnerPM)) return sendError(res, 403, "You cannot change this project's status.");
    await pool.query(`UPDATE mo_projects SET status=$1, archived_at=CASE WHEN $1='archived' THEN NOW() ELSE archived_at END, updated_at=NOW() WHERE id=$2`, [to, id]);
    await audit(u, "project.status_changed", "project", id, { status: from }, { status: to }, req);
    res.json({ ok: true, status: to });
  }));

  app.post(`${P}/projects/:id/assignments`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    if (!(isMoAdmin(u) || isMoTL(u))) return sendError(res, 403, "Only a Team Lead or Admin may assign crew.");
    const id = parseInt(getSingleParam(req.params.id), 10);
    const b = req.body as Record<string, unknown>;
    await pool.query(
      `INSERT INTO mo_project_assignments (project_id, user_id, capacity_role_id, is_project_manager, assigned_by)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
      [id, String(b.user_id), b.capacity_role_id ? Number(b.capacity_role_id) : null, !!b.is_project_manager, u.id]);
    await audit(u, "project.assignment_added", "project", id, null, { user_id: b.user_id }, req);
    res.status(201).json({ ok: true });
  }));

  // ═════════════════════════ DELIVERABLES (§7.4) ══════════════════════════
  const DELIV_TRANSITIONS: Record<string, string[]> = {
    not_started: ["in_progress", "not_required", "cancelled"], in_progress: ["in_review", "not_required", "cancelled"],
    in_review: ["approved", "changes_requested", "cancelled"], changes_requested: ["in_progress", "in_review", "cancelled"],
    approved: ["delivered", "changes_requested"], delivered: [], not_required: ["not_started"], cancelled: ["not_started"],
  };

  app.post(`${P}/projects/:id/deliverables`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    const pid = parseInt(getSingleParam(req.params.id), 10);
    const b = req.body as Record<string, unknown>;
    const title = String(b.title ?? "").trim();
    if (!title) return sendError(res, 400, "Title is required.");
    const typeId = Number(b.deliverable_type_id);
    const ins = await pool.query(
      `INSERT INTO mo_deliverables (project_id, deliverable_type_id, title, owner_id, due_date, quantity_target, unit, spec_notes, weight, status)
       SELECT $1,$2,$3,$4,$5,$6, dt.default_unit, $7, dt.default_weight, 'not_started'
       FROM mo_deliverable_types dt WHERE dt.id=$2 RETURNING *`,
      [pid, typeId, title, (b.owner_id as string) || u.id, (b.due_date as string) || null,
       b.quantity_target ? Number(b.quantity_target) : null, String(b.spec_notes ?? "")]);
    // #7: optional Drive link attached to the new deliverable.
    const url = String(b.drive_url ?? "").trim();
    if (url && /^https:\/\/(drive|docs)\.google\.com\//.test(url))
      await pool.query(`INSERT INTO mo_drive_links (entity_type, entity_id, label, url, added_by, validation_status, last_validated_at)
        VALUES ('deliverable',$1,$2,$3,$4,'ok',NOW())`, [ins.rows[0].id, title, url, u.id]);
    await audit(u, "deliverable.created", "deliverable", ins.rows[0].id, null, { title }, req);
    res.status(201).json({ deliverable: ins.rows[0] });
  }));

  app.patch(`${P}/deliverables/:id`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    const id = parseInt(getSingleParam(req.params.id), 10);
    const b = req.body as Record<string, unknown>;
    const cur = await pool.query(`SELECT * FROM mo_deliverables WHERE id=$1`, [id]);
    if (!cur.rows[0]) return sendError(res, 404, "Deliverable not found.");
    const fields: string[] = [], vals: unknown[] = []; let i = 1;
    for (const k of ["title", "owner_id", "due_date", "quantity_target", "quantity_delivered", "spec_notes",
                     "social_status", "social_post_url", "mail_status"]) {
      if (k in b) { fields.push(`${k}=$${i++}`); vals.push(b[k]); }
    }
    if (!fields.length) return res.json({ deliverable: cur.rows[0] });
    vals.push(id);
    const { rows } = await pool.query(`UPDATE mo_deliverables SET ${fields.join(",")} WHERE id=$${i} RETURNING *`, vals);
    await audit(u, "deliverable.updated", "deliverable", id, cur.rows[0], rows[0], req);
    res.json({ deliverable: rows[0] });
  }));

  // Submit a new immutable version for review.
  app.post(`${P}/deliverables/:id/versions`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    const id = parseInt(getSingleParam(req.params.id), 10);
    const url = String((req.body as Record<string, unknown>).drive_url ?? "").trim();
    if (!/^https:\/\/(drive|docs)\.google\.com\//.test(url)) return sendError(res, 400, "VR-4: must be a Google Drive/Docs link.");
    const last = await pool.query(`SELECT COALESCE(MAX(version_no),0) AS n FROM mo_deliverable_versions WHERE deliverable_id=$1`, [id]);
    const next = (last.rows[0].n as number) + 1;
    const ins = await pool.query(
      `INSERT INTO mo_deliverable_versions (deliverable_id, version_no, drive_url, note, submitted_by, review_status)
       VALUES ($1,$2,$3,$4,$5,'pending') RETURNING *`,
      [id, next, url, String((req.body as Record<string, unknown>).note ?? ""), u.id]);
    await pool.query(`UPDATE mo_deliverables SET status='in_review' WHERE id=$1`, [id]);
    await audit(u, "deliverable.version_submitted", "deliverable_version", ins.rows[0].id, null, { version_no: next }, req);
    res.status(201).json({ version: ins.rows[0] });
  }));

  // Review latest version — BR-5: a version cannot be approved by its submitter.
  app.post(`${P}/deliverables/:id/review`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    const id = parseInt(getSingleParam(req.params.id), 10);
    const outcome = String((req.body as Record<string, unknown>).outcome ?? ""); // 'approved' | 'changes_requested'
    const comment = String((req.body as Record<string, unknown>).comment ?? "");
    const v = await pool.query(`SELECT * FROM mo_deliverable_versions WHERE deliverable_id=$1 ORDER BY version_no DESC LIMIT 1`, [id]);
    if (!v.rows[0]) return sendError(res, 400, "No version to review.");
    if (v.rows[0].submitted_by === u.id) return sendError(res, 403, "BR-5: a version cannot be reviewed by its submitter.");
    const isPM = await pool.query(`SELECT 1 FROM mo_project_assignments a JOIN mo_deliverables d ON d.project_id=a.project_id
      WHERE d.id=$1 AND a.user_id=$2 AND a.is_project_manager AND a.removed_at IS NULL`, [id, u.id]);
    if (!(isMoAdmin(u) || isMoTL(u) || isPM.rows[0])) return sendError(res, 403, "BR-5: reviewer must be PM, Team Lead or Admin.");
    if (!["approved", "changes_requested"].includes(outcome)) return sendError(res, 400, "Invalid outcome.");
    await pool.query(`UPDATE mo_deliverable_versions SET review_status=$1, reviewed_by=$2, reviewed_at=NOW(), review_comment=$3 WHERE id=$4`,
      [outcome, u.id, comment, v.rows[0].id]);
    await pool.query(`UPDATE mo_deliverables SET status=$1 WHERE id=$2`, [outcome, id]);
    await audit(u, "deliverable.version_reviewed", "deliverable_version", v.rows[0].id, { review_status: "pending" }, { review_status: outcome }, req);
    res.json({ ok: true, status: outcome });
  }));

  // Mark delivered — BR-6: requires an approved latest version unless the type is review-exempt.
  app.post(`${P}/deliverables/:id/deliver`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    const id = parseInt(getSingleParam(req.params.id), 10);
    const d = await pool.query(`SELECT d.*, dt.review_exempt FROM mo_deliverables d JOIN mo_deliverable_types dt ON dt.id=d.deliverable_type_id WHERE d.id=$1`, [id]);
    if (!d.rows[0]) return sendError(res, 404, "Deliverable not found.");
    if (!d.rows[0].review_exempt) {
      const v = await pool.query(`SELECT review_status FROM mo_deliverable_versions WHERE deliverable_id=$1 ORDER BY version_no DESC LIMIT 1`, [id]);
      if (v.rows[0]?.review_status !== "approved") return sendError(res, 400, "BR-6: Delivered requires an approved latest version.");
    }
    await pool.query(`UPDATE mo_deliverables SET status='delivered', completed_at=CURRENT_DATE,
      quantity_delivered=COALESCE(quantity_delivered, quantity_target) WHERE id=$1`, [id]);
    await audit(u, "deliverable.delivered", "deliverable", id, { status: d.rows[0].status }, { status: "delivered" }, req);
    res.json({ ok: true });
  }));

  // ═════════════════════════ DAILY REPORTING (§7.2) ═══════════════════════
  // Get (auto-create draft) a report + its tasks for a date.
  app.get(`${P}/reports`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    const q = req.query as Record<string, string>;
    const date = q.date || new Date().toISOString().slice(0, 10);
    const userId = q.user || u.id;
    if (userId !== u.id && !(isMoAdmin(u) || isMoTL(u))) return sendError(res, 403, "Out of scope (§16).");
    let r = await pool.query(`SELECT * FROM mo_daily_reports WHERE user_id=$1 AND report_date=$2`, [userId, date]);
    if (!r.rows[0]) {
      r = await pool.query(`INSERT INTO mo_daily_reports (user_id, report_date, status) VALUES ($1,$2,'draft') RETURNING *`, [userId, date]);
    }
    const tasks = await pool.query(`SELECT * FROM mo_report_tasks WHERE daily_report_id=$1 ORDER BY sort_order, start_time`, [r.rows[0].id]);
    res.json({ report: r.rows[0], tasks: tasks.rows });
  }));

  // Review queue (TL/Admin) — exception-based (D2).
  app.get(`${P}/reports/queue`, asyncHandler(async (_req, res) => {
    const u = requireMedia(res); if (!u) return;
    if (!(isMoAdmin(u) || isMoTL(u))) return sendError(res, 403, "Team Lead or Admin only.");
    const { rows } = await pool.query(`SELECT * FROM mo_daily_reports WHERE status IN ('flagged','submitted','returned') ORDER BY report_date`);
    res.json({ reports: rows });
  }));

  // Log a task (auto-creates today's draft report). VR-1/3/4 + FR-2.8.
  app.post(`${P}/reports/:date/tasks`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    const date = getSingleParam(req.params.date);
    const b = req.body as Record<string, unknown>;
    const start = String(b.start_time ?? ""), end = String(b.end_time ?? "");
    const mins = t2m(end) - t2m(start);
    if (mins <= 0) return sendError(res, 400, "VR-1: end must be after start.");
    if (b.quantity && !b.unit) return sendError(res, 400, "VR-3: unit is required when quantity is present.");
    if (b.status === "blocked" && !String(b.blocker_note ?? "").trim()) return sendError(res, 400, "FR-2.8: a blocker note is required.");
    let r = await pool.query(`SELECT * FROM mo_daily_reports WHERE user_id=$1 AND report_date=$2`, [u.id, date]);
    if (!r.rows[0]) r = await pool.query(`INSERT INTO mo_daily_reports (user_id, report_date, status) VALUES ($1,$2,'draft') RETURNING *`, [u.id, date]);
    const rid = r.rows[0].id as number;
    const n = await pool.query(`SELECT COUNT(*)::int AS c FROM mo_report_tasks WHERE daily_report_id=$1`, [rid]);
    const ins = await pool.query(
      `INSERT INTO mo_report_tasks (daily_report_id, project_id, task_category_id, deliverable_id, description,
         start_time, end_time, minutes, progress_before, progress_after, quantity, unit, status, blocker_note, sort_order, evidence)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [rid, b.project_id ? Number(b.project_id) : null, b.task_category_id ? Number(b.task_category_id) : null,
       b.deliverable_id ? Number(b.deliverable_id) : null, String(b.description ?? ""), start, end, mins,
       b.progress_before ?? null, b.progress_after ?? null, b.quantity ? Number(b.quantity) : null, (b.unit as string) || null,
       (b.status as string) || "done", String(b.blocker_note ?? ""), n.rows[0].c,
       JSON.stringify(b.evidence ?? [])]);
    await refreshReportTotal(rid);
    await audit(u, "report.task_logged", "daily_report", rid, null, { minutes: mins }, req);
    res.status(201).json({ task: ins.rows[0] });
  }));

  app.patch(`${P}/tasks/:id`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    const id = parseInt(getSingleParam(req.params.id), 10);
    const b = req.body as Record<string, unknown>;
    const cur = await pool.query(`SELECT * FROM mo_report_tasks WHERE id=$1`, [id]);
    if (!cur.rows[0]) return sendError(res, 404, "Task not found.");
    const rpt = (await pool.query(`SELECT user_id, status FROM mo_daily_reports WHERE id=$1`, [cur.rows[0].daily_report_id])).rows[0];
    const isReviewer = isMoAdmin(u) || isMoTL(u);
    if (rpt && rpt.user_id !== u.id && !isReviewer) return sendError(res, 403, "You can only edit your own tasks.");
    if (rpt && !["draft", "returned"].includes(rpt.status) && !isReviewer)
      return sendError(res, 403, "BR-9: this report is locked — a Team Lead must return/unlock it before its tasks can be edited.");
    const start = (b.start_time as string) ?? cur.rows[0].start_time, end = (b.end_time as string) ?? cur.rows[0].end_time;
    const mins = t2m(end) - t2m(start);
    await pool.query(
      `UPDATE mo_report_tasks SET project_id=$1, task_category_id=$2, deliverable_id=$3, description=$4,
         start_time=$5, end_time=$6, minutes=$7, quantity=$8, unit=$9, status=$10, blocker_note=$11 WHERE id=$12`,
      [b.project_id ? Number(b.project_id) : cur.rows[0].project_id, b.task_category_id ? Number(b.task_category_id) : cur.rows[0].task_category_id,
       b.deliverable_id ? Number(b.deliverable_id) : cur.rows[0].deliverable_id, (b.description as string) ?? cur.rows[0].description,
       start, end, mins, b.quantity !== undefined ? b.quantity : cur.rows[0].quantity, (b.unit as string) ?? cur.rows[0].unit,
       (b.status as string) ?? cur.rows[0].status, (b.blocker_note as string) ?? cur.rows[0].blocker_note, id]);
    await refreshReportTotal(cur.rows[0].daily_report_id);
    await audit(u, "report.task_edited", "report_task", id, cur.rows[0], b, req);
    res.json({ ok: true });
  }));

  app.delete(`${P}/tasks/:id`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    const id = parseInt(getSingleParam(req.params.id), 10);
    const cur = await pool.query(`SELECT * FROM mo_report_tasks WHERE id=$1`, [id]);
    if (!cur.rows[0]) return sendError(res, 404, "Task not found.");
    const rpt = (await pool.query(`SELECT user_id, status FROM mo_daily_reports WHERE id=$1`, [cur.rows[0].daily_report_id])).rows[0];
    const isReviewer = isMoAdmin(u) || isMoTL(u);
    if (rpt && rpt.user_id !== u.id && !isReviewer) return sendError(res, 403, "You can only delete your own tasks.");
    if (rpt && !["draft", "returned"].includes(rpt.status) && !isReviewer)
      return sendError(res, 403, "BR-9: this report is locked — a Team Lead must return/unlock it before its tasks can be deleted.");
    await pool.query(`DELETE FROM mo_report_tasks WHERE id=$1`, [id]);
    await refreshReportTotal(cur.rows[0].daily_report_id);
    await audit(u, "report.task_deleted", "report_task", id, cur.rows[0], null, req);
    res.json({ ok: true });
  }));

  // Submit — evaluates AUTO-13 flag rules (D2). Flagged reports block auto-approval.
  app.post(`${P}/reports/:date/submit`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    const date = getSingleParam(req.params.date);
    const r = await pool.query(`SELECT * FROM mo_daily_reports WHERE user_id=$1 AND report_date=$2`, [u.id, date]);
    if (!r.rows[0]) return sendError(res, 400, "Nothing to submit — log a task first.");
    if (["submitted", "approved", "auto_approved", "flagged"].includes(r.rows[0].status))
      return sendError(res, 409, "BR-3: this report has already been submitted for the day.");
    const rid = r.rows[0].id as number;
    const tasks = await pool.query(`SELECT * FROM mo_report_tasks WHERE daily_report_id=$1`, [rid]);
    if (!tasks.rows.length) return sendError(res, 400, "Nothing to submit — log a task first.");
    const flags = await evaluateFlags(u.id, date, tasks.rows);
    const status = flags.length ? "flagged" : "submitted";
    await pool.query(`UPDATE mo_daily_reports SET status=$1, submitted_at=NOW(), note=$2, flag_rules=$3, flagged_reason=$4 WHERE id=$5`,
      [status, String((req.body as Record<string, unknown>).note ?? ""), JSON.stringify(flags), flags.join(" · ") || null, rid]);
    await audit(u, "report.submitted", "daily_report", rid, { status: "draft" }, { status }, req);
    res.json({ ok: true, status, flags });
  }));

  // TL/Admin review a report — approve / return / flag.
  app.post(`${P}/reports/:id/review`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    if (!(isMoAdmin(u) || isMoTL(u))) return sendError(res, 403, "Team Lead or Admin only.");
    const id = parseInt(getSingleParam(req.params.id), 10);
    const action = String((req.body as Record<string, unknown>).action ?? ""); // approve | return | flag
    const map: Record<string, string> = { approve: "approved", return: "returned", flag: "flagged" };
    const to = map[action]; if (!to) return sendError(res, 400, "Invalid action.");
    await pool.query(`UPDATE mo_daily_reports SET status=$1, reviewed_by=$2, reviewed_at=NOW(), review_comment=$3 WHERE id=$4`,
      [to, u.id, String((req.body as Record<string, unknown>).comment ?? ""), id]);
    await audit(u, `report.${action}`, "daily_report", id, null, { status: to }, req);
    res.json({ ok: true, status: to });
  }));

  // ═════════════════════════ PHASE 2 — EQUIPMENT / SHOOTS / LEAVE ══════════
  // Prototype sends integer user ids; the shared users table keys crew as 'mo-uN'.
  const toUid = (v: unknown): string | null =>
    v == null ? null : (typeof v === "number" || /^\d+$/.test(String(v))) ? `mo-u${v}` : String(v);

  // ── Shoots (§7.5) ─────────────────────────────────────────────────────────
  app.post(`${P}/projects/:id/shoots`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    if (!(isMoAdmin(u) || isMoTL(u))) {
      const pm = await pool.query(`SELECT 1 FROM mo_project_assignments WHERE project_id=$1 AND user_id=$2 AND is_project_manager AND removed_at IS NULL`,
        [parseInt(getSingleParam(req.params.id), 10), u.id]);
      if (!pm.rows[0]) return sendError(res, 403, "Only a PM, Team Lead or Admin may schedule a shoot.");
    }
    const pid = parseInt(getSingleParam(req.params.id), 10);
    const b = req.body as Record<string, unknown>;
    if (!String(b.title ?? "").trim()) return sendError(res, 400, "Shoot title is required.");
    if (!b.shoot_date) return sendError(res, 400, "Shoot date is required.");
    const ins = await pool.query(
      `INSERT INTO mo_shoots (project_id, title, shoot_date, call_time, end_time, location, location_url, notes, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'planned') RETURNING *`,
      [pid, String(b.title), b.shoot_date, (b.call_time as string) || null, (b.end_time as string) || null,
       (b.location as string) || "TBC", (b.location_url as string) || null, String(b.notes ?? "")]);
    const shoot = ins.rows[0];
    for (const raw of (Array.isArray(b.crew) ? b.crew : [])) {
      await pool.query(`INSERT INTO mo_shoot_crew (shoot_id, user_id, capacity_role_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
        [shoot.id, toUid(raw), 2]);
    }
    await audit(u, "shoot.created", "shoot", shoot.id, null, { title: shoot.title, date: shoot.shoot_date }, req);
    res.status(201).json({ shoot });
  }));

  app.patch(`${P}/shoots/:id`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    const id = parseInt(getSingleParam(req.params.id), 10);
    const b = req.body as Record<string, unknown>;
    const fields: string[] = [], vals: unknown[] = []; let i = 1;
    for (const k of ["title", "shoot_date", "call_time", "end_time", "location", "notes", "status"])
      if (k in b) { fields.push(`${k}=$${i++}`); vals.push(b[k]); }
    if (!fields.length) return res.json({ ok: true });
    vals.push(id);
    const { rows } = await pool.query(`UPDATE mo_shoots SET ${fields.join(",")} WHERE id=$${i} RETURNING *`, vals);
    if (!rows[0]) return sendError(res, 404, "Shoot not found.");
    await audit(u, "shoot.updated", "shoot", id, null, rows[0], req);
    res.json({ shoot: rows[0] });
  }));

  // ── Equipment bookings — AC-7: no double-booking (DB EXCLUDE constraint) ───
  app.post(`${P}/equipment/bookings`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    const b = req.body as Record<string, unknown>;
    const itemId = Number(b.equipment_item_id);
    if (!itemId) return sendError(res, 400, "equipment_item_id is required.");
    const s = b.starts_at as string, e = b.ends_at as string;
    if (!s || !e) return sendError(res, 400, "Booking start and end are required.");
    if (e < s) return sendError(res, 400, "Booking end must be on or after the start.");
    try {
      const ins = await pool.query(
        `INSERT INTO mo_equipment_bookings (equipment_item_id, user_id, shoot_id, project_id, starts_at, ends_at, status, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,'reserved',$2) RETURNING *`,
        [itemId, u.id, b.shoot_id ? Number(b.shoot_id) : null, b.project_id ? Number(b.project_id) : null, s, e]);
      await audit(u, "equipment.booked", "equipment_booking", ins.rows[0].id, null, { item: itemId, s, e }, req);
      res.status(201).json({ booking: ins.rows[0] });
    } catch (err) {
      if ((err as { code?: string }).code === "23P01")
        return sendError(res, 409, "AC-7: this item is already booked for overlapping dates.");
      throw err;
    }
  }));

  app.post(`${P}/equipment/bookings/:id/cancel`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    const id = parseInt(getSingleParam(req.params.id), 10);
    await pool.query(`UPDATE mo_equipment_bookings SET status='cancelled' WHERE id=$1`, [id]);
    await audit(u, "equipment.booking_cancelled", "equipment_booking", id, null, null, req);
    res.json({ ok: true });
  }));

  // ── Checkout / check-in — immutable transaction ledger (§7.6) ─────────────
  app.post(`${P}/equipment/:id/checkout`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    const itemId = parseInt(getSingleParam(req.params.id), 10);
    const b = req.body as Record<string, unknown>;
    const item = await pool.query(`SELECT status FROM mo_equipment_items WHERE id=$1 AND deleted_at IS NULL`, [itemId]);
    if (!item.rows[0]) return sendError(res, 404, "Item not found.");
    if (item.rows[0].status === "checked_out") return sendError(res, 409, "Item is already checked out.");
    const holder = toUid(b.holder_id) ?? u.id;
    const via = ["desktop", "mobile", "kiosk"].includes(String(b.recorded_via)) ? String(b.recorded_via) : "desktop";
    const tx = await pool.query(
      `INSERT INTO mo_equipment_transactions (equipment_item_id, booking_id, holder_id, action, quantity, condition_noted, expected_return_at, occurred_at, recorded_via, recorded_by)
       VALUES ($1,$2,$3,'check_out',1,$4,$5,NOW(),$6,$7) RETURNING *`,
      [itemId, b.booking_id ? Number(b.booking_id) : null, holder, (b.condition_noted as string) || "good",
       (b.expected_return_at as string) || null, via, u.id]);
    await pool.query(`UPDATE mo_equipment_items SET status='checked_out' WHERE id=$1`, [itemId]);
    if (b.booking_id) await pool.query(`UPDATE mo_equipment_bookings SET status='active' WHERE id=$1`, [Number(b.booking_id)]);
    await audit(u, "equipment.checked_out", "equipment_item", itemId, null, { holder }, req);
    res.status(201).json({ transaction: tx.rows[0] });
  }));

  app.post(`${P}/equipment/:id/checkin`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    const itemId = parseInt(getSingleParam(req.params.id), 10);
    const b = req.body as Record<string, unknown>;
    const via = ["desktop", "mobile", "kiosk"].includes(String(b.recorded_via)) ? String(b.recorded_via) : "desktop";
    const cond = (b.condition_noted as string) || "good";
    const tx = await pool.query(
      `INSERT INTO mo_equipment_transactions (equipment_item_id, holder_id, action, quantity, condition_noted, occurred_at, recorded_via, recorded_by)
       VALUES ($1,$2,'check_in',1,$3,NOW(),$4,$5) RETURNING *`,
      [itemId, u.id, cond, via, u.id]);
    const damaged = ["poor", "fair"].includes(cond) || b.damaged === true;
    await pool.query(`UPDATE mo_equipment_items SET status=$2, condition=COALESCE($3,condition) WHERE id=$1`,
      [itemId, damaged ? "maintenance" : "available", cond || null]);
    await pool.query(`UPDATE mo_equipment_bookings SET status='completed' WHERE equipment_item_id=$1 AND status='active'`, [itemId]);
    if (damaged) await pool.query(
      `INSERT INTO mo_maintenance_records (equipment_item_id, kind, description, reported_by, started_at)
       VALUES ($1,'damage_report',$2,$3,CURRENT_DATE)`, [itemId, `Flagged on check-in (condition: ${cond}).`, u.id]);
    await audit(u, "equipment.checked_in", "equipment_item", itemId, null, { condition: cond, damaged }, req);
    res.status(201).json({ transaction: tx.rows[0] });
  }));

  app.post(`${P}/equipment/:id/damage`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    const itemId = parseInt(getSingleParam(req.params.id), 10);
    const b = req.body as Record<string, unknown>;
    const kind = ["maintenance", "repair", "damage_report"].includes(String(b.kind)) ? String(b.kind) : "damage_report";
    const ins = await pool.query(
      `INSERT INTO mo_maintenance_records (equipment_item_id, kind, description, reported_by, started_at)
       VALUES ($1,$2,$3,$4,CURRENT_DATE) RETURNING *`, [itemId, kind, String(b.description ?? ""), u.id]);
    await pool.query(`UPDATE mo_equipment_items SET status='maintenance' WHERE id=$1`, [itemId]);
    await audit(u, "equipment.damage_reported", "equipment_item", itemId, null, { kind }, req);
    res.status(201).json({ record: ins.rows[0] });
  }));

  // ── Leave (§7.8) ──────────────────────────────────────────────────────────
  app.post(`${P}/leave`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    if (!(await requireModule(res, u, "leave"))) return;
    const b = req.body as Record<string, unknown>;
    if (!b.leave_type_id || !b.starts_on || !b.ends_on) return sendError(res, 400, "Leave type and dates are required.");
    if ((b.ends_on as string) < (b.starts_on as string)) return sendError(res, 400, "Leave end must be on or after the start.");
    const ins = await pool.query(
      `INSERT INTO mo_leave_requests (user_id, leave_type_id, starts_on, ends_on, half_day, reason, status)
       VALUES ($1,$2,$3,$4,$5,$6,'pending') RETURNING *`,
      [u.id, Number(b.leave_type_id), b.starts_on, b.ends_on, !!b.half_day, String(b.reason ?? "")]);
    await audit(u, "leave.requested", "leave_request", ins.rows[0].id, null, { s: b.starts_on, e: b.ends_on }, req);
    res.status(201).json({ leave: ins.rows[0] });
  }));

  app.post(`${P}/leave/:id/decision`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    if (!(isMoAdmin(u) || isMoTL(u))) return sendError(res, 403, "Only a Team Lead or Admin may decide leave.");
    const id = parseInt(getSingleParam(req.params.id), 10);
    const decision = String((req.body as Record<string, unknown>).decision ?? "");
    if (!["approved", "rejected", "cancelled"].includes(decision)) return sendError(res, 400, "Invalid decision.");
    await pool.query(`UPDATE mo_leave_requests SET status=$1, decided_by=$2, decided_at=NOW(), decision_note=$3 WHERE id=$4`,
      [decision, u.id, String((req.body as Record<string, unknown>).note ?? ""), id]);
    await audit(u, `leave.${decision}`, "leave_request", id, null, { decision }, req);
    res.json({ ok: true, status: decision });
  }));

  // ═════════════════════════ PHASE 4 — AUTOMATION / AI / ICS ══════════════
  // Automation rules are config, not code (NFR-10) — Admin toggles/edits persist.
  app.patch(`${P}/automation-rules/:id`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    if (!isMoAdmin(u)) return sendError(res, 403, "Only Admin may change automation rules.");
    const id = parseInt(getSingleParam(req.params.id), 10);
    const b = req.body as Record<string, unknown>;
    const cur = await pool.query(`SELECT is_enabled, config FROM mo_automation_rules WHERE id=$1`, [id]);
    if (!cur.rows[0]) return sendError(res, 404, "Rule not found.");
    const enabled = "is_enabled" in b ? !!b.is_enabled : cur.rows[0].is_enabled;
    const config = "config" in b ? JSON.stringify(b.config) : JSON.stringify(cur.rows[0].config);
    await pool.query(`UPDATE mo_automation_rules SET is_enabled=$1, config=$2, updated_by=$3 WHERE id=$4`,
      [enabled, config, u.id, id]);
    await audit(u, "automation.updated", "automation_rule", id, { is_enabled: cur.rows[0].is_enabled }, { is_enabled: enabled }, req);
    res.json({ ok: true, is_enabled: enabled });
  }));

  // AI-1 weekly digest — real anomalies computed from live data (labelled, never auto-commits).
  app.get(`${P}/ai/digest`, asyncHandler(async (_req, res) => {
    if (!requireMedia(res)) return;
    const [reports, overHours, blocked, stalls, fast] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int c FROM mo_daily_reports WHERE report_date >= CURRENT_DATE - 7`),
      pool.query(`SELECT to_char(r.report_date,'YYYY-MM-DD') AS report_date, u.full_name, r.total_minutes FROM mo_daily_reports r
                    JOIN users u ON u.id=r.user_id WHERE r.total_minutes > 840 ORDER BY r.total_minutes DESC LIMIT 5`),
      pool.query(`SELECT t.description, u.full_name FROM mo_report_tasks t
                    JOIN mo_daily_reports r ON r.id=t.daily_report_id JOIN users u ON u.id=r.user_id
                   WHERE t.status='blocked' ORDER BY r.report_date DESC LIMIT 5`),
      pool.query(`SELECT p.name, p.code FROM mo_projects p
                   WHERE p.status IN ('in_production','in_review') AND p.deleted_at IS NULL
                     AND NOT EXISTS (SELECT 1 FROM mo_report_tasks t WHERE t.project_id=p.id
                       AND t.daily_report_id IN (SELECT id FROM mo_daily_reports WHERE report_date >= CURRENT_DATE - 21))
                   LIMIT 5`),
      pool.query(`SELECT d.title, COUNT(v.id)::int versions FROM mo_deliverables d
                    JOIN mo_deliverable_versions v ON v.deliverable_id=d.id
                   GROUP BY d.id, d.title HAVING COUNT(v.id) >= 2 ORDER BY COUNT(v.id) DESC LIMIT 3`),
    ]);
    res.json({
      reports_this_week: reports.rows[0].c,
      needs_attention: overHours.rows.length + blocked.rows.length + stalls.rows.length,
      anomalies: {
        over_hours: overHours.rows.map((r) => `${r.full_name} logged ${(r.total_minutes / 60).toFixed(1)}h on ${String(r.report_date).slice(0, 10)} (above the 14h threshold)`),
        blocked: blocked.rows.map((r) => `${r.full_name}: "${String(r.description).slice(0, 60)}"`),
        stalls: stalls.rows.map((r) => `${r.name} (${r.code}) — no logged activity in 21 days (AUTO-7)`),
      },
      positive: fast.rows.map((r) => `${r.title} iterated through ${r.versions} versions`),
    });
  }));

  // AI-3 duplicate detection — real similarity over live projects (§AUTO-6).
  app.get(`${P}/ai/duplicates`, asyncHandler(async (_req, res) => {
    if (!requireMedia(res)) return;
    const { rows } = await pool.query(
      `SELECT id, name, description, faculty_served, start_date, end_date, code FROM mo_projects
        WHERE deleted_at IS NULL AND status NOT IN ('completed','archived','cancelled')`);
    const norm = (s: string) => new Set(String(s ?? "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 2));
    const jac = (a: Set<string>, b: Set<string>) => { let i = 0; a.forEach((x) => b.has(x) && i++); const u = a.size + b.size - i; return u ? i / u : 0; };
    const overlap = (a: Record<string, unknown>, b: Record<string, unknown>) =>
      a.start_date && a.end_date && b.start_date && b.end_date && !(String(a.end_date) < String(b.start_date) || String(b.end_date) < String(a.start_date));
    const pairs: unknown[] = [];
    for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) {
      const a = rows[i], b = rows[j];
      const t = jac(norm(a.name + " " + a.description), norm(b.name + " " + b.description));
      let score = t;
      if (a.faculty_served && a.faculty_served === b.faculty_served) score += 0.15;
      if (overlap(a, b)) score += 0.15;
      if (score >= 0.5) pairs.push({ a: { id: a.id, name: a.name, code: a.code }, b: { id: b.id, name: b.name, code: b.code },
        score: Math.min(1, score).toFixed(2), reasons: [t >= 0.2 ? "similar title/scope" : null, a.faculty_served === b.faculty_served ? "same faculty" : null, overlap(a, b) ? "overlapping dates" : null].filter(Boolean) });
    }
    pairs.sort((x, y) => Number((y as { score: string }).score) - Number((x as { score: string }).score));
    res.json({ threshold: 0.5, candidates: pairs.slice(0, 8) });
  }));

  // AI-7 equipment demand forecast — upcoming booking load vs inventory per category.
  app.get(`${P}/ai/forecast`, asyncHandler(async (_req, res) => {
    if (!requireMedia(res)) return;
    const [inv, load, shoots] = await Promise.all([
      pool.query(`SELECT c.id, c.name, COUNT(i.id)::int items FROM mo_equipment_categories c
                    LEFT JOIN mo_equipment_items i ON i.category_id=c.id AND i.deleted_at IS NULL AND i.status<>'retired'
                   GROUP BY c.id, c.name`),
      pool.query(`SELECT i.category_id, COUNT(*)::int booked FROM mo_equipment_bookings b
                    JOIN mo_equipment_items i ON i.id=b.equipment_item_id
                   WHERE b.status IN ('reserved','active') AND b.ends_at >= CURRENT_DATE
                   GROUP BY i.category_id`),
      pool.query(`SELECT title, to_char(shoot_date,'YYYY-MM-DD') shoot_date FROM mo_shoots
                   WHERE shoot_date >= CURRENT_DATE AND status<>'cancelled' ORDER BY shoot_date LIMIT 6`),
    ]);
    const loadBy = new Map(load.rows.map((r) => [r.category_id, r.booked]));
    const shortfalls = inv.rows.map((c) => ({ category: c.name, items: c.items, upcoming_bookings: loadBy.get(c.id) ?? 0 }))
      .filter((c) => c.upcoming_bookings >= c.items && c.items > 0)
      .map((c) => ({ ...c, short_by: c.upcoming_bookings - c.items + 1 }));
    res.json({ upcoming_shoots: shoots.rows, shortfalls });
  }));

  // ICS calendar feed (§7.11) — subscribe to shoots + deadlines + leave + holidays.
  app.get(`${P}/calendar/feed.ics`, asyncHandler(async (_req, res) => {
    if (!requireMedia(res)) return;
    const esc = (s: string) => String(s ?? "").replace(/([,;\\])/g, "\\$1").replace(/\n/g, "\\n");
    const d = (s: string) => String(s).slice(0, 10).replace(/-/g, "");
    const [shoots, dls, holidays] = await Promise.all([
      pool.query(`SELECT s.title, s.shoot_date, s.location, p.name pname FROM mo_shoots s
                    JOIN mo_projects p ON p.id=s.project_id WHERE s.status<>'cancelled'`),
      pool.query(`SELECT title, due_date FROM mo_deliverables WHERE due_date IS NOT NULL AND status NOT IN ('delivered','not_required','cancelled')`),
      pool.query(`SELECT name, date FROM mo_holidays`),
    ]);
    const ev: string[] = [];
    const push = (uid: string, date: string, summary: string, loc?: string) =>
      ev.push(`BEGIN:VEVENT\r\nUID:${uid}@nerve.media\r\nDTSTART;VALUE=DATE:${d(date)}\r\nSUMMARY:${esc(summary)}${loc ? `\r\nLOCATION:${esc(loc)}` : ""}\r\nEND:VEVENT`);
    shoots.rows.forEach((s, i) => push(`shoot-${i}`, s.shoot_date, `🎥 ${s.title} — ${s.pname}`, s.location));
    dls.rows.forEach((x, i) => push(`deliv-${i}`, x.due_date, `◆ Due: ${x.title}`));
    holidays.rows.forEach((h, i) => push(`hol-${i}`, h.date, `🏛 ${h.name}`));
    const ics = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Nerve//Media Ops//EN\r\nCALSCALE:GREGORIAN\r\nX-WR-CALNAME:Nerve Media Ops\r\n${ev.join("\r\n")}\r\nEND:VCALENDAR\r\n`;
    res.set("Content-Type", "text/calendar; charset=utf-8");
    res.set("Content-Disposition", 'inline; filename="nerve-media-ops.ics"');
    res.send(ics);
  }));

  // ═════════════════════════ PHASE 3 — BOARDS / COMMENTS ══════════════════
  app.post(`${P}/boards/:id/cards`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    if (!(isMoAdmin(u) || isMoTL(u))) return sendError(res, 403, "Boards are Admin/Team-Lead only (FR-14.1).");
    const boardId = parseInt(getSingleParam(req.params.id), 10);
    const b = req.body as Record<string, unknown>;
    if (!String(b.title ?? "").trim()) return sendError(res, 400, "Card title is required.");
    const ins = await pool.query(
      `INSERT INTO mo_cards (board_id, column_id, title, description, linked_entity_type, linked_entity_id, priority, sort_order, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,999,$8) RETURNING *`,
      [boardId, Number(b.column_id), String(b.title), String(b.description ?? ""),
       (b.linked_entity_type as string) || null, b.linked_entity_id ? Number(b.linked_entity_id) : null,
       (b.priority as string) || "normal", u.id]);
    for (const a of (Array.isArray(b.assignees) ? b.assignees : []))
      await pool.query(`INSERT INTO mo_card_assignees (card_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [ins.rows[0].id, toUid(a)]);
    await audit(u, "card.created", "card", ins.rows[0].id, null, { title: b.title }, req);
    res.status(201).json({ card: ins.rows[0] });
  }));

  app.patch(`${P}/cards/:id`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    const id = parseInt(getSingleParam(req.params.id), 10);
    const b = req.body as Record<string, unknown>;
    const cur = await pool.query(`SELECT * FROM mo_cards WHERE id=$1`, [id]);
    if (!cur.rows[0]) return sendError(res, 404, "Card not found.");
    const fields: string[] = [], vals: unknown[] = []; let i = 1;
    for (const k of ["column_id", "sort_order", "title", "description", "priority", "due_date"])
      if (k in b) { fields.push(`${k}=$${i++}`); vals.push(b[k]); }
    if (b.archived === true) { fields.push(`archived_at=CURRENT_DATE`); }
    if (fields.length) { vals.push(id); await pool.query(`UPDATE mo_cards SET ${fields.join(",")} WHERE id=$${i}`, vals); }
    // FR-14.2 two-way sync: moving a linked card to a status-mapped column updates the object.
    let synced: string | null = null;
    if ("column_id" in b) {
      const info = await pool.query(
        `SELECT bd.sync_status, col.maps_to_status FROM mo_boards bd
           JOIN mo_board_columns col ON col.id=$1 WHERE bd.id=$2`, [Number(b.column_id), cur.rows[0].board_id]);
      const maps = info.rows[0]?.maps_to_status;
      if (info.rows[0]?.sync_status && maps && cur.rows[0].linked_entity_type === "deliverable" && cur.rows[0].linked_entity_id) {
        await pool.query(`UPDATE mo_deliverables SET status=$1 WHERE id=$2`, [maps, cur.rows[0].linked_entity_id]);
        synced = maps;
      }
    }
    await audit(u, "card.updated", "card", id, cur.rows[0], b, req);
    res.json({ ok: true, synced });
  }));

  app.post(`${P}/cards/:id/checklist/:ix/toggle`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    const id = parseInt(getSingleParam(req.params.id), 10), ix = parseInt(getSingleParam(req.params.ix), 10);
    const { rows } = await pool.query(
      `UPDATE mo_card_checklist_items SET is_done = NOT is_done WHERE card_id=$1 AND sort_order=$2 RETURNING is_done`, [id, ix]);
    if (!rows[0]) return sendError(res, 404, "Checklist item not found.");
    await audit(u, "card.checklist_toggled", "card", id, null, { ix, is_done: rows[0].is_done }, req);
    res.json({ ok: true, is_done: rows[0].is_done });
  }));

  // ── Comments (BR-16) ──────────────────────────────────────────────────────
  app.post(`${P}/comments`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    const b = req.body as Record<string, unknown>;
    if (!b.entity_type || !b.entity_id || !String(b.body ?? "").trim())
      return sendError(res, 400, "entity_type, entity_id and body are required.");
    const ins = await pool.query(
      `INSERT INTO mo_comments (entity_type, entity_id, user_id, body) VALUES ($1,$2,$3,$4) RETURNING *`,
      [String(b.entity_type), Number(b.entity_id), u.id, String(b.body)]);
    await audit(u, "comment.posted", String(b.entity_type), Number(b.entity_id), null, null, req);
    res.status(201).json({ comment: ins.rows[0] });
  }));

  // Deliverable status change (Production Board drag) — persists + enforces the
  // machine, BR-5 (submitter≠approver, reviewer must be PM/TL/Admin) and BR-6.
  // changes_requested→approved is allowed for a PM/TL/Admin (#4).
  app.post(`${P}/deliverables/:id/status`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    const id = parseInt(getSingleParam(req.params.id), 10);
    const to = String((req.body as Record<string, unknown>).status ?? "");
    const d = (await pool.query(`SELECT d.*, dt.review_exempt FROM mo_deliverables d JOIN mo_deliverable_types dt ON dt.id=d.deliverable_type_id WHERE d.id=$1`, [id])).rows[0];
    if (!d) return sendError(res, 404, "Deliverable not found.");
    const DELIV: Record<string, string[]> = {
      not_started: ["in_progress", "not_required", "cancelled"], in_progress: ["in_review", "not_required", "cancelled"],
      in_review: ["approved", "changes_requested", "cancelled"], changes_requested: ["in_progress", "in_review", "approved", "cancelled"],
      approved: ["delivered", "changes_requested"], delivered: [], not_required: ["not_started"], cancelled: ["not_started"],
    };
    if (!(DELIV[d.status] ?? []).includes(to)) return sendError(res, 400, `BR-1: ${d.status} → ${to} is not a valid transition.`);
    // Admin has full override (no review mandate — #4). Everyone else obeys BR-5/BR-6.
    if (!isMoAdmin(u)) {
      if (to === "approved") {
        const v = (await pool.query(`SELECT submitted_by FROM mo_deliverable_versions WHERE deliverable_id=$1 ORDER BY version_no DESC LIMIT 1`, [id])).rows[0];
        if (v && v.submitted_by === u.id) return sendError(res, 403, "BR-5: a version cannot be approved by its submitter.");
        const isPM = await pool.query(`SELECT 1 FROM mo_project_assignments a WHERE a.project_id=$1 AND a.user_id=$2 AND a.is_project_manager AND a.removed_at IS NULL`, [d.project_id, u.id]);
        if (!(isMoTL(u) || isPM.rows[0])) return sendError(res, 403, "BR-5: reviewer must be the PM, a Team Lead or Admin.");
      }
      if (to === "delivered" && !d.review_exempt) {
        const v = (await pool.query(`SELECT review_status FROM mo_deliverable_versions WHERE deliverable_id=$1 ORDER BY version_no DESC LIMIT 1`, [id])).rows[0];
        if (v?.review_status !== "approved") return sendError(res, 400, "BR-6: Delivered requires an approved latest version.");
      }
    }
    await pool.query(`UPDATE mo_deliverables SET status=$1, completed_at=CASE WHEN $1='delivered' THEN CURRENT_DATE ELSE completed_at END WHERE id=$2`, [to, id]);
    await audit(u, "deliverable.status_changed", "deliverable", id, { status: d.status }, { status: to }, req);
    res.json({ ok: true, status: to });
  }));

  // Delete a project (soft) — #11. TL/Admin.
  app.delete(`${P}/projects/:id`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    if (!(isMoAdmin(u) || isMoTL(u))) return sendError(res, 403, "Only a Team Lead or Admin may delete a project.");
    const id = parseInt(getSingleParam(req.params.id), 10);
    await pool.query(`UPDATE mo_projects SET deleted_at=NOW() WHERE id=$1`, [id]);
    await audit(u, "project.deleted", "project", id, null, null, req);
    res.json({ ok: true });
  }));

  // Remove a media crew member — #6. Admin only. Blocks if they have activity.
  app.delete(`${P}/crew/:id`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    if (!isMoAdmin(u)) return sendError(res, 403, "Only Admin may remove crew members.");
    const realId = getSingleParam(req.params.id);
    if (realId === u.id) return sendError(res, 400, "You cannot remove yourself.");
    try {
      await pool.query(`DELETE FROM mo_user_profiles WHERE user_id=$1`, [realId]);
      await pool.query(`DELETE FROM users WHERE id=$1 AND team='media'`, [realId]);
    } catch {
      return sendError(res, 409, "This member has activity (reports/projects/audit). Reassign their work first.");
    }
    await audit(u, "crew.removed", "user", null, null, { id: realId }, req);
    res.json({ ok: true });
  }));

  // Change a member's role (and optionally team-lead) — #1. Admin only.
  app.post(`${P}/crew/:id/role`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    if (!isMoAdmin(u)) return sendError(res, 403, "Only Admin may change roles.");
    const realId = getSingleParam(req.params.id);
    const role = ({ admin: "admin", team_lead: "sub_admin", employee: "user" } as Record<string, string>)[String((req.body as Record<string, unknown>).role)];
    if (!role) return sendError(res, 400, "Invalid role.");
    if (realId === u.id) return sendError(res, 400, "You cannot change your own role.");
    await pool.query(`UPDATE users SET role=$1 WHERE id=$2 AND team='media'`, [role, realId]);
    await audit(u, "crew.role_changed", "user", null, null, { id: realId, role }, req);
    res.json({ ok: true, role });
  }));

  // Assign a member to a team lead (FR-7.2) — creates the lead's team lazily and makes
  // it the member's one primary team; empty lead_user_id unassigns. Admin only.
  app.post(`${P}/crew/:id/team`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    if (!isMoAdmin(u)) return sendError(res, 403, "Only Admin may assign team membership.");
    const memberId = getSingleParam(req.params.id);
    const leadId = String((req.body as Record<string, unknown>).lead_user_id ?? "");
    await pool.query(`DELETE FROM mo_team_members WHERE user_id=$1`, [memberId]);   // one primary team
    if (leadId) {
      let team = (await pool.query(`SELECT id FROM mo_teams WHERE lead_user_id=$1 AND is_active LIMIT 1`, [leadId])).rows[0];
      if (!team) {
        const lead = (await pool.query(`SELECT full_name FROM users WHERE id=$1`, [leadId])).rows[0];
        team = (await pool.query(`INSERT INTO mo_teams (department_id, name, lead_user_id, is_active) VALUES (1,$1,$2,true) RETURNING id`,
          [`${lead?.full_name ?? "Team"}'s team`, leadId])).rows[0];
      }
      await pool.query(`INSERT INTO mo_team_members (team_id, user_id, is_primary) VALUES ($1,$2,true)`, [team.id, memberId]);
    }
    await audit(u, leadId ? "user.team_assigned" : "user.team_unassigned", "user", null, null, { member: memberId, lead: leadId || null }, req);
    res.json({ ok: true });
  }));

  // Grant/revoke a duty flag (D4). Admin. Persists what was a local-only toggle.
  app.post(`${P}/crew/:id/duties`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    if (!isMoAdmin(u)) return sendError(res, 403, "Only Admin may grant duties.");
    const memberId = getSingleParam(req.params.id);
    const b = req.body as Record<string, unknown>;
    const fid = Number(b.duty_flag_id);
    if (!fid) return sendError(res, 400, "duty_flag_id is required.");
    if (b.grant)
      await pool.query(`INSERT INTO mo_user_duties (user_id, duty_flag_id, granted_by, granted_at) VALUES ($1,$2,$3,CURRENT_DATE)
                        ON CONFLICT (user_id, duty_flag_id) DO NOTHING`, [memberId, fid, u.id]);
    else
      await pool.query(`DELETE FROM mo_user_duties WHERE user_id=$1 AND duty_flag_id=$2`, [memberId, fid]);
    await audit(u, b.grant ? "user.duty_granted" : "user.duty_revoked", "user", null, null, { member: memberId, duty: fid }, req);
    res.json({ ok: true });
  }));

  // Remove a crew member from a project (#3). TL/Admin.
  app.delete(`${P}/projects/:id/assignments/:uid`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    if (!(isMoAdmin(u) || isMoTL(u))) return sendError(res, 403, "Only a Team Lead or Admin may change assignments.");
    const pid = parseInt(getSingleParam(req.params.id), 10);
    const uid = getSingleParam(req.params.uid);
    await pool.query(`UPDATE mo_project_assignments SET removed_at=NOW() WHERE project_id=$1 AND user_id=$2 AND removed_at IS NULL`, [pid, uid]);
    await audit(u, "project.assignment_removed", "project", pid, null, { user_id: uid }, req);
    res.json({ ok: true });
  }));

  // Remove a crew member from a shoot (#7).
  app.delete(`${P}/shoots/:id/crew/:uid`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    if (!(isMoAdmin(u) || isMoTL(u))) return sendError(res, 403, "Only a Team Lead or Admin may change shoot crew.");
    const sid = parseInt(getSingleParam(req.params.id), 10);
    const uid = getSingleParam(req.params.uid);
    await pool.query(`DELETE FROM mo_shoot_crew WHERE shoot_id=$1 AND user_id=$2`, [sid, uid]);
    await audit(u, "shoot.crew_removed", "shoot", sid, null, { user_id: uid }, req);
    res.json({ ok: true });
  }));

  // Add crew to a shoot (#7).
  app.post(`${P}/shoots/:id/crew`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    if (!(isMoAdmin(u) || isMoTL(u))) return sendError(res, 403, "Only a Team Lead or Admin may assign shoot crew.");
    const sid = parseInt(getSingleParam(req.params.id), 10);
    for (const raw of (Array.isArray((req.body as Record<string, unknown>).crew) ? (req.body as Record<string, unknown>).crew as unknown[] : []))
      await pool.query(`INSERT INTO mo_shoot_crew (shoot_id, user_id, capacity_role_id) VALUES ($1,$2,2) ON CONFLICT DO NOTHING`, [sid, String(raw)]);
    await audit(u, "shoot.crew_added", "shoot", sid, null, null, req);
    res.status(201).json({ ok: true });
  }));

  // Update own profile photo (edit-avatar from the profile dialog — #5).
  app.post(`${P}/me/profile`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    const b = req.body as Record<string, unknown>;
    await pool.query(`UPDATE users SET avatar_url=$1 WHERE id=$2`, [(b.avatar_url as string) || null, u.id]);
    await audit(u, "user.avatar_updated", "user", null, null, null, req);
    res.json({ ok: true });
  }));

  // Generic lookup CRUD (Settings — #2). Admin-editable, no deploy (NFR-10).
  const LOOKUP_CFG: Record<string, { table: string; fields: string[] }> = {
    task_categories: { table: "mo_task_categories", fields: ["name", "icon"] },
    deliverable_types: { table: "mo_deliverable_types", fields: ["name", "icon", "default_unit", "default_weight", "review_exempt"] },
    equipment_categories: { table: "mo_equipment_categories", fields: ["name", "icon", "tracking_mode"] },
    leave_types: { table: "mo_leave_types", fields: ["name", "annual_quota"] },
    project_types: { table: "mo_project_types", fields: ["name", "icon", "color"] },
    capacity_roles: { table: "mo_capacity_roles", fields: ["name"] },
    skills: { table: "mo_skills", fields: ["name", "category"] },
    tags: { table: "mo_tags", fields: ["name", "color"] },
  };
  const lookupCols = async (t: string) =>
    new Set((await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name=$1`, [t])).rows.map((r) => r.column_name as string));

  app.post(`${P}/lookups/:type`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    if (!isMoAdmin(u)) return sendError(res, 403, "Only Admin may edit lookups.");
    const cfg = LOOKUP_CFG[getSingleParam(req.params.type)]; if (!cfg) return sendError(res, 400, "Unknown lookup type.");
    const b = req.body as Record<string, unknown>;
    const name = String(b.name ?? "").trim(); if (!name) return sendError(res, 400, "Name is required.");
    const cols = await lookupCols(cfg.table);
    const rec: Record<string, unknown> = { name };
    for (const f of cfg.fields) if (f !== "name" && f in b && cols.has(f)) rec[f] = b[f];
    if (cols.has("department_id")) rec.department_id = 1;
    if (cols.has("is_active")) rec.is_active = true;
    if (cols.has("slug")) rec.slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    if (cols.has("sort_order")) rec.sort_order = (await pool.query(`SELECT COALESCE(MAX(sort_order),0)+1 n FROM ${cfg.table}`)).rows[0].n;
    if (cols.has("icon") && !("icon" in rec)) rec.icon = "◆";
    const keys = Object.keys(rec);
    const ins = await pool.query(
      `INSERT INTO ${cfg.table} (${keys.map((k) => `"${k}"`).join(",")}) VALUES (${keys.map((_, i) => "$" + (i + 1)).join(",")}) RETURNING *`,
      keys.map((k) => rec[k]));
    await audit(u, "lookup.created", cfg.table, ins.rows[0].id, null, { name }, req);
    res.status(201).json({ row: ins.rows[0] });
  }));

  app.patch(`${P}/lookups/:type/:id`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    if (!isMoAdmin(u)) return sendError(res, 403, "Only Admin may edit lookups.");
    const cfg = LOOKUP_CFG[getSingleParam(req.params.type)]; if (!cfg) return sendError(res, 400, "Unknown lookup type.");
    const id = parseInt(getSingleParam(req.params.id), 10);
    const b = req.body as Record<string, unknown>;
    const cols = await lookupCols(cfg.table);
    const sets: string[] = [], vals: unknown[] = []; let i = 1;
    for (const f of [...cfg.fields, "is_active"]) if (f in b && cols.has(f)) { sets.push(`"${f}"=$${i++}`); vals.push(b[f]); }
    if (!sets.length) return res.json({ ok: true });
    vals.push(id);
    const { rows } = await pool.query(`UPDATE ${cfg.table} SET ${sets.join(",")} WHERE id=$${i} RETURNING *`, vals);
    await audit(u, "lookup.updated", cfg.table, id, null, b, req);
    res.json({ row: rows[0] });
  }));

  // Change own password (profile dialog).
  app.post(`${P}/me/password`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    const b = req.body as Record<string, unknown>;
    if (String(b.new_password ?? "").length < 6) return sendError(res, 400, "New password must be at least 6 characters.");
    const row = (await pool.query(`SELECT password_hash FROM users WHERE id=$1`, [u.id])).rows[0];
    if (!row || !(await verifyPassword(String(b.current_password ?? ""), row.password_hash)))
      return sendError(res, 400, "Current password is incorrect.");
    await pool.query(`UPDATE users SET password_hash=$1, updated_at=NOW() WHERE id=$2`, [await hashPassword(String(b.new_password)), u.id]);
    await audit(u, "user.password_changed", "user", null, null, null, req);
    res.json({ ok: true });
  }));

  // ═════════════════════════ ADMIN: CREW / EQUIPMENT / DRIVE LINKS ═════════
  // Add a media crew member (real Nerve user). Admin only. Requires email + password.
  app.post(`${P}/crew`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    if (!isMoAdmin(u)) return sendError(res, 403, "Only Admin may add crew members.");
    const b = req.body as Record<string, unknown>;
    const email = String(b.email ?? "").trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return sendError(res, 400, "A valid email is required.");
    if (String(b.password ?? "").length < 6) return sendError(res, 400, "Password must be at least 6 characters.");
    if (!String(b.avatar_url ?? "").trim()) return sendError(res, 400, "A profile photo is required.");
    const role = ({ admin: "admin", team_lead: "sub_admin", employee: "user" } as Record<string, string>)[String(b.role)] ?? "user";
    const exists = await pool.query(`SELECT 1 FROM users WHERE email=$1`, [email]);
    if (exists.rows[0]) return sendError(res, 409, "A user with that email already exists.");
    const id = `u-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const pw = await hashPassword(String(b.password));
    await pool.query(
      `INSERT INTO users (id, full_name, email, department, role, team, password_hash, email_verified, avatar_url)
       VALUES ($1,$2,$3,'Media Crew',$4,'media',$5,true,$6)`,
      [id, String(b.full_name ?? "New Member").trim() || "New Member", email, role, pw, (b.avatar_url as string) || null]);
    const mods = Array.isArray(b.allowed_modules) ? JSON.stringify(b.allowed_modules) : null;
    await pool.query(`INSERT INTO mo_user_profiles (user_id, designation, mo_role, allowed_modules) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
      [id, String(b.designation ?? ""), ({ admin: "admin", sub_admin: "team_lead", user: "employee" } as Record<string, string>)[role], mods]);
    await audit(u, "crew.added", "user", null, null, { email, role, allowed_modules: b.allowed_modules ?? null }, req);
    res.status(201).json({ ok: true, id, email, role });
  }));

  // Update a user's module access (edit an existing member). Admin only.
  app.post(`${P}/crew/:id/modules`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    if (!isMoAdmin(u)) return sendError(res, 403, "Only Admin may change module access.");
    const memberId = getSingleParam(req.params.id);
    const mods = (req.body as Record<string, unknown>).allowed_modules;
    const val = Array.isArray(mods) ? JSON.stringify(mods) : null;   // null clears the restriction
    await pool.query(
      `INSERT INTO mo_user_profiles (user_id, allowed_modules) VALUES ($1,$2)
       ON CONFLICT (user_id) DO UPDATE SET allowed_modules=EXCLUDED.allowed_modules`, [memberId, val]);
    await audit(u, "crew.modules_changed", "user", null, null, { member: memberId, allowed_modules: mods ?? null }, req);
    res.json({ ok: true });
  }));

  // Add an equipment item (auto asset tag EQ-<CAT>-NNN). Team Lead / Admin.
  app.post(`${P}/equipment`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    if (!(await requireModule(res, u, "equipment"))) return;
    if (!(isMoAdmin(u) || isMoTL(u))) return sendError(res, 403, "Team Lead or Admin only.");
    const b = req.body as Record<string, unknown>;
    const catId = Number(b.category_id);
    if (!catId || !String(b.make ?? "").trim()) return sendError(res, 400, "Category and make are required.");
    const cat = await pool.query(`SELECT name FROM mo_equipment_categories WHERE id=$1`, [catId]);
    if (!cat.rows[0]) return sendError(res, 400, "Invalid category.");
    const prefix = String(cat.rows[0].name).replace(/[^A-Za-z]/g, "").slice(0, 3).toUpperCase() || "GEN";
    const n = (await pool.query(`SELECT COUNT(*)::int c FROM mo_equipment_items WHERE category_id=$1`, [catId])).rows[0].c + 1;
    const tag = `EQ-${prefix}-${String(n).padStart(3, "0")}`;
    const cond = ["excellent", "good", "fair", "poor"].includes(String(b.condition)) ? String(b.condition) : "good";
    const ins = await pool.query(
      `INSERT INTO mo_equipment_items (department_id, campus_id, category_id, asset_tag, qr_uid, make, model, serial_no, purchase_cost, condition, status)
       VALUES (1,1,$1,$2,$3,$4,$5,$6,$7,$8,'available') RETURNING *`,
      [catId, tag, `QR-${tag}`, String(b.make).trim(), String(b.model ?? "").trim(),
       (b.serial_no as string)?.trim() || null, b.purchase_cost ? Number(b.purchase_cost) : null, cond]);
    await audit(u, "equipment.added", "equipment_item", ins.rows[0].id, null, { tag }, req);
    res.status(201).json({ item: ins.rows[0], asset_tag: tag });
  }));

  // Attach a validated Drive link to a project/deliverable (FR-4.3).
  app.post(`${P}/drive-links`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    const b = req.body as Record<string, unknown>;
    const url = String(b.url ?? "").trim();
    if (!b.entity_type || !b.entity_id) return sendError(res, 400, "entity_type and entity_id are required.");
    if (!/^https:\/\/(drive|docs)\.google\.com\//.test(url)) return sendError(res, 400, "VR-4: must be a Google Drive/Docs link.");
    const ins = await pool.query(
      `INSERT INTO mo_drive_links (entity_type, entity_id, label, url, added_by, validation_status, last_validated_at)
       VALUES ($1,$2,$3,$4,$5,'ok',NOW()) RETURNING *`,
      [String(b.entity_type), Number(b.entity_id), String(b.label ?? "").trim(), url, u.id]);
    await audit(u, "drive_link.added", String(b.entity_type), Number(b.entity_id), null, { url }, req);
    res.status(201).json({ link: ins.rows[0] });
  }));

  // Edit project details (§13 PATCH /projects/:id). Owner/PM/TL/Admin.
  app.patch(`${P}/projects/:id`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    const id = parseInt(getSingleParam(req.params.id), 10);
    const cur = (await pool.query(`SELECT * FROM mo_projects WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!cur) return sendError(res, 404, "Project not found.");
    const isPM = await pool.query(`SELECT 1 FROM mo_project_assignments WHERE project_id=$1 AND user_id=$2 AND is_project_manager AND removed_at IS NULL`, [id, u.id]);
    if (!(isMoAdmin(u) || isMoTL(u) || cur.owner_id === u.id || isPM.rows[0]))
      return sendError(res, 403, "Only the owner/PM, a Team Lead or Admin may edit this project.");
    const b = req.body as Record<string, unknown>;
    if (typeof b.name === "string" && (b.name.trim().length < 3 || b.name.trim().length > 120))
      return sendError(res, 400, "VR-6: name must be 3–120 characters.");
    if (b.start_date && b.end_date && String(b.end_date) < String(b.start_date))
      return sendError(res, 400, "VR-6: end date must be on or after start date.");
    const fields: string[] = [], vals: unknown[] = []; let i = 1;
    for (const k of ["name", "description", "faculty_served", "priority", "start_date", "end_date", "cover_image_url", "academic_year_id"])
      if (k in b) { fields.push(`${k}=$${i++}`); vals.push(b[k]); }
    if (!fields.length) return res.json({ project: cur });
    vals.push(id);
    const { rows } = await pool.query(`UPDATE mo_projects SET ${fields.join(",")} WHERE id=$${i} RETURNING *`, vals);
    await audit(u, "project.updated", "project", id, cur, rows[0], req);
    res.json({ project: rows[0] });
  }));

  // Leave replacement (FR-10.3 / §13 POST /leave/:id/replacements). TL/Admin.
  app.post(`${P}/leave/:id/replacements`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    if (!(isMoAdmin(u) || isMoTL(u))) return sendError(res, 403, "Only a Team Lead or Admin may assign replacements.");
    const lid = parseInt(getSingleParam(req.params.id), 10);
    const b = req.body as Record<string, unknown>;
    const shootId = Number(b.shoot_id), repl = String(b.replacement_user_id ?? "");
    const lr = (await pool.query(`SELECT user_id FROM mo_leave_requests WHERE id=$1`, [lid])).rows[0];
    if (!lr) return sendError(res, 404, "Leave request not found.");
    if (!shootId || !repl) return sendError(res, 400, "shoot_id and replacement_user_id are required.");
    await pool.query(`INSERT INTO mo_leave_replacements (leave_request_id, shoot_id, replacement_user_id) VALUES ($1,$2,$3)`, [lid, shootId, repl]);
    await pool.query(`INSERT INTO mo_shoot_crew (shoot_id, user_id, capacity_role_id, is_replacement, replaced_user_id)
                      VALUES ($1,$2,2,true,$3) ON CONFLICT DO NOTHING`, [shootId, repl, lr.user_id]);
    await audit(u, "leave.replacement_assigned", "shoot", shootId, null, { leave: lid, replacement: repl }, req);
    res.status(201).json({ ok: true });
  }));

  // Admin audit browser (FR-13.3) — read the real append-only mo_audit_logs.
  app.get(`${P}/audit`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    if (!isMoAdmin(u)) return sendError(res, 403, "The audit log is Admin-only (FR-13.3).");
    const q = req.query as Record<string, unknown>;
    const conds: string[] = [], vals: unknown[] = []; let i = 1;
    if (q.entity_type) { conds.push(`a.entity_type=$${i++}`); vals.push(String(q.entity_type)); }
    if (q.action) { conds.push(`a.action ILIKE $${i++}`); vals.push("%" + String(q.action) + "%"); }
    if (q.actor) { conds.push(`us.full_name ILIKE $${i++}`); vals.push("%" + String(q.actor) + "%"); }
    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
    const { rows } = await pool.query(
      `SELECT a.id, a.actor_id, us.full_name AS actor_name, a.actor_role, a.action, a.entity_type, a.entity_id,
              a.before, a.after, a.occurred_at, a.ip, a.user_agent
       FROM mo_audit_logs a LEFT JOIN users us ON us.id=a.actor_id ${where}
       ORDER BY a.occurred_at DESC LIMIT 300`, vals);
    res.json({ audit: rows });
  }));

  // Notifications (§18) — the feed is written by the automation engine.
  app.get(`${P}/notifications`, asyncHandler(async (_req, res) => {
    const u = requireMedia(res); if (!u) return;
    const { rows } = await pool.query(`SELECT * FROM mo_notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50`, [u.id]);
    res.json({ notifications: rows });
  }));
  app.post(`${P}/notifications/read`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    const id = (req.body as Record<string, unknown>).id;
    if (id) await pool.query(`UPDATE mo_notifications SET is_read=true WHERE id=$1 AND user_id=$2`, [Number(id), u.id]);
    else await pool.query(`UPDATE mo_notifications SET is_read=true WHERE user_id=$1`, [u.id]);
    res.json({ ok: true });
  }));

  // ═════════════════ TASK / ASSIGNMENT layer (Projects → Assignments) ══════
  // A TL/Admin assigns scheduled work to crew inside a project; it surfaces in the
  // assignee's "Today's Assignments" when today ∈ [start_date, due_date].
  app.post(`${P}/projects/:id/tasks`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    if (!(isMoAdmin(u) || isMoTL(u))) return sendError(res, 403, "Only a Team Lead or Admin may assign tasks.");
    const pid = parseInt(getSingleParam(req.params.id), 10);
    const b = req.body as Record<string, unknown>;
    const title = String(b.title ?? "").trim();
    if (!title) return sendError(res, 400, "Task title is required.");
    const assignees = Array.isArray(b.assignees) ? (b.assignees as unknown[]).map(String) : [];
    if (!assignees.length) return sendError(res, 400, "Assign the task to at least one member.");
    if (b.start_date && b.due_date && String(b.due_date) < String(b.start_date))
      return sendError(res, 400, "Due date must be on or after the start date.");
    const priority = ["urgent", "high", "normal", "low"].includes(String(b.priority)) ? String(b.priority) : "normal";
    const status = ["not_started", "in_progress", "done", "blocked", "cancelled"].includes(String(b.status)) ? String(b.status) : "not_started";
    const ins = await pool.query(
      `INSERT INTO mo_assignments (project_id, title, assigned_by, priority, status, start_date, due_date, start_time, end_time, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [pid, title, u.id, priority, status, (b.start_date as string) || null, (b.due_date as string) || null,
       (b.start_time as string) || null, (b.end_time as string) || null, String(b.notes ?? "")]);
    for (const uid of assignees)
      await pool.query(`INSERT INTO mo_assignment_users (assignment_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [ins.rows[0].id, uid]);
    await audit(u, "assignment.created", "assignment", ins.rows[0].id, null, { title, assignees }, req);
    res.status(201).json({ assignment: ins.rows[0] });
  }));

  app.patch(`${P}/assignments/:id`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    const id = parseInt(getSingleParam(req.params.id), 10);
    const cur = (await pool.query(`SELECT * FROM mo_assignments WHERE id=$1`, [id])).rows[0];
    if (!cur) return sendError(res, 404, "Assignment not found.");
    const isAssignee = (await pool.query(`SELECT 1 FROM mo_assignment_users WHERE assignment_id=$1 AND user_id=$2`, [id, u.id])).rows[0];
    const priv = isMoAdmin(u) || isMoTL(u) || cur.assigned_by === u.id;
    if (!priv && !isAssignee) return sendError(res, 403, "You can't change this assignment.");
    const b = req.body as Record<string, unknown>;
    // Assignees may only move the status; TL/Admin/creator may edit everything.
    const cols = priv ? ["title", "priority", "status", "start_date", "due_date", "start_time", "end_time", "notes"] : ["status"];
    const fields: string[] = [], vals: unknown[] = []; let i = 1;
    for (const k of cols) if (k in b) { fields.push(`${k}=$${i++}`); vals.push(b[k]); }
    if (fields.length) { vals.push(id); await pool.query(`UPDATE mo_assignments SET ${fields.join(",")} WHERE id=$${i}`, vals); }
    if (priv && Array.isArray(b.assignees)) {
      await pool.query(`DELETE FROM mo_assignment_users WHERE assignment_id=$1`, [id]);
      for (const uid of (b.assignees as unknown[]).map(String))
        await pool.query(`INSERT INTO mo_assignment_users (assignment_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [id, uid]);
    }
    await audit(u, "assignment.updated", "assignment", id, cur, b, req);
    res.json({ ok: true });
  }));

  app.delete(`${P}/assignments/:id`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    if (!(isMoAdmin(u) || isMoTL(u))) return sendError(res, 403, "Only a Team Lead or Admin may delete an assignment.");
    const id = parseInt(getSingleParam(req.params.id), 10);
    await pool.query(`DELETE FROM mo_assignments WHERE id=$1`, [id]);
    await audit(u, "assignment.deleted", "assignment", id, null, null, req);
    res.json({ ok: true });
  }));

  // ═════════════════════════ KRA (§7.9 / FR-9.x) ══════════════════════════
  app.post(`${P}/kra/cycles`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    if (!(await requireModule(res, u, "performance"))) return;
    if (!(isMoAdmin(u) || isMoTL(u))) return sendError(res, 403, "Only a Team Lead or Admin may open a KRA cycle.");
    const b = req.body as Record<string, unknown>;
    if (!String(b.label ?? "").trim()) return sendError(res, 400, "Cycle label is required.");
    const ins = await pool.query(
      `INSERT INTO mo_kra_cycles (department_id, label, starts_on, ends_on, status) VALUES (1,$1,$2,$3,'active') RETURNING *`,
      [String(b.label).trim(), (b.starts_on as string) || null, (b.ends_on as string) || null]);
    await audit(u, "kra.cycle_created", "kra_cycle", ins.rows[0].id, null, { label: b.label }, req);
    res.status(201).json({ cycle: ins.rows[0] });
  }));

  app.post(`${P}/kra/:cycleId/items`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    const cid = parseInt(getSingleParam(req.params.cycleId), 10);
    const b = req.body as Record<string, unknown>;
    const target = String(b.user_id ?? u.id);
    if (target !== u.id && !(isMoAdmin(u) || isMoTL(u))) return sendError(res, 403, "You can only set your own KRAs.");
    if (!String(b.title ?? "").trim()) return sendError(res, 400, "KRA title is required.");
    const weight = Math.max(0, Math.min(100, Number(b.weight) || 0));
    const cur = Number((await pool.query(`SELECT COALESCE(SUM(weight),0) s FROM mo_kras WHERE kra_cycle_id=$1 AND user_id=$2`, [cid, target])).rows[0].s);
    if (cur + weight > 100) return sendError(res, 400, `BR-14: a user's KRA weights cannot exceed 100 (currently ${cur}).`);
    const src = ["manual", "auto"].includes(String(b.metric_source)) ? String(b.metric_source) : "manual";
    const ins = await pool.query(
      `INSERT INTO mo_kras (kra_cycle_id, user_id, title, metric_source, auto_metric_key, target_text, weight)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [cid, target, String(b.title).trim(), src, (b.auto_metric_key as string) || null, (b.target_text as string) || "", weight]);
    await audit(u, "kra.item_created", "kra", ins.rows[0].id, null, { title: b.title, weight, user: target }, req);
    res.status(201).json({ kra: ins.rows[0] });
  }));

  app.post(`${P}/kra/items/:id/review`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    const id = parseInt(getSingleParam(req.params.id), 10);
    const b = req.body as Record<string, unknown>;
    const phase = String(b.phase);
    if (!["self", "manager"].includes(phase)) return sendError(res, 400, "phase must be 'self' or 'manager'.");
    const kra = (await pool.query(`SELECT user_id FROM mo_kras WHERE id=$1`, [id])).rows[0];
    if (!kra) return sendError(res, 404, "KRA not found.");
    if (phase === "self" && kra.user_id !== u.id) return sendError(res, 403, "Only the KRA owner may self-review.");
    if (phase === "manager" && !(isMoAdmin(u) || isMoTL(u))) return sendError(res, 403, "Only a Team Lead or Admin may do the manager review.");
    await pool.query(
      `INSERT INTO mo_kra_reviews (kra_id, phase, score, achievement_pct, comment, reviewer_id, reviewed_at)
       VALUES ($1,$2,$3,$4,$5,$6,CURRENT_DATE)
       ON CONFLICT (kra_id, phase) DO UPDATE SET score=EXCLUDED.score, achievement_pct=EXCLUDED.achievement_pct,
         comment=EXCLUDED.comment, reviewer_id=EXCLUDED.reviewer_id, reviewed_at=CURRENT_DATE`,
      [id, phase, b.score != null ? Number(b.score) : null, b.achievement_pct != null ? Number(b.achievement_pct) : null,
       (b.comment as string) || "", u.id]);
    await audit(u, "kra.reviewed", "kra", id, null, { phase, score: b.score }, req);
    res.status(201).json({ ok: true });
  }));

  // ═══════════════════════════════════════════════════════════════════════
  // CRUD ENGINE — one configuration-driven framework for every Admin config
  // module (NFR-10). A module declares its table, fields, display columns,
  // dependencies and permissions; the engine provides list/search/sort/
  // pagination, create, edit, duplicate, enable/disable, archive, dependency-
  // checked delete, bulk actions and per-record audit history — uniformly.
  // ═══════════════════════════════════════════════════════════════════════
  type CrudField = {
    name: string; label: string;
    type: "text" | "textarea" | "select" | "switch" | "color" | "icon" | "date" | "number" | "slug" | "relation";
    required?: boolean; def?: unknown; options?: string[];
    relation?: { module: string; labelCol: string };
    showIf?: { field: string; value: unknown };
  };
  type CrudModule = {
    key: string; label: string; table: string; fields: CrudField[];
    cols: string[];                                     // listing display columns
    deps: { table: string; fk: string; label: string }[];
    activeCol?: string;                                 // default is_active
  };
  const CRUD: Record<string, CrudModule> = {
    project_types: { key: "project_types", label: "Project Types", table: "mo_project_types",
      fields: [
        { name: "name", label: "Name", type: "text", required: true },
        { name: "slug", label: "Slug", type: "slug" },
        { name: "color", label: "Colour", type: "color" },
        { name: "icon", label: "Icon", type: "icon" },
        { name: "sort_order", label: "Sort order", type: "number", def: 0 }],
      cols: ["name", "slug", "icon", "sort_order"],
      deps: [{ table: "mo_projects", fk: "project_type_id", label: "Projects" },
             { table: "mo_project_templates", fk: "project_type_id", label: "Templates" }] },
    project_templates: { key: "project_templates", label: "Project Templates", table: "mo_project_templates",
      fields: [
        { name: "name", label: "Name", type: "text", required: true },
        { name: "project_type_id", label: "Project type", type: "relation", required: true, relation: { module: "project_types", labelCol: "name" } }],
      cols: ["name", "project_type_id"],
      deps: [{ table: "mo_template_deliverables", fk: "template_id", label: "Template deliverables" }] },
    deliverable_types: { key: "deliverable_types", label: "Deliverable Types", table: "mo_deliverable_types",
      fields: [
        { name: "name", label: "Name", type: "text", required: true },
        { name: "slug", label: "Slug", type: "slug" },
        { name: "icon", label: "Icon", type: "icon" },
        { name: "default_weight", label: "Default weight", type: "number", def: 1 },
        { name: "default_unit", label: "Default unit", type: "text" },
        { name: "review_exempt", label: "Review exempt (BR-6)", type: "switch", def: false },
        { name: "sort_order", label: "Sort order", type: "number", def: 0 }],
      cols: ["name", "icon", "default_weight", "default_unit", "review_exempt"],
      deps: [{ table: "mo_deliverables", fk: "deliverable_type_id", label: "Deliverables" },
             { table: "mo_template_deliverables", fk: "deliverable_type_id", label: "Template items" }] },
    task_categories: { key: "task_categories", label: "Task Categories", table: "mo_task_categories",
      fields: [
        { name: "name", label: "Name", type: "text", required: true },
        { name: "icon", label: "Icon", type: "icon" },
        { name: "sort_order", label: "Sort order", type: "number", def: 0 }],
      cols: ["name", "icon", "sort_order"],
      deps: [{ table: "mo_report_tasks", fk: "task_category_id", label: "Task logs" }] },
    equipment_categories: { key: "equipment_categories", label: "Equipment Categories", table: "mo_equipment_categories",
      fields: [
        { name: "name", label: "Name", type: "text", required: true },
        { name: "icon", label: "Icon", type: "icon" },
        { name: "tracking_mode", label: "Tracking mode", type: "select", options: ["individual", "pooled"], def: "individual" },
        { name: "sort_order", label: "Sort order", type: "number", def: 0 }],
      cols: ["name", "icon", "tracking_mode"],
      deps: [{ table: "mo_equipment_items", fk: "category_id", label: "Equipment items" }] },
    leave_types: { key: "leave_types", label: "Leave Types", table: "mo_leave_types",
      fields: [
        { name: "name", label: "Name", type: "text", required: true },
        { name: "annual_quota", label: "Annual quota (days)", type: "number" }],
      cols: ["name", "annual_quota"],
      deps: [{ table: "mo_leave_requests", fk: "leave_type_id", label: "Leave requests" }] },
    skills: { key: "skills", label: "Skills", table: "mo_skills",
      fields: [
        { name: "name", label: "Name", type: "text", required: true },
        { name: "category", label: "Category", type: "text" }],
      cols: ["name", "category"],
      deps: [{ table: "mo_user_skills", fk: "skill_id", label: "Member skills" }] },
    capacity_roles: { key: "capacity_roles", label: "Capacity Roles", table: "mo_capacity_roles",
      fields: [{ name: "name", label: "Name", type: "text", required: true }],
      cols: ["name"],
      deps: [{ table: "mo_project_assignments", fk: "capacity_role_id", label: "Project assignments" },
             { table: "mo_shoot_crew", fk: "capacity_role_id", label: "Shoot crew" }] },
    vendors: { key: "vendors", label: "Vendors", table: "mo_vendors",
      fields: [
        { name: "name", label: "Name", type: "text", required: true },
        { name: "contact", label: "Contact person", type: "text" },
        { name: "phone", label: "Phone", type: "text" },
        { name: "email", label: "Email", type: "text" },
        { name: "notes", label: "Notes", type: "textarea" }],
      cols: ["name", "contact", "phone"],
      deps: [{ table: "mo_equipment_items", fk: "vendor_id", label: "Equipment items" },
             { table: "mo_maintenance_records", fk: "vendor_id", label: "Maintenance records" }] },
    tags: { key: "tags", label: "Tags", table: "mo_tags",
      fields: [
        { name: "name", label: "Name", type: "text", required: true },
        { name: "color", label: "Colour", type: "color" }],
      cols: ["name", "color"],
      deps: [{ table: "mo_entity_tags", fk: "tag_id", label: "Tagged records" }] },
    duty_flags: { key: "duty_flags", label: "Duty Flags", table: "mo_duty_flags",
      fields: [
        { name: "code", label: "Code", type: "slug", required: true },
        { name: "name", label: "Name", type: "text", required: true },
        { name: "description", label: "Description", type: "textarea" }],
      cols: ["code", "name"],
      deps: [{ table: "mo_user_duties", fk: "duty_flag_id", label: "Duty holders" }] },
    academic_years: { key: "academic_years", label: "Academic Years", table: "mo_academic_years",
      fields: [
        { name: "label", label: "Label", type: "text", required: true },
        { name: "start_date", label: "Starts", type: "date", required: true },
        { name: "end_date", label: "Ends", type: "date", required: true },
        { name: "is_current", label: "Current year", type: "switch", def: false }],
      cols: ["label", "start_date", "end_date", "is_current"],
      deps: [{ table: "mo_projects", fk: "academic_year_id", label: "Projects" }] },
    campuses: { key: "campuses", label: "Campuses", table: "mo_campuses",
      fields: [
        { name: "name", label: "Name", type: "text", required: true },
        { name: "code", label: "Code", type: "slug", required: true },
        { name: "city", label: "City", type: "text" }],
      cols: ["name", "code", "city"],
      deps: [{ table: "mo_holidays", fk: "campus_id", label: "Holidays" },
             { table: "mo_equipment_items", fk: "campus_id", label: "Equipment items" },
             { table: "mo_user_profiles", fk: "campus_id", label: "User profiles" }] },
    holidays: { key: "holidays", label: "Holidays", table: "mo_holidays",
      fields: [
        { name: "date", label: "Date", type: "date", required: true },
        { name: "name", label: "Name", type: "text", required: true },
        { name: "campus_id", label: "Campus", type: "relation", relation: { module: "campuses", labelCol: "name" } }],
      cols: ["date", "name", "campus_id"], deps: [] },
    automation_rules: { key: "automation_rules", label: "Automation Rules", table: "mo_automation_rules",
      activeCol: "is_enabled",
      fields: [
        { name: "rule_key", label: "Rule key", type: "slug", required: true },
        { name: "is_enabled", label: "Enabled", type: "switch", def: true }],
      cols: ["rule_key", "is_enabled"], deps: [] },
  };
  const CRUD_ICONS = ["◆", "●", "▲", "■", "◉", "✦", "⚑", "✎", "◈", "⛁", "▤", "☂", "♪", "✈", "☎"];

  // Permission engine: Admin = everything · Team Lead = view/edit/enable-disable ·
  // Employee = read-only. Archive + delete are Admin-only (VR-11 spirit).
  function crudCan(u: CurrentUser) {
    const r = moRoleOf(u);
    return { read: true, create: r === "admin" || r === "team_lead", update: r === "admin" || r === "team_lead",
             state: r === "admin" || r === "team_lead", archive: r === "admin", delete: r === "admin" };
  }
  const crudMod = (res: express.Response, key: string): CrudModule | null => {
    const m = CRUD[key]; if (!m) sendError(res, 400, "Unknown config module."); return m ?? null;
  };
  // Validate + coerce a payload against the module's field metadata.
  function crudValidate(m: CrudModule, b: Record<string, unknown>, partial: boolean): { ok: true; rec: Record<string, unknown> } | { ok: false; msg: string } {
    const rec: Record<string, unknown> = {};
    for (const f of m.fields) {
      let v = b[f.name];
      if (v === undefined) { if (partial) continue; v = f.def; }
      if ((f.type === "slug") && (v == null || v === "") && typeof b.name === "string" && f.name === "slug")
        v = (b.name as string).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      if (f.required && (v == null || v === "")) return { ok: false, msg: `${f.label} is required.` };
      if (v == null || v === "") { rec[f.name] = f.type === "switch" ? false : null; continue; }
      switch (f.type) {
        case "number": { const n = Number(v); if (Number.isNaN(n)) return { ok: false, msg: `${f.label} must be a number.` }; rec[f.name] = n; break; }
        case "switch": rec[f.name] = v === true || v === "true" || v === 1; break;
        case "select": if (f.options && !f.options.includes(String(v))) return { ok: false, msg: `${f.label}: invalid option.` }; rec[f.name] = String(v); break;
        case "relation": rec[f.name] = Number(v) || null; break;
        case "slug": rec[f.name] = String(v).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-|-$/g, ""); break;
        default: rec[f.name] = String(v);
      }
    }
    return { ok: true, rec };
  }
  async function crudDeps(m: CrudModule, id: number): Promise<{ label: string; count: number }[]> {
    const out: { label: string; count: number }[] = [];
    for (const d of m.deps) {
      const r = await pool.query(`SELECT COUNT(*)::int c FROM ${d.table} WHERE ${d.fk}=$1`, [id]);
      if (r.rows[0].c > 0) out.push({ label: d.label, count: r.rows[0].c });
    }
    return out;
  }

  // Meta — module definitions + relation options + the caller's permissions.
  app.get(`${P}/crud/meta`, asyncHandler(async (_req, res) => {
    const u = requireMedia(res); if (!u) return;
    const can = crudCan(u);
    const out: Record<string, unknown>[] = [];
    for (const m of Object.values(CRUD)) {
      const fields = [];
      for (const f of m.fields) {
        const ff: Record<string, unknown> = { ...f };
        if (f.type === "relation" && f.relation) {
          const rm = CRUD[f.relation.module];
          const opts = await pool.query(`SELECT id, ${f.relation.labelCol} AS l FROM ${rm.table} WHERE archived_at IS NULL ORDER BY 2`);
          ff.options2 = opts.rows.map((r) => ({ v: Number(r.id), l: r.l }));
        }
        fields.push(ff);
      }
      out.push({ key: m.key, label: m.label, cols: m.cols, fields, activeCol: m.activeCol ?? "is_active", deps: m.deps.map((d) => d.label) });
    }
    res.json({ modules: out, can, icons: CRUD_ICONS });
  }));

  // List — search / status filter / sort / pagination.
  app.get(`${P}/crud/:module`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    const m = crudMod(res, getSingleParam(req.params.module)); if (!m) return;
    const q = req.query as Record<string, string>;
    const ac = m.activeCol ?? "is_active";
    const conds: string[] = [], vals: unknown[] = []; let i = 1;
    const status = q.status || "active";
    if (status === "active") conds.push(`${ac}=true AND archived_at IS NULL`);
    else if (status === "disabled") conds.push(`${ac}=false AND archived_at IS NULL`);
    else if (status === "archived") conds.push(`archived_at IS NOT NULL`);
    if (q.q) {
      const textCols = m.fields.filter((f) => ["text", "textarea", "slug"].includes(f.type)).map((f) => f.name);
      if (textCols.length) { conds.push(`(${textCols.map((c) => `${c}::text ILIKE $${i}`).join(" OR ")})`); vals.push(`%${q.q}%`); i++; }
    }
    const sortable = new Set([...m.cols, "id", "created_at", "updated_at"]);
    const sort = sortable.has(q.sort) ? q.sort : "id";
    const dir = q.dir === "desc" ? "DESC" : "ASC";
    const per = Math.min(50, Math.max(5, parseInt(q.per || "12", 10)));
    const page = Math.max(1, parseInt(q.page || "1", 10));
    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
    const total = (await pool.query(`SELECT COUNT(*)::int c FROM ${m.table} ${where}`, vals)).rows[0].c;
    const rows = (await pool.query(
      `SELECT * FROM ${m.table} ${where} ORDER BY ${sort} ${dir} NULLS LAST LIMIT ${per} OFFSET ${(page - 1) * per}`, vals)).rows;
    res.json({ rows, total, page, per });
  }));

  // One record — row + dependency usage + audit history (View drawer tabs).
  app.get(`${P}/crud/:module/:id`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    const m = crudMod(res, getSingleParam(req.params.module)); if (!m) return;
    const id = parseInt(getSingleParam(req.params.id), 10);
    const row = (await pool.query(`SELECT * FROM ${m.table} WHERE id=$1`, [id])).rows[0];
    if (!row) return sendError(res, 404, "Record not found.");
    const deps = await crudDeps(m, id);
    const hist = (await pool.query(
      `SELECT a.action, a.before, a.after, a.occurred_at, us.full_name AS actor
       FROM mo_audit_logs a LEFT JOIN users us ON us.id=a.actor_id
       WHERE a.entity_type=$1 AND a.entity_id=$2 ORDER BY a.occurred_at DESC LIMIT 30`, [m.key, id])).rows;
    res.json({ row, dependencies: deps, audit: hist });
  }));

  // Create.
  app.post(`${P}/crud/:module`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    if (!crudCan(u).create) return sendError(res, 403, "You don't have permission to create records.");
    const m = crudMod(res, getSingleParam(req.params.module)); if (!m) return;
    const v = crudValidate(m, req.body as Record<string, unknown>, false);
    if (!v.ok) return sendError(res, 400, v.msg);
    v.rec.created_by = u.id;
    const keys = Object.keys(v.rec);
    try {
      const ins = await pool.query(
        `INSERT INTO ${m.table} (${keys.join(",")}) VALUES (${keys.map((_, ix) => "$" + (ix + 1)).join(",")}) RETURNING *`,
        keys.map((k) => v.rec[k]));
      await audit(u, "crud.created", m.key, ins.rows[0].id, null, v.rec, req);
      res.status(201).json({ row: ins.rows[0] });
    } catch (e) {
      if ((e as { code?: string }).code === "23505") return sendError(res, 409, "A record with that name/slug already exists (VR-11: unique per department).");
      throw e;
    }
  }));

  // Update (every editable field).
  app.patch(`${P}/crud/:module/:id`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    if (!crudCan(u).update) return sendError(res, 403, "You don't have permission to edit records.");
    const m = crudMod(res, getSingleParam(req.params.module)); if (!m) return;
    const id = parseInt(getSingleParam(req.params.id), 10);
    const cur = (await pool.query(`SELECT * FROM ${m.table} WHERE id=$1`, [id])).rows[0];
    if (!cur) return sendError(res, 404, "Record not found.");
    const v = crudValidate(m, req.body as Record<string, unknown>, true);
    if (!v.ok) return sendError(res, 400, v.msg);
    const keys = Object.keys(v.rec);
    if (!keys.length) return res.json({ row: cur });
    try {
      const upd = await pool.query(
        `UPDATE ${m.table} SET ${keys.map((k, ix) => `${k}=$${ix + 1}`).join(",")}, updated_at=NOW() WHERE id=$${keys.length + 1} RETURNING *`,
        [...keys.map((k) => v.rec[k]), id]);
      await audit(u, "crud.updated", m.key, id, cur, v.rec, req);
      res.json({ row: upd.rows[0] });
    } catch (e) {
      if ((e as { code?: string }).code === "23505") return sendError(res, 409, "A record with that name/slug already exists.");
      throw e;
    }
  }));

  // Duplicate — clone all editable fields, auto "(Copy)".
  app.post(`${P}/crud/:module/:id/duplicate`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    if (!crudCan(u).create) return sendError(res, 403, "You don't have permission to duplicate records.");
    const m = crudMod(res, getSingleParam(req.params.module)); if (!m) return;
    const id = parseInt(getSingleParam(req.params.id), 10);
    const cur = (await pool.query(`SELECT * FROM ${m.table} WHERE id=$1`, [id])).rows[0];
    if (!cur) return sendError(res, 404, "Record not found.");
    const rec: Record<string, unknown> = {};
    const suffix = Math.random().toString(36).slice(2, 6);
    for (const f of m.fields) {
      let v = cur[f.name];
      if (["name", "label"].includes(f.name) && typeof v === "string") v = `${v} (Copy)`;
      if (f.type === "slug" && typeof v === "string") v = `${v}-copy-${suffix}`;
      rec[f.name] = v;
    }
    rec.created_by = u.id;
    const keys = Object.keys(rec);
    const ins = await pool.query(
      `INSERT INTO ${m.table} (${keys.join(",")}) VALUES (${keys.map((_, ix) => "$" + (ix + 1)).join(",")}) RETURNING *`,
      keys.map((k) => rec[k]));
    await audit(u, "crud.duplicated", m.key, ins.rows[0].id, { source: id }, rec, req);
    res.status(201).json({ row: ins.rows[0] });
  }));

  // Enable / Disable / Archive / Restore.
  app.post(`${P}/crud/:module/:id/state`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    const m = crudMod(res, getSingleParam(req.params.module)); if (!m) return;
    const id = parseInt(getSingleParam(req.params.id), 10);
    const action = String((req.body as Record<string, unknown>).action);
    const can = crudCan(u);
    if (["enable", "disable"].includes(action) && !can.state) return sendError(res, 403, "No permission.");
    if (["archive", "restore"].includes(action) && !can.archive) return sendError(res, 403, "Archive is Admin-only.");
    const ac = m.activeCol ?? "is_active";
    const sql = { enable: `${ac}=true`, disable: `${ac}=false`, archive: `archived_at=NOW()`, restore: `archived_at=NULL` }[action];
    if (!sql) return sendError(res, 400, "Unknown action.");
    await pool.query(`UPDATE ${m.table} SET ${sql}, updated_at=NOW() WHERE id=$1`, [id]);
    await audit(u, `crud.${action}d`, m.key, id, null, { action }, req);
    res.json({ ok: true });
  }));

  // Delete — dependency analysis first; refuse (409) when referenced.
  app.delete(`${P}/crud/:module/:id`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    if (!crudCan(u).delete) return sendError(res, 403, "Delete is Admin-only.");
    const m = crudMod(res, getSingleParam(req.params.module)); if (!m) return;
    const id = parseInt(getSingleParam(req.params.id), 10);
    const deps = await crudDeps(m, id);
    if (deps.length) {
      res.status(409).json({
        message: `Cannot delete — in use by ${deps.map((d) => `${d.count} ${d.label}`).join(", ")}. Archive it instead (VR-11).`,
        dependencies: deps,
      });
      return;
    }
    await pool.query(`DELETE FROM ${m.table} WHERE id=$1`, [id]);
    await audit(u, "crud.deleted", m.key, id, null, null, req);
    res.json({ ok: true });
  }));

  // Bulk — enable / disable / archive / delete across a selection.
  app.post(`${P}/crud/:module/bulk`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    const m = crudMod(res, getSingleParam(req.params.module)); if (!m) return;
    const b = req.body as Record<string, unknown>;
    const ids = (Array.isArray(b.ids) ? b.ids : []).map(Number).filter(Boolean);
    const action = String(b.action);
    const can = crudCan(u);
    if (["enable", "disable"].includes(action) && !can.state) return sendError(res, 403, "No permission.");
    if (action === "archive" && !can.archive) return sendError(res, 403, "Archive is Admin-only.");
    if (action === "delete" && !can.delete) return sendError(res, 403, "Delete is Admin-only.");
    const ac = m.activeCol ?? "is_active";
    let done = 0, blocked = 0;
    for (const id of ids) {
      if (action === "delete") {
        const deps = await crudDeps(m, id);
        if (deps.length) { blocked++; continue; }
        await pool.query(`DELETE FROM ${m.table} WHERE id=$1`, [id]);
      } else {
        const sql = { enable: `${ac}=true`, disable: `${ac}=false`, archive: `archived_at=NOW()` }[action];
        if (!sql) return sendError(res, 400, "Unknown bulk action.");
        await pool.query(`UPDATE ${m.table} SET ${sql}, updated_at=NOW() WHERE id=$1`, [id]);
      }
      done++;
    }
    await audit(u, `crud.bulk_${action}`, m.key, null, null, { ids, done, blocked }, req);
    res.json({ done, blocked });
  }));

  // ═════════════════════════ DASHBOARD (§7.1) ═════════════════════════════
  app.get(`${P}/dashboard`, asyncHandler(async (_req, res) => {
    const u = requireMedia(res); if (!u) return;
    const today = new Date().toISOString().slice(0, 10);
    const [active, dueWeek, overdue, shootsToday, equipOut, pendingReports] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int c FROM mo_projects WHERE status IN ('planning','in_production','in_review','approved') AND deleted_at IS NULL`),
      pool.query(`SELECT COUNT(*)::int c FROM mo_deliverables WHERE due_date BETWEEN $1 AND ($1::date + 7) AND status NOT IN ('delivered','not_required','cancelled')`, [today]),
      pool.query(`SELECT COUNT(*)::int c FROM mo_deliverables WHERE due_date < $1 AND status NOT IN ('delivered','not_required','cancelled')`, [today]),
      pool.query(`SELECT COUNT(*)::int c FROM mo_shoots WHERE shoot_date=$1 AND status<>'cancelled'`, [today]),
      pool.query(`SELECT COUNT(*)::int c FROM mo_equipment_items WHERE status='checked_out'`),
      pool.query(`SELECT COUNT(*)::int c FROM mo_daily_reports WHERE status IN ('flagged','submitted')`),
    ]);
    res.json({
      active_projects: active.rows[0].c, deliverables_due_week: dueWeek.rows[0].c, overdue_deliverables: overdue.rows[0].c,
      shoots_today: shootsToday.rows[0].c, equipment_out: equipOut.rows[0].c, reports_to_review: pendingReports.rows[0].c,
    });
  }));

  // ── helpers ───────────────────────────────────────────────────────────────
  async function refreshReportTotal(rid: number) {
    await pool.query(`UPDATE mo_daily_reports SET total_minutes=(SELECT COALESCE(SUM(minutes),0) FROM mo_report_tasks WHERE daily_report_id=$1) WHERE id=$1`, [rid]);
  }
  // AUTO-13 flag rules (D2).
  async function evaluateFlags(userId: string, date: string, tasks: Record<string, unknown>[]): Promise<string[]> {
    const cfg = (await pool.query(`SELECT config FROM mo_automation_rules WHERE rule_key='AUTO-13'`)).rows[0]?.config ?? {};
    const out: string[] = [];
    const total = tasks.reduce((s, t) => s + (Number(t.minutes) || 0), 0);
    if (total > (cfg.max_hours ?? 14) * 60) out.push(`Total logged hours above ${cfg.max_hours ?? 14}h`);
    if (total < (cfg.min_hours ?? 2) * 60) out.push(`Total logged hours below ${cfg.min_hours ?? 2}h on a working day`);
    if (tasks.some(t => t.deliverable_id && t.status === "done" && !(Array.isArray(t.evidence) && (t.evidence as unknown[]).length)))
      out.push("Deliverable-completion claim without an evidence link");
    const descs = tasks.map(t => t.description);
    if (descs.length >= (cfg.identical_streak ?? 3) && new Set(descs).size === 1) out.push(`${cfg.identical_streak ?? 3}+ identical task descriptions`);
    return out;
  }
}

// ── date/time utils ─────────────────────────────────────────────────────────
function t2m(t: string): number { if (!t) return 0; const [a, b] = t.split(":").map(Number); return (a || 0) * 60 + (b || 0); }
function addDays(iso: string, n: number): string {
  const d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10);
}

// ═══════════════════════════════════════════════════════════════════════════
// Automation engine (§17) — invoked on a scheduler (see server/index.ts). Runs
// the time-based rules the request path cannot: BR-4 report auto-approve, and the
// server-persisted notification feed (AUTO-1/2/3 + review-pending). Idempotent —
// notifications dedupe on (user, kind, entity) while unread, so re-runs never spam.
// ═══════════════════════════════════════════════════════════════════════════
export async function runMediaOpsAutomations(): Promise<{ autoApproved: number; notified: number }> {
  let notified = 0;
  // BR-4 / D2 — reports auto-approve 48 h after submission unless flagged.
  const aa = await pool.query(
    `UPDATE mo_daily_reports SET status='auto_approved', reviewed_at=NOW()
      WHERE status='submitted' AND submitted_at IS NOT NULL AND submitted_at < NOW() - INTERVAL '48 hours'
      RETURNING id`);
  for (const r of aa.rows)
    await pool.query(
      `INSERT INTO mo_audit_logs (actor_id, actor_role, action, entity_type, entity_id, after)
       VALUES (NULL,'system','report.auto_approved','daily_report',$1,$2)`,
      [r.id, JSON.stringify({ status: "auto_approved", rule: "BR-4 (48h, unflagged)" })]).catch(() => {});

  const notify = async (userId: string, kind: string, title: string, body: string, et: string, eid: number | null) => {
    const r = await pool.query(
      `INSERT INTO mo_notifications (user_id, kind, title, body, entity_type, entity_id)
       SELECT $1,$2,$3,$4,$5,$6
        WHERE NOT EXISTS (SELECT 1 FROM mo_notifications n
                          WHERE n.user_id=$1 AND n.kind=$2 AND n.entity_type=$5
                            AND COALESCE(n.entity_id,-1)=COALESCE($6::bigint,-1) AND n.is_read=false)`,
      [userId, kind, title, body, et, eid]);
    notified += r.rowCount ?? 0;
  };

  // AUTO-2 — overdue deliverables → owner.
  for (const d of (await pool.query(
    `SELECT id, title, owner_id, due_date FROM mo_deliverables
      WHERE deleted_at IS NULL AND due_date < CURRENT_DATE
        AND status NOT IN ('delivered','not_required','cancelled') AND owner_id IS NOT NULL`)).rows)
    await notify(d.owner_id, "overdue", "Deliverable overdue", `“${d.title}” was due ${String(d.due_date).slice(0, 10)}`, "deliverable", d.id);

  // Review pending → the project PM.
  for (const d of (await pool.query(
    `SELECT d.id, d.title, a.user_id AS pm FROM mo_deliverables d
       JOIN mo_project_assignments a ON a.project_id=d.project_id AND a.is_project_manager AND a.removed_at IS NULL
      WHERE d.status='in_review'`)).rows)
    await notify(d.pm, "approval", "Awaiting your review", `“${d.title}” has a version pending`, "deliverable", d.id);

  // AUTO-3 — overdue equipment → current holder.
  for (const t of (await pool.query(
    `SELECT DISTINCT ON (t.equipment_item_id) t.equipment_item_id AS id, t.holder_id, t.expected_return_at, e.asset_tag
       FROM mo_equipment_transactions t JOIN mo_equipment_items e ON e.id=t.equipment_item_id
      WHERE e.status='checked_out'
      ORDER BY t.equipment_item_id, t.occurred_at DESC`)).rows)
    if (t.expected_return_at && new Date(t.expected_return_at) < new Date())
      await notify(t.holder_id, "overdue", "Equipment overdue", `${t.asset_tag} is past its return date`, "equipment", t.id);

  // AUTO-1 — today's report not submitted (working day, not on leave) → nudge the member.
  if (new Date().getDay() !== 0)
    for (const p of (await pool.query(
      `SELECT u.id FROM users u
        WHERE u.team='media' AND COALESCE(u.role,'user') <> 'admin'
          AND NOT EXISTS (SELECT 1 FROM mo_daily_reports r WHERE r.user_id=u.id AND r.report_date=CURRENT_DATE AND r.status <> 'draft')
          AND NOT EXISTS (SELECT 1 FROM mo_leave_requests l WHERE l.user_id=u.id AND l.status='approved' AND CURRENT_DATE BETWEEN l.starts_on AND l.ends_on)`)).rows)
      await notify(p.id, "reminder", "Daily report not submitted", "Log your tasks and submit today’s report (AUTO-1).", "report", null);

  return { autoApproved: aa.rowCount ?? 0, notified };
}
