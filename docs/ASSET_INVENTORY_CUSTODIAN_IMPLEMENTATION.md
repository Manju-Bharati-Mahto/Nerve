# Custodian Implementation (Phase 15)

**No legacy assets were assigned to an inventory scope in Phase 15.**

All 32 existing assets still have `scope_id IS NULL`. No scope was created in
production, no ownership was inferred from `department_id`, `campus_id` or an
asset-tag prefix, and neither PID nor 24 Frames exists anywhere in the data.
Phase 14 established that no mapping is derivable; this phase did not invent
one.

What it did build is the thing that makes a mapping *safe to make later*: a
durable, revocable, auditable record of who is responsible for which
inventory.

---

## 1. What a custodian is

Not a role. Not a table. Not an entity. **The intersection of two things that
already existed:**

```
equipment_custodian duty     →  may act on equipment AT ALL      (capability)
active scope assignment      →  ON WHICH INVENTORY               (jurisdiction)
```

Neither half is custodianship:

| Holds | Can | Cannot |
|---|---|---|
| duty only | reach the ungoverned estate, and act on it | see or touch a scoped asset |
| assignment only | **see** that inventory | act on anything in it — a *scoped viewer* |
| both | see and act, within that scope | reach any other scope |
| `isMoAdmin` | everything | — |

Both negative cases are asserted, because a layered model that quietly
collapses into "one check passed" is the failure this design exists to
prevent.

### Authorization was not re-implemented

`canCustody()` does not exist, and deliberately. The gate on an asset is
already the composition Phase 13B shipped:

```
requireEquipment(res)        module access        (existing)
canManageEquipment(u)        duty OR isMoAdmin    (existing)
assetScopeOk(scope, id)      jurisdiction         (Phase 13B)
```

Phase 15 adds **one clause** to that chain — `removed_at IS NULL` — and no
second decision point. Introducing a parallel `isCustodian()` would have meant
two places that answer the same question, which is how they come to disagree.

---

## 2. Schema changes

### `mo_user_inventory_scopes` — the provisional table becomes a ledger

Phase 13B created it with `PRIMARY KEY (user_id, scope_id)`, which permits one
row per pair and therefore **cannot remember that somebody was a custodian and
no longer is.** Accountability needs exactly that: a loan outlives a
custodian's tenure, and an inspection in March must be attributable to whoever
held the scope in March.

```sql
ALTER TABLE mo_user_inventory_scopes ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'custodian';
ALTER TABLE mo_user_inventory_scopes ADD CONSTRAINT mo_user_inventory_scopes_role_check
  CHECK (role IN ('custodian'));
ALTER TABLE mo_user_inventory_scopes ADD COLUMN IF NOT EXISTS removed_by TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE mo_user_inventory_scopes ADD COLUMN IF NOT EXISTS removed_at TIMESTAMPTZ;
ALTER TABLE mo_user_inventory_scopes ADD COLUMN IF NOT EXISTS id BIGINT GENERATED ALWAYS AS IDENTITY;
-- primary key moves off the pair, once, guarded by an inspection of pg_index
CREATE UNIQUE INDEX idx_mo_uis_active      ON mo_user_inventory_scopes(user_id, scope_id) WHERE removed_at IS NULL;
CREATE INDEX        idx_mo_uis_scope_active ON mo_user_inventory_scopes(scope_id)          WHERE removed_at IS NULL;
```

The shape is **`mo_project_assignments`'**, this codebase's existing answer to
the same problem — surrogate key, nullable `removed_at`, partial unique index:

```sql
mo_project_assignments (id … assigned_by, assigned_at, removed_at TIMESTAMPTZ)
CREATE UNIQUE INDEX idx_mo_assign_unique ON mo_project_assignments(project_id, user_id) WHERE removed_at IS NULL;
```

It is explicitly **not** `mo_user_duties`', which hard-deletes on revoke. A
hard delete is acceptable for a capability flag and is not acceptable for
accountability.

