// @vitest-environment node
/* Account Tabs & State-wise Analytics requirements — who reads which outreach
   data, and who may change it. The database-backed paths (a configured
   person's saved tabs and states) are covered by
   outreach-state-scope.integration.test.ts. */
import { describe, expect, it } from "vitest";
import {
  hasTab,
  isOutreachAdmin,
  mayCreateOutreachStateUser,
  readsInfluencer,
  resolveOutreachAccess,
  resolveOutreachScope,
  stateInScope,
  type OutreachAccess,
} from "./outreach-scope.js";
import { OUTREACH_TABS } from "./outreach-tabs.js";

const configured = (tabs: OutreachAccess["tabs"]): OutreachAccess =>
  ({ admin: false, configured: true, tabs, scope: { kind: "states", states: ["Gujarat"] } });

describe("isOutreachAdmin", () => {
  it("is the super admin and the outreach manager, nobody else", () => {
    expect(isOutreachAdmin({ role: "super_admin" })).toBe(true);
    expect(isOutreachAdmin({ role: "outreach_manager" })).toBe(true);
    // The video workflow's Admin and the Publisher no longer administer outreach.
    for (const role of ["admin", "outreach_publisher", "outreach_editor", "outreach_state_user", "user"]) {
      expect(isOutreachAdmin({ role }), role).toBe(false);
    }
    expect(isOutreachAdmin(null)).toBe(false);
  });
});

describe("resolveOutreachAccess — without the database", () => {
  it("gives an admin every tab at Edit and every state", async () => {
    const access = await resolveOutreachAccess({ id: "u", role: "outreach_manager", team: "outreach" });
    expect(access?.admin).toBe(true);
    expect(access?.scope).toEqual({ kind: "all" });
    for (const t of OUTREACH_TABS) expect(access?.tabs[t.id], t.id).toBe("edit");
  });

  it("gives other departments nothing", async () => {
    for (const team of ["branding", "design", "media", "content", null]) {
      expect(await resolveOutreachAccess({ id: "u", role: "admin", team }), String(team)).toBeNull();
      expect(await resolveOutreachScope({ id: "u", role: "admin", team }), String(team)).toBeNull();
    }
    expect(await resolveOutreachAccess(null)).toBeNull();
  });
});

describe("hasTab — Off / View / Edit", () => {
  it("Edit includes View, View is not Edit, Off is neither", () => {
    const a = configured({ pages: "edit", analytics: "view" });
    expect(hasTab(a, "pages", "edit")).toBe(true);
    expect(hasTab(a, "pages", "view")).toBe(true);
    expect(hasTab(a, "analytics", "view")).toBe(true);
    expect(hasTab(a, "analytics", "edit")).toBe(false);
    expect(hasTab(a, "campaigns", "view")).toBe(false);
    expect(hasTab(a, ["campaigns", "pages"], "edit")).toBe(true);
    expect(hasTab(null, "pages", "view")).toBe(false);
  });
});

describe("readsInfluencer", () => {
  it("needs an influencer tab, chosen by an admin", () => {
    expect(readsInfluencer(configured({ analytics: "view" }))).toBe(true);
    expect(readsInfluencer(configured({ queue: "edit" }))).toBe(false);
    // Unconfigured: influencer data was the admins' alone, and still is.
    expect(readsInfluencer({ ...configured({ analytics: "view" }), configured: false })).toBe(false);
  });
});

describe("stateInScope", () => {
  it("matches the canonical state exactly", () => {
    expect(stateInScope({ kind: "all" }, "anything")).toBe(true);
    expect(stateInScope({ kind: "states", states: ["Gujarat"] }, "Gujarat")).toBe(true);
    expect(stateInScope({ kind: "states", states: ["Gujarat"] }, "Ladakh")).toBe(false);
    // No states assigned means nothing, never everything.
    expect(stateInScope({ kind: "states", states: [] }, "Gujarat")).toBe(false);
    expect(stateInScope({ kind: "states", states: [] }, "")).toBe(false);
  });
});

describe("mayCreateOutreachStateUser", () => {
  it("lets the super admin and the outreach manager create a State User on team outreach", () => {
    expect(mayCreateOutreachStateUser({ role: "super_admin", team: null }, "outreach")).toBe(true);
    expect(mayCreateOutreachStateUser({ role: "outreach_manager", team: "outreach" }, "outreach")).toBe(true);
    // The video workflow's Admin no longer adds users.
    expect(mayCreateOutreachStateUser({ role: "admin", team: "outreach" }, "outreach")).toBe(false);
  });

  it("never lets another department's admin create one, on any team (review regression)", () => {
    for (const team of ["branding", "design", "media", "content"]) {
      expect(mayCreateOutreachStateUser({ role: "admin", team }, team), team).toBe(false);
      expect(mayCreateOutreachStateUser({ role: "admin", team }, "outreach"), team).toBe(false);
      expect(mayCreateOutreachStateUser({ role: "sub_admin", team }, team), team).toBe(false);
    }
    expect(mayCreateOutreachStateUser({ role: "outreach_manager", team: "branding" }, "branding")).toBe(false);
    expect(mayCreateOutreachStateUser({ role: "outreach_manager", team: "branding" }, "outreach")).toBe(false);
  });

  it("refuses the outreach production roles and an account off team outreach", () => {
    expect(mayCreateOutreachStateUser({ role: "outreach_editor", team: "outreach" }, "outreach")).toBe(false);
    expect(mayCreateOutreachStateUser({ role: "outreach_state_user", team: "outreach" }, "outreach")).toBe(false);
    expect(mayCreateOutreachStateUser({ role: "super_admin", team: null }, "branding")).toBe(false);
    expect(mayCreateOutreachStateUser({ role: "super_admin", team: null }, null)).toBe(false);
    expect(mayCreateOutreachStateUser(null, "outreach")).toBe(false);
  });
});
