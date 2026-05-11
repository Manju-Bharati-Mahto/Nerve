/**
 * Outreach domain data — pages, campaigns, posts.
 *
 * Frontend-only store backed by localStorage. Seeded from the BR_POST_2026 sheet
 * so the UI is meaningful out of the box. A small subscription pattern lets
 * components re-render when the store changes.
 */
import { useEffect, useState, useSyncExternalStore } from 'react'

// ── Types ──────────────────────────────────────────────────────────────────

// Creator types — all pages are UGC; bifurcated as 'state' (state-level reach pages)
// or 'pu' (Parul University owned/operated pages).
export const PAGE_TYPES = ['state', 'pu'] as const
export type PageType = typeof PAGE_TYPES[number]

export const POST_TYPES = ['static', 'reel', 'story', 'carousel'] as const
export type PostType = typeof POST_TYPES[number]

export const POST_STATUSES = ['draft', 'scheduled', 'pending_approval', 'published'] as const
export type PostStatus = typeof POST_STATUSES[number]

export const CAMPAIGN_STATUSES = ['planning', 'active', 'completed', 'paused'] as const
export type CampaignStatus = typeof CAMPAIGN_STATUSES[number]

export const FOLLOWER_TIERS = ['nano', 'micro', 'mid', 'macro'] as const
export type FollowerTier = typeof FOLLOWER_TIERS[number]

export interface OutreachPage {
  id: string
  handle: string
  geography: string         // 'Vadodara', 'Gujarat', 'Maharashtra' …
  state: string             // 'Gujarat', 'Maharashtra' (state-level grouping)
  type: PageType
  followerTier: FollowerTier
  followers: number
  inventoryPosts: number
  inventoryStories: number
  notes: string
}

export interface Campaign {
  id: string
  name: string
  startDate: string         // YYYY-MM-DD
  endDate: string
  goal: string
  status: CampaignStatus
  budgetPosts: number
  budgetStories: number
  budgetReels: number
  approvers: string[]
  creativeVariants: string[]
  assignedPageIds: string[]
}

export interface Post {
  id: string
  date: string              // YYYY-MM-DD
  pageId: string
  campaignId: string
  type: PostType
  creativeVariant: string | null
  caption: string
  status: PostStatus
  likes: number
  comments: number
  views: number
  saves: number
  shares: number
}

interface OutreachDB {
  pages: OutreachPage[]
  campaigns: Campaign[]
  posts: Post[]
}

// ── Seed data (extracted from BR_POST_2026 - All Pages.pdf) ────────────────

