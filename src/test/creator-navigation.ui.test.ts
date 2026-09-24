/* ═══════════════════════════════════════════════════════════════════════════
   UI — role-aware navigation, shortcuts, command palette and quick actions.

   THE BUG THIS FILE EXISTS FOR. A creator opening the Creator Network was
   offered "New project", "Book equipment", "Go Projects", "Go Equipment" and
   "Go Library" — by the ? dialog, by ⌘K and by the + button. None of those
   screens are theirs. The lists were hardcoded, so nothing about them could
   depend on who was reading them.

   WHAT IS ASSERTED, AND WHY IT IS ASSERTED THIS WAY. These tests boot the real
   public/media-ops/index.html in jsdom and then call the page's OWN functions —
   shortcutModel(), paletteItems(), quickAddItems(), cnItems() — rather than a
   copy of their logic. A test that restated the expected registry would pass
   against a second hardcoded list, which is the exact failure being fixed.

   Hiding an entry is never the security claim. Every panel behind these routes
   is a server-scoped read, covered by the integration suites; what is checked
   here is that the UI stops offering doors that are locked (§29, §53).
   ═══════════════════════════════════════════════════════════════════════════ */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const HTML = readFileSync("public/media-ops/index.html", "utf8");

type Mode = "creator" | "team_lead" | "creator_admin";

