import { useState } from 'react'
import { Store, Plus, Trash2 } from 'lucide-react'
import { boVendors, boAddVendor, boDeleteVendor, boUpdateVendor } from '@/lib/brandops-api'
import {
  BoPage, BoError, BoLoading, BoTable, BoRow, BoCell, BoButton, BoDialog, BoField,
  BoSearch, useBoData, useBoAction,
} from './ui'

export default function BoVendors() {
  const [q, setQ] = useState('')
  const [adding, setAdding] = useState(false)
  const { data, error, loading, refresh, setError } = useBoData(() => boVendors(), [])
  const { busy, act } = useBoAction(refresh, setError)

  const term = q.trim().toLowerCase()
  const list = (data?.vendors ?? []).filter(v =>
    !term || v.name.toLowerCase().includes(term) || v.phone.includes(term) || v.address.toLowerCase().includes(term))

  return (
    <BoPage title="Vendors" icon={Store} subtitle="The vendors who quote for and carry out branding work."
      actions={<BoButton onClick={() => setAdding(true)}><Plus className="w-3.5 h-3.5" /> Add vendor</BoButton>}>

      <div className="hub-card flex flex-wrap items-center gap-2">
        <BoSearch value={q} onChange={setQ} placeholder="Search name, phone or address…" />
        <span className="text-xs text-muted-foreground ml-auto">{list.length} vendor{list.length === 1 ? '' : 's'}</span>
      </div>

      <BoError message={error} />

      {loading ? <BoLoading /> : (
        <BoTable head={['Vendor', 'Phone', 'Address', 'Status', '']} empty="No vendors added yet.">
          {list.map(v => (
            <BoRow key={v.id}>
              <BoCell strong>{v.name}</BoCell>
              <BoCell nowrap>{v.phone}</BoCell>
              <BoCell>{v.address || '—'}</BoCell>
              <BoCell nowrap>
                <span className={`hub-badge ${v.active ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-600'}`}>
                  {v.active ? 'Active' : 'Inactive'}
                </span>
              </BoCell>
              <BoCell nowrap>
                <div className="flex gap-1.5">
                  <BoButton variant="ghost" disabled={busy}
                    onClick={() => void act(() => boUpdateVendor(v.id, { active: !v.active }))}>
                    {v.active ? 'Deactivate' : 'Activate'}
                  </BoButton>
                  <BoButton variant="danger" disabled={busy}
                    onClick={() => { if (confirm(`Delete ${v.name}?`)) void act(() => boDeleteVendor(v.id)) }}>
                    <Trash2 className="w-3 h-3" /> Delete
                  </BoButton>
                </div>
              </BoCell>
            </BoRow>
          ))}
        </BoTable>
      )}

      {adding && (
        <AddVendorDialog busy={busy} onClose={() => setAdding(false)}
          onSave={async v => { if (await act(() => boAddVendor(v))) setAdding(false) }} />
      )}
    </BoPage>
  )
}

function AddVendorDialog({ busy, onClose, onSave }: {
  busy: boolean; onClose: () => void
  onSave: (v: { name: string; phone: string; address: string }) => Promise<void>
}) {
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [address, setAddress] = useState('')
  return (
    <BoDialog title="Add vendor" onClose={onClose} footer={
      <>
        <BoButton variant="ghost" onClick={onClose}>Cancel</BoButton>
        <BoButton disabled={busy || !name.trim() || !phone.trim()}
          onClick={() => void onSave({ name: name.trim(), phone: phone.trim(), address: address.trim() })}>
          {busy ? 'Adding…' : 'Add vendor'}
        </BoButton>
      </>
    }>
      <BoField label="Vendor name *">
        <input className="hub-input" value={name} onChange={e => setName(e.target.value)} autoFocus
          placeholder="e.g. Shree Signage" />
      </BoField>
      <BoField label="Phone number *">
        <input className="hub-input" type="tel" value={phone} onChange={e => setPhone(e.target.value)} />
      </BoField>
      <BoField label="Address">
        <textarea className="hub-input" value={address} onChange={e => setAddress(e.target.value)} />
      </BoField>
    </BoDialog>
  )
}
