/**
 * Spreadsheet import helpers for the outreach Pages / Campaigns bulk uploaders.
 *
 * Reads the first sheet of an .xlsx / .xls / .csv file into header-keyed row
 * objects. Column matching is fuzzy (see `pick`) so the team can upload their
 * existing sheets without renaming columns to an exact template.
 */
import * as XLSX from 'xlsx'

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
