import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { CheckCircle2, ExternalLink, Link2 } from 'lucide-react'
import {
  listVideos, formatWhen, loadFailureOf, type VideoRecord, type LoadFailure,
} from '@/lib/outreach-video-data'
import { useAuth } from '@/hooks/useAuth'
import DriveProblemNotice from './DriveProblemNotice'
import LiveLinksDialog from './LiveLinksDialog'
import { mayPublishVideos } from './workflow-roles'

/**
 * §27 — "Published" appears in every role's navigation. The API decides the
 * scope: an editor sees their own published work, everyone else sees the
 * department's, so one screen serves all four roles honestly.
 *
 * Publishers and Admins can add or correct a video's live links here (§15.1
 * makes both optional at publish time, so "later" has to exist somewhere).
 */
export default function VideoPublished() {
  const { role } = useAuth()
  const canEditLinks = mayPublishVideos(role)
  const [videos, setVideos] = useState<VideoRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<LoadFailure | null>(null)
  const [editingLinks, setEditingLinks] = useState<VideoRecord | null>(null)

  const refresh = useCallback(async () => {
    try {
      const r = await listVideos({ status: 'published' })
      setVideos(r.videos)
      setError(null)
    } catch (err) {
      setError(loadFailureOf(err, 'Could not load published videos.'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

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

      {error && <DriveProblemNotice message={error.message} code={error.code} />}

      {/* "Nothing published yet" is a claim about a list nobody read. */}
      {!error && (
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
                      {canEditLinks && (
                        <button onClick={() => setEditingLinks(v)}
                          className="text-[11px] px-2 py-0.5 rounded-md border border-border text-muted-foreground hover:bg-accent inline-flex items-center gap-1">
                          <Link2 className="w-3 h-3" />
                          {Object.keys(v.liveUrls ?? {}).length ? 'Edit links' : 'Add links'}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editingLinks && (
        <LiveLinksDialog video={editingLinks}
          onClose={() => setEditingLinks(null)}
          onDone={async () => { setEditingLinks(null); await refresh() }} />
      )}
    </div>
  )
}
