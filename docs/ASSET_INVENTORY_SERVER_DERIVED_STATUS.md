# Server-Derived Asset Status

Phase 5 of the Asset & Inventory work: what an asset *is* is now decided by the
server, once, from authoritative records. The browser prints it.

`trgEquipStatus()` is no longer a source of business truth.

---

## 1. Lifecycle status

**Persisted**, in `mo_equipment_items.status`, CHECK-constrained to
`available | checked_out | booked | maintenance | retired | lost`.

This column is genuinely authoritative for `available`, `maintenance`,
`retired` and `lost`: they are set by deliberate acts — a damage report, the
transition endpoint, retirement — and nothing else records them, so they cannot
be derived. **It was not replaced, and no status table was added.** Every
existing mutation guard (`canTransition`, `canRetire`, `canBook`, `canCheckOut`)
reads it, and changing that is a larger change than this phase.

Two values in that CHECK list are not lifecycle facts, and the audit is what
found it:

- **`checked_out`** is a custody projection. The checkout and check-in handlers
  write it alongside the ledger row, so it is kept — but custody is now read
  from the ledger, never from this column (§2).
- **`booked`** is written by **nothing on the server**. Only the browser's
  `trgEquipStatus()` ever produced it, in its own copy of the data. §11 records
  the consequence.

---

## 2. Custody status

**Derived**, from `mo_equipment_transactions`, using Phase 4's rule unchanged:

```
latest transaction per asset   (occurred_at DESC, id DESC)
  action = 'check_out'  →  custody.status = 'checked_out'
  action = 'check_in'   →  custody.status = 'not_held'
```

The action vocabulary is the CHECK constraint's own — exactly two values. The
`id` tie-break makes a tied timestamp resolve the same way on every run, and a
test asserts it five times in a row.

There is **one** custody algorithm on the server. `GET /equipment/custody` and
the state block are built from the same latest-transaction resolution; the
server never calls its own HTTP endpoints to answer a question.

---

## 3. Maintenance status

**Derived**, from `mo_maintenance_records`: a record is open when
`resolved_at IS NULL` — the semantics Phase 2 established, unchanged.

`maintenance.active` is whether **any** record is open, with `open_count`
beside it. A resolved record, or one from last year, is history: it does not
make an asset unavailable now, and a test asserts exactly that.

An open record does **not** move the lifecycle column. When they disagree, the
API says so rather than rewriting either (§12).

---

## 4. Reservation status

**Derived**, from `mo_equipment_bookings`, using the database's own CHECK
vocabulary: `reserved | active | completed | cancelled`.

`reservation` is the **soonest booking that is still live and has not ended**:

```sql
WHERE b.status IN ('reserved','active') AND b.ends_at >= today_ist
ORDER BY b.starts_at, b.id LIMIT 1
```

Cancelled, completed and past bookings are history. An asset is not "booked"
because it was booked last March, and tests cover all four cases plus a live
booking whose last day has passed.

Where several live bookings exist, the soonest wins — the one that matters now.
Overlapping live bookings for one asset are impossible: the exclusion
constraint prevents them.

---

## 5. Availability

**Deliberately not in the state block.** Availability is a question about a
date range, not a property of an asset: a camera free today may be unavailable
on 10–12 October. `GET /equipment/availability` remains the authority, with the
exclusion constraint's own overlap semantics, and nothing here duplicates it.

A test asserts the state block has no `availability` field, so it cannot quietly
acquire one.

---

## 6. Overdue

**Derived**, from custody plus the server's date:

```sql
overdue = custody exists
          AND expected_return_at IS NOT NULL
          AND expected_return_at < (NOW() AT TIME ZONE 'Asia/Kolkata')::date
```

DATE granularity, preserved. **Due today is not late** — the rule
`overdueDays()` already encoded. Nothing persisted; derived on every read.

---

## 7. Source of truth

| Fact | Source | Kind |
|---|---|---|
| lifecycle | `mo_equipment_items.status` | **persisted** |
| custody | `mo_equipment_transactions`, latest per asset | derived |
| maintenance | `mo_maintenance_records`, `resolved_at IS NULL` | derived |
| reservation | `mo_equipment_bookings`, live and not ended | derived |
| overdue | custody + server date | derived |
| availability | a date-range query | not here |

`lifecycle.persisted: true` is on the wire, so a caller never has to guess which
is which. No derived value is written back to any table.

---

## 8. API

No new endpoint. The state block rides on the reads that already exist, built
by **one shared SQL fragment and one shared assembler** (`STATE_JOINS`,
`STATE_SELECT`, `assetState()`), so the registry and the detail page cannot
disagree — a test asserts they return an identical block for the same asset.

