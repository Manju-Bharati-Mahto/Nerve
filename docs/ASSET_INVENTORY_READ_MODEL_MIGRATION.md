# Equipment Read-Model Migration

Phase 1 of the Asset & Inventory work: the Equipment registry and asset detail
now read the server instead of the `/state` dump.

This is a performance and architecture change. Nothing was redesigned visually,
no second application or API was created, and no equipment data was duplicated.

---

## 1. Previous data-loading architecture

Everything the Equipment tab drew came out of arrays the browser had already
downloaded:

```
boot  →  GET /state  →  DB.equipment_items[]        every asset, always
                        DB.equipment_transactions[] latest per item + last 500
                        DB.equipment_bookings[]     active, or ended within 90d
                        DB.maintenance_records[]    all
                        DB.equipment_categories[]   all (small)

eqCatalog()        → iterate DB.equipment_items, group, render every row
eqHolder(id)       → scan DB.equipment_transactions for the latest row
viewEquipmentItem  → find in DB.equipment_items, then filter three more arrays
```

Two consequences, both structural:

- **The cost of opening the tab grew with the estate.** Thirty cameras or ten
  thousand, every asset was serialised, transferred, parsed and rendered —
  whether or not anybody looked past the first screen.
- **Opening one camera required the whole department's history to be present.**
  The detail page filtered the global transaction, booking and maintenance
  arrays, so it was only correct if all three were complete.

There was no search, filter or pagination: the catalog rendered everything.

---

## 2. `/state` dependencies discovered

Every Equipment-related read in `public/media-ops/index.html`, traced before any
code was changed. **36** references to `DB.equipment_items` alone.

### Migrated by this phase

| Consumer | Was | Now |
|---|---|---|
| `eqCatalog()` — the asset registry | `DB.equipment_items`, all rows | `GET /equipment` |
| holder avatar per row | `eqHolder()` over `DB.equipment_transactions` | `holder_id` field on the row |
| header figures (total / available / overdue / maintenance) | reductions over `DB.equipment_items` | `summary` on the same response |
| Catalog tab count | `DB.equipment_items.length` | `summary.total` |
| `viewEquipmentItem()` — asset detail | four `/state` arrays | `GET /equipment/:id` |

### Deliberately left on `/state`

These are **not** the asset registry, and Step 7 is explicit that only Equipment
registry consumers move in this phase:

| Consumer | Uses |
|---|---|
| Dashboard widgets, My Day "in my hands" | `equipment_items`, `eqHolder` |
| Kiosk item pickers | `equipment_items` |
| Calendar layers, shoot rows | `equipment_bookings`, `equipment_items` |
| Team / member pages | `equipment_items`, `eqHolder` |
| Booking picker, damage picker, Add-item form | `equipment_items`, `equipment_categories` |
| Command-palette search | `equipment_items` |
| `eqAvailability`, `eqBookings`, `eqMine`, `eqTransactions`, `eqMaintenance`, `eqKits`, `eqAnalytics` | their respective arrays |
| Settings lookup table | `equipment_categories` |
| `trgEquipStatus()`, `overdueEquipment()` | items + transactions + maintenance |

`equipment_categories` (11 rows) stays on `/state` on purpose: it is a small
lookup the category filter needs, and fetching it separately would add a request
to save nothing.

---

## 3. The new architecture

```
Equipment tab
  └─ GET /equipment?q=&status=&category_id=&limit=50&offset=0&summary=1
       → { items: [50 rows], total, limit, offset, summary: {…} }

Asset detail  (#/media/equipment/EQ-CAM-001, unchanged URL)
  └─ GET /equipment/EQ-CAM-001
       → { item, identifiers, transactions, bookings, maintenance, holder, escalation }
```

One request draws the registry. One request draws an asset. The browser holds a
page, never the estate.

**No new endpoint was created.** The existing `GET /equipment` and
`GET /equipment/:id` were extended, as Step 2 requires.

---

## 4. Query, filter and pagination behaviour

`GET /equipment` already supported everything the registry needed except the
holder:

