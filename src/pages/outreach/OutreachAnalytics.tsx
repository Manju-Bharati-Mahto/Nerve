import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  BarChart3, Download, Layers, TrendingUp, Award, FileText, Send, Plus,
  Filter as FilterIcon, ArrowUp, ArrowDown,
} from 'lucide-react'
import {
  BarChart, Bar, ResponsiveContainer, XAxis, YAxis, Tooltip, CartesianGrid,
  LineChart, Line, Legend,
} from 'recharts'
import {
  useOutreachData, pageMetrics, campaignMetrics, addPage, updatePage,
  PAGE_TYPES, FOLLOWER_TIERS,
  type PageType, type FollowerTier, type OutreachPage,
} from '@/lib/outreach-data'

type Tab = 'pages' | 'campaigns' | 'posts' | 'trend' | 'inventory'

const TABS: { id: Tab; label: string; icon: React.ElementType }[] = [
  { id: 'pages',     label: 'By page',           icon: FileText },
  { id: 'campaigns', label: 'Best campaigns',    icon: Send },
  { id: 'posts',     label: 'Best posts',        icon: Award },
  { id: 'trend',     label: 'Campaign trend',    icon: TrendingUp },
  { id: 'inventory', label: 'Inventory heatmap', icon: Layers },
]

// Performance tiers — would normally live in Settings; defaulted here.
const TIERS = {
  high: 5000,
  moderate: 1500,
}

