import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import type { Campaign, OutreachPage, Post } from '@/lib/outreach-data'
import OutreachCampaignDetail from './OutreachCampaignDetail'

const page: OutreachPage = {
  id: 'fix-page', handle: 'fix_page', platform: 'instagram', geography: 'Vadodara', state: 'Gujarat',
  type: 'state', followerTier: '1', contentTypes: [], contentPreferences: [], followers: 10,
  inventoryPosts: 5, inventoryStories: 5, notes: '', lastSyncedAt: null,
} as OutreachPage

const campaign: Campaign = {
  id: 'fix-campaign', name: 'FIX Campaign', startDate: '2026-10-01', endDate: '', state: 'Gujarat',
  goal: '', status: 'active', budgetPosts: 4, budgetStories: 0, budgetReels: 0,
  approvers: [], creativeVariants: [], assignedPageIds: ['fix-page'], assignedCreatorIds: [],
}

const post = (id: string): Post => ({
  id, platform: 'instagram', date: '2026-10-02', pageId: 'fix-page', creatorId: null,
  campaignId: 'fix-campaign', type: 'static', creativeVariant: null, caption: '', status: 'published',
  likes: 0, comments: 0, views: 0, saves: 0, shares: 0, addedAsLive: true,
})

const mockRemoveCampaign = vi.fn(async () => {})

vi.mock('@/lib/outreach-data', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/outreach-data')>()),
  useOutreachData: () => ({ campaigns: [campaign], posts: [post('p1'), post('p2')], pages: [page], creators: [] }),
  removeCampaign: (...args: unknown[]) => mockRemoveCampaign(...(args as [])),
}))

// recharts' ResponsiveContainer needs it; jsdom has none.
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  mockRemoveCampaign.mockClear()
})

function renderDetail() {
  return render(
    <MemoryRouter initialEntries={['/outreach/campaigns/fix-campaign']}>
      <Routes>
        <Route path="/outreach/campaigns/:campaignId" element={<OutreachCampaignDetail />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('OutreachCampaignDetail', () => {
  // outreach_posts.campaign_id is ON DELETE CASCADE. The dialog used to say
  // the posts would be "kept but unattributed" — and then they were deleted.
  it('warns that deleting the campaign deletes its posts', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    renderDetail()
    fireEvent.click(screen.getByTitle('Delete campaign'))

    expect(confirm).toHaveBeenCalledTimes(1)
    const msg = confirm.mock.calls[0][0] as string
    expect(msg).toMatch(/will also delete the 2 posts attributed to it/)
    expect(msg).not.toMatch(/kept/)
    expect(mockRemoveCampaign).not.toHaveBeenCalled()
  })

  // The server takes whole budgets from 0 to 100000; the inputs used to send
  // 1.5 (a vague 400) or 3000000000 (a 500).
  it('keeps typed budgets whole and in range', () => {
    renderDetail()
    fireEvent.click(screen.getByTitle('Edit pages, budgets and variants'))
    const [posts, stories, reels] = screen.getAllByRole('spinbutton') as HTMLInputElement[]

    fireEvent.change(posts, { target: { value: '1.5' } })
    fireEvent.change(stories, { target: { value: '3000000000' } })
    fireEvent.change(reels, { target: { value: '-4' } })

    expect(posts.value).toBe('1')
    expect(stories.value).toBe('100000')
    expect(reels.value).toBe('0')
  })
})
