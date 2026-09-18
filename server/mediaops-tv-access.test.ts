// @vitest-environment node
/* ═══════════════════════════════════════════════════════════════════════════
   TV DISPLAY BOARD — module access, end to end through the two gates.

   The bug this file exists to prevent recurring: 'tv' was registered in the
   MODULES registry but never in NAV. MODULES is a PROJECTION of NAV, so the key
   was grantable in the admin selector while nothing in the product was gated by
   it — no sidebar entry, no route, and firstAllowedRoute() with nowhere to send
   an account that had been granted only that. The admin panel said yes and the
   application had no door.

   So both halves are asserted here, from the real artefacts:

     CLIENT — NAV/MODULES and the resolution functions are extracted from the
              shipped public/media-ops/index.html and executed. Not a
              re-implementation: if the sidebar file changes, this reads the
              change.
     SERVER — tvBoardAllowed(), the exact predicate GET /v1/media/tv/board runs.

   The database half (real grants resolving through effectiveModules) lives in
   mediaops-tv-access.integration.test.ts, which skips without a database.
   ═══════════════════════════════════════════════════════════════════════════ */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TV_MODULE_KEY, tvBoardAllowed } from "./mediaops-tv.js";

/* ── Load the sidebar's own logic out of the shipped page ─────────────────── */

const HTML = readFileSync("public/media-ops/index.html", "utf8");

/** Cut one block out of the page by its start and end markers. */
function block(from: string, to: string): string {
  const a = HTML.indexOf(from);
  const b = HTML.indexOf(to, a);
  // A loud failure beats a silently empty extraction that passes every test.
  if (a < 0 || b < 0) throw new Error(`marker missing in index.html: ${a < 0 ? from : to}`);
  return HTML.slice(a, b);
}

interface NavItem { r: string; l: string; i?: string; cap?: string; minRole?: string;
                    roles?: string[]; optIn?: boolean; pfx?: string[] }
interface Mod { key: string; label: string; group: string; optIn?: boolean; pfx: string[] }
interface Harness {
  NAV: Array<{ group: string; items: NavItem[] }>;
  MODULES: Mod[];
  ROUTE_KEYS: string[];
  sidebarFor(user: TestUser): Array<{ group: string; label: string }>;
  firstAllowedRoute(user: TestUser): string | null;
  defaultModulesFor(role: string): string[];
  moduleCheckboxesFor(role: string): string[];
  moduleRoleOk(m: Mod, role: string): boolean;
}
interface TestUser { role: "admin" | "team_lead" | "employee"; modules: string[] | null }

/* The extracted source runs with the globals the page gives it. Only the parts
   the sidebar consults are stubbed, and each stub is the page's own behaviour:
   `can` mirrors CAPS, `role`/`me` come from the user under test. */
function harness(): Harness {
  const src = [
    block("const NAV = [", "const ROLE_RANK"),
    "const ROLE_RANK={employee:0,team_lead:1,admin:2};",
    block("function navShow(it,r){", "/* ── Per-user Module Access"),
    block("const modKeyOf = ", "/* Group I:"),
    block("function moduleRoleOk(m,r){", "/* The grouped Module Access checklist"),
    block("function moduleGroupsHtml(cls,selected,forRole){", "\n/* A submitted report"),
  ].join("\n");

  let CURRENT: TestUser = { role: "employee", modules: null };
  const scope = {
    DB: { module_defaults: {} as Record<string, string[]>, my_module_group: null as string | null },
    S: { me: 1 },
    CAPS: {} as Record<string, Record<string, string>>,
    can: () => true,                       // capabilities are a separate axis; not under test here
    role: () => CURRENT.role,
    isAdmin: () => CURRENT.role === "admin",
    me: () => ({ id: 1, role: CURRENT.role, allowed_modules: CURRENT.modules }),
    esc: (x: unknown) => String(x),
    ic: () => "",
  };
  const names = Object.keys(scope);
  const fn = new Function(...names, `${src}
    return { NAV, MODULES, modKeyOf, navShow, hashModule, moduleAllowed,
             firstAllowedRoute, defaultModulesFor, effectiveModulesFor, moduleRoleOk,
             moduleGroupsHtml };`);
  const api = fn(...names.map((n) => (scope as Record<string, unknown>)[n]));

  const set = (u: TestUser) => { CURRENT = u; };

  return {
    NAV: api.NAV, MODULES: api.MODULES,
    ROUTE_KEYS: api.NAV.flatMap((g: { items: NavItem[] }) => g.items.map((i) => api.modKeyOf(i.r))),
    sidebarFor(u) {
      set(u);
      return api.NAV.flatMap((g: { group: string; items: NavItem[] }) =>
        g.items.filter((it) => api.navShow(it) && api.moduleAllowed(api.hashModule(it.r)))
               .map((it) => ({ group: g.group, label: it.l })));
    },
    firstAllowedRoute(u) { set(u); return api.firstAllowedRoute(); },
    moduleRoleOk(m, r) { set({ role: r as TestUser["role"], modules: null }); return api.moduleRoleOk(m, r); },
    defaultModulesFor(r) { set({ role: r as TestUser["role"], modules: null }); return api.defaultModulesFor(r); },
    moduleCheckboxesFor(r) {
      set({ role: r as TestUser["role"], modules: null });
      return [...String(api.moduleGroupsHtml("x", [], r)).matchAll(/class="x" value="([^"]+)"/g)]
        .map((m) => m[1]);
    },
  };
}

