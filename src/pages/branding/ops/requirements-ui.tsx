/**
 * Requirement and quotation pieces shared by Branding Requests, Quotations
 * and the Dashboard.
 *
 * A requirement shows up on all three, and the branding team asked for the
 * same things wherever it appears — its size, its quotation amounts behind an
 * ⓘ, and a way to remove it — so each piece is written once here and used by
 * every page, rather than three copies drifting apart.
 */
import { useEffect, useMemo, useState } from 'react'
import { Info, History, Trash2, CheckCircle2 } from 'lucide-react'
import {
  boRequestQuotations, boMoney,
  PRIORITY_STYLE, QUOTE_STATUS_STYLE, REQUEST_STATUS_STYLE,
  type BrandingRequest, type Institute, type Priority, type QuotationWithHistory, type RequestForm,
} from '@/lib/brandops-api'
import { BoBadge, BoButton, BoDialog, BoError, BoField, BoLoading } from './ui'
import { WORK_TYPES, emptyRequestForm, requestFormOf, requestFormReady } from './requirements'

// ── Size ───────────────────────────────────────────────────────────────────

/**
 * A size, typed freely, with every size used before offered as a suggestion.
 * The team asked to be able to enter a new size — so this never restricts to
 * the list, it only saves retyping one that exists.
 */
export function SizeInput({ value, onChange, suggestions, id = 'bo-size-options' }: {
  value: string; onChange: (v: string) => void; suggestions: string[]; id?: string
}) {
  return (
    <>
      <input className="hub-input" list={id} value={value} onChange={e => onChange(e.target.value)}
        placeholder="e.g. 10x10, 6x3 ft, or any new size" />
      <datalist id={id}>
        {suggestions.map(s => <option key={s} value={s} />)}
      </datalist>
    </>
  )
}

// ── The requirement form (new and edit) ────────────────────────────────────

/** The requirement's fields. Used by the requirement dialog and inline by Add Quotation. */
export function RequestFields({ form, onChange, institutes, sizes, compact }: {
  form: RequestForm; onChange: (f: RequestForm) => void
  institutes: Pick<Institute, 'id' | 'name' | 'active'>[]; sizes: string[]
  /** Only what a quotation needs to create its requirement. */
  compact?: boolean
}) {
  const set = <K extends keyof RequestForm>(k: K, v: RequestForm[K]) => onChange({ ...form, [k]: v })
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      <BoField label="Institute *">
        <select className="hub-input" value={form.institute_id} onChange={e => set('institute_id', e.target.value)}>
          <option value="">— Select institute —</option>
          {institutes.filter(i => i.active || i.id === form.institute_id).map(i => (
            <option key={i.id} value={i.id}>{i.name}</option>
          ))}
        </select>
      </BoField>
      <BoField label="Required date *">
        <input type="date" className="hub-input" value={form.required_date}
          onChange={e => set('required_date', e.target.value)} />
      </BoField>
      <BoField label="Work type *">
        <select className="hub-input" value={form.work_type} onChange={e => set('work_type', e.target.value)}>
          <option value="">— Select work type —</option>
          {/* An older requirement may carry a work type no longer offered; keep it selectable. */}
          {[...WORK_TYPES, ...(form.work_type && !WORK_TYPES.includes(form.work_type) ? [form.work_type] : [])]
            .map(w => <option key={w} value={w}>{w}</option>)}
        </select>
      </BoField>
      <BoField label="Size" hint="Pick a size or type a new one.">
        <SizeInput value={form.size} onChange={v => set('size', v)} suggestions={sizes} />
      </BoField>
      {!compact && (
        <>
          <BoField label="Priority">
            <select className="hub-input" value={form.priority} onChange={e => set('priority', e.target.value as Priority)}>
              {Object.entries(PRIORITY_STYLE).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
          </BoField>
          <BoField label="Quantity">
            <input type="number" min={1} className="hub-input" value={form.quantity}
              onChange={e => set('quantity', Math.max(1, Number(e.target.value) || 1))} />
          </BoField>
          <BoField label="Location">
            <input className="hub-input" value={form.location} onChange={e => set('location', e.target.value)}
              placeholder="e.g. Main Gate / Block A / Auditorium" />
          </BoField>
        </>
      )}
    </div>
  )
}

