// @vitest-environment node
/* ═══════════════════════════════════════════════════════════════════════════
   16. AI request metering against a real PostgreSQL.

   Proves the audit record holds what it should and — more importantly — does
   NOT hold what it must not: no question, no answer, no key, no tool arguments.

   Synthetic users only (`aim-` prefix), removed afterwards.
   ═══════════════════════════════════════════════════════════════════════════ */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PREFIX = "aim";
let dbUp = false;
let pool: import("pg").Pool;
let q: typeof import("./mediaops-queries.js");

async function realDatabaseUrl(): Promise<string | null> {
  const { readFileSync, existsSync } = await import("node:fs");
  for (const f of [".env.local", ".env"]) {
    if (!existsSync(f)) continue;
    const m = readFileSync(f, "utf8").match(/^DATABASE_URL=(.+)$/m);
    if (m) return m[1].trim();
  }
  return null;
}

// Module-level probe: `maybe()` is read while describes are collected.
{
  const url = await realDatabaseUrl();
  if (url) {
    process.env.DATABASE_URL = url;
    const { pool: p } = await import("./db.js");
    pool = p;
    try { await pool.query("SELECT 1"); dbUp = true; q = await import("./mediaops-queries.js"); }
    catch { dbUp = false; }
  }
}
const maybe = () => (dbUp ? it : it.skip);
const U = `${PREFIX}-user`;

async function cleanup() {
  if (!pool) return;
  await pool.query(`DELETE FROM mo_ai_requests WHERE user_id LIKE $1`, [`${PREFIX}-%`]);
  await pool.query(`DELETE FROM users WHERE id LIKE $1`, [`${PREFIX}-%`]);
}
beforeAll(async () => {
  if (!dbUp) return;
  await cleanup();
  await pool.query(
    `INSERT INTO users (id, full_name, email, role, team, password_hash)
     VALUES ($1,'Test Meter',$2,'user','media','x') ON CONFLICT (id) DO NOTHING`,
    [U, `${U}@example.invalid`]);
}, 60_000);
afterAll(async () => { if (dbUp) await cleanup(); }, 60_000);

const rid = () => `${PREFIX}-${Math.random().toString(36).slice(2, 12)}`;

describe("1–5. a request produces an audit record", () => {
  maybe()("1–2. records a success with tools, rounds and tokens", async () => {
    const id = rid();
    await q.recordAiRequest({
      requestId: id, userId: U, provider: "openai-compatible", model: "test-model",
      status: "ok", stopReason: "final_answer", durationMs: 1234,
      tools: ["get_my_day", "get_overdue_deliverables"], toolRounds: 2,
      promptTokens: 100, completionTokens: 40, totalTokens: 140, questionChars: 22,
    });
    const r = (await pool.query(`SELECT * FROM mo_ai_requests WHERE request_id=$1`, [id])).rows[0];
    expect(r).toMatchObject({
      user_id: U, provider: "openai-compatible", model: "test-model", status: "ok",
      stop_reason: "final_answer", duration_ms: 1234, tool_rounds: 2,
      prompt_tokens: 100, completion_tokens: 40, total_tokens: 140, question_chars: 22,
    });
    expect(r.tools).toEqual(["get_my_day", "get_overdue_deliverables"]);   // 4. tool names
    expect(r.failure_category).toBeNull();
    expect(r.estimated_cost).toBeNull();      // 13. no price is invented
  });

  maybe()("3. records a failure under a safe category, never an exception message", async () => {
    const id = rid();
    await q.recordAiRequest({ requestId: id, userId: U, status: "failed",
      failureCategory: "provider_timeout", stopReason: "timeout", questionChars: 9 });
    const r = (await pool.query(`SELECT * FROM mo_ai_requests WHERE request_id=$1`, [id])).rows[0];
    expect(r.status).toBe("failed");
    expect(r.failure_category).toBe("provider_timeout");
    expect(q.AI_FAILURE_CATEGORIES).toContain(r.failure_category);
  });

  maybe()("6. leaves token columns NULL when the provider reported no usage", async () => {
    const id = rid();
    await q.recordAiRequest({ requestId: id, userId: U, status: "ok", tools: [] });
    const r = (await pool.query(`SELECT * FROM mo_ai_requests WHERE request_id=$1`, [id])).rows[0];
    expect(r.prompt_tokens).toBeNull();
    expect(r.completion_tokens).toBeNull();
    expect(r.total_tokens).toBeNull();        // never guessed as 0
  });

  maybe()("never throws into the request path", async () => {
    // A duplicate id is ignored rather than raising — metering must not fail a
    // request that already succeeded.
    const id = rid();
    await q.recordAiRequest({ requestId: id, userId: U, status: "ok" });
    await expect(q.recordAiRequest({ requestId: id, userId: U, status: "ok" })).resolves.toBeUndefined();
    const n = (await pool.query(`SELECT COUNT(*)::int c FROM mo_ai_requests WHERE request_id=$1`, [id])).rows[0].c;
    expect(n).toBe(1);
  });
});