const H = harness();
const labels = (u: TestUser) => H.sidebarFor(u).map((x) => x.label);

const TV_ONLY: TestUser        = { role: "employee", modules: ["tv"] };
const NO_TV: TestUser          = { role: "employee", modules: ["home", "my-day", "projects"] };
const KIOSK_ONLY: TestUser     = { role: "employee", modules: ["kiosk"] };
const BOTH: TestUser           = { role: "employee", modules: ["kiosk", "tv"] };
const ADMIN: TestUser          = { role: "admin",    modules: null };
const UNRESTRICTED: TestUser   = { role: "employee", modules: null };

/* ── Registration ─────────────────────────────────────────────────────────── */

describe("registration — the key is the route, in one place", () => {
  it("registers TV Display Board as a real sidebar entry", () => {
    const tv = H.NAV.flatMap((g) => g.items).find((i) => i.l === "TV Display Board");
    expect(tv, "TV Display Board is missing from NAV").toBeDefined();
    expect(tv!.r).toBe("#/media/tv");
  });

  it("derives the module key 'tv' from that route, matching existing grants", () => {
    expect(H.ROUTE_KEYS).toContain(TV_MODULE_KEY);
    const mod = H.MODULES.find((m) => m.key === TV_MODULE_KEY);
    expect(mod).toBeDefined();
    expect(mod!.label).toBe("TV Display Board");
    expect(mod!.group).toBe("System");
  });

  it("gives it a route prefix, so the route guard can resolve it", () => {
    // pfx:[] was the original defect: hashModule() could never return 'tv', so
    // no route was ever gated by the module.
    expect(H.MODULES.find((m) => m.key === TV_MODULE_KEY)!.pfx).toEqual(["#/media/tv"]);
  });

  it("keeps tv and kiosk as two separate modules", () => {
    const keys = H.MODULES.map((m) => m.key);
    expect(keys).toContain("kiosk");
    expect(keys).toContain("tv");
    expect(H.MODULES.find((m) => m.key === "kiosk")!.label).toBe("Kiosk Mode");
  });
});

/* ── TEST 1–6: the navigation matrix ──────────────────────────────────────── */

describe("TEST 1 — a user with ONLY tv", () => {
  it("sees TV Display Board in the sidebar", () => {
    expect(labels(TV_ONLY)).toContain("TV Display Board");
  });

  it("sees NOTHING else — the module is independently grantable", () => {
    expect(labels(TV_ONLY)).toEqual(["TV Display Board"]);
  });

  it("does not need Home, My Day, Equipment, Media Library or any other module", () => {
    for (const other of ["Home", "My Day", "Projects", "Equipment", "Media Library", "Daily Reports"])
      expect(labels(TV_ONLY)).not.toContain(other);
  });

  it("lands on the board instead of a denied screen", () => {
    // The reported symptom: firstAllowedRoute() returned null, so render() drew
    // "Not available for your role" with an empty sidebar.
    expect(H.firstAllowedRoute(TV_ONLY)).toBe("#/media/tv");
  });

  it("passes the board's API gate", () => {
    expect(tvBoardAllowed(false, ["tv"])).toBe(true);
  });
});

describe("TEST 2 — a user WITHOUT tv", () => {
  it("does not see the sidebar entry", () => {
    expect(labels(NO_TV)).not.toContain("TV Display Board");
  });
  it("is refused by the board's API gate", () => {
    expect(tvBoardAllowed(false, ["home", "my-day", "projects"])).toBe(false);
  });
});

