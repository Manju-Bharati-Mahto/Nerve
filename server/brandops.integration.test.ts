// @vitest-environment node
/* ═══════════════════════════════════════════════════════════════════════════
   INTEGRATION — BrandOps against a real PostgreSQL.

   These cover the rules a reviewer can't confirm by reading the handler,
   because they depend on the database: the partial unique index that makes
   double-allocation impossible, the approval cascade across sibling rows, the
   status machines, and the fact that history survives the things that look
   like deletions.

   Fixtures are synthetic and removed afterwards. Skips cleanly when no test
   database is reachable, so the suite still runs in CI without one.
   ═══════════════════════════════════════════════════════════════════════════ */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveTestDatabaseUrl } from "./test-db.js";

let dbUp = false;
let q: typeof import("./brandops-queries.js");
let schema: typeof import("./brandops-db.js");
let pool: import("pg").Pool;

const ACTOR = { id: null as unknown as string, full_name: "Test Actor", email: "t@test.local" };

/* Probed at module level: `maybe()` is evaluated while vitest collects the
   describe blocks, before any hook runs. */
{
  try {
    const url = resolveTestDatabaseUrl();
    process.env.DATABASE_URL = url;
    const pg = await import("pg");
    pool = new pg.default.Pool({ connectionString: url });
    await pool.query("SELECT 1");
    q = await import("./brandops-queries.js");
    schema = await import("./brandops-db.js");
    dbUp = true;
  } catch {
    dbUp = false;   // no database here; the suite skips rather than fails
  }
}

const maybe = () => (dbUp ? it : it.skip);

let instituteA = "";
let instituteB = "";
let vendorA = "";
let vendorB = "";

async function freshFrame(size = "TEST-SIZE"): Promise<{ id: string; asset_id: string }> {
  const f = await q.createFrame(ACTOR, { size, assetId: `TST-${Math.random().toString(36).slice(2, 9).toUpperCase()}` });
  return { id: f.id, asset_id: f.asset_id };
}

beforeAll(async () => {
  if (!dbUp) return;
  await schema.bootstrapBrandOpsDatabase();
  const institutes = await q.listInstitutes();
  instituteA = institutes[0].id;
  instituteB = institutes[1].id;
  vendorA = (await q.createVendor(ACTOR, { name: `TST Vendor A ${Date.now()}`, phone: "1", address: "" })).id;
  vendorB = (await q.createVendor(ACTOR, { name: `TST Vendor B ${Date.now()}`, phone: "2", address: "" })).id;
}, 60_000);

afterAll(async () => {
  if (!dbUp) return;
  // Synthetic rows only — seeded institutes and frames are left alone.
  // Order matters: the schema deliberately refuses to delete a vendor that
  // quotations reference, so the downstream rows go first.
  await pool.query(`DELETE FROM bo_work_orders WHERE vendor_id IN (SELECT id FROM bo_vendors WHERE name LIKE 'TST Vendor%')`);
  await pool.query(`DELETE FROM bo_quotations WHERE vendor_id IN (SELECT id FROM bo_vendors WHERE name LIKE 'TST Vendor%')`);
  await pool.query(`DELETE FROM bo_requests WHERE created_by IS NULL AND work_type IN ('Gate branding','Signage')`);
  await pool.query(`DELETE FROM bo_deliveries WHERE description = 'Convocation certificates'`);
  await pool.query(`DELETE FROM bo_frames WHERE asset_id LIKE 'TST-%'`);
  await pool.query(`DELETE FROM bo_vendors WHERE name LIKE 'TST Vendor%'`);
  await pool.query(`DELETE FROM bo_institutes WHERE name LIKE 'TST Institute%'`);
  await pool.query(`DELETE FROM bo_activity WHERE actor_name = 'Test Actor'`);
  await pool.end();
}, 60_000);

