/* ═══════════════════════════════════════════════════════════════════════════
   UI — the Equipment registry reads the server, not the /state dump.

   WHAT THIS REPLACED. `eqCatalog()` iterated DB.equipment_items: every asset
   the department owns, shipped to every user on every boot, then grouped,
   searched and filtered in the browser. Opening the tab cost the whole estate
   whether or not anybody looked past the first screen, and the asset detail
   page needed three more complete arrays — transactions, bookings, maintenance
   — to draw ONE camera.

   These tests boot the real public/media-ops/index.html in jsdom with a
   scripted server behind it, and assert on the REQUESTS the page makes. That
   is the only way to state the property that matters: the size of the estate
   no longer decides the cost of opening the tab.

   The counterpart API tests live in server/mediaops-equipment.integration.test.ts.
   ═══════════════════════════════════════════════════════════════════════════ */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const HTML = readFileSync("public/media-ops/index.html", "utf8");

type Ev = <T>(expr: string) => T;
interface Harness {
  dom: JSDOM;
  ev: Ev;
  calls: string[];
  /** Requests to the equipment API only, path + query. */
  equipmentCalls: () => string[];
  page: () => string;
  render: (hash?: string) => Promise<void>;
}

const TOTAL = 248;
const TX_TOTAL = 420;
const MT_TOTAL = 130;

/** A page of ledger rows in the shape GET /equipment/transactions returns. */
function ledger(n: number, offset: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: offset + i + 1, equipment_item_id: 1,
    occurred_at: "2026-09-01T10:00:00", action: i % 2 ? "check_in" : "check_out",
    holder_id: 1, holder_name: "Rahul J.", condition_noted: "good",
    expected_return_at: "2026-09-10", recorded_via: "desktop",
    recorded_by: 1, recorded_by_name: "Rahul J.",
    asset_tag: "EQ-CAM-001", make: "Sony", model: "A7",
  }));
}
/** A page of maintenance rows in the shape GET /equipment/maintenance returns. */
function records(n: number, offset: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: offset + i + 1, equipment_item_id: 1, kind: "damage_report",
    description: "Lens scratched", cost: 2500, vendor_id: null, vendor_name: "Acme",
    started_at: "2026-08-01", resolved_at: null, next_due_at: null,
    asset_tag: "EQ-CAM-001", make: "Sony", model: "A7",
  }));
}

const BK_TOTAL = 140;
const AV_TOTAL = 80;

const addDays = (iso: string, n: number) =>
  new Date(Date.parse(iso) + n * 86_400_000).toISOString().slice(0, 10);

/** A page of bookings in the shape GET /equipment/bookings returns — placed
    inside the window that was asked for, as an overlap query would return. */
function schedule(n: number, offset: number, from = "2026-09-25") {
  return Array.from({ length: n }, (_, i) => ({
    id: String(offset + i + 1), equipment_item_id: "1", user_id: "mo-u1",
    shoot_id: null, project_id: null,
    starts_at: addDays(from, 2), ends_at: addDays(from, 5),
    status: i % 2 ? "active" : "reserved", created_by: "mo-u1",
    asset_tag: `EQ-CAM-${String((i % 9) + 1).padStart(3, "0")}`,
    make: "Sony", model: "A7", category_id: 1,
    user_name: "Rahul J.", shoot_title: null, project_name: null,
  }));
}
/** A page of assets-with-a-verdict in the shape GET /equipment/availability returns. */
function availability(n: number, offset: number) {
  return Array.from({ length: n }, (_, i) => {
    const broken = i === 2, taken = i % 3 === 0 && !broken;
    return {
      id: String(offset + i + 1),
      asset_tag: `EQ-CAM-${String((i % 9) + 1).padStart(3, "0")}`,
      make: "Sony", model: "A7", serial_no: `SN-${i}`, category_id: 1,
      department_id: 1, status: broken ? "maintenance" : "available",
      condition: "good", pool_quantity: null, category_name: "Camera Body",
      available: !broken && !taken,
      blocked_by: broken ? "status" : taken ? "booking" : null,
      bookings: taken
        ? [{ id: `9${i}`, starts_at: "2026-09-25", ends_at: "2026-09-26",
             status: "reserved", user_name: "Asha K." }]
        : [],
    };
  });
}

const CUSTODY_TOTAL = 3;
const AN_ITEMS = 120;

/** The shape GET /equipment/analytics returns: aggregates, never history. */
function analyticsBody(offset = 0, limit = 50) {
  const n = Math.max(0, Math.min(limit, AN_ITEMS - offset));
  return {
    from: null, to: null,
    by_category: [
      { category_id: "1", category_name: "Camera Body", items: 40, checkouts: 620 },
      { category_id: "2", category_name: "Lens", items: 30, checkouts: 310 },
      { category_id: "3", category_name: "Tripod", items: 12, checkouts: 0 },
    ],
    by_weekday: [0, 1, 2, 3, 4, 5, 6].map((d) => ({ dow: d, bookings: d === 0 ? 41 : d * 3 })),
    items: Array.from({ length: n }, (_, i) => ({
      id: String(offset + i + 1),
      asset_tag: `EQ-CAM-${String(offset + i + 1).padStart(3, "0")}`,
      make: "Sony", model: `A7 ${offset + i + 1}`, category_id: 1,
      category_name: "Camera Body", condition: "good",
      purchase_cost: 90000, checkouts: 1200 - (offset + i), maintenance_cost: 2000,
    })),
    total: AN_ITEMS, limit, offset,
  };
}

/** Rows in the shape GET /equipment/custody returns: asset + custody + joins. */
function custodyRows(n: number, offset = 0) {
  return Array.from({ length: n }, (_, i) => {
    const id = offset + i + 1;
    const late = i === 0;
    return {
      asset: { id: String(id), asset_tag: `EQ-CAM-${String(id).padStart(3, "0")}`,
               make: "Sony", model: `A7 ${id}`, serial_no: `SN-${id}`,
               category_id: 1, category_name: "Camera Body",
               status: "checked_out", condition: "good" },
      custody: { holder_id: "1", holder_name: "Rahul J.", transaction_id: String(900 + id),
                 checked_out_at: "2026-09-01T10:00:00.000Z",
                 due_at: late ? "2026-09-10" : "2026-12-01",
                 overdue: late, overdue_days: late ? 4 : 0,
                 recorded_via: "desktop", recorded_by: "1", recorded_by_name: "Rahul J.",
                 condition_noted: "good", booking_id: null },
      project: i === 1 ? { id: "7", name: "Campus Film" } : null,
      department: { id: "1", name: "Media Crew" },
    };
  });
}

/** A page of assets in the shape GET /equipment returns. */
function assets(n: number, offset: number) {
  return Array.from({ length: n }, (_, i) => {
    const id = offset + i + 1;
    const out = i % 3 === 0;
    return {
      id, asset_tag: `EQ-CAM-${String(id).padStart(3, "0")}`,
      make: "Sony", model: `A7 ${id}`, serial_no: `SN-${id}`,
      condition: "good", status: out ? "checked_out" : "available",
      category_id: 1, category_name: "Camera Body", tracking_mode: "individual",
      warranty_until: "2027-01-01", notes: null, pool_quantity: null,
      asset_uid: `AT-${id}`, qr_uid: `QR-${id}`,
      holder_id: out ? 1 : null, holder_name: out ? "Rahul J." : null,
      holder_due_at: out ? "2026-12-01" : null,
      /* The state block the server now derives. The fixture mirrors it rather
         than leaving it out: a row without one renders "Status unknown", which
         is the point — an unanswered asset must never read as available. */
      state: {
        lifecycle: { status: out ? "checked_out" : "available", persisted: true,
                     unserviceable: false },
        custody: out
          ? { status: "checked_out", holder_id: 1, holder_name: "Rahul J.",
              transaction_id: 900 + id, checked_out_at: "2026-09-01T10:00:00.000Z",
              due_at: "2026-12-01", recorded_via: "desktop" }
          : { status: "not_held", holder_id: null, holder_name: null,
              transaction_id: null, checked_out_at: null, due_at: null, recorded_via: null },
        maintenance: { active: false, open_count: 0 },
        reservation: null,
        derived: { overdue: false, overdue_days: 0 },
        conflicts: [],
      },
      purchase_date: "2025-01-01", purchase_cost: 100000, campus_id: 1, vendor_id: null,
      insurance_policy_no: "P-1", insurance_until: "2027-01-01",
    };
  });
}

