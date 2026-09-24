# Custodian Model & Legacy Scope Migration — Design (Phase 14)

**Design and audit only. No production behaviour changed; no schema added; no
scope populated; no asset assigned.**

Phase 13B left inventory-scope authorization real but **dormant**: it is fully
enforced in code and proven by tests, and it governs nothing, because no asset
carries a `scope_id`. This phase designs the two things that would wake it up —
who a custodian actually *is*, and how the legacy estate becomes governed
without a flag day.

The single most consequential finding is in §I: **there is no derivable mapping
from the existing data to inventory scopes.** Every asset sits in one
department, on one campus, with no location column and no ownership field. Scope
assignment cannot be inferred. It has to be decided by people, and the migration
plan in §O is built around that fact rather than around a clever query.

---

## A. The existing duty system, as it actually is

### Structure

```sql
mo_duty_flags   (id, code UNIQUE, name, description  + CRUD lifecycle columns)
mo_user_duties  (user_id, duty_flag_id, granted_by, granted_at DATE,
                 PRIMARY KEY (user_id, duty_flag_id))
```

### How it behaves

| Question | Answer, from the code |
|---|---|
| **Granted** | `POST /crew/:id/duties` with `{duty_flag_id, grant:true}` — `INSERT … ON CONFLICT DO NOTHING` |
| **Revoked** | the same endpoint with `grant:false` — **hard `DELETE`** |
| **Who may** | `isMoAdmin(u)` only. Not a Team Lead. |
| **Audited** | `user.duty_granted` / `user.duty_revoked`, `entity_type='user'`, **`entity_id = NULL`**, payload `{member, duty}` |
| **Displayed** | `/state` ships `duty_flags` and `user_duties`; the client derives `hasDuty(code)`; chips render on a member card; administered under **Team → Teams & duties** |
| **Administered** | `duty_flags` is a CRUD-engine module, with `deps` on `mo_user_duties` so a duty in use cannot be deleted |
| **Checked** | five call sites, all identical: `SELECT 1 FROM mo_user_duties d JOIN mo_duty_flags f ON f.id=d.duty_flag_id WHERE d.user_id=$1 AND f.code='…'` |

### Three findings that matter

1. **`equipment_custodian` is held by nobody.** Measured on the development
   database: of six duty codes, only `casting_manager` has a holder (one). So
   `canManageEquipment()` — `isMoAdmin(u) OR holds equipment_custodian` — is in
   practice **admin-only today**. The duty is designed, wired, audited, and
   never used. Any custodian model is therefore greenfield in operational
   terms, whatever the schema says.

2. **Revocation destroys the record.** There is no `revoked_at`. After a revoke,
   the database cannot answer *"who was the equipment custodian in March?"* —
   which is precisely the question an inspection dispute or a loss enquiry asks.

3. **The audit trail is not queryable per user.** `entity_id` is `NULL` on both
   duty events, so `WHERE entity_type='user' AND entity_id=$1` returns nothing.
   The member id is only inside the JSON payload.

### How a scoped custodian should relate to the duty

**Keep both, ANDed. Do not fold scope into the duty.** They answer different
questions, and Phase 13B already ships the separation:

```
equipment_custodian (duty)   → may you act on equipment AT ALL   (capability)
scope assignment             → ON WHICH INVENTORY                (jurisdiction)
```

A duty with no scope is today's behaviour: act on the estate at large. A scope
with no duty is a **scoped viewer** — may see that inventory, may not act on it.
Phase 13B has a passing test for exactly this (`scope does not replace the
custodian duty`), so the boundary is already load-bearing rather than
aspirational.

`mo_user_duties` is **not modified** by this design. Its primary key
`(user_id, duty_flag_id)` permits one row per duty per user and therefore cannot
carry a scope, which is the structural reason a separate table exists at all.

---

## B. Assessment of `mo_user_inventory_scopes`

Phase 13B created it as an explicitly provisional attachment point:

```sql
mo_user_inventory_scopes (user_id, scope_id, granted_by, granted_at,
                          PRIMARY KEY (user_id, scope_id))
```

**Verdict: keep it, keep it separate from duties, and extend it.** It is the
right shape — a domain assignment joining a person to an inventory — and the
alternatives are worse:

| Option | Rejected because |
|---|---|
| Fold into `mo_user_duties` | PK `(user_id, duty_flag_id)` allows one row per duty; a custodian of two scopes is unrepresentable without changing a table five call sites depend on |
| Link each assignment *to* a duty row | couples two lifecycles: revoking the global duty would silently revoke every scope assignment, and the FK would have to cascade in a direction nobody wants |
| Replace with a column on `mo_user_profiles` | one scope per person only; and profiles are not an assignment ledger |
| Derive from `department_id` / `campus_id` | §I proves there is no signal there — and Phase 13B's brief forbade it explicitly |

### The minimum final model

Two additions, each earned:

```sql
mo_user_inventory_scopes (
  user_id     TEXT   NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope_id    BIGINT NOT NULL REFERENCES mo_inventory_scopes(id) ON DELETE CASCADE,
  role        TEXT   NOT NULL DEFAULT 'custodian',   -- NEW, see §C
  granted_by  TEXT   REFERENCES users(id) ON DELETE SET NULL,
  granted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  removed_by  TEXT   REFERENCES users(id) ON DELETE SET NULL,  -- NEW
  removed_at  TIMESTAMPTZ,                                     -- NEW, soft revoke
  PRIMARY KEY (user_id, scope_id)
)
```

`removed_at` follows **`mo_project_assignments`**, not `mo_user_duties`:

```sql
mo_project_assignments (…, assigned_by, assigned_at, removed_at TIMESTAMPTZ)
-- with partial indexes WHERE removed_at IS NULL
```

That is the house pattern for *"this person was responsible, and then wasn't"*,
and it is the fix for finding A-2. A hard delete is acceptable for a capability
flag; it is not acceptable for accountability, because a loan can outlive a
custodian's tenure and an inspection in March must be attributable to whoever
held the scope in March.

**Consequence for `inventoryScopeOf()`** — one clause, and it is the *only*
change this design implies for Phase 13B's code:

```sql
WHERE us.user_id = $1
  AND us.removed_at IS NULL          -- ← added
  AND s.is_active AND s.archived_at IS NULL
```

The existing revocation test (`removing the assignment removes access on the
very next request`) would be extended to cover soft revoke rather than replaced.

---

## C. Custodian types — what the evidence supports

**Two concepts, not four.** And they are already separable with what exists:

| Concept | Who | Mechanism |
|---|---|---|
| **Administers inventory** — creates scopes, renames them, appoints custodians | Media Ops Admin | `isMoAdmin()`, existing. §H tightens the CRUD gate to match. |
| **Responsible for physical custody** — of one inventory | scope assignee holding the duty | `mo_user_inventory_scopes` + `equipment_custodian` |

### What is *not* created, and why

- **"Inventory Manager" as a distinct type** — no operational requirement has
  appeared. The administrative half is already the Admin, and inventing a tier
  between Admin and custodian would be role taxonomy without a job to do. The
  `role` column is added so the *distinction can be made later without a
  migration*, defaulting to `'custodian'` — but only one value is used.
- **"Backup custodian" as a type** — unnecessary. The assignment is
  many-to-many (§D), so cover, leave and handover are expressed by *a second
  assignment*, not by a second kind of assignment. If "primary" ever needs
  marking, `mo_creator_team_members.is_primary` is the precedent — and that is
  a column, not a role.
- **"Administrator" as a scope-level role** — that is the Admin, globally.
  Creating a per-scope administrator would create a second RBAC.

Given A-1 (zero custodians exist anywhere), inventing a four-tier taxonomy now
would be designing for an organisation nobody has described yet.

---

## D. Multiple assignments — both directions

**One user → many scopes: yes. One scope → many users: yes.** Already true, and
already tested.

- The composite primary key `(user_id, scope_id)` permits both.
- `inventoryScopeOf()` already returns `{ level:"scoped", scopeIds: number[] }`
  — an array, deliberately, and Phase 13B has a passing test
  (`holding two scopes reaches both`).
- `inventoryScopeSql()` already emits `= ANY($n::bigint[])`, so the SQL side
  needs nothing.

This is not a hypothetical: the university may well run PID and 24 Frames with
one person over both at the start, and "many custodians per scope" is what makes
leave and handover possible at all.

**No change to Phase 13B's resolver shape is required by this section.**

---

## E. Assignment lifecycle