| Parameter | Behaviour |
|---|---|
| `q` | `ILIKE` across `asset_tag`, `make`, `model`, `serial_no` |
| `status` | exact; `all` disables |
| `category_id` | exact; `all` disables |
| `department_id` | exact; `all` disables — present for the future department scope, not yet surfaced in the UI |
| `include_retired` | `1` includes retired assets; excluded by default |
| `limit` | default 50, clamped to **1–200** |
| `offset` | clamped to ≥ 0 |
| `summary` | **new** — `1` adds the header figures |

Ordering is `asset_tag`, unchanged. `total` is the count of the whole match, not
the page. Nonsense input is clamped rather than trusted: `limit=99999` → 200,
`limit=-5` → 1, `offset=abc` → 0.

### Two additions, both fields rather than datasets

**`holder_id` / `holder_name` / `holder_due_at` on the row.** The catalog has
always shown a holder avatar, and used to derive it by scanning every
transaction `/state` had shipped. A paginated list has no such array — the
transactions for row 400 are not in the page — so the holder travels with the
row. One `LEFT JOIN LATERAL` against `idx_mo_txn_item (equipment_item_id,
occurred_at DESC)`, evaluated only for assets that are actually out.

**`summary=1`.** The four header figures as integers, computed by the database
over **the same filters as the list**, so the header describes what the catalog
is showing. With no filters — the default view — they are the numbers the header
showed before. Sent only when asked.

---

## 5. Detail loading

`GET /equipment/:id` was extended to accept **an asset tag as well as a numeric
id**. The catalog has always linked to `#/media/equipment/EQ-CAM-001`; accepting
the tag keeps that URL working in one request rather than a resolve-then-fetch
round trip. The tag is matched against the same unique column, not interpreted.

The detail page is a single page, not a tabbed drawer, so one request for the
record and its own history is the right shape — and Step 6 is explicit that the
detail UI is not to be redesigned.

---

## 6. Lazy-loaded datasets

| Dataset | When it loads |
|---|---|
| identifiers, transactions, bookings, maintenance for **one** asset | when that asset is opened |
| everything above, for **every** asset | **never** — this is what was removed |

The registry fetches no history of any kind. Both the API and UI suites assert
that a list row carries no `transactions`, `bookings`, `maintenance` or
`identifiers` property.

---

## 7. Compatibility decisions

**Category grouping is now per page.** The catalog has always grouped rows by
category, and still does — but a page is what the browser holds, so the count
chip on a group header counts that group's rows *on this page*. The
authoritative total for a whole category is one click away in the category
filter, and the page total is stated in the footer (`Showing 1–50 of 248`). This
is the one behaviour that could not be preserved exactly: cross-category
pagination and whole-category counts are mutually exclusive.

**Everything else is unchanged** — the same seven columns, the same Check
out / Check in row actions, the same status pills, the same `data-go` row link
to the asset tag, the same permissions. The only additions are the controls
server-side paging requires: a search box, two filter selects, and a pager.

**`/state` is untouched.** No field was removed from it and no other module was
changed.

**Writes still go through the existing endpoints**, which remain authoritative.
Each one now marks the read model stale (`eqInvalidate()`) so the next render
re-asks — *after* the mutation's own result is reported, preserving the order
established when checkout stopped reporting a failed refresh as a failed
checkout.

---

## 8. Performance measurements

Measured, not estimated: a synthetic estate of **1,000 assets** (250 checked
out) built in the test database, both endpoints called through the real server.

| | Bytes | Rows |
|---|---|---|
| `/state` — `equipment_items` | 565,180 | 1,000 |
| `/state` — `equipment_transactions` | 63,751 | 250 |
| `/state` — bookings + maintenance | 4 | 0 |
| **What the registry used to require** | **628,935** | **1,250** |
| `GET /equipment?limit=50&summary=1` | **33,155** | **50** |
| `GET /equipment/:tag` (one asset) | **750** | 1 |

**The registry's data requirement fell from ~629 KB to ~33 KB — 95% smaller —
and is now constant per page rather than proportional to the estate.**

