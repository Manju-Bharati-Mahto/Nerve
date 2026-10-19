/**
 * Every outreach tab an admin can grant, and what a View or Edit grant means.
 *
 * Account Tabs & State-wise Analytics requirements, §1: "Whenever the admin
 * adds a new user, all available tabs should be displayed with permission
 * options." This is that list, in the order the requirements give it, followed
 * by the outreach tabs the list did not name (My Videos, Scheduled, To-Do,
 * Social Pages, AI) — it says ALL available tabs, and leaving those out would
 * leave a person who needs one with no way to be given it.
 *
 * WHO IT APPLIES TO. A super admin and an outreach manager always have every
 * tab and every state; they are never configured. Everybody else on the
 * outreach team is either:
 *   - CONFIGURED — an admin has saved their tabs: they get exactly those, at
 *     exactly the level ticked; or
 *   - NOT YET CONFIGURED — they keep precisely what their role gave them before
 *     tabs could be chosen. The `defaults` below describe that, and are used
 *     only to pre-fill the Add / Edit User grid with what the person already
 *     has. They are not what enforces it: until somebody saves, the server and
 *     the route guards keep their original role checks, unchanged.
 *
 * TWO COPIES, ONE TEXT. server/outreach-tabs.ts and src/lib/outreach-tabs.ts
 * are byte-identical (outreach-tabs.test.ts fails if they drift), because the
 * server enforces these ids and the browser offers them. No imports, and no
 * work at load time beyond building one map: the shared sidebar loads this.
 */

export type OutreachTabLevel = "view" | "edit";
export type OutreachTabGroup = "influencer" | "video";

/** The roles that can be configured. Super admin and outreach manager are not. */
export type ConfigurableOutreachRole = "admin" | "outreach_editor" | "outreach_publisher" | "outreach_state_user";

export interface OutreachTab {
  id: string;
  label: string;
  group: OutreachTabGroup;
  /** The tab's own page; detail pages under it (`/outreach/pages/:id`) count as the same tab. */
  path: string;
  /** What an Edit grant allows, shown in the grid. Absent = the tab only shows things; no Edit is offered. */
  edit?: string;
  /** The single-tab grant that opened this tab before tabs were configurable; read as View. */
  legacyCapability?: string;
  /** What each role had before configuration — used to pre-fill the grid only. */
  defaults: { view: ConfigurableOutreachRole[]; edit: ConfigurableOutreachRole[] };
  /** Video workflow tabs need a workflow role (Editor, Publisher, Admin); a State User has none. */
  needsVideoRole?: boolean;
}

export const OUTREACH_TABS: readonly OutreachTab[] = [
  // ── Influencer outreach — every one of these is limited to the person's states ──
  { id: "dashboard", label: "Dashboard", group: "influencer", path: "/outreach/dashboard", defaults: { view: [], edit: [] } },
  { id: "campaigns", label: "Campaigns", group: "influencer", path: "/outreach/campaigns",
    edit: "Create, edit and delete campaigns in their states, and add live posts to them",
    defaults: { view: [], edit: [] } },
  { id: "calendar", label: "Calendar", group: "influencer", path: "/outreach/calendar", defaults: { view: [], edit: [] } },
  { id: "analytics", label: "Analytics", group: "influencer", path: "/outreach/analytics", defaults: { view: [], edit: [] } },
  { id: "alerts", label: "Alerts", group: "influencer", path: "/outreach/alerts", defaults: { view: [], edit: [] } },
  { id: "states", label: "State", group: "influencer", path: "/outreach/states", defaults: { view: [], edit: [] } },
  { id: "pages", label: "All Pages", group: "influencer", path: "/outreach/pages",
    edit: "Edit page name, link, state, geography and inventory for pages in their states",
    defaults: { view: [], edit: [] } },
  { id: "creators", label: "Creators", group: "influencer", path: "/outreach/creators",
    edit: "Edit creators in their states", defaults: { view: [], edit: [] } },
  { id: "ai", label: "AI", group: "influencer", path: "/outreach/ai", defaults: { view: [], edit: [] } },

  // ── Video workflow ──
  { id: "video_dashboard", label: "Video Dashboard", group: "video", path: "/outreach/video/dashboard",
    legacyCapability: "outreach:video_dashboard", needsVideoRole: true, defaults: { view: ["admin"], edit: [] } },
  { id: "users", label: "Users", group: "video", path: "/outreach/video/users",
    legacyCapability: "outreach:users", needsVideoRole: true, defaults: { view: ["admin"], edit: [] } },
  { id: "drive", label: "Google Drive", group: "video", path: "/outreach/video/drive",
    edit: "Connect, change or disconnect the outreach Google Drive",
    needsVideoRole: true, defaults: { view: ["admin"], edit: ["admin"] } },
  { id: "video_campaigns", label: "Video Campaigns", group: "video", path: "/outreach/video/campaigns",
    edit: "Create, edit and close video campaigns",
    legacyCapability: "outreach:campaigns", needsVideoRole: true,
    defaults: { view: ["admin", "outreach_editor", "outreach_publisher"], edit: ["admin"] } },
  { id: "review", label: "Review Queue", group: "video", path: "/outreach/video/review",
    edit: "Approve videos or send them back", legacyCapability: "outreach:review", needsVideoRole: true,
    defaults: { view: ["admin"], edit: ["admin"] } },
  { id: "event_calendar", label: "Event Calendar", group: "video", path: "/outreach/video/calendar",
    edit: "Create events and assign them to editors and publishers",
    legacyCapability: "outreach:calendar", needsVideoRole: true, defaults: { view: ["admin"], edit: ["admin"] } },
  { id: "all_videos", label: "All Videos", group: "video", path: "/outreach/video/all",
    legacyCapability: "outreach:all_videos", needsVideoRole: true,
    defaults: { view: ["admin", "outreach_editor", "outreach_publisher"], edit: [] } },
  { id: "queue", label: "Publishing Queue", group: "video", path: "/outreach/video/queue",
    edit: "Schedule approved videos and mark them published",
    legacyCapability: "outreach:queue", needsVideoRole: true,
    defaults: { view: ["admin", "outreach_publisher"], edit: ["admin", "outreach_publisher"] } },
  { id: "published", label: "Published", group: "video", path: "/outreach/video/published",
    edit: "Add or change a published video's live links",
    legacyCapability: "outreach:published", needsVideoRole: true,
    defaults: { view: ["admin", "outreach_editor", "outreach_publisher"], edit: ["admin", "outreach_publisher"] } },
  { id: "editor_log", label: "Editor Video Log", group: "video", path: "/outreach/video/editor-log",
    legacyCapability: "outreach:editor_log", needsVideoRole: true,
    defaults: { view: ["admin", "outreach_publisher"], edit: [] } },
  { id: "activity", label: "Activity", group: "video", path: "/outreach/video/activity",
    legacyCapability: "outreach:activity", needsVideoRole: true,
    defaults: { view: ["admin", "outreach_editor", "outreach_publisher"], edit: [] } },
  { id: "notifications", label: "Notifications", group: "video", path: "/outreach/video/notifications",
    legacyCapability: "outreach:notifications", needsVideoRole: true,
    defaults: { view: ["admin", "outreach_editor", "outreach_publisher"], edit: [] } },

  // ── Outreach tabs the requirements' list did not name ──
  { id: "my_videos", label: "My Videos", group: "video", path: "/outreach/video/my-videos",
    edit: "Upload videos, edit captions, submit for review and revise",
    legacyCapability: "outreach:my_videos", needsVideoRole: true,
    defaults: { view: ["admin", "outreach_editor"], edit: ["admin", "outreach_editor"] } },
  { id: "scheduled", label: "Scheduled", group: "video", path: "/outreach/video/scheduled",
    legacyCapability: "outreach:scheduled", needsVideoRole: true,
    defaults: { view: ["admin", "outreach_publisher"], edit: [] } },
  { id: "todo", label: "To-Do", group: "video", path: "/outreach/video/todo",
    edit: "Mark their assigned events complete", legacyCapability: "outreach:todo", needsVideoRole: true,
    defaults: { view: ["admin", "outreach_editor"], edit: ["admin", "outreach_editor"] } },
  { id: "social_pages", label: "Social Pages", group: "video", path: "/outreach/video/social-pages",
    edit: "Edit a page's link, contact person and status", legacyCapability: "outreach:social_pages", needsVideoRole: true,
    defaults: { view: ["admin", "outreach_editor", "outreach_publisher"], edit: ["admin"] } },
];