```jsonc
"state": {
  "lifecycle":   { "status": "maintenance", "persisted": true, "unserviceable": true },
  "custody":     { "status": "checked_out", "holder_id", "holder_name",
                   "transaction_id", "checked_out_at", "due_at", "recorded_via" },
  "maintenance": { "active": true, "open_count": 2 },
  "reservation": { "status": "reserved", "booking_id", "starts_at", "ends_at",
                   "user_id", "project_id" },   // or null
  "derived":     { "overdue": true, "overdue_days": 4 },
  "conflicts":   ["held_but_lifecycle_maintenance"]
}
```

Carried by `GET /equipment` (each row), `GET /equipment/:id` (the item) and
`GET /equipment/resolve/:identifier`.

A dedicated `GET /equipment/status` was considered and **not** built: a fourth
list endpoint over the same rows is another place for the answers to diverge,
which is the problem this phase exists to remove.

### Two header figures were wrong, and are fixed

- **`summary.booked` was structurally zero.** It counted `i.status='booked'`, a
  value the server never writes. From the moment Phase 1 moved the header onto
  the server summary, the figure could not be anything but 0 however many
  bookings existed. It now counts assets with a live booking that has not
  ended.
- **`summary.overdue` used `CURRENT_DATE`** while custody used IST, so the two
  could differ by a day. Both now use the same server date.

Note that `booked` therefore **overlaps** `available`: an available asset with a
booking next week is in both. `available`/`checked_out`/`maintenance` partition
the lifecycle column; `booked` is orthogonal to them, and the test that used to
sum all four was corrected to say so.

---

## 9. Authorization

`requireEquipment` on every state-bearing read — unchanged, fail-closed. No new
role, no hardcoded user, no scope rule invented. Holder, project and department
information reaches only callers who already had it through these endpoints.

---

## 10. Query strategy

Three LATERALs per row, evaluated only for the rows on the page:

```
latest transaction  → idx_mo_txn_item (equipment_item_id, occurred_at DESC)
open maintenance    → idx_mo_maint_open (partial)
soonest live booking→ idx_mo_booking_item_live (partial)
```

No transaction, booking or maintenance record reaches JavaScript to be reduced
there. Query count per request is unchanged: count + page, plus the summary
when asked.

---

## 11. UI migration

| Consumer | Before | After |
|---|---|---|
| registry status cell | `statusPill(e.status)` | `state.lifecycle` + separate custody / maintenance / reservation / overdue chips |
| registry Check out button | `e.status==='available'` | `state.lifecycle` **and** `state.custody` |
| registry Check in button | `holder_id===S.me` | `state.custody.holder_id` |
| detail header | one pill + an "in hand" chip | the five facts, separately |
| detail actions | `e.status` | `state` |
| dashboard "Equipment Out" | counted `DB.equipment_items` | `GET /equipment?summary=1` |
| `trgEquipStatus()` | rewrote statuses live | **returns immediately in a live session** |

`trgEquipStatus()` now returns at its first line whenever `__MO_LIVE__` is set.
Every clause in it re-derived something the server answers, and its remaining
live callers are the optimistic write paths, which re-hydrate straight after.
Offline it still reconciles the seed, which is the only thing `eqHolder()` is
left for. Tests cover both directions.

**An unknown state is never shown as available.** A row the server has not
answered for renders `Status unknown` and offers no Check out button; a failed
dashboard summary shows an em dash, not a zero. False availability is how two
people end up with one camera, so "nothing is out" and "we could not find out"
are drawn differently.

### Registry holder columns

`holder_id` / `holder_name` / `holder_due_at` used to be gated on
`i.status = 'checked_out'` as well as the ledger, so an asset moved to
maintenance while held showed no holder in the registry while
`GET /equipment/custody` still named one. **That was Phase 4's known limitation
and it is now closed** — they come from the same ledger resolution as
everything else.

---

## 12. Conflicting states

The data permits contradictions, and they are **reported, not resolved**:

| `conflicts` entry | What it means |
|---|---|
| `held_but_lifecycle_<x>` | the ledger says someone has it; the column says otherwise |
| `lifecycle_checked_out_but_not_held` | the column says out; the ledger says returned |
| `open_maintenance_but_lifecycle_<x>` | a repair is open; the column has not moved |
| `retired_with_live_booking` | retired, yet a live booking remains |
| `retired_while_held` | retired while somebody still holds it |

