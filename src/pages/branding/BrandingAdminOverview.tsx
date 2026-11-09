/**
 * Admin Dashboard overview — replaces the bare "Daily Reports" table on the
 * branding-admin Daily Reports tab. Mirrors the visual language of the
 * Branding User dashboard (Salesa design system: slate ink, bp accent,
 * white rounded-[6px] surfaces, rounded-top bar charts) but the data shown
 * is team-aggregated:
 *
 *   • 4 stat cards (Total Projects / Submitted Today / Running Projects / Total Hours MTD)
 *   • Work Analytics — submitters per day, with date filter + click-to-drill modal
 *   • Reminders — pending leaves + KRA appraisal window
 *   • All Reports dialog — top-4 user cards + Read more + full filter UI
 *   • Team Summary bar chart
 *   • Hours by Category pie + Collaboration map side by side
 */
import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  AlertCircle, ChevronDown, ChevronUp, CheckCircle, Clock,
  Download, Lock, Users as UsersIcon, ArrowRight, Briefcase, Activity, Inbox,
} from 'lucide-react'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
  PieChart, Pie, Cell,
} from 'recharts'
import { toast } from 'sonner'
import { brandingApi } from '@/lib/branding-api'
import { MONTHS, timeToHours, elapsedToTimeTaken, perDayElapsedSeconds } from '@/lib/branding-types'
import type {
  DailyReport, BrandingProject, BrandingLeave, WorkCategory,
} from '@/lib/branding-types'
import {
  DS, cx, CHART, StatCard, DarkStatCard, HeroBanner, BlockHeader, Card, CardHead, Segmented,
  NumberedItem, StatusPill, Avatar, Badge, Modal, EmptyState, Spinner, toneForStatus,
} from './ds'
import { L, CHART2, ChartTip, evenTicks } from './ds2'

// ── Date helpers (local-midnight; mirrors BrandingUserDashboard) ──────────

const fmtDate = (d: Date) => {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}
const today = () => fmtDate(new Date())
const parseDateLocal = (s: string) => {
  const [y, mo, d] = s.split('-').map(Number)
  return new Date(y, mo - 1, d)
}

// Hours actually tracked on the day of `row`. Stopwatch rows use the
// per-day delta (so a row carried from yesterday only counts what was
// added today); manual entries fall back to the typed time_taken string.
// Pass the same report set the caller is iterating so carry-over chains
// can be resolved.
function rowHours(
  row: { elapsed_seconds: number; carried_over_from_row_id: string | null; time_taken: string },
  allReports: DailyReport[],
): number {
  if (!row.elapsed_seconds) return timeToHours(row.time_taken)
  return perDayElapsedSeconds(row, allReports) / 3600
}

// A no-break space between the figure and its unit, and "hr" not "h" —
// the same rule the user dashboard's figures follow.
const fmtHours = (h: number): string => {
  if (!isFinite(h) || h <= 0) return '0\u00A0hr'
  if (h >= 1) return `${Math.round(h * 10) / 10}\u00A0hr`
  const mins = h * 60
  if (mins >= 1) return `${Math.round(mins)}\u00A0m`
  return `${Math.max(1, Math.round(h * 3600))}\u00A0s`
}

// Short labels on purpose: four segments sit side by side in the card head.
const CHART_RANGES = [
  { id: 'week', label: 'Week' },
  { id: 'month', label: 'Month' },
  { id: '6months', label: '6 Months' },
  { id: 'custom', label: 'Custom' },
] as const
type ChartRange = typeof CHART_RANGES[number]['id']



// bp palette — eight progressively lighter shades of the same blue ramp
// so per-user / per-category slices on the bar chart and the work-category
// pie stay visually distinct while reading as one cohesive gradient.

const PIE_COLORS = ['var(--bp-900)', 'var(--bp-800)', 'var(--bp-700)', 'var(--bp-600)', 'var(--bp-500)', 'var(--bp-400)', 'var(--bp-300)', 'var(--bp-200)']

// ── Donut pie (hours by category) ────────────────────────────────────────

