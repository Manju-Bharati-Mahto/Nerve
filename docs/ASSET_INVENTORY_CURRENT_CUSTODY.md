# Current Custody

Phase 4 of the Asset & Inventory work: "who holds which asset" is now a
server-derived read model. Eleven places in the browser used to work it out by
sorting the transaction array `/state` had shipped.

**No custody table was created.** The ledger remains the source of truth.

---

## 1. What current custody is

An asset is in someone's hands when **its latest transaction is a `check_out`
that no `check_in` has followed.**

```
latest transaction per asset   (occurred_at DESC, id DESC)
        ↓
action = 'check_out'  →  that row is the custody
action = 'check_in'   →  nobody holds it
no transactions       →  nobody has ever held it
```

The action vocabulary is the schema's own. `mo_equipment_transactions` has a
CHECK constraint allowing exactly `check_out` and `check_in`; nothing here
invents a third, and there is no richer lifecycle to preserve.

**The tie-break is the primary key.** `occurred_at DESC, id DESC` — the rule
`liveCheckout()` already applied for a single asset. It matters: a kiosk return
recorded in the same second as the checkout it cancels would otherwise resolve
differently between runs. A test forces two rows to one timestamp and asserts
the answer five times in a row.

**Custody is not asset status.** A `status` column reading `checked_out` with
no ledger behind it is not custody, and a test asserts it is not treated as
such.

---

## 2. Source of truth

| Fact | Where it comes from | Authoritative because |
|---|---|---|
| who holds it | `mo_equipment_transactions.holder_id` on the latest row | the row the checkout endpoint wrote |
| when it went out | `occurred_at` (TIMESTAMPTZ) | same row |
| when it is due | `expected_return_at` (DATE, nullable) | same row |
| how it was recorded | `recorded_via`, `recorded_by` | same row |
| the project | `booking_id` → `mo_equipment_bookings.project_id` | the only place the schema records one |
| the department | `mo_equipment_items.department_id` | the asset's own column |

Check-in **appends** a row; it never edits the checkout. That is what makes
"latest" the whole of the definition and keeps the ledger append-only.

**Project is null for a checkout made without a booking**, which is most of
them. That is a real gap in the data, not a gap to paper over: the endpoint
returns `null` and the project filter correctly omits those loans rather than
guessing from the asset or the holder.

---

## 3. The endpoint

```
GET /equipment/custody
→ { items: [ { asset, custody, project, department } ], total, limit, offset, summary? }
```

One row:

```jsonc
{
  "asset":   { "id", "asset_tag", "make", "model", "serial_no",
               "category_id", "category_name", "status", "condition" },
  "custody": { "holder_id", "holder_name", "transaction_id",
               "checked_out_at",          // TIMESTAMPTZ — an instant
               "due_at",                  // DATE as 'YYYY-MM-DD', or null
               "overdue", "overdue_days",
               "recorded_via", "recorded_by", "recorded_by_name",
               "condition_noted", "booking_id" },
  "project":    { "id", "name" } | null,
  "department": { "id", "name" } | null
}
```

There is no `name` on an asset in this schema — the UI renders `make + model` —
so no `name` field is invented. Nothing else is returned that the schema cannot
answer.

A custody row carries **no history**: no transactions, no maintenance, no
bookings, no identifiers. A test asserts each of those is absent.

---

## 4. Filters

| Filter | Behaviour |
|---|---|
| `asset_id` | one asset |
| `holder_id` | one person; accepts the numeric prototype id or a real user id, via the existing `toUid` |
| `category_id`, `department_id` | the asset's own columns; `all` disables |
| `project_id` | through the booking the loan was made under |
| `recorded_via` | `desktop` / `mobile` / `kiosk` |
| `overdue` | `1` = past due; `0` = not past due, including no due date |
| `due_on_or_before` | a date — "due today or already late", which is the dashboard's own line |
| `include_retired` | `0` excludes retired assets; included by default (§6) |
| `q` | `ILIKE` over `asset_tag`, `make`, `model`, `serial_no` **and the holder's name** |
| `summary=1` | `{ total, overdue, due_today, holders }` over the same filters |

`q` follows the existing equipment read models' search exactly — the same four
asset columns, plus the holder, because "who has the Sony" and "what does Asha
have" are the same question asked two ways. No new search machinery.

