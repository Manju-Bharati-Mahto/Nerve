# Equipment `/state` Consolidation

Phase 7 of the Asset & Inventory work: three equipment history arrays left the
boot payload. **73.8% of `/state` went with them.**

`equipment_items` stays, and §7 says exactly why.

---

## 1. The original `/state` equipment payload

Four arrays, shipped to every media user on every boot:

| Array | `/state` filter | Rows on the benchmark fixture |
|---|---|---|
| `equipment_transactions` | latest per item + the 500 most recent | 670 of 5,880 |
| `equipment_bookings` | live, or ended within 90 days | 2,100 |
| `maintenance_records` | **no filter at all** | 1,260 |
| `equipment_items` | `deleted_at IS NULL` | 420 |

Two were capped, which is why analytics built on them were wrong (Phase 6), and
one was unbounded.

---

## 2. Dependency audit

Proved from source rather than taken from the brief — **51 references** across
the SPA. Comments excluded, the live/offline split came out:

**The brief's list was incomplete.** It named six consumers; the audit found
four more that read `equipment_items`: the `equip()` helper (14 call sites), the
command-palette search, the Settings category counts, and the damage-report
asset picker — plus notification routing and audit-log labels through `equip()`.

### The finding that governed the whole phase

```js
// hydrateFromServer()
keys.forEach(k => { if (Array.isArray(st[k])) DB[k] = st[k]; });
```

That assignment is **conditional**. An array the server stops sending is not
emptied — it keeps whatever it had, and what it had is the **prototype seed
declared at the top of the file**. Removing an array without clearing it
client-side would have left every missed consumer rendering *fictional cameras
in a live session* — plausible, wrong, and invisible.

So every removal in this phase is paired with an explicit live-clear:

```js
['equipment_transactions','equipment_bookings','maintenance_records']
  .forEach(k => { if (!Array.isArray(st[k])) DB[k] = []; });
```

A missed consumer now shows **nothing** — visibly wrong, and findable. A server
that still sends an array is still honoured, so old and new builds interoperate.

---

## 3. Consumer matrix

| Array | Consumer | File/function | Live/offline | Needs | Replacement |
|---|---|---|---|---|---|
| bookings + items | shoots table | `viewProject` → shoots tab | live | asset tags per shoot | `GET /equipment/bookings?shoot_id=<list>` |
| bookings + items | shoot assignment card | `card(a)` run-sheet | live | kit for one shoot | same |
| bookings + items | shoot drawer | `drawerFor('shoot')` | live | bookings for one shoot | same |
| bookings | `trgEquipStatus()` | reservation clause | **offline only** | seed reconciliation | seed retained |
| bookings | `createBooking` / `cancelBooking` | optimistic writes | offline | local echo | seed retained |
| transactions | `eqHolder()` | custody | **offline only** | seed reconciliation | seed retained |
| transactions | checkout/checkin/kiosk | optimistic writes | offline | local echo | seed retained |
| maintenance | `trgEquipStatus()` | maintenance clause | **offline only** | seed reconciliation | seed retained |
| maintenance | damage report ×3 | optimistic writes | offline | local echo | seed retained |
| items | `equip()` — 14 sites | lookup by id | live | asset identity | **not migrated — §7** |
| items | kiosk pool, kits, assign-work, palette, Settings counts, damage picker, notification routing | various | live | asset identity | **not migrated — §7** |

**Every live consumer of the three removed arrays was migrated before removal.**

---

## 4. Migrations

### Shoots — all three consumers, one endpoint

All three wanted the same thing: *which assets are booked for this shoot*.
`GET /equipment/bookings` already answered it, and its row already carries
`asset_tag`, `make` and `model` — so the second array lookup disappeared too.

**No new read model was needed.** One bounded extension: `shoot_id` now accepts
a **comma-separated list**, so the shoots table costs one request instead of one
per row. Ids are parsed to integers and a list that parses to nothing matches
nothing rather than everything.

```
SHOOT_BK  →  GET /equipment/bookings?shoot_id=1,2,3&status=reserved,active
          →  grouped by shoot_id, keyed by the set asked about
```

