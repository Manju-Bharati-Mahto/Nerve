# The Client Asset Cache

Phase 8 of the Asset & Inventory work: `equipment_items` left `/state`.
**`/state` now carries no equipment rows at all.**

`equip(id)` is still synchronous. What changed is where it looks.

---

## 1. Why `equipment_items` could not simply disappear

Phase 7 removed three history arrays and stopped at this one, for a reason the
audit made concrete: `equip(id)` is **synchronous**, and it is called from
fourteen places inside render functions and action handlers — the kiosk
scan-and-commit flow (5), the QR modal, checkout, check-in, damage, kit
contents, the shoot drawer, notification routing and audit-log labels — plus
six further direct readers of the array.

Turning it into `await fetch(...)` would have put a loading state in the middle
of a checkout. So the contract was kept and the storage was replaced.

---

## 2. The `equip()` contract

```js
equip(id) → the asset, or {} if this session does not know it
```

Unchanged in shape and in what it returns, so no caller had to be rewritten to
accommodate it. **What it must never do in a live session is answer from the
prototype seed compiled into the page** — that was the Phase 7 failure mode, and
§14 below is the test that stops it coming back.

`assetKnown(id)` is the companion: *unknown* and *known to have no fields* are
different, and screens that must not imply availability use it.

---

## 3. Architecture

```
GET /equipment          ─┐
GET /equipment/:id       ├─→  assetPut / assetPutMany  →  ASSETS.byId
GET /equipment/resolve   ─┘                                   │
                                                              ↓
                                            equip(id)  (synchronous)
                                                              ↓
                                          the fourteen existing consumers
```

The cache is a **client-side projection of server data**, not a source of truth.
It holds **full asset rows only** — the shape `ASSET_SELECT` returns. Custody
and availability rows carry a subset of the columns, so caching them would make
`equip().warranty_until` depend on which screen loaded first; they are
deliberately not written into it.

---

## 4. `get` versus `ensure`

| | |
|---|---|
| `equip(id)` | **synchronous**. The cache, or `{}`. Never a network call. |
| `assetEnsure(id)` | **asynchronous**. Fetches if missing; deduplicated. |
| `assetEnsureMany(ids, width)` | bounded batches, default four at a time |
| `withAsset(id, fn)` | the boundary: ensure, then run `fn` synchronously |

**There is no hidden async.** `equip()` never fetches, no render function
awaits, and no consumer was turned into `equip(id).then(...)`. Loading happens
at a boundary the code names:

```js
checkout:(d)=>withAsset(d.eid,(e,id)=>{ …everything here is synchronous… })
```

---

## 5. Live versus offline

They share nothing.

```js
const equip = id => (window.__MO_LIVE__
  ? (ASSETS.byId.get(Number(id)) || {})     // the cache, and only the cache
  : (DB.equipment_items.find(e=>e.id===id) || {}));   // the seed, and only the seed
```

`hydrateFromServer()` empties `DB.equipment_items` and calls `assetClear()`, so
a live session starts with no assets from either source and fills only from the
server. Offline never hydrates, so the seed stands exactly as it did.

Every remaining read of `DB.equipment_items` in the page is inside an explicit
`if (!window.__MO_LIVE__)` branch.

---

## 6. Cache population

Opportunistic, from responses the page already makes — **no request exists
solely to fill the cache**:

| Source | When |
|---|---|
| `GET /equipment` (registry page) | opening the Equipment tab, paging, searching |
| `GET /equipment/:id` (detail) | opening an asset |
| the kiosk's available pool | entering the scan step |
| the picker page | opening the damage or assign-work picker |
| the palette search | typing in the command palette |
| `assetEnsure` | a cache miss at a boundary |

---

## 7. Invalidation

`eqInvalidate()` — already called after every equipment write — now also clears
`ASSETS.byId`. Cached rows are **dropped rather than patched**: the next read
re-asks the server, which is the only thing that knows what the write did.
In-flight requests are left alone; they are already asking.

`assetForget(id)` exists for a single asset. `assetClear()` also runs when a
live session starts and when Equipment access is lost — cached rows are data
*this session was allowed to read*, and that permission can be withdrawn.

---

## 8. Concurrency

```js
if (cached)  return it
if (inflight) return the same promise
otherwise    fetch, store the promise, delete it when settled
```

Ten simultaneous asks for one asset produce **one** request — tested. This
matters most for the kiosk, render bursts and kit contents.

A failure caches **nothing**, and the id is remembered in `ASSETS.missing` so a
list of labels does not ask for it on every render forever.

---

## 9. The kiosk flow

```
SCAN  →  the id is added AND assetEnsure(id) runs        ← the loading is here
      →  the list shows the asset, or "Looking this up…"
      →  Continue
      →  commitKiosk() refuses if any item is still unknown
      →  POST checkout/checkin  →  eqInvalidate()  →  re-render
```

**No network request happens inside the commit.** The scan is the boundary, and
by the time the operator presses Continue every item is confirmed or visibly
not. The check-out pool comes from `GET /equipment?status=available`; the return
pool is the custody read model, whose rows are partial — which is exactly why
the scan ensures rather than assuming.

