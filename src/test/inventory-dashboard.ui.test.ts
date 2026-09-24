/* ═══════════════════════════════════════════════════════════════════════════
   UI — Inventory Dashboard (Phase 17K).

   The dashboard is a window, so the properties worth testing are the ones that
   would make it a second system instead: does it ask the server once and draw
   the answer, or does it recount anything itself; does every figure lead to the
   screen that owns the detail; and does the inventory switcher remain the one
   control 17A built rather than a second scope selector.
   ═══════════════════════════════════════════════════════════════════════════ */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const HTML = readFileSync("public/media-ops/index.html", "utf8");

const DASH = (o: Record<string, unknown> = {}) => ({
  scope: { level: "all", selected: "all" },
  summary: { total: 42, available: 30, checked_out: 7, reserved: 3, maintenance: 2,
             overdue: 1, pending_verification: 4, rejected: 0, lost: 1, retired: 2,
             pooled: 5, serialized: 37, attention: 8 },
  breakdowns: {
    category: [{ category: "Camera Body", count: 12 }, { category: "Lens", count: 9 }],
    tracking: [{ tracking_mode: "individual", count: 37 }, { tracking_mode: "pooled", count: 5 }],
    lifecycle: [{ lifecycle: "available", count: 30 }, { lifecycle: "checked_out", count: 7 }],
    condition: [{ condition: "good", count: 28 }, { condition: "fair", count: 9 }],
  },
  custody: [{ id: 7, asset_tag: "EQ-CAM-007", internal_code: "MC-0024", make: "SONY",
              model: "FX3", inventory_name: "Media Crew", holder_id: "u-1",
              holder_name: "Rahul Joshi", due_at: "2026-09-25", overdue: false,
              project_name: "Convocation" }],
  reservations: [{ id: 3, equipment_item_id: 8, asset_tag: "EQ-CAM-008", internal_code: "MC-0025",
                   make: "SONY", model: "A7", reserved_by: "Akshay", status: "reserved",
                   starts_at: "2026-10-01", ends_at: "2026-10-02",
                   inventory_name: "Media Crew", project_name: null }],
  maintenance: [{ id: 5, equipment_item_id: 9, asset_tag: "EQ-CAM-009", internal_code: "MC-0026",
                  make: "SONY", model: "FX6", kind: "repair", description: "Mount",
                  cost: 2500, vendor_name: "Acme", started_at: "2026-09-12",
                  next_due_at: null, inventory_name: "Media Crew" }],
  verification: [{ id: 10, asset_tag: "EQ-CAM-010", internal_code: null, make: "SONY",
                   model: "FX30", verification_state: "draft", inventory_name: "Media Crew" }],
  attention: [{ id: 7, asset_tag: "EQ-CAM-007", internal_code: "MC-0024", make: "SONY",
                model: "FX3", inventory_name: "Media Crew", reason: "overdue", severity: 1,
                on_date: "2026-09-20", holder_name: "Rahul Joshi" },
              { id: 9, asset_tag: "EQ-CAM-009", internal_code: "MC-0026", make: "SONY",
                model: "FX6", inventory_name: "Media Crew", reason: "maintenance", severity: 2,
                on_date: "2026-09-12", holder_name: null }],
  activity: { items: [{ source: "custody", id: 1, at: "2026-09-22T09:00:00.000Z",
                        event: "check_out", equipment_item_id: 7, asset_tag: "EQ-CAM-007",
                        internal_code: "MC-0024", actor_name: "Rahul Joshi", detail: "good" }],
              total: 1, limit: 20, offset: 0 },
  ...o,
});

async function openDash(o: { dash?: Record<string, unknown>; status?: number } = {}) {
  const { status = 200 } = o;
  const calls: string[] = [];
  const dom = new JSDOM(HTML, { url: "http://localhost/api/media-ops/#/media/equipment",
    runScripts: "dangerously", pretendToBeVisual: true });
  const w = dom.window as unknown as { fetch: unknown; eval: (s: string) => unknown };
  w.fetch = async (input: RequestInfo | URL) => {
    const url = String(input); calls.push(url);
    const reply = (s: number, b: unknown) => ({ ok: s < 400, status: s, json: async () => b }) as Response;
    if (url.includes("/api/v1/media/state")) return reply(200, {});
    if (url.includes("/equipment/dashboard")) {
      if (status !== 200) return reply(status, { message: "nope" });
      return reply(200, o.dash ?? DASH());
    }
    if (url.includes("/equipment/inventories")) return reply(200, {
      inventories: [{ id: 11, code: "media_crew", name: "Media Crew", code_prefix: "MC", assets: 7 },
                    { id: 12, code: "pid", name: "PID", code_prefix: "PID", assets: 12 }],
      legacy: { code: "legacy", name: "Not Assigned", assets: 32 }, scope_level: "all" });
    if (url.includes("/equipment?")) return reply(200, { items: [], total: 0, limit: 50, offset: 0,
      summary: { total: 0, available: 0, checked_out: 0, booked: 0, maintenance: 0, book_value: 0, overdue: 0 } });
    return reply(200, {});
  };
  await new Promise((r) => setTimeout(r, 300));
  const ev = <T,>(e: string) => w.eval(e) as T;
  ev(`window.can = () => true; can = window.can;`);
  ev(`S.tab.equip='dashboard'; EQ_DASH.loaded=false;`);
  ev("render()"); await new Promise((r) => setTimeout(r, 240));
  ev("render()"); await new Promise((r) => setTimeout(r, 220));
  return { dom, ev, calls, page: () => dom.window.document.getElementById("page")?.innerHTML ?? "" };
}

