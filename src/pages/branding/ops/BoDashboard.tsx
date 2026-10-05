import { Link } from 'react-router-dom'
import { LayoutDashboard, AlertTriangle } from 'lucide-react'
import {
  boDashboard, boIsOverdue, boMoney, FRAME_STATUS_STYLE, REQUEST_STATUS_STYLE, PRIORITY_STYLE,
} from '@/lib/brandops-api'
import {
  BoPage, BoError, BoLoading, BoKpi, BoBadge, BoTable, BoRow, BoCell, useBoData,
} from './ui'

/**
 * The live view: what's deployed right now, what's overdue back, and what
 * branding work is outstanding. Every number here is a count over the same
 * tables the other tabs edit, so it can't drift from them.
 */
export default function BoDashboard() {
  const { data, error, loading } = useBoData(() => boDashboard(), [])

  if (loading) return <BoLoading />
  if (error) return <BoError message={error} />
  if (!data) return null
  const { kpis: k, sizes, allocations, requests } = data

  return (
    <BoPage title="Dashboard" subtitle="Frames, branding work and vendor activity" icon={LayoutDashboard}>
      <div className="grid grid-cols-2 lg:grid-cols-6 gap-3">
        <BoKpi label="Total frames" value={k.totalFrames} />
        <BoKpi label="Available" value={k.available} />
        <BoKpi label="In use" value={k.inUse} />
        <BoKpi label="Overdue back" value={k.overdue} accent={k.overdue > 0} />
        <BoKpi label="Pending branding" value={k.pendingRequests} accent={k.pendingRequests > 0} />
        <BoKpi label="Different sizes" value={k.distinctSizes} />
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-6 gap-3">
        <BoKpi label="Open quotations" value={k.openQuotations} />
        <BoKpi label="Active work orders" value={k.activeWorkOrders} />
        <BoKpi label="Vendors on site" value={k.vendorsOnSite} accent={k.vendorsOnSite > 0} />
        <BoKpi label="Material awaiting" value={k.deliveriesAwaiting} />
        <BoKpi label="Ready to collect" value={k.deliveriesReady} accent={k.deliveriesReady > 0} />
        <BoKpi label="Institutes holding" value={`${k.institutesHoldingFrames}/${k.totalInstitutes}`} />
      </div>

      {k.sheetLineTotal !== k.sheetStatedTotal && (
        <div className="hub-card bg-amber-50 border-amber-200 flex items-start gap-2 text-xs text-amber-900">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>
            The source frame sheet lists {k.sheetLineTotal} frames across its line items but its Total
            row says {k.sheetStatedTotal}. The line items were loaded. Someone should decide which is right —
            the difference is {Math.abs(k.sheetLineTotal - k.sheetStatedTotal)} frames.
          </span>
        </div>
      )}

      <div>
        <h2 className="text-[11px] uppercase tracking-widest text-muted-foreground mb-2">
          Live frame allocations
        </h2>
        <BoTable head={['Asset', 'Size', 'Institute', 'Location', 'Event', 'From', 'Until', 'Status']}
          empty="No frame is currently allocated.">
          {allocations.map(a => (
            <BoRow key={a.id}>
              <BoCell strong nowrap>
                <Link className="hover:underline" to={`/branding/ops/frames?q=${a.asset_id}`}>{a.asset_id}</Link>
              </BoCell>
              <BoCell nowrap>{a.size}</BoCell>
              <BoCell strong>{a.institute_name}</BoCell>
              <BoCell>{a.location}</BoCell>
              <BoCell>{a.event || '—'}</BoCell>
              <BoCell nowrap>{a.from_date}</BoCell>
              <BoCell nowrap>
                <span className={boIsOverdue(a.until_date) ? 'text-rose-600 font-medium' : ''}>
                  {a.until_date}{boIsOverdue(a.until_date) && ' · overdue'}
                </span>
              </BoCell>
              <BoCell><BoBadge style={FRAME_STATUS_STYLE.in_use} /></BoCell>
            </BoRow>
          ))}
        </BoTable>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <div className="lg:col-span-2">
          <h2 className="text-[11px] uppercase tracking-widest text-muted-foreground mb-2">
            Outstanding branding work
          </h2>
          <BoTable head={['Ref', 'Institute', 'Work', 'Required', 'Priority', 'Status', 'Quotes']}
            empty="No outstanding requirements.">
            {requests.map(r => (
              <BoRow key={r.id}>
                <BoCell strong nowrap>{r.reference}</BoCell>
                <BoCell>{r.institute_name}</BoCell>
                <BoCell>{r.work_type}</BoCell>
                <BoCell nowrap>{r.required_date}</BoCell>
                <BoCell><BoBadge style={PRIORITY_STYLE[r.priority]} /></BoCell>
                <BoCell><BoBadge style={REQUEST_STATUS_STYLE[r.status]} /></BoCell>
                <BoCell nowrap>{r.quote_count}{r.approved_amount ? ` · ${boMoney(r.approved_amount)}` : ''}</BoCell>
              </BoRow>
            ))}
          </BoTable>
        </div>

        <div>
          <h2 className="text-[11px] uppercase tracking-widest text-muted-foreground mb-2">Stock by size</h2>
          <div className="hub-card max-h-[420px] overflow-y-auto">
            <ul className="space-y-2.5">
              {sizes.map(s => (
                <li key={s.size}>
                  <div className="flex items-baseline justify-between gap-3 text-xs">
                    <span className="text-foreground truncate">{s.size}</span>
                    <span className="text-muted-foreground shrink-0 tabular-nums">
                      {s.available}/{s.total}
                    </span>
                  </div>
                  <div className="mt-1 h-1.5 rounded-full bg-rose-200 overflow-hidden">
                    <div className="h-full rounded-full bg-emerald-500"
                      style={{ width: `${(s.available / s.total) * 100}%` }} />
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </BoPage>
  )
}
