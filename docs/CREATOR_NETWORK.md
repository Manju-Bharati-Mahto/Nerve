# Nerve Creator Network — Architecture

> Living document. Reference for every Creator Network phase.
> Status: **Phase 6 complete** — leaderboard, achievements, Creator of the
> Cycle and the War Zone are live. Phase 7 (analytics) has not started.

Parul University runs a creator network: an incentive-based content workforce
producing reels, shorts, vlogs, event and campus content, paid in points, ranks
and payouts. It is run today through WhatsApp and spreadsheets. Nerve is
becoming the system of record; WhatsApp can stay a communication channel, but
the operational truth lives here.

The Creator Network is a **vertical inside Media Ops**, not a second product.

---

## 1. The shape of it

```
NERVE USER  (one identity, one login, one session)
    │
    ├── Employee        users.team='media'   + mo_user_profiles.mo_role
    ├── SMC member      users.team='smc'     + mo_smc_profiles
    └── Creator         users.team='creator' + mo_creator_profiles.creator_role
                                                   ├── creator_admin
                                                   ├── team_lead
                                                   └── creator
```

This mirrors SMC deliberately. SMC proved the pattern: a vertical is a built-in
`teams` row plus a profile table, and the containment falls out of machinery
that already exists.

## 2. Why this is safe by construction

`moRoleOf()` returns `null` for any team outside `media`/`smc`, and
`requireMedia()` refuses `null`. So a `team='creator'` user is refused by
**every pre-existing Media Ops route** without a line of new denial code — the
same mechanism that already contains SMC.

The two hierarchies cannot inherit each other because they read different
columns and neither reads the other's:

| | reads | never reads |
|---|---|---|
| `moRoleOf()` | `users.team`, `users.role` | `creator_role` |
| `creatorRoleOf()` | `mo_creator_profiles.creator_role` | `mo_role` |

Therefore:

- A **Creator Admin is not a Nerve Admin.** `creator_role` is invisible to `moRoleOf()`.
- A **Media Team Lead is not a Creator Team Lead.** `mo_role` is invisible to `creatorRoleOf()`.
- A **creator is not a Media Ops employee.** `team='creator'` ⇒ `moRoleOf()` null ⇒ 403.

### The hole this had to close

`moduleGroupOf()` returns `null` for an unrecognised team, `effectiveModules()`
turns that into `null`, and `requireModule()` reads `null` as **unrestricted**.
A creator would have passed every module gate in Media Ops.

Two things prevent it, and both must stay:

1. `moduleGroupOf()` returns `'creator'` for `team='creator'`.
2. Bootstrap seeds `mo_module_defaults('creator', ["creator"])`.

There is a test named for this. Do not remove it.

## 3. Module access ≠ creator role

These answer different questions and must not be conflated:

- **Module** (`creator`) — *may you open this section?* Admins pass, as they do
  for every module. Reached through the ordinary Nerve module system.
- **Creator role** — *what are you inside the network?* Comes only from a
  profile row. A Nerve Admin has none and is therefore not a Creator Admin.

`GET /creator/context` returns both separately for exactly this reason.

## 4. Data model

| Table | Key | Purpose |
|---|---|---|
| `mo_creator_profiles` | `user_id TEXT` PK → `users` | role, status, display name, type, joined/exited |
| `mo_creator_teams` | `id BIGINT` | name, lead, colour/icon, active/archived |
| `mo_creator_team_members` | `(team_id, user_id)` | membership, one primary per creator |
| `mo_creator_events` | `id BIGINT` | an event needing coverage (Phase 2) |
| `mo_creator_opportunities` | `id BIGINT` | a role on an event, and the rule it earns |
| `mo_creator_interests` | `(opportunity_id, user_id)` | interest — never an assignment |
| `mo_creator_assignments` | `id BIGINT` | the work itself, the ownership anchor |
| `mo_creator_submissions` | `id BIGINT` | a version of the content, and its verdict (Phase 3) |
| `mo_creator_point_rules` | `id BIGINT` | what a thing is worth (Phase 4) |
| `mo_creator_cycles` | `id BIGINT` | the period points count towards |
| `mo_creator_point_ledger` | `id BIGINT` | **every point transaction — the source of truth for performance** |
| `mo_creator_payout_rules` | `id BIGINT` | ₹ per point, with an effective window (Phase 5) |
| `mo_creator_payouts` | `id BIGINT` | one statement per creator per cycle: the calculation snapshot |
| `mo_creator_financial_ledger` | `id BIGINT` | **every money movement — the source of truth for money** |
| `mo_creator_achievements` | `id BIGINT` | what can be earned — a definition (Phase 6) |
| `mo_creator_achievement_awards` | `id BIGINT` | what was earned, revocable but never deleted |
| `mo_creator_cycle_awards` | `id BIGINT` | Creator of the Cycle, with the rank and points that justified it |
| `mo_creator_competitions` | `id BIGINT` | a War Zone competition |
| `mo_creator_competition_participants` | `(competition_id, user_id)` | who entered |
| `mo_creator_competition_scores` | `id BIGINT` | competition score entries — **not Creator points** |
| `mo_creator_competition_results` | `id BIGINT` | the finalised places, snapshotted |

`teams` gains a built-in `creator` row (the 7th).

**Creator teams are not `mo_teams`.** `mo_teams` drives Media Crew project
routing, `assignableMemberIds()` and workload; putting creators in it would
surface them in Media Ops pickers and give Media Team Leads scope over
creators. Separate tables are what keep the hierarchies apart.

**Everything future references `user_id TEXT`** — tasks, submissions, points,
payouts, competitions — exactly as `mo_smc_submissions.submitted_by` already
does. There is no second creator id to keep in step.

### Naming

Outreach owns `outreach_creators`: **external influencer accounts** it tracks
(handle, followers, geography). Unrelated to this. Everything here is
`mo_creator_*` and touches no Outreach table.

## 5. Lifecycle

`mo_creator_profiles.status` — `active | inactive | suspended | archived` — is
the network's own lifecycle, separate from `users.status`. A creator can be
suspended from the network while their Nerve account stays usable.

`creatorRoleOf()` returns `null` unless status is `active`, so a suspended or
archived creator keeps every point, submission and payout and loses every
right. **Nothing is ever deleted.**

