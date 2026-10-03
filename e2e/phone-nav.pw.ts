/* ═══════════════════════════════════════════════════════════════════════════
   P3 — phone navigation: the bar, and the More sheet behind it.

   THE GUARANTEE. Nothing a role can open on the desktop sidebar becomes
   unreachable on a phone. The bar carries a few destinations; the More sheet
   carries the rest; together they must cover every reachable NAV item — for
   every staff role and every creator mode. This is the test that lets the bar
   be short without losing anything.
   ═══════════════════════════════════════════════════════════════════════════ */
import { test, expect, devices, type Page } from "@playwright/test";
import { bootStaff, bootCreator, type Staff, type CreatorMode } from "./harness";

const { defaultBrowserType: _b, ...PHONE } = devices["iPhone 13"];
test.use(PHONE);

const barRoutes = (p: Page) => p.evaluate("mobileBarModel().filter(e=>e.r).map(e=>e.r)") as Promise<string[]>;
const barModel = (p: Page) => p.evaluate("mobileBarModel()") as Promise<Array<Record<string, unknown>>>;
const moreRoutes = (p: Page) =>
  p.evaluate("moreGroups().flatMap(g=>g.items).filter(i=>i.go).map(i=>i.go)") as Promise<string[]>;
const moreActs = (p: Page) =>
  p.evaluate("moreGroups().flatMap(g=>g.items).filter(i=>i.act).map(i=>i.act)") as Promise<string[]>;
const navReachable = (p: Page) =>
  p.evaluate("NAV.flatMap(g=>g.items).filter(navReachable).map(it=>it.r)") as Promise<string[]>;

const STAFF: Staff[] = ["admin", "team_lead", "coordinator", "employee"];

test.describe("every sidebar destination is reachable on a phone", () => {
  for (const role of STAFF) {
    test(role, async ({ page }) => {
      await bootStaff(page, role);
      const [bar, more, reachable] = await Promise.all([barRoutes(page), moreRoutes(page), navReachable(page)]);
      const covered = new Set([...bar, ...more]);
      const missing = reachable.filter((r) => !covered.has(r));
      expect(missing, `${role}: sidebar routes with no phone home`).toEqual([]);
    });
  }

  test("a staff member inside the Creator Network keeps every Media Ops door too", async ({ page }) => {
    await bootStaff(page, "admin");
    await page.evaluate("location.hash='#/media/creator'; render();");
    /* The CN bar is showing; Media Ops routes must still be in More. */
    const [more, reachable] = await Promise.all([moreRoutes(page), navReachable(page)]);
    const covered = new Set(more);
    const missing = reachable.filter((r) => r !== "#/media/creator" && !covered.has(r));
    expect(missing, "Media Ops routes lost while inside the Creator Network").toEqual([]);
  });
});

test.describe("every creator page is reachable on a phone", () => {
  for (const mode of ["creator", "team_lead", "creator_admin"] as CreatorMode[]) {
    test(mode, async ({ page }) => {
      await bootCreator(page, mode);
      const bar = await barRoutes(page);
      const more = await moreRoutes(page);
      const cnRoutes = await page.evaluate("cnItems().map(cnRoute)") as string[];
      const covered = new Set([...bar, ...more]);
      const missing = cnRoutes.filter((r) => !covered.has(r));
      expect(missing, `${mode}: creator pages with no phone home`).toEqual([]);
    });
  }
});

test.describe("the bar itself", () => {
  test("is never more than five items, and every route on it is reachable", async ({ page }) => {
    for (const role of STAFF) {
      await page.unrouteAll({ behavior: "ignoreErrors" });
      await bootStaff(page, role);
      const model = await barModel(page);
      expect(model.length, `${role} bar length`).toBeLessThanOrEqual(5);
      expect(model.filter((e) => e.fab).length, `${role} FAB count`).toBeLessThanOrEqual(1);
      expect(model[model.length - 1].more, `${role} last item is More`).toBe(true);
      const reachable = new Set(await navReachable(page));
      for (const e of model) if (e.r) expect(reachable.has(e.r as string), `${role} bar route ${e.r}`).toBe(true);
    }
  });

  test("gives the Log FAB only to roles that log tasks", async ({ page }) => {
    await bootStaff(page, "employee");
    expect((await barModel(page)).some((e) => e.fab), "employee has no Log FAB").toBe(true);
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await bootStaff(page, "admin");
    expect((await barModel(page)).some((e) => e.fab), "admin should not get the Log FAB").toBe(false);
  });

  test("matches the documented bar for each role", async ({ page }) => {
    const expected: Record<Staff, string[]> = {
      admin: ["#/media/home", "#/media/projects", "#/media/reports", "#/media/leave"],
      team_lead: ["#/media/home", "#/media/projects", "#/media/reports", "#/media/leave"],
      coordinator: ["#/media/my-day", "#/media/requests", "#/media/dispatch", "#/media/projects"],
      employee: ["#/media/my-day", "#/media/projects", "#/media/equipment"],
    };
    for (const role of STAFF) {
      await page.unrouteAll({ behavior: "ignoreErrors" });
      await bootStaff(page, role);
      expect(await barRoutes(page), role).toEqual(expected[role]);
    }
  });
});

