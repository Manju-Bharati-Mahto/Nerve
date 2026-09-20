/* ═══════════════════════════════════════════════════════════════════════════
   UI — the Creator Network inside the Media Ops Team Directory.

   One directory, not two (§7). These tests boot the real Media Ops page and
   drive its own functions, because the point being checked is that the
   EXISTING grouping, chip and card machinery absorbs three new roles without a
   parallel screen — so the test has to exercise that machinery rather than a
   copy of it.
   ═══════════════════════════════════════════════════════════════════════════ */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const HTML = readFileSync("public/media-ops/index.html", "utf8");

/* Exactly the shape GET /state now sends for creator_people. */
const CREATORS = [
  { id: "p1", full_name: "Priya Desai", email: "priya@x.invalid", designation: "Creator Admin",
    role: "creator_admin", creator_role: "creator_admin", creator_status: "active",
    creator_team: null, creator_team_id: null, leads_team: false, is_creator: true,
    is_active: true, joined_on: "2026-01-05", allowed_modules: null },
  { id: "l1", full_name: "Arjun Mehta", email: "arjun@x.invalid", designation: "Creator Team Lead",
    role: "creator_team_lead", creator_role: "team_lead", creator_status: "active",
    creator_team: "Reels Squad", creator_team_id: 1, leads_team: true, is_creator: true,
    is_active: true, joined_on: "2026-01-06", allowed_modules: null },
  { id: "c1", full_name: "Misha Patel", email: "misha@x.invalid", designation: "Reel Creator",
    role: "creator", creator_role: "creator", creator_status: "active",
    creator_team: "Reels Squad", creator_team_id: 1, leads_team: false, is_creator: true,
    is_active: true, joined_on: "2026-01-07", allowed_modules: null },
  { id: "c2", full_name: "Rhea Bhatt", email: "rhea@x.invalid", designation: "Reel Creator",
    role: "creator", creator_role: "creator", creator_status: "suspended",
    creator_team: "Reels Squad", creator_team_id: 1, leads_team: false, is_creator: true,
    is_active: false, joined_on: "2026-01-08", allowed_modules: null },
];

let w: Window & typeof globalThis & Record<string, unknown>;
/* The page declares its state with top-level `const`, which lives in the
   global lexical scope rather than on `window` — so the harness reaches in the
   way the page's own inline handlers do, by evaluating in that scope. */
let ev: <T>(expr: string) => T;

beforeAll(async () => {
  const dom = new JSDOM(HTML, {
    url: "http://localhost/api/media-ops/#/media/team",
    runScripts: "dangerously", pretendToBeVisual: true,
  });
  w = dom.window as never;
  ev = (expr) => (w as unknown as { eval: (s: string) => unknown }).eval(expr) as never;
  // Seed mode: no server. The page runs on its prototype data, which is what
  // the directory's crew half reads; the creator half is supplied below.
  (w as unknown as { fetch: unknown }).fetch = async () => { throw new Error("offline"); };
  await new Promise((r) => setTimeout(r, 80));
  (ev<Record<string, unknown>>("DB")).creator_people = CREATORS;
}, 30_000);

const html = () => String(ev<() => string>("teamDirectory")());

describe("the directory grows three groups, not a second directory", () => {
  it("renders Creator Admins, Creator Team Leads and Creators", () => {
    const h = html();
    for (const g of ["Creator Admins", "Creator Team Leads", "Creators"]) expect(h).toContain(g);
  });

  it("counts come from the roster, not from a label", () => {
    const h = html();
    // One admin, one lead, one active creator — the suspended one is not in
    // the active directory, exactly as a deactivated SMC profile is not.
    expect(h).toContain("Priya Desai");
    expect(h).toContain("Arjun Mehta");
    expect(h).toContain("Misha Patel");
    expect(h).not.toContain("Rhea Bhatt");
  });

  it("keeps every existing Media Ops group", () => {
    const h = html();
    for (const g of ["Admins", "Team Leads", "Employees"]) expect(h).toContain(g);
  });

  it("a Creator Team Lead is never filed under the Media Ops Team Leads", () => {
    const groups = ev<(u: unknown[]) => Array<{ role: string; users: Array<{ id: string }> }>>("roleGroups")(
      CREATORS.filter((c) => c.is_active));
    const crewLeads = groups.find((g) => g.role === "team_lead");
    expect(crewLeads).toBeUndefined();
    expect(groups.find((g) => g.role === "creator_team_lead")!.users.map((u) => u.id)).toEqual(["l1"]);
  });
});

describe("a creator's card says what they actually are", () => {
  const card = (i: number) => String(ev<(u: unknown) => string>("dirCard")(CREATORS[i]));

  it("names the creator role and the creator team", () => {
    const lead = card(1);
    expect(lead).toContain("Arjun Mehta");
    expect(lead).toContain("Creator Team Lead");
    expect(lead).toContain("Reels Squad");
    expect(lead).toContain("Leads");
    expect(lead).not.toMatch(/>\s*User\s*</);
  });

  it("a Creator Admin is network-wide rather than teamless-looking", () => {
    expect(card(0)).toContain("Network-wide");
  });

  it("a suspended creator's card says so and does not pretend otherwise", () => {
    const c = card(3);
    expect(c).toContain("Suspended");
    expect(c).toContain("cannot enter the network");
  });
});

describe("Add member is the one door", () => {
  it("offers the creator roles under their own heading, keeping the crew roles", () => {
    const opts = String(ev<(c?: string) => string>("ADD_ROLE_OPTIONS")("employee"));
    expect(opts).toContain('<optgroup label="Media Ops roles">');
    expect(opts).toContain('<optgroup label="Creator Network roles">');
    for (const r of ["employee", "team_lead", "coordinator", "admin", "smc_member"])
      expect(opts).toContain(`value="${r}"`);
    for (const r of ["creator_admin", "creator_team_lead", "creator"])
      expect(opts).toContain(`value="${r}"`);
  });

  it("knows which of them are Creator Network roles", () => {
    const is = ev<(r: string) => boolean>("isCreatorFormRole");
    expect(["creator_admin", "creator_team_lead", "creator"].every(is)).toBe(true);
    expect(["employee", "team_lead", "admin", "coordinator", "smc_member"].some(is)).toBe(false);
  });
});

describe("the module key stays the one the server already uses", () => {
  it("is 'creator', derived from the route", () => {
    expect(ev<(r: string) => string>("modKeyOf")("#/media/creator")).toBe("creator");
    const mods = ev<Array<{ key: string; group: string; label: string }>>("MODULES");
    const m = mods.filter((x) => x.key === "creator");
    expect(m.length).toBe(1);                       // exactly one, no competing key
    expect(m[0].group).toBe("Creator Network");
    // No parallel identifiers anywhere in the projection.
    for (const bad of ["creator_network", "creator_management", "creators", "creator_portal"])
      expect(mods.some((x) => x.key === bad)).toBe(false);
  });

  it("the Module Access dialog offers it as a real, grantable module", () => {
    const h = String(ev<(c: string, sel: unknown, r: string) => string>("moduleGroupsHtml")(
      "em-mod", ["creator"], "employee"));
    expect(h).toContain("Creator Network");
    expect(h).toContain('value="creator"');
  });
});
