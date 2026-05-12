import { useMemo, useState } from 'react'
import {
  Sparkles, Send, MessageSquare, Target, TrendingUp, Info, Copy, Check,
} from 'lucide-react'
import { useOutreachData } from '@/lib/outreach-data'

type Tab = 'caption' | 'matching' | 'reach'

const TABS: { id: Tab; label: string; icon: React.ElementType }[] = [
  { id: 'caption',  label: 'Caption suggestions', icon: MessageSquare },
  { id: 'matching', label: 'Post-to-page matching', icon: Target },
  { id: 'reach',    label: 'Predicted reach',     icon: TrendingUp },
]

export default function OutreachAI() {
  const [tab, setTab] = useState<Tab>('caption')

  return (
    <div className="animate-fade-in space-y-5">

      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-orange-100 flex items-center justify-center">
          <Sparkles className="w-5 h-5 text-orange-600" />
        </div>
        <div>
          <h1 className="text-2xl font-serif text-foreground">AI Suggestions</h1>
          <p className="text-sm text-muted-foreground">Captions, page matching, and reach prediction.</p>
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

      {tab === 'caption'  && <CaptionPanel />}
      {tab === 'matching' && <MatchingPanel />}
      {tab === 'reach'    && <ReachPanel />}

    </div>
  )
}

// ── Panel: Caption suggestions ─────────────────────────────────────────────

