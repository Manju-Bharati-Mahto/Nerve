# Identity & Inventory Scope — Foundation Audit

Read-only investigation. **No table, column, role, endpoint, UI or test was
created or changed.**

Companion to — and in two places a **correction of** —
[ASSET_INVENTORY_BORROWER_CUSTODIAN_ARCHITECTURE_AUDIT.md](ASSET_INVENTORY_BORROWER_CUSTODIAN_ARCHITECTURE_AUDIT.md).

---

## 1. Objective

Three blockers, examined deeper than Phase 10 took them:

1. where student/faculty identity lives,
2. what PID and 24 Frames are,
3. whether a borrower must authenticate as a Nerve user.

Two of the three moved. The third did not, and the reason is structural.

### Two corrections to Phase 10

**Correction 1 — "students and faculty do not exist in the schema" was too
strong.** It was true of `users.role` and of column names, but it missed that
**an entire student population already exists**: SMC members. From
`server/mediaops-api.ts:222`:

> *"An SMC member is an institute **student** on the coverage network, not Media
> Crew. They are stored with `team='smc'`…"*

They are Nerve accounts with an academic-unit-scoped domain profile. The
accurate statement is: *there is no generic student identity, but there is a
working precedent for one.*

**Correction 2 — Phase 10 said no pattern exists for an accountable non-user.**
One does, and it is substantial: `mountPortalOtp` (§9).

---

## 2. Identity sources

| Source | Exists? | Identifier | Authentication? | Reusable? | Evidence |
|---|---|---|---|---|---|
| `users` | yes | `id` TEXT PK | **yes** — `password_hash NOT NULL` | as the account substrate | schema |
| `mo_user_profiles` | yes | `user_id` | n/a | yes — `campus_id`, `allowed_modules`, kiosk PIN | schema |
| **`mo_smc_profiles`** | **yes** | `user_id` PK → `users` | via the user account | **yes — the closest template** | §5 |
| `mo_creator_profiles` | yes | `user_id` → `users` | via the user account | yes, as a pattern | Phase 10 |
| `mo_requests` | yes | `requester_email`/`requester_name`, **no FK** | **no** — public token + OTP | partly | §4 |
| `mo_casting_requests` | yes | `applicant_email`, `enrolment_number`, **no FK** | **no** — public token + OTP | partly | §9 |
| **`mo_portal_sessions`** | **yes** | **`email`**, not `user_id` | **OTP-verified, no account** | **yes** | §9 |
| `mo_kiosk_sessions` | yes | **`user_id`** | PIN, on top of an account | yes | schema |
| SSO / LDAP / OAuth / SAML / Azure AD | **no** | — | — | — | repo-wide search: every hit is an AI provider or an unrelated word |
| External student directory / connector | **no** | — | — | — | no connector, no import, no external identity API |

**There is no external identity provider of any kind.** Nerve issues its own
accounts with its own password hashes. Nothing federates.

---

## 3. The Nerve user model

`users`: `id TEXT PK, full_name, email NOT NULL, department TEXT NOT NULL (no
FK), role, team (FK), managed_by, password_hash NOT NULL, status
CHECK(active|inactive|archived)`.

`role` CHECK — nine values, none academic: `super_admin, admin, sub_admin, user,
outreach_manager, branding_reports_admin, design_reports_admin, task_owner,
task_manager`.

Two consequences that constrain everything downstream:

- **Every `users` row is an authenticable account.** `password_hash` is NOT
  NULL. There is no "person record without a login".
- **`users.department` is free text with no foreign key**, while
  `mo_departments` is a real table. The two are not connected, and they mean
  different things.

Membership of Media Ops is `users.team = 'media'` (`moRoleOf()`,
`mediaops-api.ts:67`); `team='smc'` resolves to `'employee'` for module
purposes but is refused by `moRoleOf()` for crew routes.

---

## 4. The `mo_requests` precedent

A complete non-user intake, already in production.

