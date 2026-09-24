# Test Suite Stability

The suite passed 11 runs in 12. This is what the twelfth was, and the seven
other things that turned up while looking for it.

---

## A. Failure reproduced

Running the full suite in a loop and keeping every log turned "occasionally
fails" into a set of distinct, separately-diagnosable failures. The rate was far
higher than 1-in-12 once several were present at once — **4 of 8 runs** in the
first batch.

| # | Symptom | Suite |
|---|---|---|
| 1 | `projects disappeared: expected [ '139' ] to deeply equal []` | `mediaops-project-hierarchy` |
| 2 | `expected 125 to be 121` (notification count) | `mediaops-creator-recognition` |
| 3 | `Error: Test timed out in 5000ms` ×3 | `mediaops-equipment` |
| 4 | `expected 'zrg Threshold 2027' to be 'zfp Precision 2027'` | `mediaops-creator-analytics` |
| 5 | `is idempotent — a second bootstrap changes no row` — the `creator` row had gained `home` | `mediaops-module-defaults` |
| 7 | `a creator with no work assigned is not called unproductive` — `expected 1 to be 3` | `mediaops-creator-analytics` |
| 8 | `the first call changes nothing and returns a preview` — `expected 10 to be 5` | `mediaops-creator-ai` |

Numbers 1–4 came from the first batch; 5, 7 and 8 only became visible once those
were fixed, and 6 was introduced by the first attempt at fixing number 2. That is
the shape of the whole exercise: each fix removed a louder failure and let a
quieter one be heard.

Each one reproduced only under the **full** suite — every suite passed alone, and
passed alongside the two or three files that seemed most related. That is the
signature of cross-file interference rather than a bug inside any one file.

---

## B. Root causes

Eight, all genuinely different. One is a product defect; one was self-inflicted
by the first attempt at another. Four are the same underlying mistake in four
places — **a test reconciling two independent reads of a shared, global
quantity** — which is the lesson worth carrying forward.

### B1 — A fixture that looked like production data

`mediaops-project-hierarchy` asserts that its operations do not disturb data
belonging to genuine accounts, and scopes that to real account-id shapes:

```js
const REAL = `(created_by LIKE 'u-%' OR created_by LIKE 'mo-%')`;
```

with a comment naming the convention every suite follows — fixtures are
recognisable by a short prefix of their own (`zph-`, `ztvit-`, …).

The crew-lifecycle suite creates its members through `POST /crew`, which mints
**real** Nerve ids of the form `u-<ts>-<rand>`. A fixture project I had added to
that suite in earlier work was `created_by` one of those members, so it was
indistinguishable from genuine data. Project-hierarchy snapshotted it, crew
lifecycle cleaned it up, and the snapshot reported a project had disappeared.

### B2 — A global automation pass writing into other suites' fixtures

`runCreatorNetworkAutomations()` walks **every active creator profile in the
database** and notifies the ones it finds. `mediaops-creator-ai` runs it eleven
times, five of those concurrently.

`mediaops-creator-recognition` asserts that reading a leaderboard notifies
nobody — a count that is already scoped to its own `zrg-` fixtures. Scoping does
not help: the automation genuinely notified those creators, and was right to.
The two simply must not overlap.

### B3 — A connection-pool deadlock in `POST /equipment` *(product defect)*

```js
await client.query("COMMIT");
await audit(u, "equipment.added", …);   // ← pool.query, while `client` is still checked out
…
} finally { client.release(); }
```

`audit()` writes through the shared pool. Each in-flight registration held one
connection and then asked for a second. Once as many registrations were in
flight as the pool has connections, every one of them was holding the only
connection another needed to finish — a textbook pool deadlock, surfacing as
requests hanging until the 5-second test timeout.

The equipment suite's concurrent-registration test is what walked into it, but
**nothing about this is test-only**: node-postgres defaults to ten connections,
and ten simultaneous registrations would do exactly the same in production.

### B4 — "The current cycle" is a global singleton

`GET /creator/analytics/summary?range=cycle` resolves the cycle as *the latest
row in the whole table*:

```sql
SELECT … FROM mo_creator_cycles WHERE status IN ('active','closed')
 ORDER BY starts_on DESC, id DESC LIMIT 2
```

The analytics test asked the API, then ran the same query itself and compared.
Five suites create cycles; between those two reads a sibling's cycle became the
latest, so the server said `zfp Precision 2027` and the test's own read said
`zrg Threshold 2027`.

### B5 — Two suites, one shared configuration table

`mo_module_defaults` holds one row per group. `mediaops-module-defaults`
snapshots the whole table to prove a second bootstrap changes no row;
`mediaops-creator-network` flips the `creator` row to `["creator","home"]`,
checks the bootstrap does not overwrite it, and restores it in a `finally`.

Both are legitimate and both are correct. The snapshot simply caught the toggle
mid-flight and reported that a bootstrap had widened the creator group.

### B6 — A fix that broke the thing it was fixing

The first version of B2's fix wrapped **each** `runCreatorNetworkAutomations()`
call in the lock. That was wrong twice over, and the suite said so within three
runs:

- the five-simultaneous-passes test exists **precisely** to exercise overlapping
  ticks, and serialising them tested nothing;
- five callers each waiting on the same exclusive lock, each holding a pool
  connection, starved the pool and timed the test out.

Recorded because it is the instructive one: a serialization that is too coarse
does not just slow a suite down, it silently deletes the property under test.

### B7 — A second global reconciliation

Same shape as B4, in a different test. `low_activity` is a signal the server
computes over every active creator **in the caller's scope**; asked as the
network-wide Creator Admin, that is the whole database. The test then re-derived
the same count with its own SQL a moment later, by which time sibling suites had
created and removed profiles of their own — the server said 1, the query said 3.

### B8 — "Nothing was written" measured over everything

`creator_send_notification` called without a token must write nothing. The test
proved that by counting **all** notifications held by its fixtures before and
after. That total moves for reasons that have nothing to do with the tool: other
tests in the same file, and the product's own notifications, land on the same
creators. Five arrived between the two reads and the preview was blamed.

---

## C. Why it was intermittent

Everything above needs two suites to be *inside a specific window at the same
moment*, and vitest runs files across as many workers as the machine has cores —
so the interleaving differs on every run.

- **B1** needs crew-lifecycle's cleanup to land between project-hierarchy's
  snapshot and its final check.
- **B2** needs an automation pass to land between the recognition suite's two
  counts — a window of two HTTP requests.
- **B3** needs enough concurrent registrations to exhaust the pool, which
  depends on how much other work is in flight.
- **B4** needs a sibling to insert a later cycle between two reads.
- **B5** needs the creator-network toggle to be mid-`finally` while the
  module-defaults snapshot runs.
- **B7** and **B8** need a sibling to change the population, or the fixtures'
  notifications, between two reads a few milliseconds apart.

They were also **masked by each other and by earlier work**. While the suite ran
against the development database, a different failure dominated every run; the
stale-fixture bug found in the previous task made whole files *skip*, and a
skipped file reads as a pass on the summary line. Each fix removed a louder
failure and let a quieter one become visible.

