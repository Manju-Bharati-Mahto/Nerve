import { describe, it, expect } from 'vitest'
import {
  recommendPages, analyzePostPerformance, formatLocalDate,
  type OutreachPage, type Post, type Campaign,
} from './outreach-data'
import { buildDashboardReport } from './outreach-export'

// ── Fixture factories ────────────────────────────────────────────────────────

function page(over: Partial<OutreachPage> & { id: string }): OutreachPage {
  return {
    handle: over.id, platform: 'instagram', geography: 'Geo', state: 'Gujarat', type: 'state', followerTier: '3',
    contentTypes: [], contentPreferences: [], followers: 1000,
    inventoryPosts: 24, inventoryStories: 24, notes: '', lastSyncedAt: null,
    ...over,
  }
}

let seq = 0
function post(over: Partial<Post> & { pageId?: string | null; campaignId?: string | null }): Post {
  return {
    id: `p${seq++}`, platform: 'instagram', date: '2026-08-01', pageId: null, creatorId: null, campaignId: null,
    type: 'reel', creativeVariant: null, caption: '', status: 'published',
    likes: 0, comments: 0, views: 0, saves: 0, shares: 0, addedAsLive: true,
    ...over,
  }
}

function campaign(over: Partial<Campaign> & { id: string }): Campaign {
  return {
    name: over.id, startDate: '2026-08-01', endDate: '', state: 'Gujarat', goal: '',
    status: 'active', budgetPosts: 0, budgetStories: 0, budgetReels: 0,
    approvers: [], creativeVariants: [], assignedPageIds: [], assignedCreatorIds: [],
    ...over,
  }
}

const today = formatLocalDate(new Date())

// ── recommendPages (PRD 6.4) ─────────────────────────────────────────────────

describe('recommendPages', () => {
  it('ranks state matches above non-matches', () => {
    const pages = [
      page({ id: 'guj', state: 'Gujarat' }),
      page({ id: 'mah', state: 'Maharashtra' }),
    ]
    const recs = recommendPages(pages, [], { campaignState: 'Gujarat' })
    expect(recs[0].page.id).toBe('guj')
    expect(recs[0].stateMatch).toBe(true)
  })

  it('excludes already-assigned pages', () => {
    const pages = [page({ id: 'a' }), page({ id: 'b' })]
    const recs = recommendPages(pages, [], { campaignState: 'Gujarat', excludeIds: new Set(['a']) })
    expect(recs.map(r => r.page.id)).toEqual(['b'])
  })

  it('drops pages with no state match, no preference match and no history', () => {
    const pages = [page({ id: 'x', state: 'Kerala', contentPreferences: [] })]
    const recs = recommendPages(pages, [], { campaignState: 'Gujarat' })
    expect(recs).toHaveLength(0)
  })

  it('ranks by historical reach when state is equal', () => {
    const pages = [page({ id: 'low', state: 'Gujarat' }), page({ id: 'high', state: 'Gujarat' })]
    const posts = [
      post({ pageId: 'low', views: 100 }),
      post({ pageId: 'high', views: 9000 }),
    ]
    const recs = recommendPages(pages, posts, { campaignState: 'Gujarat' })
    expect(recs[0].page.id).toBe('high')
    expect(recs[0].avgReach).toBe(9000)
  })

  it('boosts a content-preference match', () => {
    const pages = [
      page({ id: 'comedy', state: 'Kerala', contentPreferences: ['Comedy'] }),
      page({ id: 'plain', state: 'Kerala', contentPreferences: [] }),
    ]
    const recs = recommendPages(pages, [], { preference: 'Comedy' })
    expect(recs[0].page.id).toBe('comedy')
    expect(recs[0].prefMatch).toBe(true)
  })
})

// ── analyzePostPerformance (PRD 6.6) ─────────────────────────────────────────

