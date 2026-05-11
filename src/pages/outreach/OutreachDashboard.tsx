import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Megaphone, Send, Calendar as CalendarIcon, BarChart3, FileText, Users, Sparkles,
  TrendingUp, Heart, Eye, AlertTriangle, AlertCircle, Activity, Layers, RefreshCw,
} from 'lucide-react'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
  LineChart, Line,
} from 'recharts'
import { useAuth } from '@/hooks/useAuth'
import {
  useOutreachData, pageMetrics, campaignMetrics, syncNow,
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
  const { pages, campaigns, posts } = useOutreachData()
  const [range, setRange] = useState<Range>('30d')
  const [syncing, setSyncing] = useState(false)
  const [syncErr, setSyncErr] = useState<string | null>(null)

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

  const filteredPosts = useMemo(() => {
    const start = rangeStart(range)
    return start ? posts.filter(p => new Date(p.date) >= start) : posts
  }, [posts, range])

  const kpis = useMemo(() => {
    const reach = filteredPosts.reduce((s, p) => s + p.views, 0)
    const eng = filteredPosts.reduce((s, p) => s + p.likes + p.comments, 0)
    const active = campaigns.filter(c => c.status === 'active').length
    const totalInv = pages.reduce((s, p) => s + p.inventoryPosts + p.inventoryStories, 0)
    const used = filteredPosts.length
    const pctInv = totalInv ? Math.min(100, Math.round((used / totalInv) * 100)) : 0
    return { reach, eng, active, pctInv, postsCount: filteredPosts.length }
  }, [filteredPosts, campaigns, pages])

  const topPosts = useMemo(() => {
    return [...filteredPosts]
      .map(p => ({ post: p, score: p.likes + p.comments * 4 }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
  }, [filteredPosts])

  const topCampaigns = useMemo(() => {
    return campaigns
      .map(c => ({ c, m: campaignMetrics(c, filteredPosts) }))
      .filter(x => x.m.totalReach > 0 || x.c.status === 'active')
      .sort((a, b) => b.m.totalReach - a.m.totalReach)
      .slice(0, 5)
  }, [campaigns, filteredPosts])

  const topByType = useMemo(() => {
    function topPagesOfType(type: 'state' | 'pu') {
      return pages.filter(p => p.type === type)
        .map(p => ({ page: p, m: pageMetrics(p, filteredPosts) }))
        .sort((a, b) => b.m.avgEngagement - a.m.avgEngagement)
        .slice(0, 5)
    }
    return { state: topPagesOfType('state'), pu: topPagesOfType('pu') }
  }, [pages, filteredPosts])

  const alerts = useMemo(() => {
    const out: { id: string; severity: 'warn' | 'info' | 'critical'; text: string; link?: string }[] = []
    // Pages burning inventory
    for (const p of pages) {
      const m = pageMetrics(p, posts)
      if (m.status === 'over-used') {
        out.push({ id: `over-${p.id}`, severity: 'critical', text: `@${p.handle} is over-used (${Math.round(m.pctConsumed * 100)}%)`, link: `/outreach/creators/${p.id}` })
      }
    }
    // Campaigns ending soon
    const now = Date.now()
    for (const c of campaigns) {
      if (c.status !== 'active') continue
      const end = new Date(c.endDate).getTime()
      const days = Math.ceil((end - now) / 86400_000)
      if (days >= 0 && days <= 5) {
        out.push({ id: `end-${c.id}`, severity: 'warn', text: `${c.name} ends in ${days}d`, link: `/outreach/campaigns/${c.id}` })
      }
    }
    // Idle pages
    const idle = pages.filter(p => pageMetrics(p, posts).status === 'idle').length
    if (idle > 0) out.push({ id: 'idle', severity: 'info', text: `${idle} pages have no posts this month`, link: '/outreach/creators' })
    return out.slice(0, 8)
  }, [pages, campaigns, posts])

  const trendData = useMemo(() => {
    const days = 14
    const today = new Date()
    return Array.from({ length: days }, (_, i) => {
      const d = new Date(today)
      d.setDate(today.getDate() - (days - 1 - i))
      const iso = d.toISOString().slice(0, 10)
      const same = posts.filter(p => p.date === iso)
      return {
        day: `${d.getDate()}/${d.getMonth() + 1}`,
        posts: same.length,
        reach: same.reduce((s, p) => s + p.views, 0),
      }
    })
  }, [posts])

  const kpiCards = [
    { label: 'Reach (views)', value: fmt(kpis.reach), sub: `${kpis.postsCount} posts`, icon: Eye, bg: 'bg-orange-50', color: 'text-orange-600' },
    { label: 'Engagement', value: fmt(kpis.eng), sub: 'likes + comments', icon: Heart, bg: 'bg-rose-50', color: 'text-rose-600' },
    { label: 'Active campaigns', value: String(kpis.active), sub: `${campaigns.length} total`, icon: Send, bg: 'bg-blue-50', color: 'text-blue-600' },
    { label: 'Inventory used', value: `${kpis.pctInv}%`, sub: `${pages.length} pages`, icon: Layers, bg: 'bg-emerald-50', color: 'text-emerald-600' },
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

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
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

        {/* Alerts */}
        <div className="hub-card">
          <h2 className="text-sm font-semibold text-foreground flex items-center gap-2 mb-3">
            <AlertCircle className="w-4 h-4 text-muted-foreground" /> Alerts
          </h2>
          {alerts.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">All clear.</p>
          ) : (
            <div className="space-y-2">
              {alerts.map(a => {
                const Icon = a.severity === 'critical' ? AlertTriangle : a.severity === 'warn' ? AlertCircle : Activity
                const color = a.severity === 'critical' ? 'text-rose-600 bg-rose-50' : a.severity === 'warn' ? 'text-amber-600 bg-amber-50' : 'text-blue-600 bg-blue-50'
                const body = (
                  <>
                    <div className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${color}`}>
                      <Icon className="w-3.5 h-3.5" />
                    </div>
                    <span className="text-xs text-foreground">{a.text}</span>
                  </>
                )
                return a.link ? (
                  <Link key={a.id} to={a.link} className="flex items-center gap-2 p-2 rounded-lg hover:bg-accent transition-colors">{body}</Link>
                ) : (
                  <div key={a.id} className="flex items-center gap-2 p-2 rounded-lg">{body}</div>
                )
              })}
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
                return (
                  <div key={post.id} className="flex items-center gap-3 p-2 rounded-lg hover:bg-accent transition-colors">
                    <span className="hub-badge bg-orange-50 text-orange-700 shrink-0 capitalize">{post.type}</span>
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-medium text-foreground truncate">@{page?.handle ?? '—'}</p>
                      <p className="text-[11px] text-muted-foreground truncate">{camp?.name ?? '—'} · {post.date}</p>
                    </div>
                    <span className="text-xs font-mono text-foreground tabular-nums">{fmt(score)}</span>
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
              <Link to="/outreach/creators" className="text-xs text-orange-600 hover:underline">All creators</Link>
            </div>
            {topByType[t].length === 0 ? (
              <p className="text-sm text-muted-foreground py-6 text-center">No {t === 'pu' ? 'PU' : 'state'} pages yet.</p>
            ) : (
              <div className="space-y-1">
                {topByType[t].map(({ page, m }) => (
                  <Link key={page.id} to={`/outreach/creators/${page.id}`}
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
