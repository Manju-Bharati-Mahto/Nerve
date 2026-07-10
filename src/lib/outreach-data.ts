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
import { api, type ServerOutreachPage, type ServerOutreachCreator, type ServerOutreachCampaign, type ServerOutreachPost } from './api'

// ── Types (camelCase, frontend-facing) ─────────────────────────────────────

export const PAGE_TYPES = ['state', 'pu'] as const
export type PageType = typeof PAGE_TYPES[number]

export const POST_TYPES = ['static', 'reel', 'story', 'carousel'] as const
export type PostType = typeof POST_TYPES[number]

export const POST_STATUSES = ['draft', 'scheduled', 'pending_approval', 'published'] as const
export type PostStatus = typeof POST_STATUSES[number]

export const CAMPAIGN_STATUSES = ['planning', 'active', 'completed', 'paused'] as const
export type CampaignStatus = typeof CAMPAIGN_STATUSES[number]

export const FOLLOWER_TIERS = ['1', '2', '3', '4', '5'] as const
export type FollowerTier = typeof FOLLOWER_TIERS[number]

export const PAGE_CONTENT_TYPES = ['static', 'reel', 'carousel'] as const
export type PageContentType = typeof PAGE_CONTENT_TYPES[number]

export interface OutreachPage {
  id: string
  handle: string
  geography: string
  state: string
  type: PageType
  followerTier: FollowerTier
  contentTypes: PageContentType[]
  followers: number
  inventoryPosts: number
  inventoryStories: number
  notes: string
  lastSyncedAt: string | null
}

// Creators have the same shape as pages today but live in their own table —
// they don't show up in the All Pages ledger and have their own list view.
export interface OutreachCreator {
  id: string
  handle: string
  geography: string
  state: string
  type: PageType
  followerTier: FollowerTier
  contentTypes: PageContentType[]
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
  // State this campaign targets (e.g. "Gujarat"). Empty = unscoped.
  state: string
  goal: string
  status: CampaignStatus
  budgetPosts: number
  budgetStories: number
  budgetReels: number
  approvers: string[]
  creativeVariants: string[]
  assignedPageIds: string[]
  assignedCreatorIds: string[]
}

export interface Post {
  id: string
  date: string
  // Exactly one of pageId / creatorId is set. Mirrors the DB CHECK constraint.
  pageId: string | null
  creatorId: string | null
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
  // True when explicitly added via AddLivePostsDialog. Page analytics +
  // inventory only count these — auto-synced posts are excluded.
  addedAsLive: boolean
}

interface OutreachDB {
  pages: OutreachPage[]
  creators: OutreachCreator[]
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
    contentTypes: Array.isArray(p.content_types) ? p.content_types : [],
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
    content_types: p.contentTypes,
    followers: p.followers,
    inventory_posts: p.inventoryPosts,
    inventory_stories: p.inventoryStories,
    notes: p.notes,
  }
}

function toCreator(c: ServerOutreachCreator): OutreachCreator {
  return {
    id: c.id,
    handle: c.handle,
    geography: c.geography,
    state: c.state,
    type: c.type,
    followerTier: c.follower_tier,
    contentTypes: Array.isArray(c.content_types) ? c.content_types : [],
    followers: c.followers,
    inventoryPosts: c.inventory_posts,
    inventoryStories: c.inventory_stories,
    notes: c.notes,
    lastSyncedAt: c.last_synced_at,
  }
}

function fromCreator(c: Omit<OutreachCreator, 'id' | 'lastSyncedAt'> & Partial<Pick<OutreachCreator, 'id' | 'lastSyncedAt'>>): Partial<ServerOutreachCreator> {
  return {
    handle: c.handle,
    geography: c.geography,
    state: c.state,
    type: c.type,
    follower_tier: c.followerTier,
    content_types: c.contentTypes,
    followers: c.followers,
    inventory_posts: c.inventoryPosts,
    inventory_stories: c.inventoryStories,
    notes: c.notes,
  }
}

