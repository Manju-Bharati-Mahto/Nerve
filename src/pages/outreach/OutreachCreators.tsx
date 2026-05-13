import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  Users, Search, ArrowUpDown, ArrowUp, ArrowDown, ChevronRight, Filter as FilterIcon,
  ExternalLink, Trash2, Plus,
} from 'lucide-react'
import {
  useOutreachData, removeCreator, addCreator,
  instagramUrlForHandle, isValidInstagramHandle, parseInstagramHandle,
  PAGE_TYPES, FOLLOWER_TIERS, PAGE_CONTENT_TYPES,
  type PageType, type FollowerTier, type PageContentType, type OutreachCreator,
} from '@/lib/outreach-data'

type SortKey = 'handle' | 'geography' | 'state' | 'tier' | 'followers' | 'inventory'
type SortDir = 'asc' | 'desc'

const TABS: { id: PageType; label: string }[] = [
  { id: 'state', label: 'State' },
  { id: 'pu',    label: 'PU' },
]

export default function OutreachCreators() {
  const { creators } = useOutreachData()
  const navigate = useNavigate()

  const [tab, setTab] = useState<PageType>('state')
  const [search, setSearch] = useState('')
  const [geography, setGeography] = useState<string>('')
  const [state, setState] = useState<string>('')
  const [tier, setTier] = useState<FollowerTier | ''>('')
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: 'handle', dir: 'asc' })
  const [adding, setAdding] = useState(false)

  const geographies = useMemo(() => Array.from(new Set(creators.map(c => c.geography))).sort(), [creators])
  const states = useMemo(() => Array.from(new Set(creators.map(c => c.state))).sort(), [creators])

  const counts = useMemo(() => ({
    state: creators.filter(c => c.type === 'state').length,
    pu:    creators.filter(c => c.type === 'pu').length,
  }), [creators])

  const rows = useMemo(() => {
    const base = creators.filter(c => c.type === tab)
    const q = search.trim().toLowerCase()
    const filtered = base.filter(c => {
      if (q && !c.handle.toLowerCase().includes(q)) return false
      if (geography && c.geography !== geography) return false
      if (state && c.state !== state) return false
      if (tier && c.followerTier !== tier) return false
      return true
    })
    const dir = sort.dir === 'asc' ? 1 : -1
    filtered.sort((a, b) => {
      const k = sort.key
      const av: number | string =
        k === 'handle'    ? a.handle :
        k === 'geography' ? a.geography :
        k === 'state'     ? a.state :
        k === 'tier'      ? a.followerTier :
        k === 'followers' ? a.followers :
        a.inventoryPosts + a.inventoryStories
      const bv: number | string =
        k === 'handle'    ? b.handle :
        k === 'geography' ? b.geography :
        k === 'state'     ? b.state :
        k === 'tier'      ? b.followerTier :
        k === 'followers' ? b.followers :
        b.inventoryPosts + b.inventoryStories
      if (typeof av === 'string' && typeof bv === 'string') return av.localeCompare(bv) * dir
      return ((av as number) - (bv as number)) * dir
    })
    return filtered
  }, [creators, tab, search, geography, state, tier, sort])

  async function confirmDelete(c: OutreachCreator) {
    if (!window.confirm(`Delete @${c.handle}? This cannot be undone.`)) return
    try { await removeCreator(c.id) }
    catch (err) { alert(err instanceof Error ? err.message : 'Failed to delete creator.') }
  }

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
            <h1 className="text-2xl font-serif text-foreground">Creators</h1>
            <p className="text-sm text-muted-foreground">Directory of individual creators, split as State-level and PU-owned. Kept separate from the Pages ledger.</p>
          </div>
        </div>
        <button onClick={() => setAdding(true)}
          className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium bg-orange-600 text-white hover:opacity-90">
          <Plus className="w-4 h-4" /> Add creator
        </button>
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
            <option value="1">Tier 1</option>
            <option value="2">Tier 2</option>
            <option value="3">Tier 3</option>
            <option value="4">Tier 4</option>
            <option value="5">Tier 5</option>
          </select>
          <span className="text-xs text-muted-foreground ml-auto">{rows.length} creators</span>
        </div>
      </div>

      {/* Table */}
      <div className="hub-card p-0 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-widest text-muted-foreground border-b border-border">
              <Th label="Handle"    sk="handle"    sort={sort} onClick={toggleSort} />
              <Th label="Geography" sk="geography" sort={sort} onClick={toggleSort} />
              <Th label="State"     sk="state"     sort={sort} onClick={toggleSort} />
              <Th label="Tier"      sk="tier"      sort={sort} onClick={toggleSort} />
              <Th label="Followers" sk="followers" sort={sort} onClick={toggleSort} className="text-right" />
              <Th label="Inventory" sk="inventory" sort={sort} onClick={toggleSort} className="text-right" />
              <th className="px-3 py-2 w-8"></th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={7} className="px-3 py-12 text-center text-sm text-muted-foreground">No creators match these filters.</td></tr>
            ) : rows.map(c => (
              <tr key={c.id} className="border-b border-border last:border-0 transition-colors hover:bg-accent/40">
                <td className="px-3 py-2.5">
                  <div className="flex items-center gap-2">
                    <Link to={`/outreach/creators/${c.id}`} className="flex items-center gap-2 group min-w-0 flex-1">
                      <div className="w-7 h-7 rounded-full bg-orange-100 flex items-center justify-center shrink-0">
                        <span className="text-[10px] font-semibold text-orange-700">{c.handle[0]?.toUpperCase()}</span>
                      </div>
                      <div className="min-w-0">
                        <p className="text-xs font-medium text-foreground truncate group-hover:underline">@{c.handle}</p>
                        {c.notes && <p className="text-[10px] text-muted-foreground truncate">{c.notes}</p>}
                      </div>
                    </Link>
                    {isValidInstagramHandle(c.handle) && (
                      <a href={instagramUrlForHandle(c.handle)} target="_blank" rel="noreferrer"
                        title={`Open @${c.handle} on Instagram`}
                        className="p-1 rounded-md text-muted-foreground hover:bg-accent hover:text-orange-600 shrink-0">
                        <ExternalLink className="w-3.5 h-3.5" />
                      </a>
                    )}
                  </div>
                </td>
                <td className="px-3 py-2.5 text-xs text-foreground">{c.geography}</td>
                <td className="px-3 py-2.5 text-xs text-muted-foreground">{c.state}</td>
                <td className="px-3 py-2.5 text-xs text-foreground">Tier {c.followerTier}</td>
                <td className="px-3 py-2.5 text-right text-xs font-mono tabular-nums text-foreground">{fmt(c.followers)}</td>
                <td className="px-3 py-2.5 text-right text-xs font-mono tabular-nums text-foreground">{c.inventoryPosts}/{c.inventoryStories}</td>
                <td className="px-3 py-2.5">
                  <div className="flex items-center gap-1">
                    <button onClick={() => confirmDelete(c)}
                      title="Delete creator"
                      className="p-1 rounded-md text-muted-foreground hover:bg-rose-50 hover:text-rose-600">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                    <Link to={`/outreach/creators/${c.id}`} title="Open creator dashboard"
                      className="p-1 rounded-md text-muted-foreground hover:bg-accent">
                      <ChevronRight className="w-4 h-4" />
                    </Link>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {adding && (
        <AddCreatorModal
          defaultType={tab}
          onClose={() => setAdding(false)}
          onCreated={c => {
            setAdding(false)
            navigate(`/outreach/creators/${c.id}`)
          }}
        />
      )}
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

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function AddCreatorModal({ defaultType, onClose, onCreated }: {
  defaultType: PageType
  onClose: () => void
  /** Fires with the freshly-created creator so the parent can redirect to
   *  the analytical dashboard for that creator. */
  onCreated: (creator: OutreachCreator) => void
}) {
  const [form, setForm] = useState<{
    handle: string; geography: string; state: string; type: PageType;
    followerTier: FollowerTier; contentTypes: PageContentType[];
    followers: number; inventoryPosts: number; inventoryStories: number; notes: string;
  }>({
    handle: '', geography: '', state: '', type: defaultType,
    followerTier: '1', contentTypes: [],
    followers: 0, inventoryPosts: 0, inventoryStories: 0, notes: '',
  })

  function toggleContentType(t: PageContentType) {
    setForm(f => ({
      ...f,
      contentTypes: f.contentTypes.includes(t)
        ? f.contentTypes.filter(x => x !== t)
        : [...f.contentTypes, t],
    }))
  }

  const normalisedHandle = parseInstagramHandle(form.handle)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const canSubmit = !!normalisedHandle && form.geography.trim() && form.state.trim() && !submitting

  async function submit() {
    if (submitting) return
    setSubmitting(true)
    setSubmitError(null)
    try {
      const created = await addCreator({
        ...form,
        handle: normalisedHandle,
        geography: form.geography.trim(),
        state: form.state.trim(),
      })
      onCreated(created)
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Failed to add creator.')
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4 animate-fade-in" onClick={onClose}>
      <div className="bg-card rounded-xl border border-border w-full max-w-lg" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between p-4 border-b border-border">
          <h2 className="text-base font-serif text-foreground">Add creator</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground text-xl leading-none">×</button>
        </div>
        <div className="p-4 space-y-3">
          <div>
            <label className="hub-label">Instagram handle or URL *</label>
            <input className="hub-input" value={form.handle}
              onChange={e => setForm(f => ({ ...f, handle: e.target.value }))}
              placeholder="creator_handle  —or—  https://www.instagram.com/creator_handle/" />
            {normalisedHandle && (
              <p className="text-[11px] text-muted-foreground mt-1">
                Will save as <span className="font-mono text-foreground">@{normalisedHandle}</span> ·{' '}
                <a href={instagramUrlForHandle(normalisedHandle)} target="_blank" rel="noreferrer"
                  className="text-orange-600 hover:underline">
                  preview on Instagram
                </a>
              </p>
            )}
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
          <div>
            <label className="hub-label">Notes</label>
            <textarea className="hub-input resize-none" rows={2} value={form.notes}
              onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
              placeholder="Optional — niche, contact, anything useful" />
          </div>
        </div>
        {submitError && (
          <div className="px-4 py-2 text-xs text-rose-700 bg-rose-50 border-t border-rose-200">{submitError}</div>
        )}
        <div className="flex items-center justify-end gap-2 p-4 border-t border-border">
          <button onClick={onClose} disabled={submitting} className="px-4 py-2 rounded-lg border border-border text-sm text-muted-foreground hover:bg-accent disabled:opacity-40">Cancel</button>
          <button onClick={submit} disabled={!canSubmit}
            className="px-4 py-2 rounded-lg bg-orange-600 text-white text-sm font-medium hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed">
            {submitting ? 'Adding…' : 'Add creator'}
          </button>
        </div>
      </div>
    </div>
  )
}
