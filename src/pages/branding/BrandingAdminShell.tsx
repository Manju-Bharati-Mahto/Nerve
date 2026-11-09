/**
 * Shared chrome for every branding page that is not the user dashboard —
 * Daily Reports / KRA / Leaves / Leave Calendar / Categories inside
 * BrandingAdminDashboard, and the workspace routes (Assign Projects, Design
 * Gallery, Kanban Board, Team Members, Export Data).
 *
 * It is the same chrome BrandingUserDashboard draws for itself (Nerve Light,
 * ./ds2.tsx): a 224px grey sidebar with the lockup, grouped nav, a user card
 * at the bottom; a 48px white top bar with the breadcrumb, date, "Workspace
 * live", page actions, search, notifications, the paintbrush and the avatar
 * menu; and a grey canvas with the page title above the content. A lead who
 * steps from their own dashboard into the Kanban board, or an admin who moves
 * between Daily Reports and the gallery, never changes rooms.
 */
import { useState, useEffect, useMemo, type ReactNode } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import {
  BarChart2, Award, CalendarOff, CalendarDays, Settings2, FolderPlus,
  Search, Users, Download, LogOut, User as UserIcon, Bell, ArrowLeft, Menu,
  LayoutDashboard, ClipboardList, SquareKanban, Paintbrush, ChevronsUpDown,
  PanelLeftClose,
  // BrandOps nav icons (Inventory Manager workspace)
  Boxes, Radio, ArrowLeftRight, Undo2, IndianRupee, BadgeCheck, Hammer,
  LogIn, Camera, Package, Store, Building2, FileBarChart, History,
} from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'
import { brandingApi } from '@/lib/branding-api'
import { timeToHours } from '@/lib/branding-types'
import type { BrandingProject, DailyReport } from '@/lib/branding-types'
import BrandLogo from '@/components/BrandLogo'
import { DS, cx, Avatar, Badge } from './ds'
import { L } from './ds2'
import ThemeModal, { ModeToggle } from './ThemeModal'
import SettingsPage from './BrandingAccountPage'
import { NotificationPanel, useBrandingNotifications } from './BrandingNotifications'

// ── Navigation ────────────────────────────────────────────────────────────

type NavLink = {
  path: string
  label: string
  icon: React.ElementType
  // `adminOnly` items are hidden from `branding_reports_admin` (narrower
  // scope than full admin).
  adminOnly?: boolean
  // `requiresCapability` items are hidden unless the user has one of the
  // listed capabilities OR is a full admin / reports admin / super admin.
  requiresCapability?: string[]
  // `leadOk` items also show for team leads (sub_admin / task owner / task manager).
  leadOk?: boolean
}

const MENU: NavLink[] = [
  { path: '/branding/dashboard',      label: 'Daily Reports',     icon: BarChart2,    requiresCapability: ['branding:view_team_dashboard'] },
  { path: '/branding/kra',            label: 'KRA Management',    icon: Award,        adminOnly: true },
  { path: '/branding/leaves',         label: 'Leave Requests',    icon: CalendarOff,  adminOnly: true },
  { path: '/branding/leave-calendar', label: 'Leave Calendar',    icon: CalendarDays, adminOnly: true, requiresCapability: ['branding:leave_calendar'] },
  { path: '/branding/categories',     label: 'Manage Categories', icon: Settings2,    requiresCapability: ['branding:manage_categories'] },
  { path: '/branding/projects',       label: 'Assign Projects',   icon: FolderPlus,   requiresCapability: ['branding:assign_projects'] },
]

/**
 * BrandOps. Every entry is gated on its own capability, so an Inventory
 * Manager sees exactly the tabs their branding admin switched on, and a full
 * admin sees all sixteen. The same keys gate the API, so hiding a tab here is
 * never the only thing standing between a user and the data.
 */
