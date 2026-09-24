/* ═══════════════════════════════════════════════════════════════════════════
   UI REGRESSION — what a Creator Network member actually sees.

   The reported bug was visual: the right records existed and the right API
   answered, and the browser still showed a Knowledge Hub page with an empty
   middle. So asserting a 200 proves nothing here. This file boots the REAL
   Media Ops page — public/media-ops/index.html, the same file the server
   serves — inside jsdom, answers its fetches with the shapes the live server
   returns for each role, and then reads the rendered DOM.

   The payload shapes below were captured from a live signed-in session, one
   per role: scope 'all' / 'team' / 'self', can_manage_network true / false /
   false, and a 403 for a suspended member.
   ═══════════════════════════════════════════════════════════════════════════ */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const HTML = readFileSync("public/media-ops/index.html", "utf8");

type Role = "creator_admin" | "team_lead" | "creator";

/** The creator-scoped state, as the server sends it. */
function creatorState(role: Role) {
  const base = {
    profile: {
      user_id: `ui-${role}`, full_name: "Test Person", display_name: "Test Person",
      email: "t@x.invalid", creator_role: role, status: "active",
      joined_on: "2026-01-01", team: { id: 1, name: "Reels Squad" }, lead: null,
    },
    me: { id: `ui-${role}` },
    teams: [{ id: 1, name: "Reels Squad", member_count: 5, lead: null, is_active: true }],
  };
  if (role === "creator") return { ...base, scope: "self", can_manage_network: false };
  if (role === "team_lead")
    return { ...base, scope: "team", can_manage_network: false,
             counts: { active: 4, inactive: 0, suspended: 1, archived: 0 } };
  return { ...base, scope: "all", can_manage_network: true,
           teams: [...base.teams, { id: 2, name: "Campus Stories", member_count: 5, lead: null, is_active: true }],
           counts: { active: 12, inactive: 0, suspended: 1, archived: 0 } };
}

/** Boot the real page with a scripted server behind it. */
async function boot(opts: { role?: Role; creatorStateStatus?: number; search?: string }) {
  const { role, creatorStateStatus = 200, search = "?as=creator" } = opts;
  const dom = new JSDOM(HTML, {
    url: `http://localhost/api/media-ops/${search}#/media/creator`,
    runScripts: "dangerously", pretendToBeVisual: true,
  });
  const w = dom.window as unknown as Window & typeof globalThis;

  (w as unknown as { fetch: unknown }).fetch = async (input: RequestInfo | URL) => {
    const url = String(input);
    const reply = (status: number, body: unknown) =>
      ({ ok: status < 400, status, json: async () => body }) as Response;
    // A creator has no Media Ops state — the server refuses it. Always.
    if (url.includes("/api/v1/media/state"))
      return reply(403, { message: "Media Ops is not available for your role." });
    if (url.includes("/creator/state")) {
      if (creatorStateStatus !== 200)
        return reply(creatorStateStatus, { message: "Your Creator Network membership is not active." });
      return reply(200, creatorState(role!));
    }
    return reply(200, {});
  };

  // Let boot()'s awaits settle, then the render it schedules.
  await new Promise((r) => setTimeout(r, 60));
  return dom;
}

/* #app, not body: jsdom counts <script> source in body.textContent, so a
   phrase that appears in the page's own code would match a search for rendered
   text. The app container holds what a person actually sees. */
const text = (dom: JSDOM) => dom.window.document.getElementById("app")?.textContent ?? "";
/* The Creator Network's own navigation, as rendered into the Media Ops
   sidebar. This replaced a horizontal tab bar: the assertions below are the
   same assertions, asked of the surface that now carries the navigation. */
const cnNav = (dom: JSDOM) =>
  [...dom.window.document.querySelectorAll("#nav .nav-item")].map((n) => n.textContent?.trim());
/* Nothing should render a tab bar inside the Creator Network any more. */
const tabBars = (dom: JSDOM) => dom.window.document.querySelectorAll(".tabs .tab").length;

