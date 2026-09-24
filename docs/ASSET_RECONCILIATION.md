# Asset Reconciliation Package (Phase 16C)

**Read-only. No scope was created, no asset was created or changed, no
scope_id was assigned, no custodian was appointed. Database mutations: 0.**

This is the package Media Ops leadership approves *before* anything is
migrated. It sets the 286 rows of `Equipments - Sheet3.csv` against the 32
assets already in Nerve and asks for five decisions. It makes none of them.

---

## What is in the workbook

`docs/governance/Asset_Reconciliation_Workbook.xlsx` — nine sheets:

| Sheet | Rows | What it is for |
|---|---|---|
| `01_Master_Reconciliation` | 286 | every source row, one primary decision state each |
| `02_Duplicate_Risks` | 8 | 4 source rows × their competing candidates |
| `03_Possible_Matches` | 17 | one candidate each |
| `04_Accessories_Review` | 81 | serialized or stock? |
| `05_Identity_Review` | 5 | what does this row even name? |
| `06_New_Asset_Candidates` | 177 | confirm as new |
| `07_Pooled_Candidates` | 2 | confirm the counts |
| `08_Scope_Approval` | 2 | **P-1** — approve the inventory names |
| `09_Review_Instructions` | — | order of work, and what was deliberately not done |

Also `Asset_Reconciliation.csv` (the master sheet) and
`Asset_Reconciliation.json`.

---

## Decision states

Every one of the 286 rows carries exactly one:

| State | Rows |
|---|---|
| `CONFIRM_NEW` | **177** |
| `IDENTITY_DECISION_REQUIRED` | **86** |
| `PHYSICAL_VERIFICATION` | **21** |
| `CONFIRM_POOLED` | **2** |
| `CONFIRM_EXISTING` | **0** |
| `SCOPE_DECISION_REQUIRED` | **0** |

`CONFIRM_EXISTING` is proposed for no row, deliberately: concluding that a
spreadsheet line *is* an asset already in Nerve is a human act, taken on sheet
02 or 03. `SCOPE_DECISION_REQUIRED` is unused per row because every row sits
under an unambiguous heading — what is unapproved is the two scope **names**,
which is sheet 08.

---

## 1. Duplicate cases — the four that matter most

Two `Sony FX3` records exist in Nerve. **Four source rows, from both sections,
point at them:**

| Source row | Section | Source name | Competing candidates |
|---|---|---|---|
| 4 | MEDIA CREW | `SONY S3` | EQ-CAM-001, EQ-CAM-002 |
| 5 | MEDIA CREW | `SONY S3` | EQ-CAM-001, EQ-CAM-002 |
| 75 | STUDIO / PID | `SONY FX 3` | EQ-CAM-001, EQ-CAM-002 |
| 272 | STUDIO / PID | `Sony ɑ M3` | EQ-CAM-001, EQ-CAM-002 |

Both candidates are **currently checked out**:

| Asset | Serial | Held by |
|---|---|---|
| EQ-CAM-001 | SN-FX3-0091 | Aakash Mehta |
| EQ-CAM-002 | SN-FX3-0114 | Rahul Joshi |

**Why this needs a person, not a rule.** Two sections of the sheet appear to
claim the same two cameras — `SONY S3` under Media Crew and `SONY FX 3` under
Studio/PID. One physical camera cannot belong to both inventories. Either
these are four distinct bodies and Nerve is missing two, or the sheet lists the
same units twice under different names. **If all four were imported as new,
Nerve would hold six camera records for what may be two cameras**, two of them
already out on loan.

The decision for each row is exactly one of: **EXISTING ASSET** (name the unit)
or **NEW PHYSICAL ASSET**. Nothing here proposes a winner — the source carries
no manufacturer serial, so paperwork alone cannot settle it. Somebody has to
look at the cameras.

---

## 2. Identity ambiguities

Five rows where the source does not say what the value means.

### `MANAV` and `JOVIAN` — sequence column holding names

| Row | Name | Reference |
|---|---|---|
| 58 | `2 LANE CONNECTOR` | `MANAV` |
| 59 | `2 LANE CONNECTOR` | `JOVIAN` |

Both are preserved as **`source_reference`** and are **not** serial numbers.
They read as people, which would mean the sheet is recording *custody* in the
sequence column — a different fact from identity. If so, these are two
connectors currently with two named individuals, and Nerve records custody
through checkout, not through a name in a spreadsheet cell.

### `TOUR`

| Row | Name | Reference |
|---|---|---|
| 8 | `SONY M4` | `TOUR` |

Preserved as `source_reference`, marked `REQUIRES_REVIEW`. Is `TOUR` a third
body, a location, or a label on the case? `SONY M4` also appears with
sequences 1 and 2, so this may be a third unit — or the same unit annotated.