const BRANDOPS: NavLink[] = [
  { path: '/branding/ops/dashboard',   label: 'Dashboard',         icon: LayoutDashboard, requiresCapability: ['brandops:dashboard'] },
  { path: '/branding/ops/frames',      label: 'Frame Inventory',   icon: Boxes,           requiresCapability: ['brandops:frame_inventory'] },
  { path: '/branding/ops/in-use',      label: 'In Use Frames',     icon: Radio,           requiresCapability: ['brandops:in_use'] },
  { path: '/branding/ops/allocate',    label: 'Allocate / Move',   icon: ArrowLeftRight,  requiresCapability: ['brandops:allocate'] },
  { path: '/branding/ops/return',      label: 'Frame Return',      icon: Undo2,           requiresCapability: ['brandops:frame_return'] },
  { path: '/branding/ops/requests',    label: 'Branding Requests', icon: ClipboardList,   requiresCapability: ['brandops:requests'] },
  { path: '/branding/ops/quotations',  label: 'Quotations',        icon: IndianRupee,     requiresCapability: ['brandops:quotations'] },
  { path: '/branding/ops/approvals',   label: 'Approvals',         icon: BadgeCheck,      requiresCapability: ['brandops:approvals'] },
  { path: '/branding/ops/work-orders', label: 'Work Orders',       icon: Hammer,          requiresCapability: ['brandops:work_orders'] },
  { path: '/branding/ops/visits',      label: 'Vendor Visits',     icon: LogIn,           requiresCapability: ['brandops:vendor_visits'] },
  { path: '/branding/ops/completion',  label: 'Work Completion',   icon: Camera,          requiresCapability: ['brandops:completion'] },
  { path: '/branding/ops/deliveries',  label: 'Material Delivery', icon: Package,         requiresCapability: ['brandops:material_delivery'] },
  { path: '/branding/ops/vendors',     label: 'Vendors',           icon: Store,           requiresCapability: ['brandops:vendors'] },
  { path: '/branding/ops/institutes',  label: 'Institutes',        icon: Building2,       requiresCapability: ['brandops:institutes'] },
  { path: '/branding/ops/reports',     label: 'Reports',           icon: FileBarChart,    requiresCapability: ['brandops:reports'] },
  { path: '/branding/ops/activity',    label: 'Activity Log',      icon: History,         requiresCapability: ['brandops:activity'] },
]

const WORKSPACE: NavLink[] = [
  { path: '/branding/browse',  label: 'Design Gallery', icon: Search },
  { path: '/branding/team',    label: 'Kanban Board',   icon: SquareKanban, leadOk: true },
  { path: '/branding/members', label: 'Team Members',   icon: Users,        leadOk: true },
  { path: '/admin/export',     label: 'Export Data',    icon: Download, adminOnly: true },
]

/** Breadcrumb title + subtitle for each route the shell can host. */
export const SHELL_PAGE_META: Record<string, { title: string; subtitle: string }> = {
  '/branding/dashboard':      { title: 'Daily Reports',     subtitle: 'Team activity, hours and collaboration at a glance.' },
  '/branding/kra':            { title: 'KRA Management',    subtitle: 'Self, peer and admin scoring with a final publish.' },
  '/branding/leaves':         { title: 'Leave Requests',    subtitle: 'Approve, reject and reassign team leaves.' },
  '/branding/leave-calendar': { title: 'Leave Calendar',    subtitle: 'Every leave request by day, submitted and approved.' },
  '/branding/categories':     { title: 'Manage Categories', subtitle: 'Work categories and sub-categories the team reports against.' },
  '/branding/projects':       { title: 'Assign Projects',   subtitle: 'Create a project and hand it to designers. It lands in their daily report.' },
  '/branding/browse':         { title: 'Design Gallery',    subtitle: 'Browse creative brand assets, templates and designs.' },
  '/branding/team':           { title: 'Kanban Board',      subtitle: 'Every lead\'s projects, by stage. Drag a card to move it along.' },
  '/branding/members':        { title: 'Team Members',      subtitle: 'Every lead\'s team at a glance. Tap a figure to open it.' },
  '/branding/members/manage': { title: 'Manage Members',    subtitle: 'People, roles, access and live reports across the branding team.' },
  '/branding/account':        { title: 'Account Settings',  subtitle: 'Manage your profile preferences and credentials' },
  '/branding/notifications':  { title: 'Notifications',     subtitle: 'Everything that needs your attention.' },
  '/admin/export':            { title: 'Export Data',       subtitle: 'Download reports and records as spreadsheets.' },
}

// ── Shell ─────────────────────────────────────────────────────────────────

