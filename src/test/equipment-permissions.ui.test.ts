/* ═══════════════════════════════════════════════════════════════════════════
   UI — Equipment → Permissions.

   The real public/media-ops/index.html, in jsdom, with the server replaced by
   a recording fetch. The popup is where an Admin decides who looks after which
   inventory and who may use Equipment and the kiosk, so what is worth pinning
   is what would quietly mislead them if it drifted:

     · it lives on the Equipment page, beside Kiosk mode, and only for an Admin
     · what it draws is the server's picture — a new inventory appears by itself
     · an inventory with nobody responsible says so
     · "custodian" means the duty AND the inventory, and a user is shown as one
     · matrix ticks are a draft; Save is ONE request carrying only the changes
     · a refusal is reported as one, and the draft survives it
     · the old screens point here instead of editing the same thing twice

   The endpoints' own rules are proven against a real database in
   server/mediaops-equipment-permissions.integration.test.ts.
   ═══════════════════════════════════════════════════════════════════════════ */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const HTML = readFileSync("public/media-ops/index.html", "utf8");

const person = (id: string, full_name: string, o: Record<string, unknown> = {}) => ({
  id, full_name, email: `${id}@x.invalid`, role: "user", mo_role: "employee", tier: "employee",
  status: "active", is_admin: false, modules_role_based: false,
  equipment: true, kiosk: false, custodian: false, inventory_ids: [] as number[], ...o,
});

const MODEL = (o: Record<string, unknown> = {}) => ({
  duty: { id: 1, code: "equipment_custodian", name: "Equipment Custodian", description: "Handles the cupboard." },
  inventories: [
    { id: 1, code: "media_crew", name: "Media Crew", code_prefix: "MC", lends_to_students: false,
      state: "active", assets: 12, codes_issued: true,
      holders: [{ user_id: "mo-u77", full_name: "Zed Access", status: "active", custodian: true,
                  granted_at: "2026-09-01T00:00:00Z", granted_by_name: "Rahul" }] },
    { id: 2, code: "pid", name: "PID", code_prefix: "PID", lends_to_students: true,
      state: "active", assets: 4, codes_issued: false, holders: [] },
  ],
  people: [
    person("mo-u78", "Access Tester", { role: "admin", tier: "admin", is_admin: true, kiosk: true }),
    person("mo-u77", "Zed Access", { custodian: true, inventory_ids: [1] }),
    person("mo-u79", "Yara Plain", { kiosk: true }),
    person("mo-u80", "Xen Off", { equipment: false }),
  ],
  history: [],
  ...o,
});

type Call = { url: string; method: string; body: Record<string, unknown> | null };
type Reply = { status: number; body: unknown };

async function boot(o: { model?: ReturnType<typeof MODEL>; patch?: (b: unknown) => Reply;
                         hash?: string; me?: number; live?: boolean } = {}) {
  const calls: Call[] = [];
  const dom = new JSDOM(HTML, { url: `http://localhost/api/media-ops/${o.hash ?? "#/media/equipment"}`,
    runScripts: "dangerously", pretendToBeVisual: true });
  const w = dom.window as unknown as { fetch: unknown; eval: (s: string) => unknown; confirm: unknown };
  w.confirm = () => true;
  w.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input), method = String(init?.method ?? "GET");
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, method, body });
    const reply = (s: number, b: unknown) => ({ ok: s < 400, status: s, json: async () => b }) as Response;
    if (url.includes("/equipment/permissions")) {
      if (method === "PATCH") {
        const r = o.patch ? o.patch(body) : { status: 200, body: { applied: 1, ...(o.model ?? MODEL()) } };
        return reply(r.status, r.body);
      }
      return reply(200, o.model ?? MODEL());
    }
    return reply(200, {});
  };
  await new Promise((r) => setTimeout(r, 300));
  const ev = <T,>(e: string) => w.eval(e) as T;
  ev(`for(const [id,n,r] of [[77,'Zed Access','user'],[78,'Access Tester','admin'],[79,'Yara Plain','user'],[80,'Xen Off','user']])
        DB.users.unshift({id,real_id:'mo-u'+id,role:r,full_name:n,initials:'ZZ',color:'#888',is_active:true,designation:''});
      S.me=${o.me ?? 78}; window.__MO_LIVE__=${o.live ?? true};`);
  const doc = dom.window.document;
  const settle = (ms = 80) => new Promise((r) => setTimeout(r, ms));
  const q = (sel: string) => doc.querySelector(`#modal-layer ${sel}`) as HTMLElement | null;
  return { dom, ev, calls, doc, settle, q,
    layer: () => doc.getElementById("modal-layer")?.innerHTML ?? "",
    body: () => doc.getElementById("ep-body")?.innerHTML ?? "",
    foot: () => doc.getElementById("ep-foot")?.innerHTML ?? "",
    open: async (d = "{}") => { ev(`ACTIONS.eqPerms(${d})`); await settle(120); },
    click: async (sel: string) => { q(sel)?.click(); await settle(); },
    pick: async (sel: string, value: string) => {
      const n = q(sel) as HTMLSelectElement; n.value = value;
      n.dispatchEvent(new dom.window.Event("change", { bubbles: true })); await settle();
    },
    tick: async (sel: string) => {
      const n = q(sel) as HTMLInputElement; n.checked = !n.checked;
      n.dispatchEvent(new dom.window.Event("change", { bubbles: true })); await settle();
    },
    patches: () => calls.filter((c) => c.method === "PATCH" || c.method === "POST"),
  };
}

