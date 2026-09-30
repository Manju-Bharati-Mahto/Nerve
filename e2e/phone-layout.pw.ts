/* ═══════════════════════════════════════════════════════════════════════════
   P7 — the gate that keeps phone layout honest.

   The phone report (phone-report.pw.ts) MEASURES; this file ENFORCES. As of P7
   no screen, for any role, at any phone width, pushes content past the edge.
   From here that is a requirement, not a score: a new screen or a widened table
   that breaks it fails the build rather than quietly regressing the report.
   ═══════════════════════════════════════════════════════════════════════════ */
import { test, expect, devices } from "@playwright/test";
import { bootStaff, bootCreator, staffRoutes, creatorRoutes, go, type Staff, type CreatorMode } from "./harness";
import { scanPhone } from "./measure";

const { defaultBrowserType: _b, ...PHONE } = devices["iPhone 13"];
test.use(PHONE);

/* 320 is the hard case (iPhone SE 1st gen, small Androids); 430 the widest. */
const WIDTHS: Array<[number, number]> = [[320, 568], [375, 812], [430, 932]];
const STAFF: Staff[] = ["admin", "team_lead", "coordinator", "employee"];
const CREATORS: CreatorMode[] = ["creator", "team_lead", "creator_admin"];

for (const [width, height] of WIDTHS) {
  test(`nothing overflows at ${width}px — staff`, async ({ page }) => {
    test.setTimeout(5 * 60_000);
    await page.setViewportSize({ width, height });
    const bad: string[] = [];
    for (const role of STAFF) {
      await page.unrouteAll({ behavior: "ignoreErrors" });
      await bootStaff(page, role);
      for (const r of await staffRoutes(page)) {
        await go(page, r);
        const s = await scanPhone(page);
        if (s.offenders || s.contentOverflow)
          bad.push(`${role} ${r}: ${s.offenders} past the edge (${s.worst.map((w) => `${w.el} +${w.past}px`).join(", ")})`);
      }
    }
    expect(bad).toEqual([]);
  });

  test(`nothing overflows at ${width}px — creators`, async ({ page }) => {
    test.setTimeout(3 * 60_000);
    await page.setViewportSize({ width, height });
    const bad: string[] = [];
    for (const mode of CREATORS) {
      await page.unrouteAll({ behavior: "ignoreErrors" });
      await bootCreator(page, mode);
      for (const r of await creatorRoutes(page)) {
        await go(page, r);
        const s = await scanPhone(page);
        if (s.offenders || s.contentOverflow)
          bad.push(`creator:${mode} ${r}: ${s.offenders} past the edge (${s.worst.map((w) => `${w.el} +${w.past}px`).join(", ")})`);
      }
    }
    expect(bad).toEqual([]);
  });
}

test("stat tiles sit two per row, not one or four", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await bootStaff(page, "admin");
  await go(page, "#/media/home");
  const perRow = await page.evaluate(() => {
    const tiles = [...document.querySelectorAll("#page .grid > .stat, #page .grid > button.stat")];
    if (tiles.length < 4) return 0;
    const top = tiles[0].getBoundingClientRect().top;
    return tiles.filter((t) => Math.abs(t.getBoundingClientRect().top - top) < 2).length;
  });
  expect(perRow).toBe(2);
});

/* Overflow alone is a gameable metric: breaking every word mid-character drives
   it to zero while making the screen unreadable. P7 did exactly that, and the
   Pipeline tiles rendered "In flight / 45" as "In fligh t" over a two-line
   "4 5" while the gate reported success. A number must never wrap. */
test("a stat number never breaks across lines, on any screen", async ({ page }) => {
  test.setTimeout(3 * 60_000);
  await page.setViewportSize({ width: 320, height: 568 });
  const broken: string[] = [];
  for (const role of STAFF) {
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await bootStaff(page, role);
    for (const r of await staffRoutes(page)) {
      await go(page, r);
      const wrapped = await page.evaluate(() =>
        [...document.querySelectorAll("#page .stat-val")]
          .filter((el) => (el as HTMLElement).offsetParent !== null)
          /* One line box per element: more than one means the value wrapped. */
          .filter((el) => el.getClientRects().length > 1)
          .map((el) => (el.textContent || "").trim().slice(0, 30)));
      broken.push(...wrapped.map((t) => `${role} ${r}: "${t}"`));
    }
  }
  expect(broken).toEqual([]);
});

test("a dense table scrolls inside itself rather than stretching the page", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await bootStaff(page, "admin");
  await go(page, "#/media/admin/audit");
  const ok = await page.evaluate(() => {
    const t = document.querySelector("#page table.tbl") as HTMLElement | null;
    if (!t) return "no table";
    return getComputedStyle(t).overflowX === "auto" && t.getBoundingClientRect().width <= innerWidth + 1;
  });
  expect(ok).toBe(true);
});
