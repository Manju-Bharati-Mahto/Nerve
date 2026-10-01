/* ═══════════════════════════════════════════════════════════════════════════
   Approving work, and finding it.

   Approval is the moment the points are decided, and points are what a payout
   is computed from — so the dialog must show the number the SERVER resolved
   from the rule, never one the page made up, and must send exactly what the
   reviewer confirmed. These tests stub the API and watch the request body.

   The searches are separate from each other on purpose: tasks and events hold
   their whole list in the browser and filter it there, while creators are
   paged by the server and must ask it. A client-side filter on the creators
   page would search 25 rows and look like an answer.
   ═══════════════════════════════════════════════════════════════════════════ */
import { test, expect, devices, type Page, type Route } from "@playwright/test";
import { ORIGIN } from "./harness";
import { readFileSync, existsSync } from "node:fs";
import { join, normalize } from "node:path";

const { defaultBrowserType: _b, ...PHONE } = devices["iPhone 13"];

/* One submission awaiting a verdict, worth 10 by its rule. */
const SUB = (over: Record<string, unknown> = {}) => ({
  id: 501, assignment_id: 9001, version_no: 1, status: "submitted",
  content_url: "https://drive.google.com/file/d/x/view", submission_type: "Reel",
  note: "", submitted_by: "c1", submitted_at: "2026-09-20T10:00:00Z",
  reviewed_by: null, reviewed_at: null, review_comment: null, reviewer_name: null,
  task_title: "Reel — Convocation opener", deadline: "2026-09-25",
  creator_id: "c1", creator_name: "Misha Patel", team: { id: 1, name: "Reels Squad" },
  opportunity: { id: 77, title: "Reel Creator" },
  event: { id: 42, title: "Convocation 2026", date: "2026-09-24" },
  versions: 1,
  preset: { points: 10, rule_id: 3, rule_name: "Approved Reel", reason: "opportunity" },
  ...over,
});

const TASKS = [
  { id: 1, title: "Reel — opener", creator_name: "Misha Patel", team_name: "Reels Squad",
    event_title: "Convocation 2026", event_date: "2026-09-24", deadline: "2026-09-25",
    status: "assigned", creator_type: "Reel Creator", opportunity_title: "Reel Creator",
    submission_count: 0 },
  { id: 2, title: "Photo set — stage", creator_name: "Aakash Rao", team_name: "Stills",
    event_title: "Sports Meet 2026", event_date: "2026-10-02", deadline: "2026-10-04",
    status: "accepted", creator_type: "Photographer", opportunity_title: "Photographer",
    submission_count: 0 },
];

type Boot = { mode?: "creator_admin" | "creator"; subs?: unknown[]; tasks?: unknown[];
              onReview?: (body: Record<string, unknown>) => void;
              onCreators?: (url: URL) => void };

/** Boot the creator shell with the endpoints this file cares about scripted. */
async function boot(page: Page, o: Boot = {}) {
  const mode = o.mode ?? "creator_admin";
  await page.route(`${ORIGIN}/**`, async (route: Route) => {
    const url = new URL(route.request().url());
    const p = url.pathname;
    const json = (status: number, body: unknown) => route.fulfill({
      status, contentType: "application/json", body: JSON.stringify(body),
      headers: { "cache-control": "no-store" } });

    if (p.startsWith("/api/media-ops/")) {
      const rel = p.slice("/api/media-ops/".length) || "index.html";
      const file = normalize(join("public/media-ops", rel));
      if (!existsSync(file)) return route.fulfill({ status: 404, body: "" });
      return route.fulfill({ status: 200, body: readFileSync(file),
        contentType: rel.endsWith(".html") ? "text/html" : "application/octet-stream",
        headers: { "cache-control": "no-store" } });
    }
    if (p.endsWith("/api/v1/media/state")) return json(403, { message: "not for your role" });
    if (p.endsWith("/creator/state")) return json(200, {
      profile: { user_id: "me", full_name: "Admin", display_name: "Admin", email: "a@x.invalid",
                 creator_role: mode, status: "active", joined_on: "2026-01-01",
                 team: { id: 1, name: "Reels Squad" }, lead: null },
      me: { id: "me" }, teams: [{ id: 1, name: "Reels Squad", member_count: 5, lead: null, is_active: true }],
      scope: mode === "creator_admin" ? "all" : "self",
      can_manage_network: mode === "creator_admin",
      counts: { active: 4, inactive: 0, suspended: 0, archived: 0 },
    });
    if (p.endsWith("/creator/submissions"))
      return json(200, { submissions: o.subs ?? [SUB()], total: 1, can_review: mode === "creator_admin" });
    if (/\/creator\/submissions\/\d+\/review$/.test(p)) {
      o.onReview?.(JSON.parse(route.request().postData() || "{}"));
      return json(200, { ok: true, status: "approved",
        points: { awarded: 10, reason: "awarded", pending: false, preset: 10, adjusted: false } });
    }
    if (p.endsWith("/creator/tasks")) return json(200, { tasks: o.tasks ?? TASKS });
    if (p.endsWith("/creator/creators")) { o.onCreators?.(url); return json(200, { creators: [], total: 0 }); }
    if (p.startsWith("/api/")) return json(200, {});
    return route.abort("internetdisconnected");
  });
  await page.goto("about:blank");
  await page.goto(`${ORIGIN}/api/media-ops/index.html?as=creator#/media/creator`);
  await page.waitForFunction(() => (document.querySelector("#page")?.innerHTML.length ?? 0) > 200,
    null, { timeout: 20_000 });
  await page.addStyleTag({ content: "#toasts{display:none!important}" });
}

