/* ═══════════════════════════════════════════════════════════════════════════
   E2E HARNESS — the real Media Ops document, in a real browser, with no server.

   WHY IT IS BUILT THIS WAY. The mobile work is judged by two questions that
   jsdom cannot answer, because jsdom has no layout: does anything overflow a
   phone, and did the desktop change at all. Both need Chromium. Neither needs
   a server — and a server would make every answer depend on whatever the dev
   database holds that day.

   So the page is loaded from disk onto a fake origin, and every API request is
   refused. Offline, Media Ops boots its own prototype department: a fixed
   roster, seeded by a fixed PRNG. With the clock pinned too, the same route
   renders the same pixels on every run, which is what makes a 0-pixel desktop
   baseline meaningful.

   Staff roles come from switching the signed-in seed user. The Creator Network
   has no seed, so its shell is fed a scripted /creator/state per creator role,
   the same shapes the jsdom suites use.
   ═══════════════════════════════════════════════════════════════════════════ */
import { readFileSync, existsSync } from "node:fs";
import { join, normalize, extname } from "node:path";
import type { Page, Route } from "@playwright/test";

export const ORIGIN = "http://nerve.test";
const ROOT = join(process.cwd(), "public", "media-ops");
/* A Thursday during term. Every relative date on every page derives from it. */
export const FIXED_NOW = new Date("2026-09-24T10:00:00+05:30");

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json", ".png": "image/png",
  ".json": "application/json", ".css": "text/css", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8",
};

export type Staff = "admin" | "team_lead" | "coordinator" | "employee";
export type CreatorMode = "creator" | "team_lead" | "creator_admin";

/* Seed users who hold each role in the prototype department. The prototype
   has no coordinator, so one employee is relabelled — role() is read from the
   user row, and every coordinator branch keys off it. */
const SEED: Record<Staff, { id: number; relabel?: string }> = {
  admin: { id: 1 }, team_lead: { id: 2 }, employee: { id: 4 },
  coordinator: { id: 17, relabel: "coordinator" },
};

/* A fulfilled response the browser is allowed to cache can be served from the
   memory cache on a later request for the same URL — and a cache hit never
   reaches the route handler. That silently broke every test that boots two
   viewers in one page: the second boot got the FIRST one's /creator/state, so
   three creator modes all resolved to 'self' and the lead/manage screens went
   unmeasured while the suite still passed. Nothing here may be cached. */
const NO_STORE = { "cache-control": "no-store, max-age=0" };

function serveFile(route: Route, pathname: string) {
  const rel = pathname.slice("/api/media-ops/".length) || "index.html";
  const file = normalize(join(ROOT, rel));
  if (!file.startsWith(ROOT) || !existsSync(file)) return route.fulfill({ status: 404, body: "" });
  return route.fulfill({
    status: 200, body: readFileSync(file),
    contentType: TYPES[extname(file)] ?? "application/octet-stream",
    headers: NO_STORE,
  });
}

function creatorState(mode: CreatorMode) {
  const base = {
    profile: {
      user_id: `e2e-${mode}`, full_name: "Misha Patel", display_name: "Misha Patel",
      email: "m@x.invalid", creator_role: mode, status: "active",
      joined_on: "2026-01-01", team: { id: 1, name: "Reels Squad" }, lead: null,
    },
    me: { id: `e2e-${mode}` },
    teams: [{ id: 1, name: "Reels Squad", member_count: 5, lead: null, is_active: true }],
  };
  if (mode === "creator") return { ...base, scope: "self", can_manage_network: false };
  if (mode === "team_lead")
    return { ...base, scope: "team", can_manage_network: false,
             counts: { active: 4, inactive: 0, suspended: 1, archived: 0 } };
  return { ...base, scope: "all", can_manage_network: true,
           counts: { active: 12, inactive: 0, suspended: 1, archived: 0 } };
}

async function ready(page: Page) {
  await page.waitForFunction(
    () => (document.querySelector("#page")?.innerHTML.length ?? 0) > 200, null, { timeout: 20_000 });
  /* Toasts appear and fade on timers, so whether one is still on screen at the
     moment of a screenshot varies run to run. Masking the container is not
     enough — its box changes size with the number of toasts, so the mask moves.
     Hidden outright; they are not what the desktop gate protects. */
  await page.addStyleTag({ content: "#toasts{display:none!important}" });
}

/** Boot as Media Ops staff on the offline seed department. */
export async function bootStaff(page: Page, role: Staff, hash = "#/media/home") {
  await page.clock.setFixedTime(FIXED_NOW);
  await page.route(`${ORIGIN}/**`, (route) => {
    const p = new URL(route.request().url()).pathname;
    if (p.startsWith("/api/media-ops/")) return serveFile(route, p);
    return route.abort("internetdisconnected");   // offline ⇒ the seed department
  });
  await page.goto(`${ORIGIN}/api/media-ops/index.html${hash}`);
  await ready(page);
  const s = SEED[role];
  /* Always set S.me, even for the admin at id 1: a prior in-page role switch in
     the same worker can survive a same-URL reload, so relying on the seed
     default is not safe. */
  await page.evaluate(`(()=>{const u=DB.users.find(x=>x.id===${s.id});
    if(!u) throw new Error('no seed user ${s.id}');
    ${s.relabel ? `u.role='${s.relabel}';` : ""}
    S.me=${s.id}; render();})()`);
  const actual = await page.evaluate("role()");
  if (actual !== role) throw new Error(`booted as ${actual}, wanted ${role}`);
}

