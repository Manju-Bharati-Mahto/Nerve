import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  FileText, Search, Filter as FilterIcon, Download, CheckSquare, Square,
  Heart, MessageSquare, Eye, Bookmark, Share2, ArrowUpDown, ArrowUp, ArrowDown,
} from 'lucide-react'
import {
  useOutreachData, bulkUpdatePosts, pageMetrics,
  POST_TYPES, POST_STATUSES,
  type PostType, type PostStatus,
} from '@/lib/outreach-data'

type SortKey = 'date' | 'page' | 'campaign' | 'type' | 'likes' | 'comments' | 'views' | 'shares' | 'saves'
type SortDir = 'asc' | 'desc'

export default function OutreachAllPages() {
  const { posts, pages, campaigns } = useOutreachData()

  const [search, setSearch] = useState('')
  const [type, setType] = useState<PostType | ''>('')
  const [status, setStatus] = useState<PostStatus | ''>('')
  const [pageId, setPageId] = useState<string>('')
  const [campaignId, setCampaignId] = useState<string>('')
  const [geography, setGeography] = useState<string>('')
  const [from, setFrom] = useState<string>('')
  const [to, setTo] = useState<string>('')
  const [minEng, setMinEng] = useState<number>(0)
  const [invStatus, setInvStatus] = useState<'all' | 'over-used' | 'under-used' | 'on-track' | 'idle'>('all')
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: 'date', dir: 'desc' })
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const geographies = useMemo(() => Array.from(new Set(pages.map(p => p.geography))).sort(), [pages])

  const pageMap = useMemo(() => new Map(pages.map(p => [p.id, p])), [pages])
  const campaignMap = useMemo(() => new Map(campaigns.map(c => [c.id, c])), [campaigns])

  const pageInvStatus = useMemo(() => {
    const out = new Map<string, ReturnType<typeof pageMetrics>['status']>()
    for (const p of pages) out.set(p.id, pageMetrics(p, posts).status)
    return out
  }, [pages, posts])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    let out = posts.filter(p => {
      const page = pageMap.get(p.pageId)
      const camp = campaignMap.get(p.campaignId)
      if (q) {
        const blob = `${p.caption} ${page?.handle ?? ''} ${camp?.name ?? ''}`.toLowerCase()
        if (!blob.includes(q)) return false
      }
      if (type && p.type !== type) return false
      if (status && p.status !== status) return false
      if (pageId && p.pageId !== pageId) return false
      if (campaignId && p.campaignId !== campaignId) return false
      if (geography && page?.geography !== geography) return false
      if (from && p.date < from) return false
      if (to && p.date > to) return false
      const eng = p.likes + p.comments + p.saves + p.shares
      if (minEng && eng < minEng) return false
      if (invStatus !== 'all' && pageInvStatus.get(p.pageId) !== invStatus) return false
      return true
    })
    const dir = sort.dir === 'asc' ? 1 : -1
    out = out.sort((a, b) => {
      const k = sort.key
      const av: number | string =
        k === 'date'     ? a.date :
        k === 'page'     ? pageMap.get(a.pageId)?.handle ?? '' :
        k === 'campaign' ? campaignMap.get(a.campaignId)?.name ?? '' :
        k === 'type'     ? a.type :
        a[k]
      const bv: number | string =
        k === 'date'     ? b.date :
        k === 'page'     ? pageMap.get(b.pageId)?.handle ?? '' :
        k === 'campaign' ? campaignMap.get(b.campaignId)?.name ?? '' :
        k === 'type'     ? b.type :
        b[k]
      if (typeof av === 'string' && typeof bv === 'string') return av.localeCompare(bv) * dir
      return ((av as number) - (bv as number)) * dir
    })
    return out
  }, [posts, search, type, status, pageId, campaignId, geography, from, to, minEng, invStatus, sort, pageMap, campaignMap, pageInvStatus])

  function toggleSort(key: SortKey) {
    setSort(s => s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'desc' })
  }

  const visibleIds = useMemo(() => filtered.slice(0, 200).map(p => p.id), [filtered])
  const allSelected = visibleIds.length > 0 && visibleIds.every(id => selected.has(id))

  function toggleAll() {
    setSelected(s => {
      const next = new Set(s)
      if (allSelected) visibleIds.forEach(id => next.delete(id))
      else visibleIds.forEach(id => next.add(id))
      return next
    })
  }
  function toggleOne(id: string) {
    setSelected(s => {
      const next = new Set(s)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  function bulkPublish() {
    if (selected.size === 0) return
    bulkUpdatePosts(Array.from(selected), { status: 'published' })
    setSelected(new Set())
  }
  function bulkApprovalQueue() {
    if (selected.size === 0) return
    bulkUpdatePosts(Array.from(selected), { status: 'pending_approval' })
    setSelected(new Set())
  }

  function exportCSV() {
    const header = ['date', 'page', 'campaign', 'type', 'variant', 'status', 'likes', 'comments', 'views', 'saves', 'shares', 'caption']
    const rows = filtered.map(p => [
      p.date,
      pageMap.get(p.pageId)?.handle ?? '',
      campaignMap.get(p.campaignId)?.name ?? '',
      p.type,
      p.creativeVariant ?? '',
      p.status,
      p.likes, p.comments, p.views, p.saves, p.shares,
      `"${(p.caption ?? '').replace(/"/g, '""')}"`,
    ].join(','))
    const csv = [header.join(','), ...rows].join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `outreach-posts-${new Date().toISOString().slice(0, 10)}.csv`
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
            <p className="text-sm text-muted-foreground">Master record of every post across every page and campaign.</p>
          </div>
        </div>
        <button onClick={exportCSV} className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium border border-border hover:bg-accent">
          <Download className="w-4 h-4" /> Export CSV
        </button>
      </div>

      {/* Filters */}
      <div className="hub-card py-3 space-y-2">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="w-4 h-4 text-muted-foreground absolute left-3 top-1/2 -translate-y-1/2" />
            <input value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Search captions, handles, campaigns…"
              className="hub-input pl-9 py-1.5" />
          </div>
          <FilterIcon className="w-4 h-4 text-muted-foreground" />
          <select value={type} onChange={e => setType(e.target.value as PostType | '')} className="hub-input py-1.5 text-xs w-28">
            <option value="">Any type</option>
            {POST_TYPES.map(t => <option key={t} value={t} className="capitalize">{t}</option>)}
          </select>
          <select value={status} onChange={e => setStatus(e.target.value as PostStatus | '')} className="hub-input py-1.5 text-xs w-36">
            <option value="">Any status</option>
            {POST_STATUSES.map(s => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
          </select>
          <select value={pageId} onChange={e => setPageId(e.target.value)} className="hub-input py-1.5 text-xs w-40">
            <option value="">Any page</option>
            {pages.map(p => <option key={p.id} value={p.id}>@{p.handle}</option>)}
          </select>
          <select value={campaignId} onChange={e => setCampaignId(e.target.value)} className="hub-input py-1.5 text-xs w-40">
            <option value="">Any campaign</option>
            {campaigns.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <select value={geography} onChange={e => setGeography(e.target.value)} className="hub-input py-1.5 text-xs w-32">
            <option value="">Any geography</option>
            {geographies.map(g => <option key={g} value={g}>{g}</option>)}
          </select>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <label className="text-[11px] text-muted-foreground">Date</label>
          <input type="date" value={from} onChange={e => setFrom(e.target.value)} className="hub-input py-1.5 text-xs w-36" />
          <span className="text-xs text-muted-foreground">→</span>
          <input type="date" value={to} onChange={e => setTo(e.target.value)} className="hub-input py-1.5 text-xs w-36" />
          <label className="text-[11px] text-muted-foreground ml-2">Min engagement</label>
          <input type="number" min={0} value={minEng} onChange={e => setMinEng(Number(e.target.value) || 0)} className="hub-input py-1.5 text-xs w-24" />
          <select value={invStatus} onChange={e => setInvStatus(e.target.value as typeof invStatus)} className="hub-input py-1.5 text-xs w-36">
            <option value="all">Any inventory state</option>
            <option value="over-used">On over-used pages</option>
            <option value="on-track">On on-track pages</option>
            <option value="under-used">On under-used pages</option>
            <option value="idle">On idle pages</option>
          </select>
          <span className="text-xs text-muted-foreground ml-auto">{filtered.length} posts</span>
        </div>
      </div>

      {/* Bulk actions */}
      {selected.size > 0 && (
        <div className="hub-card py-2 flex items-center justify-between bg-orange-50 border-orange-200">
          <p className="text-xs text-orange-900"><strong>{selected.size}</strong> posts selected</p>
          <div className="flex items-center gap-2">
            <button onClick={bulkApprovalQueue} className="text-xs px-3 py-1.5 rounded-lg bg-amber-100 text-amber-700 hover:opacity-80">Send for approval</button>
            <button onClick={bulkPublish} className="text-xs px-3 py-1.5 rounded-lg bg-emerald-600 text-white hover:opacity-90">Mark as published</button>
            <button onClick={() => setSelected(new Set())} className="text-xs px-3 py-1.5 rounded-lg text-muted-foreground hover:bg-orange-100">Clear</button>
          </div>
        </div>
      )}

      {/* Table */}
      <div className="hub-card p-0 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-widest text-muted-foreground border-b border-border">
              <th className="px-2 py-2 w-8">
                <button onClick={toggleAll}>{allSelected ? <CheckSquare className="w-4 h-4 text-orange-600" /> : <Square className="w-4 h-4 text-muted-foreground" />}</button>
              </th>
              <Th label="Date"      sk="date"     sort={sort} onClick={toggleSort} />
              <Th label="Campaign"  sk="campaign" sort={sort} onClick={toggleSort} />
              <Th label="Page"      sk="page"     sort={sort} onClick={toggleSort} />
              <Th label="Type"      sk="type"     sort={sort} onClick={toggleSort} />
              <th className="px-3 py-2">Variant</th>
              <th className="px-3 py-2">Status</th>
              <Th label="Likes"     sk="likes"    sort={sort} onClick={toggleSort} className="text-right" icon={Heart} />
              <Th label="Comments"  sk="comments" sort={sort} onClick={toggleSort} className="text-right" icon={MessageSquare} />
              <Th label="Views"     sk="views"    sort={sort} onClick={toggleSort} className="text-right" icon={Eye} />
              <Th label="Saves"     sk="saves"    sort={sort} onClick={toggleSort} className="text-right" icon={Bookmark} />
              <Th label="Shares"    sk="shares"   sort={sort} onClick={toggleSort} className="text-right" icon={Share2} />
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr><td colSpan={12} className="px-3 py-12 text-center text-sm text-muted-foreground">No posts match these filters.</td></tr>
            ) : filtered.slice(0, 200).map(p => {
              const page = pageMap.get(p.pageId)
              const camp = campaignMap.get(p.campaignId)
              return (
                <tr key={p.id} className="border-b border-border last:border-0 hover:bg-accent/40 transition-colors">
                  <td className="px-2 py-2">
                    <button onClick={() => toggleOne(p.id)}>
                      {selected.has(p.id) ? <CheckSquare className="w-4 h-4 text-orange-600" /> : <Square className="w-4 h-4 text-muted-foreground" />}
                    </button>
                  </td>
                  <td className="px-3 py-2.5 text-xs text-foreground whitespace-nowrap">{p.date}</td>
                  <td className="px-3 py-2.5 text-xs text-foreground truncate max-w-[140px]">
                    {camp ? <Link to={`/outreach/campaigns/${camp.id}`} className="hover:underline">{camp.name}</Link> : '—'}
                  </td>
                  <td className="px-3 py-2.5 text-xs text-foreground truncate max-w-[140px]">
                    {page ? <Link to={`/outreach/creators/${page.id}`} className="hover:underline">@{page.handle}</Link> : '—'}
                  </td>
                  <td className="px-3 py-2.5"><span className="hub-badge bg-orange-50 text-orange-700 capitalize">{p.type}</span></td>
                  <td className="px-3 py-2.5 text-xs text-muted-foreground">{p.creativeVariant ?? '—'}</td>
                  <td className="px-3 py-2.5"><StatusBadge status={p.status} /></td>
                  <td className="px-3 py-2.5 text-right text-xs font-mono tabular-nums">{fmt(p.likes)}</td>
                  <td className="px-3 py-2.5 text-right text-xs font-mono tabular-nums">{fmt(p.comments)}</td>
                  <td className="px-3 py-2.5 text-right text-xs font-mono tabular-nums">{fmt(p.views)}</td>
                  <td className="px-3 py-2.5 text-right text-xs font-mono tabular-nums">{fmt(p.saves)}</td>
                  <td className="px-3 py-2.5 text-right text-xs font-mono tabular-nums">{fmt(p.shares)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {filtered.length > 200 && (
          <div className="p-3 text-center text-xs text-muted-foreground border-t border-border">
            Showing first 200 of {filtered.length} posts. Refine filters to narrow.
          </div>
        )}
      </div>

    </div>
  )
}

function Th({ label, sk, sort, onClick, className = '', icon: Icon }:
  { label: string; sk: SortKey; sort: { key: SortKey; dir: SortDir }; onClick: (k: SortKey) => void; className?: string; icon?: React.ElementType }) {
  const ArrowIcon = sort.key !== sk ? ArrowUpDown : sort.dir === 'asc' ? ArrowUp : ArrowDown
  return (
    <th className={`px-3 py-2 ${className}`}>
      <button onClick={() => onClick(sk)} className="inline-flex items-center gap-1 hover:text-foreground transition-colors">
        {Icon ? <Icon className="w-3 h-3" /> : null} {label} <ArrowIcon className="w-3 h-3" />
      </button>
    </th>
  )
}

function StatusBadge({ status }: { status: PostStatus }) {
  const map = {
    draft:             { label: 'Draft',    cls: 'bg-muted text-muted-foreground' },
    scheduled:         { label: 'Scheduled', cls: 'bg-blue-100 text-blue-700' },
    pending_approval:  { label: 'Pending',  cls: 'bg-amber-100 text-amber-700' },
    published:         { label: 'Published', cls: 'bg-emerald-100 text-emerald-700' },
  }
  const m = map[status]
  return <span className={`hub-badge ${m.cls}`}>{m.label}</span>
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}
