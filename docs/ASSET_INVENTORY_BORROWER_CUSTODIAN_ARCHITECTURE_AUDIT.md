# Borrower & Custodian — Architecture Audit

Audit only. **No table, endpoint, UI or schema was created or changed.**

Every claim below is cited from the live schema or from source.

---

## 1. Executive summary

Four findings decide the shape of Academic Inventory.

1. **A holder must be a Nerve account.**
   `mo_equipment_transactions.holder_id TEXT NOT NULL REFERENCES users(id)`, and
   `users.password_hash` is `NOT NULL`. There is no way to record custody for a
   person who does not have an authenticable account.

2. **Students and faculty do not exist in the schema.** `users.role` is
   CHECK-constrained to nine values, none academic. A repository-wide column
   search for `student|faculty|enrol|roll_no|borrower` returns exactly two
   hits, neither an identity: `entries.student_count` and
   `mo_casting_requests.enrolment_number`.

3. **A custodian exists, but is global.** `mo_duty_flags.equipment_custodian`
   (id 3) with `mo_user_duties(user_id, duty_flag_id, granted_by, granted_at)`.
   There is **no scope column** — a custodian is a custodian of everything.

4. **Two precedents already model a person who is not a Nerve user**, complete
   with consent capture and public submission: `mo_casting_requests` and
   `mo_requests`. Neither is a borrower, but both are the shape a borrower
   would take, and `mo_requests` already carries `institute` and
   `academic_unit_id`.

The engine itself needs **no fork**. Assets already carry two scope dimensions
(`department_id`, `campus_id`), the identifier model already lists `rfid`, and
the module shell already hosts a module with its own internal navigation.

---

## 2. Existing identity model

### `users`

| Column | Type | Note |
|---|---|---|
| `id` | **TEXT** PK | not an integer — an external id is representable |
| `email` | TEXT **NOT NULL** | |
| `password_hash` | TEXT **NOT NULL** | **every row is an authenticable account** |
| `department` | TEXT **NOT NULL** | **free text, no foreign key** |
| `team` | TEXT | FK `users_team_fkey` |
| `role` | TEXT | CHECK: `super_admin, admin, sub_admin, user, outreach_manager, branding_reports_admin, design_reports_admin, task_owner, task_manager` |
| `status` | TEXT | CHECK: `active, inactive, archived` |
| `managed_by`, `deactivated_at/by/reason` | | |

### `mo_user_profiles`

`user_id, designation, mo_role, color, joined_on, campus_id → mo_campuses,
allowed_modules jsonb, kiosk_pin_hash, kiosk_pin_set_at, kiosk_failed_attempts,
kiosk_locked_until`

`mo_role` CHECK: `admin, team_lead, employee, coordinator`.

### Can this represent the four borrower kinds?

| Kind | Representable today | Evidence |
|---|---|---|
| Employee | **yes** | a `users` row on `team='media'` |
| Faculty | **only as a generic user** | no faculty concept; `designation` is free text |
| Student | **only as a generic user** | no student concept, no enrolment number on `users` |
| External / temporary | **no** | `password_hash NOT NULL` means an account must be issued |

**Stated plainly, as required: student and faculty identity does not exist in
the current schema.** Nothing here invents one.

The two nearest things are `mo_user_profiles.designation` (free text) and
`mo_casting_requests.enrolment_number` (on an applicant record, not a user).

---

## 3. Existing Media Ops roles

Membership resolves through `moRoleOf()` (`server/mediaops-api.ts:67`):

```
super_admin            → 'admin'
team === 'smc'         → 'employee'
team !== 'media'       → null          ← not a Media Ops user at all
otherwise              → mo_user_profiles.mo_role
```

So **Media Ops membership is `users.team = 'media'`**. A student given a Nerve
account would not be a Media Ops user unless placed on the media team — which
would grant them the crew's modules. That is the central tension for §17.

The authorization chain already has **four distinct layers**:

```
requireMedia(res)                      → Nerve role + team membership
  └ requireModule(res, u, 'equipment') → module grant (allowed_modules, or the group default)
      └ canManageEquipment(u)          → isMoAdmin(u) OR equipment_custodian duty
```

`effectiveModules()` reads `mo_user_profiles.allowed_modules` and falls back to
a seeded per-group default; it **fails closed** (returns `[]` for an
unrecognised group).

**There is no scope layer.** Nothing in this chain narrows a permission to a
department, campus, academic unit or inventory.

---

## 4. Existing equipment custody model

