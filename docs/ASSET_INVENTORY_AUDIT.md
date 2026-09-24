# Asset & Inventory Management — Existing Equipment Audit

**Audit date:** 2026-09-21 · **Branch:** `media-tv-dashboard` · **Scope:** read-only.
Nothing in the repository was modified to produce this document.

---

## 1. Executive Summary

Nerve already has an Equipment module. It is roughly **70% of a schema, 30% of a
backend, and a very convincing front end**. That gap is the single most important
finding, and it shapes every recommendation below.

**The schema is genuinely good.** Eight tables already model individual asset
identity, categories, vendors, kits, bookings, an append-only transaction ledger
and maintenance records. `mo_equipment_items` carries `asset_tag UNIQUE NOT NULL`,
`qr_uid UNIQUE`, `barcode`, `serial_no`, `department_id`, `campus_id`, purchase and
warranty and insurance fields, a six-state status and a soft delete. Bookings carry
a **PostgreSQL `EXCLUDE USING gist` constraint** that makes overlapping reservations
of one item impossible at the database level. Somebody thought carefully about this.

**The backend barely uses it.** There are six equipment endpoints. There is no
`GET`, no `PATCH`, no `DELETE` for an equipment item — reads happen only through a
bulk `/state` dump, and there is no way to edit or retire an item through the API at
all. Five of the six endpoints have **no module gate and no capability check**: they
ask only "are you Media Crew?". `pool_quantity` is declared and never read by any
line of code in the repository.

**The front end shows features the backend does not have.** The "QR label" dialog
renders a deterministic checkerboard from `(i*7 + e.id*13) % 3`, encodes nothing, and
offers a **Print label** button. The kiosk asks for a PIN and accepts any four digits
without checking them against anything. The Equipment page states "AUTO-3 escalation:
holder → custodian → TL/Admin at 3 days. New checkouts blocked at 7 days (BR-7)";
the server notifies the holder once and implements neither the escalation nor the
block. Business rules that read as enforcement — BR-7, BR-8 — live in the browser.

**Test coverage of equipment write paths is zero.** Out of 983 tests in the
repository, not one calls any of the six equipment endpoints.

**The honest summary:** the Equipment module is a well-designed prototype that was
wired to a real database for its happy path and never finished. It is a good
foundation to build on and a bad thing to trust. Phase 1 should be hardening what
exists, not adding features on top of it.

---

## 2. Existing Equipment Architecture

```
public/media-ops/index.html          single-file vanilla-JS SPA (~18,900 lines)
  DB.equipment_items[]  ────────┐    client-side arrays, the UI's only data source
  DB.equipment_bookings[]       │
  DB.equipment_transactions[]   │
  DB.maintenance_records[]      │
                                │
  ACTIONS.checkout()  ──────────┤    1. mutate DB.* optimistically
  ACTIONS.confirmCheckin()      │    2. render()
  ACTIONS.cancelBooking()       │    3. moSync(MO_API.post(...))  ← fire and forget
  commitKiosk()                 │
                                ▼
server/mediaops-api.ts          GET  /state         ← 60+ unfiltered table dumps
                                POST /equipment                (create only)
                                POST /equipment/bookings
                                POST /equipment/bookings/:id/cancel
                                POST /equipment/:id/checkout
                                POST /equipment/:id/checkin
                                POST /equipment/:id/damage
                                ▼
server/mediaops-db.ts           8 tables, btree_gist EXCLUDE on bookings
```

The controlling pattern is **optimistic local mutation followed by an unverified
sync**. [`moSync()`](../public/media-ops/index.html) awaits the POST, re-hydrates from
`/state` and re-renders; on failure it toasts "Server rejected this change —
reverting" and re-hydrates. This is a reasonable pattern, but it means **the client's
rules and the server's rules can differ silently** whenever both implement the same
rule differently. They do. See §12.

---

## 3. Existing UI

**Route:** `#/media/equipment` → `viewEquipment()`; `#/media/equipment/:asset_tag` →
`viewEquipmentItem()`.

**Eight tabs**, all rendered from client arrays, all client-side filtered and sorted,
none paginated:

| Tab | Renderer | Backed by a real endpoint? |
|---|---|---|
| Catalog | `eqCatalog()` | read from `/state` only |
| Availability | `eqAvailability()` | computed client-side |
| Bookings | `eqBookings()` | create + cancel exist |
| My items | `eqMine()` | computed client-side |
| Transactions | `eqTransactions()` | read from `/state` only |
| Maintenance | `eqMaintenance()` | create only (`/damage`) |
| Kits | `eqKits()` | **no endpoint at all** |
| Analytics | `eqAnalytics()` | computed client-side |

**Header actions:** Kiosk mode, Book (`B`), Add item (gated `can('equipment.manage')`).
**Item detail actions:** Check out, Check in, Book, QR label, Report damage.

### Verified against the backend

