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
  ];
  app.get(`${P}/state`, asyncHandler(async (_req, res) => {
    if (!requireMedia(res)) return;
    const out: Record<string, unknown[]> = {};
    for (const [key, table, where, refs] of STATE) {
      const { rows } = await pool.query(`SELECT to_jsonb(t) AS row FROM ${table} t${where ? " WHERE " + where : ""}`);
      out[key] = rows.map((r) => {
        const o = r.row as Record<string, unknown>;
        for (const f of refs) o[f] = uidToInt(o[f]);
        return o;
      });
    }
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
    // FR-3.2: auto-create the type's template deliverable set.
    let made = 0;
    const tmpl = await pool.query(`SELECT id FROM mo_project_templates WHERE project_type_id=$1 AND is_active LIMIT 1`, [typeId]);
    if (tmpl.rows[0]) {
      const items = await pool.query(`SELECT * FROM mo_template_deliverables WHERE template_id=$1`, [tmpl.rows[0].id]);
      for (const it of items.rows) {
        await pool.query(
          `INSERT INTO mo_deliverables (project_id, deliverable_type_id, title, owner_id, due_date, unit, weight, status)
           SELECT $1,$2,$3,$4,$5, dt.default_unit, $6,'not_started' FROM mo_deliverable_types dt WHERE dt.id=$2`,
          [id, it.deliverable_type_id, String(it.title_pattern).replace("{project}", name), u.id,
           end ? addDays(end, it.days_offset_due) : null, it.default_weight]);
        made++;
      }
    }
    await audit(u, "project.created", "project", id, null, { name, status: gated ? "proposed" : "planning", deliverables_created: made }, req);
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
    res.json({ ok: true });
  }));

  app.delete(`${P}/tasks/:id`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    const id = parseInt(getSingleParam(req.params.id), 10);
    const cur = await pool.query(`SELECT daily_report_id FROM mo_report_tasks WHERE id=$1`, [id]);
    if (!cur.rows[0]) return sendError(res, 404, "Task not found.");
    await pool.query(`DELETE FROM mo_report_tasks WHERE id=$1`, [id]);
    await refreshReportTotal(cur.rows[0].daily_report_id);
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