const SEED_PAGES: OutreachPage[] = [
  // Vadodara
  pg('vadodaraourcity', 'Vadodara', 'Gujarat', 'state', 'mid', 48, 24),
  pg('Vadodara Sankari Nagri', 'Vadodara', 'Gujarat', 'state', 'mid', 48, 24),
  pg('Vadodara the Amazing city', 'Vadodara', 'Gujarat', 'state', 'mid', 48, 24),
  pg('Aapdu Vadodara', 'Vadodara', 'Gujarat', 'pu', 'mid', 48, 24),
  pg('Smart city Vadodara', 'Vadodara', 'Gujarat', 'state', 'micro', 48, 24),
  pg('Vadodara Sankari Nagri (club)', 'Vadodara', 'Gujarat', 'state', 'mid', 48, 24),
  pg('Trending in vadodara', 'Vadodara', 'Gujarat', 'state', 'mid', 48, 24, 'Club Deal A'),
  pg('Vadodara Media (club)', 'Vadodara', 'Gujarat', 'state', 'mid', 48, 24),
  pg('Vadodara Live', 'Vadodara', 'Gujarat', 'state', 'mid', 48, 24),
  pg('The People of Vadodara', 'Vadodara', 'Gujarat', 'state', 'mid', 48, 24),
  pg('Our City Vadodara', 'Vadodara', 'Gujarat', 'state', 'mid', 48, 24),
  pg('Baroda Mirror', 'Vadodara', 'Gujarat', 'pu', 'mid', 48, 24),
  pg('OUR PADRA', 'Vadodara', 'Gujarat', 'state', 'micro', 24, 24),
  pg('Barodian', 'Vadodara', 'Gujarat', 'state', 'mid', 48, 24),
  pg('Sweet Vadodara', 'Vadodara', 'Gujarat', 'state', 'mid', 48, 24),
  pg('I am Vadodara | Micro-Nano', 'Vadodara', 'Gujarat', 'pu', 'micro', 25, 30),
  pg('hu chu vadodara', 'Vadodara', 'Gujarat', 'pu', 'mid', 48, 24),
  pg('Vadodara Baroda', 'Vadodara', 'Gujarat', 'state', 'micro', 16, 10),
  pg('Vadodara Attraction', 'Vadodara', 'Gujarat', 'state', 'mid', 48, 24),
  pg('Vadodara Vibez', 'Vadodara', 'Gujarat', 'state', 'micro', 20, 24),
  pg('Vadodara Darshan', 'Vadodara', 'Gujarat', 'pu', 'micro', 20, 20),
  pg('Baroda Breaking News', 'Vadodara', 'Gujarat', 'state', 'micro', 20, 20),
  pg('Our VD News', 'Vadodara', 'Gujarat', 'state', 'micro', 20, 24),
  pg('thetimesofvadodara_', 'Vadodara', 'Gujarat', 'state', 'micro', 20, 20),

  // Gujarat (rest of state)
  pg('Dev Bhumi Dwarka', 'Gujarat', 'Gujarat', 'pu', 'mid', 48, 24),
  pg('Sanskari nagri navsari', 'Gujarat', 'Gujarat', 'state', 'micro', 48, 24),
  pg('I Love Jamnagar', 'Gujarat', 'Gujarat', 'pu', 'mid', 48, 24),
  pg('Our Rajkot', 'Gujarat', 'Gujarat', 'pu', 'mid', 48, 24),
  pg('iamsuratcity', 'Gujarat', 'Gujarat', 'state', 'mid', 48, 24),
  pg('Our Vapi', 'Gujarat', 'Gujarat', 'state', 'micro', 48, 24),
  pg('aapdujunagadh', 'Gujarat', 'Gujarat', 'pu', 'micro', 26, 25),
  pg('Modasa City Arvalli', 'Gujarat', 'Gujarat', 'state', 'micro', 48, 24),
  pg('Our Kutch', 'Gujarat', 'Gujarat', 'pu', 'mid', 48, 24),
  pg('Its all about Nadiad', 'Gujarat', 'Gujarat', 'state', 'micro', 48, 24),
  pg('Surat Update', 'Gujarat', 'Gujarat', 'state', 'mid', 48, 24, 'Club Deal B'),
  pg('Ahmedabad Updates', 'Gujarat', 'Gujarat', 'state', 'mid', 48, 24, 'Club Deal B'),
  pg('Apnu Amdavad', 'Gujarat', 'Gujarat', 'state', 'mid', 48, 24, 'Club Deal A'),
  pg('Maru Gandhinagar', 'Gujarat', 'Gujarat', 'pu', 'mid', 48, 24),
  pg('Aapnu Amreli', 'Gujarat', 'Gujarat', 'pu', 'mid', 48, 24),
  pg('Aapdu Porbandar', 'Gujarat', 'Gujarat', 'pu', 'mid', 48, 24),
  pg('CityofAmdavad', 'Gujarat', 'Gujarat', 'pu', 'mid', 24, 24),
  pg('Incredible Bharuch', 'Gujarat', 'Gujarat', 'state', 'micro', 24, 12),
  pg('Dahod Live', 'Gujarat', 'Gujarat', 'state', 'micro', 48, 24),

  // Maharashtra
  pg('pune guide', 'Maharashtra', 'Maharashtra', 'state', 'micro', 24, 12),
  pg('I love Aurangabad', 'Maharashtra', 'Maharashtra', 'state', 'mid', 48, 24),
  pg('aurangabadtak', 'Maharashtra', 'Maharashtra', 'state', 'mid', 48, 24),
  pg('Being Punekar', 'Maharashtra', 'Maharashtra', 'pu', 'mid', 25, 25),
  pg('Apla Akola', 'Maharashtra', 'Maharashtra', 'state', 'micro', 22, 22),
  pg('Dhulenews24', 'Maharashtra', 'Maharashtra', 'pu', 'micro', 24, 24),
  pg('My Nashik', 'Maharashtra', 'Maharashtra', 'state', 'micro', 22, 22),
  pg('trending_amravati', 'Maharashtra', 'Maharashtra', 'state', 'micro', 22, 22),

  // Rajasthan
  pg('Udaipur Blog', 'Rajasthan', 'Rajasthan', 'pu', 'mid', 48, 24),
  pg('banswara blog', 'Rajasthan', 'Rajasthan', 'state', 'micro', 48, 24),
  pg('abutimes', 'Rajasthan', 'Rajasthan', 'state', 'micro', 48, 24),
  pg('Jodhpur the blue heaven', 'Rajasthan', 'Rajasthan', 'pu', 'mid', 48, 24),
  pg('Bharatpur Buzz', 'Rajasthan', 'Rajasthan', 'state', 'micro', 48, 24),
  pg('Banjare Yaar', 'Rajasthan', 'Rajasthan', 'state', 'nano', 15, 15),
  pg('Jaipur Waley', 'Rajasthan', 'Rajasthan', 'pu', 'micro', 15, 15),

  // North-East
  pg('Justassamthings', 'North-East', 'Assam', 'state', 'mid', 48, 24),
  pg('North Eastern Chronicle', 'North-East', 'Assam', 'pu', 'mid', 48, 24),
  pg('Guwahati Plus', 'North-East', 'Assam', 'pu', 'mid', 48, 24),
  pg('Dibrugarh 24x7', 'North-East', 'Assam', 'state', 'micro', 48, 24),
  pg('Assam Unofficial', 'North-East', 'Assam', 'state', 'micro', 48, 24),

  // Madhya Pradesh
  pg('Balaghat', 'Madhya Pradesh', 'Madhya Pradesh', 'state', 'micro', 48, 24),
  pg('apna bhopal', 'Madhya Pradesh', 'Madhya Pradesh', 'state', 'micro', 48, 24),
  pg('chhindwara city', 'Madhya Pradesh', 'Madhya Pradesh', 'state', 'micro', 48, 24),
  pg('Dewas live', 'Madhya Pradesh', 'Madhya Pradesh', 'state', 'micro', 48, 24),
  pg('namaste_narmadapuram', 'Madhya Pradesh', 'Madhya Pradesh', 'state', 'micro', 48, 24),
  pg('ujjain nagri', 'Madhya Pradesh', 'Madhya Pradesh', 'pu', 'micro', 48, 24),

  // Uttar Pradesh
  pg('Kanpur Wale', 'Uttar Pradesh', 'Uttar Pradesh', 'state', 'micro', 24, 24),
  pg('360 Kanpur', 'Uttar Pradesh', 'Uttar Pradesh', 'state', 'micro', 12, 12),
  pg('UP Wale', 'Uttar Pradesh', 'Uttar Pradesh', 'state', 'micro', 48, 24),
  pg('agraalive_', 'Uttar Pradesh', 'Uttar Pradesh', 'state', 'micro', 48, 24),
  pg('Lucknow Hearts', 'Uttar Pradesh', 'Uttar Pradesh', 'pu', 'mid', 48, 24),
  pg('Apna Sultanpur', 'Uttar Pradesh', 'Uttar Pradesh', 'state', 'micro', 48, 24),

  // Bihar
  pg('Patna Se Hai', 'Bihar', 'Bihar', 'state', 'micro', 12, 12),
  pg('Patna Planet', 'Bihar', 'Bihar', 'state', 'micro', 36, 36),
  pg('Muzaffarpur Live', 'Bihar', 'Bihar', 'state', 'micro', 36, 36),

  // Goa
  pg('Goa Viral News', 'Goa', 'Goa', 'state', 'micro', 24, 24),
  pg('Goa Darling', 'Goa', 'Goa', 'state', 'micro', 24, 24),
  pg('Goastory', 'Goa', 'Goa', 'state', 'micro', 24, 24),
  pg('Goa_Dreamy', 'Goa', 'Goa', 'state', 'micro', 22, 22),
  pg('amchegoa_', 'Goa', 'Goa', 'state', 'micro', 24, 24),

  // J&K
  pg('srinagarnawakadalofficial', 'JK', 'Jammu & Kashmir', 'state', 'nano', 22, 22),
  pg('newsxnagaland', 'JK', 'Jammu & Kashmir', 'state', 'nano', 22, 22),
]

