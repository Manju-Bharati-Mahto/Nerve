import { useState } from 'react'
import { Camera, Upload, Trash2, CheckCircle2 } from 'lucide-react'
import {
  boCompletion, boWorkOrder, boUploadPhotos, boDeletePhoto, boSetWorkOrderStatus,
  WO_STATUS_STYLE, WO_NEXT, boWhen, type WorkOrder, type WorkPhoto, type PhotoPhase,
} from '@/lib/brandops-api'
import {
  BoPage, BoError, BoLoading, BoEmpty, BoBadge, BoButton, BoDialog, BoField,
  useBoData, useBoAction,
} from './ui'

const PHASES: PhotoPhase[] = ['before', 'during', 'after']

/**
 * §"vendor uploads before/during/after photos and internal team verifies".
 * Verification is blocked server-side until at least one photo exists, so the
 * Verify button here is disabled rather than failing on click.
 */
export default function BoCompletion() {
  const { data, error, loading, refresh, setError } = useBoData(() => boCompletion(), [])
  const [open, setOpen] = useState<WorkOrder | null>(null)

  const orders = data?.work_orders ?? []

  return (
    <BoPage title="Work Completion & Photos" icon={Camera}
      subtitle="Before / during / after evidence, then verification and close.">
      <div className="hub-card bg-blue-50 border-blue-200 text-xs text-blue-900">
        Status flow: Assigned → Vendor Checked In → Work Started → Work Completed → Photos Uploaded →
        Verified → Closed. A work order can't be verified until it has at least one photo.
      </div>

      <BoError message={error} />

      {loading ? <BoLoading /> : orders.length === 0 ? (
        <BoEmpty>No open work orders.</BoEmpty>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          {orders.map(w => (
            <div key={w.id} className="hub-card">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground">{w.reference} · {w.vendor_name}</p>
                  <p className="text-xs text-muted-foreground">{w.institute_name} · {w.description || 'No description'}</p>
                </div>
                <BoBadge style={WO_STATUS_STYLE[w.status]} />
              </div>
              <div className="flex items-center justify-between gap-2 mt-3 flex-wrap">
                <span className="text-xs text-muted-foreground">
                  {w.photo_count} photo{w.photo_count === 1 ? '' : 's'}
                </span>
                <BoButton variant="ghost" onClick={() => setOpen(w)}>
                  <Camera className="w-3.5 h-3.5" /> Photos & verification
                </BoButton>
              </div>
            </div>
          ))}
        </div>
      )}

      {open && (
        <PhotoDialog workOrder={open} onClose={() => setOpen(null)}
          onChanged={refresh} setError={setError} />
      )}
    </BoPage>
  )
}

function PhotoDialog({ workOrder, onClose, onChanged, setError }: {
  workOrder: WorkOrder; onClose: () => void
  onChanged: () => Promise<void>; setError: (m: string | null) => void
}) {
  const { data, refresh } = useBoData(() => boWorkOrder(workOrder.id), [workOrder.id])
  const { busy, act } = useBoAction(async () => { await refresh(); await onChanged() }, setError)
  const [phase, setPhase] = useState<PhotoPhase>('after')
  const [files, setFiles] = useState<FileList | null>(null)
  const [localError, setLocalError] = useState<string | null>(null)

  const wo = data?.work_order ?? workOrder
  const photos = data?.photos ?? []

  async function upload() {
    if (!files?.length) return
    const form = new FormData()
    form.append('phase', phase)
    for (const f of Array.from(files)) form.append('photos', f)
    setLocalError(null)
    try {
      await boUploadPhotos(wo.id, form)
      setFiles(null)
      await refresh(); await onChanged()
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Upload failed.')
    }
  }

  const canVerify = WO_NEXT[wo.status].includes('verified')

  return (
    <BoDialog title={`${wo.reference} — ${wo.vendor_name}`} onClose={onClose} wide footer={
      <>
        <BoButton variant="ghost" onClick={onClose}>Close</BoButton>
        {WO_NEXT[wo.status].map(next => (
          <BoButton key={next} variant={next === 'verified' ? 'success' : 'primary'}
            disabled={busy || (next === 'verified' && photos.length === 0)}
            onClick={() => void act(() => boSetWorkOrderStatus(wo.id, next))}>
            <CheckCircle2 className="w-3.5 h-3.5" /> {WO_STATUS_STYLE[next].label}
          </BoButton>
        ))}
      </>
    }>
      <div className="flex items-center gap-2 flex-wrap text-xs text-muted-foreground">
        <BoBadge style={WO_STATUS_STYLE[wo.status]} />
        <span>{wo.institute_name}</span>
        <span>· assigned {wo.assigned_date}</span>
        {wo.verified_at && <span>· verified {boWhen(wo.verified_at)}</span>}
      </div>

      {canVerify && photos.length === 0 && (
        <div className="hub-card bg-amber-50 border-amber-200 text-xs text-amber-900">
          Upload at least one photo before verifying — the evidence is the point of this step.
        </div>
      )}

      <div className="hub-card space-y-2">
        <div className="flex items-end gap-2 flex-wrap">
          <BoField label="Phase">
            <select className="hub-input py-1.5 text-xs w-auto" value={phase}
              onChange={e => setPhase(e.target.value as PhotoPhase)}>
              {PHASES.map(p => <option key={p} value={p}>{p[0].toUpperCase() + p.slice(1)}</option>)}
            </select>
          </BoField>
          <input type="file" accept="image/*" multiple className="text-xs"
            onChange={e => setFiles(e.target.files)} />
          <BoButton disabled={!files?.length} onClick={upload}>
            <Upload className="w-3.5 h-3.5" /> Upload
          </BoButton>
        </div>
        {localError && <p className="text-xs text-rose-600">{localError}</p>}
      </div>

      {PHASES.map(p => {
        const inPhase = photos.filter(ph => ph.phase === p)
        if (!inPhase.length) return null
        return (
          <div key={p}>
            <p className="text-[11px] uppercase tracking-widest text-muted-foreground mb-1.5">{p}</p>
            <div className="flex flex-wrap gap-2">
              {inPhase.map(ph => <PhotoThumb key={ph.id} photo={ph} busy={busy}
                onDelete={() => void act(() => boDeletePhoto(ph.id))} />)}
            </div>
          </div>
        )
      })}
      {photos.length === 0 && (
        <p className="text-xs text-muted-foreground text-center py-4">No photos uploaded yet.</p>
      )}
    </BoDialog>
  )
}

function PhotoThumb({ photo, busy, onDelete }: { photo: WorkPhoto; busy: boolean; onDelete: () => void }) {
  return (
    <div className="relative group">
      <a href={photo.file_path} target="_blank" rel="noreferrer">
        <img src={photo.file_path} alt={photo.original_name}
          className="w-24 h-24 object-cover rounded-lg border border-border" />
      </a>
      <button onClick={onDelete} disabled={busy}
        className="absolute top-1 right-1 p-1 rounded-md bg-white/90 border border-rose-200 text-rose-600 opacity-0 group-hover:opacity-100 transition-opacity disabled:opacity-40"
        title="Remove photo">
        <Trash2 className="w-3 h-3" />
      </button>
    </div>
  )
}
