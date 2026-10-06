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
  // The requirement/quotation suites below tag their work type, removed rows included.
  await pool.query(`DELETE FROM bo_requests WHERE created_by IS NULL AND work_type LIKE 'TST %'`);
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

  /* A delivery and its proof images are one transaction. Created first and
     imaged second, a failed image left a DEL-xxxx behind while the person was
     told it had failed, and their retry logged the same delivery twice. */
  maybe()("leaves nothing behind when an image cannot be recorded, and does not burn the DEL number", async () => {
    const before = await delivery();
    const n = (ref: string) => Number(ref.replace(/^DEL-/, ""));
    const marker = `TST-ATOMIC-${Date.now()}`;
    await expect(q.createDelivery(ACTOR, {
      instituteId: instituteA, materialType: "Certificate",
      description: "Convocation certificates", quantity: 1, remarks: marker,
      // file_path is NOT NULL: the second image insert fails inside the transaction.
      images: [
        { filePath: "/uploads/brandops/ok.jpg", originalName: "ok.jpg" },
        { filePath: null as unknown as string, originalName: "broken.jpg" },
      ],
    })).rejects.toThrow();

    const left = await pool.query(`SELECT id FROM bo_deliveries WHERE remarks = $1`, [marker]);
    expect(left.rowCount).toBe(0);
    const orphans = await pool.query(
      `SELECT i.id FROM bo_delivery_images i LEFT JOIN bo_deliveries d ON d.id = i.delivery_id
        WHERE d.id IS NULL OR i.file_path = '/uploads/brandops/ok.jpg'`);
    expect(orphans.rowCount).toBe(0);

    // The rolled-back delivery did not take a number: the next one is the one after `before`.
    const after = await delivery();
    expect(n(after.reference)).toBe(n(before.reference) + 1);
  });

  maybe()("records every image with the delivery when they all succeed", async () => {
    const d = await q.createDelivery(ACTOR, {
      instituteId: instituteA, materialType: "Certificate",
      description: "Convocation certificates", quantity: 2,
      images: [
        { filePath: "/uploads/brandops/a.jpg", originalName: "a.jpg" },
        { filePath: "/uploads/brandops/b.jpg", originalName: "b.jpg" },
      ],
    });
    const { rows } = await pool.query<{ file_path: string }>(
      `SELECT file_path FROM bo_delivery_images WHERE delivery_id = $1 ORDER BY file_path`, [d.id]);
    expect(rows.map(r => r.file_path)).toEqual(["/uploads/brandops/a.jpg", "/uploads/brandops/b.jpg"]);
  });
});

/* ── POST /api/brandops/deliveries through Express and multer ───────────────
   The route's half of the promise: when the delivery cannot be created, the
   images multer already wrote to disk are removed, because nothing points at
   them. A real app with a real disk-storage multer in a temp directory; the
   signed-in user is a super admin set straight into res.locals. */
