# Asset & Inventory Stabilization

Foundation, security and correctness work on the existing Media Ops Equipment module,
following [ASSET_INVENTORY_AUDIT.md](ASSET_INVENTORY_AUDIT.md).

**Not built:** RFID hardware integration, academic booking UI, inventory-audit UI,
advanced analytics, maintenance redesign, project-equipment redesign, a new asset
dashboard. No second inventory application, no second router, no second
authentication system.

---

## 1. Issues fixed

| # | Audit finding | Severity | Fix |
|---|---|---|---|
| S1 | Forged `holder_id` — any crew member could put a colleague's name on a camera | High | Custody resolved server-side by `resolveHolder()`; a named borrower requires custodial authority and must be active media crew |
| S2 | Five of six endpoints had no module gate | High | `requireEquipment()` on every equipment route |
| S3 | Kiosk PIN accepted any four digits | High | Server-verified scrypt-hashed PIN, per-person, with lockout and its own rate-limit budget |
| S4 | Booking-cancel IDOR | Medium | Ownership checked; unknown id now 404s instead of reporting success |
| S5 | Any user could force any asset to `maintenance` | Medium | Damage reporting is custodial; an item in somebody's hands keeps its custody |
| S6 | Custodian duty was frontend-only | Medium | `canManageEquipment()` reads `mo_user_duties` server-side |
| S7 | Unverified check-in | Medium | Check-in requires a live checkout; only the holder, a custodian or an Admin may perform it |
| S8 | BR-7 bypass | Medium | BR-7 enforced in `canCheckOut()`, called by the endpoint |
| S9 | `/state` shipped every transaction, unbounded | Medium | Bounded — see §7 |
| S10 | `COUNT(*)`-derived asset tags collided | Low | Advisory-locked, max-suffix derived, inside a transaction |
| S11 | Guessable `qr_uid` (`QR-` + tag) | Low | Opaque random primary QR token |
| S12 | Silent booking failure in shoot creation | Low | Unchanged — see §11 |
| — | **The QR label encoded nothing** | — | Real ISO/IEC 18004 encoder |
| — | **BR-8 implemented twice, differently** | — | One implementation, the canonical one |
| — | **AUTO-3 escalation was never implemented** | — | Implemented as the seeded rule describes |
| — | Create was `Admin \|\| TL`, contradicting the UI's own CAPS | — | One rule: Admin or custodian |
| — | `department_id`/`campus_id` hardcoded to `1` | — | Taken from the request, defaulting to the category's department |

---

## 2. Architecture decisions

**One engine, scoped — not two systems.** Nothing here forks Media Crew and Academic
equipment. The scoping primitives (`mo_departments`, `mo_campuses`, the module system,
the duty model) already existed and were unused; asset creation now populates them.

**Rules are a module, not a layer.** `server/equipment-rules.ts` holds BR-7, BR-8,
AUTO-3, VR-8 and the status machine as pure functions. The endpoints call them, the
tests call them, and `GET /equipment/rules` publishes them so the browser can *state*
a rule without *deciding* it.

**No new authentication.** The kiosk PIN uses `server/password.ts` (scrypt +
`timingSafeEqual`), the same helper Nerve authenticates with. The rate limiter is
`express-rate-limit`, declared beside the existing OTP and AI limiters and threaded
through the existing `Handlers` object. A kiosk session is a bearer token that names
one borrower and is accepted by nothing outside the equipment endpoints.

**Identity is a table, not more columns.** `mo_asset_identifiers` means a future RFID
tag is an INSERT. No `rfid_*` column was added to `mo_equipment_items`, as the audit
recommended.

**Retirement, never deletion.** There is no DELETE endpoint. `retired_at` is the
operational end of life; transactions, bookings and maintenance records are untouched
and the asset still resolves from its QR.

