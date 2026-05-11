/**
 * Outreach domain data — pages, campaigns, posts.
 *
 * Backed by the server (/api/outreach/*). The in-memory store is hydrated
 * on first `useOutreachData()` call and refreshed after every mutation.
 * Components consume camelCase shapes; we translate to/from the server's
 * snake_case at the boundary.
 *
 * No seed data lives here on purpose — the server seeds the page directory
 * once on first boot, and metrics come from the Apify sync.
 */
import { useEffect, useSyncExternalStore } from 'react'
import { api, type ServerOutreachPage, type ServerOutreachCampaign, type ServerOutreachPost } from './api'

// ── Types (camelCase, frontend-facing) ─────────────────────────────────────

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
  geography: string
  state: string
  type: PageType
  followerTier: FollowerTier
  followers: number
  inventoryPosts: number
  inventoryStories: number
  notes: string
  lastSyncedAt: string | null
}

export interface Campaign {
  id: string
  name: string
  startDate: string
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
  date: string
  pageId: string
  campaignId: string | null
  type: PostType
  creativeVariant: string | null
  caption: string
  status: PostStatus
  likes: number
  comments: number
  views: number
  saves: number
  shares: number
  mediaUrl?: string | null
  permalink?: string | null
}

interface OutreachDB {
  pages: OutreachPage[]
  campaigns: Campaign[]
  posts: Post[]
  loaded: boolean
  loading: boolean
  error: string | null
}

// ── Translation layer ──────────────────────────────────────────────────────

function toPage(p: ServerOutreachPage): OutreachPage {
  return {
    id: p.id,
    handle: p.handle,
    geography: p.geography,
    state: p.state,
    type: p.type,
    followerTier: p.follower_tier,
    followers: p.followers,
    inventoryPosts: p.inventory_posts,
    inventoryStories: p.inventory_stories,
    notes: p.notes,
    lastSyncedAt: p.last_synced_at,
  }
}

function fromPage(p: Omit<OutreachPage, 'id' | 'lastSyncedAt'> & Partial<Pick<OutreachPage, 'id' | 'lastSyncedAt'>>): Partial<ServerOutreachPage> {
  return {
    handle: p.handle,
    geography: p.geography,
    state: p.state,
    type: p.type,
    follower_tier: p.followerTier,
    followers: p.followers,
    inventory_posts: p.inventoryPosts,
    inventory_stories: p.inventoryStories,
    notes: p.notes,
  }
}

function toCampaign(c: ServerOutreachCampaign): Campaign {
  return {
    id: c.id,
    name: c.name,
    startDate: c.start_date,
    endDate: c.end_date,
    goal: c.goal,
    status: c.status,
    budgetPosts: c.budget_posts,
    budgetStories: c.budget_stories,
    budgetReels: c.budget_reels,
    approvers: c.approvers,
    creativeVariants: c.creative_variants,
    assignedPageIds: c.assigned_page_ids,
  }
}

function fromCampaign(c: Omit<Campaign, 'id'> & Partial<Pick<Campaign, 'id'>>): Partial<ServerOutreachCampaign> {
  return {
    name: c.name,
    start_date: c.startDate,
    end_date: c.endDate,
    goal: c.goal,
    status: c.status,
    budget_posts: c.budgetPosts,
    budget_stories: c.budgetStories,
    budget_reels: c.budgetReels,
    approvers: c.approvers,
    creative_variants: c.creativeVariants,
    assigned_page_ids: c.assignedPageIds,
  }
}

function toPost(p: ServerOutreachPost): Post {
  return {
    id: p.id,
    date: p.date,
    pageId: p.page_id,
    campaignId: p.campaign_id,
    type: p.type,
    creativeVariant: p.creative_variant,
    caption: p.caption,
    status: p.status,
    likes: p.likes,
    comments: p.comments,
    views: p.views,
    saves: p.saves,
    shares: p.shares,
    mediaUrl: p.media_url,
    permalink: p.permalink,
  }
}

// ── In-memory store with subscribers ───────────────────────────────────────

let store: OutreachDB = { pages: [], campaigns: [], posts: [], loaded: false, loading: false, error: null }
const listeners = new Set<() => void>()

function setStore(patch: Partial<OutreachDB>) {
  store = { ...store, ...patch }
  for (const l of listeners) l()
}

