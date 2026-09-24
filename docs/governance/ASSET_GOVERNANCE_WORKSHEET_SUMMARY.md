# Asset Governance Worksheet — Summary

Generated **2026-09-22** from the live `nerve` database over a session set
`READ ONLY`, so a stray write would have errored rather than relying on
discipline. **Nothing was written.**

This worksheet exists because the Phase 16 audit established that **no
trustworthy automatic asset → inventory scope mapping exists**. Every candidate
signal was tested and rejected. The mapping has to be made by people who know
the cupboards, and this is the sheet they make it on.

---

## The estate

| | |
|---|---|
| **Total assets** | **32** |
| **Unscoped** (`scope_id IS NULL`) | **32** |
| **Scoped** | **0** |
| On loan | **10** |
| — of which overdue | **10** (oldest due 2026-07-24) |
| Assets with a **current or future** booking | **0** |
| Assets with a **stale** booking | **18** |
| Assets with open maintenance | **2** |
| Retired | 0 |
| Soft-deleted | 0 |
| Pooled assets | **3** |
| Inventory scopes in the database | **0** |
| **Assets flagged for human review** | **23** |

### By category

| Category | Assets |
|---|---|
| Camera Body | 7 |
| Lens | 6 |
| Light | 4 |
| Microphone | 3 |
| Tripod / Support | 3 |
| Audio Recorder | 2 |
| Drone | 2 |
| Gimbal | 2 |
| Accessory | 1 |
| Battery | 1 |
| Memory Card | 1 |

### By lifecycle status

`AVAILABLE` 19 · `CHECKED_OUT` 10 · `MAINTENANCE` 2 · `BOOKED` 1

### By custody status (derived from the latest transaction)

`NEVER MOVED` 18 · `ON LOAN` 10 · `IN STORE` 4

---

## Three things the reviewer should know before starting

**1. All 25 "live" bookings have already ended.** Twenty-five bookings still
carry `reserved` or `active` status, but the latest window closed on
**2026-08-17** — over a month ago. So no booking blocks anything today, and
**18 assets display as booked when they are not**. Flagged per asset as
`STALE BOOKING`. This is a data-hygiene matter, not a scope question, but an
asset that looks committed and isn't will mislead whoever is deciding its home.

**2. Every loan is overdue.** All 10 checked-out assets are past their return
date, the oldest by roughly two months. Scope can still be assigned to an asset
on loan — it changes nothing about custody — but the reviewer should know these
are not routine active loans.

**3. One asset contradicts itself.** One row carries status `booked` with no
current booking. Reported as `CONTRADICTION`, not as an error: the row says one
thing and the records say another, and only a person can say which is right.

---

## Scope options — for review only

These are **labels on a form**, not records. None exists in the database, and
Phase 16A created none:

- Media Crew Production Inventory
- Academic Inventory — PID
- Academic Inventory — 24 Frames Studios
- Other / Requires Decision

Whether these are the right inventories is itself the open decision (**P-1**).
A reviewer who finds none of them fits should use *Other / Requires Decision*
rather than forcing a fit.

---

## How the worksheet is meant to be used

One row per asset. Fill in three columns; leave the rest alone:

| Column | What to do |
|---|---|
| **Proposed Inventory Scope** | Choose one of the four options above |
| **Human Confirmation** | `NO` → `YES` once you are sure |
| **Reviewer** / **Review Date** | Who decided, and when |
| **Mapping Status** | `PENDING` → `CONFIRMED`, or `REQUIRES DECISION` if it cannot be settled |
| **Notes** | Anything the next person needs |

**`Proposed Inventory Scope` ships deliberately blank for all 32 rows.** It was
not derived from department, campus, category, asset-tag prefix, vendor,
project, holder or history. Those appear in the sheet **as evidence to read**,
never as a rule that was applied — filling the column automatically would
manufacture exactly the mapping the audit concluded does not exist.

The two evidence columns — `Evidence — Project` and `Evidence — Pool Qty` —
exist for the same reason: they are facts to weigh, not answers.

### Personal information

The only personal field is **`Current Holder`**, a name, and only for the 10
assets actually on loan. No user id and no email address is included: the
reviewer needs to know who to ask for the camera back, and nothing else about a
person belongs in a circulated spreadsheet.

---

## Files

| File | Purpose |
|---|---|
| `docs/governance/asset-governance-worksheet.csv` | the sheet to fill in (UTF-8 BOM, opens directly in Excel) |
| `docs/governance/asset-governance-worksheet.json` | the same 32 rows plus this summary, machine-readable |
| `docs/governance/ASSET_GOVERNANCE_WORKSHEET_SUMMARY.md` | this document |

---

## What happens after the sheet is filled

Nothing automatic. A completed worksheet is the input to the **first step of
governance activation** (Phase 16 §8), which is still gated on the same two
decisions:

- **P-1** — which inventories exist, and who owns each
- **P-7** — this per-asset mapping

Once both are answered, scopes are created through the existing admin screen and
assets are assigned in reversible batches. **No scope was created, no asset was
assigned, and no custodian was appointed by this phase.**
