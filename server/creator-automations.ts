/* ═══════════════════════════════════════════════════════════════════════════
   CREATOR NETWORK — automations

   NO SECOND SCHEDULER. This runs on the same five-minute tick as
   runMediaOpsAutomations(), from the same place in server/index.ts, and its
   rules live in the same mo_automation_rules table with the same is_enabled
   toggle. Nerve has one clock.

   NO SECOND NOTIFICATION SYSTEM either: everything writes to mo_notifications
   through the same dedupe idiom Media Ops already uses — an insert guarded by
   NOT EXISTS on an unread notification with the same (user, kind, entity). So
   a rule that runs every five minutes produces one notification, not 288 a
   day, and a duplicate event delivery produces no second effect.

   WHAT THESE RULES MAY DO: notice a condition and tell somebody. That is all.
   None of them awards a point, moves money, approves work, or calls a model —
   a brief is deterministic, and an alert is a count with a threshold.

   NO LOOPS BY CONSTRUCTION: every rule reads operational state and writes only
   notifications, and nothing in Nerve triggers a rule from a notification. The
   graph has no cycle in it to close.
   ═══════════════════════════════════════════════════════════════════════════ */
import { pool } from "./db.js";
import { SIGNAL_THRESHOLDS } from "./creator-analytics.js";

export interface CreatorAutomationRun {
  at: string; notified: number; ranRules: string[]; failures: string[]; durationMs: number;
}
let lastRun: CreatorAutomationRun | null = null;
/** What the Automations screen shows. Never claims a success that did not happen. */
export function creatorAutomationState(): CreatorAutomationRun | null { return lastRun; }

/** The rules, seeded once and then owned by whoever edits them in Nerve. */
export const CREATOR_AUTOMATION_RULES: Array<[string, string, string, string]> = [
  ["CN-1", "Review backlog alert",
   `Submissions awaiting review reach ${SIGNAL_THRESHOLDS.review_backlog.attention}`,
   "Notify Creator Admins once while unread"],
  ["CN-2", "Overdue assignment alert",
   "An assignment is past its deadline and not completed",
   "Notify the creator, once per assignment while unread"],
  ["CN-3", "Completed but not submitted",
   `Completed more than ${SIGNAL_THRESHOLDS.completed_not_sent.grace_days} days ago with no submission`,
   "Notify the creator, once per assignment while unread"],
  ["CN-4", "Submission waiting too long",
   "A submission has been awaiting a verdict for more than 48 hours",
   "Notify Creator Admins, once per submission while unread"],
  ["CN-5", "Competition closing reminder",
   "An active competition ends within 48 hours",
   "Notify registered participants, once per competition while unread"],
  ["CN-6", "Outstanding payable reminder",
   "The financial ledger carries an outstanding balance",
   "Notify Creator Admins once while unread"],
];

export async function seedCreatorAutomationRules(): Promise<void> {
  for (const [key, name, trigger, action] of CREATOR_AUTOMATION_RULES)
    await pool.query(
      `INSERT INTO mo_automation_rules (department_id, rule_key, name, trigger, action, is_enabled, config)
       SELECT 1,$1,$2,$3,$4,true,'{}'::jsonb
        WHERE NOT EXISTS (SELECT 1 FROM mo_automation_rules WHERE rule_key=$1)`,
      [key, name, trigger, action]);
}

/**
 * One pass over the Creator Network's time-based conditions.
 *
 * Every rule is individually gated on its own is_enabled toggle, and a rule
 * that throws is recorded and skipped rather than taking the pass down with
 * it — one broken condition must not silence the other five.
 */
