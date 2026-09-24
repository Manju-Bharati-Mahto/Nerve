/* ═══════════════════════════════════════════════════════════════════════════
   UI — Asset 360° (Phase 17E).

   The real page in jsdom with a scripted server. Two things are worth asserting
   here and neither is "a tab exists".

   WHAT THE PAGE COSTS. Opening an asset asks for the asset. It does not ask for
   its custody history, its reservations, its maintenance, its audit trail or
   anything else until somebody opens that section — and when they do, it asks
   the SERVER for a page rather than filtering something it was handed. A page
   that loads eight histories to show one of them is the /state mistake again,
   one asset at a time.

   WHAT THE PAGE SAYS WHEN THERE IS NOTHING. An asset with no holder is not "—",
   and an asset with no inventory is not "MC-0000". Absence has to read as
   absence, or the registry quietly invents facts.
   ═══════════════════════════════════════════════════════════════════════════ */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const HTML = readFileSync("public/media-ops/index.html", "utf8");

const STATE = (o: Record<string, unknown> = {}) => ({
  lifecycle: { status: "available", persisted: true, unserviceable: false },
  custody: { status: "not_held", holder_id: null, holder_name: null, transaction_id: null,
             checked_out_at: null, due_at: null, recorded_via: null },
  maintenance: { active: false, open_count: 0 },
  reservation: null,
  verification: { state: "active", note: null, persisted: true, in_inventory: true },
  derived: { overdue: false, overdue_days: 0 },
  conflicts: [],
  ...o,
});

const ASSET = (o: Record<string, unknown> = {}) => ({
  id: 7, asset_tag: "EQ-CAM-007", internal_code: "MC-0024",
  inventory_name: "Media Crew", inventory_code: "media_crew",
  make: "SONY", model: "FX3", serial_no: "SN-FX3-0091",
  category_id: 1, category_name: "Camera Body", tracking_mode: "individual", pool_quantity: null,
  condition: "good", status: "available", notes: null,
  asset_uid: "AT-7", qr_uid: "QR-7",
  purchase_date: "2025-01-01", purchase_cost: 250000, campus_id: 1, vendor_id: null,
  insurance_policy_no: "P-1", insurance_until: "2027-01-01", warranty_until: "2027-01-01",
  created_at: "2026-01-02T10:00:00.000Z", updated_at: "2026-09-01T10:00:00.000Z",
  verification_state: "active", verification_note: null,
  state: STATE(),
  ...o,
});

interface Opts {
  item?: Record<string, unknown>;
  timeline?: unknown[]; timelineTotal?: number;
  bookings?: unknown[]; maintenance?: unknown[]; audit?: unknown[]; auditTotal?: number;
  inspections?: unknown[];
  canManage?: boolean;
}

async function open360(o: Opts = {}) {
  const { canManage = true } = o;
  const item = o.item ?? ASSET();
  const calls: string[] = [];
  const dom = new JSDOM(HTML, { url: "http://localhost/api/media-ops/#/media/equipment",
    runScripts: "dangerously", pretendToBeVisual: true });
  const w = dom.window as unknown as { fetch: unknown; eval: (s: string) => unknown };
  w.fetch = async (input: RequestInfo | URL) => {
    const url = String(input); calls.push(url);
    const reply = (s: number, b: unknown) => ({ ok: s < 400, status: s, json: async () => b }) as Response;
    const page = (items: unknown[], total?: number) =>
      reply(200, { items, total: total ?? items.length, limit: 20, offset: 0 });
    if (url.includes("/api/v1/media/state")) return reply(200, {});
    if (url.includes("/equipment/inventories")) return reply(200, {
      inventories: [{ id: 11, code: "media_crew", name: "Media Crew", code_prefix: "MC", assets: 7 }],
      legacy: { code: "legacy", name: "Not Assigned", assets: 32 }, scope_level: "all" });
      if (url.includes("/inspections")) return page(o.inspections ?? []);
    if (url.includes("/timeline")) return page(o.timeline ?? [], o.timelineTotal);
    if (url.includes("/audit")) return page(o.audit ?? [], o.auditTotal);
    if (url.includes("/equipment/bookings")) return page(o.bookings ?? []);
    if (url.includes("/equipment/maintenance")) return page(o.maintenance ?? []);
    if (/\/equipment\/[^/?]+$/.test(url)
        && !/\/(inventories|transactions|maintenance|availability|bookings|custody|analytics|rules|resolve)$/.test(url))
      return reply(200, { item, identifiers: [], transactions: [], bookings: [],
                          maintenance: [], holder: null, escalation: null });
    if (url.includes("/equipment?")) return reply(200, { items: [item], total: 1, limit: 50, offset: 0 });
    throw new Error("offline");
  };
  await new Promise((r) => setTimeout(r, 300));
  const ev = <T,>(e: string) => w.eval(e) as T;
  ev(`window.can = (k) => k === 'equipment.manage' ? ${canManage} : true; can = window.can;`);
  ev(`location.hash = '#/media/equipment/${item.asset_tag}';`);
  ev("render()"); await new Promise((r) => setTimeout(r, 220));
  ev("render()"); await new Promise((r) => setTimeout(r, 220));
  const tab = async (k: string) => {
    ev(`S.tab.asset='${k}';`); ev("render()");
    await new Promise((r) => setTimeout(r, 260));
    ev("render()"); await new Promise((r) => setTimeout(r, 200));
  };
  return { dom, ev, calls, tab,
    page: () => dom.window.document.getElementById("page")?.innerHTML ?? "" };
}

