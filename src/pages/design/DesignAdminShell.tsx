/**
 * Shared chrome (sidebar + top header) for every page a design-admin
 * accesses — Daily Reports / KRA / Leaves / Categories live inside
 * DesignAdminDashboard, and the WORKSPACE routes (Design Gallery,
 * Team Members, Export Data) wrap themselves with this shell so the
 * green-themed sidebar persists across them.
 */
import { useState, useEffect, useMemo } from 'react'
import { Link, useLocation } from 'react-router-dom'
import {
  BarChart2, Award, CalendarOff, CalendarDays, Settings2, FolderPlus,
  Search, Users, Download, LogOut, User as UserIcon, Bell, X, ArrowLeft, Paintbrush,
} from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'
import { designApi } from '@/lib/design-api'
import { MONTHS } from '@/lib/design-types'
import ProfileModal from '@/components/ProfileModal'
import BrandLogo from '@/components/BrandLogo'
import { L, cx } from '@/pages/branding/ds2'
import ThemeModal, { ModeToggle } from '@/pages/branding/ThemeModal'

type NavLink = {
  path: string
  label: string
  icon: React.ElementType
  // `adminOnly` items are hidden from `design_reports_admin` (which has a
  // narrower scope than full admin).
  adminOnly?: boolean
  // `requiresCapability` items are hidden unless the user has at least one of
  // the listed capabilities OR is a full admin / reports admin / super admin.
  // Used so non-admin users (role 'user' / 'sub_admin') who land in this
  // shell after being granted a specific capability still see only the tabs
  // their grant unlocks — not the rest of the admin chrome.
  requiresCapability?: string[]
}

const MENU: NavLink[] = [
  { path: '/design/dashboard',  label: 'Daily Reports',     icon: BarChart2,    requiresCapability: ['design:view_team_dashboard'] },
  { path: '/design/kra',        label: 'KRA Management',    icon: Award,        adminOnly: true },
  { path: '/design/leaves',     label: 'Leave Requests',    icon: CalendarOff,  adminOnly: true },
  { path: '/design/leave-calendar', label: 'Leave Calendar', icon: CalendarDays, adminOnly: true, requiresCapability: ['design:leave_calendar'] },
  { path: '/design/categories', label: 'Manage Categories', icon: Settings2,    requiresCapability: ['design:manage_categories'] },
  { path: '/design/projects',   label: 'Assign Projects',   icon: FolderPlus,   requiresCapability: ['design:assign_projects'] },
]

const WORKSPACE: NavLink[] = [
  { path: '/design/browse', label: 'Design Gallery', icon: Search },
  { path: '/design/team',   label: 'Team Members',   icon: Users, adminOnly: true },
  { path: '/admin/export',    label: 'Export Data',    icon: Download, adminOnly: true },
]

