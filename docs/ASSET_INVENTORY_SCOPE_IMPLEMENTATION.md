# Inventory Scope — Foundation (Phase 13A)

> **Superseded by Phase 13B.** The headline below was true when this was
> written and is no longer: scope **is** now an authorization boundary. See
> [ASSET_INVENTORY_SCOPE_AUTHORIZATION.md](ASSET_INVENTORY_SCOPE_AUTHORIZATION.md).
> Everything else in this document — the table, the CRUD registration, the
> indexing decision, the omitted columns — still stands, with one exception
> noted at §11: the "line not crossed" tests were rewritten by 13B, which is
> exactly what they were written to force.

**Inventory scope exists, but scoped authorization is not yet implemented.**

That sentence was the whole status of this phase and the reason it is at the top
of the document. A scope row can be created, renamed, disabled, archived and
deleted. An asset can point at one. Nothing anywhere reads that pointer to
decide what anybody may see, borrow, book or return. Creating the row is not
securing the asset.

---

## 1. What was built

| | |
|---|---|
| A table | `mo_inventory_scopes` — 8 columns, no seed rows |
| A nullable link | `mo_equipment_items.scope_id` — no backfill, nothing assigned |
| A registry entry | `inventory_scopes` in the existing CRUD engine |
| **New endpoints** | **none** |
| **New client code** | **none** |
| **New roles** | **none** |
| **New modules** | **none** |
| Tests | 35, in `server/mediaops-inventory-scope.integration.test.ts` |

Three files changed: `server/mediaops-db.ts` (the migration),
`server/mediaops-api.ts` (one registry entry), and one new test file.

---

## 2. What an inventory scope is

**Whose stock an asset belongs to** — the owner a custodian can be custodian
*of*.

Media Ops has always run a single estate. An asset carries a `department_id`
and a `campus_id`, but those are *attributes* of the asset, not owners of it:
neither can answer "who is accountable for this cupboard, and who is allowed to
lend from it". Phase 11 found that the authorization chain
(`requireMedia` → `requireModule('equipment')` → `canManageEquipment`) has no
place to express ownership at all — an equipment custodian is a custodian of
everything or of nothing.

A scope is the missing noun. `PID` and `24 Frames` are the two the university
actually has, but **neither is written anywhere in this phase** — they are rows
somebody will create, not constants in the code.

### The shape

```sql
CREATE TABLE mo_inventory_scopes (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        TEXT NOT NULL,             -- for humans; may change
  code        TEXT UNIQUE NOT NULL,      -- the machine identifier; stable
  is_active   BOOLEAN NOT NULL DEFAULT true,
  archived_at TIMESTAMPTZ,
  created_by  TEXT REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

Modelled on `mo_campuses`, the closest existing lookup — and not by analogy
alone: **`mo_equipment_items` already carries a nullable `campus_id` pointing at
exactly such a table.** `scope_id` is the same kind of column on the same table.

---

## 3. The decision that shaped the phase: no new endpoints

The brief asked for "the minimum CRUD/read surface needed" and listed four
candidate endpoints, with an instruction not to build all four automatically but
to determine the minimum. **The minimum turned out to be zero.**

`server/mediaops-api.ts` contains a configuration-driven CRUD engine. A module
declares its table, fields, display columns and dependencies; the engine
supplies list, search, sort, pagination, create, edit, duplicate,
enable/disable, archive, dependency-checked delete, bulk actions, per-record
audit history and permissions. **Twenty config modules already use it**,
`campuses` among them. The client's own comment states the contract:

> *Adding a new module = one registry entry on the server. Zero page code.*

So the entire surface for this phase is this, beside `campuses`:

```ts
inventory_scopes: { key: "inventory_scopes", label: "Inventory Scopes", table: "mo_inventory_scopes",
  fields: [
    { name: "name", label: "Name", type: "text", required: true },
    { name: "code", label: "Code", type: "slug", required: true }],
  cols: ["name", "code"],
  deps: [{ table: "mo_equipment_items", fk: "scope_id", label: "Equipment items" }] },
