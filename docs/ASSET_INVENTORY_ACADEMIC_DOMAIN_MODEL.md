# Academic Inventory — Domain Model Design

**Design only.** No schema, migration, API, UI, role, permission or record was
created or changed. Nothing here is implemented.

Builds on the Phase 10 and Phase 11 audits, and on the current implementation
(Phases 1–9A).

---

## 1. Executive summary

Academic Inventory needs **four new concepts and nothing else**. Everything else
is reuse.

| | |
|---|---|
| **NEW** | Inventory Scope · Scope Assignment (custodian) · Borrower Eligibility · Loan Request |
| **EXTEND** | one scope reference on the asset · one optional link on the booking |
| **REUSE** | assets, identifiers (incl. RFID), bookings, the custody ledger, maintenance, audit, notifications, users, academic units, the module shell |
| **DERIVE** | borrower identity · custody · effective state · scope authorization |

Three findings shape the design:

1. **The ledger must not be redesigned.** `holder_id` is `NOT NULL REFERENCES
   users(id)`. Everything downstream of custody already works; the design keeps
   that FK intact and confines the borrower question to *who gets a `users`
   row*, not *what the ledger looks like*.
2. **Every structural pattern needed already exists in this codebase.**
   `mo_creator_teams` + `mo_creator_team_members` is the scope/assignment shape.
   `mo_creator_profiles` is the domain role + status + **type** shape.
   `mo_smc_profiles` is the academic-unit-scoped population shape.
   `creatorScopeOf()` is the scope-resolution shape. None needs inventing.
3. **The one genuinely missing capability is a scope *gate*.** `department_id`
   and `campus_id` are caller-supplied filters. Academic Inventory is the first
   requirement that needs authorization derived from scope, and that is where
   the real work is.

---

## 2. Architectural principles

1. **One asset engine.** No academic asset table, no second ledger, no second
   identifier system, no second reservation system.
2. **Scope is an authorization subject, not a filter.** A filter narrows a view;
   a gate denies one. Academic Inventory needs the second.
3. **The inventory system is never an identity provider.** No borrower
   passwords, no student authentication, no faculty authentication.
4. **Roles, duties, modules, scopes and eligibility stay distinct** (§14).
5. **Derive rather than store**, consistent with Phases 4–6: custody, effective
   state and scope authority are computed from authoritative records.
6. **Nothing is named in schema logic.** "PID", "24 Frames" and "Media Crew" are
   rows, never branches in code.

---

## 3. Inventory Scope model

The central entity. **NEW.**

| Field | Why it exists | Already provided elsewhere? |
|---|---|---|
| `id` | the authorization subject every gate resolves to | no |
| `name` | what a human calls it | no |
| `code` | short stable handle for labels, exports, QR captions | no — `mo_campuses.code` is the precedent |
| `type` | distinguishes production from academic **without naming either** (§4) | no |
| `is_active` | an inventory can be retired without deleting its history | pattern from `mo_creator_teams.is_active` |
| `academic_unit_id` → `mo_academic_units` | **nullable.** Where an academic inventory belongs institutionally; already how SMC scopes a person and how `mo_requests` scopes a request | the table exists; the link does not |
| `department_id` → `mo_departments` | **nullable.** Lets Production Inventory map to the existing department so legacy reporting keeps working | the table exists |
| `campus_id` → `mo_campuses` | **nullable.** Where it physically sits — *context, never authority* (§4) | the table exists |
| `created_by`, `created_at`, `updated_at` | provenance, as every other Media Ops table has | pattern exists |

**Deliberately excluded:** `parent_scope_id` and a metadata blob. No requirement
in evidence needs a hierarchy — PID and 24 Frames are siblings, not
parent/child — and a metadata bag is where undesigned fields go to hide. If
sub-inventories are ever needed, a nullable parent is an additive change.

The three target inventories become three rows. Nothing in code mentions them.

---

## 4. Scope types, and why scope ≠ location

`type` exists so that a future inventory needs a **row, not a migration**. The
minimum taxonomy the evidence supports is two values — `production` and
`academic` — because those are the only two behaviours anything would branch on
(for example: does a loan require approval?). "studio", "department" and
"campus" are **not** types: a studio is an inventory like any other, and
department/campus are *relationships this entity already has*.

