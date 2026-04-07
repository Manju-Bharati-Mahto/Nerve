import { useState, useEffect, useCallback, useMemo } from 'react'
import { useAuth } from '@/hooks/useAuth'
import { useAppData } from '@/hooks/useAppData'
import { brandingApi } from '@/lib/branding-api'
import { api } from '@/lib/api'
import { TIME_OPTIONS, timeToHours, MONTHS } from '@/lib/branding-types'
import type {
  WorkCategory, DailyReport, DraftRow, KraParameter, SelfAppraisal, BrandingProject, BrandingLeave,
} from '@/lib/branding-types'
import {
  LayoutDashboard, ClipboardList, BarChart2, Award, Settings, HelpCircle,
  LogOut, Plus, Trash2, Send, Lock, ChevronDown, Check, Info, Download,
  Users, TrendingUp, AlertCircle, Bell, Search, ArrowUpRight, Palette,
  Calendar, Timer, LayoutGrid, X,
  Camera, Shield, BookOpen, Keyboard, MessageCircle, Phone,
} from 'lucide-react'
import BrandingBrowse from './BrandingBrowse'
import BrandingTeamPanel from './BrandingTeamPanel'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
  PieChart, Pie, Cell,
} from 'recharts'
import { toast } from 'sonner'

// ── Constants & Helpers ────────────────────────────────────────────────────

// Use LOCAL date (not UTC) so dates match stored report_date values
const fmtDate = (d: Date) => {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}
const today = () => fmtDate(new Date())

// Parse a YYYY-MM-DD string as LOCAL midnight (not UTC midnight)
// new Date("2025-04-06") is UTC midnight which shifts the date in non-UTC timezones
const parseDateLocal = (s: string) => {
  const [y, mo, d] = s.split('-').map(Number)
  return new Date(y, mo - 1, d)
}

const SEL = 'w-full bg-white text-sm px-2 py-1.5 rounded-lg border border-gray-200 focus:border-green-600 focus:outline-none focus:ring-1 focus:ring-green-200 transition-all cursor-pointer'
const INP = 'w-full bg-white text-sm px-2 py-1.5 rounded-lg border border-gray-200 focus:border-green-600 focus:outline-none focus:ring-1 focus:ring-green-200 transition-all placeholder:text-gray-400'

const PIE_COLORS = [
  '#00827F', // deep teal (eye centre)
  '#1B6CA8', // peacock blue
  '#2E8B57', // sea green
  '#7B3F9E', // iridescent purple
  '#C8A951', // golden bronze
  '#00B4C8', // bright turquoise
  '#2D5A8E', // deep sapphire
  '#3D9970', // jade green
]

type NavPage = 'dashboard' | 'daily-reports' | 'analytics' | 'self-appraisal' | 'gallery' | 'team' | 'settings' | 'help'

function blankRow(sr: number): DraftRow {
  return { _key: `${Date.now()}-${sr}`, sr_no: sr, type_of_work: '', sub_category: '', specific_work: '', time_taken: '', collaborative_colleagues: [] }
}

function workingDaysSoFar(): number {
  const now = new Date()
  let count = 0
  for (let d = 1; d <= now.getDate(); d++) {
    const day = new Date(now.getFullYear(), now.getMonth(), d).getDay()
    if (day !== 0 && day !== 6) count++
  }
  return count
}

// ── Gauge SVG ──────────────────────────────────────────────────────────────

function GaugeChart({ completed, inProgress, pending }: {
  completed: number
  inProgress: number
  pending: number
}) {
  const total = Math.max(completed + inProgress + pending, 1)
  const pct = Math.round((completed / total) * 100)

  const cx = 90, cy = 94, r = 68, sw = 22
  const S = -210, SWEEP = 240

  const pt = (deg: number) => ({
    x: cx + r * Math.cos(deg * Math.PI / 180),
    y: cy + r * Math.sin(deg * Math.PI / 180),
  })
  const arc = (a: number, b: number) => {
    const s = pt(a), e = pt(b)
    return `M ${s.x} ${s.y} A ${r} ${r} 0 ${(b - a) > 180 ? 1 : 0} 1 ${e.x} ${e.y}`
  }

  const cA = (completed / total) * SWEEP
  const iA = (inProgress / total) * SWEEP
  const pA = SWEEP - cA - iA
  const a1 = S + cA, a2 = a1 + iA, a3 = S + SWEEP
  const half = sw / 2

  // Left endpoint color (start of arc)
  const leftFill = completed > 0 ? '#52b788' : inProgress > 0 ? '#1a472a' : '#dce8e0'
  // Right endpoint: hatched if pending exists
  const rightHatched = pending > 0
  const rightFill = !rightHatched ? (inProgress > 0 ? '#1a472a' : '#52b788') : null

  return (
    <svg width="180" height="134" viewBox="0 0 180 134">
      <defs>
        <pattern id="gauge-hatch" patternUnits="userSpaceOnUse" width="8" height="8" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="8" stroke="#a8c4b4" strokeWidth="3.5" />
        </pattern>
      </defs>

      {/* Background track */}
      <path d={arc(S, a3)} fill="none" stroke="#e0ede6" strokeWidth={sw} strokeLinecap="round" />

      {/* Completed — light green */}
      {completed > 0 && cA > 0.2 && (
        <path d={arc(S, a1)} fill="none" stroke="#52b788" strokeWidth={sw} strokeLinecap="butt" />
      )}

      {/* In-progress — dark green */}
      {inProgress > 0 && iA > 0.2 && (
        <path d={arc(a1, a2)} fill="none" stroke="#1a472a" strokeWidth={sw} strokeLinecap="butt" />
      )}

      {/* Pending — hatched (base fill + hatch overlay) */}
      {pending > 0 && pA > 0.2 && (
        <>
          <path d={arc(a2, a3)} fill="none" stroke="#dce8e0" strokeWidth={sw} strokeLinecap="butt" />
          <path d={arc(a2, a3)} fill="none" stroke="url(#gauge-hatch)" strokeWidth={sw} strokeLinecap="butt" />
        </>
      )}

      {/* Round cap — arc start */}
      <circle cx={pt(S).x} cy={pt(S).y} r={half} fill={leftFill} />

      {/* Round cap — arc end */}
      {rightHatched ? (
        <>
          <circle cx={pt(a3).x} cy={pt(a3).y} r={half} fill="#dce8e0" />
          <circle cx={pt(a3).x} cy={pt(a3).y} r={half} fill="url(#gauge-hatch)" />
        </>
      ) : rightFill ? (
        <circle cx={pt(a3).x} cy={pt(a3).y} r={half} fill={rightFill} />
      ) : null}

      {/* Center label */}
      <text x={cx} y={cy - 3} textAnchor="middle" fontSize="28" fontWeight="700" fill="#1a472a">{pct}%</text>
      <text x={cx} y={cy + 16} textAnchor="middle" fontSize="10" fill="#6b7280">Project Ended</text>
    </svg>
  )
}

// ── ColleaguesSelect ───────────────────────────────────────────────────────

function ColleaguesSelect({
  options, value, onChange,
}: {
  options: { id: string; label: string }[]
  value: string[]
  onChange: (v: string[]) => void
}) {
  const [open, setOpen] = useState(false)
  const toggle = (id: string) =>
    onChange(value.includes(id) ? value.filter(v => v !== id) : [...value, id])
  const labels = value.map(id => options.find(o => o.id === id)?.label || id)

  return (
    <div className="relative w-full min-w-[150px]">
      <button type="button" onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between gap-1 text-sm px-2 py-1.5 rounded-lg border border-gray-200 hover:border-green-400 transition-colors text-left bg-white">
        <span className="truncate text-xs text-gray-500">{labels.length === 0 ? 'None' : labels.join(', ')}</span>
        <ChevronDown className="w-3.5 h-3.5 shrink-0 text-gray-400" />
      </button>
      {open && (
        <div className="absolute z-50 top-full mt-1 left-0 min-w-full w-48 bg-white border border-gray-200 rounded-lg shadow-lg py-1 max-h-52 overflow-y-auto">
          {options.length === 0 && <p className="text-xs text-gray-400 px-3 py-2">No other members</p>}
          {options.map(opt => (
            <label key={opt.id} className="flex items-center gap-2 px-3 py-1.5 hover:bg-green-50 cursor-pointer">
              <input type="checkbox" checked={value.includes(opt.id)} onChange={() => toggle(opt.id)} className="w-3.5 h-3.5 accent-green-700" />
              <span className="text-sm truncate">{opt.label}</span>
            </label>
          ))}
          <div className="border-t border-gray-100 mt-1 pt-1 px-2 pb-1">
            <button type="button" onClick={() => setOpen(false)} className="w-full text-xs text-center text-gray-400 hover:text-gray-600 py-0.5">Done</button>
          </div>
        </div>
      )}
    </div>
  )
}

// ── KRA Form ───────────────────────────────────────────────────────────────

function KraForm({ params, scores, onChange, readOnly = false }: {
  params: KraParameter[]
  scores: Record<string, number>
  onChange?: (s: Record<string, number>) => void
  readOnly?: boolean
}) {
  return (
    <div className="space-y-4">
      {params.map(p => (
        <div key={p.id}>
          <div className="flex items-start justify-between mb-1">
            <div>
              <p className="text-sm font-medium text-gray-800">{p.name}</p>
              <p className="text-xs text-gray-500">{p.description}</p>
            </div>
            <span className="text-sm font-semibold text-green-800 w-10 text-right shrink-0">
              {scores[p.id] ?? '—'}<span className="text-gray-400 font-normal">/5</span>
            </span>
          </div>
          {readOnly ? (
            <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
              <div className="h-full bg-green-700 rounded-full transition-all" style={{ width: `${((scores[p.id] ?? 0) / 5) * 100}%` }} />
            </div>
          ) : (
            <input type="range" min={0} max={5} step={1}
              value={scores[p.id] ?? 0}
              onChange={e => onChange?.({ ...scores, [p.id]: parseInt(e.target.value) })}
              className="w-full accent-green-700" />
          )}
        </div>
      ))}
    </div>
  )
}

// ── Work Analytics Chart (Recharts) ───────────────────────────────────────

const WA_HATCH_ID = 'wa-diag-hatch'

function roundedTopPath(x: number, y: number, w: number, h: number, r: number) {
  return `M${x + r},${y} h${w - 2 * r} a${r},${r} 0 0 1 ${r},${r} v${h - r} h${-w} v${-(h - r)} a${r},${r} 0 0 1 ${r},${-r}z`
}

function WorkAnalyticsChart({ data, onBarClick, loading }: {
  data: { day: string; hours: number; submitted: boolean; date: string }[]
  onBarClick?: (date: string) => void
  loading?: boolean
}) {
  if (loading) {
    return (
      <div className="flex items-center justify-center h-40">
        <div className="w-5 h-5 border-2 border-green-200 border-t-green-700 rounded-full animate-spin" />
      </div>
    )
  }

  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-40 text-sm font-semibold" style={{ color: '#52b788' }}>
        No data for this period
      </div>
    )
  }

  const CustomTooltip = ({ active, payload, label }: {
    active?: boolean
    payload?: { value: number; payload: { submitted: boolean; hours: number; date: string } }[]
    label?: string
  }) => {
    if (!active || !payload?.length) return null
    const d = payload[0].payload
    const statusColor = d.hours === 0 ? '#9ca3af' : d.submitted ? '#1a472a' : '#52b788'
    const statusLabel = d.hours === 0 ? 'No data' : d.submitted ? 'Submitted' : 'Saved draft'
    return (
      <div className="bg-white border border-gray-100 rounded-xl px-3 py-2.5 shadow-lg text-xs min-w-[100px]">
        <p className="font-bold mb-1" style={{ color: '#1a472a' }}>{label}</p>
        {d.hours > 0 && <p className="font-semibold text-gray-700 mb-0.5">{d.hours} hrs logged</p>}
        <p className="font-semibold" style={{ color: statusColor }}>{statusLabel}</p>
      </div>
    )
  }

  // Background shape — full-height capsule hatch for every bar
  const HatchBackground = (props: { x?: number; y?: number; width?: number; height?: number }) => {
    const { x = 0, y = 0, width = 0, height = 0 } = props
    if (width <= 0 || height <= 0) return null
    const r = width / 2  // full capsule radius
    return (
      <g>
        <defs>
          <pattern id={WA_HATCH_ID} patternUnits="userSpaceOnUse" width="8" height="8" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="8" stroke="#a8c5a8" strokeWidth="2.5" />
          </pattern>
        </defs>
        <path d={roundedTopPath(x, y, width, height, r)} fill="#eaf3ea" />
        <path d={roundedTopPath(x, y, width, height, r)} fill={`url(#${WA_HATCH_ID})`} />
      </g>
    )
  }

  // Foreground shape — full capsule for submitted / draft bars
  const DataBar = (props: {
    x?: number; y?: number; width?: number; height?: number
    submitted?: boolean; hours?: number; date?: string
  }) => {
    const { x = 0, y = 0, width = 0, height = 0, submitted, hours, date } = props
    if (!hours || hours <= 0 || height <= 0) return null
    const r = width / 2  // full capsule radius
    const fill = submitted ? '#1a472a' : '#74c69d'
    return (
      <g
        onClick={() => { if (submitted && date) onBarClick?.(date) }}
        style={{ cursor: submitted && date && onBarClick ? 'pointer' : 'default' }}
      >
        <path d={roundedTopPath(x, y, width, height, r)} fill={fill} />
      </g>
    )
  }

  return (
    <ResponsiveContainer width="100%" height={190}>
      <BarChart data={data} margin={{ top: 10, right: 4, left: -20, bottom: 0 }} barCategoryGap="28%">
        <CartesianGrid vertical={false} stroke="#f0f4f0" strokeDasharray="4 4" />
        <XAxis
          dataKey="day"
          axisLine={false}
          tickLine={false}
          tick={{ fontSize: 11, fill: '#9ca3af', fontWeight: 600 }}
        />
        <YAxis
          axisLine={false}
          tickLine={false}
          tick={{ fontSize: 10, fill: '#b0c0b0' }}
          tickFormatter={v => `${v}h`}
        />
        <Tooltip content={<CustomTooltip />} cursor={{ fill: 'rgba(240,247,240,0.6)' }} />
        <Bar
          dataKey="hours"
          background={(props: object) => {
            const p = props as { x?: number; y?: number; width?: number; height?: number }
            return <HatchBackground {...p} />
          }}
          shape={(props: object) => {
            const p = props as { x?: number; y?: number; width?: number; height?: number; submitted?: boolean; hours?: number; date?: string }
            return <DataBar {...p} />
          }}
        >
          {data.map((_, i) => <Cell key={i} />)}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}

