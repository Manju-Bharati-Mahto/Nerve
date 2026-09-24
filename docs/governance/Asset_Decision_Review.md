# Asset Decision Review — the 107 pending rows

Read-only. Nothing was approved, changed, coded or created to produce this.
Every fact below is taken from the workbook, the source sheet, or the live
asset records.

| Section | Rows |
|---|---|
| 1 — physical camera duplicate / identity | **4** |
| 2 — possible existing-asset matches | **17** |
| 3 — accessory tracking-mode decisions | **81** |
| 4 — identity / data ambiguities | **5** |
| **Total** | **107** |

---

## SECTION 1 — 4 physical camera duplicate / identity cases

Each row has **two** candidates, so eight lines. Both cameras are out on loan.

| Source Row | Inventory | Source Equipment Name | Candidate Nerve Asset | Manufacturer Serial | Current Holder | Due Date | Decision Required |
|---|---|---|---|---|---|---|---|
| 4 | MEDIA_CREW | `SONY S3` | EQ-CAM-001 — Sony FX3 | SN-FX3-0091 | Aakash Mehta | 2026-07-30 | EXISTING or NEW |
| 4 | MEDIA_CREW | `SONY S3` | EQ-CAM-002 — Sony FX3 | SN-FX3-0114 | Rahul Joshi | 2026-07-28 | EXISTING or NEW |
| 5 | MEDIA_CREW | `SONY S3` | EQ-CAM-001 — Sony FX3 | SN-FX3-0091 | Aakash Mehta | 2026-07-30 | EXISTING or NEW |
| 5 | MEDIA_CREW | `SONY S3` | EQ-CAM-002 — Sony FX3 | SN-FX3-0114 | Rahul Joshi | 2026-07-28 | EXISTING or NEW |
| 75 | PID | `SONY FX 3` | EQ-CAM-001 — Sony FX3 | SN-FX3-0091 | Aakash Mehta | 2026-07-30 | EXISTING or NEW |
| 75 | PID | `SONY FX 3` | EQ-CAM-002 — Sony FX3 | SN-FX3-0114 | Rahul Joshi | 2026-07-28 | EXISTING or NEW |
| 272 | PID | `Sony ɑ M3` | EQ-CAM-001 — Sony FX3 | SN-FX3-0091 | Aakash Mehta | 2026-07-30 | EXISTING or NEW |
| 272 | PID | `Sony ɑ M3` | EQ-CAM-002 — Sony FX3 | SN-FX3-0114 | Rahul Joshi | 2026-07-28 | EXISTING or NEW |

**The constraint:** only **two** physical cameras exist in Nerve, and **at most
two** of these four rows can be `CONFIRM_EXISTING` — one per camera. The other
two must be `CONFIRM_NEW` or withdrawn.

**The cross-inventory problem:** rows 4 and 5 are Media Crew; rows 75 and 272
are PID. If a row from each side claims the same camera, one physical body
would belong to two inventories, which the model does not allow.

**What only you can say:** whether `SONY S3`, `SONY FX 3` and `Sony ɑ M3` are
three names for the same kind of body or three different cameras. The serials
`SN-FX3-0091` and `SN-FX3-0114` are on the physical bodies — reading them is
the decisive act.

---

## SECTION 2 — 17 possible existing-asset matches

