// @vitest-environment node
/* ═══════════════════════════════════════════════════════════════════════════
   UNIT — the canonical equipment rules.

   These are the rules that used to live in the browser, where the endpoints
   behind them did not apply them. They are pure functions now, so this file
   pins the POLICY, and the integration suite pins that the endpoints actually
   ask these functions.

   Every expectation below is traced to a statement already in the repository:
   BR-7 and BR-8 from the Spec Coverage table, AUTO-3's thresholds from the
   seeded mo_automation_rules row, VR-8 from the booking endpoint.
   ═══════════════════════════════════════════════════════════════════════════ */
import { describe, it, expect } from "vitest";
import {
  canBook, canCheckIn, canCheckOut, canRetire, canTransition, escalationFor, overdueRecipients,
  isConditionDrop, overdueConfig, overdueDays, DEFAULT_OVERDUE_CONFIG, MAX_BOOKING_DAYS,
} from "./equipment-rules.js";

const cfg = DEFAULT_OVERDUE_CONFIG;
const base = {
  itemStatus: "available" as const, alreadyOut: false,
  borrowerWorstOverdueDays: 0, borrowerId: "u1", config: cfg,
};

describe("BR-8 — a condition DROP opens a damage report", () => {
  /* The server's old rule was absolute ("fair or poor is damage"). It
     disagreed with the browser in both directions; these two cases are the
     disagreement, and they are the reason this rule now has one home. */
  it("opens one when the item comes back worse than it went out", () => {
    expect(isConditionDrop("excellent", "good")).toBe(true);
    expect(isConditionDrop("good", "poor")).toBe(true);
    expect(isConditionDrop("fair", "poor")).toBe(true);
  });

  it("does NOT open one for an item returned exactly as it was lent", () => {
    // The old absolute rule opened a damage report here, every single time a
    // well-used 'fair' item came back unchanged.
    expect(isConditionDrop("fair", "fair")).toBe(false);
    expect(isConditionDrop("poor", "poor")).toBe(false);
  });

  it("does NOT open one for an item returned better than it was lent", () => {
    expect(isConditionDrop("poor", "excellent")).toBe(false);
    expect(isConditionDrop("good", "excellent")).toBe(false);
  });

  it("stays silent when there is no checkout condition to compare against", () => {
    expect(isConditionDrop(null, "poor")).toBe(false);
  });
});

describe("BR-7 — what blocks a checkout", () => {
  it("lets an available item go to a borrower in good standing", () => {
    expect(canCheckOut(base)).toEqual({ ok: true });
  });

  it("blocks an unserviceable item", () => {
    for (const s of ["maintenance", "retired", "lost"] as const) {
      const v = canCheckOut({ ...base, itemStatus: s });
      expect(v.ok, s).toBe(false);
      if (!v.ok) expect(v.code).toBe("BR-7_UNSERVICEABLE");
    }
  });

  it("blocks an item that is already in somebody's hands", () => {
    const v = canCheckOut({ ...base, alreadyOut: true });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe("BR-7_ALREADY_OUT");
  });

  it("blocks a borrower at the configured overdue threshold, and not before", () => {
    // The seeded rule blocks at 7 days.
    expect(canCheckOut({ ...base, borrowerWorstOverdueDays: 6 }).ok).toBe(true);
    const v = canCheckOut({ ...base, borrowerWorstOverdueDays: 7 });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe("BR-7_OVERDUE_HOLDER");
    expect(canCheckOut({ ...base, borrowerWorstOverdueDays: 40 }).ok).toBe(false);
  });

  it("honours a changed threshold rather than a hardcoded 7", () => {
    const strict = { ...cfg, block_after_days: 2 };
    expect(canCheckOut({ ...base, borrowerWorstOverdueDays: 1, config: strict }).ok).toBe(true);
    expect(canCheckOut({ ...base, borrowerWorstOverdueDays: 2, config: strict }).ok).toBe(false);
  });

  it("blocks when somebody else has it reserved for today", () => {
    const v = canCheckOut({ ...base, conflictingBookingHolder: "u2" });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe("BR-7_BOOKING_CONFLICT");
  });

  it("does NOT block the person who made the reservation", () => {
    expect(canCheckOut({ ...base, conflictingBookingHolder: "u1" }).ok).toBe(true);
  });
});