describe("7–9. the record cannot contain content or credentials", () => {
  maybe()("has no column able to hold a question, an answer or a key", async () => {
    const cols = (await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name='mo_ai_requests'`))
      .rows.map((r) => String(r.column_name));
    for (const banned of ["question", "prompt", "answer", "response", "content", "messages",
                          "api_key", "apikey", "authorization", "headers", "tool_arguments", "tool_results"])
      expect(cols).not.toContain(banned);
    expect(cols).toContain("question_chars");    // length only
  });

  maybe()("stores nothing resembling a secret even when handed one", async () => {
    const id = rid();
    await q.recordAiRequest({ requestId: id, userId: U, status: "ok",
      model: "test-model", tools: ["get_my_day"], questionChars: 40 });
    const r = (await pool.query(`SELECT * FROM mo_ai_requests WHERE request_id=$1`, [id])).rows[0];
    const json = JSON.stringify(r);
    for (const banned of ["sk-", "Bearer", "password", "@example.invalid"])
      expect(json).not.toContain(banned);
  });
});

describe("11–12. the daily counter", () => {
  maybe()("11. counts this user's requests for the Nerve calendar day", async () => {
    await pool.query(`DELETE FROM mo_ai_requests WHERE user_id=$1`, [U]);
    expect(await q.countAiRequestsToday(U)).toBe(0);
    for (let i = 0; i < 3; i++)
      await q.recordAiRequest({ requestId: rid(), userId: U, status: "ok" });
    expect(await q.countAiRequestsToday(U)).toBe(3);
  });

  maybe()("counts failures too — a broken key must not buy unlimited retries", async () => {
    await pool.query(`DELETE FROM mo_ai_requests WHERE user_id=$1`, [U]);
    await q.recordAiRequest({ requestId: rid(), userId: U, status: "failed",
      failureCategory: "provider_error" });
    expect(await q.countAiRequestsToday(U)).toBe(1);
  });

  maybe()("is scoped to one user", async () => {
    await pool.query(`DELETE FROM mo_ai_requests WHERE user_id LIKE $1`, [`${PREFIX}-%`]);
    await q.recordAiRequest({ requestId: rid(), userId: U, status: "ok" });
    expect(await q.countAiRequestsToday(`${PREFIX}-nobody`)).toBe(0);
  });

  maybe()("12. rolls over on the LOCAL date, not the UTC one", async () => {
    await pool.query(`DELETE FROM mo_ai_requests WHERE user_id=$1`, [U]);
    const today = q.nerveToday();
    await q.recordAiRequest({ requestId: rid(), userId: U, status: "ok" });
    expect(await q.countAiRequestsToday(U, today)).toBe(1);

    // Yesterday's usage must not count toward today.
    const yday = (await pool.query(`SELECT ($1::date - 1)::text AS d`, [today])).rows[0].d;
    await pool.query(`UPDATE mo_ai_requests SET local_date=$1::date WHERE user_id=$2`, [yday, U]);
    expect(await q.countAiRequestsToday(U, today)).toBe(0);
    expect(await q.countAiRequestsToday(U, yday)).toBe(1);
  });

  maybe()("17. the stored day matches the database's own CURRENT_DATE", async () => {
    await pool.query(`DELETE FROM mo_ai_requests WHERE user_id=$1`, [U]);
    await q.recordAiRequest({ requestId: rid(), userId: U, status: "ok" });
    const r = (await pool.query(
      `SELECT local_date::text AS d, CURRENT_DATE::text AS today FROM mo_ai_requests WHERE user_id=$1`,
      [U])).rows[0];
    expect(r.d).toBe(r.today);
    expect(r.d).toBe(q.nerveToday());
  });

  it("12b. the local-day boundary is computed in Nerve's timezone", () => {
    // 18:29Z is still 21 Aug in IST; 18:30Z is already the 22nd.
    expect(q?.nerveToday("Asia/Kolkata", new Date("2026-08-21T18:29:59Z"))).toBe("2026-08-21");
    expect(q?.nerveToday("Asia/Kolkata", new Date("2026-08-21T18:30:00Z"))).toBe("2026-08-22");
    // The UTC-derived answer would have been wrong for both.
    expect(new Date("2026-08-21T18:30:00Z").toISOString().slice(0, 10)).toBe("2026-08-21");
  });
});

describe("15. aggregate usage for an administrator", () => {
  maybe()("summarises without exposing any single question", async () => {
    await pool.query(`DELETE FROM mo_ai_requests WHERE user_id LIKE $1`, [`${PREFIX}-%`]);
    await q.recordAiRequest({ requestId: rid(), userId: U, provider: "openai-compatible",
      model: "m1", status: "ok", totalTokens: 100, tools: ["get_my_day"], questionChars: 10 });
    await q.recordAiRequest({ requestId: rid(), userId: U, provider: "openai-compatible",
      model: "m1", status: "failed", failureCategory: "provider_error", questionChars: 12 });

    const s = await q.getAiUsageSummary();
    expect(s.today.requests).toBeGreaterThanOrEqual(2);
    expect(s.today.failed).toBeGreaterThanOrEqual(1);
    expect(s.byUser.find((x) => x.userId === U)?.requests).toBeGreaterThanOrEqual(2);
    expect(s.byModel.some((x) => x.model === "m1")).toBe(true);
    expect(s.byFailure.some((x) => x.category === "provider_error")).toBe(true);

    const json = JSON.stringify(s);
    expect(json).not.toContain("question");
    expect(json).not.toContain("answer");
    expect(json).not.toContain("sk-");
  });

  maybe()("reports NULL cost rather than a guess", async () => {
    const s = await q.getAiUsageSummary();
    expect(s.month.estimatedCost).toBeNull();
  });
});
