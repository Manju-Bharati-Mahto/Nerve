import { defineConfig } from "@playwright/test";

/* Browser tests for the Media Ops presentation layer (e2e/*.pw.ts).
   Kept apart from vitest by name: vitest only reads src/** and server/**,
   and Playwright only reads *.pw.ts, so neither runner picks up the other. */
export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.pw.ts",
  /* Each file shares state across its tests (one report, one fingerprint set),
     so files run whole in one worker; different files still run in parallel. */
  fullyParallel: false,
  retries: 0,
  reporter: [["list"]],
  snapshotPathTemplate: "{testDir}/__screenshots__/{arg}{ext}",
  expect: { toHaveScreenshot: { maxDiffPixels: 0 } },
  use: {
    browserName: "chromium",
    /* A cached service worker would serve yesterday's bundle to today's test. */
    serviceWorkers: "block",
    locale: "en-IN",
    timezoneId: "Asia/Kolkata",
  },
});