| State | Representation | Required? |
|---|---|---|
| **active** | `removed_at IS NULL` | yes |
| **revoked** | `removed_at IS NOT NULL` | yes — §B, finding A-2 |
| **expired** | a `valid_until` date | **no** — speculative |

`expired` is deliberately omitted. Nothing in the audits describes fixed-term
custodianship; a term that ends on a date is a different product feature
(rotation), and adding the column now would mean writing an expiry check that
nothing sets. It is additive later.

**Provenance fields: all four.** `granted_by` and `granted_at` exist already;
`removed_by` and `removed_at` are added. Together they make the assignment
ledger answer "who made this person responsible, when, and who ended it" — the
same four facts `mo_project_assignments` records, which is the existing standard
for accountability in this codebase.

**Audit events** (existing `audit()`, no second system, and unlike the duty
endpoint these carry a usable `entity_id`):

```
inventory_scope.custodian_assigned   entity_type='inventory_scope'  entity_id=<scope_id>
inventory_scope.custodian_removed    entity_type='inventory_scope'  entity_id=<scope_id>
```

Recording against the **scope** rather than the user is deliberate: the CRUD
engine's detail view already renders `mo_audit_logs` filtered by
`entity_type = <module key> AND entity_id = <row id>`, so a scope's own page
would show its custodian history for free — and it fixes finding A-3 for the
new events without touching the old ones.

---

## F. Self-approval — keeping both answers reachable

Phase 12 left this open. This design does **not** resolve it, and is built so
that either rule is a later one-line policy rather than a remodelling.

**The architectural rule: `inventoryScopeOf()` must never learn about approval.**
It answers exactly one question — *which inventories may this person reach* —
and any approval rule is a separate predicate over `(actor, request, scope)`.

```
inventoryScopeOf(u)          →  jurisdiction     (Phase 13B, done)
canManageEquipment(u)        →  capability       (exists)
approvalPolicyFor(scope)     →  policy           (NOT BUILT — the seam)
```

Because the request/approval workflow does not exist, the only thing this phase
does is **refuse to foreclose it**:

- The approval decision belongs on the (future) request record — `approved_by`,
  `approved_at` — not on the assignment, so "may X approve their own request"
  is evaluated where both facts are present.
- If self-approval is later **prohibited**, the check is
  `request.requested_by <> request.approved_by`, plus "is the approver a
  custodian of the asset's scope". Both facts are available from the model above.
- If later **permitted**, the check is simply omitted. Nothing is unwound.
- Per-scope variation (PID strict, 24 Frames relaxed) is expressible as a column
  on `mo_inventory_scopes` **if and only if** that requirement appears. It is
  not added now.

---

## G. Borrowing from your own inventory

Identical treatment, identical seam, and deliberately unresolved.

The question — *may a custodian check out an asset from the inventory they are
responsible for?* — is **not a scope-resolution question**. Scope already says
yes: a custodian can reach their own inventory, which is the whole point.

It will be enforced at **checkout / request approval**, where both the actor and
the asset's scope are known:

```
POST /equipment/:id/checkout   → asset scope known, actor known  ← rule lands here
```

Recorded so the eventual rule has one home rather than three. Note that
prohibiting it outright would make a one-custodian inventory unusable by its own
custodian, which is why this is a product decision (§P) and not a default.

---

## H. CRUD authorization for `inventory_scopes`

### Current state

`crudCan(u)` is **global to the engine** — one permission set for all 21 config
modules:

```ts
{ read: true,
  create: admin || team_lead,  update: admin || team_lead,  state: admin || team_lead,
  archive: admin,              delete: admin }
```

So **a Team Lead can today create, rename and deactivate an inventory scope.**
Phase 13A flagged this as acceptable for a lookup table; Phase 13B made scope an
authorization boundary, which changes the answer. Editing the scope list is now
editing a security boundary — renaming is harmless, but *deactivating* a scope
withdraws every custodian's access to it (Phase 13B test: `deactivating the
scope withdraws it too`).

### Recommendation — a per-module override, not a global change

`CrudModule` already carries an optional per-module override (`activeCol?`), so
extending it is idiomatic rather than novel:

```ts
type CrudModule = {
  …
  activeCol?: string;
  manage?: "admin";        // NEW — when set, create/update/state/archive/delete require isMoAdmin
};