---

## D. Fix

| # | Fix | Kind |
|---|---|---|
| B1 | The crew-lifecycle fixture project is `created_by` the suite's own prefixed admin (`zlc-admin`) rather than a `u-…` member, so it obeys the convention every other suite follows | test fixture |
| B2 | A Postgres **advisory lock** (`GLOBAL_LOCK.creatorAutomations`) held by both sides: every test that runs a global pass, and the assertion about a stable notification count | serialization |
| B3 | Release the pooled client **before** `audit()` | **product** |
| B4 | The test looks the cycle up **by the label the server just returned**, rather than re-deriving "the latest" a moment later | test scoping |
| B5 | A second advisory lock (`GLOBAL_LOCK.moduleDefaults`) held by both the suite that toggles a row and the suite that snapshots the table | serialization |
| B6 | The lock moved from around each call to around each **test body** | serialization |
| B7 | The reconciliation is asked as `leadA`, whose scope is `teamA` — a population containing exactly this suite's creators and nothing else | test scoping |
| B8 | The count is restricted to `kind='creator_message'`, which is what this tool writes | test scoping |

`withGlobalLock()` lives in [`server/test-db.ts`](../server/test-db.ts).

### The lock is round the test, not round the call

See B6. The lock wraps whole test bodies: other **files** are excluded, and a
file's own concurrency — which is sometimes the thing under test — is untouched.

---

## E. Why the fix is correct

**No retries, no sleeps, no raised timeouts, no weakened assertions, and
parallelism is untouched.** Each fix removes the cause:

- **B1** removes the ambiguity. A fixture that claims to be production data is
  simply mislabelled; labelling it correctly makes project-hierarchy's assertion
  mean what it says again. No assertion was loosened — it still checks every
  genuine project.
- **B2** is the sanctioned case for serialization: a genuinely global operation
  with no scoping available. The product is right to notify every creator; a
  test asserting on the effects of that pass cannot run beside it. Nothing is
  skipped and the concurrency under test is preserved.
- **B3** is a real bug fix. Auditing after the connection is returned is correct
  independent of tests, and removes a production deadlock nobody had hit yet.
- **B4**, **B7** and **B8** keep the property and drop the race, and each is
  *more* precise than what it replaced, not less:
  - B4 never cared *which* cycle was current, only that the window is that
    cycle's stored dates rather than a rolling span — which is what it now
    asserts, plus a check that the two dates differ.
  - B7 reconciles the same rule over a population the suite owns outright,
    instead of over every creator in the database.
  - B8 asserts that the tool wrote nothing, instead of that nothing at all
    happened anywhere near its fixtures. That is the claim the test was making
    all along.

---

## F. 20-run validation

**20 / 20 from a freshly created test database.** No reruns, no retries, no
raised timeouts, full parallelism.

```
fresh test DB; 20 runs
run  1 pass … run 20 pass
TOTAL: 20/20
```

Each run is the whole suite — 42 files, 1127 tests.

Progress through the investigation, for context on how much of this was hidden
behind other failures:

| Batch | Result | What changed since |
|---|---|---|
| 8 runs | 4 failed | baseline; B1–B4 all present at once |
| 6 runs | 1 failed | B1–B4 fixed, B6 introduced by the first B2 attempt |
| 20 runs | 2 failed | B5, B6 fixed; B7 and B8 surfaced |
| **20 runs** | **0 failed** | **B7, B8 fixed** |

And **10 / 10** again without resetting the database first — the state a
developer's machine is actually in, with residue from previous runs present:

```
no reset — the database as a developer leaves it; 10 runs
TOTAL (no reset): 10/10
```

**30 consecutive green runs across both setups.**

| Check | Result |
|---|---|
| `npm test` × 30 | **1127 / 1127**, every run |
| `npm run build` | **PASS** |
| `npm run typecheck` | **PASS** |
| `npm run lint` | 1 error, 18 warnings — **unchanged from baseline** |
| Development database | **byte-identical** before and after all 30 runs |
| Parallelism | **untouched** — vitest defaults, 14 workers |

---

## G. Remaining known concurrency risks

1. **Reconciling two reads of a global quantity.** This was four of the eight
   causes (B2, B4, B7, B8) and is the pattern to watch for: a test asks the
   server for a number, then computes the same number itself a moment later. It
   is only sound if the population cannot change in between — which, in a shared
   database with ~20 suites running, means the test must own that population or
   hold a lock. Six such cases have now been scoped or serialized
   (`crew-lifecycle`, `creator-directory`, `tv-access`, `creator-recognition`,
   `creator-analytics` ×2, `creator-ai`); others may exist, and they will look
   exactly like this when they surface.

2. **The global creator cycle.** `idx_mo_cr_cycle_one_active` permits one active
   cycle database-wide, and five suites create cycles. B4 removed one dependence
   on "which cycle is current"; the points suite still closes and restores the
   active cycle under a `finally`, with a window of one HTTP request.

3. **Shared configuration rows.** `mo_automation_rules` and `mo_module_defaults`
   are single rows per key. The two tests that toggle one restore it in a
   `finally`; the module-defaults suite deliberately never deletes a shared row
   at all, for exactly this reason.

4. **One 401 seen once, never reproduced.** A single run had
   `mediaops-project-hierarchy` receive `401 {"type":"error","error":
   {"type":"authentication_error"…}}` — an Anthropic-shaped body — from
   `POST /projects` on its own loopback server. The app has no Anthropic client
   (`AI_BASE_URL` is a local Ollama address), no proxy variables are set, and no
   suite stubs global `fetch`. It did not recur in any of the ~60 subsequent
   runs, and the cause is unexplained. Recorded rather than dismissed: an
   instrumented `as()` logging `base`, the response `server`/`via` headers and
   the body will identify it in one run if it returns.

5. **Pool sizing is a ceiling, not a guarantee.** `PG_POOL_MAX=3…10` per worker
   times the worker count must stay inside `max_connections`. B3 showed what a
   handler that needs two connections at once does to that arithmetic.

