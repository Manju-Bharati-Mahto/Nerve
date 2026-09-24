# Database Pool Concurrency Audit

Repository-wide search for the pattern found in `POST /equipment`: a handler
holding a pooled PostgreSQL client while calling something that acquires a
second one.

**Result: one production-risk instance, already fixed. No further remediation
was required.** The audit is now enforced mechanically so it cannot silently
rot — see §G.

---

## A. Search methodology

The pattern has one shape, so it was searched for structurally rather than by
reading:

1. **Every acquisition.** `pool.connect()` across `server/` and `scripts/`,
   excluding test files — **9 sites**, of which `server/test-db.ts` is the test
   harness, leaving **8 in server code**.
2. **Every client's lifetime.** For each, the region from the `connect()` to the
   last `.release()` of *that variable* before its block closes — which is where
   a `finally` puts it, and the whole window that matters.
3. **Every await inside that region that is not on the held client.** This is
   the decisive question: `await client.query(...)` repeated is correct and
   common; `await anythingElse(...)` is either a second connection or an
   unbounded hold of the first.
4. **Indirect acquisition**, three ways:
   - helpers that take a client parameter but reference `pool` internally
     (searched: **none**);
   - callbacks handed a client (`payoutTx(fn)`) — each callback body scanned for
     `pool.query` / `pool.connect` / `audit` / `notify`;
   - `BEGIN` issued on the pool instead of a pinned client, which silently
     spreads a transaction across connections (searched: **none** — all six
     `BEGIN`s are on a client).
5. **Reachability.** For each finding, whether the entry point is an HTTP
   handler (concurrent) or a one-shot command (not).

Steps 1–4 are now a test rather than a one-off script (§G).

---

## B. Findings

Eight acquisition sites; six non-client awaits across five of them.

| # | Location | Held call | Second connection? | Concurrent? | Severity |
|---|---|---|---|---|---|
| F1 | `mediaops-api.ts:5157` — `POST /equipment` | `audit()` | **Yes** | **Yes** | **High — fixed** |
| F2 | `mediaops-api.ts:8817` — `payoutTx(fn)` | `fn(client)` | No | Yes | None |
| F3 | `mediaops-api.ts:6613` — `enrolCreator()` | `hashPassword()` | No | Yes | Low (hold time) |
| F4 | `mediaops-import.ts:73` | `hashPassword()` | No | No | None |
| F5 | `mediaops-import.ts:92,110` | `columnsOf()` | **Yes** | **No** | Low |
| F6 | `mediaops-db.ts:47` — bootstrap | migration on `pool` | **Yes** | No | Low |

Three sites hold a client and await nothing but that client — `db.ts:623`,
`mediaops-api.ts:5931` (force-delete) and `mediaops-api.ts:10046` (competition
finalisation). `5931` is the correct reference: it releases, *then* audits.

### F1 — `POST /equipment` *(the one that mattered)*

```
POST /equipment
  └─ pool.connect()                    ← connection 1
      ├─ BEGIN … INSERT … COMMIT       (all on the client — correct)
      ├─ audit(…)  ─────────────────▶ pool.query()   ← connection 2, still holding 1
      └─ finally { client.release() }
```

`audit()` writes through the shared pool. With **N concurrent registrations and
N ≥ pool size**, every one holds the connection another needs and none can
finish. Nothing errors at the database; the requests simply never return.

Production-reachable: yes — an ordinary authenticated endpoint. Concurrent: yes.
`node-postgres` defaults to **10** connections, so ten simultaneous
registrations reproduce it.

**Fixed** in the stabilization work: the client is released before `audit()`.

### F2 — `payoutTx(fn)` — safe, and now checked

`payoutTx` opens a transaction and hands its client to a callback. That is
pattern **B** (keep the work atomic by passing the client) and is correct — but
only while every callback uses the client it was given. All three do; each body
was scanned for `pool.query`, `pool.connect`, `audit` and `notify` and is clean.
Because this is a property of *future* callbacks too, it is a test (§G).

### F3 — `enrolCreator()` — a hold-time cost, not a deadlock

`await hashPassword(...)` runs inside the transaction. scrypt is CPU-bound and
touches no database, so **no second connection is acquired and no deadlock is
possible**. It does pin a connection for the duration of the hash (tens of
milliseconds), so `k` concurrent enrolments occupy `k` connections for that long.
Under pool exhaustion the effect is *queuing*, which resolves, rather than
deadlock, which does not.

This is Creator Network code, and the task's instruction was to leave it alone
unless a confirmed shared-infrastructure defect required a change. It does not:
there is no defect here, only a cost. **Not changed.**

### F5 — the seed importer — the real pattern, unreachable

`importMediaOpsSeed()` holds a client and calls `columnsOf()`, which runs
`pool.query` against `information_schema` — twice, the second inside a loop over
tables. Structurally this **is** F1.

It is not a production risk: the only caller is a command-line entry point,

```js
importMediaOpsSeed().then(() => pool.end()).then(() => process.exit(0))
```

so there is exactly one invocation in a fresh process with ten connections
available for its two. There is no concurrency to deadlock against.

**Deliberately not changed.** The instruction was to fix confirmed production
risks, and modifying a seed importer to remove a risk that cannot occur adds
change without buying anything. The fix is recorded where it will be found if
the situation ever changes: hoist the `columnsOf()` calls above
`pool.connect()`, which is pattern **A** and alters no behaviour. The static
guard's allow-list carries that instruction.

### F6 — the schema bootstrap

