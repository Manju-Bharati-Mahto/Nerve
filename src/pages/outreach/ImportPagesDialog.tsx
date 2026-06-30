import { useMemo, useRef, useState } from 'react'
import { Upload, X, CheckCircle, AlertCircle, Plus, Trash2 } from 'lucide-react'
import {
  useOutreachData, addPage, addCampaign, updateCampaign, slug,
  FOLLOWER_TIERS, type FollowerTier, type PageType,
} from '@/lib/outreach-data'
import { parseInventorySheet, type ParsedPageRow } from '@/lib/outreach-import'

interface EditableRow extends ParsedPageRow {
  rid: number
  include: boolean
}

let RID = 0
function toEditable(p: ParsedPageRow): EditableRow {
  return { rid: RID++, include: true, ...p }
}

const BLANK: ParsedPageRow = {
  handle: '', displayName: '', geography: '', state: '', type: 'state',
  followerTier: '1', inventoryPosts: 0, inventoryStories: 0, postsDone: 0, assignedCampaigns: [],
}

/**
 * Pages importer for the team's master tracking sheet. Parses the inventory
 * matrix, lists every detected page in an editable grid (manual-edit before
 * commit), and optionally creates the detected campaign columns + assignments.
 */
export default function ImportPagesDialog({ onClose }: { onClose: () => void }) {
  const { campaigns } = useOutreachData()
  const fileRef = useRef<HTMLInputElement>(null)
  const [step, setStep] = useState<'file' | 'edit' | 'done'>('file')
  const [busy, setBusy] = useState(false)
  const [fileName, setFileName] = useState('')
  const [rows, setRows] = useState<EditableRow[]>([])
  const [detectedCampaigns, setDetectedCampaigns] = useState<string[]>([])
  const [createCampaigns, setCreateCampaigns] = useState(true)
  const [result, setResult] = useState<{ pages: number; campaigns: number; skipped: string[] } | null>(null)

  const includedCount = useMemo(() => rows.filter(r => r.include).length, [rows])

  async function onFile(file: File) {
    setBusy(true)
    setFileName(file.name)
    try {
      const { pages, campaigns: camps } = await parseInventorySheet(file)
      if (pages.length === 0) {
        alert('No page rows detected. Make sure the sheet has an "Inventory", "Posts done" and "… Social Media Pages" header row.')
        setStep('file')
      } else {
        setRows(pages.map(toEditable))
        setDetectedCampaigns(camps)
        setStep('edit')
      }
    } catch (e) {
      alert('Could not read the file: ' + (e instanceof Error ? e.message : 'parse error'))
      setStep('file')
    } finally {
      setBusy(false)
    }
  }

  function patch(rid: number, p: Partial<EditableRow>) {
    setRows(rs => rs.map(r => r.rid === rid ? { ...r, ...p } : r))
  }

  async function commit() {
    setBusy(true)
    const skipped: string[] = []
    let createdPages = 0
    const included = rows.filter(r => r.include)

    for (const r of included) {
      const handle = r.handle.trim()
      if (!handle) { skipped.push('(row with empty handle skipped)'); continue }
      try {
        await addPage({
          handle,
          geography: r.geography.trim(),
          state: r.state.trim(),
          type: r.type,
          followerTier: r.followerTier,
          contentTypes: [],
          followers: 0,
          inventoryPosts: r.inventoryPosts,
          inventoryStories: r.inventoryStories,
          notes: r.postsDone ? `Posts done (imported): ${r.postsDone}` : '',
        })
        createdPages++
      } catch (e) {
        skipped.push(`@${handle}: ${e instanceof Error ? e.message : 'failed to add'}`)
      }
    }

    // Optionally materialise the campaign columns + page assignments. Page ids
    // are derived the same way the server does (slug of the handle), so we can
    // wire assignments without round-tripping for each created page.
    let createdCampaigns = 0
    if (createCampaigns) {
      const byCampaign = new Map<string, string[]>()
      for (const r of included) {
        if (!r.handle.trim()) continue
        const pid = slug(r.handle)
        for (const name of r.assignedCampaigns) {
          const arr = byCampaign.get(name) ?? []
          arr.push(pid)
          byCampaign.set(name, arr)
        }
      }
      const existingByName = new Map(campaigns.map(c => [c.name.trim().toLowerCase(), c]))
      const today = new Date().toISOString().slice(0, 10)
      for (const [name, pageIds] of byCampaign) {
        const ids = Array.from(new Set(pageIds))
        const existing = existingByName.get(name.trim().toLowerCase())
        try {
          if (existing) {
            const merged = Array.from(new Set([...existing.assignedPageIds, ...ids]))
            await updateCampaign(existing.id, { assignedPageIds: merged })
          } else {
            await addCampaign({
              name, startDate: today, endDate: today, state: '', goal: '', status: 'planning',
              budgetPosts: 0, budgetStories: 0, budgetReels: 0,
              approvers: [], creativeVariants: [], assignedPageIds: ids, assignedCreatorIds: [],
            })
            createdCampaigns++
          }
        } catch (e) {
          skipped.push(`campaign "${name}": ${e instanceof Error ? e.message : 'failed'}`)
        }
      }
    }

    setResult({ pages: createdPages, campaigns: createdCampaigns, skipped })
    setStep('done')
    setBusy(false)
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4 animate-fade-in">
      <div className="bg-card rounded-xl border border-border w-full max-w-6xl max-h-[92vh] flex flex-col">
        <div className="flex items-center justify-between p-4 border-b border-border">
          <div>
            <h2 className="text-base font-serif text-foreground">Import Pages via Excel</h2>
            <p className="text-xs text-muted-foreground">
              {step === 'edit'
                ? `Review and edit the detected data before importing${fileName ? ` · ${fileName}` : ''}.`
                : 'Upload the master tracking sheet — pages, inventory, geography and campaigns are read automatically.'}
            </p>
          </div>
          <button onClick={onClose} className="p-2 rounded-lg hover:bg-accent text-muted-foreground"><X className="w-4 h-4" /></button>
        </div>

        <div className="flex-1 overflow-auto p-4">
          {step === 'file' && (
            <div className="text-center py-10">
              <Upload className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
              <p className="text-sm text-foreground mb-1">Choose your Excel / CSV file</p>
              <p className="text-xs text-muted-foreground mb-4 max-w-md mx-auto">
                Reads the inventory matrix: page rows grouped under "&lt;City&gt; Social Media Pages" headers,
                "Inventory" like <span className="font-mono">48(P) 24 (S)</span>, "Posts done", and the campaign columns to the right.
              </p>
              <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden"
                onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f) }} />
              <button onClick={() => fileRef.current?.click()} disabled={busy}
                className="px-4 py-2 rounded-lg bg-orange-600 text-white text-sm font-medium hover:opacity-90 disabled:opacity-60">
                {busy ? 'Reading…' : 'Select file'}
              </button>
            </div>
          )}

          {step === 'edit' && (
            <div className="space-y-3">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <p className="text-xs text-muted-foreground">
                  <span className="font-semibold text-foreground">{includedCount}</span> of {rows.length} pages selected.
                  Edit any field below — uncheck a row to skip it.
                </p>
                <button onClick={() => setRows(rs => [...rs, toEditable(BLANK)])}
                  className="text-xs px-2.5 py-1.5 rounded-lg border border-border hover:bg-accent inline-flex items-center gap-1">
                  <Plus className="w-3.5 h-3.5" /> Add row
                </button>
              </div>

              <div className="border border-border rounded-lg overflow-auto max-h-[52vh]">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-muted/95 backdrop-blur">
                    <tr className="text-left text-[10px] uppercase tracking-widest text-muted-foreground">
                      <th className="px-2 py-2 w-8"></th>
                      <th className="px-2 py-2 min-w-[160px]">Handle</th>
                      <th className="px-2 py-2 min-w-[120px]">Geography</th>
                      <th className="px-2 py-2 min-w-[120px]">State</th>
                      <th className="px-2 py-2">Type</th>
                      <th className="px-2 py-2">Tier</th>
                      <th className="px-2 py-2 w-16">Inv P</th>
                      <th className="px-2 py-2 w-16">Inv S</th>
                      <th className="px-2 py-2 w-16">Posts</th>
                      <th className="px-2 py-2 min-w-[140px]">Campaigns</th>
                      <th className="px-2 py-2 w-8"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(r => (
                      <tr key={r.rid} className={`border-t border-border ${r.include ? '' : 'opacity-40'}`}>
                        <td className="px-2 py-1.5">
                          <input type="checkbox" checked={r.include} onChange={e => patch(r.rid, { include: e.target.checked })} />
                        </td>
                        <td className="px-2 py-1.5">
                          <input className="hub-input py-1 text-xs" value={r.handle}
                            onChange={e => patch(r.rid, { handle: e.target.value })} placeholder="handle" />
                        </td>
                        <td className="px-2 py-1.5">
                          <input className="hub-input py-1 text-xs" value={r.geography}
                            onChange={e => patch(r.rid, { geography: e.target.value })} placeholder="city" />
                        </td>
                        <td className="px-2 py-1.5">
                          <input className="hub-input py-1 text-xs" value={r.state}
                            onChange={e => patch(r.rid, { state: e.target.value })} placeholder="state" />
                        </td>
                        <td className="px-2 py-1.5">
                          <select className="hub-input py-1 text-xs" value={r.type}
                            onChange={e => patch(r.rid, { type: e.target.value as PageType })}>
                            <option value="state">State</option>
                            <option value="pu">PU</option>
                          </select>
                        </td>
                        <td className="px-2 py-1.5">
                          <select className="hub-input py-1 text-xs" value={r.followerTier}
                            onChange={e => patch(r.rid, { followerTier: e.target.value as FollowerTier })}>
                            {FOLLOWER_TIERS.map(t => <option key={t} value={t}>{t}</option>)}
                          </select>
                        </td>
                        <td className="px-2 py-1.5">
                          <input type="number" min={0} className="hub-input py-1 text-xs" value={r.inventoryPosts}
                            onChange={e => patch(r.rid, { inventoryPosts: Number(e.target.value) || 0 })} />
                        </td>
                        <td className="px-2 py-1.5">
                          <input type="number" min={0} className="hub-input py-1 text-xs" value={r.inventoryStories}
                            onChange={e => patch(r.rid, { inventoryStories: Number(e.target.value) || 0 })} />
                        </td>
                        <td className="px-2 py-1.5">
                          <input type="number" min={0} className="hub-input py-1 text-xs" value={r.postsDone}
                            onChange={e => patch(r.rid, { postsDone: Number(e.target.value) || 0 })} />
                        </td>
                        <td className="px-2 py-1.5">
                          {r.assignedCampaigns.length === 0 ? (
                            <span className="text-muted-foreground">—</span>
                          ) : (
                            <div className="flex flex-wrap gap-1">
                              {r.assignedCampaigns.map(c => (
                                <span key={c} className="hub-badge bg-orange-50 text-orange-700 text-[10px]">{c}</span>
                              ))}
                            </div>
                          )}
                        </td>
                        <td className="px-2 py-1.5">
                          <button onClick={() => setRows(rs => rs.filter(x => x.rid !== r.rid))}
                            className="p-1 rounded text-muted-foreground hover:bg-rose-50 hover:text-rose-600">
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {detectedCampaigns.length > 0 && (
                <label className="flex items-start gap-2 hub-card bg-orange-50/50 border-orange-200 cursor-pointer py-2.5">
                  <input type="checkbox" className="mt-0.5" checked={createCampaigns} onChange={e => setCreateCampaigns(e.target.checked)} />
                  <span className="text-xs text-foreground">
                    Also create the <strong>{detectedCampaigns.length}</strong> detected campaign{detectedCampaigns.length === 1 ? '' : 's'} and assign pages
                    <span className="block text-[11px] text-muted-foreground mt-0.5">{detectedCampaigns.join(' · ')}</span>
                    <span className="block text-[11px] text-muted-foreground">Existing campaigns (matched by name) are updated, not duplicated. Post links still need adding to record metrics.</span>
                  </span>
                </label>
              )}
            </div>
          )}

          {step === 'done' && result && (
            <div className="space-y-3">
              <div className="hub-card bg-emerald-50 border-emerald-200 text-sm text-emerald-900 flex items-center gap-2">
                <CheckCircle className="w-4 h-4" />
                Imported {result.pages} page{result.pages === 1 ? '' : 's'}
                {result.campaigns > 0 && ` and created ${result.campaigns} campaign${result.campaigns === 1 ? '' : 's'}`}.
              </div>
              {result.skipped.length > 0 && (
                <div className="hub-card bg-amber-50 border-amber-200 text-xs text-amber-900">
                  <p className="flex items-center gap-1.5 font-semibold mb-2"><AlertCircle className="w-4 h-4" /> Skipped {result.skipped.length}</p>
                  <ul className="space-y-0.5 max-h-40 overflow-y-auto font-mono">
                    {result.skipped.slice(0, 40).map((s, i) => <li key={i}>· {s}</li>)}
                    {result.skipped.length > 40 && <li className="text-amber-700">…and {result.skipped.length - 40} more</li>}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between p-4 border-t border-border">
          <button onClick={() => step === 'edit' ? setStep('file') : onClose()} disabled={busy}
            className="px-4 py-2 rounded-lg border border-border text-sm text-muted-foreground hover:bg-accent disabled:opacity-60">
            {step === 'edit' ? 'Back' : step === 'done' ? 'Close' : 'Cancel'}
          </button>
          {step === 'edit' && (
            <button onClick={commit} disabled={busy || includedCount === 0}
              className="px-4 py-2 rounded-lg bg-orange-600 text-white text-sm font-medium hover:opacity-90 disabled:opacity-40">
              {busy ? 'Importing…' : `Import ${includedCount} page${includedCount === 1 ? '' : 's'}`}
            </button>
          )}
          {step === 'done' && (
            <button onClick={onClose}
              className="px-4 py-2 rounded-lg bg-orange-600 text-white text-sm font-medium hover:opacity-90">Done</button>
          )}
        </div>
      </div>
    </div>
  )
}
