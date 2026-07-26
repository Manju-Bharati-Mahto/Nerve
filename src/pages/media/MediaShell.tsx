/**
 * Media Ops app shell (§5.2 navigation subset for Phase 1) + bootstrap
 * context: media role (D4 mapping), lookups, and the media team roster are
 * loaded once and shared by every page via useMedia().
 */
import { createContext, useContext, useEffect, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import {
  LayoutDashboard, Sun, FolderKanban, KanbanSquare, ClipboardList,
  Settings2, Bell, LogOut, Clapperboard, X,
} from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'
import { mediaApi } from '@/lib/media-api'
import { MEDIA_GREEN, type MediaLookups, type MediaRole, type MediaTeamUser, type MediaNotification } from '@/lib/media-types'

interface MediaCtx {
  mediaRole: MediaRole
  lookups: MediaLookups
  team: MediaTeamUser[]
  refresh: () => void
}

const Ctx = createContext<MediaCtx | null>(null)

export function useMedia(): MediaCtx {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useMedia must be used inside MediaShell')
  return ctx
}

const NAV = [
  { path: '/media/home', label: 'Home', icon: LayoutDashboard },
  { path: '/media/my-day', label: 'My Day', icon: Sun },
  { path: '/media/projects', label: 'Projects', icon: FolderKanban },
  { path: '/media/pipeline', label: 'Pipeline', icon: KanbanSquare },
  { path: '/media/reports', label: 'Daily Reports', icon: ClipboardList },
  { path: '/media/admin', label: 'Admin', icon: Settings2, adminOnly: true },
]

const ROLE_LABEL: Record<MediaRole, string> = { admin: 'Admin', team_lead: 'Team Lead', employee: 'Crew' }

export default function MediaShell({ children }: { children: React.ReactNode }) {
  const { profile, signOut } = useAuth()
  const location = useLocation()
  const navigate = useNavigate()
  const [boot, setBoot] = useState<Omit<MediaCtx, 'refresh'> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notifOpen, setNotifOpen] = useState(false)
  const [notifications, setNotifications] = useState<MediaNotification[]>([])

  const load = () => {
    mediaApi.bootstrap()
      .then(r => setBoot({ mediaRole: r.media_role, lookups: r.lookups, team: r.team }))
      .catch(e => setError(e instanceof Error ? e.message : 'Failed to load Media Ops.'))
  }
  useEffect(load, [])
  useEffect(() => {
    mediaApi.notifications().then(r => setNotifications(r.notifications)).catch(() => {})
    const t = setInterval(() => {
      mediaApi.notifications().then(r => setNotifications(r.notifications)).catch(() => {})
    }, 60_000)
    return () => clearInterval(t)
  }, [])

  const unread = notifications.filter(n => !n.is_read).length

  async function openNotifications() {
    setNotifOpen(o => !o)
    if (!notifOpen && unread > 0) {
      try {
        await mediaApi.markRead([])
        setNotifications(ns => ns.map(n => ({ ...n, is_read: true })))
      } catch { /* non-fatal */ }
    }
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-8 text-center max-w-sm">
          <p className="text-sm text-gray-600 mb-4">{error}</p>
          <button onClick={() => navigate('/login')} className="text-sm px-4 py-2 rounded-xl text-white" style={{ background: MEDIA_GREEN }}>Back to login</button>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-50 flex">
      {/* Sidebar */}
      <aside className="w-60 shrink-0 bg-white border-r border-gray-100 flex flex-col fixed inset-y-0">
        <div className="flex items-center gap-2.5 px-5 py-5 border-b border-gray-100">
          <div className="w-9 h-9 rounded-xl flex items-center justify-center" style={{ background: MEDIA_GREEN }}>
            <Clapperboard className="w-5 h-5 text-white" />
          </div>
          <div>
            <p className="font-serif font-extrabold leading-tight" style={{ color: MEDIA_GREEN }}>Media Ops</p>
            <p className="text-[10px] uppercase tracking-widest text-gray-400">Media Crew</p>
          </div>
        </div>
        <nav className="flex-1 p-3 space-y-1 overflow-y-auto">
          {NAV.filter(n => !n.adminOnly || boot?.mediaRole === 'admin').map(n => {
            const active = location.pathname.startsWith(n.path)
            const Icon = n.icon
            return (
              <Link key={n.path} to={n.path}
                className={`flex items-center gap-2.5 px-3 py-2 rounded-xl text-[13px] font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[#1a472a]/40 ${
                  active ? 'text-white' : 'text-gray-500 hover:bg-gray-50 hover:text-gray-700'
                }`}
                style={active ? { background: MEDIA_GREEN } : undefined}>
                <Icon className="w-4 h-4 shrink-0" /> {n.label}
              </Link>
            )
          })}
        </nav>
        <div className="p-3 border-t border-gray-100">
          <div className="flex items-center gap-2.5 px-2 py-2">
            <div className="w-8 h-8 rounded-full flex items-center justify-center text-white text-xs font-bold" style={{ background: MEDIA_GREEN }}>
              {(profile?.full_name || '?').slice(0, 1).toUpperCase()}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold text-gray-800 truncate">{profile?.full_name}</p>
              <p className="text-[10px] text-gray-400">{boot ? ROLE_LABEL[boot.mediaRole] : '…'}</p>
            </div>
            <button onClick={openNotifications} title="Notifications"
              className="relative p-1.5 rounded-lg hover:bg-gray-100 text-gray-500">
              <Bell className="w-4 h-4" />
              {unread > 0 && <span className="absolute -top-0.5 -right-0.5 w-4 h-4 rounded-full bg-rose-500 text-white text-[9px] flex items-center justify-center">{unread > 9 ? '9+' : unread}</span>}
            </button>
            <button onClick={() => { void signOut(); navigate('/login') }} title="Sign out"
              className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-500">
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </aside>

      {/* Notifications drawer */}
      {notifOpen && (
        <div className="fixed inset-0 z-40" onClick={() => setNotifOpen(false)}>
          <div className="absolute left-60 bottom-4 w-80 max-h-[70vh] overflow-y-auto bg-white rounded-2xl border border-gray-100 shadow-xl p-3 ml-2"
            onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-1 pb-2">
              <p className="text-xs font-bold uppercase tracking-widest" style={{ color: MEDIA_GREEN }}>Notifications</p>
              <button onClick={() => setNotifOpen(false)} className="p-1 rounded-md hover:bg-gray-100 text-gray-400"><X className="w-3.5 h-3.5" /></button>
            </div>
            {notifications.length === 0 ? (
              <p className="text-xs text-gray-400 text-center py-6">Nothing yet.</p>
            ) : notifications.map(n => (
              <div key={n.id} className="px-2 py-2 border-t border-gray-50">
                <p className="text-xs font-semibold text-gray-800">{n.title}</p>
                {n.body && <p className="text-[11px] text-gray-500 mt-0.5">{n.body}</p>}
                <p className="text-[10px] text-gray-400 mt-0.5">{new Date(n.created_at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Main */}
      <main className="flex-1 ml-60 px-4 py-4 lg:px-6 lg:py-5">
        {!boot ? (
          <div className="space-y-4">
            {[1, 2, 3].map(i => <div key={i} className="bg-white rounded-2xl border border-gray-100 h-28 animate-pulse" />)}
          </div>
        ) : (
          <Ctx.Provider value={{ ...boot, refresh: load }}>
            {children}
          </Ctx.Provider>
        )}
      </main>
    </div>
  )
}
