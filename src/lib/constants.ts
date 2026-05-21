export const DEPARTMENTS = [
  'Engineering',
  'Physiotherapy',
  'Pharmacy',
  'Management',
  'Architecture',
  'Design',
  'Nursing',
  'Medical',
  'Law',
  'Computer Applications',
  'Sciences',
  'Arts & Humanities',
  'Goa Campus',
  'Vadodara Campus',
  'University-Wide',
  'Other',
]

// Entry types owned by each team
export const BRANDING_TYPES = [
  'Event',
  'Achievement',
  'MOU / Partnership',
  'Placement',
  'Infrastructure',
  'Campaign',
] as const

export const CONTENT_TYPES = [
  'Program update',
  'Research',
  'Faculty',
  'Student activity',
  'Admission',
  'Policy',
  'General update',
] as const

export const ENTRY_TYPES = [...BRANDING_TYPES, ...CONTENT_TYPES]

export const PRIORITIES = ['Normal', 'High', 'Key highlight'] as const

export const ROLES = ['super_admin', 'admin', 'sub_admin', 'user', 'outreach_manager', 'branding_reports_admin'] as const
export type AppRole = typeof ROLES[number]

export const TEAMS = ['branding', 'content', 'outreach'] as const
export type BuiltInTeam = typeof TEAMS[number]
export type AppTeam = string  // BuiltInTeam or any custom team slug
