/* ═══════════════════════════════════════════════════════════════════════════
   P2 — the phone chrome: topbar, bottom bar, the menu, toasts.

   Enforced from this phase on at every phone width: nothing in the chrome runs
   past the screen edge, every chrome control is a 44px thumb target, the bar
   never hides the end of a page, and the menu opened from the burger can be
   closed the ways a person would try.
   ═══════════════════════════════════════════════════════════════════════════ */
import { test, expect, devices, type Page } from "@playwright/test";
import { bootStaff, go, ORIGIN } from "./harness";

const { defaultBrowserType: _b, ...PHONE } = devices["iPhone 13"];
test.use(PHONE);

const WIDTHS: Array<[number, number]> = [
  [320, 568], [360, 740], [375, 812], [390, 844], [393, 852], [414, 896], [430, 932],
];

/** Chrome elements past the viewport edge, and chrome controls under 44px. */
async function chromeProblems(page: Page) {
  return await page.evaluate(() => {
    const W = innerWidth, out: string[] = [];
    const shown = (el: Element) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && cs.display !== "none" && cs.visibility !== "hidden"; };
    for (const sel of ["#topbar", "#mobilebar"]) for (const el of document.querySelectorAll(`${sel} *`)) {
      if (!shown(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.right > W + 1 || r.left < -1) out.push(`${sel} ${el.tagName.toLowerCase()}#${el.id} past the edge`);
    }
    for (const el of document.querySelectorAll("#topbar button, #mobilebar button")) {
      if (!shown(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 44 || r.height < 44) out.push(`${el.id || el.textContent?.trim()} is ${Math.round(r.width)}×${Math.round(r.height)}`);
    }
    return out;
  });
}

for (const [width, height] of WIDTHS) {
  test(`${width}px: the chrome fits and every control is a thumb target`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    for (const role of ["admin", "employee"] as const) {
      await page.unrouteAll({ behavior: "ignoreErrors" });
      await bootStaff(page, role);
      for (const r of ["#/media/home", "#/media/my-day", "#/media/projects", "#/media/pipeline"]) {
        await go(page, r);
        expect(await chromeProblems(page), `${role} ${r}`).toEqual([]);
      }
    }
  });
}

test("the topbar shows the page's name, and search is one tap", async ({ page }) => {
  await bootStaff(page, "admin");
  await go(page, "#/media/pipeline");
  await expect(page.locator("#m-title")).toBeVisible();
  await expect(page.locator("#m-title")).toHaveText(await page.locator("#crumb-page").textContent() ?? "");
  await expect(page.locator(".search-wrap")).toBeHidden();
  await page.click("#btn-msearch");
  await expect(page.locator("#palette")).toHaveClass(/\bon\b/);
});

test("the bar never hides the end of a page", async ({ page }) => {
  await bootStaff(page, "admin");
  const [bar, pad] = await page.evaluate(() => [
    document.querySelector("#mobilebar")!.getBoundingClientRect().height,
    parseFloat(getComputedStyle(document.querySelector("#content")!).paddingBottom),
  ]);
  expect(bar).toBeGreaterThanOrEqual(60);
  expect(pad, "content can scroll no further than the top of the bar").toBeGreaterThanOrEqual(bar);
});

test("a toast sits above the bar, not on it", async ({ page }) => {
  await bootStaff(page, "admin");
  /* The harness hides toasts for pixel stability; this test is about them. */
  await page.evaluate(() => document.querySelectorAll("style").forEach((s) => {
    if (s.textContent?.includes("#toasts{display:none")) s.remove(); }));
  await page.evaluate("toast('Saved','ok')");
  /* Toasts slide up into place; measure where it settles, not mid-flight. */
  await page.waitForTimeout(400);
  const [toastBottom, barTop] = await page.evaluate(() => [
    document.querySelector("#toasts .toast")!.getBoundingClientRect().bottom,
    document.querySelector("#mobilebar")!.getBoundingClientRect().top,
  ]);
  expect(toastBottom).toBeLessThanOrEqual(barTop);
});

test.describe("the menu behind the burger", () => {
  const open = async (page: Page) => {
    await page.click("#btn-burger");
    await expect(page.locator("body")).toHaveClass(/nav-open/);
    await expect(page.locator("#scrim")).toHaveClass(/\bon\b/);
  };
  const closed = async (page: Page) => {
    await expect(page.locator("body")).not.toHaveClass(/nav-open/);
    await expect(page.locator("#scrim")).not.toHaveClass(/\bon\b/);
  };

  test("closes when a link in it is tapped, and goes there", async ({ page }) => {
    await bootStaff(page, "admin");
    await open(page);
    await page.locator('#sidebar a.nav-item[href="#/media/calendar"]').click();
    await closed(page);
    expect(await page.evaluate("location.hash")).toBe("#/media/calendar");
  });

  test("closes when the dimmed page beside it is tapped", async ({ page }) => {
    await bootStaff(page, "admin");
    await open(page);
    await page.mouse.click(page.viewportSize()!.width - 10, 300);
    await closed(page);
  });

  test("closes on Escape (a hardware keyboard on a tablet)", async ({ page }) => {
    await bootStaff(page, "admin");
    await open(page);
    await page.keyboard.press("Escape");
    await closed(page);
  });

  test("takes taps on its own links, above its scrim", async ({ page }) => {
    await bootStaff(page, "admin");
    await open(page);
    const hit = await page.evaluate(() => {
      const a = document.querySelector('#sidebar a.nav-item[href="#/media/calendar"]')!;
      const r = a.getBoundingClientRect();
      return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest("#sidebar") !== null;
    });
    expect(hit, "the scrim is on top of the menu it belongs to").toBe(true);
  });
});

test("a phone in landscape gets the same chrome as in portrait", async ({ page }) => {
  await page.setViewportSize({ width: 844, height: 390 });
  await bootStaff(page, "admin");
  await expect(page.locator("#mobilebar")).toBeVisible();
  await expect(page.locator("#m-title")).toBeVisible();
  const sidebarRight = await page.evaluate(() => document.querySelector("#sidebar")!.getBoundingClientRect().right);
  expect(sidebarRight, "the desktop sidebar is showing on a landscape phone").toBeLessThanOrEqual(0);
});

test.describe("forced Mobile on a desktop", () => {
  test.use({ isMobile: false, hasTouch: false, viewport: { width: 1440, height: 900 } });

  test("gets the phone chrome at full width", async ({ page }) => {
    await bootStaff(page, "admin");
    await page.goto(`${ORIGIN}/api/media-ops/index.html?layout=mobile#/media/home`);
    await expect(page.locator("#mobilebar")).toBeVisible();
    await expect(page.locator(".search-wrap")).toBeHidden();
    const sidebarRight = await page.evaluate(() => document.querySelector("#sidebar")!.getBoundingClientRect().right);
    expect(sidebarRight).toBeLessThanOrEqual(0);
  });
});