---

## 10. Error semantics

**An unknown asset is never treated as a valid one.**

| Situation | What happens |
|---|---|
| kiosk item not confirmed | the list says "Looking this up…" / "Unknown asset" |
| kiosk commit with an unknown item | **nothing is written**, with a recoverable message |
| `withAsset` cannot fetch | the action does not run: "could not be confirmed — nothing was changed" |
| a label cannot resolve | `Asset #123`, never a guessed name |
| picker list not loaded | "Loading assets…" / "could not be loaded", never an empty picker |

---

## 11. Security

Every fetch goes through the existing endpoints behind `requireEquipment`, so
the cache can only ever hold what this session was allowed to retrieve. No new
authorization was invented.

`assetGuard()` clears the cache when `moduleAllowed('equipment')` is false, so
rows read under a permission do not survive its removal.

Removing `equipment_items` from `/state` also **narrows** exposure: `/state` is
gated by `requireMedia` only, so it used to hand the whole asset table to every
media user regardless of the Equipment module. That data is now module-gated.

---

## 12. Network behaviour

| Consumer | Request | When |
|---|---|---|
| registry / detail | as before | tab or asset opened |
| kiosk pool | `?status=available&limit=50` | scan step opened |
| kiosk scan miss | `/equipment/:id` | on scan |
| palette | `?q=…&limit=5` | as the term changes |
| damage picker | `?limit=200` | modal opened |
| assign-work chips | `?status=available&limit=30` | modal opened |
| Settings counts | `/equipment/analytics?limit=1` | Settings opened |
| kit contents | bounded `ensureMany`, once per kit set | Kits tab opened |
| labels | one batched `ensureMany` after the render | when a label misses |

**Nothing was added to boot.** There is no `boot → fetch every asset`
pattern: the first measurement showed the assign-work picker fetching 200 rows
to draw 30 chips, and each picker now asks for the size it actually shows.

---

## 13. Boot payload

Fixture: **420 assets, 5,880 transactions, 2,100 bookings, 1,260 maintenance
records.**

| | Raw | gzip | Asset rows | `JSON.parse` |
|---|---|---|---|---|
| Before Phase 8 | 287,700 B | 14,281 B | 420 | 0.55 ms |
| **After Phase 8** | **51,965 B** | **6,811 B** | **0** | **0.09 ms** |
| Removed | 235,735 B (81.9%) | 7,470 B (52.3%) | 420 | |

Across the consolidation as a whole — Phase 7 and Phase 8 together:

| | Raw | gzip |
|---|---|---|
| Before Phase 7 | 1,086,623 B | 34,490 B |
| **Now** | **51,965 B** | **6,811 B** |
| | **−95.2%** | **−80.3%** |

---

## 14. `/state` removal and the regression that guards it

`equipment_items` is gone from the payload. The guard has three parts:

1. **API** — `/state` carries none of `equipment_items`,
   `equipment_transactions`, `equipment_bookings`, `maintenance_records`, and
   the serialised payload contains neither key.
2. **The fictional-asset test** — the page has a full prototype estate compiled
   into it. In a live session, `equip(seedId)` must return **unknown**; the same
   call offline must still return the seed asset. This is the Phase 7 failure
   mode written down as a test.
3. **Live start** — a cache populated before `hydrateFromServer()` is empty
   afterwards, and `DB.equipment_items` is emptied rather than falling back.

`equipment_categories`, `equipment_kits` and `kit_items` remain: a few dozen
lookup rows, not history. The assets a kit points at are resolved through the
cache.

---

## 15. Remaining limitations

1. **The damage picker is capped at 200 assets.** It used to list the whole
   table. A searchable picker — the registry's `q` — is the right fix and is a
   UI change this phase did not make.
2. **The Settings category count costs an analytics request.** It is one request
   on a settings page, and it avoided inventing a counts endpoint, but analytics
   computes more than the counts it is asked for.
3. **The cache is unbounded in principle.** It grows with the assets a session
   looks at and is cleared on every write and on module loss, so in practice it
   holds a page or two. A department browsing thousands of assets in one session
   would want an LRU bound.
4. **`assetEnsureMany` is bounded at four concurrent requests**, chosen for
   politeness rather than measured — kits are small enough that it has not
   mattered.
5. **The offline seed is still a prototype estate compiled into the page.**
   Untouched.

   > **Corrected by the Phase 9 audit.** This line, and the Phase 8 closing
   > recommendation, described the seed as the largest thing in the file. It is
   > not: the equipment seed is **~10.8 KB raw / ~3.6 KB gzip, about 0.8%** of
   > `index.html`, which is dominated by application code and CSS. The reason to
   > look at standalone mode is not its size — it is that seven of eight
   > Equipment screens no longer work offline, and the one path that still does
   > records custody that is never sent and never persisted. See
   > [ASSET_INVENTORY_OFFLINE_AUDIT.md](ASSET_INVENTORY_OFFLINE_AUDIT.md).
