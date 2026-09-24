/* ═══════════════════════════════════════════════════════════════════════════
   UI — Physical verification worklist (Phase 17M).

   Two properties, and neither of them is "the tab renders".

   THE OBSERVATION PANEL STARTS EMPTY. The whole reason a row reaches this
   screen is that the spreadsheet could not settle what the equipment is. If
   the page helpfully prefills "what you can see" from what the sheet claimed,
   the verifier is confirming the sheet rather than reading the equipment, and
   the screen has quietly become a rubber stamp. The fields being blank is the
   feature.

   THE LIST IS THE SERVER'S. Filters and paging go to the server as query
   parameters. A browser-side filter over a page of twenty-five would silently
   only filter the twenty-five it happens to be holding, which is the /state
   mistake in a smaller costume.
   ═══════════════════════════════════════════════════════════════════════════ */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const HTML = readFileSync("public/media-ops/index.html", "utf8");

const ROW = (o: Record<string, unknown> = {}) => ({
  id: 501, batch_id: 9, source_row: 12,
  source_name: "SONY FX3", source_inventory: "MEDIA CREW", source_sr_no: "12",
  normalized_name: "SONY FX3", proposed_serial_no: null,
  proposed_category_name: "Camera Body", proposed_inventory_name: "Media Crew",
  proposed_tracking_mode: "individual", proposed_quantity: null, warnings: [],
  batch_file_name: "inventory.xlsx", candidate_count: 1,
  top_candidate_tag: "EQ-CAM-001", top_candidate_confidence: "POSSIBLE",
  age_days: 4, inspected: false, ...o,
});
const CANDIDATE = (o: Record<string, unknown> = {}) => ({
  id: 77, asset_tag: "EQ-CAM-001", internal_code: "MC-0024", serial_no: "SN-REAL-9",
  make: "SONY", model: "FX3", status: "available", condition: "good",
  verification_state: "active", category_name: "Camera Body", inventory_name: "Media Crew",
  held: false, holder_name: null, confidence: "POSSIBLE", why: "Name contains the model", ...o,
});

async function openWorklist(o: { items?: unknown[]; total?: number;
                                 row?: Record<string, unknown>; candidates?: unknown[] } = {}) {
  const calls: string[] = [];
  const dom = new JSDOM(HTML, { url: "http://localhost/api/media-ops/#/media/equipment",
    runScripts: "dangerously", pretendToBeVisual: true });
  const w = dom.window as unknown as { fetch: unknown; eval: (s: string) => unknown };
  w.fetch = async (input: RequestInfo | URL) => {
    const url = String(input); calls.push(url);
    const reply = (s: number, b: unknown) => ({ ok: s < 400, status: s, json: async () => b }) as Response;
    if (url.includes("/api/v1/media/state")) return reply(200, {});
    if (url.includes("/equipment/inventories")) return reply(200, {
      inventories: [{ id: 11, code: "media_crew", name: "Media Crew", code_prefix: "MC", assets: 7 }],
      legacy: { code: "legacy", name: "Not Assigned", assets: 32 }, scope_level: "all" });
    if (url.includes("/equipment/verification-worklist/"))
      return reply(200, { row: o.row ?? ROW(), candidates: o.candidates ?? [CANDIDATE()], counts: {} });
    if (url.includes("/equipment/verification-worklist"))
      return reply(200, { items: o.items ?? [ROW()], total: o.total ?? 1, limit: 25, offset: 0,
                          scope: { level: "all", selected: "all" } });
    if (url.includes("/equipment?")) return reply(200, { items: [], total: 0, limit: 50, offset: 0 });
    throw new Error("offline");
  };
  await new Promise((r) => setTimeout(r, 300));
  const ev = <T,>(e: string) => w.eval(e) as T;
  ev("window.can = () => true; can = window.can;");
  ev("S.tab.equip='verify';"); ev("render()");
  await new Promise((r) => setTimeout(r, 260));
  ev("render()"); await new Promise((r) => setTimeout(r, 200));
  return { dom, ev, calls,
    page: () => dom.window.document.getElementById("page")?.innerHTML ?? "",
    layer: () => dom.window.document.getElementById("modal-layer")?.innerHTML ?? "" };
}

