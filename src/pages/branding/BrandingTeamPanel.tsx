import { useEffect, useState, useCallback } from 'react'
import { useAuth } from '@/hooks/useAuth'
import { useAppData } from '@/hooks/useAppData'
import { brandingApi } from '@/lib/branding-api'
import type { BrandingProject, MemberReportStatus } from '@/lib/branding-types'
import type { AppUser } from '@/lib/app-types'
import {
  Users, FolderKanban, Plus, Pencil, Trash2, X, Check,
  CalendarDays, UserPlus, ChevronDown, ChevronUp,
  CheckCircle2, XCircle,
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
              className="px-4 py-2 text-sm rounded-lg text-white disabled:opacity-50" style={{ background: '#1a472a' }}>
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
              className="px-4 py-2 text-sm rounded-lg text-white disabled:opacity-50" style={{ background: '#1a472a' }}>
              {saving ? 'Saving…' : mode === 'add' ? 'Create Project' : 'Save Changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

function todayIso() {
  return new Date().toISOString().slice(0, 10)
}

// ── Main Component ─────────────────────────────────────────────────────────

export default function BrandingTeamPanel() {
  const { role, user } = useAuth()
  const { users: allUsers, addUser, updateUser, deleteUser } = useAppData()
  const isAdmin = role === 'admin' || role === 'super_admin'
  const isLead = role === 'sub_admin'

  // Branding members only
  // - admin/super_admin: all branding members
  // - sub_admin (lead): members they manage + themselves (so their own report is visible)
  const members = allUsers.filter(u =>
    u.team === 'branding' &&
    u.role !== 'super_admin' &&
    (isAdmin
      ? true
      : isLead
        ? u.managed_by === user?.id || u.id === user?.id
        : u.id !== user?.id)
  )

  const [tab, setTab] = useState<'members' | 'projects'>('members')

  // ── Report statuses — date-filtered ──────────────────────────────────
  const [filterDate, setFilterDate] = useState(todayIso)
  const [todayStatuses, setTodayStatuses] = useState<MemberReportStatus[]>([])
  const [statusLoading, setStatusLoading] = useState(false)

  const loadStatuses = useCallback((d: string) => {
    setStatusLoading(true)
    brandingApi.getTeamReportStatus(d)
      .then(r => setTodayStatuses(r.statuses))
      .catch(() => {})
      .finally(() => setStatusLoading(false))
  }, [])

  useEffect(() => { loadStatuses(filterDate) }, [loadStatuses, filterDate])

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

  async function handleAssignMember(memberId: string, leadId: string | null) {
    await updateUser(memberId, { managed_by: leadId })
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
          <h1 className="text-3xl font-extrabold font-serif" style={{ color: '#1a472a' }}>
            {isLead ? 'My Team' : 'Team Management'}
          </h1>
          <p className="text-sm font-semibold mt-0.5" style={{ color: '#52b788' }}>
            {isLead ? 'Branding team — members & daily report status' : 'Branding team — members & projects'}
          </p>
        </div>
        {isAdmin && tab === 'members' && (
          <button
            onClick={() => setMemberDialog('add')}
            className="flex items-center gap-2 px-4 py-2 text-white rounded-xl text-sm font-semibold"
            style={{ background: '#1a472a' }}
          >
            <UserPlus className="w-4 h-4" />
            Add Member
          </button>
        )}
        {isAdmin && tab === 'projects' && (
          <button
            onClick={() => setProjDialog('add')}
            className="flex items-center gap-2 px-4 py-2 text-white rounded-xl text-sm font-semibold"
            style={{ background: '#1a472a' }}
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
            tab === 'members' ? 'border-[#1a472a] text-[#1a472a]' : 'border-transparent text-muted-foreground hover:text-foreground'
          }`}
        >
          <Users className="w-4 h-4" />
          Members ({members.length})
        </button>
        {isAdmin && (
          <button
            onClick={() => setTab('projects')}
            className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
              tab === 'projects' ? 'border-[#1a472a] text-[#1a472a]' : 'border-transparent text-muted-foreground hover:text-foreground'
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
          {/* Date filter + summary */}
          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex items-center gap-2 bg-white border border-gray-200 rounded-xl px-3 py-2">
              <CalendarDays className="w-4 h-4 shrink-0" style={{ color: '#52b788' }} />
              <input
                type="date"
                max={todayIso()}
                value={filterDate}
                onChange={e => setFilterDate(e.target.value)}
                className="text-sm bg-transparent outline-none cursor-pointer"
                style={{ color: '#1a472a' }}
              />
            </div>
            {statusLoading ? (
              <span className="text-xs font-medium text-gray-400 animate-pulse">Loading…</span>
            ) : todayStatuses.length > 0 && (
              <>
                <span className="flex items-center gap-1 text-xs font-semibold text-green-700 bg-green-50 px-3 py-1.5 rounded-full">
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  {todayStatuses.filter(s => s.has_submitted).length} submitted
                </span>
                <span className="flex items-center gap-1 text-xs font-semibold text-red-600 bg-red-50 px-3 py-1.5 rounded-full">
                  <XCircle className="w-3.5 h-3.5" />
                  {todayStatuses.filter(s => !s.has_submitted).length} pending
                </span>
              </>
            )}
          </div>

          <MemberGroup
            label="Team Leads"
            items={teamLeads}
            isAdmin={isAdmin}
            statuses={todayStatuses}
            loading={statusLoading}
            currentUserId={user?.id}
            teamLeads={teamLeads}
            onEdit={m => setMemberDialog({ mode: 'edit', member: m })}
            onDelete={m => { setDeleteTarget(m); setDeleteConfirm(false) }}
            onAssign={handleAssignMember}
          />
          <MemberGroup
            label="Members"
            items={teamMembers}
            isAdmin={isAdmin}
            statuses={todayStatuses}
            loading={statusLoading}
            currentUserId={user?.id}
            teamLeads={teamLeads}
            onEdit={m => setMemberDialog({ mode: 'edit', member: m })}
            onDelete={m => { setDeleteTarget(m); setDeleteConfirm(false) }}
            onAssign={handleAssignMember}
          />
          {members.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-8">
              No members yet.{isAdmin ? ' Click "Add Member" to get started.' : ''}
            </p>
          )}
        </div>
      )}

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
  label, items, isAdmin, statuses, loading, currentUserId, teamLeads, onEdit, onDelete, onAssign
}: {
  label: string
  items: AppUser[]
  isAdmin: boolean
  statuses: MemberReportStatus[]
  loading: boolean
  currentUserId?: string
  teamLeads: AppUser[]
  onEdit: (m: AppUser) => void
  onDelete: (m: AppUser) => void
  onAssign: (memberId: string, leadId: string | null) => Promise<void>
}) {
  if (items.length === 0) return null
  return (
    <div>
      <p className="text-[11px] font-bold uppercase tracking-widest mb-4 px-1" style={{ color: '#52b788' }}>{label}</p>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
        {items.map(m => {
          const status = statuses.find(s => s.user_id === m.id)
          const isLead = m.role === 'sub_admin'
          const isSelf = m.id === currentUserId
          const initials = (m.full_name || m.email).slice(0, 2).toUpperCase()
          return (
            <div key={m.id} className={`bg-white rounded-2xl border shadow-sm overflow-hidden flex flex-col ${isSelf ? 'border-[#1a472a] ring-2 ring-[#1a472a]/10' : 'border-gray-100'}`}>
              {/* Avatar area — full-width cover */}
              <div className="h-56 overflow-hidden rounded-t-2xl">
                {m.avatar_url ? (
                  <img src={m.avatar_url} alt={m.full_name} className="w-full h-full object-cover" />
                ) : (
                  <div
                    className="w-full h-full flex items-center justify-center text-3xl font-bold text-white"
                    style={{ background: isLead ? 'linear-gradient(135deg, #1a472a, #2d6a4f)' : 'linear-gradient(135deg, #2d6a4f, #52b788)' }}
                  >
                    {initials}
                  </div>
                )}
              </div>

              {/* Info */}
              <div className="px-4 pt-3 pb-4 flex flex-col flex-1">
                {/* Name + verified badge */}
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="font-bold text-gray-800 text-[14px] truncate leading-tight">{m.full_name || 'Unnamed'}</span>
                  <span className={`shrink-0 w-[18px] h-[18px] rounded-full flex items-center justify-center ${isLead ? 'bg-green-500' : 'bg-gray-300'}`}>
                    <Check className="w-2.5 h-2.5 text-white" />
                  </span>
                  {isSelf && (
                    <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-md text-white shrink-0" style={{ background: '#1a472a' }}>You</span>
                  )}
                </div>

                {/* Designation */}
                <p className="text-[12px] text-gray-500 mt-0.5 leading-snug">
                  {m.department || (isLead ? 'Team Lead' : 'Team Member')}
                </p>

                {/* Assign to lead — admin only, regular members only */}
                {isAdmin && !isLead && (
                  <div className="mt-2">
                    <select
                      defaultValue={m.managed_by ?? ''}
                      onChange={e => void onAssign(m.id, e.target.value || null)}
                      className="w-full text-[11px] px-2 py-1 rounded-lg border border-gray-200 bg-gray-50 focus:border-green-600 focus:outline-none cursor-pointer"
                      style={{ color: m.managed_by ? '#1a472a' : '#9ca3af' }}
                    >
                      <option value="">Unassigned</option>
                      {teamLeads.map(lead => (
                        <option key={lead.id} value={lead.id}>
                          {lead.full_name || lead.email}
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                {/* Bottom row: report status + actions */}
                <div className="flex items-center justify-between mt-3 gap-2">
                  {loading ? (
                    <span className="h-6 w-20 rounded-full bg-gray-100 animate-pulse inline-block" />
                  ) : status ? (
                    status.has_submitted ? (
                      <span className="flex items-center gap-1 text-[11px] font-semibold text-green-700 bg-green-50 px-2 py-1 rounded-full whitespace-nowrap">
                        <CheckCircle2 className="w-3 h-3 shrink-0" /> Submitted
                      </span>
                    ) : (
                      <span className="flex items-center gap-1 text-[11px] font-semibold text-red-600 bg-red-50 px-2 py-1 rounded-full whitespace-nowrap">
                        <XCircle className="w-3 h-3 shrink-0" /> Pending
                      </span>
                    )
                  ) : (
                    <span className="text-[11px] text-gray-400">No data</span>
                  )}

                  {isAdmin && (
                    <div className="flex gap-1 shrink-0">
                      <button onClick={() => onEdit(m)} className="p-1.5 rounded-lg text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors" title="Edit">
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      <button onClick={() => onDelete(m)} className="p-1.5 rounded-lg text-gray-400 hover:bg-red-50 hover:text-red-500 transition-colors" title="Remove">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )
        })}
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
                <div key={m.id} className="flex items-center gap-1.5 px-2.5 py-1 rounded-full" style={{ background: 'rgba(26,71,42,0.08)' }}>
                  <Check className="w-3 h-3" style={{ color: '#1a472a' }} />
                  <span className="text-xs font-medium" style={{ color: '#1a472a' }}>{m.full_name || m.email}</span>
                  <span className="text-[10px]" style={{ color: '#52b788' }}>
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