/** Boot the real page with a scripted equipment API behind it. */
async function boot(opts: { listStatus?: number; detailStatus?: number;
                            txStatus?: number; mtStatus?: number;
                            bkStatus?: number; avStatus?: number;
                            cuStatus?: number; cuRows?: number;
                            anStatus?: number;
                            stateBody?: Record<string, unknown> } = {}): Promise<Harness> {
  const { listStatus = 200, detailStatus = 200, txStatus = 200, mtStatus = 200,
          bkStatus = 200, avStatus = 200, cuStatus = 200, cuRows = CUSTODY_TOTAL,
          anStatus = 200, stateBody } = opts;
  const calls: string[] = [];
  const dom = new JSDOM(HTML, {
    url: "http://localhost/api/media-ops/#/media/equipment",
    runScripts: "dangerously", pretendToBeVisual: true,
  });
  const w = dom.window as unknown as { fetch: unknown; eval: (s: string) => unknown };

  w.fetch = async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const reply = (status: number, body: unknown) =>
      ({ ok: status < 400, status, json: async () => body }) as Response;

    // The page still boots on /state for every OTHER module; the registry must
    // not need it. Offline here, so anything that did need it would show.
    /* /state fails by default, which is what proves the read models stand on
       their own. A test that needs the boot path itself supplies a payload. */
    if (url.includes("/api/v1/media/state")) {
      if (!stateBody) throw new Error("offline");
      return reply(200, stateBody);
    }

    if (url.includes("/equipment?")) {
      if (listStatus !== 200) return reply(listStatus, { message: "Equipment is unavailable." });
      const p = new URL("http://x" + url.slice(url.indexOf("/equipment")));
      const offset = Number(p.searchParams.get("offset") ?? 0);
      const q = p.searchParams.get("q") ?? "";
      const status = p.searchParams.get("status") ?? "all";
      const category = p.searchParams.get("category_id") ?? "all";
      let total = TOTAL;
      if (q) total = 2;
      if (status !== "all") total = 90;
      if (category !== "all") total = 12;
      const n = Math.max(0, Math.min(50, total - offset));
      return reply(200, {
        items: assets(n, offset), total, limit: 50, offset,
        summary: p.searchParams.get("summary") === "1"
          ? { total, available: 120, checked_out: 60, booked: 8,
              maintenance: 5, book_value: 1_234_567, overdue: 3 }
          : undefined,
      });
    }

    if (url.includes("/equipment/transactions")) {
      if (txStatus !== 200) return reply(txStatus, { message: "The ledger is unavailable." });
      const p = new URL("http://x" + url.slice(url.indexOf("/equipment")));
      const offset = Number(p.searchParams.get("offset") ?? 0);
      const action = p.searchParams.get("action") ?? "all";
      const total = action === "all" ? TX_TOTAL : 60;
      const n = Math.max(0, Math.min(50, total - offset));
      return reply(200, { items: ledger(n, offset), total, limit: 50, offset });
    }

    if (url.includes("/equipment/maintenance")) {
      if (mtStatus !== 200) return reply(mtStatus, { message: "Maintenance is unavailable." });
      const p = new URL("http://x" + url.slice(url.indexOf("/equipment")));
      const offset = Number(p.searchParams.get("offset") ?? 0);
      const status = p.searchParams.get("status") ?? "all";
      const total = status === "open" ? 7 : MT_TOTAL;
      const n = Math.max(0, Math.min(50, total - offset));
      return reply(200, {
        items: records(n, offset), total, limit: 50, offset,
        summary: p.searchParams.get("summary") === "1"
          ? { total, open: 7, resolved: total - 7, cost: 98_000 } : undefined,
      });
    }

    if (url.includes("/equipment/analytics")) {
      if (anStatus !== 200) return reply(anStatus, { message: "Analytics are unavailable." });
      const p = new URL("http://x" + url.slice(url.indexOf("/equipment")));
      return reply(200, analyticsBody(Number(p.searchParams.get("offset") ?? 0),
                                      Number(p.searchParams.get("limit") ?? 50)));
    }

    if (url.includes("/equipment/custody")) {
      if (cuStatus !== 200) return reply(cuStatus, { message: "Custody is unavailable." });
      const p = new URL("http://x" + url.slice(url.indexOf("/equipment")));
      const offset = Number(p.searchParams.get("offset") ?? 0);
      const limit = Number(p.searchParams.get("limit") ?? 50);
      const n = Math.max(0, Math.min(limit, cuRows - offset));
      return reply(200, { items: custodyRows(n, offset), total: cuRows, limit, offset });
    }

    if (url.includes("/equipment/bookings")) {
      if (bkStatus !== 200) return reply(bkStatus, { message: "Bookings are unavailable." });
      const p = new URL("http://x" + url.slice(url.indexOf("/equipment")));
      const offset = Number(p.searchParams.get("offset") ?? 0);
      const limit = Number(p.searchParams.get("limit") ?? 50);
      const status = p.searchParams.get("status") ?? "all";
      /* Asked about specific shoots: answer one booking per shoot, tagged with
         the shoot it belongs to, which is what the Shoots screens group by. */
      const shootParam = p.searchParams.get("shoot_id");
      if (shootParam) {
        const ids = shootParam.split(",").map(Number).filter(Boolean);
        const rows = ids.map((sid, i) => ({
          ...schedule(1, i)[0], shoot_id: String(sid),
          asset_tag: `EQ-KIT-${String(sid).padStart(3, "0")}`,
          make: "Sony", model: `FX${sid}`, category_id: 1,
        }));
        return reply(200, { items: rows, total: rows.length, limit, offset: 0 });
      }
      const total = status === "cancelled" ? 3 : BK_TOTAL;
      const n = Math.max(0, Math.min(limit, total - offset));
      const from = p.searchParams.get("from") ?? undefined;
      return reply(200, { items: schedule(n, offset, from), total, limit, offset });
    }

    if (url.includes("/equipment/availability")) {
      if (avStatus !== 200) return reply(avStatus, { message: "Availability is unavailable." });
      const p = new URL("http://x" + url.slice(url.indexOf("/equipment")));
      const offset = Number(p.searchParams.get("offset") ?? 0);
      const limit = Number(p.searchParams.get("limit") ?? 50);
      const n = Math.max(0, Math.min(limit, AV_TOTAL - offset));
      return reply(200, {
        from: p.searchParams.get("from"), to: p.searchParams.get("to"),
        items: availability(n, offset), total: AV_TOTAL, limit, offset,
      });
    }

    if (/\/equipment\/[^/?]+$/.test(url)) {
      if (detailStatus !== 200) return reply(detailStatus, { message: "Asset not found." });
      /* The asset that was ASKED for. Returning id 1 whatever the request said
         is not what the server does, and it made a cache miss unresolvable —
         the caller stored id 1, still did not know the id it wanted, and asked
         again. */
      const wanted = Number(url.split("/").pop());
      const one = { ...assets(1, 0)[0], ...(wanted ? { id: wanted } : {}) };
      return reply(200, {
        item: one,
        identifiers: [{ id: 1, kind: "qr", value: "AT-1", is_primary: true, is_active: true }],
        transactions: [{ id: 9, action: "check_out", holder_id: 1, occurred_at: "2026-09-01T10:00:00",
                         recorded_via: "desktop", condition_noted: "good", expected_return_at: "2026-09-10" }],
        bookings: [], maintenance: [],
        holder: { id: 1, expected_return_at: "2026-09-10", overdue_days: 0 }, escalation: null,
      });
    }
    return reply(200, {});
  };

  await new Promise((r) => setTimeout(r, 140));
  const ev: Ev = (expr) => w.eval(expr) as never;
  ev("window.__MO_LIVE__ = true; S.tab.equip = 'catalog';");

  const h: Harness = {
    dom, ev, calls,
    equipmentCalls: () => calls.filter((c) => c.includes("/api/v1/media/equipment"))
      .map((c) => c.slice(c.indexOf("/api/v1/media") + "/api/v1/media".length)),
    page: () => dom.window.document.getElementById("page")?.textContent ?? "",
    render: async (hash?: string) => {
      if (hash) dom.window.location.hash = hash;
      ev("render()");
      await new Promise((r) => setTimeout(r, 130));
    },
  };
  // Land on a freshly-loaded registry.
  ev("EQ_LIST.loaded = false;");
  await h.render();
  calls.length = 0;
  return h;
}

const rows = (h: Harness) =>
  h.dom.window.document.querySelectorAll("#page table.tbl tbody tr").length;

/* ══════════════════════════════════════════════════════════════════════════
   The property the migration exists for.
   ══════════════════════════════════════════════════════════════════════════ */