| UI feature | Reality |
|---|---|
| Add item | **Real.** `POST /equipment`. |
| Edit item | **Does not exist** in UI or API. |
| Delete / retire / mark lost | **Does not exist** in UI or API. `deleted_at`, `retired` and `lost` are unreachable. |
| Check out | Real, but the client's BR-7 guards are not enforced server-side. |
| Check in | Real, but the damage rule differs from the server's. |
| Book | Real, and genuinely protected by the DB constraint. |
| Cancel booking | Real, but **no ownership check** server-side. |
| Report damage | Real. |
| Kits | **Read-only fiction.** No create/edit/assign endpoint. |
| QR label | **Fake.** A generated checkerboard with a Print button. |
| Kiosk | **Real transactions, fake authentication.** |
| Overdue escalation | **Partly fiction.** See §13. |
| Categories | Real, via the generic lookup CRUD engine. |
| Locations | **No model exists.** Only `campus_id`. |
| Attachments | Only `photo_url`, never written by any endpoint. |

---

## 4. Existing Database

Eight tables, all in [`server/mediaops-db.ts`](../server/mediaops-db.ts) §11.5.

### `mo_equipment_items` — the asset registry

`id` · `department_id`→`mo_departments` · `campus_id`→`mo_campuses` ·
`category_id`→`mo_equipment_categories` NOT NULL · **`asset_tag TEXT UNIQUE NOT NULL`** ·
**`qr_uid TEXT UNIQUE`** · `barcode TEXT` · `make` · `model` · `serial_no` ·
`purchase_date` · `purchase_cost NUMERIC(12,2)` · `vendor_id` · `warranty_until` ·
`insurance_policy_no` · `insurance_until` ·
`condition CHECK (excellent|good|fair|poor)` ·
`status CHECK (available|checked_out|booked|maintenance|retired|lost)` ·
`pool_quantity INTEGER` · `photo_url` · `notes` · `deleted_at TIMESTAMPTZ`.

Index: `idx_mo_equip_status (category_id, status)`.

**No `created_at` / `updated_at`.** Unusual for this codebase and a real gap for an
asset register — there is no way to ask when a row was first created or last touched.

### `mo_equipment_bookings` — reservations

`equipment_item_id` NOT NULL ON DELETE CASCADE · `user_id` NOT NULL →`users` ·
`shoot_id` · `project_id` · `starts_at DATE` · `ends_at DATE` ·
`status CHECK (reserved|active|completed|cancelled)` · `created_by`.

```sql
EXCLUDE USING gist (
  equipment_item_id WITH =,
  daterange(starts_at, ends_at, '[]') WITH &&
) WHERE (status IN ('reserved','active'))
```

This is the strongest thing in the module. Backed by `btree_gist`, created in
[`mediaops-db.ts:33`](../server/mediaops-db.ts) with a fatal error if unavailable.

**Granularity is `DATE`, not `TIMESTAMPTZ`** — a morning and an afternoon booking of
one camera on one day is impossible to express. For a studio this will matter.

### `mo_equipment_transactions` — the custody ledger

`equipment_item_id` NOT NULL · `booking_id` · `holder_id` NOT NULL →`users` ·
`action CHECK (check_out|check_in)` · `quantity` · `condition_noted` ·
`expected_return_at DATE` · `occurred_at TIMESTAMPTZ` ·
`recorded_via CHECK (desktop|mobile|kiosk)` · `recorded_by`.

Index: `(equipment_item_id, occurred_at DESC)`.

Append-only **by convention** — nothing revokes UPDATE or DELETE, and there is no
`created_at` distinct from `occurred_at`, so a backdated row is indistinguishable
from a real one.

### `mo_maintenance_records`

`equipment_item_id` NOT NULL · `kind CHECK (maintenance|repair|damage_report)` ·
`description` · `cost` · `vendor_id` · `reported_by` · `started_at` · `resolved_at` ·
`next_due_at`. **No resolver, no status, no severity, no attachment.**

### `mo_equipment_categories`, `mo_vendors`, `mo_equipment_kits`, `mo_kit_items`

Categories carry `department_id`, `name`, **`tracking_mode CHECK (individual|pooled)`**,
`icon`, `sort_order`, plus `is_active`/`archived_at`/`created_by`/`created_at`/
`updated_at` added by the generic config migration at
[`mediaops-db.ts:812`](../server/mediaops-db.ts). Kits are `(id, name, description,
is_active)` with a `(kit_id, equipment_item_id)` join table and **no code that reads
either**.

### Individual identity vs. quantities

**Individual, with a pooled mode declared and never implemented.** Every item is one
row with a unique `asset_tag`. `tracking_mode='pooled'` is settable in Settings and
displayed as a chip; `pool_quantity` appears **once in the entire repository**, in the
`CREATE TABLE`. No endpoint writes it and no view reads it. Treat pooled tracking as
**not implemented**, not as a half-built feature.

---

## 5. Existing APIs