describe("logging a delivery over HTTP", () => {
  let server: import("node:http").Server | null = null;
  let base = "";
  let dir = "";

  beforeAll(async () => {
    if (!dbUp) return;
    const [{ default: express }, { default: multer }, fs, os, nodePath, api, guard] = await Promise.all([
      import("express"), import("multer"), import("node:fs"), import("node:os"), import("node:path"),
      import("./brandops-api.js"), import("./upload-guard.js"),
    ]);
    dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "nerve-bo-test-"));
    const upload = multer({
      storage: multer.diskStorage({
        destination: (_req, _file, cb) => cb(null, dir),
        filename: (_req, file, cb) => cb(null, guard.safeImageName(file)),
      }),
      limits: { fileSize: 1024 * 1024 },
      fileFilter: guard.imageFileFilter,
    });
    const app = express();
    app.use(express.json());
    app.use((_req, res, next) => {
      res.locals.currentUser = { id: null, role: "super_admin", team: null, full_name: "Test Actor", email: "t@test.local" };
      next();
    });
    api.registerBrandOpsApi(app, {
      asyncHandler: fn => (req, res, next) => { void fn(req, res, next).catch(next); },
      sendError: (res, status, message) => { res.status(status).json({ message }); },
      getSingleParam: v => (Array.isArray(v) ? v[0] : v),
      uploadsDir: dir,
      uploadImages: (field, maxFiles) =>
        guard.acceptUpload(upload.array(field, maxFiles), { sizeLabel: "1 MB", maxFiles, field }),
    });
    app.use(guard.jsonErrorHandler);
    await new Promise<void>(resolve => { server = app.listen(0, "127.0.0.1", () => resolve()); });
    base = `http://127.0.0.1:${(server!.address() as import("node:net").AddressInfo).port}`;
  });

  afterAll(async () => {
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    if (dir) (await import("node:fs")).rmSync(dir, { recursive: true, force: true });
  });

  function form(fields: Record<string, string>, images: number): FormData {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.append(k, v);
    for (let i = 0; i < images; i++) {
      fd.append("images", new Blob([new Uint8Array([0xff, 0xd8, 0xff, i])], { type: "image/jpeg" }), `p${i}.jpg`);
    }
    return fd;
  }

  const files = async () => (await import("node:fs")).readdirSync(dir);

  maybe()("deletes the uploaded images when the delivery cannot be created", async () => {
    const marker = `TST-HTTP-${Date.now()}`;
    const res = await fetch(`${base}/api/brandops/deliveries`, {
      method: "POST",
      body: form({
        institute_id: "no-such-institute", material_type: "Certificate",
        description: "Convocation certificates", remarks: marker,
      }, 2),
    });
    expect(res.status).toBe(404);
    expect(await files()).toEqual([]);
    expect((await pool.query(`SELECT id FROM bo_deliveries WHERE remarks = $1`, [marker])).rowCount).toBe(0);
  });

  maybe()("keeps the images, and points at them, when it succeeds", async () => {
    const res = await fetch(`${base}/api/brandops/deliveries`, {
      method: "POST",
      body: form({ institute_id: instituteA, material_type: "Certificate", description: "Convocation certificates" }, 2),
    });
    expect(res.status).toBe(201);
    const { delivery } = await res.json() as { delivery: { id: string } };
    const stored = await files();
    expect(stored).toHaveLength(2);
    const { rows } = await pool.query<{ file_path: string }>(
      `SELECT file_path FROM bo_delivery_images WHERE delivery_id = $1`, [delivery.id]);
    expect(rows.map(r => r.file_path.split("/").pop()).sort()).toEqual([...stored].sort());
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

/* ── Requirements and quotations, as the branding team asked (Oct 2026) ──
   Size, Completed, soft removal and quotation history. Every requirement here
   carries a "TST " work type so afterAll can find it, removed ones included. */

const tag = () => Math.random().toString(36).slice(2, 9).toUpperCase();

async function tstRequirement(extra: Partial<import("./brandops-queries.js").RequestInput> = {}) {
  return q.createRequest(ACTOR, {
    instituteId: instituteA, requiredDate: "2026-11-01", workType: "TST Work",
    priority: "normal", description: "Test requirement", location: "Gate", quantity: 1, ...extra,
  });
}

async function quote(requestId: string, amount: number, vendorId = vendorA) {
  return q.createQuotation(ACTOR, { requestId, vendorId, amount, quoteDate: "2026-10-10" });
}

/** Approved quote, a work order, and the work order pushed to closed. */
async function closeWorkOrder(workOrderId: string) {
  await q.setWorkOrderStatus(ACTOR, workOrderId, "in_progress");
  await q.setWorkOrderStatus(ACTOR, workOrderId, "completed");
  await q.addPhoto(ACTOR, { workOrderId, phase: "after", filePath: "/uploads/brandops/t.png", originalName: "t.png" });
  await q.setWorkOrderStatus(ACTOR, workOrderId, "verified");
  await q.setWorkOrderStatus(ACTOR, workOrderId, "closed");
}

const refNumber = (ref: string) => Number(ref.replace(/^.*-/, ""));

describe("requirement size", () => {
  maybe()("is stored, listed, editable and offered as a suggestion beside the frame sizes", async () => {
    const size = `12x8 ft TST-${tag()}`;
    const r = await tstRequirement({ size: `  ${size}  ` });
    expect(r.size).toBe(size);   // trimmed on the way in
    expect((await q.listRequests()).find(x => x.id === r.id)?.size).toBe(size);
    expect((await q.listRequests({ q: size.toLowerCase() })).map(x => x.id)).toContain(r.id);

    const sizes = await q.requestSizes();
    expect(sizes).toContain(size);
    expect(sizes).toContain("10x10");   // a seeded frame size
    expect(sizes).not.toContain("");

    const edited = `TST-EDIT-${tag()}`;
    const after = await q.updateRequest(ACTOR, r.id, {
      instituteId: instituteA, requiredDate: "2026-11-01", workType: "TST Work",
      priority: "normal", description: "Test requirement", size: edited,
    });
    expect(after.size).toBe(edited);
    expect((await q.getRequest(r.id))?.size).toBe(edited);
    expect(await q.requestSizes()).toContain(edited);
  });

  maybe()("stops suggesting a size once the only requirement using it is removed", async () => {
    const size = `TST-GONE-${tag()}`;
    const r = await tstRequirement({ size });
    expect(await q.requestSizes()).toContain(size);
    await q.removeRequest(ACTOR, r.id);
    expect(await q.requestSizes()).not.toContain(size);
  });
});

describe("removing a requirement", () => {
  maybe()("takes it, and its quotations, off every list and count — but keeps the rows", async () => {
    const r = await tstRequirement();
    const q1 = await quote(r.id, 1000);
    const q2 = await quote(r.id, 900, vendorB);
    const before = await q.kpis();

    await q.removeRequest(ACTOR, r.id, "Duplicate entry");

    // Branding Requests and the Dashboard both read listRequests / getRequest.
    expect((await q.listRequests()).find(x => x.id === r.id)).toBeUndefined();
    expect(await q.getRequest(r.id)).toBeNull();

    const after = await q.kpis();
    expect(after.pendingRequests).toBe(before.pendingRequests - 1);
    expect(after.openQuotations).toBe(before.openQuotations - 2);

    // Quotations and Approvals must not offer a price for work nobody wants.
    const ids = (list: { id: string }[]) => list.map(x => x.id);
    expect(ids(await q.listQuotations())).not.toContain(q1.id);
    expect(ids(await q.listQuotations({ status: "pending" }))).not.toContain(q1.id);
    expect(ids(await q.listQuotations({ status: "pending" }))).not.toContain(q2.id);
    expect(ids(await q.listQuotations({ includeRemoved: true }))).toEqual(expect.arrayContaining([q1.id, q2.id]));

    await expect(q.decideQuotation(ACTOR, q1.id, "approved")).rejects.toMatchObject({ status: 404 });

    const { rows } = await pool.query<{ removed_at: string | null; removal_reason: string }>(
      `SELECT removed_at, removal_reason FROM bo_requests WHERE id = $1`, [r.id]);
    expect(rows[0].removed_at).not.toBeNull();
    expect(rows[0].removal_reason).toBe("Duplicate entry");
  });

  maybe()("is refused while a work order is open, allowed once it closes, and only once", async () => {
    const r = await tstRequirement();
    const qt = await quote(r.id, 5000);
    await q.decideQuotation(ACTOR, qt.id, "approved");
    const wo = await q.createWorkOrder(ACTOR, { requestId: r.id, assignedDate: "2026-10-15" });

    await expect(q.removeRequest(ACTOR, r.id)).rejects.toMatchObject({ status: 409 });
    await expect(q.removeRequest(ACTOR, r.id)).rejects.toThrow(/open work order/i);
    expect(await q.getRequest(r.id)).not.toBeNull();

    await closeWorkOrder(wo.id);
    await q.removeRequest(ACTOR, r.id);
    expect(await q.getRequest(r.id)).toBeNull();

    await expect(q.removeRequest(ACTOR, r.id)).rejects.toMatchObject({ status: 404 });
  });

  maybe()("cannot be edited, completed or quoted once removed", async () => {
    const r = await tstRequirement();
    await q.removeRequest(ACTOR, r.id);
    await expect(q.updateRequest(ACTOR, r.id, {
      instituteId: instituteA, requiredDate: "2026-11-01", workType: "TST Work",
      priority: "normal", description: "x",
    })).rejects.toMatchObject({ status: 404 });
    await expect(q.completeRequest(ACTOR, r.id)).rejects.toMatchObject({ status: 404 });
    await expect(quote(r.id, 100)).rejects.toMatchObject({ status: 404 });
  });
});

describe("requirement references", () => {
  maybe()("never collide after a removal", async () => {
    const made = [await tstRequirement(), await tstRequirement(), await tstRequirement()];
    await q.removeRequest(ACTOR, made[1].id);
    const next = await tstRequirement();

    const { rows } = await pool.query<{ reference: string }>(
      `SELECT reference FROM bo_requests WHERE id <> $1`, [next.id]);
    expect(rows.map(x => x.reference)).not.toContain(next.reference);
    expect(refNumber(next.reference)).toBeGreaterThan(Math.max(...rows.map(x => refNumber(x.reference))));
  });

  maybe()("keep counting past a gap left by a row that really was deleted", async () => {
    // The old COUNT-based numbering handed out an existing reference here and
    // the UNIQUE constraint then refused every creation that followed.
    const first = await tstRequirement();
    const second = await tstRequirement();
    await pool.query(`DELETE FROM bo_requests WHERE id = $1`, [first.id]);
    const third = await tstRequirement();
    expect(refNumber(third.reference)).toBe(refNumber(second.reference) + 1);
  });
});

describe("completing a requirement", () => {
  maybe()("marks a quoted requirement completed, once, and refuses new quotations", async () => {
    const r = await tstRequirement();
    await quote(r.id, 700);
    expect((await q.getRequest(r.id))?.status).toBe("quoted");

    await q.completeRequest(ACTOR, r.id, "  Installed at the gate  ");
    const done = await q.getRequest(r.id);
    expect(done?.status).toBe("completed");
    expect(done?.completed_at).not.toBeNull();
    expect(done?.completion_note).toBe("Installed at the gate");

    await expect(q.completeRequest(ACTOR, r.id)).rejects.toMatchObject({ status: 409 });
    await expect(q.completeRequest(ACTOR, r.id)).rejects.toThrow(/already completed/i);
    await expect(quote(r.id, 650)).rejects.toMatchObject({ status: 409 });
    await expect(q.createQuotation(ACTOR, { requestId: r.id, vendorId: vendorB, amount: 1, quoteDate: "2026-10-10" }))
      .rejects.toThrow(/can't take new quotations/i);
  });

  maybe()("reopens a requirement with no quotations to pending", async () => {
    const r = await tstRequirement();
    await q.completeRequest(ACTOR, r.id);
    expect(await q.reopenRequest(ACTOR, r.id)).toBe("pending");
    const back = await q.getRequest(r.id);
    expect(back?.status).toBe("pending");
    expect(back?.completed_at).toBeNull();
    expect(back?.completion_note).toBe("");
  });

  maybe()("reopens a quoted requirement to quoted", async () => {
    const r = await tstRequirement();
    await quote(r.id, 400);
    await q.completeRequest(ACTOR, r.id);
    expect(await q.reopenRequest(ACTOR, r.id)).toBe("quoted");
    expect((await q.getRequest(r.id))?.status).toBe("quoted");
  });

  maybe()("completes from approved and reopens to approved", async () => {
    const r = await tstRequirement();
    const qt = await quote(r.id, 400);
    await q.decideQuotation(ACTOR, qt.id, "approved");
    await q.completeRequest(ACTOR, r.id);
    expect((await q.getRequest(r.id))?.status).toBe("completed");
    expect(await q.reopenRequest(ACTOR, r.id)).toBe("approved");
  });

  maybe()("reopens to in progress while its work order is still open", async () => {
    const r = await tstRequirement();
    const qt = await quote(r.id, 400);
    await q.decideQuotation(ACTOR, qt.id, "approved");
    await q.createWorkOrder(ACTOR, { requestId: r.id, assignedDate: "2026-10-15" });
    expect((await q.getRequest(r.id))?.status).toBe("in_progress");
    await q.completeRequest(ACTOR, r.id);
    expect(await q.reopenRequest(ACTOR, r.id)).toBe("in_progress");
  });

  maybe()("refuses to reopen a requirement that is not completed", async () => {
    const r = await tstRequirement();
    await expect(q.reopenRequest(ACTOR, r.id)).rejects.toMatchObject({ status: 409 });
    await expect(q.reopenRequest(ACTOR, r.id)).rejects.toThrow(/not completed/i);
  });
});

describe("editing a quotation", () => {
  maybe()("files the old version as a revision and bumps the revision number", async () => {
    const r = await tstRequirement();
    const qt = await q.createQuotation(ACTOR, {
      requestId: r.id, vendorId: vendorA, amount: 1000, quoteDate: "2026-10-10", notes: "First offer",
    });
    expect(qt.revision).toBe(1);

    const edited = await q.updateQuotation(ACTOR, qt.id, { amount: 1200, vendorId: vendorB, notes: "Revised" });
    expect(edited.revision).toBe(2);
    expect(Number(edited.amount)).toBe(1200);
    expect(edited.vendor_id).toBe(vendorB);
    expect(edited.updated_at).not.toBeNull();

    const { quotations } = await q.quotationHistory(r.id);
    const h = quotations.find(x => x.id === qt.id);
    expect(h?.revisions).toHaveLength(1);
    // The revision holds what was REPLACED, not the new figure.
    expect(h?.revisions[0].revision).toBe(1);
    expect(Number(h?.revisions[0].amount)).toBe(1000);
    expect(h?.revisions[0].vendor_name).toBe(qt.vendor_name);
    expect(h?.revisions[0].notes).toBe("First offer");
    expect(h?.revisions[0].quote_date).toBe("2026-10-10");
  });

  maybe()("creates no revision for an edit that changes nothing", async () => {
    const r = await tstRequirement();
    const qt = await quote(r.id, 1000);
    const same = await q.updateQuotation(ACTOR, qt.id, { amount: 1000, quoteDate: "2026-10-10", vendorId: vendorA });
    expect(same.revision).toBe(1);
    const { quotations } = await q.quotationHistory(r.id);
    expect(quotations.find(x => x.id === qt.id)?.revisions).toEqual([]);
  });

  maybe()("locks an approved quotation against edit and removal", async () => {
    const r = await tstRequirement();
    const qt = await quote(r.id, 1000);
    await q.decideQuotation(ACTOR, qt.id, "approved");
    await expect(q.updateQuotation(ACTOR, qt.id, { amount: 1 })).rejects.toMatchObject({ status: 409 });
    await expect(q.removeQuotation(ACTOR, qt.id)).rejects.toMatchObject({ status: 409 });
    const still = (await q.listQuotations({ requestId: r.id })).find(x => x.id === qt.id);
    expect(Number(still?.amount)).toBe(1000);
    expect(still?.removed_at).toBeNull();
  });

  maybe()("refuses to edit a removed quotation", async () => {
    const r = await tstRequirement();
    const qt = await quote(r.id, 1000);
    await q.removeQuotation(ACTOR, qt.id);
    await expect(q.updateQuotation(ACTOR, qt.id, { amount: 5 })).rejects.toMatchObject({ status: 404 });
  });

  maybe()("serialises two simultaneous edits into two sequential revisions", async () => {
    // FOR UPDATE makes the second edit wait for the first and then read its
    // result; without it both would file "revision 1" and one would hit the
    // (quotation_id, revision) unique constraint.
    const r = await tstRequirement();
    const qt = await quote(r.id, 1000);
    const results = await Promise.allSettled([
      q.updateQuotation(ACTOR, qt.id, { amount: 2000 }),
      q.updateQuotation(ACTOR, qt.id, { amount: 3000 }),
    ]);
    expect(results.map(x => x.status)).toEqual(["fulfilled", "fulfilled"]);

    const { quotations } = await q.quotationHistory(r.id);
    const h = quotations.find(x => x.id === qt.id);
    expect(h?.revision).toBe(3);
    const revs = h?.revisions.map(x => x.revision) ?? [];
    expect(revs).toEqual([1, 2]);
    expect(Number(h?.revisions[0].amount)).toBe(1000);
    // Revision 2 is whichever edit landed first; the standing figure is the other.
    expect([Number(h?.revisions[1].amount), Number(h?.amount)].sort()).toEqual([2000, 3000]);
  });
});

describe("removing a quotation", () => {
  maybe()("is soft: gone from the lists, still in the history with when and why", async () => {
    const r = await tstRequirement();
    const keep = await quote(r.id, 800);
    const gone = await quote(r.id, 900, vendorB);
    await q.removeQuotation(ACTOR, gone.id, "Vendor withdrew");

    expect((await q.listQuotations({ requestId: r.id })).map(x => x.id)).toEqual([keep.id]);
    const { quotations } = await q.quotationHistory(r.id);
    const h = quotations.find(x => x.id === gone.id);
    expect(h?.removed_at).not.toBeNull();
    expect(h?.removal_reason).toBe("Vendor withdrew");
    expect(quotations.map(x => x.id)).toEqual(expect.arrayContaining([keep.id, gone.id]));

    // It no longer counts towards the requirement's quotes or lowest price.
    const req = await q.getRequest(r.id);
    expect(req?.quote_count).toBe(1);
    expect(Number(req?.lowest_amount)).toBe(800);
    expect(req?.status).toBe("quoted");

    await expect(q.removeQuotation(ACTOR, gone.id)).rejects.toMatchObject({ status: 404 });
  });

  maybe()("returns a quoted requirement to pending when the last quotation goes", async () => {
    const r = await tstRequirement();
    const a = await quote(r.id, 800);
    const b = await quote(r.id, 900, vendorB);
    await q.removeQuotation(ACTOR, a.id);
    expect((await q.getRequest(r.id))?.status).toBe("quoted");
    await q.removeQuotation(ACTOR, b.id);
    expect((await q.getRequest(r.id))?.status).toBe("pending");
  });

  maybe()("is left alone when a sibling is approved", async () => {
    const r = await tstRequirement();
    const win = await quote(r.id, 500);
    const lose = await quote(r.id, 600, vendorB);
    const removed = await quote(r.id, 700);
    await q.removeQuotation(ACTOR, removed.id, "Withdrawn");

    await q.decideQuotation(ACTOR, win.id, "approved");

    const all = await q.listQuotations({ requestId: r.id, includeRemoved: true });
    expect(all.find(x => x.id === win.id)?.status).toBe("approved");
    expect(all.find(x => x.id === lose.id)?.status).toBe("rejected");
    const untouched = all.find(x => x.id === removed.id);
    expect(untouched?.status).toBe("pending");
    expect(untouched?.decided_at).toBeNull();
    expect(untouched?.removed_at).not.toBeNull();
  });
});

describe("a quotation for a typed-in requirement", () => {
  maybe()("creates the requirement and the quotation together", async () => {
    const size = `TST-NEW-${tag()}`;
    const made = await q.createQuotationWithNewRequest(ACTOR, {
      instituteId: instituteB, requiredDate: "2026-12-01", workType: "TST Typed",
      priority: "urgent", description: "Typed in the quotation form", size,
    }, { vendorId: vendorA, amount: 4321, quoteDate: "2026-10-11", notes: "Below" });

    expect(Number(made.amount)).toBe(4321);
    expect(made.notes).toBe("Below");
    expect(made.request_size).toBe(size);
    expect(made.work_type).toBe("TST Typed");
    const req = await q.getRequest(made.request_id);
    expect(req?.status).toBe("quoted");
    expect(req?.institute_id).toBe(instituteB);
    expect(req?.reference).toBe(made.request_reference);
    expect(req?.quote_count).toBe(1);
  });

  maybe()("leaves no requirement behind when the quotation fails", async () => {
    const description = `Orphan check ${tag()}`;
    const count = async () => Number((await pool.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM bo_requests WHERE description = $1`, [description])).rows[0].c);

    expect(await count()).toBe(0);
    await expect(q.createQuotationWithNewRequest(ACTOR, {
      instituteId: instituteA, requiredDate: "2026-12-01", workType: "TST Typed",
      priority: "normal", description,
    }, { vendorId: "no-such-vendor", amount: 100, quoteDate: "2026-10-11" })).rejects.toMatchObject({ status: 404 });
    expect(await count()).toBe(0);
  });
});

describe("quotation summaries for the Dashboard", () => {
  maybe()("group the standing quotations by requirement, cheapest first", async () => {
    const r1 = await tstRequirement();
    const r2 = await tstRequirement();
    const r3 = await tstRequirement();   // no quotations at all
    const a = await quote(r1.id, 300);
    const b = await quote(r1.id, 100, vendorB);
    const c = await quote(r1.id, 50);
    await q.removeQuotation(ACTOR, c.id);
    const d = await quote(r2.id, 999);

    const out = await q.quoteSummaries([r1.id, r2.id, r3.id]);
    expect(out[r1.id].map(x => x.id)).toEqual([b.id, a.id]);
    expect(out[r2.id].map(x => x.id)).toEqual([d.id]);
    expect(out[r3.id]).toBeUndefined();
    expect(out[r1.id][0]).toMatchObject({ reference: b.reference, vendor_name: b.vendor_name, status: "pending", revision: 1 });
    expect(Number(out[r1.id][0].amount)).toBe(100);

    expect(await q.quoteSummaries([])).toEqual({});
  });
});

describe("quotation history", () => {
  maybe()("lists every quotation a requirement has had, oldest first, for comparison", async () => {
    // The comparison only means anything with two or more quotations, so this
    // is the case the ⓘ view and the history dialog depend on.
    const r = await tstRequirement();
    const older = await quote(r.id, 1500);
    const newer = await quote(r.id, 1400, vendorB);
    await q.updateQuotation(ACTOR, newer.id, { amount: 1300 });

    const { request, quotations } = await q.quotationHistory(r.id);
    expect(request?.id).toBe(r.id);
    expect(quotations.map(x => x.id)).toEqual([older.id, newer.id]);
    expect(quotations[0].revisions).toEqual([]);
    expect(quotations[1].revisions.map(x => Number(x.amount))).toEqual([1400]);
  });
});
