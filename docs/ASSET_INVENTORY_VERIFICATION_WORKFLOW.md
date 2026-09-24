# Asset Verification & Approval Workflow (Phase 17D)

How a record becomes inventory, and why nothing that is already inventory can be
pulled back out.

---

## 1. What verification answers

`verification_state` says whether an asset **record** has been reviewed and
accepted. It says nothing about where the asset is, who holds it, whether it is
booked or whether it is broken — `status`, custody, reservation and maintenance
each keep their own field and none of them is consulted here.

The distinction matters because the two questions have different owners. A
custodian decides whether a record is believable. The ledger decides where the
camera is. A camera can be pending verification and checked out at the same
time, and both statements are true.

---

## 2. Four states, and no fifth

```
draft ──submit──▶ pending_verification ──approve──▶ active
                        │
                        └──reject──▶ rejected ──return_to_draft──▶ draft
```

| State | Meaning | In the catalogue? | Can be issued? |
|---|---|---|---|
| `draft` | staged, not put forward | no | no |
| `pending_verification` | waiting for a custodian | no | no |
| `active` | **is** inventory | yes | yes |
| `rejected` | refused, with a reason | no | no |

**`approved` is deliberately not a persisted state.** Approval is the *act* that
produces `active`. Storing both would put two columns' worth of meaning in one
field with nothing to say which was authoritative. The button says Approve; the
column says `active`.

**Nothing transitions out of `active`.** There is no such row in the matrix and
no endpoint that can write one. This is the phase's central safety property:
every asset in the existing estate is `active`, so a transition out of it would
be a way to make a working camera vanish from the catalogue.

---

## 3. The two populations

| | Existing estate | Registered through Add item | Staged by an importer |
|---|---|---|---|
| Rows | the 32 assets on dev | as today | none yet |
| `verification_state` | `active` (column default) | `active` | `draft`, explicitly asked for |
| In the catalogue | yes | yes, immediately | no, until approved |
| Behaviour after 17D | **unchanged in every respect** | **unchanged** | must be reviewed before use |

No migration touched a row. The column default is `active`, which is what made
the whole phase additive: the estate was already in its final state before the
workflow existed.

**Registration may stage, but may not approve.** `POST /equipment` accepts
`verification_state` only when it is omitted (→ `active`, the existing
behaviour) or exactly `'draft'`. `'active'`, `'pending_verification'`,
`'rejected'` and anything else are refused with a 400. `'draft'` is the one
value that can ever be safe to accept from a client because it makes a record
*less* trusted; asserting that a record is verified is the claim only a reviewer
may make, and it is made through the verification endpoint or not at all. A
staged draft still gets its asset tag and its internal code — staging is about
trust, not identity.

**Verified on dev after this phase: 32 assets, 0 scoped, 0 coded, 32 `active`,
0 in any other state, 0 verification notes.**

---

## 4. Where it is enforced

**The database.**

```sql
CHECK (verification_state IN ('draft','pending_verification','active','rejected'))
CHECK (verification_state <> 'rejected'
       OR (verification_note IS NOT NULL AND btrim(verification_note) <> ''))
```

A rejection that cannot say why is refused by the database, not only by the
handler. No code path — importer, script, psql session — can produce one.

**The endpoint.** `POST /equipment/:id/verification` takes `{action, reason?}`.
The action names a transition; the caller never names the resulting state. The
handler:

- locks the row `FOR UPDATE` inside a transaction;
- refuses an action that is not legal from the row's current state (409);
- refuses `reject` without a non-blank reason (400);
- updates with `WHERE verification_state = <expected from>`, so a concurrent
  winner makes the loser a 409 rather than a silent overwrite;
- releases the client **before** calling `audit()` — this codebase forbids
  auditing under a held pooled client after a real production deadlock;
- clears `verification_note` on any move that is not a rejection, so a stale
  explanation cannot outlive the rejection it belonged to.

Authorization is the existing chain: `requireMedia` → `requireModule('equipment')`
→ `canManageEquipment` → inventory scope. A custodian acting on another
inventory's asset gets the endpoint's own **404**, identical to a non-existent
id, so an asset id is never an existence oracle.

**Circulation.** A record that is not `active` cannot be booked and cannot be
checked out (409, "not part of the inventory yet"). The gate is on the way *in*
only: check-in, damage and maintenance stay open at every verification state,
because blocking a return would strand equipment in somebody's bag over a
paperwork state.

---

## 5. What the client sees

`GET /equipment` — drafts, pending and rejected records are **absent by
default**. `?verification=<state>` opens the door deliberately; `?verification=all`
shows everything. The default is what keeps a staged import off the catalogue.

