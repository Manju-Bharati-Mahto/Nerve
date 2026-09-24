# Server-Computed Equipment Analytics

Phase 6 of the Asset & Inventory work: the Equipment analytics screen is
computed by the database. `eqAnalytics()` no longer reduces anything.

---

## 1. The `eqAnalytics()` audit

Three blocks, four metrics, all reduced in the browser from three `/state`
arrays. Two of those arrays are capped, so **every figure on the screen was
computed over a window nobody chose**.

| Block | Metric | Calculation | Source array | Truncated? |
|---|---|---|---|---|
| Checkouts by category | bar value | `Σ(check_out count per item) × 2` | items + transactions | **yes** |
| Demand heatmap | bar value | `count of bookings per weekday of starts_at` | bookings | **yes** |
| Per-item utilisation | Checkouts | `check_out count for the item` | transactions | **yes** |
| | Utilisation % | `min(100, checkouts × 14)` | transactions | **yes** |
| | Maintenance | `Σ cost of the item's records` | maintenance | no (uncapped) |
| | Purchase cost, Condition | item columns | items | no |

The caps, from `/state`:

- **transactions** — "the latest row per item, plus the 500 most recent overall"
- **bookings** — "live, or ended within the last 90 days"

On the benchmark fixture that meant **670 of 5,880 transactions were visible —
11%**. A per-item checkout count of 3 could mean three or three hundred.

**Scope**: global, and no date range. The Analytics module passes a `from` to
its other reports and `eqAnalytics()` **ignores it** — it has always shown all
of history.

### Two ambiguities, reported rather than resolved

`× 2` and `× 14` are magic constants with no basis in the data. The category
chart is titled "Checkouts by category" but plots checkouts doubled; the
utilisation bar reaches 100% at seven checkouts regardless of how long anything
was out. The card's own tooltip says "Checked-out days ÷ available days", which
is **derivable** from the ledger — but choosing it would be deciding a metric
definition, not fixing a source.

**Both formulas are unchanged.** They now consume a correct count. See §14.

---

## 2. Metric definitions

| Metric | Definition | Kind |
|---|---|---|
| `by_category[].checkouts` | `check_out` transactions for assets in the category | historical |
| `by_category[].items` | distinct assets in the category | current |
| `by_weekday[].bookings` | bookings whose `starts_at` falls on that weekday, **any status** | historical |
| `items[].checkouts` | `check_out` transactions for that asset | historical |
| `items[].maintenance_cost` | `SUM(cost)` of that asset's maintenance records | historical |
| `items[].purchase_cost`, `condition` | the asset's own columns | current |

`by_weekday` counts a booking whatever its status, which is what the heatmap has
always done: it is a **demand** signal, and a cancelled booking is still someone
having wanted the gear that day.

---

## 3. Source of truth

| Metric | Table |
|---|---|
| categories, item counts | `mo_equipment_categories`, `mo_equipment_items` |
| checkouts | `mo_equipment_transactions` (`action='check_out'`) |
| weekday demand | `mo_equipment_bookings` |
| maintenance cost | `mo_maintenance_records` |

No analytics table, no materialised storage, no internal HTTP calls, and no
metric derived from another endpoint.

---

## 4. Current vs historical

**Everything in this endpoint is historical** — counts of things that happened.

`checkouts` is the number of check_out transactions, **never** the number of
assets currently out. That is a current-state question and is answered by
custody and by `GET /equipment?summary=1`.

**No current-state summary was added here**, deliberately: `eqAnalytics()`
displays none, and `?summary=1` already returns total / available /
checked_out / booked / maintenance / overdue. A second place to compute those is
exactly what Phase 5 spent its effort removing.

---

## 5. Endpoint

```
GET /equipment/analytics
  ?from= &to= &department_id= &category_id= &limit=50 &offset=0

→ { from, to,
    by_category: [{ category_id, category_name, items, checkouts }],
    by_weekday:  [{ dow, bookings }]           // seven entries, 0 = Sunday
    items:       [{ id, asset_tag, make, model, category_id, category_name,
                    condition, purchase_cost, checkouts, maintenance_cost }],
    total, limit, offset }
```

