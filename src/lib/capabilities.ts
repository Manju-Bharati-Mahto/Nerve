// Source of truth for grantable capabilities on the client side.
// Mirrored in server/capabilities.ts — keep both in sync when adding new keys.

/**
 * BrandOps modules — one key per tab. These are the switches a branding admin
 * flips when creating an Inventory Manager, so the label and description here
 * are what that admin reads while deciding.
 */
export const BO_CAPABILITIES = [
  "brandops:dashboard",
  "brandops:frame_inventory",
  "brandops:in_use",
  "brandops:allocate",
  "brandops:frame_return",
  "brandops:requests",
  "brandops:quotations",
  "brandops:approvals",
  "brandops:work_orders",
  "brandops:vendor_visits",
  "brandops:completion",
  "brandops:material_delivery",
  "brandops:vendors",
  "brandops:institutes",
  "brandops:reports",
  "brandops:activity",
] as const;

export type BoCapability = (typeof BO_CAPABILITIES)[number];

/**
 * Outreach video workflow modules — one key per tab (PRD §6 "Custom
 * Permissions"). These are the switches the outreach manager flips when
 * creating an Editor, Publisher or Manager, so the label and description here
 * are what that manager reads while deciding.
 */
export const OV_CAPABILITIES = [
  "outreach:video_dashboard",
  "outreach:my_videos",
  "outreach:all_videos",
  "outreach:queue",
  "outreach:published",
  "outreach:calendar",
  "outreach:social_pages",
  "outreach:editor_log",
  "outreach:todo",
  "outreach:notifications",
  "outreach:users",
  "outreach:activity",
] as const;

export type OvCapability = (typeof OV_CAPABILITIES)[number];

export const CAPABILITIES = [
  "branding:manage_categories",
  "branding:view_team_dashboard",
  "branding:assign_projects",
  "branding:leave_calendar",
  "design:manage_categories",
  "design:view_team_dashboard",
  "design:assign_projects",
  "design:leave_calendar",
  ...BO_CAPABILITIES,
  ...OV_CAPABILITIES,
] as const;

export type CapabilityKey = (typeof CAPABILITIES)[number];

