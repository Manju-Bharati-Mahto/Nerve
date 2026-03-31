import { useMemo, useState } from 'react'
import { TEAM_COLOR_MAP, FALLBACK_COLOR } from '@/lib/db'
import type { TeamRecord, AppUser } from '@/lib/app-types'
import { useAuth } from '@/hooks/useAuth'
import { useAppData } from '@/hooks/useAppData'
import { getErrorMessage } from '@/lib/error-utils'
import { Crown, Shield, UserCheck, User, Search, RefreshCw, Plus, Trash2, Layers } from 'lucide-react'
import type { AppRole } from '@/lib/constants'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'

const ROLE_CFG: Record<AppRole, { label: string; icon: React.ElementType; color: string; bg: string }> = {
  super_admin: { label: 'Super Admin', icon: Crown, color: 'text-purple-600', bg: 'bg-purple-100' },
  admin: { label: 'Admin', icon: Shield, color: 'text-blue-600', bg: 'bg-blue-100' },
  sub_admin: { label: 'Team Lead', icon: UserCheck, color: 'text-teal-600', bg: 'bg-teal-100' },
  user: { label: 'Member', icon: User, color: 'text-green-600', bg: 'bg-green-100' },
}

const BLANK_USER = { full_name: '', email: '', password: '', department: '' }
const BLANK_TEAM = { name: '', color: 'violet', error: '' }

const CUSTOM_COLORS = [
  { id: 'violet', dot: 'bg-violet-500' },
  { id: 'amber', dot: 'bg-amber-500' },
  { id: 'rose', dot: 'bg-rose-500' },
  { id: 'emerald', dot: 'bg-emerald-500' },
  { id: 'orange', dot: 'bg-orange-500' },
  { id: 'cyan', dot: 'bg-cyan-500' },
]

const ROLE_LABEL: Record<AppRole, string> = {
  super_admin: 'Super Admin', admin: 'Admin', sub_admin: 'Team Lead', user: 'Member',
}

