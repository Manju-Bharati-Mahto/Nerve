import { useState, useMemo } from 'react'
import { useAuth } from '@/hooks/useAuth'
import { useAppData } from '@/hooks/useAppData'
import { getErrorMessage } from '@/lib/error-utils'
import { BRANDING_TYPES } from '@/lib/constants'
import { Palette, Trophy, Handshake, Star, Users, Download, PlusCircle, Search, Plus } from 'lucide-react'
import { Link } from 'react-router-dom'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import type { AppRole } from '@/lib/constants'

const BLANK = { full_name: '', email: '', password: '', department: '' }

export default function BrandingAdminDashboard() {
  const { profile } = useAuth()
  const { entries: allEntries, users: allUsers, addUser } = useAppData()

  // dialog state — managedBy is set to a lead's ID when adding a member under that lead
  const [dialog, setDialog] = useState<{
    open: boolean
    role: AppRole
    managedBy: string | null
    leadName: string
    form: typeof BLANK
    error: string
  }>({ open: false, role: 'user', managedBy: null, leadName: '', form: BLANK, error: '' })

  function openAddLead() {
    setDialog({ open: true, role: 'sub_admin', managedBy: null, leadName: '', form: BLANK, error: '' })
  }

  function openAddMember(leadId: string, leadName: string) {
    setDialog({ open: true, role: 'user', managedBy: leadId, leadName, form: BLANK, error: '' })
  }

  async function submitAdd() {
    const { form, role, managedBy } = dialog
    if (!form.full_name.trim() || !form.email.trim() || !form.password.trim()) {
      setDialog(d => ({ ...d, error: 'Name, email and password are required.' }))
      return
    }
    if (allUsers.find(u => u.email.toLowerCase() === form.email.toLowerCase())) {
      setDialog(d => ({ ...d, error: 'An account with this email already exists.' }))
      return
    }
    try {
      await addUser({
        full_name: form.full_name.trim(), email: form.email.trim(),
        password: form.password, department: form.department.trim(),
        role, team: 'branding', managed_by: managedBy,
      })
      setDialog(d => ({ ...d, open: false }))
    } catch (err: unknown) {
      setDialog(d => ({ ...d, error: getErrorMessage(err, 'Failed to add user.') }))
    }
  }

  const brandingEntries = useMemo(
    () => allEntries.filter(e => (BRANDING_TYPES as readonly string[]).includes(e.type)),
    [allEntries]
  )

  const teamUsers  = allUsers.filter(u => u.team === 'branding' && u.role !== 'super_admin' && u.role !== 'admin')
  const subAdmins  = teamUsers.filter(u => u.role === 'sub_admin')
  const members    = teamUsers.filter(u => u.role === 'user')
  const unassigned = members.filter(m => !m.managed_by || !subAdmins.find(s => s.id === m.managed_by))

  const stats = useMemo(() => {
    const now = new Date()
    return {
      total:      brandingEntries.length,
      thisMonth:  brandingEntries.filter(e => {
        const d = new Date(e.entry_date)
        return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear()
      }).length,
      highlights: brandingEntries.filter(e => e.priority === 'Key highlight').length,
      members:    teamUsers.length,
    }
  }, [brandingEntries, teamUsers])

  const typeData = useMemo(() =>
    BRANDING_TYPES.map(t => ({
      type: t.length > 12 ? t.slice(0, 12) + '…' : t,
      count: brandingEntries.filter(e => e.type === t).length,
    })).filter(d => d.count > 0),
    [brandingEntries]
  )

  const recent = brandingEntries.slice(0, 6)

  return (
    <div className="animate-fade-in space-y-6">

      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-pink-100 flex items-center justify-center">
          <Palette className="w-5 h-5 text-pink-600" />
        </div>
        <div>
          <h1 className="text-2xl font-serif text-foreground">Branding Team Dashboard</h1>
          <p className="text-sm text-muted-foreground">
            Welcome{profile?.full_name ? `, ${profile.full_name}` : ''}
          </p>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-4 gap-3">
        {[
          { label: 'Branding entries', value: stats.total,      icon: Palette,    bg: 'bg-pink-50',   color: 'text-pink-600' },
          { label: 'This month',       value: stats.thisMonth,  icon: Star,       bg: 'bg-amber-50',  color: 'text-amber-600' },
          { label: 'Key highlights',   value: stats.highlights, icon: Trophy,     bg: 'bg-purple-50', color: 'text-purple-600' },
          { label: 'Team members',     value: stats.members,    icon: Users,      bg: 'bg-blue-50',   color: 'text-blue-600' },
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

      <div className="grid grid-cols-3 gap-5">
        {/* Chart */}
        <div className="hub-card col-span-2">
          <div className="flex items-center gap-2 mb-4">
            <Handshake className="w-4 h-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold text-foreground">Entries by type</h2>
          </div>
          {typeData.length === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">No branding entries yet.</p>
          ) : (
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={typeData} margin={{ top: 4, right: 0, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                <XAxis dataKey="type" tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} tickLine={false} axisLine={false} />
                <YAxis tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} tickLine={false} axisLine={false} allowDecimals={false} width={24} />
                <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid hsl(var(--border))', background: 'hsl(var(--card))' }} cursor={{ fill: 'hsl(var(--accent))' }} />
                <Bar dataKey="count" fill="#ec4899" radius={[4, 4, 0, 0]} maxBarSize={40} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* Quick actions */}
        <div className="hub-card">
          <h2 className="text-sm font-semibold text-foreground mb-3">Quick actions</h2>
          {[
            { to: '/add',           icon: PlusCircle, label: 'Add entry',    desc: 'Log a branding update' },
            { to: '/browse',        icon: Search,     label: 'Browse all',   desc: 'Search all entries' },
            { to: '/branding/team', icon: Users,      label: 'Team members', desc: 'View your team' },
            { to: '/admin/export',  icon: Download,   label: 'Export data',  desc: 'Download as CSV/JSON' },
          ].map(({ to, icon: Icon, label, desc }) => (
            <Link key={to} to={to}
              className="flex items-center gap-3 p-3 rounded-lg hover:bg-accent transition-colors group">
              <div className="w-8 h-8 rounded-lg bg-muted flex items-center justify-center shrink-0 group-hover:bg-pink-50 transition-colors">
                <Icon className="w-4 h-4 text-muted-foreground group-hover:text-pink-600 transition-colors" />
              </div>
              <div>
                <p className="text-sm font-medium text-foreground">{label}</p>
                <p className="text-xs text-muted-foreground">{desc}</p>
              </div>
            </Link>
          ))}
        </div>
      </div>

      {/* Team management — hierarchical */}
      <div className="hub-card">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-sm font-semibold text-foreground">Team management</h2>
          <button onClick={openAddLead}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-pink-50 text-pink-700 hover:opacity-80 transition-opacity">
            <Plus className="w-3.5 h-3.5" /> Add Team Lead
          </button>
        </div>

        {subAdmins.length === 0 && (
          <p className="text-sm text-muted-foreground py-4 text-center">No team leads yet. Add one to get started.</p>
        )}

        <div className="space-y-3">
          {subAdmins.map(lead => {
            const leadMembers = members.filter(m => m.managed_by === lead.id)
            return (
              <div key={lead.id} className="border border-border rounded-xl overflow-hidden">
                {/* Lead row */}
                <div className="flex items-center gap-3 px-4 py-3 bg-teal-50/60 border-b border-border">
                  <div className="w-8 h-8 rounded-full bg-teal-100 flex items-center justify-center shrink-0">
                    <span className="text-xs font-semibold text-teal-700">
                      {(lead.full_name || lead.email)[0].toUpperCase()}
                    </span>
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-foreground truncate">{lead.full_name || 'Unnamed'}</p>
                    <p className="text-xs text-muted-foreground truncate">{lead.email}{lead.department ? ` · ${lead.department}` : ''}</p>
                  </div>
                  <span className="hub-badge bg-teal-100 text-teal-700 shrink-0">Team Lead</span>
                  <button onClick={() => openAddMember(lead.id, lead.full_name || lead.email)}
                    className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium bg-pink-50 text-pink-700 hover:opacity-80 transition-opacity shrink-0">
                    <Plus className="w-3 h-3" /> Add Member
                  </button>
                </div>

                {/* Members under this lead */}
                <div className="divide-y divide-border">
                  {leadMembers.length === 0 ? (
                    <p className="text-xs text-muted-foreground px-4 py-3">No members assigned to this lead yet.</p>
                  ) : (
                    leadMembers.map(m => (
                      <div key={m.id} className="flex items-center gap-3 px-4 py-2.5">
                        <div className="w-1.5 h-1.5 rounded-full bg-border shrink-0 ml-2" />
                        <div className="w-7 h-7 rounded-full bg-pink-100 flex items-center justify-center shrink-0">
                          <span className="text-xs font-semibold text-pink-700">
                            {(m.full_name || m.email)[0].toUpperCase()}
                          </span>
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium text-foreground truncate">{m.full_name || 'Unnamed'}</p>
                          <p className="text-xs text-muted-foreground truncate">{m.email}</p>
                        </div>
                        <span className="hub-badge bg-green-100 text-green-700 shrink-0">Member</span>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )
          })}
        </div>

        {/* Unassigned members */}
        {unassigned.length > 0 && (
          <div className="mt-4">
            <p className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground mb-2">
              Unassigned Members
            </p>
            {unassigned.map(m => (
              <div key={m.id} className="flex items-center gap-3 py-2.5 border-b border-border last:border-0">
                <div className="w-7 h-7 rounded-full bg-pink-100 flex items-center justify-center shrink-0">
                  <span className="text-xs font-semibold text-pink-700">
                    {(m.full_name || m.email)[0].toUpperCase()}
                  </span>
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-foreground truncate">{m.full_name || 'Unnamed'}</p>
                  <p className="text-xs text-muted-foreground truncate">{m.email}</p>
                </div>
                <span className="hub-badge bg-green-100 text-green-700 shrink-0">Member</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Recent entries */}
      <div className="hub-card">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-foreground">Recent branding entries</h2>
          <Link to="/browse" className="text-xs text-primary hover:underline">View all</Link>
        </div>
        {recent.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-4">No entries yet.</p>
        ) : (
          <div className="grid grid-cols-2 gap-x-6">
            {recent.map(e => (
              <div key={e.id} className="flex items-start justify-between gap-4 py-3 border-b border-border last:border-0">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-foreground truncate">{e.title}</p>
                  <div className="flex gap-1.5 mt-1 flex-wrap">
                    <span className="hub-badge bg-pink-50 text-pink-700">{e.type}</span>
                    <span className="hub-badge bg-primary/5 text-primary/70">{e.dept}</span>
                    {e.priority !== 'Normal' && (
                      <span className="hub-badge bg-amber-50 text-amber-700">{e.priority}</span>
                    )}
                  </div>
                </div>
                <span className="text-xs text-muted-foreground shrink-0 pt-0.5">{e.entry_date}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Dialog */}
      <Dialog open={dialog.open} onOpenChange={open => setDialog(d => ({ ...d, open }))}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {dialog.role === 'sub_admin' ? 'Add Team Lead' : `Add Member under ${dialog.leadName}`}
            </DialogTitle>
          </DialogHeader>
          <div className="flex gap-2 mb-1">
            <span className="hub-badge bg-pink-50 text-pink-700">Branding Team</span>
            <span className="hub-badge bg-primary/10 text-primary">
              {dialog.role === 'sub_admin' ? 'Team Lead' : 'Member'}
            </span>
            {dialog.leadName && (
              <span className="hub-badge bg-teal-50 text-teal-700">Under {dialog.leadName}</span>
            )}
          </div>
          <div className="space-y-3">
            <div>
              <label className="hub-label">Full name *</label>
              <input className="hub-input" value={dialog.form.full_name}
                onChange={e => setDialog(d => ({ ...d, form: { ...d.form, full_name: e.target.value } }))}
                placeholder="Dr. Full Name" />
            </div>
            <div>
              <label className="hub-label">Email *</label>
              <input className="hub-input" type="email" value={dialog.form.email}
                onChange={e => setDialog(d => ({ ...d, form: { ...d.form, email: e.target.value } }))}
                placeholder="name@parul.ac.in" />
            </div>
            <div>
              <label className="hub-label">Password *</label>
              <input className="hub-input" type="password" value={dialog.form.password}
                onChange={e => setDialog(d => ({ ...d, form: { ...d.form, password: e.target.value } }))}
                placeholder="Set a password" />
            </div>
            <div>
              <label className="hub-label">Department</label>
              <input className="hub-input" value={dialog.form.department}
                onChange={e => setDialog(d => ({ ...d, form: { ...d.form, department: e.target.value } }))}
                placeholder="e.g. Engineering" />
            </div>
            {dialog.error && (
              <p className="text-sm text-destructive bg-destructive/10 px-3 py-2 rounded-lg">{dialog.error}</p>
            )}
            <div className="flex gap-3 pt-1">
              <button onClick={() => void submitAdd()}
                className="flex-1 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-brand-dark transition-colors">
                Add user
              </button>
              <button onClick={() => setDialog(d => ({ ...d, open: false }))}
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