function toCampaign(c: ServerOutreachCampaign): Campaign {
  return {
    id: c.id,
    name: c.name,
    startDate: c.start_date,
    endDate: c.end_date,
    state: c.state ?? '',
    goal: c.goal,
    status: c.status,
    budgetPosts: c.budget_posts,
    budgetStories: c.budget_stories,
    budgetReels: c.budget_reels,
    approvers: c.approvers,
    creativeVariants: c.creative_variants,
    assignedPageIds: c.assigned_page_ids,
    // Pre-creator-split campaigns won't have this field; default to empty so
    // existing rows render correctly.
    assignedCreatorIds: Array.isArray(c.assigned_creator_ids) ? c.assigned_creator_ids : [],
  }
}

function fromCampaign(c: Omit<Campaign, 'id'> & Partial<Pick<Campaign, 'id'>>): Partial<ServerOutreachCampaign> {
  return {
    name: c.name,
    start_date: c.startDate,
    end_date: c.endDate,
    state: c.state,
    goal: c.goal,
    status: c.status,
    budget_posts: c.budgetPosts,
    budget_stories: c.budgetStories,
    budget_reels: c.budgetReels,
    approvers: c.approvers,
    creative_variants: c.creativeVariants,
    assigned_page_ids: c.assignedPageIds,
    assigned_creator_ids: c.assignedCreatorIds,
  }
}

function toPost(p: ServerOutreachPost): Post {
  return {
    id: p.id,
    date: p.date,
    pageId: p.page_id,
    creatorId: p.creator_id,
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
    addedAsLive: (p as ServerOutreachPost & { added_as_live?: boolean }).added_as_live ?? false,
  }
}

// ── In-memory store with subscribers ───────────────────────────────────────

