/* ═══════════════════════════════════════════════════════════════════════════
   UI — Equipment access, from Users & Roles.

   THE THING THIS PANEL EXISTS TO PREVENT. Module access, inventory scope and
   the custodian duty were administered on three different screens, one of them
   organised by inventory rather than by person. "Make this employee a PID
   custodian" therefore meant three visits, in the right order, and forgetting
   the third produced somebody who can open Equipment, holds PID, and cannot
   act — which reads as a broken product rather than an unfinished sentence.

   So the panel shows all three, says in words what the combination MEANS, and
   saves them in one request. These tests pin the parts that would silently
   mislead an administrator if they drifted:

     · the inventories come from the server, so a future one appears by itself
     · the ticks are the server's state, not the browser's guess
     · "Saved" appears only after the server says so
     · a failure says so and does not look like a success
   ═══════════════════════════════════════════════════════════════════════════ */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const HTML = readFileSync("public/media-ops/index.html", "utf8");

const ACCESS = (o: Record<string, unknown> = {}) => ({
  user: { id: "mo-u77", full_name: "Zed Access", email: "zed@x.invalid",
          role: "user", team: "media", status: "active", mo_role: "employee" },
  module: { key: "equipment", enabled: true, unrestricted: false,
            bypassed_by_role: false,
            effective_modules: ["home", "my-day", "equipment"] },
  inventories: [
    { id: 1, code: "media_crew", name: "Media Crew", code_prefix: "MC",
      assigned: true, granted_at: "2026-01-04T00:00:00.000Z", granted_by_name: "Rahul" },
    { id: 2, code: "pid", name: "PID", code_prefix: "PID",
      assigned: false, granted_at: null, granted_by_name: null },
  ],
  custodian: { duty_flag_id: 1, code: "equipment_custodian", name: "Equipment Custodian",
               description: "Looks after an inventory.", granted: false },
  history: [],
  ...o,
});

type Call = { url: string; method: string; body: unknown };

async function open(o: { access?: Record<string, unknown>; patch?: () => { status: number; body: unknown } } = {}) {
  const calls: Call[] = [];
  const dom = new JSDOM(HTML, { url: "http://localhost/api/media-ops/#/media/admin/users",
    runScripts: "dangerously", pretendToBeVisual: true });
  const w = dom.window as unknown as { fetch: unknown; eval: (s: string) => unknown };
  w.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = String(init?.method ?? "GET");
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null });
    const reply = (s: number, b: unknown) => ({ ok: s < 400, status: s, json: async () => b }) as Response;
    if (url.includes("/equipment-access")) {
      if (method === "PATCH") {
        const r = o.patch ? o.patch() : { status: 200, body: o.access ?? ACCESS() };
        return reply(r.status, r.body);
      }
      return reply(200, o.access ?? ACCESS());
    }
    if (url.includes("/api/v1/media/state")) return reply(200, {});
    return reply(200, {});
  };
  await new Promise((r) => setTimeout(r, 300));
  const ev = <T,>(e: string) => w.eval(e) as T;
  /* An Admin looking at an employee. The subject needs a row in DB.users
     because ruid() maps the table's integer id to the real Nerve id the
     endpoint is addressed by — the same mapping every other admin action uses. */
  ev(`DB.users.unshift({id:77,real_id:'mo-u77',role:'user',full_name:'Zed Access',
        initials:'ZA',color:'#888',is_active:true});
      DB.users.unshift({id:78,real_id:'mo-u78',role:'admin',full_name:'Access Tester',
        initials:'AT',color:'#888',is_active:true});
      S.me=78; window.__MO_LIVE__=true;`);
  ev("ACTIONS.equipAccess({uid:'77'})");
  await new Promise((r) => setTimeout(r, 260));
  const doc = dom.window.document;
  return { dom, ev, calls,
    layer: () => doc.getElementById("modal-layer")?.innerHTML ?? "",
    body: () => doc.getElementById("ea-body")?.innerHTML ?? "",
    foot: () => doc.getElementById("ea-foot")?.innerHTML ?? "",
    /* Click the real input so the real onchange wiring runs. */
    click: async (sel: string) => {
      (doc.querySelector(sel) as HTMLElement | null)?.click();
      await new Promise((r) => setTimeout(r, 60));
    },
    save: async () => {
      (doc.querySelector('#ea-foot [data-act="eaSave"]') as HTMLElement | null)?.click();
      await new Promise((r) => setTimeout(r, 200));
    },
    patches: () => calls.filter((c) => c.method === "PATCH"),
  };
}

