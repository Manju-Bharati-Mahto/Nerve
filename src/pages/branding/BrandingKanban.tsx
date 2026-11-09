/**
 * Design Leads — Kanban Board.
 *
 * One board per lead: pick a lead, see their profile and month figures,
 * filter by designer, and drag project cards across six workflow columns
 * (Not Started → In Progress → In Review → Changes Received → Approved →
 * Delivered). Everything here is live Nerve data:
 *
 *   · leads      branding users with a lead role (sub_admin / task_owner /
 *                task_manager); a lead who opens the page lands on their own tab
 *   · team       people managed by that lead, plus anyone assigned to one of
 *                the lead's projects
 *   · projects   branding projects the lead supervises or created
 *   · hours      this month's submitted daily-report hours per designer
 *   · column     `board_status` on the project (persisted on drop); dropping on
 *                Delivered also marks the project completed
 *
 * Rendered for the head inside BrandingAdminShell at /branding/team, and for
 * leads as the "Kanban Board" page of their own dashboard (`embedded`).
 */
import { useCallback, useEffect, useMemo, useState, type DragEvent } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Plus, Users, Clock, CalendarDays, Check, Flag, ArrowUpRight, ListChecks, Inbox } from 'lucide-react'
import { toast } from 'sonner'
import { useAuth } from '@/hooks/useAuth'
import { useAppData } from '@/hooks/useAppData'
import { brandingApi } from '@/lib/branding-api'
import { timeToHours, MONTHS } from '@/lib/branding-types'
import type { BrandingProject, BoardStatus, ProjectPriority, WorkCategory, DailyReport } from '@/lib/branding-types'
import { DS, cx, Avatar, Badge, Modal, EmptyState, Spinner, Segmented } from './ds'

// ── Board vocabulary ───────────────────────────────────────────────────────

const STATUSES: { id: BoardStatus; label: string; head: string; title: string; count: string }[] = [
  { id: 'notstarted', label: 'Not Started',      head: 'bg-[#F9FAFB]',   title: 'text-[#6B7280]',   count: 'bg-[#E5E7EB] text-[#6B7280]' },
  { id: 'inprogress', label: 'In Progress',      head: 'bg-bp-50',      title: 'text-bp-700',      count: 'bg-bp-100 text-bp-800' },
  { id: 'review',     label: 'In Review',        head: 'bg-amber-50',   title: 'text-amber-700',   count: 'bg-amber-100 text-amber-800' },
  { id: 'changes',    label: 'Changes Received', head: 'bg-rose-50',    title: 'text-rose-700',    count: 'bg-rose-100 text-rose-800' },
  { id: 'approved',   label: 'Approved',         head: 'bg-violet-50',  title: 'text-violet-700',  count: 'bg-violet-100 text-violet-800' },
  { id: 'delivered',  label: 'Delivered',        head: 'bg-emerald-50', title: 'text-emerald-700', count: 'bg-emerald-100 text-emerald-800' },
]

const PRIORITY: Record<ProjectPriority, { dot: string; label: string; next: ProjectPriority }> = {
  high:   { dot: 'bg-rose-500',    label: 'High priority',   next: 'medium' },
  medium: { dot: 'bg-amber-500',   label: 'Medium priority', next: 'low' },
  low:    { dot: 'bg-emerald-500', label: 'Low priority',    next: 'high' },
}

const LEAD_ROLES = new Set(['sub_admin', 'task_owner', 'task_manager'])

/** Lead accent colours, cycled in roster order (navy, blue, teal, violet, amber). */
const LEAD_COLORS = ['#1A3C6E', '#2E5FA3', '#0A5C43', '#3C3489', '#7A4500']

/** Category chip tints, chosen by name so a category keeps its colour everywhere. */
const CAT_TINTS = [
  'bg-bp-50 text-bp-800', 'bg-emerald-50 text-emerald-800', 'bg-amber-50 text-amber-800',
  'bg-violet-50 text-violet-800', 'bg-rose-50 text-rose-800', 'bg-sky-50 text-sky-800', 'bg-lime-50 text-lime-800',
]
function catTint(name: string): string {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return CAT_TINTS[h % CAT_TINTS.length]
}

