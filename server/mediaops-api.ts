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
import { randomUUID } from "node:crypto";

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
/* The Media Operations Coordinator is a MEDIA-department role stored on
   mo_user_profiles.mo_role, so Nerve-wide three-role parity is untouched: at the
   platform level a coordinator is an ordinary 'user'.

   That is deliberate for permissions too. moRoleOf() resolves a coordinator to
   'employee', so every EXISTING gate (approve a version, review a report, edit
   production work, admin settings) denies them by default — which is exactly the
   role's "Cannot" list. Their extra rights are granted only by the operational
   endpoints below, each of which checks isCoordinator() explicitly. */
async function isCoordinator(u: CurrentUser): Promise<boolean> {
  if (u.team !== "media") return false;
  const r = (await pool.query(`SELECT mo_role FROM mo_user_profiles WHERE user_id=$1`, [u.id])).rows[0];
  return r?.mo_role === "coordinator";
}

/* Has an administrator explicitly granted this user a module?

   allowed_modules is NULL for "role based" and an array once an admin has set it
   explicitly, so a grant only exists in the array case. This is the API half of
   the same rule the client applies in grantedByModule(): an explicit grant ADDS
   a capability on top of the role. Before this existed, module access could only
   ever subtract, so ticking a box for a module the role did not already imply
   changed nothing — the sidebar stayed hidden and the API kept answering 403. */
async function hasModuleGrant(u: CurrentUser, key: string): Promise<boolean> {
  const row = (await pool.query(
    `SELECT allowed_modules FROM mo_user_profiles WHERE user_id=$1`, [u.id])).rows[0];
  const am = row?.allowed_modules;
  return Array.isArray(am) && am.includes(key);
}

/* ── SMC — Social Media Council ────────────────────────────────────────────
   An SMC member is an institute student on the coverage network, not Media
   Crew. They are stored with team='smc', which means moRoleOf() returns null
   for them and EVERY pre-existing media-ops route already refuses them — the
   deny-by-default model does the work, so §41's deny list needs no new
   enforcement code. Their access is granted only by the /smc/* routes below,
   each of which re-checks ownership. */
async function isSmcMember(u: CurrentUser): Promise<boolean> {
  if (u.team !== "smc") return false;
  const r = (await pool.query(
    `SELECT is_active FROM mo_smc_profiles WHERE user_id=$1`, [u.id])).rows[0];
  return !!r?.is_active;   // a deactivated member keeps their history but loses access (§21)
}

/* Who may run SMC Management. A duty rather than a tier, exactly like Casting
   Manager — so an Admin, a Team Lead or the Operations Coordinator can hold it
   without inventing a role (§15). Admins always qualify. */
async function isSmcManager(u: CurrentUser): Promise<boolean> {
  if (isMoAdmin(u)) return true;
  // An explicit Module Access grant is sufficient on its own — the duty is one
  // way to hold this, not the only way (§ Module Access).
  if (await hasModuleGrant(u, "smc")) return true;
  if (u.team !== "media") return false;
  const r = (await pool.query(
    `SELECT 1 FROM mo_user_duties d JOIN mo_duty_flags f ON f.id=d.duty_flag_id
      WHERE d.user_id=$1 AND f.code='smc_manager' AND f.is_active`, [u.id])).rows[0];
  return !!r;
}

