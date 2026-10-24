/* ═══════════════════════════════════════════════════════════════════════════
   Crew workflow on a phone — what a live run found covered or cut off.

   Home's Pending approvals dropped the project column and clipped Review to
   "Revi", so two "Story / Post v1" rows could only be told apart by date. And
   the start-up "Live · …" toast sat on top of the board's move sheet, over
   Open project, until it faded.
   ═══════════════════════════════════════════════════════════════════════════ */
import { test, expect, devices } from "@playwright/test";
import { bootStaff, go } from "./harness";

const { defaultBrowserType: _b, ...PHONE } = devices["iPhone 13"];
test.use(PHONE);

test("Pending approvals keeps each row's project and a whole Review button", async ({ page }) => {
  await bootStaff(page, "team_lead");
  await go(page, "#/media/home");
  const rows = await page.evaluate(() =>
    [...document.querySelectorAll("#page .card")].filter((c) => c.querySelector("h3")?.textContent === "Pending Approvals")
      .flatMap((c) => [...c.querySelectorAll("tbody tr[data-drawer]")]).slice(0, 4).map((tr) => {
      const card = tr.getBoundingClientRect();
      const proj = tr.querySelector("td.hide-sm") as HTMLElement;
      const btn = (tr.querySelector('td[data-m="actions"] button') as HTMLElement).getBoundingClientRect();
      return { project: proj.offsetParent !== null ? proj.innerText.trim() : "",
               btnInside: btn.left >= card.left - 0.5 && btn.right <= card.right + 0.5 && btn.right <= innerWidth,
               btnW: btn.width };
    }));
  expect(rows.length, "the seed has versions waiting on a Team Lead").toBeGreaterThan(0);
  for (const r of rows) {
    expect(r.project).not.toBe("");
    expect(r.btnInside).toBe(true);
    expect(r.btnW).toBeGreaterThan(60);
  }
});

test("the board's move sheet clears a passing toast before it rises", async ({ page }) => {
  await bootStaff(page, "admin");
  await go(page, "#/media/pipeline");
  /* Toast and tap in one turn, so the toast's own two seconds cannot be what
     clears it. */
  const left = await page.evaluate(() => {
    (window as unknown as { toast: (...a: unknown[]) => void })
      .toast("Live · 3 projects and 9 daily reports from the server. Signed in as Admin.", "ok", null, { passing: true });
    const before = document.querySelectorAll("#toasts [data-passing]").length;
    (document.querySelector("#page .kb-card .kc-move") as HTMLElement).click();
    return { before, sheet: !!document.querySelector(".menu.as-sheet"),
             after: document.querySelectorAll("#toasts [data-passing]").length };
  });
  expect(left).toEqual({ before: 1, sheet: true, after: 0 });
});
