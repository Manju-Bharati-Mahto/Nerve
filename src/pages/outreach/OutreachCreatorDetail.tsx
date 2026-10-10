import { useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  ArrowLeft, Users, Calendar, TrendingUp, FileText, Heart, Eye, MessageSquare,
  Bookmark, Share2, ExternalLink, Trash2, Pencil, Link as LinkIcon,
} from 'lucide-react'
import {
  LineChart, Line, ResponsiveContainer, XAxis, YAxis, Tooltip, CartesianGrid,
} from 'recharts'
import {
  useOutreachData, removeCreator, updateCreator, instagramUrlForHandle, isValidInstagramHandle,
  formatLocalDate, PAGE_TYPES, FOLLOWER_TIERS, PAGE_CONTENT_TYPES,
  type OutreachCreator, type PageType, type FollowerTier, type PageContentType,
} from '@/lib/outreach-data'
import StateSelect from './StateSelect'
import AddLivePostsDialog from './AddLivePostsDialog'
import { useCanEditPosts, useCanEditTab, useIsOutreachAdmin } from '@/lib/outreach-access'

export default function OutreachCreatorDetail() {
  const { creatorId } = useParams<{ creatorId: string }>()
  const { creators, campaigns, posts } = useOutreachData()
  const navigate = useNavigate()
  const creator = creators.find(c => c.id === creatorId)
  const [deleting, setDeleting] = useState(false)
  const [livePostsOpen, setLivePostsOpen] = useState(false)
  // By tab level, as the server decides: Edit on Creators edits; deleting is the manager's.
  const canEdit = useCanEditTab('creators')
  const canEditPosts = useCanEditPosts()
  const isAdmin = useIsOutreachAdmin()
  const [editing, setEditing] = useState(false)

  // Posts attributed to this creator. Sorted newest first for the table.
  const creatorPosts = useMemo(
    () => posts.filter(p => p.creatorId === creatorId).sort((a, b) => b.date.localeCompare(a.date)),
    [posts, creatorId],
  )

  async function handleDelete() {
    if (!creator) return
    const linked = creatorPosts.length
    const msg = linked > 0
      ? `Delete @${creator.handle}? This will also remove ${linked} post${linked === 1 ? '' : 's'} tied to this creator. This cannot be undone.`
      : `Delete @${creator.handle}? This cannot be undone.`
    if (!window.confirm(msg)) return
    setDeleting(true)
    try {
      await removeCreator(creator.id)
      navigate('/outreach/creators')
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to delete creator.')
      setDeleting(false)
    }
  }

  // Engagement over the last 30 days, computed from real posts now.
  const trend = useMemo(() => {
    const days = 30
    const today = new Date()
    return Array.from({ length: days }, (_, i) => {
      const d = new Date(today)
      d.setDate(today.getDate() - (days - 1 - i))
      const iso = formatLocalDate(d)
      const same = creatorPosts.filter(p => p.date === iso)
      return {
        day: `${d.getDate()}/${d.getMonth() + 1}`,
        engagement: same.reduce((s, p) => s + p.likes + p.comments + p.saves + p.shares, 0),
      }
    })
  }, [creatorPosts])

  // Real KPI numbers. % consumed uses MTD posts/stories vs the creator's
  // inventory caps — same definition as for pages.
  const kpis = useMemo(() => {
    const now = new Date()
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
    const mtd = creatorPosts.filter(p => new Date(p.date) >= monthStart)
    const postsCount = mtd.filter(p => p.type !== 'story').length
    const storyCount = mtd.filter(p => p.type === 'story').length
    const pctPosts   = creator?.inventoryPosts   ? postsCount / creator.inventoryPosts   : 0
    const pctStories = creator?.inventoryStories ? storyCount / creator.inventoryStories : 0
    const pctConsumed = (pctPosts + pctStories) / 2
    const totalEng = mtd.reduce((s, p) => s + p.likes + p.comments, 0)
    const avgEngagement = mtd.length ? Math.round(totalEng / mtd.length) : 0
    const totalReach = creatorPosts.reduce((s, p) => s + p.views, 0)
    return {
      postsDoneMTD: postsCount + storyCount,
      pctConsumed,
      avgEngagement,
      totalReach,
      lastPostDate: creatorPosts[0]?.date ?? null,
    }
  }, [creatorPosts, creator])

  const campaignHistory = useMemo(() => {
    if (!creator) return []
    // Campaigns where the creator is assigned OR where a creator-attributed
    // post was attributed to a campaign (covers the standalone-then-attached
    // edge case).
    const ids = new Set<string>(creator ? campaigns.filter(c => c.assignedCreatorIds.includes(creator.id)).map(c => c.id) : [])
    for (const p of creatorPosts) if (p.campaignId) ids.add(p.campaignId)
    return Array.from(ids).map(id => campaigns.find(c => c.id === id)).filter((c): c is NonNullable<typeof c> => !!c)
      .sort((a, b) => b.startDate.localeCompare(a.startDate))
  }, [campaigns, creator, creatorPosts])

  if (!creator) {
    return (
      <div className="animate-fade-in space-y-4">
        <Link to="/outreach/creators" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="w-4 h-4" /> Back to Creators
        </Link>
        <div className="hub-card text-center py-12">
          <p className="text-sm text-muted-foreground">Creator not found.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="animate-fade-in space-y-5">

      <Link to="/outreach/creators" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="w-4 h-4" /> Back to Creators
      </Link>

      <div className="hub-card">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-4">
            <div className="w-14 h-14 rounded-xl bg-orange-100 flex items-center justify-center">
              <span className="text-xl font-semibold text-orange-700">{creator.handle[0]?.toUpperCase()}</span>
            </div>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="text-xl font-serif text-foreground">@{creator.handle}</h1>
                {isValidInstagramHandle(creator.handle) && (
                  <a href={instagramUrlForHandle(creator.handle)} target="_blank" rel="noreferrer"
                    title={`Open @${creator.handle} on Instagram`}
                    className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-lg bg-orange-100 text-orange-700 hover:opacity-80">
                    <ExternalLink className="w-3 h-3" /> Open on Instagram
                  </a>
                )}
              </div>
              <p className="text-sm text-muted-foreground">
                {creator.geography} · {creator.state} · <span className="uppercase">{creator.type}</span> · Tier {creator.followerTier}
              </p>
              {creator.notes && <p className="text-xs text-muted-foreground mt-1">{creator.notes}</p>}
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="hub-badge bg-orange-50 text-orange-700"><Users className="w-3 h-3 inline mr-1" />{fmt(creator.followers)}</span>
            <span className="hub-badge bg-blue-50 text-blue-700">Inv {creator.inventoryPosts}P / {creator.inventoryStories}S</span>
            {canEditPosts && (
              <button
                onClick={() => setLivePostsOpen(true)}
                className="text-xs px-2.5 py-1.5 rounded-lg bg-orange-100 text-orange-700 hover:opacity-80 inline-flex items-center gap-1"
              >
                <LinkIcon className="w-3 h-3" /> Add live posts
              </button>
            )}
            {/* Without this a wrong inventory or tier could only be fixed by
                deleting the creator — which also deletes its posts. */}
            {canEdit && (
              <button onClick={() => setEditing(true)}
                title="Edit location, tier and inventory"
                className="text-xs px-2.5 py-1.5 rounded-lg bg-accent text-foreground hover:opacity-80 inline-flex items-center gap-1">
                <Pencil className="w-3 h-3" /> Edit
              </button>
            )}
            {isAdmin && (
              <button onClick={handleDelete} disabled={deleting}
                title="Delete creator"
                className="text-xs px-2.5 py-1.5 rounded-lg bg-rose-100 text-rose-700 hover:opacity-80 inline-flex items-center gap-1 disabled:opacity-50">
                <Trash2 className="w-3 h-3" /> {deleting ? 'Deleting…' : 'Delete'}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <Kpi label="Posts MTD"   value={String(kpis.postsDoneMTD)}             icon={FileText}   bg="bg-orange-50"  color="text-orange-600" />
        <Kpi label="% consumed"  value={`${Math.round(kpis.pctConsumed * 100)}%`} icon={TrendingUp} bg="bg-blue-50"    color="text-blue-600" />
        <Kpi label="Avg eng"     value={fmt(kpis.avgEngagement)}                  icon={Heart}      bg="bg-rose-50"    color="text-rose-600" />
        <Kpi label="Total reach" value={fmt(kpis.totalReach)}                     icon={Eye}        bg="bg-emerald-50" color="text-emerald-600" />
        <Kpi label="Last post"   value={kpis.lastPostDate ?? '—'}                 icon={Calendar}   bg="bg-amber-50"   color="text-amber-600" />
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
        {/* Historical posts — actual posts attributed to this creator. */}
        <div className="hub-card lg:col-span-2 p-0 overflow-hidden">
          <div className="flex items-center justify-between p-4 border-b border-border">
            <h2 className="text-sm font-semibold text-foreground">Historical posts ({creatorPosts.length})</h2>
            {canEditPosts && (
              <button
                onClick={() => setLivePostsOpen(true)}
                className="text-xs text-orange-600 hover:underline inline-flex items-center gap-1"
              >
                <LinkIcon className="w-3 h-3" /> Add live posts
              </button>
            )}
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
                {creatorPosts.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="px-3 py-12 text-center text-sm text-muted-foreground">
                      No posts yet. Hit <span className="font-medium text-foreground">Add live posts</span> to attach Instagram URLs and pull live metrics.
                    </td>
                  </tr>
                ) : creatorPosts.slice(0, 50).map(p => {
                  const c = campaigns.find(c => c.id === p.campaignId)
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
            <p className="text-sm text-muted-foreground py-6 text-center">Not assigned to any campaigns yet.</p>
          ) : (
            <div className="space-y-1">
              {campaignHistory.map(c => (
                <Link key={c.id} to={`/outreach/campaigns/${c.id}`}
                  className="flex items-center justify-between gap-2 p-2 rounded-lg hover:bg-accent transition-colors">
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-foreground truncate">{c.name}</p>
                    <p className="text-[11px] text-muted-foreground capitalize">{c.status} · {c.startDate}</p>
                  </div>
                  <span className="hub-badge bg-orange-50 text-orange-700 shrink-0 capitalize">{c.status}</span>
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>

      {livePostsOpen && (
        <AddLivePostsDialog
          mode="creator"
          creatorId={creator.id}
          onClose={() => setLivePostsOpen(false)}
        />
      )}

      {editing && <EditCreatorModal creator={creator} onClose={() => setEditing(false)} />}

    </div>
  )
}

type CreatorForm = Pick<OutreachCreator,
  'geography' | 'state' | 'type' | 'followerTier' | 'contentTypes' |
  'followers' | 'inventoryPosts' | 'inventoryStories' | 'notes'>

// Everything Add creator asks for except the handle, which is the creator's
// identity (its id and its Instagram link derive from it).
function EditCreatorModal({ creator, onClose }: { creator: OutreachCreator; onClose: () => void }) {
  const initial: CreatorForm = {
    geography: creator.geography, state: creator.state, type: creator.type,
    followerTier: creator.followerTier, contentTypes: creator.contentTypes,
    followers: creator.followers, inventoryPosts: creator.inventoryPosts,
    inventoryStories: creator.inventoryStories, notes: creator.notes,
  }
  const [form, setForm] = useState<CreatorForm>(initial)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const changed = JSON.stringify(form) !== JSON.stringify(initial)
  const canSave = changed && !!form.geography.trim() && !!form.state.trim() && !saving

  function toggleContentType(t: PageContentType) {
    setForm(f => ({
      ...f,
      contentTypes: f.contentTypes.includes(t) ? f.contentTypes.filter(x => x !== t) : [...f.contentTypes, t],
    }))
  }

  const count = (raw: string) => Math.max(0, Math.floor(Number(raw) || 0))

  async function save() {
    if (!canSave) return
    setSaving(true); setError(null)
    try {
      await updateCreator(creator.id, { ...form, geography: form.geography.trim(), state: form.state.trim() })
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save creator.')
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4 animate-fade-in" onClick={() => { if (!saving) onClose() }}>
      <div className="bg-card rounded-xl border border-border w-full max-w-lg" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between p-4 border-b border-border">
          <h2 className="text-base font-serif text-foreground">Edit @{creator.handle}</h2>
          <button onClick={onClose} disabled={saving} className="text-muted-foreground hover:text-foreground text-xl leading-none disabled:opacity-40">×</button>
        </div>
        <div className="p-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="hub-label">Geography *</label>
              <input className="hub-input" value={form.geography} onChange={e => setForm(f => ({ ...f, geography: e.target.value }))} />
            </div>
            <div>
              <label className="hub-label">State *</label>
              {/* A legacy state shows as "unrecognised" until replaced; left
                  as it is, it is sent back unchanged, which the server accepts. */}
              <StateSelect value={form.state} onChange={state => setForm(f => ({ ...f, state }))} aria-label="State" />
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
                {FOLLOWER_TIERS.map(t => <option key={t} value={t}>Tier {t}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label className="hub-label">Content type</label>
            <div className="flex gap-2 flex-wrap">
              {PAGE_CONTENT_TYPES.map(t => {
                const selected = form.contentTypes.includes(t)
                return (
                  <button key={t} type="button" onClick={() => toggleContentType(t)}
                    className={`text-xs px-3 py-1.5 rounded-lg border transition-colors capitalize ${
                      selected
                        ? 'bg-orange-100 border-orange-300 text-orange-700 font-medium'
                        : 'bg-card border-border text-muted-foreground hover:bg-accent'
                    }`}>
                    {t}
                  </button>
                )
              })}
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="hub-label">Followers</label>
              <input type="number" min={0} step={1} className="hub-input" value={form.followers}
                onChange={e => setForm(f => ({ ...f, followers: count(e.target.value) }))} />
            </div>
            <div>
              <label className="hub-label">Inv. posts</label>
              <input type="number" min={0} step={1} className="hub-input" value={form.inventoryPosts}
                onChange={e => setForm(f => ({ ...f, inventoryPosts: count(e.target.value) }))} />
            </div>
            <div>
              <label className="hub-label">Inv. stories</label>
              <input type="number" min={0} step={1} className="hub-input" value={form.inventoryStories}
                onChange={e => setForm(f => ({ ...f, inventoryStories: count(e.target.value) }))} />
            </div>
          </div>
          <div>
            <label className="hub-label">Notes</label>
            <textarea className="hub-input resize-none" rows={2} value={form.notes}
              onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} />
          </div>
        </div>
        {error && <div className="px-4 py-2 text-xs text-rose-700 bg-rose-50 border-t border-rose-200">{error}</div>}
        <div className="flex items-center justify-end gap-2 p-4 border-t border-border">
          <button onClick={onClose} disabled={saving} className="px-4 py-2 rounded-lg border border-border text-sm text-muted-foreground hover:bg-accent disabled:opacity-40">Cancel</button>
          <button onClick={save} disabled={!canSave}
            className="px-4 py-2 rounded-lg bg-orange-600 text-white text-sm font-medium hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed">
            {saving ? 'Saving…' : 'Save changes'}
          </button>
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