**Unknown is not none.** A shoot whose gear has not arrived shows `…`, and one
whose request failed shows `unavailable` — never "none". This is a run-sheet
somebody packs a van from; "no gear booked" and "we could not find out" must not
look alike.

---

## 5. Offline architecture

Audited before touching, because §4 warns against forcing an online API into an
offline workflow.

**What offline means here**: the SPA ships a complete prototype seed *declared in
the file*. On boot it calls `/state`; if that succeeds, `__MO_LIVE__` is set and
the seed is overwritten. If it fails — no session, no backend — the app runs on
the seed, and writes mutate the local arrays.

**Reconciliation**: `trgEquipStatus()` and `eqHolder()`, both of which Phases 4
and 5 already made **offline-only** (they return immediately when `__MO_LIVE__`).

**What this phase changed about offline: nothing.** The seed arrays are in the
file, not in `/state`, so removing them from the payload does not touch
standalone mode. The offline paths keep exactly the data they had.

**No equipment data was left in the boot payload under another name.** The
three arrays are gone from `/state` outright; the seed that remains is the
hardcoded prototype data that has always been there.

---

## 6. Removed arrays

In dependency order — the order the audit produced, not the suggested one:

1. **`equipment_bookings`** — after the three Shoots consumers migrated.
2. **`equipment_transactions`** — no live consumers remained after Phase 4.
3. **`maintenance_records`** — no live consumers remained after Phase 2/5.

All three were removed together *after* the audit proved every live consumer had
a replacement, which is the condition §10 sets.

---

## 7. What remains, and why

> **Phase 8 update: `equipment_items` has since been removed too.** The section
> below records the Phase 7 position and the reasoning that deferred it; the
> migration that followed — a synchronous client asset cache — is documented in
> [ASSET_INVENTORY_CLIENT_ASSET_CACHE.md](ASSET_INVENTORY_CLIENT_ASSET_CACHE.md).
> `/state` now carries **no equipment rows at all**; only
> `equipment_categories`, `equipment_kits` and `kit_items` remain as lookups.

**`equipment_items` was NOT removed in Phase 7.** This was a deliberate stop,
not an oversight.

It is read by `equip(id)` — a **synchronous** lookup with 14 call sites inside
render functions and action handlers: the kiosk flow (5), the QR modal,
checkout/check-in/damage actions, kit contents, the shoot drawer, notification
routing and audit-log labels — plus six further direct readers.

Replacing a synchronous lookup with an asynchronous fetch means giving each of
those sites a loading state, including the kiosk's scan-and-commit flow. That is
a larger piece of work than this phase, and doing it badly would put a *loading*
state in the middle of a checkout. The honest position: the audit found the
dependency is deeper than the brief assumed, and the refactor is specified in
§13 rather than rushed here.

Also still shipped, deliberately: `equipment_categories` (11 rows),
`equipment_kits` and `kit_items` — small lookups, not history.

---

## 8. Endpoint mapping

| Question | Endpoint |
|---|---|
| what is booked for these shoots | `GET /equipment/bookings?shoot_id=…` |
| the department's schedule | `GET /equipment/bookings` |
| who holds what | `GET /equipment/custody` |
| the ledger | `GET /equipment/transactions` |
| repairs | `GET /equipment/maintenance` |
| free for a date range | `GET /equipment/availability` |
| an asset and its effective state | `GET /equipment`, `GET /equipment/:id` |
| charts | `GET /equipment/analytics` |

**No generic replacement was created.** There is no `/equipment/state`,
`/equipment/full`, `/equipment/all-data` or `/equipment/bootstrap` — that would
have recreated the problem with a different URL.

---

## 9. Security

`requireEquipment` on every replacement endpoint, unchanged. No new
authorization policy, no new roles, no scope rules invented.

**Visibility narrowed slightly, in the right direction.** `/state` is gated by
`requireMedia` only, so it shipped equipment history to every media user
regardless of the `equipment` module. Those questions now go through
module-gated endpoints. Every media role has `equipment` by default, so a
default install is unaffected; an account an administrator explicitly revoked
Equipment from no longer receives equipment history at boot — which is what
revoking it was supposed to mean.