**`role`** exists so a later phase can distinguish kinds of responsibility
without a migration. It has exactly one legal value today and the CHECK says
so — a column that accepts anything is how an undesigned role taxonomy gets
into the data. There is no `primary_custodian`, `backup_custodian`,
`inventory_manager`, `assistant_custodian` or `temporary_custodian`: the table
is many-to-many, so cover, leave and handover are *a second assignment*, not a
second kind of assignment.

### `mo_audit_logs` — a text entity reference

```sql
ALTER TABLE mo_audit_logs ADD COLUMN IF NOT EXISTS entity_uid TEXT;
```

See §5. `entity_id` is `BIGINT`; `users.id` is `TEXT`.

### Indexes — why these two and no others

| Index | Evidence |
|---|---|
| `idx_mo_uis_active` UNIQUE `(user_id, scope_id) WHERE removed_at IS NULL` | enforces one live assignment per pair; **also the concurrency authority** (§8). Its leading column serves `inventoryScopeOf()`, which filters by `user_id`. |
| `idx_mo_uis_scope_active` `(scope_id) WHERE removed_at IS NULL` | "who are this scope's custodians" runs on every scope view and filters `scope_id`; the unique index leads with `user_id` and cannot serve it. |

No separate `user_id` index: it is the leading column of the unique index
already. Nothing speculative was added.

### Migration safety

- **Additive** — every statement is `ADD COLUMN IF NOT EXISTS`, `CREATE … IF NOT
  EXISTS`, or a guarded one-time primary-key move.
- **Idempotent** — verified by bootstrapping twice in a row and comparing the
  resulting columns, primary key and indexes.
- **The PK move is inspected, not blindly re-applied.** A
  `DROP CONSTRAINT`/`ADD CONSTRAINT` pair on every boot would rewrite a
  constraint that authorization reads on every request, and §G.9 exists because
  that pattern already bit this codebase once. The code reads `pg_index` and
  acts only if `user_id` is still part of the primary key.
- `scope_id` is **not** made `NOT NULL`. No asset ownership changed. No
  transaction history was rewritten. No assignment was hard-deleted.
- **Proven against a real database**: a pre-existing `tsx watch` dev server
  restarted on the migration and applied it to the development database, which
  holds 32 real assets. All 32 remained `scope_id IS NULL`; 0 scopes and 0
  assignments were created.

---

## 3. Authorization model

### `inventoryScopeOf()` — one clause added

```sql
WHERE us.user_id = $1
  AND us.removed_at IS NULL          -- ← Phase 15
  AND s.is_active AND s.archived_at IS NULL
```

Unchanged otherwise, and still **re-read on every request and never cached**,
which is what makes revocation take effect on the next call rather than the
next login. The result shape is untouched:

| Caller | Resolves to |
|---|---|
| `isMoAdmin` | `{ level: "all" }` |
| ≥1 live assignment to an active, unarchived scope | `{ level: "scoped", scopeIds: [...] }` |
| anyone else past the module gate | `{ level: "none" }` |

### Admin behaviour

Unchanged, and derived from `isMoAdmin()` — the existing role check that
already governs `POST /crew/:id/duties`. **No global role was created**, and no
person's identity appears anywhere in the code. An Admin holds **no** scope
assignment; a test asserts that, so admin access can never come to depend on
one.

### Revoked behaviour

| Revoked | Effect |
|---|---|
| the **assignment** | loses sight of that scope's assets on the next request; the row survives and stays queryable |
| the **duty** | keeps sight of the scope, loses the ability to act — degrades to a scoped viewer |
| the **scope** (deactivated or archived) | withdraws every custodian at once |

---

## 4. API

Three endpoints. Reuse first: inventory scopes themselves already have full
CRUD through the generic engine (`/crud/inventory_scopes`), so only the
assignment sub-resource was added — under the module's own namespace, in the
shape `POST /crew/:id/duties` already established.

```
GET    /api/v1/media/equipment/scopes/:scopeId/custodians
POST   /api/v1/media/equipment/scopes/:scopeId/custodians          { user_id }
DELETE /api/v1/media/equipment/scopes/:scopeId/custodians/:userId
```

**All three are Admin-only** (`isMoAdmin`). Appointing a custodian is a
governance act, so holding the custodian duty must not let you appoint another
custodian — or yourself.