describe("the header answers what this is and where it belongs", () => {
  it("leads with the name, the internal code, the inventory and the category", async () => {
    const p = (await open360()).page();
    expect(p).toContain("SONY FX3");
    expect(p).toContain("MC-0024");
    expect(p).toContain("Media Crew");
    expect(p).toContain("Camera Body");
  });

  it("shows the identifiers an asset actually has, and no others", async () => {
    const p = (await open360()).page();
    expect(p).toContain("SN-FX3-0091");
    expect(p).toContain("AT-7");
    expect(p).not.toMatch(/RFID/i);          // no RFID identifier exists on this asset
  });

  it("says PENDING and NOT ASSIGNED for an ungoverned asset — never a fake code", async () => {
    const p = (await open360({ item: ASSET({ internal_code: null, inventory_name: null,
      inventory_code: null, serial_no: null }) })).page();
    expect(p).toMatch(/Internal code pending/i);
    expect(p).toContain("Not Assigned");
    expect(p).not.toMatch(/MC-0000|PID-0000/);
    /* And never the database id wearing a costume. */
    expect(p).not.toMatch(/Internal code<\/dt><dd>7</);
  });

  it("distinguishes pooled inventory from a serialized asset", async () => {
    const ser = (await open360()).page();
    expect(ser).toContain("Serialized");
    const pooled = (await open360({ item: ASSET({ tracking_mode: "pooled", pool_quantity: 48,
      model: "Battery" }) })).page();
    expect(pooled).toContain("Pooled");
    expect(pooled).toContain("48 units");
  });

  it("flags a record that is not yet inventory", async () => {
    const p = (await open360({ item: ASSET({ verification_state: "draft",
      state: STATE({ verification: { state: "draft", note: null, persisted: true, in_inventory: false } }) }) })).page();
    expect(p).toContain("Draft");
  });
});

describe("the overview keeps the five states apart", () => {
  it("draws all five as separate answers", async () => {
    const p = (await open360()).page();
    for (const k of ["Lifecycle", "Verification", "Custody", "Reservation", "Maintenance"])
      expect(p, k).toContain(k);
    /* The one word the page must never invent. */
    expect(p).not.toMatch(/\bUnavailable\b/);
  });

  it("shows four true facts at once without merging them", async () => {
    const p = (await open360({ item: ASSET({
      status: "checked_out",
      state: STATE({
        lifecycle: { status: "checked_out", persisted: true, unserviceable: false },
        custody: { status: "checked_out", holder_id: "u-1", holder_name: "Rahul Joshi",
                   transaction_id: 5, checked_out_at: "2026-09-20T09:00:00.000Z",
                   due_at: "2026-09-25", recorded_via: "kiosk" },
        maintenance: { active: true, open_count: 2 },
        reservation: { status: "reserved", booking_id: 3, starts_at: "2026-10-01",
                       ends_at: "2026-10-02", user_id: "u-1", project_id: null },
        verification: { state: "pending_verification", note: null, persisted: true, in_inventory: false },
      }) }) })).page();
    expect(p).toContain("Checked out");
    expect(p).toContain("Pending verification");
    expect(p).toContain("Reserved");
    expect(p).toContain("2 open records");
  });

  it("reports a contradiction instead of picking a winner", async () => {
    const p = (await open360({ item: ASSET({
      state: STATE({ conflicts: ["held_but_lifecycle_maintenance"] }) }) })).page();
    expect(p).toMatch(/disagrees with itself/i);
    expect(p).toContain("held but lifecycle maintenance");
    expect(p).toMatch(/nothing here decides between them/i);
  });

  it("costs ONE request — no section is fetched before it is opened", async () => {
    const h = await open360();
    const noisy = h.calls.filter((c) => /timeline|\/audit|bookings|maintenance/.test(c));
    expect(noisy, `unopened sections were fetched: ${JSON.stringify(noisy)}`).toEqual([]);
  });
});