function LiquidGlassPie({ data, title }: {
  data: { name: string; value: number }[]
  title: string
}) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null)
  const total = data.reduce((s, d) => s + d.value, 0)
  const active = activeIndex !== null ? data[activeIndex] : null

  const CustomTooltip = ({ active, payload }: {
    active?: boolean
    payload?: { name: string; value: number; payload: { name: string; value: number } }[]
  }) => {
    if (!active || !payload?.length) return null
    const idx = data.findIndex(d => d.name === payload[0].name)
    const color = PIE_COLORS[idx % PIE_COLORS.length]
    return (
      <div className="bg-white border border-[#C5CAD1] rounded-[6px] px-3.5 py-2.5 shadow-lg min-w-[130px]">
        <div className="flex items-center gap-2 mb-1">
          <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: color }} />
          <span className="text-xs font-semibold text-[#111827]">{payload[0].name}</span>
        </div>
        <p className="text-base font-semibold text-[#111827] tracking-tight">{payload[0].value}h</p>
        <p className="text-[10px] font-semibold text-[#9CA3AF]">{total > 0 ? Math.round((payload[0].value / total) * 100) : 0}% of total</p>
      </div>
    )
  }

  const CustomLabel = ({ cx, cy, midAngle, innerRadius, outerRadius, index }: {
    cx: number; cy: number; midAngle: number; innerRadius: number; outerRadius: number; index: number
  }) => {
    if (index !== activeIndex) return null
    const RADIAN = Math.PI / 180
    const r = innerRadius + (outerRadius - innerRadius) * 0.5
    const x = cx + r * Math.cos(-midAngle * RADIAN)
    const y = cy + r * Math.sin(-midAngle * RADIAN)
    return (
      <text x={x} y={y} textAnchor="middle" dominantBaseline="central" fontSize={11} fontWeight={700} fill="white">
        {Math.round((data[index].value / total) * 100)}%
      </text>
    )
  }

  return (
    <div>
      <CardHead title={title} subtitle="This month, all team members" className="mb-4" />
      <div className="flex flex-col sm:flex-row items-center gap-4">
        <div className="relative shrink-0" style={{ width: 220, height: 200 }}>
          <div className="absolute inset-0 rounded-[6px] bg-[#F9FAFB] border border-[#C5CAD1]" />
          <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none z-10">
            {active ? (
              <>
                <span className="text-[11px] font-semibold text-center leading-tight px-2"
                  style={{ color: PIE_COLORS[activeIndex! % PIE_COLORS.length] }}>{active.name}</span>
                <span className="text-lg font-semibold text-[#111827] tracking-tight mt-0.5">{active.value}h</span>
              </>
            ) : (
              <>
                <span className={DS.eyebrow}>Total</span>
                <span className="text-xl font-semibold text-[#111827] tracking-tight">{total}h</span>
              </>
            )}
          </div>
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie data={data} dataKey="value" nameKey="name"
                cx="50%" cy="50%" innerRadius={52} outerRadius={80} paddingAngle={3}
                labelLine={false}
                label={CustomLabel as unknown as boolean}
                onMouseEnter={(_, i) => setActiveIndex(i)}
                onMouseLeave={() => setActiveIndex(null)}
                onClick={(_, i) => setActiveIndex(prev => prev === i ? null : i)}>
                {data.map((_, i) => {
                  const isActive = activeIndex === i
                  const color = PIE_COLORS[i % PIE_COLORS.length]
                  return (
                    <Cell key={i} fill={color}
                      stroke="var(--nv-surface)"
                      strokeWidth={isActive ? 2.5 : 1}
                      style={{
                        transform: isActive ? 'scale(1.05)' : 'scale(1)',
                        transformOrigin: 'center',
                        transition: 'all 0.2s ease',
                        cursor: 'pointer',
                        opacity: activeIndex !== null && !isActive ? 0.6 : 1,
                      }} />
                  )
                })}
              </Pie>
              <Tooltip content={<CustomTooltip />} />
            </PieChart>
          </ResponsiveContainer>
        </div>

        <div className="flex flex-wrap gap-x-5 gap-y-2.5">
          {data.map((entry, i) => {
            const color = PIE_COLORS[i % PIE_COLORS.length]
            const isActive = activeIndex === i
            return (
              <button key={i} onClick={() => setActiveIndex(prev => prev === i ? null : i)}
                className="flex items-center gap-2 transition-all cursor-pointer"
                style={{ opacity: activeIndex !== null && !isActive ? 0.45 : 1 }}>
                <span className="w-3 h-3 rounded-full shrink-0 transition-all" style={{
                  background: color,
                  transform: isActive ? 'scale(1.3)' : 'scale(1)',
                }} />
                <span className={cx('text-xs font-semibold', isActive ? 'text-[#111827]' : 'text-[#6B7280]')}>{entry.name}</span>
                <span className="text-xs font-semibold text-[#111827]">{entry.value}h</span>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// ── Submitters-per-day bar chart (capsule style) ─────────────────────────
// Same visual idiom as the user dashboard's WorkAnalyticsChart but the y-axis
// is a count of users who submitted (rather than hours logged).

// Team submissions per day, drawn exactly like the user dashboard's Work
// Activity chart: grey bars rising from the axis, the focused day in the
// primary colour with a dashed guide and a pill naming it. Today is focused
// until you hover. Click a bar for who submitted, or the space above it for
// who did not.
function SubmittersChart({ data, onBarClick, onMissingClick, loading, total }: {
  data: { day: string; count: number; total: number; date: string; isHoliday: boolean; isFuture: boolean }[]
  onBarClick?: (date: string) => void
  onMissingClick?: (date: string) => void
  loading?: boolean
  total: number  // total active branding users (denominator)
}) {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null)
  const [guide, setGuide] = useState<{ x: number; y: number } | null>(null)
  const guideKey = useRef('')

  const today = fmtDate(new Date())
  const currentIndex = data.findIndex(d => d.date === today)
  const lastArrived = data.reduce((best, d, i) => (d.isFuture ? best : i), 0)
  const focusIndex = hoveredIndex ?? (currentIndex !== -1 ? currentIndex : lastArrived)
  const focus = data[focusIndex]

  useEffect(() => { guideKey.current = ''; setGuide(null) }, [data])

  if (loading) {
    return <div className="flex items-center justify-center h-56"><Spinner /></div>
  }
  if (data.length === 0) {
    return <div className="flex items-center justify-center h-56 text-[13px] text-[#6B7280]">No data for this period</div>
  }

  // Scaled to the busiest period, not the headcount, so a day when three of
  // twenty-five filed is still a readable bar; the pill gives the full count.
  const ticks = evenTicks(Math.max(5, ...data.map(d => d.count)))
  const showHolidayLabel = data.length <= 14

  const DayBar = (props: {
    x?: number; y?: number; width?: number; height?: number; index?: number
    payload?: typeof data[number]
    background?: { x: number; y: number; width: number; height: number }
  }) => {
    const { x = 0, y = 0, width = 0, height = 0, payload, index = -1, background } = props
    if (width <= 0 || !payload) return null
    const isZero = payload.count <= 0
    const isFocus = index === focusIndex
    const missing = total - payload.count

    const barH = payload.isHoliday ? 22 : isZero ? 4 : Math.max(height, 4)
    const barY = payload.isHoliday || isZero ? y - barH : y - (barH - height)
    const r = Math.min(6, width / 2)
    const centre = x + width / 2

    if (isFocus) {
      const key = `${index}:${Math.round(centre)}:${Math.round(barY)}`
      if (guideKey.current !== key) {
        guideKey.current = key
        requestAnimationFrame(() => setGuide({ x: centre, y: barY }))
      }
    }

    const d = `M${x},${barY + barH} V${barY + r} Q${x},${barY} ${x + r},${barY} H${x + width - r} Q${x + width},${barY} ${x + width},${barY + r} V${barY + barH} Z`

    if (payload.isHoliday) {
      return (
        <g className="cursor-default">
          <path d={d} fill={CHART2.grid} />
          {showHolidayLabel && (
            <text x={centre} y={barY - 6} textAnchor="middle" fontSize={10} fill={CHART2.tick} fontWeight={500}>Holiday</text>
          )}
        </g>
      )
    }
    if (payload.isFuture) return <path d={d} fill={CHART2.grid} />

    const fill = isFocus && !isZero ? CHART2.highlight : hoveredIndex === index ? CHART2.barHover : CHART2.bar
    const openMissing = () => { if (payload.date && missing > 0) onMissingClick?.(payload.date) }
    return (
      <g>
        {/* The empty column above the bar is the "who didn't file" target. */}
        {background && (
          <rect x={background.x} y={background.y} width={background.width} height={background.height}
            fill="transparent" onClick={openMissing} className={missing > 0 ? 'cursor-pointer' : undefined} />
        )}
        <path
          d={d}
          fill={fill}
          style={{ transition: 'fill 150ms ease-out' }}
          className="cursor-pointer"
          onClick={e => { e.stopPropagation(); if (isZero) openMissing(); else if (payload.date) onBarClick?.(payload.date) }}
        />
      </g>
    )
  }

  const pill = focus?.isHoliday ? 'Holiday' : focus?.isFuture ? 'Upcoming' : `${focus?.count ?? 0} of ${total} filed`

  return (
    <div className="relative flex-1 min-h-[240px]">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={data}
          margin={{ top: 36, right: 0, left: 0, bottom: 0 }}
          barCategoryGap="28%"
          onMouseMove={(state: { activeTooltipIndex?: number }) => {
            const i = state?.activeTooltipIndex
            const next = typeof i === 'number' && i >= 0 && i < data.length ? i : null
            if (next !== hoveredIndex) setHoveredIndex(next)
          }}
          onMouseLeave={() => setHoveredIndex(null)}
        >
          <CartesianGrid vertical={false} stroke={CHART2.grid} />
          <XAxis dataKey="day" axisLine={false} tickLine={false} tick={{ fontSize: 12, fill: CHART2.tick }} dy={10}
            interval={data.length > 14 ? 'preserveStartEnd' : 0} minTickGap={8} />
          <YAxis orientation="left" domain={[0, ticks[ticks.length - 1]]} ticks={ticks} interval={0}
            axisLine={false} tickLine={false} allowDecimals={false}
            tick={{ fontSize: 12, fill: CHART2.tick }} width={34} dx={-4} />
          <Bar dataKey="count" background={{ fill: 'transparent' }} shape={(props: object) => <DayBar {...props} />} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>

      {guide && focus && (
        <div className="pointer-events-none absolute inset-0 z-10" aria-hidden="true">
          <svg className="absolute inset-0 w-full h-full overflow-visible">
            <line x1={34} x2={guide.x} y1={guide.y} y2={guide.y} stroke={CHART2.guide} strokeWidth={1.25} strokeDasharray="4 4" />
          </svg>
          <div className="absolute" style={{ left: guide.x, top: guide.y - 8, transform: 'translate(-50%, -100%)' }}>
            <ChartTip label={focus.day} value={pill} />
          </div>
        </div>
      )}
    </div>
  )
}

// ── Main component ───────────────────────────────────────────────────────

interface User { id: string; full_name: string; email: string; avatar_url: string | null }

export default function BrandingAdminOverview({ brandingUsers }: { brandingUsers: User[] }) {
  const navigate = useNavigate()
  // ── Top-level data ────────────────────────────────────────────────────
  const [projects, setProjects] = useState<BrandingProject[]>([])
  const [categories, setCategories] = useState<WorkCategory[]>([])
  const [leaves, setLeaves] = useState<BrandingLeave[]>([])
  const [monthReports, setMonthReports] = useState<DailyReport[]>([])

  // Chart range
  const [chartFilter, setChartFilter] = useState<'week' | 'month' | '6months' | 'custom'>('week')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')
  const [chartData, setChartData] = useState<{ day: string; count: number; total: number; date: string; isHoliday: boolean; isFuture: boolean }[]>([])
  const [chartReports, setChartReports] = useState<DailyReport[]>([])
  const [chartLoading, setChartLoading] = useState(false)

  // Drill-down: which day's submitters / non-submitters are we showing?
  const [drillDate, setDrillDate] = useState<string | null>(null)
  const [missingDate, setMissingDate] = useState<string | null>(null)

  // All Reports dialog
  const [allReportsOpen, setAllReportsOpen] = useState(false)

  // Projects Overview dialog — opened from the Total Projects stat card.
  // Lists each project, who's assigned, and hours each member logged on it.
  const [projectsOverviewOpen, setProjectsOverviewOpen] = useState(false)

  // ── Initial load: projects, categories, pending leaves, MTD reports ───
  useEffect(() => {
    brandingApi.getProjects().then(r => setProjects(r.projects)).catch(() => {})
    brandingApi.getCategories().then(r => setCategories(r.categories)).catch(() => {})
    brandingApi.getLeaves('pending').then(r => setLeaves(r.leaves)).catch(() => {})

    const now = new Date()
    const from = fmtDate(new Date(now.getFullYear(), now.getMonth(), 1))
    const to = fmtDate(now)
    brandingApi.getAllReports({ dateFrom: from, dateTo: to })
      .then(r => setMonthReports(r.reports))
      .catch(() => {})
  }, [])

  // ── Chart data (submitters per day) ───────────────────────────────────
  useEffect(() => {
    const now = new Date()
    let dateFrom: string, dateTo: string
    if (chartFilter === 'week') {
      const sunday = new Date(now); sunday.setDate(now.getDate() - now.getDay())
      const saturday = new Date(sunday); saturday.setDate(sunday.getDate() + 6)
      dateFrom = fmtDate(sunday); dateTo = fmtDate(saturday)
    } else if (chartFilter === 'month') {
      dateFrom = fmtDate(new Date(now.getFullYear(), now.getMonth(), 1))
      dateTo = fmtDate(now)
    } else if (chartFilter === '6months') {
      dateFrom = fmtDate(new Date(now.getFullYear(), now.getMonth() - 5, 1))
      dateTo = fmtDate(now)
    } else {
      if (!customFrom || !customTo) return
      dateFrom = customFrom; dateTo = customTo
    }

    setChartLoading(true)
    brandingApi.getAllReports({ dateFrom, dateTo, lockedOnly: true })
      .then(r => {
        setChartReports(r.reports)
        const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
        const MONTH_ABB = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
        const total = brandingUsers.length

        const submittersByDate = new Map<string, Set<string>>()
        for (const rep of r.reports) {
          if (!rep.is_locked) continue
          const set = submittersByDate.get(rep.report_date) ?? new Set<string>()
          set.add(rep.user_id)
          submittersByDate.set(rep.report_date, set)
        }

        // Sunday is the only off-day (matches countWorkingDays on the server).
        const isHolidayFor = (d: Date) => d.getDay() === 0
        // "Today" boundary uses the local-midnight equivalent of `now` so
        // that any day after today renders as the not-yet-arrived hatch.
        const todayMid = new Date(now.getFullYear(), now.getMonth(), now.getDate())
        const isFutureFor = (d: Date) => d.getTime() > todayMid.getTime()

        let data: typeof chartData = []
        if (chartFilter === 'week') {
          const sunday = parseDateLocal(dateFrom)
          data = Array.from({ length: 7 }, (_, i) => {
            const d = new Date(sunday); d.setDate(sunday.getDate() + i)
            const ds = fmtDate(d)
            return {
              day: DAY_LABELS[i],
              count: submittersByDate.get(ds)?.size ?? 0,
              total, date: ds, isHoliday: isHolidayFor(d), isFuture: isFutureFor(d),
            }
          })
        } else if (chartFilter === '6months') {
          // Month buckets aren't single days, so they're never marked as holidays.
          // A whole month is "future" only when its first day is past today.
          data = Array.from({ length: 6 }, (_, i) => {
            const ms = new Date(now.getFullYear(), now.getMonth() - 5 + i, 1)
            const me = new Date(ms.getFullYear(), ms.getMonth() + 1, 0)
            const set = new Set<string>()
            for (const [d, s] of submittersByDate) {
              const dd = parseDateLocal(d)
              if (dd >= ms && dd <= me) s.forEach(x => set.add(x))
            }
            return { day: MONTH_ABB[ms.getMonth()], count: set.size, total, date: fmtDate(ms), isHoliday: false, isFuture: isFutureFor(ms) }
          })
        } else {
          const from = parseDateLocal(dateFrom), to = parseDateLocal(dateTo)
          const out: typeof chartData = []
          const d = new Date(from)
          while (d <= to) {
            const ds = fmtDate(d)
            out.push({
              day: String(d.getDate()),
              count: submittersByDate.get(ds)?.size ?? 0,
              total, date: ds, isHoliday: isHolidayFor(d), isFuture: isFutureFor(d),
            })
            d.setDate(d.getDate() + 1)
          }
          data = out
        }
        setChartData(data)
      })
      .catch(e => toast.error(e instanceof Error ? e.message : 'Failed to load chart'))
      .finally(() => setChartLoading(false))
  }, [chartFilter, customFrom, customTo, brandingUsers.length])

  // ── Derived stats ─────────────────────────────────────────────────────
  const totalProjects = projects.length
  const runningProjects = projects.filter(p => p.status === 'active').length
  const submittedToday = useMemo(() => {
    const t = today()
    const set = new Set(monthReports.filter(r => r.report_date === t && r.is_locked).map(r => r.user_id))
    return set.size
  }, [monthReports])

  // Reports keyed to the people who actually submit (excludes admin /
  // reports-admin / super-admin entries). Drives every aggregation
  // below so admin rows can't pollute team totals.
  const submitterReports = useMemo(() => {
    const ids = new Set(brandingUsers.map(u => u.id))
    return monthReports.filter(r => ids.has(r.user_id))
  }, [monthReports, brandingUsers])

  const totalHoursMTD = useMemo(() => {
    let s = 0
    for (const rep of submitterReports) {
      for (const row of rep.rows) s += rowHours(row, submitterReports)
    }
    return Math.round(s * 10) / 10
  }, [submitterReports])

  // Per-user totals for the month — drives the Team Summary chart and
  // the "Read more" team list. (The dashboard top-4 strip uses
  // `todayTopUsers` below so it refreshes daily.)
  const userTotals = useMemo(() => {
    const map = new Map<string, { id: string; name: string; email: string; avatar_url: string | null; hours: number; reports: number }>()
    for (const u of brandingUsers) {
      map.set(u.id, { id: u.id, name: u.full_name || u.email, email: u.email, avatar_url: u.avatar_url, hours: 0, reports: 0 })
    }
    for (const rep of submitterReports) {
      const entry = map.get(rep.user_id)
      if (!entry) continue
      entry.reports += 1
      for (const row of rep.rows) entry.hours += rowHours(row, submitterReports)
    }
    return Array.from(map.values()).sort((a, b) => b.hours - a.hours)
  }, [submitterReports, brandingUsers])

  // Top contributors for TODAY only — drives the four cards on the
  // dashboard so the strip rolls over every day instead of staying
  // sticky on whoever led the month.
  const todayTopUsers = useMemo(() => {
    const t = today()
    const map = new Map<string, { id: string; name: string; email: string; avatar_url: string | null; hours: number; reports: number }>()
    for (const u of brandingUsers) {
      map.set(u.id, { id: u.id, name: u.full_name || u.email, email: u.email, avatar_url: u.avatar_url, hours: 0, reports: 0 })
    }
    for (const rep of submitterReports) {
      if (rep.report_date !== t) continue
      const entry = map.get(rep.user_id)
      if (!entry) continue
      entry.reports += 1
      for (const row of rep.rows) entry.hours += rowHours(row, submitterReports)
    }
    return Array.from(map.values())
      .filter(u => u.hours > 0)
      .sort((a, b) => b.hours - a.hours || a.name.localeCompare(b.name))
  }, [submitterReports, brandingUsers])

  // Team Summary chart data (current month).
  // `cap` is the chart's y-axis cap — we render every user against the
  // same maximum so the hatched backdrop reads as the team's high-water
  // mark. The actual hours get drawn as a filled capsule inside.
  const teamSummary = useMemo(() => {
    const top = userTotals.filter(u => u.hours > 0).slice(0, 10)
    return top.map(u => ({
      name: u.name.split(' ')[0] || u.name,
      hours: Math.round(u.hours * 10) / 10,
    }))
  }, [userTotals])
  const teamTicks = useMemo(() => evenTicks(teamSummary.reduce((m, u) => Math.max(m, u.hours), 0)), [teamSummary])

  // Hours by Category (pie data)
  const categoryHours = useMemo(() => {
    const m = new Map<string, number>()
    for (const rep of submitterReports) {
      for (const row of rep.rows) {
        const k = row.type_of_work || 'Uncategorized'
        m.set(k, (m.get(k) ?? 0) + rowHours(row, submitterReports))
      }
    }
    return Array.from(m.entries())
      .map(([name, value]) => ({ name, value: Math.round(value * 10) / 10 }))
      .filter(d => d.value > 0)
      .sort((a, b) => b.value - a.value)
  }, [submitterReports])

  // Collaboration map — by user pair. For each report row, every
  // (author, collaborator) tuple adds the row's hours to the pair's bucket.
  // Pair key is the two ids sorted so (A,B) and (B,A) merge into one entry.
  const collabByPair = useMemo(() => {
    const submitterIds = new Set(brandingUsers.map(u => u.id))
    const map = new Map<string, { a: string; b: string; hours: number; sessions: number; projects: Set<string> }>()
    for (const rep of submitterReports) {
      for (const row of rep.rows) {
        const hours = rowHours(row, submitterReports)
        if (!row.collaborative_colleagues || row.collaborative_colleagues.length === 0) continue
        for (const partnerId of row.collaborative_colleagues) {
          // Skip self, missing ids, and any collaborator that isn't a
          // submitter (e.g. an admin who got tagged) — admins never
          // appear in the dashboard's people surfaces.
          if (!partnerId || partnerId === rep.user_id) continue
          if (!submitterIds.has(partnerId)) continue
          const [a, b] = [rep.user_id, partnerId].sort()
          const key = `${a}::${b}`
          const entry = map.get(key) ?? { a, b, hours: 0, sessions: 0, projects: new Set<string>() }
          entry.hours += hours
          entry.sessions += 1
          entry.projects.add(row.specific_work || row.type_of_work || 'Untitled')
          map.set(key, entry)
        }
      }
    }
    return Array.from(map.values())
      .filter(e => e.hours > 0)
      .sort((a, b) => b.hours - a.hours)
  }, [submitterReports, brandingUsers])

  // ── Drill-down: who submitted on a given day ──────────────────────────
  const userById = useMemo(() => new Map(brandingUsers.map(u => [u.id, u])), [brandingUsers])

  const drillSubmitters = useMemo(() => {
    if (!drillDate) return []
    const reportsForDay = chartReports.filter(r => r.report_date === drillDate && r.is_locked)
    return reportsForDay.map(rep => {
      const hours = rep.rows.reduce((s, row) => s + rowHours(row, chartReports), 0)
      const u = userById.get(rep.user_id)
      return {
        id: rep.user_id,
        name: rep.user_name || rep.user_email || rep.user_id,
        email: u?.email ?? rep.user_email ?? '',
        avatar_url: u?.avatar_url ?? null,
        hours: Math.round(hours * 10) / 10,
        rowCount: rep.rows.length,
        submittedAt: rep.submitted_at,
      }
    }).sort((a, b) => b.hours - a.hours)
  }, [drillDate, chartReports, userById])

  // Non-submitters for a given day = brandingUsers minus anyone who locked
  // a report for that date in the chart fetch.
  const drillMissing = useMemo(() => {
    if (!missingDate) return []
    const submittedSet = new Set(
      chartReports
        .filter(r => r.report_date === missingDate && r.is_locked)
        .map(r => r.user_id)
    )
    return brandingUsers
      .filter(u => !submittedSet.has(u.id))
      .map(u => ({ id: u.id, name: u.full_name || u.email, email: u.email, avatar_url: u.avatar_url }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [missingDate, chartReports, brandingUsers])

  // ── Reminders ─────────────────────────────────────────────────────────
  const now = new Date()
  const pendingLeaves = leaves.filter(l => l.status === 'pending').length
  const appraisalDue = now.getDate() >= 20

  const handleBarClick = useCallback((date: string) => setDrillDate(date), [])
  const handleMissingClick = useCallback((date: string) => setMissingDate(date), [])

  // Hours behind the chart's range — the big figure and the Avg chip in
  // the Work Analytics head, same as the user dashboard's Work Activity.
  const chartHours = useMemo(() => {
    const ids = new Set(brandingUsers.map(u => u.id))
    const byDate = new Map<string, number>()
    for (const rep of chartReports) {
      if (!rep.is_locked || !ids.has(rep.user_id)) continue
      let h = 0
      for (const row of rep.rows) h += rowHours(row, chartReports)
      byDate.set(rep.report_date, (byDate.get(rep.report_date) ?? 0) + h)
    }
    let total = 0
    for (const v of byDate.values()) total += v
    return { total, avg: byDate.size > 0 ? Math.round((total / byDate.size) * 10) / 10 : null }
  }, [chartReports, brandingUsers])

  // en-US for the short month: en-GB renders September as "Sept".
  const stamp = `${now.toLocaleDateString('en-GB', { weekday: 'long' })} ${now.getDate()} ${now.toLocaleDateString('en-US', { month: 'short' })}`
  const missingToday = now.getDay() === 0 ? 0 : Math.max(0, brandingUsers.length - submittedToday)

  // Ordered by what to do first; only present while actually true.
  const attention: { title: string; body: string; run: () => void }[] = []
  if (pendingLeaves > 0) attention.push({
    title: `${pendingLeaves} leave request${pendingLeaves === 1 ? '' : 's'} pending`,
    body: 'Approve or reject in Leave Requests',
    run: () => navigate('/branding/leaves'),
  })
  if (appraisalDue) attention.push({
    title: 'KRA appraisal window open',
    body: `Review and publish ${MONTHS[now.getMonth()]} ${now.getFullYear()} scores`,
    run: () => navigate('/branding/kra'),
  })
  if (missingToday > 0) attention.push({
    title: `${missingToday} team member${missingToday === 1 ? '' : 's'} yet to file today`,
    body: 'See who has not submitted a report',
    run: () => setMissingDate(today()),
  })

  return (
    <div className="space-y-4 w-full">

      <HeroBanner
        eyebrow={<>Team workspace &middot; {stamp}</>}
        title="Your team's day, in one view."
        body="See who has filed, what hours are in, and where the work is."
        primary={{ label: 'Open all reports', onClick: () => setAllReportsOpen(true) }}
        secondary={{ label: 'Team members', onClick: () => navigate('/branding/team') }}
      />

      {/* ── At a glance: four figures for this month ──────────────────── */}
      <div>
        <BlockHeader
          title="At a glance"
          subtitle={<>{MONTHS[now.getMonth()]} {now.getFullYear()} &middot; branding team</>}
        />
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
          <DarkStatCard
            title="Total hours"
            value={fmtHours(totalHoursMTD)}
            sub={<>{now.getDate()} {MONTHS[now.getMonth()]} &middot; {submitterReports.length} report{submitterReports.length === 1 ? '' : 's'} filed</>}
            icon={Clock}
            onClick={() => setAllReportsOpen(true)}
          />
          <StatCard title="Total Projects" value={totalProjects} icon={Briefcase}
            sub={`${runningProjects} active`}
            onClick={() => setProjectsOverviewOpen(true)} />
          <StatCard title="Submitted Today" value={submittedToday} icon={CheckCircle}
            meter={{ done: submittedToday, total: brandingUsers.length, label: `of ${brandingUsers.length} team` }} />
          <StatCard title="Running Projects" value={runningProjects} icon={Activity}
            sub="active campaigns" />
        </div>
      </div>

      {/* ── Row 2: Work Analytics + Needs your attention ──────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
        <Card
          title="Work Analytics"
          subtitle="Team submissions · click a bar for names"
          className="lg:col-span-3"
          bodyClassName="flex flex-col flex-1"
          action={
            <>
              {chartHours.avg !== null && (
                <span className="hidden sm:inline-flex items-center h-8 px-3 rounded-[6px] text-[12px] font-medium whitespace-nowrap border border-[#C5CAD1] bg-white text-[#374151]">
                  Avg {chartHours.avg}{'\u00A0'}hr
                </span>
              )}
              <Segmented<ChartRange>
                round
                ariaLabel="Chart period"
                value={chartFilter}
                onChange={setChartFilter}
                options={[...CHART_RANGES]}
              />
            </>
          }
        >
          <div className="flex items-end justify-between gap-3 flex-wrap">
            <span className={L.figure}>
              {Math.floor(chartHours.total).toLocaleString()}
              <span>.{String(Math.round((chartHours.total % 1) * 100)).padStart(2, '0')}</span>
              <span className="text-[16px] text-[#6B7280] font-medium ml-1 tracking-normal">hr</span>
            </span>
            <div className="flex items-center gap-4 text-[12px] text-[#6B7280]">
              <span className="inline-flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-[var(--nerve-primary)]" aria-hidden="true" /> Submitted
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-[#F3F4F6] border border-[#C5CAD1]" aria-hidden="true" /> Holiday
              </span>
            </div>
          </div>

          {chartFilter === 'custom' && (
            <div className="flex items-center gap-2 mt-3 bg-[#F9FAFB] p-2.5 rounded-[6px] border border-[#C5CAD1]">
              <span className="text-xs font-medium text-[#6B7280]">From</span>
              <input type="date" value={customFrom} onChange={e => setCustomFrom(e.target.value)}
                className="text-xs px-2.5 py-1 rounded-[6px] border border-[#C5CAD1] bg-white focus:outline-none focus:border-[#9CA3AF]" />
              <span className="text-xs font-medium text-[#6B7280]">To</span>
              <input type="date" value={customTo} onChange={e => setCustomTo(e.target.value)}
                className="text-xs px-2.5 py-1 rounded-[6px] border border-[#C5CAD1] bg-white focus:outline-none focus:border-[#9CA3AF]" />
            </div>
          )}

          <div className="mt-2 flex-1 flex flex-col min-h-[240px]">
            <SubmittersChart data={chartData} loading={chartLoading} total={brandingUsers.length}
              onBarClick={handleBarClick} onMissingClick={handleMissingClick} />
          </div>
        </Card>

        {/* Needs your attention */}
        <Card title="Needs your attention" subtitle="Prioritised next steps" className="lg:col-span-2">
          {attention.length === 0 ? (
            <EmptyState compact icon={CheckCircle} title="Nothing needs your attention right now." />
          ) : (
            <ul className="divide-y divide-[#C5CAD1]">
              {attention.map((item, i) => (
                <NumberedItem key={item.title} n={i + 1} title={item.title} body={item.body}
                  action="Review" onAction={item.run} />
              ))}
            </ul>
          )}
        </Card>
      </div>

      {/* ── Row 3: All Reports (top-4 cards + open dialog) ────────────── */}
      <div className={cx(DS.card, 'p-4')}>
        <CardHead
          title="Today's Top Contributors"
          subtitle={<>Leaderboard for {now.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })} &middot; refreshes every day</>}
          link="See all"
          onLink={() => setAllReportsOpen(true)}
        />
        <div className="mt-4 grid grid-cols-2 lg:grid-cols-4 gap-3">
          {todayTopUsers.slice(0, 4).map(u => (
            <UserSummaryCard key={u.id} {...u} />
          ))}
          {todayTopUsers.length === 0 && (
            <div className="col-span-full">
              <EmptyState compact icon={UsersIcon} title="No one has logged hours today yet." />
            </div>
          )}
        </div>
        {userTotals.length > 0 && (
          <p className="mt-3 pt-2 border-t border-[#C5CAD1] text-xs font-medium text-[#9CA3AF] text-center">
            {userTotals.length} {userTotals.length === 1 ? 'member' : 'members'}
          </p>
        )}
      </div>

      {/* ── Row 4: Team Summary bar chart ─────────────────────────────── */}
      <Card title="Team Summary" subtitle="Hours logged per member this month (top 10)">
        {teamSummary.length === 0 ? (
          <EmptyState compact icon={Activity} title="No hours logged yet this month." />
        ) : (
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={teamSummary} margin={{ top: 8, right: 0, left: 0, bottom: 0 }} barCategoryGap="28%">
              <CartesianGrid vertical={false} stroke={CHART2.grid} />
              <XAxis dataKey="name" tick={{ fontSize: 12, fill: CHART2.tick }} tickLine={false} axisLine={false} dy={10}
                interval={teamSummary.length > 6 ? 'preserveStartEnd' : 0} minTickGap={8} />
              <YAxis domain={[0, teamTicks[teamTicks.length - 1]]} ticks={teamTicks} interval={0}
                tick={{ fontSize: 12, fill: CHART2.tick }} tickLine={false} axisLine={false} width={34} dx={-4} />
              <Tooltip cursor={{ fill: 'var(--nv-canvas)' }}
                content={(p: { active?: boolean; payload?: { payload: typeof teamSummary[number] }[]; label?: string }) => {
                  if (!p.active || !p.payload?.length) return null
                  return <ChartTip label={p.label} value={`${p.payload[0].payload.hours} hr`} />
                }} />
              <Bar dataKey="hours" fill={CHART2.highlight} radius={[6, 6, 0, 0]} maxBarSize={44} isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </Card>

      {/* ── Row 5: Hours by Category pie + Collaboration map ──────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className={cx(DS.card, 'p-4')}>
          {categoryHours.length === 0 ? (
            <>
              <CardHead title="Hours by Work Category" subtitle="This month, all team members" className="mb-4" />
              <EmptyState compact icon={Inbox} title="No data." />
            </>
          ) : (
            <LiquidGlassPie data={categoryHours} title="Hours by Work Category" />
          )}
        </div>

        <CollaborationMap items={collabByPair} userMap={brandingUsers} />
      </div>

      {/* ── Drill-down modal: who submitted on selected day ───────────── */}
      {drillDate && (
        <DayDrillModal date={drillDate} submitters={drillSubmitters} onClose={() => setDrillDate(null)} />
      )}

      {/* ── Drill-down modal: who DIDN'T submit on selected day ─────────── */}
      {missingDate && (
        <MissingDrillModal date={missingDate} missing={drillMissing} onClose={() => setMissingDate(null)} />
      )}

      {/* ── All Reports dialog ────────────────────────────────────────── */}
      {allReportsOpen && (
        <AllReportsDialog
          brandingUsers={brandingUsers}
          categories={categories}
          onClose={() => setAllReportsOpen(false)}
        />
      )}

      {/* ── Projects Overview dialog ──────────────────────────────────── */}
      {projectsOverviewOpen && (
        <ProjectsOverviewDialog
          projects={projects}
          monthReports={monthReports}
          brandingUsers={brandingUsers}
          onClose={() => setProjectsOverviewOpen(false)}
          onGoToProjects={() => {
            setProjectsOverviewOpen(false)
            navigate('/branding/team?tab=projects')
          }}
        />
      )}
    </div>
  )
}

// ── User summary card (top 4 + Read more) ────────────────────────────────

function UserSummaryCard({ name, email, hours, reports, avatar_url, onClick }: { name: string; email: string; hours: number; reports: number; avatar_url?: string | null; onClick?: () => void }) {
  const Wrapper = onClick ? 'button' : 'div'
  return (
    <Wrapper
      onClick={onClick}
      className={cx(
        'bg-white rounded-[6px] border border-[#C5CAD1] p-4 text-left w-full transition-colors duration-300 ease-out',
        onClick ? 'cursor-pointer hover:border-bp-700' : 'hover:border-bp-700',
      )}
    >
      <div className="flex items-center gap-3">
        <Avatar url={avatar_url} name={name} email={email} size="md" />
        <div className="min-w-0">
          <p className="text-sm font-semibold text-[#111827] truncate">{name}</p>
          <p className="text-[11px] text-[#6B7280] font-medium truncate">{email}</p>
        </div>
      </div>
      <div className="mt-3 flex items-end justify-between">
        <div>
          <p className="text-lg font-semibold tabular-nums leading-none text-[#111827] tracking-tight">
            {fmtHours(hours)}
          </p>
          <p className="text-[11px] mt-1 text-[#6B7280] font-medium">{reports} report{reports === 1 ? '' : 's'}</p>
        </div>
      </div>
    </Wrapper>
  )
}

// ── Day drill-down modal ─────────────────────────────────────────────────

function DayDrillModal({ date, submitters, onClose }: {
  date: string
  submitters: { id: string; name: string; email: string; avatar_url: string | null; hours: number; rowCount: number; submittedAt: string | null }[]
  onClose: () => void
}) {
  const label = new Date(date + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
  const totalHrs = Math.round(submitters.reduce((s, x) => s + x.hours, 0) * 10) / 10
  return (
    <Modal
      size="md"
      onClose={onClose}
      title={<>Submissions — {label}</>}
      subtitle={
        <span className="flex items-center gap-2">
          <CheckCircle className="w-3.5 h-3.5 text-emerald-500" /> {submitters.length} submitter{submitters.length === 1 ? '' : 's'}
          <span className="text-[#9CA3AF]">·</span>
          <span className="font-semibold text-[#374151]">{totalHrs} hrs total</span>
        </span>
      }
    >
      {submitters.length === 0 ? (
        <EmptyState icon={Inbox} title="No one submitted on this day." />
      ) : (
        <div className="overflow-x-auto">
          <table className={cx(DS.tableSoft, 'min-w-[460px]')}>
            <thead>
              <tr>
                <th className={DS.thSoft}>Colleague</th>
                <th className={DS.thSoft}>Activity</th>
                <th className={cx(DS.thSoft, 'text-center')}>Hours</th>
                <th className={cx(DS.thSoft, 'text-right')}>Status</th>
              </tr>
            </thead>
            <tbody>
              {submitters.map((s, idx) => (
                <tr key={s.id} className={idx % 2 === 0 ? DS.trSoftEven : DS.trSoftOdd}>
                  <td className={cx(DS.tdSoft, 'font-semibold text-[#111827]')}>
                    <div className="flex items-center gap-2 max-w-[200px]">
                      <Avatar url={s.avatar_url} name={s.name} email={s.email} size="xs" />
                      <span className="truncate">{s.name}</span>
                    </div>
                  </td>
                  <td className={cx(DS.tdSoft, 'font-normal text-[#6B7280] whitespace-nowrap')}>
                    {s.rowCount} entr{s.rowCount === 1 ? 'y' : 'ies'}
                    {s.submittedAt && ` · ${new Date(s.submittedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true })}`}
                  </td>
                  <td className={cx(DS.tdSoft, 'font-semibold text-[#374151] text-center whitespace-nowrap')}>
                    {s.hours > 0 ? fmtHours(s.hours) : '—'}
                  </td>
                  <td className={cx(DS.tdSoft, 'text-right whitespace-nowrap')}>
                    <StatusPill tone="success">Submitted</StatusPill>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  )
}

// ── Collaboration map (clickable, by project) ────────────────────────────

// Modal listing users who DIDN'T submit on the picked date. Triggered by
// clicking the slate portion of a bar in the Work Analytics chart.
function MissingDrillModal({ date, missing, onClose }: {
  date: string
  missing: { id: string; name: string; email: string; avatar_url: string | null }[]
  onClose: () => void
}) {
  const label = new Date(date + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
  return (
    <Modal
      size="md"
      onClose={onClose}
      title={<>Did NOT submit — {label}</>}
      subtitle={
        <span className="flex items-center gap-2">
          <AlertCircle className="w-3.5 h-3.5 text-amber-500" /> {missing.length} team member{missing.length === 1 ? '' : 's'} missing
        </span>
      }
    >
      {missing.length === 0 ? (
        <EmptyState icon={CheckCircle} title="Everyone submitted on this day." />
      ) : (
        <div className="overflow-x-auto">
          <table className={cx(DS.tableSoft, 'min-w-[400px]')}>
            <thead>
              <tr>
                <th className={DS.thSoft}>Colleague</th>
                <th className={DS.thSoft}>Email</th>
                <th className={cx(DS.thSoft, 'text-right')}>Status</th>
              </tr>
            </thead>
            <tbody>
              {missing.map((m, idx) => (
                <tr key={m.id} className={idx % 2 === 0 ? DS.trSoftEven : DS.trSoftOdd}>
                  <td className={cx(DS.tdSoft, 'font-semibold text-[#111827]')}>
                    <div className="flex items-center gap-2 max-w-[200px]">
                      <Avatar url={m.avatar_url} name={m.name} email={m.email} size="xs" />
                      <span className="truncate">{m.name}</span>
                    </div>
                  </td>
                  <td className={cx(DS.tdSoft, 'font-normal text-[#6B7280] max-w-[220px] truncate')}>{m.email}</td>
                  <td className={cx(DS.tdSoft, 'text-right whitespace-nowrap')}>
                    <StatusPill tone="warning">Pending</StatusPill>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  )
}

function CollaborationMap({ items, userMap }: {
  items: { a: string; b: string; hours: number; sessions: number; projects: Set<string> }[]
  userMap: User[]
}) {
  const [open, setOpen] = useState<string | null>(null)
  const userById = useMemo(() => new Map(userMap.map(u => [u.id, u])), [userMap])
  const nameFor = (id: string) => userById.get(id)?.full_name || userById.get(id)?.email || 'Unknown'

  const maxHours = items[0]?.hours ?? 0

  return (
    <div className={cx(DS.card, 'p-4')}>
      <CardHead title="Collaboration Map" subtitle="Hours each pair of team members spent working together this month" className="mb-4" />
      {items.length === 0 ? (
        <EmptyState compact icon={UsersIcon} title="No collaborative work yet this month." />
      ) : (
        <div className="space-y-2 max-h-[300px] overflow-y-auto pr-1">
          {items.slice(0, 15).map(item => {
            const key = `${item.a}::${item.b}`
            const isOpen = open === key
            const userA = userById.get(item.a)
            const userB = userById.get(item.b)
            const hrs = Math.round(item.hours * 10) / 10
            const widthPct = maxHours > 0 ? Math.max(8, (item.hours / maxHours) * 100) : 0
            return (
              <div key={key} className="rounded-[6px] border border-[#C5CAD1]">
                <button onClick={() => setOpen(isOpen ? null : key)}
                  className="w-full flex items-center gap-3 p-3 hover:bg-[#F9FAFB] transition-colors text-left cursor-pointer rounded-[6px]">
                  <div className="flex items-center -space-x-2 shrink-0">
                    <Avatar url={userA?.avatar_url} name={userA?.full_name} email={userA?.email}
                      size="sm" className="ring-2 ring-white" />
                    <Avatar url={userB?.avatar_url} name={userB?.full_name} email={userB?.email}
                      size="sm" className="ring-2 ring-white !bg-bp-700" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-[#111827] truncate">
                      {nameFor(item.a)} <span className="text-[#9CA3AF] font-normal">↔</span> {nameFor(item.b)}
                    </p>
                    <div className="mt-1 h-1.5 w-full rounded-full bg-[#F3F4F6] overflow-hidden">
                      <div className="h-full rounded-full bg-bp-600" style={{ width: `${widthPct}%` }} />
                    </div>
                    <p className="text-[11px] mt-1 text-[#6B7280] font-medium">
                      {hrs}h together · {item.sessions} session{item.sessions === 1 ? '' : 's'} · {item.projects.size} project{item.projects.size === 1 ? '' : 's'}
                    </p>
                  </div>
                  {isOpen ? <ChevronUp className="w-4 h-4 text-[#9CA3AF] shrink-0" /> : <ChevronDown className="w-4 h-4 text-[#9CA3AF] shrink-0" />}
                </button>
                {isOpen && (
                  <div className="px-3 pb-3 pt-1">
                    <p className={cx(DS.eyebrow, 'mb-1.5')}>Projects together</p>
                    <div className="flex flex-wrap gap-1.5">
                      {Array.from(item.projects).slice(0, 20).map(p => (
                        <Badge key={p} tone="info">{p}</Badge>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── Projects Overview dialog (opened from Total Projects stat card) ─────

// Lists every project, who's assigned, and how many hours each assigned
// member has logged against it this month. A row click takes the admin
// to the Team Members page with the Projects tab pre-selected.
function ProjectsOverviewDialog({ projects, monthReports, brandingUsers, onClose, onGoToProjects }: {
  projects: BrandingProject[]
  monthReports: DailyReport[]
  brandingUsers: User[]
  onClose: () => void
  onGoToProjects: () => void
}) {
  const userById = useMemo(() => new Map(brandingUsers.map(u => [u.id, u])), [brandingUsers])

  // For each project, accumulate hours-per-user and most-recent-log time
  // by matching report rows' `specific_work` against the project name
  // (case-insensitive). The dashboard pivots around this name today, so
  // this is the same join the rest of the dashboard uses.
  const projectStats = useMemo(() => {
    const byName = new Map<string, { hours: Map<string, number>; lastLogged: Map<string, string> }>()
    for (const proj of projects) {
      byName.set(proj.name.toLowerCase(), { hours: new Map(), lastLogged: new Map() })
    }
    for (const rep of monthReports) {
      for (const row of rep.rows) {
        const key = (row.specific_work || '').toLowerCase().trim()
        if (!key) continue
        const bucket = byName.get(key)
        if (!bucket) continue
        const h = rowHours(row, monthReports)
        bucket.hours.set(rep.user_id, (bucket.hours.get(rep.user_id) ?? 0) + h)
        const prev = bucket.lastLogged.get(rep.user_id)
        if (!prev || rep.report_date > prev) bucket.lastLogged.set(rep.user_id, rep.report_date)
      }
    }
    return projects.map(p => {
      const bucket = byName.get(p.name.toLowerCase())!
      const assignedIds = p.assigned_user_ids?.length ? p.assigned_user_ids : Array.from(bucket.hours.keys())
      const members = assignedIds.map(id => ({
        id,
        user: userById.get(id),
        hours: Math.round((bucket.hours.get(id) ?? 0) * 10) / 10,
        lastLogged: bucket.lastLogged.get(id) ?? null,
      }))
      const totalHours = Math.round(members.reduce((s, m) => s + m.hours, 0) * 10) / 10
      return { project: p, members, totalHours }
    }).sort((a, b) => {
      // Active projects first, then by total hours desc, name asc
      const aActive = a.project.status === 'active' ? 0 : 1
      const bActive = b.project.status === 'active' ? 0 : 1
      if (aActive !== bActive) return aActive - bActive
      if (b.totalHours !== a.totalHours) return b.totalHours - a.totalHours
      return a.project.name.localeCompare(b.project.name)
    })
  }, [projects, monthReports, userById])

  return (
    <Modal
      size="xl"
      onClose={onClose}
      title={
        <span className="flex items-center gap-2">
          <Briefcase className="w-5 h-5 text-bp-700" />
          Total Projects ({projects.length})
        </span>
      }
      subtitle="Who's assigned to what — and the hours logged on each project this month"
      footer={
        <button onClick={onGoToProjects} className={cx(DS.btn, DS.btnPrimary, DS.btnSm)}>
          Manage projects <ArrowRight className="w-3.5 h-3.5" />
        </button>
      }
    >
      <div className="space-y-3">
        {projectStats.length === 0 ? (
          <EmptyState icon={Briefcase} title="No projects yet." />
        ) : projectStats.map(({ project, members, totalHours }) => {
          return (
            <button
              key={project.id}
              onClick={onGoToProjects}
              className="w-full text-left bg-white rounded-[6px] border border-[#C5CAD1] hover:border-bp-700 transition-colors duration-300 ease-out p-4 group cursor-pointer">
              <div className="flex items-start justify-between gap-3 mb-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className={cx(DS.h3, 'truncate')}>{project.name}</h3>
                    <Badge tone={toneForStatus(project.status)} className="uppercase tracking-wider">
                      {project.status.replace('_', ' ')}
                    </Badge>
                    {project.deadline && (
                      <span className="text-[11px] font-semibold text-[#6B7280]">
                        Due {new Date(project.deadline).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}
                      </span>
                    )}
                  </div>
                  {project.description && (
                    <p className="text-xs text-[#6B7280] font-medium mt-1 line-clamp-2">{project.description}</p>
                  )}
                </div>
                <div className="text-right shrink-0">
                  <p className="text-xl font-semibold leading-none text-[#111827] tracking-tight">
                    {totalHours}<span className="text-xs font-semibold text-[#9CA3AF] ml-1">hrs</span>
                  </p>
                  <p className={cx(DS.muted, 'text-[10px] mt-0.5')}>this month</p>
                </div>
              </div>

              {members.length === 0 ? (
                <p className="text-xs text-[#9CA3AF] font-medium italic">No one assigned yet.</p>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {members.map(m => {
                    const name = m.user?.full_name || m.user?.email || 'Unknown'
                    return (
                      <div key={m.id} className="flex items-center gap-2 px-3 py-2 rounded-[6px] bg-[#F9FAFB] border border-[#C5CAD1]">
                        <Avatar url={m.user?.avatar_url} name={m.user?.full_name} email={m.user?.email} size="sm" />
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-semibold text-[#111827] truncate">{name}</p>
                          <p className="text-[10px] text-[#6B7280] font-medium">
                            {m.hours > 0
                              ? <>{m.hours}h logged{m.lastLogged ? ` · last ${new Date(m.lastLogged + 'T00:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}` : ''}</>
                              : <span className="text-[#9CA3AF]">No time logged yet</span>}
                          </p>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}

              <p className="mt-3 flex items-center gap-1 text-[11px] font-semibold text-bp-700 opacity-0 group-hover:opacity-100 transition-opacity">
                Open in Team Members → Projects <ArrowRight className="w-3 h-3" />
              </p>
            </button>
          )
        })}
      </div>
    </Modal>
  )
}

// ── All Reports dialog (top-4 cards + filters + per-row table) ──────────

interface AllReportsDialogProps {
  brandingUsers: User[]
  categories: WorkCategory[]
  onClose: () => void
}

function AllReportsDialog({ brandingUsers, categories, onClose }: AllReportsDialogProps) {
  function defaultFilters() {
    const now = new Date()
    const wk = new Date(now); wk.setDate(now.getDate() - 7)
    return {
      userIds: [] as string[],
      dateFrom: fmtDate(wk),
      dateTo: fmtDate(now),
      typeOfWork: '',
      subCategory: '',
      lockedOnly: false,
    }
  }
  const [filters, setFilters] = useState(defaultFilters)
  const [reports, setReports] = useState<DailyReport[]>([])
  const [loading, setLoading] = useState(false)
  const [userDropOpen, setUserDropOpen] = useState(false)
  const [detailUserId, setDetailUserId] = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    brandingApi.getAllReports({
      userIds:     filters.userIds.length > 0 ? filters.userIds : undefined,
      dateFrom:    filters.dateFrom    || undefined,
      dateTo:      filters.dateTo      || undefined,
      typeOfWork:  filters.typeOfWork  || undefined,
      subCategory: filters.subCategory || undefined,
      lockedOnly:  filters.lockedOnly  || undefined,
    })
      .then(r => setReports(r.reports))
      .catch(() => toast.error('Failed to load reports'))
      .finally(() => setLoading(false))
  }, [filters])

  // Every branding-team member (users + leads + admins) shows up here,
  // even when they have no reports for the active filter set — zero rows
  // is information too. Sorted by hours desc, name asc as a tiebreaker.
  const userCards = useMemo(() => {
    const map = new Map<string, { id: string; name: string; email: string; avatar_url: string | null; hours: number; reports: number }>()
    for (const u of brandingUsers) {
      map.set(u.id, { id: u.id, name: u.full_name || u.email, email: u.email, avatar_url: u.avatar_url, hours: 0, reports: 0 })
    }
    for (const rep of reports) {
      const entry = map.get(rep.user_id)
      if (!entry) continue
      entry.reports += 1
      for (const row of rep.rows) entry.hours += rowHours(row, reports)
    }
    return Array.from(map.values())
      .sort((a, b) => b.hours - a.hours || a.name.localeCompare(b.name))
  }, [reports, brandingUsers])

  const toggleUser = (id: string) =>
    setFilters(p => ({ ...p, userIds: p.userIds.includes(id) ? p.userIds.filter(u => u !== id) : [...p.userIds, id] }))

  const sortedReports = useMemo(() =>
    [...reports].sort((a, b) => {
      if (a.report_date !== b.report_date) return a.report_date < b.report_date ? 1 : -1
      const aT = a.submitted_at ? Date.parse(a.submitted_at) : 0
      const bT = b.submitted_at ? Date.parse(b.submitted_at) : 0
      return bT - aT
    }), [reports])

  const subCatOptions = categories.find(c => c.name === filters.typeOfWork)?.sub_categories || []

  function exportCSV() {
    const rows: string[][] = [['Date', 'User', 'Sr', 'Type of Work', 'Sub Category', 'Specific Work', 'Time Taken', 'Collaborators']]
    for (const r of reports)
      for (const row of r.rows)
        rows.push([r.report_date, r.user_name || '', String(row.sr_no), row.type_of_work, row.sub_category, row.specific_work, row.time_taken, row.collaborative_colleagues.join('; ')])
    const csv = rows.map(r => r.map(c => `"${(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\n')
    const a = document.createElement('a')
    a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv)
    a.download = `branding-reports-${today()}.csv`
    a.click()
    toast.success('CSV downloaded')
  }

  return (
    <>
      <Modal
        size="2xl"
        onClose={onClose}
        title="All Reports"
        subtitle={<>{userCards.length} contributor{userCards.length === 1 ? '' : 's'} matching filters — click a card for the full breakdown</>}
        footer={
          <button onClick={exportCSV} className={cx(DS.btn, DS.btnSecondary, DS.btnSm)}>
            <Download className="w-3.5 h-3.5" /> Export CSV
          </button>
        }
      >
        {/* Filter bar */}
        <div className={cx(DS.card, 'bg-[#F9FAFB] p-4 mb-4 grid grid-cols-2 lg:grid-cols-5 gap-3')}>
          <div className="relative">
            <label className={DS.label}>Users</label>
            <button type="button" onClick={() => setUserDropOpen(o => !o)} className={cx(DS.select, 'flex items-center justify-between text-left')}>
              <span className="truncate text-sm">
                {filters.userIds.length === 0 ? 'All users'
                  : filters.userIds.length === 1 ? (brandingUsers.find(u => u.id === filters.userIds[0])?.full_name || 'Unknown')
                  : `${filters.userIds.length} selected`}
              </span>
              <ChevronDown className="w-3.5 h-3.5 text-[#9CA3AF] shrink-0" />
            </button>
            {userDropOpen && (
              <div className="absolute z-40 top-full mt-1 left-0 w-full bg-white border border-[#C5CAD1] rounded-[6px] shadow-lg py-1 max-h-52 overflow-y-auto">
                <label className="flex items-center gap-2 px-3 py-1.5 hover:bg-bp-50 cursor-pointer">
                  <input type="checkbox" checked={filters.userIds.length === 0}
                    onChange={() => setFilters(p => ({ ...p, userIds: [] }))}
                    className="w-3.5 h-3.5 accent-bp-700" />
                  <span className="text-sm text-[#374151] font-medium">All users</span>
                </label>
                <div className={cx(DS.divider, 'my-1')} />
                {brandingUsers.map(u => (
                  <label key={u.id} className="flex items-center gap-2 px-3 py-1.5 hover:bg-bp-50 cursor-pointer">
                    <input type="checkbox" checked={filters.userIds.includes(u.id)}
                      onChange={() => toggleUser(u.id)}
                      className="w-3.5 h-3.5 accent-bp-700" />
                    <span className="text-sm text-[#374151] font-medium truncate">{u.full_name || u.email}</span>
                  </label>
                ))}
              </div>
            )}
          </div>
          <div>
            <label className={DS.label}>From</label>
            <input type="date" value={filters.dateFrom} onChange={e => setFilters(p => ({ ...p, dateFrom: e.target.value }))} className={DS.input} />
          </div>
          <div>
            <label className={DS.label}>To</label>
            <input type="date" value={filters.dateTo} onChange={e => setFilters(p => ({ ...p, dateTo: e.target.value }))} className={DS.input} />
          </div>
          <div>
            <label className={DS.label}>Type of Work</label>
            <select value={filters.typeOfWork}
              onChange={e => setFilters(p => ({ ...p, typeOfWork: e.target.value, subCategory: '' }))}
              className={DS.select}>
              <option value="">All types</option>
              {categories.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
            </select>
          </div>
          <div>
            <label className={DS.label}>Sub Category</label>
            <select value={filters.subCategory}
              onChange={e => setFilters(p => ({ ...p, subCategory: e.target.value }))}
              disabled={!filters.typeOfWork}
              className={DS.select}>
              <option value="">All sub-categories</option>
              {subCatOptions.map(s => <option key={s.id} value={s.name}>{s.name}</option>)}
            </select>
          </div>
        </div>

        <div>
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-[#9CA3AF] font-medium">
              <Spinner /> Loading…
            </div>
          ) : userCards.length === 0 ? (
            <EmptyState icon={Inbox} title="No reports match the current filters." />
          ) : (
            /* Every user matching the current filters is rendered as a
               clickable card. Clicking a card opens that user's
               detailed report popup. */
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              {userCards.map(u => (
                <UserSummaryCard key={u.id} {...u} onClick={() => setDetailUserId(u.id)} />
              ))}
            </div>
          )}
        </div>
      </Modal>

      {/* Per-user drill popup. Opens on UserSummaryCard click; the
          user can see every report for that person within the current
          filter set without leaving the All Reports dialog. */}
      {detailUserId && (
        <UserReportsDetailModal
          user={userCards.find(u => u.id === detailUserId) ?? null}
          reports={sortedReports.filter(r => r.user_id === detailUserId)}
          brandingUsers={brandingUsers}
          onClose={() => setDetailUserId(null)}
        />
      )}
    </>
  )
}

// ── Per-user drill popup inside All Reports ──────────────────────────────

// Tiny status badge — mirrors the one on the user dashboard so the
// admin sees exactly the same paused/finished/running pill the user
// submitted on the row.
function RowStatusBadge({ status }: { status: 'idle' | 'running' | 'paused' | 'finished' }) {
  const label = {
    idle:     'Not started',
    running:  'Running',
    paused:   'Paused',
    finished: 'Finished',
  }[status]
  return <Badge tone={toneForStatus(status)}>{label}</Badge>
}

function UserReportsDetailModal({ user, reports, brandingUsers, onClose }: {
  user: { id: string; name: string; email: string; avatar_url: string | null; hours: number; reports: number } | null
  reports: DailyReport[]
  brandingUsers: User[]
  onClose: () => void
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  // Lookup table so collaborator user-ids render as human names.
  const nameById = useMemo(() => {
    const m = new Map<string, string>()
    for (const u of brandingUsers) m.set(u.id, u.full_name || u.email || u.id)
    return m
  }, [brandingUsers])

  if (!user) return null
  const totalHrs = Math.round(reports.reduce((s, r) => s + r.rows.reduce((ss, rw) => ss + rowHours(rw, reports), 0), 0) * 10) / 10
  return (
    <Modal
      size="xl"
      onClose={onClose}
      title={
        <span className="flex items-center gap-3 min-w-0">
          <Avatar url={user.avatar_url} name={user.name} email={user.email} size="lg" />
          <span className="truncate">{user.name}</span>
        </span>
      }
      subtitle={<>{reports.length} report{reports.length === 1 ? '' : 's'} · {totalHrs}h on-day · {user.email}</>}
    >
      <div className="space-y-2">
        {reports.length === 0 ? (
          <EmptyState icon={Inbox} title="No reports for this user under the current filters." />
        ) : reports.map(r => {
          const dayHours = Math.round(r.rows.reduce((s, rw) => s + rowHours(rw, reports), 0) * 10) / 10
          const isOpen = expanded.has(r.id)
          return (
            <div key={r.id} className={cx(DS.card, 'overflow-hidden')}>
              <button onClick={() => setExpanded(p => { const s = new Set(p); if (s.has(r.id)) s.delete(r.id); else s.add(r.id); return s })}
                className={cx('w-full flex items-center gap-3 px-4 py-2.5 cursor-pointer', DS.trHover)}>
                <div className="flex-1 min-w-0 text-left">
                  <p className="text-sm font-semibold text-[#111827]">
                    {new Date(r.report_date + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}
                  </p>
                  <p className="text-xs text-[#6B7280] font-medium">
                    {r.rows.length} row{r.rows.length === 1 ? '' : 's'} · {dayHours}h on this day
                    {r.submitted_at && ` · submitted ${new Date(r.submitted_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true })}`}
                  </p>
                </div>
                {r.is_locked
                  ? <Badge tone="success"><Lock className="w-2.5 h-2.5 inline mr-0.5" />Submitted</Badge>
                  : <Badge tone="warning">Draft</Badge>}
                {isOpen ? <ChevronUp className="w-4 h-4 text-[#9CA3AF]" /> : <ChevronDown className="w-4 h-4 text-[#9CA3AF]" />}
              </button>
              {isOpen && (
                <div className="overflow-x-auto border-t border-[#C5CAD1]">
                  <table className={cx(DS.table, '!text-xs')}>
                    <thead className={DS.thead}>
                      <tr>
                        {['Sr', 'Type', 'Sub', 'Project', 'Status', 'Time today', 'Collaborators'].map(h => (
                          <th key={h} className={DS.th}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className={DS.tbody}>
                      {r.rows.map(row => {
                        const isCarried = !!row.carried_over_from_row_id
                        const hasStopwatch = row.elapsed_seconds > 0 || row.stopwatch_status !== 'idle'
                        const perDaySecs = hasStopwatch ? perDayElapsedSeconds(row, reports) : 0
                        return (
                          <tr key={row.id} className={DS.trHover}>
                            <td className={cx(DS.td, 'text-[#9CA3AF]')}>{row.sr_no}</td>
                            <td className={DS.td}>{row.type_of_work}</td>
                            <td className={cx(DS.td, 'text-[#6B7280]')}>{row.sub_category || '—'}</td>
                            <td className={DS.td}>
                              <span className="text-[#111827] font-medium">{row.specific_work}</span>
                              {isCarried && (
                                <span className="block text-[10px] text-[#9CA3AF] mt-0.5">Continued from a previous day</span>
                              )}
                            </td>
                            <td className={DS.td}>
                              <RowStatusBadge status={row.stopwatch_status} />
                              {row.stopwatch_status === 'paused' && row.last_paused_at && (
                                <div className="text-[10px] text-[#9CA3AF] mt-0.5">
                                  paused {new Date(row.last_paused_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true })}
                                </div>
                              )}
                            </td>
                            <td className={cx(DS.td, 'font-semibold whitespace-nowrap text-[#111827]')}>
                              {!hasStopwatch ? (
                                // Manual time entry — show what the user typed.
                                <>{row.time_taken}</>
                              ) : perDaySecs === 0 && isCarried ? (
                                <>
                                  <span className="text-[#9CA3AF]">—</span>
                                  <span className="block text-[10px] text-[#9CA3AF] font-normal">no new work today</span>
                                  <span className="block text-[10px] text-[#9CA3AF] font-normal">
                                    cumulative {elapsedToTimeTaken(row.elapsed_seconds)}
                                  </span>
                                </>
                              ) : (
                                <>
                                  {elapsedToTimeTaken(perDaySecs)}
                                  {row.elapsed_seconds !== perDaySecs && (
                                    <span className="block text-[10px] text-[#9CA3AF] font-normal">
                                      cumulative {elapsedToTimeTaken(row.elapsed_seconds)}
                                    </span>
                                  )}
                                </>
                              )}
                            </td>
                            <td className={cx(DS.td, 'text-[#6B7280]')}>
                              {row.collaborative_colleagues.length === 0
                                ? '—'
                                : row.collaborative_colleagues.map(id => nameById.get(id) || id).join(', ')}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </Modal>
  )
}
