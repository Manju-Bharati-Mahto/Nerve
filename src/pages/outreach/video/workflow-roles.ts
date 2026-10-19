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
import { useAuth } from '@/hooks/useAuth'
import { canUseTab, useOutreachAccess } from '@/lib/outreach-access'
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
 * Only a super admin creates an Admin — the same rule as canCreateManagedUser
 * on the server. Everyone else who administers outreach users is an outreach
 * manager (Account Tabs requirements: the outreach admins are the super admin
 * and the manager), capped below Admin.
 */
export function grantableVideoRoles(actorNerveRole: AppRole | null): VideoRole[] {
  if (actorNerveRole === 'super_admin') return ALL_VIDEO_ROLES
  return MANAGER_GRANTABLE_ROLES
}

/** Whether this actor may create or edit someone holding `target`. */
export function mayAssignVideoRole(actorNerveRole: AppRole | null, target: VideoRole): boolean {
  return grantableVideoRoles(actorNerveRole).includes(target)
}

/* ── Who may do what to a video ─────────────────────────────────────────────
   The PRD gives uploading to Editors and publishing to Publishers, with an
   Admin able to do either. The API enforces exactly that (requireRole in
   outreach-video/routes.ts). Several screens are nonetheless open to more
   roles than may act on them — a Manager watches the publishing queue, and
   reaches My Videos as the department's list — and those screens used to
   offer every button regardless, so a Manager filled in a whole upload form
   or a schedule only to be told "Your role cannot perform that action."
   These are the same lists as the API's, stated once for the UI, so a screen
   hides what its viewer cannot do instead of letting it fail. */

/** The workflow role the server reads a Nerve role as (videoRoleForNerveRole). */
export function videoRoleOf(nerveRole: AppRole | null): VideoRole | null {
  if (nerveRole === 'super_admin' || nerveRole === 'admin') return 'admin'
  if (nerveRole === 'outreach_manager') return 'manager'
  if (nerveRole === 'outreach_editor') return 'editor'
  if (nerveRole === 'outreach_publisher') return 'publisher'
  return null
}

/** Upload, edit a caption, submit for review, start a revision. */
export const UPLOAD_ROLES: VideoRole[] = ['editor', 'admin']
/** Schedule, mark as published, record live links. */
export const PUBLISH_ROLES: VideoRole[] = ['publisher', 'admin']

export function mayUploadVideos(nerveRole: AppRole | null): boolean {
  const role = videoRoleOf(nerveRole)
  return !!role && UPLOAD_ROLES.includes(role)
}

export function mayPublishVideos(nerveRole: AppRole | null): boolean {
  const role = videoRoleOf(nerveRole)
  return !!role && PUBLISH_ROLES.includes(role)
}

/**
 * The same decision as the API's allowedHere(): someone the outreach manager
 * has configured may act on a tab they hold at Edit; anyone else keeps the
 * role rule they always had (`legacy`). Only hides what would be refused.
 */
export function useVideoTabEdit(tabs: string | string[], legacy: boolean): boolean {
  const { access } = useOutreachAccess()
  if (!access?.configured) return legacy
  return (Array.isArray(tabs) ? tabs : [tabs]).some(t => canUseTab(access, t, 'edit'))
}

/** Whether this Nerve role reads as one of `roles` in the video workflow. */
export function hasVideoRole(nerveRole: AppRole | null, roles: VideoRole[]): boolean {
  const role = videoRoleOf(nerveRole)
  return !!role && roles.includes(role)
}

/** Upload, caption, submit, revise — My Videos at Edit, or the Editor / Admin role. */
export function useMayUploadVideos(): boolean {
  const { role } = useAuth()
  return useVideoTabEdit('my_videos', mayUploadVideos(role))
}

/** Schedule and mark published — Publishing Queue at Edit, or the Publisher / Admin role. */
export function useMayPublishVideos(): boolean {
  const { role } = useAuth()
  return useVideoTabEdit('queue', mayPublishVideos(role))
}