describe("where it lives", () => {
  it("is a Permissions button on the Equipment page, beside Kiosk mode, for an Admin only", async () => {
    const h = await boot();
    const page = h.ev<string>("viewEquipment()");
    expect(page).toContain('data-act="eqPerms"');
    expect(page.indexOf('data-act="openKiosk"')).toBeLessThan(page.indexOf('data-act="eqPerms"'));
    h.ev("S.me=79");
    expect(h.ev<string>("viewEquipment()"), "an employee was offered the Admin's popup").not.toContain('data-act="eqPerms"');
  });

  it("hides Kiosk mode from someone whose Kiosk access was withdrawn", async () => {
    const h = await boot();
    h.ev(`user(79).allowed_modules=['home','equipment']; S.me=79;`);
    expect(h.ev<string>("viewEquipment()")).not.toContain('data-act="openKiosk"');
  });

  it("refuses to open for somebody who is not an Admin, and asks the server nothing", async () => {
    const h = await boot({ me: 79 });
    await h.open();
    expect(h.body()).toBe("");
    expect(h.calls.filter((c) => c.url.includes("/equipment/permissions"))).toEqual([]);
  });
});

describe("Inventories", () => {
  it("draws the inventories the SERVER returned, and nothing hard-coded", async () => {
    const h = await boot({ model: MODEL({ inventories: [
      { id: 9, code: "frames24", name: "24 Frames", code_prefix: "TF", lends_to_students: false,
        state: "active", assets: 0, codes_issued: false, holders: [] }] }) });
    await h.open();
    expect(h.calls.some((c) => c.method === "GET" && c.url.endsWith("/equipment/permissions"))).toBe(true);
    expect(h.body()).toContain("24 Frames");
    expect(h.body(), "an inventory the server did not send was drawn").not.toContain("Media Crew");
  });

  it("names the custodian, and says so plainly when an inventory has nobody responsible", async () => {
    const h = await boot();
    await h.open();
    const mc = h.q('section[aria-label="Media Crew"]')!.innerHTML;
    expect(mc).toContain("Zed Access");
    expect(mc).toContain(">Custodian<");
    const pid = h.q('section[aria-label="PID"]')!.innerHTML;
    expect(pid).toMatch(/No custodian/);
    expect(pid).toContain("Lends to students");
  });

  it("shows a holder without the duty as a user, not a custodian", async () => {
    const m = MODEL();
    m.inventories[1].holders = [{ user_id: "mo-u79", full_name: "Yara Plain", status: "active", custodian: false,
                                  granted_at: null as never, granted_by_name: null as never }];
    const h = await boot({ model: m });
    await h.open();
    const pid = h.q('section[aria-label="PID"]')!.innerHTML;
    expect(pid).toContain(">User<");
    expect(pid).toContain("Make custodian");
  });

  it("does not offer an Admin, or somebody who already holds it, in the Add picker", async () => {
    const h = await boot();
    await h.open();
    const opts = [...h.doc.querySelectorAll('#modal-layer [data-ep="add-uid"][data-sid="1"] option')]
      .map((o) => (o as HTMLOptionElement).value);
    expect(opts).toContain("mo-u79");
    expect(opts).not.toContain("mo-u78");
    expect(opts).not.toContain("mo-u77");
  });

  it("appoints a custodian in one request: Equipment, the inventory and the duty together", async () => {
    const h = await boot();
    await h.open();
    await h.pick('[data-ep="add-uid"][data-sid="2"]', "mo-u79");
    await h.click('[data-ep="add-go"][data-sid="2"]');
    const p = h.patches();
    expect(p.length).toBe(1);
    expect(p[0].url).toContain("/equipment/permissions");
    expect(p[0].body).toEqual({ changes: [{ user_id: "mo-u79", module_enabled: true,
                                            grant_inventory_ids: [2], equipment_custodian: true }] });
  });

  it("adds a user without the duty when asked to", async () => {
    const h = await boot();
    await h.open();
    await h.pick('[data-ep="add-uid"][data-sid="2"]', "mo-u79");
    await h.pick('[data-ep="add-role"][data-sid="2"]', "user");
    await h.click('[data-ep="add-go"][data-sid="2"]');
    expect(h.patches()[0].body).toEqual({ changes: [{ user_id: "mo-u79", module_enabled: true,
                                                      grant_inventory_ids: [2] }] });
  });

  it("asks before removing, and offers to drop the duty with someone's last inventory", async () => {
    const h = await boot();
    await h.open();
    await h.click('[data-ep="remove"][data-uid="mo-u77"][data-sid="1"]');
    expect(h.patches(), "removed before the Admin confirmed").toEqual([]);
    expect(h.body()).toMatch(/Remove Zed Access from Media Crew\?/);
    expect(h.body()).toMatch(/only custodian/);
    expect((h.q('[data-ep="confirm-duty"]') as HTMLInputElement).checked).toBe(true);
    await h.click('[data-ep="remove-go"]');
    expect(h.patches()[0].body).toEqual({ changes: [{ user_id: "mo-u77", revoke_inventory_ids: [1],
                                                      equipment_custodian: false }] });
  });

  it("offers nothing to press on an archived inventory but Restore", async () => {
    /* It authorises nobody and the server changes nothing on it, so a Remove
       button there would report a success that did not happen. */
    const m = MODEL();
    m.inventories.push({ id: 3, code: "old_store", name: "Old Store", code_prefix: "OS", lends_to_students: false,
      state: "archived", assets: 2, codes_issued: true,
      holders: [{ user_id: "mo-u79", full_name: "Yara Plain", status: "active", custodian: false,
                  granted_at: null as never, granted_by_name: null as never }] });
    const h = await boot({ model: m });
    await h.open();
    expect(h.body(), "an archived inventory was listed among the live ones").not.toContain("Old Store");
    await h.click('[data-ep="gone"]');
    expect(h.q('[data-ep="inv-restore"][data-sid="3"]')).not.toBeNull();
    expect(h.q('[data-ep="remove"][data-sid="3"]')).toBeNull();
    expect(h.q('[data-ep="add-uid"][data-sid="3"]')).toBeNull();
  });

  it("creates an inventory through its own endpoint", async () => {
    const h = await boot();
    await h.open();
    await h.click('[data-ep="inv-new"]');
    const name = h.q("#ep-f-name") as HTMLInputElement;
    name.value = "24 Frames"; name.dispatchEvent(new h.dom.window.Event("input", { bubbles: true }));
    const pre = h.q("#ep-f-prefix") as HTMLInputElement;
    pre.value = "tf"; pre.dispatchEvent(new h.dom.window.Event("input", { bubbles: true }));
    await h.click('[data-ep="form-save"]');
    const post = h.calls.find((c) => c.method === "POST" && c.url.endsWith("/equipment/inventories"));
    expect(post?.body).toEqual({ name: "24 Frames", code_prefix: "TF", lends_to_students: false });
  });

  it("will not offer to change a prefix once codes have been issued under it", async () => {
    const h = await boot();
    await h.open();
    await h.click('[data-ep="inv-edit"][data-sid="1"]');
    expect((h.q("#ep-f-prefix") as HTMLInputElement).disabled).toBe(true);
    expect(h.body()).toMatch(/can no longer change/);
  });
});

