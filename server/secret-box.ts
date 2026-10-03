/**
 * Sealing a secret for the database.
 *
 * A refresh token or an OAuth client secret that an Admin pastes into the app
 * has to live somewhere the server can read it back — so it lives in Postgres,
 * but never in clear. AES-256-GCM under a key derived from SESSION_SECRET:
 * the one secret this deployment already has to keep. Rotating SESSION_SECRET
 * therefore also retires every sealed value, and open() returns null for them
 * rather than garbage, so the UI can say "reconnect" instead of failing later.
 *
 * Format: `v1.<iv>.<tag>.<ciphertext>`, each part base64url. The version is
 * there so a later scheme can coexist with rows sealed under this one.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { config } from "./config.js";

const b64u = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

/* Purpose-bound: a key for sealing is never the session secret itself, and a
   different purpose string gives a different key from the same secret. */
const key = (purpose: string) =>
  createHash("sha256").update(`${config.sessionSecret}\u0000secret-box\u0000${purpose}`).digest();

export function sealSecret(plain: string, purpose = "default"): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(purpose), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `v1.${b64u(iv)}.${b64u(cipher.getAuthTag())}.${b64u(ct)}`;
}

/** The sealed value, or null when it was sealed under another key or tampered with. */
export function openSecret(sealed: string | null | undefined, purpose = "default"): string | null {
  if (!sealed) return null;
  const parts = sealed.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key(purpose), unb64u(parts[1]));
    decipher.setAuthTag(unb64u(parts[2]));
    return Buffer.concat([decipher.update(unb64u(parts[3])), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}