describe('analyzePostPerformance', () => {
  it('reports not-enough-data below the history threshold', () => {
    const pg = page({ id: 'a' })
    const posts = [post({ pageId: 'a', views: 100 }), post({ pageId: 'a', views: 200 })]
    const res = analyzePostPerformance(pg, posts[0], posts)
    expect(res.enoughData).toBe(false)
    expect(res.underperforming).toBe(false)
  })

  it('flags a post below the page average and suggests the best format', () => {
    const pg = page({ id: 'a' })
    // 3 reels averaging high, 1 low static.
    const posts = [
      post({ pageId: 'a', type: 'reel', views: 5000 }),
      post({ pageId: 'a', type: 'reel', views: 5000 }),
      post({ pageId: 'a', type: 'reel', views: 5000 }),
      post({ pageId: 'a', type: 'static', views: 100 }),
    ]
    const low = posts[3]
    const res = analyzePostPerformance(pg, low, posts)
    expect(res.enoughData).toBe(true)
    expect(res.underperforming).toBe(true)
    expect(res.alternate).toBe('reel')
    expect(res.reasons.join(' ')).toMatch(/reel/i)
  })

  it('does not flag a post at or above the average', () => {
    const pg = page({ id: 'a' })
    const posts = [
      post({ pageId: 'a', views: 1000 }),
      post({ pageId: 'a', views: 1000 }),
      post({ pageId: 'a', views: 1000 }),
    ]
    const res = analyzePostPerformance(pg, posts[0], posts)
    expect(res.underperforming).toBe(false)
  })

  it('calls out a Reels-only page running a non-reel', () => {
    const pg = page({ id: 'a', contentPreferences: ['Reels-only'] })
    const posts = [
      post({ pageId: 'a', type: 'reel', views: 5000 }),
      post({ pageId: 'a', type: 'reel', views: 5000 }),
      post({ pageId: 'a', type: 'static', views: 10 }),
    ]
    const res = analyzePostPerformance(pg, posts[2], posts)
    expect(res.underperforming).toBe(true)
    expect(res.reasons.join(' ')).toMatch(/reels-only/i)
  })
})

// ── buildDashboardReport (PRD 6.3) ───────────────────────────────────────────

describe('buildDashboardReport', () => {
  it('sums only live posts inside the window and computes engagement rate', () => {
    const pages = [page({ id: 'pg', state: 'Gujarat' })]
    const camps = [campaign({ id: 'c1', state: 'Gujarat' })]
    const posts = [
      post({ pageId: 'pg', campaignId: 'c1', date: today, views: 1000, likes: 50, comments: 30, shares: 20 }),
      // Outside the 30-day window — must be ignored.
      post({ pageId: 'pg', campaignId: 'c1', date: '2020-01-01', views: 999999, likes: 1, comments: 1, shares: 1 }),
      // Auto-synced (not live) — must be ignored.
      post({ pageId: 'pg', campaignId: 'c1', date: today, views: 500, likes: 5, comments: 5, addedAsLive: false }),
    ]
    const report = buildDashboardReport(camps, pages, [], posts, { days: 30 })
    expect(report.summary.views).toBe(1000)
    expect(report.summary.likes).toBe(50)
    expect(report.summary.campaigns).toBe(1)
    expect(report.rows).toHaveLength(1)
    const row = report.rows[0]
    expect(row.reach).toBe(1000)
    expect(row.shares).toBe(20)
    // (50 + 30 + 20) / 1000 = 10%
    expect(row.engagementRate).toBeCloseTo(10, 5)
    expect(report.totals.reach).toBe(1000)
  })

  it('scopes to the selected state', () => {
    const pages = [page({ id: 'g', state: 'Gujarat' }), page({ id: 'm', state: 'Maharashtra' })]
    const camps = [campaign({ id: 'cg', state: 'Gujarat' }), campaign({ id: 'cm', state: 'Maharashtra' })]
    const posts = [
      post({ pageId: 'g', campaignId: 'cg', date: today, views: 100 }),
      post({ pageId: 'm', campaignId: 'cm', date: today, views: 200 }),
    ]
    const report = buildDashboardReport(camps, pages, [], posts, { days: 30, stateFilter: 'Gujarat' })
    expect(report.rows).toHaveLength(1)
    expect(report.rows[0].name).toBe('cg')
    expect(report.summary.views).toBe(100)
  })
})
