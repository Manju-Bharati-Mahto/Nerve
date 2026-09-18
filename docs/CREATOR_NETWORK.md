# Nerve Creator Network — Architecture

> Living document. Reference for every Creator Network phase.
> Status: **Phase 3 complete** — content submission and review are live.
> Phase 4 (points, ranks, cycles) has not started.

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
| 4 | Points, point ledger, rank engine, cycles |
| 5 | Payouts, financial ledger, audit |
| 6 | Leaderboard, achievements, Creator of the Cycle, War Zone |
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
