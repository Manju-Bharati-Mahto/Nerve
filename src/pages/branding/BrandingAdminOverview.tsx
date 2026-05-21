/**
 * Admin Dashboard overview — replaces the bare "Daily Reports" table on the
 * branding-admin Daily Reports tab. Mirrors the visual language of the
 * Branding User dashboard (dark green serif, glassy stat cards, capsule bar
 * charts) but the data shown is team-aggregated:
 *
 *   • 4 stat cards (Total Projects / Submitted Today / Running Projects / Total Hours MTD)
 *   • Work Analytics — submitters per day, with date filter + click-to-drill modal
 *   • Reminders — pending leaves + KRA appraisal window
 *   • All Reports dialog — top-4 user cards + Read more + full filter UI
 *   • Team Summary bar chart
 *   • Hours by Category pie + Collaboration map side by side
 */
import { useState, useEffect, useMemo, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ArrowUpRight, Plus, AlertCircle, ChevronDown, ChevronUp, CheckCircle,
  Download, Lock, Filter, X, Users as UsersIcon, Award, ArrowRight, Briefcase,
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

// ── Color tokens (match user dashboard) ──────────────────────────────────

const GREEN_DARK = '#1a472a'
const GREEN_MID = '#52b788'
const GREEN_LIGHT = '#74c69d'
const GREEN_BG = '#f4f7f4'
const HATCH_ID = 'admin-bar-hatch'
const FUTURE_HATCH_ID = 'admin-bar-future-hatch'
const TEAM_HATCH_ID = 'admin-team-hatch'

// Peacock-green palette — eight progressively lighter shades of the
// same teal-green family so per-user / per-category slices on the bar
// chart and the work-category pie stay visually distinct while reading
// as one cohesive peacock-feather gradient.
const TEAM_COLORS = ['#013F37', '#015D52', '#017A6A', '#009B82', '#0BB196', '#3FC8AC', '#7DD8C1', '#B9E7D6']

const PIE_COLORS = ['#013F37', '#015D52', '#017A6A', '#009B82', '#0BB196', '#3FC8AC', '#7DD8C1', '#B9E7D6']

// ── StatCard (mirrors user dashboard) ────────────────────────────────────

function StatCard({ title, value, sub, badge, dark, onClick }: {
  title: string
  value: string | number
  sub?: string
  badge?: number
  dark?: boolean
  onClick?: () => void
}) {
  return (
    <div
      onClick={onClick}
      className={`rounded-2xl p-5 flex flex-col justify-between min-h-[130px] relative overflow-hidden ${onClick ? 'cursor-pointer' : ''}`}
      style={dark ? {
        background: 'linear-gradient(135deg, #1a472a 0%, #2d6a4f 45%, #40916c 100%)',
        color: 'white',
      } : { background: 'white', border: '1px solid #f3f4f6' }}
    >
      {dark && (
        <div className="absolute inset-0 pointer-events-none"
          style={{ background: 'radial-gradient(ellipse at 80% 20%, rgba(255,255,255,0.10) 0%, transparent 65%)' }} />
      )}
      <div className="relative flex items-start justify-between">
        <p className={`text-sm font-medium ${dark ? 'text-green-200' : 'text-gray-500'}`}>{title}</p>
        <div className={`w-8 h-8 rounded-full border flex items-center justify-center ${dark ? 'border-green-500/60 bg-white/10' : 'border-gray-200'}`}>
          <ArrowUpRight className={`w-3.5 h-3.5 ${dark ? 'text-white' : 'text-gray-400'}`} />
        </div>
      </div>
      <div className="relative">
        <p className={`text-4xl font-bold leading-none ${dark ? 'text-white' : 'text-gray-800'}`}>{value}</p>
        {badge !== undefined && (
          <div className="flex items-center gap-2 mt-2.5">
            <span className={`flex items-center gap-0.5 text-[11px] font-semibold px-1.5 py-0.5 rounded ${dark ? 'bg-white/15 text-green-100' : 'bg-green-100 text-green-700'}`}>
              {badge}<ArrowUpRight className="w-3 h-3" />
            </span>
            <span className={`text-xs ${dark ? 'text-green-200' : 'text-gray-500'}`}>{sub ?? 'across the team'}</span>
          </div>
        )}
        {sub && badge === undefined && (
          <p className={`text-xs mt-2 ${dark ? 'text-green-200' : 'text-gray-500'}`}>{sub}</p>
        )}
      </div>
    </div>
  )
}

// ── Liquid-glass donut pie (mirrors LiquidGlassPie in BrandingUserDashboard) ──

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
      <div style={{
        background: 'rgba(255,255,255,0.22)',
        backdropFilter: 'blur(18px)',
        WebkitBackdropFilter: 'blur(18px)',
        border: '1px solid rgba(255,255,255,0.45)',
        borderRadius: 14,
        padding: '10px 14px',
        boxShadow: '0 8px 32px rgba(26,71,42,0.18)',
        minWidth: 130,
      }}>
        <div className="flex items-center gap-2 mb-1">
          <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: color, boxShadow: `0 0 6px ${color}99` }} />
          <span className="text-xs font-bold" style={{ color: GREEN_DARK }}>{payload[0].name}</span>
        </div>
        <p className="text-base font-extrabold" style={{ color }}>{payload[0].value}h</p>
        <p className="text-[10px] font-semibold text-gray-400">{total > 0 ? Math.round((payload[0].value / total) * 100) : 0}% of total</p>
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
      <h3 className="text-lg font-extrabold font-serif mb-1" style={{ color: GREEN_DARK }}>{title}</h3>
      <p className="text-xs font-semibold mb-4" style={{ color: GREEN_MID }}>This month, all team members</p>
      <div className="flex flex-col sm:flex-row items-center gap-5">
        <div className="relative shrink-0" style={{ width: 220, height: 200 }}>
          <div className="absolute inset-0 rounded-2xl" style={{
            background: 'linear-gradient(135deg, rgba(255,255,255,0.55) 0%, rgba(210,240,220,0.35) 100%)',
            backdropFilter: 'blur(12px)',
            WebkitBackdropFilter: 'blur(12px)',
            border: '1px solid rgba(255,255,255,0.65)',
            boxShadow: '0 4px 24px rgba(26,71,42,0.10), inset 0 1px 0 rgba(255,255,255,0.8)',
          }} />
          <div className="absolute inset-0 rounded-2xl pointer-events-none" style={{
            background: 'radial-gradient(ellipse at 30% 20%, rgba(255,255,255,0.50) 0%, transparent 60%)',
          }} />
          <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none z-10">
            {active ? (
              <>
                <span className="text-[11px] font-semibold text-center leading-tight px-2"
                  style={{ color: PIE_COLORS[activeIndex! % PIE_COLORS.length] }}>{active.name}</span>
                <span className="text-lg font-extrabold mt-0.5" style={{ color: GREEN_DARK }}>{active.value}h</span>
              </>
            ) : (
              <>
                <span className="text-[10px] font-semibold text-gray-400">Total</span>
                <span className="text-xl font-extrabold" style={{ color: GREEN_DARK }}>{total}h</span>
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
                      stroke={isActive ? 'rgba(255,255,255,0.8)' : 'rgba(255,255,255,0.3)'}
                      strokeWidth={isActive ? 2.5 : 1}
                      style={{
                        filter: isActive ? `drop-shadow(0 0 8px ${color}cc)` : undefined,
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
                className="flex items-center gap-2 transition-all"
                style={{ opacity: activeIndex !== null && !isActive ? 0.45 : 1 }}>
                <span className="w-3 h-3 rounded-full shrink-0 transition-all" style={{
                  background: color,
                  boxShadow: isActive ? `0 0 8px ${color}cc` : 'none',
                  transform: isActive ? 'scale(1.3)' : 'scale(1)',
                }} />
                <span className="text-xs font-semibold" style={{ color: isActive ? GREEN_DARK : GREEN_MID }}>{entry.name}</span>
                <span className="text-xs font-bold" style={{ color: GREEN_DARK }}>{entry.value}h</span>
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

function roundedTopPath(x: number, y: number, w: number, h: number, r: number) {
  return `M${x + r},${y} h${w - 2 * r} a${r},${r} 0 0 1 ${r},${r} v${h - r} h${-w} v${-(h - r)} a${r},${r} 0 0 1 ${r},${-r}z`
}

// Fully-rounded pill (top AND bottom). Clamps r so the path stays valid
// when the rectangle is shorter than 2r or narrower than 2r — at that
// point both endcaps merge into one curved blob, which is what we want
// for "almost zero" bars instead of a degenerate path.
function capsulePath(x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2))
  if (rr <= 0) return ''
  const x2 = x + w
  const y2 = y + h
  return `M${x + rr},${y}`
    + ` H${x2 - rr}`
    + ` A${rr},${rr} 0 0 1 ${x2},${y + rr}`
    + ` V${y2 - rr}`
    + ` A${rr},${rr} 0 0 1 ${x2 - rr},${y2}`
    + ` H${x + rr}`
    + ` A${rr},${rr} 0 0 1 ${x},${y2 - rr}`
    + ` V${y + rr}`
    + ` A${rr},${rr} 0 0 1 ${x + rr},${y}`
    + ` Z`
}

function SubmittersChart({ data, onBarClick, onMissingClick, loading, total }: {
  data: { day: string; count: number; total: number; date: string; isHoliday: boolean; isFuture: boolean }[]
  onBarClick?: (date: string) => void
  onMissingClick?: (date: string) => void
  loading?: boolean
  total: number  // total active branding users (denominator)
}) {
  if (loading) {
    return (
      <div className="flex items-center justify-center h-44">
        <div className="w-5 h-5 border-2 border-green-200 border-t-green-700 rounded-full animate-spin" />
      </div>
    )
  }
  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-44 text-sm font-semibold" style={{ color: GREEN_MID }}>
        No data for this period
      </div>
    )
  }

  const CustomTooltip = (p: { active?: boolean; payload?: { payload: typeof data[number] }[]; label?: string }) => {
    if (!p.active || !p.payload?.length) return null
    const d = p.payload[0].payload
    if (d.isFuture && !d.isHoliday) {
      return (
        <div className="bg-white border border-gray-100 rounded-xl px-3 py-2.5 shadow-lg text-xs min-w-[140px]">
          <p className="font-bold mb-1" style={{ color: GREEN_DARK }}>{p.label}</p>
          <p className="font-semibold text-gray-500">Hasn't arrived yet</p>
        </div>
      )
    }
    if (d.isHoliday) {
      return (
        <div className="bg-white border border-gray-100 rounded-xl px-3 py-2.5 shadow-lg text-xs min-w-[140px]">
          <p className="font-bold mb-1" style={{ color: GREEN_DARK }}>{p.label}</p>
          <p className="font-semibold text-gray-500">Holiday — no reports expected</p>
        </div>
      )
    }
    const missing = total - d.count
    return (
      <div className="bg-white border border-gray-100 rounded-xl px-3 py-2.5 shadow-lg text-xs min-w-[160px]">
        <p className="font-bold mb-1" style={{ color: GREEN_DARK }}>{p.label}</p>
        <p className="font-semibold text-gray-700">{d.count} submitted</p>
        <p className="font-semibold text-gray-500">{missing} didn't submit</p>
        {d.count > 0 && (
          <p className="font-semibold mt-1" style={{ color: GREEN_MID }}>Click to view details</p>
        )}
      </div>
    )
  }

  // Single custom shape per category. Renders either a hatched capsule
  // (holiday) or two stacked capsules — light green for the whole bar
  // (non-submitters) with a smaller dark-green capsule on top with its own
  // rounded top (submitters). Each region gets its own click handler so the
  // user can drill into either group.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const StackedBar = (props: any) => {
    const { x = 0, y = 0, width = 0, height = 0 } = props
    const payload = props?.payload as typeof data[number] | undefined
    if (!payload || width <= 0 || height <= 0) return null
    const fullR = width / 2
    const fullPath = roundedTopPath(x, y, width, height, fullR)

    // Holiday OR future-day → render only the hatched backdrop (no count
    // fill, no click handler). Future days use a slightly cooler stripe so
    // they're visually distinguishable from holidays even though both read
    // as "no submission expected here".
    if (payload.isHoliday || payload.isFuture) {
      const patternId = payload.isHoliday ? HATCH_ID : FUTURE_HATCH_ID
      return (
        <g>
          <path d={fullPath} fill="#eaf3ea" opacity={0.6} />
          <path d={fullPath} fill={`url(#${patternId})`} />
        </g>
      )
    }

    const safeTotal = total > 0 ? total : 1
    const countH = (payload.count / safeTotal) * height
    const countY = y + height - countH
    const missing = safeTotal - payload.count

    // Dark capsule radius is clamped so very small fractions still render
    // as a half-pill rather than a degenerate path. When countH is large
    // enough we get a full pill (matching the outer capsule width).
    const darkR = Math.min(fullR, Math.max(1, countH / 2))
    const darkPath = countH > 1
      ? roundedTopPath(x, countY, width, countH, darkR)
      : null

    return (
      <g>
        {/* Light green full capsule = non-submitters. Clickable when
            there's at least one non-submitter to drill into. */}
        <path
          d={fullPath}
          fill={GREEN_LIGHT}
          opacity={0.9}
          onClick={() => { if (payload.date && missing > 0) onMissingClick?.(payload.date) }}
          style={{ cursor: payload.date && missing > 0 && onMissingClick ? 'pointer' : 'default' }}
        />
        {/* Dark green capsule on top with rounded curvy top — sits inside
            the light one; click here drills into the submitters. */}
        {darkPath && (
          <path
            d={darkPath}
            fill={GREEN_DARK}
            onClick={(e) => { e.stopPropagation(); if (payload.date && payload.count > 0) onBarClick?.(payload.date) }}
            style={{ cursor: payload.date && payload.count > 0 && onBarClick ? 'pointer' : 'default' }}
          />
        )}
      </g>
    )
  }

  return (
    <ResponsiveContainer width="100%" height={210}>
      <BarChart data={data} margin={{ top: 10, right: 4, left: -20, bottom: 0 }} barCategoryGap="28%">
        <defs>
          <pattern id={HATCH_ID} patternUnits="userSpaceOnUse" width="8" height="8" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="8" stroke="#a8c5a8" strokeWidth="2.5" />
          </pattern>
          <pattern id={FUTURE_HATCH_ID} patternUnits="userSpaceOnUse" width="8" height="8" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="8" stroke="#cdd6cd" strokeWidth="2.5" />
          </pattern>
        </defs>
        <CartesianGrid vertical={false} stroke="#f0f4f0" strokeDasharray="4 4" />
        <XAxis dataKey="day" axisLine={false} tickLine={false}
          tick={{ fontSize: 11, fill: '#9ca3af', fontWeight: 600 }} />
        <YAxis axisLine={false} tickLine={false}
          tick={{ fontSize: 10, fill: '#b0c0b0' }}
          allowDecimals={false}
          domain={[0, Math.max(total, 1)]}
          tickFormatter={v => `${v}`} />
        <Tooltip content={<CustomTooltip />} cursor={{ fill: 'rgba(240,247,240,0.6)' }} />
        <Bar dataKey="total" shape={StackedBar} />
      </BarChart>
    </ResponsiveContainer>
  )
}

