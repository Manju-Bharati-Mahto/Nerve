import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Send, Plus, Search, X, ChevronRight, Filter as FilterIcon } from 'lucide-react'
import {
  useOutreachData, addCampaign, campaignMetrics,
  type CampaignStatus,
} from '@/lib/outreach-data'

const STATUS_CFG: Record<CampaignStatus, { label: string; cls: string }> = {
  planning:  { label: 'Planning',  cls: 'bg-blue-100 text-blue-700' },
  active:    { label: 'Active',    cls: 'bg-emerald-100 text-emerald-700' },
  paused:    { label: 'Paused',    cls: 'bg-amber-100 text-amber-700' },
  completed: { label: 'Completed', cls: 'bg-muted text-muted-foreground' },
}

export default function OutreachCampaigns() {
  const { campaigns, posts, pages } = useOutreachData()
  const [view, setView] = useState<'cards' | 'table'>('cards')
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<CampaignStatus | ''>('')
  const [creating, setCreating] = useState(false)

  const enriched = useMemo(() => campaigns.map(c => ({ c, m: campaignMetrics(c, posts) })), [campaigns, posts])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return enriched.filter(({ c }) => {
      if (q && !c.name.toLowerCase().includes(q)) return false
      if (status && c.status !== status) return false
      return true
    }).sort((a, b) => a.c.startDate < b.c.startDate ? 1 : -1)
  }, [enriched, search, status])

  return (
    <div className="animate-fade-in space-y-5">

      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-orange-100 flex items-center justify-center">
            <Send className="w-5 h-5 text-orange-600" />
          </div>
          <div>
            <h1 className="text-2xl font-serif text-foreground">Campaigns</h1>
            <p className="text-sm text-muted-foreground">Plan, launch, and track outreach campaigns.</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="inline-flex bg-card border border-border rounded-lg overflow-hidden text-xs">
            {(['cards', 'table'] as const).map(v => (
              <button key={v} onClick={() => setView(v)}
                className={`px-3 py-1.5 transition-colors capitalize ${view === v ? 'bg-orange-100 text-orange-700 font-medium' : 'text-muted-foreground hover:bg-accent'}`}>
                {v}
              </button>
            ))}
          </div>
          <button onClick={() => setCreating(true)}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium bg-orange-600 text-white hover:opacity-90 transition-opacity">
            <Plus className="w-4 h-4" /> New campaign
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="hub-card py-3">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="w-4 h-4 text-muted-foreground absolute left-3 top-1/2 -translate-y-1/2" />
            <input value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Search campaigns…"
              className="hub-input pl-9 py-1.5" />
          </div>
          <FilterIcon className="w-4 h-4 text-muted-foreground" />
          <select value={status} onChange={e => setStatus(e.target.value as CampaignStatus | '')} className="hub-input py-1.5 text-xs w-32">
            <option value="">Any status</option>
            {Object.entries(STATUS_CFG).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
          <span className="text-xs text-muted-foreground ml-auto">{filtered.length} of {campaigns.length} campaigns</span>
        </div>
      </div>

      {/* Body */}
      {filtered.length === 0 ? (
        <div className="hub-card text-center py-16">
          <div className="w-12 h-12 rounded-xl bg-orange-50 mx-auto flex items-center justify-center mb-3">
            <Send className="w-6 h-6 text-orange-600" />
          </div>
          <p className="text-sm font-medium text-foreground">No campaigns match these filters.</p>
        </div>
      ) : view === 'cards' ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map(({ c, m }) => (
            <Link key={c.id} to={`/outreach/campaigns/${c.id}`}
              className="hub-card hover:shadow-md transition-shadow block">
              <div className="flex items-start justify-between gap-2 mb-2">
                <div className="min-w-0 flex-1">
                  <h3 className="text-sm font-semibold text-foreground truncate">{c.name}</h3>
                  <p className="text-[11px] text-muted-foreground">{c.startDate} → {c.endDate}</p>
                </div>
                <span className={`hub-badge ${STATUS_CFG[c.status].cls} shrink-0`}>{STATUS_CFG[c.status].label}</span>
              </div>
              <p className="text-xs text-muted-foreground mb-3 line-clamp-2">{c.goal || 'No goal set'}</p>

              {/* Progress */}
              <div className="mb-2">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[10px] uppercase tracking-widest text-muted-foreground">Budget consumed</span>
                  <span className="text-xs font-mono tabular-nums text-foreground">{Math.round(m.pctConsumed * 100)}%</span>
                </div>
                <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                  <div className={`h-full ${m.pctConsumed >= 1 ? 'bg-rose-500' : m.pctConsumed >= 0.7 ? 'bg-amber-500' : 'bg-orange-500'}`}
                    style={{ width: `${Math.min(100, m.pctConsumed * 100)}%` }} />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-2 text-center pt-2 border-t border-border">
                <div>
                  <p className="text-sm font-mono tabular-nums text-foreground">{m.postsDelivered}<span className="text-[10px] text-muted-foreground">/{c.budgetPosts}</span></p>
                  <p className="text-[10px] text-muted-foreground">Posts</p>
                </div>
                <div>
                  <p className="text-sm font-mono tabular-nums text-foreground">{m.storiesDelivered}<span className="text-[10px] text-muted-foreground">/{c.budgetStories}</span></p>
                  <p className="text-[10px] text-muted-foreground">Stories</p>
                </div>
                <div>
                  <p className="text-sm font-mono tabular-nums text-foreground">{m.reelsDelivered}<span className="text-[10px] text-muted-foreground">/{c.budgetReels}</span></p>
                  <p className="text-[10px] text-muted-foreground">Reels</p>
                </div>
              </div>

              <div className="flex items-center gap-1.5 mt-3 flex-wrap">
                {c.creativeVariants.map(v => (
                  <span key={v} className="hub-badge bg-muted text-muted-foreground text-[10px]">{v}</span>
                ))}
              </div>
              <p className="text-[11px] text-muted-foreground mt-2">{c.assignedPageIds.length} pages assigned</p>
            </Link>
          ))}
        </div>
      ) : (
        <div className="hub-card p-0 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-widest text-muted-foreground border-b border-border">
                <th className="px-3 py-2">Name</th>
                <th className="px-3 py-2">Dates</th>
                <th className="px-3 py-2 text-right">Budget (P/S/R)</th>
                <th className="px-3 py-2 text-right">Pages</th>
                <th className="px-3 py-2 text-right">Delivered</th>
                <th className="px-3 py-2 text-right">% consumed</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2 w-8"></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(({ c, m }) => (
                <tr key={c.id} className="border-b border-border last:border-0 hover:bg-accent/40 transition-colors">
                  <td className="px-3 py-2.5">
                    <Link to={`/outreach/campaigns/${c.id}`} className="text-xs font-medium text-foreground hover:underline">{c.name}</Link>
                  </td>
                  <td className="px-3 py-2.5 text-xs text-muted-foreground">{c.startDate} → {c.endDate}</td>
                  <td className="px-3 py-2.5 text-right text-xs font-mono tabular-nums">{c.budgetPosts}/{c.budgetStories}/{c.budgetReels}</td>
                  <td className="px-3 py-2.5 text-right text-xs font-mono tabular-nums">{c.assignedPageIds.length}</td>
                  <td className="px-3 py-2.5 text-right text-xs font-mono tabular-nums">{m.postsDelivered + m.storiesDelivered + m.reelsDelivered}</td>
                  <td className="px-3 py-2.5 text-right text-xs font-mono tabular-nums">{Math.round(m.pctConsumed * 100)}%</td>
                  <td className="px-3 py-2.5"><span className={`hub-badge ${STATUS_CFG[c.status].cls}`}>{STATUS_CFG[c.status].label}</span></td>
                  <td className="px-3 py-2.5"><ChevronRight className="w-4 h-4 text-muted-foreground" /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {creating && <CreateCampaignModal pages={pages} onClose={() => setCreating(false)} />}

    </div>
  )
}