Breakdowns arrive **already aggregated** — the browser renders, it does not
group. `by_weekday` is always seven entries, zero-filled, so the chart needs no
gap handling.

The per-item table is paginated with the clamp every equipment read model
shares (default 50, 1–200). `eqAnalytics()` rendered every non-pooled asset;
paging it is the same change Phases 1–3 made everywhere else, and it stops the
response growing with the estate.

---

## 6. Filters

| Filter | Meaning |
|---|---|
| `from` / `to` | inclusive date range on the historical metrics |
| `department_id` | the asset's department |
| `category_id` | the asset's category |
| `limit` / `offset` | the per-item table only |

Only filters with an existing meaning. No range means **all of history**, which
is what the screen has always shown — the UI passes none, so behaviour is
unchanged. The Analytics module could now honour the `from` it already has;
wiring that would change displayed figures, so it was left alone.

---

## 7. Date semantics

**Inclusive at both ends**, and compared as a **day**:

| Record | Column | Comparison |
|---|---|---|
| transaction | `occurred_at` (TIMESTAMPTZ) | `(occurred_at AT TIME ZONE 'Asia/Kolkata')::date` |
| booking | `starts_at` (DATE) | as written |
| maintenance | `started_at` (DATE) | as written |

The IST conversion is the one `GET /equipment/transactions` already applies, so
a transaction belongs to the same day in both. A test asserts that 01:00 IST on
the 2nd — 19:30 UTC on the 1st — counts on the 2nd.

No DATE value passes through a JS `Date`: all filtering is SQL-side, and the
aggregates are numbers, so the Phase 3 timezone shift cannot recur here.

---

## 8. Security

`requireEquipment` — Media Ops crew and the `equipment` module, the same gate as
every other equipment read. No new role, no scope rule invented.

**The existing client gate is cosmetic, and this was checked rather than
assumed.** `equipment.analytics` in the browser's CAPS table is `team_lead` and
`admin` only, but the server has never read that table, and `/state` ships the
raw arrays to every media user — so any employee could already compute these
figures. `requireEquipment` therefore **preserves the current data exposure
exactly**: it neither widens nor tightens it. Tightening would be inventing an
authorization rule, which this phase does not do. Recorded in §14 as a decision
somebody should make deliberately.

---

## 9. Query strategy

Three aggregate queries plus a count — four per request, no N+1:

1. **`by_category`** — one `GROUP BY c.id` over a left join, not a query per
   category. Categories with nothing in them come back as zero.
2. **`by_weekday`** — one `GROUP BY EXTRACT(DOW ...)`. Postgres numbers Sunday
   as 0, which is what the browser's `D.dow()` returns, so the buckets line up
   without a translation table.
3. **`items`** — two correlated aggregates per asset, for the page only.
4. **count** — the pager's total.

No history is sent anywhere to be reduced.

---

## 10. Performance

Fixture: **420 assets, 5,880 transactions, 2,100 bookings, 1,260 maintenance
records.**

| | Rows | Bytes | Median | p95 |
|---|---|---|---|---|
| **Before** — what `eqAnalytics()` reduced | 3,190 | **802,753** | — | — |
| `GET /equipment/analytics?limit=50` | 50 | **11,010** | 20.8 ms | 28.6 ms |
| …with a date range | 50 | 11,026 | 42.0 ms | 47.8 ms |

**98.6% smaller** — and the old input was not merely large, it was *wrong*:
**670 of 5,880 transactions**, 11% of the history it claimed to summarise.

The dated variant is slower because `(occurred_at AT TIME ZONE 'Asia/Kolkata')::date`
is not indexable. No expression index was added: the UI passes no range, so it
would be an index for a query nobody makes.

---

## 11. Index decisions

One added, one measured and **rejected** — both on the evidence of a plan.

