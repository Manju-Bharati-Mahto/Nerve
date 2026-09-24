# Offline Equipment Seed — Audit

**This document does not make a decision.** It establishes what standalone mode
is, what it does, and what it costs, so that somebody with the authority to
decide can do so on evidence.

Nothing was changed in this phase. Five tests were added that record the
behaviour described below.

---

## 0. The headline, and a correction

**The equipment seed is 10,835 B raw / ~3,557 B gzip — about 0.8% of
`index.html`.** Thirty-two assets, twenty transactions, twenty-two bookings,
five maintenance records.

The Phase 8 report closed by calling the offline seed "the largest single thing
in the file" and recommending it as the next priority on those grounds. **That
was wrong.** The file is 1.4 MB because of application code and CSS, not
because of seed data, and the equipment portion of the seed is a rounding error
within it. Anyone who reads that recommendation should read this instead.

The case for looking at standalone mode is not size. It is §4 and §6: most of
it no longer works, and the part that still works records custody that does not
exist.

---

## 1. Current offline architecture

There is no offline *mode*. There is a **fallback**.

```
boot()
  ├─ creator? → hydrateCreatorShell()            → __MO_LIVE__ = true
  ├─ hydrateFromServer()  ── succeeds ──────────→ __MO_LIVE__ = true
  └─ hydrateFromServer()  ── throws ────────────→ nothing is set
                                                   the prototype seed stands
                                                   console.warn(
                                                     "running on seed data")
```

`window.__MO_LIVE__` is set true in exactly two functions and set false only by
the two logout paths. **No switch, flag, route, query parameter, environment
variable or UI control turns standalone mode on.** It is what happens when
`GET /state` fails: no session, no backend, or no network.

---

## 2. Seed location

All of it is a literal declaration inside `public/media-ops/index.html`, lines
1711–1857. It is hand-written, not generated. `daily_reports`, `notifications`,
`audit_logs`, `activity` and others are declared **empty** and generated at
runtime — so they are not seed data in this sense.

---

## 3. Seed size

| Block | Rows | Fields | Raw | gzip |
|---|---|---|---|---|
| `equipment_categories` | 11 | 6 | 1,055 B | 336 B |
| `vendors` | 4 | 6 | 1,014 B | 633 B |
| `equipment_items` | **32** | 22 | 3,459 B | 1,184 B |
| `equipment_kits` | 4 | 4 | 375 B | 209 B |
| `kit_items` | 17 | 2 | 773 B | 257 B |
| `equipment_bookings` | 22 | 9 | 1,958 B | 527 B |
| `equipment_transactions` | 20 | 11 | 2,020 B | 444 B |
| `maintenance_records` | 5 | 10 | 1,557 B | 680 B |
| **Total** | **115 rows** | | **~10,835 B** | **~3,557 B** |

Context: `index.html` is 1,407,191 B raw / 364,615 B gzip. The inline script is
1,335,471 B of that; the HTML shell and CSS are 71,720 B. **The equipment seed
is ~0.8% of the file.**

Supporting seed the equipment rows point at: 18 users, 28 projects, 24 shoots,
58 shoot_crew rows. Those exist for every module, not for equipment.

---

## 4. What still works offline — measured, not assumed

Booted with `/state` failing, each Equipment tab rendered:

| Tab | Offline |
|---|---|
| Catalog | ⚠ "The asset registry could not be loaded" |
| Availability | ⚠ "Availability could not be loaded" |
| Bookings | ⚠ "Bookings could not be loaded" |
| My items | ⚠ error + Retry |
| Transactions | ⚠ "The ledger could not be loaded" |
| Maintenance | ⚠ "Maintenance records could not be loaded" |
| Analytics | ⚠ "Analytics could not be computed" |
| **Kits** | **renders** — from `equipment_kits`, `kit_items` and `equip()` |

**Seven of eight Equipment screens are already non-functional offline.** This is
a direct consequence of Phases 1–8: each screen moved to a read model, and a
read model cannot answer without a server. The seed rows those screens used are
still shipped; the screens are gone.

Still working offline: the kiosk (§6), the Kits tab, `equip()` lookups,
`trgEquipStatus()`/`eqHolder()` reconciliation, and the offline branches of the
palette and the pickers — several of which feed screens that no longer render.

---

## 5. Usage evidence

**Usage cannot be established from the repository.** There is no telemetry, no
analytics, no feature flag, no deployment configuration and no operational
document that records whether anyone runs this app without a session.

What *can* be established:

- The SPA is served **publicly**, before the API auth middleware, deliberately:
  *"the prototype itself is not sensitive; its `/api/v1/media/*` data calls
  remain authenticated."* So any anonymous visitor to `/api/media-ops/` reaches
  the seed.
- A service worker caches the shell, so the page opens with no network. Its own
  comment says *"writes still require connectivity."*
- No test before this phase exercised standalone mode as a mode.