const SEED_CAMPAIGNS: Campaign[] = [
  cm('REHABVEDA', '2026-03-02', '2026-03-15', 'Rehabilitation awareness', 'completed', 60, 30, 0, ['set_1', 'set_2'], ['vadodaraourcity', 'Aapdu Vadodara', 'Baroda Mirror', 'Justassamthings']),
  cm('Udhayam 2026 (Reels)', '2026-03-11', '2026-03-25', 'Cultural fest reels reach', 'active', 0, 0, 50, ['garud', 'drone', 'engine'], ['Vadodara Sankari Nagri', 'Aapnu Amreli', 'Being Punekar', 'Guwahati Plus']),
  cm('Udhayam 2026 (Static)', '2026-03-11', '2026-03-25', 'Cultural fest static creatives', 'active', 60, 0, 0, ['set_1', 'set_2', 'set_3'], ['Aapdu Vadodara', 'Baroda Mirror', 'I am Vadodara | Micro-Nano']),
  cm('Media Crew (Story)', '2026-03-14', '2026-03-21', 'BTS coverage stories', 'completed', 0, 80, 0, ['set_1'], ['vadodaraourcity', 'Vadodara Live', 'Sweet Vadodara']),
  cm('Praman 2026', '2026-03-16', '2026-03-30', 'Convocation hype', 'active', 50, 25, 30, ['set_1', 'set_2', 'garud'], ['Vadodara Sankari Nagri', 'Vadodara Live']),
  cm('Physio Goa Admission', '2026-03-20', '2026-04-10', 'Physio Goa admissions push', 'active', 0, 0, 40, ['REMS', 'engine'], ['Goa Viral News', 'Goa Darling', 'Goastory']),
  cm('H.E Rui Duarte (Static)', '2026-03-22', '2026-03-29', 'Diplomatic visit coverage', 'completed', 30, 10, 0, ['set_1'], ['Goa Viral News', 'amchegoa_']),
  cm('VFF', '2026-03-24', '2026-04-07', 'Vadodara Film Festival', 'active', 80, 40, 20, ['set_1', 'set_2', 'garud', 'drone'], ['vadodaraourcity', 'Baroda Mirror', 'Sweet Vadodara', 'Vadodara Darshan']),
  cm('MLA (Goa)', '2026-03-28', '2026-04-04', 'Local government engagement', 'completed', 20, 10, 0, ['set_1'], ['Goa Viral News', 'Goastory']),
  cm('Air Force', '2026-03-30', '2026-04-15', 'Air Force exhibition', 'active', 40, 20, 15, ['set_1', 'set_2'], ['Vadodara Sankari Nagri', 'Vadodara Attraction']),
  cm('Placement Day', '2026-03-30', '2026-04-10', 'Placement results announcement', 'completed', 50, 30, 10, ['set_1', 'set_2'], ['vadodaraourcity', 'Baroda Mirror', 'CityofAmdavad']),
  cm('Tech Expo', '2026-04-01', '2026-04-15', 'Tech showcase static creatives', 'active', 60, 20, 0, ['set_1', 'set_2', 'set_3'], ['Aapdu Vadodara', 'Maru Gandhinagar', 'I Love Jamnagar', 'Lucknow Hearts']),
  cm('Dhoom "Virast E Bharat"', '2026-04-02', '2026-04-20', 'Cultural heritage reels', 'active', 30, 20, 50, ['garud', 'drone', 'engine'], ['Vadodara Darshan', 'Aapnu Amreli', 'CityofAmdavad', 'Guwahati Plus']),
  cm('International AI Tech Tour', '2026-04-03', '2026-04-25', 'Cross-state AI tour coverage', 'planning', 100, 60, 40, ['set_1', 'set_2', 'garud'], ['vadodaraourcity', 'Being Punekar', 'Lucknow Hearts', 'Guwahati Plus']),
  cm('VFDF', '2026-04-09', '2026-04-25', 'Design & Fashion Festival', 'active', 70, 40, 30, ['set_1', 'set_2', 'set_3'], ['vadodaraourcity', 'Sweet Vadodara', 'Vadodara Darshan', 'CityofAmdavad']),
  cm('10th Result', '2026-04-23', '2026-04-26', 'School board results', 'planning', 30, 20, 10, ['set_1'], ['CityofAmdavad', 'Maru Gandhinagar']),
  cm('Food Fest', '2026-04-30', '2026-05-15', 'Food festival static push', 'planning', 50, 20, 0, ['set_1', 'set_2'], ['vadodaraourcity', 'Sweet Vadodara', 'Baroda Mirror']),
]

