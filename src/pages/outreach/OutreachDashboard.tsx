import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Megaphone, Send, Calendar as CalendarIcon, BarChart3, FileText, Users, Sparkles,
  TrendingUp, Heart, Eye, MessageCircle, Share2, AlertTriangle, Activity, Layers, RefreshCw,
  ExternalLink, MapPin,
} from 'lucide-react'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
  LineChart, Line,
} from 'recharts'
import { useAuth } from '@/hooks/useAuth'
import {
  useOutreachData, pageMetrics, campaignMetrics, syncNow,
  aggregateTotals, outreachStates, buildPostStateLookup, assignedPageIdSet,
  computeOutreachAlerts,
} from '@/lib/outreach-data'

type Range = '7d' | '30d' | 'mtd' | 'all'

function rangeStart(range: Range): Date | null {
  const now = new Date()
  if (range === '7d') return new Date(now.getTime() - 7 * 86400_000)
  if (range === '30d') return new Date(now.getTime() - 30 * 86400_000)
  if (range === 'mtd') return new Date(now.getFullYear(), now.getMonth(), 1)
  return null
}

export default function OutreachDashboard() {
  const { profile } = useAuth()
  const { pages, creators, campaigns, posts } = useOutreachData()
  const [range, setRange] = useState<Range>('30d')
  const [stateFilter, setStateFilter] = useState('')
  const [syncing, setSyncing] = useState(false)
  const [syncErr, setSyncErr] = useState<string | null>(null)

  // State-wise filter (spec 1.1): when a state is selected every number on the
  // dashboard narrows to data from pages/campaigns in that state.
  const states = useMemo(() => outreachStates(pages, campaigns), [pages, campaigns])
  const stateOf = useMemo(() => buildPostStateLookup(pages, creators), [pages, creators])
  const statePages = useMemo(() => stateFilter ? pages.filter(p => p.state === stateFilter) : pages, [pages, stateFilter])
  const stateCampaigns = useMemo(() => stateFilter ? campaigns.filter(c => c.state === stateFilter) : campaigns, [campaigns, stateFilter])

  const mostRecentSync = useMemo(() => {
    const ts = pages
      .map(p => p.lastSyncedAt)
      .filter((x): x is string => !!x)
      .sort()
      .pop()
    return ts ?? null
  }, [pages])

  async function onSyncNow() {
    if (syncing) return
    setSyncing(true)
    setSyncErr(null)
    try {
      await syncNow()
    } catch (err) {
      setSyncErr(err instanceof Error ? err.message : 'Sync failed.')
    } finally {
      setSyncing(false)
    }
  }

  // Dashboard KPIs reflect work the team explicitly executed — live posts the
  // operator added via AddLivePostsDialog, not the entire Apify-synced backlog
  // of historical Instagram posts on each page. Filtering at the source keeps
  // every downstream calculation honest without per-call gymnastics.
  const livePosts = useMemo(() => {
    const live = posts.filter(p => p.addedAsLive)
    return stateFilter ? live.filter(p => stateOf(p) === stateFilter) : live
  }, [posts, stateFilter, stateOf])

  const filteredPosts = useMemo(() => {
    const start = rangeStart(range)
    return start ? livePosts.filter(p => new Date(p.date) >= start) : livePosts
  }, [livePosts, range])

  // Five headline totals (spec 1.1 summary cards). Reach is proxied by post
  // views and shares are 0 unless recorded — see aggregateTotals.
  const totals = useMemo(() => aggregateTotals(filteredPosts), [filteredPosts])

  // Side-by-side panels (spec 1.1): engagement %, active campaigns, inventory.
  const engagementPct = totals.reach ? (totals.engagement / totals.reach) * 100 : 0
  const activeCampaigns = useMemo(() => stateCampaigns.filter(c => c.status === 'active'), [stateCampaigns])
  const inventory = useMemo(() => {
    const assigned = assignedPageIdSet(campaigns)
    const used = statePages.filter(p => assigned.has(p.id)).length
    return { used, total: statePages.length, pct: statePages.length ? Math.round((used / statePages.length) * 100) : 0 }
  }, [campaigns, statePages])

  const topPosts = useMemo(() => {
    return [...filteredPosts]
      .map(p => ({ post: p, score: p.likes + p.comments * 4 }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
  }, [filteredPosts])

  const topCampaigns = useMemo(() => {
    return stateCampaigns
      .map(c => ({ c, m: campaignMetrics(c, filteredPosts) }))
      .filter(x => x.m.totalReach > 0 || x.c.status === 'active')
      .sort((a, b) => b.m.totalReach - a.m.totalReach)
      .slice(0, 5)
  }, [stateCampaigns, filteredPosts])

  const topByType = useMemo(() => {
    function topPagesOfType(type: 'state' | 'pu') {
      return statePages.filter(p => p.type === type)
        .map(p => ({ page: p, m: pageMetrics(p, filteredPosts) }))
        .sort((a, b) => b.m.avgEngagement - a.m.avgEngagement)
        .slice(0, 5)
    }
    return { state: topPagesOfType('state'), pu: topPagesOfType('pu') }
  }, [statePages, filteredPosts])

  const creatorSummary = useMemo(() => {
    const byType = { state: 0, pu: 0 }
    const byTier: Record<string, number> = { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 }
    for (const c of creators) {
      byType[c.type]++
      byTier[c.followerTier] = (byTier[c.followerTier] ?? 0) + 1
    }
    return { byType, byTier, total: creators.length }
  }, [creators])

  // Standing alerts (spec 1.4): pages/creators assigned to a campaign that
  // haven't posted within 24h of the campaign start. Scoped to the selected
  // state via the campaign's state.
  const alerts = useMemo(() => {
    const all = computeOutreachAlerts(campaigns, pages, creators, posts)
    return stateFilter ? all.filter(a => {
      const c = campaigns.find(cc => cc.id === a.campaignId)
      return c?.state === stateFilter
    }) : all
  }, [campaigns, pages, creators, posts, stateFilter])

  const trendData = useMemo(() => {
    const days = 14
    const today = new Date()
    return Array.from({ length: days }, (_, i) => {
      const d = new Date(today)
      d.setDate(today.getDate() - (days - 1 - i))
      const iso = d.toISOString().slice(0, 10)
      const same = livePosts.filter(p => p.date === iso)
      return {
        day: `${d.getDate()}/${d.getMonth() + 1}`,
        posts: same.length,
        reach: same.reduce((s, p) => s + p.views, 0),
      }
    })
  }, [livePosts])

  const kpiCards = [
    { label: 'Total Reach', value: fmt(totals.reach), sub: 'post views (reach proxy)', icon: Eye, bg: 'bg-orange-50', color: 'text-orange-600' },
    { label: 'Total Views', value: fmt(totals.views), sub: `${totals.posts} live post${totals.posts === 1 ? '' : 's'}`, icon: Activity, bg: 'bg-blue-50', color: 'text-blue-600' },
    { label: 'Total Likes', value: fmt(totals.likes), sub: 'across live posts', icon: Heart, bg: 'bg-rose-50', color: 'text-rose-600' },
    { label: 'Total Comments', value: fmt(totals.comments), sub: 'across live posts', icon: MessageCircle, bg: 'bg-violet-50', color: 'text-violet-600' },
    { label: 'Total Shares', value: fmt(totals.shares), sub: 'where recorded', icon: Share2, bg: 'bg-emerald-50', color: 'text-emerald-600' },
  ]

  return (
    <div className="animate-fade-in space-y-6">

      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-orange-100 flex items-center justify-center">
            <Megaphone className="w-5 h-5 text-orange-600" />
          </div>
          <div>
            <h1 className="text-2xl font-serif text-foreground">Outreach Dashboard</h1>
            <p className="text-sm text-muted-foreground">
              Welcome{profile?.full_name ? `, ${profile.full_name}` : ''}.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="relative">
            <MapPin className="w-3.5 h-3.5 text-muted-foreground absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <select value={stateFilter} onChange={e => setStateFilter(e.target.value)}
              className="hub-input py-1.5 pl-7 text-xs w-40" title="Filter all dashboard data by state">
              <option value="">All states</option>
              {states.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div className="inline-flex bg-card border border-border rounded-lg overflow-hidden text-xs">
            {(['7d', '30d', 'mtd', 'all'] as Range[]).map(r => (
              <button key={r} onClick={() => setRange(r)}
                className={`px-3 py-1.5 transition-colors ${range === r ? 'bg-orange-100 text-orange-700 font-medium' : 'text-muted-foreground hover:bg-accent'}`}>
                {r === '7d' ? 'Last 7d' : r === '30d' ? 'Last 30d' : r === 'mtd' ? 'MTD' : 'All time'}
              </button>
            ))}
          </div>
          <button onClick={onSyncNow} disabled={syncing}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-orange-600 text-white hover:opacity-90 disabled:opacity-50">
            <RefreshCw className={`w-3.5 h-3.5 ${syncing ? 'animate-spin' : ''}`} />
            {syncing ? 'Syncing…' : 'Sync now'}
          </button>
          <span className="text-[11px] text-muted-foreground">
            {syncErr
              ? <span className="text-rose-600">{syncErr}</span>
              : mostRecentSync
                ? `Last synced ${formatRelative(mostRecentSync)}`
                : 'Not synced yet'}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
        {kpiCards.map(k => {
          const Icon = k.icon
          return (
            <div key={k.label} className="hub-card flex items-start gap-3 py-3">
              <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${k.bg} shrink-0`}>
                <Icon className={`w-4 h-4 ${k.color}`} />
              </div>
              <div className="min-w-0">
                <div className="text-2xl font-serif text-foreground leading-none">{k.value}</div>
                <div className="text-xs font-medium text-foreground mt-1">{k.label}</div>
                <div className="text-[11px] text-muted-foreground truncate">{k.sub}</div>
              </div>
            </div>
          )
        })}
      </div>

      {/* Side-by-side panels (spec 1.1): engagement %, active campaigns, inventory used */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div className="hub-card py-4">
          <div className="flex items-center gap-2 mb-1">
            <Heart className="w-4 h-4 text-rose-500" />
            <h2 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Engagement overview</h2>
          </div>
          <p className="text-3xl font-serif text-foreground leading-none">{engagementPct.toFixed(2)}%</p>
          <p className="text-[11px] text-muted-foreground mt-1.5">{fmt(totals.engagement)} engagements over {fmt(totals.reach)} reach</p>
        </div>

        <div className="hub-card py-4">
          <div className="flex items-center gap-2 mb-1">
            <Send className="w-4 h-4 text-blue-500" />
            <h2 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Active campaigns</h2>
          </div>
          <p className="text-3xl font-serif text-foreground leading-none">{activeCampaigns.length}</p>
          {activeCampaigns.length === 0 ? (
            <p className="text-[11px] text-muted-foreground mt-1.5">None running right now.</p>
          ) : (
            <div className="mt-2 space-y-0.5 max-h-20 overflow-y-auto">
              {activeCampaigns.slice(0, 4).map(c => (
                <Link key={c.id} to={`/outreach/campaigns/${c.id}`} className="block text-[11px] text-foreground hover:text-orange-600 truncate">· {c.name}</Link>
              ))}
              {activeCampaigns.length > 4 && <p className="text-[11px] text-muted-foreground">+{activeCampaigns.length - 4} more</p>}
            </div>
          )}
        </div>

        <div className="hub-card py-4">
          <div className="flex items-center gap-2 mb-1">
            <Layers className="w-4 h-4 text-emerald-500" />
            <h2 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Page inventory used</h2>
          </div>
          <p className="text-3xl font-serif text-foreground leading-none">
            {inventory.used} <span className="text-base text-muted-foreground">of {inventory.total} pages</span>
          </p>
          <div className="h-1.5 rounded-full bg-muted overflow-hidden mt-2">
            <div className="h-full bg-emerald-500" style={{ width: `${inventory.pct}%` }} />
          </div>
          <p className="text-[11px] text-muted-foreground mt-1.5">{inventory.pct}% of pages assigned to a campaign</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* Trend chart */}
        <div className="hub-card lg:col-span-2">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
              <TrendingUp className="w-4 h-4 text-muted-foreground" /> Activity (last 14 days)
            </h2>
          </div>
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={trendData} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
              <XAxis dataKey="day" tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} tickLine={false} axisLine={false} />
              <YAxis yAxisId="l" tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} tickLine={false} axisLine={false} width={28} />
              <YAxis yAxisId="r" orientation="right" tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} tickLine={false} axisLine={false} width={42} />
              <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid hsl(var(--border))', background: 'hsl(var(--card))' }} />
              <Line yAxisId="l" type="monotone" dataKey="posts" stroke="#f97316" strokeWidth={2} dot={false} name="Posts" />
              <Line yAxisId="r" type="monotone" dataKey="reach" stroke="#3b82f6" strokeWidth={2} dot={false} name="Reach" />
            </LineChart>
          </ResponsiveContainer>
        </div>

        {/* Alerts — pages overdue on their 24h post deadline (spec 1.4) */}
        <div className="hub-card">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
              <AlertTriangle className={`w-4 h-4 ${alerts.length ? 'text-rose-500' : 'text-muted-foreground'}`} /> Alerts
              {alerts.length > 0 && <span className="hub-badge bg-rose-100 text-rose-700">{alerts.length}</span>}
            </h2>
            <Link to="/outreach/alerts" className="text-xs text-orange-600 hover:underline">View all</Link>
          </div>
          {alerts.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">All clear — every assigned page has posted.</p>
          ) : (
            <div className="space-y-2">
              {alerts.slice(0, 6).map(a => (
                <Link key={a.id}
                  to={a.subjectKind === 'page' ? `/outreach/pages/${a.subjectId}` : `/outreach/creators/${a.subjectId}`}
                  className="flex items-start gap-2 p-2 rounded-lg bg-rose-50/60 hover:bg-rose-50 transition-colors">
                  <div className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0 text-rose-600 bg-rose-100">
                    <AlertTriangle className="w-3.5 h-3.5" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-xs text-foreground truncate"><span className="font-medium">@{a.handle}</span> hasn't posted for <span className="font-medium">{a.campaignName}</span></p>
                    <p className="text-[11px] text-rose-600">{a.hoursOverdue}h past the 24h deadline</p>
                  </div>
                </Link>
              ))}
              {alerts.length > 6 && <p className="text-[11px] text-muted-foreground px-2">+{alerts.length - 6} more — see Alerts</p>}
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* Top posts */}
        <div className="hub-card">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-foreground">Top posts</h2>
            <Link to="/outreach/pages" className="text-xs text-orange-600 hover:underline">View all</Link>
          </div>
          {topPosts.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">No posts in this window.</p>
          ) : (
            <div className="space-y-2">
              {topPosts.map(({ post, score }) => {
                const page = pages.find(p => p.id === post.pageId)
                const camp = campaigns.find(c => c.id === post.campaignId)
                const body = (
                  <>
                    <span className="hub-badge bg-orange-50 text-orange-700 shrink-0 capitalize">{post.type}</span>
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-medium text-foreground truncate">@{page?.handle ?? '—'}</p>
                      <p className="text-[11px] text-muted-foreground truncate">{camp?.name ?? '—'} · {post.date}</p>
                    </div>
                    <span className="text-xs font-mono text-foreground tabular-nums">{fmt(score)}</span>
                    {post.permalink && <ExternalLink className="w-3 h-3 text-muted-foreground shrink-0" />}
                  </>
                )
                return post.permalink ? (
                  <a key={post.id} href={post.permalink} target="_blank" rel="noreferrer"
                    title="Open on Instagram"
                    className="flex items-center gap-3 p-2 rounded-lg hover:bg-accent transition-colors">
                    {body}
                  </a>
                ) : (
                  <div key={post.id} className="flex items-center gap-3 p-2 rounded-lg hover:bg-accent transition-colors">
                    {body}
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* Top campaigns chart */}
        <div className="hub-card">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-foreground">Top campaigns by reach</h2>
            <Link to="/outreach/campaigns" className="text-xs text-orange-600 hover:underline">View all</Link>
          </div>
          {topCampaigns.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">No campaign data yet.</p>
          ) : (
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={topCampaigns.map(x => ({ name: x.c.name.length > 14 ? x.c.name.slice(0, 14) + '…' : x.c.name, reach: x.m.totalReach }))}
                margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                <XAxis dataKey="name" tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} tickLine={false} axisLine={false} />
                <YAxis tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} tickLine={false} axisLine={false} width={36} />
                <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid hsl(var(--border))', background: 'hsl(var(--card))' }} />
                <Bar dataKey="reach" fill="#f97316" radius={[4, 4, 0, 0]} maxBarSize={36} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      {/* Top pages split by type */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {(['state', 'pu'] as const).map(t => (
          <div key={t} className="hub-card">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-foreground">Top {t === 'pu' ? 'PU' : 'State'} pages</h2>
              <Link to="/outreach/pages" className="text-xs text-orange-600 hover:underline">All pages</Link>
            </div>
            {topByType[t].length === 0 ? (
              <p className="text-sm text-muted-foreground py-6 text-center">No {t === 'pu' ? 'PU' : 'state'} pages yet.</p>
            ) : (
              <div className="space-y-1">
                {topByType[t].map(({ page, m }) => (
                  <Link key={page.id} to={`/outreach/pages/${page.id}`}
                    className="flex items-center gap-3 p-2 rounded-lg hover:bg-accent transition-colors">
                    <div className="w-7 h-7 rounded-full bg-orange-100 flex items-center justify-center shrink-0">
                      <span className="text-[10px] font-semibold text-orange-700">
                        {page.handle[0]?.toUpperCase()}
                      </span>
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-medium text-foreground truncate">@{page.handle}</p>
                      <p className="text-[11px] text-muted-foreground truncate">{page.geography} · {fmt(page.followers)} followers</p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-xs font-mono tabular-nums text-foreground">{fmt(m.avgEngagement)}</p>
                      <p className="text-[10px] text-muted-foreground">avg eng/post</p>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Creators directory — separate entity from pages; shows the lay of the
          land so the team knows what's available when assigning campaigns. */}
      <div className="hub-card">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
            <Users className="w-4 h-4 text-muted-foreground" /> Creators directory
          </h2>
          <Link to="/outreach/creators" className="text-xs text-orange-600 hover:underline">Manage creators</Link>
        </div>
        {creatorSummary.total === 0 ? (
          <p className="text-sm text-muted-foreground py-6 text-center">
            No creators added yet. <Link to="/outreach/creators" className="text-orange-600 hover:underline">Add your first creator</Link>.
          </p>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="hub-card bg-orange-50/40 py-3">
              <p className="text-[10px] uppercase tracking-widest text-muted-foreground">Total</p>
              <p className="text-2xl font-serif text-foreground leading-none mt-1">{creatorSummary.total}</p>
              <p className="text-[11px] text-muted-foreground mt-1">creators on file</p>
            </div>
            <div className="hub-card bg-blue-50/40 py-3">
              <p className="text-[10px] uppercase tracking-widest text-muted-foreground">State</p>
              <p className="text-2xl font-serif text-foreground leading-none mt-1">{creatorSummary.byType.state}</p>
              <p className="text-[11px] text-muted-foreground mt-1">state-level reach</p>
            </div>
            <div className="hub-card bg-emerald-50/40 py-3">
              <p className="text-[10px] uppercase tracking-widest text-muted-foreground">PU</p>
              <p className="text-2xl font-serif text-foreground leading-none mt-1">{creatorSummary.byType.pu}</p>
              <p className="text-[11px] text-muted-foreground mt-1">PU-owned</p>
            </div>
            <div className="hub-card bg-amber-50/40 py-3">
              <p className="text-[10px] uppercase tracking-widest text-muted-foreground">By tier</p>
              <div className="flex items-baseline gap-2 mt-1">
                {(['1', '2', '3', '4', '5'] as const).map(t => (
                  <span key={t} className="text-[11px] font-mono tabular-nums text-foreground">
                    T{t}: <span className="font-semibold">{creatorSummary.byTier[t] ?? 0}</span>
                  </span>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="hub-card">
        <h2 className="text-sm font-semibold text-foreground mb-3">Quick actions</h2>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2">
          {[
            { to: '/outreach/campaigns', icon: Send,      label: 'Campaigns' },
            { to: '/outreach/calendar',  icon: CalendarIcon, label: 'Calendar' },
            { to: '/outreach/analytics', icon: BarChart3, label: 'Analytics' },
            { to: '/outreach/pages',     icon: FileText,  label: 'All Pages' },
            { to: '/outreach/creators',  icon: Users,     label: 'Creators' },
            { to: '/outreach/ai',        icon: Sparkles,  label: 'AI Assist' },
          ].map(({ to, icon: Icon, label }) => (
            <Link key={to} to={to}
              className="flex items-center gap-2 p-2.5 rounded-lg hover:bg-accent transition-colors group">
              <Icon className="w-4 h-4 text-muted-foreground group-hover:text-orange-600" />
              <span className="text-sm text-foreground">{label}</span>
            </Link>
          ))}
        </div>
      </div>

    </div>
  )
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function formatRelative(iso: string): string {
  const diffSec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (diffSec < 60) return 'just now'
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`
  return `${Math.floor(diffSec / 86400)}d ago`
}
