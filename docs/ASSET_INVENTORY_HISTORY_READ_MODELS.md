# Equipment History Read Models

Phase 2 of the Asset & Inventory work: the **Transactions** and **Maintenance**
tabs now read the server instead of the `/state` dump.

Same shape as Phase 1 — a paginated, filtered, server-authoritative read model
per tab. Nothing was redesigned, no new workflow was introduced, and the asset
detail page still gets one asset's history in its own request.

---

## 1. Previous transaction/maintenance loading

Both tabs drew from arrays the browser had already downloaded at boot:

```
boot  →  GET /state  →  DB.equipment_transactions[]   latest per item + most recent 500
                        DB.maintenance_records[]      ALL of them, unbounded

eqTransactions()  → sort DB.equipment_transactions, render every row
eqMaintenance()   → filter DB.maintenance_records, render every row,
                    and reduce the same array again for the footer's cost total
```

Three consequences, and the first was a correctness problem rather than a
performance one:

- **The Transactions tab was showing a truncated ledger and saying nothing.**
  `/state` caps transactions at *the latest row per item, plus the 500 most
  recent*. The tab rendered that as though it were the department's history. On
  the measured fixture it displayed **500 of 4,800 rows** — 10% — with no
  indication that the rest existed.
- **Maintenance was uncapped**, so the boot payload grew with every repair ever
  recorded. It is the one Equipment dataset with no ceiling at all.
- **Neither tab could filter or page**, because filtering an array you only
  partly have gives an answer that is only partly true.

---

## 2. Consumers discovered

Traced before any code changed — every read of either array in
`public/media-ops/index.html`.

### `DB.equipment_transactions`

| Consumer | What it wanted | Outcome |
|---|---|---|
| `eqTransactions()` — the Transactions tab | the whole ledger, sorted | **migrated** |
| Transactions tab count | `.length` | **migrated** (`total`) |
| `eqHolder(itemId)` | the *latest* row for one item | left — current state, not history (see below) |
| `eqAnalytics()` | per-asset check-out counts, utilisation | **left deliberately** (§11) |
| offline write paths (kiosk, checkout, check-in) | push a row | left — standalone-mode only |

### `DB.maintenance_records`

| Consumer | What it wanted | Outcome |
|---|---|---|
| `eqMaintenance()` — the Maintenance tab | every record | **migrated** |
| the tab's cost footer | `SUM(cost)` over the same rows | **migrated** (`summary.cost`) |
| Maintenance tab count + the header's "N open records" | open records | **migrated** (`summary.open`) |
| `trgEquipStatus()` | open records → force an item to `maintenance` | left — a status derivation, not the tab |
| `eqAnalytics()` | per-asset repair spend | **left deliberately** (§11) |
| offline write paths (damage report) | push a record | left — standalone-mode only |

**`eqHolder()` was deliberately not migrated.** It asks *who has this right
now*, which is current state; Phase 1 already answered it for the registry with
a `holder_id` column on the row. Migrating it here would have pulled the
dashboard, My Day, kiosk, team pages and `eqAvailability` into a history phase.

---

## 3. New transaction API

```
GET /equipment/transactions
  ?asset_id= &holder_id= &action= &recorded_via= &department_id= &project_id=
  &from= &to= &limit=50 &offset=0

→ { items: [...], total, limit, offset }
```

`requireEquipment(res)` — Media Ops crew **and** the `equipment` module, the
same gate every other Equipment read uses. No new authorization path.

One row is one ledger entry and nothing else:

```
id, equipment_item_id, occurred_at, action, holder_id, condition_noted,
expected_return_at, recorded_via, recorded_by,
asset_tag, make, model,                      ← so the table can name the asset
holder_name, recorded_by_name,               ← so it can name the people
project_id                                   ← via the booking, see §5
```

Ordered `occurred_at DESC, id DESC`. The tie-break on `id` matters: several
rows can share a timestamp, and without it the same page could come back in a
different order twice and paging would skip or repeat rows.

Retired assets keep their history — the only exclusion is `deleted_at IS NULL`,
which is the same soft-delete rule the registry uses.

---

## 4. New maintenance API

```
GET /equipment/maintenance
  ?asset_id= &status=open|resolved|all &kind= &department_id=
  &from= &to= &limit=50 &offset=0 &summary=1

→ { items: [...], total, limit, offset, summary?: { total, open, resolved, cost } }
```

Row:

```
id, equipment_item_id, kind, description, cost, vendor_id, reported_by,
started_at, resolved_at, next_due_at,
asset_tag, make, model, vendor_name
```

Ordered `started_at DESC NULLS LAST, id DESC`.

**Status is derived, not stored.** `mo_maintenance_records` has no status
column — a record is open until `resolved_at` is set, which is exactly what the
tab has always displayed. `?status=open` reads that existing shape. It does not
introduce a state machine; maintenance workflow is a later phase, and this
phase was explicitly not to invent one.