6. **A teardown that deletes a rule another suite's ledger row is holding.**
   *Observed once, in run 1 of a 5-run check after the Equipment history
   migration; not present in any of the 98 logs from the campaign above.*
   **Fixed.**

   ```
   FAIL server/mediaops-creator-payouts.integration.test.ts
   update or delete on table "mo_creator_point_rules" violates foreign key
   constraint "mo_creator_point_ledger_rule_id_fkey"
     ❯ cleanup server/mediaops-creator-payouts.integration.test.ts:190
   ```

   **All 1192 tests passed.** It is the suite's own `cleanup()` that fails, so
   the file is reported failed with nothing in it broken — the same shape as B1.

   The mechanism is B2's, through a path the lock does not cover.
   `ruleForOpportunity()` falls back to *whichever* `approved_submission` rule
   is active when an opportunity names none:

   ```sql
   SELECT * FROM mo_creator_point_rules
    WHERE is_active AND source_type='approved_submission' LIMIT 2
   ```

   The payouts suite inserts `zfp Approved Reel`, which is active and of that
   source type for as long as its §43 test runs. While it is the one the
   fallback finds, a concurrent suite's approval is awarded under it: the
   resulting ledger row has *that* suite's `user_id` and `created_by` and *this*
   suite's `rule_id`. The payouts cleanup matched ledger rows by creator, actor
   and cycle but **not by rule**, so the row survived its own teardown and the
   rule delete hit a RESTRICT key.

   `mediaops-creator-points` already covers exactly this, and says why:

   ```js
   OR l.rule_id IN (SELECT id FROM mo_creator_point_rules WHERE name LIKE $2)
   ```

   **The fix is that one clause, added to both of the payouts cleanup's ledger
   deletes** — the reversals pass and the entries pass, in that order, because
   the foreign keys are RESTRICT the whole way down. It is strictly test-scoped:
   no endpoint, no product behaviour, no other suite.

   It does not broaden the cleanup. `${PX} %` is the same prefix scope every
   other line in that teardown already uses, and a ledger row can only match it
   by pointing at a rule this fixture created — which is precisely a row this
   fixture caused. Rows belonging to other suites' rules are untouched, and the
   *only* rows newly in scope are ones that would otherwise be left holding a
   rule this file is about to delete.

   Validated over 6 consecutive full-suite runs at the time.

   **THAT FIX WAS NOT ENOUGH, and the same foreign key failed again in Phase
   4.** The rule predicate removes the offending rows *once*; it does not close
   the window they arrive through. This file's `Approved Reel` rule stays active
   and of type `approved_submission` until the moment it is deleted, so
   `ruleForOpportunity()`'s fallback can hand it to a concurrent suite's
   approval **after** the ledger has been cleaned and **before** the rule is
   dropped. Six green runs proved only that the window is narrow.

   What closes it is locking the rules while their ledger rows are removed:

   ```sql
   BEGIN;
   SELECT id FROM mo_creator_point_rules WHERE name LIKE $1 FOR UPDATE;
   DELETE FROM mo_creator_point_ledger WHERE rule_id IN (SELECT id FROM … LIKE $1);
   DELETE FROM mo_creator_point_rules WHERE name LIKE $1;
   COMMIT;
   ```

   `FOR UPDATE` blocks the row-share lock a concurrent INSERT's foreign-key
   check needs, so no new ledger row can appear between the two deletes. Still
   prefix-scoped; still nothing another suite owns.

   The lesson: a cleanup that races is not fixed by deleting more rows, only by
   removing the race. And *n* green runs is evidence about a window's width, not
   proof that it is shut.

7. **One unidentified failure in the Equipment integration suite.**
   *Observed once, during the Phase 3 booking migration, in an explicit run of
   the six Equipment suites: `Test Files 1 failed | 5 passed`, `Tests 1 failed |
   231 passed`. The five that passed were named; the failing test was not
   captured, because the command that produced it filtered vitest's output down
   to the summary lines.*

   **IDENTIFIED AND FIXED IN PHASE 4.** See the addendum below.

   What was done about it: the one test added in that phase whose assertion was
   structurally unscoped — availability pagination, which compared page 1 and
   page 2 over *every* asset in the database — now scopes itself with `q=ZEQ`,
   this file's own fixtures. That is a real weakness whether or not it was the
   cause: `mediaops-crew-lifecycle` and `mediaops-tv-access` both insert into
   `mo_equipment_items`, and an unscoped offset window can shift under a sibling
   INSERT. It does not explain a failure in a subset run where neither of those
   suites was running, so **the cause is recorded as unknown rather than fixed.**

   The lesson worth keeping is about the harness, not the test: a validation run
   that greps for `Tests` and `Test Files` throws away the only copy of the
   failure. Runs that are meant to catch flakes now write the whole log to a
   file and grep the file.


### G.7 — resolved: it was a production bug, not a flake

Run the suite keeping the whole log and the flake names itself. Seven runs of
the Equipment suite reproduced it, and the line number was the first real clue:
the failure was at `expect(clash.length).toBe(1)`, not at the `ok.length`
assertion above it. One booking request had got its 201; the **loser had
returned neither 201 nor 409**.

Only the first assertion carried a diagnostic message, so the statuses were
never printed. Both assertions now carry the full outcome — and that showed:

```
AssertionError: 500: | 201:: expected +0 to be 1
```

A 500 with an empty body — express's default HTML error page.

**The cause.** Reproduced through the real handler with an error logger
attached:

```
code: '40P01', msg: 'deadlock detected'
  at server/mediaops-api.ts:2069   ← the INSERT in POST /equipment/bookings
```

Two overlapping bookings of one asset, inserted at the same instant. Each
transaction writes its exclusion-constraint index entry and must then wait on
the other to commit before it can decide the conflict. That is a wait cycle, and
Postgres breaks it by killing one. The handler caught only `23P01`, so the
victim — whose booking genuinely had lost to a conflicting one — got a crash
instead of `AC-7`.

A bare two-statement race does **not** reproduce it: 400 concurrent pairs
straight against the database were all a clean `23P01 + OK`. It is the
handler's own latency between the two inserts that aligns the waits.

**The fix.** `40P01` is mapped to the same 409 AC-7 as `23P01`. Not a retry:
the request is answered once, with what actually happened.

**The guard.** A runtime test cannot provoke a deadlock on demand — a
fourteen-pair concurrency test was written, verified NOT to fail with the fix
reverted, and is therefore kept as an invariant rather than as the guard. The
guard is a source-level check that the booking handler maps both SQLSTATEs,
with comments stripped first: the first version of it read the comment
explaining the fix and passed with the fix reverted. It now fails with the fix
reverted and passes with it, verified both ways.

**What to take from it.** Two things, both about the harness rather than the
code. A validation run that greps for `Tests` and `Test Files` throws away the
only copy of the failure. And an assertion without a message is a assertion you
cannot diagnose from a log — in a concurrency test, every assertion should carry
the outcome that produced it.

8. **An inbox assertion that read whichever notification was newest.**
   *Observed once in eight full-suite runs during Phase 4.*

   ```
   FAIL server/mediaops-creator-submissions.integration.test.ts
     > the creator is told, and can read the comment
   expected 'War Zone: zrg Reel Battle is open' to contain 'Changes requested'
   ```

   The received title names another suite's prefix, which is the whole
   diagnosis: opening an opportunity **broadcasts to every active creator**, so
   `mediaops-creator-recognition` putting a row in this creator's inbox pushes
   the review notification off the top of

   ```sql
   SELECT title, body FROM mo_notifications WHERE user_id=$1 ORDER BY id DESC LIMIT 1
   ```

   The test scoped by user, which is not enough when the user is a member of a
   population other suites broadcast to. It now scopes by the notification it is
   about (`title ILIKE '%Changes requested%'`) and asserts one row came back, so
   "the creator was told" is still what is being asserted — of a population this
   file owns.

   This is B1's shape again (a fixture that looked like production data) in a
   new place: **an assertion about "the latest row" is an assertion about every
   suite that can write one.**