### No sequence at all

| Row | Name |
|---|---|
| 51 | `PXW Z190` |

The sequence cell is empty. One unit or several is unstated. **No sequence was
invented.** (Note `PXW Z190 CHARGER` on the next row *does* carry a sequence.)

### Bare numeric

| Row | Name |
|---|---|
| 16 | `SONY 85` |

A brand and a bare number. `85` is most likely a focal length, which would make
this a lens — but the sheet does not say, and `85` could equally be a sequence.
Recorded in `IDENTITY_REVIEW` rather than guessed. Every other bare-number row
(`SONY 24/70`, `SAMYANG 50 1.4`, `SONY 24MM` …) resolved to Lens on focal-length
or aperture notation; this one has neither.

---

## 3. Accessory and pooled decisions

**81 accessory rows** need a tracking decision, grouped as a **proposal only**:

| Proposed grouping | Rows | Families | Reasoning offered |
|---|---|---|---|
| **LIKELY INDIVIDUAL** | 41 | chargers (26), bags (18 → see note), magic arms, snoot | durable, device-specific, and the source counts each one |
| **AMBIGUOUS** | 40 | batteries & cells (21), cables & adapters (9), cloths (5) | consumable and interchangeable, yet the source still numbers each one |

Nothing was auto-serialized. The honest position is that **a numbered list does
not distinguish "five tracked chargers" from "a drawer with five chargers in
it"** — the sheet counts, it does not say whether anyone tracks.

`Cloths (2 green,1 black , 2 white)` is the clearest contradiction: the name
describes a set of five, and there are five numbered rows. One reading says one
row per cloth; the other says five bundles.

**2 pooled rows** carry an explicit quantity range and were not expanded:

| Row | Name | Range | Units | Proposed code |
|---|---|---|---|---|
| 128 | `panasonic rechargeable cell` | `1 to 48` | 48 | PID-0041 |
| 252 | `Rechargeable cell` | `1 to 29` | 29 | PID-0125 |

Expanding these would have produced 361 rows instead of 286 and invented 75
assets nobody has labelled.

---

## 4. Scope approval — P-1, still open

| Proposed Scope | Source Heading | Rows | Approved? |
|---|---|---|---|
| `MEDIA_CREW` | `MEDIA CREW` | 68 | **PENDING** |
| `PID` | `STUDIO / PID` | 218 | **PENDING** |

These are **the spreadsheet's own headings**, carried through unchanged. They
are not approved Nerve scopes, **no database record exists for either**, and
every row on the master sheet reads `Scope Approval = PENDING`.

Approving them means answering P-1: are *Media Crew* and *Studio/PID* the two
inventories the university intends to govern, under those names? A third
inventory, a rename, or a split is still open.

---

## 5. Human actions required, in order

1. **Sheet 08** — approve, rename or reject the two inventory names. Everything
   else is provisional until this is settled.
2. **Sheet 02** — the four camera rows. Physically inspect EQ-CAM-001 and
   EQ-CAM-002 (currently with Aakash Mehta and Rahul Joshi) and decide, per
   source row, EXISTING or NEW.
3. **Sheet 03** — 17 possible matches, mostly lenses. Expect to reject some:
   `SONY 24MM` is offered against a 24-70mm zoom because category, brand and
   the number 24 agree, which is weak evidence and is labelled as such.
4. **Sheet 05** — the five identity rows: `MANAV`, `JOVIAN`, `TOUR`,
   `PXW Z190`, `SONY 85`.
5. **Sheet 04** — accessories: individual or stock, per family.
6. **Sheets 06 and 07** — confirm the 177 new candidates and the 2 pooled
   counts.

Only after 1–6 does an import become a safe operation.

---

## What was deliberately not done

- **No winner chosen.** Where several Nerve assets fit one row, all are listed
  with their serials and current holders.
- **No manufacturer serial invented.** Blank on all 286 rows; `Sr. No` is a
  source sequence and stays in its own column.
- **No quantity range expanded.**
- **Codes are proposals.** `PROPOSED_INTERNAL_ASSET_CODE` — 200 issued to the
  177 new and 2 pooled candidates plus 21 verification rows; the 86 unsettled
  rows have none, because a code names a record and these are not yet known to
  be one.
- **Existing identifiers untouched.** The 32 existing assets keep their `EQ-`
  tags, QR identifiers and serials.

---

## Database safety

Session set `READ ONLY` before any query. Verified before and after:

`mo_equipment_items` · `mo_equipment_transactions` · `mo_equipment_bookings` ·
`mo_maintenance_records` · `mo_inventory_scopes` · `mo_user_inventory_scopes` ·
`mo_asset_identifiers` · `mo_user_duties` · `mo_audit_logs`

**All unchanged. Database mutations: 0.**
