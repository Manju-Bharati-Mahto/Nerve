import { useMemo, useState } from 'react'
import { IndianRupee, Plus, Pencil, Trash2, X } from 'lucide-react'
import {
  boQuotations, boAddQuotation, boUpdateQuotation, boRemoveQuotation, boRequests, boVendors,
  boInstitutes, boToday, boMoney, QUOTE_STATUS_STYLE, REQUEST_STATUS_STYLE,
  type BrandingRequest, type Institute, type Quotation, type QuoteStatus, type RequestForm, type Vendor,
} from '@/lib/brandops-api'
import {
  BoPage, BoError, BoLoading, BoBadge, BoTable, BoCell, BoButton, BoDialog,
  BoField, BoSelect, useBoData, useBoAction, useBoAccess,
} from './ui'
import { RequestFields, QuoteInfoButton, QuotationHistoryDialog } from './requirements-ui'
import { emptyRequestForm, requestFormReady } from './requirements'

type AddQuotation = Parameters<typeof boAddQuotation>[0]

/** Requirements that are finished one way or another can't take new quotations. */
const UNQUOTABLE = ['closed', 'rejected', 'completed']

const APPROVED_LOCKED = 'Approved quotations are locked — the decision was made on that figure.'

/**
 * Recording what vendors have quoted. Choosing between them is Approvals.
 *
 * Every quotation is kept: an edit saves the version it replaces and a
 * removal only hides it, so the ⓘ on any row can lay the old prices beside
 * the new ones.
 */