describe("each section is a server read, taken when it is opened", () => {
  it("asks for custody history only when the tab is opened", async () => {
    const h = await open360({ timeline: [{ source: "custody", id: 1, occurred_at: "2026-09-20T09:00:00.000Z",
      event: "check_out", actor_id: "u-1", actor_name: "Rahul Joshi", detail: "good",
      recorded_via: "kiosk", kind: null, resolved: null, due_at: "2026-09-25" }] });
    expect(h.calls.some((c) => c.includes("timeline"))).toBe(false);
    await h.tab("custody");
    const asked = h.calls.filter((c) => c.includes("timeline"));
    expect(asked.length).toBeGreaterThan(0);
    expect(asked[asked.length - 1]).toContain("kind=custody");
    expect(h.page()).toContain("Checked out");
    expect(h.page()).toContain("Rahul Joshi");
  });

  it("asks the booking endpoint for this asset, current first and past on request", async () => {
    const h = await open360({ bookings: [{ id: 3, starts_at: "2026-10-01", ends_at: "2026-10-02",
      user_id: "u-1", user_name: "Rahul Joshi", project_name: "Convocation", shoot_title: null,
      status: "reserved" }] });
    await h.tab("reservations");
    const b = h.calls.filter((c) => c.includes("/equipment/bookings"));
    expect(b[b.length - 1]).toContain("asset_id=7");
    /* PHASE 17G — "current and upcoming" is `live=1`, which the SERVER resolves
       from status AND dates. A reservation whose last day has passed is history
       however its status column reads, and nothing sweeps the table to say so;
       asking by status alone showed last March's booking as current. */
    expect(b[b.length - 1]).toContain("live=1");
    expect(h.page()).toContain("Convocation");
    h.ev(`ACTIONS.a360Alt({k:'reservations', v:'1'})`);
    await new Promise((r) => setTimeout(r, 260));
    expect(h.calls.filter((c) => c.includes("/equipment/bookings")).pop())
      .toContain("live=0");
  });

  it("splits upkeep from damage by kind", async () => {
    const h = await open360({ maintenance: [{ id: 1, kind: "maintenance", description: "Annual service",
      started_at: "2026-09-12", resolved_at: "2026-09-13", cost: 1200, vendor_name: "Acme",
      next_due_at: null, reported_by: null }] });
    await h.tab("maintenance");
    expect(h.calls.filter((c) => c.includes("/equipment/maintenance")).pop())
      .toContain("kind=maintenance,repair");
    expect(h.page()).toContain("Annual service");
    await h.tab("damage");
    expect(h.calls.filter((c) => c.includes("/equipment/maintenance")).pop())
      .toContain("kind=damage_report");
  });

  it("draws the whole history in one sequence", async () => {
    const h = await open360({ timeline: [
      { source: "custody", id: 2, occurred_at: "2026-09-22T09:00:00.000Z", event: "check_out",
        actor_id: "u-1", actor_name: "Rahul Joshi", detail: "good", recorded_via: "desktop",
        kind: null, resolved: null, due_at: null },
      { source: "maintenance", id: 9, occurred_at: "2026-09-12T00:00:00.000Z", event: "damage_report",
        actor_id: null, actor_name: "Akshay", detail: "Cracked filter", recorded_via: null,
        kind: "damage_report", resolved: true, due_at: "2026-09-14" },
    ] });
    await h.tab("transactions");
    const p = h.page();
    expect(p).toContain("Checked out");
    expect(p).toContain("Damage reported");
    expect(p).toContain("Cracked filter");
  });

  it("pages through the SERVER, not through the browser", async () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      source: "custody", id: i + 1, occurred_at: `2026-09-${String(i % 28 + 1).padStart(2, "0")}T09:00:00.000Z`,
      event: i % 2 ? "check_in" : "check_out", actor_id: "u-1", actor_name: "Rahul Joshi",
      detail: null, recorded_via: "desktop", kind: null, resolved: null, due_at: null }));
    const h = await open360({ timeline: many, timelineTotal: 57 });
    await h.tab("transactions");
    expect(h.page()).toContain("Showing 1–20 of 57");
    h.calls.length = 0;
    h.ev(`ACTIONS.a360Page({k:'transactions', d:'1'})`);
    await new Promise((r) => setTimeout(r, 260));
    expect(h.calls.filter((c) => c.includes("timeline")).pop()).toContain("offset=20");
  });

  it("never asks for an unbounded history", async () => {
    const h = await open360();
    await h.tab("transactions");
    for (const c of h.calls.filter((x) => /timeline|\/audit|bookings|maintenance/.test(x)))
      expect(c, c).toMatch(/limit=\d+/);
  });
});