**Who creates one:** either an authenticated coordinator
(`POST /api/v1/media/requests`) or **the public**, through
`/api/v1/public/request/:token` — a route mounted *outside* the authenticated
API.

**Identity of the requester:** `requester_name`, `requester_email`,
`stakeholder`, `contact`, `contact_email`, `contact_phone` — **plain columns,
no foreign key to `users`**. Accountability on the Nerve side is carried by
`received_by`, `converted_by`, `lead_user_id`, all FK to `users`.

**Institute:** represented **twice** — `institute TEXT` (free text) *and*
`academic_unit_id → mo_academic_units`. The duplication is itself a finding:
the schema has not settled whether an institute is a string or a row.

**Workflow:** `status` CHECK — `new, under_review, needs_clarification, ready,
converted, closed, rejected`; `source` CHECK — `manual, external`; plus
`review_note`, `first_touched_at`, `converted_at`, `submitted_ip`.

**Does it distinguish student/faculty/staff?** No. It has no requester-type
column at all.

**Is there an approval?** Not by that name. `under_review → ready → converted`
is a review-and-convert ladder, and `converted_by` names who did it. It is the
nearest existing thing to an approval, and it is a workflow *state machine*, not
an approval entity.

**Relationship to Nerve users:** the requester has none; the handlers do.

---

## 5. The Creator and SMC profile precedents

Two domain populations layered on `users`. SMC is the closer of the two.

```
users (account: email + password_hash + status)
  └── mo_smc_profiles
        user_id          PK → users(id) ON DELETE CASCADE
        academic_unit_id → mo_academic_units(id)   ← SCOPE
        designation      NOT NULL
        manager_id       → users(id) ON DELETE SET NULL   ← RESPONSIBLE PERSON
        is_active        NOT NULL                  ← domain state, independent of users.status
        phone, joining_date, coverage_area, created_by, created_at, updated_at
```

Everything a borrower population would need is demonstrated here:

| Requirement | How SMC already does it |
|---|---|
| a distinct population inside Media Ops | `team='smc'` + a profile row |
| **scoped to an academic unit** | `academic_unit_id → mo_academic_units` |
| a responsible person per member | `manager_id` |
| domain-level active/inactive | `is_active`, separate from `users.status` |
| denied the crew's routes by default | `moRoleOf()` returns null → every pre-existing route refuses them |
| access granted only by its own routes | `/smc/*`, each re-checking ownership |
| created by a manager | `POST /smc/members` — email + temporary password → a real account |
| the unit is called an "institute" | the read model aliases `mo_academic_units.name AS institute` |

`mo_creator_profiles` shows the same layering with a different scope axis
(teams) and its own role vocabulary.

**The architectural point:** a borrower population does not need a new
mechanism. It needs the SMC mechanism pointed at a different scope.

---

## 6. PID evidence

**Zero representations.** A repository-wide search across `server/`, `src/`,
`public/`, `docs/` for `Parul Institute of Design` and `\bPID\b` returns only
occurrences of `pid` as a local variable for `project_id`.

The database has no matching row in `mo_departments` (Media Crew, Content Team,
Outreach), `mo_campuses` (Vadodara, Rajkot) or `mo_academic_units`.

The nearest existing row is **`mo_academic_units` id 6, "Faculty of Design"**
(slug `faculty-of-design`, short name `Design`, `department_id=1`) — an academic
faculty of the university, not an institute named PID.

| Candidate representation | Present? |
|---|---|
| department | no |
| campus | no |
| academic unit | **adjacent only** — "Faculty of Design" exists; PID does not |
| location / team / project / institute string | no |

---

## 7. 24 Frames evidence

**Zero representations.** No match anywhere in the repository or the database,
in any spelling searched (`24 Frames`, `24-Frames`, `24Frames`).

It is also the harder of the two to place: it is a **studio**, not a faculty, so
`mo_academic_units` — the one table that already holds something PID-shaped —
does not obviously fit it.

