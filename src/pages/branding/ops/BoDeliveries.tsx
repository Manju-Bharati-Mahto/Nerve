import { useState } from 'react'
import { Package, Plus, BellRing, PackageCheck } from 'lucide-react'
import {
  boDeliveries, boAddDelivery, boDeliveryReceived, boDeliveryNotify, boDeliveryCollected,
  boInstitutes, boVendors, DELIVERY_STATUS_STYLE, boWhen,
} from '@/lib/brandops-api'
import {
  BoPage, BoError, BoLoading, BoKpi, BoBadge, BoTable, BoRow, BoCell, BoButton,
  BoDialog, BoField, useBoData, useBoAction,
} from './ui'

const MATERIALS = ['Certificate', 'Memento', 'Flyer', 'Board', 'Banner', 'Brochure', 'Other']

/** Printed matter: vendor delivers → office receives → institute is told → collected. */
export default function BoDeliveries() {
  const [adding, setAdding] = useState(false)
  const { data, error, loading, refresh, setError } = useBoData(async () => {
    const [deliveries, institutes, vendors] = await Promise.all([
      boDeliveries(), boInstitutes(), boVendors(),
    ])
    return { deliveries: deliveries.deliveries, institutes: institutes.institutes, vendors: vendors.vendors }
  }, [])
  const { busy, act } = useBoAction(refresh, setError)
  const [collecting, setCollecting] = useState<string | null>(null)
  const [collectedBy, setCollectedBy] = useState('')

  const list = data?.deliveries ?? []
  const count = (s: string) => list.filter(d => d.status === s).length

  return (
    <BoPage title="Material Delivery" icon={Package}
      subtitle="Printed material from vendor delivery through to institute collection."
      actions={<BoButton onClick={() => setAdding(true)}><Plus className="w-3.5 h-3.5" /> Log delivery</BoButton>}>

      <div className="grid grid-cols-3 gap-3">
        <BoKpi label="Awaiting vendor delivery" value={count('awaiting')} />
        <BoKpi label="Ready for collection" value={count('ready')} accent={count('ready') > 0} />
        <BoKpi label="Collected" value={count('collected')} />
      </div>

      <BoError message={error} />

      {loading ? <BoLoading /> : (
        <BoTable head={['Ref', 'Institute', 'Material', 'Qty', 'Vendor', 'Images', 'Expected', 'Received', 'Notified', 'Collected', 'Status']}
          empty="No material deliveries logged yet.">
          {list.map(d => (
            <BoRow key={d.id}>
              <BoCell strong nowrap>{d.reference}</BoCell>
              <BoCell>{d.institute_name}</BoCell>
              <BoCell>{d.material_type} — {d.description}</BoCell>
              <BoCell nowrap>{d.quantity}</BoCell>
              <BoCell>{d.vendor_name ?? '—'}</BoCell>
              <BoCell>
                {d.images.length === 0 ? '—' : (
                  <div className="flex gap-1">
                    {d.images.map(im => (
                      <a key={im.id} href={im.file_path} target="_blank" rel="noreferrer" title={im.original_name}>
                        <img src={im.file_path} alt={im.original_name}
                          className="w-9 h-9 object-cover rounded border border-border" />
                      </a>
                    ))}
                  </div>
                )}
              </BoCell>
              <BoCell nowrap>{d.expected_date ?? '—'}</BoCell>
              <BoCell nowrap>{d.received_at ? boWhen(d.received_at) : '—'}</BoCell>
              <BoCell nowrap>{d.notified_at ? boWhen(d.notified_at) : '—'}</BoCell>
              <BoCell nowrap>{d.collected_at ? `${boWhen(d.collected_at)}${d.collected_by_name ? ` · ${d.collected_by_name}` : ''}` : '—'}</BoCell>
              <BoCell nowrap>
                <div className="flex items-center gap-1.5 flex-wrap">
                  <BoBadge style={DELIVERY_STATUS_STYLE[d.status]} />
                  {d.status === 'awaiting' && (
                    <BoButton variant="ghost" disabled={busy} onClick={() => void act(() => boDeliveryReceived(d.id))}>
                      Received
                    </BoButton>
                  )}
                  {d.status === 'ready' && (
                    <>
                      {!d.notified_at && (
                        <BoButton variant="ghost" disabled={busy} onClick={() => void act(() => boDeliveryNotify(d.id))}>
                          <BellRing className="w-3 h-3" /> Notify
                        </BoButton>
                      )}
                      <BoButton variant="success" disabled={busy}
                        onClick={() => { setCollecting(d.id); setCollectedBy('') }}>
                        <PackageCheck className="w-3 h-3" /> Collected
                      </BoButton>
                    </>
                  )}
                </div>
              </BoCell>
            </BoRow>
          ))}
        </BoTable>
      )}

      {collecting && (
        <BoDialog title="Mark as collected" onClose={() => setCollecting(null)} footer={
          <>
            <BoButton variant="ghost" onClick={() => setCollecting(null)}>Cancel</BoButton>
            <BoButton variant="success" disabled={busy} onClick={async () => {
              if (await act(() => boDeliveryCollected(collecting, collectedBy.trim()))) setCollecting(null)
            }}>Confirm collection</BoButton>
          </>
        }>
          <BoField label="Collected by" hint="Who from the institute picked it up.">
            <input className="hub-input" value={collectedBy} autoFocus
              onChange={e => setCollectedBy(e.target.value)} placeholder="e.g. Dr Shah" />
          </BoField>
        </BoDialog>
      )}

      {adding && (
        <AddDeliveryDialog institutes={data?.institutes ?? []} vendors={data?.vendors ?? []}
          busy={busy} onClose={() => setAdding(false)}
          onSave={async form => { if (await act(() => boAddDelivery(form))) setAdding(false) }} />
      )}
    </BoPage>
  )
}