9. **The same teardown race, in `mediaops-creator-points`, on a different key.**
   *Observed once in eight full-suite runs during Phase 4, after §G.6 was
   closed in the payouts suite.*

   ```
   FAIL server/mediaops-creator-points.integration.test.ts
   update or delete on table "mo_creator_cycles" violates foreign key
   constraint "mo_creator_point_ledger_cycle_id_fkey"
     ❯ cleanup server/mediaops-creator-points.integration.test.ts:194
   ```

   Identical shape to §G.6 and worth stating as one rule rather than two
   incidents:

   > **A fixture that is a global singleton cannot be torn down in two
   > statements.** This file's cycle is the *current* cycle (B4) and its rule is
   > the one active `approved_submission` rule. Both are reachable by every
   > concurrent suite for as long as they exist, so any gap between "delete the
   > rows that point at it" and "delete it" is a window, and both foreign keys
   > are RESTRICT.

   **The first attempt at fixing this was wrong, and is worth recording.**
   Both teardowns were made to take `FOR UPDATE` on the cycles and rules before
   deleting. That does close the gap — and it also blocks the row-share lock a
   **concurrent suite's application call** needs for its own foreign-key check.
   Within ten runs the submission-review endpoint deadlocked against a teardown
   and returned 500:

   ```
   FAIL … > §43 — an approved submission still awards points
   AssertionError: expected 500 to be 200
   ```

   A teardown that makes production paths fail is a worse bug than the one it
   fixes. The locks were removed.

   **What actually fixes it is removing the reachability, not adding a lock.**
   The race exists because these fixtures are *findable*: the cycle is the one
   with `status='active'`, and the rule is the one active `approved_submission`
   rule, so every concurrent suite's awarding code can legitimately attach a
   ledger row to them. Both teardowns now begin by taking them out of those two
   lookups:

   ```sql
   UPDATE mo_creator_cycles      SET status='closed'   WHERE label LIKE $1 AND status='active';
   UPDATE mo_creator_point_rules SET is_active=false    WHERE name  LIKE $1 AND is_active;
   ```

   Nothing is blocked, nothing can deadlock, and by the time the deletes run
   there is no path left that could produce a new referencing row. The existing
   prefix-scoped ledger deletes then clear what is already there.

10. **"This cycle" is whichever cycle is globally latest, resolved twice.**
    *Observed once in seven full-suite runs; 8/8 green when the suite runs
    alone. Not fixed — diagnosed and recorded.*

    *Second sighting during Phase 17J validation, once in three full runs, with
    the identical assertion and the identical `expected +0 to be 120`. Ruled out
    as 17J's doing on three grounds: runMediaOpsAutomations() — which 17J's tests
    now call directly — contains no reference to mo_creator_point_ledger or to
    any creator cycle; no creator file was modified by the phase; and the two
    endpoints either side of the failing one agreed with the ledger, which is
    the signature of a THIRD resolution of "this cycle" disagreeing, not of
    missing ledger rows. Still unfixed: the endpoints resolve the current cycle
    independently, so a sibling suite creating a newer cycle between two calls
    changes the answer underneath a passing assertion.*

    ```
    FAIL server/mediaops-creator-analytics.integration.test.ts
      > points equal SUM over the point ledger, on every screen that shows them
    AssertionError: expected +0 to be 120
      at :342  expect((detail.body.rank).points).toBe(ledger)
    ```

    The creator's own view and the leaderboard both returned 120; the
    **manager's** view of the same creator returned 0. The three are read in
    sequence, and "this cycle" is resolved independently by each:

    ```sql
    SELECT id, label, starts_on, ends_on, status FROM mo_creator_cycles
     WHERE status IN ('active','closed')
     ORDER BY starts_on DESC, id DESC LIMIT 2
    ```

    That is a **global** read — the latest cycle in the whole table, not this
    file's. A sibling suite inserting a cycle with a later `starts_on`, or
    deleting the one that was latest, changes the answer between two calls in
    the same test. This is B4 again (the current cycle is a singleton), in a
    place B4 was not previously known to reach.

    Note it is *not* caused by §G.9's teardown change: that sets sibling cycles
    to `closed`, and `closed` is still inside this `IN` list. The race is the
    insert/delete, which has always been there.

    **Not fixed here**, because the phase that found it was scoped to a single
    equipment mutation and this is Creator-side. The test-scoped fix when
    someone takes it: the assertion already captures `usedCycle` from the first
    call, so the manager view should be compared against the ledger **for the
    cycle that view itself resolved**, rather than assuming all three resolved
    the same one. That keeps the property — every screen agrees with the ledger
    — without depending on which cycle is globally latest at that instant.

11. **A global figure, counted twice, with eleven sibling suites writing to it.**
    *Observed once in eight full-suite runs from Phase 13A onwards. Same class
    as §G.10, different test and different table. **FIXED in Phase 15**, after
    it failed a fourth validation gate.*

    **The fix**: the source is counted on BOTH sides of the endpoint call, and
    the dashboard's figure must fall within `[before, after]` — the strongest
    statement that is true under concurrency, and an exact equality whenever no
    sibling writes during the call. A wrong figure still fails; only the race
    is gone. The property was preserved, not loosened.

    The original diagnosis follows.

    ```
    FAIL server/mediaops-creator-analytics.integration.test.ts
      > every figure reconciles with its source > approved content equals the submission table
    AssertionError: expected 3 to be 4
      at :315  expect(dash).toBe(sql)
    ```

    The test asserts that the dashboard's "approved" figure equals a `COUNT(*)`
    over the submission table. Both are correct; neither is scoped to this
    file's `PX` prefix:

    ```js
    const dash = (await as("creatorAdmin", "GET", `/creator/analytics/summary?range=30d`))
                   .body.production.approved;          // round-trip 1
    const sql  = await pool.query(`SELECT COUNT(*) FROM mo_creator_submissions … `);  // round-trip 2
    expect(dash).toBe(sql);
    ```

    Two **global** reads of the same quantity, on two connections, one after the
    other. Eleven Creator integration suites run against this database at the
    same time, and several of them approve submissions. One approving between
    the two reads makes the second larger than the first — which is exactly the
    3 vs 4 observed. It is ordinary read skew, not a product defect: at no
    instant was the dashboard wrong.

    The test immediately below it already does the right thing for *its* own
    figure — it counts `WHERE a.user_id LIKE ${PX}-%`, this file's own rows, and
    asserts `toBeGreaterThanOrEqual(3)`. The reconciliation assertion is the one
    that reaches for a global.

    Two options were sketched here originally — scope both sides to `PX`, or
    read both sides at one snapshot. Neither was available: the summary
    endpoint has no creator filter, and it answers on its own connection, so a
    single transaction cannot span it. The bracket above is the third option
    and the correct one. It is **not** "widening the assertion to a range",
    which the original warning rejected: the bracket is the set of values the
    endpoint could legitimately have returned, and it collapses to one value
    when nothing else is writing.

    **Not caused by the phase that observed it.** The Phase 13A test file
    (`mediaops-inventory-scope.integration.test.ts`) contains no reference to
    any creator table; every row it writes is prefix-scoped to `zis` in
    `users`, `mo_user_profiles`, `mo_audit_logs`, `mo_equipment_items`,
    `mo_equipment_categories`, `mo_equipment_transactions`,
    `mo_asset_identifiers` and `mo_inventory_scopes`. Adding a 45th file does
    widen the timing window for races that already exist, which is the honest
    extent of the connection.