**Additive migrations only.** Every statement in `bootstrapAssetFoundation()` is
`IF NOT EXISTS` or an idempotent backfill. No column was dropped, narrowed or renamed.

---

## 3. Security changes

### Custody identity — `resolveHolder()`

```
was:  const holder = toUid(b.holder_id) ?? u.id;     // the browser decided
now:  1. a verified kiosk session   → the person who entered their own PIN
      2. the authenticated caller   → the default
      3. a named borrower           → custodians and Admins only, and only for
                                      an active media crew member
```

### Authorization

`requireEquipment()` = media role → Equipment module. `canManageEquipment()` = Admin,
or the `equipment_custodian` duty.

A note worth recording: the first version of `canManageEquipment()` also accepted an
explicit module grant, copying `canManageCasting()`. That was wrong and the new tests
caught it. Casting has two module keys — `casting` to look and `casting-admin` to run
it — so a grant of the second means authority. Equipment has one key, and it is the key
that lets you *borrow* a camera. Accepting it made every borrower a custodian.

### Kiosk

PIN belongs to a person, stored as a scrypt hash, never returned in any form. Failures
increment a counter and lock the profile for 15 minutes after 5 attempts; the route
carries a 20-per-15-minutes IP budget on top. Unknown person and wrong PIN return the
same message, so the pad cannot be used to enumerate staff. A successful verification
issues a 10-minute session token, stored hashed; the checkout endpoints read the
borrower from the session, and a `holder_id` in the body is ignored when a kiosk token
is present.

---

## 4. QR architecture

```
printed label → opaque token (AT-…) → mo_asset_identifiers → asset row
```

`server/qr.ts` is a self-contained ISO/IEC 18004 encoder: byte mode, error-correction
level M, versions 1–10, all eight masks scored by the standard's penalty rules. It has
no dependencies — a label glued to a lens has to keep resolving for years, so the thing
that generates it is pinned and tested here rather than floating on a version range.

**The token carries nothing mutable.** Not the holder, not the location, not the
status, not the project. It is a random `AT-` + 32 hex characters, generated once and
never derived from the asset tag, category or sequence. `GET /equipment/:id/qr` renders
it; `GET /equipment/resolve/:identifier` resolves it, and also resolves asset tags,
barcodes, serials and RFID values.

Legacy `qr_uid` values are migrated into the identifier table and stay **active**, so
anything already recorded still resolves — they are simply no longer primary.

Verified by `server/qr.test.ts`, which decodes the encoder's own output back to its
payload using a reader written from the specification: placement, masking, block
interleaving and the byte-mode header are all exercised, through version 8 and
multi-byte UTF-8.

---

## 5. Borrower-model findings

Full note: [ASSET_BORROWER_MODEL.md](ASSET_BORROWER_MODEL.md). In brief:

`users.password_hash` is `NOT NULL` and `users.email` is `UNIQUE`, so every holder must
today be a person who can sign in. Students and faculty cannot be represented.
`mo_casting_records` is the precedent that matters — a full person record with no
account — and the recommendation is `mo_borrowers`, a party table where `user_id` is
optional, with the ledger denormalising `borrower_name_at` so history survives a name
change, an archive or a departure.

**`holder_id` was deliberately not redesigned in this phase.** The note is binding on
the future migration, and the current implementation was written so that when
`borrower_id` arrives it is one function — `resolveHolder()` — that changes, not a
dozen handlers.

---

## 6. Asset identifier architecture

```sql
mo_asset_identifiers (
  id, asset_id → mo_equipment_items,
  kind CHECK (asset_tag|qr|barcode|serial|rfid|internal),
  value TEXT NOT NULL,
  is_primary, is_active, created_at, created_by, retired_at )
```

- `UNIQUE(value)` across the whole table, retired rows included — a scanner hands over
  a string with no idea what kind it is, and a value that once meant one camera must
  never later resolve to another.
- `UNIQUE(asset_id, kind) WHERE is_primary AND retired_at IS NULL` — one primary of
  each kind per asset.

