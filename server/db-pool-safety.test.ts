// @vitest-environment node
/* ═══════════════════════════════════════════════════════════════════════════
   STATIC — nobody may hold a pooled connection while asking for another.

   THE BUG THIS ENCODES. `POST /equipment` ran a transaction on a checked-out
   client and then, still holding it, called audit() — which writes through the
   shared pool. Each in-flight registration held one connection and asked for a
   second, so once as many registrations were in flight as the pool has
   connections, every one of them held the connection another needed. Nothing
   timed out at the database; the requests simply never finished.

   It is invisible in review (two correct-looking lines), invisible under light
   load, and it is the same three characters — `pool.` instead of `client.` —
   every time. So it is checked mechanically rather than remembered.

   THE RULE. Between `const c = await pool.connect()` and `c.release()`, every
   awaited call must be on `c`. Anything else is either a second connection or
   an unbounded hold of the first, and both are refused here.

   This is a source scan, not a runtime test: it needs no database and runs in
   milliseconds. The allow-list below is the audit's findings, each with the
   reason it is safe — and a new entry has to be justified the same way.
   ═══════════════════════════════════════════════════════════════════════════ */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/* Files that run in the SERVER. Test files are excluded, and so is
   server/test-db.ts: it is the suites' own harness — it never loads in the
   application, and its withGlobalLock() deliberately holds a connection for an
   advisory lock while the locked work runs on the pool. That is the same shape
   as the bootstrap lock and just as bounded, but it is not server code and the
   rule below is about server code. */
const NOT_SERVER_CODE = new Set(["server/test-db.ts", "server/test-guard.ts"]);

function sourceFiles(): string[] {
  const out: string[] = [];
  for (const dir of ["server", "scripts"]) {
    let names: string[] = [];
    try { names = readdirSync(dir); } catch { continue; }
    for (const n of names) {
      const p = join(dir, n);
      if (n.endsWith(".ts") && !n.includes(".test.") && !NOT_SERVER_CODE.has(p)) out.push(p);
    }
  }
  return out;
}

interface Hold { file: string; line: number; varName: string; callee: string; source: string }

/**
 * Every awaited call that happens while a pooled client is checked out and is
 * NOT a call on that client.
 *
 * The region runs from the `pool.connect()` to the last `.release()` of that
 * same variable before the enclosing block closes — which is where a `finally`
 * puts it, and which is the whole window that matters.
 */
