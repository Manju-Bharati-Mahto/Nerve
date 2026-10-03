/* ═══════════════════════════════════════════════════════════════════════════
   DESKTOP REGRESSION GATE — the promise that the phone layer changes nothing
   on desktop, checked rather than asserted.

   Two baselines, both taken from the commit before any mobile work:

   1. MARKUP FINGERPRINTS, committed (e2e/baselines/desktop-dom.json): one hash
      per role × route of the rendered page and chrome. Small, reviewable, and
      it sees everything below the fold.

   2. PIXELS, local only (e2e/__screenshots__, gitignored): the viewport of every
      route at five desktop widths, 0 pixels of tolerance. ~200 PNGs are too
      heavy for the repository; regenerate them on any machine by checking out
      the P0 commit and running `npm run test:e2e:baseline`.

   Record a new fingerprint baseline with E2E_UPDATE=1. A change here is only
   acceptable when it is a desktop change somebody asked for.
   ═══════════════════════════════════════════════════════════════════════════ */
import { test, expect } from "@playwright/test";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { bootStaff, staffRoutes, go, slug, type Staff } from "./harness";
import { desktopFingerprint } from "./measure";

const FP_FILE = "e2e/baselines/desktop-dom.json";
const ROLES: Staff[] = ["admin", "team_lead", "coordinator", "employee"];
const UPDATE = process.env.E2E_UPDATE === "1";

test.describe("desktop markup is unchanged", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("fingerprint every route for every staff role", async ({ page }) => {
    test.setTimeout(10 * 60_000);
    const got: Record<string, string> = {};
    for (const role of ROLES) {
      await page.unrouteAll({ behavior: "ignoreErrors" });
      await bootStaff(page, role);
      for (const r of await staffRoutes(page)) {
        const landed = await go(page, r);
        got[`${role} ${r}${landed !== r ? ` -> ${landed}` : ""}`] = await desktopFingerprint(page);
      }
    }
    if (UPDATE || !existsSync(FP_FILE)) {
      mkdirSync("e2e/baselines", { recursive: true });
      writeFileSync(FP_FILE, JSON.stringify(got, null, 1) + "\n");
      test.info().annotations.push({ type: "baseline", description: `recorded ${Object.keys(got).length} fingerprints` });
      return;
    }
    const want = JSON.parse(readFileSync(FP_FILE, "utf8")) as Record<string, string>;
    const changed = Object.keys(want).filter((k) => got[k] !== want[k]);
    const added = Object.keys(got).filter((k) => !(k in want));
    expect({ changed, added }, "desktop markup differs from the P0 baseline").toEqual({ changed: [], added: [] });
  });
});

for (const [width, height] of [[1440, 900], [1280, 800], [1024, 768], [821, 900], [800, 900]] as const) {
  test.describe(`desktop pixels at ${width}`, () => {
    test.use({ viewport: { width, height } });

    test(`admin, every route, ${width}×${height}`, async ({ page }) => {
      test.setTimeout(10 * 60_000);
      await bootStaff(page, "admin");
      for (const r of await staffRoutes(page)) {
        await go(page, r);
        await expect.soft(page, r).toHaveScreenshot(`${width}-${slug(r)}.png`, {
          maxDiffPixels: 0, animations: "disabled", caret: "hide",
        });
      }
    });
  });
}