All under `${P}` = `/api/v1/media`. `requireMedia(res)` means *any* user with a Media
Ops role — it does not check modules, capabilities or duties.

| # | Method · Path | Authorization | Module gate | Audit | Notify |
|---|---|---|---|---|---|
| 1 | `POST /equipment` | `requireMedia` + Admin\|TL | ✅ `equipment` | `equipment.added` | — |
| 2 | `POST /equipment/bookings` | `requireMedia` only | ❌ | `equipment.booked` | — |
| 3 | `POST /equipment/bookings/:id/cancel` | `requireMedia` only | ❌ | `equipment.booking_cancelled` | — |
| 4 | `POST /equipment/:id/checkout` | `requireMedia` only | ❌ | `equipment.checked_out` | — |
| 5 | `POST /equipment/:id/checkin` | `requireMedia` only | ❌ | `equipment.checked_in` | — |
| 6 | `POST /equipment/:id/damage` | `requireMedia` only | ❌ | `equipment.damage_reported` | — |

Plus: `GET /state` (bulk read), the generic lookup CRUD for `equipment_categories`,
and a **side-write** inside work assignment
([`mediaops-api.ts:1653`](../server/mediaops-api.ts)) that inserts bookings for a new
shoot.

### Findings

**No read, update or delete endpoints.** Equipment is readable only by downloading
every row of every table via `/state`, and an item can never be edited or retired
once created. `status` values `retired` and `lost` are unreachable through the API.

**Validation gaps.**
- `#2` validates dates and the 30-day cap (VR-8) but **never checks the item exists**
  or is not retired/lost — it relies on the FK.
- `#3` does not check the booking exists, its status, or who owns it. It returns
  `{ok:true}` for a nonexistent id.
- `#4` checks only `status === 'checked_out'`. An item in `maintenance`, `retired` or
  `lost` can be checked out through the API; only the browser refuses.
- `#5` **never checks the item was checked out.** Checking in an available item
  writes a spurious ledger row and completes bookings.
- `#6` accepts any item id and forces `status='maintenance'`.

**Silent failure.** The shoot-creation booking side-write ends in
`.catch(() => {/* clashes surface via AC-7 */})`. The error is discarded: the user is
told the shoot was created with its equipment, and the booking may never have
happened.

**Asset tag generation is unsafe.**
```js
const n = (await pool.query(`SELECT COUNT(*)::int c FROM mo_equipment_items WHERE category_id=$1`)).rows[0].c + 1;
const tag = `EQ-${prefix}-${String(n).padStart(3,'0')}`;
```
`COUNT(*)` includes soft-deleted rows but not concurrency. Two simultaneous creates
in one category produce the same tag and one fails on the UNIQUE constraint; the
counter is also not monotonic across deletions. There is no retry.

**`qr_uid` is derived, not random:** `QR-${tag}`, which is `EQ-CAM-001` → `QR-EQ-CAM-001`.
Fully guessable. Fine as a printed tag, unusable as a capability token.

**`department_id` and `campus_id` are hardcoded to `1`** in the INSERT. Every asset
created through the API belongs to department 1, campus 1, regardless of anything.

**N+1:** the shoot side-write loops one INSERT per item. `/state` executes 60+
full-table SELECTs sequentially in a `for` loop.

---

## 6. Existing Permissions

Three capabilities exist, defined **only in the browser** at
[`index.html:2392`](../public/media-ops/index.html):

```js
'equipment.book':      {employee:'S', team_lead:'S', admin:'S', coordinator:'S'},
'equipment.manage':    {employee:'CUSTODIAN', team_lead:'-', admin:'A'},
'equipment.analytics': {employee:'-', team_lead:'A', admin:'A'},
```

`CUSTODIAN` resolves to `hasDuty('equipment_custodian')`, backed by real tables
(`mo_duty_flags`, `mo_user_duties`, seeded at
[`mediaops-db.ts:2342`](../server/mediaops-db.ts)). **The server never consults the
duty for equipment.**

### Who can actually do what

| Action | UI allows | **API allows** |
|---|---|---|
| View equipment | anyone with the `equipment` module | **any Media Ops user** (`/state` ships it regardless of module) |
| Create | Admin, or Custodian | Admin **or Team Lead** |
| Edit | nobody | nobody |
| Delete / retire | nobody | nobody |
| Check out | any user, BR-7 guards applied | **any Media Ops user**, no guards, **any `holder_id`** |
| Check in | holder or manager | **any Media Ops user**, any item |
| Book | any user | **any Media Ops user** |
| Cancel booking | own booking, or manager | **any Media Ops user, any booking** |
| Change status | via checkout/checkin/damage | same, unguarded |
| View history | anyone | anyone |

**Two concrete inconsistencies.**

1. `equipment.manage` is `-` for `team_lead`, so the UI hides Add item from a Team
   Lead and, if reached, the handler toasts **"Team Lead or Admin only"** — a message
   that contradicts the rule that just blocked them. The API meanwhile *does* accept
   Team Leads. UI and API disagree about who may create equipment.

