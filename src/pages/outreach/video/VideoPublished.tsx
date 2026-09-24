import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { CheckCircle2, ExternalLink, AlertCircle } from 'lucide-react'
import {
  listVideos, formatWhen, type VideoRecord,
} from '@/lib/outreach-video-data'

/**
 * §27 — "Published" appears in every role's navigation. The API decides the
 * scope: an editor sees their own published work, everyone else sees the
 * department's, so one screen serves all four roles honestly.
 */
export default function VideoPublished() {
  const [videos, setVideos] = useState<VideoRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    listVideos({ status: 'published' })
      .then(r => setVideos(r.videos))
      .catch(err => setError(err instanceof Error ? err.message : 'Could not load published videos.'))
      .finally(() => setLoading(false))
  }, [])

  return (
    <div className="animate-fade-in space-y-5">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-emerald-100 flex items-center justify-center">
          <CheckCircle2 className="w-5 h-5 text-emerald-600" />
        </div>
        <div>
          <h1 className="text-2xl font-serif text-foreground">Published</h1>
          <p className="text-sm text-muted-foreground">Videos that have gone live, with their links.</p>
        </div>
      </div>

      {error && (
        <div className="hub-card bg-rose-50 border-rose-200 flex items-start gap-2 text-sm text-rose-900">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" /> <span>{error}</span>
        </div>
      )}

      <div className="hub-card p-0 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-widest text-muted-foreground border-b border-border">
              <th className="px-3 py-2">Video</th>
              <th className="px-3 py-2">Client / Project</th>
              <th className="px-3 py-2">Published</th>
              <th className="px-3 py-2">Live links</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={4} className="px-3 py-12 text-center text-sm text-muted-foreground">Loading…</td></tr>
            ) : videos.length === 0 ? (
              <tr><td colSpan={4} className="px-3 py-12 text-center text-sm text-muted-foreground">
                Nothing published yet.
              </td></tr>
            ) : videos.map(v => (
              <tr key={v.id} className="border-b border-border last:border-0 hover:bg-accent/40">
                <td className="px-3 py-2.5">
                  <Link to={`/outreach/video/videos/${v.id}`}
                    className="text-xs font-medium text-foreground hover:underline">{v.title}</Link>
                </td>
                <td className="px-3 py-2.5 text-xs text-muted-foreground">{v.client}</td>
                <td className="px-3 py-2.5 text-xs text-muted-foreground">{formatWhen(v.publishedAt)}</td>
                <td className="px-3 py-2.5">
                  <div className="flex items-center gap-2 flex-wrap">
                    {Object.entries(v.liveUrls ?? {}).map(([platform, url]) => (
                      <a key={platform} href={url} target="_blank" rel="noreferrer"
                        className="text-[11px] px-2 py-0.5 rounded-md bg-orange-50 text-orange-700 hover:bg-orange-100 inline-flex items-center gap-1 capitalize">
                        {platform} <ExternalLink className="w-3 h-3" />
                      </a>
                    ))}
                    {!Object.keys(v.liveUrls ?? {}).length && (
                      <span className="text-[11px] text-muted-foreground">No link recorded</span>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