/** The column a project sits in. Older rows predate the board, so a completed
 *  project that was never dragged still shows under Delivered. */
function columnOf(p: BrandingProject): BoardStatus {
  if (p.board_status !== 'notstarted') return p.board_status
  if (p.status === 'completed') return 'delivered'
  if (p.status === 'on_hold') return 'changes'
  if (p.assignments.some(a => a.status === 'completed')) return 'inprogress'
  return 'notstarted'
}

const fmtDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

function deadlineChip(deadline: string | null) {
  if (!deadline) return null
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const due = new Date(deadline); due.setHours(0, 0, 0, 0)
  const diff = Math.ceil((due.getTime() - today.getTime()) / 86400000)
  const label = due.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
  if (diff < 0) return <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-rose-50 text-rose-700">Overdue · {label}</span>
  if (diff <= 3) return <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-amber-50 text-amber-700">Due {label}</span>
  return <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-[#F3F4F6] text-[#6B7280] inline-flex items-center gap-1"><CalendarDays className="w-3 h-3" />{label}</span>
}

// ── Page ───────────────────────────────────────────────────────────────────

export default function BrandingKanban({ embedded = false }: { embedded?: boolean }) {
  const { profile, role } = useAuth()
  const { users } = useAppData()
  const isAdmin = role === 'super_admin' || role === 'admin' || role === 'branding_reports_admin'

  const [projects, setProjects] = useState<BrandingProject[]>([])
  const [categories, setCategories] = useState<WorkCategory[]>([])
  const [monthReports, setMonthReports] = useState<DailyReport[]>([])
  const [loading, setLoading] = useState(true)

  const reload = useCallback(() => {
    return brandingApi.getProjects().then(r => setProjects(r.projects)).catch(() => {})
  }, [])

  useEffect(() => {
    setLoading(true)
    Promise.all([
      brandingApi.getProjects().then(r => setProjects(r.projects)),
      brandingApi.getCategories().then(r => setCategories(r.categories)),
    ]).catch(() => {}).finally(() => setLoading(false))
  }, [])

  // Hours this month, whole team, submitted reports only.
  useEffect(() => {
    const now = new Date()
    brandingApi.getAllReports({ dateFrom: fmtDate(new Date(now.getFullYear(), now.getMonth(), 1)), dateTo: fmtDate(now), lockedOnly: true, teamScope: true })
      .then(r => setMonthReports(r.reports))
      .catch(() => setMonthReports([]))
  }, [])

  // ── Leads and the active tab ─────────────────────────────────────────────
  const brandingUsers = useMemo(() => users.filter(u => u.team === 'branding'), [users])
  // Admins get a tab per lead; a lead gets their own board only.
  const leads = useMemo(
    () => brandingUsers.filter(u => LEAD_ROLES.has(u.role) && (isAdmin || u.id === profile?.id)),
    [brandingUsers, isAdmin, profile?.id],
  )
  // ?lead=<id> opens that lead's tab and ?col=<status> rings that column —
  // the Team Members overview deep-links here from its figures.
  const [searchParams] = useSearchParams()
  const leadParam = searchParams.get('lead')
  const colParam = searchParams.get('col') as BoardStatus | null
  const highlightCol = colParam && STATUSES.some(s => s.id === colParam) ? colParam : null
  const [activeLead, setActiveLead] = useState<string>('')
  useEffect(() => {
    if (activeLead || leads.length === 0) return
    const fromUrl = leadParam && leads.find(l => l.id === leadParam)
    const mine = leads.find(l => l.id === profile?.id)
    setActiveLead(fromUrl ? fromUrl.id : mine ? mine.id : leads[0].id)
  }, [leads, activeLead, profile?.id, leadParam])
  const lead = leads.find(l => l.id === activeLead) ?? null
  const leadColor = (id: string) => LEAD_COLORS[Math.max(0, leads.findIndex(l => l.id === id)) % LEAD_COLORS.length]

  // ── This lead's projects, team, categories ───────────────────────────────
  const leadProjects = useMemo(() => {
    if (!lead) return []
    const managedIds = new Set(brandingUsers.filter(u => u.managed_by === lead.id).map(u => u.id))
    return projects.filter(p =>
      p.assigned_lead_id === lead.id || p.created_by === lead.id ||
      p.assigned_user_ids.some(id => managedIds.has(id)))
  }, [lead, projects, brandingUsers])

  const team = useMemo(() => {
    if (!lead) return []
    const ids = new Set<string>()
    brandingUsers.forEach(u => { if (u.managed_by === lead.id && u.id !== lead.id) ids.add(u.id) })
    leadProjects.forEach(p => p.assigned_user_ids.forEach(id => { if (id !== lead.id) ids.add(id) }))
    return brandingUsers.filter(u => ids.has(u.id))
  }, [lead, brandingUsers, leadProjects])


  const [activeDesigner, setActiveDesigner] = useState<string>('all')
  useEffect(() => { setActiveDesigner('all') }, [activeLead])

  const nameById = useMemo(() => new Map(brandingUsers.map(u => [u.id, u.full_name || u.email])), [brandingUsers])

  // ── Hours by designer (this month) ───────────────────────────────────────
  const hoursByUser = useMemo(() => {
    const m = new Map<string, number>()
    for (const r of monthReports) {
      const h = (r.rows ?? []).reduce((s, row) => s + timeToHours(row.time_taken), 0)
      m.set(r.user_id, (m.get(r.user_id) ?? 0) + h)
    }
    return m
  }, [monthReports])
  const teamHours = team.reduce((s, u) => s + (hoursByUser.get(u.id) ?? 0), 0) + (lead ? hoursByUser.get(lead.id) ?? 0 : 0)
  const fmtH = (h: number) => (Math.round(h * 10) / 10).toString()

  // ── Figures ──────────────────────────────────────────────────────────────
  const visible = useMemo(() => activeDesigner === 'all'
    ? leadProjects
    : leadProjects.filter(p => p.assigned_user_ids.includes(activeDesigner)), [leadProjects, activeDesigner])
  const todayMs = new Date().setHours(0, 0, 0, 0)
  const stats = {
    active: leadProjects.filter(p => columnOf(p) === 'inprogress').length,
    delivered: leadProjects.filter(p => columnOf(p) === 'delivered').length,
    overdue: leadProjects.filter(p => p.deadline && new Date(p.deadline).getTime() < todayMs && columnOf(p) !== 'delivered').length,
  }

  // ── Drag and drop ────────────────────────────────────────────────────────
  const [dragId, setDragId] = useState<string | null>(null)
  const [overCol, setOverCol] = useState<BoardStatus | null>(null)
  const canEdit = isAdmin || LEAD_ROLES.has(role ?? '')

  async function moveTo(projectId: string, to: BoardStatus) {
    const p = projects.find(x => x.id === projectId)
    if (!p || columnOf(p) === to) return
    const prev = projects
    setProjects(ps => ps.map(x => x.id === projectId ? { ...x, board_status: to, status: to === 'delivered' ? 'completed' : 'active' } : x))
    try {
      const { project } = await brandingApi.updateProjectBoard(projectId, { board_status: to })
      setProjects(ps => ps.map(x => x.id === projectId ? project : x))
    } catch (e) {
      setProjects(prev)
      toast.error(e instanceof Error ? e.message : 'Could not move the project.')
    }
  }

  async function cyclePriority(p: BrandingProject) {
    if (!canEdit) return
    const next = PRIORITY[p.priority].next
    setProjects(ps => ps.map(x => x.id === p.id ? { ...x, priority: next } : x))
    try {
      await brandingApi.updateProjectBoard(p.id, { priority: next })
    } catch {
      void reload()
      toast.error('Could not change priority.')
    }
  }

  function onDragStart(e: DragEvent, id: string) {
    setDragId(id)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', id)
  }
  function onDrop(e: DragEvent, to: BoardStatus) {
    e.preventDefault()
    const id = dragId ?? e.dataTransfer.getData('text/plain')
    setDragId(null); setOverCol(null)
    if (id) void moveTo(id, to)
  }

  // ── Add project ──────────────────────────────────────────────────────────
  const [addOpen, setAddOpen] = useState<BoardStatus | null>(null)

  if (loading && projects.length === 0) {
    return <div className={cx(DS.card, 'p-10 grid place-items-center')}><Spinner /></div>
  }
  if (leads.length === 0) {
    return (
      <div className={DS.card}>
        <EmptyState icon={Users} title="No design leads yet" body="Add a team lead under Team Members and their board will appear here." />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* ── Lead tabs ───────────────────────────────────────────────────── */}
      <div className={cx(DS.card, 'px-2 flex flex-wrap items-center gap-x-1')}>
        <div className="flex items-center gap-1 overflow-x-auto scrollbar-none min-w-0 max-w-full">
        {leads.map(l => {
          const on = l.id === activeLead
          return (
            <button
              key={l.id}
              type="button"
              onClick={() => setActiveLead(l.id)}
              className={cx(
                'flex items-center gap-2 px-4 py-3 text-[13px] font-semibold whitespace-nowrap border-b-[3px] transition-colors cursor-pointer -mb-px',
                on ? 'text-[#111827] border-bp-700' : 'text-[#6B7280] border-transparent hover:text-[#111827]',
              )}
            >
              <span className="w-2 h-2 rounded-full shrink-0" style={{ background: leadColor(l.id) }} />
              {(l.full_name || l.email).split(' ')[0]}
              {l.id === profile?.id && <Badge tone="accent" className="!px-1.5 !py-0.5 !text-[9px]">You</Badge>}
            </button>
          )
        })}
        </div>
        <div className="w-full sm:w-auto sm:ml-auto px-2 sm:px-0 py-2 flex items-center justify-between sm:justify-end gap-3 border-t sm:border-t-0 border-[#C5CAD1]">
          {(isAdmin || canEdit) && (
            <Link to="/branding/members/manage?tab=live" className={cx(DS.link, 'text-[12px]')}>
              Members & live reports <ArrowUpRight className="w-3.5 h-3.5" />
            </Link>
          )}
          {canEdit && (
            <button type="button" onClick={() => setAddOpen('notstarted')} className={cx(DS.btn, DS.btnPrimary, DS.btnSm)}>
              <Plus className="w-3.5 h-3.5 stroke-[2.5]" /> Add project
            </button>
          )}
        </div>
      </div>

      {lead && (
        <>
          {/* ── Lead profile ───────────────────────────────────────────── */}
          <div className={cx(DS.card, DS.cardPad, 'flex items-center gap-4 sm:gap-5 flex-wrap')}>
            {lead.avatar_url ? (
              <Avatar url={lead.avatar_url} name={lead.full_name} email={lead.email} size="lg" />
            ) : (
              <div className="w-13 h-13 w-[52px] h-[52px] rounded-[6px] grid place-items-center text-lg font-semibold text-white shrink-0" style={{ background: leadColor(lead.id) }}>
                {(lead.full_name || lead.email).split(' ').map(s => s[0]).slice(0, 2).join('').toUpperCase()}
              </div>
            )}
            <div className="flex-1 min-w-[200px]">
              <p className="text-base font-semibold text-[#111827] tracking-tight">{lead.full_name || lead.email}</p>
              <p className="text-[13px] font-medium text-[#6B7280] mt-0.5">
                {lead.role === 'sub_admin' ? 'Design Lead' : lead.role === 'task_owner' ? 'Task Owner' : 'Task Manager'}
                {lead.department ? ` · ${lead.department}` : ''} · Branding &amp; Digital Communications
              </p>
            </div>
            <div className="flex gap-4 sm:gap-7">
              {[
                { v: `${fmtH(teamHours)}h`, l: 'This month' },
                { v: stats.active, l: 'Active' },
                { v: stats.delivered, l: 'Delivered' },
                { v: stats.overdue, l: 'Overdue', warn: stats.overdue > 0 },
              ].map(s => (
                <div key={s.l} className="text-center">
                  <p className={cx('text-xl font-semibold tabular-nums leading-none', s.warn ? 'text-rose-600' : 'text-bp-800')}>{s.v}</p>
                  <p className="text-[10px] font-semibold text-[#6B7280] mt-1 uppercase tracking-wider">{s.l}</p>
                </div>
              ))}
            </div>
          </div>

          {/* ── Team chips ─────────────────────────────────────────────── */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className={cx(DS.eyebrow, 'mr-1')}>Team</span>
            <button type="button" onClick={() => setActiveDesigner('all')} className={cx(DS.pill, '!py-1 !text-xs', activeDesigner === 'all' ? DS.pillOn : DS.pillOff)}>All designers</button>
            {team.map(u => (
              <button key={u.id} type="button" onClick={() => setActiveDesigner(u.id)} className={cx(DS.pill, '!py-1 !text-xs', activeDesigner === u.id ? DS.pillOn : DS.pillOff)}>
                {u.full_name || u.email}
              </button>
            ))}
            {team.length === 0 && <span className="text-xs text-[#9CA3AF] font-medium">No designers on this lead's team yet.</span>}
          </div>

          {/* ── Board ──────────────────────────────────────────────────── */}
          <div className="overflow-x-auto -mx-1 px-1 pb-2">
            <div className="flex gap-3 min-w-max items-start">
              {STATUSES.map(st => {
                const cards = visible.filter(p => columnOf(p) === st.id)
                const over = overCol === st.id
                const lit = highlightCol === st.id
                return (
                  <div
                    key={st.id}
                    className={cx(DS.card, 'w-[248px] flex flex-col max-h-[calc(100vh-18rem)] overflow-hidden transition-colors', (over || lit) && 'ring-2 ring-bp-400')}
                    onDragOver={e => { if (!canEdit) return; e.preventDefault(); if (overCol !== st.id) setOverCol(st.id) }}
                    onDragLeave={() => { if (overCol === st.id) setOverCol(null) }}
                    onDrop={e => onDrop(e, st.id)}
                  >
                    <div className={cx('px-3.5 py-3 flex items-center justify-between border-b border-[#C5CAD1]', st.head)}>
                      <span className={cx('text-[11px] font-semibold uppercase tracking-wider', st.title)}>{st.label}</span>
                      <span className={cx('text-[11px] font-semibold px-2 py-0.5 rounded-full tabular-nums', st.count)}>{cards.length}</span>
                    </div>
                    <div className={cx('p-2.5 flex flex-col gap-2 overflow-y-auto flex-1 min-h-[80px]', over && 'bg-bp-50/40')}>
                      {cards.length === 0 && <p className="text-xs text-[#9CA3AF] font-medium text-center py-5">No projects</p>}
                      {cards.map(p => (
                        <ProjectCard
                          key={p.id}
                          p={p}
                          nameById={nameById}
                          draggable={canEdit}
                          dragging={dragId === p.id}
                          onDragStart={e => onDragStart(e, p.id)}
                          onDragEnd={() => { setDragId(null); setOverCol(null) }}
                          onPriority={() => void cyclePriority(p)}
                        />
                      ))}
                      {canEdit && (
                        <button
                          type="button"
                          onClick={() => setAddOpen(st.id)}
                          className="w-full py-2 rounded-[6px] border border-dashed border-[#9CA3AF] text-xs font-semibold text-[#6B7280] hover:border-bp-400 hover:text-bp-700 hover:bg-bp-50/60 transition-colors cursor-pointer"
                        >
                          + Add project
                        </button>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>

        </>
      )}

      {addOpen && lead && (
        <AddProjectModal
          status={addOpen}
          lead={lead}
          team={team}
          categories={categories}
          onClose={() => setAddOpen(null)}
          onCreated={p => { setProjects(ps => [p, ...ps]); setAddOpen(null) }}
        />
      )}
    </div>
  )
}

// ── Card ───────────────────────────────────────────────────────────────────

function ProjectCard({ p, nameById, draggable, dragging, onDragStart, onDragEnd, onPriority }: {
  p: BrandingProject
  nameById: Map<string, string>
  draggable: boolean
  dragging: boolean
  onDragStart: (e: DragEvent) => void
  onDragEnd: () => void
  onPriority: () => void
}) {
  const done = p.assignments.filter(a => a.status === 'completed').length
  const designers = p.assigned_user_ids.map(id => nameById.get(id) ?? 'Unknown')
  return (
    <div
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className={cx(
        'bg-white border border-[#C5CAD1] rounded-[6px] px-3 py-2.5 relative select-none transition-shadow hover:border-bp-300',
        draggable ? 'cursor-grab active:cursor-grabbing active:shadow-lg' : '',
        dragging && 'opacity-50',
      )}
    >
      <button
        type="button"
        onClick={onPriority}
        title={`${PRIORITY[p.priority].label} · click to change`}
        className={cx('absolute top-2.5 right-2.5 w-2 h-2 rounded-full cursor-pointer ring-2 ring-white', PRIORITY[p.priority].dot)}
        aria-label={PRIORITY[p.priority].label}
      />
      <p className="text-[13px] font-semibold text-[#111827] leading-snug pr-4">{p.name}</p>
      {p.type_of_work && (
        <span className={cx('inline-block mt-1.5 text-[10px] font-semibold px-2 py-0.5 rounded-full', catTint(p.type_of_work))}>{p.type_of_work}</span>
      )}
      <p className="mt-1.5 text-[11px] font-medium text-[#6B7280] flex items-center gap-1.5 min-w-0">
        <span className="w-1.5 h-1.5 rounded-full bg-bp-600 shrink-0" />
        <span className="truncate">{designers.length ? designers.join(', ') : 'Unassigned'}</span>
      </p>
      <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
        {deadlineChip(p.deadline)}
        {p.assignments.length > 0 && (
          <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-[#F3F4F6] text-[#6B7280] inline-flex items-center gap-1">
            <Check className="w-3 h-3" />{done}/{p.assignments.length} done
          </span>
        )}
      </div>
    </div>
  )
}

// ── Add project modal ──────────────────────────────────────────────────────

function AddProjectModal({ status, lead, team, categories, onClose, onCreated }: {
  status: BoardStatus
  lead: { id: string; full_name: string; email: string }
  team: { id: string; full_name: string; email: string }[]
  categories: WorkCategory[]
  onClose: () => void
  onCreated: (p: BrandingProject) => void
}) {
  const [name, setName] = useState('')
  const [cat, setCat] = useState('')
  const [sub, setSub] = useState('')
  const [priority, setPriority] = useState<ProjectPriority>('medium')
  const [deadline, setDeadline] = useState('')
  const [designers, setDesigners] = useState<string[]>([])
  const [specific, setSpecific] = useState('')
  const [col, setCol] = useState<BoardStatus>(status)
  const [saving, setSaving] = useState(false)
  const subs = categories.find(c => c.name === cat)?.sub_categories ?? []

  async function submit() {
    if (!name.trim()) { toast.error('Project name is required.'); return }
    if (!cat) { toast.error('Pick a category.'); return }
    setSaving(true)
    try {
      const { project } = await brandingApi.createProject({
        name: name.trim(),
        description: specific.trim(),
        deadline: deadline || undefined,
        assigned_user_ids: designers,
        type_of_work: cat,
        sub_category: sub,
        specific_work: specific.trim(),
        board_status: col,
        priority,
        assigned_lead_id: lead.id,
      })
      toast.success('Project added to the board.')
      onCreated(project)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to create project.')
    } finally { setSaving(false) }
  }

  return (
    <Modal
      title="Add new project"
      subtitle={`On ${lead.full_name || lead.email}'s board`}
      onClose={onClose}
      size="md"
      footer={<>
        <button type="button" onClick={onClose} className={cx(DS.btn, DS.btnSecondary)}>Cancel</button>
        <button type="button" onClick={() => void submit()} disabled={saving} className={cx(DS.btn, DS.btnPrimary)}>
          <ListChecks className="w-4 h-4" /> {saving ? 'Creating…' : 'Create project'}
        </button>
      </>}
    >
      <div className="space-y-4">
        <div>
          <label className={DS.label}>Project name <span className="text-rose-500">*</span></label>
          <input className={DS.input} value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Ahmedabad Admission Brochure" autoFocus />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className={DS.label}>Category <span className="text-rose-500">*</span></label>
            <select className={DS.select} value={cat} onChange={e => { setCat(e.target.value); setSub('') }}>
              <option value="">Select…</option>
              {categories.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
            </select>
          </div>
          <div>
            <label className={DS.label}>Sub-category</label>
            <select className={DS.select} value={sub} onChange={e => setSub(e.target.value)} disabled={!cat}>
              <option value="">{cat ? 'Select…' : 'Pick a category first'}</option>
              {subs.map(s => <option key={s.id} value={s.name}>{s.name}</option>)}
            </select>
          </div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className={DS.label}>Priority</label>
            <Segmented<ProjectPriority> round={false} value={priority} onChange={setPriority}
              options={[{ id: 'high', label: 'High' }, { id: 'medium', label: 'Medium' }, { id: 'low', label: 'Low' }]} />
          </div>
          <div>
            <label className={DS.label}>Deadline</label>
            <input type="date" className={DS.input} value={deadline} onChange={e => setDeadline(e.target.value)} />
          </div>
        </div>
        <div>
          <label className={DS.label}>Column</label>
          <select className={DS.select} value={col} onChange={e => setCol(e.target.value as BoardStatus)}>
            {STATUSES.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </div>
        <div>
          <label className={DS.label}>Designers {designers.length > 0 && <Badge tone="info" className="ml-2">{designers.length} selected</Badge>}</label>
          {team.length === 0 ? (
            <EmptyState compact icon={Inbox} title="No designers on this team" body="The project will be created unassigned." className="border border-dashed border-[#C5CAD1] rounded-[6px]" />
          ) : (
            <div className="border border-[#C5CAD1] rounded-[6px] divide-y divide-[#C5CAD1] max-h-44 overflow-y-auto">
              {team.map(d => {
                const on = designers.includes(d.id)
                return (
                  <label key={d.id} className={cx('flex items-center gap-3 px-3 py-2.5 cursor-pointer transition-colors', on ? 'bg-bp-50/60' : 'hover:bg-[#F9FAFB]')}>
                    <span className={cx('w-[18px] h-[18px] rounded-md grid place-items-center border shrink-0', on ? 'bg-bp-700 border-bp-700 text-white' : 'border-[#9CA3AF] bg-white')}>
                      {on && <Check className="w-3 h-3 stroke-[3]" />}
                    </span>
                    <input type="checkbox" className="sr-only" checked={on} onChange={() => setDesigners(a => on ? a.filter(x => x !== d.id) : [...a, d.id])} />
                    <span className="text-sm font-medium text-[#111827] truncate">{d.full_name || d.email}</span>
                  </label>
                )
              })}
            </div>
          )}
        </div>
        <div>
          <label className={DS.label}>Brief</label>
          <textarea className={DS.textarea} rows={2} value={specific} onChange={e => setSpecific(e.target.value)} placeholder="What needs to be designed" />
        </div>
        <p className={cx(DS.hint, 'flex items-center gap-1.5')}><Flag className="w-3.5 h-3.5 text-bp-600" /> Drag the card between columns to move it along. <Clock className="w-3.5 h-3.5 text-bp-600 ml-1" /> Hours come from submitted daily reports.</p>
      </div>
    </Modal>
  )
}
