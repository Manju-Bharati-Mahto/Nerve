/* ═══════════════════════════════════════════════════════════════════════════
   UI — Physical assurance (Phase 17N).

   THE PAGE DOES NO ARITHMETIC. Coverage arrives as a number and is printed. A
   percentage recomputed in the browser is a second opinion waiting to disagree
   with the one the database gave, and the first time they differ nobody will
   know which is wrong.

   NOTHING IS CALLED LATE. No stocktake interval has been agreed, so an asset
   last seen 143 days ago says 143 days and stops there. A red pill would be
   this screen inventing a policy, and whoever saw the red would reasonably
   assume somebody had set one.

   ABSENCE READS AS ABSENCE. "Never inspected" is a word, not an empty cell and
   not a dash — a dash could mean "no data", "not applicable", or "zero days".
   ═══════════════════════════════════════════════════════════════════════════ */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const HTML = readFileSync("public/media-ops/index.html", "utf8");

const SEEN = (o: Record<string, unknown> = {}) => ({
  id: 41, asset_tag: "EQ-CAM-004", internal_code: "MC-0031", make: "SONY", model: "FX3",
  lifecycle: "available", verification_state: "active", condition: "good",
  category_name: "Camera Body", inventory_name: "Media Crew", scope_id: 11,
  tracking_mode: "individual", last_inspection_id: 9,
  last_inspected_at: "2026-05-03T08:00:00.000Z", last_observed_condition: "fair",
  last_outcome: "passed", last_inspector_name: "Asha Rao", last_inspector_id: "u2",
  days_since_inspection: 143, ...o,
});
const NEVER = (o: Record<string, unknown> = {}) => SEEN({
  id: 42, asset_tag: "EQ-LEN-002", internal_code: null, model: "24-70mm",
  last_inspection_id: null, last_inspected_at: null, last_observed_condition: null,
  last_outcome: null, last_inspector_name: null, last_inspector_id: null,
  days_since_inspection: null, ...o,
});

async function open(o: { items?: unknown[]; total?: number;
                         summary?: Record<string, unknown> } = {}) {
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
    if (url.includes("/equipment/physical-assurance")) return reply(200, {
      scope: { level: "all", selected: "all" },
      summary: o.summary ?? { total: 7, inspected: 3, never_inspected: 4,
                              coverage_pct: 42.9, oldest_days: 143 },
      assets: { items: o.items ?? [SEEN(), NEVER()], total: o.total ?? 2, limit: 25, offset: 0 },
    });
    if (url.includes("/equipment/verification-worklist"))
      return reply(200, { items: [], total: 0, limit: 25, offset: 0,
                          scope: { level: "all", selected: "all" } });
    if (url.includes("/equipment?")) return reply(200, { items: [], total: 0, limit: 50, offset: 0 });
    throw new Error("offline");
  };
  await new Promise((r) => setTimeout(r, 300));
  const ev = <T,>(e: string) => w.eval(e) as T;
  ev("window.can = () => true; can = window.can;");
  ev("S.tab.equip='verify'; EQ_PHYS.view='assurance';"); ev("render()");
  await new Promise((r) => setTimeout(r, 260));
  ev("render()"); await new Promise((r) => setTimeout(r, 200));
  return { dom, ev, calls,
    page: () => dom.window.document.getElementById("page")?.innerHTML ?? "" };
}