`bootstrapMediaOpsDatabase()` holds one connection for a session advisory lock
while the migration runs its statements on the pool. Nested by construction, and
necessary: the lock has to outlive the statements it serialises. It runs once at
start-up, needs exactly two connections, and establishes the pool-size floor in
§F.

---

## C. Confirmed production risks

**One: F1**, already fixed.

F5 and F6 are genuine nested acquisitions but neither is production-reachable
under concurrency. F2 and F3 acquire nothing.

---

## D. Fixes

| Finding | Change |
|---|---|
| F1 | Client released before `audit()` — pattern **A**. Already in `mediaops-api.ts`; unchanged by this task. |
| All | A static guard that fails the build if the pattern reappears (§G). |
| F1 | Its concurrency regression test raised to **12 simultaneous registrations against a 6-connection pool**, so it exercises the deadlocking case rather than the borderline one, and now also asserts every asset got its audit row. |

No production code was modified in this task. The pool was not enlarged, no
traffic was serialized, and no retries were added.

---

## E. Remaining theoretical risks

1. **`enrolCreator` pins a connection through a scrypt hash** (F3). Queuing, not
   deadlock. If creator enrolment ever became a bulk operation, moving the hash
   above `pool.connect()` would be the fix — the password is not part of the
   transaction's invariant.
2. **The seed importer** (F5) becomes F1 the day it is mounted on a route.
3. **A future `payoutTx` callback** could reach for `pool` instead of its client.
   Checked by a test, not by convention.
4. **Long transactions in general.** Any handler holding a client across slow
   work reduces effective pool capacity. The guard catches *acquisition*, not
   *duration*; nothing currently holds a client across I/O other than the two
   scrypt calls.
5. **Advisory locks held on pooled connections** (F6, and the test harness's
   `withGlobalLock`). Correct, but each costs a connection for its duration.

---

## F. Pool-size assumptions

`server/db.ts` creates one pool per process:

```js
export const pool = new Pool({
  connectionString: config.databaseUrl,
  ...(process.env.PG_POOL_MAX ? { max: Number(process.env.PG_POOL_MAX) } : {}),
});
```

| Context | Max per pool | Note |
|---|---|---|
| Production / development | **10** (node-postgres default) | `PG_POOL_MAX` unset |
| Test suite | **6** | set in `vitest.config.ts`; each worker has its own pool |

What the code now assumes:

- **Every request handler needs exactly one connection at a time.** That is the
  invariant the guard enforces, and it is what makes the pool a queue rather than
  a deadlock surface: with it, `k` concurrent requests against `n` connections
  simply wait; without it, they stop.
- **Start-up needs two** (F6), so a pool of 1 would hang the bootstrap. Nothing
  configures one, but it is the floor.
- **Workers × pool max must stay under `max_connections`** (100 here). At the
  test setting that is 14 × 6 = 84.

---

## G. Test coverage

### `server/db-pool-safety.test.ts` — the audit, as a test

A source scan, so it needs no database and runs in milliseconds:

| Test | What it refuses |
|---|---|
| no unreviewed call under a held client | any non-client await not in the reviewed allow-list |
| never audits, notifies or logs while holding a client | `audit` / `notify` / `pool.query` / `pool.connect` — refused outright, never allow-listed |
| BEGIN only on a pinned client | `pool.query("BEGIN")`, which spreads a transaction across connections |
| payoutTx callbacks stay on their client | F2 becoming a risk later |
| no stale allow-list entries | the list rotting into permission for code nobody checked |
| the scan finds what it expects | a broken matcher passing everything for the wrong reason |

The allow-list is §B's findings with the reason each is safe, so adding an entry
requires writing down a justification.

**The guard was verified to fail.** Re-introducing the original defect — moving
`audit()` back inside the held region — produced:

```
+ "server/mediaops-api.ts:5204 — await audit() while holding 'client'"
+ "server/mediaops-api.ts:5204 — await audit()"
Tests  2 failed | 4 passed (6)
```

and restoring the fix returned it to 6 passed. A guard that cannot fail proves
nothing, so this was checked rather than assumed.

### Runtime concurrency

| Path | Coverage |
|---|---|
| `POST /equipment` | **12 simultaneous** registrations against a 6-connection pool; all 201, all tags unique, all audit rows written |
| `payoutTx` (generate / approve / pay) | three existing tests at **10 simultaneous** each — above the pool — each asserting exactly one payout, one liability entry, one payment |

Both exceed the pool they run against, which is the condition that produces the
deadlock. Transaction integrity is asserted alongside completion in every case:
one payout, one ledger entry, unique tags, matching audit rows.

---

## H. Validation

| Check | Result |
|---|---|
| `npm test` | **1133 / 1133** — 43 files |
| `npm run build` | **PASS** |
| `npm run typecheck` | **PASS** |
| `npm run lint` | 1 error, 18 warnings — **unchanged from baseline** |
| Guard + equipment + payouts, explicitly | **130 / 130** |
| Guard fails on the reintroduced defect | **verified** |

Test count 1127 → 1133: six added by the static guard.

---

## Changed files

| File | Change |
|---|---|
| `server/db-pool-safety.test.ts` | **new** — the audit as an enforceable test |
| `server/mediaops-equipment.integration.test.ts` | concurrency raised to 12 (above the pool) and audit-row assertion added |
| `docs/DB_POOL_CONCURRENCY_AUDIT.md` | **new** — this document |

**No production code was changed.** No Asset/Inventory UI or API architecture was
touched, and no Creator Network code was modified — F3 was examined and left
alone because it is a cost, not a defect.
