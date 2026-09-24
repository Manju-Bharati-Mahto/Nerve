# Bookings and Availability

Phase 3 of the Asset & Inventory work: the booking schedule, the availability
grid, the booking picker and the calendar's equipment layer now read the
server. Availability became a question the **database** answers, in the
exclusion constraint's own terms.

No booking policy was redesigned, no visual layout was changed, and no parallel
booking engine was built.

---

## 1. Existing booking architecture

Audited before anything was written.

### The table

```sql
mo_equipment_bookings (
  id, equipment_item_id → mo_equipment_items ON DELETE CASCADE,
  user_id → users, shoot_id → mo_shoots, project_id → mo_projects,
  starts_at DATE NOT NULL, ends_at DATE NOT NULL,
  status TEXT CHECK (status IN ('reserved','active','completed','cancelled')),
  created_by → users,
  EXCLUDE USING gist (
    equipment_item_id WITH =,
    daterange(starts_at, ends_at, '[]') WITH &&
  ) WHERE (status IN ('reserved','active'))
)
```

The exclusion constraint is the strongest thing in the module and predates this
phase. It is backed by `btree_gist`, which the bootstrap treats as fatal if
unavailable.

### The endpoints, before

| Endpoint | Gate |
|---|---|
| `POST /equipment/bookings` | `requireEquipment` — media crew + the `equipment` module |
| `POST /equipment/bookings/:id/cancel` | same, plus owner-or-custodian |

**There was no way to read bookings.** Every screen that showed one got it from
the `/state` dump.

### The consumers, before

| Consumer | Read | Outcome |
|---|---|---|
| `eqBookings()` — the Bookings tab | the whole array, sorted | **migrated** |
| Bookings tab count | `.filter(status!=='completed').length` | **migrated** |
| `eqAvailability()` — the 14-day grid | every asset × 14 days × the array | **migrated** |
| `ACTIONS.bookingCheck()` — the booking picker | a client-side conflict scan | **migrated** |
| `eqMine()` — my bookings | `user_id === S.me` | **migrated** |
| the calendar's `bookings` layer | per-day filter over the array | **migrated** |
| `trgEquipStatus()` | derives an item's `booked` status | left — §11 |
| Shoots module (3 places) | bookings for a shoot | left — another module |
| `eqAnalytics()` | day-of-week distribution | left — a later phase |
| offline write paths | push/mutate locally | left — standalone mode |

---

## 2. Booking semantics

Read out of the schema and the handlers; **none of this was changed.**

**What a booking is.** One asset, one person, one inclusive date window, with an
optional link to a shoot and a project.

**What a conflict is.** The constraint's own definition, and nothing else:

> the same `equipment_item_id`, and `daterange(starts_at, ends_at, '[]')`
> overlapping, **while both bookings are `reserved` or `active`**.

So a `cancelled` or `completed` booking conflicts with nothing — it is outside
the constraint's `WHERE` clause. This phase adopts that same predicate
everywhere rather than restating it.

**Status.** `reserved` on creation. → `active` when the asset is checked out
under that booking. → `completed` on check-in. → `cancelled` explicitly, or when
the asset is retired (future reservations are released; history is untouched).
Nothing writes `booked` to an item: that status is still derived in the browser
by `trgEquipStatus()` (§11).

**Who may do what.** Create: any media crew member with the `equipment` module,
on an asset that exists and is not `maintenance`/`retired`/`lost`. Cancel: the
person who booked it, or an Admin or `equipment_custodian`. Both unchanged.

**Validation.** `canBook(from, to)` in `server/equipment-rules.ts` — dates
required, end on or after start, at most `MAX_BOOKING_DAYS` (30). The
availability endpoint applies the **same function**, so it cannot report on a
window that could never be booked.

**Department scope.** A booking has no department of its own; it inherits the
asset's `department_id`, which is what both new endpoints filter on.

---

## 3. Date/time semantics

**Both ends are inclusive.** `'[]'` is the whole of it: a booking ending on the
3rd and one starting on the 3rd **conflict**; the first free window begins on
the 4th. Anything that computes availability differently will call something
free that the `INSERT` then refuses.

**A booking is days, not instants.** `starts_at`/`ends_at` are `DATE`. There is
no intra-day granularity — a morning and an afternoon booking of one camera on
one day cannot be expressed. That is a schema limitation, recorded in the audit
and unchanged here (§11).