`summary=1` returns the counts and the one sum the tab already showed, computed
over the same filters as the list. Sent only when asked.

---

## 5. Query/filter model

Every filter is a column the schema already has. Nothing was invented, and no
field was added to any table.

| Filter | Transactions | Maintenance | Source |
|---|---|---|---|
| `asset_id` | ✓ | ✓ | `equipment_item_id` |
| `action` | ✓ | — | `t.action` |
| `recorded_via` | ✓ | — | `t.recorded_via` (desktop / kiosk) |
| `holder_id` | ✓ | — | `t.holder_id` |
| `status` | — | ✓ | derived from `resolved_at` |
| `kind` | — | ✓ | `m.kind` |
| `department_id` | ✓ | ✓ | the **asset's** department, joined |
| `project_id` | ✓ | — | through the booking — see below |
| `from` / `to` | ✓ | ✓ | `occurred_at` / `started_at` |

**`project_id` comes through the booking**, because that is the only place the
schema records it: a transaction carries `booking_id`, and the booking carries
the project. A checkout made without a booking has no project, and the filter
correctly returns nothing for it rather than guessing.

**Dates are days, in IST.** A person types a date, so `occurred_at` is compared
as `(occurred_at AT TIME ZONE 'Asia/Kolkata')::date` — the zone the rest of
Media Ops reports in. Comparing a timestamp against a bare date would silently
drop the last day of any range.

All values are bound parameters. `all` on a select means "no filter" rather
than a literal match, matching the registry's convention.

---

## 6. Pagination model

Both endpoints share the registry's clamp, as one helper rather than two copies:

```js
limit  = clamp(parseInt(limit)  || 50, 1, 200)
offset = max(parseInt(offset) || 0, 0)
```

- **The default is a page, not the table.** No parameters at all returns 50 rows
  and the true `total`; there is no way to ask either endpoint for everything.
- `limit=99999` → 200, `limit=-5` → 1, `limit=abc` → 50, `offset=abc` → 0.
  Nonsense is clamped, never trusted and never echoed into SQL.
- `total` counts the whole match, not the page, so the footer can say
  `Showing 1–50 of 4,800` truthfully.
- The count and the page run against the same `WHERE`, so the total always
  describes the rows being shown.

---

## 7. UI migration

Each tab now owns a small state object and a loader, exactly as the registry
does — `EQ_TX` / `eqTxLoad()` and `EQ_MT` / `eqMtLoad()`:

```js
{ loaded, loading, rows, total, summary, err, f: {…filters}, offset }
```

- **One request per tab entry.** Verified in a harness: opening Transactions
  makes exactly one call —
  `/equipment/transactions?action=all&limit=50&offset=0` — and opening
  Maintenance makes exactly one —
  `/equipment/maintenance?status=all&kind=all&limit=50&offset=0&summary=1`.
- **Four states each**: loading, empty, error-with-retry, and the table. Before
  this phase a failed load had no representation, because the data could not
  fail — it was already in the browser.
- **Filters and paging go to the server.** Changing a filter returns to page 1;
  paging moves `offset` and re-asks.
- **The columns, the row actions and the layout are unchanged.** The additions
  are only what server-side paging requires: the filter selects and a pager.
- **Writes still go through the existing endpoints.** `eqInvalidate()` now marks
  all four read models stale — `EQ_LIST`, `EQ_ITEM`, `EQ_TX`, `EQ_MT` — so a
  checkout, check-in or damage report makes the next render re-ask, *after* the
  mutation reports its own result.

The header figures that used to be reduced from the arrays now come from
`summary`: the Maintenance tab count and the "N open records" stat read
`summary.open`, and the cost footer reads `summary.cost`.

---

## 8. `/state` dependencies removed

| Consumer | Before | After |
|---|---|---|
| `eqTransactions()` | `DB.equipment_transactions` | `GET /equipment/transactions` |
| Transactions tab count | `.length` of that array | `total` |
| `eqMaintenance()` | `DB.maintenance_records` | `GET /equipment/maintenance` |
| Maintenance tab count | `.filter(open).length` | `summary.open` |
| "N open records" header stat | the same filter again | `summary.open` |
| Maintenance cost footer | `.reduce()` over the array | `summary.cost` |

**Proven, not asserted.** The UI suite answers `/state` with a network failure
and both tabs still render, page and filter. That is the regression guard: if
either tab ever reaches back into `/state`, the test fails.

`/state` itself is untouched — no field was removed and no other module was
changed. The two arrays are still shipped, for the consumers in §10.

---

## 9. Performance measurements

Measured against a real server and database, not estimated. Fixture: **400
assets, 4,800 transactions, 1,200 maintenance records** — roughly a department
after a few years.

### Transactions

