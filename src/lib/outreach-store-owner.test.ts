/* The outreach store belongs to whoever is signed in, and to their states.

   The bug: signing out and in as somebody else does not reload the page, and
   the store loaded once per page load — so a user assigned only Gujarat was
   shown the manager's pages from every state, and the manager's overall
   reach on their dashboard. The server had answered them correctly; they
   were simply never asked. */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'

const who = vi.hoisted(() => ({
  user: { id: 'manager' } as { id: string } | null,
  access: { admin: true, configured: false, tabs: {}, scope: { kind: 'all' } } as unknown,
  accessLoading: false,
  /** What the server answers each person: the pages of their states. */
  pagesFor: {} as Record<string, Array<{ id: string; state: string }>>,
  /** Holds a person's answer back until released, to test a late reply. */
  hold: null as null | { userId: string; release: () => void },
}))

vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: who.user }) }))
vi.mock('./outreach-access', () => ({
  useOutreachAccess: () => ({ access: who.access, loading: who.accessLoading }),
}))
vi.mock('./api', async importOriginal => {
  const real = await importOriginal<typeof import('./api')>()
  const page = (p: { id: string; state: string }) => ({
    id: p.id, handle: p.id, platform: 'instagram', geography: p.state, state: p.state, type: 'state',
    follower_tier: '1', content_types: [], content_preferences: [], followers: 100,
    inventory_posts: 1, inventory_stories: 0, notes: '', last_synced_at: null,
  })
  return {
    ...real,
    api: {
      ...real.api,
      listOutreachPages: async () => {
        const asked = who.user?.id ?? ''
        if (who.hold?.userId === asked) await new Promise<void>(r => { who.hold!.release = r })
        return { pages: (who.pagesFor[asked] ?? []).map(page) }
      },
      listOutreachCreators: async () => ({ creators: [] }),
      listOutreachCampaigns: async () => ({ campaigns: [] }),
      listOutreachPosts: async () => ({ posts: [] }),
    },
  }
})

const { useOutreachData } = await import('./outreach-data')

const gujaratOnly = { admin: false, configured: true, tabs: { pages: 'view' }, scope: { kind: 'states', states: ['Gujarat'] } }

beforeEach(() => {
  who.user = { id: 'manager' }
  who.access = { admin: true, configured: false, tabs: {}, scope: { kind: 'all' } }
  who.accessLoading = false
  who.hold = null
  who.pagesFor = {
    manager: [{ id: 'gj', state: 'Gujarat' }, { id: 'rj', state: 'Rajasthan' }, { id: 'tn', state: 'Tamil Nadu' }],
    gujarat: [{ id: 'gj', state: 'Gujarat' }],
  }
})

const states = (pages: Array<{ state: string }>) => pages.map(p => p.state).sort()

describe('the outreach store follows the signed-in person', () => {
  it('shows a Gujarat-only user their own pages after the manager signs out, not the manager’s', async () => {
    const { result, rerender } = renderHook(() => useOutreachData())
    await waitFor(() => expect(result.current.loaded).toBe(true))
    expect(states(result.current.pages)).toEqual(['Gujarat', 'Rajasthan', 'Tamil Nadu'])

    // Sign out, sign in as the Gujarat user — same tab, no reload.
    who.user = { id: 'gujarat' }
    who.access = gujaratOnly
    rerender()
    // Never the previous person's lists, not even for the first render.
    expect(result.current.pages).toEqual([])
    await waitFor(() => expect(result.current.loaded).toBe(true))
    expect(states(result.current.pages)).toEqual(['Gujarat'])
  })

  it('waits for the person’s access before loading anything', async () => {
    who.user = { id: 'gujarat' }
    who.access = null
    who.accessLoading = true
    const { result, rerender } = renderHook(() => useOutreachData())
    expect(result.current.pages).toEqual([])
    expect(result.current.loading).toBe(true)

    who.access = gujaratOnly
    who.accessLoading = false
    rerender()
    await waitFor(() => expect(result.current.loaded).toBe(true))
    expect(states(result.current.pages)).toEqual(['Gujarat'])
  })

  it('reloads when the manager changes the person’s states', async () => {
    who.user = { id: 'gujarat' }
    who.access = gujaratOnly
    const { result, rerender } = renderHook(() => useOutreachData())
    await waitFor(() => expect(result.current.loaded).toBe(true))
    expect(states(result.current.pages)).toEqual(['Gujarat'])

    who.pagesFor.gujarat = [{ id: 'gj', state: 'Gujarat' }, { id: 'rj', state: 'Rajasthan' }]
    who.access = { ...gujaratOnly, scope: { kind: 'states', states: ['Gujarat', 'Rajasthan'] } }
    rerender()
    await waitFor(() => expect(states(result.current.pages)).toEqual(['Gujarat', 'Rajasthan']))
  })

  it('drops a late answer that was meant for the previous person', async () => {
    who.hold = { userId: 'manager', release: () => {} }
    const { result, rerender } = renderHook(() => useOutreachData())
    await waitFor(() => expect(result.current.loading).toBe(true))

    who.user = { id: 'gujarat' }
    who.access = gujaratOnly
    rerender()
    await waitFor(() => expect(result.current.loaded).toBe(true))
    expect(states(result.current.pages)).toEqual(['Gujarat'])

    // The manager's slow reply finally lands — and changes nothing.
    await act(async () => { who.hold!.release(); await new Promise(r => setTimeout(r, 20)) })
    expect(states(result.current.pages)).toEqual(['Gujarat'])
  })
})