**Timezone.** A `DATE` carries no zone, so a range comparison needs no
conversion; the window is compared as written. Timezone only enters where "now"
does, and the codebase's convention for that — `(NOW() AT TIME ZONE
'Asia/Kolkata')::date` — is what the transaction read model already uses.

### A defect found and fixed here

`node-postgres` parses a `DATE` into a **JS Date at local midnight**, and
`res.json()` renders that in UTC. East of Greenwich, every date selected plainly
was serialised as **the day before**:

```
'2026-11-02'::date  →  JSON "2026-11-01T18:30:00.000Z"    ← wrong day
to_jsonb(row)       →  JSON "2026-11-02"                  ← correct
```

`/state` never had the bug: it ships rows through `to_jsonb()`. The Phase 1 and
Phase 2 read models did, because they select columns directly. **Nine date
columns across four tables were affected** — the asset's purchase, warranty and
insurance dates; a transaction's `expected_return_at`; a maintenance record's
`started_at`, `resolved_at` and `next_due_at`; and a booking's `starts_at` and
`ends_at`.

Every equipment read model now serialises dates in SQL (`to_char(col,
'YYYY-MM-DD')`, or `to_jsonb(t) || jsonb_build_object(…)` where the query takes
whole rows). A test asserts the round trip and that no date carries a `T` or a
`Z`. The overdue arithmetic was deliberately **not** touched: it runs on the raw
value, and only what reaches the client was normalised.

---

## 4. Availability query

```
GET /equipment/availability
  ?from=YYYY-MM-DD&to=YYYY-MM-DD        (required)
  &asset_id= &category_id= &department_id= &status= &q=
  &individual_only=1 &include_retired=1 &limit=50 &offset=0

→ { from, to, total, limit, offset, items: [ …asset…, available, blocked_by, bookings[] ] }
```

**The decision is the database's, in the constraint's own words:**

```sql
(i.status <> ALL($unserviceable)) AND NOT EXISTS (
  SELECT 1 FROM mo_equipment_bookings b
   WHERE b.equipment_item_id = i.id
     AND b.status IN ('reserved','active')
     AND daterange(b.starts_at, b.ends_at, '[]') && daterange($from, $to, '[]')
) AS available
```

That is the exclusion constraint's predicate, character for character. What this
endpoint calls free is what the `INSERT` accepts, and what it calls taken is
what the constraint refuses — asserted in both directions by a test.

- `blocked_by` is `'status'`, `'booking'` or `null`, so the UI can say *why*.
- `bookings[]` carries the overlapping windows for the assets **on this page**,
  so a grid can paint them without deciding anything.
- `checked_out` does **not** block: an asset out today can be booked for a
  window after it returns, which is what the picker has always allowed. Only
  `maintenance`/`retired`/`lost` block — the same list `POST /equipment/bookings`
  refuses on.
- The window is validated with `canBook`, so a 45-day question is refused with
  the same VR-8 message a 45-day booking gets.

**Availability is not a promise.** It is what the ledger said at the moment of
asking. The constraint is still the only thing that decides a booking (§6).

---

## 5. Booking read model

```
GET /equipment/bookings
  ?from= &to= &asset_id= &user_id= &status= &category_id=
  &department_id= &project_id= &shoot_id= &limit=50 &offset=0 &summary=1

→ { items, total, limit, offset, summary?: { total, reserved, active, cancelled, completed } }
```

Row: the booking's own columns plus `asset_tag`, `make`, `model`,
`category_id`, `user_name`, `shoot_title` and `project_name` — enough to draw a
row without three more arrays being present.

**`status` takes a comma-separated subset of the four values the CHECK
constraint allows**, or `all`. No screen needed a word the schema does not have:
the Bookings tab asks for `reserved,active,cancelled` (what it has always
shown), the calendar asks for `reserved,active` (what the constraint itself
scopes to). An unrecognised word is dropped rather than obeyed.

**`from`/`to` is an overlap, not a containment** — the same inclusive test as
§4. A booking that began in May and ends in June belongs to June's calendar. A
containment query would lose every booking that straddles a month boundary.

**Ordering is `starts_at, id` ascending.** This is a schedule before it is a
history, and ascending is what the Bookings tab has always shown. The `id`
tie-break keeps paging stable when two bookings start on the same day.

**Pagination** is the registry's clamp, shared: default 50, 1–200, offset ≥ 0,
nonsense clamped. There is no way to ask either endpoint for the whole table.

---

## 6. Conflict protection

**Unchanged, and deliberately so.** `POST /equipment/bookings` still inserts and
still catches SQLSTATE `23P01`:

```
request A ─┐
request B ─┤→ both read availability → both told "free"
           └→ INSERT → the EXCLUDE constraint → one 201, one 409 (AC-7)
