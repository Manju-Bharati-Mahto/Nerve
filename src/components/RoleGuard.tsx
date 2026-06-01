import { Navigate } from 'react-router-dom'
import { useAuth, getRoleDashboard } from '@/hooks/useAuth'
import type { AppRole } from '@/lib/constants'

interface RoleGuardProps {
  allowed: AppRole[]
  team?: string           // if set, user must belong to this team (super_admin bypasses)
  excludeTeam?: string    // if set, users on this team are redirected (super_admin bypasses)
  // Optional escape hatch: if the user's role isn't in `allowed`, this list of
  // capability keys is checked against their grants. Any match unlocks access.
  // The team constraint still applies — capability-only access requires the
  // user to belong to the specified team (or be super_admin).
  anyCapability?: string[]
  children: React.ReactNode
}

export default function RoleGuard({ allowed, team, excludeTeam, anyCapability, children }: RoleGuardProps) {
  const { role, team: userTeam, profile, loading } = useAuth()

  if (loading) return null

  const roleOk = role && allowed.includes(role)
  const teamOk = !team || role === 'super_admin' || userTeam === team
  const notExcluded = !excludeTeam || role === 'super_admin' || userTeam !== excludeTeam
  const capOk = !!anyCapability && anyCapability.length > 0
    && (profile?.capabilities ?? []).some(k => anyCapability.includes(k))

  // Allow access if (role+team OK) OR (team OK AND capability match).
  const access = (roleOk && teamOk && notExcluded) || (capOk && teamOk && notExcluded)

  if (!access) {
    return <Navigate to={getRoleDashboard(role, userTeam)} replace />
  }

  return <>{children}</>
}
