import { useState } from 'react'
import { Undo2 } from 'lucide-react'
import { boAllocations, boReturnFrame, boIsOverdue } from '@/lib/brandops-api'
import {
  BoPage, BoError, BoLoading, BoEmpty, BoButton, BoField, BoDialog, useBoData, useBoAction,
} from './ui'
import type { Allocation } from '@/lib/brandops-api'

/** Receiving a frame back puts it straight into Available and records its condition. */
export default function BoReturn() {
  const { data, error, loading, refresh, setError } = useBoData(() => boAllocations({ open: true }), [])
  const { busy, act } = useBoAction(refresh, setError)
  const [receiving, setReceiving] = useState<Allocation | null>(null)
  const list = data?.allocations ?? []

  return (
    <BoPage title="Frame Return / Receive" icon={Undo2}
      subtitle="When a deployed frame comes back, receive that exact asset here.">
      <BoError message={error} />

      {loading ? <BoLoading /> : list.length === 0 ? (
        <BoEmpty>Nothing is out on loan — every frame is in store.</BoEmpty>
      ) : (
        <div className="space-y-2">
          {list.map(a => {
            const late = boIsOverdue(a.until_date)
            return (
              <div key={a.id} className={`hub-card flex items-center justify-between gap-4 flex-wrap ${late ? 'border-rose-300 bg-rose-50/40' : ''}`}>
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground">
                    {a.asset_id} <span className="text-muted-foreground font-normal">· {a.size}</span>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {a.institute_name} · {a.location} · due {a.until_date}
                    {late && <span className="text-rose-600 font-medium"> · overdue</span>}
                  </p>
                </div>
                <BoButton variant="success" onClick={() => setReceiving(a)}>Receive back</BoButton>
              </div>
            )
          })}
        </div>
      )}

      {receiving && (
        <ReceiveDialog allocation={receiving} busy={busy} onClose={() => setReceiving(null)}
          onSave={async (payload) => {
            if (await act(() => boReturnFrame(receiving.frame_id, payload))) setReceiving(null)
          }} />
      )}
    </BoPage>
  )
}

function ReceiveDialog({ allocation, busy, onClose, onSave }: {
  allocation: Allocation; busy: boolean; onClose: () => void
  onSave: (p: { condition: string; location: string; remarks: string }) => Promise<void>
}) {
  const [condition, setCondition] = useState('Good')
  const [location, setLocation] = useState('Store Room A')
  const [remarks, setRemarks] = useState('')

  return (
    <BoDialog title={`Receive ${allocation.asset_id}`} onClose={onClose} footer={
      <>
        <BoButton variant="ghost" onClick={onClose}>Cancel</BoButton>
        <BoButton variant="success" disabled={busy}
          onClick={() => void onSave({ condition, location, remarks })}>
          {busy ? 'Saving…' : 'Receive frame'}
        </BoButton>
      </>
    }>
      <p className="text-xs text-muted-foreground">
        Coming back from <b className="text-foreground">{allocation.institute_name}</b> ({allocation.location}),
        out since {allocation.from_date}.
      </p>
      <BoField label="Condition" hint="Good / Damaged / Needs repair — recorded against the frame.">
        <input className="hub-input" value={condition} onChange={e => setCondition(e.target.value)} />
      </BoField>
      <BoField label="Storage location">
        <input className="hub-input" value={location} onChange={e => setLocation(e.target.value)} />
      </BoField>
      <BoField label="Return remarks">
        <textarea className="hub-input" value={remarks} onChange={e => setRemarks(e.target.value)} />
      </BoField>
    </BoDialog>
  )
}
