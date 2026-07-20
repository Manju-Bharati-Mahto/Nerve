/**
 * PU MediaOps shell — sidebar + top bar for every Media Crew page.
 * Mirrors Nerve's dark-green identity (BrandingAdminShell is the reference):
 * fixed sidebar with Menu / Workspace / Account groups, content in cards.
 */
import { Link, useLocation } from 'react-router-dom'
import { LayoutDashboard, ClipboardList, Users, Clapperboard, LogOut, UserRound } from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'

const GREEN = '#1a472a'

interface NavLink {
  path: string
  label: string
  icon: React.ElementType
  leadOnly?: boolean
}

const MENU: NavLink[] = [
  { path: '/media/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { path: '/media/report', label: 'My Daily Report', icon: ClipboardList },
  { path: '/media/team-reports', label: 'Team Reports', icon: Users, leadOnly: true },
  { path: '/media/projects', label: 'Production Tracker', icon: Clapperboard },
]

export default function MediaShell({ children }: { children: React.ReactNode }) {
  const { profile, role, signOut } = useAuth()
  const location = useLocation()
  const isLead = role === 'super_admin' || role === 'admin' || role === 'sub_admin'

  const roleLabel =
    role === 'super_admin' ? 'Super Admin'
    : role === 'admin' ? 'MediaOps Admin'
    : role === 'sub_admin' ? 'Team Lead'
    : role === 'social_media' ? 'Social Media'
    : 'Crew Member'

  return (
    <div className="min-h-screen bg-[#f7faf8] flex">
      <aside className="w-60 shrink-0 border-r border-gray-100 bg-white flex flex-col min-h-screen">
        <div className="px-5 py-5 flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-xl flex items-center justify-center" style={{ background: GREEN }}>
            <Clapperboard className="w-5 h-5 text-white" />
          </div>
          <div>
            <p className="text-sm font-extrabold leading-tight" style={{ color: GREEN }}>PU MediaOps</p>
            <p className="text-[10px] text-gray-400 leading-tight">Media Crew Operations</p>
          </div>
        </div>

        <nav className="flex-1 px-3 space-y-0.5">
          <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest px-3 pt-2 pb-1.5">Menu</p>
          {MENU.filter(l => !l.leadOnly || isLead).map(l => {
            const active = location.pathname.startsWith(l.path)
            const Icon = l.icon
            return (
              <Link key={l.path} to={l.path}
                className={`flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-[13px] font-semibold transition-colors ${
                  active ? 'text-white' : 'text-gray-500 hover:bg-gray-50 hover:text-gray-700'
                }`}
                style={active ? { background: GREEN } : undefined}>
                <Icon className="w-4 h-4 shrink-0" />
                {l.label}
              </Link>
            )
          })}
        </nav>

        <div className="px-3 pb-5 space-y-0.5">
          <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest px-3 pb-1.5">Account</p>
          <div className="px-3 py-2 flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-full bg-green-100 flex items-center justify-center">
              <UserRound className="w-4 h-4" style={{ color: GREEN }} />
            </div>
            <div className="min-w-0">
              <p className="text-xs font-semibold text-gray-700 truncate">{profile?.full_name || profile?.email}</p>
              <p className="text-[10px] text-gray-400">{roleLabel}</p>
            </div>
          </div>
          <button onClick={signOut}
            className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-[13px] font-semibold text-gray-500 hover:bg-gray-50 hover:text-gray-700">
            <LogOut className="w-4 h-4" /> Logout
          </button>
        </div>
      </aside>

      <main className="flex-1 min-w-0 p-6">{children}</main>
    </div>
  )
}