export function registerMediaOpsApi(app: express.Express, h: Handlers) {
  const { asyncHandler, sendError, getSingleParam } = h;
  const P = "/api/v1/media";

  // Guard: every media-ops route requires a media-team member (or super admin).
  function requireMedia(res: express.Response): CurrentUser | null {
    const u = res.locals.currentUser as CurrentUser;
    if (!moRoleOf(u)) { sendError(res, 403, "Media Crew access only."); return null; }
    return u;
  }

  // ── Assignable-member scoping (§16) ──────────────────────────────────────
  // Who may this actor put on a project, a deliverable or a task?
  //   Admin      → every active media crew member (no department limit).
  //   Team Lead  → only members of the team(s) they lead, plus themselves.
  //   Employee   → themselves only.
  // Enforced server-side on every assignment path; the UI merely mirrors it.
  async function assignableMemberIds(actor: CurrentUser): Promise<Set<string>> {
    const role = moRoleOf(actor);
    if (role === "admin") {
      const { rows } = await pool.query(`SELECT id FROM users WHERE team='media'`);
      return new Set(rows.map((r) => String(r.id)));
    }
    const out = new Set<string>([actor.id]);
    if (role === "team_lead") {
      const { rows } = await pool.query(
        `SELECT tm.user_id FROM mo_team_members tm
           JOIN mo_teams t ON t.id = tm.team_id
          WHERE t.lead_user_id = $1 AND t.is_active`, [actor.id]);
      rows.forEach((r) => out.add(String(r.user_id)));
    }
    return out;
  }

  /** Reject the request when any id falls outside the actor's assignable scope. */
  async function assertAssignable(res: express.Response, actor: CurrentUser, ids: string[]): Promise<boolean> {
    const wanted = ids.filter(Boolean);
    if (!wanted.length) return true;
    const allowed = await assignableMemberIds(actor);
    const bad = wanted.filter((id) => !allowed.has(id));
    if (bad.length) {
      sendError(res, 403, moRoleOf(actor) === "team_lead"
        ? "You can only assign members of your own team."
        : "You can only assign yourself.");
      return false;
    }
    return true;
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

  /** pg returns DATE as a JS Date; render it as plain YYYY-MM-DD so audit rows
      compare like-for-like instead of shifting by timezone. */
  const dOnly = (v: unknown): string | null => {
    if (v == null) return null;
    if (v instanceof Date) {
      return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, "0")}-${String(v.getDate()).padStart(2, "0")}`;
    }
    return String(v).slice(0, 10);
  };

  // Append-only audit (FR-13). Never throws into the request path.
  async function audit(actor: CurrentUser, action: string, entityType: string, entityId: number | null,
                       before: unknown, after: unknown, req: express.Request) {
    try {
      await pool.query(
        `INSERT INTO mo_audit_logs (actor_id, actor_role, action, entity_type, entity_id, before, after, ip, user_agent)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [actor.id, moRoleOf(actor) ?? actor.role /* D4: one role vocabulary in the trail */, action, entityType, entityId,
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
    // Orphan guard (G1): never ship deliverables whose parent project is deleted.
    ["deliverables", "mo_deliverables", "deleted_at IS NULL AND project_id IN (SELECT id FROM mo_projects WHERE deleted_at IS NULL)", ["owner_id", "delivered_by", "approved_by"]],
    ["deliverable_versions", "mo_deliverable_versions", null, ["submitted_by", "reviewed_by"]],
    ["drive_links", "mo_drive_links", null, ["added_by"]],
    ["daily_reports", "mo_daily_reports", null, ["user_id", "reviewed_by", "last_edited_by"]],
    ["report_tasks", "mo_report_tasks", null, []],
    // Phase 2 — equipment, shoots, leave
    ["vendors", "mo_vendors", "archived_at IS NULL", []],
    ["equipment_categories", "mo_equipment_categories", "archived_at IS NULL", []],
    ["equipment_items", "mo_equipment_items", "deleted_at IS NULL", []],
    ["equipment_kits", "mo_equipment_kits", null, []],
    ["kit_items", "mo_kit_items", null, []],
    ["equipment_bookings", "mo_equipment_bookings", null, ["user_id", "created_by"]],
    ["equipment_transactions", "mo_equipment_transactions", null, ["holder_id", "recorded_by"]],
    ["maintenance_records", "mo_maintenance_records", null, ["reported_by"]],
    ["shoots", "mo_shoots", "deleted_at IS NULL", ["created_by"]],
    ["shoot_crew", "mo_shoot_crew", null, ["user_id", "replaced_user_id"]],
    ["leave_types", "mo_leave_types", "archived_at IS NULL", []],
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
    // Operations Coordinator: intake + coordination logs.
    ["requests", "mo_requests", null, ["received_by", "converted_by", "lead_user_id"]],
    ["request_links", "mo_request_links", null, ["created_by"]],
    ["meetings", "mo_meetings", null, ["logged_by"]],
    ["vendor_activities", "mo_vendor_activities", null, ["logged_by"]],
    ["followups", "mo_followups", null, ["owner_id"]],
    // Casting library. Records ship in full; the preview filters client-side on
    // consent + archive so an employee never sees a record that is not cleared.
    ["casting_records", "mo_casting_records", null, ["created_by", "updated_by"]],
    ["casting_tags", "mo_casting_tags", null, ["created_by"]],
    ["casting_collections", "mo_casting_collections", null, ["created_by"]],
    ["casting_record_tags", "mo_casting_record_tags", null, []],
    ["casting_record_collections", "mo_casting_record_collections", null, []],
    ["casting_requests", "mo_casting_requests", null, ["requested_by", "handled_by"]],
    ["casting_links", "mo_casting_links", null, ["created_by"]],
    ["project_casting", "mo_project_casting", null, ["linked_by"]],
    ["automation_rules", "mo_automation_rules", null, ["updated_by"]],
    // Admin configuration (CRUD engine) — the DB is the source of truth for every
    // picker/template in the operational UI. Archived rows are excluded (cannot be
    // selected); disabled rows ship and are filtered by is_active client-side.
    ["project_types", "mo_project_types", "archived_at IS NULL", []],
    ["deliverable_types", "mo_deliverable_types", "archived_at IS NULL", []],
    ["task_categories", "mo_task_categories", "archived_at IS NULL", []],
    ["project_templates", "mo_project_templates", "archived_at IS NULL", []],
    ["template_deliverables", "mo_template_deliverables", null, []],
    ["academic_years", "mo_academic_years", "archived_at IS NULL", []],
    // Archived units still ship: historical projects must keep rendering their
    // unit name. The pickers filter to is_active client-side.
    ["academic_units", "mo_academic_units", null, []],
    // Work Types drive the unified Assign Work form; archived ones ship so
    // historical shoots/tasks still resolve their type name.
    ["work_types", "mo_work_types", null, []],
    ["campuses", "mo_campuses", "archived_at IS NULL", []],
    ["capacity_roles", "mo_capacity_roles", "archived_at IS NULL", []],
    ["tags", "mo_tags", "archived_at IS NULL", []],
    // Org structure (§11.1) — drives real TL scoping (team_members) + custodian duty (user_duties).
    ["teams", "mo_teams", null, ["lead_user_id"]],
    ["team_members", "mo_team_members", null, ["user_id"]],
    ["duty_flags", "mo_duty_flags", "archived_at IS NULL", []],
    ["user_duties", "mo_user_duties", null, ["user_id", "granted_by"]],
    ["skills", "mo_skills", "archived_at IS NULL", []],
    ["user_skills", "mo_user_skills", null, ["user_id"]],
  ];
  app.get(`${P}/state`, asyncHandler(async (_req, res) => {
    /* An SMC member boots the same SPA but must never receive the crew payload:
       no roster, no projects, no deliverables, no other members' work (§42). The
       server decides what they get rather than trusting the client to ignore it,
       so this stays a data-scoping decision, not a UI one. They are the only
       person in their own users array, which is all me() needs. */
    const cu = res.locals.currentUser as CurrentUser;
    if (await isSmcMember(cu)) {
      const prof = (await pool.query(
        `SELECT p.*, un.name AS institute FROM mo_smc_profiles p
           LEFT JOIN mo_academic_units un ON un.id = p.academic_unit_id
          WHERE p.user_id=$1`, [cu.id])).rows[0] ?? null;
      const units = (await pool.query(
        `SELECT id, name FROM mo_academic_units WHERE is_active AND archived_at IS NULL ORDER BY name`)).rows;
      const notes = (await pool.query(
        `SELECT id, kind, title, body, entity_type, entity_id, is_read, created_at
           FROM mo_notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50`, [cu.id])).rows;
      const ME = 900;
      return res.json({
        me: ME,
        users: [{ id: ME, real_id: cu.id, full_name: cu.full_name ?? "SMC Member",
                  email: cu.email ?? "", role: "smc_member", avatar_url: null,
                  designation: prof?.designation ?? "SMC Member" }],
        academic_units: units,
        notifications: notes.map((n) => ({ ...n, user_id: ME })),
        smc_profile: prof,
      });
    }
    const u = requireMedia(res); if (!u) return;
    // Stable {real user id → prototype integer id} map for the media crew (+ the
    // current user if they aren't on the media team, e.g. super_admin). Used for
    // BOTH the user-ref columns and the roster, so identities line up even for real
    // (non-'mo-uN') users. This roster REPLACES the prototype's seed users.
    const crew = (await pool.query(
      `SELECT u.id, u.full_name, u.email, u.role, u.avatar_url, u.created_at,
              p.designation, p.joined_on, p.allowed_modules, p.mo_role,
              u.status, u.deactivated_at FROM users u LEFT JOIN mo_user_profiles p ON p.user_id=u.id
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
    /* The SMC roster — the SAME population SMC Management lists, so Team
       Directory and SMC Management can never disagree about who exists or how
       many there are. Deliberately NOT merged into users: that array is the
       Media Crew roster and every assignment picker iterates it, so an SMC
       member landing there would be offered as crew. The directory concatenates
       the two explicitly instead. */
    out.smc_people = (await pool.query(`
      SELECT u.id, u.full_name, u.email, u.avatar_url, COALESCE(u.status,'active') AS status,
             sp.designation, sp.phone, sp.coverage_area, sp.joining_date,
             sp.is_active, sp.academic_unit_id, un.name AS institute,
             p.allowed_modules,
             (SELECT COUNT(*) FROM mo_assignment_users au
                JOIN mo_assignments a ON a.id = au.assignment_id AND a.is_smc
               WHERE au.user_id = u.id) AS assignment_count
        FROM mo_smc_profiles sp
        JOIN users u ON u.id = sp.user_id
        LEFT JOIN mo_user_profiles p ON p.user_id = u.id
        LEFT JOIN mo_academic_units un ON un.id = sp.academic_unit_id
       ORDER BY u.full_name`)).rows
      .map((r) => ({
        id: r.id, full_name: r.full_name, email: r.email, avatar_url: r.avatar_url,
        designation: r.designation ?? "SMC Member",
        institute: r.institute ?? null, academic_unit_id: r.academic_unit_id,
        phone: r.phone ?? null, coverage_area: r.coverage_area ?? null,
        joining_date: r.joining_date ?? null,
        allowed_modules: Array.isArray(r.allowed_modules) ? r.allowed_modules : null,
        assignment_count: Number(r.assignment_count ?? 0),
        // The directory keys everything off role; this is what gives SMC members
        // their own group without touching the grouping code.
        role: "smc_member", team: "smc", is_smc: true,
        // Deactivating the SMC profile removes them from the active directory
        // exactly as a removed crew account is, using the same is_active flag.
        is_active: !!r.is_active && String(r.status) !== "removed",
      }));

    // Real roster (replaces the prototype's seed users) + the current identity.
    out.users = crew.map((r) => {
      const name = String(r.full_name ?? "User");
      return {
        id: idMap.get(String(r.id)), real_id: r.id, full_name: name, email: r.email ?? "",
        // The media role wins when it is one the platform roles cannot express —
        // today that is the Operations Coordinator. Everything else keeps mapping
        // from users.role so Nerve-wide parity is unchanged.
        role: r.mo_role === "coordinator" ? "coordinator" : (roleMap[String(r.role)] ?? "employee"),
        initials: (name.split(/\s+/).map((w) => w[0] || "").join("").slice(0, 2).toUpperCase()) || "?",
        color: "#3B9B76", avatar_url: r.avatar_url ?? null,
        // Removed accounts still ship: historical rows reference them, and every
        // name in a report or audit entry must keep resolving. Active surfaces
        // filter on is_active; history does not.
        status: (r.status as string) ?? "active",
        is_active: ((r.status as string) ?? "active") === "active",
        deactivated_at: r.deactivated_at ?? null,
        designation: r.designation ?? "", joined_on: r.joined_on ?? (r.created_at ? String(r.created_at).slice(0, 10) : null),
        allowed_modules: Array.isArray(r.allowed_modules) ? r.allowed_modules : null,
      };
    });
    out.me = idMap.get(u.id);
    // ── §16 / AC-10 scoping (server-side, not just UI) ─────────────────────
    // HR-ish data is scoped by role: employee = own only, team_lead = own +
    // members of teams they lead, admin = all. Production data (projects,
    // deliverables, equipment) stays departmental per §16 note 1.
    const myRole = moRoleOf(u);
    if (myRole !== "admin") {
      const visReal = new Set<string>([u.id]);
      if (myRole === "team_lead") {
        const tm = await pool.query(
          `SELECT user_id FROM mo_team_members WHERE team_id IN (SELECT id FROM mo_teams WHERE lead_user_id=$1 AND is_active)`, [u.id]);
        tm.rows.forEach((r) => visReal.add(String(r.user_id)));
      }
      const vis = new Set<number>();
      visReal.forEach((rid) => { const n = idMap.get(rid); if (n !== undefined) vis.add(n); });
      const arr = (k: string) => out[k] as Array<Record<string, unknown>>;
      out.daily_reports = arr("daily_reports").filter((r) => vis.has(Number(r.user_id)));
      const visReports = new Set(arr("daily_reports").map((r) => Number(r.id)));
      out.report_tasks = arr("report_tasks").filter((t) => visReports.has(Number(t.daily_report_id)));
      out.leave_requests = arr("leave_requests").filter((r) => vis.has(Number(r.user_id)));
      const visLeaves = new Set(arr("leave_requests").map((r) => Number(r.id)));
      out.leave_replacements = arr("leave_replacements").filter((r) => visLeaves.has(Number(r.leave_request_id)));
      out.kras = arr("kras").filter((r) => vis.has(Number(r.user_id)));
      const visKras = new Set(arr("kras").map((r) => Number(r.id)));
      out.kra_reviews = arr("kra_reviews").filter((r) => visKras.has(Number(r.kra_id)));
      out.performance_snapshots = arr("performance_snapshots").filter((r) => vis.has(Number(r.user_id)));
    }
    // D1 — real "fires / 30d" counters per automation rule, from execution records.
    const fireRows = await pool.query(`
      SELECT CASE WHEN kind='reminder' THEN 'AUTO-1'
                  WHEN kind='overdue' AND entity_type='deliverable' THEN 'AUTO-2'
                  WHEN kind='overdue' AND entity_type='equipment' THEN 'AUTO-3'
                  WHEN kind='approval' THEN 'AUTO-4' END AS rk, COUNT(*)::int c
        FROM mo_notifications WHERE created_at > NOW() - INTERVAL '30 days' GROUP BY 1`);
    const flagged30 = (await pool.query(
      `SELECT COUNT(*)::int c FROM mo_daily_reports WHERE status='flagged' AND submitted_at > NOW() - INTERVAL '30 days'`)).rows[0].c;
    const fires: Record<string, number> = { "AUTO-13": flagged30 };
    for (const r of fireRows.rows) if (r.rk) fires[r.rk] = r.c;
    for (const ar of (out.automation_rules as Array<Record<string, unknown>>)) ar.fires_30d = fires[String(ar.rule_key)] ?? 0;
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
    completed: ["archived"], archived: ["completed"] /* un-archive: Admin only (BR-12) */,
    on_hold: ["planning", "in_production", "cancelled"], cancelled: [],
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

  // FR-1.10 — Recent Activity for the Home dashboard, scoped per §16: admin sees the
  // department stream; others see their own actions + activity on projects they are
  // assigned to (never department-wide).
  app.get(`${P}/activity/recent`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    let rows;
    if (isMoAdmin(u)) {
      rows = (await pool.query(
        `SELECT a.action, a.entity_type, a.entity_id, a.occurred_at, us.full_name AS actor
           FROM mo_audit_logs a LEFT JOIN users us ON us.id=a.actor_id
          ORDER BY a.occurred_at DESC LIMIT 20`)).rows;
    } else {
      rows = (await pool.query(
        `WITH my_projects AS (
           SELECT p.id FROM mo_projects p WHERE p.deleted_at IS NULL AND (p.owner_id=$1
             OR EXISTS (SELECT 1 FROM mo_project_assignments a WHERE a.project_id=p.id AND a.user_id=$1 AND a.removed_at IS NULL)))
         SELECT a.action, a.entity_type, a.entity_id, a.occurred_at, us.full_name AS actor
           FROM mo_audit_logs a LEFT JOIN users us ON us.id=a.actor_id
          WHERE a.actor_id=$1
             OR (a.entity_type='project' AND a.entity_id IN (SELECT id FROM my_projects))
             OR (a.entity_type='deliverable' AND a.entity_id IN (SELECT d.id FROM mo_deliverables d WHERE d.project_id IN (SELECT id FROM my_projects)))
          ORDER BY a.occurred_at DESC LIMIT 20`, [u.id])).rows;
    }
    res.json({ activity: rows });
  }));

  // FR-3.5 / FR-13.3 — per-object activity feed (the non-admin subset of the audit
  // trail): the project's own events + its deliverables' events. Any media member.
  app.get(`${P}/projects/:id/activity`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    const id = parseInt(getSingleParam(req.params.id), 10);
    const { rows } = await pool.query(
      `SELECT a.action, a.entity_type, a.entity_id, a.before, a.after, a.occurred_at, us.full_name AS actor
         FROM mo_audit_logs a LEFT JOIN users us ON us.id=a.actor_id
        WHERE (a.entity_type='project' AND a.entity_id=$1)
           OR (a.entity_type IN ('deliverable','shoot','assignment')
               AND a.entity_id IN (
                 SELECT d.id FROM mo_deliverables d WHERE d.project_id=$1
                 UNION SELECT s.id FROM mo_shoots s WHERE s.project_id=$1
                 UNION SELECT g.id FROM mo_assignments g WHERE g.project_id=$1))
        ORDER BY a.occurred_at DESC LIMIT 60`, [id]);
    res.json({ activity: rows });
  }));

  /* Create a project's deliverables from its type's active template. ONE
     implementation, shared by POST /projects and the coordinator's
     Convert-to-Project, so both produce identical scope, offsets and due dates.
     Deliverables are project SCOPE: created unscheduled, they only enter
     someone's day when a TL/PM schedules them. */
  type TplItemCfg = { id: number; owners: string[]; priority: string; est_hours: number | null; due_offset: number | null };
  async function applyTemplateDeliverables(o: {
    projectId: number; typeId: number; projectName: string; end: string | null;
    picked?: number[] | null; cfg?: TplItemCfg[] | null;
  }): Promise<number> {
    const tmpl = await pool.query(
      `SELECT id FROM mo_project_templates WHERE project_type_id=$1 AND is_active LIMIT 1`, [o.typeId]);
    if (!tmpl.rows[0]) return 0;
    let items = (await pool.query(`SELECT * FROM mo_template_deliverables WHERE template_id=$1`, [tmpl.rows[0].id])).rows;
    if (o.picked) items = items.filter((it: { id: number }) => o.picked!.includes(Number(it.id)));
    let made = 0;
    for (const it of items) {
      const c = o.cfg?.find((x) => x.id === Number(it.id));
      // Offset precedence: per-project override → template default. The template
      // row itself is never modified (§3).
      const offset = c?.due_offset ?? Number(it.days_offset_due);
      const due = o.end ? addDays(o.end, offset) : null;
      const dl = await pool.query(
        `INSERT INTO mo_deliverables (project_id, deliverable_type_id, title, owner_id, due_date, unit, weight, status,
           priority, estimated_hours, due_offset_days, due_date_source)
         SELECT $1,$2,$3,$4,$5, dt.default_unit, $6,'not_started',$7,$8,$9,'offset' FROM mo_deliverable_types dt WHERE dt.id=$2
         RETURNING id`,
        [o.projectId, it.deliverable_type_id, String(it.title_pattern).replace("{project}", o.projectName),
         c?.owners[0] || null, due, it.default_weight, c?.priority ?? "normal", c?.est_hours ?? null, offset]);
      if (dl.rows[0]) made++;   // a template item pointing at a deleted type is skipped, not fatal
    }
    return made;
  }

  /* Whole-project creation used by Convert-to-Project. Reuses the template
     applier above so a converted project is indistinguishable from one created
     in the Projects module. */
  async function createProjectWithTemplate(o: {
    actor: CurrentUser; req: express.Request; name: string; description: string; typeId: number;
    unitId: number | null; priority: string; start: string | null; end: string | null;
    ownerId: string | null; source: string; venue?: string | null;
  }): Promise<{ id: number; deliverables: number }> {
    const ay = await pool.query(`SELECT id FROM mo_academic_years WHERE is_current LIMIT 1`);
    const ins = await pool.query(
      `INSERT INTO mo_projects (department_id, campus_id, academic_year_id, project_type_id, code, name, description,
         academic_unit_id, status, priority, owner_id, created_by, start_date, end_date, type_meta, source, venue)
       VALUES (1,1,$1,$2,'PENDING',$3,$4,$5,'planning',$6,$7,$8,$9,$10,'{}'::jsonb,$11,$12) RETURNING id`,
      [ay.rows[0]?.id ?? null, o.typeId, o.name, o.description, o.unitId, o.priority,
       o.ownerId, o.actor.id, o.start, o.end, o.source, o.venue ?? null]);
    const id = Number(ins.rows[0].id);
    await pool.query(`UPDATE mo_projects SET code=$1 WHERE id=$2`, [`MC-2627-${100 + id}`, id]);
    // Only the production owner is assigned as PM. The creator is NOT added —
    // an Operations Coordinator must never end up owning production work.
    if (o.ownerId)
      await pool.query(
        `INSERT INTO mo_project_assignments (project_id, user_id, capacity_role_id, is_project_manager, assigned_by)
         VALUES ($1,$2,(SELECT id FROM mo_capacity_roles WHERE name='Coordinator' LIMIT 1),true,$3)`,
        [id, o.ownerId, o.actor.id]);
    const deliverables = await applyTemplateDeliverables(
      { projectId: id, typeId: o.typeId, projectName: o.name, end: o.end });
    await audit(o.actor, "project.created", "project", id, null,
      { name: o.name, status: "planning", deliverables_created: deliverables, source: o.source }, o.req);
    return { id, deliverables };
  }

  app.post(`${P}/projects`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    if (!(await requireModule(res, u, "projects"))) return;   // Group I: API half of module gating
    const b = req.body as Record<string, unknown>;
    const name = String(b.name ?? "").trim();
    if (name.length < 3 || name.length > 120) return sendError(res, 400, "VR-6: name must be 3–120 characters.");
    const typeId = Number(b.project_type_id);
    if (!typeId) return sendError(res, 400, "Project type is required.");
    const start = (b.start_date as string) || null, end = (b.end_date as string) || null;
    if (start && end && end < start) return sendError(res, 400, "VR-6: end date must be on or after start date.");
    // VR-6 / AUTO-6: block EXACT duplicates (same name + type + academic year, live).
    // Fuzzy near-duplicates only warn (client dupCheck + /ai/duplicates), per spec.
    const dup = await pool.query(
      `SELECT code FROM mo_projects WHERE deleted_at IS NULL AND lower(name)=lower($1) AND project_type_id=$2 LIMIT 1`,
      [name, typeId]);
    if (dup.rows[0] && b.force_duplicate !== true)
      return sendError(res, 409, `AUTO-6/VR-6: an identical project already exists (${dup.rows[0].code}). Rename it, or merge into the existing project.`);
    // Only a Team Lead or Admin may create a project.
    if (!(isMoAdmin(u) || isMoTL(u)))
      return sendError(res, 403, "Only a Team Lead or Admin may create a project.");
    // Every id the caller wants to put on this project must be inside their
    // assignable scope — a Team Lead may not reach outside their own team.
    const wantAssignees = Array.isArray(b.assignees) ? (b.assignees as unknown[]).map(String) : [];
    const wantOwners = Array.isArray(b.template_config)
      ? (b.template_config as Array<Record<string, unknown>>).flatMap((c) =>
          Array.isArray(c.owners) ? (c.owners as unknown[]).map(String) : [])
      : [];
    if (!(await assertAssignable(res, u, [...wantAssignees, ...wantOwners, ...(b.owner_id ? [String(b.owner_id)] : [])]))) return;
    const gated = false;   // TL/Admin only ⇒ projects are created active
    const ay = await pool.query(`SELECT id FROM mo_academic_years WHERE is_current LIMIT 1`);
    // Academic Unit is master data — validate the reference and refuse a unit
    // that is archived or disabled (it may still be shown on old projects, but
    // must not be selectable for new work).
    const unitId = b.academic_unit_id ? Number(b.academic_unit_id) : null;
    if (unitId !== null) {
      const au = (await pool.query(`SELECT is_active, archived_at FROM mo_academic_units WHERE id=$1`, [unitId])).rows[0];
      if (!au) return sendError(res, 400, "Unknown academic unit.");
      if (!au.is_active || au.archived_at) return sendError(res, 400, "That academic unit is archived or disabled — pick an active one.");
    }
    const ins = await pool.query(
      `INSERT INTO mo_projects (department_id, campus_id, academic_year_id, project_type_id, code, name, description,
         academic_unit_id, status, priority, owner_id, created_by, start_date, end_date, type_meta, source)
       VALUES (1,1,$1,$2,'PENDING',$3,$4,$5,$6,$7,$8,$8,$9,$10,$11,'app') RETURNING id`,
      [ay.rows[0]?.id ?? null, typeId, name, String(b.description ?? ""), unitId,
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
    // richer form: per-item owners/priority/estimated hours) supersedes template_items.
    // Deliverables are project SCOPE, not today's work: they are created unscheduled
    // and stay on the project page until a TL/PM schedules them for a date, which is
    // what puts them into that owner's Today's Assignments.
    let made = 0;
    const cfg: TplItemCfg[] | null = Array.isArray(b.template_config)
      ? (b.template_config as Array<Record<string, unknown>>).map((c) => ({
          id: Number(c.id),
          owners: Array.isArray(c.owners) ? (c.owners as unknown[]).map(String) : [],
          priority: ["urgent", "high", "normal", "low"].includes(String(c.priority)) ? String(c.priority) : "normal",
          est_hours: c.est_hours != null && !Number.isNaN(Number(c.est_hours)) ? Number(c.est_hours) : null,
          // Per-project override of the template's default offset (§2/§6).
          due_offset: c.due_offset != null && c.due_offset !== "" && !Number.isNaN(Number(c.due_offset))
            ? Math.max(0, Number(c.due_offset)) : null,
        }))
      : null;
    const picked = cfg ? cfg.map((c) => c.id) : (Array.isArray(b.template_items) ? (b.template_items as unknown[]).map(Number) : null);
    if (b.apply_template !== false)
      made = await applyTemplateDeliverables({ projectId: id, typeId, projectName: name, end, picked, cfg });
    await audit(u, "project.created", "project", id, null,
      { name, status: gated ? "proposed" : "planning", deliverables_created: made }, req);
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
    // BR-11 / FR-3.6 — the approval gate is its OWN capability: an employee may move
    // their own project through production states, but NEVER approve a proposal
    // (that would let them approve their own gated project — audit finding 9.1).
    if (from === "proposed" && to === "approved" && !(isMoAdmin(u) || isMoTL(u)))
      return sendError(res, 403, "BR-11: only a Team Lead or Admin may approve a proposed project.");
    if (to === "archived" && !isMoAdmin(u)) return sendError(res, 403, "Only Admin may archive (BR-1).");
    if (from === "archived" && !isMoAdmin(u)) return sendError(res, 403, "BR-12: only Admin may un-archive.");
    if (!(isMoAdmin(u) || isMoTL(u) || isOwnerPM)) return sendError(res, 403, "You cannot change this project's status.");
    await pool.query(
      `UPDATE mo_projects SET status=$1,
         archived_at=CASE WHEN $1='archived' THEN NOW() WHEN $3 THEN NULL ELSE archived_at END,
         updated_at=NOW() WHERE id=$2`, [to, id, from === "archived"]);
    await audit(u, from === "archived" ? "project.unarchived" : (to === "archived" ? "project.archived" : "project.status_changed"),
      "project", id, { status: from }, { status: to }, req);
    res.json({ ok: true, status: to });
  }));

  app.post(`${P}/projects/:id/assignments`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    if (!(isMoAdmin(u) || isMoTL(u))) return sendError(res, 403, "Only a Team Lead or Admin may assign crew.");
    const id = parseInt(getSingleParam(req.params.id), 10);
    const b = req.body as Record<string, unknown>;
    // A4: clean 400s instead of FK-violation 500s.
    if (!b.user_id || typeof b.user_id !== "string") return sendError(res, 400, "user_id is required.");
    const target = (await pool.query(`SELECT 1 FROM users WHERE id=$1 AND team='media'`, [b.user_id])).rows[0];
    if (!target) return sendError(res, 400, "user_id does not match a media crew member.");
    // §16 scope: a Team Lead may only crew their own team members.
    if (!(await assertAssignable(res, u, [String(b.user_id)]))) return;
    if (!(await pool.query(`SELECT 1 FROM mo_projects WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0])
      return sendError(res, 404, "Project not found.");
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
    // §16: "Create/edit deliverables — Employee: on own projects." Owner or PM only.
    if (!(isMoAdmin(u) || isMoTL(u))) {
      const own = await pool.query(
        `SELECT 1 FROM mo_projects p WHERE p.id=$1 AND (p.owner_id=$2
            OR EXISTS (SELECT 1 FROM mo_project_assignments a WHERE a.project_id=p.id AND a.user_id=$2 AND a.is_project_manager AND a.removed_at IS NULL))`,
        [pid, u.id]);
      if (!own.rows[0]) return sendError(res, 403, "§16: employees may create deliverables only on their own projects (owner or PM).");
    }
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
    // Robustness: the INSERT…SELECT yields no row when the type id doesn't exist —
    // answer 400, not a crash (found via a deleted lookup type).
    if (!ins.rows[0]) return sendError(res, 400, "Invalid deliverable type.");
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
    // Re-owning a deliverable is an assignment — same team scope as everything else.
    if ("owner_id" in b && b.owner_id && String(b.owner_id) !== String(cur.rows[0].owner_id)
        && !(await assertAssignable(res, u, [String(b.owner_id)]))) return;
    const fields: string[] = [], vals: unknown[] = []; let i = 1;
    for (const k of ["title", "owner_id", "due_date", "quantity_target", "quantity_delivered", "spec_notes",
                     "social_status", "social_post_url", "mail_status",
                     "scheduled_date", "priority", "estimated_hours", "approval_status"]) {
      if (k in b) { fields.push(`${k}=$${i++}`); vals.push(b[k]); }
    }
    if (!fields.length) return res.json({ deliverable: cur.rows[0] });
    vals.push(id);
    const { rows } = await pool.query(`UPDATE mo_deliverables SET ${fields.join(",")} WHERE id=$${i} RETURNING *`, vals);
    await audit(u, "deliverable.updated", "deliverable", id, cur.rows[0], rows[0], req);
    res.json({ deliverable: rows[0] });
  }));

  // ── Schedule a deliverable (FR: project scope → today's work) ────────────
  // Setting scheduled_date is what promotes a deliverable into its owner's
  // Today's Assignments, and only for that date. Clearing it sends the work
  // back to the project backlog. TL/Admin, or the project owner/PM.
  app.post(`${P}/deliverables/:id/schedule`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    const id = parseInt(getSingleParam(req.params.id), 10);
    const cur = (await pool.query(`SELECT * FROM mo_deliverables WHERE id=$1`, [id])).rows[0];
    if (!cur) return sendError(res, 404, "Deliverable not found.");
    if (!(isMoAdmin(u) || isMoTL(u))) {
      const own = await pool.query(
        `SELECT 1 FROM mo_projects p WHERE p.id=$1 AND (p.owner_id=$2
            OR EXISTS (SELECT 1 FROM mo_project_assignments a WHERE a.project_id=p.id AND a.user_id=$2 AND a.is_project_manager AND a.removed_at IS NULL))`,
        [cur.project_id, u.id]);
      if (!own.rows[0]) return sendError(res, 403, "Only a Team Lead, Admin, or the project owner/PM may schedule work.");
    }
    const b = req.body as Record<string, unknown>;
    const date = b.scheduled_date == null || b.scheduled_date === "" ? null : String(b.scheduled_date);
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return sendError(res, 400, "scheduled_date must be YYYY-MM-DD (or null to unschedule).");
    // Scheduling implies an assignee — that person is who it shows up for.
    const owner = b.owner_id ? String(b.owner_id) : String(cur.owner_id ?? "");
    if (date && !owner) return sendError(res, 400, "Assign an owner before scheduling this deliverable.");
    if (b.owner_id && String(b.owner_id) !== String(cur.owner_id)
        && !(await assertAssignable(res, u, [String(b.owner_id)]))) return;
    const { rows } = await pool.query(
      `UPDATE mo_deliverables SET scheduled_date=$1, owner_id=COALESCE($2, owner_id),
         estimated_hours=COALESCE($3, estimated_hours), priority=COALESCE($4, priority)
       WHERE id=$5 RETURNING *`,
      [date, b.owner_id ? String(b.owner_id) : null,
       b.estimated_hours != null && b.estimated_hours !== "" ? Number(b.estimated_hours) : null,
       b.priority ? String(b.priority) : null, id]);
    await audit(u, date ? "deliverable.scheduled" : "deliverable.unscheduled", "deliverable", id,
      { scheduled_date: cur.scheduled_date, owner_id: cur.owner_id },
      { scheduled_date: date, owner_id: rows[0].owner_id }, req);
    if (date && rows[0].owner_id && String(rows[0].owner_id) !== u.id)
      await pool.query(
        `INSERT INTO mo_notifications (user_id, kind, title, body, entity_type, entity_id)
         VALUES ($1,'assignment',$2,$3,'deliverable',$4)`,
        [rows[0].owner_id, "Work scheduled for you",
          `${u.full_name ?? "Your Team Lead"} scheduled “${rows[0].title}” for ${date}.`, id]).catch(() => {});
    res.json({ deliverable: rows[0] });
  }));

  // ── Edit a deliverable's due date (PRD §4/§5/§7) ─────────────────────────
  // Admin: any project. Team Lead: only projects whose crew are on a team they
  // lead. Employee: read-only. A hand-picked date flips due_date_source to
  // 'manual' so a later project-start change never overwrites it (§9).
  async function canEditProjectDates(actor: CurrentUser, projectId: number): Promise<boolean> {
    if (isMoAdmin(actor)) return true;
    if (!isMoTL(actor)) return false;                       // employees are read-only
    const scope = await assignableMemberIds(actor);
    const { rows } = await pool.query(
      `SELECT p.owner_id, p.created_by,
              COALESCE(ARRAY(SELECT a.user_id FROM mo_project_assignments a
                              WHERE a.project_id=p.id AND a.removed_at IS NULL), '{}') AS crew
         FROM mo_projects p WHERE p.id=$1`, [projectId]);
    if (!rows[0]) return false;
    const people = [String(rows[0].owner_id), String(rows[0].created_by), ...(rows[0].crew as string[]).map(String)];
    // The project belongs to this lead if they own it or anyone on it is theirs.
    return people.some((id) => scope.has(id));
  }

  app.patch(`${P}/deliverables/:id/due-date`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    const id = parseInt(getSingleParam(req.params.id), 10);
    const cur = (await pool.query(`SELECT * FROM mo_deliverables WHERE id=$1`, [id])).rows[0];
    if (!cur) return sendError(res, 404, "Deliverable not found.");
    if (!(await canEditProjectDates(u, Number(cur.project_id))))
      return sendError(res, 403, isMoTL(u)
        ? "You can only edit due dates on your own team's projects."
        : "Only a Team Lead or Admin may change a due date.");
    const b = req.body as Record<string, unknown>;
    const raw = b.due_date == null || b.due_date === "" ? null : String(b.due_date);
    if (raw && !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return sendError(res, 400, "due_date must be YYYY-MM-DD (or null to clear).");
    const reason = String(b.reason ?? "");
    const { rows } = await pool.query(
      `UPDATE mo_deliverables SET due_date=$1, due_date_source='manual', updated_at=NOW()
       WHERE id=$2 RETURNING *`, [raw, id]);
    // §7: every change logged with old + new date, who and when (occurred_at).
    await audit(u, "deliverable.due_date_changed", "deliverable", id,
      { due_date: dOnly(cur.due_date), due_date_source: cur.due_date_source },
      { due_date: raw, due_date_source: "manual", changed_by: u.id,
        changed_by_role: moRoleOf(u), reason: reason || undefined }, req);
    res.json({ deliverable: rows[0] });
  }));

  // Members this caller may assign work to (§16 scope). Powers every crew picker.
  app.get(`${P}/members/assignable`, asyncHandler(async (_req, res) => {
    const u = requireMedia(res); if (!u) return;
    const ids = [...(await assignableMemberIds(u))];
    if (!ids.length) return res.json({ members: [] });
    const { rows } = await pool.query(
      `SELECT u.id, u.full_name, u.role, COALESCE(pr.designation,'') AS designation
         FROM users u LEFT JOIN mo_user_profiles pr ON pr.user_id=u.id
        WHERE u.id = ANY($1::text[]) AND u.team='media' ORDER BY u.full_name`, [ids]);
    res.json({ members: rows, scope: moRoleOf(u) });
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
    // Approval is the creative verdict; it also hands the item to Operations.
    // Queueing here is what makes "approved work appears in Ready for Dispatch"
    // automatic — the coordinator never has to notice an approval happened.
    if (outcome === "approved")
      await pool.query(
        `UPDATE mo_deliverables SET dispatch_status='queued', queued_at=NOW()
          WHERE id=$1 AND dispatch_status='none'`, [id]);
    // Changes requested on something already queued pulls it back out.
    if (outcome === "changes_requested")
      await pool.query(
        `UPDATE mo_deliverables SET dispatch_status='none', queued_at=NULL
          WHERE id=$1 AND dispatch_status='queued'`, [id]);
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
  // Statuses that mean "already went to a reviewer". Editing content in any of
  // these invalidates the outcome and re-opens the review.
  const POST_SUBMIT = ["submitted", "flagged", "approved", "auto_approved"];

  /** Who reviews this report — the lead(s) of the author's team, else Admins. */
  async function reviewersFor(authorId: string): Promise<string[]> {
    const leads = (await pool.query(
      `SELECT DISTINCT t.lead_user_id FROM mo_team_members tm
         JOIN mo_teams t ON t.id = tm.team_id
        WHERE tm.user_id = $1 AND t.is_active AND t.lead_user_id IS NOT NULL`, [authorId]))
      .rows.map((r) => String(r.lead_user_id)).filter((id) => id !== authorId);
    if (leads.length) return leads;
    return (await pool.query(
      `SELECT id FROM users WHERE team='media' AND role IN ('admin','super_admin')`)).rows.map((r) => String(r.id));
  }

  /**
   * Call after ANY content change to a report. If the report had already been
   * submitted, the previous review outcome is invalidated and it goes back into
   * the queue as 'submitted' (Pending Review) — an edited report can never stay
   * Approved. Always records who edited it and when, and always audits.
   */
  async function touchReportAfterEdit(actor: CurrentUser, reportId: number, req: express.Request) {
    const cur = (await pool.query(`SELECT * FROM mo_daily_reports WHERE id=$1`, [reportId])).rows[0];
    if (!cur) return null;
    if (!POST_SUBMIT.includes(String(cur.status))) {
      // Draft / returned: still track authorship of the edit, no review reset.
      await pool.query(`UPDATE mo_daily_reports SET last_edited_at=NOW(), last_edited_by=$1 WHERE id=$2`, [actor.id, reportId]);
      return { reset: false, from: String(cur.status), to: String(cur.status) };
    }
    // Re-evaluate AUTO-13 against the edited content so a report edited into a
    // suspicious shape is flagged rather than quietly re-queued.
    const tasks = (await pool.query(`SELECT * FROM mo_report_tasks WHERE daily_report_id=$1`, [reportId])).rows;
    const flags = await evaluateFlags(String(cur.user_id), String(cur.report_date).slice(0, 10), tasks);
    const to = flags.length ? "flagged" : "submitted";
    await pool.query(
      `UPDATE mo_daily_reports SET status=$1,
         reviewed_by=NULL, reviewed_at=NULL, review_comment='', auto_approved=false,
         flag_rules=$2, flagged_reason=$3,
         edited_after_submit=true, revision=revision+1, last_edited_at=NOW(), last_edited_by=$4
       WHERE id=$5`,
      [to, JSON.stringify(flags), flags.join(" · ") || null, actor.id, reportId]);
    await audit(actor, "report.edited_after_submit", "daily_report", reportId,
      { status: cur.status, reviewed_by: cur.reviewed_by, reviewed_at: cur.reviewed_at, revision: cur.revision },
      { status: to, edited_by: actor.id, edited_by_role: moRoleOf(actor), revision: Number(cur.revision) + 1,
        approval_invalidated: ["approved", "auto_approved"].includes(String(cur.status)) }, req);
    for (const reviewer of await reviewersFor(String(cur.user_id)))
      await pool.query(
        `INSERT INTO mo_notifications (user_id, kind, title, body, entity_type, entity_id)
         VALUES ($1,'approval',$2,$3,'daily_report',$4)`,
        [reviewer, "Report edited — needs re-review",
          `${actor.full_name ?? "A crew member"} edited an already-submitted report; it is back in your queue.`, reportId],
      ).catch(() => {});
    return { reset: true, from: String(cur.status), to };
  }

  /** Owner (or reviewer) may edit; content edits after submission re-open review. */
  function canEditReport(actor: CurrentUser, ownerId: string): boolean {
    return ownerId === actor.id || isMoAdmin(actor) || isMoTL(actor);
  }

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
    if (mins > 16 * 60) return sendError(res, 400, "VR-1: a single task cannot exceed 16 hours — split it.");
    if (String(b.description ?? "").trim().length < 3) return sendError(res, 400, "Describe the task (min 3 characters).");
    for (const k of ["progress_before", "progress_after"] as const)
      if (b[k] != null && (Number(b[k]) < 0 || Number(b[k]) > 100)) return sendError(res, 400, "VR-2: progress must be 0–100.");
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
    // Lifecycle: logging the first work against a deliverable starts it.
    if (b.deliverable_id)
      await pool.query(
        `UPDATE mo_deliverables SET status='in_progress', updated_at=NOW()
          WHERE id=$1 AND status='not_started'`, [Number(b.deliverable_id)]);
    await audit(u, "report.task_logged", "daily_report", rid, null, { minutes: mins }, req);
    // Adding a task to an already-submitted report re-opens its review.
    const re = await touchReportAfterEdit(u, rid, req);
    res.status(201).json({ task: ins.rows[0], report_status: re?.to, rereview: !!re?.reset });
  }));

  app.patch(`${P}/tasks/:id`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    const id = parseInt(getSingleParam(req.params.id), 10);
    const b = req.body as Record<string, unknown>;
    const cur = await pool.query(`SELECT * FROM mo_report_tasks WHERE id=$1`, [id]);
    if (!cur.rows[0]) return sendError(res, 404, "Task not found.");
    const rpt = (await pool.query(`SELECT user_id, status FROM mo_daily_reports WHERE id=$1`, [cur.rows[0].daily_report_id])).rows[0];
    // Owners may edit their own report at any stage; an edit after submission
    // invalidates the review outcome instead of being blocked (see
    // touchReportAfterEdit). Reviewers may edit too — always audited.
    if (rpt && !canEditReport(u, String(rpt.user_id))) return sendError(res, 403, "You can only edit your own tasks.");
    const start = (b.start_time as string) ?? cur.rows[0].start_time, end = (b.end_time as string) ?? cur.rows[0].end_time;
    const mins = t2m(end) - t2m(start);
    await pool.query(
      `UPDATE mo_report_tasks SET project_id=$1, task_category_id=$2, deliverable_id=$3, description=$4,
         start_time=$5, end_time=$6, minutes=$7, quantity=$8, unit=$9, status=$10, blocker_note=$11,
         updated_at=NOW() WHERE id=$12`,
      [b.project_id ? Number(b.project_id) : cur.rows[0].project_id, b.task_category_id ? Number(b.task_category_id) : cur.rows[0].task_category_id,
       b.deliverable_id ? Number(b.deliverable_id) : cur.rows[0].deliverable_id, (b.description as string) ?? cur.rows[0].description,
       start, end, mins, b.quantity !== undefined ? b.quantity : cur.rows[0].quantity, (b.unit as string) ?? cur.rows[0].unit,
       (b.status as string) ?? cur.rows[0].status, (b.blocker_note as string) ?? cur.rows[0].blocker_note, id]);
    await refreshReportTotal(cur.rows[0].daily_report_id);
    await audit(u, "report.task_edited", "report_task", id, cur.rows[0], b, req);
    const re = await touchReportAfterEdit(u, Number(cur.rows[0].daily_report_id), req);
    res.json({ ok: true, report_status: re?.to, rereview: !!re?.reset });
  }));

  app.delete(`${P}/tasks/:id`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    const id = parseInt(getSingleParam(req.params.id), 10);
    const cur = await pool.query(`SELECT * FROM mo_report_tasks WHERE id=$1`, [id]);
    if (!cur.rows[0]) return sendError(res, 404, "Task not found.");
    const rpt = (await pool.query(`SELECT user_id, status FROM mo_daily_reports WHERE id=$1`, [cur.rows[0].daily_report_id])).rows[0];
    if (rpt && !canEditReport(u, String(rpt.user_id))) return sendError(res, 403, "You can only delete your own tasks.");
    await pool.query(`DELETE FROM mo_report_tasks WHERE id=$1`, [id]);
    await refreshReportTotal(cur.rows[0].daily_report_id);
    await audit(u, "report.task_deleted", "report_task", id, cur.rows[0], null, req);
    const re = await touchReportAfterEdit(u, Number(cur.rows[0].daily_report_id), req);
    res.json({ ok: true, report_status: re?.to, rereview: !!re?.reset });
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
  // BR-9 / §16 #4 — unlock a past report for editing (TL/Admin, logged). Sets the
  // report back to 'returned' so its tasks become editable by the owner again.
  app.post(`${P}/reports/:id/unlock`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    if (!(isMoAdmin(u) || isMoTL(u))) return sendError(res, 403, "Only a Team Lead or Admin may unlock a report (BR-9).");
    const id = parseInt(getSingleParam(req.params.id), 10);
    const cur = (await pool.query(`SELECT * FROM mo_daily_reports WHERE id=$1`, [id])).rows[0];
    if (!cur) return sendError(res, 404, "Report not found.");
    if (cur.status === "draft") return sendError(res, 400, "Report is already editable (draft).");
    await pool.query(`UPDATE mo_daily_reports SET status='returned', reviewed_by=$1, reviewed_at=NOW() WHERE id=$2`, [u.id, id]);
    await audit(u, "report.unlocked", "daily_report", id, { status: cur.status }, { status: "returned" }, req);
    res.json({ ok: true, status: "returned" });
  }));

  app.post(`${P}/reports/:id/review`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    if (!(isMoAdmin(u) || isMoTL(u))) return sendError(res, 403, "Team Lead or Admin only.");
    const id = parseInt(getSingleParam(req.params.id), 10);
    const action = String((req.body as Record<string, unknown>).action ?? ""); // approve | return | flag
    const map: Record<string, string> = { approve: "approved", return: "returned", flag: "flagged" };
    const to = map[action]; if (!to) return sendError(res, 400, "Invalid action.");
    const cur = (await pool.query(`SELECT status, revision FROM mo_daily_reports WHERE id=$1`, [id])).rows[0];
    if (!cur) return sendError(res, 404, "Report not found.");
    // A fresh decision clears the "edited since review" marker — the badge
    // reverts to the plain outcome until the next post-submission edit.
    await pool.query(`UPDATE mo_daily_reports SET status=$1, reviewed_by=$2, reviewed_at=NOW(), review_comment=$3,
        edited_after_submit=false WHERE id=$4`,
      [to, u.id, String((req.body as Record<string, unknown>).comment ?? ""), id]);
    await audit(u, `report.${action}`, "daily_report", id,
      { status: cur.status },
      { status: to, reviewed_by: u.id, reviewed_by_role: moRoleOf(u), revision: cur.revision,
        comment: String((req.body as Record<string, unknown>).comment ?? "") }, req);
    res.json({ ok: true, status: to });
  }));

  // ═════════════════════════ PHASE 2 — EQUIPMENT / SHOOTS / LEAVE ══════════
  // Prototype sends integer user ids; the shared users table keys crew as 'mo-uN'.
  const toUid = (v: unknown): string | null =>
    v == null ? null : (typeof v === "number" || /^\d+$/.test(String(v))) ? `mo-u${v}` : String(v);

  // ── Unified "Assign Work" (§7.5) ─────────────────────────────────────────
  // One entry point for every kind of assignable work. The chosen work type's
  // form_template decides which record we write — a shoot or a standard task.
  // Adding a new work type in Settings therefore needs no code change here.
  app.post(`${P}/projects/:id/work`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    const pid = parseInt(getSingleParam(req.params.id), 10);
    const b = req.body as Record<string, unknown>;
    if (!b.work_type_id) return sendError(res, 400, "Work type is required.");
    const wt = (await pool.query(`SELECT * FROM mo_work_types WHERE id=$1`, [Number(b.work_type_id)])).rows[0];
    if (!wt) return sendError(res, 400, "Unknown work type.");
    if (!wt.is_active || wt.archived_at) return sendError(res, 400, "That work type is archived or disabled — pick an active one.");
    // Both templates need assign rights; shoots additionally allow the PM.
    const isPMrow = (await pool.query(
      `SELECT 1 FROM mo_project_assignments WHERE project_id=$1 AND user_id=$2 AND is_project_manager AND removed_at IS NULL`,
      [pid, u.id])).rows[0];
    if (!(isMoAdmin(u) || isMoTL(u) || isPMrow))
      return sendError(res, 403, "Only a PM, Team Lead or Admin may assign work.");

    if (wt.form_template === "shoot") {
      if (!String(b.title ?? "").trim()) return sendError(res, 400, "Title is required.");
      if (!b.shoot_date) return sendError(res, 400, "Date is required.");
      const crew = (Array.isArray(b.crew) ? b.crew : []).map((r) => String(toUid(r)));
      if (!(await assertAssignable(res, u, crew))) return;
      const ins = await pool.query(
        `INSERT INTO mo_shoots (project_id, work_type_id, title, shoot_date, call_time, end_time, location, location_url, notes, status, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'planned',$10) RETURNING *`,
        [pid, wt.id, String(b.title), b.shoot_date, (b.call_time as string) || null, (b.end_time as string) || null,
         (b.location as string) || "TBC", (b.location_url as string) || null, String(b.notes ?? ""), u.id]);
      const shoot = ins.rows[0];
      for (const uid of crew)
        await pool.query(`INSERT INTO mo_shoot_crew (shoot_id, user_id, capacity_role_id) VALUES ($1,$2,2) ON CONFLICT DO NOTHING`, [shoot.id, uid]);
      for (const raw of (Array.isArray(b.equipment) ? b.equipment : []))
        await pool.query(
          `INSERT INTO mo_equipment_bookings (equipment_item_id, user_id, shoot_id, project_id, starts_at, ends_at, status, created_by)
           VALUES ($1,$2,$3,$4,$5,$5,'reserved',$2)`,
          [Number(raw), u.id, shoot.id, pid, b.shoot_date]).catch(() => {/* clashes surface via AC-7 */});
      await audit(u, "work.assigned", "shoot", shoot.id, null,
        { work_type: wt.name, form_template: wt.form_template, title: shoot.title, date: shoot.shoot_date }, req);
      return res.status(201).json({ kind: "shoot", work_type: wt, shoot });
    }

    // standard_task
    const title = String(b.title ?? "").trim();
    if (!title) return sendError(res, 400, "Title is required.");
    const assignees = (Array.isArray(b.assignees) ? b.assignees : []).map((r) => String(toUid(r)));
    if (!assignees.length) return sendError(res, 400, "Assign the work to at least one member.");
    if (!(await assertAssignable(res, u, assignees))) return;
    const priority = ["urgent", "high", "normal", "low"].includes(String(b.priority)) ? String(b.priority) : "normal";
    const ins = await pool.query(
      `INSERT INTO mo_assignments (project_id, work_type_id, deliverable_id, title, assigned_by, priority, status,
         start_date, due_date, notes)
       VALUES ($1,$2,$3,$4,$5,$6,'not_started',$7,$8,$9) RETURNING *`,
      [pid, wt.id, b.deliverable_id ? Number(b.deliverable_id) : null, title, u.id, priority,
       (b.start_date as string) || null, (b.due_date as string) || null, String(b.notes ?? "")]);
    for (const uid of assignees)
      await pool.query(`INSERT INTO mo_assignment_users (assignment_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [ins.rows[0].id, uid]);
    await audit(u, "work.assigned", "assignment", ins.rows[0].id, null,
      { work_type: wt.name, form_template: wt.form_template, title, assignees }, req);
    for (const uid of assignees)
      if (uid !== u.id)
        await pool.query(
          `INSERT INTO mo_notifications (user_id, kind, title, body, entity_type, entity_id)
           VALUES ($1,'assignment',$2,$3,'assignment',$4)`,
          [uid, `${wt.name} assigned to you`, `${u.full_name ?? "Your Team Lead"} assigned “${title}”.`, ins.rows[0].id]).catch(() => {});
    res.status(201).json({ kind: "assignment", work_type: wt, assignment: ins.rows[0] });
  }));

  // ── Shoots (§7.5) ─────────────────────────────────────────────────────────
  // A shoot has NO write path of its own. It is created through the unified
  // POST /projects/:id/work above, like every other kind of work — the routes
  // below only edit or retire a shoot that already exists. The old
  // POST /projects/:id/shoots endpoint was the second, divergent creation path
  // (no work type, no assignable-crew check, no attribution) and is gone.

  // A2 — soft-delete a shoot (BR-13). TL/Admin.
  app.delete(`${P}/shoots/:id`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    if (!(isMoAdmin(u) || isMoTL(u))) return sendError(res, 403, "Only a Team Lead or Admin may delete a shoot.");
    const id = parseInt(getSingleParam(req.params.id), 10);
    await pool.query(`UPDATE mo_shoots SET deleted_at=NOW(), status='cancelled' WHERE id=$1`, [id]);
    await audit(u, "shoot.deleted", "shoot", id, null, null, req);
    res.json({ ok: true });
  }));

  app.patch(`${P}/shoots/:id`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    if (!(isMoAdmin(u) || isMoTL(u))) return sendError(res, 403, "Only a Team Lead or Admin may edit a shoot.");
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
    // VR-8: bookings are capped at 30 days.
    if ((new Date(e).getTime() - new Date(s).getTime()) / 86400000 > 30)
      return sendError(res, 400, "VR-8: a booking cannot exceed 30 days.");
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

  // ── Leave (§7.8) ─────────────────────────────────────────────────────────
  // Operational availability + approval only. No balance/quota logic lives
  // here or anywhere else in this module — the university's HR system owns that.
  // ── Approval hierarchy (PRD §16) ─────────────────────────────────────────
  //   Employee   → decided by the Team Lead who leads their team, or Admin.
  //   Team Lead  → decided by Admin ONLY (never a peer TL, never themselves).
  //   Admin      → decided by Admin (no higher authority exists in-app).
  // Nobody below Admin may ever decide their own request. Enforced here, in the
  // one place every decision must pass through — the UI only mirrors this.
  const MO_ROLE_OF_DB = (role: string): MoRole =>
    role === "super_admin" || role === "admin" ? "admin" : role === "sub_admin" ? "team_lead" : "employee";

  /** Employee ids whose leave `leadId` may decide (members of teams they lead, employees only). */
  async function employeesLedBy(leadId: string): Promise<Set<string>> {
    const { rows } = await pool.query(
      `SELECT tm.user_id, u.role
         FROM mo_team_members tm
         JOIN mo_teams t ON t.id = tm.team_id
         JOIN users u ON u.id = tm.user_id
        WHERE t.lead_user_id = $1 AND t.is_active`, [leadId]);
    return new Set(rows.filter((r: Record<string, unknown>) => MO_ROLE_OF_DB(String(r.role)) === "employee")
      .map((r: Record<string, unknown>) => String(r.user_id)));
  }

  /** Who should decide `requesterId`'s leave — the routing target for notifications.
      Employee → the lead(s) of the team(s) they belong to (Admins as fallback).
      Team Lead / Admin → the Admins. */
  async function approversFor(requesterId: string): Promise<string[]> {
    const admins = (await pool.query(
      `SELECT id FROM users WHERE team='media' AND role IN ('admin','super_admin')`)).rows.map((r) => String(r.id));
    const requester = (await pool.query(`SELECT role FROM users WHERE id=$1`, [requesterId])).rows[0];
    if (!requester || MO_ROLE_OF_DB(String(requester.role)) !== "employee") return admins;
    const leads = (await pool.query(
      `SELECT DISTINCT t.lead_user_id FROM mo_team_members tm
         JOIN mo_teams t ON t.id = tm.team_id
        WHERE tm.user_id = $1 AND t.is_active AND t.lead_user_id IS NOT NULL`, [requesterId]))
      .rows.map((r) => String(r.lead_user_id)).filter((id) => id !== requesterId);
    return leads.length ? leads : admins;   // unassigned employee → Admin decides
  }

  /** Best-effort in-app notification; never breaks the request. */
  async function notifyLeave(userId: string, kind: string, title: string, body: string, leaveId: number) {
    try {
      await pool.query(
        `INSERT INTO mo_notifications (user_id, kind, title, body, entity_type, entity_id)
         VALUES ($1,$2,$3,$4,'leave_request',$5)`, [userId, kind, title, body, leaveId]);
    } catch { /* notifications must never break the flow */ }
  }

  /** Authoritative check: may `actor` decide the leave request owned by `requesterId`? */
  async function canDecideLeaveFor(actor: CurrentUser, requesterId: string): Promise<string | null> {
    const actorRole = moRoleOf(actor);
    if (actorRole !== "admin" && actorRole !== "team_lead")
      return "Only a Team Lead or Admin may decide leave.";
    // Self-approval: forbidden for everyone except Admin, who has no higher authority.
    if (requesterId === actor.id)
      return actorRole === "admin" ? null : "You cannot decide your own leave request.";
    if (actorRole === "admin") return null;                     // Admin decides for everyone
    // Team Lead: only employees on a team they lead. A TL's own peers/TLs go to Admin.
    const requester = (await pool.query(`SELECT role FROM users WHERE id=$1`, [requesterId])).rows[0];
    if (!requester) return "Leave request not found.";
    if (MO_ROLE_OF_DB(String(requester.role)) !== "employee")
      return "A Team Lead's leave request must be decided by an Admin.";
    return (await employeesLedBy(actor.id)).has(requesterId)
      ? null : "You can only decide leave for employees on your own team.";
  }

  const DAY_TYPES = ["full", "half_morning", "half_afternoon"];
  function validateLeavePayload(b: Record<string, unknown>, isAdmin: boolean) {
    if (!b.leave_type_id || !b.starts_on || !b.ends_on) return "Leave type and dates are required.";
    if ((b.ends_on as string) < (b.starts_on as string)) return "Leave end must be on or after the start.";
    if (!isAdmin && (b.starts_on as string) < new Date().toISOString().slice(0, 10)) return "Leave date cannot be in the past.";
    if (!String(b.reason ?? "").trim()) return "Reason is required.";
    const dayType = String(b.day_type ?? "full");
    if (!DAY_TYPES.includes(dayType)) return "Invalid leave duration.";
    return null;
  }

  app.post(`${P}/leave`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    if (!(await requireModule(res, u, "leave"))) return;
    const b = req.body as Record<string, unknown>;
    const err = validateLeavePayload(b, isMoAdmin(u));
    if (err) return sendError(res, 400, err);
    const ins = await pool.query(
      `INSERT INTO mo_leave_requests
         (user_id, leave_type_id, starts_on, ends_on, day_type, reason, replacement_user_id, affected_project_id, remarks, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending') RETURNING *`,
      [u.id, Number(b.leave_type_id), b.starts_on, b.ends_on, String(b.day_type ?? "full"), String(b.reason ?? "").trim(),
        b.replacement_user_id ? String(b.replacement_user_id) : null,
        b.affected_project_id ? Number(b.affected_project_id) : null,
        String(b.remarks ?? "")]);
    await audit(u, "leave.requested", "leave_request", ins.rows[0].id, null, { s: b.starts_on, e: b.ends_on }, req);
    // Route to whoever has authority to decide it (TL for employees, Admin for TLs).
    for (const approver of await approversFor(u.id))
      await notifyLeave(approver, "approval", "Leave request awaiting your decision",
        `${u.full_name ?? "A crew member"} requested leave ${b.starts_on} → ${b.ends_on}.`, Number(ins.rows[0].id));
    res.status(201).json({ leave: ins.rows[0] });
  }));

  // Employee edits their own request — only while it's still pending (VR).
  app.patch(`${P}/leave/:id`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    const id = parseInt(getSingleParam(req.params.id), 10);
    const existing = (await pool.query(`SELECT * FROM mo_leave_requests WHERE id=$1`, [id])).rows[0];
    if (!existing) return sendError(res, 404, "Leave request not found.");
    if (existing.user_id !== u.id && !isMoAdmin(u)) return sendError(res, 403, "You can only edit your own leave request.");
    if (existing.status !== "pending") return sendError(res, 400, "Only a pending leave request can be edited.");
    const b = req.body as Record<string, unknown>;
    const err = validateLeavePayload(b, isMoAdmin(u));
    if (err) return sendError(res, 400, err);
    const upd = await pool.query(
      `UPDATE mo_leave_requests SET leave_type_id=$1, starts_on=$2, ends_on=$3, day_type=$4, reason=$5,
         replacement_user_id=$6, affected_project_id=$7, remarks=$8, updated_at=NOW()
       WHERE id=$9 RETURNING *`,
      [Number(b.leave_type_id), b.starts_on, b.ends_on, String(b.day_type ?? "full"), String(b.reason ?? "").trim(),
        b.replacement_user_id ? String(b.replacement_user_id) : null,
        b.affected_project_id ? Number(b.affected_project_id) : null,
        String(b.remarks ?? ""), id]);
    await audit(u, "leave.edited", "leave_request", id, null, { s: b.starts_on, e: b.ends_on }, req);
    res.json({ leave: upd.rows[0] });
  }));

  // Employee cancels their own pending request. Approved/rejected leave is
  // immutable to the employee — a Team Lead/Admin decision reverses that instead.
  app.post(`${P}/leave/:id/cancel`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    const id = parseInt(getSingleParam(req.params.id), 10);
    const existing = (await pool.query(`SELECT * FROM mo_leave_requests WHERE id=$1`, [id])).rows[0];
    if (!existing) return sendError(res, 404, "Leave request not found.");
    if (existing.user_id !== u.id && !isMoAdmin(u)) return sendError(res, 403, "You can only cancel your own leave request.");
    if (existing.status !== "pending") return sendError(res, 400, "Only a pending leave request can be cancelled.");
    await pool.query(`UPDATE mo_leave_requests SET status='cancelled', updated_at=NOW() WHERE id=$1`, [id]);
    await audit(u, "leave.cancelled", "leave_request", id, null, {}, req);
    res.json({ ok: true, status: "cancelled" });
  }));

  app.post(`${P}/leave/:id/decision`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    const id = parseInt(getSingleParam(req.params.id), 10);
    const decision = String((req.body as Record<string, unknown>).decision ?? "");
    if (!["approved", "rejected", "cancelled"].includes(decision)) return sendError(res, 400, "Invalid decision.");
    const existing = (await pool.query(`SELECT user_id, status FROM mo_leave_requests WHERE id=$1`, [id])).rows[0];
    if (!existing) return sendError(res, 404, "Leave request not found.");
    // Hierarchy gate — the authority for who may decide what (never the UI).
    const denied = await canDecideLeaveFor(u, String(existing.user_id));
    if (denied) return sendError(res, 403, denied);
    const note = String((req.body as Record<string, unknown>).note ?? "");
    await pool.query(`UPDATE mo_leave_requests SET status=$1, decided_by=$2, decided_at=NOW(), decision_note=$3, updated_at=NOW() WHERE id=$4`,
      [decision, u.id, note, id]);
    // Audit carries approver id + role + timestamp (occurred_at) + remarks.
    await audit(u, `leave.${decision}`, "leave_request", id,
      { status: existing.status },
      { decision, decided_by: u.id, decided_by_role: moRoleOf(u), requester_id: existing.user_id, remarks: note }, req);
    await notifyLeave(String(existing.user_id), "approval", `Leave ${decision}`,
      `${u.full_name ?? "Your approver"} ${decision} your leave request.${note ? " Note: " + note : ""}`, id);
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
      `SELECT id, name, description, academic_unit_id, start_date, end_date, code FROM mo_projects
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
      if (a.academic_unit_id && a.academic_unit_id === b.academic_unit_id) score += 0.15;
      if (overlap(a, b)) score += 0.15;
      if (score >= 0.5) pairs.push({ a: { id: a.id, name: a.name, code: a.code }, b: { id: b.id, name: b.name, code: b.code },
        score: Math.min(1, score).toFixed(2), reasons: [t >= 0.2 ? "similar title/scope" : null, a.academic_unit_id === b.academic_unit_id ? "same academic unit" : null, overlap(a, b) ? "overlapping dates" : null].filter(Boolean) });
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
  // FR-14 — create a management board (+ default columns). TL/Admin.
  app.post(`${P}/boards`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    if (!(isMoAdmin(u) || isMoTL(u))) return sendError(res, 403, "Management boards are for Team Leads and Admins (FR-14.1).");
    const b = req.body as Record<string, unknown>;
    const name = String(b.name ?? "").trim();
    if (!name) return sendError(res, 400, "Board name is required.");
    const ins = await pool.query(
      `INSERT INTO mo_boards (department_id, name, is_management, created_by, is_active) VALUES (1,$1,true,$2,true) RETURNING *`, [name, u.id]);
    const cols = Array.isArray(b.columns) && b.columns.length ? (b.columns as unknown[]).map(String) : ["To do", "Doing", "Review", "Done"];
    for (let i = 0; i < cols.length; i++)
      await pool.query(`INSERT INTO mo_board_columns (board_id, name, sort_order) VALUES ($1,$2,$3)`, [ins.rows[0].id, cols[i], i]);
    await audit(u, "board.created", "board", ins.rows[0].id, null, { name, columns: cols }, req);
    res.status(201).json({ board: ins.rows[0] });
  }));

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
    // Lifecycle (PRD §3): Assigned → In Progress → Delivered → Approved (optional).
    // The owner delivers, then a reviewer approves via approval_status — so
    // in_progress → delivered is a first-class transition. The older
    // review-then-deliver path (in_review → approved → delivered) still works.
    const DELIV: Record<string, string[]> = {
      not_started: ["in_progress", "delivered", "not_required", "cancelled"],
      in_progress: ["in_review", "delivered", "not_required", "cancelled"],
      in_review: ["approved", "changes_requested", "delivered", "cancelled"],
      changes_requested: ["in_progress", "in_review", "approved", "cancelled"],
      approved: ["delivered", "changes_requested"],
      delivered: ["changes_requested"],   // a reviewer can send delivered work back
      not_required: ["not_started"], cancelled: ["not_started"],
    };
    if (!(DELIV[d.status] ?? []).includes(to)) return sendError(res, 400, `BR-1: ${d.status} → ${to} is not a valid transition.`);
    const isPMrow = (await pool.query(
      `SELECT 1 FROM mo_project_assignments a WHERE a.project_id=$1 AND a.user_id=$2 AND a.is_project_manager AND a.removed_at IS NULL`,
      [d.project_id, u.id])).rows[0];
    // §7: an employee may drive their OWN deliverable only.
    if (!isMoAdmin(u) && !isMoTL(u) && !isPMrow && String(d.owner_id) !== u.id)
      return sendError(res, 403, "You can only update deliverables assigned to you.");
    // Admin has full override (no review mandate — #4). Everyone else obeys BR-5.
    if (!isMoAdmin(u) && to === "approved") {
      const v = (await pool.query(`SELECT submitted_by FROM mo_deliverable_versions WHERE deliverable_id=$1 ORDER BY version_no DESC LIMIT 1`, [id])).rows[0];
      if (v && v.submitted_by === u.id) return sendError(res, 403, "BR-5: a version cannot be approved by its submitter.");
      if (!(isMoTL(u) || isPMrow)) return sendError(res, 403, "BR-5: reviewer must be the PM, a Team Lead or Admin.");
    }
    // Delivering stamps who/when and re-opens the approval gate for the reviewer.
    const delivering = to === "delivered";
    await pool.query(
      `UPDATE mo_deliverables SET status=$1,
         completed_at = CASE WHEN $2 THEN CURRENT_DATE ELSE completed_at END,
         delivered_by = CASE WHEN $2 THEN $3 ELSE delivered_by END,
         approval_status = CASE WHEN $2 THEN 'pending' ELSE approval_status END,
         updated_at = NOW()
       WHERE id=$4`, [to, delivering, u.id, id]);
    await audit(u, "deliverable.status_changed", "deliverable", id,
      { status: d.status }, { status: to, delivered_by: delivering ? u.id : undefined }, req);
    // Tell the reviewers there is something to review.
    if (delivering) {
      const reviewers = (await pool.query(
        `SELECT DISTINCT t.lead_user_id AS id FROM mo_team_members tm
           JOIN mo_teams t ON t.id=tm.team_id
          WHERE tm.user_id=$1 AND t.is_active AND t.lead_user_id IS NOT NULL AND t.lead_user_id <> $1`, [u.id])).rows;
      for (const r of reviewers)
        await pool.query(
          `INSERT INTO mo_notifications (user_id, kind, title, body, entity_type, entity_id)
           VALUES ($1,'review',$2,$3,'deliverable',$4)`,
          [r.id, "Deliverable delivered — needs review",
            `${u.full_name ?? "A crew member"} marked “${d.title}” as delivered.`, id]).catch(() => {});
    }
    res.json({ ok: true, status: to });
  }));

  // ── Approve / request changes on a DELIVERED output (PRD §3, §6) ─────────
  // Separate from the version-review machinery: this is the reviewer's verdict
  // on the deliverable itself, and it is what the employee sees straight back.
  app.post(`${P}/deliverables/:id/approval`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    const id = parseInt(getSingleParam(req.params.id), 10);
    const d = (await pool.query(`SELECT * FROM mo_deliverables WHERE id=$1`, [id])).rows[0];
    if (!d) return sendError(res, 404, "Deliverable not found.");
    const isPMrow = (await pool.query(
      `SELECT 1 FROM mo_project_assignments a WHERE a.project_id=$1 AND a.user_id=$2 AND a.is_project_manager AND a.removed_at IS NULL`,
      [d.project_id, u.id])).rows[0];
    if (!(isMoAdmin(u) || isMoTL(u) || isPMrow))
      return sendError(res, 403, "Only a Team Lead, Admin or the project PM may approve deliverables.");
    if (String(d.owner_id) === u.id && !isMoAdmin(u))
      return sendError(res, 403, "BR-5: you cannot approve your own deliverable.");
    const to = String((req.body as Record<string, unknown>).approval_status ?? "");
    if (!["approved", "changes_requested", "rejected", "pending"].includes(to))
      return sendError(res, 400, "approval_status must be approved, changes_requested, rejected or pending.");
    const note = String((req.body as Record<string, unknown>).note ?? "");
    // "Needs revision" pulls the work back into the employee's active list.
    const backToWork = to === "changes_requested" || to === "rejected";
    const { rows } = await pool.query(
      `UPDATE mo_deliverables SET approval_status=$1, approved_by=$2, approved_at=NOW(),
         status = CASE WHEN $3 THEN 'changes_requested' ELSE status END,
         updated_at = NOW()
       WHERE id=$4 RETURNING *`, [to, u.id, backToWork, id]);
    await audit(u, "deliverable.approval_changed", "deliverable", id,
      { approval_status: d.approval_status, status: d.status },
      { approval_status: to, approved_by: u.id, approved_by_role: moRoleOf(u), note }, req);
    if (d.owner_id && String(d.owner_id) !== u.id)
      await pool.query(
        `INSERT INTO mo_notifications (user_id, kind, title, body, entity_type, entity_id)
         VALUES ($1,'review',$2,$3,'deliverable',$4)`,
        [d.owner_id, to === "approved" ? "Deliverable approved" : "Changes requested",
          `${u.full_name ?? "Your reviewer"} set “${d.title}” to ${to.replace("_", " ")}.${note ? " " + note : ""}`, id]).catch(() => {});
    res.json({ deliverable: rows[0] });
  }));

  // Delete a project (soft) — #11. TL/Admin.
  app.delete(`${P}/projects/:id`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    if (!(isMoAdmin(u) || isMoTL(u))) return sendError(res, 403, "Only a Team Lead or Admin may delete a project.");
    const id = parseInt(getSingleParam(req.params.id), 10);
    // G1: cascade the soft-delete so no orphans pollute the Library/Workload.
    await pool.query(`UPDATE mo_projects SET deleted_at=NOW() WHERE id=$1`, [id]);
    await pool.query(`UPDATE mo_deliverables SET deleted_at=NOW() WHERE project_id=$1 AND deleted_at IS NULL`, [id]);
    await pool.query(`UPDATE mo_project_assignments SET removed_at=NOW() WHERE project_id=$1 AND removed_at IS NULL`, [id]);
    await pool.query(`UPDATE mo_shoots SET status='cancelled' WHERE project_id=$1 AND status IN ('planned','confirmed')`, [id]);
    await pool.query(`UPDATE mo_assignments SET status='cancelled' WHERE project_id=$1 AND status NOT IN ('done','cancelled')`, [id]);
    await audit(u, "project.deleted", "project", id, null, { cascade: "deliverables, assignments, shoots, tasks" }, req);
    res.json({ ok: true });
  }));

  // Remove a media crew member — #6. Admin only. Blocks if they have activity.
  /* What a member is currently holding. Drives the confirmation modal so the
     Admin decides with the facts in front of them — this is information, never
     a blocker. */
  app.get(`${P}/crew/:id/impact`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    if (!isMoAdmin(u)) return sendError(res, 403, "Only Admin may inspect a member's active work.");
    const id = getSingleParam(req.params.id);
    const one = async (sql: string) => Number((await pool.query(sql, [id])).rows[0]?.n ?? 0);
    const [projects, deliverables, reviews, assignments, reports] = await Promise.all([
      one(`SELECT count(*) n FROM mo_projects WHERE owner_id=$1 AND status NOT IN ('completed','archived','cancelled') AND deleted_at IS NULL`),
      one(`SELECT count(*) n FROM mo_deliverables WHERE owner_id=$1 AND status NOT IN ('delivered','not_required','cancelled') AND deleted_at IS NULL`),
      one(`SELECT count(*) n FROM mo_deliverable_versions v JOIN mo_deliverables d ON d.id=v.deliverable_id
            WHERE v.review_status='pending' AND d.owner_id=$1`),
      one(`SELECT count(*) n FROM mo_assignment_users au JOIN mo_assignments a ON a.id=au.assignment_id
            WHERE au.user_id=$1 AND a.status NOT IN ('done','cancelled')`),
      one(`SELECT count(*) n FROM mo_daily_reports WHERE user_id=$1`),
    ]);
    const led = (await pool.query(
      `SELECT t.id, t.name,
              (SELECT count(*) FROM mo_team_members m WHERE m.team_id=t.id)::int AS members,
              (SELECT count(*) FROM mo_projects p WHERE p.owner_id=$1 AND p.deleted_at IS NULL)::int AS projects
         FROM mo_teams t WHERE t.lead_user_id=$1 AND t.archived_at IS NULL`, [id])).rows;
    const history = await one(`SELECT count(*) n FROM mo_audit_logs WHERE actor_id=$1`);
    res.json({
      active: { projects, deliverables, reviews, assignments },
      history: { reports, audit_entries: history },
      leads_teams: led,
      has_active_work: projects + deliverables + reviews + assignments > 0,
    });
  }));

  /* Remove a member.
     This DEACTIVATES the account; it never deletes production data. The user row
     survives so that every historical reference — reports, versions, reviews,
     comments, dispatch records, audit rows — keeps resolving to the real person.
     "Delivered by Manav Trivedi" therefore still reads correctly afterwards.

     What removal actually does:
       · revokes sign-in (status + a scrambled password hash)
       · drops active team membership, and unassigns them from a team they lead
         (the team itself survives, with no lead)
       · closes out open project assignments so selectors stop offering them
     Historical rows are deliberately left untouched. */
  app.delete(`${P}/crew/:id`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    if (!isMoAdmin(u)) return sendError(res, 403, "Only Admin may remove crew members.");
    const realId = getSingleParam(req.params.id);
    if (realId === u.id) return sendError(res, 400, "You cannot remove yourself.");
    const target = (await pool.query(`SELECT id, full_name, role, status FROM users WHERE id=$1 AND team='media'`, [realId])).rows[0];
    if (!target) return sendError(res, 404, "That member is not on the media crew.");
    if (target.status === "archived") return res.json({ ok: true, already: true });

    const b = (req.body ?? {}) as Record<string, unknown>;
    const reassignTo = b.reassign_to ? String(toUid(b.reassign_to)) : null;
    const newLead = b.new_lead ? String(toUid(b.new_lead)) : null;

    // Optional: hand active work to someone else FIRST, so nothing is orphaned.
    // Entirely the Admin's choice — removal proceeds either way.
    let reassigned = 0;
    if (reassignTo && reassignTo !== realId) {
      const r1 = await pool.query(
        `UPDATE mo_deliverables SET owner_id=$1 WHERE owner_id=$2
           AND status NOT IN ('delivered','not_required','cancelled') AND deleted_at IS NULL`, [reassignTo, realId]);
      const r2 = await pool.query(
        `UPDATE mo_projects SET owner_id=$1 WHERE owner_id=$2
           AND status NOT IN ('completed','archived','cancelled') AND deleted_at IS NULL`, [reassignTo, realId]);
      reassigned = (r1.rowCount ?? 0) + (r2.rowCount ?? 0);
    }

    // Teams they lead survive. A replacement lead may be named; otherwise the
    // team is left Lead Unassigned for an Admin to fill later. The team, its
    // members and its projects are never touched.
    const ledTeams = (await pool.query(`SELECT id, name FROM mo_teams WHERE lead_user_id=$1`, [realId])).rows;
    if (ledTeams.length) {
      if (newLead && newLead !== realId) {
        await pool.query(`UPDATE mo_teams SET lead_user_id=$1 WHERE lead_user_id=$2`, [newLead, realId]);
        await pool.query(`UPDATE users SET role='sub_admin' WHERE id=$1 AND role='user'`, [newLead]);
        await pool.query(`UPDATE mo_user_profiles SET mo_role='team_lead' WHERE user_id=$1 AND mo_role='employee'`, [newLead]);
      } else {
        await pool.query(`UPDATE mo_teams SET lead_user_id=NULL WHERE lead_user_id=$1`, [realId]);
      }
    }

    // Remove from ACTIVE operational surfaces only.
    await pool.query(`DELETE FROM mo_team_members WHERE user_id=$1`, [realId]);
    await pool.query(`UPDATE mo_project_assignments SET removed_at=NOW() WHERE user_id=$1 AND removed_at IS NULL`, [realId]);
    await pool.query(`DELETE FROM mo_assignment_users WHERE user_id=$1 AND assignment_id IN
                        (SELECT id FROM mo_assignments WHERE status NOT IN ('done','cancelled'))`, [realId]);
    await pool.query(`DELETE FROM mo_shoot_crew WHERE user_id=$1 AND shoot_id IN
                        (SELECT id FROM mo_shoots WHERE shoot_date >= CURRENT_DATE)`, [realId]);

    // Revoke access. The hash is replaced with a value no password can produce,
    // so the account cannot be signed into even if status were ever bypassed.
    await pool.query(
      `UPDATE users SET status='archived', deactivated_at=NOW(), deactivated_by=$1,
         deactivation_reason=$2, password_hash=concat('removed:', gen_random_uuid()::text)
       WHERE id=$3`,
      [u.id, String(b.reason ?? "Removed by admin"), realId]);

    await audit(u, "crew.removed", "user", null, { id: realId, name: target.full_name, status: target.status },
      { id: realId, status: "archived", reassigned_to: reassignTo, teams_unassigned: ledTeams.map((t) => t.name),
        new_lead: newLead, forced: !!b.force }, req);
    res.json({
      ok: true, status: "archived", reassigned,
      teams_unassigned: ledTeams.map((t) => ({ id: t.id, name: t.name })),
      new_lead: newLead,
    });
  }));

  /* Restore a removed account. Removal is reversible by an Admin — the spec's
     "cannot be undone from the UI" refers to the member's own access, not to an
     Admin's ability to put a mistake right. */
  app.post(`${P}/crew/:id/restore`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    if (!isMoAdmin(u)) return sendError(res, 403, "Only Admin may restore an account.");
    const realId = getSingleParam(req.params.id);
    const t = (await pool.query(`SELECT status FROM users WHERE id=$1 AND team='media'`, [realId])).rows[0];
    if (!t) return sendError(res, 404, "That member is not on the media crew.");
    if (t.status === "active") return res.json({ ok: true, already: true });
    // The password is NOT restored — it was destroyed on removal by design, so a
    // restored member goes through a password reset like any new account.
    await pool.query(
      `UPDATE users SET status='active', deactivated_at=NULL, deactivated_by=NULL, deactivation_reason=NULL WHERE id=$1`,
      [realId]);
    await audit(u, "crew.restored", "user", null, { id: realId, status: t.status }, { id: realId, status: "active" }, req);
    res.json({ ok: true, needs_password_reset: true });
  }));

  // Change a member's role (and optionally team-lead) — #1. Admin only.
  app.post(`${P}/crew/:id/role`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    if (!isMoAdmin(u)) return sendError(res, 403, "Only Admin may change roles.");
    const realId = getSingleParam(req.params.id);
    const want = String((req.body as Record<string, unknown>).role);
    // The Operations Coordinator is a MEDIA role: at platform level they are an
    // ordinary 'user', and mo_role carries the distinction. Every other role maps
    // straight through, so Nerve-wide parity is preserved.
    const role = ({ admin: "admin", team_lead: "sub_admin", employee: "user", coordinator: "user" } as Record<string, string>)[want];
    const moRole = ({ admin: "admin", team_lead: "team_lead", employee: "employee", coordinator: "coordinator" } as Record<string, string>)[want];
    if (!role) return sendError(res, 400, "Invalid role.");
    if (realId === u.id) return sendError(res, 400, "You cannot change your own role.");
    await pool.query(`UPDATE users SET role=$1 WHERE id=$2 AND team='media'`, [role, realId]);
    await pool.query(`UPDATE mo_user_profiles SET mo_role=$1 WHERE user_id=$2`, [moRole, realId]);
    // Group I rule: module access may only REMOVE what the role grants, never add.
    // Demoting to employee drops role-exclusive module grants (audited via the row diff).
    // Module keys mirror the sidebar, so the set an employee cannot reach is the
    // Admin group plus the lead-only sidebar entries.
    if (role === "user")
      await pool.query(
        `UPDATE mo_user_profiles SET allowed_modules = (
           SELECT COALESCE(jsonb_agg(m), '[]'::jsonb) FROM jsonb_array_elements_text(allowed_modules) m
            WHERE m NOT IN ('admin/settings','admin/automations','admin/audit','admin/users',
                            'spec','team','analytics','boards'))
         WHERE user_id=$1 AND allowed_modules IS NOT NULL`, [realId]);
    await audit(u, "crew.role_changed", "user", null, null, { id: realId, role }, req);
    res.json({ ok: true, role });
  }));

  // ═══════════════════════ CASTING LIBRARY ══════════════════════════════════
  // Maintaining the library is a DUTY (D4), not a role: an ordinary employee
  // carrying the casting_manager flag manages it and stays an employee
  // everywhere else. Admin always has access.
  async function canManageCasting(u: CurrentUser): Promise<boolean> {
    if (isMoAdmin(u)) return true;
    if (await hasModuleGrant(u, "casting-admin")) return true;   // explicit grant adds it
    const r = await pool.query(
      `SELECT 1 FROM mo_user_duties d JOIN mo_duty_flags f ON f.id=d.duty_flag_id
        WHERE d.user_id=$1 AND f.code='casting_manager'`, [u.id]);
    return !!r.rows[0];
  }
  const castingAdmin = async (res: express.Response, u: CurrentUser): Promise<boolean> => {
    if (await canManageCasting(u)) return true;
    sendError(res, 403, "Only the Casting Manager or an Admin may maintain the casting library.");
    return false;
  };
  /* A Drive folder link, validated rather than trusted — a malformed URL in the
     library is a dead end for whoever needs the media on a shoot day. */
  const DRIVE_RE = /^https:\/\/(drive|docs)\.google\.com\/[^\s]+$/i;
  const nextCastId = async (): Promise<string> => {
    const { rows } = await pool.query(
      `SELECT COALESCE(MAX(NULLIF(regexp_replace(cast_id,'\\D','','g'),'')::int),0) AS n FROM mo_casting_records`);
    return `CAST-${String(Number(rows[0].n) + 1).padStart(5, "0")}`;
  };

  /* Records the ordinary crew may see: active, and cleared for production use.
     Consent is the gate — pending/restricted/expired records stay with the
     Casting Manager until sorted out. */
  const PREVIEW_WHERE = `archived_at IS NULL AND availability <> 'archived' AND consent_status = 'confirmed'`;

  app.get(`${P}/casting`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    const manage = await canManageCasting(u);
    const q = req.query as Record<string, unknown>;
    // Management sees everything; everyone else sees only usable records.
    const all = manage && String(q.scope ?? "") === "all";
    const conds: string[] = [all ? "1=1" : PREVIEW_WHERE], vals: unknown[] = []; let i = 1;
    if (q.q) {
      // One search box across everything a caster would think to type.
      conds.push(`(r.name ILIKE $${i} OR r.cast_id ILIKE $${i} OR r.profession ILIKE $${i}
        OR r.category ILIKE $${i} OR r.location ILIKE $${i} OR r.languages::text ILIKE $${i}
        OR replace(r.age_group,'_',' ') ILIKE $${i} OR r.availability ILIKE $${i}
        OR EXISTS (SELECT 1 FROM mo_casting_record_tags rt JOIN mo_casting_tags t ON t.id=rt.tag_id
                    WHERE rt.record_id=r.id AND t.name ILIKE $${i})
        OR EXISTS (SELECT 1 FROM mo_casting_record_collections rc JOIN mo_casting_collections c ON c.id=rc.collection_id
                    WHERE rc.record_id=r.id AND c.name ILIKE $${i}))`);
      vals.push(`%${String(q.q)}%`); i++;
    }
    for (const [k, col] of [["category", "r.category"], ["age_group", "r.age_group"],
      ["availability", "r.availability"], ["consent_status", "r.consent_status"], ["gender", "r.gender"]] as const)
      if (q[k]) { conds.push(`${col}=$${i++}`); vals.push(String(q[k])); }
    if (q.tag) { conds.push(`EXISTS (SELECT 1 FROM mo_casting_record_tags rt WHERE rt.record_id=r.id AND rt.tag_id=$${i++})`); vals.push(Number(q.tag)); }
    if (q.collection) { conds.push(`EXISTS (SELECT 1 FROM mo_casting_record_collections rc WHERE rc.record_id=r.id AND rc.collection_id=$${i++})`); vals.push(Number(q.collection)); }
    if (q.language) { conds.push(`r.languages::text ILIKE $${i++}`); vals.push(`%${String(q.language)}%`); }
    const { rows } = await pool.query(
      `SELECT to_jsonb(r) || jsonb_build_object(
         'tags', COALESCE((SELECT jsonb_agg(rt.tag_id) FROM mo_casting_record_tags rt WHERE rt.record_id=r.id),'[]'::jsonb),
         'collections', COALESCE((SELECT jsonb_agg(rc.collection_id) FROM mo_casting_record_collections rc WHERE rc.record_id=r.id),'[]'::jsonb)
       ) AS row FROM mo_casting_records r WHERE ${conds.join(" AND ")} ORDER BY r.updated_at DESC LIMIT 500`, vals);
    // §31 — an applicant's university email belongs to the people reviewing them,
    // not to everyone browsing the library. Stripped from the payload itself, so
    // it cannot leak through the network response even though no card renders it.
    const records = rows.map((x) => {
      const r = x.row as Record<string, unknown>;
      if (!manage) { delete r.applicant_email; delete r.source_request_id; }
      return r;
    });
    res.json({ records, can_manage: manage });
  }));

  app.post(`${P}/casting`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    if (!(await castingAdmin(res, u))) return;
    const b = req.body as Record<string, unknown>;
    const name = String(b.name ?? "").trim();
    if (!name) return sendError(res, 400, "A casting name or reference is required.");
    if (!String(b.category ?? "").trim()) return sendError(res, 400, "Pick a primary category.");
    const drive = String(b.drive_url ?? "").trim();
    if (!DRIVE_RE.test(drive)) return sendError(res, 400, "Please enter a valid Google Drive folder link.");
    const castId = await nextCastId();
    const ins = await pool.query(
      `INSERT INTO mo_casting_records (cast_id, name, category, profession, age_group, gender, languages,
         campus_id, location, availability, consent_status, consent_date, consent_scope, review_date,
         drive_url, notes, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$17) RETURNING *`,
      [castId, name, String(b.category), (b.profession as string) || null, (b.age_group as string) || null,
       (b.gender as string) || null, JSON.stringify(b.languages ?? []),
       b.campus_id ? Number(b.campus_id) : null, (b.location as string) || null,
       String(b.availability ?? "available"), String(b.consent_status ?? "pending"),
       (b.consent_date as string) || null, (b.consent_scope as string) || null, (b.review_date as string) || null,
       drive, String(b.notes ?? ""), u.id]);
    const rec = ins.rows[0];
    await setCastingLinks(Number(rec.id), b);
    await audit(u, "casting.created", "casting_record", rec.id, null,
      { cast_id: castId, name, category: rec.category, consent_status: rec.consent_status }, req);
    res.status(201).json({ record: rec });
  }));

  /* Tag + collection membership, rewritten as a set. Kept in one place so create
     and update cannot drift apart. */
  async function setCastingLinks(recordId: number, b: Record<string, unknown>): Promise<void> {
    if (Array.isArray(b.tags)) {
      await pool.query(`DELETE FROM mo_casting_record_tags WHERE record_id=$1`, [recordId]);
      for (const t of b.tags as unknown[])
        await pool.query(`INSERT INTO mo_casting_record_tags (record_id, tag_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
          [recordId, Number(t)]);
    }
    if (Array.isArray(b.collections)) {
      await pool.query(`DELETE FROM mo_casting_record_collections WHERE record_id=$1`, [recordId]);
      for (const c of b.collections as unknown[])
        await pool.query(`INSERT INTO mo_casting_record_collections (record_id, collection_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
          [recordId, Number(c)]);
    }
  }

  app.patch(`${P}/casting/:id`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    if (!(await castingAdmin(res, u))) return;
    const id = parseInt(getSingleParam(req.params.id), 10);
    const cur = (await pool.query(`SELECT * FROM mo_casting_records WHERE id=$1`, [id])).rows[0];
    if (!cur) return sendError(res, 404, "Casting record not found.");
    const b = req.body as Record<string, unknown>;
    if (b.drive_url !== undefined && !DRIVE_RE.test(String(b.drive_url).trim()))
      return sendError(res, 400, "Please enter a valid Google Drive folder link.");
    const fields: string[] = [], vals: unknown[] = []; let i = 1;
    for (const c of ["name", "category", "profession", "age_group", "gender", "location", "availability",
      "consent_status", "consent_date", "consent_scope", "review_date", "drive_url", "notes"])
      if (b[c] !== undefined) { fields.push(`${c}=$${i++}`); vals.push(b[c] === "" ? null : b[c]); }
    if (b.languages !== undefined) { fields.push(`languages=$${i++}`); vals.push(JSON.stringify(b.languages)); }
    if (b.campus_id !== undefined) { fields.push(`campus_id=$${i++}`); vals.push(b.campus_id ? Number(b.campus_id) : null); }
    fields.push(`updated_by=$${i++}`); vals.push(u.id);
    fields.push(`updated_at=NOW()`);
    vals.push(id);
    const rec = (await pool.query(`UPDATE mo_casting_records SET ${fields.join(",")} WHERE id=$${i} RETURNING *`, vals)).rows[0];
    await setCastingLinks(id, b);
    // Consent and Drive changes are the ones worth seeing on their own in the log.
    const action = b.consent_status !== undefined && b.consent_status !== cur.consent_status ? "casting.consent_changed"
      : b.drive_url !== undefined && b.drive_url !== cur.drive_url ? "casting.drive_changed"
      : Array.isArray(b.tags) && b.name === undefined ? "casting.tagged" : "casting.updated";
    await audit(u, action, "casting_record", id,
      { cast_id: cur.cast_id, consent_status: cur.consent_status, availability: cur.availability, drive_url: cur.drive_url },
      { cast_id: rec.cast_id, consent_status: rec.consent_status, availability: rec.availability, drive_url: rec.drive_url }, req);
    res.json({ record: rec });
  }));

  /* Archive, never hard-delete: a record referenced by past projects or requests
     must stay readable. Admin force-delete lives behind ?purge=1. */
  app.delete(`${P}/casting/:id`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    if (!(await castingAdmin(res, u))) return;
    const id = parseInt(getSingleParam(req.params.id), 10);
    const cur = (await pool.query(`SELECT * FROM mo_casting_records WHERE id=$1`, [id])).rows[0];
    if (!cur) return sendError(res, 404, "Casting record not found.");
    const purge = String((req.query as Record<string, unknown>).purge ?? "") === "1";
    if (purge) {
      if (!isMoAdmin(u)) return sendError(res, 403, "Only an Admin may permanently delete a casting record.");
      await pool.query(`DELETE FROM mo_casting_records WHERE id=$1`, [id]);
      await audit(u, "casting.deleted", "casting_record", id, { cast_id: cur.cast_id, name: cur.name }, null, req);
      return res.json({ ok: true, purged: true });
    }
    await pool.query(`UPDATE mo_casting_records SET archived_at=NOW(), availability='archived', updated_by=$1 WHERE id=$2`, [u.id, id]);
    await audit(u, "casting.archived", "casting_record", id, { cast_id: cur.cast_id, availability: cur.availability },
      { availability: "archived" }, req);
    res.json({ ok: true });
  }));

  app.post(`${P}/casting/:id/restore`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    if (!(await castingAdmin(res, u))) return;
    const id = parseInt(getSingleParam(req.params.id), 10);
    const rec = (await pool.query(
      `UPDATE mo_casting_records SET archived_at=NULL, availability='available', updated_by=$1 WHERE id=$2 RETURNING *`,
      [u.id, id])).rows[0];
    if (!rec) return sendError(res, 404, "Casting record not found.");
    await audit(u, "casting.restored", "casting_record", id, { availability: "archived" }, { cast_id: rec.cast_id, availability: "available" }, req);
    res.json({ record: rec });
  }));

  /* Drive link check. HEAD tells us whether the URL still resolves; it cannot see
     inside a private folder, which is why the result is recorded as "reachable"
     rather than claimed as verified access. */
  app.post(`${P}/casting/:id/check-drive`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    if (!(await castingAdmin(res, u))) return;
    const id = parseInt(getSingleParam(req.params.id), 10);
    const rec = (await pool.query(`SELECT drive_url, cast_id FROM mo_casting_records WHERE id=$1`, [id])).rows[0];
    if (!rec) return sendError(res, 404, "Casting record not found.");
    let ok = false;
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 6000);
      const r = await fetch(String(rec.drive_url), { method: "HEAD", redirect: "follow", signal: ctl.signal });
      clearTimeout(t);
      ok = r.status < 400;
    } catch { ok = false; }
    await pool.query(`UPDATE mo_casting_records SET drive_ok=$1, drive_checked_at=NOW() WHERE id=$2`, [ok, id]);
    await audit(u, "casting.drive_checked", "casting_record", id, null, { cast_id: rec.cast_id, reachable: ok }, req);
    res.json({ ok, checked_at: new Date().toISOString() });
  }));

  // ── Casting requests ──────────────────────────────────────────────────────
  app.post(`${P}/casting-requests`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;               // anyone on the crew may ask
    const b = req.body as Record<string, unknown>;
    const need = String(b.need ?? "").trim();
    if (!need) return sendError(res, 400, "Describe the casting you need.");
    const n = (await pool.query(
      `SELECT COALESCE(MAX(NULLIF(regexp_replace(request_id,'\\D','','g'),'')::int),0) AS n FROM mo_casting_requests`)).rows[0].n;
    const code = `CR-${String(Number(n) + 1).padStart(5, "0")}`;
    const ins = await pool.query(
      `INSERT INTO mo_casting_requests (request_id, requested_by, project_id, need, category, age_group, gender,
         languages, due_date, notes, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'new') RETURNING *`,
      [code, u.id, b.project_id ? Number(b.project_id) : null, need, (b.category as string) || null,
       (b.age_group as string) || null, (b.gender as string) || null, JSON.stringify(b.languages ?? []),
       (b.due_date as string) || null, String(b.notes ?? "")]);
    await audit(u, "casting_request.created", "casting_request", ins.rows[0].id, null, { request_id: code, need }, req);
    // Tell whoever holds the duty, so a request cannot sit unseen.
    const managers = (await pool.query(
      `SELECT d.user_id FROM mo_user_duties d JOIN mo_duty_flags f ON f.id=d.duty_flag_id WHERE f.code='casting_manager'`)).rows;
    for (const m of managers)
      await pool.query(
        `INSERT INTO mo_notifications (user_id, kind, title, body, entity_type, entity_id)
         VALUES ($1,'casting',$2,$3,'casting_request',$4)`,
        [m.user_id, "New casting request", `${code}: ${need}`, ins.rows[0].id]);
    res.status(201).json({ request: ins.rows[0] });
  }));

  app.patch(`${P}/casting-requests/:id`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    if (!(await castingAdmin(res, u))) return;
    const id = parseInt(getSingleParam(req.params.id), 10);
    const cur = (await pool.query(`SELECT * FROM mo_casting_requests WHERE id=$1`, [id])).rows[0];
    if (!cur) return sendError(res, 404, "Casting request not found.");
    const b = req.body as Record<string, unknown>;
    const fields: string[] = [], vals: unknown[] = []; let i = 1;
    if (b.status !== undefined) { fields.push(`status=$${i++}`); vals.push(String(b.status)); }
    if (b.matched_record_id !== undefined) {
      fields.push(`matched_record_id=$${i++}`); vals.push(b.matched_record_id ? Number(b.matched_record_id) : null);
    }
    if (b.notes !== undefined) { fields.push(`notes=$${i++}`); vals.push(String(b.notes)); }
    fields.push(`handled_by=$${i++}`); vals.push(u.id);
    fields.push(`updated_at=NOW()`);
    vals.push(id);
    const r = (await pool.query(`UPDATE mo_casting_requests SET ${fields.join(",")} WHERE id=$${i} RETURNING *`, vals)).rows[0];
    await audit(u, r.status === "completed" ? "casting_request.completed" : "casting_request.updated",
      "casting_request", id, { status: cur.status }, { request_id: r.request_id, status: r.status, matched: r.matched_record_id }, req);
    if (r.status === "completed" && cur.requested_by)
      await pool.query(
        `INSERT INTO mo_notifications (user_id, kind, title, body, entity_type, entity_id)
         VALUES ($1,'casting',$2,$3,'casting_request',$4)`,
        [cur.requested_by, "Your casting request is ready", `${r.request_id} has been completed.`, id]);
    res.json({ request: r });
  }));

  // ── §33 link casting to a project ─────────────────────────────────────────
  app.post(`${P}/projects/:id/casting`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    const pid = parseInt(getSingleParam(req.params.id), 10);
    const recId = Number((req.body as Record<string, unknown>).record_id);
    if (!recId) return sendError(res, 400, "record_id is required.");
    await pool.query(
      `INSERT INTO mo_project_casting (project_id, record_id, linked_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
      [pid, recId, u.id]);
    await audit(u, "casting.linked_to_project", "casting_record", recId, null, { project_id: pid }, req);
    res.json({ ok: true });
  }));
  app.delete(`${P}/projects/:id/casting/:recordId`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    const pid = parseInt(getSingleParam(req.params.id), 10);
    const recId = parseInt(getSingleParam(req.params.recordId), 10);
    await pool.query(`DELETE FROM mo_project_casting WHERE project_id=$1 AND record_id=$2`, [pid, recId]);
    await audit(u, "casting.unlinked_from_project", "casting_record", recId, { project_id: pid }, null, req);
    res.json({ ok: true });
  }));

  // ═════════ EXTERNAL CASTING REGISTRATION — intake layer ═══════════════════
  // A campaign link anyone at the university can open without a NERVE account.
  // Submissions land in the SAME Requests queue the Casting Manager already
  // works; approval turns one into an ordinary casting record with a CAST ID.

  /* Identity verification happens HERE, on the server (§45). The browser tells us
     nothing we trust: it hands over a Google ID token, and we ask Google who it
     belongs to before believing any of it.

     GOOGLE_OAUTH_CLIENT_ID must be set for this to accept real sign-ins. Without
     it the endpoint refuses external submissions rather than pretending to have
     verified anybody — see the DEV note below. */
  type GoogleIdentity = { email: string; name: string; email_verified: boolean };
  async function verifyGoogleIdToken(idToken: string): Promise<GoogleIdentity | null> {
    if (!idToken) return null;
    try {
      // Google's tokeninfo endpoint validates the signature, issuer and expiry
      // for us and returns the claims — full server-side verification without
      // pulling in an OAuth dependency.
      const r = await fetch("https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(idToken));
      if (!r.ok) return null;
      const c = await r.json() as Record<string, unknown>;
      const aud = String(c.aud ?? "");
      const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID ?? "";
      // The token must have been minted for OUR client, or anyone could present a
      // token from any Google app and be believed.
      if (!clientId || aud !== clientId) return null;
      const iss = String(c.iss ?? "");
      if (iss !== "accounts.google.com" && iss !== "https://accounts.google.com") return null;
      const email = String(c.email ?? "").toLowerCase();
      if (!email) return null;
      return { email, name: String(c.name ?? email.split("@")[0]), email_verified: String(c.email_verified) === "true" };
    } catch { return null; }
  }
  /* Local development has no Google client configured, so the flow would be
     untestable. When ALLOW_DEV_CASTING_IDENTITY is explicitly enabled the server
     accepts a plain email — never in production, and it is refused the moment a
     real client id is configured. */
  function devIdentity(body: Record<string, unknown>): GoogleIdentity | null {
    if (process.env.NODE_ENV === "production") return null;
    if (process.env.ALLOW_DEV_CASTING_IDENTITY !== "1") return null;
    if (process.env.GOOGLE_OAUTH_CLIENT_ID) return null;
    const email = String(body.dev_email ?? "").trim().toLowerCase();
    if (!email) return null;
    return { email, name: String(body.dev_name ?? email.split("@")[0]), email_verified: true };
  }

  const linkOpen = (l: Record<string, unknown>): { ok: boolean; why?: string } => {
    if (!l.is_active) return { ok: false, why: "This casting registration is currently closed." };
    const today = new Date().toISOString().slice(0, 10);
    if (l.active_from && String(l.active_from).slice(0, 10) > today)
      return { ok: false, why: "This casting registration has not opened yet." };
    if (l.expires_on && String(l.expires_on).slice(0, 10) < today)
      return { ok: false, why: "This casting registration has closed." };
    return { ok: true };
  };

  // ── PUBLIC: campaign details. No NERVE session; deliberately reveals only what
  //    an applicant needs to see, never submissions or internal data.
  app.get(`/api/v1/public/casting/:token`, asyncHandler(async (req, res) => {
    const token = getSingleParam(req.params.token);
    const l = (await pool.query(`SELECT * FROM mo_casting_links WHERE token=$1`, [token])).rows[0];
    if (!l) return sendError(res, 404, "This casting registration link is not valid.");
    const st = linkOpen(l);
    res.json({
      campaign: { name: l.name, description: l.description, allowed_domain: l.allowed_domain,
        require_department: l.require_department },
      open: st.ok, message: st.why ?? null,
      google_client_id: process.env.GOOGLE_OAUTH_CLIENT_ID ?? null,
      dev_identity: process.env.NODE_ENV !== "production" && process.env.ALLOW_DEV_CASTING_IDENTITY === "1"
        && !process.env.GOOGLE_OAUTH_CLIENT_ID,
    });
  }));

  // ── PUBLIC: has this account already applied to this campaign? (§14)
  app.post(`/api/v1/public/casting/:token/lookup`, asyncHandler(async (req, res) => {
    const token = getSingleParam(req.params.token);
    const l = (await pool.query(`SELECT * FROM mo_casting_links WHERE token=$1`, [token])).rows[0];
    if (!l) return sendError(res, 404, "This casting registration link is not valid.");
    const b = req.body as Record<string, unknown>;
    const who = await verifyGoogleIdToken(String(b.id_token ?? "")) ?? devIdentity(b);
    if (!who) return sendError(res, 401, "We could not verify that Google account. Please sign in again.");
    if (!who.email.endsWith("@" + String(l.allowed_domain).replace(/^@/, "")))
      return sendError(res, 403, `Please sign in using your official @${String(l.allowed_domain).replace(/^@/, "")} Google account to submit this casting form.`);
    const ex = (await pool.query(
      `SELECT request_id, status, created_at FROM mo_casting_requests
        WHERE link_id=$1 AND lower(applicant_email)=lower($2)`, [l.id, who.email])).rows[0];
    res.json({ email: who.email, name: who.name, existing: ex ?? null });
  }));

  // ── PUBLIC: submit. Verified identity + domain + consent + dedupe, all here.
  app.post(`/api/v1/public/casting/:token/submit`, asyncHandler(async (req, res) => {
    const token = getSingleParam(req.params.token);
    const l = (await pool.query(`SELECT * FROM mo_casting_links WHERE token=$1`, [token])).rows[0];
    if (!l) return sendError(res, 404, "This casting registration link is not valid.");
    const st = linkOpen(l);
    if (!st.ok) return sendError(res, 403, st.why!);

    const b = req.body as Record<string, unknown>;
    const who = await verifyGoogleIdToken(String(b.id_token ?? "")) ?? devIdentity(b);
    if (!who) return sendError(res, 401, "We could not verify that Google account. Please sign in again.");
    const domain = String(l.allowed_domain).replace(/^@/, "");
    if (!who.email.endsWith("@" + domain))
      return sendError(res, 403, `Please sign in using your official @${domain} Google account to submit this casting form.`);
    if (!b.consent) return sendError(res, 400, "Please confirm the casting consent before submitting.");

    const name = String(b.name ?? who.name ?? "").trim();
    if (!name) return sendError(res, 400, "Please enter your full name.");
    const type = String(b.applicant_type ?? "").trim();
    if (!type) return sendError(res, 400, "Please tell us what best describes you.");
    if (l.require_department && !String(b.department ?? "").trim())
      return sendError(res, 400, "Please enter your department or institute.");

    // §14 — one submission per account per campaign; an update is allowed while
    // the request has not been decided.
    const ex = (await pool.query(
      `SELECT * FROM mo_casting_requests WHERE link_id=$1 AND lower(applicant_email)=lower($2)`,
      [l.id, who.email])).rows[0];
    const payload = {
      applicant_name: name, applicant_type: type,
      department: String(b.department ?? "") || null, designation: String(b.designation ?? "") || null,
      age_group: String(b.age_group ?? "") || null, gender: String(b.gender ?? "") || null,
      languages: JSON.stringify(Array.isArray(b.languages) ? b.languages : []),
      category: String(b.category ?? type) || null,
      interests: JSON.stringify(Array.isArray(b.interests) ? b.interests : []),
      availability: String(b.availability ?? "") || null,
      location: String(b.location ?? "") || null,
      intro: String(b.intro ?? "") || null,
      need: `${type} — ${name}`,
    };
    if (ex) {
      if (["approved", "rejected"].includes(String(ex.status)))
        return res.status(200).json({ duplicate: true, request_id: ex.request_id, status: ex.status,
          message: "You have already submitted a casting request for this drive." });
      await pool.query(
        `UPDATE mo_casting_requests SET applicant_name=$1, applicant_type=$2, department=$3, designation=$4,
           age_group=$5, gender=$6, languages=$7, category=$8, interests=$9, availability=$10, location=$11,
           intro=$12, need=$13, updated_at=NOW() WHERE id=$14`,
        [payload.applicant_name, payload.applicant_type, payload.department, payload.designation,
         payload.age_group, payload.gender, payload.languages, payload.category, payload.interests,
         payload.availability, payload.location, payload.intro, payload.need, ex.id]);
      return res.json({ updated: true, request_id: ex.request_id, status: ex.status });
    }

    const n = (await pool.query(
      `SELECT COALESCE(MAX(NULLIF(regexp_replace(request_id,'\\D','','g'),'')::int),0) AS n FROM mo_casting_requests`)).rows[0].n;
    const code = `CR-${String(Number(n) + 1).padStart(5, "0")}`;
    const ins = await pool.query(
      `INSERT INTO mo_casting_requests (request_id, source, link_id, applicant_email, applicant_name, applicant_type,
         department, designation, age_group, gender, languages, category, interests, availability, location, intro,
         need, consent_given, consent_at, status, submitted_ip)
       VALUES ($1,'external',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,true,NOW(),'new',$17) RETURNING *`,
      [code, l.id, who.email, payload.applicant_name, payload.applicant_type, payload.department,
       payload.designation, payload.age_group, payload.gender, payload.languages, payload.category,
       payload.interests, payload.availability, payload.location, payload.intro, payload.need,
       (req.headers["x-forwarded-for"] as string) || req.ip || null]);

    // Audited without a NERVE actor — the applicant has no account, by design (§7).
    await pool.query(
      // No NERVE actor by design (§7) — the applicant has no account. Recorded as
      // a 'system' event with the verified identity in the payload, which is the
      // vocabulary mo_audit_logs already uses for non-user actors.
      `INSERT INTO mo_audit_logs (actor_id, actor_role, action, entity_type, entity_id, before, after, ip)
       VALUES (NULL,'system','casting_request.submitted','casting_request',$1,NULL,$2,$3)`,
      [ins.rows[0].id, JSON.stringify({ request_id: code, campaign: l.name, applicant: who.email }),
       (req.ip ?? null)]);
    // Tell whoever holds the casting duty.
    const managers = (await pool.query(
      `SELECT d.user_id FROM mo_user_duties d JOIN mo_duty_flags f ON f.id=d.duty_flag_id WHERE f.code='casting_manager'`)).rows;
    for (const m of managers)
      await pool.query(
        `INSERT INTO mo_notifications (user_id, kind, title, body, entity_type, entity_id)
         VALUES ($1,'casting',$2,$3,'casting_request',$4)`,
        [m.user_id, "New casting registration", `${code} — ${name} (${type})`, ins.rows[0].id]);
    res.status(201).json({ request_id: code });
  }));

  // ── Registration links (Casting Manager / Admin) ───────────────────────────
  app.post(`${P}/casting-links`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    if (!(await castingAdmin(res, u))) return;
    const b = req.body as Record<string, unknown>;
    const name = String(b.name ?? "").trim();
    if (!name) return sendError(res, 400, "Give the campaign a name.");
    // Only an Admin may widen the domain away from the university default.
    const domain = String(b.allowed_domain ?? "paruluniversity.ac.in").replace(/^@/, "");
    if (domain !== "paruluniversity.ac.in" && !isMoAdmin(u))
      return sendError(res, 403, "Only an Admin may allow a domain other than the university's.");
    const token = randomUUID().replace(/-/g, "");
    const ins = await pool.query(
      `INSERT INTO mo_casting_links (token, name, description, allowed_domain, active_from, expires_on,
         require_department, is_active, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,true,$8) RETURNING *`,
      [token, name, String(b.description ?? ""), domain, (b.active_from as string) || null,
       (b.expires_on as string) || null, !!b.require_department, u.id]);
    await audit(u, "casting_link.created", "casting_link", ins.rows[0].id, null, { name, domain }, req);
    res.status(201).json({ link: ins.rows[0] });
  }));

  app.patch(`${P}/casting-links/:id`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    if (!(await castingAdmin(res, u))) return;
    const id = parseInt(getSingleParam(req.params.id), 10);
    const cur = (await pool.query(`SELECT * FROM mo_casting_links WHERE id=$1`, [id])).rows[0];
    if (!cur) return sendError(res, 404, "Registration link not found.");
    const b = req.body as Record<string, unknown>;
    const fields: string[] = [], vals: unknown[] = []; let i = 1;
    for (const c of ["name", "description", "active_from", "expires_on"])
      if (b[c] !== undefined) { fields.push(`${c}=$${i++}`); vals.push(b[c] === "" ? null : b[c]); }
    if (b.is_active !== undefined) { fields.push(`is_active=$${i++}`); vals.push(!!b.is_active); }
    if (b.require_department !== undefined) { fields.push(`require_department=$${i++}`); vals.push(!!b.require_department); }
    if (!fields.length) return res.json({ link: cur });
    fields.push(`updated_at=NOW()`); vals.push(id);
    const l = (await pool.query(`UPDATE mo_casting_links SET ${fields.join(",")} WHERE id=$${i} RETURNING *`, vals)).rows[0];
    await audit(u, b.is_active === false ? "casting_link.deactivated" : "casting_link.updated",
      "casting_link", id, { is_active: cur.is_active }, { name: l.name, is_active: l.is_active }, req);
    res.json({ link: l });
  }));

  // ── Review an external request, and approve it into a real casting record ──
  app.post(`${P}/casting-requests/:id/review`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    if (!(await castingAdmin(res, u))) return;
    const id = parseInt(getSingleParam(req.params.id), 10);
    const r = (await pool.query(`SELECT * FROM mo_casting_requests WHERE id=$1`, [id])).rows[0];
    if (!r) return sendError(res, 404, "Casting request not found.");
    const b = req.body as Record<string, unknown>;
    const to = String(b.status ?? "");
    if (!["under_review", "clarification", "approved", "rejected", "archived"].includes(to))
      return sendError(res, 400, "Unknown review decision.");
    const note = String(b.note ?? "").trim() || null;

    if (to !== "approved") {
      await pool.query(
        `UPDATE mo_casting_requests SET status=$1, review_note=COALESCE($2, review_note), handled_by=$3,
           reviewed_at=NOW(), archived_at=CASE WHEN $1='archived' THEN NOW() ELSE archived_at END,
           updated_at=NOW() WHERE id=$4`, [to, note, u.id, id]);
      await audit(u, `casting_request.${to}`, "casting_request", id, { status: r.status },
        { request_id: r.request_id, status: to, note }, req);
      return res.json({ ok: true, status: to });
    }

    // §22 — approval is not a status change: it creates the casting record.
    if (r.matched_record_id) return sendError(res, 409, "This request already has a casting record.");
    const castId = await nextCastId();
    const rec = (await pool.query(
      `INSERT INTO mo_casting_records (cast_id, name, category, profession, age_group, gender, languages,
         campus_id, location, availability, consent_status, consent_date, notes,
         source, source_request_id, applicant_email, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'confirmed',CURRENT_DATE,$11,'external_registration',$12,$13,$14,$14)
       RETURNING *`,
      [castId, r.applicant_name ?? r.need, r.category ?? r.applicant_type ?? "Other", r.designation ?? null,
       r.age_group ?? null, r.gender ?? null, JSON.stringify(r.languages ?? []),
       r.campus_id ?? null, r.location ?? null,
       ({ "Available regularly": "available", "Available occasionally": "limited",
          "Available with advance notice": "limited", "Currently unavailable": "unavailable" } as Record<string, string>)[String(r.availability)] ?? "available",
       [r.intro, r.department ? `Department: ${r.department}` : null].filter(Boolean).join("\n"),
       id, r.applicant_email, u.id])).rows[0];
    await pool.query(
      `UPDATE mo_casting_requests SET status='approved', matched_record_id=$1, review_note=COALESCE($2, review_note),
         handled_by=$3, reviewed_at=NOW(), updated_at=NOW() WHERE id=$4`, [rec.id, note, u.id, id]);
    // §40 — ONE meaningful entry for the approval, not three technical ones. The
    // individual writes are still visible in the audit log itself.
    await audit(u, "casting_request.approved", "casting_request", id, { status: r.status },
      { request_id: r.request_id, status: "approved", cast_id: castId, record_id: rec.id, note }, req);
    res.json({ ok: true, status: "approved", cast_id: castId, record: rec });
  }));

  // ═══════════ OPERATIONS COORDINATOR — intake → conversion → dispatch ══════
  // The coordinator owns the first and last stage of a project. Everything in
  // between (assignment, production, review, approval) stays in the modules that
  // already own it; nothing here duplicates a production workflow.
  const coordOnly = async (res: express.Response, u: CurrentUser): Promise<boolean> => {
    if (isMoAdmin(u) || await isCoordinator(u)) return true;
    sendError(res, 403, "Only the Operations Coordinator or an Admin may do this.");
    return false;
  };

  // ── Request intake ────────────────────────────────────────────────────────
  // ═════════ EXTERNAL MEDIA REQUEST INTAKE — the intake door ════════════════
  // Identity verification, domain rules and abuse protection are the SAME layer
  // the casting portal uses (verifyGoogleIdToken / devIdentity above) — one
  // implementation, so the security story cannot diverge between the two doors.

  const reqLinkOpen = (l: Record<string, unknown>): { ok: boolean; why?: string } => {
    if (!l.is_active) return { ok: false, why: "This media request portal is currently unavailable. Please contact the Media Operations team for assistance." };
    const today = new Date().toISOString().slice(0, 10);
    if (l.active_from && String(l.active_from).slice(0, 10) > today)
      return { ok: false, why: "This media request portal has not opened yet." };
    if (l.expires_on && String(l.expires_on).slice(0, 10) < today)
      return { ok: false, why: "This media request portal has closed." };
    return { ok: true };
  };

  // ── PUBLIC: what the requester needs to render the form. Nothing internal.
  app.get(`/api/v1/public/request/:token`, asyncHandler(async (req, res) => {
    const token = getSingleParam(req.params.token);
    const l = (await pool.query(`SELECT * FROM mo_request_links WHERE token=$1`, [token])).rows[0];
    if (!l) return sendError(res, 404, "This media request link is not valid.");
    const st = reqLinkOpen(l);
    // The taxonomies come from the SAME master data the internal form uses (§9,
    // §15) — no second, incompatible vocabulary for external requesters.
    const units = (await pool.query(
      `SELECT id, name FROM mo_academic_units WHERE is_active AND archived_at IS NULL ORDER BY sort_order, name`)).rows;
    const delivTypes = (await pool.query(
      `SELECT id, name FROM mo_deliverable_types WHERE archived_at IS NULL ORDER BY name`)).rows;
    const workTypes = (await pool.query(
      `SELECT id, name FROM mo_work_types WHERE is_active AND archived_at IS NULL ORDER BY sort_order, name`)).rows;
    res.json({
      portal: { name: l.name, description: l.description, allowed_domain: l.allowed_domain },
      open: st.ok, message: st.why ?? null,
      units, deliverable_types: delivTypes, work_types: workTypes,
      google_client_id: process.env.GOOGLE_OAUTH_CLIENT_ID ?? null,
      dev_identity: process.env.NODE_ENV !== "production" && process.env.ALLOW_DEV_CASTING_IDENTITY === "1"
        && !process.env.GOOGLE_OAUTH_CLIENT_ID,
    });
  }));

  /* PUBLIC: who am I, and what have I already asked for? Powers both the
     prefilled contact details and the "My requests" list (§38) — which shows the
     requester their OWN submissions and nothing else. */
  app.post(`/api/v1/public/request/:token/me`, asyncHandler(async (req, res) => {
    const token = getSingleParam(req.params.token);
    const l = (await pool.query(`SELECT * FROM mo_request_links WHERE token=$1`, [token])).rows[0];
    if (!l) return sendError(res, 404, "This media request link is not valid.");
    const b = req.body as Record<string, unknown>;
    const who = await verifyGoogleIdToken(String(b.id_token ?? "")) ?? devIdentity(b);
    if (!who) return sendError(res, 401, "We could not verify that Google account. Please sign in again.");
    const domain = String(l.allowed_domain).replace(/^@/, "");
    if (!who.email.endsWith("@" + domain))
      return sendError(res, 403, `Please sign in using your official @${domain} account to submit a media request.`);
    // Deliberately narrow: id, title, date and a SIMPLIFIED status (§39). No
    // internal notes, no team, no assignments, no reviewer.
    const mine = (await pool.query(
      `SELECT code, event_name, event_date, status, created_at, project_id
         FROM mo_requests WHERE lower(requester_email)=lower($1) ORDER BY created_at DESC LIMIT 25`,
      [who.email])).rows.map((r) => ({
        code: r.code, event_name: r.event_name, event_date: r.event_date, created_at: r.created_at,
        // Internal vocabulary is not the requester's business.
        status: ({ new: "Submitted", under_review: "Under review", needs_clarification: "Clarification required",
          ready: "Under review", converted: "Scheduled / in production", closed: "Closed",
          rejected: "Closed" } as Record<string, string>)[String(r.status)] ?? "Submitted",
      }));
    res.json({ email: who.email, name: who.name, requests: mine });
  }));

  // ── PUBLIC: submit a media requirement.
  app.post(`/api/v1/public/request/:token/submit`, asyncHandler(async (req, res) => {
    const token = getSingleParam(req.params.token);
    const l = (await pool.query(`SELECT * FROM mo_request_links WHERE token=$1`, [token])).rows[0];
    if (!l) return sendError(res, 404, "This media request link is not valid.");
    const st = reqLinkOpen(l);
    if (!st.ok) return sendError(res, 403, st.why!);

    const b = req.body as Record<string, unknown>;
    const who = await verifyGoogleIdToken(String(b.id_token ?? "")) ?? devIdentity(b);
    if (!who) return sendError(res, 401, "We could not verify that Google account. Please sign in again.");
    const domain = String(l.allowed_domain).replace(/^@/, "");
    if (!who.email.endsWith("@" + domain))
      return sendError(res, 403, `Please sign in using your official @${domain} account to submit a media request.`);

    const institute = String(b.institute ?? "").trim();
    const event = String(b.event_name ?? "").trim();
    const stakeholder = String(b.stakeholder ?? who.name ?? "").trim();
    const requirement = String(b.requirement ?? "").trim();
    if (!institute) return sendError(res, 400, "Please tell us which institute or faculty this is for.");
    if (!event) return sendError(res, 400, "Please give the event or requirement a name.");
    if (!stakeholder) return sendError(res, 400, "Please give a point of contact.");
    if (!b.event_date) return sendError(res, 400, "Please give the date this is needed for.");
    if (!requirement) return sendError(res, 400, "Please summarise what you need.");

    /* §20 — a duplicate is a SIGNAL, not a hard block: same person, same event,
       same date. We surface the existing request and let them decide, because a
       genuine second request for the same event is legitimate. */
    if (!b.confirm_duplicate) {
      const dup = (await pool.query(
        `SELECT code, status FROM mo_requests
          WHERE lower(requester_email)=lower($1) AND lower(event_name)=lower($2)
            AND (event_date IS NOT DISTINCT FROM $3::date) AND status <> 'closed' LIMIT 1`,
        [who.email, event, (b.event_date as string) || null])).rows[0];
      if (dup) return res.status(409).json({
        duplicate: true, existing_code: dup.code, existing_status: dup.status,
        message: "A similar request may already exist.",
      });
    }

    const n = (await pool.query(
      `SELECT COALESCE(MAX(NULLIF(regexp_replace(code,'\\D','','g'),'')::int),0) AS n FROM mo_requests`)).rows[0].n;
    const code = `REQ-${String(Math.max(Number(n), 1000) + 1).padStart(5, "0")}`;
    const ins = await pool.query(
      `INSERT INTO mo_requests (code, source, link_id, requester_email, requester_name,
         institute, academic_unit_id, stakeholder, contact, contact_email, contact_phone,
         event_name, venue, event_date, event_time, end_date, end_time,
         requirement, description, requirement_types, deliverables_requested,
         priority, budget, meeting_required, meeting_date, meeting_time, meeting_notes,
         vendor_required, vendor_details, additional_notes, notes, status, submitted_ip)
       VALUES ($1,'external',$2,$3,$4,$5,$6,$7,$8,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,
               $20,$21,$22,$23,$24,$25,$26,$27,$28,'','new',$29) RETURNING *`,
      [code, l.id, who.email, who.name,
       institute, b.academic_unit_id ? Number(b.academic_unit_id) : null, stakeholder,
       String(b.contact_email ?? who.email), String(b.contact_phone ?? "") || null,
       event, (b.venue as string) || null, (b.event_date as string) || null, (b.event_time as string) || null,
       (b.end_date as string) || null, (b.end_time as string) || null,
       requirement, String(b.description ?? ""),
       JSON.stringify(Array.isArray(b.requirement_types) ? b.requirement_types : []),
       JSON.stringify(Array.isArray(b.deliverables_requested) ? b.deliverables_requested : []),
       ["urgent", "high", "normal", "low"].includes(String(b.priority)) ? String(b.priority) : "normal",
       b.budget != null && b.budget !== "" ? Number(b.budget) : null,
       !!b.meeting_required, (b.meeting_date as string) || null, (b.meeting_time as string) || null,
       String(b.meeting_notes ?? "") || null,
       !!b.vendor_required, String(b.vendor_details ?? "") || null,
       String(b.additional_notes ?? "") || null,
       (req.headers["x-forwarded-for"] as string) || req.ip || null]);

    // No NERVE actor — the requester has no account, by design (§6).
    await pool.query(
      `INSERT INTO mo_audit_logs (actor_id, actor_role, action, entity_type, entity_id, before, after, ip)
       VALUES (NULL,'system','request.submitted_external','request',$1,NULL,$2,$3)`,
      [ins.rows[0].id,
       JSON.stringify({ code, portal: l.name, requester: who.email, event, institute }),
       (req.ip ?? null)]);

    // A meeting request becomes a real follow-up for the coordinator (§12) —
    // never a silently scheduled meeting.
    if (b.meeting_required)
      await pool.query(
        `INSERT INTO mo_followups (request_id, stakeholder, contact, subject, reminder_date, notes, status)
         VALUES ($1,$2,$3,$4,$5,$6,'open')`,
        [ins.rows[0].id, stakeholder, who.email, `Meeting requested for ${event}`,
         (b.meeting_date as string) || null, String(b.meeting_notes ?? "")]);

    // Tell the coordinators. Anyone holding the coordinator media role.
    const coords = (await pool.query(
      `SELECT user_id FROM mo_user_profiles WHERE mo_role='coordinator'`)).rows;
    for (const c of coords)
      await pool.query(
        `INSERT INTO mo_notifications (user_id, kind, title, body, entity_type, entity_id)
         VALUES ($1,'request',$2,$3,'request',$4)`,
        [c.user_id, "New media request", `${code} — ${event} (${institute})`, ins.rows[0].id]);

    res.status(201).json({ code, event_name: event, submitted_at: ins.rows[0].created_at });
  }));

  // ── Request portal links (Operations Coordinator / Admin) ─────────────────
  app.post(`${P}/request-links`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    if (!(await coordOnly(res, u))) return;
    const b = req.body as Record<string, unknown>;
    const name = String(b.name ?? "").trim();
    if (!name) return sendError(res, 400, "Give the portal a name.");
    const domain = String(b.allowed_domain ?? "paruluniversity.ac.in").replace(/^@/, "");
    if (domain !== "paruluniversity.ac.in" && !isMoAdmin(u))
      return sendError(res, 403, "Only an Admin may allow a domain other than the university's.");
    const token = randomUUID().replace(/-/g, "");
    const ins = await pool.query(
      `INSERT INTO mo_request_links (token, name, description, allowed_domain, active_from, expires_on, is_active, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,true,$7) RETURNING *`,
      [token, name, String(b.description ?? ""), domain,
       (b.active_from as string) || null, (b.expires_on as string) || null, u.id]);
    await audit(u, "request_link.created", "request_link", ins.rows[0].id, null, { name, domain }, req);
    res.status(201).json({ link: ins.rows[0] });
  }));

  app.patch(`${P}/request-links/:id`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    if (!(await coordOnly(res, u))) return;
    const id = parseInt(getSingleParam(req.params.id), 10);
    const cur = (await pool.query(`SELECT * FROM mo_request_links WHERE id=$1`, [id])).rows[0];
    if (!cur) return sendError(res, 404, "Request portal not found.");
    const b = req.body as Record<string, unknown>;
    const fields: string[] = [], vals: unknown[] = []; let i = 1;
    for (const c of ["name", "description", "active_from", "expires_on"])
      if (b[c] !== undefined) { fields.push(`${c}=$${i++}`); vals.push(b[c] === "" ? null : b[c]); }
    if (b.is_active !== undefined) { fields.push(`is_active=$${i++}`); vals.push(!!b.is_active); }
    if (!fields.length) return res.json({ link: cur });
    fields.push(`updated_at=NOW()`); vals.push(id);
    const l = (await pool.query(`UPDATE mo_request_links SET ${fields.join(",")} WHERE id=$${i} RETURNING *`, vals)).rows[0];
    await audit(u, b.is_active === false ? "request_link.deactivated" : "request_link.updated",
      "request_link", id, { is_active: cur.is_active }, { name: l.name, is_active: l.is_active }, req);
    res.json({ link: l });
  }));

  app.post(`${P}/requests`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    if (!(await coordOnly(res, u))) return;
    const b = req.body as Record<string, unknown>;
    const event = String(b.event_name ?? "").trim();
    if (!event) return sendError(res, 400, "Event name is required.");
    const ins = await pool.query(
      `INSERT INTO mo_requests (institute, academic_unit_id, stakeholder, contact, event_name, project_type_id,
         venue, event_date, event_time, end_date, description, deliverables_requested, attachments,
         priority, budget, notes, status, received_by,
         contact_email, contact_phone, requirement, meeting_required, vendor_required, team_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'new',$17,
               $18,$19,$20,$21,$22,$23) RETURNING *`,
      [String(b.institute ?? ""), b.academic_unit_id ? Number(b.academic_unit_id) : null,
       String(b.stakeholder ?? ""), String(b.contact ?? b.contact_email ?? ""), event,
       b.project_type_id ? Number(b.project_type_id) : null, (b.venue as string) || null,
       (b.event_date as string) || null, (b.event_time as string) || null, (b.end_date as string) || null,
       String(b.description ?? ""), JSON.stringify(b.deliverables_requested ?? []),
       JSON.stringify(b.attachments ?? []),
       ["urgent", "high", "normal", "low"].includes(String(b.priority)) ? String(b.priority) : "normal",
       b.budget != null && b.budget !== "" ? Number(b.budget) : null, String(b.notes ?? ""), u.id,
       (b.contact_email as string) || null, (b.contact_phone as string) || null,
       (b.requirement as string) || null, !!b.meeting_required, !!b.vendor_required,
       b.team_id ? Number(b.team_id) : null]);
    const r = ins.rows[0];
    await pool.query(`UPDATE mo_requests SET code=$1 WHERE id=$2`, [`REQ-${1000 + Number(r.id)}`, r.id]);
    await audit(u, "request.created", "request", r.id, null, { event_name: event, institute: r.institute }, req);
    res.status(201).json({ request: { ...r, code: `REQ-${1000 + Number(r.id)}` } });
  }));

  app.patch(`${P}/requests/:id`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    if (!(await coordOnly(res, u))) return;
    const id = parseInt(getSingleParam(req.params.id), 10);
    const cur = (await pool.query(`SELECT * FROM mo_requests WHERE id=$1`, [id])).rows[0];
    if (!cur) return sendError(res, 404, "Request not found.");
    if (cur.status === "converted") return sendError(res, 409, "This request has already become a project — edit the project instead.");
    const b = req.body as Record<string, unknown>;
    const COLS = ["institute", "stakeholder", "contact", "event_name", "venue", "event_date", "event_time",
      "end_date", "description", "priority", "notes",
      "contact_email", "contact_phone", "requirement"];
    const fields: string[] = [], vals: unknown[] = []; let i = 1;
    for (const c of COLS) if (b[c] !== undefined) { fields.push(`${c}=$${i++}`); vals.push(b[c] === "" ? null : b[c]); }
    for (const c of ["academic_unit_id", "project_type_id", "team_id"]) if (b[c] !== undefined) { fields.push(`${c}=$${i++}`); vals.push(b[c] ? Number(b[c]) : null); }
    for (const c of ["meeting_required", "vendor_required"]) if (b[c] !== undefined) { fields.push(`${c}=$${i++}`); vals.push(!!b[c]); }
    if (b.budget !== undefined) { fields.push(`budget=$${i++}`); vals.push(b.budget === "" || b.budget == null ? null : Number(b.budget)); }
    for (const c of ["deliverables_requested", "attachments"]) if (b[c] !== undefined) { fields.push(`${c}=$${i++}`); vals.push(JSON.stringify(b[c])); }
    if (b.status !== undefined) {
      const to = String(b.status);
      // First move off 'new' is the moment Operations picked it up.
      if (cur.status === "new" && to !== "new" && !cur.first_touched_at)
        fields.push(`first_touched_at=NOW()`);
      // 'converted' is reached only through /convert, never by editing the status.
      const FLOW: Record<string, string[]> = {
        new: ["under_review", "needs_clarification", "ready", "closed", "rejected"],
        under_review: ["needs_clarification", "ready", "closed", "rejected"],
        needs_clarification: ["under_review", "ready", "closed", "rejected"],
        ready: ["under_review", "needs_clarification", "closed", "rejected"],
        converted: ["closed"], closed: [], rejected: ["new"],
      };
      if (!(FLOW[cur.status] ?? []).includes(to))
        return sendError(res, 400, `${cur.status} → ${to} is not a valid request transition.`);
      fields.push(`status=$${i++}`); vals.push(to);
    }
    if (!fields.length) return res.json({ request: cur });
    fields.push(`updated_at=NOW()`);
    vals.push(id);
    const r = (await pool.query(`UPDATE mo_requests SET ${fields.join(",")} WHERE id=$${i} RETURNING *`, vals)).rows[0];
    await audit(u, b.status !== undefined ? "request.status_changed" : "request.updated", "request", id,
      { status: cur.status }, { status: r.status }, req);
    res.json({ request: r });
  }));

  // Raise a clarification: flips the request and opens a follow-up in one step,
  // so a pending question can never exist without something tracking it.
  app.post(`${P}/requests/:id/clarify`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    if (!(await coordOnly(res, u))) return;
    const id = parseInt(getSingleParam(req.params.id), 10);
    const r = (await pool.query(`SELECT * FROM mo_requests WHERE id=$1`, [id])).rows[0];
    if (!r) return sendError(res, 404, "Request not found.");
    const b = req.body as Record<string, unknown>;
    const subject = String(b.subject ?? "").trim() || "Clarification required";
    await pool.query(`UPDATE mo_requests SET status='needs_clarification', updated_at=NOW() WHERE id=$1`, [id]);
    const f = await pool.query(
      `INSERT INTO mo_followups (request_id, stakeholder, contact, subject, reminder_date, notes, owner_id, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'awaiting_reply') RETURNING *`,
      [id, r.stakeholder, r.contact, subject, (b.reminder_date as string) || null, String(b.notes ?? ""), u.id]);
    await audit(u, "request.clarification_sent", "request", id, null, { subject }, req);
    res.status(201).json({ request_status: "needs_clarification", followup: f.rows[0] });
  }));

  // ── Convert to Project ────────────────────────────────────────────────────
  // Delegates to the SAME project-creation path the Projects module uses, so the
  // template, deliverables, offsets and due dates all behave identically. The
  // coordinator adds only what conversion means: linking the request and handing
  // the project to a Team Lead.
  app.post(`${P}/requests/:id/convert`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    if (!(await coordOnly(res, u))) return;
    const id = parseInt(getSingleParam(req.params.id), 10);
    const r = (await pool.query(`SELECT * FROM mo_requests WHERE id=$1`, [id])).rows[0];
    if (!r) return sendError(res, 404, "Request not found.");
    if (r.status === "converted") return sendError(res, 409, "This request has already been converted.");
    if (!["ready", "under_review"].includes(String(r.status)))
      return sendError(res, 400, "Review the request first — only one marked Under review or Ready can become a project.");
    const b = req.body as Record<string, unknown>;
    const typeId = Number(b.project_type_id ?? r.project_type_id);
    if (!typeId) return sendError(res, 400, "Pick a project type — it decides which template is applied.");
    /* §3 — Operations picks a TEAM, never an individual. The team's lead becomes
       the production owner, which is what routes deliverables, assignments,
       review and notifications. Falling back to a directly-named lead keeps the
       API usable for scripts and for a team that has lost its lead. */
    const teamId = b.team_id ? Number(b.team_id) : (r.team_id ? Number(r.team_id) : null);
    let leadId: string | null = null;
    if (teamId) {
      const t = (await pool.query(
        `SELECT lead_user_id, name FROM mo_teams WHERE id=$1 AND archived_at IS NULL AND is_active`, [teamId])).rows[0];
      if (!t) return sendError(res, 400, "That team does not exist or is archived.");
      if (!t.lead_user_id) return sendError(res, 400, `"${t.name}" has no Team Lead — give it one before routing work to it.`);
      leadId = String(t.lead_user_id);
    } else if (b.lead_user_id) leadId = String(toUid(b.lead_user_id));
    else if (r.lead_user_id) leadId = String(r.lead_user_id);
    const start = (b.start_date as string) || r.event_date || null;
    const end = (b.end_date as string) || r.end_date || r.event_date || null;

    /* §2 — the coordinator creates the operational record; they are Created By and
       nothing more. Production ownership belongs to the Team Lead, and a project
       with no lead is left OWNERLESS (flagged Needs assignment) rather than
       silently landing on the coordinator. */
    const made = await createProjectWithTemplate({
      actor: u, req, name: String(r.event_name), description: String(r.description ?? ""),
      typeId, unitId: r.academic_unit_id ? Number(r.academic_unit_id) : null,
      priority: String(r.priority), start, end,
      ownerId: leadId, venue: (r.venue as string) || null,
      source: "request",
    });

    await pool.query(`UPDATE mo_projects SET source='request' WHERE id=$1`, [made.id]);
    // Hand the project to the Team Lead as PM so review routing lands correctly.
    if (leadId)
      await pool.query(
        `INSERT INTO mo_project_assignments (project_id, user_id, is_project_manager, assigned_by)
         VALUES ($1,$2,true,$3) ON CONFLICT (project_id, user_id) DO UPDATE SET is_project_manager=true`,
        [made.id, leadId, u.id]).catch(() => {/* assignment table may lack the unique — non-fatal */});
    await pool.query(
      `UPDATE mo_requests SET status='converted', project_id=$1, converted_by=$2, converted_at=NOW(),
         lead_user_id=COALESCE($3, lead_user_id), team_id=COALESCE($4, team_id), updated_at=NOW() WHERE id=$5`,
      [made.id, u.id, leadId, teamId, id]);
    await audit(u, "request.converted", "request", id, { status: r.status },
      { status: "converted", project_id: made.id, deliverables_created: made.deliverables }, req);
    if (leadId && leadId !== u.id) {
      await audit(u, "project.lead_assigned", "project", made.id, null, { lead: leadId }, req);
      await pool.query(
        `INSERT INTO mo_notifications (user_id, kind, title, body, entity_type, entity_id)
         VALUES ($1,'assignment',$2,$3,'project',$4)`,
        [leadId, "You are leading a new project",
         `${r.event_name} was converted from request ${r.code ?? id}. ${made.deliverables} deliverable(s) created.`, made.id]);
    }
    res.status(201).json({ project_id: made.id, deliverables_created: made.deliverables });
  }));

  // Assign / change the Team Lead on a converted project.
  app.post(`${P}/requests/:id/lead`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    if (!(await coordOnly(res, u))) return;
    const id = parseInt(getSingleParam(req.params.id), 10);
    const r = (await pool.query(`SELECT * FROM mo_requests WHERE id=$1`, [id])).rows[0];
    if (!r) return sendError(res, 404, "Request not found.");
    const leadId = String(toUid((req.body as Record<string, unknown>).lead_user_id) ?? "");
    if (!leadId) return sendError(res, 400, "lead_user_id is required.");
    await pool.query(`UPDATE mo_requests SET lead_user_id=$1, updated_at=NOW() WHERE id=$2`, [leadId, id]);
    if (r.project_id) {
      await pool.query(`UPDATE mo_projects SET owner_id=$1 WHERE id=$2`, [leadId, r.project_id]);
      await pool.query(
        `INSERT INTO mo_project_assignments (project_id, user_id, is_project_manager, assigned_by)
         VALUES ($1,$2,true,$3) ON CONFLICT DO NOTHING`, [r.project_id, leadId, u.id]);
    }
    await audit(u, "project.lead_assigned", "request", id, { lead: r.lead_user_id }, { lead: leadId }, req);
    res.json({ ok: true });
  }));

  // ── Dispatch queue ────────────────────────────────────────────────────────
  // Approval is the Team Lead's creative verdict; dispatch is the coordinator's
  // operational one. An approved deliverable is QUEUED, never auto-delivered.
  app.post(`${P}/deliverables/:id/dispatch`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    if (!(await coordOnly(res, u))) return;
    const id = parseInt(getSingleParam(req.params.id), 10);
    const d = (await pool.query(`SELECT * FROM mo_deliverables WHERE id=$1`, [id])).rows[0];
    if (!d) return sendError(res, 404, "Deliverable not found.");
    const v = (await pool.query(
      `SELECT review_status, drive_url FROM mo_deliverable_versions WHERE deliverable_id=$1
        ORDER BY version_no DESC LIMIT 1`, [id])).rows[0];
    if (v?.review_status !== "approved")
      return sendError(res, 400, "Only a deliverable whose latest version is approved can be dispatched.");
    const b = req.body as Record<string, unknown>;
    const recipient = String(b.recipient ?? "").trim();
    if (!recipient) return sendError(res, 400, "A recipient is required to record the dispatch.");
    const upd = await pool.query(
      `UPDATE mo_deliverables SET dispatch_status='delivered', dispatch_recipient=$1, dispatch_subject=$2,
         dispatch_notes=$3, dispatched_by=$4, dispatched_at=NOW() WHERE id=$5 RETURNING *`,
      [recipient, String(b.subject ?? ""), String(b.notes ?? ""), u.id, id]);
    await audit(u, "deliverable.dispatched", "deliverable", id,
      { dispatch_status: d.dispatch_status },
      { dispatch_status: "delivered", recipient, drive_url: v.drive_url ?? null, subject: String(b.subject ?? "") }, req);
    if (d.owner_id && d.owner_id !== u.id)
      await pool.query(
        `INSERT INTO mo_notifications (user_id, kind, title, body, entity_type, entity_id)
         VALUES ($1,'deliverable',$2,$3,'deliverable',$4)`,
        [d.owner_id, "Your deliverable was dispatched", `${d.title} was sent to ${recipient}.`, id]);
    res.json({ deliverable: upd.rows[0] });
  }));

  // Archive a delivered item — the operational close.
  app.post(`${P}/deliverables/:id/archive`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    if (!(await coordOnly(res, u))) return;
    const id = parseInt(getSingleParam(req.params.id), 10);
    const d = (await pool.query(`SELECT dispatch_status FROM mo_deliverables WHERE id=$1`, [id])).rows[0];
    if (!d) return sendError(res, 404, "Deliverable not found.");
    if (d.dispatch_status !== "delivered")
      return sendError(res, 400, "Only a delivered deliverable can be archived.");
    await pool.query(`UPDATE mo_deliverables SET dispatch_status='archived' WHERE id=$1`, [id]);
    await audit(u, "deliverable.archived", "deliverable", id, { dispatch_status: "delivered" }, { dispatch_status: "archived" }, req);
    res.json({ ok: true });
  }));

  // Copying the Drive link is an operational act worth recording — it is how a
  // stakeholder handover starts, and the archive should show it happened.
  app.post(`${P}/deliverables/:id/link-copied`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    if (!(await coordOnly(res, u))) return;
    const id = parseInt(getSingleParam(req.params.id), 10);
    await audit(u, "deliverable.link_copied", "deliverable", id, null, {}, req);
    res.json({ ok: true });
  }));

  // ── Coordination logs: meetings, vendor activity, follow-ups ──────────────
  const logRoutes: Array<[string, string, string[], string]> = [
    ["meetings", "mo_meetings",
      ["kind", "stakeholder", "vendor_id", "project_id", "request_id", "purpose", "meet_date", "meet_time",
       "duration_min", "location", "outcome", "next_action", "notes", "status"], "meeting"],
    ["vendor-activities", "mo_vendor_activities",
      ["vendor_id", "project_id", "kind", "purpose", "amount", "status", "notes", "activity_date"], "vendor_activity"],
    ["followups", "mo_followups",
      ["request_id", "project_id", "vendor_id", "stakeholder", "contact", "subject", "pending_since",
       "reminder_date", "status", "notes"], "followup"],
  ];
  for (const [path, table, cols, entity] of logRoutes) {
    const stamp = table === "mo_followups" ? "owner_id" : "logged_by";
    app.post(`${P}/${path}`, asyncHandler(async (req, res) => {
      const u = requireMedia(res); if (!u) return;
      if (!(await coordOnly(res, u))) return;
      const b = req.body as Record<string, unknown>;
      const names: string[] = [], vals: unknown[] = [];
      for (const c of cols) if (b[c] !== undefined && b[c] !== "") { names.push(c); vals.push(b[c]); }
      names.push(stamp); vals.push(u.id);
      const ins = await pool.query(
        `INSERT INTO ${table} (${names.map((n) => `"${n}"`).join(",")})
         VALUES (${names.map((_, i) => "$" + (i + 1)).join(",")}) RETURNING *`, vals);
      await audit(u, `${entity}.logged`, entity, ins.rows[0].id, null, ins.rows[0], req);
      res.status(201).json({ row: ins.rows[0] });
    }));
    app.patch(`${P}/${path}/:id`, asyncHandler(async (req, res) => {
      const u = requireMedia(res); if (!u) return;
      if (!(await coordOnly(res, u))) return;
      const id = parseInt(getSingleParam(req.params.id), 10);
      const b = req.body as Record<string, unknown>;
      const fields: string[] = [], vals: unknown[] = []; let i = 1;
      for (const c of cols) if (b[c] !== undefined) { fields.push(`"${c}"=$${i++}`); vals.push(b[c] === "" ? null : b[c]); }
      if (table === "mo_followups" && b.status !== undefined) { fields.push(`last_contact_at=NOW()`); }
      if (!fields.length) return sendError(res, 400, "Nothing to update.");
      vals.push(id);
      const r = (await pool.query(`UPDATE ${table} SET ${fields.join(",")} WHERE id=$${i} RETURNING *`, vals)).rows[0];
      if (!r) return sendError(res, 404, "Not found.");
      await audit(u, `${entity}.updated`, entity, id, null, r, req);
      res.json({ row: r });
    }));
  }

  // ═══════════════ ORGANIZATION MANAGEMENT — Teams as master data ═══════════
  // Team → Teams & duties is the single source of truth for org structure. Every
  // consumer (dashboards, Assign Work, filters, review routing, leave approval)
  // already resolves people through mo_teams.lead_user_id / mo_team_members, so
  // changing a team here propagates platform-wide with no second write.
  // Admin only: org structure decides who reviews whom.
  const teamAdmin = (res: express.Response, u: CurrentUser): boolean => {
    if (isMoAdmin(u)) return true;
    sendError(res, 403, "Only an Admin may manage the organization structure.");
    return false;
  };
  /* One lead → one team, unless the Admin explicitly overrides (§7). */
  async function leadClash(leadId: string, exceptTeam: number | null): Promise<string | null> {
    const { rows } = await pool.query(
      `SELECT name FROM mo_teams WHERE lead_user_id=$1 AND archived_at IS NULL AND is_active
        ${exceptTeam ? "AND id<>$2" : ""} LIMIT 1`,
      exceptTeam ? [leadId, exceptTeam] : [leadId]);
    return rows[0]?.name ?? null;
  }
  /* A member belongs to exactly one primary team, so joining one leaves the other. */
  async function setMembership(teamId: number, userId: string): Promise<void> {
    await pool.query(`DELETE FROM mo_team_members WHERE user_id=$1`, [userId]);
    await pool.query(`INSERT INTO mo_team_members (team_id, user_id, is_primary) VALUES ($1,$2,true)
                      ON CONFLICT DO NOTHING`, [teamId, userId]);
  }
  /* §12 — leading a team IS the Team Lead role here: review routing, leave
     approval and dashboard scope all key off it. Promote an employee the moment
     they are handed a team so the transfer needs no second step. Admins are left
     alone, and nobody is auto-demoted — a former lead may still run another team,
     and withdrawing someone's access is a deliberate act, not a side effect. */
  async function promoteToLead(actor: CurrentUser, userId: string, req: express.Request): Promise<boolean> {
    const cur = (await pool.query(`SELECT role FROM users WHERE id=$1`, [userId])).rows[0];
    if (!cur || cur.role !== "user") return false;
    await pool.query(`UPDATE users SET role='sub_admin' WHERE id=$1`, [userId]);
    await pool.query(`UPDATE mo_user_profiles SET mo_role='team_lead' WHERE user_id=$1`, [userId]);
    await audit(actor, "crew.role_changed", "user", null, { id: userId, role: "user" },
      { id: userId, role: "sub_admin", reason: "given a team to lead" }, req);
    return true;
  }

  app.post(`${P}/teams`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    if (!teamAdmin(res, u)) return;
    const b = req.body as Record<string, unknown>;
    const name = String(b.name ?? "").trim();
    if (!name) return sendError(res, 400, "Team name is required.");
    const leadId = String(toUid(b.lead_user_id) ?? "");
    if (!leadId) return sendError(res, 400, "Every team needs exactly one Team Lead.");
    if (!(await pool.query(`SELECT 1 FROM users WHERE id=$1 AND team='media'`, [leadId])).rows[0])
      return sendError(res, 400, "That Team Lead is not a member of the media crew.");
    if (!b.allow_multi_lead) {
      const clash = await leadClash(leadId, null);
      if (clash) return sendError(res, 409,
        `That person already leads "${clash}". A lead runs one team by default — re-send with allow_multi_lead to override.`);
    }
    if ((await pool.query(`SELECT 1 FROM mo_teams WHERE lower(name)=lower($1) AND archived_at IS NULL`, [name])).rows[0])
      return sendError(res, 409, `A team called "${name}" already exists.`);
    const next = (await pool.query(`SELECT COALESCE(MAX(sort_order),0)+1 AS n FROM mo_teams`)).rows[0].n;
    const t = (await pool.query(
      `INSERT INTO mo_teams (department_id, name, lead_user_id, is_active, description, color, icon, sort_order)
       VALUES ((SELECT id FROM mo_departments ORDER BY id LIMIT 1),$1,$2,true,$3,$4,$5,$6) RETURNING *`,
      [name, leadId, String(b.description ?? "") || null, (b.color as string) || null, (b.icon as string) || null, next])).rows[0];
    const promoted = await promoteToLead(u, leadId, req);
    // The lead's own membership is implicit; only explicit members are stored.
    for (const raw of (Array.isArray(b.members) ? b.members : []))
      await setMembership(Number(t.id), String(toUid(raw)));
    await audit(u, "team.created", "team", t.id, null, { name, lead: leadId }, req);
    res.status(201).json({ team: t, promoted_lead: promoted });
  }));

  app.patch(`${P}/teams/:id`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    if (!teamAdmin(res, u)) return;
    const id = parseInt(getSingleParam(req.params.id), 10);
    const cur = (await pool.query(`SELECT * FROM mo_teams WHERE id=$1`, [id])).rows[0];
    if (!cur) return sendError(res, 404, "Team not found.");
    const b = req.body as Record<string, unknown>;
    const fields: string[] = [], vals: unknown[] = []; let i = 1; let promoted = false;
    if (b.name !== undefined) {
      const name = String(b.name).trim();
      if (!name) return sendError(res, 400, "Team name cannot be empty.");
      if ((await pool.query(`SELECT 1 FROM mo_teams WHERE lower(name)=lower($1) AND id<>$2 AND archived_at IS NULL`, [name, id])).rows[0])
        return sendError(res, 409, `A team called "${name}" already exists.`);
      fields.push(`name=$${i++}`); vals.push(name);
    }
    if (b.lead_user_id !== undefined) {
      const leadId = String(toUid(b.lead_user_id) ?? "");
      if (!leadId) return sendError(res, 400, "Every team needs exactly one Team Lead.");
      if (!(await pool.query(`SELECT 1 FROM users WHERE id=$1 AND team='media'`, [leadId])).rows[0])
        return sendError(res, 400, "That Team Lead is not a member of the media crew.");
      if (!b.allow_multi_lead) {
        const clash = await leadClash(leadId, id);
        if (clash) return sendError(res, 409,
          `That person already leads "${clash}". A lead runs one team by default — re-send with allow_multi_lead to override.`);
      }
      // A lead cannot also sit in the member list of the team they run.
      await pool.query(`DELETE FROM mo_team_members WHERE team_id=$1 AND user_id=$2`, [id, leadId]);
      if (leadId !== cur.lead_user_id) promoted = await promoteToLead(u, leadId, req);
      fields.push(`lead_user_id=$${i++}`); vals.push(leadId);
    }
    for (const [k, col] of [["description", "description"], ["color", "color"], ["icon", "icon"]] as const)
      if (b[k] !== undefined) { fields.push(`${col}=$${i++}`); vals.push(String(b[k] ?? "") || null); }
    if (b.is_active !== undefined) { fields.push(`is_active=$${i++}`); vals.push(!!b.is_active); }
    if (b.archived !== undefined) { fields.push(`archived_at=$${i++}`); vals.push(b.archived ? new Date() : null); }
    if (!fields.length) return res.json({ team: cur });
    vals.push(id);
    const t = (await pool.query(`UPDATE mo_teams SET ${fields.join(",")} WHERE id=$${i} RETURNING *`, vals)).rows[0];
    await audit(u, "team.updated", "team", id,
      { name: cur.name, lead_user_id: cur.lead_user_id, archived_at: cur.archived_at },
      { name: t.name, lead_user_id: t.lead_user_id, archived_at: t.archived_at }, req);
    res.json({ team: t, promoted_lead: promoted });
  }));

  // Delete a team. Members are NEVER silently dropped: the caller must say where
  // they go — another team, or unassigned.
  app.delete(`${P}/teams/:id`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    if (!teamAdmin(res, u)) return;
    const id = parseInt(getSingleParam(req.params.id), 10);
    const t = (await pool.query(`SELECT * FROM mo_teams WHERE id=$1`, [id])).rows[0];
    if (!t) return sendError(res, 404, "Team not found.");
    const members = (await pool.query(`SELECT user_id FROM mo_team_members WHERE team_id=$1`, [id])).rows;
    const moveTo = (req.query.reassign_to ?? (req.body as Record<string, unknown>)?.reassign_to) as string | undefined;
    if (members.length && moveTo === undefined)
      return sendError(res, 409,
        `"${t.name}" has ${members.length} member(s). Send reassign_to=<teamId> to move them, or reassign_to="" to leave them unassigned.`);
    if (moveTo) {
      const dest = parseInt(String(moveTo), 10);
      if (dest === id) return sendError(res, 400, "Pick a different team to move members into.");
      if (!(await pool.query(`SELECT 1 FROM mo_teams WHERE id=$1 AND archived_at IS NULL`, [dest])).rows[0])
        return sendError(res, 400, "The destination team does not exist.");
      for (const m of members) await setMembership(dest, String(m.user_id));
    }
    // Anything still attached goes with the row (FK cascade) — by now it is empty
    // or the Admin explicitly chose to leave those people unassigned.
    await pool.query(`DELETE FROM mo_teams WHERE id=$1`, [id]);
    await audit(u, "team.deleted", "team", id, { name: t.name, members: members.length },
      { moved_to: moveTo ? Number(moveTo) : null }, req);
    res.json({ ok: true, moved: moveTo ? members.length : 0, unassigned: moveTo ? 0 : members.length });
  }));

  app.post(`${P}/teams/:id/members`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    if (!teamAdmin(res, u)) return;
    const id = parseInt(getSingleParam(req.params.id), 10);
    const t = (await pool.query(`SELECT * FROM mo_teams WHERE id=$1`, [id])).rows[0];
    if (!t) return sendError(res, 404, "Team not found.");
    const uid = String(toUid((req.body as Record<string, unknown>).user_id) ?? "");
    if (!uid) return sendError(res, 400, "user_id is required.");
    if (uid === t.lead_user_id) return sendError(res, 400, "That person already leads this team.");
    await setMembership(id, uid);
    await audit(u, "team.member_added", "team", id, null, { member: uid }, req);
    res.json({ ok: true });
  }));

  app.delete(`${P}/teams/:id/members/:uid`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    if (!teamAdmin(res, u)) return;
    const id = parseInt(getSingleParam(req.params.id), 10);
    const uid = String(toUid(getSingleParam(req.params.uid)) ?? "");
    await pool.query(`DELETE FROM mo_team_members WHERE team_id=$1 AND user_id=$2`, [id, uid]);
    await audit(u, "team.member_removed", "team", id, { member: uid }, null, req);
    res.json({ ok: true });
  }));

  // Drag-and-drop ordering — the order teams appear in everywhere.
  app.post(`${P}/teams/reorder`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    if (!teamAdmin(res, u)) return;
    const ids = (req.body as Record<string, unknown>).ids;
    if (!Array.isArray(ids)) return sendError(res, 400, "ids[] is required.");
    for (let n = 0; n < ids.length; n++)
      await pool.query(`UPDATE mo_teams SET sort_order=$1 WHERE id=$2`, [n + 1, Number(ids[n])]);
    await audit(u, "team.reordered", "team", null, null, { ids }, req);
    res.json({ ok: true });
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
    leave_types: { table: "mo_leave_types", fields: ["name", "notes"] },
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
    // H2: photo is optional — initials avatar is the fallback (bulk onboarding).
    const role = ({ admin: "admin", team_lead: "sub_admin", employee: "user", coordinator: "user" } as Record<string, string>)[String(b.role)] ?? "user";
    const exists = await pool.query(`SELECT 1 FROM users WHERE email=$1`, [email]);
    if (exists.rows[0]) return sendError(res, 409, "A user with that email already exists.");
    const id = `u-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const pw = await hashPassword(String(b.password));
    await pool.query(
      `INSERT INTO users (id, full_name, email, department, role, team, password_hash, email_verified, avatar_url)
       VALUES ($1,$2,$3,'Media Crew',$4,'media',$5,true,$6)`,
      [id, String(b.full_name ?? "New Member").trim() || "New Member", email, role, pw, (b.avatar_url as string) || null]);
    // 1.2 — default module sets per role, applied when no explicit selection is
    // made: onboarding must not depend on remembering ten checkboxes, and a missed
    // tick must never silently remove a right §16 grants.
    // Keys mirror the sidebar one-for-one (route minus '#/media/'), so these sets
    // are the sidebar an employee / team lead sees. Keep in step with NAV in
    // public/media-ops/index.html, which is the source these are projected from.
    const ROLE_DEFAULT_MODULES: Record<string, string[] | null> = {
      user: ["home", "my-day", "projects", "pipeline", "reports", "library", "equipment",
             "calendar", "leave", "kra", "performance", "ai", "kiosk"],
      sub_admin: ["home", "my-day", "projects", "pipeline", "reports", "boards", "library", "equipment",
                  "calendar", "team", "leave", "analytics", "kra", "performance", "ai", "kiosk"],
      admin: null,   // unrestricted
    };
    const mods = Array.isArray(b.allowed_modules) && (b.allowed_modules as unknown[]).length
      ? JSON.stringify(b.allowed_modules)
      : (ROLE_DEFAULT_MODULES[role] ? JSON.stringify(ROLE_DEFAULT_MODULES[role]) : null);
    await pool.query(`INSERT INTO mo_user_profiles (user_id, designation, mo_role, allowed_modules, campus_id) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
      [id, String(b.designation ?? ""),
       // an explicit coordinator request wins; otherwise derive from the platform role
       String(b.role) === "coordinator" ? "coordinator"
         : ({ admin: "admin", sub_admin: "team_lead", user: "employee" } as Record<string, string>)[role], mods,
       b.campus_id ? Number(b.campus_id) : null]);
    // H3: optional primary team (lead) + skills at creation.
    if (b.lead_user_id) {
      const leadId = String(b.lead_user_id);
      let team = (await pool.query(`SELECT id FROM mo_teams WHERE lead_user_id=$1 AND is_active LIMIT 1`, [leadId])).rows[0];
      if (!team) {
        const lead = (await pool.query(`SELECT full_name FROM users WHERE id=$1`, [leadId])).rows[0];
        team = (await pool.query(`INSERT INTO mo_teams (department_id, name, lead_user_id, is_active) VALUES (1,$1,$2,true) RETURNING id`,
          [`${lead?.full_name ?? "Team"}'s team`, leadId])).rows[0];
      }
      await pool.query(`INSERT INTO mo_team_members (team_id, user_id, is_primary) VALUES ($1,$2,true) ON CONFLICT DO NOTHING`, [team.id, id]);
    }
    if (Array.isArray(b.skills))
      for (const s of b.skills as Array<Record<string, unknown>>)
        if (s.skill_id) await pool.query(
          `INSERT INTO mo_user_skills (user_id, skill_id, proficiency, certified_until) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
          [id, Number(s.skill_id), Math.min(5, Math.max(1, Number(s.proficiency) || 3)), (s.certified_until as string) || null]);
    await audit(u, "crew.added", "user", null, null, { email, role, allowed_modules: b.allowed_modules ?? null }, req);
    res.status(201).json({ ok: true, id, email, role });
  }));

  // H4 — edit an existing member (name, email, designation, campus). Admin only.
  app.patch(`${P}/crew/:id`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    if (!isMoAdmin(u)) return sendError(res, 403, "Only Admin may edit members.");
    const realId = getSingleParam(req.params.id);
    const b = req.body as Record<string, unknown>;
    const cur = (await pool.query(`SELECT id, full_name, email FROM users WHERE id=$1 AND team='media'`, [realId])).rows[0];
    if (!cur) return sendError(res, 404, "Member not found.");
    if (typeof b.full_name === "string" && b.full_name.trim())
      await pool.query(`UPDATE users SET full_name=$1 WHERE id=$2`, [b.full_name.trim(), realId]);
    if (typeof b.email === "string" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b.email.trim())) {
      const clash = await pool.query(`SELECT 1 FROM users WHERE email=$1 AND id<>$2`, [b.email.trim().toLowerCase(), realId]);
      if (clash.rows[0]) return sendError(res, 409, "That email is already in use.");
      await pool.query(`UPDATE users SET email=$1 WHERE id=$2`, [b.email.trim().toLowerCase(), realId]);
    }
    if ("designation" in b || "campus_id" in b)
      await pool.query(
        `INSERT INTO mo_user_profiles (user_id, designation, campus_id) VALUES ($1,$2,$3)
         ON CONFLICT (user_id) DO UPDATE SET designation=COALESCE(NULLIF($2,''), mo_user_profiles.designation),
           campus_id=COALESCE($3, mo_user_profiles.campus_id)`,
        [realId, String(b.designation ?? ""), b.campus_id ? Number(b.campus_id) : null]);
    await audit(u, "crew.edited", "user", null, cur, b, req);
    res.json({ ok: true });
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
    // Changing the academic unit may only target an active, non-archived unit.
    // Leaving it untouched keeps a historical (possibly archived) reference intact.
    if ("academic_unit_id" in b && b.academic_unit_id != null &&
        Number(b.academic_unit_id) !== Number(cur.academic_unit_id)) {
      const au = (await pool.query(`SELECT is_active, archived_at FROM mo_academic_units WHERE id=$1`, [Number(b.academic_unit_id)])).rows[0];
      if (!au) return sendError(res, 400, "Unknown academic unit.");
      if (!au.is_active || au.archived_at) return sendError(res, 400, "That academic unit is archived or disabled — pick an active one.");
    }
    const fields: string[] = [], vals: unknown[] = []; let i = 1;
    for (const k of ["name", "description", "academic_unit_id", "priority", "start_date", "end_date", "cover_image_url", "academic_year_id"])
      if (k in b) { fields.push(`${k}=$${i++}`); vals.push(b[k]); }
    if (!fields.length) return res.json({ project: cur });
    vals.push(id);
    const { rows } = await pool.query(`UPDATE mo_projects SET ${fields.join(",")} WHERE id=$${i} RETURNING *`, vals);
    // §9: moving the project dates re-derives due dates ONLY for deliverables
    // still tracking their offset. Hand-edited dates ('manual') are left alone.
    let recalculated = 0;
    if ("end_date" in b && rows[0].end_date && String(rows[0].end_date) !== String(cur.end_date)) {
      const r = await pool.query(
        `UPDATE mo_deliverables
            SET due_date = ($1::date + COALESCE(due_offset_days,0) * INTERVAL '1 day')::date, updated_at=NOW()
          WHERE project_id=$2 AND due_date_source='offset' AND deleted_at IS NULL
          RETURNING id`, [rows[0].end_date, id]);
      recalculated = r.rowCount ?? 0;
      if (recalculated)
        await audit(u, "project.due_dates_recalculated", "project", id,
          { end_date: dOnly(cur.end_date) },
          { end_date: dOnly(rows[0].end_date), deliverables_updated: recalculated }, req);
    }
    await audit(u, "project.updated", "project", id, cur, rows[0], req);
    res.json({ project: rows[0], due_dates_recalculated: recalculated });
  }));

  // Leave replacement (FR-10.3 / §13 POST /leave/:id/replacements). Same
  // approval hierarchy as the decision itself — you cannot arrange cover for a
  // request you have no authority to decide.
  app.post(`${P}/leave/:id/replacements`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    const lid = parseInt(getSingleParam(req.params.id), 10);
    const b = req.body as Record<string, unknown>;
    const shootId = Number(b.shoot_id), repl = String(b.replacement_user_id ?? "");
    const lr = (await pool.query(`SELECT user_id FROM mo_leave_requests WHERE id=$1`, [lid])).rows[0];
    if (!lr) return sendError(res, 404, "Leave request not found.");
    const denied = await canDecideLeaveFor(u, String(lr.user_id));
    if (denied) return sendError(res, 403, denied);
    if (!shootId || !repl) return sendError(res, 400, "shoot_id and replacement_user_id are required.");
    await pool.query(`INSERT INTO mo_leave_replacements (leave_request_id, shoot_id, replacement_user_id) VALUES ($1,$2,$3)`, [lid, shootId, repl]);
    await pool.query(`INSERT INTO mo_shoot_crew (shoot_id, user_id, capacity_role_id, is_replacement, replaced_user_id)
                      VALUES ($1,$2,2,true,$3) ON CONFLICT DO NOTHING`, [shootId, repl, lr.user_id]);
    await audit(u, "leave.replacement_assigned", "shoot", shootId, null, { leave: lid, replacement: repl }, req);
    res.status(201).json({ ok: true });
  }));

  // Admin audit browser (FR-13.3) — read the real append-only mo_audit_logs.
  /* A user's OWN action history. Not privileged — it is a record of what the
     caller themselves did — so it needs no admin gate. The Operations
     Coordinator's activity timeline and auto-generated daily report are both
     built from this, which is why neither can drift from what actually happened. */
  app.get(`${P}/my-activity`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    const day = String((req.query as Record<string, unknown>).day ?? "");
    const { rows } = await pool.query(
      `SELECT id, actor_id, action, entity_type, entity_id, before, after, occurred_at
         FROM mo_audit_logs
        WHERE actor_id=$1 ${day ? "AND occurred_at::date = $2::date" : ""}
        ORDER BY occurred_at DESC LIMIT 300`,
      day ? [u.id, day] : [u.id]);
    res.json({ audit: rows });
  }));

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
    if (!(await assertAssignable(res, u, assignees))) return;
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
    // Module keys mirror the sidebar one-for-one, so KRA cycles gate on 'kra'
    // (its own sidebar entry) rather than on the Performance module.
    if (!(await requireModule(res, u, "kra"))) return;
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
    template_deliverables: { key: "template_deliverables", label: "Template Items", table: "mo_template_deliverables",
      fields: [
        { name: "template_id", label: "Template", type: "relation", required: true, relation: { module: "project_templates", labelCol: "name" } },
        { name: "deliverable_type_id", label: "Deliverable type", type: "relation", required: true, relation: { module: "deliverable_types", labelCol: "name" } },
        { name: "title_pattern", label: "Title pattern ({project} substitutes)", type: "text", required: true },
        { name: "default_weight", label: "Weight", type: "number", def: 1 },
        { name: "days_offset_due", label: "Due offset (days after project end)", type: "number", def: 5 }],
      cols: ["template_id", "deliverable_type_id", "title_pattern", "default_weight", "days_offset_due"],
      deps: [] },
    deliverable_types: { key: "deliverable_types", label: "Deliverable Types", table: "mo_deliverable_types",
      fields: [
        { name: "name", label: "Name", type: "text", required: true },
        { name: "slug", label: "Slug", type: "slug" },
        { name: "icon", label: "Icon", type: "icon" },
        { name: "default_weight", label: "Default weight", type: "number", def: 1 },
        { name: "default_unit", label: "Default unit", type: "text" },
        { name: "review_exempt", label: "Review exempt (BR-6)", type: "switch", def: false },
        { name: "default_due_offset_days", label: "Default due offset (days after project end)", type: "number", def: 5 },
        { name: "sort_order", label: "Sort order", type: "number", def: 0 }],
      cols: ["name", "icon", "default_weight", "default_unit", "default_due_offset_days"],
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
        { name: "notes", label: "Notes", type: "text" }],
      cols: ["name", "notes"],
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
    casting_tags: { key: "casting_tags", label: "Casting Tags", table: "mo_casting_tags",
      fields: [
        { name: "name", label: "Name", type: "text", required: true },
        { name: "category", label: "Category", type: "select",
          options: ["profession", "production_type", "age_group", "language", "requirement", "other"],
          def: "other", required: true },
        { name: "description", label: "Description", type: "text" },
        { name: "sort_order", label: "Sort order", type: "number", def: 0 }],
      cols: ["name", "category", "description", "sort_order"],
      // A tag already on a record is archived, never deleted — historical casting
      // records must keep reading the same way.
      deps: [{ table: "mo_casting_record_tags", fk: "tag_id", label: "Casting records" }] },
    casting_collections: { key: "casting_collections", label: "Casting Collections", table: "mo_casting_collections",
      fields: [
        { name: "name", label: "Name", type: "text", required: true },
        { name: "description", label: "Description", type: "text" },
        { name: "sort_order", label: "Sort order", type: "number", def: 0 }],
      cols: ["name", "description", "sort_order"],
      deps: [{ table: "mo_casting_record_collections", fk: "collection_id", label: "Casting records" }] },
    work_types: { key: "work_types", label: "Work Types", table: "mo_work_types",
      fields: [
        { name: "name", label: "Name", type: "text", required: true },
        { name: "icon", label: "Icon", type: "icon" },
        { name: "form_template", label: "Form template", type: "select",
          options: ["standard_task", "shoot"], def: "standard_task", required: true },
        { name: "slug", label: "Slug", type: "slug" },
        { name: "sort_order", label: "Sort order", type: "number", def: 0 }],
      cols: ["name", "icon", "form_template", "sort_order"],
      // Referenced by both record kinds → delete refused once in use; archive instead.
      deps: [{ table: "mo_shoots", fk: "work_type_id", label: "Shoots" },
             { table: "mo_assignments", fk: "work_type_id", label: "Assigned tasks" }] },
    academic_units: { key: "academic_units", label: "Academic Units", table: "mo_academic_units",
      fields: [
        { name: "name", label: "Name", type: "text", required: true },
        { name: "short_name", label: "Short name", type: "text" },
        { name: "slug", label: "Slug", type: "slug" },
        { name: "notes", label: "Notes", type: "textarea" },
        { name: "sort_order", label: "Sort order", type: "number", def: 0 }],
      cols: ["name", "short_name", "slug", "sort_order"],
      // Referenced by projects → delete is refused (409) once in use; archive instead.
      deps: [{ table: "mo_projects", fk: "academic_unit_id", label: "Projects" }] },
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
    // Force Delete is reserved for the platform Super Admin (raw role, not the
    // media-ops role mapping — a media 'admin' does NOT qualify).
    (can as Record<string, unknown>).force = u.role === "super_admin";
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
    if (q.created_by) { conds.push(`created_by=$${i++}`); vals.push(String(q.created_by)); }
    if (q.created_from) { conds.push(`created_at>=$${i++}`); vals.push(String(q.created_from)); }
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

  // Force Delete — SUPER ADMIN ONLY. Requires the literal confirmation "DELETE".
  // Nulls out references where the FK is nullable, deletes child rows where it
  // isn't, then removes the record. Fully audited with the impact summary.
  app.post(`${P}/crud/:module/:id/force-delete`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    if (u.role !== "super_admin") return sendError(res, 403, "Force Delete is available only to the Super Admin.");
    if (String((req.body as Record<string, unknown>).confirm) !== "DELETE")
      return sendError(res, 400, 'Type DELETE to confirm this high-risk action.');
    const m = crudMod(res, getSingleParam(req.params.module)); if (!m) return;
    const id = parseInt(getSingleParam(req.params.id), 10);
    const cur = (await pool.query(`SELECT * FROM ${m.table} WHERE id=$1`, [id])).rows[0];
    if (!cur) return sendError(res, 404, "Record not found.");
    const impact = await crudDeps(m, id);
    const cleaned: Record<string, string> = {};
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const d of m.deps) {
        // Nullable FK → references become NULL; NOT NULL → referencing rows are removed.
        const nullable = (await client.query(
          `SELECT is_nullable FROM information_schema.columns WHERE table_name=$1 AND column_name=$2`,
          [d.table, d.fk])).rows[0]?.is_nullable === "YES";
        if (nullable) {
          await client.query(`UPDATE ${d.table} SET ${d.fk}=NULL WHERE ${d.fk}=$1`, [id]);
          cleaned[d.label] = "references set to NULL";
        } else {
          await client.query(`DELETE FROM ${d.table} WHERE ${d.fk}=$1`, [id]);
          cleaned[d.label] = "referencing rows deleted";
        }
      }
      await client.query(`DELETE FROM ${m.table} WHERE id=$1`, [id]);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
      return sendError(res, 409, `Force delete failed — a deeper reference blocks it: ${(e as Error).message}`);
    }
    client.release();
    await audit(u, "crud.force_deleted", m.key, id, cur, { impact, cleaned, confirmed: true }, req);
    res.json({ ok: true, impact, cleaned });
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

  // ═══════════════════════════════════════════════════════════════════════════
  // SMC — Social Media Council (institute-level coverage network)
  // ═══════════════════════════════════════════════════════════════════════════
  // Built on mo_projects (the event), mo_assignments (the assignment),
  // mo_academic_units (the institute) and mo_notifications/mo_audit_logs, so
  // Central Media keeps one source of truth and SMC coverage is never invisible
  // to it. Only the SMC-specific lifecycle and the submission history are new.

  const smcNotify = async (userId: string, kind: string, title: string, body: string, asgId: number) => {
    try {
      await pool.query(
        `INSERT INTO mo_notifications (user_id, kind, title, body, entity_type, entity_id)
         VALUES ($1,$2,$3,$4,'smc_assignment',$5)`, [userId, kind, title, body, asgId]);
    } catch { /* notification failure must never break the workflow */ }
  };

  /** The SMC member on an assignment (mo_assignment_users, reused as-is). */
  const smcAssignee = async (asgId: number): Promise<string | null> => {
    const r = (await pool.query(
      `SELECT user_id FROM mo_assignment_users WHERE assignment_id=$1 LIMIT 1`, [asgId])).rows[0];
    return r ? String(r.user_id) : null;
  };

  /* One shared SELECT so member and management views can never disagree about
     what an assignment is. Event data is joined from the project — never copied. */
  const SMC_SELECT = `
    SELECT a.id, a.title, a.priority,
           -- A DATE becomes local midnight in the driver and then serialises to
           -- UTC, which moves it to the previous day anywhere east of Greenwich.
           -- Send the calendar date as text so the client reads what was stored.
           to_char(a.start_date,'YYYY-MM-DD') AS start_date,
           a.start_time, a.end_time, a.venue,
           a.coverage_requirements, a.deliverables_required, a.submission_deadline,
           a.smc_status, a.notes, a.accepted_at, a.started_at, a.cancelled_at, a.cancel_reason,
           a.escalated_at, a.escalation_reason, a.escalation_status, a.assigned_by,
           a.project_id, p.name AS event_name, p.event_level,
           u.id AS unit_id, u.name AS institute,
           ab.full_name AS assigned_by_name,
           au.user_id AS member_id, mu.full_name AS member_name,
           s.id AS submission_id, s.attempt, s.drive_url, s.photos_url, s.media_library_url,
           s.reference_url, s.note AS submission_note, s.photo_count, s.video_count,
           s.submitted_at, s.review_status, s.review_feedback, s.reviewed_at,
           rv.full_name AS reviewed_by_name
      FROM mo_assignments a
      LEFT JOIN mo_projects p        ON p.id = a.project_id
      LEFT JOIN mo_academic_units u  ON u.id = COALESCE(a.academic_unit_id, p.academic_unit_id)
      LEFT JOIN users ab             ON ab.id = a.assigned_by
      LEFT JOIN mo_assignment_users au ON au.assignment_id = a.id
      LEFT JOIN users mu             ON mu.id = au.user_id
      LEFT JOIN LATERAL (
        SELECT * FROM mo_smc_submissions WHERE assignment_id = a.id
         ORDER BY attempt DESC LIMIT 1) s ON true
      LEFT JOIN users rv             ON rv.id = s.reviewed_by
     WHERE a.is_smc = true`;

  // ── SMC MEMBER ────────────────────────────────────────────────────────────

  /* §7/§32 — everything the member must act on, ordered by what is most urgent:
     revision-required first, then today chronologically, then overdue, then
     upcoming. Scoped to the caller: an SMC member can only ever read their own
     assignments (§42), enforced by the join on their own id. */
  app.get(`${P}/smc/my-day`, asyncHandler(async (_req, res) => {
    const u = res.locals.currentUser as CurrentUser;
    if (!(await isSmcMember(u))) return sendError(res, 403, "SMC access only.");
    const { rows } = await pool.query(`${SMC_SELECT} AND au.user_id = $1
       ORDER BY
         CASE WHEN a.smc_status = 'revision_required' THEN 0
              WHEN a.start_date = CURRENT_DATE THEN 1
              WHEN a.start_date < CURRENT_DATE AND a.smc_status NOT IN ('reviewed','cancelled') THEN 2
              ELSE 3 END,
         a.start_date, a.start_time NULLS LAST`, [u.id]);
    const prof = (await pool.query(
      `SELECT p.*, un.name AS institute FROM mo_smc_profiles p
         LEFT JOIN mo_academic_units un ON un.id = p.academic_unit_id
        WHERE p.user_id=$1`, [u.id])).rows[0] ?? null;
    res.json({ profile: prof, assignments: rows });
  }));

  /* Ownership gate for every member action: the assignment must exist, be SMC,
     belong to THIS member, and not be cancelled. Returns a message rather than
     leaking whether someone else's assignment exists (§42, §50). */
  async function ownAssignment(u: CurrentUser, id: number):
    Promise<{ row: Record<string, unknown> } | { err: [number, string] }> {
    const r = (await pool.query(
      `SELECT a.*, au.user_id AS member_id FROM mo_assignments a
         LEFT JOIN mo_assignment_users au ON au.assignment_id=a.id
        WHERE a.id=$1 AND a.is_smc=true`, [id])).rows[0];
    if (!r) return { err: [404, "That assignment could not be found."] };
    if (String(r.member_id ?? "") !== u.id) return { err: [403, "That assignment is not yours."] };
    if (r.smc_status === "cancelled") return { err: [409, "This assignment has been cancelled."] };
    return { row: r };
  }

  const smcTransition = (from: string, to: string): boolean => {
    const ok: Record<string, string[]> = {
      assigned: ["accepted"],
      accepted: ["in_progress", "submitted"],
      in_progress: ["submitted"],
      revision_required: ["submitted"],
    };
    return (ok[from] ?? []).includes(to);
  };

  // §9 accept / §10 start — one handler, since they differ only in the column.
  for (const [verb, next, stamp] of [["accept", "accepted", "accepted_at"], ["start", "in_progress", "started_at"]] as const) {
    app.post(`${P}/smc/assignments/:id/${verb}`, asyncHandler(async (req, res) => {
      const u = res.locals.currentUser as CurrentUser;
      if (!(await isSmcMember(u))) return sendError(res, 403, "SMC access only.");
      const id = Number(getSingleParam(req.params.id));
      const got = await ownAssignment(u, id);
      if ("err" in got) return sendError(res, got.err[0], got.err[1]);
      const from = String(got.row.smc_status ?? "assigned");
      if (!smcTransition(from, next))
        return sendError(res, 409, `This assignment cannot be ${verb === "accept" ? "accepted" : "started"} from its current state.`);
      const extra = verb === "accept" ? `, accepted_by=$2` : ``;
      await pool.query(
        `UPDATE mo_assignments SET smc_status='${next}', ${stamp}=NOW()${extra} WHERE id=$1`,
        verb === "accept" ? [id, u.id] : [id]);
      await audit(u, `smc.assignment_${verb === "accept" ? "accepted" : "started"}`, "assignment", id,
        { smc_status: from }, { smc_status: next }, req);
      if (got.row.assigned_by)
        await smcNotify(String(got.row.assigned_by), "smc_assignment",
          verb === "accept" ? "SMC assignment accepted" : "SMC coverage started",
          `${u.full_name ?? "An SMC member"} — ${String(got.row.title ?? "assignment")}`, id);
      res.json({ ok: true, smc_status: next });
    }));
  }

  /* §12/§13 — submit or resubmit. A new attempt row every time, so a revision
     never overwrites what was reviewed before (§14). */
  app.post(`${P}/smc/assignments/:id/submit`, asyncHandler(async (req, res) => {
    const u = res.locals.currentUser as CurrentUser;
    if (!(await isSmcMember(u))) return sendError(res, 403, "SMC access only.");
    const id = Number(getSingleParam(req.params.id));
    const got = await ownAssignment(u, id);
    if ("err" in got) return sendError(res, got.err[0], got.err[1]);
    const from = String(got.row.smc_status ?? "assigned");
    if (!smcTransition(from, "submitted"))
      return sendError(res, 409, from === "submitted"
        ? "This work has already been submitted and is awaiting review."
        : "Accept and start this assignment before submitting your work.");

    const b = req.body as Record<string, unknown>;
    const url = (k: string) => String(b[k] ?? "").trim();
    const drive = url("drive_url"), photos = url("photos_url");
    if (!drive && !photos)
      return sendError(res, 400, "Add at least one link to your work — a Drive or Photos link.");
    const bad = [["drive_url", drive], ["photos_url", photos],
      ["media_library_url", url("media_library_url")], ["reference_url", url("reference_url")]]
      .find(([, v]) => v && !/^https?:\/\/\S+$/i.test(v));
    if (bad) return sendError(res, 400, "One of the links is not a valid URL. Please check and try again.");

    const attempt = Number((await pool.query(
      `SELECT COALESCE(MAX(attempt),0)+1 AS n FROM mo_smc_submissions WHERE assignment_id=$1`, [id])).rows[0].n);
    const ins = await pool.query(
      `INSERT INTO mo_smc_submissions (assignment_id, submitted_by, attempt, drive_url, photos_url,
         media_library_url, reference_url, note, photo_count, video_count)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [id, u.id, attempt, drive || null, photos || null, url("media_library_url") || null,
       url("reference_url") || null, url("note") || null,
       Math.max(0, Number(b.photo_count) || 0), Math.max(0, Number(b.video_count) || 0)]);
    await pool.query(`UPDATE mo_assignments SET smc_status='submitted' WHERE id=$1`, [id]);
    await audit(u, attempt > 1 ? "smc.submission_resubmitted" : "smc.submission_created",
      "assignment", id, { smc_status: from }, { attempt, submission_id: ins.rows[0].id }, req);
    if (got.row.assigned_by)
      await smcNotify(String(got.row.assigned_by), "smc_submission", "SMC work submitted",
        `${u.full_name ?? "An SMC member"} submitted ${String(got.row.title ?? "coverage")}`, id);
    res.status(201).json({ ok: true, smc_status: "submitted", attempt });
  }));


  // ── SMC MANAGEMENT ────────────────────────────────────────────────────────

  async function requireSmcManager(res: express.Response): Promise<CurrentUser | null> {
    const u = res.locals.currentUser as CurrentUser;
    if (!(await isSmcManager(u))) { sendError(res, 403, "SMC Management access only."); return null; }
    return u;
  }

  /* §16 — the dashboard counts. Every number is a real query, and each maps to a
     filter the UI can open, so nothing here is decorative. */
  app.get(`${P}/smc/overview`, asyncHandler(async (_req, res) => {
    if (!(await requireSmcManager(res))) return;
    const q = async (sql: string) => Number((await pool.query(sql)).rows[0].n);
    const [members, active, institutes] = await Promise.all([
      q(`SELECT COUNT(*) n FROM mo_smc_profiles`),
      q(`SELECT COUNT(*) n FROM mo_smc_profiles WHERE is_active`),
      q(`SELECT COUNT(DISTINCT academic_unit_id) n FROM mo_smc_profiles WHERE is_active AND academic_unit_id IS NOT NULL`),
    ]);
    const byStatus = (await pool.query(
      `SELECT COALESCE(smc_status,'assigned') s, COUNT(*) n FROM mo_assignments
        WHERE is_smc AND smc_status <> 'cancelled' GROUP BY 1`)).rows
      .reduce((a: Record<string, number>, r) => { a[String(r.s)] = Number(r.n); return a; }, {});
    const today = await q(`SELECT COUNT(*) n FROM mo_assignments WHERE is_smc AND start_date=CURRENT_DATE AND smc_status<>'cancelled'`);
    // "Missed" is measurable, not guessed: past its deadline and still unsubmitted.
    const missed = await q(
      `SELECT COUNT(*) n FROM mo_assignments WHERE is_smc AND smc_status IN ('assigned','accepted','in_progress')
        AND submission_deadline IS NOT NULL AND submission_deadline < NOW()`);
    const unaccepted = await q(
      `SELECT COUNT(*) n FROM mo_assignments WHERE is_smc AND COALESCE(smc_status,'assigned')='assigned'
        AND start_date <= CURRENT_DATE`);
    res.json({ members, active_members: active, institutes_covered: institutes, assignments_today: today,
      assigned: byStatus.assigned ?? 0, accepted: byStatus.accepted ?? 0,
      in_progress: byStatus.in_progress ?? 0, submitted: byStatus.submitted ?? 0,
      reviewed: byStatus.reviewed ?? 0, revision_required: byStatus.revision_required ?? 0,
      missed, unaccepted });
  }));

  /* §52/§53/§54 — the coverage list, filterable. One endpoint powers Today's
     Coverage, the status drill-downs and the search box. */
  app.get(`${P}/smc/assignments`, asyncHandler(async (req, res) => {
    if (!(await requireSmcManager(res))) return;
    const f = req.query as Record<string, string>;
    const where: string[] = []; const args: unknown[] = [];
    const add = (sql: string, v: unknown) => { args.push(v); where.push(sql.replace("?", `$${args.length}`)); };
    if (f.status === "missed") where.push(`a.smc_status IN ('assigned','accepted','in_progress')
      AND a.submission_deadline IS NOT NULL AND a.submission_deadline < NOW()`);
    else if (f.status) add(`COALESCE(a.smc_status,'assigned') = ?`, f.status);
    if (f.unit) add(`COALESCE(a.academic_unit_id, p.academic_unit_id) = ?`, Number(f.unit));
    if (f.member) add(`au.user_id = ?`, f.member);
    if (f.level) add(`p.event_level = ?`, f.level);
    if (f.date === "today") where.push(`a.start_date = CURRENT_DATE`);
    else if (f.from) add(`a.start_date >= ?`, f.from);
    if (f.to) add(`a.start_date <= ?`, f.to);
    if (f.q) add(`(a.title ILIKE '%'||?||'%' OR p.name ILIKE '%'||$${args.length}||'%' OR mu.full_name ILIKE '%'||$${args.length}||'%')`, f.q);
    const sql = `${SMC_SELECT}${where.length ? " AND " + where.join(" AND ") : ""}
      ORDER BY a.start_date DESC, a.start_time NULLS LAST LIMIT 300`;
    res.json({ assignments: (await pool.query(sql, args)).rows });
  }));

  /* §34 — per-member and per-institute performance, all derived from records. */
  app.get(`${P}/smc/performance`, asyncHandler(async (_req, res) => {
    if (!(await requireSmcManager(res))) return;
    const members = (await pool.query(`
      SELECT u.id, u.full_name, un.name AS institute, pr.is_active,
             COUNT(a.id) total,
             COUNT(*) FILTER (WHERE a.accepted_at IS NOT NULL) accepted,
             COUNT(*) FILTER (WHERE a.smc_status IN ('submitted','reviewed','revision_required')) submitted,
             COUNT(*) FILTER (WHERE a.smc_status = 'reviewed') reviewed,
             COUNT(*) FILTER (WHERE a.smc_status = 'revision_required') revision_required,
             COUNT(*) FILTER (WHERE a.smc_status IN ('assigned','accepted','in_progress')
               AND a.submission_deadline IS NOT NULL AND a.submission_deadline < NOW()) missed,
             COUNT(*) FILTER (WHERE s.submitted_at IS NOT NULL AND a.submission_deadline IS NOT NULL
               AND s.submitted_at > a.submission_deadline) late
        FROM mo_smc_profiles pr
        JOIN users u ON u.id = pr.user_id
        LEFT JOIN mo_academic_units un ON un.id = pr.academic_unit_id
        LEFT JOIN mo_assignment_users au ON au.user_id = u.id
        LEFT JOIN mo_assignments a ON a.id = au.assignment_id AND a.is_smc AND a.smc_status <> 'cancelled'
        LEFT JOIN LATERAL (SELECT submitted_at FROM mo_smc_submissions
                            WHERE assignment_id = a.id ORDER BY attempt DESC LIMIT 1) s ON true
       GROUP BY u.id, u.full_name, un.name, pr.is_active
       ORDER BY u.full_name`)).rows;
    const institutes = (await pool.query(`
      SELECT un.id, un.name,
             COUNT(DISTINCT pr.user_id) FILTER (WHERE pr.is_active) active_members,
             COUNT(DISTINCT p.id) FILTER (WHERE p.event_level IN ('institute','major_institute')) events,
             COUNT(DISTINCT a.id) covered,
             COUNT(DISTINCT a.id) FILTER (WHERE a.smc_status = 'reviewed') completed
        FROM mo_academic_units un
        LEFT JOIN mo_smc_profiles pr ON pr.academic_unit_id = un.id
        LEFT JOIN mo_projects p ON p.academic_unit_id = un.id
        LEFT JOIN mo_assignments a ON a.is_smc AND COALESCE(a.academic_unit_id, p.academic_unit_id) = un.id
                                  AND a.smc_status <> 'cancelled'
       WHERE un.is_active AND un.archived_at IS NULL
       GROUP BY un.id, un.name ORDER BY un.name`)).rows;
    res.json({ members, institutes });
  }));

  // §18/§19 — SMC member CRUD. Creating one makes a REAL account (team='smc').
  app.get(`${P}/smc/members`, asyncHandler(async (_req, res) => {
    if (!(await requireSmcManager(res))) return;
    const { rows } = await pool.query(`
      SELECT u.id, u.full_name, u.email, pr.phone, pr.designation, pr.joining_date,
             pr.coverage_area, pr.is_active, pr.academic_unit_id, un.name AS institute,
             pr.manager_id, m.full_name AS manager_name
        FROM mo_smc_profiles pr
        JOIN users u ON u.id = pr.user_id
        LEFT JOIN mo_academic_units un ON un.id = pr.academic_unit_id
        LEFT JOIN users m ON m.id = pr.manager_id
       ORDER BY pr.is_active DESC, u.full_name`);
    res.json({ members: rows });
  }));

  app.post(`${P}/smc/members`, asyncHandler(async (req, res) => {
    const actor = await requireSmcManager(res); if (!actor) return;
    const b = req.body as Record<string, unknown>;
    const name = String(b.full_name ?? "").trim();
    const email = String(b.email ?? "").trim().toLowerCase();
    const password = String(b.password ?? "").trim();
    const unit = b.academic_unit_id ? Number(b.academic_unit_id) : null;
    if (!name) return sendError(res, 400, "Please enter the member's full name.");
    if (!/^\S+@\S+\.\S+$/.test(email)) return sendError(res, 400, "Please enter a valid email address.");
    if (password.length < 6) return sendError(res, 400, "The temporary password must be at least 6 characters.");
    if (!unit) return sendError(res, 400, "Please choose the institute this member covers.");
    /* One person, one account. An existing SMC member is named as such; an
       account on another team is refused outright rather than being converted,
       because silently moving someone between teams changes what they can see
       and must be a deliberate administrative act (§9). */
    const dup = (await pool.query(
      `SELECT u.team, (sp.user_id IS NOT NULL) AS is_smc FROM users u
         LEFT JOIN mo_smc_profiles sp ON sp.user_id = u.id
        WHERE lower(u.email)=lower($1)`, [email])).rows[0];
    if (dup)
      return sendError(res, 409, dup.is_smc
        ? "This email is already registered as an SMC member."
        : `This email already belongs to a ${dup.team ?? "NERVE"} account. Ask an administrator to move it before adding them to SMC.`);

    // team='smc' is what makes the role real: moRoleOf() returns null for them,
    // so every non-SMC media route refuses them server-side (§4, §41).
    const id = `smc-${Date.now()}-${randomUUID().slice(0, 8)}`;
    await pool.query(
      `INSERT INTO users (id, full_name, email, role, team, password_hash, email_verified)
       VALUES ($1,$2,$3,'user','smc',$4,true)`,
      [id, name, email, await hashPassword(password)]);
    await pool.query(
      `INSERT INTO mo_smc_profiles (user_id, academic_unit_id, designation, phone, joining_date,
         coverage_area, manager_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, unit, String(b.designation ?? "SMC Member").trim() || "SMC Member",
       String(b.phone ?? "").trim() || null, b.joining_date || null,
       String(b.coverage_area ?? "").trim() || null, b.manager_id || null, actor.id]);
    await audit(actor, "smc.member_created", "user", null, null, { id, email, unit }, req);
    res.status(201).json({ ok: true, id });
  }));

  app.patch(`${P}/smc/members/:id`, asyncHandler(async (req, res) => {
    const actor = await requireSmcManager(res); if (!actor) return;
    const id = getSingleParam(req.params.id);
    const before = (await pool.query(`SELECT * FROM mo_smc_profiles WHERE user_id=$1`, [id])).rows[0];
    if (!before) return sendError(res, 404, "That SMC member could not be found.");
    const b = req.body as Record<string, unknown>;
    // Role is never editable here (§20) — only the SMC profile fields are.
    const sets: string[] = []; const args: unknown[] = [];
    const set = (col: string, v: unknown) => { args.push(v); sets.push(`${col}=$${args.length}`); };
    if (b.academic_unit_id !== undefined) set("academic_unit_id", Number(b.academic_unit_id) || null);
    if (b.designation !== undefined) set("designation", String(b.designation).trim() || "SMC Member");
    if (b.phone !== undefined) set("phone", String(b.phone).trim() || null);
    if (b.coverage_area !== undefined) set("coverage_area", String(b.coverage_area).trim() || null);
    if (b.manager_id !== undefined) set("manager_id", b.manager_id || null);
    if (b.joining_date !== undefined) set("joining_date", b.joining_date || null);
    if (b.is_active !== undefined) set("is_active", !!b.is_active);
    if (b.full_name !== undefined && String(b.full_name).trim())
      await pool.query(`UPDATE users SET full_name=$1 WHERE id=$2`, [String(b.full_name).trim(), id]);
    if (sets.length) {
      args.push(id);
      await pool.query(`UPDATE mo_smc_profiles SET ${sets.join(", ")}, updated_at=NOW() WHERE user_id=$${args.length}`, args);
    }
    const action = b.is_active === undefined ? "smc.member_edited"
      : (b.is_active ? "smc.member_activated" : "smc.member_deactivated");
    await audit(actor, action, "user", null, before, { ...b, user_id: id }, req);
    res.json({ ok: true });
  }));

  /* §35 — one member's full history: assignments, submissions, reviews. */
  app.get(`${P}/smc/members/:id/history`, asyncHandler(async (req, res) => {
    if (!(await requireSmcManager(res))) return;
    const id = getSingleParam(req.params.id);
    const { rows } = await pool.query(`${SMC_SELECT} AND au.user_id=$1 ORDER BY a.start_date DESC`, [id]);
    const reviews = (await pool.query(`
      SELECT s.*, a.title, rv.full_name AS reviewer FROM mo_smc_submissions s
        JOIN mo_assignments a ON a.id = s.assignment_id
        LEFT JOIN users rv ON rv.id = s.reviewed_by
       WHERE s.submitted_by=$1 ORDER BY s.submitted_at DESC`, [id])).rows;
    res.json({ assignments: rows, submissions: reviews });
  }));

  /* §27/§28 — create an assignment against an EXISTING event. Event facts are
     read from the project, never re-entered, so the two cannot disagree. */
  app.post(`${P}/smc/assignments`, asyncHandler(async (req, res) => {
    const actor = await requireSmcManager(res); if (!actor) return;
    const b = req.body as Record<string, unknown>;
    const projectId = Number(b.project_id) || null;
    const memberId = String(b.member_id ?? "").trim();
    if (!projectId) return sendError(res, 400, "Choose the event this coverage is for.");
    if (!memberId) return sendError(res, 400, "Choose an SMC member to assign.");
    const proj = (await pool.query(`SELECT * FROM mo_projects WHERE id=$1`, [projectId])).rows[0];
    if (!proj) return sendError(res, 404, "That event could not be found.");
    const prof = (await pool.query(`SELECT * FROM mo_smc_profiles WHERE user_id=$1`, [memberId])).rows[0];
    if (!prof) return sendError(res, 404, "That SMC member could not be found.");
    if (!prof.is_active) return sendError(res, 409, "That SMC member is inactive and cannot receive assignments.");

    const date = String(b.start_date ?? proj.start_date ?? "").slice(0, 10) || null;
    const unit = Number(b.academic_unit_id) || proj.academic_unit_id || prof.academic_unit_id || null;
    // §31 — a conflict is reported, not blocked; management decides.
    const conflicts = date ? (await pool.query(
      `SELECT a.id, a.title, a.start_time, a.end_time FROM mo_assignments a
         JOIN mo_assignment_users au ON au.assignment_id=a.id
        WHERE au.user_id=$1 AND a.is_smc AND a.start_date=$2
          AND COALESCE(a.smc_status,'assigned') NOT IN ('cancelled','reviewed')`,
      [memberId, date])).rows : [];

    const ins = await pool.query(
      `INSERT INTO mo_assignments (project_id, title, assigned_by, priority, status, start_date,
         start_time, end_time, notes, is_smc, academic_unit_id, venue, coverage_requirements,
         deliverables_required, submission_deadline, smc_status)
       VALUES ($1,$2,$3,$4,'not_started',$5,$6,$7,$8,true,$9,$10,$11,$12,$13,'assigned') RETURNING id`,
      [projectId, String(b.title ?? proj.name ?? "SMC coverage").trim(), actor.id,
       String(b.priority ?? "normal"), date, b.start_time || null, b.end_time || null,
       String(b.instructions ?? "").trim() || null, unit, String(b.venue ?? "").trim() || null,
       String(b.coverage_requirements ?? "").trim() || null,
       String(b.deliverables_required ?? "").trim() || null, b.submission_deadline || null]);
    const id = Number(ins.rows[0].id);
    await pool.query(`INSERT INTO mo_assignment_users (assignment_id, user_id) VALUES ($1,$2)`, [id, memberId]);
    await audit(actor, "smc.assignment_created", "assignment", id, null,
      { project_id: projectId, member_id: memberId, unit }, req);
    await smcNotify(memberId, "smc_assignment", "New coverage assignment",
      `${String(proj.name ?? "An event")}${date ? " — " + date : ""}`, id);
    res.status(201).json({ ok: true, id, conflicts });
  }));

  /* §14 — review a submission. The decision is written on the submission ATTEMPT,
     so the history of what was reviewed when is preserved across revisions. */
  app.post(`${P}/smc/assignments/:id/review`, asyncHandler(async (req, res) => {
    const actor = await requireSmcManager(res); if (!actor) return;
    const id = Number(getSingleParam(req.params.id));
    const b = req.body as Record<string, unknown>;
    const decision = String(b.decision ?? "").trim();
    if (!["reviewed", "revision_required"].includes(decision))
      return sendError(res, 400, "Choose whether the work is accepted or needs revision.");
    const feedback = String(b.feedback ?? "").trim();
    if (decision === "revision_required" && !feedback)
      return sendError(res, 400, "Please say what needs to change so the member can act on it.");
    const sub = (await pool.query(
      `SELECT * FROM mo_smc_submissions WHERE assignment_id=$1 ORDER BY attempt DESC LIMIT 1`, [id])).rows[0];
    if (!sub) return sendError(res, 404, "There is no submission to review yet.");
    await pool.query(
      `UPDATE mo_smc_submissions SET review_status=$1, reviewed_by=$2, reviewed_at=NOW(), review_feedback=$3
        WHERE id=$4`, [decision, actor.id, feedback || null, sub.id]);
    await pool.query(`UPDATE mo_assignments SET smc_status=$1 WHERE id=$2`, [decision, id]);
    await audit(actor, decision === "reviewed" ? "smc.submission_reviewed" : "smc.revision_requested",
      "assignment", id, { attempt: sub.attempt }, { decision, feedback }, req);
    const member = await smcAssignee(id);
    if (member) await smcNotify(member, "smc_review",
      decision === "reviewed" ? "Your coverage was reviewed" : "Revision requested",
      decision === "reviewed" ? "Your submission has been accepted." : feedback, id);
    res.json({ ok: true, smc_status: decision });
  }));

  // §30 — reassign, keeping the handover auditable.
  app.post(`${P}/smc/assignments/:id/reassign`, asyncHandler(async (req, res) => {
    const actor = await requireSmcManager(res); if (!actor) return;
    const id = Number(getSingleParam(req.params.id));
    const to = String((req.body as Record<string, unknown>).member_id ?? "").trim();
    const reason = String((req.body as Record<string, unknown>).reason ?? "").trim();
    const asg = (await pool.query(`SELECT * FROM mo_assignments WHERE id=$1 AND is_smc`, [id])).rows[0];
    if (!asg) return sendError(res, 404, "That assignment could not be found.");
    const prof = (await pool.query(`SELECT is_active FROM mo_smc_profiles WHERE user_id=$1`, [to])).rows[0];
    if (!prof) return sendError(res, 404, "That SMC member could not be found.");
    if (!prof.is_active) return sendError(res, 409, "That SMC member is inactive and cannot receive assignments.");
    const from = await smcAssignee(id);
    if (from === to) return sendError(res, 409, "That assignment is already with this member.");
    await pool.query(`DELETE FROM mo_assignment_users WHERE assignment_id=$1`, [id]);
    await pool.query(`INSERT INTO mo_assignment_users (assignment_id, user_id) VALUES ($1,$2)`, [id, to]);
    // The new assignee starts from the beginning; the old one's acceptance is history.
    await pool.query(
      `UPDATE mo_assignments SET smc_status='assigned', accepted_by=NULL, accepted_at=NULL, started_at=NULL WHERE id=$1`, [id]);
    await pool.query(
      `INSERT INTO mo_smc_reassignments (assignment_id, from_user_id, to_user_id, changed_by, reason)
       VALUES ($1,$2,$3,$4,$5)`, [id, from, to, actor.id, reason || null]);
    await audit(actor, "smc.assignment_reassigned", "assignment", id, { from }, { to, reason }, req);
    if (from) await smcNotify(from, "smc_assignment", "Assignment reassigned",
      `${String(asg.title ?? "Coverage")} is no longer assigned to you.`, id);
    await smcNotify(to, "smc_assignment", "New coverage assignment", String(asg.title ?? "Coverage"), id);
    res.json({ ok: true });
  }));

  // §37 — escalate to Central Media: the event is promoted so the existing
  // Central Media workflow picks it up, rather than inventing a second pipeline.
  app.post(`${P}/smc/assignments/:id/escalate`, asyncHandler(async (req, res) => {
    const actor = await requireSmcManager(res); if (!actor) return;
    const id = Number(getSingleParam(req.params.id));
    const reason = String((req.body as Record<string, unknown>).reason ?? "").trim();
    if (!reason) return sendError(res, 400, "Please give a reason so Central Media knows what is needed.");
    const asg = (await pool.query(`SELECT * FROM mo_assignments WHERE id=$1 AND is_smc`, [id])).rows[0];
    if (!asg) return sendError(res, 404, "That assignment could not be found.");
    if (asg.escalated_at) return sendError(res, 409, "This assignment has already been escalated.");
    await pool.query(
      `UPDATE mo_assignments SET escalated_at=NOW(), escalated_by=$1, escalation_reason=$2,
         escalation_status='open' WHERE id=$3`, [actor.id, reason, id]);
    // Promote the event itself so it surfaces in the Central Media views.
    if (asg.project_id)
      await pool.query(
        `UPDATE mo_projects SET event_level='major_institute'
          WHERE id=$1 AND event_level='institute'`, [asg.project_id]);
    await audit(actor, "smc.assignment_escalated", "assignment", id, null, { reason }, req);
    res.json({ ok: true });
  }));

  // §21 — cancel, never delete: history stays intact.
  app.post(`${P}/smc/assignments/:id/cancel`, asyncHandler(async (req, res) => {
    const actor = await requireSmcManager(res); if (!actor) return;
    const id = Number(getSingleParam(req.params.id));
    const reason = String((req.body as Record<string, unknown>).reason ?? "").trim();
    const asg = (await pool.query(`SELECT * FROM mo_assignments WHERE id=$1 AND is_smc`, [id])).rows[0];
    if (!asg) return sendError(res, 404, "That assignment could not be found.");
    await pool.query(
      `UPDATE mo_assignments SET smc_status='cancelled', cancelled_at=NOW(), cancel_reason=$1 WHERE id=$2`,
      [reason || null, id]);
    await audit(actor, "smc.assignment_cancelled", "assignment", id, { smc_status: asg.smc_status }, { reason }, req);
    const member = await smcAssignee(id);
    if (member) await smcNotify(member, "smc_assignment", "Assignment cancelled",
      `${String(asg.title ?? "Coverage")}${reason ? " — " + reason : ""}`, id);
    res.json({ ok: true });
  }));

  /* Institutes for the pickers, with their SMC strength (§17/§22). Reuses
     mo_academic_units — no second institute table. */
  app.get(`${P}/smc/institutes`, asyncHandler(async (_req, res) => {
    if (!(await requireSmcManager(res))) return;
    const { rows } = await pool.query(`
      SELECT un.id, un.name, un.is_active,
             COUNT(pr.user_id) FILTER (WHERE pr.is_active) AS active_members,
             COUNT(pr.user_id) AS total_members
        FROM mo_academic_units un
        LEFT JOIN mo_smc_profiles pr ON pr.academic_unit_id = un.id
       WHERE un.archived_at IS NULL
       GROUP BY un.id, un.name, un.is_active ORDER BY un.name`);
    res.json({ institutes: rows });
  }));

  /* Institute-level events that can take SMC coverage (§24/§27), with the
     institute's own SMC members offered alongside. */
  app.get(`${P}/smc/assignable-events`, asyncHandler(async (_req, res) => {
    if (!(await requireSmcManager(res))) return;
    const events = (await pool.query(`
      SELECT p.id, p.name, p.start_date, p.event_level, p.academic_unit_id, un.name AS institute
        FROM mo_projects p LEFT JOIN mo_academic_units un ON un.id = p.academic_unit_id
       WHERE p.event_level IN ('institute','major_institute','university')
         AND p.status NOT IN ('archived','cancelled','completed')
       ORDER BY p.start_date DESC NULLS LAST LIMIT 200`)).rows;
    const members = (await pool.query(`
      SELECT pr.user_id id, u.full_name, pr.academic_unit_id, un.name AS institute
        FROM mo_smc_profiles pr JOIN users u ON u.id=pr.user_id
        LEFT JOIN mo_academic_units un ON un.id=pr.academic_unit_id
       WHERE pr.is_active ORDER BY u.full_name`)).rows;
    res.json({ events, members });
  }));

  /* §29 — recent SMC activity, read from the shared audit trail. The SPA clears
     its local audit copy at hydrate, so the trail is served rather than guessed;
     this is a read of mo_audit_logs, not a second log. */
  app.get(`${P}/smc/activity`, asyncHandler(async (_req, res) => {
    if (!(await requireSmcManager(res))) return;
    const { rows } = await pool.query(`
      SELECT l.id, l.action, l.entity_type, l.entity_id, l.after, l.occurred_at,
             u.full_name AS actor_name
        FROM mo_audit_logs l LEFT JOIN users u ON u.id = l.actor_id
       WHERE l.action LIKE 'smc.%'
       ORDER BY l.occurred_at DESC LIMIT 60`);
    res.json({ activity: rows });
  }));

  /* §23 — set an event's level. The only change SMC makes to an existing event. */
  app.patch(`${P}/smc/events/:id/level`, asyncHandler(async (req, res) => {
    const actor = await requireSmcManager(res); if (!actor) return;
    const id = Number(getSingleParam(req.params.id));
    const level = String((req.body as Record<string, unknown>).event_level ?? "");
    if (!["central", "institute", "major_institute", "university"].includes(level))
      return sendError(res, 400, "That is not a valid event level.");
    const before = (await pool.query(`SELECT event_level FROM mo_projects WHERE id=$1`, [id])).rows[0];
    if (!before) return sendError(res, 404, "That event could not be found.");
    await pool.query(`UPDATE mo_projects SET event_level=$1 WHERE id=$2`, [level, id]);
    await audit(actor, "smc.event_level_changed", "project", id, before, { event_level: level }, req);
    res.json({ ok: true });
  }));


  /* ═══ Deliverable-level assignment (crew + SMC) ═════════════════════════════
     A deliverable can carry BOTH a Media Crew assignee and an SMC assignee: they
     are two relationships to the same work, not alternatives. Both are ordinary
     mo_assignments rows against the SAME project and deliverable, separated only
     by is_smc — so each already flows into the My Day and workflow that reads it,
     and neither duplicates a project, a deliverable or an assignment engine. */

  /** The deliverable's current assignees, with names resolved. SMC members are
      not in the crew roster /state ships, so their name is resolved here rather
      than by polluting that roster. */
  app.get(`${P}/deliverables/:id/assignees`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    const did = parseInt(getSingleParam(req.params.id), 10);
    const { rows } = await pool.query(`
      SELECT a.id, a.is_smc, a.smc_status, a.status, au.user_id,
             us.full_name, p.designation, un.name AS institute
        FROM mo_assignments a
        JOIN mo_assignment_users au ON au.assignment_id = a.id
        JOIN users us ON us.id = au.user_id
        LEFT JOIN mo_user_profiles p ON p.user_id = us.id
        LEFT JOIN mo_smc_profiles sp ON sp.user_id = us.id
        LEFT JOIN mo_academic_units un ON un.id = sp.academic_unit_id
       WHERE a.deliverable_id = $1 AND a.status <> 'cancelled'
         AND COALESCE(a.smc_status,'') <> 'cancelled'`, [did]);
    const pick = (smc: boolean) => {
      const r = rows.find((x) => !!x.is_smc === smc);
      return r ? { assignment_id: r.id, user_id: r.user_id, full_name: r.full_name,
                   designation: r.designation ?? null, institute: r.institute ?? null,
                   status: smc ? r.smc_status : r.status } : null;
    };
    res.json({ crew: pick(false), smc: pick(true) });
  }));

  /** Candidates for both pickers, from the existing rosters. */
  app.get(`${P}/deliverables/:id/assignable`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    const allowed = await assignableMemberIds(u);
    const crew = (await pool.query(`
      SELECT u.id, u.full_name, p.designation, u.role
        FROM users u LEFT JOIN mo_user_profiles p ON p.user_id = u.id
       WHERE u.team='media' AND COALESCE(u.status,'active')='active'
       ORDER BY u.full_name`)).rows.filter((r) => allowed.has(String(r.id)));
    const smc = (await pool.query(`
      SELECT sp.user_id AS id, us.full_name, sp.designation,
             sp.academic_unit_id, un.name AS institute
        FROM mo_smc_profiles sp
        JOIN users us ON us.id = sp.user_id
        LEFT JOIN mo_academic_units un ON un.id = sp.academic_unit_id
       WHERE sp.is_active ORDER BY un.name NULLS LAST, us.full_name`)).rows;
    res.json({ crew, smc });
  }));

  /* Assign (or reassign) the deliverable. One handler for both kinds so the
     validation, audit and notification story cannot diverge between them. */
  app.post(`${P}/deliverables/:id/assignee`, asyncHandler(async (req, res) => {
    const u = requireMedia(res); if (!u) return;
    const did = parseInt(getSingleParam(req.params.id), 10);
    const b = req.body as Record<string, unknown>;
    const kind = String(b.kind ?? "crew");
    const memberId = String(b.user_id ?? "").trim();
    if (!["crew", "smc"].includes(kind)) return sendError(res, 400, "Unknown assignment type.");
    if (!memberId) return sendError(res, 400, "Choose someone to assign.");

    const d = (await pool.query(
      `SELECT d.*, p.name AS project_name FROM mo_deliverables d
         LEFT JOIN mo_projects p ON p.id = d.project_id WHERE d.id=$1`, [did])).rows[0];
    if (!d) return sendError(res, 404, "That deliverable could not be found.");
    // Same gate the rest of the project surface uses: owner, PM, Team Lead or Admin.
    const pm = await pool.query(
      `SELECT 1 FROM mo_project_assignments WHERE project_id=$1 AND user_id=$2
         AND is_project_manager AND removed_at IS NULL`, [d.project_id, u.id]);
    const owner = (await pool.query(
      `SELECT owner_id FROM mo_projects WHERE id=$1`, [d.project_id])).rows[0]?.owner_id;
    if (!(isMoAdmin(u) || isMoTL(u) || owner === u.id || pm.rows[0]))
      return sendError(res, 403, "Only the owner/PM, a Team Lead or Admin may assign this deliverable.");

    if (kind === "crew") {
      if (!(await assertAssignable(res, u, [memberId]))) return;
    } else {
      const sp = (await pool.query(
        `SELECT is_active FROM mo_smc_profiles WHERE user_id=$1`, [memberId])).rows[0];
      if (!sp) return sendError(res, 404, "That SMC member could not be found.");
      if (!sp.is_active) return sendError(res, 409, "That SMC member is inactive and cannot receive assignments.");
    }

    const isSmc = kind === "smc";
    const existing = (await pool.query(
      `SELECT a.id, au.user_id FROM mo_assignments a
         LEFT JOIN mo_assignment_users au ON au.assignment_id=a.id
        WHERE a.deliverable_id=$1 AND a.is_smc=$2 AND a.status <> 'cancelled'
          AND COALESCE(a.smc_status,'') <> 'cancelled' LIMIT 1`, [did, isSmc])).rows[0];

    // Deliverable titles often already carry the project name; only append it
    // when it adds something, so the assignment does not read "X — Y — Y".
    const dTitle = String(d.title ?? "Deliverable");
    const pName = d.project_name ? String(d.project_name) : "";
    const title = pName && !dTitle.includes(pName) ? `${dTitle} — ${pName}` : dTitle;
    // dOnly(): pg hands back a DATE as a JS Date, and String(...).slice(0,10)
    // yields "Thu Aug 27" rather than a date. The helper already exists for this.
    const due = dOnly(d.due_date);

    let asgId: number;
    if (existing) {
      // Reassign in place (§12): one active assignment per kind, never a duplicate.
      asgId = Number(existing.id);
      const from = existing.user_id ? String(existing.user_id) : null;
      if (from === memberId)
        return res.json({ ok: true, unchanged: true, assignment_id: asgId });
      await pool.query(`DELETE FROM mo_assignment_users WHERE assignment_id=$1`, [asgId]);
      await pool.query(
        `INSERT INTO mo_assignment_users (assignment_id, user_id) VALUES ($1,$2)`, [asgId, memberId]);
      if (isSmc) {
        // The incoming member starts fresh; the handover is kept, as elsewhere.
        await pool.query(
          `UPDATE mo_assignments SET smc_status='assigned', accepted_by=NULL, accepted_at=NULL,
             started_at=NULL WHERE id=$1`, [asgId]);
        await pool.query(
          `INSERT INTO mo_smc_reassignments (assignment_id, from_user_id, to_user_id, changed_by, reason)
           VALUES ($1,$2,$3,$4,$5)`, [asgId, from, memberId, u.id, "Reassigned from the deliverable panel"]);
      }
      if (from) await pool.query(
        `INSERT INTO mo_notifications (user_id, kind, title, body, entity_type, entity_id)
         VALUES ($1,$2,$3,$4,'assignment',$5)`,
        [from, isSmc ? "smc_assignment" : "assignment", "Assignment reassigned",
         `${title} is no longer assigned to you.`, asgId]).catch(() => {});
    } else {
      const ins = await pool.query(
        `INSERT INTO mo_assignments (project_id, deliverable_id, title, assigned_by, priority, status,
           start_date, due_date, is_smc, academic_unit_id, submission_deadline, smc_status)
         VALUES ($1,$2,$3,$4,'normal','not_started',CURRENT_DATE,$5,$6,$7,$8,$9) RETURNING id`,
        [d.project_id, did, title, u.id, due, isSmc,
         isSmc ? (await pool.query(`SELECT academic_unit_id FROM mo_smc_profiles WHERE user_id=$1`, [memberId])).rows[0]?.academic_unit_id ?? null : null,
         isSmc && due ? `${due}T23:59:59` : null,
         isSmc ? "assigned" : null]);
      asgId = Number(ins.rows[0].id);
      await pool.query(
        `INSERT INTO mo_assignment_users (assignment_id, user_id) VALUES ($1,$2)`, [asgId, memberId]);
    }

    await pool.query(
      `INSERT INTO mo_notifications (user_id, kind, title, body, entity_type, entity_id)
       VALUES ($1,$2,$3,$4,'assignment',$5)`,
      [memberId, isSmc ? "smc_assignment" : "assignment",
       isSmc ? "New coverage assignment" : "New assignment", title, asgId]).catch(() => {});
    await audit(u, isSmc ? "deliverable.smc_assigned" : "deliverable.assigned",
      "deliverable", did, null, { assignment_id: asgId, user_id: memberId, kind }, req);

    const state = (await pool.query(`
      SELECT us.full_name, p.designation, un.name AS institute
        FROM users us LEFT JOIN mo_user_profiles p ON p.user_id=us.id
        LEFT JOIN mo_smc_profiles sp ON sp.user_id=us.id
        LEFT JOIN mo_academic_units un ON un.id=sp.academic_unit_id
       WHERE us.id=$1`, [memberId])).rows[0] ?? {};
    res.status(201).json({ ok: true, assignment_id: asgId, kind,
      assignee: { user_id: memberId, full_name: state.full_name ?? null,
                  designation: state.designation ?? null, institute: state.institute ?? null } });
  }));

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
  // Admin-configurable rules (NFR-10): each block below is gated on its rule's
  // is_enabled toggle — editing a rule in Settings changes behaviour immediately.
  const ruleRows = await pool.query(`SELECT rule_key, is_enabled FROM mo_automation_rules`);
  const ruleOn = (k: string) => { const r = ruleRows.rows.find((x) => x.rule_key === k); return r ? !!r.is_enabled : true; };
  // BR-4 / D2 — reports auto-approve 48 h after submission unless flagged.
  // A report edited after submission is excluded: it was sent back for an
  // explicit re-review, and auto-approving it would bypass that decision.
  const aa = await pool.query(
    `UPDATE mo_daily_reports SET status='auto_approved', reviewed_at=NOW()
      WHERE status='submitted' AND NOT edited_after_submit
        AND submitted_at IS NOT NULL AND submitted_at < NOW() - INTERVAL '48 hours'
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

  // AUTO-2 — overdue deliverables → owner; escalation: +PM at 3 days, +Admins at 7 (§17).
  if (ruleOn("AUTO-2")) {
    const admins = (await pool.query(`SELECT id FROM users WHERE team='media' AND role='admin'`)).rows.map((r) => r.id as string);
    for (const d of (await pool.query(
      `SELECT d.id, d.title, d.owner_id, d.due_date, (CURRENT_DATE - d.due_date) AS days_over,
              (SELECT a.user_id FROM mo_project_assignments a WHERE a.project_id=d.project_id AND a.is_project_manager AND a.removed_at IS NULL LIMIT 1) AS pm
         FROM mo_deliverables d
        WHERE d.deleted_at IS NULL AND d.due_date < CURRENT_DATE
          AND d.status NOT IN ('delivered','not_required','cancelled') AND d.owner_id IS NOT NULL`)).rows) {
      const msg = `“${d.title}” was due ${String(d.due_date).slice(0, 10)}`;
      await notify(d.owner_id, "overdue", "Deliverable overdue", msg, "deliverable", d.id);
      if (Number(d.days_over) >= 3 && d.pm && d.pm !== d.owner_id)
        await notify(d.pm, "overdue", "Escalation: deliverable 3+ days overdue", msg, "deliverable", d.id);
      if (Number(d.days_over) >= 7)
        for (const a of admins) if (a !== d.owner_id) await notify(a, "overdue", "Escalation: deliverable 7+ days overdue", msg, "deliverable", d.id);
    }
  }

  // Review pending → the project PM (escalation family AUTO-4).
  if (ruleOn("AUTO-4")) for (const d of (await pool.query(
    `SELECT d.id, d.title, a.user_id AS pm FROM mo_deliverables d
       JOIN mo_project_assignments a ON a.project_id=d.project_id AND a.is_project_manager AND a.removed_at IS NULL
      WHERE d.status='in_review'`)).rows)
    await notify(d.pm, "approval", "Awaiting your review", `“${d.title}” has a version pending`, "deliverable", d.id);

  // AUTO-3 — overdue equipment → current holder.
  if (ruleOn("AUTO-3")) for (const t of (await pool.query(
    `SELECT DISTINCT ON (t.equipment_item_id) t.equipment_item_id AS id, t.holder_id, t.expected_return_at, e.asset_tag
       FROM mo_equipment_transactions t JOIN mo_equipment_items e ON e.id=t.equipment_item_id
      WHERE e.status='checked_out'
      ORDER BY t.equipment_item_id, t.occurred_at DESC`)).rows)
    if (t.expected_return_at && new Date(t.expected_return_at) < new Date())
      await notify(t.holder_id, "overdue", "Equipment overdue", `${t.asset_tag} is past its return date`, "equipment", t.id);

  // AUTO-10 — shoot within 24h → remind each crew member (call time + location).
  if (ruleOn("AUTO-10"))
    for (const s of (await pool.query(
      `SELECT s.id, s.title, s.shoot_date, s.call_time, s.location FROM mo_shoots s
        WHERE s.deleted_at IS NULL AND s.status IN ('planned','confirmed')
          AND s.shoot_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 1`)).rows)
      for (const c of (await pool.query(`SELECT user_id FROM mo_shoot_crew WHERE shoot_id=$1`, [s.id])).rows)
        await notify(c.user_id, "shoot", "Shoot tomorrow — be ready",
          `“${s.title}” · ${String(s.shoot_date).slice(0, 10)}${s.call_time ? " · call " + s.call_time : ""}${s.location ? " · " + s.location : ""}`,
          "shoot", s.id);

  // AUTO-1 — today's report not submitted (working day, not on leave) → nudge the member.
  if (ruleOn("AUTO-1") && new Date().getDay() !== 0)
    for (const p of (await pool.query(
      `SELECT u.id FROM users u
        WHERE u.team='media' AND COALESCE(u.role,'user') <> 'admin'
          AND NOT EXISTS (SELECT 1 FROM mo_daily_reports r WHERE r.user_id=u.id AND r.report_date=CURRENT_DATE AND r.status <> 'draft')
          AND NOT EXISTS (SELECT 1 FROM mo_leave_requests l WHERE l.user_id=u.id AND l.status='approved' AND CURRENT_DATE BETWEEN l.starts_on AND l.ends_on)`)).rows)
      await notify(p.id, "reminder", "Daily report not submitted", "Log your tasks and submit today’s report (AUTO-1).", "report", null);

  return { autoApproved: aa.rowCount ?? 0, notified };
}
