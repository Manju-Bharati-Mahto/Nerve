# Outreach video workflow — gap audit against the Campaign & Content Management PRD

**Source document:** `Social_Media_Campaign_Management_PRD.pdf` (17 sections), supplied 2026-10-05.
**Audited against:** `server/outreach-video/*`, `src/pages/outreach/video/*`, `server/outreach-db.ts`, `src/App.tsx`, `src/lib/capabilities.ts`.

---

## The headline finding

**This PDF is not the PRD the module was built from.** The shipped
`server/outreach-video` module cites section numbers up to §28 and implements a
different specification — one with clients/projects, editor analytics
restrictions, and a deliberately minimal status set. The attached PDF is a
17-section document describing overlapping functionality with **materially
different rules**.

Most of the PDF is already satisfied. The gaps are concentrated, and three of
them are not gaps at all but **direct contradictions** of decisions the existing
code made on purpose and wrote tests for. Those three cannot be "filled" — they
have to be chosen between.

### The three contradictions

| # | The PDF says | The code does | Why it matters |
|---|---|---|---|
| **C1** | §11: `Uploaded → Under Review → Approved → Scheduled → Published`, plus `Rejected → Editor Revision → Under Review`, with the rejection reason visible to the editor | `draft \| submitted \| published`, with the comment *"§7 — the whole status set. There is deliberately no approval/revision state."* | Adding approval, rejection and scheduling changes the core state machine, every guard that reads it, the queue, the dashboards, and the status of **existing Drive records**. This is a migration, not an addition. |
| **C2** | §7 + §17: a Campaign is an entity (name, description, start/end, campaign manager, pages, status, posting requirements, notes), and *"One Campaign = One Centralized Workspace"* | A video's campaign is a **plain string** (`client`) used as a Drive sub-folder name. A real campaign entity exists, but in Postgres (`outreach_campaigns`), belonging to the separate influencer-outreach side and never linked to a video. | Satisfying §17 means unifying two campaign concepts that currently share nothing. Every existing video carries a free-text campaign that would need mapping onto a real row. |
| **C3** | §9: Drive layout `Social Media Campaigns/<Campaign>/{Videos, Captions, Published}` and §10 naming `VLF 2027 - Video 1.mp4` | Root layout `Videos/`, `Thumbnails/`, `Reports/`, with per-campaign sub-folders under `Videos/`, named `<Campaign> Video <n>` (no hyphen, no `Captions/` or `Published/` folder) | Drive is the **source of truth** (`types.ts`: *"nothing here is mirrored into Postgres"*). Restructuring folders and renaming files moves live assets people already have links to. |

---

## Section-by-section

Legend: ✅ done · 🟡 partial · ❌ missing · ⚠️ conflicts with shipped behaviour

### §1 Product Overview
✅ Four roles exist as `VIDEO_ROLES = ["admin","editor","manager","publisher"]`, mapped from Nerve roles by `videoRoleForNerveRole()`.

### §2 Roles & Permissions

**Editor** — 🟡
| Requirement | State |
|---|---|
| Upload video | ✅ `POST /videos` |
| Add caption | ✅ `PATCH /videos/:id/caption` |
| Select campaign | 🟡 free-text `client`, not a campaign record (**C2**) |
| Select social media page(s) | ❌ a video carries a `platform` string; there is no page selection and no page link |
| Add description/notes | ✅ `notes` |
| View uploaded content and status | ✅ `VideoMyVideos` |
| View assigned campaigns | 🟡 editors are assigned to **events**, not campaigns |

**Publisher** — 🟡
| Requirement | State |
|---|---|
| Full access to campaigns and content | ✅ |
| View/download videos | ✅ `/stream`, `/download` |
| Copy captions | ✅ |
| **Schedule posts** | ❌ no scheduled state and no scheduled-time field |
| Mark as published | ✅ `POST /videos/:id/publish` |
| **Add posting date/time** | 🟡 `publishedAt` records when it *was* published; there is no field for an intended posting time |
| View publishing history | ✅ `VideoPublished`, activity log |
| Access old/existing version | 🟡 `currentVersion` is tracked; no version history UI |

**Manager** — ❌ mostly
| Requirement | State |
|---|---|
| View campaign status | ❌ (**C2**) |
| Monitor pending/running/completed campaigns | ❌ |
| View posting progress | ❌ |
| Campaign/event calendar | 🟡 `VideoCalendar` shows **events**, not campaign postings |
| Monitor remaining posts | ❌ no posting requirement to count against |
| View assigned publishers and pages | ❌ events assign an **editor** only |

**Admin** — 🟡
| Requirement | State |
|---|---|
| Add/edit/deactivate users | ✅ `VideoUsers`, `POST/PATCH/DELETE /users` |
| Assign roles | ✅ |
| **Set custom permissions** | ❌ **nothing exists** |
| Create/manage campaigns | ❌ in this module (**C2**) |
| Manage social media pages | 🟡 read-only `GET /social-pages`; no CRUD here |
| View all content and activity | ✅ `VideoActivity` |
| View analytics and audit logs | ✅ `/kpis`, `/activity` |

### §3 Editor Dashboard & Upload Workflow — 🟡
Upload → campaign → **page(s)** → caption → submit: the page-selection step is missing. Content does reach a per-campaign Drive folder ✅, though not the §9 layout (**C3**).

### §4 Publisher Requirements — 🟡
Everything present except **scheduling** and an intended **posting date/time**.

