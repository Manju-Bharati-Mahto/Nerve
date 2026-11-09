/**
 * Team Members — one card per lead's team.
 *
 * The head (and each lead) sees every lead as a card: who they are, how big
 * the team is, who is in today, who has filed, and where that team's
 * projects stand on the Kanban board. Every figure is a link to the page
 * that owns it, so the card is a table of contents for the team, not a
 * dead summary:
 *
 *   Avg h · Reports        → Live Reports (today's filings)
 *   Members                → Manage Members
 *   Present                → Leave Calendar (admin) / Live Reports (lead)
 *   Active / Done / Reviews / Awaiting / Changes / Blocked
 *                          → Kanban board, that lead's tab, that column lit
 *
 * Figures come from the same sources those pages read, so the numbers here
 * are the numbers you find when you click through.
 */
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Users, UserPlus, SquareKanban, Radio, Award, CheckCircle2, AlertCircle, Inbox,
  ArrowRight, ShieldCheck, Undo2, Eye,
} from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'
import { useAppData } from '@/hooks/useAppData'
import { brandingApi } from '@/lib/branding-api'
import { timeToHours, MONTHS } from '@/lib/branding-types'
import type { BrandingProject, BrandingLeave, DailyReport, BoardStatus } from '@/lib/branding-types'
import { DS, cx, Avatar, Badge, EmptyState, Spinner, BlockHeader, StatusPill, Meter, Modal } from './ds'

const LEAD_ROLES = new Set(['sub_admin', 'task_owner', 'task_manager'])
const fmtDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const today = () => fmtDate(new Date())

/** Same column rule as the Kanban board, so counts here match what it shows. */
function columnOf(p: BrandingProject): BoardStatus {
  if (p.board_status !== 'notstarted') return p.board_status
  if (p.status === 'completed') return 'delivered'
  if (p.status === 'on_hold') return 'changes'
  if (p.assignments.some(a => a.status === 'completed')) return 'inprogress'
  return 'notstarted'
}

