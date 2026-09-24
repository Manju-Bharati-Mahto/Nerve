import { useEffect, useState } from 'react'
import { Share2, AlertCircle, Lock, CheckCircle2, MinusCircle } from 'lucide-react'
import { listSocialPages, type EditorVisiblePage } from '@/lib/outreach-video-data'

/**
 * §8.2 — "Editors can view the list of social media pages / accounts relevant
 * to their assigned clients or projects (platform name, page/handle, and
 * connected status) so they know where content is destined for."
 *
 * The API is what enforces the restriction (§25): an editor's response simply
 * has no analytics in it. This page shows what came back rather than hiding
 * fields locally, so the two can't drift apart.
 */
export default function VideoSocialPages() {
  const [pages, setPages] = useState<EditorVisiblePage[]>([])
  const [analyticsVisible, setAnalyticsVisible] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    listSocialPages()
      .then(r => { setPages(r.pages); setAnalyticsVisible(r.analytics_visible) })
      .catch(err => setError(err instanceof Error ? err.message : 'Could not load pages.'))
      .finally(() => setLoading(false))
  }, [])

  return (
    <div className="animate-fade-in space-y-5">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-orange-100 flex items-center justify-center">
          <Share2 className="w-5 h-5 text-orange-600" />
        </div>
        <div>
          <h1 className="text-2xl font-serif text-foreground">Social Media Pages</h1>
          <p className="text-sm text-muted-foreground">Where the content you make is destined for.</p>
        </div>
      </div>

      {!analyticsVisible && (
        <div className="hub-card bg-muted/40 flex items-start gap-2 text-xs text-muted-foreground">
          <Lock className="w-4 h-4 mt-0.5 shrink-0" />
          <span>
            Performance data for these pages — followers, reach and engagement — isn't part
            of the editor view.
          </span>
        </div>
      )}

      {error && (
        <div className="hub-card bg-rose-50 border-rose-200 flex items-start gap-2 text-sm text-rose-900">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" /> <span>{error}</span>
        </div>
      )}

      <div className="hub-card p-0 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-widest text-muted-foreground border-b border-border">
              <th className="px-3 py-2">Page / handle</th>
              <th className="px-3 py-2">Platform</th>
              <th className="px-3 py-2">Status</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={3} className="px-3 py-12 text-center text-sm text-muted-foreground">Loading…</td></tr>
            ) : pages.length === 0 ? (
              <tr><td colSpan={3} className="px-3 py-12 text-center text-sm text-muted-foreground">
                No pages have been added yet.
              </td></tr>
            ) : pages.map(p => (
              <tr key={`${p.platform}-${p.id}`} className="border-b border-border last:border-0 hover:bg-accent/40">
                <td className="px-3 py-2.5 text-xs font-medium text-foreground">@{p.handle}</td>
                <td className="px-3 py-2.5 text-xs text-muted-foreground capitalize">{p.platform}</td>
                <td className="px-3 py-2.5">
                  {p.connected ? (
                    <span className="hub-badge bg-emerald-100 text-emerald-700 inline-flex items-center gap-1">
                      <CheckCircle2 className="w-3 h-3" /> Connected
                    </span>
                  ) : (
                    <span className="hub-badge bg-muted text-muted-foreground inline-flex items-center gap-1">
                      <MinusCircle className="w-3 h-3" /> Not synced
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