| Table | Relevant columns |
|---|---|
| `mo_equipment_items` | `department_id → mo_departments`, `campus_id → mo_campuses`, `category_id`, `vendor_id`, `status`, `condition`, `pool_quantity`, `deleted_at`, `retired_by` |
| `mo_equipment_transactions` | `equipment_item_id`, `booking_id`, **`holder_id NOT NULL → users(id)`**, `action` CHECK `check_out\|check_in`, `quantity`, `condition_noted`, `expected_return_at`, `occurred_at`, `recorded_via` CHECK `desktop\|mobile\|kiosk`, `recorded_by → users(id)` |
| `mo_equipment_bookings` | `user_id → users`, `shoot_id`, `project_id`, `starts_at/ends_at`, `status`, EXCLUDE constraint |
| `mo_maintenance_records` | `reported_by → users`, `resolved_at`, `cost`, `vendor_id` |

Current custody is derived, not stored: the latest transaction per asset by
`(occurred_at DESC, id DESC)`, custody only if that row is a `check_out`
(Phase 4).

### Who can become a holder?

**Any row in `users`, and nothing else.** The foreign key is the whole answer.

| Relationship | Without schema change |
|---|---|
| Employee → Asset | **yes** |
| Custodian → Asset | **yes** (a custodian is a user) |
| Faculty → Asset | **only if issued a Nerve account** |
| Student → Asset | **only if issued a Nerve account** |
| External borrower → Asset | **no** |

The kiosk already separates *who operates the terminal* from *who takes the
asset*: `resolveHolder()` and the kiosk session token name the verified
borrower, and `recorded_by` names the operator. That separation is exactly what
an academic counter needs, and it already exists.

---

## 5. Existing borrower-like structures

No `loan`, `reservation`, `inspection`, `borrow*` or `custod*` table exists —
verified by direct query against `information_schema.tables`.

Two structures model a **person who is not a Nerve user**:

### `mo_casting_requests`

`applicant_name, applicant_email, applicant_type, department, designation,
campus_id, enrolment_number, mobile_phone, location, source` CHECK
`internal|external`, `link_id`, `submitted_ip`, and a consent block:
`consent_given, consent_at, consent_version, consent_text`.

Reusable as a **pattern**, not as a table: it is a casting applicant, and its
columns are casting-specific. What it proves is that Media Ops already accepts
a person via a public link, records who they are and what they consented to,
and reviews them — without issuing an account.

### `mo_requests`

`institute TEXT, academic_unit_id → mo_academic_units, stakeholder, contact,
requester_name, requester_email, contact_phone, status, received_by,
converted_by, converted_at, review_note, first_touched_at, source, link_id,
submitted_ip`.

This is the closest existing thing to a borrower request: an **institute-scoped
request from a non-user, reviewed by a named person and converted**. It
converts to a project, not a loan, so it is not directly reusable — but the
intake → review → conversion shape, and the `institute` + `academic_unit_id`
pair, are already proven in production code.

### `mo_creator_profiles`

A **domain identity layered on a `users` row** — the Creator Network's members
are Nerve accounts with a domain profile, domain role and domain status. This
is the existing precedent for "a distinct population inside Media Ops that is
not the media crew", and it is the closest architectural analogue to a borrower
population.

---

## 6. Existing custodian-like structures

`mo_duty_flags` — `casting_manager, smc_manager, **equipment_custodian**,
report_reviewer, project_manager, kiosk_operator`.

`mo_user_duties` — `user_id, duty_flag_id, granted_by, granted_at`.

`canManageEquipment(u)` = `isMoAdmin(u) OR has the equipment_custodian duty`.

**A duty is global.** There is no `department_id`, `campus_id` or inventory
column on `mo_user_duties`, so "Equipment Custodian" means *of everything*.

The desired concept — `Inventory Scope → Custodian → Assets` — has **no
existing representation**. The pieces that exist:

- the duty mechanism (who is responsible, granted by whom, when),
- two scope dimensions on the asset (`department_id`, `campus_id`).

What is missing is the **link between them**. Nothing today says "this person is
responsible for these assets".

---

## 7. Organizational scope model

| Table | Rows today | Meaning |
|---|---|---|
| `mo_departments` | 3 — Media Crew, Content Team, Outreach | **Media Ops internal departments** |
| `mo_campuses` | 2 — Vadodara (VAD), Rajkot (RJK) | physical campuses |
| `mo_academic_units` | Faculty of Design, Engineering, Medicine, … (FK `department_id`) | university faculties |