2. Module revocation does not work for equipment. Only `POST /equipment` calls
   `requireModule(res, u, "equipment")`. Removing the module hides the sidebar entry
   and leaves booking, cancelling, checkout, check-in and damage fully callable —
   the same class of bug that was found and fixed in the Creator Network.

---

## 7. Existing Project Integration

**One link exists:** `mo_equipment_bookings.project_id → mo_projects(id)`, plus
`shoot_id → mo_shoots(id)`. That is the whole of it.

There is **no** project equipment allocation table, no "Add Equipment" control on a
project page, no equipment list in the project view, and no equipment cost rollup.
`project_id` is populated in exactly one place — the shoot-creation side-write, which
copies the shoot's project onto the booking.

**Traced end to end:** Assign Work → `POST /work` with `body.equipment[]` → loop of
`INSERT INTO mo_equipment_bookings (…, shoot_id, project_id, …)` → errors swallowed.
There is no UI anywhere that reads bookings back by `project_id`.

---

## 8. Existing QR / Barcode Capability

**None.** `qr_uid` and `barcode` are the only matches in the entire repository for
`qrcode|barcode|getUserMedia|BarcodeDetector|jsQR|scanner`. There is:

- no QR generation library,
- no QR rendering,
- no camera access anywhere in the codebase,
- no scan endpoint, no asset-token lookup, no public asset URL.

The **"QR label" dialog is a fabrication**:

```js
${Array.from({length:121},(_,i)=>{const on=(i*7+e.id*13)%3!==0; …})}
```

A deterministic 11×11 checkerboard derived from the row id. It is not a QR code, it
encodes nothing, and the dialog offers **Print label**. Any labels already printed
and stuck to equipment are unreadable by any scanner. This should be treated as a
correctness bug, not a missing feature.

The kiosk's "Scan item QR" step is a filtered list of clickable items.

**Reusable:** the `qr_uid UNIQUE` column and the `#/media/equipment/:asset_tag` route.
Nothing else.

---

## 9. RFID Readiness

**PARTIALLY READY.**

**In favour:** every asset is a row with immutable individual identity and a unique
tag; `mo_equipment_transactions` is already an event ledger with a `recorded_via`
enum, which is the natural place for a reader-sourced event; `btree_gist` is enabled.

**Against:** identifiers live as columns *on the item* (`asset_tag`, `qr_uid`,
`barcode`), so each new identifier type is another column and another UNIQUE index —
there is no identifier table. There is no reader, location or scan-event concept;
`recorded_via` is a closed CHECK that would need altering. There is no location model
at all, so `reader_location` has nothing to point at. Transactions have no
idempotency key, and an RFID portal emitting repeated reads needs one.

The clean evolution is an `mo_asset_identifiers` table (`asset_id`, `kind`, `value`,
`is_active`) rather than more columns. Do not add `rfid_*` fields to
`mo_equipment_items`.

---

## 10. Current User / Custodian Model

**Holder is a proper foreign key**, not free text:
`holder_id TEXT NOT NULL REFERENCES users(id)`. Good.

**It cannot distinguish the people the future system needs to serve.** `users.role`
is `super_admin|admin|sub_admin|user|outreach_manager|branding_reports_admin|
design_reports_admin|task_owner|task_manager` and `users.team` is a team FK. There is
**no faculty, no student, no external borrower**. Every holder must be a Nerve user
account, so lending a lens to a design student is currently unrepresentable.

**Custodian** exists as a duty flag (`equipment_custodian`) with real tables, consulted
only by the browser.

**`holder_id` is caller-supplied and unvalidated:**
```js
const holder = toUid(b.holder_id) ?? u.id;
```
`toUid` maps a number to `mo-u{n}` and otherwise passes the string through. Any Media
Ops user can check an item out to **any user id in Nerve**.

**Check-in records the wrong person.** The check-in endpoint writes
`holder_id: u.id` — whoever pressed the button, not who held the item. When a
custodian receives equipment back from a colleague, the ledger says the custodian had
it. Custody history cannot be reconstructed reliably from the ledger today.

---

## 11. Existing Booking Capability

The best-implemented part of the module.

**Database-level conflict protection is real** and was verified by reading the
constraint and its error path: the API catches SQLSTATE `23P01` and returns
`409 AC-7: this item is already booked for overlapping dates`. This is not frontend
validation — concurrent requests cannot both succeed.

**Limits:** `DATE` granularity only (no intra-day slots); 30-day cap (VR-8); the
`booked` item status is computed client-side by `trgEquipStatus()` and never written
by the server; cancellation is unauthenticated beyond "is Media Crew"; there is no
approval workflow, no waitlist, no recurring booking, and no check that the booked
item is serviceable.

---

## 12. Existing Check-in / Check-out

Both write to the transaction ledger and update item status. Both work. Both diverge
from the client.

