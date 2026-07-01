// Source of truth for grantable capabilities on the client side.
// Mirrored in server/capabilities.ts — keep both in sync when adding new keys.

export const CAPABILITIES = [
  "branding:manage_categories",
  "branding:view_team_dashboard",
  "branding:assign_projects",
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
};

export function isValidCapability(key: string): key is CapabilityKey {
  return (CAPABILITIES as readonly string[]).includes(key);
}
