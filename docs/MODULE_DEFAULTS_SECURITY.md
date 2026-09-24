# Module Defaults & Fail-Closed Authorization

Found during fresh-database validation of the test-isolation work: a brand-new
Nerve installation failed **open** for module authorization. This note records the
audit, the fix, and what remains.

---

## A. Previous behaviour

`effectiveModules(u)` resolved a user's module list in three steps:

```
explicit per-user override (mo_user_profiles.allowed_modules is an array)  → that list
otherwise, the group's row in mo_module_defaults                           → that list
otherwise                                                                  → null
```

and every gate read `null` as **unrestricted**:

| Gate | Old test |
|---|---|
| `requireModule()` | `eff === null \|\| eff.includes(key)` → allow |
| `allowsModule()` | `eff === null \|\| eff.includes(key)` → allow |
| `canUseCreatorAi()` | `eff === null \|\| eff.includes('creator')` → allow |
| `tvBoardAllowed()` | `isAdmin \|\| effective === null \|\| includes('tv')` → allow |
| `hasModuleGrant()` | `eff !== null && eff.includes(key)` → already closed |
| `requireCreatorNetwork()` | `eff !== null && eff.includes(...)` → already closed |

This was a deliberate migration stance, stated in the code: *"a group nobody has
configured behaves exactly as it did before this table existed, so adding group
defaults cannot silently revoke access from anyone."* Reasonable as a migration.
Dangerous as a steady state.

`moduleGroupOf()` can return six groups — `admin`, `team_lead`, `coordinator`,
`employee`, `smc_member`, `creator` — and **the bootstrap seeded exactly one of
them** (`creator`, added when the Creator Network shipped, for precisely this
reason).

---

## B. The security issue

On a fresh installation five of the six groups had no row. So:

```
new employee → moduleGroupOf → 'employee' → no row → null → "unrestricted"
             → requireModule('admin/settings')  ALLOWED
             → requireModule('admin/users')     ALLOWED
             → requireModule('tv')              ALLOWED
             → requireModule('creator')         ALLOWED
```

An ordinary employee passed **every** module gate in the product, Settings and
Users & Roles included. The configuration whose absence granted everything was
configuration an administrator had to know to go and create — by opening a
Settings page and saving it once.

It never showed in development because that database had all six rows, written by
an administrator months earlier. It surfaced the first time a database was built
from scratch, in `mediaops-creator-network.integration.test.ts`, where an SMC
member resolved to `null` instead of a module list.

**Severity: high.** Not remotely exploitable by an anonymous user — `requireMedia()`
still gates every route on media-crew membership — but any authenticated crew
member on a fresh install held administrative module access.

---

## C. Fresh-install defaults

`bootstrapMediaOpsDatabase()` now seeds a row for every group
(`MODULE_DEFAULT_SEED` in [mediaops-db.ts](../server/mediaops-db.ts)).

### Where the values come from

**Not from judgement, and not from the development database.** They are the exact
sets the application *already derives* for an unconfigured group, in
`public/media-ops/index.html`:

```js
function defaultModulesFor(r){
  const d=(DB.module_defaults||{})[r];
  if(Array.isArray(d)) return d.slice();
  return MODULES.filter(m=>moduleRoleOk(m,r)&&!m.optIn).map(m=>m.key);
}
```

— every module the role can reach, minus the opt-in ones. Writing that down
changes no behaviour; it makes explicit what was implicit, which is what makes
denial-on-missing safe.

The development database was deliberately **not** copied: its rows are that
organisation's own narrowing (their `team_lead` list is 14 keys against the
derived 20), and one org's policy is not a product default.

### One correction to the derivation, and why it matters

`defaultModulesFor()` calls `navShow(m, r)` with an *explicit* role, which answers
*"could this role ever hold this module?"* — the question the Module Access dialog
asks. For the signed-in user the same function asks `can(cap)`, which resolves the
duty-conditional verdicts (`'SMC'`, `'CASTING'`, `'CUSTODIAN'`) through `hasDuty()`.

Two modules are gated on such a verdict and **confer authority when granted**:

