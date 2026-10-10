import { useCallback, useEffect, useMemo, useState } from 'react'
import { UserPlus, AlertCircle, Search, X, Trash2, Ban, RotateCcw, SlidersHorizontal } from 'lucide-react'
import { listWorkflowUsers, addWorkflowUser, formatWhen, type VideoRole } from '@/lib/outreach-video-data'
import { useAuth } from '@/hooks/useAuth'
import { useAppData } from '@/hooks/useAppData'
import { api } from '@/lib/api'
import type { AppRole } from '@/lib/constants'
import {
  listOutreachAccessUsers, saveOutreachUserAccess, updateOutreachUser, removeOutreachUser,
  type OutreachAccessUser,
} from '@/lib/outreach-access'
import { OUTREACH_TABS, cleanTabLevels, defaultTabLevels, type OutreachTabLevel } from '@/lib/outreach-tabs'
import { videoRoleOf } from './workflow-roles'
import { useIsOutreachAdmin } from '@/lib/outreach-access'
import { AccessGrid, StatesPicker } from './AccessGrid'

/**
 * §4.2 — the outreach team, with §4.3 add, §4.4 role change, §4.5 disable /
 * enable and §4.6 / 6.2 remove; and, per the Account Tabs requirements, every
 * tab Off / View / Edit and the states each person sees.
 *
 * Built on the Nerve accounts themselves, not the video workflow's Drive
 * registry: the list, the role, Disable and Remove all work with Google Drive
 * connected or not, and a State User — who has no workflow record — is listed
 * like anyone else. The workflow registry only adds "Last activity", when it
 * can be read.
 *
 * Anyone given the Users tab sees the list; only the outreach admins — the
 * super admin and the outreach manager — add, change or remove people. The
 * API refuses everyone else whatever this page shows.
 */

const ROLE_NAME: Record<string, string> = {
  super_admin: 'Super admin',
  admin: 'Admin',
  outreach_manager: 'Manager',
  outreach_editor: 'Editor',
  outreach_publisher: 'Publisher',
  outreach_state_user: 'State User',
}

const ROLE_HINT: Record<string, string> = {
  admin: 'Video workflow Admin: uploads and publishes videos.',
  outreach_manager: 'Administers outreach: always every tab and every state.',
  outreach_editor: 'Uploads videos and works the review cycle.',
  outreach_publisher: 'Schedules and publishes approved videos.',
  outreach_state_user: 'Sees only the pages and analytics of their states. No video workflow.',
}

/** The roles this actor may give: only a super admin makes an Admin (canCreateManagedUser). */
function rolesFor(actorRole: AppRole | null): AppRole[] {
  const base: AppRole[] = ['outreach_manager', 'outreach_editor', 'outreach_publisher', 'outreach_state_user']
  return actorRole === 'super_admin' ? ['admin', ...base] : base
}

/** Super admin and manager: never configured, always everything. */
const isAdminRole = (role: string) => role === 'super_admin' || role === 'outreach_manager'

function tabsSummary(u: OutreachAccessUser): string {
  if (u.admin) return 'Every tab'
  const levels = Object.values(u.tabs ?? {})
  if (levels.length === 0) return 'No tabs'
  const edit = levels.filter(l => l === 'edit').length
  return `${levels.length} of ${OUTREACH_TABS.length}${edit ? ` · ${edit} edit` : ''}`
}

function statesSummary(u: OutreachAccessUser): string {
  if (u.admin || u.allStates) return 'All States'
  // Not configured yet: they open no Outreach tab, so no state applies to them.
  if (!u.configured && u.states.length === 0) return 'Not chosen'
  if (u.states.length === 0) return 'None'
  if (u.states.length <= 2) return u.states.join(', ')
  return `${u.states.slice(0, 2).join(', ')} +${u.states.length - 2}`
}

