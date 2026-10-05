import { useState } from 'react'
import { ClipboardList, Plus } from 'lucide-react'
import {
  boRequests, boAddRequest, boInstitutes, boToday,
  REQUEST_STATUS_STYLE, PRIORITY_STYLE, boMoney, type Priority, type RequestStatus,
} from '@/lib/brandops-api'
import {
  BoPage, BoError, BoLoading, BoBadge, BoTable, BoRow, BoCell, BoButton, BoDialog,
  BoField, BoSearch, BoSelect, useBoData, useBoAction,
} from './ui'

const WORK_TYPES = ['Frame / Branding', 'Signage', 'Banner', 'Printing', 'Installation', 'Repair / Maintenance', 'Other']

/** The front of the pipeline: an institute wants something branded. */
export default function BoRequests() {
  const [q, setQ] = useState('')
  const [status, setStatus] = useState('')
  const [adding, setAdding] = useState(false)

  const { data, error, loading, refresh, setError } = useBoData(async () => {
    const [requests, institutes] = await Promise.all([
      boRequests({ q: q.trim() || undefined, status: (status || undefined) as RequestStatus | undefined }),
      boInstitutes(),
    ])
    return { requests: requests.requests, institutes: institutes.institutes }
  }, [q, status])
  const { busy, act } = useBoAction(refresh, setError)

  return (
    <BoPage title="Branding Requests" icon={ClipboardList}
      subtitle="Requirement → vendor quotations → approval → work order."
      actions={<BoButton onClick={() => setAdding(true)}><Plus className="w-3.5 h-3.5" /> New requirement</BoButton>}>

      <div className="hub-card flex flex-wrap items-center gap-2">
        <BoSearch value={q} onChange={setQ} placeholder="Search reference, institute, work type or description…" />
        <BoSelect label="All statuses" value={status} onChange={setStatus}
          options={Object.entries(REQUEST_STATUS_STYLE).map(([k, v]) => [k, v.label] as [string, string])} />
      </div>

      <BoError message={error} />

      {loading ? <BoLoading /> : (
        <BoTable head={['Ref', 'Institute', 'Work type', 'Description', 'Location', 'Required', 'Qty', 'Priority', 'Status', 'Quotes']}
          empty="No requirements yet.">
          {(data?.requests ?? []).map(r => (
            <BoRow key={r.id}>
              <BoCell strong nowrap>{r.reference}</BoCell>
              <BoCell>{r.institute_name}</BoCell>
              <BoCell nowrap>{r.work_type}</BoCell>
              <BoCell>{r.description}</BoCell>
              <BoCell>{r.location || '—'}</BoCell>
              <BoCell nowrap>{r.required_date}</BoCell>
              <BoCell nowrap>{r.quantity}</BoCell>
              <BoCell><BoBadge style={PRIORITY_STYLE[r.priority]} /></BoCell>
              <BoCell><BoBadge style={REQUEST_STATUS_STYLE[r.status]} /></BoCell>
              <BoCell nowrap>
                {r.quote_count}
                {r.approved_amount && <span className="text-emerald-700"> · {boMoney(r.approved_amount)}</span>}
              </BoCell>
            </BoRow>
          ))}
        </BoTable>
      )}

      {adding && (
        <AddRequestDialog institutes={data?.institutes ?? []} busy={busy}
          onClose={() => setAdding(false)}
          onSave={async f => { if (await act(() => boAddRequest(f))) setAdding(false) }} />
      )}
    </BoPage>
  )
}

function AddRequestDialog({ institutes, busy, onClose, onSave }: {
  institutes: { id: string; name: string; active: boolean }[]
  busy: boolean; onClose: () => void
  onSave: (f: {
    institute_id: string; required_date: string; work_type: string
    priority: Priority; description: string; location: string; quantity: number
  }) => Promise<void>
}) {
  const [instituteId, setInstituteId] = useState('')
  const [requiredDate, setRequiredDate] = useState(boToday())
  const [workType, setWorkType] = useState('')
  const [priority, setPriority] = useState<Priority>('normal')
  const [description, setDescription] = useState('')
  const [location, setLocation] = useState('')
  const [quantity, setQuantity] = useState(1)

  const ready = instituteId && requiredDate && workType && description.trim()

  return (
    <BoDialog title="New branding requirement" onClose={onClose} wide footer={
      <>
        <BoButton variant="ghost" onClick={onClose}>Cancel</BoButton>
        <BoButton disabled={busy || !ready} onClick={() => void onSave({
          institute_id: instituteId, required_date: requiredDate, work_type: workType,
          priority, description: description.trim(), location: location.trim(), quantity,
        })}>{busy ? 'Creating…' : 'Create requirement'}</BoButton>
      </>
    }>
      <p className="text-xs text-muted-foreground">
        The reference number is generated for you.
      </p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <BoField label="Institute *">
          <select className="hub-input" value={instituteId} onChange={e => setInstituteId(e.target.value)}>
            <option value="">— Select institute —</option>
            {institutes.filter(i => i.active).map(i => <option key={i.id} value={i.id}>{i.name}</option>)}
          </select>
        </BoField>
        <BoField label="Required date *">
          <input type="date" className="hub-input" value={requiredDate} onChange={e => setRequiredDate(e.target.value)} />
        </BoField>
        <BoField label="Work type *">
          <select className="hub-input" value={workType} onChange={e => setWorkType(e.target.value)}>
            <option value="">— Select work type —</option>
            {WORK_TYPES.map(w => <option key={w} value={w}>{w}</option>)}
          </select>
        </BoField>
        <BoField label="Priority">
          <select className="hub-input" value={priority} onChange={e => setPriority(e.target.value as Priority)}>
            {Object.entries(PRIORITY_STYLE).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
        </BoField>
        <BoField label="Location">
          <input className="hub-input" value={location} onChange={e => setLocation(e.target.value)}
            placeholder="e.g. Main Gate / Block A / Auditorium" />
        </BoField>
        <BoField label="Quantity">
          <input type="number" min={1} className="hub-input" value={quantity}
            onChange={e => setQuantity(Math.max(1, Number(e.target.value) || 1))} />
        </BoField>
      </div>
      <BoField label="Work / branding description *">
        <textarea className="hub-input" value={description} onChange={e => setDescription(e.target.value)}
          placeholder="Describe what branding work is required…" />
      </BoField>
    </BoDialog>
  )
}