| Source Row | Inventory | Source Name | Candidate ID | Candidate Name | Manufacturer Serial | Matching Evidence | Weak Evidence / Conflict | Decision |
|---|---|---|---|---|---|---|---|---|
| 13 | MEDIA_CREW | `SONY 35 MM` | 10 | Sony FE 16-35mm f/2.8 GM | SN-L1635-08 | Sony + 35, both Lens | source reads as a **35mm prime**; candidate is a **16-35 zoom** | |
| 14 | MEDIA_CREW | `SONY 35 MM` | 10 | Sony FE 16-35mm f/2.8 GM | SN-L1635-08 | Sony + 35, both Lens | same conflict; **also competes with rows 13, 76, 286** | |
| 17 | MEDIA_CREW | `SONY 24/70` | 8 | Sony FE 24-70mm f/2.8 GM II | SN-L2470-33 | Sony + 24 + 70 — focal range matches exactly | competes with rows 18, 78, 79, 288 | |
| 18 | MEDIA_CREW | `SONY 24/70` | 8 | Sony FE 24-70mm f/2.8 GM II | SN-L2470-33 | as above | as above | |
| 24 | MEDIA_CREW | `CANON 24/105` | 12 | Canon RF 24-105mm f/4L | SN-RF24105-19 | Canon + 24 + 105 — matches exactly | competes with row 25; source does not say RF or EF mount | |
| 25 | MEDIA_CREW | `CANON 24/105` | 12 | Canon RF 24-105mm f/4L | SN-RF24105-19 | as above | as above | |
| 76 | PID | `SONY 16/35` | 10 | Sony FE 16-35mm f/2.8 GM | SN-L1635-08 | Sony + 16 + 35 — matches exactly | competes with rows 13, 14, 286 — and 13/14 are **Media Crew** | |
| 77 | PID | `SONY 85 G MM` | 11 | Sony FE 85mm f/1.8 | SN-L85-44 | Sony + 85, both Lens | source says **"G"**; the candidate f/1.8 is **not** a G-series lens | |
| 78 | PID | `SONY 24MM` | 8 | Sony FE 24-70mm f/2.8 GM II | SN-L2470-33 | Sony + 24, both Lens | source reads as a **24mm prime**; candidate is a **24-70 zoom** | |
| 79 | PID | `SONY 24/70` | 8 | Sony FE 24-70mm f/2.8 GM II | SN-L2470-33 | Sony + 24 + 70 — matches exactly | competes with rows 17, 18 (**Media Crew**), 78, 288 | |
| 108 | PID | `Godox SL 60 II D` | 21 | Godox SL60W | SN-SL60-88 | Godox + 60, both Light | **"SL 60 II D" and "SL60W" are different models** | |
| 129 | PID | `Zoom H6` | 25 | Zoom H6 Recorder | SN-ZH6-1290 | name matches once spacing is ignored | competes with row 130 | |
| 130 | PID | `Zoom H6` | 25 | Zoom H6 Recorder | SN-ZH6-1290 | as above | as above | |
| 281 | PID | `Sony lens 70-200 mm` | 9 | Sony FE 70-200mm f/2.8 GM II | SN-L70200-12 | Sony + 70 + 200 — matches exactly | none beyond the missing serial | |
| 286 | PID | `Sony 16 - 35 mm` | 10 | Sony FE 16-35mm f/2.8 GM | SN-L1635-08 | Sony + 16 + 35 — matches exactly | competes with rows 13, 14, 76 | |
| 287 | PID | `Sony 85 mm` | 11 | Sony FE 85mm f/1.8 | SN-L85-44 | Sony + 85, both Lens | source gives no aperture; competes with row 77 | |
| 288 | PID | `Sony 24mm` | 8 | Sony FE 24-70mm f/2.8 GM II | SN-L2470-33 | Sony + 24, both Lens | **prime vs zoom conflict**; competes with rows 17, 18, 78, 79 | |

### The structural limit

Seventeen rows point at only **seven** distinct assets:

| Candidate | Claimed by rows | Count |
|---|---|---|
| EQ-LEN-001 (24-70) | 17, 18, 78, 79, 288 | 5 |
| EQ-LEN-003 (16-35) | 13, 14, 76, 286 | 4 |
| EQ-LEN-004 (85mm) | 77, 287 | 2 |
| EQ-LEN-005 (24-105) | 24, 25 | 2 |
| EQ-AUD-001 (H6) | 129, 130 | 2 |
| EQ-LEN-002 (70-200) | 281 | 1 |
| EQ-LGT-004 (SL60W) | 108 | 1 |

**At most 7 of the 17 can be `CONFIRM_EXISTING`; at least 10 must be
`CONFIRM_NEW`.** EQ-LEN-001 and EQ-LEN-003 are each claimed from **both**
inventories, the same cross-inventory conflict as the cameras.

---

## SECTION 3 — 81 accessory tracking-mode decisions

**I have not decided serialized vs pooled for any family.** The source numbers
each item, which is evidence of counting but not of tracking.