Whether that path is used by anyone, deliberately, is a question for the
department. It cannot be answered from source.

---

## 6. Offline mutations and reconciliation

This is the finding with operational consequences.

**Offline mutations are permitted, are never persisted, and are *inconsistently*
sent.**

```js
async function moSync(promise, onOk){
  if(!window.__MO_LIVE__) return;      // ← every server write path stops here
  …
}
```

Measured end to end with `/state` failing:

| | |
|---|---|
| kiosk checkout of asset 1 | **completes** |
| local transactions | 20 → **21** |
| `equip(1).status` | → **`checked_out`** |
| POST requests attempted | **0** |
| `localStorage` keys | **0** |
| IndexedDB | not used |
| service-worker background sync | not implemented |

So an offline kiosk checkout produces a custody record that looks exactly like a
real one, exists in a single browser tab's memory, and **disappears on reload**.

### The write paths do not agree with each other

`moSync()` returns early when offline — but **its argument is evaluated before
it is entered**. So a call site written as

```js
moSync(MO_API.post('/equipment/bookings/' + id + '/cancel', {}))
```

fires the request anyway, and `moSync` then drops the promise, producing an
**unhandled rejection**. A call site that builds the request inside
`if (window.__MO_LIVE__) { … }` does not.

Measured offline:

| Action | Request attempted? |
|---|---|
| `checkout` | **no** — guarded by `__MO_LIVE__` |
| `commitKiosk` | **no** — guarded |
| `cancelBooking` | **yes** — `POST …/cancel`, rejection unhandled |

This was pre-existing and is recorded above as the audit found it.

> **Normalised after the audit.** The four unguarded equipment mutations —
> `createBooking`, `cancelBooking`, `confirmDamage`, `createEquipment` — now
> build their request inside an explicit `if (window.__MO_LIVE__)` check, the
> same shape checkout, check-in and the kiosk already used. Offline, no
> equipment write request is attempted and no rejection is dropped; online,
> behaviour is unchanged. The table above therefore describes the position
> *before* that change, and the row for `cancelBooking` now reads "no".
>
> **This introduces no offline mutation architecture.** No queue, no local
> store, no synchronisation, no reconciliation, and no change to standalone
> mode: the local optimistic mutation each action performs is exactly what it
> was. All that changed is whether a request nobody can answer is sent.
>
> **Everything in §10–§12 still stands.** Whether Media Ops should support
> intentional offline operation remains an open product decision, and the
> questions in §12 are unanswered.

| Question | Answer |
|---|---|
| mutation queue | **none** |
| idempotency | not applicable — nothing is sent |
| retry | none |
| conflict handling | none |
| ordering | not applicable |
| duplicate submission | not applicable |
| reconciliation | **none** — there is no mechanism to reconcile at all |
| audit trail | local `audit()` only, lost with the page |
| same asset changed online meanwhile | never detected |

**There is no reconciliation mechanism. Stated explicitly, as §3 requires.**

---

## 7. Authentication and authorization

| Question | Answer |
|---|---|
| requires a live session? | **No.** The seed path exists precisely because there is none. |
| local PIN? | The kiosk PIN pad is reachable, but its verification endpoint fails offline. |
| trusts a local user id? | Yes — `S.me` falls back to the seed identity. |
| seed reachable without authentication? | **Yes**, by design (§5). |
| privileged operations offline? | Only against local arrays. |
| bypasses `requireEquipment`? | Not meaningfully — no request is made. |
| bypasses server authorization? | No server is involved. |

**No new security hole.** The exposure is fictional data and a UI that offers
actions it cannot perform. The risk is *misleading*, not *leaking*: an
anonymous visitor sees a working-looking department with invented people,
projects and equipment.

Worth flagging for the decision, not fixed here: the client capability table
(`can('equipment.analytics')` and friends) is cosmetic in every mode — the
server has never read it.

---

## 8. Field-level dependency

A scan of client code for each seed field (counts are indicative — names like
`status` and `user_id` are shared across modules):

| Table | Never referenced by name in client code |
|---|---|
| `equipment_items` | `barcode` |
| `equipment_transactions` | `recorded_by` |
| `equipment_bookings` | (none) |
| `maintenance_records` | `reported_by` |

Everything else is referenced somewhere, though much of it only by screens that
no longer render offline (§4). **Nothing was deleted.**

The minimum for what *actually works* offline today — the Kits tab, `equip()`
lookups and the kiosk's local echo — is roughly:

```
equipment_items:      id, asset_tag, make, model, category_id, status, condition
equipment_categories: id, name, icon
equipment_kits:       id, name, description
kit_items:            kit_id, equipment_item_id
```

That is perhaps 2 KB raw of the 10.8 KB. The other three tables
(`equipment_transactions`, `equipment_bookings`, `maintenance_records`) feed
`trgEquipStatus()` and `eqHolder()`, whose output is consumed almost entirely by
screens that now show an error offline.

---

## 9. Relationship to the Phase 8 asset cache