| Module | Effect of holding it |
|---|---|
| `smc` | `isSmcManager()` returns true — *"an explicit Module Access grant is sufficient on its own"* |
| `casting-admin` | `canManageCasting()` returns true, same rule |

Seeding those into a role's baseline would have made **every media employee an SMC
manager**. The first version of this table did exactly that, and
`ai-user-context.integration.test.ts` caught it:

```
✗ smc.read comes from the smc_manager DUTY, not from being an SMC member
  expected [ 'equipment.read', …(6) ] to not include 'smc.read'
```

A duty is granted per *person*; it is never what a role implies. So a module gated
on one belongs in nobody's default. Both stay for `admin`, whose verdict on each is
`'A'` — an authority that role does carry.

That rule also, independently, reproduces the distinction the development
organisation drew by hand: their `employee`, `team_lead` and `coordinator` rows
carry `casting` and lack `smc` and `casting-admin`.

### What gets seeded

| Group | Modules | `smc` | `casting-admin` | `tv` | `creator` |
|---|---|---|---|---|---|
| `admin` | 27 | ✓ | ✓ | — | — |
| `team_lead` | 20 | — | — | — | — |
| `coordinator` | 18 | — | — | — | — |
| `employee` | 17 | — | — | — | — |
| `smc_member` | 16 | — | — | — | — |
| `creator` | 1 | — | — | — | ✓ |

`tv` and `creator` are opt-in — granted per person, never by role.

**`creator` is deliberately not its derivation.** The derived set for a creator is
the same sixteen modules an SMC member gets, which would hand the Creator
Network's members the whole of Media Ops. It is seeded closed — the network and
nothing else — and it is the one group absent from `MODULE_DEFAULT_ROLES`, so
Settings cannot widen it by accident.

**These lists are strictly narrower than a fresh install had before.** "No row"
meant everything.

---

## D. Fail-closed behaviour

`effectiveModules()` now returns `string[]`, never `null`:

```
explicit per-user override  → that list
group's configured row      → that list
no recognised group         → []          (was null → unrestricted)
group with no row           → []          (was null → unrestricted)
```

All four fail-open gates changed to a plain `.includes(key)`. `tvBoardAllowed()`
now denies on `null` and `[]`.

**An empty list and a missing row are deliberately indistinguishable.** An
administrator who saves an empty list means it, and a row that has gone missing
must not be treated more generously than one that says nothing.

### Two things deliberately preserved

**The Admin bypass.** `requireModule()` and `allowsModule()` still short-circuit on
`isMoAdmin(u)`. An administrator is how a misconfigured install gets repaired, so
they must never be locked out by the configuration they are the only one who can
fix. Tested.

**Client/server agreement.** The old `null` behaviour existed so the sidebar and
the server agreed: the sidebar showed every module when nothing was configured, so
refusing server-side would have left nav items linking to pages that denied them.
That agreement is now kept by *configuration* — both sides read the same seeded
list — rather than by both sides failing open.

---

## E. Migration / bootstrap behaviour

```sql
INSERT INTO mo_module_defaults (role, modules) VALUES ($1, $2::jsonb)
ON CONFLICT (role) DO NOTHING
```

| | Result |
|---|---|
| Fresh installation | all six rows written |
| Existing installation | every administrator-chosen value kept, including a deliberately empty one |
| Repeated boots | idempotent — no row rewritten |

Verified against the live development database: its six rows are byte-identical
before and after this work.

### One unrelated defect this surfaced

The bootstrap contains nine `DROP CONSTRAINT IF EXISTS` / `ADD CONSTRAINT` pairs.
Two callers running that pair concurrently both drop, both add, and the second
dies with `constraint "…" already exists`. Nothing made that likely until several
integration suites began calling the bootstrap against one database — but it was
always true of **two application instances starting together, which is an ordinary
deploy**. `bootstrapMediaOpsDatabase()` now takes a session advisory lock, so the
whole bootstrap serialises. Eight of the nine pairs predate this work.

---

## F. Tests

`server/mediaops-module-defaults.integration.test.ts` — 19 tests:

| Requirement | Covered by |
|---|---|
| 1. Fresh DB has every group | a row for each of the six; every seeded key is a real sidebar module |
| 2. Explicitly enabled → allowed | `employee` holds `equipment` → `GET /equipment` 200 |
| 3. Explicitly disabled → denied | `employee` lacks `tv` → `GET /tv/board` 403; per-user override withholding |
| 4. Missing configuration → denied | unresolvable group resolves to `[]`; empty resolution → 403 |
| 5. Administrator config preserved | `ON CONFLICT DO NOTHING` proven on a private row; real rows byte-identical across a re-seed |
| 6. Creator unchanged | creator resolves to `['creator']` and leaks nothing |
| 7. Equipment authorization unchanged | module-driven 200/403, message unchanged |
| 8. Existing gates pass | whole suite, 1127 tests |
| 9. No Creator behaviour change | Creator suites untouched and green |
| 10. Bootstrap idempotent | re-run changes no row |

**Security regression test:** every protected surface (`/equipment`, `/tv/board`,
`/creator/state`) and a protected write, with no module resolved, must answer ≥400.

### Why no test deletes a defaults row

The obvious way to test "missing row denies" is to delete one. Every group's row is
shared configuration read by every suite in the run. An earlier version of this
file removed the `coordinator` row on the assumption nothing else used it; the
project-hierarchy suite promptly failed with *"no access to the projects module"*,
because its Coordinator resolves through that row. **There is no group some sibling
does not depend on.**

So the branch is covered where it can be covered honestly: `effectiveModules()`
returning `[]` for an unresolvable group is the *same* `return []` the missing-row
branch takes, on a state no suite can disturb; and the end-to-end 403 is driven by
an empty resolution, which is byte-for-byte the list a missing row produces through
the identical gate.

---

## G. Validation

| Check | Result |
|---|---|
| `npm test` | **1127 passed / 1127** — 42 files |
| Stability | 11 of 12 consecutive full runs green |
| From a freshly created test database | **1127 / 1127** |
| Development DB modified | **No** — fingerprinted before/after including `mo_module_defaults` |
| `npm run build` | **PASS** |
| `npm run typecheck` | **PASS** |
| `npm run lint` | 1 error, 18 warnings — **unchanged from baseline** |
| Targeted auth / Creator / Equipment suites | **246 / 246** |

Test count 1126 → 1127 net of the 19 added and the TV unit test's null assertion
being split in two.

---

## H. Remaining authorization risks

1. **`GET /module-defaults` is not module-gated.** It is guarded by `requireMedia()`
   alone, so any crew member can read the whole module map. Information disclosure
   about the permission structure, not access — and pre-existing. Left alone
   deliberately: gating it is a separate decision, not part of fail-closed.

2. **The client still fails open.** `effectiveModulesFor()` in
   `public/media-ops/index.html` returns `null` for a missing row and
   `moduleAllowed()` reads that as unrestricted. With seeding in place this cannot
   arise; if a row were deleted, the user would see modules and get 403s on
   clicking them. Ugly, not unsafe — the server is the boundary. Worth aligning,
   but it would change the standalone prototype's offline behaviour and is out of
   scope here.

3. **`smc_member`'s derived default is broad** — 16 modules including `projects`,
   `equipment`, `requests` and `dispatch`. That is what the application already
   granted an SMC member implicitly, so seeding it changes nothing, but the
   development organisation narrowed theirs to three modules. Administrators should
   review it. Narrowing it in the product would be inventing policy.

4. **Per-user overrides are unvalidated.** `allowed_modules` accepts any string;
   a typo grants nothing and reports no error. Pre-existing.

5. **The seed can drift from the sidebar.** A renamed route would leave a stale key.
   The suite asserts every seeded key is a real sidebar module, which catches a
   rename in one direction but not a *new* module nobody adds to the defaults —
   that one would simply be ungranted, which is the safe direction.

6. **One flaky run in twelve** remains, not reproduced in five follow-up attempts.
   The suites share one database under parallelism; several assert on counts that
   siblings can move. Three such cases were scoped during this work
   (`crew-lifecycle`, `creator-directory`, `tv-access`) and more may exist.
