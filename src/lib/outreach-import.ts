/**
 * Spreadsheet import helpers for the outreach Pages / Campaigns bulk uploaders.
 *
 * Reads the first sheet of an .xlsx / .xls / .csv file into header-keyed row
 * objects. Column matching is fuzzy (see `pick`) so the team can upload their
 * existing sheets without renaming columns to an exact template.
 */
import * as XLSX from 'xlsx'
import { parseInstagramHandle } from './outreach-data'

export interface ParsedSheet {
  headers: string[]
  rows: Record<string, string>[]
}

export async function parseSpreadsheet(file: File): Promise<ParsedSheet> {
  const buf = await file.arrayBuffer()
  const wb = XLSX.read(buf, { type: 'array' })
  const first = wb.SheetNames[0]
  if (!first) return { headers: [], rows: [] }
  const sheet = wb.Sheets[first]
  const json = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '' })
  // Union of keys across rows — xlsx omits a key on a row when that cell is the
  // last column and empty, so row 0's keys alone can miss columns.
  const headerSet = new Set<string>()
  for (const r of json) for (const k of Object.keys(r)) headerSet.add(k)
  const headers = Array.from(headerSet)
  const rows = json.map(r => {
    const o: Record<string, string> = {}
    for (const h of headers) o[h] = String(r[h] ?? '').trim()
    return o
  })
  return { headers, rows }
}

/**
 * Returns the first non-empty cell whose column header matches any of the
 * given patterns (tested against the lower-cased header). Patterns are tried in
 * order so callers can prioritise the most specific column name first.
 */
export function pick(row: Record<string, string>, headers: string[], patterns: RegExp[]): string {
  for (const p of patterns) {
    for (const h of headers) {
      if (p.test(h.toLowerCase().trim())) {
        const v = row[h]
        if (v && v.trim()) return v.trim()
      }
    }
  }
  return ''
}

// ── Inventory matrix parser (the team's master tracking sheet) ─────────────
//
// Handles the real-world layout where:
//   - rows are pages, grouped under section headers like "Vadodara Social
//     Media Pages" (which sets the geography for every page below it),
//   - the "Inventory" cell encodes posts + stories, e.g. "48(P) 24 (S)",
//   - "Posts done" is a per-page count,
//   - and every column to the RIGHT of the page-name column is a campaign,
//     with a number in the cell meaning that page posted for that campaign.
// Page hyperlinks (when present) give the real Instagram handle; otherwise the
// display text is cleaned of trailing "- (3)", "- static(2)", "(club)" tags.

export interface ParsedPageRow {
  handle: string
  displayName: string
  geography: string
  state: string
  type: 'state' | 'pu'
  followerTier: '1' | '2' | '3' | '4' | '5'
  inventoryPosts: number
  inventoryStories: number
  postsDone: number
  /** Campaign column names where this row had a value. */
  assignedCampaigns: string[]
}

export interface ParsedInventorySheet {
  pages: ParsedPageRow[]
  /** Distinct campaign column names detected across the sheet. */
  campaigns: string[]
}

// City → state lookup so a "Vadodara …" section auto-fills state = Gujarat.
// Unknown geographies fall back to using the geography as the state (editable).
const CITY_STATE: Record<string, string> = {
  vadodara: 'Gujarat', baroda: 'Gujarat', surat: 'Gujarat', ahmedabad: 'Gujarat',
  rajkot: 'Gujarat', gujarat: 'Gujarat', gandhinagar: 'Gujarat', anand: 'Gujarat',
  pune: 'Maharashtra', mumbai: 'Maharashtra', nagpur: 'Maharashtra',
  aurangabad: 'Maharashtra', nashik: 'Maharashtra', maharashtra: 'Maharashtra',
  bhopal: 'Madhya Pradesh', indore: 'Madhya Pradesh', 'madhya pradesh': 'Madhya Pradesh',
  patna: 'Bihar', bihar: 'Bihar',
  jaipur: 'Rajasthan', udaipur: 'Rajasthan', jodhpur: 'Rajasthan', rajasthan: 'Rajasthan',
  lucknow: 'Uttar Pradesh', kanpur: 'Uttar Pradesh', 'uttar pradesh': 'Uttar Pradesh',
  guwahati: 'Assam', assam: 'Assam', 'north-east': 'Assam',
  goa: 'Goa', delhi: 'Delhi', punjab: 'Punjab', haryana: 'Haryana',
}