export default function BrandingTeamOverview() {
  const { role } = useAuth()
  const { users } = useAppData()
  const isAdmin = role === 'super_admin' || role === 'admin' || role === 'branding_reports_admin'

  const [projects, setProjects] = useState<BrandingProject[]>([])
  const [todayReports, setTodayReports] = useState<DailyReport[]>([])
  const [monthReports, setMonthReports] = useState<DailyReport[]>([])
  const [leaves, setLeaves] = useState<BrandingLeave[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const now = new Date()
    const t = today()
    Promise.all([
      brandingApi.getProjects().then(r => setProjects(r.projects)),
      brandingApi.getAllReports({ dateFrom: t, dateTo: t, teamScope: true }).then(r => setTodayReports(r.reports)),
      brandingApi.getAllReports({ dateFrom: fmtDate(new Date(now.getFullYear(), now.getMonth(), 1)), dateTo: t, lockedOnly: true, teamScope: true })
        .then(r => setMonthReports(r.reports)),
      brandingApi.getLeaves('approved').then(r => setLeaves(r.leaves)).catch(() => setLeaves([])),
    ]).catch(() => {}).finally(() => setLoading(false))
  }, [])

  const brandingUsers = useMemo(() => users.filter(u => u.team === 'branding'), [users])
  const leads = useMemo(() => brandingUsers.filter(u => LEAD_ROLES.has(u.role)), [brandingUsers])

  const hoursToday = useMemo(() => {
    const m = new Map<string, { hours: number; submitted: boolean }>()
    for (const r of todayReports) {
      const h = (r.rows ?? []).reduce((s, row) => s + timeToHours(row.time_taken), 0)
      m.set(r.user_id, { hours: h, submitted: r.is_locked })
    }
    return m
  }, [todayReports])

  const hoursMonth = useMemo(() => {
    const m = new Map<string, number>()
    for (const r of monthReports) {
      const h = (r.rows ?? []).reduce((s, row) => s + timeToHours(row.time_taken), 0)
      m.set(r.user_id, (m.get(r.user_id) ?? 0) + h)
    }
    return m
  }, [monthReports])

  const onLeaveToday = useMemo(() => {
    const t = today()
    return new Set(leaves.filter(l => l.leave_date === t && !l.is_half_day).map(l => l.user_id))
  }, [leaves])

  const todayMs = new Date().setHours(0, 0, 0, 0)
  const t = today()

  const cards = useMemo(() => leads.map(lead => {
    const managed = new Set(brandingUsers.filter(u => u.managed_by === lead.id).map(u => u.id))
    const leadProjects = projects.filter(p =>
      p.assigned_lead_id === lead.id || p.created_by === lead.id || p.assigned_user_ids.some(id => managed.has(id)))
    const teamIds = new Set<string>(managed)
    leadProjects.forEach(p => p.assigned_user_ids.forEach(id => { if (id !== lead.id) teamIds.add(id) }))
    teamIds.delete(lead.id)
    const team = brandingUsers.filter(u => teamIds.has(u.id))

    const submitted = team.filter(u => hoursToday.get(u.id)?.submitted).length
    const hrsToday = team.reduce((s, u) => s + (hoursToday.get(u.id)?.hours ?? 0), 0)
    const avgToday = team.length ? hrsToday / team.length : 0
    const present = team.filter(u => !onLeaveToday.has(u.id)).length
    const avgMonth = team.length ? team.reduce((s, u) => s + (hoursMonth.get(u.id) ?? 0), 0) / team.length : 0

    const col = (c: BoardStatus) => leadProjects.filter(p => columnOf(p) === c).length
    const doneToday = leadProjects.filter(p => p.assignments.some(a => a.completed_at && a.completed_at.slice(0, 10) === t)).length
    const awaiting = leadProjects.filter(p => {
      const c = columnOf(p)
      return p.assignments.length > 0 && p.assignments.every(a => a.status === 'completed') && c !== 'delivered' && c !== 'approved'
    }).length
    const blocked = leadProjects.filter(p => p.deadline && new Date(p.deadline).getTime() < todayMs && columnOf(p) !== 'delivered').length
    const open = leadProjects.filter(p => columnOf(p) !== 'delivered').length

    return {
      lead, team, open, total: leadProjects.length,
      avgToday, submitted, present, avgMonth,
      notstarted: col('notstarted'), active: col('inprogress'), doneToday, reviews: col('review'),
      approved: col('approved'), delivered: col('delivered'), awaiting, changes: col('changes'), blocked,
    }
  }), [leads, brandingUsers, projects, hoursToday, hoursMonth, onLeaveToday, todayMs, t])

  const unassigned = useMemo(() => brandingUsers.filter(u =>
    !LEAD_ROLES.has(u.role) && u.role === 'user' && !u.managed_by), [brandingUsers])

  const fmtH = (h: number) => (Math.round(h * 10) / 10).toFixed(1)
  const [selected, setSelected] = useState<string | null>(null)
  const detail = selected ? cards.find(c => c.lead.id === selected) ?? null : null
  const manageFor = (leadId: string, tab?: 'live' | 'projects') =>
    `/branding/members/manage?lead=${leadId}${tab ? `&tab=${tab}` : ''}`

  if (loading && projects.length === 0) {
    return <div className={cx(DS.card, 'p-10 grid place-items-center')}><Spinner /></div>
  }

  return (
    <div className="space-y-4">
      <BlockHeader
        title="Teams"
        subtitle={`${leads.length} lead${leads.length === 1 ? '' : 's'} · ${brandingUsers.length} people · ${MONTHS[new Date().getMonth()]} ${new Date().getFullYear()}`}
        action={<>
          <Link to="/branding/team" className={cx(DS.btn, DS.btnSecondary, DS.btnSm)}><SquareKanban className="w-4 h-4" /> Kanban board</Link>
          <Link to="/branding/members/manage" className={cx(DS.btn, DS.btnPrimary, DS.btnSm)}><UserPlus className="w-4 h-4" /> Manage members</Link>
        </>}
      />

      {cards.length === 0 ? (
        <div className={DS.card}>
          <EmptyState icon={Users} title="No team leads yet" body="Make someone a lead under Manage Members and their team card will appear here."
            action={<Link to="/branding/members/manage" className={cx(DS.btn, DS.btnPrimary)}>Manage members</Link>} />
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {cards.map(c => {
            const urgent = c.awaiting + c.changes + c.blocked
            const filedAll = c.team.length > 0 && c.submitted === c.team.length
            return (
              <button
                key={c.lead.id}
                type="button"
                onClick={() => setSelected(c.lead.id)}
                className={cx(DS.card, 'text-left p-4 flex flex-col gap-4 hover:border-bp-700 hover:shadow-sm transition-all cursor-pointer group')}
              >
                {/* Lead */}
                <div className="flex items-center gap-3">
                  <div className="relative shrink-0">
                    <Avatar url={c.lead.avatar_url} name={c.lead.full_name} email={c.lead.email} size="lg" className="!rounded-[6px]" />
                    <span className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full bg-emerald-500 ring-2 ring-white" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-[15px] font-semibold text-[#111827] tracking-tight truncate group-hover:text-bp-700 transition-colors">{c.lead.full_name || c.lead.email}</p>
                    <p className="text-[13px] font-medium text-[#6B7280] truncate">{c.lead.department || 'Design Lead'}</p>
                  </div>
                  {c.open > 0
                    ? <StatusPill tone={urgent > 0 ? 'danger' : 'warning'} className="shrink-0"><span className={cx('w-1.5 h-1.5 rounded-full mr-1.5', urgent > 0 ? 'bg-rose-500' : 'bg-amber-500')} />{c.open} open</StatusPill>
                    : <StatusPill tone="success" className="shrink-0"><CheckCircle2 className="w-3 h-3 mr-1" /> All clear</StatusPill>}
                </div>

                {/* Team strip */}
                <div className="flex items-center gap-3">
                  <div className="flex -space-x-2 shrink-0">
                    {c.team.slice(0, 5).map(u => (
                      <span key={u.id} className="relative">
                        <Avatar url={u.avatar_url} name={u.full_name} email={u.email} size="sm" className="!rounded-full ring-2 ring-white" />
                        <span className={cx('absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full ring-2 ring-white',
                          hoursToday.get(u.id)?.submitted ? 'bg-emerald-500' : onLeaveToday.has(u.id) ? 'bg-[#D1D5DB]' : 'bg-amber-400')} />
                      </span>
                    ))}
                    {c.team.length > 5 && <span className="w-8 h-8 rounded-full bg-[#F3F4F6] ring-2 ring-white grid place-items-center text-[10px] font-semibold text-[#6B7280]">+{c.team.length - 5}</span>}
                    {c.team.length === 0 && <span className="text-xs font-medium text-[#9CA3AF]">No members yet</span>}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] font-semibold text-[#111827] tabular-nums truncate">{c.team.length} member{c.team.length === 1 ? '' : 's'}</p>
                    <p className={cx('text-[12px] font-semibold truncate', filedAll ? 'text-emerald-700' : 'text-[#6B7280]')}>{c.submitted}/{c.team.length} filed today</p>
                  </div>
                </div>

                {/* One-line status */}
                <div className="flex items-center justify-between gap-3 pt-3 border-t border-[#C5CAD1]">
                  <div className="flex items-center gap-2 min-w-0">
                    {urgent > 0 ? (
                      <span className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-rose-700 truncate"><AlertCircle className="w-3.5 h-3.5 shrink-0" /> {urgent} need{urgent === 1 ? 's' : ''} attention</span>
                    ) : c.reviews > 0 ? (
                      <span className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-bp-700 truncate"><Eye className="w-3.5 h-3.5 shrink-0" /> {c.reviews} in review</span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-emerald-700 truncate"><CheckCircle2 className="w-3.5 h-3.5 shrink-0" /> On track</span>
                    )}
                    <span className="text-[12px] font-medium text-[#9CA3AF] shrink-0">· {c.active} active</span>
                  </div>
                  <span className={cx(DS.link, 'text-[12px] shrink-0')}>Details <ArrowRight className="w-3 h-3" /></span>
                </div>
              </button>
            )
          })}
        </div>
      )}

      {detail && (
        <Modal
          size="lg"
          onClose={() => setSelected(null)}
          title={detail.lead.full_name || detail.lead.email}
          subtitle={`${detail.lead.department || 'Design Lead'} · ${detail.team.length} member${detail.team.length === 1 ? '' : 's'}`}
          footer={<>
            <Link to={manageFor(detail.lead.id)} className={cx(DS.btn, DS.btnSecondary)}><Users className="w-4 h-4" /> Members</Link>
            <Link to={manageFor(detail.lead.id, 'live')} className={cx(DS.btn, DS.btnSecondary)}><Radio className="w-4 h-4" /> Live reports</Link>
            {isAdmin && <Link to="/branding/kra" className={cx(DS.btn, DS.btnSecondary)}><Award className="w-4 h-4" /> KRA</Link>}
            <Link to={`/branding/team?lead=${detail.lead.id}`} className={cx(DS.btn, DS.btnPrimary)}><SquareKanban className="w-4 h-4" /> Open Kanban board</Link>
          </>}
        >
          <TeamDetail c={detail} hoursToday={hoursToday} onLeaveToday={onLeaveToday} isAdmin={isAdmin} fmtH={fmtH} manageFor={manageFor} />
        </Modal>
      )}

      {unassigned.length > 0 && (
        <div className={cx(DS.card, DS.cardPad)}>
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-[6px] bg-amber-50 text-amber-700 grid place-items-center shrink-0"><AlertCircle className="w-5 h-5" /></div>
              <div>
                <p className="text-[15px] font-semibold text-[#111827] tracking-tight">Not on any team</p>
                <p className="text-[13px] font-medium text-[#6B7280] mt-0.5">{unassigned.length} member{unassigned.length === 1 ? '' : 's'} without a lead. Their work will not show on a board until a lead is assigned.</p>
              </div>
            </div>
            <Link to="/branding/members/manage" className={cx(DS.btn, DS.btnSecondary, DS.btnSm)}>Assign leads</Link>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {unassigned.map(u => (
              <span key={u.id} className="inline-flex items-center gap-2 pl-1 pr-3 py-1 rounded-full bg-[#F9FAFB] border border-[#C5CAD1] text-xs font-semibold text-[#374151]">
                <Avatar url={u.avatar_url} name={u.full_name} email={u.email} size="xs" className="!rounded-full" />
                {u.full_name || u.email}
              </span>
            ))}
          </div>
        </div>
      )}

      {cards.length > 0 && cards.every(c => c.team.length === 0) && (
        <div className={DS.card}>
          <EmptyState compact icon={Inbox} title="Teams are empty" body="Set each member's lead under Manage Members and the figures will fill in." />
        </div>
      )}
      <p className="text-[11px] font-medium text-[#9CA3AF]">
        <Badge tone="neutral" className="mr-1.5">How to read</Badge>
        Member dots: green has filed today, amber has not, grey is on leave. The bar is the team's board by stage; tap any part to open it.
      </p>
    </div>
  )
}

