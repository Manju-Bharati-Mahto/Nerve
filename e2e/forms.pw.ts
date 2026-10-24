/* ═══════════════════════════════════════════════════════════════════════════
   P6 — forms on a phone.

   Text at 16px so iOS does not zoom the page when a field is focused; controls
   at a thumb's size; field pairs that stack instead of crushing; a filter search
   that keeps focus and the caret while you type; keyboard hints per field.
   ═══════════════════════════════════════════════════════════════════════════ */
import { test, expect, devices, type Page } from "@playwright/test";
import { bootStaff, go } from "./harness";

const { defaultBrowserType: _b, ...PHONE } = devices["iPhone 13"];
test.use(PHONE);

const openTaskLog = async (page: Page) => {
  await bootStaff(page, "employee");
  await go(page, "#/media/my-day");
  await page.click("#mobilebar .fab");
  await expect(page.locator("#modal-layer")).toHaveClass(/\bon\b/);
};

test("every field in a form is at least 16px, so iOS does not zoom on focus", async ({ page }) => {
  await openTaskLog(page);
  const small = await page.evaluate(() =>
    [...document.querySelectorAll("#modal-layer input, #modal-layer select, #modal-layer textarea")]
      .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
      .map((el) => ({ t: (el as HTMLElement).tagName, px: parseFloat(getComputedStyle(el).fontSize) }))
      .filter((x) => x.px < 16));
  expect(small, "fields below 16px would trigger iOS zoom-on-focus").toEqual([]);
});

test("text and select fields are a thumb's height", async ({ page }) => {
  await openTaskLog(page);
  /* Measured from the applied CSS box, not getBoundingClientRect: at deviceScale
     3 the rect snaps a 44px control to ~42.7, an emulation artifact, while the
     box the finger hits is the CSS 44px. */
  const short = await page.evaluate(() =>
    [...document.querySelectorAll("#modal-layer input:not([type=checkbox]):not([type=radio]), #modal-layer select")]
      .filter((el) => (el as HTMLElement).offsetParent !== null)
      .map((el) => ({ id: (el as HTMLInputElement).id || el.tagName, h: parseFloat(getComputedStyle(el).height) }))
      .filter((x) => x.h < 44));
  expect(short).toEqual([]);
});

test("a two-field row stacks rather than crushing on a narrow phone", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await openTaskLog(page);
  /* Start and End sit in one .row; on a 320 phone they should be on two lines. */
  const stacked = await page.evaluate(() => {
    const start = document.querySelector("#tl-start")?.getBoundingClientRect();
    const end = document.querySelector("#tl-end")?.getBoundingClientRect();
    if (!start || !end) return "fields not found";
    return end.top >= start.bottom - 2;   // end is below start, not beside it
  });
  expect(stacked).toBe(true);
});

test("the Drive-link field asks for a URL keyboard, without changing its type", async ({ page }) => {
  await openTaskLog(page);
  /* Log a task takes the link through Submit for review, which opens over it:
     link a deliverable this person can submit, then open that form. */
  const did = await page.evaluate(() => {
    const sel = document.getElementById("tl-deliv") as HTMLSelectElement;
    const ps = document.getElementById("tl-project") as HTMLSelectElement;
    for (const p of [...ps.options]) {
      ps.value = p.value; ps.dispatchEvent(new Event("change"));
      const o = [...sel.options].find((x) => x.value && (window as any).eval(`canSubmitVersion(deliv(${+x.value}))`));
      if (o) { sel.value = o.value; sel.dispatchEvent(new Event("change")); return +o.value; }
    }
    return 0;
  });
  expect(did, "a deliverable the employee can submit").toBeGreaterThan(0);
  await page.click("#tl-submit");
  const link = page.locator("#sv-layer #sv-url");
  await expect(link).toHaveAttribute("inputmode", "url");
  await expect(link).toHaveAttribute("autocapitalize", "off");
  /* Type is untouched, so validation is exactly as on desktop. */
  expect(await link.evaluate((el: HTMLInputElement) => el.type)).not.toBe("url");
});

test("a number field asks for a numeric keyboard", async ({ page }) => {
  await openTaskLog(page);
  await expect(page.locator("#tl-qty")).toHaveAttribute("inputmode", "numeric");
});

test("a filter search keeps focus and caret while you type", async ({ page }) => {
  await bootStaff(page, "coordinator");
  await go(page, "#/media/requests");
  const box = page.locator("#req-q");
  await box.click();
  /* Type character by character; before the fix, the re-render dropped focus
     after the first one and the rest were lost. */
  await page.keyboard.type("conv", { delay: 30 });
  await expect(box).toBeFocused();
  await expect(box).toHaveValue("conv");
});

test("the blocker note is validated inline, not by a toast", async ({ page }) => {
  await openTaskLog(page);
  /* A valid form except the blocked-note, driven in-page so no field-order or
     actionability detail can mask the check under test. */
  await page.evaluate(() => {
    const set = (id: string, v: string) => { const e = document.getElementById(id) as HTMLInputElement; if (e) e.value = v; };
    set("tl-desc", "Waiting on the venue"); set("tl-start", "09:00"); set("tl-end", "10:00"); set("tl-blocknote", "");
    (document.querySelector("#tl-status [data-st=blocked]") as HTMLElement).click();
    (document.querySelector("#modal-layer [data-act=saveTask]") as HTMLElement).click();
  });
  await expect(page.locator("#modal-layer .field-err")).toBeVisible();
  await expect(page.locator("#tl-blocknote")).toHaveAttribute("aria-invalid", "true");
});
