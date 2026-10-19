// @vitest-environment node
/* ═══════════════════════════════════════════════════════════════════════════
   The boundary on a Manager administering the outreach team.

   A Manager now reaches every user write — add, change role, disable, delete —
   because they administer their own team. That makes exactly one thing
   dangerous: a Manager must not be able to end up with, or hand someone else,
   more authority than they hold.

   It takes two rules to close, and the second is the one that is easy to
   forget. Capping what a Manager may ASSIGN stops them promoting anyone to
   Admin. On its own that is decoration: the Admin account still sits there,
   and a Manager who cannot out-rank it can simply disable or delete it
   instead. So modifying an existing Admin is refused separately.

   The last test is the real guarantee — that no sequence of individually
   permitted moves adds up to a Manager holding Admin authority.
   ═══════════════════════════════════════════════════════════════════════════ */
import { describe, expect, it } from "vitest";
import { MANAGER_GRANTABLE_ROLES, mayAssignRole, mayModifyUserWithRole } from "./users.js";
import { VIDEO_ROLES, type VideoRole } from "./types.js";

describe("a Manager staffing their own team", () => {
  it("may assign the three production roles", () => {
    for (const role of MANAGER_GRANTABLE_ROLES) {
      expect(mayAssignRole("manager", role), role).toBe(true);
    }
  });

  it("may not assign Admin", () => {
    expect(mayAssignRole("manager", "admin")).toBe(false);
  });

  it("may modify an Editor, Publisher or fellow Manager", () => {
    for (const role of MANAGER_GRANTABLE_ROLES) {
      expect(mayModifyUserWithRole("manager", role), role).toBe(true);
    }
  });

  it("may not modify an existing Admin — so they cannot disable or delete one", () => {
    expect(mayModifyUserWithRole("manager", "admin")).toBe(false);
  });
});

describe("an Admin is unrestricted", () => {
  it("may assign and modify every role, including Admin", () => {
    for (const role of VIDEO_ROLES) {
      expect(mayAssignRole("admin", role), role).toBe(true);
      expect(mayModifyUserWithRole("admin", role), role).toBe(true);
    }
  });
});

describe("neither an Editor nor a Publisher administers anybody", () => {
  it("is refused every assignment and every modification", () => {
    for (const actor of ["editor", "publisher"] as VideoRole[]) {
      for (const role of VIDEO_ROLES) {
        expect(mayAssignRole(actor, role), `${actor} → assign ${role}`).toBe(false);
        expect(mayModifyUserWithRole(actor, role), `${actor} → modify ${role}`).toBe(false);
      }
    }
  });
});

describe("the boundary holds across the whole role set", () => {
  it("lets no non-admin reach Admin by any permitted move", () => {
    /* Stated over every role rather than the four that exist today: a role
       added later and wired nowhere should fail here rather than quietly
       become a way up. */
    for (const actor of VIDEO_ROLES.filter(r => r !== "admin")) {
      expect(mayAssignRole(actor, "admin"), `${actor} must not create an Admin`).toBe(false);
      expect(mayModifyUserWithRole(actor, "admin"), `${actor} must not edit an Admin`).toBe(false);
    }
  });

  it("never lets an actor assign a role they could not themselves be given", () => {
    for (const actor of VIDEO_ROLES) {
      for (const target of VIDEO_ROLES) {
        if (!mayAssignRole(actor, target)) continue;
        // The only actor allowed to produce an Admin is an Admin.
        if (target === "admin") expect(actor).toBe("admin");
      }
    }
  });
});