| Candidate | Before | After | Verdict |
|---|---|---|---|
| `mo_maintenance_records(equipment_item_id)` | 15.02 ms / 12,258 buffers | **1.70 ms / 3,438** | **added** |
| `mo_equipment_transactions(equipment_item_id, action)` | 15.18 ms / 12,264 | 15.02 ms / 12,258 | **rejected** |

The maintenance index was needed because Phase 5's `idx_mo_maint_open` is
partial (`WHERE resolved_at IS NULL`) and cannot serve a sum over *all* of an
asset's records. The transactions index bought six buffers: `idx_mo_txn_item`
already covers that count, and an index that buys nothing still costs every
write.

---

## 12. UI migration

`eqAnalytics()` now renders `GET /equipment/analytics`. It performs **no
aggregation**: the charts map the server's arrays, and the table maps its rows.
There is no `eqAnalyticsFromServer()` doing the old reduction over new data.

Both callers are unchanged — the Equipment page's Analytics tab and the
Analytics module's `equipment` report.

`eqInvalidate()` clears the cached analytics, so a checkout, booking or repair
makes the next render re-ask.

---

## 13. Truncation regression

The test that would fail if anyone rebuilt analytics from `/state`:

- **1,200 checkouts on one asset.** The test first computes what `/state` *would*
  have shipped for that asset under its own cap, asserts the fixture is bigger
  than it, then asserts analytics report exactly 1,200. The failure message
  prints both numbers.
- **300 bookings from 2024**, all completed, all outside the 90-day window — the
  test asserts `/state` would ship **zero** of them, and that all 300 still
  reach the heatmap.
- **600 maintenance records**, summed to the exact rupee.

---

## 14. Error semantics

**An error is never a zero.** A failed analytics request renders "Analytics
could not be computed" with a Retry button, and **no charts and no table** —
tested by asserting the page contains no table rows and not even the section
heading. Drawing empty charts would read as "this department owns nothing and
books nothing", which is a different and far more dangerous claim than "we could
not find out". This is the Phase 5 dash-not-zero rule, applied to charts.

An **empty** department is distinguished from a failed one: "Nothing to compare
yet" and "No checkouts recorded yet", with no error styling.

### Decisions still owed

1. **`× 2` and `× 14`** (§1). Both preserved, both unexplained. The real
   utilisation — checked-out days over elapsed days — is derivable from the
   ledger and should replace `× 14` once someone decides that is the metric.
2. **Who may see analytics.** The client capability says team_lead and admin;
   the server has never enforced it and `/state` never respected it (§8).

---

## 15. Contradiction handling

Phase 5's five conflict types are **not aggregated here**. No analytics screen
asks for totals of them, and inventing the aggregate would be inventing the
requirement. Analytics preserve the Phase 5 derived-state semantics: contradictory
assets are reported per asset on the state block and are **never silently
classified** as available or unavailable to make a total add up.

---

## 16. Remaining `/state` consumers

**Analytics no longer read `/state`. The arrays are still shipped**, and this
phase does not remove them:

| Array | Still read by |
|---|---|
| `equipment_transactions` | offline seed reconciliation, offline write paths |
| `equipment_bookings` | the Shoots module (3 places), offline writes, `trgEquipStatus` offline |
| `maintenance_records` | `trgEquipStatus` offline, offline writes |
| `equipment_items` | kit picker, kiosk pool, assign-work list, Shoots, offline paths |

Removing them is the consolidation phase, after those consumers are mapped.

---

> **Superseded in part by Phase 7.** This document describes `/state` as still
> shipping the equipment history arrays, which was true when it was written.
> `equipment_transactions`, `equipment_bookings` and `maintenance_records` have
> since been **removed from `/state`** — see
> [ASSET_INVENTORY_STATE_CONSOLIDATION.md](ASSET_INVENTORY_STATE_CONSOLIDATION.md).
> `equipment_items` remains, and that document records why. Nothing else in the
> phase described here changed.
