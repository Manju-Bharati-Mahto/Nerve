// ═══════════════════════════════════════════════════════════════════════════
// NERVE MEDIA OPS — SEED IMPORTER
// Loads the prototype's demo dataset (server/mediaops-seed.json, extracted from
// the interactive prototype) into the real mo_* schema so the backend holds the
// same rich data the UI was designed around. Run once for a demo DB:
//     npx tsx server/mediaops-import.ts
//
// Strategy (see docs/MEDIA_OPS.md): the prototype uses integer ids whose FKs are
// self-consistent, so every mo_ row is inserted WITH its original id
// (OVERRIDING SYSTEM VALUE) — no entity-id remapping. Only user references remap,
// because the 18 media crew live in the shared global `users` table (TEXT ids).
// Idempotent: truncates the mo_ target tables first, upserts users by email.
// ═══════════════════════════════════════════════════════════════════════════
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { pool } from "./db.js";
import { hashPassword } from "./password.js";

const HERE = dirname(fileURLToPath(import.meta.url));
type Row = Record<string, unknown>;
type DB = Record<string, Row[]>;

// Columns that are integers in the prototype but TEXT → users(id) in mo_*.
const USER_REF = new Set([
  "owner_id", "created_by", "user_id", "assigned_by", "submitted_by", "reviewed_by",
  "added_by", "actor_id", "holder_id", "checked_out_by", "requested_by", "approved_by",
  "lead_user_id", "manager_id", "head_user_id", "custodian_id", "replaced_by",
  "recorded_by", "reported_by", "decided_by", "replacement_user_id", "replaced_user_id",
]);
// prototype DB key → mo_ table, in FK-safe order. Lookups first, then transactional.
const PLAN: [string, string][] = [
  ["departments", "mo_departments"], ["campuses", "mo_campuses"], ["academic_years", "mo_academic_years"],
  ["teams", "mo_teams"], ["duty_flags", "mo_duty_flags"], ["skills", "mo_skills"],
  ["capacity_roles", "mo_capacity_roles"], ["deliverable_types", "mo_deliverable_types"],
  ["task_categories", "mo_task_categories"], ["tags", "mo_tags"], ["automation_rules", "mo_automation_rules"],
  ["project_types", "mo_project_types"], ["project_templates", "mo_project_templates"],
  ["template_deliverables", "mo_template_deliverables"],
  ["projects", "mo_projects"], ["project_assignments", "mo_project_assignments"],
  ["deliverables", "mo_deliverables"], ["deliverable_versions", "mo_deliverable_versions"],
  ["drive_links", "mo_drive_links"], ["daily_reports", "mo_daily_reports"], ["report_tasks", "mo_report_tasks"],
  // ── Phase 2: equipment, shoots, leave (FK-safe: shoots before bookings) ──
  ["vendors", "mo_vendors"], ["equipment_categories", "mo_equipment_categories"],
  ["leave_types", "mo_leave_types"], ["holidays", "mo_holidays"],
  ["equipment_items", "mo_equipment_items"], ["equipment_kits", "mo_equipment_kits"],
  ["kit_items", "mo_kit_items"], ["shoots", "mo_shoots"], ["shoot_crew", "mo_shoot_crew"],
  ["equipment_bookings", "mo_equipment_bookings"], ["equipment_transactions", "mo_equipment_transactions"],
  ["maintenance_records", "mo_maintenance_records"], ["leave_requests", "mo_leave_requests"],
  ["leave_replacements", "mo_leave_replacements"],
];
const ROLE_MAP: Record<string, string> = { admin: "admin", team_lead: "sub_admin", employee: "user" };

async function columnsOf(table: string): Promise<Map<string, string>> {
  const { rows } = await pool.query(
    `SELECT column_name, data_type FROM information_schema.columns WHERE table_name=$1`, [table]);
  return new Map(rows.map((r: Row) => [r.column_name as string, r.data_type as string]));
}

