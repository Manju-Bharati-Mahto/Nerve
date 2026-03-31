import { useMemo } from 'react'
import { useAuth } from '@/hooks/useAuth'
import { TEAM_COLOR_MAP, FALLBACK_COLOR } from '@/lib/db'
import { useAppData } from '@/hooks/useAppData'
import { Layers, Users, UserCheck } from 'lucide-react'

export default function TeamPanel() {
  const { team: myTeam, role } = useAuth()
  const { users: allUsers, teams: allTeams } = useAppData()

  const showTeams = role === 'super_admin'
    ? allTeams
    : allTeams.filter(t => t.id === myTeam)

  return (
    <div className="animate-fade-in space-y-6">
      <div>
        <h1 className="text-2xl font-serif text-foreground">Team Members</h1>
        <p className="text-sm text-muted-foreground mt-1">
          {role === 'super_admin'
            ? 'All teams across the organisation'
            : `Members of your ${allTeams.find(t => t.id === myTeam)?.name ?? myTeam} team`}
        </p>
      </div>

      {showTeams.map(t => {
        const c = TEAM_COLOR_MAP[t.color] ?? FALLBACK_COLOR
        const members   = allUsers.filter(u => u.team === t.id && u.role !== 'super_admin')
        const admins    = members.filter(u => u.role === 'admin')
        const subAdmins = members.filter(u => u.role === 'sub_admin')
        const users     = members.filter(u => u.role === 'user')

        return (
          <div key={t.id} className="hub-card">
            <div className="flex items-center gap-2.5 mb-4">
              <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${c.bgRound}`}>
                <Layers className={`w-4 h-4 ${c.text}`} />
              </div>
              <h2 className="text-sm font-semibold text-foreground">{t.name} Team</h2>
              <span className="ml-auto text-xs text-muted-foreground">{members.length} members</span>
            </div>

            {[
              { label: 'Admins', items: admins, badge: c.badge },
              { label: 'Team Leaders (Sub Admin)', items: subAdmins, badge: 'bg-teal-100 text-teal-700' },
              { label: 'Members', items: users, badge: 'bg-green-100 text-green-700' },
            ].map(group => group.items.length > 0 && (
              <div key={group.label} className="mb-4 last:mb-0">
                <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-2 px-1">
                  {group.label}
                </p>
                <div className="space-y-1">
                  {group.items.map(u => (
                    <div key={u.id} className="flex items-center justify-between py-2.5 px-1 border-b border-border last:border-0">
                      <div className="flex items-center gap-3">
                        <div className={`w-8 h-8 rounded-full ${c.bgRound} flex items-center justify-center shrink-0`}>
                          <span className={`text-xs font-semibold ${c.text}`}>
                            {(u.full_name || u.email)[0].toUpperCase()}
                          </span>
                        </div>
                        <div>
                          <p className="text-sm font-medium text-foreground">{u.full_name || 'Unnamed'}</p>
                          <p className="text-xs text-muted-foreground">{u.email}{u.department ? ` · ${u.department}` : ''}</p>
                        </div>
                      </div>
                      <span className={`hub-badge shrink-0 ${group.badge}`}>{group.label.split(' ')[0]}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}

            {members.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-4">No members assigned yet.</p>
            )}
          </div>
        )
      })}

      {showTeams.length === 0 && (
        <p className="text-sm text-muted-foreground text-center py-8">No team assigned. Ask your Super Admin to assign you to a team.</p>
      )}
    </div>
  )
}