Existing `asset_tag`, `qr_uid`, `barcode` and `serial_no` values are backfilled as
rows and the columns are left in place, so nothing that reads them breaks. RFID
readiness moves from **PARTIALLY READY** to **READY at the data layer**; no reader,
scan-event or location model exists yet, which is Phase 9.

---

## 7. `/state` performance changes

Documented strategy first, one targeted change second.

**Strategy.** `/state` runs ~60 sequential full-table `SELECT`s per boot per user. The
destination is per-module paginated reads; `GET /equipment` (filtered, paginated, max
200) and `GET /equipment/:id` (one asset with its history) are the first of them, and
the Equipment catalog can move onto them without further server work. The remaining
datasets are classified in the audit; moving them is Phase 4 proper and needs UI work
in step, so it was not done blind here.

**What changed now**, because its cost grows with every check-out:

| Dataset | Before | After |
|---|---|---|
| `equipment_transactions` | every row, forever | latest per item **+** most recent 500 |
| `equipment_bookings` | every row, forever | active/reserved, or ending within 90 days |

The latest-per-item half is what `eqHolder()` reads, so the holder chip, "My items",
the overdue calculation and the sidebar badge stay **exact at any table size**. Older
rows are history, served per asset by `GET /equipment/:id`. No UI consumer changed
behaviour; this is the one part of Phase 4 that could not wait.

---

## 8. API changes

**Hardened (6):** `POST /equipment`, `POST /equipment/bookings`,
`POST /equipment/bookings/:id/cancel`, `POST /equipment/:id/checkout`,
`POST /equipment/:id/checkin`, `POST /equipment/:id/damage`.

**New (10):**

| Method · Path | Purpose | Authorization |
|---|---|---|
| `GET /equipment` | paginated, filtered list | module |
| `GET /equipment/:id` | one asset + identifiers, history, bookings | module |
| `PATCH /equipment/:id` | metadata (never status) | custodial |
| `POST /equipment/:id/status` | manual transition | custodial |
| `POST /equipment/:id/retire` | lifecycle end, history preserved | custodial |
| `POST /equipment/:id/identifiers` | add QR/barcode/serial/RFID | custodial |
| `GET /equipment/:id/qr` | real QR label (JSON or SVG) | module |
| `GET /equipment/resolve/:identifier` | any identifier → asset | module |
| `GET /equipment/rules` | the published policy | module |
| `POST /equipment/kiosk/pin`, `/kiosk/session`, `/kiosk/session/end` | kiosk credentials and sessions | self or custodial |

No endpoint was removed or renamed. Every mutation authorizes, validates, audits and
preserves history.

**New audit actions:** `equipment.updated`, `equipment.status_changed`,
`equipment.retired`, `equipment.identifier_added`, `equipment.resolved`,
`equipment.kiosk_pin_set`, `equipment.kiosk_pin_cleared`,
`equipment.kiosk_pin_failed`, `equipment.kiosk_session_opened`.

---

## 9. Database migrations

All in `bootstrapAssetFoundation()`, additive and idempotent.

**`mo_equipment_items`** — `created_at`, `updated_at`, `retired_at`, `retired_by`,
`retired_reason`.
**`mo_user_profiles`** — `kiosk_pin_hash`, `kiosk_pin_set_at`,
`kiosk_failed_attempts`, `kiosk_locked_until`.
**New:** `mo_asset_identifiers`, `mo_kiosk_sessions`.
**Backfill:** every existing `asset_tag`, `qr_uid`, `barcode` and `serial_no` becomes
an identifier row; every asset without a primary QR token gets one.

Nothing dropped, nothing renamed, no data destroyed.

---

## 10. Test coverage

**Before:** 983 tests, **zero** touching any equipment endpoint.
**After:** 1099 tests. **+116 added.** 1089 pass; the 10 failures are pre-existing and
unrelated (§11).