describe("People — the matrix", () => {
  const people = async (o: Parameters<typeof boot>[0] = {}) => {
    const h = await boot(o);
    await h.open();
    await h.click('[data-ep="tab"][data-k="people"]');
    return h;
  };
  const cell = (uid: string, f: string, sid?: number) =>
    `[data-ep="cell"][data-uid="${uid}"][data-f="${f}"]${sid != null ? `[data-sid="${sid}"]` : ""}`;

  it("ticks exactly what the server reported", async () => {
    const h = await people();
    const on = (sel: string) => (h.q(sel) as HTMLInputElement).checked;
    expect(on(cell("mo-u77", "inv", 1))).toBe(true);
    expect(on(cell("mo-u77", "inv", 2))).toBe(false);
    expect(on(cell("mo-u77", "custodian"))).toBe(true);
    expect(on(cell("mo-u79", "kiosk"))).toBe(true);
    expect(h.body()).toContain("Manages Media Crew");
  });

  it("shows an Admin's row without controls — they reach everything by role", async () => {
    const h = await people();
    expect(h.q(cell("mo-u78", "equipment"))).toBeNull();
    expect(h.body()).toMatch(/every module and every inventory by role/);
  });

  it("will not take an inventory or the duty for somebody without Equipment", async () => {
    const h = await people();
    expect((h.q(cell("mo-u80", "inv", 2)) as HTMLInputElement).disabled).toBe(true);
    expect((h.q(cell("mo-u80", "custodian")) as HTMLInputElement).disabled).toBe(true);
    expect(h.body()).toContain("No equipment access");
  });

  it("keeps ticks as a draft and sends nothing until Save", async () => {
    const h = await people();
    await h.tick(cell("mo-u79", "inv", 2));
    await h.tick(cell("mo-u79", "custodian"));
    expect(h.patches()).toEqual([]);
    expect(h.body()).toContain("Manages PID");
    expect(h.foot()).toMatch(/1 person changed/);
  });

  it("saves every changed row in ONE request, carrying only the changes", async () => {
    const h = await people();
    await h.tick(cell("mo-u79", "inv", 2));
    await h.tick(cell("mo-u79", "custodian"));
    await h.tick(cell("mo-u77", "inv", 1));       // − Media Crew
    await h.click('[data-ep="save"]');
    const p = h.patches();
    expect(p.length).toBe(1);
    expect(p[0].body).toEqual({ changes: [
      { user_id: "mo-u79", grant_inventory_ids: [2], equipment_custodian: true },
      { user_id: "mo-u77", revoke_inventory_ids: [1] },
    ] });
  });

  it("takes Kiosk away with Equipment, since the kiosk is reached through it", async () => {
    const h = await people();
    await h.tick(cell("mo-u79", "equipment"));
    await h.click('[data-ep="save"]');
    expect(h.patches()[0].body).toEqual({ changes: [
      { user_id: "mo-u79", module_enabled: false, kiosk_enabled: false }] });
  });

  it("an unticked-then-reticked box is not a change", async () => {
    const h = await people();
    await h.tick(cell("mo-u79", "inv", 2));
    await h.tick(cell("mo-u79", "inv", 2));
    expect(h.foot()).not.toMatch(/changed/);
  });

  it("redraws from the server's reply, not from what was clicked", async () => {
    const after = MODEL();
    after.people[2] = person("mo-u79", "Yara Plain", { kiosk: true, inventory_ids: [1] });
    const h = await people({ patch: () => ({ status: 200, body: { applied: 1, ...after } }) });
    await h.tick(cell("mo-u79", "inv", 2));
    await h.click('[data-ep="save"]');
    await h.settle(120);
    expect((h.q(cell("mo-u79", "inv", 2)) as HTMLInputElement).checked, "kept the draft").toBe(false);
    expect((h.q(cell("mo-u79", "inv", 1)) as HTMLInputElement).checked).toBe(true);
  });

  it("reports a refusal as one, names it, and keeps the draft for fixing", async () => {
    const h = await people({ patch: () => ({ status: 409,
      body: { message: "Xen Off: That account is not active, so access cannot be granted to it." } }) });
    await h.tick(cell("mo-u79", "inv", 2));
    await h.click('[data-ep="save"]');
    await h.settle(120);
    expect(h.foot()).toMatch(/Not saved/);
    expect(h.foot()).toContain("Xen Off: That account is not active");
    expect(h.foot()).toMatch(/1 person changed/);
  });

  it("refuses to save at all when the page cannot reach the server", async () => {
    const h = await people({ live: false });
    await h.tick(cell("mo-u79", "inv", 2));
    await h.click('[data-ep="save"]');
    expect(h.patches(), "a write was attempted with no server").toEqual([]);
  });

  it("filters by name without losing the draft", async () => {
    const h = await people();
    await h.tick(cell("mo-u79", "inv", 2));
    const s = h.q('[data-ep="search"]') as HTMLInputElement;
    s.value = "zed"; s.dispatchEvent(new h.dom.window.Event("input", { bubbles: true }));
    await h.settle();
    expect(h.q(cell("mo-u79", "inv", 2))).toBeNull();
    expect(h.q(cell("mo-u77", "inv", 1))).not.toBeNull();
    expect(h.foot()).toMatch(/1 person changed/);
  });

  it("opens on a person's row when reached from Users & Roles", async () => {
    const h = await boot();
    await h.open("{uid:'79'}");
    expect(h.body()).toContain('aria-selected="true" class="on" data-ep="tab" data-k="people"');
    expect(h.q(cell("mo-u79", "equipment"))).not.toBeNull();
    expect(h.q(cell("mo-u77", "equipment")), "the list was not filtered to the person").toBeNull();
  });
});