export default function DesignAdminShell({ children }: { children: React.ReactNode }) {
  const { profile, role, signOut } = useAuth()
  const location = useLocation()
  const [profileOpen, setProfileOpen] = useState(false)

  const isFullAdmin = role === 'super_admin' || role === 'admin' || role === 'design_reports_admin'
  const isReportsAdmin = role === 'design_reports_admin'
  // Capability-only access: a regular user (or sub_admin) granted access to
  // a specific admin feature. The shell renders, but the sidebar is filtered
  // to only the tabs they can actually use.
  const userCaps = profile?.capabilities ?? []
  // Task owners are leads with built-in project-assign rights — they always see
  // the Assign Projects tab even without an explicit capability grant.
  const isTaskOwner = role === 'task_owner' || role === 'task_manager'
  const canSee = (item: NavLink): boolean => {
    if (isFullAdmin) {
      // Full admins see everything except the items reserved for higher-tier
      // admin (currently `adminOnly` excludes reports-admin).
      return !item.adminOnly || !isReportsAdmin
    }
    if (isTaskOwner && item.requiresCapability?.includes('design:assign_projects')) return true
    // Non-admin: only show items unlocked by an explicit capability grant.
    return !!item.requiresCapability?.some(c => userCaps.includes(c))
  }

  const roleLabel = isReportsAdmin ? 'Reports Admin' : isFullAdmin ? 'Admin' : 'Granted access'
  const visibleMenu = MENU.filter(canSee)
  const visibleWorkspace = WORKSPACE.filter(canSee)
  const isActive = (p: string) => location.pathname === p

  return (
    <div className="nerve-light -mx-6 -mt-8 -mb-8 flex bg-white h-screen overflow-hidden">
      {/* ── Left Sidebar ──────────────────────────────────────────── */}
      <aside className="w-56 bg-[#F3F4F6] border-r border-[#C5CAD1] flex flex-col shrink-0 h-full overflow-y-auto">
        {/* Logo */}
        <div className="h-12 shrink-0 flex items-center px-4 border-b border-[#C5CAD1]">
          <BrandLogo variant="nerve" className="w-[150px] max-w-full" />
        </div>

        <nav className="flex-1 px-3 pb-4 overflow-y-auto">
          {/* For capability-only users (not full admins) surface a back-link
             so they can return to their own dashboard without typing a URL. */}
          {!isFullAdmin && (
            <Link to="/design/user" className={cx(L.nav, L.navOff, 'mt-3 mb-1')}>
              <ArrowLeft className={L.navIcon} strokeWidth={1.75} /> Back to my dashboard
            </Link>
          )}
          <div className={L.navGroup}>Menu</div>
          <div className="space-y-0.5">
            {visibleMenu.map(item => (
              <NavLinkButton key={item.path} item={item} active={isActive(item.path)} />
            ))}
          </div>

          {visibleWorkspace.length > 0 && (
            <>
              <div className={L.navGroup}>Workspace</div>
              <div className="space-y-0.5">
                {visibleWorkspace.map(item => (
                  <NavLinkButton key={item.path} item={item} active={isActive(item.path)} />
                ))}
              </div>
            </>
          )}

          <div className={L.navGroup}>Account</div>
          <div className="space-y-0.5">
            <button onClick={() => setProfileOpen(true)} className={cx(L.nav, L.navOff)}>
              <UserIcon className={L.navIcon} strokeWidth={1.75} /> My Profile
            </button>
            <button onClick={() => { void signOut?.() }} className={cx(L.nav, L.navOff)}>
              <LogOut className={L.navIcon} strokeWidth={1.75} /> Logout
            </button>
          </div>
        </nav>

        <div className="mx-3 mb-4 p-3 rounded-[6px] bg-white border border-[#C5CAD1]">
          <p className="text-[12px] font-semibold text-[#111827] leading-tight">Design {isReportsAdmin ? 'Reports Admin' : 'Admin'}</p>
          <p className="text-[11px] text-[#6B7280] mt-1 leading-snug">Review reports, scores and team activity.</p>
        </div>
      </aside>

      {/* ── Main Area ─────────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col min-w-0 h-full overflow-hidden bg-white">
        <AdminTopHeader profile={profile} roleLabel={roleLabel} onOpenProfile={() => setProfileOpen(true)} />
        <main className="flex-1 overflow-y-auto bg-[#F9FAFB] p-6 space-y-5">
          {children}
        </main>
      </div>

      <ProfileModal open={profileOpen} onClose={() => setProfileOpen(false)} />
    </div>
  )
}

// ── Sidebar nav link (Link + active glassy gradient style) ──────────────

function NavLinkButton({ item, active }: { item: NavLink; active: boolean }) {
  const Icon = item.icon
  return (
    <Link to={item.path} className={cx(L.nav, active ? L.navOn : L.navOff)} aria-current={active ? 'page' : undefined}>
      <Icon className={active ? L.navIconOn : L.navIcon} strokeWidth={1.75} />
      <span className="flex-1 truncate">{item.label}</span>
    </Link>
  )
}

// ── Top Header (search + notifications + profile) ───────────────────────

function AdminTopHeader({
  profile, roleLabel, onOpenProfile,
}: {
  profile: ReturnType<typeof useAuth>['profile']
  roleLabel: string
  onOpenProfile: () => void
}) {
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [notifOpen, setNotifOpen] = useState(false)
  const [themeOpen, setThemeOpen] = useState(false)
  const [leaveCount, setLeaveCount] = useState(0)

  useEffect(() => {
    designApi.getLeaves('pending').then(r => setLeaveCount(r.leaves.length)).catch(() => {})
  }, [])

  // useMemo so `now` is stable across renders and the deps array below
  // doesn't churn every tick (otherwise eslint flags the missing dep).
  const now = useMemo(() => new Date(), [])
  const appraisalDue = now.getDate() >= 20
  const notifications = useMemo(() => {
    const items: { id: string; title: string; body: string; type: 'warning' | 'info' | 'success' }[] = []
    if (leaveCount > 0) items.push({
      id: 'leaves', title: `${leaveCount} Leave Request${leaveCount === 1 ? '' : 's'} Pending`,
      body: 'Review in Leave Requests', type: 'warning',
    })
    if (appraisalDue) items.push({
      id: 'appraisal', title: 'KRA Appraisal Window Open',
      body: `Publish ${MONTHS[now.getMonth()]} ${now.getFullYear()} scores`, type: 'info',
    })
    if (items.length === 0) items.push({
      id: 'all-clear', title: 'All Clear', body: 'No pending items right now.', type: 'success',
    })
    return items
  }, [leaveCount, appraisalDue, now])

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { setSearchOpen(false); setNotifOpen(false); setSearchQuery('') }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault(); setSearchOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <>
      <header className="h-12 shrink-0 bg-white border-b border-[#C5CAD1] px-4 sm:px-6 flex items-center gap-3 sticky top-0 z-20">
        <button onClick={() => setSearchOpen(true)}
          className="flex-1 max-w-xs flex items-center gap-2 bg-[#F9FAFB] border border-[#C5CAD1] rounded-[6px] h-8 px-3 text-[13px] text-[#9CA3AF] hover:border-[#9CA3AF] transition-colors text-left">
          <Search className="w-3.5 h-3.5 shrink-0" />
          <span>Search reports, projects…</span>
          <span className="ml-auto text-[10px] text-[#9CA3AF] bg-white border border-[#C5CAD1] rounded px-1 py-0.5">⌘F</span>
        </button>

        <div className="ml-auto flex items-center gap-0.5">
          <div className="relative">
            <button onClick={() => setNotifOpen(o => !o)} className={cx(L.iconGhost, 'relative')} aria-label="Notifications">
              <Bell className="w-4 h-4" strokeWidth={1.75} />
              {(leaveCount > 0 || appraisalDue) && (
                <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 rounded-full text-[9px] font-semibold text-[var(--nerve-on-primary)] bg-[var(--nerve-primary)] flex items-center justify-center">
                  {leaveCount + (appraisalDue ? 1 : 0)}
                </span>
              )}
            </button>
            {notifOpen && (
              <div className="absolute right-0 top-11 w-80 bg-white rounded-[8px] shadow-[0_24px_48px_-12px_rgba(16,24,40,0.25)] border border-[#C5CAD1] z-50 overflow-hidden">
                <div className="flex items-center justify-between px-4 py-3 border-b border-[#C5CAD1]">
                  <p className="text-[13px] font-semibold text-[#111827]">Notifications</p>
                  <button onClick={() => setNotifOpen(false)} className="text-[#9CA3AF] hover:text-[#111827]"><X className="w-3.5 h-3.5" /></button>
                </div>
                <div className="divide-y divide-[#F3F4F6] max-h-72 overflow-y-auto">
                  {notifications.map(n => (
                    <div key={n.id} className="flex items-start gap-3 px-4 py-3 hover:bg-[#F9FAFB] transition-colors">
                      <div className={`w-2 h-2 rounded-full mt-1.5 shrink-0 ${n.type === 'warning' ? 'bg-amber-400' : n.type === 'success' ? 'bg-green-500' : 'bg-[var(--nerve-primary)]'}`} />
                      <div>
                        <p className="text-[13px] font-medium text-[#111827]">{n.title}</p>
                        <p className="text-[12px] text-[#6B7280] mt-0.5">{n.body}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          <ModeToggle />
          <button type="button" onClick={() => setThemeOpen(true)}
            className={cx(L.iconGhost, themeOpen && 'bg-[#F3F4F6] text-[#111827]')}
            aria-label="Appearance" title="Appearance · colour mode and primary colour">
            <Paintbrush className="w-4 h-4" strokeWidth={1.75} />
          </button>

          <button onClick={onOpenProfile} className="flex items-center gap-2 ml-1 hover:opacity-80 transition-opacity">
            {profile?.avatar_url ? (
              <img src={profile.avatar_url} alt={profile.full_name || 'avatar'}
                className="w-7 h-7 rounded-[6px] object-cover shrink-0" />
            ) : (
              <div className="w-7 h-7 rounded-[6px] bg-[var(--nerve-primary-soft)] border border-[var(--nerve-primary-soft-border)] flex items-center justify-center text-[var(--nerve-primary-text)] text-[12px] font-semibold uppercase shrink-0">
                {profile?.full_name?.charAt(0) || profile?.email?.charAt(0) || 'U'}
              </div>
            )}
            <div className="hidden sm:block text-left">
              <p className="text-[13px] font-semibold text-[#111827] leading-tight">{profile?.full_name || 'Admin'}</p>
              <p className="text-[11px] text-[#6B7280] leading-tight">{roleLabel}</p>
            </div>
          </button>
        </div>
      </header>

      {themeOpen && <ThemeModal onClose={() => setThemeOpen(false)} />}

      {searchOpen && (
        <div className="fixed inset-0 bg-black/30 z-50 flex items-start justify-center pt-20 px-4"
          onClick={() => { setSearchOpen(false); setSearchQuery('') }}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-xl overflow-hidden" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-3 px-4 py-3.5 border-b border-gray-100">
              <Search className="w-4 h-4 text-gray-400 shrink-0" />
              <input autoFocus value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
                placeholder="Search reports, projects, work types…"
                className="flex-1 bg-transparent text-sm outline-none placeholder:text-gray-400" />
              <button onClick={() => { setSearchOpen(false); setSearchQuery('') }}
                className="text-gray-400 hover:text-gray-600"><X className="w-4 h-4" /></button>
            </div>
            <div className="px-4 py-8 text-center text-xs text-gray-400">
              {searchQuery
                ? 'Search across all team reports — coming soon.'
                : 'Start typing to search. Press Esc to close.'}
            </div>
          </div>
        </div>
      )}
    </>
  )
}

// ── Convenience: conditionally wrap a child with the shell when the
// current user is a design admin. Used by the route-level wrappers
// for /design/browse, /design/team, /admin/export so non-admin roles
// (super_admin viewing the page, content team viewing /admin/export)
// don't accidentally pick up design chrome.

export function MaybeDesignAdminShell({ children }: { children: React.ReactNode }) {
  const { role, team } = useAuth()
  const isDesignAdmin = team === 'design' && (role === 'admin' || role === 'design_reports_admin')
  if (isDesignAdmin) return <DesignAdminShell>{children}</DesignAdminShell>
  return <>{children}</>
}