`GET` returns, from **one** query: `scope`, `active[]`, `history[]`,
`active_count` and `no_custodian`. Each row carries the assignee's name, the
grant and removal dates, who granted and who removed, and `has_duty` —
computed in the same statement by an `EXISTS` over `mo_user_duties`, so there
is no query per custodian.

### Validation, and what is refused

| Condition | Answer |
|---|---|
| unknown scope, unknown user | 404 |
| inactive account | 409 |
| **archived scope** | 409 — `inventoryScopeOf()` filters archived scopes, so the assignment could not take effect. Refusing a provably inert write is not a product rule. |
| **self-appointment** | 403 |
| duplicate live assignment | 409, raised by `idx_mo_uis_active` |
| missing/blank `user_id` | 400 |
| appointee lacks the duty | **201 with a `warning`** — reported, not refused (§7) |

### Re-appointment after removal

A **new row** is inserted. `removed_at` is never silently cleared, and the
historical row keeps its own `granted_at`, `removed_at` and `removed_by`. A
test asserts two distinct `id`s survive a remove-then-re-add cycle — the
revival shortcut would have left one.

### DB pool safety

**No `pool.connect()` anywhere in these endpoints.** Every write is a single
statement whose uniqueness the database guarantees, so no pooled client is held
across an `audit()` call — the shape that deadlocked production once already
(`docs/DB_POOL_CONCURRENCY_AUDIT.md` F1, fixed by releasing before auditing).
No transaction was needed, so none was opened.

---

## 5. Audit

Existing `audit()` helper, existing `mo_audit_logs`. No second audit system and
no new table.

```
inventory_scope.custodian_assigned   entity_type='inventory_scopes'  entity_id=<scope>  entity_uid=<user>
inventory_scope.custodian_removed    entity_type='inventory_scopes'  entity_id=<scope>  entity_uid=<user>
```

`entity_type` is the **CRUD module key** on purpose: the scope's existing Audit
History tab already reads `(entity_type, entity_id)`, so custodian changes
appear there with no new query and no new screen.

### The duty `entity_id` gap — root cause and fix

The gap was **not** an oversight in the duty endpoint. `mo_audit_logs.entity_id`
is `BIGINT` and `users.id` is `TEXT`, so *every* audit event about a person has
always written `entity_id = NULL` — `user.duty_granted`, `user.duty_revoked`,
`user.avatar_updated`, `user.password_changed`. The affected person existed only
inside the JSONB payload, so "what was done to this person" could not be
queried.

Widening `entity_id` to `TEXT` would touch every reader and every numeric
entity in the table. Instead, `audit()` gained an **optional trailing**
`entityUid` parameter writing to a new nullable `entity_uid` column:

- **No event was renamed** and `entity_type` keeps its vocabulary (`'user'`
  stays `'user'`).
- All ~200 existing call sites are unchanged and keep writing `NULL`.
- Every existing reader names its columns explicitly — there is no
  `SELECT * FROM mo_audit_logs` in the codebase — so nothing sees the column
  unless it asks.

`"every duty change for this person"` is now this, and a test asserts it:

```sql
SELECT * FROM mo_audit_logs
 WHERE entity_type='user' AND entity_uid=$1 AND action LIKE 'user.duty_%';
```

No index was added for it yet: no feature queries it, and this series does not
add speculative indexes.

---

## 6. Assignment lifecycle

| State | Representation |
|---|---|
| active | `removed_at IS NULL` |
| revoked | `removed_at IS NOT NULL`, with `removed_by` |

`expired` was **not** built. Nothing describes fixed-term custodianship; a term
that ends on a date is a rotation feature, and the column would mean writing an
expiry check nothing sets. Additive later.

Four provenance facts are recorded — `granted_by`, `granted_at`, `removed_by`,
`removed_at` — the same four `mo_project_assignments` keeps.

---

## 7. Last-custodian behaviour

**Removing the final custodian is allowed.** Blocking it would make offboarding
impossible; appointing a replacement automatically would invent an
accountability nobody agreed to. Neither happens.

- `GET` reports `active_count` and `no_custodian`, so the UI can warn *before*
  the removal.
