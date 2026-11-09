/**
 * Assign Projects — capability-gated tab (branding:assign_projects).
 *
 * A branding head grants this capability to certain leads (via Team Members →
 * Extra capabilities). Those leads land here to create a project — name, type
 * of work, sub-category, specific work, deadline — and assign it to designers
 * they manage. Each assignment seeds a row in that designer's daily report for
 * the chosen work date (handled server-side by POST /projects/assign).
 */
import { useEffect, useMemo, useState } from 'react'
import { FolderPlus, CalendarDays, Users, Check, Clock, ListChecks, CheckCircle2 } from 'lucide-react'
import { toast } from 'sonner'
import { useAuth } from '@/hooks/useAuth'
import { useAppData } from '@/hooks/useAppData'
import { brandingApi } from '@/lib/branding-api'
import type { WorkCategory, BrandingProject } from '@/lib/branding-types'
import { DS, cx, Card, Badge, EmptyState, StatCard, DarkStatCard, BlockHeader, Meter, toneForStatus } from './ds'

function todayLocal(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export default function BrandingProjectsAssign() {
  const { user, role } = useAuth()
  const { users } = useAppData()
  const isAdmin = role === 'super_admin' || role === 'admin'

  const [categories, setCategories] = useState<WorkCategory[]>([])
  const [projects, setProjects] = useState<BrandingProject[]>([])

  const [name, setName] = useState('')
  const [type, setType] = useState('')
  const [subCat, setSubCat] = useState('')
  const [specific, setSpecific] = useState('')
  const [deadline, setDeadline] = useState('')
  const [workDate, setWorkDate] = useState(todayLocal())
  const [assignees, setAssignees] = useState<string[]>([])
  const [assignLead, setAssignLead] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => { brandingApi.getCategories().then(r => setCategories(r.categories)).catch(() => {}) }, [])
  useEffect(() => { brandingApi.getProjects().then(r => setProjects(r.projects)).catch(() => {}) }, [])

  // "Assign to designers" lists the WHOLE branding team — designers, leads and
  // task managers — for every actor (no managed-by scoping), so anyone using
  // this page sees the same roster the head sees. Self is excluded.
  const designers = useMemo(() => users.filter(u =>
    u.team === 'branding' && (u.role === 'user' || u.role === 'sub_admin' || u.role === 'task_owner' || u.role === 'task_manager') &&
    u.id !== user?.id
  ), [users, user?.id])

  // "Assign Lead" dropdown: supervisory profiles — the branding head (admin),
  // leads, task owners and task managers. Optional, and does NOT get a
  // daily-report row. Not scoped — a supervising link.
  const leads = useMemo(() => users.filter(u =>
    u.team === 'branding' && (u.role === 'admin' || u.role === 'sub_admin' || u.role === 'task_owner' || u.role === 'task_manager')
  ), [users])

  const subCategories = useMemo(
    () => categories.find(c => c.name === type)?.sub_categories ?? [],
    [categories, type],
  )
  const nameById = useMemo(() => new Map(users.map(u => [u.id, u.full_name || u.email])), [users])

  function toggleAssignee(id: string) {
    setAssignees(a => a.includes(id) ? a.filter(x => x !== id) : [...a, id])
  }

  function reset() {
    setName(''); setType(''); setSubCat(''); setSpecific(''); setDeadline(''); setWorkDate(todayLocal()); setAssignees([]); setAssignLead('')
  }

  async function submit() {
    if (!name.trim()) { toast.error('Project name is required.'); return }
    if (!type) { toast.error('Type of work is required.'); return }
    if (!subCat) { toast.error('Sub-category is required.'); return }
    if (!specific.trim()) { toast.error('Specific work is required.'); return }
    if (!workDate) { toast.error('Work date is required.'); return }
    if (assignees.length === 0) { toast.error('Select at least one designer to assign.'); return }
    setSaving(true)
    try {
      const { project } = await brandingApi.assignProject({
        name: name.trim(),
        description: undefined,
        deadline: deadline || undefined,
        type_of_work: type,
        sub_category: subCat,
        specific_work: specific.trim(),
        assigned_user_ids: assignees,
        assign_lead_id: assignLead || undefined,
        work_date: workDate,
      })
      setProjects(prev => [project, ...prev])
      reset()
      toast.success(`Assigned to ${project.assigned_user_ids.length} member${project.assigned_user_ids.length === 1 ? '' : 's'} — added to their daily report.`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to assign project.')
    } finally { setSaving(false) }
  }

  const pending = projects.filter(p => p.status !== 'completed')
  const completed = projects.filter(p => p.status === 'completed')
  const openAssignments = pending.reduce((n, p) => n + p.assignments.filter(a => a.status !== 'completed').length, 0)
  const dueSoon = pending.filter(p => {
    if (!p.deadline) return false
    const days = (new Date(p.deadline).getTime() - Date.now()) / 86400000
    return days <= 7
  }).length

  return (
    <div className="space-y-4 lg:flex-1 flex flex-col">
      {/* KPI strip */}
      <div>
        <BlockHeader
          title="At a glance"
          subtitle={`${projects.length} project${projects.length === 1 ? '' : 's'} · branding team`}
        />
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        <DarkStatCard title="Open projects" value={String(pending.length).padStart(2, '0')} sub="Still being worked on" icon={ListChecks} />
        <StatCard title="Completed" value={completed.length} sub="Every assignee signed off" icon={CheckCircle2}
          meter={projects.length > 0 ? { done: completed.length, total: projects.length, label: `${Math.round((completed.length / projects.length) * 100)}% of all projects` } : undefined} />
        <StatCard title="Open assignments" value={openAssignments} sub="Rows waiting in daily reports" icon={Users} />
        <StatCard title="Due this week" value={dueSoon} sub={dueSoon > 0 ? 'Deadlines inside 7 days' : 'Nothing due soon'} icon={CalendarDays} />
      </div>
      </div>

      {/* The three columns fill the rest of the screen on desktop and share
          one height, so every card's bottom edge lands on the same line and
          no empty canvas is left below. Extra height goes to the team picker
          and the project lists; on a short screen the form sets the height
          and the page scrolls. */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 items-stretch lg:flex-1">
        {/* ── Create / assign form ─────────────────────────────────── */}
        <Card
          title="New assignment"
          subtitle="Each selected member gets a row in their daily report on the work date."
          eyebrow="Create"
          bodyClassName="flex-1 flex flex-col min-h-0"
        >
          <div className="space-y-4 flex-1 flex flex-col">
            <div>
              <label className={DS.label}>Project name <span className="text-rose-500">*</span></label>
              <input className={DS.input} placeholder="e.g. Convocation 2026 collateral" value={name} onChange={e => setName(e.target.value)} />
            </div>

            <div className="grid grid-cols-1 gap-4">
              <div>
                <label className={DS.label}>Type of work <span className="text-rose-500">*</span></label>
                <select className={DS.select} value={type} onChange={e => { setType(e.target.value); setSubCat('') }}>
                  <option value="">Select type of work…</option>
                  {categories.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
                </select>
              </div>
              <div>
                <label className={DS.label}>Sub-category <span className="text-rose-500">*</span></label>
                <select className={DS.select} value={subCat} onChange={e => setSubCat(e.target.value)} disabled={!type}>
                  <option value="">{type ? 'Select sub-category…' : 'Pick a type first'}</option>
                  {subCategories.map(s => <option key={s.id} value={s.name}>{s.name}</option>)}
                </select>
              </div>
            </div>

            <div>
              <label className={DS.label}>Specific work <span className="text-rose-500">*</span></label>
              <input className={DS.input} placeholder="e.g. Design 3 Instagram creatives" value={specific} onChange={e => setSpecific(e.target.value)} />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className={DS.label}>Deadline</label>
                <input type="date" className={DS.input} value={deadline} onChange={e => setDeadline(e.target.value)} />
              </div>
              <div>
                <label className={DS.label}>Work date <span className="text-rose-500">*</span></label>
                <input type="date" className={DS.input} value={workDate} onChange={e => setWorkDate(e.target.value)} />
                <p className={DS.hint}>Day the row appears in the designer's report.</p>
              </div>
            </div>

            <div className="lg:flex-1 flex flex-col">
              <label className={DS.label}>
                Assign to designers / leads <span className="text-rose-500">*</span>
                {assignees.length > 0 && <Badge tone="info" className="ml-2">{assignees.length} selected</Badge>}
              </label>
              {designers.length === 0 ? (
                <EmptyState compact icon={Users} title="No members to assign"
                  body={isAdmin ? 'Add branding team members first.' : 'No branding team members found yet.'}
                  className="border border-dashed border-[#C5CAD1] rounded-[6px]" />
              ) : (
                <div className="relative border border-[#C5CAD1] rounded-[6px] divide-y divide-[#C5CAD1] max-h-56 lg:max-h-none lg:grow lg:h-0 lg:min-h-56 overflow-y-auto">
                  {designers.map(d => {
                    const checked = assignees.includes(d.id)
                    const roleLabel = d.role === 'sub_admin' ? 'Lead' : d.role === 'task_owner' ? 'Task Owner' : d.role === 'task_manager' ? 'Task Manager' : 'Designer'
                    return (
                      <label key={d.id} className={cx('flex items-center gap-3 px-3 py-2.5 cursor-pointer transition-colors', checked ? 'bg-bp-50/60' : 'hover:bg-[#F9FAFB]')}>
                        <span className={cx('w-[18px] h-[18px] rounded-md grid place-items-center border transition-colors shrink-0', checked ? 'bg-bp-700 border-bp-700 text-white' : 'border-[#9CA3AF] bg-white')}>
                          {checked && <Check className="w-3 h-3 stroke-[3]" />}
                        </span>
                        <input type="checkbox" className="sr-only" checked={checked} onChange={() => toggleAssignee(d.id)} />
                        <span className="text-sm font-medium text-[#111827] truncate">{d.full_name || d.email}</span>
                        <span className="ml-auto text-[10px] font-semibold uppercase tracking-wider text-[#9CA3AF] shrink-0">{roleLabel}</span>
                      </label>
                    )
                  })}
                </div>
              )}
            </div>

            <div>
              <label className={DS.label}>
                Supervising lead <span className="font-medium text-[#9CA3AF]">(optional, no report row)</span>
              </label>
              <select className={DS.select} value={assignLead} onChange={e => setAssignLead(e.target.value)}>
                <option value="">No supervising lead</option>
                {leads.map(l => <option key={l.id} value={l.id}>{l.full_name || l.email}{l.role === 'admin' ? ' (Head)' : l.role === 'task_owner' ? ' (Task Owner)' : l.role === 'task_manager' ? ' (Task Manager)' : ''}</option>)}
              </select>
            </div>

            <button onClick={() => void submit()} disabled={saving} className={cx(DS.btn, DS.btnPrimary, 'w-full !py-3')}>
              <FolderPlus className="w-4 h-4 stroke-[2.5]" />
              {saving ? 'Assigning…' : 'Create & assign'}
            </button>
          </div>
        </Card>

        {/* ── Project status: Pending vs Completed columns ─────────── */}
        {/* A project moves to Completed when every assigned designer /
            lead has marked their part done (server flips status then);
            partially-done pending projects show an n/m progress hint. */}
        {/* On desktop each list is absolutely positioned inside its grid
            cell, so the cell adds no height of its own: the row is exactly
            as tall as the form and the list scrolls within it. */}
        <div className="relative lg:min-h-0">
          <div className="lg:absolute lg:inset-0">
            <ProjectStatusColumn
              title="Pending projects"
              eyebrow="In progress"
              empty="No pending projects."
              emptyBody="Create one on the left and it will appear here."
              items={pending.slice(0, 40)}
              nameById={nameById}
            />
          </div>
        </div>
        <div className="relative lg:min-h-0">
          <div className="lg:absolute lg:inset-0">
            <ProjectStatusColumn
              title="Completed projects"
              eyebrow="Delivered"
              empty="No completed projects yet."
              emptyBody="Projects move here once every assignee has signed off."
              items={completed.slice(0, 40)}
              nameById={nameById}
            />
          </div>
        </div>
      </div>
    </div>
  )
}

function ProjectStatusColumn({ title, eyebrow, empty, emptyBody, items, nameById }: {
  title: string
  eyebrow: string
  empty: string
  emptyBody?: string
  items: BrandingProject[]
  nameById: Map<string, string>
}) {
  return (
    <Card title={title} eyebrow={eyebrow} action={<Badge tone="neutral">{items.length}</Badge>} className="h-full" bodyClassName="flex-1 min-h-0 flex flex-col">
      {items.length === 0 ? (
        <EmptyState compact icon={ListChecks} title={empty} body={emptyBody} className="my-auto" />
      ) : (
        <div className="space-y-3 flex-1 min-h-0 max-h-[70vh] lg:max-h-none overflow-y-auto -mx-1 px-1">
          {items.map(p => {
            const doneCount = p.assignments.filter(a => a.status === 'completed').length
            const overdue = p.status !== 'completed' && p.deadline && new Date(p.deadline).getTime() < Date.now()
            return (
              <div key={p.id} className="border border-[#C5CAD1] rounded-[6px] p-3.5 hover:border-bp-300 transition-colors bg-white">
                <div className="flex items-start justify-between gap-2">
                  <p className="text-sm font-semibold text-[#111827] leading-snug">{p.name}</p>
                  <Badge tone={overdue ? 'danger' : toneForStatus(p.status)} className="capitalize">{overdue ? 'overdue' : p.status.replace('_', ' ')}</Badge>
                </div>
                {(p.type_of_work || p.specific_work) && (
                  <p className="text-xs text-[#6B7280] font-medium mt-1 leading-relaxed">
                    {[p.type_of_work, p.sub_category].filter(Boolean).join(' · ')}
                    {p.specific_work ? ` — ${p.specific_work}` : ''}
                  </p>
                )}
                {p.assignments.length > 0 && p.status !== 'completed' && (
                  <Meter value={doneCount} max={p.assignments.length} className="mt-2.5"
                    label={`${doneCount} of ${p.assignments.length} assignee${p.assignments.length === 1 ? '' : 's'} done`} />
                )}
                <div className="flex items-center flex-wrap gap-x-3.5 gap-y-1 mt-2.5 text-[11px] font-semibold text-[#9CA3AF]">
                  {p.deadline && <span className={cx('inline-flex items-center gap-1', overdue && 'text-rose-600')}><CalendarDays className="w-3 h-3" /> Due {new Date(p.deadline).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</span>}
                  <span className="inline-flex items-center gap-1"><Users className="w-3 h-3" /> {p.assigned_user_ids.length} assigned</span>
                  <span className="inline-flex items-center gap-1"><Clock className="w-3 h-3" /> {new Date(p.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</span>
                </div>
                {p.assignments.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {p.assignments.map(a => (
                      <Badge key={a.user_id} tone={a.status === 'completed' ? 'success' : 'neutral'}>
                        {a.status === 'completed' && <Check className="w-2.5 h-2.5 stroke-[3]" />}
                        {nameById.get(a.user_id) ?? 'Unknown'}
                      </Badge>
                    ))}
                  </div>
                )}
                {p.assigned_lead_id && (
                  <p className="text-[11px] font-medium text-[#6B7280] mt-2">Lead · {nameById.get(p.assigned_lead_id) ?? 'Unknown'}</p>
                )}
              </div>
            )
          })}
        </div>
      )}
    </Card>
  )
}
