/**
 * Who may see which outreach data (PRD 6.1 / 6.3).
 *
 * WHAT WAS WRONG. The influencer API had one check, a role allowlist
 * (outreach_manager, super_admin), used for reads and writes alike. A
 * Publisher — whom the product owner names a full influencer admin — got 403
 * on every page, campaign and post, and there was no way to give anyone read
 * access to some states without also giving them every write.
 *
 * THE RULE, read fresh from the database on every request so a change of
 * role or of assigned states applies on the very next call, with no cache to
 * go stale:
 *   - super_admin, outreach_manager, outreach_publisher (team outreach): ALL.
 *   - outreach_state_user (team outreach): the states in outreach_user_states,
 *     possibly none. No states means seeing nothing, never everything.
 *   - anyone else: refused. That includes a Nerve "admin" — the outreach
 *     Admin is the video workflow's Admin only, and another department's
 *     admin has no business in outreach data at all.
 *
 * Editing is narrower than reading: State Users are strictly read-only.
 */
import { listUserStates } from "./outreach-db.js";

export type OutreachScope =
  | { kind: "all" }
  | { kind: "states"; states: string[] };

export interface ScopeSubject {
  id: string;
  role: string;
  team: string | null;
}

export const OUTREACH_STATE_USER_ROLE = "outreach_state_user";

/** Which kind of access a person has, before any state is read; null = none. */
export function outreachAccessKind(user: Pick<ScopeSubject, "role" | "team"> | null | undefined): OutreachScope["kind"] | null {
  if (!user) return null;
  if (user.role === "super_admin") return "all";
  /* No team check for the manager: requireOutreach never had one, and
     narrowing it here would lock out whoever it currently admits. */
  if (user.role === "outreach_manager") return "all";
  if (user.team !== "outreach") return null;
  if (user.role === "outreach_publisher") return "all";
  if (user.role === OUTREACH_STATE_USER_ROLE) return "states";
  return null;
}

/** Whether this person may create, change, delete or sync influencer data. */
export function mayEditOutreach(user: Pick<ScopeSubject, "role" | "team"> | null | undefined): boolean {
  return outreachAccessKind(user) === "all";
}

/** The person's scope, or null when they have no influencer access at all. */
export async function resolveOutreachScope(user: ScopeSubject | null | undefined): Promise<OutreachScope | null> {
  const kind = outreachAccessKind(user);
  if (kind === null || !user) return null;
  if (kind === "all") return { kind: "all" };
  return { kind: "states", states: await listUserStates(user.id) };
}

/** Whether a record carrying `state` is visible under `scope`. */
export function stateInScope(scope: OutreachScope, state: string | null | undefined): boolean {
  return scope.kind === "all" || scope.states.includes(state ?? "");
}
