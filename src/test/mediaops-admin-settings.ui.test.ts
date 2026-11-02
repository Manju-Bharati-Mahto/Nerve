import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const HTML = readFileSync("public/media-ops/index.html", "utf8");

async function boot() {
  const writes: Array<{ url: string; body: Record<string, unknown> }> = [];
  const dom = new JSDOM(HTML, { url: "http://localhost/api/media-ops/#/media/admin/settings",
    runScripts: "dangerously", pretendToBeVisual: true });
  const window = dom.window as unknown as { fetch: unknown; eval: <T>(code: string) => T };
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method && init.method !== "GET")
      writes.push({ url: String(input), body: JSON.parse(String(init.body)) as Record<string, unknown> });
    return { ok: true, status: 200, json: async () => ({}) } as Response;
  };
  await new Promise((r) => setTimeout(r, 300));
  const ev = <T,>(code: string) => window.eval<T>(code);
  ev("DB.users.unshift({id:901,real_id:'admin-test',role:'admin',full_name:'Test Admin',is_active:true}); S.me=901; window.__MO_LIVE__=true");
  return { dom, doc: dom.window.document, ev, writes };
}

describe("Media Ops admin settings from the ZIP", () => {
  it("uses the saved working-day schedule in report and capacity calculations", async () => {
    const h = await boot();
    h.ev("DB.settings.working_days='Monday to Friday'");
    expect(h.ev<boolean>("D.isWorking('2026-10-24')")).toBe(false);
    expect(h.ev<boolean>("D.isWorking('2026-10-26')")).toBe(true);
    h.ev("DB.settings.working_days='Monday to Saturday'");
    expect(h.ev<boolean>("D.isWorking('2026-10-24')")).toBe(true);
    expect(h.ev<boolean>("D.isWorking('2026-10-25')")).toBe(false);
    h.ev("DB.settings.working_days='Monday to Sunday'");
    expect(h.ev<boolean>("D.isWorking('2026-10-25')")).toBe(true);
  });

  it("sends the setting keys and options the API accepts", async () => {
    const h = await boot();
    expect(h.ev<unknown>("({me:S.me,role:me().role,admin:isAdmin()})")).toEqual({me:901,role:"admin",admin:true});
    const settingsHtml = h.ev<string>("admSettings()");
    expect(settingsHtml).toContain("st-department_name");
    h.ev("render()");
    const input = (id: string) => h.doc.getElementById(id) as HTMLInputElement;
    input("st-department_name").value = "Media Studio";
    input("st-academic_year_id").value = "2";
    input("st-project_code_prefix").value = "NM";
    input("st-working_days").value = "Monday to Friday";
    input("st-random_sample_pct").value = "18";
    input("st-backfill_window").value = "Within 48 hours";
    input("st-task_progress_tracking").classList.remove("on");
    input("st-whatsapp_notifications").classList.add("on");
    h.ev("ACTIONS.saveSettings()");
    await new Promise((r) => setTimeout(r, 0));
    const write = h.writes.find((w) => w.url.endsWith("/settings"));
    expect(write?.body).toMatchObject({ department_name: "Media Studio", current_academic_year_id: 2,
      project_code_prefix: "NM", working_days: "Monday to Friday", random_sample_pct: 18,
      backfill_window: "Within 48 hours", task_progress_tracking: false, whatsapp_notifications: true });
    expect(write?.body).not.toHaveProperty("academic_year_id");
    expect(write?.body).not.toHaveProperty("progress_before_after_on_tasks");
    expect(write?.body).not.toHaveProperty("whatsapp_enabled");
  });

  it("sends board name, description and sync setting", async () => {
    const h = await boot();
    const id = h.ev<number>("DB.boards[0].id");
    h.ev(`ACTIONS.boardSettings({bid:${id}})`);
    (h.doc.getElementById("bs-name") as HTMLInputElement).value = "Production planning";
    (h.doc.getElementById("bs-desc") as HTMLInputElement).value = "Crew plan";
    h.doc.getElementById("bs-sync")!.classList.add("on");
    h.ev(`ACTIONS.saveBoardSettings({bid:${id}})`);
    await new Promise((r) => setTimeout(r, 0));
    expect(h.writes.find((w) => w.url.endsWith(`/boards/${id}`))?.body)
      .toEqual({ name: "Production planning", description: "Crew plan", sync_status: true });
  });

  it("sends edited automation config instead of only showing a success toast", async () => {
    const h = await boot();
    const id = h.ev<number>("DB.automation_rules.find(r=>r.rule_key==='AUTO-13').id");
    h.ev(`ACTIONS.editRuleConfig({rid:${id}})`);
    const rate = h.doc.querySelector('[data-cfg-key="random_sample_pct"]') as HTMLInputElement;
    expect(rate).toBeTruthy();
    rate.value = "23";
    h.ev(`ACTIONS.saveRuleConfig({rid:${id}})`);
    await new Promise((r) => setTimeout(r, 0));
    expect(h.writes.find((w) => w.url.endsWith(`/automation-rules/${id}`))?.body)
      .toMatchObject({ config: { random_sample_pct: 23 } });
  });
});