12. **bootstrapAssetFoundation()'s backfill races a sibling's DELETE.**
    *Diagnosed in Phase 14. **FIXED in Phase 15**, after it stopped being
    theoretical: it took down a suite's `beforeAll` and silently skipped all 48
    of its tests, which reads as a pass in the summary line.*

    **The fix**, applied to all four identifier backfills and to the primary-QR
    minting: the source select moved into a CTE with `FOR SHARE`, so each
    parent row is held for the duration of the statement and a concurrent
    `DELETE` waits instead of winning.

    ```sql
    WITH src AS (SELECT i.id, i.asset_tag AS v, i.created_at
                   FROM mo_equipment_items i WHERE i.asset_tag IS NOT NULL
                  FOR SHARE)
    INSERT INTO mo_asset_identifiers (...) SELECT ... FROM src
    ON CONFLICT (value) DO NOTHING
    ```

    It was *not* fixed by catching and ignoring 23503, which would have
    silently skipped identifier rows — the trap named when this was first
    written up.

    The original diagnosis follows.

    ```
    FAIL server/mediaops-module-defaults.integration.test.ts
      > a fresh installation is configured, not implicit
      > is idempotent — a second bootstrap changes no row
    error: insert or update on table "mo_asset_identifiers" violates foreign key
           constraint "mo_asset_identifiers_asset_id_fkey"
      at bootstrapAssetFoundation server/mediaops-db.ts:1777
    ```

    The backfill gives every asset an `asset_tag` identifier row:

    ```sql
    INSERT INTO mo_asset_identifiers (asset_id, kind, value, is_primary, created_by)
    SELECT i.id, 'asset_tag', i.asset_tag, true, … FROM mo_equipment_items i
    ON CONFLICT DO NOTHING
    ```

    Under READ COMMITTED the SELECT reads `i.id` from its own snapshot, but the
    foreign key is checked against the table as it stands when the row is
    written. A sibling suite that deletes that asset in between — which the
    equipment suites do constantly — commits, and the INSERT then points at
    nothing. `ON CONFLICT DO NOTHING` does not help: this is a missing parent,
    not a duplicate.

    It is a real (if narrow) production race too: two app instances starting
    while assets are being deleted. The advisory lock added in §G.9 serialises
    bootstrap against *another bootstrap*, not against ordinary traffic.

    **The fix taken** was the first of the two options sketched here:
    `FOR SHARE` on `mo_equipment_items`, so the parent rows cannot be deleted
    under it.

    A SECOND race on the same table was found at the same time and is worth
    recording separately: bootstrap **mints a primary QR token** for any asset
    that lacks one, and a test fixture that inserted its own primary QR with
    `ON CONFLICT (value) DO NOTHING` was racing it for
    `uq_mo_asset_ident_primary (asset_id, kind) WHERE is_primary` — a
    constraint that conflict target does not cover, so the loser threw instead
    of skipping. Fixed on the test side: the fixture's token is not primary,
    because nothing about it needs to be. `resolve` matches on VALUE, which is
    what a scanned label actually carries.

    **What Phase 13B did do**: its own suite originally dropped and recreated
    three `mo_equipment_items` rows in `beforeEach` — thirty-five times a run.
    That churn is gone; the rows are created once and only their STATE is reset
    per test. Isolation is unchanged. The race was not introduced by that
    suite, but it was being made likelier, and that part was ours to undo.

13. **Module defaults resolve differently while a sibling is editing them.**
    *Observed twice during Phase 13B validation, in two different tests, on two
    different suites. Diagnosed, not fixed — Creator/module-defaults territory,
    and unrelated to inventory scope.*

    ```
    FAIL server/mediaops-module-defaults.integration.test.ts
      > a creator still resolves to the network and nothing else
    AssertionError: expected [ 'creator', 'home' ] to deeply equal [ 'creator' ]

    FAIL server/mediaops-crew-lifecycle.integration.test.ts
      > keeps the prior module grant when none is supplied
    AssertionError: expected [ 'boards', 'calendar', 'home', …(2) ]
                    to deeply equal [ 'home', 'projects' ]
    ```

    Both assert an exact module list resolved through `effectiveModules()`,
    which reads configuration several suites write to. The extra entries are
    another suite's defaults, seen mid-edit. This is the same shape as §G.10
    and entry 11: **a global singleton, read as though it were the file's own.**

    That is now three separate places where the pattern has bitten, which makes
    it a class rather than three incidents. The durable fix is for each suite
    to assert over configuration it owns — or for `effectiveModules()` to be
    given an explicit configuration argument in tests rather than reading the
    live table — not for each assertion to be loosened one at a time.

14. **"Count the whole table" is not a test of your own write.**
    *Two instances found and FIXED during Phase 15, both introduced by earlier
    phases of this same series. Recorded because it is now the fourth sighting
    of one pattern, and the fix is the same every time.*

    ```
    FAIL server/mediaops-inventory-scope.integration.test.ts
      > bad input > writes nothing when it refuses
    AssertionError: expected 5 to be 4

    FAIL server/mediaops-custodian.integration.test.ts
      > the assignment ledger > leaves every existing asset ungoverned
    AssertionError: expected 2 to be 0
    ```

    Both counted a shared table with no predicate:

    ```js
    const before = COUNT(*) FROM mo_inventory_scopes;      // ← the whole table
    …two refused POSTs…
    expect(COUNT(*) FROM mo_inventory_scopes).toBe(before);
    ```

    Correct the day it was written, when one suite created scopes. Phase 13B
    added a second and Phase 15 a third, all running in parallel against the
    same database, and the count then moves between the two reads for reasons
    that have nothing to do with the refusal being tested.

    **The fix, in both cases: count by ACTOR, not by total.** The CRUD engine
    stamps `created_by` with the caller, and every suite creates its rows as
    its own prefixed user, so `WHERE created_by LIKE 'zis-%'` is exactly the
    set that suite could have written. Where the claim is about a MIGRATION
    rather than a suite, the discriminator is the opposite one:
    `WHERE created_by IS NULL` — a migration has no actor, and no test can
    produce that row.

    This is the same failure as §G.10, entry 11 and entry 13: **a global read
    treated as if it were the file's own.** Four sightings across three
    different tables is not three accidents and one coincidence; it is the
    default mistake of this test suite's shape. The rule worth remembering:

    > If the assertion would still be true when another suite is running, scope
    > the query to something only your suite can produce. A prefix, an actor,
    > or an id you captured — never a bare COUNT(*).

    Loosening the assertion to a range is not a fix; it deletes the property
    the test exists to protect.

