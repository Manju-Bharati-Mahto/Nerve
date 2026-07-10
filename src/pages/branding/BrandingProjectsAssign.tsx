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
import { FolderPlus, CalendarDays, Users, Check, Clock } from 'lucide-react'
import { toast } from 'sonner'
import { useAuth } from '@/hooks/useAuth'
import { useAppData } from '@/hooks/useAppData'
import { brandingApi } from '@/lib/branding-api'
import type { WorkCategory, BrandingProject } from '@/lib/branding-types'

function todayLocal(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const GREEN = '#1a472a'

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

  const inputCls = 'w-full text-sm border border-gray-200 rounded-xl px-3 py-2.5 bg-white focus:outline-none focus:ring-2 focus:ring-green-200'
  const labelCls = 'text-xs font-bold uppercase tracking-wide mb-1 block'

  return (
    <div className="max-w-6xl mx-auto">
      <div className="flex items-center gap-3 mb-5">
        <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: GREEN }}>
          <FolderPlus className="w-5 h-5 text-white" />
        </div>
        <div>
          <h1 className="text-xl font-extrabold font-serif" style={{ color: GREEN }}>Assign Projects</h1>
          <p className="text-sm text-gray-500">Create a project and assign it to your designers — it lands in their daily report.</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* ── Create / assign form ─────────────────────────────────── */}
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 space-y-3">
          <h2 className="text-sm font-bold" style={{ color: GREEN }}>New assignment</h2>

          <div>
            <label className={labelCls} style={{ color: GREEN }}>Project Name *</label>
            <input className={inputCls} placeholder="e.g. Convocation 2026 collateral" value={name} onChange={e => setName(e.target.value)} />
          </div>

          <div>
            <label className={labelCls} style={{ color: GREEN }}>Type of Work *</label>
            <select className={inputCls} value={type} onChange={e => { setType(e.target.value); setSubCat('') }}>
              <option value="">Select type of work…</option>
              {categories.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
            </select>
          </div>

          <div>
            <label className={labelCls} style={{ color: GREEN }}>Sub-category *</label>
            <select className={`${inputCls} disabled:bg-gray-50 disabled:text-gray-400`} value={subCat} onChange={e => setSubCat(e.target.value)} disabled={!type}>
              <option value="">{type ? 'Select sub-category…' : 'Pick a type of work first'}</option>
              {subCategories.map(s => <option key={s.id} value={s.name}>{s.name}</option>)}
            </select>
          </div>

          <div>
            <label className={labelCls} style={{ color: GREEN }}>Specific Work *</label>
            <input className={inputCls} placeholder="e.g. Design 3 Instagram creatives" value={specific} onChange={e => setSpecific(e.target.value)} />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls} style={{ color: GREEN }}>Deadline</label>
              <input type="date" className={inputCls} value={deadline} onChange={e => setDeadline(e.target.value)} />
            </div>
            <div>
              <label className={labelCls} style={{ color: GREEN }}>Work date *</label>
              <input type="date" className={inputCls} value={workDate} onChange={e => setWorkDate(e.target.value)} />
              <p className="text-[10px] text-gray-400 mt-1">Day the row appears in the designer's report.</p>
            </div>
          </div>

          <div>
            <label className={labelCls} style={{ color: GREEN }}>Assign to designers / leads *</label>
            {designers.length === 0 ? (
              <p className="text-xs text-gray-400 border border-gray-100 rounded-xl px-3 py-3">
                No members to assign. {isAdmin ? 'Add branding team members first.' : 'No branding team members found yet.'}
              </p>
            ) : (
              <div className="border border-gray-100 rounded-xl divide-y divide-gray-50 max-h-52 overflow-y-auto">
                {designers.map(d => {
                  const checked = assignees.includes(d.id)
                  const roleLabel = d.role === 'sub_admin' ? 'Lead' : d.role === 'task_owner' ? 'Task Owner' : d.role === 'task_manager' ? 'Task Manager' : 'Designer'
                  return (
                    <label key={d.id} className="flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-gray-50">
                      <span className={`w-4 h-4 rounded flex items-center justify-center border ${checked ? 'text-white' : 'border-gray-300'}`}
                        style={checked ? { background: GREEN, borderColor: GREEN } : {}}>
                        {checked && <Check className="w-3 h-3" />}
                      </span>
                      <input type="checkbox" className="hidden" checked={checked} onChange={() => toggleAssignee(d.id)} />
                      <span className="text-sm text-gray-700 truncate">{d.full_name || d.email}</span>
                      <span className="ml-auto text-[10px] uppercase tracking-wide text-gray-400">{roleLabel}</span>
                    </label>
                  )
                })}
              </div>
            )}
            <p className="text-[10px] text-gray-400 mt-1">Each selected member gets a row in their daily report on the work date.</p>
          </div>

          <div>
            <label className={labelCls} style={{ color: GREEN }}>Assign Lead <span className="normal-case font-normal text-gray-400">(optional — supervisory, no report row)</span></label>
            <select className={inputCls} value={assignLead} onChange={e => setAssignLead(e.target.value)}>
              <option value="">No supervising lead</option>
              {leads.map(l => <option key={l.id} value={l.id}>{l.full_name || l.email}{l.role === 'admin' ? ' (Head)' : l.role === 'task_owner' ? ' (Task Owner)' : l.role === 'task_manager' ? ' (Task Manager)' : ''}</option>)}
            </select>
          </div>

          <button onClick={() => void submit()} disabled={saving}
            className="w-full py-2.5 rounded-xl text-sm font-semibold text-white disabled:opacity-50 transition-opacity mt-1"
            style={{ background: GREEN }}>
            {saving ? 'Assigning…' : 'Create & Assign'}
          </button>
        </div>

        {/* ── Project status: Pending vs Completed columns ─────────── */}
        {/* A project moves to Completed when every assigned designer /
            lead has marked their part done (server flips status then);
            partially-done pending projects show an n/m progress hint. */}
        <ProjectStatusColumn
          title="Pending Projects"
          empty="No pending projects."
          items={projects.filter(p => p.status !== 'completed').slice(0, 40)}
          nameById={nameById}
        />
        <ProjectStatusColumn
          title="Completed Projects"
          empty="No completed projects yet."
          items={projects.filter(p => p.status === 'completed').slice(0, 40)}
          nameById={nameById}
        />
      </div>
    </div>
  )
}