`type` should be free text or a narrow CHECK. `mo_creator_profiles.creator_type`
is the existing precedent, and it is deliberately free text with the comment
that it is "free text from the admin".

### Scope is not location

An inventory **has** a location; it **is not** one.

- Two inventories can sit on one campus. PID and 24 Frames plausibly do, so
  `campus_id` cannot distinguish them — it fails as an identity.
- One inventory can span locations without becoming two inventories.
- An asset can be physically moved without changing who is accountable for it.

So `campus_id` on the scope is **context for humans and for future RFID
readers**, and is never consulted by an authorization decision.

---

## 5. Asset relationship

**EXTEND `mo_equipment_items` with one nullable scope reference.**

### One scope, or several?

**One — and this follows from an existing hard constraint, not from taste.**

- Custody is derived from *the latest transaction per asset*. Authorization over
  that asset must therefore resolve to exactly one scope, or "may this person
  check this out" has no single answer.
- The booking EXCLUDE constraint is per `equipment_item_id`. Two scopes sharing
  one asset would contend for one reservation calendar with no way to arbitrate.
- A custodian is accountable for assets. Two custodians accountable for the same
  camera is not a data model, it is an argument.

So: **one asset belongs to at most one inventory scope at a time.**

### Transfer between scopes

Permitted in principle, as a deliberate act. The consequences:

- **Transfer while on loan must be refused.** Custody and accountability would
  be split between two custodians mid-loan.
- **History must not be rewritten.** Past transactions belong to the scope that
  was accountable at the time.

### Does history need scope attribution?

**Yes, and it is already available without a new column.** A transaction's scope
is the scope of its asset *at that moment*. Two ways to answer it:

- **derive** — join the asset's current scope (correct only if transfers are
  rare or never happen);
- **record** — copy the scope onto the transaction at write time (correct
  always; costs one column and denormalises).

This is genuinely undecided and depends on §19 Q8. The design records the
trade-off rather than picking; if transfers are disallowed, derivation is free
and exact.

### Relationship to `department_id` / `campus_id`

Both stay. They keep working as filters and for existing reporting. The scope
reference is **added beside them**, not instead of them, so no existing read
model, summary or test changes behaviour.

---

## 6. Custodian model

```
users ──< Scope Assignment >── Inventory Scope
```

**NEW join entity**, layered *over* the existing duty infrastructure.
`mo_user_duties` is **not modified** — the global `equipment_custodian` duty
keeps its current meaning (may act on the estate at all), and the assignment
answers the different question *of which inventory*.

| Field | Why |
|---|---|
| `user_id` → `users` | who |
| `scope_id` → Inventory Scope | of what |
| `role` | `custodian` / `manager` — a **domain** role, not a Nerve role (§14) |
| `is_active` | revoke without deleting the record |
| `granted_by` → `users`, `granted_at` | who made them responsible, and when — the existing `mo_user_duties` provenance pattern |
| `ended_at` | **nullable.** "Active period" matters because a loan can outlive a custodian's tenure; an inspection in March must be attributable to whoever was responsible in March |

**Many custodians per scope:** yes — the join is many-to-many, and
`mo_creator_team_members` is the precedent. Cover, leave and handover all
require it.

**One person over several scopes:** yes, by the same structure. A single person
may well run both PID and 24 Frames initially.

This is directly `mo_creator_teams.lead_user_id` generalised from one lead to a
membership table, which is what `mo_creator_team_members` already is.

---

## 7. Borrower model

**Deliberately unresolved**, as instructed. What the design provides is an
*abstraction* that survives any of the three answers.

### The hard constraint

`mo_equipment_transactions.holder_id TEXT NOT NULL REFERENCES users(id)`.

**The ledger is the boundary.** Any borrower who can appear in custody history
must have a `users` row, or that FK must change. Those are the only two options,
and the second touches the one append-only table the whole module rests on.

### The abstraction

A **Borrower Profile** — the `mo_smc_profiles` / `mo_creator_profiles` shape:

