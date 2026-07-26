/**
 * Home — role-adaptive dashboard (FR-1.1/1.2/1.3/1.4/1.7/1.9).
 * Employees see their own scope; leads/admin see the department. The scoping
 * happens server-side; this page renders whatever it is given.
 */
import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ClipboardList, FolderKanban, AlertTriangle, CalendarDays, Plus, RefreshCw } from 'lucide-react'
import { mediaApi } from '@/lib/media-api'
import { useMedia } from './MediaShell'
import {
  MEDIA_GREEN, PROJECT_STATUS_META, REPORT_STATUS_META, fmtMinutes,
  type MediaDashboard,
} from '@/lib/media-types'

export default function MediaHome() {
  const { mediaRole } = useMedia()
  const navigate = useNavigate()
  const [dash, setDash] = useState<MediaDashboard | null>(null)
  const [loading, setLoading] = useState(true)

  const load = () => {
    setLoading(true)
    mediaApi.dashboard().then(r => setDash(r.dashboard)).finally(() => setLoading(false))
  }
  useEffect(load, [])

  if (!dash) {
    return <div className="space-y-4">{[1, 2, 3].map(i => <div key={i} className="bg-white rounded-2xl border border-gray-100 h-28 animate-pulse" />)}</div>
  }

  const overdue = dash.deliverablesDueSoon.filter(d => d.overdue)
  const isLead = mediaRole !== 'employee'

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-lg font-extrabold font-serif" style={{ color: MEDIA_GREEN }}>
            {new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })}
          </h1>
          <p className="text-xs text-gray-500">{isLead ? 'Department overview' : 'Your production overview'}</p>
        </div>
        {/* FR-1.9 quick actions */}
        <div className="flex items-center gap-2">
          <button onClick={() => navigate('/media/my-day')}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-[13px] font-semibold text-white hover:opacity-90" style={{ background: MEDIA_GREEN }}>
            <Plus className="w-4 h-4" /> Log Task
          </button>
          <button onClick={() => navigate('/media/projects?new=1')}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-[13px] font-semibold border border-gray-200 text-gray-600 hover:bg-gray-50">
            <FolderKanban className="w-4 h-4" /> New Project
          </button>
          <button onClick={load} title="Refresh" className="p-1.5 rounded-xl border border-gray-200 text-gray-500 hover:bg-gray-50">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* FR-1.1 stat strip */}
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
        <Stat label={isLead ? 'Reports pending today' : 'Report status'}
          value={isLead ? `${dash.pendingReports.length}/${dash.teamSize}` : (dash.pendingReports.length === 0 ? 'Submitted' : 'Pending')}
          accent={dash.pendingReports.length > 0 ? '#b45309' : MEDIA_GREEN} icon={ClipboardList} />
        <Stat label="Deliverables due (14d)" value={String(dash.deliverablesDueSoon.length)}
          sub={overdue.length > 0 ? `${overdue.length} overdue` : undefined} accent={overdue.length ? '#b91c1c' : MEDIA_GREEN} icon={CalendarDays} />
        <Stat label="Running projects" value={String(dash.runningProjects.length)} accent={MEDIA_GREEN} icon={FolderKanban} />
        {isLead
          ? <Stat label="Review queue" value={String(dash.reviewQueueCount)} accent={dash.reviewQueueCount ? '#9d174d' : MEDIA_GREEN} icon={AlertTriangle} />
          : <Stat label="Due this week (mine)" value={String(dash.deliverablesDueSoon.filter(d => !d.overdue).length)} accent={MEDIA_GREEN} icon={CalendarDays} />}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Needs attention (W1) */}
        <div className="lg:col-span-2 space-y-4">
          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4">
            <h2 className="text-sm font-bold mb-3" style={{ color: MEDIA_GREEN }}>Needs attention</h2>
            {overdue.length === 0 && dash.reviewQueue.length === 0 ? (
              <p className="text-sm text-gray-400 py-6 text-center">All clear — nothing overdue or waiting on review.</p>
            ) : (
              <div className="space-y-2">
                {overdue.map(d => (
                  <Link key={d.id} to={`/media/projects/${d.project_id}`}
                    className="flex items-center justify-between gap-3 px-3 py-2 rounded-xl bg-rose-50 hover:bg-rose-100 transition-colors">
                    <div className="min-w-0">
                      <p className="text-xs font-semibold text-gray-800 truncate">{d.title} <span className="text-gray-400 font-normal">· {d.project_code}</span></p>
                      <p className="text-[11px] text-rose-700">Overdue since {d.due_date}{d.owner_name ? ` · ${d.owner_name}` : ' · unowned'}</p>
                    </div>
                    <span className="text-[10px] font-bold text-rose-700 uppercase shrink-0">Overdue</span>
                  </Link>
                ))}
                {isLead && dash.reviewQueue.map(r => (
                  <Link key={r.id} to="/media/reports"
                    className="flex items-center justify-between gap-3 px-3 py-2 rounded-xl bg-amber-50 hover:bg-amber-100 transition-colors">
                    <div className="min-w-0">
                      <p className="text-xs font-semibold text-gray-800 truncate">{r.user_name} · {r.report_date}</p>
                      <p className="text-[11px] text-amber-800 truncate">{r.flagged_reason || 'Awaiting review'}</p>
                    </div>
                    <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded-full shrink-0"
                      style={{ background: REPORT_STATUS_META[r.status].bg, color: REPORT_STATUS_META[r.status].fg }}>
                      {REPORT_STATUS_META[r.status].label}
                    </span>
                  </Link>
                ))}
              </div>
            )}
          </div>

          {/* FR-1.3 running projects */}
          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-bold" style={{ color: MEDIA_GREEN }}>Running projects</h2>
              <Link to="/media/projects" className="text-xs font-semibold hover:underline" style={{ color: MEDIA_GREEN }}>View all</Link>
            </div>
            {dash.runningProjects.length === 0 ? (
              <p className="text-sm text-gray-400 py-6 text-center">No running projects.</p>
            ) : (
              <div className="divide-y divide-gray-50">
                {dash.runningProjects.map(p => (
                  <Link key={p.id} to={`/media/projects/${p.id}`} className="flex items-center gap-3 py-2 hover:bg-gray-50 rounded-lg px-2 -mx-2">
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-semibold text-gray-800 truncate">{p.name} <span className="text-gray-400 font-normal">· {p.code}</span></p>
                      <div className="flex items-center gap-2 mt-1">
                        <div className="h-1.5 w-32 rounded-full bg-gray-100 overflow-hidden">
                          <div className="h-full rounded-full" style={{ width: `${p.progress ?? 0}%`, background: MEDIA_GREEN }} />
                        </div>
                        <span className="text-[10px] text-gray-400 font-mono">{p.progress ?? 0}%</span>
                        {p.logged_minutes ? <span className="text-[10px] text-gray-400">· {fmtMinutes(p.logged_minutes)} logged</span> : null}
                      </div>
                    </div>
                    <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded-full shrink-0"
                      style={{ background: PROJECT_STATUS_META[p.status].bg, color: PROJECT_STATUS_META[p.status].fg }}>
                      {PROJECT_STATUS_META[p.status].label}
                    </span>
                    {p.end_date && <span className="text-[10px] text-gray-400 shrink-0">{p.end_date}</span>}
                  </Link>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Right column */}
        <div className="space-y-4">
          {isLead && (
            <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4">
              <h2 className="text-sm font-bold mb-3" style={{ color: MEDIA_GREEN }}>Reports pending today <span className="text-gray-400 font-normal">({dash.pendingReports.length})</span></h2>
              {dash.pendingReports.length === 0 ? (
                <p className="text-sm text-gray-400 py-4 text-center">Everyone has submitted. 🎉</p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {dash.pendingReports.map(u => (
                    <span key={u.id} className="text-[11px] px-2 py-1 rounded-full bg-amber-50 text-amber-800 font-medium">{u.full_name}</span>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* FR-1.4 upcoming deadlines */}
          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4">
            <h2 className="text-sm font-bold mb-3" style={{ color: MEDIA_GREEN }}>Upcoming deadlines</h2>
            {dash.deliverablesDueSoon.filter(d => !d.overdue).length === 0 ? (
              <p className="text-sm text-gray-400 py-4 text-center">Nothing due in the next 14 days.</p>
            ) : (
              <div className="space-y-1.5">
                {dash.deliverablesDueSoon.filter(d => !d.overdue).slice(0, 8).map(d => (
                  <Link key={d.id} to={`/media/projects/${d.project_id}`} className="block px-2 py-1.5 rounded-lg hover:bg-gray-50">
                    <p className="text-xs font-semibold text-gray-800 truncate">{d.title}</p>
                    <p className="text-[11px] text-gray-400">{d.project_code} · due {d.due_date}{d.owner_name ? ` · ${d.owner_name}` : ''}</p>
                  </Link>
                ))}
              </div>
            )}
          </div>

          {/* FR-1.10 recent activity */}
          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4">
            <h2 className="text-sm font-bold mb-3" style={{ color: MEDIA_GREEN }}>Recent activity</h2>
            {dash.recentActivity.length === 0 ? (
              <p className="text-sm text-gray-400 py-4 text-center">No activity yet.</p>
            ) : (
              <div className="space-y-2">
                {dash.recentActivity.slice(0, 10).map((a, i) => (
                  <p key={i} className="text-[11px] text-gray-500">
                    <span className="font-semibold text-gray-700">{a.actor_name || 'System'}</span>{' '}
                    {a.action.replace(/\./g, ' ').replace(/_/g, ' ')}
                    {a.project_name ? <span className="text-gray-400"> · {a.project_name}</span> : null}
                  </p>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function Stat({ label, value, sub, accent, icon: Icon }: {
  label: string; value: string; sub?: string; accent: string; icon: React.ElementType
}) {
  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-3.5 flex items-center gap-3">
      <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0" style={{ background: `${accent}18` }}>
        <Icon className="w-4 h-4" style={{ color: accent }} />
      </div>
      <div className="min-w-0">
        <p className="text-lg font-extrabold leading-none tabular-nums" style={{ color: accent }}>{value}</p>
        <p className="text-[11px] text-gray-500 mt-1">{label}{sub ? <span className="text-rose-600 font-semibold"> · {sub}</span> : null}</p>
      </div>
    </div>
  )
}
