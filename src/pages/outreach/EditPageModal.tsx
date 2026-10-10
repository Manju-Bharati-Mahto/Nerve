/**
 * Edit page (PRD 6.5): rename a page, set its link, move it to the right state
 * and geography, raise or lower its inventory, and set its content preference
 * — without deleting it and adding it again, which threw away its posts,
 * campaign assignments and analytics.
 *
 * Renaming keeps the page's id, so everything attached to it stays attached.
 * The name and link are checked here by the server's own rule
 * (outreach-page-edit.ts is the same file on both sides), and the server
 * checks them again; a name another page already has comes back as a 409 and
 * is shown inline. Only the fields that changed are sent.
 */
import { useMemo, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import {
  useOutreachData, updatePage, pageMetrics, profileUrlForPage,
  PAGE_CONTENT_PREFERENCES, type OutreachPage, type PageEdit,
} from '@/lib/outreach-data'
import { canonicalState, canonicalGeography } from '@/lib/outreach-states'
import { handleKey, normalisePageHandle, normalisePageLink } from '@/lib/outreach-page-edit'
import StateSelect from './StateSelect'

const count = (raw: string) => Math.max(0, Math.floor(Number(raw) || 0))

export default function EditPageModal({ page, onClose }: { page: OutreachPage; onClose: () => void }) {
  const { posts } = useOutreachData()
  const used = useMemo(() => pageMetrics(page, posts), [page, posts])
  const platformName = page.platform === 'facebook' ? 'Facebook' : 'Instagram'

  const [handle, setHandle] = useState(page.handle)
  const [pageLink, setPageLink] = useState(page.pageLink)
  const [state, setState] = useState(page.state)
  const [geography, setGeography] = useState(page.geography)
  const [contentPreferences, setContentPreferences] = useState<string[]>(page.contentPreferences)
  const [inventoryPosts, setInventoryPosts] = useState(page.inventoryPosts)
  const [inventoryStories, setInventoryStories] = useState(page.inventoryStories)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // A value handed back as it was is not re-checked (the server does the
  // same), so a legacy name or link never blocks an inventory edit.
  const handleChanged = handle.trim() !== page.handle
  const handleCheck = handleChanged ? normalisePageHandle(page.platform, handle) : null
  const newHandle = handleCheck?.ok && handleCheck.handle !== page.handle ? handleCheck.handle : null

  const linkChanged = pageLink.trim() !== page.pageLink
  const linkCheck = linkChanged ? normalisePageLink(page.platform, pageLink) : null
  const nameForLink = newHandle ?? page.handle
  // A link to a different account than the page name is almost always a slip.
  const linkHandle = pageLink.trim() ? normalisePageHandle(page.platform, pageLink) : null
  const linkPointsElsewhere = !!linkHandle?.ok && (linkCheck?.ok ?? true) && handleKey(linkHandle.handle) !== handleKey(nameForLink)

  const stateChanged = state !== page.state
  const canonical = canonicalState(state)
  const geographyTidy = canonicalGeography(geography)

  const patch: PageEdit = {}
  if (newHandle) patch.handle = newHandle
  if (linkChanged && linkCheck?.ok) patch.pageLink = linkCheck.link
  if (stateChanged && canonical) patch.state = canonical
  if (geographyTidy !== page.geography) patch.geography = geographyTidy
  if (JSON.stringify(contentPreferences) !== JSON.stringify(page.contentPreferences)) patch.contentPreferences = contentPreferences
  if (inventoryPosts !== page.inventoryPosts) patch.inventoryPosts = inventoryPosts
  if (inventoryStories !== page.inventoryStories) patch.inventoryStories = inventoryStories

  const problems = [
    handleCheck && !handleCheck.ok ? handleCheck.problem : null,
    linkCheck && !linkCheck.ok ? linkCheck.problem : null,
    stateChanged && !canonical ? 'Choose a state from the list.' : null,
    geographyTidy !== page.geography && !geographyTidy ? 'Geography can’t be blank.' : null,
  ].filter((p): p is string => !!p)
  const canSave = !saving && problems.length === 0 && Object.keys(patch).length > 0
  const overUsed = inventoryPosts < used.postsDone

  function togglePref(p: string) {
    setContentPreferences(prev => prev.includes(p) ? prev.filter(x => x !== p) : [...prev, p])
  }

  async function save() {
    if (!canSave) return
    setSaving(true); setError(null)
    try {
      await updatePage(page.id, patch)
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save page.')
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4 animate-fade-in" onClick={() => { if (!saving) onClose() }}>
      <div role="dialog" aria-label={`Edit @${page.handle}`}
        className="bg-card rounded-xl border border-border w-full max-w-lg max-h-[92vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between p-4 border-b border-border">
          <div>
            <h2 className="text-base font-serif text-foreground">Edit @{page.handle}</h2>
            <p className="text-[11px] text-muted-foreground">{platformName} page · the platform can’t be changed</p>
          </div>
          <button onClick={onClose} disabled={saving} aria-label="Close"
            className="text-muted-foreground hover:text-foreground text-xl leading-none disabled:opacity-40">×</button>
        </div>
        <div className="p-4 space-y-3 overflow-y-auto">
          <div>
            <label className="hub-label" htmlFor="edit-page-handle">Page name *</label>
            <input id="edit-page-handle" className="hub-input" value={handle} onChange={e => setHandle(e.target.value)}
              placeholder={page.platform === 'facebook' ? 'mycitypage  —or—  https://www.facebook.com/mycitypage' : 'mycitypage  —or—  https://www.instagram.com/mycitypage/'} />
            {handleCheck && !handleCheck.ok && <p className="text-[11px] text-rose-700 mt-1">{handleCheck.problem}</p>}
            {newHandle && (
              <p className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-2 py-1.5 mt-1">
                Will save as <span className="font-mono">@{newHandle}</span>. Renaming keeps this page’s posts, campaigns and
                analytics. Make sure the account was renamed on {platformName} — the next sync looks for <span className="font-mono">@{newHandle}</span>.
              </p>
            )}
          </div>

          <div>
            <label className="hub-label" htmlFor="edit-page-link">Page link</label>
            <input id="edit-page-link" className="hub-input" value={pageLink} onChange={e => setPageLink(e.target.value)}
              placeholder={profileUrlForPage({ handle: nameForLink, platform: page.platform })} />
            <div className="flex items-center justify-between gap-2 mt-1">
              {linkCheck && !linkCheck.ok
                ? <p className="text-[11px] text-rose-700">{linkCheck.problem}</p>
                : linkPointsElsewhere
                  ? <p className="text-[11px] text-amber-700">This link is for @{linkHandle?.ok ? linkHandle.handle : ''}, not @{nameForLink}.</p>
                  : <p className="text-[11px] text-muted-foreground">Optional. Blank uses the address built from the page name.</p>}
              <button type="button" className="text-[11px] text-orange-600 hover:underline shrink-0"
                onClick={() => setPageLink(profileUrlForPage({ handle: nameForLink, platform: page.platform }))}>
                Use @{nameForLink}’s address
              </button>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="hub-label" htmlFor="edit-page-state">State *</label>
              <StateSelect id="edit-page-state" value={state} onChange={setState} />
            </div>
            <div>
              <label className="hub-label" htmlFor="edit-page-geography">Geography *</label>
              <input id="edit-page-geography" className="hub-input" value={geography} onChange={e => setGeography(e.target.value)} placeholder="Vadodara" />
            </div>
          </div>

          <div>
            <label className="hub-label">Inventory (total slots)</label>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-[11px] text-muted-foreground" htmlFor="edit-page-inv-posts">Posts</label>
                <input id="edit-page-inv-posts" type="number" min={0} className="hub-input" value={inventoryPosts}
                  onChange={e => setInventoryPosts(count(e.target.value))} />
              </div>
              <div>
                <label className="text-[11px] text-muted-foreground" htmlFor="edit-page-inv-stories">Stories</label>
                <input id="edit-page-inv-stories" type="number" min={0} className="hub-input" value={inventoryStories}
                  onChange={e => setInventoryStories(count(e.target.value))} />
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground mt-1">
              Used so far: {used.postsDone} post{used.postsDone === 1 ? '' : 's'} · {used.storiesDone} stor{used.storiesDone === 1 ? 'y' : 'ies'} (counted from live posts).
            </p>
            {overUsed && (
              <p className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-2 py-1.5 mt-1 flex items-start gap-1.5">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
                {used.postsDone} posts are already placed on this page — more than the {inventoryPosts} you are setting. You can save
                this; the page will then show as over-used.
              </p>
            )}
          </div>

          <div>
            <label className="hub-label">Content preference</label>
            <div className="flex gap-2 flex-wrap">
              {PAGE_CONTENT_PREFERENCES.map(p => {
                const selected = contentPreferences.includes(p)
                return (
                  <button key={p} type="button" onClick={() => togglePref(p)} aria-pressed={selected}
                    className={`text-xs px-3 py-1.5 rounded-lg border transition-colors ${
                      selected
                        ? 'bg-orange-100 border-orange-300 text-orange-700 font-medium'
                        : 'bg-card border-border text-muted-foreground hover:bg-accent'
                    }`}>
                    {p}
                  </button>
                )
              })}
            </div>
            {contentPreferences.length === 0 && (
              <p className="text-[11px] text-muted-foreground mt-1">Not set — pick the content this page is known for.</p>
            )}
          </div>
        </div>
        {error && <div role="alert" className="px-4 py-2 text-xs text-rose-700 bg-rose-50 border-t border-rose-200">{error}</div>}
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