// Human-readable metadata for each capability — drives the MemberDialog
// picker UI and the dynamically-rendered sidebar entries.
export const CAPABILITY_META: Record<CapabilityKey, {
  label: string;
  description: string;
  // Route this capability unlocks, used by the sidebar to inject an entry.
  route: string;
  // Sidebar label for the injected entry.
  sidebarLabel: string;
}> = {
  "branding:manage_categories": {
    label: "Manage categories",
    description: "Add / edit / delete work categories that members pick from in daily reports.",
    route: "/branding/categories",
    sidebarLabel: "Manage Categories",
  },
  "branding:view_team_dashboard": {
    label: "Branding dashboard (all team reports)",
    description: "View the full team daily-reports dashboard with charts, work analytics, and top contributors.",
    route: "/branding/dashboard",
    sidebarLabel: "Team Dashboard",
  },
  "branding:assign_projects": {
    label: "Assign projects",
    description: "Create projects and assign work to designers; each assignment adds a row to the designer's daily report.",
    route: "/branding/projects",
    sidebarLabel: "Assign Projects",
  },
  "branding:leave_calendar": {
    label: "Leave calendar",
    description: "View the team-wide leave calendar showing everyone's submitted and approved leaves.",
    route: "/branding/leave-calendar",
    sidebarLabel: "Leave Calendar",
  },
  "design:manage_categories": {
    label: "Manage categories",
    description: "Add / edit / delete work categories that members pick from in daily reports.",
    route: "/design/categories",
    sidebarLabel: "Manage Categories",
  },
  "design:view_team_dashboard": {
    label: "Design dashboard (all team reports)",
    description: "View the full team daily-reports dashboard with charts, work analytics, and top contributors.",
    route: "/design/dashboard",
    sidebarLabel: "Team Dashboard",
  },
  "design:assign_projects": {
    label: "Assign projects",
    description: "Create projects and assign work to designers; each assignment adds a row to the designer's daily report.",
    route: "/design/projects",
    sidebarLabel: "Assign Projects",
  },
  "design:leave_calendar": {
    label: "Leave calendar",
    description: "View the team-wide leave calendar showing everyone's submitted and approved leaves.",
    route: "/design/leave-calendar",
    sidebarLabel: "Leave Calendar",
  },
  "brandops:dashboard": {
    label: "Dashboard",
    description: "Live KPIs: frames available and deployed, overdue returns, pending branding work.",
    route: "/branding/ops/dashboard",
    sidebarLabel: "Dashboard",
  },
  "brandops:frame_inventory": {
    label: "Frame Inventory",
    description: "The full asset register. Add and remove frames, search by asset ID, size, status or institute.",
    route: "/branding/ops/frames",
    sidebarLabel: "Frame Inventory",
  },
  "brandops:in_use": {
    label: "In Use Frames",
    description: "Every deployed frame with its institute, exact location and usage period.",
    route: "/branding/ops/in-use",
    sidebarLabel: "In Use Frames",
  },
  "brandops:allocate": {
    label: "Allocate / Move",
    description: "Send a specific frame to an institute for an event, with from and until dates.",
    route: "/branding/ops/allocate",
    sidebarLabel: "Allocate / Move",
  },
  "brandops:frame_return": {
    label: "Frame Return",
    description: "Receive a deployed frame back into store, recording its condition.",
    route: "/branding/ops/return",
    sidebarLabel: "Frame Return",
  },
  "brandops:requests": {
    label: "Branding Requests",
    description: "Raise and track branding requirements from institutes.",
    route: "/branding/ops/requests",
    sidebarLabel: "Branding Requests",
  },
  "brandops:quotations": {
    label: "Quotations",
    description: "Record vendor quotations against a requirement.",
    route: "/branding/ops/quotations",
    sidebarLabel: "Quotations",
  },
  "brandops:approvals": {
    label: "Approvals",
    description: "Approve or reject quotations. Approving one rejects the competing quotes and unlocks the work order.",
    route: "/branding/ops/approvals",
    sidebarLabel: "Approvals",
  },
  "brandops:work_orders": {
    label: "Work Orders",
    description: "Issue work orders from approved quotations and move them through to completion.",
    route: "/branding/ops/work-orders",
    sidebarLabel: "Work Orders",
  },
  "brandops:vendor_visits": {
    label: "Vendor Visits",
    description: "Check vendors in and out on site. Timestamps are recorded by the server, not typed in.",
    route: "/branding/ops/visits",
    sidebarLabel: "Vendor Visits",
  },
  "brandops:completion": {
    label: "Work Completion & Photos",
    description: "Upload before / during / after photos and verify finished work.",
    route: "/branding/ops/completion",
    sidebarLabel: "Work Completion",
  },
  "brandops:material_delivery": {
    label: "Material Delivery",
    description: "Track printed material from vendor delivery through to institute collection.",
    route: "/branding/ops/deliveries",
    sidebarLabel: "Material Delivery",
  },
  "brandops:vendors": {
    label: "Vendors",
    description: "Manage the vendor master list.",
    route: "/branding/ops/vendors",
    sidebarLabel: "Vendors",
  },
  "brandops:institutes": {
    label: "Institutes",
    description: "Manage the institute master list that every other module picks from.",
    route: "/branding/ops/institutes",
    sidebarLabel: "Institutes",
  },
  "brandops:reports": {
    label: "Reports",
    description: "Inventory totals by size and institute, and the source sheet reconciliation.",
    route: "/branding/ops/reports",
    sidebarLabel: "Reports",
  },
  "brandops:activity": {
    label: "Activity Log",
    description: "Every BrandOps action, who did it and when.",
    route: "/branding/ops/activity",
    sidebarLabel: "Activity Log",
  },
  "outreach:video_dashboard": {
    label: "Video dashboard",
    description: "Workflow totals — videos by status, pending work and recent activity across the team.",
    route: "/outreach/video/dashboard",
    sidebarLabel: "Video Dashboard",
  },
  "outreach:my_videos": {
    label: "My videos",
    description: "An editor's own uploads and the status of each one.",
    route: "/outreach/video/my-videos",
    sidebarLabel: "My Videos",
  },
  "outreach:all_videos": {
    label: "All videos (search)",
    description: "Search and filter every video in the workflow by campaign, date, page, status, user or platform.",
    route: "/outreach/video/all",
    sidebarLabel: "All Videos",
  },
  "outreach:queue": {
    label: "Publishing queue",
    description: "Content waiting to be published, with the caption and the video to download.",
    route: "/outreach/video/queue",
    sidebarLabel: "Publishing Queue",
  },
  "outreach:published": {
    label: "Published",
    description: "The publishing record — what went out, when, and by whom.",
    route: "/outreach/video/published",
    sidebarLabel: "Published",
  },
  "outreach:calendar": {
    label: "Event calendar",
    description: "The shooting and posting calendar, and which editor is assigned to each event.",
    route: "/outreach/video/calendar",
    sidebarLabel: "Event Calendar",
  },
  "outreach:social_pages": {
    label: "Social media pages",
    description: "The pages content is posted to. Editors see the page and platform only, never analytics.",
    route: "/outreach/video/social-pages",
    sidebarLabel: "Social Pages",
  },
  "outreach:editor_log": {
    label: "Editor video log",
    description: "Per-editor output over time — how much each editor has produced and delivered.",
    route: "/outreach/video/editor-log",
    sidebarLabel: "Editor Video Log",
  },
  "outreach:todo": {
    label: "To-do",
    description: "Events assigned to this person that still need a video.",
    route: "/outreach/video/todo",
    sidebarLabel: "To-Do",
  },
  "outreach:notifications": {
    label: "Notifications",
    description: "Workflow notices — assignments, submissions and completions.",
    route: "/outreach/video/notifications",
    sidebarLabel: "Notifications",
  },
  "outreach:users": {
    label: "Workflow users (admin)",
    description: "Add team members, set their role and choose the tabs each one can see. Grant with care — this is the administration tab.",
    route: "/outreach/video/users",
    sidebarLabel: "Users",
  },
  "outreach:activity": {
    label: "Activity log",
    description: "The audit trail — who uploaded, approved, scheduled or published each piece of content.",
    route: "/outreach/video/activity",
    sidebarLabel: "Activity Logs",
  },
};

/** The BrandOps tabs in the order they appear in the sidebar. */
export const BO_CAPABILITY_ORDER: BoCapability[] = [...BO_CAPABILITIES];

/** The outreach video tabs in the order they appear in the sidebar. */
export const OV_CAPABILITY_ORDER: OvCapability[] = [...OV_CAPABILITIES];

export function isBoCapability(key: string): key is BoCapability {
  return (BO_CAPABILITIES as readonly string[]).includes(key);
}

export function isValidCapability(key: string): key is CapabilityKey {
  return (CAPABILITIES as readonly string[]).includes(key);
}
