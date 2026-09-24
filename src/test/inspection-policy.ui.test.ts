/* ═══════════════════════════════════════════════════════════════════════════
   UI — Inspection policy administration (Phase 17O).

   Two things are worth pinning here.

   THE SCOPE IS STATED, NOT IMPLIED. This phase is category-only, so the form
   has no inventory selector — and, more importantly, it says in words that a
   policy applies to every asset in the category in every inventory. A blank
   scope field that silently meant "everywhere" is how somebody comes to
   believe they have configured one department.

   A MISSING POLICY IS SHOWN AS MISSING. The empty state does not say "all
   good"; it says what the absence means for the assurance page, because a
   configuration screen that congratulates you for having configured nothing
   is the most expensive kind of reassuring.
   ═══════════════════════════════════════════════════════════════════════════ */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const HTML = readFileSync("public/media-ops/index.html", "utf8");

const POLICY = (o: Record<string, unknown> = {}) => ({
  id: 3, category_id: 1, category_name: "Camera Body", interval_days: 30,
  is_active: true, in_effect: true, note: "", effective_from: "2026-01-01",
  effective_to: null, assets_in_category: 7,
  created_by_name: "Rahul", updated_by_name: "Rahul",
  created_at: "2026-09-01T00:00:00.000Z", updated_at: "2026-09-01T00:00:00.000Z", ...o,
});

async function open(o: { items?: unknown[]; admin?: boolean } = {}) {
  const { admin = true } = o;
  const calls: { url: string; method: string; body: unknown }[] = [];
  const dom = new JSDOM(HTML, { url: "http://localhost/api/media-ops/#/media/admin/inspection",
    runScripts: "dangerously", pretendToBeVisual: true });
  const w = dom.window as unknown as { fetch: unknown; eval: (s: string) => unknown };
  w.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: String(init?.method ?? "GET"),
                 body: init?.body ? JSON.parse(String(init.body)) : null });
    const reply = (s: number, b: unknown) => ({ ok: s < 400, status: s, json: async () => b }) as Response;
    if (url.includes("/api/v1/media/state")) return reply(200, {});
    if (url.includes("/equipment/inspection-policies"))
      return reply(200, { items: o.items ?? [POLICY()], total: 1, limit: 200, offset: 0,
                          max_interval_days: 3650 });
    return reply(200, {});
  };
  await new Promise((r) => setTimeout(r, 300));
  const ev = <T,>(e: string) => w.eval(e) as T;
  /* isAdmin() is role() is me().role is DB.users.find(u => u.id === S.me).
     me() is a const, so the role is set where the page actually reads it —
     which is also the only way that exercises the real lookup. */
  ev(`DB.users.unshift({id:'zip-actor',role:'${admin ? "admin" : "user"}',full_name:'Policy Tester',`
   + ` initials:'PT',color:'#888',is_active:true}); S.me='zip-actor';`);
  ev("ADM_IP.loaded=false; admIpLoad();");
  await new Promise((r) => setTimeout(r, 260));
  return { dom, ev, calls,
    panel: () => ev<string>("admInspectionPolicy()"),
    layer: () => dom.window.document.getElementById("modal-layer")?.innerHTML ?? "" };
}

describe("inspection policy administration", () => {
  it("shows the interval, the window and who last touched it", async () => {
    const p = (await open()).panel();
    expect(p).toContain("Camera Body");
    expect(p).toContain("30 days");
    expect(p).toContain("2026-01-01");
    expect(p).toMatch(/open-ended/i);
    expect(p).toMatch(/In effect today/i);
  });

  it("separates being switched on from being in effect today", async () => {
    /* A policy can be active and not yet apply. Collapsing the two would make
       a future policy look like it were already governing. */
    const p = (await open({ items: [POLICY({ effective_from: "2099-01-01", in_effect: false })] })).panel();
    expect(p).toMatch(/Active/);
    expect(p).not.toMatch(/In effect today/i);
  });

  it("says a policy covers every inventory, and offers no inventory selector", async () => {
    const h = await open();
    expect(h.panel()).toMatch(/every asset in that category, in every\s+inventory/i);
    h.ev("ACTIONS.admIpNew()");
    await new Promise((r) => setTimeout(r, 200));
    const form = h.layer();
    expect(form).toMatch(/every asset in this\s+category, in every inventory/i);
    expect(form, "an inventory selector implied a scope this phase does not have")
      .not.toMatch(/Media Crew|PID|inventory<\/label>/i);
    expect(form).toContain('id="ip-cat"');
    expect(form).toContain('id="ip-int"');
  });

  it("will not offer to move an existing policy to another category", async () => {
    const h = await open();
    h.ev("ACTIONS.admIpEdit({pid:'3'})");
    await new Promise((r) => setTimeout(r, 200));
    const form = h.layer();
    expect(form, "editing offered a category picker").not.toContain('id="ip-cat"');
    expect(form).toMatch(/cannot be moved to another category/i);
  });

  it("activates and deactivates through PATCH, not a verb of its own", async () => {
    const h = await open();
    h.ev("ACTIONS.admIpToggle({pid:'3',to:'0'})");
    await new Promise((r) => setTimeout(r, 220));
    const call = h.calls.find((c) => c.method === "PATCH");
    expect(call, "no PATCH was sent").toBeTruthy();
    expect(call!.url).toContain("/equipment/inspection-policies/3");
    expect(call!.body).toEqual({ is_active: false });
    expect(h.calls.some((c) => /\/(activate|deactivate)/.test(c.url))).toBe(false);
  });

  it("gives a non-admin the table and no way to change it", async () => {
    const p = (await open({ admin: false })).panel();
    expect(p).toContain("Camera Body");
    expect(p).toMatch(/Read only/i);
    expect(p).not.toMatch(/New policy/i);
    expect(p).not.toMatch(/data-act="admIpEdit"/);
    expect(p).not.toMatch(/data-act="admIpToggle"/);
  });

  it("says what having no policy means, rather than congratulating the admin", async () => {
    const p = (await open({ items: [] })).panel();
    /* The EMPTY STATE only. The header above it has to use the word
       "compliant" in order to say assets are never reported as compliant,
       which is the opposite of the thing being checked here. */
    const empty = p.slice(p.indexOf('class="empty"'));
    expect(empty).toMatch(/No inspection policy has been set/i);
    expect(empty, "the empty state did not say what the absence means")
      .toMatch(/no policy/i);
    for (const word of [/all good/i, /healthy/i, /up to date/i, /✓/])
      expect(empty, `an empty configuration was congratulated: ${word}`).not.toMatch(word);
  });
});
