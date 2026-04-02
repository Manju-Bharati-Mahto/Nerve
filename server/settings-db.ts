import { randomBytes } from "node:crypto";
import { pool } from "./db.js";

// ── Bootstrap ──────────────────────────────────────────────────────────────

export async function bootstrapSettingsDatabase() {
  // Key-value settings store
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Password reset tokens
  await pool.query(`
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TIMESTAMPTZ NOT NULL,
      used       BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Email verification tokens
  await pool.query(`
    CREATE TABLE IF NOT EXISTS email_verification_tokens (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TIMESTAMPTZ NOT NULL,
      used       BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Add email_verified column to users if missing
  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT false
  `);

  // Seed defaults
  const defaults: Record<string, string> = {
    "site.name":                    "Parul University Knowledge Hub",
    "site.timezone":                "Asia/Kolkata",
    "auth.session_timeout_hours":   "168",
    "auth.max_login_attempts":      "5",
    "auth.email_verification":      "false",
    "branding.delete_window_mins":  "60",
    "smtp.host":                    "",
    "smtp.port":                    "587",
    "smtp.user":                    "",
    "smtp.from":                    "noreply@parul.ac.in",
    "design_gallery.enabled":       "true",
    "daily_reports.enabled":        "true",
    "kra_appraisal.enabled":        "true",
  };

  for (const [key, value] of Object.entries(defaults)) {
    await pool.query(
      `INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`,
      [key, value]
    );
  }
}

// ── Settings CRUD ──────────────────────────────────────────────────────────

export async function getAllSettings(): Promise<Record<string, string>> {
  const res = await pool.query<{ key: string; value: string }>(
    `SELECT key, value FROM app_settings ORDER BY key`
  );
  return Object.fromEntries(res.rows.map(r => [r.key, r.value]));
}

export async function getSetting(key: string): Promise<string | null> {
  const res = await pool.query<{ value: string }>(
    `SELECT value FROM app_settings WHERE key = $1`, [key]
  );
  return res.rows[0]?.value ?? null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  await pool.query(
    `INSERT INTO app_settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [key, value]
  );
}

export async function setSettings(patch: Record<string, string>): Promise<void> {
  for (const [k, v] of Object.entries(patch)) {
    await setSetting(k, v);
  }
}

// ── Password reset tokens ──────────────────────────────────────────────────

export async function createPasswordResetToken(userId: string): Promise<string> {
  const raw = randomBytes(32).toString("hex");
  const { createHash } = await import("node:crypto");
  const hash = createHash("sha256").update(raw).digest("hex");
  const id = `prt-${Date.now()}-${randomBytes(3).toString("hex")}`;

  // Invalidate previous unused tokens for this user
  await pool.query(
    `UPDATE password_reset_tokens SET used = true WHERE user_id = $1 AND used = false`,
    [userId]
  );

  await pool.query(
    `INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at)
     VALUES ($1, $2, $3, NOW() + interval '30 minutes')`,
    [id, userId, hash]
  );
  return raw;
}

export async function consumePasswordResetToken(
  raw: string
): Promise<string | null> {
  const { createHash } = await import("node:crypto");
  const hash = createHash("sha256").update(raw).digest("hex");
  const res = await pool.query<{ user_id: string }>(
    `UPDATE password_reset_tokens
     SET used = true
     WHERE token_hash = $1
       AND used = false
       AND expires_at > NOW()
     RETURNING user_id`,
    [hash]
  );
  return res.rows[0]?.user_id ?? null;
}

// ── Email verification tokens ──────────────────────────────────────────────

export async function createEmailVerificationToken(userId: string): Promise<string> {
  const raw = randomBytes(32).toString("hex");
  const { createHash } = await import("node:crypto");
  const hash = createHash("sha256").update(raw).digest("hex");
  const id = `evt-${Date.now()}-${randomBytes(3).toString("hex")}`;

  await pool.query(
    `UPDATE email_verification_tokens SET used = true WHERE user_id = $1 AND used = false`,
    [userId]
  );
  await pool.query(
    `INSERT INTO email_verification_tokens (id, user_id, token_hash, expires_at)
     VALUES ($1, $2, $3, NOW() + interval '24 hours')`,
    [id, userId, hash]
  );
  return raw;
}

export async function consumeEmailVerificationToken(
  raw: string
): Promise<string | null> {
  const { createHash } = await import("node:crypto");
  const hash = createHash("sha256").update(raw).digest("hex");
  const res = await pool.query<{ user_id: string }>(
    `UPDATE email_verification_tokens
     SET used = true
     WHERE token_hash = $1
       AND used = false
       AND expires_at > NOW()
     RETURNING user_id`,
    [hash]
  );
  if (!res.rows[0]) return null;
  const userId = res.rows[0].user_id;
  await pool.query(`UPDATE users SET email_verified = true WHERE id = $1`, [userId]);
  return userId;
}

export async function isEmailVerified(userId: string): Promise<boolean> {
  const res = await pool.query<{ email_verified: boolean }>(
    `SELECT email_verified FROM users WHERE id = $1`, [userId]
  );
  return res.rows[0]?.email_verified ?? false;
}
