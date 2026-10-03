/* Local-only dummy accounts for role checking.
 *
 * Idempotent: re-running resets the password and the role rows rather than
 * creating a second copy. Writes nothing outside these six accounts, except
 * for setting a password on the existing rahul.joshi admin, which was asked
 * for by name.
 *
 * Run:  npx tsx <this file>
 */
import { randomBytes } from "node:crypto";

const PASSWORD = process.env.DUMMY_PASSWORD || "NerveLocal#2026";

type Spec = {
  email: string;
  name: string;
  role: string;                     // users.role
  team: string | null;              // users.team
  moRole?: "admin" | "team_lead" | "employee";
  creatorRole?: "creator_admin" | "team_lead" | "creator";
  designation?: string;
  keepExisting?: boolean;           // do not overwrite name/role/team
};

const SPECS: Spec[] = [
  { email: "rahul.joshi@paruluniversity.ac.in", name: "Rahul Joshi",
    role: "admin", team: "media", moRole: "admin", keepExisting: true },
  { email: "dummy-lead@parul.ac.in", name: "Dummy Team Lead",
    role: "sub_admin", team: "media", moRole: "team_lead", designation: "Team Lead" },
  { email: "dummy-employee@parul.ac.in", name: "Dummy Employee",
    role: "user", team: "media", moRole: "employee", designation: "Camera Operator" },
  { email: "dummy-creator-admin@parul.ac.in", name: "Dummy Creator Admin",
    role: "user", team: "creator", creatorRole: "creator_admin" },
  { email: "dummy-creator-lead@parul.ac.in", name: "Dummy Creator Lead",
    role: "user", team: "creator", creatorRole: "team_lead" },
  { email: "dummy-creator@parul.ac.in", name: "Dummy Creator",
    role: "user", team: "creator", creatorRole: "creator" },
];

/* LOCAL DATABASES ONLY. This script sets a known password on real accounts,
   including an admin. Run against anything but a local database it would be a
   credential written into a public repository, so it refuses outright rather
   than asking. */
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
function assertLocalDatabase() {
  let host = "";
  try { host = new URL(process.env.DATABASE_URL ?? "").hostname; } catch { /* unparseable */ }
  if (!LOCAL_HOSTS.has(host)) {
    console.error(`Refusing to run: DATABASE_URL points at "${host || "nothing"}", not a local database.`);
    process.exit(1);
  }
}

(async () => {
  assertLocalDatabase();
  /* Imported only after the guard: loading server/db.js opens a pool against
     whatever DATABASE_URL says, which is exactly what the guard is for. */
  const { hashPassword } = await import("../server/password.js");
  const { pool } = await import("../server/db.js");
  const hash = await hashPassword(PASSWORD);
  const out: Array<Record<string, string>> = [];

  for (const s of SPECS) {
    const found = await pool.query<{ id: string }>(
      `SELECT id FROM users WHERE lower(email)=lower($1)`, [s.email]);
    let id = found.rows[0]?.id;

    if (id) {
      /* Existing account: password and sign-in eligibility only. The admin in
         this list is a real seeded person, so their name, role and team are
         left exactly as they are. */
      await pool.query(
        `UPDATE users SET password_hash=$1, status='active', email_verified=true
          WHERE id=$2`, [hash, id]);
      if (!s.keepExisting)
        await pool.query(`UPDATE users SET full_name=$1, role=$2, team=$3 WHERE id=$4`,
          [s.name, s.role, s.team, id]);
    } else {
      id = `u-${Date.now()}-${randomBytes(3).toString("hex")}`;
      await pool.query(
        `INSERT INTO users (id, full_name, email, department, role, team, password_hash,
                            status, email_verified)
         VALUES ($1,$2,$3,'',$4,$5,$6,'active',true)`,
        [id, s.name, s.email, s.role, s.team, hash]);
    }

    if (s.moRole)
      await pool.query(
        `INSERT INTO mo_user_profiles (user_id, designation, mo_role)
         VALUES ($1,$2,$3)
         ON CONFLICT (user_id) DO UPDATE SET mo_role=EXCLUDED.mo_role,
           designation=COALESCE(NULLIF(mo_user_profiles.designation,''), EXCLUDED.designation)`,
        [id, s.designation ?? "", s.moRole]);

    if (s.creatorRole)
      await pool.query(
        `INSERT INTO mo_creator_profiles (user_id, creator_role, status, display_name)
         VALUES ($1,$2,'active',$3)
         ON CONFLICT (user_id) DO UPDATE SET creator_role=EXCLUDED.creator_role, status='active'`,
        [id, s.creatorRole, s.name]);

    out.push({
      email: s.email,
      what: s.creatorRole ? `creator / ${s.creatorRole}` : `${s.role} / ${s.moRole}`,
      id,
    });
  }

  console.table(out);
  console.log(`\nPassword for all of the above: ${PASSWORD}\n`);
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