```

What that one entry buys, against the brief's requirements for every endpoint:

| Requirement | How it is met |
|---|---|
| Authenticated session | `requireMedia()` on every `/crud/*` route |
| Media Ops access | same call — a caller with no media role is refused |
| Existing authorization architecture | `crudCan()`, unchanged; no new role |
| Validate inputs | `crudValidate()` against the declared field metadata |
| Fail closed | unknown module → 400; no permission → 403; no session → 403 |
| Audit mutations | existing `audit()` → `mo_audit_logs`, `entity_type='inventory_scopes'` |
| Never trust caller-supplied scope | no endpoint accepts a scope as authorization input, because no endpoint reads scope at all |

**A bespoke `/equipment/scopes` surface was considered and rejected.** It would
have been a second way to manage a config table, a second validation path, a
second permission check and a second set of tests, for an object whose nearest
sibling (`campuses`) is already managed generically. It would also have left
`mo_inventory_scopes` outside the lifecycle contract every other config table
obeys.

### The resulting URLs

Nothing here is new; the module key is.

```
GET    /api/v1/media/crud/meta                      module definitions + the caller's permissions
GET    /api/v1/media/crud/inventory_scopes          list  (?q= &status= &sort= &dir= &page= &per=)
GET    /api/v1/media/crud/inventory_scopes/:id      row + dependencies + audit history
POST   /api/v1/media/crud/inventory_scopes          create
PATCH  /api/v1/media/crud/inventory_scopes/:id      edit
POST   /api/v1/media/crud/inventory_scopes/:id/state  enable | disable | archive | restore
DELETE /api/v1/media/crud/inventory_scopes/:id      delete, refused when in use
```

---

## 4. Who may do what

Inherited from `crudCan()` exactly as it stands. **No role was created, and no
"Inventory Admin" exists.**

| | read | create | edit | enable/disable | archive | delete | force-delete |
|---|---|---|---|---|---|---|---|
| Admin (media) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| Team Lead (`sub_admin`) | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| Crew member (`user`) | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Not media crew | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Super Admin | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

**One line here deserves to be challenged, and this document will not bury it:
a Team Lead can create and rename a scope.** That is right for a lookup table
and is not obviously right for a permission boundary. It is only acceptable
today *because scope is not a boundary* — a scope row changes nothing about who
may see or borrow anything. The phase that makes scope decide access has to
revisit this, and the test
`"lets a team lead create and edit, but not archive or delete"` asserts the
current split so that revisiting it is a visible change rather than a silent
one.

Note also that there is **no 401 anywhere in this surface**: `requireMedia()`
answers 403 for a caller with no media role, and an absent session has none.
The distinction between "not logged in" and "not media crew" is not one this
architecture draws, and this phase did not start drawing it.

---

## 5. What was deliberately left out, and why

Each of these was proposed — several by the Phase 12 design — and each is
recorded in a comment at the migration site so the omission reads as a decision.

| Not created | Why |
|---|---|
| `parent_scope_id` | Nothing needs a hierarchy. PID and 24 Frames are siblings. |
| `metadata` JSON | Where undesigned fields go to hide. |
| `type` / `scope_type` | **Phase 12 proposed this; Phase 13A does not implement it.** See below. |
| `department_id`, `campus_id`, `academic_unit_id` | Context links from the Phase 12 design. No screen or query in this phase reads them. |
| `NOT NULL` on `scope_id` | There is no correct value for an existing asset, and inventing one would be fabricating ownership. |
| A backfill | Same reason. **Zero assets were assigned.** |
| Seed scopes | A seeded 'PID' would be a product decision taken by a migration. |
| An `/equipment/scopes` API | §3. |
| An Academic Inventory module, screen or nav entry | §7. |
| An index on `scope_id` | §6 — measured, not justified yet. |

### The Phase 12 discrepancy, stated plainly

The Phase 12 design document proposed a `type` column (production / academic)
so that a future academic inventory would need a row rather than a migration.
**It is not in this table.**

Nothing in Phase 13A branches on it. The only behaviour that would — *does a
loan of this kind need approval?* — belongs to a later phase, and adding a
column now to serve code that does not exist is exactly the speculation this
series has avoided since Phase 6. The column is additive whenever that code
arrives, at which point the values it should hold will be known rather than
guessed. This is a deliberate departure from the Phase 12 design and not an
oversight.

---

## 6. Indexing — measured, and declined

The brief asked for evidence-based indexes and specifically for `(scope_id)` to
be evaluated. It was, against a synthetic estate of **5,000 assets** (2,500
scoped across 12 scopes, 2,500 still unscoped — the state this phase actually
leaves behind), in the test database.

The only query in the codebase that filters on `scope_id` is the CRUD engine's
dependency count, which runs when an admin opens or deletes a scope.

| `SELECT COUNT(*) FROM mo_equipment_items WHERE scope_id=$1` | Execution | Round-trip median |
|---|---|---|
| Without an index | 0.392 ms | 0.56 ms |
| With `(scope_id)` | 0.108 ms | 0.15 ms |

The index is 56 kB and makes the query ~3.6× faster. **It was not added.**
0.39 ms on an admin configuration screen is not a cost worth an index, and this
series has refused speculative indexes since Phase 6.

**The condition that changes the answer:** the first query that filters on
`scope_id` on a *user-facing* path. Scoped authorization is precisely that —
every equipment list would gain a `WHERE scope_id = ANY(...)` on the registry's
hot path. The index should be added by the phase that adds that predicate,
where it can be measured against the query that needs it.

### Other measurements

| | Result |
|---|---|
| Registry page, 5,000 assets, with the nullable column present | 0.016 ms exec, 0.17 ms median round-trip — **no regression** |
| Scope list (engine list query) | 0.011 ms exec, 0.15 ms median |
| Scope detail (row + dependency count + audit history) | 0.76 ms median |
| Queries per scope detail | **3**, independent of asset or scope count |
| Queries per scope list | **2** (count + page), independent of row count |

No N+1: the dependency count is one aggregate per declared dependency, and
`inventory_scopes` declares one.

---

## 7. User interface

**None was built.** No navigation entry, no screen, no placeholder.

The scope appears in the existing Admin configuration page as one more chip in
a strip that is rendered from `/crud/meta` — the same way Campuses, Work Types
and Academic Units appear. That is not new UI; it is an existing screen
discovering a new module key. No file under `public/media-ops/` was modified.

This satisfies the brief's condition that a UI appear "only if an appropriate
existing admin location exists". One does, and it required zero page code.

`/state` was **not** touched: no scope data is shipped in the boot payload, and
a test asserts it.

---

## 8. Tests

35 tests in `server/mediaops-inventory-scope.integration.test.ts`, real
handlers against a real database, every fixture prefixed `zis`.

This file is also **the CRUD engine's first direct test coverage.** The audit
found no test in the repository issuing a request to any `/crud/` endpoint,
which is how its permission split, dependency-checked delete and archive path
came to be entirely unexercised.

| Group | Covers |
|---|---|
| the migration (5) | the 8-column lifecycle contract; the refused columns are absent; `scope_id` is nullable with no default; bootstrap creates no scopes and assigns no assets; idempotence |
| a scope's life (8) | create; `created_by` recorded unasked; code normalisation; list; detail with dependencies and audit history; rename leaves the code alone; disable keeps the row and moves it between status lists; archive and restore |
| bad input (7) | duplicate code; duplicate differing only by case or spacing; missing name; missing code; a code that slugs away to nothing; nothing written when refused; 404 for an absent scope |
| authorization (6) | no session; not media crew; member may read but not write; team lead may create/edit/disable but not archive/delete; force-delete refused to a media admin; every mutation audited |
| equipment undisturbed (7) | an asset registers with no scope; lists and opens normally; `scope_id` leaks into no read model; absent from `/state`; behaves identically once scoped; an assigned asset blocks the scope delete (409); an unused scope deletes |
| the line not crossed (2) | a scope does not restrict who may see an asset; no endpoint assigns an asset to a scope |

The last group is the important one. Those two tests fail the moment somebody
implements enforcement, which is the point: **13B has to change them
deliberately, and cannot inherit an enforcement nobody wrote.**

---

## 9. Known gaps

### 9.1 A required slug can be stored empty — pre-existing, engine-wide

`crudValidate()` checks `required` **before** it normalises a slug. A code of
`"!!!"` passes the non-empty check, is then normalised to `""`, and is stored.
The row ends up with an empty machine identifier.

This is **not introduced by this phase** — it affects every config module with
a required slug, `campuses` included — and the brief instructed that unrelated defects be
diagnosed and documented rather than opportunistically fixed. It is not
theoretical: any name with no `[a-z0-9_-]` character does it, which at this
university includes a name typed in Gujarati or Hindi.

Damage is limited to one such row per table by the `UNIQUE` index. The
recommended fix is to re-check `required` after normalisation, in
`crudValidate()`, as its own change across all of them. The test
`"KNOWN GAP — accepts a code that slugs away to nothing"` pins the current
behaviour so that fix appears as a deliberate edit.

### 9.2 Nullable `scope_id` must fail closed later

`NULL` means **"not yet scoped"**. It must never be read as "belongs to
everyone". The phase that enforces scope has to treat a null scope as *no
access*, not *all access*, and to decide what happens to the existing unscoped
estate before it turns enforcement on. This is recorded at the migration site
as well as here.

### 9.3 Team Lead write access

§4. Acceptable while scope is inert; a decision for the enforcing phase.

### 9.4 Unrelated, pre-existing, untouched

- **`npm run lint` reports 1 error**: `scripts/seed-creator-demo.ts:142`,
  `'failures' is never reassigned. Use 'const' instead`. The file is unmodified
  by this phase (last touched by commit `a3f9b7d`) and is a development seed
  script. Diagnosed, not fixed.
- **`docs/TEST_STABILITY.md` §G.10**, the Creator Analytics "latest cycle"
  global-singleton flake, remains open and was not touched.
- **A second flake of the same class was observed during this phase's
  validation** and is recorded as `TEST_STABILITY.md` entry 11:
  `creator-analytics > approved content equals the submission table`
  reconciles two **global**, unscoped counts of `mo_creator_submissions` across
  two round-trips, while eleven Creator suites write to that table
  concurrently. One failure in eight runs. Diagnosed, not fixed — it is
  Creator-side and this phase was scoped to the inventory scope foundation.
  The Phase 13A test file references no creator table, so it cannot produce or
  remove a submission; adding a 45th file widens the timing window for a race
  that already existed, and that is the whole of the connection.

---

## 10. What this phase does *not* do

Restating, because a foundation is easy to mistake for a feature:

- It does **not** restrict who may see, borrow, book, check out or return any
  asset.
- It does **not** assign any asset to any scope. There is no endpoint that
  does, and a test asserts there is none.
- It does **not** know what a borrower is, or an eligibility rule, a request, an
  approval, an inspection or a loan.
- It does **not** add a Nerve role, module, authentication path or identity
  source.
- It does **not** make Media Ops an identity provider.
- It does **not** hardcode PID, 24 Frames, "student" or "faculty" anywhere.

---

## 11. Recommended next phase (13B)

**Scoped authorization**, and nothing else. In this order:

1. **Decide what a null scope means, and say it in one place.** Every gate will
   need the answer; deriving it twice is how two gates come to disagree.
2. **Decide what happens to the existing unscoped estate** before any
   enforcement is switched on. This is a product decision with a migration
   attached, not a code change.
3. **Attach custodians to scopes.** Phase 10 found `equipment_custodian` is a
   global duty flag with no object. A custodian *of a scope* is the smallest
   change that makes ownership mean anything.
4. **Add the scope predicate to the equipment read models**, and add the
   `(scope_id)` index with that query's measurement beside it (§6).
5. **Revisit `crudCan()` for this module** (§4) once scope decides access.
6. Only then: the borrower, eligibility and request work the Phase 10 and 12
   documents describe.

The two tests in "the line not crossed" are the tripwire for step 4. They are
supposed to fail then.

> **They did.** Phase 13B's first run failed
> `does not restrict who may see an asset`, which is the whole reason it was
> written that way. It has been rewritten to assert enforcement. The second —
> that no endpoint assigns an asset to a scope — still passes, unchanged: 13B
> decides who may reach a scoped asset, not how an asset comes to be scoped.
