# Governance Manifest Validation (Phase 16D)

# RESULT: **BLOCKED**

Migration is not permitted. **No migration plan and no migration preview were
generated**, because generating them would imply a readiness that does not
exist.

**Database mutations: 0.** The session was opened `READ ONLY`; counts before and
after are identical across `mo_equipment_items`, `mo_equipment_transactions`,
`mo_equipment_bookings`, `mo_maintenance_records`, `mo_inventory_scopes`,
`mo_user_inventory_scopes` and `mo_audit_logs`.

---

## Why it is blocked, in one line

**The workbook is byte-identical to the one Phase 16C generated. No human has
recorded a single decision in it.**

| Check | Found |
|---|---|
| Rows in the manifest | 286 |
| Rows with a human decision | **0** |
| Verification results recorded (sheets 02/03) | **0 of 25** |
| Inventories explicitly approved | **0 of 2** |
| Blocking findings | **313** |

The file's modification time is unchanged from generation, and every decision
column — `Decision`, `Decided By`, `Decision Date`, `Verification Result`,
`Confirm NEW?`, `Confirm POOLED?`, `Approved?` — is empty.

This is the gate doing its job. A machine proposal is not a human decision, and
this validator will not treat one as the other.

---

## Blocking findings

| Count | Reason |
|---|---|
| 177 | no human decision recorded (proposal was `CONFIRM_NEW`) |
| 86 | no human decision recorded (proposal was `IDENTITY_DECISION_REQUIRED`) |
| 21 | no human decision recorded (proposal was `PHYSICAL_VERIFICATION`) |
| 17 | possible match unresolved (14 × `EQ-LEN-*`, 2 × `EQ-AUD-001`, 1 × `EQ-LGT-004`) |
| 8 | duplicate identity unresolved against `EQ-CAM-001` / `EQ-CAM-002` |
| 2 | no human decision recorded (proposal was `CONFIRM_POOLED`) |
| 2 | scope approval is `PENDING`, not an explicit approval |

### The two that must be settled first

```
Scope MEDIA_CREW
Reason: scope approval is "PENDING", not an explicit approval
Required action: Media Ops leadership must set Approved? = YES on sheet 08,
                 with Approved By and Date (decision P-1)

Scope PID
Reason: scope approval is "PENDING", not an explicit approval
Required action: as above
```

Until both are approved, **no row may be migrated at all**, because every row's
scope would be unapproved.

### The four camera cases

```
Row 4    SONY S3
Reason: duplicate identity unresolved
Required action: physical verification against EQ-CAM-001 (checked out, due 2026-07-30)
                 and EQ-CAM-002 (checked out, due 2026-07-28)

Row 5    SONY S3            — same two candidates
Row 75   SONY FX 3          — same two candidates
Row 272  Sony ɑ M3          — same two candidates
```

Four source rows, from **both** sections, fit the same two physical cameras.
Both are out on loan. One camera cannot belong to Media Crew and Studio/PID at
once, and the source carries no manufacturer serial, so this cannot be settled
from paperwork. Somebody has to look at the cameras.

---

## The validator

`scripts/validate-governance-manifest.mjs` — re-runnable:

```
npx tsx scripts/validate-governance-manifest.mjs [workbook.xlsx]
```

Exit code 0 = `READY_FOR_MIGRATION`, 1 = `BLOCKED`. Full detail lands in
`docs/governance/Asset_Governance_Validation_Result.json`.

### Gates implemented

| Gate | Rule |
|---|---|
| A | both inventories explicitly approved, with an approver and a date |
| B | every row carries exactly one of `CONFIRM_EXISTING` / `CONFIRM_NEW` / `CONFIRM_POOLED`; blank or any of the five blocking states stops migration |
| C | `CONFIRM_EXISTING` names exactly one existing, live asset id — and **no two source rows may claim the same physical asset** |
| D | `CONFIRM_NEW` has inventory, name, tracking model and a unique internal asset code that collides with no existing asset tag; must not also name an existing asset |
| E | `CONFIRM_POOLED` has a positive quantity and `tracking_model = POOLED`; pooled-capable categories must exist |
| F | every duplicate-risk and possible-match line resolved to `EXISTING ASSET` or `NEW PHYSICAL ASSET` |
| G | `MANAV`, `JOVIAN`, `TOUR` and the source sequence may never become a manufacturer serial |
| H | every migrating row's scope is one of the approved inventories |

### It was proven to work in both directions

A gate that can never open is a wall. The validator was self-tested against
fabricated workbooks built in a scratch directory and deleted afterwards —
**the real workbook was never modified**:

| Fixture | Expected | Result |
|---|---|---|
| all decisions present and consistent | READY | **READY_FOR_MIGRATION** |
| one inventory left `PENDING` | BLOCKED | BLOCKED (219) |
| two NEW rows sharing an internal asset code | BLOCKED | BLOCKED (1) |
| an internal asset code equal to `EQ-CAM-001` | BLOCKED | BLOCKED (1) |
| `TOUR` written into Manufacturer Serial | BLOCKED | BLOCKED (1) |
| source sequence copied into Manufacturer Serial | BLOCKED | BLOCKED (1) |
| a `CONFIRM_NEW` row still naming an existing asset | BLOCKED | BLOCKED (1) |
| two rows claiming the same existing asset | BLOCKED | BLOCKED (1) |

The first attempt at the "clean" fixture was itself rejected — it let four
different source rows all claim `EQ-LEN-003`. That was the fixture being wrong
and Gate C being right, and it is the clearest evidence the duplicate
protection works.

---

## What is needed to reach READY_FOR_MIGRATION

1. **Sheet 08** — approve or rename `MEDIA_CREW` and `PID`, with approver and
   date. (P-1)
2. **Sheet 02** — resolve the 4 camera rows by physical inspection.
3. **Sheet 03** — resolve the 17 possible matches; expect to reject some.
4. **Sheets 04 / 05** — settle the 86 identity and accessory rows.
5. **Sheets 06 / 07** — confirm the 177 new and 2 pooled candidates.
6. **Sheet 01** — one final `Decision` per row, with `Decided By` and
   `Decision Date`.

Then re-run the validator. It will either print `READY_FOR_MIGRATION` and
produce the migration plan, or name the remaining rows.

---

## Pooled inventory is representable

Checked against the live schema rather than assumed:
`mo_equipment_categories.tracking_mode = 'pooled'` exists on **Accessory**,
**Battery** and **Memory Card**, and `mo_equipment_items.pool_quantity` is a
nullable integer already in use by `EQ-CRD-POOL` (18), `EQ-BAT-POOL` (24) and
`EQ-ACC-POOL` (15).

So the two pooled rows can be migrated without faking serialized assets —
provided their category resolves to a pooled-mode one. The proposed category
for both is *Battery / Cell*; the existing pooled category is named *Battery*.
**That name mapping is an open question for sheet 07**, not something this
validator will decide.
