/* Regression tests for the outreach view helpers: state matching, inventory
   pacing, CSV export, calendar paging, the dashboard's daily trend, alert
   dismissal and the AI Suggestions panels. Each block names the bug it pins. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  normaliseState, sameState, outreachStates, recommendPages, suggestedMonthlyUsage,
  toCsv, shiftCalendarCursor, dailyTrend, formatLocalDate, computeOutreachAlerts,
  dismissAlert, getDismissedAlertIds, useOutreachStore, matchPagesForPostType, predictReach,
  REACH_PREDICTION_MIN_SAMPLES,
  type OutreachPage, type Post, type Campaign,
} from './outreach-data'
import { renderHook, act } from '@testing-library/react'

function page(over: Partial<OutreachPage> & { id: string }): OutreachPage {
  return {
    handle: over.id, platform: 'instagram', geography: 'Geo', state: 'Gujarat', type: 'state', followerTier: '3',
    contentTypes: [], contentPreferences: [], followers: 1000,
    inventoryPosts: 24, inventoryStories: 0, notes: '', lastSyncedAt: null,
    pageLink: '', contactPerson: '', status: 'active',
    ...over,
  }
}

let seq = 0
function post(over: Partial<Post>): Post {
  return {
    id: `p${seq++}`, platform: 'instagram', date: '2026-08-01', pageId: null, creatorId: null, campaignId: null,
    type: 'static', creativeVariant: null, caption: '', status: 'published',
    likes: 0, comments: 0, views: 0, saves: 0, shares: 0, addedAsLive: true,
    ...over,
  }
}

function campaign(over: Partial<Campaign> & { id: string }): Campaign {
  return {
    name: over.id, startDate: '2026-01-01', endDate: '', state: 'Gujarat', goal: '',
    status: 'active', budgetPosts: 0, budgetStories: 0, budgetReels: 0,
    approvers: [], creativeVariants: [], assignedPageIds: [], assignedCreatorIds: [],
    ...over,
  }
}

// ── C11 / C27: state names differing only in case are one state ─────────────

describe('state normalisation', () => {
  it('maps a listed state to its canonical spelling, whatever the case or spacing', () => {
    expect(normaliseState('gujarat')).toBe('Gujarat')
    expect(normaliseState('  tamil   NADU ')).toBe('Tamil Nadu')
    expect(normaliseState('Ladakh ')).toBe('Ladakh')
    expect(normaliseState(null)).toBe('')
  })

  it('compares states case-insensitively', () => {
    expect(sameState('gujarat', 'Gujarat')).toBe(true)
    expect(sameState('Ladakh', 'ladakh ')).toBe(true)
    expect(sameState('Gujarat', 'Goa')).toBe(false)
  })

  it('lists one dropdown entry per state', () => {
    const states = outreachStates(
      [page({ id: 'a', state: 'gujarat' }), page({ id: 'b', state: 'Ladakh' }), page({ id: 'c', state: 'ladakh' })],
      [campaign({ id: 'x', state: 'Gujarat' })],
    )
    expect(states).toEqual(['Gujarat', 'Ladakh'])
  })

  it('recommends a page as a state match when only the case differs', () => {
    const recs = recommendPages([page({ id: 'puprojections', state: 'gujarat' })], [], { campaignState: 'Gujarat' })
    expect(recs.map(r => r.page.id)).toEqual(['puprojections'])
    expect(recs[0].stateMatch).toBe(true)
  })
})

// ── C23: no monthly pace once the post inventory is used up ─────────────────

describe('suggestedMonthlyUsage', () => {
  const live = (n: number) => Array.from({ length: n }, () => post({ pageId: 'pg', likes: 100, comments: 5 }))

  it('suggests nothing when every post slot is used', () => {
    expect(suggestedMonthlyUsage(page({ id: 'pg', inventoryPosts: 10 }), live(10))).toBe(0)
  })

  it('never suggests more slots than remain', () => {
    expect(suggestedMonthlyUsage(page({ id: 'pg', inventoryPosts: 120 }), live(117))).toBe(3)
  })

  it('keeps the yearly pace while slots remain', () => {
    expect(suggestedMonthlyUsage(page({ id: 'pg', inventoryPosts: 24 }), [])).toBe(2)
  })
})

// ── C20: CSV cells with commas, quotes or newlines are quoted ───────────────

describe('toCsv', () => {
  it('keeps a comma inside a value in one column', () => {
    const csv = toCsv([['handle', 'geography', 'state'], ['sweep_comma', 'Vadodara, Gujarat', 'Gujarat']])
    expect(csv).toBe('handle,geography,state\nsweep_comma,"Vadodara, Gujarat",Gujarat')
  })

  it('doubles embedded quotes and quotes line breaks', () => {
    expect(toCsv([['say "hi"', 'a\nb', 3, null]])).toBe('"say ""hi""","a\nb",3,')
  })
})

// ── C28: month paging from the 29th-31st does not skip a month ──────────────

describe('shiftCalendarCursor', () => {
  it('goes Oct → Nov → Dec from Oct 31', () => {
    const nov = shiftCalendarCursor(new Date(2026, 9, 31), 'month', 1)
    expect([nov.getFullYear(), nov.getMonth()]).toEqual([2026, 10])
    const dec = shiftCalendarCursor(nov, 'month', 1)
    expect([dec.getFullYear(), dec.getMonth()]).toEqual([2026, 11])
  })

  it('goes Jan → Feb from Jan 30, and back from Mar 31 to Feb', () => {
    expect(shiftCalendarCursor(new Date(2026, 0, 30), 'month', 1).getMonth()).toBe(1)
    expect(shiftCalendarCursor(new Date(2026, 2, 31), 'month', -1).getMonth()).toBe(1)
  })

  it('still moves a week at a time in week view', () => {
    expect(formatLocalDate(shiftCalendarCursor(new Date(2026, 9, 31), 'week', 1))).toBe('2026-11-07')
  })
})

// ── C29: trend buckets use the local calendar day at any hour ───────────────

describe('dailyTrend', () => {
  it('labels and buckets the same local day just after midnight', () => {
    // 00:30 local: in IST, toISOString() is still the previous day here.
    const ref = new Date(2026, 8, 12, 0, 30)
    const trend = dailyTrend([post({ date: '2026-09-12', views: 7 }), post({ date: '2026-09-11' })], 14, ref)
    expect(trend).toHaveLength(14)
    const last = trend[13]
    expect(last).toMatchObject({ date: '2026-09-12', day: '12/9', posts: 1, reach: 7 })
    expect(trend[12]).toMatchObject({ date: '2026-09-11', day: '11/9', posts: 1 })
    expect(trend[0].date).toBe('2026-08-30')
  })
})

// ── C30: a dismissed alert is gone everywhere ───────────────────────────────

describe('alert dismissal', () => {
  // A plain in-memory Storage: the runner's global localStorage is not a
  // usable Storage on every Node version (Node 25 ships a stub without a file).
  beforeEach(() => {
    const data = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => { data.set(k, String(v)) },
      removeItem: (k: string) => { data.delete(k) },
      clear: () => data.clear(),
    })
  })
  afterEach(() => { vi.unstubAllGlobals() })

  const camps = [campaign({ id: 'c1', assignedPageIds: ['a', 'b'] })]
  const pgs = [page({ id: 'a' }), page({ id: 'b' })]

  it('computeOutreachAlerts leaves out dismissed ids', () => {
    const all = computeOutreachAlerts(camps, pgs, [], [], new Date(2026, 5, 1), new Set())
    expect(all.map(a => a.id).sort()).toEqual(['c1:a', 'c1:b'])
    const rest = computeOutreachAlerts(camps, pgs, [], [], new Date(2026, 5, 1), new Set(['c1:a']))
    expect(rest.map(a => a.id)).toEqual(['c1:b'])
  })

  it('dismissing notifies every store consumer and is honoured by default', () => {
    const { result } = renderHook(() => useOutreachStore())
    act(() => { dismissAlert('c1:b') })
    expect(result.current.dismissedAlertIds.has('c1:b')).toBe(true)
    expect(getDismissedAlertIds().has('c1:b')).toBe(true)
    // The sidebar badge calls computeOutreachAlerts without a dismissed set.
    expect(computeOutreachAlerts(camps, pgs, [], [], new Date(2026, 5, 1)).map(a => a.id)).toEqual(['c1:a'])
  })
})

// ── C33: the matching panel's campaign picker changes the ranking ──────────

describe('matchPagesForPostType', () => {
  const pgs = [page({ id: 'big', state: 'Maharashtra' }), page({ id: 'local', state: 'gujarat' })]
  const ps = [
    post({ pageId: 'big', likes: 3000 }),
    post({ pageId: 'local', likes: 100 }),
    post({ pageId: 'local', likes: 0, status: 'scheduled', addedAsLive: false }),
  ]

  it('ranks by engagement with no campaign, ignoring planned posts', () => {
    const recs = matchPagesForPostType(pgs, ps, 'static')
    expect(recs.map(r => r.page.id)).toEqual(['big', 'local'])
    expect(recs[1]).toMatchObject({ samples: 1, avgEngagement: 100 })
  })

  it('ranks pages in the campaign state first', () => {
    const recs = matchPagesForPostType(pgs, ps, 'static', campaign({ id: 'c', state: 'Gujarat', assignedPageIds: ['local'] }))
    expect(recs.map(r => r.page.id)).toEqual(['local', 'big'])
    expect(recs[0]).toMatchObject({ stateMatch: true, assigned: true })
  })
})

// ── C32: predicted-reach probability is meaningful ──────────────────────────

describe('predictReach', () => {
  it('gives 100% to a page whose equal posts all meet the cross-page median, and skips planned posts', () => {
    const ps = [
      ...Array.from({ length: 10 }, () => post({ pageId: 'inv', likes: 100, comments: 5, views: 1000 })),
      post({ pageId: 'inv', status: 'scheduled', addedAsLive: false }),
      post({ pageId: 'other', likes: 50 }),
    ]
    const r = predictReach('inv', 'static', ps)!
    expect(r.samples).toBe(10)
    expect(r.avgReach).toBe(1000)
    expect(r.benchmarkPages).toBe(2)
    expect(r.successProb).toBe(1)
    expect(r.samples).toBeGreaterThanOrEqual(REACH_PREDICTION_MIN_SAMPLES)
  })

  it('gives 0% to a page that never reaches the cross-page median', () => {
    const ps = [
      post({ pageId: 'weak', likes: 10 }), post({ pageId: 'weak', likes: 10 }),
      post({ pageId: 'strong', likes: 500 }), post({ pageId: 'strong', likes: 500 }), post({ pageId: 'strong', likes: 500 }),
    ]
    expect(predictReach('weak', 'static', ps)!.successProb).toBe(0)
  })

  it('returns null with no measured history', () => {
    expect(predictReach('x', 'reel', [post({ pageId: 'x', type: 'reel', status: 'draft', addedAsLive: false })])).toBeNull()
  })
})