**BR-8 is implemented twice, differently:**

| | Client | Server |
|---|---|---|
| Rule | condition **dropped** vs. checkout condition | condition **is `fair` or `poor`** (absolute) |
| `excellent` → `good` | damage report opened | no damage; item `available` |
| `fair` → `fair` | no damage | damage report opened; item `maintenance` |

Because `moSync()` re-hydrates from `/state` after the POST, **the server wins and
the user's screen changes under them**. The client also never sends the `damaged`
flag, so the server's `b.damaged === true` branch is dead code from this UI.

**BR-7 is client-only.** "Blocked — you hold an item ≥ 7 days overdue" and "item is
maintenance/retired/lost" are both in `ACTIONS.checkout`. The endpoint enforces
neither.

**Check-in completes every active booking for the item** regardless of who held it:
`UPDATE mo_equipment_bookings SET status='completed' WHERE equipment_item_id=$1 AND status='active'`.

**The kiosk is an authentication hole.** `openKiosk()` is reachable from the Equipment
page by any user; the PIN pad advances on **any four digits**
(`if(S.kiosk.pin.length>=4){S.kiosk.step=2;}`) with no verification against anything;
and `commitKiosk()` then checks out to `S.me` — the signed-in session, not the person
who typed the PIN. The prompt "Scan your badge or enter your Nerve PIN" describes a
mechanism that does not exist.

---

## 13. Existing Maintenance / Damage

A single flat table and one endpoint. A record can be opened (by check-in, or by
`POST /equipment/:id/damage`) and **can never be resolved** — `resolved_at` and
`next_due_at` are written by no code path. An item put into `maintenance` therefore
**cannot be returned to service through the API at all**; only a check-in with a good
condition will flip it back, which is not what a repair is.

No severity, no assignee, no cost tracking in practice, no attachments, no inspection
concept, no link to a vendor work order.

---

## 14. Existing Audit Trail

Two separate things share the name.

**Server-side** `audit()` writes to `mo_audit_logs` for all six endpoints:
`equipment.added`, `equipment.booked`, `equipment.booking_cancelled`,
`equipment.checked_out`, `equipment.checked_in`, `equipment.damage_reported`. Real,
and reasonable coverage of the write paths that exist.

**Client-side** `audit()` writes to a local array for the prototype and is not
persisted.

Against the target event vocabulary:

| Event | Status |
|---|---|
| `asset_created` | ✅ `equipment.added` |
| `asset_reserved` | ✅ `equipment.booked` |
| `asset_checkout` | ✅ `equipment.checked_out` |
| `asset_return` | ✅ `equipment.checked_in` |
| `asset_damaged` | ✅ `equipment.damage_reported` |
| `asset_assigned` | ❌ no assignment concept |
| `asset_released` | ❌ |
| `asset_repaired` | ❌ unreachable |
| `asset_maintenance` | ⚠️ only as damage |
| `asset_location_changed` | ❌ no location model |
| `asset_status_changed` | ⚠️ implied, never explicit |
| `asset_retired` | ❌ unreachable |

The ledger and the audit log overlap without either being authoritative. A future
design should pick one.

### Automations

Only **AUTO-3** touches equipment, at
[`mediaops-api.ts:10865`](../server/mediaops-api.ts): for each checked-out item past
`expected_return_at`, notify **the holder**. That is all. The UI's claim of
"holder → custodian → TL/Admin at 3 days" and "new checkouts blocked at 7 days" is
not implemented anywhere on the server.

---

## 15. Existing Tests

**Zero equipment endpoint coverage.** No test in the repository issues a request to
any of the six endpoints. The only equipment references in tests are incidental:

| File | What it does |
|---|---|
| `mediaops-crew-lifecycle.integration.test.ts` | `INSERT`s a transaction row directly to prove deactivation preserves history |
| `mediaops-tv-access.test.ts` | asserts category names are not personal data |
| `ai-user-context.integration.test.ts` | asserts the `equipment.read` AI capability follows the module |

Nothing tests the booking EXCLUDE constraint, checkout, check-in, BR-7, BR-8, the
kiosk, overdue, asset tag generation or any authorization rule.

**Suite result (unchanged by this audit):** 983 tests, **973 passed, 10 failed**. All
10 failures are in `server/mediaops-creator-payouts.integration.test.ts` and are
unrelated to equipment — `.env.local` points `DATABASE_URL` at the **dev** database
`nerve` rather than `nerve_test`, so that suite collides with demo seed data (an
open-ended payout rule "Standard 2026-27" causes a 409). Verified identical with all
working-tree changes stashed.

---

## 16. Security Findings

Severity assumes an authenticated Media Ops user acting in bad faith or by accident.

