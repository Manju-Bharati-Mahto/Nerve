import { useEffect, useMemo, useState } from 'react'
import { X, Plus, Trash2, Loader2, Link as LinkIcon, ExternalLink, AlertCircle, CheckCircle2 } from 'lucide-react'
import {
  addLivePostsByUrl, useOutreachStore,
  type Campaign, type Post,
} from '@/lib/outreach-data'

/**
 * Dialog used in two places:
 *   - Auto-opens after a campaign is created (OutreachCampaigns)
 *   - Manual button on the campaign detail header (OutreachCampaignDetail)
 *
 * User picks a page assigned to the campaign, pastes 1..N Instagram post/reel
 * URLs, hits "Fetch analytics" → server calls Apify, upserts each result as a
 * post under (campaign, page), and we render the metrics inline.
 */
export default function AddLivePostsDialog({
  campaign, onClose,
}: {
  campaign: Campaign
  onClose: () => void
}) {
  const { pages } = useOutreachStore()
  const assignedPages = useMemo(
    () => pages.filter(p => campaign.assignedPageIds.includes(p.id)),
    [pages, campaign.assignedPageIds],
  )

  const [pageId, setPageId] = useState<string>(assignedPages[0]?.id ?? '')
  // If the store hadn't hydrated when the dialog mounted, pageId starts empty
  // and the form would stay disabled even after pages arrive. Re-pick a default
  // once the assignedPages list is available, but never clobber an explicit
  // user choice (only fill when current pageId isn't in the list).
  useEffect(() => {
    if (assignedPages.length === 0) return
    if (!assignedPages.some(p => p.id === pageId)) {
      setPageId(assignedPages[0].id)
    }
  }, [assignedPages, pageId])

  const [urls, setUrls] = useState<string[]>([''])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [results, setResults] = useState<{ posts: Post[]; skipped: { url: string; reason: string }[] } | null>(null)

  function updateUrl(i: number, value: string) {
    setUrls(prev => prev.map((u, idx) => (idx === i ? value : u)))
  }
  function addUrlRow() { setUrls(prev => [...prev, '']) }
  function removeUrlRow(i: number) {
    setUrls(prev => (prev.length <= 1 ? [''] : prev.filter((_, idx) => idx !== i)))
  }

  const cleanedUrls = urls.map(u => u.trim()).filter(Boolean)
  const canSubmit = !!pageId && cleanedUrls.length > 0 && !loading

  async function submit() {
    if (!canSubmit) return
    setLoading(true)
    setError(null)
    setResults(null)
    try {
      const res = await addLivePostsByUrl(campaign.id, pageId, cleanedUrls)
      setResults({ posts: res.posts, skipped: res.skipped })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch analytics.')
    } finally {
      setLoading(false)
    }
  }

  const selectedPage = assignedPages.find(p => p.id === pageId)

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4 animate-fade-in">
      <div className="bg-card rounded-xl border border-border w-full max-w-2xl max-h-[90vh] flex flex-col">

        <div className="flex items-start justify-between p-4 border-b border-border">
          <div className="min-w-0">
            <h2 className="text-base font-serif text-foreground">Add live posts</h2>
            <p className="text-xs text-muted-foreground truncate">
              Pull real metrics into <span className="font-medium text-foreground">{campaign.name}</span> by URL.
            </p>
          </div>
          <button onClick={onClose} className="p-2 rounded-lg hover:bg-accent text-muted-foreground">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">

          {assignedPages.length === 0 ? (
            <div className="hub-card bg-amber-50 border-amber-200 text-xs text-amber-900 flex items-start gap-2">
              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
              <span>This campaign has no pages assigned. Add pages to the campaign first, then come back to attach live posts.</span>
            </div>
          ) : (
            <>
              <div>
                <label className="hub-label">Page from this campaign</label>
                <select
                  className="hub-input"
                  value={pageId}
                  onChange={e => setPageId(e.target.value)}
                >
                  {assignedPages.map(p => (
                    <option key={p.id} value={p.id}>
                      @{p.handle} · {p.geography} · {p.type}
                    </option>
                  ))}
                </select>
                {selectedPage && (
                  <p className="text-[11px] text-muted-foreground mt-1">
                    URLs you paste below must belong to @{selectedPage.handle}.
                  </p>
                )}
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="hub-label mb-0">Instagram post / reel URLs</label>
                  <button
                    type="button"
                    onClick={addUrlRow}
                    disabled={urls.length >= 20}
                    className="text-xs text-orange-600 hover:underline inline-flex items-center gap-1 disabled:opacity-40 disabled:no-underline"
                  >
                    <Plus className="w-3 h-3" /> Add another
                  </button>
                </div>
                <div className="space-y-2">
                  {urls.map((u, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <LinkIcon className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                      <input
                        className="hub-input py-1.5 text-xs flex-1"
                        placeholder="https://www.instagram.com/p/SHORTCODE/ or /reel/SHORTCODE/"
                        value={u}
                        onChange={e => updateUrl(i, e.target.value)}
                      />
                      <button
                        type="button"
                        onClick={() => removeUrlRow(i)}
                        className="p-1.5 rounded-lg text-muted-foreground hover:bg-accent disabled:opacity-40"
                        disabled={urls.length === 1 && !u}
                        aria-label="Remove URL"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
                <p className="text-[11px] text-muted-foreground mt-1">
                  Up to 20 URLs per request. Each one is scraped via Apify and saved as a published post under this campaign + page.
                </p>
              </div>
            </>
          )}

          {error && (
            <div className="hub-card bg-rose-50 border-rose-200 text-xs text-rose-900 flex items-start gap-2">
              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {results && <ResultsBlock results={results} />}
        </div>

        <div className="flex items-center justify-between p-4 border-t border-border gap-2">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg border border-border text-sm text-muted-foreground hover:bg-accent"
          >
            {results ? 'Done' : 'Cancel'}
          </button>
          <button
            onClick={submit}
            disabled={!canSubmit || assignedPages.length === 0}
            className="px-4 py-2 rounded-lg bg-orange-600 text-white text-sm font-medium hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-2"
          >
            {loading && <Loader2 className="w-4 h-4 animate-spin" />}
            {loading ? 'Fetching…' : results ? 'Fetch more' : 'Fetch analytics'}
          </button>
        </div>
      </div>
    </div>
  )
}

function ResultsBlock({ results }: { results: { posts: Post[]; skipped: { url: string; reason: string }[] } }) {
  return (
    <div className="space-y-3">
      {results.posts.length > 0 && (
        <div className="hub-card p-0 overflow-hidden">
          <div className="px-3 py-2 border-b border-border bg-emerald-50/50 flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-600" />
            <p className="text-xs font-medium text-foreground">
              {results.posts.length} post{results.posts.length === 1 ? '' : 's'} saved
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-widest text-muted-foreground border-b border-border">
                  <th className="px-3 py-2">Post</th>
                  <th className="px-3 py-2">Type</th>
                  <th className="px-3 py-2">Date</th>
                  <th className="px-3 py-2 text-right">Likes</th>
                  <th className="px-3 py-2 text-right">Comments</th>
                  <th className="px-3 py-2 text-right">Views</th>
                </tr>
              </thead>
              <tbody>
                {results.posts.map(p => (
                  <tr key={p.id} className="border-b border-border last:border-0">
                    <td className="px-3 py-2 max-w-[200px]">
                      {p.permalink ? (
                        <a href={p.permalink} target="_blank" rel="noreferrer"
                          className="text-xs text-orange-600 hover:underline inline-flex items-center gap-1 truncate">
                          {truncate(p.caption || p.permalink, 36)}
                          <ExternalLink className="w-3 h-3 shrink-0" />
                        </a>
                      ) : (
                        <span className="text-xs text-muted-foreground truncate">{truncate(p.caption || '—', 36)}</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground capitalize">{p.type}</td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">{p.date}</td>
                    <td className="px-3 py-2 text-right text-xs font-mono tabular-nums">{fmt(p.likes)}</td>
                    <td className="px-3 py-2 text-right text-xs font-mono tabular-nums">{fmt(p.comments)}</td>
                    <td className="px-3 py-2 text-right text-xs font-mono tabular-nums">{fmt(p.views)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {results.skipped.length > 0 && (
        <div className="hub-card bg-amber-50 border-amber-200 p-0 overflow-hidden">
          <div className="px-3 py-2 border-b border-amber-200 flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-amber-700" />
            <p className="text-xs font-medium text-amber-900">
              {results.skipped.length} skipped
            </p>
          </div>
          <ul className="divide-y divide-amber-200">
            {results.skipped.map((s, i) => (
              <li key={i} className="px-3 py-2 text-xs">
                <p className="font-mono text-amber-900 truncate">{s.url}</p>
                <p className="text-amber-800">{s.reason}</p>
              </li>
            ))}
          </ul>
        </div>
      )}

      {results.posts.length === 0 && results.skipped.length === 0 && (
        <p className="text-xs text-muted-foreground text-center py-2">Nothing to show.</p>
      )}
    </div>
  )
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s
  return s.slice(0, n - 1) + '…'
}
