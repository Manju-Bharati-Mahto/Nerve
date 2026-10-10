/**
 * Who may open which outreach tab, at which level, and for which states.
 *
 * Account Tabs & State-wise Analytics requirements (§1, §2), which replace the
 * earlier role-only rule. Read fresh from the database on every request, so a
 * change an admin saves applies to the very next call, with no cache to go
 * stale:
 *
 *   - super_admin and outreach_manager are the outreach ADMINS: every tab at
 *     Edit, every state, and the only people who add users or choose anyone's
 *     tabs and states. They are never configured.
 *   - everyone else on the outreach team is either CONFIGURED (an admin saved
 *     their tabs — they get exactly those, and only the states assigned to
 *     them, or every state when "All States" was chosen) or NOT YET
 *     CONFIGURED, in which case they keep exactly what their role gave them
 *     before tabs were choosable: the original role checks still decide.
 *   - nobody outside the outreach team has outreach access. That includes a
 *     Nerve "admin" on another team.
 *
 * A configured person with no states sees no state data at all — never
 * everything. "Users must not be able to access data or analytics for any
 * state other than the one assigned to them."
 */
import { getUserAccess, listUserStates } from "./outreach-db.js";
import { listUserCapabilities } from "./db.js";
import {
  OUTREACH_TABS, defaultTabLevels, levelAtLeast,
  type OutreachTabLevel,
} from "./outreach-tabs.js";

export type OutreachScope =
  | { kind: "all" }
  | { kind: "states"; states: string[] };

export interface ScopeSubject {
  id: string;
  role: string;
  team: string | null;
}

export const OUTREACH_STATE_USER_ROLE = "outreach_state_user";

export interface OutreachAccess {
  admin: boolean;
  /** True once an admin has saved this person's tabs. */
  configured: boolean;
  /** Tab id → level. For an admin, every tab at Edit. For the unconfigured, what their role effectively gives. */
  tabs: Record<string, OutreachTabLevel>;
  scope: OutreachScope;
}

export const INFLUENCER_TAB_IDS: readonly string[] = OUTREACH_TABS.filter(t => t.group === "influencer").map(t => t.id);
const ALL_EDIT = Object.fromEntries(OUTREACH_TABS.map(t => [t.id, "edit" as const]));

/** super_admin and outreach_manager — the people who administer outreach. */
export function isOutreachAdmin(user: Pick<ScopeSubject, "role"> | null | undefined): boolean {
  /* No team check for the manager: the influencer guard never had one, and
     narrowing it here would lock out whoever it currently admits. */
  return user?.role === "super_admin" || user?.role === "outreach_manager";
}

/** Everything about one person's outreach access, or null when they have none. */
export async function resolveOutreachAccess(user: ScopeSubject | null | undefined): Promise<OutreachAccess | null> {
  if (!user) return null;
  if (isOutreachAdmin(user)) return { admin: true, configured: false, tabs: { ...ALL_EDIT }, scope: { kind: "all" } };
  if (user.team !== "outreach") return null;

  const saved = await getUserAccess(user.id);
  if (saved) {
    return {
      admin: false,
      configured: true,
      tabs: saved.tabs,
      scope: saved.allStates ? { kind: "all" } : { kind: "states", states: await listUserStates(user.id) },
    };
  }
  const legacy = (await listUserCapabilities(user.id)).filter(k => k.startsWith("outreach:"));
  return {
    admin: false,
    configured: false,
    tabs: defaultTabLevels(user.role, legacy),
    /* Not yet configured: no influencer tab is open to them (only admins had
       those), so this scope never reaches influencer data. The video
       workflow, which predates states, does not narrow by it for them — see
       the social-pages route. */
    scope: { kind: "states", states: await listUserStates(user.id) },
  };
}

/** Whether `access` reaches any of `tabs` at `level`. */
export function hasTab(access: OutreachAccess | null | undefined, tabs: string | readonly string[], level: OutreachTabLevel): boolean {
  if (!access) return false;
  if (access.admin) return true;
  return (typeof tabs === "string" ? [tabs] : tabs).some(id => levelAtLeast(access.tabs[id], level));
}

/**
 * Whether `access` may read influencer data at all. Influencer tabs were
 * admin-only before tabs were choosable, so an unconfigured person never has
 * one; they get one the moment an admin configures them with it.
 */
export function readsInfluencer(access: OutreachAccess | null | undefined): boolean {
  if (!access) return false;
  return access.admin || (access.configured && hasTab(access, INFLUENCER_TAB_IDS, "view"));
}

/** The person's influencer-data scope, or null when they may open no influencer tab at all. */
export async function resolveOutreachScope(user: ScopeSubject | null | undefined): Promise<OutreachScope | null> {
  const access = await resolveOutreachAccess(user);
  return readsInfluencer(access) ? access!.scope : null;
}

/** Whether a record carrying `state` is visible under `scope`. */
export function stateInScope(scope: OutreachScope, state: string | null | undefined): boolean {
  return scope.kind === "all" || scope.states.includes(state ?? "");
}

/**
 * Whether `actor` may create an account with role outreach_state_user on
 * `team`.
 *
 * WHY A RULE OF ITS OWN. canCreateManagedUser's admin branch only checks that
 * the new account is on the admin's own team, never that the team is
 * outreach, so the State User is decided here, outreach-only, before the
 * shared lists are consulted:
 *   - the account must be on team outreach (on any other team it could never
 *     see anything);
 *   - the actor must be an outreach admin — super_admin or outreach_manager.
 *     The requirements make them the only people who add users.
 */
export function mayCreateOutreachStateUser(
  actor: Pick<ScopeSubject, "role" | "team"> | null | undefined,
  team: string | null | undefined,
): boolean {
  if (!actor || team !== "outreach") return false;
  if (actor.role === "super_admin") return true;
  return actor.role === "outreach_manager" && actor.team === "outreach";
}