describe("the equipment access panel", () => {
  it("is reachable from Users & Roles, on the row for a person", async () => {
    expect(HTML).toContain('data-act="equipAccess" data-uid="${u.id}"');
    /* And that page is Admin-only in the router, as it always was. */
    expect(HTML).toMatch(/admin\/users['"][^}]*minRole:'admin'/);
  });

  it("renders the three layers under their own headings", async () => {
    const h = await open();
    const b = h.body();
    expect(b).toContain("MODULE");
    expect(b).toContain("INVENTORY ACCESS");
    expect(b).toContain("CUSTODIAL PERMISSIONS");
    expect(b).toContain("ACCESS SUMMARY");
  });

  it("asks the server for this person's access, by their real id", async () => {
    const h = await open();
    const read = h.calls.find((c) => c.url.includes("/equipment-access") && c.method === "GET");
    expect(read, `calls: ${JSON.stringify(h.calls.map((c) => c.url))}`).toBeTruthy();
    expect(read!.url).toContain("/crew/mo-u77/equipment-access");
  });

  it("lists the inventories the SERVER returned, and nothing hard-coded", async () => {
    const h = await open();
    expect(h.body()).toContain("Media Crew");
    expect(h.body()).toContain("PID");
    /* A third inventory must appear with no change to this file. */
    const h2 = await open({ access: ACCESS({ inventories: [
      { id: 9, code: "frames24", name: "24 Frames", code_prefix: "TF",
        assigned: false, granted_at: null, granted_by_name: null }] }) });
    expect(h2.body()).toContain("24 Frames");
    expect(h2.body(), "an inventory the server did not send was drawn").not.toContain("Media Crew");
  });

  it("ticks exactly what the server says is assigned", async () => {
    const h = await open();
    const doc = h.dom.window.document;
    const mc = doc.querySelector('.ea-scope[value="1"]') as HTMLInputElement;
    const pid = doc.querySelector('.ea-scope[value="2"]') as HTMLInputElement;
    expect(mc.checked, "Media Crew is assigned and was drawn unticked").toBe(true);
    expect(pid.checked, "PID is not assigned and was drawn ticked").toBe(false);
    expect((doc.querySelector("#ea-module") as HTMLInputElement).checked).toBe(true);
  });

  it("reflects the custodian duty the server reported", async () => {
    const off = await open();
    expect((off.dom.window.document.querySelector("#ea-duty") as HTMLInputElement).checked).toBe(false);
    const on = await open({ access: ACCESS({
      custodian: { duty_flag_id: 1, code: "equipment_custodian", name: "Equipment Custodian",
                   description: "", granted: true } }) });
    expect((on.dom.window.document.querySelector("#ea-duty") as HTMLInputElement).checked).toBe(true);
  });

  it("says what the combination means, in a sentence", async () => {
    /* A tick list says what was clicked. This says what it GRANTS, which is the
       thing worth reading before pressing Save. */
    const h = await open({ access: ACCESS({
      inventories: [{ id: 2, code: "pid", name: "PID", code_prefix: "PID",
                      assigned: true, granted_at: null, granted_by_name: null }],
      custodian: { duty_flag_id: 1, code: "equipment_custodian",
                   name: "Equipment Custodian", description: "", granted: true } }) });
    expect(h.body()).toContain("Can manage PID equipment.");
    /* Scope without the duty is a viewer, and the sentence must not overstate it. */
    const viewer = await open({ access: ACCESS({
      inventories: [{ id: 2, code: "pid", name: "PID", code_prefix: "PID",
                      assigned: true, granted_at: null, granted_by_name: null }] }) });
    expect(viewer.body()).toMatch(/Can see PID equipment, but not act on it/);
  });

  it("says so when there is no inventory, rather than showing an empty list", async () => {
    const h = await open({ access: ACCESS({ inventories: [
      { id: 1, code: "media_crew", name: "Media Crew", code_prefix: "MC",
        assigned: false, granted_at: null, granted_by_name: null }] }) });
    expect(h.body()).toContain("No inventory assigned.");
  });

  it("will not let an inventory be ticked while the module is off", async () => {
    const h = await open({ access: ACCESS({
      module: { key: "equipment", enabled: false, unrestricted: false,
                bypassed_by_role: false, effective_modules: ["home"] } }) });
    expect(h.body()).toMatch(/Equipment module access is required/i);
    const pid = h.dom.window.document.querySelector('.ea-scope[value="2"]') as HTMLInputElement;
    expect(pid.disabled, "an inventory was offered without the module").toBe(true);
  });

  it("warns that turning the module off writes an explicit list for a role-based account", async () => {
    /* Not a detail: it changes them from "inherits their role" to "custom", and
       an administrator should be told before it happens rather than after. */
    const h = await open({ access: ACCESS({
      module: { key: "equipment", enabled: true, unrestricted: true,
                bypassed_by_role: false, effective_modules: ["home", "equipment"] } }) });
    expect(h.body()).toMatch(/inherited from their role/i);
    expect(h.body()).toMatch(/writes an explicit module list/i);
  });

  it("explains that an Admin cannot have Equipment taken away by this panel", async () => {
    const h = await open({ access: ACCESS({
      module: { key: "equipment", enabled: true, unrestricted: true,
                bypassed_by_role: true, effective_modules: [] } }) });
    expect(h.body()).toMatch(/reaches every module and every inventory by role/i);
  });
});

describe("saving equipment access", () => {
  it("sends one request carrying all three layers", async () => {
    const h = await open();
    await h.click('.ea-scope[value="2"]');          // + PID
    await h.click("#ea-duty");                      // + custodian
    await h.save();
    const p = h.patches();
    expect(p.length, `patches: ${JSON.stringify(p)}`).toBe(1);
    expect(p[0].url).toContain("/crew/mo-u77/equipment-access");
    expect(p[0].body).toEqual({
      module_enabled: true,
      inventory_scope_ids: [1, 2],
      equipment_custodian: true,
    });
  });

  it("sends the removal of an inventory as its absence, not a delete call", async () => {
    const h = await open();
    await h.click('.ea-scope[value="1"]');          // − Media Crew
    await h.save();
    expect((h.patches()[0].body as { inventory_scope_ids: number[] }).inventory_scope_ids).toEqual([]);
    /* One transactional PATCH — never a DELETE per inventory, which is how a
       half-applied change happens. */
    expect(h.calls.filter((c) => c.method === "DELETE")).toEqual([]);
  });

  it("offers nothing to save until something has changed", async () => {
    const h = await open();
    const btn = () => h.dom.window.document.querySelector('#ea-foot [data-act="eaSave"]') as HTMLButtonElement;
    expect(btn().disabled, "Save was live before anything was edited").toBe(true);
    await h.click("#ea-duty");
    expect(btn().disabled).toBe(false);
  });

  it("shows Saved only after the server has confirmed it", async () => {
    const h = await open();
    await h.click("#ea-duty");
    expect(h.foot(), "Saved before saving").not.toMatch(/Saved/);
    await h.save();
    expect(h.foot()).toMatch(/Saved/);
  });

  it("does not claim success when the server refuses", async () => {
    const h = await open({ patch: () => ({ status: 409,
      body: { message: "An archived or inactive inventory cannot be assigned. Restore it first." } }) });
    await h.click('.ea-scope[value="2"]');
    await h.save();
    expect(h.foot(), "a refusal was reported as success").not.toMatch(/(^|[^n])Saved/);
    expect(h.foot()).toMatch(/Failed — changes not saved/);
    expect(h.foot()).toMatch(/archived or inactive inventory/);
  });

  it("redraws from the server's reply rather than from what was clicked", async () => {
    /* The server is entitled to commit something other than the draft — a
       materialised module list, for instance. The panel must show what landed. */
    const h = await open({ patch: () => ({ status: 200, body: ACCESS({
      inventories: [
        { id: 1, code: "media_crew", name: "Media Crew", code_prefix: "MC",
          assigned: false, granted_at: null, granted_by_name: null },
        { id: 2, code: "pid", name: "PID", code_prefix: "PID",
          assigned: true, granted_at: "2026-09-24T00:00:00.000Z", granted_by_name: "Access Tester" },
      ] }) }) });
    await h.click('.ea-scope[value="2"]');
    await h.save();
    const doc = h.dom.window.document;
    expect((doc.querySelector('.ea-scope[value="1"]') as HTMLInputElement).checked,
      "the panel kept the draft instead of the committed state").toBe(false);
    expect((doc.querySelector('.ea-scope[value="2"]') as HTMLInputElement).checked).toBe(true);
  });

  it("refuses to save at all when the page cannot reach the server", async () => {
    const h = await open();
    h.ev("window.__MO_LIVE__=false");
    await h.click("#ea-duty");
    await h.save();
    expect(h.patches(), "a write was attempted with no server").toEqual([]);
  });
});
