import { useState } from 'react'
import { Link } from 'react-router-dom'
import { LayoutDashboard, AlertTriangle, Trash2, CheckCircle2 } from 'lucide-react'
import {
  boDashboard, boIsOverdue, boCompleteRequest, boRemoveRequest,
  FRAME_STATUS_STYLE, REQUEST_STATUS_STYLE, PRIORITY_STYLE, type BrandingRequest, type RequestStatus,
} from '@/lib/brandops-api'
import {
  BoPage, BoError, BoLoading, BoKpi, BoBadge, BoTable, BoRow, BoCell, BoButton,
  useBoData, useBoAction, useBoAccess,
} from './ui'
import {
  CompleteRequestDialog, QuotationHistoryDialog, QuoteAmount, QuoteInfoButton, RemoveRequestDialog,
} from './requirements-ui'
import { quoteSummaryTitle } from './requirements'

// The states the server lets a requirement be marked Completed from.
const COMPLETABLE: RequestStatus[] = ['pending', 'quoted', 'approved', 'in_progress']

/**
 * The live view: what's deployed right now, what's overdue back, and what
 * branding work is outstanding. Every number here is a count over the same
 * tables the other tabs edit, so it can't drift from them.
 */
export default function BoDashboard() {
  const { data, error, loading, refresh, setError } = useBoData(() => boDashboard(), [])
  const { busy, act } = useBoAction(refresh, setError)
  const { can } = useBoAccess()
  const canEdit = can('brandops:requests')
  const [removing, setRemoving] = useState<BrandingRequest | null>(null)
  const [completing, setCompleting] = useState<BrandingRequest | null>(null)
  const [quotesOf, setQuotesOf] = useState<string | null>(null)

  // Only the first load blanks the page. Once there is a dashboard, a refresh
  // after an action, or an action's error, must not take it off screen.
  if (!data) {
    if (loading) return <BoLoading />
    return <BoError message={error ?? 'Could not load the dashboard.'} />
  }
  const { kpis: k, sizes, allocations, requests, quotes } = data

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
          {/* An action's error shows here, beside the row it was about. */}
          <div className="mb-2"><BoError message={error} /></div>
          <BoTable head={['Ref', 'Institute', 'Work', 'Size', 'Required', 'Priority', 'Status', 'Quotation', '']}
            empty="No outstanding requirements.">
            {requests.map(r => (
              <BoRow key={r.id}>
                <BoCell strong nowrap>{r.reference}</BoCell>
                <BoCell>{r.institute_name}</BoCell>
                <BoCell>{r.work_type}</BoCell>
                <BoCell nowrap>{r.size || '—'}</BoCell>
                <BoCell nowrap>{r.required_date}</BoCell>
                <BoCell><BoBadge style={PRIORITY_STYLE[r.priority]} /></BoCell>
                <BoCell><BoBadge style={REQUEST_STATUS_STYLE[r.status]} /></BoCell>
                <BoCell nowrap>
                  <span className="inline-flex items-center gap-1">
                    <QuoteAmount approved={r.approved_amount} lowest={r.lowest_amount} count={r.quote_count} />
                    {/* The hover text already lists vendors and amounts; the click opens the full comparison. */}
                    {r.quote_count > 0 && (
                      <QuoteInfoButton title={quoteSummaryTitle(quotes[r.id])} onClick={() => setQuotesOf(r.id)} />
                    )}
                  </span>
                </BoCell>
                <BoCell nowrap>
                  {canEdit && (
                    <div className="flex gap-1.5">
                      {COMPLETABLE.includes(r.status) && (
                        // Icon-only: the table shares its row with Stock by size and has no room for labels.
                        <BoButton variant="ghost" disabled={busy} title="Mark completed — the work is finished"
                          onClick={() => setCompleting(r)}>
                          <CheckCircle2 className="w-3 h-3 text-emerald-600" />
                        </BoButton>
                      )}
                      <BoButton variant="danger" disabled={busy} title="Remove requirement"
                        onClick={() => setRemoving(r)}>
                        <Trash2 className="w-3 h-3" />
                      </BoButton>
                    </div>
                  )}
                </BoCell>
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

      {/* The dialogs close whether or not the action went through: a refusal
          (say, a work order still open) is shown above the table, which an
          open dialog would cover. */}
      {removing && (
        <RemoveRequestDialog request={removing} busy={busy} onClose={() => setRemoving(null)}
          onConfirm={async reason => { await act(() => boRemoveRequest(removing.id, reason)); setRemoving(null) }} />
      )}
      {completing && (
        <CompleteRequestDialog request={completing} busy={busy} onClose={() => setCompleting(null)}
          onConfirm={async note => { await act(() => boCompleteRequest(completing.id, note)); setCompleting(null) }} />
      )}
      {quotesOf && <QuotationHistoryDialog requestId={quotesOf} onClose={() => setQuotesOf(null)} />}
    </BoPage>
  )
}
