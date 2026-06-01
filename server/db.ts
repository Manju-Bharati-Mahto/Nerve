import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { config } from "./config.js";
import { hashPassword, verifyPassword } from "./password.js";
import {
  BUILT_IN_TEAMS,
  DEFAULT_SUPER_ADMIN_EMAIL,
  LEGACY_SUPER_ADMIN_PASSWORD,
  SEED_ENTRIES,
  SEED_USERS,
  SUPER_ADMIN_SEED_ID,
  isSeedSuperAdmin,
  type SeedRole,
} from "./seed.js";

export type AppRole = SeedRole;

export interface Attachment {
  id: string;
  entry_id: string;
  file_name: string;
  file_type: "pdf" | "image";
  file_size: number;
}

export interface Entry {
  id: string;
  title: string;
  dept: string;
  type: string;
  body: string;
  priority: "Normal" | "High" | "Key highlight";
  entry_date: string;
  created_by: string | null;
  tags: string[];
  author_name: string;
  academic_year: string;
  student_count: number | null;
  external_link: string;
  collaborating_org: string;
  created_at: string;
  attachments: Attachment[];
}

export interface TeamRecord {
  id: string;
  name: string;
  color: string;
  isBuiltIn: boolean;
}

export interface BrandingRow {
  id: string;
  category: string;
  sub_category: string;
  time_taken: string;
  team_member: string;
  project_name: string;
  additional_info: string;
  created_at: string;
  updated_at: string;
}

export interface AppUser {
  id: string;
  full_name: string;
  email: string;
  department: string;
  role: AppRole;
  team: string | null;
  managed_by: string | null;
  email_verified: boolean;
  avatar_url: string | null;
  created_at: string;
  updated_at: string;
  team_joined_at: string | null;
}

export interface UserWithPassword extends AppUser {
  password_hash: string;
}

export interface CreateUserInput {
  full_name: string;
  email: string;
  password: string;
  department: string;
  role: AppRole;
  team: string | null;
  managed_by: string | null;
}

export interface UpdateUserInput {
  full_name?: string;
  email?: string;
  password?: string;
  department?: string;
  role?: AppRole;
  team?: string | null;
  managed_by?: string | null;
  avatar_url?: string | null;
}

export interface CreateEntryInput {
  title: string;
  dept: string;
  type: string;
  body: string;
  priority: "Normal" | "High" | "Key highlight";
  entry_date: string;
  created_by: string | null;
  tags: string[];
  author_name: string;
  academic_year: string;
  student_count: number | null;
  external_link: string;
  collaborating_org: string;
}

export interface CreateTeamInput {
  name: string;
  color: string;
}

export interface CreateBrandingRowInput {
  category?: string;
  sub_category?: string;
  time_taken?: string;
  team_member?: string;
  project_name?: string;
  additional_info?: string;
}

export type UpdateBrandingRowInput = CreateBrandingRowInput;

interface UserRow {
  id: string;
  full_name: string;
  email: string;
  department: string;
  role: AppRole;
  team: string | null;
  managed_by: string | null;
  password_hash: string;
  email_verified: boolean;
  avatar_url: string | null;
  created_at: string;
  updated_at: string;
  team_joined_at: string | null;
}

interface EntryRow {
  id: string;
  title: string;
  dept: string;
  type: string;
  body: string;
  priority: "Normal" | "High" | "Key highlight";
  entry_date: string;
  created_by: string | null;
  tags: string[];
  author_name: string;
  academic_year: string;
  student_count: number | null;
  external_link: string;
  collaborating_org: string;
  created_at: string;
  attachments: Attachment[];
}

interface TeamRow {
  id: string;
  name: string;
  color: string;
  is_built_in: boolean;
}

interface BrandingRowRecord {
  id: string;
  category: string;
  sub_category: string;
  time_taken: string;
  team_member: string;
  project_name: string;
  additional_info: string;
  created_at: string;
  updated_at: string;
}

export const pool = new Pool({
  connectionString: config.databaseUrl,
});

function generateId(prefix: string) {
  return `${prefix}-${Date.now()}-${randomBytes(3).toString("hex")}`;
}