// ── Create Campaign Modal ──────────────────────────────────────────────────

function CreateCampaignModal({ pages, onClose }: { pages: ReturnType<typeof useOutreachData>['pages']; onClose: () => void }) {
  const [step, setStep] = useState(1)
  const [form, setForm] = useState({
    name: '', startDate: '', goal: '',
    budgetPosts: 0, budgetStories: 0, budgetReels: 0,
    variantsRaw: 'set_1, set_2',
    pageIds: [] as string[],
    approversRaw: 'Outreach Manager',
  })
  const [pageQuery, setPageQuery] = useState('')

  const filteredPages = useMemo(() => {
    const q = pageQuery.trim().toLowerCase()
    return pages.filter(p => !q || p.handle.toLowerCase().includes(q) || p.geography.toLowerCase().includes(q))
  }, [pages, pageQuery])

  function togglePage(id: string) {
    setForm(f => ({ ...f, pageIds: f.pageIds.includes(id) ? f.pageIds.filter(x => x !== id) : [...f.pageIds, id] }))
  }

  function submit() {
    addCampaign({
      name: form.name.trim(),
      startDate: form.startDate,
      // End date intentionally mirrors start date — campaigns are now open-ended
      // until manually marked completed. Kept on the Campaign type for back-compat.
      endDate: form.startDate,
      goal: form.goal.trim(),
      status: 'planning',
      budgetPosts: form.budgetPosts,
      budgetStories: form.budgetStories,
      budgetReels: form.budgetReels,
      approvers: form.approversRaw.split(',').map(s => s.trim()).filter(Boolean),
      creativeVariants: form.variantsRaw.split(',').map(s => s.trim()).filter(Boolean),
      assignedPageIds: form.pageIds,
    })
    onClose()
  }

  const canStep1 = !!form.name && !!form.startDate
  const canStep2 = form.budgetPosts + form.budgetStories + form.budgetReels > 0
  const canStep3 = form.pageIds.length > 0

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4 animate-fade-in">
      <div className="bg-card rounded-xl border border-border w-full max-w-2xl max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between p-4 border-b border-border">
          <div>
            <h2 className="text-base font-serif text-foreground">New campaign</h2>
            <p className="text-xs text-muted-foreground">Step {step} of 4</p>
          </div>
          <button onClick={onClose} className="p-2 rounded-lg hover:bg-accent text-muted-foreground"><X className="w-4 h-4" /></button>
        </div>

        {/* Stepper */}
        <div className="flex border-b border-border">
          {['Basics', 'Budget', 'Pages', 'Variants & Approvers'].map((label, i) => (
            <div key={label} className={`flex-1 px-3 py-2 text-center text-[11px] uppercase tracking-widest border-b-2 transition-colors ${
              step === i + 1 ? 'border-orange-600 text-orange-700' : i + 1 < step ? 'border-emerald-500 text-emerald-700' : 'border-transparent text-muted-foreground'
            }`}>
              {i + 1}. {label}
            </div>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {step === 1 && (
            <>
              <div>
                <label className="hub-label">Name *</label>
                <input className="hub-input" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                  placeholder="e.g. Tech Expo April" />
              </div>
              <div>
                <label className="hub-label">Start date *</label>
                <input type="date" className="hub-input" value={form.startDate} onChange={e => setForm(f => ({ ...f, startDate: e.target.value }))} />
              </div>
              <div>
                <label className="hub-label">Goal / KPI</label>
                <textarea className="hub-input resize-none" rows={3} value={form.goal} onChange={e => setForm(f => ({ ...f, goal: e.target.value }))}
                  placeholder="e.g. 500k reach, 2% engagement rate" />
              </div>
            </>
          )}

          {step === 2 && (
            <>
              <p className="text-xs text-muted-foreground mb-2">Budget = inventory units this campaign should consume across all assigned pages.</p>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="hub-label">Posts</label>
                  <input type="number" min={0} className="hub-input" value={form.budgetPosts}
                    onChange={e => setForm(f => ({ ...f, budgetPosts: Number(e.target.value) || 0 }))} />
                </div>
                <div>
                  <label className="hub-label">Stories</label>
                  <input type="number" min={0} className="hub-input" value={form.budgetStories}
                    onChange={e => setForm(f => ({ ...f, budgetStories: Number(e.target.value) || 0 }))} />
                </div>
                <div>
                  <label className="hub-label">Reels</label>
                  <input type="number" min={0} className="hub-input" value={form.budgetReels}
                    onChange={e => setForm(f => ({ ...f, budgetReels: Number(e.target.value) || 0 }))} />
                </div>
              </div>
              <div className="hub-card bg-orange-50 border-orange-200 text-xs text-orange-900 py-2">
                Total budget: <strong>{form.budgetPosts + form.budgetStories + form.budgetReels}</strong> units across {form.pageIds.length || '—'} pages
              </div>
            </>
          )}

          {step === 3 && (
            <>
              <div className="flex items-center justify-between">
                <p className="text-xs text-muted-foreground">{form.pageIds.length} of {pages.length} pages selected</p>
                <input value={pageQuery} onChange={e => setPageQuery(e.target.value)} placeholder="Filter pages…" className="hub-input py-1 text-xs w-48" />
              </div>
              <div className="border border-border rounded-lg max-h-72 overflow-y-auto divide-y divide-border">
                {filteredPages.map(p => (
                  <label key={p.id} className="flex items-center gap-3 px-3 py-2 hover:bg-accent cursor-pointer">
                    <input type="checkbox" checked={form.pageIds.includes(p.id)} onChange={() => togglePage(p.id)} />
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-medium text-foreground truncate">@{p.handle}</p>
                      <p className="text-[11px] text-muted-foreground truncate">{p.geography} · {p.type}</p>
                    </div>
                  </label>
                ))}
              </div>
            </>
          )}

          {step === 4 && (
            <>
              <div>
                <label className="hub-label">Creative variants (comma-separated)</label>
                <input className="hub-input" value={form.variantsRaw}
                  onChange={e => setForm(f => ({ ...f, variantsRaw: e.target.value }))}
                  placeholder="set_1, set_2, garud, drone" />
                <p className="text-[11px] text-muted-foreground mt-1">Variants tag each post so you can compare which creative pulled best.</p>
              </div>
              <div>
                <label className="hub-label">Approvers (comma-separated)</label>
                <input className="hub-input" value={form.approversRaw}
                  onChange={e => setForm(f => ({ ...f, approversRaw: e.target.value }))}
                  placeholder="Outreach Manager, Brand Lead" />
              </div>
              <div className="hub-card bg-muted text-xs space-y-1">
                <p><strong>{form.name}</strong> · starts {form.startDate}</p>
                <p>{form.budgetPosts} posts · {form.budgetStories} stories · {form.budgetReels} reels</p>
                <p>{form.pageIds.length} pages · {form.variantsRaw.split(',').filter(Boolean).length} variants</p>
              </div>
            </>
          )}
        </div>

        <div className="flex items-center justify-between p-4 border-t border-border">
          <button onClick={() => step > 1 ? setStep(step - 1) : onClose()}
            className="px-4 py-2 rounded-lg border border-border text-sm text-muted-foreground hover:bg-accent">
            {step > 1 ? 'Back' : 'Cancel'}
          </button>
          {step < 4 ? (
            <button onClick={() => setStep(step + 1)}
              disabled={(step === 1 && !canStep1) || (step === 2 && !canStep2) || (step === 3 && !canStep3)}
              className="px-4 py-2 rounded-lg bg-orange-600 text-white text-sm font-medium hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed">
              Next
            </button>
          ) : (
            <button onClick={submit}
              className="px-4 py-2 rounded-lg bg-orange-600 text-white text-sm font-medium hover:opacity-90">
              Create campaign
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