| Field | Why |
|---|---|
| `user_id` → `users` | the identity spine; keeps the ledger FK intact |
| `borrower_type` | population label (§8) |
| `academic_unit_id` → `mo_academic_units` | **nullable.** Where they belong; exactly how SMC scopes a student |
| `status` | domain lifecycle, separate from `users.status` — a suspended borrower is not a deactivated employee |
| `identifier` | **nullable.** Enrolment or staff number. `mo_casting_requests.enrolment_number` is the precedent |
| `valid_until` | **nullable.** A student's eligibility ends; an account may not |
| `created_by`, timestamps | provenance |

**Why a profile rather than a `users.role` value:** because a borrower is a
*population inside Media Ops*, which is exactly what `mo_creator_profiles` and
`mo_smc_profiles` are, and because adding to the nine-value `users.role` CHECK
would grant meaning across all of Nerve, not just here.

### If a non-account borrower is chosen

Stated plainly rather than worked around: the Phase 11 portal pattern
(`mountPortalOtp` → `mo_portal_sessions`, identity = **verified email**) can
establish *who someone is*, but it **cannot make them a holder**. The
consequences, in full:

1. the `holder_id` FK would have to admit a non-`users` subject — a change to
   the ledger's referential integrity, affecting custody derivation, the state
   block, analytics and every equipment test; **or**
2. verification provisions a `users` row (the portal becomes an enrolment path,
   not a custody path) — the ledger is untouched; **or**
3. a staff member holds custody on the borrower's behalf, and the borrower is
   recorded on the *request* rather than the ledger — the ledger is untouched,
   but "who physically holds it" becomes indirect.

**No shortcut is proposed.** This is §19 Q4.

---

## 8. Borrower populations

Three ways to represent student / faculty / employee / guest:

| Approach | Authorization | Reporting | Eligibility | Audit | Integrations |
|---|---|---|---|---|---|
| **identity-derived** (infer from `users.team`, `mo_smc_profiles`, …) | no new surface | brittle — meaning is scattered | hard to express | unchanged | breaks when a directory arrives |
| **domain profile attribute** (`borrower_type` on the profile) | one place to read | direct | direct | unchanged | a future import sets one column |
| **explicit borrower-type entity** | a table to join | rich | rich | unchanged | most work |

The middle option matches every existing precedent in this codebase
(`creator_type`, `applicant_type`, `mo_smc_profiles.designation`), and
`creator_type` is deliberately free text rather than a CHECK — worth copying,
because the list of populations is a business question that will change.

**These are never global Nerve roles.** A student is not a `users.role`.

---

## 9. Borrower eligibility

```
Borrower ──< Eligibility >── Inventory Scope
```

**NEW.** The minimum is a join with a validity window:

`borrower (user_id) · scope_id · is_active · valid_from / valid_until ·
granted_by · granted_at`

**Why it is not derived from the academic unit.** It is tempting to say "a
student of Unit X is automatically eligible for Inventory Y". That embeds a
business rule in a query, and the rule is exactly what changes: a design student
may be eligible at 24 Frames but not at PID, a final-year may have rights a
first-year does not, and a visiting lecturer belongs to no unit.

An explicit join keeps the rule **data**, so a custodian can grant and revoke it
without a deployment. A unit-based default can still be offered in the UI as a
bulk action — that is a convenience, not a rule.

**Where the rule must not live:** on `mo_equipment_items`. The asset table
describes the asset, never who may borrow it.

---

## 10. Request and approval

### The five roles are distinct, even when one person fills them

| Role | Meaning |
|---|---|
| **requester** | who submitted the form |
| **borrower** | who will hold the asset (may differ — a faculty member requesting for a student) |
| **approver** | who authorised it |
| **issuer / custodian** | who handed it over |
| **holder** | who the ledger says has it |

A production checkout collapses all five into one person; an academic loan may
use four different ones. The model keeps them as separate references.

### Lifecycle

`mo_requests` already proves a status ladder in production:
`new · under_review · needs_clarification · ready · converted · closed ·
rejected`. Reusing that **vocabulary** (not the table — it is project intake)
gives the minimum:

```
draft? → submitted → under_review → approved → fulfilled
                          ↓             ↓
                       rejected      cancelled / expired
```

