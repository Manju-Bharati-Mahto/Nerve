/* The estimated-views rule: Instagram and Facebook report a view/play count
   only for videos and reels. A static image or a carousel has none, so the
   sync stores views = 0 for them. Their reach is estimated from engagement at
   a fixed rate — likes × 20 — and that estimate must show up everywhere reach
   is counted or a per-post view number is shown. Reels keep their real plays. */
import { describe, it, expect } from 'vitest'
import {
  effectiveViews, isEstimatedViews, ESTIMATED_VIEWS_PER_LIKE,
  aggregateTotals, campaignMetrics, dailyTrend, predictReach,
  type Post, type Campaign,
} from './outreach-data'

let seq = 0
function post(over: Partial<Post>): Post {
  return {
    id: `e${seq++}`, platform: 'instagram', date: '2026-08-01', pageId: null, creatorId: null, campaignId: null,
    type: 'static', creativeVariant: null, caption: '', status: 'published',
    likes: 0, comments: 0, views: 0, saves: 0, shares: 0, addedAsLive: true,
    ...over,
  }
}

describe('effectiveViews — likes × 20 for static and carousel, real plays otherwise', () => {
  it('estimates a static post from its likes', () => {
    expect(effectiveViews(post({ type: 'static', likes: 12, views: 0 }))).toBe(12 * ESTIMATED_VIEWS_PER_LIKE)
    expect(ESTIMATED_VIEWS_PER_LIKE).toBe(20)
  })

  it('estimates a carousel from its likes', () => {
    expect(effectiveViews(post({ type: 'carousel', likes: 7, views: 0 }))).toBe(140)
  })

  it('uses the real view count for a reel, never the estimate', () => {
    expect(effectiveViews(post({ type: 'reel', likes: 5, views: 9000 }))).toBe(9000)
  })

  it('ignores any stray stored views on a static post — the formula is the source of truth', () => {
    // The platform never reports views for these, but even if a number leaked
    // in, a static post's shown reach is the estimate.
    expect(effectiveViews(post({ type: 'static', likes: 3, views: 999 }))).toBe(60)
  })

  it('marks only static and carousel as estimated', () => {
    expect(isEstimatedViews(post({ type: 'static' }))).toBe(true)
    expect(isEstimatedViews(post({ type: 'carousel' }))).toBe(true)
    expect(isEstimatedViews(post({ type: 'reel' }))).toBe(false)
    expect(isEstimatedViews(post({ type: 'story' }))).toBe(false)
  })
})

describe('the estimate flows into every reach total', () => {
  it('counts estimated views in the dashboard totals', () => {
    const totals = aggregateTotals([
      post({ type: 'static', likes: 10 }),    // 200
      post({ type: 'carousel', likes: 5 }),   // 100
      post({ type: 'reel', likes: 1, views: 3000 }), // 3000 real
    ])
    expect(totals.reach).toBe(200 + 100 + 3000)
    expect(totals.views).toBe(3300)
  })

  it('counts estimated views in a campaign total', () => {
    const campaign = { id: 'c1' } as Campaign
    const m = campaignMetrics(campaign, [
      post({ campaignId: 'c1', type: 'static', likes: 50 }),  // 1000
      post({ campaignId: 'c1', type: 'reel', views: 500 }),   // 500
      post({ campaignId: 'c2', type: 'static', likes: 999 }), // other campaign, ignored
    ])
    expect(m.totalReach).toBe(1500)
  })

  it('counts estimated views in the daily trend', () => {
    const ref = new Date(2026, 7, 2, 12, 0)
    const trend = dailyTrend([post({ date: '2026-08-01', type: 'static', likes: 4 })], 7, ref)
    const day = trend.find(d => d.date === '2026-08-01')!
    expect(day.reach).toBe(80)
  })

  it('predicts a static-only page from its estimated reach, not from zeros', () => {
    const ps = Array.from({ length: 6 }, () =>
      post({ pageId: 'p', type: 'static', likes: 100, comments: 1 }))
    const r = predictReach('p', 'static', ps)!
    expect(r.samples).toBe(6)
    expect(r.avgReach).toBe(2000)      // 100 likes × 20
    expect(r.medianReach).toBe(2000)
  })
})