export async function runCreatorNetworkAutomations(): Promise<CreatorAutomationRun> {
  const started = Date.now();
  let notified = 0;
  const ranRules: string[] = [];
  const failures: string[] = [];

  const rules = (await pool.query(
    `SELECT rule_key, is_enabled FROM mo_automation_rules WHERE rule_key LIKE 'CN-%'`)).rows;
  const on = (k: string) => {
    const r = rules.find((x) => x.rule_key === k);
    return r ? !!r.is_enabled : true;      // a rule not yet seeded runs by default
  };

  /* The dedupe. An identical unread notification is never written twice, so a
     five-minute tick is idempotent and a duplicate delivery is a no-op.

     A DEPARTED RECIPIENT IS SKIPPED, NOT AN ERROR. A rule reads a list of
     people and then writes to them, and somebody can be removed in between.
     An existence check in the same statement does not close that race — the
     row is visible in the statement's snapshot and gone by the time the
     foreign key is checked — so the violation itself is caught, and only that
     one: anything else still fails loudly. Losing one notification to a
     departed user is correct; losing the whole pass is not. */
  const notify = async (userId: string, kind: string, title: string, body: string,
                        entityType: string, entityId: number | null) => {
    try {
      const r = await pool.query(
        `INSERT INTO mo_notifications (user_id, kind, title, body, entity_type, entity_id)
         SELECT $1,$2,$3,$4,$5,$6
          WHERE NOT EXISTS (SELECT 1 FROM mo_notifications n
                            WHERE n.user_id=$1 AND n.kind=$2 AND n.entity_type=$5
                              AND COALESCE(n.entity_id,-1)=COALESCE($6::bigint,-1)
                              AND n.is_read=false)`,
        [userId, kind, title, body, entityType, entityId]);
      notified += r.rowCount ?? 0;
    } catch (e) {
      if ((e as { code?: string }).code !== "23503") throw e;   // not a vanished user
    }
  };

  const creatorAdmins = async (): Promise<string[]> => (await pool.query(
    `SELECT user_id FROM mo_creator_profiles WHERE creator_role='creator_admin' AND status='active'
      UNION
     SELECT id FROM users WHERE team='media' AND role='admin' AND status='active'`))
    .rows.map((r) => String(r.user_id ?? r.id));

  const run = async (key: string, fn: () => Promise<void>) => {
    if (!on(key)) return;
    try { await fn(); ranRules.push(key); }
    catch (e) { failures.push(`${key}: ${(e as Error).message.slice(0, 120)}`); }
  };

  // CN-1 — the review queue has grown past the attention threshold.
  await run("CN-1", async () => {
    const n = Number((await pool.query(
      `SELECT COUNT(*)::int c FROM mo_creator_submissions WHERE status='submitted'`)).rows[0].c);
    if (n < SIGNAL_THRESHOLDS.review_backlog.attention) return;
    for (const admin of await creatorAdmins())
      await notify(admin, "creator_signal", "Creator review backlog",
        `${n} creator submission${n === 1 ? " is" : "s are"} awaiting a review verdict.`,
        "creator_signal", null);
  });

  // CN-2 — a creator's own work is past its deadline.
  await run("CN-2", async () => {
    for (const a of (await pool.query(
      `SELECT a.id, a.user_id, a.title, a.deadline FROM mo_creator_assignments a
         JOIN mo_creator_profiles c ON c.user_id = a.user_id AND c.status='active'
        WHERE a.deadline IS NOT NULL
          AND a.deadline < (NOW() AT TIME ZONE 'Asia/Kolkata')::date
          AND a.status NOT IN ('completed','declined','cancelled')
        LIMIT 500`)).rows)
      await notify(String(a.user_id), "creator_overdue", "Assignment past its deadline",
        `“${a.title}” was due ${String(a.deadline).slice(0, 10)}.`, "creator_assignment", Number(a.id));
  });

  // CN-3 — finished, but never handed in.
  await run("CN-3", async () => {
    const grace = SIGNAL_THRESHOLDS.completed_not_sent.grace_days;
    for (const a of (await pool.query(
      `SELECT a.id, a.user_id, a.title FROM mo_creator_assignments a
         JOIN mo_creator_profiles c ON c.user_id = a.user_id AND c.status='active'
        WHERE a.status='completed' AND a.completed_at IS NOT NULL
          AND a.completed_at < NOW() - ($1 || ' days')::interval
          AND NOT EXISTS (SELECT 1 FROM mo_creator_submissions s WHERE s.assignment_id = a.id)
        LIMIT 500`, [grace])).rows)
      await notify(String(a.user_id), "creator_reminder", "Completed work not yet submitted",
        `“${a.title}” was marked complete but nothing has been submitted for review.`,
        "creator_assignment", Number(a.id));
  });

  // CN-4 — a submission has been waiting too long for a verdict.
  await run("CN-4", async () => {
    const waiting = (await pool.query(
      `SELECT s.id, a.title,
              ROUND(EXTRACT(EPOCH FROM (NOW() - s.submitted_at))/3600)::int AS hours
         FROM mo_creator_submissions s
         JOIN mo_creator_assignments a ON a.id = s.assignment_id
        WHERE s.status='submitted' AND s.submitted_at < NOW() - INTERVAL '48 hours'
        ORDER BY s.submitted_at LIMIT 100`)).rows;
    if (!waiting.length) return;
    const admins = await creatorAdmins();
    for (const s of waiting)
      for (const admin of admins)
        await notify(admin, "creator_review", "Submission waiting over 48 hours",
          `“${s.title}” has been awaiting a verdict for ${s.hours} hours.`,
          "creator_submission", Number(s.id));
  });

  // CN-5 — a competition a creator entered is about to close.
  await run("CN-5", async () => {
    for (const p of (await pool.query(
      `SELECT p.user_id, k.id, k.name, k.ends_at FROM mo_creator_competition_participants p
         JOIN mo_creator_competitions k ON k.id = p.competition_id
        WHERE k.status='active' AND p.status='registered'
          AND k.ends_at BETWEEN NOW() AND NOW() + INTERVAL '48 hours'
        LIMIT 500`)).rows)
      await notify(String(p.user_id), "competition", "A competition you entered is closing soon",
        `${p.name} closes on ${String(p.ends_at).slice(0, 10)}.`, "creator_competition", Number(p.id));
  });

  // CN-6 — money is owed. A reminder, never a payment.
  await run("CN-6", async () => {
    const owed = String((await pool.query(
      `SELECT COALESCE(SUM(amount),0)::numeric(12,2) t FROM mo_creator_financial_ledger`)).rows[0].t);
    if (!(Number(owed) > 0)) return;
    for (const admin of await creatorAdmins())
      await notify(admin, "creator_finance", "Creator payouts outstanding",
        `₹${owed} remains payable across the Creator Network.`, "creator_finance", null);
  });

  lastRun = {
    at: new Date().toISOString(), notified, ranRules, failures,
    durationMs: Date.now() - started,
  };
  return lastRun;
}
