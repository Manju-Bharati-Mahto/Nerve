# Asset Approval Review (Phase 16E)

**Validator result: BLOCKED. Migration is not permitted.**

Both inventories are now approved and 179 of 286 rows carry a decision.
The remaining **107 rows were left pending deliberately** — every one of them
needs a judgement that cannot be made from the workbook or the source sheet.

**No database was touched.** This phase read two files and wrote two. No scope
record was created, no asset was created or modified, no serial was invented.

---

## What was approved

### Sheet 08 — inventories

| Proposed Scope | Source Heading | Rows | Approved? | Approved By | Date |
|---|---|---|---|---|---|
| `MEDIA_CREW` | MEDIA CREW | 68 | **YES** | Rahul Joshi | 2026-09-22 |
| `PID` | STUDIO / PID | 218 | **YES** | Rahul Joshi | 2026-09-22 |

This approves **the names**. No `mo_inventory_scopes` record was created — that
happens at migration, and the database still holds zero scopes.

### Sheet 01 — 179 rows

| Decision | Rows |
|---|---|
| `CONFIRM_NEW` | **177** |
| `CONFIRM_POOLED` | **2** |

Each carries `Decided By = Rahul Joshi`, `Decision Date = 2026-09-22`, and a
note recording **how** it was approved: a bulk rule, not individual inspection.
That distinction is in the workbook so nobody later mistakes 179 bulk approvals
for 179 physical checks.

### Eligibility was re-derived, not inherited

A row was approved only when **both** the machine's proposal *and* an
independent re-check agreed. The re-check tested the underlying facts rather
than the label: reconciliation status is `NEW`, no candidate existing asset is
named, tracking model is `SERIALIZED` or `POOLED`, category is resolved, the
source reference is not a named ambiguity, an internal code exists, the
inventory is one of the two approved, a pooled row has a positive quantity, and
the review flag carries no duplicate-risk, possible-match, consumable,
non-numeric or missing-sequence marker.

**Disagreements between the two methods: 0 of 286.**

### Nothing was renamed, recoded or invented

| | |
|---|---|
| Source equipment names changed | 0 |
| Row numbers / source references changed | 0 |
| Internal asset codes changed | **0** — `MC-####` / `PID-####` preserved exactly |
| Manufacturer serials written | **0** |
| Ambiguous rows converted to make validation pass | **0** |

---

## What was left pending, and why

**107 rows.** None was resolved by assumption.

| Rows | Decision still required |
|---|---|
| **81** | **Accessory — serialized or pooled?** chargers 26, bags 18, batteries 14, XLR/adapters 7, battery cells 7, cloths 5, magic arms 3, snoot 1 |
| **17** | **Possible existing match** — confirm `EXISTING ASSET` or `NEW PHYSICAL ASSET` (14 × `EQ-LEN-*`, 2 × `EQ-AUD-001`, 1 × `EQ-LGT-004`) |
| **4** | **Duplicate identity** — physical verification |
| **3** | **Named reference** — `TOUR`, `MANAV`, `JOVIAN` |
| **1** | **No sequence** — `PXW Z190`, row 51: how many units? |
| **1** | **Category unresolved** — `SONY 85`, row 16 |

### The four camera rows

| Row | Source name | Inventory | Candidates |
|---|---|---|---|
| 4 | `SONY S3` | MEDIA_CREW | EQ-CAM-001, EQ-CAM-002 |
| 5 | `SONY S3` | MEDIA_CREW | EQ-CAM-001, EQ-CAM-002 |
| 75 | `SONY FX 3` | PID | EQ-CAM-001, EQ-CAM-002 |
| 272 | `Sony ɑ M3` | PID | EQ-CAM-001, EQ-CAM-002 |

`EQ-CAM-001` (SN-FX3-0091) is out with Aakash Mehta, due 2026-07-30.
`EQ-CAM-002` (SN-FX3-0114) is out with Rahul Joshi, due 2026-07-28.

Four rows across **both** inventories fit the same two cameras. One camera
cannot be Media Crew's and Studio/PID's at once. Approving these would have
meant guessing which physical body each row names — exactly what this process
exists to prevent.

### The five identity rows

| Row | Name | Value | Question |
|---|---|---|---|
| 8 | `SONY M4` | `TOUR` | a third body, a location, or a label? |
| 16 | `SONY 85` | — | is `85` a focal length, a model, or a sequence? |
| 51 | `PXW Z190` | *(blank)* | one unit or several? |
| 58 | `2 LANE CONNECTOR` | `MANAV` | a person — is the sheet recording custody here? |
| 59 | `2 LANE CONNECTOR` | `JOVIAN` | as above |

---

## Validator output

```
BLOCKED
  rows in manifest         286
  approved inventories     MEDIA_CREW, PID
  rows with a decision     179
  rows without a decision  107
  database mutations       0
  blocking findings        132
```

| Count | Blocking reason |
|---|---|
| 86 | no decision recorded (proposal `IDENTITY_DECISION_REQUIRED`) |
| 21 | no decision recorded (proposal `PHYSICAL_VERIFICATION`) |
| 17 | possible match unresolved |
| 8 | duplicate identity unresolved (4 rows × 2 candidates) |

Findings fell from **313 to 132**. The two scope-approval blocks are cleared.

---

## To reach READY_FOR_MIGRATION

1. **Sheet 02** — 4 camera rows. Inspect EQ-CAM-001 and EQ-CAM-002, write
   `EXISTING ASSET` or `NEW PHYSICAL ASSET` per line, then the matching
   `Decision` on sheet 01.
2. **Sheet 03** — 17 possible matches. Expect to reject some: `SONY 24MM` is
   offered against a 24-70mm zoom on weak evidence.
3. **Sheet 04** — 81 accessories, decidable by family rather than row:
   are chargers tracked individually, or stock? bags? batteries? cables?
4. **Sheet 05** — the 5 identity rows above.
5. Re-run:
   ```
   node scripts/validate-governance-manifest.mjs \
     docs/governance/Asset_Reconciliation_Workbook_APPROVAL_REVIEW.xlsx
   ```

One open item that is **not** blocking but must be settled before the pooled
rows are written: the two approved pooled rows propose category
**"Battery / Cell"**, while the existing pooled-mode category in Nerve is named
**"Battery"**. Noted on sheet 07 as a migration-time mapping decision.

---

## Files

| File | State |
|---|---|
| `docs/governance/Asset_Reconciliation_Workbook.xlsx` | **unmodified** (mtime and size unchanged) |
| `/Users/rjtheorigin/Documents/Equipments  - Sheet3.csv` | **unmodified** — read only |
| `docs/governance/Asset_Reconciliation_Workbook_APPROVAL_REVIEW.xlsx` | **created** |
| `docs/governance/Asset_Approval_Review_Report.md` | **created** |
| `docs/governance/Asset_Approval_Review.json` | created — the 107 held rows with reasons |
| `docs/governance/Asset_Governance_Validation_Result.json` | overwritten by the validator run |

**Migration is not allowed to proceed.**
