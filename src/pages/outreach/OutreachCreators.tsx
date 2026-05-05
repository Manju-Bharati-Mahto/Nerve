import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Users, Search, ArrowUpDown, ArrowUp, ArrowDown, ChevronRight, Filter as FilterIcon,
} from 'lucide-react'
import {
  useOutreachData, pageMetrics,
  type PageType, type FollowerTier,
} from '@/lib/outreach-data'

type SortKey = 'handle' | 'geography' | 'inventory' | 'mtd' | 'pct' | 'eng' | 'last' | 'status'
type SortDir = 'asc' | 'desc'
type InvFilter = 'all' | 'over-used' | 'under-used' | 'on-track' | 'idle'

const TABS: { id: PageType; label: string }[] = [
  { id: 'outreach', label: 'Outreach' },
  { id: 'ugc',      label: 'UGC' },
  { id: 'static',   label: 'Static' },
]

export default function OutreachCreators() {
  const { pages, posts } = useOutreachData()
  const [tab, setTab] = useState<PageType>('outreach')
  const [search, setSearch] = useState('')
  const [geography, setGeography] = useState<string>('')
  const [state, setState] = useState<string>('')
  const [inv, setInv] = useState<InvFilter>('all')
  const [tier, setTier] = useState<FollowerTier | ''>('')
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: 'pct', dir: 'desc' })

  const geographies = useMemo(() => Array.from(new Set(pages.map(p => p.geography))).sort(), [pages])
  const states = useMemo(() => Array.from(new Set(pages.map(p => p.state))).sort(), [pages])

  const counts = useMemo(() => ({
    outreach: pages.filter(p => p.type === 'outreach').length,
    ugc:      pages.filter(p => p.type === 'ugc').length,
    static:   pages.filter(p => p.type === 'static').length,
  }), [pages])

  const rows = useMemo(() => {
    const base = pages.filter(p => p.type === tab).map(page => ({ page, m: pageMetrics(page, posts) }))
    const q = search.trim().toLowerCase()
    const filtered = base.filter(({ page, m }) => {
      if (q && !page.handle.toLowerCase().includes(q)) return false
      if (geography && page.geography !== geography) return false
      if (state && page.state !== state) return false
      if (tier && page.followerTier !== tier) return false
      if (inv !== 'all' && m.status !== inv) return false
      return true
    })
    const dir = sort.dir === 'asc' ? 1 : -1
    filtered.sort((a, b) => {
      const k = sort.key
      const av: number | string =
        k === 'handle'    ? a.page.handle :
        k === 'geography' ? a.page.geography :
        k === 'inventory' ? a.page.inventoryPosts + a.page.inventoryStories :
        k === 'mtd'       ? a.m.postsDoneMTD + a.m.storiesDoneMTD :
        k === 'pct'       ? a.m.pctConsumed :
        k === 'eng'       ? a.m.avgEngagement :
        k === 'last'      ? (a.m.lastPostDate ?? '') :
        a.m.status
      const bv: number | string =
        k === 'handle'    ? b.page.handle :
        k === 'geography' ? b.page.geography :
        k === 'inventory' ? b.page.inventoryPosts + b.page.inventoryStories :
        k === 'mtd'       ? b.m.postsDoneMTD + b.m.storiesDoneMTD :
        k === 'pct'       ? b.m.pctConsumed :
        k === 'eng'       ? b.m.avgEngagement :
        k === 'last'      ? (b.m.lastPostDate ?? '') :
        b.m.status
      if (typeof av === 'string' && typeof bv === 'string') return av.localeCompare(bv) * dir
      return ((av as number) - (bv as number)) * dir
    })
    return filtered
  }, [pages, posts, tab, search, geography, state, tier, inv, sort])

  function toggleSort(key: SortKey) {
    setSort(s => s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'desc' })
  }

  return (
    <div className="animate-fade-in space-y-5">

      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-orange-100 flex items-center justify-center">
            <Users className="w-5 h-5 text-orange-600" />
          </div>
          <div>
            <h1 className="text-2xl font-serif text-foreground">Creators (Pages)</h1>
            <p className="text-sm text-muted-foreground">Directory of social media pages by type and geography.</p>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-border">
        {TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${tab === t.id
              ? 'border-orange-600 text-orange-700'
              : 'border-transparent text-muted-foreground hover:text-foreground'}`}>
            {t.label} <span className="ml-1.5 text-[10px] text-muted-foreground">({counts[t.id]})</span>
          </button>
        ))}
      </div>

      {/* Filters */}
      <div className="hub-card py-3">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="w-4 h-4 text-muted-foreground absolute left-3 top-1/2 -translate-y-1/2" />
            <input value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Search handle…"
              className="hub-input pl-9 py-1.5" />
          </div>
          <FilterIcon className="w-4 h-4 text-muted-foreground" />
          <select value={geography} onChange={e => setGeography(e.target.value)} className="hub-input py-1.5 text-xs w-36">
            <option value="">All geographies</option>
            {geographies.map(g => <option key={g} value={g}>{g}</option>)}
          </select>
          <select value={state} onChange={e => setState(e.target.value)} className="hub-input py-1.5 text-xs w-32">
            <option value="">All states</option>
            {states.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          <select value={tier} onChange={e => setTier(e.target.value as FollowerTier | '')} className="hub-input py-1.5 text-xs w-32">
            <option value="">Any tier</option>
            <option value="nano">Nano (&lt;10k)</option>
            <option value="micro">Micro (10–50k)</option>
            <option value="mid">Mid (50–250k)</option>
            <option value="macro">Macro (250k+)</option>
          </select>
          <select value={inv} onChange={e => setInv(e.target.value as InvFilter)} className="hub-input py-1.5 text-xs w-36">
            <option value="all">Any inventory</option>
            <option value="over-used">Over-used (≥90%)</option>
            <option value="on-track">On-track</option>
            <option value="under-used">Under-used (&lt;30%)</option>
            <option value="idle">Idle (no posts)</option>
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
              <Th label="State"       sk="geography" sort={sort} onClick={toggleSort} hidden />
              <Th label="Inventory"   sk="inventory" sort={sort} onClick={toggleSort} className="text-right" />
              <Th label="Done MTD"    sk="mtd"       sort={sort} onClick={toggleSort} className="text-right" />
              <Th label="% consumed"  sk="pct"       sort={sort} onClick={toggleSort} className="text-right" />
              <Th label="Avg eng"     sk="eng"       sort={sort} onClick={toggleSort} className="text-right" />
              <Th label="Last post"   sk="last"      sort={sort} onClick={toggleSort} />
              <Th label="Status"      sk="status"    sort={sort} onClick={toggleSort} />
              <th className="px-3 py-2 w-8"></th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={9} className="px-3 py-12 text-center text-sm text-muted-foreground">No pages match these filters.</td></tr>
            ) : rows.map(({ page, m }) => (
              <tr key={page.id} className="border-b border-border last:border-0 hover:bg-accent/40 transition-colors">
                <td className="px-3 py-2.5">
                  <Link to={`/outreach/creators/${page.id}`} className="flex items-center gap-2 group">
                    <div className="w-7 h-7 rounded-full bg-orange-100 flex items-center justify-center shrink-0">
                      <span className="text-[10px] font-semibold text-orange-700">{page.handle[0]?.toUpperCase()}</span>
                    </div>
                    <div className="min-w-0">
                      <p className="text-xs font-medium text-foreground truncate group-hover:underline">@{page.handle}</p>
                      <p className="text-[10px] text-muted-foreground">{fmt(page.followers)} followers · {page.followerTier}</p>
                    </div>
                  </Link>
                </td>
                <td className="px-3 py-2.5 text-xs text-foreground">{page.geography}</td>
                <td className="px-3 py-2.5 text-xs text-muted-foreground hidden">{page.state}</td>
                <td className="px-3 py-2.5 text-right text-xs font-mono tabular-nums text-foreground">{page.inventoryPosts}/{page.inventoryStories}</td>
                <td className="px-3 py-2.5 text-right text-xs font-mono tabular-nums text-foreground">{m.postsDoneMTD + m.storiesDoneMTD}</td>
                <td className="px-3 py-2.5 text-right">
                  <PctBar pct={m.pctConsumed} />
                </td>
                <td className="px-3 py-2.5 text-right text-xs font-mono tabular-nums text-foreground">{fmt(m.avgEngagement)}</td>
                <td className="px-3 py-2.5 text-xs text-muted-foreground">{m.lastPostDate ?? '—'}</td>
                <td className="px-3 py-2.5"><StatusBadge status={m.status} /></td>
                <td className="px-3 py-2.5 text-muted-foreground"><ChevronRight className="w-4 h-4" /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

    </div>
  )
}

function Th({ label, sk, sort, onClick, className = '', hidden = false }:
  { label: string; sk: SortKey; sort: { key: SortKey; dir: SortDir }; onClick: (k: SortKey) => void; className?: string; hidden?: boolean }) {
  if (hidden) return <th className="hidden">{label}</th>
  const Icon = sort.key !== sk ? ArrowUpDown : sort.dir === 'asc' ? ArrowUp : ArrowDown
  return (
    <th className={`px-3 py-2 ${className}`}>
      <button onClick={() => onClick(sk)} className="inline-flex items-center gap-1 hover:text-foreground transition-colors">
        {label} <Icon className="w-3 h-3" />
      </button>
    </th>
  )
}

function PctBar({ pct }: { pct: number }) {
  const clamped = Math.max(0, Math.min(1, pct))
  const color = clamped >= 0.9 ? 'bg-rose-500' : clamped >= 0.6 ? 'bg-amber-500' : clamped >= 0.3 ? 'bg-emerald-500' : 'bg-blue-400'
  return (
    <div className="inline-flex items-center gap-2">
      <div className="w-16 h-1.5 rounded-full bg-muted overflow-hidden">
        <div className={`h-full ${color}`} style={{ width: `${clamped * 100}%` }} />
      </div>
      <span className="text-xs font-mono tabular-nums text-foreground w-9 text-right">{Math.round(clamped * 100)}%</span>
    </div>
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

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}