- `DELETE` returns `remaining_active` and `no_custodian`, so the UI can say
  what happened.
- The UI warns: *"Removing this custodian will leave this inventory scope
  without an assigned custodian."* The Admin may continue; cancelling sends
  nothing.

**`NO_CUSTODIAN` is derived, never stored.** It is `COUNT(*) = 0` over live
assignments. No `custodian_status` or `has_custodian` column was added, and a
test asserts neither exists.

---

## 8. Concurrency

The database is the authority, not the browser.

| Race | Outcome |
|---|---|
| two Admins appoint the same person to the same scope | `idx_mo_uis_active` admits one; the loser gets 409. **One** live assignment. |
| two Admins revoke the same person | `UPDATE … WHERE removed_at IS NULL` matches once; the loser gets 404 and the original `removed_by`/`removed_at` are not overwritten |
| revoke racing a re-appointment | never more than one live assignment |

All three are tested with real concurrent requests.

---

## 9. UI

Inside the **existing** config View drawer, as a `Custodians` tab beside
General / Configuration / Dependencies / Audit History. A scope *is* a config
record, and that drawer already had tabs.

**No new portal, no new router, no separate custodian application, no new
screen.** One tab, rendered by `scopeCustodiansBody()`.

An Admin can view live custodians (with appointment date, who appointed them,
and whether they hold the duty), view the full assignment history (with removal
date and who removed them), appoint, and remove.

- **`NO CUSTODIAN`** is stated explicitly rather than shown as an empty table —
  an empty table reads as "failed to load".
- An assignee without the duty is labelled **`viewer only`**, so the two halves
  of custodianship are visible rather than implied.
- Controls are gated on the **per-module `can`** the server computes for that
  caller (`GET /crud/meta` now reports it per module), so a non-Admin is not
  shown buttons the API would refuse. **This is presentation, not
  authorization** — the endpoints check `isMoAdmin` themselves.

### Legacy assets in the UI

Deliberately **not** labelled. Phase 13B keeps `scope_id` out of the equipment
read models, and a "Legacy / Ungoverned" badge on an asset row would require
putting it back. §12 permits such a label rather than requiring one, so the
contract was kept and a test asserts the catalog renderer still never reads
`scope_id`. The governed count per scope is already visible on the scope's
Dependencies tab. Surfacing it per asset is a UI decision for whoever needs it.

### `/state`

Untouched. No custodian or scope collection was added to the boot payload; a
test asserts `inventory_scopes`, `user_inventory_scopes` and `custodians` are
all absent from it. Custodians load from their own feature endpoint, one
request per scope view.

---

## 10. CRUD authorization

`crudCan()` was global to the engine: `create`/`update`/`state` for
**admin or team_lead** across all 21 config modules. So a Team Lead could
create, rename and *deactivate* an inventory scope — and deactivating one
withdraws every custodian's access to it.

`CrudModule` gained an optional per-module override, idiomatic because the type
already carries `activeCol?`:

```ts
manage?: "admin";     // set on inventory_scopes only
```

- Writes on a `manage:"admin"` module require `isMoAdmin()` — the same bar as
  appointing a custodian.
- **`read` is unaffected**: the scope list is a lookup that pickers and filters
  need. It is not the boundary.
- **The other twenty modules are untouched.** A regression test asserts a Team
  Lead can still create, edit and disable a campus, and still cannot archive
  one.
- Error precedence is preserved: the permission check still runs before module
  resolution, so an unknown module with no permission still answers 403.
- `GET /crud/meta` now reports each module's `can` and `manage` for the caller.

---

## 11. Security model