`draft` is only needed if requests are composed over time; `expired` only if
approvals have a shelf life. Both are §19 questions, and both are additive.

### Minimum information

`scope_id · requester_id · borrower_id · asset_id or category_id · window
(from/to) · purpose · status · decided_by · decided_at · decision_note ·
booking_id (once approved) · created_at`

That set answers: **who requested**, **on whose behalf**, **who approved**,
**what for**, **for when**. *Who issued / held / returned / inspected* are
answered by the ledger and the inspection record, not here.

---

## 11. Reservation integration

**REUSE `mo_equipment_bookings`. No second reservation system.**

```
Request → approved → creates a booking → checkout consumes it
```

The booking table already has everything: an asset, a user, a date range, a
status (`reserved|active|completed|cancelled`), and — critically — a
**database-enforced EXCLUDE constraint** that makes double-booking impossible
under concurrency. An academic reservation that did not use it would be a second
reservation system with weaker guarantees.

`mo_equipment_bookings` already carries optional `shoot_id` and `project_id` —
*why* the booking exists. An academic loan is a third such purpose, so the
minimum addition is **one nullable `request_id`**, mirroring the two links that
already exist.

`POST /equipment/bookings` already rejects unserviceable assets and enforces
VR-8; the approval step would call the same path rather than inserting directly.

---

## 12. Checkout and custody

**REUSE the ledger unchanged.**

Everything needed already exists:

- `holder_id` — who has it
- `recorded_by` + `recorded_via` (`desktop|mobile|kiosk`) — who issued it and how
- `booking_id` — which reservation it was made under
- `expected_return_at`, `condition_noted`
- append-only, with custody derived by `(occurred_at DESC, id DESC)`
- `resolveHolder()` already refuses a client-supplied holder unless the caller
  is a custodian/admin or holds a verified kiosk session
- the kiosk already separates operator from holder — precisely an academic
  counter's requirement

**The only change checkout needs is a scope gate** (§13): may this caller issue
*this* asset, and is *this* borrower eligible in that scope. No ledger column is
required for the account-based borrower model.

---

## 13. Return and inspection

**NEW, and deliberately tiny.** The Phase 10 gap was *who inspected*, not a
maintenance system — that exists.