// Generate posts from the campaign × page intersections in the PDF.
// Each cell value (1, 2, "set_1", "garud", …) becomes one or more posts.
const SEED_POSTS: Post[] = generateSeedPosts(SEED_PAGES, SEED_CAMPAIGNS)

const SEED: OutreachDB = { pages: SEED_PAGES, campaigns: SEED_CAMPAIGNS, posts: SEED_POSTS }

// ── Helpers ────────────────────────────────────────────────────────────────

function pg(handle: string, geography: string, state: string, type: PageType, tier: FollowerTier, posts: number, stories: number, notes = ''): OutreachPage {
  const followers = tier === 'macro' ? 500_000 : tier === 'mid' ? 80_000 : tier === 'micro' ? 20_000 : 5_000
  return {
    id: slug(handle),
    handle,
    geography,
    state,
    type,
    followerTier: tier,
    followers: followers + Math.floor(seedRand(handle) * followers * 0.4),
    inventoryPosts: posts,
    inventoryStories: stories,
    notes,
  }
}

function cm(name: string, startDate: string, endDate: string, goal: string, status: CampaignStatus,
            budgetPosts: number, budgetStories: number, budgetReels: number,
            variants: string[], pageHandles: string[]): Campaign {
  return {
    id: slug(name),
    name,
    startDate,
    endDate,
    goal,
    status,
    budgetPosts,
    budgetStories,
    budgetReels,
    approvers: ['Outreach Manager'],
    creativeVariants: variants,
    assignedPageIds: pageHandles.map(slug),
  }
}