export default function BoQuotations() {
  const [status, setStatus] = useState('')
  const [showRemoved, setShowRemoved] = useState(false)
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<Quotation | null>(null)
  const [removing, setRemoving] = useState<Quotation | null>(null)
  const [history, setHistory] = useState<string | null>(null)
  const { can } = useBoAccess()
  const canEdit = can('brandops:quotations')

  const { data, error, loading, refresh, setError } = useBoData(async () => {
    const [quotations, requests, vendors, institutes] = await Promise.all([
      boQuotations({
        status: (status || undefined) as QuoteStatus | undefined,
        include_removed: showRemoved ? '1' : undefined,
      }),
      /* The requirement list is readable from Quotations, but if it can't be
         read for any reason a new requirement can still be typed — so a failed
         list must not take the whole page down with it. */
      boRequests().catch(() => null),
      boVendors(), boInstitutes(),
    ])
    return {
      quotations: quotations.quotations,
      requests: requests?.requests ?? null, sizes: requests?.sizes ?? [],
      vendors: vendors.vendors, institutes: institutes.institutes,
    }
  }, [status, showRemoved])
  const { busy, act } = useBoAction(refresh, setError)

  const quotable = useMemo(
    () => (data?.requests ?? []).filter(r => !UNQUOTABLE.includes(r.status)),
    [data],
  )
  const quotations = data?.quotations ?? []
  const removedCount = quotations.filter(q => q.removed_at).length
  const standing = quotations.length - removedCount

  return (
    <BoPage title="Quotations" icon={IndianRupee}
      subtitle="What each vendor has quoted against a requirement."
      // Never disabled for want of requirements: a new one can be typed in.
      actions={canEdit && <BoButton onClick={() => setAdding(true)} disabled={!data}>
        <Plus className="w-3.5 h-3.5" /> Add quotation
      </BoButton>}>

      <div className="hub-card flex flex-wrap items-center gap-2">
        <BoSelect label="All statuses" value={status} onChange={setStatus}
          options={Object.entries(QUOTE_STATUS_STYLE).map(([k, v]) => [k, v.label] as [string, string])} />
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <input type="checkbox" checked={showRemoved} onChange={e => setShowRemoved(e.target.checked)} />
          Show removed
        </label>
        <span className="text-xs text-muted-foreground ml-auto">
          {data ? `${standing} quotation${standing === 1 ? '' : 's'}${removedCount ? ` · ${removedCount} removed` : ''}` : ''}
        </span>
      </div>

      <BoError message={error} />

      {loading ? <BoLoading /> : (
        <BoTable head={['Ref', 'Requirement', 'Institute', 'Size', 'Vendor', 'Amount', 'Quoted', 'Status', 'Note', '']}
          empty="No quotations recorded yet.">
          {quotations.map(q => {
            /* A quotation is history once it, or its requirement, was removed:
               shown under "Show removed", never editable. */
            const requirementGone = !!q.request_removed_at
            const removed = !!q.removed_at || requirementGone
            const locked = q.status === 'approved'
            return (
              // Not BoRow: a removed quotation stays listed but must read as gone.
              <tr key={q.id} className={`border-b border-border/60 last:border-0 align-top ${removed ? 'opacity-50' : ''}`}>
                <BoCell strong nowrap>
                  {q.reference}
                  {q.revision > 1 && (
                    <span className="ml-1.5 hub-badge bg-slate-100 text-slate-600"
                      title={`Edited ${q.revision - 1} time${q.revision === 2 ? '' : 's'} — the ⓘ shows every earlier version.`}>
                      v{q.revision}
                    </span>
                  )}
                </BoCell>
                <BoCell nowrap>
                  {q.request_reference}
                  {q.work_type && <div className="text-[11px]">{q.work_type}</div>}
                </BoCell>
                <BoCell>{q.institute_name}</BoCell>
                <BoCell nowrap>{q.request_size || '—'}</BoCell>
                <BoCell strong>{q.vendor_name}</BoCell>
                <BoCell strong nowrap>{boMoney(q.amount)}</BoCell>
                <BoCell nowrap>{q.quote_date}</BoCell>
                <BoCell>
                  {removed
                    ? <span className="hub-badge bg-slate-100 text-slate-600">
                        {requirementGone && !q.removed_at ? 'Requirement removed' : 'Removed'}
                      </span>
                    : <BoBadge style={QUOTE_STATUS_STYLE[q.status]} />}
                </BoCell>
                <BoCell>
                  {removed ? (q.removal_reason || (requirementGone ? 'Its requirement was removed' : 'removed')) : (q.decision_note || q.notes || '—')}
                </BoCell>
                <BoCell nowrap>
                  <div className="flex items-center gap-1.5">
                    {/* Read-only, so offered on removed quotations too: they are what
                        gets compared. Not for a removed requirement — it no longer exists
                        to open. */}
                    {!requirementGone && (
                      <QuoteInfoButton onClick={() => setHistory(q.request_id)}
                        title={`Every quotation for ${q.request_reference}, with earlier versions`} />
                    )}
                    {canEdit && !removed && (
                      <>
                        <BoButton variant="ghost" disabled={busy || locked} onClick={() => setEditing(q)}
                          title={locked ? APPROVED_LOCKED : 'Edit — the current version is kept in the history'}>
                          <Pencil className="w-3 h-3" /> Edit
                        </BoButton>
                        <BoButton variant="danger" disabled={busy || locked} onClick={() => setRemoving(q)}
                          title={locked ? APPROVED_LOCKED : 'Remove — it stays in the requirement’s history'}>
                          <Trash2 className="w-3 h-3" /> Remove
                        </BoButton>
                      </>
                    )}
                  </div>
                </BoCell>
              </tr>
            )
          })}
        </BoTable>
      )}

      {adding && data && (
        <AddQuotationDialog requests={quotable} listed={data.requests !== null}
          vendors={data.vendors} institutes={data.institutes} sizes={data.sizes} busy={busy}
          onClose={() => setAdding(false)}
          onSave={async f => { if (await act(() => boAddQuotation(f))) setAdding(false) }} />
      )}

      {editing && (
        <EditQuotationDialog quotation={editing} vendors={data?.vendors ?? []} busy={busy}
          onClose={() => setEditing(null)}
          onSave={async patch => { if (await act(() => boUpdateQuotation(editing.id, patch))) setEditing(null) }} />
      )}

      {removing && (
        <RemoveQuotationDialog quotation={removing} busy={busy}
          onClose={() => setRemoving(null)}
          onConfirm={async reason => { if (await act(() => boRemoveQuotation(removing.id, reason))) setRemoving(null) }} />
      )}

      {history && <QuotationHistoryDialog requestId={history} onClose={() => setHistory(null)} />}
    </BoPage>
  )
}