| | Before | After |
|---|---|---|
| Requests to draw the registry | 0 (rode on `/state`) | **1** |
| Rows transferred for the registry | every asset | **50** |
| Rows rendered into the DOM | every asset | **50** |
| Requests to open one asset | 0 (rode on `/state`) | **1** |
| Database queries for the registry | ~60 sequential (`/state`) | **4** (count, page, 2 summary) |
| Search / filter / page | in the browser, over the estate | on the server |

### What has *not* changed, stated plainly

`/state` still ships those 1,000 items, because the dashboard, My Day, kiosk,
calendar, team pages and booking pickers still read them (§2). **The total boot
payload is therefore unchanged by this phase.** What changed is that the
registry no longer *depends* on it — proven, not asserted: the UI suite answers
`/state` with a network failure and the registry still renders.

Removing `equipment_items` from `/state` is the next phase's work and requires
migrating those eight consumers first.

---

## 9. Tests added

**API** — `server/mediaops-equipment.integration.test.ts`, 60 → **69**:

- first page, second page, page size, non-overlapping pages, `total` is the match
- clamped pagination: oversized, negative and non-numeric `limit`/`offset`
- search across tag, make, model and serial; empty result
- status filter, category filter
- holder on the row: absent, present after checkout, absent again after check-in
- no history attached to a list row
- `summary` only when asked, honouring the same filters, narrowing with them
- detail by asset tag and by id, 404 for an unknown tag
- authorization: no module, not media crew, unauthenticated

**UI** — `src/test/equipment-read-model.ui.test.ts`, **21 new**, booting the real
page with a scripted server:

- registry loads through `GET /equipment`, once, on entry
- **`/state` is not requested to draw the registry** (the regression guard)
- one page held, not the estate; `Showing 1–50 of 248`
- no history fetched for the list; no heavy property on a row
- the seven columns, the row actions and the tag link are unchanged
- the holder still renders with the local transaction array emptied
- search, status filter, category filter and paging each hit the server
- a filter change returns to page 1
- header figures come from the summary
- detail fetches by tag in one request, renders history with the local arrays
  emptied, and re-fetches for a different asset
- loading, empty, list error (with retry) and detail error states
- a write marks the read model stale, and a checkout is still reported as
  successful when the refresh afterwards fails

---

## 10. Remaining `/state` dependencies

Listed in §2. In short: eight non-registry consumers still read
`DB.equipment_items`, and the seven other Equipment tabs still read their own
arrays. `equipment_categories` is a deliberate keep.

---

## 11. Recommended next phase

**Migrate the remaining Equipment tabs**, in this order — each is a read the
server can already answer or nearly so:

1. **Transactions** and **Maintenance** tabs — the two that read unbounded
   history. These want the same treatment as the registry: paginated endpoints
   and a filter. `GET /equipment/:id` already returns one asset's history; a
   department-wide paginated variant is the missing piece.
2. **Bookings** and **Availability** — need a date-range query, which is also
   what a booking calendar will want.
3. **My items** — a `holder_id=me` filter on the existing list endpoint.

Only once those are done can `equipment_transactions`, `maintenance_records` and
`equipment_bookings` leave `/state`; and only once the dashboard, My Day, kiosk,
calendar and team consumers have a scoped endpoint can `equipment_items` follow.
That is the point at which the boot payload actually shrinks.

`eqAnalytics` should not be migrated by porting its client-side reductions — it
is the natural consumer of a server-computed analytics endpoint, like the
Creator Network's.

---

> **Superseded in part by Phase 7.** This document describes `/state` as still
> shipping the equipment history arrays, which was true when it was written.
> `equipment_transactions`, `equipment_bookings` and `maintenance_records` have
> since been **removed from `/state`** — see
> [ASSET_INVENTORY_STATE_CONSOLIDATION.md](ASSET_INVENTORY_STATE_CONSOLIDATION.md).
> `equipment_items` remains, and that document records why. Nothing else in the
> phase described here changed.
