import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, MapPin, Link as LinkIcon, ExternalLink, CheckCircle2 } from 'lucide-react'
import {
  useOutreachData, computeOutreachAlerts, outreachStates,
  type Campaign,
} from '@/lib/outreach-data'
import AddLivePostsDialog from './AddLivePostsDialog'

function fmtOverdue(hours: number): string {
  if (hours < 24) return `${hours}h overdue`
  const d = Math.floor(hours / 24)
  const h = hours % 24
  return h ? `${d}d ${h}h overdue` : `${d}d overdue`
}

export default function OutreachAlerts() {
  const { campaigns, pages, creators, posts } = useOutreachData()
  const [stateFilter, setStateFilter] = useState('')
  const [resolveFor, setResolveFor] = useState<Campaign | null>(null)

  const states = useMemo(() => outreachStates(pages, campaigns), [pages, campaigns])
  const campaignById = useMemo(() => new Map(campaigns.map(c => [c.id, c])), [campaigns])

  const alerts = useMemo(() => {
    const all = computeOutreachAlerts(campaigns, pages, creators, posts)
    if (!stateFilter) return all
    return all.filter(a => campaignById.get(a.campaignId)?.state === stateFilter)
  }, [campaigns, pages, creators, posts, stateFilter, campaignById])

  return (
    <div className="animate-fade-in space-y-5">

      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-rose-100 flex items-center justify-center">
            <AlertTriangle className="w-5 h-5 text-rose-600" />
          </div>
          <div>
            <h1 className="text-2xl font-serif text-foreground">Alerts</h1>
            <p className="text-sm text-muted-foreground">
              Pages assigned to a campaign that haven't published within 24 hours of its start date.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {states.length > 0 && (
            <div className="relative">
              <MapPin className="w-3.5 h-3.5 text-muted-foreground absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <select value={stateFilter} onChange={e => setStateFilter(e.target.value)}
                className="hub-input py-1.5 pl-7 text-xs w-40">
                <option value="">All states</option>
                {states.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
          )}
          <span className={`hub-badge ${alerts.length ? 'bg-rose-100 text-rose-700' : 'bg-emerald-100 text-emerald-700'}`}>
            {alerts.length} pending
          </span>
        </div>
      </div>

      {alerts.length === 0 ? (
        <div className="hub-card text-center py-16">
          <div className="w-12 h-12 rounded-xl bg-emerald-50 mx-auto flex items-center justify-center mb-3">
            <CheckCircle2 className="w-6 h-6 text-emerald-600" />
          </div>
          <p className="text-sm font-medium text-foreground">All clear.</p>
          <p className="text-xs text-muted-foreground mt-1">Every assigned page has published its post on time.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {alerts.map(a => {
            const campaign = campaignById.get(a.campaignId)
            const detailLink = a.subjectKind === 'page' ? `/outreach/pages/${a.subjectId}` : `/outreach/creators/${a.subjectId}`
            return (
              <div key={a.id} className="hub-card border-l-4 border-l-rose-500 flex items-start gap-3 py-3">
                <div className="w-9 h-9 rounded-lg bg-rose-100 flex items-center justify-center shrink-0">
                  <AlertTriangle className="w-4 h-4 text-rose-600" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-foreground">
                    <Link to={detailLink} className="font-semibold hover:underline">@{a.handle}</Link>
                    {' '}has not published for{' '}
                    <Link to={`/outreach/campaigns/${a.campaignId}`} className="font-semibold hover:underline">{a.campaignName}</Link>
                  </p>
                  <p className="text-[11px] text-muted-foreground mt-0.5">
                    <span className="uppercase tracking-wide">{a.subjectKind}</span>
                    {campaign?.startDate && <> · started {campaign.startDate}</>}
                    {campaign?.state && <> · {campaign.state}</>}
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="hub-badge bg-rose-100 text-rose-700 whitespace-nowrap">{fmtOverdue(a.hoursOverdue)}</span>
                  {campaign && a.subjectKind === 'page' && (
                    <button onClick={() => setResolveFor(campaign)}
                      title="Add the published post link to resolve this alert"
                      className="text-xs px-2.5 py-1.5 rounded-lg bg-orange-100 text-orange-700 hover:opacity-80 inline-flex items-center gap-1">
                      <LinkIcon className="w-3 h-3" /> Add post
                    </button>
                  )}
                  <Link to={detailLink}
                    className="text-xs px-2.5 py-1.5 rounded-lg border border-border hover:bg-accent inline-flex items-center gap-1">
                    Open <ExternalLink className="w-3 h-3" />
                  </Link>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {resolveFor && (
        <AddLivePostsDialog campaign={resolveFor} onClose={() => setResolveFor(null)} />
      )}

    </div>
  )
}
