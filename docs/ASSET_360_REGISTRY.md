# Asset 360° Registry (Phase 17E)

One asset, one page, eight questions — and five answers that are never merged
into one.

---

## 1. Purpose

Every asset in Media Ops now has a single authoritative detail page that answers:

> What is this asset? Where does it belong? Who has it? What is its current
> state? What has happened to it? What reservations exist? What maintenance has
> happened? What verification and audit information exists?

Phase 17E establishes the **information architecture and the read experience**.
It adds no operational workflow: checkout (17F), reservations (17G), project
allocation (17H), inspection (17I) and maintenance management (17J) each remain
their own phase. Where those domains already hold data, this page reads it.

---

## 2. One asset entity

`mo_equipment_items` remains the canonical physical asset. There is no Equipment
Profile, Asset Profile, Inventory Item Profile or Device Profile — those would be
competing names for the row that already exists.

Source-of-truth tables, unchanged by this phase:

| Concept | Table |
|---|---|
| The asset | `mo_equipment_items` |
| Its inventory | `mo_inventory_scopes` |
| Custody ledger | `mo_equipment_transactions` |
| Reservations | `mo_equipment_bookings` |
| Maintenance **and damage** | `mo_maintenance_records` (split by `kind`) |
| Identifiers | `mo_asset_identifiers` |
| Audit | `mo_audit_logs` |

**Inspection is not a domain this system has.** The page says so in words rather
than drawing an empty frame that looks like a feature.

---

## 3. Five states, kept apart

`assetState()` returns five independently-sourced dimensions and a `conflicts`
list. Nothing collapses them into an availability word, and no derived value is
persisted.

| Dimension | Source | Persisted |
|---|---|---|
| `lifecycle` | `mo_equipment_items.status` | yes |
| `custody` | latest row in `mo_equipment_transactions` | derived from the ledger |
| `verification` | `mo_equipment_items.verification_state` / `_note` | yes |
| `reservation` | next live `mo_equipment_bookings` row | derived |
| `maintenance` | open `mo_maintenance_records` | derived |

A camera can be Active, Checked Out, Pending Verification, Reserved for Tuesday
and under repair — five true statements at once.

**Verification joined `state` in this phase** as a *projection*, not a copy:
`mo_equipment_items.verification_state` is still the only place it is stored, and
still travels on the row. What `state.verification` adds is that "is this record
believed?" reads the same way as "where is it?".

**Contradictions are reported, not resolved.** `conflicts` has always been part of
the read model; the page now draws it as a warning naming both facts, because
nothing in the schema says which should win.

---

## 4. API — what was reused, extended and added

Reuse came first: three of the five sections needed no new endpoint, because the
module-level list endpoints already accept `asset_id`, already paginate through
`pageOf()`, and already enforce inventory scope through `pushInventoryScope()`.

### Reused unchanged

| Section | Endpoint |
|---|---|
| Reservations | `GET /equipment/bookings?asset_id=&status=&limit=&offset=` |
| Maintenance | `GET /equipment/maintenance?asset_id=&kind=&limit=&offset=` |
| Damage | `GET /equipment/maintenance?asset_id=&kind=damage_report` |

### Extended compatibly

**`GET /equipment/maintenance` — `?kind=` now accepts a list.** `maintenance,repair`
is one request instead of two merged in the browser, exactly as bookings'
`?status=` already worked. A single value means what it always did; unrecognised
words are dropped.

### Added

**`GET /equipment/:id/timeline`**

One asset's history as one sequence, from both history tables.

- **Auth**: `requireEquipment` → `assetScopeOk`. Out of scope answers **404**,
  byte-identical to a non-existent id.
- **Params**: `kind=custody|maintenance` (anything else = no filter), `limit` (≤200,
  default 50), `offset`.
- **Response**: `{ items, total, limit, offset }`. Each item carries `source`,
  `id`, `occurred_at`, `event`, `actor_id`, `actor_name`, `detail`, `recorded_via`,
  `kind`, `resolved`, `due_at`.
- **Composition**: `UNION ALL` in one query, ordered and paginated in the
  database. No third history table is created and nothing is denormalised.
  Merging two separately-paginated lists in the browser produces a timeline with
  holes in it, which is why this is one query.

**`GET /equipment/:id/audit`**

What was done to the *record*, as opposed to the asset.

- **Auth**: `requireEquipment` → `canManageEquipment` → `assetScopeOk`. A
  non-custodian gets 403; another inventory's asset gets 404.
- **Params**: `action_prefix` (so the Verification tab reads its own slice rather
  than paging the whole trail and discarding rows), `limit`, `offset`.
- **Response**: `{ items, total, limit, offset }` with `action`, `actor_id`,
  `actor_name`, `actor_role`, `before`, `after`, `occurred_at`.
- `entity_type` is **pinned server-side** to `equipment_item`, so no query string
  can turn this into a general audit browser. `ip` and `user_agent` are
  deliberately not returned.
- The global admin-only `GET /audit` is untouched.

### Not added

No `GET /equipment/:id/transactions`, `/bookings` or `/maintenance`. They would
have duplicated endpoints that already do the job.

---

## 5. Authorization

No new permission concept. The chain is the one Asset & Inventory already uses:

```
requireMedia → requireModule('equipment') → [canManageEquipment] → inventoryScopeOf → scopeAllows / assetScopeOk
```

- Reading an asset and its timeline requires the equipment module and the asset's
  inventory scope.
