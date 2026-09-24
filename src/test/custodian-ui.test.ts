/* ═══════════════════════════════════════════════════════════════════════════
   UI — Custodians of an inventory scope (Phase 15).

   The real public/media-ops/index.html, in jsdom, rendering the Custodians tab
   of the existing config View drawer. No new screen and no new route was
   added, so there is nothing else to navigate to.

   What these tests are actually for: the drawer is where an Admin appoints and
   removes the people accountable for physical equipment, so the things worth
   asserting are the ones that would quietly mislead — a table that looks empty
   when it means "nobody is responsible", a Remove button offered to someone
   the API would refuse, and a last-custodian removal that happens without
   saying what it costs.

   Client-side gating is presentation, never authorization: every endpoint
   behind these controls checks isMoAdmin itself, and
   mediaops-custodian.integration.test.ts proves it.
   ═══════════════════════════════════════════════════════════════════════════ */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const HTML = readFileSync("public/media-ops/index.html", "utf8");

type Ev = <T>(expr: string) => T;
interface H {
  dom: JSDOM; ev: Ev; calls: string[];
  modal: () => string;
  open: (o?: Partial<Payload>) => Promise<void>;
}
interface Payload {
  active: Record<string, unknown>[];
  history: Record<string, unknown>[];
  canWrite: boolean;
}

const person = (id: string, name: string, over: Record<string, unknown> = {}) => ({
  id: id + "-row", user_id: id, full_name: name, role: "custodian",
  granted_at: "2026-09-01T00:00:00Z", granted_by: "mo-admin",
  granted_by_name: "Nerve Admin", removed_at: null, removed_by: null,
  removed_by_name: null, user_status: "active", has_duty: true, ...over,
});

