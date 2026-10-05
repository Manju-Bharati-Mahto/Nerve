import { useCallback, useEffect, useMemo, useState } from 'react'
import { UserPlus, AlertCircle, Search, X, Trash2, Ban, RotateCcw } from 'lucide-react'
import {
  listWorkflowUsers, addWorkflowUser, updateWorkflowUser, deleteWorkflowUser,
  formatWhen, ROLE_LABEL, type WorkflowUser, type VideoRole,
} from '@/lib/outreach-video-data'
import { useAuth } from '@/hooks/useAuth'
import { useAppData } from '@/hooks/useAppData'
import { api } from '@/lib/api'
import { CAPABILITY_META, OV_CAPABILITY_ORDER } from '@/lib/capabilities'
import { NERVE_ROLE_FOR_VIDEO_ROLE, grantableVideoRoles } from './workflow-roles' 

/**
 * §4.2 — the searchable user-management table, with §4.3 add, §4.4 role change,
 * §4.5 disable/reactivate and §4.6 delete.
 *
 * Delete here is §4.6's "remove from the active user list": the record is
 * tombstoned server-side so every video, event and activity entry keeps
 * resolving to the right name and email. The dialog says so, because
 * "Delete" on its own would imply the history goes too.
 */
export default function VideoUsers() {
  const { role: actorRole } = useAuth()
  /* The same ceiling the dialog uses, and the same one the API enforces: a
     Manager must not be able to promote somebody to Admin from the table
     either. An existing Admin stays listed and readable — they simply are not
     a choice a Manager can pick, and the API refuses the edit regardless. */
  const assignableRoles = grantableVideoRoles(actorRole)
  const [users, setUsers] = useState<WorkflowUser[]>([])
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [confirming, setConfirming] = useState<WorkflowUser | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const { users } = await listWorkflowUsers()
      setUsers(users.filter(u => !u.deletedAt))
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load users.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return users
    return users.filter(u =>
      u.name.toLowerCase().includes(q) ||
      u.email.toLowerCase().includes(q) ||
      ROLE_LABEL[u.role].toLowerCase().includes(q))
  }, [users, query])

  async function act(user: WorkflowUser, fn: () => Promise<unknown>) {
    setBusyId(user.id)
    setError(null)
    try { await fn(); await refresh() }
    catch (err) { setError(err instanceof Error ? err.message : 'That change did not save.') }
    finally { setBusyId(null) }
  }

  return (
    <div className="animate-fade-in space-y-5">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-serif text-foreground">Users</h1>
          <p className="text-sm text-muted-foreground">Who can reach the video workflow, and as what.</p>
        </div>
        <button onClick={() => setAdding(true)}
          className="px-4 py-2 rounded-lg bg-orange-600 text-white text-sm font-medium hover:opacity-90 inline-flex items-center gap-2">
          <UserPlus className="w-4 h-4" /> Add user
        </button>
      </div>

      {error && (
        <div className="hub-card bg-rose-50 border-rose-200 flex items-start gap-2 text-sm text-rose-900">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" /> <span>{error}</span>
        </div>
      )}

      <div className="hub-card space-y-4">
        <div className="relative">
          <Search className="w-4 h-4 text-muted-foreground absolute left-3 top-1/2 -translate-y-1/2" />
          <input className="hub-input pl-9" placeholder="Search by name, email or role…"
            value={query} onChange={e => setQuery(e.target.value)} />
        </div>

        {loading ? (
          <p className="text-sm text-muted-foreground text-center py-8">Loading…</p>
        ) : shown.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-8">
            {users.length === 0 ? 'No users registered yet.' : 'Nobody matches that search.'}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-muted-foreground border-b border-border">
                  <th className="py-2 pr-3 font-medium">Name</th>
                  <th className="py-2 pr-3 font-medium">Email</th>
                  <th className="py-2 pr-3 font-medium">Role</th>
                  <th className="py-2 pr-3 font-medium">Status</th>
                  <th className="py-2 pr-3 font-medium">Date added</th>
                  <th className="py-2 pr-3 font-medium">Last activity</th>
                  <th className="py-2 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {shown.map(u => (
                  <tr key={u.id} className="border-b border-border/60 last:border-0">
                    <td className="py-2.5 pr-3 text-foreground">{u.name}</td>
                    <td className="py-2.5 pr-3 text-muted-foreground">{u.email}</td>
                    <td className="py-2.5 pr-3">
                      {/* §4.4 — the change takes effect on their next session. */}
                      <select className="hub-input py-1 text-xs w-auto" value={u.role}
                        disabled={busyId === u.id || !assignableRoles.includes(u.role)}
                        onChange={e => act(u, () => updateWorkflowUser(u.id, { role: e.target.value as VideoRole }))}>
                        {/* The person's current role is always shown, even when
                            this actor could not assign it, so the table reads
                            truthfully rather than mislabelling an Admin. */}
                        {(assignableRoles.includes(u.role) ? assignableRoles : [u.role, ...assignableRoles])
                          .map(r => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                      </select>
                    </td>
                    <td className="py-2.5 pr-3">
                      <span className={`hub-badge ${u.active
                        ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-600'}`}>
                        {u.active ? 'Active' : 'Disabled'}
                      </span>
                    </td>
                    <td className="py-2.5 pr-3 text-muted-foreground whitespace-nowrap">{formatWhen(u.createdAt)}</td>
                    <td className="py-2.5 pr-3 text-muted-foreground whitespace-nowrap">{formatWhen(u.lastActivityAt)}</td>
                    <td className="py-2.5 text-right whitespace-nowrap">
                      <button disabled={busyId === u.id}
                        onClick={() => act(u, () => updateWorkflowUser(u.id, { active: !u.active }))}
                        className="text-xs px-2 py-1 rounded-lg border border-border text-muted-foreground hover:bg-accent disabled:opacity-40 inline-flex items-center gap-1">
                        {u.active ? <><Ban className="w-3 h-3" /> Disable</> : <><RotateCcw className="w-3 h-3" /> Enable</>}
                      </button>
                      <button disabled={busyId === u.id} onClick={() => setConfirming(u)}
                        className="ml-1.5 text-xs px-2 py-1 rounded-lg border border-rose-200 text-rose-600 hover:bg-rose-50 disabled:opacity-40 inline-flex items-center gap-1">
                        <Trash2 className="w-3 h-3" /> Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {adding && (
        <AddUserDialog onClose={() => setAdding(false)}
          onDone={async () => { setAdding(false); await refresh() }} />
      )}
      {confirming && (
        <ConfirmDelete user={confirming} onClose={() => setConfirming(null)}
          onConfirm={async () => {
            const user = confirming
            setConfirming(null)
            await act(user, () => deleteWorkflowUser(user.id))
          }} />
      )}
    </div>
  )
}

/**
 * §4.3 + §6 — adds a person to the outreach team.
 *
 * This creates a real NERVE ACCOUNT, which is the part that was missing: the
 * old dialog wrote only the workflow registry, so the person it "added" had no
 * way to sign in unless somebody created their login elsewhere. The workflow
 * registry entry is not written here at all — the server provisions it on the
 * person's first authenticated request, deriving the workflow role from the
 * Nerve role, so the two can never disagree about who someone is.
 *
 * §6's custom permissions are the tab switches below. A role opens the tabs it
 * always did; a switch opens one more for this person alone. Both are checked
 * on the API, so a tab nobody switched on is not merely hidden.
 */
function AddUserDialog({ onClose, onDone }: { onClose: () => void; onDone: () => Promise<void> }) {
  const { role: actorRole } = useAuth()
  const { addUser } = useAppData()
  const roles = grantableVideoRoles(actorRole)

  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [mobile, setMobile] = useState('')
  const [department, setDepartment] = useState('')
  const [role, setRole] = useState<VideoRole>(roles.includes('editor') ? 'editor' : roles[0])
  const [capabilities, setCapabilities] = useState<string[]>([])
  const [photo, setPhoto] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const toggle = (key: string) => setCapabilities(cur =>
    cur.includes(key) ? cur.filter(k => k !== key) : [...cur, key])

  const allOn = OV_CAPABILITY_ORDER.every(k => capabilities.includes(k))
  const toggleAll = () => setCapabilities(allOn ? [] : [...OV_CAPABILITY_ORDER])

  async function save() {
    setBusy(true)
    setError(null)
    try {
      const created = await addUser({
        full_name: name.trim(),
        email: email.trim(),
        password,
        department: department.trim(),
        role: NERVE_ROLE_FOR_VIDEO_ROLE[role],
        team: 'outreach',
        managed_by: null,
        mobile: mobile.trim() || null,
      })
      // Grants are a separate write, and only worth making when there are any.
      if (capabilities.length) await api.setUserCapabilities(created.id, capabilities)

      /* §6 — the photo is optional, and the account already exists by now, so
         a failed photo is reported without undoing the add. */
      let photoError: string | null = null
      if (photo) {
        try { await api.uploadMemberAvatar(created.id, photo) }
        catch (err) { photoError = err instanceof Error ? err.message : 'The photo did not upload.' }
      }

      /* Register them in the workflow table too. The server would do this by
         itself on their first authenticated request, but "by itself, later"
         means the person the administrator just added is missing from the
         list they are looking at — so it is done here, now, and the table
         tells the truth immediately. Matching role, so the two agree.

         Not fatal if it fails: the account exists and signing in provisions
         the record anyway, so the add is reported as the success it was. */
      try {
        await addWorkflowUser({ name: name.trim(), email: email.trim(), role })
      } catch { /* provisioned on first sign-in instead */ }

      if (photoError) {
        setError(`${name.trim()} was added, but the photo did not upload: ${photoError}. You can try again from their profile.`)
        setBusy(false)
        return
      }
      await onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add that user.')
      setBusy(false)
    }
  }

  const ready = name.trim() && email.trim() && password.length >= 6

  return (
    <Dialog title="Add team member" onClose={onClose} busy={busy}>
      <div className="p-4 space-y-3 overflow-y-auto">
        <div className="grid grid-cols-2 gap-3">
          <div><label className="hub-label">Full name *</label>
            <input className="hub-input" value={name} onChange={e => setName(e.target.value)}
              placeholder="Jane Doe" /></div>
          <div><label className="hub-label">Department / team</label>
            <input className="hub-input" value={department} onChange={e => setDepartment(e.target.value)}
              placeholder="Outreach" /></div>
        </div>
        <div><label className="hub-label">Email address *</label>
          <input className="hub-input" type="email" value={email} onChange={e => setEmail(e.target.value)}
            placeholder="jane@parul.ac.in" />
          <p className="text-[11px] text-muted-foreground mt-1">
            This is the address they sign in with.
          </p></div>
        <div className="grid grid-cols-2 gap-3">
          <div><label className="hub-label">Temporary password *</label>
            <input className="hub-input" type="password" value={password}
              onChange={e => setPassword(e.target.value)} placeholder="Min 6 characters" /></div>
          <div><label className="hub-label">Mobile number</label>
            <input className="hub-input" value={mobile} onChange={e => setMobile(e.target.value)}
              placeholder="Optional" /></div>
        </div>
        <div>
          <label className="hub-label">Profile photo</label>
          <input type="file" accept="image/jpeg,image/png,image/webp,image/gif"
            className="hub-input py-1.5 text-xs"
            onChange={e => setPhoto(e.target.files?.[0] ?? null)} />
          <p className="text-[11px] text-muted-foreground mt-1">Optional. JPG, PNG, WEBP or GIF, up to 3 MB.</p>
        </div>
        <div><label className="hub-label">Role *</label>
          <select className="hub-input" value={role} onChange={e => setRole(e.target.value as VideoRole)}>
            {roles.map(r => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
          </select>
          {!roles.includes('admin') && (
            <p className="text-[11px] text-muted-foreground mt-1">
              A Manager can add Editors, Publishers and Managers. Only an Admin can add another Admin.
            </p>
          )}
        </div>

        <div className="pt-1">
          <div className="flex items-center justify-between gap-2 mb-1">
            <label className="hub-label mb-0">Tabs this person can see</label>
            <button type="button" onClick={toggleAll}
              className="text-[11px] font-semibold text-orange-700 hover:underline">
              {allOn ? 'Clear all' : 'Select all'}
            </button>
          </div>
          <p className="text-[11px] text-muted-foreground mb-2">
            Their role already opens its usual tabs. Switch on anything extra this
            person should reach — leaving everything off is fine.
          </p>
          <div className="space-y-1.5 max-h-56 overflow-y-auto pr-1">
            {OV_CAPABILITY_ORDER.map(key => {
              const meta = CAPABILITY_META[key]
              return (
                <label key={key}
                  className="flex items-start gap-2 px-2.5 py-2 rounded-lg border border-border cursor-pointer hover:bg-accent/40">
                  <input type="checkbox" className="mt-0.5"
                    checked={capabilities.includes(key)} onChange={() => toggle(key)} />
                  <div className="min-w-0">
                    <p className="text-xs font-semibold text-foreground">{meta.label}</p>
                    <p className="text-[11px] text-muted-foreground">{meta.description}</p>
                  </div>
                </label>
              )
            })}
          </div>
        </div>

        {error && <p className="text-xs text-rose-600">{error}</p>}
      </div>
      <div className="flex items-center justify-end gap-2 p-4 border-t border-border shrink-0">
        <button onClick={onClose} disabled={busy}
          className="px-4 py-2 rounded-lg border border-border text-sm text-muted-foreground hover:bg-accent disabled:opacity-40">Cancel</button>
        <button onClick={save} disabled={busy || !ready}
          className="px-4 py-2 rounded-lg bg-orange-600 text-white text-sm font-medium hover:opacity-90 disabled:opacity-40">
          {busy ? 'Adding…' : 'Add user'}
        </button>
      </div>
    </Dialog>
  )
}

function ConfirmDelete({ user, onClose, onConfirm }: {
  user: WorkflowUser; onClose: () => void; onConfirm: () => Promise<void>
}) {
  return (
    <Dialog title={`Delete ${user.name}?`} onClose={onClose} busy={false}>
      <div className="p-4 space-y-2 text-sm text-muted-foreground">
        <p>They lose access to the video workflow immediately.</p>
        <p>
          Their videos, events and activity history stay exactly as they are, still
          showing their name — nothing they worked on is removed.
        </p>
      </div>
      <div className="flex items-center justify-end gap-2 p-4 border-t border-border">
        <button onClick={onClose}
          className="px-4 py-2 rounded-lg border border-border text-sm text-muted-foreground hover:bg-accent">Cancel</button>
        <button onClick={onConfirm}
          className="px-4 py-2 rounded-lg bg-rose-600 text-white text-sm font-medium hover:opacity-90">
          Delete user
        </button>
      </div>
    </Dialog>
  )
}

function Dialog({ title, onClose, busy, children }: {
  title: string; onClose: () => void; busy: boolean; children: React.ReactNode
}) {
  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4 animate-fade-in">
      {/* Capped and scrollable: the tab switches make this dialog taller than a
          laptop screen, and a centred dialog that overflows puts its own Save
          button off the bottom of the window where nobody can reach it. */}
      <div className="bg-card rounded-xl border border-border w-full max-w-md max-h-full flex flex-col">
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