export default function BrandingAdminShell({ children, title, subtitle, actions }: {
  children: ReactNode
  /** Override the route's default title / subtitle. */
  title?: ReactNode
  subtitle?: ReactNode
  /** Page-level buttons rendered on the right of the title row. */
  actions?: ReactNode
}) {
  const { profile, role, team, signOut } = useAuth()
  const location = useLocation()
  const navigate = useNavigate()
  const [themeOpen, setThemeOpen] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [notifOpen, setNotifOpen] = useState(false)

  const isFullAdmin = role === 'super_admin' || role === 'admin' || role === 'branding_reports_admin'
  const isReportsAdmin = role === 'branding_reports_admin'
  const userCaps = profile?.capabilities ?? []
  const isTaskOwner = role === 'task_owner' || role === 'task_manager'
  const notifState = useBrandingNotifications(isFullAdmin)
  const onNotificationsPage = location.pathname === '/branding/notifications'
  const onAccountPage = location.pathname === '/branding/account'
  const canSee = (item: NavLink): boolean => {
    if (isFullAdmin) return !item.adminOnly || !isReportsAdmin
    if (isTaskOwner && item.requiresCapability?.includes('branding:assign_projects')) return true
    return !!item.requiresCapability?.some(c => userCaps.includes(c))
  }

  // A full admin owns all of these pages; everyone else is passing through
  // from their own dashboard, which keeps the gallery and team directory.
  const visibleMenu = MENU.filter(canSee)
  const isLead = isTaskOwner || role === 'sub_admin'
  const visibleWorkspace = isFullAdmin
    ? WORKSPACE.filter(canSee)
    : WORKSPACE.filter(w => w.path === '/branding/browse' || (isLead && w.leadOk))
  // BrandOps tabs an Inventory Manager (or a full admin) may see. canSee already
  // returns everything for a full admin and capability-gated items otherwise.
  const visibleBrandOps = BRANDOPS.filter(canSee)

  const roleLabel = role === 'super_admin' ? 'Super Admin'
    : isReportsAdmin ? 'Reports Admin'
    : role === 'admin' ? 'Admin'
    : isTaskOwner ? 'Team Lead'
    : role === 'sub_admin' ? 'Team Lead'
    : role === 'inventory_manager' ? 'Inventory Manager'
    : 'Member'
  const isActive = (p: string) => location.pathname === p || (p === '/branding/members' && location.pathname.startsWith('/branding/members/'))
  const meta = SHELL_PAGE_META[location.pathname]
  const pageTitle = title ?? meta?.title ?? 'Dashboard'
  const pageSubtitle = subtitle ?? meta?.subtitle ?? ''

  // Branding members get a full-bleed canvas from AppLayout; anyone else
  // (a super admin, say) still has the global sidebar and page padding, so
  // the shell climbs out of that padding to fill the viewport.
  const fullBleed = team === 'branding' && location.pathname.startsWith('/branding/')

  const now = new Date()
  const headerDate = `${now.toLocaleDateString('en-GB', { weekday: 'long' })}, ${now.getDate()} ${now.toLocaleDateString('en-GB', { month: 'long' })} ${now.getFullYear()}`
  const dateChip = `${now.toLocaleDateString('en-GB', { weekday: 'short' })} ${now.getDate()} ${now.toLocaleDateString('en-GB', { month: 'short' })}`

  // Close the phone drawer whenever the route changes.
  useEffect(() => { setSidebarOpen(false); setNotifOpen(false) }, [location.pathname])

  const NavItem = ({ item }: { item: NavLink }) => {
    const Icon = item.icon
    const active = isActive(item.path)
    return (
      <Link to={item.path} onClick={() => setSidebarOpen(false)} className={cx(L.nav, active ? L.navOn : L.navOff)} aria-current={active ? 'page' : undefined}>
        <Icon className={active ? L.navIconOn : L.navIcon} strokeWidth={1.75} />
        <span className="truncate">{item.label}</span>
        {item.path === '/branding/leaves' && <PendingLeavesDot />}
      </Link>
    )
  }

  return (
    <div className={cx('nerve-light flex bg-white overflow-hidden', fullBleed ? 'h-full' : '-mx-6 -mt-8 -mb-8 h-visible-screen')}>
      {sidebarOpen && (
        <div className="md:hidden fixed inset-0 bg-[#111827]/30 z-40 nerve-overlay-in" onClick={() => setSidebarOpen(false)} aria-hidden="true" />
      )}

      {/* ── Sidebar ───────────────────────────────────────────────────── */}
      <aside
        className={cx(
          'w-56 bg-[#F3F4F6] border-r border-[#C5CAD1] flex flex-col h-full shrink-0 p-3',
          'fixed inset-y-0 z-50 transition-[left] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]',
          sidebarOpen ? 'left-0' : '-left-56',
          'md:static',
        )}
      >
        {/* Brand */}
        <div className="relative shrink-0 flex justify-start pl-1 pt-1.5 pb-0.5">
          <BrandLogo variant="nerve" className="w-[155px] md:w-[175px]" />
          <button
            type="button"
            onClick={() => setSidebarOpen(false)}
            className={cx(L.iconGhost, 'md:hidden absolute right-0 top-0')}
            aria-label="Close menu"
            title="Close menu"
          >
            <PanelLeftClose className="w-4 h-4" strokeWidth={1.75} />
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto scrollbar-none -mx-1 px-1 pb-2 mt-2">
          {!isFullAdmin && role !== 'inventory_manager' && (
            <Link to="/branding/user" className={cx(L.nav, L.navOff, 'mt-2')}>
              <ArrowLeft className={L.navIcon} strokeWidth={1.75} />
              <span className="truncate">Back to my dashboard</span>
            </Link>
          )}

          {visibleMenu.length > 0 && (
            <>
              <p className={L.navGroup}>Main menu</p>
              <div className="space-y-0.5">
                {visibleMenu.map(item => <NavItem key={item.path} item={item} />)}
              </div>
            </>
          )}

          {visibleWorkspace.length > 0 && (
            <>
              <p className={L.navGroup}>Workspace</p>
              <div className="space-y-0.5">
                {visibleWorkspace.map(item => <NavItem key={item.path} item={item} />)}
              </div>
            </>
          )}

          {visibleBrandOps.length > 0 && (
            <>
              <p className={L.navGroup}>BrandOps</p>
              <div className="space-y-0.5">
                {visibleBrandOps.map(item => <NavItem key={item.path} item={item} />)}
              </div>
            </>
          )}

          <p className={L.navGroup}>Other</p>
          <div className="space-y-0.5">
            {/* Desktop slides the panel out of the sidebar; phones open a page,
                like every other section. */}
            <button
              type="button"
              onClick={() => {
                if (window.matchMedia('(max-width: 767px)').matches) { setSidebarOpen(false); navigate('/branding/notifications') }
                else setNotifOpen(o => !o)
              }}
              aria-expanded={notifOpen}
              aria-controls="notification-drawer"
              className={cx(L.nav, (notifOpen || onNotificationsPage) ? L.navOn : L.navOff)}
            >
              <Bell className={(notifOpen || onNotificationsPage) ? L.navIconOn : L.navIcon} strokeWidth={1.75} />
              <span className="truncate flex-1">Notifications</span>
              {notifState.unreadCount > 0 && (
                <span className="min-w-[18px] h-[18px] px-1 rounded-[5px] bg-[#F59E0B] text-white text-[11px] font-semibold grid place-items-center tabular-nums">{notifState.unreadCount}</span>
              )}
            </button>
            <Link to="/branding/account" onClick={() => setSidebarOpen(false)} className={cx(L.nav, onAccountPage ? L.navOn : L.navOff)} aria-current={onAccountPage ? 'page' : undefined}>
              <UserIcon className={onAccountPage ? L.navIconOn : L.navIcon} strokeWidth={1.75} />
              <span>Account</span>
            </Link>
            <button type="button" onClick={() => { void signOut?.() }} className={cx(L.nav, L.navOff)}>
              <LogOut className={L.navIcon} strokeWidth={1.75} />
              <span>Logout</span>
            </button>
          </div>
        </nav>

        {/* User card */}
        <div className="shrink-0 pt-3 border-t border-[#C5CAD1]">
          <button
            type="button"
            onClick={() => { setSidebarOpen(false); navigate('/branding/account') }}
            className="w-full flex items-center gap-2.5 p-2 rounded-[6px] bg-white border border-[#C5CAD1] hover:border-[#9CA3AF] transition-colors text-left cursor-pointer"
            title={`${profile?.full_name || 'User'} · ${roleLabel}`}
          >
            <Avatar url={profile?.avatar_url} name={profile?.full_name} email={profile?.email} size="sm" />
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-semibold text-[#111827] truncate">{profile?.full_name || 'User'}</p>
              <p className="text-[11px] text-[#6B7280] truncate">{roleLabel}</p>
            </div>
            <ChevronsUpDown className="w-3.5 h-3.5 text-[#9CA3AF] shrink-0" strokeWidth={1.75} />
          </button>
        </div>
      </aside>

      {/* ── Notification drawer: slides out from the sidebar ──────────── */}
      {notifOpen && <div className="fixed inset-0 z-30" onClick={() => setNotifOpen(false)} aria-hidden="true" />}
      <aside
        id="notification-drawer"
        role="dialog"
        aria-label="Notifications"
        aria-hidden={!notifOpen}
        className={cx(
          'fixed inset-y-0 left-0 md:left-56 z-40 w-80 max-w-[calc(100vw-3.5rem)] bg-white border-r border-[#C5CAD1]',
          'shadow-[8px_0_24px_-12px_rgba(16,24,40,0.25)] flex flex-col',
          'transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]',
          notifOpen ? 'translate-x-0' : '-translate-x-[120%] pointer-events-none',
        )}
      >
        <NotificationPanel state={notifState} variant="drawer" onClose={() => setNotifOpen(false)} />
      </aside>

      {/* ── Main ──────────────────────────────────────────────────────── */}
      <div className="flex-1 h-full flex flex-col overflow-hidden min-w-0 bg-white">
        {/* Top bar: breadcrumb left; date, status, actions and controls right */}
        <header className="h-12 shrink-0 flex items-center justify-between gap-3 px-4 sm:px-6 border-b border-[#C5CAD1] bg-white z-20">
          <div className="flex items-center gap-2 min-w-0">
            <button type="button" onClick={() => setSidebarOpen(true)} className={cx(L.iconGhost, 'md:hidden -ml-2')} aria-label="Open menu">
              <Menu className="w-4 h-4" strokeWidth={1.75} />
            </button>
            <nav className="hidden md:flex items-center gap-1.5 text-[13px] min-w-0" aria-label="Breadcrumb">
              <Link to={isFullAdmin ? '/branding/dashboard' : '/branding/user'} className="text-[#6B7280] hover:text-[#111827] transition-colors">Workspace</Link>
              <span className="text-[#C5CAD1]" aria-hidden="true">/</span>
              <span className="font-medium text-[#111827] truncate" aria-current="page">{pageTitle}</span>
            </nav>
            <span className="md:hidden text-[13px] font-medium text-[#111827] truncate">{pageTitle}</span>
          </div>

          <div className="flex items-center gap-0.5">
            <span className="hidden md:inline-flex items-center gap-2 text-[12px] text-[#6B7280] mr-2 whitespace-nowrap" title={headerDate}>
              <span>{dateChip}</span>
              <span className="text-[#D1D5DB]" aria-hidden="true">·</span>
              <span className="inline-flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-[#22C55E]" aria-hidden="true" />
                Workspace live
              </span>
            </span>
            {actions && <div className="hidden lg:flex items-center gap-1.5 mr-1.5">{actions}</div>}
            <SearchControl />
            <ModeToggle />
            <button type="button" onClick={() => setThemeOpen(true)} className={cx(L.iconGhost, themeOpen && 'bg-[#F3F4F6] text-[#111827]')} aria-label="Appearance" title="Appearance · colour mode and primary colour">
              <Paintbrush className="w-4 h-4" strokeWidth={1.75} />
            </button>
            <AvatarMenu profile={profile} roleLabel={roleLabel} onOpenProfile={() => navigate('/branding/account')} onSignOut={() => { void signOut?.() }} />
          </div>
        </header>

        <main className="relative flex-1 min-h-0 overflow-y-auto overscroll-contain bg-[#F9FAFB] px-4 sm:px-6 pt-5 pb-8">
          <div key={location.pathname} className="nerve-page-in space-y-4 min-h-full flex flex-col">
            {/* No page heading: the breadcrumb in the top bar names the page.
                Page actions still get a row on screens too narrow for the bar. */}
            {actions && <div className="lg:hidden flex items-center gap-1.5 flex-wrap">{actions}</div>}
            {onNotificationsPage
              ? <div className={cx(L.card, 'overflow-hidden')}><NotificationPanel state={notifState} variant="page" /></div>
              : onAccountPage
                ? <SettingsPage profile={profile} />
                : children}
          </div>
        </main>
      </div>

      {themeOpen && <ThemeModal onClose={() => setThemeOpen(false)} />}
    </div>
  )
}

// ── Pieces ────────────────────────────────────────────────────────────────

/** Amber dot beside "Leave Requests" while any are waiting. */
function PendingLeavesDot() {
  const [count, setCount] = useState(0)
  useEffect(() => {
    brandingApi.getLeaves('pending').then(r => setCount(r.leaves.length)).catch(() => {})
  }, [])
  if (count === 0) return null
  return (
    <span className="ml-auto shrink-0 flex items-center" title={`${count} pending`}>
      <span className="w-1.5 h-1.5 rounded-full bg-[#F59E0B]" />
      <span className="sr-only">{count} pending leave requests</span>
    </span>
  )
}

function AvatarMenu({ profile, roleLabel, onOpenProfile, onSignOut }: {
  profile: ReturnType<typeof useAuth>['profile']
  roleLabel: string
  onOpenProfile: () => void
  onSignOut: () => void
}) {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('[data-avatar-menu]')) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  return (
    <div className="relative shrink-0 ml-1" data-avatar-menu="">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className={cx('rounded-full transition-shadow cursor-pointer', open ? 'ring-2 ring-[var(--nerve-primary-soft-border)]' : 'hover:ring-2 hover:ring-[#C5CAD1]')}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`${profile?.full_name || 'User'} · ${roleLabel}`}
      >
        <Avatar url={profile?.avatar_url} name={profile?.full_name} email={profile?.email} size="sm" />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-10 w-64 max-w-[calc(100vw-2rem)] bg-white rounded-[6px] border border-[#C5CAD1] shadow-[0_12px_32px_-8px_rgba(16,24,40,0.2)] z-50 overflow-hidden animate-scale-in">
          <div className="px-4 py-3 border-b border-[#C5CAD1] flex items-center gap-3">
            <Avatar url={profile?.avatar_url} name={profile?.full_name} email={profile?.email} size="sm" />
            <div className="min-w-0">
              <p className="text-[13px] font-semibold text-[#111827] truncate">{profile?.full_name || 'User'}</p>
              <p className="text-[12px] text-[#6B7280] truncate">{profile?.email}</p>
            </div>
          </div>
          <div className="px-4 py-2 border-b border-[#C5CAD1]">
            <Badge tone="info">{roleLabel}</Badge>
          </div>
          <div className="py-1">
            <button role="menuitem" onClick={() => { setOpen(false); onOpenProfile() }} className="w-full flex items-center gap-2.5 px-4 h-9 text-left text-[13px] text-[#111827] hover:bg-[#F9FAFB] transition-colors cursor-pointer">
              <UserIcon className="w-4 h-4 shrink-0 text-[#6B7280]" strokeWidth={1.75} />
              <span>My profile</span>
            </button>
            <Link role="menuitem" to="/branding/user" onClick={() => setOpen(false)} className="w-full flex items-center gap-2.5 px-4 h-9 text-left text-[13px] text-[#111827] hover:bg-[#F9FAFB] transition-colors cursor-pointer">
              <LayoutDashboard className="w-4 h-4 shrink-0 text-[#6B7280]" strokeWidth={1.75} />
              <span>My dashboard</span>
            </Link>
            <button role="menuitem" onClick={() => { setOpen(false); onSignOut() }} className="w-full flex items-center gap-2.5 px-4 h-9 text-left text-[13px] text-[#DC2626] hover:bg-[#FEF2F2] transition-colors cursor-pointer">
              <LogOut className="w-4 h-4 shrink-0" strokeWidth={1.75} />
              <span>Logout</span>
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

/** ⌘F search across the last month of team reports and all projects. */
function SearchControl() {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [reports, setReports] = useState<DailyReport[]>([])
  const [projects, setProjects] = useState<BrandingProject[]>([])
  const [loading, setLoading] = useState(false)
  const navigate = useNavigate()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); setOpen(true) }
      if (e.key === 'Escape') { setOpen(false); setQ('') }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    if (!open) return
    setLoading(true)
    const now = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    Promise.all([
      brandingApi.getAllReports({ dateFrom: iso(new Date(now.getFullYear(), now.getMonth() - 1, 1)), dateTo: iso(now) }),
      brandingApi.getProjects(),
    ]).then(([r, p]) => { setReports(r.reports); setProjects(p.projects) })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [open])

  const results = useMemo(() => {
    const s = q.toLowerCase().trim()
    if (!s) return { reports: reports.slice(0, 5), projects: projects.slice(0, 4) }
    return {
      reports: reports.filter(r =>
        r.report_date.includes(s) || (r.user_name ?? '').toLowerCase().includes(s) ||
        r.rows?.some(row => row.type_of_work.toLowerCase().includes(s) || row.specific_work.toLowerCase().includes(s))).slice(0, 6),
      projects: projects.filter(p => p.name.toLowerCase().includes(s) || (p.description ?? '').toLowerCase().includes(s)).slice(0, 4),
    }
  }, [q, reports, projects])

  const close = () => { setOpen(false); setQ('') }

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={L.iconGhost} aria-label="Search" title="Search (⌘F)">
        <Search className="w-4 h-4" strokeWidth={1.75} />
      </button>
      {open && (
        <div className={cx(DS.overlay, '!pt-20')} onClick={close}>
          <div className={cx(DS.dialog, 'max-w-xl overflow-hidden')} onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-3 px-4 h-12 border-b border-[#C5CAD1]">
              <Search className="w-4 h-4 text-[#9CA3AF] shrink-0" strokeWidth={1.75} />
              <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="Search reports, people, projects…" className="flex-1 bg-transparent text-[13px] outline-none placeholder:text-[#9CA3AF] text-[#111827]" />
              <kbd className="text-[11px] font-medium text-[#6B7280] bg-[#F9FAFB] border border-[#C5CAD1] rounded-[4px] px-1.5 py-0.5">Esc</kbd>
            </div>
            <div className="max-h-[60vh] overflow-y-auto">
              {loading && <p className="px-4 py-8 text-center text-[12px] text-[#6B7280]">Searching…</p>}
              {!loading && results.reports.length === 0 && results.projects.length === 0 && (
                <p className="px-4 py-8 text-center text-[12px] text-[#6B7280]">Nothing matches “{q}”.</p>
              )}
              {!loading && results.projects.length > 0 && (
                <div className="py-2">
                  <p className={cx(DS.eyebrow, 'px-4 py-1.5')}>Projects</p>
                  {results.projects.map(p => (
                    <button key={p.id} type="button" onClick={() => { close(); navigate('/branding/projects') }} className="w-full text-left px-4 py-2.5 hover:bg-[#F9FAFB] transition-colors cursor-pointer">
                      <p className="text-[13px] font-semibold text-[#111827] truncate">{p.name}</p>
                      <p className="text-[12px] text-[#6B7280] truncate">{p.description || 'No description'}{p.deadline ? ` · due ${p.deadline}` : ''}</p>
                    </button>
                  ))}
                </div>
              )}
              {!loading && results.reports.length > 0 && (
                <div className="py-2 border-t border-[#C5CAD1]">
                  <p className={cx(DS.eyebrow, 'px-4 py-1.5')}>Reports</p>
                  {results.reports.map(r => {
                    const hrs = (r.rows ?? []).reduce((s, row) => s + timeToHours(row.time_taken), 0)
                    return (
                      <button key={r.id} type="button" onClick={() => { close(); navigate('/branding/dashboard') }} className="w-full text-left px-4 py-2.5 hover:bg-[#F9FAFB] transition-colors cursor-pointer flex items-center gap-3">
                        <ClipboardList className="w-4 h-4 text-[#9CA3AF] shrink-0" strokeWidth={1.75} />
                        <div className="min-w-0 flex-1">
                          <p className="text-[13px] font-semibold text-[#111827] truncate">{r.user_name || 'Report'} · {r.report_date}</p>
                          <p className="text-[12px] text-[#6B7280] truncate">{(r.rows ?? []).length} row{(r.rows ?? []).length === 1 ? '' : 's'} · {hrs.toFixed(1)}h</p>
                        </div>
                        <Badge tone={r.is_locked ? 'success' : 'warning'}>{r.is_locked ? 'Submitted' : 'Draft'}</Badge>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  )
}

// ── Route wrapper ─────────────────────────────────────────────────────────
// Wrap a page in the branding shell for anyone on the branding team (every
// branding role shares the same chrome now) and for super admins. Other
// teams on shared routes like /admin/export keep their own layout.

export function MaybeBrandingAdminShell({ children }: { children: ReactNode }) {
  const { role, team } = useAuth()
  const wrap = team === 'branding' || role === 'super_admin'
  if (wrap) return <BrandingAdminShell>{children}</BrandingAdminShell>
  return <>{children}</>
}
