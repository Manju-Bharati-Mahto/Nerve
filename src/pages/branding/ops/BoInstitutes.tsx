import { useState } from 'react'
import { Building2, Plus, Trash2 } from 'lucide-react'
import { boInstitutes, boAddInstitute, boDeleteInstitute, boUpdateInstitute } from '@/lib/brandops-api'
import {
  BoPage, BoError, BoLoading, BoTable, BoRow, BoCell, BoButton, BoDialog, BoField,
  BoSearch, useBoData, useBoAction,
} from './ui'

/** The master list every other module's dropdown is drawn from. */
export default function BoInstitutes() {
  const [q, setQ] = useState('')
  const [adding, setAdding] = useState(false)
  const { data, error, loading, refresh, setError } = useBoData(() => boInstitutes(), [])
  const { busy, act } = useBoAction(refresh, setError)

  const term = q.trim().toLowerCase()
  const all = data?.institutes ?? []
  const list = all.filter(i => !term || i.name.toLowerCase().includes(term) || i.faculty.toLowerCase().includes(term))

  return (
    <BoPage title="Institutes" icon={Building2} subtitle="Institute master list and current frame holdings."
      actions={<BoButton onClick={() => setAdding(true)}><Plus className="w-3.5 h-3.5" /> Add institute</BoButton>}>

      <div className="hub-card flex flex-wrap items-center gap-2">
        <BoSearch value={q} onChange={setQ} placeholder="Search institute or faculty…" />
        <span className="text-xs text-muted-foreground ml-auto">
          {list.length} of {all.length} · {all.filter(i => i.frames_in_use > 0).length} holding frames
        </span>
      </div>

      <BoError message={error} />

      {loading ? <BoLoading /> : (
        <BoTable head={['Institute', 'Faculty', 'Frames in use', 'Status', '']} empty="No institute found.">
          {list.map(i => (
            <BoRow key={i.id}>
              <BoCell strong>{i.name}</BoCell>
              <BoCell>{i.faculty}</BoCell>
              <BoCell nowrap>
                <span className={i.frames_in_use > 0 ? 'text-[#0047AB] font-semibold' : ''}>{i.frames_in_use}</span>
              </BoCell>
              <BoCell nowrap>
                <span className={`hub-badge ${i.active ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-600'}`}>
                  {i.active ? 'Active' : 'Inactive'}
                </span>
              </BoCell>
              <BoCell nowrap>
                <div className="flex gap-1.5">
                  <BoButton variant="ghost" disabled={busy}
                    onClick={() => void act(() => boUpdateInstitute(i.id, { active: !i.active }))}>
                    {i.active ? 'Deactivate' : 'Activate'}
                  </BoButton>
                  <BoButton variant="danger" disabled={busy || i.frames_in_use > 0}
                    title={i.frames_in_use > 0 ? 'Receive its frames back first' : undefined}
                    onClick={() => { if (confirm(`Remove ${i.name} from the master list?`)) void act(() => boDeleteInstitute(i.id)) }}>
                    <Trash2 className="w-3 h-3" /> Remove
                  </BoButton>
                </div>
              </BoCell>
            </BoRow>
          ))}
        </BoTable>
      )}

      {adding && (
        <BoDialog title="Add institute" onClose={() => setAdding(false)}>
          <AddInstituteForm busy={busy} onClose={() => setAdding(false)}
            onSave={async (name, faculty) => { if (await act(() => boAddInstitute(name, faculty))) setAdding(false) }} />
        </BoDialog>
      )}
    </BoPage>
  )
}

function AddInstituteForm({ busy, onClose, onSave }: {
  busy: boolean; onClose: () => void; onSave: (name: string, faculty: string) => Promise<void>
}) {
  const [name, setName] = useState('')
  const [faculty, setFaculty] = useState('')
  return (
    <>
      <BoField label="Institute name *">
        <input className="hub-input" value={name} onChange={e => setName(e.target.value)} autoFocus />
      </BoField>
      <BoField label="Faculty / department" hint="Defaults to Parul University if left blank.">
        <input className="hub-input" value={faculty} onChange={e => setFaculty(e.target.value)} />
      </BoField>
      <div className="flex justify-end gap-2 pt-2">
        <BoButton variant="ghost" onClick={onClose}>Cancel</BoButton>
        <BoButton disabled={busy || !name.trim()} onClick={() => void onSave(name.trim(), faculty.trim())}>
          {busy ? 'Adding…' : 'Add institute'}
        </BoButton>
      </div>
    </>
  )
}
