// @vitest-environment node
/* The three Phase 3 tools, with the Nerve service mocked. These assert the tool
   CONTRACT — scoping, shape, self-scoping, bounding. Whether the service returns
   the right rows is proven separately, against a real database, in
   server/mediaops-queries.integration.test.ts. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const findOverdueDeliverables = vi.fn();
const getMyDay = vi.fn();
const getUserIdentity = vi.fn();

vi.mock("../../mediaops-queries.js", () => ({
  findOverdueDeliverables: (...a: unknown[]) => findOverdueDeliverables(...a),
  getMyDay: (...a: unknown[]) => getMyDay(...a),
  getUserIdentity: (...a: unknown[]) => getUserIdentity(...a),
}));

const { getCurrentUserTool, getMyDayTool, getOverdueDeliverablesTool, nerveTools } =
  await import("./nerve-tools.js");
const { AiToolRegistry } = await import("./registry.js");
import type { AiCapability, AiUserContext } from "../types.js";

const ctx = { requestId: "req-1", signal: new AbortController().signal };

const asUser = (o: Partial<AiUserContext> & { id: string }): AiUserContext => ({
  role: "employee",
  capabilities: new Set<AiCapability>(["media.read", "myday.read", "projects.read"]),
  projectScope: "own",
  ...o,
});

const employee = asUser({ id: "mo-u9" });
const teamLead = asUser({ id: "mo-u2", role: "team_lead", projectScope: "all" });
const admin = asUser({ id: "mo-u1", role: "admin", projectScope: "all" });
const smcMember = asUser({
  id: "smc-1", role: "employee", projectScope: "own",
  // SMC default modules are home / my-day / leave — no "projects".
  capabilities: new Set<AiCapability>(["media.read", "myday.read"]),
});

beforeEach(() => {
  getUserIdentity.mockResolvedValue({
    id: "mo-u9", full_name: "Priya Shah", role: "user", team: "media", designation: "Videographer",
  });
  getMyDay.mockResolvedValue({
    date: "2026-08-21",
    report: { status: "draft", taskCount: 2, totalMinutes: 210 },
    items: [{ source: "shoot", id: 3, title: "Convocation", projectCode: "PRJ-1",
              projectName: "Convocation 2026", status: "planned", priority: null,
              dueDate: "2026-08-21", startTime: "09:00" }],
  });
  findOverdueDeliverables.mockResolvedValue([]);
});
afterEach(() => { vi.clearAllMocks(); });

/* ── get_current_user ──────────────────────────────────────────────────── */
describe("18. get_current_user", () => {
  it("1–3. answers for an employee, a team lead and an admin", async () => {
    for (const u of [employee, teamLead, admin]) {
      getUserIdentity.mockResolvedValueOnce({
        id: u.id, full_name: "Someone", role: "user", team: "media", designation: "Editor" });
      const r = await getCurrentUserTool.run(u, {}, ctx);
      expect(getUserIdentity).toHaveBeenCalledWith(u.id);
      expect((r.data as { role: string }).role).toBe(u.role);
    }
  });

  it("4. answers for an SMC member using the same identity model", async () => {
    getUserIdentity.mockResolvedValueOnce({
      id: "smc-1", full_name: "Institute Rep", role: "user", team: "smc", designation: "SMC Member" });
    const r = await getCurrentUserTool.run(smcMember, {}, ctx);
    expect((r.data as { team: string }).team).toBe("smc");
  });

  it("5. surfaces a clean error when the record cannot be read", async () => {
    getUserIdentity.mockResolvedValueOnce(null);
    await expect(getCurrentUserTool.run(employee, {}, ctx)).rejects.toThrow(/could not be read/);
  });

  it("6. returns no sensitive field", async () => {
    getUserIdentity.mockResolvedValueOnce({
      id: "mo-u9", full_name: "Priya Shah", role: "user", team: "media", designation: "Videographer" });
    const json = JSON.stringify((await getCurrentUserTool.run(employee, {}, ctx)).data);
    for (const banned of ["password", "password_hash", "email", "phone", "token", "secret",
                          "allowed_modules", "capabilities"])
      expect(json.toLowerCase()).not.toContain(banned);
  });

  it("7. cannot be pointed at another user — it takes no arguments", async () => {
    expect((getCurrentUserTool.parametersJsonSchema as { properties?: object }).properties ?? {}).toEqual({});
    // Even if a model smuggles one through, the schema rejects it before run().
    expect(getCurrentUserTool.params.safeParse({ user_id: "mo-u1" }).success).toBe(false);
    await getCurrentUserTool.run(employee, {}, ctx);
    expect(getUserIdentity).toHaveBeenCalledWith("mo-u9");     // always the caller
  });
});

