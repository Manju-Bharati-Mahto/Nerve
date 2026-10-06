import { useState } from 'react'
import { ClipboardList, Plus, Pencil, CheckCircle2, RotateCcw, Trash2 } from 'lucide-react'
import {
  boRequests, boAddRequest, boUpdateRequest, boCompleteRequest, boReopenRequest, boRemoveRequest,
  boInstitutes, REQUEST_STATUS_STYLE, PRIORITY_STYLE, type BrandingRequest, type RequestStatus,
} from '@/lib/brandops-api'
import {
  BoPage, BoError, BoLoading, BoBadge, BoTable, BoRow, BoCell, BoButton,
  BoSearch, BoSelect, useBoData, useBoAction, useBoAccess,
} from './ui'
import {
  RequestDialog, RemoveRequestDialog, CompleteRequestDialog, QuoteAmount, QuoteInfoButton, QuotationHistoryDialog,
} from './requirements-ui'

/** Statuses with work still ahead — the ones the server lets be marked Completed. */
const COMPLETABLE: RequestStatus[] = ['pending', 'quoted', 'approved', 'in_progress']

/** One dialog at a time; which one, and for which row. */
type Open =
  | { kind: 'add' }
  | { kind: 'edit' | 'complete' | 'remove'; request: BrandingRequest }
  | { kind: 'quotes'; requestId: string }

/** The front of the pipeline: an institute wants something branded. */
export default function BoRequests() {
  const [q, setQ] = useState('')
  const [status, setStatus] = useState('')
  const [open, setOpen] = useState<Open | null>(null)
  const { can } = useBoAccess()
  const canEdit = can('brandops:requests')

  const { data, error, loading, refresh, setError } = useBoData(async () => {
    const [requests, institutes] = await Promise.all([
      boRequests({ q: q.trim() || undefined, status: (status || undefined) as RequestStatus | undefined }),
      boInstitutes(),
    ])
    return { requests: requests.requests, sizes: requests.sizes, institutes: institutes.institutes }
  }, [q, status])
  const { busy, act } = useBoAction(refresh, setError)

  // A form closes only once the API has accepted it, so a refusal never throws
  // away what was typed. A confirmation closes either way: the refusal (an open
  // work order blocking removal, say) shows in BoError above the table, which
  // the dialog's overlay would otherwise sit on top of.
  const save = async (fn: () => Promise<unknown>) => { if (await act(fn)) setOpen(null) }
  const settle = async (fn: () => Promise<unknown>) => { await act(fn); setOpen(null) }

  const reopen = (r: BrandingRequest) => {
    if (!window.confirm(`Reopen ${r.reference}? It goes back to where its quotations and work order leave it.`)) return
    void act(() => boReopenRequest(r.id))
  }

  const institutes = data?.institutes ?? []
  const sizes = data?.sizes ?? []

  return (
    <BoPage title="Branding Requests" icon={ClipboardList}
      subtitle="Requirement → vendor quotations → approval → work order."
      actions={canEdit && (
        <BoButton onClick={() => setOpen({ kind: 'add' })}><Plus className="w-3.5 h-3.5" /> New requirement</BoButton>
      )}>

      <div className="hub-card flex flex-wrap items-center gap-2">
        <BoSearch value={q} onChange={setQ} placeholder="Search reference, institute, work type, size, location or description…" />
        <BoSelect label="All statuses" value={status} onChange={setStatus}
          options={Object.entries(REQUEST_STATUS_STYLE).map(([k, v]) => [k, v.label] as [string, string])} />
      </div>

      <BoError message={error} />

      {loading ? <BoLoading /> : (
        <BoTable head={['Ref', 'Institute', 'Work type', 'Size', 'Description', 'Location', 'Required', 'Qty', 'Priority', 'Status', 'Quotes', 'Actions']}
          empty="No requirements yet.">
          {(data?.requests ?? []).map(r => (
            <BoRow key={r.id}>
              <BoCell strong nowrap>{r.reference}</BoCell>
              <BoCell>{r.institute_name}</BoCell>
              <BoCell nowrap>{r.work_type}</BoCell>
              <BoCell nowrap>{r.size || '—'}</BoCell>
              <BoCell>{r.description}</BoCell>
              <BoCell>{r.location || '—'}</BoCell>
              <BoCell nowrap>{r.required_date}</BoCell>
              <BoCell nowrap>{r.quantity}</BoCell>
              <BoCell><BoBadge style={PRIORITY_STYLE[r.priority]} /></BoCell>
              <BoCell>
                <BoBadge style={REQUEST_STATUS_STYLE[r.status]} />
                {r.status === 'completed' && r.completion_note && (
                  <div className="text-[11px] mt-1 max-w-[180px]">{r.completion_note}</div>
                )}
              </BoCell>
              <BoCell nowrap>
                <span className="inline-flex items-center gap-1">
                  <QuoteAmount approved={r.approved_amount} lowest={r.lowest_amount} count={r.quote_count} />
                  {r.quote_count > 0 && (
                    <QuoteInfoButton onClick={() => setOpen({ kind: 'quotes', requestId: r.id })}
                      title={`Quotations for ${r.reference}`} />
                  )}
                </span>
              </BoCell>
              <BoCell nowrap>
                {canEdit ? (
                  <div className="flex gap-1.5">
                    <BoButton variant="ghost" disabled={busy} title="Edit"
                      onClick={() => setOpen({ kind: 'edit', request: r })}>
                      <Pencil className="w-3 h-3" />
                    </BoButton>
                    {COMPLETABLE.includes(r.status) && (
                      <BoButton variant="ghost" disabled={busy} title="Mark completed — the work is finished"
                        onClick={() => setOpen({ kind: 'complete', request: r })}>
                        <CheckCircle2 className="w-3 h-3 text-emerald-600" /> Complete
                      </BoButton>
                    )}
                    {r.status === 'completed' && (
                      <BoButton variant="ghost" disabled={busy} title="Reopen — marked completed by mistake"
                        onClick={() => reopen(r)}>
                        <RotateCcw className="w-3 h-3" /> Reopen
                      </BoButton>
                    )}
                    <BoButton variant="danger" disabled={busy} title="Remove from Branding Requests and the Dashboard"
                      onClick={() => setOpen({ kind: 'remove', request: r })}>
                      <Trash2 className="w-3 h-3" />
                    </BoButton>
                  </div>
                ) : <span className="text-[11px]">—</span>}
              </BoCell>
            </BoRow>
          ))}
        </BoTable>
      )}

      {open?.kind === 'add' && (
        <RequestDialog institutes={institutes} sizes={sizes} busy={busy} onClose={() => setOpen(null)}
          onSave={f => save(() => boAddRequest(f))} />
      )}
      {open?.kind === 'edit' && (
        <RequestDialog initial={open.request} institutes={institutes} sizes={sizes} busy={busy}
          onClose={() => setOpen(null)}
          onSave={f => save(() => boUpdateRequest(open.request.id, f))} />
      )}
      {open?.kind === 'complete' && (
        <CompleteRequestDialog request={open.request} busy={busy} onClose={() => setOpen(null)}
          onConfirm={note => settle(() => boCompleteRequest(open.request.id, note))} />
      )}
      {open?.kind === 'remove' && (
        <RemoveRequestDialog request={open.request} busy={busy} onClose={() => setOpen(null)}
          onConfirm={reason => settle(() => boRemoveRequest(open.request.id, reason))} />
      )}
      {open?.kind === 'quotes' && (
        <QuotationHistoryDialog requestId={open.requestId} onClose={() => setOpen(null)} />
      )}
    </BoPage>
  )
}
