# Asset & Inventory — deployment, rollback and migration readiness

Written for whoever runs the first production deployment of the Asset &
Inventory module and the inventory import that follows it. Phase 17P.

## 1. What the module adds to the database

All of it is created by `bootstrapMediaOpsDatabase()` in
[server/mediaops-db.ts](../server/mediaops-db.ts), which the API runs at
startup, after the core schema and before it listens.

**Tables** — `mo_inventory_scopes`, `mo_user_inventory_scopes`,
`mo_equipment_categories`, `mo_equipment_items`, `mo_equipment_bookings`,
`mo_equipment_transactions`, `mo_maintenance_records`, `mo_asset_inspections`,
`mo_inspection_policies`, `mo_asset_identifiers`, `mo_asset_import_batches`,
`mo_asset_import_rows`, `mo_kiosk_sessions`, `mo_equipment_kits`,
`mo_kit_items`, plus the shared `mo_audit_logs` and `mo_notifications`.

**Reference rows seeded once** — the `media_crew` and `pid` inventory scopes,
the `equipment_custodian` duty flag, and the equipment categories. Seeds are
`ON CONFLICT DO NOTHING`, so an administrator's later edits survive a restart.

## 2. Ordering is part of the contract

Every statement is idempotent — `IF NOT EXISTS` throughout. **That makes a
statement safe to repeat. It does not make it safe to run early**, and the
difference is invisible on any database that already has the schema.

Three ordering faults were found in 17P by building a database from nothing,
which is something no test does: the test database is created once and kept.
Each one stopped the bootstrap outright, so a first deployment could not start:

```
error: relation "mo_equipment_transactions" does not exist
error: relation "mo_maintenance_records" does not exist
error: column "scope_id" does not exist
```

`npm run audit:migration-order` now checks this statically and fails the run on
a fault. Run it with the other audits before a release.

## 3. Verified

- A brand-new, empty database bootstraps end to end.
- Three further consecutive bootstraps change nothing: schema, indexes,
  constraints, module defaults, user profiles, inventory scopes, duty flags and
  row counts are byte-identical afterwards, on both a fresh and a long-lived
  database.

## 4. Rollback

There are no down migrations and none should be written for appearance: every
statement here is additive, and a `DROP` written to look symmetrical is a
loaded gun pointed at an estate's history.

**Take a database backup before the first deployment and before the inventory
import.** That is the rollback plan, and it is sufficient because nothing in
this module rewrites or deletes pre-existing data.

**Irreversible, and why:**

| Change | Why it cannot be undone cleanly |
|---|---|
| `mo_equipment_bookings.created_at` | Back-filled with the migration's own timestamp. The real creation time was never recorded and cannot be recovered, so dropping and re-adding the column loses every genuine value written since. |
| Internal code allocation (`MC-0001`, `PID-0001`) | Codes are printed on labels and stuck to equipment. A rollback that reissues them makes the labels wrong. |
| QR identifiers | Same: printed and physically attached. |
| Audit log rows | Append-only by design. |
| Inspections, transactions, maintenance | The ledger the module exists to keep. |

The legacy module-key expansion (17N/17P) is worth naming separately: it used
to widen `allowed_modules` on every boot for any profile containing `projects`
or `performance`. It is fixed, but **profiles widened by earlier boots stay
widened** — the widened rows cannot be told apart from deliberate grants, and
narrowing them would remove somebody's access. That is an administrative
review, not a migration.

## 5. Ready to receive the real inventory

Verified present and working, with no fake inventory created:

- **Scopes** — `media_crew` and `pid` exist, each with its code prefix.
- **Internal codes** — allocated per scope under an advisory lock, gapless,
  and only once an asset has an inventory.
- **Duplicate and identity conflict detection** — serial matching ignores case
  and punctuation, so `SN: x-123` and `x123` are one serial.
- **Pooled vs serialized** — decided per row during review, not guessed.
- **QR** — generated on demand from the asset's identifier; nothing is minted
  during import.
- **Verification and physical verification** — an imported row is a draft until
  somebody confirms it against the object.
- **Batch visibility** — scoped: a custodian sees a batch only if they may see
  a row in it.
- **Caps** — 5 MB per upload, one file, 5,000 rows per batch, `.csv`/`.xlsx`/
  `.xls` only, and the parse decides what the file is, not its name.

The source workbook is roughly 68 Media Crew and 218 PID rows. **Revalidate
those numbers against the actual workbook at import time** — they are from an
earlier count and this phase did not open it.

## 6. Running it locally

`npm run dev:native` — API on `API_PORT` (3001) and the web app on 8080, which
proxies `/api` to the API. The Media Ops app is served by the API at
`/api/media-ops/`, and its API base is the relative path `/api/v1/media`, so it
always talks to whichever origin served it. There is no second configuration
mechanism and no host is hard-coded.

**A stale API process is the failure mode to know about.** `npm run dev:server`
uses `tsx watch` and reloads; a plain `tsx server/index.ts` does not. One of
those left running holds the port, the watcher cannot bind it, and the browser
gets 404s from an older Nerve for endpoints that exist in the source. That is
exactly what produced "Bookings could not be loaded — HTTP 404". `dev-native.sh`
refuses to start when the ports are busy, which is the check that catches it.
