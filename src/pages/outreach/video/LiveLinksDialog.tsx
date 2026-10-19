import { useState } from 'react'
import { AlertCircle, Loader2, X } from 'lucide-react'
import { setLiveUrls, type LiveUrlPlatform, type VideoRecord } from '@/lib/outreach-video-data'

/**
 * §15.1 — adding or correcting where a published video went live.
 *
 * Both links are optional when a video is marked published, and the publish
 * dialog says they "can be added later" — but nothing offered a way to, so a
 * video published without a link said "No link recorded" for good. This is
 * that way: the API's PATCH /videos/:id/live-urls, which the UI never called.
 *
 * Every platform is sent, emptied ones included, because an empty value is
 * how the API removes a link — a mistyped URL must be correctable to nothing.
 */
export default function LiveLinksDialog({ video, onClose, onDone }: {
  video: VideoRecord
  onClose: () => void
  onDone: () => Promise<void>
}) {
  const [instagram, setInstagram] = useState(video.liveUrls?.instagram ?? '')
  const [facebook, setFacebook] = useState(video.liveUrls?.facebook ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save() {
    setBusy(true)
    setError(null)
    try {
      const liveUrls: Record<LiveUrlPlatform, string> = {
        instagram: instagram.trim(), facebook: facebook.trim(),
      }
      await setLiveUrls(video.id, liveUrls)
      await onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the links.')
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4 animate-fade-in">
      <div className="bg-card rounded-xl border border-border w-full max-w-md max-h-full flex flex-col">
        <div className="flex items-start justify-between p-4 border-b border-border shrink-0">
          <div className="min-w-0">
            <h2 className="text-base font-serif text-foreground">Live links</h2>
            <p className="text-xs text-muted-foreground truncate max-w-xs">{video.title}</p>
          </div>
          <button onClick={onClose} disabled={busy} aria-label="Close"
            className="p-2 rounded-lg hover:bg-accent text-muted-foreground disabled:opacity-40">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 space-y-3 overflow-y-auto">
          <div>
            <label className="hub-label" htmlFor="live-instagram">Instagram link</label>
            <input id="live-instagram" className="hub-input" value={instagram}
              onChange={e => setInstagram(e.target.value)} placeholder="https://www.instagram.com/p/…" />
          </div>
          <div>
            <label className="hub-label" htmlFor="live-facebook">Facebook link</label>
            <input id="live-facebook" className="hub-input" value={facebook}
              onChange={e => setFacebook(e.target.value)} placeholder="https://www.facebook.com/…" />
          </div>
          <p className="text-[11px] text-muted-foreground">Clear a box to remove that link.</p>
          {error && (
            <div className="hub-card bg-rose-50 border-rose-200 flex items-start gap-2 text-xs text-rose-900">
              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" /> <span>{error}</span>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 p-4 border-t border-border shrink-0">
          <button onClick={onClose} disabled={busy}
            className="px-4 py-2 rounded-lg border border-border text-sm text-muted-foreground hover:bg-accent disabled:opacity-40">
            Cancel
          </button>
          <button onClick={save} disabled={busy}
            className="px-4 py-2 rounded-lg bg-orange-600 text-white text-sm font-medium hover:opacity-90 disabled:opacity-40 inline-flex items-center gap-2">
            {busy && <Loader2 className="w-4 h-4 animate-spin" />}
            {busy ? 'Saving…' : 'Save links'}
          </button>
        </div>
      </div>
    </div>
  )
}