15. **Entry 14 again, three times — and why "measure it earlier" is not a fix.**

    Phase 17D. Three assertions in the Asset & Inventory suites failed
    intermittently once 17C made inventory assignment routine and 17D added
    fixtures of its own:

    ```
    FAIL server/mediaops-inventory-scope.integration.test.ts
      > the migration > seeds the two APPROVED inventories, and invents nothing else
    FAIL server/mediaops-inventory-foundation.integration.test.ts
      > backfilling internal codes > is idempotent — running it again finds nothing to do
    ```

    The first had already been "fixed" once, by moving the count into
    `beforeAll` so it was taken "at the instant after bootstrap". That reasoning
    is wrong and worth naming: **moving a global read earlier narrows the window,
    it does not close it.** By the time any suite's `beforeAll` runs, ten others
    are already running, and one of them has already attached a fixture to a
    seeded inventory. The measurement was as global as it had ever been; it just
    failed less often, which is worse.

    What separates the populations here is not *when* the row was written but
    *what it belongs to*. Every suite in this repository names its fixture
    category `<zxx> Something` — the prefix convention is three letters starting
    with `z`. So:

    ```sql
    JOIN mo_equipment_categories c ON c.id = i.category_id
    WHERE s.created_by IS NULL AND c.name !~ '^z[a-z][a-z] '
    ```

    is exactly "assets the registry seeded, attached to an inventory the
    migration seeded" — the population a backfill would have moved, and one no
    sibling suite can write into. With that predicate the assertion can be taken
    **live**, which is stricter than the `beforeAll` version ever was: a backfill
    at any point during the run now fails it.

    The third case was different again. `remaining_eligible` in the backfill
    response is **deliberately global** for an admin — it answers "what is still
    uncoded anywhere", which is right for an operator and useless as an
    assertion. The test now runs the backfill against one inventory and queries
    that inventory. When an endpoint's figure is intentionally global, do not
    narrow the endpoint; narrow the test.

16. **A migration that rebuilt a correct constraint on every bootstrap.**

    Not a flake — a contention source that makes flakes likelier, found while
    writing an idempotence test for Phase 17D.

    ```ts
    await pool.query(`ALTER TABLE mo_equipment_items DROP CONSTRAINT IF EXISTS …_tracking_check`);
    await pool.query(`ALTER TABLE mo_equipment_items ADD CONSTRAINT …_tracking_check CHECK (…)`);
    ```

    `CREATE … IF NOT EXISTS` has no equivalent for a constraint whose definition
    changes, so the obvious way to write "replace this CHECK" is a DROP + ADD
    pair. Unconditionally, that takes an **`ACCESS EXCLUSIVE` lock on
    `mo_equipment_items`** every time the schema is bootstrapped — and roughly
    fifty suites bootstrap it concurrently, each already holding locks of its
    own. The definition was correct on all but the first of those fifty runs.

    The fix is the `uq_mo_equip_serial` lesson from Phase 17B in another shape:
    read what is actually stored, and act only on a difference.

    ```ts
    const have = SELECT pg_get_constraintdef(oid) … WHERE conname = $1;
    if (have?.includes(marker)) return;            // already the wanted shape
    ```

    The regression test compares constraint **oids** across a second bootstrap: a
    dropped-and-recreated constraint gets a new oid, so reverting to the
    unconditional form fails immediately rather than showing up months later as
    an unexplained timeout.

    The same shape still exists on `users`, `mo_requests` and
    `mo_casting_requests`. It is recorded here rather than changed, because
    those tables were outside the phase that found it.

---

# Operational rules (Phase 17E.1)

The entries above are incident reports. This section is the short version a
person needs *while writing a test*, plus the two audits that look for the same
mistakes mechanically.

## 17. Fixture-scoped assertions

**One database, every suite, in parallel.** An assertion that reads rows it did
not create is measuring a moving target. It passes on your machine, passes in
review, and fails three weeks later in somebody else's run.

**The rule:**

> If the assertion would still be true when another suite is running, scope the
> query to something only your suite can produce. A prefix, an actor, or an id
> you captured — never a bare `COUNT(*)`.

**What counts as owning a row** — pick the narrowest one that fits the entity:

| Discriminator | Use it for | Example |
|---|---|---|
| Captured fixture category | assets, anything with a category | `WHERE category_id = ANY($1)` with the ids `beforeAll` created |
| Captured scope id | inventory-bound rows | `WHERE scope_id = $1` |
| Captured user id | ledger rows, audit, notifications | `WHERE actor_id = $1` |
| Suite prefix | rows whose natural key you control | `WHERE asset_tag LIKE 'EQ-ZIF-%'` |
| A captured row id | one specific thing | `WHERE id = $1` |

**`created_by IS NULL` is not fixture ownership.** It is the opposite: the
signature of a row written by a *migration*, which has no actor. It is the right
discriminator for "no test wrote this", and the wrong one for "my test wrote
this". NULL means nobody claimed it, not that you did.

**Scoping one side is not enough.** `WHERE s.created_by IS NULL` rules out a
*scope* a test could have made and says nothing about the *asset* attached to
it. Both ends of a join need a discriminator, or neither does.

**Moving a global read earlier does not fix it.** Taking the count in `beforeAll`
"at the instant after bootstrap" narrows the window and closes nothing — by the
time any suite's `beforeAll` runs, ten others are already writing. This was tried
and failed twice.

**When the figure is genuinely global, narrow the test, not the endpoint.**
`remaining_eligible` and the per-inventory asset counts are global on purpose:
they answer an operator's question. Assert them against an inventory your suite
owns, or compare a window `[before, after]` rather than an equality.

**A before/after delta is a global assertion wearing a disguise.** This one
survived review because it *looked* careful — it filtered to one inventory and it
took a baseline first:

```js
const before = (await sum("admin", "?inventory=media_crew")).checked_out;
await checkout(id);
expect((await sum("admin", "?inventory=media_crew")).checked_out).toBe(before + 1);
```

It failed at 1 against 2. Taking a baseline does not freeze it. `before + 1`
asserts *"my checkout is the only write to media_crew between these two HTTP
requests"* — which is a claim about the other forty suites, not about the code
under test. The narrower filter bought nothing, because the sibling suites write
to `media_crew` too.

The claim the test actually wanted was "the dashboard reflects this mutation",
and that claim is about **one asset**, so assert it about one asset:

```js
expect(await held()).not.toContain(id);   // before
await checkout(id);
expect(await held()).toContain(id);       // after
```

Now concurrent traffic moves the list around this row without touching the
verdict. **Prefer membership of a row you own over arithmetic on a total** —
`toContain(id)` is exact, order-free, and immune to everything the delta was
counting by accident.

**Legitimately global assertions exist and should stay that way** — a migration
invariant, a bootstrap idempotence check, a schema shape. Do not rewrite them.

Run `npm run audit:test-isolation` to list candidates. It is **advisory and
always exits 0**: on the run that produced it, 36 candidates contained 4 real
defects, so a CI gate at that precision would be turned off within a week.
Classify each candidate A–E using the key printed at the top of the script.

## 18. Adversarial read-model tests

**The incident.** `ASSET_SELECT` emitted two result columns named
`tracking_mode`:

