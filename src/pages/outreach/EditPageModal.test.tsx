import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OutreachPage, Post } from '@/lib/outreach-data'

const page: OutreachPage = {
  id: 'fix-page', handle: 'fix_page', platform: 'instagram', geography: 'Vadodara', state: 'Gujarat',
  type: 'state', followerTier: '2', contentTypes: [], contentPreferences: [], followers: 100,
  inventoryPosts: 10, inventoryStories: 4, notes: '', lastSyncedAt: null,
  pageLink: '', contactPerson: '', status: 'active',
}

const livePost = (id: string): Post => ({
  id, platform: 'instagram', date: '2026-10-01', pageId: 'fix-page', creatorId: null, campaignId: null,
  type: 'static', creativeVariant: null, caption: '', status: 'published',
  likes: 0, comments: 0, views: 0, saves: 0, shares: 0, mediaUrl: null, permalink: null, addedAsLive: true,
})

const mockUpdatePage = vi.fn(async (..._args: unknown[]) => {})

vi.mock('@/lib/outreach-data', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/outreach-data')>()),
  useOutreachData: () => ({ pages: [page], posts: [livePost('a'), livePost('b'), livePost('c')], campaigns: [], creators: [] }),
  updatePage: (...args: unknown[]) => mockUpdatePage(...args),
}))

const { default: EditPageModal } = await import('./EditPageModal')

afterEach(() => {
  cleanup()
  mockUpdatePage.mockReset()
  mockUpdatePage.mockImplementation(async () => {})
})

const save = () => screen.getByRole('button', { name: 'Save changes' })

describe('EditPageModal', () => {
  it('shows every editable field with the page’s values', () => {
    render(<EditPageModal page={{ ...page, pageLink: 'https://www.instagram.com/fix_page/' }} onClose={() => {}} />)
    expect((screen.getByLabelText('Page name *') as HTMLInputElement).value).toBe('fix_page')
    expect((screen.getByLabelText('Page link') as HTMLInputElement).value).toBe('https://www.instagram.com/fix_page/')
    expect((screen.getByLabelText('State *') as HTMLSelectElement).value).toBe('Gujarat')
    expect((screen.getByLabelText('Geography *') as HTMLInputElement).value).toBe('Vadodara')
    expect((screen.getByLabelText('Posts') as HTMLInputElement).value).toBe('10')
    expect((screen.getByLabelText('Stories') as HTMLInputElement).value).toBe('4')
    expect(screen.getByRole('button', { name: 'Comedy' })).toBeTruthy()
    expect(save()).toHaveProperty('disabled', true)   // nothing changed yet
  })

  it('renames from a pasted profile URL and sends only what changed', async () => {
    const onClose = vi.fn()
    render(<EditPageModal page={page} onClose={onClose} />)
    fireEvent.change(screen.getByLabelText('Page name *'), { target: { value: 'https://www.instagram.com/fix_renamed/?hl=en' } })
    expect(screen.getByText(/Renaming keeps this page’s posts, campaigns and/)).toBeTruthy()
    fireEvent.click(save())
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(mockUpdatePage).toHaveBeenCalledWith('fix-page', { handle: 'fix_renamed' })
  })

  it('shows the server’s duplicate answer inline and stays open', async () => {
    mockUpdatePage.mockRejectedValue(new Error('@taken is already in the ledger — choose another name.'))
    const onClose = vi.fn()
    render(<EditPageModal page={page} onClose={onClose} />)
    fireEvent.change(screen.getByLabelText('Page name *'), { target: { value: 'taken' } })
    fireEvent.click(save())
    expect((await screen.findByRole('alert')).textContent).toMatch(/already in the ledger/)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('refuses a name with a space and a link to another platform before sending', () => {
    render(<EditPageModal page={page} onClose={() => {}} />)
    fireEvent.change(screen.getByLabelText('Page name *'), { target: { value: 'two words' } })
    expect(screen.getByText(/not an Instagram username/)).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Page name *'), { target: { value: 'fix_page' } })
    fireEvent.change(screen.getByLabelText('Page link'), { target: { value: 'https://www.facebook.com/fix_page' } })
    expect(screen.getByText(/must be an Instagram link/)).toBeTruthy()
    expect(save()).toHaveProperty('disabled', true)
  })

  it('warns, but allows, inventory lowered below what is already used', async () => {
    render(<EditPageModal page={page} onClose={() => {}} />)
    expect(screen.getByText(/Used so far: 3 posts/)).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Posts'), { target: { value: '2' } })
    expect(screen.getByText(/the page will then show as over-used/)).toBeTruthy()
    fireEvent.click(save())
    await waitFor(() => expect(mockUpdatePage).toHaveBeenCalledWith('fix-page', { inventoryPosts: 2 }))
  })

  it('moves the page to another state, by the master list', async () => {
    render(<EditPageModal page={page} onClose={() => {}} />)
    fireEvent.change(screen.getByLabelText('State *'), { target: { value: 'Tamil Nadu' } })
    fireEvent.click(save())
    await waitFor(() => expect(mockUpdatePage).toHaveBeenCalledWith('fix-page', { state: 'Tamil Nadu' }))
  })

  it('lets a page with an unrecognised legacy state still have its inventory edited', async () => {
    render(<EditPageModal page={{ ...page, state: 'Guj' }} onClose={() => {}} />)
    expect(screen.getByText(/Guj \(unrecognised/)).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Stories'), { target: { value: '6' } })
    fireEvent.click(save())
    await waitFor(() => expect(mockUpdatePage).toHaveBeenCalledWith('fix-page', { inventoryStories: 6 }))
  })

  it('fills the link from the page name', async () => {
    render(<EditPageModal page={page} onClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: /Use @fix_page’s address/ }))
    fireEvent.click(save())
    await waitFor(() => expect(mockUpdatePage).toHaveBeenCalledWith('fix-page', { pageLink: 'https://www.instagram.com/fix_page/' }))
  })
})
