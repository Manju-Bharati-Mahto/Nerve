---
title: 'Fix dashboard tab persistence on reload'
type: 'bugfix'
created: '2026-04-07T16:10:28+05:30'
status: 'done'
baseline_commit: 'afc381cfd33dbe0d060fe50600a113d525654332'
context:
  - '_bmad-output/project-context.md'
  - 'docs/architecture-frontend.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The super admin dashboard uses uncontrolled tab state with a hardcoded default, so reloading the page always returns users to the Overview tab even if they were working in Branding Team or Content Team. That breaks continuity and makes refreshes feel like navigation loss.

**Approach:** Make the selected dashboard tab derive from the URL query string so the current tab survives reloads and remains shareable/bookmarkable. Keep invalid or missing tab values safely mapped to the existing default tab, and cover the behavior with focused regression tests.

## Boundaries & Constraints

**Always:** Preserve the existing `/super-admin/dashboard` route and current tab labels/content; use a single visible source of truth for the active tab; keep fallback behavior on unknown state aligned with the current default Overview tab; add regression coverage for both restoring a selected tab and safe fallback behavior.

**Ask First:** Any change that would require a new nested route structure, broader dashboard information architecture changes, or a persistence mechanism that affects other dashboard pages beyond this bug.

**Never:** Introduce localStorage/sessionStorage as a second persistence layer for the same tab; change unrelated branding/content dashboard behavior; alter auth/role guard routing; refactor the dashboard layout beyond what is needed to make tab persistence reliable and testable.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Restore selected tab | User loads `/super-admin/dashboard?tab=branding` or reloads while that query is present | Branding Team tab renders as active and its panel content is shown instead of Overview | N/A |
| Change active tab | User clicks a different tab while on the super admin dashboard | URL query updates to the selected tab so a subsequent reload reopens the same tab | N/A |
| Invalid tab query | User loads `/super-admin/dashboard?tab=unknown` | Dashboard falls back to Overview and does not crash or render an empty state | Invalid values are ignored and normalized to the default experience |

</frozen-after-approval>

## Code Map

- `src/pages/SuperAdminDashboard.tsx` -- current uncontrolled tab implementation and best place to bind tab state to URL search params
- `src/App.tsx` -- route surface confirming the dashboard remains on the existing `/super-admin/dashboard` path
- `src/test/setup.ts` -- shared frontend test setup available for DOM/router-based page tests
- `src/pages/SuperAdminDashboard.test.tsx` -- regression coverage for query-param restoration, click-driven URL updates, and invalid-tab fallback

## Tasks & Acceptance

**Execution:**
- [x] `src/pages/SuperAdminDashboard.tsx` -- replace `defaultValue`-only tab behavior with validated query-param-driven state and tab updates -- makes reload persistence explicit and URL-backed
- [x] `src/pages/SuperAdminDashboard.test.tsx` -- add regression tests for restoring the active tab from the URL, updating the URL when a new tab is selected, and falling back on invalid tab values -- prevents regressions in future dashboard changes
- [x] `src/test/example.test.ts` -- remove or keep only if it still adds value after introducing the real regression coverage -- avoid leaving placeholder-only tests as the main frontend signal

**Acceptance Criteria:**
- Given the super admin dashboard is opened with `?tab=branding`, when the page loads or reloads, then the Branding Team tab remains selected and its panel content is displayed
- Given a user is on the super admin dashboard, when they switch from Overview to Content Team, then the browser URL reflects the selected tab and a reload keeps Content Team selected
- Given the dashboard is opened with an unsupported `tab` query value, when the page renders, then Overview is shown and no broken/blank tab state appears

## Spec Change Log

## Design Notes

Use the URL query string as the only persistence channel for this page because it survives reloads naturally, keeps deep links meaningful, and avoids hiding navigation state inside browser storage. Validation should remain local and explicit so malformed query values degrade cleanly to the existing Overview default.

## Verification

**Commands:**
- `npm test -- SuperAdminDashboard` -- expected: new regression tests pass
- `npm run build` -- expected: frontend and server builds still succeed after the tab-state change

## Suggested Review Order

**Tab State Binding**

- Defines the allowed tab values and the safe fallback to `overview`.
  [`SuperAdminDashboard.tsx:16`](../../src/pages/SuperAdminDashboard.tsx#L16)

- Binds the selected tab to `?tab=` and canonicalizes invalid or duplicate values.
  [`SuperAdminDashboard.tsx:307`](../../src/pages/SuperAdminDashboard.tsx#L307)

- Switches Radix tabs from uncontrolled defaults to URL-backed controlled state.
  [`SuperAdminDashboard.tsx:358`](../../src/pages/SuperAdminDashboard.tsx#L358)

**Regression Coverage**

- Sets up router-aware rendering and stable hook/API mocks for page-level behavior tests.
  [`SuperAdminDashboard.test.tsx:77`](../../src/pages/SuperAdminDashboard.test.tsx#L77)

- Covers deep-link restore, keyboard-driven URL updates, and malformed-query normalization.
  [`SuperAdminDashboard.test.tsx:105`](../../src/pages/SuperAdminDashboard.test.tsx#L105)
