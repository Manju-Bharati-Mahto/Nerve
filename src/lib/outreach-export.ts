/**
 * Per-campaign report export — PDF and Word (.docx).
 *
 * Spec (Export Feature → Campaign Report Export): for each campaign produce a
 * document containing the campaign's name / dates / state, the list of assigned
 * pages, the specific post link added for each page plus that post's
 * performance (reach, views, likes, comments), and a total summary at the end.
 *
 * Both generators run entirely client-side. Only live posts (added via the
 * "Add live posts" dialog) count — auto-synced backlog rows are ignored, in
 * line with the rest of the outreach analytics.
 */
import jsPDF from 'jspdf'
import autoTable from 'jspdf-autotable'
import {
  Document, Packer, Paragraph, Table, TableRow, TableCell, TextRun,
  HeadingLevel, WidthType, AlignmentType, BorderStyle,
} from 'docx'
import type { Campaign, OutreachPage, OutreachCreator, Post } from './outreach-data'
import { slug, buildPostStateLookup, formatLocalDate } from './outreach-data'

export interface CampaignReportRow {
  subject: string          // @handle
  kind: 'page' | 'creator'
  link: string             // post permalink, or '' when pending
  reach: number
  views: number
  likes: number
  comments: number
  pending: boolean         // true when the assignee hasn't published yet
}

export interface CampaignReport {
  campaign: Campaign
  rows: CampaignReportRow[]
  totals: { reach: number; views: number; likes: number; comments: number; posts: number }
}

/** Builds the structured report data shared by both exporters. */
export function buildCampaignReport(
  campaign: Campaign,
  pages: OutreachPage[],
  creators: OutreachCreator[],
  posts: Post[],
): CampaignReport {
  const pageById = new Map(pages.map(p => [p.id, p]))
  const creatorById = new Map(creators.map(c => [c.id, c]))
  const rows: CampaignReportRow[] = []

  const livePostsFor = (predicate: (p: Post) => boolean) =>
    posts.filter(p => p.campaignId === campaign.id && p.addedAsLive && predicate(p))

  for (const pid of campaign.assignedPageIds) {
    const page = pageById.get(pid)
    if (!page) continue
    const pp = livePostsFor(p => p.pageId === pid)
    if (pp.length === 0) {
      rows.push({ subject: `@${page.handle}`, kind: 'page', link: '', reach: 0, views: 0, likes: 0, comments: 0, pending: true })
    } else {
      for (const p of pp) {
        rows.push({ subject: `@${page.handle}`, kind: 'page', link: p.permalink ?? '', reach: p.views, views: p.views, likes: p.likes, comments: p.comments, pending: false })
      }
    }
  }

  for (const cid of campaign.assignedCreatorIds) {
    const creator = creatorById.get(cid)
    if (!creator) continue
    const cp = livePostsFor(p => p.creatorId === cid)
    if (cp.length === 0) {
      rows.push({ subject: `@${creator.handle}`, kind: 'creator', link: '', reach: 0, views: 0, likes: 0, comments: 0, pending: true })
    } else {
      for (const p of cp) {
        rows.push({ subject: `@${creator.handle}`, kind: 'creator', link: p.permalink ?? '', reach: p.views, views: p.views, likes: p.likes, comments: p.comments, pending: false })
      }
    }
  }

  const live = rows.filter(r => !r.pending)
  const totals = {
    reach: live.reduce((s, r) => s + r.reach, 0),
    views: live.reduce((s, r) => s + r.views, 0),
    likes: live.reduce((s, r) => s + r.likes, 0),
    comments: live.reduce((s, r) => s + r.comments, 0),
    posts: live.length,
  }
  return { campaign, rows, totals }
}