inventory_scopes: { …, manage: "admin" }
```

- **Default unchanged**, so the other twenty modules keep their behaviour and no
  existing test moves.
- `read` stays open to the module's users — the scope *list* is a lookup that
  pickers and filters need; it is not the boundary.
- **No global Nerve role is created.** This reuses `isMoAdmin()`, the same check
  that already governs `POST /crew/:id/duties`. That symmetry is the argument:
  appointing an equipment custodian is already admin-only, so creating the
  inventory they are custodian *of* should not be a lower bar.

### Custodian assignment authorization

When an assignment API is eventually built (**not this phase**): **Admin only**,
matching `POST /crew/:id/duties` exactly. A custodian must not be able to
appoint another custodian to their own scope, and must not be able to appoint
themselves (§M).

---

## I. The legacy estate

Measured **read-only** against the development database (`nerve`) on
2026-09-22. This is dev/demo data, **not production** — the production figures
must be re-measured with the same queries before §O step 1. The *shape* of the
finding, however, is structural and will not change: it is about which columns
exist, not how many rows they hold.

### What is there

| | |
|---|---|
| Assets total / live / operational / retired | 32 / 32 / 32 / 0 |
| Currently checked out | **10**, held by 5 people |
| Scopes | **0** |
| Assets with `scope_id` | **0** |
| Categories in use | 11 (Camera Body 7, Lens 6, Light 4, Tripod 3, Microphone 3, Drone 2, Gimbal 2, Audio Recorder 2, Battery 1, Memory Card 1, Accessory 1) |
| Departments | **1** — "Media Crew", holding all 32 |
| Campuses | **1** — "Vadodara — Main Campus", holding all 32 |
| Holders of `equipment_custodian` | **0** |
| Location column | **none exists** |

### The finding that shapes the migration

**No column in `mo_equipment_items` carries an ownership signal.**

- `department_id` → one value for the whole estate. No discrimination.
- `campus_id` → one value for the whole estate. No discrimination.
- `asset_tag` prefix → `EQ-CAM-*`, `EQ-LEN-*` … these are **category**
  abbreviations generated at registration, not owners.
- **Location is not modelled at all** — there is no `location`, `room`, `store`
  or `shelf` column, so "which cupboard is it in" has never been recorded. The
  brief asked for current locations; the honest answer is that the system does
  not know.
- `vendor_id`, `purchase_date`, `notes` → provenance, not ownership.

**Therefore: no mapping proposal can be derived from data, and none is offered.**
Any `department_id → scope` or `campus_id → scope` rule would be inventing a
distinction the database does not contain — and would silently put the entire
estate in one scope, which is indistinguishable from doing nothing while looking
like progress.

### The migration mapping proposal, stated honestly

The mapping is **a human decision captured as a reviewed list**, not a query:

1. Produce the worksheet: one row per operational asset with
   `asset_tag, category, make, model, serial_no, current_holder, status` and an
   empty `proposed_scope` column.
2. The people who actually run the cupboards fill in `proposed_scope`.
3. The filled worksheet is validated (§O step 2) before a single `UPDATE` runs.

`pool_quantity` exists, so pooled (`tracking_mode='pooled'`) categories must be
decided as units, not per item — flagged in §P.

---

## J. Migration states

Two states, and **no intermediate one**.

| State | Predicate | Meaning |
|---|---|---|
| **LEGACY** | `scope_id IS NULL` | predates the model; ungoverned; reachable by anyone who passes the module gate |
| **GOVERNED** | `scope_id = X` | reachable only via scope authority |

An intermediate "pending" state was considered and **rejected**: a third value
would need its own authorization semantics in every one of the nineteen enforced
paths, to express something a worksheet column already expresses *outside* the
database. Migration progress is a report, not a schema state:

```sql
SELECT count(*) FILTER (WHERE scope_id IS NULL)     AS legacy,
       count(*) FILTER (WHERE scope_id IS NOT NULL) AS governed
  FROM mo_equipment_items
 WHERE deleted_at IS NULL AND retired_at IS NULL;