// ── Add ────────────────────────────────────────────────────────────────────

/** Every word typed must appear somewhere in the requirement — order free. */
function matchesRequirement(r: BrandingRequest, text: string): boolean {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return true
  const hay = [r.reference, r.work_type, r.institute_name, r.size, r.description].join(' ').toLowerCase()
  return words.every(w => hay.includes(w))
}

/**
 * The requirement is typed, not only picked: the team often has a vendor's
 * quote in hand before anyone has raised the requirement. Typing searches the
 * open requirements; text that matches none of them (or the "new requirement"
 * option) becomes a new requirement, created with the quotation in one step.
 */
function AddQuotationDialog({ requests, listed, vendors, institutes, sizes, busy, onClose, onSave }: {
  requests: BrandingRequest[]
  /** False when the requirement list could not be read; only new ones can be typed then. */
  listed: boolean
  vendors: Vendor[]; institutes: Institute[]; sizes: string[]
  busy: boolean; onClose: () => void; onSave: (f: AddQuotation) => Promise<void>
}) {
  const [text, setText] = useState('')
  const [picked, setPicked] = useState<BrandingRequest | null>(null)
  const [chosenNew, setChosenNew] = useState(false)
  const [form, setForm] = useState<RequestForm>(emptyRequestForm)
  const [vendorId, setVendorId] = useState('')
  const [amount, setAmount] = useState('')
  const [quoteDate, setQuoteDate] = useState(boToday())
  const [notes, setNotes] = useState('')

  const matches = useMemo(() => requests.filter(r => matchesRequirement(r, text)), [requests, text])
  const typed = text.trim()
  const isNew = !picked && typed !== '' && (chosenNew || matches.length === 0)
  const newRequirement: RequestForm = { ...form, description: typed, size: form.size.trim() }

  const quoteReady = vendorId && amount !== '' && Number(amount) >= 0 && quoteDate
  const ready = quoteReady && (picked ? true : isNew && requestFormReady(newRequirement))

  const save = () => {
    const quote = { vendor_id: vendorId, amount: Number(amount), quote_date: quoteDate, notes: notes.trim() }
    void onSave(picked ? { ...quote, request_id: picked.id } : { ...quote, new_requirement: newRequirement })
  }

  return (
    <BoDialog title="Add quotation" onClose={onClose} footer={
      <>
        <BoButton variant="ghost" onClick={onClose}>Cancel</BoButton>
        <BoButton disabled={busy || !ready} onClick={save}>
          {busy ? 'Saving…' : isNew ? 'Save requirement and quotation' : 'Save quotation'}
        </BoButton>
      </>
    }>
      <BoField label="Requirement *" hint={picked ? undefined : isNew
        ? 'Nothing picked — this will be saved as a new requirement, described as typed.'
        : listed
          ? 'Type to search by reference, work type, institute, size or description — or describe a new one.'
          : 'The list of existing requirements could not be loaded — describe a new one.'}>
        {picked ? (
          <PickedRequirement request={picked} onClear={() => { setPicked(null); setText('') }} />
        ) : (
          <RequirementCombobox text={text} matches={matches} isNew={isNew}
            onText={v => { setText(v); if (!v.trim()) setChosenNew(false) }}
            onPick={r => { setPicked(r); setChosenNew(false) }}
            onNew={() => setChosenNew(true)} />
        )}
      </BoField>

      {isNew && (
        <div className="rounded-lg border border-dashed border-border p-3 space-y-2">
          <p className="text-[11px] uppercase tracking-widest text-muted-foreground">New requirement</p>
          <RequestFields form={form} onChange={setForm} institutes={institutes} sizes={sizes} compact />
          {matches.length > 0 && (
            <button type="button" className="text-xs text-[#0047AB] hover:underline"
              onClick={() => setChosenNew(false)}>
              Pick one of the {matches.length} matching requirement{matches.length === 1 ? '' : 's'} instead
            </button>
          )}
        </div>
      )}

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

/** The requirement once chosen — a summary, with a way back to the search. */
function PickedRequirement({ request: r, onClear }: { request: BrandingRequest; onClear: () => void }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2">
      <div className="min-w-0 flex-1 text-xs">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-medium text-foreground">{r.reference}</span>
          <span className="text-foreground">{r.work_type}</span>
          <BoBadge style={REQUEST_STATUS_STYLE[r.status]} />
        </div>
        <div className="text-muted-foreground mt-0.5">
          {r.institute_name}{r.size && ` · ${r.size}`} · required {r.required_date}
          {r.quote_count > 0 && ` · ${r.quote_count} quote${r.quote_count === 1 ? '' : 's'} so far`}
        </div>
        {r.description && <div className="text-muted-foreground mt-0.5 line-clamp-2">{r.description}</div>}
      </div>
      <button type="button" onClick={onClear} title="Choose a different requirement" aria-label="Clear requirement"
        className="p-1 rounded hover:bg-accent text-muted-foreground shrink-0">
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  )
}

/**
 * A text box whose matches drop down beneath it. Built here rather than with
 * a <datalist>, which can only offer strings — it can't show a requirement's
 * institute and size, or the "new requirement" choice.
 */
function RequirementCombobox({ text, matches, isNew, onText, onPick, onNew }: {
  text: string; matches: BrandingRequest[]; isNew: boolean
  onText: (v: string) => void; onPick: (r: BrandingRequest) => void; onNew: () => void
}) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)

  const shown = matches.slice(0, 8)
  const typed = text.trim()
  // The last option, once something is typed: keep the text as a new requirement.
  const options = shown.length + (typed ? 1 : 0)
  const listOpen = open && options > 0 && !isNew

  const choose = (i: number) => {
    if (i < shown.length) onPick(shown[i])
    else onNew()
    setOpen(false)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (!listOpen) { setOpen(true); setActive(0); return }
      const step = e.key === 'ArrowDown' ? 1 : -1
      setActive(a => (a + step + options) % options)
    } else if (e.key === 'Enter' && listOpen) {
      e.preventDefault()
      choose(Math.min(active, options - 1))
    } else if (e.key === 'Escape' && listOpen) {
      // Close the list only — the dialog also listens for Escape and would close.
      e.stopPropagation()
      setOpen(false)
    }
  }

  return (
    <div className="relative">
      {/* One box throughout: when it becomes a new requirement, what was typed
          is its description and stays editable right here. */}
      <input className="hub-input" value={text} autoFocus
        role="combobox" aria-expanded={listOpen} aria-autocomplete="list" aria-controls="bo-requirement-options"
        placeholder={isNew ? 'Describe the branding work required…' : 'Type a requirement — REQ-0012, Banner, an institute, a size…'}
        onChange={e => { onText(e.target.value); setOpen(true); setActive(0) }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown} />
      {listOpen && (
        <ul id="bo-requirement-options" role="listbox"
          className="absolute z-10 left-0 right-0 mt-1 max-h-64 overflow-y-auto rounded-lg border border-border bg-card shadow-lg text-xs">
          {shown.map((r, i) => (
            <li key={r.id} role="option" aria-selected={i === active}
              // mousedown, not click: a click would blur the input first and close the list.
              onMouseDown={e => { e.preventDefault(); choose(i) }}
              onMouseEnter={() => setActive(i)}
              className={`px-3 py-2 cursor-pointer ${i === active ? 'bg-accent' : ''}`}>
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="font-medium text-foreground">{r.reference}</span>
                <span className="text-foreground">{r.work_type}</span>
                <span className="text-muted-foreground">· {r.institute_name}{r.size && ` · ${r.size}`}</span>
              </div>
              {r.description && <div className="text-muted-foreground truncate">{r.description}</div>}
            </li>
          ))}
          {matches.length > shown.length && (
            <li className="px-3 py-1.5 text-muted-foreground">
              {matches.length - shown.length} more — keep typing to narrow down.
            </li>
          )}
          {typed && (
            <li role="option" aria-selected={active === shown.length}
              onMouseDown={e => { e.preventDefault(); choose(shown.length) }}
              onMouseEnter={() => setActive(shown.length)}
              className={`px-3 py-2 cursor-pointer border-t border-border text-[#0047AB] ${active === shown.length ? 'bg-accent' : ''}`}>
              <Plus className="w-3 h-3 inline -mt-0.5" /> Use “{typed}” as a new requirement
            </li>
          )}
        </ul>
      )}
    </div>
  )
}

