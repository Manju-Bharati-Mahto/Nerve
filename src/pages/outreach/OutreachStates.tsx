import { useCallback, useEffect, useMemo, useState } from 'react'
import { MapPin, X, Users as UsersIcon, AlertCircle } from 'lucide-react'
import { useOutreachData, pageMetrics } from '@/lib/outreach-data'
import { useAuth } from '@/hooks/useAuth'
import { OUTREACH_STATE_NAMES, canonicalState } from '@/lib/outreach-states'
import {
  useIsOutreachAdmin, listOutreachAccessUsers, saveOutreachUserStates,
  type OutreachAccessUser,
} from '@/lib/outreach-access'

/**
 * The State tab — Account Tabs & State-wise Analytics requirements, §2.
 *
 * One row per state: its pages, their reach and inventory, and who can see
 * it. An outreach admin clicks a state to open the access window, picks a
 * person, and chooses which states' analytics they may see — one state,
 * several, or All States — with that person's current choice already
 * selected. Saving applies on the person's next request; nobody has to sign
 * out.
 *
 * Anyone else given this tab sees the same table for their own states only
 * (the server sends no other state's pages), without the window.
 */
const ROLE_LABEL: Record<string, string> = {
  admin: 'Video Admin', outreach_editor: 'Editor', outreach_publisher: 'Publisher',
  outreach_state_user: 'State User', outreach_manager: 'Manager', super_admin: 'Super Admin',
}