describe("the frame sheet", () => {
  maybe()("loads the line items, not the sheet's own Total", () => {
    // The sheet contradicts itself. The line items carry the detail, so they
    // win — and the stated total is kept so the UI can show the discrepancy.
    expect(schema.FRAME_SHEET_LINE_TOTAL).toBe(214);
    expect(schema.FRAME_SHEET_STATED_TOTAL).toBe(206);
    expect(schema.FRAME_SHEET_LINE_TOTAL).not.toBe(schema.FRAME_SHEET_STATED_TOTAL);
  });

  maybe()("seeded every line item as its own individually-tracked asset", async () => {
    const { rows } = await pool.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM bo_frames WHERE asset_id LIKE 'PU-BR-%'`);
    expect(Number(rows[0].c)).toBe(214);
  });

  maybe()("gives identical frames distinct asset ids", async () => {
    const { rows } = await pool.query<{ asset_id: string }>(
      `SELECT asset_id FROM bo_frames WHERE size = '10x10' ORDER BY asset_id`);
    expect(rows.length).toBe(15);
    expect(new Set(rows.map(r => r.asset_id)).size).toBe(15);
  });
});

describe("allocation", () => {
  maybe()("sends a specific frame out and brings it back", async () => {
    const f = await freshFrame();
    await q.allocateFrame(ACTOR, {
      frameId: f.id, instituteId: instituteA, location: "Main Gate",
      event: "Orientation", from: "2026-10-05", until: "2026-10-12",
    });
    const out = await q.getFrame(f.id);
    expect(out?.status).toBe("in_use");
    expect(out?.institute_id).toBe(instituteA);

    await q.returnFrame(ACTOR, { frameId: f.id, condition: "Good", location: "Store Room A" });
    const back = await q.getFrame(f.id);
    expect(back?.status).toBe("available");
    expect(back?.institute_id).toBeNull();
  });

  maybe()("keeps the calendar day it was given, without a timezone shift", async () => {
    // A DATE read back as a local-midnight Date serialises to the previous day
    // anywhere east of UTC. This is the regression guard for that.
    const f = await freshFrame();
    await q.allocateFrame(ACTOR, {
      frameId: f.id, instituteId: instituteA, location: "X",
      event: "", from: "2026-10-05", until: "2026-10-12",
    });
    const [a] = await q.listAllocations({ frameId: f.id, open: true });
    expect(a.from_date).toBe("2026-10-05");
    expect(a.until_date).toBe("2026-10-12");
  });

  maybe()("refuses to allocate a frame that is already out", async () => {
    const f = await freshFrame();
    const args = {
      frameId: f.id, instituteId: instituteA, location: "A",
      event: "", from: "2026-10-05", until: "2026-10-12",
    };
    await q.allocateFrame(ACTOR, args);
    await expect(q.allocateFrame(ACTOR, { ...args, instituteId: instituteB }))
      .rejects.toThrow(/already deployed/i);
  });

  maybe()("cannot double-book even when two allocations race", async () => {
    // The status check alone would let both through; the partial unique index
    // is what actually makes this safe.
    const f = await freshFrame();
    const attempt = (location: string) => q.allocateFrame(ACTOR, {
      frameId: f.id, instituteId: instituteA, location,
      event: "", from: "2026-10-05", until: "2026-10-12",
    });
    const results = await Promise.allSettled([attempt("A"), attempt("B"), attempt("C")]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);

    const open = await q.listAllocations({ frameId: f.id, open: true });
    expect(open).toHaveLength(1);
  });

  maybe()("refuses a backwards date range", async () => {
    const f = await freshFrame();
    await expect(q.allocateFrame(ACTOR, {
      frameId: f.id, instituteId: instituteA, location: "A",
      event: "", from: "2026-10-12", until: "2026-10-05",
    })).rejects.toThrow(/cannot be before/i);
  });

  maybe()("refuses to receive back a frame that was never out", async () => {
    const f = await freshFrame();
    await expect(q.returnFrame(ACTOR, { frameId: f.id })).rejects.toThrow(/not currently deployed/i);
  });

  maybe()("keeps the movement history after the frame comes back", async () => {
    const f = await freshFrame();
    await q.allocateFrame(ACTOR, {
      frameId: f.id, instituteId: instituteA, location: "Gate",
      event: "Convocation", from: "2026-10-05", until: "2026-10-12",
    });
    await q.returnFrame(ACTOR, { frameId: f.id, condition: "Damaged", remarks: "Bent corner" });

    const history = await q.listAllocations({ frameId: f.id });
    expect(history).toHaveLength(1);
    expect(history[0].returned_at).not.toBeNull();
    expect(history[0].return_condition).toBe("Damaged");
    expect(history[0].event).toBe("Convocation");
  });
});

describe("removing things that hold history", () => {
  maybe()("retires a frame instead of deleting it, so its history survives", async () => {
    const f = await freshFrame();
    await q.allocateFrame(ACTOR, {
      frameId: f.id, instituteId: instituteA, location: "Gate",
      event: "E", from: "2026-10-05", until: "2026-10-12",
    });
    await q.returnFrame(ACTOR, { frameId: f.id });
    await q.retireFrame(ACTOR, f.id);

    expect((await q.listFrames()).find(x => x.id === f.id)).toBeUndefined();
    const { rows } = await pool.query(`SELECT 1 FROM bo_frame_allocations WHERE frame_id = $1`, [f.id]);
    expect(rows).toHaveLength(1);
  });

  maybe()("refuses to retire a frame that is physically out", async () => {
    const f = await freshFrame();
    await q.allocateFrame(ACTOR, {
      frameId: f.id, instituteId: instituteA, location: "Gate",
      event: "", from: "2026-10-05", until: "2026-10-12",
    });
    await expect(q.retireFrame(ACTOR, f.id)).rejects.toThrow(/Receive it back/i);
  });

  maybe()("refuses to remove an institute still holding frames", async () => {
    const inst = await q.createInstitute(ACTOR, `TST Institute ${Date.now()}`, "Testing");
    const f = await freshFrame();
    await q.allocateFrame(ACTOR, {
      frameId: f.id, instituteId: inst.id, location: "Gate",
      event: "", from: "2026-10-05", until: "2026-10-12",
    });
    await expect(q.deleteInstitute(ACTOR, inst.id)).rejects.toThrow(/still holds 1 frame/i);
  });
});

describe("quotations and approval", () => {
  async function requirement() {
    return q.createRequest(ACTOR, {
      instituteId: instituteA, requiredDate: "2026-11-01", workType: "Gate branding",
      priority: "high", description: "Arch branding", location: "Gate", quantity: 1,
    });
  }

  maybe()("moves a requirement to 'quoted' as soon as it has a quotation", async () => {
    const r = await requirement();
    expect(r.status).toBe("pending");
    await q.createQuotation(ACTOR, { requestId: r.id, vendorId: vendorA, amount: 25000, quoteDate: "2026-10-10" });
    const after = (await q.listRequests()).find(x => x.id === r.id);
    expect(after?.status).toBe("quoted");
  });

  maybe()("approving one quotation rejects the competing ones", async () => {
    const r = await requirement();
    const q1 = await q.createQuotation(ACTOR, { requestId: r.id, vendorId: vendorA, amount: 25000, quoteDate: "2026-10-10" });
    const q2 = await q.createQuotation(ACTOR, { requestId: r.id, vendorId: vendorB, amount: 21500, quoteDate: "2026-10-10" });

    await q.decideQuotation(ACTOR, q2.id, "approved", "Lowest");

    const all = await q.listQuotations({ requestId: r.id });
    expect(all.find(x => x.id === q2.id)?.status).toBe("approved");
    expect(all.find(x => x.id === q1.id)?.status).toBe("rejected");
    expect((await q.listRequests()).find(x => x.id === r.id)?.status).toBe("approved");
  });

  maybe()("cannot approve a second quotation on the same requirement", async () => {
    const r = await requirement();
    const q1 = await q.createQuotation(ACTOR, { requestId: r.id, vendorId: vendorA, amount: 100, quoteDate: "2026-10-10" });
    const q2 = await q.createQuotation(ACTOR, { requestId: r.id, vendorId: vendorB, amount: 200, quoteDate: "2026-10-10" });
    await q.decideQuotation(ACTOR, q1.id, "approved");
    // q2 was auto-rejected, so deciding it again is a conflict either way.
    await expect(q.decideQuotation(ACTOR, q2.id, "approved")).rejects.toThrow(/already been/i);
  });

  maybe()("refuses to decide the same quotation twice", async () => {
    const r = await requirement();
    const only = await q.createQuotation(ACTOR, { requestId: r.id, vendorId: vendorA, amount: 500, quoteDate: "2026-10-10" });
    await q.decideQuotation(ACTOR, only.id, "rejected", "Too expensive");
    await expect(q.decideQuotation(ACTOR, only.id, "approved")).rejects.toThrow(/already been rejected/i);
  });
});

describe("work orders", () => {
  async function approvedRequirement() {
    const r = await q.createRequest(ACTOR, {
      instituteId: instituteA, requiredDate: "2026-11-01", workType: "Signage",
      priority: "normal", description: "Board", location: "", quantity: 1,
    });
    const quote = await q.createQuotation(ACTOR, { requestId: r.id, vendorId: vendorA, amount: 9000, quoteDate: "2026-10-10" });
    await q.decideQuotation(ACTOR, quote.id, "approved");
    return r;
  }

  maybe()("cannot be raised before a quotation is approved", async () => {
    const r = await q.createRequest(ACTOR, {
      instituteId: instituteA, requiredDate: "2026-11-01", workType: "Signage",
      priority: "normal", description: "Board", location: "", quantity: 1,
    });
    await expect(q.createWorkOrder(ACTOR, { requestId: r.id, assignedDate: "2026-10-15" }))
      .rejects.toThrow(/no approved quotation/i);
  });

  maybe()("takes its vendor and amount from the approved quote", async () => {
    const r = await approvedRequirement();
    const wo = await q.createWorkOrder(ACTOR, { requestId: r.id, assignedDate: "2026-10-15" });
    expect(wo.vendor_id).toBe(vendorA);
    expect(Number(wo.amount)).toBe(9000);
    expect(wo.assigned_date).toBe("2026-10-15");
  });

  maybe()("allows only one work order per requirement", async () => {
    const r = await approvedRequirement();
    await q.createWorkOrder(ACTOR, { requestId: r.id, assignedDate: "2026-10-15" });
    await expect(q.createWorkOrder(ACTOR, { requestId: r.id, assignedDate: "2026-10-16" }))
      .rejects.toThrow(/already exists/i);
  });

  maybe()("refuses to skip steps in the status flow", async () => {
    const r = await approvedRequirement();
    const wo = await q.createWorkOrder(ACTOR, { requestId: r.id, assignedDate: "2026-10-15" });
    await expect(q.setWorkOrderStatus(ACTOR, wo.id, "verified")).rejects.toThrow(/can't move straight to/i);
    await expect(q.setWorkOrderStatus(ACTOR, wo.id, "closed")).rejects.toThrow(/can't move straight to/i);
  });

  maybe()("refuses to verify work with no photographic evidence", async () => {
    const r = await approvedRequirement();
    const wo = await q.createWorkOrder(ACTOR, { requestId: r.id, assignedDate: "2026-10-15" });
    await q.setWorkOrderStatus(ACTOR, wo.id, "in_progress");
    await q.setWorkOrderStatus(ACTOR, wo.id, "completed");
    await expect(q.setWorkOrderStatus(ACTOR, wo.id, "verified")).rejects.toThrow(/at least one photo/i);

    await q.addPhoto(ACTOR, { workOrderId: wo.id, phase: "after", filePath: "/uploads/brandops/x.png", originalName: "x.png" });
    await q.setWorkOrderStatus(ACTOR, wo.id, "verified");
    expect((await q.getWorkOrder(wo.id))?.status).toBe("verified");
  });

  maybe()("closes the requirement when the work order closes", async () => {
    const r = await approvedRequirement();
    const wo = await q.createWorkOrder(ACTOR, { requestId: r.id, assignedDate: "2026-10-15" });
    await q.setWorkOrderStatus(ACTOR, wo.id, "in_progress");
    await q.setWorkOrderStatus(ACTOR, wo.id, "completed");
    await q.addPhoto(ACTOR, { workOrderId: wo.id, phase: "after", filePath: "/uploads/brandops/y.png", originalName: "y.png" });
    await q.setWorkOrderStatus(ACTOR, wo.id, "verified");
    await q.setWorkOrderStatus(ACTOR, wo.id, "closed");
    expect((await q.listRequests()).find(x => x.id === r.id)?.status).toBe("closed");
  });

  maybe()("will not let a vendor check in twice without checking out", async () => {
    const r = await approvedRequirement();
    const wo = await q.createWorkOrder(ACTOR, { requestId: r.id, assignedDate: "2026-10-15" });
    await q.checkIn(ACTOR, wo.id);
    await expect(q.checkIn(ACTOR, wo.id)).rejects.toThrow(/already checked in/i);
    await q.checkOut(ACTOR, wo.id);
    await q.checkIn(ACTOR, wo.id);   // a second visit is fine once the first closed
    expect((await q.listVisits({ workOrderId: wo.id }))).toHaveLength(2);
  });

  maybe()("refuses a check-out with nobody on site", async () => {
    const r = await approvedRequirement();
    const wo = await q.createWorkOrder(ACTOR, { requestId: r.id, assignedDate: "2026-10-15" });
    await expect(q.checkOut(ACTOR, wo.id)).rejects.toThrow(/not checked in/i);
  });
});

describe("material delivery", () => {
  async function delivery() {
    return q.createDelivery(ACTOR, {
      instituteId: instituteA, materialType: "Certificate",
      description: "Convocation certificates", quantity: 500,
    });
  }

  maybe()("walks awaiting → ready → collected and no further", async () => {
    const d = await delivery();
    expect(d.status).toBe("awaiting");
    await q.advanceDelivery(ACTOR, d.id, "ready");
    await q.advanceDelivery(ACTOR, d.id, "collected", "Dr Shah");
    const done = (await q.listDeliveries()).find(x => x.id === d.id);
    expect(done?.status).toBe("collected");
    expect(done?.collected_by_name).toBe("Dr Shah");
    await expect(q.advanceDelivery(ACTOR, d.id, "ready")).rejects.toThrow(/can't move/i);
  });

  maybe()("refuses to skip receiving", async () => {
    const d = await delivery();
    await expect(q.advanceDelivery(ACTOR, d.id, "collected")).rejects.toThrow(/can't move/i);
  });

  maybe()("refuses to notify an institute before the material arrives", async () => {
    const d = await delivery();
    await expect(q.notifyDelivery(ACTOR, d.id)).rejects.toThrow(/before notifying/i);
    await q.advanceDelivery(ACTOR, d.id, "ready");
    await q.notifyDelivery(ACTOR, d.id);
    expect((await q.listDeliveries()).find(x => x.id === d.id)?.notified_at).not.toBeNull();
  });
});

describe("the activity log", () => {
  maybe()("records what happened in human terms, not row ids", async () => {
    const f = await freshFrame();
    await q.allocateFrame(ACTOR, {
      frameId: f.id, instituteId: instituteA, location: "Main Gate",
      event: "Orientation", from: "2026-10-05", until: "2026-10-12",
    });
    const [entry] = await q.listActivity({ module: "Frame Allocation", limit: 1 });
    expect(entry.action).toBe("Frame allocated");
    expect(entry.details).toContain(f.asset_id);
    expect(entry.details).toContain("Main Gate");
  });

  maybe()("can be filtered by module and free text", async () => {
    const byModule = await q.listActivity({ module: "Frame Inventory" });
    expect(byModule.every(e => e.module === "Frame Inventory")).toBe(true);
    const bySearch = await q.listActivity({ q: "no such thing anywhere" });
    expect(bySearch).toEqual([]);
  });
});

describe("KPIs", () => {
  maybe()("count the same frames the inventory list shows", async () => {
    const [k, frames] = await Promise.all([q.kpis(), q.listFrames()]);
    expect(k.totalFrames).toBe(frames.length);
    expect(k.available + k.inUse).toBe(k.totalFrames);
    expect(k.sheetLineTotal).toBe(214);
  });

  maybe()("flag a frame whose return date has passed as overdue", async () => {
    const f = await freshFrame();
    await q.allocateFrame(ACTOR, {
      frameId: f.id, instituteId: instituteA, location: "Gate",
      event: "", from: "2020-01-01", until: "2020-01-02",
    });
    expect((await q.kpis()).overdue).toBeGreaterThan(0);
  });
});