function cityToState(geo: string): string {
  return CITY_STATE[geo.trim().toLowerCase()] ?? ''
}

/** Parses "48(P) 24 (S)", "25 P & 30 (S)", "16 (P) 10 (S)" → {posts, stories}. */
export function parseInventory(s: string): { posts: number; stories: number } {
  const t = (s ?? '').toUpperCase()
  const pm = t.match(/(\d+)\s*\(?\s*P/)
  const sm = t.match(/(\d+)\s*\(?\s*S/)
  return { posts: pm ? parseInt(pm[1], 10) : 0, stories: sm ? parseInt(sm[1], 10) : 0 }
}

/** Strips trailing annotations like " - (3)", " - static(2)", " (club)". */
function cleanPageName(s: string): string {
  return s
    .replace(/\s*[-–]\s*(?:static|club)?\s*\(?\s*\d*\s*\)?\s*$/i, '')
    .replace(/\s*\((?:club|static)\)\s*$/i, '')
    .trim()
}

// ── Campaign sheet parser (campaign + pages + live posts in one upload) ─────
//
// Layout: one row per page-assignment, grouped by campaign name. Campaign-level
// cells (dates, state, budgets, variants…) are read from the first row of the
// group where they're non-empty, so merged-cell sheets — where the campaign
// name appears once and continuation rows leave it blank — parse naturally
// (blank names carry forward from the row above).
//
//   Campaign  | Start    | State | Posts | Stories | Reels | Variant      | Page          | Post links
//   Lakshya   | 01/07/26 | Jammu | 10    | 5       | 6     | set_1, set_2 | @rajourinews  | url1 url2
//             |          |       |       |         |       | set_2        | @poonch_live  | url3
//
// The Variant column does double duty: every token it contains joins the
// campaign's creative-variant list, and when a row has exactly ONE token, that
// row's post links are tagged with it (multiple/empty → links auto-match by
// caption, the same behaviour as the Add Live Posts dialog).

/** Accept "DD/MM/YYYY", "DD-MM-YYYY", "YYYY-MM-DD" (and Excel serials) →
 *  ISO YYYY-MM-DD. Returns '' when unparseable. */
export function normalizeDate(raw: string): string {
  const s = raw.trim()
  if (!s) return ''
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  // Excel sometimes hands us a serial date number when cells are date-typed.
  if (/^\d{4,6}$/.test(s)) {
    const serial = parseInt(s, 10)
    const ms = (serial - 25569) * 86400_000 // 25569 = days between 1899-12-30 and epoch
    const d = new Date(ms)
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10)
  }
  const m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/)
  if (!m) return ''
  const [, d, mo, y] = m
  const yyyy = y.length === 2 ? `20${y}` : y
  return `${yyyy}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`
}

export interface ParsedCampaignPageRow {
  /** Canonical handle, no @. */
  handle: string
  /** Creative variant to tag this row's links with; '' = auto-match by caption. */
  variant: string
  /** Instagram post / reel URLs found in the row. */
  links: string[]
}

export interface ParsedCampaignGroup {
  name: string
  startDate: string
  state: string
  goal: string
  budgetPosts: number
  budgetStories: number
  budgetReels: number
  /** Union of the variants column tokens across the group's rows. */
  variants: string[]
  pages: ParsedCampaignPageRow[]
}

export interface ParsedCampaignSheet {
  campaigns: ParsedCampaignGroup[]
  warnings: string[]
}

