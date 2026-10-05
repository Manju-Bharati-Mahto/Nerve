/* ═══════════════════════════════════════════════════════════════════════════
   The branding roster must account for every member it counts.

   WHY THIS FILE EXISTS. The roster is drawn as two lists: leads, selected by
   naming the three lead roles, and members, selected by `role === 'user'`.
   Between them those filters did NOT cover every role, so adding a fourth —
   inventory_manager — produced a person who was counted in the "Members (n)"
   header and rendered in neither list. The admin who had just created an
   Inventory Manager could not see, edit or remove them; the only sign the
   account existed was the count going up by one.

   The edit dialog had the same omission one layer down: it rebuilt its role
   from a chain of ternaries ending in 'user', so opening an Inventory Manager
   showed the wrong role already selected, and saving demoted them silently.

   Both are failures of exhaustiveness, so the tests assert on what happens to
   a role the rules were not written for — not only on the roles that exist
   today. A role added tomorrow and wired nowhere should fail here, loudly,
   rather than disappear from a page in production.
   ═══════════════════════════════════════════════════════════════════════════ */
import { describe, expect, it } from "vitest";
import { EDITABLE_ROLES, LEAD_ROLES, editableRole, splitRoster } from "./team-roster";
import { ROLES } from "@/lib/constants";

const person = (role: string, id = role) => ({ id, role });

describe("splitting the roster into leads and members", () => {
  it("puts an inventory_manager somewhere — they belong to neither hand-written group", () => {
    const { leads, rest } = splitRoster([person("inventory_manager")]);
    expect(leads.length + rest.length).toBe(1);
    expect(rest.map(p => p.role)).toEqual(["inventory_manager"]);
  });

  it("loses nobody, whatever role they hold", () => {
    /* Every role the system knows about, not only the ones this page expects
       to meet. The two lists are a partition or this fails. */
    const everyone = ROLES.map(r => person(r));
    const { leads, rest } = splitRoster(everyone);

    expect(leads.length + rest.length).toBe(everyone.length);
    const seen = [...leads, ...rest].map(p => p.id).sort();
    expect(seen).toEqual(everyone.map(p => p.id).sort());
  });

  it("claims nobody twice", () => {
    const { leads, rest } = splitRoster(ROLES.map(r => person(r)));
    const overlap = leads.filter(l => rest.some(r => r.id === l.id));
    expect(overlap).toEqual([]);
  });

  it("still groups the three lead roles as leads", () => {
    const { leads } = splitRoster(LEAD_ROLES.map(r => person(r)));
    expect(leads.map(p => p.role).sort()).toEqual([...LEAD_ROLES].sort());
  });

  it("treats an ordinary member as a member", () => {
    const { leads, rest } = splitRoster([person("user")]);
    expect(leads).toEqual([]);
    expect(rest.map(p => p.role)).toEqual(["user"]);
  });
});

describe("the role the edit dialog opens on", () => {
  it("round-trips an inventory_manager, so saving cannot demote them", () => {
    expect(editableRole("inventory_manager")).toBe("inventory_manager");
  });

  it("round-trips every role the dialog offers", () => {
    for (const role of EDITABLE_ROLES) expect(editableRole(role)).toBe(role);
  });

  it("falls back to 'user' only for a role the dialog cannot represent", () => {
    expect(editableRole("super_admin")).toBe("user");
    expect(editableRole("")).toBe("user");
  });

  it("offers every role the dialog can be asked to edit", () => {
    /* A lead or a member the panel renders must also be editable by it;
       anything the roster shows but the dialog cannot represent is the exact
       shape of the bug this file guards. */
    for (const role of LEAD_ROLES) expect(EDITABLE_ROLES).toContain(role);
    expect(EDITABLE_ROLES).toContain("inventory_manager");
    expect(EDITABLE_ROLES).toContain("user");
  });
});