export const OUTREACH_TAB_IDS: readonly string[] = OUTREACH_TABS.map(t => t.id);

const TAB_BY_ID = new Map<string, OutreachTab>(OUTREACH_TABS.map(t => [t.id, t]));

export function outreachTab(id: string): OutreachTab | undefined {
  return TAB_BY_ID.get(id);
}

/**
 * The tab a path belongs to: its own page or any page beneath it
 * ("/outreach/pages/abc" is All Pages). Longest match wins, so
 * "/outreach/video/campaigns" is Video Campaigns, not Campaigns.
 */
export function outreachTabForPath(path: string): OutreachTab | undefined {
  let best: OutreachTab | undefined;
  for (const tab of OUTREACH_TABS) {
    if (path === tab.path || path.startsWith(`${tab.path}/`)) {
      if (!best || tab.path.length > best.path.length) best = tab;
    }
  }
  return best;
}

/** A level is at least another: Edit includes View. */
export function levelAtLeast(have: OutreachTabLevel | undefined, need: OutreachTabLevel): boolean {
  if (!have) return false;
  return need === "view" || have === "edit";
}

/**
 * A grid of tab → level as saved, cleaned: unknown tabs dropped, Edit only
 * where the tab offers it (otherwise View), and video tabs removed for a role
 * with no workflow role (a State User).
 */
export function cleanTabLevels(
  levels: Record<string, string | null | undefined>,
  role: string,
): Record<string, OutreachTabLevel> {
  const out: Record<string, OutreachTabLevel> = {};
  for (const [id, raw] of Object.entries(levels)) {
    const tab = TAB_BY_ID.get(id);
    if (!tab || (raw !== "view" && raw !== "edit")) continue;
    if (tab.needsVideoRole && role === "outreach_state_user") continue;
    out[id] = raw === "edit" && tab.edit ? "edit" : "view";
  }
  return out;
}

/**
 * What an as-yet-unconfigured person effectively has: their role's defaults,
 * plus View on any tab their old single-tab grants opened. Pre-fills the grid
 * so saving it for the first time changes nothing the admin did not change.
 */
export function defaultTabLevels(role: string, legacyCapabilities: readonly string[] = []): Record<string, OutreachTabLevel> {
  const out: Record<string, OutreachTabLevel> = {};
  for (const tab of OUTREACH_TABS) {
    const r = role as ConfigurableOutreachRole;
    if (tab.defaults.edit.includes(r)) out[tab.id] = "edit";
    else if (tab.defaults.view.includes(r)) out[tab.id] = "view";
    else if (tab.legacyCapability && legacyCapabilities.includes(tab.legacyCapability)) out[tab.id] = "view";
  }
  return cleanTabLevels(out, role);
}
