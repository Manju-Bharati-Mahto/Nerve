import { useCallback, useEffect, useState } from 'react'
import { Share2, Lock, CheckCircle2, MinusCircle, Pencil, X } from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'
import { useVideoTabEdit } from './workflow-roles'
import {
  listSocialPages, updateSocialPage, loadFailureOf, type EditorVisiblePage, type LoadFailure,
} from '@/lib/outreach-video-data'
import DriveProblemNotice from './DriveProblemNotice'

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
  const { role } = useAuth()
  // Edit on Social Pages for a configured person; otherwise the roles the API always took.
  const canEdit = useVideoTabEdit('social_pages', role === 'super_admin' || role === 'admin' || role === 'outreach_manager')

  const [pages, setPages] = useState<EditorVisiblePage[]>([])
  const [analyticsVisible, setAnalyticsVisible] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<LoadFailure | null>(null)
  const [editing, setEditing] = useState<EditorVisiblePage | null>(null)

  const refresh = useCallback(async () => {
    try {
      const r = await listSocialPages()
      setPages(r.pages)
      setAnalyticsVisible(r.analytics_visible)
      setError(null)
    } catch (err) {
      setError(loadFailureOf(err, 'Could not load pages.'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  /* §8/§25 — the editor's projection is an allowlist and carries none of the
     columns below. Keying off the response rather than the role means the
     table shows exactly what the API was willing to send. */
  const detailed = pages.some(p => p.status !== undefined || p.contact_person !== undefined)
  const cols = 3 + (detailed ? 3 : 0) + (canEdit ? 1 : 0)

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

      {/* Only once the API has answered: before that, or after a failure,
          nobody knows which view this is. */}
      {!loading && !error && !analyticsVisible && (
        <div className="hub-card bg-muted/40 flex items-start gap-2 text-xs text-muted-foreground">
          <Lock className="w-4 h-4 mt-0.5 shrink-0" />
          <span>
            Performance data for these pages — followers, reach and engagement — isn't part
            of the editor view.
          </span>
        </div>
      )}

      {error && <DriveProblemNotice message={error.message} code={error.code} />}

      {/* "No pages have been added yet" is a claim about a list nobody read. */}
      {!error && (
        <div className="hub-card p-0 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-widest text-muted-foreground border-b border-border">
                <th className="px-3 py-2">Page / handle</th>
                <th className="px-3 py-2">Platform</th>
                <th className="px-3 py-2">Sync</th>
                {/* §8 — only populated for people who may see more than the
                    editor's allowlisted projection. */}
                {detailed && <th className="px-3 py-2">Contact</th>}
                {detailed && <th className="px-3 py-2">Campaigns</th>}
                {detailed && <th className="px-3 py-2">Status</th>}
                {canEdit && <th className="px-3 py-2 text-right">Edit</th>}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={cols} className="px-3 py-12 text-center text-sm text-muted-foreground">Loading…</td></tr>
              ) : pages.length === 0 ? (
                <tr><td colSpan={cols} className="px-3 py-12 text-center text-sm text-muted-foreground">
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
                  {detailed && (
                    <td className="px-3 py-2.5 text-xs text-muted-foreground">
                      {p.contact_person || '—'}
                    </td>
                  )}
                  {detailed && (
                    <td className="px-3 py-2.5 text-xs text-muted-foreground">
                      {p.assigned_campaigns?.length ? p.assigned_campaigns.join(', ') : '—'}
                    </td>
                  )}
                  {detailed && (
                    <td className="px-3 py-2.5">
                      <span className={`hub-badge ${p.status === 'inactive'
                        ? 'bg-muted text-muted-foreground' : 'bg-emerald-100 text-emerald-700'}`}>
                        {p.status === 'inactive' ? 'Inactive' : 'Active'}
                      </span>
                    </td>
                  )}
                  {canEdit && (
                    <td className="px-3 py-2.5 text-right">
                      <button onClick={() => setEditing(p)}
                        className="text-xs px-2 py-1 rounded-lg border border-border text-muted-foreground hover:bg-accent inline-flex items-center gap-1">
                        <Pencil className="w-3 h-3" /> Edit
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <PageDetailsDialog page={editing}
          onClose={() => setEditing(null)}
          onDone={async () => { setEditing(null); await refresh() }} />
      )}
    </div>
  )
}

/** §8 — the three fields a person maintains; everything else comes from the sync. */
function PageDetailsDialog({ page, onClose, onDone }: {
  page: EditorVisiblePage; onClose: () => void; onDone: () => Promise<void>
}) {
  const [link, setLink] = useState(page.page_link ?? '')
  const [contact, setContact] = useState(page.contact_person ?? '')
  const [status, setStatus] = useState<'active' | 'inactive'>(
    page.status === 'inactive' ? 'inactive' : 'active')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save() {
    setBusy(true)
    setError(null)
    try {
      await updateSocialPage(page.id, {
        page_link: link.trim(), contact_person: contact.trim(), status,
      })
      await onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save those details.')
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4 animate-fade-in">
      <div className="bg-card rounded-xl border border-border w-full max-w-md max-h-full flex flex-col">
        <div className="flex items-start justify-between p-4 border-b border-border shrink-0">
          <h2 className="text-base font-serif text-foreground">@{page.handle}</h2>
          <button onClick={onClose} disabled={busy}
            className="p-2 rounded-lg hover:bg-accent text-muted-foreground disabled:opacity-40">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-4 space-y-3 overflow-y-auto">
          <div>
            <label className="hub-label">Page link</label>
            <input className="hub-input" value={link} onChange={e => setLink(e.target.value)}
              placeholder="https://instagram.com/…" />
          </div>
          <div>
            <label className="hub-label">Contact person</label>
            <input className="hub-input" value={contact} onChange={e => setContact(e.target.value)}
              placeholder="Who looks after this page" />
          </div>
          <div>
            <label className="hub-label">Status</label>
            <select className="hub-input" value={status}
              onChange={e => setStatus(e.target.value as 'active' | 'inactive')}>
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </select>
            <p className="text-[11px] text-muted-foreground mt-1">
              Whether we still post here. Separate from whether the sync can reach it.
            </p>
          </div>
          {error && <p className="text-xs text-rose-600">{error}</p>}
        </div>
        <div className="flex items-center justify-end gap-2 p-4 border-t border-border shrink-0">
          <button onClick={onClose} disabled={busy}
            className="px-4 py-2 rounded-lg border border-border text-sm text-muted-foreground hover:bg-accent disabled:opacity-40">
            Cancel
          </button>
          <button onClick={save} disabled={busy}
            className="px-4 py-2 rounded-lg bg-orange-600 text-white text-sm font-medium hover:opacity-90 disabled:opacity-40">
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}