/* ── get_my_day ────────────────────────────────────────────────────────── */
describe("19. get_my_day", () => {
  it("1–2. returns the caller's own day for an employee and a team lead", async () => {
    await getMyDayTool.run(employee, {}, ctx);
    expect(getMyDay).toHaveBeenCalledWith("mo-u9");
    await getMyDayTool.run(teamLead, {}, ctx);
    expect(getMyDay).toHaveBeenCalledWith("mo-u2");
  });

  it("3. serves an SMC member, who holds my-day by default", async () => {
    expect(smcMember.capabilities.has("myday.read")).toBe(true);
    await getMyDayTool.run(smcMember, {}, ctx);
    expect(getMyDay).toHaveBeenCalledWith("smc-1");
  });

  it("4. cannot be asked for another employee's day", async () => {
    expect((getMyDayTool.parametersJsonSchema as { properties?: object }).properties ?? {}).toEqual({});
    for (const attempt of [{ user_id: "mo-u1" }, { employeeId: "mo-u1" }, { memberId: "x" }, { date: "2020-01-01" }])
      expect(getMyDayTool.params.safeParse(attempt).success).toBe(false);
    await getMyDayTool.run(employee, {}, ctx);
    expect(getMyDay).toHaveBeenCalledTimes(1);
    expect(getMyDay).toHaveBeenCalledWith("mo-u9");            // never a supplied id
  });

  it("5. reports the date the service resolved, never one it computed itself", async () => {
    const r = await getMyDayTool.run(employee, {}, ctx);
    expect((r.data as { date: string }).date).toBe("2026-08-21");
  });

  it("7–9. carries assignments, deliverables, shoots and the report summary", async () => {
    const d = (await getMyDayTool.run(employee, {}, ctx)).data as {
      items: Array<{ source: string }>; report: { status: string; taskCount: number }; itemCount: number };
    expect(d.items[0].source).toBe("shoot");
    expect(d.report).toEqual({ status: "draft", taskCount: 2, totalMinutes: 210 });
    expect(d.itemCount).toBe(1);
  });

  it("10. declares a row ceiling", () => {
    expect(getMyDayTool.limit?.maxRows).toBe(40);
  });

  it("leaks no task descriptions or internal ids beyond what the shape declares", async () => {
    const d = (await getMyDayTool.run(employee, {}, ctx)).data as Record<string, unknown>;
    expect(Object.keys(d).sort()).toEqual(["date", "itemCount", "items", "report"]);
  });
});