/** GET /creator/state, in the three shapes the server sends. */
function creatorState(role: Mode) {
  const base = {
    profile: {
      user_id: `ui-${role}`, full_name: "Misha Patel", display_name: "Misha Patel",
      email: "m@x.invalid", creator_role: role, status: "active",
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
           counts: { active: 12, inactive: 0, suspended: 1, archived: 0 } };
}

/* The page declares its state with top-level `const`, which lives in the
   global lexical scope rather than on `window` — so the harness reaches in the
   way the page's own inline handlers do, by evaluating in that scope. */
type Ev = <T>(expr: string) => T;

interface Session { dom: JSDOM; ev: Ev; go: (hash: string) => Promise<void> }

/** Boot as a Creator Network member: the creator-scoped shell, no Media Ops. */
async function bootCreator(role: Mode, hash = "#/media/creator"): Promise<Session> {
  const dom = new JSDOM(HTML, {
    url: `http://localhost/api/media-ops/?as=creator${hash}`,
    runScripts: "dangerously", pretendToBeVisual: true,
  });
  const w = dom.window as unknown as { fetch: unknown; eval: (s: string) => unknown };
  w.fetch = async (input: RequestInfo | URL) => {
    const url = String(input);
    const reply = (status: number, body: unknown) =>
      ({ ok: status < 400, status, json: async () => body }) as Response;
    if (url.includes("/api/v1/media/state"))
      return reply(403, { message: "Media Ops is not available for your role." });
    if (url.includes("/creator/state")) return reply(200, creatorState(role));
    return reply(200, {});
  };
  await new Promise((r) => setTimeout(r, 90));
  const ev: Ev = (expr) => w.eval(expr) as never;
  return { dom, ev, go: navigator(dom, ev) };
}

/** Boot as Media Ops staff: the ordinary shell on its seed department. */
async function bootMediaOps(hash = "#/media/home"): Promise<Session> {
  const dom = new JSDOM(HTML, {
    url: `http://localhost/api/media-ops/${hash}`,
    runScripts: "dangerously", pretendToBeVisual: true,
  });
  const w = dom.window as unknown as { fetch: unknown; eval: (s: string) => unknown };
  // Offline: the page runs on its prototype department, an Admin signed in.
  w.fetch = async () => { throw new Error("offline"); };
  await new Promise((r) => setTimeout(r, 90));
  const ev: Ev = (expr) => w.eval(expr) as never;
  return { dom, ev, go: navigator(dom, ev) };
}

function navigator(dom: JSDOM, ev: Ev) {
  return async (hash: string) => {
    dom.window.location.hash = hash;
    ev("render()");
    await new Promise((r) => setTimeout(r, 25));
  };
}

/* ── Readers, all of them reading the rendered page or its own registry ──── */
const sidebar = (s: Session) =>
  [...s.dom.window.document.querySelectorAll("#nav .nav-item")]
    /* A nav entry's text includes its badge count ("Daily Reports3"), so the
       label is the .nav-label span rather than the whole anchor. */
    .map((n) => n.querySelector(".nav-label")?.textContent?.trim() ?? n.textContent?.trim() ?? "");
const groups = (s: Session) =>
  [...s.dom.window.document.querySelectorAll("#nav .nav-group-label")].map((n) => n.textContent?.trim() ?? "");
/** The 'G then _' destinations the keyboard will actually accept. */
const gotos = (s: Session) =>
  s.ev<{ l: string }[]>("shortcutModel().nav").map((n) => n.l);
/** The single-key actions the keyboard will actually accept. */
const actionKeys = (s: Session) =>
  s.ev<{ l: string }[]>("shortcutModel().actions").map((a) => a.l);
/** Every command ⌘K offers with an empty query, and with one. */
const palette = (s: Session, q = "") =>
  s.ev<{ g: string; b: string }[]>(`paletteItems(${JSON.stringify(q)})`).map((i) => `${i.g}: ${i.b}`);
const quickAdd = (s: Session) =>
  s.ev<{ label?: string; sep?: boolean }[]>("quickAddItems()").filter((i) => !i.sep).map((i) => i.label);
/** The rendered ? dialog. */
function shortcutDialog(s: Session): string {
  s.ev("showShortcuts()");
  return s.dom.window.document.getElementById("modal-layer")?.textContent ?? "";
}

/* The Media Ops actions and destinations a creator must never be offered.
   Whole labels, compared exactly: "My Analytics" is a creator's own page and
   must not be caught by a substring test for "Analytics". */
const FORBIDDEN = ["New project", "Book equipment", "Log a task", "Projects", "Equipment",
                   "Media Library", "Daily Reports", "Team", "Calendar", "Analytics",
                   "Production Pipeline", "Leave", "KRA", "TV Display Board"];

/* ══════════════════════════════════════════════════════════════════════════
   1–3. The three Creator Network roles get their own navigation.
   ══════════════════════════════════════════════════════════════════════════ */
describe("the Creator Network sidebar is the role", () => {
  it("CREATOR — their own work, grouped Network / Insights / Account", async () => {
    const s = await bootCreator("creator");
    expect(sidebar(s)).toEqual(["Assistant", "Opportunities", "My Tasks", "Leaderboard",
      "War Zone", "Achievements", "My Analytics", "My Points", "My Payouts", "My Profile"]);
    expect(groups(s)).toEqual(["Creator Network", "Insights", "Account"]);
  });

  it("TEAM LEAD — their team beside their own work, and no network money", async () => {
    const s = await bootCreator("team_lead");
    expect(sidebar(s)).toEqual(["Assistant", "My Team", "Opportunities", "My Tasks", "Review",
      "Leaderboard", "War Zone", "Achievements", "Team Analytics", "My Analytics",
      "My Points", "My Profile"]);
    // §6 — the management finance surfaces are not a Team Lead's screens.
    for (const denied of ["Payouts", "Creators", "Overview"]) expect(sidebar(s)).not.toContain(denied);
  });

  it("CREATOR ADMIN — management views, named as management, not as 'My'", async () => {
    const s = await bootCreator("creator_admin");
    expect(sidebar(s)).toEqual(["Overview", "Creators", "Teams", "Events", "Tasks", "Review",
      "Points", "Payouts", "Recognition", "Analytics", "Assistant"]);
    // §39 — an admin manages the network's points, they do not have "My Points".
    for (const personal of ["My Points", "My Payouts", "My Analytics"])
      expect(sidebar(s)).not.toContain(personal);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   4 + 16. Media Ops Master Admin, and the Media Ops sidebar left alone.
   ══════════════════════════════════════════════════════════════════════════ */
describe("a Media Ops Admin keeps Media Ops, and manages the network too", () => {
  let s: Session;
  beforeAll(async () => { s = await bootMediaOps(); }, 30_000);

  it("still has the whole Media Ops sidebar", () => {
    const nav = sidebar(s);
    for (const m of ["Home", "My Day", "Projects", "Daily Reports", "Media Library",
                     "Equipment", "Calendar", "Team", "Creator Network"])
      expect(nav, m).toContain(m);
  });

  it("still has the Media Ops shortcuts, on the letters they always were", () => {
    const M = s.ev<{ nav: { k: string; route: string }[] }>("shortcutModel()");
    const map = Object.fromEntries(M.nav.map((n) => [n.k, n.route]));
    expect(map).toMatchObject({
      h: "#/media/home", m: "#/media/my-day", p: "#/media/projects", r: "#/media/reports",
      e: "#/media/equipment", c: "#/media/calendar", t: "#/media/team",
      a: "#/media/analytics", l: "#/media/library",
    });
    expect(actionKeys(s)).toEqual(["Log a task", "New project", "Book equipment"]);
  });

  /* §8 — reached through the administrative role, holding no creator profile. */
  it("gets Creator Management without being made a Creator Admin", async () => {
    s.ev(`CREATOR_STATE.loaded=true;CREATOR_STATE.err=null;CREATOR_STATE.data=${
      JSON.stringify({ ...creatorState("creator_admin"), profile: null, creator_role: null })};`);
    await s.go("#/media/creator");
    expect(s.ev<string>("cnMode()")).toBe("manage");
    expect(sidebar(s)).toContain("Payouts");
    expect(sidebar(s)).toContain("Creators");
  });

  it("swaps to Creator shortcuts inside the module, and back on the way out", async () => {
    await s.go("#/media/creator");
    expect(gotos(s)).toContain("Payouts");
    expect(gotos(s)).not.toContain("Projects");
    await s.go("#/media/home");
    expect(gotos(s)).toContain("Projects");
    expect(gotos(s)).not.toContain("Recognition");
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   5–7. Nothing unauthorised is reachable by sidebar, key or command.
   ══════════════════════════════════════════════════════════════════════════ */
describe("a creator is never offered a Media Ops door", () => {
  let s: Session;
  beforeAll(async () => { s = await bootCreator("creator"); }, 30_000);

  it("not in the sidebar", () => {
    const nav = sidebar(s);
    for (const f of FORBIDDEN) expect(nav, f).not.toContain(f);
  });

  it("not as a keyboard shortcut — the action list is empty, not filtered", () => {
    expect(actionKeys(s)).toEqual([]);
    const g = gotos(s).join(" | ");
    for (const f of ["Projects", "Equipment", "Media Library", "Daily Reports"])
      expect(g).not.toContain(f);
  });

  it("not in the command palette, on an empty query or a pointed one", () => {
    for (const q of ["", "project", "equipment", "book", "new"]) {
      const p = palette(s, q).join(" | ");
      for (const f of ["New project", "Book equipment", "Log a task", "Create Project"])
        expect(p, `query ${JSON.stringify(q)}`).not.toContain(f);
    }
  });

  /* §45 — searching for the word must not conjure the action. */
  it("searching 'project' offers a creator nothing at all", () => {
    expect(palette(s, "project").filter((x) => x.startsWith("Actions:"))).toEqual([]);
  });

  it("not behind the + button, which is hidden rather than empty", () => {
    expect(quickAdd(s)).toEqual([]);
    const btn = s.dom.window.document.getElementById("btn-quickadd") as HTMLElement;
    expect(btn.style.display).toBe("none");
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   12–14. The three lists are generated, per role.
   ══════════════════════════════════════════════════════════════════════════ */
describe("the shortcut dialog, the palette and the + menu are the role", () => {
  it("the ? dialog lists the creator's own pages and none of Media Ops", async () => {
    const s = await bootCreator("creator");
    const d = shortcutDialog(s);
    expect(d).toContain("Keyboard shortcuts");
    for (const own of ["Opportunities", "War Zone", "My Payouts"]) expect(d).toContain(own);
    /* The rows are generated from the registry, so a destination is named by
       its own label — "Projects", never the old hand-written "Go Projects". */
    for (const f of ["New project", "Book equipment", "Log a task",
                     "Projects", "Equipment", "Media Library", "Daily Reports"])
      expect(d, f).not.toContain(f);
    // The shell's own keys survive: they are preferences, not business actions.
    expect(d).toContain("Toggle dark mode");
    expect(d).toContain("Command palette");
  });

  /* §50 — the module is not handed out because somebody works in Media Ops. */
  it("an ordinary Media Ops employee is offered no Creator Network at all", async () => {
    const s = await bootMediaOps();
    s.ev("DB.users[0].role='employee';DB.users[0].allowed_modules=['home','my-day','projects'];");
    await s.go("#/media/home");
    expect(sidebar(s)).toEqual(["Home", "My Day", "Projects"]);
    expect(gotos(s).sort()).toEqual(["Home", "My Day", "Projects"]);
    expect(shortcutDialog(s)).not.toContain("Creator");
  });

  it("a Creator Admin's dialog lists management pages instead", async () => {
    const s = await bootCreator("creator_admin");
    const d = shortcutDialog(s);
    for (const own of ["Recognition", "Payouts", "Creators"]) expect(d).toContain(own);
    expect(d).not.toContain("New project");
  });

  it("every 'G then _' letter is unique within a role, or one would shadow another", async () => {
    for (const role of ["creator", "team_lead", "creator_admin"] as const) {
      const s = await bootCreator(role);
      const keys = s.ev<{ k: string }[]>("shortcutModel().nav").map((n) => n.k);
      expect(new Set(keys).size, `${role} has a duplicate shortcut letter`).toBe(keys.length);
    }
  });

  it("navigation and actions stay separate in the palette (§24)", async () => {
    const s = await bootCreator("creator");
    const p = palette(s);
    expect(p).toContain("Navigate: My Tasks");           // navigation: theirs
    expect(p.filter((x) => x.startsWith("Actions:")))     // actions: only shell preferences
      .toEqual(["Actions: Toggle dark mode", "Actions: Keyboard shortcuts"]);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   8–11. Revocation, restoration, and the route that is not the sidebar.
   ══════════════════════════════════════════════════════════════════════════ */
describe("when the module goes away, so does everything that points at it", () => {
  let s: Session;
  beforeAll(async () => { s = await bootCreator("creator"); }, 30_000);

  const revoke = async () => {
    s.ev("DB.users[0].allowed_modules=[];DB.module_defaults={creator:[]};");
    await s.go("#/media/creator");
  };
  const restore = async () => {
    s.ev("DB.users[0].allowed_modules=['creator'];DB.module_defaults={creator:['creator']};");
    await s.go("#/media/creator");
  };

  it("the navigation disappears", async () => {
    await revoke();
    expect(s.ev<string | null>("cnMode()")).toBeNull();
    expect(sidebar(s)).toEqual([]);
  });

  it("the shortcuts disappear with it", async () => {
    await revoke();
    expect(gotos(s)).toEqual([]);
    expect(actionKeys(s)).toEqual([]);
  });

  it("and so do the commands", async () => {
    await revoke();
    expect(palette(s, "payouts").filter((x) => x.startsWith("Navigate:"))).toEqual([]);
    expect(palette(s).filter((x) => x.startsWith("Navigate:"))).toEqual([]);
  });

  it("a hand-typed route is refused, not rendered", async () => {
    await revoke();
    s.dom.window.location.hash = "#/media/creator/payouts";
    s.ev("render()");
    await new Promise((r) => setTimeout(r, 25));
    const page = s.dom.window.document.getElementById("page")?.textContent ?? "";
    expect(page).not.toContain("What your points were worth");
  });

  it("restoring the module brings all three back", async () => {
    await restore();
    expect(sidebar(s)).toContain("My Payouts");
    expect(gotos(s)).toContain("My Payouts");
    // An empty query lists only the first few destinations, so name this one.
    expect(palette(s, "payouts")).toContain("Navigate: My Payouts");
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   11 + 14. Direct URLs, for every page, and only the viewer's own.
   ══════════════════════════════════════════════════════════════════════════ */
describe("every page has a URL, and only the right people can open it", () => {
  it("each sidebar entry is reachable by its own route", async () => {
    const s = await bootCreator("creator");
    const items = s.ev<{ s: string; l: string }[]>("cnItems()");
    for (const it of items) {
      await s.go(`#/media/creator/${it.s}`);
      expect(s.ev<{ l: string }>("cnCurrent()").l, `route ${it.s}`).toBe(it.l);
      // The sidebar marks where you are, for sighted users and for a reader.
      const active = s.dom.window.document.querySelector("#nav .nav-item.active");
      expect(active?.textContent?.trim()).toBe(it.l);
      expect(active?.getAttribute("aria-current")).toBe("page");
      // And the breadcrumb names the page, not the module three times (§35).
      expect(s.dom.window.document.getElementById("crumb-page")?.textContent).toBe(it.l);
    }
  });

  /* §14 — a creator typing a management route does not get a management page.
     The sidebar is not the gate; this is, and the API behind it is the real
     one. */
  it("a creator hand-typing a management route lands on their own page", async () => {
    const s = await bootCreator("creator");
    for (const denied of ["payouts-management", "creators", "overview", "recognition"]) {
      await s.go(`#/media/creator/${denied}`);
      expect(s.ev<{ k: string }>("cnCurrent()").k, denied).toBe("assistant");
      expect(sidebar(s)).not.toContain("Creators");
    }
  });

  it("a Team Lead hand-typing the payout route gets no payout page", async () => {
    const s = await bootCreator("team_lead");
    await s.go("#/media/creator/payouts");
    expect(s.ev<{ k: string }>("cnCurrent()").k).toBe("assistant");
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   15. Role change is read again, never remembered.
   ══════════════════════════════════════════════════════════════════════════ */
describe("a changed role produces changed navigation", () => {
  it("promoting a creator to Team Lead re-derives the sidebar and the keys", async () => {
    const s = await bootCreator("creator");
    expect(sidebar(s)).not.toContain("Review");

    // Exactly what the next session would receive from GET /creator/state.
    s.ev(`CREATOR_STATE.data=${JSON.stringify(creatorState("team_lead"))};`);
    await s.go("#/media/creator");

    expect(s.ev<string>("cnMode()")).toBe("lead");
    expect(sidebar(s)).toContain("My Team");
    expect(sidebar(s)).toContain("Review");
    expect(gotos(s)).toContain("Review");
    expect(shortcutDialog(s)).toContain("Team Analytics");
  });

  it("demoting back to creator takes the team pages away again", async () => {
    const s = await bootCreator("team_lead");
    expect(sidebar(s)).toContain("Review");
    s.ev(`CREATOR_STATE.data=${JSON.stringify(creatorState("creator"))};`);
    await s.go("#/media/creator");
    expect(s.ev<string>("cnMode()")).toBe("self");
    expect(sidebar(s)).not.toContain("Review");
    expect(sidebar(s)).not.toContain("My Team");
    expect(gotos(s)).not.toContain("Review");
  });
});