---

## 5. Pagination

The clamp the other equipment read models already share: default 50, 1–200,
offset ≥ 0, nonsense clamped rather than trusted. `total` counts the whole
match, not the page. **There is no way to ask for the whole table.**

Ordering is `expected_return_at ASC NULLS LAST, asset_tag` — what is due
soonest first, which is what every consumer of this list wants.

---

## 6. Overdue semantics

```sql
overdue      = expected_return_at IS NOT NULL
               AND expected_return_at < (NOW() AT TIME ZONE 'Asia/Kolkata')::date
overdue_days = GREATEST(0, today_ist - expected_return_at)
```

- **The server's clock, in the zone the rest of Media Ops reports in.** Never
  the browser's. The old `overdueEquipment()` compared against a date derived
  from the viewer's machine.
- **DATE granularity is preserved**, because `expected_return_at` is a DATE.
- **Due today is not late.** The first day a loan is late is the day after it
  was due — the rule `overdueDays()` already encodes. Tested explicitly.
- **No due date is not overdue.** Tested explicitly.
- **Nothing is persisted.** Overdue is derived on every read.

---

## 7. Security

`requireEquipment` — Media Ops crew **and** the `equipment` module, the same
gate every other equipment read uses. No new role, no hardcoded user, no
weakening because it is a read.

Tested: module revoked → 403, not media crew → 403, unauthenticated → 403,
ordinary crew with the module → 200, custodian → 200, admin → 200.

The distinction between role, module access, scope and domain permission is
untouched: this endpoint asks only "may you see Equipment at all", exactly as
`GET /equipment` does. It does not introduce a per-holder scope, and it does not
claim to — see §11.

---

## 8. UI migration

`eqHolder()` had eleven call sites. All of them now read the server.

| Consumer | Now asks |
|---|---|
| `eqMine()` — "In my possession" | `?holder_id=<me>` |
| Equipment tab count, "My items" | the same query's `total` |
| My Day — "Equipment I hold" | `?holder_id=<me>` |
| Dashboard — "Equipment Due" | `?due_on_or_before=<today>` (+ `holder_id` for an employee) |
| `overdueEquipment()` — sidebar badge, header, BR-7 guard | `?overdue=1` |
| Kiosk return picker | `?holder_id=<the verified borrower>` |
| A colleague's profile | `?holder_id=<them>` |
| Admin roster, "Holds gear" | one `?limit=200`, grouped by holder |
| `deactivateUser` guard | `?holder_id=<them>` |

The client is `custodyAsk({…})`: **one request per question**, cached under the
question it asked. It is not a replacement dump — no consumer receives a
transaction, and none of them decides who holds anything. A test asserts that
twenty-five assets in custody still produce exactly one request for "what do I
hold".

The **per-asset** answer was already migrated in Phase 1 and is not re-asked: a
registry row carries `holder_id`/`holder_name`/`holder_due_at`, and the detail
page carries `holder`.

`eqInvalidate()` drops every cached custody answer, so a checkout or a check-in
makes the next render re-ask. There is no synchronisation step.

### `trgEquipStatus()`

Audited before touching. It mixes four things — lifecycle status, custody,
reservation and maintenance — and only the custody clause was migrated.

In a live session `checked_out` is written by `POST /equipment/checkout` and
cleared by check-in, so the status column already carries it. Re-deriving it in
the browser meant the browser could **overrule the server** on the one case
where they disagree. The clause now runs only when there is no server, where it
still reconciles the offline seed — the only remaining use of `eqHolder()`.

Reservation, maintenance and the rest of the status system are untouched. That
is Phase 5.

---

## 9. `/state` dependencies removed

Every live derivation of custody from `DB.equipment_transactions`.

**Proven, not asserted.** The UI suite empties `DB.equipment_transactions`
outright, resets any local `checked_out` status, *and* answers `/state` with a
network failure. The holder, the loan, the due date and the overdue count all
still render. Anything still deriving custody locally would have nothing to
derive it from.

**`/state` is not equipment-free, and this phase does not claim it is.** It
still ships `equipment_transactions`, `maintenance_records`, `equipment_bookings`
and `equipment_items` for the consumers listed in §11. The boot payload is
unchanged.

---

## 10. Performance

Fixture: **420 assets, 5,180 transactions, 140 currently out** — six complete
loans each, then a third checked out again and left out.

