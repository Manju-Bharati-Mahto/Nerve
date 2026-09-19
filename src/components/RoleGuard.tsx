import { Navigate } from 'react-router-dom'
import { useAuth, getRoleDashboard } from '@/hooks/useAuth'
import { isActiveCreator } from '@/lib/creator-access'
import type { AppRole } from '@/lib/constants'

interface RoleGuardProps {
  allowed: AppRole[]
  // if set, user must belong to this team — or one of them (super_admin bypasses)
  team?: string | string[]
  excludeTeam?: string    // if set, users on this team are redirected (super_admin bypasses)
  // Optional escape hatch: if the user's role isn't in `allowed`, this list of
  // capability keys is checked against their grants. Any match unlocks access.
  // The team constraint still applies — capability-only access requires the
  // user to belong to the specified team (or be super_admin).
  anyCapability?: string[]
  // An active Creator Network member satisfies this guard on their own. Set
  // ONLY on /media, which hosts the Creator Network: a creator's Nerve team is
  // 'creator', so the ['media','smc'] team constraint would otherwise refuse
  // them and send them back to a Knowledge Hub page that also refuses them.
  // This admits them to the SHELL and nothing else — the Media Ops app loads
  // the creator-scoped state, and every endpoint behind it re-checks standing
  // server-side. It is not a capability and grants no Media Ops data.
  allowActiveCreator?: boolean
  children: React.ReactNode
}

export default function RoleGuard({ allowed, team, excludeTeam, anyCapability, allowActiveCreator, children }: RoleGuardProps) {
  const { role, team: userTeam, profile, loading } = useAuth()

  if (loading) return null

  const creatorOk = !!allowActiveCreator && isActiveCreator(profile?.creator)

  const roleOk = role && allowed.includes(role)
  const teams = team == null ? null : (Array.isArray(team) ? team : [team])
  const teamOk = !teams || role === 'super_admin' || (!!userTeam && teams.includes(userTeam))
  const notExcluded = !excludeTeam || role === 'super_admin' || userTeam !== excludeTeam
  const capOk = !!anyCapability && anyCapability.length > 0
    && (profile?.capabilities ?? []).some(k => anyCapability.includes(k))

  // Allow access if (role+team OK) OR (team OK AND capability match) OR the
  // caller is an active creator on a route that admits them. Every branch is
  // still subject to excludeTeam — creator standing is a way past the TEAM
  // allowlist, never past a deliberate exclusion.
  const access = ((roleOk && teamOk) || (capOk && teamOk) || creatorOk) && notExcluded

  if (!access) {
    return <Navigate to={getRoleDashboard(role, userTeam, profile?.creator)} replace />
  }

  return <>{children}</>
}