function CaptionPanel() {
  const { pages, posts, campaigns } = useOutreachData()
  const [pageId, setPageId] = useState('')
  const [campaignId, setCampaignId] = useState('')
  const [brief, setBrief] = useState('')
  const [generated, setGenerated] = useState<string[]>([])
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null)

  // Pull top-engagement past captions from this page as few-shot examples (would be
  // sent to an LLM with the brief in production).
  const examples = useMemo(() => {
    if (!pageId) return []
    return posts
      .filter(p => p.pageId === pageId)
      .map(p => ({ p, eng: p.likes + p.comments + p.saves + p.shares }))
      .sort((a, b) => b.eng - a.eng)
      .slice(0, 5)
      .map(x => x.p.caption)
  }, [pageId, posts])

  function generate() {
    const page = pages.find(p => p.id === pageId)
    const campaign = campaigns.find(c => c.id === campaignId)
    const handle = page?.handle ?? 'page'
    const cname = campaign?.name ?? 'campaign'
    // Local stub — in production this would call your LLM with `brief` + `examples`.
    setGenerated([
      `${cname} is here! Catch the action live with @${handle}. ${brief.slice(0, 120)}`,
      `Big news from ${page?.geography ?? 'town'} — ${cname}. ${brief.slice(0, 100)} Don't miss out!`,
      `Mark your calendar: ${cname}. Brought to you by @${handle}. ${brief.slice(0, 80)}`,
    ])
  }

  function copy(text: string, idx: number) {
    navigator.clipboard.writeText(text)
    setCopiedIdx(idx)
    setTimeout(() => setCopiedIdx(null), 1500)
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
      <div className="hub-card lg:col-span-1 space-y-3">
        <h2 className="text-sm font-semibold text-foreground">Brief</h2>
        <div>
          <label className="hub-label">Page *</label>
          <select value={pageId} onChange={e => setPageId(e.target.value)} className="hub-input py-1.5">
            <option value="">Select…</option>
            {pages.map(p => <option key={p.id} value={p.id}>@{p.handle} ({p.geography})</option>)}
          </select>
        </div>
        <div>
          <label className="hub-label">Campaign</label>
          <select value={campaignId} onChange={e => setCampaignId(e.target.value)} className="hub-input py-1.5">
            <option value="">Select…</option>
            {campaigns.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div>
          <label className="hub-label">Brief</label>
          <textarea rows={5} value={brief} onChange={e => setBrief(e.target.value)}
            placeholder="Tone, key messages, hashtags, CTA…"
            className="hub-input resize-none" />
        </div>
        <button onClick={generate} disabled={!pageId}
          className="w-full px-4 py-2 rounded-lg bg-orange-600 text-white text-sm font-medium hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center justify-center gap-2">
          <Sparkles className="w-4 h-4" /> Generate
        </button>
      </div>

      <div className="lg:col-span-2 space-y-3">
        {generated.length === 0 ? (
          <div className="hub-card text-center py-16">
            <MessageSquare className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
            <p className="text-sm text-foreground">Pick a page and brief, then generate.</p>
            <p className="text-xs text-muted-foreground mt-1">Suggestions use this page's top-performing past captions as style examples.</p>
          </div>
        ) : (
          <>
            <h2 className="text-sm font-semibold text-foreground">Suggestions</h2>
            {generated.map((text, i) => (
              <div key={i} className="hub-card flex items-start justify-between gap-3">
                <p className="text-sm text-foreground flex-1 whitespace-pre-wrap">{text}</p>
                <button onClick={() => copy(text, i)}
                  className="p-2 rounded-lg hover:bg-accent text-muted-foreground shrink-0"
                  title="Copy">
                  {copiedIdx === i ? <Check className="w-4 h-4 text-emerald-600" /> : <Copy className="w-4 h-4" />}
                </button>
              </div>
            ))}
          </>
        )}

        {examples.length > 0 && (
          <div className="hub-card">
            <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-2">Style examples used</h3>
            <ul className="space-y-1">
              {examples.map((c, i) => (
                <li key={i} className="text-xs text-muted-foreground line-clamp-2">· {c}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Panel: Post-to-page matching ───────────────────────────────────────────

function MatchingPanel() {
  const { pages, posts, campaigns } = useOutreachData()
  const [postType, setPostType] = useState<'static' | 'reel' | 'story' | 'carousel'>('reel')
  const [campaignId, setCampaignId] = useState('')

  // Rule-based fallback (the spec calls out: "Without 3+ months of labeled data,
  // fall back to rule-based"). Score = avg engagement of this type from this page.
  const recs = useMemo(() => {
    return pages.map(page => {
      const hist = posts.filter(p => p.pageId === page.id && p.type === postType)
      const avgEng = hist.length ? hist.reduce((s, p) => s + p.likes + p.comments + p.saves + p.shares, 0) / hist.length : 0
      let reason = ''
      if (hist.length === 0) reason = `No prior ${postType} history`
      else reason = `${hist.length} prior ${postType}s · avg eng ${fmt(Math.round(avgEng))}`
      return { page, score: avgEng, reason, samples: hist.length }
    })
    .filter(r => r.samples > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10)
  }, [pages, posts, postType])

  return (
    <div className="space-y-4">
      <div className="hub-card bg-blue-50 border-blue-200 text-xs text-blue-900 flex items-start gap-2">
        <Info className="w-4 h-4 shrink-0 mt-0.5" />
        <p>
          Heuristic ranking using past performance per (page, post type). Once you have 3+ months of labeled
          data, swap this for a learned recommender that considers time-of-day, campaign category, geography fit, etc.
        </p>
      </div>

      <div className="hub-card flex items-center gap-3 flex-wrap">
        <div>
          <label className="hub-label">Post type</label>
          <select value={postType} onChange={e => setPostType(e.target.value as 'static' | 'reel' | 'story' | 'carousel')}
            className="hub-input py-1.5 text-xs w-32">
            <option value="static">Static</option>
            <option value="reel">Reel</option>
            <option value="story">Story</option>
            <option value="carousel">Carousel</option>
          </select>
        </div>
        <div>
          <label className="hub-label">Campaign (optional)</label>
          <select value={campaignId} onChange={e => setCampaignId(e.target.value)}
            className="hub-input py-1.5 text-xs w-48">
            <option value="">Any</option>
            {campaigns.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
      </div>

      <div className="hub-card p-0 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-widest text-muted-foreground border-b border-border">
              <th className="px-3 py-2">Recommended page</th>
              <th className="px-3 py-2">Geography</th>
              <th className="px-3 py-2">Type</th>
              <th className="px-3 py-2">Why</th>
              <th className="px-3 py-2 text-right">Score</th>
            </tr>
          </thead>
          <tbody>
            {recs.length === 0 ? (
              <tr><td colSpan={5} className="px-3 py-12 text-center text-sm text-muted-foreground">No history yet for this post type.</td></tr>
            ) : recs.map(r => (
              <tr key={r.page.id} className="border-b border-border last:border-0 hover:bg-accent/40">
                <td className="px-3 py-2.5 text-xs font-medium text-foreground">@{r.page.handle}</td>
                <td className="px-3 py-2.5 text-xs text-muted-foreground">{r.page.geography}</td>
                <td className="px-3 py-2.5 text-xs uppercase">{r.page.type}</td>
                <td className="px-3 py-2.5 text-xs text-muted-foreground">{r.reason}</td>
                <td className="px-3 py-2.5 text-right text-xs font-mono tabular-nums">{fmt(Math.round(r.score))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── Panel: Predicted reach (replaces "feasibility %") ──────────────────────

function ReachPanel() {
  const { pages, posts } = useOutreachData()
  const [pageId, setPageId] = useState('')
  const [type, setType] = useState<'static' | 'reel' | 'story' | 'carousel'>('reel')

  const result = useMemo(() => {
    if (!pageId) return null
    const page = pages.find(p => p.id === pageId)
    if (!page) return null
    const hist = posts.filter(p => p.pageId === pageId && p.type === type)
    if (hist.length === 0) {
      return { kind: 'no-data' as const, page }
    }
    const eng = hist.map(p => p.likes + p.comments + p.saves + p.shares)
    const reach = hist.map(p => p.views)
    const median = (xs: number[]) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)]
    const avg = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length
    const successProb = eng.filter(e => e > median(eng)).length / eng.length
    return {
      kind: 'ok' as const,
      page,
      samples: hist.length,
      medianEng: Math.round(median(eng)),
      medianReach: Math.round(median(reach)),
      avgReach: Math.round(avg(reach)),
      successProb,                           // P(eng > page-median)
      formula: 'P(engagement > page-median for this post type)',
    }
  }, [pageId, type, pages, posts])

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
      <div className="hub-card lg:col-span-1 space-y-3">
        <h2 className="text-sm font-semibold text-foreground">Inputs</h2>
        <div>
          <label className="hub-label">Page *</label>
          <select value={pageId} onChange={e => setPageId(e.target.value)} className="hub-input py-1.5">
            <option value="">Select…</option>
            {pages.map(p => <option key={p.id} value={p.id}>@{p.handle}</option>)}
          </select>
        </div>
        <div>
          <label className="hub-label">Post type</label>
          <select value={type} onChange={e => setType(e.target.value as 'static' | 'reel' | 'story' | 'carousel')} className="hub-input py-1.5">
            <option value="static">Static</option>
            <option value="reel">Reel</option>
            <option value="story">Story</option>
            <option value="carousel">Carousel</option>
          </select>
        </div>
        <div className="hub-card bg-blue-50 border-blue-200 text-[11px] text-blue-900 flex items-start gap-2">
          <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <p>"Predicted reach" replaces the vague "feasibility %". Definition: <strong>{result?.kind === 'ok' ? result.formula : 'P(engagement > page-median for this post type)'}</strong>.</p>
        </div>
      </div>

      <div className="lg:col-span-2 space-y-4">
        {!result && (
          <div className="hub-card text-center py-16">
            <TrendingUp className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
            <p className="text-sm text-foreground">Pick a page and post type to predict reach.</p>
          </div>
        )}
        {result?.kind === 'no-data' && (
          <div className="hub-card text-center py-12 bg-amber-50 border-amber-200">
            <p className="text-sm text-amber-900">No prior <strong>{type}</strong> posts on @{result.page.handle}. Need history before predictions are meaningful.</p>
          </div>
        )}
        {result?.kind === 'ok' && (
          <>
            <div className="grid grid-cols-2 gap-3">
              <div className="hub-card">
                <p className="text-[11px] uppercase tracking-widest text-muted-foreground">Predicted reach</p>
                <p className="text-3xl font-serif text-foreground mt-1">{fmt(result.medianReach)}</p>
                <p className="text-[11px] text-muted-foreground mt-1">median across {result.samples} prior {type}s · avg {fmt(result.avgReach)}</p>
              </div>
              <div className="hub-card">
                <p className="text-[11px] uppercase tracking-widest text-muted-foreground">Success probability</p>
                <p className="text-3xl font-serif text-foreground mt-1">{Math.round(result.successProb * 100)}%</p>
                <p className="text-[11px] text-muted-foreground mt-1">P(engagement &gt; {fmt(result.medianEng)} median)</p>
              </div>
            </div>
            <div className="hub-card text-xs text-muted-foreground">
              <p className="mb-1"><strong>Sample size:</strong> {result.samples}. Confidence is low below ~10 samples — treat results as directional.</p>
              <p><strong>Page:</strong> @{result.page.handle} · {result.page.geography} · {fmt(result.page.followers)} followers · Tier {result.page.followerTier}.</p>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}
