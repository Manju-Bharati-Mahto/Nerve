/* ═══════════════════════════════════════════════════════════════════════════
   A page's consumed inventory counts POSTS only.

   The All Pages ledger shows each page's inventory and how much of it the
   team has used. Stories are still counted and shown, but they no longer draw
   inventory down: consumption is posts used out of posts available.

   This replaced an average of the post and story percentages, which was wrong
   for nearly every page in the ledger, because most pages have no story
   inventory. With none, the story half of the average was always 0, so a page
   whose posts were completely used read as 50% and "on-track" rather than
   full and "over-used" — the one state the column exists to warn about.
   ═══════════════════════════════════════════════════════════════════════════ */
import { describe, expect, it } from 'vitest'
import { pageMetrics, type OutreachPage, type Post } from './outreach-data'

const page = (inventoryPosts: number, inventoryStories: number): OutreachPage => ({
  id: 'pg', handle: 'paruluniversity', platform: 'instagram', geography: '', state: '',
  type: 'Institute' as OutreachPage['type'], followerTier: 'Macro' as OutreachPage['followerTier'],
  contentTypes: [], contentPreferences: [], followers: 0,
  inventoryPosts, inventoryStories, notes: '', lastSyncedAt: null,
  pageLink: '', contactPerson: '', status: 'active',
})

let n = 0
const post = (type: Post['type'], over: Partial<Post> = {}): Post => ({
  id: `p${n++}`, platform: 'instagram', date: '2026-10-01', pageId: 'pg', creatorId: null,
  campaignId: null, type, creativeVariant: null, caption: '', status: 'published' as Post['status'],
  likes: 0, comments: 0, views: 0, saves: 0, shares: 0, addedAsLive: true,
  ...over,
})
const many = (k: number, type: Post['type']) => Array.from({ length: k }, () => post(type))

describe('consumed inventory is posts only', () => {
  it('reports posts used out of post inventory', () => {
    const m = pageMetrics(page(10, 5), [...many(4, 'static')])
    expect(m.postsDone).toBe(4)
    expect(m.pctConsumed).toBeCloseTo(0.4)
  })

  it('does not let stories draw the inventory down', () => {
    const withStories = pageMetrics(page(10, 5), [...many(4, 'static'), ...many(5, 'story')])
    const without = pageMetrics(page(10, 5), [...many(4, 'static')])
    expect(withStories.pctConsumed).toBe(without.pctConsumed)
  })

  it('still counts stories, so they can be shown', () => {
    const m = pageMetrics(page(10, 5), [...many(2, 'static'), ...many(3, 'story')])
    expect(m.storiesDone).toBe(3)
  })

  it('reads a page with every post used as full — even with no story inventory', () => {
    /* The bug this replaced: averaging with an empty story inventory halved
       the figure, so this page showed 50% and was called on-track. */
    const m = pageMetrics(page(10, 0), many(10, 'static'))
    expect(m.pctConsumed).toBe(1)
    expect(m.status).toBe('over-used')
  })

  it('calls a lightly used page under-used on its posts alone', () => {
    const m = pageMetrics(page(10, 5), [...many(1, 'static'), ...many(5, 'story')])
    expect(m.status).toBe('under-used')
  })

  it('reports 0%, not a division error, for a page with no post inventory', () => {
    const m = pageMetrics(page(0, 5), many(2, 'story'))
    expect(m.pctConsumed).toBe(0)
    expect(Number.isFinite(m.pctConsumed)).toBe(true)
  })

  it('ignores posts that were synced rather than placed by the team', () => {
    const m = pageMetrics(page(10, 0), [...many(2, 'static'), post('static', { addedAsLive: false })])
    expect(m.postsDone).toBe(2)
  })

  it('counts every non-story type — static, reel and carousel — as a post', () => {
    const m = pageMetrics(page(10, 0), [...many(1, 'static'), ...many(1, 'reel'), ...many(1, 'carousel')])
    expect(m.postsDone).toBe(3)
    expect(m.pctConsumed).toBeCloseTo(0.3)
  })
})