describe("the registry is a server read", () => {
  it("loads through GET /equipment, once, on entry", async () => {
    const h = await boot();
    h.ev("EQ_LIST.loaded = false;");
    await h.render();
    const eq = h.equipmentCalls();
    expect(eq).toHaveLength(1);
    expect(eq[0]).toMatch(/^\/equipment\?/);
    expect(eq[0]).toContain("limit=50");
    expect(eq[0]).toContain("offset=0");
  });

  /* THE REGRESSION GUARD. /state is answered with a network failure in this
     harness, so a registry that still depended on it would render nothing. */
  it("does not ask for /state to draw the registry", async () => {
    const h = await boot();
    h.ev("EQ_LIST.loaded = false;");
    await h.render();
    expect(h.calls.some((c) => c.includes("/api/v1/media/state"))).toBe(false);
    expect(rows(h)).toBeGreaterThan(0);
  });

  it("holds one page, not the estate", async () => {
    const h = await boot();
    expect(rows(h)).toBe(50);
    expect(h.ev<number>("EQ_LIST.rows.length")).toBe(50);
    expect(h.ev<number>("EQ_LIST.total")).toBe(TOTAL);
    expect(h.page()).toContain(`Showing 1–50 of ${TOTAL}`);
  });

  /* The list response must stay a list. A row carrying its asset's history
     would put the estate's history back in the browser by another door. */
  it("fetches no transaction, booking or maintenance history for the list", async () => {
    const h = await boot();
    h.ev("EQ_LIST.loaded = false;");
    await h.render();
    for (const c of h.equipmentCalls())
      expect(c, `list load fetched ${c}`).toMatch(/^\/equipment\?/);
    const row = h.ev<Record<string, unknown>>("EQ_LIST.rows[0]");
    for (const heavy of ["transactions", "bookings", "maintenance", "identifiers"])
      expect(row, `a list row carried ${heavy}`).not.toHaveProperty(heavy);
  });

  it("renders the columns and actions it always had", async () => {
    const h = await boot();
    const head = [...h.dom.window.document.querySelectorAll("#page table.tbl thead th")]
      .map((t) => t.textContent?.trim()).filter(Boolean);
    expect(head).toEqual(["Asset tag", "Item", "Serial", "Condition", "Holder", "Warranty", "Status"]);
    const acts = [...h.dom.window.document.querySelectorAll("#page [data-act]")]
      .map((n) => n.getAttribute("data-act"));
    expect(acts).toContain("checkout");
    // The row still links to the asset by its tag, as the catalog always has.
    expect(h.dom.window.document.querySelector("#page tbody tr")?.getAttribute("data-go"))
      .toBe("#/media/equipment/EQ-CAM-001");
  });

  it("draws the holder from the row, with no transaction history to hand", async () => {
    const h = await boot();
    /* Emptying the local transaction array is the test: the catalog used to
       derive every holder avatar from it, so a registry that still did would
       lose them here. The holder is a field on the row now. */
    h.ev("DB.equipment_transactions = [];");
    h.ev("EQ_LIST.loaded = false;");
    await h.render();
    expect(h.ev<string | null>("EQ_LIST.rows[0].holder_id")).toBeTruthy();
    expect(rows(h)).toBe(50);
    const holderCells = [...h.dom.window.document.querySelectorAll("#page tbody tr")]
      .filter((tr) => !(tr.children[4]?.textContent ?? "").includes("—"));
    expect(holderCells.length, "no holder was drawn without the transaction array")
      .toBeGreaterThan(0);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   Search, filter and paging happen on the server.
   ══════════════════════════════════════════════════════════════════════════ */
describe("the browser asks rather than sifts", () => {
  let h: Harness;
  beforeEach(async () => { h = await boot(); });

  it("sends a search to the server and shows what comes back", async () => {
    h.calls.length = 0;
    h.ev("ACTIONS.eqFilter({k:'q'},{value:'A7 3'})");
    await new Promise((r) => setTimeout(r, 130));
    const eq = h.equipmentCalls();
    expect(eq).toHaveLength(1);
    expect(eq[0]).toContain("q=A7+3");
    expect(rows(h)).toBe(2);
  });

  it("sends the status filter", async () => {
    h.calls.length = 0;
    h.ev("ACTIONS.eqFilter({k:'status'},{value:'checked_out'})");
    await new Promise((r) => setTimeout(r, 130));
    expect(h.equipmentCalls()[0]).toContain("status=checked_out");
    expect(h.ev<number>("EQ_LIST.total")).toBe(90);
  });

  it("sends the category filter", async () => {
    h.calls.length = 0;
    h.ev("ACTIONS.eqFilter({k:'category_id'},{value:'1'})");
    await new Promise((r) => setTimeout(r, 130));
    expect(h.equipmentCalls()[0]).toContain("category_id=1");
    expect(h.ev<number>("EQ_LIST.total")).toBe(12);
  });

  it("pages forward and back through the server", async () => {
    h.calls.length = 0;
    h.ev("ACTIONS.eqPage({d:'1'})");
    await new Promise((r) => setTimeout(r, 130));
    expect(h.ev<number>("EQ_LIST.offset")).toBe(50);
    expect(h.equipmentCalls()[0]).toContain("offset=50");
    expect(h.page()).toContain("Showing 51–100");

    h.calls.length = 0;
    h.ev("ACTIONS.eqPage({d:'-1'})");
    await new Promise((r) => setTimeout(r, 130));
    expect(h.ev<number>("EQ_LIST.offset")).toBe(0);
  });

  it("returns to the first page when a filter changes", async () => {
    h.ev("ACTIONS.eqPage({d:'1'})");
    await new Promise((r) => setTimeout(r, 130));
    expect(h.ev<number>("EQ_LIST.offset")).toBe(50);
    h.ev("ACTIONS.eqFilter({k:'status'},{value:'available'})");
    await new Promise((r) => setTimeout(r, 130));
    expect(h.ev<number>("EQ_LIST.offset")).toBe(0);
  });

  it("takes its header figures from the same response", async () => {
    const vals = [...h.dom.window.document.querySelectorAll("#page .stat .stat-val")]
      .map((n) => n.textContent?.trim());
    expect(vals[0]).toBe(String(TOTAL));     // Total items
    expect(vals[1]).toBe("120");             // Available now
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   Detail — its own request, its own history.
   ══════════════════════════════════════════════════════════════════════════ */
describe("an asset is opened, not searched for in a downloaded array", () => {
  it("fetches the asset by the tag in the URL, in one request", async () => {
    const h = await boot();
    h.calls.length = 0;
    await h.render("#/media/equipment/EQ-CAM-001");
    expect(h.equipmentCalls()).toEqual(["/equipment/EQ-CAM-001"]);
    expect(h.page()).toContain("Sony A7 1");
  });

  it("renders the asset and its history from the SERVER, not the local arrays", async () => {
    /* The original property, unchanged: this page used to filter these three
       arrays for the asset's own history, so emptying them would have blanked
       it. What changed in Phase 17E is WHERE the history is drawn — the detail
       payload's preview became a Transactions section that asks the server for
       a page of the timeline. Emptying the arrays must still change nothing,
       and opening the section must still be a request rather than a filter. */
    const h = await boot();
    h.ev("DB.equipment_transactions = []; DB.equipment_bookings = []; DB.maintenance_records = [];");
    h.ev("EQ_ITEM.loaded = false; EQ_ITEM.tag = null;");
    await h.render("#/media/equipment/EQ-CAM-001");
    expect(h.page()).toContain("Sony A7 1");
    expect(h.page()).toContain("Current state");

    h.calls.length = 0;
    h.ev("S.tab.asset='transactions';");
    await h.render("#/media/equipment/EQ-CAM-001");
    await h.render("#/media/equipment/EQ-CAM-001");
    expect(h.calls.filter((c) => c.includes("/timeline")).length,
      "the history was read from a local array instead of the server").toBeGreaterThan(0);
  });

  it("re-fetches when a different asset is opened", async () => {
    const h = await boot();
    await h.render("#/media/equipment/EQ-CAM-001");
    h.calls.length = 0;
    await h.render("#/media/equipment/EQ-CAM-002");
    expect(h.equipmentCalls()).toEqual(["/equipment/EQ-CAM-002"]);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   The states an asynchronous read has and a downloaded array did not.
   ══════════════════════════════════════════════════════════════════════════ */
describe("loading, empty and error are all shown", () => {
  it("says it is loading before the first page arrives", async () => {
    const h = await boot();
    h.ev("EQ_LIST.loaded = false; EQ_LIST.loading = false;");
    h.ev("render()");                       // synchronous: the fetch is in flight
    expect(h.page()).toContain("Loading the asset registry");
  });

  it("says so when nothing matches, and offers the way back", async () => {
    const h = await boot();
    h.ev("EQ_LIST.rows = []; EQ_LIST.total = 0; EQ_LIST.loaded = true; render();");
    expect(h.page()).toContain("No assets match");
  });

  it("reports an API failure instead of an empty catalog, and can retry", async () => {
    const h = await boot({ listStatus: 500 });
    h.ev("EQ_LIST.loaded = false;");
    await h.render();
    expect(h.page()).toContain("could not be loaded");
    expect(h.dom.window.document.querySelector('#page [data-act="eqRetry"]')).not.toBeNull();
    // and nothing stale is drawn as though it were current
    expect(rows(h)).toBe(0);
  });

  it("reports a failed asset load rather than a blank page", async () => {
    const h = await boot({ detailStatus: 404 });
    await h.render("#/media/equipment/EQ-CAM-001");
    expect(h.page()).toContain("could not be loaded");
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   Writes invalidate the read model — without regressing the reporting order.
   ══════════════════════════════════════════════════════════════════════════ */
describe("a write makes the page stale, and says so in the right order", () => {
  it("marks the registry and the open asset stale", async () => {
    const h = await boot();
    expect(h.ev<boolean>("EQ_LIST.loaded")).toBe(true);
    h.ev("EQ_ITEM.loaded = true; eqInvalidate();");
    expect(h.ev<boolean>("EQ_LIST.loaded")).toBe(false);
    expect(h.ev<boolean>("EQ_ITEM.loaded")).toBe(false);
  });

  /* The established order: the mutation's outcome is reported first, and a
     refresh that fails afterwards must not be reported as a failed checkout. */
  it("still reports a successful checkout when the refresh afterwards fails", async () => {
    const h = await boot();
    h.ev(`DB.equipment_items = [{id:1,asset_tag:'EQ-CAM-001',make:'Sony',model:'A7',
           status:'available',condition:'good',category_id:1}];`);
    const t = h.dom.window.document.getElementById("toasts");
    if (t) t.innerHTML = "";
    h.ev("ACTIONS.checkout({eid:'1'})");
    await new Promise((r) => setTimeout(r, 150));
    /* Phase 17F — the loan is confirmed before it is made. The ORDER being
       tested is unchanged: the outcome is reported first, and the refresh that
       fails afterwards must not turn a successful checkout into an error. */
    h.ev("document.querySelector('#co-go').click()");
    await new Promise((r) => setTimeout(r, 200));
    // /state throws in this harness, so the refresh after the checkout fails.
    expect(t?.textContent ?? "").toContain("checked out to");
  });
});


/* ══════════════════════════════════════════════════════════════════════════
   Phase 2 — the two history tabs.

   Both used to render an array out of /state: the whole ledger, and every
   maintenance record the department has ever opened. `/state` fails in this
   harness, so a tab that still depended on it would render nothing.
   ══════════════════════════════════════════════════════════════════════════ */
async function openTab(h: Harness, tab: string) {
  h.ev(`S.tab.equip = ${JSON.stringify(tab)};`);
  h.calls.length = 0;
  await h.render();
}

describe("the Transactions tab is a server read", () => {
  it("loads through GET /equipment/transactions, without /state", async () => {
    const h = await boot();
    await openTab(h, "transactions");
    const eq = h.equipmentCalls();
    expect(eq).toHaveLength(1);
    expect(eq[0]).toMatch(/^\/equipment\/transactions\?/);
    expect(eq[0]).toContain("limit=50");
    expect(h.calls.some((c) => c.includes("/api/v1/media/state"))).toBe(false);
    expect(rows(h)).toBe(50);
    expect(h.page()).toContain(`Showing 1–50 of ${TX_TOTAL}`);
  });

  it("keeps the columns and the ledger's own note", async () => {
    const h = await boot();
    await openTab(h, "transactions");
    const head = [...h.dom.window.document.querySelectorAll("#page table.tbl thead th")]
      .map((t) => t.textContent?.trim());
    expect(head).toEqual(["When", "Item", "Action", "Holder", "Condition",
                          "Expected return", "Via", "Recorded by"]);
    expect(h.page()).toContain("Immutable ledger");
  });

  it("filters and pages on the server", async () => {
    const h = await boot();
    await openTab(h, "transactions");
    h.calls.length = 0;
    h.ev("ACTIONS.eqTxFilter({k:'action'},{value:'check_out'})");
    await new Promise((r) => setTimeout(r, 130));
    expect(h.equipmentCalls()[0]).toContain("action=check_out");
    expect(h.ev<number>("EQ_TX.total")).toBe(60);

    h.calls.length = 0;
    h.ev("ACTIONS.eqTxPage({d:'1'})");
    await new Promise((r) => setTimeout(r, 130));
    expect(h.equipmentCalls()[0]).toContain("offset=50");
    expect(h.ev<number>("EQ_TX.offset")).toBe(50);
  });

  it("renders the ledger with the local array emptied", async () => {
    const h = await boot();
    h.ev("DB.equipment_transactions = [];");
    await openTab(h, "transactions");
    expect(rows(h)).toBe(50);
    expect(h.page()).toContain("Check out");
  });

  it("shows loading, then an error with a retry", async () => {
    const h = await boot({ txStatus: 500 });
    h.ev("S.tab.equip='transactions'; EQ_TX.loaded=false; EQ_TX.loading=false; render();");
    expect(h.page()).toContain("Loading the ledger");
    await new Promise((r) => setTimeout(r, 130));
    expect(h.page()).toContain("could not be loaded");
    expect(h.dom.window.document.querySelector('#page [data-act="eqTxRetry"]')).not.toBeNull();
    expect(rows(h)).toBe(0);
  });

  it("says so when the ledger is empty", async () => {
    const h = await boot();
    await openTab(h, "transactions");
    h.ev("EQ_TX.rows = []; EQ_TX.total = 0; EQ_TX.loaded = true; render();");
    expect(h.page()).toContain("No transactions");
  });
});

describe("the Maintenance tab is a server read", () => {
  it("loads through GET /equipment/maintenance, without /state", async () => {
    const h = await boot();
    await openTab(h, "maintenance");
    const eq = h.equipmentCalls();
    expect(eq).toHaveLength(1);
    expect(eq[0]).toMatch(/^\/equipment\/maintenance\?/);
    expect(eq[0]).toContain("summary=1");
    expect(h.calls.some((c) => c.includes("/api/v1/media/state"))).toBe(false);
    expect(rows(h)).toBe(50);
  });

  it("keeps the columns, the report action and the ownership footer", async () => {
    const h = await boot();
    await openTab(h, "maintenance");
    const head = [...h.dom.window.document.querySelectorAll("#page table.tbl thead th")]
      .map((t) => t.textContent?.trim());
    expect(head).toEqual(["Item", "Kind", "Description", "Vendor", "Cost",
                          "Opened", "Resolved", "Next due"]);
    expect(h.page()).toContain("Cost of ownership to date");
    const acts = [...h.dom.window.document.querySelectorAll("#page [data-act]")]
      .map((n) => n.getAttribute("data-act"));
    expect(acts).toContain("reportDamage");
  });

  it("takes its footer and open count from the summary, not from an array", async () => {
    const h = await boot();
    h.ev("DB.maintenance_records = [];");
    await openTab(h, "maintenance");
    expect(h.ev<number>("EQ_MT.summary.open")).toBe(7);
    expect(rows(h)).toBe(50);
    expect(h.page()).not.toContain("Cost of ownership to date: —");
  });

  it("filters by status and pages on the server", async () => {
    const h = await boot();
    await openTab(h, "maintenance");
    h.calls.length = 0;
    h.ev("ACTIONS.eqMtFilter({k:'status'},{value:'open'})");
    await new Promise((r) => setTimeout(r, 130));
    expect(h.equipmentCalls()[0]).toContain("status=open");
    expect(h.ev<number>("EQ_MT.total")).toBe(7);

    h.ev("ACTIONS.eqMtFilter({k:'status'},{value:'all'})");
    await new Promise((r) => setTimeout(r, 130));
    h.calls.length = 0;
    h.ev("ACTIONS.eqMtPage({d:'1'})");
    await new Promise((r) => setTimeout(r, 130));
    expect(h.equipmentCalls()[0]).toContain("offset=50");
  });

  it("shows loading, then an error with a retry", async () => {
    const h = await boot({ mtStatus: 503 });
    h.ev("S.tab.equip='maintenance'; EQ_MT.loaded=false; EQ_MT.loading=false; render();");
    expect(h.page()).toContain("Loading maintenance records");
    await new Promise((r) => setTimeout(r, 130));
    expect(h.page()).toContain("could not be loaded");
    expect(h.dom.window.document.querySelector('#page [data-act="eqMtRetry"]')).not.toBeNull();
  });

  it("says so when there are no records", async () => {
    const h = await boot();
    await openTab(h, "maintenance");
    h.ev("EQ_MT.rows = []; EQ_MT.total = 0; EQ_MT.loaded = true; render();");
    expect(h.page()).toContain("No maintenance records");
  });
});

describe("a write makes the history tabs stale too", () => {
  it("invalidates the ledger and the maintenance list", async () => {
    const h = await boot();
    h.ev("EQ_TX.loaded = true; EQ_MT.loaded = true; eqInvalidate();");
    expect(h.ev<boolean>("EQ_TX.loaded")).toBe(false);
    expect(h.ev<boolean>("EQ_MT.loaded")).toBe(false);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   PHASE 3 — the schedule, the availability grid and the calendar layer.

   What these replaced: three separate scans of DB.equipment_bookings, one of
   which — the booking picker — was deciding what was FREE and offering a
   checkbox on the strength of it. /state is answered with a network failure
   throughout, so anything still reaching for that array shows up here.
   ══════════════════════════════════════════════════════════════════════════ */
describe("the Bookings tab is a server read", () => {
  it("loads through GET /equipment/bookings, once, without /state", async () => {
    const h = await boot();
    h.ev("S.tab.equip='bookings'; EQ_BK.loaded=false;");
    await h.render();
    const eq = h.equipmentCalls();
    expect(eq).toHaveLength(1);
    expect(eq[0]).toMatch(/^\/equipment\/bookings\?/);
    expect(eq[0]).toContain("limit=50");
    expect(eq[0]).toContain("offset=0");
    expect(h.calls.some((c) => c.includes("/media/state")),
      "the schedule asked for /state").toBe(false);
  });

  it("holds one page, and says how many there are", async () => {
    const h = await boot();
    h.ev("S.tab.equip='bookings'; EQ_BK.loaded=false;");
    await h.render();
    expect(rows(h)).toBe(50);
    expect(h.ev<number>("EQ_BK.total")).toBe(BK_TOTAL);
    expect(h.page()).toContain(`Showing 1–50 of ${BK_TOTAL}`);
  });

  it("keeps the six columns, the window, and Cancel", async () => {
    const h = await boot();
    h.ev("S.tab.equip='bookings'; EQ_BK.loaded=false;");
    await h.render();
    const head = [...h.dom.window.document.querySelectorAll("#page table.tbl thead th")]
      .map((t) => t.textContent?.trim());
    expect(head).toEqual(["Item", "Booked by", "Window", "Linked to", "Status", ""]);
    expect(h.page()).toContain("EQ-CAM-001");
    expect(h.dom.window.document.querySelector('#page [data-act="cancelBooking"]')).not.toBeNull();
    expect(h.dom.window.document.querySelector('#page [data-act="booking"]')).not.toBeNull();
  });

  it("renders with the local booking array emptied", async () => {
    const h = await boot();
    h.ev("DB.equipment_bookings.length = 0; S.tab.equip='bookings'; EQ_BK.loaded=false;");
    await h.render();
    expect(h.ev<number>("DB.equipment_bookings.length")).toBe(0);
    expect(rows(h)).toBe(50);
    expect(h.page()).toContain("EQ-CAM-001");
  });

  it("filters and pages on the server", async () => {
    const h = await boot();
    h.ev("S.tab.equip='bookings'; EQ_BK.loaded=false;");
    await h.render();

    h.calls.length = 0;
    h.ev("ACTIONS.eqBkFilter({k:'status'},{value:'cancelled'})");
    await new Promise((r) => setTimeout(r, 130));
    expect(h.equipmentCalls()[0]).toContain("status=cancelled");
    expect(h.ev<number>("EQ_BK.total")).toBe(3);

    h.ev("ACTIONS.eqBkFilter({k:'status'},{value:'reserved,active,cancelled'})");
    await new Promise((r) => setTimeout(r, 130));
    h.calls.length = 0;
    h.ev("ACTIONS.eqBkPage({d:'1'})");
    await new Promise((r) => setTimeout(r, 130));
    expect(h.ev<number>("EQ_BK.offset")).toBe(50);
    expect(h.equipmentCalls()[0]).toContain("offset=50");
  });

  it("returns to the first page when the filter changes", async () => {
    const h = await boot();
    h.ev("S.tab.equip='bookings'; EQ_BK.loaded=false;");
    await h.render();
    h.ev("ACTIONS.eqBkPage({d:'1'})");
    await new Promise((r) => setTimeout(r, 130));
    expect(h.ev<number>("EQ_BK.offset")).toBe(50);
    h.ev("ACTIONS.eqBkFilter({k:'status'},{value:'reserved'})");
    await new Promise((r) => setTimeout(r, 130));
    expect(h.ev<number>("EQ_BK.offset")).toBe(0);
  });

  it("shows loading, then an error with a retry", async () => {
    const h = await boot({ bkStatus: 500 });
    h.ev("S.tab.equip='bookings'; EQ_BK.loaded=false;");
    h.ev("render()");
    expect(h.page()).toContain("Loading bookings");
    await new Promise((r) => setTimeout(r, 140));
    expect(h.page()).toContain("Bookings could not be loaded");
    expect(h.dom.window.document.querySelector('[data-act="eqBkRetry"]')).not.toBeNull();
  });

  it("says so when the filter matches nothing", async () => {
    const h = await boot();
    h.ev("S.tab.equip='bookings'; EQ_BK.loaded=true; EQ_BK.rows=[]; EQ_BK.total=0; EQ_BK.err=null;");
    await h.render();
    expect(h.page()).toContain("No bookings");
    expect(rows(h)).toBe(0);
  });
});

describe("availability is the server's verdict, not the browser's", () => {
  it("asks GET /equipment/availability for the window on screen", async () => {
    const h = await boot();
    h.ev("S.tab.equip='availability'; EQ_AV.loaded=false;");
    await h.render();
    const eq = h.equipmentCalls();
    expect(eq).toHaveLength(1);
    expect(eq[0]).toMatch(/^\/equipment\/availability\?/);
    expect(eq[0]).toContain("individual_only=1");
    expect(eq[0]).toMatch(/from=\d{4}-\d{2}-\d{2}/);
    expect(eq[0]).toMatch(/to=\d{4}-\d{2}-\d{2}/);
    expect(h.calls.some((c) => c.includes("/media/state"))).toBe(false);
  });

  it("asks for exactly the fourteen days it draws", async () => {
    const h = await boot();
    h.ev("S.tab.equip='availability'; EQ_AV.loaded=false;");
    await h.render();
    const q = new URLSearchParams(h.equipmentCalls()[0].split("?")[1]);
    const from = q.get("from")!, to = q.get("to")!;
    const days = (Date.parse(to) - Date.parse(from)) / 86_400_000;
    expect(days, "the window asked for is not the window drawn").toBe(13);
    const cols = h.dom.window.document.querySelectorAll("#page table.tbl thead th").length - 1;
    expect(cols).toBe(14);
  });

  it("paints the server's windows, with the local array emptied", async () => {
    const h = await boot();
    h.ev("DB.equipment_bookings.length = 0; S.tab.equip='availability'; EQ_AV.loaded=false;");
    await h.render();
    expect(rows(h)).toBe(25);
    const body = h.dom.window.document.querySelector("#page table.tbl tbody")!.innerHTML;
    expect(body, "a reserved window was not painted").toContain("Asha K.");
    expect(body, "maintenance was not painted").toContain("Under maintenance");
  });

  it("re-asks when the window moves, from the first page", async () => {
    const h = await boot();
    h.ev("S.tab.equip='availability'; EQ_AV.loaded=false;");
    await h.render();
    h.ev("ACTIONS.eqAvPage({d:'1'})");
    await new Promise((r) => setTimeout(r, 130));
    expect(h.ev<number>("EQ_AV.offset")).toBe(25);

    h.calls.length = 0;
    h.ev("ACTIONS.eqAvFrom({},{value:'2027-03-01'})");
    await new Promise((r) => setTimeout(r, 130));
    const eq = h.equipmentCalls();
    expect(eq[0]).toContain("from=2027-03-01");
    expect(eq[0]).toContain("to=2027-03-14");
    expect(h.ev<number>("EQ_AV.offset"), "a new window kept the old page").toBe(0);
  });

  it("names the constraint it actually relies on", async () => {
    const h = await boot();
    h.ev("S.tab.equip='availability'; EQ_AV.loaded=false;");
    await h.render();
    expect(h.page()).toContain("daterange");
    expect(h.page(), "the footer still names a type the constraint does not use")
      .not.toContain("tstzrange");
  });

  it("shows loading, then an error with a retry", async () => {
    const h = await boot({ avStatus: 500 });
    h.ev("S.tab.equip='availability'; EQ_AV.loaded=false;");
    h.ev("render()");
    expect(h.page()).toContain("Asking the server what is free");
    await new Promise((r) => setTimeout(r, 140));
    expect(h.page()).toContain("Availability could not be loaded");
    expect(h.dom.window.document.querySelector('[data-act="eqAvRetry"]')).not.toBeNull();
  });
});

describe("the booking picker stops deciding for itself", () => {
  /** Open the booking modal and let its first availability call settle. */
  async function picker(h: Harness) {
    h.ev("openBooking()");
    await new Promise((r) => setTimeout(r, 160));
    return h.dom.window.document;
  }

  it("asks the server what is free for the typed window", async () => {
    const h = await boot();
    h.calls.length = 0;
    await picker(h);
    const av = h.equipmentCalls().filter((c) => c.startsWith("/equipment/availability"));
    expect(av.length, "the picker did not ask").toBeGreaterThan(0);
    expect(av[av.length - 1]).toMatch(/from=\d{4}-\d{2}-\d{2}.*to=\d{4}-\d{2}-\d{2}/);
  });

  it("offers only what the server called available, and names who holds the rest", async () => {
    const h = await boot();
    h.ev("DB.equipment_bookings.length = 0;");
    await picker(h);
    const d = h.dom.window.document;
    const boxes = [...d.querySelectorAll("#bk-items input[type=checkbox]")] as HTMLInputElement[];
    expect(boxes.length).toBe(AV_TOTAL);
    /* The fixture's verdicts: one in three is taken, and one is under
       maintenance — the browser is not recomputing either. */
    const enabled = boxes.filter((b) => !b.disabled).length;
    expect(enabled).toBe(availability(AV_TOTAL, 0).filter((r) => r.available).length);
    expect(d.getElementById("bk-items")!.innerHTML).toContain("Booked by Asha");
  });

  /* THE POINT OF THE PHASE. If the server cannot answer, nothing may be
     offered — an unknown answer must never render as a free asset. */
  it("offers nothing at all when availability cannot be checked", async () => {
    const h = await boot({ avStatus: 500 });
    await picker(h);
    const d = h.dom.window.document;
    expect(d.getElementById("bk-conflict")!.textContent).toContain("could not be checked");
    expect(d.querySelectorAll("#bk-items input[type=checkbox]").length).toBe(0);
    expect(d.getElementById("bk-items")!.textContent).toContain("Nothing can be offered");
  });

  it("refuses a backwards or over-long window before asking", async () => {
    const h = await boot();
    await picker(h);
    const d = h.dom.window.document;
    (d.getElementById("bk-from") as HTMLInputElement).value = "2027-05-10";
    (d.getElementById("bk-to") as HTMLInputElement).value = "2027-05-01";
    h.calls.length = 0;
    h.ev("ACTIONS.bookingCheck()");
    await new Promise((r) => setTimeout(r, 120));
    expect(d.getElementById("bk-conflict")!.textContent).toContain("VR-8");
    expect(h.equipmentCalls().filter((c) => c.startsWith("/equipment/availability")))
      .toEqual([]);
  });
});

describe("the calendar's equipment layer is a server read", () => {
  it("asks for the range on screen, and not for /state", async () => {
    const h = await boot();
    h.calls.length = 0;
    await h.render("#/media/calendar");
    const bk = h.equipmentCalls().filter((c) => c.startsWith("/equipment/bookings"));
    expect(bk).toHaveLength(1);
    const q = new URLSearchParams(bk[0].split("?")[1]);
    expect(q.get("status")).toBe("reserved,active");
    expect(q.get("from")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(q.get("to")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // The range has to cover both the 42-cell grid and the 21-day agenda.
    const span = (Date.parse(q.get("to")!) - Date.parse(q.get("from")!)) / 86_400_000;
    expect(span).toBeGreaterThanOrEqual(41);
  });

  it("draws bookings with the local array emptied", async () => {
    const h = await boot();
    h.ev("DB.equipment_bookings.length = 0;");
    await h.render("#/media/calendar");
    await new Promise((r) => setTimeout(r, 130));
    const chips = h.dom.window.document
      .querySelectorAll('.cal-ev[data-go^="#/media/equipment/"]');
    expect(chips.length, "no booking reached the grid").toBeGreaterThan(0);
  });

  it("re-asks when the month changes, and not before", async () => {
    const h = await boot();
    await h.render("#/media/calendar");
    await new Promise((r) => setTimeout(r, 130));
    h.calls.length = 0;
    await h.render();                       // same month — the key has not moved
    expect(h.equipmentCalls().filter((c) => c.startsWith("/equipment/bookings"))).toEqual([]);
    h.ev("ACTIONS.calPrev()");
    await new Promise((r) => setTimeout(r, 160));
    expect(h.equipmentCalls().filter((c) => c.startsWith("/equipment/bookings")).length)
      .toBeGreaterThan(0);
  });
});

describe("a booking makes the reads stale", () => {
  it("invalidates the schedule, the availability grid and the calendar", async () => {
    const h = await boot();
    h.ev("S.tab.equip='bookings'; EQ_BK.loaded=false;");
    await h.render();
    expect(h.ev<boolean>("EQ_BK.loaded")).toBe(true);
    h.ev("EQ_AV.loaded=true; EQ_MYBK.loaded=true; CAL_BK.key='x';");
    h.ev("eqInvalidate()");
    expect(h.ev<boolean>("EQ_BK.loaded")).toBe(false);
    expect(h.ev<boolean>("EQ_AV.loaded")).toBe(false);
    expect(h.ev<boolean>("EQ_MYBK.loaded")).toBe(false);
    expect(h.ev<string | null>("CAL_BK.key")).toBeNull();
  });

  it("cancelling a booking the browser has never seen does not throw", async () => {
    const h = await boot();
    h.ev("DB.equipment_bookings.length = 0; S.tab.equip='bookings'; EQ_BK.loaded=false;");
    await h.render();
    /* The id comes from a server page; the local array is empty. This used to
       read .status off undefined. */
    expect(() => h.ev("ACTIONS.cancelBooking({bid:'7'})")).not.toThrow();
    await new Promise((r) => setTimeout(r, 130));
  });
});

describe("the calendar layer is honest about what it could not show", () => {
  it("says so when the range holds more bookings than one page", async () => {
    const h = await boot();
    await h.render("#/media/calendar");
    await new Promise((r) => setTimeout(r, 140));
    /* The fixture's range returns 140 of 140, so nothing is hidden. Force the
       truncation the 200-row cap produces on a very busy month. */
    h.ev("CAL_BK.total = 640;");
    await h.render();
    expect(h.page()).toContain("of 640 equipment bookings in this range");
  });

  it("says so when the layer could not be loaded at all", async () => {
    const h = await boot({ bkStatus: 500 });
    await h.render("#/media/calendar");
    await new Promise((r) => setTimeout(r, 150));
    expect(h.page()).toContain("Equipment bookings could not be loaded");
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   PHASE 4 — who holds what comes from the server.

   eqHolder() used to answer this by sorting DB.equipment_transactions in the
   browser, in eleven places. These tests empty that array outright AND answer
   /state with a network failure: anything still deriving custody locally has
   nothing to derive it from, so it shows up here.
   ══════════════════════════════════════════════════════════════════════════ */

/** Kill every local trace of custody, so only the server can supply it. */
const blankLocalCustody = (h: Harness) =>
  h.ev("DB.equipment_transactions.length = 0; DB.equipment_items.forEach(e=>{ if(e.status==='checked_out') e.status='available'; });");

describe("current custody is a server read", () => {
  it("asks GET /equipment/custody scoped to the viewer, once, on My items", async () => {
    const h = await boot();
    blankLocalCustody(h);
    h.ev("S.tab.equip='mine'; custodyInvalidate();");
    h.calls.length = 0;
    await h.render();
    const cu = h.equipmentCalls().filter((c) => c.startsWith("/equipment/custody"));
    /* One query PER QUESTION. The page asks two: what the viewer holds, and
       what is overdue for the sidebar badge. Neither is per-asset, and neither
       is the whole ledger. */
    const mine = cu.filter((c) => c.includes("holder_id="));
    expect(mine.length, `custody calls: ${JSON.stringify(cu)}`).toBe(1);
    expect(cu.every((c) => c.includes("limit=")),
      `an unbounded custody request: ${JSON.stringify(cu)}`).toBe(true);
    expect(h.calls.some((c) => c.includes("/media/state")),
      "custody asked for /state").toBe(false);
  });

  /* THE INDEPENDENCE PROOF. The ledger is empty and /state is a network
     failure; the holder, the loan and the overdue count all still render. */
  it("renders what I hold with the local ledger emptied and /state failing", async () => {
    const h = await boot();
    blankLocalCustody(h);
    expect(h.ev<number>("DB.equipment_transactions.length")).toBe(0);
    h.ev("S.tab.equip='mine';");
    await h.render();
    const page = h.page();
    expect(page).toContain("EQ-CAM-001");
    expect(page, "the check-in action vanished with the local ledger").toContain("Check in");
    expect(h.dom.window.document.querySelectorAll('#page [data-act="checkin"]').length)
      .toBe(CUSTODY_TOTAL);
  });

  it("shows the server's overdue count, not one worked out from a browser clock", async () => {
    const h = await boot();
    blankLocalCustody(h);
    h.ev("S.tab.equip='mine';");
    await h.render();
    /* The fixture's first row is 4 days late; the others are not. The browser
       is not recomputing that from TODAY — it is printing what it was told. */
    expect(h.page()).toContain("4d overdue");
    expect(h.page()).toContain("due ");
  });

  it("takes the My items tab count from the server's total", async () => {
    const h = await boot({ cuRows: 9 });
    blankLocalCustody(h);
    h.ev("S.tab.equip='mine';");
    await h.render();
    await h.render();
    const tab = [...h.dom.window.document.querySelectorAll("#page [data-tab]")]
      .find((n) => (n as HTMLElement).dataset.tab === "mine");
    expect(tab?.textContent).toContain("9");
  });

  it("shows loading, then an error with a retry", async () => {
    const h = await boot({ cuStatus: 500 });
    blankLocalCustody(h);
    h.ev("S.tab.equip='mine';");
    h.ev("render()");
    expect(h.page()).toContain("Loading");
    await new Promise((r) => setTimeout(r, 150));
    expect(h.page()).toContain("Custody is unavailable");
    expect(h.dom.window.document.querySelector('[data-act="custodyRetry"]')).not.toBeNull();
  });

  it("says so when the viewer holds nothing", async () => {
    const h = await boot({ cuRows: 0 });
    blankLocalCustody(h);
    h.ev("S.tab.equip='mine';");
    await h.render();
    expect(h.page()).toContain("Nothing checked out to you");
  });

  it("re-asks after a checkout or a check-in, with no synchronisation step", async () => {
    const h = await boot();
    blankLocalCustody(h);
    h.ev("S.tab.equip='mine';");
    await h.render();
    expect(h.ev<number>("Object.keys(CUSTODY).length")).toBeGreaterThan(0);
    h.ev("eqInvalidate()");
    expect(h.ev<number>("Object.keys(CUSTODY).length"),
      "a write left a stale custody answer cached").toBe(0);
    h.calls.length = 0;
    await h.render();
    expect(h.equipmentCalls().filter((c) => c.startsWith("/equipment/custody")).length)
      .toBeGreaterThan(0);
  });

  it("asks one query per question, not one per asset", async () => {
    const h = await boot({ cuRows: 25 });
    blankLocalCustody(h);
    h.ev("S.tab.equip='mine'; custodyInvalidate();");
    h.calls.length = 0;
    await h.render();
    await h.render();
    const cu = h.equipmentCalls().filter((c) => c.startsWith("/equipment/custody"));
    /* Twenty-five assets in custody, and still one request for "what do I
       hold" — the number of assets does not decide the number of queries. */
    expect(cu.filter((c) => c.includes("holder_id=")).length,
      `25 assets produced these calls: ${JSON.stringify(cu)}`).toBe(1);
    expect(cu.length, `more questions than screens: ${JSON.stringify(cu)}`).toBeLessThanOrEqual(3);
  });
});

describe("the other custody consumers read the server too", () => {
  it("a colleague's profile lists what they hold", async () => {
    const h = await boot();
    blankLocalCustody(h);
    h.ev("custodyInvalidate();");
    h.calls.length = 0;
    /* Somebody other than the viewer, so the scope is visible in the request. */
    await h.render("#/media/team/2");
    await new Promise((r) => setTimeout(r, 140));
    const cu = h.equipmentCalls().filter((c) => c.startsWith("/equipment/custody"));
    expect(cu.length, `custody calls: ${JSON.stringify(cu)}`).toBeGreaterThan(0);
    expect(cu.some((c) => c.includes("holder_id=2")),
      `custody calls: ${JSON.stringify(cu)}`).toBe(true);
  });

  it("the dashboard's Equipment Due asks for what is due by today", async () => {
    const h = await boot();
    blankLocalCustody(h);
    h.ev("custodyInvalidate();");
    h.calls.length = 0;
    await h.render("#/media/home");
    await new Promise((r) => setTimeout(r, 160));
    const cu = h.equipmentCalls().filter((c) => c.startsWith("/equipment/custody"));
    expect(cu.some((c) => c.includes("due_on_or_before=")),
      `custody calls: ${JSON.stringify(cu)}`).toBe(true);
  });

  it("the overdue badge counts the server's overdue list", async () => {
    const h = await boot();
    blankLocalCustody(h);
    h.ev("custodyInvalidate();");
    h.calls.length = 0;
    await h.render("#/media/home");
    await new Promise((r) => setTimeout(r, 160));
    await h.render();
    const cu = h.equipmentCalls().filter((c) => c.startsWith("/equipment/custody"));
    expect(cu.some((c) => c.includes("overdue=1")),
      `custody calls: ${JSON.stringify(cu)}`).toBe(true);
    expect(h.ev<number>("overdueEquipment().length")).toBe(CUSTODY_TOTAL);
  });
});

describe("trgEquipStatus keeps the server's custody verdict", () => {
  /* In a live session the status column is written by checkout and check-in.
     Re-deriving it here from a local ledger let the browser overrule the
     server; the clause now only reconciles the offline seed. */
  it("does not overwrite a server status from a stale local ledger", async () => {
    const h = await boot();
    h.ev(`window.__MO_LIVE__ = true;
          DB.equipment_items[0].status='checked_out';
          DB.equipment_transactions.length = 0;
          trgEquipStatus();`);
    expect(h.ev<string>("DB.equipment_items[0].status"),
      "the browser overruled the server's checked_out").toBe("checked_out");
  });

  it("still reconciles the seed when there is no server", async () => {
    const h = await boot();
    h.ev(`window.__MO_LIVE__ = false;
          DB.equipment_items[0].status='available';
          DB.equipment_transactions.length = 0;
          DB.equipment_transactions.push({id:1, equipment_item_id:DB.equipment_items[0].id,
            action:'check_out', holder_id:1, occurred_at:'2026-09-01T10:00:00', expected_return_at:null});
          trgEquipStatus();`);
    expect(h.ev<string>("DB.equipment_items[0].status"),
      "the offline seed stopped reconciling").toBe("checked_out");
  });

  it("leaves maintenance, retired and lost alone either way", async () => {
    const h = await boot();
    for (const live of [true, false]) {
      h.ev(`window.__MO_LIVE__ = ${live};
            DB.equipment_items[1].status='maintenance';
            trgEquipStatus();`);
      expect(h.ev<string>("DB.equipment_items[1].status"), `live=${live}`).toBe("maintenance");
    }
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   PHASE 5 — the browser prints the server's state, and derives none of it.
   ══════════════════════════════════════════════════════════════════════════ */

/** The text of the registry row's Status cell — not the whole page, which
    also contains the status filter's options and the header figures. */
const statusCell = (h: Harness) =>
  h.dom.window.document.querySelectorAll("#page table.tbl tbody tr td")[6]?.textContent ?? "";

/** A registry page whose single asset carries exactly this state. */
async function withState(state: unknown | undefined, opts: Record<string, unknown> = {}) {
  const h = await boot({ ...opts, listStatus: 200 });
  h.ev(`EQ_LIST.loaded = true; EQ_LIST.loading = false; EQ_LIST.err = null;
        EQ_LIST.total = 1; EQ_LIST.offset = 0;
        EQ_LIST.rows = [${JSON.stringify({
          id: 1, asset_tag: "EQ-CAM-001", make: "Sony", model: "A7",
          serial_no: "SN-1", condition: "good", status: "available",
          category_id: 1, category_name: "Camera Body", tracking_mode: "individual",
          warranty_until: "2027-01-01", notes: null, pool_quantity: null,
          holder_id: null, holder_name: null, holder_due_at: null,
          ...(state === undefined ? {} : { state }),
        })}];
        S.tab.equip = 'catalog';`);
  await h.render();
  return h;
}
const baseState = (over: Record<string, unknown> = {}) => ({
  lifecycle: { status: "available", persisted: true, unserviceable: false },
  custody: { status: "not_held", holder_id: null, holder_name: null,
             transaction_id: null, checked_out_at: null, due_at: null, recorded_via: null },
  maintenance: { active: false, open_count: 0 },
  reservation: null,
  derived: { overdue: false, overdue_days: 0 },
  conflicts: [],
  ...over,
});

describe("the registry prints the server's status", () => {
  it("shows the lifecycle the server gave it", async () => {
    const h = await withState(baseState({
      lifecycle: { status: "maintenance", persisted: true, unserviceable: true } }));
    expect(statusCell(h)).toContain("Maintenance");
    expect(statusCell(h)).not.toContain("Available");
  });

  /* §21. THE ONE THAT MATTERS. A row the server has not answered for must not
     read as available — false availability is how two people book one camera. */
  it("shows an unanswered asset as unknown, never as available", async () => {
    const h = await withState(undefined);
    expect(statusCell(h)).toContain("Status unknown");
    expect(statusCell(h), "an asset with no server state was drawn as Available")
      .not.toContain("Available");
    expect(h.dom.window.document.querySelector('#page [data-act="checkout"]'),
      "check-out was offered for an asset with no known state").toBeNull();
  });

  it("does not offer check-out when the server does not call it available", async () => {
    for (const st of [
      baseState({ lifecycle: { status: "maintenance", persisted: true, unserviceable: true } }),
      baseState({ custody: { status: "checked_out", holder_id: 99, holder_name: "Asha",
                             transaction_id: 5, checked_out_at: "2026-09-01T10:00:00.000Z",
                             due_at: "2026-09-10", recorded_via: "desktop" } }),
    ]) {
      const h = await withState(st);
      expect(h.dom.window.document.querySelector('#page [data-act="checkout"]')).toBeNull();
    }
    const ok = await withState(baseState());
    expect(ok.dom.window.document.querySelector('#page [data-act="checkout"]')).not.toBeNull();
  });

  it("keeps the five facts apart instead of flattening them", async () => {
    const h = await withState(baseState({
      lifecycle: { status: "maintenance", persisted: true, unserviceable: true },
      custody: { status: "checked_out", holder_id: 1, holder_name: "Rahul J.",
                 transaction_id: 5, checked_out_at: "2026-09-01T10:00:00.000Z",
                 due_at: "2026-09-10", recorded_via: "desktop" },
      maintenance: { active: true, open_count: 2 },
      reservation: { status: "reserved", booking_id: 7,
                     starts_at: "2026-10-01", ends_at: "2026-10-03" },
      derived: { overdue: true, overdue_days: 4 },
      conflicts: ["held_but_lifecycle_maintenance"],
    }));
    const page = statusCell(h);
    expect(page, "lifecycle").toContain("Maintenance");
    expect(page, "custody").toContain("in hand");
    expect(page, "overdue").toContain("4d overdue");
    expect(page, "maintenance").toContain("maintenance open");
    expect(page, "reservation").toContain("reserved");
    expect(page, "the contradiction was hidden").toContain("state conflict");
  });

  it("says nothing about availability, which depends on a date range", async () => {
    const h = await withState(baseState());
    expect(h.ev<unknown>("EQ_LIST.rows[0].state.availability"),
      "availability was baked into the row").toBeUndefined();
  });
});

describe("the dashboard's equipment figures come from the server", () => {
  it("asks for the summary and prints its counts", async () => {
    const h = await boot();
    h.ev("EQ_SUMMARY.loaded=false; EQ_SUMMARY.loading=false;");
    h.calls.length = 0;
    await h.render("#/media/home");
    await new Promise((r) => setTimeout(r, 150));
    expect(h.equipmentCalls().some((c) => c.includes("summary=1")),
      `calls: ${JSON.stringify(h.equipmentCalls())}`).toBe(true);
    expect(h.page()).toContain("Equipment Out");
  });

  /* Nothing out and "we could not find out" are different things. */
  it("shows a dash, not a zero, when the summary fails", async () => {
    const h = await boot({ listStatus: 500 });
    h.ev("EQ_SUMMARY.loaded=false; EQ_SUMMARY.loading=false;");
    await h.render("#/media/home");
    await new Promise((r) => setTimeout(r, 170));
    expect(h.page()).toContain("Could not be loaded");
  });
});

describe("trgEquipStatus no longer decides anything live", () => {
  it("is a no-op in a live session, whatever the local arrays say", async () => {
    const h = await boot();
    h.ev(`window.__MO_LIVE__ = true;
          DB.equipment_items[0].status = 'available';
          DB.equipment_bookings.length = 0;
          DB.equipment_bookings.push({id:1, equipment_item_id:DB.equipment_items[0].id,
            status:'reserved', starts_at:TODAY, ends_at:D.add(TODAY,3), user_id:1});
          DB.maintenance_records.length = 0;
          DB.maintenance_records.push({id:1, equipment_item_id:DB.equipment_items[0].id,
            resolved_at:null, kind:'repair'});
          trgEquipStatus();`);
    expect(h.ev<string>("DB.equipment_items[0].status"),
      "the browser rewrote a server status from local arrays").toBe("available");
  });

  it("still reconciles the seed when there is no server", async () => {
    const h = await boot();
    h.ev(`window.__MO_LIVE__ = false;
          DB.equipment_items[0].status = 'available';
          DB.equipment_transactions.length = 0;
          DB.maintenance_records.length = 0;
          DB.equipment_bookings.length = 0;
          DB.equipment_bookings.push({id:1, equipment_item_id:DB.equipment_items[0].id,
            status:'reserved', starts_at:TODAY, ends_at:D.add(TODAY,3), user_id:1});
          trgEquipStatus();`);
    expect(h.ev<string>("DB.equipment_items[0].status")).toBe("booked");
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   PHASE 6 — analytics come from the database, not from /state.

   The old eqAnalytics() reduced three arrays the browser had been handed, two
   of which /state caps. These assert the screen asks the server once, renders
   what it is given, and keeps working with all three arrays emptied.
   ══════════════════════════════════════════════════════════════════════════ */

/** Land on the Analytics tab with its first response settled. */
async function onAnalytics(h: Harness) {
  h.ev("S.tab.equip='analytics'; EQ_AN.loaded=false; EQ_AN.loading=false; EQ_AN.offset=0;");
  h.calls.length = 0;
  await h.render();
  await new Promise((r) => setTimeout(r, 140));
  return h;
}

describe("equipment analytics are a server read", () => {
  it("asks GET /equipment/analytics once, and never touches /state", async () => {
    const h = await onAnalytics(await boot());
    const an = h.equipmentCalls().filter((c) => c.startsWith("/equipment/analytics"));
    expect(an.length, `calls: ${JSON.stringify(h.equipmentCalls())}`).toBe(1);
    expect(an[0]).toContain("limit=50");
    expect(h.calls.some((c) => c.includes("/media/state")),
      "analytics asked for /state").toBe(false);
  });

  /* §19 — THE DEPENDENCY PROOF. All three arrays emptied, /state failing, and
     every figure still renders because none of them was ever the source. */
  it("renders identically with the three local arrays emptied", async () => {
    const full = await onAnalytics(await boot());
    const before = full.page();

    const h = await boot();
    h.ev(`DB.equipment_transactions.length = 0;
          DB.equipment_bookings.length = 0;
          DB.maintenance_records.length = 0;`);
    await onAnalytics(h);
    expect(h.ev<number>("DB.equipment_transactions.length")).toBe(0);
    expect(h.ev<number>("DB.equipment_bookings.length")).toBe(0);
    expect(h.ev<number>("DB.maintenance_records.length")).toBe(0);
    expect(h.page(), "analytics changed when the local arrays were emptied").toBe(before);
  });

  it("renders the server's breakdowns without grouping anything itself", async () => {
    const h = await onAnalytics(await boot());
    const page = h.page();
    expect(page).toContain("Checkouts by category");
    expect(page).toContain("Demand heatmap by weekday");
    /* Phase 17N renamed this. The old heading said "Per-item utilisation" over
       a column showing min(100, checkouts × 14) as a percentage, under a
       tooltip claiming checked-out days ÷ available days — a formula nothing
       implemented. The section shows checkout activity and now says so. */
    expect(page).toContain("Checkout activity");
    expect(page, "the old claim came back").not.toContain("Per-item utilisation");
    /* The fixture's first item: 1,200 checkouts — far past anything /state
       could have shipped — and its costs, straight from the response. */
    expect(page).toContain("1200");
    expect(h.dom.window.document.querySelectorAll("#page table.tbl tbody tr").length).toBe(50);
  });

  it("shows a count /state could never have produced", async () => {
    const h = await onAnalytics(await boot());
    const first = h.dom.window.document.querySelector("#page table.tbl tbody tr")!;
    const checkouts = Number(first.querySelectorAll("td")[2].textContent);
    expect(checkouts, "the per-item count looks truncated").toBe(1200);
  });

  it("pages the per-item table on the server", async () => {
    const h = await onAnalytics(await boot());
    expect(h.page()).toContain(`Showing 1–50 of ${AN_ITEMS}`);
    h.calls.length = 0;
    h.ev("ACTIONS.eqAnPage({d:'1'})");
    await new Promise((r) => setTimeout(r, 140));
    expect(h.ev<number>("EQ_AN.offset")).toBe(50);
    expect(h.equipmentCalls()[0]).toContain("offset=50");
  });

  it("shows loading, then an error with a retry", async () => {
    const h = await boot({ anStatus: 500 });
    h.ev("S.tab.equip='analytics'; EQ_AN.loaded=false; EQ_AN.loading=false;");
    h.ev("render()");
    expect(h.page()).toContain("Computing analytics");
    await new Promise((r) => setTimeout(r, 150));
    expect(h.page()).toContain("Analytics could not be computed");
    expect(h.dom.window.document.querySelector('[data-act="eqAnRetry"]')).not.toBeNull();
  });

  /* §14 — ERROR IS NOT ZERO. Empty charts read as "this department owns
     nothing and books nothing", which is a different claim from "we could not
     find out", and a far more dangerous one to act on. */
  it("does not draw zeroed charts when analytics fail", async () => {
    const h = await boot({ anStatus: 500 });
    h.ev("S.tab.equip='analytics'; EQ_AN.loaded=false; EQ_AN.loading=false;");
    await h.render();
    await new Promise((r) => setTimeout(r, 150));
    const page = h.page();
    expect(page).toContain("Analytics could not be computed");
    expect(page, "a chart was drawn from a failed response").not.toContain("Checkout activity");
    expect(h.dom.window.document.querySelectorAll("#page table.tbl tbody tr").length).toBe(0);
  });

  it("says so when there is nothing to compare, without calling it an error", async () => {
    const h = await boot();
    h.ev(`S.tab.equip='analytics'; EQ_AN.loaded=true; EQ_AN.loading=false; EQ_AN.err=null;
          EQ_AN.data={from:null,to:null,by_category:[],by_weekday:[0,1,2,3,4,5,6].map(d=>({dow:d,bookings:0})),
                      items:[],total:0,limit:50,offset:0};`);
    await h.render();
    expect(h.page()).toContain("Nothing to compare yet");
    expect(h.page()).toContain("No checkouts recorded yet");
    expect(h.page(), "an empty department was reported as a failure")
      .not.toContain("could not be computed");
  });

  it("marks analytics stale after a write", async () => {
    const h = await onAnalytics(await boot());
    expect(h.ev<boolean>("EQ_AN.loaded")).toBe(true);
    h.ev("eqInvalidate()");
    expect(h.ev<boolean>("EQ_AN.loaded"), "a write left stale analytics cached").toBe(false);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   PHASE 7 — the Shoots module reads the bookings endpoint.

   Three screens used to filter DB.equipment_bookings for a shoot and then look
   each booking's asset up in DB.equipment_items. Both arrays are emptied here,
   and /state fails, so anything still reaching for them has nothing.
   ══════════════════════════════════════════════════════════════════════════ */

/** Empty the two arrays the Shoots screens used to read. */
const blankShootArrays = (h: Harness) =>
  h.ev("DB.equipment_bookings.length = 0; DB.equipment_items.length = 0;");

describe("the Shoots module reads equipment from the server", () => {
  it("asks once for every shoot on the page, not once per shoot", async () => {
    const h = await boot();
    blankShootArrays(h);
    h.ev("SHOOT_BK.key=null; SHOOT_BK.byShoot=Object.create(null); SHOOT_BK.err=null;");
    h.calls.length = 0;
    await h.render("#/media/projects/5/shoots");
    await new Promise((r) => setTimeout(r, 150));
    const bk = h.equipmentCalls().filter((c) => c.includes("shoot_id="));
    expect(bk.length, `calls: ${JSON.stringify(h.equipmentCalls())}`).toBe(1);
    /* Several shoots, one request — the whole point of the list filter. */
    const ids = new URLSearchParams(bk[0].split("?")[1]).get("shoot_id")!;
    expect(ids.split(",").length).toBeGreaterThan(1);
    expect(h.calls.some((c) => c.includes("/media/state")),
      "Shoots asked for /state").toBe(false);
  });

  it("renders the booked gear with both local arrays emptied", async () => {
    const h = await boot();
    blankShootArrays(h);
    h.ev("SHOOT_BK.key=null; SHOOT_BK.byShoot=Object.create(null);");
    await h.render("#/media/projects/5/shoots");
    await new Promise((r) => setTimeout(r, 160));
    await h.render();
    expect(h.ev<number>("DB.equipment_bookings.length")).toBe(0);
    expect(h.ev<number>("DB.equipment_items.length")).toBe(0);
    expect(h.page(), "no asset tag reached the shoots table").toContain("EQ-KIT-");
  });

  /* UNKNOWN IS NOT NONE. A shoot whose gear has not arrived must not read as a
     shoot with no gear booked — that is a run-sheet somebody packs from. */
  it("shows pending and failed differently from genuinely none", async () => {
    const h = await boot();
    blankShootArrays(h);
    h.ev("SHOOT_BK.key=null; SHOOT_BK.byShoot=Object.create(null); SHOOT_BK.err=null; SHOOT_BK.loading=false;");
    h.ev("render()");                                  // first paint, answer not back
    expect(h.page(), "a pending answer was drawn as 'none'").not.toContain("none");

    const bad = await boot({ bkStatus: 500 });
    blankShootArrays(bad);
    bad.ev("SHOOT_BK.key=null; SHOOT_BK.byShoot=Object.create(null); SHOOT_BK.err=null;");
    await bad.render("#/media/projects/5/shoots");
    await new Promise((r) => setTimeout(r, 170));
    await bad.render();
    expect(bad.page(), "a failed answer was drawn as 'none'").toContain("unavailable");
  });

  it("re-asks only when the set of shoots changes", async () => {
    const h = await boot();
    blankShootArrays(h);
    h.ev("SHOOT_BK.key=null; SHOOT_BK.byShoot=Object.create(null);");
    await h.render("#/media/projects/5/shoots");
    await new Promise((r) => setTimeout(r, 150));
    h.calls.length = 0;
    await h.render();
    expect(h.equipmentCalls().filter((c) => c.includes("shoot_id=")),
      "the same page re-asked").toEqual([]);
  });

  it("draws one shoot's kit in the drawer, from the same endpoint", async () => {
    const h = await boot();
    blankShootArrays(h);
    h.ev("SHOOT_BK.key=null; SHOOT_BK.byShoot=Object.create(null);");
    h.calls.length = 0;
    h.ev("drawerFor('shoot',1)");
    await new Promise((r) => setTimeout(r, 160));
    h.ev("drawerFor('shoot',1)");
    await new Promise((r) => setTimeout(r, 60));
    const asked = h.equipmentCalls().filter((c) => c.includes("shoot_id="));
    expect(asked.length, `calls: ${JSON.stringify(asked)}`).toBeGreaterThan(0);
    expect(h.dom.window.document.body.textContent).toContain("EQ-KIT-001");
  });
});

describe("the boot payload no longer carries equipment history", () => {
  /* The client must not fall back to the seed for an array the server has
     stopped sending — fictional cameras in a live session are worse than a big
     payload, and they would hide any consumer this migration missed. */
  /* A /state shaped like the one the server now sends: the lookups, none of
     the history. This is the real boot path, not a re-implementation of it. */
  const NEW_STATE = { me: 1, users: [], projects: [], shoots: [], shoot_crew: [],
                      equipment_categories: [], equipment_items: [],
                      equipment_kits: [], kit_items: [], module_defaults: {} };

  it("empties the removed arrays when /state omits them", async () => {
    const h = await boot({ stateBody: NEW_STATE });
    h.ev(`DB.equipment_transactions = [{id:1}]; DB.equipment_bookings = [{id:1}];
          DB.maintenance_records = [{id:1}];`);
    h.ev("hydrateFromServer()");
    await new Promise((r) => setTimeout(r, 120));
    for (const k of ["equipment_transactions", "equipment_bookings", "maintenance_records"])
      expect(h.ev<number>(`DB.${k}.length`), `${k} kept its seed in a live session`).toBe(0);
  });

  it("still honours a server that does send them", async () => {
    const h = await boot({ stateBody: { ...NEW_STATE, equipment_bookings: [{ id: 7 }] } });
    h.ev("DB.equipment_bookings = [];");
    h.ev("hydrateFromServer()");
    await new Promise((r) => setTimeout(r, 120));
    expect(h.ev<number>("DB.equipment_bookings.length"),
      "an array the server DID send was thrown away").toBe(1);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   PHASE 8 — the client asset cache.

   equip(id) stays synchronous; what changed is where it looks. The test that
   matters most is the last one in the first block: in a live session, an id
   that exists only in the prototype seed must come back UNKNOWN.
   ══════════════════════════════════════════════════════════════════════════ */

const ASSET = (id: number) => ({
  id, asset_tag: `EQ-CAM-${String(id).padStart(3, "0")}`, make: "Sony",
  model: `A7 ${id}`, condition: "good", status: "available", category_id: 1,
});

describe("the asset cache", () => {
  it("remembers one asset and several, and answers synchronously", async () => {
    const h = await boot();
    h.ev(`assetClear(); assetPut(${JSON.stringify(ASSET(11))});`);
    expect(h.ev<string>("equip(11).asset_tag")).toBe("EQ-CAM-011");
    expect(h.ev<boolean>("assetKnown(11)")).toBe(true);
    h.ev(`assetPutMany([${JSON.stringify(ASSET(12))}, ${JSON.stringify(ASSET(13))}]);`);
    expect(h.ev<boolean>("assetKnown(12) && assetKnown(13)")).toBe(true);
  });

  it("returns the existing empty-object contract for a miss, not a guess", async () => {
    const h = await boot();
    h.ev("assetClear();");
    expect(h.ev<boolean>("assetKnown(404)")).toBe(false);
    expect(h.ev<unknown>("equip(404).asset_tag")).toBeUndefined();
    expect(h.ev<string>("typeof equip(404)")).toBe("object");
  });

  it("forgets one asset, and forgets all of them", async () => {
    const h = await boot();
    h.ev(`assetClear(); assetPutMany([${JSON.stringify(ASSET(21))}, ${JSON.stringify(ASSET(22))}]);`);
    h.ev("assetForget(21);");
    expect(h.ev<boolean>("assetKnown(21)")).toBe(false);
    expect(h.ev<boolean>("assetKnown(22)")).toBe(true);
    h.ev("assetClear();");
    expect(h.ev<boolean>("assetKnown(22)")).toBe(false);
  });

  /* §25 — THE REGRESSION THIS PHASE EXISTS TO PREVENT.

     /state ships no assets. The page has a whole prototype estate compiled
     into it. In a live session equip() must answer from the server's cache or
     not at all — never with a seed camera that does not exist. */
  it("never answers from the prototype seed in a live session", async () => {
    const h = await boot();
    const seeded = h.ev<number>("DB.equipment_items.length");
    expect(seeded, "the page has no seed to be fooled by").toBeGreaterThan(0);
    const seedId = h.ev<number>("DB.equipment_items[0].id");
    const seedTag = h.ev<string>("DB.equipment_items[0].asset_tag");

    h.ev("window.__MO_LIVE__ = true; assetClear();");
    expect(h.ev<boolean>(`assetKnown(${seedId})`)).toBe(false);
    expect(h.ev<unknown>(`equip(${seedId}).asset_tag`),
      `equip() answered with the seed asset ${seedTag} in a live session`).toBeUndefined();

    /* And offline it still answers, because that is the whole of offline mode. */
    h.ev("window.__MO_LIVE__ = false;");
    expect(h.ev<string>(`equip(${seedId}).asset_tag`)).toBe(seedTag);
    h.ev("window.__MO_LIVE__ = true;");
  });

  it("starts empty when a live session begins", async () => {
    const h = await boot({ stateBody: { me: 1, users: [], projects: [], shoots: [],
                                        shoot_crew: [], equipment_categories: [],
                                        equipment_kits: [], kit_items: [], module_defaults: {} } });
    h.ev(`assetPut(${JSON.stringify(ASSET(31))});`);
    h.ev("hydrateFromServer()");
    await new Promise((r) => setTimeout(r, 130));
    expect(h.ev<boolean>("assetKnown(31)"), "the cache survived a live session start").toBe(false);
    expect(h.ev<number>("DB.equipment_items.length"),
      "the asset table fell back to the seed").toBe(0);
  });
});

describe("ensure — the asynchronous half", () => {
  it("makes no request for an asset already cached", async () => {
    const h = await boot();
    h.ev(`assetClear(); assetPut(${JSON.stringify(ASSET(41))});`);
    h.calls.length = 0;
    h.ev("assetEnsure(41)");
    await new Promise((r) => setTimeout(r, 90));
    expect(h.equipmentCalls().filter((c) => c.includes("/equipment/41"))).toEqual([]);
  });

  it("makes exactly one request for a miss, and caches the result", async () => {
    const h = await boot();
    h.ev("assetClear();");
    h.calls.length = 0;
    h.ev("assetEnsure(1)");
    await new Promise((r) => setTimeout(r, 130));
    expect(h.equipmentCalls().filter((c) => /\/equipment\/1$/.test(c)).length).toBe(1);
    expect(h.ev<boolean>("assetKnown(1)")).toBe(true);
  });

  /* A kiosk list, a kit and a render burst all ask at once. One request. */
  it("collapses concurrent asks for the same asset into one request", async () => {
    const h = await boot();
    h.ev("assetClear();");
    h.calls.length = 0;
    h.ev("for (let i=0;i<10;i++) assetEnsure(1);");
    await new Promise((r) => setTimeout(r, 150));
    expect(h.equipmentCalls().filter((c) => /\/equipment\/1$/.test(c)).length,
      "ten asks produced more than one request").toBe(1);
  });

  it("caches nothing on failure, and does not ask again for it", async () => {
    const h = await boot({ detailStatus: 404 });
    h.ev("assetClear();");
    h.ev("assetEnsure(1)");
    await new Promise((r) => setTimeout(r, 130));
    expect(h.ev<boolean>("assetKnown(1)"), "a failed fetch left an entry behind").toBe(false);
    /* A label asking repeatedly must not turn into an endless retry. */
    expect(h.ev<boolean>("ASSETS.missing.has(1)")).toBe(true);
    h.ev("assetLabel(1); assetLabel(1);");
    expect(h.ev<number>("ASSET_WANTED.size"),
      "a known-missing asset was queued for another attempt").toBe(0);
  });

  it("succeeds on a retry once the server can answer", async () => {
    const bad = await boot({ detailStatus: 404 });
    bad.ev("assetClear(); assetEnsure(1)");
    await new Promise((r) => setTimeout(r, 120));
    expect(bad.ev<boolean>("assetKnown(1)")).toBe(false);

    const good = await boot();
    good.ev("assetClear(); assetEnsure(1)");
    await new Promise((r) => setTimeout(r, 130));
    expect(good.ev<boolean>("assetKnown(1)")).toBe(true);
  });

  it("resolves many assets a few at a time, not all at once", async () => {
    const h = await boot();
    h.ev("assetClear();");
    h.calls.length = 0;
    h.ev("assetEnsureMany([1,2,3,4,5,6,7,8])");
    await new Promise((r) => setTimeout(r, 400));
    const asked = h.equipmentCalls().filter((c) => /\/equipment\/\d+$/.test(c));
    expect(asked.length, "an id was asked for twice").toBe(new Set(asked).size);
    expect(asked.length).toBeLessThanOrEqual(8);
  });
});

describe("the kit picker resolves its assets without an N+1", () => {
  it("asks for each unknown kit asset once, and not once per render", async () => {
    const h = await boot();
    h.ev("assetClear(); S.tab.equip='kits';");
    h.calls.length = 0;
    await h.render();
    await new Promise((r) => setTimeout(r, 400));
    const first = h.equipmentCalls().filter((c) => /\/equipment\/\d+$/.test(c));
    expect(first.length, "an asset was fetched twice").toBe(new Set(first).size);
    h.calls.length = 0;
    await h.render();
    await new Promise((r) => setTimeout(r, 120));
    expect(h.equipmentCalls().filter((c) => /\/equipment\/\d+$/.test(c)),
      "a second render re-fetched assets already cached").toEqual([]);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   PHASE 9 — the offline seed, as an audit rather than a change.

   These tests change nothing. They record what standalone mode actually does
   today, so the product decision in docs/ASSET_INVENTORY_OFFLINE_AUDIT.md rests
   on executable facts rather than on reading the code and hoping.

   Nothing here asserts that the behaviour is correct. Several of these are
   findings a product owner may well want changed.
   ══════════════════════════════════════════════════════════════════════════ */

/** A genuinely offline boot: /state fails and nothing sets live mode. */
async function bootOffline() {
  const calls: string[] = [];
  const dom = new JSDOM(HTML, {
    url: "http://localhost/api/media-ops/#/media/equipment",
    runScripts: "dangerously", pretendToBeVisual: true,
  });
  const w = dom.window as unknown as { fetch: unknown; eval: (s: string) => unknown };
  w.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${String(input)}`);
    throw new Error("offline");
  };
  await new Promise((r) => setTimeout(r, 260));
  const ev = <T,>(e: string) => w.eval(e) as T;
  return { dom, ev, calls,
    page: () => dom.window.document.getElementById("page")?.textContent ?? "" };
}

describe("standalone mode, as it actually behaves", () => {
  it("is entered by failure, not by choice", async () => {
    const o = await bootOffline();
    /* There is no switch, no flag and no route that turns offline mode on.
       __MO_LIVE__ is set true by hydrateFromServer() and hydrateCreatorShell()
       and by nothing else, so "offline" is simply /state having thrown. */
    expect(o.ev<boolean>("!!window.__MO_LIVE__")).toBe(false);
    expect(o.ev<number>("DB.equipment_items.length"),
      "the prototype seed is what the app falls back to").toBeGreaterThan(0);
  });

  /* THE FINDING THAT MATTERS MOST FOR THE DECISION. Phases 1–8 moved every
     equipment screen onto a read model, and a read model cannot answer
     offline. The seed is still there; the screens that used it are not. */
  it("leaves the Equipment module unable to render, seed notwithstanding", async () => {
    const o = await bootOffline();
    const broken: string[] = [], working: string[] = [];
    for (const tab of ["catalog", "availability", "bookings", "mine",
                       "transactions", "maintenance", "analytics", "kits"]) {
      o.ev(`S.tab.equip='${tab}'; render();`);
      await new Promise((r) => setTimeout(r, 170));
      (/could not be|unavailable|Retry/i.test(o.page()) ? broken : working).push(tab);
    }
    expect(broken.length, `working offline: ${working.join(", ")}`).toBeGreaterThanOrEqual(7);
    expect(working, "only Kits still draws from the seed").toContain("kits");
  });

  /* PHASE 17P CHANGED WHAT THIS TEST ASSERTS, AND THE OLD VERSION IS WORTH
     KEEPING IN VIEW. It read:

       it("records a kiosk checkout locally, sends nothing, and persists nothing")
         expect(DB.equipment_transactions.length).toBe(before + 1)
         expect(equip(1).status).toBe("checked_out")

     — a faithful description of what the code did, and of a defect. An
     unattended kiosk that had lost the API drew "Done" over a trolley of
     equipment, wrote the loans into one tab's memory, and lost them at the
     next reload. Nobody was told. 17P's brief required that path removed, so
     the assertion is now its opposite: offline, a kiosk run records NOTHING,
     sends nothing, and says so. */
  it("records nothing at all when the kiosk has no server, and says so", async () => {
    const o = await bootOffline();
    const before = o.ev<number>("DB.equipment_transactions.length");
    /* The seed's own state, whatever it is — the assertion is that the kiosk
       run did not CHANGE it, not that any particular value is wrong. */
    const status = o.ev<string>("equip(1).status");
    o.calls.length = 0;
    o.ev(`S.kiosk.holder='mo-u3'; S.kiosk.mode='check_out';
          S.kiosk.items=[1]; S.kiosk.ret='2026-12-31'; commitKiosk();`);
    await new Promise((r) => setTimeout(r, 200));

    expect(o.ev<number>("DB.equipment_transactions.length"),
      "a loan was invented in the browser").toBe(before);
    expect(o.ev<string>("equip(1).status"),
      "the browser moved an asset with no record of it").toBe(status);
    expect(o.calls.filter((c) => c.startsWith("POST")),
      "a write was attempted while offline").toEqual([]);
    /* And the run does not reach the confirmation screen. */
    expect(o.ev<number>("S.kiosk.step"), "the kiosk showed Done").not.toBe(5);
    expect(o.ev<number>("Object.keys(localStorage).length")).toBe(0);
  });

  /* OFFLINE WRITE PATHS NOW AGREE WITH EACH OTHER — AND WITH THE DATABASE.

     Phase 9 found that moSync() declines to act when offline but its ARGUMENT
     is evaluated first, so `moSync(MO_API.post(…))` had already sent a doomed
     request whose rejection was dropped unobserved. That half was fixed then.

     17P fixed the other half: the local mutation those guards were protecting
     was itself the defect. A cancellation that flipped a row in a browser
     array and reported success is a reservation the database still holds. */
  it("attempts no equipment write while offline, and invents none either", async () => {
    const o = await bootOffline();
    o.calls.length = 0;

    o.ev("ACTIONS.checkout({eid:1})");
    o.ev(`DB.equipment_bookings.push({id:9991, equipment_item_id:1, user_id:1,
            status:'reserved', starts_at:TODAY, ends_at:TODAY});
          ACTIONS.cancelBooking({bid:9991});`);
    await new Promise((r) => setTimeout(r, 250));

    expect(o.calls.filter((c) => c.startsWith("POST")),
      "a doomed write was attempted offline").toEqual([]);
    expect(o.ev<string>("DB.equipment_bookings.find(b=>b.id===9991).status"),
      "a booking was cancelled in the browser and nowhere else").toBe("reserved");
  });

  /* The class of bug, not the one instance. Every equipment mutation must
     decide whether there is a server BEFORE it does anything else — build a
     request, write a row, or say the word "booked". A new one written without
     that check fails here. */
  it("keeps every equipment mutation behind the live-write guard", () => {
    const actions = HTML.slice(HTML.indexOf("  checkout:(d)=>withAsset"));
    const offenders: string[] = [];
    for (const name of ["checkout", "checkin", "confirmCheckin", "createBooking",
                        "cancelBooking", "confirmDamage", "createEquipment"]) {
      const at = actions.indexOf(`  ${name}:`);
      expect(at, `${name} not found — this guard needs repointing`).toBeGreaterThan(-1);
      /* The handler body, to the next top-level action key. */
      const rest = actions.slice(at + name.length + 4);
      const body = rest.slice(0, rest.search(/\n {2}[a-zA-Z_]+:/));
      const post = body.indexOf("MO_API.");
      const guard = body.indexOf("liveWrite(");
      if (guard === -1 || (post !== -1 && guard > post)) offenders.push(name);
    }
    expect(offenders,
      "these act before anything checks whether there is a server").toEqual([]);
  });

  it("keeps the seed entirely out of a live session", async () => {
    /* The Phase 8 guarantee, restated from the offline side: the same seed
       that answers here must not answer there. */
    const o = await bootOffline();
    const seedTag = o.ev<string>("DB.equipment_items[0].asset_tag");
    expect(o.ev<string>("equip(DB.equipment_items[0].id).asset_tag")).toBe(seedTag);
    o.ev("window.__MO_LIVE__ = true; assetClear();");
    expect(o.ev<unknown>("equip(DB.equipment_items[0].id).asset_tag"),
      "the seed leaked into a live session").toBeUndefined();
  });
});

describe("cancelling a booking online is unchanged", () => {
  it("sends exactly one cancel, and marks the reads stale", async () => {
    const h = await boot();
    h.ev(`DB.equipment_bookings.length = 0;
          DB.equipment_bookings.push({id:9991, equipment_item_id:1, user_id:1,
            status:'reserved', starts_at:TODAY, ends_at:TODAY});
          EQ_BK.loaded = true;`);
    h.calls.length = 0;
    h.ev("ACTIONS.cancelBooking({bid:9991})");
    await new Promise((r) => setTimeout(r, 200));

    const posts = h.calls.filter((c) => c.includes("/cancel"));
    expect(posts.length, `calls: ${JSON.stringify(h.equipmentCalls())}`).toBe(1);
    expect(posts[0]).toContain("/equipment/bookings/9991/cancel");
    expect(h.ev<boolean>("EQ_BK.loaded"), "the schedule was not marked stale").toBe(false);
    /* 17P: the local row is NOT flipped any more. The Bookings tab is a server
       read and never saw that array; flipping it only mattered offline, where
       it was the whole of what "cancelled" meant. */
    expect(h.ev<string>("DB.equipment_bookings.find(b=>b.id===9991).status"),
      "the browser decided the cancellation itself").toBe("reserved");
  });

  it("still cancels a booking the browser has never seen", async () => {
    const h = await boot();
    h.ev("DB.equipment_bookings.length = 0;");
    h.calls.length = 0;
    expect(() => h.ev("ACTIONS.cancelBooking({bid:4242})")).not.toThrow();
    await new Promise((r) => setTimeout(r, 200));
    expect(h.calls.filter((c) => c.includes("/equipment/bookings/4242/cancel")).length).toBe(1);
  });
});
