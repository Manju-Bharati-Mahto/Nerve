// @vitest-environment node
/* PRD 6.1 / 6.3 — who reads which outreach data, and who may change it. */
import { describe, expect, it } from "vitest";
import {
  mayCreateOutreachStateUser,
  mayEditOutreach,
  outreachAccessKind,
  resolveOutreachScope,
  stateInScope,
} from "./outreach-scope.js";

describe("outreachAccessKind", () => {
  it("gives super_admin, the outreach manager and the outreach publisher everything", () => {
    expect(outreachAccessKind({ role: "super_admin", team: null })).toBe("all");
    expect(outreachAccessKind({ role: "outreach_manager", team: "outreach" })).toBe("all");
    // The product owner's "Publisher (Admin)": a full influencer admin.
    expect(outreachAccessKind({ role: "outreach_publisher", team: "outreach" })).toBe("all");
  });

  it("scopes a State User to their states", () => {
    expect(outreachAccessKind({ role: "outreach_state_user", team: "outreach" })).toBe("states");
  });

  it("refuses everyone else — the outreach Admin and every other department included", () => {
    // The outreach Admin is the video workflow's Admin only (not widened).
    expect(outreachAccessKind({ role: "admin", team: "outreach" })).toBeNull();
    expect(outreachAccessKind({ role: "outreach_editor", team: "outreach" })).toBeNull();
    for (const team of ["branding", "design", "media", "content"]) {
      expect(outreachAccessKind({ role: "admin", team }), team).toBeNull();
      expect(outreachAccessKind({ role: "user", team }), team).toBeNull();
    }
    expect(outreachAccessKind(null)).toBeNull();
    expect(outreachAccessKind(undefined)).toBeNull();
  });

  it("requires team outreach for the publisher and the State User", () => {
    // Nothing in the users table stops an outreach_* role sitting on another team.
    expect(outreachAccessKind({ role: "outreach_publisher", team: "branding" })).toBeNull();
    expect(outreachAccessKind({ role: "outreach_state_user", team: "design" })).toBeNull();
  });
});

describe("mayEditOutreach", () => {
  it("lets only full-access people write", () => {
    expect(mayEditOutreach({ role: "super_admin", team: null })).toBe(true);
    expect(mayEditOutreach({ role: "outreach_manager", team: "outreach" })).toBe(true);
    expect(mayEditOutreach({ role: "outreach_publisher", team: "outreach" })).toBe(true);
    // State Users are strictly read-only.
    expect(mayEditOutreach({ role: "outreach_state_user", team: "outreach" })).toBe(false);
    expect(mayEditOutreach({ role: "admin", team: "outreach" })).toBe(false);
    expect(mayEditOutreach({ role: "admin", team: "branding" })).toBe(false);
  });
});

describe("resolveOutreachScope", () => {
  it("answers full access and refusal without reading the database", async () => {
    expect(await resolveOutreachScope({ id: "u", role: "outreach_publisher", team: "outreach" })).toEqual({ kind: "all" });
    expect(await resolveOutreachScope({ id: "u", role: "admin", team: "media" })).toBeNull();
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
  it("lets super_admin and the outreach team's manager or admin create a State User on team outreach", () => {
    expect(mayCreateOutreachStateUser({ role: "super_admin", team: null }, "outreach")).toBe(true);
    expect(mayCreateOutreachStateUser({ role: "outreach_manager", team: "outreach" }, "outreach")).toBe(true);
    expect(mayCreateOutreachStateUser({ role: "admin", team: "outreach" }, "outreach")).toBe(true);
  });

  it("never lets another department's admin create one, on any team (review regression)", () => {
    // canCreateManagedUser's admin branch checks only "own team"; with the
    // role in that list a branding admin could mint one on team branding.
    for (const team of ["branding", "design", "media", "content"]) {
      expect(mayCreateOutreachStateUser({ role: "admin", team }, team), team).toBe(false);
      expect(mayCreateOutreachStateUser({ role: "admin", team }, "outreach"), team).toBe(false);
      expect(mayCreateOutreachStateUser({ role: "sub_admin", team }, team), team).toBe(false);
    }
    // A manager whose own team is not outreach cannot either.
    expect(mayCreateOutreachStateUser({ role: "outreach_manager", team: "branding" }, "branding")).toBe(false);
    expect(mayCreateOutreachStateUser({ role: "outreach_manager", team: "branding" }, "outreach")).toBe(false);
  });

  it("refuses the outreach production roles and an account off team outreach", () => {
    expect(mayCreateOutreachStateUser({ role: "outreach_editor", team: "outreach" }, "outreach")).toBe(false);
    expect(mayCreateOutreachStateUser({ role: "outreach_state_user", team: "outreach" }, "outreach")).toBe(false);
    // On another team the account could never see anything — refuse even super_admin.
    expect(mayCreateOutreachStateUser({ role: "super_admin", team: null }, "branding")).toBe(false);
    expect(mayCreateOutreachStateUser({ role: "super_admin", team: null }, null)).toBe(false);
    expect(mayCreateOutreachStateUser(null, "outreach")).toBe(false);
  });
});
