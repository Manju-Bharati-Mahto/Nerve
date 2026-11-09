import { Fragment, useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useAuth } from '@/hooks/useAuth'
import { useAppData } from '@/hooks/useAppData'
import { brandingApi } from '@/lib/branding-api'
import { api } from '@/lib/api'
import type {
  BrandingProject, MemberReportStatus, DailyReport, DailyReportRow,
  ReportRowComment, BrandingTodo,
} from '@/lib/branding-types'
import {
  perDayElapsedSeconds, elapsedToTimeTaken,
} from '@/lib/branding-types'
import type { AppUser } from '@/lib/app-types'
import { CAPABILITIES, CAPABILITY_META, BO_CAPABILITIES } from '@/lib/capabilities'
import {
  Users, FolderKanban, Plus, Pencil, Trash2, Check,
  CalendarDays, UserPlus, ChevronDown, ChevronUp,
  CheckCircle2, XCircle, Radio, Send, Clock, ListTodo, RefreshCw,
  ArrowLeft,
} from 'lucide-react'
import {
  DS, cx, Badge, Avatar, Modal, EmptyState, Spinner,
  Segmented, BlockHeader, CardHead, StatusPill, MiniStat, DotItem,
} from './ds'
import type { Tone } from './ds'

// ── Helpers ────────────────────────────────────────────────────────────────

type TabKey = 'members' | 'projects' | 'live'

const STATUS_LABELS: Record<BrandingProject['status'], string> = {
  active: 'Active',
  completed: 'Completed',
  on_hold: 'On Hold',
}
const STATUS_BADGE: Record<BrandingProject['status'], Tone> = {
  active: 'success',
  completed: 'info',
  on_hold: 'warning',
}
// ── Member Dialog ──────────────────────────────────────────────────────────

interface MemberFormState {
  full_name: string
  email: string
  password: string
  department: string
  role: 'user' | 'sub_admin' | 'task_owner' | 'task_manager' | 'inventory_manager'
  capabilities: string[]
}

function emptyMember(): MemberFormState {
  return { full_name: '', email: '', password: '', department: '', role: 'user', capabilities: [] }
}

interface MemberDialogProps {
  mode: 'add' | 'edit'
  initial?: MemberFormState & { id: string }
  canManageCapabilities: boolean
  onSave: (data: MemberFormState) => Promise<void>
  onClose: () => void
}

