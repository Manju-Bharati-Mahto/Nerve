import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/* ── The one OTP policy in NERVE ───────────────────────────────────────────
   Extracted from the password-reset flow (settings-db.ts) so the employee
   Forgot Password path and the public portals share a single definition of
   what an OTP is: how it is generated, how it is stored, how long it lives
   and what makes it spent. Both callers import from here; neither restates
   the rules.

   Storage stays with each caller because the two are bound to different
   subjects — password_otps.user_id is NOT NULL and references users(id), and
   an external applicant must never get a users row. The policy is shared; only
   the table each flow writes to differs. */

/** Minutes an OTP stays valid. Matches the password-reset TTL. */
export const OTP_TTL_MINUTES = 10;

/** Seconds a caller must wait before a fresh code can be sent to the same subject. */
export const OTP_RESEND_COOLDOWN_SECONDS = 60;

/** Wrong guesses allowed against a single code before it is burned. */
export const OTP_MAX_ATTEMPTS = 5;

/** Six digits, uniformly drawn from a CSPRNG — not Math.random(). */
export function generateOtp(): string {
  // Rejection sampling keeps every code equally likely; a plain modulo would
  // bias the low end of the range.
  for (;;) {
    const n = randomBytes(4).readUInt32BE(0);
    if (n < 4_294_000_000) return String(100000 + (n % 900000));
  }
}

/** Codes are stored as hashes so a database read never yields a usable OTP. */
export function hashOtp(otp: string): string {
  return createHash("sha256").update(otp.trim()).digest("hex");
}

/** Constant-time hash comparison, so a wrong code cannot be timed out digit by digit. */
export function otpHashMatches(a: string, b: string): boolean {
  const x = Buffer.from(String(a), "utf8");
  const y = Buffer.from(String(b), "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Opaque, unguessable handle for a verified public-portal session. */
export function newSessionToken(): string {
  return randomBytes(32).toString("hex");
}

/** r****@paruluniversity.ac.in — enough to recognise, not enough to harvest. */
export function maskEmail(email: string): string {
  const [local, domain] = String(email).split("@");
  if (!domain) return "";
  const head = local.slice(0, 1);
  return `${head}${"*".repeat(Math.max(3, local.length - 1))}@${domain}`;
}

/** True when `email` belongs to `domain` (leading @ tolerated on either side). */
export function emailInDomain(email: string, domain: string): boolean {
  const d = String(domain).replace(/^@/, "").toLowerCase();
  return String(email).trim().toLowerCase().endsWith("@" + d);
}