function generateSeedPosts(pages: OutreachPage[], campaigns: Campaign[]): Post[] {
  const posts: Post[] = []
  let seq = 0
  for (const c of campaigns) {
    for (const pid of c.assignedPageIds) {
      const page = pages.find(p => p.id === pid)
      if (!page) continue
      // 1–4 posts per (campaign, page) using campaign date range
      const r = seedRand(c.id + pid)
      const count = 1 + Math.floor(r * 4)
      const start = new Date(c.startDate).getTime()
      const end = new Date(c.endDate).getTime()
      for (let i = 0; i < count; i++) {
        const t = start + ((end - start) * (i + 0.5)) / count
        const date = new Date(t).toISOString().slice(0, 10)
        const variant = c.creativeVariants[Math.floor(seedRand(c.id + pid + i) * c.creativeVariants.length)]
        const type: PostType = nameToType(c.name, variant, seedRand(c.id + pid + i + 'type'))
        const isPub = new Date(date).getTime() < Date.now()
        const baseReach = page.followers * (0.05 + seedRand(c.id + pid + i + 'reach') * 0.25)
        posts.push({
          id: `post-${++seq}`,
          date,
          pageId: page.id,
          campaignId: c.id,
          type,
          creativeVariant: variant ?? null,
          caption: `${c.name} — ${variant ?? 'main'} — by @${page.handle}`,
          status: isPub ? 'published' : 'scheduled',
          likes:    Math.floor(baseReach * 0.04),
          comments: Math.floor(baseReach * 0.005),
          views:    type === 'reel' ? Math.floor(baseReach * 3) : Math.floor(baseReach * 0.8),
          saves:    Math.floor(baseReach * 0.01),
          shares:   Math.floor(baseReach * 0.008),
        })
      }
    }
  }
  return posts
}