function subscribe(cb: () => void) {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

function getSnapshot(): OutreachDB {
  return store
}

async function fetchAll() {
  setStore({ loading: true, error: null })
  try {
    const [{ pages }, { campaigns }, { posts }] = await Promise.all([
      api.listOutreachPages(),
      api.listOutreachCampaigns(),
      api.listOutreachPosts(),
    ])
    setStore({
      pages: pages.map(toPage),
      campaigns: campaigns.map(toCampaign),
      posts: posts.map(toPost),
      loaded: true,
      loading: false,
      error: null,
    })
  } catch (err) {
    setStore({ loading: false, error: err instanceof Error ? err.message : 'Failed to load outreach data.' })
  }
}

let inflight: Promise<void> | null = null
function ensureLoaded() {
  if (store.loaded || inflight) return
  inflight = fetchAll().finally(() => { inflight = null })
}

export function useOutreachStore() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/** Hook every outreach page uses. Hydrates from API on first mount. */
export function useOutreachData() {
  const db = useOutreachStore()
  useEffect(() => { ensureLoaded() }, [])
  return db
}

/** Force a refetch — useful after a sync to pick up fresh data. */
export function refreshOutreach() {
  return fetchAll()
}

// ── Mutators (async; refetch on success) ───────────────────────────────────

export async function addPage(page: Omit<OutreachPage, 'id' | 'lastSyncedAt'>) {
  await api.createOutreachPage(fromPage(page))
  await fetchAll()
}

export async function updatePage(id: string, patch: Partial<Omit<OutreachPage, 'id'>>) {
  const serverPatch: Partial<ServerOutreachPage> = {}
  if (patch.handle !== undefined) serverPatch.handle = patch.handle
  if (patch.geography !== undefined) serverPatch.geography = patch.geography
  if (patch.state !== undefined) serverPatch.state = patch.state
  if (patch.type !== undefined) serverPatch.type = patch.type
  if (patch.followerTier !== undefined) serverPatch.follower_tier = patch.followerTier
  if (patch.followers !== undefined) serverPatch.followers = patch.followers
  if (patch.inventoryPosts !== undefined) serverPatch.inventory_posts = patch.inventoryPosts
  if (patch.inventoryStories !== undefined) serverPatch.inventory_stories = patch.inventoryStories
  if (patch.notes !== undefined) serverPatch.notes = patch.notes
  await api.updateOutreachPage(id, serverPatch)
  await fetchAll()
}

export async function addCampaign(campaign: Omit<Campaign, 'id'>) {
  await api.createOutreachCampaign(fromCampaign(campaign))
  await fetchAll()
}

export async function updateCampaign(id: string, patch: Partial<Campaign>) {
  const serverPatch: Partial<ServerOutreachCampaign> = {}
  if (patch.name !== undefined) serverPatch.name = patch.name
  if (patch.startDate !== undefined) serverPatch.start_date = patch.startDate
  if (patch.endDate !== undefined) serverPatch.end_date = patch.endDate
  if (patch.goal !== undefined) serverPatch.goal = patch.goal
  if (patch.status !== undefined) serverPatch.status = patch.status
  if (patch.budgetPosts !== undefined) serverPatch.budget_posts = patch.budgetPosts
  if (patch.budgetStories !== undefined) serverPatch.budget_stories = patch.budgetStories
  if (patch.budgetReels !== undefined) serverPatch.budget_reels = patch.budgetReels
  if (patch.approvers !== undefined) serverPatch.approvers = patch.approvers
  if (patch.creativeVariants !== undefined) serverPatch.creative_variants = patch.creativeVariants
  if (patch.assignedPageIds !== undefined) serverPatch.assigned_page_ids = patch.assignedPageIds
  await api.updateOutreachCampaign(id, serverPatch)
  await fetchAll()
}

export async function addPostsBulk(posts: Omit<Post, 'id'>[]) {
  if (posts.length === 0) return
  const payload: Partial<ServerOutreachPost>[] = posts.map(p => ({
    page_id: p.pageId,
    campaign_id: p.campaignId,
    date: p.date,
    type: p.type,
    creative_variant: p.creativeVariant,
    caption: p.caption,
    status: p.status,
  }))
  await api.createOutreachPosts(payload)
  await fetchAll()
}

/** Triggers a server-side Apify sync for the given handles (or all pages). */
export async function syncNow(handles?: string[]) {
  const result = await api.syncOutreach(handles)
  await fetchAll()
  return result
}

// ── Pure helpers — used by analytics widgets, no store state ───────────────

export interface PageMetrics {
  postsDoneMTD: number
  storiesDoneMTD: number
  pctConsumed: number
  avgEngagement: number
  lastPostDate: string | null
  status: 'over-used' | 'under-used' | 'on-track' | 'idle'
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
  // Apify can't read saves/shares, so engagement here is likes + comments only.
  const totalEng = mtd.reduce((s, p) => s + p.likes + p.comments, 0)
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
  const totalEngagement = cp.reduce((s, p) => s + p.likes + p.comments, 0)
  const totalReach = cp.reduce((s, p) => s + p.views, 0)
  return { postsDelivered, storiesDelivered, reelsDelivered, totalBudget, pctConsumed, totalEngagement, totalReach }
}

export function suggestedMonthlyUsage(page: OutreachPage, posts: Post[]): number {
  const total = page.inventoryPosts + page.inventoryStories
  if (total <= 0) return 0
  const m = pageMetrics(page, posts)
  let pace = total / 12
  if (m.avgEngagement >= 4000) pace *= 1.2
  else if (m.avgEngagement > 0 && m.avgEngagement < 500) pace *= 0.7
  return Math.max(1, Math.round(pace))
}

export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60)
}