```

### Closure condition (defined, deliberately not implemented)

> Every **operational** asset — `deleted_at IS NULL AND retired_at IS NULL` —
> has a non-null `scope_id`, and has had one for a full business cycle with no
> access incidents.

Retired and soft-deleted assets are **excluded**: they are history, they are
already excluded from the registry by default, and forcing a scope onto a
retired asset would mean inventing an owner for something nobody owns any more.
This is why `NOT NULL` (§O step 9) must be a partial constraint or preceded by a
decision about history — flagged in §P.

---

## K. Historical records — derive or snapshot

### What Phase 13B already does

**It derives.** The four history read models (`transactions`, `maintenance`,
`bookings`, `custody`) are scoped by joining the item and filtering
`i.scope_id` — the asset's scope **now**, not at the time of the event.

That is a deliberate consequence worth stating plainly: **if an asset is ever
transferred between scopes, its entire history moves with it.** March's
transactions would appear under the new scope and vanish from the old one.

### The decision

| | Correct when | Cost |
|---|---|---|
| **Derive** (today) | transfers never happen, or are rare and retrospective movement is acceptable | free; already shipped |
| **Snapshot** — `scope_id` copied onto the transaction/booking/maintenance row at write time | always | one column × three tables, denormalised, and every write path must set it |

**Recommendation: keep deriving, and do not add snapshot columns until transfer
(§L) is actually implemented.** The two decisions are the same decision. Adding
three columns now would mean writing a value nothing reads, and the moment
transfer ships, the snapshot must be backfilled anyway — at which point the
correct value for existing rows is knowable (there have been no transfers yet,
so it is exactly the current scope).

**Do not alter history for reporting convenience.** If a report needs
"transactions by scope as it was", that is the snapshot decision, taken on its
merits.

---

## L. Asset transfer between scopes (design only)

Phase 12's constraint holds: **one asset belongs to at most one scope at a
time**, because custody derives from the latest transaction and the booking
`EXCLUDE` constraint is per item — two scopes over one asset gives one
reservation calendar with no arbiter.

```
Scope A ──[ transfer ]──> Scope B
```

### Preconditions — all must hold

| Check | Why |
|---|---|
| asset is **not checked out** | custody and accountability would split mid-loan. **Not hypothetical: 10 of 32 dev assets are on loan right now.** |
| asset has **no active or reserved future booking** | the booking was made against the old scope's calendar and its holder may lose access on transfer |
| asset is not **retired** | nothing to transfer |
| target scope is **active and not archived** | transferring into a deactivated scope would strand the asset where nobody has authority |

Refusal should reuse the existing conflict vocabulary — **409**, the same status
`AC-7` uses for a booking clash — not 404, because the caller legitimately knows
this asset exists.

### Authorization

The safe default is **Admin only**, matching §H. The alternative — "custodian of
the source *and* target" — is attractive but lets two colluding custodians move
assets without an administrator ever seeing it, and there is no operational
requirement for self-service transfer. Recorded as a product decision (§P).

### Audit

```
equipment.scope_transferred   entity_type='equipment_item'  entity_id=<asset id>
  before { scope_id: A }   after { scope_id: B, reason }
