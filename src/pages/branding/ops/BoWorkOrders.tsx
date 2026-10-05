import { useState } from 'react'
import { Hammer, Plus, ArrowRight } from 'lucide-react'
import {
  boWorkOrders, boAddWorkOrder, boSetWorkOrderStatus, boRequests, boToday,
  boMoney, WO_STATUS_STYLE, WO_NEXT, type WorkOrderStatus,
} from '@/lib/brandops-api'
import {
  BoPage, BoError, BoLoading, BoBadge, BoTable, BoRow, BoCell, BoButton, BoDialog,
  BoField, BoSearch, BoSelect, useBoData, useBoAction,
} from './ui'

/**
 * Work orders only exist downstream of an approved quotation, so the "new"
 * dialog lists approved requirements rather than letting one be typed in.
 */
export default function BoWorkOrders() {
  const [q, setQ] = useState('')
  const [status, setStatus] = useState('')
  const [adding, setAdding] = useState(false)

  const { data, error, loading, refresh, setError } = useBoData(async () => {
    const [orders, requests] = await Promise.all([
      boWorkOrders({ q: q.trim() || undefined, status: (status || undefined) as WorkOrderStatus | undefined }),
      boRequests(),
    ])
    return { orders: orders.work_orders, requests: requests.requests }
  }, [q, status])
  const { busy, act } = useBoAction(refresh, setError)

  // Approved, and no work order raised yet.
  const raised = new Set((data?.orders ?? []).map(o => o.request_id))
  const eligible = (data?.requests ?? []).filter(r => r.status === 'approved' && !raised.has(r.id))

  return (
    <BoPage title="Work Orders" icon={Hammer}
      subtitle="Issued from approved quotations, and moved through to close."
      actions={
        <BoButton onClick={() => setAdding(true)} disabled={eligible.length === 0}>
          <Plus className="w-3.5 h-3.5" /> New work order
        </BoButton>
      }>

      <div className="hub-card flex flex-wrap items-center gap-2">
        <BoSearch value={q} onChange={setQ} placeholder="Search reference, vendor, institute…" />
        <BoSelect label="All statuses" value={status} onChange={setStatus}
          options={Object.entries(WO_STATUS_STYLE).map(([k, v]) => [k, v.label] as [string, string])} />
        {eligible.length === 0 && (
          <span className="text-[11px] text-muted-foreground ml-auto">
            Approve a quotation to raise a new work order.
          </span>
        )}
      </div>

      <BoError message={error} />

      {loading ? <BoLoading /> : (
        <BoTable head={['WO', 'Requirement', 'Institute', 'Vendor', 'Amount', 'Assigned', 'Photos', 'Status', 'Next step']}
          empty="No work orders yet.">
          {(data?.orders ?? []).map(w => (
            <BoRow key={w.id}>
              <BoCell strong nowrap>{w.reference}</BoCell>
              <BoCell nowrap>{w.request_reference}</BoCell>
              <BoCell>{w.institute_name}</BoCell>
              <BoCell strong>{w.vendor_name}</BoCell>
              <BoCell nowrap>{boMoney(w.amount)}</BoCell>
              <BoCell nowrap>{w.assigned_date}</BoCell>
              <BoCell nowrap>{w.photo_count}</BoCell>
              <BoCell><BoBadge style={WO_STATUS_STYLE[w.status]} /></BoCell>
              <BoCell nowrap>
                <div className="flex gap-1.5 flex-wrap">
                  {WO_NEXT[w.status].map(next => (
                    <BoButton key={next} variant="ghost" disabled={busy}
                      onClick={() => void act(() => boSetWorkOrderStatus(w.id, next))}>
                      <ArrowRight className="w-3 h-3" /> {WO_STATUS_STYLE[next].label}
                    </BoButton>
                  ))}
                  {WO_NEXT[w.status].length === 0 && <span className="text-[11px] text-muted-foreground">Done</span>}
                </div>
              </BoCell>
            </BoRow>
          ))}
        </BoTable>
      )}

      {adding && (
        <AddWorkOrderDialog eligible={eligible} busy={busy} onClose={() => setAdding(false)}
          onSave={async f => { if (await act(() => boAddWorkOrder(f))) setAdding(false) }} />
      )}
    </BoPage>
  )
}

function AddWorkOrderDialog({ eligible, busy, onClose, onSave }: {
  eligible: { id: string; reference: string; institute_name: string; work_type: string; approved_amount: string | null }[]
  busy: boolean; onClose: () => void
  onSave: (f: { request_id: string; assigned_date: string; description: string }) => Promise<void>
}) {
  const [requestId, setRequestId] = useState('')
  const [assignedDate, setAssignedDate] = useState(boToday())
  const [description, setDescription] = useState('')

  return (
    <BoDialog title="New work order" onClose={onClose} footer={
      <>
        <BoButton variant="ghost" onClick={onClose}>Cancel</BoButton>
        <BoButton disabled={busy || !requestId || !assignedDate}
          onClick={() => void onSave({ request_id: requestId, assigned_date: assignedDate, description: description.trim() })}>
          {busy ? 'Creating…' : 'Create work order'}
        </BoButton>
      </>
    }>
      <p className="text-xs text-muted-foreground">
        Only requirements with an approved quotation appear here. The vendor and amount come from
        that approved quote.
      </p>
      <BoField label="Approved requirement *">
        <select className="hub-input" value={requestId} onChange={e => setRequestId(e.target.value)}>
          <option value="">— Select requirement —</option>
          {eligible.map(r => (
            <option key={r.id} value={r.id}>
              {r.reference} — {r.work_type} — {r.institute_name} — {boMoney(r.approved_amount)}
            </option>
          ))}
        </select>
      </BoField>
      <BoField label="Assigned date *">
        <input type="date" className="hub-input" value={assignedDate} onChange={e => setAssignedDate(e.target.value)} />
      </BoField>
      <BoField label="Work description">
        <textarea className="hub-input" value={description} onChange={e => setDescription(e.target.value)} />
      </BoField>
    </BoDialog>
  )
}
