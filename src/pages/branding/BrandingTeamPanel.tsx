import { useEffect, useState, useCallback } from 'react'
import { useAuth } from '@/hooks/useAuth'
import { useAppData } from '@/hooks/useAppData'
import { brandingApi } from '@/lib/branding-api'
import type { BrandingProject, MemberReportStatus } from '@/lib/branding-types'
import type { AppUser } from '@/lib/app-types'
import {
  Users, FolderKanban, Plus, Pencil, Trash2, X, Check,
  CalendarDays, UserPlus, ChevronDown, ChevronUp,
  ClipboardList, CheckCircle2, XCircle, RefreshCw,
} from 'lucide-react'

// ── Helpers ────────────────────────────────────────────────────────────────

const STATUS_LABELS: Record<BrandingProject['status'], string> = {
  active: 'Active',
  completed: 'Completed',
  on_hold: 'On Hold',
}
const STATUS_BADGE: Record<BrandingProject['status'], string> = {
  active: 'bg-green-100 text-green-700',
  completed: 'bg-blue-100 text-blue-700',
  on_hold: 'bg-yellow-100 text-yellow-700',
}

// ── Member Dialog ──────────────────────────────────────────────────────────

interface MemberFormState {
  full_name: string
  email: string
  password: string
  department: string
  role: 'user' | 'sub_admin'
}

function emptyMember(): MemberFormState {
  return { full_name: '', email: '', password: '', department: '', role: 'user' }
}

interface MemberDialogProps {
  mode: 'add' | 'edit'
  initial?: MemberFormState & { id: string }
  onSave: (data: MemberFormState) => Promise<void>
  onClose: () => void
}