| Threat | Defence | Tested |
|---|---|---|
| unauthorized assignment | all three endpoints `isMoAdmin` | ✅ |
| custodian appoints themselves | `userId === u.id` → 403 | ✅ |
| custodian appoints/revokes another | Admin-only | ✅ |
| forged `scope_id` | never read for authorization; a body scope is a filter only | ✅ (13B) |
| forged `user_id` | must resolve to a live `users` row; the actor is always `res.locals.currentUser` | ✅ |
| assigning an inactive user | `status='active'` required | ✅ |
| assigning a user without module access | permitted but inert — `requireEquipment` runs first | ✅ (13B) |
| assignment without the duty | grants sight, never action | ✅ |
| duty without assignment | reaches only the ungoverned estate | ✅ |
| revoked assignment still granting access | `removed_at IS NULL` in the resolver, re-read per request | ✅ |
| revoked duty still granting action | `canManageEquipment` re-read per request | ✅ |
| cross-scope access | 13B, 404 not 403 | ✅ |
| removing the last custodian | allowed, warned, never auto-replaced | ✅ |
| existence disclosure | unknown scope and unknown user both 404, using existing conventions | ✅ |

---

## 12. Tests

| Suite | Tests |
|---|---|
| `server/mediaops-custodian.integration.test.ts` | **48** — migration shape, PK, partial unique index, role CHECK, appointment, validation, soft revoke, history, re-appointment, last custodian, authorization (all eight §13 cases), CRUD governance + regression, audit including both duty-gap fixes, concurrency ×3, legacy estate |
| `src/test/custodian-ui.test.ts` | **20** — tab presence and absence, feature-endpoint loading, active/history rendering, `NO CUSTODIAN`, `viewer only`, admin gating both ways, picker exclusion, last-custodian warning, cancel-sends-nothing, assign flow, legacy non-labelling, `/state` |

Both suites were **mutation-tested**: removing `removed_at IS NULL` fails a
test; removing `manage:"admin"` fails two; forcing the UI gate open fails one;
removing the last-custodian warning fails one.

### A Phase 13B tripwire fired, as intended

Phase 13B shipped `lets a team lead create and edit, but not archive or delete`
with a comment asking the phase that made scope decide access to revisit it.
Phase 15 did exactly that, so the test failed on the first full run and has
been **deliberately rewritten** to assert the new admin-only rule — including
that a Team Lead may still *read* the scope list, and that none of their
refused writes took effect.

### Two pre-existing flakes were fixed in passing

Adding a third suite that creates inventory scopes exposed two assertions
written when only one did: a bare `COUNT(*)` over `mo_inventory_scopes` in the
Phase 13A suite, and one over scoped assets in this phase's own first draft.
Both now count **by actor** rather than by total. Recorded as
`docs/TEST_STABILITY.md` entry 14, which is the fourth sighting of that
pattern and states the rule.

---

## 13. Deliberately not implemented

Every one of these was left exactly as it was, with its seam intact: PID and
24 Frames representation, student / faculty / non-account borrower identity,
borrower eligibility, request and approval workflow, self-approval policy,
own-inventory borrowing policy, pooled-asset scope, retired-asset scope policy,
RFID, **asset transfer**, and historical scope snapshots.

No transfer endpoint, UI, workflow, approval or snapshot column was added.
Scope is still derived for history, which Phase 14 §K established is the same
decision as transfer — and transfer does not exist.

---

## 14. Unresolved product decisions

Carried forward from Phase 14, none answered here:

| # | Decision |
|---|---|
| P-1 | Which inventories exist, and who owns each |
| P-2 | How many custodians per inventory; is a primary marked |
| P-4 | Self-approval — may a custodian approve their own request |
| P-5 | Borrowing from your own inventory |
| P-6 | Scope transfer — Admin only, or custodian-of-both |
| P-7 | The per-asset legacy mapping |
| P-8 | Historical scope snapshots (same decision as P-6) |
| P-9 | Pooled assets — can one pool span scopes |
| P-10 | Retired assets — do they need a scope at closure |

**P-3 (backup custodians) is resolved**: not a type. The assignment is
many-to-many, so cover is a second assignment.

---

## 15. Next phase

1. **Decide P-1** and create the real scopes through the existing admin screen.
2. **Fill the Phase 14 §I worksheet** — the per-asset mapping is a human
   decision, not a query.
3. **Assign assets in batches**, reversible per asset with
   `UPDATE … SET scope_id = NULL`, then appoint custodians (§O step 4: assets
   before custodians, so a custodian can verify what they received).
4. Add the `(scope_id)` index with a measurement over a genuinely scoped estate.
5. Only then: transfer, borrower, eligibility, request and approval.