| # | Finding | Severity |
|---|---|---|
| S1 | **Forged holder.** `POST /equipment/:id/checkout` accepts any `holder_id`, unvalidated beyond the FK. Any user can make the record say a colleague took a ₹2,00,000 camera. | **High** |
| S2 | **Module gate missing on 5 of 6 endpoints.** Revoking the `equipment` module hides the UI and leaves booking, cancelling, checkout, check-in and damage callable. | **High** |
| S3 | **Kiosk authentication is cosmetic.** Any four digits pass; the transaction is attributed to the signed-in session. An unattended kiosk tablet is an open terminal. | **High** |
| S4 | **Booking-cancel IDOR.** No ownership or existence check — any user can cancel any booking, including one made for a shoot tomorrow. | **Medium** |
| S5 | **Availability denial of service.** `POST /equipment/:id/damage` lets any user force any item to `maintenance`, and nothing can move it back. | **Medium** |
| S6 | **Custodian duty is frontend-only.** `equipment.manage` = `CUSTODIAN` is never checked server-side. | **Medium** |
| S7 | **Unverified check-in.** Any user can check in any item, writing a false ledger row and completing others' bookings. | **Medium** |
| S8 | **BR-7 bypass.** Overdue-holder blocking and maintenance/retired/lost refusal exist only in the browser. | **Medium** |
| S9 | **Full dataset to every user.** `/state` ships all items, bookings, transactions and maintenance records regardless of module grant — including purchase cost, insurance policy numbers and every colleague's custody history. | **Medium** |
| S10 | **Asset tag race.** `COUNT(*)`-derived tags collide under concurrency and after soft deletes; no retry. | **Low** |
| S11 | **Guessable `qr_uid`.** `QR-` + asset tag. Safe today because nothing authenticates on it; must not become a token. | **Low** |
| S12 | **Silent booking failure** in shoot creation (`.catch(() => {})`). | **Low** |

No SQL injection was found — every query uses parameterized placeholders. No
unparameterized interpolation of user input into SQL exists in the equipment paths.
(`/state` interpolates table names, but only from a hardcoded array.)

---

## 17. Performance Findings

**The bottleneck is `/state`, not equipment.** On every app boot, for every user:

```js
for (const [key, table, where, refs] of STATE) {
  const { rows } = await pool.query(`SELECT to_jsonb(t) AS row FROM ${table}…`);
}
```

Sequential, ~60 tables, no `LIMIT`, no pagination, no module filtering. Equipment
contributes four of those: items, bookings, **transactions** and maintenance records.
Transactions grow without bound — two per item per loan, forever.

All filtering, searching, sorting and grouping in all eight tabs happens in the
browser over these arrays. `overdueEquipment()` maps every item and sorts that item's
whole transaction list.

| Scale | Verdict |
|---|---|
| 100 assets | **Fine.** Roughly today's prototype. |
| 1,000 assets | **Workable**, degrading. ~10–20k transaction rows in every boot payload. |
| 10,000 assets | **Not viable.** Hundreds of thousands of transaction rows per boot; multi-megabyte JSON; `eqCatalog()` renders every row into one DOM table. |
| 100,000 assets | **Impossible** without a different read architecture. |

The fix is not an index — it is per-module paginated read endpoints. Note that
`mo_equipment_items` has only `(category_id, status)`; there is no index on
`asset_tag` lookup beyond the UNIQUE, none on `department_id`/`campus_id`, and none on
`mo_equipment_bookings(starts_at, ends_at)` for calendar queries.

---

## 18. Gaps

Against the §11 requirement list:

| | Requirement | Status | Note |
|---|---|---|---|
| A | Asset Registry | **PARTIAL** | Table is good; no read/update/delete API |
| B | Asset Categories | **EXISTS** | With admin CRUD |
| C | Individual Asset Identity | **EXISTS** | `asset_tag UNIQUE NOT NULL` |
| D | QR Identity | **CONFLICTING** | Column exists; UI prints a fake code |
| E | RFID Identity | **MISSING** | See §9 |
| F | Locations | **MISSING** | Only `campus_id`; no room/shelf |
| G | Departments | **PARTIAL** | Column exists, hardcoded to `1` |
| H | Custodians | **PARTIAL** | Duty exists, never enforced server-side |
| I | Availability | **PARTIAL** | Computed client-side; `booked` never persisted |
| J | Reservations | **EXISTS** | With real DB conflict protection |
| K | Booking Calendar | **PARTIAL** | Date-only; no calendar endpoint |
| L | Check-out | **PARTIAL** | Works; rules unenforced |
| M | Check-in | **PARTIAL** | Works; records the wrong holder |
| N | Overdue | **PARTIAL** | Notifies holder only; no escalation, no block |
| O | Project Allocation | **PARTIAL** | Booking FK only; no UI |
| P | Maintenance | **PARTIAL** | Openable, never resolvable |
| Q | Damage | **PARTIAL** | Two conflicting rules |
| R | Inspection | **MISSING** | |
| S | Asset History | **PARTIAL** | Ledger exists; custody attribution broken |
| T | Inventory Audit | **MISSING** | No stocktake concept |
| U | Student Loans | **MISSING** | No student identity |
| V | Faculty Loans | **MISSING** | No faculty identity |
| W | Employee Loans | **EXISTS** | This is what checkout is |
| X | Reporting | **PARTIAL** | Client-side analytics tab only |
| Y | Notifications | **PARTIAL** | AUTO-3 only |
| Z | Analytics | **PARTIAL** | Computed in the browser |

