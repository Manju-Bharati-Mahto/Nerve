import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useAuth } from '@/hooks/useAuth'
import { useAppData } from '@/hooks/useAppData'
import { brandingApi } from '@/lib/branding-api'
import type {
  BrandingProject, MemberReportStatus, DailyReport, DailyReportRow,
  ReportRowComment,
} from '@/lib/branding-types'
import {
  perDayElapsedSeconds, elapsedToTimeTaken,
} from '@/lib/branding-types'
import type { AppUser } from '@/lib/app-types'
import {
  Users, FolderKanban, Plus, Pencil, Trash2, X, Check,
  CalendarDays, UserPlus, ChevronDown, ChevronUp,
  CheckCircle2, XCircle, Radio, Send, Clock,
} from 'lucide-react'

// ── Helpers ────────────────────────────────────────────────────────────────

type TabKey = 'members' | 'projects' | 'live'

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

  // Allow ?tab=projects|live in the URL to land directly on a sub-tab —
  // used by the Total Projects card on the admin dashboard.
  const [searchParams, setSearchParams] = useSearchParams()
  const tabParam = searchParams.get('tab')
  const initialTab: TabKey = tabParam === 'projects' ? 'projects' : tabParam === 'live' ? 'live' : 'members'
  const [tab, setTab] = useState<TabKey>(initialTab)

  // Keep the URL in sync so reloads / back-button preserve the chosen tab,
  // and strip the param when switching back to "members" to keep URLs clean.
  useEffect(() => {
    const current = searchParams.get('tab')
    if (tab !== 'members' && current !== tab) {
      const next = new URLSearchParams(searchParams)
      next.set('tab', tab)
      setSearchParams(next, { replace: true })
    } else if (tab === 'members' && current) {
      const next = new URLSearchParams(searchParams)
      next.delete('tab')
      setSearchParams(next, { replace: true })
    }
  }, [tab, searchParams, setSearchParams])

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
    // Leads and admins both need the project list: admins manage all, leads
    // assign to their managed members.
    if (isAdmin || isLead) {
      brandingApi.getProjects()
        .then(r => setProjects(r.projects))
        .catch(() => {})
        .finally(() => setProjLoading(false))
    } else {
      setProjLoading(false)
    }
  }, [isAdmin, isLead])

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
        {(isAdmin || isLead) && tab === 'projects' && (
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
        {(isAdmin || isLead) && (
          <button
            onClick={() => setTab('live')}
            className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
              tab === 'live' ? 'border-[#1a472a] text-[#1a472a]' : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            <Radio className="w-4 h-4" />
            Live Reports
          </button>
        )}
        {(isAdmin || isLead) && (
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
              No projects yet.{(isAdmin || isLead) ? ' Click "New Project" to create one.' : ''}
            </p>
          )}
          {projects.map(proj => (
            <ProjectCard
              key={proj.id}
              project={proj}
              members={allUsers}
              canEdit={isAdmin || isLead}
              canDelete={isAdmin || isLead}
              onEdit={() => setProjDialog({ mode: 'edit', project: proj })}
              onDelete={() => setDeleteProjTarget(proj)}
            />
          ))}
        </div>
      )}

      {/* ── Live Reports Tab ── */}
      {tab === 'live' && (isAdmin || isLead) && (
        <LiveReportsView members={members} currentUserId={user?.id ?? ''} />
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
  project, members, canEdit, canDelete, onEdit, onDelete
}: {
  project: BrandingProject
  members: AppUser[]
  canEdit: boolean
  canDelete: boolean
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
        {(canEdit || canDelete) && (
          <div className="flex items-center gap-1 shrink-0">
            {canEdit && (
              <button
                onClick={onEdit}
                className="p-1.5 rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
                title="Edit project"
              >
                <Pencil className="w-3.5 h-3.5" />
              </button>
            )}
            {canDelete && (
              <button
                onClick={onDelete}
                className="p-1.5 rounded-lg text-muted-foreground hover:bg-red-50 hover:text-red-600 transition-colors"
                title="Delete project"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            )}
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

// ── LiveReportsView ────────────────────────────────────────────────────────
// Live monitor for a lead's managed members: shows each member's report for
// the chosen date, refreshes every 30s, and lets the lead post per-row
// comments that the member sees on their own dashboard.

const POLL_INTERVAL_MS = 30_000

const STOPWATCH_LABEL: Record<string, { label: string; cls: string }> = {
  idle:     { label: 'Not started', cls: 'bg-gray-100 text-gray-600' },
  running:  { label: 'Running',     cls: 'bg-amber-100 text-amber-700' },
  paused:   { label: 'Paused',      cls: 'bg-orange-100 text-orange-700' },
  finished: { label: 'Finished',    cls: 'bg-green-100 text-green-700' },
}

function LiveReportsView({
  members, currentUserId,
}: {
  members: AppUser[]
  currentUserId: string
}) {
  const [date, setDate] = useState(todayIso)
  const [reports, setReports] = useState<DailyReport[]>([])
  const [commentsByRow, setCommentsByRow] = useState<Record<string, ReportRowComment[]>>({})
  const [loading, setLoading] = useState(false)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  const [expandedUserId, setExpandedUserId] = useState<string | null>(null)
  const inFlight = useRef(false)

  // Only include actual team members (not the lead themselves).
  const monitoredMembers = useMemo(
    () => members.filter(m => m.id !== currentUserId),
    [members, currentUserId],
  )
  const memberIds = useMemo(() => monitoredMembers.map(m => m.id), [monitoredMembers])

  const refresh = useCallback(async () => {
    if (memberIds.length === 0) { setReports([]); return }
    if (inFlight.current) return
    inFlight.current = true
    try {
      const { reports } = await brandingApi.getAllReports({
        userIds: memberIds, dateFrom: date, dateTo: date, teamScope: true,
      })
      setReports(reports)
      const rowIds = reports.flatMap(r => (r.rows ?? []).map(row => row.id))
      if (rowIds.length > 0) {
        const { comments } = await brandingApi.getRowComments(rowIds)
        const grouped: Record<string, ReportRowComment[]> = {}
        for (const c of comments) (grouped[c.row_id] ??= []).push(c)
        setCommentsByRow(grouped)
      } else {
        setCommentsByRow({})
      }
      setLastUpdated(new Date())
    } catch {
      // Silent — polling will retry. Keep last good data on screen.
    } finally {
      inFlight.current = false
    }
  }, [memberIds, date])

  // Initial load + 30s polling. Restart whenever the date changes.
  useEffect(() => {
    setLoading(true)
    refresh().finally(() => setLoading(false))
    const id = setInterval(refresh, POLL_INTERVAL_MS)
    return () => clearInterval(id)
  }, [refresh])

  const reportByUser = useMemo(() => {
    const map: Record<string, DailyReport> = {}
    for (const r of reports) map[r.user_id] = r
    return map
  }, [reports])

  // Per-day total hours for a member's report on the selected date — sums
  // perDayElapsedSeconds across rows so carry-over chains don't double count.
  function perDayHours(rep: DailyReport | undefined): number {
    if (!rep?.rows) return 0
    const secs = rep.rows.reduce((s, r) => s + perDayElapsedSeconds(r, [rep]), 0)
    return Math.round((secs / 3600) * 10) / 10
  }

  function memberStatus(rep: DailyReport | undefined): { label: string; cls: string } {
    if (!rep) return { label: 'Not started', cls: 'bg-gray-100 text-gray-600' }
    if (rep.is_locked) return { label: 'Submitted', cls: 'bg-green-100 text-green-700' }
    if ((rep.rows?.length ?? 0) === 0) return { label: 'Not started', cls: 'bg-gray-100 text-gray-600' }
    return { label: 'In progress', cls: 'bg-amber-100 text-amber-700' }
  }

  async function postComment(rowId: string, body: string) {
    const trimmed = body.trim()
    if (!trimmed) return
    try {
      const { comment } = await brandingApi.createRowComment(rowId, trimmed)
      setCommentsByRow(m => ({ ...m, [rowId]: [...(m[rowId] ?? []), comment] }))
    } catch (e) {
      console.error(e)
    }
  }

  async function removeComment(rowId: string, commentId: string) {
    try {
      await brandingApi.deleteRowComment(commentId)
      setCommentsByRow(m => ({
        ...m,
        [rowId]: (m[rowId] ?? []).filter(c => c.id !== commentId),
      }))
    } catch (e) {
      console.error(e)
    }
  }

  return (
    <div className="space-y-5">
      {/* Date + live indicator */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-2 bg-white border border-gray-200 rounded-xl px-3 py-2">
          <CalendarDays className="w-4 h-4 shrink-0" style={{ color: '#52b788' }} />
          <input
            type="date"
            max={todayIso()}
            value={date}
            onChange={e => setDate(e.target.value)}
            className="text-sm bg-transparent outline-none cursor-pointer"
            style={{ color: '#1a472a' }}
          />
        </div>
        <span className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-full" style={{ background: 'rgba(82,183,136,0.15)', color: '#1a472a' }}>
          <span className="relative inline-flex w-2 h-2">
            <span className="absolute inline-flex w-full h-full rounded-full opacity-75 animate-ping" style={{ background: '#52b788' }} />
            <span className="relative inline-flex w-2 h-2 rounded-full" style={{ background: '#52b788' }} />
          </span>
          Live · refreshes every 30s
        </span>
        {lastUpdated && (
          <span className="text-xs text-muted-foreground">
            Updated {lastUpdated.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}
          </span>
        )}
        <button
          onClick={() => void refresh()}
          className="text-xs font-semibold px-3 py-1.5 rounded-full border border-gray-200 hover:border-[#52b788] hover:text-[#1a472a] transition-colors"
        >
          Refresh now
        </button>
      </div>

      {loading && reports.length === 0 ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : monitoredMembers.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-8">
          No members assigned to you yet.
        </p>
      ) : (
        <div className="space-y-3">
          {monitoredMembers.map(m => {
            const rep = reportByUser[m.id]
            const status = memberStatus(rep)
            const hrs = perDayHours(rep)
            const isOpen = expandedUserId === m.id
            return (
              <div key={m.id} className="hub-card">
                <button
                  type="button"
                  onClick={() => setExpandedUserId(isOpen ? null : m.id)}
                  className="w-full flex items-center justify-between gap-3 text-left"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-9 h-9 rounded-full flex items-center justify-center text-white text-sm font-bold shrink-0" style={{ background: '#1a472a' }}>
                      {(m.full_name || m.email)[0]?.toUpperCase() ?? '?'}
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-semibold truncate" style={{ color: '#1a472a' }}>
                        {m.full_name || m.email}
                      </p>
                      <p className="text-xs text-muted-foreground truncate">{m.email}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <span className={`hub-badge ${status.cls}`}>{status.label}</span>
                    <span className="flex items-center gap-1 text-xs font-semibold" style={{ color: '#1a472a' }}>
                      <Clock className="w-3.5 h-3.5" style={{ color: '#52b788' }} />
                      {hrs} hrs
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {(rep?.rows?.length ?? 0)} {rep?.rows?.length === 1 ? 'row' : 'rows'}
                    </span>
                    {isOpen ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
                  </div>
                </button>

                {isOpen && (
                  <div className="mt-4 pt-4 border-t border-border">
                    {!rep || (rep.rows?.length ?? 0) === 0 ? (
                      <p className="text-xs text-muted-foreground text-center py-4">
                        No entries for this date.
                      </p>
                    ) : (
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="text-xs border-b border-gray-100" style={{ color: '#1a472a' }}>
                            <th className="text-left pb-2 font-bold w-8 pr-2">#</th>
                            <th className="text-left pb-2 font-bold pr-2">Type</th>
                            <th className="text-left pb-2 font-bold pr-2">Specific Work</th>
                            <th className="text-left pb-2 font-bold pr-2 whitespace-nowrap">Status</th>
                            <th className="text-left pb-2 font-bold pr-2 whitespace-nowrap">Today</th>
                            <th className="text-left pb-2 font-bold whitespace-nowrap">Comments</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(rep.rows ?? []).map((row: DailyReportRow) => {
                            const perDay = perDayElapsedSeconds(row, [rep])
                            const sw = STOPWATCH_LABEL[row.stopwatch_status] ?? STOPWATCH_LABEL.idle
                            const thread = commentsByRow[row.id] ?? []
                            return (
                              <tr key={row.id} className="border-b border-gray-50 last:border-0 align-top">
                                <td className="py-2.5 text-gray-400 pr-2">{row.sr_no}</td>
                                <td className="py-2.5 pr-2">
                                  <span className="text-gray-700">{row.type_of_work}</span>
                                  {row.sub_category && <span className="text-xs text-gray-400 block">{row.sub_category}</span>}
                                </td>
                                <td className="py-2.5 text-gray-600 pr-2">{row.specific_work || '—'}</td>
                                <td className="py-2.5 pr-2">
                                  <span className={`text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded ${sw.cls}`}>
                                    {sw.label}
                                  </span>
                                </td>
                                <td className="py-2.5 text-gray-700 font-medium whitespace-nowrap pr-2">
                                  {elapsedToTimeTaken(perDay)}
                                </td>
                                <td className="py-2.5 min-w-[260px]">
                                  <CommentThread
                                    rowId={row.id}
                                    comments={thread}
                                    currentUserId={currentUserId}
                                    onSubmit={body => postComment(row.id, body)}
                                    onDelete={id => removeComment(row.id, id)}
                                  />
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── CommentThread ──────────────────────────────────────────────────────────

function CommentThread({
  rowId, comments, currentUserId, onSubmit, onDelete,
}: {
  rowId: string
  comments: ReportRowComment[]
  currentUserId: string
  onSubmit: (body: string) => Promise<void>
  onDelete: (id: string) => Promise<void>
}) {
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)

  async function handleSend() {
    if (!draft.trim() || sending) return
    setSending(true)
    try {
      await onSubmit(draft)
      setDraft('')
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="space-y-2">
      {comments.length === 0 ? (
        <p className="text-[11px] text-gray-400 italic">No comments yet.</p>
      ) : (
        <ul className="space-y-1.5">
          {comments.map(c => (
            <li key={c.id} className="rounded-lg px-2.5 py-1.5" style={{ background: 'rgba(82,183,136,0.10)' }}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-[11px] font-semibold" style={{ color: '#1a472a' }}>
                    {c.author_name}
                    <span className="text-gray-400 font-normal ml-1.5">
                      {new Date(c.created_at).toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}
                    </span>
                  </p>
                  <p className="text-xs text-gray-700 whitespace-pre-wrap break-words">{c.body}</p>
                </div>
                {c.author_id === currentUserId && (
                  <button
                    onClick={() => void onDelete(c.id)}
                    className="text-gray-400 hover:text-red-600 shrink-0"
                    title="Delete comment"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      <form
        onSubmit={e => { e.preventDefault(); void handleSend() }}
        className="flex items-center gap-1"
      >
        <input
          type="text"
          value={draft}
          onChange={e => setDraft(e.target.value)}
          placeholder="Leave feedback…"
          className="flex-1 min-w-0 text-xs px-2.5 py-1.5 rounded-lg border border-gray-200 outline-none focus:border-[#52b788]"
          aria-label={`Comment on row ${rowId}`}
        />
        <button
          type="submit"
          disabled={!draft.trim() || sending}
          className="p-1.5 rounded-lg text-white disabled:opacity-40"
          style={{ background: '#1a472a' }}
          title="Post comment"
        >
          {sending ? <Clock className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
        </button>
      </form>
    </div>
  )
}
