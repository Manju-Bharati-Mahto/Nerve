import { useCallback, useEffect, useMemo, useState } from 'react'
import { UserPlus, AlertCircle, Search, X, Trash2, Ban, RotateCcw } from 'lucide-react'
import {
  listWorkflowUsers, addWorkflowUser, updateWorkflowUser, deleteWorkflowUser,
  formatWhen, ROLE_LABEL, type WorkflowUser, type VideoRole,
} from '@/lib/outreach-video-data'

const ROLES: VideoRole[] = ['admin', 'editor', 'manager', 'publisher']

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
                        disabled={busyId === u.id}
                        onChange={e => act(u, () => updateWorkflowUser(u.id, { role: e.target.value as VideoRole }))}>
                        {ROLES.map(r => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
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

/** §4.3 — Full Name, Email, Role, Account Status. */
function AddUserDialog({ onClose, onDone }: { onClose: () => void; onDone: () => Promise<void> }) {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<VideoRole>('editor')
  const [active, setActive] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save() {
    setBusy(true)
    setError(null)
    try {
      await addWorkflowUser({ name: name.trim(), email: email.trim(), role, active })
      await onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add that user.')
      setBusy(false)
    }
  }

  return (
    <Dialog title="Add user" onClose={onClose} busy={busy}>
      <div className="p-4 space-y-3">
        <div><label className="hub-label">Full name *</label>
          <input className="hub-input" value={name} onChange={e => setName(e.target.value)} /></div>
        <div><label className="hub-label">Email address *</label>
          <input className="hub-input" type="email" value={email} onChange={e => setEmail(e.target.value)} />
          <p className="text-[11px] text-muted-foreground mt-1">
            They sign in with this address — it has to match their Nerve account.
          </p></div>
        <div><label className="hub-label">Role *</label>
          <select className="hub-input" value={role} onChange={e => setRole(e.target.value as VideoRole)}>
            {ROLES.map(r => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
          </select></div>
        <label className="flex items-center gap-2 text-sm text-foreground">
          <input type="checkbox" checked={active} onChange={e => setActive(e.target.checked)} />
          Active
        </label>
        {error && <p className="text-xs text-rose-600">{error}</p>}
      </div>
      <div className="flex items-center justify-end gap-2 p-4 border-t border-border">
        <button onClick={onClose} disabled={busy}
          className="px-4 py-2 rounded-lg border border-border text-sm text-muted-foreground hover:bg-accent disabled:opacity-40">Cancel</button>
        <button onClick={save} disabled={busy || !name.trim() || !email.trim()}
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
      <div className="bg-card rounded-xl border border-border w-full max-w-md">
        <div className="flex items-start justify-between p-4 border-b border-border">
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
