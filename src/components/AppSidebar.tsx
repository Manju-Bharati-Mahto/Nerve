import { Link, useLocation } from 'react-router-dom'
import { useAuth } from '@/hooks/useAuth'
import {
  LayoutDashboard, Search, PlusCircle, Users, Download,
  LogOut, BookOpen, MessageSquare, Newspaper,
  Crown, UserCheck, User, Settings, Palette, FileText,
} from 'lucide-react'

type NavItem = { path: string; label: string; icon: React.ElementType }
type SectionConfig = { heading?: string; items: NavItem[] }
type RoleConfig = {
  label: string
  icon: React.ElementType
  iconColor: string
  iconBg: string
  sections: SectionConfig[]
}

function cfg(
  label: string,
  icon: React.ElementType,
  iconColor: string,
  iconBg: string,
  sections: SectionConfig[]
): RoleConfig {
  return { label, icon, iconColor, iconBg, sections }
}

// Sidebar config keyed by `${role}:${team}`
const SIDEBAR: Record<string, RoleConfig> = {

  'super_admin:': cfg('Super Admin', Crown, 'text-purple-600', 'bg-purple-100', [
    { items: [
      { path: '/super-admin/dashboard', label: 'Dashboard',      icon: LayoutDashboard },
      { path: '/super-admin/users',     label: 'All users',      icon: Users },
      { path: '/super-admin/settings',  label: 'Settings',       icon: Settings },
    ]},
    { heading: 'Content', items: [
      { path: '/browse',       label: 'Browse all',  icon: Search },
      { path: '/admin/export', label: 'Export data', icon: Download },
    ]},
    { heading: 'AI', items: [
      { path: '/ai/query',      label: 'Ask AI',     icon: MessageSquare },
      { path: '/ai/newsletter', label: 'Newsletter', icon: Newspaper },
    ]},
  ]),

  'admin:branding': cfg('Branding Admin', Palette, 'text-pink-600', 'bg-pink-100', [
    { items: [
      { path: '/branding/dashboard', label: 'Dashboard',    icon: LayoutDashboard },
      { path: '/branding/browse',    label: 'Design Gallery', icon: Search },
    ]},
    { heading: 'Team', items: [
      { path: '/branding/team',  label: 'Team members', icon: Users },
      { path: '/admin/export',   label: 'Export data',  icon: Download },
    ]},
  ]),

  'admin:content': cfg('Content Admin', FileText, 'text-blue-600', 'bg-blue-100', [
    { items: [
      { path: '/content/dashboard', label: 'Dashboard',  icon: LayoutDashboard },
      { path: '/browse',            label: 'Browse',     icon: Search },
      { path: '/add',               label: 'Add entry',  icon: PlusCircle },
    ]},
    { heading: 'Team', items: [
      { path: '/content/team', label: 'Team members', icon: Users },
      { path: '/admin/export', label: 'Export data',  icon: Download },
    ]},
    { heading: 'AI', items: [
      { path: '/ai/query',      label: 'Ask AI',     icon: MessageSquare },
      { path: '/ai/newsletter', label: 'Newsletter', icon: Newspaper },
    ]},
  ]),

  'sub_admin:branding': cfg('Branding Lead', UserCheck, 'text-pink-600', 'bg-pink-100', [
    { items: [
      { path: '/branding/sub-admin', label: 'Dashboard',      icon: LayoutDashboard },
      { path: '/branding/browse',    label: 'Design Gallery', icon: Search },
      { path: '/branding/team',      label: 'My team',        icon: Users },
    ]},
  ]),

  'sub_admin:content': cfg('Content Lead', UserCheck, 'text-blue-600', 'bg-blue-100', [
    { items: [
      { path: '/content/sub-admin', label: 'Dashboard', icon: LayoutDashboard },
      { path: '/browse',            label: 'Browse',    icon: Search },
      { path: '/add',               label: 'Add entry', icon: PlusCircle },
      { path: '/content/team',      label: 'My team',   icon: Users },
    ]},
    { heading: 'AI', items: [
      { path: '/ai/query',      label: 'Ask AI',     icon: MessageSquare },
      { path: '/ai/newsletter', label: 'Newsletter', icon: Newspaper },
    ]},
  ]),

  'user:branding': cfg('Branding Team', User, 'text-pink-600', 'bg-pink-100', [
    { items: [
      { path: '/branding/user',   label: 'My Dashboard',   icon: LayoutDashboard },
      { path: '/branding/browse', label: 'Design Gallery', icon: Search },
    ]},
  ]),

  'user:content': cfg('Content Team', User, 'text-blue-600', 'bg-blue-100', [
    { items: [
      { path: '/content/user', label: 'My Dashboard', icon: LayoutDashboard },
      { path: '/add',          label: 'Add entry',    icon: PlusCircle },
      { path: '/browse',       label: 'Browse',       icon: Search },
      { path: '/admin/export', label: 'Export data',  icon: Download },
    ]},
    { heading: 'AI', items: [
      { path: '/ai/query',      label: 'Ask AI',     icon: MessageSquare },
      { path: '/ai/newsletter', label: 'Newsletter', icon: Newspaper },
    ]},
  ]),
}