describe("physical assurance", () => {
  it("prints the server's coverage rather than working it out again", async () => {
    const p = (await open()).page();
    expect(p).toContain("42.9%");
    /* 3 of 7 is 42.857…; a browser-side calculation would very likely show
       something else, and two different numbers for one fact is the bug. */
    expect(p).not.toContain("42.8");
    expect(p).not.toContain("43%");
  });

  it("shows the four figures the page is for", async () => {
    const p = (await open()).page();
    expect(p).toMatch(/Assets in view/i);
    expect(p).toMatch(/Inspected/);
    expect(p).toMatch(/Never inspected/i);
    expect(p).toMatch(/Inspection coverage/i);
  });

  it("says NEVER INSPECTED in words, not as an empty cell", async () => {
    const p = (await open()).page();
    expect(p).toMatch(/Never inspected/i);
    /* And the asset that HAS been seen shows its date, inspector and age. */
    expect(p).toContain("2026-05-03");
    expect(p).toContain("Asha Rao");
    expect(p).toContain("143d");
  });

  it("passes no verdict on an asset whose category has no policy", async () => {
    /* 17N asserted this of every asset, because no interval existed. 17O
       narrows it: a verdict needs a policy, and a category without one is
       reported as such rather than quietly as fine. The rows here carry no
       policy, so no row may carry a judgement. */
    const h = await open({ items: [SEEN({ inspection_state: "no_policy",
        policy_id: null, policy_interval_days: null, due_at: null, days_until_due: null }),
      NEVER({ inspection_state: "never_inspected" })] });
    const panel = h.ev<string>("eqAssurance()");
    const rows = panel.slice(panel.indexOf("<tbody>"), panel.indexOf("</tbody>"));
    expect(rows.length, "no rows were rendered, so this proved nothing").toBeGreaterThan(200);
    for (const word of [/overdue/i, /\blate\b/i, /compliance/i])
      expect(rows, `an ungoverned asset was judged: ${word}`).not.toMatch(word);
    expect(rows).toMatch(/No policy/i);
    expect(rows, "a missing interval was shown as a blank rather than as missing")
      .toMatch(/not set/i);
    /* And the caption says what a missing policy means, so the gap reads as a
       gap rather than as a pass. */
    expect(panel).toMatch(/no active policy/i);
    expect(panel).toMatch(/never as compliant/i);
  });

  it("shows the derived state, the interval and the due date when a policy applies", async () => {
    const h = await open({ items: [
      SEEN({ id: 51, asset_tag: "EQ-CAM-051", inspection_state: "overdue",
             policy_id: 3, policy_interval_days: 30, due_at: "2026-06-02", days_until_due: -113 }),
      SEEN({ id: 52, asset_tag: "EQ-CAM-052", inspection_state: "not_due",
             policy_id: 3, policy_interval_days: 30, due_at: "2026-12-01", days_until_due: 69 }),
      SEEN({ id: 53, asset_tag: "EQ-CAM-053", inspection_state: "due",
             policy_id: 3, policy_interval_days: 30, due_at: "2026-09-23", days_until_due: 0 })] });
    const rows = h.ev<string>("eqAssurance()");
    expect(rows).toContain("2026-06-02");
    expect(rows).toContain("30d");
    expect(rows).toMatch(/Overdue/);
    expect(rows).toMatch(/Not due/);
    expect(rows).toMatch(/Due today/);
    /* How far past, from the server's number — the page does no date maths. */
    expect(rows).toMatch(/113d over/);
  });

  it("carries the state filter and the due sorts to the server", async () => {
    const h = await open();
    h.ev("EQ_PA.f.inspection_status='overdue'; EQ_PA.f.sort='due_soon';"
       + " EQ_PA.loaded=false; eqPaLoad();");
    await new Promise((r) => setTimeout(r, 240));
    const asked = h.calls.filter((u) => u.includes("physical-assurance")).pop() ?? "";
    expect(asked).toContain("inspection_status=overdue");
    expect(asked).toContain("sort=due_soon");
  });

  it("opens the list filtered when a state card or a dashboard figure is clicked", async () => {
    const h = await open();
    h.ev("ACTIONS.eqPaState({v:'overdue'})");
    await new Promise((r) => setTimeout(r, 220));
    expect(h.ev<string>("EQ_PA.f.inspection_status")).toBe("overdue");
    h.ev("ACTIONS.eqDashState({v:'due'})");
    await new Promise((r) => setTimeout(r, 220));
    expect(h.ev<string>("EQ_PA.f.inspection_status")).toBe("due");
    expect(h.ev<string>("EQ_PHYS.view")).toBe("assurance");
  });

  it("sends filters and paging to the server", async () => {
    const h = await open();
    h.ev("EQ_PA.f.inspection='never'; EQ_PA.f.sort='never_first'; EQ_PA.offset=25;"
       + " EQ_PA.loaded=false; eqPaLoad();");
    await new Promise((r) => setTimeout(r, 240));
    const asked = h.calls.filter((u) => u.includes("physical-assurance")).pop() ?? "";
    expect(asked).toContain("inspection=never");
    expect(asked).toContain("sort=never_first");
    expect(asked).toContain("offset=25");
    /* A filter left at "all" is not sent at all, rather than sent as a word the
       server would have to know to ignore. */
    expect(asked).not.toContain("lifecycle=all");
  });

  it("drills every asset through to Asset 360 and builds no detail screen of its own", async () => {
    const p = (await open()).page();
    expect(p).toContain('href="#/media/equipment/EQ-CAM-004"');
    expect(p).toContain('href="#/media/equipment/EQ-LEN-002"');
  });

  it("reports an empty selection as empty, not as zero coverage", async () => {
    const p = (await open({ items: [], total: 0,
      summary: { total: 0, inspected: 0, never_inspected: 0, coverage_pct: null, oldest_days: null } })).page();
    expect(p).toMatch(/No assets match this filter/i);
    /* 0 of 0 is not 0% — the server sent null and the page shows a dash. */
    expect(p).not.toContain("0%");
  });

  it("keeps the two physical questions apart behind one tab", async () => {
    const h = await open();
    expect(h.page()).toMatch(/Verification worklist/i);
    expect(h.page()).toMatch(/Physical assurance/i);
    h.ev("ACTIONS.eqPhysView({v:'worklist'})");
    await new Promise((r) => setTimeout(r, 220));
    /* Switching back shows the 17M queue, not the assurance table. */
    expect(h.page()).not.toMatch(/Inspection coverage/i);
  });

  it("opens the assurance list already filtered when a dashboard figure is clicked", async () => {
    const h = await open();
    h.ev("ACTIONS.eqDashAssurance({v:'never'})");
    await new Promise((r) => setTimeout(r, 240));
    expect(h.ev<string>("EQ_PA.f.inspection")).toBe("never");
    expect(h.ev<string>("EQ_PHYS.view")).toBe("assurance");
    expect(h.ev<string>("S.tab.equip")).toBe("verify");
  });
});