type TeamCard = {
  lead: { id: string; full_name: string; email: string; department: string; avatar_url?: string | null }
  team: { id: string; full_name: string; email: string; avatar_url?: string | null }[]
  open: number; total: number
  avgToday: number; submitted: number; present: number; avgMonth: number
  notstarted: number; active: number; doneToday: number; reviews: number; approved: number; delivered: number
  awaiting: number; changes: number; blocked: number
}

/** Everything about one team, shown when its card is opened. */
function TeamDetail({ c, hoursToday, onLeaveToday, isAdmin, fmtH, manageFor }: {
  c: TeamCard
  hoursToday: Map<string, { hours: number; submitted: boolean }>
  onLeaveToday: Set<string>
  isAdmin: boolean
  fmtH: (h: number) => string
  manageFor: (leadId: string, tab?: 'live' | 'projects') => string
}) {
  const kanban = (col?: BoardStatus) => `/branding/team?lead=${c.lead.id}${col ? `&col=${col}` : ''}`
  const liveTo = manageFor(c.lead.id, 'live')
  const presentTo = isAdmin ? '/branding/leave-calendar' : liveTo
  const attention = [
    c.awaiting > 0 && { n: c.awaiting, label: 'awaiting your approval', tone: 'warning' as const, to: kanban('inprogress'), icon: ShieldCheck },
    c.changes > 0 && { n: c.changes, label: 'changes requested', tone: 'danger' as const, to: kanban('changes'), icon: Undo2 },
    c.blocked > 0 && { n: c.blocked, label: 'past deadline', tone: 'danger' as const, to: kanban(), icon: AlertCircle },
    c.reviews > 0 && { n: c.reviews, label: 'in review', tone: 'info' as const, to: kanban('review'), icon: Eye },
  ].filter(Boolean) as { n: number; label: string; tone: 'warning' | 'danger' | 'info'; to: string; icon: React.ElementType }[]
  const segments: { key: BoardStatus; n: number; cls: string; label: string }[] = [
    { key: 'notstarted', n: c.notstarted, cls: 'bg-[#D1D5DB]',   label: 'Not started' },
    { key: 'inprogress', n: c.active,     cls: 'bg-bp-600',      label: 'In progress' },
    { key: 'review',     n: c.reviews,    cls: 'bg-amber-400',   label: 'In review' },
    { key: 'changes',    n: c.changes,    cls: 'bg-rose-500',    label: 'Changes' },
    { key: 'approved',   n: c.approved,   cls: 'bg-violet-500',  label: 'Approved' },
    { key: 'delivered',  n: c.delivered,  cls: 'bg-emerald-500', label: 'Delivered' },
  ]
  const filedPct = c.team.length ? Math.round((c.submitted / c.team.length) * 100) : 0

  return (
    <div className="space-y-4">
      {/* Needs attention */}
      <div className={cx(DS.card, 'p-4 bg-[#F9FAFB]')}>
        <p className={cx(DS.eyebrow, 'mb-2')}>Needs attention</p>
        <div className="flex items-center gap-2 flex-wrap">
          {attention.length === 0 ? (
            <span className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-emerald-700"><CheckCircle2 className="w-4 h-4" /> Nothing waiting on you</span>
          ) : attention.map(a => (
            <Link key={a.label} to={a.to} className={cx(
              'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12px] font-semibold border transition-colors',
              a.tone === 'danger' ? 'bg-rose-50 border-rose-200 text-rose-700 hover:border-rose-400'
                : a.tone === 'warning' ? 'bg-amber-50 border-amber-200 text-amber-700 hover:border-amber-400'
                : 'bg-bp-50 border-bp-200 text-bp-700 hover:border-bp-400',
            )}>
              <a.icon className="w-3.5 h-3.5" /> {a.n} {a.label}
            </Link>
          ))}
        </div>
      </div>

      {/* Team today */}
      <div className={cx(DS.card, 'p-4')}>
        <div className="flex items-center justify-between gap-3 mb-3">
          <p className={DS.eyebrow}>Team today</p>
          <Link to={liveTo} className={cx(DS.link, 'text-[12px]')}>Live reports <ArrowRight className="w-3 h-3" /></Link>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-4 items-center">
          <div className="min-w-0">
            <div className="flex flex-wrap gap-2 mb-3">
              {c.team.map(u => (
                <Link key={u.id} to={manageFor(c.lead.id)} className="inline-flex items-center gap-2 pl-1 pr-2.5 py-1 rounded-full bg-[#F9FAFB] border border-[#C5CAD1] text-xs font-semibold text-[#374151] hover:border-bp-400 transition-colors" title={hoursToday.get(u.id)?.submitted ? 'Filed today' : onLeaveToday.has(u.id) ? 'On leave' : 'Not filed yet'}>
                  <span className="relative">
                    <Avatar url={u.avatar_url} name={u.full_name} email={u.email} size="xs" className="!rounded-full" />
                    <span className={cx('absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full ring-1 ring-white',
                      hoursToday.get(u.id)?.submitted ? 'bg-emerald-500' : onLeaveToday.has(u.id) ? 'bg-[#D1D5DB]' : 'bg-amber-400')} />
                  </span>
                  {u.full_name || u.email}
                </Link>
              ))}
              {c.team.length === 0 && <span className="text-xs font-medium text-[#9CA3AF]">No members yet</span>}
            </div>
            <p className="text-sm font-semibold text-[#111827] tabular-nums">
              {c.team.length} member{c.team.length === 1 ? '' : 's'}
              <span className="font-medium text-[#9CA3AF]"> · </span>
              <Link to={presentTo} className={cx('hover:underline', c.present < c.team.length ? 'text-amber-700' : 'text-[#111827]')}>{c.present} present</Link>
            </p>
            <Link to={liveTo} className="block mt-1.5">
              <Meter value={c.submitted} max={Math.max(c.team.length, 1)} tone={c.team.length > 0 && c.submitted === c.team.length ? 'success' : 'warning'}
                label={`${c.submitted} of ${c.team.length} filed today · ${filedPct}%`} />
            </Link>
          </div>
          <div className="flex sm:flex-col gap-4 sm:gap-2 sm:text-right sm:border-l sm:border-[#C5CAD1] sm:pl-4">
            <Link to={liveTo} className="group">
              <p className="text-[22px] font-semibold text-[#111827] tabular-nums leading-none group-hover:text-bp-700">{fmtH(c.avgToday)}<span className="text-sm font-semibold text-[#9CA3AF] ml-0.5">h</span></p>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-[#9CA3AF] mt-1">avg today</p>
            </Link>
            <Link to="/branding/dashboard" className="group">
              <p className="text-[15px] font-semibold text-[#374151] tabular-nums leading-none group-hover:text-bp-700">{fmtH(c.avgMonth)}<span className="text-xs font-semibold text-[#9CA3AF] ml-0.5">h</span></p>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-[#9CA3AF] mt-1">avg month</p>
            </Link>
          </div>
        </div>
      </div>

      {/* Board */}
      <div className={cx(DS.card, 'p-4')}>
        <div className="flex items-center justify-between gap-3 mb-3">
          <p className={DS.eyebrow}>Board · {c.total} project{c.total === 1 ? '' : 's'}</p>
          <Link to={kanban()} className={cx(DS.link, 'text-[12px]')}>Open board <ArrowRight className="w-3 h-3" /></Link>
        </div>
        {c.total === 0 ? (
          <p className="text-xs font-medium text-[#9CA3AF]">No projects on this board yet.</p>
        ) : (
          <>
            <div className="flex h-2.5 rounded-full overflow-hidden bg-[#F3F4F6] gap-px">
              {segments.filter(sg => sg.n > 0).map(sg => (
                <Link key={sg.key} to={kanban(sg.key)} title={`${sg.n} ${sg.label.toLowerCase()}`} className={cx('h-full hover:opacity-80', sg.cls)} style={{ width: `${(sg.n / c.total) * 100}%` }} />
              ))}
            </div>
            <div className="mt-3 grid grid-cols-2 sm:grid-cols-3 gap-2">
              {segments.map(sg => (
                <Link key={sg.key} to={kanban(sg.key)} className={cx('flex items-center gap-2 rounded-[6px] border px-3 py-2 transition-colors', sg.n > 0 ? 'border-[#C5CAD1] hover:border-bp-400 bg-white' : 'border-[#C5CAD1] bg-[#F9FAFB]')}>
                  <span className={cx('w-2 h-2 rounded-full shrink-0', sg.n > 0 ? sg.cls : 'bg-[#E5E7EB]')} />
                  <span className={cx('text-sm font-semibold tabular-nums', sg.n > 0 ? 'text-[#111827]' : 'text-[#9CA3AF]')}>{sg.n}</span>
                  <span className={cx('text-[12px] font-semibold truncate', sg.n > 0 ? 'text-[#6B7280]' : 'text-[#9CA3AF]')}>{sg.label}</span>
                </Link>
              ))}
            </div>
            {c.doneToday > 0 && (
              <p className="mt-3 inline-flex items-center gap-1.5 text-[12px] font-semibold text-emerald-700"><CheckCircle2 className="w-3.5 h-3.5" /> {c.doneToday} done today</p>
            )}
          </>
        )}
      </div>
    </div>
  )
}
