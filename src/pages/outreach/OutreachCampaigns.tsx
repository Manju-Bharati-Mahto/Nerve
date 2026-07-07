import { useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Send, Plus, Search, X, ChevronRight, Filter as FilterIcon, Trash2, Upload, CheckCircle, AlertCircle } from 'lucide-react'
import {
  useOutreachData, addCampaign, removeCampaign, campaignMetrics,
  INDIAN_STATES,
  type Campaign, type CampaignStatus,
} from '@/lib/outreach-data'
import { parseSpreadsheet, pick } from '@/lib/outreach-import'
import AddLivePostsDialog from './AddLivePostsDialog'

const STATUS_CFG: Record<CampaignStatus, { label: string; cls: string }> = {
  planning:  { label: 'Planning',  cls: 'bg-blue-100 text-blue-700' },
  active:    { label: 'Active',    cls: 'bg-emerald-100 text-emerald-700' },
  paused:    { label: 'Paused',    cls: 'bg-amber-100 text-amber-700' },
  completed: { label: 'Completed', cls: 'bg-muted text-muted-foreground' },
}

export default function OutreachCampaigns() {
  const { campaigns, posts, pages, creators } = useOutreachData()
  const navigate = useNavigate()
  const [view, setView] = useState<'cards' | 'table'>('cards')
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<CampaignStatus | ''>('')
  const [creating, setCreating] = useState(false)
  const [importing, setImporting] = useState(false)
  // Campaign whose "add live posts" dialog is currently open. Set when the
  // CreateCampaignModal finishes (auto-open flow) or could be wired to a
  // campaign-row action in the future.
  const [livePostsFor, setLivePostsFor] = useState<Campaign | null>(null)

  const enriched = useMemo(() => campaigns.map(c => ({ c, m: campaignMetrics(c, posts) })), [campaigns, posts])

  async function confirmDelete(c: Campaign) {
    const linked = posts.filter(p => p.campaignId === c.id).length
    const msg = linked > 0
      ? `Delete "${c.name}"? ${linked} post${linked === 1 ? '' : 's'} attributed to it will be kept but unattributed. This cannot be undone.`
      : `Delete "${c.name}"? This cannot be undone.`
    if (!window.confirm(msg)) return
    try { await removeCampaign(c.id) }
    catch (err) { alert(err instanceof Error ? err.message : 'Failed to delete campaign.') }
  }

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
          <button onClick={() => setImporting(true)}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium border border-border hover:bg-accent transition-colors">
            <Upload className="w-4 h-4" /> Import Excel
          </button>
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
                  <p className="text-[11px] text-muted-foreground">{c.startDate} → {c.endDate}{c.state && ` · ${c.state}`}</p>
                </div>
                <span className={`hub-badge ${STATUS_CFG[c.status].cls} shrink-0`}>{STATUS_CFG[c.status].label}</span>
              </div>
              <p className="text-xs text-muted-foreground mb-3 line-clamp-2">{c.goal || 'No goal set'}</p>

              {/* Progress */}
              <div className="mb-2">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[10px] uppercase tracking-widest text-muted-foreground">Post completion</span>
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
              <p className="text-[11px] text-muted-foreground mt-2">
                {c.assignedPageIds.length} pages
                {c.assignedCreatorIds.length > 0 && ` · ${c.assignedCreatorIds.length} creators`} assigned
              </p>
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
                <th className="px-3 py-2">State</th>
                <th className="px-3 py-2 text-right">Budget (P/S/R)</th>
                <th className="px-3 py-2 text-right">Pages + Creators</th>
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
                  <td className="px-3 py-2.5 text-xs text-muted-foreground">{c.state || '—'}</td>
                  <td className="px-3 py-2.5 text-right text-xs font-mono tabular-nums">{c.budgetPosts}/{c.budgetStories}/{c.budgetReels}</td>
                  <td className="px-3 py-2.5 text-right text-xs font-mono tabular-nums">{c.assignedPageIds.length} / {c.assignedCreatorIds.length}</td>
                  <td className="px-3 py-2.5 text-right text-xs font-mono tabular-nums">{m.postsDelivered + m.storiesDelivered + m.reelsDelivered}</td>
                  <td className="px-3 py-2.5 text-right text-xs font-mono tabular-nums">{Math.round(m.pctConsumed * 100)}%</td>
                  <td className="px-3 py-2.5"><span className={`hub-badge ${STATUS_CFG[c.status].cls}`}>{STATUS_CFG[c.status].label}</span></td>
                  <td className="px-3 py-2.5">
                    <div className="flex items-center gap-1">
                      <button onClick={() => confirmDelete(c)}
                        title="Delete campaign"
                        className="p-1 rounded-md text-muted-foreground hover:bg-rose-50 hover:text-rose-600">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                      <ChevronRight className="w-4 h-4 text-muted-foreground" />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {creating && (
        <CreateCampaignModal
          pages={pages}
          creators={creators}
          onClose={() => setCreating(false)}
          onCreated={c => {
            setCreating(false)
            // Live posts can now attach to either a page or a creator, so the
            // dialog opens whenever the campaign has at least one assignee of
            // either kind. Otherwise jump to the campaign detail page.
            if (c.assignedPageIds.length + c.assignedCreatorIds.length > 0) {
              setLivePostsFor(c)
            } else {
              navigate(`/outreach/campaigns/${c.id}`)
            }
          }}
        />
      )}

      {livePostsFor && (
        <AddLivePostsDialog
          campaign={livePostsFor}
          onClose={() => setLivePostsFor(null)}
        />
      )}

      {importing && <ImportCampaignsModal onClose={() => setImporting(false)} />}

    </div>
  )
}

