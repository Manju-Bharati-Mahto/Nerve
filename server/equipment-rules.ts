/* ═══════════════════════════════════════════════════════════════════════════
   EQUIPMENT BUSINESS RULES — the one authoritative implementation.

   These rules already existed. They existed in the BROWSER, which is the
   problem: BR-7 refused a checkout in `ACTIONS.checkout` and the endpoint
   behind it accepted the same request, and BR-8 was implemented twice with two
   different meanings, so a check-in could open a damage report on one side and
   not the other. `moSync()` then re-hydrated from the server and the user
   watched their screen change its mind.

   Nothing here is new policy. Every rule below is transcribed from what the
   repository already stated:

     BR-7  "Checkout blocked on maintenance, overdue holder, conflict"
           — the Spec Coverage table in public/media-ops/index.html
     BR-8  "Check-in condition drop auto-opens a damage report"
           — the same table
     AUTO-3 "Holder → +custodian on overdue → +TL/Admin at 3d; blocks new
            checkouts per BR-7", config {esc_tl_days: 3, block_after_days: 7}
           — the seeded mo_automation_rules row in mediaops-db.ts
     VR-8  a booking may not exceed 30 days
           — already enforced by POST /equipment/bookings

   The thresholds stay in mo_automation_rules where an Admin can already edit
   them; this module takes them as an argument rather than hardcoding 3 and 7.

   Everything here is a pure function. The API calls them, the tests call them,
   and the browser is told the answer rather than working it out again.
   ═══════════════════════════════════════════════════════════════════════════ */

export type Condition = "excellent" | "good" | "fair" | "poor";
export type ItemStatus = "available" | "checked_out" | "booked" | "maintenance" | "retired" | "lost";

/** Better is higher. BR-8 asks whether the return is LOWER than the checkout. */
export const CONDITION_RANK: Record<Condition, number> = {
  excellent: 4, good: 3, fair: 2, poor: 1,
};

export const CONDITIONS = Object.keys(CONDITION_RANK) as Condition[];
export const isCondition = (v: unknown): v is Condition =>
  typeof v === "string" && v in CONDITION_RANK;

/** AUTO-3's tunables, as stored in mo_automation_rules.config. */
export interface OverdueConfig {
  /** Days overdue before the custodian is copied. The seed says 0 — at once. */
  esc_custodian_days: number;
  /** Days overdue before a Team Lead / Admin is copied. The seed says 3. */
  esc_tl_days: number;
  /** Days overdue after which the holder may not take anything else. Seed: 7. */
  block_after_days: number;
}

export const DEFAULT_OVERDUE_CONFIG: OverdueConfig = {
  esc_custodian_days: 0, esc_tl_days: 3, block_after_days: 7,
};

/** Read the config off a stored rule row, falling back field by field. */
export function overdueConfig(raw: unknown): OverdueConfig {
  const c = (raw ?? {}) as Partial<Record<keyof OverdueConfig, unknown>>;
  const num = (v: unknown, d: number) =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : d;
  return {
    esc_custodian_days: num(c.esc_custodian_days, DEFAULT_OVERDUE_CONFIG.esc_custodian_days),
    esc_tl_days:        num(c.esc_tl_days,        DEFAULT_OVERDUE_CONFIG.esc_tl_days),
    block_after_days:   num(c.block_after_days,   DEFAULT_OVERDUE_CONFIG.block_after_days),
  };
}

/** VR-8 — the longest window a single booking may cover. */
export const MAX_BOOKING_DAYS = 30;

/** An item in one of these states is not lendable. BR-7's first clause. */
export const UNSERVICEABLE: ItemStatus[] = ["maintenance", "retired", "lost"];

/** Whole days between two dates, floor, never negative for same-day. */
export function daysBetween(from: Date | string, to: Date | string): number {
  const a = typeof from === "string" ? new Date(from + "T00:00:00Z") : from;
  const b = typeof to === "string" ? new Date(to + "T00:00:00Z") : to;
  return Math.floor((b.getTime() - a.getTime()) / 86_400_000);
}