One subtlety worth keeping: a creator-team user whose profile is not active is
refused *before* the module check, because the `creator` module reaches them
through their team's group defaults and would otherwise let them back in.

## 6. Scope

Resolved server-side from the session, never from the request.

| Caller | Sees |
|---|---|
| Nerve Admin | the whole network |
| Creator Admin | the whole network |
| Creator Team Lead | the creator teams they lead |
| Creator | their own records |

Every future creator query must filter through `creatorScopeOf()` and must
never accept a `user_id` or `team_id` from the client as the thing being scoped
to. The Phase 0 endpoints take no identifiers at all.

## 7. Audit

Reuses `mo_audit_logs` — no second audit system. Note `entity_id` is `BIGINT`,
so user-scoped actions follow the existing convention (`entity_id` null, the
id inside the JSON payload), as `crew.removed` already does. Team-scoped
actions can use the `BIGINT` team id directly.

Phase 0 has no mutations, so it writes no audit rows. Every phase that changes
points, ranks, payouts, assignments or creator status must.

## 8. API

All under the existing `/api/v1/media` prefix, behind the existing session auth
and rate limiting. Every one calls `requireCreatorNetwork()`; every write also
calls `requireCreatorManage()`.

| Endpoint | Returns / does |
|---|---|
| `GET /creator/context` | the caller's role, scope, whether they may manage |
| `GET /creator/me` | the caller's own profile — takes no id |
| `GET /creator/status` | network size, narrowed to scope |
| `GET /creator/state` | **the shell payload** — identity, profile, team, lead, teams, counts |
| `GET /creator/creators` | directory: `q`, `status`, `role`, `team_id`, `limit`, `offset` |
| `GET /creator/creators/:id` | one creator, scope applied to the lookup itself |
| `POST /creator/creators` | enrol — `{user_id}` or `{email, full_name, password}` |
| `PATCH /creator/creators/:id` | role, status, team, type, notes |
| `GET /creator/teams` · `GET /creator/teams/:id` | teams, scoped; members of one |
| `POST /creator/teams` · `PATCH /creator/teams/:id` | create; rename, activate, assign lead |
| `POST /creator/teams/:id/members` | add (a move — one primary team) |
| `DELETE /creator/teams/:id/members/:userId` | remove |

### `GET /creator/state` — why it exists

`GET /state` gates on `requireMedia()`, which does not admit creators **and must
not start**. Before Phase 1 the SPA's boot caught that 403 and silently fell
through to seed data, so a creator would have been shown a demo Media Crew.

`/creator/state` is the scoped answer: identity, own profile, team, lead, the
teams they may see, and counts only where counts mean something. It carries no
projects, deliverables, crew, equipment or reports — asserted by a test.

## 9. Navigation

One `NAV` entry at `#/media/creator` in its own group. The module key is
derived from the route (`modKeyOf`), so it matches the server's
`CREATOR_MODULE` with nothing to keep in sync. Marked `optIn`, so no role
silently acquires it. A user without the module never sees the group.

## 10. Phase 1 — directory, teams, hierarchy

### The client

One page, three audiences, decided by what the server returns rather than by
the client:

| Caller | Sees |
|---|---|
| Creator Admin / Nerve Admin | counts, directory (Creators / Teams tabs), management actions |
| Creator Team Lead | their team, read-only |
| Creator | their own profile, team and lead — no directory, no tabs |

A creator-team user cannot load the Media Ops shell, so `hydrateCreatorShell()`
swaps the app onto `/creator/state`: every Media Ops table is emptied, one user
(them) is injected, and their module set becomes exactly `['creator']`. The
existing `moduleAllowed()` then resolves the sidebar to the Creator Network and
nothing else — no new permission logic, the same gate on a smaller truth.

### Directory queries

Filtered, sorted and paged **in SQL** (default 50, max 200). The browser never
receives rows it then hides — at a thousand creators that is both slow and a
disclosure. `CREATOR_SELECT` joins the team and its lead, so a page is one
query rather than one per row.

Contact details are redacted for anyone but a network manager, per row, the way
casting already redacts phone numbers.

### Scope, in one place

`creatorScopeSql()` turns the scope into a SQL clause, and every read goes
through it. A forged `team_id` can only **narrow** — the scope clause is
applied first and a filter can only add to it. An id outside scope reads as
**404, not 403**, so the directory cannot be probed for who is on the network.

### Roles and status

Role changes and status changes are Creator Admin only, with one guard on top:
**nobody changes their own role or status**, Creator Admin included. That stops
a Team Lead promoting themselves and keeps "who may promote" from becoming
circular.

The endpoint writes no `users` column at all, so a Creator Admin cannot grant a
Nerve role — tested by sending `role`, `team` and `mo_role` in the payload and
asserting the account is untouched.

Suspension is not escapable through a team: a suspended creator is refused the
network **before** the module check, and cannot be added to a team at all.

### Team Leads

Explicitly appointed, never inferred. A nominee must already be on the network
and active; appointing an ordinary creator promotes them to `team_lead` and
audits it, the same way naming a Media Crew lead already promotes.

### Audit

`mo_audit_logs`, no second system. `creator.created`, `creator.updated`,
`creator.role_changed`, `creator.status_changed`, `creator.archived`,
`creator.restored`, `creator.team_joined` / `team_moved` / `team_left`,
`creator_team.created` / `renamed` / `status_changed` / `lead_assigned` /
`lead_changed`. A test asserts no password or token ever reaches the trail.

### Indexes

`mo_creator_profiles(creator_role, status)`, `mo_creator_teams(lead_user_id)`
partial on live rows, unique `lower(name)`, and the primary-team partial unique
index on `mo_creator_team_members(user_id)` — all from Phase 0, all still the
ones these queries need.

## 10b. Resolved in Phase 1 — the old known gap

**`GET /api/v1/media/state` gates on `requireMedia()`, so a `team='creator'`
user cannot hydrate the Media Ops client.** The API works for them; the
existing SPA shell does not load.

Phase 0 deliberately did not touch `/state` — widening a broad endpoint to
carry creator data is exactly the wrong move. Phase 1 must choose:

- **A.** A scoped `GET /creator/state` serving only what a creator's own
  surface needs. *(Recommended — matches the TV board precedent.)*