Both facts are returned in every case, and the UI shows a `state conflict`
badge. **No rule was invented to pick a winner**: the schema, the handlers and
the tests do not contain one, so choosing would be making business policy. These
are flagged for a human decision — see §14.

One case *does* have a rule in the existing code and is followed: retirement
cancels live bookings (`UPDATE … SET status='cancelled' WHERE status IN
('reserved','active')`), so `retired_with_live_booking` should not arise through
the retire endpoint. It is detected because the data can still reach that shape
another way.

---

## 13. Performance

Fixture: **420 assets, 5,180 transactions, 2,100 bookings, 1,260 maintenance
records.**

| | Rows | Bytes | Median |
|---|---|---|---|
| `GET /equipment?limit=50` | 50 | 52,747 | **5.0 ms** |
| `…&summary=1` | 50 | 52,860 | 8.7 ms |
| `GET /equipment/:id` | 1 | 5,474 | 4.1 ms |
| `GET /equipment/custody?limit=50` | 50 | 26,819 | 7.4 ms |

**Two indexes were added, on the evidence of a plan and not before it.** The
first measurement of the state-bearing registry was **37.9 ms**, and
`EXPLAIN ANALYZE` said why: `mo_maintenance_records` had **no index on
`equipment_item_id` at all**, so the open-repair lookup did a Seq Scan per row —
420 loops, 5,460 buffers, roughly 28 ms of the 38. The booking lookup could not
use the exclusion constraint's GiST index either: that index is on a daterange,
and this asks for the earliest start.

```sql
CREATE INDEX idx_mo_maint_open        ON mo_maintenance_records(equipment_item_id)
  WHERE resolved_at IS NULL;
CREATE INDEX idx_mo_booking_item_live ON mo_equipment_bookings(equipment_item_id, starts_at)
  WHERE status IN ('reserved','active');
```

Both are partial, so they index only the rows the question is about and stay
small as history grows. After them:

```
Limit (actual time=0.133..0.880 rows=50)
  Index Scan using mo_equipment_items_asset_tag_key on mo_equipment_items i
  ->  Index Scan using idx_mo_txn_item        (loops=50)
  ->  Index Only Scan using idx_mo_maint_open (loops=50)
Buffers: shared hit=507
```

**37.9 ms → 5.0 ms; buffers 8,151 → 507.** The page is now faster than it was
before this phase, because the laterals run for the 50 rows on the page rather
than for all 420.

---

## 14. Known limitations

1. **`booked` remains in the lifecycle CHECK constraint** although nothing
   writes it. Removing it is a migration, and the value would have to be
   translated out of any existing row first.
2. **`checked_out` is still persisted on the asset** as well as derived from the
   ledger. The API always answers from the ledger, and reports it when the two
   disagree — but the column is still there, and every mutation guard reads it.
   Collapsing it is a schema change with real blast radius.
3. **Conflicts are detected, not resolved** (§12). Five combinations need a
   business-rule decision. This phase deliberately does not make it.
4. **The dashboard counts assets, not units.** It used to sum `pool_quantity`;
   the server summary has no unit figure. One honest number was preferred to two
   that disagree, but the figure changed meaning slightly for pooled assets.
5. **Three consumers still read `DB.equipment_items[].status` from `/state`** —
   the kit picker, the kiosk checkout pool and the assign-work gear list. They
   read the *persisted* column, which is now exactly what the server stored
   (nothing rewrites it locally any more), so they are more correct than before;
   they are simply not yet on an endpoint.

---

## 15. Remaining `/state` dependencies

**`/state` is not equipment-free, and this phase does not claim it is.** It
still ships `equipment_items`, `equipment_transactions`, `equipment_bookings`
and `maintenance_records`, for:

- `trgEquipStatus()` — **offline only** now, so no live decision depends on it
- the three consumers in §14.5, reading the persisted column
- the Shoots module, in three places
- `eqAnalytics()`, which still reduces the arrays and is Phase 6's work
- every offline/optimistic write path

Removing the arrays belongs to the later consolidation phase. What changed here
is that **no live status decision is made from them.**

---

> **Superseded in part by Phase 7.** This document describes `/state` as still
> shipping the equipment history arrays, which was true when it was written.
> `equipment_transactions`, `equipment_bookings` and `maintenance_records` have
> since been **removed from `/state`** — see
> [ASSET_INVENTORY_STATE_CONSOLIDATION.md](ASSET_INVENTORY_STATE_CONSOLIDATION.md).
> `equipment_items` remains, and that document records why. Nothing else in the
> phase described here changed.