export async function importMediaOpsSeed(): Promise<void> {
  const db = JSON.parse(readFileSync(join(HERE, "mediaops-seed.json"), "utf8")) as DB;
  const client = await pool.connect();
  try {
    // 1) Media crew → shared users table. Build proto-int → users(id text) map.
    const userMap = new Map<number, string>();
    const pwd = await hashPassword("media123");
    for (const u of db.users) {
      const id = `mo-u${u.id}`;
      const role = ROLE_MAP[String(u.role)] ?? "user";
      const r = await client.query(
        `INSERT INTO users (id, full_name, email, department, role, team, password_hash, avatar_url, email_verified)
         VALUES ($1,$2,$3,'Media Crew',$4,'media',$5,$6,true)
         ON CONFLICT (email) DO UPDATE SET full_name=EXCLUDED.full_name, role=EXCLUDED.role, team='media'
         RETURNING id`,
        [id, u.full_name, u.email, role, pwd, u.avatar_url ?? null]);
      userMap.set(Number(u.id), r.rows[0].id as string);
    }
    console.log(`users: ${userMap.size} media crew upserted (login: <email> / media123)`);

    // 2) Clean slate for the mo_ target tables (CASCADE clears empty Phase-2/3 dependents).
    const targets = PLAN.map(([, t]) => t).concat("mo_user_profiles");
    await client.query(`TRUNCATE ${targets.join(", ")} RESTART IDENTITY CASCADE`);

    // 3) mo_user_profiles (designation / mo_role / colour drive /lookups people list).
    const profCols = await columnsOf("mo_user_profiles");
    for (const u of db.users) {
      const vals: Row = { user_id: userMap.get(Number(u.id)) };
      if (profCols.has("designation")) vals.designation = u.designation ?? null;
      if (profCols.has("mo_role")) vals.mo_role = u.role ?? null;
      if (profCols.has("color")) vals.color = u.color ?? null;
      if (profCols.has("nerve_user_id")) vals.nerve_user_id = u.nerve_user_id ?? null;
      if (profCols.has("joined_on")) vals.joined_on = u.joined_on ?? u.joined ?? null;
      const cols = Object.keys(vals);
      await client.query(
        `INSERT INTO mo_user_profiles (${cols.map(q).join(",")}) VALUES (${cols.map((_, i) => "$" + (i + 1)).join(",")})`,
        cols.map((c) => vals[c])).catch(() => {/* optional */});
    }

    // 4) Generic explicit-id import per entity.
    for (const [key, table] of PLAN) {
      const rows = db[key] ?? [];
      if (!rows.length) { console.log(`${table}: 0 (empty)`); continue; }
      const cols = await columnsOf(table);
      const jsonb = new Set([...cols].filter(([, t]) => t === "jsonb" || t === "json").map(([c]) => c));
      let ok = 0; const errs: string[] = [];
      for (const row of rows) {
        // project_types.default_template_id is a circular FK to project_templates → set in a post-pass.
        const skip = table === "mo_project_types" ? new Set(["default_template_id"]) : new Set<string>();
        const names: string[] = [], values: unknown[] = [];
        for (const [k, v] of Object.entries(row)) {
          if (!cols.has(k) || skip.has(k)) continue;
          names.push(k);
          if (v === null || v === undefined) values.push(null);
          else if (USER_REF.has(k)) values.push(userMap.get(Number(v)) ?? null);
          else if (jsonb.has(k)) values.push(JSON.stringify(v));
          else values.push(v);
        }
        try {
          await client.query(
            `INSERT INTO ${table} (${names.map(q).join(",")}) OVERRIDING SYSTEM VALUE
             VALUES (${names.map((_, i) => "$" + (i + 1)).join(",")})`, values);
          ok++;
        } catch (e) { if (errs.length < 3) errs.push((e as Error).message.split("\n")[0]); }
      }
      // Keep the identity sequence ahead of the explicit ids we just inserted.
      if (cols.has("id")) {
        await client.query(
          `SELECT setval(pg_get_serial_sequence($1,'id'), GREATEST((SELECT COALESCE(MAX(id),0) FROM ${table}),1))`, [table]);
      }
      console.log(`${table}: ${ok}/${rows.length}${errs.length ? "  ⚠ " + errs.join(" | ") : ""}`);
    }

    // 5) Post-pass: project_types.default_template_id (deferred circular FK).
    for (const t of db.project_types) {
      if (t.default_template_id != null)
        await client.query(`UPDATE mo_project_types SET default_template_id=$1 WHERE id=$2`, [t.default_template_id, t.id]);
    }
    console.log("Media Ops seed import complete.");
  } finally {
    client.release();
  }
}
function q(c: string) { return `"${c}"`; }

// Run directly: npx tsx server/mediaops-import.ts
if (import.meta.url === `file://${process.argv[1]}`) {
  importMediaOpsSeed().then(() => pool.end()).then(() => process.exit(0))
    .catch((e) => { console.error(e); process.exit(1); });
}