### Structural limitations

Individual identity ✅ and immutable asset identity ✅ are both **already solved** —
this is the most valuable thing the existing schema gives you. The real structural
gaps are: no location model; no department scope in practice; no identifier
abstraction; no lifecycle transitions (`retired`/`lost` unreachable); no resolvable
maintenance; no inspection; no stocktake; no non-Nerve borrower; no intra-day
booking; `holder_id` semantics broken on check-in; and no `created_at`/`updated_at` on
the asset row.

---

## 19. Technical Debt

1. **Business rules implemented twice, differently** (BR-8), and once only in the
   browser (BR-7). Each divergence is a bug the user experiences as the screen
   changing by itself.
2. **The UI asserts behaviour that does not exist** — AUTO-3 escalation, BR-7
   blocking, kiosk PIN, QR labels. This is the most dangerous debt here, because it
   converts missing features into *believed* features.
3. **Optimistic mutation without rollback discipline.** `moSync` re-hydrates rather
   than reverting, so the two states reconcile by full reload.
4. **Dead schema:** `pool_quantity`, `barcode`, `photo_url`, `insurance_*`,
   `warranty_until` (displayed, never set), kits, `next_due_at`, `resolved_at`.
5. **`/state` as the only read path.**
6. **No equipment tests.**
7. Hardcoded `department_id=1, campus_id=1`.
8. `COUNT(*)`-based tag generation.
9. Swallowed errors in the shoot booking loop.

---

## 20. Reusable Components

Worth keeping and building on:

- **`mo_equipment_items`** — a sound asset registry needing additive columns only.
- **The `EXCLUDE USING gist` booking constraint** and the enabled `btree_gist`
  extension. Correct, and hard to get right; do not rewrite it.
- **`mo_equipment_transactions`** as an event ledger shape, with `recorded_via`
  already anticipating kiosk and mobile.
- **`audit()`** and `mo_audit_logs` — consistent, already wired for six event types.
- **The duty model** (`mo_duty_flags` / `mo_user_duties`) for custodians — it just
  needs a server-side reader.
- **Module system** (`NAV` → `MODULES` → `allowed_modules` → `requireModule`) — the
  right place to scope a future Academic inventory, and it already works when called.
- **The notification helper** and `runMediaOpsAutomations()` scheduler.
- **`mo_departments` / `mo_campuses`** — already seeded with Media Crew, Content Team,
  Outreach and two campuses.
- **The generic lookup CRUD engine** — new config tables need no endpoint code.
- **The jsdom UI test harness** (`src/test/*.ui.test.ts`) — boots the real page and
  drives its own functions; directly reusable for equipment UI regression.

---

## 21. Future Architecture Compatibility

Against the §12 target model:

```
ORGANIZATION → DEPARTMENT → INVENTORY → CATEGORY → ASSET TYPE → INDIVIDUAL ASSET
```

**Can the current architecture evolve toward it? Yes — additively, without a rewrite.**

| Layer | Today | Path |
|---|---|---|
| Organization | implicit | leave implicit |
| Department | column, hardcoded | populate and scope; table exists |
| Inventory | ❌ | new table, or department + category is enough at first |
| Category | ✅ | keep |
| Asset Type | ❌ (`make`/`model` are free text) | new `mo_asset_models` table; `category → model → item` |
| Individual Asset | ✅ | keep |
| Identifiers | columns | **new `mo_asset_identifiers` table** — the one structural change worth making early |
| Status | ✅ enum | extend CHECK |
| Location | ❌ | new `mo_locations` + `location_id` |
| Custodian | duty flag | enforce server-side |
| Current Holder | ⚠️ ledger-derived, broken on check-in | fix check-in; consider a denormalized `current_holder_id` |
| Reservation → Checkout → Return | ✅ | keep; add intra-day |
| Inspection | ❌ | new |
| Maintenance / Damage | ⚠️ | add resolution |
| History | ⚠️ | unify ledger and audit log |

**Media Crew vs. Academic (§13):** the scoping primitives exist —
`mo_departments`, `mo_campuses`, `department_id`/`campus_id` on items, the module
system, the duty model — and none are used. The clean answer is **one system scoped by
department**, not two. The blocker is not schema, it is that **borrowers must be Nerve
users**: students and faculty have no representation. That is the decision to make
before Phase 6, and it should be made early because it affects the ledger's foreign
key.

---

## 22. Recommended Phase 1 Scope

**Do not add features first.** The existing module tells users it does things it does
not do, and adding an Academic inventory on top would multiply that. Phase 1 should
make the current claims true and the current data trustworthy:

1. Close S1–S3 (forged holder, missing module gates, kiosk auth).
2. Add read/update/retire endpoints so an asset has a lifecycle.
3. Pick one BR-8 and delete the other.
4. Remove or genuinely implement the QR label and the kiosk PIN.
5. Make `holder_id` on check-in mean the holder.
6. Add the first equipment tests — the booking constraint, checkout/check-in, and
   every authorization rule.
7. Replace the `/state` equipment dump with a paginated read.

---

# Recommended Next Step

**Do not implement any of the following yet.** This is a proposed sequence for
review, not a plan of record.

### Phase 1 — Asset Foundation
*Purpose:* make the existing module honest and trustworthy before extending it.
*Database:* `created_at`/`updated_at` on items; `mo_asset_identifiers`; `mo_locations`
+ `location_id`; populate `department_id`/`campus_id`.
*API:* `GET /equipment` (paginated, filtered), `GET /equipment/:id`, `PATCH`,
`POST /equipment/:id/retire`; `requireModule` + custodian checks on all six existing
endpoints; sequence-based asset tags.
*UI:* edit and retire; remove the fake QR dialog; paginated catalog.
*Security:* S1, S2, S4–S8, S10, S12.
*Audit:* `asset_updated`, `asset_retired`, `asset_status_changed`.
*Tests:* every authorization rule; tag generation under concurrency; pagination.
*Dependencies:* none. **Everything else depends on this.**

### Phase 2 — QR Identity
*Purpose:* a printed label that actually resolves.
*Database:* identifiers from Phase 1; random, non-derived `qr_uid`.
*API:* `GET /assets/resolve/:identifier`.
*UI:* real QR rendering (one vendored library), printable label sheets.
*Security:* decide explicitly whether the code is a lookup key or a capability — it
must not silently become the latter.
*Tests:* resolution, collisions, revoked identifiers.
*Dependencies:* Phase 1.

### Phase 3 — Check-in / Check-out
*Purpose:* move BR-7/BR-8 to the server and fix custody attribution.
*Database:* transaction idempotency key; explicit `custody_holder_id`.
*API:* server-enforced BR-7; one BR-8; check-in validates prior checkout.
*UI:* kiosk with real authentication, or withdrawn.
*Security:* S3, S7, S8.
*Tests:* full custody lifecycle; concurrent checkout of one item.
*Dependencies:* Phases 1–2.

### Phase 4 — Reservations / Booking
*Purpose:* intra-day booking and a real calendar.
*Database:* `TIMESTAMPTZ` + `tstzrange` in the EXCLUDE constraint (migration must
preserve existing rows); index on the range.
*API:* calendar/availability endpoints; ownership on cancel.
*UI:* booking calendar.
*Tests:* overlap at boundaries; timezone correctness.
*Dependencies:* Phase 3.

### Phase 5 — Project Equipment
*Purpose:* equipment as part of a project, not a side effect of a shoot.
*Database:* `mo_project_equipment` (or promote booking `project_id`).
*API:* allocation endpoints; stop swallowing conflicts.
*UI:* an Equipment section on the project page.
*Tests:* allocation, release, project deletion behaviour.
*Dependencies:* Phase 4.

### Phase 6 — Custodian / Academic Loans
*Purpose:* students and faculty. **The largest single design decision in this roadmap.**
*Database:* a borrower model that does not require a Nerve user account, and its
consequences for `holder_id`'s foreign key.
*API:* department-scoped everything; custodian authority enforced.
*Security:* cross-department isolation, tested explicitly.
*Tests:* a Design student cannot see or borrow Media Crew equipment.
*Dependencies:* Phases 1–5. **Resolve the borrower-identity question before Phase 3
freezes the ledger's FK.**

### Phase 7 — Maintenance / Damage
*Purpose:* a repair that can finish.
*Database:* status, severity, assignee, attachments on maintenance records.
*API:* resolve, reopen, return-to-service.
*Tests:* full maintenance lifecycle; an item cannot be stranded.
*Dependencies:* Phase 1.

### Phase 8 — Inventory Audit
*Purpose:* physical stocktake reconciliation.
*Database:* `mo_inventory_audits`, `mo_inventory_audit_lines`.
*API:* open, scan, reconcile, close.
*Dependencies:* Phases 2, 7.

### Phase 9 — RFID Readiness
*Purpose:* bulk identification.
*Database:* readers, reader locations, scan events (identifier table already in place).
*API:* an ingest endpoint with idempotency and rate limiting.
*Security:* readers are unattended devices — device identity, not user identity.
*Dependencies:* Phases 2, 8.

### Phase 10 — Analytics / Automation
*Purpose:* utilisation, loss rates, escalation that matches what the UI claims.
*API:* server-computed analytics; AUTO-3 escalation as documented.
*Dependencies:* all prior phases.

---

**STOP. This document is an audit. Nothing above has been implemented.**