// ── Edit and remove ────────────────────────────────────────────────────────

function EditQuotationDialog({ quotation: q, vendors, busy, onClose, onSave }: {
  quotation: Quotation; vendors: Vendor[]; busy: boolean; onClose: () => void
  onSave: (patch: { vendor_id: string; amount: number; quote_date: string; notes: string }) => Promise<void>
}) {
  const [vendorId, setVendorId] = useState(q.vendor_id)
  const [amount, setAmount] = useState(String(Number(q.amount)))
  const [quoteDate, setQuoteDate] = useState(q.quote_date)
  const [notes, setNotes] = useState(q.notes)

  const changed = vendorId !== q.vendor_id || Number(amount) !== Number(q.amount)
    || quoteDate !== q.quote_date || notes.trim() !== q.notes.trim()
  const ready = vendorId && amount !== '' && Number(amount) >= 0 && quoteDate && changed

  return (
    <BoDialog title={`Edit ${q.reference}`} onClose={onClose} footer={
      <>
        <BoButton variant="ghost" onClick={onClose}>Cancel</BoButton>
        <BoButton disabled={busy || !ready} onClick={() => void onSave({
          vendor_id: vendorId, amount: Number(amount), quote_date: quoteDate, notes: notes.trim(),
        })}>{busy ? 'Saving…' : 'Save changes'}</BoButton>
      </>
    }>
      <p className="text-xs text-muted-foreground">
        {q.request_reference} · {q.work_type} · {q.institute_name}. The current version
        ({boMoney(q.amount)}, v{q.revision}) is kept, so the old and new figures can be compared from the ⓘ.
      </p>
      <BoField label="Vendor *">
        <select className="hub-input" value={vendorId} onChange={e => setVendorId(e.target.value)}>
          {/* A vendor since deactivated still shows, so an untouched quotation keeps its vendor. */}
          {vendors.filter(v => v.active || v.id === q.vendor_id).map(v => (
            <option key={v.id} value={v.id}>{v.name}</option>
          ))}
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

function RemoveQuotationDialog({ quotation: q, busy, onClose, onConfirm }: {
  quotation: Quotation; busy: boolean; onClose: () => void; onConfirm: (reason: string) => Promise<void>
}) {
  const [reason, setReason] = useState('')
  return (
    <BoDialog title={`Remove ${q.reference}?`} onClose={onClose} footer={
      <>
        <BoButton variant="ghost" onClick={onClose}>Cancel</BoButton>
        <BoButton variant="danger" disabled={busy} onClick={() => void onConfirm(reason.trim())}>
          <Trash2 className="w-3.5 h-3.5" /> {busy ? 'Removing…' : 'Remove quotation'}
        </BoButton>
      </>
    }>
      <p className="text-sm text-foreground">
        {q.vendor_name} — {boMoney(q.amount)} for {q.request_reference} ({q.institute_name}).
      </p>
      <p className="text-xs text-muted-foreground">
        It leaves Quotations and Approvals, but nothing is deleted: it stays in the requirement's
        history (ⓘ) to compare against, and under “Show removed”. If it was the requirement's last
        quotation, the requirement goes back to Pending.
      </p>
      <BoField label="Reason (optional)">
        <input className="hub-input" value={reason} onChange={e => setReason(e.target.value)}
          placeholder="e.g. Vendor withdrew, or entered twice" />
      </BoField>
    </BoDialog>
  )
}