/** Boot as a Creator Network member: the creator-only shell, scripted state. */
export async function bootCreator(page: Page, mode: CreatorMode) {
  await page.clock.setFixedTime(FIXED_NOW);
  await page.route(`${ORIGIN}/**`, (route) => {
    const p = new URL(route.request().url()).pathname;
    if (p.startsWith("/api/media-ops/")) return serveFile(route, p);
    const json = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: "application/json",
                      body: JSON.stringify(body), headers: NO_STORE });
    if (p.endsWith("/api/v1/media/state")) return json(403, { message: "Media Ops is not available for your role." });
    if (p.endsWith("/creator/state")) return json(200, creatorState(mode));
    if (p.startsWith("/api/")) return json(200, {});
    return route.abort("internetdisconnected");
  });
  /* goto() to a URL that differs only after the '#' is a FRAGMENT navigation:
     the document is not re-executed, so hydrateCreatorShell never re-runs and
     the shell keeps the previous viewer. Landing on about:blank first forces a
     real document load, so each boot starts from nothing. */
  await page.goto("about:blank");
  await page.goto(`${ORIGIN}/api/media-ops/index.html?as=creator#/media/creator`);
  await ready(page);
  /* The shell must have resolved to THIS viewer's mode. bootStaff has always
     checked its role; this check is here because its absence hid the caching
     bug above for three phases. */
  const want = mode === "creator" ? "self" : mode === "team_lead" ? "lead" : "manage";
  const got = await page.evaluate("cnMode()");
  if (got !== want) throw new Error(`booted creator mode ${got}, wanted ${want}`);
}

/* Parameterised routes need a value the seed actually has. */
const PROJECT_TABS = ["deliverables", "shoots", "equipment", "activity", "comments"];
const ADMIN_SECTIONS = ["lookups", "types", "templates", "automations", "inspection",
                        "users", "permissions", "audit", "settings"];
/* Routes that leave the app or only redirect — nothing of their own to render. */
const SKIP = new Set(["#/media/tv", "#/media/smc/my-day"]);

/** Every staff route the router serves, as concrete hashes. */
export async function staffRoutes(page: Page): Promise<string[]> {
  const sources = await page.evaluate("ROUTES.map(([re])=>re.source)") as string[];
  const reports = await page.evaluate(
    "typeof ANALYTICS_REPORTS!=='undefined'?ANALYTICS_REPORTS.map(r=>r[0]):[]") as string[];
  const out: string[] = [];
  for (const src of sources) {
    const plain = src.replace(/^\^/, "").replace(/\$$/, "").replace(/\\\//g, "/");
    if (!plain.includes("(")) { out.push(plain); continue; }
    if (plain === "#/media/projects/(\\d+)") out.push("#/media/projects/1");
    else if (plain.startsWith("#/media/projects/(\\d+)/")) PROJECT_TABS.forEach((t) => out.push(`#/media/projects/1/${t}`));
    else if (plain.startsWith("#/media/reports/")) out.push("#/media/reports/2026-09-23");
    else if (plain.startsWith("#/media/equipment/")) out.push("#/media/equipment/EQ-CAM-001");
    else if (plain.startsWith("#/media/team/")) out.push("#/media/team/2");
    else if (plain.startsWith("#/media/analytics/")) reports.forEach((k) => out.push(`#/media/analytics/${k}`));
    else if (plain.startsWith("#/media/admin/")) ADMIN_SECTIONS.forEach((k) => out.push(`#/media/admin/${k}`));
    /* #/media/creator/(slug) is covered by the creator boots. */
  }
  return [...new Set(out)].filter((r) => !SKIP.has(r));
}

/** Every Creator Network page this viewer's shell offers. */
export async function creatorRoutes(page: Page): Promise<string[]> {
  return await page.evaluate("cnItems().map(cnRoute)") as string[];
}

/** Go to a route the way the sidebar does. Returns where the app actually landed. */
export async function go(page: Page, hash: string): Promise<string> {
  await page.evaluate(`location.hash=${JSON.stringify(hash)}`);
  await page.evaluate("render()");
  /* Offline panels resolve their failed fetch on the next tick and re-render. */
  await page.waitForTimeout(60);
  return await page.evaluate("location.hash") as string;
}

export const slug = (hash: string) => hash.replace(/^#\/media\/?/, "").replace(/[^\w-]+/g, "_") || "root";