/** New requirement, or edit an existing one. */
export function RequestDialog({ initial, institutes, sizes, busy, onClose, onSave }: {
  /** Absent for a new requirement. */
  initial?: BrandingRequest
  institutes: Pick<Institute, 'id' | 'name' | 'active'>[]; sizes: string[]
  busy: boolean; onClose: () => void; onSave: (f: RequestForm) => Promise<void>
}) {
  const [form, setForm] = useState<RequestForm>(() => initial ? requestFormOf(initial) : emptyRequestForm())
  const ready = requestFormReady(form)
  return (
    <BoDialog title={initial ? `Edit ${initial.reference}` : 'New branding requirement'} onClose={onClose} wide footer={
      <>
        <BoButton variant="ghost" onClick={onClose}>Cancel</BoButton>
        <BoButton disabled={busy || !ready} onClick={() => void onSave({
          ...form, description: form.description.trim(), location: form.location.trim(), size: form.size.trim(),
        })}>{busy ? 'Saving…' : initial ? 'Save changes' : 'Create requirement'}</BoButton>
      </>
    }>
      {!initial && <p className="text-xs text-muted-foreground">The reference number is generated for you.</p>}
      <RequestFields form={form} onChange={setForm} institutes={institutes} sizes={sizes} />
      <BoField label="Work / branding description *">
        <textarea className="hub-input" value={form.description}
          onChange={e => setForm({ ...form, description: e.target.value })}
          placeholder="Describe what branding work is required…" />
      </BoField>
    </BoDialog>
  )
}

// ── Remove and complete ────────────────────────────────────────────────────

/**
 * Confirms removing a requirement. Says plainly that it goes from both Branding
 * Requests and the Dashboard, and that it is kept on record — "remove" on its
 * own would suggest the history goes too.
 */
export function RemoveRequestDialog({ request, busy, onClose, onConfirm }: {
  request: Pick<BrandingRequest, 'reference' | 'work_type' | 'institute_name' | 'quote_count'>
  busy: boolean; onClose: () => void; onConfirm: (reason: string) => Promise<void>
}) {
  const [reason, setReason] = useState('')
  return (
    <BoDialog title={`Remove ${request.reference}?`} onClose={onClose} footer={
      <>
        <BoButton variant="ghost" onClick={onClose}>Cancel</BoButton>
        <BoButton variant="danger" disabled={busy} onClick={() => void onConfirm(reason.trim())}>
          <Trash2 className="w-3.5 h-3.5" /> {busy ? 'Removing…' : 'Remove requirement'}
        </BoButton>
      </>
    }>
      <p className="text-sm text-foreground">
        {request.work_type} for {request.institute_name}.
      </p>
      <p className="text-xs text-muted-foreground">
        It will disappear from Branding Requests and the Dashboard
        {request.quote_count > 0 && <>, and its {request.quote_count} quotation{request.quote_count === 1 ? '' : 's'} from Quotations and Approvals</>}.
        Nothing is deleted: it stays on record in the Activity Log.
      </p>
      <BoField label="Reason (optional)">
        <input className="hub-input" value={reason} onChange={e => setReason(e.target.value)}
          placeholder="e.g. Duplicate of REQ-0012, or no longer needed" />
      </BoField>
    </BoDialog>
  )
}

/** Confirms marking a requirement Completed — the work is finished. */
export function CompleteRequestDialog({ request, busy, onClose, onConfirm }: {
  request: Pick<BrandingRequest, 'reference' | 'work_type' | 'institute_name'>
  busy: boolean; onClose: () => void; onConfirm: (note: string) => Promise<void>
}) {
  const [note, setNote] = useState('')
  return (
    <BoDialog title={`Mark ${request.reference} completed?`} onClose={onClose} footer={
      <>
        <BoButton variant="ghost" onClick={onClose}>Cancel</BoButton>
        <BoButton variant="success" disabled={busy} onClick={() => void onConfirm(note.trim())}>
          <CheckCircle2 className="w-3.5 h-3.5" /> {busy ? 'Saving…' : 'Mark completed'}
        </BoButton>
      </>
    }>
      <p className="text-sm text-foreground">{request.work_type} for {request.institute_name}.</p>
      <p className="text-xs text-muted-foreground">
        It leaves the Dashboard's outstanding work. If it was marked by mistake, it can be reopened.
      </p>
      <BoField label="Note (optional)">
        <input className="hub-input" value={note} onChange={e => setNote(e.target.value)}
          placeholder="e.g. Installed and checked on site" />
      </BoField>
    </BoDialog>
  )
}