function toCount(s: string): number {
  const n = parseInt(s.replace(/[^\d]/g, ''), 10)
  return Number.isFinite(n) && n >= 0 ? n : 0
}

/** Splits a cell that may hold several Instagram URLs (newlines/commas/spaces). */
function extractLinks(cell: string): string[] {
  return cell.split(/[\s,;]+/).map(s => s.trim()).filter(s => /instagram\.com\//i.test(s))
}

function splitVariants(cell: string): string[] {
  return cell.split(/[,;/]+/).map(s => s.trim()).filter(Boolean)
}

export async function parseCampaignSheet(file: File): Promise<ParsedCampaignSheet> {
  const { headers, rows } = await parseSpreadsheet(file)
  const warnings: string[] = []
  const groups = new Map<string, ParsedCampaignGroup>()

  // Column patterns. Order matters: `pick` tries patterns first-to-last, and
  // the budget columns must not swallow the "post links" column (or vice
  // versa), hence the anchored/negative-ish shapes.
  const PAT = {
    name: [/campaign.*name|name.*campaign/, /^campaign$/, /^name$/, /title/],
    start: [/start/, /^from$/, /launch/],
    state: [/^state$/, /state/],
    goal: [/description|desc\b/, /goal/, /brief/, /kpi/],
    budgetPosts: [/(no|num|number|#).*post/, /^posts?$/, /post.*(count|budget|target)/],
    budgetStories: [/(no|num|number|#).*stor/, /^stor(y|ies)$/, /stor(y|ies).*(count|budget|target)/, /stor/],
    budgetReels: [/(no|num|number|#).*reel/, /^reels?$/, /reel.*(count|budget|target)/, /reel/],
    variant: [/variant|creative|^sets?$/],
    page: [/page.*(name|handle)/, /^pages?$/, /handle/, /account/, /^insta/],
    links: [/link|url|live.*post/],
  }

  let carriedName = ''
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const rawName = pick(row, headers, PAT.name)
    const name = (rawName || carriedName).trim()
    if (!name) {
      // A row with page/link data but no campaign to attach to.
      if (pick(row, headers, PAT.page) || pick(row, headers, PAT.links)) {
        warnings.push(`Row ${i + 2}: no campaign name (and none above to carry from) — skipped.`)
      }
      continue
    }
    carriedName = name

    const key = name.toLowerCase()
    let g = groups.get(key)
    if (!g) {
      g = {
        name, startDate: '', state: '', goal: '',
        budgetPosts: 0, budgetStories: 0, budgetReels: 0,
        variants: [], pages: [],
      }
      groups.set(key, g)
    }

    // Campaign-level fields: first non-empty value in the group wins.
    if (!g.startDate) g.startDate = normalizeDate(pick(row, headers, PAT.start))
    if (!g.state) g.state = pick(row, headers, PAT.state)
    if (!g.goal) g.goal = pick(row, headers, PAT.goal)
    if (!g.budgetPosts) g.budgetPosts = toCount(pick(row, headers, PAT.budgetPosts))
    if (!g.budgetStories) g.budgetStories = toCount(pick(row, headers, PAT.budgetStories))
    if (!g.budgetReels) g.budgetReels = toCount(pick(row, headers, PAT.budgetReels))

    const variantTokens = splitVariants(pick(row, headers, PAT.variant))
    for (const v of variantTokens) if (!g.variants.includes(v)) g.variants.push(v)

    const pageCell = pick(row, headers, PAT.page)
    const links = extractLinks(pick(row, headers, PAT.links))
    if (!pageCell) {
      if (links.length > 0) warnings.push(`Row ${i + 2} ("${name}"): post links given without a page — skipped.`)
      continue
    }
    const handle = parseInstagramHandle(pageCell)
    if (!handle) {
      warnings.push(`Row ${i + 2} ("${name}"): could not read a page handle from "${pageCell}" — skipped.`)
      continue
    }

    // Merge rows for the same page within a campaign (links accumulate).
    const rowVariant = variantTokens.length === 1 ? variantTokens[0] : ''
    const existing = g.pages.find(p => p.handle === handle)
    if (existing) {
      for (const l of links) if (!existing.links.includes(l)) existing.links.push(l)
      if (!existing.variant && rowVariant) existing.variant = rowVariant
    } else {
      g.pages.push({ handle, variant: rowVariant, links })
    }
  }

  return { campaigns: Array.from(groups.values()), warnings }
}

export async function parseInventorySheet(file: File): Promise<ParsedInventorySheet> {
  const buf = await file.arrayBuffer()
  const wb = XLSX.read(buf, { type: 'array' })
  const first = wb.SheetNames[0]
  if (!first) return { pages: [], campaigns: [] }
  const ws = wb.Sheets[first]
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', blankrows: false, raw: false }) as unknown[][]
  const grid = aoa.map(r => (r ?? []).map(c => String(c ?? '').trim()))

  // Locate the header row: it has "Inventory", "Posts done" and a "… Social
  // Media Pages" cell. Fall back to just Inventory + Social Media.
  const findHeader = (strict: boolean) => grid.findIndex(row => {
    const lc = row.map(c => c.toLowerCase())
    const hasInv = lc.some(c => c.includes('inventory'))
    const hasPages = lc.some(c => c.includes('social media'))
    const hasPosts = lc.some(c => c.includes('posts done'))
    return strict ? (hasInv && hasPages && hasPosts) : (hasInv && hasPages)
  })
  const hr = findHeader(true) !== -1 ? findHeader(true) : findHeader(false)
  if (hr === -1) return { pages: [], campaigns: [] }

  const header = grid[hr]
  const lc = header.map(c => c.toLowerCase())
  const colInv = lc.findIndex(c => c.includes('inventory'))
  const colPosts = lc.findIndex(c => c.includes('posts done'))
  const colPages = lc.findIndex(c => c.includes('social media'))

  // Campaign columns = every non-empty header right of the page-name column,
  // excluding obvious non-campaign trailing columns (e.g. a "Goal" summary).
  const campaignCols: { idx: number; name: string }[] = []
  for (let c = colPages + 1; c < header.length; c++) {
    const name = header[c]
    if (!name || /^goal/i.test(name) || /^total/i.test(name)) continue
    campaignCols.push({ idx: c, name })
  }

  const pages: ParsedPageRow[] = []
  let currentGeo = ''
  for (let i = hr + 1; i < grid.length; i++) {
    const row = grid[i]
    const pageCell = (row[colPages] ?? '').trim()
    if (!pageCell) continue
    // Section header sets the geography for the rows beneath it.
    if (/social media pages/i.test(pageCell)) {
      currentGeo = pageCell.replace(/social media pages/i, '').trim()
      continue
    }
    // A real page row needs a name; prefer the cell's hyperlink for the handle.
    const cell = ws[XLSX.utils.encode_cell({ r: i, c: colPages })] as { l?: { Target?: string } } | undefined
    const link = cell?.l?.Target
    const handle = link ? parseInstagramHandle(link) : cleanPageName(pageCell)
    if (!handle) continue
    const { posts: invPosts, stories: invStories } = parseInventory(row[colInv] ?? '')
    const postsDone = parseInt((row[colPosts] ?? '').replace(/\D+/g, '') || '0', 10) || 0
    const geography = currentGeo
    const state = cityToState(geography) || geography
    const assignedCampaigns = campaignCols
      .filter(cc => (row[cc.idx] ?? '').trim() !== '')
      .map(cc => cc.name)
    pages.push({
      handle, displayName: cleanPageName(pageCell),
      geography, state, type: 'state', followerTier: '1',
      inventoryPosts: invPosts, inventoryStories: invStories, postsDone, assignedCampaigns,
    })
  }

  return { pages, campaigns: campaignCols.map(c => c.name) }
}
