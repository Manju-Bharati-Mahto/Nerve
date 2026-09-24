import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Bell, AlertCircle, CheckCheck } from 'lucide-react'
import {
  listNotifications, markNotificationsRead, formatWhen,
  type WorkflowNotification,
} from '@/lib/outreach-video-data'

/**
 * §19 — the four in-app notifications, newest first. Opening the page doesn't
 * silently mark everything read: the editor may well be scanning it and come
 * back, so "Mark all read" stays an explicit action, while clicking through to
 * a subject clears just that one.
 */
export default function VideoNotifications() {
  const [items, setItems] = useState<WorkflowNotification[]>([])
  const [unread, setUnread] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const r = await listNotifications()
      setItems(r.notifications)
      setUnread(r.unread)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load notifications.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  async function markAll() {
    setBusy(true)
    try { await markNotificationsRead(); await refresh() }
    catch { /* a failed read-marker isn't worth an alert */ }
    finally { setBusy(false) }
  }

  async function markOne(id: string) {
    try { await markNotificationsRead([id]); await refresh() } catch { /* ignore */ }
  }

  return (
    <div className="animate-fade-in space-y-5">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-orange-100 flex items-center justify-center">
            <Bell className="w-5 h-5 text-orange-600" />
          </div>
          <div>
            <h1 className="text-2xl font-serif text-foreground">Notifications</h1>
            <p className="text-sm text-muted-foreground">
              {unread > 0 ? `${unread} unread` : 'Nothing unread.'}
            </p>
          </div>
        </div>
        {unread > 0 && (
          <button onClick={markAll} disabled={busy}
            className="text-xs px-3 py-1.5 rounded-lg border border-border text-muted-foreground hover:bg-accent disabled:opacity-40 inline-flex items-center gap-1">
            <CheckCheck className="w-3.5 h-3.5" /> {busy ? 'Saving…' : 'Mark all read'}
          </button>
        )}
      </div>

      {error && (
        <div className="hub-card bg-rose-50 border-rose-200 flex items-start gap-2 text-sm text-rose-900">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" /> <span>{error}</span>
        </div>
      )}

      {loading ? (
        <div className="hub-card text-center py-12 text-sm text-muted-foreground">Loading…</div>
      ) : items.length === 0 ? (
        <div className="hub-card text-center py-12">
          <p className="text-sm text-muted-foreground">No notifications yet.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {items.map(n => {
            const body = (
              <>
                <span className={`mt-1.5 w-1.5 h-1.5 rounded-full shrink-0 ${n.readAt ? 'bg-transparent' : 'bg-orange-500'}`} />
                <div className="min-w-0">
                  <p className={`text-sm ${n.readAt ? 'text-muted-foreground' : 'text-foreground font-medium'}`}>
                    {n.message}
                  </p>
                  <p className="text-[11px] text-muted-foreground">{formatWhen(n.createdAt)}</p>
                </div>
              </>
            )
            const cls = `hub-card flex items-start gap-2.5 ${n.readAt ? '' : 'border-orange-200 bg-orange-50/40'}`
            return n.subject ? (
              <Link key={n.id} to={subjectPath(n.subject)} onClick={() => { void markOne(n.id) }}
                className={`${cls} hover:border-orange-300 transition-colors`}>
                {body}
              </Link>
            ) : (
              <div key={n.id} className={cls}>{body}</div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function subjectPath(subject: { type: 'video' | 'event'; id: string }): string {
  return subject.type === 'video'
    ? `/outreach/video/videos/${subject.id}`
    : `/outreach/video/events/${subject.id}`
}