function MemberDialog({ mode, initial, onSave, onClose }: MemberDialogProps) {
  const [form, setForm] = useState<MemberFormState>(
    initial ? { ...initial } : emptyMember()
  )
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!form.full_name.trim()) { setErr('Name is required.'); return }
    if (!form.email.trim()) { setErr('Email is required.'); return }
    if (mode === 'add' && !form.password.trim()) { setErr('Password is required.'); return }
    setSaving(true)
    setErr('')
    try {
      await onSave(form)
      onClose()
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Failed to save.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-card border border-border rounded-xl shadow-xl w-full max-w-md mx-4">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="text-sm font-semibold text-foreground">
            {mode === 'add' ? 'Add Team Member' : 'Edit Member'}
          </h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="w-4 h-4" />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground block mb-1">Full Name *</label>
              <input
                className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-background"
                value={form.full_name}
                onChange={e => setForm(f => ({ ...f, full_name: e.target.value }))}
                placeholder="Jane Doe"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground block mb-1">Department</label>
              <input
                className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-background"
                value={form.department}
                onChange={e => setForm(f => ({ ...f, department: e.target.value }))}
                placeholder="Design"
              />
            </div>
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground block mb-1">Email *</label>
            <input
              type="email"
              className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-background"
              value={form.email}
              onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
              placeholder="jane@example.com"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground block mb-1">
              {mode === 'add' ? 'Password *' : 'New Password (leave blank to keep)'}
            </label>
            <input
              type="password"
              className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-background"
              value={form.password}
              onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
              placeholder={mode === 'edit' ? 'Leave blank to keep current' : 'Min 6 characters'}
            />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground block mb-1">Role *</label>
            <select
              className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-background"
              value={form.role}
              onChange={e => setForm(f => ({ ...f, role: e.target.value as 'user' | 'sub_admin' }))}
            >
              <option value="user">Team Member</option>
              <option value="sub_admin">Team Lead</option>
            </select>
          </div>
          {err && <p className="text-xs text-red-500">{err}</p>}
          <div className="flex gap-2 justify-end pt-1">
            <button type="button" onClick={onClose}
              className="px-4 py-2 text-sm rounded-lg border border-border text-muted-foreground hover:bg-accent">
              Cancel
            </button>
            <button type="submit" disabled={saving}
              className="px-4 py-2 text-sm rounded-lg bg-pink-600 text-white hover:bg-pink-700 disabled:opacity-50">
              {saving ? 'Saving…' : mode === 'add' ? 'Add Member' : 'Save Changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ── Project Dialog ─────────────────────────────────────────────────────────

interface ProjectFormState {
  name: string
  description: string
  deadline: string
  status: BrandingProject['status']
  assigned_user_ids: string[]
}

function emptyProject(): ProjectFormState {
  return { name: '', description: '', deadline: '', status: 'active', assigned_user_ids: [] }
}

interface ProjectDialogProps {
  mode: 'add' | 'edit'
  initial?: ProjectFormState & { id: string }
  members: AppUser[]
  onSave: (data: ProjectFormState) => Promise<void>
  onClose: () => void
}

function ProjectDialog({ mode, initial, members, onSave, onClose }: ProjectDialogProps) {
  const [form, setForm] = useState<ProjectFormState>(
    initial ? { ...initial } : emptyProject()
  )
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')
  const [memberOpen, setMemberOpen] = useState(false)

  function toggleMember(id: string) {
    setForm(f => ({
      ...f,
      assigned_user_ids: f.assigned_user_ids.includes(id)
        ? f.assigned_user_ids.filter(uid => uid !== id)
        : [...f.assigned_user_ids, id],
    }))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!form.name.trim()) { setErr('Project name is required.'); return }
    setSaving(true)
    setErr('')
    try {
      await onSave(form)
      onClose()
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Failed to save.')
    } finally {
      setSaving(false)
    }
  }

  const selectedNames = members
    .filter(m => form.assigned_user_ids.includes(m.id))
    .map(m => m.full_name || m.email)

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-card border border-border rounded-xl shadow-xl w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border sticky top-0 bg-card">
          <h2 className="text-sm font-semibold text-foreground">
            {mode === 'add' ? 'New Project' : 'Edit Project'}
          </h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="w-4 h-4" />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          <div>
            <label className="text-xs font-medium text-muted-foreground block mb-1">Project Name *</label>
            <input
              className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-background"
              value={form.name}
              onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              placeholder="Annual Brochure Design"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground block mb-1">Description</label>
            <textarea
              className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-background resize-none"
              rows={3}
              value={form.description}
              onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
              placeholder="Brief description of the project…"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground block mb-1">Deadline</label>
              <input
                type="date"
                className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-background"
                value={form.deadline}
                onChange={e => setForm(f => ({ ...f, deadline: e.target.value }))}
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground block mb-1">Status</label>
              <select
                className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-background"
                value={form.status}
                onChange={e => setForm(f => ({ ...f, status: e.target.value as BrandingProject['status'] }))}
              >
                <option value="active">Active</option>
                <option value="on_hold">On Hold</option>
                <option value="completed">Completed</option>
              </select>
            </div>
          </div>
          {/* Assign members */}
          <div>
            <label className="text-xs font-medium text-muted-foreground block mb-1">Assign Members</label>
            <button
              type="button"
              onClick={() => setMemberOpen(o => !o)}
              className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-background text-left flex justify-between items-center"
            >
              <span className={selectedNames.length ? 'text-foreground' : 'text-muted-foreground'}>
                {selectedNames.length
                  ? selectedNames.slice(0, 3).join(', ') + (selectedNames.length > 3 ? ` +${selectedNames.length - 3} more` : '')
                  : 'Select members…'}
              </span>
              {memberOpen ? <ChevronUp className="w-4 h-4 shrink-0" /> : <ChevronDown className="w-4 h-4 shrink-0" />}
            </button>
            {memberOpen && (
              <div className="border border-border rounded-lg mt-1 max-h-44 overflow-y-auto bg-background">
                {members.length === 0 && (
                  <p className="text-xs text-muted-foreground px-3 py-2">No team members yet.</p>
                )}
                {members.map(m => (
                  <label key={m.id} className="flex items-center gap-2.5 px-3 py-2 hover:bg-accent cursor-pointer">
                    <input
                      type="checkbox"
                      checked={form.assigned_user_ids.includes(m.id)}
                      onChange={() => toggleMember(m.id)}
                      className="rounded"
                    />
                    <span className="text-sm text-foreground">{m.full_name || m.email}</span>
                    <span className="ml-auto text-[11px] text-muted-foreground">
                      {m.role === 'sub_admin' ? 'Lead' : 'Member'}
                    </span>
                  </label>
                ))}
              </div>
            )}
          </div>
          {err && <p className="text-xs text-red-500">{err}</p>}
          <div className="flex gap-2 justify-end pt-1">
            <button type="button" onClick={onClose}
              className="px-4 py-2 text-sm rounded-lg border border-border text-muted-foreground hover:bg-accent">
              Cancel
            </button>
            <button type="submit" disabled={saving}
              className="px-4 py-2 text-sm rounded-lg bg-pink-600 text-white hover:bg-pink-700 disabled:opacity-50">
              {saving ? 'Saving…' : mode === 'add' ? 'Create Project' : 'Save Changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ── Report Status Tab ──────────────────────────────────────────────────────

function todayIso() {
  return new Date().toISOString().slice(0, 10)
}

function ReportStatusTab({ members }: { members: AppUser[] }) {
  const [date, setDate] = useState(todayIso)
  const [statuses, setStatuses] = useState<MemberReportStatus[]>([])
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')

  const load = useCallback((d: string) => {
    setLoading(true)
    setErr('')
    brandingApi.getTeamReportStatus(d)
      .then(r => setStatuses(r.statuses))
      .catch(e => setErr(e instanceof Error ? e.message : 'Failed to load.'))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { load(date) }, [load, date])

  const submitted = statuses.filter(s => s.has_submitted).length
  const total = statuses.length

  return (
    <div className="space-y-4">
      {/* Date picker + refresh */}
      <div className="flex items-center gap-3 flex-wrap">
        <div>
          <label className="text-xs font-medium text-muted-foreground block mb-1">Select Date</label>
          <input
            type="date"
            max={todayIso()}
            value={date}
            onChange={e => setDate(e.target.value)}
            className="border border-border rounded-lg px-3 py-2 text-sm bg-background"
          />
        </div>
        <button
          onClick={() => load(date)}
          disabled={loading}
          className="mt-5 flex items-center gap-1.5 px-3 py-2 text-sm rounded-lg border border-border text-muted-foreground hover:bg-accent disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
        {!loading && total > 0 && (
          <div className="mt-5 flex items-center gap-2">
            <span className="text-xs font-medium text-green-700 bg-green-100 px-2.5 py-1 rounded-full">
              {submitted} submitted
            </span>
            <span className="text-xs font-medium text-red-700 bg-red-100 px-2.5 py-1 rounded-full">
              {total - submitted} pending
            </span>
          </div>
        )}
      </div>

      {err && <p className="text-xs text-red-500">{err}</p>}

      {/* Status list */}
      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : statuses.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-6">No team members found.</p>
      ) : (
        <div className="hub-card divide-y divide-border">
          {/* Only show regular members (role=user) under "Members", leads under "Team Leads" */}
          {(['sub_admin', 'user'] as const).map(r => {
            const group = statuses.filter(s => s.role === r)
            if (group.length === 0) return null
            return (
              <div key={r} className="py-3 first:pt-0 last:pb-0">
                <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-2 px-1">
                  {r === 'sub_admin' ? 'Team Leads' : 'Members'}
                </p>
                <div className="space-y-1">
                  {group.map(s => (
                    <div key={s.user_id} className="flex items-center justify-between py-2 px-1">
                      <div className="flex items-center gap-3">
                        <div className="w-7 h-7 rounded-full bg-pink-100 flex items-center justify-center shrink-0">
                          <span className="text-xs font-semibold text-pink-600">
                            {(s.user_name || s.user_email)[0].toUpperCase()}
                          </span>
                        </div>
                        <div>
                          <p className="text-sm font-medium text-foreground">{s.user_name || 'Unnamed'}</p>
                          <p className="text-xs text-muted-foreground">{s.user_email}</p>
                        </div>
                      </div>
                      {s.has_submitted ? (
                        <div className="flex items-center gap-1.5 text-green-700 bg-green-50 px-2.5 py-1 rounded-full">
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          <span className="text-xs font-medium">Submitted</span>
                        </div>
                      ) : (
                        <div className="flex items-center gap-1.5 text-red-600 bg-red-50 px-2.5 py-1 rounded-full">
                          <XCircle className="w-3.5 h-3.5" />
                          <span className="text-xs font-medium">Not submitted</span>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── Main Component ─────────────────────────────────────────────────────────

export default function BrandingTeamPanel() {
  const { role, user } = useAuth()
  const { users: allUsers, addUser, updateUser, deleteUser } = useAppData()
  const isAdmin = role === 'admin' || role === 'super_admin'
  const isLead = role === 'sub_admin'

  // Branding members only (excluding super_admin; team lead excludes self)
  const members = allUsers.filter(u =>
    u.team === 'branding' &&
    u.role !== 'super_admin' &&
    (isAdmin ? true : u.id !== user?.id)
  )

  const [tab, setTab] = useState<'members' | 'report-status' | 'projects'>('members')

  // ── Members state ─────────────────────────────────────────────────────
  const [memberDialog, setMemberDialog] = useState<null | 'add' | { mode: 'edit'; member: AppUser }>(null)
  const [deleteTarget, setDeleteTarget] = useState<AppUser | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState(false)

  // ── Projects state ────────────────────────────────────────────────────
  const [projects, setProjects] = useState<BrandingProject[]>([])
  const [projLoading, setProjLoading] = useState(true)
  const [projDialog, setProjDialog] = useState<null | 'add' | { mode: 'edit'; project: BrandingProject }>(null)
  const [deleteProjTarget, setDeleteProjTarget] = useState<BrandingProject | null>(null)

  useEffect(() => {
    if (isAdmin) {
      brandingApi.getProjects()
        .then(r => setProjects(r.projects))
        .catch(() => {})
        .finally(() => setProjLoading(false))
    }
  }, [isAdmin])

  // ── Member handlers ───────────────────────────────────────────────────

  async function handleAddMember(data: MemberFormState) {
    await addUser({
      full_name: data.full_name,
      email: data.email,
      password: data.password,
      department: data.department,
      role: data.role,
      team: 'branding',
      managed_by: user?.id ?? null,
    })
  }

  async function handleEditMember(data: MemberFormState & { id?: string }, memberId: string) {
    const patch: Record<string, unknown> = {
      full_name: data.full_name,
      email: data.email,
      department: data.department,
      role: data.role,
    }
    if (data.password) patch.password = data.password
    await updateUser(memberId, patch as Parameters<typeof updateUser>[1])
  }

  async function handleDeleteMember() {
    if (!deleteTarget) return
    await deleteUser(deleteTarget.id)
    setDeleteTarget(null)
    setDeleteConfirm(false)
  }

  // ── Project handlers ──────────────────────────────────────────────────

  async function handleAddProject(data: ProjectFormState) {
    const { project } = await brandingApi.createProject({
      name: data.name,
      description: data.description,
      deadline: data.deadline || undefined,
      assigned_user_ids: data.assigned_user_ids,
    })
    setProjects(ps => [project, ...ps])
  }

  async function handleEditProject(data: ProjectFormState, projectId: string) {
    const { project } = await brandingApi.updateProject(projectId, {
      name: data.name,
      description: data.description,
      deadline: data.deadline || undefined,
      status: data.status,
      assigned_user_ids: data.assigned_user_ids,
    })
    setProjects(ps => ps.map(p => p.id === projectId ? project : p))
  }

  async function handleDeleteProject() {
    if (!deleteProjTarget) return
    await brandingApi.deleteProject(deleteProjTarget.id)
    setProjects(ps => ps.filter(p => p.id !== deleteProjTarget.id))
    setDeleteProjTarget(null)
  }

  // ── Render ─────────────────────────────────────────────────────────────

  const teamLeads = members.filter(m => m.role === 'sub_admin')
  const teamMembers = members.filter(m => m.role === 'user')

  return (
    <div className="animate-fade-in space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-serif text-foreground">
            {isLead ? 'My Team' : 'Team Management'}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {isLead ? 'Branding team — members & daily report status' : 'Branding team — members & projects'}
          </p>
        </div>
        {isAdmin && tab === 'members' && (
          <button
            onClick={() => setMemberDialog('add')}
            className="flex items-center gap-2 px-4 py-2 bg-pink-600 text-white rounded-lg text-sm hover:bg-pink-700"
          >
            <UserPlus className="w-4 h-4" />
            Add Member
          </button>
        )}
        {isAdmin && tab === 'projects' && (
          <button
            onClick={() => setProjDialog('add')}
            className="flex items-center gap-2 px-4 py-2 bg-pink-600 text-white rounded-lg text-sm hover:bg-pink-700"
          >
            <Plus className="w-4 h-4" />
            New Project
          </button>
        )}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-border">
        <button
          onClick={() => setTab('members')}
          className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
            tab === 'members' ? 'border-pink-600 text-pink-600' : 'border-transparent text-muted-foreground hover:text-foreground'
          }`}
        >
          <Users className="w-4 h-4" />
          Members ({members.length})
        </button>
        <button
          onClick={() => setTab('report-status')}
          className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
            tab === 'report-status' ? 'border-pink-600 text-pink-600' : 'border-transparent text-muted-foreground hover:text-foreground'
          }`}
        >
          <ClipboardList className="w-4 h-4" />
          Daily Report Status
        </button>
        {isAdmin && (
          <button
            onClick={() => setTab('projects')}
            className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
              tab === 'projects' ? 'border-pink-600 text-pink-600' : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            <FolderKanban className="w-4 h-4" />
            Projects ({projects.length})
          </button>
        )}
      </div>

      {/* ── Members Tab ── */}
      {tab === 'members' && (
        <div className="space-y-5">
          <MemberGroup
            label="Team Leads"
            badge="bg-teal-100 text-teal-700"
            items={teamLeads}
            isAdmin={isAdmin}
            onEdit={m => setMemberDialog({ mode: 'edit', member: m })}
            onDelete={m => { setDeleteTarget(m); setDeleteConfirm(false) }}
          />
          <MemberGroup
            label="Members"
            badge="bg-pink-100 text-pink-700"
            items={teamMembers}
            isAdmin={isAdmin}
            onEdit={m => setMemberDialog({ mode: 'edit', member: m })}
            onDelete={m => { setDeleteTarget(m); setDeleteConfirm(false) }}
          />
          {members.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-8">
              No members yet.{isAdmin ? ' Click "Add Member" to get started.' : ''}
            </p>
          )}
        </div>
      )}

      {/* ── Report Status Tab ── */}
      {tab === 'report-status' && <ReportStatusTab members={members} />}

      {/* ── Projects Tab ── */}
      {tab === 'projects' && (
        <div className="space-y-3">
          {projLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
          {!projLoading && projects.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-8">
              No projects yet.{isAdmin ? ' Click "New Project" to create one.' : ''}
            </p>
          )}
          {projects.map(proj => (
            <ProjectCard
              key={proj.id}
              project={proj}
              members={allUsers}
              isAdmin={isAdmin}
              onEdit={() => setProjDialog({ mode: 'edit', project: proj })}
              onDelete={() => setDeleteProjTarget(proj)}
            />
          ))}
        </div>
      )}

      {/* ── Member Dialog ── */}
      {memberDialog === 'add' && (
        <MemberDialog mode="add" onSave={handleAddMember} onClose={() => setMemberDialog(null)} />
      )}
      {memberDialog !== null && memberDialog !== 'add' && memberDialog.mode === 'edit' && (
        <MemberDialog
          mode="edit"
          initial={{
            id: memberDialog.member.id,
            full_name: memberDialog.member.full_name,
            email: memberDialog.member.email,
            password: '',
            department: memberDialog.member.department,
            role: memberDialog.member.role === 'sub_admin' ? 'sub_admin' : 'user',
          }}
          onSave={data => handleEditMember(data, memberDialog.member.id)}
          onClose={() => setMemberDialog(null)}
        />
      )}

      {/* ── Delete Member Confirm ── */}
      {deleteTarget && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-card border border-border rounded-xl shadow-xl w-full max-w-sm mx-4 p-6 space-y-4">
            <h2 className="text-sm font-semibold text-foreground">Remove Member</h2>
            <p className="text-sm text-muted-foreground">
              Remove <span className="font-medium text-foreground">{deleteTarget.full_name || deleteTarget.email}</span> from the branding team?
              This cannot be undone.
            </p>
            {!deleteConfirm && (
              <div className="flex gap-2 justify-end">
                <button onClick={() => setDeleteTarget(null)}
                  className="px-4 py-2 text-sm rounded-lg border border-border text-muted-foreground hover:bg-accent">
                  Cancel
                </button>
                <button onClick={() => setDeleteConfirm(true)}
                  className="px-4 py-2 text-sm rounded-lg bg-red-600 text-white hover:bg-red-700">
                  Remove
                </button>
              </div>
            )}
            {deleteConfirm && (
              <div className="space-y-2">
                <p className="text-xs text-red-500 font-medium">Are you sure? This will permanently delete their account.</p>
                <div className="flex gap-2 justify-end">
                  <button onClick={() => { setDeleteTarget(null); setDeleteConfirm(false) }}
                    className="px-4 py-2 text-sm rounded-lg border border-border text-muted-foreground hover:bg-accent">
                    Cancel
                  </button>
                  <button onClick={handleDeleteMember}
                    className="px-4 py-2 text-sm rounded-lg bg-red-600 text-white hover:bg-red-700">
                    Yes, Delete
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Project Dialog ── */}
      {projDialog === 'add' && (
        <ProjectDialog mode="add" members={members} onSave={handleAddProject} onClose={() => setProjDialog(null)} />
      )}
      {projDialog !== null && projDialog !== 'add' && projDialog.mode === 'edit' && (
        <ProjectDialog
          mode="edit"
          initial={{
            id: projDialog.project.id,
            name: projDialog.project.name,
            description: projDialog.project.description,
            deadline: projDialog.project.deadline ?? '',
            status: projDialog.project.status,
            assigned_user_ids: projDialog.project.assigned_user_ids,
          }}
          members={members}
          onSave={data => handleEditProject(data, projDialog.project.id)}
          onClose={() => setProjDialog(null)}
        />
      )}

      {/* ── Delete Project Confirm ── */}
      {deleteProjTarget && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-card border border-border rounded-xl shadow-xl w-full max-w-sm mx-4 p-6 space-y-4">
            <h2 className="text-sm font-semibold text-foreground">Delete Project</h2>
            <p className="text-sm text-muted-foreground">
              Delete <span className="font-medium text-foreground">"{deleteProjTarget.name}"</span>?
              This cannot be undone.
            </p>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setDeleteProjTarget(null)}
                className="px-4 py-2 text-sm rounded-lg border border-border text-muted-foreground hover:bg-accent">
                Cancel
              </button>
              <button onClick={handleDeleteProject}
                className="px-4 py-2 text-sm rounded-lg bg-red-600 text-white hover:bg-red-700">
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── MemberGroup sub-component ──────────────────────────────────────────────

function MemberGroup({
  label, badge, items, isAdmin, onEdit, onDelete
}: {
  label: string
  badge: string
  items: AppUser[]
  isAdmin: boolean
  onEdit: (m: AppUser) => void
  onDelete: (m: AppUser) => void
}) {
  if (items.length === 0) return null
  return (
    <div className="hub-card">
      <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-3 px-1">{label}</p>
      <div className="space-y-1">
        {items.map(m => (
          <div key={m.id} className="flex items-center justify-between py-2.5 px-1 border-b border-border last:border-0">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-full bg-pink-100 flex items-center justify-center shrink-0">
                <span className="text-xs font-semibold text-pink-600">
                  {(m.full_name || m.email)[0].toUpperCase()}
                </span>
              </div>
              <div>
                <p className="text-sm font-medium text-foreground">{m.full_name || 'Unnamed'}</p>
                <p className="text-xs text-muted-foreground">{m.email}{m.department ? ` · ${m.department}` : ''}</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className={`hub-badge ${badge}`}>{label.split(' ')[0]}</span>
              {isAdmin && (
                <>
                  <button
                    onClick={() => onEdit(m)}
                    className="p-1.5 rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
                    title="Edit"
                  >
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => onDelete(m)}
                    className="p-1.5 rounded-lg text-muted-foreground hover:bg-red-50 hover:text-red-600 transition-colors"
                    title="Remove"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── ProjectCard sub-component ──────────────────────────────────────────────

function ProjectCard({
  project, members, isAdmin, onEdit, onDelete
}: {
  project: BrandingProject
  members: AppUser[]
  isAdmin: boolean
  onEdit: () => void
  onDelete: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const assignedMembers = members.filter(m => project.assigned_user_ids.includes(m.id))

  return (
    <div className="hub-card">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-sm font-semibold text-foreground">{project.name}</h3>
            <span className={`hub-badge ${STATUS_BADGE[project.status]}`}>
              {STATUS_LABELS[project.status]}
            </span>
          </div>
          {project.description && (
            <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{project.description}</p>
          )}
          <div className="flex items-center gap-4 mt-2">
            {project.deadline && (
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                <CalendarDays className="w-3 h-3" />
                {new Date(project.deadline).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
              </span>
            )}
            <button
              onClick={() => setExpanded(e => !e)}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              <Users className="w-3 h-3" />
              {assignedMembers.length} assigned
              {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            </button>
          </div>
        </div>
        {isAdmin && (
          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={onEdit}
              className="p-1.5 rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
              title="Edit project"
            >
              <Pencil className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={onDelete}
              className="p-1.5 rounded-lg text-muted-foreground hover:bg-red-50 hover:text-red-600 transition-colors"
              title="Delete project"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </div>

      {expanded && (
        <div className="mt-3 pt-3 border-t border-border">
          {assignedMembers.length === 0 ? (
            <p className="text-xs text-muted-foreground">No members assigned.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {assignedMembers.map(m => (
                <div key={m.id} className="flex items-center gap-1.5 px-2.5 py-1 bg-pink-50 rounded-full">
                  <Check className="w-3 h-3 text-pink-600" />
                  <span className="text-xs font-medium text-pink-700">{m.full_name || m.email}</span>
                  <span className="text-[10px] text-pink-400">
                    {m.role === 'sub_admin' ? 'Lead' : 'Member'}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