function UserRow({
  u,
  meId,
  teams,
  onUpdate,
  onDelete,
}: {
  u: AppUser
  meId: string | undefined
  teams: TeamRecord[]
  onUpdate: (id: string, role: AppRole, team: string | null) => void
  onDelete: (id: string) => void
}) {
  const roleCfg = ROLE_CFG[u.role] || ROLE_CFG.user
  const RoleIcon = roleCfg.icon
  const isSelf = u.id === meId

  return (
    <div className="flex items-center justify-between py-2.5 border-b border-border last:border-0 gap-4">
      <div className="flex items-center gap-3 min-w-0 flex-1">
        <div className={`w-8 h-8 rounded-full ${roleCfg.bg} flex items-center justify-center shrink-0`}>
          <RoleIcon className={`w-4 h-4 ${roleCfg.color}`} />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground truncate">
            {u.full_name || 'Unnamed'}
            {isSelf && <span className="ml-1.5 text-[10px] text-muted-foreground">(you)</span>}
          </p>
          <p className="text-xs text-muted-foreground truncate">
            {u.email}{u.department ? ` · ${u.department}` : ''}
          </p>
        </div>
      </div>
      {!isSelf && (
        <div className="flex gap-2 shrink-0 items-center">
          <select
            className="hub-input text-xs py-1 w-28"
            value={u.role}
            onChange={e => onUpdate(u.id, e.target.value as AppRole, u.team)}
          >
            <option value="user">Member</option>
            <option value="sub_admin">Team Lead</option>
            <option value="admin">Admin</option>
          </select>
          <select
            className="hub-input text-xs py-1 w-32"
            value={u.team ?? ''}
            onChange={e => onUpdate(u.id, u.role, e.target.value || null)}
          >
            <option value="">No team</option>
            {teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <button
            onClick={() => onDelete(u.id)}
            className="p-2 rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
            title="Delete user"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      )}
    </div>
  )
}

export default function SuperAdminUsers() {
  const { user: me } = useAuth()
  const {
    users,
    teams,
    refreshAll,
    updateUser,
    addUser,
    addTeam,
    deleteTeam,
    deleteUser,
  } = useAppData()
  const [search, setSearch] = useState('')

  const [userDialog, setUserDialog] = useState<{
    open: boolean; role: AppRole; team: string | null
    form: typeof BLANK_USER; error: string
  }>({ open: false, role: 'user', team: null, form: BLANK_USER, error: '' })

  const [teamDialog, setTeamDialog] = useState<{
    open: boolean
  } & typeof BLANK_TEAM>({ open: false, ...BLANK_TEAM })

  function refresh() {
    void refreshAll()
  }

  async function handleUpdateUser(id: string, role: AppRole, team: string | null) {
    await updateUser(id, { role, team })
  }

  function openAddUser(role: AppRole, team: string | null) {
    setUserDialog({ open: true, role, team, form: BLANK_USER, error: '' })
  }

  async function submitUser() {
    const { form, role, team } = userDialog
    if (!form.full_name.trim() || !form.email.trim() || !form.password.trim()) {
      setUserDialog(d => ({ ...d, error: 'Name, email and password are required.' }))
      return
    }
    if (users.find(u => u.email.toLowerCase() === form.email.toLowerCase())) {
      setUserDialog(d => ({ ...d, error: 'An account with this email already exists.' }))
      return
    }

    try {
      await addUser({
        full_name: form.full_name.trim(),
        email: form.email.trim(),
        password: form.password,
        department: form.department.trim(),
        role,
        team,
        managed_by: null,
      })
      setUserDialog(d => ({ ...d, open: false }))
    } catch (err: unknown) {
      setUserDialog(d => ({ ...d, error: getErrorMessage(err, 'Failed to add user.') }))
    }
  }

  async function submitTeam() {
    if (!teamDialog.name.trim()) {
      setTeamDialog(d => ({ ...d, error: 'Team name is required.' }))
      return
    }
    const id = teamDialog.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')
    if (teams.find(t => t.id === id)) {
      setTeamDialog(d => ({ ...d, error: 'A team with this name already exists.' }))
      return
    }

    try {
      await addTeam({ name: teamDialog.name.trim(), color: teamDialog.color })
      setTeamDialog({ open: false, ...BLANK_TEAM })
    } catch (err: unknown) {
      setTeamDialog(d => ({ ...d, error: getErrorMessage(err, 'Failed to create team.') }))
    }
  }

  async function handleDeleteTeam(teamId: string) {
    const hasUsers = users.some(u => u.team === teamId)
    if (hasUsers) {
      alert('Reassign all users from this team before deleting it.')
      return
    }
    await deleteTeam(teamId)
  }

  async function handleDeleteUser(userId: string) {
    if (!confirm('Delete this user?')) return
    await deleteUser(userId)
  }

  const visible = useMemo(() => {
    const q = search.toLowerCase()
    return users.filter(u => {
      if (u.role === 'super_admin') return false
      return !search || u.full_name?.toLowerCase().includes(q) || u.email?.toLowerCase().includes(q)
    })
  }, [users, search])

  const unassigned = visible.filter(u => !u.team)

  const counts = useMemo(() => {
    const out: Record<string, number> = { _none: 0 }
    for (const u of users) {
      if (u.role === 'super_admin') continue
      if (!u.team) out._none = (out._none || 0) + 1
      else out[u.team] = (out[u.team] || 0) + 1
    }
    return out
  }, [users])

  const roleGroups: { role: AppRole; label: string; addLabel: string }[] = [
    { role: 'admin', label: 'Admins', addLabel: 'Add Admin' },
    { role: 'sub_admin', label: 'Team Leads', addLabel: 'Add Team Lead' },
    { role: 'user', label: 'Members', addLabel: 'Add Member' },
  ]

  const userDialogTeamName = userDialog.team
    ? (teams.find(t => t.id === userDialog.team)?.name ?? userDialog.team)
    : null

  const userDialogTeamColor = userDialog.team
    ? (TEAM_COLOR_MAP[teams.find(t => t.id === userDialog.team)?.color ?? ''] ?? FALLBACK_COLOR)
    : null

  return (
    <div className="animate-fade-in space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-serif text-foreground">User management</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Manage roles and team assignments. Only you can change these settings.
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => setTeamDialog({ open: true, ...BLANK_TEAM })}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg border border-border text-sm font-medium text-foreground hover:bg-accent transition-colors">
            <Plus className="w-4 h-4" /> Add Team
          </button>
          <button onClick={() => openAddUser('user', null)}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-brand-dark transition-colors">
            <Plus className="w-4 h-4" /> Add User
          </button>
        </div>
      </div>

      <div className="grid grid-cols-4 gap-3">
        {teams.map(t => {
          const c = TEAM_COLOR_MAP[t.color] ?? FALLBACK_COLOR
          return (
            <div key={t.id} className={`hub-card flex items-center gap-3 py-3 ${c.bg} border-0`}>
              <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${c.bgRound} shrink-0`}>
                <Layers className={`w-4 h-4 ${c.text}`} />
              </div>
              <div className="min-w-0 flex-1">
                <div className={`text-xl font-serif leading-none ${c.text}`}>{counts[t.id] ?? 0}</div>
                <div className="text-[11px] text-muted-foreground mt-0.5 truncate">{t.name} Team</div>
              </div>
            </div>
          )
        })}
        <div className="hub-card flex items-center gap-3 py-3">
          <div className="w-9 h-9 rounded-lg flex items-center justify-center bg-muted shrink-0">
            <User className="w-4 h-4 text-muted-foreground" />
          </div>
          <div>
            <div className="text-xl font-serif text-foreground leading-none">{counts._none ?? 0}</div>
            <div className="text-[11px] text-muted-foreground mt-0.5">Unassigned</div>
          </div>
        </div>
      </div>

      <div className="hub-card">
        <div className="flex gap-3 items-center">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
            <input className="hub-input pl-9" placeholder="Search by name or email..."
              value={search} onChange={e => setSearch(e.target.value)} />
          </div>
          <button onClick={refresh}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-border text-xs text-muted-foreground hover:bg-accent transition-colors shrink-0">
            <RefreshCw className="w-3.5 h-3.5" /> Refresh
          </button>
        </div>
      </div>

      {teams.map(t => {
        const c = TEAM_COLOR_MAP[t.color] ?? FALLBACK_COLOR
        return (
          <div key={t.id} className="hub-card overflow-hidden p-0">
            <div className={`flex items-center gap-2.5 px-5 py-3 ${c.headerBg} border-b border-border`}>
              <Layers className={`w-4 h-4 ${c.text}`} />
              <h2 className={`text-sm font-semibold ${c.text}`}>{t.name} Team</h2>
              <span className="ml-auto text-xs text-muted-foreground mr-2">{counts[t.id] ?? 0} members</span>
              {!t.isBuiltIn && (
                <button onClick={() => void handleDeleteTeam(t.id)}
                  className="p-1 rounded text-muted-foreground hover:text-destructive transition-colors"
                  title="Delete team">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            <div className="p-5 space-y-5">
              {roleGroups.map(({ role, label: groupLabel, addLabel }) => {
                const groupUsers = visible.filter(u => u.team === t.id && u.role === role)
                return (
                  <div key={role}>
                    <div className="flex items-center justify-between mb-2">
                      <p className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
                        {groupLabel}
                      </p>
                      <button onClick={() => openAddUser(role, t.id)}
                        className={`flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium ${c.bg} ${c.text} hover:opacity-80 transition-opacity`}>
                        <Plus className="w-3 h-3" /> {addLabel}
                      </button>
                    </div>
                    {groupUsers.length > 0
                      ? groupUsers.map(u => (
                          <UserRow
                            key={u.id}
                            u={u}
                            meId={me?.id}
                            teams={teams}
                            onUpdate={(id, nextRole, nextTeam) => void handleUpdateUser(id, nextRole, nextTeam)}
                            onDelete={(id) => void handleDeleteUser(id)}
                          />
                        ))
                      : <p className="text-xs text-muted-foreground py-1">No {groupLabel.toLowerCase()} assigned yet.</p>
                    }
                  </div>
                )
              })}
            </div>
          </div>
        )
      })}

      {unassigned.length > 0 && (
        <div className="hub-card">
          <h2 className="text-sm font-semibold text-foreground mb-3">Unassigned users</h2>
          {unassigned.map(u => (
            <UserRow
              key={u.id}
              u={u}
              meId={me?.id}
              teams={teams}
              onUpdate={(id, role, team) => void handleUpdateUser(id, role, team)}
              onDelete={(id) => void handleDeleteUser(id)}
            />
          ))}
        </div>
      )}

      <Dialog open={userDialog.open} onOpenChange={open => setUserDialog(d => ({ ...d, open }))}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add {ROLE_LABEL[userDialog.role]}</DialogTitle>
          </DialogHeader>
          <div className="flex gap-2 mb-1">
            {userDialogTeamName && userDialogTeamColor
              ? <span className={`hub-badge ${userDialogTeamColor.bg} ${userDialogTeamColor.text}`}>
                  {userDialogTeamName} Team
                </span>
              : <span className="hub-badge bg-muted text-muted-foreground">No team</span>
            }
            <span className="hub-badge bg-primary/10 text-primary">{ROLE_LABEL[userDialog.role]}</span>
          </div>
          <div className="space-y-3">
            <div>
              <label className="hub-label">Full name *</label>
              <input className="hub-input" value={userDialog.form.full_name}
                onChange={e => setUserDialog(d => ({ ...d, form: { ...d.form, full_name: e.target.value } }))}
                placeholder="Dr. Full Name" />
            </div>
            <div>
              <label className="hub-label">Email *</label>
              <input className="hub-input" type="email" value={userDialog.form.email}
                onChange={e => setUserDialog(d => ({ ...d, form: { ...d.form, email: e.target.value } }))}
                placeholder="name@parul.ac.in" />
            </div>
            <div>
              <label className="hub-label">Password *</label>
              <input className="hub-input" type="password" value={userDialog.form.password}
                onChange={e => setUserDialog(d => ({ ...d, form: { ...d.form, password: e.target.value } }))}
                placeholder="Set a password" />
            </div>
            <div>
              <label className="hub-label">Department</label>
              <input className="hub-input" value={userDialog.form.department}
                onChange={e => setUserDialog(d => ({ ...d, form: { ...d.form, department: e.target.value } }))}
                placeholder="e.g. Engineering" />
            </div>
            {userDialog.error && (
              <p className="text-sm text-destructive bg-destructive/10 px-3 py-2 rounded-lg">{userDialog.error}</p>
            )}
            <div className="flex gap-3 pt-1">
              <button onClick={() => void submitUser()}
                className="flex-1 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-brand-dark transition-colors">
                Add user
              </button>
              <button onClick={() => setUserDialog(d => ({ ...d, open: false }))}
                className="px-4 py-2 rounded-lg border border-border text-sm text-muted-foreground hover:bg-accent transition-colors">
                Cancel
              </button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={teamDialog.open} onOpenChange={open => setTeamDialog(d => ({ ...d, open }))}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Create new team</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <label className="hub-label">Team name *</label>
              <input className="hub-input" value={teamDialog.name}
                onChange={e => setTeamDialog(d => ({ ...d, name: e.target.value, error: '' }))}
                placeholder="e.g. Marketing" />
            </div>
            <div>
              <label className="hub-label">Team color</label>
              <div className="flex gap-2 mt-1.5">
                {CUSTOM_COLORS.map(col => (
                  <button key={col.id} onClick={() => setTeamDialog(d => ({ ...d, color: col.id }))}
                    className={`w-7 h-7 rounded-full ${col.dot} transition-all ${
                      teamDialog.color === col.id ? 'ring-2 ring-offset-2 ring-foreground scale-110' : 'opacity-70 hover:opacity-100'
                    }`} />
                ))}
              </div>
            </div>
            {teamDialog.error && (
              <p className="text-sm text-destructive bg-destructive/10 px-3 py-2 rounded-lg">{teamDialog.error}</p>
            )}
            <div className="flex gap-3">
              <button onClick={() => void submitTeam()}
                className="flex-1 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-brand-dark transition-colors">
                Create team
              </button>
              <button onClick={() => setTeamDialog(d => ({ ...d, open: false }))}
                className="px-4 py-2 rounded-lg border border-border text-sm text-muted-foreground hover:bg-accent transition-colors">
                Cancel
              </button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
