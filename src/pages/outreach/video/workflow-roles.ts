/* ═══════════════════════════════════════════════════════════════════════════
   Who the outreach administrator may create, and what that means in Nerve.

   Two separate facts live here, and keeping them together is the point:

   1. A workflow role (Editor / Publisher / Manager / Admin) is what the video
      module talks about. A Nerve role is what the person signs in as. The
      module derives the first from the second at request time
      (`videoRoleForNerveRole` on the server), so creating an account means
      choosing the NERVE role that will produce the workflow role the
      administrator picked. Get that mapping wrong and the account signs in as
      the wrong thing — or as nothing at all.

   2. A Manager administers the outreach team but cannot mint an Admin. That
      ceiling is enforced on the server in two places (`canCreateManagedUser`
      in server/index.ts and `managerMayActOn` in outreach-video/routes.ts);
      this is the same rule stated once for the UI, so the dialog never offers
      a choice the API will refuse.
   ═══════════════════════════════════════════════════════════════════════════ */
import type { AppRole } from '@/lib/constants'
import type { VideoRole } from '@/lib/outreach-video-data'

/**
 * The Nerve role that makes someone each workflow role.
 *
 * Must stay the inverse of `videoRoleForNerveRole()` on the server. An Admin is
 * the one asymmetric case: the workflow reads both `super_admin` and `admin` as
 * Admin, and `admin` is the one an administrator can actually create.
 */
export const NERVE_ROLE_FOR_VIDEO_ROLE: Record<VideoRole, AppRole> = {
  admin: 'admin',
  manager: 'outreach_manager',
  editor: 'outreach_editor',
  publisher: 'outreach_publisher',
}

/** Roles a Manager may hand out — everything except Admin. */
export const MANAGER_GRANTABLE_ROLES: VideoRole[] = ['editor', 'publisher', 'manager']

/** Every role, for an Admin or super admin. */
export const ALL_VIDEO_ROLES: VideoRole[] = ['admin', 'manager', 'editor', 'publisher']

/**
 * The roles this actor may create or assign.
 *
 * A Manager is capped below Admin. Anyone else who reaches the administration
 * tab at all is an Admin or super admin, so they get the full set.
 */
export function grantableVideoRoles(actorNerveRole: AppRole | null): VideoRole[] {
  if (actorNerveRole === 'outreach_manager') return MANAGER_GRANTABLE_ROLES
  return ALL_VIDEO_ROLES
}

/** Whether this actor may create or edit someone holding `target`. */
export function mayAssignVideoRole(actorNerveRole: AppRole | null, target: VideoRole): boolean {
  return grantableVideoRoles(actorNerveRole).includes(target)
}