describe("TEST 3 — a user with ONLY kiosk", () => {
  it("does not get the TV board with it", () => {
    expect(labels(KIOSK_ONLY)).not.toContain("TV Display Board");
    expect(tvBoardAllowed(false, ["kiosk"])).toBe(false);
  });
});

describe("TEST 4 — a user with BOTH kiosk and tv", () => {
  it("sees the TV entry and holds the kiosk grant alongside it", () => {
    expect(labels(BOTH)).toContain("TV Display Board");
    expect(H.MODULES.map((m) => m.key)).toContain("kiosk");
    expect(tvBoardAllowed(false, ["kiosk", "tv"])).toBe(true);
  });
});

describe("TEST 5 — an admin", () => {
  it("reaches the board through the existing admin bypass", () => {
    expect(tvBoardAllowed(true, ["home"])).toBe(true);
    expect(tvBoardAllowed(true, null)).toBe(true);
  });
  it("sees the entry in the sidebar", () => {
    expect(labels(ADMIN)).toContain("TV Display Board");
  });
});

describe("TEST 6 — unrelated modules but no tv", () => {
  it("hides the entry and refuses the API", () => {
    const u: TestUser = { role: "team_lead", modules: ["projects", "reports", "team", "equipment"] };
    expect(labels(u)).not.toContain("TV Display Board");
    expect(tvBoardAllowed(false, u.modules)).toBe(false);
  });
});

/* ── Defaults: grantable, but never handed out by a role ──────────────────── */

describe("module defaults — opt-in, not automatic", () => {
  it("is offered as a checkbox in the admin module selector for every role", () => {
    for (const r of ["employee", "team_lead", "admin"])
      expect(H.moduleCheckboxesFor(r), `missing for ${r}`).toContain(TV_MODULE_KEY);
  });

  it("is NOT in any role's derived default set", () => {
    // Otherwise every employee on an installation without configured group
    // defaults would silently acquire a wall display.
    for (const r of ["employee", "team_lead", "admin"])
      expect(H.defaultModulesFor(r), `leaked into ${r} defaults`).not.toContain(TV_MODULE_KEY);
  });

  it("still hands out the ordinary modules it sits beside", () => {
    expect(H.defaultModulesFor("employee")).toContain("home");
    expect(H.defaultModulesFor("employee")).toContain("projects");
  });

  it("treats an unrestricted installation the same as the sidebar does", () => {
    // effectiveModules() === null means "no restrictions configured anywhere".
    // The sidebar shows every module then, so the board must open then too, or
    // a nav item would link to a page that refuses it.
    expect(labels(UNRESTRICTED)).toContain("TV Display Board");
    expect(tvBoardAllowed(false, null)).toBe(true);
  });
});

/* ── Nothing else moved ───────────────────────────────────────────────────── */

describe("no collateral change to other modules", () => {
  it("withholds from the derived defaults exactly the opt-in modules, no others", () => {
    /* defaultModulesFor() subtracts `optIn` modules and nothing else. Comparing
       the withheld set against the optIn set proves that directly, and keeps
       holding as more opt-in modules arrive (the Creator Network is the second)
       while still catching a module withheld by accident. */
    for (const r of ["employee", "team_lead", "admin"]) {
      const eligible = H.MODULES.filter((m) => H.moduleRoleOk(m, r));
      const withheld = eligible.filter((m) => !H.defaultModulesFor(r).includes(m.key)).map((m) => m.key);
      const optIn = eligible.filter((m) => m.optIn).map((m) => m.key);
      expect(withheld.sort(), `unexpected modules withheld from ${r}`).toEqual(optIn.sort());
    }
    // The wall display is one of them, and is never handed out by a role.
    expect(H.defaultModulesFor("employee")).not.toContain(TV_MODULE_KEY);
  });

  it("still hands kiosk to the derived defaults, exactly as before", () => {
    expect(H.defaultModulesFor("employee")).toContain("kiosk");
  });

  it("leaves the admin sidebar complete", () => {
    const a = labels(ADMIN);
    for (const l of ["Home", "My Day", "Projects", "Equipment", "Media Library",
                     "Daily Reports", "Calendar", "Leave", "Settings"])
      expect(a, `admin lost ${l}`).toContain(l);
  });

  it("keeps kiosk out of the sidebar — it is still a shell button, not a nav item", () => {
    expect(H.ROUTE_KEYS).not.toContain("kiosk");
  });
});