`mo_equipment_items` carries **both** `department_id` and `campus_id`, both
nullable. So an asset already has two independent scope axes.

### How might PID and 24 Frames be represented?

Trade-offs only — **not ranked**, and nothing was created.

**A. As departments** (`mo_departments`). The asset already has
`department_id`, and equipment read models already filter on it, so this needs
no schema change at all. Against: `mo_departments` currently means *Media Ops
internal team*, and Media Crew / Content Team / Outreach sit in the same list —
mixing an institute with an internal team changes what the table means, and
`users.department` is free text with no FK to it, so the two would drift.

**B. As an inventory** (a new concept). Cleanly separates "which stock is this"
from "which team are you on", and is the only option that gives the custodian
something to be custodian *of*. Against: it is a new entity, and every existing
equipment filter is written against `department_id`.

**C. As a location.** `mo_campuses` exists and assets already carry
`campus_id`. Good for "where is the cupboard". Against: PID and 24 Frames are
not campuses — both could sit on the same campus — so this axis cannot
distinguish them.

**D. As an organizational unit** (`mo_academic_units`). Already exists, already
holds *Faculty of Design*, already has a `department_id` FK, and already
appears on `mo_requests.academic_unit_id`. Against: 24 Frames Studios is a
studio, not a faculty; and this table's `department_id` points at a Media Ops
department, which is an odd inversion to build on.

**E. A combination** — for example an inventory that *references* a department,
campus and/or academic unit rather than being one. Against: more moving parts
before anyone has asked for them.

**What the architecture already supports:** A and C need no schema change. D
needs no schema change but is a semantic stretch for 24 Frames. B and E require
a new entity.

---

## 8. Authorization model

| Concept | Exists today | As what |
|---|---|---|
| Media Ops Master Admin | **yes** | `mo_role='admin'`, or Nerve `super_admin` |
| Asset/Inventory Admin | **partly** | `canManageEquipment` = admin or custodian duty; not a distinct role |
| Inventory Custodian | **yes, unscoped** | `equipment_custodian` duty |
| Inventory Manager | **no** | no such concept |
| Borrower | **no** | any Media Ops user with the `equipment` module may check out |
| Requester | **no** | there is no equipment request at all |

The existing model has module grants, duty flags and fail-closed defaults. It
does **not** have scope. Everything Academic Inventory needs beyond a custodian
is a *scope relationship*, not a new role — which means the existing
module/duty model can carry it **if** a scope link is added; it cannot carry it
as it stands.

---

## 9. Accountability model

`mo_audit_logs`: `actor_id, actor_role, action, entity_type, entity_id, before
jsonb, after jsonb, ip, user_agent, occurred_at` — a generic record for
anything routed through `audit()`.

| Question | Answered today | By what |
|---|---|---|
| WHO requested? | **no** | no request concept |
| WHO approved? | **no** | no approval concept for equipment |
| WHO issued? | **yes** | `mo_equipment_transactions.recorded_by` + `recorded_via` |
| WHO physically holds it? | **yes** | `holder_id`, and the derived custody read model |
| WHO returned it? | **yes** | the `check_in` row's `holder_id` / `recorded_by` |
| WHO inspected it? | **no** | no inspection concept; `condition_noted` records *what*, not *who inspected* |
| WHO recorded damage? | **yes** | `mo_maintenance_records.reported_by` |
| WHO closed the transaction? | **partly** | check-in closes the loan, and `recorded_by` names the actor; there is no separate closure step |

Four of eight are answered by the ledger, one partly. The missing four —
request, approval, inspection, closure — are all *workflow states that do not
exist*, not identities that are missing.

---

## 10. QR / RFID compatibility

`mo_asset_identifiers`: `asset_id, kind, value, is_primary, is_active,
created_at, created_by, retired_at`, with

```sql
CHECK (kind = ANY (ARRAY['asset_tag','qr','barcode','serial','rfid','internal']))
```

**`rfid` is already an allowed kind.** An RFID tag is a row, not a migration —
which is what Phase 0 designed it for.

Every identifier hangs off `asset_id`. **There is no identifier table for
people**, and nothing in the QR or kiosk path reads a borrower from a code: the
kiosk resolves the borrower through a PIN-verified session, and the QR encodes
an opaque asset token carrying no mutable business data.

**The principle holds as stated: QR/RFID identifies the asset, never the
borrower.** Academic Inventory needs no second identifier system.

---

## 11. Minimum future domain model

Proposed **conceptually**. Nothing was created. Each entry states why an
existing table cannot carry it.

### Likely required

