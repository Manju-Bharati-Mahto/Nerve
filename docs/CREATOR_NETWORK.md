# Nerve Creator Network — Architecture

> Living document. Reference for every Creator Network phase.
> Status: **Phase 0 complete** — foundation only. No creator UI is built yet.

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

| Endpoint | Returns |
|---|---|
| `GET /api/v1/media/creator/context` | the caller's role, scope and whether they may manage |
| `GET /api/v1/media/creator/me` | the caller's own profile — takes no id |
| `GET /api/v1/media/creator/status` | network size, narrowed to scope |

All three sit under the existing `/api/v1/media` prefix, behind the existing
session auth and rate limiting.

## 9. Navigation

One `NAV` entry at `#/media/creator` in its own group. The module key is
derived from the route (`modKeyOf`), so it matches the server's
`CREATOR_MODULE` with nothing to keep in sync. Marked `optIn`, so no role
silently acquires it. A user without the module never sees the group.

## 10. Known gap — the Phase 1 starting point

**`GET /api/v1/media/state` gates on `requireMedia()`, so a `team='creator'`
user cannot hydrate the Media Ops client.** The API works for them; the
existing SPA shell does not load.

Phase 0 deliberately did not touch `/state` — widening a broad endpoint to
carry creator data is exactly the wrong move. Phase 1 must choose:

- **A.** A scoped `GET /creator/state` serving only what a creator's own
  surface needs. *(Recommended — matches the TV board precedent.)*
- **B.** Admit creators to `/state` with heavy server-side filtering.
- **C.** A separate lightweight creator surface, as `/api/media-tv/` is.

Until then, the Creator Network section is reachable by Media Ops staff holding
the module. Creators reach the API directly.

## 11. Roadmap

| Phase | Scope |
|---|---|
| **0 ✅** | Architecture, identity, roles, teams, RBAC, scope, nav, API foundation |
| 1 | Creator directory, creator teams, hierarchy |
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