// ── Main component ───────────────────────────────────────────────────────

interface User { id: string; full_name: string; email: string; avatar_url: string | null }

// Small avatar that uses the user's avatar_url when available, falling back
// to coloured initials. Used everywhere a person is rendered on the admin
// dashboard so the look stays consistent.
function Avatar({ url, name, email, sizeClass = 'w-9 h-9', textClass = 'text-xs', bg = 'bg-green-100 text-green-800', ring }: {
  url?: string | null
  name?: string
  email?: string
  sizeClass?: string
  textClass?: string
  bg?: string
  ring?: string
}) {
  const initials =
    (name || '').split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase()
    || email?.[0]?.toUpperCase()
    || 'U'
  const ringCls = ring ?? ''
  if (url) {
    return (
      <img
        src={url}
        alt={name || email || 'avatar'}
        className={`${sizeClass} rounded-full object-cover shrink-0 ${ringCls}`}
      />
    )
  }
  return (
    <div className={`${sizeClass} rounded-full ${bg} flex items-center justify-center ${textClass} font-bold shrink-0 ${ringCls}`}>
      {initials}
    </div>
  )
}

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
        const DAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']
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
    const cap = top.reduce((m, u) => Math.max(m, u.hours), 0)
    return top.map((u, i) => ({
      name: u.name.split(' ')[0] || u.name,
      hours: Math.round(u.hours * 10) / 10,
      color: TEAM_COLORS[i % TEAM_COLORS.length],
      cap: Math.max(cap, 1),
    }))
  }, [userTotals])

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

  return (
    <div className="space-y-5">

      {/* ── Row 1: 4 stat cards ───────────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard title="Total Projects" value={totalProjects} dark
          sub={`${runningProjects} active`}
          onClick={() => setProjectsOverviewOpen(true)} />
        <StatCard title="Submitted Today" value={submittedToday}
          badge={submittedToday}
          sub={`of ${brandingUsers.length} team`} />
        <StatCard title="Running Projects" value={runningProjects}
          badge={runningProjects}
          sub="active campaigns" />
        <StatCard title="Total Hours" value={totalHoursMTD} sub="this month" />
      </div>

      {/* ── Row 2: Work Analytics + Reminders ─────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
        <div className="lg:col-span-3 bg-white rounded-2xl border border-gray-100 p-5">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h3 className="text-lg font-bold" style={{ color: GREEN_DARK }}>Work Analytics</h3>
              <p className="text-xs font-semibold mt-0.5" style={{ color: GREEN_MID }}>
                Team members who submitted per day
              </p>
            </div>
            <div className="flex items-center gap-3 text-xs font-semibold flex-wrap" style={{ color: GREEN_MID }}>
              <span className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-sm inline-block" style={{ background: GREEN_DARK }} />
                Submitted
              </span>
              <span className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-sm inline-block" style={{ background: GREEN_LIGHT }} />
                Didn't submit
              </span>
              <span className="flex items-center gap-1.5">
                <svg width="10" height="10" style={{ display: 'inline-block' }}>
                  <defs>
                    <pattern id="admin-legend-hatch" patternUnits="userSpaceOnUse" width="4" height="4" patternTransform="rotate(45)">
                      <line x1="0" y1="0" x2="0" y2="4" stroke="#a8c5a8" strokeWidth="1.5" />
                    </pattern>
                  </defs>
                  <rect width="10" height="10" rx="2" fill="#eaf3ea" />
                  <rect width="10" height="10" rx="2" fill="url(#admin-legend-hatch)" />
                </svg>
                Holiday
              </span>
              <span className="flex items-center gap-1.5">
                <svg width="10" height="10" style={{ display: 'inline-block' }}>
                  <defs>
                    <pattern id="admin-legend-future" patternUnits="userSpaceOnUse" width="4" height="4" patternTransform="rotate(45)">
                      <line x1="0" y1="0" x2="0" y2="4" stroke="#cdd6cd" strokeWidth="1.5" />
                    </pattern>
                  </defs>
                  <rect width="10" height="10" rx="2" fill="#eaf3ea" opacity="0.6" />
                  <rect width="10" height="10" rx="2" fill="url(#admin-legend-future)" />
                </svg>
                Upcoming
              </span>
            </div>
          </div>

          {/* Filter buttons */}
          <div className="flex flex-wrap items-center gap-2 mb-4">
            {(['week', 'month', '6months', 'custom'] as const).map(f => (
              <button key={f} onClick={() => setChartFilter(f)}
                className={`px-3 py-1 rounded-lg text-xs font-semibold transition-colors ${
                  chartFilter === f ? 'text-white' : 'text-gray-500 bg-gray-100 hover:bg-gray-200'
                }`}
                style={chartFilter === f ? { background: GREEN_DARK } : {}}>
                {f === 'week' ? '1 Week' : f === 'month' ? '1 Month' : f === '6months' ? '6 Months' : 'Custom'}
              </button>
            ))}
            {chartFilter === 'custom' && (
              <div className="flex items-center gap-1.5 ml-1">
                <input type="date" value={customFrom} onChange={e => setCustomFrom(e.target.value)}
                  className="text-xs px-2 py-1 rounded-lg border border-gray-200 focus:outline-none focus:border-green-600" />
                <span className="text-xs text-gray-400">→</span>
                <input type="date" value={customTo} onChange={e => setCustomTo(e.target.value)}
                  className="text-xs px-2 py-1 rounded-lg border border-gray-200 focus:outline-none focus:border-green-600" />
              </div>
            )}
          </div>

          <SubmittersChart data={chartData} loading={chartLoading} total={brandingUsers.length}
            onBarClick={handleBarClick} onMissingClick={handleMissingClick} />
          <p className="text-center text-[11px] mt-2" style={{ color: GREEN_MID }}>
            Click a bar to view who submitted on that day
          </p>
        </div>

        {/* Reminders — same illustrated background as the user dashboard */}
        <div className="lg:col-span-2 rounded-2xl border border-gray-100 p-5 flex flex-col relative overflow-hidden">
          <img
            src="/reminders-bg.jpeg"
            alt=""
            aria-hidden="true"
            className="absolute inset-0 w-full h-full object-cover object-top pointer-events-none select-none"
            style={{ opacity: 0.55 }}
          />
          <div className="absolute inset-0 pointer-events-none rounded-2xl" style={{ background: 'rgba(255,255,255,0.50)' }} />
          <h3 className="relative z-10 text-lg font-bold mb-4" style={{ color: GREEN_DARK }}>Reminders</h3>
          <div className="relative z-10 space-y-3 flex-1">
            {pendingLeaves > 0 ? (
              <div className="rounded-xl bg-amber-50/90 border border-amber-100 p-4">
                <p className="text-sm font-semibold text-amber-800">{pendingLeaves} Leave Request{pendingLeaves === 1 ? '' : 's'} Pending</p>
                <p className="text-xs text-amber-600 mt-0.5">Review and approve/reject in Leave Requests</p>
              </div>
            ) : (
              <div className="rounded-xl bg-green-50/90 border border-green-100 p-4">
                <p className="text-sm font-semibold text-green-800">All Leaves Reviewed</p>
                <p className="text-xs text-green-600 mt-0.5">No pending requests</p>
              </div>
            )}
            {appraisalDue && (
              <div className="rounded-xl bg-blue-50/90 border border-blue-100 p-4">
                <p className="text-sm font-semibold text-blue-800">KRA Appraisal Window Open</p>
                <p className="text-xs text-blue-600 mt-0.5">
                  Review and publish {MONTHS[now.getMonth()]} {now.getFullYear()} scores
                </p>
              </div>
            )}
            {!appraisalDue && pendingLeaves === 0 && (
              <p className="text-xs text-gray-400 text-center py-4">Nothing urgent right now.</p>
            )}
          </div>
        </div>
      </div>

      {/* ── Row 3: All Reports (top-4 cards + open dialog) ────────────── */}
      <div className="bg-white rounded-2xl border border-gray-100 p-5">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-lg font-bold" style={{ color: GREEN_DARK }}>Today's Top Contributors</h3>
            <p className="text-xs font-semibold mt-0.5" style={{ color: GREEN_MID }}>
              Leaderboard for {now.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })} — refreshes every day.
            </p>
          </div>
          <button onClick={() => setAllReportsOpen(true)}
            className="flex items-center gap-1.5 text-xs font-semibold text-white px-3 py-2 rounded-xl"
            style={{ background: GREEN_DARK }}>
            <Filter className="w-3 h-3" /> Open detailed view
          </button>
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {todayTopUsers.slice(0, 4).map(u => (
            <UserSummaryCard key={u.id} {...u} />
          ))}
          {todayTopUsers.length === 0 && (
            <p className="text-sm text-gray-400 col-span-full text-center py-6">No one has logged hours today yet.</p>
          )}
        </div>
        {userTotals.length > 0 && (
          <button onClick={() => setAllReportsOpen(true)}
            className="w-full mt-3 py-2 text-xs font-semibold rounded-lg hover:bg-green-50 transition-colors"
            style={{ color: GREEN_DARK }}>
            See all {userTotals.length} team member{userTotals.length === 1 ? '' : 's'}
          </button>
        )}
      </div>

      {/* ── Row 4: Team Summary bar chart ─────────────────────────────── */}
      <div className="bg-white rounded-2xl border border-gray-100 p-5">
        <h3 className="text-lg font-bold mb-1" style={{ color: GREEN_DARK }}>Team Summary</h3>
        <p className="text-xs font-semibold mb-4" style={{ color: GREEN_MID }}>
          Hours logged per member this month (top 10)
        </p>
        {teamSummary.length === 0 ? (
          <p className="text-sm text-gray-400 text-center py-10">No hours logged yet this month.</p>
        ) : (
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={teamSummary} margin={{ top: 10, right: 8, left: -10, bottom: 0 }} barCategoryGap="22%">
              <defs>
                <pattern id={TEAM_HATCH_ID} patternUnits="userSpaceOnUse" width="7" height="7" patternTransform="rotate(45)">
                  <line x1="0" y1="0" x2="0" y2="7" stroke="#c8e0d8" strokeWidth="2" />
                </pattern>
              </defs>
              <CartesianGrid vertical={false} stroke="#f0f4f0" strokeDasharray="4 4" />
              <XAxis dataKey="name" tick={{ fontSize: 11, fill: '#6b7280', fontWeight: 700 }} tickLine={false} axisLine={false} />
              <YAxis tick={{ fontSize: 10, fill: '#b0c0b0' }} tickLine={false} axisLine={false} tickFormatter={v => `${v}h`} />
              <Tooltip cursor={{ fill: 'rgba(240,247,240,0.4)' }}
                content={(p: { active?: boolean; payload?: { payload: typeof teamSummary[number] }[]; label?: string }) => {
                  if (!p.active || !p.payload?.length) return null
                  const d = p.payload[0].payload
                  return (
                    <div className="bg-white border border-gray-100 rounded-xl px-3 py-2 shadow-lg text-xs">
                      <p className="font-bold" style={{ color: GREEN_DARK }}>{p.label}</p>
                      <p className="font-semibold" style={{ color: d.color }}>{d.hours} hrs</p>
                    </div>
                  )
                }} />
              {/* Single bar drawn with a custom shape: a hatched grey
                  capsule backdrop for the team's max, with the user's
                  actual hours rendered as a filled coloured capsule
                  inside. dataKey="cap" so the bar height matches the
                  shared maximum across all users. */}
              <Bar dataKey="cap" maxBarSize={44}
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                shape={(props: any) => {
                  const { x = 0, y = 0, width = 0, height = 0 } = props
                  const d = props?.payload as typeof teamSummary[number] | undefined
                  if (!d || width <= 0 || height <= 0) return null
                  const fullR = width / 2
                  const backdrop = capsulePath(x, y, width, height, fullR)
                  const fillFrac = d.cap > 0 ? Math.min(1, d.hours / d.cap) : 0
                  const fillH = Math.max(width, fillFrac * height) // never thinner than a pill
                  const fillY = y + height - Math.min(height, fillH)
                  const fillPath = capsulePath(x, fillY, width, Math.min(height, fillH), fullR)
                  return (
                    <g>
                      <path d={backdrop} fill="#ecf4f0" />
                      <path d={backdrop} fill={`url(#${TEAM_HATCH_ID})`} />
                      <path d={fillPath} fill={d.color} />
                    </g>
                  )
                }}
              />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* ── Row 5: Hours by Category pie + Collaboration map ──────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-white rounded-2xl border border-gray-100 p-5">
          {categoryHours.length === 0 ? (
            <>
              <h3 className="text-lg font-extrabold font-serif mb-1" style={{ color: GREEN_DARK }}>Hours by Work Category</h3>
              <p className="text-xs font-semibold mb-4" style={{ color: GREEN_MID }}>This month, all team members</p>
              <p className="text-sm text-gray-400 text-center py-10">No data.</p>
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
      className={`rounded-2xl border border-gray-100 p-4 bg-gradient-to-br from-white to-green-50/30 text-left w-full ${
        onClick ? 'cursor-pointer hover:border-green-300 hover:shadow-md hover:-translate-y-0.5 transition-all' : ''
      }`}
    >
      <div className="flex items-center gap-3">
        <Avatar url={avatar_url} name={name} email={email} sizeClass="w-10 h-10" textClass="text-xs" />
        <div className="min-w-0">
          <p className="text-sm font-bold font-serif truncate" style={{ color: GREEN_DARK }}>{name}</p>
          <p className="text-[11px] text-gray-400 truncate">{email}</p>
        </div>
      </div>
      <div className="mt-3 flex items-end justify-between">
        <div>
          <p className="text-2xl font-bold leading-none" style={{ color: GREEN_DARK }}>
            {Math.round(hours * 10) / 10}<span className="text-sm font-semibold text-gray-400 ml-1">hrs</span>
          </p>
          <p className="text-[11px] mt-1" style={{ color: GREEN_MID }}>{reports} report{reports === 1 ? '' : 's'}</p>
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
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-xl max-h-[80vh] overflow-hidden flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <div>
            <h2 className="text-base font-extrabold font-serif" style={{ color: GREEN_DARK }}>Submissions — {label}</h2>
            <p className="text-xs font-semibold mt-0.5 flex items-center gap-2" style={{ color: GREEN_MID }}>
              <CheckCircle className="w-3 h-3" /> {submitters.length} submitter{submitters.length === 1 ? '' : 's'}
              <span className="text-gray-300">·</span>
              <span className="font-semibold text-gray-700">{totalHrs} hrs total</span>
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 p-1"><X className="w-5 h-5" /></button>
        </div>
        <div className="overflow-y-auto flex-1 px-6 py-4 space-y-2">
          {submitters.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-12">No one submitted on this day.</p>
          ) : submitters.map(s => (
            <div key={s.id} className="flex items-center justify-between p-3 rounded-xl border border-gray-100 hover:bg-green-50/30 transition-colors">
              <div className="flex items-center gap-3 min-w-0">
                <Avatar url={s.avatar_url} name={s.name} email={s.email} sizeClass="w-9 h-9" textClass="text-xs" />
                <div className="min-w-0">
                  <p className="text-sm font-bold font-serif truncate" style={{ color: GREEN_DARK }}>{s.name}</p>
                  <p className="text-[11px]" style={{ color: GREEN_MID }}>
                    {s.rowCount} entr{s.rowCount === 1 ? 'y' : 'ies'}
                    {s.submittedAt && ` · submitted ${new Date(s.submittedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true })}`}
                  </p>
                </div>
              </div>
              <div className="text-right shrink-0 ml-3">
                <p className="text-lg font-bold" style={{ color: GREEN_DARK }}>{s.hours}<span className="text-xs text-gray-400 ml-0.5">h</span></p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ── Collaboration map (clickable, by project) ────────────────────────────

// Modal listing users who DIDN'T submit on the picked date. Triggered by
// clicking the light-green portion of a bar in the Work Analytics chart.
function MissingDrillModal({ date, missing, onClose }: {
  date: string
  missing: { id: string; name: string; email: string; avatar_url: string | null }[]
  onClose: () => void
}) {
  const label = new Date(date + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-xl max-h-[80vh] overflow-hidden flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <div>
            <h2 className="text-base font-extrabold font-serif" style={{ color: GREEN_DARK }}>Did NOT submit — {label}</h2>
            <p className="text-xs font-semibold mt-0.5 flex items-center gap-2" style={{ color: GREEN_MID }}>
              <AlertCircle className="w-3 h-3" /> {missing.length} team member{missing.length === 1 ? '' : 's'} missing
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 p-1"><X className="w-5 h-5" /></button>
        </div>
        <div className="overflow-y-auto flex-1 px-6 py-4 space-y-2">
          {missing.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-12">Everyone submitted on this day. 🎉</p>
          ) : missing.map(m => (
            <div key={m.id} className="flex items-center gap-3 p-3 rounded-xl border border-gray-100 hover:bg-amber-50/30 transition-colors">
              <Avatar url={m.avatar_url} name={m.name} email={m.email} sizeClass="w-9 h-9" textClass="text-xs" bg="bg-amber-100 text-amber-800" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-bold font-serif truncate" style={{ color: GREEN_DARK }}>{m.name}</p>
                <p className="text-[11px] text-gray-400 truncate">{m.email}</p>
              </div>
              <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 shrink-0">No report</span>
            </div>
          ))}
        </div>
      </div>
    </div>
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
    <div className="bg-white rounded-2xl border border-gray-100 p-5">
      <h3 className="text-lg font-bold mb-1" style={{ color: GREEN_DARK }}>Collaboration Map</h3>
      <p className="text-xs font-semibold mb-4" style={{ color: GREEN_MID }}>
        Hours each pair of team members spent working together this month
      </p>
      {items.length === 0 ? (
        <p className="text-sm text-gray-400 text-center py-10">No collaborative work yet this month.</p>
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
              <div key={key} className="rounded-xl border border-gray-100">
                <button onClick={() => setOpen(isOpen ? null : key)}
                  className="w-full flex items-center gap-3 p-3 hover:bg-green-50/30 transition-colors text-left">
                  <div className="flex items-center -space-x-2 shrink-0">
                    <Avatar url={userA?.avatar_url} name={userA?.full_name} email={userA?.email}
                      sizeClass="w-8 h-8" textClass="text-[11px]" ring="ring-2 ring-white" />
                    <Avatar url={userB?.avatar_url} name={userB?.full_name} email={userB?.email}
                      sizeClass="w-8 h-8" textClass="text-[11px]" bg="bg-emerald-100 text-emerald-800" ring="ring-2 ring-white" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-bold font-serif truncate" style={{ color: GREEN_DARK }}>
                      {nameFor(item.a)} <span className="text-gray-400 font-normal">↔</span> {nameFor(item.b)}
                    </p>
                    <div className="mt-1 h-1.5 w-full rounded-full bg-green-50 overflow-hidden">
                      <div className="h-full rounded-full" style={{ width: `${widthPct}%`, background: GREEN_DARK }} />
                    </div>
                    <p className="text-[11px] mt-1" style={{ color: GREEN_MID }}>
                      {hrs}h together · {item.sessions} session{item.sessions === 1 ? '' : 's'} · {item.projects.size} project{item.projects.size === 1 ? '' : 's'}
                    </p>
                  </div>
                  {isOpen ? <ChevronUp className="w-4 h-4 text-gray-400 shrink-0" /> : <ChevronDown className="w-4 h-4 text-gray-400 shrink-0" />}
                </button>
                {isOpen && (
                  <div className="px-3 pb-3 pt-1">
                    <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 mb-1.5">Projects together</p>
                    <div className="flex flex-wrap gap-1.5">
                      {Array.from(item.projects).slice(0, 20).map(p => (
                        <span key={p} className="text-[11px] px-2 py-1 rounded-full bg-green-50 text-green-700 font-medium">{p}</span>
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
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-4xl max-h-[90vh] overflow-hidden flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <div>
            <h2 className="text-lg font-extrabold font-serif flex items-center gap-2" style={{ color: GREEN_DARK }}>
              <Briefcase className="w-5 h-5" />
              Total Projects ({projects.length})
            </h2>
            <p className="text-xs font-semibold mt-0.5" style={{ color: GREEN_MID }}>
              Who's assigned to what — and the hours logged on each project this month
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={onGoToProjects}
              className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg text-white"
              style={{ background: GREEN_DARK }}>
              Manage projects <ArrowRight className="w-3 h-3" />
            </button>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600 p-1"><X className="w-5 h-5" /></button>
          </div>
        </div>

        <div className="overflow-y-auto flex-1 px-6 py-4 space-y-3">
          {projectStats.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-12">No projects yet.</p>
          ) : projectStats.map(({ project, members, totalHours }) => {
            const statusStyle =
              project.status === 'active'    ? 'bg-green-700 text-white' :
              project.status === 'completed' ? 'bg-blue-100 text-blue-800' :
                                               'bg-amber-100 text-amber-800'
            return (
              <button
                key={project.id}
                onClick={onGoToProjects}
                className="w-full text-left rounded-2xl border border-gray-100 hover:border-green-300 hover:shadow-md transition-all p-4 group">
                <div className="flex items-start justify-between gap-3 mb-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="text-base font-extrabold font-serif truncate" style={{ color: GREEN_DARK }}>{project.name}</h3>
                      <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wider ${statusStyle}`}>
                        {project.status.replace('_', ' ')}
                      </span>
                      {project.deadline && (
                        <span className="text-[10px] font-semibold text-gray-500">
                          Due {new Date(project.deadline).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}
                        </span>
                      )}
                    </div>
                    {project.description && (
                      <p className="text-xs text-gray-500 mt-1 line-clamp-2">{project.description}</p>
                    )}
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-xl font-extrabold leading-none" style={{ color: GREEN_DARK }}>
                      {totalHours}<span className="text-xs font-semibold text-gray-400 ml-1">hrs</span>
                    </p>
                    <p className="text-[10px] font-semibold mt-0.5" style={{ color: GREEN_MID }}>this month</p>
                  </div>
                </div>

                {members.length === 0 ? (
                  <p className="text-xs text-gray-400 italic">No one assigned yet.</p>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {members.map(m => {
                      const name = m.user?.full_name || m.user?.email || 'Unknown'
                      return (
                        <div key={m.id} className="flex items-center gap-2 px-3 py-2 rounded-xl bg-green-50/50 border border-green-100/60">
                          <Avatar url={m.user?.avatar_url} name={m.user?.full_name} email={m.user?.email}
                            sizeClass="w-8 h-8" textClass="text-xs" />
                          <div className="flex-1 min-w-0">
                            <p className="text-xs font-bold truncate" style={{ color: GREEN_DARK }}>{name}</p>
                            <p className="text-[10px]" style={{ color: GREEN_MID }}>
                              {m.hours > 0
                                ? <>{m.hours}h logged{m.lastLogged ? ` · last ${new Date(m.lastLogged + 'T00:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}` : ''}</>
                                : <span className="text-gray-400">No time logged yet</span>}
                            </p>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}

                <p className="mt-3 flex items-center gap-1 text-[11px] font-semibold opacity-0 group-hover:opacity-100 transition-opacity" style={{ color: GREEN_DARK }}>
                  Open in Team Members → Projects <ArrowRight className="w-3 h-3" />
                </p>
              </button>
            )
          })}
        </div>
      </div>
    </div>
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

  const INP = 'w-full text-sm px-3 py-2 rounded-lg border border-gray-200 bg-white focus:outline-none focus:ring-2 focus:ring-green-300 transition-all'
  const SEL = INP + ' cursor-pointer'

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-5xl max-h-[90vh] overflow-hidden flex flex-col" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <div>
            <h2 className="text-lg font-extrabold font-serif" style={{ color: GREEN_DARK }}>All Reports</h2>
            <p className="text-xs font-semibold mt-0.5" style={{ color: GREEN_MID }}>
              {userCards.length} contributor{userCards.length === 1 ? '' : 's'} matching filters — click a card for the full breakdown
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={exportCSV}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border border-gray-200 hover:bg-gray-50"
              style={{ color: GREEN_DARK }}>
              <Download className="w-3 h-3" /> Export CSV
            </button>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600 p-1"><X className="w-5 h-5" /></button>
          </div>
        </div>

        {/* Filter bar */}
        <div className="px-6 py-3 border-b border-gray-100 grid grid-cols-2 lg:grid-cols-5 gap-3">
          <div className="relative">
            <label className="text-[10px] font-bold text-gray-500 block mb-1">Users</label>
            <button type="button" onClick={() => setUserDropOpen(o => !o)} className={SEL + ' flex items-center justify-between'}>
              <span className="truncate text-sm">
                {filters.userIds.length === 0 ? 'All users'
                  : filters.userIds.length === 1 ? (brandingUsers.find(u => u.id === filters.userIds[0])?.full_name || 'Unknown')
                  : `${filters.userIds.length} selected`}
              </span>
              <ChevronDown className="w-3.5 h-3.5 text-gray-400" />
            </button>
            {userDropOpen && (
              <div className="absolute z-40 top-full mt-1 left-0 w-full bg-white border border-gray-100 rounded-lg shadow-lg py-1 max-h-52 overflow-y-auto">
                <label className="flex items-center gap-2 px-3 py-1.5 hover:bg-green-50/40 cursor-pointer">
                  <input type="checkbox" checked={filters.userIds.length === 0}
                    onChange={() => setFilters(p => ({ ...p, userIds: [] }))}
                    className="w-3.5 h-3.5 accent-green-700" />
                  <span className="text-sm">All users</span>
                </label>
                <div className="border-t border-gray-100 my-1" />
                {brandingUsers.map(u => (
                  <label key={u.id} className="flex items-center gap-2 px-3 py-1.5 hover:bg-green-50/40 cursor-pointer">
                    <input type="checkbox" checked={filters.userIds.includes(u.id)}
                      onChange={() => toggleUser(u.id)}
                      className="w-3.5 h-3.5 accent-green-700" />
                    <span className="text-sm truncate">{u.full_name || u.email}</span>
                  </label>
                ))}
              </div>
            )}
          </div>
          <div>
            <label className="text-[10px] font-bold text-gray-500 block mb-1">From</label>
            <input type="date" value={filters.dateFrom} onChange={e => setFilters(p => ({ ...p, dateFrom: e.target.value }))} className={INP} />
          </div>
          <div>
            <label className="text-[10px] font-bold text-gray-500 block mb-1">To</label>
            <input type="date" value={filters.dateTo} onChange={e => setFilters(p => ({ ...p, dateTo: e.target.value }))} className={INP} />
          </div>
          <div>
            <label className="text-[10px] font-bold text-gray-500 block mb-1">Type of Work</label>
            <select value={filters.typeOfWork}
              onChange={e => setFilters(p => ({ ...p, typeOfWork: e.target.value, subCategory: '' }))}
              className={SEL}>
              <option value="">All types</option>
              {categories.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
            </select>
          </div>
          <div>
            <label className="text-[10px] font-bold text-gray-500 block mb-1">Sub Category</label>
            <select value={filters.subCategory}
              onChange={e => setFilters(p => ({ ...p, subCategory: e.target.value }))}
              disabled={!filters.typeOfWork}
              className={SEL + (filters.typeOfWork ? '' : ' opacity-50 cursor-not-allowed')}>
              <option value="">All sub-categories</option>
              {subCatOptions.map(s => <option key={s.id} value={s.name}>{s.name}</option>)}
            </select>
          </div>
        </div>

        <div className="overflow-y-auto flex-1 px-6 py-4">
          {loading ? (
            <p className="text-sm text-gray-400 text-center py-8">Loading…</p>
          ) : userCards.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-12">No reports match the current filters.</p>
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
      </div>
    </div>
  )
}

// ── Per-user drill popup inside All Reports ──────────────────────────────

// Tiny status badge — mirrors the one on the user dashboard so the
// admin sees exactly the same paused/finished/running pill the user
// submitted on the row.
function RowStatusBadge({ status }: { status: 'idle' | 'running' | 'paused' | 'finished' }) {
  const cfg = {
    idle:     { label: 'Not started', cls: 'bg-gray-100 text-gray-600' },
    running:  { label: 'Running',     cls: 'bg-amber-100 text-amber-700' },
    paused:   { label: 'Paused',      cls: 'bg-orange-100 text-orange-700' },
    finished: { label: 'Finished',    cls: 'bg-green-100 text-green-700' },
  }[status]
  return (
    <span className={`inline-block text-[10px] font-bold px-2 py-0.5 rounded-full ${cfg.cls}`}>
      {cfg.label}
    </span>
  )
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
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[60] p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-4xl max-h-[85vh] overflow-hidden flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <div className="flex items-center gap-3 min-w-0">
            <Avatar url={user.avatar_url} name={user.name} email={user.email} sizeClass="w-12 h-12" textClass="text-sm" />
            <div className="min-w-0">
              <h2 className="text-lg font-extrabold font-serif truncate" style={{ color: GREEN_DARK }}>{user.name}</h2>
              <p className="text-xs font-semibold mt-0.5" style={{ color: GREEN_MID }}>
                {reports.length} report{reports.length === 1 ? '' : 's'} · {totalHrs}h on-day · {user.email}
              </p>
            </div>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 p-1 shrink-0"><X className="w-5 h-5" /></button>
        </div>
        <div className="overflow-y-auto flex-1 px-6 py-4 space-y-2">
          {reports.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-10">No reports for this user under the current filters.</p>
          ) : reports.map(r => {
            const dayHours = Math.round(r.rows.reduce((s, rw) => s + rowHours(rw, reports), 0) * 10) / 10
            const isOpen = expanded.has(r.id)
            return (
              <div key={r.id} className="rounded-xl border border-gray-100 overflow-hidden">
                <button onClick={() => setExpanded(p => { const s = new Set(p); if (s.has(r.id)) s.delete(r.id); else s.add(r.id); return s })}
                  className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-green-50/30 transition-colors">
                  <div className="flex-1 min-w-0 text-left">
                    <p className="text-sm font-semibold text-gray-800">
                      {new Date(r.report_date + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}
                    </p>
                    <p className="text-xs text-gray-500">
                      {r.rows.length} row{r.rows.length === 1 ? '' : 's'} · {dayHours}h on this day
                      {r.submitted_at && ` · submitted ${new Date(r.submitted_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true })}`}
                    </p>
                  </div>
                  {r.is_locked
                    ? <span className="text-[10px] font-bold bg-green-50 text-green-700 px-2 py-0.5 rounded-full"><Lock className="w-2.5 h-2.5 inline mr-0.5" />Submitted</span>
                    : <span className="text-[10px] font-bold bg-amber-50 text-amber-700 px-2 py-0.5 rounded-full">Draft</span>}
                  {isOpen ? <ChevronUp className="w-4 h-4 text-gray-400" /> : <ChevronDown className="w-4 h-4 text-gray-400" />}
                </button>
                {isOpen && (
                  <div className="overflow-x-auto border-t border-gray-100">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="bg-gray-50 border-b border-gray-100">
                          {['Sr', 'Type', 'Sub', 'Project', 'Status', 'Time today', 'Collaborators'].map(h => (
                            <th key={h} className="text-left text-[10px] font-bold uppercase tracking-wider text-gray-500 px-3 py-2">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {r.rows.map(row => {
                          const isCarried = !!row.carried_over_from_row_id
                          const hasStopwatch = row.elapsed_seconds > 0 || row.stopwatch_status !== 'idle'
                          const perDaySecs = hasStopwatch ? perDayElapsedSeconds(row, reports) : 0
                          return (
                            <tr key={row.id} className="border-b border-gray-50 last:border-0">
                              <td className="px-3 py-2 text-gray-400 align-top">{row.sr_no}</td>
                              <td className="px-3 py-2 align-top">{row.type_of_work}</td>
                              <td className="px-3 py-2 text-gray-500 align-top">{row.sub_category || '—'}</td>
                              <td className="px-3 py-2 align-top">
                                <span className="text-gray-800">{row.specific_work}</span>
                                {isCarried && (
                                  <span className="block text-[10px] text-gray-400 mt-0.5">Continued from a previous day</span>
                                )}
                              </td>
                              <td className="px-3 py-2 align-top">
                                <RowStatusBadge status={row.stopwatch_status} />
                                {row.stopwatch_status === 'paused' && row.last_paused_at && (
                                  <div className="text-[10px] text-gray-400 mt-0.5">
                                    paused {new Date(row.last_paused_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true })}
                                  </div>
                                )}
                              </td>
                              <td className="px-3 py-2 font-medium whitespace-nowrap align-top" style={{ color: GREEN_DARK }}>
                                {!hasStopwatch ? (
                                  // Manual time entry — show what the user typed.
                                  <>{row.time_taken}</>
                                ) : perDaySecs === 0 && isCarried ? (
                                  <>
                                    <span className="text-gray-400">—</span>
                                    <span className="block text-[10px] text-gray-400 font-normal">no new work today</span>
                                    <span className="block text-[10px] text-gray-400 font-normal">
                                      cumulative {elapsedToTimeTaken(row.elapsed_seconds)}
                                    </span>
                                  </>
                                ) : (
                                  <>
                                    {elapsedToTimeTaken(perDaySecs)}
                                    {row.elapsed_seconds !== perDaySecs && (
                                      <span className="block text-[10px] text-gray-400 font-normal">
                                        cumulative {elapsedToTimeTaken(row.elapsed_seconds)}
                                      </span>
                                    )}
                                  </>
                                )}
                              </td>
                              <td className="px-3 py-2 text-gray-500 align-top">
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
      </div>
    </div>
  )
}