| Field | Why |
|---|---|
| `transaction_id` → the **check-in** row | anchors the inspection to the return it describes |
| `inspector_id` → `users` | the missing answer |
| `inspected_at` | when |
| `condition` | the assessed condition (the ledger's `condition_noted` is what was *recorded at return*; this is the considered judgement, which may differ) |
| `damage_found` | boolean — drives whether a maintenance record follows |
| `notes` | **nullable** |

**Excluded:** an evidence/photo column. Nothing in the current system stores
images for equipment, and adding a file-handling path here would make inspection
the first. If photos are wanted, that is its own decision.

**Not a workflow.** Inspection produces a record and, if `damage_found`, an
ordinary `mo_maintenance_records` row through the existing damage path — which
already exists and already auto-opens on a condition drop (BR-8).

---

## 14. Accountability matrix

| Event | Requester | Borrower | Approver | Issuer/Custodian | Holder | Inspector | Audit |
|---|---|---|---|---|---|---|---|
| Request | **D** | **D** | — | — | — | — | **D** |
| Approval | R | R | **D** | — | — | — | **D** |
| Reservation | R | R | R | — | — | — | **E** ✓ |
| Checkout | R | R | R | **E** ✓ | **E** ✓ | — | **E** ✓ |
| Return | R | R | R | **E** ✓ | **E** ✓ | — | **E** ✓ |
| Inspection | R | R | R | R | R | **D** | **D** |
| Damage | R | R | R | **E** ✓ | R | R | **E** ✓ |
| Maintenance | — | — | — | **E** ✓ | — | — | **E** ✓ |

**E ✓** = exists today · **D** = requires the domain model above · **R** =
resolvable by reference once the domain model exists · **—** = not applicable

Four of eight event types are fully answered today. The gaps are all *workflow
states that do not exist*, not identities that are missing — unchanged from
Phase 10, now with a model that fills them.

---

## 15. Authorization model

```
Nerve user           users.role, users.status                    ✓ exists
   ↓
Media Ops module     requireEquipment(): team + module grant     ✓ exists
   ↓
INVENTORY SCOPE      resolved FROM THE USER, never from input    ✗ to build
   ↓
Domain role/duty     scope assignment (custodian/manager)        ✗ to build
   ↓                 + global equipment_custodian duty           ✓ exists
Operation            canCheckOut / canBook / canRetire / …       ✓ exists
```

### Operations and who may perform them

| Operation | Gate |
|---|---|
| view | scope membership, or a global custodian/admin |
| request | borrower eligibility in the scope |
| approve | custodian/manager of that scope, **and not the borrower** (§18) |
| reserve | via approval, through the existing booking endpoint |
| checkout | custodian of the scope; borrower eligible; existing BR-7/BR-8 rules |
| checkin | holder, custodian of the scope, or admin |
| inspect | custodian/manager of the scope |
| maintain | existing `canManageEquipment`, narrowed to the scope |
| manage inventory | custodian/manager of that scope; admin everywhere |

### The rule that matters

**A caller-supplied `scope_id`, `department_id` or `campus_id` is a filter and
must never be an authorization input.** The pattern to follow already exists:
`creatorScopeOf(u)` resolves scope **from the authenticated user** and returns
`{level:'all'|'team'|'self'}`; the query then applies it. An equipment
equivalent — `inventoryScopeOf(u)` returning the scopes a user may act in, and
at what level — is the same shape, and it is the single largest piece of work in
the whole design.

---

## 16. Role / duty / scope boundaries

Six distinct things, preserved:

| Concept | Where it lives | Example |
|---|---|---|
| Global Nerve role | `users.role` | `admin` |
| Media Ops module grant | `mo_user_profiles.allowed_modules` / group default | `equipment` |
| Media Ops role | `mo_user_profiles.mo_role` | `team_lead` |
| Domain role | scope assignment `role` | `custodian` of PID |
| Duty | `mo_duty_flags` + `mo_user_duties` | `equipment_custodian` (global capability) |
| Inventory scope | Inventory Scope | PID |
| Borrower eligibility | Eligibility join | eligible at 24 Frames until June |

**No generic "Inventory Admin" global role is created.** An admin is already an
admin; a custodian is already a duty; *which inventory* is a relationship. The
Creator Network makes the same separation — `creator_admin` is a domain role in
`mo_creator_profiles`, not a Nerve role — and it works.

---

## 17. Conceptual ERD

```
                users ─────────────────────────────┐
                  │ 1                              │ 1
                  │                                │
       ┌──────────┴───────────┐          ┌─────────┴──────────┐
       │ Borrower Profile     │          │ Scope Assignment   │
       │ (NEW)                │          │ (NEW)              │
       │ user_id, type,       │          │ user_id, scope_id, │
       │ academic_unit_id,    │          │ role, is_active,   │
       │ status, identifier   │          │ granted_by/at,     │
       └──────────┬───────────┘          │ ended_at           │
                  │                      └─────────┬──────────┘
                  │ *                              │ *
       ┌──────────┴───────────┐                    │
       │ Eligibility (NEW)    │                    │
       │ user_id, scope_id,   │                    │
       │ valid_from/until     │                    │
       └──────────┬───────────┘                    │
                  │ *                            * │
                  └──────────┐        ┌────────────┘
                             ▼        ▼
                    ┌────────────────────────┐
                    │ Inventory Scope (NEW)  │
                    │ id, name, code, type,  │
                    │ academic_unit_id?,     │
                    │ department_id?,        │
                    │ campus_id?, is_active  │
                    └───────────┬────────────┘
                                │ 1
                                │ *
                    ┌───────────┴────────────────────┐
                    │ mo_equipment_items (EXTEND)    │
                    │ + scope_id (nullable)          │
                    └───────────┬────────────────────┘
                                │ 1
             ┌──────────────────┼───────────────────┬───────────────┐
             │ *                │ *                 │ *             │ *
   ┌─────────┴────────┐ ┌───────┴──────────┐ ┌──────┴───────┐ ┌─────┴──────────┐
   │ mo_equipment_    │ │ mo_equipment_    │ │ mo_asset_    │ │ mo_maintenance_│
   │ bookings         │ │ transactions     │ │ identifiers  │ │ records        │
   │ (EXTEND:         │ │ (REUSE)          │ │ (REUSE, incl │ │ (REUSE)        │
   │  + request_id?)  │ │ holder_id→users  │ │  rfid)       │ │                │
   └─────────┬────────┘ └───────┬──────────┘ └──────────────┘ └────────────────┘
             │ 1                │ 1
             │                  │ 0..1
   ┌─────────┴────────┐ ┌───────┴──────────┐
   │ Loan Request     │ │ Inspection (NEW) │
   │ (NEW)            │ │ transaction_id,  │
   │ scope, requester,│ │ inspector_id,    │
   │ borrower, window,│ │ condition,       │
   │ status, decided_ │ │ damage_found     │
   │ by/at, booking   │ └──────────────────┘
   └──────────────────┘
```

---

## 18. Entity classification

| Entity | Class | Basis |
|---|---|---|
| User | **REUSE** | `users` — the identity spine; no new auth |
| Academic unit | **REUSE** | `mo_academic_units` — already scopes SMC people and requests |
| Department / Campus | **REUSE** | `mo_departments`, `mo_campuses` — context on the scope |
| Asset | **REUSE + EXTEND** | `mo_equipment_items` + one nullable `scope_id` |
| Identifier (QR/RFID) | **REUSE** | `mo_asset_identifiers` — `rfid` already an allowed kind |
| Reservation | **REUSE + EXTEND** | `mo_equipment_bookings` + one nullable `request_id` |
| Transaction / custody | **REUSE, unchanged** | `mo_equipment_transactions` |
| Current custody | **DERIVE** | latest transaction per asset (Phase 4) |
| Effective state | **DERIVE** | the Phase 5 state block |
| Maintenance / damage | **REUSE** | `mo_maintenance_records` |
| Audit | **REUSE** | `mo_audit_logs` via `audit()` |
| Notifications | **REUSE** | `mo_notifications` + automation engine |
| Duty (global capability) | **REUSE, unmodified** | `mo_duty_flags` / `mo_user_duties` |
| **Inventory Scope** | **NEW** | nothing represents an inventory; §3 |
| **Scope Assignment** | **NEW** | duties have no scope column; §6 |
| **Borrower Profile** | **NEW** (or **DERIVE** if borrowers are existing users with no extra attributes) | §7; shape copied from `mo_smc_profiles` |
| **Borrower Eligibility** | **NEW** | keeps the rule as data, not code; §9 |
| **Loan Request** | **NEW** | no equipment request exists; `mo_requests` is project intake |
| Approval | **DERIVE** — *not* a new entity | status + `decided_by` + `decided_at` on the request |
| **Inspection** | **NEW** | the one Phase 10 accountability gap; §13 |
| Scope authorization | **DERIVE** | `inventoryScopeOf(u)`, shaped like `creatorScopeOf()` |

**Four new tables, two one-column extensions.** Everything else is existing
infrastructure or computed.

---

## 19. Existing asset migration

Existing production equipment must keep working unchanged.

| Concern | Behaviour |
|---|---|
| default scope | `scope_id` is **nullable**, so every existing asset keeps working with no backfill. A "Production Inventory" scope can be created and assets attached deliberately, in the open. |
| legacy assets | unchanged; `department_id` and `campus_id` keep their current meaning and keep filtering |
| legacy transactions | **untouched.** The ledger gains no column in the account-based model |
| existing bookings | untouched; `request_id` is nullable |
| current custody | unchanged — derivation does not consult scope |
| QR / RFID identifiers | unchanged; identifiers are per asset and scope-agnostic |
| historical scope attribution | §5 — derivable if transfers are disallowed; needs a recorded column if they are allowed |

**A null scope must mean "not yet scoped", never "visible to everyone".** Once a
gate exists, unscoped assets need an explicit rule, and the safe default is the
one this codebase already chose for modules: **fail closed** — visible to global
custodians and admins only, until assigned.

---

## 20. Security model

| Threat | Today | Under this design |
|---|---|---|
| forged borrower | n/a | eligibility resolved server-side from the borrower profile, never from the request body |
| forged holder | **prevented** — `resolveHolder()` | unchanged |
| forged scope | n/a | **the central rule**: scope resolved from the user, never accepted as input (§15) |
| cross-inventory checkout | **not prevented** | gate at checkout: asset's scope ∈ caller's scopes |
| unauthorized approval | n/a | approver must hold a custodian/manager assignment **in that scope** |
| self-approval | n/a | requires an explicit rule: `approver_id ≠ borrower_id` (and arguably ≠ `requester_id`) |
| custodian approving own request | n/a | the same rule; a custodian borrowing needs a second approver, or an accepted exception |
| inactive borrower | **not checked** | eligibility `is_active` + `valid_until` checked at request and at checkout |
| inactive custodian | **not checked** | assignment `is_active`/`ended_at` checked at the point of action |
| scope removed while on loan | n/a | scope deactivation must not orphan an open loan — refuse, or require check-in first |
| asset transfer between scopes | n/a | refuse while custody is open (§5) |
| historical record modification | **partly** — append-only by convention only | unchanged by this design; still worth a grant-level fix separately |

The two rules that must be **explicit**, because nothing implies them, are
**self-approval** and **cross-inventory access**.

---

## 21. Product decisions still required

Unchanged from Phase 11 unless noted; none is answered here.

1. **PID representation** — an Inventory Scope is proposed; whether PID is *also*
   an academic unit row is open.
2. **24 Frames representation** — same, and harder: it is a studio, not a faculty.
3. **Student / faculty identity source** — no directory, no SSO; SMC accounts are
   created by hand.
4. **Must every borrower authenticate?** §7 sets out the three consequences.
5. **Borrower populations** — which types exist, and whether the list is fixed.
6. **Approval authority** — custodian, faculty, department head, or none.
7. **Custodian assignment model** — per scope is proposed; per asset is not.
8. **May assets move between inventory scopes?** Decides whether transactions
   need recorded scope attribution (§5).
9. **Do external borrowers exist?** Decides whether §7's option 1 is ever needed.

Newly surfaced by this design:

10. **Is an approval valid indefinitely?** Decides whether `expired` exists.
11. **May a custodian borrow from their own inventory?** Decides the
    self-approval rule.
12. **Should inspection capture photographic evidence?** Would make equipment the
    first module to store images.

---

## 22. Implementation sequence

Dependency order. Each stage is blocked by those above it.

```
A. Identity source confirmation          ← Q3, Q4, Q5. Nothing below can start.
      ↓
B. Inventory Scope                       ← Q1, Q2. The authorization subject.
      ↓
C. Asset → scope link (nullable)         ← additive; no behaviour change yet
      ↓
D. Scope Assignment (custodian)          ← Q7. First scoped accountability.
      ↓
E. inventoryScopeOf() + the scope GATE   ← the largest piece; nothing is
      ↓                                    enforced until this exists
F. Borrower Profile                      ← needs A
      ↓
G. Borrower Eligibility                  ← needs B, F
      ↓
H. Loan Request + Approval               ← needs E, G, Q6, Q11
      ↓
I. Reservation integration               ← REUSE bookings + request_id
      ↓
J. Academic checkout / checkin           ← REUSE the ledger + the gate from E
      ↓
K. Inspection                            ← needs J, Q12
      ↓
L. Inventory audit / stock-take          ← needs B, C
      ↓
M. RFID                                  ← REUSE mo_asset_identifiers; needs L
```

**C, I and J are mostly reuse.** **E is where the work is** — it is the
capability the platform has never had, and every gate below it depends on it.

Stages A and B are blocked on product decisions. Nothing after A can begin until
Q3 and Q4 are answered.

---

## 23. Explicit non-goals

Not designed here, and not to be inferred:

- a second asset table, ledger, identifier system or reservation system
- borrower authentication, passwords, or any identity-provider behaviour
- new global Nerve roles, including an "Inventory Admin"
- changes to Creator Network, SMC, casting or project intake
- RFID hardware integration (the data model already admits the tag)
- offline capability, a mutation queue or a local database
- a maintenance-workflow redesign
- academic fees, fines, penalties or billing — nothing in evidence asks for them
- hierarchical or nested inventories
- photographic evidence storage
