/* ═══════════════════════════════════════════════════════════════════════════
   UI — inventory foundation (Phase 17A).

   The real page in jsdom with a scripted server. What matters here is not that
   a select element appears, but WHERE its options come from: the server says
   which inventories this caller may reach, and the browser draws exactly that.
   An inventory the caller has no authority over must be ABSENT, not greyed
   out, or the switcher becomes a directory of inventories that exist.

   Client-side filtering is presentation. The `inventory=` parameter narrows a
   query the server has already scoped; it can never widen it, and
   mediaops-inventory-foundation.integration.test.ts proves that end.
   ═══════════════════════════════════════════════════════════════════════════ */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const HTML = readFileSync("public/media-ops/index.html", "utf8");

type Inv = { id: number; code: string; name: string; code_prefix: string; assets: number };
interface Opts { inventories?: Inv[]; legacy?: number; level?: string; invStatus?: number }

/* The asset shape the server actually returns, including the nested `state`
   block Phase 5 derives. A flat stand-in crashes the renderer — which is the
   read model doing its job: a row without a state block must never be drawn
   as if it were available. */
function assets(n: number) {
  return Array.from({ length: n }, (_, i) => {
    const id = i + 1;
    return {
      id, asset_tag: `EQ-CAM-${String(id).padStart(3, "0")}`,
      internal_code: `MC-${String(id).padStart(4, "0")}`,
      make: "Sony", model: `A7 ${id}`, serial_no: `SN-${id}`,
      condition: "good", status: "available",
      category_id: 1, category_name: "Camera Body", tracking_mode: "individual",
      warranty_until: "2027-01-01", notes: null, pool_quantity: null,
      asset_uid: `AT-${id}`, qr_uid: `QR-${id}`,
      holder_id: null, holder_name: null, holder_due_at: null,
      state: {
        lifecycle: { status: "available", persisted: true, unserviceable: false },
        custody: { status: "not_held", holder_id: null, holder_name: null,
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

async function boot(o: Opts = {}) {
  const { inventories = [
    { id: 11, code: "media_crew", name: "Media Crew", code_prefix: "MC", assets: 7 },
    { id: 12, code: "pid", name: "PID", code_prefix: "PID", assets: 12 },
  ], legacy = 32, level = "all", invStatus = 200 } = o;
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
    /* A live session. hydrateFromServer() only overwrites arrays the payload
       actually carries, so an empty object is enough to set __MO_LIVE__ — and
       it proves the inventory data does NOT arrive this way. */
    if (url.includes("/api/v1/media/state")) return reply(200, {});
    if (url.includes("/equipment/inventories")) {
      if (invStatus !== 200) return reply(invStatus, { message: "unavailable" });
      return reply(200, { inventories, legacy: { code: "legacy", name: "Not Assigned", assets: legacy },
                          scope_level: level });
    }
    if (url.includes("/equipment?")) {
      const p = new URL("http://x" + url.slice(url.indexOf("/equipment")));
      const inv = p.searchParams.get("inventory") ?? "all";
      const n = inv === "all" ? 5 : inv === "pid" ? 2 : 3;
      return reply(200, { items: assets(n), total: n, limit: 50, offset: 0,
        summary: { total: n, available: n, checked_out: 0, booked: 0, maintenance: 0, book_value: 0, overdue: 0 } });
    }
    throw new Error("offline");
  };
  await new Promise((r) => setTimeout(r, 300));
  const ev = <T,>(e: string) => w.eval(e) as T;
  const page = () => dom.window.document.getElementById("page")?.innerHTML ?? "";
  const render = async () => { ev("render()"); await new Promise((r) => setTimeout(r, 160)); };
  /* Land on a freshly-loaded registry, the way the other equipment UI suites
     do: the page renders on demand, not on a timer. */
  ev("EQ_LIST.loaded = false; S.tab.equip='catalog';");
  await render();
  await render();          // second pass draws what the two loads resolved
  return { dom, ev, calls, page, render };
}

describe("the inventory switcher is drawn from the server's answer", () => {
  it("offers the inventories the server returned, and the legacy estate", async () => {
    const h = await boot();
    const html = h.page();
    expect(html).toContain("All inventories");
    expect(html).toContain("Media Crew");
    expect(html).toContain("PID");
    expect(html).toContain("Not Assigned");
  });

  it("loads them from a feature endpoint, once, never from /state", async () => {
    const h = await boot();
    await new Promise((r) => setTimeout(r, 250));
    expect(h.calls.filter((c) => c.includes("/equipment/inventories")).length).toBe(1);
    /* /state is answered so the session is live — and carries no inventory. */
    expect(h.ev<boolean>(`Object.prototype.hasOwnProperty.call(DB,'inventory_scopes')`)).toBe(false);
  });

  it("shows a scoped custodian only their own inventory", async () => {
    /* The server sent one. The browser draws one. It does not know PID exists
       and has no way to ask for it. */
    const h = await boot({ level: "scoped", legacy: 32,
      inventories: [{ id: 11, code: "media_crew", name: "Media Crew", code_prefix: "MC", assets: 7 }] });
    const html = h.page();
    expect(html).toContain("Media Crew");
    expect(html).not.toContain(">PID (");
  });

  it("still offers the legacy estate to a caller who holds no inventory", async () => {
    const h = await boot({ level: "none", inventories: [], legacy: 32 });
    expect(h.page()).toContain("Not Assigned");
  });

  it("draws no switcher at all when there is nothing to switch between", async () => {
    // A control with one option is furniture, not a choice.
    const h = await boot({ level: "none", inventories: [], legacy: 0 });
    expect(h.page()).not.toContain("All inventories");
  });

  it("draws no switcher when the endpoint fails, and the catalog still renders", async () => {
    const h = await boot({ invStatus: 500 });
    expect(h.page()).not.toContain("All inventories");
    expect(h.page()).toContain("EQ-CAM-001");     // the registry is unharmed
  });
});

describe("choosing an inventory asks the server again", () => {
  it("sends inventory= on the next request and returns to page 1", async () => {
    const h = await boot();
    await new Promise((r) => setTimeout(r, 250));
    h.calls.length = 0;
    h.ev(`EQ_LIST.offset=100; ACTIONS.eqFilter({k:'inventory'},{value:'pid'});`);
    await new Promise((r) => setTimeout(r, 250));

    const q = h.calls.filter((c) => c.includes("/equipment?"));
    expect(q.length).toBeGreaterThan(0);
    expect(q[q.length - 1]).toContain("inventory=pid");
    expect(q[q.length - 1]).toContain("offset=0");
  });

  it("asks for the legacy estate by its own key", async () => {
    const h = await boot();
    await new Promise((r) => setTimeout(r, 250));
    h.calls.length = 0;
    h.ev(`ACTIONS.eqFilter({k:'inventory'},{value:'legacy'});`);
    await new Promise((r) => setTimeout(r, 250));
    expect(h.calls.filter((c) => c.includes("/equipment?")).pop()).toContain("inventory=legacy");
  });

  it("defaults to every inventory the caller may see", async () => {
    const h = await boot();
    await new Promise((r) => setTimeout(r, 250));
    expect(h.calls.find((c) => c.includes("/equipment?"))).toContain("inventory=all");
  });
});

describe("the identity model reaches the browser intact", () => {
  it("searches by internal code through the server, not in the page", async () => {
    const h = await boot();
    await new Promise((r) => setTimeout(r, 250));
    h.calls.length = 0;
    h.ev(`ACTIONS.eqFilter({k:'q'},{value:'MC-0004'});`);
    await new Promise((r) => setTimeout(r, 250));
    const q = h.calls.filter((c) => c.includes("/equipment?")).pop() ?? "";
    expect(q).toContain("q=MC-0004");
  });

  it("says so in the search box", async () => {
    const h = await boot();
    expect(h.page()).toMatch(/Search code, tag, make, model or serial/);
  });

  it("never receives the authorization key", async () => {
    /* Phase 13B keeps scope_id out of the read models; the switcher works on
       the inventory CODE, which is not a permission. */
    const h = await boot();
    await new Promise((r) => setTimeout(r, 250));
    expect(h.ev<boolean>(`EQ_LIST.rows.some(r=>'scope_id' in r)`)).toBe(false);
    expect(h.ev<string>(`EQ_LIST.rows[0].internal_code`)).toBe("MC-0001");
  });

  it("adds no inventory collection to the boot payload", async () => {
    const h = await boot();
    /* DB.equipment_items DOES exist — it is the offline prototype seed Phase 9
       audited and Phase 8 left in place, and it is never populated from the
       server. What must not appear is an inventory collection. */
    for (const k of ["inventory_scopes", "user_inventory_scopes"])
      expect(h.ev<boolean>(`Object.prototype.hasOwnProperty.call(DB,'${k}')`), k).toBe(false);
    expect(h.ev<number>(`EQ_INV.rows.length`)).toBeGreaterThan(0);   // it lives in its own cache
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   PHASE 17C — the Assign Inventory control.

   Hiding a button is courtesy, not security: the endpoint refuses the same
   request whether or not the browser drew the control, and
   mediaops-inventory-foundation.integration.test.ts proves that end. What is
   worth asserting here is that the page never invents an identity — an
   ungoverned asset reads "Not Assigned" and "Pending", never MC-0000.
   ═══════════════════════════════════════════════════════════════════════════ */
describe("the Assign Inventory action", () => {
  /* The detail page, with one asset and a scripted server. */
  async function detail(o: { scoped?: boolean; canManage?: boolean } = {}) {
    const { scoped = false, canManage = true } = o;
    const calls: string[] = [];
    const posts: { url: string; body: unknown }[] = [];
    const dom = new JSDOM(HTML, { url: "http://localhost/api/media-ops/#/media/equipment",
      runScripts: "dangerously", pretendToBeVisual: true });
    const w = dom.window as unknown as { fetch: unknown; eval: (s: string) => unknown };
    /* Mutable, because the server is: once the asset is assigned, every later
       read returns the assigned row. A fixed fixture made the page appear to
       "lose" the new code on its refresh, which the server would never do. */
    let item = { ...assets(1)[0],
      internal_code: scoped ? "MC-0046" : null,
      inventory_name: scoped ? "Media Crew" : null,
      inventory_code: scoped ? "media_crew" : null,
      verification_state: "active" };
    w.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input); calls.push(`${init?.method ?? "GET"} ${url}`);
      const reply = (s: number, b: unknown) => ({ ok: s < 400, status: s, json: async () => b }) as Response;
      if (url.includes("/api/v1/media/state")) return reply(200, {});
      if (url.includes("/equipment/inventories")) return reply(200, {
        inventories: [{ id: 11, code: "media_crew", name: "Media Crew", code_prefix: "MC", assets: 7 },
                      { id: 12, code: "pid", name: "PID", code_prefix: "PID", assets: 12 }],
        legacy: { code: "legacy", name: "Not Assigned", assets: 32 }, scope_level: "all" });
      if (url.includes("/assign-inventory")) {
        posts.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
        item = { ...item, internal_code: "MC-0046",
                 inventory_name: "Media Crew", inventory_code: "media_crew" };
        return reply(200, { item });
      }
      /* The catalog links by ASSET TAG, so the detail route is
         /equipment/EQ-CAM-001 as often as /equipment/1. Matching only digits
         left the page on its empty state and every assertion below failed for
         the wrong reason. */
      if (/\/equipment\/[^/?]+$/.test(url) && !/\/(inventories|transactions|maintenance|availability|bookings|custody|analytics|rules|resolve)$/.test(url))
        return reply(200, { item, identifiers: [], transactions: [], bookings: [],
                            maintenance: [], holder: null, escalation: null });
      if (url.includes("/equipment?")) return reply(200, { items: [item], total: 1, limit: 50, offset: 0 });
      throw new Error("offline");
    };
    await new Promise((r) => setTimeout(r, 300));
    const ev = <T,>(e: string) => w.eval(e) as T;
    ev(`CAPS_OVERRIDE=${canManage}`);
    /* `can()` is the page's own capability check; the harness pins its answer
       rather than reconstructing a whole role fixture. */
    ev(`window.can = (k) => k === 'equipment.manage' ? ${canManage} : true;`);
    ev(`can = window.can;`);
    ev(`location.hash = '#/media/equipment/${item.asset_tag}';`);
    ev("render()"); await new Promise((r) => setTimeout(r, 220));
    ev("render()"); await new Promise((r) => setTimeout(r, 220));
    return { dom, ev, calls, posts,
      page: () => dom.window.document.getElementById("page")?.innerHTML ?? "",
      modal: () => dom.window.document.getElementById("modal-layer")?.innerHTML ?? "" };
  }

  it("shows an ungoverned asset as Not Assigned and Pending — never a fake code", async () => {
    const h = await detail({ scoped: false });
    const p = h.page();
    expect(p).toContain("Not Assigned");
    expect(p).toContain("Pending");
    expect(p).not.toMatch(/MC-0000|PID-0000|TEMP-/);
  });

  it("offers the action to somebody who may manage equipment", async () => {
    const h = await detail({ scoped: false, canManage: true });
    expect(h.page()).toContain("Assign Inventory");
  });

  it("does not offer it to somebody who may not", async () => {
    const h = await detail({ scoped: false, canManage: false });
    expect(h.page()).not.toContain("Assign Inventory");
  });

  it("does not offer it for an asset that already has an inventory", async () => {
    const h = await detail({ scoped: true });
    expect(h.page()).toContain("Media Crew");
    expect(h.page()).toContain("MC-0046");
    expect(h.page()).not.toContain("Assign Inventory");
  });

  it("warns that the code is permanent and that this is not approval", async () => {
    const h = await detail({ scoped: false });
    h.ev(`ACTIONS.assignInventory({eid:'1'})`);
    await new Promise((r) => setTimeout(r, 120));
    const m = h.modal();
    expect(m).toContain("permanent internal code");
    expect(m).toMatch(/not approval/i);
    expect(m).not.toMatch(/\bApprove\b/);
    expect(m).toContain("Assign &amp; Generate Code");
  });

  it("sends the chosen inventory once, and only after confirmation", async () => {
    const h = await detail({ scoped: false });
    h.ev(`window.confirm = () => true;`);
    h.ev(`ACTIONS.assignInventory({eid:'1'})`);
    await new Promise((r) => setTimeout(r, 120));
    h.ev(`document.querySelector('#assign-inv').value='12'`);
    h.dom.window.document.querySelector<HTMLElement>("#assign-go")!.click();
    await new Promise((r) => setTimeout(r, 200));
    expect(h.posts.length).toBe(1);
    expect((h.posts[0].body as { scope_id: number }).scope_id).toBe(12);
  });

  it("sends nothing when the confirmation is declined", async () => {
    const h = await detail({ scoped: false });
    h.ev(`window.confirm = () => false;`);
    h.ev(`ACTIONS.assignInventory({eid:'1'})`);
    await new Promise((r) => setTimeout(r, 120));
    h.dom.window.document.querySelector<HTMLElement>("#assign-go")!.click();
    await new Promise((r) => setTimeout(r, 200));
    expect(h.posts).toEqual([]);
  });

  it("takes the new identity from the SERVER's response, not from the form", async () => {
    const h = await detail({ scoped: false });
    h.ev(`window.confirm = () => true;`);
    h.ev(`ACTIONS.assignInventory({eid:'1'})`);
    await new Promise((r) => setTimeout(r, 120));
    h.dom.window.document.querySelector<HTMLElement>("#assign-go")!.click();
    await new Promise((r) => setTimeout(r, 250));
    /* The cache now holds what the server said, including a code the browser
       never chose. */
    expect(h.ev<string>(`(ASSETS.byId.get(1)||{}).internal_code`)).toBe("MC-0046");
    expect(h.ev<string>(`(ASSETS.byId.get(1)||{}).inventory_name`)).toBe("Media Crew");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   PHASE 17D — verification, as the page presents it.

   Two claims, and the second matters more than the first.

   A record under review must SAY so, say why when it was rejected, and offer
   only the moves that are legal from where it stands. And an asset that is
   already part of the inventory — which is every asset that existed before this
   phase — must read exactly as it did before: no verification row, no badge,
   nothing added to a working camera's page because a workflow was introduced
   around it.
   ═══════════════════════════════════════════════════════════════════════════ */
describe("verification on the asset page", () => {
  async function vdetail(state: string, o: { note?: string | null; canManage?: boolean } = {}) {
    const { note = null, canManage = true } = o;
    const posts: { url: string; body: Record<string, unknown> }[] = [];
    const dom = new JSDOM(HTML, { url: "http://localhost/api/media-ops/#/media/equipment",
      runScripts: "dangerously", pretendToBeVisual: true });
    const w = dom.window as unknown as { fetch: unknown; eval: (s: string) => unknown };
    /* state.verification is a PROJECTION of the column and the server always
       sends both (Phase 17E), so the fixture carries both or the page is being
       tested against a shape no server produces. */
    const vblock = (st: string, n: string | null) => ({
      state: st, note: n, persisted: true, in_inventory: st === "active" });
    let item = { ...assets(1)[0], internal_code: "MC-0046", inventory_name: "Media Crew",
                 inventory_code: "media_crew", verification_state: state, verification_note: note,
                 state: { ...assets(1)[0].state, verification: vblock(state, note) } };
    w.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const reply = (s: number, b: unknown) => ({ ok: s < 400, status: s, json: async () => b }) as Response;
      if (url.includes("/api/v1/media/state")) return reply(200, {});
      if (url.includes("/equipment/inventories")) return reply(200, {
        inventories: [{ id: 11, code: "media_crew", name: "Media Crew", code_prefix: "MC", assets: 7 }],
        legacy: { code: "legacy", name: "Not Assigned", assets: 32 }, scope_level: "all" });
      if (url.includes("/verification")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        posts.push({ url, body });
        /* The SERVER decides the resulting state — the browser is told. */
        const to: Record<string, string> = { submit: "pending_verification", approve: "active",
                                             reject: "rejected", return_to_draft: "draft" };
        const next = to[String(body.action)] ?? item.verification_state;
        const nextNote = body.action === "reject" ? String(body.reason) : null;
        item = { ...item, verification_state: next, verification_note: nextNote,
                 state: { ...item.state, verification: vblock(next, nextNote) } };
        return reply(200, { item });
      }
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
      ev(`S.tab.asset='${k}';`); ev("render()"); await new Promise((r) => setTimeout(r, 240));
      ev("render()"); await new Promise((r) => setTimeout(r, 200));
    };
    return { dom, ev, posts, tab,
      page: () => dom.window.document.getElementById("page")?.innerHTML ?? "",
      modal: () => dom.window.document.getElementById("modal-layer")?.innerHTML ?? "" };
  }

  it("RAISES NOTHING on an asset that is already inventory", async () => {
    /* The whole estate is 'active'. Introducing verification must not put a
       warning, a badge or a pending action on a camera that has been working
       for years. Phase 17E gives verification a state card and a tab of its
       own — so it is now NAMED on the page, which is the point of a registry —
       but an active record still reads as settled and offers nothing to do. */
    const h = await vdetail("active");
    const head = h.page();
    expect(head).not.toContain("st-warn");
    expect(head).not.toContain("Submit for Verification");
    expect(head).toContain("MC-0046");        // and the rest of the page is intact
    await h.tab("verification");
    const v = h.page();
    expect(v).toContain("Verified");
    expect(v).toMatch(/can be booked and issued/i);
    for (const a of ["Submit for Verification", "Approve", "Reject", "Return to Draft"])
      expect(v, a).not.toContain(a);
  });

  it("shows a draft as a draft, with the one move that is legal", async () => {
    const h = await vdetail("draft");
    expect(h.page(), "the header did not flag an unverified record").toContain("Draft");
    await h.tab("verification");
    const p = h.page();
    expect(p).toContain("Verification");
    expect(p).toContain("Draft");
    expect(p).toContain("Submit for Verification");
    expect(p).not.toContain("Approve");
    expect(p).toMatch(/cannot be booked or issued/i);
  });

  it("offers approve and reject on a record under review", async () => {
    const h = await vdetail("pending_verification");
    await h.tab("verification");
    const p = h.page();
    expect(p).toContain("Pending verification");
    expect(p).toContain("Approve");
    expect(p).toContain("Reject");
    expect(p).not.toContain("Submit for Verification");
  });

  it("prints the rejection reason in full, and the way back", async () => {
    const h = await vdetail("rejected", { note: "Serial does not match the physical asset." });
    await h.tab("verification");
    const p = h.page();
    expect(p).toContain("Rejected");
    expect(p).toContain("Serial does not match the physical asset.");
    expect(p).toContain("Return to Draft");
    expect(p).not.toContain("Approve");
  });

  it("tells a colleague who may not review what the state is, and offers nothing", async () => {
    const h = await vdetail("pending_verification", { canManage: false });
    await h.tab("verification");
    const p = h.page();
    expect(p).toContain("Pending verification");
    expect(p).not.toContain("Approve");
    expect(p).not.toContain("Reject");
  });

  it("sends the transition by name, after confirmation", async () => {
    const h = await vdetail("draft");
    h.ev(`window.confirm = () => true;`);
    h.ev(`ACTIONS.verifyAsset({eid:'1', vact:'submit'})`);
    await new Promise((r) => setTimeout(r, 250));
    expect(h.posts.length).toBe(1);
    expect(h.posts[0].body.action).toBe("submit");
    expect(h.posts[0].url).toContain("/equipment/1/verification");
  });

  it("sends nothing when the confirmation is declined", async () => {
    const h = await vdetail("pending_verification");
    h.ev(`window.confirm = () => false;`);
    h.ev(`ACTIONS.verifyAsset({eid:'1', vact:'approve'})`);
    await new Promise((r) => setTimeout(r, 250));
    expect(h.posts).toEqual([]);
  });

  it("REFUSES TO REJECT WITHOUT A REASON", async () => {
    const h = await vdetail("pending_verification");
    h.ev(`ACTIONS.verifyAsset({eid:'1', vact:'reject'})`);
    await new Promise((r) => setTimeout(r, 150));
    expect(h.modal()).toMatch(/Why is this record being rejected/i);
    h.dom.window.document.querySelector<HTMLElement>("#rej-go")!.click();
    await new Promise((r) => setTimeout(r, 200));
    expect(h.posts, "a rejection left the browser with no reason").toEqual([]);
    /* Whitespace is not a reason either. */
    h.dom.window.document.querySelector<HTMLTextAreaElement>("#rej-why")!.value = "   ";
    h.dom.window.document.querySelector<HTMLElement>("#rej-go")!.click();
    await new Promise((r) => setTimeout(r, 200));
    expect(h.posts).toEqual([]);
  });

  it("sends the reason it was given", async () => {
    const h = await vdetail("pending_verification");
    h.ev(`ACTIONS.verifyAsset({eid:'1', vact:'reject'})`);
    await new Promise((r) => setTimeout(r, 150));
    h.dom.window.document.querySelector<HTMLTextAreaElement>("#rej-why")!.value =
      "Two rows describe the same camera.";
    h.dom.window.document.querySelector<HTMLElement>("#rej-go")!.click();
    await new Promise((r) => setTimeout(r, 250));
    expect(h.posts.length).toBe(1);
    expect(h.posts[0].body).toEqual({ action: "reject", reason: "Two rows describe the same camera." });
  });

  it("takes the resulting state from the SERVER, not from the button", async () => {
    const h = await vdetail("pending_verification");
    h.ev(`window.confirm = () => true;`);
    h.ev(`ACTIONS.verifyAsset({eid:'1', vact:'approve'})`);
    await new Promise((r) => setTimeout(r, 300));
    expect(h.ev<string>(`(ASSETS.byId.get(1)||{}).verification_state`)).toBe("active");
  });
});

describe("the verification queue", () => {
  type Row = Record<string, unknown>;
  async function queue(o: { rows?: Row[]; total?: number; canManage?: boolean } = {}) {
    const { canManage = true } = o;
    const rows = o.rows ?? [{
      id: 41, asset_tag: "EQ-CAM-041", internal_code: "MC-0041", make: "Sony", model: "FX3",
      category_name: "Camera Body", inventory_name: "Media Crew", inventory_code: "media_crew",
      verification_state: "pending_verification", verification_note: null, pool_quantity: null,
      tracking_mode: "individual", created_on: "2026-09-20",
      submitted_by: "Rahul Joshi", submitted_on: "2026-09-21" }];
    const total = o.total ?? rows.length;
    const calls: string[] = [];
    const dom = new JSDOM(HTML, { url: "http://localhost/api/media-ops/#/media/equipment",
      runScripts: "dangerously", pretendToBeVisual: true });
    const w = dom.window as unknown as { fetch: unknown; eval: (s: string) => unknown };
    w.fetch = async (input: RequestInfo | URL) => {
      const url = String(input); calls.push(url);
      const reply = (s: number, b: unknown) => ({ ok: s < 400, status: s, json: async () => b }) as Response;
      if (url.includes("/api/v1/media/state")) return reply(200, {});
      if (url.includes("/equipment/verification-queue")) {
        const p = new URL("http://x" + url.slice(url.indexOf("/equipment")));
        const want = p.searchParams.get("state") ?? "pending_verification";
        const mine = rows.filter((r) => r.verification_state === want);
        return reply(200, { items: mine, total: mine.length ? total : 0, limit: 25, offset: 0 });
      }
      if (url.includes("/equipment/inventories")) return reply(200, {
        inventories: [{ id: 11, code: "media_crew", name: "Media Crew", code_prefix: "MC", assets: 7 }],
        legacy: { code: "legacy", name: "Not Assigned", assets: 32 }, scope_level: "all" });
      if (url.includes("/equipment?")) return reply(200, { items: [], total: 0, limit: 50, offset: 0,
        summary: { total: 0, available: 0, checked_out: 0, booked: 0, maintenance: 0, book_value: 0, overdue: 0 } });
      throw new Error("offline");
    };
    await new Promise((r) => setTimeout(r, 300));
    const ev = <T,>(e: string) => w.eval(e) as T;
    ev(`window.can = (k) => k === 'equipment.manage' ? ${canManage} : true; can = window.can;`);
    ev(`S.tab.equip='verification'; EQ_VQ.loaded=false;`);
    ev("render()"); await new Promise((r) => setTimeout(r, 220));
    ev("render()"); await new Promise((r) => setTimeout(r, 220));
    return { dom, ev, calls, page: () => dom.window.document.getElementById("page")?.innerHTML ?? "" };
  }

  it("lists what is waiting, with the inventory and who put it forward", async () => {
    const p = (await queue()).page();
    expect(p).toContain("EQ-CAM-041");
    expect(p).toContain("MC-0041");
    expect(p).toContain("Media Crew");
    expect(p).toContain("Rahul Joshi");
    expect(p).toContain("Approve");
    expect(p).toContain("Reject");
  });

  it("asks the server for one state at a time, pending first", async () => {
    const h = await queue();
    const first = h.calls.filter((c) => c.includes("verification-queue")).pop() ?? "";
    expect(first).toContain("state=pending_verification");
    expect(first).toContain("limit=25");
    h.calls.length = 0;
    h.ev(`ACTIONS.eqVqState({}, {value:'draft'})`);
    await new Promise((r) => setTimeout(r, 250));
    expect(h.calls.filter((c) => c.includes("verification-queue")).pop()).toContain("state=draft");
  });

  it("pages through the server, not through the browser", async () => {
    const many = Array.from({ length: 25 }, (_, i) => ({
      id: 100 + i, asset_tag: `EQ-CAM-${100 + i}`, internal_code: null, make: "Sony", model: "A7",
      category_name: "Camera Body", inventory_name: "Media Crew", inventory_code: "media_crew",
      verification_state: "pending_verification", verification_note: null, pool_quantity: null,
      tracking_mode: "individual", created_on: "2026-09-20", submitted_by: "Rahul Joshi",
      submitted_on: "2026-09-21" }));
    const h = await queue({ rows: many, total: 60 });
    expect(h.page()).toContain("Showing 1–25 of 60");
    h.calls.length = 0;
    h.ev(`ACTIONS.eqVqPage({d:'1'})`);
    await new Promise((r) => setTimeout(r, 250));
    expect(h.calls.filter((c) => c.includes("verification-queue")).pop()).toContain("offset=25");
  });

  it("shows a rejection's reason beside the row", async () => {
    const h = await queue({ rows: [{
      id: 42, asset_tag: "EQ-CAM-042", internal_code: "MC-0042", make: "Sony", model: "FX6",
      category_name: "Camera Body", inventory_name: "Media Crew", inventory_code: "media_crew",
      verification_state: "rejected", verification_note: "Duplicate of EQ-CAM-041.",
      pool_quantity: null, tracking_mode: "individual", created_on: "2026-09-20",
      submitted_by: "Rahul Joshi", submitted_on: "2026-09-21" }] });
    h.ev(`ACTIONS.eqVqState({}, {value:'rejected'})`);
    await new Promise((r) => setTimeout(r, 300));
    const p = h.page();
    expect(p).toContain("Duplicate of EQ-CAM-041.");
    expect(p).toContain("Return to Draft");
  });

  it("says plainly when there is nothing to review", async () => {
    const p = (await queue({ rows: [] })).page();
    expect(p).toMatch(/Nothing waiting for review/i);
    expect(p).toMatch(/catalogue is unaffected/i);
  });

  it("is not offered at all to somebody who may not review", async () => {
    const h = await queue({ canManage: false });
    expect(h.ev<string>(`viewEquipment()`)).not.toContain('data-tab="verification"');
    expect(h.calls.some((c) => c.includes("verification-queue")), "it asked anyway").toBe(false);
  });
});
