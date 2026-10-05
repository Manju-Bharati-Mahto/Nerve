// Source of truth for grantable capabilities on the server side.
// Mirrored in src/lib/capabilities.ts — keep both in sync when adding new keys.
//
// Capabilities are layered ON TOP of roles: a user with a capability gets
// access to a specific admin feature without being promoted to admin.

/**
 * BrandOps modules. One key per tab, because the branding admin grants access
 * tab by tab when creating an Inventory Manager — these are the switches in
 * that dialog, and each is enforced on the API as well as in the sidebar.
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
 * Outreach video workflow modules (PRD §6 "Custom Permissions"). One key per
 * tab, for the same reason as BrandOps: the outreach manager administers their
 * own team and decides tab by tab what each person sees. Enforced on the API
 * as well as in the sidebar — the nav is a convenience, not the control.
 */
export const OV_CAPABILITIES = [
  "outreach:video_dashboard",
  "outreach:my_videos",
  "outreach:all_videos",
  "outreach:campaigns",
  "outreach:review",
  "outreach:queue",
  "outreach:scheduled",
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

export function isValidCapability(key: string): key is CapabilityKey {
  return (CAPABILITIES as readonly string[]).includes(key);
}
