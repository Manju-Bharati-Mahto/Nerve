# Inventory Scope Authorization (Phase 13B)

Phase 13A created the scope object and said, at the top of its document, that
scoped authorization was not implemented. **It is now.** An asset that belongs
to an inventory scope is reachable only by someone with authority over that
scope.

This document is the account of what that means, what it deliberately does not
mean, and where it is still incomplete.

---

## 1. The model

```
MODULE ACCESS          requireEquipment()      may you use Equipment at all
      +
INVENTORY SCOPE        inventoryScopeOf()      WHICH ASSETS that is about
      +
DOMAIN DUTY            canManageEquipment()    may you act, or only look
      =
AUTHORIZED ASSET ACCESS
```

The three are ANDed and none substitutes for another. A scope grant does not
let you into the module; the module does not give you a scope; and neither
makes you a custodian. Tests assert each of those separately, because a layered
model that collapses under one missing check is not layered.

**No new Nerve role was created.** The admin's authority comes from
`isMoAdmin()` — the role check that already governs every other module — so the
Media Ops master admin keeps full access without anybody's identity appearing
in the code.

### Filters narrow; authorization decides

A caller-supplied `scope_id`, `department_id` or `campus_id` is a filter. It is
pushed into the *same* `where` array as the scope predicate, never in place of
one, so a filter can only ever shrink what scope already permitted. Asking for
another scope's asset by id returns nothing rather than everything.

---

## 2. Scope resolution — `inventoryScopeOf(u)`

Modelled on `creatorScopeOf()`, the existing precedent for exactly this problem:
a discriminated union resolved once per request, plus a SQL fragment that
applies it, so there is one place that decides who sees what.

```ts
type InventoryScope =
  | { level: "all" }                          // the whole estate
  | { level: "scoped"; scopeIds: number[] }   // these scopes, plus the unscoped estate
  | { level: "none" };                        // the unscoped estate only
```

| Caller | Resolves to |
|---|---|
| Media Ops Admin (`isMoAdmin`) | `all` |
| Holder of one or more **active, unarchived** scope assignments | `scoped` |
| Everyone else who passed the module gate | `none` |

It is **re-read on every request and never cached**, which is what makes
revocation immediate rather than effective at next login.

### The two different nulls

This is the part worth being exact about, because "fail closed" is ambiguous
until you say which way it closes.

- **`scope_id IS NULL` on an ASSET** means *not yet governed*. The asset
  predates the scope model and has never been anybody's in particular, so it
  stays reachable exactly as it is today.
- **No assignment for a CALLER** means *governs nothing*. They get no scoped
  asset at all.

So a caller with no scope authorization gets **no scoped data** — not
"everything", and not "nothing at all".

**This is why the change could be shipped.** Enforcement only ever *adds* a
restriction, to assets somebody has deliberately scoped. It takes no access
away from anyone, and the estate does not go dark on deploy. Two tests exist
solely to hold that line, because a security change that quietly breaks the
product is not a success.

---

## 3. Where a scope assignment comes from

`mo_user_inventory_scopes (user_id, scope_id, granted_by, granted_at)`, shaped
like `mo_user_duties` — the existing convention for "this user has been granted
this thing".

**This is a provisional attachment point, and it is marked as such in the
migration.** Phase 13A's document lists "attach custodians to scopes" as the
next dependency; authorization needs something to authorize against, and this
is the smallest thing that works.

What it is **not**: the custodian model. There is no duty semantics, no
borrower, no eligibility, no request or approval, **no grant/revoke endpoint
and no screen.** A row is written by an Admin or by a test, directly. Who may
appoint a custodian, and what a custodian may do that a viewer may not, is a
later phase's design — see §10.

`mo_user_duties` could not be reused: it is keyed `(user_id, duty_flag_id)` and
could therefore hold only one scope per user.

`ON DELETE CASCADE` on both sides is what makes revocation and scope deletion
take effect immediately.

---

## 4. Read enforcement

Every equipment read endpoint was traced, and all nine are enforced.