function fmtNum(n: number): string {
  return n.toLocaleString('en-IN')
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

// ── PDF ────────────────────────────────────────────────────────────────────

export function exportCampaignReportPdf(report: CampaignReport) {
  const { campaign, rows, totals } = report
  const doc = new jsPDF({ unit: 'pt', format: 'a4' })
  const marginX = 40
  let y = 48

  doc.setFontSize(18)
  doc.setTextColor(234, 88, 12) // orange-600
  doc.text(campaign.name, marginX, y)
  y += 22

  doc.setFontSize(10)
  doc.setTextColor(80)
  const meta = [
    `Dates: ${campaign.startDate || '—'}${campaign.endDate ? `  to  ${campaign.endDate}` : '  onwards'}`,
    `State: ${campaign.state || 'All states'}`,
    `Status: ${campaign.status}`,
    `Pages assigned: ${campaign.assignedPageIds.length}` +
      (campaign.assignedCreatorIds.length ? `   Creators: ${campaign.assignedCreatorIds.length}` : ''),
  ]
  for (const line of meta) { doc.text(line, marginX, y); y += 15 }
  if (campaign.goal) { y += 2; doc.text(doc.splitTextToSize(`Goal: ${campaign.goal}`, 515), marginX, y); y += 16 }
  y += 6

  autoTable(doc, {
    startY: y,
    head: [['Page / Creator', 'Post link', 'Reach', 'Views', 'Likes', 'Comments']],
    body: rows.map(r => [
      r.subject,
      r.pending ? 'Pending — no post added' : (r.link || '—'),
      r.pending ? '—' : fmtNum(r.reach),
      r.pending ? '—' : fmtNum(r.views),
      r.pending ? '—' : fmtNum(r.likes),
      r.pending ? '—' : fmtNum(r.comments),
    ]),
    styles: { fontSize: 8, cellPadding: 4, overflow: 'linebreak' },
    headStyles: { fillColor: [234, 88, 12], textColor: 255 },
    columnStyles: {
      1: { cellWidth: 200 },
      2: { halign: 'right' }, 3: { halign: 'right' }, 4: { halign: 'right' }, 5: { halign: 'right' },
    },
    margin: { left: marginX, right: marginX },
  })

  // jspdf-autotable stashes the final Y on the doc instance.
  const afterTableY = (doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? y
  let ty = afterTableY + 24
  doc.setFontSize(12)
  doc.setTextColor(20)
  doc.text('Total summary', marginX, ty)
  ty += 16
  doc.setFontSize(10)
  doc.setTextColor(80)
  const summary = [
    `Live posts: ${fmtNum(totals.posts)}`,
    `Total reach: ${fmtNum(totals.reach)}`,
    `Total views: ${fmtNum(totals.views)}`,
    `Total likes: ${fmtNum(totals.likes)}`,
    `Total comments: ${fmtNum(totals.comments)}`,
  ]
  for (const line of summary) { doc.text(line, marginX, ty); ty += 14 }

  triggerDownload(doc.output('blob'), `campaign-${slug(campaign.name) || campaign.id}-report.pdf`)
}

// ── Word (.docx) ─────────────────────────────────────────────────────────────

const CELL_BORDERS = {
  top: { style: BorderStyle.SINGLE, size: 4, color: 'E5E7EB' },
  bottom: { style: BorderStyle.SINGLE, size: 4, color: 'E5E7EB' },
  left: { style: BorderStyle.SINGLE, size: 4, color: 'E5E7EB' },
  right: { style: BorderStyle.SINGLE, size: 4, color: 'E5E7EB' },
}

function docxCell(text: string, opts: { bold?: boolean; fill?: string; align?: (typeof AlignmentType)[keyof typeof AlignmentType] } = {}) {
  return new TableCell({
    borders: CELL_BORDERS,
    shading: opts.fill ? { fill: opts.fill } : undefined,
    children: [new Paragraph({
      alignment: opts.align,
      children: [new TextRun({ text, bold: opts.bold, size: 18, color: opts.bold && opts.fill ? 'FFFFFF' : '111111' })],
    })],
  })
}

export async function exportCampaignReportDocx(report: CampaignReport) {
  const { campaign, rows } = report
  const ORANGE = 'EA580C'

  // Per request: the DOC report is just two adjacent columns — page handle and
  // its post link. One row per live post; assigned pages with no post yet show
  // a dash in the link column.
  const headerRow = new TableRow({
    tableHeader: true,
    children: ['Page handle', 'Post link'].map(h => docxCell(h, { bold: true, fill: ORANGE })),
  })
  const bodyRows = rows.map(r => new TableRow({
    children: [
      docxCell(r.subject),
      docxCell(r.pending || !r.link ? '—' : r.link),
    ],
  }))

  const table = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [headerRow, ...bodyRows],
  })

  const doc = new Document({
    sections: [{
      children: [
        new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: campaign.name, color: ORANGE })] }),
        new Paragraph({ text: '' }),
        table,
      ],
    }],
  })

  const blob = await Packer.toBlob(doc)
  triggerDownload(blob, `campaign-${slug(campaign.name) || campaign.id}-report.docx`)
}