**Inventory scope** — *what a custodian is custodian of, and which stock an
asset belongs to.*
Existing tables cannot express it: `mo_departments` means an internal team,
`mo_campuses` means a place, `mo_academic_units` means a faculty. Could
plausibly be represented by `department_id` (option A, §7) at the cost of
overloading that table's meaning.
Would own: name, the organisational unit(s) it maps to, active state.

**Custodian assignment** — *this person is responsible for that scope.*
`mo_user_duties` cannot: it has no scope column. This is the single clearest
structural gap in the audit.
Would own: user, scope, granted_by, granted_at.

**Borrower identity** — *a student or faculty member who may hold an asset.*
`users` cannot represent one without issuing an account (`password_hash NOT
NULL`); `mo_casting_requests` is casting-specific. **Whether this is needed at
all depends on §17 Q1** — if students already have Nerve accounts, this
collapses into a profile on `users`, exactly as `mo_creator_profiles` does.
Would own: the link to a user (or the standalone person), type, enrolment/staff
identifier, active state.

### Required only if the workflow is adopted

**Loan request** and **approval** — the workflow diagram has both, and neither
exists for equipment. `mo_requests` is the right *shape* but the wrong domain.
A request would own: borrower, asset or category, window, purpose, status,
requested_at. Approval would own: decision, decided_by, decided_at, reason.

Whether these are two entities or one with a status field is an
implementation choice, not an architectural one.

### Probably NOT required

**Reservation** — `mo_equipment_bookings` already reserves an asset for a date
range, enforced by a database EXCLUDE constraint, with a project/shoot link and
a status vocabulary. An approved request should very likely *become* a booking
rather than a new table.

**Inspection** — check-in already records `condition_noted` and auto-opens a
damage report on a condition drop (BR-8). What is missing is only *who
inspected*, which is a column-shaped gap, not an entity-shaped one.

**Custody ledger** — exists, is append-only, and must not be duplicated.

---

## 12. Existing APIs reusable

| Need | Existing endpoint |
|---|---|
| assets, with derived state | `GET /equipment`, `GET /equipment/:id` |
| identifier resolution (QR/RFID) | `GET /equipment/resolve/:identifier` |
| who holds what | `GET /equipment/custody` |
| reservations | `GET /equipment/bookings`, `POST /equipment/bookings` |
| date-range availability | `GET /equipment/availability` |
| the ledger | `GET /equipment/transactions` |
| repairs | `GET /equipment/maintenance` |
| charts | `GET /equipment/analytics` |
| issue / return | `POST /equipment/:id/checkout`, `/checkin` |
| kiosk identity | `POST /equipment/kiosk/session/*` |
| policy | `GET /equipment/rules` |
| people, departments, campuses, academic units | the existing admin CRUD surface |
| audit | `audit()` into `mo_audit_logs` |
| notifications | `mo_notifications` + the automation engine |

Every one of these is behind `requireEquipment` and would remain so.

---

## 13. Future API boundaries

Borrower and custodian endpoints would belong **inside the existing equipment
surface**, under `/equipment/*`, not in a parallel namespace — the same
decision Phase 6 made when it declined a second analytics endpoint.

The boundary that matters: **scope must be applied inside the existing read
models**, as another filter alongside `department_id` and `category_id`, rather
than by adding a second set of endpoints that answer the same questions for a
different population. A `GET /academic/equipment` would be the beginning of a
second asset system.

---

## 14. Future UI boundaries

The nav registry is a flat list of groups and items (`{group:'Assets', items:[…
{r:'#/media/equipment', …}]}`), each gated by `moduleAllowed(hashModule(it.r))`
— the module is derived from the route's first segment.

Two consequences:

1. A route such as `#/media/equipment/academic/pid` derives the module
   `equipment`, so **Academic Inventory can live inside the existing module
   grant** without a new module key. A separate key (e.g.
   `academic-inventory`) is equally possible via `MODULE_DEFAULT_SEED`.
2. **The shell already supports a module with its own internal navigation** —
   the Creator Network does exactly this (`CN_NAV`, `creatorNavHtml()`,
   `cnRoute()`), added in the Creator Network phase. Academic Inventory scoped
   within Asset & Inventory is the same pattern, already proven.

No navigation redesign is required, and none was made.

---

## 15. Security considerations