/**
 * How many days past its due date a loan is. 0 means due today or not yet due;
 * the first day a thing is late is day 1.
 */
export function overdueDays(expectedReturnAt: string | Date | null, now: Date | string): number {
  if (!expectedReturnAt) return 0;
  return Math.max(0, daysBetween(expectedReturnAt, now));
}

/* ── BR-8 ─────────────────────────────────────────────────────────────────
   "Check-in condition drop auto-opens a damage report."

   The RELATIVE reading is the canonical one, and it is what the browser did.
   The server's old absolute rule ("fair or poor is damage") disagreed in both
   directions: it opened a report on a battered-but-unchanged item returned
   exactly as lent, and it stayed silent on a pristine item returned merely
   good. Compared against the condition RECORDED AT CHECKOUT, not against the
   item's current condition column — that column is rewritten by this very
   check-in, so reading it makes the rule depend on the order of writes. */
export function isConditionDrop(atCheckout: Condition | null | undefined, onReturn: Condition): boolean {
  if (!atCheckout) return false;         // nothing to compare against
  return CONDITION_RANK[onReturn] < CONDITION_RANK[atCheckout];
}

/* ── BR-7 ─────────────────────────────────────────────────────────────────
   "Checkout blocked on maintenance, overdue holder, conflict." */

export interface CheckoutRequest {
  itemStatus: ItemStatus;
  /** True when a live check_out transaction exists for this item. */
  alreadyOut: boolean;
  /** Days overdue of the borrower's WORST outstanding loan. 0 if none. */
  borrowerWorstOverdueDays: number;
  /** A reserved/active booking covering today held by somebody else. */
  conflictingBookingHolder?: string | null;
  borrowerId: string;
  config: OverdueConfig;
}

export type RuleVerdict = { ok: true } | { ok: false; code: string; message: string };

export function canCheckOut(r: CheckoutRequest): RuleVerdict {
  if (UNSERVICEABLE.includes(r.itemStatus))
    return { ok: false, code: "BR-7_UNSERVICEABLE",
             message: `BR-7: this item is ${r.itemStatus} and cannot be checked out.` };

  if (r.alreadyOut || r.itemStatus === "checked_out")
    return { ok: false, code: "BR-7_ALREADY_OUT",
             message: "BR-7: this item is already checked out." };

  if (r.borrowerWorstOverdueDays >= r.config.block_after_days && r.config.block_after_days > 0)
    return { ok: false, code: "BR-7_OVERDUE_HOLDER",
             message: `BR-7: blocked — you hold an item ${r.borrowerWorstOverdueDays} days overdue. `
                    + `New checkouts are blocked at ${r.config.block_after_days} days.` };

  if (r.conflictingBookingHolder && r.conflictingBookingHolder !== r.borrowerId)
    return { ok: false, code: "BR-7_BOOKING_CONFLICT",
             message: "BR-7: this item is reserved by somebody else for today." };

  return { ok: true };
}

/** Check-in's precondition: the item has to actually be out. */
export function canCheckIn(itemStatus: ItemStatus, alreadyOut: boolean): RuleVerdict {
  if (!alreadyOut && itemStatus !== "checked_out")
    return { ok: false, code: "NOT_CHECKED_OUT",
             message: "This item is not checked out, so it cannot be checked in." };
  return { ok: true };
}

/* ── Status transitions ───────────────────────────────────────────────────
   Which manual status changes a lifecycle call may make. Movements driven by
   checkout/check-in/damage are not listed: those are made by the endpoints
   that own them, and a human setting 'checked_out' by hand would produce an
   item that is out with nobody holding it. */
const MANUAL_TRANSITIONS: Record<ItemStatus, ItemStatus[]> = {
  available:   ["maintenance", "lost", "retired"],
  checked_out: ["lost"],
  booked:      ["maintenance", "lost", "retired"],
  maintenance: ["available", "retired", "lost"],
  lost:        ["available", "retired"],
  retired:     [],
};