- **B.** Admit creators to `/state` with heavy server-side filtering.
- **C.** A separate lightweight creator surface, as `/api/media-tv/` is.

**Resolved with option A.** `/creator/state` exists, and the SPA boots creators
onto it. Media Ops `/state` was not touched.

## 11. Roadmap

| Phase | Scope |
|---|---|
| **0 ✅** | Architecture, identity, roles, teams, RBAC, scope, nav, API foundation |
| **1 ✅** | Creator directory, creator teams, hierarchy, scoped shell |
| **2 ✅** | Events, opportunities, interest, selection, assignment, tasks |
| **3 ✅** | Content submission, versioning, review and verdicts |
| **4 ✅** | Point rules, point ledger, cycles, rank engine |
| **5 ✅** | Payout rates, payouts, financial ledger, payment, statements |
| **6 ✅** | Leaderboard, achievements, Creator of the Cycle, War Zone |
| 7 | Analytics, creator growth, management intelligence |
| 8 | Notifications, automation, chat, AI, platform integrations |

Each phase owns its database changes, service layer, APIs, permissions,
frontend, validation, audit, tests and regression run. Phases are not combined.

## 12. Security boundaries

Never trusted from the client: role, permissions, creator identity, team scope,
admin status. The Phase 0 endpoints accept no identifiers, which is the
cheapest way to hold that line.

Escalation paths explicitly tested and closed: creator → team lead, team lead →
creator admin, creator admin → Nerve Admin, and module grant → creator role.

---

## PHASE 1 COMPLETE

**Implementation notes**

- No schema change. Phase 0's three tables and their indexes carried Phase 1
  unmodified — which is the test of whether Phase 0 was right.
- One identity per person throughout. Enrolment either links an existing Nerve
  account or creates one; a duplicate email answers with `USER_EXISTS` or
  `CREATOR_EXISTS` and whose account it is, never a second row.
- Enrolling existing Media Ops staff as a Creator Admin leaves their Nerve role
  and team exactly as they were. Asserted.
- `CR_` was already the Casting Request namespace in the client; the Creator
  Network uses `CN_`.

**Phase 2 starts here:** events and tasks, referencing
`mo_creator_profiles.user_id`, scoped through `creatorScopeOf()`, with interest
registration and assignment as separate steps. Nothing in Phase 1 needs to
change first.

---

## PHASE 2 — events → opportunity → interest → selection → assignment → task

### The rule the phase turns on

**Interest is not assignment.** A creator raising a hand is a claim; being
chosen is a decision somebody makes; the assignment is its consequence. Three
records, three actors, three timestamps — so months later the network can still
answer *who applied, who was chosen, and who was passed over*.

The counts on an opportunity card say it out loud: `18 interested · 5 of 5
assigned`.

### Why these are new tables

Two reuse paths were checked and both are blocked by evidence, not preference:

- **`mo_projects`** feeds the production pipeline, the dashboard and the office
  TV board. A creator event put there would appear on all three.
- **`mo_assignments.project_id` is `NOT NULL`** against `mo_projects`, so
  creator work could only live there by dropping a constraint on a live Media
  Ops table.

A test asserts no creator event reaches either table.

### Entities

| Table | Holds |
|---|---|
| `mo_creator_events` | the event — title, unit, venue, date, times, status |
| `mo_creator_opportunities` | what it needs — title, creator type, **required_count**, task deadline, status |
| `mo_creator_interests` | a claim and its decision — status, `decided_by`, `decided_at` |
| `mo_creator_assignments` | **the assignment, which is also the task** |

```
mo_creator_events 1─* mo_creator_opportunities ─┬─* mo_creator_interests
                                                └─* mo_creator_assignments
```

**Assignment and task are one row.** In this phase they are strictly 1:1 — same
creator, same opportunity, one shared lifecycle — so a separate task table would
repeat every column and add no fact. Selection and assignment, which *are*
different events, stay separate. If a later phase needs several tasks per
assignment, a child table can be added without disturbing any of this.

### State machines

Controlled server-side. The client names a **transition**, never a status.

```
event        draft → open → closed → completed → archived   (cancelled from most)
opportunity  draft → open → closed                          (cancelled from most)
interest     interested → withdrawn | selected | not_selected
assignment   assigned → accepted → in_progress → completed
                    ↘ declined (from assigned or accepted)
                    ↘ cancelled (manager only)
```

Nothing leads out of `declined` or `completed`. **A declined task can never
become a completed one** — it takes a fresh assignment, which the partial unique
index permits because it only covers live rows.

Who may move what: the creator owns `accepted`, `in_progress`, `completed` and
`declined` on their own row; a manager may only `cancel`. A suspended creator
cannot move anything, even work already assigned to them.

### Ownership is not a field

The two creator-side writes — registering interest, and moving a task — take
**no creator id at all**. The row is written from the session. That is stronger
than validating an id, because there is nothing to forge. `assigned_by` and
`team_id` are resolved server-side too; sending them changes nothing.

### Integrity in the database, not the form

- one **live** interest per creator per opportunity (partial unique index, so a
  withdrawal frees them to re-apply and the withdrawn row is kept)
- one **live** assignment per creator per opportunity (declined and cancelled
  rows stay as history and do not block reassignment)
- assignment only to an **active** network member

### Dates

`event_date` and `task_deadline` are separate fields and separate concepts — the
festival is on the 20th, the reels are due on the 22nd. Every DATE is returned
through `dOnly()`, and a test asserts both survive the round trip unshifted.

### API

| Endpoint | Does |
|---|---|
| `GET/POST /creator/events` · `GET/PATCH /creator/events/:id` | events, with requirements creatable inline |
| `GET/POST /creator/opportunities` · `PATCH /creator/opportunities/:id` | requirements |
| `POST/DELETE /creator/opportunities/:id/interest` | register / withdraw — **no id in the payload** |
| `GET /creator/interests` | scoped; `opportunity_id`, `status` |
| `POST /creator/interests/:id/reject` | records `not_selected`, never deletes |
| `POST /creator/assignments` | **selection** — marks the interest and creates the task |
| `GET /creator/tasks` · `PATCH /creator/assignments/:id` | the work, and its transitions |

Opportunities are a **noticeboard**: every active creator may read what is open.
Interests and tasks are private and scoped.

### Audit and notifications

