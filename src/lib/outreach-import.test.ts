// @vitest-environment node
/* The spreadsheet importers' readers: dates written day first, counts that
   are not whole numbers, page links under blank rows, and states read from
   section headings. Sheets are built in memory with SheetJS itself. */
import { describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import { normalizeDate, parseCampaignSheet, parseInventorySheet, toCount } from './outreach-import'

function csvFile(text: string, name = 'sheet.csv'): File {
  return new File([text], name, { type: 'text/csv' })
}

function xlsxFile(ws: XLSX.WorkSheet): File {
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1')
  const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer
  return new File([out], 'sheet.xlsx')
}

describe('normalizeDate', () => {
  it('reads day-first dates', () => {
    expect(normalizeDate('08/10/2026')).toBe('2026-10-08')
    expect(normalizeDate('8-10-26')).toBe('2026-10-08')
    expect(normalizeDate('08.10.2026')).toBe('2026-10-08')
  })

  it('reads a month written as a word', () => {
    expect(normalizeDate('8 Oct 2026')).toBe('2026-10-08')
    expect(normalizeDate('08-Oct-26')).toBe('2026-10-08')
    expect(normalizeDate('8th September 2026')).toBe('2026-09-08')
    expect(normalizeDate('8 Sept 2026')).toBe('2026-09-08')
    expect(normalizeDate('8 Octopus 2026')).toBe('')
  })

  it("refuses a day that doesn't exist instead of building it", () => {
    expect(normalizeDate('31/02/2026')).toBe('')
    expect(normalizeDate('00/10/2026')).toBe('')
    expect(normalizeDate('10/13/2026')).toBe('')   // month first is not read
    expect(normalizeDate('2026-02-31')).toBe('')
    expect(normalizeDate('29/02/2028')).toBe('2028-02-29')
  })

  it('still takes ISO dates, Excel serials and blanks', () => {
    expect(normalizeDate('2026-10-08')).toBe('2026-10-08')
    expect(normalizeDate('46303')).toBe('2026-10-08')
    expect(normalizeDate('')).toBe('')
    expect(normalizeDate('soon')).toBe('')
  })
})

describe('toCount', () => {
  it('reads the number a cell starts with, not every digit in it', () => {
    expect(toCount('12')).toBe(12)
    expect(toCount(' 12 posts ')).toBe(12)
    expect(toCount('1,200')).toBe(1200)
    expect(toCount('3 (2 pending)')).toBe(3)
    // Was 15. Kept as 1.5 so the importer's whole-number check reports it.
    expect(toCount('1.5')).toBe(1.5)
    expect(toCount('')).toBe(0)
    expect(toCount('none')).toBe(0)
  })
})

describe('parseCampaignSheet', () => {
  it('reads a CSV date day first — 08/10/2026 is 8 October, not 10 August', async () => {
    const { campaigns, warnings } = await parseCampaignSheet(csvFile(
      'Campaign,Start,State,Posts,Page\nLakshya,08/10/2026,tamilnadu,4,@rajourinews\n'))
    expect(warnings).toEqual([])
    expect(campaigns[0].startDate).toBe('2026-10-08')
    expect(campaigns[0].budgetPosts).toBe(4)
    // The raw state is kept; the importer canonicalises or reports it.
    expect(campaigns[0].state).toBe('tamilnadu')
  })

  it('warns about a start date that does not exist, by row', async () => {
    const { campaigns, warnings } = await parseCampaignSheet(csvFile('Campaign,Start\nLakshya,31/02/2026\n'))
    expect(campaigns[0].startDate).toBe('')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/Row 2 .*31\/02\/2026/)
  })

  it('keeps a fractional budget a fraction, for the whole-number check to report', async () => {
    const { campaigns } = await parseCampaignSheet(csvFile('Campaign,Posts\nLakshya,1.5\n'))
    expect(campaigns[0].budgetPosts).toBe(1.5)
  })
})

describe('parseInventorySheet', () => {
  function inventorySheet(blankAbove: number) {
    // A truly blank row has no cells at all ([]), which is what SheetJS skips.
    const rows: string[][] = [
      ['Sr', 'Inventory', 'Posts done', 'Social Media Pages', 'Diwali'],
      ['', '', '', 'Tamilnadu Social Media Pages', ''],
      ...Array.from({ length: blankAbove }, () => []),
      ['1', '48(P) 24 (S)', '3', 'Chennai Talks - (3)', '1'],
      [],
      ['2', '10(P) 5(S)', '1.5', 'Madurai Live', ''],
      ['', '', '', 'Vadodara Social Media Pages', ''],
      ['3', '6(P)', '', 'Baroda Buzz', ''],
      ['', '', '', 'Atlantis Social Media Pages', ''],
      ['4', '6(P)', '', 'Nowhere Page', ''],
    ]
    const ws = XLSX.utils.aoa_to_sheet(rows)
    const linkAt = (row: number, handle: string) => {
      const ref = XLSX.utils.encode_cell({ r: row, c: 3 })
      ws[ref].l = { Target: `https://www.instagram.com/${handle}/` }
    }
    linkAt(2 + blankAbove, 'chennai_talks')
    linkAt(4 + blankAbove, 'madurai_live')
    linkAt(6 + blankAbove, 'baroda_buzz')
    return xlsxFile(ws)
  }

  it("gives each page its own link even under blank rows (was the next page's)", async () => {
    const { pages } = await parseInventorySheet(inventorySheet(2))
    expect(pages.map(p => p.handle)).toEqual(['chennai_talks', 'madurai_live', 'baroda_buzz', 'Nowhere Page'])
  })

  it("reads links right for a sheet whose used range doesn't start at row 1", async () => {
    // Written from A3, so the used range (and grid row 0) starts at sheet row 3.
    const ws: XLSX.WorkSheet = {}
    XLSX.utils.sheet_add_aoa(ws, [
      ['Inventory', 'Posts done', 'Social Media Pages'],
      ['', '', 'Gujarat Social Media Pages'],
      [],
      ['5(P)', '1', 'Page One'],
      ['5(P)', '1', 'Page Two'],
    ], { origin: 'A3' })
    ws[XLSX.utils.encode_cell({ r: 5, c: 2 })].l = { Target: 'https://www.instagram.com/page_one/' }
    ws[XLSX.utils.encode_cell({ r: 6, c: 2 })].l = { Target: 'https://www.instagram.com/page_two/' }
    const { pages } = await parseInventorySheet(xlsxFile(ws))
    expect(pages.map(p => p.handle)).toEqual(['page_one', 'page_two'])
  })

  it('names states canonically, maps cities, and keeps an unknown section for the grid to flag', async () => {
    const { pages } = await parseInventorySheet(inventorySheet(0))
    expect(pages.map(p => p.state)).toEqual(['Tamil Nadu', 'Tamil Nadu', 'Gujarat', 'Atlantis'])
    expect(pages[0].geography).toBe('Tamilnadu')
  })

  it('reads posts done as the number the cell starts with', async () => {
    const { pages } = await parseInventorySheet(inventorySheet(0))
    expect(pages.map(p => p.postsDone)).toEqual([3, 1, 0, 0])
    expect(pages[0].assignedCampaigns).toEqual(['Diwali'])
  })
})