```

One event, on the asset, with both scopes — so the asset's own history answers
"when did this leave PID?" without a join. `equipment.updated` is **not**
reused: a transfer is not an edit, and `scope_id` is deliberately absent from
`ASSET_EDITABLE` (Phase 13B tests that self-service rescoping is impossible).

---

## M. Security design (not implemented)

| Threat | Defence |
|---|---|
| **Unauthorized assignment** | assignment endpoint is `isMoAdmin` only, same as `POST /crew/:id/duties` |
| **Forged `scope_id`** in a request body | scope is never taken from the caller for authorization — Phase 13B's rule. A body `scope_id` is a *filter*; it can only narrow. `scope_id` stays out of `ASSET_EDITABLE`. |
| **Forged `user_id`** | the assignee must resolve to a live `users` row; the actor is always `res.locals.currentUser`, never the body |
| **Self-assignment** | `assignee <> actor` on the assignment endpoint. An Admin who needs their own scope has another Admin grant it — the same principle that makes self-approval a question at all (§F) |
| **Removing the last custodian** | *warn, do not refuse.* A scope with no custodian is still administrable by an Admin, and refusing would make offboarding impossible. The report in §O step 6 surfaces custodian-less scopes. |
| **Assigning an inactive user** | require `users.status='active'` at assignment time **and** re-check at resolution: `inventoryScopeOf()` should join `users` and ignore assignments for non-active accounts, so deactivating a leaver revokes reach without a second action |
| **Assigning a user without Media Ops access** | permitted but **inert**, and that is correct: `requireEquipment()` runs first, so a scope grants nothing on its own. Phase 13B tests this (`scope does not replace the module gate`). The UI should warn rather than the API refuse. |
| **Cross-scope access** | Phase 13B, enforced and tested across 10 bypass vectors |
| **Revoked assignment still granting access** | `removed_at IS NULL` in the resolver, which is re-read every request and never cached |
| **Transfer while checked out** | §L precondition, 409 |

---

## N. Final conceptual domain model

```
                 ┌──────────────────────┐
                 │ users                │ REUSE
                 └───────┬──────────────┘
                         │
          ┌──────────────┼───────────────────────┐
          │              │                       │
   ┌──────┴───────┐  ┌───┴────────────────┐  ┌───┴──────────────┐
   │ mo_user_     │  │ mo_user_inventory_ │  │ mo_equipment_    │
   │ duties       │  │ scopes             │  │ transactions     │
   │ REUSE        │  │ EXTEND             │  │ REUSE            │
   │ (capability) │  │ (+role,+removed_*) │  │ (custody)        │
   └──────┬───────┘  └───┬────────────────┘  └───┬──────────────┘
          │              │                       │
   ┌──────┴───────┐      │                       │
   │ mo_duty_     │      │                       │
   │ flags REUSE  │      │                       │
   └──────────────┘      │                       │
                         │                       │
                 ┌───────┴──────────┐            │
                 │ mo_inventory_    │            │
                 │ scopes   REUSE   │            │
                 └───────┬──────────┘            │
                         │ scope_id (nullable)   │
                 ┌───────┴──────────┐            │
                 │ mo_equipment_    ├────────────┘
                 │ items    REUSE   │
                 └───────┬──────────┘
                         │
                 ┌───────┴──────────┐
                 │ mo_audit_logs    │ REUSE
                 └──────────────────┘
