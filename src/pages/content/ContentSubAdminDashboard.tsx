import { useMemo } from 'react'
import { useAuth } from '@/hooks/useAuth'
import { useAppData } from '@/hooks/useAppData'
import { CONTENT_TYPES } from '@/lib/constants'
import { FileText, PlusCircle, Search, Users, BookOpen, MessageSquare } from 'lucide-react'
import { Link } from 'react-router-dom'

export default function ContentSubAdminDashboard() {
  const { profile } = useAuth()
  const { entries: allEntries, users: allUsers } = useAppData()

  const contentEntries = useMemo(
    () => allEntries.filter(e => (CONTENT_TYPES as readonly string[]).includes(e.type)),
    [allEntries]
  )

  const teamUsers = useMemo(
    () => allUsers.filter(u => u.team === 'content' && u.role === 'user'),
    [allUsers]
  )

  const stats = useMemo(() => {
    const now = new Date()
    return {
      total:     contentEntries.length,
      thisMonth: contentEntries.filter(e => {
        const d = new Date(e.entry_date)
        return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear()
      }).length,
      research:  contentEntries.filter(e => e.type === 'Research').length,
      teamUsers: teamUsers.length,
    }
  }, [contentEntries, teamUsers])

  const recent = contentEntries.slice(0, 6)

  return (
    <div className="animate-fade-in space-y-6">

      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-blue-100 flex items-center justify-center">
          <FileText className="w-5 h-5 text-blue-600" />
        </div>
        <div>
          <h1 className="text-2xl font-serif text-foreground">Content Team — Lead Dashboard</h1>
          <p className="text-sm text-muted-foreground">
            Welcome{profile?.full_name ? `, ${profile.full_name}` : ''}. You manage the content team.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[
          { label: 'Content entries', value: stats.total,     icon: FileText,  bg: 'bg-blue-50',   color: 'text-blue-600' },
          { label: 'This month',      value: stats.thisMonth, icon: FileText,  bg: 'bg-amber-50',  color: 'text-amber-600' },
          { label: 'Research papers', value: stats.research,  icon: BookOpen,  bg: 'bg-green-50',  color: 'text-green-600' },
          { label: 'Team users',      value: stats.teamUsers, icon: Users,     bg: 'bg-purple-50', color: 'text-purple-600' },
        ].map(s => {
          const Icon = s.icon
          return (
            <div key={s.label} className="hub-card flex items-center gap-3 py-3">
              <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${s.bg} shrink-0`}>
                <Icon className={`w-4 h-4 ${s.color}`} />
              </div>
              <div>
                <div className="text-2xl font-serif text-foreground leading-none">{s.value}</div>
                <div className="text-xs text-muted-foreground mt-0.5">{s.label}</div>
              </div>
            </div>
          )
        })}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">

        <div className="hub-card lg:col-span-2">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-foreground">Recent content entries</h2>
            <Link to="/browse" className="text-xs text-primary hover:underline flex items-center gap-1">
              <Search className="w-3 h-3" /> Browse all
            </Link>
          </div>
          {recent.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">No entries yet.</p>
          ) : (
            <div>
              {recent.map(e => (
                <div key={e.id} className="flex items-start justify-between gap-3 py-3 border-b border-border last:border-0">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground truncate">{e.title}</p>
                    <div className="flex gap-1.5 mt-1">
                      <span className="hub-badge bg-blue-50 text-blue-700">{e.type}</span>
                      <span className="hub-badge bg-primary/5 text-primary/70">{e.dept}</span>
                    </div>
                  </div>
                  <span className="text-xs text-muted-foreground shrink-0">{e.entry_date}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="space-y-4">
          <div className="hub-card">
            <h2 className="text-sm font-semibold text-foreground mb-3">Quick actions</h2>
            {[
              { to: '/add',          icon: PlusCircle,   label: 'Add entry' },
              { to: '/browse',       icon: Search,       label: 'Browse entries' },
              { to: '/content/team', icon: Users,        label: 'My team' },
              { to: '/ai/query',     icon: MessageSquare, label: 'Ask AI' },
            ].map(({ to, icon: Icon, label }) => (
              <Link key={to} to={to}
                className="flex items-center gap-3 p-2.5 rounded-lg hover:bg-accent transition-colors group">
                <Icon className="w-4 h-4 text-muted-foreground group-hover:text-blue-600" />
                <span className="text-sm text-foreground">{label}</span>
              </Link>
            ))}
          </div>

          {teamUsers.length > 0 && (
            <div className="hub-card">
              <h2 className="text-sm font-semibold text-foreground mb-3">My team ({teamUsers.length})</h2>
              <div className="space-y-2">
                {teamUsers.slice(0, 4).map(u => (
                  <div key={u.id} className="flex items-center gap-2">
                    <div className="w-6 h-6 rounded-full bg-blue-100 flex items-center justify-center shrink-0">
                      <span className="text-[10px] font-semibold text-blue-600">
                        {(u.full_name || u.email)[0].toUpperCase()}
                      </span>
                    </div>
                    <span className="text-xs text-foreground truncate">{u.full_name}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

      </div>
    </div>
  )
}