| | Rows | Bytes |
|---|---|---|
| `/state` — what the tab used to work from | 500 (of 4,800) | 123,601 |
| `GET /equipment/transactions?limit=50` | 50 (of 4,800) | **17,396** |

**86% smaller — and it is the first version that can reach all 4,800 rows.**
The old tab was not a smaller view of the ledger; it was a different, silently
truncated one.

### Maintenance

| | Rows | Bytes |
|---|---|---|
| `/state` — every record, always | 1,200 | 233,099 |
| `GET /equipment/maintenance?limit=50&summary=1` | 50 (of 1,200) | **15,111** |

**94% smaller, and constant per page** rather than proportional to every repair
ever recorded. The summary — counts and the cost total — arrives in the same
response, so the header and footer cost no extra request.

### Asset detail — unchanged, and deliberately

`GET /equipment/zph2-1` returns **4,801 bytes**: one asset with its own 12
transactions and 3 maintenance records. Per-asset history stays on the detail
endpoint, as the phase required.

| | Before | After |
|---|---|---|
| Requests to draw Transactions | 0 (rode on `/state`) | **1** |
| Requests to draw Maintenance | 0 (rode on `/state`) | **1** |
| Rows the browser holds, per tab | 500 / 1,200 | **50** |
| Filtering and paging | impossible | on the server |
| Ledger rows reachable | 500 | **all of them** |

### What has *not* changed, stated plainly

**The boot payload is unchanged by this phase.** `/state` still ships both
arrays, because `eqHolder()`, `trgEquipStatus()` and `eqAnalytics()` still read
them (§10). What changed is that neither tab *depends* on it any more. The
payload shrinks when the last consumer of each array is migrated — §12.

---

## 10. Remaining dependencies

| Array | Still read by | Why it stays |
|---|---|---|
| `equipment_transactions` | `eqHolder()` | current custody, used by the dashboard, My Day, kiosk, team pages, `eqMine`, `eqAvailability` |
| | `eqAnalytics()` | §11 |
| | offline write paths | standalone mode has no server |
| `maintenance_records` | `trgEquipStatus()` | derives an item's `maintenance` status |
| | `eqAnalytics()` | §11 |
| | offline write paths | standalone mode has no server |

Also still on `/state`, unchanged from Phase 1: `equipment_items` (eight
non-registry consumers), `equipment_bookings` (`eqBookings`, `eqAvailability`,
the calendar), and `equipment_categories` — an 11-row lookup that is a
deliberate keep.

---

## 11. Analytics implications

`eqAnalytics()` was **not** migrated, as the phase required, and its
client-side reductions were not ported.

It currently computes, in the browser, over the `/state` arrays:

- check-outs per asset and a utilisation estimate (`check_out` count × 2 days)
- repair spend per asset (`SUM(cost)` per item)

Both are **already wrong, and were before this phase**: they reduce the
truncated 500-row transaction array, so utilisation is understated for any
department with more history than that. Porting those reductions onto the new
endpoints would have meant paging the whole ledger into the browser to add it
up — which is what this phase exists to stop.

The correct shape is a server-computed analytics endpoint that returns the
aggregates already grouped, the way the Creator Network's analytics works.
Until then the tab keeps reading `/state`, which is no worse than it was and is
honest about being unmigrated.

**This phase did not change any number `eqAnalytics` displays.**

---

## 12. Recommended next phase

1. **Bookings and availability.** The remaining unbounded-ish Equipment array,
   and the one that needs a date-range query — which is also what a booking
   calendar wants. `equipment_bookings` can leave `/state` once `eqBookings`,
   `eqAvailability` and the calendar layer are migrated.
2. **A current-custody read model.** One endpoint answering "who holds what"
   retires `eqHolder()` across all six of its callers, and is the last consumer
   of `equipment_transactions` outside analytics. Only then can the ledger leave
   the boot payload.
3. **A server-computed analytics endpoint** (§11), which retires the last
   reader of both arrays and fixes the truncation bug at the same time.
4. **A scoped items endpoint** for the dashboard, My Day, kiosk, calendar and
   team consumers — after which `equipment_items` can leave `/state`.

**That is the point at which the boot payload actually shrinks.** Steps 1–4
each remove a dependency; none of them alone removes an array.

Maintenance workflow, reservations, academic inventory and RFID remain
explicitly out of scope, and no groundwork for them was laid here.

---

> **Superseded in part by Phase 7.** This document describes `/state` as still
> shipping the equipment history arrays, which was true when it was written.
> `equipment_transactions`, `equipment_bookings` and `maintenance_records` have
> since been **removed from `/state`** — see
> [ASSET_INVENTORY_STATE_CONSOLIDATION.md](ASSET_INVENTORY_STATE_CONSOLIDATION.md).
> `equipment_items` remains, and that document records why. Nothing else in the
> phase described here changed.