---

## 10. Boot payload, before and after

Fixture: **420 assets, 5,880 transactions, 2,100 bookings, 1,260 maintenance
records.**

| | Raw | gzip | Rows of equipment history |
|---|---|---|---|
| **Before** | 1,086,623 B | 34,490 B | 4,030 |
| **After** | **284,450 B** | **13,531 B** | 0 |
| Removed | **802,173 B (73.8%)** | 20,959 B (60.8%) | 4,030 |

`JSON.parse` of the payload: **1.91 ms → 0.43 ms** (mean of 20).

The gzip figure is the honest one to quote for the wire; the raw and parse
figures are what the browser actually pays after decompression.

---

## 11. Network behaviour

The point was not to trade one large request for twenty small ones at boot.

| Consumer | Endpoint | When |
|---|---|---|
| Shoots table | `/equipment/bookings?shoot_id=…` | **on feature use** — opening the shoots tab; one request for the whole page |
| Shoot drawer / card | same | on open; cached by the set of shoots asked about |
| Equipment tabs | their own read models | on tab entry |
| Analytics | `/equipment/analytics` | on tab entry |
| Dashboard figures | `/equipment?summary=1` | on the home page |

**Nothing added to boot.** Every request above happens when its feature is used,
and each is cached until a write invalidates it.

---

## 12. Regression tests

**API** — a boot-contract suite that fails if any of this is undone:

- the three arrays are absent from `/state`
- the lookups that remain (`equipment_categories`, `equipment_items`,
  `equipment_kits`, `kit_items`) are still present
- the session contract (`users`, `projects`, `shoots`, `shoot_crew`,
  `module_defaults`) is unchanged
- **each removed array's question is answered by its replacement** — a checkout,
  a booking and a repair, each found through its own endpoint
- the shoots list filter returns one row per shoot, each carrying its asset
- a junk shoot list matches nothing rather than everything

**UI** — with `DB.equipment_bookings` and `DB.equipment_items` both emptied and
`/state` failing:

- the shoots table asks **once** for several shoots, and never for `/state`
- asset tags still render
- pending shows `…`, failure shows `unavailable`, neither shows "none"
- the same page does not re-ask; the drawer draws one shoot's kit
- **the live-clear works**: a `/state` without the arrays empties them rather
  than falling back to the seed, and a `/state` that still sends one keeps it

---

## 13. Remaining technical debt

1. **`equipment_items` is still in `/state`** (§7). The blocking work is
   replacing `equip(id)`. The smallest sound design: a client-side asset cache
   keyed by id, filled from the read models the page already fetches and
   topped up by `GET /equipment/:id` on a miss, plus loading states at the 14
   call sites — the kiosk flow being the delicate one. That is Phase 8-sized.
2. **`equipment_kits` / `kit_items` have no read model.** Small lookups today;
   they would follow `equipment_items`.
3. **Offline mode is a full prototype seed.** It works, it is untouched, and it
   is a large amount of fiction compiled into the page. Whether it should still
   exist is a product question this phase did not raise.
4. **A test-helper bug was found and fixed here, not introduced here**: the
   suite's "today" helpers computed a **UTC** day while every endpoint compares
   against the **IST** day, so for five and a half hours each night six overdue
   assertions were off by one. Found when the clock crossed midnight IST
   mid-run. All day helpers now compute the server's day.

---

## 14. Corrections to earlier documents

Earlier Asset & Inventory documents state that `/state` still ships all four
equipment arrays. That was true when written and is no longer true: three are
gone. The remaining-dependency sections of
`ASSET_INVENTORY_HISTORY_READ_MODELS.md`, `ASSET_INVENTORY_BOOKING_AVAILABILITY.md`,
`ASSET_INVENTORY_CURRENT_CUSTODY.md`, `ASSET_INVENTORY_SERVER_DERIVED_STATUS.md`
and `ASSET_INVENTORY_SERVER_ANALYTICS.md` should be read as describing the
position at the end of their own phase, superseded here.

`/state` is **not** a source of truth for equipment history any more. For
`equipment_items` it remains the delivery mechanism, and §7 records why.
