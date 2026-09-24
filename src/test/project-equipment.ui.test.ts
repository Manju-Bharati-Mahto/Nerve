/* ═══════════════════════════════════════════════════════════════════════════
   UI — Project Equipment (Phase 17H).

   The tab is a window onto existing records, so what matters here is that it
   stays one: the page asks the SERVER for the project's equipment and draws the
   answer, rather than assembling a second opinion out of bookings and assets it
   happens to be holding. Reserving from a project posts to the same booking
   endpoint the Equipment module uses — there is no project booking path.
   ═══════════════════════════════════════════════════════════════════════════ */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const HTML = readFileSync("public/media-ops/index.html", "utf8");

const ROW = (o: Record<string, unknown> = {}) => ({
  id: 41, equipment_item_id: 7, status: "reserved", user_id: "u-1",
  starts_at: "2031-09-18", ends_at: "2031-09-20", live: true, started: false,
  asset_tag: "EQ-CAM-007", internal_code: "MC-0024", make: "SONY", model: "FX3",
  asset_status: "available", verification_state: "active", category_id: 1,
  tracking_mode: "individual", category_name: "Camera Body",
  inventory_name: "Media Crew", inventory_code: "media_crew",
  booked_by_name: "Rahul Joshi", shoot_title: null,
  holder_id: null, holder_name: null, checked_out_at: null, due_at: null, overdue: false,
  ...o,
});

interface Opts {
  current?: unknown[]; upcoming?: unknown[]; history?: unknown[]; historyTotal?: number;
  project?: Record<string, unknown>; canManage?: boolean; status?: number;
}

async function openTab(o: Opts = {}) {
  const { canManage = true, status = 200 } = o;
  const calls: { url: string; method: string }[] = [];
  const dom = new JSDOM(HTML, { url: "http://localhost/api/media-ops/#/media/equipment",
    runScripts: "dangerously", pretendToBeVisual: true });
  const w = dom.window as unknown as { fetch: unknown; eval: (s: string) => unknown };
  w.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET" });
    const reply = (s: number, b: unknown) => ({ ok: s < 400, status: s, json: async () => b }) as Response;
    if (url.includes("/api/v1/media/state")) return reply(200, {});
    if (/\/projects\/\d+\/equipment/.test(url)) {
      if (status !== 200) return reply(status, { message: "nope" });
      return reply(200, {
        project: o.project ?? { id: 5, code: "P-5", name: "Convocation",
          status: "active", start_date: "2031-09-15", end_date: "2031-09-25" },
        current: o.current ?? [], upcoming: o.upcoming ?? [],
        history: { items: o.history ?? [], total: o.historyTotal ?? (o.history ?? []).length,
                   limit: 20, offset: 0 },
      });
    }
    if (url.includes("/equipment/inventories")) return reply(200, {
      inventories: [{ id: 11, code: "media_crew", name: "Media Crew", code_prefix: "MC", assets: 7 }],
      legacy: { code: "legacy", name: "Not Assigned", assets: 32 }, scope_level: "all" });
    if (url.includes("/equipment?")) return reply(200, { items: [
      { id: 7, asset_tag: "EQ-CAM-007", internal_code: "MC-0024", make: "SONY", model: "FX3",
        inventory_name: "Media Crew", status: "available" }], total: 1, limit: 8, offset: 0 });
    if (url.includes("/equipment/bookings")) return reply(201, { booking: { id: 99 } });
    return reply(200, {});
  };
  await new Promise((r) => setTimeout(r, 300));
  const ev = <T,>(e: string) => w.eval(e) as T;
  ev(`window.can = (k) => k === 'equipment.manage' ? ${canManage} : true; can = window.can;`);
  ev(`window.moduleAllowed = () => true; moduleAllowed = window.moduleAllowed;`);
  /* THE APPLICATION'S OWN SEEDED PROJECT. Replacing DB.projects with a bare
     row makes the project page render against a fixture whose related
     collections do not exist — deliverables, assignments, shoots — which fails
     in the page rather than in the tab under test. */
  ev(`location.hash = '#/media/projects/' + DB.projects[0].id + '/equipment';`);
  ev("render()"); await new Promise((r) => setTimeout(r, 240));
  ev("render()"); await new Promise((r) => setTimeout(r, 220));
  return { dom, ev, calls,
    page: () => dom.window.document.getElementById("page")?.innerHTML ?? "",
    modal: () => dom.window.document.getElementById("modal-layer")?.innerHTML ?? "" };
}

