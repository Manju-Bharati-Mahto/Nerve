import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import type { OutreachCreator } from '@/lib/outreach-data'
import OutreachCreatorDetail from './OutreachCreatorDetail'

const creator: OutreachCreator = {
  id: 'creator-fix', handle: 'fix_creator', geography: 'Vadodara', state: 'Gujarat',
  type: 'state', followerTier: '2', contentTypes: ['reel'], followers: 1200,
  inventoryPosts: 3, inventoryStories: 2, notes: '', lastSyncedAt: null,
}

const mockUpdateCreator = vi.fn(async () => {})

vi.mock('@/lib/outreach-data', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/outreach-data')>()),
  useOutreachData: () => ({ creators: [creator], campaigns: [], posts: [], pages: [] }),
  updateCreator: (...args: unknown[]) => mockUpdateCreator(...(args as [])),
}))

// recharts' ResponsiveContainer needs it; jsdom has none.
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver

afterEach(() => {
  cleanup()
  mockUpdateCreator.mockClear()
})

function renderDetail() {
  return render(
    <MemoryRouter initialEntries={['/outreach/creators/creator-fix']}>
      <Routes>
        <Route path="/outreach/creators/:creatorId" element={<OutreachCreatorDetail />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('OutreachCreatorDetail', () => {
  // A creator saved with the wrong inventory or tier used to be fixable only
  // by deleting it, which deleted its posts too.
  it('edits a creator in place', async () => {
    renderDetail()
    fireEvent.click(screen.getByRole('button', { name: /edit/i }))

    const save = screen.getByRole('button', { name: /save changes/i })
    expect(save).toBeDisabled()

    const [, invPosts] = screen.getAllByRole('spinbutton')
    fireEvent.change(invPosts, { target: { value: '7.6' } })
    fireEvent.change(screen.getAllByRole('combobox')[1], { target: { value: '4' } })
    fireEvent.click(save)

    await waitFor(() => expect(mockUpdateCreator).toHaveBeenCalledTimes(1))
    expect(mockUpdateCreator).toHaveBeenCalledWith('creator-fix', expect.objectContaining({
      inventoryPosts: 7, followerTier: '4', geography: 'Vadodara', state: 'Gujarat',
    }))
    await waitFor(() => expect(screen.queryByRole('button', { name: /save changes/i })).toBeNull())
  })

  it('shows the server’s reason when a save is refused', async () => {
    mockUpdateCreator.mockRejectedValueOnce(new Error('Invalid creator: inventory posts — must be a whole number.'))
    renderDetail()
    fireEvent.click(screen.getByRole('button', { name: /edit/i }))
    fireEvent.change(screen.getAllByRole('spinbutton')[2], { target: { value: '9' } })
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }))

    expect(await screen.findByText(/must be a whole number/)).toBeInTheDocument()
  })
})
