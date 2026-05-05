import { useMemo } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  ArrowLeft, Users, Calendar, TrendingUp, FileText, Heart, Eye, MessageSquare, Bookmark, Share2,
} from 'lucide-react'
import {
  LineChart, Line, ResponsiveContainer, XAxis, YAxis, Tooltip, CartesianGrid,
} from 'recharts'
import { useOutreachData, pageMetrics } from '@/lib/outreach-data'

export default function OutreachPageDetail() {
  const { pageId } = useParams<{ pageId: string }>()
  const { pages, posts, campaigns } = useOutreachData()
  const page = pages.find(p => p.id === pageId)

  const pagePosts = useMemo(
    () => posts.filter(p => p.pageId === pageId).sort((a, b) => b.date.localeCompare(a.date)),
    [posts, pageId]
  )
  const m = useMemo(() => page ? pageMetrics(page, posts) : null, [page, posts])

  const trend = useMemo(() => {
    const days = 30
    const today = new Date()
    return Array.from({ length: days }, (_, i) => {
      const d = new Date(today)
      d.setDate(today.getDate() - (days - 1 - i))
      const iso = d.toISOString().slice(0, 10)
      const same = pagePosts.filter(p => p.date === iso)
      return {
        day: `${d.getDate()}/${d.getMonth() + 1}`,
        engagement: same.reduce((s, p) => s + p.likes + p.comments + p.saves + p.shares, 0),
      }
    })
  }, [pagePosts])

  const campaignHistory = useMemo(() => {
    const grouped = new Map<string, number>()
    for (const p of pagePosts) grouped.set(p.campaignId, (grouped.get(p.campaignId) ?? 0) + 1)
    return Array.from(grouped.entries())
      .map(([cid, count]) => ({ campaign: campaigns.find(c => c.id === cid), count }))
      .filter(x => x.campaign)
      .sort((a, b) => b.count - a.count)
  }, [pagePosts, campaigns])

  if (!page) {
    return (
      <div className="animate-fade-in space-y-4">
        <Link to="/outreach/creators" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="w-4 h-4" /> Back to Creators
        </Link>
        <div className="hub-card text-center py-12">
          <p className="text-sm text-muted-foreground">Page not found.</p>
        </div>
      </div>
    )
  }

  const totals = pagePosts.reduce((acc, p) => ({
    likes: acc.likes + p.likes, comments: acc.comments + p.comments,
    views: acc.views + p.views, saves: acc.saves + p.saves, shares: acc.shares + p.shares,
  }), { likes: 0, comments: 0, views: 0, saves: 0, shares: 0 })

  return (
    <div className="animate-fade-in space-y-5">

      <Link to="/outreach/creators" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="w-4 h-4" /> Back to Creators
      </Link>

      <div className="hub-card">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-4">
            <div className="w-14 h-14 rounded-xl bg-orange-100 flex items-center justify-center">
              <span className="text-xl font-semibold text-orange-700">{page.handle[0]?.toUpperCase()}</span>
            </div>
            <div>
              <h1 className="text-xl font-serif text-foreground">@{page.handle}</h1>
              <p className="text-sm text-muted-foreground">
                {page.geography} · {page.state} · <span className="capitalize">{page.type}</span> · {page.followerTier} tier
              </p>
              {page.notes && <p className="text-xs text-muted-foreground mt-1">{page.notes}</p>}
            </div>
          </div>
          <div className="flex gap-2">
            <span className="hub-badge bg-orange-50 text-orange-700"><Users className="w-3 h-3 inline mr-1" />{fmt(page.followers)}</span>
            <span className="hub-badge bg-blue-50 text-blue-700">Inv {page.inventoryPosts}P / {page.inventoryStories}S</span>
          </div>
        </div>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <Kpi label="Posts MTD"   value={String(m?.postsDoneMTD ?? 0)} icon={FileText}  bg="bg-orange-50" color="text-orange-600" />
        <Kpi label="% consumed"  value={`${Math.round((m?.pctConsumed ?? 0) * 100)}%`} icon={TrendingUp} bg="bg-blue-50" color="text-blue-600" />
        <Kpi label="Avg eng"     value={fmt(m?.avgEngagement ?? 0)} icon={Heart}    bg="bg-rose-50" color="text-rose-600" />
        <Kpi label="Total reach" value={fmt(totals.views)}            icon={Eye}      bg="bg-emerald-50" color="text-emerald-600" />
        <Kpi label="Last post"   value={m?.lastPostDate ?? '—'}       icon={Calendar} bg="bg-amber-50"   color="text-amber-600" />
      </div>

      {/* Trend */}
      <div className="hub-card">
        <h2 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
          <TrendingUp className="w-4 h-4 text-muted-foreground" /> Engagement (last 30 days)
        </h2>
        <ResponsiveContainer width="100%" height={200}>
          <LineChart data={trend} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
            <XAxis dataKey="day" tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} tickLine={false} axisLine={false} />
            <YAxis tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} tickLine={false} axisLine={false} width={36} />
            <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid hsl(var(--border))', background: 'hsl(var(--card))' }} />
            <Line type="monotone" dataKey="engagement" stroke="#f97316" strokeWidth={2} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* Historical posts */}
        <div className="hub-card lg:col-span-2 p-0 overflow-hidden">
          <div className="flex items-center justify-between p-4 border-b border-border">
            <h2 className="text-sm font-semibold text-foreground">Historical posts ({pagePosts.length})</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-widest text-muted-foreground border-b border-border">
                  <th className="px-3 py-2">Date</th>
                  <th className="px-3 py-2">Campaign</th>
                  <th className="px-3 py-2">Type</th>
                  <th className="px-3 py-2">Variant</th>
                  <th className="px-3 py-2 text-right"><Heart className="w-3 h-3 inline" /></th>
                  <th className="px-3 py-2 text-right"><MessageSquare className="w-3 h-3 inline" /></th>
                  <th className="px-3 py-2 text-right"><Eye className="w-3 h-3 inline" /></th>
                  <th className="px-3 py-2 text-right"><Bookmark className="w-3 h-3 inline" /></th>
                  <th className="px-3 py-2 text-right"><Share2 className="w-3 h-3 inline" /></th>
                </tr>
              </thead>
              <tbody>
                {pagePosts.length === 0 ? (
                  <tr><td colSpan={9} className="px-3 py-12 text-center text-sm text-muted-foreground">No posts yet.</td></tr>
                ) : pagePosts.slice(0, 50).map(p => {
                  const c = campaigns.find(c => c.id === p.campaignId)
                  return (
                    <tr key={p.id} className="border-b border-border last:border-0 hover:bg-accent/40">
                      <td className="px-3 py-2 text-xs text-foreground">{p.date}</td>
                      <td className="px-3 py-2 text-xs text-foreground truncate max-w-[160px]">{c?.name ?? '—'}</td>
                      <td className="px-3 py-2"><span className="hub-badge bg-orange-50 text-orange-700 capitalize">{p.type}</span></td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">{p.creativeVariant ?? '—'}</td>
                      <td className="px-3 py-2 text-right text-xs font-mono tabular-nums">{fmt(p.likes)}</td>
                      <td className="px-3 py-2 text-right text-xs font-mono tabular-nums">{fmt(p.comments)}</td>
                      <td className="px-3 py-2 text-right text-xs font-mono tabular-nums">{fmt(p.views)}</td>
                      <td className="px-3 py-2 text-right text-xs font-mono tabular-nums">{fmt(p.saves)}</td>
                      <td className="px-3 py-2 text-right text-xs font-mono tabular-nums">{fmt(p.shares)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* Campaign history */}
        <div className="hub-card">
          <h2 className="text-sm font-semibold text-foreground mb-3">Campaign history</h2>
          {campaignHistory.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">No campaigns yet.</p>
          ) : (
            <div className="space-y-1">
              {campaignHistory.map(({ campaign, count }) => campaign && (
                <Link key={campaign.id} to={`/outreach/campaigns/${campaign.id}`}
                  className="flex items-center justify-between gap-2 p-2 rounded-lg hover:bg-accent transition-colors">
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-foreground truncate">{campaign.name}</p>
                    <p className="text-[11px] text-muted-foreground capitalize">{campaign.status}</p>
                  </div>
                  <span className="hub-badge bg-orange-50 text-orange-700 shrink-0">{count} posts</span>
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>

    </div>
  )
}

function Kpi({ label, value, icon: Icon, bg, color }: { label: string; value: string; icon: React.ElementType; bg: string; color: string }) {
  return (
    <div className="hub-card flex items-center gap-3 py-3">
      <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${bg} shrink-0`}>
        <Icon className={`w-4 h-4 ${color}`} />
      </div>
      <div className="min-w-0">
        <div className="text-lg font-serif text-foreground leading-none">{value}</div>
        <div className="text-[11px] text-muted-foreground mt-1 truncate">{label}</div>
      </div>
    </div>
  )
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}
