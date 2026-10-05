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
] as const;

export type CapabilityKey = (typeof CAPABILITIES)[number];

export function isValidCapability(key: string): key is CapabilityKey {
  return (CAPABILITIES as readonly string[]).includes(key);
}
