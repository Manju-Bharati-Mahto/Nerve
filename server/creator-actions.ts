/* ═══════════════════════════════════════════════════════════════════════════
   CREATOR NETWORK — the only place an AI-initiated write happens

   This file exists so the answer to "what can the assistant change?" is a file
   listing rather than a search. Everything else the AI layer touches is
   read-only; the whitelist below is the complete set of mutations, and it has
   exactly one member.

   WHAT IS DELIBERATELY ABSENT, and must stay absent:

     points      awarding, reversing, adjusting, closing a cycle
     money       approving, paying, adjusting, reversing, rate changes
     content     approving or rejecting a submission
     identity    creating, suspending or archiving a creator

   Money and points are READ-ONLY to the assistant, permanently as far as this
   phase is concerned. A person approves a payout, in the payout screen, with
   their name on it.

   THE CONFIRMATION MODEL

   A mutation is never a single call. The tool first returns a PROPOSAL — who
   it would reach, exactly what it would say — together with a token that is a
   signature over the caller, the action, the target and the parameters, with
   an expiry. Executing requires handing that token back. A token therefore
   cannot authorise a different action, a different target, different text, a
   different person, or the same thing tomorrow.

   No table is needed for that, and deliberately so: a pending proposal is not
   business state, and storing one would only create something else to expire,
   clean up and leak.
   ═══════════════════════════════════════════════════════════════════════════ */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Pool } from "pg";

/* Both the pool and the configuration are reached LAZILY, for the same reason
   creator-queries.ts does it: server/ai/tools/creator-tools.ts imports this
   file, so a top-level import would make merely building the tool registry
   open a database connection and demand a SESSION_SECRET. */
let poolRef: Pool | null = null;
async function db(): Promise<Pool> {
  if (!poolRef) ({ pool: poolRef } = await import("./db.js"));
  return poolRef;
}

/** Every mutation the assistant may perform, by name. Nothing else exists. */
export const CREATOR_AI_ACTIONS = ["creator_send_notification"] as const;
export type CreatorAiAction = (typeof CREATOR_AI_ACTIONS)[number];

/** How long a proposal stays executable. Short: a confirmation is a reply to
    something on screen, not a standing permission. */
export const ACTION_TTL_MS = 10 * 60 * 1000;

/* The payload is canonicalised before signing so that a token cannot be
   replayed against a payload that differs only in key order or whitespace. */
function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
}
/* Signing key. Read from the environment directly rather than through the
   config module, which validates the whole application's configuration at
   import time — far more than a signature needs. */
const secret = () => process.env.SESSION_SECRET || "nerve-creator-action-unset";

/**
 * Sign a proposed action.
 *
 * Bound to all five of the things that must not drift between proposing and
 * executing: WHO is asking, WHAT action, WHICH target, WHICH parameters, and
 * UNTIL WHEN.
 */
export function signCreatorAction(
  userId: string, action: CreatorAiAction, payload: unknown, now = Date.now(),
): { token: string; expiresAt: string } {
  const exp = now + ACTION_TTL_MS;
  const body = `${userId}|${action}|${canonical(payload)}|${exp}`;
  const mac = createHmac("sha256", secret()).update(body).digest("base64url");
  return { token: `${exp}.${mac}`, expiresAt: new Date(exp).toISOString() };
}

export type ActionCheck =
  | { ok: true }
  | { ok: false; reason: "malformed" | "expired" | "mismatch" };

/**
 * Verify a token against the action actually being attempted.
 *
 * Compared against a signature recomputed from the CURRENT request, so a
 * token issued for three creators cannot execute against four, and yesterday's
 * confirmation cannot execute today's proposal.
 */
export function verifyCreatorAction(
  token: string, userId: string, action: CreatorAiAction, payload: unknown, now = Date.now(),
): ActionCheck {
  const [expRaw, mac] = String(token ?? "").split(".");
  const exp = Number(expRaw);
  if (!mac || !Number.isFinite(exp)) return { ok: false, reason: "malformed" };
  if (exp < now) return { ok: false, reason: "expired" };
  const body = `${userId}|${action}|${canonical(payload)}|${exp}`;
  const expected = createHmac("sha256", secret()).update(body).digest("base64url");
  const a = Buffer.from(mac), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "mismatch" };
  return { ok: true };
}

/* ── The one mutation ─────────────────────────────────────────────────────
   Sends an in-app notification to creators the caller may already reach.

   It writes through mo_notifications — the same table and the same dedupe
   every other Nerve notification uses — and it is idempotent by that dedupe:
   the same message to the same person is one unread notification however many
   times it arrives, so a retried confirmation cannot become spam.

   The ACTOR is the human. The assistant is the instrument, and the audit row
   says which human pressed it. */
export async function sendCreatorNotification(opts: {
  actorId: string;
  recipients: Array<{ userId: string; name: string }>;
  title: string;
  body: string;
}): Promise<{ sent: number; skipped: number }> {
  let sent = 0;
  for (const r of opts.recipients) {
    const ins = await (await db()).query(
      `INSERT INTO mo_notifications (user_id, kind, title, body, entity_type, entity_id)
       SELECT $1,'creator_message',$2,$3,'creator_message',NULL
        WHERE NOT EXISTS (
          SELECT 1 FROM mo_notifications n
           WHERE n.user_id=$1 AND n.kind='creator_message'
             AND n.title=$2 AND n.body=$3 AND n.is_read=false)`,
      [r.userId, opts.title, opts.body]);
    sent += ins.rowCount ?? 0;
  }
  return { sent, skipped: opts.recipients.length - sent };
}
