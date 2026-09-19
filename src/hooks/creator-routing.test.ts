/* ═══════════════════════════════════════════════════════════════════════════
   REGRESSION — a Creator Network member must land in the Creator Network.

   The bug this pins: a creator is an ordinary Nerve user (role 'user') whose
   Nerve team is 'creator'. getRoleDashboard() knew 'media' and 'smc' but not
   'creator', so every creator — including a Creator Admin — fell through to
   the last branch and was sent to /branding/user, a Knowledge Hub page whose
   own guard then refused them. The result was a redirect loop that rendered
   nothing, under a sidebar that had no entry for `user:creator` either.

   Creator standing is NOT inferred from the team name here. It comes from
   mo_creator_profiles, carried on the session payload, exactly as §8 requires:
   the team string is where the person sits in Nerve, the profile is what they
   are on the network.
   ═══════════════════════════════════════════════════════════════════════════ */
import { describe, it, expect } from "vitest";
import { getRoleDashboard } from "./useAuth";
import { isActiveCreator } from "../lib/creator-access";

const active = (role: "creator_admin" | "team_lead" | "creator") =>
  ({ creator_role: role, status: "active" } as const);

describe("where a Creator Network member lands after signing in", () => {
  it("sends a Creator Admin to the Media Ops app, not the Knowledge Hub", () => {
    expect(getRoleDashboard("user", "creator", active("creator_admin"))).toBe("/media");
  });

  it("sends a Team Lead to the Media Ops app", () => {
    expect(getRoleDashboard("user", "creator", active("team_lead"))).toBe("/media");
  });

  it("sends a creator to the Media Ops app", () => {
    expect(getRoleDashboard("user", "creator", active("creator"))).toBe("/media");
  });

  /* Status decides membership, not the team column and not a module grant.
     A suspended creator is no longer a member, so they must not be sent into
     the network — the server would refuse them anyway (§25). */
  it("does not send a suspended creator into the network", () => {
    expect(getRoleDashboard("user", "creator", { creator_role: "creator", status: "suspended" }))
      .not.toBe("/media");
  });

  it("does not send an archived creator into the network", () => {
    expect(getRoleDashboard("user", "creator", { creator_role: "creator", status: "archived" }))
      .not.toBe("/media");
  });

  /* Media Ops staff enrolled as a Creator Admin keep their own way in. */
  it("leaves a Media Ops admin on /media", () => {
    expect(getRoleDashboard("admin", "media", active("creator_admin"))).toBe("/media");
    expect(getRoleDashboard("admin", "media", null)).toBe("/media");
  });
});

describe("everybody else is exactly where they were", () => {
  it("an ordinary branding user still gets the Knowledge Hub", () => {
    expect(getRoleDashboard("user", "branding", null)).toBe("/branding/user");
  });
  it("a content user still gets the content dashboard", () => {
    expect(getRoleDashboard("user", "content", null)).toBe("/content/user");
  });
  it("a design user still gets the design dashboard", () => {
    expect(getRoleDashboard("user", "design", null)).toBe("/design/user");
  });
  it("a super admin still gets the super admin dashboard", () => {
    expect(getRoleDashboard("super_admin", null, null)).toBe("/super-admin/dashboard");
  });
  it("an SMC member still gets Media Ops", () => {
    expect(getRoleDashboard("user", "smc", null)).toBe("/media");
  });
  it("an outreach manager is untouched", () => {
    expect(getRoleDashboard("outreach_manager", "outreach", null)).toBe("/outreach/dashboard");
  });

  /* The Creator Network is not reachable by being on the creator team alone —
     without a profile there is nothing to be a member of. */
  it("someone on the creator team with no profile does not reach the network", () => {
    expect(getRoleDashboard("user", "creator", null)).not.toBe("/media");
  });
});

/* ── Media Ops staff who are also on the network ─────────────────────────
   The two identities coexist: a Nerve Admin can hold a Creator Admin profile
   while staying on team='media'. They keep the full Media Ops app — the
   Creator Network is one module inside it, not a replacement for it. */
describe("staff enrolled on the network keep their own application", () => {
  const enrolled = { creator_role: 'creator_admin', status: 'active' } as const

  it("a media-team Creator Admin still resolves to /media", () => {
    expect(getRoleDashboard('admin', 'media', enrolled)).toBe('/media')
    expect(getRoleDashboard('sub_admin', 'media', enrolled)).toBe('/media')
  })

  /* The creator-only shell is chosen by the same predicate the redirect uses,
     so pin it here: being on the media team disqualifies you from it however
     the profile reads. */
  const creatorOnly = (team: string | null, creator: unknown) =>
    isActiveCreator(creator as never) && team !== 'media' && team !== 'smc'

  it("but they do NOT get the creator-only shell", () => {
    expect(creatorOnly('media', enrolled)).toBe(false)
    expect(creatorOnly('smc', enrolled)).toBe(false)
  })

  it("while an ordinary creator does", () => {
    expect(creatorOnly('creator', { creator_role: 'creator', status: 'active' })).toBe(true)
    expect(creatorOnly('creator', { creator_role: 'creator', status: 'suspended' })).toBe(false)
    expect(creatorOnly('creator', null)).toBe(false)
  })
})