// ── Quotation amounts and history ──────────────────────────────────────────

/**
 * The figure a requirement's row shows: the approved price once there is one,
 * otherwise the cheapest quotation still standing.
 */
export function QuoteAmount({ approved, lowest, count }: {
  approved: string | null; lowest: string | null; count: number
}) {
  if (count === 0) return <span className="text-muted-foreground">No quotes</span>
  if (approved) return <span className="text-emerald-700 font-medium">{boMoney(approved)} <span className="text-[10px] font-normal">approved</span></span>
  return (
    <span>
      {lowest ? <>{boMoney(lowest)} <span className="text-[10px] text-muted-foreground">lowest of {count}</span></> : `${count} quote${count === 1 ? '' : 's'}`}
    </span>
  )
}

/** The ⓘ that opens a requirement's quotation details. */
export function QuoteInfoButton({ onClick, title = 'Quotation details' }: { onClick: () => void; title?: string }) {
  return (
    <button type="button" onClick={onClick} title={title} aria-label={title}
      className="inline-flex items-center justify-center w-5 h-5 rounded-full text-[#0047AB] hover:bg-blue-50 align-middle">
      <Info className="w-3.5 h-3.5" />
    </button>
  )
}

/**
 * Every quotation a requirement has had, side by side — the ⓘ view, and the
 * comparison the team asked for: each vendor's price against the lowest, and
 * every earlier price a quotation carried before it was edited. Removed
 * quotations are kept and can be shown, so an old offer can still be
 * compared with a new one.
 */
export function QuotationHistoryDialog({ requestId, onClose }: { requestId: string; onClose: () => void }) {
  const [data, setData] = useState<{ request: BrandingRequest | null; quotations: QuotationWithHistory[] } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showRemoved, setShowRemoved] = useState(false)
  const [open, setOpen] = useState<Record<string, boolean>>({})

  useEffect(() => {
    let live = true
    boRequestQuotations(requestId)
      .then(d => { if (live) setData(d) })
      .catch(err => { if (live) setError(err instanceof Error ? err.message : 'Could not load the quotations.') })
    return () => { live = false }
  }, [requestId])

  const shown = useMemo(
    () => (data?.quotations ?? []).filter(q => showRemoved || !q.removed_at),
    [data, showRemoved],
  )
  const removedCount = (data?.quotations ?? []).filter(q => q.removed_at).length
  // "Lowest" compares quotations still in play: not removed, not rejected.
  const lowest = useMemo(() => {
    const live = (data?.quotations ?? []).filter(q => !q.removed_at && q.status !== 'rejected').map(q => Number(q.amount))
    return live.length ? Math.min(...live) : null
  }, [data])

  const r = data?.request
  return (
    <BoDialog title={r ? `Quotations — ${r.reference}` : 'Quotations'} onClose={onClose} wide footer={
      <BoButton variant="ghost" onClick={onClose}>Close</BoButton>
    }>
      <BoError message={error} />
      {!data && !error && <BoLoading />}
      {r && (
        <div className="text-xs text-muted-foreground flex flex-wrap gap-x-4 gap-y-1">
          <span><b className="text-foreground">{r.work_type}</b> · {r.institute_name}</span>
          {r.size && <span>Size: <b className="text-foreground">{r.size}</b></span>}
          <span>Qty {r.quantity}</span>
          <span>Required {r.required_date}</span>
          <BoBadge style={REQUEST_STATUS_STYLE[r.status]} />
        </div>
      )}
      {data && (
        data.quotations.length === 0 ? (
          <p className="text-sm text-muted-foreground py-6 text-center">No quotations recorded for this requirement yet.</p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[10px] uppercase tracking-widest text-muted-foreground border-b border-border">
                    <th className="py-2 pr-3 font-medium">Vendor</th>
                    <th className="py-2 pr-3 font-medium">Amount</th>
                    <th className="py-2 pr-3 font-medium">vs lowest</th>
                    <th className="py-2 pr-3 font-medium">Quoted</th>
                    <th className="py-2 pr-3 font-medium">Status</th>
                    <th className="py-2 pr-3 font-medium">Changes</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map(q => {
                    const amount = Number(q.amount)
                    const diff = lowest === null || q.removed_at || q.status === 'rejected' ? null : amount - lowest
                    return (
                      <QuoteRows key={q.id} q={q} diff={diff} isLowest={diff === 0}
                        open={!!open[q.id]} onToggle={() => setOpen(o => ({ ...o, [q.id]: !o[q.id] }))} />
                    )
                  })}
                </tbody>
              </table>
            </div>
            {removedCount > 0 && (
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <input type="checkbox" checked={showRemoved} onChange={e => setShowRemoved(e.target.checked)} />
                Show {removedCount} removed quotation{removedCount === 1 ? '' : 's'}
              </label>
            )}
          </>
        )
      )}
    </BoDialog>
  )
}

