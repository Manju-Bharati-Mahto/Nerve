/* ═══════════════════════════════════════════════════════════════════════════
   THE FIRST REAL NERVE TOOLS

   Three tools, chosen to prove the whole path rather than to be useful yet:
   identity (no data), one's own day (self-scoped), and overdue deliverables
   (the first genuinely scoped read).

   BOUNDARY — these call the shared query service in server/mediaops-queries.ts.
   There is no pool, no SQL and no table name in this file. The service owns the
   query; this file owns the SHAPE the model sees, which is a different job and
   deliberately a separate one: a tool exists to hand a model the smallest true
   answer, not to hand it a row.

   NO BUSINESS LOGIC — nothing here decides that someone is overloaded or that a
   project is failing. It reports what Nerve already computed. Interpretation is
   the model's job, and it is labelled as interpretation when it happens.
   ═══════════════════════════════════════════════════════════════════════════ */

import { z, toJSONSchema } from "zod/v4";
import {
  findOverdueDeliverables, getMyDay, getUserIdentity,
  type DeliverableScope,
} from "../../mediaops-queries.js";
import { AiProviderError } from "../errors.js";
import type { AiTool, AiUserContext } from "../types.js";

/* Every tool in this slice is parameterless. That is a security posture, not an
   oversight: with no arguments there is no argument through which a model could
   influence whose data is returned. Scope comes from the authenticated context
   and nowhere else. */
const NO_PARAMS = z.object({}).strict();
const NO_PARAMS_JSON = toJSONSchema(NO_PARAMS) as Record<string, unknown>;

/** Nerve resolves the scope; the tool only translates it for the query layer. */
const scopeFor = (user: AiUserContext): DeliverableScope =>
  user.projectScope === "all" ? { kind: "all" } : { kind: "user", userId: user.id };

/* ── 1. get_current_user ──────────────────────────────────────────────────
   Who is asking. Takes no id and offers no way to name anyone else, so it can
   never become a directory lookup. Returns the fields a model needs to address
   someone correctly and reason about their role — and nothing that would be a
   problem in a prompt: no email, no phone, no profile, no permissions. */
export const getCurrentUserTool: AiTool<Record<string, never>> = {
  name: "get_current_user",
  description:
    "Get the identity of the person asking: their name, Nerve role, team and designation. "
    + "Always returns the authenticated caller — it cannot look up anyone else.",
  params: NO_PARAMS,
  parametersJsonSchema: NO_PARAMS_JSON,
  requires: "media.read",
  async run(user) {
    const identity = await getUserIdentity(user.id);
    if (!identity) throw new AiProviderError("provider_error", "That user record could not be read.");
    return {
      data: {
        id: identity.id,
        name: identity.full_name,
        // The media-ops role vocabulary, which is what the rest of Nerve speaks.
        role: user.role,
        platformRole: identity.role,
        team: identity.team,
        designation: identity.designation,
      },
    };
  },
};

/* ── 2. get_my_day ────────────────────────────────────────────────────────
   The caller's own scheduled day, from the same tables the My Day page reads.

   Self-scoped by construction rather than by a check: getMyDay() takes a user id
   and this tool passes the authenticated one. There is no parameter to override.

   No date parameter. The service supports one — the My Day page is date-aware —
   but a first slice does not need it, and leaving it out means the model cannot
   walk backwards through someone's calendar. Today only. */
export const getMyDayTool: AiTool<Record<string, never>> = {
  name: "get_my_day",
  description:
    "Get what the person asking has scheduled TODAY: their assignments, deliverables "
    + "scheduled for today, shoots they are crewed on, and whether they have logged "
    + "and submitted today's report. Always their own day — it cannot return anyone else's.",
  params: NO_PARAMS,
  parametersJsonSchema: NO_PARAMS_JSON,
  requires: "myday.read",
  // A day holds a handful of items; this ceiling is a backstop, not a filter.
  limit: { maxRows: 40 },
  async run(user) {
    const day = await getMyDay(user.id);
    return {
      data: {
        date: day.date,
        report: day.report,
        itemCount: day.items.length,
        items: day.items,
      },
    };
  },
};

/* ── 3. get_overdue_deliverables ──────────────────────────────────────────
   The first genuinely scoped read.

   The overdue DEFINITION is AUTO-2's, shared through findOverdueDeliverables()
   so the automation and this tool can never disagree about what "overdue" is.
   The SCOPE comes from the resolved context, so this tool cannot widen it.

   Reports facts only: a due date, a day count, an owner. Whether that is "a
   problem" is interpretation, and belongs to the model. */
export const getOverdueDeliverablesTool: AiTool<Record<string, never>> = {
  name: "get_overdue_deliverables",
  description:
    "List deliverables that are past their due date and not yet delivered, limited to what "
    + "the person asking is permitted to see. Returns each deliverable's title, project, "
    + "owner, due date and how many days it is overdue. A deliverable due today is not overdue.",
  params: NO_PARAMS,
  parametersJsonSchema: NO_PARAMS_JSON,
  requires: "projects.read",
  limit: { maxRows: 50 },
  async run(user) {
    const scope = scopeFor(user);
    const all = await findOverdueDeliverables(scope);
    const MAX = 50;
    const shown = all.slice(0, MAX);
    return {
      data: {
        total: all.length,
        // Stated so the model can say whose overdue work it is looking at rather
        // than implying it saw everything.
        scope: scope.kind === "all" ? "department" : "own_work_and_projects",
        deliverables: shown.map((d) => ({
          id: d.id,
          title: d.title,
          project: d.projectCode ? `${d.projectCode} — ${d.projectName}` : d.projectName,
          owner: d.ownerName,
          isOwnedByMe: d.ownerId === user.id,
          dueDate: d.dueDate,
          daysOverdue: d.daysOverdue,
          status: d.status,
          priority: d.priority,
        })),
      },
      truncated: all.length > shown.length,
      ...(all.length > shown.length
        ? { note: `Showing the ${shown.length} most overdue of ${all.length}.` }
        : {}),
    };
  },
};

/** Every real tool in this phase. Registered by createAiToolRegistry(). */
export function nerveTools(): AiTool<never>[] {
  return [
    getCurrentUserTool as unknown as AiTool<never>,
    getMyDayTool as unknown as AiTool<never>,
    getOverdueDeliverablesTool as unknown as AiTool<never>,
  ];
}