describe("the application a Creator Network member lands in", () => {
  let admin: JSDOM, lead: JSDOM, creator: JSDOM;
  beforeAll(async () => {
    admin = await boot({ role: "creator_admin" });
    lead = await boot({ role: "team_lead" });
    creator = await boot({ role: "creator" });
  }, 30_000);

  it("is the Nerve Media Ops shell, not the Knowledge Hub", () => {
    for (const dom of [admin, lead, creator]) {
      const brand = dom.window.document.querySelector(".brand-txt")?.textContent ?? "";
      expect(brand).toContain("NERVE");
      expect(brand).toContain("Media Ops");
      expect(text(dom)).not.toContain("Knowledge Hub");
    }
  });

  it("opens on the Creator Network, with no Media Ops data behind it", () => {
    for (const dom of [admin, lead, creator]) {
      expect(dom.window.location.hash).toBe("#/media/creator");
      // The seed department must never appear — that was the old fallback.
      expect(text(dom)).not.toContain("Running on seed data");
    }
  });

  it("shows the Creator Network and no other Media Ops module in the sidebar", () => {
    for (const dom of [admin, lead, creator]) {
      const nav = dom.window.document.getElementById("nav")?.textContent ?? "";
      // Their own Creator pages, and the group that names the module.
      expect(nav).toContain("Assistant");
      for (const other of ["Equipment", "Leave", "KRA", "Projects"]) expect(nav).not.toContain(other);
    }
  });
});

describe("each role gets its own navigation", () => {
  it("CREATOR ADMIN — the management pages, money included", async () => {
    const dom = await boot({ role: "creator_admin" });
    expect(cnNav(dom)).toEqual(["Overview", "Creators", "Teams", "Events", "Tasks", "Review",
      "Points", "Payouts", "Recognition", "Analytics", "Assistant"]);
    // The management actions are theirs alone, and sit in the page header.
    expect(text(dom)).toContain("Creator Management");
    const acts = [...dom.window.document.querySelectorAll("[data-act]")].map((n) => n.getAttribute("data-act"));
    expect(acts).toContain("crNewCreator");
  });

  it("TEAM LEAD — team pages, and NO payouts or network directory", async () => {
    const dom = await boot({ role: "team_lead" });
    const t = cnNav(dom);
    expect(t).toEqual(["Assistant", "My Team", "Opportunities", "My Tasks", "Review",
      "Leaderboard", "War Zone", "Achievements", "Team Analytics", "My Analytics",
      "My Points", "My Profile"]);
    expect(t).not.toContain("Payouts");     // §6 — no financial management
    expect(t).not.toContain("Creators");    // §6 — no creator management CRUD
    const acts = [...dom.window.document.querySelectorAll("[data-act]")].map((n) => n.getAttribute("data-act"));
    expect(acts).not.toContain("crNewCreator");   // no creator CRUD
    expect(acts).not.toContain("crNewTeam");      // no team creation
  });

  it("CREATOR — their own work, and nothing about anybody else", async () => {
    const dom = await boot({ role: "creator" });
    const t = cnNav(dom);
    expect(t).toEqual(["Assistant", "Opportunities", "My Tasks", "Leaderboard", "War Zone",
      "Achievements", "My Analytics", "My Points", "My Payouts", "My Profile"]);
    expect(t).not.toContain("Creators");
    expect(t).not.toContain("Teams");
    expect(t).not.toContain("Review");
    const acts = [...dom.window.document.querySelectorAll("[data-act]")].map((n) => n.getAttribute("data-act"));
    expect(acts).not.toContain("crNewCreator");
  });

  /* The horizontal tab bar this navigation replaced was removed, not hidden —
     the renderers that produced it are gone from the page (§12). */
  it("renders no horizontal tab bar for anybody", async () => {
    for (const role of ["creator", "team_lead", "creator_admin"] as const)
      expect(tabBars(await boot({ role }))).toBe(0);
  });
});

describe("when the network cannot be loaded", () => {
  it("a suspended member is told so, and is not shown a demo department", async () => {
    const dom = await boot({ role: "creator", creatorStateStatus: 403 });
    const t = text(dom);
    expect(t).toContain("membership is not active");
    expect(t).not.toContain("Running on seed data");
    // Nothing to retry — this is a decision, not a failure.
    expect(dom.window.document.getElementById("cn-retry")).toBeNull();
  });

  it("any other refusal is an explicit error with a retry, never a blank page", async () => {
    const dom = await boot({ role: "creator", creatorStateStatus: 500 });
    expect(text(dom)).toContain("Creator Network could not be loaded");
    expect(dom.window.document.getElementById("cn-retry")).not.toBeNull();
  });
});