```

| Element | Class | Note |
|---|---|---|
| **User** | REUSE | `users` + `mo_user_profiles`. No identity work; inventory is not an identity provider. |
| **Inventory Scope** | REUSE | `mo_inventory_scopes`, Phase 13A. Unchanged. |
| **Scope Assignment** | **EXTEND** | `mo_user_inventory_scopes` + `role`, `removed_by`, `removed_at` |
| **Duty** | REUSE | `mo_duty_flags` / `mo_user_duties`, **unmodified** |
| **Asset** | REUSE | `mo_equipment_items.scope_id`, Phase 13A. Unchanged. |
| **Custodian** | **DERIVE** | not an entity — the intersection of an active assignment and the `equipment_custodian` duty |
| **Audit** | REUSE | `mo_audit_logs` + existing `audit()`. No second audit system. |
| **Custody / holder** | DERIVE | latest transaction per asset, as today |
| **Historical scope** | DERIVE | §K — asset's current scope, until transfer exists |
| Borrower, Loan, Request, Eligibility | **NOT CREATED** | out of scope, and dependent on all of the above |

**One table changes. Nothing is replaced. Nothing is created.**

---

## O. Migration plan

Steps 1–6 are executable once the product decisions in §P are made. **Steps 7–9
are explicitly not implemented by this phase.**

| # | Step | Gate before proceeding |
|---|---|---|
| 1 | **Establish production scopes.** Create the real inventories through the existing CRUD screen. Re-measure §I against production first. | the list of inventories is agreed by the people who run them (§P-1) |
| 2 | **Validate the mapping.** Fill the §I worksheet; check every operational asset appears exactly once, every `proposed_scope` matches a real scope, and no asset is unassigned. | 100% of operational assets mapped, reviewed by name |
| 3 | **Assign assets** — `UPDATE … SET scope_id` in batches by category, smallest first. Each batch is one audited administrative action. | after each batch: the §J progress query, and a spot check that the intended custodian can still see the batch |
| 4 | **Assign custodians** — after step 3, never before. A custodian appointed over an empty scope cannot verify anything. Grant the `equipment_custodian` duty *and* the scope assignment; neither alone is enough. | each custodian confirms they can see exactly their own inventory |
| 5 | **Verify authorization** — for each scope: its custodian sees it, another scope's custodian does not, an unassigned crew member sees neither, the Admin sees everything. | the matrix is clean |
| 6 | **Verify every operational asset is governed** — §J query returns `legacy = 0`; and a report of scopes with **no active custodian** is empty or consciously accepted (§M). | sign-off |
| 7 | **Enable strict mode** — *NOT NOW.* Change the resolver so `level:"none"` yields no assets at all rather than the legacy estate. | step 6 stable for a full business cycle |
| 8 | **Remove the NULL fallback** — *NOT NOW.* Drop `${col} IS NULL` from `inventoryScopeSql()`. | step 7 with no incidents |
| 9 | **Make `scope_id` mandatory** — *NOT NOW.* `NOT NULL`, or a partial constraint excluding retired/deleted assets (§J). | step 8 stable |

**Why this order is safe.** Phase 13B's enforcement is strictly additive: a
`NULL` scope stays reachable. So steps 1–6 are *reversible one asset at a time* —
setting `scope_id` back to `NULL` restores the previous behaviour exactly, with
no code change and no deploy. The irreversible decisions are steps 7–9, and they
are last, gated, and deliberately out of this phase.

**Rollback:** `UPDATE mo_equipment_items SET scope_id = NULL WHERE …` for any
batch, at any point up to step 7.

---

## P. Unresolved product decisions

None of these are answered here, and none should be guessed at.

| # | Decision | Blocks | Why it cannot be inferred |
|---|---|---|---|
| **P-1** | **Which inventories exist, and who owns each?** | everything | §I: the data contains no ownership signal. PID and 24 Frames are named in the audits but exist nowhere in the database. |
| **P-2** | **How many custodians per inventory**, and is a primary marked? | §C, §M | many-to-many supports any answer; the operational one is unknown |
| **P-3** | **Backup custodians** — a second assignment, or nothing? | §C | no cover/leave policy has been described |
| **P-4** | **Self-approval** — may a custodian approve their own request? | §F | Phase 12 left it open; may vary per scope |
| **P-5** | **Borrowing from your own inventory** — permitted? | §G | prohibiting it makes a single-custodian inventory unusable by its custodian |
| **P-6** | **Scope transfer** — Admin only, or custodian-of-both? | §L | no requirement for self-service transfer has appeared |
| **P-7** | **Legacy asset mapping** — the actual per-asset list | §O step 2 | must come from the people who run the cupboards |
| **P-8** | **Historical snapshots** — needed? | §K | same decision as P-6: only matters if transfers happen |
| **P-9** | **Pooled assets** (`tracking_mode='pooled'`, `pool_quantity`) — can one pool span scopes? | §O step 3 | Phase 12's one-asset-one-scope rule was reasoned about serialised items |
| **P-10** | **Retired assets** — do they need a scope at closure? | §J, §O step 9 | decides whether step 9 is `NOT NULL` or a partial constraint |

---

## Appendix — reproducing the §I measurement

Read-only. Run against production before §O step 1.

```sql
-- totals
SELECT count(*) total,
       count(*) FILTER (WHERE deleted_at IS NULL) live,
       count(*) FILTER (WHERE deleted_at IS NULL AND retired_at IS NULL) operational,
       count(*) FILTER (WHERE deleted_at IS NULL AND retired_at IS NOT NULL) retired
  FROM mo_equipment_items;

-- governance progress
SELECT count(*) FILTER (WHERE scope_id IS NULL) legacy,
       count(*) FILTER (WHERE scope_id IS NOT NULL) governed
  FROM mo_equipment_items WHERE deleted_at IS NULL AND retired_at IS NULL;

-- is there any ownership signal? (all-one-value => no)
SELECT count(DISTINCT department_id) depts, count(DISTINCT campus_id) campuses
  FROM mo_equipment_items WHERE deleted_at IS NULL;

-- who holds the custodian duty
SELECT u.id, u.full_name FROM mo_user_duties d
  JOIN mo_duty_flags f ON f.id = d.duty_flag_id
  JOIN users u ON u.id = d.user_id
 WHERE f.code = 'equipment_custodian';

-- assets on loan (transfer blockers, §L)
SELECT count(*) FROM mo_equipment_items
 WHERE status = 'checked_out' AND deleted_at IS NULL;

-- the migration worksheet (§I)
SELECT i.asset_tag, c.name AS category, i.make, i.model, i.serial_no, i.status,
       NULL::text AS proposed_scope
  FROM mo_equipment_items i
  LEFT JOIN mo_equipment_categories c ON c.id = i.category_id
 WHERE i.deleted_at IS NULL AND i.retired_at IS NULL
 ORDER BY c.name, i.asset_tag;
```