`GET /equipment/verification-queue?state=&limit=&offset=` — the review list.
Scoped through the same clause as the catalogue, paginated, and it returns
`total` so the tab badge costs no second request. `submitted_by` comes from the
audit trail through one LATERAL join, not from a denormalised column.

The asset read model carries `verification_state` and `verification_note`.
`scope_id` remains absent: the authorization key does not travel to the browser.

---

## 6. The screen

**Asset detail.** The verification row appears **only when there is something to
say** — an `active` asset's page is byte-for-byte what it was before this phase.
A draft, a pending or a rejected record shows its state, the note in full for a
rejection, and the buttons that are legal from there. A rejection is the one move
that cannot be made from a button alone: it opens a modal that will not submit an
empty or whitespace reason.

**Verification tab** (Equipment module, custodians and admins only). One state at
a time, 25 to a page, with the inventory, the internal code, who submitted it and
when. A remembered tab now falls back to the catalogue when the permission that
offered it is gone.

Every control is a convenience. The server re-checks all of it.

---

## 7. Audit

One event per transition, on `entity_type='equipment_item'`:

| Action | Before | After |
|---|---|---|
| `equipment.verification_submitted` | `{verification_state:'draft'}` | `{verification_state:'pending_verification'}` |
| `equipment.verification_approved` | `{…:'pending_verification'}` | `{…:'active'}` |
| `equipment.verification_rejected` | `{…:'pending_verification'}` | `{…:'rejected', reason:'…'}` |
| `equipment.verification_resubmitted` | `{…:'rejected'}` | `{…:'draft'}` |

Submitter and approver are separate rows with separate `actor_id`s, so the trail
can always tell them apart. **A self-approval rule is not implemented** — whether
one person may submit and approve the same record is an open product decision,
not something this phase invented.

---

## 8. Repairs made to earlier phases

**Migrations that rebuilt correct constraints.** `mo_equipment_items_tracking_check`
and `mo_equipment_items_pool_qty_check` (Phase 17A) were written as
`DROP CONSTRAINT IF EXISTS` + `ADD CONSTRAINT`, unconditionally. That takes an
`ACCESS EXCLUSIVE` lock on `mo_equipment_items` on **every** bootstrap, for a
definition that was already right — and roughly fifty test suites bootstrap this
schema concurrently. Both now go through `ensureCheck(name, marker, expr)`, which
compares `pg_get_constraintdef` first and acts only on a difference. A test
compares constraint oids across a second bootstrap, so a regression to the
unconditional form fails.

The same shape still exists on `users`, `mo_requests` and `mo_casting_requests`.
Those tables are outside this phase and were left alone deliberately.

**Three globally-counted test assertions** (TEST_STABILITY entry 14, fourth
through sixth occurrences of the same shape):

- `inventory-scope` "seeds the two APPROVED inventories" counted every asset
  attached to a seeded inventory. Sibling suites legitimately attach their own,
  which 17C made routine and 17D made constant. Now restricted to assets in a
  **registry** category (fixture categories are `<zxx> Something`), and taken
  live — which is stricter than the beforeAll version it replaces.
- `inventory-foundation` "assigns no legacy asset to either" had the mirror
  defect, keyed on its own asset-tag prefix. Same discriminator now.
- `inventory-foundation` "is idempotent" read `remaining_eligible`, which is
  deliberately global for an admin. It now runs against one inventory and checks
  that inventory.

---

## 9. What Phase 17D did not do

- No importer. Nothing creates `draft` rows yet; the workflow is ready for one.
- No bulk approve or bulk reject.
- No self-approval rule, and no reviewer assignment.
- No change to any existing asset, category, inventory or authorization rule.
- No new global role. Reviewing is `canManageEquipment` plus inventory scope,
  exactly as assignment is.
- No transition out of `active`, by any route.
- No equipment or inventory collection returned to `/state`.

---

## 10. Coverage

| Suite | Tests |
|---|---|
| `server/mediaops-inventory-foundation.integration.test.ts` | 111 (17A–17D) |
| `src/test/inventory-foundation.ui.test.ts` | 37 |
| `server/mediaops-inventory-scope.integration.test.ts` | 36 |
| `server/mediaops-inventory-scope-auth.integration.test.ts` | 35 |
| `server/mediaops-custodian.integration.test.ts` | 51 |
| `server/mediaops-equipment.integration.test.ts` | 180 |

What the 17D tests pin, beyond the happy path: every illegal transition is
refused; a rejection without a reason is refused at the handler **and** at the
database; an `active` asset cannot be moved by any action; a generic `PATCH`
cannot drive verification; a client cannot register a record as verified;
verification changes no identity field; two reviewers
racing produce exactly one winner and exactly one audit event; a custodian cannot
see or act on another inventory's queue; a draft is invisible in the catalogue
but still in the table; and an issued asset can always be returned.
