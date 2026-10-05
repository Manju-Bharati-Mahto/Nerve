import { useState } from 'react'
import { IndianRupee, Plus } from 'lucide-react'
import {
  boQuotations, boAddQuotation, boRequests, boVendors, boToday,
  boMoney, QUOTE_STATUS_STYLE, type QuoteStatus,
} from '@/lib/brandops-api'
import {
  BoPage, BoError, BoLoading, BoBadge, BoTable, BoRow, BoCell, BoButton, BoDialog,
  BoField, BoSelect, useBoData, useBoAction,
} from './ui'

/** Recording what vendors have quoted. Choosing between them is Approvals. */
export default function BoQuotations() {
  const [status, setStatus] = useState('')
  const [adding, setAdding] = useState(false)

  const { data, error, loading, refresh, setError } = useBoData(async () => {
    const [quotations, requests, vendors] = await Promise.all([
      boQuotations({ status: (status || undefined) as QuoteStatus | undefined }),
      boRequests(), boVendors(),
    ])
    return { quotations: quotations.quotations, requests: requests.requests, vendors: vendors.vendors }
  }, [status])
  const { busy, act } = useBoAction(refresh, setError)

  // A requirement that is closed or rejected can't take new quotations.
  const quotable = (data?.requests ?? []).filter(r => !['closed', 'rejected'].includes(r.status))

  return (
    <BoPage title="Quotations" icon={IndianRupee}
      subtitle="What each vendor has quoted against a requirement."
      actions={<BoButton onClick={() => setAdding(true)} disabled={quotable.length === 0}>
        <Plus className="w-3.5 h-3.5" /> Add quotation
      </BoButton>}>

      <div className="hub-card flex flex-wrap items-center gap-2">
        <BoSelect label="All statuses" value={status} onChange={setStatus}
          options={Object.entries(QUOTE_STATUS_STYLE).map(([k, v]) => [k, v.label] as [string, string])} />
        <span className="text-xs text-muted-foreground ml-auto">
          {data ? `${data.quotations.length} quotation${data.quotations.length === 1 ? '' : 's'}` : ''}
        </span>
      </div>

      <BoError message={error} />

      {loading ? <BoLoading /> : (
        <BoTable head={['Ref', 'Requirement', 'Institute', 'Vendor', 'Amount', 'Quoted', 'Status', 'Note']}
          empty="No quotations recorded yet.">
          {(data?.quotations ?? []).map(q => (
            <BoRow key={q.id}>
              <BoCell strong nowrap>{q.reference}</BoCell>
              <BoCell nowrap>{q.request_reference}</BoCell>
              <BoCell>{q.institute_name}</BoCell>
              <BoCell strong>{q.vendor_name}</BoCell>
              <BoCell strong nowrap>{boMoney(q.amount)}</BoCell>
              <BoCell nowrap>{q.quote_date}</BoCell>
              <BoCell><BoBadge style={QUOTE_STATUS_STYLE[q.status]} /></BoCell>
              <BoCell>{q.decision_note || q.notes || '—'}</BoCell>
            </BoRow>
          ))}
        </BoTable>
      )}

      {adding && (
        <AddQuotationDialog requests={quotable} vendors={data?.vendors ?? []} busy={busy}
          onClose={() => setAdding(false)}
          onSave={async f => { if (await act(() => boAddQuotation(f))) setAdding(false) }} />
      )}
    </BoPage>
  )
}

function AddQuotationDialog({ requests, vendors, busy, onClose, onSave }: {
  requests: { id: string; reference: string; institute_name: string; work_type: string }[]
  vendors: { id: string; name: string; active: boolean }[]
  busy: boolean; onClose: () => void
  onSave: (f: { request_id: string; vendor_id: string; amount: number; quote_date: string; notes: string }) => Promise<void>
}) {
  const [requestId, setRequestId] = useState('')
  const [vendorId, setVendorId] = useState('')
  const [amount, setAmount] = useState('')
  const [quoteDate, setQuoteDate] = useState(boToday())
  const [notes, setNotes] = useState('')

  const ready = requestId && vendorId && amount !== '' && Number(amount) >= 0 && quoteDate

  return (
    <BoDialog title="Add quotation" onClose={onClose} footer={
      <>
        <BoButton variant="ghost" onClick={onClose}>Cancel</BoButton>
        <BoButton disabled={busy || !ready} onClick={() => void onSave({
          request_id: requestId, vendor_id: vendorId, amount: Number(amount),
          quote_date: quoteDate, notes: notes.trim(),
        })}>{busy ? 'Saving…' : 'Save quotation'}</BoButton>
      </>
    }>
      <BoField label="Requirement *">
        <select className="hub-input" value={requestId} onChange={e => setRequestId(e.target.value)}>
          <option value="">— Select requirement —</option>
          {requests.map(r => (
            <option key={r.id} value={r.id}>{r.reference} — {r.work_type} — {r.institute_name}</option>
          ))}
        </select>
      </BoField>
      <BoField label="Vendor *">
        <select className="hub-input" value={vendorId} onChange={e => setVendorId(e.target.value)}>
          <option value="">— Select vendor —</option>
          {vendors.filter(v => v.active).map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
        </select>
      </BoField>
      <div className="grid grid-cols-2 gap-3">
        <BoField label="Amount (₹) *">
          <input type="number" min={0} step="0.01" className="hub-input" value={amount}
            onChange={e => setAmount(e.target.value)} />
        </BoField>
        <BoField label="Quotation date *">
          <input type="date" className="hub-input" value={quoteDate} onChange={e => setQuoteDate(e.target.value)} />
        </BoField>
      </div>
      <BoField label="Notes">
        <textarea className="hub-input" value={notes} onChange={e => setNotes(e.target.value)} />
      </BoField>
    </BoDialog>
  )
}