let store: OutreachDB = { pages: [], creators: [], campaigns: [], posts: [], loaded: false, loading: false, error: null }
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
    const [{ pages }, { creators }, { campaigns }, { posts }] = await Promise.all([
      api.listOutreachPages(),
      api.listOutreachCreators(),
      api.listOutreachCampaigns(),
      api.listOutreachPosts(),
    ])
    setStore({
      pages: pages.map(toPage),
      creators: creators.map(toCreator),
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
  if (patch.contentTypes !== undefined) serverPatch.content_types = patch.contentTypes
  if (patch.followers !== undefined) serverPatch.followers = patch.followers
  if (patch.inventoryPosts !== undefined) serverPatch.inventory_posts = patch.inventoryPosts
  if (patch.inventoryStories !== undefined) serverPatch.inventory_stories = patch.inventoryStories
  if (patch.notes !== undefined) serverPatch.notes = patch.notes
  await api.updateOutreachPage(id, serverPatch)
  await fetchAll()
}

export async function addCampaign(campaign: Omit<Campaign, 'id'>): Promise<Campaign> {
  const { campaign: created } = await api.createOutreachCampaign(fromCampaign(campaign))
  await fetchAll()
  return toCampaign(created)
}

/**
 * Deletes a campaign and refreshes the store. Posts that were attributed to
 * the campaign survive (the FK is ON DELETE SET NULL) — their `campaignId`
 * becomes null so they appear as unattributed on dashboards/analytics.
 */
export async function removeCampaign(id: string) {
  await api.deleteOutreachCampaign(id)
  await fetchAll()
}

/**
 * Deletes a page and refreshes the store. CASCADES to outreach_posts so any
 * posts tied to this page are removed too. There is no undo.
 */
export async function removePage(id: string) {
  await api.deleteOutreachPage(id)
  await fetchAll()
}

export async function updateCampaign(id: string, patch: Partial<Campaign>) {
  const serverPatch: Partial<ServerOutreachCampaign> = {}
  if (patch.name !== undefined) serverPatch.name = patch.name
  if (patch.startDate !== undefined) serverPatch.start_date = patch.startDate
  if (patch.endDate !== undefined) serverPatch.end_date = patch.endDate
  if (patch.state !== undefined) serverPatch.state = patch.state
  if (patch.goal !== undefined) serverPatch.goal = patch.goal
  if (patch.status !== undefined) serverPatch.status = patch.status
  if (patch.budgetPosts !== undefined) serverPatch.budget_posts = patch.budgetPosts
  if (patch.budgetStories !== undefined) serverPatch.budget_stories = patch.budgetStories
  if (patch.budgetReels !== undefined) serverPatch.budget_reels = patch.budgetReels
  if (patch.approvers !== undefined) serverPatch.approvers = patch.approvers
  if (patch.creativeVariants !== undefined) serverPatch.creative_variants = patch.creativeVariants
  if (patch.assignedPageIds !== undefined) serverPatch.assigned_page_ids = patch.assignedPageIds
  if (patch.assignedCreatorIds !== undefined) serverPatch.assigned_creator_ids = patch.assignedCreatorIds
  await api.updateOutreachCampaign(id, serverPatch)
  await fetchAll()
}

// ── Creator mutators ──────────────────────────────────────────────────────

export async function addCreator(creator: Omit<OutreachCreator, 'id' | 'lastSyncedAt'>): Promise<OutreachCreator> {
  const { creator: created } = await api.createOutreachCreator(fromCreator(creator))
  await fetchAll()
  return toCreator(created)
}

export async function updateCreator(id: string, patch: Partial<Omit<OutreachCreator, 'id'>>) {
  const serverPatch: Partial<ServerOutreachCreator> = {}
  if (patch.handle !== undefined) serverPatch.handle = patch.handle
  if (patch.geography !== undefined) serverPatch.geography = patch.geography
  if (patch.state !== undefined) serverPatch.state = patch.state
  if (patch.type !== undefined) serverPatch.type = patch.type
  if (patch.followerTier !== undefined) serverPatch.follower_tier = patch.followerTier
  if (patch.contentTypes !== undefined) serverPatch.content_types = patch.contentTypes
  if (patch.followers !== undefined) serverPatch.followers = patch.followers
  if (patch.inventoryPosts !== undefined) serverPatch.inventory_posts = patch.inventoryPosts
  if (patch.inventoryStories !== undefined) serverPatch.inventory_stories = patch.inventoryStories
  if (patch.notes !== undefined) serverPatch.notes = patch.notes
  await api.updateOutreachCreator(id, serverPatch)
  await fetchAll()
}

export async function removeCreator(id: string) {
  await api.deleteOutreachCreator(id)
  await fetchAll()
}

export async function addPostsBulk(posts: Omit<Post, 'id'>[]) {
  if (posts.length === 0) return
  const payload: Partial<ServerOutreachPost>[] = posts.map(p => ({
    page_id: p.pageId ?? null,
    creator_id: p.creatorId ?? null,
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

/**
 * Re-scrapes the reach/views of every tracked live post across all pages
 * (on-demand; no profile scrape). Refetches the store so dashboards/tables
 * pick up the fresh numbers.
 */
export async function refreshReachNow() {
  const result = await api.refreshOutreachReach()
  await fetchAll()
  return result
}

// ── Dismissed alerts (client-only, persisted per browser) ──────────────────
// Alerts are derived (recomputed each render), so "dismiss" is a local
// acknowledgement stored in localStorage keyed by the alert's stable id
// (`${campaignId}:${subjectId}`). Adding the missing post still auto-clears the
// alert regardless of dismissal, since it drops out of computeOutreachAlerts.
const DISMISSED_ALERTS_KEY = 'outreach.dismissedAlerts'

export function getDismissedAlertIds(): Set<string> {
  try {
    const raw = localStorage.getItem(DISMISSED_ALERTS_KEY)
    return new Set(raw ? (JSON.parse(raw) as string[]) : [])
  } catch { return new Set() }
}

/** Marks an alert dismissed and returns the updated set (for React state). */
export function dismissAlert(id: string): Set<string> {
  const ids = getDismissedAlertIds()
  ids.add(id)
  try { localStorage.setItem(DISMISSED_ALERTS_KEY, JSON.stringify([...ids])) } catch { /* storage unavailable */ }
  return ids
}

/**
 * Pulls metrics for specific Instagram post/reel URLs and persists them under
 * either a page (campaign required) or a creator (campaign optional). Returns
 * the saved posts plus any URLs that were skipped (bad URL, owner mismatch,
 * Apify failure). Triggers a store refetch so dashboards / analytics pick up
 * the new rows.
 */
export async function addLivePostsByUrl(args: {
  urls: string[]
  pageId?: string
  creatorId?: string
  campaignId?: string
  creativeVariant?: string
}) {
  const result = await api.fetchOutreachPostsByUrls({
    urls: args.urls,
    page_id: args.pageId,
    creator_id: args.creatorId,
    campaign_id: args.campaignId,
    creative_variant: args.creativeVariant,
  })
  await fetchAll()
  return {
    ok: result.ok,
    posts: result.posts.map(toPost),
    skipped: result.skipped,
  }
}

// ── Pure helpers — used by analytics widgets, no store state ───────────────

export interface PageMetrics {
  /** All-time count of posts (non-story) the team has placed on this page. */
  postsDone: number
  /** All-time count of stories placed on this page. */
  storiesDone: number
  pctConsumed: number
  avgEngagement: number
  lastPostDate: string | null
  status: 'over-used' | 'under-used' | 'on-track' | 'idle'
}

export function pageMetrics(page: OutreachPage, posts: Post[]): PageMetrics {
  // Analytics + inventory only count posts explicitly added via AddLivePostsDialog
  // (server: addLivePosts). Auto-synced Apify posts are excluded so the figures
  // reflect what the team has actually placed, not what the page ran on IG.
  //
  // "Consumed" is LIFETIME, not month-to-date: inventory is a fixed capacity the
  // team draws down as it places posts, so every added live post counts toward
  // consumption regardless of its publish month. (A post added for a campaign
  // that ran last month must still show as consumed.)
  const pagePosts = posts.filter(p => p.pageId === page.id && p.addedAsLive)
  const postsCount = pagePosts.filter(p => p.type !== 'story').length
  const storyCount = pagePosts.filter(p => p.type === 'story').length
  const pctPosts = page.inventoryPosts ? postsCount / page.inventoryPosts : 0
  const pctStories = page.inventoryStories ? storyCount / page.inventoryStories : 0
  const pctConsumed = (pctPosts + pctStories) / 2
  // Apify can't read saves/shares, so engagement here is likes + comments only.
  const totalEng = pagePosts.reduce((s, p) => s + p.likes + p.comments, 0)
  const avgEngagement = pagePosts.length ? Math.round(totalEng / pagePosts.length) : 0
  const last = [...pagePosts].sort((a, b) => b.date.localeCompare(a.date))[0]
  let status: PageMetrics['status'] = 'on-track'
  if (pagePosts.length === 0) status = 'idle'
  else if (pctConsumed >= 0.9) status = 'over-used'
  else if (pctConsumed < 0.3) status = 'under-used'
  return { postsDone: postsCount, storiesDone: storyCount, pctConsumed, avgEngagement, lastPostDate: last?.date ?? null, status }
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
  // Only operator-added live posts count toward a campaign's delivery/reach —
  // the profile sync auto-attributes backlog posts by caption match, and those
  // must not inflate "post completion" or analytics.
  const cp = posts.filter(p => p.campaignId === campaign.id && p.addedAsLive)
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
  // Suggestion is for posts only — stories are excluded from the pacing target.
  if (page.inventoryPosts <= 0) return 0
  const m = pageMetrics(page, posts)
  let pace = page.inventoryPosts / 12
  if (m.avgEngagement >= 4000) pace *= 1.2
  else if (m.avgEngagement > 0 && m.avgEngagement < 500) pace *= 0.7
  return Math.max(1, Math.round(pace))
}

export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60)
}

/**
 * Normalises a handle input: accepts a bare username, `@username`, or any
 * Instagram URL form (instagram.com/username, with/without protocol, with
 * trailing path / querystring) and returns the canonical handle.
 *
 * Returns empty string if nothing usable can be extracted.
 */
export function parseInstagramHandle(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) return ''
  // URL form — pull the first path segment after instagram.com.
  const urlMatch = trimmed.match(/instagram\.com\/([^/?#\s]+)/i)
  if (urlMatch) return urlMatch[1].replace(/^@/, '')
  // Bare handle (allow leading @, strip query / path leftovers just in case).
  return trimmed.replace(/^@/, '').split(/[/?#\s]/)[0]
}

/** Returns the public Instagram profile URL for a handle. */
export function instagramUrlForHandle(handle: string): string {
  const h = handle.trim().replace(/^@/, '')
  return `https://www.instagram.com/${encodeURIComponent(h)}/`
}

/**
 * Returns true if `handle` is a syntactically valid Instagram username.
 * Legacy seed entries that contained spaces or other display-only text
 * fail this check, so callers can hide a broken "Open on Instagram" link.
 */
export function isValidInstagramHandle(handle: string): boolean {
  return /^[A-Za-z0-9._]{1,30}$/.test(handle.trim().replace(/^@/, ''))
}

/**
 * Formats a Date as a local-time YYYY-MM-DD string. Important: `toISOString`
 * uses UTC, which shifts the day by ±1 in non-UTC timezones (e.g. IST).
 * Every date bucket in this domain (post.date, campaign dates) is a local
 * calendar day, so we must format in local time to compare correctly.
 */
export function formatLocalDate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// ── State-wise filtering (Dashboard / Analytics) ───────────────────────────

/** Canonical state list used to seed the "State" dropdowns when adding a
 *  campaign / page. The live filters union this with whatever states already
 *  exist on records, so a new state typed by hand still shows up. */
export const INDIAN_STATES = [
  'Gujarat', 'Maharashtra', 'Madhya Pradesh', 'Bihar', 'Rajasthan', 'Assam',
  'Uttar Pradesh', 'Goa', 'Delhi', 'Karnataka', 'Tamil Nadu', 'West Bengal',
  'Punjab', 'Haryana', 'Kerala', 'Telangana', 'Andhra Pradesh', 'Odisha',
  'Jharkhand', 'Chhattisgarh', 'Uttarakhand', 'Himachal Pradesh',
] as const

/** Distinct, sorted list of states actually in use across pages + campaigns. */
export function outreachStates(pages: OutreachPage[], campaigns: Campaign[]): string[] {
  const set = new Set<string>()
  for (const p of pages) if (p.state) set.add(p.state)
  for (const c of campaigns) if (c.state) set.add(c.state)
  return Array.from(set).sort()
}

/** Returns the state a post should be attributed to — its page's state, or its
 *  creator's state. Empty string when the subject has no state set. */
export function buildPostStateLookup(
  pages: OutreachPage[],
  creators: OutreachCreator[],
): (post: Post) => string {
  const pm = new Map(pages.map(p => [p.id, p.state]))
  const cm = new Map(creators.map(c => [c.id, c.state]))
  return (post) =>
    post.pageId ? (pm.get(post.pageId) ?? '')
      : post.creatorId ? (cm.get(post.creatorId) ?? '')
      : ''
}

// ── Aggregate totals (Dashboard summary cards) ─────────────────────────────

export interface OutreachTotals {
  reach: number
  views: number
  likes: number
  comments: number
  shares: number
  engagement: number
  posts: number
}

/**
 * Sums the five headline metrics across the given posts. Note: the public
 * Instagram scrape only exposes plays/likes/comments — `reach` is proxied by
 * post views (plays) and `shares` is 0 unless explicitly recorded. Engagement
 * is likes + comments (the metrics we can actually read).
 */
export function aggregateTotals(posts: Post[]): OutreachTotals {
  let views = 0, likes = 0, comments = 0, shares = 0
  for (const p of posts) { views += p.views; likes += p.likes; comments += p.comments; shares += p.shares }
  return { reach: views, views, likes, comments, shares, engagement: likes + comments, posts: posts.length }
}

// ── Campaign date status (Calendar colour-coding) ──────────────────────────

export type CampaignDateStatus = 'upcoming' | 'active' | 'completed'

/**
 * Date-derived status used by the calendar. Per spec: a campaign turns GREEN
 * (completed) once its end date has passed, is YELLOW (active) while live, and
 * neutral (upcoming) before it starts. Independent of the manually-set
 * `campaign.status` so the calendar updates automatically as time passes.
 */
export function campaignDateStatus(c: Campaign, ref = new Date()): CampaignDateStatus {
  const today = formatLocalDate(ref)
  if (c.startDate && today < c.startDate) return 'upcoming'
  if (c.endDate && today > c.endDate) return 'completed'
  return 'active'
}

/** Set of every page id assigned to at least one campaign (inventory "in use"). */
export function assignedPageIdSet(campaigns: Campaign[]): Set<string> {
  const s = new Set<string>()
  for (const c of campaigns) for (const id of c.assignedPageIds) s.add(id)
  return s
}

// ── Alerts: 24h "page assigned but no post yet" rule ───────────────────────

export interface OutreachAlert {
  /** Stable id = `${campaignId}:${subjectId}` so list keys stay consistent. */
  id: string
  campaignId: string
  campaignName: string
  subjectId: string
  subjectKind: 'page' | 'creator'
  handle: string
  /** Whole hours elapsed since the 24h-after-start deadline passed. */
  hoursOverdue: number
}

/**
 * Computes the standing alerts: for every campaign whose start date is more
 * than 24h in the past, each assigned page/creator that still has no live post
 * attributed to that campaign is overdue. Resolves automatically once a post
 * link is added for that subject. Completed campaigns are excluded.
 */
export function computeOutreachAlerts(
  campaigns: Campaign[],
  pages: OutreachPage[],
  creators: OutreachCreator[],
  posts: Post[],
  ref = new Date(),
): OutreachAlert[] {
  const out: OutreachAlert[] = []
  const now = ref.getTime()
  const pageById = new Map(pages.map(p => [p.id, p]))
  const creatorById = new Map(creators.map(c => [c.id, c]))
  for (const c of campaigns) {
    if (!c.startDate || c.status === 'completed') continue
    // Local midnight of the start date + 24h grace window.
    const deadline = new Date(`${c.startDate}T00:00:00`).getTime() + 24 * 3600_000
    if (Number.isNaN(deadline) || now < deadline) continue
    const hoursOverdue = Math.floor((now - deadline) / 3600_000)
    for (const pid of c.assignedPageIds) {
      const page = pageById.get(pid)
      if (!page) continue
      const posted = posts.some(p => p.pageId === pid && p.campaignId === c.id && p.addedAsLive)
      if (!posted) out.push({ id: `${c.id}:${pid}`, campaignId: c.id, campaignName: c.name, subjectId: pid, subjectKind: 'page', handle: page.handle, hoursOverdue })
    }
    for (const cid of c.assignedCreatorIds) {
      const creator = creatorById.get(cid)
      if (!creator) continue
      const posted = posts.some(p => p.creatorId === cid && p.campaignId === c.id && p.addedAsLive)
      if (!posted) out.push({ id: `${c.id}:${cid}`, campaignId: c.id, campaignName: c.name, subjectId: cid, subjectKind: 'creator', handle: creator.handle, hoursOverdue })
    }
  }
  return out.sort((a, b) => b.hoursOverdue - a.hoursOverdue)
}
