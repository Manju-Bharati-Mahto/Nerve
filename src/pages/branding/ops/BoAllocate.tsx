import { useState } from 'react'
import { ArrowLeftRight } from 'lucide-react'
import { boFrames, boInstitutes, boAllocations, boAllocate, boToday } from '@/lib/brandops-api'
import {
  BoPage, BoError, BoLoading, BoTable, BoRow, BoCell, BoButton, BoField, useBoData, useBoAction,
} from './ui'

/**
 * §"Select the exact available frame": the dropdown lists individual asset
 * IDs, not sizes, because several identical frames may exist and picking
 * "10x10" would not say which one left the store.
 */
export default function BoAllocate() {
  const { data, error, loading, refresh, setError } = useBoData(async () => {
    const [frames, institutes, history] = await Promise.all([
      boFrames({ status: 'available' }), boInstitutes(), boAllocations(),
    ])
    return { frames: frames.frames, institutes: institutes.institutes, history: history.allocations }
  }, [])
  const { busy, act } = useBoAction(refresh, setError)

  const [frameId, setFrameId] = useState('')
  const [instituteId, setInstituteId] = useState('')
  const [location, setLocation] = useState('')
  const [event, setEvent] = useState('')
  const [from, setFrom] = useState(boToday())
  const [until, setUntil] = useState('')

  async function submit() {
    const ok = await act(() => boAllocate({
      frame_id: frameId, institute_id: instituteId, location, event,
      from_date: from, until_date: until,
    }))
    if (ok) { setFrameId(''); setLocation(''); setEvent(''); setUntil('') }
  }

  if (loading) return <BoLoading />

  const available = data?.frames ?? []
  const ready = frameId && instituteId && location.trim() && from && until

  return (
    <BoPage title="Allocate / Move Frame" icon={ArrowLeftRight}
      subtitle="Send a specific frame out to an institute, and record when it is due back.">

      <div className="hub-card bg-blue-50 border-blue-200 text-xs text-blue-900">
        Pick the <b>exact asset ID</b>. Choosing only a size isn't enough — several identical
        frames exist, and the register has to know which one physically left the store.
      </div>

      <BoError message={error} />

      <div className="hub-card grid grid-cols-1 md:grid-cols-3 gap-3">
        <BoField label="Available frame *">
          <select className="hub-input" value={frameId} onChange={e => setFrameId(e.target.value)}>
            <option value="">{available.length ? `— Pick one of ${available.length} —` : 'No frames available'}</option>
            {available.map(f => (
              <option key={f.id} value={f.id}>{f.asset_id} — {f.size} — {f.location}</option>
            ))}
          </select>
        </BoField>
        <BoField label="Institute *">
          <select className="hub-input" value={instituteId} onChange={e => setInstituteId(e.target.value)}>
            <option value="">— Select institute —</option>
            {(data?.institutes ?? []).filter(i => i.active).map(i => (
              <option key={i.id} value={i.id}>{i.name}</option>
            ))}
          </select>
        </BoField>
        <BoField label="Exact location *" hint="Where on campus it will stand">
          <input className="hub-input" value={location} onChange={e => setLocation(e.target.value)}
            placeholder="e.g. Main Gate, Block A foyer" />
        </BoField>
        <BoField label="Event / purpose">
          <input className="hub-input" value={event} onChange={e => setEvent(e.target.value)}
            placeholder="e.g. Orientation 2026" />
        </BoField>
        <BoField label="From *">
          <input type="date" className="hub-input" value={from} onChange={e => setFrom(e.target.value)} />
        </BoField>
        <BoField label="Until *" hint="When it should come back. Overdue frames are flagged.">
          <input type="date" className="hub-input" value={until} onChange={e => setUntil(e.target.value)} />
        </BoField>
        <div className="md:col-span-3">
          <BoButton disabled={busy || !ready} onClick={submit}>
            {busy ? 'Allocating…' : 'Allocate frame'}
          </BoButton>
        </div>
      </div>

      <div>
        <h2 className="text-[11px] uppercase tracking-widest text-muted-foreground mb-2">Movement history</h2>
        <BoTable head={['When', 'Asset', 'Size', 'Institute', 'Location', 'Event', 'Period', 'Returned']}
          empty="No movements recorded yet.">
          {(data?.history ?? []).map(a => (
            <BoRow key={a.id}>
              <BoCell nowrap>{new Date(a.allocated_at).toLocaleDateString()}</BoCell>
              <BoCell strong nowrap>{a.asset_id}</BoCell>
              <BoCell nowrap>{a.size}</BoCell>
              <BoCell>{a.institute_name}</BoCell>
              <BoCell>{a.location}</BoCell>
              <BoCell>{a.event || '—'}</BoCell>
              <BoCell nowrap>{a.from_date} → {a.until_date}</BoCell>
              <BoCell nowrap>
                {a.returned_at
                  ? <span className="text-emerald-700">{new Date(a.returned_at).toLocaleDateString()}</span>
                  : <span className="text-rose-600">Still out</span>}
              </BoCell>
            </BoRow>
          ))}
        </BoTable>
      </div>
    </BoPage>
  )
}