| | Rows | Bytes | Median |
|---|---|---|---|
| **Before** — the `/state` slice `eqHolder()` scanned | 540 | 142,201 | — |
| `GET /equipment/custody?limit=50` | 50 of 140 | 27,471 | 11.2 ms |
| `?holder_id=` — one person | 14 | **7,732** | 6.7 ms |
| `?overdue=1` | 64 | 35,149 | 6.3 ms |
| `?limit=200` — the admin roster | 140 | 76,910 | 7.4 ms |
| `?limit=50&summary=1` | 50 | 27,536 | 10.7 ms |

The comparison that matters is not row-for-row: **the browser used to scan 540
transactions to answer "what do I hold", and did it again at every one of eleven
call sites.** That question is now 7.7 KB and one query.

**Query count**: 2 per request (count + page), 3 with `summary=1`. No N+1, no
per-asset round trip, and no transaction reaches JavaScript.

### `EXPLAIN ANALYZE`

```
Limit (actual time=1.808..1.815 rows=50)
  Sort  Key: t.expected_return_at, i.asset_tag   (top-N heapsort, 30kB)
  ->  Nested Loop (actual time=0.047..1.626 rows=140)
        ->  Seq Scan on mo_equipment_items i (rows=420)
        ->  Limit  (loops=420)
              ->  Incremental Sort   Presorted Key: x.occurred_at
                    ->  Index Scan using idx_mo_txn_item on mo_equipment_transactions x
                          Index Cond: (equipment_item_id = i.id)
  Buffers: shared hit=1420       Execution Time: 1.851 ms
```

**No index was added.** The existing `idx_mo_txn_item (equipment_item_id,
occurred_at DESC)` — the one the registry's holder column already relies on —
serves the lateral directly. `occurred_at` comes back presorted, so only the
`id` tie-break needs sorting, over one or two rows per asset. 1.85 ms across
5,180 transactions, entirely from cache. The plan does not demonstrate that an
index is required, so none was added.

The `Seq Scan` over 420 items drives the loop. At department scale that is
correct and cheap; a much larger estate would want the item filters to reach an
index, which is a question for whoever hits it, with a plan in hand.

---

## 11. Known limitations

1. **Custody and the registry's holder column can disagree.** `ASSET_SELECT`
   gates its holder on `i.status = 'checked_out'` as well as the ledger, so an
   asset moved to `maintenance` while someone still holds it shows no holder
   there — while this endpoint, correctly, still names one. Reconciling them is
   Phase 5's work, not a change to make from here. A test pins the behaviour.
2. **No per-holder scope.** Anyone with the Equipment module can read the whole
   department's custody, which is what `/state` already gave them. This phase
   preserved that rather than inventing a scope rule.
3. **Project is frequently null**, because most checkouts are made without a
   booking (§2).
4. **The admin roster groups in the browser.** One `?limit=200` query, grouped
   by holder. Current custody is small by construction, but a department with
   more than 200 assets out at once would need a per-holder aggregate endpoint.
5. **`/state` still ships every equipment array.** `trgEquipStatus`'s
   reservation clause, the Shoots module and `eqAnalytics()` still read them.
   The boot payload does not shrink in this phase.
6. **`eqHolder()` still exists** for offline seed reconciliation. It is not
   reachable in a live session.

---

## 12. Recommended next phase

**Phase 5 — server-derived asset status.** With custody and bookings both
answered by the server, `trgEquipStatus()` can go entirely: `checked_out`,
`booked`, `maintenance` and `available` can each be derived where they are
enforced. That also resolves limitation 1 by making the registry's holder and
this endpoint agree by construction.

After that, a server-computed analytics endpoint retires the last reader of the
transaction, maintenance and booking arrays — and only then do those arrays
leave `/state` and the boot payload actually shrink.

---

> **Superseded in part by Phase 7.** This document describes `/state` as still
> shipping the equipment history arrays, which was true when it was written.
> `equipment_transactions`, `equipment_bookings` and `maintenance_records` have
> since been **removed from `/state`** — see
> [ASSET_INVENTORY_STATE_CONSOLIDATION.md](ASSET_INVENTORY_STATE_CONSOLIDATION.md).
> `equipment_items` remains, and that document records why. Nothing else in the
> phase described here changed.