```

No check-then-insert was introduced. The availability endpoint is a **read**;
it does not reserve, lock or pre-claim anything, and the handler does not
consult it before inserting.

Two tests hold this down:

- two concurrent requests for overlapping windows on one asset — **both are
  told the asset is free first**, which is the honest answer at the moment each
  asked, and is exactly why the verdict cannot live in the reader. Then exactly
  one 201, exactly one 409, and exactly one live row in the table.
- eight simultaneous requests on one window — one 201, seven 409, one row.

---

## 7. Calendar migration

The layer used to filter `DB.equipment_bookings`, which `/state` ships as
"everything live, plus ninety days" — a window nobody chose.

It now asks for **exactly the days on screen**: one range covering both the
42-cell month grid and the 21-day agenda. Changing month changes the range,
which changes the cache key, which is what re-asks. Nothing else about the
calendar moved: same layers, same toggles, same chips, same colours, same drag
behaviour.

Two honesty additions, because a calendar that silently drops events is worse
than one that admits it:

- if the range holds more bookings than the 200-row page, the legend says
  `Showing 200 of N equipment bookings in this range`;
- if the layer could not be loaded, the legend says so instead of rendering an
  empty month as though it were a quiet one.

**One behavioural consequence, stated plainly.** The layer now reads a
module-gated endpoint, so it is only fetched by someone who holds the
`equipment` module. Before, `/state` handed equipment bookings to every media
user regardless — which the audit recorded as finding S9. Every media role has
`equipment` by default, so this changes nothing on a default install; it affects
only an account an administrator has explicitly revoked Equipment from, and for
that account the module gate is the existing rule, not a new one.

Employees still see only their own bookings on the calendar. That was
`scoped()`, a client-side filter; it is now the read model's `user_id` filter,
asked of the server. `scoped()` remains in place as the same check it always
was — it is simply no longer the thing doing the filtering.

---

## 8. `/state` dependencies removed

| Consumer | Before | After |
|---|---|---|
| `eqBookings()` | `DB.equipment_bookings` | `GET /equipment/bookings` |
| Bookings tab count | `.filter(…).length` | `total` |
| `eqAvailability()` | the array, × every asset × 14 days | `GET /equipment/availability` |
| `ACTIONS.bookingCheck()` | a client-side conflict scan | `GET /equipment/availability` |
| `eqMine()` — my bookings | `user_id === S.me` | `?user_id=` |
| calendar `bookings` layer | per-day filter over the array | `?from=&to=&status=reserved,active` |

**Proven, not asserted.** The UI suite answers `/state` with a network failure
and empties `DB.equipment_bookings` outright; the tab, the grid, the picker and
the calendar all still draw. If any of them reaches back into that array, the
test fails.

`/state` itself is untouched — no field removed, no other module changed.

---

## 9. Performance

Measured against a real server and database. Fixture: **400 assets, 2,400
bookings (1,200 live)** — a monthly window per asset across a year.

| | Rows | Bytes | Median |
|---|---|---|---|
| **Before** — `/state` booking array | 1,200 | 216,001 | — |
| `GET /equipment/bookings?limit=50` | 50 (of 2,400) | **15,828** | 9.8 ms |
| calendar month (overlap, limit 200) | 200 | 63,230 | 5.9 ms |
| availability, 14 days × 25 assets | 25 (of 400) | **11,298** | 4.7 ms |
| availability, 14 days × 200 assets (the picker) | 200 | 89,840 | 7.8 ms |

**The schedule's payload fell from ~216 KB to ~16 KB — 93% smaller — and is now
constant per page rather than proportional to the department's booking history.**
It is also the first version that can reach all 2,400 bookings: `/state` ships
only what is live plus ninety days.

**Query count.** The schedule costs 2 queries (count + page), 3 with
`summary=1`. Availability costs 3 (count, page, and the windows behind the
verdict for that page). Before, all of it rode on `/state`'s ~60 sequential
queries and then cost the browser a scan per asset per day.

**The overlap uses the exclusion constraint's own index.** `EXPLAIN ANALYZE` on
the per-asset overlap:

```
Bitmap Heap Scan on mo_equipment_bookings b
  Recheck Cond: ((daterange(starts_at, ends_at, '[]') && '[2026-09-01,2026-09-15)'::daterange)
                 AND (status = ANY ('{reserved,active}')))
  Buffers: shared hit=13