function MemberDialog({ mode, initial, canManageCapabilities, onSave, onClose }: MemberDialogProps) {
  const [form, setForm] = useState<MemberFormState>(
    initial ? { ...initial } : emptyMember()
  )
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

  function toggleCapability(key: string) {
    setForm(f => ({
      ...f,
      capabilities: f.capabilities.includes(key)
        ? f.capabilities.filter(k => k !== key)
        : [...f.capabilities, key],
    }))
  }

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
    <Modal
      title={mode === 'add' ? 'Add Team Member' : 'Edit Member'}
      onClose={onClose}
      size="md"
      footer={
        <>
          <button type="button" onClick={onClose} className={cx(DS.btn, DS.btnSecondary)}>
            Cancel
          </button>
          <button type="submit" form="member-dialog-form" disabled={saving} className={cx(DS.btn, DS.btnPrimary)}>
            {saving ? 'Saving…' : mode === 'add' ? 'Add Member' : 'Save Changes'}
          </button>
        </>
      }
    >
      {/* Profile header — the Account page's avatar + name row, fed live
          from the form so the card reflects what is being typed. */}
      <div className="flex items-center gap-4 sm:gap-5 pb-5 mb-5 border-b border-[#C5CAD1]">
        <Avatar name={form.full_name} email={form.email} size="xl" />
        <div className="min-w-0">
          <p className="text-base font-semibold text-[#111827] tracking-tight truncate">
            {form.full_name.trim() || (mode === 'add' ? 'New member' : 'Unnamed')}
          </p>
          <p className="text-sm font-medium text-[#6B7280] truncate">{form.email.trim() || 'Email address'}</p>
          <p className="text-xs font-medium text-[#9CA3AF] mt-1">
            {mode === 'add' ? 'Joins the branding team' : 'Branding team'}
          </p>
        </div>
      </div>

      <form id="member-dialog-form" onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className={DS.label}>Full Name *</label>
            <input
              className={DS.input}
              value={form.full_name}
              onChange={e => setForm(f => ({ ...f, full_name: e.target.value }))}
              placeholder="Jane Doe"
            />
          </div>
          <div>
            <label className={DS.label}>Department</label>
            <input
              className={DS.input}
              value={form.department}
              onChange={e => setForm(f => ({ ...f, department: e.target.value }))}
              placeholder="Design"
            />
          </div>
        </div>
        <div>
          <label className={DS.label}>Email *</label>
          <input
            type="email"
            className={DS.input}
            value={form.email}
            onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
            placeholder="jane@example.com"
          />
        </div>
        <div>
          <label className={DS.label}>
            {mode === 'add' ? 'Password *' : 'New Password (leave blank to keep)'}
          </label>
          <input
            type="password"
            className={DS.input}
            value={form.password}
            onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
            placeholder={mode === 'edit' ? 'Leave blank to keep current' : 'Min 6 characters'}
          />
        </div>
        <div>
          <label className={DS.label}>Role *</label>
          <select
            className={DS.select}
            value={form.role}
            onChange={e => setForm(f => ({ ...f, role: e.target.value as MemberFormState['role'] }))}
          >
            <option value="user">Designer</option>
            <option value="sub_admin">Team Lead</option>
            <option value="task_owner">Task Owner</option>
            <option value="task_manager">Task Manager</option>
            <option value="inventory_manager">Inventory Manager (BrandOps)</option>
          </select>
        </div>
        {canManageCapabilities && (
          <div className="pt-1">
            <p className={DS.eyebrow}>Extra capabilities</p>
            <p className={cx(DS.hint, 'mb-3')}>
              Grant access to specific admin features without promoting the member to admin. Each grant adds a sidebar entry on the user's dashboard.
            </p>
            <div className="space-y-2">
              {CAPABILITIES.filter(k => k.startsWith('branding:')).map(key => {
                const meta = CAPABILITY_META[key]
                const checked = form.capabilities.includes(key)
                return (
                  <label
                    key={key}
                    className={cx(
                      'flex items-start gap-3 px-3.5 py-3 rounded-[6px] border cursor-pointer transition-colors',
                      checked ? 'bg-bp-50 border-bp-300' : 'bg-white border-[#C5CAD1] hover:border-[#9CA3AF] hover:bg-[#F9FAFB]',
                    )}
                  >
                    <input
                      type="checkbox"
                      className="sr-only"
                      checked={checked}
                      onChange={() => toggleCapability(key)}
                    />
                    <span
                      className={cx(
                        'mt-0.5 w-[18px] h-[18px] rounded-md border grid place-items-center shrink-0 transition-colors',
                        checked ? 'bg-bp-700 border-bp-700 text-white' : 'bg-white border-[#9CA3AF]',
                      )}
                      aria-hidden="true"
                    >
                      {checked && <Check className="w-3 h-3 stroke-[3]" />}
                    </span>
                    <div className="min-w-0">
                      <p className={cx('text-[13px] font-semibold', checked ? 'text-bp-800' : 'text-[#111827]')}>{meta.label}</p>
                      <p className="text-xs text-[#6B7280] font-medium leading-snug mt-0.5">{meta.description}</p>
                    </div>
                  </label>
                )
              })}
            </div>

            {/* BrandOps: one switch per tab. An Inventory Manager sees only
                what is ticked here, and the same keys gate the API. */}
            <div className="mt-5">
              <div className="flex items-center justify-between gap-2 mb-1">
                <p className={DS.eyebrow}>
                  BrandOps tabs {form.role === 'inventory_manager' && <span className="text-rose-500">*</span>}
                </p>
                <button type="button"
                  onClick={() => setForm(f => ({
                    ...f,
                    capabilities: BO_CAPABILITIES.every(k => f.capabilities.includes(k))
                      ? f.capabilities.filter(k => !(BO_CAPABILITIES as readonly string[]).includes(k))
                      : [...new Set([...f.capabilities, ...BO_CAPABILITIES])],
                  }))}
                  className="text-[11px] font-semibold text-bp-700 hover:underline">
                  {BO_CAPABILITIES.every(k => form.capabilities.includes(k)) ? 'Clear all' : 'Select all'}
                </button>
              </div>
              <p className={cx(DS.hint, 'mb-3')}>
                Switch on the BrandOps tabs this person should see. An Inventory Manager with
                nothing ticked here can sign in but has no modules.
              </p>
              <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
                {BO_CAPABILITIES.map(key => {
                  const meta = CAPABILITY_META[key]
                  const checked = form.capabilities.includes(key)
                  return (
                    <label
                      key={key}
                      className={cx(
                        'flex items-start gap-3 px-3.5 py-3 rounded-[6px] border cursor-pointer transition-colors',
                        checked ? 'bg-bp-50 border-bp-300' : 'bg-white border-[#C5CAD1] hover:border-[#9CA3AF] hover:bg-[#F9FAFB]',
                      )}
                    >
                      <input type="checkbox" className="sr-only" checked={checked} onChange={() => toggleCapability(key)} />
                      <span
                        className={cx(
                          'mt-0.5 w-[18px] h-[18px] rounded-md border grid place-items-center shrink-0 transition-colors',
                          checked ? 'bg-bp-700 border-bp-700 text-white' : 'bg-white border-[#9CA3AF]',
                        )}
                        aria-hidden="true"
                      >
                        {checked && <Check className="w-3 h-3 stroke-[3]" />}
                      </span>
                      <div className="min-w-0">
                        <p className={cx('text-[13px] font-semibold', checked ? 'text-bp-800' : 'text-[#111827]')}>{meta.label}</p>
                        <p className="text-xs text-[#6B7280] font-medium leading-snug mt-0.5">{meta.description}</p>
                      </div>
                    </label>
                  )
                })}
              </div>
            </div>
          </div>
        )}
        {err && <p className="text-xs font-semibold text-rose-600">{err}</p>}
      </form>
    </Modal>
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
    <Modal
      title={mode === 'add' ? 'New Project' : 'Edit Project'}
      onClose={onClose}
      size="lg"
      footer={
        <>
          <button type="button" onClick={onClose} className={cx(DS.btn, DS.btnSecondary)}>
            Cancel
          </button>
          <button type="submit" form="project-dialog-form" disabled={saving} className={cx(DS.btn, DS.btnPrimary)}>
            {saving ? 'Saving…' : mode === 'add' ? 'Create Project' : 'Save Changes'}
          </button>
        </>
      }
    >
      <form id="project-dialog-form" onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className={DS.label}>Project Name *</label>
          <input
            className={DS.input}
            value={form.name}
            onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
            placeholder="Annual Brochure Design"
          />
        </div>
        <div>
          <label className={DS.label}>Description</label>
          <textarea
            className={cx(DS.textarea, 'resize-none')}
            rows={3}
            value={form.description}
            onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
            placeholder="Brief description of the project…"
          />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className={DS.label}>Deadline</label>
            <input
              type="date"
              className={DS.input}
              value={form.deadline}
              onChange={e => setForm(f => ({ ...f, deadline: e.target.value }))}
            />
          </div>
          <div>
            <label className={DS.label}>Status</label>
            <select
              className={DS.select}
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
          <label className={DS.label}>Assign Members</label>
          <button
            type="button"
            onClick={() => setMemberOpen(o => !o)}
            className={cx(DS.input, 'text-left flex justify-between items-center gap-2 cursor-pointer', memberOpen && 'border-bp-600 ring-2 ring-bp-200')}
          >
            <span className={cx('truncate', selectedNames.length ? 'text-[#111827]' : 'text-[#9CA3AF]')}>
              {selectedNames.length
                ? selectedNames.slice(0, 3).join(', ') + (selectedNames.length > 3 ? ` +${selectedNames.length - 3} more` : '')
                : 'Select members…'}
            </span>
            {memberOpen ? <ChevronUp className="w-4 h-4 shrink-0 text-[#9CA3AF]" /> : <ChevronDown className="w-4 h-4 shrink-0 text-[#9CA3AF]" />}
          </button>
          {memberOpen && (
            <div className="border border-[#C5CAD1] rounded-[6px] mt-2 max-h-44 overflow-y-auto bg-white divide-y divide-[#C5CAD1]">
              {members.length === 0 && (
                <EmptyState compact title="No team members yet." />
              )}
              {members.map(m => {
                const on = form.assigned_user_ids.includes(m.id)
                return (
                  <label key={m.id} className={cx('flex items-center gap-3 px-3.5 py-2.5 cursor-pointer transition-colors', on ? 'bg-bp-50' : 'hover:bg-[#F9FAFB]')}>
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() => toggleMember(m.id)}
                      className="sr-only"
                    />
                    <span
                      className={cx(
                        'w-[18px] h-[18px] rounded-md border grid place-items-center shrink-0 transition-colors',
                        on ? 'bg-bp-700 border-bp-700 text-white' : 'bg-white border-[#9CA3AF]',
                      )}
                      aria-hidden="true"
                    >
                      {on && <Check className="w-3 h-3 stroke-[3]" />}
                    </span>
                    <Avatar url={m.avatar_url} name={m.full_name} email={m.email} size="xs" />
                    <span className={cx('text-sm font-semibold truncate', on ? 'text-bp-800' : 'text-[#111827]')}>{m.full_name || m.email}</span>
                    <span className="ml-auto text-[11px] font-semibold text-[#9CA3AF] shrink-0">
                      {m.role === 'sub_admin' ? 'Lead' : m.role === 'task_owner' ? 'Task Owner' : m.role === 'task_manager' ? 'Task Manager' : m.role === 'inventory_manager' ? 'Inventory Mgr' : 'Member'}
                    </span>
                  </label>
                )
              })}
            </div>
          )}
        </div>
        {err && <p className="text-xs font-semibold text-rose-600">{err}</p>}
      </form>
    </Modal>
  )
}