function ProjectStatusColumn({ title, empty, items, nameById }: {
  title: string
  empty: string
  items: BrandingProject[]
  nameById: Map<string, string>
}) {
  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
      <h2 className="text-sm font-bold mb-3" style={{ color: GREEN }}>{title} ({items.length})</h2>
      {items.length === 0 ? (
        <p className="text-sm text-gray-400 py-8 text-center">{empty}</p>
      ) : (
        <div className="space-y-2.5 max-h-[70vh] overflow-y-auto">
          {items.map(p => {
            const doneCount = p.assignments.filter(a => a.status === 'completed').length
            return (
              <div key={p.id} className="border border-gray-100 rounded-xl p-3">
                <div className="flex items-start justify-between gap-2">
                  <p className="text-sm font-semibold text-gray-800">{p.name}</p>
                  <span className="text-[10px] px-2 py-0.5 rounded-full shrink-0"
                    style={{ background: p.status === 'completed' ? '#e6f4ea' : p.status === 'on_hold' ? '#fef3c7' : '#e8f0eb', color: p.status === 'on_hold' ? '#92400e' : GREEN }}>
                    {p.status.replace('_', ' ')}
                  </span>
                </div>
                {(p.type_of_work || p.specific_work) && (
                  <p className="text-xs text-gray-500 mt-0.5">
                    {[p.type_of_work, p.sub_category].filter(Boolean).join(' · ')}
                    {p.specific_work ? ` — ${p.specific_work}` : ''}
                  </p>
                )}
                <div className="flex items-center flex-wrap gap-x-4 gap-y-1 mt-1.5 text-[11px] text-gray-400">
                  {p.deadline && <span className="inline-flex items-center gap-1"><CalendarDays className="w-3 h-3" /> Due {new Date(p.deadline).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>}
                  <span className="inline-flex items-center gap-1"><Users className="w-3 h-3" /> {p.assigned_user_ids.length} assigned</span>
                  {p.assignments.length > 0 && p.status !== 'completed' && (
                    <span className="inline-flex items-center gap-1"><Check className="w-3 h-3" /> {doneCount}/{p.assignments.length} done</span>
                  )}
                  <span className="inline-flex items-center gap-1"><Clock className="w-3 h-3" /> {new Date(p.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
                </div>
                {/* Per-member status (req 6): who's finished vs pending. */}
                {p.assignments.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {p.assignments.map(a => (
                      <span key={a.user_id} className="text-[10px] px-1.5 py-0.5 rounded-full inline-flex items-center gap-1"
                        style={a.status === 'completed' ? { background: '#e6f4ea', color: GREEN } : { background: '#f3f4f6', color: '#6b7280' }}>
                        {a.status === 'completed' && <Check className="w-2.5 h-2.5" />}
                        {nameById.get(a.user_id) ?? 'Unknown'}
                      </span>
                    ))}
                  </div>
                )}
                {p.assigned_lead_id && (
                  <p className="text-[11px] text-gray-500 mt-1">Lead: {nameById.get(p.assigned_lead_id) ?? 'Unknown'}</p>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
