/* ═══════════════════════════════════════════════════════════════════════════
   Roster rules for the branding team panel.

   These live apart from the component because both exist to be exhaustive,
   and exhaustiveness is worth stating as a test. Both failed the same way
   when inventory_manager was added: a hand-written list of roles stopped
   being complete, and neither omission announced itself. A member vanished
   from a page that still counted them, and the edit dialog opened on the
   wrong role and would have saved it.
   ═══════════════════════════════════════════════════════════════════════════ */

/** Roles drawn in the "Team Leads" group; everyone else is an ordinary member. */
export const LEAD_ROLES = ['sub_admin', 'task_owner', 'task_manager'] as const

/** Roles the member dialog can edit. A role missing here opens as 'user' —
    and saving the dialog would then demote the person to one. */
export const EDITABLE_ROLES = ['user', 'sub_admin', 'task_owner', 'task_manager', 'inventory_manager'] as const
export type EditableRole = typeof EDITABLE_ROLES[number]

/** Split a roster into the two rendered groups, losing nobody. */
export function splitRoster<T extends { role: string }>(members: T[]): { leads: T[]; rest: T[] } {
  const isLead = (m: T) => (LEAD_ROLES as readonly string[]).includes(m.role)
  return { leads: members.filter(isLead), rest: members.filter(m => !isLead(m)) }
}

/** The role the edit dialog should open on for an existing member. */
export function editableRole(role: string): EditableRole {
  return (EDITABLE_ROLES as readonly string[]).includes(role) ? role as EditableRole : 'user'
}