---

## 8. Inventory scope models

Compared, **not ranked**, and nothing chosen.

### 1. Department-scoped (`mo_departments`)

*Existing support*: highest. `mo_equipment_items.department_id` already exists
and every equipment read model already accepts a `department_id` filter.
*Missing*: nothing structural. *Authorization*: the filter would have to become
a gate derived from the user — which does not exist today (§10).
*Assets*: no change. *Custodians*: `mo_user_duties` would need a scope column.
*Borrowers*: no natural link — `users.department` is free text, unconnected.
*Reporting*: works immediately; every existing breakdown is by department.
*RFID*: unaffected. *Migration*: lowest — insert rows.
*Cost*: `mo_departments` currently means "Media Ops internal team". Putting PID
beside Media Crew changes what the table means, and nothing prevents the two
senses drifting apart.

### 2. Academic-unit-scoped (`mo_academic_units`)

*Existing support*: high, and already proven for **people** —
`mo_smc_profiles.academic_unit_id` and `mo_requests.academic_unit_id`.
*Missing*: assets have **no** `academic_unit_id`; that link does not exist.
*Authorization*: same gap as every other option.
*Custodians*: same scope-column gap. *Borrowers*: **best fit** — this is already
how an SMC student is scoped. *Reporting*: nothing aggregates equipment by
academic unit today. *RFID*: unaffected. *Migration*: assets need a new scope
link. *Cost*: 24 Frames is not a faculty (§7), and `mo_academic_units.department_id`
points at a Media Ops department, an inversion that would have to be lived with.

### 3. A dedicated inventory-scope entity

*Existing support*: none — it does not exist. *Missing*: the entity, plus links
from assets, custodians and borrowers. *Authorization*: the only option that
gives the gate a single, unambiguous subject. *Assets*: a new scope column.
*Custodians*: **the only option that makes "custodian of PID" directly
expressible**. *Borrowers*: an explicit eligibility link. *Reporting*: clean, but
everything existing is written against `department_id`. *RFID*: unaffected.
*Migration*: highest. *Cost*: a new domain object before anyone has asked for
one; and the risk that it becomes a second, parallel department table.

### 4. Campus/location-scoped (`mo_campuses`)

