import { useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  ArrowLeft, Users, Calendar, TrendingUp, FileText, Heart, Eye, MessageSquare, Bookmark, Share2,
  ExternalLink, Trash2, Link as LinkIcon,
} from 'lucide-react'
import {
  LineChart, Line, ResponsiveContainer, XAxis, YAxis, Tooltip, CartesianGrid,
} from 'recharts'
import { useOutreachData, pageMetrics, removePage, instagramUrlForHandle, isValidInstagramHandle, formatLocalDate, refreshOutreach } from '@/lib/outreach-data'
import { api } from '@/lib/api'
import AddLivePostsDialog from './AddLivePostsDialog'

export default function OutreachPageDetail() {
  const { pageId } = useParams<{ pageId: string }>()
  const { pages, posts, campaigns } = useOutreachData()
  const navigate = useNavigate()
  const page = pages.find(p => p.id === pageId)
  const [deleting, setDeleting] = useState(false)
  const [addingLivePosts, setAddingLivePosts] = useState(false)
  // Tracks which post row is currently being removed so we can disable its
  // button + show feedback without blocking the rest of the table.
  const [deletingPostId, setDeletingPostId] = useState<string | null>(null)

  async function handleDeletePost(postId: string) {
    if (!confirm('Remove this live post? This will reduce the page\'s analytics by its metrics.')) return
    setDeletingPostId(postId)
    try {
      await api.deleteOutreachPost(postId)
      await refreshOutreach()
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to remove post.')
    } finally {
      setDeletingPostId(null)
    }
  }

  async function handleDelete() {
    if (!page) return
    // Counts ALL posts that would CASCADE-delete with the page — auto-synced
    // rows are excluded from analytics but still get removed from the DB.
    const linked = posts.filter(p => p.pageId === page.id).length
    const msg = linked > 0
      ? `Delete @${page.handle}? This will also remove ${linked} post${linked === 1 ? '' : 's'} tied to this page. This cannot be undone.`
      : `Delete @${page.handle}? This cannot be undone.`
    if (!window.confirm(msg)) return
    setDeleting(true)
    try {
      await removePage(page.id)
      navigate('/outreach/pages')
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to delete page.')
      setDeleting(false)
    }
  }

  // Only live-added posts feed this page's analytics, totals, trend,
  // historical table, and campaign history. Auto-synced rows are excluded
  // so the page reflects what the team has actually placed, not random posts
  // scraped from the IG profile.
  const pagePosts = useMemo(
    () => posts
      .filter(p => p.pageId === pageId && p.addedAsLive)
      .sort((a, b) => b.date.localeCompare(a.date)),
    [posts, pageId]
  )
  const m = useMemo(() => page ? pageMetrics(page, posts) : null, [page, posts])

  const trend = useMemo(() => {
    const days = 30
    const today = new Date()
    return Array.from({ length: days }, (_, i) => {
      const d = new Date(today)
      d.setDate(today.getDate() - (days - 1 - i))
      // Local date — see note in formatLocalDate. Was using toISOString here,
      // which silently lost a day's worth of posts in IST.
      const iso = formatLocalDate(d)
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
        <Link to="/outreach/pages" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="w-4 h-4" /> Back to All Pages
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

      <Link to="/outreach/pages" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="w-4 h-4" /> Back to All Pages
      </Link>

      <div className="hub-card">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-4">
            <div className="w-14 h-14 rounded-xl bg-orange-100 flex items-center justify-center">
              <span className="text-xl font-semibold text-orange-700">{page.handle[0]?.toUpperCase()}</span>
            </div>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="text-xl font-serif text-foreground">@{page.handle}</h1>
                {isValidInstagramHandle(page.handle) && (
                  <a href={instagramUrlForHandle(page.handle)} target="_blank" rel="noreferrer"
                    title={`Open @${page.handle} on Instagram`}
                    className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-lg bg-orange-100 text-orange-700 hover:opacity-80">
                    <ExternalLink className="w-3 h-3" /> Open on Instagram
                  </a>
                )}
              </div>
              <p className="text-sm text-muted-foreground">
                {page.geography} · {page.state} · <span className="uppercase">{page.type}</span> · Tier {page.followerTier}
              </p>
              {page.notes && <p className="text-xs text-muted-foreground mt-1">{page.notes}</p>}
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="hub-badge bg-orange-50 text-orange-700"><Users className="w-3 h-3 inline mr-1" />{fmt(page.followers)}</span>
            <span className="hub-badge bg-blue-50 text-blue-700">Inv {page.inventoryPosts}P / {page.inventoryStories}S</span>
            <button onClick={() => setAddingLivePosts(true)}
              title="Add live posts (analytics + inventory feed off these)"
              className="text-xs px-2.5 py-1.5 rounded-lg bg-orange-100 text-orange-700 hover:opacity-80 inline-flex items-center gap-1">
              <LinkIcon className="w-3 h-3" /> Add live posts
            </button>
            <button onClick={handleDelete} disabled={deleting}
              title="Delete page"
              className="text-xs px-2.5 py-1.5 rounded-lg bg-rose-100 text-rose-700 hover:opacity-80 inline-flex items-center gap-1 disabled:opacity-50">
              <Trash2 className="w-3 h-3" /> {deleting ? 'Deleting…' : 'Delete'}
            </button>
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
                  <th className="px-3 py-2 w-8" aria-label="Actions"></th>
                </tr>
              </thead>
              <tbody>
                {pagePosts.length === 0 ? (
                  <tr><td colSpan={10} className="px-3 py-12 text-center text-sm text-muted-foreground">No posts yet.</td></tr>
                ) : pagePosts.slice(0, 50).map(p => {
                  const c = campaigns.find(c => c.id === p.campaignId)
                  const isRowDeleting = deletingPostId === p.id
                  return (
                    <tr key={p.id} className="border-b border-border last:border-0 hover:bg-accent/40">
                      <td className="px-3 py-2 text-xs text-foreground">
                        {p.permalink ? (
                          <a href={p.permalink} target="_blank" rel="noreferrer"
                            title="Open on Instagram"
                            className="inline-flex items-center gap-1 text-orange-600 hover:underline">
                            {p.date}
                            <ExternalLink className="w-3 h-3" />
                          </a>
                        ) : p.date}
                      </td>
                      <td className="px-3 py-2 text-xs text-foreground truncate max-w-[160px]">{c?.name ?? '—'}</td>
                      <td className="px-3 py-2"><span className="hub-badge bg-orange-50 text-orange-700 capitalize">{p.type}</span></td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">{p.creativeVariant ?? '—'}</td>
                      <td className="px-3 py-2 text-right text-xs font-mono tabular-nums">{fmt(p.likes)}</td>
                      <td className="px-3 py-2 text-right text-xs font-mono tabular-nums">{fmt(p.comments)}</td>
                      {/* Views: show the exact total (not abbreviated) so the real
                          per-post reach is auditable. */}
                      <td className="px-3 py-2 text-right text-xs font-mono tabular-nums" title={`${p.views.toLocaleString('en-US')} views`}>{p.views.toLocaleString('en-US')}</td>
                      <td className="px-3 py-2 text-right text-xs font-mono tabular-nums">{fmt(p.saves)}</td>
                      <td className="px-3 py-2 text-right text-xs font-mono tabular-nums">{fmt(p.shares)}</td>
                      <td className="px-3 py-2 text-right">
                        <button
                          type="button"
                          onClick={() => void handleDeletePost(p.id)}
                          disabled={isRowDeleting}
                          aria-label="Remove this live post"
                          title="Remove this live post"
                          className="p-1 rounded-md text-muted-foreground hover:bg-red-50 hover:text-red-600 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </td>
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

      {addingLivePosts && (
        <AddLivePostsDialog
          mode="page"
          pageId={page.id}
          onClose={() => setAddingLivePosts(false)}
        />
      )}

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