// ── Create Campaign Modal ──────────────────────────────────────────────────

function CreateCampaignModal({
  pages, creators, onClose, onCreated,
}: {
  pages: ReturnType<typeof useOutreachData>['pages']
  creators: ReturnType<typeof useOutreachData>['creators']
  onClose: () => void
  /** Fires with the freshly-created campaign so the parent can open the
   *  "add live posts" dialog as a follow-on step. */
  onCreated: (campaign: Campaign) => void
}) {
  const [step, setStep] = useState(1)
  const [form, setForm] = useState({
    name: '', startDate: '', endDate: '', state: '', goal: '',
    budgetPosts: 0, budgetStories: 0, budgetReels: 0,
    variantsRaw: 'set_1, set_2',
    pageIds: [] as string[],
    creatorIds: [] as string[],
    approversRaw: 'Outreach Manager',
  })
  // State options: canonical list ∪ states already on pages, so a state the
  // team has used before is always selectable.
  const stateOptions = useMemo(
    () => Array.from(new Set([...INDIAN_STATES, ...pages.map(p => p.state).filter(Boolean)])).sort(),
    [pages],
  )
  const [pageQuery, setPageQuery] = useState('')
  const [creatorQuery, setCreatorQuery] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  const filteredPages = useMemo(() => {
    const q = pageQuery.trim().toLowerCase()
    return pages.filter(p => !q || p.handle.toLowerCase().includes(q) || p.geography.toLowerCase().includes(q))
  }, [pages, pageQuery])

  const filteredCreators = useMemo(() => {
    const q = creatorQuery.trim().toLowerCase()
    return creators.filter(c => !q || c.handle.toLowerCase().includes(q) || c.geography.toLowerCase().includes(q))
  }, [creators, creatorQuery])

  function togglePage(id: string) {
    setForm(f => ({ ...f, pageIds: f.pageIds.includes(id) ? f.pageIds.filter(x => x !== id) : [...f.pageIds, id] }))
  }

  function toggleCreator(id: string) {
    setForm(f => ({ ...f, creatorIds: f.creatorIds.includes(id) ? f.creatorIds.filter(x => x !== id) : [...f.creatorIds, id] }))
  }

  async function submit() {
    if (submitting) return
    setSubmitting(true)
    setSubmitError(null)
    try {
      const created = await addCampaign({
        name: form.name.trim(),
        startDate: form.startDate,
        // End date is optional in the form; fall back to the start date so a
        // single-day campaign still has a valid (non-empty) range.
        endDate: form.endDate || form.startDate,
        state: form.state.trim(),
        goal: form.goal.trim(),
        status: 'planning',
        budgetPosts: form.budgetPosts,
        budgetStories: form.budgetStories,
        budgetReels: form.budgetReels,
        approvers: form.approversRaw.split(',').map(s => s.trim()).filter(Boolean),
        creativeVariants: form.variantsRaw.split(',').map(s => s.trim()).filter(Boolean),
        assignedPageIds: form.pageIds,
        assignedCreatorIds: form.creatorIds,
      })
      onCreated(created)
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Failed to create campaign.')
      setSubmitting(false)
    }
  }

  const canStep1 = !!form.name && !!form.startDate
  const canStep2 = form.budgetPosts + form.budgetStories + form.budgetReels > 0
  // Need at least one assignee — page OR creator — to advance past step 3.
  const canStep3 = form.pageIds.length + form.creatorIds.length > 0

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
          {['Basics', 'Budget', 'Pages & Creators', 'Variants & Approvers'].map((label, i) => (
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
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="hub-label">Start date *</label>
                  <input type="date" className="hub-input" value={form.startDate} onChange={e => setForm(f => ({ ...f, startDate: e.target.value }))} />
                </div>
                <div>
                  <label className="hub-label">End date</label>
                  <input type="date" className="hub-input" value={form.endDate} min={form.startDate || undefined}
                    onChange={e => setForm(f => ({ ...f, endDate: e.target.value }))} />
                </div>
              </div>
              <div>
                <label className="hub-label">State</label>
                <select className="hub-input" value={form.state} onChange={e => setForm(f => ({ ...f, state: e.target.value }))}>
                  <option value="">Select a state (which state this campaign targets)</option>
                  {stateOptions.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <div>
                <label className="hub-label">Description</label>
                <textarea className="hub-input resize-none" rows={3} value={form.goal} onChange={e => setForm(f => ({ ...f, goal: e.target.value }))}
                  placeholder="Optional — e.g. 500k reach, 2% engagement rate" />
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
                Total budget: <strong>{form.budgetPosts + form.budgetStories + form.budgetReels}</strong> units across {form.pageIds.length + form.creatorIds.length || '—'} pages + creators
              </div>
            </>
          )}

          {step === 3 && (
            <>
              {/* Pages section */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                    Pages <span className="font-normal normal-case tracking-normal">— {form.pageIds.length} of {pages.length} selected</span>
                  </p>
                  <input value={pageQuery} onChange={e => setPageQuery(e.target.value)} placeholder="Filter pages…" className="hub-input py-1 text-xs w-48" />
                </div>
                <div className="border border-border rounded-lg max-h-48 overflow-y-auto divide-y divide-border">
                  {filteredPages.length === 0 ? (
                    <p className="px-3 py-6 text-xs text-muted-foreground text-center">No pages match.</p>
                  ) : filteredPages.map(p => (
                    <label key={p.id} className="flex items-center gap-3 px-3 py-2 hover:bg-accent cursor-pointer">
                      <input type="checkbox" checked={form.pageIds.includes(p.id)} onChange={() => togglePage(p.id)} />
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-medium text-foreground truncate">@{p.handle}</p>
                        <p className="text-[11px] text-muted-foreground truncate">{p.geography} · {p.type}</p>
                      </div>
                    </label>
                  ))}
                </div>
              </div>

              {/* Creators section */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                    Creators <span className="font-normal normal-case tracking-normal">— {form.creatorIds.length} of {creators.length} selected</span>
                  </p>
                  <input value={creatorQuery} onChange={e => setCreatorQuery(e.target.value)} placeholder="Filter creators…" className="hub-input py-1 text-xs w-48" />
                </div>
                <div className="border border-border rounded-lg max-h-48 overflow-y-auto divide-y divide-border">
                  {filteredCreators.length === 0 ? (
                    <p className="px-3 py-6 text-xs text-muted-foreground text-center">
                      {creators.length === 0 ? 'No creators yet — add them from the Creators page.' : 'No creators match.'}
                    </p>
                  ) : filteredCreators.map(c => (
                    <label key={c.id} className="flex items-center gap-3 px-3 py-2 hover:bg-accent cursor-pointer">
                      <input type="checkbox" checked={form.creatorIds.includes(c.id)} onChange={() => toggleCreator(c.id)} />
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-medium text-foreground truncate">@{c.handle}</p>
                        <p className="text-[11px] text-muted-foreground truncate">{c.geography} · {c.type}</p>
                      </div>
                    </label>
                  ))}
                </div>
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
                <p><strong>{form.name}</strong> · {form.startDate}{form.endDate && ` → ${form.endDate}`}{form.state && ` · ${form.state}`}</p>
                <p>{form.budgetPosts} posts · {form.budgetStories} stories · {form.budgetReels} reels</p>
                <p>{form.pageIds.length} pages · {form.creatorIds.length} creators · {form.variantsRaw.split(',').filter(Boolean).length} variants</p>
              </div>
            </>
          )}
        </div>

        {submitError && (
          <div className="px-4 py-2 text-xs text-rose-700 bg-rose-50 border-t border-rose-200">{submitError}</div>
        )}
        <div className="flex items-center justify-between p-4 border-t border-border">
          <button onClick={() => step > 1 ? setStep(step - 1) : onClose()}
            disabled={submitting}
            className="px-4 py-2 rounded-lg border border-border text-sm text-muted-foreground hover:bg-accent disabled:opacity-40">
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
              disabled={submitting}
              className="px-4 py-2 rounded-lg bg-orange-600 text-white text-sm font-medium hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed">
              {submitting ? 'Creating…' : 'Create campaign'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Import Campaigns via Excel ─────────────────────────────────────────────

// Accept "DD/MM/YYYY", "DD-MM-YYYY", "YYYY-MM-DD" (and Excel serials) →
// normalise to ISO YYYY-MM-DD. Returns '' when unparseable.
function normalizeDate(raw: string): string {
  const s = raw.trim()
  if (!s) return ''
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  // Excel sometimes hands us a serial date number when cells are date-typed.
  if (/^\d{4,6}$/.test(s)) {
    const serial = parseInt(s, 10)
    const ms = (serial - 25569) * 86400_000 // 25569 = days between 1899-12-30 and epoch
    const d = new Date(ms)
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10)
  }
  const m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/)
  if (!m) return ''
  const [, d, mo, y] = m
  const yyyy = y.length === 2 ? `20${y}` : y
  return `${yyyy}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`
}

function ImportCampaignsModal({ onClose }: { onClose: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<{ created: number; skipped: string[] } | null>(null)

  async function onFile(file: File) {
    setBusy(true)
    try {
      const { headers, rows } = await parseSpreadsheet(file)
      let created = 0
      const skipped: string[] = []
      for (const row of rows) {
        const name = pick(row, headers, [/campaign.*name|name.*campaign/, /^name$/, /campaign/, /title/])
        if (!name) { skipped.push(`(row missing a campaign name)`); continue }
        const startRaw = pick(row, headers, [/start/, /from/, /^date$/, /launch/])
        const endRaw = pick(row, headers, [/end/, /finish/, /to\b/, /till/, /until/])
        const startDate = normalizeDate(startRaw) || new Date().toISOString().slice(0, 10)
        const endDate = normalizeDate(endRaw) || startDate
        const state = pick(row, headers, [/state/])
        const goal = pick(row, headers, [/description|desc\b/, /goal/, /brief/, /note/, /kpi/])
        try {
          await addCampaign({
            name: name.trim(), startDate, endDate, state: state.trim(), goal: goal.trim(),
            status: 'planning', budgetPosts: 0, budgetStories: 0, budgetReels: 0,
            approvers: [], creativeVariants: [], assignedPageIds: [], assignedCreatorIds: [],
          })
          created++
        } catch (err) {
          skipped.push(`"${name}" — ${err instanceof Error ? err.message : 'failed'}`)
        }
      }
      setDone({ created, skipped })
    } catch (err) {
      setDone({ created: 0, skipped: [err instanceof Error ? err.message : 'Could not read the file.'] })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4 animate-fade-in" onClick={onClose}>
      <div className="bg-card rounded-xl border border-border w-full max-w-lg" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between p-4 border-b border-border">
          <div>
            <h2 className="text-base font-serif text-foreground">Import campaigns from Excel</h2>
            <p className="text-xs text-muted-foreground">Bulk-create campaigns from an .xlsx / .csv. Columns are matched automatically.</p>
          </div>
          <button onClick={onClose} className="p-2 rounded-lg hover:bg-accent text-muted-foreground"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-4 space-y-3">
          {!done ? (
            <div className="text-center py-6">
              <Upload className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
              <p className="text-sm text-foreground mb-1">Choose a spreadsheet to upload</p>
              <p className="text-xs text-muted-foreground mb-4">Recognised columns: name, start date, end date, state, description.</p>
              <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden"
                onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f) }} />
              <button onClick={() => fileRef.current?.click()} disabled={busy}
                className="px-4 py-2 rounded-lg bg-orange-600 text-white text-sm font-medium hover:opacity-90 disabled:opacity-50">
                {busy ? 'Importing…' : 'Select file'}
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="hub-card bg-emerald-50 border-emerald-200 text-sm text-emerald-900 flex items-center gap-2">
                <CheckCircle className="w-4 h-4" /> Imported {done.created} campaign{done.created === 1 ? '' : 's'}.
              </div>
              {done.skipped.length > 0 && (
                <div className="hub-card bg-amber-50 border-amber-200 text-xs text-amber-900">
                  <p className="flex items-center gap-1.5 font-semibold mb-2"><AlertCircle className="w-4 h-4" /> Skipped {done.skipped.length}</p>
                  <ul className="space-y-0.5 max-h-40 overflow-y-auto">
                    {done.skipped.slice(0, 30).map((s, i) => <li key={i}>· {s}</li>)}
                    {done.skipped.length > 30 && <li className="text-amber-700">…and {done.skipped.length - 30} more</li>}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 p-4 border-t border-border">
          <button onClick={onClose} className="px-4 py-2 rounded-lg border border-border text-sm text-muted-foreground hover:bg-accent">
            {done ? 'Done' : 'Cancel'}
          </button>
        </div>
      </div>
    </div>
  )
}