| Endpoint | How |
|---|---|
| `GET /equipment` | scope predicate in the `where` array — list **and** `summary` counts |
| `GET /equipment/transactions` | same, via the item join |
| `GET /equipment/maintenance` | same |
| `GET /equipment/availability` | same |
| `GET /equipment/bookings` | same |
| `GET /equipment/custody` | same |
| `GET /equipment/analytics` | one predicate in `assetWhere`, which every figure is computed over |
| `GET /equipment/:id` | folded into the lookup's own `WHERE` — out of scope is simply *not found* |
| `GET /equipment/resolve/:identifier` | checked **before** the retired-identifier 410 (see §6) |
| `GET /equipment/:id/qr` | checked before the "no QR yet" 409 |

The summary counts matter as much as the rows: a header total computed over the
whole estate would betray the existence of an asset the list itself refused to
show. A test asserts the total equals what was actually returned.

---

## 5. Write enforcement

| Operation | Enforced |
|---|---|
| `POST /equipment/:id/checkout` | ✅ |
| `POST /equipment/:id/checkin` | ✅ |
| `POST /equipment/:id/damage` | ✅ |
| `POST /equipment/bookings` | ✅ (on `equipment_item_id` in the body) |
| `POST /equipment/bookings/:id/cancel` | ✅ (via the booking's asset — see §6) |
| `PATCH /equipment/:id` | ✅ |
| `POST /equipment/:id/status` | ✅ |
| `POST /equipment/:id/retire` | ✅ |
| `POST /equipment/:id/identifiers` | ✅ |
| `POST /projects/:id/work` | ✅ — **found during the audit**, see below |
| `POST /equipment` (register) | n/a — see below |
| Kiosk session endpoints | n/a — they mint a session; the checkout itself is enforced above |

**`POST /projects/:id/work` was a real cross-scope write vector.** The shoot
form takes an `equipment` array of raw ids and inserts a booking for each, with
errors swallowed — so a Projects call could reserve an asset belonging to a
scope the caller cannot see or name. Out-of-scope ids are now dropped before
the insert. They are dropped rather than refused because that loop already
silently ignores a booking clash, and turning that into an error would be a
business-rule change this phase has no mandate for.

**Asset registration accepts no scope.** `POST /equipment` never reads
`scope_id`, so a new asset is created unscoped and no caller-supplied scope is
ever trusted. See §9.

**An asset cannot be re-scoped through the API.** `scope_id` is absent from
`ASSET_EDITABLE`, so `PATCH` drops the field rather than writing it. Tested —
self-service rescoping would defeat the entire model.

---

## 6. Failing closed, and failing *quietly*

Every scope denial is **404, never 403**, and always carries the *same message
that endpoint already gives for an id that does not exist.*

A 403 would confirm the asset is real. So would a different message, or a
different status. The point of the check is that an id, tag, QR token or
booking id tells a caller nothing they did not already have the right to know,
and a test asserts that an out-of-scope asset and an invented id produce byte-
identical answers.

Two orderings were adjusted specifically for this:

- **`resolve/:identifier`** checked the retired-identifier `410` before the
  asset was loaded. Scope is now checked first, so a scanned label cannot
  distinguish "retired identifier in someone else's scope" from "no such
  identifier" — which is exactly the confirmation a scan would be fishing for.
- **`bookings/:id/cancel`** returned early when a booking was already
  cancelled, echoing the row back. Scope is now checked before that return.

A booking id and a transaction row are both handles on an asset, and both are
scoped by the asset they belong to.

---

## 7. What is deliberately *not* enforced

Traced, decided, and left alone rather than changed by reflex.

| Endpoint | Exposure | Why unchanged |
|---|---|---|
| `GET /ai/forecast` | per-category counts + upcoming shoot titles | aggregate only; no asset identity. Gated by `requireMedia`. |
| `GET /dashboard` | one global `COUNT(*)` of checked-out items | a single number; no identity |

Both leak **aggregate magnitude** across scopes and nothing else. Scoping them
would change what the dashboard and the forecast mean for every user, which is
a product decision, not a security fix. Recorded here so the choice is visible
rather than accidental.

---

## 8. Security tests

`server/mediaops-inventory-scope-auth.integration.test.ts` — **35 tests**, real
handlers, real database, fixtures prefixed `zia`.

Two custodians hold the *same* `equipment_custodian` duty and differ only by
scope, so the duty cannot be what separates them.

| Group | Proves |
|---|---|
| reads (4) | each custodian sees their own scope and the unscoped estate, not the other's; summary counts cannot be used to probe; a user with no scope fails closed |
| bypass attempts (10) | asset id, asset tag, QR token, **retired** QR token, QR image endpoint, query filter, transaction row, booking row, booking id, custody/maintenance/availability — each refused, each with the same answer an invented id gets |
| writes (8) | checkout, checkin, damage, edit, status, retire, identifier attach, booking, re-scoping, and the Projects shoot form — all refused, **and the database verified unchanged after each** |
| the range ends (6) | the admin still sees and edits the whole estate and holds no scope row; anonymous and non-crew still refused; scope does not replace the module gate; scope does not replace the custodian duty |
| revocation (5) | removing an assignment, deactivating a scope and archiving a scope each withdraw access on the very next request; two scopes reach both; scoping an asset is what brings it under control |

Every negative assertion is paired with a **positive control** — the owner *can*
see it. Without that, an empty list from a wrong response key would pass as if
it were security. One did, during development, and the control caught it.

**The suite was mutation-tested**: forcing `inventoryScopeOf()` to return
`{level:"all"}` fails **24 of the 35**. It is not vacuous.

### The Phase 13A tripwire fired, as intended

13A shipped two tests asserting that scope was *not* an authorization boundary,
written to fail the moment enforcement arrived so it could not be inherited by
accident. One failed on the first run of this phase's changes and has been
deliberately rewritten to assert the opposite; the other — that no endpoint
assigns an asset to a scope — still passes and is unchanged.

---

## 9. Limitations

1. **Assignment is provisional.** No endpoint or screen grants a scope; rows
   are written directly. §3.
2. **The estate is entirely unscoped.** Enforcement is real but currently
   governs nothing, because no asset has a `scope_id` and 13A deliberately
   fabricated none. The model proves out in tests; in production it activates
   one asset at a time, as somebody assigns scopes.
3. **A new asset is created unscoped**, even by a scoped custodian. Making it
   inherit the creator's scope would be inventing product behaviour — and is
   ambiguous the moment a custodian holds two scopes.
4. **Aggregate exposure** in `/ai/forecast` and `/dashboard`. §7.
5. **No index on `scope_id`.** 13A measured it and declined on evidence
   (0.39 ms over 5,000 assets, admin screen only). 13B adds the predicate to
   the registry's hot path, so **this is now the query that justifies it** —
   but it should be added with a measurement against a scoped estate, and there
   is no scoped estate to measure yet. See §10.
6. **UI unchanged.** The client was not touched. A scoped user's screens
   correctly show less because the server sends less. Client-side hiding was
   never authorization and none was added.
7. **`crudCan()` still lets a Team Lead create and rename scopes** — flagged in
   13A §4. Now that scope decides access, this is a real question, not a
   theoretical one. §10.

---

## 9a. Unrelated failures seen during validation

Neither is caused by this phase; both are recorded in `docs/TEST_STABILITY.md`.

- **Entry 12** — `bootstrapAssetFoundation()`'s identifier backfill can trip its
  own foreign key when a sibling suite deletes an asset between the
  `INSERT … SELECT`'s snapshot and its FK check. A narrow production race too.
  Diagnosed, not fixed. **This phase's own suite did stop churning
  `mo_equipment_items` thirty-five times a run**, which was making it likelier
  — the rows are now created once and only their state is reset per test.
- **Entry 13** — module-default resolution read as a global singleton while a
  sibling suite edits it, seen in `mediaops-module-defaults` and
  `mediaops-crew-lifecycle`. Same class as §G.10 and entry 11.

---

## 10. Next dependency: scoped custodian assignment

In order:

1. **Decide what happens to the existing unscoped estate.** Enforcement is
   inert until assets are scoped, and assigning them is a product decision with
   a migration attached.
2. **Design the custodian model properly** and replace or grow
   `mo_user_inventory_scopes`: who may appoint a custodian, whether
   custodianship is per scope or per category, and what a custodian may do that
   a scoped viewer may not. Today scope governs *reach*, and the duty governs
   *action*, independently.
3. **Tighten `crudCan()` for `inventory_scopes`** (§9.7). Editing the scope
   list is now editing an authorization boundary.
4. **Add the `(scope_id)` index** with a measurement over a genuinely scoped
   estate (§9.5).
5. Only then: borrower, eligibility, request and approval — all of which
   depend on this foundation and none of which exist.
