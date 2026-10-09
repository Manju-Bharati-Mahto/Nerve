/* The two spreadsheet importers and the New Campaign dialog used to:
   - assume a new page's id was slug(handle), so when the server had to suffix
     a taken id the campaign was wired to a different page;
   - report a handle already in the ledger (409) as a failure;
   - drop a whole campaign when a new page had no State;
   - send impossible dates and out-of-range budgets that came back as
     "Internal server error.". */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { HttpError } from '@/lib/http'

const createOutreachPage = vi.fn()
const listOutreachPages = vi.fn()
vi.mock('@/lib/api', () => ({
  api: {
    createOutreachPage: (...a: unknown[]) => createOutreachPage(...a),
    listOutreachPages: (...a: unknown[]) => listOutreachPages(...a),
  },
}))

const {
  ensureInstagramPage, instagramPageIndex, handleKey, PageNeedsPlaceError,
  isRealIsoDate, toBudget, budgetProblem, MAX_BUDGET,
} = await import('./import-pages')

const row = (handle: string, place = 'Gujarat') => ({
  handle, geography: place, state: place, type: 'state' as const, followerTier: '3' as const,
  inventoryPosts: 0, inventoryStories: 0, notes: '',
})

beforeEach(() => {
  createOutreachPage.mockReset()
  listOutreachPages.mockReset()
})

describe('ensureInstagramPage', () => {
  it('uses the id the server gave, not slug(handle)', async () => {
    // "fix.dup" slugs to "fix-dup", which "fix_dup" already holds.
    createOutreachPage.mockResolvedValue({ page: { id: 'fix-dup-7903db', handle: 'fix.dup' } })
    const known = new Map<string, string>()
    const r = await ensureInstagramPage(row('fix.dup'), known)
    expect(r).toEqual({ id: 'fix-dup-7903db', created: true })
    expect(known.get('fix.dup')).toBe('fix-dup-7903db')
  })

  it('reuses a page already in the store without calling the server', async () => {
    const known = instagramPageIndex([{ id: 'p-1', handle: '@Fix_One', platform: 'instagram' }])
    const r = await ensureInstagramPage(row('fix_one'), known)
    expect(r).toEqual({ id: 'p-1', created: false })
    expect(createOutreachPage).not.toHaveBeenCalled()
  })

  it('creates a handle repeated in one sheet only once', async () => {
    createOutreachPage.mockResolvedValue({ page: { id: 'fix-two' } })
    const known = new Map<string, string>()
    await ensureInstagramPage(row('fix_two'), known)
    const again = await ensureInstagramPage(row('@FIX_two'), known)
    expect(again).toEqual({ id: 'fix-two', created: false })
    expect(createOutreachPage).toHaveBeenCalledTimes(1)
  })

  it('treats a 409 as "already exists" and reuses that page', async () => {
    createOutreachPage.mockRejectedValue(new HttpError('@FIX_dup is already in the ledger.', 409))
    listOutreachPages.mockResolvedValue({ pages: [
      { id: 'fb-fix-dup', handle: 'fix_dup', platform: 'facebook' },
      { id: 'fix-dup', handle: 'FIX_dup', platform: 'instagram' },
    ] })
    const r = await ensureInstagramPage(row('fix_dup'), new Map())
    expect(r).toEqual({ id: 'fix-dup', created: false })
  })

  it('passes any other server failure through', async () => {
    createOutreachPage.mockRejectedValue(new HttpError('Outreach manager only.', 403))
    await expect(ensureInstagramPage(row('fix_x'), new Map())).rejects.toThrow('Outreach manager only.')
    expect(listOutreachPages).not.toHaveBeenCalled()
  })

  it('refuses to create a page with no state instead of sending a payload the server rejects', async () => {
    await expect(ensureInstagramPage(row('fix_nostate', ''), new Map())).rejects.toBeInstanceOf(PageNeedsPlaceError)
    expect(createOutreachPage).not.toHaveBeenCalled()
  })

  it('does not need a state for a page that already exists', async () => {
    const known = new Map([['fix_known', 'fix-known']])
    await expect(ensureInstagramPage(row('fix_known', ''), known)).resolves.toEqual({ id: 'fix-known', created: false })
  })

  it('does not match a Facebook page for an Instagram handle', () => {
    expect(instagramPageIndex([{ id: 'fb-x', handle: 'x', platform: 'facebook' }]).size).toBe(0)
    expect(handleKey('  @@Foo ')).toBe('foo')
  })
})

describe('isRealIsoDate', () => {
  it('accepts real days and rejects impossible ones', () => {
    expect(isRealIsoDate('2026-10-08')).toBe(true)
    expect(isRealIsoDate('2028-02-29')).toBe(true)
    expect(isRealIsoDate('2026-02-31')).toBe(false)
    expect(isRealIsoDate('2026-02-29')).toBe(false)
    expect(isRealIsoDate('2026-13-01')).toBe(false)
    expect(isRealIsoDate('08/10/2026')).toBe(false)
  })
})

describe('budgets', () => {
  it('turns what the input holds into a whole number in range', () => {
    expect(toBudget('1.5')).toBe(1)
    expect(toBudget('')).toBe(0)
    expect(toBudget('-3')).toBe(0)
    expect(toBudget('3000000000')).toBe(MAX_BUDGET)
    expect(toBudget('12')).toBe(12)
  })

  it('names the budget a sheet got wrong', () => {
    expect(budgetProblem('Posts', 10)).toBeNull()
    expect(budgetProblem('Posts', 3_000_000_000)).toMatch(/^Posts budget 3000000000 is more than/)
    expect(budgetProblem('Reels', 1.5)).toBe('Reels budget must be a whole number.')
  })
})
