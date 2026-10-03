/* ═══════════════════════════════════════════════════════════════════════════
   P9 — the app once it is installed.

   Installed is a different product from a tab: there is no address bar to
   reload from, no way to see that a deploy happened, and a network failure has
   no browser error page behind it. These tests drive the three things that only
   exist there — the status-bar colour, the offline card and the update notice —
   and check a browser tab is left exactly as it was.
   ═══════════════════════════════════════════════════════════════════════════ */
import { test, expect, devices, type Page } from "@playwright/test";
import { bootStaff, ORIGIN } from "./harness";
import { readFileSync, existsSync } from "node:fs";
import { join, normalize } from "node:path";

const { defaultBrowserType: _b, ...PHONE } = devices["iPhone 13"];
const themeColor = (p: Page) =>
  p.evaluate(() => document.querySelector('meta[name="theme-color"]')?.getAttribute("content"));

/* Two ways to be installed, and the difference matters. The offline card is
   decided during boot, so that test has to be installed BEFORE the page loads.
   Everything else needs an app that booted normally and is installed now —
   installing it from the start would just show the offline card, because the
   harness answers no API call. */
const FAKE_STANDALONE = `(()=>{const real=window.matchMedia.bind(window);
  window.matchMedia=(q)=>q.includes('display-mode: standalone')
    ? {matches:true,media:q,onchange:null,addEventListener(){},removeEventListener(){},
       addListener(){},removeListener(){},dispatchEvent:()=>false}
    : real(q);})()`;
const becomeInstalled = (p: Page) => p.evaluate(FAKE_STANDALONE);

/** Make the page believe it was launched from the home screen, from load. */
const pretendInstalled = (p: Page) => p.addInitScript(() => {
  const real = window.matchMedia.bind(window);
  window.matchMedia = ((q: string) => q.includes("display-mode: standalone")
    ? { matches: true, media: q, onchange: null,
        addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
        dispatchEvent: () => false } as unknown as MediaQueryList
    : real(q)) as typeof window.matchMedia;
});

test.describe("the status bar colour", () => {
  test("follows the phone's theme, and stays dark on desktop", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await bootStaff(page, "admin");
    /* Desktop keeps the value it has always had — the tab and a desktop-installed
       title bar are not what this phase changes. */
    expect(await themeColor(page)).toBe("#0E1512");

    await page.click("#btn-display");
    await page.click('.menu-item:has-text("Mobile")');
    expect(await themeColor(page), "a phone light bar should match the app's white surface").toBe("#FFFFFF");

    await page.click("#btn-role");
    await page.click('#modal-layer [data-act="setTheme"][data-v="dark"]');
    expect(await themeColor(page), "a dark phone bar should match the dark surface").toBe("#131A24");
  });

});

test.describe("the status bar colour, on a real phone", () => {
  /* The device descriptor, not just a narrow viewport: Auto is touch-aware by
     design, so a small window with a mouse stays desktop. */
  test.use(PHONE);

  test("is already right before the first paint", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("mo_theme", "dark"));
    await bootStaff(page, "admin");
    /* The head script runs during parse, so this was never white first. */
    expect(await themeColor(page)).toBe("#131A24");
  });
});

test.describe("installed, with no network", () => {
  test.use(PHONE);

  test("says so, instead of quietly showing demo data", async ({ page }) => {
    await pretendInstalled(page);
    /* Serve the app itself, and let every API call fail at the transport, which
       is what a phone with no signal does. */
    await page.route(`${ORIGIN}/**`, (route) => {
      const p = new URL(route.request().url()).pathname;
      if (p.startsWith("/api/media-ops/")) {
        const rel = p.slice("/api/media-ops/".length) || "index.html";
        const file = normalize(join("public/media-ops", rel));
        if (!existsSync(file)) return route.fulfill({ status: 404, body: "" });
        return route.fulfill({ status: 200, body: readFileSync(file),
          contentType: rel.endsWith(".html") ? "text/html" : "application/octet-stream",
          headers: { "cache-control": "no-store" } });
      }
      return route.abort("internetdisconnected");
    });
    await page.goto(`${ORIGIN}/api/media-ops/index.html#/media/home`);
    await expect(page.locator(".offline-card")).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(".offline-card h1")).toHaveText(/offline/i);
    /* The seed department must not be on screen: those are real people's names. */
    await expect(page.locator("#page")).toHaveCount(0);
  });

  test("a browser tab still falls back to the seed, as it always has", async ({ page }) => {
    /* Same failure, not installed: unchanged behaviour. */
    await bootStaff(page, "admin");
    await expect(page.locator(".offline-card")).toHaveCount(0);
    await expect(page.locator("#page")).toBeVisible();
  });
});

test.describe("a new version on the server", () => {
  test.use(PHONE);

  test("offers a reload, and does not go away by itself", async ({ page }) => {
    await bootStaff(page, "admin");
    await becomeInstalled(page);
    /* The running page is "dev"; answer the check with a different build. */
    await page.route("**/index.html", (route) =>
      route.fulfill({ status: 200, contentType: "text/html",
        body: '<meta name="mo-build" content="0123456789ab">' }));
    await page.evaluate("_updAt=0; moCheckUpdate()");
    const banner = page.locator("#mo-update");
    await expect(banner).toBeVisible();
    /* A toast would have gone by now: action toasts auto-dismiss at 6s. */
    await page.waitForTimeout(6500);
    await expect(banner, "the notice disappeared on its own").toBeVisible();
    await expect(banner).toContainText("new version");
  });

  test("says nothing when the build is the same", async ({ page }) => {
    await bootStaff(page, "admin");
    await becomeInstalled(page);
    await page.route("**/index.html", (route) =>
      route.fulfill({ status: 200, contentType: "text/html",
        body: '<meta name="mo-build" content="dev">' }));
    await page.evaluate("_updAt=0; moCheckUpdate()");
    await page.waitForTimeout(200);
    await expect(page.locator("#mo-update")).toHaveCount(0);
  });

  test("never checks in a browser tab", async ({ page }) => {
    await bootStaff(page, "admin");
    let asked = false;
    await page.route("**/index.html", (route) => { asked = true; return route.fulfill({ status: 200, body: "" }); });
    await page.evaluate("_updAt=0; moCheckUpdate()");
    await page.waitForTimeout(200);
    expect(asked, "a tab reloads itself; it has no business polling").toBe(false);
  });
});

test.describe("the More sheet", () => {
  test.use(PHONE);

  test("offers Reload app only once there is no address bar", async ({ page }) => {
    await bootStaff(page, "admin");
    await page.click('#mobilebar [aria-label="More"]');
    await expect(page.locator('#m-sheet .m-sheet-row:has-text("Reload app")')).toHaveCount(0);
  });

  test("offers it when installed, and says where Nerve home will open on iOS", async ({ page }) => {
    await page.addInitScript(() => Object.defineProperty(navigator, "userAgent",
      { get: () => "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15" }));
    await bootStaff(page, "admin");
    await becomeInstalled(page);
    await page.click('#mobilebar [aria-label="More"]');
    await expect(page.locator('#m-sheet .m-sheet-row:has-text("Reload app")')).toBeVisible();
    await expect(page.locator('#m-sheet .m-sheet-row:has-text("Nerve home")')).toContainText("Safari");
  });
});