`mo_audit_logs` and `mo_notifications`, both existing. Events, opportunities,
interests, assignments and every task transition are logged with actor, action,
entity and timestamp.

**A bug this phase found and fixed:** `mo_audit_actor_role_chk` allowed only
`admin | team_lead | employee | system`, and `audit()` wrote the raw platform
role for anyone outside those tiers. A creator's `'user'` violated the CHECK,
`audit()` swallows its own errors — so **every creator-initiated action was
going unlogged**. The vocabulary now includes `'creator'`, and an unrecognised
role writes `NULL` so the insert can never silently fail again.

---

## PHASE 2 COMPLETE

**Implementation notes**

- No change to Phase 0 or Phase 1 behaviour; the only edit outside new code was
  the audit vocabulary fix above.
- The bootstrap's constraint widening is a single `DO $$` statement with a
  duplicate-object guard, so parallel boots cannot race between drop and add.
- A Team Lead reads their team's interests and tasks but cannot assign in this
  phase — §5 gives selection to Creator Admin. Widening it is a one-line change.

**Phase 3 starts here:** content submission against a **completed** task —
`mo_creator_assignments.id` is the anchor — then review and approval. Nothing in
Phase 2 needs to change first.

---

## PHASE 3 — content submission and review

### Completion is not approval

A creator marking a task **complete** says the work is done and ready to look
at. The **verdict** is management's separate act and lives on the submission.
The assignment never moves because of a review — a test asserts it stays
`completed` through the whole cycle.

### Built on the convention that already existed

`mo_deliverable_versions` is already how Nerve does a versioned submission
carrying a review verdict. `mo_creator_submissions` uses the same shape and the
same words — `version_no`, `submitted_by`, `reviewed_by`, `review_comment`,
`UNIQUE(assignment_id, version_no)` — so the codebase has one convention, not
two. The review endpoint mirrors `POST /deliverables/:id/review`: one route, an
`outcome` in the body, and **BR-5** (a submission cannot be reviewed by the
person who submitted it).

### Schema

`mo_creator_submissions` — anchored on `assignment_id`, which Phase 2 made the
single ownership anchor. Nothing else is needed: creator, team, opportunity and
event are all reachable through it, so none of them is a field a client could
forge.

| Constraint | Stops |
|---|---|
| `UNIQUE (assignment_id, version_no)` | two versions claiming the same number |
| partial unique on `status='submitted'` | stacking V2 on an unreviewed V1; a retried request opening a second review |
| partial unique on `status='approved'` | a task with two approved versions |
| `CHECK (version_no > 0)` | nonsense numbering |

Indexed on `(status, submitted_at)` and `(reviewed_by, reviewed_at)`.

### Four states, not six

`submitted → changes_requested → (resubmit as a new row) → approved | rejected`

`submitted` **is** under review — a separate `UNDER_REVIEW` would be a status
nothing ever sets, and there is no draft step in this workflow. Both terminal
states are kept because "fix it" and "we are not taking this" are different
answers to a creator.

Nothing leaves `approved` or `rejected`. A verdict is only accepted on a
version whose status is still `submitted`, enforced in the `WHERE` clause — so
two reviewers acting at once produce one verdict and one 409, and an approved
version cannot be re-decided.

### Versioning, and the race

V1 is immutable. Changes requested means the creator submits a **new row** as
V2; V1 keeps its content, its comment and its reviewer forever.

`MAX(version_no)+1` alone is not safe — two requests read the same maximum.
`UNIQUE(assignment_id, version_no)` is what actually decides it, and the loser
**recomputes and retries** (bounded) rather than erroring. Four concurrent
submissions produce exactly one new version and three 409s, asserted by test.

### Ownership

A submission carries **no creator id, team id, event id or opportunity id**.
The server resolves the assignment from the session and refuses anything that
is not the caller's — a foreign assignment answers **404**, indistinguishable
from one that does not exist.

### Content links, not files

Nerve stores a URL and mirrors nothing; no Drive credentials are held. `https`
only — that is what rules out `javascript:`, `data:` and `file:`. No host
allow-list, because creators legitimately post to Drive, YouTube and Instagram.

### Who may do what

| | Creator | Team Lead | Creator Admin / Nerve Admin |
|---|---|---|---|
| Submit | own completed tasks | — | — |
| See submissions | own | their team's | all |
| Verdict | — | **no** | yes |

Review authority stays where Phase 2 left selection. A Team Lead reads their
team's work and does not rule on it.

### API

| Endpoint | Does |
|---|---|
| `POST /creator/assignments/:id/submissions` | submit the next version |
| `GET /creator/assignments/:id/submissions` | full version history, scoped |
| `GET /creator/submissions` | review queue — `status`, `creator_id`, `team_id`, `event_id`, `opportunity_id`, `since`, paged |
| `POST /creator/submissions/:id/review` | `outcome: approved \| changes_requested \| rejected` |

`changes_requested` and `rejected` require a comment; `approved` does not.

### Audit and notifications

`creator_submission.submitted`, `.changes_requested`, `.approved`,
`.rejected` on `mo_audit_logs`. Notifications on `mo_notifications`: the
assigner is told there is something to review, the creator is told the verdict
and reads the comment.

**The Phase 2 audit regression is directly guarded here.** Submitting is a
creator action, so a test asserts the row exists *and* that `actor_role` is
`'creator'` — the exact failure that silently emptied the creator trail before.

### Phase 4 anchor

Points attach to an **approved submission**: `mo_creator_submissions` where
`status='approved'`, one per assignment by construction, carrying
`reviewed_by`, `reviewed_at` and a path to creator, team, opportunity and
event. Nothing in Phase 3 needs to change for a point ledger to reference it.

---

## PHASE 3 COMPLETE

**Implementation notes**

- No Phase 0/1/2 behaviour changed; `/creator/tasks` gained the latest
  submission via a lateral join so the task list stays one query.
- Submission requires the task to be `completed`, which is the documented
  meaning of completion in §2.
- A rejected submission closes the task to further versions. If reopening is
  ever wanted it should be an explicit management action, not a silent path.

---

## PHASE 4 — points, the ledger, cycles and rank

### THE POINT LEDGER IS THE SOURCE OF TRUTH

There is no `total_points` column. Not on `mo_creator_profiles`, not anywhere —
a test asserts that no table in the network has a column matching `%point%`,
`%rank%` or `%score%`, so one cannot quietly appear later.