describe("check-in requires a checkout", () => {
  it("accepts a return of an item that is out", () => {
    expect(canCheckIn("checked_out", true)).toEqual({ ok: true });
  });

  it("refuses to 'return' an item that was never taken", () => {
    const v = canCheckIn("available", false);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe("NOT_CHECKED_OUT");
  });
});

describe("overdue arithmetic", () => {
  it("counts the first late day as day 1", () => {
    expect(overdueDays("2026-09-10", "2026-09-10")).toBe(0);
    expect(overdueDays("2026-09-10", "2026-09-11")).toBe(1);
    expect(overdueDays("2026-09-10", "2026-09-17")).toBe(7);
  });

  it("is zero for a loan not yet due, and for one with no due date", () => {
    expect(overdueDays("2026-09-20", "2026-09-10")).toBe(0);
    expect(overdueDays(null, "2026-09-10")).toBe(0);
  });
});

describe("AUTO-3 — who hears about it, and when", () => {
  it("tells nobody while the loan is still current", () => {
    expect(escalationFor(0, cfg)).toEqual({ holder: false, custodian: false, leadership: false });
  });

  it("tells the holder and the custodian from the first late day", () => {
    expect(escalationFor(1, cfg)).toEqual({ holder: true, custodian: true, leadership: false });
  });

  it("adds leadership at the configured third day — without dropping the others", () => {
    expect(escalationFor(2, cfg)).toEqual({ holder: true, custodian: true, leadership: false });
    expect(escalationFor(3, cfg)).toEqual({ holder: true, custodian: true, leadership: true });
    expect(escalationFor(30, cfg)).toEqual({ holder: true, custodian: true, leadership: true });
  });

  it("reads its thresholds from the stored rule config", () => {
    const c = overdueConfig({ esc_tl_days: 5, block_after_days: 10 });
    expect(c.esc_tl_days).toBe(5);
    expect(c.block_after_days).toBe(10);
    expect(escalationFor(4, c).leadership).toBe(false);
    expect(escalationFor(5, c).leadership).toBe(true);
  });

  it("falls back field by field when the config is absent or nonsense", () => {
    expect(overdueConfig(null)).toEqual(DEFAULT_OVERDUE_CONFIG);
    expect(overdueConfig({ esc_tl_days: -4, block_after_days: "soon" })).toEqual(DEFAULT_OVERDUE_CONFIG);
  });
});

describe("status transitions and retirement", () => {
  it("allows the ordinary manual moves", () => {
    expect(canTransition("available", "maintenance")).toEqual({ ok: true });
    expect(canTransition("maintenance", "available")).toEqual({ ok: true });
    expect(canTransition("available", "lost")).toEqual({ ok: true });
  });

  it("treats retirement as final", () => {
    const v = canTransition("retired", "available");
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe("RETIRED_IS_FINAL");
  });

  it("refuses to set 'checked_out' by hand — that belongs to the ledger", () => {
    expect(canTransition("available", "checked_out").ok).toBe(false);
  });

  it("will not retire an asset that is in somebody's hands", () => {
    const v = canRetire("checked_out", true);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe("RETIRE_WHILE_OUT");
    expect(canRetire("available", false)).toEqual({ ok: true });
  });
});