*Existing support*: present — `mo_equipment_items.campus_id` and
`mo_user_profiles.campus_id` both exist. *Missing*: it cannot distinguish PID
from 24 Frames if both sit on the Vadodara campus, which is the likely case.
*Authorization*: a weak gate for this purpose. *Assets*: no change.
*Custodians*/*Borrowers*: no natural link. *Reporting*: answers "where", not
"whose". *RFID*: **the most natural pairing** — a reader is a fixed location.
*Migration*: none. *Cost*: it answers a different question from the one asked.

### 5. Organizational scope + physical location combined

*Existing support*: both axes already exist on the asset — `department_id` and
`campus_id` — so a two-axis model is already half-built.
*Missing*: the ownership axis still has to be decided (options 1–3), and the
gate still has to exist. *Authorization*: gate on ownership, filter on location.
*Assets*: no change. *Custodians*: scope is a pair, which complicates the
assignment. *Borrowers*: eligibility on ownership. *Reporting*: richest.
*RFID*: location axis is exactly right. *Migration*: whatever option 1–3 costs.
*Cost*: two things to keep correct instead of one.

---

## 9. Borrower identity models

### The existing accountable-non-user pattern, in full

This is the Phase 10 gap that was wrong. `mountPortalOtp`
(`mediaops-api.ts:4696`) mounts, for casting and for requests:

```
link token          mo_request_links / mo_casting_links
                      token, name, allowed_domain, active_from,
                      expires_on, is_active, created_by
      ↓
POST {prefix}/:token/otp/send          rate-limited (otpSendLimiter)
      ↓  eligibility: emailInDomain(email, link.allowed_domain)
         "Please use your official @<domain> email address."
         — checked on the server, never on the client
      ↓
mo_portal_otps       otp_hash, attempts, used, expires_at
      ↓
POST {prefix}/:token/otp/verify        rate-limited (otpVerifyLimiter)
      ↓
mo_portal_sessions   token, kind, link_token, EMAIL, expires_at
      ↓
submission row       applicant_email / requester_email, submitted_ip,
                     consent_given, consent_at, consent_version, consent_text
      ↓
portalAudit()        → mo_audit_logs
```

So Nerve **already** establishes: a person, verified at an **official
institutional email domain**, time-boxed, rate-limited, consent-recorded,
IP-recorded and audited — **with no account issued**.

Note the two session models side by side:

| | identity | requires an account |
|---|---|---|
| `mo_portal_sessions` | **`email`** | **no** |
| `mo_kiosk_sessions` | **`user_id`** | **yes** |

The equipment path uses the second. That is precisely why a verified portal
identity cannot hold an asset today.

### What an accountable borrower would additionally require

Beyond what the portal pattern already provides: a **durable** identity (a
portal session expires; a loan outlives it), a link the ledger can reference,
an eligibility state that can be revoked, and — if the ledger is to remain
unchanged — a `users` row, because `holder_id` is `NOT NULL REFERENCES
users(id)`.

**No model is proposed here.** The three shapes the evidence permits are: a
`users` row plus an SMC-style profile; a portal-verified person record that the
ledger would have to be taught to reference; or a hybrid where a portal
verification provisions an account. Each has a different answer to §13 Q3.

---

## 10. Authorization boundary

```
Nerve identity          users.role, users.status              ✓ exists
      ↓
Media Ops membership    users.team = 'media'  (moRoleOf)      ✓ exists
      ↓
Module grant            requireModule(u,'equipment')          ✓ exists, fails closed
      ↓
INVENTORY SCOPE         ─────────────────────────────────     ✗ DOES NOT EXIST
      ↓
Custodian relationship  equipment_custodian duty              ~ exists, GLOBAL, unscoped
      ↓
Borrower eligibility    ─────────────────────────────────     ✗ DOES NOT EXIST
      ↓
Asset operation         canCheckOut / canBook / canRetire     ✓ exists
```

**The chain stops being able to enforce scope immediately after the module
grant.**

Precisely:

- `department_id` and `campus_id` are **caller-supplied query filters** on the
  equipment read models. No endpoint derives either from the authenticated
  user. They narrow a view; they never deny one.
- `mo_user_duties` has no scope column, so `canManageEquipment()` is
  all-or-nothing.
- `requireEquipment()` = media crew + module. Nothing further.
- **The pattern for fixing this already exists in the codebase**:
  `creatorScopeOf(u)` returns `{level:'all'} | {level:'team', teamIds} |
  {level:'self', userId}`, resolved from the user and applied inside the
  Creator queries. An equipment equivalent would be the same shape. It has not
  been written, and this phase did not write it.

---

## 11. Reusable existing infrastructure

- the asset engine entire: items, identifiers (**`rfid` already an allowed
  kind**), bookings with an EXCLUDE constraint, custody, the append-only
  ledger, maintenance, analytics
- `mo_smc_profiles` as the **template** for an academic-unit-scoped population
  layered on `users`
- `mo_creator_profiles` + `creatorScopeOf()` as the **template** for domain
  roles and scope resolution
- `mountPortalOtp` + `mo_portal_otps` + `mo_portal_sessions` + `portalAudit`
  for verified institutional identity without an account
- `mo_academic_units` — already populated, already used to scope both people
  (SMC) and requests
- `mo_requests`' status ladder as a proven review-workflow vocabulary
- the kiosk's separation of operator (`recorded_by`) from holder (`holder_id`)
- duty flags, module grants, fail-closed `effectiveModules()`
- `mo_audit_logs`, notifications, the automation engine

## 12. Missing infrastructure

1. an inventory scope object, whatever §8 option is chosen
2. a scope column on custodian assignment
3. a scope **gate** in the authorization chain (§10)
4. an asset→scope link, if the scope is not `department_id`
5. a borrower population and eligibility state
6. a durable identity for a non-account borrower, if one is wanted
7. equipment request and approval (unchanged from Phase 10)
8. a "who inspected" record (unchanged from Phase 10)

Items 1–4 are all consequences of the same absent concept.

---

## 13. PHASE 11 DECISIONS REQUIRED

Only questions the repository cannot answer.

1. **Where do student and faculty identities live?** The repository shows no
   external directory and no SSO. SMC students exist **because a manager
   created accounts for them by hand**, one at a time. Is that the intended
   route for borrowers, or does a student directory exist outside this
   repository that nobody has connected?
2. **Are PID and 24 Frames organizational units, inventories, locations, or a
   combination?** Neither exists anywhere today (§6, §7). 24 Frames is the
   harder case: it is a studio, and the one table already holding something
   PID-shaped holds *faculties*.
3. **Must every borrower authenticate through Nerve?** The ledger says yes
   today (`holder_id → users`). The portal pattern shows the organisation
   already accepts a weaker, verified identity for other purposes. Which
   standard applies to equipment custody is a policy choice, not a technical one.
4. **Can a faculty or student borrower be represented by an existing Nerve
   identity?** Technically yes — SMC proves it. The question is whether issuing
   an account to every borrower is acceptable operationally, and what
   `users.team` such an account should carry, given that `team` decides what
   the rest of Media Ops shows them.
5. **Who approves an academic equipment request?** No approval exists for
   equipment anywhere. Whether there is one at all is undecided.
6. **Is a custodian assigned per inventory scope?** The duty mechanism implies
   per scope; nothing in the data implies per asset.
7. **Can one inventory have several custodians?** `mo_user_duties` is already
   many-to-many on (user, duty), so many custodians is natural — but with no
   scope, "many custodians of what" cannot be asked yet.

Additionally surfaced by this audit:

8. **Should `institute` be a string or a row?** `mo_requests` carries both
   `institute TEXT` and `academic_unit_id`. Academic Inventory will inherit
   whichever convention is chosen.
9. **What `users.team` should a borrower hold?** `'media'` grants the crew's
   modules; `'smc'` is taken and means something else. A third value has
   consequences for every existing gate.

---

## 14. Implementation gate

### Technically ready — no decision needed

- the asset engine, identifiers (including RFID), bookings, custody, ledger,
  maintenance, analytics
- the module shell, including a module with its own internal navigation
- the audit and notification substrate
- two working templates for a scoped domain population (`mo_smc_profiles`,
  `mo_creator_profiles`) and one for scope resolution (`creatorScopeOf`)
- a working pattern for verified institutional identity without an account

### Blocked by product decisions

| Blocked | On |
|---|---|
| any borrower table or profile | Q1, Q3, Q4, Q9 |
| any inventory scope object | Q2, Q8 |
| custodian scoping | Q2, Q6, Q7 |
| the scope authorization gate | Q2 — it needs a subject |
| request and approval | Q5 |

### Should be reused, not rebuilt

`mo_equipment_*` entire · `mo_asset_identifiers` for RFID ·
`mo_equipment_bookings` for reservations · `mo_smc_profiles` as the population
template · `creatorScopeOf()` as the scope-resolution shape ·
`mountPortalOtp` if a non-account borrower is chosen · `mo_academic_units` ·
`mo_audit_logs`.

### Should NOT be created yet

A borrower table, a custodian table, a loan table, an inventory table, an
academic asset table, a second custody ledger, a second identifier system, new
global Nerve roles, a new authentication path, or any Academic Inventory UI.

**Nothing below "identity confirmation" in the Phase 10 dependency sequence can
begin until Q1–Q4 are answered.** Q2 in particular blocks four separate items,
because a gate cannot be written until there is something to gate on.