export default function OutreachStates() {
  const { pages, posts, loading, error } = useOutreachData()
  const isAdmin = useIsOutreachAdmin()
  const { role } = useAuth()
  const [people, setPeople] = useState<OutreachAccessUser[]>([])
  const [peopleError, setPeopleError] = useState<string | null>(null)
  const [opened, setOpened] = useState<string | null>(null)
  const [showAll, setShowAll] = useState(false)

  const loadPeople = useCallback(async () => {
    if (!isAdmin) return
    try { setPeople(await listOutreachAccessUsers()); setPeopleError(null) }
    catch (err) { setPeopleError(err instanceof Error ? err.message : 'Could not load the team.') }
  }, [isAdmin])
  useEffect(() => { void loadPeople() }, [loadPeople])

  const rows = useMemo(() => {
    const byState = new Map<string, { pages: number; followers: number; used: number; total: number; views: number; likes: number }>()
    for (const page of pages) {
      const state = canonicalState(page.state) || '—'
      const r = byState.get(state) ?? { pages: 0, followers: 0, used: 0, total: 0, views: 0, likes: 0 }
      r.pages += 1
      r.followers += page.followers
      r.total += page.inventoryPosts
      r.used += pageMetrics(page, posts).postsDone
      for (const p of posts) {
        if (p.pageId === page.id && p.addedAsLive) { r.views += p.views; r.likes += p.likes }
      }
      byState.set(state, r)
    }
    const names = isAdmin && showAll ? OUTREACH_STATE_NAMES : [...byState.keys()]
    return [...new Set(names)]
      .map(state => ({ state, ...(byState.get(state) ?? { pages: 0, followers: 0, used: 0, total: 0, views: 0, likes: 0 }) }))
      .sort((a, b) => b.pages - a.pages || a.state.localeCompare(b.state))
  }, [pages, posts, isAdmin, showAll])

  /** Who can see one state: everyone with All States, plus those assigned it. */
  const viewersOf = (state: string) =>
    people.filter(p => p.admin || p.allStates || p.states.includes(state))

  return (
    <div className="animate-fade-in space-y-5">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-orange-100 flex items-center justify-center">
            <MapPin className="w-5 h-5 text-orange-600" />
          </div>
          <div>
            <h1 className="text-xl font-serif text-foreground">State</h1>
            <p className="text-sm text-muted-foreground">
              {isAdmin
                ? 'Pages and analytics state by state. Click a state to choose who can see it.'
                : 'Pages and analytics for the states assigned to you.'}
            </p>
          </div>
        </div>
        {isAdmin && (
          <label className="text-xs text-muted-foreground inline-flex items-center gap-2">
            <input type="checkbox" checked={showAll} onChange={e => setShowAll(e.target.checked)} />
            Show states with no pages
          </label>
        )}
      </div>

      {(error || peopleError) && (
        <div className="hub-card flex items-start gap-2 text-sm text-rose-600">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" /> {error || peopleError}
        </div>
      )}

      {loading ? (
        <div className="hub-card text-center py-12 text-sm text-muted-foreground">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="hub-card text-center py-12">
          <MapPin className="w-8 h-8 text-muted-foreground/40 mx-auto mb-2" />
          <p className="text-sm text-muted-foreground">
            {isAdmin ? 'No pages have been added yet.' : 'No pages exist in the states assigned to you, or none have been assigned yet. Ask your outreach manager.'}
          </p>
        </div>
      ) : (
        <div className="hub-card overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-widest text-muted-foreground border-b border-border">
                <th className="px-3 py-2.5 font-medium">State</th>
                <th className="px-3 py-2.5 font-medium text-right">Pages</th>
                <th className="px-3 py-2.5 font-medium text-right">Followers</th>
                <th className="px-3 py-2.5 font-medium text-right">Post inventory used</th>
                <th className="px-3 py-2.5 font-medium text-right">Views</th>
                <th className="px-3 py-2.5 font-medium text-right">Likes</th>
                {isAdmin && <th className="px-3 py-2.5 font-medium">Who can see it</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map(r => {
                const viewers = isAdmin ? viewersOf(r.state) : []
                const configurable = viewers.filter(v => !v.admin)
                return (
                  <tr key={r.state}
                    onClick={isAdmin && r.state !== '—' ? () => setOpened(r.state) : undefined}
                    className={`border-b border-border/60 last:border-0 ${isAdmin && r.state !== '—' ? 'cursor-pointer hover:bg-accent/40' : ''}`}>
                    <td className="px-3 py-2.5 font-medium text-foreground">
                      {r.state === '—' ? <span className="text-muted-foreground">No state set</span> : r.state}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{r.pages}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{r.followers.toLocaleString('en-IN')}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{r.used} / {r.total}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{r.views.toLocaleString('en-IN')}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{r.likes.toLocaleString('en-IN')}</td>
                    {isAdmin && (
                      <td className="px-3 py-2.5 text-xs text-muted-foreground">
                        {configurable.length
                          ? configurable.map(v => v.name).join(', ')
                          : <span className="italic">Managers only</span>}
                      </td>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {opened && (
        <StateAccessWindow
          state={opened}
          // Admins see everything; the video workflow Admin is the super admin's to limit.
          people={people.filter(p => !p.admin && (p.role !== 'admin' || role === 'super_admin'))}
          onClose={() => setOpened(null)}
          onSaved={async () => { await loadPeople() }} />
      )}
    </div>
  )
}

/**
 * The access window (§2). Picks one person; shows their current states
 * already selected; the admin chooses one state, several, or All States, and
 * saves or cancels. The state that was clicked is listed first and marked,
 * but is not ticked for anyone automatically — what is shown selected is
 * exactly what that person has now.
 */
function StateAccessWindow({ state, people, onClose, onSaved }: {
  state: string
  people: OutreachAccessUser[]
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const [userId, setUserId] = useState('')
  const person = people.find(p => p.id === userId) ?? null
  const [allStates, setAllStates] = useState(false)
  const [chosen, setChosen] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  /* Pre-select the chosen person's current assignment — when they are picked,
     not on every refresh of the list, so the reload after a save does not
     wipe what was just saved off the screen. */
  function pick(id: string) {
    const next = people.find(p => p.id === id) ?? null
    setUserId(id)
    setAllStates(next?.allStates ?? false)
    setChosen(next ? [...next.states] : [])
    setError(null)
    setSaved(false)
  }

  const toggle = (s: string) => setChosen(cur => cur.includes(s) ? cur.filter(x => x !== s) : [...cur, s])
  const ordered = [state, ...OUTREACH_STATE_NAMES.filter(s => s !== state)]

  async function save() {
    if (!person) return
    setBusy(true); setError(null)
    try {
      await saveOutreachUserStates(person.id, { allStates, states: allStates ? [] : chosen })
      await onSaved()
      setSaved(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4 animate-fade-in" onClick={onClose}>
      <div className="bg-card rounded-xl border border-border w-full max-w-lg max-h-full flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-start justify-between p-4 border-b border-border shrink-0">
          <div>
            <h2 className="text-base font-serif text-foreground">State-wise analytics access</h2>
            <p className="text-xs text-muted-foreground mt-0.5">Opened from <b>{state}</b></p>
          </div>
          <button onClick={onClose} className="p-2 rounded-lg hover:bg-accent text-muted-foreground" aria-label="Close">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 space-y-4 overflow-y-auto">
          <div>
            <label className="hub-label">User</label>
            <select className="hub-input" value={userId} onChange={e => pick(e.target.value)}>
              <option value="">— choose a user —</option>
              {people.map(p => (
                <option key={p.id} value={p.id}>
                  {p.name} · {ROLE_LABEL[p.role] ?? p.role}{(p.allStates || p.states.includes(state)) ? ` · sees ${state}` : ''}
                </option>
              ))}
            </select>
            {!people.length && (
              <p className="text-[11px] text-muted-foreground mt-1 inline-flex items-center gap-1">
                <UsersIcon className="w-3 h-3" /> No outreach users yet besides managers, who always see every state.
              </p>
            )}
          </div>

          {person && (
            <>
              <div className="space-y-2">
                <label className="flex items-center gap-2 text-sm text-foreground">
                  <input type="radio" name="scope" checked={allStates} onChange={() => setAllStates(true)} />
                  All States — sees analytics of every state
                </label>
                <label className="flex items-center gap-2 text-sm text-foreground">
                  <input type="radio" name="scope" checked={!allStates} onChange={() => setAllStates(false)} />
                  Only the states ticked below
                </label>
              </div>

              {!allStates && (
                <div className="space-y-1 max-h-64 overflow-y-auto pr-1 border border-border rounded-lg p-2">
                  {ordered.map(s => (
                    <label key={s} className={`flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer hover:bg-accent/40 ${s === state ? 'bg-orange-50' : ''}`}>
                      <input type="checkbox" checked={chosen.includes(s)} onChange={() => toggle(s)} />
                      <span className="text-sm text-foreground">{s}</span>
                      {s === state && <span className="text-[10px] uppercase tracking-wider text-orange-700">this state</span>}
                    </label>
                  ))}
                </div>
              )}

              {!allStates && chosen.length === 0 && (
                <p className="text-xs text-amber-700">With no state ticked, {person.name} will see no pages or analytics at all.</p>
              )}
              {!person.configured && (
                <p className="text-[11px] text-muted-foreground">
                  {person.name}'s tabs have not been chosen yet. Saving keeps the tabs they have now.
                </p>
              )}
            </>
          )}

          {error && <p className="text-xs text-rose-600">{error}</p>}
          {saved && <p className="text-xs text-emerald-700">Saved. {person?.name} sees this from their next page load.</p>}
        </div>

        <div className="flex items-center justify-end gap-2 p-4 border-t border-border shrink-0">
          <button onClick={onClose} disabled={busy}
            className="px-4 py-2 rounded-lg border border-border text-sm text-muted-foreground hover:bg-accent disabled:opacity-40">
            {saved ? 'Close' : 'Cancel'}
          </button>
          <button onClick={save} disabled={busy || !person}
            className="px-4 py-2 rounded-lg bg-orange-600 text-white text-sm font-medium hover:opacity-90 disabled:opacity-40">
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}