async function boot(): Promise<H> {
  const calls: string[] = [];
  const dom = new JSDOM(HTML, {
    url: "http://localhost/api/media-ops/#/media/settings",
    runScripts: "dangerously", pretendToBeVisual: true,
  });
  const w = dom.window as unknown as { fetch: unknown; eval: (s: string) => unknown };
  let payload: Payload = { active: [], history: [], canWrite: true };

  w.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${url}`);
    const reply = (status: number, body: unknown) =>
      ({ ok: status < 400, status, json: async () => body }) as Response;
    if (url.includes("/equipment/scopes/") && url.includes("/custodians")) {
      if ((init?.method ?? "GET") !== "GET") return reply(200, { no_custodian: payload.active.length <= 1 });
      return reply(200, {
        scope: { id: 5, name: "PID", code: "pid", is_active: true, archived_at: null },
        active: payload.active, history: payload.history,
        no_custodian: payload.active.length === 0, active_count: payload.active.length,
      });
    }
    throw new Error("offline");
  };
  await new Promise((r) => setTimeout(r, 260));
  const ev = <T,>(e: string) => w.eval(e) as T;

  /* The drawer renders from the module metadata the server sends, so the test
     supplies it exactly as GET /crud/meta would — including the per-module
     `can`, which is what decides whether the controls appear at all. */
  const open = async (o: Partial<Payload> = {}) => {
    payload = { active: [], history: [], canWrite: true, ...o };
    ev(`S.crud={mod:'inventory_scopes',q:'',status:'active',sort:'id',dir:'asc',page:1,sel:{}};
        S._crudMeta={can:{read:true,create:true,update:true,state:true,archive:true,delete:true,force:false},
          icons:[],modules:[{key:'inventory_scopes',label:'Inventory Scopes',cols:['name','code'],
            activeCol:'is_active',deps:[],manage:'admin',
            can:{create:${payload.canWrite},update:${payload.canWrite},state:${payload.canWrite}},
            fields:[{name:'name',label:'Name',type:'text',required:true},
                    {name:'code',label:'Code',type:'slug',required:true}]}]};
        S._crudView={row:{id:5,name:'PID',code:'pid',is_active:true,archived_at:null,
          created_by:'mo-admin',created_at:'2026-09-01',updated_at:'2026-09-01'},
          dependencies:[],audit:[]};
        S._crudCust=null;`);
    await ev<Promise<unknown>>(`loadScopeCustodians(5)`);
    ev(`crudViewModal('custodians')`);
  };

  return { dom, ev, calls, open,
    modal: () => dom.window.document.getElementById("modal-layer")?.innerHTML ?? "" };
}

describe("the Custodians tab exists where a scope already lives", () => {
  it("is offered for an inventory scope, beside the tabs that were already there", async () => {
    const h = await boot();
    await h.open({ active: [person("u1", "Rahul Joshi")] });
    const m = h.modal();
    expect(m).toContain("Custodians");
    // The drawer it was added to, unchanged.
    for (const t of ["General", "Configuration", "Dependencies", "Audit History"])
      expect(m, `lost the ${t} tab`).toContain(t);
  });

  it("is not offered for an ordinary config module", async () => {
    const h = await boot();
    await h.open({ active: [] });
    h.ev(`S._crudMeta.modules[0].key='campuses'; S.crud.mod='campuses';
          S._crudMeta.modules[0].label='Campuses'; crudViewModal('general');`);
    expect(h.modal()).not.toContain(">Custodians<");
  });

  it("loads custodians through a feature endpoint, not the boot payload", async () => {
    const h = await boot();
    h.calls.length = 0;
    await h.open({ active: [person("u1", "Rahul Joshi")] });
    expect(h.calls.filter((c) => c.includes("/custodians")).length).toBe(1);
    // One request for the whole tab: no query per custodian, none per row.
    expect(h.calls.filter((c) => c.includes("/state"))).toEqual([]);
  });
});

describe("what the tab says", () => {
  it("lists the live custodians with when they were appointed and by whom", async () => {
    const h = await boot();
    await h.open({ active: [person("u1", "Rahul Joshi"), person("u2", "Anjali Nair")] });
    const m = h.modal();
    expect(m).toContain("Rahul Joshi");
    expect(m).toContain("Anjali Nair");
    expect(m).toContain("Nerve Admin");
    expect(m).toMatch(/Assigned/);
  });

  it("says NO CUSTODIAN rather than showing an empty table", async () => {
    /* An empty table reads as "failed to load". A scope with nobody
       responsible is a real state that somebody has to act on. */
    const h = await boot();
    await h.open({ active: [] });
    const m = h.modal();
    expect(m).toContain("NO CUSTODIAN");
    expect(m).toMatch(/Nobody is currently responsible/i);
  });

  it("marks an assignee who lacks the equipment duty as a viewer only", async () => {
    /* The two halves of custodianship are separate, and this is where that
       becomes visible: assigned, but unable to act. */
    const h = await boot();
    await h.open({ active: [person("u1", "Rahul Joshi", { has_duty: false })] });
    expect(h.modal()).toContain("viewer only");
  });

  it("shows the duty as held when it is", async () => {
    const h = await boot();
    await h.open({ active: [person("u1", "Rahul Joshi", { has_duty: true })] });
    expect(h.modal()).toContain("held");
    expect(h.modal()).not.toContain("viewer only");
  });

  it("renders previous custodians with their removal date and who removed them", async () => {
    const h = await boot();
    await h.open({
      active: [person("u2", "Anjali Nair")],
      history: [person("u1", "Rahul Joshi", {
        removed_at: "2026-09-15T00:00:00Z", removed_by: "mo-admin2",
        removed_by_name: "Second Admin" })],
    });
    const m = h.modal();
    expect(m).toContain("Previous custodians");
    expect(m).toContain("Rahul Joshi");
    expect(m).toContain("Second Admin");
    expect(m).toMatch(/Removed/);
  });

  it("says so plainly when there is no history", async () => {
    const h = await boot();
    await h.open({ active: [person("u1", "Rahul Joshi")], history: [] });
    expect(h.modal()).toContain("No previous custodians recorded");
  });

  it("a revoked custodian appears only in the history, never as active", async () => {
    const h = await boot();
    await h.open({
      active: [],
      history: [person("u1", "Rahul Joshi", { removed_at: "2026-09-15T00:00:00Z" })],
    });
    const m = h.modal();
    expect(m).toContain("NO CUSTODIAN");
    expect(m).toContain("Previous custodians");
    expect(m).not.toContain("Remove</button>");
  });
});

describe("only an admin is offered the controls", () => {
  it("an admin gets the picker and a Remove action", async () => {
    const h = await boot();
    await h.open({ active: [person("u1", "Rahul Joshi")], canWrite: true });
    const m = h.modal();
    expect(m).toContain("Appoint a custodian");
    expect(m).toContain("data-cust-assign");
    expect(m).toContain("data-cust-remove");
  });

  it("a non-admin gets neither, because the server said they may not write", async () => {
    /* Gated on the per-module `can` the server computed for this caller, not
       on a role guess in the browser. */
    const h = await boot();
    await h.open({ active: [person("u1", "Rahul Joshi")], canWrite: false });
    const m = h.modal();
    expect(m).not.toContain("Appoint a custodian");
    expect(m).not.toContain("data-cust-assign");
    expect(m).not.toContain("data-cust-remove");
    // They can still see who is responsible.
    expect(m).toContain("Rahul Joshi");
  });

  it("does not offer an existing custodian in the picker again", async () => {
    const h = await boot();
    h.ev(`DB.users=[{real_id:'u1',full_name:'Rahul Joshi'},{real_id:'u9',full_name:'Yash Panchal'}]`);
    await h.open({ active: [person("u1", "Rahul Joshi")] });
    const m = h.modal();
    expect(m).toContain("Yash Panchal");
    expect(m).not.toMatch(/<option value="u1"/);
  });
});

describe("removing a custodian", () => {
  const armConfirm = (h: H, answer: boolean) =>
    h.ev(`window.__asked=[]; window.confirm=(m)=>{window.__asked.push(m);return ${answer};}`);

  it("warns what it costs when this is the last one, and proceeds on confirm", async () => {
    const h = await boot();
    await h.open({ active: [person("u1", "Rahul Joshi")] });
    armConfirm(h, true);
    h.calls.length = 0;
    h.dom.window.document.querySelector<HTMLElement>("[data-cust-remove]")!.click();
    await new Promise((r) => setTimeout(r, 120));

    const asked = h.ev<string[]>("window.__asked");
    expect(asked.length).toBe(1);
    expect(asked[0]).toMatch(/without an assigned custodian/i);
    expect(h.calls.some((c) => c.startsWith("DELETE") && c.includes("/custodians/u1"))).toBe(true);
  });

  it("does not warn about the last custodian when others remain", async () => {
    const h = await boot();
    await h.open({ active: [person("u1", "Rahul Joshi"), person("u2", "Anjali Nair")] });
    armConfirm(h, true);
    h.dom.window.document.querySelector<HTMLElement>("[data-cust-remove]")!.click();
    await new Promise((r) => setTimeout(r, 120));

    const asked = h.ev<string[]>("window.__asked");
    expect(asked[0]).not.toMatch(/without an assigned custodian/i);
    expect(asked[0]).toMatch(/Remove Rahul Joshi/);
  });

  it("cancelling sends nothing at all", async () => {
    const h = await boot();
    await h.open({ active: [person("u1", "Rahul Joshi")] });
    armConfirm(h, false);
    h.calls.length = 0;
    h.dom.window.document.querySelector<HTMLElement>("[data-cust-remove]")!.click();
    await new Promise((r) => setTimeout(r, 120));

    expect(h.ev<string[]>("window.__asked").length).toBe(1);
    expect(h.calls.filter((c) => c.startsWith("DELETE")),
      "cancelling must leave the assignment exactly as it was").toEqual([]);
  });
});

describe("appointing a custodian", () => {
  it("sends the chosen person, once", async () => {
    const h = await boot();
    h.ev(`DB.users=[{real_id:'u9',full_name:'Yash Panchal'}]`);
    await h.open({ active: [] });
    h.calls.length = 0;
    h.ev(`document.querySelector('#cust-pick').value='u9'`);
    h.dom.window.document.querySelector<HTMLElement>("[data-cust-assign]")!.click();
    await new Promise((r) => setTimeout(r, 120));

    const posts = h.calls.filter((c) => c.startsWith("POST") && c.includes("/custodians"));
    expect(posts.length).toBe(1);
  });

  it("sends nothing when nobody was chosen", async () => {
    const h = await boot();
    await h.open({ active: [] });
    h.calls.length = 0;
    h.dom.window.document.querySelector<HTMLElement>("[data-cust-assign]")!.click();
    await new Promise((r) => setTimeout(r, 120));
    expect(h.calls.filter((c) => c.startsWith("POST"))).toEqual([]);
  });
});

describe("legacy assets are not given an owner they do not have", () => {
  it("the asset registry still receives no scope, so the UI cannot imply one", async () => {
    /* Phase 13B keeps scope_id out of the equipment read models on purpose.
       This test is here so that adding it — which is what a "Legacy" badge
       would require — is a deliberate decision rather than a side effect. */
    const h = await boot();
    const leaks = h.ev<boolean>(
      `/scope_id/.test(String(typeof eqCatalog==='function'?eqCatalog:''))`);
    expect(leaks, "the catalog renderer reads scope_id").toBe(false);
  });

  it("no custodian or scope collection was added to the boot payload", async () => {
    const h = await boot();
    for (const k of ["inventory_scopes", "user_inventory_scopes", "custodians"])
      expect(h.ev<boolean>(`Object.prototype.hasOwnProperty.call(DB,'${k}')`), k).toBe(false);
  });
});