describe("the project equipment tab reads the server's answer", () => {
  it("asks ONE endpoint, once, however many rows come back", async () => {
    /* The N+1 this replaces would be: list the bookings, then ask about each
       asset's custody. Twenty rows must cost exactly what one row costs. */
    const many = Array.from({ length: 20 }, (_, i) => ROW({ id: 200 + i, equipment_item_id: 100 + i }));
    const h = await openTab({ upcoming: many });
    const asked = h.calls.filter((c) => /\/projects\/\d+\/equipment/.test(c.url));
    expect(asked.length, `calls: ${JSON.stringify(h.calls.map((c) => c.url))}`).toBe(1);
    /* And nothing per row: no asset read, no custody read, no ledger read. */
    for (const per of ["/equipment/transactions", "/equipment/custody?asset_id", "/equipment/7"])
      expect(h.calls.filter((c) => c.url.includes(per)).length, per).toBe(0);
    expect(h.page()).toContain("MC-0024");
  });

  it("bounds what it asks for", async () => {
    const h = await openTab();
    const asked = h.calls.find((c) => /\/projects\/\d+\/equipment/.test(c.url))!;
    expect(asked.url).toMatch(/limit=\d+/);
    expect(asked.url).toMatch(/offset=\d+/);
  });

  it("shows the equipment, its inventory, its dates and its state", async () => {
    const p = (await openTab({ upcoming: [ROW()] })).page();
    expect(p).toContain("SONY FX3");
    expect(p).toContain("MC-0024");
    expect(p).toContain("Media Crew");
    expect(p).toContain("Reserved");
  });

  it("distinguishes reserved from checked out, and names the holder", async () => {
    const p = (await openTab({ current: [ROW({ started: true, status: "active",
      holder_id: "u-9", holder_name: "Akshay", due_at: "2031-09-20" })] })).page();
    expect(p).toContain("Checked out");
    expect(p).toContain("Akshay");
    expect(p).toMatch(/due /);
    expect(p).not.toContain("Not checked out");
  });

  it("marks a returned and a cancelled reservation in history", async () => {
    const p = (await openTab({ history: [ROW({ id: 8, live: false, status: "completed" }),
                                          ROW({ id: 9, live: false, status: "cancelled" })] })).page();
    expect(p).toContain("Returned");
    expect(p).toContain("Cancelled");
  });

  it("says a project's dates are a starting point, not the booking's", async () => {
    const p = (await openTab()).page();
    expect(p).toMatch(/This project runs/i);
    expect(p).toMatch(/Equipment dates are set per reservation/i);
  });

  it("copes with a project that has no dates", async () => {
    const p = (await openTab({ project: { id: 5, code: "P-5", name: "X", status: "active",
      start_date: null, end_date: null } })).page();
    expect(p).toMatch(/This project has no dates/i);
    expect(p).not.toContain("null");
  });

  it("says what is missing, in words", async () => {
    const p = (await openTab()).page();
    expect(p).toMatch(/Nothing is reserved or out for this project today/i);
    expect(p).toMatch(/No upcoming reservations/i);
    expect(p).toMatch(/No past equipment on this project/i);
  });

  it("pages history through the server", async () => {
    const many = Array.from({ length: 20 }, (_, i) => ROW({ id: 100 + i, live: false, status: "completed" }));
    const h = await openTab({ history: many, historyTotal: 44 });
    expect(h.page()).toContain("Showing 1–20 of 44");
    h.calls.length = 0;
    h.ev(`ACTIONS.peqPage({d:'1'})`);
    await new Promise((r) => setTimeout(r, 240));
    expect(h.calls.filter((c) => /\/projects\/\d+\/equipment/.test(c.url)).pop()!.url).toContain("offset=20");
  });

  it("links into the asset's own page rather than repeating it", async () => {
    const p = (await openTab({ upcoming: [ROW()] })).page();
    expect(p).toContain("#/media/equipment/EQ-CAM-007");
    expect(p).toContain("View asset");
  });

  it("reports a failure instead of drawing an empty project", async () => {
    const p = (await openTab({ status: 500 })).page();
    expect(p).toMatch(/could not be loaded/i);
    expect(p).not.toMatch(/No upcoming reservations/i);
  });
});

describe("reserving from a project uses the existing booking endpoint", () => {
  it("posts to /equipment/bookings with the project as a label", async () => {
    const h = await openTab();
    h.ev(`ACTIONS.peqAdd({pid:String(DB.projects[0].id)})`);
    await new Promise((r) => setTimeout(r, 150));
    expect(h.modal()).toMatch(/Add equipment to this project/i);
    /* The dates default to the project's, and are editable. */
    expect(h.ev<string>(`document.querySelector('#pq-s').value`)).toBe("2031-09-15");

    h.ev(`document.querySelector('#pq-q').value='FX3'`);
    h.ev(`document.querySelector('#pq-q').dispatchEvent(new window.Event('input'))`);
    await new Promise((r) => setTimeout(r, 400));
    h.ev(`document.querySelector('[data-pick]').click()`);
    h.calls.length = 0;
    h.ev(`document.querySelector('#pq-go').click()`);
    await new Promise((r) => setTimeout(r, 250));
    const post = h.calls.find((c) => c.url.includes("/equipment/bookings"));
    expect(post, "it did not use the existing booking endpoint").toBeDefined();
    expect(post!.method).toBe("POST");
    /* No project-specific booking route was invented. */
    expect(h.calls.some((c) => /\/projects\/\d+\/(bookings|reserve)/.test(c.url))).toBe(false);
  });

  it("searches through the server, so scope decides what can be picked", async () => {
    const h = await openTab();
    h.ev(`ACTIONS.peqAdd({pid:String(DB.projects[0].id)})`);
    await new Promise((r) => setTimeout(r, 150));
    h.calls.length = 0;
    h.ev(`document.querySelector('#pq-q').value='FX3'`);
    h.ev(`document.querySelector('#pq-q').dispatchEvent(new window.Event('input'))`);
    await new Promise((r) => setTimeout(r, 400));
    expect(h.calls.some((c) => c.url.includes("/equipment?")), "the picker searched a local array").toBe(true);
  });

  it("will not reserve before an asset is chosen", async () => {
    const h = await openTab();
    h.ev(`ACTIONS.peqAdd({pid:String(DB.projects[0].id)})`);
    await new Promise((r) => setTimeout(r, 150));
    expect(h.ev<boolean>(`document.querySelector('#pq-go').disabled`)).toBe(true);
  });

  it("is not offered to somebody who may not manage equipment", async () => {
    const p = (await openTab({ canManage: false, upcoming: [ROW()] })).page();
    expect(p).not.toContain("Add equipment");
    expect(p).not.toContain(">Cancel<");
  });
});