```sql
COALESCE(i.tracking_mode, c.tracking_mode) AS tracking_mode,   -- the item's
...
c.name AS category_name, c.tracking_mode,                      -- the category's
```

node-postgres assigns result columns to object keys in order, so the second one
won and **the item-level override was discarded on every read for four phases**.
A pooled item in a serialized category reported itself as serialized — the one
thing `tracking_mode` exists to prevent. Postgres raises nothing; two columns of
the same name are perfectly legal SQL.

**Why no test caught it.** Every test that exercised pooling created the pooled
item in a *pooled* category. The item's answer and the category's agreed, so
whichever column won, the assertion passed.

**The pattern that catches it.** When a read model joins entities that share a
column name, write the test so the sources **disagree**:

```
item.tracking_mode     = pooled
category.tracking_mode = individual
expected API result    = pooled          ← only one source can produce this
```

Then assert the *other* source is still reachable under its own name
(`category_tracking_mode`), so the fix cannot be "delete the second column".

**Dimensions worth making disagree**, when a read model joins on them: `id`,
`name`, `code`, `status`, `state`, `type`, `role`, `quantity`, `tracking_mode`,
`scope_id`, `category_id`, `user_id`, `created_at`, `updated_at`. Only where the
join actually creates the overlap — an artificial test for a column that appears
once is noise.

**A UNION takes its column names from the first branch** and discards the rest.
Later branches cannot shadow anything, but they must keep the same order: a
transposition puts one column's value under another's name and nothing complains.
Assert a field from each branch.

Run `npm run audit:read-models` to find duplicate output names statically. Unlike
the isolation audit this one **fails on a finding** — it needs no database for
that check and has no known false positives here. It resolves `alias.*`
projections against the live schema when a database is reachable, and says so
when it cannot. Reintroducing the `tracking_mode` defect makes it exit 1.

## 19. RESOLVED: a notification appears inside a lock that should exclude it

**Status: DIAGNOSED AND FIXED in Phase 17O.** Seen across Phases 17L, 17M and
17N, roughly one full-suite run in three, never in isolation.

**The answer, and it was not where anyone was looking.** Phase 17N replaced the
count with the ROWS. The next failure named the writer immediately:

```
a read added notifications: [
  {kind: "maintenance", entity_type: "maintenance", user_id: "zrg-nadmin",
   title: "Maintenance open — EQ-ZEQ-164"},
  {kind: "maintenance", entity_type: "maintenance", user_id: "zrg-nadmin",
   title: "Damage reported — EQ-ZEQ-212"}]
```

`EQ-ZEQ-*` is the **equipment** suite. It opened maintenance on its own asset,
and 17J's `maintenanceRecipients()` notifies every active media admin the scope
allows — for an unscoped asset, deliberately everybody, as its comment says.
`zrg-nadmin` is an admin the **recognition** suite creates, so it received mail
about another suite's camera. Correct product behaviour; nothing to fix in the
application.

**Why the lock never helped.** It excludes concurrent creator automation passes.
No creator pass was ever involved. Three phases of reasoning about that lock
were reasoning about the wrong subsystem, and a bare count could not say so.

**The fix** is one predicate: the assertion counts notifications to this suite's
users *in this suite's domain*, `entity_type NOT IN ('equipment','maintenance',
'equipment_item')`. The row detail stays, so a third domain fanning out to these
admins will name itself the same way.

**The lesson, and it is the reusable part.** A count that fails tells you only
that it failed. The same assertion over a SET costs nothing extra and, on the
day it breaks, hands you the row. Three phases and three sightings produced no
diagnosis; one run with the ids produced it in full. **Assert over the rows you
mean, not the number of them.**

```
server/mediaops-creator-recognition.integration.test.ts
  > creators are told about their recognition, and not about everybody else's
AssertionError: expected 87 to be 86
```

The assertion is already careful. It scopes to `user_id LIKE 'zrg-%'` — this
suite's own actors — and it holds `GLOBAL_LOCK.creatorAutomations` across the
window precisely because `runCreatorNetworkAutomations()` walks every active
creator and would otherwise write into these fixtures legitimately. Something
still adds one notification to a `zrg-` user between the two counts.

**Ruled out, so nobody repeats it:**

| Hypothesis | Finding |
|---|---|
| Another suite shares the `zrg` prefix | No. Every suite prefix is unique. |
| The two GETs in the window write | No. `GET /creator/leaderboard` and `GET /creator/achievements` contain no INSERT, UPDATE, DELETE, `notify` or `audit` call. |
| An automation pass ran unlocked | No. Both callers of `runCreatorNetworkAutomations()` in tests wrap it in `withGlobalLock` on the same key. |
| The boot scheduler fired | No. `setTimeout(... 9000)` lives in the `app.listen` path in `server/index.ts`, which integration tests do not take. |
| A fire-and-forget notification landed late | No unawaited `notify*` call exists on the creator path. |
| A database trigger | No triggers on `mo_notifications`. |

**Ruled out above, all correctly** — the hypotheses were sound and every one of
them was wrong, because the writer was in a domain nobody had thought to
suspect. That is the case for instrumenting rather than theorising.

**Not caused by 17M.** The phase touches assets and reconciliation, shares no
table with creator recognition, and the failure predates it.

### 19b. A sibling in the same family: the window that runs backwards

```
server/mediaops-creator-analytics.integration.test.ts
  > approved content equals the submission table
AssertionError: dashboard 18 outside [18, 15]
```

This one IS diagnosed, and the diagnosis is in the test's own comment. Entry 11
replaced an equality with a `[before, after]` window, on the stated assumption
that "submissions are approved and never un-approved by the siblings", so the
count can only rise.

It can also **fall**. A sibling suite's teardown deletes its submissions, and
then `after` (15) is smaller than `before` (18) — the window is inverted and
every value fails it, including the correct one. The dashboard answered 18,
which equals `before`, so it was right at the instant it ran.

The fix is to order the bounds rather than assume them:
`[Math.min(before, after), Math.max(before, after)]`. Deliberately not applied
here — it belongs to the Creator analytics suite and 17M's brief is explicit
that unrelated tests are not to be edited for green. Written down so whoever
owns that file can apply a one-line change instead of re-deriving this.

**The family.** Entries 11, 19 and 19b are the same shape in three Creator
suites: a figure counted from a shared table, compared across two instants.
Collectively they trip roughly one full-suite run in three. None of them has
ever failed in isolation, and none involves the Media Ops asset estate.

## 20. A backtick in a SQL comment, and why typecheck will not save you

Third sighting, so it goes in the file.

The SQL in this codebase lives in template literals, and the SQL is commented
as heavily as the TypeScript around it. Put a backtick inside one of those
comments — quoting a column name, the way you would anywhere else —

```js
await pool.query(`
  SELECT ...
         /* These are NOT verification: 17D's `pending_verification` above
            asks whether a RECORD has been accepted ... */
         COUNT(*) ...`);
```

— and the literal ends at that backtick. What follows is parsed as code.

**`npx tsc --noEmit` reported no error.** Neither did `npm run build`. The
fragments still form something TypeScript is willing to parse, so the only
thing that failed was SWC, when vitest transformed the file:

```
Error: x Expected ',', got 'ident'
  ,-[server/mediaops-api.ts:5906:1]