export default function VideoUsers() {
  const { user: me, role: actorRole } = useAuth()
  /* Anyone given the Users tab sees the team; only the outreach admins add,
     change or remove people. */
  const isAdmin = useIsOutreachAdmin()
  const assignable = rolesFor(actorRole)
  const [users, setUsers] = useState<OutreachAccessUser[]>([])
  const [lastActivity, setLastActivity] = useState<Map<string, string | null | undefined>>(new Map())
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<OutreachAccessUser | null>(null)
  const [confirming, setConfirming] = useState<OutreachAccessUser | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setUsers(await listOutreachAccessUsers())
      setLoadError(null)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Could not load users.')
    } finally {
      setLoading(false)
    }
    /* Last activity lives in the video workflow's registry, on Drive. It is a
       nice-to-have: without Drive the column reads "—" and nothing else
       changes. */
    try {
      const { users: records } = await listWorkflowUsers()
      setLastActivity(new Map(records.filter(r => !r.deletedAt).map(r => [r.email.toLowerCase(), r.lastActivityAt])))
    } catch { /* no Drive, or not reachable: the column stays empty */ }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return users
    return users.filter(u =>
      u.name.toLowerCase().includes(q) ||
      u.email.toLowerCase().includes(q) ||
      (ROLE_NAME[u.role] ?? u.role).toLowerCase().includes(q) ||
      statesSummary(u).toLowerCase().includes(q))
  }, [users, query])

  async function act(user: OutreachAccessUser, fn: () => Promise<unknown>, done?: string) {
    setBusyId(user.id)
    setError(null)
    setNotice(null)
    try { await fn(); await refresh(); if (done) setNotice(done) }
    catch (err) { setError(err instanceof Error ? err.message : 'That change did not save.') }
    finally { setBusyId(null) }
  }

  /** May this actor change this person at all? The API applies the same ceilings. */
  const manageable = (u: OutreachAccessUser) =>
    isAdmin && u.id !== me?.id && u.role !== 'super_admin' && (u.role !== 'admin' || actorRole === 'super_admin')

  return (
    <div className="animate-fade-in space-y-5">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-serif text-foreground">Users</h1>
          <p className="text-sm text-muted-foreground">
            The outreach team: each person's role, the tabs they can open, and the states whose pages and analytics they see.
          </p>
        </div>
        {isAdmin && (
          <button onClick={() => setAdding(true)}
            className="px-4 py-2 rounded-lg bg-orange-600 text-white text-sm font-medium hover:opacity-90 inline-flex items-center gap-2">
            <UserPlus className="w-4 h-4" /> Add user
          </button>
        )}
      </div>

      {loadError && <Banner tone="error" text={loadError} />}
      {error && <Banner tone="error" text={error} onDismiss={() => setError(null)} />}
      {notice && <Banner tone="ok" text={notice} onDismiss={() => setNotice(null)} />}

      <div className="hub-card space-y-4">
        <div className="relative">
          <Search className="w-4 h-4 text-muted-foreground absolute left-3 top-1/2 -translate-y-1/2" />
          <input className="hub-input pl-9" placeholder="Search by name, email, role or state…"
            value={query} onChange={e => setQuery(e.target.value)} />
        </div>

        {loading ? (
          <p className="text-sm text-muted-foreground text-center py-8">Loading…</p>
        ) : loadError && users.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-8">
            The user list could not be loaded — see the message above.
          </p>
        ) : shown.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-8">
            {users.length === 0 ? 'Nobody is on the outreach team yet.' : 'Nobody matches that search.'}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-muted-foreground border-b border-border">
                  <th className="py-2 pr-3 font-medium">Name</th>
                  <th className="py-2 pr-3 font-medium">Role</th>
                  <th className="py-2 pr-3 font-medium">Tabs</th>
                  <th className="py-2 pr-3 font-medium">States</th>
                  <th className="py-2 pr-3 font-medium">Status</th>
                  <th className="py-2 pr-3 font-medium">Date added</th>
                  <th className="py-2 pr-3 font-medium">Last activity</th>
                  <th className="py-2 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {shown.map(u => {
                  const canManage = manageable(u)
                  const busy = busyId === u.id
                  const roleChoices = assignable.includes(u.role as AppRole) ? assignable : [u.role as AppRole, ...assignable]
                  return (
                    <tr key={u.id} className="border-b border-border/60 last:border-0 align-top">
                      <td className="py-2.5 pr-3">
                        <p className="text-foreground">{u.name}{u.id === me?.id && <span className="text-muted-foreground"> (you)</span>}</p>
                        <p className="text-muted-foreground">{u.email}</p>
                      </td>
                      <td className="py-2.5 pr-3">
                        {/* §4.4 — on the Nerve account, so it applies on their next request. */}
                        <select className="hub-input py-1 text-xs w-auto" value={u.role}
                          disabled={busy || !canManage}
                          onChange={e => {
                            const next = e.target.value
                            void act(u, () => updateOutreachUser(u.id, { role: next }),
                              `${u.name} is now ${ROLE_NAME[next] ?? next}.`)
                          }}>
                          {roleChoices.map(r => <option key={r} value={r}>{ROLE_NAME[r] ?? r}</option>)}
                        </select>
                      </td>
                      <td className="py-2.5 pr-3 text-muted-foreground whitespace-nowrap">
                        {tabsSummary(u)}
                        {!u.admin && !u.configured && <p className="text-[10px]">Role's usual tabs</p>}
                      </td>
                      <td className="py-2.5 pr-3 text-muted-foreground">
                        <span className={statesSummary(u) === 'None' ? 'text-amber-700' : ''}>{statesSummary(u)}</span>
                      </td>
                      <td className="py-2.5 pr-3">
                        <span className={`hub-badge ${u.active ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-600'}`}>
                          {u.active ? 'Active' : 'Disabled'}
                        </span>
                      </td>
                      <td className="py-2.5 pr-3 text-muted-foreground whitespace-nowrap">{formatWhen(u.createdAt)}</td>
                      <td className="py-2.5 pr-3 text-muted-foreground whitespace-nowrap">
                        {formatWhen(lastActivity.get(u.email.toLowerCase()))}
                      </td>
                      <td className="py-2.5 text-right whitespace-nowrap">
                        {isAdmin && !u.admin && (u.role !== 'admin' || actorRole === 'super_admin') && (
                          <button disabled={busy} onClick={() => setEditing(u)}
                            className="text-xs px-2 py-1 rounded-lg border border-border text-foreground hover:bg-accent disabled:opacity-40 inline-flex items-center gap-1">
                            <SlidersHorizontal className="w-3 h-3" /> Tabs &amp; states
                          </button>
                        )}
                        {canManage && (
                          <>
                            <button disabled={busy}
                              onClick={() => act(u, () => updateOutreachUser(u.id, { active: !u.active }),
                                u.active ? `${u.name} is disabled and signed out.` : `${u.name} can sign in again.`)}
                              className="ml-1.5 text-xs px-2 py-1 rounded-lg border border-border text-muted-foreground hover:bg-accent disabled:opacity-40 inline-flex items-center gap-1">
                              {u.active ? <><Ban className="w-3 h-3" /> Disable</> : <><RotateCcw className="w-3 h-3" /> Enable</>}
                            </button>
                            <button disabled={busy} onClick={() => setConfirming(u)}
                              className="ml-1.5 text-xs px-2 py-1 rounded-lg border border-rose-200 text-rose-600 hover:bg-rose-50 disabled:opacity-40 inline-flex items-center gap-1">
                              <Trash2 className="w-3 h-3" /> Remove
                            </button>
                          </>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {adding && (
        <AddUserDialog onClose={() => setAdding(false)}
          onDone={async (message) => { setAdding(false); await refresh(); setNotice(message) }} />
      )}
      {editing && (
        <AccessDialog user={editing} onClose={() => setEditing(null)}
          onDone={async () => {
            const name = editing.name
            setEditing(null)
            await refresh()
            setNotice(`${name}'s tabs and states are saved. They see the change the next time they come back to Nerve.`)
          }} />
      )}
      {confirming && (
        <ConfirmRemove user={confirming} onClose={() => setConfirming(null)}
          onConfirm={async () => {
            const user = confirming
            setConfirming(null)
            await act(user, () => removeOutreachUser(user.id),
              `${user.name} has been removed. ${user.email} can now be used for a new account.`)
          }} />
      )}
    </div>
  )
}

/**
 * §4.3 + §6 + Account Tabs §1 — adds a person to the outreach team: a real
 * Nerve account, then exactly the tabs and states chosen here.
 */
function AddUserDialog({ onClose, onDone }: {
  onClose: () => void
  onDone: (message: string) => Promise<void>
}) {
  const { role: actorRole } = useAuth()
  const { addUser } = useAppData()
  const roles = rolesFor(actorRole)

  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [mobile, setMobile] = useState('')
  const [department, setDepartment] = useState('Outreach')
  const [role, setRole] = useState<AppRole>('outreach_editor')
  const [tabs, setTabs] = useState<Record<string, OutreachTabLevel>>(() => defaultTabLevels('outreach_editor'))
  const [tabsTouched, setTabsTouched] = useState(false)
  const [scope, setScope] = useState<{ allStates: boolean; states: string[] }>({ allStates: false, states: [] })
  const [photo, setPhoto] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /* A new role starts from its usual tabs — unless the grid was already
     changed by hand, in which case those choices stay, minus anything the new
     role cannot have. */
  function changeRole(next: AppRole) {
    setRole(next)
    setTabs(cur => tabsTouched ? cleanTabLevels(cur, next) : defaultTabLevels(next))
  }

  async function save() {
    setBusy(true)
    setError(null)
    const who = name.trim()
    try {
      const created = await addUser({
        full_name: who,
        email: email.trim(),
        password,
        department: department.trim(),
        role,
        team: 'outreach',
        managed_by: null,
        mobile: mobile.trim() || null,
      })

      /* From here the account exists; anything that fails is said, not
         undone, and can be finished from the table. */
      const problems: string[] = []
      if (!isAdminRole(role)) {
        try { await saveOutreachUserAccess(created.id, { tabs, ...scope }) }
        catch (err) {
          problems.push(`their tabs and states did not save (${err instanceof Error ? err.message : 'unknown error'}) — open "Tabs & states" on their row to set them`)
        }
      }
      if (photo) {
        try { await api.uploadMemberAvatar(created.id, photo) }
        catch (err) { problems.push(`the photo did not upload (${err instanceof Error ? err.message : 'unknown error'})`) }
      }
      /* Register them in the video workflow now, so they appear on its
         assignment lists before their first sign-in. Best effort: the server
         registers them on their first request anyway, and with no Drive
         connected there is nothing to write. A State User has no workflow
         role. */
      const videoRole = videoRoleOf(role) as VideoRole | null
      if (videoRole) {
        try { await addWorkflowUser({ name: who, email: email.trim(), role: videoRole }) } catch { /* see above */ }
      }

      if (problems.length) {
        setError(`${who} was added and can sign in, but ${problems.join('; and ')}.`)
        setBusy(false)
        return
      }
      await onDone(`${who} was added as ${ROLE_NAME[role]}. They can sign in with ${email.trim()}.`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add that user.')
      setBusy(false)
    }
  }

  const ready = name.trim() && email.trim() && password.length >= 6

  return (
    <Dialog title="Add team member" onClose={onClose} busy={busy} wide>
      <div className="p-4 space-y-3 overflow-y-auto">
        <div className="grid grid-cols-2 gap-3">
          <div><label className="hub-label">Full name *</label>
            <input className="hub-input" value={name} onChange={e => setName(e.target.value)} placeholder="Jane Doe" /></div>
          <div><label className="hub-label">Department / team</label>
            <input className="hub-input" value={department} onChange={e => setDepartment(e.target.value)} placeholder="Outreach" /></div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div><label className="hub-label">Email address *</label>
            <input className="hub-input" type="email" value={email} onChange={e => setEmail(e.target.value)}
              placeholder="jane@paruluniversity.ac.in" />
            <p className="text-[11px] text-muted-foreground mt-1">The address they sign in with.</p></div>
          <div><label className="hub-label">Temporary password *</label>
            <input className="hub-input" type="password" value={password}
              onChange={e => setPassword(e.target.value)} placeholder="Min 6 characters" /></div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div><label className="hub-label">Mobile number</label>
            <input className="hub-input" value={mobile} onChange={e => setMobile(e.target.value)} placeholder="Optional" /></div>
          <div><label className="hub-label">Profile photo</label>
            <input type="file" accept="image/jpeg,image/png,image/webp,image/gif" className="hub-input py-1.5 text-xs"
              onChange={e => setPhoto(e.target.files?.[0] ?? null)} />
            <p className="text-[11px] text-muted-foreground mt-1">Optional. JPG, PNG, WEBP or GIF, up to 3 MB.</p></div>
        </div>
        <div><label className="hub-label">Role *</label>
          <select className="hub-input" value={role} onChange={e => changeRole(e.target.value as AppRole)}>
            {roles.map(r => <option key={r} value={r}>{ROLE_NAME[r]}</option>)}
          </select>
          <p className="text-[11px] text-muted-foreground mt-1">
            {ROLE_HINT[role]}
            {actorRole !== 'super_admin' && ' Only a super admin can add an Admin.'}
          </p>
        </div>

        {isAdminRole(role) ? (
          <p className="text-xs text-muted-foreground border border-border rounded-lg p-3">
            A Manager administers outreach, so they always have every tab, at Edit, and every state. There is nothing to choose.
          </p>
        ) : (
          <>
            <AccessGrid tabs={tabs} stateUser={role === 'outreach_state_user'}
              onChange={next => { setTabs(next); setTabsTouched(true) }} />
            <StatesPicker allStates={scope.allStates} states={scope.states} onChange={setScope} />
          </>
        )}

        {error && <p className="text-xs text-rose-600">{error}</p>}
      </div>
      <DialogFooter onCancel={onClose} busy={busy} disabled={!ready} onSave={save}
        label={busy ? 'Adding…' : 'Add user'} />
    </Dialog>
  )
}

/** Account Tabs §1–2 — one person's tabs and states, changeable any time. */
function AccessDialog({ user, onClose, onDone }: {
  user: OutreachAccessUser
  onClose: () => void
  onDone: () => Promise<void>
}) {
  const [tabs, setTabs] = useState<Record<string, OutreachTabLevel>>(user.tabs ?? {})
  const [scope, setScope] = useState({ allStates: user.allStates, states: user.states })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save() {
    setBusy(true)
    setError(null)
    try {
      await saveOutreachUserAccess(user.id, { tabs, ...scope })
      await onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not save.')
      setBusy(false)
    }
  }

  return (
    <Dialog title={`Tabs & states — ${user.name}`} onClose={onClose} busy={busy} wide>
      <div className="p-4 space-y-3 overflow-y-auto">
        <p className="text-xs text-muted-foreground">{ROLE_NAME[user.role] ?? user.role} · {user.email}</p>
        {!user.configured && (
          <p className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg p-2">
            Not chosen yet: shown below is what their role gives them today. Once saved, this becomes exactly what they can open.
          </p>
        )}
        <AccessGrid tabs={tabs} onChange={setTabs} stateUser={user.role === 'outreach_state_user'} />
        <StatesPicker allStates={scope.allStates} states={scope.states} onChange={setScope} />
        {error && <p className="text-xs text-rose-600">{error}</p>}
      </div>
      <DialogFooter onCancel={onClose} busy={busy} onSave={save} label={busy ? 'Saving…' : 'Save'} />
    </Dialog>
  )
}

/** PRD 6.2 — says exactly what removing does, because "Delete" alone would mislead both ways. */
function ConfirmRemove({ user, onClose, onConfirm }: {
  user: OutreachAccessUser; onClose: () => void; onConfirm: () => Promise<void>
}) {
  return (
    <Dialog title={`Remove ${user.name}?`} onClose={onClose} busy={false}>
      <div className="p-4 space-y-2 text-sm text-muted-foreground">
        <p>They are signed out at once and can no longer sign in.</p>
        <p>
          Their email, <span className="text-foreground">{user.email}</span>, is released: you can create a new
          account with it straight away.
        </p>
        <p>
          Their videos, events and activity stay exactly as they are, still showing their name — nothing they
          worked on is removed. This cannot be undone; to stop someone signing in for a while, Disable them instead.
        </p>
      </div>
      <div className="flex items-center justify-end gap-2 p-4 border-t border-border">
        <button onClick={onClose}
          className="px-4 py-2 rounded-lg border border-border text-sm text-muted-foreground hover:bg-accent">Cancel</button>
        <button onClick={onConfirm}
          className="px-4 py-2 rounded-lg bg-rose-600 text-white text-sm font-medium hover:opacity-90">
          Remove user
        </button>
      </div>
    </Dialog>
  )
}

function Banner({ tone, text, onDismiss }: { tone: 'error' | 'ok'; text: string; onDismiss?: () => void }) {
  const style = tone === 'error'
    ? 'bg-rose-50 border-rose-200 text-rose-900'
    : 'bg-emerald-50 border-emerald-200 text-emerald-900'
  return (
    <div className={`hub-card ${style} flex items-start gap-2 text-sm`}>
      <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
      <span className="flex-1">{text}</span>
      {onDismiss && (
        <button onClick={onDismiss} className="p-1 rounded hover:bg-black/5" aria-label="Dismiss">
          <X className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  )
}

function DialogFooter({ onCancel, onSave, busy, disabled, label }: {
  onCancel: () => void; onSave: () => void; busy: boolean; disabled?: boolean; label: string
}) {
  return (
    <div className="flex items-center justify-end gap-2 p-4 border-t border-border shrink-0">
      <button onClick={onCancel} disabled={busy}
        className="px-4 py-2 rounded-lg border border-border text-sm text-muted-foreground hover:bg-accent disabled:opacity-40">Cancel</button>
      <button onClick={onSave} disabled={busy || disabled}
        className="px-4 py-2 rounded-lg bg-orange-600 text-white text-sm font-medium hover:opacity-90 disabled:opacity-40">
        {label}
      </button>
    </div>
  )
}

function Dialog({ title, onClose, busy, wide, children }: {
  title: string; onClose: () => void; busy: boolean; wide?: boolean; children: React.ReactNode
}) {
  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4 animate-fade-in">
      {/* Capped and scrollable: the tab grid makes this taller than a laptop
          screen, and a centred dialog that overflows puts its own Save button
          off the bottom of the window. */}
      <div className={`bg-card rounded-xl border border-border w-full ${wide ? 'max-w-2xl' : 'max-w-md'} max-h-full flex flex-col`}>
        <div className="flex items-start justify-between p-4 border-b border-border shrink-0">
          <h2 className="text-base font-serif text-foreground">{title}</h2>
          <button onClick={onClose} disabled={busy}
            className="p-2 rounded-lg hover:bg-accent text-muted-foreground disabled:opacity-40">
            <X className="w-4 h-4" />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}