A creator's balance is `SUM(points)` over `mo_creator_point_ledger`. A rank is
computed from those sums when the board is asked for. Both are **derived every
time**, which is the whole reason they cannot drift: there is no second number
to disagree with the transactions.

Points are financial-ledger-like data, so the ledger behaves like one:

| Property | How it is held |
|---|---|
| Append-only | no endpoint updates or deletes a row — asserted against the source, not just by convention |
| Explainable | every row carries a `reason`, and for an award the rule name and the task |
| Idempotent | a unique index, not an if-not-exists |
| Immutable amounts | the value is **copied onto the row** at award time |
| Correctable | a reversal is a new, opposite row; the original stays |

The single exception to append-only is `claim-pending`, which sets `cycle_id`
on rows that have none. It changes no amount and no owner, and it is audited.

### Schema

```
mo_creator_point_rules   name (unique, case-insensitive), points, source_type, is_active
mo_creator_cycles        label (unique), starts_on, ends_on, status, CHECK (ends_on >= starts_on)
mo_creator_point_ledger  user_id, cycle_id (NULL = waiting), rule_id, points,
                         source_type, source_id, reason, reversal_of_id, created_by
mo_creator_opportunities + point_rule_id   — which rule this role earns
```

| Index | Holds |
|---|---|
| `idx_mo_cr_cycle_one_active` — unique on `(status)` where `status='active'` | **at most one active cycle**, in the database rather than in a check the next writer can skip |
| `idx_mo_cr_ledger_source` — unique on `(source_type, source_id, rule_id)` where `source_type='approved_submission'` | **one approved submission earns once**, however many requests arrive |
| `idx_mo_cr_ledger_reversal` — unique on `reversal_of_id` | a transaction is reversed once and never twice |

Foreign keys to cycles, rules and reversed rows are `ON DELETE RESTRICT`:
history cannot be half-deleted. A rule that has awarded points is **retired**,
never deleted, because the rows pointing at it must keep resolving.

### Approval is what earns

There is no "award points" endpoint. Points are written inside
`POST /creator/submissions/:id/review` when the outcome is `approved`, from the
record that was just approved:

- **who** comes from the assignment, never the request
- **how much** comes from the rule, never the request
- **which cycle** is whichever is active now, never a date the browser sent

A forged `user_id`, `points` or `cycle_id` on the review body changes nothing —
asserted by test.

### Which rule an approved submission earns

The opportunity names it (`point_rule_id`), set by a Creator Admin against a
rule that exists and is still active. Failing that, if the network has exactly
**one** active rule, that is unambiguous and is used. With several and no
choice recorded, **nothing is awarded** and the response says
`rule_ambiguous` — a silent wrong number is worse than a visible zero.

### No active cycle: the points wait

Approval is never blocked by accounting. With no active cycle the transaction
is written with `cycle_id = NULL` — recorded, not lost, not guessed into a
month, and not allowed to invent a cycle. An Admin later places the waiting
rows into a cycle explicitly through `POST /creator/cycles/:id/claim-pending`,
which is audited.

### Cycles

`draft → active → closed → (reopen | archived)`; a draft may also be archived.
Only a **draft** is editable: once a cycle has been active it may own
transactions, and moving its boundaries would silently restate history. A
closed cycle is never restated — a manual adjustment naming one is refused, and
corrections belong in an open cycle.

### Rank

One grouped aggregate for the whole board — not a `SUM` per creator — with
`RANK() OVER (ORDER BY total DESC)`. That is **competition ranking**: equal
totals share a place and the next one skips, so 50/40/40/20 ranks 1, 2, 2, 4.
Display ties break by name then user id, so the order is deterministic rather
than whatever the planner returns.

A creator with no transactions is simply absent from the board. A zero balance
is a place on it. An **archived creator keeps their points and their place** —
history does not change because someone left.

### Who may do what

| | Creator | Team Lead | Creator Admin / Nerve Admin |
|---|---|---|---|
| See own points and ledger | yes | yes | yes |
| See the ledger | own | their team's | all |
| Leaderboard | yes | their team's | whole network |
| Create rules or cycles | — | — | yes |
| Manual adjustment / reversal | — | **no** | yes |

A Team Lead reads their team's standing and changes none of it — the same line
Phase 3 drew for verdicts.

### API

| Endpoint | Does |
|---|---|
| `GET /creator/rules` · `POST` · `PATCH /:id` | what things are worth; `PATCH` retires with `is_active` |
| `GET /creator/cycles` · `POST` · `PATCH /:id` | periods, and their lifecycle; the response carries what is waiting |
| `POST /creator/cycles/:id/claim-pending` | place waiting transactions into a cycle |
| `GET /creator/points` | the caller's own balance, lifetime, rank and recent rows |
| `GET /creator/points/ledger` | transactions — scoped, filtered by cycle, source or pending, paged |
| `GET /creator/leaderboard` | the board for a cycle (`cycle_id`, or the active one) |
| `POST /creator/points/adjust` | a manual transaction: whole non-zero amount, reason required |
| `POST /creator/points/:id/reverse` | the opposite transaction; reason required, once only |

`GET /api/v1/media/state` is untouched: none of this is on it.

### Audit and notifications

`creator_point_rule.created|updated|activated|deactivated`,
`creator_cycle.created|active|closed|archived|updated`,
`creator_points.awarded|adjusted|reversed|cycle_assigned`. Every award records
the creator, the amount, the rule, how the rule was chosen, the submission and
the cycle. A creator is notified when they earn, when an adjustment is made,
and when one is reversed.

No password, token, key or secret is written to either — asserted by test
against the actual rows.

### Phase 5 anchor

A payout reads the ledger. It never writes to it, and it never becomes the
place a balance is stored: `SUM(points)` for a creator in a closed cycle is the
figure a payout is computed from, and it stays reproducible because nothing
restates a closed cycle.

---

## PHASE 4 COMPLETE

**Implementation notes**

- Nothing in Phases 0–3 changed in behaviour. The review endpoint gained one
  line — the award — and its response gained a `points` object saying what
  happened, including when nothing was awarded and why.
- `mo_creator_opportunities.point_rule_id` is additive and nullable: existing
  opportunities keep working and earn nothing until a rule is named.