export function canTransition(from: ItemStatus, to: ItemStatus): RuleVerdict {
  if (from === to) return { ok: true };
  if (from === "retired")
    return { ok: false, code: "RETIRED_IS_FINAL",
             message: "A retired asset cannot change status. Its history stays intact." };
  if (!MANUAL_TRANSITIONS[from]?.includes(to))
    return { ok: false, code: "BAD_TRANSITION",
             message: `An asset cannot move from ${from} to ${to} directly.` };
  return { ok: true };
}

/** An asset that is out cannot be retired — it is in somebody's hands. */
export function canRetire(status: ItemStatus, alreadyOut: boolean): RuleVerdict {
  if (status === "retired") return { ok: false, code: "ALREADY_RETIRED", message: "Already retired." };
  if (alreadyOut || status === "checked_out")
    return { ok: false, code: "RETIRE_WHILE_OUT",
             message: "This asset is checked out. Check it in before retiring it." };
  return { ok: true };
}

/* ── AUTO-3 ───────────────────────────────────────────────────────────────
   Who hears about an overdue loan, and when. The seeded rule reads
   "Holder → +custodian on overdue → +TL/Admin at 3d", so each tier is ADDED
   to the ones before it rather than replacing them: at four days the holder is
   still told, and so is the custodian. */
export interface EscalationTargets { holder: boolean; custodian: boolean; leadership: boolean }

export function escalationFor(days: number, config: OverdueConfig): EscalationTargets {
  if (days <= 0) return { holder: false, custodian: false, leadership: false };
  return {
    holder: true,
    custodian: days >= config.esc_custodian_days,
    leadership: days >= config.esc_tl_days,
  };
}

/* AUTO-3's RECIPIENTS — who is actually told, once escalationFor() has said
   which TIERS should hear about an overdue loan.

   Extracted here, pure, for the same reason escalationFor() is: the fan-out
   lives in runMediaOpsAutomations(), which cannot be executed by a test
   without auto-approving leave and writing notifications against every
   unrelated fixture in a shared database. The tiers were already testable;
   the RECIPIENTS were not, and that is where a real cross-scope leak lived
   until Phase 16.

   `mayHear` is the caller's scope check — scopeAllows() against the asset's
   scope, in production. The rule is not restated here, only applied, so there
   is still exactly one implementation of who may see which inventory.

   An UNSCOPED asset makes mayHear true for everyone, so the legacy estate
   notifies exactly as it did before scopes existed. */
export type OverdueRecipients = { holder: string | null; custodians: string[]; leadership: string[] };

export function overdueRecipients(
  who: EscalationTargets,
  holderId: string,
  custodians: readonly string[],
  leadership: readonly string[],
  mayHear: (userId: string) => boolean,
): OverdueRecipients {
  return {
    /* The holder is told about their OWN loan, so there is nothing to
       disclose and no scope check applies. */
    holder: who.holder ? holderId : null,
    custodians: who.custodian
      ? custodians.filter((c) => c !== holderId && mayHear(c))
      : [],
    /* Leadership excludes anyone already told as a custodian, so nobody is
       notified twice — and is scope-checked too, because the list contains
       sub_admins, who are Team Leads rather than Admins and hold no
       estate-wide authority in the scope model. */
    leadership: who.leadership
      ? leadership.filter((l) => l !== holderId && !custodians.includes(l) && mayHear(l))
      : [],
  };
}

/** VR-8, kept beside the rules it belongs with rather than inline in a handler. */
export function canBook(startsAt: string, endsAt: string): RuleVerdict {
  if (!startsAt || !endsAt)
    return { ok: false, code: "DATES_REQUIRED", message: "Booking start and end are required." };
  if (endsAt < startsAt)
    return { ok: false, code: "END_BEFORE_START", message: "Booking end must be on or after the start." };
  if (daysBetween(startsAt, endsAt) > MAX_BOOKING_DAYS)
    return { ok: false, code: "VR-8", message: `VR-8: a booking cannot exceed ${MAX_BOOKING_DAYS} days.` };
  return { ok: true };
}
