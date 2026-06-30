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
