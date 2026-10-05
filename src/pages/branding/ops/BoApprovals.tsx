import { useState } from 'react'
import { CheckCircle2, XCircle, BadgeCheck } from 'lucide-react'
import { boApprovals, boQuotations, boDecideQuotation, boMoney, QUOTE_STATUS_STYLE } from '@/lib/brandops-api'
import {
  BoPage, BoError, BoLoading, BoEmpty, BoBadge, BoTable, BoRow, BoCell, BoButton,
  BoDialog, BoField, useBoData, useBoAction,
} from './ui'
import type { Quotation } from '@/lib/brandops-api'

/**
 * Deciding between quotations. Approving one rejects the competing quotes on
 * the same requirement — the dialog says so, because the person clicking
 * should know they are also turning the others down.
 */
export default function BoApprovals() {
  const { data, error, loading, refresh, setError } = useBoData(async () => {
    const [pending, all] = await Promise.all([boApprovals(), boQuotations()])
    return { pending: pending.quotations, decided: all.quotations.filter(q => q.status !== 'pending') }
  }, [])
  const { busy, act } = useBoAction(refresh, setError)
  const [deciding, setDeciding] = useState<{ q: Quotation; decision: 'approved' | 'rejected' } | null>(null)

  const pending = data?.pending ?? []
  // Competing quotes on the same requirement, so the decision can be compared.
  const siblings = (q: Quotation) => pending.filter(p => p.request_id === q.request_id && p.id !== q.id)

  return (
    <BoPage title="Approvals" icon={BadgeCheck}
      subtitle="Approve or reject vendor quotations. Approving one unlocks the work order.">
      <BoError message={error} />

      {loading ? <BoLoading /> : pending.length === 0 ? (
        <BoEmpty>No quotations are waiting for a decision.</BoEmpty>
      ) : (
        <div className="space-y-3">
          {pending.map(q => {
            const others = siblings(q)
            const cheapest = others.every(o => Number(o.amount) >= Number(q.amount))
            return (
              <div key={q.id} className="hub-card">
                <div className="flex items-start justify-between gap-4 flex-wrap">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground">
                      {q.vendor_name} · {boMoney(q.amount)}
                      {cheapest && others.length > 0 && (
                        <span className="ml-2 hub-badge bg-emerald-100 text-emerald-700">Lowest</span>
                      )}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {q.request_reference} · {q.institute_name} · quoted {q.quote_date}
                    </p>
                    {q.notes && <p className="text-xs text-muted-foreground mt-1">{q.notes}</p>}
                    {others.length > 0 && (
                      <p className="text-[11px] text-muted-foreground mt-1.5">
                        Competing: {others.map(o => `${o.vendor_name} ${boMoney(o.amount)}`).join(' · ')}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <BoButton variant="danger" onClick={() => setDeciding({ q, decision: 'rejected' })}>
                      <XCircle className="w-3.5 h-3.5" /> Reject
                    </BoButton>
                    <BoButton variant="success" onClick={() => setDeciding({ q, decision: 'approved' })}>
                      <CheckCircle2 className="w-3.5 h-3.5" /> Approve
                    </BoButton>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {(data?.decided.length ?? 0) > 0 && (
        <div>
          <h2 className="text-[11px] uppercase tracking-widest text-muted-foreground mb-2">Already decided</h2>
          <BoTable head={['Ref', 'Requirement', 'Vendor', 'Amount', 'Status', 'Reason']}>
            {(data?.decided ?? []).map(q => (
              <BoRow key={q.id}>
                <BoCell strong nowrap>{q.reference}</BoCell>
                <BoCell nowrap>{q.request_reference}</BoCell>
                <BoCell>{q.vendor_name}</BoCell>
                <BoCell nowrap>{boMoney(q.amount)}</BoCell>
                <BoCell><BoBadge style={QUOTE_STATUS_STYLE[q.status]} /></BoCell>
                <BoCell>{q.decision_note || '—'}</BoCell>
              </BoRow>
            ))}
          </BoTable>
        </div>
      )}

      {deciding && (
        <DecisionDialog {...deciding} others={siblings(deciding.q)} busy={busy}
          onClose={() => setDeciding(null)}
          onConfirm={async note => {
            if (await act(() => boDecideQuotation(deciding.q.id, deciding.decision, note))) setDeciding(null)
          }} />
      )}
    </BoPage>
  )
}

function DecisionDialog({ q, decision, others, busy, onClose, onConfirm }: {
  q: Quotation; decision: 'approved' | 'rejected'; others: Quotation[]
  busy: boolean; onClose: () => void; onConfirm: (note: string) => Promise<void>
}) {
  const [note, setNote] = useState(decision === 'approved' && others.length ? 'Lowest quote' : '')
  const approving = decision === 'approved'
  return (
    <BoDialog title={approving ? `Approve ${q.vendor_name}?` : `Reject ${q.vendor_name}?`} onClose={onClose} footer={
      <>
        <BoButton variant="ghost" onClick={onClose}>Cancel</BoButton>
        <BoButton variant={approving ? 'success' : 'danger'} disabled={busy}
          onClick={() => void onConfirm(note)}>
          {busy ? 'Saving…' : approving ? 'Approve quotation' : 'Reject quotation'}
        </BoButton>
      </>
    }>
      <p className="text-sm text-foreground">
        {q.vendor_name} quoted <b>{boMoney(q.amount)}</b> for {q.request_reference} ({q.institute_name}).
      </p>
      {approving && others.length > 0 && (
        <div className="hub-card bg-amber-50 border-amber-200 text-xs text-amber-900">
          This also rejects {others.length === 1 ? 'the competing quotation' : `the ${others.length} competing quotations`} on
          this requirement: {others.map(o => o.vendor_name).join(', ')}. Only one quote per requirement can be approved.
        </div>
      )}
      {approving && (
        <p className="text-xs text-muted-foreground">
          Once approved, a work order can be raised against this requirement.
        </p>
      )}
      <BoField label="Reason / note">
        <textarea className="hub-input" value={note} onChange={e => setNote(e.target.value)} />
      </BoField>
    </BoDialog>
  )
}
