import { useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  ArrowLeft, Send, Calendar, Heart, Eye, FileText, Pause, Play, CheckCircle,
  Link as LinkIcon, Trash2, Users, Download,
} from 'lucide-react'
import AddLivePostsDialog from './AddLivePostsDialog'
import { buildCampaignReport, exportCampaignReportPdf, exportCampaignReportDocx } from '@/lib/outreach-export'
import {
  BarChart, Bar, ResponsiveContainer, XAxis, YAxis, Tooltip, CartesianGrid,
} from 'recharts'
import {
  useOutreachData, updateCampaign, removeCampaign, campaignMetrics,
  type CampaignStatus,
} from '@/lib/outreach-data'

const STATUS_CFG: Record<CampaignStatus, { label: string; cls: string }> = {
  planning:  { label: 'Planning',  cls: 'bg-blue-100 text-blue-700' },
  active:    { label: 'Active',    cls: 'bg-emerald-100 text-emerald-700' },
  paused:    { label: 'Paused',    cls: 'bg-amber-100 text-amber-700' },
  completed: { label: 'Completed', cls: 'bg-muted text-muted-foreground' },
}

export default function OutreachCampaignDetail() {
  const { campaignId } = useParams<{ campaignId: string }>()
  const { campaigns, posts, pages, creators } = useOutreachData()
  const navigate = useNavigate()
  const campaign = campaigns.find(c => c.id === campaignId)
  const [showAllPages, setShowAllPages] = useState(false)
  const [livePostsOpen, setLivePostsOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)

  async function handleDelete() {
    if (!campaign) return
    const linked = posts.filter(p => p.campaignId === campaign.id).length
    const msg = linked > 0
      ? `Delete "${campaign.name}"? ${linked} post${linked === 1 ? '' : 's'} attributed to it will be kept but unattributed. This cannot be undone.`
      : `Delete "${campaign.name}"? This cannot be undone.`
    if (!window.confirm(msg)) return
    setDeleting(true)
    try {
      await removeCampaign(campaign.id)
      navigate('/outreach/campaigns')
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to delete campaign.')
      setDeleting(false)
    }
  }

  const m = useMemo(() => campaign ? campaignMetrics(campaign, posts) : null, [campaign, posts])

  const perPage = useMemo(() => {
    if (!campaign) return []
    return campaign.assignedPageIds.map(pid => {
      const page = pages.find(p => p.id === pid)
      // Only count posts explicitly added via Add Live Posts — Apify-synced
      // backlog posts (the page's lifetime Instagram feed) get attributed by
      // accident otherwise and inflate every campaign's "delivered" count.
      const pp = posts.filter(p => p.pageId === pid && p.campaignId === campaign.id && p.addedAsLive)
      return {
        page,
        delivered: pp.length,
        likes: pp.reduce((s, p) => s + p.likes, 0),
        comments: pp.reduce((s, p) => s + p.comments, 0),
        views: pp.reduce((s, p) => s + p.views, 0),
        engagement: pp.reduce((s, p) => s + p.likes + p.comments + p.saves + p.shares, 0),
      }
    }).filter(x => x.page).sort((a, b) => b.engagement - a.engagement)
  }, [campaign, posts, pages])

  const variantStats = useMemo(() => {
    if (!campaign) return []
    return campaign.creativeVariants.map(v => {
      const vp = posts.filter(p => p.campaignId === campaign.id && p.creativeVariant === v && p.addedAsLive)
      return {
        variant: v,
        posts: vp.length,
        avgEng: vp.length ? Math.round(vp.reduce((s, p) => s + p.likes + p.comments + p.saves + p.shares, 0) / vp.length) : 0,
      }
    })
  }, [campaign, posts])

  if (!campaign || !m) {
    return (
      <div className="animate-fade-in space-y-4">
        <Link to="/outreach/campaigns" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="w-4 h-4" /> Back to Campaigns
        </Link>
        <div className="hub-card text-center py-12">
          <p className="text-sm text-muted-foreground">Campaign not found.</p>
        </div>
      </div>
    )
  }

  function setStatus(s: CampaignStatus) {
    if (!campaign) return
    updateCampaign(campaign.id, { status: s })
  }

  return (
    <div className="animate-fade-in space-y-5">

      <Link to="/outreach/campaigns" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="w-4 h-4" /> Back to Campaigns
      </Link>

      <div className="hub-card">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-4">
            <div className="w-14 h-14 rounded-xl bg-orange-100 flex items-center justify-center">
              <Send className="w-6 h-6 text-orange-600" />
            </div>
            <div>
              <h1 className="text-xl font-serif text-foreground">{campaign.name}</h1>
              <p className="text-sm text-muted-foreground">
                {campaign.startDate} → {campaign.endDate}
                {campaign.state && ` · ${campaign.state}`}
                {' · '}{campaign.assignedPageIds.length} pages
                {campaign.assignedCreatorIds.length > 0 && ` · ${campaign.assignedCreatorIds.length} creators`}
                {' · '}{campaign.creativeVariants.length} variants
              </p>
              {campaign.goal && <p className="text-xs text-muted-foreground mt-1">Goal: {campaign.goal}</p>}
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`hub-badge ${STATUS_CFG[campaign.status].cls}`}>{STATUS_CFG[campaign.status].label}</span>
            <button
              onClick={() => setLivePostsOpen(true)}
              className="text-xs px-2.5 py-1.5 rounded-lg bg-orange-100 text-orange-700 hover:opacity-80 inline-flex items-center gap-1"
            >
              <LinkIcon className="w-3 h-3" /> Add live posts
            </button>
            <button
              onClick={() => exportCampaignReportPdf(buildCampaignReport(campaign, pages, creators, posts))}
              className="text-xs px-2.5 py-1.5 rounded-lg bg-blue-100 text-blue-700 hover:opacity-80 inline-flex items-center gap-1"
            >
              <Download className="w-3 h-3" /> Export PDF
            </button>
            <button
              onClick={async () => { await exportCampaignReportDocx(buildCampaignReport(campaign, pages, creators, posts)) }}
              className="text-xs px-2.5 py-1.5 rounded-lg bg-indigo-100 text-indigo-700 hover:opacity-80 inline-flex items-center gap-1"
            >
              <Download className="w-3 h-3" /> Export Word
            </button>
            {campaign.status === 'planning' && (
              <button onClick={() => setStatus('active')} className="text-xs px-2.5 py-1.5 rounded-lg bg-emerald-100 text-emerald-700 hover:opacity-80 inline-flex items-center gap-1">
                <Play className="w-3 h-3" /> Activate
              </button>
            )}
            {campaign.status === 'active' && (
              <>
                <button onClick={() => setStatus('paused')} className="text-xs px-2.5 py-1.5 rounded-lg bg-amber-100 text-amber-700 hover:opacity-80 inline-flex items-center gap-1">
                  <Pause className="w-3 h-3" /> Pause
                </button>
                <button onClick={() => setStatus('completed')} className="text-xs px-2.5 py-1.5 rounded-lg bg-muted text-muted-foreground hover:opacity-80 inline-flex items-center gap-1">
                  <CheckCircle className="w-3 h-3" /> Complete
                </button>
              </>
            )}
            {campaign.status === 'paused' && (
              <button onClick={() => setStatus('active')} className="text-xs px-2.5 py-1.5 rounded-lg bg-emerald-100 text-emerald-700 hover:opacity-80 inline-flex items-center gap-1">
                <Play className="w-3 h-3" /> Resume
              </button>
            )}
            <button onClick={handleDelete} disabled={deleting}
              title="Delete campaign"
              className="text-xs px-2.5 py-1.5 rounded-lg bg-rose-100 text-rose-700 hover:opacity-80 inline-flex items-center gap-1 disabled:opacity-50">
              <Trash2 className="w-3 h-3" /> {deleting ? 'Deleting…' : 'Delete'}
            </button>
          </div>
        </div>

        {/* Progress */}
        <div className="mt-4">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[10px] uppercase tracking-widest text-muted-foreground">Post completion</span>
            <span className="text-xs font-mono tabular-nums text-foreground">{m.postsDelivered + m.storiesDelivered + m.reelsDelivered} / {m.totalBudget} ({Math.round(m.pctConsumed * 100)}%)</span>
          </div>
          <div className="h-2 rounded-full bg-muted overflow-hidden">
            <div className={`h-full ${m.pctConsumed >= 1 ? 'bg-rose-500' : m.pctConsumed >= 0.7 ? 'bg-amber-500' : 'bg-orange-500'}`}
              style={{ width: `${Math.min(100, m.pctConsumed * 100)}%` }} />
          </div>
        </div>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <Kpi label="Posts"  value={`${m.postsDelivered}/${campaign.budgetPosts}`}  icon={FileText} bg="bg-orange-50" color="text-orange-600" />
        <Kpi label="Stories" value={`${m.storiesDelivered}/${campaign.budgetStories}`} icon={FileText} bg="bg-blue-50" color="text-blue-600" />
        <Kpi label="Reels"  value={`${m.reelsDelivered}/${campaign.budgetReels}`}  icon={FileText} bg="bg-rose-50" color="text-rose-600" />
        <Kpi label="Total reach" value={fmt(m.totalReach)} icon={Eye} bg="bg-emerald-50" color="text-emerald-600" />
        <Kpi label="Total engagement" value={fmt(m.totalEngagement)} icon={Heart} bg="bg-amber-50" color="text-amber-600" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* Per-page delivery table */}
        <div className="hub-card lg:col-span-2 p-0 overflow-hidden">
          <div className="flex items-center justify-between p-4 border-b border-border">
            <h2 className="text-sm font-semibold text-foreground">Per-page delivery</h2>
            {perPage.length > 8 && (
              <button onClick={() => setShowAllPages(s => !s)} className="text-xs text-orange-600 hover:underline">
                {showAllPages ? 'Show top 8' : `Show all ${perPage.length}`}
              </button>
            )}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-widest text-muted-foreground border-b border-border">
                  <th className="px-3 py-2">Page</th>
                  <th className="px-3 py-2">Geography</th>
                  <th className="px-3 py-2 text-right">Delivered</th>
                  <th className="px-3 py-2 text-right">Reach</th>
                  <th className="px-3 py-2 text-right">Engagement</th>
                  <th className="px-3 py-2 w-8"></th>
                </tr>
              </thead>
              <tbody>
                {(showAllPages ? perPage : perPage.slice(0, 8)).map(({ page, delivered, views, engagement }) => page && (
                  <tr key={page.id} className="border-b border-border last:border-0 hover:bg-accent/40">
                    <td className="px-3 py-2.5">
                      <Link to={`/outreach/pages/${page.id}`} className="text-xs font-medium text-foreground hover:underline">@{page.handle}</Link>
                    </td>
                    <td className="px-3 py-2.5 text-xs text-muted-foreground">{page.geography}</td>
                    <td className="px-3 py-2.5 text-right text-xs font-mono tabular-nums">{delivered}</td>
                    {/* Reach = total views for this page in the campaign; show the
                        exact number rather than an abbreviation. */}
                    <td className="px-3 py-2.5 text-right text-xs font-mono tabular-nums" title={`${views.toLocaleString('en-US')} views`}>{views.toLocaleString('en-US')}</td>
                    <td className="px-3 py-2.5 text-right text-xs font-mono tabular-nums">{fmt(engagement)}</td>
                    <td className="px-3 py-2.5 text-right">
                      <button
                        onClick={async () => {
                          if (!campaign) return
                          if (!confirm(`Remove @${page.handle} from this campaign? The page itself stays — only the assignment is cleared.`)) return
                          await updateCampaign(campaign.id, {
                            assignedPageIds: campaign.assignedPageIds.filter(id => id !== page.id),
                          })
                        }}
                        title="Remove page from campaign"
                        className="p-1 rounded-md text-muted-foreground hover:bg-rose-50 hover:text-rose-600"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Variant performance */}
        <div className="hub-card">
          <h2 className="text-sm font-semibold text-foreground mb-3">Creative variant performance</h2>
          {variantStats.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">No variants defined.</p>
          ) : (
            <ResponsiveContainer width="100%" height={Math.max(160, variantStats.length * 32)}>
              <BarChart data={variantStats} layout="vertical" margin={{ top: 0, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" horizontal={false} />
                <XAxis type="number" tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} tickLine={false} axisLine={false} />
                <YAxis dataKey="variant" type="category" tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} tickLine={false} axisLine={false} width={64} />
                <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid hsl(var(--border))', background: 'hsl(var(--card))' }} />
                <Bar dataKey="avgEng" fill="#f97316" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
          <div className="mt-3 space-y-1">
            {variantStats.map(v => (
              <div key={v.variant} className="flex items-center justify-between text-xs">
                <span className="font-mono">{v.variant}</span>
                <span className="text-muted-foreground">{v.posts} posts · {fmt(v.avgEng)} avg eng</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Assigned creators — listed separately from pages since creators are
          a distinct entity. Sync isn't wired up for creators yet, so we show
          profile info and Instagram links rather than per-creator post stats. */}
      <div className="hub-card">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
            <Users className="w-4 h-4 text-muted-foreground" /> Assigned creators
            <span className="text-xs text-muted-foreground font-normal">({campaign.assignedCreatorIds.length})</span>
          </h2>
        </div>
        {campaign.assignedCreatorIds.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">No creators assigned.</p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
            {campaign.assignedCreatorIds.map(cid => {
              const creator = creators.find(c => c.id === cid)
              if (!creator) {
                return (
                  <div key={cid} className="hub-card py-2 bg-muted/40">
                    <p className="text-xs text-muted-foreground italic">Deleted creator ({cid})</p>
                  </div>
                )
              }
              return (
                <Link key={cid} to={`/outreach/creators/${creator.id}`}
                  className="hub-card py-2 hover:shadow-md transition-shadow flex items-center gap-3">
                  <div className="w-9 h-9 rounded-full bg-orange-100 flex items-center justify-center shrink-0">
                    <span className="text-xs font-semibold text-orange-700">{creator.handle[0]?.toUpperCase()}</span>
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium text-foreground truncate">@{creator.handle}</p>
                    <p className="text-[11px] text-muted-foreground truncate">
                      {creator.geography} · <span className="uppercase">{creator.type}</span> · Tier {creator.followerTier}
                    </p>
                  </div>
                </Link>
              )
            })}
          </div>
        )}
      </div>

      <div className="hub-card">
        <h2 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
          <Calendar className="w-4 h-4 text-muted-foreground" /> Approvers
        </h2>
        <div className="flex flex-wrap gap-2">
          {campaign.approvers.length === 0 ? (
            <span className="text-xs text-muted-foreground">No approvers set.</span>
          ) : campaign.approvers.map(a => (
            <span key={a} className="hub-badge bg-orange-50 text-orange-700">{a}</span>
          ))}
        </div>
      </div>

      {livePostsOpen && (
        <AddLivePostsDialog campaign={campaign} onClose={() => setLivePostsOpen(false)} />
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
