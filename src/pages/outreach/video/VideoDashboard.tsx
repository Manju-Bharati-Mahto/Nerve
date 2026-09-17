import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { BarChart3, AlertCircle, Film, Send, CheckCircle2, Clock, Calendar, UserX } from 'lucide-react'
import { getKpis, formatHours, type WorkflowKpis, type CountRow } from '@/lib/outreach-video-data'

/**
 * §20 — the workflow KPI dashboard, for Admin and Manager only (the API
 * enforces that too).
 *
 * Every card here is a plain count or a mean over the two stores, so the
 * numbers reconcile with the lists they link to rather than being a separate
 * reporting pipeline that can drift.
 */
export default function VideoDashboard() {
  const [kpis, setKpis] = useState<WorkflowKpis | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    getKpis().then(setKpis).catch(err =>
      setError(err instanceof Error ? err.message : 'Could not load the dashboard.'))
  }, [])

  if (error) {
    return (
      <div className="hub-card bg-rose-50 border-rose-200 flex items-start gap-2 text-sm text-rose-900">
        <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" /> <span>{error}</span>
      </div>
    )
  }
  if (!kpis) return <div className="hub-card text-center py-12 text-sm text-muted-foreground">Loading…</div>

  return (
    <div className="animate-fade-in space-y-6">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-orange-100 flex items-center justify-center">
          <BarChart3 className="w-5 h-5 text-orange-600" />
        </div>
        <div>
          <h1 className="text-2xl font-serif text-foreground">Workflow Dashboard</h1>
          <p className="text-sm text-muted-foreground">Everything moving through video, at a glance.</p>
        </div>
      </div>

      <section className="space-y-3">
        <h2 className="text-[11px] uppercase tracking-widest text-muted-foreground">Videos</h2>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <Kpi label="Total videos" value={kpis.totalVideos} icon={Film} to="/outreach/video/all" />
          <Kpi label="Draft" value={kpis.draftVideos} icon={Clock} />
          <Kpi label="Submitted" value={kpis.submittedVideos} icon={Send} to="/outreach/video/queue" />
          <Kpi label="Published" value={kpis.publishedVideos} icon={CheckCircle2} to="/outreach/video/published" />
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <Kpi label="Published this week" value={kpis.publishedThisWeek} />
          <Kpi label="Published this month" value={kpis.publishedThisMonth} />
          <Kpi label="Avg. draft → submitted" text={formatHours(kpis.avgDraftToSubmittedHours)} />
          <Kpi label="Avg. submitted → published" text={formatHours(kpis.avgSubmittedToPublishedHours)} />
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-[11px] uppercase tracking-widest text-muted-foreground">Events</h2>
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
          <Kpi label="Total events" value={kpis.totalEvents} icon={Calendar} to="/outreach/video/calendar" />
          <Kpi label="Upcoming" value={kpis.upcomingEvents} />
          <Kpi label="Past" value={kpis.pastEvents} />
          <Kpi label="Unassigned" value={kpis.unassignedEvents} icon={UserX}
            accent={kpis.unassignedEvents > 0} to="/outreach/video/calendar" />
          <Kpi label="Completed" value={kpis.completedEvents} />
        </div>
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <Breakdown title="Videos by editor" rows={kpis.videosByEditor} empty="No videos uploaded yet." />
        <Breakdown title="Videos by client" rows={kpis.videosByClient} empty="No campaigns yet." />
        <Breakdown title="Events by editor" rows={kpis.eventsByEditor} empty="Nothing assigned yet." />
      </div>
    </div>
  )
}

function Kpi({ label, value, text, icon: Icon, to, accent }: {
  label: string; value?: number; text?: string
  icon?: React.ElementType; to?: string; accent?: boolean
}) {
  const body = (
    <>
      <div className="flex items-start justify-between gap-2">
        <div className="text-2xl font-serif text-foreground leading-none">{text ?? value}</div>
        {Icon && <Icon className="w-4 h-4 text-muted-foreground shrink-0" />}
      </div>
      <div className="text-[11px] text-muted-foreground mt-1.5">{label}</div>
    </>
  )
  const cls = `hub-card py-3 ${accent ? 'border-amber-300 bg-amber-50/50' : ''}`
  return to
    ? <Link to={to} className={`${cls} block hover:border-orange-300 transition-colors`}>{body}</Link>
    : <div className={cls}>{body}</div>
}

/** A count breakdown as a share bar — readable without a chart library. */
function Breakdown({ title, rows, empty }: { title: string; rows: CountRow[]; empty: string }) {
  const max = Math.max(1, ...rows.map(r => r.count))
  return (
    <div className="hub-card">
      <h2 className="text-sm font-semibold text-foreground mb-3">{title}</h2>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">{empty}</p>
      ) : (
        <ul className="space-y-2.5">
          {rows.slice(0, 8).map(row => (
            <li key={row.key}>
              <div className="flex items-baseline justify-between gap-3 text-xs">
                <span className="text-foreground truncate">{row.label}</span>
                <span className="text-muted-foreground shrink-0">{row.count}</span>
              </div>
              <div className="mt-1 h-1.5 rounded-full bg-muted overflow-hidden">
                <div className="h-full rounded-full bg-orange-500"
                  style={{ width: `${(row.count / max) * 100}%` }} />
              </div>
            </li>
          ))}
          {rows.length > 8 && (
            <li className="text-[11px] text-muted-foreground">+{rows.length - 8} more</li>
          )}
        </ul>
      )}
    </div>
  )
}