describe("VR-8 — booking windows", () => {
  it("accepts a normal window", () => {
    expect(canBook("2026-09-01", "2026-09-05")).toEqual({ ok: true });
  });

  it("rejects an end before its start", () => {
    expect(canBook("2026-09-05", "2026-09-01").ok).toBe(false);
  });

  it(`caps a booking at ${MAX_BOOKING_DAYS} days`, () => {
    expect(canBook("2026-09-01", "2026-10-01").ok).toBe(true);    // exactly 30
    const v = canBook("2026-09-01", "2026-10-02");                // 31
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe("VR-8");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   AUTO-3 RECIPIENTS — who is told, not merely which tiers.

   Phase 16 found a cross-scope information leak here. The overdue notice
   carries an ASSET TAG and the NAME OF WHOEVER HOLDS IT, and it went to every
   holder of the equipment_custodian duty and to every media admin AND
   sub_admin, with no reference to which inventory the asset belonged to. Once
   scopes are populated, a custodian of one inventory would be told the tag and
   holder of an asset in another — which the API itself answers 404 for.

   escalationFor() was always unit-tested; the recipients were not, which is
   exactly where the defect survived six phases.
   ═══════════════════════════════════════════════════════════════════════════ */
describe("AUTO-3 — who actually hears about an overdue loan", () => {
  const ALL = { holder: true, custodian: true, leadership: true };
  const custodians = ["cust-a", "cust-b"];
  const leadership = ["admin-1", "lead-1"];
  /** Production passes scopeAllows() against the asset's scope. */
  const onlyA = (uid: string) => uid === "cust-a" || uid === "admin-1";
  const everyone = () => true;

  it("tells the holder about their own loan without any scope check", () => {
    // Nothing is disclosed: they already have the asset in their hands.
    const to = overdueRecipients(ALL, "cust-b", custodians, leadership, () => false);
    expect(to.holder).toBe("cust-b");
  });

  it("tells only the custodians whose scope covers the asset", () => {
    const to = overdueRecipients(ALL, "someone", custodians, leadership, onlyA);
    expect(to.custodians).toEqual(["cust-a"]);
    expect(to.custodians).not.toContain("cust-b");
  });

  it("scope-checks leadership too, because a Team Lead is not an Admin", () => {
    /* The leadership list is media admin/super_admin/sub_admin. A sub_admin is
       a Team Lead, who holds no estate-wide authority in the scope model, so
       they must not learn a tag and a holder this way either. */
    const to = overdueRecipients(ALL, "someone", custodians, leadership, onlyA);
    expect(to.leadership).toEqual(["admin-1"]);
    expect(to.leadership).not.toContain("lead-1");
  });

  it("tells everyone about an UNSCOPED asset, exactly as before scopes existed", () => {
    // The legacy estate must not go quiet the day governance ships.
    const to = overdueRecipients(ALL, "someone", custodians, leadership, everyone);
    expect(to.custodians).toEqual(["cust-a", "cust-b"]);
    expect(to.leadership).toEqual(["admin-1", "lead-1"]);
  });

  it("never tells the holder twice, whatever their other roles", () => {
    const to = overdueRecipients(ALL, "cust-a", custodians, leadership, everyone);
    expect(to.custodians).not.toContain("cust-a");
    expect(to.holder).toBe("cust-a");
  });

  it("never tells a custodian twice via leadership", () => {
    const to = overdueRecipients(ALL, "x", ["admin-1"], leadership, everyone);
    expect(to.custodians).toEqual(["admin-1"]);
    expect(to.leadership).toEqual(["lead-1"]);
  });

  it("respects the escalation tiers — scope narrows, it does not widen", () => {
    const holderOnly = { holder: true, custodian: false, leadership: false };
    const to = overdueRecipients(holderOnly, "someone", custodians, leadership, everyone);
    expect(to.custodians).toEqual([]);
    expect(to.leadership).toEqual([]);
    expect(to.holder).toBe("someone");
  });

  it("tells nobody when the loan is not overdue at all", () => {
    const none = { holder: false, custodian: false, leadership: false };
    const to = overdueRecipients(none, "someone", custodians, leadership, everyone);
    expect(to).toEqual({ holder: null, custodians: [], leadership: [] });
  });
});