// ── Dashboard "Last 30 days" report (PRD 6.3) ────────────────────────────────

export interface DashboardReportRow {
  name: string
  state: string
  reach: number
  views: number
  likes: number
  comments: number
  shares: number
  /** (likes + comments + shares) / reach, as a percentage. */
  engagementRate: number
}

export interface DashboardReport {
  generatedAt: Date
  from: string           // YYYY-MM-DD (inclusive window start)
  to: string             // YYYY-MM-DD (report day)
  days: number
  stateFilter: string    // '' = all states
  summary: { views: number; likes: number; campaigns: number }
  rows: DashboardReportRow[]
  totals: { reach: number; views: number; likes: number; comments: number; shares: number; engagementRate: number }
}

/**
 * Builds the rolling-window dashboard report. Only operator-added live posts
 * count (consistent with every other outreach analytic). When `stateFilter` is
 * set, the report mirrors the dashboard's state scoping exactly: posts are
 * narrowed by their page/creator state and campaigns by their own state.
 */
export function buildDashboardReport(
  campaigns: Campaign[],
  pages: OutreachPage[],
  creators: OutreachCreator[],
  posts: Post[],
  opts: { stateFilter?: string; days?: number } = {},
): DashboardReport {
  const days = opts.days ?? 30
  const stateFilter = opts.stateFilter ?? ''
  const now = new Date()
  const start = new Date(now.getTime() - days * 86400_000)
  const startIso = formatLocalDate(start)
  const stateOf = buildPostStateLookup(pages, creators)

  // Live posts within the rolling window, narrowed by state when a filter is on.
  const windowPosts = posts.filter(p =>
    p.addedAsLive &&
    p.date >= startIso &&
    (!stateFilter || stateOf(p) === stateFilter),
  )

  const scopedCampaigns = stateFilter ? campaigns.filter(c => c.state === stateFilter) : campaigns

  const rows: DashboardReportRow[] = []
  for (const c of scopedCampaigns) {
    const cp = windowPosts.filter(p => p.campaignId === c.id)
    // "active or run in the last N days": include if it drew posts in the window
    // or is currently active. Skip otherwise so the table stays relevant.
    if (cp.length === 0 && c.status !== 'active') continue
    const reach = cp.reduce((s, p) => s + p.views, 0)
    const likes = cp.reduce((s, p) => s + p.likes, 0)
    const comments = cp.reduce((s, p) => s + p.comments, 0)
    const shares = cp.reduce((s, p) => s + p.shares, 0)
    const engagementRate = reach ? ((likes + comments + shares) / reach) * 100 : 0
    rows.push({ name: c.name, state: c.state || '—', reach, views: reach, likes, comments, shares, engagementRate })
  }
  rows.sort((a, b) => b.reach - a.reach)

  const totReach = rows.reduce((s, r) => s + r.reach, 0)
  const totLikes = rows.reduce((s, r) => s + r.likes, 0)
  const totComments = rows.reduce((s, r) => s + r.comments, 0)
  const totShares = rows.reduce((s, r) => s + r.shares, 0)
  const totals = {
    reach: totReach,
    views: totReach,
    likes: totLikes,
    comments: totComments,
    shares: totShares,
    engagementRate: totReach ? ((totLikes + totComments + totShares) / totReach) * 100 : 0,
  }

  // Overall summary totals are taken across ALL live window posts (not only the
  // ones attributed to a campaign) so the headline views/likes match the
  // dashboard's state-scoped cards.
  const summary = {
    views: windowPosts.reduce((s, p) => s + p.views, 0),
    likes: windowPosts.reduce((s, p) => s + p.likes, 0),
    campaigns: rows.length,
  }

  return { generatedAt: now, from: startIso, to: formatLocalDate(now), days, stateFilter, summary, rows, totals }
}

