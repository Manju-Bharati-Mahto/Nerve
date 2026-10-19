import { Navigate } from 'react-router-dom'
import RoleGuard from '@/components/RoleGuard'
import type { AppRole } from '@/lib/constants'
import { canUseTab, firstOpenTab, useOutreachAccess } from '@/lib/outreach-access'

/**
 * The page guard for every outreach route (Account Tabs requirements §1).
 *
 * A person an admin has configured opens exactly the tabs ticked for them —
 * `tab` names the one this route belongs to (a detail page can belong to
 * several: a video opens from any tab that lists videos). Everybody else — an
 * outreach admin, or someone not yet configured — goes through the RoleGuard
 * this route always had, with the same roles and grants, so their access is
 * exactly what it was.
 *
 * A configured person who reaches a tab they were not given is taken to the
 * first tab they do have, rather than bounced around; with none at all they
 * are told so. The server refuses the data either way.
 */
export default function OutreachTabGuard({ tab, allowed, anyCapability, children }: {
  tab: string | string[]
  allowed: AppRole[]
  anyCapability?: string[]
  children: React.ReactNode
}) {
  const { access, loading } = useOutreachAccess()
  if (loading) return null

  if (access?.configured) {
    const tabs = Array.isArray(tab) ? tab : [tab]
    if (tabs.some(t => canUseTab(access, t))) return <>{children}</>
    const first = firstOpenTab(access)
    if (first) return <Navigate to={first} replace />
    return <NoTabs />
  }

  return (
    <RoleGuard allowed={allowed} team="outreach" anyCapability={anyCapability}>
      {children}
    </RoleGuard>
  )
}

function NoTabs() {
  return (
    <div className="hub-card text-center py-12 max-w-lg mx-auto mt-10">
      <p className="text-sm font-medium text-foreground">No tabs have been given to you yet.</p>
      <p className="text-xs text-muted-foreground mt-1">Ask your outreach manager to choose which tabs you can see.</p>
    </div>
  )
}