const openReview = async (page: Page) => {
  await page.evaluate("location.hash='#/media/creator/review'");
  await page.waitForSelector('[data-act="cnReview"][data-o="approved"]', { timeout: 10_000 });
};

test.describe("the approve dialog", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("opens with the points the server resolved, and names the rule", async ({ page }) => {
    await boot(page);
    await openReview(page);
    await page.click('[data-act="cnReview"][data-o="approved"]');
    await expect(page.locator("#modal-layer")).toHaveClass(/\bon\b/);
    await expect(page.locator("#rv-points")).toHaveValue("10");
    await expect(page.locator("#rv-points-hint")).toContainText("Approved Reel");
    /* The creator and the version are named, so nobody approves the wrong row. */
    await expect(page.locator("#modal-layer .mo-head")).toContainText("Misha Patel");
    await expect(page.locator("#modal-layer .mo-head")).toContainText("V1");
  });

  test("plus and minus move the same field you can type into", async ({ page }) => {
    await boot(page);
    await openReview(page);
    await page.click('[data-act="cnReview"][data-o="approved"]');
    await page.click('[data-pt="1"]');
    await page.click('[data-pt="1"]');
    await expect(page.locator("#rv-points")).toHaveValue("12");
    await page.click('[data-pt="-1"]');
    await expect(page.locator("#rv-points")).toHaveValue("11");
    /* Typed value and stepper agree about what will be sent. */
    await page.fill("#rv-points", "40");
    await page.click('[data-pt="1"]');
    await expect(page.locator("#rv-points")).toHaveValue("41");
  });

  test("will not go below zero", async ({ page }) => {
    await boot(page);
    await openReview(page);
    await page.click('[data-act="cnReview"][data-o="approved"]');
    await page.fill("#rv-points", "1");
    for (let i = 0; i < 4; i++) await page.click('[data-pt="-1"]');
    await expect(page.locator("#rv-points")).toHaveValue("0");
  });

  test("sends exactly what the reviewer confirmed, with the note", async ({ page }) => {
    let sent: Record<string, unknown> | null = null;
    await boot(page, { onReview: (b) => { sent = b; } });
    await openReview(page);
    await page.click('[data-act="cnReview"][data-o="approved"]');
    await page.fill("#rv-points", "25");
    await page.fill("#rv-points-note", "re-shot after the venue moved");
    await page.click('[data-act="cnApproveGo"]');
    await expect.poll(() => sent).not.toBeNull();
    expect(sent!).toMatchObject({ outcome: "approved", points: 25,
      points_note: "re-shot after the venue moved" });
  });

  test("refuses a value out of range without calling the server", async ({ page }) => {
    let called = false;
    await boot(page, { onReview: () => { called = true; } });
    await openReview(page);
    await page.click('[data-act="cnReview"][data-o="approved"]');
    await page.fill("#rv-points", "99999");
    await page.click('[data-act="cnApproveGo"]');
    await expect(page.locator("#rv-points-err")).toContainText("between 0 and 10000");
    await expect(page.locator("#rv-points")).toHaveAttribute("aria-invalid", "true");
    await expect(page.locator("#modal-layer")).toHaveClass(/\bon\b/);   // still open to fix
    expect(called, "a bad value was sent to the server").toBe(false);
  });

  test("where no rule applies it says so, and offers no number to invent", async ({ page }) => {
    await boot(page, { subs: [SUB({ preset: { points: null, rule_id: null, rule_name: null, reason: "ambiguous" } })] });
    await openReview(page);
    await page.click('[data-act="cnReview"][data-o="approved"]');
    await expect(page.locator("#modal-layer")).toContainText("More than one active rule");
    await expect(page.locator("#rv-points")).toHaveCount(0);
    /* Approving is still possible — it records the verdict, awards nothing. */
    await expect(page.locator('[data-act="cnApproveGo"]')).toBeVisible();
  });
});