function todayIso() {
  return new Date().toISOString().slice(0, 10)
}

// ── Member To-Dos Dialog (Visible to Leads & Admins) ──────────────────────

function MemberTodosDialog({ member, onClose, mode = 'modal' }: { member: AppUser; onClose: () => void; mode?: 'modal' | 'page' }) {
  const [todos, setTodos] = useState<BrandingTodo[]>([])
  const [loading, setLoading] = useState(true)

  // Page mode (phones / tablets): opening pushes a history entry so the
  // device Back button closes the page instead of leaving the panel.
  useEffect(() => {
    if (mode !== 'page') return
    window.history.pushState({ todosPage: member.id }, '')
    let popped = false
    const onPop = () => { popped = true; onClose() }
    window.addEventListener('popstate', onPop)
    return () => {
      window.removeEventListener('popstate', onPop)
      // Closed by the on-screen Back: drop the entry we pushed.
      if (!popped && window.history.state?.todosPage === member.id) window.history.back()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, member.id])

  useEffect(() => {
    let unmounted = false
    setLoading(true)
    brandingApi.getTodos(member.id)
      .then(res => {
        if (!unmounted) setTodos(res.todos || [])
      })
      .catch(() => {
        if (!unmounted) setTodos([])
      })
      .finally(() => {
        if (!unmounted) setLoading(false)
      })
    return () => { unmounted = true }
  }, [member.id])

  // The todo model only knows "completed" — an open item with a due date is
  // scheduled work (in progress), one without is simply pending.
  const completedCount = todos.filter(t => t.completed).length
  const inProgressCount = todos.filter(t => !t.completed && t.due_date).length
  const pendingCount = todos.length - completedCount - inProgressCount

  const fmtDay = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })

  const body = (
    <>
      {/* Status strip — Project Progress's three figure tiles */}
      <div className="grid grid-cols-3 gap-2 mb-5">
        <MiniStat dot="bg-emerald-500" n={completedCount} label="Completed" />
        <MiniStat dot="bg-bp-600" n={inProgressCount} label="In progress" />
        <MiniStat dot="bg-slate-400" n={pendingCount} label="Pending" />
      </div>

      {/* Content */}
      {loading ? (
        <div className="flex flex-col items-center justify-center py-12 gap-2">
          <Spinner />
          <p className={DS.muted}>Loading to-dos…</p>
        </div>
      ) : todos.length === 0 ? (
        <EmptyState
          icon={ListTodo}
          title="No to-dos created yet"
          body="This member has not added any personal to-dos in their schedule."
        />
      ) : (
        <ul className="divide-y divide-[#C5CAD1]">
          {todos.map(todo => {
            const open = !todo.completed
            const meta = [
              `Created ${fmtDay(todo.created_at)}`,
              todo.completed && todo.completed_at ? `Done ${fmtDay(todo.completed_at)}` : null,
              todo.due_date ? `Due ${fmtDay(todo.due_date)}` : null,
            ].filter(Boolean).join(' · ')
            return (
              <DotItem
                key={todo.id}
                title={<span className={todo.completed ? 'line-through text-[#9CA3AF]' : undefined}>{todo.title}</span>}
                meta={meta}
                trailing={
                  todo.completed
                    ? <Badge tone="success">Completed</Badge>
                    : open && todo.due_date
                      ? <Badge tone="info">In progress</Badge>
                      : <Badge tone="neutral">Pending</Badge>
                }
              />
            )
          })}
        </ul>
      )}
    </>
  )

  if (mode === 'page') {
    return (
      <div className="space-y-3">
        <button type="button" onClick={onClose} className={cx(DS.btn, DS.btnSecondary, DS.btnSm)}>
          <ArrowLeft className="w-3.5 h-3.5" strokeWidth={1.75} /> Back to team
        </button>
        <div className={cx(DS.card, DS.cardPad)}>
          <div className="flex items-center gap-3 mb-4">
            <Avatar url={member.avatar_url} name={member.full_name} email={member.email} size="md" />
            <div className="min-w-0">
              <h2 className={DS.h2}>{member.full_name || member.email}'s Schedule & To-Dos</h2>
              <p className={cx(DS.sub, 'text-[12px]')}>Tasks created by this member in Today's Schedule</p>
            </div>
          </div>
          {body}
        </div>
      </div>
    )
  }

  return (
    <Modal
      title={`${member.full_name || member.email}'s Schedule & To-Dos`}
      subtitle="Tasks created by this member in Today's Schedule"
      onClose={onClose}
      size="lg"
      footer={
        <button onClick={onClose} className={cx(DS.btn, DS.btnSecondary)}>
          Close
        </button>
      }
    >
      {body}
    </Modal>
  )
}