| Risk | Today |
|---|---|
| forged `borrower_id` | **n/a** — no borrower concept |
| forged `holder_id` | **prevented** — `resolveHolder()` refuses a client-supplied holder unless the caller is a custodian/admin or holds a verified kiosk session |
| self-approval | **n/a** — no approval step exists |
| custodian approving own request | **n/a**, and **would need an explicit control** |
| cross-inventory access | **NOT prevented** — there is no inventory scope; any Media Ops user with the `equipment` module sees every asset |
| cross-department access | **NOT prevented** — `department_id` is a filter, never a gate |
| inactive borrower | **partly** — `users.status` exists; no check on it in the checkout path |
| inactive custodian | **not checked** — the duty has no expiry and is not re-validated |
| unauthorized checkout | **prevented** — `requireEquipment`, plus BR-7 and the unserviceable rule |
| unauthorized return | **prevented** — only the holder, a custodian or an admin may check in |
| reservation conflicts | **prevented in the database** — `EXCLUDE USING gist`, including under concurrency |
| historical record mutation | **partly** — the ledger is append-only *by convention*; no grant revokes UPDATE/DELETE |

The two that would need explicit new controls for Academic Inventory are
**cross-inventory access** and **custodian self-approval**. Both follow from the
missing scope layer rather than from any defect in what exists.

---

## 16. Gaps

1. No student or faculty identity (§2).
2. A holder must be an authenticable account (§4).
3. A custodian cannot be scoped (§6).
4. No inventory scope on anything (§7).
5. No equipment request or approval (§9).
6. No record of *who inspected* a return (§9).
7. No cross-scope authorization gate (§15).

Everything else Academic Inventory needs — assets, identifiers including RFID,
reservations with conflict protection, custody, the ledger, maintenance,
notifications, audit, the module shell — **already exists and should not be
rebuilt.**

---

## 17. Decisions required

These cannot be answered from the repository.

1. **Do students and faculty already have Nerve accounts?** Everything else
   depends on this. If yes, a borrower is a profile on `users` (the
   `mo_creator_profiles` pattern) and gaps 1–2 largely close. If no, a decision
   is needed on whether to issue accounts or to represent a borrower who has
   none — which the current `holder_id` foreign key forbids.
2. **Are PID and 24 Frames inventories, departments, locations, academic units,
   or a combination?** §7 lays out what each costs; the repository cannot choose.
3. **Must a borrower be an authenticated Nerve user?** This is the same question
   as 1 seen from the accountability side: an unauthenticated borrower cannot
   currently appear in the ledger at all.
4. **Do external borrowers exist** — visiting faculty, alumni, vendors?
5. **Who approves a loan** — custodian, faculty, department head, nobody?
   Whether an approval step exists at all is a product decision; there is none
   today.
6. **Is a custodian assigned per inventory or per asset?** The duty mechanism
   suggests per scope; nothing in the data suggests per asset.
7. **May a borrower hold several assets at once?** The ledger allows it; BR-7
   blocks a *new* checkout only when the borrower is ≥7 days overdue.
8. **Do students and faculty follow the same approval workflow?** If they
   differ, borrower type becomes a workflow input rather than a label.
9. **Is Academic Inventory visible to the media crew, and vice versa?** This is
   the cross-scope question in §15, and it determines whether scope is a filter
   or a gate.

---

## 18. Recommended implementation sequence

A **dependency order**, not a ranking. Each stage is blocked by the one before,
and only stages this audit found evidence for are listed.

```
1. Identity confirmation              ← blocked on decision 1 and 3
      ↓                                 nothing below can be designed until it is known
                                        whether a borrower is a users row
2. Inventory scope                    ← blocked on decision 2
      ↓                                 the thing a custodian is custodian of, and the
                                        dimension every later gate filters on
3. Custodian relationship             ← needs 2; the only clear structural gap (§6)
      ↓
4. Borrower relationship              ← needs 1; a profile on users, or a person record
      ↓
5. Scope authorization                ← needs 2, 3, 4; turns the filter into a gate (§15)
      ↓
6. Request                            ← needs 4; only if decision 5 says a request exists
      ↓
7. Approval                           ← needs 6 and decision 5
      ↓
8. Reservation                        ← REUSE mo_equipment_bookings; an approved request
      ↓                                 becomes a booking rather than a new table
9. Checkout / custody / return        ← ALREADY EXISTS; needs only the scope gate from 5
      ↓
10. Inspection                        ← needs 9; a "who inspected" record, not an entity (§11)
```

Stages 8 and 9 are mostly **reuse**, not construction. Stage 5 is where most of
the real work sits, because it is the layer the current authorization chain does
not have.

Nothing beyond stage 1 can be specified until decisions 1–3 in §17 are answered.
