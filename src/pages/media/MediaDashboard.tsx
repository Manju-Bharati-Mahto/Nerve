/**
 * M2 — Dashboard: the 10-second "what is happening today" view. Stat cards per
 * FR-DS-01 (submitted today, pending reports, running projects, upcoming
 * events, pending deliverables, today's shoots) with click-through, plus a
 * reminders panel. Charts land with the Team & Performance module (Phase 1.5).
 */
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  ClipboardList, ClipboardX, Clapperboard, CalendarDays, ListTodo, Camera, AlertCircle,
} from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'
import { mediaApi } from '@/lib/media-api'
import { MEDIA_CATEGORY_META, type MediaProject, type MediaDailyReport, type MediaMember } from '@/lib/media-types'

const GREEN = '#1a472a'

function dayString(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export default function MediaDashboard() {
  const { profile, role } = useAuth()
  const isLead = role === 'super_admin' || role === 'admin' || role === 'sub_admin'
  const today = dayString(new Date())

  const [projects, setProjects] = useState<MediaProject[]>([])
  const [members, setMembers] = useState<MediaMember[]>([])
  const [reports, setReports] = useState<MediaDailyReport[]>([])
  const [myReport, setMyReport] = useState<MediaDailyReport | null>(null)

  useEffect(() => {
    mediaApi.getProjects().then(r => setProjects(r.projects)).catch(() => {})
    mediaApi.getTeam().then(r => setMembers(r.members)).catch(() => {})
    mediaApi.getMyReport(today).then(r => setMyReport(r.report)).catch(() => {})
    if (isLead) mediaApi.getTeamReports(today).then(r => setReports(r.reports)).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLead])

  const stats = useMemo(() => {
    const submitted = reports.filter(r => r.status !== 'draft').length
    const running = projects.filter(p => p.status === 'running')
    const in14 = new Date(); in14.setDate(in14.getDate() + 14)
    const upcoming = projects.filter(p =>
      p.status === 'upcoming' && p.start_date && p.start_date <= dayString(in14) && p.start_date >= today)
    const pendingDeliverables = projects.flatMap(p => p.deliverables).filter(d => d.status !== 'done').length
    const todaysShoots = projects.filter(p =>
      p.start_date && p.start_date <= today && (p.end_date ?? p.start_date) >= today && p.status !== 'archived')
    const awaiting = reports.filter(r => r.status === 'submitted').length
    const notPosted = projects.flatMap(p => p.social_posts).filter(s => !s.is_posted).length
    return { submitted, running, upcoming, pendingDeliverables, todaysShoots, awaiting, notPosted }
  }, [projects, reports, today])

  const cards = [
    ...(isLead ? [{
      label: 'Submitted Today', value: `${stats.submitted} of ${members.length}`,
      icon: ClipboardList, to: '/media/team-reports', tint: 'bg-emerald-50 text-emerald-600',
    }, {
      label: 'Awaiting Review', value: String(stats.awaiting),
      icon: ClipboardX, to: '/media/team-reports', tint: 'bg-blue-50 text-blue-600',
    }] : [{
      label: 'My Report Today', value: myReport ? (myReport.status === 'draft' ? 'Draft' : myReport.status === 'sent_back' ? 'Sent back' : myReport.status === 'approved' ? 'Approved' : 'Submitted') : 'Not started',
      icon: ClipboardList, to: '/media/report', tint: 'bg-emerald-50 text-emerald-600',
    }]),
    { label: 'Running Projects', value: String(stats.running.length), icon: Clapperboard, to: '/media/projects', tint: 'bg-violet-50 text-violet-600' },
    { label: 'Upcoming (14 days)', value: String(stats.upcoming.length), icon: CalendarDays, to: '/media/projects', tint: 'bg-amber-50 text-amber-600' },
    { label: 'Pending Deliverables', value: String(stats.pendingDeliverables), icon: ListTodo, to: '/media/projects', tint: 'bg-rose-50 text-rose-600' },
    { label: "Today's Shoots", value: String(stats.todaysShoots.length), icon: Camera, to: '/media/projects', tint: 'bg-orange-50 text-orange-600' },
  ]

  return (
    <div className="max-w-5xl mx-auto space-y-5">
      <div>
        <h1 className="text-xl font-extrabold font-serif" style={{ color: GREEN }}>Dashboard</h1>
        <p className="text-sm text-gray-500">Welcome{profile?.full_name ? `, ${profile.full_name}` : ''} — here's today at a glance.</p>
      </div>

      {!myReport && (
        <Link to="/media/report" className="block bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm text-amber-900 hover:bg-amber-100 transition-colors">
          <AlertCircle className="w-4 h-4 inline mr-1.5 -mt-0.5" />
          You haven't filed today's report yet — it takes under two minutes.
        </Link>
      )}

      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        {cards.map(c => {
          const Icon = c.icon
          return (
            <Link key={c.label} to={c.to} className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4 hover:shadow transition-shadow">
              <div className={`w-9 h-9 rounded-xl flex items-center justify-center mb-2 ${c.tint}`}>
                <Icon className="w-5 h-5" />
              </div>
              <p className="text-2xl font-extrabold font-serif leading-none" style={{ color: GREEN }}>{c.value}</p>
              <p className="text-[11px] text-gray-400 mt-1 uppercase tracking-wide font-semibold">{c.label}</p>
            </Link>
          )
        })}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4">
          <h2 className="text-sm font-bold mb-3" style={{ color: GREEN }}>Today's shoots</h2>
          {stats.todaysShoots.length === 0 ? (
            <p className="text-sm text-gray-400 py-6 text-center">No shoots today — enjoy the quiet.</p>
          ) : (
            <div className="space-y-2">
              {stats.todaysShoots.slice(0, 6).map(p => (
                <Link key={p.id} to="/media/projects" className="flex items-center justify-between gap-2 px-3 py-2 rounded-xl hover:bg-gray-50">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-gray-800 truncate">{p.name}</p>
                    <p className="text-[11px] text-gray-400">{p.date_label || p.start_date}{p.city && ` · ${p.city}`}</p>
                  </div>
                  <span className={`text-[10px] px-2 py-0.5 rounded-full font-semibold shrink-0 ${MEDIA_CATEGORY_META[p.category].bg} ${MEDIA_CATEGORY_META[p.category].color}`}>
                    {MEDIA_CATEGORY_META[p.category].short}
                  </span>
                </Link>
              ))}
            </div>
          )}
        </div>

        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4">
          <h2 className="text-sm font-bold mb-3" style={{ color: GREEN }}>Upcoming (next 14 days)</h2>
          {stats.upcoming.length === 0 ? (
            <p className="text-sm text-gray-400 py-6 text-center">Nothing scheduled in the next two weeks.</p>
          ) : (
            <div className="space-y-2">
              {stats.upcoming.slice(0, 6).map(p => (
                <Link key={p.id} to="/media/projects" className="flex items-center justify-between gap-2 px-3 py-2 rounded-xl hover:bg-gray-50">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-gray-800 truncate">{p.name}</p>
                    <p className="text-[11px] text-gray-400">{p.date_label || p.start_date}</p>
                  </div>
                  <span className={`text-[10px] px-2 py-0.5 rounded-full font-semibold shrink-0 ${MEDIA_CATEGORY_META[p.category].bg} ${MEDIA_CATEGORY_META[p.category].color}`}>
                    {MEDIA_CATEGORY_META[p.category].short}
                  </span>
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
