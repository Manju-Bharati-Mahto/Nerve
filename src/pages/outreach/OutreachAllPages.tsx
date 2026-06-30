import { useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import {
  FileText, Search, Filter as FilterIcon, Download, Plus,
  ArrowUpDown, ArrowUp, ArrowDown, Sparkles, ExternalLink, Trash2, LinkIcon,
  Upload, X, CheckCircle, AlertCircle,
} from 'lucide-react'
import {
  useOutreachData, pageMetrics, suggestedMonthlyUsage, removePage,
  instagramUrlForHandle, isValidInstagramHandle, assignedPageIdSet, addPage, parseInstagramHandle,
  PAGE_CONTENT_TYPES, FOLLOWER_TIERS, type FollowerTier, type PageContentType, type OutreachPage,
} from '@/lib/outreach-data'
import { parseSpreadsheet, pick } from '@/lib/outreach-import'
import { AddPageModal } from './OutreachAnalytics'
import AddLivePostsDialog from './AddLivePostsDialog'

type SortKey = 'handle' | 'tier' | 'geography' | 'total' | 'consumed' | 'suggested' | 'status'
type SortDir = 'asc' | 'desc'

export default function OutreachAllPages() {
  const { pages, posts, campaigns } = useOutreachData()
  const assigned = useMemo(() => assignedPageIdSet(campaigns), [campaigns])
  const [searchParams] = useSearchParams()
  // Pages to highlight, sourced from ?ids=ID1,ID2 (e.g. coming from the
  // dashboard's "X pages have not posted this month" alert).
  const highlightIds = useMemo(() => {
    const raw = searchParams.get('ids')
    return new Set(raw ? raw.split(',').map(s => s.trim()).filter(Boolean) : [])
  }, [searchParams])

  const [search, setSearch] = useState('')
  const [tier, setTier] = useState<FollowerTier | ''>('')
  const [contentTypeFilter, setContentTypeFilter] = useState<Set<PageContentType>>(new Set())
  const [geography, setGeography] = useState<string>('')
  const [invStatus, setInvStatus] = useState<'all' | 'over-used' | 'under-used' | 'on-track' | 'idle'>(
    // If we arrived from the idle-pages alert, default the filter to idle so the
    // user sees the relevant set right away.
    searchParams.get('filter') === 'idle' ? 'idle' : 'all',
  )
  const [inventoryFilter, setInventoryFilter] = useState<'all' | 'assigned' | 'available'>('all')
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: 'consumed', dir: 'desc' })
  const [creating, setCreating] = useState(false)
  const [importing, setImporting] = useState(false)
  // Which page is currently the target of the "Add live posts" dialog (null = closed).
  const [livePostsPageId, setLivePostsPageId] = useState<string | null>(null)

  const geographies = useMemo(() => Array.from(new Set(pages.map(p => p.geography))).sort(), [pages])

  function toggleContentType(t: PageContentType) {
    setContentTypeFilter(prev => {
      const next = new Set(prev)
      if (next.has(t)) next.delete(t); else next.add(t)
      return next
    })
  }

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase()
    const enriched = pages.map(p => {
      const m = pageMetrics(p, posts)
      const total = p.inventoryPosts + p.inventoryStories
      const consumed = m.postsDoneMTD + m.storiesDoneMTD
      return { page: p, m, total, consumed, suggested: suggestedMonthlyUsage(p, posts) }
    })
    const filtered = enriched.filter(({ page, m }) => {
      if (q && !`${page.handle} ${page.geography}`.toLowerCase().includes(q)) return false
      if (tier && page.followerTier !== tier) return false
      if (geography && page.geography !== geography) return false
      if (invStatus !== 'all' && m.status !== invStatus) return false
      if (inventoryFilter === 'assigned' && !assigned.has(page.id)) return false
      if (inventoryFilter === 'available' && assigned.has(page.id)) return false
      // Content-type filter: page must have AT LEAST ONE of the selected types.
      if (contentTypeFilter.size > 0 && !page.contentTypes.some(t => contentTypeFilter.has(t))) return false
      return true
    })
    const dir = sort.dir === 'asc' ? 1 : -1
    filtered.sort((a, b) => {
      const k = sort.key
      const av: number | string =
        k === 'handle'    ? a.page.handle :
        k === 'tier'      ? a.page.followerTier :
        k === 'geography' ? a.page.geography :
        k === 'total'     ? a.total :
        k === 'consumed'  ? a.consumed :
        k === 'suggested' ? a.suggested :
        a.m.status
      const bv: number | string =
        k === 'handle'    ? b.page.handle :
        k === 'tier'      ? b.page.followerTier :
        k === 'geography' ? b.page.geography :
        k === 'total'     ? b.total :
        k === 'consumed'  ? b.consumed :
        k === 'suggested' ? b.suggested :
        b.m.status
      if (typeof av === 'string' && typeof bv === 'string') return av.localeCompare(bv) * dir
      return ((av as number) - (bv as number)) * dir
    })
    return filtered
  }, [pages, posts, search, tier, contentTypeFilter, geography, invStatus, inventoryFilter, assigned, sort])

  async function confirmDelete(page: OutreachPage) {
    const linked = posts.filter(p => p.pageId === page.id).length
    const msg = linked > 0
      ? `Delete @${page.handle}? This will also remove ${linked} post${linked === 1 ? '' : 's'}. This cannot be undone.`
      : `Delete @${page.handle}? This cannot be undone.`
    if (!window.confirm(msg)) return
    try { await removePage(page.id) }
    catch (err) { alert(err instanceof Error ? err.message : 'Failed to delete page.') }
  }

  function toggleSort(key: SortKey) {
    setSort(s => s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'desc' })
  }

  function exportCSV() {
    const header = ['handle', 'tier', 'geography', 'state', 'total_inventory', 'consumed_inventory', 'suggested_per_month', 'status', 'inventory_status']
    const lines = rows.map(({ page, total, consumed, suggested, m }) => [
      page.handle, page.followerTier, page.geography, page.state, total, consumed, suggested, m.status,
      assigned.has(page.id) ? 'assigned' : 'available',
    ].join(','))
    const csv = [header.join(','), ...lines].join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `outreach-all-pages-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="animate-fade-in space-y-5">

      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-orange-100 flex items-center justify-center">
            <FileText className="w-5 h-5 text-orange-600" />
          </div>
          <div>
            <h1 className="text-2xl font-serif text-foreground">All Pages</h1>
            <p className="text-sm text-muted-foreground">Inventory ledger across every page — total, consumed, and AI-suggested monthly pace.</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setCreating(true)} className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium bg-orange-600 text-white hover:opacity-90">
            <Plus className="w-4 h-4" /> Add page
          </button>
          <button onClick={() => setImporting(true)} className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium border border-border hover:bg-accent">
            <Upload className="w-4 h-4" /> Import Excel
          </button>
          <button onClick={exportCSV} className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium border border-border hover:bg-accent">
            <Download className="w-4 h-4" /> Export CSV
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="hub-card py-3">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="w-4 h-4 text-muted-foreground absolute left-3 top-1/2 -translate-y-1/2" />
            <input value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Search handle or geography…"
              className="hub-input pl-9 py-1.5" />
          </div>
          <FilterIcon className="w-4 h-4 text-muted-foreground" />
          <select value={tier} onChange={e => setTier(e.target.value as FollowerTier | '')} className="hub-input py-1.5 text-xs w-28">
            <option value="">Any tier</option>
            {FOLLOWER_TIERS.map(t => <option key={t} value={t}>Tier {t}</option>)}
          </select>
          <select value={geography} onChange={e => setGeography(e.target.value)} className="hub-input py-1.5 text-xs w-36">
            <option value="">Any geography</option>
            {geographies.map(g => <option key={g} value={g}>{g}</option>)}
          </select>
          <select value={invStatus} onChange={e => setInvStatus(e.target.value as typeof invStatus)} className="hub-input py-1.5 text-xs w-36">
            <option value="all">Any status</option>
            <option value="over-used">Over-used</option>
            <option value="on-track">On-track</option>
            <option value="under-used">Under-used</option>
            <option value="idle">Idle</option>
          </select>
          <select value={inventoryFilter} onChange={e => setInventoryFilter(e.target.value as typeof inventoryFilter)} className="hub-input py-1.5 text-xs w-36">
            <option value="all">All inventory</option>
            <option value="assigned">Assigned</option>
            <option value="available">Available</option>
          </select>
          <span className="text-xs text-muted-foreground ml-auto">{rows.length} pages</span>
        </div>
        {/* Content-type chips — multi-select. Page matches if it has at least
            one of the selected content types. */}
        <div className="flex items-center gap-2 mt-2 flex-wrap">
          <span className="text-[11px] uppercase tracking-widest text-muted-foreground">Content type</span>
          {PAGE_CONTENT_TYPES.map(t => {
            const selected = contentTypeFilter.has(t)
            return (
              <button key={t} type="button" onClick={() => toggleContentType(t)}
                className={`text-[11px] px-2.5 py-1 rounded-lg border transition-colors capitalize ${
                  selected
                    ? 'bg-orange-100 border-orange-300 text-orange-700 font-medium'
                    : 'bg-card border-border text-muted-foreground hover:bg-accent'
                }`}>
                {t}
              </button>
            )
          })}
          {contentTypeFilter.size > 0 && (
            <button type="button" onClick={() => setContentTypeFilter(new Set())}
              className="text-[11px] text-muted-foreground hover:text-foreground underline">
              Clear
            </button>
          )}
        </div>
      </div>

      {/* Table */}
      <div className="hub-card p-0 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-widest text-muted-foreground border-b border-border">
              <Th label="Handle"      sk="handle"    sort={sort} onClick={toggleSort} />
              <Th label="Tier"        sk="tier"      sort={sort} onClick={toggleSort} />
              <Th label="Geography"   sk="geography" sort={sort} onClick={toggleSort} />
              <Th label="Total inv."  sk="total"     sort={sort} onClick={toggleSort} className="text-right" />
              <Th label="Consumed"    sk="consumed"  sort={sort} onClick={toggleSort} className="text-right" />
              <Th label="AI suggested / mo" sk="suggested" sort={sort} onClick={toggleSort} className="text-right" />
              <Th label="Status"      sk="status"    sort={sort} onClick={toggleSort} />
              <th className="px-3 py-2">Inventory</th>
              <th className="px-3 py-2 w-8"></th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={9} className="px-3 py-12 text-center text-sm text-muted-foreground">No pages match these filters.</td></tr>
            ) : rows.map(({ page, m, consumed, suggested }) => (
              <tr key={page.id} className={`border-b border-border last:border-0 transition-colors ${
                highlightIds.has(page.id) ? 'bg-orange-50 hover:bg-orange-100' : 'hover:bg-accent/40'
              }`}>
                <td className="px-3 py-2.5">
                  <div className="flex items-center gap-1.5">
                    <Link to={`/outreach/pages/${page.id}`} className="text-xs font-medium text-foreground hover:underline">@{page.handle}</Link>
                    {isValidInstagramHandle(page.handle) && (
                      <a href={instagramUrlForHandle(page.handle)} target="_blank" rel="noreferrer"
                        title={`Open @${page.handle} on Instagram`}
                        className="text-muted-foreground hover:text-orange-600">
                        <ExternalLink className="w-3 h-3" />
                      </a>
                    )}
                  </div>
                </td>
                <td className="px-3 py-2.5">
                  <span className="hub-badge bg-orange-50 text-orange-700 text-[10px]">Tier {page.followerTier}</span>
                </td>
                <td className="px-3 py-2.5 text-xs text-foreground">{page.geography}</td>
                <td className="px-3 py-2.5 text-right text-xs font-mono tabular-nums text-foreground whitespace-nowrap">
                  {page.inventoryPosts} <span className="text-[10px] text-muted-foreground">(Posts)</span>
                  <span className="text-muted-foreground"> & </span>
                  {page.inventoryStories} <span className="text-[10px] text-muted-foreground">(Stories)</span>
                </td>
                <td className="px-3 py-2.5 text-right text-xs font-mono tabular-nums text-foreground">
                  {consumed}
                  <span className="text-[10px] text-muted-foreground"> ({Math.round(m.pctConsumed * 100)}%)</span>
                </td>
                <td className="px-3 py-2.5 text-right">
                  <span className="inline-flex items-center gap-1 text-xs font-mono tabular-nums text-foreground">
                    <Sparkles className="w-3 h-3 text-amber-500" /> {suggested}
                  </span>
                </td>
                <td className="px-3 py-2.5"><StatusBadge status={m.status} /></td>
                <td className="px-3 py-2.5">
                  {assigned.has(page.id)
                    ? <span className="hub-badge bg-blue-100 text-blue-700">Assigned</span>
                    : <span className="hub-badge bg-emerald-100 text-emerald-700">Available</span>}
                </td>
                <td className="px-3 py-2.5">
                  <div className="flex items-center gap-1">
                    <button onClick={() => setLivePostsPageId(page.id)}
                      title="Add live posts to this page"
                      className="p-1 rounded-md text-muted-foreground hover:bg-orange-50 hover:text-orange-600">
                      <LinkIcon className="w-3.5 h-3.5" />
                    </button>
                    <button onClick={() => confirmDelete(page)}
                      title="Delete page"
                      className="p-1 rounded-md text-muted-foreground hover:bg-rose-50 hover:text-rose-600">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {creating && <AddPageModal onClose={() => setCreating(false)} />}
      {importing && <ImportPagesModal onClose={() => setImporting(false)} />}
      {livePostsPageId && (
        <AddLivePostsDialog
          mode="page"
          pageId={livePostsPageId}
          onClose={() => setLivePostsPageId(null)}
        />
      )}
    </div>
  )
}

function ImportPagesModal({ onClose }: { onClose: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [step, setStep] = useState<'file' | 'done'>('file')
  const [busy, setBusy] = useState(false)
  const [createdCount, setCreatedCount] = useState(0)
  const [skipped, setSkipped] = useState<string[]>([])

  function digits(s: string): string {
    return (s.match(/\d+/g) || []).join('')
  }

  async function onFile(file: File) {
    setBusy(true)
    let created = 0
    const skip: string[] = []
    try {
      const { headers, rows } = await parseSpreadsheet(file)
      for (const row of rows) {
        const handleRaw = pick(row, headers, [/handle/, /instagram/, /username/, /url/, /account/, /page/, /name/])
        const handle = parseInstagramHandle(handleRaw)
        if (!handle) {
          skip.push(`empty handle: ${Object.values(row).slice(0, 3).join(' | ')}`)
          continue
        }

        const state = pick(row, headers, [/state/])
        const geoRaw = pick(row, headers, [/geograph/, /city/, /region/, /area/, /location/])
        const geography = geoRaw || state
        const type: 'state' | 'pu' =
          pick(row, headers, [/type/]).toLowerCase() === 'pu' ? 'pu' : 'state'

        const tierDigit = digits(pick(row, headers, [/tier/])).charAt(0)
        const followerTier = (['1', '2', '3', '4', '5'].includes(tierDigit) ? tierDigit : '1') as FollowerTier

        const followers = parseInt(digits(pick(row, headers, [/follower/])) || '0', 10) || 0
        const inventoryPosts = parseInt(
          digits(pick(row, headers, [/inventory.*post|post.*inventory|^posts?$|inv.*post/])) || '0', 10,
        ) || 0
        const inventoryStories = parseInt(digits(pick(row, headers, [/stor/])) || '0', 10) || 0
        const notes = pick(row, headers, [/note/, /remark/])

        try {
          await addPage({
            handle, geography, state, type, followerTier,
            contentTypes: [], followers, inventoryPosts, inventoryStories, notes,
          })
          created++
        } catch (err) {
          skip.push(`@${handle}: ${err instanceof Error ? err.message : 'failed to add'}`)
        }
      }
    } catch (err) {
      skip.push(`could not read file: ${err instanceof Error ? err.message : 'parse error'}`)
    } finally {
      setCreatedCount(created)
      setSkipped(skip)
      setStep('done')
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4 animate-fade-in">
      <div className="bg-card rounded-xl border border-border w-full max-w-2xl max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between p-4 border-b border-border">
          <div>
            <h2 className="text-base font-serif text-foreground">Import Pages via Excel</h2>
            <p className="text-xs text-muted-foreground">Upload a spreadsheet — pages are automatically detected and separated by state from the data.</p>
          </div>
          <button onClick={onClose} className="p-2 rounded-lg hover:bg-accent text-muted-foreground"><X className="w-4 h-4" /></button>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {step === 'file' && (
            <div className="text-center py-8">
              <Upload className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
              <p className="text-sm text-foreground mb-1">Choose an Excel or CSV file to upload</p>
              <p className="text-xs text-muted-foreground mb-4">Columns like handle, state, geography, type, tier, followers, inventory and notes are detected automatically.</p>
              <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden"
                onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f) }} />
              <button onClick={() => fileRef.current?.click()} disabled={busy}
                className="px-4 py-2 rounded-lg bg-orange-600 text-white text-sm font-medium hover:opacity-90 disabled:opacity-60">
                {busy ? 'Importing…' : 'Select file'}
              </button>
            </div>
          )}

          {step === 'done' && (
            <div className="space-y-3">
              <div className="hub-card bg-emerald-50 border-emerald-200 text-sm text-emerald-900 flex items-center gap-2">
                <CheckCircle className="w-4 h-4" /> Imported {createdCount} pages.
              </div>
              {skipped.length > 0 && (
                <div className="hub-card bg-amber-50 border-amber-200 text-xs text-amber-900">
                  <p className="flex items-center gap-1.5 font-semibold mb-2"><AlertCircle className="w-4 h-4" /> Skipped {skipped.length} rows</p>
                  <ul className="space-y-0.5 max-h-40 overflow-y-auto font-mono">
                    {skipped.slice(0, 30).map((s, i) => <li key={i}>· {s}</li>)}
                    {skipped.length > 30 && <li className="text-amber-700">…and {skipped.length - 30} more</li>}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end p-4 border-t border-border">
          <button onClick={onClose} disabled={busy}
            className="px-4 py-2 rounded-lg border border-border text-sm text-muted-foreground hover:bg-accent disabled:opacity-60">
            {step === 'done' ? 'Close' : 'Cancel'}
          </button>
        </div>
      </div>
    </div>
  )
}

function Th({ label, sk, sort, onClick, className = '' }:
  { label: string; sk: SortKey; sort: { key: SortKey; dir: SortDir }; onClick: (k: SortKey) => void; className?: string }) {
  const Icon = sort.key !== sk ? ArrowUpDown : sort.dir === 'asc' ? ArrowUp : ArrowDown
  return (
    <th className={`px-3 py-2 ${className}`}>
      <button onClick={() => onClick(sk)} className="inline-flex items-center gap-1 hover:text-foreground transition-colors">
        {label} <Icon className="w-3 h-3" />
      </button>
    </th>
  )
}

function StatusBadge({ status }: { status: 'over-used' | 'under-used' | 'on-track' | 'idle' }) {
  const map = {
    'over-used':  { label: 'Over-used',  cls: 'bg-rose-100 text-rose-700' },
    'on-track':   { label: 'On-track',   cls: 'bg-emerald-100 text-emerald-700' },
    'under-used': { label: 'Under-used', cls: 'bg-amber-100 text-amber-700' },
    'idle':       { label: 'Idle',       cls: 'bg-muted text-muted-foreground' },
  }
  const m = map[status]
  return <span className={`hub-badge ${m.cls}`}>{m.label}</span>
}