function mapUser(row: UserRow): AppUser {
  return {
    id: row.id,
    full_name: row.full_name,
    email: row.email,
    department: row.department || "",
    role: row.role,
    team: row.team,
    managed_by: row.managed_by,
    email_verified: row.email_verified ?? false,
    avatar_url: row.avatar_url ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    team_joined_at: row.team_joined_at ?? null,
  };
}

function mapEntry(row: EntryRow): Entry {
  return {
    id: row.id,
    title: row.title,
    dept: row.dept,
    type: row.type,
    body: row.body,
    priority: row.priority,
    entry_date: row.entry_date,
    created_by: row.created_by,
    tags: row.tags || [],
    author_name: row.author_name || "",
    academic_year: row.academic_year || "",
    student_count: row.student_count,
    external_link: row.external_link || "",
    collaborating_org: row.collaborating_org || "",
    created_at: row.created_at,
    attachments: Array.isArray(row.attachments) ? row.attachments : [],
  };
}

function mapTeam(row: TeamRow): TeamRecord {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    isBuiltIn: row.is_built_in,
  };
}

function mapBrandingRow(row: BrandingRowRecord): BrandingRow {
  return {
    id: row.id,
    category: row.category || "",
    sub_category: row.sub_category || "",
    time_taken: row.time_taken || "",
    team_member: row.team_member || "",
    project_name: row.project_name || "",
    additional_info: row.additional_info || "",
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function bootstrapDatabase() {
  await pool.query(`CREATE EXTENSION IF NOT EXISTS vector`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS teams (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      color TEXT NOT NULL,
      is_built_in BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      full_name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      department TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL CHECK (role IN ('super_admin', 'admin', 'sub_admin', 'user', 'outreach_manager', 'branding_reports_admin')),
      team TEXT REFERENCES teams(id) ON DELETE SET NULL,
      managed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Add avatar_url column if it doesn't exist (safe migration)
  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT DEFAULT NULL
  `);

  // Track when each user joined their current team. Used to clamp the KRA
  // expected-days window so new joiners and team-transferred members aren't
  // penalised for days before they were on the team. Backfilled from
  // created_at for existing rows where the user has a team set.
  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS team_joined_at TIMESTAMPTZ
  `);
  await pool.query(`
    UPDATE users
       SET team_joined_at = created_at
     WHERE team_joined_at IS NULL AND team IS NOT NULL
  `);

  // Widen role CHECK constraint to include all current roles (safe migration).
  // branding_reports_admin: branding-team admin restricted to Daily Reports +
  // Manage Categories. Doesn't get KRA or Leave Requests.
  await pool.query(`
    DO $$
    BEGIN
      ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
      ALTER TABLE users ADD CONSTRAINT users_role_check
        CHECK (role IN ('super_admin', 'admin', 'sub_admin', 'user', 'outreach_manager', 'branding_reports_admin'));
    END $$;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS entries (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      dept TEXT NOT NULL,
      type TEXT NOT NULL,
      body TEXT NOT NULL,
      priority TEXT NOT NULL CHECK (priority IN ('Normal', 'High', 'Key highlight')),
      entry_date DATE NOT NULL,
      created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      tags TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
      author_name TEXT NOT NULL DEFAULT '',
      academic_year TEXT NOT NULL DEFAULT '',
      student_count INTEGER,
      external_link TEXT NOT NULL DEFAULT '',
      collaborating_org TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      attachments JSONB NOT NULL DEFAULT '[]'::JSONB
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS branding_rows (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL DEFAULT '',
      sub_category TEXT NOT NULL DEFAULT '',
      time_taken TEXT NOT NULL DEFAULT '',
      team_member TEXT NOT NULL DEFAULT '',
      project_name TEXT NOT NULL DEFAULT '',
      additional_info TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Per-user capability grants. Layered on top of roles: a user with role
  // 'user' or 'sub_admin' can be granted specific admin-only features (e.g.
  // 'branding:manage_categories') by an admin. Admin / super_admin / role-
  // owned features are NOT stored here — the role itself grants them.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_capabilities (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      capability_key TEXT NOT NULL,
      granted_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(user_id, capability_key)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS user_capabilities_user_id_idx ON user_capabilities(user_id)`);

  await seedDefaults();
}

async function seedDefaults() {
  const teamCount = await pool.query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM teams`);
  if (teamCount.rows[0].count === 0) {
    for (const team of BUILT_IN_TEAMS) {
      await pool.query(
        `INSERT INTO teams (id, name, color, is_built_in) VALUES ($1, $2, $3, $4)`,
        [team.id, team.name, team.color, team.isBuiltIn],
      );
    }
  }

  const userCount = await pool.query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM users`);
  if (userCount.rows[0].count === 0) {
    for (const user of SEED_USERS) {
      const password = isSeedSuperAdmin(user) ? config.superAdminPassword : user.password;
      const email = isSeedSuperAdmin(user) ? config.superAdminEmail : user.email;
      const passwordHash = await hashPassword(password);

      await pool.query(
        `INSERT INTO users (id, full_name, email, department, role, team, managed_by, password_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          user.id,
          user.full_name,
          email,
          user.department,
          user.role,
          user.team,
          user.managed_by,
          passwordHash,
        ],
      );
    }
  }

  await rotateLegacySuperAdminCredentials();

  const entryCount = await pool.query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM entries`);
  if (entryCount.rows[0].count === 0) {
    for (const entry of SEED_ENTRIES) {
      await pool.query(
        `INSERT INTO entries (
          id, title, dept, type, body, priority, entry_date, created_by, tags,
          author_name, academic_year, student_count, external_link, collaborating_org, created_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7::date, $8, $9::text[], $10, $11, $12, $13, $14, $15::timestamptz
        )`,
        [
          entry.id,
          entry.title,
          entry.dept,
          entry.type,
          entry.body,
          entry.priority,
          entry.entry_date,
          entry.created_by,
          entry.tags,
          entry.author_name,
          entry.academic_year,
          entry.student_count,
          entry.external_link,
          entry.collaborating_org,
          entry.created_at,
        ],
      );
    }
  }
}

async function rotateLegacySuperAdminCredentials() {
  const result = await pool.query<UserRow>(
    `SELECT * FROM users WHERE id = $1 LIMIT 1`,
    [SUPER_ADMIN_SEED_ID],
  );
  const superAdmin = result.rows[0];
  if (!superAdmin || superAdmin.role !== "super_admin") return;

  const shouldUpdateEmail =
    superAdmin.email === DEFAULT_SUPER_ADMIN_EMAIL &&
    superAdmin.email !== config.superAdminEmail;
  const shouldUpdatePassword = await verifyPassword(
    LEGACY_SUPER_ADMIN_PASSWORD,
    superAdmin.password_hash,
  );

  if (!shouldUpdateEmail && !shouldUpdatePassword) return;

  await pool.query(
    `UPDATE users
       SET email = $2,
           password_hash = $3,
           updated_at = NOW()
     WHERE id = $1`,
    [
      SUPER_ADMIN_SEED_ID,
      shouldUpdateEmail ? config.superAdminEmail : superAdmin.email,
      shouldUpdatePassword ? await hashPassword(config.superAdminPassword) : superAdmin.password_hash,
    ],
  );
}

export async function getUserById(id: string) {
  const result = await pool.query<UserRow>(`SELECT * FROM users WHERE id = $1`, [id]);
  if (!result.rows[0]) return null;
  return { ...mapUser(result.rows[0]), password_hash: result.rows[0].password_hash };
}

export async function getUserByEmail(email: string) {
  const result = await pool.query<UserRow>(`SELECT * FROM users WHERE LOWER(email) = LOWER($1)`, [email]);
  if (!result.rows[0]) return null;
  return { ...mapUser(result.rows[0]), password_hash: result.rows[0].password_hash };
}

export async function listUsers() {
  const result = await pool.query<UserRow>(`SELECT * FROM users ORDER BY created_at ASC`);
  return result.rows.map(mapUser);
}

export async function createUser(input: CreateUserInput) {
  const passwordHash = await hashPassword(input.password);
  const result = await pool.query<UserRow>(
    `INSERT INTO users (id, full_name, email, department, role, team, managed_by, password_hash, team_joined_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CASE WHEN $6::text IS NULL THEN NULL ELSE NOW() END)
     RETURNING *`,
    [
      generateId("u"),
      input.full_name,
      input.email,
      input.department,
      input.role,
      input.team,
      input.role === "user" ? input.managed_by : null,
      passwordHash,
    ],
  );
  return mapUser(result.rows[0]);
}

export async function updateUser(id: string, input: UpdateUserInput) {
  const current = await getUserById(id);
  if (!current) return null;

  const passwordHash = input.password ? await hashPassword(input.password) : current.password_hash;
  const role = input.role ?? current.role;
  const team = input.team === undefined ? current.team : input.team;
  const managedBy = role === "user"
    ? (input.managed_by === undefined ? current.managed_by : input.managed_by)
    : null;

  const avatarUrl = input.avatar_url !== undefined ? input.avatar_url : current.avatar_url;

  // Re-stamp team_joined_at whenever the team actually changes (including
  // assignment from null → team, team → team', or team → null). Keep the
  // existing value when team is unchanged so KRA windows stay stable.
  const teamChanged = input.team !== undefined && input.team !== current.team;

  const result = await pool.query<UserRow>(
    `UPDATE users
     SET full_name = $2,
         email = $3,
         department = $4,
         role = $5,
         team = $6,
         managed_by = $7,
         password_hash = $8,
         avatar_url = $9,
         team_joined_at = CASE
           WHEN $10::boolean THEN (CASE WHEN $6::text IS NULL THEN NULL ELSE NOW() END)
           ELSE team_joined_at
         END,
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [
      id,
      input.full_name ?? current.full_name,
      input.email ?? current.email,
      input.department ?? current.department,
      role,
      team,
      managedBy,
      passwordHash,
      avatarUrl,
      teamChanged,
    ],
  );

  return result.rows[0] ? mapUser(result.rows[0]) : null;
}

export async function deleteUser(id: string) {
  await pool.query(`UPDATE users SET managed_by = NULL, updated_at = NOW() WHERE managed_by = $1`, [id]);
  await pool.query(`DELETE FROM users WHERE id = $1`, [id]);
}

// ── Per-user capability grants ─────────────────────────────────────────────
// Layered on top of roles: a user with role 'user' or 'sub_admin' may have
// specific admin-only features explicitly granted (e.g. branding:manage_categories).
// Capability keys are free-form strings prefixed by domain — see
// shared/capabilities.ts for the source of truth on which keys are valid.

export interface UserCapability {
  capability_key: string;
  granted_by: string | null;
  granted_at: string;
}

export async function listUserCapabilities(userId: string): Promise<string[]> {
  const result = await pool.query<{ capability_key: string }>(
    `SELECT capability_key FROM user_capabilities WHERE user_id = $1`,
    [userId],
  );
  return result.rows.map(r => r.capability_key);
}

// Bulk lookup: returns a map userId -> capability[] for hydrating user lists
// without N+1 queries.
export async function listCapabilitiesByUserIds(
  userIds: string[],
): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (userIds.length === 0) return map;
  const result = await pool.query<{ user_id: string; capability_key: string }>(
    `SELECT user_id, capability_key FROM user_capabilities WHERE user_id = ANY($1::text[])`,
    [userIds],
  );
  for (const row of result.rows) {
    const existing = map.get(row.user_id) ?? [];
    existing.push(row.capability_key);
    map.set(row.user_id, existing);
  }
  return map;
}

// Replace the user's full capability set in a single transaction.
// `keys` is the desired final state — rows not in the set are removed.
export async function setUserCapabilities(
  userId: string,
  keys: string[],
  grantedBy: string,
): Promise<string[]> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `DELETE FROM user_capabilities WHERE user_id = $1 AND capability_key <> ALL($2::text[])`,
      [userId, keys],
    );
    for (const key of keys) {
      // Generate IDs deterministically off the (user, capability) so a
      // repeated call doesn't accumulate duplicate rows with new IDs.
      await client.query(
        `INSERT INTO user_capabilities (id, user_id, capability_key, granted_by)
           VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, capability_key) DO NOTHING`,
        [`uc_${userId}_${key}`.slice(0, 64), userId, key, grantedBy],
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
  return listUserCapabilities(userId);
}

export async function listEntries() {
  const result = await pool.query<EntryRow>(`SELECT * FROM entries ORDER BY created_at DESC`);
  return result.rows.map(mapEntry);
}

export async function createEntry(input: CreateEntryInput) {
  const result = await pool.query<EntryRow>(
    `INSERT INTO entries (
      id, title, dept, type, body, priority, entry_date, created_by, tags,
      author_name, academic_year, student_count, external_link, collaborating_org, attachments
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7::date, $8, $9::text[],
      $10, $11, $12, $13, $14, '[]'::jsonb
    )
    RETURNING *`,
    [
      generateId("e"),
      input.title,
      input.dept,
      input.type,
      input.body,
      input.priority,
      input.entry_date,
      input.created_by,
      input.tags,
      input.author_name,
      input.academic_year,
      input.student_count,
      input.external_link,
      input.collaborating_org,
    ],
  );
  return mapEntry(result.rows[0]);
}

export async function deleteEntry(id: string) {
  await pool.query(`DELETE FROM entries WHERE id = $1`, [id]);
}

export async function listTeams() {
  const result = await pool.query<TeamRow>(`SELECT * FROM teams ORDER BY is_built_in DESC, name ASC`);
  return result.rows.map(mapTeam);
}

export async function createTeam(input: CreateTeamInput) {
  const id = input.name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
  const result = await pool.query<TeamRow>(
    `INSERT INTO teams (id, name, color, is_built_in)
     VALUES ($1, $2, $3, false)
     RETURNING *`,
    [id, input.name, input.color],
  );
  return mapTeam(result.rows[0]);
}

export async function deleteTeam(id: string) {
  await pool.query(`DELETE FROM teams WHERE id = $1`, [id]);
}

export async function listBrandingRows() {
  const result = await pool.query<BrandingRowRecord>(`SELECT * FROM branding_rows ORDER BY created_at ASC`);
  return result.rows.map(mapBrandingRow);
}

export async function createBrandingRow(input: CreateBrandingRowInput) {
  const result = await pool.query<BrandingRowRecord>(
    `INSERT INTO branding_rows (
      id, category, sub_category, time_taken, team_member, project_name, additional_info
    ) VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING *`,
    [
      generateId("br"),
      input.category || "",
      input.sub_category || "",
      input.time_taken || "",
      input.team_member || "",
      input.project_name || "",
      input.additional_info || "",
    ],
  );
  return mapBrandingRow(result.rows[0]);
}

export async function updateBrandingRow(id: string, input: UpdateBrandingRowInput) {
  const current = await pool.query<BrandingRowRecord>(`SELECT * FROM branding_rows WHERE id = $1`, [id]);
  if (!current.rows[0]) return null;
  const row = current.rows[0];

  const result = await pool.query<BrandingRowRecord>(
    `UPDATE branding_rows
     SET category = $2,
         sub_category = $3,
         time_taken = $4,
         team_member = $5,
         project_name = $6,
         additional_info = $7,
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [
      id,
      input.category ?? row.category,
      input.sub_category ?? row.sub_category,
      input.time_taken ?? row.time_taken,
      input.team_member ?? row.team_member,
      input.project_name ?? row.project_name,
      input.additional_info ?? row.additional_info,
    ],
  );

  return mapBrandingRow(result.rows[0]);
}

export async function deleteBrandingRow(id: string) {
  await pool.query(`DELETE FROM branding_rows WHERE id = $1`, [id]);
}

export async function getBootstrapData(includeBrandingRows: boolean) {
  const [entries, users, teams, brandingRows] = await Promise.all([
    listEntries(),
    listUsers(),
    listTeams(),
    includeBrandingRows ? listBrandingRows() : Promise.resolve([] as BrandingRow[]),
  ]);

  return { entries, users, teams, brandingRows };
}