// ── Liquid Glass Pie Chart ────────────────────────────────────────────────

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
          <span className="text-xs font-bold" style={{ color: '#1a472a' }}>{payload[0].name}</span>
        </div>
        <p className="text-base font-extrabold" style={{ color }}>{payload[0].value}h</p>
        <p className="text-[10px] font-semibold text-gray-400">{total > 0 ? Math.round((payload[0].value / total) * 100) : 0}% of total</p>
      </div>
    )
  }

  const CustomLabel = ({ cx, cy, midAngle, innerRadius, outerRadius, index }: {
    cx: number; cy: number; midAngle: number;
    innerRadius: number; outerRadius: number; index: number
  }) => {
    if (index !== activeIndex) return null
    const RADIAN = Math.PI / 180
    const r = innerRadius + (outerRadius - innerRadius) * 0.5
    const x = cx + r * Math.cos(-midAngle * RADIAN)
    const y = cy + r * Math.sin(-midAngle * RADIAN)
    return (
      <text x={x} y={y} textAnchor="middle" dominantBaseline="central"
        fontSize={11} fontWeight={700} fill="white">
        {Math.round((data[index].value / total) * 100)}%
      </text>
    )
  }

  return (
    <div>
      <h3 className="text-sm font-extrabold font-serif mb-4" style={{ color: '#1a472a' }}>{title}</h3>
      <div className="flex flex-col sm:flex-row items-center gap-5">
        {/* Glass card wrapper for the pie */}
        <div className="relative shrink-0" style={{ width: 220, height: 200 }}>
          {/* Frosted glass backdrop */}
          <div className="absolute inset-0 rounded-2xl" style={{
            background: 'linear-gradient(135deg, rgba(255,255,255,0.55) 0%, rgba(210,240,220,0.35) 100%)',
            backdropFilter: 'blur(12px)',
            WebkitBackdropFilter: 'blur(12px)',
            border: '1px solid rgba(255,255,255,0.65)',
            boxShadow: '0 4px 24px rgba(26,71,42,0.10), inset 0 1px 0 rgba(255,255,255,0.8)',
          }} />
          {/* Subtle specular highlight */}
          <div className="absolute inset-0 rounded-2xl pointer-events-none" style={{
            background: 'radial-gradient(ellipse at 30% 20%, rgba(255,255,255,0.50) 0%, transparent 60%)',
          }} />
          {/* Centre label when a slice is active */}
          <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none z-10">
            {active ? (
              <>
                <span className="text-[11px] font-semibold text-center leading-tight px-2"
                  style={{ color: PIE_COLORS[activeIndex! % PIE_COLORS.length] }}>
                  {active.name}
                </span>
                <span className="text-lg font-extrabold mt-0.5" style={{ color: '#1a472a' }}>{active.value}h</span>
              </>
            ) : (
              <>
                <span className="text-[10px] font-semibold text-gray-400">Total</span>
                <span className="text-xl font-extrabold" style={{ color: '#1a472a' }}>{total}h</span>
              </>
            )}
          </div>
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <defs>
                {data.map((_, i) => (
                  <filter key={i} id={`glow-${i}`}>
                    <feGaussianBlur stdDeviation="3" result="blur" />
                    <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
                  </filter>
                ))}
              </defs>
              <Pie
                data={data}
                dataKey="value"
                nameKey="name"
                cx="50%"
                cy="50%"
                innerRadius={52}
                outerRadius={80}
                paddingAngle={3}
                labelLine={false}
                label={CustomLabel as unknown as boolean}
                onMouseEnter={(_, index) => setActiveIndex(index)}
                onMouseLeave={() => setActiveIndex(null)}
                onClick={(_, index) => setActiveIndex(prev => prev === index ? null : index)}
              >
                {data.map((_, i) => {
                  const isActive = activeIndex === i
                  const color = PIE_COLORS[i % PIE_COLORS.length]
                  return (
                    <Cell
                      key={i}
                      fill={color}
                      stroke={isActive ? 'rgba(255,255,255,0.8)' : 'rgba(255,255,255,0.3)'}
                      strokeWidth={isActive ? 2.5 : 1}
                      style={{
                        filter: isActive ? `drop-shadow(0 0 8px ${color}cc)` : undefined,
                        transform: isActive ? 'scale(1.05)' : 'scale(1)',
                        transformOrigin: 'center',
                        transition: 'all 0.2s ease',
                        cursor: 'pointer',
                        opacity: activeIndex !== null && !isActive ? 0.6 : 1,
                      }}
                    />
                  )
                })}
              </Pie>
              <Tooltip content={<CustomTooltip />} />
            </PieChart>
          </ResponsiveContainer>
        </div>

        {/* Legend */}
        <div className="flex flex-wrap gap-x-5 gap-y-2.5">
          {data.map((entry, i) => {
            const color = PIE_COLORS[i % PIE_COLORS.length]
            const isActive = activeIndex === i
            return (
              <button
                key={i}
                onClick={() => setActiveIndex(prev => prev === i ? null : i)}
                className="flex items-center gap-2 transition-all"
                style={{ opacity: activeIndex !== null && !isActive ? 0.45 : 1 }}
              >
                <span className="w-3 h-3 rounded-full shrink-0 transition-all" style={{
                  background: color,
                  boxShadow: isActive ? `0 0 8px ${color}cc` : 'none',
                  transform: isActive ? 'scale(1.3)' : 'scale(1)',
                }} />
                <span className="text-xs font-semibold" style={{ color: isActive ? '#1a472a' : '#52b788' }}>
                  {entry.name}
                </span>
                <span className="text-xs font-bold" style={{ color: '#1a472a' }}>{entry.value}h</span>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// ── Stat Card ──────────────────────────────────────────────────────────────

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
      {/* subtle radial shine for the dark card */}
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
            <span className={`text-xs ${dark ? 'text-green-200' : 'text-gray-500'}`}>Increased from last month</span>
          </div>
        )}
        {sub && badge === undefined && (
          <p className={`text-xs mt-2 ${dark ? 'text-green-200' : 'text-gray-500'}`}>{sub}</p>
        )}
      </div>
    </div>
  )
}

// ── Dashboard Overview Page ────────────────────────────────────────────────

function DashboardPage({
  profile,
  users,
  onNavigate,
}: {
  profile: ReturnType<typeof useAuth>['profile']
  users: ReturnType<typeof useAppData>['users']
  onNavigate: (p: NavPage) => void
}) {
  const [analytics, setAnalytics] = useState<{
    typeHours: Record<string, number>
    collaboratorMap: Record<string, { hours: number; count: number }>
    totalReports: number
  } | null>(null)
  const [weeklyData, setWeeklyData] = useState<{ day: string; hours: number; submitted: boolean; date: string }[]>([])
  const [weeklyReports, setWeeklyReports] = useState<DailyReport[]>([])
  const [chartReports, setChartReports] = useState<DailyReport[]>([])
  const [todayReport, setTodayReport] = useState<DailyReport | null>(null)
  const [projects, setProjects] = useState<BrandingProject[]>([])
  const [categories, setCategories] = useState<WorkCategory[]>([])
  const [chartFilter, setChartFilter] = useState<'week' | 'month' | '6months' | 'custom'>('week')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')
  const [chartLoading, setChartLoading] = useState(false)
  const [reportPopup, setReportPopup] = useState<DailyReport | null>(null)

  // Collaboration modal state
  const [showAddCollab, setShowAddCollab] = useState(false)
  const [collabColleague, setCollabColleague] = useState('')
  const [collabWorkType, setCollabWorkType] = useState('')
  const [collabSubCat, setCollabSubCat] = useState('')
  const [collabNote, setCollabNote] = useState('')
  const [collabTime, setCollabTime] = useState('')
  const [collabSaving, setCollabSaving] = useState(false)

  // Load projects
  useEffect(() => {
    brandingApi.getProjects()
      .then(r => setProjects(r.projects))
      .catch(() => {})
  }, [])

  // Load categories for collaboration form
  useEffect(() => {
    brandingApi.getCategories()
      .then(r => setCategories(r.categories))
      .catch(() => {})
  }, [])

  // Load monthly analytics
  useEffect(() => {
    const now = new Date()
    const dateFrom = fmtDate(new Date(now.getFullYear(), now.getMonth(), 1))
    const dateTo = fmtDate(now)
    if (profile?.id) {
      brandingApi.getAnalytics({ dateFrom, dateTo, userId: profile.id })
        .then(r => setAnalytics(r.analytics))
        .catch(() => {})
    }
  }, [profile?.id])

  // Always load current week for collaboration card
  useEffect(() => {
    if (!profile?.id) return
    const now = new Date()
    const sunday = new Date(now)
    sunday.setDate(now.getDate() - now.getDay())
    const saturday = new Date(sunday)
    saturday.setDate(sunday.getDate() + 6)
    brandingApi.getAllReports({ dateFrom: fmtDate(sunday), dateTo: fmtDate(saturday), userId: profile.id })
      .then(r => setWeeklyReports(r.reports))
      .catch(() => {})
  }, [profile?.id])

  // Chart filter — fetch and aggregate data based on selected filter
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

    if (!profile?.id) return

    setChartLoading(true)
    brandingApi.getAllReports({ dateFrom, dateTo, userId: profile.id })
      .then(r => {
        setChartReports(r.reports)
        const DAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']
        const MONTH_ABB = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

        if (chartFilter === 'week') {
          const sunday = parseDateLocal(dateFrom)
          const data = Array.from({ length: 7 }, (_, i) => {
            const d = new Date(sunday); d.setDate(sunday.getDate() + i)
            const ds = fmtDate(d)
            const rep = r.reports.find(rp => rp.report_date === ds)
            const hrs = rep?.rows?.reduce((s, row) => s + timeToHours(row.time_taken), 0) ?? 0
            return { day: DAY_LABELS[i], hours: Math.round(hrs * 10) / 10, submitted: rep?.is_locked ?? false, date: ds }
          })
          setWeeklyData(data)
        } else if (chartFilter === 'month') {
          const from = parseDateLocal(dateFrom), to = parseDateLocal(dateTo)
          const data: { day: string; hours: number; submitted: boolean; date: string }[] = []
          const d = new Date(from)
          while (d <= to) {
            const ds = fmtDate(d)
            const rep = r.reports.find(rp => rp.report_date === ds)
            const hrs = rep?.rows?.reduce((s, row) => s + timeToHours(row.time_taken), 0) ?? 0
            data.push({ day: String(d.getDate()), hours: Math.round(hrs * 10) / 10, submitted: rep?.is_locked ?? false, date: ds })
            d.setDate(d.getDate() + 1)
          }
          setWeeklyData(data)
        } else if (chartFilter === '6months') {
          const data = Array.from({ length: 6 }, (_, i) => {
            const ms = new Date(now.getFullYear(), now.getMonth() - 5 + i, 1)
            const me = new Date(ms.getFullYear(), ms.getMonth() + 1, 0)
            const monthReps = r.reports.filter(rp => {
              const rd = parseDateLocal(rp.report_date)
              return rd >= ms && rd <= me
            })
            const hrs = monthReps.reduce((s, rep) =>
              s + (rep.rows?.reduce((rs, row) => rs + timeToHours(row.time_taken), 0) ?? 0), 0)
            return { day: MONTH_ABB[ms.getMonth()], hours: Math.round(hrs * 10) / 10, submitted: monthReps.some(rp => rp.is_locked), date: fmtDate(ms) }
          })
          setWeeklyData(data)
        } else {
          const from = parseDateLocal(dateFrom), to = parseDateLocal(dateTo)
          const data: { day: string; hours: number; submitted: boolean; date: string }[] = []
          const d = new Date(from)
          while (d <= to) {
            const ds = fmtDate(d)
            const rep = r.reports.find(rp => rp.report_date === ds)
            const hrs = rep?.rows?.reduce((s, row) => s + timeToHours(row.time_taken), 0) ?? 0
            data.push({ day: String(d.getDate()), hours: Math.round(hrs * 10) / 10, submitted: rep?.is_locked ?? false, date: ds })
            d.setDate(d.getDate() + 1)
          }
          setWeeklyData(data)
        }
      })
      .catch(e => toast.error(e instanceof Error ? e.message : 'Failed to load analytics'))
      .finally(() => setChartLoading(false))
  }, [chartFilter, customFrom, customTo, profile?.id])

  // Load today's report status
  useEffect(() => {
    brandingApi.getReport(today())
      .then(r => setTodayReport(r.report))
      .catch(() => {})
  }, [])

  const workingDays = workingDaysSoFar()
  const submitted = analytics?.totalReports ?? 0
  const totalHoursThisMonth = analytics
    ? Math.round(Object.values(analytics.typeHours).reduce((a, b) => a + b, 0) * 10) / 10
    : 0
  const progress = workingDays > 0 ? Math.min(100, Math.round((submitted / workingDays) * 100)) : 0
  const todayHours = todayReport?.rows?.reduce((s, r) => s + timeToHours(r.time_taken), 0) ?? 0

  // Project stats
  const now = new Date()
  const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1)
  const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1)
  const totalProjects = projects.length
  const runningProjects = projects.filter(p => p.status === 'active').length
  const newThisMonth = projects.filter(p => new Date(p.created_at) >= thisMonthStart).length
  const newLastMonth = projects.filter(p => {
    const d = new Date(p.created_at)
    return d >= lastMonthStart && d < thisMonthStart
  }).length
  const projectIncrease = Math.max(0, newThisMonth - newLastMonth)
  const runningIncrease = projects.filter(p => p.status === 'active' && new Date(p.created_at) >= thisMonthStart).length

  // Gauge filter — project status breakdown
  const [gaugeFilter, setGaugeFilter] = useState<'month' | 'quarter' | 'all'>('all')
  const gaugeProjects = useMemo(() => {
    if (gaugeFilter === 'month') return projects.filter(p => new Date(p.created_at) >= thisMonthStart)
    if (gaugeFilter === 'quarter') {
      const qStart = new Date(now.getFullYear(), now.getMonth() - 2, 1)
      return projects.filter(p => new Date(p.created_at) >= qStart)
    }
    return projects
  }, [gaugeFilter, projects, thisMonthStart, now])
  const gaugeCompleted  = gaugeProjects.filter(p => p.status === 'completed').length
  const gaugeInProgress = gaugeProjects.filter(p => p.status === 'active').length
  const gaugePending    = gaugeProjects.filter(p => p.status === 'on_hold').length

  const topCollaborators = analytics
    ? Object.entries(analytics.collaboratorMap)
        .sort((a, b) => b[1].hours - a[1].hours)
        .slice(0, 4)
        .map(([name, v]) => ({ name, hours: v.hours }))
    : []

  const pieData = analytics
    ? Object.entries(analytics.typeHours)
        .filter(([, v]) => v > 0)
        .map(([name, value]) => ({ name, value: Math.round(value * 10) / 10 }))
    : []

  const appraisalDue = now.getDate() >= 20
  const todaySubmitted = todayReport?.is_locked ?? false

  // All branding team members except self
  const brandingMembers = users.filter(u => u.team === 'branding' && u.id !== profile?.id)

  const collabSubCatOptions = useMemo(() => {
    if (!collabWorkType) return []
    return categories.find(c => c.name === collabWorkType)?.sub_categories || []
  }, [collabWorkType, categories])

  // Per-member collaboration details derived from this week's actual reports
  const collabDetails = useMemo(() => {
    const todayStr = today()
    const map: Record<string, { work: string; status: 'completed' | 'in-progress' | 'pending' }> = {}
    weeklyReports.forEach(rep => {
      rep.rows?.forEach(row => {
        row.collaborative_colleagues.forEach(uid => {
          const isToday = rep.report_date === todayStr
          const submitted = rep.is_locked
          const work = [row.type_of_work, row.specific_work].filter(Boolean).join(' — ')
          const status: 'completed' | 'in-progress' | 'pending' =
            (isToday && submitted) ? 'completed' : submitted ? 'completed' : 'in-progress'
          // keep the most recent (latest date wins)
          if (!map[uid] || rep.report_date >= (map[uid] as { date?: string }).date!) {
            map[uid] = { work: work || 'Collaborative work', status }
          }
        })
      })
    })
    return map
  }, [weeklyReports])

  const handleBarClick = useCallback((date: string) => {
    const rep = chartReports.find(r => r.report_date === date)
    if (rep) setReportPopup(rep)
  }, [chartReports])

  async function logCollaboration() {
    if (!collabColleague) { toast.error('Select a colleague.'); return }
    if (!collabWorkType) { toast.error('Select type of work.'); return }
    if (!collabNote.trim()) { toast.error('Enter a work description.'); return }
    if (!collabTime) { toast.error('Select time taken.'); return }
    if (todayReport?.is_locked) { toast.error('Today\'s report is already submitted.'); return }

    setCollabSaving(true)
    try {
      const rep = todayReport ?? (await brandingApi.getReport(today())).report
      const existingRows = rep.rows.map(row => ({
        sr_no: row.sr_no, type_of_work: row.type_of_work, sub_category: row.sub_category,
        specific_work: row.specific_work, time_taken: row.time_taken,
        collaborative_colleagues: row.collaborative_colleagues,
      }))
      const newRow = {
        sr_no: existingRows.length + 1,
        type_of_work: collabWorkType,
        sub_category: collabSubCat,
        specific_work: collabNote.trim(),
        time_taken: collabTime,
        collaborative_colleagues: [collabColleague],
      }
      await brandingApi.saveRows(rep.id, [...existingRows, newRow])
      // Refresh today's report so time tracker updates
      const updated = await brandingApi.getReport(today())
      setTodayReport(updated.report)
      toast.success('Collaboration logged to today\'s draft report!')
      setShowAddCollab(false)
      setCollabColleague(''); setCollabWorkType(''); setCollabSubCat('')
      setCollabNote(''); setCollabTime('')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to log collaboration')
    } finally {
      setCollabSaving(false)
    }
  }

  return (
    <div className="space-y-6">
      {/* Page heading */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-3xl font-extrabold font-serif" style={{ color: '#1a472a' }}>Dashboard</h1>
          <p className="text-sm font-semibold mt-0.5" style={{ color: '#52b788' }}>Plan, prioritize, and accomplish your tasks with ease.</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => onNavigate('daily-reports')}
            className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold text-white"
            style={{ background: '#1a472a' }}
          >
            <Plus className="w-4 h-4" /> Submit Report
          </button>
          <button
            onClick={() => onNavigate('self-appraisal')}
            className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold border border-gray-200 text-gray-700 hover:bg-gray-50"
          >
            Self Appraisal
          </button>
        </div>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard title="Total Projects" value={totalProjects} badge={projectIncrease} dark onClick={() => onNavigate('daily-reports')} />
        <StatCard title="Submitted Reports" value={submitted} badge={submitted} />
        <StatCard title="Running Projects" value={runningProjects} badge={runningIncrease} onClick={() => onNavigate('daily-reports')} />
        <StatCard title="Total Hours" value={totalHoursThisMonth} sub="This month" onClick={() => onNavigate('analytics')} />
      </div>

      {/* Row 2: Bar chart + Reminders + Recent */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
        {/* Work Analytics bar chart */}
        <div className="lg:col-span-3 bg-white rounded-2xl border border-gray-100 p-5">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h3 className="text-lg font-bold" style={{ color: '#1a472a' }}>Work Analytics</h3>
              <p className="text-xs font-semibold mt-0.5" style={{ color: '#52b788' }}>Hours logged per day from your reports</p>
            </div>
            <div className="flex items-center gap-3 text-xs font-semibold" style={{ color: '#52b788' }}>
              <span className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-sm inline-block" style={{ background: '#1a472a' }} />Submitted
              </span>
              <span className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-sm inline-block" style={{ background: '#74c69d' }} />Draft
              </span>
              <span className="flex items-center gap-1.5">
                <svg width="10" height="10" style={{ display: 'inline-block', verticalAlign: 'middle' }}>
                  <defs>
                    <pattern id="legend-hatch" patternUnits="userSpaceOnUse" width="4" height="4" patternTransform="rotate(45)">
                      <line x1="0" y1="0" x2="0" y2="4" stroke="#a8c5a8" strokeWidth="1.5" />
                    </pattern>
                  </defs>
                  <rect width="10" height="10" rx="2" fill="#eaf3ea" />
                  <rect width="10" height="10" rx="2" fill="url(#legend-hatch)" />
                </svg>
                No data
              </span>
            </div>
          </div>
          {/* Filter buttons */}
          <div className="flex flex-wrap items-center gap-2 mb-4">
            {(['week', 'month', '6months', 'custom'] as const).map(f => (
              <button
                key={f}
                onClick={() => setChartFilter(f)}
                className={`px-3 py-1 rounded-lg text-xs font-semibold transition-colors ${
                  chartFilter === f ? 'text-white' : 'text-gray-500 bg-gray-100 hover:bg-gray-200'
                }`}
                style={chartFilter === f ? { background: '#1a472a' } : {}}
              >
                {f === 'week' ? '1 Week' : f === 'month' ? '1 Month' : f === '6months' ? '6 Months' : 'Custom'}
              </button>
            ))}
            {chartFilter === 'custom' && (
              <div className="flex items-center gap-1.5 ml-1">
                <input type="date" value={customFrom} onChange={e => setCustomFrom(e.target.value)}
                  className="text-xs px-2 py-1 rounded-lg border border-gray-200 focus:outline-none focus:border-green-600" />
                <span className="text-xs text-gray-400">to</span>
                <input type="date" value={customTo} onChange={e => setCustomTo(e.target.value)}
                  className="text-xs px-2 py-1 rounded-lg border border-gray-200 focus:outline-none focus:border-green-600" />
              </div>
            )}
          </div>
          <WorkAnalyticsChart data={weeklyData} onBarClick={handleBarClick} loading={chartLoading} />
          {chartFilter === 'week' && !chartLoading && weeklyData.some(d => d.submitted) && (
            <p className="text-[10px] font-semibold text-center mt-1" style={{ color: '#52b788' }}>Click a submitted bar to view the report</p>
          )}
        </div>

        {/* Reminders */}
        <div className="lg:col-span-2 rounded-2xl border border-gray-100 p-5 flex flex-col relative overflow-hidden">
          {/* Duck background image — full visible */}
          <img
            src="/reminders-bg.jpeg"
            alt=""
            aria-hidden="true"
            className="absolute inset-0 w-full h-full object-cover object-top pointer-events-none select-none"
            style={{ opacity: 0.55 }}
          />
          {/* Light frosted overlay so text stays readable */}
          <div className="absolute inset-0 pointer-events-none rounded-2xl" style={{ background: 'rgba(255,255,255,0.50)' }} />
          {/* Content */}
          <h3 className="relative z-10 text-lg font-bold mb-4" style={{ color: '#1a472a' }}>Reminders</h3>
          <div className="relative z-10 space-y-3 flex-1">
            {!todaySubmitted && (
              <div className="rounded-xl bg-amber-50/90 border border-amber-100 p-4">
                <p className="text-sm font-semibold text-amber-800">Today's Report Pending</p>
                <p className="text-xs text-amber-600 mt-0.5">
                  {new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}
                </p>
              </div>
            )}
            {todaySubmitted && (
              <div className="rounded-xl bg-green-50/90 border border-green-100 p-4">
                <p className="text-sm font-semibold text-green-800">Today's Report Submitted</p>
                <p className="text-xs text-green-600 mt-0.5">{Math.round(todayHours * 10) / 10} hrs logged today</p>
              </div>
            )}
            {appraisalDue && (
              <div className="rounded-xl bg-blue-50/90 border border-blue-100 p-4">
                <p className="text-sm font-semibold text-blue-800">Self Appraisal Window</p>
                <p className="text-xs text-blue-600 mt-0.5">Submit for {MONTHS[now.getMonth()]} {now.getFullYear()}</p>
              </div>
            )}
          </div>
          <button
            onClick={() => onNavigate('daily-reports')}
            className="relative z-10 mt-4 w-full py-2.5 rounded-xl text-sm font-semibold text-white flex items-center justify-center gap-2"
            style={{ background: '#1a472a' }}
          >
            <Send className="w-4 h-4" /> Submit Today's Report
          </button>
        </div>
      </div>

      {/* Row 3: Collaboration + Progress + Time Tracker */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
        {/* Team Collaboration */}
        <div className="lg:col-span-2 bg-white rounded-2xl border border-gray-100 p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-bold" style={{ color: '#1a472a' }}>Team Collaboration</h3>
            <button
              onClick={() => setShowAddCollab(true)}
              className="flex items-center gap-1 text-xs font-semibold text-white px-2.5 py-1.5 rounded-lg transition-colors"
              style={{ background: '#1a472a' }}
            >
              <Plus className="w-3 h-3" /> Add Member
            </button>
          </div>

          {brandingMembers.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-6">No team members found.</p>
          ) : (
            <div className="space-y-1">
              {brandingMembers.map(member => {
                const weekly = collabDetails[member.id]
                const monthly = analytics?.collaboratorMap[member.full_name || ''] ??
                                analytics?.collaboratorMap[member.email] ?? null

                // Derive status
                const status: 'completed' | 'in-progress' | 'pending' =
                  weekly?.status === 'completed' ? 'completed'
                  : weekly?.status === 'in-progress' ? 'in-progress'
                  : monthly ? 'in-progress'
                  : 'pending'

                const workLabel = weekly?.work
                  || (monthly ? `${Math.round(monthly.hours * 10) / 10}h collaborated this month` : 'No collaboration yet')

                const initials = (member.full_name || member.email || 'U')
                  .split(' ').map((n: string) => n[0]).join('').slice(0, 2).toUpperCase()

                const badgeStyle = status === 'completed'
                  ? 'bg-green-100 text-green-700'
                  : status === 'in-progress'
                  ? 'bg-amber-100 text-amber-700'
                  : 'bg-red-50 text-red-500'
                const badgeLabel = status === 'completed' ? 'Completed' : status === 'in-progress' ? 'In Progress' : 'Pending'

                return (
                  <div key={member.id} className="flex items-center gap-3 py-2 border-b border-gray-50 last:border-0">
                    {/* Avatar */}
                    {member.avatar_url
                      ? <img src={member.avatar_url} alt={initials} className="w-9 h-9 rounded-full object-cover shrink-0" />
                      : <div className="w-9 h-9 rounded-full bg-green-100 flex items-center justify-center text-xs font-bold text-green-800 shrink-0">{initials}</div>
                    }
                    {/* Info */}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-bold font-serif leading-tight" style={{ color: '#1a472a' }}>{member.full_name || member.email}</p>
                      <p className="text-xs font-semibold truncate mt-0.5" style={{ color: '#52b788' }}>Working on {workLabel}</p>
                    </div>
                    {/* Status badge */}
                    <span className={`text-[11px] font-semibold px-2.5 py-1 rounded-full shrink-0 ${badgeStyle}`}>
                      {badgeLabel}
                    </span>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* Project Progress gauge */}
        <div className="lg:col-span-2 rounded-2xl border border-gray-100 p-5 flex flex-col relative overflow-hidden">
          {/* Background image */}
          <img
            src="/project-progress-bg.jpeg"
            alt=""
            className="absolute inset-0 w-full h-full object-cover"
            style={{ opacity: 0.30 }}
          />
          {/* Frosted overlay for readability */}
          <div className="absolute inset-0" style={{ background: 'rgba(255,255,255,0.60)' }} />
          <div className="flex items-center justify-between mb-3 relative z-10">
            <h3 className="text-lg font-bold" style={{ color: '#1a472a' }}>Project Progress</h3>
            <div className="flex items-center gap-1">
              {(['month', 'quarter', 'all'] as const).map(f => (
                <button
                  key={f}
                  onClick={() => setGaugeFilter(f)}
                  className={`px-2.5 py-1 rounded-lg text-[11px] font-semibold transition-colors ${
                    gaugeFilter === f ? 'text-white' : 'text-gray-400 hover:bg-gray-100'
                  }`}
                  style={gaugeFilter === f ? { background: '#1a472a' } : {}}
                >
                  {f === 'month' ? 'Month' : f === 'quarter' ? 'Quarter' : 'All'}
                </button>
              ))}
            </div>
          </div>
          <div className="flex-1 flex items-center justify-center relative z-10">
            <GaugeChart completed={gaugeCompleted} inProgress={gaugeInProgress} pending={gaugePending} />
          </div>
          {/* Legend */}
          <div className="flex items-center justify-center gap-4 mt-1 text-xs text-gray-500 relative z-10">
            <span className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full inline-block" style={{ background: '#52b788' }} />
              Completed
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full inline-block" style={{ background: '#1a472a' }} />
              In Progress
            </span>
            <span className="flex items-center gap-1.5">
              <svg width="10" height="10" className="inline-block">
                <rect width="10" height="10" fill="#dce8e0" />
                <rect width="10" height="10" fill="url(#gauge-hatch-legend)" />
                <defs>
                  <pattern id="gauge-hatch-legend" patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)">
                    <line x1="0" y1="0" x2="0" y2="6" stroke="#a8c4b4" strokeWidth="3" />
                  </pattern>
                </defs>
              </svg>
              Pending
            </span>
          </div>
        </div>

        {/* Time Tracker */}
        <div className="lg:col-span-1 rounded-2xl p-5 flex flex-col justify-between text-white relative overflow-hidden">
          {/* Full background image */}
          <img
            src="/tracker-bg.jpeg"
            alt=""
            aria-hidden="true"
            className="absolute inset-0 w-full h-full object-cover object-top pointer-events-none select-none"
          />
          {/* Thin dark scrim at bottom so text stays legible */}
          <div className="absolute inset-0 pointer-events-none" style={{ background: 'linear-gradient(to top, rgba(0,0,0,0.62) 0%, rgba(0,0,0,0.18) 55%, rgba(0,0,0,0.05) 100%)' }} />
          {/* Content */}
          <div className="relative z-10 flex items-center gap-2">
            <Timer className="w-4 h-4" style={{ color: '#1a472a' }} />
            <span className="text-sm font-bold" style={{ color: '#1a472a' }}>Today's Hours</span>
          </div>
          <div className="relative z-10">
            <p className="text-3xl font-bold tracking-wider mt-3 drop-shadow-md">
              {String(Math.floor(todayHours)).padStart(2, '0')}:
              {String(Math.round((todayHours % 1) * 60)).padStart(2, '0')}
            </p>
            <p className="text-xs text-white/70 mt-1">{todaySubmitted ? 'Submitted ✓' : 'Draft'}</p>
          </div>
          <button
            onClick={() => onNavigate('daily-reports')}
            className="relative z-10 mt-4 w-full py-2 rounded-xl text-xs font-semibold bg-black/20 hover:bg-black/35 backdrop-blur-sm transition-colors"
          >
            {todaySubmitted ? 'View Report' : 'Log Hours'}
          </button>
        </div>
      </div>

      {/* Work type donut */}
      {pieData.length > 0 && (
        <div className="bg-white rounded-2xl border border-gray-100 p-5">
          <LiquidGlassPie data={pieData} title="Work Type Distribution — This Month" />
        </div>
      )}

      {/* ── Add Member / Log Collaboration Modal ──────────────────────────── */}
      {showAddCollab && (
        <div
          className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4"
          onClick={() => setShowAddCollab(false)}
        >
          <div
            className="bg-white rounded-2xl shadow-2xl w-full max-w-md space-y-4 overflow-hidden"
            onClick={e => e.stopPropagation()}
          >
            {/* Modal header */}
            <div className="flex items-center justify-between px-6 pt-5">
              <div>
                <h2 className="text-base font-extrabold font-serif" style={{ color: '#1a472a' }}>Log Collaboration</h2>
                <p className="text-xs font-semibold mt-0.5" style={{ color: '#52b788' }}>Adds an entry to today's draft report.</p>
              </div>
              <button onClick={() => setShowAddCollab(false)} className="text-gray-400 hover:text-gray-600 transition-colors">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="px-6 space-y-3">
              {/* Colleague */}
              <div>
                <label className="text-xs font-bold block mb-1" style={{ color: '#1a472a' }}>Team Member *</label>
                <select value={collabColleague} onChange={e => setCollabColleague(e.target.value)} className={SEL}>
                  <option value="">Select colleague…</option>
                  {brandingMembers.map(m => (
                    <option key={m.id} value={m.id}>{m.full_name || m.email}</option>
                  ))}
                </select>
              </div>

              {/* Work type */}
              <div>
                <label className="text-xs font-bold block mb-1" style={{ color: '#1a472a' }}>Type of Work *</label>
                <select value={collabWorkType} onChange={e => { setCollabWorkType(e.target.value); setCollabSubCat('') }} className={SEL}>
                  <option value="">Select type…</option>
                  {categories.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
                </select>
              </div>

              {/* Sub category (if available) */}
              {collabSubCatOptions.length > 0 && (
                <div>
                  <label className="text-xs font-bold block mb-1" style={{ color: '#1a472a' }}>Sub Category</label>
                  <select value={collabSubCat} onChange={e => setCollabSubCat(e.target.value)} className={SEL}>
                    <option value="">Select sub-category…</option>
                    {collabSubCatOptions.map(s => <option key={s.id} value={s.name}>{s.name}</option>)}
                  </select>
                </div>
              )}

              {/* Description */}
              <div>
                <label className="text-xs font-bold block mb-1" style={{ color: '#1a472a' }}>Work Description *</label>
                <input
                  value={collabNote}
                  onChange={e => setCollabNote(e.target.value)}
                  placeholder="e.g. Worked on logo redesign together…"
                  className={INP}
                />
              </div>

              {/* Time taken */}
              <div>
                <label className="text-xs font-bold block mb-1" style={{ color: '#1a472a' }}>Time Taken *</label>
                <select value={collabTime} onChange={e => setCollabTime(e.target.value)} className={SEL}>
                  <option value="">Select duration…</option>
                  {TIME_OPTIONS.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>

              {todayReport?.is_locked && (
                <div className="flex items-center gap-2 p-3 bg-amber-50 border border-amber-100 rounded-xl text-xs text-amber-700">
                  <Lock className="w-3.5 h-3.5 shrink-0" />
                  Today's report is already submitted. You cannot add new entries.
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="flex gap-2 px-6 pb-5 pt-1">
              <button
                onClick={() => void logCollaboration()}
                disabled={collabSaving || todayReport?.is_locked}
                className="flex-1 py-2.5 rounded-xl text-sm font-semibold text-white disabled:opacity-50 transition-colors"
                style={{ background: '#1a472a' }}
              >
                {collabSaving ? 'Saving…' : 'Log Collaboration'}
              </button>
              <button
                onClick={() => setShowAddCollab(false)}
                className="px-5 py-2.5 rounded-xl text-sm border border-gray-200 text-gray-600 hover:bg-gray-50 transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Report Detail Popup ──────────────────────────────────────────── */}
      {reportPopup && (
        <div
          className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4"
          onClick={() => setReportPopup(null)}
        >
          <div
            className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[80vh] overflow-hidden flex flex-col"
            onClick={e => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
              <div>
                <h2 className="text-base font-extrabold font-serif" style={{ color: '#1a472a' }}>
                  Report — {new Date(reportPopup.report_date + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
                </h2>
                <p className="text-xs font-semibold mt-0.5 flex items-center gap-1.5" style={{ color: '#52b788' }}>
                  {reportPopup.is_locked
                    ? <><Lock className="w-3 h-3 text-green-600" /><span className="text-green-600 font-medium">Submitted</span></>
                    : <><AlertCircle className="w-3 h-3 text-amber-500" /><span className="text-amber-600 font-medium">Draft</span></>
                  }
                  <span className="text-gray-300">·</span>
                  Total: <span className="font-semibold text-gray-700">
                    {Math.round((reportPopup.rows?.reduce((s, r) => s + timeToHours(r.time_taken), 0) ?? 0) * 10) / 10} hrs
                  </span>
                </p>
              </div>
              <button onClick={() => setReportPopup(null)} className="text-gray-400 hover:text-gray-600 transition-colors p-1">
                <X className="w-5 h-5" />
              </button>
            </div>
            {/* Table */}
            <div className="overflow-y-auto flex-1 px-6 py-4">
              {!reportPopup.rows || reportPopup.rows.length === 0 ? (
                <p className="text-sm text-gray-400 text-center py-8">No entries in this report.</p>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-xs border-b border-gray-100" style={{ color: '#1a472a' }}>
                      <th className="text-left pb-2 font-bold w-8 pr-3">#</th>
                      <th className="text-left pb-2 font-bold pr-3">Type of Work</th>
                      <th className="text-left pb-2 font-bold pr-3">Specific Work</th>
                      <th className="text-left pb-2 font-bold whitespace-nowrap">Time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {reportPopup.rows.map(row => (
                      <tr key={row.id} className="border-b border-gray-50 last:border-0">
                        <td className="py-2.5 text-gray-400 pr-3">{row.sr_no}</td>
                        <td className="py-2.5 pr-3">
                          <span className="text-gray-700">{row.type_of_work}</span>
                          {row.sub_category && <span className="text-xs text-gray-400 block">{row.sub_category}</span>}
                        </td>
                        <td className="py-2.5 text-gray-600 pr-3">{row.specific_work}</td>
                        <td className="py-2.5 text-gray-700 font-medium whitespace-nowrap">{row.time_taken}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Analytics Page ─────────────────────────────────────────────────────────

type DateFilter = 'week' | 'month' | '3months' | 'custom'

function AnalyticsPage({ userId, users }: { userId: string; users: ReturnType<typeof useAppData>['users'] }) {
  const [filter, setFilter] = useState<DateFilter>('month')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')
  const [analytics, setAnalytics] = useState<{
    typeHours: Record<string, number>
    subCatHours: Record<string, Record<string, number>>
    collaboratorMap: Record<string, { hours: number; count: number }>
    totalReports: number
  } | null>(null)
  const [loading, setLoading] = useState(false)

  const getRange = useCallback((): { dateFrom: string; dateTo: string } => {
    const now = new Date()
    if (filter === 'week') {
      const start = new Date(now); start.setDate(now.getDate() - 6)
      return { dateFrom: fmtDate(start), dateTo: fmtDate(now) }
    }
    if (filter === 'month')
      return { dateFrom: fmtDate(new Date(now.getFullYear(), now.getMonth(), 1)), dateTo: fmtDate(now) }
    if (filter === '3months') {
      const start = new Date(now); start.setMonth(now.getMonth() - 3)
      return { dateFrom: fmtDate(start), dateTo: fmtDate(now) }
    }
    return { dateFrom: customFrom || fmtDate(new Date(now.getFullYear(), now.getMonth(), 1)), dateTo: customTo || fmtDate(now) }
  }, [filter, customFrom, customTo])

  useEffect(() => {
    if (filter === 'custom' && (!customFrom || !customTo)) return
    setLoading(true)
    const { dateFrom, dateTo } = getRange()
    brandingApi.getAnalytics({ dateFrom, dateTo, userId })
      .then(r => setAnalytics(r.analytics))
      .catch(() => toast.error('Failed to load analytics'))
      .finally(() => setLoading(false))
  }, [filter, customFrom, customTo, userId, getRange])

  const pieData = analytics
    ? Object.entries(analytics.typeHours).map(([name, value]) => ({ name, value: Math.round(value * 10) / 10 }))
    : []
  const collabData = analytics
    ? Object.entries(analytics.collaboratorMap)
        .sort((a, b) => b[1].hours - a[1].hours).slice(0, 8)
        .map(([idOrName, v]) => {
          const resolved = users.find(u => u.id === idOrName)
          const fullName = resolved?.full_name || idOrName
          return { name: fullName.split(' ')[0] || fullName.slice(0, 10), hours: Math.round(v.hours * 10) / 10 }
        })
    : []

  const aiSuggestions = useMemo(() => {
    if (!analytics) return []
    const suggestions: string[] = []
    const entries = Object.entries(analytics.typeHours)
    const total = entries.reduce((s, [, v]) => s + v, 0)
    if (total === 0) return ['No data for the selected period. Start submitting daily reports to see insights.']
    const dominant = [...entries].sort((a, b) => b[1] - a[1])[0]
    if (dominant && dominant[1] / total > 0.6)
      suggestions.push(`${Math.round((dominant[1] / total) * 100)}% of your time is on "${dominant[0]}". Consider diversifying your work areas.`)
    if (Object.keys(analytics.collaboratorMap).length === 0)
      suggestions.push('No collaboration logged this period. Working with colleagues can improve output quality.')
    if (analytics.totalReports < 5 && filter === 'month')
      suggestions.push(`Only ${analytics.totalReports} reports submitted this month. Consistent daily reporting helps track your progress.`)
    if (suggestions.length === 0)
      suggestions.push('Great work! Your time distribution looks balanced across multiple categories.')
    return suggestions
  }, [analytics, filter])

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-extrabold font-serif" style={{ color: '#1a472a' }}>Analytics</h1>
        <p className="text-sm font-semibold mt-0.5" style={{ color: '#52b788' }}>Track your work hours and collaboration patterns.</p>
      </div>

      {/* Filter bar */}
      <div className="bg-white rounded-2xl border border-gray-100 p-4 flex items-center gap-2 flex-wrap">
        {(['week', 'month', '3months', 'custom'] as DateFilter[]).map(f => (
          <button key={f} onClick={() => setFilter(f)}
            className={`px-4 py-1.5 rounded-full text-sm font-medium transition-colors ${filter === f ? 'text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
            style={filter === f ? { background: '#1a472a' } : {}}>
            {f === 'week' ? 'This Week' : f === 'month' ? 'This Month' : f === '3months' ? 'Last 3 Months' : 'Custom'}
          </button>
        ))}
        {filter === 'custom' && (
          <div className="flex items-center gap-2">
            <input type="date" value={customFrom} onChange={e => setCustomFrom(e.target.value)} className="text-xs border border-gray-200 rounded-lg px-2 py-1.5" />
            <span className="text-xs text-gray-400">–</span>
            <input type="date" value={customTo} onChange={e => setCustomTo(e.target.value)} className="text-xs border border-gray-200 rounded-lg px-2 py-1.5" />
          </div>
        )}
      </div>

      {loading && <p className="text-sm text-gray-400 text-center py-10 animate-pulse">Loading analytics…</p>}

      {!loading && analytics && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          {/* Time Distribution */}
          <div className="bg-white rounded-2xl border border-gray-100 p-5">
            {pieData.length === 0
              ? <>
                  <h3 className="text-sm font-extrabold font-serif mb-4" style={{ color: '#1a472a' }}>Time Distribution</h3>
                  <p className="text-sm text-gray-400 text-center py-10">No data for this period.</p>
                </>
              : <LiquidGlassPie data={pieData} title="Time Distribution" />
            }
          </div>

          {/* Collaboration */}
          <div className="rounded-2xl border border-gray-100 p-5 overflow-hidden relative" style={{ background: '#fff' }}>
            {/* Duck background */}
            <div className="absolute inset-0 z-0" style={{
              backgroundImage: 'url(/ducks-collab.png)',
              backgroundSize: 'cover',
              backgroundPosition: 'center',
              opacity: 0.18,
            }} />
            {/* Frosted overlay */}
            <div className="absolute inset-0 z-0" style={{
              background: 'linear-gradient(135deg, rgba(255,255,255,0.72) 0%, rgba(210,240,220,0.55) 100%)',
              backdropFilter: 'blur(2px)',
              WebkitBackdropFilter: 'blur(2px)',
            }} />
            <div className="relative z-10">
              <h3 className="text-sm font-extrabold font-serif mb-4 flex items-center gap-2" style={{ color: '#1a472a' }}>
                <Users className="w-4 h-4" style={{ color: '#1a472a' }} /> Collaboration Hours
              </h3>
              {collabData.length === 0
                ? <p className="text-sm text-gray-400 text-center py-10">No collaboration data.</p>
                : (
                  <ResponsiveContainer width="100%" height={220}>
                    <BarChart data={collabData} margin={{ top: 4, right: 0, left: -24, bottom: 0 }} barCategoryGap="30%">
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(26,71,42,0.08)" vertical={false} />
                      <XAxis dataKey="name" tick={false} tickLine={false} axisLine={false} />
                      <YAxis tick={{ fontSize: 11, fill: '#3a6b4a' }} tickLine={false} axisLine={false} allowDecimals={false} />
                      <Tooltip
                        formatter={(v: number) => [`${v} hrs`, 'Hours']}
                        contentStyle={{ borderRadius: 10, border: '1px solid rgba(26,71,42,0.15)', fontSize: 12, background: 'rgba(255,255,255,0.85)', backdropFilter: 'blur(8px)' }}
                      />
                      <Bar dataKey="hours" maxBarSize={44}
                        shape={(props: { x?: number; y?: number; width?: number; height?: number; fill?: string }) => {
                          const { x = 0, y = 0, width = 0, height = 0, fill } = props
                          if (!width || !height) return <g />
                          const rx = width / 2
                          return (
                            <g>
                              <rect x={x} y={y} width={width} height={height} rx={rx} ry={rx} fill={fill} opacity={0.85} />
                              <rect x={x + width * 0.2} y={y + 4} width={width * 0.25} height={Math.min(height * 0.4, 18)} rx={width * 0.12}
                                fill="rgba(255,255,255,0.4)" />
                            </g>
                          )
                        }}
                      >
                        {collabData.map((_, i) => (
                          <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                )
              }
            </div>
          </div>

          {/* Category Breakdown */}
          {Object.keys(analytics.subCatHours).length > 0 && (
            <div className="bg-white rounded-2xl border border-gray-100 p-5 lg:col-span-2">
              <h3 className="text-sm font-extrabold font-serif mb-4 flex items-center gap-2" style={{ color: '#1a472a' }}>
                <TrendingUp className="w-4 h-4" style={{ color: '#1a472a' }} /> Category Breakdown
              </h3>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-100 text-left">
                      <th className="pb-2 pr-4 text-xs font-bold" style={{ color: '#1a472a' }}>Category</th>
                      <th className="pb-2 pr-4 text-xs font-bold" style={{ color: '#1a472a' }}>Sub Category</th>
                      <th className="pb-2 text-xs font-bold text-right" style={{ color: '#1a472a' }}>Hours</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(analytics.subCatHours).flatMap(([cat, subs]) =>
                      Object.entries(subs).map(([sub, hrs], si) => (
                        <tr key={`${cat}-${sub}`} className="border-b border-gray-50 last:border-0">
                          <td className="py-2 pr-4 text-gray-800">{si === 0 ? cat : ''}</td>
                          <td className="py-2 pr-4 text-gray-500">{sub || '—'}</td>
                          <td className="py-2 text-right font-semibold text-green-800">{Math.round(hrs * 10) / 10}h</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* AI Suggestions */}
          <div className="bg-white rounded-2xl border border-gray-100 p-5 lg:col-span-2">
            <h3 className="text-sm font-extrabold font-serif mb-4 flex items-center gap-2" style={{ color: '#1a472a' }}>
              <Info className="w-4 h-4" style={{ color: '#1a472a' }} /> AI-Based Insights
            </h3>
            <div className="space-y-2">
              {aiSuggestions.map((s, i) => (
                <div key={i} className="flex items-start gap-3 p-3 rounded-xl bg-green-50 border border-green-100">
                  <AlertCircle className="w-4 h-4 text-green-700 shrink-0 mt-0.5" />
                  <p className="text-sm text-gray-700">{s}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Project Icon variants ──────────────────────────────────────────────────
function ProjectIcon({ index }: { index: number }) {
  const configs: { bg: string; svg: React.ReactNode }[] = [
    { bg: '#EFF6FF', svg: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
        <rect x="3" y="6" width="18" height="3" rx="1.5" fill="#3B82F6"/>
        <rect x="3" y="11" width="13" height="3" rx="1.5" fill="#60A5FA"/>
        <rect x="3" y="16" width="8" height="3" rx="1.5" fill="#93C5FD"/>
      </svg>
    )},
    { bg: '#ECFDF5', svg: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
        <path d="M12 3 A9 9 0 0 1 21 12 L12 12 Z" fill="#10B981"/>
        <path d="M12 12 A9 9 0 0 1 5.4 19.8 L12 12 Z" fill="#34D399"/>
        <path d="M5.4 19.8 A9 9 0 0 1 3 12 L12 12 Z" fill="#6EE7B7"/>
      </svg>
    )},
    { bg: '#FDF2F8', svg: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
        <path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.64 5.64l2.83 2.83M15.53 15.53l2.83 2.83M5.64 18.36l2.83-2.83M15.53 8.47l2.83-2.83" stroke="#EC4899" strokeWidth="2.5" strokeLinecap="round"/>
      </svg>
    )},
    { bg: '#FFFBEB', svg: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
        <path d="M12 3 L19 12 L12 21 L5 12 Z" fill="#F59E0B"/>
      </svg>
    )},
    { bg: '#F5F3FF', svg: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
        <circle cx="8" cy="8" r="3.5" fill="#8B5CF6"/>
        <circle cx="16" cy="8" r="3.5" fill="#A78BFA"/>
        <circle cx="8" cy="16" r="3.5" fill="#C4B5FD"/>
        <circle cx="16" cy="16" r="3.5" fill="#DDD6FE"/>
      </svg>
    )},
    { bg: '#ECFEFF', svg: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
        <path d="M13 3L6 14h7l-2 7 8-11h-7l2-9z" fill="#06B6D4"/>
      </svg>
    )},
  ]
  const c = configs[index % configs.length]
  return (
    <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0" style={{ background: c.bg }}>
      {c.svg}
    </div>
  )
}

// ── Daily Reports Page ─────────────────────────────────────────────────────

function DailyReportsPage({
  users,
  profile,
}: {
  users: ReturnType<typeof useAppData>['users']
  profile: ReturnType<typeof useAuth>['profile']
}) {
  const selectedDate = today()  // locked to today — no past/future submissions
  const [categories, setCategories] = useState<WorkCategory[]>([])
  const [report, setReport] = useState<DailyReport | null>(null)
  const [rows, setRows] = useState<DraftRow[]>([blankRow(1)])
  const [saving, setSaving] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  // ── Leave state ────────────────────────────────────────────────────────
  const [leaves, setLeaves] = useState<BrandingLeave[]>([])
  const [showLeaveModal, setShowLeaveModal] = useState(false)
  const [leaveDate, setLeaveDate] = useState(today())
  const [leaveReason, setLeaveReason] = useState('')
  const [leaveTransferDate, setLeaveTransferDate] = useState('')
  const [leaveSubmitting, setLeaveSubmitting] = useState(false)
  const [showTransferEdit, setShowTransferEdit] = useState<string | null>(null)
  const [transferEditVal, setTransferEditVal] = useState('')
  const isAdmin = profile?.role === 'admin' || profile?.role === 'super_admin'

  const [collabAnalytics, setCollabAnalytics] = useState<Record<string, { hours: number; count: number }>>({})
  const [collabFilter, setCollabFilter] = useState<'day' | 'week' | 'month' | 'custom'>('month')
  const [collabCustomFrom, setCollabCustomFrom] = useState('')
  const [collabCustomTo, setCollabCustomTo] = useState('')
  const [collabLoading, setCollabLoading] = useState(false)

  // ── Projects state ─────────────────────────────────────────────────────
  const [projects, setProjects] = useState<BrandingProject[]>([])
  const [showAddProject, setShowAddProject] = useState(false)
  const [projName, setProjName] = useState('')
  const [projDesc, setProjDesc] = useState('')
  const [projDeadline, setProjDeadline] = useState('')
  const [projSaving, setProjSaving] = useState(false)

  const colleagueOptions = useMemo(() =>
    users.filter(u => u.team === 'branding' && u.id !== profile?.id)
      .map(u => ({ id: u.id, label: u.full_name || u.email })),
    [users, profile])

  useEffect(() => {
    brandingApi.getCategories()
      .then(r => setCategories(r.categories))
      .catch(() => toast.error('Failed to load categories'))
  }, [])

  useEffect(() => {
    brandingApi.getLeaves(isAdmin ? 'pending' : undefined)
      .then(r => setLeaves(r.leaves))
      .catch(() => {})
  }, [isAdmin])

  useEffect(() => {
    brandingApi.getProjects()
      .then(r => setProjects(r.projects))
      .catch(() => {})
  }, [])

  async function addProject() {
    if (!projName.trim()) { toast.error('Project name is required.'); return }
    setProjSaving(true)
    try {
      const res = await brandingApi.createProject({
        name: projName.trim(),
        description: projDesc.trim() || undefined,
        deadline: projDeadline || undefined,
      })
      setProjects(prev => [res.project, ...prev])
      setProjName(''); setProjDesc(''); setProjDeadline('')
      setShowAddProject(false)
      toast.success('Project created!')
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to create project') }
    finally { setProjSaving(false) }
  }

  // Load collaboration stats for the graph — filter-aware
  useEffect(() => {
    if (!profile?.id) return
    const now = new Date()
    let dateFrom: string
    let dateTo = fmtDate(now)
    if (collabFilter === 'day') {
      dateFrom = fmtDate(now)
    } else if (collabFilter === 'week') {
      const d = new Date(now); d.setDate(d.getDate() - 6)
      dateFrom = fmtDate(d)
    } else if (collabFilter === 'month') {
      dateFrom = fmtDate(new Date(now.getFullYear(), now.getMonth(), 1))
    } else {
      if (!collabCustomFrom || !collabCustomTo) return
      dateFrom = collabCustomFrom
      dateTo = collabCustomTo
    }
    setCollabLoading(true)
    brandingApi.getAnalytics({ dateFrom, dateTo, userId: profile.id })
      .then(r => setCollabAnalytics(r.analytics.collaboratorMap))
      .catch(() => {})
      .finally(() => setCollabLoading(false))
  }, [profile?.id, collabFilter, collabCustomFrom, collabCustomTo])

  useEffect(() => {
    if (!selectedDate) return
    brandingApi.getReport(selectedDate)
      .then(r => {
        setReport(r.report)
        if (r.report.rows.length > 0) {
          setRows(r.report.rows.map(row => ({
            _key: row.id, sr_no: row.sr_no, type_of_work: row.type_of_work,
            sub_category: row.sub_category, specific_work: row.specific_work,
            time_taken: row.time_taken, collaborative_colleagues: row.collaborative_colleagues,
          })))
        } else if (!r.report.is_locked) {
          setRows([blankRow(1)])
        }
      })
      .catch(() => toast.error('Failed to load report'))
  }, [selectedDate])

  const subCatOptions = useCallback((typeOfWork: string) => {
    if (!typeOfWork) return []
    return categories.find(c => c.name === typeOfWork)?.sub_categories || []
  }, [categories])

  function updateRow(key: string, field: keyof DraftRow, value: unknown) {
    setRows(prev => prev.map(r => {
      if (r._key !== key) return r
      const updated = { ...r, [field]: value }
      if (field === 'type_of_work') updated.sub_category = ''
      return updated
    }))
  }

  const addRow = () => setRows(prev => [...prev, blankRow(prev.length + 1)])
  const deleteRow = (key: string) =>
    setRows(prev => prev.filter(r => r._key !== key).map((r, i) => ({ ...r, sr_no: i + 1 })))

  async function saveDraft() {
    if (!report || report.is_locked) return
    setSaving(true)
    try {
      await brandingApi.saveRows(report.id, rows.map(r => ({
        sr_no: r.sr_no, type_of_work: r.type_of_work, sub_category: r.sub_category,
        specific_work: r.specific_work, time_taken: r.time_taken, collaborative_colleagues: r.collaborative_colleagues,
      })))
      toast.success('Draft saved')
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to save') }
    finally { setSaving(false) }
  }

  async function submitReport() {
    if (!report || report.is_locked) return
    const invalid = rows.filter(r => !r.type_of_work || !r.sub_category || !r.specific_work || !r.time_taken)
    if (invalid.length > 0) {
      toast.error('Please fill all mandatory fields before submitting.')
      return
    }
    if (rows.length === 0) { toast.error('Add at least one row before submitting.'); return }
    setSubmitting(true)
    try {
      await brandingApi.saveRows(report.id, rows.map(r => ({
        sr_no: r.sr_no, type_of_work: r.type_of_work, sub_category: r.sub_category,
        specific_work: r.specific_work, time_taken: r.time_taken, collaborative_colleagues: r.collaborative_colleagues,
      })))
      const res = await brandingApi.submitReport(report.id)
      setReport(res.report)
      toast.success('Report submitted and locked!')
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to submit') }
    finally { setSubmitting(false) }
  }

  async function applyForLeave() {
    if (!leaveDate) { toast.error('Select a leave date.'); return }
    if (!leaveReason.trim()) { toast.error('Please provide a reason.'); return }
    setLeaveSubmitting(true)
    try {
      const res = await brandingApi.applyLeave({
        leave_date: leaveDate, reason: leaveReason.trim(),
        transfer_date: leaveTransferDate || undefined,
      })
      setLeaves(prev => {
        const idx = prev.findIndex(l => l.id === res.leave.id)
        return idx >= 0 ? prev.map((l, i) => i === idx ? res.leave : l) : [res.leave, ...prev]
      })
      toast.success('Leave application submitted!')
      setShowLeaveModal(false); setLeaveReason(''); setLeaveTransferDate('')
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to apply') }
    finally { setLeaveSubmitting(false) }
  }

  async function cancelLeaveById(id: string) {
    try {
      await brandingApi.cancelLeave(id)
      setLeaves(prev => prev.filter(l => l.id !== id))
      toast.success('Leave cancelled.')
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to cancel') }
  }

  async function saveTransferDate(id: string) {
    try {
      const res = await brandingApi.updateLeaveTransfer(id, transferEditVal || null)
      setLeaves(prev => prev.map(l => l.id === id ? res.leave : l))
      setShowTransferEdit(null)
      toast.success('Transfer date updated.')
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to update') }
  }

  async function reviewLeave(id: string, status: 'approved' | 'rejected') {
    try {
      const res = await brandingApi.reviewLeave(id, status)
      setLeaves(prev => prev.filter(l => l.id !== res.leave.id))
      toast.success(status === 'approved' ? 'Leave approved.' : 'Leave rejected.')
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed') }
  }

  const todayLeave = leaves.find(l => l.leave_date === selectedDate)

  const displayRows = report?.is_locked ? report.rows : rows
  const totalHours = useMemo(() =>
    displayRows.reduce((s, r) => s + timeToHours(r.time_taken), 0), [displayRows])

  const collabBarData = Object.entries(collabAnalytics)
    .sort((a, b) => b[1].hours - a[1].hours)
    .slice(0, 8)
    .map(([idOrName, v]) => {
      // Resolve user ID → full name (server may return IDs or names)
      const resolved = users.find(u => u.id === idOrName)
      const fullName = resolved?.full_name || idOrName
      return {
        name: fullName.split(' ')[0] || fullName.slice(0, 10),
        fullName,
        hours: Math.round(v.hours * 10) / 10,
      }
    })

  const statusColor = (s: BrandingProject['status']) =>
    s === 'active' ? 'bg-green-100 text-green-700' : s === 'completed' ? 'bg-blue-100 text-blue-700' : 'bg-amber-100 text-amber-700'
  const statusLabel = (s: BrandingProject['status']) =>
    s === 'active' ? 'Running' : s === 'completed' ? 'Completed' : 'On Hold'

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-extrabold font-serif" style={{ color: '#1a472a' }}>Daily Reports</h1>
        <p className="text-sm font-semibold mt-0.5" style={{ color: '#52b788' }}>Log your daily work and track collaboration.</p>
      </div>

      {/* ── Projects section — two cards ───────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

        {/* Card 1: Project List */}
        <div className="bg-white rounded-2xl border border-gray-100 p-5 flex flex-col">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-extrabold font-serif" style={{ color: '#1a472a' }}>Project</h2>
            <button
              onClick={() => setShowAddProject(true)}
              className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-sm font-semibold transition-colors hover:bg-green-50"
              style={{ border: '2px solid #1a472a', color: '#1a472a' }}
            >
              <Plus className="w-3.5 h-3.5" /> New
            </button>
          </div>
          {projects.length === 0 ? (
            <div className="flex-1 flex items-center justify-center py-8">
              <p className="text-sm text-gray-400 text-center">No projects yet.<br/>Click <strong>+ New</strong> to create one.</p>
            </div>
          ) : (
            <div className="space-y-3 overflow-y-auto max-h-72 pr-1">
              {projects.map((p, i) => (
                <div key={p.id} className="flex items-center gap-3 p-2 rounded-xl hover:bg-gray-50 transition-colors">
                  <ProjectIcon index={i} />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-bold font-serif truncate" style={{ color: '#1a472a' }}>{p.name}</p>
                    <p className="text-xs font-semibold" style={{ color: '#52b788' }}>
                      {p.deadline
                        ? `Due date: ${new Date(p.deadline).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`
                        : 'No deadline set'}
                    </p>
                  </div>
                  <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full shrink-0 ${statusColor(p.status)}`}>
                    {statusLabel(p.status)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Card 2: Project Progress gauge */}
        <div className="rounded-2xl border border-gray-100 p-5 flex flex-col relative overflow-hidden" style={{ background: '#fff' }}>
          <img src="/snail-progress.jpeg" alt="" className="absolute inset-0 w-full h-full object-cover" style={{ opacity: 0.22 }} />
          <div className="absolute inset-0" style={{ background: 'rgba(255,255,255,0.60)' }} />
          <h2 className="text-lg font-extrabold font-serif mb-2 relative z-10" style={{ color: '#1a472a' }}>Project Progress</h2>
          <div className="flex-1 flex items-center justify-center relative z-10">
            <GaugeChart
              completed={projects.filter(p => p.status === 'completed').length}
              inProgress={projects.filter(p => p.status === 'active').length}
              pending={projects.filter(p => p.status === 'on_hold').length}
            />
          </div>
          <div className="flex items-center justify-center gap-4 mt-1 text-xs font-semibold relative z-10" style={{ color: '#52b788' }}>
            <span className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full inline-block" style={{ background: '#52b788' }} />
              Completed
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full inline-block" style={{ background: '#1a472a' }} />
              In Progress
            </span>
            <span className="flex items-center gap-1.5">
              <svg width="10" height="10" className="inline-block">
                <rect width="10" height="10" fill="#dce8e0" />
                <rect width="10" height="10" fill="url(#rpt-hatch-legend)" />
                <defs>
                  <pattern id="rpt-hatch-legend" patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)">
                    <line x1="0" y1="0" x2="0" y2="6" stroke="#a8c4b4" strokeWidth="3" />
                  </pattern>
                </defs>
              </svg>
              Pending
            </span>
          </div>
        </div>
      </div>

      {/* ── Add Project Modal ─────────────────────────────────────────────── */}
      {showAddProject && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.45)' }}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-extrabold font-serif" style={{ color: '#1a472a' }}>New Project</h3>
              <button
                onClick={() => { setShowAddProject(false); setProjName(''); setProjDesc(''); setProjDeadline('') }}
                className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="text-xs font-bold uppercase tracking-wide mb-1 block" style={{ color: '#1a472a' }}>Project Name *</label>
                <input
                  placeholder="e.g. Brand Campaign Q2"
                  value={projName}
                  onChange={e => setProjName(e.target.value)}
                  className="w-full text-sm border border-gray-200 rounded-xl px-3 py-2.5 bg-white focus:outline-none focus:ring-2 focus:ring-green-200"
                  autoFocus
                />
              </div>
              <div>
                <label className="text-xs font-bold uppercase tracking-wide mb-1 block" style={{ color: '#1a472a' }}>Deadline</label>
                <input
                  type="date"
                  value={projDeadline}
                  onChange={e => setProjDeadline(e.target.value)}
                  className="w-full text-sm border border-gray-200 rounded-xl px-3 py-2.5 bg-white focus:outline-none focus:ring-2 focus:ring-green-200"
                />
              </div>
              <div>
                <label className="text-xs font-bold uppercase tracking-wide mb-1 block" style={{ color: '#1a472a' }}>Description</label>
                <textarea
                  placeholder="Optional description…"
                  value={projDesc}
                  onChange={e => setProjDesc(e.target.value)}
                  rows={3}
                  className="w-full text-sm border border-gray-200 rounded-xl px-3 py-2.5 bg-white focus:outline-none focus:ring-2 focus:ring-green-200 resize-none"
                />
              </div>
            </div>
            <div className="flex items-center gap-3 pt-1">
              <button
                onClick={() => void addProject()}
                disabled={projSaving}
                className="flex-1 py-2.5 rounded-xl text-sm font-semibold text-white disabled:opacity-50 transition-opacity"
                style={{ background: '#1a472a' }}
              >
                {projSaving ? 'Creating…' : 'Create Project'}
              </button>
              <button
                onClick={() => { setShowAddProject(false); setProjName(''); setProjDesc(''); setProjDeadline('') }}
                className="flex-1 py-2.5 rounded-xl text-sm border border-gray-200 text-gray-600 hover:bg-gray-50 transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Date + status bar */}
      <div className="bg-white rounded-2xl border border-gray-100 p-4 flex items-center gap-3 flex-wrap">
        <Calendar className="w-4 h-4 text-green-700 shrink-0" />
        <div className="flex items-center gap-2">
          <span className="text-sm font-bold font-serif" style={{ color: '#1a472a' }}>Today</span>
          <span className="text-sm font-semibold text-gray-500">
            {new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
          </span>
        </div>

        {/* Leave / report status badge */}
        {todayLeave?.status === 'approved'
          ? <span className="flex items-center gap-1.5 text-xs font-semibold text-blue-700 bg-blue-50 px-3 py-1.5 rounded-full">
              <AlertCircle className="w-3 h-3" /> On Leave
            </span>
          : todayLeave?.status === 'pending'
          ? <span className="flex items-center gap-1.5 text-xs font-semibold text-amber-700 bg-amber-50 px-3 py-1.5 rounded-full">
              <AlertCircle className="w-3 h-3" /> Leave Pending Approval
            </span>
          : report?.is_locked
          ? <span className="flex items-center gap-1.5 text-xs font-medium text-amber-700 bg-amber-50 px-3 py-1.5 rounded-full">
              <Lock className="w-3 h-3" /> Submitted — read only
            </span>
          : <span className="text-xs font-semibold bg-green-50 px-3 py-1.5 rounded-full" style={{ color: '#52b788' }}>
              Draft — not yet submitted
            </span>
        }

        {totalHours > 0 && (
          <span className="text-xs font-medium text-green-800 bg-green-50 px-3 py-1.5 rounded-full">
            {Math.round(totalHours * 10) / 10} hrs total
          </span>
        )}

        {/* Apply for leave button (not already on leave today) */}
        {!todayLeave && !report?.is_locked && (
          <button
            onClick={() => { setLeaveDate(today()); setShowLeaveModal(true) }}
            className="ml-auto flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-xs font-bold transition-colors hover:bg-red-50"
            style={{ border: '1.5px solid #dc2626', color: '#dc2626' }}
          >
            <AlertCircle className="w-3 h-3" /> Apply Leave
          </button>
        )}
        {todayLeave?.status === 'pending' && (
          <button
            onClick={() => cancelLeaveById(todayLeave.id)}
            className="ml-auto text-xs font-semibold text-red-500 hover:text-red-700 underline"
          >
            Cancel Leave
          </button>
        )}
      </div>

      {/* On Leave banner — shown instead of report form */}
      {todayLeave?.status === 'approved' && (
        <div className="bg-blue-50 border border-blue-100 rounded-2xl p-6 text-center space-y-2">
          <p className="text-2xl">🏖️</p>
          <p className="text-base font-extrabold font-serif" style={{ color: '#1a472a' }}>You are on approved leave today</p>
          <p className="text-sm font-semibold text-blue-600">No report submission required for {selectedDate}.</p>
          {todayLeave.transfer_date && (
            <p className="text-xs font-semibold text-gray-500 mt-1">
              Transfer day: <span className="font-bold" style={{ color: '#1a472a' }}>{todayLeave.transfer_date}</span>
            </p>
          )}
          <p className="text-xs text-gray-400 mt-2 italic">Reason: {todayLeave.reason || '—'}</p>
        </div>
      )}

      {/* Report table */}
      {todayLeave?.status !== 'approved' && (
      <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm border-collapse min-w-[900px]">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-100">
                {['Sr.', 'Type of Work *', 'Sub Category *', 'Specific Work *', 'Time Taken *', 'Collaborative Work'].map(h => (
                  <th key={h} className="text-left text-[11px] font-bold uppercase tracking-wider px-3 py-3 first:text-center first:w-12" style={{ color: '#1a472a' }}>{h}</th>
                ))}
                {!report?.is_locked && <th className="w-10" />}
              </tr>
            </thead>
            <tbody>
              {displayRows.length === 0 && (
                <tr>
                  <td colSpan={7} className="text-center text-sm text-gray-400 py-12">
                    No entries. Click <strong>Add Row</strong> to get started.
                  </td>
                </tr>
              )}
              {(report?.is_locked ? report.rows : rows).map((row, i) => {
                const isLocked = report?.is_locked
                const key = (row as DraftRow)._key || (row as import('@/lib/branding-types').DailyReportRow).id
                const subs = subCatOptions(row.type_of_work)
                const showSubText = row.type_of_work === 'Others' ||
                  (subs.length > 0 && subs.find(s => s.name === row.sub_category)?.is_others)

                return (
                  <tr key={key} className={`border-b border-gray-50 last:border-0 group hover:bg-green-50/30 ${i % 2 === 1 ? 'bg-gray-50/30' : ''}`}>
                    <td className="px-3 py-2 text-xs text-gray-400 font-medium text-center">{row.sr_no}</td>

                    <td className="px-2 py-2">
                      {isLocked ? <span>{row.type_of_work}</span>
                        : <select value={row.type_of_work} onChange={e => updateRow((row as DraftRow)._key, 'type_of_work', e.target.value)} className={SEL}>
                          <option value="">Select…</option>
                          {categories.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
                        </select>}
                    </td>

                    <td className="px-2 py-2">
                      {isLocked ? <span>{row.sub_category}</span>
                        : showSubText ? <input value={row.sub_category} onChange={e => updateRow((row as DraftRow)._key, 'sub_category', e.target.value)} placeholder="Type sub category…" className={INP} />
                        : <select value={row.sub_category} onChange={e => updateRow((row as DraftRow)._key, 'sub_category', e.target.value)} className={SEL}>
                          <option value="">Select…</option>
                          {subs.map(s => <option key={s.id} value={s.name}>{s.name}</option>)}
                        </select>}
                    </td>

                    <td className="px-2 py-2">
                      {isLocked ? <span>{row.specific_work}</span>
                        : <input value={row.specific_work} onChange={e => updateRow((row as DraftRow)._key, 'specific_work', e.target.value)} placeholder="Describe the work done…" className={INP} />}
                    </td>

                    <td className="px-2 py-2">
                      {isLocked ? <span>{row.time_taken}</span>
                        : <select value={row.time_taken} onChange={e => updateRow((row as DraftRow)._key, 'time_taken', e.target.value)} className={SEL}>
                          <option value="">Select…</option>
                          {TIME_OPTIONS.map(t => <option key={t} value={t}>{t}</option>)}
                        </select>}
                    </td>

                    <td className="px-2 py-2">
                      {isLocked
                        ? <span className="text-sm text-gray-500">
                            {row.collaborative_colleagues.length === 0 ? '—'
                              : row.collaborative_colleagues.map(id => colleagueOptions.find(o => o.id === id)?.label || id).join(', ')}
                          </span>
                        : <ColleaguesSelect options={colleagueOptions} value={row.collaborative_colleagues}
                            onChange={v => updateRow((row as DraftRow)._key, 'collaborative_colleagues', v)} />}
                    </td>

                    {!isLocked && (
                      <td className="px-2 py-2">
                        <button onClick={() => deleteRow((row as DraftRow)._key)}
                          className="opacity-0 group-hover:opacity-100 p-1 rounded text-gray-400 hover:text-red-500 transition-all">
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </td>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        <div className="px-4 py-3 bg-gray-50 border-t border-gray-100 flex items-center justify-between flex-wrap gap-2">
          <span className="text-xs font-semibold" style={{ color: '#52b788' }}>
            {displayRows.length} {displayRows.length === 1 ? 'row' : 'rows'}
            {totalHours > 0 && ` · ${Math.round(totalHours * 10) / 10} hrs total`}
          </span>
          {!report?.is_locked && (
            <button onClick={addRow} className="flex items-center gap-1 text-xs font-medium text-green-700 hover:text-green-800 transition-colors">
              <Plus className="w-3.5 h-3.5" /> Add Row
            </button>
          )}
        </div>
      </div>
      )} {/* end todayLeave !== approved */}

      {/* Action buttons */}
      {!report?.is_locked && todayLeave?.status !== 'approved' && (
        <div className="flex items-center gap-3">
          <button onClick={() => void saveDraft()} disabled={saving}
            className="px-5 py-2.5 rounded-xl border border-gray-200 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors disabled:opacity-50">
            {saving ? 'Saving…' : 'Save Draft'}
          </button>
          <button onClick={() => void submitReport()} disabled={submitting}
            className="flex items-center gap-2 px-6 py-2.5 rounded-xl text-sm font-semibold text-white disabled:opacity-50 transition-colors"
            style={{ background: '#1a472a' }}>
            <Send className="w-4 h-4" />
            {submitting ? 'Submitting…' : 'Submit Report'}
          </button>
          <p className="text-xs font-semibold" style={{ color: '#52b788' }}>Once submitted, the report cannot be edited.</p>
        </div>
      )}

      {/* ── Leave History (user) / Pending Leave Requests (admin) ─────── */}
      <div className="bg-white rounded-2xl border border-gray-100 p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-base font-extrabold font-serif" style={{ color: '#1a472a' }}>
            {isAdmin ? 'Pending Leave Requests' : 'My Leave Requests'}
          </h3>
          {!isAdmin && (
            <button
              onClick={() => { setLeaveDate(today()); setShowLeaveModal(true) }}
              className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-xs font-bold transition-colors hover:bg-red-50"
              style={{ border: '1.5px solid #dc2626', color: '#dc2626' }}
            >
              <AlertCircle className="w-3 h-3" /> Apply Leave
            </button>
          )}
        </div>

        {leaves.length === 0 ? (
          <p className="text-sm text-center py-6" style={{ color: '#52b788' }}>
            {isAdmin ? 'No pending leave requests.' : 'No leave requests yet.'}
          </p>
        ) : (
          <div className="space-y-3">
            {leaves.map(lv => (
              <div key={lv.id} className="flex items-start gap-4 p-3 rounded-xl border border-gray-100 hover:bg-gray-50 transition-colors">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    {isAdmin && lv.user_name && (
                      <span className="text-sm font-bold font-serif" style={{ color: '#1a472a' }}>{lv.user_name}</span>
                    )}
                    <span className="text-sm font-semibold text-gray-700">{lv.leave_date}</span>
                    <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                      lv.status === 'approved' ? 'bg-blue-100 text-blue-700' :
                      lv.status === 'rejected' ? 'bg-red-100 text-red-600' :
                      'bg-amber-100 text-amber-700'
                    }`}>
                      {lv.status.charAt(0).toUpperCase() + lv.status.slice(1)}
                    </span>
                  </div>
                  <p className="text-xs text-gray-500 mt-0.5">{lv.reason || '—'}</p>
                  {/* Transfer date row */}
                  <div className="flex items-center gap-2 mt-1">
                    <span className="text-xs font-semibold text-gray-400">Transfer day:</span>
                    {showTransferEdit === lv.id ? (
                      <div className="flex items-center gap-1.5">
                        <input type="date" value={transferEditVal}
                          onChange={e => setTransferEditVal(e.target.value)}
                          min={today()}
                          className="text-xs border border-gray-200 rounded-lg px-2 py-0.5 focus:outline-none focus:border-green-600" />
                        <button onClick={() => void saveTransferDate(lv.id)}
                          className="text-xs font-bold text-green-700 hover:text-green-900">Save</button>
                        <button onClick={() => setShowTransferEdit(null)}
                          className="text-xs text-gray-400 hover:text-gray-600">Cancel</button>
                      </div>
                    ) : (
                      <span className="text-xs font-semibold" style={{ color: '#1a472a' }}>
                        {lv.transfer_date || 'Not set'}
                        {!isAdmin && lv.status === 'pending' && (
                          <button
                            onClick={() => { setShowTransferEdit(lv.id); setTransferEditVal(lv.transfer_date || '') }}
                            className="ml-2 text-[10px] text-gray-400 underline hover:text-green-700"
                          >edit</button>
                        )}
                      </span>
                    )}
                  </div>
                </div>

                {/* Admin actions */}
                {isAdmin && lv.status === 'pending' && (
                  <div className="flex gap-2 shrink-0">
                    <button onClick={() => void reviewLeave(lv.id, 'approved')}
                      className="px-3 py-1.5 text-xs font-bold text-white rounded-lg"
                      style={{ background: '#1a472a' }}>Approve</button>
                    <button onClick={() => void reviewLeave(lv.id, 'rejected')}
                      className="px-3 py-1.5 text-xs font-bold text-red-600 border border-red-200 rounded-lg hover:bg-red-50">Reject</button>
                  </div>
                )}
                {/* User cancel */}
                {!isAdmin && lv.status === 'pending' && (
                  <button onClick={() => void cancelLeaveById(lv.id)}
                    className="text-xs text-red-400 hover:text-red-600 shrink-0 underline">Cancel</button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Leave Application Modal */}
      {showLeaveModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.45)' }}
          onClick={() => setShowLeaveModal(false)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6 space-y-4" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h3 className="text-base font-extrabold font-serif" style={{ color: '#1a472a' }}>Apply for Leave</h3>
              <button onClick={() => setShowLeaveModal(false)} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400"><X className="w-4 h-4" /></button>
            </div>

            <div className="space-y-3">
              <div>
                <label className="text-xs font-bold uppercase tracking-wide mb-1 block" style={{ color: '#1a472a' }}>Leave Date *</label>
                <input type="date" value={leaveDate} min={today()}
                  onChange={e => setLeaveDate(e.target.value)}
                  className="w-full text-sm border border-gray-200 rounded-xl px-3 py-2.5 bg-white focus:outline-none focus:ring-2 focus:ring-green-200" />
                <p className="text-[10px] text-gray-400 mt-0.5">Only today or future dates allowed.</p>
              </div>
              <div>
                <label className="text-xs font-bold uppercase tracking-wide mb-1 block" style={{ color: '#1a472a' }}>Reason *</label>
                <textarea value={leaveReason} onChange={e => setLeaveReason(e.target.value)}
                  placeholder="Brief reason for leave…" rows={3}
                  className="w-full text-sm border border-gray-200 rounded-xl px-3 py-2.5 bg-white focus:outline-none focus:ring-2 focus:ring-green-200 resize-none" />
              </div>
              <div>
                <label className="text-xs font-bold uppercase tracking-wide mb-1 block" style={{ color: '#1a472a' }}>Transfer Leave to (optional)</label>
                <input type="date" value={leaveTransferDate} min={today()}
                  onChange={e => setLeaveTransferDate(e.target.value)}
                  className="w-full text-sm border border-gray-200 rounded-xl px-3 py-2.5 bg-white focus:outline-none focus:ring-2 focus:ring-green-200" />
                <p className="text-[10px] text-gray-400 mt-0.5">If you'll work on another day to compensate, pick it here.</p>
              </div>
            </div>

            <div className="flex gap-3 pt-1">
              <button onClick={() => void applyForLeave()} disabled={leaveSubmitting}
                className="flex-1 py-2.5 rounded-xl text-sm font-semibold text-white disabled:opacity-50"
                style={{ background: '#1a472a' }}>
                {leaveSubmitting ? 'Submitting…' : 'Submit Leave Request'}
              </button>
              <button onClick={() => setShowLeaveModal(false)}
                className="flex-1 py-2.5 rounded-xl text-sm border border-gray-200 text-gray-600 hover:bg-gray-50">
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Collaboration Graph */}
      <div className="rounded-2xl border border-gray-100 overflow-hidden relative">
        {/* Teamwork background */}
        <img src="/teamwork-bg.jpeg" alt="" aria-hidden="true"
          className="absolute inset-0 w-full h-full object-cover object-center pointer-events-none select-none"
          style={{ opacity: 0.18 }} />
        {/* Frosted overlay */}
        <div className="absolute inset-0 pointer-events-none"
          style={{ background: 'rgba(244,247,244,0.82)' }} />

        <div className="relative z-10 p-5">
          <div className="flex items-start justify-between gap-3 mb-1 flex-wrap">
            <h3 className="text-base font-extrabold font-serif flex items-center gap-2" style={{ color: '#1a472a' }}>
              <Users className="w-4 h-4" style={{ color: '#1a472a' }} /> Collaboration Graph
            </h3>
            {/* Filter buttons */}
            <div className="flex items-center gap-1.5 flex-wrap">
              {(['day', 'week', 'month', 'custom'] as const).map(f => (
                <button
                  key={f}
                  onClick={() => setCollabFilter(f)}
                  className={`px-2.5 py-1 rounded-lg text-[11px] font-bold transition-all ${
                    collabFilter === f ? 'text-[#1a472a]' : 'text-gray-400 hover:bg-white/60'
                  }`}
                  style={collabFilter === f ? {
                    border: '1.5px solid #1a472a',
                    background: 'linear-gradient(135deg, rgba(255,255,255,0.75) 0%, rgba(210,240,220,0.60) 100%)',
                    backdropFilter: 'blur(8px)',
                    WebkitBackdropFilter: 'blur(8px)',
                    boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.9)',
                  } : {}}
                >
                  {f === 'day' ? '1 Day' : f === 'week' ? '1 Week' : f === 'month' ? '1 Month' : 'Custom'}
                </button>
              ))}
            </div>
          </div>
          {/* Custom date range */}
          {collabFilter === 'custom' && (
            <div className="flex items-center gap-2 mt-2 mb-3">
              <input type="date" value={collabCustomFrom} onChange={e => setCollabCustomFrom(e.target.value)}
                className="text-xs px-2 py-1.5 rounded-lg border border-gray-200 bg-white/80 focus:outline-none focus:border-green-600" />
              <span className="text-xs font-semibold" style={{ color: '#52b788' }}>to</span>
              <input type="date" value={collabCustomTo} onChange={e => setCollabCustomTo(e.target.value)}
                className="text-xs px-2 py-1.5 rounded-lg border border-gray-200 bg-white/80 focus:outline-none focus:border-green-600" />
            </div>
          )}
          <p className="text-xs font-semibold mb-4" style={{ color: '#52b788' }}>
            {collabFilter === 'day' ? "Today's collaboration hours." :
             collabFilter === 'week' ? 'Last 7 days collaboration hours.' :
             collabFilter === 'month' ? "This month's collaboration hours." :
             'Custom range collaboration hours.'}
          </p>
          {collabLoading
            ? <p className="text-sm text-center py-8 animate-pulse" style={{ color: '#52b788' }}>Loading…</p>
            : collabBarData.length === 0
            ? <p className="text-sm text-center py-8" style={{ color: '#52b788' }}>No collaboration data for this period.</p>
            : (
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={collabBarData} margin={{ top: 4, right: 0, left: -24, bottom: 0 }} barCategoryGap="35%">
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(26,71,42,0.08)" vertical={false} />
                  <XAxis dataKey="name" tick={false} tickLine={false} axisLine={false} />
                  <YAxis tick={{ fontSize: 11, fill: '#6b8f71' }} tickLine={false} axisLine={false} allowDecimals={false} />
                  <Tooltip
                    formatter={(v: number, _: string, props: { payload?: { fullName?: string } }) => [
                      `${v} hrs`, props.payload?.fullName || 'Hours'
                    ]}
                    contentStyle={{
                      borderRadius: 12, border: '1px solid rgba(255,255,255,0.6)',
                      background: 'rgba(255,255,255,0.82)', backdropFilter: 'blur(12px)',
                      fontSize: 12,
                    }}
                  />
                  <Bar
                    dataKey="hours"
                    maxBarSize={40}
                    shape={(props: object) => {
                      const { x = 0, y = 0, width = 0, height = 0, index = 0 } = props as {
                        x?: number; y?: number; width?: number; height?: number; index?: number
                      }
                      if (height <= 0) return <g />
                      const r = width / 2
                      const color = PIE_COLORS[(index as number) % PIE_COLORS.length]
                      return (
                        <g>
                          {/* capsule: full-height track (faint) */}
                          <rect x={x} y={y - r} width={width} height={height + r} rx={r}
                            fill={color} opacity={0.15} />
                          {/* capsule: actual filled bar */}
                          <rect x={x} y={y} width={width} height={height + r} rx={r}
                            fill={color} />
                          {/* gloss highlight */}
                          <rect x={x + width * 0.2} y={y + 4} width={width * 0.25} height={Math.min(height * 0.4, 20)} rx={width * 0.12}
                            fill="rgba(255,255,255,0.35)" />
                        </g>
                      )
                    }}
                  >
                    {collabBarData.map((_, i) => (
                      <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )
          }
        </div>
      </div>
    </div>
  )
}

// ── Settings Page ──────────────────────────────────────────────────────────

function SettingsPage({ profile }: { profile: ReturnType<typeof useAuth>['profile'] }) {
  const [fullName, setFullName] = useState(profile?.full_name || '')
  const [designation, setDesignation] = useState(profile?.department || '')
  const [phone, setPhone] = useState(() => localStorage.getItem(`phone_${profile?.id}`) || '')
  const [avatarUrl, setAvatarUrl] = useState<string>(
    () => profile?.avatar_url || localStorage.getItem(`avatar_${profile?.id}`) || ''
  )
  const [avatarUploading, setAvatarUploading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [editMode, setEditMode] = useState(false)
  const [newPwd, setNewPwd] = useState('')
  const [confirmPwd, setConfirmPwd] = useState('')
  const [pwdSaving, setPwdSaving] = useState(false)
  const [section, setSection] = useState<'profile' | 'security' | 'team'>('profile')

  async function handleAvatarChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    if (file.size > 3 * 1024 * 1024) { toast.error('Image must be under 3 MB.'); return }
    setAvatarUploading(true)
    try {
      const res = await api.uploadAvatar(file)
      setAvatarUrl(res.avatar_url)
      toast.success('Profile photo updated!')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to upload photo')
    } finally {
      setAvatarUploading(false)
    }
  }

  async function saveProfile() {
    if (!profile?.id) return
    setSaving(true)
    try {
      if (profile?.id) localStorage.setItem(`phone_${profile.id}`, phone)
      await api.updateMe({ full_name: fullName, department: designation })
      toast.success('Profile updated!')
      setEditMode(false)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save profile')
    } finally {
      setSaving(false)
    }
  }

  async function changePassword() {
    if (!newPwd) { toast.error('Enter a new password.'); return }
    if (newPwd !== confirmPwd) { toast.error('Passwords do not match.'); return }
    if (newPwd.length < 8) { toast.error('Minimum 8 characters required.'); return }
    if (!profile?.id) return
    setPwdSaving(true)
    try {
      await api.updateUser(profile.id, { password: newPwd })
      toast.success('Password changed!')
      setNewPwd(''); setConfirmPwd('')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to change password')
    } finally {
      setPwdSaving(false)
    }
  }

  const initials = (profile?.full_name || profile?.email || 'U')
    .split(' ').map((n: string) => n[0]).join('').slice(0, 2).toUpperCase()

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="text-3xl font-extrabold font-serif" style={{ color: '#1a472a' }}>Settings</h1>
        <p className="text-sm font-semibold mt-0.5" style={{ color: '#52b788' }}>Manage your profile and account preferences.</p>
      </div>

      {/* Section tabs */}
      <div className="flex gap-1 bg-gray-100 rounded-xl p-1">
        {(['profile', 'security', 'team'] as const).map(s => (
          <button key={s} onClick={() => setSection(s)}
            className={`flex-1 py-2 rounded-lg text-sm font-semibold capitalize transition-all ${
              section === s ? 'bg-white shadow-sm text-gray-800' : 'text-gray-500 hover:text-gray-700'
            }`}>
            {s === 'profile' ? 'Profile' : s === 'security' ? 'Security' : 'Team'}
          </button>
        ))}
      </div>

      {section === 'profile' && (
        <div className="bg-white rounded-2xl border border-gray-100 p-6 space-y-6">
          {/* Avatar + name row */}
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-5">
              <div className="relative shrink-0 group">
                {avatarUrl
                  ? <img src={avatarUrl} alt="avatar" className="w-20 h-20 rounded-2xl object-cover" />
                  : (
                    <div className="w-20 h-20 rounded-2xl bg-green-100 flex items-center justify-center text-2xl font-bold text-green-800">
                      {initials}
                    </div>
                  )
                }
                {/* Always-visible camera button — user can change photo any time */}
                <label className={`absolute -bottom-1.5 -right-1.5 w-7 h-7 rounded-full bg-white border border-gray-200 shadow flex items-center justify-center cursor-pointer hover:bg-green-50 transition-colors ${avatarUploading ? 'opacity-60 pointer-events-none' : ''}`}>
                  {avatarUploading
                    ? <div className="w-3.5 h-3.5 border-2 border-green-700 border-t-transparent rounded-full animate-spin" />
                    : <Camera className="w-3.5 h-3.5" style={{ color: '#1a472a' }} />
                  }
                  <input type="file" accept="image/*" className="hidden" onChange={handleAvatarChange} disabled={avatarUploading} />
                </label>
              </div>
              <div>
                <p className="font-bold font-serif" style={{ color: '#1a472a' }}>{profile?.full_name || 'Your Name'}</p>
                <p className="text-sm font-semibold" style={{ color: '#52b788' }}>{profile?.email}</p>
                <p className="text-xs font-semibold mt-1" style={{ color: '#52b788' }}>Click the camera icon to change your photo</p>
              </div>
            </div>
            {/* Edit / Cancel toggle */}
            {!editMode ? (
              <button
                onClick={() => setEditMode(true)}
                className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-bold border-2 transition-colors hover:bg-green-50"
                style={{ borderColor: '#1a472a', color: '#1a472a' }}
              >
                <ArrowUpRight className="w-3.5 h-3.5" /> Edit Profile
              </button>
            ) : (
              <button
                onClick={() => { setEditMode(false); setFullName(profile?.full_name || ''); setDesignation(profile?.department || '') }}
                className="px-4 py-2 rounded-xl text-sm font-bold border border-gray-200 text-gray-500 hover:bg-gray-50 transition-colors"
              >
                Cancel
              </button>
            )}
          </div>

          {/* Read-only view */}
          {!editMode && (
            <div className="grid grid-cols-2 gap-4">
              {[
                { label: 'Full Name', value: profile?.full_name || '—' },
                { label: 'Designation / Role', value: profile?.department || '—' },
                { label: 'Email Address', value: profile?.email || '—' },
                { label: 'Phone Number', value: phone || '—' },
              ].map(item => (
                <div key={item.label} className="rounded-xl bg-gray-50 border border-gray-100 p-3">
                  <p className="text-xs font-bold mb-0.5" style={{ color: '#52b788' }}>{item.label}</p>
                  <p className="text-sm font-semibold truncate" style={{ color: '#1a472a' }}>{item.value}</p>
                </div>
              ))}
            </div>
          )}

          {/* Edit form */}
          {editMode && (
            <>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-xs font-bold block mb-1" style={{ color: '#1a472a' }}>Full Name</label>
                  <input value={fullName} onChange={e => setFullName(e.target.value)} className={INP} placeholder="Your full name" autoFocus />
                </div>
                <div>
                  <label className="text-xs font-bold block mb-1" style={{ color: '#1a472a' }}>Designation / Role</label>
                  <input value={designation} onChange={e => setDesignation(e.target.value)} className={INP} placeholder="e.g. Graphic Designer" />
                </div>
                <div>
                  <label className="text-xs font-bold block mb-1" style={{ color: '#1a472a' }}>Email Address</label>
                  <div className="relative">
                    <input value={profile?.email || ''} readOnly className={`${INP} bg-gray-50 cursor-not-allowed text-gray-400 pr-24`} />
                    <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-amber-600 bg-amber-50 px-1.5 py-0.5 rounded font-medium">Contact admin</span>
                  </div>
                </div>
                <div>
                  <label className="text-xs font-bold block mb-1" style={{ color: '#1a472a' }}>
                    <span className="flex items-center gap-1"><Phone className="w-3 h-3" /> Phone Number</span>
                  </label>
                  <input value={phone} onChange={e => setPhone(e.target.value)} className={INP} placeholder="+91 98765 43210" type="tel" />
                </div>
              </div>
              <button onClick={() => void saveProfile()} disabled={saving}
                className="px-6 py-2.5 rounded-xl text-sm font-semibold text-white disabled:opacity-50 transition-colors"
                style={{ background: '#1a472a' }}>
                {saving ? 'Saving…' : 'Save Changes'}
              </button>
            </>
          )}
        </div>
      )}

      {section === 'security' && (
        <div className="bg-white rounded-2xl border border-gray-100 p-6 space-y-5">
          <div>
            <h3 className="text-sm font-extrabold font-serif flex items-center gap-2" style={{ color: '#1a472a' }}>
              <Shield className="w-4 h-4" style={{ color: '#1a472a' }} /> Change Password
            </h3>
            <p className="text-xs font-semibold mt-0.5" style={{ color: '#52b788' }}>Use at least 8 characters with a mix of letters and numbers.</p>
          </div>
          <div className="space-y-3">
            <div>
              <label className="text-xs font-bold block mb-1" style={{ color: '#1a472a' }}>New Password</label>
              <input type="password" value={newPwd} onChange={e => setNewPwd(e.target.value)}
                className={INP} placeholder="Min. 8 characters" />
            </div>
            <div>
              <label className="text-xs font-bold block mb-1" style={{ color: '#1a472a' }}>Confirm New Password</label>
              <input type="password" value={confirmPwd} onChange={e => setConfirmPwd(e.target.value)}
                className={INP} placeholder="Repeat new password" />
            </div>
            {newPwd && confirmPwd && newPwd !== confirmPwd && (
              <p className="text-xs text-red-500 flex items-center gap-1">
                <AlertCircle className="w-3 h-3" /> Passwords do not match
              </p>
            )}
          </div>
          <button onClick={() => void changePassword()}
            disabled={pwdSaving || !newPwd || !confirmPwd || newPwd !== confirmPwd}
            className="flex items-center gap-2 px-6 py-2.5 rounded-xl text-sm font-semibold text-white disabled:opacity-50 transition-colors"
            style={{ background: '#1a472a' }}>
            <Shield className="w-4 h-4" /> {pwdSaving ? 'Updating…' : 'Update Password'}
          </button>
        </div>
      )}

      {section === 'team' && (
        <div className="bg-white rounded-2xl border border-gray-100 p-6 space-y-4">
          <h3 className="text-sm font-extrabold font-serif" style={{ color: '#1a472a' }}>Team Information</h3>
          <div className="grid grid-cols-2 gap-3">
            {[
              { label: 'Team', value: 'Branding Team' },
              { label: 'Role', value: 'Member' },
              { label: 'Department', value: profile?.department || '—' },
              { label: 'Account ID', value: profile?.id?.slice(0, 8).toUpperCase() + '…' || '—' },
            ].map(item => (
              <div key={item.label} className="rounded-xl bg-gray-50 border border-gray-100 p-4">
                <p className="text-xs font-semibold mb-1" style={{ color: '#52b788' }}>{item.label}</p>
                <p className="text-sm font-bold" style={{ color: '#1a472a' }}>{item.value}</p>
              </div>
            ))}
          </div>
          <div className="rounded-xl bg-green-50 border border-green-100 p-4">
            <p className="text-xs font-semibold text-green-800 mb-1">Team Permissions</p>
            <ul className="text-xs text-green-700 space-y-1 list-disc list-inside">
              <li>Submit daily work reports</li>
              <li>Upload and browse design gallery</li>
              <li>Submit monthly self-appraisal</li>
              <li>Peer-mark team members (when enabled)</li>
            </ul>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Help Page ──────────────────────────────────────────────────────────────

function HelpPage({ onNavigate }: { onNavigate: (p: NavPage) => void }) {
  const [openFaq, setOpenFaq] = useState<number | null>(null)

  const faqs = [
    { q: 'How do I submit my daily report?', a: 'Go to Daily Reports from the left sidebar. Fill in your work rows (type of work, specific task, time taken, and any collaborators), then click Submit Report. Reports lock once submitted.' },
    { q: 'Can I edit a submitted report?', a: 'No. Once submitted (locked), reports cannot be edited. Make sure all entries are correct before submitting.' },
    { q: 'When is the self-appraisal window?', a: 'From the 20th to the last day of each month you can submit your KRA self-appraisal. It can only be submitted once per month per year.' },
    { q: 'How does peer marking work?', a: 'When your admin enables peer marking, you can rate colleagues on KRA parameters. Submissions are anonymous — no one can see who gave which score.' },
    { q: 'How do I log collaboration work?', a: 'From the Dashboard, click "+ Add Member" in the Team Collaboration card. This creates an entry in today\'s draft report tagged to your colleague.' },
    { q: 'How do I upload designs to the gallery?', a: 'Go to Design Gallery from the sidebar. Click "Upload Design", fill in the title, category, and tags, then attach your image. It becomes visible to the whole team immediately.' },
    { q: 'What does the Work Analytics chart show?', a: 'The pill bar chart shows your submitted hours per day/month. Dark green = submitted reports, lighter green = drafts, hatched = no data. Click a submitted bar to see that day\'s full report.' },
  ]

  const shortcuts = [
    { keys: '⌘F / Ctrl+F', desc: 'Open search (reports & projects)' },
    { keys: 'Esc', desc: 'Close any open modal or panel' },
  ]

  const quickLinks: { icon: React.ElementType; title: string; desc: string; page: NavPage; color: string }[] = [
    { icon: ClipboardList, title: 'Submit Daily Report', desc: 'Log your work for today', page: 'daily-reports', color: '#1B6CA8' },
    { icon: BarChart2, title: 'View Analytics', desc: 'See your hours & trends', page: 'analytics', color: '#00827F' },
    { icon: Award, title: 'Self Appraisal', desc: 'Submit your KRA scores', page: 'self-appraisal', color: '#7B3F9E' },
    { icon: LayoutGrid, title: 'Design Gallery', desc: 'Browse & upload designs', page: 'gallery', color: '#C8A951' },
  ]

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="text-3xl font-extrabold font-serif" style={{ color: '#1a472a' }}>Help & Support</h1>
        <p className="text-sm font-semibold mt-0.5" style={{ color: '#52b788' }}>Learn how to use the Branding Portal and find answers fast.</p>
      </div>

      {/* Quick navigation cards */}
      <div className="grid grid-cols-2 gap-3">
        {quickLinks.map(item => (
          <button key={item.title} onClick={() => onNavigate(item.page)}
            className="bg-white rounded-2xl border border-gray-100 p-4 flex items-start gap-3 hover:shadow-sm transition-all text-left">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0"
              style={{ background: item.color + '18' }}>
              <item.icon className="w-4 h-4" style={{ color: item.color }} />
            </div>
            <div>
              <p className="text-sm font-bold font-serif" style={{ color: '#1a472a' }}>{item.title}</p>
              <p className="text-xs font-semibold mt-0.5" style={{ color: '#52b788' }}>{item.desc}</p>
            </div>
          </button>
        ))}
      </div>

      {/* FAQ accordion */}
      <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-50 flex items-center gap-2">
          <BookOpen className="w-4 h-4" style={{ color: '#1a472a' }} />
          <h3 className="text-sm font-extrabold font-serif" style={{ color: '#1a472a' }}>Frequently Asked Questions</h3>
        </div>
        <div className="divide-y divide-gray-50">
          {faqs.map((faq, i) => (
            <div key={i}>
              <button
                onClick={() => setOpenFaq(openFaq === i ? null : i)}
                className="w-full flex items-center justify-between px-5 py-3.5 text-left hover:bg-gray-50 transition-colors gap-4"
              >
                <span className="text-sm font-bold" style={{ color: '#1a472a' }}>{faq.q}</span>
                <ChevronDown className={`w-4 h-4 text-gray-400 shrink-0 transition-transform duration-200 ${openFaq === i ? 'rotate-180' : ''}`} />
              </button>
              {openFaq === i && (
                <div className="px-5 pb-4">
                  <p className="text-sm font-semibold leading-relaxed" style={{ color: '#52b788' }}>{faq.a}</p>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Keyboard shortcuts */}
      <div className="bg-white rounded-2xl border border-gray-100 p-5">
        <div className="flex items-center gap-2 mb-4">
          <Keyboard className="w-4 h-4" style={{ color: '#1a472a' }} />
          <h3 className="text-sm font-extrabold font-serif" style={{ color: '#1a472a' }}>Keyboard Shortcuts</h3>
        </div>
        <div className="space-y-2.5">
          {shortcuts.map(s => (
            <div key={s.keys} className="flex items-center justify-between">
              <span className="text-sm font-semibold" style={{ color: '#52b788' }}>{s.desc}</span>
              <kbd className="px-2.5 py-1 rounded-lg bg-gray-100 text-xs font-mono font-bold text-gray-700 border border-gray-200">{s.keys}</kbd>
            </div>
          ))}
        </div>
      </div>

      {/* Feature overview */}
      <div className="bg-white rounded-2xl border border-gray-100 p-5">
        <div className="flex items-center gap-2 mb-4">
          <MessageCircle className="w-4 h-4" style={{ color: '#1a472a' }} />
          <h3 className="text-sm font-extrabold font-serif" style={{ color: '#1a472a' }}>Portal Features</h3>
        </div>
        <div className="grid grid-cols-2 gap-3">
          {[
            { title: 'Daily Reports', desc: 'Log work hours with type, task, time, and collaborators.' },
            { title: 'Work Analytics', desc: 'Visual charts of your weekly/monthly productivity.' },
            { title: 'Design Gallery', desc: 'Upload, browse, and vote on team design work.' },
            { title: 'KRA Appraisal', desc: 'Self-assess and peer-mark on performance parameters.' },
            { title: 'Project Tracker', desc: 'View and manage active team projects.' },
            { title: 'Team Collaboration', desc: 'Tag colleagues in your daily reports.' },
          ].map(f => (
            <div key={f.title} className="rounded-xl bg-gray-50 p-3">
              <p className="text-xs font-bold font-serif" style={{ color: '#1a472a' }}>{f.title}</p>
              <p className="text-[11px] font-semibold mt-0.5 leading-snug" style={{ color: '#52b788' }}>{f.desc}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Support footer */}
      <div className="bg-white rounded-2xl border border-gray-100 p-5 flex items-center justify-between flex-wrap gap-3">
        <div>
          <p className="text-sm font-bold font-serif" style={{ color: '#1a472a' }}>Nerve — Branding Portal</p>
          <p className="text-xs font-semibold mt-0.5" style={{ color: '#52b788' }}>Parul University Knowledge Hub · v1.0</p>
        </div>
        <div className="text-xs text-gray-500">
          Need help? <span className="font-semibold" style={{ color: '#1a472a' }}>admin@paruluniversity.ac.in</span>
        </div>
      </div>
    </div>
  )
}

// ── Self Appraisal Page ────────────────────────────────────────────────────

function SelfAppraisalPage({
  users,
  profile,
}: {
  users: ReturnType<typeof useAppData>['users']
  profile: ReturnType<typeof useAuth>['profile']
}) {
  const [kraParams, setKraParams] = useState<KraParameter[]>([])
  const [appraisalMonth, setAppraisalMonth] = useState(new Date().getMonth() + 1)
  const [appraisalYear, setAppraisalYear] = useState(new Date().getFullYear())
  const [selfAppraisal, setSelfAppraisal] = useState<SelfAppraisal | null>(null)
  const [selfScores, setSelfScores] = useState<Record<string, number>>({})
  const [selfLoading, setSelfLoading] = useState(false)
  const [confirmSubmit, setConfirmSubmit] = useState(false)
  const [peerEnabled, setPeerEnabled] = useState(false)
  const [peerColleague, setPeerColleague] = useState('')
  const [peerScores, setPeerScores] = useState<Record<string, number>>({})
  const [completedPeers, setCompletedPeers] = useState<string[]>([])
  const [peerSubmitting, setPeerSubmitting] = useState(false)
  const [kraReport, setKraReport] = useState<import('@/lib/branding-types').KraReport | null>(null)
  const [section, setSection] = useState<'self' | 'peer' | 'download'>('self')

  const colleagueOptions = useMemo(() =>
    users.filter(u => u.team === 'branding' && u.id !== profile?.id)
      .map(u => ({ id: u.id, label: u.full_name || u.email })),
    [users, profile])

  useEffect(() => {
    brandingApi.getKraParameters().then(r => setKraParams(r.parameters)).catch(() => {})
    brandingApi.getPeerMarkingEnabled().then(r => setPeerEnabled(r.enabled)).catch(() => {})
  }, [])

  useEffect(() => {
    if (section !== 'self') return
    setSelfLoading(true)
    brandingApi.getSelfAppraisal(appraisalMonth, appraisalYear)
      .then(r => {
        setSelfAppraisal(r.appraisal)
        if (r.appraisal) setSelfScores(r.appraisal.scores)
        else setSelfScores(Object.fromEntries(kraParams.map(p => [p.id, 5])))
      })
      .catch(() => toast.error('Failed to load appraisal'))
      .finally(() => setSelfLoading(false))
  }, [section, appraisalMonth, appraisalYear, kraParams])

  useEffect(() => {
    if (section !== 'peer') return
    brandingApi.getPeerMarkingCompleted(appraisalMonth, appraisalYear)
      .then(r => setCompletedPeers(r.completed))
      .catch(() => {})
  }, [section, appraisalMonth, appraisalYear])

  useEffect(() => {
    if (section !== 'download' || !profile) return
    brandingApi.getKraReport(profile.id, appraisalMonth, appraisalYear)
      .then(r => setKraReport(r.report))
      .catch(() => setKraReport(null))
  }, [section, appraisalMonth, appraisalYear, profile])

  async function submitSelfAppraisal() {
    setSelfLoading(true)
    try {
      const res = await brandingApi.submitSelfAppraisal(appraisalMonth, appraisalYear, selfScores)
      setSelfAppraisal(res.appraisal)
      setConfirmSubmit(false)
      toast.success('Self appraisal submitted successfully!')
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to submit') }
    finally { setSelfLoading(false) }
  }

  async function submitPeerMarking() {
    if (!peerColleague) { toast.error('Select a colleague first.'); return }
    setPeerSubmitting(true)
    try {
      await brandingApi.submitPeerMarking(peerColleague, appraisalMonth, appraisalYear, peerScores)
      setCompletedPeers(prev => [...prev, peerColleague])
      setPeerColleague('')
      setPeerScores(Object.fromEntries(kraParams.map(p => [p.id, 5])))
      toast.success('Peer marking submitted!')
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed') }
    finally { setPeerSubmitting(false) }
  }

  const peerColleagueOptions = useMemo(() =>
    colleagueOptions.filter(o => !completedPeers.includes(o.id)), [colleagueOptions, completedPeers])

  const now = new Date()

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-extrabold font-serif" style={{ color: '#1a472a' }}>Self Appraisal</h1>
        <p className="text-sm font-semibold mt-0.5" style={{ color: '#52b788' }}>Submit your monthly KRA self-evaluation. One submission per month.</p>
      </div>

      {/* Period selector */}
      <div className="bg-white rounded-2xl border border-gray-100 p-4 flex items-center gap-4 flex-wrap">
        <Calendar className="w-4 h-4 text-green-700 shrink-0" />
        <label className="text-sm font-bold font-serif" style={{ color: '#1a472a' }}>Period:</label>
        <select value={appraisalMonth} onChange={e => setAppraisalMonth(parseInt(e.target.value))}
          className="text-sm border border-gray-200 rounded-lg px-3 py-1.5 focus:outline-none">
          {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
        </select>
        <select value={appraisalYear} onChange={e => setAppraisalYear(parseInt(e.target.value))}
          className="text-sm border border-gray-200 rounded-lg px-3 py-1.5 focus:outline-none">
          {[2024, 2025, 2026, 2027].map(y => <option key={y} value={y}>{y}</option>)}
        </select>
        {selfAppraisal && (
          <span className="flex items-center gap-1.5 text-xs font-medium text-green-700 bg-green-50 px-3 py-1.5 rounded-full ml-auto">
            <Check className="w-3 h-3" /> Submitted for {MONTHS[appraisalMonth - 1]}
          </span>
        )}
      </div>

      {/* Section tabs */}
      <div className="grid grid-cols-3 gap-3">
        {[
          { key: 'self' as const, icon: Award, label: 'Self Appraisal', desc: 'Evaluate your own KRA performance' },
          { key: 'peer' as const, icon: Users, label: 'Staff KRA Marking', desc: 'Anonymously mark your colleagues' },
          { key: 'download' as const, icon: Download, label: 'KRA Report', desc: 'View & download your final KRA' },
        ].map(s => {
          const Icon = s.icon
          const active = section === s.key
          return (
            <button key={s.key} onClick={() => setSection(s.key)}
              className={`rounded-2xl p-4 text-left border transition-all hover:shadow-sm ${active ? 'border-green-700 bg-green-50' : 'bg-white border-gray-100'}`}>
              <div className="flex items-center gap-2 mb-1">
                <Icon className={`w-5 h-5 ${active ? 'text-green-800' : 'text-gray-400'}`} />
                <span className={`text-sm font-bold font-serif ${active ? '' : ''}`} style={{ color: active ? '#1a472a' : '#52b788' }}>{s.label}</span>
              </div>
              <p className="text-xs font-semibold" style={{ color: '#52b788' }}>{s.desc}</p>
            </button>
          )
        })}
      </div>

      {/* Self Appraisal */}
      {section === 'self' && (
        <div className="bg-white rounded-2xl border border-gray-100 p-6 space-y-5">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-extrabold font-serif" style={{ color: '#1a472a' }}>
              Self Appraisal — {MONTHS[appraisalMonth - 1]} {appraisalYear}
            </h2>
            {selfAppraisal && (
              <span className="flex items-center gap-1.5 text-xs font-medium text-green-700 bg-green-50 px-3 py-1 rounded-full">
                <Lock className="w-3 h-3" /> Submitted — locked
              </span>
            )}
          </div>

          {selfLoading
            ? <p className="text-sm text-gray-400 text-center py-10 animate-pulse">Loading…</p>
            : kraParams.length === 0
            ? <p className="text-sm text-gray-400 text-center py-10">KRA parameters not configured yet.</p>
            : (
              <>
                <div className="p-4 bg-amber-50 border border-amber-100 rounded-xl text-xs text-amber-700 flex items-start gap-2">
                  <Info className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>Self appraisal can only be submitted <strong>once per month</strong>. Once submitted, it cannot be edited.</span>
                </div>

                <KraForm params={kraParams} scores={selfScores} onChange={setSelfScores} readOnly={!!selfAppraisal} />

                {!selfAppraisal && !confirmSubmit && (
                  <button onClick={() => setConfirmSubmit(true)}
                    className="w-full py-2.5 rounded-xl text-sm font-semibold text-white transition-colors"
                    style={{ background: '#1a472a' }}>
                    Submit Self Appraisal
                  </button>
                )}

                {!selfAppraisal && confirmSubmit && (
                  <div className="p-4 bg-amber-50 border border-amber-200 rounded-xl space-y-3">
                    <p className="text-sm font-medium text-amber-800">
                      You are about to submit your Self Appraisal for {MONTHS[appraisalMonth - 1]} {appraisalYear}.
                      <strong className="block mt-1">This action cannot be undone. Are you sure?</strong>
                    </p>
                    <div className="flex gap-3">
                      <button onClick={() => void submitSelfAppraisal()} disabled={selfLoading}
                        className="flex-1 py-2 rounded-xl text-sm font-semibold text-white disabled:opacity-50"
                        style={{ background: '#1a472a' }}>
                        Yes, submit now
                      </button>
                      <button onClick={() => setConfirmSubmit(false)}
                        className="px-5 py-2 rounded-xl border border-gray-200 text-sm text-gray-600 hover:bg-gray-50">
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </>
            )
          }
        </div>
      )}

      {/* Peer KRA Marking */}
      {section === 'peer' && (
        <div className="bg-white rounded-2xl border border-gray-100 p-6 space-y-5">
          <h2 className="text-base font-extrabold font-serif" style={{ color: '#1a472a' }}>
            Staff KRA Marking — {MONTHS[appraisalMonth - 1]} {appraisalYear}
          </h2>
          {!peerEnabled
            ? <div className="flex items-start gap-3 p-4 bg-gray-50 rounded-xl">
                <AlertCircle className="w-5 h-5 text-gray-400 shrink-0 mt-0.5" />
                <p className="text-sm text-gray-500">This feature is currently disabled. Contact your Admin.</p>
              </div>
            : (
              <>
                <div>
                  <label className="text-sm font-bold font-serif block mb-2" style={{ color: '#1a472a' }}>Select Colleague</label>
                  <select value={peerColleague}
                    onChange={e => { setPeerColleague(e.target.value); setPeerScores(Object.fromEntries(kraParams.map(p => [p.id, 5]))) }}
                    className="text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none max-w-xs w-full">
                    <option value="">Select a colleague…</option>
                    {peerColleagueOptions.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
                  </select>
                  {completedPeers.length > 0 && (
                    <p className="text-xs text-gray-400 mt-1">
                      Already marked: {completedPeers.map(id => colleagueOptions.find(o => o.id === id)?.label || id).join(', ')}
                    </p>
                  )}
                </div>
                {peerColleague && kraParams.length > 0 && (
                  <>
                    <div className="p-3 bg-blue-50 border border-blue-100 rounded-xl text-xs text-blue-700">
                      Your identity will remain anonymous. Once submitted, this marking is locked.
                    </div>
                    <KraForm params={kraParams} scores={peerScores} onChange={setPeerScores} />
                    <button onClick={() => void submitPeerMarking()} disabled={peerSubmitting}
                      className="w-full py-2.5 rounded-xl text-sm font-semibold text-white disabled:opacity-50"
                      style={{ background: '#1a472a' }}>
                      {peerSubmitting ? 'Submitting…' : 'Submit Peer Marking'}
                    </button>
                  </>
                )}
                {peerColleagueOptions.length === 0 && (
                  <div className="flex items-center gap-2 p-3 bg-green-50 border border-green-100 rounded-xl">
                    <Check className="w-4 h-4 text-green-700" />
                    <p className="text-sm text-green-800">You have marked all your colleagues for this period.</p>
                  </div>
                )}
              </>
            )
          }
        </div>
      )}

      {/* Download KRA Report */}
      {section === 'download' && (
        <div className="bg-white rounded-2xl border border-gray-100 p-6 space-y-5">
          <h2 className="text-base font-extrabold font-serif" style={{ color: '#1a472a' }}>
            KRA Report — {MONTHS[appraisalMonth - 1]} {appraisalYear}
          </h2>
          {!kraReport?.is_final_pushed
            ? <div className="flex items-start gap-3 p-4 bg-gray-50 rounded-xl">
                <Lock className="w-5 h-5 text-gray-400 shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-bold font-serif" style={{ color: '#1a472a' }}>Report not available yet</p>
                  <p className="text-sm font-semibold" style={{ color: '#52b788' }}>Your KRA is pending Admin review and approval.</p>
                </div>
              </div>
            : kraReport && kraParams.length > 0
            ? (
              <div className="space-y-5">
                <div className="grid grid-cols-3 gap-3">
                  {[
                    { label: 'Self Score', value: kraReport.self_appraisal ? (Object.values(kraReport.self_appraisal.scores).reduce((a, b) => a + b, 0) / kraParams.length).toFixed(1) : '—', bg: 'bg-green-50 text-green-800' },
                    { label: 'Peer Avg', value: Object.keys(kraReport.peer_average).length ? (Object.values(kraReport.peer_average).reduce((a, b) => a + b, 0) / kraParams.length).toFixed(1) : '—', bg: 'bg-blue-50 text-blue-800' },
                    { label: 'Final Score', value: kraReport.composite_score?.toFixed(1) ?? '—', bg: 'bg-amber-50 text-amber-800' },
                  ].map(s => (
                    <div key={s.label} className={`p-4 rounded-2xl ${s.bg}`}>
                      <p className="text-xs font-medium uppercase tracking-wider opacity-60">{s.label}</p>
                      <p className="text-3xl font-bold mt-1">{s.value}<span className="text-sm font-normal opacity-50">/10</span></p>
                    </div>
                  ))}
                </div>
                <h3 className="text-sm font-extrabold font-serif" style={{ color: '#1a472a' }}>Parameter Breakdown</h3>
                <KraForm params={kraParams} scores={kraReport.self_appraisal?.scores || {}} readOnly />
                <button onClick={() => window.print()}
                  className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold text-white"
                  style={{ background: '#1a472a' }}>
                  <Download className="w-4 h-4" /> Download / Print PDF
                </button>
              </div>
            )
            : <p className="text-sm text-gray-400 text-center py-6">No KRA data found for this period.</p>
          }
        </div>
      )}
    </div>
  )
}

// ── Main Component ─────────────────────────────────────────────────────────

export default function BrandingUserDashboard() {
  const { profile, signOut, role } = useAuth()
  const { users } = useAppData()
  const [activePage, setActivePage] = useState<NavPage>('dashboard')

  // ── Search state ─────────────────────────────────────────────────────────
  const [searchOpen, setSearchOpen]   = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchReports, setSearchReports] = useState<import('@/lib/branding-types').DailyReport[]>([])
  const [searchProjects, setSearchProjects] = useState<BrandingProject[]>([])
  const [searchLoading, setSearchLoading] = useState(false)

  useEffect(() => {
    if (!searchOpen) return
    setSearchLoading(true)
    const now = new Date()
    const dateFrom = fmtDate(new Date(now.getFullYear(), now.getMonth() - 1, 1))
    Promise.all([
      brandingApi.getAllReports({ dateFrom, dateTo: fmtDate(now) }),
      brandingApi.getProjects(),
    ]).then(([reps, projs]) => {
      setSearchReports(reps.reports)
      setSearchProjects(projs.projects)
    }).catch(() => {}).finally(() => setSearchLoading(false))
  }, [searchOpen])

  const searchResults = useMemo(() => {
    const q = searchQuery.toLowerCase().trim()
    if (!q) return { reports: searchReports.slice(0, 5), projects: searchProjects.slice(0, 4) }
    return {
      reports: searchReports.filter(r =>
        r.report_date.includes(q) ||
        r.rows?.some(row => row.type_of_work.toLowerCase().includes(q) || row.specific_work.toLowerCase().includes(q))
      ).slice(0, 6),
      projects: searchProjects.filter(p =>
        p.name.toLowerCase().includes(q) || p.description?.toLowerCase().includes(q)
      ).slice(0, 4),
    }
  }, [searchQuery, searchReports, searchProjects])

  // Keyboard shortcut ⌘F / Ctrl+F → open search
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault()
        setSearchOpen(true)
      }
      if (e.key === 'Escape') {
        setSearchOpen(false)
        setNotifOpen(false)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  // ── Notification state ────────────────────────────────────────────────────
  const [notifOpen, setNotifOpen] = useState(false)

  const notifications = useMemo(() => {
    const now = new Date()
    const items: { id: string; title: string; body: string; type: 'warning' | 'info' | 'success' }[] = []
    items.push({
      id: 'report',
      title: "Today's Report",
      body: `Submit your daily report for ${now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' })}`,
      type: 'warning',
    })
    if (now.getDate() >= 20) {
      items.push({ id: 'appraisal', title: 'Self Appraisal Window Open', body: `Submit your KRA appraisal for ${MONTHS[now.getMonth()]}`, type: 'info' })
    }
    items.push({ id: 'collab', title: 'Log Collaboration', body: 'Tag team members you worked with today', type: 'info' })
    return items
  }, [])

  const navItems: { key: NavPage; icon: React.ElementType; label: string }[] = [
    { key: 'dashboard', icon: LayoutDashboard, label: 'Dashboard' },
    { key: 'daily-reports', icon: ClipboardList, label: 'Daily Reports' },
    { key: 'analytics', icon: BarChart2, label: 'Analytics' },
    { key: 'self-appraisal', icon: Award, label: 'Self Appraisal' },
    { key: 'gallery', icon: LayoutGrid, label: 'Design Gallery' },
    ...(role === 'sub_admin' ? [{ key: 'team' as NavPage, icon: Users, label: 'My Team' }] : []),
  ]

  return (
    <div className="-mx-6 -mt-8 -mb-8 flex bg-[#f4f7f4] h-screen overflow-hidden">
      {/* ── Left Sidebar ──────────────────────────────────────────────────── */}
      <aside className="w-52 bg-white border-r border-gray-100 flex flex-col shrink-0 h-full overflow-y-auto">
        {/* Logo */}
        <div className="px-5 pt-6 pb-4 border-b border-gray-50">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl flex items-center justify-center" style={{ background: '#1a472a' }}>
              <Palette className="w-4 h-4 text-white" />
            </div>
            <span className="font-bold text-[16px] text-gray-800 tracking-tight">Nerve</span>
          </div>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-3 py-4 space-y-0.5">
          <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest px-3 mb-2">Menu</p>
          {navItems.map(item => {
            const Icon = item.icon
            const active = activePage === item.key
            return (
              <button key={item.key} onClick={() => setActivePage(item.key)}
                className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-[13px] font-semibold transition-all text-left relative ${
                  active ? 'text-[#1a472a]' : 'text-gray-500 hover:bg-gray-50 hover:text-gray-700'
                }`}
                style={active ? {
                  border: '1.5px solid #1a472a',
                  background: 'linear-gradient(135deg, rgba(255,255,255,0.72) 0%, rgba(210,240,220,0.55) 100%)',
                  backdropFilter: 'blur(10px)',
                  WebkitBackdropFilter: 'blur(10px)',
                  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.9), 0 2px 8px rgba(26,71,42,0.10)',
                } : {}}>
                <Icon className="w-4 h-4 shrink-0" />
                {item.label}
              </button>
            )
          })}

          <div className="pt-4">
            <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest px-3 mb-2">General</p>
            {(['settings', 'help'] as const).map((key) => {
              const active = activePage === key
              const Icon = key === 'settings' ? Settings : HelpCircle
              const label = key === 'settings' ? 'Settings' : 'Help'
              return (
                <button key={key}
                  onClick={() => setActivePage(key)}
                  className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-[13px] font-semibold transition-all text-left mb-0.5 ${
                    active ? 'text-[#1a472a]' : 'text-gray-500 hover:bg-gray-50 hover:text-gray-700'
                  }`}
                  style={active ? {
                    border: '1.5px solid #1a472a',
                    background: 'linear-gradient(135deg, rgba(255,255,255,0.72) 0%, rgba(210,240,220,0.55) 100%)',
                    backdropFilter: 'blur(10px)',
                    WebkitBackdropFilter: 'blur(10px)',
                    boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.9), 0 2px 8px rgba(26,71,42,0.10)',
                  } : {}}>
                  <Icon className="w-4 h-4 shrink-0" />{label}
                </button>
              )
            })}
            <button
              onClick={() => { void signOut?.() }}
              className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-[13px] font-medium text-gray-500 hover:bg-red-50 hover:text-red-600 text-left transition-colors">
              <LogOut className="w-4 h-4 shrink-0" /> Logout
            </button>
          </div>
        </nav>

        {/* Bottom promo card */}
        <div className="mx-3 mb-4 p-4 rounded-2xl text-white" style={{ background: 'linear-gradient(135deg, #1a472a 0%, #2d6a4f 100%)' }}>
          <p className="text-[12px] font-bold leading-tight">Branding Portal</p>
          <p className="text-[11px] opacity-70 mt-1 leading-snug">Log your work daily and track your growth.</p>
        </div>
      </aside>

      {/* ── Main Area ─────────────────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col min-w-0 h-full overflow-hidden">
        {/* Top Header */}
        <header className="bg-white border-b border-gray-100 px-6 py-3.5 flex items-center gap-4 sticky top-0 z-20 shrink-0">
          {/* Search trigger */}
          <button
            onClick={() => setSearchOpen(true)}
            className="flex-1 max-w-xs flex items-center gap-2 bg-gray-50 border border-gray-100 rounded-xl px-3 py-2 text-sm text-gray-400 hover:border-green-300 transition-colors text-left"
          >
            <Search className="w-3.5 h-3.5 shrink-0" />
            <span>Search reports, projects…</span>
            <span className="ml-auto text-[10px] text-gray-300 bg-white border border-gray-100 rounded px-1 py-0.5">⌘F</span>
          </button>

          <div className="ml-auto flex items-center gap-3">
            {/* Notification bell */}
            <div className="relative">
              <button
                onClick={() => setNotifOpen(o => !o)}
                className="w-9 h-9 rounded-full bg-gray-50 border border-gray-100 flex items-center justify-center text-gray-400 hover:bg-gray-100 transition-colors relative"
              >
                <Bell className="w-4 h-4" />
                <span className="absolute -top-0.5 -right-0.5 w-4 h-4 rounded-full text-[9px] font-bold text-white flex items-center justify-center" style={{ background: '#1a472a' }}>
                  {notifications.length}
                </span>
              </button>

              {/* Notification panel */}
              {notifOpen && (
                <div className="absolute right-0 top-11 w-80 bg-white rounded-2xl shadow-xl border border-gray-100 z-50 overflow-hidden">
                  <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
                    <p className="text-sm font-semibold text-gray-800">Notifications</p>
                    <button onClick={() => setNotifOpen(false)} className="text-gray-400 hover:text-gray-600"><X className="w-3.5 h-3.5" /></button>
                  </div>
                  <div className="divide-y divide-gray-50 max-h-72 overflow-y-auto">
                    {notifications.map(n => (
                      <div key={n.id} className="flex items-start gap-3 px-4 py-3 hover:bg-gray-50 transition-colors">
                        <div className={`w-2 h-2 rounded-full mt-1.5 shrink-0 ${n.type === 'warning' ? 'bg-amber-400' : n.type === 'success' ? 'bg-green-500' : 'bg-blue-400'}`} />
                        <div>
                          <p className="text-sm font-medium text-gray-800">{n.title}</p>
                          <p className="text-xs text-gray-400 mt-0.5">{n.body}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="px-4 py-2.5 border-t border-gray-100">
                    <button
                      onClick={() => { setNotifOpen(false); setActivePage('daily-reports') }}
                      className="w-full py-2 rounded-xl text-xs font-semibold text-white"
                      style={{ background: '#1a472a' }}
                    >
                      Submit Today's Report
                    </button>
                  </div>
                </div>
              )}
            </div>

            <button
              onClick={() => setActivePage('settings')}
              className="flex items-center gap-2.5 hover:opacity-80 transition-opacity"
            >
              {profile?.avatar_url ? (
                <img
                  src={profile.avatar_url}
                  alt={profile.full_name || 'avatar'}
                  className="w-9 h-9 rounded-full object-cover shrink-0 ring-2 ring-green-100"
                />
              ) : (
                <div className="w-9 h-9 rounded-full bg-green-100 flex items-center justify-center text-green-800 text-sm font-bold uppercase shrink-0">
                  {profile?.full_name?.charAt(0) || profile?.email?.charAt(0) || 'U'}
                </div>
              )}
              <div className="hidden sm:block text-left">
                <p className="text-[13px] font-semibold text-gray-800 leading-tight">{profile?.full_name || 'User'}</p>
                <p className="text-[11px] text-gray-400 leading-tight">{profile?.email}</p>
              </div>
            </button>
          </div>
        </header>

        {/* Scrollable page content */}
        <main className="flex-1 overflow-y-auto p-6">
          {activePage === 'dashboard' && (
            <DashboardPage profile={profile} users={users} onNavigate={setActivePage} />
          )}
          {activePage === 'daily-reports' && (
            <DailyReportsPage profile={profile} users={users} />
          )}
          {activePage === 'analytics' && (
            <AnalyticsPage userId={profile?.id || ''} users={users} />
          )}
          {activePage === 'self-appraisal' && (
            <SelfAppraisalPage profile={profile} users={users} />
          )}
          {activePage === 'gallery' && <BrandingBrowse />}
          {activePage === 'team' && <BrandingTeamPanel />}
          {activePage === 'settings' && <SettingsPage profile={profile} />}
          {activePage === 'help' && <HelpPage onNavigate={setActivePage} />}
        </main>
      </div>

      {/* ── Search Modal ──────────────────────────────────────────────────── */}
      {searchOpen && (
        <div
          className="fixed inset-0 bg-black/30 z-50 flex items-start justify-center pt-20 px-4"
          onClick={() => { setSearchOpen(false); setSearchQuery('') }}
        >
          <div
            className="bg-white rounded-2xl shadow-2xl w-full max-w-xl overflow-hidden"
            onClick={e => e.stopPropagation()}
          >
            {/* Search input */}
            <div className="flex items-center gap-3 px-4 py-3.5 border-b border-gray-100">
              <Search className="w-4 h-4 text-gray-400 shrink-0" />
              <input
                autoFocus
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder="Search reports, projects, work types…"
                className="flex-1 text-sm bg-transparent outline-none text-gray-800 placeholder:text-gray-400"
              />
              {searchQuery && (
                <button onClick={() => setSearchQuery('')} className="text-gray-400 hover:text-gray-600">
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
              <kbd className="text-[10px] text-gray-300 border border-gray-100 rounded px-1.5 py-0.5">ESC</kbd>
            </div>

            {/* Results */}
            <div className="max-h-96 overflow-y-auto">
              {searchLoading ? (
                <p className="text-sm text-gray-400 text-center py-8 animate-pulse">Loading…</p>
              ) : (
                <>
                  {/* Reports */}
                  {searchResults.reports.length > 0 && (
                    <div>
                      <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 px-4 pt-3 pb-1">Reports</p>
                      {searchResults.reports.map(r => (
                        <button
                          key={r.id}
                          onClick={() => { setSearchOpen(false); setSearchQuery(''); setActivePage('daily-reports') }}
                          className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-gray-50 text-left transition-colors"
                        >
                          <div className="w-7 h-7 rounded-lg bg-green-100 flex items-center justify-center shrink-0">
                            <ClipboardList className="w-3.5 h-3.5 text-green-700" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-gray-800">{new Date(r.report_date).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}</p>
                            <p className="text-xs text-gray-400 truncate">
                              {r.rows?.slice(0, 2).map(row => row.type_of_work).filter(Boolean).join(' · ') || 'No entries'}
                            </p>
                          </div>
                          <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full shrink-0 ${r.is_locked ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700'}`}>
                            {r.is_locked ? 'Submitted' : 'Draft'}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}

                  {/* Projects */}
                  {searchResults.projects.length > 0 && (
                    <div>
                      <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 px-4 pt-3 pb-1">Projects</p>
                      {searchResults.projects.map(p => (
                        <button
                          key={p.id}
                          onClick={() => { setSearchOpen(false); setSearchQuery(''); setActivePage('daily-reports') }}
                          className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-gray-50 text-left transition-colors"
                        >
                          <div className="w-7 h-7 rounded-lg bg-blue-50 flex items-center justify-center shrink-0">
                            <LayoutGrid className="w-3.5 h-3.5 text-blue-500" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-gray-800 truncate">{p.name}</p>
                            <p className="text-xs text-gray-400 truncate">{p.description || 'No description'}</p>
                          </div>
                          <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full shrink-0 ${
                            p.status === 'active' ? 'bg-green-100 text-green-700' :
                            p.status === 'completed' ? 'bg-blue-100 text-blue-700' : 'bg-amber-100 text-amber-700'
                          }`}>{p.status === 'active' ? 'Running' : p.status === 'completed' ? 'Done' : 'On Hold'}</span>
                        </button>
                      ))}
                    </div>
                  )}

                  {!searchLoading && searchResults.reports.length === 0 && searchResults.projects.length === 0 && (
                    <div className="text-center py-10">
                      <Search className="w-8 h-8 text-gray-200 mx-auto mb-2" />
                      <p className="text-sm text-gray-400">{searchQuery ? `No results for "${searchQuery}"` : 'Start typing to search'}</p>
                    </div>
                  )}
                </>
              )}
            </div>

            <div className="px-4 py-2.5 border-t border-gray-100 flex items-center gap-4 text-[10px] text-gray-300">
              <span><kbd className="border border-gray-100 rounded px-1">↑↓</kbd> navigate</span>
              <span><kbd className="border border-gray-100 rounded px-1">↵</kbd> open</span>
              <span><kbd className="border border-gray-100 rounded px-1">ESC</kbd> close</span>
            </div>
          </div>
        </div>
      )}

      {/* Click-away for notification panel */}
      {notifOpen && (
        <div className="fixed inset-0 z-40" onClick={() => setNotifOpen(false)} />
      )}
    </div>
  )
}