function nameToType(campaign: string, variant: string | null, r: number): PostType {
  const lc = campaign.toLowerCase()
  if (lc.includes('reel') || variant === 'garud' || variant === 'drone' || variant === 'engine' || variant === 'REMS') return 'reel'
  if (lc.includes('story')) return 'story'
  if (lc.includes('static')) return 'static'
  if (r < 0.6) return 'static'
  if (r < 0.85) return 'reel'
  if (r < 0.95) return 'story'
  return 'carousel'
}

export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60)
}

// Tiny deterministic pseudo-random so seeded values stay stable across reloads.
function seedRand(key: string): number {
  let h = 2166136261
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return ((h >>> 0) % 10_000) / 10_000
}

// ── Store ──────────────────────────────────────────────────────────────────

// Bumped to v2 when PAGE_TYPES changed from outreach/ugc/static → state/pu.
// Old localStorage payloads would carry invalid `type` values and break filters.
const STORAGE_KEY = 'nerve.outreach.v2'

function loadDB(): OutreachDB {
  if (typeof window === 'undefined') return SEED
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return SEED
    const parsed = JSON.parse(raw) as OutreachDB
    if (!parsed.pages || !parsed.campaigns || !parsed.posts) return SEED
    return parsed
  } catch {
    return SEED
  }
}

function persist(db: OutreachDB) {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(db))
}

let store: OutreachDB = loadDB()
const listeners = new Set<() => void>()