function QuoteRows({ q, diff, isLowest, open, onToggle }: {
  q: QuotationWithHistory; diff: number | null; isLowest: boolean; open: boolean; onToggle: () => void
}) {
  return (
    <>
      <tr className={`border-b border-border/60 align-top ${q.removed_at ? 'opacity-50' : ''}`}>
        <td className="py-2 pr-3">
          <div className="font-medium text-foreground">{q.vendor_name}</div>
          <div className="text-[11px] text-muted-foreground">{q.reference}{q.removed_at && ' · removed'}</div>
        </td>
        <td className="py-2 pr-3 whitespace-nowrap font-medium">
          {boMoney(q.amount)}
          {isLowest && <span className="ml-1.5 text-[10px] text-emerald-700 font-normal">lowest</span>}
        </td>
        <td className="py-2 pr-3 whitespace-nowrap text-xs text-muted-foreground">
          {diff === null ? '—' : diff === 0 ? '—' : `+${boMoney(String(diff))}`}
        </td>
        <td className="py-2 pr-3 whitespace-nowrap text-xs">{q.quote_date}</td>
        <td className="py-2 pr-3"><BoBadge style={QUOTE_STATUS_STYLE[q.status]} /></td>
        <td className="py-2 pr-3 text-xs">
          {q.revisions.length ? (
            <button type="button" onClick={onToggle}
              className="inline-flex items-center gap-1 text-[#0047AB] hover:underline">
              <History className="w-3 h-3" /> {q.revisions.length} earlier version{q.revisions.length === 1 ? '' : 's'}
            </button>
          ) : <span className="text-muted-foreground">Original</span>}
        </td>
      </tr>
      {(q.notes || q.decision_note || q.removal_reason) && (
        <tr className={q.removed_at ? 'opacity-50' : ''}>
          <td colSpan={6} className="pb-2 pr-3 text-[11px] text-muted-foreground">
            {q.notes && <div>Notes: {q.notes}</div>}
            {q.decision_note && <div>Decision: {q.decision_note}</div>}
            {q.removal_reason && <div>Removed: {q.removal_reason}</div>}
          </td>
        </tr>
      )}
      {open && q.revisions.map(rev => (
        <tr key={rev.revision} className="bg-muted/40 text-xs">
          <td className="py-1.5 pr-3 pl-3 text-muted-foreground">
            v{rev.revision} · {rev.vendor_name}
          </td>
          <td className="py-1.5 pr-3 whitespace-nowrap line-through text-muted-foreground">{boMoney(rev.amount)}</td>
          <td className="py-1.5 pr-3 whitespace-nowrap text-muted-foreground">
            {(() => {
              const change = Number(q.amount) - Number(rev.amount)
              return change === 0 ? 'same price' : `${change < 0 ? '−' : '+'}${boMoney(String(Math.abs(change)))} now`
            })()}
          </td>
          <td className="py-1.5 pr-3 whitespace-nowrap">{rev.quote_date}</td>
          <td colSpan={2} className="py-1.5 pr-3 text-muted-foreground">
            Replaced {new Date(rev.replaced_at).toLocaleDateString()}{rev.replaced_by_name ? ` by ${rev.replaced_by_name}` : ''}
            {rev.notes && <div>Notes then: {rev.notes}</div>}
          </td>
        </tr>
      ))}
    </>
  )
}
