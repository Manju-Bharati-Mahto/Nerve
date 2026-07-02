/**
 * Shared chrome (sidebar + top header) for every page a branding-admin
 * accesses — Daily Reports / KRA / Leaves / Categories live inside
 * BrandingAdminDashboard, and the WORKSPACE routes (Design Gallery,
 * Team Members, Export Data) wrap themselves with this shell so the
 * green-themed sidebar persists across them.
 */
import { useState, useEffect, useMemo } from 'react'
import { Link, useLocation } from 'react-router-dom'
import {
  Palette, BarChart2, Award, CalendarOff, CalendarDays, Settings2, FolderPlus,
  Search, Users, Download, LogOut, User as UserIcon, Bell, X, ArrowLeft,
} from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'
import { brandingApi } from '@/lib/branding-api'
import { MONTHS } from '@/lib/branding-types'
import ProfileModal from '@/components/ProfileModal'

type NavLink = {
  path: string
  label: string
  icon: React.ElementType
  // `adminOnly` items are hidden from `branding_reports_admin` (which has a
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
  { path: '/branding/dashboard',  label: 'Daily Reports',     icon: BarChart2,    requiresCapability: ['branding:view_team_dashboard'] },
  { path: '/branding/kra',        label: 'KRA Management',    icon: Award,        adminOnly: true },
  { path: '/branding/leaves',     label: 'Leave Requests',    icon: CalendarOff,  adminOnly: true },
  { path: '/branding/leave-calendar', label: 'Leave Calendar', icon: CalendarDays, adminOnly: true },
  { path: '/branding/categories', label: 'Manage Categories', icon: Settings2,    requiresCapability: ['branding:manage_categories'] },
  { path: '/branding/projects',   label: 'Assign Projects',   icon: FolderPlus,   requiresCapability: ['branding:assign_projects'] },
]

const WORKSPACE: NavLink[] = [
  { path: '/branding/browse', label: 'Design Gallery', icon: Search },
  { path: '/branding/team',   label: 'Team Members',   icon: Users, adminOnly: true },
  { path: '/admin/export',    label: 'Export Data',    icon: Download, adminOnly: true },
]