describe("verification and audit", () => {
  it("shows the state, the reason and the way back", async () => {
    const h = await open360({ item: ASSET({ verification_state: "rejected",
      verification_note: "Serial does not match the physical asset.",
      state: STATE({ verification: { state: "rejected", in_inventory: false, persisted: true,
        note: "Serial does not match the physical asset." } }) }) });
    await h.tab("verification");
    const p = h.page();
    expect(p).toContain("Rejected");
    expect(p).toContain("Serial does not match the physical asset.");
    expect(p).toContain("Return to Draft");
    expect(p).toMatch(/cannot be booked or issued/i);
  });

  it("reads only the verification slice of the trail", async () => {
    const h = await open360();
    await h.tab("verification");
    expect(h.calls.filter((c) => c.includes("/audit")).pop())
      .toContain("action_prefix=equipment.verification_");
  });

  it("turns an audit action into a sentence", async () => {
    const h = await open360({ audit: [
      { id: 1, action: "equipment.inventory_assigned", actor_id: "u-1", actor_name: "Rahul Joshi",
        actor_role: "admin", before: null, after: null, occurred_at: "2026-09-20T09:00:00.000Z" }] });
    await h.tab("audit");
    expect(h.page()).toContain("Inventory assigned");
    expect(h.page()).not.toContain("equipment.inventory_assigned");
  });

  it("is not offered to a colleague who may not review", async () => {
    const h = await open360({ canManage: false });
    await h.tab("audit");
    expect(h.page()).toMatch(/Equipment Custodians and Admins/);
    expect(h.calls.some((c) => c.includes("/audit")), "it asked anyway").toBe(false);
  });
});

describe("absence reads as absence", () => {
  it("says what is missing, in words", async () => {
    const h = await open360();
    await h.tab("custody");
    expect(h.page()).toMatch(/Currently available/i);
    expect(h.page()).toMatch(/No custody history/i);
    await h.tab("reservations");
    expect(h.page()).toMatch(/No current or upcoming reservations/i);
    await h.tab("maintenance");
    expect(h.page()).toMatch(/No maintenance records/i);
    await h.tab("damage");
    expect(h.page()).toMatch(/No damage reports/i);
    await h.tab("audit");
    expect(h.page()).toMatch(/No audit events available/i);
  });

  it("says plainly when an asset has never been inspected", async () => {
    /* PHASE 17I made inspection a real domain. This used to assert the
       opposite — "not yet part of this system" — which was true when it was
       written and is exactly what the phase removed. */
    const h = await open360();
    await h.tab("damage");
    expect(h.page()).toMatch(/No inspections recorded for this asset yet/i);
    expect(h.page()).not.toMatch(/not yet part of this system/i);
  });

  it("never shows a bare dash, N\\/A, null or undefined where a sentence belongs", async () => {
    const h = await open360();
    for (const t of ["custody", "reservations", "maintenance", "damage", "audit"]) {
      await h.tab(t);
      const empty = h.page().match(/<div class="empty"[\s\S]*?<\/div>\s*<\/div>/g)?.join(" ") ?? "";
      expect(empty, t).not.toMatch(/\bN\/A\b|\bundefined\b|\bnull\b/);
    }
  });
});

