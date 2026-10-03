/* ═══════════════════════════════════════════════════════════════════════════
   P5 — overlays as phone surfaces.

   On a phone every overlay is dismissible with the hardware Back button (and
   the iOS edge swipe), sizes to the space the keyboard leaves, and traps focus
   and the screen reader inside itself. These tests drive Back, check the route
   never moves, and check #app is never left inert.
   ═══════════════════════════════════════════════════════════════════════════ */
import { test, expect, devices, type Page } from "@playwright/test";
import { bootStaff, go } from "./harness";

const { defaultBrowserType: _b, ...PHONE } = devices["iPhone 13"];
test.use(PHONE);

const hash = (p: Page) => p.evaluate(() => location.hash);
const appInert = (p: Page) => p.evaluate(() => (document.querySelector("#app") as HTMLElement).inert === true);

test.describe("Back closes each overlay and leaves the route where it was", () => {
  test("a modal", async ({ page }) => {
    await bootStaff(page, "employee");
    await go(page, "#/media/my-day");
    const before = await hash(page);
    await page.click("#mobilebar .fab");                 // Log task → modal
    await expect(page.locator("#modal-layer")).toHaveClass(/\bon\b/);
    expect(await appInert(page), "the app behind the modal is not inert").toBe(true);
    await page.goBack();
    await expect(page.locator("#modal-layer")).not.toHaveClass(/\bon\b/);
    expect(await hash(page)).toBe(before);
    expect(await appInert(page), "#app left inert after the modal closed").toBe(false);
  });

  test("the More sheet", async ({ page }) => {
    await bootStaff(page, "admin");
    const before = await hash(page);
    await page.click('#mobilebar [aria-label="More"]');
    await expect(page.locator("#m-sheet")).toHaveClass(/\bon\b/);
    await page.goBack();
    await expect(page.locator("#m-sheet")).not.toHaveClass(/\bon\b/);
    expect(await hash(page)).toBe(before);
  });

  test("a menu action sheet", async ({ page }) => {
    await bootStaff(page, "admin");
    const before = await hash(page);
    await page.click("#btn-display");
    await expect(page.locator(".menu.as-sheet")).toBeVisible();
    await page.goBack();
    await expect(page.locator(".menu")).toHaveCount(0);
    expect(await hash(page)).toBe(before);
  });

  test("the palette", async ({ page }) => {
    await bootStaff(page, "admin");
    const before = await hash(page);
    await page.click("#btn-msearch");
    await expect(page.locator("#palette")).toHaveClass(/\bon\b/);
    await page.goBack();
    await expect(page.locator("#palette")).not.toHaveClass(/\bon\b/);
    expect(await hash(page)).toBe(before);
  });

  test("a detail drawer", async ({ page }) => {
    await bootStaff(page, "admin");
    await go(page, "#/media/equipment/EQ-CAM-001");
    /* Open a drawer through the page's own control if present; otherwise drive
       openDrawer directly — the engine, not the caller, is under test. */
    await page.evaluate(`openDrawer('<div class="dr-head"><h2>Detail</h2></div><div class="dr-body">x</div>')`);
    await expect(page.locator("#drawer")).toHaveClass(/\bon\b/);
    expect(await appInert(page)).toBe(true);
    const before = await hash(page);
    await page.goBack();
    await expect(page.locator("#drawer")).not.toHaveClass(/\bon\b/);
    expect(await appInert(page)).toBe(false);
    expect(await hash(page)).toBe(before);
  });
});