export default function OutreachAnalytics() {
  const [tab, setTab] = useState<Tab>('inventory')

  return (
    <div className="animate-fade-in space-y-5">

      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-orange-100 flex items-center justify-center">
          <BarChart3 className="w-5 h-5 text-orange-600" />
        </div>
        <div>
          <h1 className="text-2xl font-serif text-foreground">Analytics</h1>
          <p className="text-sm text-muted-foreground">Performance, comparisons, and inventory consumption.</p>
        </div>
      </div>

      <div className="flex border-b border-border overflow-x-auto">
        {TABS.map(t => {
          const Icon = t.icon
          return (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors inline-flex items-center gap-2 whitespace-nowrap ${tab === t.id
                ? 'border-orange-600 text-orange-700'
                : 'border-transparent text-muted-foreground hover:text-foreground'}`}>
              <Icon className="w-4 h-4" /> {t.label}
            </button>
          )
        })}
      </div>

      {tab === 'pages'     && <PagesPerformance />}
      {tab === 'campaigns' && <CampaignsCompare />}
      {tab === 'posts'     && <BestPosts />}
      {tab === 'trend'     && <CampaignTrend />}
      {tab === 'inventory' && <InventoryHeatmap />}

    </div>
  )
}

// ── Tab: Pages Performance ─────────────────────────────────────────────────

function PagesPerformance() {
  const { pages, posts, campaigns } = useOutreachData()
  const [statusFilter, setStatusFilter] = useState<'all' | 'over-used' | 'on-track' | 'under-used' | 'idle'>('all')
  const [campaignFilter, setCampaignFilter] = useState<string>('')
  const [creating, setCreating] = useState(false)

  const pagesByCampaign = useMemo(() => {
    if (!campaignFilter) return null
    const c = campaigns.find(cc => cc.id === campaignFilter)
    return c ? new Set(c.assignedPageIds) : new Set<string>()
  }, [campaigns, campaignFilter])

  const rows = useMemo(() => {
    const enriched = pages.map(p => ({ page: p, m: pageMetrics(p, posts) }))
    return enriched
      .filter(({ page, m }) => {
        if (statusFilter !== 'all' && m.status !== statusFilter) return false
        if (pagesByCampaign && !pagesByCampaign.has(page.id)) return false
        return true
      })
      .sort((a, b) => b.m.avgEngagement - a.m.avgEngagement)
  }, [pages, posts, statusFilter, pagesByCampaign])

  function exportCSV() {
    const header = ['handle', 'geography', 'state', 'type', 'inventory_posts', 'inventory_stories', 'posts_mtd', 'pct_consumed', 'avg_engagement', 'last_post', 'status']
    const lines = rows.map(({ page, m }) => [
      page.handle, page.geography, page.state, page.type, page.inventoryPosts, page.inventoryStories,
      m.postsDoneMTD + m.storiesDoneMTD, (m.pctConsumed * 100).toFixed(0) + '%', m.avgEngagement,
      m.lastPostDate ?? '', m.status,
    ].join(','))
    const csv = [header.join(','), ...lines].join('\n')
    download(csv, `outreach-pages-${new Date().toISOString().slice(0, 10)}.csv`)
  }

  return (
    <div className="space-y-3">
      <div className="hub-card py-3 flex items-center gap-2 flex-wrap">
        <FilterIcon className="w-4 h-4 text-muted-foreground" />
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value as typeof statusFilter)} className="hub-input py-1.5 text-xs w-36">
          <option value="all">Any status</option>
          <option value="over-used">Over-used</option>
          <option value="on-track">On-track</option>
          <option value="under-used">Under-used</option>
          <option value="idle">Idle</option>
        </select>
        <select value={campaignFilter} onChange={e => setCampaignFilter(e.target.value)} className="hub-input py-1.5 text-xs w-48">
          <option value="">Any campaign</option>
          {campaigns.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <span className="text-xs text-muted-foreground">{rows.length} pages</span>
        <div className="ml-auto flex items-center gap-2">
          <button onClick={() => setCreating(true)} className="text-xs px-3 py-1.5 rounded-lg bg-orange-600 text-white hover:opacity-90 inline-flex items-center gap-1.5">
            <Plus className="w-3.5 h-3.5" /> Add page
          </button>
          <button onClick={exportCSV} className="text-xs px-3 py-1.5 rounded-lg border border-border hover:bg-accent inline-flex items-center gap-1.5">
            <Download className="w-3.5 h-3.5" /> Export
          </button>
        </div>
      </div>
      <div className="hub-card p-0 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-widest text-muted-foreground border-b border-border">
              <th className="px-3 py-2">Page</th>
              <th className="px-3 py-2">Geography</th>
              <th className="px-3 py-2">Type</th>
              <th className="px-3 py-2 text-right">Posts MTD</th>
              <th className="px-3 py-2 text-right">% consumed</th>
              <th className="px-3 py-2 text-right">Avg eng</th>
              <th className="px-3 py-2">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={7} className="px-3 py-12 text-center text-sm text-muted-foreground">No pages match these filters.</td></tr>
            ) : rows.map(({ page, m }) => (
              <tr key={page.id} className="border-b border-border last:border-0 hover:bg-accent/40">
                <td className="px-3 py-2.5">
                  <Link to={`/outreach/creators/${page.id}`} className="text-xs font-medium text-foreground hover:underline">@{page.handle}</Link>
                </td>
                <td className="px-3 py-2.5 text-xs text-muted-foreground">{page.geography}</td>
                <td className="px-3 py-2.5 text-xs uppercase text-muted-foreground">{page.type}</td>
                <td className="px-3 py-2.5 text-right text-xs font-mono tabular-nums">{m.postsDoneMTD + m.storiesDoneMTD}</td>
                <td className="px-3 py-2.5 text-right text-xs font-mono tabular-nums">{Math.round(m.pctConsumed * 100)}%</td>
                <td className="px-3 py-2.5 text-right text-xs font-mono tabular-nums">{fmt(m.avgEngagement)}</td>
                <td className="px-3 py-2.5"><StatusChip s={m.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {creating && <AddPageModal onClose={() => setCreating(false)} />}
    </div>
  )
}

// ── Tab: Campaign Compare ──────────────────────────────────────────────────

function CampaignsCompare() {
  const { campaigns, posts } = useOutreachData()
  const enriched = useMemo(() => campaigns.map(c => ({ c, m: campaignMetrics(c, posts) })), [campaigns, posts])
  const top3 = useMemo(() => enriched.sort((a, b) => b.m.totalReach - a.m.totalReach).slice(0, 3).map(x => x.c.id), [enriched])
  const [selected, setSelected] = useState<string[]>(top3)

  function toggle(id: string) {
    setSelected(s => s.includes(id) ? s.filter(x => x !== id) : s.length >= 4 ? s : [...s, id])
  }

  const compared = enriched.filter(x => selected.includes(x.c.id))
  const chartData = compared.map(({ c, m }) => ({
    name: c.name.length > 16 ? c.name.slice(0, 16) + '…' : c.name,
    Reach: m.totalReach,
    Engagement: m.totalEngagement,
    Delivered: m.postsDelivered + m.storiesDelivered + m.reelsDelivered,
  }))

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
      <div className="hub-card lg:col-span-1">
        <h2 className="text-sm font-semibold text-foreground mb-2">Pick up to 4 campaigns</h2>
        <p className="text-[11px] text-muted-foreground mb-3">{selected.length} selected</p>
        <div className="space-y-1 max-h-96 overflow-y-auto">
          {enriched.map(({ c }) => (
            <label key={c.id} className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-accent cursor-pointer">
              <input type="checkbox" checked={selected.includes(c.id)} onChange={() => toggle(c.id)} />
              <span className="text-xs text-foreground truncate">{c.name}</span>
            </label>
          ))}
        </div>
      </div>
      <div className="hub-card lg:col-span-2">
        <h2 className="text-sm font-semibold text-foreground mb-3">Side-by-side comparison</h2>
        {compared.length === 0 ? (
          <p className="text-sm text-muted-foreground py-12 text-center">Select campaigns to compare.</p>
        ) : (
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
              <XAxis dataKey="name" tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} />
              <YAxis yAxisId="l" tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} width={48} />
              <YAxis yAxisId="r" orientation="right" tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} width={36} />
              <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid hsl(var(--border))', background: 'hsl(var(--card))' }} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Bar yAxisId="l" dataKey="Reach"      fill="#f97316" radius={[4, 4, 0, 0]} />
              <Bar yAxisId="l" dataKey="Engagement" fill="#3b82f6" radius={[4, 4, 0, 0]} />
              <Bar yAxisId="r" dataKey="Delivered"  fill="#10b981" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  )
}

// ── Tab: Best Posts ────────────────────────────────────────────────────────

function BestPosts() {
  const { posts, pages, campaigns } = useOutreachData()
  const [tier, setTier] = useState<'all' | 'high' | 'moderate' | 'low'>('high')
  const [campaignFilter, setCampaignFilter] = useState<string>('')
  const [pageFilter, setPageFilter] = useState<string>('')
  const [dir, setDir] = useState<'desc' | 'asc'>('desc')

  const scored = useMemo(() => posts.map(p => {
    const eng = p.likes + p.comments + p.saves + p.shares
    const t: 'high' | 'moderate' | 'low' = eng >= TIERS.high ? 'high' : eng >= TIERS.moderate ? 'moderate' : 'low'
    return { post: p, eng, tier: t }
  }), [posts])

  const filtered = useMemo(() => {
    const out = scored.filter(x => {
      if (tier !== 'all' && x.tier !== tier) return false
      if (campaignFilter && x.post.campaignId !== campaignFilter) return false
      if (pageFilter && x.post.pageId !== pageFilter) return false
      return true
    })
    out.sort((a, b) => dir === 'desc' ? b.eng - a.eng : a.eng - b.eng)
    return out.slice(0, 50)
  }, [scored, tier, campaignFilter, pageFilter, dir])

  return (
    <div className="space-y-3">
      <div className="hub-card py-3 flex items-center gap-2 flex-wrap">
        <span className="text-xs text-muted-foreground">Tier:</span>
        {(['all', 'high', 'moderate', 'low'] as const).map(t => (
          <button key={t} onClick={() => setTier(t)}
            className={`text-xs px-3 py-1.5 rounded-lg capitalize transition-colors ${
              tier === t ? 'bg-orange-100 text-orange-700 font-medium' : 'border border-border text-muted-foreground hover:bg-accent'
            }`}>
            {t}
          </button>
        ))}
        <span className="w-px h-5 bg-border mx-1" />
        <FilterIcon className="w-4 h-4 text-muted-foreground" />
        <select value={campaignFilter} onChange={e => setCampaignFilter(e.target.value)} className="hub-input py-1.5 text-xs w-44">
          <option value="">Any campaign</option>
          {campaigns.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select value={pageFilter} onChange={e => setPageFilter(e.target.value)} className="hub-input py-1.5 text-xs w-40">
          <option value="">Any page</option>
          {pages.map(p => <option key={p.id} value={p.id}>@{p.handle}</option>)}
        </select>
        <button onClick={() => setDir(d => d === 'desc' ? 'asc' : 'desc')}
          className="text-xs px-3 py-1.5 rounded-lg border border-border hover:bg-accent inline-flex items-center gap-1.5">
          {dir === 'desc' ? <ArrowDown className="w-3.5 h-3.5" /> : <ArrowUp className="w-3.5 h-3.5" />}
          {dir === 'desc' ? 'Descending' : 'Ascending'}
        </button>
        <span className="text-[11px] text-muted-foreground ml-auto">Thresholds: ≥{TIERS.high} = high · ≥{TIERS.moderate} = moderate</span>
      </div>
      <div className="hub-card p-0 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-widest text-muted-foreground border-b border-border">
              <th className="px-3 py-2">Date</th>
              <th className="px-3 py-2">Page</th>
              <th className="px-3 py-2">Campaign</th>
              <th className="px-3 py-2">Type</th>
              <th className="px-3 py-2">Variant</th>
              <th className="px-3 py-2 text-right">Engagement</th>
              <th className="px-3 py-2 text-right">Reach</th>
              <th className="px-3 py-2">Tier</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr><td colSpan={8} className="px-3 py-12 text-center text-sm text-muted-foreground">No posts in this tier.</td></tr>
            ) : filtered.map(({ post, eng, tier: t }) => {
              const page = pages.find(p => p.id === post.pageId)
              const camp = campaigns.find(c => c.id === post.campaignId)
              return (
                <tr key={post.id} className="border-b border-border last:border-0 hover:bg-accent/40">
                  <td className="px-3 py-2.5 text-xs">{post.date}</td>
                  <td className="px-3 py-2.5 text-xs">{page ? <Link to={`/outreach/creators/${page.id}`} className="hover:underline">@{page.handle}</Link> : '—'}</td>
                  <td className="px-3 py-2.5 text-xs">{camp ? <Link to={`/outreach/campaigns/${camp.id}`} className="hover:underline">{camp.name}</Link> : '—'}</td>
                  <td className="px-3 py-2.5"><span className="hub-badge bg-orange-50 text-orange-700 capitalize">{post.type}</span></td>
                  <td className="px-3 py-2.5 text-xs text-muted-foreground">{post.creativeVariant ?? '—'}</td>
                  <td className="px-3 py-2.5 text-right text-xs font-mono tabular-nums">{fmt(eng)}</td>
                  <td className="px-3 py-2.5 text-right text-xs font-mono tabular-nums">{fmt(post.views)}</td>
                  <td className="px-3 py-2.5"><TierChip t={t} /></td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── Tab: Campaign Trend (overall over time) ────────────────────────────────

function CampaignTrend() {
  const { posts } = useOutreachData()
  const data = useMemo(() => {
    const byDay = new Map<string, { posts: number; reach: number; eng: number }>()
    for (const p of posts) {
      const cur = byDay.get(p.date) ?? { posts: 0, reach: 0, eng: 0 }
      cur.posts++
      cur.reach += p.views
      cur.eng += p.likes + p.comments + p.saves + p.shares
      byDay.set(p.date, cur)
    }
    return Array.from(byDay.entries()).sort(([a], [b]) => a.localeCompare(b))
      .map(([day, v]) => ({ day: day.slice(5), ...v }))
  }, [posts])

  return (
    <div className="hub-card">
      <h2 className="text-sm font-semibold text-foreground mb-3">Overall campaign performance</h2>
      <ResponsiveContainer width="100%" height={320}>
        <LineChart data={data} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
          <XAxis dataKey="day" tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} />
          <YAxis yAxisId="l" tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} width={48} />
          <YAxis yAxisId="r" orientation="right" tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} width={36} />
          <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid hsl(var(--border))', background: 'hsl(var(--card))' }} />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          <Line yAxisId="l" type="monotone" dataKey="reach" name="Reach" stroke="#f97316" strokeWidth={2} dot={false} />
          <Line yAxisId="l" type="monotone" dataKey="eng"   name="Engagement" stroke="#3b82f6" strokeWidth={2} dot={false} />
          <Line yAxisId="r" type="monotone" dataKey="posts" name="Posts" stroke="#10b981" strokeWidth={2} dot={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

// ── Tab: Inventory Heatmap ─────────────────────────────────────────────────

function InventoryHeatmap() {
  const { pages, posts } = useOutreachData()
  const [geoFilter, setGeoFilter] = useState<string>('')
  const [typeFilter, setTypeFilter] = useState<PageType | ''>('')
  const [topUp, setTopUp] = useState<OutreachPage | null>(null)

  const geographies = useMemo(() => Array.from(new Set(pages.map(p => p.geography))).sort(), [pages])

  const rows = useMemo(() => {
    return pages
      .filter(p => (!geoFilter || p.geography === geoFilter) && (!typeFilter || p.type === typeFilter))
      .map(p => ({ page: p, m: pageMetrics(p, posts) }))
      .sort((a, b) => b.m.pctConsumed - a.m.pctConsumed)
  }, [pages, posts, geoFilter, typeFilter])

  function bg(pct: number): string {
    if (pct >= 0.95) return 'bg-rose-500/90 text-white'
    if (pct >= 0.80) return 'bg-rose-300 text-rose-900'
    if (pct >= 0.60) return 'bg-amber-300 text-amber-900'
    if (pct >= 0.30) return 'bg-emerald-300 text-emerald-900'
    if (pct >= 0.01) return 'bg-emerald-100 text-emerald-700'
    return 'bg-muted text-muted-foreground'
  }

  // Group by geography for a tidy heatmap
  const grouped = useMemo(() => {
    const byGeo = new Map<string, typeof rows>()
    for (const r of rows) {
      const arr = byGeo.get(r.page.geography) ?? []
      arr.push(r)
      byGeo.set(r.page.geography, arr)
    }
    return Array.from(byGeo.entries()).sort(([a], [b]) => a.localeCompare(b))
  }, [rows])

  return (
    <div className="space-y-4">
      <div className="hub-card py-3 flex items-center gap-2 flex-wrap">
        <FilterIcon className="w-4 h-4 text-muted-foreground" />
        <select value={geoFilter} onChange={e => setGeoFilter(e.target.value)} className="hub-input py-1.5 text-xs w-40">
          <option value="">All geographies</option>
          {geographies.map(g => <option key={g} value={g}>{g}</option>)}
        </select>
        <select value={typeFilter} onChange={e => setTypeFilter(e.target.value as PageType | '')} className="hub-input py-1.5 text-xs w-32">
          <option value="">Any type</option>
          {PAGE_TYPES.map(t => <option key={t} value={t}>{t === 'pu' ? 'PU' : 'State'}</option>)}
        </select>
        <span className="text-xs text-muted-foreground">{rows.length} pages</span>
        <button onClick={() => setTopUp(pages[0] ?? null)} disabled={pages.length === 0}
          className="text-xs px-3 py-1.5 rounded-lg bg-orange-600 text-white hover:opacity-90 disabled:opacity-40 inline-flex items-center gap-1.5 ml-auto">
          <Plus className="w-3.5 h-3.5" /> Add inventory
        </button>
      </div>

      <div className="hub-card flex items-center gap-3 text-xs flex-wrap">
        <span className="text-muted-foreground">Inventory consumption legend:</span>
        <Legend2 cls="bg-emerald-100 text-emerald-700"  label="<30% (under-used)" />
        <Legend2 cls="bg-emerald-300 text-emerald-900" label="30-60%" />
        <Legend2 cls="bg-amber-300 text-amber-900"     label="60-80%" />
        <Legend2 cls="bg-rose-300 text-rose-900"       label="80-95%" />
        <Legend2 cls="bg-rose-500/90 text-white"       label="≥95% (burned)" />
        <Legend2 cls="bg-muted text-muted-foreground"   label="Idle" />
      </div>

      {topUp && <AddInventoryModal pages={pages} initialPage={topUp} onClose={() => setTopUp(null)} />}

      {grouped.map(([geo, gRows]) => (
        <div key={geo} className="hub-card">
          <h3 className="text-sm font-semibold text-foreground mb-3">{geo} <span className="text-xs text-muted-foreground font-normal">({gRows.length} pages)</span></h3>
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-2">
            {gRows.map(({ page, m }) => (
              <Link key={page.id} to={`/outreach/creators/${page.id}`}
                title={`@${page.handle} — ${m.postsDoneMTD + m.storiesDoneMTD}/${page.inventoryPosts + page.inventoryStories} = ${Math.round(m.pctConsumed * 100)}%`}
                className={`p-3 rounded-lg ${bg(m.pctConsumed)} hover:opacity-90 transition-opacity`}>
                <p className="text-xs font-medium truncate">@{page.handle}</p>
                <p className="text-lg font-mono tabular-nums leading-none mt-1">{Math.round(m.pctConsumed * 100)}%</p>
                <p className="text-[10px] opacity-80 mt-1">{m.postsDoneMTD + m.storiesDoneMTD} of {page.inventoryPosts + page.inventoryStories}</p>
              </Link>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

function Legend2({ cls, label }: { cls: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`w-3 h-3 rounded ${cls.split(' ')[0]}`} />
      <span className="text-muted-foreground">{label}</span>
    </span>
  )
}

function StatusChip({ s }: { s: 'over-used' | 'under-used' | 'on-track' | 'idle' }) {
  const map = {
    'over-used':  { label: 'Over-used',  cls: 'bg-rose-100 text-rose-700' },
    'on-track':   { label: 'On-track',   cls: 'bg-emerald-100 text-emerald-700' },
    'under-used': { label: 'Under-used', cls: 'bg-amber-100 text-amber-700' },
    'idle':       { label: 'Idle',       cls: 'bg-muted text-muted-foreground' },
  }[s]
  return <span className={`hub-badge ${map.cls}`}>{map.label}</span>
}

function TierChip({ t }: { t: 'high' | 'moderate' | 'low' }) {
  const map = {
    high:     { label: 'High',     cls: 'bg-emerald-100 text-emerald-700' },
    moderate: { label: 'Moderate', cls: 'bg-amber-100 text-amber-700' },
    low:      { label: 'Low',      cls: 'bg-muted text-muted-foreground' },
  }[t]
  return <span className={`hub-badge ${map.cls}`}>{map.label}</span>
}

function download(text: string, name: string) {
  const blob = new Blob([text], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

// ── Modals ─────────────────────────────────────────────────────────────────

export function AddPageModal({ onClose }: { onClose: () => void }) {
  const [form, setForm] = useState<{
    handle: string; geography: string; state: string; type: PageType;
    followerTier: FollowerTier; followers: number; inventoryPosts: number; inventoryStories: number; notes: string;
  }>({
    handle: '', geography: '', state: '', type: 'state',
    followerTier: 'micro', followers: 20000, inventoryPosts: 24, inventoryStories: 24, notes: '',
  })

  const canSubmit = form.handle.trim() && form.geography.trim() && form.state.trim()

  function submit() {
    addPage({ ...form, handle: form.handle.trim(), geography: form.geography.trim(), state: form.state.trim() })
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4 animate-fade-in" onClick={onClose}>
      <div className="bg-card rounded-xl border border-border w-full max-w-lg" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between p-4 border-b border-border">
          <h2 className="text-base font-serif text-foreground">Add page</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground text-xl leading-none">×</button>
        </div>
        <div className="p-4 space-y-3">
          <div>
            <label className="hub-label">Handle *</label>
            <input className="hub-input" value={form.handle} onChange={e => setForm(f => ({ ...f, handle: e.target.value }))} placeholder="e.g. mycitypage" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="hub-label">Geography *</label>
              <input className="hub-input" value={form.geography} onChange={e => setForm(f => ({ ...f, geography: e.target.value }))} placeholder="Vadodara" />
            </div>
            <div>
              <label className="hub-label">State *</label>
              <input className="hub-input" value={form.state} onChange={e => setForm(f => ({ ...f, state: e.target.value }))} placeholder="Gujarat" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="hub-label">Type</label>
              <select className="hub-input" value={form.type} onChange={e => setForm(f => ({ ...f, type: e.target.value as PageType }))}>
                {PAGE_TYPES.map(t => <option key={t} value={t}>{t === 'pu' ? 'PU' : 'State'}</option>)}
              </select>
            </div>
            <div>
              <label className="hub-label">Follower tier</label>
              <select className="hub-input" value={form.followerTier} onChange={e => setForm(f => ({ ...f, followerTier: e.target.value as FollowerTier }))}>
                {FOLLOWER_TIERS.map(t => <option key={t} value={t} className="capitalize">{t}</option>)}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="hub-label">Followers</label>
              <input type="number" min={0} className="hub-input" value={form.followers}
                onChange={e => setForm(f => ({ ...f, followers: Number(e.target.value) || 0 }))} />
            </div>
            <div>
              <label className="hub-label">Inv. posts</label>
              <input type="number" min={0} className="hub-input" value={form.inventoryPosts}
                onChange={e => setForm(f => ({ ...f, inventoryPosts: Number(e.target.value) || 0 }))} />
            </div>
            <div>
              <label className="hub-label">Inv. stories</label>
              <input type="number" min={0} className="hub-input" value={form.inventoryStories}
                onChange={e => setForm(f => ({ ...f, inventoryStories: Number(e.target.value) || 0 }))} />
            </div>
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 p-4 border-t border-border">
          <button onClick={onClose} className="px-4 py-2 rounded-lg border border-border text-sm text-muted-foreground hover:bg-accent">Cancel</button>
          <button onClick={submit} disabled={!canSubmit}
            className="px-4 py-2 rounded-lg bg-orange-600 text-white text-sm font-medium hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed">
            Add page
          </button>
        </div>
      </div>
    </div>
  )
}

export function AddInventoryModal({ pages, initialPage, onClose }:
  { pages: OutreachPage[]; initialPage: OutreachPage; onClose: () => void }) {
  const [pageId, setPageId] = useState(initialPage.id)
  const [addPosts, setAddPosts] = useState(0)
  const [addStories, setAddStories] = useState(0)
  const current = pages.find(p => p.id === pageId) ?? initialPage

  function submit() {
    updatePage(pageId, {
      inventoryPosts: current.inventoryPosts + addPosts,
      inventoryStories: current.inventoryStories + addStories,
    })
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4 animate-fade-in" onClick={onClose}>
      <div className="bg-card rounded-xl border border-border w-full max-w-md" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between p-4 border-b border-border">
          <h2 className="text-base font-serif text-foreground">Top up inventory</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground text-xl leading-none">×</button>
        </div>
        <div className="p-4 space-y-3">
          <div>
            <label className="hub-label">Page</label>
            <select className="hub-input" value={pageId} onChange={e => setPageId(e.target.value)}>
              {pages.map(p => <option key={p.id} value={p.id}>@{p.handle}</option>)}
            </select>
            <p className="text-[11px] text-muted-foreground mt-1">
              Current: {current.inventoryPosts} posts · {current.inventoryStories} stories
            </p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="hub-label">Add posts</label>
              <input type="number" min={0} className="hub-input" value={addPosts}
                onChange={e => setAddPosts(Number(e.target.value) || 0)} />
            </div>
            <div>
              <label className="hub-label">Add stories</label>
              <input type="number" min={0} className="hub-input" value={addStories}
                onChange={e => setAddStories(Number(e.target.value) || 0)} />
            </div>
          </div>
          <div className="hub-card bg-muted text-xs py-2">
            New totals: <strong>{current.inventoryPosts + addPosts}</strong> posts · <strong>{current.inventoryStories + addStories}</strong> stories
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 p-4 border-t border-border">
          <button onClick={onClose} className="px-4 py-2 rounded-lg border border-border text-sm text-muted-foreground hover:bg-accent">Cancel</button>
          <button onClick={submit} disabled={addPosts + addStories === 0}
            className="px-4 py-2 rounded-lg bg-orange-600 text-white text-sm font-medium hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed">
            Add inventory
          </button>
        </div>
      </div>
    </div>
  )
}
