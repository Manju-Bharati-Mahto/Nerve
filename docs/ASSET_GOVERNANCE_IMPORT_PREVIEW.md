# Asset Governance Import Preview (Phase 16B)

**Dry run. Nothing was written to any database.**

The Phase 16 audit concluded that no automatic asset → inventory mapping could
be trusted. That conclusion has not changed — what has changed is that a
**human-provided source now exists**. `Equipments - Sheet3.csv` divides the
estate into two named sections, and those headings, and nothing else, decide
the proposed scope:

```
MEDIA CREW    →  MEDIA_CREW
STUDIO / PID  →  PID
```

No department, campus, category, tag prefix, vendor, holder, project or history
was consulted to place a single row.

---

## Source accounting

| | |
|---|---|
| Lines in the source file | 292 |
| Equipment rows parsed | **286** |
| Lines that are not equipment rows | 6 (2 section headings, 1 column header, 3 blank) |
| **Media Crew rows** | **68** |
| **PID rows** | **218** |

Every line is accounted for: 286 + 6 = 292. Each equipment row appears exactly
once, and the row's original file line number travels with it in
`Source Row` so any question can be taken back to the sheet.

---

## Tracking model

| | |
|---|---|
| **SERIALIZED candidates** | **198** |
| **POOLED candidates** | **2** |
| **REQUIRES_REVIEW** | **86** |
| Physical units represented by the pooled rows | 77 |

### The two pooled rows were not exploded

| Source | Sequence | Quantity | Code |
|---|---|---|---|
| `panasonic rechargeable cell` | `1 to 48` | 48 | PID-0039 |
| `Rechargeable cell` | `1 to 29` | 29 | PID-0123 |

A range is a stock count, not 48 identities. Expanding them would have produced
**361 rows instead of 286** and invented 75 assets nobody has ever labelled.
Both are marked `POOLED`, both keep `1 to 48` / `1 to 29` in
`Source Reference`, and neither received a manufacturer serial.

### Why 86 rows need a human

| Reason | Rows |
|---|---|
| Consumable / accessory family — serialized or stock is a judgement | 81 |
| Non-numeric source value (`TOUR`, `MANAV`, `JOVIAN`) | 3 |
| No source sequence at all (`PXW Z190`) | 1 |
| Category could not be resolved confidently (`SONY 85`) | 1 |

By category: chargers 26 · batteries/cells 21 · bags 18 · cables & adapters 9 ·
cloths 5 · support accessories 3 · cameras 2 · light modifier 1 · unresolved 1.

These were **not** guessed at. A charger numbered 1–5 might be five tracked
devices or a drawer with five chargers in it, and the sheet does not say which.

---

## Internal asset codes

**200 issued** — `MC-0001…MC-0045` and `PID-0001…PID-0155` — to the 198
serialized and 2 pooled candidates. Sequential from 0001 within each inventory,
globally unique, and colliding with no existing Nerve asset tag.

Rows still marked `REQUIRES_REVIEW` deliberately **have no code**: a code names
a concrete inventory record, and these rows have not yet been decided to be one.
They receive codes when review settles them.

### `Sr. No` is not a serial number

**Zero manufacturer serials were written.** The source's `Sr. No` column is a
*source sequence* — a counter within a repeated name — and it is carried in
`Source Sequence`, never in `Manufacturer Serial`. The three non-numeric values
are preserved verbatim in `Source Reference`:

| Source row | Value | Treatment |
|---|---|---|
| `SONY M4` | `TOUR` | `source_reference = TOUR`, flagged for review |
| `2 LANE CONNECTOR` | `MANAV` | `source_reference = MANAV`, flagged |
| `2 LANE CONNECTOR` | `JOVIAN` | `source_reference = JOVIAN`, flagged |

`MANAV` and `JOVIAN` appear to be people. Whatever they are, they are not
serial numbers.

### Repeated names stay separate

57 distinct names repeat in the source, and no repeat was collapsed:

- `SONY S3` ×2 → `SONY S3 1` (MC-0001), `SONY S3 2` (MC-0002)
- `Canon 200DII` ×5 → PID-0081 … PID-0085

The original `Source Equipment Name` is never altered; the numbered form lives
in `Display Equipment Name`.

---

## Reconciliation against the 32 existing Nerve assets

| Status | Rows |
|---|---|
| NEW | **264** |
| POSSIBLE_MATCH | **17** |
| DUPLICATE_RISK | **4** |
| REQUIRES_REVIEW | 1 |
| **MATCHED** | **0** |

**Nothing is reported as MATCHED, and nothing can be.** The source sheet carries
no manufacturer serial, and the 32 existing records' serials were not taken from
it, so no row can be *confirmed* to be a given physical unit. Every name
resemblance is a candidate for a person to settle.

