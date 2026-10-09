/**
 * Shared by the two spreadsheet importers (Import Pages, Import Campaigns) and
 * the New Campaign dialog: resolving a sheet's handle to the page the SERVER
 * knows, and the checks that keep a bad cell from reaching the API as a vague
 * 400 or a 500.
 */
import { api } from '@/lib/api'
import { HttpError } from '@/lib/http'
import type { OutreachPage, PageType, FollowerTier } from '@/lib/outreach-data'
import { canonicalState } from '@/lib/outreach-states'

/**
 * Highest budget the forms accept. The column is a Postgres INTEGER, so
 * anything past 2^31-1 used to come back as "Internal server error."; no real
 * campaign comes near this, so a typo is caught long before that.
 */
export const MAX_BUDGET = 100_000

/** A budget input's value as a whole number in 0..MAX_BUDGET ("1.5" → 1, "" → 0). */
export function toBudget(raw: string | number): number {
  const n = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.min(Math.floor(n), MAX_BUDGET)
}

/** Why a budget the sheet gave cannot be saved, or null when it can. */
export function budgetProblem(label: string, n: number): string | null {
  if (!Number.isInteger(n) || n < 0) return `${label} budget must be a whole number.`
  if (n > MAX_BUDGET) return `${label} budget ${n} is more than ${MAX_BUDGET.toLocaleString('en-IN')}.`
  return null
}

/**
 * True for a YYYY-MM-DD that names a day on the calendar. The server only
 * checks the shape, so "2026-02-31" used to reach Postgres and come back as a
 * bare "Internal server error." for the whole campaign.
 */
export function isRealIsoDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (!m) return false
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const date = new Date(Date.UTC(y, mo - 1, d))
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d
}

/** A handle the way the server compares them: case-insensitive, no leading @. */
export function handleKey(handle: string): string {
  return handle.trim().replace(/^@+/, '').toLowerCase()
}

/** handle → page id for the Instagram pages already in the ledger. */
export function instagramPageIndex(pages: Pick<OutreachPage, 'id' | 'handle' | 'platform'>[]): Map<string, string> {
  return new Map(pages.filter(p => p.platform !== 'facebook').map(p => [handleKey(p.handle), p.id]))
}

/** A new page needs both; the server rejects either one blank. */
export class PageNeedsPlaceError extends Error {
  constructor(readonly handle: string) {
    super(`@${handle} is not in the ledger yet, and a new page needs a geography and a state.`)
    this.name = 'PageNeedsPlaceError'
  }
}

/**
 * A new page whose sheet state matches nothing on the master list (PRD 6.4).
 * Reported for that row, by name, instead of the server's 400 for the whole
 * row — or, before states were checked, being stored as one more spelling.
 */
export class PageStateUnknownError extends Error {
  constructor(readonly handle: string, readonly state: string) {
    super(`@${handle} is not in the ledger yet, and "${state}" is not an Indian state or union territory — choose one from the list.`)
    this.name = 'PageStateUnknownError'
  }
}

export interface ImportedPage {
  handle: string
  geography: string
  state: string
  type: PageType
  followerTier: FollowerTier
  inventoryPosts: number
  inventoryStories: number
  notes: string
}

/**
 * The id of the page for `input.handle`, creating it when the ledger does not
 * have it. `known` (from instagramPageIndex) is read and kept up to date, so a
 * handle that appears twice in one sheet is created once.
 *
 * The id always comes from the server. The importers used to assume it was
 * slug(handle), but the server suffixes an id that is already taken
 * ("fix.dup" and "fix_dup" both slug to "fix-dup"), so that guess wired the
 * campaign to some other page. A 409 means the page exists already — the
 * store was stale — and is reused rather than reported as a failure.
 *
 * Does not refresh the outreach store; call refreshOutreach() once at the end.
 */
export async function ensureInstagramPage(
  input: ImportedPage,
  known: Map<string, string>,
): Promise<{ id: string; created: boolean }> {
  const handle = input.handle.trim().replace(/^@+/, '')
  const key = handleKey(handle)
  const hit = known.get(key)
  if (hit) return { id: hit, created: false }

  const geography = input.geography.trim()
  if (!geography || !input.state.trim()) throw new PageNeedsPlaceError(handle)
  // "gujarat " or "Tamilnadu" is the canonical state; "Guj" is reported.
  const state = canonicalState(input.state)
  if (!state) throw new PageStateUnknownError(handle, input.state.trim())

  try {
    const { page } = await api.createOutreachPage({
      handle,
      platform: 'instagram',
      geography,
      state,
      type: input.type,
      follower_tier: input.followerTier,
      content_types: [],
      content_preferences: [],
      followers: 0,
      inventory_posts: input.inventoryPosts,
      inventory_stories: input.inventoryStories,
      notes: input.notes,
    })
    known.set(key, page.id)
    return { id: page.id, created: true }
  } catch (err) {
    if (!(err instanceof HttpError && err.status === 409)) throw err
    const { pages } = await api.listOutreachPages()
    const existing = pages.find(p => p.platform !== 'facebook' && handleKey(p.handle) === key)
    if (!existing) throw err
    known.set(key, existing.id)
    return { id: existing.id, created: false }
  }
}