describe("the dashboard asks the server once and draws the answer", () => {
  it("makes ONE dashboard request for the whole page", async () => {
    const h = await openDash();
    expect(h.calls.filter((c) => c.includes("/equipment/dashboard")).length,
      `calls: ${JSON.stringify(h.calls)}`).toBe(1);
    /* And composes nothing per row: no asset read, no ledger read, no
       verification-queue read. (The Equipment PAGE has its own overdue widget
       that asks /equipment/custody — that predates this tab and is not the
       dashboard assembling its own answer.) */
    for (const per of ["/equipment/transactions", "/equipment/verification-queue",
                       "/equipment/maintenance?asset_id", "/equipment/7"])
      expect(h.calls.filter((c) => c.includes(per)).length, per).toBe(0);
  });

  it("shows the server's figures without recomputing them", async () => {
    const p = (await openDash()).page();
    for (const n of ["42", "30", "7", "8"]) expect(p).toContain(n);
    expect(p).toContain("37 serialized · 5 pooled");
    expect(p).toContain("1 overdue");
  });

  it("bounds what it asks for", async () => {
    const h = await openDash();
    const url = h.calls.find((c) => c.includes("/equipment/dashboard"))!;
    expect(url).toMatch(/limit=\d+/);
    expect(url).toMatch(/offset=\d+/);
  });

  it("draws every section the response carries", async () => {
    const p = (await openDash()).page();
    for (const heading of ["Needs attention", "Out now", "Upcoming reservations",
                           "Open maintenance", "Awaiting verification", "Recent activity",
                           "By category", "By lifecycle", "By condition", "By tracking mode"])
      expect(p, heading).toContain(heading);
  });

  it("lists a reason per attention row rather than one row per asset", async () => {
    const p = (await openDash()).page();
    expect(p).toContain("Overdue");
    expect(p).toContain("In maintenance");
    expect(p).toContain("Rahul Joshi");
  });

  it("links every asset into Asset 360 rather than a detail screen of its own", async () => {
    const p = (await openDash()).page();
    expect(p).toContain("#/media/equipment/EQ-CAM-007");
    expect(p).toContain("#/media/equipment/EQ-CAM-009");
  });

  it("re-asks the server when a filter changes", async () => {
    const h = await openDash();
    h.calls.length = 0;
    h.ev(`ACTIONS.eqDashFilter({k:'condition'}, {value:'poor'})`);
    await new Promise((r) => setTimeout(r, 250));
    expect(h.calls.filter((c) => c.includes("/equipment/dashboard")).pop()).toContain("condition=poor");
  });

  it("shares ONE inventory switcher with the catalogue", async () => {
    /* 17A's control, not a second scope selector. */
    const h = await openDash();
    h.calls.length = 0;
    h.ev(`ACTIONS.eqFilter({k:'inventory'}, {value:'pid'})`);
    await new Promise((r) => setTimeout(r, 250));
    const last = h.calls.filter((c) => c.includes("/equipment/dashboard")).pop();
    expect(last, "the switcher did not drive the dashboard").toContain("inventory=pid");
    expect(h.ev<string>(`EQ_LIST.f.inventory`), "the catalogue did not keep the choice").toBe("pid");
  });

  it("pages the activity feed through the server", async () => {
    const many = DASH({ activity: { items: Array.from({ length: 20 }, (_, i) => ({
      source: "custody", id: i + 1, at: "2026-09-22T09:00:00.000Z", event: "check_in",
      equipment_item_id: 7, asset_tag: "EQ-CAM-007", internal_code: "MC-0024",
      actor_name: "Rahul Joshi", detail: null })), total: 57, limit: 20, offset: 0 } });
    const h = await openDash({ dash: many });
    expect(h.page()).toContain("Showing 1–20 of 57");
    h.calls.length = 0;
    h.ev(`ACTIONS.eqDashPage({d:'1'})`);
    await new Promise((r) => setTimeout(r, 250));
    expect(h.calls.filter((c) => c.includes("/equipment/dashboard")).pop()).toContain("offset=20");
  });

  it("says what is empty, in words", async () => {
    const empty = DASH({ custody: [], reservations: [], maintenance: [], verification: [],
                         attention: [], activity: { items: [], total: 0, limit: 20, offset: 0 } });
    const p = (await openDash({ dash: empty })).page();
    expect(p).toMatch(/Nothing needs attention in this inventory/i);
    expect(p).toMatch(/Nothing is checked out/i);
    expect(p).toMatch(/No live reservations/i);
    expect(p).toMatch(/No open maintenance/i);
    expect(p).toMatch(/Nothing is waiting to be verified/i);
    expect(p).toMatch(/No recent activity/i);
    expect(p).not.toMatch(/\bundefined\b|\bNaN\b/);
  });

  it("reports a failure instead of drawing an empty inventory", async () => {
    const p = (await openDash({ status: 500 })).page();
    expect(p).toMatch(/could not be loaded/i);
    expect(p).not.toMatch(/Nothing needs attention/i);
  });

  it("is invalidated by a write, so the next render re-asks", async () => {
    const h = await openDash();
    expect(h.ev<boolean>("EQ_DASH.loaded")).toBe(true);
    h.ev("eqInvalidate()");
    expect(h.ev<boolean>("EQ_DASH.loaded"), "a write left stale dashboard figures").toBe(false);
  });
});