export function exportDashboardReportPdf(report: DashboardReport) {
  const { rows, totals, summary } = report
  const doc = new jsPDF({ unit: 'pt', format: 'a4' })
  const marginX = 40
  let y = 48

  doc.setFontSize(18)
  doc.setTextColor(234, 88, 12)
  doc.text(`Outreach Report — Last ${report.days} Days`, marginX, y)
  y += 22

  doc.setFontSize(10)
  doc.setTextColor(80)
  const gen = report.generatedAt
  const genStr = `${gen.toLocaleDateString('en-IN')} ${gen.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}`
  for (const line of [
    `Date range: ${report.from}  to  ${report.to}`,
    `State: ${report.stateFilter || 'All states'}`,
    `Generated: ${genStr}`,
  ]) { doc.text(line, marginX, y); y += 15 }
  y += 8

  // Overall summary band
  doc.setFontSize(12)
  doc.setTextColor(20)
  doc.text('Overall summary', marginX, y)
  y += 16
  doc.setFontSize(10)
  doc.setTextColor(80)
  for (const line of [
    `Total views (reach): ${fmtNum(summary.views)}`,
    `Total likes: ${fmtNum(summary.likes)}`,
    `Campaigns active / run in the last ${report.days} days: ${fmtNum(summary.campaigns)}`,
  ]) { doc.text(line, marginX, y); y += 14 }
  y += 8

  autoTable(doc, {
    startY: y,
    head: [['Campaign', 'State', 'Reach', 'Views', 'Likes', 'Comments', 'Shares', 'Eng. rate']],
    body: rows.map(r => [
      r.name, r.state,
      fmtNum(r.reach), fmtNum(r.views), fmtNum(r.likes), fmtNum(r.comments), fmtNum(r.shares),
      `${r.engagementRate.toFixed(1)}%`,
    ]),
    foot: [[
      'Totals', '',
      fmtNum(totals.reach), fmtNum(totals.views), fmtNum(totals.likes), fmtNum(totals.comments), fmtNum(totals.shares),
      `${totals.engagementRate.toFixed(1)}%`,
    ]],
    styles: { fontSize: 8, cellPadding: 4, overflow: 'linebreak' },
    headStyles: { fillColor: [234, 88, 12], textColor: 255 },
    footStyles: { fillColor: [255, 237, 213], textColor: 20, fontStyle: 'bold' },
    columnStyles: {
      0: { cellWidth: 150 },
      2: { halign: 'right' }, 3: { halign: 'right' }, 4: { halign: 'right' },
      5: { halign: 'right' }, 6: { halign: 'right' }, 7: { halign: 'right' },
    },
    margin: { left: marginX, right: marginX },
  })

  if (rows.length === 0) {
    const afterY = (doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? y
    doc.setFontSize(10)
    doc.setTextColor(120)
    doc.text('No campaigns ran in this window.', marginX, afterY + 20)
  }

  const stateTag = report.stateFilter ? `-${slug(report.stateFilter)}` : ''
  triggerDownload(doc.output('blob'), `outreach-report-last-${report.days}d${stateTag}-${report.to}.pdf`)
}
