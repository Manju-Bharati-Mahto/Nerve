/**
 * What the signed-in person may open in outreach, and which states they see —
 * the browser's view of GET /api/outreach/access (server/outreach-scope.ts).
 *
 * This decides only what is SHOWN: which sidebar entries appear, which pages
 * open, which buttons render. The server makes the same decision again on
 * every request and refuses whatever this would have hidden, so nothing here
 * is a security boundary.
 *
 * Kept fresh without a sign-out: it is fetched once per signed-in person and
 * again whenever the window regains focus, so a change the manager saves (a
 * tab taken away, a state added) shows up the next time the person comes
 * back to the tab.
 */
import { useEffect, useSyncExternalStore } from 'react'
import { useAuth } from '@/hooks/useAuth'
import { OUTREACH_TABS, levelAtLeast, type OutreachTabLevel } from './outreach-tabs'

export type OutreachScope = { kind: 'all' } | { kind: 'states'; states: string[] }

export interface OutreachAccess {
  admin: boolean
  configured: boolean
  tabs: Record<string, OutreachTabLevel>
  scope: OutreachScope
}

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/$/, '')

/** super_admin and outreach_manager administer outreach and always have everything. */
export function isOutreachAdminRole(role: string | null | undefined): boolean {
  return role === 'super_admin' || role === 'outreach_manager'
}

const ADMIN_ACCESS: OutreachAccess = {
  admin: true,
  configured: false,
  tabs: Object.fromEntries(OUTREACH_TABS.map(t => [t.id, 'edit' as const])),
  scope: { kind: 'all' },
}

interface State { userId: string | null; access: OutreachAccess | null; loading: boolean }
let state: State = { userId: null, access: null, loading: false }
const listeners = new Set<() => void>()
let inflight: Promise<void> | null = null

function set(next: Partial<State>) {
  state = { ...state, ...next }
  listeners.forEach(l => l())
}

async function load(userId: string): Promise<void> {
  if (inflight) return inflight
  inflight = (async () => {
    try {
      const res = await fetch(`${API_BASE_URL}/outreach/access`, { credentials: 'include' })
      const body = res.ok ? await res.json() as { access: OutreachAccess } : null
      // A late answer for somebody who has since signed out must not land on the next person.
      if (state.userId === userId) set({ access: body?.access ?? null, loading: false })
    } catch {
      if (state.userId === userId) set({ loading: false })
    } finally {
      inflight = null
    }
  })()
  return inflight
}

/** Forces a fresh read — after an admin changes their own team's access, for instance. */
export function refreshOutreachAccess(): void {
  if (state.userId) void load(state.userId)
}

/**
 * The signed-in person's outreach access. `access` is null while it loads and
 * for anybody outside the outreach team. Admins are answered at once, without
 * a request.
 */
export function useOutreachAccess(): { access: OutreachAccess | null; loading: boolean } {
  const { user, role, team, loading: authLoading } = useAuth()
  const userId = user?.id ?? null
  const admin = isOutreachAdminRole(role)
  const relevant = !!userId && !admin && team === 'outreach'

  const snap = useSyncExternalStore(
    cb => { listeners.add(cb); return () => listeners.delete(cb) },
    () => state,
  )

  useEffect(() => {
    if (!relevant || !userId) return
    if (state.userId !== userId) {
      set({ userId, access: null, loading: true })
      void load(userId)
    }
    const onFocus = () => { void load(userId) }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [relevant, userId])

  if (authLoading) return { access: null, loading: true }
  if (admin) return { access: ADMIN_ACCESS, loading: false }
  if (!relevant) return { access: null, loading: false }
  if (snap.userId !== userId) return { access: null, loading: true }
  return { access: snap.access, loading: snap.loading }
}

/** Whether `access` reaches `tab` at `level`. */
export function canUseTab(access: OutreachAccess | null | undefined, tab: string, level: OutreachTabLevel = 'view'): boolean {
  if (!access) return false
  if (access.admin) return true
  return levelAtLeast(access.tabs[tab], level)
}

/** The first tab, in the sidebar's order, that this person may open. */
export function firstOpenTab(access: OutreachAccess): string | null {
  return OUTREACH_TABS.find(t => canUseTab(access, t.id))?.path ?? null
}

/** Shorthand for components: may the signed-in person make changes on this tab? */
export function useCanEditTab(tab: string): boolean {
  const { access } = useOutreachAccess()
  return canUseTab(access, tab, 'edit')
}

/**
 * May the signed-in person add or remove live posts? The server takes Edit on
 * Campaigns, All Pages or Creators (POST_TABS): a post belongs to a campaign
 * and to a page or creator.
 */
export function useCanEditPosts(): boolean {
  const { access } = useOutreachAccess()
  return ['campaigns', 'pages', 'creators'].some(t => canUseTab(access, t, 'edit'))
}

/** May the signed-in person add or delete pages and creators, or run the paid syncs? Admins only. */
export function useIsOutreachAdmin(): boolean {
  const { role } = useAuth()
  return isOutreachAdminRole(role)
}

// ── Admin calls: the Users dialog's tab grid and the State window ──────────

export interface OutreachAccessUser {
  id: string
  name: string
  email: string
  role: string
  /** False once disabled: they cannot sign in until enabled again. */
  active: boolean
  createdAt?: string
  /** Super admin / outreach manager: every tab and state, never configured. */
  admin: boolean
  configured: boolean
  /** Saved tabs, or for the unconfigured what their role effectively gives; null for an admin. */
  tabs: Record<string, OutreachTabLevel> | null
  allStates: boolean
  states: string[]
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
  const body = await res.json().catch(() => ({})) as Record<string, unknown>
  if (!res.ok) throw new Error(typeof body.message === 'string' ? body.message : `Request failed (${res.status}).`)
  return body as T
}

export const listOutreachAccessUsers = () =>
  call<{ users: OutreachAccessUser[] }>('/outreach/access/users').then(r => r.users)

/** Saves one person's whole grid: tabs, and either All States or a list of states. */
export const saveOutreachUserAccess = (
  userId: string, access: { tabs: Record<string, OutreachTabLevel>; allStates: boolean; states: string[] },
) => call<{ access: OutreachAccess }>(`/outreach/access/users/${encodeURIComponent(userId)}`, {
  method: 'PUT', body: JSON.stringify(access),
}).then(r => r.access)

/** The State window: changes only which states a person sees, keeping their tabs. */
export const saveOutreachUserStates = (userId: string, states: { allStates: boolean; states: string[] }) =>
  call<{ access: OutreachAccess }>(`/outreach/access/users/${encodeURIComponent(userId)}/states`, {
    method: 'PUT', body: JSON.stringify(states),
  }).then(r => r.access)

/** The Users table's role change and Disable / Enable — on the Nerve account, Drive or not. */
export const updateOutreachUser = (userId: string, change: { role?: string; active?: boolean }) =>
  call<{ updated: true; role: string; active: boolean }>(`/outreach/access/users/${encodeURIComponent(userId)}`, {
    method: 'PATCH', body: JSON.stringify(change),
  })

/** Removes someone from outreach for good, releasing their email for a new account. */
export const removeOutreachUser = (userId: string) =>
  call<{ removed: true; email: string }>(`/outreach/access/users/${encodeURIComponent(userId)}`, { method: 'DELETE' })
