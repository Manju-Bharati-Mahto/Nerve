import { Navigate, useLocation } from 'react-router-dom'
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
  const { pathname } = useLocation()

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
    const home = getRoleDashboard(role, userTeam, profile?.creator)
    /* Sending someone to the page that just refused them is an endless
       redirect, which the browser renders as a white screen. It happens
       whenever a role's own landing page is capability-gated and no
       capability was granted — an Inventory Manager with no BrandOps tabs
       ticked is exactly that, and the member dialog allows it on purpose.
       Say so instead of looping. */
    if (home === pathname) {
      return (
        <div className="min-h-screen flex items-center justify-center p-6">
          <div className="max-w-sm text-center space-y-2">
            <h1 className="text-sm font-semibold text-foreground">No modules yet</h1>
            <p className="text-sm text-muted-foreground">
              Your account is active, but no sections have been switched on for it yet.
              Ask your team admin to grant access.
            </p>
          </div>
        </div>
      )
    }
    return <Navigate to={home} replace />
  }

  return <>{children}</>
}