describe("the old screens point here", () => {
  it("Users & Roles opens this popup for a person, not a separate panel", () => {
    expect(HTML).toContain('data-act="eqPerms" data-uid="${u.id}"');
    expect(HTML).not.toContain('data-act="equipAccess"');
  });

  it("Settings → Lookups no longer edits Inventory Scopes, and says where they went", async () => {
    const h = await boot({ hash: "#/media/admin/lookups" });
    h.ev(`S._crudMeta=null`);
    h.ev(`MO_API.get=async()=>({can:{},icons:[],modules:[{key:'project_types',label:'Project Types'},
            {key:'inventory_scopes',label:'Inventory Scopes'}]})`);
    await h.ev<Promise<void>>("loadCrudMeta()");
    expect(h.ev<string[]>("S._crudMeta.modules.map(m=>m.key)")).toEqual(["project_types"]);
    expect(h.ev<string>("admInventoriesMoved()")).toMatch(/Inventories have moved/);
  });

  it("the Team page shows custodians but grants the duty only through Permissions", async () => {
    const h = await boot({ hash: "#/media/team" });
    h.ev(`S.tab.team='structure'`);
    const html = h.ev<string>("viewTeam()");
    const fid = h.ev<number>(`DB.duty_flags.find(f=>f.code==='equipment_custodian').id`);
    expect(html).not.toContain(`fid:${fid}})`);
    expect(html).toContain('data-act="eqPerms"');
  });
});

describe("legacy assets are not given an owner they do not have", () => {
  it("the catalog renderer still reads no scope", async () => {
    /* Phase 13B keeps scope_id out of the equipment read models on purpose.
       This test is here so that adding it — which is what a "Legacy" badge
       would require — is a deliberate decision rather than a side effect. */
    const h = await boot();
    expect(h.ev<boolean>(`/scope_id/.test(String(typeof eqCatalog==='function'?eqCatalog:''))`)).toBe(false);
  });

  it("no custodian or scope collection was added to the boot payload", async () => {
    const h = await boot();
    for (const k of ["inventory_scopes", "user_inventory_scopes", "custodians"])
      expect(h.ev<boolean>(`Object.prototype.hasOwnProperty.call(DB,'${k}')`), k).toBe(false);
  });
});