const FALLBACK: RoleConfig = cfg('User', User, 'text-muted-foreground', 'bg-muted', [
  { items: [{ path: '/browse', label: 'Browse', icon: Search }] },
])

export default function AppSidebar() {
  const { profile, role, team, signOut } = useAuth()
  const location = useLocation()
  const isActive = (path: string) => location.pathname === path

  const key = `${role ?? ''}:${team ?? ''}`
  const config = SIDEBAR[key] ?? FALLBACK
  const BadgeIcon = config.icon

  return (
    <aside className="w-60 border-r border-border bg-card flex flex-col shrink-0">

      {/* Logo */}
      <div className="p-5 border-b border-border">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-primary flex items-center justify-center">
            <BookOpen className="w-5 h-5 text-primary-foreground" />
          </div>
          <div>
            <h1 className="text-sm font-serif font-bold text-foreground leading-tight">Parul University</h1>
            <p className="text-[11px] text-muted-foreground">Knowledge Hub</p>
          </div>
        </div>
      </div>

      {/* Team badge */}
      {team && (
        <div className={`mx-3 mt-3 px-3 py-2 rounded-lg flex items-center gap-2 ${config.iconBg}`}>
          <BadgeIcon className={`w-3.5 h-3.5 ${config.iconColor}`} />
          <span className={`text-xs font-semibold ${config.iconColor}`}>
            {team === 'branding' ? 'Branding Team' : 'Content Team'}
          </span>
        </div>
      )}

      {/* Nav */}
      <nav className="flex-1 p-3 space-y-1 overflow-y-auto">
        {config.sections.map((section, si) => (
          <div key={si}>
            {section.heading && (
              <div className="pt-4 pb-1 px-3">
                <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                  {section.heading}
                </span>
              </div>
            )}
            {section.items.map(item => (
              <Link
                key={item.path}
                to={item.path}
                className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${
                  isActive(item.path)
                    ? 'bg-accent text-accent-foreground font-medium'
                    : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
                }`}
              >
                <item.icon className="w-4 h-4 shrink-0" />
                {item.label}
              </Link>
            ))}
          </div>
        ))}
      </nav>

      {/* Footer */}
      <div className="p-4 border-t border-border">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <div className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${config.iconBg}`}>
              <BadgeIcon className={`w-3.5 h-3.5 ${config.iconColor}`} />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground truncate">{profile?.full_name || 'User'}</p>
              <p className="text-[11px] text-muted-foreground">{config.label}</p>
            </div>
          </div>
          <button
            onClick={signOut}
            className="p-2 rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground transition-colors shrink-0"
            title="Sign out"
          >
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </div>
    </aside>
  )
}