test.describe("account controls live in More", () => {
  test("staff get Notifications, Profile, Nerve home and Log out", async ({ page }) => {
    await bootStaff(page, "admin");
    const acts = await moreActs(page);
    expect(acts).toEqual(expect.arrayContaining(["moreNotifications", "moreProfile", "moreNerveHome", "logout"]));
  });

  test("a creator's More has no Notifications (their inbox is always empty)", async ({ page }) => {
    await bootCreator(page, "creator");
    expect(await moreActs(page)).not.toContain("moreNotifications");
    /* And the topbar bell is hidden for them. */
    await expect(page.locator("#btn-bell")).toBeHidden();
  });

  test("Kiosk is in More only where the role holds it", async ({ page }) => {
    await bootStaff(page, "admin");
    expect(await moreActs(page)).toContain("moreKiosk");
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await bootStaff(page, "employee");
    /* The seed employee has no kiosk grant. */
    const empHasKiosk = await page.evaluate("moduleAllowed('kiosk')&&moduleAllowed('equipment')");
    expect(await moreActs(page)).toEqual(empHasKiosk ? expect.arrayContaining(["moreKiosk"]) : expect.not.arrayContaining(["moreKiosk"]));
  });
});

test.describe("the bar in use", () => {
  test("More opens the sheet and its scrim, and closes both", async ({ page }) => {
    await bootStaff(page, "admin");
    await page.click('#mobilebar [aria-label="More"]');
    await expect(page.locator("#m-sheet")).toHaveClass(/\bon\b/);
    await expect(page.locator("#m-sheet-scrim")).toHaveClass(/\bon\b/);
    await page.click("#m-sheet [data-msclose]");
    await expect(page.locator("#m-sheet")).not.toHaveClass(/\bon\b/);
  });

  test("a More row navigates, and closes the sheet", async ({ page }) => {
    await bootStaff(page, "admin");
    await page.click('#mobilebar [aria-label="More"]');
    await page.click('#m-sheet [data-go="#/media/calendar"]');
    expect(await page.evaluate("location.hash")).toBe("#/media/calendar");
    await expect(page.locator("#m-sheet")).not.toHaveClass(/\bon\b/);
  });

  /* The sheet holds a history entry, so closing it queues a history.back(). When
     that raced the row's own navigation the viewer was bounced straight back to
     where they started. Both halves are asserted: you arrive, and ONE Back
     returns you — not zero (entry eaten) and not two (entry left behind). */
  test("one Back after a More row returns to the page you left", async ({ page }) => {
    await bootStaff(page, "admin");
    await page.evaluate("location.hash='#/media/projects'");
    await page.waitForFunction("location.hash==='#/media/projects'");
    await page.click('#mobilebar [aria-label="More"]');
    await page.click('#m-sheet [data-go="#/media/calendar"]');
    await page.waitForTimeout(80);   // any queued history step would land by now
    expect(await page.evaluate("location.hash"), "the navigation was undone").toBe("#/media/calendar");
    await page.goBack();
    expect(await page.evaluate("location.hash")).toBe("#/media/projects");
  });

  test("tapping a bar item navigates; tapping the active one scrolls to the top", async ({ page }) => {
    await bootStaff(page, "admin");
    await page.click('#mobilebar button:has-text("Projects")');
    expect(await page.evaluate("hashModule(location.hash)")).toBe("projects");
    /* Scroll the page down, then tap the tab it is already on. */
    const scrolled = await page.evaluate(() => { const c = document.querySelector("#content")!;
      c.scrollTop = 400; return c.scrollTop; });
    expect(scrolled, "the projects page was not scrollable to test against").toBeGreaterThan(0);
    await page.click('#mobilebar button:has-text("Projects")');   // the active tab
    expect(await page.evaluate("document.querySelector('#content').scrollTop")).toBe(0);
  });

  test("the active tab is the one whose page is showing", async ({ page }) => {
    await bootStaff(page, "admin");
    await page.evaluate("location.hash='#/media/projects/1'; render();");
    const active = await page.evaluate(
      "[...document.querySelectorAll('#mobilebar .mb-it.on')].map(b=>b.getAttribute('aria-label'))");
    expect(active).toEqual(["Projects"]);   // a project detail still lights Projects
  });

  test("the More tab shows a dot when something badged is hidden behind it", async ({ page }) => {
    await bootStaff(page, "admin");
    /* Admin's bar omits Pipeline, which carries an overdue badge in the seed. */
    const dot = await page.evaluate("moreHasBadge()");
    expect(dot).toBe(true);
    await expect(page.locator("#mobilebar .mb-dot")).toBeVisible();
  });
});