- Reading its audit trail additionally requires `canManageEquipment`.
- Department and campus are **not** authorization. Inventory scope is.
- Admins keep the unrestricted access they already had. No Asset Super Admin,
  Inventory Super Admin or Equipment Admin was invented.

**Cross-scope denial is a 404 carrying each endpoint's own existing message**, so
an id, a tag, an internal code or a QR token can never be used to confirm that
something exists in an inventory the caller has no business seeing. A list
endpoint narrows to nothing instead, because there is simply nothing in scope to
return.

---

## 6. Performance

**One request opens the page.** `GET /equipment/:id` returns the shell: the asset
row, its five states, its identifiers, and the bounded previews it has always
returned (≤50 transactions, ≤50 maintenance, live bookings). The Overview tab is
drawn entirely from that, so it costs nothing extra.

**A section costs nothing until it is opened**, and then costs one paginated
request. Sections are dropped — never patched — when a write lands, so the next
open re-asks the server.

Every section endpoint is capped at 200 rows by `pageOf()`, and the page asks for
20. There is no code path that returns an unbounded history.

**`/state` is unchanged.** `equipment_items`, `equipment_transactions`,
`equipment_bookings`, `maintenance_records` and `inventory_scopes` stay out of the
boot payload. A richer page per asset is a reason to read *more per asset*, never
a reason to ship every asset — which is the Phase 7/8 optimisation this phase had
to avoid undoing one asset at a time.

**No derived state was persisted.** No `current_holder_name`, `current_status`,
`next_reservation`, `maintenance_status` or `last_transaction` column was added.

---

## 7. The screen

```
← Equipment
SONY FX3
MC-0024 · Media Crew · Camera Body · Serialized
● Available   ✔ verified   Serial SN-FX3-0091   QR AT-7

Overview │ Custody │ Reservations │ Maintenance │ Damage & Inspection │
Transactions │ Verification │ Audit
```

- **Overview** — Identity, Inventory, Record metadata, and the five state cards.
- **Custody** — current holder, since, due, recorded via; then custody history.
- **Reservations** — current & upcoming, or past, through the booking endpoint.
- **Maintenance** — `maintenance` + `repair`; status is derived from `resolved_at`.
- **Damage & Inspection** — `damage_report`, plus an explicit statement that
  inspection is not yet part of this system.
- **Transactions** — the unified timeline.
- **Verification** — the 17D state machine, its reason, its legal moves, and the
  verification slice of the trail.
- **Audit** — the asset's own events, custodians and admins only.

The tab lives in `S.tab.asset`, driven by the one delegated tab handler the rest
of the application uses. Sections use the existing `.skel` shimmer while loading.
Assets themselves still live in `ASSETS.byId`; the section objects hold a *page of
one asset's history*, following the same shape as `EQ_TX`/`EQ_MT`/`EQ_BK`.

---

## 8. Legacy and pooled assets

**Ungoverned legacy assets** (`scope_id IS NULL`, `internal_code IS NULL`) render
exactly as they are: *Not Assigned* and *Internal code pending*. No inventory is
invented, no code is generated, and the database id is never shown as a public
identifier. They remain reachable by everyone, because the legacy estate belongs
to nobody.

**Pooled assets** are one record with a quantity — `Pooled · 48 units` — never 48
fabricated serial identities. The header states which of the two a record is.

**Nothing was migrated.** Dev remains 32 assets, 0 scoped, 0 coded, 32 active.

---

## 9. Defect found and fixed

`ASSET_SELECT` selected **two result columns both named `tracking_mode`**:

```sql
COALESCE(i.tracking_mode, c.tracking_mode) AS tracking_mode,   -- the item's, then the category's
...
c.name AS category_name, c.tracking_mode,                      -- ← the category's, again
```

node-postgres builds a row object from the result columns in order, so the second
one won and **the per-item override was silently discarded on every read**. A
pooled item in a serialized category reported itself as serialized — the one thing
`tracking_mode` exists to prevent. It survived Phase 17A's tests because those put
the pooled item in a pooled category, where both answers agree.

The category's default is now `category_tracking_mode`, so `tracking_mode` means
the COALESCE above it. Found by a Phase 17E test that deliberately put a pooled
item in a serialized category.

---

## 10. Phase boundaries

Read-only here; each of these owns its own workflow later:

| Phase | Not implemented in 17E |
|---|---|
| 17F | Checkout / check-in |
| 17G | Reservation creation, editing, cancellation |
| 17H | Project equipment allocation |
| 17I | Inspection and damage workflow |
| 17J | Maintenance management |
| 17K | Inventory dashboard |
| 17L | CSV import and reconciliation |
| 17M | RFID hardware integration |
| 17N | Production hardening |

The existing checkout, check-in, booking and damage-report actions remain in the
page header, where they already were. They were not extended.

**Viewing an asset writes no audit event.** A read is not a compliance event, and
logging one would bury the events that matter.

---

## 11. Coverage

| Suite | Tests |
|---|---|
| `server/mediaops-asset-360.integration.test.ts` | 30 |
| `src/test/asset-360.ui.test.ts` | 24 |

What they pin: the five dimensions stay separate and none of them is an
availability word; a contradiction is reported rather than resolved; the timeline
merges both history tables, is newest-first, and its pages do not overlap; no
endpoint returns an unbounded history; cross-scope reads are 404 and identical to
a non-existent id; the audit endpoint cannot be widened by a query string and
leaks no `ip`/`user_agent`; an ungoverned asset renders without an invented
inventory or code; a pooled row is never split into units; opening the page
fetches no section; and every empty state is a sentence rather than a dash.
