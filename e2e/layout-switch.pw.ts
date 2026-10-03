/* ═══════════════════════════════════════════════════════════════════════════
   The layout switch in a real browser.

   jsdom proves the logic with a scripted matchMedia; only Chromium can prove
   the part that depends on the browser: that touch emulation actually matches
   (hover: none) and (pointer: coarse), that a mouse window squeezed to phone
   width does NOT, that the attribute is right before first paint, and that
   a rewritten viewport really gives a phone the 1280px desktop.
   ═══════════════════════════════════════════════════════════════════════════ */
import { test, expect, devices, type Page } from "@playwright/test";
import { bootStaff, ORIGIN } from "./harness";

/* A device preset minus its browser choice — this suite always runs Chromium,
   and a per-group browser type is not allowed. */
const device = (name: string) => {
  const { defaultBrowserType: _b, ...rest } = devices[name];
  return rest;
};

/** Record every data-layout write from the first byte of the document. */
async function recordLayoutWrites(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __layouts: string[]; __flips: string[] };
    w.__layouts = []; w.__flips = [];
    const set = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (n: string, v: string) {
      if (this === document.documentElement && n === "data-layout") w.__layouts.push(v);
      return set.call(this, n, v);
    };
    addEventListener("mo:layout", () => w.__flips.push(document.documentElement.getAttribute("data-layout")!));
  });
}
const layout = (page: Page) => page.evaluate(() => document.documentElement.getAttribute("data-layout"));
const writes = (page: Page) => page.evaluate(() => (window as unknown as { __layouts: string[] }).__layouts);
const flips = (page: Page) => page.evaluate(() => (window as unknown as { __flips: string[] }).__flips);

test.describe("a mouse desktop is always desktop", () => {
  for (const width of [1440, 1024, 800, 700, 390]) {
    test(`at ${width}px wide`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await recordLayoutWrites(page);
      await bootStaff(page, "admin");
      expect(await layout(page)).toBe("desktop");
      expect(await writes(page)).toEqual(["desktop"]);
    });
  }

  test("resizing across 820 and back never flips it", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await recordLayoutWrites(page);
    await bootStaff(page, "admin");
    for (const width of [700, 390, 1280, 600, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(50);
      expect(await layout(page), `flipped at ${width}px`).toBe("desktop");
    }
    expect(await flips(page)).toEqual([]);
  });
});

test.describe("a touch phone is mobile", () => {
  test.use(device("iPhone 13"));

  test("from the first write, with no desktop frame before it", async ({ page }) => {
    await recordLayoutWrites(page);
    await bootStaff(page, "admin");
    expect(await page.evaluate(() => matchMedia("(hover: none) and (pointer: coarse)").matches),
      "Chromium's touch emulation does not match the query the switch relies on").toBe(true);
    expect(await layout(page)).toBe("mobile");
    expect(await writes(page)).toEqual(["mobile"]);
    expect(await page.evaluate("isMobileLayout()")).toBe(true);
  });

  test("in landscape too", async ({ page }) => {
    await page.setViewportSize({ width: 844, height: 390 });
    await bootStaff(page, "admin");
    expect(await layout(page)).toBe("mobile");
  });

  test("chooses the real 1280px desktop when the person asks for Desktop", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("mo_layout", "desktop"));
    await bootStaff(page, "admin");
    expect(await layout(page)).toBe("desktop");
    expect(await page.evaluate(() => window.innerWidth)).toBe(1280);
  });
});

test.describe("a touch tablet", () => {
  test.use(device("iPad Pro 11 landscape"));

  test("is desktop in landscape, and flips on rotation only once the modal is closed", async ({ page }) => {
    await recordLayoutWrites(page);
    await bootStaff(page, "admin");
    expect(await layout(page)).toBe("desktop");

    await page.evaluate(`modal('<div class="mo-body"><input id="typed" value="half a task"></div>')`);
    await page.setViewportSize({ width: 820, height: 1180 });       // rotate to portrait
    await page.waitForTimeout(50);
    expect(await layout(page), "flipped under an open modal").toBe("desktop");
    await expect(page.locator("#typed")).toHaveValue("half a task");

    await page.evaluate("closeModal()");
    expect(await layout(page)).toBe("mobile");
    expect(await flips(page)).toEqual(["mobile"]);
  });
});

test("?layout=mobile shows the phone layout on a wide desktop, for one load", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await bootStaff(page, "admin");
  await page.goto(`${ORIGIN}/api/media-ops/index.html?layout=mobile#/media/home`);
  expect(await layout(page)).toBe("mobile");
  expect(await page.evaluate(() => localStorage.getItem("mo_layout"))).toBeNull();
});