describe("the physical verification worklist", () => {
  it("asks the server for the queue, and never for every batch", async () => {
    const { calls } = await openWorklist();
    expect(calls.some((u) => u.includes("/equipment/verification-worklist"))).toBe(true);
    /* Not by walking batches, which is the thing the cross-batch list replaces. */
    expect(calls.filter((u) => /\/equipment\/imports(\?|$)/.test(u)), "it enumerated batches").toEqual([]);
  });

  it("sends its filters and its page to the server", async () => {
    const h = await openWorklist();
    h.ev("EQ_PV.f.status='open'; EQ_PV.f.age_days='7'; EQ_PV.offset=25; EQ_PV.loaded=false; eqPvLoad();");
    await new Promise((r) => setTimeout(r, 240));
    const asked = h.calls.filter((u) => u.includes("verification-worklist")).pop() ?? "";
    expect(asked).toContain("status=open");
    expect(asked).toContain("age_days=7");
    expect(asked).toContain("offset=25");
  });

  it("shows the source row, the candidate and how long it has waited", async () => {
    const p = (await openWorklist()).page();
    expect(p).toContain("SONY FX3");
    expect(p).toContain("EQ-CAM-001");
    expect(p).toContain("POSSIBLE");
    expect(p).toMatch(/4d/);
    expect(p).toMatch(/Not seen/i);
  });

  it("says plainly when nothing is waiting, rather than showing an empty table", async () => {
    const p = (await openWorklist({ items: [], total: 0 })).page();
    expect(p).toMatch(/Nothing is waiting to be looked at/i);
  });

  it("separates what the sheet claims from what the verifier can see", async () => {
    const h = await openWorklist();
    h.ev("ACTIONS.eqPvOpen({rid:'501',bid:'9'})");
    await new Promise((r) => setTimeout(r, 260));
    const m = h.layer();
    expect(m).toMatch(/What the sheet claims/i);
    expect(m).toMatch(/What you can see/i);
    /* The claim is labelled as a claim. */
    expect(m).toMatch(/A claim, not a fact/i);
    /* Sr. No is named for what it is, wherever it appears. */
    expect(m).toMatch(/a row counter, never a serial/i);
  });

  it("leaves every observation field EMPTY — the sheet does not fill them in", async () => {
    const h = await openWorklist();
    h.ev("ACTIONS.eqPvOpen({rid:'501',bid:'9'})");
    await new Promise((r) => setTimeout(r, 260));
    const doc = h.dom.window.document;
    for (const id of ["pv-make", "pv-model", "pv-serial", "pv-code"]) {
      const el = doc.getElementById(id) as HTMLInputElement | null;
      expect(el, `${id} is missing`).toBeTruthy();
      expect(el!.value, `${id} was prefilled, so the verifier would only confirm it`).toBe("");
    }
  });

  it("shows the candidate as Nerve currently holds it, not as the sheet described it", async () => {
    const h = await openWorklist();
    h.ev("ACTIONS.eqPvOpen({rid:'501',bid:'9'})");
    await new Promise((r) => setTimeout(r, 260));
    const m = h.layer();
    expect(m).toContain("MC-0024");
    expect(m).toContain("SN-REAL-9");
    expect(m).toMatch(/never a decision/i);
  });

  it("is honest when Nerve holds nothing like the row", async () => {
    const h = await openWorklist({ candidates: [] });
    h.ev("ACTIONS.eqPvOpen({rid:'501',bid:'9'})");
    await new Promise((r) => setTimeout(r, 260));
    expect(h.layer()).toMatch(/Nerve holds nothing that looks like this row/i);
  });
});
