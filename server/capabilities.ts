// Source of truth for grantable capabilities on the server side.
// Mirrored in src/lib/capabilities.ts — keep both in sync when adding new keys.
//
// Capabilities are layered ON TOP of roles: a user with a capability gets
// access to a specific admin feature without being promoted to admin.

export const CAPABILITIES = [
  "branding:manage_categories",
  "branding:view_team_dashboard",
  "branding:assign_projects",
  "branding:leave_calendar",
] as const;

export type CapabilityKey = (typeof CAPABILITIES)[number];

export function isValidCapability(key: string): key is CapabilityKey {
  return (CAPABILITIES as readonly string[]).includes(key);
}
