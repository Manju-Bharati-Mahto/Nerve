import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Boxes, Plus, Trash2 } from 'lucide-react'
import {
  boFrames, boAddFrame, boRetireFrame,
  FRAME_STATUS_STYLE, type FrameStatus,
} from '@/lib/brandops-api'
import {
  BoPage, BoError, BoLoading, BoBadge, BoTable, BoRow, BoCell, BoButton, BoDialog,
  BoField, BoSearch, BoSelect, useBoData, useBoAction,
} from './ui'

/**
 * The asset register. The whole reason this exists rather than a quantity
 * column: four 10x10 frames with two deployed is useless unless you know
 * which two, so every row is one physical object with its own ID.
 */
export default function BoFrames() {
  const [params, setParams] = useSearchParams()
  const [q, setQ] = useState(params.get('q') ?? '')
  const [status, setStatus] = useState<string>('')
  const [size, setSize] = useState('')
  const [adding, setAdding] = useState(false)

  const { data, error, loading, refresh, setError } = useBoData(
    () => boFrames({ q: q.trim() || undefined, status: (status || undefined) as FrameStatus | undefined, size: size || undefined }),
    [q, status, size])
  const { busy, act } = useBoAction(refresh, setError)

  function search(v: string) {
    setQ(v)
    if (v) params.set('q', v); else params.delete('q')
    setParams(params, { replace: true })
  }

  return (
    <BoPage title="Frame Inventory" icon={Boxes}
      subtitle="Every frame tracked individually, so you always know which one is where."
      actions={<BoButton onClick={() => setAdding(true)}><Plus className="w-3.5 h-3.5" /> Add frame</BoButton>}>

      <div className="hub-card flex flex-wrap items-center gap-2">
        <BoSearch value={q} onChange={search} placeholder="Search asset ID, size, location, institute or event…" />
        <BoSelect label="All statuses" value={status} onChange={setStatus}
          options={[['available', 'Available'], ['in_use', 'In Use']]} />
        <BoSelect label="All sizes" value={size} onChange={setSize}
          options={(data?.sizes ?? []).map(s => [s, s] as [string, string])} />
        <span className="text-xs text-muted-foreground ml-auto">
          {data ? `${data.frames.length} shown` : ''}
        </span>
      </div>

      <BoError message={error} />

      {loading ? <BoLoading /> : (
        <BoTable head={['Asset ID', 'Size', 'Status', 'Location', 'Institute', 'Event', 'Condition', '']}
          empty="No frames match.">
          {(data?.frames ?? []).map(f => (
            <BoRow key={f.id}>
              <BoCell strong nowrap>{f.asset_id}</BoCell>
              <BoCell nowrap>{f.size}</BoCell>
              <BoCell><BoBadge style={FRAME_STATUS_STYLE[f.status]} /></BoCell>
              <BoCell>{f.location}</BoCell>
              <BoCell>{f.institute_name ?? '—'}</BoCell>
              <BoCell>{f.event ?? '—'}</BoCell>
              <BoCell nowrap>{f.condition}</BoCell>
              <BoCell nowrap>
                {f.status === 'available' ? (
                  <BoButton variant="danger" disabled={busy}
                    onClick={() => { if (confirm(`Remove ${f.asset_id} from inventory? Its allocation history is kept.`)) void act(() => boRetireFrame(f.id)) }}>
                    <Trash2 className="w-3 h-3" /> Remove
                  </BoButton>
                ) : <span className="text-[11px] text-muted-foreground">In use</span>}
              </BoCell>
            </BoRow>
          ))}
        </BoTable>
      )}

      {adding && (
        <AddFrameDialog suggested={data?.next_asset_id ?? ''} busy={busy}
          onClose={() => setAdding(false)}
          onSave={async (f) => { if (await act(() => boAddFrame(f))) setAdding(false) }} />
      )}
    </BoPage>
  )
}

function AddFrameDialog({ suggested, busy, onClose, onSave }: {
  suggested: string; busy: boolean; onClose: () => void
  onSave: (f: { asset_id: string; size: string; location: string; condition: string }) => Promise<void>
}) {
  const [assetId, setAssetId] = useState(suggested)
  const [size, setSize] = useState('')
  const [location, setLocation] = useState('Store Room A')
  const [condition, setCondition] = useState('Good')

  return (
    <BoDialog title="Add frame" onClose={onClose} footer={
      <>
        <BoButton variant="ghost" onClick={onClose}>Cancel</BoButton>
        <BoButton disabled={busy || !size.trim()}
          onClick={() => void onSave({ asset_id: assetId.trim(), size: size.trim(), location, condition })}>
          {busy ? 'Adding…' : 'Add frame'}
        </BoButton>
      </>
    }>
      <BoField label="Asset ID" hint="Must be unique. The next free ID is filled in for you.">
        <input className="hub-input" value={assetId} onChange={e => setAssetId(e.target.value)} />
      </BoField>
      <BoField label="Frame size *" hint="e.g. 10x10, Box standy, T stands">
        <input className="hub-input" value={size} onChange={e => setSize(e.target.value)} autoFocus />
      </BoField>
      <BoField label="Storage location">
        <input className="hub-input" value={location} onChange={e => setLocation(e.target.value)} />
      </BoField>
      <BoField label="Condition">
        <input className="hub-input" value={condition} onChange={e => setCondition(e.target.value)} />
      </BoField>
    </BoDialog>
  )
}
