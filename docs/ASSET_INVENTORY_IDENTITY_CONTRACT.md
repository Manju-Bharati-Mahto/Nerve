# Asset Identity & Import Contract (Phase 17B)

What an importer may rely on, and what it must never do. Written now so the
importer inherits a contract rather than inventing one.

---

## 1. Six identifiers, none interchangeable

| Field | Owner | Shape | Nullable | Unique |
|---|---|---|---|---|
| `id` | database | bigint | no | yes (PK) |
| `internal_code` | **this system** | `MC-0001`, `PID-0001` | **yes** | yes, partial |
| `asset_tag` | this system | `EQ-CAM-001` (category-derived) | no | yes |
| `qr_uid` / `mo_asset_identifiers.value` | this system | opaque `AT-…` | yes | yes |
| `serial_no` | **the manufacturer** | free text | **yes** | yes, partial, real serials only |
| source `Sr. No` | **the spreadsheet** | a row counter | — | **never stored on an asset** |

**The rule an importer must not break:** the source sequence column is a row
counter. It is not a serial, not a code, and has no column on `mo_equipment_items`.

`internal_code` is inventory-derived; `asset_tag` is category-derived. They
answer different questions and neither replaces the other.

---

## 2. Internal codes

- **Server-allocated only.** `allocateInternalCode(client, scopeId)` — a client
  may never supply one. `POST /equipment` ignores a caller-supplied
  `internal_code`, and a test asserts it.
- **Prefix comes from the inventory row** (`mo_inventory_scopes.code_prefix`),
  so a new inventory is a row, not a deploy.
- **Concurrency-safe**: transaction-scoped advisory lock keyed on the scope,
  plus a partial unique index as the final authority. `MAX()+1` is never used
  in application code.
- **Allocated only for a scoped asset.** No inventory → no prefix → no code.
  This is reported as *code pending*, never guessed.
- **Immutable in practice**: `internal_code` is absent from `ASSET_EDITABLE`,
  so no update route can change it, and the backfill only ever fills a NULL.

---

## 3. Tracking model

| | |
|---|---|
| `mo_equipment_categories.tracking_mode` | the category's default |
| `mo_equipment_items.tracking_mode` | the item's override; `NULL` means "ask the category" |
| `mo_equipment_items.pool_quantity` | a count, `> 0`, and meaningless on a serialized row |

A pooled row is **one record with a quantity**. An importer must not expand a
quantity into individual identities, and must not fabricate serials for them.

---

## 4. Verification state

`draft` → `pending_verification` → `active`, defaulting to `active`.

**Separate from `status`**: `status` says where the asset is (available,
checked out, maintenance); `verification_state` says whether the record is
believed. The registry shows only `active` rows unless a caller explicitly
asks (`?verification=draft`), so an importer can stage rows without them
appearing as real gear.

---

## 5. The seven outcomes an importer must express

| Outcome | How it is represented |
|---|---|
| **NEW ASSET** | insert with `verification_state='draft'`, scope set, code minted at approval |
| **EXISTING ASSET** | no insert; the source row is linked to an existing `id` |
| **POSSIBLE MATCH** | `draft` + the candidate id(s) recorded in the import layer, **never** merged automatically |
| **DUPLICATE** | `draft`, blocked from approval until a person resolves it |
| **NEEDS VERIFICATION** | `pending_verification` |
| **POOLED** | one row, `tracking_mode='pooled'`, `pool_quantity=N` |
| **SERIALIZED** | one row per unit, `tracking_mode='individual'` |

Candidate-match bookkeeping belongs to the **import layer**, not to
`mo_equipment_items`. An asset record states what a thing *is*, not what a
spreadsheet row might have meant.

---

## 6. Service boundaries the importer reuses

| Need | Existing thing to use |
|---|---|
| allocate a code | `allocateInternalCode(client, scopeId)` |
| may this caller touch this inventory | `inventoryScopeOf` / `scopeAllows` / `assetScopeOk` |
| filter a query by reach | `pushInventoryScope(where, scope, params)` |
| act on the estate | `canManageEquipment(u)` |
| record what happened | `audit(actor, action, entityType, entityId, before, after, req, entityUid?)` |
| resolve a printed label | `GET /equipment/resolve/:identifier` — already accepts code, tag, QR, barcode, serial |

**No second allocator, RBAC, audit system or QR store.** An importer that adds
one of those has gone wrong.

---

## 7. Hard constraints an importer will meet

- `uq_mo_equip_internal_code` — one code, one asset
- `uq_mo_equip_serial` — one **real** manufacturer serial, one asset.
  Placeholders (`—`, `-`, `N/A`, `NA`, `NONE`, `NIL`, blank) are **not**
  serials and are excluded from the constraint
- `mo_equipment_items_tracking_check` — `individual` or `pooled`
- `mo_equipment_items_pool_qty_check` — `pool_quantity > 0`
- `mo_equipment_items_verification_check` — the three states above
- `uq_mo_scope_prefix` — one prefix, one inventory

A duplicate real serial is a **409**, not a 500.

---

## 8. Still open

- No importer, no column mapping, no upload endpoint.
- Nothing writes `draft` yet, so the state is exercised only by tests.
- `POST /equipment` mints a code at creation; **assets scoped by any other
  path need the backfill** (`POST /equipment/backfill-codes`).
- The 286 CSV rows remain unapproved and unimported. The four camera
  duplicates and seventeen possible matches are unresolved.
