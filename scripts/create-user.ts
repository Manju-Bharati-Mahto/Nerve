import { hashPassword } from "../server/password.js";
import { pool } from "../server/db.js";
import { randomBytes } from "node:crypto";

const email = process.argv[2];
const password = process.argv[3];
const fullName = process.argv[4];
const role = process.argv[5] ?? "user";       // user | sub_admin | admin | super_admin | outreach_manager
const team = process.argv[6] ?? "branding";   // branding | content | outreach | ""
const department = process.argv[7] ?? "";

if (!email || !password || !fullName) {
  console.error("Usage: tsx scripts/create-user.ts <email> <password> <fullName> [role=user] [team=branding] [department='']");
  process.exit(1);
}

(async () => {
  const id = `u-${Date.now()}-${randomBytes(3).toString("hex")}`;
  const hash = await hashPassword(password);
  try {
    const res = await pool.query(
      `INSERT INTO users (id, full_name, email, department, role, team, managed_by, password_hash)
       VALUES ($1, $2, $3, $4, $5, $6, NULL, $7)
       RETURNING id, email, full_name, role, team`,
      [id, fullName, email, department, role, team, hash]
    );
    console.log("Created:", res.rows[0]);
  } catch (e) {
    console.error("Failed:", e instanceof Error ? e.message : e);
    process.exit(1);
  } finally {
    await pool.end();
  }
})();