function AddDeliveryDialog({ institutes, vendors, busy, onClose, onSave }: {
  institutes: { id: string; name: string; active: boolean }[]
  vendors: { id: string; name: string; active: boolean }[]
  busy: boolean; onClose: () => void; onSave: (form: FormData) => Promise<void>
}) {
  const [instituteId, setInstituteId] = useState('')
  const [materialType, setMaterialType] = useState('')
  const [description, setDescription] = useState('')
  const [quantity, setQuantity] = useState(1)
  const [vendorId, setVendorId] = useState('')
  const [expected, setExpected] = useState('')
  const [remarks, setRemarks] = useState('')
  const [files, setFiles] = useState<FileList | null>(null)

  const ready = instituteId && materialType && description.trim()

  function submit() {
    const form = new FormData()
    form.append('institute_id', instituteId)
    form.append('material_type', materialType)
    form.append('description', description.trim())
    form.append('quantity', String(quantity))
    if (vendorId) form.append('vendor_id', vendorId)
    if (expected) form.append('expected_date', expected)
    if (remarks.trim()) form.append('remarks', remarks.trim())
    for (const f of Array.from(files ?? [])) form.append('images', f)
    void onSave(form)
  }

  return (
    <BoDialog title="Log material delivery" onClose={onClose} wide footer={
      <>
        <BoButton variant="ghost" onClick={onClose}>Cancel</BoButton>
        <BoButton disabled={busy || !ready} onClick={submit}>
          {busy ? 'Saving…' : 'Add delivery'}
        </BoButton>
      </>
    }>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <BoField label="Institute *">
          <select className="hub-input" value={instituteId} onChange={e => setInstituteId(e.target.value)}>
            <option value="">— Select institute —</option>
            {institutes.filter(i => i.active).map(i => <option key={i.id} value={i.id}>{i.name}</option>)}
          </select>
        </BoField>
        <BoField label="Material type *">
          <select className="hub-input" value={materialType} onChange={e => setMaterialType(e.target.value)}>
            <option value="">— Select material —</option>
            {MATERIALS.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
        </BoField>
        <BoField label="Description *">
          <input className="hub-input" value={description} onChange={e => setDescription(e.target.value)}
            placeholder="e.g. Convocation certificates" />
        </BoField>
        <BoField label="Quantity *">
          <input type="number" min={1} className="hub-input" value={quantity}
            onChange={e => setQuantity(Math.max(1, Number(e.target.value) || 1))} />
        </BoField>
        <BoField label="Vendor">
          <select className="hub-input" value={vendorId} onChange={e => setVendorId(e.target.value)}>
            <option value="">— None —</option>
            {vendors.filter(v => v.active).map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
        </BoField>
        <BoField label="Expected delivery date">
          <input type="date" className="hub-input" value={expected} onChange={e => setExpected(e.target.value)} />
        </BoField>
      </div>
      <BoField label="Material image / proof" hint="Photos of what arrived. Multiple allowed.">
        <input type="file" accept="image/*" multiple className="text-xs"
          onChange={e => setFiles(e.target.files)} />
      </BoField>
      <BoField label="Remarks">
        <textarea className="hub-input" value={remarks} onChange={e => setRemarks(e.target.value)} />
      </BoField>
    </BoDialog>
  )
}