```

**What this means in practice.** A green typecheck is not evidence that a file
containing SQL still parses the way you meant. After editing a template
literal, run something that transforms the file — the suite that covers it is
enough, and it is the step that caught this every time.

**The rule:** inside a template literal, quote identifiers with capitals or
plain words. `pending_verification`, not a backticked one. The comment is for a
human; the backtick is for the parser, and the parser is not reading the
comment.

## 21. Offset paging over a table the whole run writes to

`GET /audit` is the estate-wide log, and 17N gave it pages. The obvious test —
read page one, read page two, assert they do not overlap — passed on its first
full run, failed on the second, and the failure was honest:

```
× pages with a total, and page two does not repeat page one
  → two pages overlapped: expected [ 526592, 526591 ] to deeply equal []
```

Sixty other suites were writing to `mo_audit_logs` between the two requests.
The list is ordered newest-first, so five new events push everything down five
places and `OFFSET 5` lands back inside what was page one. **The rows really
did repeat, and the endpoint is correct**: that is what offset paging over a
growing list does, in this product and in every other one.

So the test was asking a question the API cannot answer — "is this list stable
while you read it" — and calling the answer a defect. What it should ask is
whether the page boundary is right, and that can only be asked of a list that
holds still. Entry 17 again: **scope the query to something only your suite can
produce.** Twelve rows are planted under an `entity_type` no other suite writes,
`?entity_type=…` selects exactly them, and the three pages are asserted to be
the twelve rows with nothing repeated and nothing missing.

Planting them with one `occurred_at` is deliberate and makes the test stronger
than the original: with every timestamp equal the order is decided entirely by
the `id DESC` tie-break, so a boundary without one fails every run instead of
one in three.

**The same shape, the same week.** `a student browses PID and sees nothing of
Media Crew` read `/equipment?limit=200` and asserted its own asset was in the
result. It was, until the siblings had made two hundred assets the student
could also see, and then it was on page two. Fixed by filtering to the block's
own category — and, while there, by asserting that a custodian DOES see the
hidden asset through the same read, so the negative half cannot pass by the
asset simply not existing.

**Both of these were mine, in tests written the same day.** The tell is the
same in both: an assertion about a shared, growing table that happens to be
true when nothing else is running.

## 22. When the flake is the messenger

A third failure in the same triple run looked like the family in entry 19:

```
× keeps the prior module grant when none is supplied
  → expected [ 'boards', 'calendar', 'home', …(2) ] to deeply equal [ 'home', 'projects' ]
```

A crew-lifecycle fixture created with `["home","projects"]` read back as five
modules. Intermittent, cross-suite, count-adjacent — everything about it says
"scope the assertion and move on".

It was a product defect. `bootstrapMediaOpsDatabase()` carries the migration
that expanded the old coarse module keys into sidebar keys, and its guard was
"this row contains any legacy key". Two legacy keys — `projects` and
`performance` — are also current sidebar keys, so the migration matched rows in
the NEW vocabulary and re-expanded them on every single boot:

```
["home","projects"] → ["boards","calendar","home","pipeline","projects"]
```

Ticking Projects for an employee silently also gave them Pipeline, Boards and
Calendar, and since `POST /crew/:id/role` strips `boards` when it demotes
somebody, the next restart gave it back. The test was intermittent only because
it depended on a sibling suite's bootstrap landing between the fixture being
written and being read.

**The rule this leaves.** Before scoping a flake away, read what the wrong value
actually is. `['boards','calendar','home',…]` is not noise and not a count off
by one — it is a specific, sorted, plausible list, and a shared-table flake has
no reason to produce one. A wrong value that looks *deliberate* is worth ten
minutes of following before it is worth stabilising. Reproducing it took one
`BEGIN; … ROLLBACK;` against the test database.

## 23. The database the tests never build

17P went looking for a frontend defect and found a deployment one, because it
did something the suite does not: it created an empty PostgreSQL database and
asked Nerve to build itself in it.

```
ok   bootstrapDatabase
ok   bootstrapBrandingDatabase
ok   bootstrapSettingsDatabase
ok   bootstrapOutreach
ok   bootstrapDesignDatabase
FAIL bootstrapMediaOpsDatabase → relation "mo_equipment_transactions" does not exist
```

Three faults of the same shape, one after another — an index created a few
hundred lines above the table it indexes, a second table indexed before it was
declared, and an index on a column added by a later `ALTER`. Two were 17N's.
One predated it by several phases. **Every one of them was a first deployment
that could not start**, and none of them could fail in the test suite, because
`scripts/test-db-setup.sh` creates `nerve_test` once and every run after that
inherits a database that already has the schema.

**The rule.** `IF NOT EXISTS` makes a statement safe to **repeat**. It does not
make it safe to run **early**. Idempotence and ordering are different
properties, and a suite running against a long-lived database can only ever
observe the first one.

**What now checks it.** `npm run audit:migration-order` — static, instant, no
database — asserts that every `CREATE INDEX` follows the `CREATE TABLE` it
names and every column it uses. It is in the same family as the read-model and
isolation audits, and it fails the run on a finding rather than advising.

Building a real empty database is still the stronger check and is worth doing
before a release; the script is what makes the cheap version run every time.

## 24. A test that passes all day and fails all evening

The access-management triple failed three times out of three on the same
assertion, which is the useful kind of failure:

```
× a project's equipment > reports the project's OWN dates without making them the booking's
  → expected '2026-10-04' to be '2026-10-03'
```

The fixture is created in SQL:

```sql
INSERT INTO mo_projects (..., start_date, end_date)
VALUES (..., CURRENT_DATE + 10, CURRENT_DATE + 20)
```

and compared against the suite's own helper:

```js
const day = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
```

`CURRENT_DATE` is the **database's** day. `toISOString()` is the **UTC** day.
This module is IST throughout — every date rule in the API compares against
`(NOW() AT TIME ZONE 'Asia/Kolkata')::date` — and **between 18:30 and 24:00 UTC
the IST day is already tomorrow**. The run started at 02:16 IST, which is 20:46
UTC, so the fixture said 2026-10-04 and the test expected 2026-10-03.

**Why it had never been seen.** Outside that five-and-a-half-hour window the two
days agree and every assertion passes. A suite run during the working day cannot
observe it. There is nothing intermittent about it — it is deterministic inside
the window and impossible outside it, which is worse than a flake, because a
flake at least announces itself early.

**The fix.** One shared `istDay()` beside the suite's other helpers, and all five
local `day()` definitions now point at it. The sibling scope-auth suite has
carried exactly this helper, with exactly this comment, since Phase 13B — the
lesson existed and had not travelled.

**The rule.** If a fixture's date comes from SQL (`CURRENT_DATE`, `NOW()`), the
assertion's date must come from the same timezone the server uses. A date helper
built on `toISOString()` is a UTC helper, and this product does not have a UTC
day. When a date test fails by exactly one day, check the clock before checking
the logic.