function heldCalls(): Hold[] {
  const found: Hold[] = [];
  for (const file of sourceFiles()) {
    const lines = readFileSync(file, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const m = /const (\w+)\s*=\s*await pool\.connect\(\)/.exec(lines[i]);
      if (!m) continue;
      const varName = m[1];
      let end = i, depth = 0;
      for (let j = i; j < Math.min(i + 300, lines.length); j++) {
        depth += (lines[j].match(/\{/g) ?? []).length - (lines[j].match(/\}/g) ?? []).length;
        if (lines[j].includes(`${varName}.release()`)) end = j;
        if (j > i && depth < 0) break;
      }
      for (let j = i; j <= end; j++) {
        const s = lines[j].trim();
        if (s.startsWith("//") || s.startsWith("*") || s.startsWith("/*")) continue;
        for (const c of lines[j].matchAll(/await\s+([A-Za-z_$][\w.$]*)\s*\(/g)) {
          const callee = c[1];
          if (callee.startsWith(`${varName}.`) || callee === "pool.connect") continue;
          found.push({ file, line: j + 1, varName, callee, source: s.slice(0, 100) });
        }
      }
    }
  }
  return found;
}

/* ── The audit's findings ─────────────────────────────────────────────────
   Every entry is a call that happens while a connection is held, together with
   why it is safe. Two tests below enforce the two different reasons. */
const ALLOWED: Record<string, string> = {
  /* A CPU-bound scrypt hash. No database work, so no second connection and no
     deadlock — but it does pin the connection for the duration of the hash.
     Recorded as a hold-time cost, not a correctness problem. */
  "server/mediaops-api.ts:hashPassword": "scrypt; no database access",
  "server/mediaops-import.ts:hashPassword": "scrypt; no database access",

  /* payoutTx() hands its own client to the callback. Safe only while every
     callback uses that client and never the pool — which the second test below
     verifies directly rather than trusting. */
  "server/mediaops-api.ts:fn": "payoutTx callback; receives the client, checked below",

  /* The CLI seed importer asks information_schema for a table's columns through
     the pool while holding a client. It IS the nested pattern — but it runs
     from a one-shot command line entry point (`importMediaOpsSeed().then(() =>
     pool.end())`), never from a request, so there is no concurrency to deadlock
     against and a fresh pool has ten connections for its two. Left alone
     deliberately: changing a seed importer for a risk that cannot occur buys
     nothing. If it is ever mounted on a route, this entry must go and the
     columnsOf() calls must be hoisted above pool.connect(). */
  "server/mediaops-import.ts:columnsOf": "CLI-only entry point; no concurrent callers",

  /* The schema bootstrap holds one connection for an advisory lock while the
     migration runs its statements on the pool. Two connections, once, at
     start-up — see the pool-size floor in docs/DB_POOL_CONCURRENCY_AUDIT.md. */
  "server/mediaops-db.ts:bootstrapMediaOpsDatabaseUnlocked": "startup only; needs 2 connections",

  /* Phase 17A. allocateInternalCode() is handed the CALLER'S client and every
     statement inside it runs on that client — the advisory lock, the MAX scan
     and nothing else. It acquires no second connection, so the nested pattern
     this file exists to catch cannot occur.

     That is a property of the signature, not a promise: the function takes a
     client and never sees `pool`. The second test below verifies the same
     thing for payoutTx callbacks, and the argument here is identical. */
  "server/mediaops-api.ts:allocateInternalCode": "receives the held client; opens no connection of its own",

  /* Phase 17I. openMaintenance() counts an asset's open maintenance records and
     takes the connection to count them ON. Passing the held client is not a
     convenience here, it is the requirement: the check-in and inspection-release
     paths decide the asset's status from that count, and counting through the
     POOL would read outside the row lock they are holding — which is precisely
     the race those paths exist to close. A report committed a microsecond
     earlier would be invisible and the asset would go back on the shelf with
     open work against it.

     Safe for the same reason as allocateInternalCode: it has no `pool` default
     and cannot reach one. The signature takes a Queryable and every statement
     runs on whatever it was handed, so the nested pattern this file catches
     cannot occur. If a default is ever added to that parameter, this entry must
     go and the call sites must be re-examined. */
  "server/mediaops-api.ts:openMaintenance": "receives the held client by design; counting off-lock would be the bug",

  /* Phase 17L. createEquipmentOn() is the canonical asset-creation body,
     extracted so the importer can run it INSIDE its own transaction — approving
     an import row has to be atomic across the asset, its identifiers, the row's
     state and the batch, and an HTTP call to POST /equipment cannot join a
     transaction.

     Same property as allocateInternalCode, which it calls: the signature takes
     a client and the function never sees `pool`, so it opens no connection of
     its own. The guard caught a REAL violation beside this one on the same day
     — mayReviewScope() reached inventoryScopeOf(), which does query the pool —
     and that one was fixed by resolving the caller's scope before the
     transaction rather than excusing it here. */
  "server/mediaops-api.ts:createEquipmentOn": "receives the held client; opens no connection of its own",

  /* Phase 17L. grouped() is a closure declared INSIDE the dashboard handler,
     three lines below the `snap` it uses — it closes over that client and runs
     `snap.query` on it. It is the same query four times with a different GROUP
     BY expression, written once rather than four times.

     The dashboard holds a connection at all because its figures have to agree
     with each other: ten separate pool.query calls meant ten snapshots, and the
     lifecycle breakdown summing to 2 against a total of 1 is what that looks
     like from outside. The whole page now reads one REPEATABLE READ snapshot,
     which requires one connection, which is why this appears here at all. */
  "server/mediaops-api.ts:grouped": "closure over the held client; opens no connection of its own",

  /* Phase 17O. policyClash() asks whether an active inspection policy already
     covers the days a write is about to claim. Taking the caller's client is
     the requirement rather than a convenience: checking through the POOL and
     then inserting on the transaction would read outside the row lock the
     mutation holds, which is exactly the gap the check exists to close — two
     admins could each be told the dates were free and both be right at the
     moment they asked.

     Same signature property as allocateInternalCode and createEquipmentOn: it
     takes a connection and never sees `pool`, so it opens none of its own. */
  "server/mediaops-api.ts:policyClash": "receives the held client; opens no connection of its own",
};

describe("no handler holds a pooled connection while acquiring another", () => {
  it("has no unreviewed call under a held client", () => {
    const unexpected = heldCalls().filter((h) => !(`${h.file}:${h.callee}` in ALLOWED));
    expect(unexpected.map((h) => `${h.file}:${h.line} — await ${h.callee}() while holding '${h.varName}'`))
      .toEqual([]);
  });

  /* The specific shape that caused the outage: audit/notify/logging run while
     the transaction's client is still checked out. There is no reason for any
     of these to be inside a transaction — they are independent writes — so they
     are refused outright rather than allow-listed. */
  it("never audits, notifies or logs while holding a client", () => {
    const forbidden = new Set(["audit", "notify", "pool.query", "pool.connect"]);
    const offenders = heldCalls().filter((h) => forbidden.has(h.callee));
    expect(offenders.map((h) => `${h.file}:${h.line} — await ${h.callee}()`)).toEqual([]);
  });

  it("issues BEGIN only on a pinned client, never on the pool", () => {
    const bad: string[] = [];
    for (const file of sourceFiles()) {
      const src = readFileSync(file, "utf8");
      src.split("\n").forEach((l, i) => {
        if (/pool\.query\(\s*[`"']BEGIN/.test(l)) bad.push(`${file}:${i + 1}`);
      });
    }
    /* A BEGIN on the pool starts a transaction on whichever connection answers
       and the next statement may land on a different one — the transaction is
       silently not a transaction. */
    expect(bad).toEqual([]);
  });

  it("keeps every payoutTx callback on the client it was handed", () => {
    const src = readFileSync("server/mediaops-api.ts", "utf8").split("\n");
    const offenders: string[] = [];
    for (let i = 0; i < src.length; i++) {
      if (!src[i].includes("payoutTx") || src[i].includes("function payoutTx")) continue;
      let depth = 0;
      for (let j = i; j < Math.min(i + 80, src.length); j++) {
        depth += (src[j].match(/\{/g) ?? []).length - (src[j].match(/\}/g) ?? []).length;
        const s = src[j].trim();
        if (!s.startsWith("//") && (/\bpool\.query\(/.test(src[j]) || /\bpool\.connect\(/.test(src[j])
            || /\bawait audit\(/.test(src[j]) || /\bawait notify\(/.test(src[j])))
          offenders.push(`server/mediaops-api.ts:${j + 1} — ${s.slice(0, 70)}`);
        if (j > i && depth <= 0) break;
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("the audit's own findings are still what they were", () => {
  /* If a reviewed call disappears, the allow-list entry should go with it —
     otherwise the list rots into permission for something nobody checked. */
  it("has no stale allow-list entries", () => {
    const live = new Set(heldCalls().map((h) => `${h.file}:${h.callee}`));
    const stale = Object.keys(ALLOWED).filter((k) => !live.has(k));
    expect(stale, "these allow-list entries no longer match any code").toEqual([]);
  });

  it("finds the connections it expects to find, so the scan is not silently empty", () => {
    const sites = sourceFiles().flatMap((f) =>
      readFileSync(f, "utf8").split("\n")
        .map((l, i) => (/await pool\.connect\(\)/.test(l) ? `${f}:${i + 1}` : null))
        .filter(Boolean));
    // A scan that matches nothing would pass every test above for the wrong reason.
    expect(sites.length).toBeGreaterThanOrEqual(7);
  });
});