/* ── get_overdue_deliverables ──────────────────────────────────────────── */
describe("20–21. get_overdue_deliverables scoping", () => {
  const row = (o: Partial<Record<string, unknown>> = {}) => ({
    id: 1, title: "Aftermovie", status: "in_progress", priority: "high",
    dueDate: "2026-08-01", daysOverdue: 20, ownerId: "mo-u9", ownerName: "Priya Shah",
    projectId: 7, projectCode: "PRJ-7", projectName: "Convocation", projectManagerId: "mo-u2", ...o,
  });

  it("an employee is scoped to their own work and projects", async () => {
    await getOverdueDeliverablesTool.run(employee, {}, ctx);
    expect(findOverdueDeliverables).toHaveBeenCalledWith({ kind: "user", userId: "mo-u9" });
  });

  it("a team lead and an admin get the departmental scope Nerve resolved", async () => {
    await getOverdueDeliverablesTool.run(teamLead, {}, ctx);
    expect(findOverdueDeliverables).toHaveBeenLastCalledWith({ kind: "all" });
    await getOverdueDeliverablesTool.run(admin, {}, ctx);
    expect(findOverdueDeliverables).toHaveBeenLastCalledWith({ kind: "all" });
  });

  it("Employee A can never be given Employee B's scope", async () => {
    const a = asUser({ id: "emp-A" }), b = asUser({ id: "emp-B" });
    await getOverdueDeliverablesTool.run(a, {}, ctx);
    expect(findOverdueDeliverables).toHaveBeenLastCalledWith({ kind: "user", userId: "emp-A" });
    await getOverdueDeliverablesTool.run(b, {}, ctx);
    expect(findOverdueDeliverables).toHaveBeenLastCalledWith({ kind: "user", userId: "emp-B" });
  });

  it("scope comes from the resolved context, not from the role string", async () => {
    // A tampered role must not widen anything: projectScope is what decides.
    const spoofed = asUser({ id: "emp-A", role: "admin", projectScope: "own" });
    await getOverdueDeliverablesTool.run(spoofed, {}, ctx);
    expect(findOverdueDeliverables).toHaveBeenCalledWith({ kind: "user", userId: "emp-A" });
  });

  it("cannot be widened through a parameter — there are none", () => {
    expect((getOverdueDeliverablesTool.parametersJsonSchema as { properties?: object }).properties ?? {}).toEqual({});
    for (const attempt of [{ scope: "all" }, { userId: "mo-u1" }, { projectId: 1 }, { limit: 9999 }])
      expect(getOverdueDeliverablesTool.params.safeParse(attempt).success).toBe(false);
  });

  it("reports the scope it actually used", async () => {
    findOverdueDeliverables.mockResolvedValue([row()]);
    const emp = (await getOverdueDeliverablesTool.run(employee, {}, ctx)).data as { scope: string };
    expect(emp.scope).toBe("own_work_and_projects");
    const adm = (await getOverdueDeliverablesTool.run(admin, {}, ctx)).data as { scope: string };
    expect(adm.scope).toBe("department");
  });

  it("shapes each row for a model, with no internal identifiers beyond the id", async () => {
    findOverdueDeliverables.mockResolvedValue([row()]);
    const d = (await getOverdueDeliverablesTool.run(employee, {}, ctx)).data as {
      total: number; deliverables: Array<Record<string, unknown>> };
    expect(d.total).toBe(1);
    expect(Object.keys(d.deliverables[0]).sort()).toEqual(
      ["daysOverdue", "dueDate", "id", "isOwnedByMe", "owner", "priority", "project", "status", "title"]);
    expect(d.deliverables[0].project).toBe("PRJ-7 — Convocation");
    expect(d.deliverables[0].isOwnedByMe).toBe(true);
    // The PM's user id is an internal routing detail AUTO-2 needs; a model does not.
    expect(JSON.stringify(d.deliverables[0])).not.toContain("mo-u2");
  });

  it("15. bounds a large result and reports the true total", async () => {
    findOverdueDeliverables.mockResolvedValue(
      Array.from({ length: 214 }, (_, i) => row({ id: i + 1 })));
    const r = await getOverdueDeliverablesTool.run(admin, {}, ctx);
    const d = r.data as { total: number; deliverables: unknown[] };
    expect(d.deliverables).toHaveLength(50);
    expect(d.total).toBe(214);                   // scale is still reported honestly
    expect(r.truncated).toBe(true);
    expect(r.note).toContain("214");
  });

  it("returns an empty, honest result rather than nothing", async () => {
    findOverdueDeliverables.mockResolvedValue([]);
    const r = await getOverdueDeliverablesTool.run(employee, {}, ctx);
    expect(r.data).toMatchObject({ total: 0, deliverables: [] });
    expect(r.truncated).toBeFalsy();
  });
});

/* ── capability gating end to end ──────────────────────────────────────── */
describe("21. an unauthorized caller cannot invoke a tool by naming it", () => {
  const registry = new AiToolRegistry().registerAll(nerveTools());

  it("10. an SMC member without the projects module is refused overdue deliverables", () => {
    expect(registry.definitionsFor(smcMember).map((d) => d.name).sort())
      .toEqual(["get_current_user", "get_my_day"]);
    expect(registry.resolveFor(smcMember, "get_overdue_deliverables"))
      .toEqual({ ok: false, reason: "unauthorized" });
  });

  it("a user with no capabilities is refused all three", () => {
    const nobody = asUser({ id: "x", capabilities: new Set<AiCapability>() });
    expect(registry.definitionsFor(nobody)).toEqual([]);
    for (const n of ["get_current_user", "get_my_day", "get_overdue_deliverables"])
      expect(registry.resolveFor(nobody, n)).toEqual({ ok: false, reason: "unauthorized" });
  });

  it("declares the capability each tool actually needs", () => {
    expect(getCurrentUserTool.requires).toBe("media.read");
    expect(getMyDayTool.requires).toBe("myday.read");
    expect(getOverdueDeliverablesTool.requires).toBe("projects.read");
  });
});