export default function BrandingAdminShell({ children }: { children: React.ReactNode }) {
  const { profile, role, signOut } = useAuth()
  const location = useLocation()
  const [profileOpen, setProfileOpen] = useState(false)

  const isFullAdmin = role === 'super_admin' || role === 'admin' || role === 'branding_reports_admin'
  const isReportsAdmin = role === 'branding_reports_admin'
  // Capability-only access: a regular user (or sub_admin) granted access to
  // a specific admin feature. The shell renders, but the sidebar is filtered
  // to only the tabs they can actually use.
  const userCaps = profile?.capabilities ?? []
  // Task owners are leads with built-in project-assign rights — they always see
  // the Assign Projects tab even without an explicit capability grant.
  const isTaskOwner = role === 'task_owner'
  const canSee = (item: NavLink): boolean => {
    if (isFullAdmin) {
      // Full admins see everything except the items reserved for higher-tier
      // admin (currently `adminOnly` excludes reports-admin).
      return !item.adminOnly || !isReportsAdmin
    }
    if (isTaskOwner && item.requiresCapability?.includes('branding:assign_projects')) return true
    // Non-admin: only show items unlocked by an explicit capability grant.
    return !!item.requiresCapability?.some(c => userCaps.includes(c))
  }

  const roleLabel = isReportsAdmin ? 'Reports Admin' : isFullAdmin ? 'Admin' : 'Granted access'
  const visibleMenu = MENU.filter(canSee)
  const visibleWorkspace = WORKSPACE.filter(canSee)
  const isActive = (p: string) => location.pathname === p

  return (
    <div className="-mx-6 -mt-8 -mb-8 flex bg-[#f4f7f4] h-screen overflow-hidden">
      {/* ── Left Sidebar ──────────────────────────────────────────── */}
      <aside className="w-52 bg-white border-r border-gray-100 flex flex-col shrink-0 h-full overflow-y-auto">
        {/* Logo */}
        <div className="px-5 pt-6 pb-4 border-b border-gray-50">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl flex items-center justify-center" style={{ background: '#1a472a' }}>
              <Palette className="w-4 h-4 text-white" />
            </div>
            <span className="font-bold text-[16px] text-gray-800 tracking-tight">Nerve</span>
          </div>
        </div>

        <nav className="flex-1 px-3 py-4 space-y-0.5">
          {/* For capability-only users (not full admins) surface a back-link
             so they can return to their own dashboard without typing a URL. */}
          {!isFullAdmin && (
            <Link
              to="/branding/user"
              className="w-full flex items-center gap-2.5 px-3 py-2 mb-3 rounded-xl text-[12px] font-semibold text-gray-500 hover:bg-gray-50 hover:text-gray-700 transition-colors"
            >
              <ArrowLeft className="w-3.5 h-3.5 shrink-0" /> Back to my dashboard
            </Link>
          )}
          <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest px-3 mb-2">Menu</p>
          {visibleMenu.map(item => (
            <NavLinkButton key={item.path} item={item} active={isActive(item.path)} />
          ))}

          {visibleWorkspace.length > 0 && (
            <div className="pt-4">
              <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest px-3 mb-2">Workspace</p>
              {visibleWorkspace.map(item => (
                <NavLinkButton key={item.path} item={item} active={isActive(item.path)} />
              ))}
            </div>
          )}

          <div className="pt-4">
            <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest px-3 mb-2">Account</p>
            <button onClick={() => setProfileOpen(true)}
              className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-[13px] font-medium text-gray-500 hover:bg-gray-50 hover:text-gray-700 text-left transition-colors">
              <UserIcon className="w-4 h-4 shrink-0" /> My Profile
            </button>
            <button onClick={() => { void signOut?.() }}
              className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-[13px] font-medium text-gray-500 hover:bg-red-50 hover:text-red-600 text-left transition-colors">
              <LogOut className="w-4 h-4 shrink-0" /> Logout
            </button>
          </div>
        </nav>

        <div className="mx-3 mb-4 p-4 rounded-2xl text-white" style={{ background: 'linear-gradient(135deg, #1a472a 0%, #2d6a4f 100%)' }}>
          <p className="text-[12px] font-bold leading-tight">Branding {isReportsAdmin ? 'Reports Admin' : 'Admin'}</p>
          <p className="text-[11px] opacity-70 mt-1 leading-snug">Review reports, scores and team activity.</p>
        </div>
      </aside>

      {/* ── Main Area ─────────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col min-w-0 h-full overflow-hidden">
        <AdminTopHeader profile={profile} roleLabel={roleLabel} onOpenProfile={() => setProfileOpen(true)} />
        <main className="flex-1 overflow-y-auto p-6 space-y-5">
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
    <Link to={item.path}
      className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-[13px] font-semibold transition-all text-left relative ${
        active ? 'text-[#1a472a]' : 'text-gray-500 hover:bg-gray-50 hover:text-gray-700'
      }`}
      style={active ? {
        border: '1.5px solid #1a472a',
        background: 'linear-gradient(135deg, rgba(255,255,255,0.72) 0%, rgba(210,240,220,0.55) 100%)',
        backdropFilter: 'blur(10px)',
        WebkitBackdropFilter: 'blur(10px)',
        boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.9), 0 2px 8px rgba(26,71,42,0.10)',
      } : {}}>
      <Icon className="w-4 h-4 shrink-0" />
      {item.label}
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
  const [leaveCount, setLeaveCount] = useState(0)

  useEffect(() => {
    brandingApi.getLeaves('pending').then(r => setLeaveCount(r.leaves.length)).catch(() => {})
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
      <header className="bg-white border-b border-gray-100 px-6 py-3.5 flex items-center gap-4 sticky top-0 z-20 shrink-0">
        <button onClick={() => setSearchOpen(true)}
          className="flex-1 max-w-xs flex items-center gap-2 bg-gray-50 border border-gray-100 rounded-xl px-3 py-2 text-sm text-gray-400 hover:border-green-300 transition-colors text-left">
          <Search className="w-3.5 h-3.5 shrink-0" />
          <span>Search reports, projects…</span>
          <span className="ml-auto text-[10px] text-gray-300 bg-white border border-gray-100 rounded px-1 py-0.5">⌘F</span>
        </button>

        <div className="ml-auto flex items-center gap-3">
          <div className="relative">
            <button onClick={() => setNotifOpen(o => !o)}
              className="w-9 h-9 rounded-full bg-gray-50 border border-gray-100 flex items-center justify-center text-gray-400 hover:bg-gray-100 transition-colors relative">
              <Bell className="w-4 h-4" />
              {(leaveCount > 0 || appraisalDue) && (
                <span className="absolute -top-0.5 -right-0.5 w-4 h-4 rounded-full text-[9px] font-bold text-white flex items-center justify-center" style={{ background: '#1a472a' }}>
                  {leaveCount + (appraisalDue ? 1 : 0)}
                </span>
              )}
            </button>
            {notifOpen && (
              <div className="absolute right-0 top-11 w-80 bg-white rounded-2xl shadow-xl border border-gray-100 z-50 overflow-hidden">
                <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
                  <p className="text-sm font-semibold text-gray-800">Notifications</p>
                  <button onClick={() => setNotifOpen(false)} className="text-gray-400 hover:text-gray-600"><X className="w-3.5 h-3.5" /></button>
                </div>
                <div className="divide-y divide-gray-50 max-h-72 overflow-y-auto">
                  {notifications.map(n => (
                    <div key={n.id} className="flex items-start gap-3 px-4 py-3 hover:bg-gray-50 transition-colors">
                      <div className={`w-2 h-2 rounded-full mt-1.5 shrink-0 ${n.type === 'warning' ? 'bg-amber-400' : n.type === 'success' ? 'bg-green-500' : 'bg-blue-400'}`} />
                      <div>
                        <p className="text-sm font-medium text-gray-800">{n.title}</p>
                        <p className="text-xs text-gray-400 mt-0.5">{n.body}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          <button onClick={onOpenProfile}
            className="flex items-center gap-2.5 hover:opacity-80 transition-opacity">
            {profile?.avatar_url ? (
              <img src={profile.avatar_url} alt={profile.full_name || 'avatar'}
                className="w-9 h-9 rounded-full object-cover shrink-0 ring-2 ring-green-100" />
            ) : (
              <div className="w-9 h-9 rounded-full bg-green-100 flex items-center justify-center text-green-800 text-sm font-bold uppercase shrink-0">
                {profile?.full_name?.charAt(0) || profile?.email?.charAt(0) || 'U'}
              </div>
            )}
            <div className="hidden sm:block text-left">
              <p className="text-[13px] font-semibold text-gray-800 leading-tight">{profile?.full_name || 'Admin'}</p>
              <p className="text-[11px] text-gray-400 leading-tight">{roleLabel}</p>
            </div>
          </button>
        </div>
      </header>

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
// current user is a branding admin. Used by the route-level wrappers
// for /branding/browse, /branding/team, /admin/export so non-admin roles
// (super_admin viewing the page, content team viewing /admin/export)
// don't accidentally pick up branding chrome.

export function MaybeBrandingAdminShell({ children }: { children: React.ReactNode }) {
  const { role, team } = useAuth()
  const isBrandingAdmin = team === 'branding' && (role === 'admin' || role === 'branding_reports_admin')
  if (isBrandingAdmin) return <BrandingAdminShell>{children}</BrandingAdminShell>
  return <>{children}</>
}