describe("moving between assets", () => {
  it("does not show one asset's history under another's name", async () => {
    const h = await open360({ timeline: [{ source: "custody", id: 1,
      occurred_at: "2026-09-20T09:00:00.000Z", event: "check_out", actor_id: "u-1",
      actor_name: "Rahul Joshi", detail: null, recorded_via: "desktop", kind: null,
      resolved: null, due_at: null }] });
    await h.tab("transactions");
    expect(h.page()).toContain("Rahul Joshi");
    /* A different asset: the sections are dropped rather than redrawn. */
    h.ev(`EQ_ITEM.tag='EQ-CAM-999'; a360Reset();`);
    expect(h.ev<number>(`Object.keys(A360.sec).length`)).toBe(0);
    expect(h.ev<string>(`S.tab.asset`)).toBe("overview");
  });

  it("drops every section when a write lands", async () => {
    const h = await open360();
    await h.tab("transactions");
    expect(h.ev<number>(`Object.keys(A360.sec).length`)).toBeGreaterThan(0);
    h.ev("eqInvalidate()");
    expect(h.ev<number>(`Object.keys(A360.sec).length`)).toBe(0);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   PHASE 17G — moving a reservation from the Asset 360 page.

   The control edits the booking rather than cancelling and recreating it, so
   the reservation keeps its identity and its place in the record.
   ═══════════════════════════════════════════════════════════════════════════ */
describe("a reservation can be moved from the asset page", () => {
  const RESERVED = [{ id: 3, starts_at: "2031-10-01", ends_at: "2031-10-02",
    user_id: "u-1", user_name: "Rahul Joshi", project_name: "Convocation",
    shoot_title: null, status: "reserved" }];

  it("offers the control on a live reservation, and not in history", async () => {
    const h = await open360({ bookings: RESERVED });
    await h.tab("reservations");
    expect(h.page()).toContain("Change dates");
    h.ev(`ACTIONS.a360Alt({k:'reservations', v:'1'})`);
    await new Promise((r) => setTimeout(r, 260));
    expect(h.page(), "history offered a control that edits the past").not.toContain("Change dates");
  });

  it("PATCHES the existing booking rather than replacing it", async () => {
    const h = await open360({ bookings: RESERVED });
    await h.tab("reservations");
    h.ev(`ACTIONS.editBooking({bid:'3', s:'2031-10-01', e:'2031-10-02'})`);
    await new Promise((r) => setTimeout(r, 150));
    const m = h.dom.window.document.getElementById("modal-layer")?.innerHTML ?? "";
    expect(m).toContain("2031-10-01");
    expect(m).toMatch(/Both days are included/i);
    h.calls.length = 0;
    h.ev("document.querySelector('#eb-e').value='2031-10-05'");
    h.ev("document.querySelector('#eb-go').click()");
    await new Promise((r) => setTimeout(r, 200));
    const sent = h.calls.filter((c) => c.includes("/equipment/bookings/3"));
    expect(sent.length, "the booking was not edited in place").toBe(1);
    /* And nothing was cancelled or created to achieve it. */
    expect(h.calls.some((c) => c.includes("/cancel"))).toBe(false);
  });

  it("will not send a move with a missing date", async () => {
    const h = await open360({ bookings: RESERVED });
    await h.tab("reservations");
    h.ev(`ACTIONS.editBooking({bid:'3', s:'2031-10-01', e:'2031-10-02'})`);
    await new Promise((r) => setTimeout(r, 150));
    h.calls.length = 0;
    h.ev("document.querySelector('#eb-s').value=''");
    h.ev("document.querySelector('#eb-go').click()");
    await new Promise((r) => setTimeout(r, 200));
    expect(h.calls.filter((c) => c.includes("/equipment/bookings/3")).length).toBe(0);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   PHASE 17I — inspection and maintenance closure, from the asset page.

   Two decisions kept apart on screen because they are two decisions in the
   model: marking repair work finished, and deciding the camera may go out.
   ═══════════════════════════════════════════════════════════════════════════ */
describe("inspection and closure on the asset page", () => {
  const INSPECTIONS = [
    { id: 2, inspector_id: "u-1", inspector_name: "Rahul Joshi", observed_condition: "good",
      outcome: "passed", notes: "Second look — it was dirt.", inspected_at: "2026-09-20T09:00:00.000Z" },
    { id: 1, inspector_id: "u-1", inspector_name: "Rahul Joshi", observed_condition: "poor",
      outcome: "maintenance_required", notes: "Looked cracked.", inspected_at: "2026-09-18T09:00:00.000Z" },
  ];

  it("shows the inspection history, newest first, with what was seen", async () => {
    const h = await open360({ inspections: INSPECTIONS });
    await h.tab("damage");
    const p = h.page();
    expect(p).toContain("Passed");
    expect(p).toContain("Maintenance required");
    expect(p).toContain("Observed: good");
    expect(p).toContain("Second look — it was dirt.");
  });

  it("asks the inspections endpoint, not the maintenance one", async () => {
    const h = await open360({ inspections: INSPECTIONS });
    await h.tab("damage");
    expect(h.calls.some((c) => c.includes("/inspections"))).toBe(true);
  });

  it("offers Mark resolved only on an OPEN maintenance record", async () => {
    const h = await open360({ maintenance: [
      { id: 1, kind: "repair", description: "Open one", started_at: "2026-09-12",
        resolved_at: null, cost: null, vendor_name: null, next_due_at: null, reported_by: null },
      { id: 2, kind: "repair", description: "Closed one", started_at: "2026-09-01",
        resolved_at: "2026-09-05", resolution_note: "Serviced", cost: null,
        vendor_name: null, next_due_at: null, reported_by: null }] });
    await h.tab("maintenance");
    const p = h.page();
    expect(p).toContain("Mark resolved");
    expect(p).toContain("Serviced");
    /* One control, for the one open record. */
    expect(p.match(/Mark resolved/g)!.length).toBe(1);
  });

  it("says resolving does NOT return the asset to service", async () => {
    const h = await open360({ maintenance: [
      { id: 1, kind: "repair", description: "Open", started_at: "2026-09-12", resolved_at: null,
        cost: null, vendor_name: null, next_due_at: null, reported_by: null }] });
    await h.tab("maintenance");
    let asked = "";
    h.ev(`window.confirm = (m) => { window.__ASKED = m; return false; };`);
    h.ev(`ACTIONS.resolveMaint({mid:'1'})`);
    await new Promise((r) => setTimeout(r, 120));
    asked = h.ev<string>(`window.__ASKED`);
    expect(asked).toMatch(/does NOT return the asset to service/i);
    /* Declined, so nothing was sent. */
    expect(h.calls.some((c) => c.includes("/maintenance/1/resolve"))).toBe(false);
  });

  it("records an inspection and can release a repaired asset", async () => {
    const h = await open360({ item: ASSET({ status: "maintenance",
      state: STATE({ lifecycle: { status: "maintenance", persisted: true, unserviceable: true },
                     maintenance: { active: false, open_count: 0 } }) }) });
    await h.tab("damage");
    h.ev(`ACTIONS.inspectAsset({eid:'7', cond:'good', status:'maintenance', open:'0'})`);
    await new Promise((r) => setTimeout(r, 150));
    const m = h.dom.window.document.getElementById("modal-layer")?.innerHTML ?? "";
    expect(m).toMatch(/Release this asset back into service/i);
    expect(m).toMatch(/cannot be edited afterwards/i);
    h.calls.length = 0;
    h.ev(`document.querySelector('#insp-go').click()`);
    await new Promise((r) => setTimeout(r, 200));
    expect(h.calls.some((c) => c.includes("/equipment/7/inspections"))).toBe(true);
  });

  it("will not offer release while work is still open, and says why", async () => {
    const h = await open360();
    await h.tab("damage");
    h.ev(`ACTIONS.inspectAsset({eid:'7', cond:'good', status:'maintenance', open:'2'})`);
    await new Promise((r) => setTimeout(r, 150));
    const m = h.dom.window.document.getElementById("modal-layer")?.innerHTML ?? "";
    expect(m).not.toMatch(/Release this asset back into service/i);
    /* The sentence wraps in the template, so the count and the noun are
       matched across whitespace rather than as one literal. */
    expect(m.replace(/\s+/g, " ")).toMatch(/2 open maintenance records/i);
    expect(m).toMatch(/Resolve them before it can be released/i);
  });

  it("will not submit a failed inspection with no explanation", async () => {
    const h = await open360();
    await h.tab("damage");
    h.ev(`ACTIONS.inspectAsset({eid:'7', cond:'good', status:'available', open:'0'})`);
    await new Promise((r) => setTimeout(r, 150));
    h.ev(`document.querySelector('#insp-out button[data-o="maintenance_required"]').click()`);
    h.calls.length = 0;
    h.ev(`document.querySelector('#insp-go').click()`);
    await new Promise((r) => setTimeout(r, 200));
    expect(h.calls.some((c) => c.includes("/inspections"))).toBe(false);
  });

  it("shows what a repair cost, who did it, and how it ended", async () => {
    /* PHASE 17J — three columns the schema always had and nothing could write. */
    const h = await open360({ maintenance: [
      { id: 1, kind: "repair", description: "Lens mount replaced", started_at: "2026-09-01",
        resolved_at: "2026-09-05", resolution_note: "Mount swapped", resolved_by: "u-1",
        resolved_by_name: "Rahul Joshi", cost: 2500.5, vendor_id: 2, vendor_name: "Acme Optics",
        next_due_at: "2027-03-01", reported_by: null }] });
    await h.tab("maintenance");
    const p = h.page();
    expect(p).toContain("Acme Optics");
    expect(p).toContain("Next due");
    expect(p).toContain("Resolved by Rahul Joshi: Mount swapped");
  });

  it("offers Update only while the record is open", async () => {
    const h = await open360({ maintenance: [
      { id: 1, kind: "repair", description: "Open one", started_at: "2026-09-12", resolved_at: null,
        cost: null, vendor_id: null, vendor_name: null, next_due_at: null, reported_by: null },
      { id: 2, kind: "repair", description: "Closed one", started_at: "2026-09-01",
        resolved_at: "2026-09-05", cost: null, vendor_id: null, vendor_name: null,
        next_due_at: null, reported_by: null }] });
    await h.tab("maintenance");
    expect(h.page().match(/>Update</g)!.length, "history offered an edit control").toBe(1);
  });

  it("PATCHES the open record with the operational fields", async () => {
    const h = await open360({ maintenance: [
      { id: 7, kind: "repair", description: "Open", started_at: "2026-09-12", resolved_at: null,
        cost: null, vendor_id: null, vendor_name: null, next_due_at: null, reported_by: null }] });
    await h.tab("maintenance");
    h.ev(`ACTIONS.editMaint({mid:'7', desc:'Open', cost:'', vendor:'', due:''})`);
    await new Promise((r) => setTimeout(r, 150));
    const m = h.dom.window.document.getElementById("modal-layer")?.innerHTML ?? "";
    expect(m).toMatch(/Next service due/i);
    expect(m).toMatch(/Internal — no vendor/i);
    expect(m).toMatch(/only be updated while it is open/i);
    h.calls.length = 0;
    h.ev(`document.querySelector('#mt-cost').value='1200.75'`);
    h.ev(`document.querySelector('#mt-go').click()`);
    await new Promise((r) => setTimeout(r, 220));
    expect(h.calls.some((c) => c.includes("/equipment/maintenance/7"))).toBe(true);
  });

  it("offers neither control to somebody who may not manage equipment", async () => {
    const h = await open360({ canManage: false, inspections: INSPECTIONS,
      maintenance: [{ id: 1, kind: "repair", description: "Open", started_at: "2026-09-12",
        resolved_at: null, cost: null, vendor_name: null, next_due_at: null, reported_by: null }] });
    await h.tab("damage");
    expect(h.page()).not.toContain("Record inspection");
    await h.tab("maintenance");
    expect(h.page()).not.toContain("Mark resolved");
    expect(h.page()).not.toContain(">Update<");
  });
});