test.describe("modal shape", () => {
  test("a form is full-screen; a prompt is a sheet", async ({ page }) => {
    await bootStaff(page, "employee");
    await go(page, "#/media/my-day");
    await page.click("#mobilebar .fab");                 // Log task has inputs
    await expect(page.locator("#modal-layer")).toHaveAttribute("data-mkind", "full");
    await page.goBack();
    await page.evaluate(`modal('<div class="mo-head"><h2>Sure?</h2></div><div class="mo-body">No inputs here</div>')`);
    await expect(page.locator("#modal-layer")).toHaveAttribute("data-mkind", "sheet");
  });

  test("a form does not autofocus a field (no keyboard on open)", async ({ page }) => {
    await bootStaff(page, "employee");
    await go(page, "#/media/my-day");
    await page.click("#mobilebar .fab");
    const focused = await page.evaluate(() => document.activeElement?.tagName);
    expect(["DIV", "BODY"], "a field grabbed focus and would pop the keyboard").toContain(focused);
  });

  test("a close button is injected when the head lacks one, and left alone when present", async ({ page }) => {
    await bootStaff(page, "employee");
    /* A modal whose head has no control of its own gets a Close injected. */
    await page.evaluate(`modal('<div class="mo-head"><h2>Plain</h2></div><div class="mo-body"><input></div>')`);
    await expect(page.locator('#modal-layer .mo-head [aria-label="Close"]')).toBeVisible();
    await page.click('#modal-layer .mo-head [aria-label="Close"]');
    await expect(page.locator("#modal-layer")).not.toHaveClass(/\bon\b/);
    /* Log task ships its own close, so exactly one control sits in its head. */
    await go(page, "#/media/my-day");
    await page.click("#mobilebar .fab");
    expect(await page.locator("#modal-layer .mo-head .icon-btn").count(),
      "the task-log head has more than one close control").toBe(1);
  });

  /* The layer is a grid; an auto row grows with its content, so a long form
     (Add member, Equipment permissions) used to be as tall as its content and
     pushed its own Save button below the screen, where nothing could scroll to
     it. The body must scroll instead, under a footer that stays put. */
  test("a long form keeps its footer on the screen and scrolls its body instead", async ({ page }) => {
    await bootStaff(page, "employee");
    for (const kind of ["full", "sheet"] as const) {
      /* Closed with Back, as a person would: a modal closed in code pops its
         history entry asynchronously, and that pop would close the next one. */
      if (kind === "sheet") {
        await page.goBack();
        await expect(page.locator("#modal-layer")).not.toHaveClass(/\bon\b/);
      }
      await page.evaluate((k) => {
        const w = window as unknown as { modal: (h: string) => void };
        w.modal(`<div class="mo-head"><h2>Long</h2></div><div class="mo-body">${
          '<p style="height:60px;margin:0">row</p>'.repeat(60)}${k === "full" ? "<input>" : ""}</div>
          <div class="mo-foot"><button class="btn primary">Save</button></div>`);
      }, kind);
      await expect(page.locator("#modal-layer")).toHaveAttribute("data-mkind", kind);
      /* A sheet slides up from below; measure where it comes to rest. */
      await page.locator("#modal-layer .modal").evaluate((el) =>
        Promise.all(el.getAnimations().map((a) => a.finished)));
      const m = await page.evaluate(() => {
        const foot = document.querySelector("#modal-layer .mo-foot")!.getBoundingClientRect();
        const body = document.querySelector("#modal-layer .mo-body") as HTMLElement;
        return { bottom: foot.bottom, vh: innerHeight, scrolls: body.scrollHeight > body.clientHeight };
      });
      expect(m.bottom, `${kind}: the footer is below the screen`).toBeLessThanOrEqual(m.vh + 0.5);
      expect(m.scrolls, `${kind}: the body grew instead of scrolling`).toBe(true);
    }
  });
});

test("the Escape chain calls Back at most once (route unchanged)", async ({ page }) => {
  await bootStaff(page, "admin");
  await go(page, "#/media/projects");
  const before = await hash(page);
  await page.click("#btn-msearch");                      // palette open
  await expect(page.locator("#palette")).toHaveClass(/\bon\b/);
  await page.keyboard.press("Escape");                   // runs closePalette+closeModal+closeDrawer+closeMenu
  await expect(page.locator("#palette")).not.toHaveClass(/\bon\b/);
  expect(await hash(page), "the Escape chain navigated off the route").toBe(before);
});

test("a closed drawer is inert and hidden from assistive tech, on desktop too", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await bootStaff(page, "admin");
  /* Never opened yet: still fine to be inert. Open then close, then assert. */
  await page.evaluate(`openDrawer('<div class="dr-head"><h2>D</h2></div>'); closeDrawer();`);
  await expect(page.locator("#drawer")).toHaveAttribute("inert", "");
  await expect(page.locator("#drawer")).toHaveAttribute("aria-hidden", "true");
});

test.describe("overlays do not overflow the narrowest phone", () => {
  test.use({ viewport: { width: 320, height: 568 } });
  const overflowIn = (p: Page, sel: string) => p.evaluate((s) => {
    const root = document.querySelector(s); if (!root) return ["no root"];
    const W = innerWidth, bad: string[] = [];
    for (const el of root.querySelectorAll("*")) {
      const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
      if (r.width < 1 || cs.display === "none" || cs.visibility === "hidden") continue;
      let scroller = false;
      for (let a = el.parentElement; a && a !== root; a = a.parentElement) {
        const ox = getComputedStyle(a).overflowX; if (ox === "auto" || ox === "scroll") { scroller = true; break; }
      }
      if ((r.right > W + 1 || r.left < -1) && !scroller) bad.push(el.tagName.toLowerCase() + "." + [...el.classList].slice(0, 2).join("."));
    }
    return bad;
  }, sel);

  test("the task-log modal", async ({ page }) => {
    await bootStaff(page, "employee");
    await go(page, "#/media/my-day");
    await page.click("#mobilebar .fab");
    await page.waitForTimeout(320);
    expect(await overflowIn(page, "#modal-layer")).toEqual([]);
  });

  test("the profile modal", async ({ page }) => {
    await bootStaff(page, "admin");
    await page.click("#btn-role");
    await page.waitForTimeout(320);
    expect(await overflowIn(page, "#modal-layer")).toEqual([]);
  });

  test("a detail drawer", async ({ page }) => {
    await bootStaff(page, "admin");
    await go(page, "#/media/equipment/EQ-CAM-001");
    await page.evaluate(`openDrawer('<div class="dr-head"><h2>Booking detail for EQ-CAM-001</h2></div><div class="dr-body"><p>'+('long '.repeat(60))+'</p></div>')`);
    await page.waitForFunction(() => getComputedStyle(document.querySelector("#drawer")!).transform === "matrix(1, 0, 0, 1, 0, 0)");
    expect(await overflowIn(page, "#drawer")).toEqual([]);
  });
});