Matching is **category + brand + numbers**, not string similarity. An earlier
pass on raw name overlap matched `SONY C2` — a camera — to three *lenses*
because they shared the digit 2. Requiring the kind of thing to agree first
removed that class of nonsense.

The 21 candidates:

| Source | Category | Existing | Status |
|---|---|---|---|
| `SONY S3` ×2 | Camera Body | EQ-CAM-001 \| EQ-CAM-002 | DUPLICATE_RISK |
| `SONY FX 3` | Camera Body | EQ-CAM-001 \| EQ-CAM-002 | DUPLICATE_RISK |
| `Sony ɑ M3` | Camera Body | EQ-CAM-001 \| EQ-CAM-002 | DUPLICATE_RISK |
| `SONY 24/70` ×3 | Lens | EQ-LEN-001 | POSSIBLE_MATCH |
| `SONY 35 MM` ×2 | Lens | EQ-LEN-003 | POSSIBLE_MATCH |
| `SONY 16/35`, `Sony 16 - 35 mm` | Lens | EQ-LEN-003 | POSSIBLE_MATCH |
| `SONY 85 G MM`, `Sony 85 mm` | Lens | EQ-LEN-004 | POSSIBLE_MATCH |
| `CANON 24/105` ×2 | Lens | EQ-LEN-005 | POSSIBLE_MATCH |
| `Sony lens 70-200 mm` | Lens | EQ-LEN-002 | POSSIBLE_MATCH |
| `SONY 24MM`, `Sony 24mm` | Lens | EQ-LEN-001 | POSSIBLE_MATCH |
| `Godox SL 60 II D` | Light | EQ-LGT-004 | POSSIBLE_MATCH |
| `Zoom H6` ×2 | Audio Recorder | EQ-AUD-001 | POSSIBLE_MATCH |

A `DUPLICATE_RISK` row means two or more existing units fit the name and the
source cannot say which. **Importing one of those rows without confirming would
create a duplicate of an asset that is already in Nerve** — three of which are
currently on loan.

---

## Existing estate, unchanged

| | |
|---|---|
| Existing Nerve assets | 32 |
| Currently scoped | **0** |
| Currently unscoped | **32** |
| Inventory scopes in the database | **0** |

`Current Scope` reads `LEGACY / UNSCOPED` wherever a row matched an existing
asset. `Proposed Scope` is filled from the section heading — **and was not
written anywhere.**

---

## Ambiguities that need a human decision

1. **Which of the 86 accessory rows are tracked individually?** Chargers,
   batteries, bags, cables, cloths and arms are numbered in the sheet, but
   numbering a drawer's contents is not the same as tracking each one.
2. **The 4 DUPLICATE_RISK rows** — which physical unit does each name?
3. **The 17 POSSIBLE_MATCH rows** — is this the asset already in Nerve, or a
   second one? Some are weak (`SONY 24MM` against a 24-70mm zoom) and a
   reviewer should expect to reject a few.
4. **`SONY M4` / `TOUR`** — is `TOUR` a third unit, a location, or a label?
5. **`PXW Z190`** — no sequence. One unit, or several?
6. **`2 LANE CONNECTOR` / `MANAV`, `JOVIAN`** — these look like people holding
   the item. If so, the sheet is recording custody in the sequence column.
7. **`SONY 85`** — a bare number. Lens is likely, but the sheet does not say.
8. **`Cloths (2 green,1 black , 2 white)` numbered 1–5** — the name describes
   five cloths and there are five rows. One row per cloth, or five bundles?
9. **Whether `MEDIA_CREW` and `PID` are the approved inventory names at all.**
   That is decision **P-1**, still open. The section headings are the sheet's
   words, not an approved scope list.

---

## Files

| Path | |
|---|---|
| `docs/governance/Asset_Governance_Import_Preview.xlsx` | 3 sheets: Import Preview, Summary, Lines Not Imported |
| `docs/governance/Asset_Governance_Import_Preview.csv` | 286 rows, UTF-8 BOM |
| `docs/governance/Asset_Governance_Import_Preview.json` | rows + summary + every skipped line with its reason |
| `docs/ASSET_GOVERNANCE_IMPORT_PREVIEW.md` | this document |

---

## Database safety

The connection was set `READ ONLY` before any query. Verified before and after:

`mo_equipment_items`, `mo_equipment_transactions`, `mo_equipment_bookings`,
`mo_maintenance_records`, `mo_inventory_scopes`, `mo_user_inventory_scopes`,
`mo_asset_identifiers`, `mo_user_duties`, `mo_audit_logs` — **all unchanged.**

No scope was created. No asset was assigned. No custodian was appointed.
**Database mutations: 0.**