// ── Main Component ─────────────────────────────────────────────────────────

export default function BrandingTeamPanel() {
  const { role, user } = useAuth()
  const { users: allUsers, addUser, updateUser, deleteUser, refreshAll } = useAppData()
  const isAdmin = role === 'admin' || role === 'super_admin'
  const isLead = role === 'sub_admin' || role === 'task_owner' || role === 'task_manager'

  // Branding members only
  // - admin/super_admin: all branding members
  // - sub_admin (lead): members they manage + themselves (so their own report is visible)
  // Allow ?tab=projects|live in the URL to land directly on a sub-tab —
  // used by the Total Projects card on the admin dashboard — and ?lead=<id>
  // to show one lead's team only, which is how the Team Members overview
  // cards open this page.
  const [searchParams, setSearchParams] = useSearchParams()
  const leadFilter = searchParams.get('lead')
  const filterLead = leadFilter ? allUsers.find(u => u.id === leadFilter) ?? null : null
  const clearLeadFilter = () => {
    const next = new URLSearchParams(searchParams)
    next.delete('lead')
    setSearchParams(next, { replace: true })
  }

  const members = allUsers.filter(u =>
    u.team === 'branding' &&
    u.role !== 'super_admin' &&
    (isAdmin
      ? true
      : isLead
        ? u.managed_by === user?.id || u.id === user?.id
        : u.id !== user?.id) &&
    (!filterLead || u.managed_by === filterLead.id || u.id === filterLead.id)
  )
  const memberIds = new Set(members.map(m => m.id))
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
  // Statuses for the people on screen only, so the summary matches the cards
  // when one lead's team is being shown.
  const shownStatuses = todayStatuses.filter(st => memberIds.has(st.user_id))

  // ── Members state ─────────────────────────────────────────────────────
  const [memberDialog, setMemberDialog] = useState<null | 'add' | { mode: 'edit'; member: AppUser }>(null)
  const [deleteTarget, setDeleteTarget] = useState<AppUser | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState(false)
  const [viewingTodosMember, setViewingTodosMember] = useState<AppUser | null>(null)

  // ── Projects state ────────────────────────────────────────────────────
  const [projects, setProjects] = useState<BrandingProject[]>([])
  const shownProjects = projects.filter(proj => !filterLead
    || proj.assigned_lead_id === filterLead.id || proj.created_by === filterLead.id
    || proj.assigned_user_ids.some(id => memberIds.has(id)))
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
    const created = await addUser({
      full_name: data.full_name,
      email: data.email,
      password: data.password,
      department: data.department,
      role: data.role,
      team: 'branding',
      managed_by: user?.id ?? null,
    })
    // Capability grants are admin-only; non-admins won't send a non-empty
    // array because the picker stays hidden for them.
    if (isAdmin && data.capabilities.length > 0) {
      await api.setUserCapabilities(created.id, data.capabilities)
      await refreshAll()
    }
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
    // Sync capabilities whenever the admin had the picker — even an empty
    // array is meaningful (it revokes any existing grants).
    if (isAdmin) {
      await api.setUserCapabilities(memberId, data.capabilities)
      await refreshAll()
    }
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

  const teamLeads = members.filter(m => m.role === 'sub_admin' || m.role === 'task_owner' || m.role === 'task_manager')
  const teamMembers = members.filter(m => m.role === 'user')

  // Below the lg breakpoint a member's to-dos open as a page of their own
  // (like every other page on a phone) instead of a dialog.
  const [isSmall, setIsSmall] = useState(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 1023px)').matches)
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 1023px)')
    const onChange = () => setIsSmall(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  if (viewingTodosMember && isSmall) {
    return (
      <MemberTodosDialog
        mode="page"
        member={viewingTodosMember}
        onClose={() => setViewingTodosMember(null)}
      />
    )
  }

  return (
    <div className="animate-fade-in space-y-4">
      {/* Toolbar: tabs on the left, context action on the right. The host
          shell already draws the page title, so this row stays compact. */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <Segmented<TabKey>
          round={false}
          className="flex-1 max-w-md"
          ariaLabel="Team sections"
          value={tab}
          onChange={setTab}
          options={[
            { id: 'members', label: `Members (${members.length})` },
            ...((isAdmin || isLead)
              ? [
                  { id: 'live' as const, label: 'Live Reports' },
                  { id: 'projects' as const, label: `Projects (${shownProjects.length})` },
                ]
              : []),
          ]}
        />
        <div className="flex items-center gap-2 shrink-0">
          {isAdmin && tab === 'members' && (
            <button
              onClick={() => setMemberDialog('add')}
              className={cx(DS.btn, DS.btnPrimary)}
            >
              <UserPlus className="w-4 h-4" />
              Add Member
            </button>
          )}
          {(isAdmin || isLead) && tab === 'projects' && (
            <button
              onClick={() => setProjDialog('add')}
              className={cx(DS.btn, DS.btnPrimary)}
            >
              <Plus className="w-4 h-4" />
              New Project
            </button>
          )}
        </div>
      </div>

      {filterLead && (
        <div className={cx(DS.card, 'px-4 py-3 flex items-center gap-3 flex-wrap bg-bp-50/60 border-bp-200')}>
          <Avatar url={filterLead.avatar_url} name={filterLead.full_name} email={filterLead.email} size="sm" />
          <p className="text-sm font-medium text-[#374151] min-w-0">
            Showing <span className="font-semibold text-[#111827]">{filterLead.full_name || filterLead.email}</span>'s team only
            <span className="text-[#9CA3AF]"> · {members.length} {members.length === 1 ? 'person' : 'people'}</span>
          </p>
          <button type="button" onClick={clearLeadFilter} className={cx(DS.btn, DS.btnSecondary, DS.btnXs, 'ml-auto')}>
            Show all teams
          </button>
        </div>
      )}

      {/* ── Members Tab ── */}
      {tab === 'members' && (
        <div className="space-y-4">
          {/* Date filter + summary */}
          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex items-center gap-2 bg-white border border-[#C5CAD1] rounded-[6px] px-3 py-2 focus-within:border-bp-600 focus-within:ring-2 focus-within:ring-bp-200 transition-all">
              <CalendarDays className="w-4 h-4 shrink-0 text-[#9CA3AF]" />
              <input
                type="date"
                max={todayIso()}
                value={filterDate}
                onChange={e => setFilterDate(e.target.value)}
                className="text-sm font-semibold text-[#111827] bg-transparent outline-none cursor-pointer"
              />
            </div>
            {statusLoading ? (
              <span className="inline-flex items-center gap-2 text-xs font-medium text-[#9CA3AF]"><Spinner /> Loading…</span>
            ) : shownStatuses.length > 0 && (
              <>
                <Badge tone="success" className="!px-3 !py-1.5 !text-xs">
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  {shownStatuses.filter(s => s.has_submitted).length} submitted
                </Badge>
                <Badge tone="danger" className="!px-3 !py-1.5 !text-xs">
                  <XCircle className="w-3.5 h-3.5" />
                  {shownStatuses.filter(s => !s.has_submitted).length} pending
                </Badge>
              </>
            )}
          </div>

          <MemberGroup
            label="Team leads"
            items={teamLeads}
            isAdmin={isAdmin}
            statuses={todayStatuses}
            loading={statusLoading}
            currentUserId={user?.id}
            teamLeads={teamLeads}
            onEdit={m => setMemberDialog({ mode: 'edit', member: m })}
            onDelete={m => { setDeleteTarget(m); setDeleteConfirm(false) }}
            onAssign={handleAssignMember}
            onViewTodos={m => setViewingTodosMember(m)}
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
            onViewTodos={m => setViewingTodosMember(m)}
          />
          {members.length === 0 && (
            <div className={DS.card}>
              <EmptyState
                icon={Users}
                title={<>No members yet.{isAdmin ? ' Click "Add Member" to get started.' : ''}</>}
              />
            </div>
          )}
        </div>
      )}

      {/* ── Projects Tab ── */}
      {tab === 'projects' && (
        <div className="space-y-3">
          {projLoading && (
            <div className={cx(DS.card, 'flex items-center justify-center gap-2 py-12')}>
              <Spinner /> <span className={DS.muted}>Loading projects…</span>
            </div>
          )}
          {!projLoading && shownProjects.length === 0 && (
            <div className={DS.card}>
              <EmptyState
                icon={FolderKanban}
                title={<>No projects yet.{(isAdmin || isLead) ? ' Click "New Project" to create one.' : ''}</>}
              />
            </div>
          )}
          {shownProjects.map(proj => (
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
        <MemberDialog
          mode="add"
          canManageCapabilities={isAdmin}
          onSave={handleAddMember}
          onClose={() => setMemberDialog(null)}
        />
      )}
      {memberDialog !== null && memberDialog !== 'add' && memberDialog.mode === 'edit' && (
        <MemberDialog
          mode="edit"
          canManageCapabilities={isAdmin}
          initial={{
            id: memberDialog.member.id,
            full_name: memberDialog.member.full_name,
            email: memberDialog.member.email,
            password: '',
            department: memberDialog.member.department,
            role: memberDialog.member.role === 'sub_admin' ? 'sub_admin' : memberDialog.member.role === 'task_owner' ? 'task_owner' : memberDialog.member.role === 'task_manager' ? 'task_manager' : memberDialog.member.role === 'inventory_manager' ? 'inventory_manager' : 'user',
            capabilities: memberDialog.member.capabilities ?? [],
          }}
          onSave={data => handleEditMember(data, memberDialog.member.id)}
          onClose={() => setMemberDialog(null)}
        />
      )}

      {/* ── Delete Member Confirm ── */}
      {deleteTarget && (
        <Modal
          title="Remove Member"
          onClose={() => { setDeleteTarget(null); setDeleteConfirm(false) }}
          size="sm"
          footer={
            !deleteConfirm ? (
              <>
                <button onClick={() => setDeleteTarget(null)} className={cx(DS.btn, DS.btnSecondary)}>
                  Cancel
                </button>
                <button onClick={() => setDeleteConfirm(true)} className={cx(DS.btn, DS.btnDanger)}>
                  Remove
                </button>
              </>
            ) : (
              <>
                <button onClick={() => { setDeleteTarget(null); setDeleteConfirm(false) }} className={cx(DS.btn, DS.btnSecondary)}>
                  Cancel
                </button>
                <button onClick={handleDeleteMember} className={cx(DS.btn, DS.btnDanger)}>
                  Yes, Delete
                </button>
              </>
            )
          }
        >
          <p className="text-sm text-[#6B7280] font-medium leading-relaxed">
            Remove <span className="font-semibold text-[#111827]">{deleteTarget.full_name || deleteTarget.email}</span> from the branding team?
            This cannot be undone.
          </p>
          {deleteConfirm && (
            <p className="mt-3 text-xs font-semibold text-rose-700 bg-rose-50 border border-rose-100 rounded-[6px] px-3.5 py-2.5">Are you sure? This will permanently delete their account.</p>
          )}
        </Modal>
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
        <Modal
          title="Delete Project"
          onClose={() => setDeleteProjTarget(null)}
          size="sm"
          footer={
            <>
              <button onClick={() => setDeleteProjTarget(null)} className={cx(DS.btn, DS.btnSecondary)}>
                Cancel
              </button>
              <button onClick={handleDeleteProject} className={cx(DS.btn, DS.btnDanger)}>
                Delete
              </button>
            </>
          }
        >
          <p className="text-sm text-[#6B7280] font-medium leading-relaxed">
            Delete <span className="font-semibold text-[#111827]">"{deleteProjTarget.name}"</span>?
            This cannot be undone.
          </p>
        </Modal>
      )}

      {/* ── View Member Schedule To-Dos Dialog ── */}
      {viewingTodosMember && (
        <MemberTodosDialog
          member={viewingTodosMember}
          onClose={() => setViewingTodosMember(null)}
        />
      )}
    </div>
  )
}

// ── MemberGroup sub-component ──────────────────────────────────────────────

function MemberGroup({
  label, items, isAdmin, statuses, loading, currentUserId, teamLeads, onEdit, onDelete, onAssign, onViewTodos
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
  onViewTodos: (m: AppUser) => void
}) {
  if (items.length === 0) return null
  return (
    <div>
      <BlockHeader
        title={label}
        subtitle={`${items.length} ${items.length === 1 ? 'person' : 'people'}`}
      />
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        {items.map(m => {
          const status = statuses.find(s => s.user_id === m.id)
          const isLead = m.role === 'sub_admin'
          const isSelf = m.id === currentUserId
          return (
            <div
              key={m.id}
              className={cx(
                DS.card, DS.cardHover, DS.cardPad, 'flex flex-col',
                isSelf && 'ring-2 ring-bp-400 bg-bp-50/40',
              )}
            >
              {/* Identity row */}
              <div className="flex items-start gap-3">
                <Avatar url={m.avatar_url} name={m.full_name} email={m.email} size="lg" className="!rounded-[6px]" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-sm font-semibold text-[#111827] tracking-tight truncate leading-tight">{m.full_name || 'Unnamed'}</span>
                    {isSelf && <Badge tone="accent">You</Badge>}
                  </div>
                  <p className="text-xs text-[#6B7280] font-medium truncate mt-0.5">{m.email}</p>
                </div>
              </div>

              {/* Role + designation */}
              <div className="flex items-center gap-2 flex-wrap mt-3">
                <Badge tone="info">{isLead ? 'Team Lead' : 'Team Member'}</Badge>
                <span className="text-xs text-[#6B7280] font-medium truncate">
                  {m.department || (isLead ? 'Team Lead' : 'Team Member')}
                </span>
              </div>

              {/* Assign to lead — admin only, regular members only */}
              {isAdmin && !isLead && (
                <div className="mt-3">
                  <select
                    defaultValue={m.managed_by ?? ''}
                    onChange={e => void onAssign(m.id, e.target.value || null)}
                    className={cx(DS.select, '!py-2 !text-xs font-semibold', m.managed_by ? '!text-bp-800' : '!text-slate-400')}
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
              <div className="flex items-center justify-between mt-4 pt-3 border-t border-[#C5CAD1] gap-2">
                {loading ? (
                  <span className="h-6 w-20 rounded-full bg-[#F3F4F6] animate-pulse inline-block" />
                ) : status ? (
                  status.has_submitted ? (
                    <StatusPill tone="success">Submitted</StatusPill>
                  ) : (
                    <StatusPill tone="warning">Pending</StatusPill>
                  )
                ) : (
                  <span className={DS.muted}>No data</span>
                )}

                <div className="flex items-center gap-1 shrink-0">
                  <button
                    onClick={() => onViewTodos(m)}
                    className={DS.iconBtnSm}
                    title="View Schedule To-Dos"
                  >
                    <ListTodo className="w-3.5 h-3.5" />
                  </button>
                  {isAdmin && (
                    <>
                      <button onClick={() => onEdit(m)} className={DS.iconBtnSm} title="Edit">
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      <button onClick={() => onDelete(m)} className={cx(DS.iconBtnSm, 'hover:!bg-rose-600 hover:!border-rose-600')} title="Remove">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </>
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
  const overdue = !!project.deadline && project.status !== 'completed' && project.deadline.slice(0, 10) < todayIso()

  return (
    <div className={cx(DS.card, DS.cardHover, DS.cardPad)}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className={DS.h3}>{project.name}</h3>
            <StatusPill tone={STATUS_BADGE[project.status]}>
              {STATUS_LABELS[project.status]}
            </StatusPill>
          </div>
          {project.description && (
            <p className={cx(DS.sub, 'mt-1 line-clamp-2')}>{project.description}</p>
          )}
          <div className="flex items-center gap-4 mt-3 text-[11px] font-medium text-[#9CA3AF]">
            {project.deadline && (
              <span className={cx('inline-flex items-center gap-1.5', overdue && 'text-rose-600 font-semibold')}>
                <CalendarDays className="w-3.5 h-3.5" />
                {new Date(project.deadline).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                {overdue && ' · Overdue'}
              </span>
            )}
            <button
              onClick={() => setExpanded(e => !e)}
              className="inline-flex items-center gap-1.5 hover:text-bp-700 transition-colors cursor-pointer"
            >
              <Users className="w-3.5 h-3.5" />
              {assignedMembers.length} assigned
              {expanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
            </button>
          </div>
        </div>
        {(canEdit || canDelete) && (
          <div className="flex items-center gap-1 shrink-0">
            {canEdit && (
              <button
                onClick={onEdit}
                className={DS.iconBtnSm}
                title="Edit project"
              >
                <Pencil className="w-3.5 h-3.5" />
              </button>
            )}
            {canDelete && (
              <button
                onClick={onDelete}
                className={cx(DS.iconBtnSm, 'hover:!bg-rose-600 hover:!border-rose-600')}
                title="Delete project"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        )}
      </div>

      {expanded && (
        <div className="mt-4 pt-4 border-t border-[#C5CAD1]">
          {assignedMembers.length === 0 ? (
            <EmptyState compact icon={Users} title="No members assigned." />
          ) : (
            <div className="flex flex-wrap gap-2">
              {assignedMembers.map(m => (
                <div key={m.id} className="inline-flex items-center gap-2 pl-1 pr-3 py-1 rounded-full bg-bp-50 border border-bp-100">
                  <Avatar url={m.avatar_url} name={m.full_name} email={m.email} size="xs" className="!rounded-full" />
                  <span className="text-xs font-semibold text-bp-800">{m.full_name || m.email}</span>
                  <span className="text-[10px] font-semibold text-bp-700/70">
                    {m.role === 'sub_admin' ? 'Lead' : m.role === 'task_owner' ? 'Task Owner' : m.role === 'task_manager' ? 'Task Manager' : m.role === 'inventory_manager' ? 'Inventory Mgr' : 'Member'}
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

const STOPWATCH_LABEL: Record<string, { label: string; tone: Tone }> = {
  idle:     { label: 'Not started', tone: 'neutral' },
  running:  { label: 'Running',     tone: 'warning' },
  paused:   { label: 'Paused',      tone: 'info' },
  finished: { label: 'Finished',    tone: 'success' },
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

  function memberStatus(rep: DailyReport | undefined): { label: string; tone: Tone } {
    if (!rep) return { label: 'Not started', tone: 'neutral' }
    if (rep.is_locked) return { label: 'Submitted', tone: 'success' }
    if ((rep.rows?.length ?? 0) === 0) return { label: 'Not started', tone: 'neutral' }
    return { label: 'In progress', tone: 'warning' }
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

  // One-line summary for the Activity column: how much is logged and what
  // the latest row is about.
  function activityLabel(rep: DailyReport | undefined): string {
    const rows = rep?.rows ?? []
    if (rows.length === 0) return 'No report for this date'
    const last = rows[rows.length - 1]
    const what = last.specific_work || last.type_of_work || 'Untitled entry'
    return `${rows.length} ${rows.length === 1 ? 'entry' : 'entries'} · ${what}`
  }

  const dateLabel = new Date(`${date}T00:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })

  return (
    <div className="space-y-4">
      {/* Date + live indicator */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-2 bg-white border border-[#C5CAD1] rounded-[6px] px-3 py-2 focus-within:border-bp-600 focus-within:ring-2 focus-within:ring-bp-200 transition-all">
          <CalendarDays className="w-4 h-4 shrink-0 text-[#9CA3AF]" />
          <input
            type="date"
            max={todayIso()}
            value={date}
            onChange={e => setDate(e.target.value)}
            className="text-sm font-semibold text-[#111827] bg-transparent outline-none cursor-pointer"
          />
        </div>
        <span className="inline-flex items-center gap-2 text-xs font-semibold px-3 py-1.5 rounded-full bg-emerald-50 text-emerald-700">
          <span className="relative inline-flex w-2 h-2">
            <span className="absolute inline-flex w-full h-full rounded-full opacity-75 animate-ping bg-emerald-500" />
            <span className="relative inline-flex w-2 h-2 rounded-full bg-emerald-500" />
          </span>
          Live · refreshes every 30s
        </span>
        {lastUpdated && (
          <span className={DS.muted}>
            Updated {lastUpdated.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}
          </span>
        )}
        <button
          onClick={() => void refresh()}
          className={cx(DS.btn, DS.btnSoft)}
        >
          <RefreshCw className="w-3.5 h-3.5" /> Refresh now
        </button>
      </div>

      {loading && reports.length === 0 ? (
        <div className={cx(DS.card, 'flex items-center justify-center gap-2 py-12')}>
          <Spinner /> <span className={DS.muted}>Loading reports…</span>
        </div>
      ) : monitoredMembers.length === 0 ? (
        <div className={DS.card}>
          <EmptyState icon={Radio} title="No members assigned to you yet." />
        </div>
      ) : (
        /* Team-Collaboration roster: soft striped table, one row per member.
           Clicking a row opens that member's report table beneath it. */
        <div className={cx(DS.card, 'p-4')}>
          <CardHead
            title="Team roster"
            subtitle={`Reports for ${dateLabel}`}
            action={<span className={DS.chip}>{monitoredMembers.length} {monitoredMembers.length === 1 ? 'member' : 'members'}</span>}
            className="mb-4"
          />
          <div className="overflow-x-auto -mx-1 sm:mx-0 pr-1">
            <table className={cx(DS.tableSoft, 'min-w-[460px]')}>
              <thead>
                <tr>
                  <th className={DS.thSoft}>Colleague</th>
                  <th className={DS.thSoft}>Activity</th>
                  <th className={cx(DS.thSoft, 'text-center')}>Hours</th>
                  <th className={cx(DS.thSoft, 'text-right')}>Status</th>
                </tr>
              </thead>
              <tbody>
                {monitoredMembers.map((m, idx) => {
                  const rep = reportByUser[m.id]
                  const status = memberStatus(rep)
                  const hrs = perDayHours(rep)
                  const isOpen = expandedUserId === m.id
                  const rowCount = rep?.rows?.length ?? 0
                  return (
                    <Fragment key={m.id}>
                      <tr
                        onClick={() => setExpandedUserId(isOpen ? null : m.id)}
                        className={cx(idx % 2 === 0 ? DS.trSoftEven : DS.trSoftOdd, 'cursor-pointer', isOpen && '!bg-bp-50')}
                        aria-expanded={isOpen}
                      >
                        {/* Colleague */}
                        <td className={cx(DS.tdSoft, 'font-semibold text-[#111827]')}>
                          <div className="flex items-center gap-2 max-w-[200px]">
                            <Avatar url={m.avatar_url} name={m.full_name} email={m.email} size="xs" className="!rounded-full" />
                            <span className="truncate font-semibold">{m.full_name || m.email}</span>
                            {isOpen
                              ? <ChevronUp className="w-3.5 h-3.5 text-[#9CA3AF] shrink-0" />
                              : <ChevronDown className="w-3.5 h-3.5 text-[#9CA3AF] shrink-0" />}
                          </div>
                        </td>
                        {/* Activity */}
                        <td className={cx(DS.tdSoft, 'font-normal text-[#6B7280] max-w-[220px] truncate')}>
                          {activityLabel(rep)}
                        </td>
                        {/* Hours */}
                        <td className={cx(DS.tdSoft, 'text-center font-semibold text-[#374151] tabular-nums whitespace-nowrap')}>
                          {hrs > 0 ? `${hrs} hrs` : '—'}
                        </td>
                        {/* Status */}
                        <td className={cx(DS.tdSoft, 'text-right whitespace-nowrap')}>
                          <StatusPill tone={status.tone}>{status.label}</StatusPill>
                        </td>
                      </tr>

                      {isOpen && (
                        <tr>
                          <td colSpan={4} className="px-0 pt-0.5 pb-1">
                            {!rep || rowCount === 0 ? (
                              <div className={DS.card}>
                                <EmptyState compact icon={Clock} title="No entries for this date." />
                              </div>
                            ) : (
                              <div className={cx(DS.card, 'overflow-hidden')}>
                                <div className="overflow-x-auto">
                                  <table className={DS.table}>
                                    <thead className={DS.thead}>
                                      <tr>
                                        <th className={cx(DS.th, 'w-8')}>#</th>
                                        <th className={DS.th}>Type</th>
                                        <th className={DS.th}>Specific Work</th>
                                        <th className={DS.th}>Status</th>
                                        <th className={DS.th}>Today</th>
                                        <th className={DS.th}>Comments</th>
                                      </tr>
                                    </thead>
                                    <tbody className={DS.tbody}>
                                      {(rep.rows ?? []).map((row: DailyReportRow) => {
                                        const perDay = perDayElapsedSeconds(row, [rep])
                                        const sw = STOPWATCH_LABEL[row.stopwatch_status] ?? STOPWATCH_LABEL.idle
                                        const thread = commentsByRow[row.id] ?? []
                                        return (
                                          <tr key={row.id} className={DS.trHover}>
                                            <td className={cx(DS.td, 'text-[#9CA3AF] font-semibold tabular-nums')}>{row.sr_no}</td>
                                            <td className={DS.td}>
                                              <span className="font-semibold text-[#111827]">{row.type_of_work}</span>
                                              {row.sub_category && <span className="text-xs text-[#9CA3AF] font-medium block">{row.sub_category}</span>}
                                            </td>
                                            <td className={cx(DS.td, 'text-[#6B7280]')}>{row.specific_work || '—'}</td>
                                            <td className={DS.td}>
                                              <StatusPill tone={sw.tone}>{sw.label}</StatusPill>
                                            </td>
                                            <td className={cx(DS.td, 'font-semibold text-[#111827] tabular-nums whitespace-nowrap')}>
                                              {elapsedToTimeTaken(perDay)}
                                            </td>
                                            <td className={cx(DS.td, 'min-w-[260px]')}>
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
                                </div>
                              </div>
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
          <p className="mt-3 pt-2 border-t border-[#C5CAD1] text-xs font-medium text-[#9CA3AF] text-center">
            {monitoredMembers.length} {monitoredMembers.length === 1 ? 'member' : 'members'} · {reports.filter(r => r.is_locked).length} submitted
          </p>
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
        <p className={cx(DS.muted, 'italic')}>No comments yet.</p>
      ) : (
        <ul className="space-y-1.5">
          {comments.map(c => (
            <li key={c.id} className="rounded-[6px] px-3 py-2 bg-bp-50 border border-bp-100">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-[11px] font-semibold text-bp-800">
                    {c.author_name}
                    <span className="text-[#9CA3AF] font-medium ml-1.5">
                      {new Date(c.created_at).toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}
                    </span>
                  </p>
                  <p className="text-xs text-[#374151] font-medium whitespace-pre-wrap break-words mt-0.5">{c.body}</p>
                </div>
                {c.author_id === currentUserId && (
                  <button
                    onClick={() => void onDelete(c.id)}
                    className="text-[#9CA3AF] hover:text-rose-600 shrink-0 transition-colors cursor-pointer"
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
        className="flex items-center gap-1.5"
      >
        <input
          type="text"
          value={draft}
          onChange={e => setDraft(e.target.value)}
          placeholder="Leave feedback…"
          className={cx(DS.input, 'flex-1 min-w-0 !text-xs !px-3 !py-2 !rounded-[6px]')}
          aria-label={`Comment on row ${rowId}`}
        />
        <button
          type="submit"
          disabled={!draft.trim() || sending}
          className="w-8 h-8 rounded-[6px] grid place-items-center bg-bp-700 text-white hover:bg-bp-800 transition-colors cursor-pointer shrink-0 disabled:opacity-40 disabled:cursor-not-allowed"
          title="Post comment"
        >
          {sending ? <Clock className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
        </button>
      </form>
    </div>
  )
}
