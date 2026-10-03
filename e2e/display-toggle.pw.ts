/* ═══════════════════════════════════════════════════════════════════════════
   P4 — the Desktop/Mobile toggle.

   The switch built inert in P1 is now something a person controls: a button
   beside the profile, and a seg in the profile and More sheets. These tests
   drive it the way a person would and check the layout, the viewport and the
   remembered theme actually follow.
   ═══════════════════════════════════════════════════════════════════════════ */
import { test, expect, devices, type Page } from "@playwright/test";
import { bootStaff, ORIGIN } from "./harness";

const device = (name: string) => { const { defaultBrowserType: _b, ...rest } = devices[name]; return rest; };
const layout = (p: Page) => p.evaluate(() => document.documentElement.getAttribute("data-layout"));
const theme = (p: Page) => p.evaluate(() => document.documentElement.getAttribute("data-theme"));

test.describe("the topbar button", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("shows the layout in force and opens Auto/Desktop/Mobile", async ({ page }) => {
    await bootStaff(page, "admin");
    await expect(page.locator("#btn-display")).toHaveAttribute("aria-label", "Display: Desktop");
    await page.click("#btn-display");
    await expect(page.locator(".menu")).toBeVisible();
    for (const l of ["Auto", "Desktop", "Mobile"]) await expect(page.locator(".menu-item", { hasText: l })).toBeVisible();
    await expect(page.locator(".menu-item.on")).toHaveText(/Auto/);
  });

  test("Mobile flips a wide desktop with no reload, keeping in-memory state", async ({ page }) => {
    await bootStaff(page, "admin");
    await page.evaluate(() => ((window as unknown as { __keep: number }).__keep = 42));
    await page.click("#btn-display");
    await page.click('.menu-item:has-text("Mobile")');
    expect(await layout(page)).toBe("mobile");
    expect(await page.evaluate(() => (window as unknown as { __keep?: number }).__keep), "the page reloaded").toBe(42);
    await expect(page.locator("#mobilebar")).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem("mo_layout"))).toBe("mobile");
  });

  test("the button icon tracks the layout after a flip", async ({ page }) => {
    await bootStaff(page, "admin");
    await page.click("#btn-display");
    await page.click('.menu-item:has-text("Mobile")');
    await expect(page.locator("#btn-display")).toHaveAttribute("aria-label", "Display: Mobile");
  });
});

test.describe("Desktop chosen on a phone", () => {
  test.use(device("iPhone 13"));

  test("reloads into the real 1280px desktop", async ({ page }) => {
    await bootStaff(page, "admin");
    expect(await layout(page)).toBe("mobile");
    await page.click("#btn-display");
    await Promise.all([
      page.waitForNavigation(),   // the viewport rewrite forces a reload
      page.click('.menu-item:has-text("Desktop")'),
    ]);
    expect(await layout(page)).toBe("desktop");
    expect(await page.evaluate(() => window.innerWidth)).toBe(1280);
    expect(await page.evaluate(() => localStorage.getItem("mo_layout"))).toBe("desktop");
  });
});

test.describe("the seg in the profile sheet", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("changes the layout, and lights the chosen option", async ({ page }) => {
    await bootStaff(page, "admin");
    await page.click("#btn-role");
    await page.click('#modal-layer [data-act="setLayout"][data-v="mobile"]');
    expect(await layout(page)).toBe("mobile");
  });

  test("on desktop, the theme changes but is not remembered", async ({ page }) => {
    await bootStaff(page, "admin");
    await page.click("#btn-role");
    await page.click('#modal-layer [data-act="setTheme"][data-v="dark"]');
    expect(await theme(page)).toBe("dark");
    /* The seg lights up in place, no rebuild. */
    await expect(page.locator('#modal-layer [data-act="setTheme"][data-v="dark"]')).toHaveClass(/\bon\b/);
    /* Desktop does not persist the theme — a reload comes back light. */
    expect(await page.evaluate(() => localStorage.getItem("mo_theme"))).toBeNull();
  });
});

test.describe("theme on a phone is remembered", () => {
  test.use(device("iPhone 13"));

  test("the More sheet seg sets it, writes mo_theme, and survives a reload before paint", async ({ page }) => {
    await bootStaff(page, "admin");
    await page.click('#mobilebar [aria-label="More"]');
    await page.click('#m-sheet [data-act="setTheme"][data-v="dark"]');
    expect(await theme(page)).toBe("dark");
    expect(await page.evaluate(() => localStorage.getItem("mo_theme"))).toBe("dark");

    /* Reopen from scratch. The head script runs during parse, so data-theme is
       dark before the app script defines S; capture the head-script value via an
       init script, then confirm S adopts it once booted. */
    await page.addInitScript(() => ((window as unknown as { __theme0: string | null }).__theme0 =
      document.documentElement.getAttribute("data-theme")));
    await page.goto(`${ORIGIN}/api/media-ops/index.html#/media/home`);
    /* S is a top-level const in the inline script — reachable by bare name in a
       string eval, never as window.S (which is why the harness evals strings). */
    await page.waitForFunction("typeof S !== 'undefined'");
    expect(await theme(page), "the head script did not apply the saved theme before paint").toBe("dark");
    expect(await page.evaluate("S.theme"), "S.theme did not adopt the persisted theme").toBe("dark");
  });
});

test("Auto is restored, and forgets the saved preference", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await bootStaff(page, "admin");
  await page.evaluate(() => localStorage.setItem("mo_layout", "mobile"));
  await page.reload();
  expect(await layout(page)).toBe("mobile");
  await page.click("#btn-display");
  await page.click('.menu-item:has-text("Auto")');
  expect(await layout(page)).toBe("desktop");
  expect(await page.evaluate(() => localStorage.getItem("mo_layout"))).toBeNull();
});