- `mo_projects`, `mo_assignments` and `mo_deliverable_versions` are untouched
  by Phase 4 — asserted by a test that reads the source of the phase itself.
- 51 integration tests: the required end-to-end scenario, ten simultaneous
  approvals producing one transaction, ten simultaneous awards at the database
  producing one row, rule changes not rewriting history, the rank engine
  including ties and archived creators, and the security matrix.

---

## PHASE 5 — payouts, the financial ledger and payment

### TWO LEDGERS, TWO JOBS

> **THE POINT LEDGER IS THE SOURCE OF TRUTH FOR PERFORMANCE.**
> Points, ranking, cycles. Phase 4 owns it.
>
> **THE FINANCIAL LEDGER IS THE SOURCE OF TRUTH FOR MONEY.**
> Amounts owed, corrected and paid. Phase 5 owns it.

A payout **reads** points. A payout **never writes** points. A ₹200 bonus is a
financial entry, never twenty points; a point correction is a point
transaction, never a payment. Every test that moves money takes an `md5`
fingerprint of the point ledger before and after and asserts it is identical.

The two are joined at exactly one place: a payout's `points_basis`, copied from
`SUM(points)` for that creator in that cycle at the moment of calculation, and
never read again.

### Money is NUMERIC, never a float

Nerve's established monetary type is `NUMERIC(12,2)` (`mo_requests.budget`,
`mo_equipment_items.purchase_cost`, `mo_vendor_activities.amount`), and Phase 5
follows it. `node-postgres` returns `NUMERIC` as a **string**, so an amount is
never a JavaScript number on either leg:

- arriving, an amount is validated as text against `/^-?\d{1,9}(\.\d{1,2})?$/`
  and handed to Postgres as text. A client that computed `0.1 + 0.2` and sent
  `0.30000000000000004` is **refused**, not silently rounded.
- in the database, every calculation is SQL on `NUMERIC`.
- leaving, amounts are serialised as strings and the browser formats them
  without arithmetic.

A rate is `NUMERIC(12,4)` — a rate is not an amount, and ₹7.50 and ₹0.0125 per
point are both legitimate. The precedent for a finer NUMERIC is
`mo_ai_requests.estimated_cost`.

**Rounding, stated explicitly** (no prior Nerve finance code defined one):
`ROUND(points × rate, 2)` in Postgres — half away from zero, to two decimal
places, once, at calculation time. 3 × ₹0.3333 = ₹1.00; 7 × ₹1.005 = ₹7.04.

**Currency** is a column, defaulting to `'INR'`, carried from the rate onto the
payout and onto every entry. Nothing mixes currencies; the university operates
in one.

### The payout model

Confirmed before implementation, because no PRD in the repository defines it:
**points × rate, plus manual financial adjustments.**

```
approved content → points → closed cycle → rate → payout → financial ledger → payment
```

| Question | Answered by |
|---|---|
| How much? | `gross_amount`, and the ledger for net |
| Why? | `points_basis`, traceable to the point transactions behind it |
| For which cycle? | `cycle_id` |
| At what rate? | `rate`, snapshotted |
| Approved? | `approved_by`, `approved_at` |
| Paid? | `paid_at`, `payment_reference`, and a `payment` entry |

### Rates and effective windows

A rate has `effective_from` / `effective_to`. A payout is priced by the rate
covering its **cycle's end date** — the accounting boundary the cycle closed
on, not today. Two active rates covering the same day are refused when created,
so a payout can never be ambiguous; a cycle with no covering rate is refused at
calculation rather than guessed.

Changing a rate means **ending the current one and starting the next**. The
figure on a rate that has already priced a payout cannot be edited at all —
those payouts carry their own copy, but the row has to keep telling the truth
about what it was. September stays at ₹10 when October becomes ₹12, asserted by
test.

### The snapshot

At calculation time the payout copies `points_basis`, `payout_rule_id`, `rate`,
`currency` and `gross_amount`. Nothing is recomputed for display, ever. When the
cycle's current total later differs from the basis, the statement **says so**
rather than quietly showing a number that no longer matches what was paid.

There is deliberately **no `net_amount` column**. Net is `gross + SUM(ledger)`,
derived on read — the same reason Phase 4 has no stored point total.

### Generation: closed cycles only, and once

Only a `closed` cycle. An active cycle's totals are still moving, and a payout
calculated from a moving total is a number nobody can defend.

One statement, in one SQL round trip for the whole network:

```sql
INSERT INTO mo_creator_payouts (…)
SELECT t.user_id, …, ROUND(t.total::numeric * $rate, 2), …
  FROM (SELECT user_id, SUM(points)::int AS total
          FROM mo_creator_point_ledger WHERE cycle_id=$1 GROUP BY user_id) t
 WHERE t.total > 0
ON CONFLICT DO NOTHING
```

No N+1. A creator on zero or negative points gets no payout.

**Idempotency is the index**, not a read-then-write:
`UNIQUE (user_id, cycle_id) WHERE status NOT IN ('rejected','voided')`. Ten
simultaneous requests produce one payout; the losers are no-ops, not errors.
Rejected and voided statements are excluded so a cycle can be recalculated
after a mistake.

### Lifecycle

```
calculated ──> approved ──> paid
     │             │
     └> rejected   └> voided
```

**APPROVED IS NOT PAID.** Approving recognises a liability and writes the money
into the financial ledger. Paying records that cash actually moved and carries
the reference that proves it. A manager who approved a payout has not paid
anybody, and no screen says they have.

Every transition is guarded in the `WHERE` clause, so two managers acting at
once produce one transition and one 409. Each transition that moves money runs
in a transaction with its ledger write — a payout reading PAID with no
financial entry behind it would be a lie the database told.

A payout is never approved by the creator it belongs to. A **paid** payout is
never voided and never edited; it is corrected with an adjustment.

### The financial ledger

Entries are amounts **owed**, which is what makes the arithmetic mean something:

| Entry | Sign | When |
|---|---|---|
| `payout` | + gross | on approval — the liability |
| `adjustment` | ± | a bonus or a correction, any time before or after payment |
| `reversal` | ∓ | cancels exactly one entry |
| `payment` | − outstanding | on payment — the cash |