The cache already has the right shape for this:

```
LIVE     server → assetPut() → ASSETS.byId → equip()
OFFLINE  seed   → ???        → ASSETS.byId → equip()
```

`equip()` currently branches on `__MO_LIVE__` and reads the seed array directly
offline. Routing the seed through `assetPut()` at boot would give one lookup
path and one storage for both modes.

**It was not done, deliberately.** The branch is what currently guarantees the
seed cannot surface in a live session — the Phase 7 failure mode — and that
guarantee is worth more than the tidiness until a decision is made about
whether offline survives at all. If it does, this is the natural first step.

---

## 10. Options

Neutral, and deliberately unranked.

### A — Remove offline equipment support entirely

*Benefits*: deletes ~10.8 KB of fiction, one `equip()` branch, the offline write
paths, `trgEquipStatus()`, `eqHolder()`; removes the risk in §6; one code path
to reason about.
*Costs*: the app shows nothing useful without a session; the Kits tab loses its
only offline function.
*Risks*: low technically. The real risk is discovering afterwards that somebody
depended on the demo behaviour — for training, a pitch, or a device with poor
connectivity.
*Effort*: small. Most of it is already dead (§4).
*Kiosk*: loses a local-only flow that records custody nobody can see.
*Accountability*: **improves** — a kiosk that refuses is safer than one that
pretends.
*Academic Inventory / RFID*: no impediment; both assume a server.

### B — Keep offline, reduce the seed to asset identity only

*Benefits*: keeps lookups and Kits working; drops the three history tables that
feed screens which no longer render; ~2 KB instead of ~10.8 KB.
*Costs*: `trgEquipStatus()` and `eqHolder()` lose their inputs and would need
removing or reducing.
*Risks*: leaves §6 untouched — mutations still silently local.
*Effort*: small-to-moderate.
*Kiosk*: unchanged, including the risk.
*Accountability*: unchanged.

### C — Keep full standalone mode, with a structured local database

*Benefits*: honest offline capability; a real queue, real reconciliation.
*Costs*: substantial — IndexedDB, a mutation queue, idempotency keys, conflict
resolution, an offline audit trail, and server support for replay.
*Risks*: the hardest correctness problem in the whole application. Custody
conflicts are the exact case that is hard to get right.
*Effort*: large; a project, not a phase.
*Kiosk*: becomes genuinely useful in a cupboard with bad wifi.
*Accountability*: potentially the best outcome, if done correctly; the worst if
not.
*Academic Inventory / RFID*: an RFID reader in a store room is the strongest
argument for this option.

### D — Keep offline read-only; remove offline mutations

*Benefits*: removes §6's risk directly; the app degrades to something
truthful — you can look things up, you cannot pretend to check them out.
*Costs*: the kiosk cannot be used without connectivity; existing offline write
paths are deleted.
*Risks*: low.
*Effort*: small-to-moderate.
*Kiosk*: must refuse, visibly, when offline.
*Accountability*: **improves** for the same reason as A.

### E — Defer to a future PWA/local-database architecture

*Benefits*: no work now; keeps the question open.
*Costs*: the §6 risk stays for as long as the deferral lasts; each later phase
carries the seed and its branches.
*Risks*: "temporary" persists. The seed has already outlived the architecture
that needed it.
*Effort*: none now, C's effort later.
*Kiosk*: unchanged, including the risk.

---

## 11. Risks, independent of the option chosen

1. **An offline checkout records custody that does not exist.** It survives no
   reload and reaches no server. If anyone has ever relied on it, the ledger is
   wrong and nothing in the system knows.
2. **The app looks like it is working.** Nothing on screen says "this is demo
   data" — the console warning is the only signal.
3. **Seven of eight Equipment screens already fail offline**, so whatever value
   standalone mode had is largely gone. Keeping it costs the branches, not the
   bytes.
4. **Anonymous visitors reach the prototype.** Intended, documented, and worth
   re-confirming now that the app looks less like a prototype.

---

## 12. What the product decision needs

1. **Does anyone use Media Ops without a session?** Demo, training, pitch, a
   store room with no wifi. Only the department can answer this.
2. **Should a kiosk work without connectivity?** This is the real question. A
   yes points at C; a no makes A or D straightforward.
3. **Is the public prototype still wanted** now that the app resembles the
   production system?
4. **If offline stays, is local-only custody acceptable?** If not, §6 must be
   fixed or offline mutations removed, whichever option is chosen.

Once 1 and 2 are answered the rest follows quickly. **They cannot be answered
from this repository.**

---

## 13. Tests added

Five, recording behaviour rather than asserting it is right:

- standalone mode is entered by failure, not by choice
- seven of eight Equipment tabs cannot render offline; Kits can
- a kiosk checkout offline writes locally, **sends nothing, persists nothing**
- which write paths are guarded offline and which fire a doomed request
- the seed answers offline and is invisible in a live session

None asserts that any of this is desirable.