| Family | Rows | Quantity if known | Current Proposed Tracking Mode | Evidence | Decision Required |
|---|---|---|---|---|---|
| **Chargers** | 26 | not stated; highest sequence 5 | `REQUIRES_REVIEW` | 9 distinct names, each separately numbered: Canon 200d ×5, Canon 1500DII ×5, SONY ×4, panasonic cell ×4, cell ×3, Canon 700D ×2, CANON ×1, LUMIX ×1, PXW Z190 ×1. Both inventories. | serialized per charger, or stock per type? |
| **Batteries** | 21 | not stated; highest sequence 7 | `REQUIRES_REVIEW` | Sony battery ×7, SONY EXTRA BATTRAY ×5, BATTRAY M4 3 TOUR ×2, FX BATTRAY ×2, plus BATTRAY S3 1 / S3 2 / M4 1 / M4 2 / C2. Both inventories. **Nerve already holds `EQ-BAT-POOL` (Sony NP-FZ100, qty 24) as pooled stock** — a precedent, not a decision. | serialized per battery, or stock per type? |
| **Bags** | 18 | not stated; highest sequence 7 | `REQUIRES_REVIEW` | big camera bag ×7, canon camera bag ×5, sony small bag ×4, sony alpha camera bag ×2. PID only. | serialized, or stock? |
| **XLR / adapters** | 7 | not stated; highest sequence 4 | `REQUIRES_REVIEW` | `G4 + 2 MX XLR to AUX` ×4, `XLR to AUX (MX)` ×3. PID only. The "G4 + 2 MX" name reads as a **kit** of several parts. | serialized, stock, or kits? |
| **Cloths** | 5 | name implies 5 (2 green, 1 black, 2 white) | `REQUIRES_REVIEW` | one name, `Cloths (2 green,1 black , 2 white)`, on 5 numbered rows. PID only. | 5 individual cloths, or 5 bundles of 5? |
| **Arms** | 3 | not stated; highest sequence 3 | `REQUIRES_REVIEW` | `magic arm` ×3. PID only. | serialized, or stock? |
| **Snoot** | 1 | not stated | `REQUIRES_REVIEW` | `snoot` ×1. PID only. A light modifier. | serialized, or stock? |

**On "Cells":** there is no separate cells family among these 81. The rows
containing "cell" are *chargers* (`panasonic cell charger`, `cell charger`) and
are counted under Chargers. The two genuine cell rows —
`panasonic rechargeable cell` (1 to 48) and `Rechargeable cell` (1 to 29) —
carry explicit quantity ranges, are already `CONFIRM_POOLED`, and are **not**
pending.

---

## SECTION 4 — 5 identity / data ambiguities

| Row | Inventory | Source Name | Sequence | Reference | What is missing |
|---|---|---|---|---|---|
| **8** | MEDIA_CREW | `SONY M4` | *(blank)* | `TOUR` | `SONY M4` also appears with sequences **1** and **2**. This third row has `TOUR` where a number should be. Missing: whether `TOUR` is a **third body**, a **location**, or a **label on an existing body**. If it is a third body it needs its own code; if it is an annotation, this row is not an asset. |
| **16** | MEDIA_CREW | `SONY 85` | `1` | — | The name is a brand plus a bare number and nothing else. Missing: what `85` denotes. Every other bare-number row resolved to a lens through focal-plus-aperture (`50 1.4`) or a focal range (`24/70`); this has neither. Missing: whether it is an **85mm lens**, a **model designation**, or something else. Category is `REVIEW`, so no reconciliation was attempted against existing assets. |
| **51** | MEDIA_CREW | `PXW Z190` | *(blank)* | — | The sequence cell is empty, while the very next row (`PXW Z190 CHARGER`) **does** carry a sequence. Missing: **how many units** this row represents. One camcorder, or several? No sequence was invented, so no internal code was issued. |
| **58** | MEDIA_CREW | `2 LANE CONNECTOR` | *(blank)* | `MANAV` | The sequence column holds a **person's name**. Missing: whether the sheet is recording **custody** here rather than identity. Nerve records custody through checkout, not through a spreadsheet cell — so if `MANAV` holds this connector, that is a checkout, not an asset attribute. |
| **59** | MEDIA_CREW | `2 LANE CONNECTOR` | *(blank)* | `JOVIAN` | Identical to row 58. Together they suggest **two connectors**, each with a person — but the sheet never says so. |

`TOUR`, `MANAV` and `JOVIAN` are held in `Source Reference` and have **not**
been written into any serial field.

---

## What I need from you

1. **Section 1** — per row: `EXISTING` (name which camera) or `NEW`. Remember
   at most two rows can be EXISTING.
2. **Section 2** — per row: `EXISTING` or `NEW`. At most one row per candidate
   asset; at least 10 of the 17 must be NEW.
3. **Section 3** — per family: `SERIALIZED` or `POOLED` (with a quantity).
4. **Section 4** — per row: what the value means, and how many units exist.

Nothing has been approved, changed or created. Waiting for your decisions.
