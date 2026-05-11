import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  FileText, Search, Filter as FilterIcon, Download, Plus,
  ArrowUpDown, ArrowUp, ArrowDown, Sparkles,
} from 'lucide-react'
import {
  useOutreachData, pageMetrics, suggestedMonthlyUsage,
  PAGE_TYPES, type PageType,
} from '@/lib/outreach-data'
import { AddPageModal } from './OutreachAnalytics'

type SortKey = 'handle' | 'geography' | 'type' | 'total' | 'consumed' | 'suggested' | 'status'
type SortDir = 'asc' | 'desc'

export default function OutreachAllPages() {
  const { pages, posts } = useOutreachData()

  const [search, setSearch] = useState('')
  const [type, setType] = useState<PageType | ''>('')
  const [geography, setGeography] = useState<string>('')
  const [invStatus, setInvStatus] = useState<'all' | 'over-used' | 'under-used' | 'on-track' | 'idle'>('all')
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: 'consumed', dir: 'desc' })
  const [creating, setCreating] = useState(false)

  const geographies = useMemo(() => Array.from(new Set(pages.map(p => p.geography))).sort(), [pages])

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
      if (type && page.type !== type) return false
      if (geography && page.geography !== geography) return false
      if (invStatus !== 'all' && m.status !== invStatus) return false
      return true
    })
    const dir = sort.dir === 'asc' ? 1 : -1
    filtered.sort((a, b) => {
      const k = sort.key
      const av: number | string =
        k === 'handle'    ? a.page.handle :
        k === 'geography' ? a.page.geography :
        k === 'type'      ? a.page.type :
        k === 'total'     ? a.total :
        k === 'consumed'  ? a.consumed :
        k === 'suggested' ? a.suggested :
        a.m.status
      const bv: number | string =
        k === 'handle'    ? b.page.handle :
        k === 'geography' ? b.page.geography :
        k === 'type'      ? b.page.type :
        k === 'total'     ? b.total :
        k === 'consumed'  ? b.consumed :
        k === 'suggested' ? b.suggested :
        b.m.status
      if (typeof av === 'string' && typeof bv === 'string') return av.localeCompare(bv) * dir
      return ((av as number) - (bv as number)) * dir
    })
    return filtered
  }, [pages, posts, search, type, geography, invStatus, sort])

  function toggleSort(key: SortKey) {
    setSort(s => s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'desc' })
  }

  function exportCSV() {
    const header = ['handle', 'geography', 'state', 'type', 'total_inventory', 'consumed_inventory', 'suggested_per_month', 'status']
    const lines = rows.map(({ page, total, consumed, suggested, m }) => [
      page.handle, page.geography, page.state, page.type, total, consumed, suggested, m.status,
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
          <select value={type} onChange={e => setType(e.target.value as PageType | '')} className="hub-input py-1.5 text-xs w-28">
            <option value="">Any type</option>
            {PAGE_TYPES.map(t => <option key={t} value={t}>{t === 'pu' ? 'PU' : 'State'}</option>)}
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
          <span className="text-xs text-muted-foreground ml-auto">{rows.length} pages</span>
        </div>
      </div>

      {/* Table */}
      <div className="hub-card p-0 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-widest text-muted-foreground border-b border-border">
              <Th label="Handle"      sk="handle"    sort={sort} onClick={toggleSort} />
              <Th label="Geography"   sk="geography" sort={sort} onClick={toggleSort} />
              <Th label="Type"        sk="type"      sort={sort} onClick={toggleSort} />
              <Th label="Total inv."  sk="total"     sort={sort} onClick={toggleSort} className="text-right" />
              <Th label="Consumed"    sk="consumed"  sort={sort} onClick={toggleSort} className="text-right" />
              <Th label="AI suggested / mo" sk="suggested" sort={sort} onClick={toggleSort} className="text-right" />
              <Th label="Status"      sk="status"    sort={sort} onClick={toggleSort} />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={7} className="px-3 py-12 text-center text-sm text-muted-foreground">No pages match these filters.</td></tr>
            ) : rows.map(({ page, m, total, consumed, suggested }) => (
              <tr key={page.id} className="border-b border-border last:border-0 hover:bg-accent/40 transition-colors">
                <td className="px-3 py-2.5">
                  <Link to={`/outreach/creators/${page.id}`} className="text-xs font-medium text-foreground hover:underline">@{page.handle}</Link>
                </td>
                <td className="px-3 py-2.5 text-xs text-foreground">{page.geography}</td>
                <td className="px-3 py-2.5"><span className="hub-badge bg-orange-50 text-orange-700 uppercase text-[10px]">{page.type}</span></td>
                <td className="px-3 py-2.5 text-right text-xs font-mono tabular-nums text-foreground">{total}</td>
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
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {creating && <AddPageModal onClose={() => setCreating(false)} />}
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