function notify() {
  persist(store)
  for (const l of listeners) l()
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

function getSnapshot(): OutreachDB {
  return store
}

export function useOutreachStore() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

// ── Mutators ───────────────────────────────────────────────────────────────

export function resetOutreach() {
  store = SEED
  notify()
}

export function addPage(page: Omit<OutreachPage, 'id'>) {
  const id = slug(page.handle) || `page-${Date.now()}`
  store = { ...store, pages: [...store.pages, { ...page, id }] }
  notify()
}

export function updatePage(id: string, patch: Partial<OutreachPage>) {
  store = { ...store, pages: store.pages.map(p => p.id === id ? { ...p, ...patch } : p) }
  notify()
}

export function addCampaign(campaign: Omit<Campaign, 'id'>) {
  const id = slug(campaign.name) || `c-${Date.now()}`
  store = { ...store, campaigns: [...store.campaigns, { ...campaign, id }] }
  notify()
}

export function updateCampaign(id: string, patch: Partial<Campaign>) {
  store = { ...store, campaigns: store.campaigns.map(c => c.id === id ? { ...c, ...patch } : c) }
  notify()
}

export function addPost(post: Omit<Post, 'id'>) {
  const id = `post-${Date.now()}-${Math.floor(Math.random() * 1000)}`
  store = { ...store, posts: [...store.posts, { ...post, id }] }
  notify()
}

export function addPostsBulk(posts: Omit<Post, 'id'>[]) {
  const stamped = posts.map((p, i) => ({ ...p, id: `post-${Date.now()}-${i}` }))
  store = { ...store, posts: [...store.posts, ...stamped] }
  notify()
}

export function updatePost(id: string, patch: Partial<Post>) {
  store = { ...store, posts: store.posts.map(p => p.id === id ? { ...p, ...patch } : p) }
  notify()
}

export function bulkUpdatePosts(ids: string[], patch: Partial<Post>) {
  const set = new Set(ids)
  store = { ...store, posts: store.posts.map(p => set.has(p.id) ? { ...p, ...patch } : p) }
  notify()
}

export function deletePost(id: string) {
  store = { ...store, posts: store.posts.filter(p => p.id !== id) }
  notify()
}

// ── Derived helpers ────────────────────────────────────────────────────────

export interface PageMetrics {
  postsDoneMTD: number
  storiesDoneMTD: number
  pctConsumed: number
  avgEngagement: number
  lastPostDate: string | null
  status: 'over-used' | 'under-used' | 'on-track' | 'idle'
}

/**
 * Recommended monthly inventory burn for a page.
 * Naive model: pace = total inventory ÷ 12 months, then nudged by recent
 * engagement — pages performing well (>4k avg eng) get +20%, low performers
 * (<500 avg eng) get -30%. Floors at 1 unit.
 */
export function suggestedMonthlyUsage(page: OutreachPage, posts: Post[]): number {
  const total = page.inventoryPosts + page.inventoryStories
  if (total <= 0) return 0
  const m = pageMetrics(page, posts)
  let pace = total / 12
  if (m.avgEngagement >= 4000) pace *= 1.2
  else if (m.avgEngagement > 0 && m.avgEngagement < 500) pace *= 0.7
  return Math.max(1, Math.round(pace))
}

export function pageMetrics(page: OutreachPage, posts: Post[], referenceDate = new Date()): PageMetrics {
  const monthStart = new Date(referenceDate.getFullYear(), referenceDate.getMonth(), 1)
  const pagePosts = posts.filter(p => p.pageId === page.id)
  const mtd = pagePosts.filter(p => new Date(p.date) >= monthStart)
  const postsCount = mtd.filter(p => p.type !== 'story').length
  const storyCount = mtd.filter(p => p.type === 'story').length
  const pctPosts = page.inventoryPosts ? postsCount / page.inventoryPosts : 0
  const pctStories = page.inventoryStories ? storyCount / page.inventoryStories : 0
  const pctConsumed = (pctPosts + pctStories) / 2
  const totalEng = mtd.reduce((s, p) => s + p.likes + p.comments + p.shares + p.saves, 0)
  const avgEngagement = mtd.length ? Math.round(totalEng / mtd.length) : 0
  const last = pagePosts.sort((a, b) => b.date.localeCompare(a.date))[0]
  let status: PageMetrics['status'] = 'on-track'
  if (mtd.length === 0) status = 'idle'
  else if (pctConsumed >= 0.9) status = 'over-used'
  else if (pctConsumed < 0.3) status = 'under-used'
  return { postsDoneMTD: postsCount, storiesDoneMTD: storyCount, pctConsumed, avgEngagement, lastPostDate: last?.date ?? null, status }
}

export interface CampaignMetrics {
  postsDelivered: number
  storiesDelivered: number
  reelsDelivered: number
  totalBudget: number
  pctConsumed: number
  totalEngagement: number
  totalReach: number
}

export function campaignMetrics(campaign: Campaign, posts: Post[]): CampaignMetrics {
  const cp = posts.filter(p => p.campaignId === campaign.id)
  const postsDelivered = cp.filter(p => p.type === 'static' || p.type === 'carousel').length
  const storiesDelivered = cp.filter(p => p.type === 'story').length
  const reelsDelivered = cp.filter(p => p.type === 'reel').length
  const totalBudget = campaign.budgetPosts + campaign.budgetStories + campaign.budgetReels
  const totalDelivered = postsDelivered + storiesDelivered + reelsDelivered
  const pctConsumed = totalBudget ? totalDelivered / totalBudget : 0
  const totalEngagement = cp.reduce((s, p) => s + p.likes + p.comments + p.shares + p.saves, 0)
  const totalReach = cp.reduce((s, p) => s + p.views, 0)
  return { postsDelivered, storiesDelivered, reelsDelivered, totalBudget, pctConsumed, totalEngagement, totalReach }
}

// Backwards-compat helper for components that just want the live data.
export function useOutreachData() {
  const db = useOutreachStore()
  // Force re-render across tab navigations even when localStorage was mutated elsewhere.
  const [, setT] = useState(0)
  useEffect(() => {
    const onStorage = (e: StorageEvent) => { if (e.key === STORAGE_KEY) setT(t => t + 1) }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])
  return db
}