```

No index was added: writing the predicate in the constraint's own terms is what
makes its GiST index usable for reading as well as for enforcing.

### What has *not* changed

**The boot payload is unchanged by this phase.** `/state` still ships
`equipment_bookings`, because `trgEquipStatus()`, the Shoots module and
`eqAnalytics()` still read it (§11). What changed is that no booking *screen*
depends on it.

---

## 10. Tests

**API — `server/mediaops-equipment.integration.test.ts`, 84 → 110 (+26):**

- availability: free, taken, the inclusive boundary in both directions, and
  **that the INSERT agrees with the boundary**
- cancelled, completed and historical bookings do not hold a window
- single-day windows; `checked_out` does not block; `maintenance` does, as
  `blocked_by: 'status'`
- category, department, search and `individual_only` filters
- window validation rejects the same shapes a booking rejects, with VR-8's message
- pagination, non-overlapping pages, clamped nonsense, empty results
- the read model: page/total, ascending order, overlap-not-containment and its
  boundary days, status subsets, unknown status words dropped, user/category/
  department/project/shoot filters, row contents, `summary=1`, gating
- **dates survive the round trip** — `2028-11-02` reads back as `2028-11-02`,
  with no `T` and no `Z`, from the read model and from the detail page
- authorization on both endpoints: no module, not crew, unauthenticated

**Concurrency, explicitly:** two requests told "free" then racing to insert —
one 201, one 409 with AC-7, one row. And an eight-way pile-up on one window.

**UI — `src/test/equipment-read-model.ui.test.ts`, 34 → 59 (+25),** booting the
real page with `/state` failing:

- each of the four screens loads through its endpoint, **once**, and never asks
  for `/state`
- all four still draw with `DB.equipment_bookings` emptied
- the six Bookings columns, Cancel and ＋ Book are unchanged
- filters and paging go to the server; a filter change returns to page 1
- the availability grid asks for exactly the fourteen days it draws
- the footer names `daterange` — the constraint's actual type — not `tstzrange`
- **the picker offers nothing at all when availability cannot be checked**, and
  refuses a backwards or over-long window without asking
- the calendar asks for the range on screen, covers grid and agenda, re-asks on
  a month change and not otherwise, and says so when truncated or failed
- loading, empty, error-with-retry for every screen
- a booking marks all four reads stale
- cancelling a booking the browser has never seen does not throw

---

## 11. Remaining limitations

1. **`DATE` granularity.** No intra-day booking. A morning and an afternoon
   booking of one camera on one day cannot be expressed, and the constraint
   would refuse the second. Changing this means `tstzrange` and a migration.
2. **`trgEquipStatus()` still derives `booked` in the browser**, from the
   `/state` array, for items that have a reserved booking within two days. The
   server never writes that status. This is a status derivation like the
   maintenance one, and it belongs with the current-custody work.
3. **The Shoots module still reads bookings from `/state`** in three places.
   Different module, out of this phase's scope.
4. **`eqAnalytics()` still reduces the `/state` array** and is still wrong for
   the same reason it was in Phase 2 — it reduces a truncated window. It wants a
   server-computed analytics endpoint, not a port of its reductions.
5. **The calendar caps at 200 bookings per range.** It says so when it truncates
   rather than dropping them silently, but a department with more than 200
   bookings in one month would want a per-day aggregate instead.
6. **No index on `(starts_at, ends_at)` alone.** Department-wide range queries
   fall back to a scan filtered by the join; the per-asset overlap uses the
   constraint's GiST index. At the measured size this is single-digit
   milliseconds; a busy department would want the index.
7. **Cancellation is still the only way to release a window.** No approval
   workflow, no waitlist, no recurring bookings — none of which this phase was
   asked to add.

---

## 12. Recommended next phase

1. **A current-custody read model.** One endpoint answering "who holds what"
   retires `eqHolder()` across its six callers and `trgEquipStatus()`'s first
   clause. It is the last blocker on `equipment_transactions` leaving `/state`.
2. **Server-derived item status.** With custody and bookings both server-side,
   `trgEquipStatus()` can go entirely and `booked`/`checked_out` can be computed
   where they are enforced rather than in the browser.
3. **A server-computed analytics endpoint**, retiring the last reader of the
   transaction, maintenance and booking arrays — and fixing the truncation bug
   in the same move.
4. **Then, and only then, the arrays leave `/state`** and the boot payload
   actually shrinks.

Academic loans, borrower redesign, project equipment allocation, RFID, inventory
audit and analytics redesign remain out of scope, and no groundwork for any of
them was laid here.

---

> **Superseded in part by Phase 7.** This document describes `/state` as still
> shipping the equipment history arrays, which was true when it was written.
> `equipment_transactions`, `equipment_bookings` and `maintenance_records` have
> since been **removed from `/state`** — see
> [ASSET_INVENTORY_STATE_CONSOLIDATION.md](ASSET_INVENTORY_STATE_CONSOLIDATION.md).
> `equipment_items` remains, and that document records why. Nothing else in the
> phase described here changed.