`SUM(amount)` over a payout is therefore **what is still outstanding**, and zero
means settled. "Approved but unpaid" is a number, not an opinion, and the
dashboard's outstanding figure comes from the ledger rather than from statuses.

**Immutable.** No endpoint updates or deletes an entry — asserted against the
source of `mediaops-api.ts`, not only by convention. Indexes hold the rest: one
`payout` entry per payout, one `payment` entry per payout, one reversal per
entry. Every foreign key is `ON DELETE RESTRICT`: financial history cannot be
half-deleted, and an archived or suspended creator keeps every payout and entry.

### Corrections

| Situation | What happens |
|---|---|
| Wrong before approval | reject; nothing financial was recorded |
| Wrong after approval, before payment | **void** — every open entry is reversed in one statement, balance returns to zero, originals stay |
| Wrong after payment | **adjustment** — ₹2,040 paid, −₹140 recorded; the payment stays at ₹2,040, net becomes ₹1,900, and the balance reads −₹140 |
| A mistaken adjustment | **reverse** it — an equal and opposite entry, once only |

A `payment` entry is never reversed (correct it with an adjustment) and the
`payout` entry is never reversed on its own (that is what void is for). A
residual balance after a post-payment correction stays visible as outstanding
for finance to settle.

### Reopening a closed cycle

Phase 4 allows `closed → active`. Phase 5 **blocks it once the cycle has a live
payout**: reopening would let points move underneath a calculation that has
already been approved or paid. The close is an accounting boundary, not just a
status. Corrections after that point are financial, which leaves both the
points and the payout saying what they always said.

### Permissions

| | Creator | Team Lead | Creator Admin / Nerve Admin |
|---|---|---|---|
| Own payouts and statements | yes | yes | yes |
| Other people's payouts | — | **no** | all |
| Financial ledger | own | **no** | all |
| Rates, calculate, approve, reject, pay, void, adjust, reverse | — | **no** | yes |

**A Team Lead has no financial authority and no financial visibility.** Leading
a team is not a financial role, and nothing about it makes one — the lead keeps
their Phase 4 view of their team's points and sees only their own money. This is
the narrowest defensible line and is reversible later.

A payment reference is required, bounded to 4–120 characters, and rejected if it
looks like a credential. Nerve stores a UTR, a voucher or a bank reference and
**never** a password, PIN, API key or secret.

### API

| Endpoint | Does |
|---|---|
| `GET/POST/PATCH /creator/payout-rules` | rates and their windows |
| `POST /creator/cycles/:id/payouts` | calculate a closed cycle, idempotently |
| `GET /creator/payouts` | scoped, filtered by cycle, creator, status, team; paged |
| `GET /creator/payouts/:id` | the statement: snapshot, financial entries, and the point transactions behind the basis |
| `GET /creator/payouts/summary/:cycleId` | the admin dashboard, in two queries |
| `POST /creator/payouts/:id/approve` · `/reject` · `/pay` · `/void` · `/adjust` | the lifecycle |
| `GET /creator/finance/ledger` | the financial ledger, scoped and paged |
| `POST /creator/finance/:id/reverse` | reverse one adjustment |

`GET /api/v1/media/state` carries none of this.

### Audit and notifications

`creator_payout_rule.created|updated|activated|deactivated`,
`creator_payout.calculated|approved|rejected|paid|voided|adjusted`,
`creator_financial_entry.reversed`. Calculation writes **one audit row per
payout**, batched in a single statement — money is traced per record, not per
run. A creator is notified when their payout is calculated, approved, adjusted
and paid.

No password, token, key or secret reaches either — asserted by test against the
actual rows.

### Phase 6 anchor

Leaderboards, achievements, Creator of the Cycle and War Zone all consume
`mo_creator_point_ledger` and the rank engine, which Phase 5 does not touch.
Nothing in Phase 6 needs to read or write a payout: a competition is decided on
points, and money follows the cycle it was earned in.

---

## PHASE 5 COMPLETE

**Implementation notes**

- No Phase 0–4 behaviour changed, with one deliberate addition: reopening a
  closed cycle that has payouts is now refused (§29 requires exactly this).
- `mo_creator_opportunities.point_rule_id` gained an API in Phase 4; nothing
  else in the earlier phases was touched.
- One real bug was caught by these tests and fixed: the settled amount was
  being negated with `Number()` before going into the audit row, turning
  `-2040.00` into `2040`. Postgres negates it now — a reminder of why the rule
  is *no JavaScript arithmetic on money*, not *be careful with it*.
- 64 integration tests: the required end-to-end, the bonus and correction
  scenarios, four concurrency cases, financial precision, the security matrix,
  and regression fingerprints over the point ledger.

---

## PHASE 6 — leaderboard, achievements, Creator of the Cycle, War Zone

### PHASE 6 DOES NOT OWN PERFORMANCE ACCOUNTING

> The **point ledger** stays the source of truth for points.
> The **rank engine** stays the source of truth for rank.
> The **financial ledger** stays the source of truth for money.
>
> Phase 6 **consumes** all three and writes to none of them.

A test fingerprints the point ledger, the financial ledger and the payouts
before and after every recognition operation — awarding, finalising a cycle,
creating and completing a competition — and asserts all three are byte-identical.
A second test reads the Phase 6 source and fails on any `INSERT`, `UPDATE` or
`DELETE` against them. No counter was added to `mo_creator_profiles`,
`mo_creator_teams` or `users`: "12 achievements" is twelve rows.

Four ideas are kept apart because they are not the same thing: a rank is not an
achievement, Creator of the Cycle is not rank #1 renamed, and a War Zone score
is not a Creator point.

### Leaderboard

Built **on** the Phase 4 rank engine, not beside it — one endpoint, so two
leaderboards can never disagree. `GET /creator/leaderboard` keeps every Phase 4
field and default and gains `team_id`, `q`, `offset`, a per-row `approved`
count, a `total`, and a `me` block.

Ranking is computed over the **whole board first**, then the page is taken, so
paging and searching never change the rank anybody holds: #17 is #17 on page
one, on page two and in a search for their own name. Competition ranking is
unchanged — 50/40/40/20 is 1, 2, 2, 4.

**Visibility is Phase 4's and was not touched:** a Team Lead sees their own
team; everyone else — creators included — sees the network. Narrowing by
`team_id` is a filter that can only ever narrow; a Team Lead asking for another
team still gets their own. §7 is honoured literally: a creator at #17 is told
#17 and is highlighted in place, never promoted.