### §5 Manager Dashboard & Campaign/Event Calendar — ❌
`/kpis` serves video-level counts. None of the nine campaign-level metrics exist. The calendar shows events with *(title, description, date, client, assignedEditor, status)* — the PDF asks each entry to show **Campaign Name, Social Media Page, Content Type, Posting Date/Time, Assigned Publisher, Status**, of which only status is present. Campaign progress (required / published / remaining) has nothing to count against.

### §6 Admin User Management — 🟡 → **this is the piece being built now**
| Field | State |
|---|---|
| Full Name | ✅ |
| Email | ✅ |
| Mobile Number (optional) | ❌ |
| Profile Photo (optional) | ❌ (`avatar_url` exists on the Nerve user) |
| Department/Team | ❌ on the workflow user |
| Role | ✅ |
| **Custom Permissions** | ❌ |

Also note: **"Add User" here does not create a login.** It writes the Drive
workflow registry only, so the person cannot sign in unless a Nerve account was
created for them separately.

### §7 Campaign Management — ❌ / ⚠️ (**C2**)
`outreach_campaigns` already has name, start/end, status, assigned pages and
budgets (`budget_posts/stories/reels` ≈ posting requirements). It lacks
**campaign manager** and **notes**, and has no relationship to a video.

### §8 Social Media Page Management — 🟡
Pages exist via the outreach sync with platform and handle; campaigns reference
them (`assigned_page_ids` ✅). Missing: **contact person**, and admin CRUD from
this module. Note `social-pages.ts` deliberately restricts what an editor may
see (no analytics) — a constraint from the *other* PRD that this PDF does not
mention but which should be preserved.

### §9 Google Drive Integration — ⚠️ (**C3**)
Integration is real and working; the folder layout differs.

### §10 Automatic Video & Caption Naming — 🟡 / ⚠️ (**C3**)
Sequential per-campaign numbering ✅, held explicitly in `sequences` so a number
is never reused. A matching `.txt` caption file is written ✅. Differences: the
file name is `<Campaign> Video <n>` rather than `<Campaign> - Video <n>`, and
the caption file's body is the caption alone — the PDF wants Campaign, Video
Number, Platform/Page and caption.

### §11 Content Status Workflow — ⚠️ **(C1)** the central conflict

### §12 Dashboard Analytics — 🟡
`/kpis` exists; the four per-role metric sets in the PDF table are not
separately modelled, and the Admin/Manager sets depend on campaign data (**C2**).

### §13 Search & Filtering — ✅ / 🟡
`GET /search` and `GET /filter-options` exist. Facets for **campaign** and
**content type** depend on **C2**; the rest are available.

### §14 Notifications — 🟡 / ⚠️
Implemented kinds are `video_submitted`, `event_assigned`, `event_reassigned`,
`event_completed`. The PDF asks for approval/rejection/revision notices (needs
**C1**) and deadline notices (needs **C2**). Overlap is small.

### §15 Audit Log — ✅
Per-record `ActivityEntry[]` with the actor's name/email **snapshotted**, so
history survives user deletion. Exceeds the PDF's requirement.

### §16 End-to-End System Flow — 🟡
Follows from the above; the Admin→Campaign and Manager-monitoring legs are the
weak links.

### §17 Core Product Principle — ❌ (**C2**)
"One Campaign = One Centralized Workspace" is the one thing the current design
does not do: a campaign is a string on a video and, separately, a row in
Postgres.

---

## What this means for sequencing

1. **Admin, users, roles and per-tab permissions** (§2 Admin, §6) are additive.
   They contradict nothing and are the explicit ask. **Build now.**
2. **Campaign as a first-class entity** (**C2**, §7/§17) is the keystone. §5,
   §12, §13 and most of §14 are blocked behind it, and it needs a decision about
   whether to adopt `outreach_campaigns` or introduce a campaign inside the
   video workflow's Drive stores.
3. **The status machine** (**C1**, §11) and **Drive restructuring** (**C3**,
   §9/§10) are rewrites of working, tested behaviour with live data behind them.
   Each needs an explicit go-ahead and a migration plan.

---

## Separate finding: the frontend has not been typechecked

`npm run typecheck` runs `tsc --noEmit -p tsconfig.json`, and `tsconfig.json`
has `"files": []` with project references. That configuration compiles
**nothing** — the command exits 0 without checking a single file. Only the
second half of the script, `-p tsconfig.server.json`, does real work, so the
server has been typechecked and the React app has not.

Checking the app properly (`tsc --noEmit -p tsconfig.app.json`) reports errors
in five files that predate this work:

- `src/pages/AddEntry.tsx` — `priority: string` passed where a union is required
- `src/pages/AdminUsers.tsx` — calls `updateRole`, which does not exist (it is `updateRoleAndTeam`)
- `src/pages/SuperAdminUsers.tsx`
- `src/pages/branding/BrandingUserDashboard.tsx` — missing `last_paused_at`
- `src/pages/design/DesignUserDashboard.tsx` — the same

The `AdminUsers` one is a real runtime bug: that call cannot succeed.

The script is left alone here deliberately. Pointing it at `tsconfig.app.json`
turns the build red immediately for five unrelated files, which is not a change
to make in the middle of a feature branch. It is worth doing on its own, with
those five fixed in the same change.

One defect in already-merged work was found this way and fixed on this branch:
`BoButton` had no `title` prop, so the tooltip explaining why "Remove" is
disabled on the BrandOps Institutes page silently did nothing.