test.describe("the approve dialog on a phone", () => {
  test.use(PHONE);

  test("is a sheet whose controls are thumb-sized and do not zoom iOS", async ({ page }) => {
    await boot(page);
    await openReview(page);
    await page.click('[data-act="cnReview"][data-o="approved"]');
    const m = await page.evaluate(() => {
      const i = document.querySelector("#rv-points") as HTMLElement;
      const b = document.querySelector("[data-pt]") as HTMLElement;
      return { font: parseFloat(getComputedStyle(i).fontSize),
               inputH: parseFloat(getComputedStyle(i).height),
               btnH: parseFloat(getComputedStyle(b).height),
               btnW: parseFloat(getComputedStyle(b).width) };
    });
    expect(m.font).toBeGreaterThanOrEqual(16);     // below this iOS zooms the page
    expect(m.inputH).toBeGreaterThanOrEqual(44);
    expect(m.btnH).toBeGreaterThanOrEqual(44);
    expect(m.btnW).toBeGreaterThanOrEqual(44);
  });
});

test.describe("searching", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  const goTasks = async (page: Page) => {
    await page.evaluate("location.hash='#/media/creator/tasks'");
    await page.waitForSelector("#cn-task-q", { timeout: 10_000 });
  };

  test("a task search matches creator, event and category, not only the title", async ({ page }) => {
    await boot(page);
    await goTasks(page);
    const rows = () => page.locator("#page table.tbl tbody tr");
    expect(await rows().count()).toBe(2);

    await page.fill("#cn-task-q", "Aakash");                 // creator
    await expect(rows()).toHaveCount(1);
    await page.fill("#cn-task-q", "Convocation");            // event
    await expect(rows()).toHaveCount(1);
    await page.fill("#cn-task-q", "Photographer");           // category
    await expect(rows()).toHaveCount(1);
    await page.fill("#cn-task-q", "reel");                   // case-insensitive
    await expect(rows()).toHaveCount(1);
  });

  test("typing keeps focus and the caret, so the second character is not lost", async ({ page }) => {
    await boot(page);
    await goTasks(page);
    await page.click("#cn-task-q");
    await page.keyboard.type("reel", { delay: 30 });
    await expect(page.locator("#cn-task-q")).toBeFocused();
    await expect(page.locator("#cn-task-q")).toHaveValue("reel");
  });

  test("says how many of how many, and what matched nothing", async ({ page }) => {
    await boot(page);
    await goTasks(page);
    await page.fill("#cn-task-q", "Aakash");
    await expect(page.locator("#page .hint")).toContainText("1 of 2 shown");
    await page.fill("#cn-task-q", "zzzz");
    await expect(page.locator("#page .hint")).toContainText("nothing matches");
  });

  test("a task search never asks the server — the rows are already here", async ({ page }) => {
    let fetches = 0;
    await boot(page, { tasks: TASKS });
    await page.route("**/creator/tasks*", async (route) => { fetches++; await route.fallback(); });
    await goTasks(page);
    const before = fetches;
    await page.fill("#cn-task-q", "Aakash");
    await page.waitForTimeout(400);
    expect(fetches, "filtering refetched the list").toBe(before);
  });

  test("a creator search DOES ask the server, debounced, because the list is paged", async ({ page }) => {
    const asked: string[] = [];
    await boot(page, { onCreators: (u) => asked.push(u.searchParams.get("q") ?? "") });
    await page.evaluate("location.hash='#/media/creator/creators'");
    await page.waitForSelector("#cr-q", { timeout: 10_000 });
    asked.length = 0;
    await page.click("#cr-q");
    await page.keyboard.type("misha", { delay: 20 });
    await page.waitForTimeout(600);
    expect(asked.length, "one request per keystroke, or none at all").toBe(1);
    expect(asked[0]).toBe("misha");
    await expect(page.locator("#cr-q")).toBeFocused();
  });
});