### Achievements

A **definition** and an **award** are separate tables.

Criteria are **structured data** — a type from a closed set plus a number —
never an expression and never a string that becomes code or SQL:

| `criteria_type` | Evaluated from |
|---|---|
| `point_threshold` | `SUM(points)` in the point ledger |
| `approved_content_count` | approved submissions |
| `cycle_rank` | the cycle's ranking |
| `creator_of_cycle` | a Creator of the Cycle award |
| `competition_result` | a finalised competition place |
| `manual` | an Admin, by hand |

Adding a criterion means adding a branch to the evaluator. An admin configures
what is already possible and cannot invent execution.

**Scope is explicit**: `lifetime`, `cycle` or `competition`, never mixed.

**Evaluation is targeted** (§14/§46), never a sweep: an approval evaluates one
creator, a cycle close evaluates one cycle, a completion evaluates one
competition. Each is a single `INSERT … SELECT` that lands on the uniqueness
index, so a thousand-creator network is one statement and ten simultaneous
evaluations award once.

**Idempotency** is one index covering all three scopes:
`UNIQUE (user_id, achievement_id, COALESCE(cycle_id,0), COALESCE(source_id,0)) WHERE revoked_at IS NULL`.
Postgres treats NULLs as distinct, so the `COALESCE` is what stops a lifetime
badge being awarded twice. The partial clause lets a revoked award stay in
history without blocking the badge being earned properly later.

**Seeded starters** (all editable and retirable by a Creator Admin, written
only when absent): `first_content`, `ten_contents`, `hundred_points`,
`top_three_cycle`, `creator_of_cycle`, `war_zone_winner`. The thresholds are
starting points, not business policy.

**Recognition is history.** An award survives a team move, a suspension and an
archive — all asserted. A mistake is **revoked** with a reason and an actor and
stays visible; there is no endpoint that deletes one. The criterion of an
achievement people already hold cannot be changed: those awards were earned
against what it said.

### Creator of the Cycle

A recognition record in its own right, in its own table — not rank #1 with a
different label. Today's rule is the top of the **closed** cycle by the Phase 4
rank engine, and the row keeps `rank_at_award`, `points_at_award` and the
criteria in words, so a later point correction cannot rewrite why somebody was
recognised.

**A tie means two winners, and the system says so.** `UNIQUE (cycle_id, user_id)`
— one award per creator per cycle, not one per cycle — so everybody at rank 1 is
recognised and the response returns `shared: true` with every winner named.
Nothing picks between them by a rule nobody wrote down.

Finalisation is one statement with `ON CONFLICT DO NOTHING`: ten simultaneous
requests produce one award.

### War Zone

A competition is not the leaderboard, not the point ledger and not the payout
system. `draft → open → active → completed`, with `cancelled` reachable from
the first three. There is deliberately **no reopen**: results that can be
reopened are not results.

**Scoring is separate, by design.** Entries in `mo_creator_competition_scores`
sum to a participant's score, the same shape as the point ledger and for the
same reason — no stored total, and a correction is a compensating entry.
Writing any of it into `mo_creator_point_ledger` would make a judged contest
alter a permanent performance record and, through Phase 5, somebody's pay.

**Participation**: a creator enters themselves and nobody else — a forged
`user_id` is refused. Registration closes when the competition does. Eligibility
is the network's: an active profile, plus team membership for a team
competition. A competition out of scope answers **404**, exactly as one that
does not exist, so its existence is never confirmed.

**Results** snapshot the place and score at finalisation. Ties share a place,
the same competition ranking the rank engine uses: two on 92 are both 1st and
both `winner`, and the next is 3rd. Finalisation runs in a transaction guarded
by the status, so ten simultaneous requests produce one result set.

**Prizes are words.** A competition stores a `recognition` description. Money
belongs to Phase 5's financial architecture and is never created by winning.

### Permissions

| | Creator | Team Lead | Creator Admin / Nerve Admin |
|---|---|---|---|
| Leaderboard | network (Phase 4) | own team (Phase 4) | network |
| Own achievements, recognition, results | yes | yes | yes |
| Others' achievement awards | — | own team | all |
| Enter a competition | themselves only | themselves only | may enter others |
| Define or award achievements, revoke | — | **no** | yes |
| Create, open, score, finalise, cancel a competition | — | **no** | yes |
| Finalise Creator of the Cycle | — | **no** | yes |

A Team Lead has no recognition authority, exactly as they have no financial
authority in Phase 5.

### Audit and notifications

`creator_achievement.created|updated|activated|deactivated|awarded|revoked`,
`creator_cycle_award.created`,
`creator_competition.created|updated|opened|started|completed|cancelled|
result_finalized|participant_added|participant_withdrawn|participant_disqualified|
score_recorded`.

Notifications: an achievement earned, Creator of the Cycle, a competition
opened (to the eligible network or team), started, cancelled, and results.
**A leaderboard read notifies nobody** — asserted by test.

### Phase 7 anchor

Analytics and Creator Growth Intelligence consume what already exists: the
point ledger for performance, the rank engine for standing, the recognition
tables for outcomes, the financial ledger for cost. Phase 7 needs no new source
of truth and should create none — it reads, aggregates and presents. The rule
Phase 6 followed is the one Phase 7 inherits: **derive, never store a second
copy of a number another system owns.**

---

## PHASE 6 COMPLETE

**Implementation notes**

- Phases 0–5 are unchanged in behaviour. Two additive touches: the review
  endpoint now also evaluates that one creator's lifetime achievements and
  returns an `achievements` count, and the leaderboard gained optional filters
  plus a `me` block while keeping every existing field and default.
- Every creator test fixture now clears its own recognition rows before its
  people: an achievement award is `RESTRICT`-protected on purpose, which is
  the schema saying that recognition outlives the creator record's edits.
- Two real bugs the tests caught: a count query that bound a parameter its SQL
  never referenced (so a Creator Admin's competition list failed outright), and
  an existence leak where entering a team competition you could not see replied
  "that is for another team" instead of 404.
- 51 integration tests: the required end-to-end, both tie policies, targeted
  evaluation and idempotency, the revoke model, four concurrency cases, the
  security matrix, and the triple-ledger fingerprint.
