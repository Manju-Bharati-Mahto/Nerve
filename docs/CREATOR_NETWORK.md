# Nerve Creator Network — Architecture

> Living document. Reference for every Creator Network phase.
> Status: **Phase 1 complete** — directory, teams and hierarchy are live.
> Phase 2 (events and tasks) has not started.

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
| 2 | Events, tasks, interest, assignment |
| 3 | Content submission + review workflow |
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