| Suite | Tests | Covers |
|---|---|---|
| `server/qr.test.ts` | 18 | structure, round-trip decode to v8, determinism, uniqueness, overlong refusal, printable SVG |
| `server/equipment-rules.test.ts` | 27 | BR-7, BR-8 both directions, overdue arithmetic, AUTO-3 tiers, configurable thresholds, transitions, VR-8 |
| `server/mediaops-equipment.integration.test.ts` | 60 | auth × 4 actor kinds, checkout, forged holder, check-in, wrong holder, booking conflicts, identifiers, QR, kiosk, lifecycle, tag races |
| `src/test/equipment-ui.test.ts` | 11 | kiosk pad no longer self-advances, session token sent, real QR fetched, BR-7/BR-8 reported from the server |

Against the required matrix: AUTH ✅ · CHECKOUT ✅ · CHECK-IN ✅ · BOOKING ✅ · QR ✅ ·
KIOSK ✅ · LIFECYCLE ✅ · BUSINESS RULES ✅.

**One deliberate gap.** AUTO-3's *notification fan-out* is covered at unit level
(`escalationFor`) rather than end to end. Running the global automation pass in a test
writes notification rows against every genuinely overdue loan in whatever database the
suite points at — and `.env.local` points at the dev database. The selection rule is
pure and exhaustively tested; what the integration suite asserts is the part with
teeth, that BR-7 actually refuses the checkout.

No existing test was weakened. `Handlers.kioskPinLimiter` is optional precisely so the
13 suites that mount this API without limiters keep working.

---

## 11. Remaining technical debt

1. **The test database is the dev database.** `.env.local` sets `DATABASE_URL` to
   `nerve`, not `nerve_test`. The 10 failures in `mediaops-creator-payouts` are that
   suite colliding with demo seed data, identical before and after this work. **This
   should be fixed before anything else** — it is why a test run can damage real data.
2. **`mediaops-creator-points.integration.test.ts:545`** still runs
   `UPDATE mo_creator_cycles SET status='closed' WHERE status='active'` with no prefix,
   closing other suites' cycles. Out of scope here; the equipment suite writes no
   unscoped statement.
3. **S12 unfixed:** shoot creation still swallows booking conflicts with
   `.catch(() => {})`. It sits in the work-assignment handler, not in equipment, and
   fixing it changes assignment behaviour — Phase 5.
4. **Maintenance still cannot be resolved.** `resolved_at` and `next_due_at` are written
   by no code path. An asset put into `maintenance` now has a route back
   (`POST /:id/status`), which is a workaround, not the workflow. Phase 7.
5. **Pooled tracking remains unimplemented.** `pool_quantity` is still read by nothing.
6. **Kits remain read-only.** No endpoint.
7. **The Equipment catalog still reads `/state`**, not `GET /equipment`. The endpoint
   exists and is tested; moving the eight tabs onto it is UI work.
8. **No location model.** Only `campus_id`. Phase 1 of the audit's roadmap named
   `mo_locations`; it was not built here because nothing yet consumes it.
9. **The kiosk person-picker lists the whole active crew.** Acceptable for a cupboard
   tablet; a large roster will want search or a badge scan.

---

## 12. Recommended next phase

**Phase 4 proper — move the Equipment UI onto the paginated reads.** The endpoints
exist and are tested; the catalog, availability and transactions tabs still render from
the `/state` arrays. Doing this next converts the read work already done into the
actual performance win, and it is the last thing that has to happen before the asset
count can grow.

Then Phase 7 (maintenance that can be resolved), because an asset that cannot come back
into service is a correctness problem, not a feature gap.

**Before Phase 6**, answer the five policy questions in §8 of the borrower note. They
are not engineering decisions and they gate the FK change.

---

**Nothing in the audit's later phases was built. This is foundation, security,
correctness and lifecycle only.**
