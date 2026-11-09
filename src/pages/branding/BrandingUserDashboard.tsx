import { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef, Fragment } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '@/hooks/useAuth'
import { CAPABILITY_META, type CapabilityKey } from '@/lib/capabilities'
import { useAppData } from '@/hooks/useAppData'
import { brandingApi } from '@/lib/branding-api'
import { api } from '@/lib/api'
import { TIME_OPTIONS, timeToHours, MONTHS, formatElapsed, elapsedToTimeTaken } from '@/lib/branding-types'
import type {
  WorkCategory, DailyReport, DraftRow, KraParameter, SelfAppraisal, BrandingProject, BrandingLeave,
  ReportRowComment, BrandingTodo, StopwatchStatus,
} from '@/lib/branding-types'
import {
  LayoutDashboard, ClipboardList, BarChart2, Award, Settings, HelpCircle, ArrowRight,
  LogOut, Plus, Trash2, Send, Lock, ChevronDown, Check, Info, Download,
  Users, TrendingUp, AlertCircle, Bell, Search, ArrowUpRight, Palette, Paintbrush,
  Calendar, Timer, LayoutGrid, X, Menu, FolderPlus,
  BookOpen, Keyboard, MessageCircle, Phone,
  Play, Pause, Square, Repeat, Rocket, User, Layers,
  CheckCircle2, Clock, SlidersHorizontal, History, CheckCheck,
  ListTodo, CheckSquare, Eye, UserCheck, Loader2,
  ChevronsUpDown, CalendarDays, Newspaper, FileText, PanelLeftClose,
} from 'lucide-react'
import {
  L, CHART2, cx, hueForStatus, type Hue,
  Card, StatCard, Segmented, SearchField, Kebab, IconTile, Badge, StatusText,
  ActivityItem, Avatar, Th, Modal, EmptyState, Spinner, ChartTip,
  evenTicks } from './ds2'
import ThemeModal, { ModeToggle } from './ThemeModal'
import BrandLogo from '@/components/BrandLogo'
import { applySavedPrimary } from './theme'
import BrandingBrowse from './BrandingBrowse'
import BrandingKanban from './BrandingKanban'
import BrandingTeamPanel from './BrandingTeamPanel'
import SettingsPage from './BrandingAccountPage'
import {
  BarChart, Bar, XAxis, YAxis, ResponsiveContainer, CartesianGrid,
  Cell, ReferenceLine, LabelList,
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

// Dynamic range for stat cards: e.g. "From Sep 01, 2026 - Sep 30, 2026"
const currentMonthRange = () => {
  const now = new Date()
  const year = now.getFullYear()
  const monthName = now.toLocaleString('en-US', { month: 'short' })
  const lastDay = new Date(year, now.getMonth() + 1, 0).getDate()
  // "Sep 1 – 30, 2026". The old form repeated the month and the year and led
  // with "From", and at the size these cards are now set it ran off the end of
  // every one of them.
  return `${monthName} 1 – ${lastDay}, ${year}`
}

// Helper to resolve user position/designation (e.g. Graphic Design Intern for Priyanshu Anand)
const getUserPosition = (prof?: { full_name?: string; department?: string; email?: string } | null) => {
  if (!prof) return 'Graphic Designer'
  const name = (prof.full_name || '').toLowerCase()
  const email = (prof.email || '').toLowerCase()
  if (name.includes('priyanshu') || email.includes('priyanshu')) {
    return 'Graphic Design Intern'
  }
  const dept = (prof.department || '').trim()
  if (dept && !['branding', 'university-wide', 'team'].includes(dept.toLowerCase())) {
    return dept
  }
  return 'Graphic Designer'
}

// Parse a YYYY-MM-DD string as LOCAL midnight (not UTC midnight)
// new Date("2025-04-06") is UTC midnight which shifts the date in non-UTC timezones
const parseDateLocal = (s: string) => {
  const [y, mo, d] = s.split('-').map(Number)
  return new Date(y, mo - 1, d)
}

// Hours -> readable duration. Rounding to one decimal everywhere turned any
// stopwatch under 6 minutes into "0h", so a freshly logged 9s task looked
// like the chart had not updated. Sub-hour work keeps its own unit.
// A no-break space between the figure and its unit: they are one value, so
// they must never be split across a line, and "3.3h" set solid reads as a
// single word rather than a measurement. The unit is "hr", not "h",
// everywhere it appears.
const fmtHours = (h: number): string => {
  if (!isFinite(h) || h <= 0) return '0\u00A0hr'
  if (h >= 1) return `${Math.round(h * 10) / 10}\u00A0hr`
  const mins = h * 60
  if (mins >= 1) return `${Math.round(mins)}\u00A0m`
  return `${Math.max(1, Math.round(h * 3600))}\u00A0s`
}

/** Hours on a row *right now*.
 *
 *  A finished row carries its hours in `time_taken`; a running or paused one
 *  carries them only on its stopwatch, and `time_taken` stays empty until
 *  Finish is pressed. Summing `time_taken` alone therefore reported 0 hr for
 *  a day whose timers were still going — which is exactly what "Today's
 *  Hours" showed while work was being tracked. */
const rowHoursNow = (row: {
  time_taken: string
  stopwatch_status: StopwatchStatus
  elapsed_seconds: number
  stopwatch_started_at: string | null
}): number => {
  const logged = timeToHours(row.time_taken)
  if (logged > 0) return logged
  const since = row.stopwatch_status === 'running' && row.stopwatch_started_at
    ? Math.max(0, (Date.now() - new Date(row.stopwatch_started_at).getTime()) / 1000)
    : 0
  return (row.elapsed_seconds + since) / 3600
}

// A standard 9-to-5 day. The 5 PM auto-pause already treats this as the end
// of the working day, so the day bar measures against the same figure.
const DAILY_TARGET_HOURS = 8

/** "1h 5m 0s" as the reader should see it: "1hr 5m 0s".
 *
 *  Only for display. The same string is what `time_taken` stores and what
 *  timeToHours parses back (its regex expects `\d+h`), and rows already in
 *  the database are written that way — so the stored form keeps its "h". */
const labelElapsed = (seconds: number) => formatElapsed(seconds).replace(/(\d+)h\b/, '$1hr')

// ── Nerve Light helpers ────────────────────────────────────────────────────

/** Text link in the ds2 idiom ("View analytics", "All reports"). */
const TEXT_LINK = 'text-[13px] font-medium text-[#111827] hover:underline underline-offset-4 cursor-pointer'

/** Card title with a one-line subtitle under it ("Projects in motion" /
 *  "0 running · 0 completed"). Slots into ds2's `Card` title. */
function CardTitle({ title, sub }: { title: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <span className="flex flex-col gap-0.5 min-w-0">
      <span>{title}</span>
      {sub && <span className="text-[12px] font-normal text-[#6B7280] tracking-normal">{sub}</span>}
    </span>
  )
}

const SEL = L.select
const INP = L.input

// Grid-cell variants of the two above, for the daily-report table only.
// A bordered box in every cell turned the table into a wall of form controls;
// these stay flat until you hover or focus them, so the table reads as content
// and the editing affordance appears where the pointer is. Modals keep SEL/INP.
const SEL_CELL = 'w-full h-8 bg-white text-[13px] px-2 pr-7 rounded-[6px] border border-[#C5CAD1] appearance-none select-chevron text-[#111827] hover:border-[#9CA3AF] focus:border-[#9CA3AF] focus:outline-none focus:ring-2 focus:ring-[#111827]/5 transition-colors cursor-pointer truncate'
const INP_CELL = 'w-full h-8 bg-white text-[13px] px-2 rounded-[6px] border border-[#C5CAD1] text-[#111827] hover:border-[#9CA3AF] focus:border-[#9CA3AF] focus:outline-none focus:ring-2 focus:ring-[#111827]/5 transition-colors placeholder:text-[#9CA3AF]'

// One palette for every work-type chart — the category table and the
// Analytics waffle must colour the same category identically. A ramp of the
// Nerve Light ink, darkest first: every list that uses it is ranked
// largest-first, so the ramp doubles as a reading order.
const WORK_TYPE_BAR_COLORS = [...CHART2.ramp]

// Where blocks of colour touch, shade is not enough. In the waffle the squares
// of one category sit directly against the next, so these are hues, ordered so
// that the categories that meet each other are the furthest apart.
//
// Rank order is the same in the waffle and in Category Breakdown (both sorted
// by hours, largest first), so a category keeps its colour across the page.
const CATEGORY_COLORS = [...CHART2.series, '#64748B', '#DC2626']

/** Whether THIS user is finished with a project, by their own assignment and
 *  not the project's status. Marking a project complete only flips the
 *  project itself once every assignee has done so, so the two answer different
 *  questions — and a card that reports the project status cannot show the
 *  reader their own progress. Falls back to the project when the reader has no
 *  assignment on it. */
function myProjectStatus(p: BrandingProject, userId?: string): 'completed' | 'pending' {
  const mine = p.assignments.find(a => a.user_id === userId)
  if (mine) return mine.status === 'completed' ? 'completed' : 'pending'
  return p.status === 'completed' ? 'completed' : 'pending'
}

type NavPage = 'dashboard' | 'daily-reports' | 'analytics' | 'self-appraisal' | 'gallery' | 'team' | 'members' | 'settings' | 'help' | 'notifications'

function blankRow(sr: number): DraftRow {
  return {
    _key: `${Date.now()}-${sr}`, sr_no: sr,
    type_of_work: '', sub_category: '', specific_work: '', time_taken: '',
    collaborative_colleagues: [],
    stopwatch_status: 'idle', elapsed_seconds: 0,
    stopwatch_started_at: null, carried_over_from_row_id: null,
    last_paused_at: null, project_id: null,
  }
}

// Hard ceiling on a single uninterrupted "since" snapshot. Mirrors the
// server-side MAX_STOPWATCH_SINCE_SECONDS in branding-db.ts. A timer left
// running unattended would otherwise accrue raw wall-clock time and inflate
// elapsed_seconds. 9h is the upper bound of a plausible working session.
const MAX_STOPWATCH_SINCE_SECONDS = 9 * 3600

// Per-day elapsed for a row whose work may span multiple days via carry-over.
// `elapsed_seconds` is cumulative across the chain; this returns just what was
// tracked on the day of `row`. If we can't locate the prior-day source row in
// the loaded reports, we conservatively fall back to the cumulative value.
function perDayElapsedSeconds(
  row: { elapsed_seconds: number; carried_over_from_row_id: string | null },
  allReports: { rows?: { id: string; elapsed_seconds: number }[] }[],
): number {
  if (!row.carried_over_from_row_id) return row.elapsed_seconds
  for (const rep of allReports) {
    const src = rep.rows?.find(r => r.id === row.carried_over_from_row_id)
    if (src) return Math.max(0, row.elapsed_seconds - src.elapsed_seconds)
  }
  return row.elapsed_seconds
}

function StatusBadge({ status, lastPausedAt }: { status: 'idle' | 'running' | 'paused' | 'finished'; lastPausedAt: string | null }) {
  const cfg = {
    idle:     { label: 'Not started', hue: 'grey' as Hue },
    running:  { label: 'Running',     hue: 'amber' as Hue },
    paused:   { label: 'Paused',      hue: 'blue' as Hue },
    finished: { label: 'Finished',    hue: 'green' as Hue },
  }[status]
  return (
    <div className="inline-flex flex-col items-start">
      <Badge hue={cfg.hue}>{cfg.label}</Badge>
      {lastPausedAt && (status === 'paused' || status === 'finished') && (
        <span className="text-[11px] text-[#6B7280] mt-0.5">
          at {new Date(lastPausedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true })}
        </span>
      )}
    </div>
  )
}

// ── Stopwatch cell ─────────────────────────────────────────────────────────
//   idle → Start → running → Pause → paused → Continue → running … → Finish → finished
// While running we tick locally every second; the source of truth for time is
// `elapsed_seconds + (now − stopwatch_started_at)`. Each transition is persisted
// via onAction so teammates polling can see live status.
function StopwatchCell({
  row,
  disabled,
  canStart,
  onAction,
}: {
  row: DraftRow
  disabled?: boolean
  canStart: boolean
  onAction: (patch: Partial<DraftRow>) => void | Promise<void>
}) {
  const [, forceTick] = useState(0)

  useEffect(() => {
    if (row.stopwatch_status !== 'running') return
    const id = setInterval(() => forceTick(t => t + 1), 1000)
    return () => clearInterval(id)
  }, [row.stopwatch_status])

  const liveSeconds = (() => {
    if (row.stopwatch_status === 'running' && row.stopwatch_started_at) {
      const since = Math.max(0, Math.floor((Date.now() - new Date(row.stopwatch_started_at).getTime()) / 1000))
      return row.elapsed_seconds + since
    }
    return row.elapsed_seconds
  })()

  if (disabled) {
    return <span className="text-[13px] text-[#111827] tabular-nums">{row.time_taken ? row.time_taken.replace(/(\d+)h\b/, '$1hr') : labelElapsed(liveSeconds)}</span>
  }

  const isCarried = !!row.carried_over_from_row_id
  const start  = () => void onAction({ stopwatch_status: 'running', stopwatch_started_at: new Date().toISOString(), last_paused_at: null })
  const pause  = () => void onAction({ stopwatch_status: 'paused', elapsed_seconds: liveSeconds, stopwatch_started_at: null, last_paused_at: new Date().toISOString() })
  const cont   = () => void onAction({ stopwatch_status: 'running', stopwatch_started_at: new Date().toISOString(), last_paused_at: null })
  const finish = () => void onAction({
    stopwatch_status: 'finished',
    elapsed_seconds: liveSeconds,
    stopwatch_started_at: null,
    last_paused_at: new Date().toISOString(),
    time_taken: liveSeconds > 0 ? elapsedToTimeTaken(liveSeconds) : '0m',
  })

  // One button size and one shape for every state: the ds2 small button,
  // secondary for everything but the primary action of the moment.
  const btn = cx(L.btn, L.btnSm, 'gap-1')
  const ghost = L.btnSecondary
  const running = row.stopwatch_status === 'running'
  const done = row.stopwatch_status === 'finished'

  return (
    <div className="flex items-center gap-1.5">
      <span
        // font-mono is deliberate and load-bearing: a running clock in a
        // proportional face shuffles sideways on every tick. This is the
        // only place in the portal in another typeface, and it is here so
        // the seconds stay in one column.
        className={cx(
          'inline-flex items-center h-8 px-2 rounded-[6px] text-[12px] font-mono tabular-nums border shrink-0',
          running ? 'bg-[var(--nerve-primary-soft)] text-[var(--nerve-primary-text)] border-[var(--nerve-primary-soft-border)]'
            : done ? 'bg-[#F9FAFB] text-[#6B7280] border-[#C5CAD1]'
            : 'bg-white text-[#374151] border-[#C5CAD1]',
        )}
        title={isCarried ? 'Carried over from a previous day' : undefined}
      >
        {/* A quiet pulsing dot carries "this is live" instead of a loud colour. */}
        {running && <span className="w-1.5 h-1.5 rounded-full bg-[var(--nerve-primary)] mr-1.5 animate-pulse shrink-0" />}
        {labelElapsed(liveSeconds)}
        {isCarried && <Repeat className="inline-block w-3 h-3 ml-1 opacity-60" />}
      </span>

      {row.stopwatch_status === 'idle' && (
        <button
          type="button"
          onClick={start}
          disabled={!canStart}
          title={canStart ? 'Start tracking' : 'Fill in type, sub-category and description first'}
          className={cx(btn, canStart ? L.btnPrimary : 'bg-[#F3F4F6] text-[#9CA3AF] cursor-not-allowed')}
        >
          <Play className="w-3 h-3" /> Start
        </button>
      )}
      {running && (
        <button type="button" onClick={pause} title="Pause tracking" className={cx(btn, ghost)}>
          <Pause className="w-3 h-3" /> Pause
        </button>
      )}
      {row.stopwatch_status === 'paused' && (
        <>
          <button type="button" onClick={cont} title="Resume tracking"
            className={cx(btn, L.btnPrimary)}>
            <Play className="w-3 h-3" /> Resume
          </button>
          {/* Finish is destructive-ish (it locks the duration in), so it stays
              secondary rather than shouting in red next to the primary. */}
          <button type="button" onClick={finish} title="Finish and lock this duration"
            className={cx(btn, ghost)}>
            <Square className="w-3 h-3" /> Finish
          </button>
        </>
      )}
      {done && (
        <Badge hue="green" className="!h-8"><Check className="w-3 h-3" /> Done</Badge>
      )}
    </div>
  )
}

function workingDaysSoFar(): number {
  const now = new Date()
  let count = 0
  for (let d = 1; d <= now.getDate(); d++) {
    // Sunday (0) is the only off-day. Saturday counts.
    const day = new Date(now.getFullYear(), now.getMonth(), d).getDay()
    if (day !== 0) count++
  }
  return count
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
  const [dropStyle, setDropStyle] = useState<React.CSSProperties>({})
  const btnRef = useRef<HTMLButtonElement>(null)

  const toggle = (id: string) =>
    onChange(value.includes(id) ? value.filter(v => v !== id) : [...value, id])
  const labels = value.map(id => options.find(o => o.id === id)?.label || id)

  const handleOpen = () => {
    if (!open && btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect()
      // Clamp to the viewport: on a phone the trigger sits near the right edge
      // and there is often no room below it.
      const gap = 8
      const spaceBelow = window.innerHeight - rect.bottom - gap
      const flipUp = spaceBelow < 180 && rect.top > spaceBelow
      const width = Math.min(Math.max(rect.width, 192), window.innerWidth - gap * 2)
      setDropStyle({
        position: 'fixed',
        ...(flipUp
          ? { bottom: window.innerHeight - rect.top + 4, maxHeight: rect.top - gap * 2 }
          : { top: rect.bottom + 4, maxHeight: spaceBelow - gap }),
        left: Math.max(gap, Math.min(rect.left, window.innerWidth - width - gap)),
        width,
        zIndex: 9999,
      })
    }
    setOpen(o => !o)
  }

  // Close on outside click
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (btnRef.current && !btnRef.current.closest('[data-colleagues-select]')?.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  return (
    <div className="relative w-full min-w-[150px]" data-colleagues-select="">
      <button ref={btnRef} type="button" onClick={handleOpen}
        className="w-full h-8 flex items-center justify-between gap-1 text-[13px] px-2 rounded-[6px] border border-[#C5CAD1] bg-white hover:border-[#9CA3AF] focus:outline-none focus:border-[#9CA3AF] transition-colors text-left cursor-pointer">
        <span className={cx('truncate text-[13px]', labels.length === 0 ? 'text-[#9CA3AF]' : 'text-[#111827]')}>{labels.length === 0 ? 'None' : labels.join(', ')}</span>
        <ChevronDown className="w-3.5 h-3.5 shrink-0 text-[#6B7280]" strokeWidth={1.75} />
      </button>
      {open && (
        <div style={dropStyle} className="bg-white border border-[#C5CAD1] rounded-[6px] shadow-[0_8px_24px_-8px_rgba(16,24,40,0.2)] py-1 overflow-y-auto animate-scale-in">
          {options.length === 0 && <p className="text-[12px] text-[#9CA3AF] px-3 py-2">No other members</p>}
          {options.map(opt => (
            <label key={opt.id} className="flex items-center gap-2 px-3 h-9 hover:bg-[#F9FAFB] cursor-pointer">
              <input type="checkbox" checked={value.includes(opt.id)} onChange={() => toggle(opt.id)} className="w-3.5 h-3.5 accent-[var(--nerve-primary)]" />
              <span className="text-[13px] text-[#111827] truncate">{opt.label}</span>
            </label>
          ))}
          <div className="border-t border-[#C5CAD1] mt-1 pt-1 px-2 pb-1">
            <button type="button" onClick={() => setOpen(false)} className="w-full text-[12px] font-medium text-center text-[#6B7280] hover:text-[#111827] py-1.5 cursor-pointer">Done</button>
          </div>
        </div>
      )}
    </div>
  )
}

// ── KRA Form ───────────────────────────────────────────────────────────────

/** The appraisal scale. Whole numbers only — see the note in KraForm. */
const KRA_SCALE = 5

/** The scale is an evaluation, so the level you pick is coloured by what it
 *  means rather than by the brand: 1 and 2 read as a problem, 3 as adequate,
 *  4 and 5 as strong. Ten of these tiles sit on one screen, and in a single
 *  blue the only way to find the weak parameters was to read all fifty
 *  numbers. The whole run takes the chosen level's hue so each tile reads as
 *  one coloured bar, and the score beside it is tinted to match.
 *
 *  These class strings are spelled out in full because Tailwind scans source
 *  text — a composed `bg-${tone}-600` would not survive the build. */
const KRA_LEVEL_TONES = [
  { solid: 'bg-[#DC2626] border-[#DC2626] text-white', trail: 'bg-[#FEF2F2] border-[#FEE2E2] text-[#B91C1C]', ring: 'ring-[#FEE2E2]', hoverOn: 'hover:bg-[#B91C1C] hover:border-[#B91C1C]', hoverOff: 'hover:border-[#FCA5A5] hover:text-[#B91C1C]', score: 'text-[#DC2626]', card: 'bg-[#FEF2F2] border-[#FEE2E2] hover:border-[#FECACA]' },
  { solid: 'bg-[#F59E0B] border-[#F59E0B] text-white', trail: 'bg-[#FFFBEB] border-[#FEF3C7] text-[#B45309]', ring: 'ring-[#FEF3C7]', hoverOn: 'hover:bg-[#D97706] hover:border-[#D97706]', hoverOff: 'hover:border-[#FCD34D] hover:text-[#B45309]', score: 'text-[#D97706]', card: 'bg-[#FFFBEB] border-[#FEF3C7] hover:border-[#FDE68A]' },
  { solid: 'bg-[#F59E0B] border-[#F59E0B] text-white', trail: 'bg-[#FFFBEB] border-[#FEF3C7] text-[#B45309]', ring: 'ring-[#FEF3C7]', hoverOn: 'hover:bg-[#D97706] hover:border-[#D97706]', hoverOff: 'hover:border-[#FCD34D] hover:text-[#B45309]', score: 'text-[#D97706]', card: 'bg-[#FFFBEB] border-[#FEF3C7] hover:border-[#FDE68A]' },
  { solid: 'bg-[#22C55E] border-[#22C55E] text-white', trail: 'bg-[#ECFDF5] border-[#D1FAE5] text-[#047857]', ring: 'ring-[#D1FAE5]', hoverOn: 'hover:bg-[#16A34A] hover:border-[#16A34A]', hoverOff: 'hover:border-[#86EFAC] hover:text-[#047857]', score: 'text-[#16A34A]', card: 'bg-[#ECFDF5] border-[#D1FAE5] hover:border-[#A7F3D0]' },
  { solid: 'bg-[#16A34A] border-[#16A34A] text-white', trail: 'bg-[#ECFDF5] border-[#D1FAE5] text-[#047857]', ring: 'ring-[#D1FAE5]', hoverOn: 'hover:bg-[#15803D] hover:border-[#15803D]', hoverOff: 'hover:border-[#86EFAC] hover:text-[#047857]', score: 'text-[#16A34A]', card: 'bg-[#ECFDF5] border-[#D1FAE5] hover:border-[#A7F3D0]' },
] as const

/** Tone for a score, or undefined when nothing is chosen yet. Scores outside
 *  1..KRA_SCALE clamp rather than crash — the database scale is 10. */
const kraTone = (v: number | undefined) =>
  v && v >= 1 ? KRA_LEVEL_TONES[Math.min(Math.round(v), KRA_SCALE) - 1] : undefined

/** A numbered 1-5 scale rather than anything bar-shaped.
 *  The score is one of five whole levels, so the control shows the levels
 *  themselves: five numbered circles, filled up to the chosen one. You read the
 *  value off the number, not off a length, and when editable you click the
 *  level you want instead of dragging or sizing something. */
function ScorePips({ value, onSelect, label }: {
  value: number | undefined
  onSelect?: (v: number) => void
  label: string
}) {
  const filled = value ?? 0
  const sel = kraTone(value)
  return (
    <div
      className="flex items-center gap-1.5"
      role={onSelect ? 'radiogroup' : undefined}
      aria-label={onSelect ? `${label} — score out of ${KRA_SCALE}` : undefined}
    >
      {Array.from({ length: KRA_SCALE }, (_, i) => {
        const step = i + 1
        const on = filled >= step
        const isCurrent = filled === step
        const base = `w-8 h-8 rounded-full grid place-items-center text-[12px] font-semibold tabular-nums transition-colors select-none border`
        // Only the chosen level is solid. The levels beneath it keep a pale
        // trail so you can still read the score as a length, but ten of these
        // controls on one screen used to put up fifty heavy navy circles and
        // the actual score was lost in them.
        const tone = isCurrent && sel
          ? sel.solid
          : on && sel
          ? sel.trail
          : 'bg-white border-[#C5CAD1] text-[#D1D5DB]'
        const ring = isCurrent && sel ? ` ring-2 ${sel.ring}` : ''
        if (!onSelect) return <span key={step} className={`${base} ${tone}${ring}`}>{step}</span>
        // An unchosen circle previews its own level on hover, so you can see
        // what you are about to pick before you commit to it.
        const hover = isCurrent && sel ? sel.hoverOn : KRA_LEVEL_TONES[i].hoverOff
        return (
          <button
            key={step}
            type="button"
            role="radio"
            aria-checked={isCurrent}
            aria-label={`${step} out of ${KRA_SCALE}`}
            title={`${step} / ${KRA_SCALE}`}
            // Clicking the current score clears it, so a mis-click is undoable
            // without a separate reset control.
            onClick={() => onSelect(isCurrent ? 0 : step)}
            className={`${base} ${tone}${ring} cursor-pointer focus:outline-none focus:ring-2 focus:ring-[#C5CAD1] ${hover}`}
          >
            {step}
          </button>
        )
      })}
    </div>
  )
}

function KraForm({ params, scores, onChange, readOnly = false }: {
  params: KraParameter[]
  scores: Record<string, number>
  onChange?: (s: Record<string, number>) => void
  readOnly?: boolean
}) {
  return (
    // One tile per parameter, three per row on a wide canvas, two on medium,
    // one on a phone. Three only from xl: at lg the sidebar leaves ~245px per
    // column, which is not enough for a name and five circles.
    //
    // The tiles carry the separation that ten parameters need — before them
    // this was one unbroken field of text and circles and nothing said where
    // one parameter ended and the next began.
    // NOTE ON SCALE: kra_parameters.max_score is 10 in the database, but this
    // form has always been a 0-5 control and the seeded data matches that.
    // Change both together if the scale ever moves.
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
      {params.map(p => {
        const v = scores[p.id]
        return (
          <div
            key={p.id}
            // The tile wears the palest shade of the score's own hue, so a
            // screen of ten parameters can be scanned for the weak ones from
            // the block colour alone, before any circle or number is read.
            // Unscored tiles stay neutral — grey means "not answered yet".
            className={`flex flex-col rounded-[6px] border p-4 transition-colors ${
              kraTone(v)?.card ?? 'border-[#C5CAD1] bg-[#F9FAFB] hover:border-[#C5CAD1]'
            }`}
          >
            <p className="text-[13px] font-semibold text-[#111827]">{p.name}</p>
            <p className="mt-1 text-[12px] leading-relaxed text-[#6B7280]">{p.description}</p>
            {/* mt-auto, so that however many lines a description runs to, every
                scale in the row still lines up along the bottom of its tile. */}
            <div className="mt-auto pt-4 flex items-center justify-between gap-3">
              <ScorePips
                value={v}
                label={p.name}
                onSelect={readOnly ? undefined : n => onChange?.({ ...scores, [p.id]: n })}
              />
              <span className={`shrink-0 text-[13px] font-semibold tabular-nums ${kraTone(v)?.score ?? 'text-[#111827]'}`}>
                {v ?? <span className="text-[#D1D5DB]">&ndash;</span>}
                <span className="text-[12px] font-medium text-[#9CA3AF]">/{KRA_SCALE}</span>
              </span>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// Short labels on purpose: four segments sit side by side here, so "This Week"
// and friends would push the control past the card on a phone.
const CHART_RANGES = [
  { id: 'week', label: 'Week' },
  { id: 'month', label: 'Month' },
  { id: 'year', label: 'Year' },
  { id: 'custom', label: 'Custom' },
] as const

// ── Work Analytics Chart (Salesa Design System matching reference) ────────

/** Work-activity bars in the Nerve Light idiom: every period is a grey bar,
 *  the one being read is dark ink, a dashed guide runs along the top of that
 *  bar from the left edge of the plot, and a dark pill ("Tue : 5.4 hr") sits
 *  above it. The Y axis sits on the right so the guide has a clean run. */
function WorkAnalyticsChart({ data, onBarClick, loading, isWeekView }: {
  data: { day: string; hours: number; submitted: boolean; date: string; isCurrent?: boolean; isHoliday?: boolean }[]
  onBarClick?: (date: string) => void
  loading?: boolean
  isWeekView?: boolean
}) {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null)
  // Where the focused bar was drawn, in plot pixels. Bars record it while
  // Recharts renders them, and the guide is positioned on the next frame —
  // Recharts measures its width after mount, so the first render's geometry
  // is never the real one.
  const [guide, setGuide] = useState<{ x: number; y: number } | null>(null)
  const guideKey = useRef('')
  const plotRef = useRef<HTMLDivElement>(null)

  const currentIndex = data.findIndex(d => d.isCurrent)
  const maxIndex = data.reduce((best, d, i) => (d.hours > (data[best]?.hours ?? -1) ? i : best), 0)
  const focusIndex = hoveredIndex ?? (currentIndex !== -1 ? currentIndex : maxIndex)
  const focus = data[focusIndex]

  useEffect(() => { guideKey.current = ''; setGuide(null) }, [data])

  if (loading) {
    return (
      <div className="flex items-center justify-center h-56">
        <Spinner />
      </div>
    )
  }

  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-56 text-[13px] text-[#6B7280]">
        No work activity recorded for this period
      </div>
    )
  }

  // Y-axis ceiling: for week max 9h, month ~45h max, year adapts
  const maxHours = Math.max(...data.map(d => d.hours), 0)
  let yDomainMax: number
  if (isWeekView) {
    yDomainMax = 9
  } else if (maxHours <= 0) {
    yDomainMax = 10
  } else if (maxHours <= 6) {
    yDomainMax = 8
  } else if (maxHours <= 10) {
    yDomainMax = 12
  } else if (maxHours <= 18) {
    yDomainMax = 20
  } else if (maxHours <= 30) {
    yDomainMax = 36
  } else if (maxHours <= 45) {
    yDomainMax = 50
  } else {
    yDomainMax = Math.ceil((maxHours * 1.2) / 10) * 10
  }

  const yTicks = isWeekView ? [0, 3, 6, 9] : evenTicks(yDomainMax)

  const CustomBar = (props: {
    x?: number; y?: number; width?: number; height?: number; index?: number
    payload?: { hours?: number; isHoliday?: boolean; date?: string }
  }) => {
    const { x = 0, y = 0, width = 0, height = 0, payload, index = -1 } = props
    if (width <= 0) return null

    const hours = payload?.hours ?? 0
    const isZero = hours <= 0
    const isHoliday = payload?.isHoliday ?? false
    const isFocus = index === focusIndex

    const barH = isHoliday ? 22 : isZero ? 4 : Math.max(height, 4)
    const barY = isHoliday ? y - 22 : isZero ? y - 4 : y - (barH - height)
    const r = Math.min(6, width / 2)
    const top = barY
    const centre = x + width / 2

    if (isFocus) {
      const key = `${index}:${Math.round(centre)}:${Math.round(top)}`
      if (guideKey.current !== key) {
        guideKey.current = key
        requestAnimationFrame(() => setGuide({ x: centre, y: top }))
      }
    }

    // Top corners rounded-[5px] (6px), foot square — the bar reads as rising from the axis.
    const d = `M${x},${barY + barH} V${barY + r} Q${x},${barY} ${x + r},${barY} H${x + width - r} Q${x + width},${barY} ${x + width},${barY + r} V${barY + barH} Z`

    if (isHoliday) {
      return (
        <g className="cursor-default">
          <path d={d} fill={CHART2.grid} />
          <text x={centre} y={barY - 6} textAnchor="middle" fontSize={10} fill={CHART2.tick} fontWeight={500}>
            Holiday
          </text>
        </g>
      )
    }

    const fill = isFocus && !isZero
      ? CHART2.highlight
      : hoveredIndex === index ? CHART2.barHover : CHART2.bar
    return (
      <g onClick={() => { if (payload?.date) onBarClick?.(payload.date) }} className="cursor-pointer">
        <path d={d} fill={fill} style={{ transition: 'fill 150ms ease-out' }} />
      </g>
    )
  }

  return (
    <div className="w-full h-full flex flex-col">
      {/* Fills whatever height the card gives it (min 240px) so the chart
          grows with its neighbour instead of leaving a blank band below. */}
      <div ref={plotRef} className="relative flex-1 min-h-[240px]">
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
            <XAxis
              dataKey="day"
              axisLine={false}
              tickLine={false}
              tick={{ fontSize: 12, fill: CHART2.tick }}
              dy={10}
            />
            <YAxis
              orientation="left"
              domain={[0, yTicks[yTicks.length - 1]]}
              ticks={yTicks}
              interval={0}
              axisLine={false}
              tickLine={false}
              allowDecimals={false}
              tick={{ fontSize: 12, fill: CHART2.tick }}
              width={34}
              dx={-4}
            />
            <Bar dataKey="hours" shape={(props: object) => <CustomBar {...props} />} isAnimationActive={false}>
              {data.map((_, i) => <Cell key={i} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>

        {/* Guide: a dashed rule along the focused bar's top edge, and the
            dark pill naming it just above. */}
        {guide && focus && (
          <div className="pointer-events-none absolute inset-0 z-10" aria-hidden="true">
            <svg className="absolute inset-0 w-full h-full overflow-visible">
              <line x1={34} x2={guide.x} y1={guide.y} y2={guide.y} stroke={CHART2.guide} strokeWidth={1.25} strokeDasharray="4 4" />
            </svg>
            <div className="absolute" style={{ left: guide.x, top: guide.y - 8, transform: 'translate(-50%, -100%)' }}>
              <ChartTip
                label={focus.day}
                value={focus.isHoliday ? 'Holiday' : `${focus.hours} hr${focus.submitted ? ' · filed' : ''}`}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Time Distribution waffle ──────────────────────────────────────────────

/** A hundred squares, one per percent of the period, handed out largest-first.
 *  A ring and a treemap both turn the small categories into shapes too thin to
 *  letter, and both ask the reader to judge an angle or an area. Counting
 *  squares needs no judgement: four squares is four percent of the month. */
function TimeDistributionWaffle({ data, title }: {
  data: { name: string; value: number }[]
  title: string
}) {
  const [hovered, setHovered] = useState<number | null>(null)
  const rows = useMemo(() => [...data].sort((a, b) => b.value - a.value), [data])
  const total = rows.reduce((s, d) => s + d.value, 0)
  const active = hovered !== null ? rows[hovered] : null

  // Which category owns each of the hundred squares. Every category that has
  // any time at all keeps at least one square — rounding a real half-hour away
  // to nothing is the failing this chart exists to avoid — and the remainder
  // is handed out largest-fraction-first so the squares total exactly 100.
  const squares = useMemo(() => {
    if (total <= 0) return []
    const exact = rows.map(r => (r.value / total) * 100)
    const counts = exact.map((e, i) => (rows[i].value > 0 ? Math.max(1, Math.floor(e)) : 0))
    let sum = counts.reduce((a, b) => a + b, 0)
    const byFraction = exact.map((_, i) => i).sort((a, b) => (exact[b] % 1) - (exact[a] % 1))
    for (let k = 0; sum < 100 && byFraction.length; k++) { counts[byFraction[k % byFraction.length]]++; sum++ }
    while (sum > 100) {
      // Take the square back off the biggest block, never off a last square.
      let biggest = -1
      counts.forEach((c, i) => { if (c > 1 && (biggest < 0 || c > counts[biggest])) biggest = i })
      if (biggest < 0) break
      counts[biggest]--; sum--
    }
    const out: number[] = []
    counts.forEach((c, i) => { for (let j = 0; j < c; j++) out.push(i) })
    return out
  }, [rows, total])

  if (rows.length === 0 || total <= 0) {
    return (
      <div className="h-full flex flex-col">
        <h3 className={L.cardTitle}>{title}</h3>
        <p className="flex-1 grid place-items-center text-[13px] text-[#6B7280] py-10">Nothing logged in this period.</p>
      </div>
    )
  }

  const pctOf = (v: number) => Math.max(1, Math.round((v / total) * 100))

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <h3 className={L.cardTitle}>{title}</h3>
        <span className={cx(L.eyebrow, 'shrink-0')}>
          {rows.length} work {rows.length === 1 ? 'type' : 'types'}
        </span>
      </div>
      {/* One readout, in the same place whether or not anything is hovered. */}
      <p className={cx(L.meta, 'mt-1 mb-4 truncate')}>
        {active
          ? <><span className="font-semibold text-[#111827]">{active.name}</span>
              {' · '}{fmtHours(active.value)}{' · '}{pctOf(active.value)} of every 100 squares</>
          : <><span className="font-semibold text-[#111827]">{fmtHours(total)}</span> logged · one square is 1% of the period.</>}
      </p>

      {/* Twenty across, five down. A ten-by-ten block is a square that fights
          the card's shape; a wide band of the same hundred squares sits like a
          banner and leaves the width under it for the list. */}
      <div
        className="grid grid-cols-[repeat(10,minmax(0,1fr))] sm:grid-cols-[repeat(20,minmax(0,1fr))] gap-1 sm:gap-2"
        role="img"
        aria-label={`Share of the period by work type: ${rows.map(r => `${r.name} ${pctOf(r.value)}%`).join(', ')}`}
        onMouseLeave={() => setHovered(null)}
      >
        {squares.map((cat, i) => (
          <span
            key={i}
            onMouseEnter={() => setHovered(cat)}
            className="aspect-square rounded-[7px] transition-opacity duration-150"
            style={{
              background: CHART2.series[cat % CHART2.series.length],
              opacity: hovered !== null && hovered !== cat ? 0.18 : 1,
            }}
          />
        ))}
      </div>

      {/* The same ranking as the squares, read as a list. Hovering either one
          lights the other, so the block of colour and the figure are never
          matched up by eye. Two columns, because nine of these stacked singly
          made the list twice the height of the chart above it. */}
      <ul className="mt-5 grid grid-cols-1 sm:grid-cols-2 gap-x-5 gap-y-0.5">
        {rows.map((entry, i) => (
          <li key={entry.name}>
            <button
              type="button"
              onMouseEnter={() => setHovered(i)}
              onMouseLeave={() => setHovered(null)}
              onClick={() => setHovered(prev => (prev === i ? null : i))}
              title={entry.name}
              className={`w-full flex items-baseline gap-2 rounded-[6px] px-2 py-1 text-left transition-colors cursor-pointer ${
                hovered === i ? 'bg-[#F9FAFB]' : 'hover:bg-[#F9FAFB]'
              }`}
              style={{ opacity: hovered !== null && hovered !== i ? 0.45 : 1 }}
            >
              <span className="w-2.5 h-2.5 rounded-[6px] shrink-0 relative top-[1px]"
                    style={{ background: CHART2.series[i % CHART2.series.length] }} />
              <span className={`text-[12px] font-medium truncate ${hovered === i ? 'text-[#111827]' : 'text-[#374151]'}`}>
                {entry.name}
              </span>
              <span className="ml-auto shrink-0 text-[12px] font-semibold text-[#111827] tabular-nums">
                {fmtHours(entry.value)}
                <span className="text-[11px] font-normal text-[#6B7280] ml-1.5">{pctOf(entry.value)}%</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

// ── Collaboration columns ─────────────────────────────────────────────────

/** A name over two lines — given name above, the rest below. One line of full
 *  names at this size either collides or has to be tilted, and cutting them to
 *  the first word alone turned "Branding Lead" into "Branding". */
function CollabTick({ x = 0, y = 0, payload }: {
  x?: number; y?: number; payload?: { value?: string }
}) {
  const full = payload?.value ?? ''
  const [first, ...rest] = full.split(' ')
  const second = rest.join(' ')
  return (
    <text x={x} y={y + 14} textAnchor="middle" fontSize={11} fontWeight={500} fill={CHART2.tick}>
      <title>{full}</title>
      <tspan x={x}>{first}</tspan>
      {second && <tspan x={x} dy={13} fontWeight={400} fill="var(--nv-faint)">{second}</tspan>}
    </text>
  )
}

const COLLAB_RANGES = [
  { id: 'day', label: 'Day' },
  { id: 'week', label: 'Week' },
  { id: 'month', label: 'Month' },
  { id: 'custom', label: 'Custom' },
] as const

/** Who the reader worked alongside, and for how long, over a chosen window.
 *
 *  This was two cards: a column chart tied to the page's own date range, and a
 *  list of the same people with its own range buttons underneath it. Same
 *  question, same names, same hours, twice — so the range control from one and
 *  the chart from the other are now a single card.
 *
 *  Columns, not rails: six full-width tracks with a grey remainder read as six
 *  progress bars towards a target nobody set, where standing them up compares
 *  the people against each other, which is the only thing the card is for. */
function CollaborationCard({ userId, users }: {
  userId: string
  users: ReturnType<typeof useAppData>['users']
}) {
  const [range, setRange] = useState<'day' | 'week' | 'month' | 'custom'>('month')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')
  const [map, setMap] = useState<Record<string, { hours: number; count: number }>>({})
  const [loading, setLoading] = useState(false)
  const [hovered, setHovered] = useState<number | null>(null)

  useEffect(() => {
    if (!userId) return
    const now = new Date()
    let dateFrom: string
    let dateTo = fmtDate(now)
    if (range === 'day') {
      dateFrom = fmtDate(now)
    } else if (range === 'week') {
      const d = new Date(now); d.setDate(d.getDate() - 6)
      dateFrom = fmtDate(d)
    } else if (range === 'month') {
      dateFrom = fmtDate(new Date(now.getFullYear(), now.getMonth(), 1))
    } else {
      if (!customFrom || !customTo) return
      dateFrom = customFrom
      dateTo = customTo
    }
    setLoading(true)
    brandingApi.getAnalytics({ dateFrom, dateTo, userId })
      .then(r => setMap(r.analytics.collaboratorMap))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [userId, range, customFrom, customTo])

  const rows = useMemo(() => Object.entries(map)
    .sort((a, b) => b[1].hours - a[1].hours)
    .slice(0, 8)
    .map(([idOrName, v]) => {
      // The server may return an id or a name; resolve what it can.
      const resolved = users.find(u => u.id === idOrName)
      return {
        name: resolved?.full_name || idOrName,
        hours: Math.round(v.hours * 10) / 10,
        sessions: v.count,
      }
    }), [map, users])

  const total = rows.reduce((s, c) => s + c.hours, 0)
  const active = hovered !== null ? rows[hovered] : null
  const period = range === 'day' ? 'today'
    : range === 'week' ? 'in the last 7 days'
    : range === 'month' ? 'this month'
    : 'in this range'

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <h3 className={L.cardTitle}>
          <Users className="w-4 h-4 text-[#6B7280]" strokeWidth={1.75} /> Collaboration
        </h3>
        {/* The range lives on the card, not on the page, because this is the
            one panel on Analytics whose window people actually change. */}
        <Segmented<typeof range>
          size="sm"
          value={range}
          onChange={setRange}
          options={COLLAB_RANGES.map(r => ({ id: r.id as typeof range, label: r.label }))}
        />
      </div>

      {range === 'custom' && (
        <div className="flex items-center gap-2 mt-3">
          <input type="date" value={customFrom} onChange={e => setCustomFrom(e.target.value)}
            className={cx(L.input, 'h-8 w-auto text-[12px]')} />
          <span className={L.meta}>to</span>
          <input type="date" value={customTo} onChange={e => setCustomTo(e.target.value)}
            className={cx(L.input, 'h-8 w-auto text-[12px]')} />
        </div>
      )}

      <p className={cx(L.meta, 'mt-1 mb-4 truncate')}>
        {active
          ? <><span className="font-semibold text-[#111827]">{active.name}</span>
              {' · '}{fmtHours(active.hours)}{' · '}{active.sessions} {active.sessions === 1 ? 'entry' : 'entries'}
              {' · '}{total > 0 ? Math.max(1, Math.round((active.hours / total) * 100)) : 0}% of shared work</>
          : <><span className="font-semibold text-[#111827]">{fmtHours(total)}</span> of shared work {period}
              {rows.length > 0 && <> · {rows.length} {rows.length === 1 ? 'colleague' : 'colleagues'}</>}</>}
      </p>

      {loading
        ? <p className="flex-1 grid place-items-center text-[13px] text-[#6B7280] py-10 animate-pulse">Loading…</p>
        : rows.length === 0
        ? <p className="flex-1 grid place-items-center text-[13px] text-[#6B7280] py-10">No collaboration {period}.</p>
        : (
      <div className="flex-1 min-h-[230px]">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={rows}
            margin={{ top: 22, right: 4, bottom: 0, left: 4 }}
            onMouseMove={(state: { activeTooltipIndex?: number }) => {
              const i = state?.activeTooltipIndex
              const next = typeof i === 'number' && i >= 0 && i < rows.length ? i : null
              if (next !== hovered) setHovered(next)
            }}
            onMouseLeave={() => setHovered(null)}
          >
            <CartesianGrid vertical={false} stroke={CHART2.grid} />
            <XAxis
              dataKey="name"
              tickLine={false}
              axisLine={{ stroke: 'var(--nv-line)' }}
              tick={<CollabTick />}
              interval={0}
              height={38}
            />
            <YAxis hide />
            <Bar dataKey="hours" radius={[3, 3, 0, 0]} maxBarSize={54} isAnimationActive={false}>
              {/* Grey columns, one dark: the hovered colleague, or the top
                  one when nothing is hovered. */}
              {rows.map((_, i) => (
                <Cell
                  key={i}
                  fill={(hovered === null ? i === 0 : hovered === i) ? CHART2.highlight : CHART2.bar}
                  style={{ transition: 'fill 150ms ease-out' }}
                />
              ))}
              {/* The figure sits over its own column, so the chart is readable
                  without a hover — the hours were the point of the old list. */}
              <LabelList
                dataKey="hours"
                position="top"
                offset={8}
                formatter={(v: number) => fmtHours(v)}
                style={{ fontSize: 11, fontWeight: 600, fill: 'var(--nv-ink)' }}
              />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      )}
    </div>
  )
}

// ── Work Type Distribution (horizontal bars) ──────────────────────────────
function WorkTypeBars({ data }: { data: { name: string; value: number }[] }) {
  const isEmpty = data.length === 0
  const rows = data
    .slice()
    .sort((a, b) => b.value - a.value)
    .slice(0, 8)
  const total = rows.reduce((s, r) => s + r.value, 0)
  const max = Math.max(...rows.map(r => r.value), 1)

  return (
    <div className={cx(L.card, L.cardPad)}>
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h3 className={L.cardTitle}>Work Type Distribution</h3>
        <div className="flex items-center gap-2 shrink-0">
          <Badge hue="grey">This Month</Badge>
        </div>
      </div>
      {isEmpty ? (
        <EmptyState compact icon={BarChart2} title="No work types yet"
          body="Submit a daily report and the hours you log will be split by type of work here." />
      ) : (
      <>
      <p className={cx(L.meta, 'mt-1 mb-5')}>
        {`${fmtHours(total)} across ${rows.length} work ${rows.length === 1 ? 'type' : 'types'}.`}
      </p>

      {/* Three columns rather than one tall stack: eight full-width bars left
          most of the card empty on the right and pushed everything below it
          down the page. Ranked left-to-right, top-to-bottom. */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-x-6 xl:gap-x-8 gap-y-3.5">
        {rows.map(r => {
          const pct = total > 0 ? Math.max(1, Math.round((r.value / total) * 100)) : 0
          return (
            <div key={r.name} className="min-w-0">
              <div className="flex items-baseline justify-between gap-2 mb-1.5">
                {/* Narrower columns clip the longer category names, so the
                    full name stays reachable on hover. */}
                <span className="text-[12px] text-[#6B7280] truncate" title={r.name}>{r.name}</span>
                <span className="text-[12px] font-semibold text-[#111827] shrink-0 tabular-nums">
                  {fmtHours(r.value)}
                  <span className="text-[12px] font-normal text-[#6B7280] ml-1.5">{pct}%</span>
                </span>
              </div>
              <div className="h-2 rounded-full overflow-hidden" style={{ background: CHART2.bar }}>
                <div
                  className="h-full rounded-full transition-[width] duration-500 ease-out"
                  style={{ width: `${Math.max((r.value / max) * 100, 2)}%`, background: CHART2.highlight }}
                />
              </div>
            </div>
          )
        })}
      </div>
      </>
      )}
    </div>
  )
}

// ── Stat Card (Salesa Design System matching reference) ────────────────────

// ── Dashboard Overview Page ────────────────────────────────────────────────

function DashboardPage({
  profile,
  users,
  onNavigate,
  hasTeamPage = false,
}: {
  profile: ReturnType<typeof useAuth>['profile']
  users: ReturnType<typeof useAppData>['users']
  onNavigate: (p: NavPage) => void
  /** Only leads get a My Team page, and the intro card's second button
   *  points there when they do. */
  hasTeamPage?: boolean
}) {
  const [analytics, setAnalytics] = useState<{
    typeHours: Record<string, number>
    collaboratorMap: Record<string, { hours: number; count: number }>
    totalReports: number
  } | null>(null)
  const [weeklyData, setWeeklyData] = useState<{ day: string; hours: number; submitted: boolean; date: string; isCurrent?: boolean; isHoliday?: boolean }[]>([])
  const [weeklyReports, setWeeklyReports] = useState<DailyReport[]>([])
  const [chartReports, setChartReports] = useState<DailyReport[]>([])
  const [todayReport, setTodayReport] = useState<DailyReport | null>(null)
  const [projects, setProjects] = useState<BrandingProject[]>([])

  // Recent reports get their own short window rather than reusing the chart's
  // range — otherwise flipping the chart to Year would silently rewrite this
  // list, and it is meant to be "the last few days", not "the last selection".
  const [recentReports, setRecentReports] = useState<DailyReport[]>([])
  // Whether this month's appraisal is already in, so the nudge for it is only
  // shown to someone who still owes one.
  const [appraisalDone, setAppraisalDone] = useState<boolean | null>(null)
  const [categories, setCategories] = useState<WorkCategory[]>([])
  const [chartFilter, setChartFilter] = useState<'year' | 'month' | 'week' | 'custom'>('week')
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

  // Live-sync collab card: refresh own analytics + the WHOLE team's weekly
  // reports on mount and every 30s, so a colleague's stopwatch transition or
  // new collaboration entry shows up in everyone's profile within one tick.
  const refreshCollabSync = useCallback(async () => {
    if (!profile?.id) return
    const now = new Date()
    const monthFrom = fmtDate(new Date(now.getFullYear(), now.getMonth(), 1))
    const monthTo = fmtDate(now)
    const sunday = new Date(now); sunday.setDate(now.getDate() - now.getDay())
    const saturday = new Date(sunday); saturday.setDate(sunday.getDate() + 6)
    try {
      const [analyticsRes, reportsRes] = await Promise.all([
        brandingApi.getAnalytics({ dateFrom: monthFrom, dateTo: monthTo, userId: profile.id }),
        brandingApi.getAllReports({ dateFrom: fmtDate(sunday), dateTo: fmtDate(saturday), teamScope: true }),
      ])
      setAnalytics(analyticsRes.analytics)
      setWeeklyReports(reportsRes.reports)
    } catch { /* swallow — initial-load toast is enough */ }
  }, [profile?.id])

  useEffect(() => {
    void refreshCollabSync()
    const id = setInterval(() => { void refreshCollabSync() }, 30_000)
    return () => clearInterval(id)
  }, [refreshCollabSync])

  // Chart filter — fetch and aggregate data based on selected filter
  useEffect(() => {
    const now = new Date()
    let dateFrom: string, dateTo: string

    if (chartFilter === 'year') {
      dateFrom = fmtDate(new Date(now.getFullYear(), 0, 1))
      dateTo = fmtDate(new Date(now.getFullYear(), 11, 31))
    } else if (chartFilter === 'month') {
      dateFrom = fmtDate(new Date(now.getFullYear(), now.getMonth(), 1))
      dateTo = fmtDate(now)
    } else if (chartFilter === 'week') {
      const sunday = new Date(now); sunday.setDate(now.getDate() - now.getDay())
      const saturday = new Date(sunday); saturday.setDate(sunday.getDate() + 6)
      dateFrom = fmtDate(sunday); dateTo = fmtDate(saturday)
    } else {
      if (!customFrom || !customTo) return
      dateFrom = customFrom; dateTo = customTo
    }

    if (!profile?.id) return

    setChartLoading(true)
    brandingApi.getAllReports({ dateFrom, dateTo, userId: profile.id })
      .then(r => {
        setChartReports(r.reports)
        const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
        const MONTH_ABB = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']


        if (chartFilter === 'year') {
          const currentMonthIdx = now.getMonth()
          const rawData = Array.from({ length: 12 }, (_, i) => {
            const ms = new Date(now.getFullYear(), i, 1)
            const me = new Date(now.getFullYear(), i + 1, 0)
            const monthReps = r.reports.filter(rp => {
              const rd = parseDateLocal(rp.report_date)
              return rd >= ms && rd <= me
            })
            const hrs = monthReps.reduce((s, rep) =>
              s + (rep.rows?.reduce((rs, row) => rs + timeToHours(row.time_taken), 0) ?? 0), 0)
            return {
              day: MONTH_ABB[i],
              hours: Math.round(hrs * 10) / 10,
              submitted: monthReps.some(rp => rp.is_locked),
              date: fmtDate(ms),
              isCurrent: i === currentMonthIdx,
            }
          })
          setWeeklyData(rawData)
        } else if (chartFilter === 'month') {
          const from = parseDateLocal(dateFrom), to = parseDateLocal(dateTo)
          const rawData: { day: string; hours: number; submitted: boolean; date: string; isCurrent?: boolean }[] = []
          const d = new Date(from)
          const todayDate = now.getDate()
          while (d <= to) {
            const ds = fmtDate(d)
            const rep = r.reports.find(rp => rp.report_date === ds)
            const hrs = rep?.rows?.reduce((s, row) => s + timeToHours(row.time_taken), 0) ?? 0
            rawData.push({
              day: String(d.getDate()),
              hours: Math.round(hrs * 10) / 10,
              submitted: rep?.is_locked ?? false,
              date: ds,
              isCurrent: d.getDate() === todayDate,
            })
            d.setDate(d.getDate() + 1)
          }
          setWeeklyData(rawData)
        } else if (chartFilter === 'week') {
          const sunday = parseDateLocal(dateFrom)
          const currentDayIdx = now.getDay()
          const rawData = Array.from({ length: 7 }, (_, i) => {
            const d = new Date(sunday); d.setDate(sunday.getDate() + i)
            const ds = fmtDate(d)
            const rep = r.reports.find(rp => rp.report_date === ds)
            const hrs = rep?.rows?.reduce((s, row) => s + timeToHours(row.time_taken), 0) ?? 0
            const isSunday = i === 0
            return {
              day: DAY_LABELS[i],
              hours: isSunday ? 0 : Math.min(Math.round(hrs * 10) / 10, 9),
              submitted: isSunday ? false : (rep?.is_locked ?? false),
              date: ds,
              isCurrent: i === currentDayIdx,
              isHoliday: isSunday,
            }
          })
          setWeeklyData(rawData)
        } else {
          const from = parseDateLocal(dateFrom), to = parseDateLocal(dateTo)
          const data: { day: string; hours: number; submitted: boolean; date: string }[] = []
          const d = new Date(from)
          while (d <= to) {
            const ds = fmtDate(d)
            const rep = r.reports.find(rp => rp.report_date === ds)
            const hrs = rep?.rows?.reduce((s, row) => s + timeToHours(row.time_taken), 0) ?? 0
            data.push({
              day: String(d.getDate()),
              hours: Math.round(hrs * 10) / 10,
              submitted: rep?.is_locked ?? false,
              date: ds,
            })
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

  useEffect(() => {
    if (!profile?.id) return
    const to = new Date()
    const from = new Date(); from.setDate(from.getDate() - 60)
    brandingApi.getAllReports({ userId: profile.id, dateFrom: fmtDate(from), dateTo: fmtDate(to) })
      .then(r => setRecentReports(
        [...r.reports]
          .filter(rep => (rep.rows ?? []).length > 0)
          .sort((a, b) => b.report_date.localeCompare(a.report_date))
          .slice(0, 3),
      ))
      .catch(() => {})
  }, [profile?.id])

  useEffect(() => {
    const d = new Date()
    brandingApi.getSelfAppraisal(d.getMonth() + 1, d.getFullYear())
      .then(r => setAppraisalDone(!!r.appraisal))
      .catch(() => setAppraisalDone(null))
  }, [])

  // This month's own reports. "Reports submitted" used to read
  // analytics.totalReports, which counts every report in the window — today's
  // unsubmitted draft included. The card said 20 submitted on a month with 19
  // filed and one still open, and it was wrong that way every single day.
  const [monthReports, setMonthReports] = useState<DailyReport[]>([])
  useEffect(() => {
    if (!profile?.id) return
    const d = new Date()
    brandingApi.getAllReports({
      userId: profile.id,
      dateFrom: fmtDate(new Date(d.getFullYear(), d.getMonth(), 1)),
      dateTo: fmtDate(d),
    })
      .then(r => setMonthReports(r.reports))
      .catch(() => setMonthReports([]))
  }, [profile?.id, todayReport?.is_locked])

  // A running stopwatch changes the hours without changing any state, so the
  // card needs a nudge to re-read the clock. Only while something is running,
  // and only once a minute — this is an hours figure, not a stopwatch.
  const hasRunningRow = (todayReport?.rows ?? []).some(r => r.stopwatch_status === 'running')
  const [, setClockTick] = useState(0)
  useEffect(() => {
    if (!hasRunningRow) return
    const id = setInterval(() => setClockTick(t => t + 1), 60_000)
    return () => clearInterval(id)
  }, [hasRunningRow])

  const workingDays = workingDaysSoFar()
  const submitted = monthReports.filter(r => r.is_locked).length
  const todayHours = (todayReport?.rows ?? []).reduce((s, r) => s + rowHoursNow(r), 0)
  // Analytics is the server's own aggregate and is what the Analytics page
  // shows, so it stays the base. It only sees `time_taken`, so a row whose
  // timer is still running counts as zero there — that live time is added
  // back here, and only for rows with nothing logged yet, so nothing is
  // counted twice.
  const liveUnloggedToday = (todayReport?.rows ?? [])
    .reduce((sum, r) => sum + (timeToHours(r.time_taken) > 0 ? 0 : rowHoursNow(r)), 0)
  const totalHoursThisMonth = analytics
    ? Math.round((Object.values(analytics.typeHours).reduce((a, b) => a + b, 0) + liveUnloggedToday) * 10) / 10
    : Math.round(liveUnloggedToday * 10) / 10
  const progress = workingDays > 0 ? Math.min(100, Math.round((submitted / workingDays) * 100)) : 0
  const totalChartHours = useMemo(() => {
    return weeklyData.reduce((acc, d) => acc + d.hours, 0)
  }, [weeklyData])

  // Project stats
  const now = new Date()
  const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1)
  const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1)
  const totalProjects = projects.length
  // Yours, not the workspace's. This counted every project the workspace had
  // open, so it disagreed with the Projects list and the Project Progress
  // gauge — both of which go by your own assignment — on the same screen.
  const runningProjects = projects.filter(p => myProjectStatus(p, profile?.id) !== 'completed').length
  // By the reader's own assignment, so that marking a project complete on the
  // Daily Reports page moves this card.
  const myCompletedProjects = projects.filter(p => myProjectStatus(p, profile?.id) === 'completed').length
  const newThisMonth = projects.filter(p => new Date(p.created_at) >= thisMonthStart).length
  const newLastMonth = projects.filter(p => {
    const d = new Date(p.created_at)
    return d >= lastMonthStart && d < thisMonthStart
  }).length
  const projectIncrease = Math.max(0, newThisMonth - newLastMonth)
  const runningIncrease = projects.filter(p => p.status === 'active' && new Date(p.created_at) >= thisMonthStart).length

  /** What a day was mostly about: the work type with the most hours on it.
   *  A report has several rows and the card has one line, so the biggest
   *  slice stands for the day. */
  const reportLabel = (rep: DailyReport) => {
    const byType: Record<string, number> = {}
    for (const row of rep.rows ?? []) {
      byType[row.type_of_work || 'Other'] = (byType[row.type_of_work || 'Other'] ?? 0) + timeToHours(row.time_taken)
    }
    const top = Object.entries(byType).sort((a, b) => b[1] - a[1])[0]
    return top ? top[0] : 'No entries'
  }
  const reportHours = (rep: DailyReport) =>
    (rep.rows ?? []).reduce((sum, row) => sum + timeToHours(row.time_taken), 0)

  // Built from state rather than hard-coded, so an item only appears while it
  // is actually true — and the card can be honestly empty.
  const attention: { title: string; body: string; action: string; run: () => void }[] = []
  {
    const openToday = (todayReport?.rows ?? []).filter(r => r.stopwatch_status !== 'finished').length
    if (openToday > 0) {
      attention.push({
        title: "Finish today's active tasks",
        body: `${openToday} ${openToday === 1 ? 'task is' : 'tasks are'} still in progress`,
        action: 'Open',
        run: () => onNavigate('daily-reports'),
      })
    }
    const nextDue = projects
      .filter(pr => pr.status !== 'completed' && pr.deadline)
      .sort((a, b) => (a.deadline ?? '').localeCompare(b.deadline ?? ''))[0]
    if (nextDue?.deadline) {
      attention.push({
        title: 'Review upcoming project dates',
        // new Date(), not parseDateLocal: a project deadline is a full
        // timestamp, and the YYYY-MM-DD parser returns Invalid Date for it.
        // This matches how the Projects list already renders "Due 6 Oct".
        body: `${nextDue.name} · ${new Date(nextDue.deadline).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`,
        action: 'View',
        run: () => onNavigate('daily-reports'),
      })
    }
    if (appraisalDone === false) {
      attention.push({
        title: 'Complete monthly reflection',
        body: 'Add your outcomes and goals',
        action: 'Review',
        run: () => onNavigate('self-appraisal'),
      })
    }
  }

  // Everything you are on: open work first by soonest deadline, then the work
  // you have finished. Completed projects used to be filtered out, so a
  // project vanished from the card at the moment you marked it done — the one
  // moment you might look for it. "Done" is a state worth seeing, not an
  // absence. Completion follows your own assignment, like the Projects list
  // and the Project Progress gauge.
  const projectDone = (pr: BrandingProject) => myProjectStatus(pr, profile?.id) === 'completed'
  const projectsInMotion = [...projects].sort((a, b) => {
    const da = projectDone(a), db = projectDone(b)
    if (da !== db) return da ? 1 : -1
    // Within a group: soonest deadline first for open work, latest finish
    // first for closed, and anything undated last either way.
    if (!a.deadline && !b.deadline) return 0
    if (!a.deadline) return 1
    if (!b.deadline) return -1
    return da ? b.deadline.localeCompare(a.deadline) : a.deadline.localeCompare(b.deadline)
  })

  const doneInMotion = projectsInMotion.filter(projectDone).length
  const openInMotion = projectsInMotion.length - doneInMotion

  const topCollaborators = analytics
    ? Object.entries(analytics.collaboratorMap)
        .sort((a, b) => b[1].hours - a[1].hours)
        .slice(0, 4)
        .map(([name, v]) => ({ name, hours: v.hours }))
    : []

  const pieData = analytics
    ? Object.entries(analytics.typeHours)
        .filter(([, v]) => v > 0)
        .map(([name, value]) => ({ name, value }))
    : []

  const appraisalDue = now.getDate() >= 20
  const todaySubmitted = todayReport?.is_locked ?? false

  // All branding team members except self
  const brandingMembers = users.filter(u => u.team === 'branding' && u.id !== profile?.id)

  const collabSubCatOptions = useMemo(() => {
    if (!collabWorkType) return []
    return categories.find(c => c.name === collabWorkType)?.sub_categories || []
  }, [collabWorkType, categories])

  // Per-member status for TODAY. The card calls itself live work status, so
  // today is the only day that can answer it.
  //
  // What this used to do, and why each part was wrong:
  //  · It scanned the whole week and let any day win, so a Tuesday row could
  //    describe someone's "current" activity on a Friday.
  //  · "Completed" needed a *finished stopwatch* on a locked report. Anyone
  //    who filed their day without ever using the timer stayed In Progress
  //    even after submitting.
  //  · It never set `hours` at all, so the Hours column read `undefined` and
  //    silently fell back to a monthly figure under a column the rest of the
  //    row described as today. (This is the TS2339 that sat in the build.)
  //  · Hours came from `time_taken`, which is empty while a timer runs — the
  //    same defect fixed on the dashboard's Today's Hours.
  const collabDetails = useMemo(() => {
    const todayStr = today()
    const map: Record<string, {
      work: string
      status: 'completed' | 'in-progress' | 'pending'
      date?: string
      hours: number
    }> = {}

    for (const rep of weeklyReports.filter(r => r.report_date === todayStr)) {
      const rows = rep.rows ?? []
      const hours = rows.reduce((sum, row) => sum + rowHoursNow(row), 0)
      // What they are on right now: a live timer beats a paused one, and
      // failing both, the last row with anything written on it.
      const pick = rows.find(r => r.stopwatch_status === 'running')
        ?? rows.find(r => r.stopwatch_status === 'paused')
        ?? [...rows].reverse().find(r => r.specific_work || r.type_of_work)
      const work = pick
        ? ([pick.type_of_work, pick.specific_work].filter(Boolean).join(' — ') || 'Working')
        : ''
      map[rep.user_id] = {
        status: rep.is_locked ? 'completed' : rows.length > 0 ? 'in-progress' : 'pending',
        work: work || (rep.is_locked ? 'Day filed' : 'Draft open, nothing logged yet'),
        date: rep.report_date,
        hours,
      }
    }

    // Anyone with nothing today still gets a line, from work you logged with
    // them — but as Pending, because it says nothing about their day.
    for (const rep of weeklyReports) {
      if (rep.user_id !== profile?.id) continue
      for (const row of rep.rows ?? []) {
        for (const uid of row.collaborative_colleagues) {
          if (map[uid]) continue
          const work = [row.type_of_work, row.specific_work].filter(Boolean).join(' — ')
          map[uid] = { work: work || 'Collaborative work', status: 'pending', date: rep.report_date, hours: 0 }
        }
      }
    }
    return map
  }, [weeklyReports, profile?.id])

  const handleBarClick = useCallback((date: string) => {
    const rep = chartReports.find(r => r.report_date === date)
    if (rep) setReportPopup(rep)
  }, [chartReports])

  // Team table: one row per branding colleague, live ones first.
  const teamRows = useMemo(() => {
    const statusRank = { 'in-progress': 0, completed: 1, pending: 2 } as const
    const rows = brandingMembers.map(m => {
      const weekly = collabDetails[m.id]
      const monthly = analytics?.collaboratorMap[m.full_name || ''] ?? analytics?.collaboratorMap[m.email] ?? null
      const status: 'completed' | 'in-progress' | 'pending' = weekly?.status ?? 'pending'
      return {
        member: m,
        name: m.full_name || m.email,
        work: weekly?.work || (monthly ? `${fmtHours(monthly.hours)} collaborated this month` : 'No report today'),
        hours: weekly?.hours ?? 0,
        status,
      }
    })
    rows.sort((a, b) => (statusRank[a.status] - statusRank[b.status]) || a.name.localeCompare(b.name))
    return rows
  }, [brandingMembers, collabDetails, analytics])

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
        stopwatch_status: row.stopwatch_status,
        elapsed_seconds: row.elapsed_seconds,
        stopwatch_started_at: row.stopwatch_started_at,
        carried_over_from_row_id: row.carried_over_from_row_id,
        last_paused_at: row.last_paused_at,
        project_id: row.project_id ?? null,
      }))
      const newRow = {
        sr_no: existingRows.length + 1,
        type_of_work: collabWorkType,
        sub_category: collabSubCat,
        specific_work: collabNote.trim(),
        time_taken: collabTime,
        collaborative_colleagues: [collabColleague],
        stopwatch_status: 'finished' as const,
        elapsed_seconds: 0,
        stopwatch_started_at: null,
        carried_over_from_row_id: null,
        last_paused_at: new Date().toISOString(),
        project_id: null,
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

  // Average of the periods that had any work on them, for the chip beside the
  // range control. Holidays and empty days would only drag it down.
  const workedPeriods = weeklyData.filter(d => !d.isHoliday && d.hours > 0).length
  const avgChartHours = workedPeriods > 0 ? totalChartHours / workedPeriods : 0
  // The onboarding nudge is for an account that has never filed anything.
  // Someone with history but a quiet week still gets their chart (with zero
  // bars), not a prompt that reads as if their past reports were lost.
  const [hasAnyReports, setHasAnyReports] = useState<boolean | null>(null)
  useEffect(() => {
    if (!profile?.id) return
    brandingApi.getAllReports({ userId: profile.id })
      .then(r => setHasAnyReports(r.reports.some(rep => (rep.rows ?? []).some(row => timeToHours(row.time_taken) > 0) || rep.is_locked)))
      .catch(() => setHasAnyReports(true))
  }, [profile?.id, todayReport?.is_locked])
  // "New" means an empty workspace: nothing ever filed AND nothing assigned.
  // A member who already carries projects has a history on the team, so they
  // get the real chart (zero bars and all) rather than the onboarding prompt.
  const chartIsEmpty = !chartLoading && hasAnyReports === false && projects.length === 0 && !weeklyData.some(d => d.hours > 0)

  const introDate = now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' })
  const monthLabel = now.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
  const todayLabel = now.toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })

  return (
    <div className="w-full space-y-4">
      {/* ── Intro banner ─────────────────────────────────────────────────── */}
      {/* The banner is the one coloured surface on the page, in the design's
          brand blue (var(--nerve-primary)). */}
      <section className="rounded-[6px] bg-[var(--nerve-primary-dark)] overflow-hidden">
        <div className="grid grid-cols-1">
          <div className="p-4 sm:p-7 flex flex-col justify-center min-w-0">
            <p className={cx(L.eyebrow, '!text-[var(--nerve-on-primary-muted)]')}>Your workspace · {introDate}</p>
            <h2 className="mt-2 text-[22px] sm:text-[24px] font-semibold text-[var(--nerve-on-primary)] tracking-[-0.01em] leading-tight">
              Good work starts with a clear view.
            </h2>
            <p className="mt-2 text-[13px] text-[var(--nerve-on-primary-muted)] leading-relaxed max-w-xl">
              Track today’s activity, close open tasks and see what your team needs from you.
            </p>
            <div className="mt-5 flex items-center gap-2 flex-wrap">
              <button type="button" onClick={() => onNavigate('daily-reports')} className={cx(L.btn, 'bg-[var(--nv-white)] text-[var(--nerve-primary-ink)] hover:bg-[var(--nv-white-hover)]')}>
                Open today’s worklog <ArrowRight className="w-4 h-4" strokeWidth={1.75} />
              </button>
              <button type="button" onClick={() => onNavigate(hasTeamPage ? 'team' : 'analytics')} className={cx(L.btn, 'bg-transparent border border-[var(--nerve-on-primary-muted)] text-[var(--nerve-on-primary)] hover:bg-[var(--nerve-primary)]')}>
                {hasTeamPage ? 'View team activity' : 'View analytics'}
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* ── At a glance ──────────────────────────────────────────────────── */}
      <section>
        <div className="flex items-end justify-between gap-3 flex-wrap">
          <div>
            <h2 className="text-[14px] font-semibold text-[#111827]">At a glance</h2>
            <p className={L.meta}>{monthLabel} · your personal workspace</p>
          </div>
        </div>
        <div className="mt-3 grid grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard
            title="Today's Hours"
            icon={Clock}
            value={fmtHours(todayHours)}
            sub={`${todayLabel} · ${todaySubmitted ? 'submitted' : 'draft in progress'}`}
            onClick={() => onNavigate('daily-reports')}
          />
          <StatCard
            title="Hours this month"
            icon={TrendingUp}
            value={fmtHours(totalHoursThisMonth)}
            sub={currentMonthRange()}
            onClick={() => onNavigate('analytics')}
          />
          <StatCard
            title="Active projects"
            icon={Layers}
            value={String(runningProjects).padStart(2, '0')}
            sub="Assigned to you and still open"
            onClick={() => onNavigate('daily-reports')}
          />
          <StatCard
            title="Reports submitted"
            icon={CheckCircle2}
            value={<>{submitted}<span className="text-[#9CA3AF] font-medium">{' / '}{workingDays}</span></>}
            sub={`Filed out of ${workingDays} working days so far`}
            onClick={() => onNavigate('daily-reports')}
          />
        </div>
      </section>

      {/* ── Work activity · Projects in motion ───────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-stretch">
        <Card
          title="Work Activity"
          bodyClassName="flex flex-col flex-1"
          action={
            <>
              {!chartIsEmpty && (
                // Same box as the range pills beside it, just not clickable.
                <span className="hidden sm:inline-flex items-center h-8 px-3 rounded-[6px] text-[12px] font-medium whitespace-nowrap border border-[#C5CAD1] bg-white text-[#374151]">
                  Avg {fmtHours(avgChartHours)}
                </span>
              )}
              <Segmented<typeof chartFilter>
                size="sm"
                value={chartFilter}
                onChange={setChartFilter}
                options={CHART_RANGES.map(r => ({ id: r.id as typeof chartFilter, label: r.label }))}
              />
            </>
          }
        >
          {chartIsEmpty ? (
            <div className="py-6 sm:py-10">
              <EmptyState
                icon={BarChart2}
                title="Nothing logged yet"
                body="Add a report each day to log your presence. Every submitted day builds this chart, counts toward your monthly hours, and shows your team what you worked on."
                action={
                  <button type="button" onClick={() => onNavigate('daily-reports')} className={cx(L.btn, L.btnPrimary, L.btnSm)}>
                    <Plus className="w-4 h-4" strokeWidth={1.75} /> Add today's report
                  </button>
                }
              />
            </div>
          ) : (
          <>
          <div className="flex items-end justify-between gap-3 flex-wrap">
            <span className={L.figure}>
              {Math.floor(totalChartHours).toLocaleString()}
              <span>.{String(Math.round((totalChartHours % 1) * 100)).padStart(2, '0')}</span>
              <span className="text-[16px] text-[#6B7280] font-medium ml-1 tracking-normal">hr</span>
            </span>
            <div className="flex items-center gap-4 text-[12px] text-[#6B7280]">
              <span className="inline-flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-[var(--nerve-primary)]" aria-hidden="true" /> Total Hours
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-[#F3F4F6] border border-[#C5CAD1]" aria-hidden="true" /> Holiday
              </span>
            </div>
          </div>

          {chartFilter === 'custom' && (
            <div className="mt-3 flex items-center flex-wrap gap-2 rounded-[6px] border border-[#C5CAD1] bg-[#F9FAFB] p-2">
              <span className={L.meta}>From</span>
              <input type="date" value={customFrom} onChange={e => setCustomFrom(e.target.value)} className={cx(L.input, 'h-8 w-auto text-[12px]')} />
              <span className={L.meta}>To</span>
              <input type="date" value={customTo} onChange={e => setCustomTo(e.target.value)} className={cx(L.input, 'h-8 w-auto text-[12px]')} />
            </div>
          )}

          <div className="mt-2 flex-1 flex flex-col min-h-[240px]">
            <WorkAnalyticsChart
              data={weeklyData}
              onBarClick={handleBarClick}
              loading={chartLoading}
              isWeekView={chartFilter === 'week'}
            />
          </div>
          </>
          )}
        </Card>

        <Card
          title={<CardTitle title="Projects in motion" sub={`${openInMotion} running · ${doneInMotion} completed`} />}
          action={<button type="button" onClick={() => onNavigate('analytics')} className={TEXT_LINK}>View analytics →</button>}
          bodyClassName="flex-1"
        >
          {projectsInMotion.length === 0 ? (
            <EmptyState icon={Layers} title="No projects assigned to you yet." />
          ) : (
            <div className="divide-y divide-[#C5CAD1] max-h-[22rem] overflow-y-auto -mr-2 pr-2">
              {projectsInMotion.map(pr => {
                const done = projectDone(pr)
                const state = done ? 'completed' : pr.status === 'on_hold' ? 'paused' : 'open'
                const hue = hueForStatus(state)
                return (
                  <ActivityItem
                    key={pr.id}
                    icon={done ? CheckCircle2 : pr.status === 'on_hold' ? Pause : Layers}
                    hue={hue}
                    title={pr.name}
                    meta={<>
                      {pr.type_of_work || pr.sub_category || 'Project'}
                      {pr.deadline ? ` · due ${new Date(pr.deadline).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}` : ''}
                    </>}
                    time={<Badge hue={hue}>{done ? 'Delivered' : pr.status === 'on_hold' ? 'On hold' : 'In progress'}</Badge>}
                  />
                )
              })}
            </div>
          )}
        </Card>
      </div>

      {/* ── Recent reports · Needs your attention ────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-stretch">
        <Card
          title={<CardTitle title="Recent reports" sub="Pick up where you left off" />}
          action={<button type="button" onClick={() => onNavigate('daily-reports')} className={TEXT_LINK}>All reports →</button>}
        >
          {recentReports.length === 0 ? (
            <EmptyState compact icon={ClipboardList} title="No reports filed yet." />
          ) : (
            <div className="divide-y divide-[#C5CAD1]">
              {recentReports.map(rep => (
                <ActivityItem
                  key={rep.id}
                  icon={FileText}
                  hue={rep.is_locked ? 'green' : 'amber'}
                  title={reportLabel(rep)}
                  meta={<>
                    {parseDateLocal(rep.report_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                    {' · '}{fmtHours(reportHours(rep))}
                  </>}
                  time={<Badge hue={rep.is_locked ? 'green' : 'amber'}>{rep.is_locked ? 'Submitted' : 'Draft'}</Badge>}
                  onClick={() => onNavigate('daily-reports')}
                />
              ))}
            </div>
          )}
        </Card>

        <Card title={<CardTitle title="Needs your attention" sub="Prioritised next steps" />}>
          {attention.length === 0 ? (
            <EmptyState compact icon={CheckCircle2} title="Nothing needs your attention right now." />
          ) : (
            <div className="divide-y divide-[#C5CAD1]">
              {attention.map((item, i) => (
                <div key={item.title} className="flex items-start gap-3 py-3">
                  <span className="w-8 h-8 rounded-[6px] border border-[#C5CAD1] bg-[#F9FAFB] grid place-items-center text-[11px] font-semibold text-[#6B7280] tabular-nums shrink-0">
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] font-semibold text-[#111827]">{item.title}</p>
                    <p className="text-[12px] text-[#6B7280] mt-0.5">{item.body}</p>
                  </div>
                  <button type="button" onClick={item.run} className={cx(TEXT_LINK, 'shrink-0')}>{item.action} →</button>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      {/* ── Team collaboration ───────────────────────────────────────────── */}
      <Card
        title={<CardTitle title="Team Collaboration" sub="Live work status across branding peers" />}
        padded={false}
        action={
          <button type="button" onClick={() => setShowAddCollab(true)} className={cx(L.btn, L.btnSecondary, L.btnSm)}>
            <Plus className="w-4 h-4 text-[#6B7280]" strokeWidth={1.75} /> Add Log
          </button>
        }
      >
        {teamRows.length === 0 ? (
          <EmptyState compact icon={Users} title="No team members found." />
        ) : (
          // Eight rows tall; the rest scroll inside the card, header pinned.
          <div className="overflow-auto max-h-[464px]">
            <table className={cx(L.table, 'min-w-[640px] border-collapse')}>
              <thead className={cx(L.thead, 'sticky top-0 z-10')}>
                <tr>
                  <Th>Colleague</Th>
                  <Th>Activity</Th>
                  <Th>Hours</Th>
                  <Th align="right">Status</Th>
                </tr>
              </thead>
              <tbody>
                {teamRows.map(r => (
                  <tr key={r.member.id} className={L.trHover}>
                    <td className={cx(L.td, 'font-medium')}>
                      <span className="flex items-center gap-2.5 max-w-[220px]">
                        <Avatar name={r.name} url={r.member.avatar_url} size="sm" />
                        <span className="truncate">{r.name}</span>
                      </span>
                    </td>
                    <td className={cx(L.td, '!text-[#6B7280] max-w-[320px]')}>
                      <span className="block truncate">{r.work}</span>
                    </td>
                    <td className={cx(L.td, 'tabular-nums whitespace-nowrap')}>{r.hours > 0 ? fmtHours(r.hours) : '—'}</td>
                    <td className={cx(L.td, 'text-right')}>
                      {r.status === 'completed'
                        ? <StatusText icon={Check} hue="green">Success</StatusText>
                        : r.status === 'in-progress'
                        ? <StatusText icon={Timer} hue="blue">In progress</StatusText>
                        : <StatusText icon={Clock} hue="amber">Pending</StatusText>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {teamRows.length > 0 && (
          <p className={cx(L.meta, 'text-center px-4 py-2.5 border-t border-[#C5CAD1]')}>
            {brandingMembers.length} {brandingMembers.length === 1 ? 'member' : 'members'}
          </p>
        )}
      </Card>

      {/* ── Add Member / Log Collaboration Modal ──────────────────────────── */}
      {showAddCollab && (
        <Modal
          size="sm"
          title="Log Collaboration"
          subtitle="Adds an entry to today's draft report."
          onClose={() => setShowAddCollab(false)}
          footer={
            <>
              <button type="button" onClick={() => setShowAddCollab(false)} className={cx(L.btn, L.btnSecondary)}>
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void logCollaboration()}
                disabled={collabSaving || todayReport?.is_locked}
                className={cx(L.btn, L.btnPrimary)}
              >
                {collabSaving ? 'Saving…' : 'Log Collaboration'}
              </button>
            </>
          }
        >
          <div className="space-y-3">
            {/* Colleague */}
            <div>
              <label className={L.label}>Team Member *</label>
              <select value={collabColleague} onChange={e => setCollabColleague(e.target.value)} className={L.select}>
                <option value="">Select colleague…</option>
                {brandingMembers.map(m => (
                  <option key={m.id} value={m.id}>{m.full_name || m.email}</option>
                ))}
              </select>
            </div>

            {/* Work type */}
            <div>
              <label className={L.label}>Type of Work *</label>
              <select value={collabWorkType} onChange={e => { setCollabWorkType(e.target.value); setCollabSubCat('') }} className={L.select}>
                <option value="">Select type…</option>
                {categories.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
              </select>
            </div>

            {/* Sub category (if available) */}
            {collabSubCatOptions.length > 0 && (
              <div>
                <label className={L.label}>Sub Category</label>
                <select value={collabSubCat} onChange={e => setCollabSubCat(e.target.value)} className={L.select}>
                  <option value="">Select sub-category…</option>
                  {collabSubCatOptions.map(s => <option key={s.id} value={s.name}>{s.name}</option>)}
                </select>
              </div>
            )}

            {/* Description */}
            <div>
              <label className={L.label}>Work Description *</label>
              <input
                value={collabNote}
                onChange={e => setCollabNote(e.target.value)}
                placeholder="e.g. Worked on logo redesign together…"
                className={L.input}
              />
            </div>

            {/* Time taken */}
            <div>
              <label className={L.label}>Time Taken *</label>
              <select value={collabTime} onChange={e => setCollabTime(e.target.value)} className={L.select}>
                <option value="">Select duration…</option>
                {TIME_OPTIONS.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>

            {todayReport?.is_locked && (
              <div className="flex items-center gap-2 p-3 rounded-[6px] border border-[#FEF3C7] bg-[#FFFBEB] text-[12px] text-[#B45309]">
                <Lock className="w-3.5 h-3.5 shrink-0" strokeWidth={1.75} />
                Today's report is already submitted. You cannot add new entries.
              </div>
            )}
          </div>
        </Modal>
      )}

      {/* ── Report Detail Popup ──────────────────────────────────────────── */}
      {reportPopup && (
        <Modal
          size="lg"
          onClose={() => setReportPopup(null)}
          title={<>Report — {new Date(reportPopup.report_date + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</>}
          subtitle={
            <span className="inline-flex items-center gap-1.5 flex-wrap">
              {reportPopup.is_locked
                ? <StatusText icon={Lock} hue="green" className="!text-[12px]">Submitted</StatusText>
                : <StatusText icon={AlertCircle} hue="amber" className="!text-[12px]">Draft</StatusText>}
              {reportPopup.is_locked && reportPopup.submitted_at && (
                <>
                  <span className="text-[#D1D5DB]">·</span>
                  <span>
                    on {new Date(reportPopup.submitted_at).toLocaleString('en-GB', {
                      day: 'numeric', month: 'short', year: 'numeric',
                      hour: 'numeric', minute: '2-digit', hour12: true,
                    })}
                  </span>
                </>
              )}
              {(() => {
                // Per-day total: sum of per-row deltas (today's work only,
                // not cumulative across the carry-over chain).
                const totalSecs = (reportPopup.rows ?? []).reduce(
                  (s, r) => s + perDayElapsedSeconds(r, chartReports), 0,
                )
                return (
                  <>
                    <span className="text-[#D1D5DB]">·</span>
                    Today: <span className="font-semibold text-[#111827]">
                      {Math.round((totalSecs / 3600) * 10) / 10} hrs
                    </span>
                  </>
                )
              })()}
            </span>
          }
        >
          {!reportPopup.rows || reportPopup.rows.length === 0 ? (
            <EmptyState compact icon={FileText} title="No entries in this report." />
          ) : (
            <div className="overflow-x-auto -mx-5">
              <table className={cx(L.table, 'min-w-[520px]')}>
                <thead className={L.thead}>
                  <tr>
                    <th className={cx(L.th, 'w-8 !px-5')}>#</th>
                    <Th>Type of Work</Th>
                    <Th>Specific Work</Th>
                    <Th>Status</Th>
                    <Th className="!pr-5">Today</Th>
                  </tr>
                </thead>
                <tbody>
                  {reportPopup.rows.map(row => {
                    const perDaySecs = perDayElapsedSeconds(row, chartReports)
                    const isCarried = !!row.carried_over_from_row_id
                    return (
                      <tr key={row.id} className={L.trHover}>
                        <td className={cx(L.td, '!px-5 !text-[#9CA3AF] !align-top')}>{row.sr_no}</td>
                        <td className={cx(L.td, '!align-top')}>
                          <span>{row.type_of_work}</span>
                          {row.sub_category && <span className="block text-[12px] text-[#6B7280]">{row.sub_category}</span>}
                        </td>
                        <td className={cx(L.td, '!text-[#374151] !align-top')}>{row.specific_work}</td>
                        <td className={cx(L.td, '!align-top')}>
                          <StatusBadge status={row.stopwatch_status} lastPausedAt={row.last_paused_at} />
                          {isCarried && (
                            <div className="text-[11px] text-[#9CA3AF] mt-0.5">
                              Continued from a previous day
                            </div>
                          )}
                        </td>
                        <td className={cx(L.td, '!pr-5 font-medium whitespace-nowrap !align-top tabular-nums')}>
                          {perDaySecs === 0 && isCarried ? (
                            // Carried-over row with no new work today (or
                            // a historical row whose elapsed was reset by
                            // the wall-clock cap, so source == current).
                            <>
                              <span className="text-[#9CA3AF]">—</span>
                              <span className="block text-[11px] text-[#9CA3AF] font-normal">
                                no new work today
                              </span>
                              <span className="block text-[11px] text-[#9CA3AF] font-normal">
                                cumulative {elapsedToTimeTaken(row.elapsed_seconds)}
                              </span>
                            </>
                          ) : (
                            <>
                              {elapsedToTimeTaken(perDaySecs)}
                              {row.elapsed_seconds !== perDaySecs && (
                                <span className="block text-[11px] text-[#9CA3AF] font-normal">
                                  cumulative {elapsedToTimeTaken(row.elapsed_seconds)}
                                </span>
                              )}
                            </>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Modal>
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
    typeProjects: Record<string, number>
    subCatProjects: Record<string, Record<string, number>>
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

  const realPie = analytics
    ? Object.entries(analytics.typeHours).filter(([, v]) => v > 0).map(([name, value]) => ({ name, value }))
    : []
  const pieIsSample = realPie.length === 0
  const pieData = realPie
  // Full names, not first names: the bars are horizontal now, so there is
  // room to say who each one is instead of relying on a hover tooltip.
  const realCategoryRows = analytics
    ? Object.entries(analytics.subCatHours).flatMap(([cat, subs]) =>
        Object.entries(subs).map(([sub, hrs], si) => ({
          cat, sub, hours: hrs, projects: analytics.subCatProjects?.[cat]?.[sub] ?? 0, first: si === 0,
        })))
    : []
  const categoryIsSample = realCategoryRows.length === 0
  const categoryRows = realCategoryRows

  // Grouped and ranked. The flat list arrived in map order, so a 52h category
  // could sit below a 10h one and its sub-categories were in no order at all.
  // Categories sort by total and sub-categories by hours, the same rule the
  // donut uses — so rank N here is rank N there, and the colours line up.
  // Which categories have their sub-categories showing. Everything starts
  // collapsed: nine categories with every sub listed ran to some forty rows, so
  // the table was mostly scrolling past detail nobody had asked for. The
  // category totals are the summary; the subs are the drill-down.
  const [openCats, setOpenCats] = useState<Set<string>>(new Set())
  const toggleCat = (cat: string) => setOpenCats(prev => {
    const next = new Set(prev)
    if (!next.delete(cat)) next.add(cat)
    return next
  })

  const categoryGroups = useMemo(() => {
    const byCat = new Map<string, { cat: string; hours: number; projects: number; subs: { sub: string; hours: number; projects: number }[] }>()
    for (const r of categoryRows) {
      const g = byCat.get(r.cat) ?? { cat: r.cat, hours: 0, projects: 0, subs: [] }
      g.hours += r.hours
      g.projects += r.projects
      g.subs.push({ sub: r.sub, hours: r.hours, projects: r.projects })
      byCat.set(r.cat, g)
    }
    const groups = [...byCat.values()].sort((a, b) => b.hours - a.hours)
    for (const g of groups) g.subs.sort((a, b) => b.hours - a.hours)
    return groups
  }, [categoryRows])
  const categoryGrandTotal = categoryGroups.reduce((s, g) => s + g.hours, 0)

  return (
    <div className="space-y-4">
      {/* Filter bar */}
      <div className={cx(L.card, L.cardPad, 'flex items-center gap-3 flex-wrap')}>
        <Segmented<DateFilter>
          size="sm"
          className="flex-wrap"
          value={filter}
          onChange={setFilter}
          options={[
            { id: 'week', label: 'This Week' },
            { id: 'month', label: 'This Month' },
            { id: '3months', label: 'Last 3 Months' },
            { id: 'custom', label: 'Custom' },
          ]}
        />
        {filter === 'custom' && (
          <div className="flex items-center gap-2">
            <input type="date" value={customFrom} onChange={e => setCustomFrom(e.target.value)} className={cx(L.input, 'h-8 w-auto text-[12px]')} />
            <span className={L.meta}>–</span>
            <input type="date" value={customTo} onChange={e => setCustomTo(e.target.value)} className={cx(L.input, 'h-8 w-auto text-[12px]')} />
          </div>
        )}
      </div>

      {loading && <p className="text-[13px] text-[#6B7280] text-center py-10 animate-pulse">Loading analytics…</p>}

      {!loading && analytics && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Time Distribution */}
          <div className={cx(L.card, L.cardPad, 'relative flex flex-col')}>
            {pieIsSample
              ? <>
                  <h3 className={L.cardTitle}>Time Distribution</h3>
                  <EmptyState icon={BarChart2} title="No hours logged in this period"
                    body="Submit daily reports and each work type will claim its share of these squares." />
                </>
              : <TimeDistributionWaffle data={pieData} title="Time Distribution" />}
          </div>

          {/* Collaboration — the chart and the range control that used to be
              two separate cards asking the same question. */}
          <div className={cx(L.card, L.cardPad, 'flex flex-col')}>
            <CollaborationCard userId={userId} users={users} />
          </div>

          {/* Category Breakdown */}
          <Card
            className="lg:col-span-2"
            padded={false}
            icon={TrendingUp}
            title="Category Breakdown"
            action={categoryIsSample ? undefined : (
              <button
                type="button"
                onClick={() => setOpenCats(prev =>
                  prev.size === categoryGroups.length ? new Set() : new Set(categoryGroups.map(g => g.cat)))}
                className={TEXT_LINK}
              >
                {openCats.size === categoryGroups.length ? 'Collapse all' : 'Expand all'}
              </button>
            )}
          >
            {categoryIsSample ? (
              <EmptyState icon={TrendingUp} title="No categories to break down yet"
                body="Your reports are grouped here by type of work and sub-category once you start logging." />
            ) : (
            <div className="overflow-x-auto">
              <table className={cx(L.table, 'min-w-[620px]')}>
                {/* One indented name column plus right-aligned figures. */}
                <colgroup>
                  <col />
                  <col className="w-24" />
                  <col className="w-44" />
                  <col className="w-24" />
                </colgroup>
                <thead className={L.thead}>
                  <tr>
                    <Th>Category</Th>
                    <Th align="right">Hours</Th>
                    <Th align="right">Share</Th>
                    <Th align="right">Projects</Th>
                  </tr>
                </thead>
                <tbody>
                  {/* One project = one stopwatch row marked `finished` in the
                      window. A multi-day task counts exactly once, logged on
                      the day it was finished. */}
                  {categoryGroups.map((g, gi) => {
                    const color = CATEGORY_COLORS[gi % CATEGORY_COLORS.length]
                    const share = categoryGrandTotal > 0 ? (g.hours / categoryGrandTotal) * 100 : 0
                    const open = openCats.has(g.cat)
                    return (
                      <Fragment key={g.cat}>
                        {/* Group header — carries the category's own totals and
                            opens the sub-categories underneath it. */}
                        <tr className={cx(L.trHover, 'cursor-pointer')} onClick={() => toggleCat(g.cat)}>
                          <td className={L.td}>
                            <button
                              type="button"
                              aria-expanded={open}
                              // The row is the hit target; this is here so the
                              // control is reachable by keyboard and reads as
                              // a disclosure to a screen reader.
                              onClick={e => { e.stopPropagation(); toggleCat(g.cat) }}
                              className="flex items-center gap-2 min-w-0 w-full text-left cursor-pointer"
                            >
                              <ChevronDown
                                className={`w-3.5 h-3.5 shrink-0 text-[#9CA3AF] transition-transform duration-200 ${open ? '' : '-rotate-90'}`}
                                strokeWidth={1.75}
                              />
                              <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: color }} />
                              <span className="font-semibold text-[#111827] truncate" title={g.cat}>{g.cat}</span>
                              {/* Says what is hidden, so a collapsed row is
                                  still informative. */}
                              <span className="text-[11px] font-medium text-[#9CA3AF] shrink-0 tabular-nums">
                                {g.subs.length}
                              </span>
                            </button>
                          </td>
                          <td className={cx(L.td, 'text-right font-semibold tabular-nums')}>{fmtHours(g.hours)}</td>
                          <td className={L.td}>
                            <span className="flex items-center justify-end gap-2">
                              <span className="h-1.5 w-20 rounded-full bg-[#F3F4F6] overflow-hidden shrink-0">
                                <span className="block h-full rounded-full" style={{ width: `${Math.max(share, 2)}%`, background: color }} />
                              </span>
                              <span className="text-[12px] font-medium text-[#6B7280] tabular-nums w-9 text-right">{Math.round(share)}%</span>
                            </span>
                          </td>
                          <td className={cx(L.td, 'text-right font-semibold tabular-nums')}>{g.projects}</td>
                        </tr>
                        {open && g.subs.map(sc => {
                          const inCat = g.hours > 0 ? Math.round((sc.hours / g.hours) * 100) : 0
                          return (
                            <tr key={`${g.cat}-${sc.sub}`} className={cx(L.trHover, 'bg-[#F9FAFB]/60')}>
                              <td className={cx(L.td, '!py-2 !pl-[34px]')}>
                                {/* Rule tying the sub back to its group. */}
                                <span className="flex items-center gap-2 min-w-0 border-l border-[#C5CAD1] pl-3">
                                  <span className="text-[#374151] truncate" title={sc.sub || '—'}>{sc.sub || '—'}</span>
                                </span>
                              </td>
                              <td className={cx(L.td, '!py-2 text-right !text-[#374151] tabular-nums')}>{fmtHours(sc.hours)}</td>
                              <td className={cx(L.td, '!py-2 text-right text-[12px] !text-[#9CA3AF] tabular-nums')}>{inCat}% of {g.cat.split(' ')[0]}</td>
                              <td className={cx(L.td, '!py-2 text-right !text-[#6B7280] tabular-nums')}>{sc.projects}</td>
                            </tr>
                          )
                        })}
                      </Fragment>
                    )
                  })}
                </tbody>
              </table>
            </div>
            )}
          </Card>

        </div>
      )}
    </div>
  )
}

// ── Project Icon variants ──────────────────────────────────────────────────
function ProjectIcon({ index }: { index: number }) {
  const configs: { bg: string; svg: React.ReactNode }[] = [
    { bg: 'var(--nerve-primary-soft)', svg: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
        <rect x="3" y="6" width="18" height="3" rx="1.5" fill="var(--nerve-primary)"/>
        <rect x="3" y="11" width="13" height="3" rx="1.5" fill="var(--bp-400)"/>
        <rect x="3" y="16" width="8" height="3" rx="1.5" fill="var(--bp-300)"/>
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
    <div className="w-9 h-9 rounded-[6px] border border-[#C5CAD1] flex items-center justify-center shrink-0" style={{ background: c.bg }}>
      {c.svg}
    </div>
  )
}

// ── Submission heatmap ────────────────────────────────────────────────────

type HeatDay = {
  hours: number
  submitted: boolean
  rows: { type_of_work: string; sub_category: string; specific_work: string; time_taken: string }[]
}

// ── Daily Reports Page ─────────────────────────────────────────────────────

function DailyReportsPage({
  users,
  profile,
  reportVersion = 0,
}: {
  users: ReturnType<typeof useAppData>['users']
  profile: ReturnType<typeof useAuth>['profile']
  /** Bumped by the shell when a row is created from the header sheet, so this
   *  page re-reads the report even though it is already mounted. */
  reportVersion?: number
}) {
  const selectedDate = today()  // locked to today — no past/future submissions
  const [categories, setCategories] = useState<WorkCategory[]>([])
  const [report, setReport] = useState<DailyReport | null>(null)
  const [rows, setRows] = useState<DraftRow[]>([blankRow(1)])
  const [saving, setSaving] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  // Lead-authored feedback on individual rows; polled so comments left by the
  // lead appear without a full page reload.
  const [commentsByRow, setCommentsByRow] = useState<Record<string, ReportRowComment[]>>({})

  // ── Leave state ────────────────────────────────────────────────────────
  // datetime-local format: "YYYY-MM-DDTHH:mm" (no timezone)
  const defaultStart = `${today()}T09:00`
  const defaultEnd   = `${today()}T17:00`
  const [leaves, setLeaves] = useState<BrandingLeave[]>([])
  const [showLeaveModal, setShowLeaveModal] = useState(false)
  const [leaveStart, setLeaveStart] = useState(defaultStart)
  const [leaveEnd, setLeaveEnd] = useState(defaultEnd)
  const [leaveReason, setLeaveReason] = useState('')
  const [leaveTransferDate, setLeaveTransferDate] = useState('')
  const [leaveSubmitting, setLeaveSubmitting] = useState(false)

  // ── Projects state ─────────────────────────────────────────────────────
  const [projects, setProjects] = useState<BrandingProject[]>([])
  const [showAddProject, setShowAddProject] = useState(false)
  // Which project list the card is showing. Pending and Completed used to be
  // stacked inside one scroller, so the card carried two headings, two counts
  // and a scroll position that could come to rest between them.
  const [projectTab, setProjectTab] = useState<'pending' | 'completed'>('pending')
  const [projName, setProjName] = useState('')
  const [projDesc, setProjDesc] = useState('')
  const [projDeadline, setProjDeadline] = useState('')
  const [projType, setProjType] = useState('')
  const [projSubCat, setProjSubCat] = useState('')
  const [projSpecific, setProjSpecific] = useState('')
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
    brandingApi.getLeaves()
      .then(r => setLeaves(r.leaves))
      .catch(() => {})
  }, [])

  // Projects were fetched once on mount, so a project the lead assigned — or
  // a teammate finishing their half of one — never reached this page until a
  // reload. Polled on the same 30s cadence the dashboard's collab card uses.
  const reloadProjects = useCallback(() => {
    brandingApi.getProjects().then(r => setProjects(r.projects)).catch(() => {})
  }, [])
  useEffect(() => {
    reloadProjects()
    const id = setInterval(reloadProjects, 30_000)
    return () => clearInterval(id)
  }, [reloadProjects])

  // ── Row status, read from the Kanban card each row is tracked on ──────
  const BOARD_LABEL: Record<string, { label: string; hue: Hue }> = {
    notstarted: { label: 'Not started',      hue: 'grey' },
    inprogress: { label: 'In progress',      hue: 'blue' },
    review:     { label: 'Waiting for approval', hue: 'amber' },
    changes:    { label: 'Changes received', hue: 'red' },
    approved:   { label: 'Approved',         hue: 'violet' },
    delivered:  { label: 'Delivered',        hue: 'green' },
  }
  const cardById = useMemo(() => new Map(projects.map(p => [p.id, p])), [projects])
  // The timer decides the first three columns, so those are read straight
  // from the row and update the instant you press Start / Pause / Finish.
  // Anything past review (Changes received, Approved, Delivered) is the
  // lead's placement on the Kanban board and comes from the card.
  const LEAD_COLUMNS = ['changes', 'approved', 'delivered']
  const rowStatus = (row: ReportRow) => {
    if (!row.specific_work.trim()) return null
    const card = row.project_id ? cardById.get(row.project_id) : undefined
    if (card && LEAD_COLUMNS.includes(card.board_status)) return BOARD_LABEL[card.board_status]
    const col = row.stopwatch_status === 'running' ? 'inprogress'
      : row.stopwatch_status === 'finished' ? 'review'
      : 'notstarted'
    return BOARD_LABEL[col]
  }

  // ── Report history ─────────────────────────────────────────────────────
  // The table above is locked to today, so every earlier day was unreachable
  // from this page. Six months is the window: long enough to cover an
  // appraisal cycle, short enough that the month filter stays a short list.
  const [history, setHistory] = useState<DailyReport[]>([])
  const [histQuery, setHistQuery] = useState('')
  const [histStatus, setHistStatus] = useState<'all' | 'submitted' | 'draft'>('all')
  const [histMonth, setHistMonth] = useState('all')
  const [histView, setHistView] = useState<DailyReport | null>(null)
  // Six months is over a hundred rows. The page shows a screenful and grows
  // on demand rather than pushing everything below it off the bottom.
  const HIST_PAGE = 10
  const [histShown, setHistShown] = useState(HIST_PAGE)

  useEffect(() => {
    if (!profile?.id) return
    const from = new Date()
    from.setDate(from.getDate() - 180)
    brandingApi.getAllReports({ userId: profile.id, dateFrom: fmtDate(from), dateTo: today() })
      .then(r => setHistory(r.reports))
      .catch(() => {})
    // Re-read when today's report changes identity or gets filed, so the top
    // row of the history matches the table above it.
  }, [profile?.id, reportVersion, report?.id, report?.is_locked])

  /** A day's headline: the work type it spent the most hours on. */
  const histLabel = (rep: DailyReport) => {
    const byType: Record<string, number> = {}
    for (const row of rep.rows ?? [])
      byType[row.type_of_work || 'Other'] = (byType[row.type_of_work || 'Other'] ?? 0) + timeToHours(row.time_taken)
    const top = Object.entries(byType).sort((a, b) => b[1] - a[1])[0]
    return top ? top[0] : 'No entries'
  }
  /** The sub-line: what was actually done. Capped at two, because a full
   *  eight-hour day can carry five entries and the cell is one line. */
  const histSummary = (rep: DailyReport) => {
    const seen = new Set<string>()
    for (const row of rep.rows ?? []) {
      const t = (row.specific_work || row.sub_category || '').trim()
      if (t) seen.add(t)
    }
    const all = [...seen]
    if (all.length <= 2) return all.join(' · ')
    return `${all.slice(0, 2).join(' · ')} · +${all.length - 2} more`
  }
  const histHours = (rep: DailyReport) =>
    (rep.rows ?? []).reduce((sum, row) => sum + timeToHours(row.time_taken), 0)

  // Only the months that actually have reports — an empty "March" in the
  // dropdown is a dead end.
  const histMonths = useMemo(() => {
    const keys = [...new Set(history.map(r => r.report_date.slice(0, 7)))].sort().reverse()
    return keys.map(k => ({
      key: k,
      label: parseDateLocal(`${k}-01`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }),
    }))
  }, [history])

  const filteredHistory = useMemo(() => {
    const q = histQuery.trim().toLowerCase()
    return history
      .filter(rep => {
        if (histStatus === 'submitted' && !rep.is_locked) return false
        if (histStatus === 'draft' && rep.is_locked) return false
        if (histMonth !== 'all' && !rep.report_date.startsWith(histMonth)) return false
        if (!q) return true
        const hay = [
          rep.report_date,
          parseDateLocal(rep.report_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }),
          ...(rep.rows ?? []).flatMap(r => [r.type_of_work, r.sub_category, r.specific_work]),
        ].join(' ').toLowerCase()
        return hay.includes(q)
      })
      .sort((a, b) => b.report_date.localeCompare(a.report_date))
  }, [history, histQuery, histStatus, histMonth])

  // A narrowed list starts from the top again — otherwise a search could
  // return eight results while the page still claims to be showing forty.
  useEffect(() => { setHistShown(HIST_PAGE) }, [histQuery, histStatus, histMonth])

  const visibleHistory = filteredHistory.slice(0, histShown)

  function resetProjectForm() {
    setProjName(''); setProjDesc(''); setProjDeadline('')
    setProjType(''); setProjSubCat(''); setProjSpecific('')
  }

  async function addProject() {
    if (!projName.trim()) { toast.error('Project name is required.'); return }
    if (!projType) { toast.error('Type of work is required.'); return }
    if (!projSubCat) { toast.error('Sub-category is required.'); return }
    if (!projSpecific.trim()) { toast.error('Specific work is required.'); return }
    setProjSaving(true)
    try {
      const res = await brandingApi.createProject({
        name: projName.trim(),
        description: projDesc.trim() || undefined,
        deadline: projDeadline || undefined,
        type_of_work: projType,
        sub_category: projSubCat,
        specific_work: projSpecific.trim(),
      })
      setProjects(prev => [res.project, ...prev])
      resetProjectForm()
      setShowAddProject(false)
      toast.success('Project created!')
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to create project') }
    finally { setProjSaving(false) }
  }

  // The assignee marks their own copy of a project complete (req 6). Updates
  // the project in place with the returned per-assignment statuses.
  async function markProjectComplete(projectId: string) {
    try {
      const { project } = await brandingApi.completeProject(projectId)
      setProjects(prev => prev.map(p => p.id === project.id ? project : p))
      toast.success('Marked as completed!')
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to update project') }
  }

  // id → display name for showing assigned designers / lead on project cards.
  const projectUserName = (id: string | null) =>
    id ? (users.find(u => u.id === id)?.full_name || users.find(u => u.id === id)?.email || 'Unknown') : ''

  const pendingProjects = projects.filter(p => myProjectStatus(p, profile?.id) === 'pending')
  const completedProjects = projects.filter(p => myProjectStatus(p, profile?.id) === 'completed')

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
            stopwatch_status: row.stopwatch_status,
            elapsed_seconds: row.elapsed_seconds,
            stopwatch_started_at: row.stopwatch_started_at,
            carried_over_from_row_id: row.carried_over_from_row_id,
        project_id: row.project_id ?? null,
            last_paused_at: row.last_paused_at,
          })))
        } else if (!r.report.is_locked) {
          setRows([blankRow(1)])
        }
      })
      .catch(() => toast.error('Failed to load report'))
    // reportVersion is the shell's signal that it wrote a row from the header
    // sheet; re-reading is how that row reaches this table.
  }, [selectedDate, reportVersion])

  // Poll comments left by the lead on this report's rows. We track the saved
  // row IDs (from `report.rows`), not the in-progress drafts, since comments
  // only exist on persisted rows.
  const persistedRowIds = useMemo(
    () => (report?.rows ?? []).map(r => r.id).join(','),
    [report?.rows],
  )
  useEffect(() => {
    const ids = persistedRowIds ? persistedRowIds.split(',').filter(Boolean) : []
    if (ids.length === 0) { setCommentsByRow({}); return }
    let cancelled = false
    const load = () => {
      brandingApi.getRowComments(ids)
        .then(({ comments }) => {
          if (cancelled) return
          const grouped: Record<string, ReportRowComment[]> = {}
          for (const c of comments) (grouped[c.row_id] ??= []).push(c)
          setCommentsByRow(grouped)
        })
        .catch(() => {})
    }
    load()
    const timer = setInterval(load, 30_000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [persistedRowIds])

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

  // Stopwatch helpers — patch a single row and persist atomically so teammates
  // see live state. Use a ref to avoid the React-state race between setRows
  // and the immediate save call.
  const rowsRef = useRef<DraftRow[]>(rows)
  useEffect(() => { rowsRef.current = rows }, [rows])

  function rowPayload(r: DraftRow) {
    return {
      sr_no: r.sr_no, type_of_work: r.type_of_work, sub_category: r.sub_category,
      specific_work: r.specific_work, time_taken: r.time_taken,
      collaborative_colleagues: r.collaborative_colleagues,
      stopwatch_status: r.stopwatch_status,
      elapsed_seconds: r.elapsed_seconds,
      stopwatch_started_at: r.stopwatch_started_at,
      carried_over_from_row_id: r.carried_over_from_row_id,
      last_paused_at: r.last_paused_at,
      project_id: r.project_id ?? null,
    }
  }

  async function applyRowPatch(key: string, patch: Partial<DraftRow>) {
    // Row timers are independent and any number of them may run at once. Real
    // work overlaps — a render going in the background while a poster is being
    // laid out — and forcing one at a time meant that time was either lost or
    // logged against the wrong row.
    //
    // Nothing here has to arbitrate: each row carries its own
    // stopwatch_started_at and its elapsed time is derived from that alone. The
    // server stores them the same way, and the 5 PM auto-pause and the submit
    // snapshot already walk every running row rather than assuming a single one.
    const next = rowsRef.current.map(r => (r._key === key ? { ...r, ...patch } : r))
    rowsRef.current = next
    setRows(next)
    if (!report || report.is_locked) return
    try {
      await brandingApi.saveRows(report.id, next.map(rowPayload))
      reloadProjects()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save stopwatch state')
    }
  }

  const addRow = () => setRows(prev => [...prev, blankRow(prev.length + 1)])
  const deleteRow = (key: string) =>
    setRows(prev => prev.filter(r => r._key !== key).map((r, i) => ({ ...r, sr_no: i + 1 })))

  async function saveDraft() {
    if (!report || report.is_locked) return
    setSaving(true)
    try {
      await brandingApi.saveRows(report.id, rows.map(rowPayload))
      reloadProjects()
      toast.success('Draft saved')
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to save') }
    finally { setSaving(false) }
  }

  async function submitReport() {
    if (!report || report.is_locked) return
    if (rows.length === 0) { toast.error('Add at least one row before submitting.'); return }
    // Block on missing core fields, but allow unfinished stopwatches.
    const invalid = rows.filter(r => !r.type_of_work || !r.sub_category || !r.specific_work)
    if (invalid.length > 0) {
      toast.error('Please fill type, sub-category, and description for every row.')
      return
    }
    // At submit time:
    //   - running rows → snapshot to PAUSED with their actual elapsed time
    //   - paused rows  → keep paused, refresh time_taken from elapsed_seconds
    //   - finished/idle → keep, but make sure time_taken reflects elapsed_seconds
    // Paused rows get picked up by the server's carryOverPausedRows on tomorrow's
    // getOrCreateDailyReport so the unfinished entry reappears in the next day's draft.
    const now = Date.now()
    const nowIso = new Date(now).toISOString()
    const finalisedRows: DraftRow[] = rows.map(r => {
      if (r.stopwatch_status === 'running' && r.stopwatch_started_at) {
        const rawSince = Math.max(0, Math.floor((now - new Date(r.stopwatch_started_at).getTime()) / 1000))
        const since = Math.min(rawSince, MAX_STOPWATCH_SINCE_SECONDS)
        const captured = r.elapsed_seconds + since
        return {
          ...r,
          stopwatch_status: 'paused',
          elapsed_seconds: captured,
          stopwatch_started_at: null,
          last_paused_at: nowIso,
          time_taken: elapsedToTimeTaken(captured),
        }
      }
      // For paused: always re-derive time_taken from elapsed_seconds so the
      // locked report shows the exact paused-at duration (e.g. "2m 15s"), not "0m".
      if (r.stopwatch_status === 'paused') {
        return { ...r, time_taken: elapsedToTimeTaken(r.elapsed_seconds) }
      }
      // Finished rows already have their time_taken set when Finish was clicked.
      // Idle rows fall back to their elapsed (usually 0) so the column has something.
      if (!r.time_taken) {
        return { ...r, time_taken: elapsedToTimeTaken(r.elapsed_seconds) }
      }
      return r
    })
    setRows(finalisedRows)
    rowsRef.current = finalisedRows
    setSubmitting(true)
    try {
      await brandingApi.saveRows(report.id, finalisedRows.map(rowPayload))
      reloadProjects()
      const res = await brandingApi.submitReport(report.id)
      setReport(res.report)
      const carryCount = finalisedRows.filter(r => r.stopwatch_status === 'paused').length
      toast.success(carryCount > 0
        ? `Report submitted. ${carryCount} unfinished ${carryCount === 1 ? 'row will' : 'rows will'} carry over to tomorrow.`
        : 'Report submitted and locked!')
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to submit') }
    finally { setSubmitting(false) }
  }

  async function applyForLeave() {
    if (!leaveStart || !leaveEnd) { toast.error('Select both start and end date/time.'); return }
    if (new Date(leaveEnd) <= new Date(leaveStart)) { toast.error('End must be after start.'); return }
    if (!leaveReason.trim()) { toast.error('Please provide a reason.'); return }
    setLeaveSubmitting(true)
    try {
      const res = await brandingApi.applyLeave({
        start_at: new Date(leaveStart).toISOString(),
        end_at: new Date(leaveEnd).toISOString(),
        reason: leaveReason.trim(),
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


  const todayLeave = leaves.find(l => l.leave_date === selectedDate)
  // Half-day approved leave still requires a report for the working half.
  const isFullDayApprovedLeave = todayLeave?.status === 'approved' && !todayLeave.is_half_day
  const isHalfDayApprovedLeave = todayLeave?.status === 'approved' && todayLeave.is_half_day

  const displayRows = report?.is_locked ? report.rows : rows

  // Finish is final, so a row only ever travels one way. Anything still idle,
  // running or paused is open work and stays in the upper section; a finished
  // stopwatch drops the row into the completed one, which is where the day is
  // filed from.
  const openRows = displayRows.filter(r => r.stopwatch_status !== 'finished')
  const doneRows = displayRows.filter(r => r.stopwatch_status === 'finished')

  // The five editable controls for one report row. Defined once and rendered
  // by both the desktop table and the phone card list so the two can't drift.
  type ReportRow = DraftRow | import('@/lib/branding-types').DailyReportRow
  const rowFields = (row: ReportRow, isLocked: boolean) => {
    const subs = subCatOptions(row.type_of_work)
    // Free-text mode for the sub-category. This used to key off the value being
    // exactly the string "Others", which meant the field flipped back to a
    // <select> — discarding the entry — the moment the first character was
    // typed. Anything that is not one of the listed options counts as a custom
    // value instead, so a half-typed entry stays editable.
    const knownSubs = subs.map(x => x.name)
    const othersName = subs.find(x => x.is_others)?.name ?? ''
    const isOthersPlaceholder = othersName !== '' && row.sub_category === othersName
    const showSubText =
      row.type_of_work === 'Others' ||
      isOthersPlaceholder ||
      (subs.length > 0 && row.sub_category !== '' && !knownSubs.includes(row.sub_category))
    const k = (row as DraftRow)._key
    return {
      type_of_work: isLocked
        ? <span className="text-[13px] text-[#111827]">{row.type_of_work || '—'}</span>
        : <select value={row.type_of_work} onChange={e => updateRow(k, 'type_of_work', e.target.value)} className={SEL_CELL} title={row.type_of_work || undefined}>
            <option value="">Select…</option>
            {categories.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
          </select>,
      sub_category: isLocked
        ? <span className="text-[13px] text-[#111827]">{row.sub_category || '—'}</span>
        : showSubText
        // Picking "Others" stores that literal as the value, which would
        // otherwise sit in the box and get typed in front of. Show it as empty
        // so the placeholder leads, and fall back to it when cleared so the
        // field does not snap shut mid-edit.
        ? <input
            value={isOthersPlaceholder ? '' : row.sub_category}
            onChange={e => updateRow(k, 'sub_category', e.target.value === '' ? (othersName || '') : e.target.value)}
            placeholder="Type sub category…" className={INP_CELL} />
        : <select value={row.sub_category} onChange={e => updateRow(k, 'sub_category', e.target.value)} className={SEL_CELL} title={row.sub_category || undefined}>
            <option value="">Select…</option>
            {subs.map(s => <option key={s.id} value={s.name}>{s.name}</option>)}
          </select>,
      specific_work: isLocked
        ? <span className="text-[13px] text-[#111827]">{row.specific_work || '—'}</span>
        // Clipped text was unrecoverable before — title makes the full line reachable.
        : <input value={row.specific_work} onChange={e => updateRow(k, 'specific_work', e.target.value)} placeholder="Describe the work done…" className={INP_CELL} title={row.specific_work || undefined} />,
      time_tracker: <StopwatchCell
        row={row as DraftRow}
        disabled={isLocked}
        canStart={!!(row.type_of_work && row.sub_category && row.specific_work)}
        onAction={patch => applyRowPatch(k, patch)}
      />,
      collaborative_colleagues: isLocked
        ? <span className="text-[13px] text-[#6B7280]">
            {row.collaborative_colleagues.length === 0 ? '—'
              : row.collaborative_colleagues.map(id => colleagueOptions.find(o => o.id === id)?.label || id).join(', ')}
          </span>
        : <ColleaguesSelect options={colleagueOptions} value={row.collaborative_colleagues}
            onChange={v => updateRow(k, 'collaborative_colleagues', v)} />,
    }
  }
  // Per-section totals: time banked on work still open, and time being filed.
  // "N hr so far" on the In Progress header has the same problem the
  // dashboard's Today's Hours had: an open row's time lives on its stopwatch,
  // not in `time_taken`, so the header read 0 while the timers ran.
  const openHours = openRows.reduce((s, r) => s + rowHoursNow(r), 0)
  const doneHours = doneRows.reduce((s, r) => s + timeToHours(r.time_taken), 0)

  /* One table, rendered twice — once for work still open, once for work
     finished. A helper rather than a copy, so the two sections cannot drift
     apart: same columns, same controls, same comment threads. */
  const renderRowsTable = (sectionRows: ReportRow[], empty: string) => (
    <>
        <div className="overflow-x-auto hidden md:block">
          <table className={cx(L.table, 'border-collapse min-w-[1000px]')}>
            {/* Explicit widths: Specific Work was the widest field but the
                narrowest column, so every description was clipped. Time Tracker
                gets the most room of the inputs — its paused state carries three
                controls (elapsed, Resume, Finish) and overlapped the next column
                at anything narrower. */}
            <colgroup>
              <col className="w-12" />
              <col className="w-[15%]" />
              <col className="w-[13%]" />
              <col className="w-[20%]" />
              <col className="w-[14%]" />
              <col className="w-[24%]" />
              <col className="w-[9%]" />
              {!report?.is_locked && <col className="w-10" />}
            </colgroup>
            <thead className={L.thead}>
              <tr>
                {[
                  { label: 'Sr.', req: false },
                  { label: 'Type of Work', req: true },
                  { label: 'Sub Category', req: true },
                  { label: 'Specific Work', req: true },
                  { label: 'Collaborative Work', req: false },
                  { label: 'Time Tracker', req: true },
                  { label: 'Status', req: false },
                ].map(h => (
                  <th key={h.label} className={cx(L.th, 'uppercase tracking-[0.06em] !text-[11px] !px-3 first:text-center')}>
                    {h.label}
                    {h.req && <span className="text-[#DC2626] ml-0.5" title="Required">*</span>}
                  </th>
                ))}
                {!report?.is_locked && <th className="w-10" />}
              </tr>
            </thead>
            <tbody>
              {sectionRows.length === 0 && (
                <tr>
                  <td colSpan={8} className="text-center text-[13px] text-[#6B7280] py-10 px-4 border-t border-[#C5CAD1]">
                    {empty}
                  </td>
                </tr>
              )}
              {sectionRows.map(row => {
                const isLocked = report?.is_locked
                // A finished row is locked in: its duration is banked and its
                // card is waiting for approval, so the fields turn read-only
                // and the delete control goes away.
                const isFinished = row.stopwatch_status === 'finished'
                const key = (row as DraftRow)._key || (row as import('@/lib/branding-types').DailyReportRow).id
                // Comments only attach to persisted rows. `_key` for draft rows
                // is the persisted id once saved; for brand-new local rows it's
                // a temporary id that won't match anything in commentsByRow.
                const rowComments = commentsByRow[key] ?? []
                const colCount = isLocked ? 7 : 8
                const fields = rowFields(row, !!isLocked || isFinished)
                const isRunning = row.stopwatch_status === 'running'
                const hasComments = rowComments.length > 0
                const cell = cx('px-1.5 py-2 align-middle', !hasComments && 'border-t border-[#C5CAD1]')

                return (
                  <Fragment key={key}>
                  {/* A single hover tint plus a left accent on the row whose
                      stopwatch is running is easier to scan than zebra stripes. */}
                  <tr className={cx('group transition-colors', isRunning ? 'bg-[var(--nerve-primary-soft)] shadow-[inset_3px_0_0_0_var(--nerve-primary)]' : L.trHover)}>
                    <td className={cx('px-3 py-2 text-[12px] text-[#9CA3AF] text-center tabular-nums align-middle', 'border-t border-[#C5CAD1]')}>{row.sr_no}</td>

                    <td className={cx(cell, 'border-t border-[#C5CAD1]')}>{fields.type_of_work}</td>

                    <td className={cx(cell, 'border-t border-[#C5CAD1]')}>{fields.sub_category}</td>

                    <td className={cx(cell, 'border-t border-[#C5CAD1]')}>{fields.specific_work}</td>

                    <td className={cx(cell, 'border-t border-[#C5CAD1]')}>{fields.collaborative_colleagues}</td>

                    <td className={cx(cell, 'border-t border-[#C5CAD1] min-w-[236px] whitespace-nowrap')}>{fields.time_tracker}</td>

                    <td className={cx(cell, 'border-t border-[#C5CAD1] whitespace-nowrap')}>
                      {(() => { const st = rowStatus(row); return st ? <Badge hue={st.hue} dot>{st.label}</Badge> : <span className="text-[12px] text-[#9CA3AF]">—</span> })()}
                    </td>

                    {!isLocked && (
                      <td className="px-2 py-2 align-middle border-t border-[#C5CAD1]">
                        {/* Visible on focus as well as hover, so it is reachable
                            by keyboard rather than pointer-only. */}
                        {!isFinished && <button type="button" onClick={() => deleteRow((row as DraftRow)._key)}
                          title="Delete this row" aria-label={`Delete row ${row.sr_no}`}
                          className="opacity-0 group-hover:opacity-100 focus:opacity-100 p-1.5 rounded-[5px] text-[#9CA3AF] hover:text-[#DC2626] hover:bg-[#FEF2F2] focus:outline-none focus:ring-2 focus:ring-[#FECACA] transition-all cursor-pointer">
                          <Trash2 className="w-3.5 h-3.5" strokeWidth={1.75} />
                        </button>}
                      </td>
                    )}
                  </tr>
                  {hasComments && (
                    /* Reads as a reply thread hanging off its row — indented and
                       rule-tied to the row above — rather than a full-width
                       band that looked like another record. */
                    <tr className={isRunning ? 'bg-[var(--nerve-primary-soft)]' : ''}>
                      <td colSpan={colCount} className="px-3 pb-3 pt-0">
                        <div className="ml-12 border-l-2 border-[#C5CAD1] pl-3 space-y-1.5">
                          {rowComments.map(c => (
                            <div key={c.id} className="flex items-start gap-2">
                              <MessageCircle className="w-3.5 h-3.5 mt-[3px] shrink-0 text-[#9CA3AF]" strokeWidth={1.75} />
                              <div className="min-w-0">
                                <p className="text-[11px] leading-tight">
                                  <span className="font-semibold text-[#111827]">{c.author_name}</span>
                                  <span className="text-[#9CA3AF] font-normal ml-1.5">
                                    {new Date(c.created_at).toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}
                                  </span>
                                </p>
                                <p className="text-[12px] text-[#374151] whitespace-pre-wrap break-words mt-0.5">{c.body}</p>
                              </div>
                            </div>
                          ))}
                        </div>
                      </td>
                    </tr>
                  )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
        {/* Phone layout — the same controls stacked as one card per row, so a
            900px-wide table never has to be scrolled sideways on a handset. */}
        <div className="md:hidden divide-y divide-[#C5CAD1] border-t border-[#C5CAD1]">
          {sectionRows.length === 0 && (
            <p className="text-center text-[13px] text-[#6B7280] py-10 px-4">
              {empty}
            </p>
          )}
          {sectionRows.map(row => {
            const isLocked = !!report?.is_locked
            const isFinished = row.stopwatch_status === 'finished'
            const key = (row as DraftRow)._key || (row as import('@/lib/branding-types').DailyReportRow).id
            const fields = rowFields(row, isLocked || isFinished)
            const rowComments = commentsByRow[key] ?? []
            return (
              <div key={key} className="p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-2">
                    <span className={L.eyebrow}>Row {row.sr_no}</span>
                    {(() => { const st = rowStatus(row); return st ? <Badge hue={st.hue} dot>{st.label}</Badge> : null })()}
                  </span>
                  {!isLocked && !isFinished && (
                    <button type="button" onClick={() => deleteRow((row as DraftRow)._key)}
                      className="p-1.5 -mr-1.5 rounded-[5px] text-[#9CA3AF] hover:text-[#DC2626] hover:bg-[#FEF2F2] transition-colors cursor-pointer"
                      aria-label={`Delete row ${row.sr_no}`}>
                      <Trash2 className="w-4 h-4" strokeWidth={1.75} />
                    </button>
                  )}
                </div>
                {([
                  ['Type of Work *', fields.type_of_work],
                  ['Sub Category *', fields.sub_category],
                  ['Specific Work *', fields.specific_work],
                  ['Collaborative Work', fields.collaborative_colleagues],
                  ['Time Tracker *', fields.time_tracker],
                ] as const).map(([label, control]) => (
                  <div key={label}>
                    <p className={cx(L.eyebrow, 'mb-1')}>{label}</p>
                    {/* No wrapper box: editable controls carry their own border,
                        and read-only values read as plain text under the label. */}
                    {control}
                  </div>
                ))}
                {rowComments.length > 0 && (
                  <ul className="space-y-1.5 pt-1">
                    {rowComments.map(c => (
                      <li key={c.id} className="rounded-[6px] bg-[#F9FAFB] border border-[#C5CAD1] px-3 py-2">
                        <p className="text-[11px] font-semibold text-[#111827]">
                          {c.author_name}
                          <span className="text-[#9CA3AF] font-normal ml-1.5">
                            {new Date(c.created_at).toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}
                          </span>
                        </p>
                        <p className="text-[12px] text-[#374151] whitespace-pre-wrap break-words">{c.body}</p>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )
          })}
        </div>
    </>
  )

  const visibleProjects = projectTab === 'pending' ? pendingProjects : completedProjects

  // Counts behind the progress gauge.
  //
  // These used to read the project-wide `status`, while the Projects list
  // immediately to the left reads `myProjectStatus` — your own assignment.
  // The two disagree whenever a project has a second assignee: finishing your
  // half moves the row into the Completed tab but leaves the project 'active'
  // until everyone is done, so the gauge sat still while the list beside it
  // moved. On the live data that read "Pending 0 / Completed 14" next to a
  // gauge claiming 10 of 14 delivered. Both cards now answer the same
  // question — how much of MY work is done — so a click moves both.
  //
  // On hold stays project-wide, because there is no per-assignee hold: it is
  // the project that is paused. It is only counted when your part is still
  // open, so a hold can never contradict your own Completed count.
  const doneCount = projects.filter(p => myProjectStatus(p, profile?.id) === 'completed').length
  const holdCount = projects.filter(p =>
    p.status === 'on_hold' && myProjectStatus(p, profile?.id) !== 'completed').length
  const trackedCount = projects.length
  const activeCount = Math.max(0, trackedCount - doneCount - holdCount)
  const sharePct = (n: number) => (trackedCount ? Math.round((n / trackedCount) * 100) : 0)
  // The soonest deadline still outstanding — the one thing a reader of this
  // card actually has to act on. Outstanding for YOU, matching the counts
  // above: a project you have finished is not yours to chase.
  const nextDue = projects
    .filter(p => myProjectStatus(p, profile?.id) !== 'completed' && p.deadline)
    .sort((a, b) => (a.deadline || '').localeCompare(b.deadline || ''))[0]

  // "Nov 5", and the year only when it isn't this one — on a list where every
  // deadline falls in the current year, ", 2026" eight times over is eight
  // repetitions of something the reader already knows.
  const shortDate = (iso: string) => {
    const d = new Date(iso)
    return d.toLocaleDateString('en-US', d.getFullYear() === new Date().getFullYear()
      ? { month: 'short', day: 'numeric' }
      : { month: 'short', day: 'numeric', year: 'numeric' })
  }
  const daysUntil = (iso: string) => {
    const d = new Date(iso); d.setHours(0, 0, 0, 0)
    const today = new Date(); today.setHours(0, 0, 0, 0)
    return Math.round((d.getTime() - today.getTime()) / 86400000)
  }

  return (
    <div className="space-y-4">
      {/* Today's report leads the page: it is the thing this page exists for
          and the only part of it with a deadline. Projects and Leave are
          reference, so they follow. */}
      {/* On Leave banner — shown instead of (full-day) or above (half-day) the report form */}
      {todayLeave?.status === 'approved' && (
        <div className="bg-[#ECFDF5] border border-[#D1FAE5] rounded-[6px] p-4 text-center space-y-2">
          <p className="text-2xl">🏖️</p>
          <p className="text-[14px] font-semibold text-[#065F46]">
            {isHalfDayApprovedLeave
              ? `You are on approved ${todayLeave.half_day_period === 'first' ? 'first-half' : 'second-half'} leave today`
              : 'You are on approved leave today'}
          </p>
          <p className="text-[13px] text-[#047857]">
            {isHalfDayApprovedLeave
              ? `Submit a report for the working half. Window: ${new Date(todayLeave.start_at).toLocaleString([], { hour: 'numeric', minute: '2-digit', hour12: true })} – ${new Date(todayLeave.end_at).toLocaleString([], { hour: 'numeric', minute: '2-digit', hour12: true })}.`
              : `No report submission required for ${selectedDate}.`}
          </p>
          {todayLeave.transfer_date && (
            <p className="text-[12px] text-[#6B7280] mt-1">
              Transfer day: <span className="font-semibold text-[#065F46]">{todayLeave.transfer_date}</span>
            </p>
          )}
          <p className="text-[12px] text-[#9CA3AF] mt-2 italic">Reason: {todayLeave.reason || '—'}</p>
        </div>
      )}

      {/* Today's report, in two sections split by whether the work is done.
          Open work stays up top so it can be picked up again tomorrow;
          finished work drops below, where the Submit button lives — you file
          the day from the pile of things you actually finished. */}
      {!isFullDayApprovedLeave && (
      <div className="space-y-4" id="todays-report">

      {/* Once the day is filed there is nothing to pick up, so an empty open
          section would just be a header over a blank table. A filed report
          that still has paused rows keeps the section, because those rows are
          what reopens tomorrow. */}
      {(!report?.is_locked || openRows.length > 0) && (
      <div className={cx(L.card, 'overflow-hidden')}>
        <div className="px-4 py-3 flex items-baseline justify-between gap-3 flex-wrap bg-[var(--nerve-primary)]">
          <h3 className={cx(L.cardTitle, '!text-[var(--nerve-on-primary)]')}>
            In Progress
          </h3>
          <p className={cx(L.meta, '!text-[var(--nerve-on-primary-muted)]')}>
            {report?.is_locked
              ? 'Saved as paused — these reopen in tomorrow’s draft.'
              : 'Hit Finish on a row to move it down to Completed.'}
          </p>
        </div>

        {renderRowsTable(openRows, 'Nothing in progress. Add a row to start tracking work.')}

        <div className="px-4 py-2.5 bg-[#F9FAFB] border-t border-[#C5CAD1] flex items-center justify-between flex-wrap gap-2">
          {!report?.is_locked ? (
            <button type="button" onClick={addRow} className={cx(L.btn, L.btnPrimary, L.btnSm)}>
              <Plus className="w-3.5 h-3.5" strokeWidth={1.75} /> Add new report
            </button>
          ) : <span />}
          <span className={L.meta}>
            {openRows.length} {openRows.length === 1 ? 'row' : 'rows'}
            {openHours > 0 && ` · ${fmtHours(openHours)} so far`}
          </span>
        </div>
      </div>
      )}

      <div className={L.card}>
        <div className="bg-[var(--nerve-primary)] rounded-t-[5px] px-4 py-3 flex items-baseline justify-between gap-3 flex-wrap">
          <h3 className={cx(L.cardTitle, '!text-[var(--nerve-on-primary)]')}>
            Completed
          </h3>
          {doneHours > 0 && (
            <p className={cx(L.meta, 'tabular-nums')}>
              {fmtHours(doneHours)} logged
            </p>
          )}
        </div>

        {renderRowsTable(doneRows, report?.is_locked
          ? 'No work was marked finished on this report.'
          : 'Nothing finished yet. Rows land here when you hit Finish.')}

        {/* Actions, then the rules. The button that commits the day sits with
            the completed work rather than under the whole table, so what you
            are filing is the thing directly above it. */}
        {!report?.is_locked && (
        <div className="relative px-4 py-4 border-t border-[#C5CAD1]">
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => void saveDraft()} disabled={saving} className={cx(L.btn, L.btnSecondary)}>
              {saving ? 'Saving…' : 'Save Draft'}
            </button>
            <button type="button" onClick={() => void submitReport()} disabled={submitting} className={cx(L.btn, L.btnPrimary)}>
              <Send className="w-4 h-4" strokeWidth={1.75} />
              {submitting ? 'Submitting…' : 'Submit Report'}
            </button>

            {/* The submission rules live behind an info icon: hover (or focus,
                for the keyboard) opens them in the empty footer space to the
                right of the icon; on phones, above it. */}
            <span className="xl:relative group inline-flex items-center">
              <button
                type="button"
                className={cx(L.iconBtnSm, '!border-[var(--nerve-primary-soft-border)] !text-[var(--nerve-primary-text)] hover:!bg-[var(--nerve-primary-soft)]')}
                aria-label="Submission rules"
                aria-describedby="submit-rules"
              >
                <Info className="w-4 h-4" strokeWidth={1.75} />
              </button>
              <div
                id="submit-rules"
                role="tooltip"
                className="pointer-events-none absolute z-30 bg-white border border-[#C5CAD1] rounded-[6px] shadow-[0_12px_32px_-8px_rgba(16,24,40,0.25)] p-2.5 left-4 right-4 bottom-full mb-2 xl:right-auto xl:left-full xl:bottom-auto xl:top-1/2 xl:mb-0 xl:ml-3 xl:-translate-y-1/2 xl:w-[calc(100vw-38rem)] xl:max-w-[1000px] opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100"
              >
                <p className="text-[12px] xl:text-[11.5px] leading-snug text-[#DC2626]">
                  <span className="font-semibold text-[#B91C1C]">Once submitted, the report cannot be edited.</span>{' '}
                  {selectedDate === today() && (
                    <>
                      Running stopwatches auto-pause at 5:00 PM IST and editing closes at 9:00 PM IST &mdash;
                      if you're still working past 5 PM, hit Continue to resume. Anything unsubmitted is
                      filed and locked at 9 PM, with a running stopwatch snapshotted as paused so
                      unfinished work carries over to tomorrow.
                    </>
                  )}
                </p>
                {openRows.length > 0 && (
                  <p className="mt-1 text-[12px] xl:text-[11.5px] leading-snug text-[#6B7280]">
                    Submitting files the whole day. The {openRows.length} row
                    {openRows.length === 1 ? '' : 's'} still in progress {openRows.length === 1 ? 'is' : 'are'}{' '}
                    saved as paused and {openRows.length === 1 ? 'reopens' : 'reopen'} in tomorrow's draft.
                  </p>
                )}
              </div>
            </span>
          </div>
        </div>
      )}
      </div>

      </div>


      )} {/* end !isFullDayApprovedLeave */}

      {/* ── Projects section — two cards ───────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

        {/* Card 1: Project List */}
        <Card
          title="Projects"
          bodyClassName="flex-1 flex flex-col"
          action={
            <button type="button" onClick={() => setShowAddProject(true)} className={cx(L.btn, L.btnPrimary, L.btnSm)}>
              <Plus className="w-3.5 h-3.5" strokeWidth={2} /> New
            </button>
          }
        >
          {projects.length === 0 ? (
            <div className="flex-1 flex items-center justify-center py-8">
              <p className="text-[13px] text-[#6B7280] text-center">No projects yet.<br/>Click <strong className="text-[#111827] font-semibold">+ New</strong> to create one.</p>
            </div>
          ) : (
            <>
              {/* One list at a time. The counts live on the tabs, so the list
                  itself needs no headings at all. */}
              <Segmented<typeof projectTab>
                size="sm"
                className="mb-3"
                value={projectTab}
                onChange={setProjectTab}
                options={([
                  { id: 'pending' as const, label: <>Pending <span className="opacity-60 tabular-nums">{pendingProjects.length}</span></> },
                  { id: 'completed' as const, label: <>Completed <span className="opacity-60 tabular-nums">{completedProjects.length}</span></> },
                ])}
              />

              {visibleProjects.length === 0 ? (
                <p className="text-[13px] text-[#6B7280] py-8 text-center">
                  {projectTab === 'pending' ? 'Nothing pending.' : 'Nothing completed yet.'}
                </p>
              ) : (
                /* Hairline rules instead of gaps: they separate rows on a third
                   of the ink a card or a border would need. */
                <ul className="divide-y divide-[#C5CAD1] overflow-y-auto max-h-[26rem] pr-1 -mr-1">
                  {visibleProjects.map((p, i) => {
                    const mine = p.assignments.find(a => a.user_id === profile?.id)
                    // Everyone on the project except the reader — their own name
                    // appeared on every single row and told them nothing.
                    const others = p.assigned_user_ids
                      .filter(id => id !== profile?.id)
                      .map(projectUserName)
                      .filter(Boolean)
                    const people = others.length <= 1 ? others[0] : `${others[0]} +${others.length - 1}`
                    // Urgency is only meaningful on work still to do — a finished
                    // project whose deadline has passed is not "overdue", so the
                    // Completed tab just states the date.
                    const left = projectTab === 'pending' && p.deadline ? daysUntil(p.deadline) : null
                    const dueTone = left === null ? 'text-[#6B7280]'
                      : left < 0 ? 'text-[#DC2626] font-medium'
                      : left <= 7 ? 'text-[#B45309] font-medium'
                      : 'text-[#6B7280]'
                    const dueText = !p.deadline ? 'No deadline'
                      : left === null ? shortDate(p.deadline)
                      : left < 0 ? `Overdue · ${shortDate(p.deadline)}`
                      : left === 0 ? 'Due today'
                      : left === 1 ? 'Due tomorrow'
                      : `Due ${shortDate(p.deadline)}`
                    // Nothing is dropped, only moved: the full roster and the
                    // lead are still one hover away.
                    const fullMeta = [
                      p.deadline ? `Due ${shortDate(p.deadline)}` : 'No deadline',
                      p.assigned_user_ids.map(projectUserName).filter(Boolean).join(', '),
                      p.assigned_lead_id ? `Lead: ${projectUserName(p.assigned_lead_id)}` : '',
                    ].filter(Boolean).join('  ·  ')
                    return (
                      <li key={p.id} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
                        <ProjectIcon index={i} />
                        <div className="min-w-0 flex-1">
                          <p className="text-[13px] font-semibold text-[#111827] truncate" title={p.name}>{p.name}</p>
                          <p className="mt-0.5 text-[12px] text-[#6B7280] truncate" title={fullMeta}>
                            <span className={dueTone}>{dueText}</span>
                            {people && <span className="text-[#9CA3AF]"> · {people}</span>}
                          </p>
                        </div>
                        {/* "Running" on seven of eight rows was seven chips that
                            said nothing. Only the exception is worth a badge. */}
                        {projectTab === 'pending' && p.status === 'on_hold' && (
                          <Badge hue="amber">On hold</Badge>
                        )}
                        {/* Spelled out rather than a bare tick: a circle with a
                            check in it is read as either "this is done" or
                            "finish this", and those are opposite meanings on
                            two tabs of the same list. */}
                        {projectTab === 'completed' ? (
                          <Badge hue="green"><Check className="w-3 h-3" strokeWidth={2} /> Completed</Badge>
                        ) : mine ? (
                          <button type="button" onClick={() => void markProjectComplete(p.id)}
                            aria-label={`Mark ${p.name} as completed`}
                            className={cx(L.btn, L.btnSecondary, L.btnSm, 'shrink-0')}>
                            <Check className="w-3.5 h-3.5" strokeWidth={1.75} />
                            <span className="hidden sm:inline">Mark as completed</span>
                            <span className="sm:hidden">Complete</span>
                          </button>
                        ) : null}
                      </li>
                    )
                  })}
                </ul>
              )}
            </>
          )}
        </Card>

        {/* Card 2: Project Progress gauge */}
        <Card
          title="Project Progress"
          bodyClassName="flex-1 flex flex-col"
          action={<Badge hue={trackedCount > 0 && doneCount === trackedCount ? 'green' : 'grey'}>{doneCount} of {trackedCount} delivered</Badge>}
        >
          {(() => {
            const pct = trackedCount > 0 ? Math.round((doneCount / trackedCount) * 100) : 0
            const bands = [
              { label: 'Completed',   n: doneCount,   fill: 'bg-[var(--nerve-primary)]', dot: 'bg-[var(--nerve-primary)]' },
              { label: 'In progress', n: activeCount, fill: 'bg-[var(--nerve-primary-soft-border)]', dot: 'bg-[var(--nerve-primary-soft-border)]' },
              { label: 'On hold',     n: holdCount,   fill: 'bg-[#D9DDE3]', dot: 'bg-[#D9DDE3]' },
            ] as const
            return (
              <div className="flex-1 flex flex-col">
                {/* Headline figure, in the same voice as the KPI tiles. */}
                <div className="flex items-end justify-between gap-3">
                  <div>
                    <p className={L.figure}>
                      {pct}<span className="text-[16px] text-[#6B7280] font-medium ml-0.5 tracking-normal">%</span>
                    </p>
                    <p className={cx(L.meta, 'mt-1.5')}>
                      {trackedCount === 0
                        ? 'No projects assigned yet'
                        : doneCount === trackedCount
                          ? 'Everything assigned to you is delivered'
                          : `${trackedCount - doneCount} of ${trackedCount} still open`}
                    </p>
                  </div>
                  <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-[#9CA3AF] pb-1">delivered</span>
                </div>

                {/* One bar, three bands, in proportion. */}
                <div className="mt-4 flex h-2 rounded-[3px] overflow-hidden bg-[#F3F4F6] gap-px" aria-hidden="true">
                  {trackedCount > 0 && bands.filter(b => b.n > 0).map(b => (
                    <span key={b.label} className={cx('h-full', b.fill)} style={{ width: `${(b.n / trackedCount) * 100}%` }} />
                  ))}
                </div>

                {/* Breakdown rows: label on the left, count and share on the right. */}
                <ul className="mt-3 divide-y divide-[#C5CAD1] border-y border-[#C5CAD1]">
                  {bands.map(b => (
                    <li key={b.label} className="flex items-center justify-between gap-3 py-2.5">
                      <span className="flex items-center gap-2 text-[13px] text-[#111827]">
                        <span className={cx('w-2 h-2 rounded-full shrink-0', b.dot)} />
                        {b.label}
                      </span>
                      <span className="flex items-baseline gap-2 tabular-nums">
                        <span className="text-[13px] font-semibold text-[#111827]">{b.n}</span>
                        <span className="text-[12px] text-[#6B7280] w-9 text-right">{sharePct(b.n)}%</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )
          })()}

          {nextDue && (
            <div className="mt-3 flex items-center gap-2 rounded-[6px] border border-[#C5CAD1] bg-[#F9FAFB] px-3 py-2.5">
              <Calendar className="w-4 h-4 text-[#9CA3AF] shrink-0" strokeWidth={1.75} />
              <span className={cx(L.eyebrow, 'shrink-0')}>Next due</span>
              <span className="text-[12px] font-semibold text-[#111827] truncate" title={nextDue.name}>{nextDue.name}</span>
              <span className={`ml-auto shrink-0 text-[12px] font-semibold tabular-nums ${
                daysUntil(nextDue.deadline!) < 0 ? 'text-[#DC2626]'
                  : daysUntil(nextDue.deadline!) <= 7 ? 'text-[#B45309]'
                  : 'text-[#6B7280]'
              }`}>
                {daysUntil(nextDue.deadline!) < 0 ? 'Overdue'
                  : daysUntil(nextDue.deadline!) === 0 ? 'Today'
                  : shortDate(nextDue.deadline!)}
              </span>
            </div>
          )}
        </Card>
      </div>

      {/* ── Add Project Modal ─────────────────────────────────────────────── */}
      {showAddProject && (
        <Modal
          size="lg"
          title="New Project"
          onClose={() => { setShowAddProject(false); resetProjectForm() }}
          footer={
            <>
              <button type="button" onClick={() => { setShowAddProject(false); resetProjectForm() }} className={cx(L.btn, L.btnSecondary)}>
                Cancel
              </button>
              <button type="button" onClick={() => void addProject()} disabled={projSaving} className={cx(L.btn, L.btnPrimary)}>
                {projSaving ? 'Creating…' : 'Create Project'}
              </button>
            </>
          }
        >
          <div className="space-y-3">
            <div>
              <label className={L.label}>Project Name *</label>
              <input
                placeholder="e.g. Brand Campaign Q2"
                value={projName}
                onChange={e => setProjName(e.target.value)}
                className={L.input}
                autoFocus
              />
            </div>
            <div>
              <label className={L.label}>Type of Work *</label>
              <select
                value={projType}
                onChange={e => { setProjType(e.target.value); setProjSubCat('') }}
                className={L.select}
              >
                <option value="">Select type of work…</option>
                {categories.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
              </select>
            </div>
            <div>
              <label className={L.label}>Sub-category *</label>
              <select
                value={projSubCat}
                onChange={e => setProjSubCat(e.target.value)}
                disabled={!projType}
                className={L.select}
              >
                <option value="">{projType ? 'Select sub-category…' : 'Pick a type of work first'}</option>
                {(categories.find(c => c.name === projType)?.sub_categories ?? []).map(sc => (
                  <option key={sc.id} value={sc.name}>{sc.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={L.label}>Specific Work *</label>
              <input
                placeholder="e.g. Poster design for launch event"
                value={projSpecific}
                onChange={e => setProjSpecific(e.target.value)}
                className={L.input}
              />
            </div>
            <div>
              <label className={L.label}>Deadline</label>
              <input
                type="date"
                value={projDeadline}
                onChange={e => setProjDeadline(e.target.value)}
                className={L.input}
              />
            </div>
            <div>
              <label className={L.label}>Description</label>
              <textarea
                placeholder="Optional description…"
                value={projDesc}
                onChange={e => setProjDesc(e.target.value)}
                rows={3}
                className={cx(L.textarea, 'resize-none')}
              />
            </div>
          </div>
        </Modal>
      )}

      {/* ── Leave ────────────────────────────────────────────────────────
          One section for the whole subject: today's state, the action, and
          the history. */}
      <Card
        title={<>Leave{leaves.length > 0 && <span className="text-[12px] font-medium text-[#9CA3AF] tabular-nums">{leaves.length} {leaves.length === 1 ? 'request' : 'requests'}</span>}</>}
        action={
          <button
            type="button"
            onClick={() => { setLeaveStart(`${today()}T09:00`); setLeaveEnd(`${today()}T17:00`); setShowLeaveModal(true) }}
            className={cx(L.btn, L.btnDanger, L.btnSm)}
          >
            <Calendar className="w-3.5 h-3.5" strokeWidth={1.75} /> Apply leave
          </button>
        }
      >
        {/* Today first: the one row of this list a reader needs right now. */}
        {todayLeave && (
          <div className={cx('mb-4 flex items-center gap-3 flex-wrap rounded-[6px] border px-4 py-3',
            todayLeave.status === 'approved' ? 'bg-[#ECFDF5] border-[#D1FAE5]'
              : todayLeave.status === 'rejected' ? 'bg-[#FEF2F2] border-[#FEE2E2]'
              : 'bg-[#FFFBEB] border-[#FEF3C7]')}>
            {todayLeave.status === 'approved'
              ? <Check className="w-4 h-4 text-[#16A34A] shrink-0" strokeWidth={1.75} />
              : <AlertCircle className={cx('w-4 h-4 shrink-0', todayLeave.status === 'rejected' ? 'text-[#DC2626]' : 'text-[#F59E0B]')} strokeWidth={1.75} />}
            <p className={cx('text-[13px] font-semibold',
              todayLeave.status === 'approved' ? 'text-[#065F46]'
                : todayLeave.status === 'rejected' ? 'text-[#B91C1C]' : 'text-[#B45309]')}>
              {todayLeave.status === 'approved'
                ? (isHalfDayApprovedLeave
                    ? `On ${todayLeave.half_day_period === 'first' ? 'first-half' : 'second-half'} leave today`
                    : 'On leave today')
                : todayLeave.status === 'rejected'
                ? "Today's leave was declined"
                : 'Leave pending approval for today'}
            </p>
            {todayLeave.reason && (
              <p className="text-[12px] text-[#6B7280] truncate min-w-0">{todayLeave.reason}</p>
            )}
            {todayLeave.status === 'pending' && (
              <button
                type="button"
                onClick={() => cancelLeaveById(todayLeave.id)}
                className="ml-auto shrink-0 text-[12px] font-medium text-[#DC2626] hover:text-[#B91C1C] underline underline-offset-2 cursor-pointer"
              >
                Cancel
              </button>
            )}
          </div>
        )}

        {leaves.length === 0 ? (
          <p className="text-[13px] text-center py-8 text-[#6B7280]">
            No leave requests yet.
          </p>
        ) : (
          <ul className="divide-y divide-[#C5CAD1]">
            {leaves.map(lv => {
              const from = new Date(lv.start_at)
              const to = new Date(lv.end_at)
              const hasWindow = !isNaN(from.getTime()) && !isNaN(to.getTime())
              const t = (d: Date) => d.toLocaleString([], { hour: 'numeric', minute: '2-digit', hour12: true })
              return (
                <li key={lv.id} className="flex items-start gap-3 py-3.5 first:pt-0 last:pb-0">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-[13px] font-semibold text-[#111827] tabular-nums">{lv.leave_date}</span>
                      {lv.is_half_day && lv.half_day_period && (
                        <Badge hue="amber">{lv.half_day_period === 'first' ? 'First half' : 'Second half'}</Badge>
                      )}
                      {/* Green for granted, red for refused, amber for waiting —
                          three answers, three colours. */}
                      <Badge hue={lv.status === 'approved' ? 'green' : lv.status === 'rejected' ? 'red' : 'amber'}>
                        {lv.status.charAt(0).toUpperCase() + lv.status.slice(1)}
                      </Badge>
                    </div>
                    {/* A leave saved before the app stored times has no window
                        to show; it used to print "Invalid Date" on the row. */}
                    <p className="mt-1 text-[12px] text-[#6B7280]">
                      {hasWindow && <span className="tabular-nums">{t(from)} – {t(to)}</span>}
                      {hasWindow && lv.reason && <span className="mx-1.5 text-[#D1D5DB]">·</span>}
                      {lv.reason}
                    </p>
                    {lv.transfer_date && (
                      <p className="mt-0.5 text-[12px] font-medium text-[#111827]">
                        Transfer day: {lv.transfer_date}
                      </p>
                    )}
                  </div>
                  {/* Only a request nobody has answered yet can be withdrawn. */}
                  {lv.status === 'pending' && (
                    <button
                      type="button"
                      onClick={() => void cancelLeaveById(lv.id)}
                      className="shrink-0 text-[12px] font-medium text-[#DC2626] hover:text-[#B91C1C] underline underline-offset-2 cursor-pointer"
                    >
                      Cancel
                    </button>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </Card>

      {/* Leave Application Modal */}
      {showLeaveModal && (
        <Modal
          size="sm"
          title="Apply for Leave"
          onClose={() => setShowLeaveModal(false)}
          footer={
            <>
              <button type="button" onClick={() => setShowLeaveModal(false)} className={cx(L.btn, L.btnSecondary)}>
                Cancel
              </button>
              <button type="button" onClick={() => void applyForLeave()} disabled={leaveSubmitting} className={cx(L.btn, L.btnPrimary)}>
                {leaveSubmitting ? 'Submitting…' : 'Submit Leave Request'}
              </button>
            </>
          }
        >
          <div className="space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className={L.label}>From *</label>
                <input type="datetime-local" value={leaveStart} min={`${today()}T00:00`}
                  onChange={e => setLeaveStart(e.target.value)}
                  className={L.input} />
              </div>
              <div>
                <label className={L.label}>To *</label>
                <input type="datetime-local" value={leaveEnd} min={leaveStart || `${today()}T00:00`}
                  onChange={e => setLeaveEnd(e.target.value)}
                  className={L.input} />
              </div>
            </div>
            {(() => {
              // Half-day detection (client-side preview; server confirms).
              const st = leaveStart, en = leaveEnd
              if (!st || !en) return null
              const sd = st.split('T')[0], ed = en.split('T')[0]
              if (sd !== ed) return <p className="text-[12px] font-medium text-[#111827]">Multi-day leave</p>
              if (st.endsWith('T09:00') && en.endsWith('T13:00'))
                return <p className="text-[12px] font-medium text-[#B45309]">First half (9:00 AM – 1:00 PM)</p>
              if (st.endsWith('T14:00') && en.endsWith('T17:00'))
                return <p className="text-[12px] font-medium text-[#B45309]">Second half (2:00 PM – 5:00 PM)</p>
              return <p className="text-[12px] font-medium text-[#6B7280]">Same-day leave window</p>
            })()}
            <p className="text-[11px] text-[#9CA3AF]">
              Half-day rules: <span className="font-medium text-[#6B7280]">First half</span> = 9:00 AM – 1:00 PM, <span className="font-medium text-[#6B7280]">Second half</span> = 2:00 PM – 5:00 PM.
            </p>
            <div>
              <label className={L.label}>Reason *</label>
              <textarea value={leaveReason} onChange={e => setLeaveReason(e.target.value)}
                placeholder="Brief reason for leave…" rows={3}
                className={cx(L.textarea, 'resize-none')} />
            </div>
            <div>
              <label className={L.label}>Transfer Leave to (optional)</label>
              <input type="date" value={leaveTransferDate} min={today()}
                onChange={e => setLeaveTransferDate(e.target.value)}
                className={L.input} />
              <p className={L.hint}>If you'll work on another day to compensate, pick it here.</p>
            </div>
          </div>
        </Modal>
      )}

      {/* ── Report history ──────────────────────────────────────────────
          Everything above this point is today. This is every other day:
          searchable, filterable by status and month, and read-only —
          past reports cannot be edited, so the only action on them is View.
          Today's own draft is the one row that links back up to the table. */}
      <div>
        <h3 className="text-[14px] font-semibold text-[#111827]">Report history</h3>
        <p className={L.meta}>Search and review earlier entries</p>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <SearchField
            value={histQuery}
            onChange={setHistQuery}
            placeholder="Search reports or projects"
            className="flex-1 min-w-[200px] max-w-xs"
          />
          <select
            value={histStatus}
            onChange={e => setHistStatus(e.target.value as 'all' | 'submitted' | 'draft')}
            className={cx(L.select, '!w-auto')}
          >
            <option value="all">All statuses</option>
            <option value="submitted">Submitted</option>
            <option value="draft">Draft</option>
          </select>
          <select
            value={histMonth}
            onChange={e => setHistMonth(e.target.value)}
            className={cx(L.select, '!w-auto')}
          >
            <option value="all">All months</option>
            {histMonths.map(m => <option key={m.key} value={m.key}>{m.label}</option>)}
          </select>
          <span className={cx(L.meta, 'ml-auto tabular-nums')}>
            {filteredHistory.length} {filteredHistory.length === 1 ? 'report' : 'reports'}
          </span>
        </div>

        <div className={cx(L.card, 'mt-3 overflow-hidden')}>
          {filteredHistory.length === 0 ? (
            <p className="text-[13px] text-[#6B7280] py-14 text-center">
              {history.length === 0
                ? 'No reports filed in the last six months.'
                : 'No reports match these filters.'}
            </p>
          ) : (
            <>
              {/* Desktop table */}
              <div className="hidden md:block overflow-x-auto">
                <table className={L.table}>
                  <thead className={L.thead}>
                    <tr>
                      <Th className="uppercase tracking-[0.06em] !text-[11px]">Date</Th>
                      <Th className="uppercase tracking-[0.06em] !text-[11px]">Work summary</Th>
                      <Th className="uppercase tracking-[0.06em] !text-[11px]">Hours</Th>
                      <Th className="uppercase tracking-[0.06em] !text-[11px]">Status</Th>
                      <Th className="uppercase tracking-[0.06em] !text-[11px]">Action</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleHistory.map(rep => {
                      const isToday = rep.report_date === today()
                      return (
                        <tr key={rep.id} className={L.trHover}>
                          <td className={cx(L.td, 'whitespace-nowrap font-semibold tabular-nums')}>
                            {parseDateLocal(rep.report_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                          </td>
                          <td className={L.td}>
                            <p className="font-semibold text-[#111827]">{histLabel(rep)}</p>
                            {histSummary(rep) && (
                              <p className="text-[12px] text-[#6B7280] mt-0.5">{histSummary(rep)}</p>
                            )}
                          </td>
                          <td className={cx(L.td, 'whitespace-nowrap tabular-nums')}>
                            {fmtHours(histHours(rep))}
                          </td>
                          <td className={L.td}>
                            <Badge hue={rep.is_locked ? 'green' : 'amber'}>{rep.is_locked ? 'Submitted' : 'Draft'}</Badge>
                          </td>
                          <td className={L.td}>
                            {isToday && !rep.is_locked ? (
                              <button
                                type="button"
                                onClick={() => document.getElementById('todays-report')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
                                className={TEXT_LINK}
                              >
                                Edit
                              </button>
                            ) : (
                              <button
                                type="button"
                                onClick={() => setHistView(rep)}
                                className={TEXT_LINK}
                              >
                                View
                              </button>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>

              {/* Mobile list — the same rows without the horizontal scroll */}
              <ul className="md:hidden divide-y divide-[#C5CAD1]">
                {visibleHistory.map(rep => {
                  const isToday = rep.report_date === today()
                  return (
                    <li key={rep.id} className="px-4 py-3.5">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-[12px] text-[#6B7280] tabular-nums">
                            {parseDateLocal(rep.report_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                          </p>
                          <p className="text-[13px] font-semibold text-[#111827] mt-1">{histLabel(rep)}</p>
                          {histSummary(rep) && (
                            <p className="text-[12px] text-[#6B7280] mt-0.5">{histSummary(rep)}</p>
                          )}
                        </div>
                        <Badge hue={rep.is_locked ? 'green' : 'amber'} className="shrink-0">{rep.is_locked ? 'Submitted' : 'Draft'}</Badge>
                      </div>
                      <div className="mt-2 flex items-center justify-between">
                        <span className="text-[13px] text-[#111827] tabular-nums">{fmtHours(histHours(rep))}</span>
                        <button
                          type="button"
                          onClick={() => isToday && !rep.is_locked
                            ? document.getElementById('todays-report')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                            : setHistView(rep)}
                          className={TEXT_LINK}
                        >
                          {isToday && !rep.is_locked ? 'Edit' : 'View'}
                        </button>
                      </div>
                    </li>
                  )
                })}
              </ul>

              {filteredHistory.length > visibleHistory.length && (
                <div className="border-t border-[#C5CAD1] px-4 py-3 text-center">
                  <button
                    type="button"
                    onClick={() => setHistShown(n => n + HIST_PAGE)}
                    className={TEXT_LINK}
                  >
                    Show {Math.min(HIST_PAGE, filteredHistory.length - visibleHistory.length)} more
                    <span className="text-[#9CA3AF] font-normal">
                      {' · '}{visibleHistory.length} of {filteredHistory.length}
                    </span>
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Read-only view of one past day */}
      {histView && (
        <Modal
          size="lg"
          onClose={() => setHistView(null)}
          title={parseDateLocal(histView.report_date).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
          subtitle={<>
            {(histView.rows ?? []).length} {(histView.rows ?? []).length === 1 ? 'entry' : 'entries'}
            {' · '}{fmtHours(histHours(histView))}
            {' · '}{histView.is_locked ? 'Submitted' : 'Draft'}
          </>}
        >
          {(histView.rows ?? []).length === 0 ? (
            <p className="text-[13px] text-[#6B7280] py-8 text-center">This day has no entries.</p>
          ) : (
            <ul className="space-y-3">
              {(histView.rows ?? []).map(row => (
                <li key={row.id} className="border border-[#C5CAD1] rounded-[6px] p-3.5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-[13px] font-semibold text-[#111827]">{row.type_of_work || 'Untitled'}</p>
                      <p className="text-[12px] text-[#6B7280] mt-0.5">{row.sub_category}</p>
                    </div>
                    <span className="shrink-0 text-[13px] font-semibold text-[#111827] tabular-nums">
                      {fmtHours(timeToHours(row.time_taken))}
                    </span>
                  </div>
                  {row.specific_work && (
                    <p className="text-[13px] text-[#374151] mt-2 leading-relaxed">{row.specific_work}</p>
                  )}
                  {(row.collaborative_colleagues ?? []).length > 0 && (
                    <p className="text-[12px] text-[#9CA3AF] mt-2">
                      With {(row.collaborative_colleagues ?? []).map(id => projectUserName(id) || id).join(', ')}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Modal>
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

  const quickLinks: { icon: React.ElementType; title: string; desc: string; page: NavPage; hue: Hue }[] = [
    { icon: ClipboardList, title: 'Submit Daily Report', desc: 'Log your work for today', page: 'daily-reports', hue: 'blue' },
    { icon: BarChart2, title: 'View Analytics', desc: 'See your hours & trends', page: 'analytics', hue: 'green' },
    { icon: Award, title: 'Self Appraisal', desc: 'Submit your KRA scores', page: 'self-appraisal', hue: 'violet' },
    { icon: LayoutGrid, title: 'Design Gallery', desc: 'Browse & upload designs', page: 'gallery', hue: 'amber' },
  ]

  return (
    <div className="space-y-4">
      {/* Quick navigation cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {quickLinks.map(item => (
          <button key={item.title} type="button" onClick={() => onNavigate(item.page)}
            className={cx(L.card, L.cardPad, 'flex items-start gap-3  transition-colors text-left cursor-pointer')}>
            <IconTile icon={item.icon} hue={item.hue} />
            <div className="min-w-0">
              <p className="text-[13px] font-semibold text-[#111827]">{item.title}</p>
              <p className="text-[12px] text-[#6B7280] mt-0.5">{item.desc}</p>
            </div>
          </button>
        ))}
      </div>

      {/* FAQ accordion */}
      <Card icon={BookOpen} title="Frequently Asked Questions" padded={false}>
        <div className="divide-y divide-[#C5CAD1]">
          {faqs.map((faq, i) => (
            <div key={i}>
              <button
                type="button"
                onClick={() => setOpenFaq(openFaq === i ? null : i)}
                aria-expanded={openFaq === i}
                className="w-full flex items-center justify-between px-4 py-3.5 text-left hover:bg-[#F9FAFB] transition-colors gap-4 cursor-pointer"
              >
                <span className="text-[13px] font-semibold text-[#111827]">{faq.q}</span>
                <ChevronDown className={cx('w-4 h-4 text-[#9CA3AF] shrink-0 transition-transform duration-200', openFaq === i && 'rotate-180 text-[#111827]')} strokeWidth={1.75} />
              </button>
              {openFaq === i && (
                <div className="px-4 pb-4">
                  <p className="text-[13px] text-[#6B7280] leading-relaxed">{faq.a}</p>
                </div>
              )}
            </div>
          ))}
        </div>
      </Card>

      {/* Keyboard shortcuts */}
      <Card icon={Keyboard} title="Keyboard Shortcuts">
        <div className="space-y-2.5">
          {shortcuts.map(sc => (
            <div key={sc.keys} className="flex items-center justify-between gap-3">
              <span className="text-[13px] text-[#374151]">{sc.desc}</span>
              <kbd className="px-2 py-1 rounded-[5px] bg-[#F3F4F6] text-[11px] font-mono font-medium text-[#374151] border border-[#C5CAD1]">{sc.keys}</kbd>
            </div>
          ))}
        </div>
      </Card>

      {/* Feature overview */}
      <Card icon={MessageCircle} title="Portal Features">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {[
            { title: 'Daily Reports', desc: 'Log work hours with type, task, time, and collaborators.' },
            { title: 'Work Analytics', desc: 'Visual charts of your weekly/monthly productivity.' },
            { title: 'Design Gallery', desc: 'Upload, browse, and vote on team design work.' },
            { title: 'KRA Appraisal', desc: 'Self-assess and peer-mark on performance parameters.' },
            { title: 'Project Tracker', desc: 'View and manage active team projects.' },
            { title: 'Team Collaboration', desc: 'Tag colleagues in your daily reports.' },
          ].map(f => (
            <div key={f.title} className="rounded-[6px] bg-[#F9FAFB] border border-[#C5CAD1] px-3.5 py-3">
              <p className="text-[13px] font-semibold text-[#111827]">{f.title}</p>
              <p className="text-[12px] text-[#6B7280] mt-0.5 leading-snug">{f.desc}</p>
            </div>
          ))}
        </div>
      </Card>

      {/* Support footer */}
      <div className={cx(L.card, L.cardPad, 'flex items-center justify-between flex-wrap gap-3')}>
        <div>
          <p className="text-[13px] font-semibold text-[#111827]">Nerve — Branding Portal</p>
          <p className="text-[12px] text-[#9CA3AF] mt-0.5">Parul University Knowledge Hub · v1.0</p>
        </div>
        <div className="text-[12px] text-[#6B7280]">
          Need help? <span className="font-semibold text-[#111827]">admin@paruluniversity.ac.in</span>
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
    <div className="space-y-4">
      {/* Period selector */}
      <div className={cx(L.card, L.cardPad, 'flex items-center gap-3 flex-wrap')}>
        <Calendar className="w-4 h-4 text-[#6B7280] shrink-0" strokeWidth={1.75} />
        <label className="text-[13px] font-semibold text-[#111827]">Period:</label>
        <select value={appraisalMonth} onChange={e => setAppraisalMonth(parseInt(e.target.value))} className={cx(L.select, '!w-auto')}>
          {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
        </select>
        <select value={appraisalYear} onChange={e => setAppraisalYear(parseInt(e.target.value))} className={cx(L.select, '!w-auto')}>
          {[2024, 2025, 2026, 2027].map(y => <option key={y} value={y}>{y}</option>)}
        </select>
        {selfAppraisal && (
          <Badge hue="green" className="ml-auto"><Check className="w-3 h-3" strokeWidth={2} /> Submitted for {MONTHS[appraisalMonth - 1]}</Badge>
        )}
      </div>

      {/* Section tabs */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {[
          { key: 'self' as const, icon: Award, label: 'Self Appraisal', desc: 'Evaluate your own KRA performance' },
          { key: 'peer' as const, icon: Users, label: 'Staff KRA Marking', desc: 'Anonymously mark your colleagues' },
          { key: 'download' as const, icon: Download, label: 'KRA Report', desc: 'View & download your final KRA' },
        ].map(sec => {
          const Icon = sec.icon
          const active = section === sec.key
          return (
            <button key={sec.key} type="button" role="tab" aria-selected={active} onClick={() => setSection(sec.key)}
              className={cx(
                'rounded-[6px] p-4 text-left border transition-colors cursor-pointer',
                active ? 'bg-white border-[var(--nerve-primary)] ring-1 ring-[var(--nerve-primary)]' : 'bg-white border-[#C5CAD1] hover:border-[#C5CAD1]',
              )}>
              <div className="flex items-center gap-2 mb-1">
                <Icon className={cx('w-4 h-4', active ? 'text-[#111827]' : 'text-[#6B7280]')} strokeWidth={1.75} />
                <span className={cx('text-[13px] font-semibold', active ? 'text-[#111827]' : 'text-[#374151]')}>{sec.label}</span>
              </div>
              <p className="text-[12px] text-[#6B7280]">{sec.desc}</p>
            </button>
          )
        })}
      </div>

      {/* Self Appraisal */}
      {section === 'self' && (
        <div className={cx(L.card, 'p-4 space-y-4')}>
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <h2 className={L.cardTitle}>
              Self Appraisal — {MONTHS[appraisalMonth - 1]} {appraisalYear}
            </h2>
            {selfAppraisal && (
              <Badge hue="green"><Lock className="w-3 h-3" strokeWidth={2} /> Submitted — locked</Badge>
            )}
          </div>

          {selfLoading
            ? <p className="text-[13px] text-[#6B7280] text-center py-10 animate-pulse">Loading…</p>
            : kraParams.length === 0
            ? <p className="text-[13px] text-[#6B7280] text-center py-10">KRA parameters not configured yet.</p>
            : (
              <>
                <div className="p-3.5 bg-[var(--nerve-primary-soft)] border border-[var(--nerve-primary-soft-border)] rounded-[6px] text-[12px] text-[var(--nerve-primary-text)] flex items-start gap-2">
                  <Info className="w-4 h-4 text-[var(--nerve-primary)] shrink-0 mt-0.5" strokeWidth={1.75} />
                  <span>Self appraisal can only be submitted <strong>once per month</strong>. Once submitted, it cannot be edited.</span>
                </div>

                <KraForm params={kraParams} scores={selfScores} onChange={setSelfScores} readOnly={!!selfAppraisal} />

                {!selfAppraisal && !confirmSubmit && (
                  <button type="button" onClick={() => setConfirmSubmit(true)} className={cx(L.btn, L.btnPrimary, 'w-full')}>
                    Submit Self Appraisal
                  </button>
                )}

                {!selfAppraisal && confirmSubmit && (
                  <div className="p-4 bg-[#FFFBEB] border border-[#FEF3C7] rounded-[6px] space-y-3">
                    <p className="text-[13px] text-[#B45309]">
                      You are about to submit your Self Appraisal for {MONTHS[appraisalMonth - 1]} {appraisalYear}.
                      <strong className="block mt-1">This action cannot be undone. Are you sure?</strong>
                    </p>
                    <div className="flex gap-2">
                      <button type="button" onClick={() => void submitSelfAppraisal()} disabled={selfLoading} className={cx(L.btn, L.btnPrimary, 'flex-1')}>
                        Yes, submit now
                      </button>
                      <button type="button" onClick={() => setConfirmSubmit(false)} className={cx(L.btn, L.btnSecondary)}>
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
        <div className={cx(L.card, 'p-4 space-y-4')}>
          <h2 className={L.cardTitle}>
            Staff KRA Marking — {MONTHS[appraisalMonth - 1]} {appraisalYear}
          </h2>
          {!peerEnabled
            ? <div className="flex items-start gap-3 p-4 bg-[#F9FAFB] border border-[#C5CAD1] rounded-[6px]">
                <AlertCircle className="w-4 h-4 text-[#9CA3AF] shrink-0 mt-0.5" strokeWidth={1.75} />
                <p className="text-[13px] text-[#6B7280]">This feature is currently disabled. Contact your Admin.</p>
              </div>
            : (
              <>
                <div>
                  <label className={L.label}>Select Colleague</label>
                  <select value={peerColleague}
                    onChange={e => { setPeerColleague(e.target.value); setPeerScores(Object.fromEntries(kraParams.map(p => [p.id, 5]))) }}
                    className={cx(L.select, 'max-w-xs')}>
                    <option value="">Select a colleague…</option>
                    {peerColleagueOptions.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
                  </select>
                  {completedPeers.length > 0 && (
                    <p className={L.hint}>
                      Already marked: {completedPeers.map(id => colleagueOptions.find(o => o.id === id)?.label || id).join(', ')}
                    </p>
                  )}
                </div>
                {peerColleague && kraParams.length > 0 && (
                  <>
                    <div className="p-3.5 bg-[var(--nerve-primary-soft)] border border-[var(--nerve-primary-soft-border)] rounded-[6px] text-[12px] text-[var(--nerve-primary-text)]">
                      Your identity will remain anonymous. Once submitted, this marking is locked.
                    </div>
                    <KraForm params={kraParams} scores={peerScores} onChange={setPeerScores} />
                    <button type="button" onClick={() => void submitPeerMarking()} disabled={peerSubmitting} className={cx(L.btn, L.btnPrimary, 'w-full')}>
                      {peerSubmitting ? 'Submitting…' : 'Submit Peer Marking'}
                    </button>
                  </>
                )}
                {peerColleagueOptions.length === 0 && (
                  <div className="flex items-center gap-2 p-3.5 bg-[#ECFDF5] border border-[#D1FAE5] rounded-[6px]">
                    <Check className="w-4 h-4 text-[#16A34A]" strokeWidth={1.75} />
                    <p className="text-[13px] text-[#047857]">You have marked all your colleagues for this period.</p>
                  </div>
                )}
              </>
            )
          }
        </div>
      )}

      {/* Download KRA Report */}
      {section === 'download' && (
        <div className={cx(L.card, 'p-4 space-y-4')}>
          <h2 className={L.cardTitle}>
            KRA Report — {MONTHS[appraisalMonth - 1]} {appraisalYear}
          </h2>
          {!kraReport?.is_final_pushed
            ? <div className="flex items-start gap-3 p-4 bg-[#F9FAFB] border border-[#C5CAD1] rounded-[6px]">
                <Lock className="w-4 h-4 text-[#9CA3AF] shrink-0 mt-0.5" strokeWidth={1.75} />
                <div>
                  <p className="text-[13px] font-semibold text-[#111827]">Report not available yet</p>
                  <p className="text-[13px] text-[#6B7280]">Your KRA is pending Admin review and approval.</p>
                </div>
              </div>
            : kraReport && kraParams.length > 0
            ? (
              <div className="space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  {[
                    { label: 'Self Score', value: kraReport.self_appraisal ? (Object.values(kraReport.self_appraisal.scores).reduce((a, b) => a + b, 0) / kraParams.length).toFixed(1) : '—', cls: 'bg-[#F9FAFB] border-[#C5CAD1]' },
                    { label: 'Peer Avg', value: Object.keys(kraReport.peer_average).length ? (Object.values(kraReport.peer_average).reduce((a, b) => a + b, 0) / kraParams.length).toFixed(1) : '—', cls: 'bg-[#F9FAFB] border-[#C5CAD1]' },
                    { label: 'Final Score', value: kraReport.composite_score?.toFixed(1) ?? '—', cls: 'bg-[var(--nerve-primary-soft)] border-[var(--nerve-primary-soft-border)]' },
                  ].map(sc => (
                    <div key={sc.label} className={cx('p-4 rounded-[6px] border', sc.cls)}>
                      <p className={L.eyebrow}>{sc.label}</p>
                      <p className={cx(L.figure, 'mt-2')}>{sc.value}<span className="text-[13px] font-normal text-[#6B7280] ml-1">/10</span></p>
                    </div>
                  ))}
                </div>
                <h3 className={L.cardTitle}>Parameter Breakdown</h3>
                <KraForm params={kraParams} scores={kraReport.self_appraisal?.scores || {}} readOnly />
                <button type="button" onClick={() => window.print()} className={cx(L.btn, L.btnPrimary)}>
                  <Download className="w-4 h-4" strokeWidth={1.75} /> Download / Print PDF
                </button>
              </div>
            )
            : <p className="text-[13px] text-[#6B7280] text-center py-6">No KRA data found for this period.</p>
          }
        </div>
      )}
    </div>
  )
}

// ── Page Titles & Subtitles (Salesa Design System) ─────────────────────────
const PAGE_META: Record<NavPage, { title: string; subtitle: string }> = {
  dashboard: {
    title: 'Dashboard',
    subtitle: 'A clear view of your work and what needs attention.',
  },
  'daily-reports': {
    title: 'Daily Reports',
    subtitle: 'Track and submit your daily work & project deliverables',
  },
  analytics: {
    title: 'Analytics',
    subtitle: 'Comprehensive performance, hours and work breakdown',
  },
  'self-appraisal': {
    title: 'Self Appraisal',
    subtitle: 'Evaluate your milestones, KPIs and submit appraisals',
  },
  gallery: {
    title: 'Design Gallery',
    subtitle: 'Browse creative brand assets, templates and designs',
  },
  team: {
    title: 'Kanban Board',
    subtitle: 'Your team\u2019s projects by stage. Drag a card to move it along.',
  },
  members: {
    title: 'Team Members',
    subtitle: 'Your team: who has filed today, live reports and the projects they are on.',
  },
  settings: {
    title: 'Account Settings',
    subtitle: 'Manage your profile preferences and credentials',
  },
  notifications: {
    title: 'Notifications',
    subtitle: 'Everything that needs your attention, newest first',
  },
  help: {
    title: 'Help Center',
    subtitle: 'Documentation, guides and platform support',
  },
}

// ── Today's Schedule Center Popup Modal (Salesa Design System) ─────────────

function TodayScheduleModal({
  isOpen,
  onClose,
  todayReport,
  onNavigate,
  profile,
  users,
}: {
  isOpen: boolean
  onClose: () => void
  todayReport: DailyReport | null
  onNavigate: (p: NavPage) => void
  profile?: ReturnType<typeof useAuth>['profile']
  users?: ReturnType<typeof useAppData>['users']
}) {
  const [activeTab, setActiveTab] = useState<'all' | 'assigned' | 'todos'>('all')
  const [assignedProjects, setAssignedProjects] = useState<BrandingProject[]>([])
  const [todos, setTodos] = useState<BrandingTodo[]>([])
  const [newTodoTitle, setNewTodoTitle] = useState('')
  const [loading, setLoading] = useState(false)
  const [addingTodo, setAddingTodo] = useState(false)

  useEffect(() => {
    if (!isOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isOpen, onClose])

  // Fetch assigned projects & to-dos
  useEffect(() => {
    if (!isOpen) return
    setLoading(true)
    Promise.all([
      brandingApi.getProjects().catch(() => ({ projects: [] })),
      brandingApi.getTodos().catch(() => ({ todos: [] })),
    ]).then(([projRes, todoRes]) => {
      const myId = profile?.id
      const mine = (projRes.projects || []).filter(p =>
        myId && (p.assigned_user_ids?.includes(myId) || p.assignments?.some(a => a.user_id === myId))
      )
      setAssignedProjects(mine)
      setTodos(todoRes.todos || [])
    }).finally(() => {
      setLoading(false)
    })
  }, [isOpen, profile?.id])

  const handleAddTodo = async (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = newTodoTitle.trim()
    if (!trimmed) return
    try {
      setAddingTodo(true)
      const res = await brandingApi.createTodo({ title: trimmed })
      if (res.todo) {
        setTodos(prev => [res.todo, ...prev])
        setNewTodoTitle('')
        toast.success('To-do added (visible to Admin & Lead)')
      }
    } catch {
      toast.error('Failed to add to-do')
    } finally {
      setAddingTodo(false)
    }
  }

  const handleToggleTodo = async (todo: BrandingTodo) => {
    const next = !todo.completed
    setTodos(prev => prev.map(t => t.id === todo.id ? { ...t, completed: next } : t))
    try {
      await brandingApi.toggleTodo(todo.id, next)
    } catch {
      setTodos(prev => prev.map(t => t.id === todo.id ? { ...t, completed: todo.completed } : t))
      toast.error('Failed to update to-do')
    }
  }

  const handleDeleteTodo = async (id: string) => {
    setTodos(prev => prev.filter(t => t.id !== id))
    try {
      await brandingApi.deleteTodo(id)
      toast.success('To-do deleted')
    } catch {
      toast.error('Failed to delete to-do')
    }
  }

  const handleCompleteProject = async (projectId: string) => {
    try {
      await brandingApi.completeProject(projectId)
      setAssignedProjects(prev => prev.map(p => {
        if (p.id !== projectId) return p
        const updated = p.assignments?.map(a =>
          a.user_id === profile?.id ? { ...a, status: 'completed' as const, completed_at: new Date().toISOString() } : a
        )
        return { ...p, assignments: updated }
      }))
      toast.success('Project task marked complete')
    } catch {
      toast.error('Failed to complete task')
    }
  }

  if (!isOpen) return null

  const now = new Date()
  const todaySubmitted = todayReport?.is_locked ?? false
  const todayHours = todayReport?.rows?.reduce((s, r) => s + timeToHours(r.time_taken), 0) ?? 0
  const appraisalDue = now.getDate() >= 20
  const dateFormatted = now.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })

  // Count metrics
  const pendingAssigned = assignedProjects.filter(p => {
    const myA = p.assignments?.find(a => a.user_id === profile?.id)
    return myA ? myA.status !== 'completed' : p.status !== 'completed'
  }).length
  const pendingTodos = todos.filter(t => !t.completed).length
  const totalItemsCount = assignedProjects.length + todos.length

  return (
    <Modal
      size="md"
      onClose={onClose}
      title={<span className="inline-flex items-center gap-2">Today's Schedule <span className="w-2 h-2 rounded-full bg-[#22C55E]" aria-hidden="true" /></span>}
      subtitle={
        <span className="flex items-center justify-between gap-3 flex-wrap">
          <span>Assigned work, personal to-dos &amp; report status</span>
          <Badge hue="grey">{dateFormatted}</Badge>
        </span>
      }
      footer={
        <>
          <button type="button" onClick={onClose} className={cx(L.btn, L.btnSecondary)}>
            Close
          </button>
          <button
            type="button"
            onClick={() => { onClose(); onNavigate('daily-reports') }}
            className={cx(L.btn, L.btnPrimary)}
          >
            <Send className="w-3.5 h-3.5" strokeWidth={1.75} />
            <span>{todaySubmitted ? "View Today's Report" : "Open Today's Daily Report"}</span>
          </button>
        </>
      }
    >
      <div className="space-y-4">
          {/* 1. Today's Report Status Banner */}
          {!todaySubmitted ? (
            <div className="rounded-[6px] bg-[#FFFBEB] border border-[#FEF3C7] p-3.5 flex items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <IconTile icon={AlertCircle} hue="amber" />
                <div>
                  <p className="text-[13px] font-semibold text-[#111827] leading-tight">Daily Report Pending</p>
                  <p className="text-[12px] text-[#B45309] mt-0.5">Submit all logged hours before midnight</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => { onClose(); onNavigate('daily-reports') }}
                className={cx(L.btn, L.btnPrimary, L.btnSm)}
              >
                Log Now
              </button>
            </div>
          ) : (
            <div className="rounded-[6px] bg-[#ECFDF5] border border-[#D1FAE5] p-3.5 flex items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <IconTile icon={CheckCircle2} hue="green" />
                <div>
                  <p className="text-[13px] font-semibold text-[#111827] leading-tight">Daily Report Submitted</p>
                  <p className="text-[12px] text-[#047857] mt-0.5">{fmtHours(todayHours)} logged for today</p>
                </div>
              </div>
              <Badge hue="green">Locked</Badge>
            </div>
          )}

          {/* 2. Filter Navigation Pills */}
          <Segmented<typeof activeTab>
            size="sm"
            className="w-full [&>button]:flex-1"
            value={activeTab}
            onChange={setActiveTab}
            options={[
              { id: 'all' as const, label: `All (${totalItemsCount})` },
              { id: 'assigned' as const, label: <>Lead &amp; Admin Tasks{pendingAssigned > 0 && <span className="ml-1.5 inline-flex items-center justify-center min-w-4 h-4 px-1 rounded-full bg-[#F59E0B] text-white text-[10px] font-semibold">{pendingAssigned}</span>}</> },
              { id: 'todos' as const, label: <>My To-Dos{pendingTodos > 0 && <span className="ml-1.5 inline-flex items-center justify-center min-w-4 h-4 px-1 rounded-full bg-[#6B7280] text-white text-[10px] font-semibold">{pendingTodos}</span>}</> },
            ]}
          />

          {/* 3. Section: Tasks Assigned by Team Lead & Admin */}
          {(activeTab === 'all' || activeTab === 'assigned') && (
            <div className="space-y-2.5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <UserCheck className="w-4 h-4 text-[#6B7280]" strokeWidth={1.75} />
                  <h4 className={L.eyebrow}>Assigned by Lead &amp; Admin</h4>
                </div>
                <Badge hue="grey">{assignedProjects.length} {assignedProjects.length === 1 ? 'task' : 'tasks'}</Badge>
              </div>

              {loading ? (
                <div className="p-6 text-center text-[#6B7280] text-[12px] flex items-center justify-center gap-2">
                  <Spinner />
                  <span>Loading assigned tasks...</span>
                </div>
              ) : assignedProjects.length === 0 ? (
                <div className="rounded-[6px] border border-dashed border-[#C5CAD1] p-4 text-center text-[12px] text-[#6B7280]">
                  No tasks assigned by your team lead or admin yet.
                </div>
              ) : (
                <div className="space-y-2">
                  {assignedProjects.map(p => {
                    const assigner = users?.find(u => u.id === p.created_by)
                    const assignerName = assigner?.full_name || 'Team Lead'
                    const isSuper = assigner?.role === 'super_admin' || assigner?.role === 'admin'
                    const myA = p.assignments?.find(a => a.user_id === profile?.id)
                    const isDone = myA ? myA.status === 'completed' : p.status === 'completed'

                    return (
                      <div
                        key={p.id}
                        className={cx('rounded-[6px] border p-3.5 transition-colors', isDone ? 'bg-[#F9FAFB] border-[#C5CAD1] opacity-80' : 'bg-white border-[#C5CAD1] hover:border-[#C5CAD1]')}
                      >
                        <div className="flex items-start justify-between gap-2.5">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className={cx('text-[13px] font-semibold', isDone ? 'line-through text-[#9CA3AF]' : 'text-[#111827]')}>
                                {p.name}
                              </span>
                              {p.type_of_work && (
                                <Badge hue="grey" className="!h-5 !text-[11px]">
                                  {p.type_of_work}{p.sub_category ? ` • ${p.sub_category}` : ''}
                                </Badge>
                              )}
                            </div>
                            {p.description && (
                              <p className="text-[12px] text-[#6B7280] mt-1 line-clamp-2">
                                {p.description}
                              </p>
                            )}
                            <div className="flex items-center gap-3 mt-2 text-[11px] text-[#9CA3AF] flex-wrap">
                              <span className="flex items-center gap-1 text-[#6B7280]">
                                <span className="w-1.5 h-1.5 rounded-full bg-[var(--nerve-primary)]" />
                                Assigned by <strong className="text-[#111827] font-semibold">{assignerName}</strong> ({isSuper ? 'Admin' : 'Lead'})
                              </span>
                              {p.deadline && (
                                <span className="flex items-center gap-1 text-[#6B7280]">
                                  <Calendar className="w-3 h-3 text-[#9CA3AF]" strokeWidth={1.75} />
                                  Due {new Date(p.deadline).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                                </span>
                              )}
                            </div>
                          </div>

                          {/* Completion Action */}
                          <div className="shrink-0 flex items-center">
                            {isDone ? (
                              <Badge hue="green"><Check className="w-3 h-3" strokeWidth={2.5} /> Done</Badge>
                            ) : (
                              <button
                                type="button"
                                onClick={() => handleCompleteProject(p.id)}
                                className={cx(L.btn, L.btnSecondary, L.btnSm)}
                                title="Mark this assigned task completed"
                              >
                                Mark Done
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )}

          {/* 4. Section: My To-Do List (Custom user tasks, visible to admin/lead) */}
          {(activeTab === 'all' || activeTab === 'todos') && (
            <div className="space-y-2.5 pt-1">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <ListTodo className="w-4 h-4 text-[#6B7280]" strokeWidth={1.75} />
                  <h4 className={L.eyebrow}>My To-Do List</h4>
                </div>
                {/* Visible to Admin & Lead Badge */}
                <Badge hue="green" className="!h-5 !text-[11px]"><Eye className="w-2.5 h-2.5" strokeWidth={1.75} /> Visible to Admin &amp; Lead</Badge>
              </div>

              {/* Add To-Do Input Form */}
              <form onSubmit={handleAddTodo} className="flex items-center gap-2">
                <input
                  type="text"
                  value={newTodoTitle}
                  onChange={e => setNewTodoTitle(e.target.value)}
                  placeholder="Add a new to-do or schedule task..."
                  className={L.input}
                />
                <button
                  type="submit"
                  disabled={addingTodo || !newTodoTitle.trim()}
                  className={cx(L.btn, L.btnPrimary, 'shrink-0')}
                >
                  {addingTodo ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <>
                      <Plus className="w-3.5 h-3.5" strokeWidth={2} />
                      <span>Add</span>
                    </>
                  )}
                </button>
              </form>

              {/* To-Do Items List */}
              {loading ? (
                <div className="p-4 text-center text-[#6B7280] text-[12px] flex items-center justify-center gap-2">
                  <Spinner />
                  <span>Loading to-dos...</span>
                </div>
              ) : todos.length === 0 ? (
                <div className="rounded-[6px] border border-dashed border-[#C5CAD1] p-4 text-center text-[12px] text-[#6B7280]">
                  No personal to-dos yet. Add a task above to plan your day!
                </div>
              ) : (
                <div className="space-y-1.5 max-h-60 overflow-y-auto pr-1">
                  {todos.map(todo => (
                    <div
                      key={todo.id}
                      className={cx('flex items-center justify-between gap-2.5 px-3 py-2.5 rounded-[6px] border transition-colors', todo.completed ? 'bg-[#F9FAFB] border-[#C5CAD1]' : 'bg-white border-[#C5CAD1] hover:border-[#C5CAD1]')}
                    >
                      <label className="flex items-center gap-2.5 flex-1 min-w-0 cursor-pointer select-none">
                        <input
                          type="checkbox"
                          checked={todo.completed}
                          onChange={() => handleToggleTodo(todo)}
                          className="w-4 h-4 rounded-[5px] border-[#C5CAD1] accent-[var(--nerve-primary)] cursor-pointer"
                        />
                        <span className={cx('text-[13px] break-words', todo.completed ? 'line-through text-[#9CA3AF]' : 'text-[#111827] font-medium')}>
                          {todo.title}
                        </span>
                      </label>
                      <button
                        type="button"
                        onClick={() => handleDeleteTodo(todo.id)}
                        className="p-1 rounded-[5px] text-[#9CA3AF] hover:text-[#DC2626] hover:bg-[#FEF2F2] transition-colors cursor-pointer shrink-0"
                        title="Delete to-do"
                      >
                        <Trash2 className="w-3.5 h-3.5" strokeWidth={1.75} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Appraisal Notice if Open */}
          {appraisalDue && (
            <div className="rounded-[6px] bg-[var(--nerve-primary-soft)] border border-[var(--nerve-primary-soft-border)] p-3 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <Award className="w-4 h-4 text-[var(--nerve-primary)] shrink-0" strokeWidth={1.75} />
                <p className="text-[12px] text-[var(--nerve-primary-text)] font-medium">
                  Self Appraisal Window is open for {MONTHS[now.getMonth()]}
                </p>
              </div>
              <button
                type="button"
                onClick={() => { onClose(); onNavigate('self-appraisal') }}
                className={cx(TEXT_LINK, 'shrink-0')}
              >
                Start
              </button>
            </div>
          )}
      </div>
    </Modal>
  )
}

// ── Main Component ─────────────────────────────────────────────────────────

export default function BrandingUserDashboard() {
  const { profile, signOut, role } = useAuth()
  const { users } = useAppData()
  const [activePage, setActivePage] = useState<NavPage>('dashboard')
  const [exporting, setExporting] = useState(false)

  // CSV Export for user's reports
  const handleExport = async () => {
    try {
      setExporting(true)
      const res = await brandingApi.getAllReports(profile?.id ? { userId: profile.id } : undefined)
      const reportsList = res.reports || []
      if (reportsList.length === 0) {
        toast.info('No submitted reports found to export.')
        return
      }
      const rows: string[][] = [
        ['Report Date', 'User', 'Sr No', 'Type of Work', 'Sub Category', 'Specific Work', 'Time Taken', 'Collaborators', 'Submitted At'],
      ]
      for (const r of reportsList) {
        for (const row of r.rows || []) {
          rows.push([
            r.report_date || '',
            r.user_name || profile?.full_name || '',
            String(row.sr_no || ''),
            row.type_of_work || '',
            row.sub_category || '',
            row.specific_work || '',
            row.time_taken || '',
            (row.collaborative_colleagues || []).join('; '),
            r.submitted_at || '',
          ])
        }
      }
      const csv = rows.map(r => r.map(c => `"${(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\n')
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `nerve-branding-reports-${today()}.csv`
      a.click()
      URL.revokeObjectURL(url)
      toast.success(`Exported ${reportsList.length} report(s) successfully!`)
    } catch (err: any) {
      toast.error('Failed to export reports: ' + (err?.message || 'Unknown error'))
    } finally {
      setExporting(false)
    }
  }

  // Sidebar is hidden by default on phones (slides in as a drawer); always
  // visible on md+ screens. Tap a nav item to auto-close on mobile.
  const [sidebarOpen, setSidebarOpen] = useState(false)

  // Header furniture. The date is built by hand rather than left to
  // toLocaleDateString: en-GB drops the comma after the weekday and en-US
  // puts the month first, and the workspace bar wants "Thursday, 24
  // September 2026".
  const headerDate = (() => {
    const d = new Date()
    const weekday = d.toLocaleDateString('en-GB', { weekday: 'long' })
    const month = d.toLocaleDateString('en-GB', { month: 'long' })
    return `${weekday}, ${d.getDate()} ${month} ${d.getFullYear()}`
  })()
  function gotoPage(p: NavPage) { setActivePage(p); setSidebarOpen(false) }

  // ── Search state ─────────────────────────────────────────────────────────
  const [searchOpen, setSearchOpen]   = useState(false)
  const [themeOpen, setThemeOpen]     = useState(false)
  // A saved primary colour (paintbrush in the top bar) applies on load.
  useEffect(() => { applySavedPrimary() }, [])
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
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'f')) {
        e.preventDefault()
        setSearchOpen(true)
      }
      if (e.key === 'Escape') {
        setSearchOpen(false)
        setNotifOpen(false)
        setAvatarMenuOpen(false)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  // Avatar menu. On phones it holds every header action, since the action
  // pills and icon buttons are hidden below lg.
  const [avatarMenuOpen, setAvatarMenuOpen] = useState(false)

  // Close it on any tap outside the trigger or the panel.
  useEffect(() => {
    if (!avatarMenuOpen) return
    const handler = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('[data-avatar-menu]')) setAvatarMenuOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [avatarMenuOpen])

  // Today's report, read once for the sidebar badge and for the
  // notification feed below.
  const [todayReport, setTodayReport] = useState<DailyReport | null>(null)
  const [todayReportStatus, setTodayReportStatus] = useState<string | null>(null)
  useEffect(() => {
    brandingApi.getReport(today())
      .then(r => {
        if (r?.report) {
          setTodayReport(r.report)
          setTodayReportStatus(r.report.is_locked ? null : 'Pending')
        } else {
          setTodayReport(null)
          setTodayReportStatus('Pending')
        }
      })
      .catch(() => {
        setTodayReport(null)
        setTodayReportStatus(null)
      })
  }, [])

  // ── Notification state ────────────────────────────────────────────────────
  const [notifOpen, setNotifOpen] = useState(false)
  // Switching page from anywhere (sidebar, top bar, a link inside a card)
  // slides the drawer back in, so it never sits open over a page you did not
  // open it on.
  useEffect(() => { setNotifOpen(false) }, [activePage])

  // ── What the workspace has to tell you ──────────────────────────────────
  // Everything here is derived from live state, so an item only exists while
  // it is true. The list used to be three fixed strings that said the same
  // thing whether or not you had already done them.
  const [notifProjects, setNotifProjects] = useState<BrandingProject[]>([])
  const [notifComments, setNotifComments] = useState<ReportRowComment[]>([])
  const [appraisalFiled, setAppraisalFiled] = useState<boolean | null>(null)
  const [notifReports, setNotifReports] = useState<DailyReport[]>([])

  useEffect(() => {
    const load = () => brandingApi.getProjects()
      .then(r => setNotifProjects(r.projects))
      .catch(() => setNotifProjects([]))
    load()
    // A lead dragging a card on the Kanban board should reach the designer's
    // panel without a reload, so the feed re-reads the board every 30s.
    const id = setInterval(load, 30_000)
    return () => clearInterval(id)
  }, [])

  // The last week of your own reports, for the "you filed this" items.
  useEffect(() => {
    if (!profile?.id) return
    const from = new Date()
    from.setDate(from.getDate() - 7)
    brandingApi.getAllReports({ userId: profile.id, dateFrom: fmtDate(from), dateTo: today() })
      .then(r => setNotifReports(r.reports))
      .catch(() => setNotifReports([]))
  }, [profile?.id])

  // Lead feedback on today's rows — "what task I got from the team lead".
  // Comments only exist on persisted rows, so this keys off today's report.
  const todayRowIds = (todayReport?.rows ?? []).map(r => r.id).join(',')
  useEffect(() => {
    const ids = todayRowIds ? todayRowIds.split(',').filter(Boolean) : []
    if (ids.length === 0) { setNotifComments([]); return }
    brandingApi.getRowComments(ids)
      .then(r => setNotifComments(r.comments))
      .catch(() => setNotifComments([]))
  }, [todayRowIds])

  // Only asked for once the window is actually open, so most of the month
  // this costs nothing.
  useEffect(() => {
    const d = new Date()
    if (d.getDate() < 20) { setAppraisalFiled(null); return }
    brandingApi.getSelfAppraisal(d.getMonth() + 1, d.getFullYear())
      .then(r => setAppraisalFiled(!!r.appraisal))
      .catch(() => setAppraisalFiled(null))
  }, [])

  const notifications = useMemo(() => {
    const now = new Date()
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    const dayMs = 86400000
    const items: {
      id: string; title: string; body: string
      type: 'warning' | 'info' | 'success'
      page?: NavPage
    }[] = []

    const mine = notifProjects.filter(pr =>
      pr.status !== 'completed' &&
      (pr.assigned_user_ids ?? []).includes(profile?.id ?? '') &&
      (pr.assignments ?? []).every(a => a.user_id !== profile?.id || a.status !== 'completed'))

    // 1. Someone on the team wrote on your work. Nothing else in the list is
    //    another person waiting on you, so it leads.
    for (const c of notifComments.filter(c => c.author_id !== profile?.id).slice(0, 3)) {
      items.push({
        id: `comment-${c.id}`,
        title: `Feedback from ${c.author_name || 'your lead'}`,
        body: c.body,
        type: 'info',
        page: 'daily-reports',
      })
    }

    // 1b. Your card moved on the Kanban board. One item per card, worded by
    //     the column it landed in, newest first. Your own moves (starting the
    //     timer) are skipped — you already know.
    const BOARD_MOVE: Record<string, { title: string; body: string; type: 'warning' | 'info' | 'success' }> = {
      notstarted: { title: 'Moved back to Not started', body: 'Your card was put back in the queue', type: 'info' },
      inprogress: { title: 'Moved to In progress', body: 'Your card is now being worked on', type: 'info' },
      review: { title: 'Sent for review', body: 'Your card is in the review column', type: 'info' },
      changes: { title: 'Changes requested', body: 'Your card is in Changes received — revise and resubmit', type: 'warning' },
      approved: { title: 'Approved', body: 'Your card was approved', type: 'success' },
      delivered: { title: 'Delivered', body: 'Your card was marked delivered', type: 'success' },
    }
    const moved = notifProjects
      .filter(pr => pr.board_moved_at
        && (pr.assigned_user_ids ?? []).includes(profile?.id ?? '')
        && pr.board_moved_by !== profile?.id
        && (now.getTime() - new Date(pr.board_moved_at).getTime()) / dayMs <= 7)
      .sort((a, b) => new Date(b.board_moved_at!).getTime() - new Date(a.board_moved_at!).getTime())
      .slice(0, 5)
    for (const pr of moved) {
      const spec = BOARD_MOVE[pr.board_status] ?? BOARD_MOVE.notstarted
      const who = users.find(u => u.id === pr.board_moved_by)
      const at = new Date(pr.board_moved_at!)
      const mins = Math.max(0, Math.round((now.getTime() - at.getTime()) / 60000))
      const ago = mins < 1 ? 'just now' : mins < 60 ? `${mins} min ago` : mins < 1440 ? `${Math.round(mins / 60)} hr ago`
        : at.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
      items.push({
        id: `moved-${pr.id}-${pr.board_status}`,
        title: `${spec.title}: ${pr.name}`,
        body: `${spec.body}${who ? ` · by ${who.full_name}` : ''} · ${ago}`,
        type: spec.type,
        page: 'daily-reports',
      })
    }

    // 2. Deadlines — overdue first, then anything inside a week.
    for (const pr of mine) {
      if (!pr.deadline) continue
      const due = new Date(pr.deadline)
      const days = Math.round((due.getTime() - startOfToday.getTime()) / dayMs)
      const when = due.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
      if (days < 0) {
        items.push({ id: `late-${pr.id}`, title: `Overdue: ${pr.name}`, body: `Was due ${when}`, type: 'warning', page: 'daily-reports' })
      } else if (days <= 7) {
        items.push({
          id: `due-${pr.id}`,
          title: `Deadline approaching: ${pr.name}`,
          body: days === 0 ? `Due today, ${when}` : `Due in ${days} ${days === 1 ? 'day' : 'days'} · ${when}`,
          type: 'warning',
          page: 'daily-reports',
        })
      }
    }

    // 3. Work handed to you in the last week.
    for (const pr of mine) {
      const age = (now.getTime() - new Date(pr.created_at).getTime()) / dayMs
      if (age > 7) continue
      const lead = users.find(u => u.id === pr.assigned_lead_id || u.id === pr.created_by)
      items.push({
        id: `new-${pr.id}`,
        title: 'New project assigned',
        body: lead ? `${pr.name} · from ${lead.full_name}` : pr.name,
        type: 'info',
        page: 'daily-reports',
      })
    }

    // 4. Things that finished. Only the last week, and only the three most
    //    recent, so a long history of delivered work does not bury the items
    //    that still need doing.
    const finished: { id: string; title: string; body: string; at: number }[] = []
    for (const pr of notifProjects) {
      const assignments = pr.assignments ?? []
      const mineOnIt = assignments.find(a => a.user_id === profile?.id)
      if (!mineOnIt) continue
      const allDone = assignments.length > 0 && assignments.every(a => a.status === 'completed')
      const stamps = assignments
        .map(a => (a.completed_at ? new Date(a.completed_at).getTime() : 0))
        .filter(t => t > 0)
      // Delivered by everyone: the moment the last assignee signed off.
      if (allDone && stamps.length > 0) {
        const at = Math.max(...stamps)
        if ((now.getTime() - at) / dayMs <= 7) {
          finished.push({
            id: `delivered-${pr.id}`,
            title: `Project delivered: ${pr.name}`,
            body: assignments.length > 1
              ? `All ${assignments.length} assignees have signed off`
              : 'Signed off and closed',
            at,
          })
        }
        continue
      }
      // Your half is in, the project is still open on someone else.
      if (mineOnIt.status === 'completed' && mineOnIt.completed_at) {
        const at = new Date(mineOnIt.completed_at).getTime()
        const waiting = assignments.filter(a => a.status !== 'completed').length
        if ((now.getTime() - at) / dayMs <= 7) {
          finished.push({
            id: `mydone-${pr.id}`,
            title: `You completed: ${pr.name}`,
            body: `Waiting on ${waiting} other ${waiting === 1 ? 'assignee' : 'assignees'}`,
            at,
          })
        }
      }
    }
    for (const f of finished.sort((a, b) => b.at - a.at).slice(0, 3)) {
      items.push({ id: f.id, title: f.title, body: f.body, type: 'success', page: 'daily-reports' })
    }

    // 5. Reports you filed in the last week, newest first — the same "this is
    //    done" signal for the other half of the portal. Today's own report is
    //    handled below, so it is excluded here to avoid saying it twice.
    // An empty report that happens to be locked is not an accomplishment, and
    // "0 hr logged" under a green dot reads as a bug. Only days with work on
    // them count.
    for (const rep of notifReports
      .filter(r => r.is_locked && r.report_date !== today()
        && (r.rows ?? []).some(row => timeToHours(row.time_taken) > 0))
      .sort((a, b) => b.report_date.localeCompare(a.report_date))
      .slice(0, 2)) {
      const d = parseDateLocal(rep.report_date)
      const hrs = (rep.rows ?? []).reduce((sum, row) => sum + timeToHours(row.time_taken), 0)
      items.push({
        id: `filed-${rep.id}`,
        title: 'Report submitted',
        body: `${d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' })} · ${fmtHours(hrs)} logged`,
        type: 'success',
        page: 'daily-reports',
      })
    }

    // 6. Your own day.
    items.push(todayReport?.is_locked
      ? {
          id: `report-${today()}`,
          title: "Today's report is filed",
          body: `Submitted for ${now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' })}`,
          type: 'success',
          page: 'daily-reports',
        }
      : {
          id: `report-${today()}`,
          title: "Today's Report",
          body: `Submit your daily report for ${now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' })}`,
          type: 'warning',
          page: 'daily-reports',
        })

    // 7. Appraisal window, but only while you still owe one.
    if (now.getDate() >= 20 && appraisalFiled === false) {
      items.push({
        id: `appraisal-${now.getFullYear()}-${now.getMonth() + 1}`,
        title: 'Self Appraisal Window Open',
        body: `Submit your KRA appraisal for ${MONTHS[now.getMonth()]}`,
        type: 'info',
        page: 'self-appraisal',
      })
    }

    // Warnings above everything else; the rest keep the order they were built.
    const rank = { warning: 0, info: 1, success: 2 }
    return items.sort((a, b) => rank[a.type] - rank[b.type])
  }, [notifProjects, notifComments, notifReports, todayReport, appraisalFiled, profile?.id, users])

  // Read state lives per user in localStorage. "Mark all as read" hides the
  // current items from the main list; the history toggle (clock icon in the
  // panel header) shows everything again, read items muted.
  const readKey = `nerve.notif.read.${profile?.id ?? 'anon'}`
  const [readIds, setReadIds] = useState<Set<string>>(() => new Set())
  const [showHistory, setShowHistory] = useState(false)
  useEffect(() => {
    try {
      const raw = localStorage.getItem(readKey)
      setReadIds(new Set(raw ? (JSON.parse(raw) as string[]) : []))
    } catch { setReadIds(new Set()) }
  }, [readKey])
  const markAllRead = () => {
    const next = new Set(readIds)
    for (const n of notifications) next.add(n.id)
    setReadIds(next)
    try { localStorage.setItem(readKey, JSON.stringify([...next])) } catch { /* session only */ }
  }
  const unreadNotifs = notifications.filter(n => !readIds.has(n.id))
  const visibleNotifs = showHistory ? notifications : unreadNotifs
  const unreadCount = unreadNotifs.length

  const [scheduleOpen, setScheduleOpen] = useState(false)

  // ── Quick "New report" sheet ────────────────────────────────────────────
  // Creating a row from the header writes straight to today's report through
  // the API rather than reaching into DailyReportsPage's state, which lives in
  // a sibling component. `reportVersion` is how that page finds out: it is a
  // dependency of its fetch, so bumping it re-reads the report it is showing.
  const [newReportOpen, setNewReportOpen] = useState(false)
  const [reportVersion, setReportVersion] = useState(0)
  const [nrCats, setNrCats] = useState<WorkCategory[]>([])
  const [nrType, setNrType] = useState('')
  const [nrSub, setNrSub] = useState('')
  const [nrWork, setNrWork] = useState('')
  const [nrSaving, setNrSaving] = useState(false)

  // Categories are only needed once the sheet is opened, so they are not part
  // of the shell's first paint.
  useEffect(() => {
    if (!newReportOpen || nrCats.length > 0) return
    brandingApi.getCategories()
      .then(r => setNrCats(r.categories))
      .catch(() => setNrCats([]))
  }, [newReportOpen, nrCats.length])

  const nrSubOptions = nrCats.find(c => c.name === nrType)?.sub_categories ?? []

  function closeNewReport() {
    setNewReportOpen(false)
    setNrType(''); setNrSub(''); setNrWork('')
  }

  async function createQuickReport(mode: 'start' | 'draft') {
    if (!nrType) { toast.error('Pick a work category.'); return }
    if (!nrWork.trim()) { toast.error('Describe what you worked on.'); return }
    setNrSaving(true)
    try {
      const rep = (await brandingApi.getReport(today())).report
      if (rep.is_locked) {
        toast.error("Today's report is already submitted.")
        return
      }
      const existing = rep.rows.map(row => ({
        sr_no: row.sr_no, type_of_work: row.type_of_work, sub_category: row.sub_category,
        specific_work: row.specific_work, time_taken: row.time_taken,
        collaborative_colleagues: row.collaborative_colleagues,
        stopwatch_status: row.stopwatch_status,
        elapsed_seconds: row.elapsed_seconds,
        stopwatch_started_at: row.stopwatch_started_at,
        carried_over_from_row_id: row.carried_over_from_row_id,
        project_id: row.project_id ?? null,
        last_paused_at: row.last_paused_at,
      }))
      // The sheet no longer asks for hours: the stopwatch in the report
      // table is what measures them. "Start working" therefore always begins
      // a running row, and "Save draft" always parks an idle one — there is
      // no third case where a row arrives already finished.
      const timed = mode === 'start'
      await brandingApi.saveRows(rep.id, [...existing, {
        sr_no: existing.length + 1,
        type_of_work: nrType,
        sub_category: nrSub,
        specific_work: nrWork.trim(),
        time_taken: '',
        collaborative_colleagues: [],
        stopwatch_status: (timed ? 'running' : 'idle') as StopwatchStatus,
        elapsed_seconds: 0,
        stopwatch_started_at: timed ? new Date().toISOString() : null,
        carried_over_from_row_id: null,
        last_paused_at: null,
        project_id: null,
      }])
      const updated = await brandingApi.getReport(today())
      setTodayReport(updated.report)
      setReportVersion(v => v + 1)
      closeNewReport()
      setActivePage('daily-reports')
      toast.success(timed
        ? 'Row added and the timer is running.'
        : 'Row saved to today\u2019s draft.')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to create the row')
    } finally {
      setNrSaving(false)
    }
  }
  const navItems: { key: NavPage; icon: React.ElementType; label: string; badge?: string }[] = [
    { key: 'dashboard', icon: LayoutGrid, label: 'Dashboard' },
    { key: 'daily-reports', icon: ClipboardList, label: 'Daily Reports', badge: todayReportStatus ?? undefined },
    { key: 'analytics', icon: BarChart2, label: 'Analytics' },
    { key: 'self-appraisal', icon: Award, label: 'Self Appraisal' },
    { key: 'gallery', icon: Layers, label: 'Design Gallery' },
    ...(role === 'sub_admin' || role === 'task_owner' || role === 'task_manager' ? [{ key: 'team' as NavPage, icon: LayoutGrid, label: 'Kanban Board' }, { key: 'members' as NavPage, icon: Users, label: 'Team Members' }] : []),
  ]

  const NavButton = ({ page, icon: Icon, label, dot }: { page: NavPage; icon: React.ElementType; label: string; dot?: 'amber' | 'green' }) => {
    const on = activePage === page
    return (
      <button type="button" onClick={() => gotoPage(page)} aria-current={on ? 'page' : undefined} className={cx(L.nav, on ? L.navOn : L.navOff)}>
        <Icon className={on ? L.navIconOn : L.navIcon} strokeWidth={1.75} />
        <span className="truncate flex-1">{label}</span>
        {dot && <span className={cx('w-1.5 h-1.5 rounded-full shrink-0', dot === 'green' ? 'bg-[#22C55E]' : 'bg-[#F59E0B]')} aria-hidden="true" />}
      </button>
    )
  }
  const isLead = role === 'sub_admin' || role === 'task_owner' || role === 'task_manager'
  const pageTitle = activePage === 'dashboard' ? 'Dashboard' : (PAGE_META[activePage]?.title || 'Dashboard')
  const dateChip = new Date().toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })

  return (
    <div className="nerve-light bg-white h-full">
      <div className={'flex h-full bg-white'}>
        {/* Mobile backdrop — only rendered when the drawer is open on phones */}
        {sidebarOpen && (
          <div
            className="md:hidden fixed inset-0 bg-[#111827]/30 z-40 nerve-overlay-in"
            onClick={() => setSidebarOpen(false)}
            aria-hidden="true"
          />
        )}

        {/* ── Sidebar (white, hairline, grouped nav, user card) ───────────── */}
        <aside
          className={cx(
            'w-56 bg-[#F3F4F6] border-r border-[#C5CAD1] flex flex-col h-full shrink-0 p-3',
            'fixed inset-y-0 z-50 transition-[left] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]',
            sidebarOpen ? 'left-0' : '-left-56',
            'md:static',
          )}
        >
          {/* Brand */}
          <div className="relative shrink-0 flex justify-start pl-1 pt-1.5 pb-0.5">
            {/* Wide lockup: Nerve wordmark with "powered by Parul University"
                beneath (216×57), left-aligned with the nav items. */}
            <BrandLogo variant="nerve" className="w-[155px] md:w-[175px]" />
            {/* Phones only: closes the slide-in drawer. On desktop the sidebar
                is fixed, so there is nothing to collapse. */}
            <button
              type="button"
              onClick={() => setSidebarOpen(false)}
              className={cx(L.iconGhost, 'md:hidden absolute right-0 top-0')}
              aria-label="Close menu"
              title="Close menu"
            >
              <PanelLeftClose className="w-4 h-4" strokeWidth={1.75} />
            </button>
          </div>


          <nav className="flex-1 overflow-y-auto scrollbar-none -mx-1 px-1 pb-2 mt-3">
            <p className={L.navGroup}>Main navigation</p>
            <div className="space-y-0.5">
              <NavButton page="dashboard" icon={LayoutGrid} label="Dashboard" />

              <NavButton
                page="daily-reports"
                icon={ClipboardList}
                label="Daily Reports"
                dot={todayReportStatus ? 'amber' : todayReport?.is_locked ? 'green' : undefined}
              />
              <NavButton page="analytics" icon={BarChart2} label="Analytics" />
              <NavButton page="self-appraisal" icon={Award} label="Self Appraisal" />
              <NavButton page="gallery" icon={Layers} label="Design Gallery" />
              {isLead && <NavButton page="team" icon={LayoutGrid} label="Kanban Board" />}
              {isLead && <NavButton page="members" icon={Users} label="Team Members" />}

              {(role === 'task_owner' || role === 'task_manager') && (
                <Link to="/branding/projects" className={cx(L.nav, L.navOff)}>
                  <FolderPlus className={L.navIcon} strokeWidth={1.75} />
                  <span className="truncate">Assign Projects</span>
                </Link>
              )}
              {(profile?.capabilities ?? []).map(rawKey => {
                const key = rawKey as CapabilityKey
                const meta = CAPABILITY_META[key]
                if (!meta) return null
                return (
                  <Link key={key} to={meta.route} className={cx(L.nav, L.navOff)}>
                    <Settings className={L.navIcon} strokeWidth={1.75} />
                    <span className="truncate">{meta.sidebarLabel}</span>
                  </Link>
                )
              })}
            </div>

            <p className={L.navGroup}>Support</p>
            <div className="space-y-0.5">
              <button
                type="button"
                onClick={() => {
                  setAvatarMenuOpen(false)
                  // Phones: a full page like every other section. Desktop: the
                  // drawer that slides out beside the sidebar.
                  if (window.matchMedia('(max-width: 767px)').matches) { setNotifOpen(false); gotoPage('notifications') }
                  else setNotifOpen(o => !o)
                }}
                aria-expanded={notifOpen}
                aria-controls="notification-drawer"
                className={cx(L.nav, (notifOpen || activePage === 'notifications') ? L.navOn : L.navOff)}
              >
                <Bell className={(notifOpen || activePage === 'notifications') ? L.navIconOn : L.navIcon} strokeWidth={1.75} />
                <span className="truncate flex-1">Notifications</span>
                {unreadCount > 0 && (
                  <span className="min-w-[18px] h-[18px] px-1 rounded-[5px] bg-[#F59E0B] text-white text-[11px] font-semibold grid place-items-center tabular-nums">{unreadCount}</span>
                )}
              </button>
              <NavButton page="settings" icon={User} label="Account" />
              <NavButton page="help" icon={HelpCircle} label="Help Center" />
              <button type="button" onClick={() => void signOut?.()} className={cx(L.nav, L.navOff)}>
                <LogOut className={L.navIcon} strokeWidth={1.75} />
                <span className="truncate flex-1">Logout</span>
              </button>
            </div>
          </nav>

          {/* User card — opens the account menu upwards */}
          <div className="pt-3 border-t border-[#C5CAD1] relative" data-avatar-menu="">
            <button
              type="button"
              onClick={() => { setAvatarMenuOpen(o => !o); setNotifOpen(false) }}
              aria-haspopup="menu"
              aria-expanded={avatarMenuOpen}
              className={cx(
                'w-full flex items-center gap-2.5 h-12 px-2.5 rounded-[6px] border bg-white transition-colors cursor-pointer',
                avatarMenuOpen ? 'border-[#9CA3AF]' : 'border-[#C5CAD1] hover:bg-[#F9FAFB]',
              )}
            >
              <Avatar url={profile?.avatar_url} name={profile?.full_name} email={profile?.email} size="sm" />
              <span className="min-w-0 flex-1 text-left">
                <span className="block text-[13px] font-semibold text-[#111827] truncate">{profile?.full_name || 'User'}</span>
                <span className="block text-[12px] text-[#6B7280] truncate">{profile?.email}</span>
              </span>
              <ChevronsUpDown className="w-4 h-4 text-[#9CA3AF] shrink-0" strokeWidth={1.75} />
            </button>

            {avatarMenuOpen && (
              <div role="menu" className="absolute left-0 right-0 bottom-[calc(100%-4px)] bg-white rounded-[6px] border border-[#C5CAD1] shadow-[0_12px_32px_-8px_rgba(16,24,40,0.2)] z-50 overflow-hidden animate-scale-in">
                <div className="px-3 py-2.5 border-b border-[#C5CAD1]">
                  <p className="text-[13px] font-semibold text-[#111827] truncate">{profile?.full_name || 'User'}</p>
                  <p className="text-[12px] text-[#6B7280] truncate">{getUserPosition(profile)}</p>
                </div>
                <div className="py-1">
                  {([
                    { icon: User, label: 'Account settings', run: () => gotoPage('settings') },
                    { icon: Calendar, label: "Today's schedule", run: () => { setSidebarOpen(false); setScheduleOpen(true) } },
                    { icon: Download, label: exporting ? 'Exporting…' : 'Export my reports (CSV)', run: () => { void handleExport() } },
                    { icon: HelpCircle, label: 'Help center', run: () => gotoPage('help') },
                  ] as const).map(item => (
                    <button
                      key={item.label}
                      role="menuitem"
                      onClick={() => { setAvatarMenuOpen(false); item.run() }}
                      className="w-full flex items-center gap-2.5 px-3 h-9 text-left text-[13px] text-[#111827] hover:bg-[#F9FAFB] transition-colors cursor-pointer"
                    >
                      <item.icon className="w-4 h-4 shrink-0 text-[#6B7280]" strokeWidth={1.75} />
                      <span className="truncate">{item.label}</span>
                    </button>
                  ))}
                </div>
                <div className="py-1 border-t border-[#C5CAD1]">
                  <button
                    role="menuitem"
                    onClick={() => { setAvatarMenuOpen(false); void signOut?.() }}
                    className="w-full flex items-center gap-2.5 px-3 h-9 text-left text-[13px] text-[#DC2626] hover:bg-[#FEF2F2] transition-colors cursor-pointer"
                  >
                    <LogOut className="w-4 h-4 shrink-0" strokeWidth={1.75} />
                    <span>Log out</span>
                  </button>
                </div>
              </div>
            )}
          </div>
        </aside>

        {/* ── Notification drawer: slides out from the sidebar's right edge ── */}
        {notifOpen && (
          <div className="fixed inset-0 z-30" onClick={() => setNotifOpen(false)} aria-hidden="true" />
        )}
        <aside
          id="notification-drawer"
          role="dialog"
          aria-label="Notifications"
          aria-hidden={!notifOpen}
          className={cx(
            'fixed inset-y-0 left-0 md:left-56 z-40 w-80 max-w-[calc(100vw-3.5rem)] bg-white border-r border-[#C5CAD1]',
            'shadow-[8px_0_24px_-12px_rgba(16,24,40,0.25)] flex flex-col',
            'transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]',
            notifOpen ? 'translate-x-0' : '-translate-x-[120%] pointer-events-none',
          )}
        >
          <div className="flex items-center justify-between px-4 h-12 border-b border-[#C5CAD1] shrink-0">
            <p className="text-[13px] font-semibold text-[#111827] flex items-center gap-2">
              {showHistory ? 'History' : 'Notifications'}
              {!showHistory && unreadCount > 0 && <Badge hue="amber">{unreadCount}</Badge>}
            </p>
            <span className="flex items-center gap-0.5">
              <button
                type="button"
                onClick={() => setShowHistory(v => !v)}
                aria-pressed={showHistory}
                className={cx(L.iconGhost, showHistory && 'bg-[#F3F4F6] text-[#111827]')}
                aria-label={showHistory ? 'Back to unread' : 'Show history'}
                title={showHistory ? 'Back to unread' : 'History · everything, including read items'}
              >
                <History className="w-3.5 h-3.5" strokeWidth={1.75} />
              </button>
              <button onClick={() => setNotifOpen(false)} className={L.iconGhost} aria-label="Close"><X className="w-3.5 h-3.5" strokeWidth={1.75} /></button>
            </span>
          </div>
          <div className="divide-y divide-[#C5CAD1] overflow-y-auto flex-1 min-h-0">
            {visibleNotifs.length === 0 && (
              <p className="px-4 py-10 text-center text-[12px] text-[#6B7280]">
                {showHistory ? 'No notifications yet.' : 'All caught up. Open history to see earlier items.'}
              </p>
            )}
            {visibleNotifs.map(n => (
              <button
                key={n.id}
                type="button"
                onClick={() => { if (n.page) { setNotifOpen(false); setActivePage(n.page) } }}
                className={cx('w-full text-left flex items-start gap-3 px-4 py-3 hover:bg-[#F9FAFB] transition-colors', n.page ? 'cursor-pointer' : 'cursor-default', readIds.has(n.id) && 'opacity-60')}
              >
                <IconTile
                  icon={n.type === 'warning' ? AlertCircle : n.type === 'success' ? CheckCircle2 : Info}
                  hue={n.type === 'warning' ? 'amber' : n.type === 'success' ? 'green' : 'blue'}
                />
                <div className="min-w-0">
                  <p className="text-[13px] font-semibold text-[#111827]">{n.title}</p>
                  <p className="text-[12px] text-[#6B7280] mt-0.5 leading-snug break-words">{n.body}</p>
                </div>
              </button>
            ))}
          </div>
          <div className="px-4 py-3 border-t border-[#C5CAD1] bg-[#F9FAFB] shrink-0">
            <button
              type="button"
              onClick={markAllRead}
              disabled={unreadCount === 0}
              className={cx(L.btn, L.btnPrimary, L.btnSm, 'w-full disabled:opacity-50 disabled:cursor-default')}
            >
              <CheckCheck className="w-3.5 h-3.5" strokeWidth={1.75} /> Mark all as read
            </button>
          </div>
        </aside>

        {/* ── Main ─────────────────────────────────────────────────────────── */}
        <div className="flex-1 h-full flex flex-col overflow-hidden min-w-0 bg-white">
          {/* Top bar: breadcrumb left, date, bell and settings right */}
          <header className="h-12 shrink-0 flex items-center justify-between gap-3 px-4 sm:px-6 border-b border-[#C5CAD1] bg-white z-20">
            <div className="flex items-center gap-2 min-w-0">
              <button
                type="button"
                onClick={() => setSidebarOpen(true)}
                className={cx(L.iconGhost, 'md:hidden -ml-2')}
                aria-label="Open menu"
              >
                <Menu className="w-4 h-4" strokeWidth={1.75} />
              </button>
              {/* Desktop: breadcrumb (Workspace / Page). Phones: just the page
                  name, there is no room for the trail next to the menu button. */}
              <nav className="hidden md:flex items-center gap-1.5 text-[13px] min-w-0" aria-label="Breadcrumb">
                <button
                  type="button"
                  onClick={() => gotoPage('dashboard')}
                  className="text-[#6B7280] hover:text-[#111827] transition-colors"
                >
                  Workspace
                </button>
                <span className="text-[#C5CAD1]" aria-hidden="true">/</span>
                <span className="font-medium text-[#111827] truncate" aria-current="page">{pageTitle}</span>
              </nav>
              <span className="md:hidden text-[13px] font-medium text-[#111827] truncate">{pageTitle}</span>
            </div>

            <div className="flex items-center gap-0.5">
              <span className="hidden md:inline-flex items-center gap-2 text-[12px] text-[#6B7280] mr-2 whitespace-nowrap" title={headerDate}>
                <span>{dateChip}</span>
                <span className="text-[#D1D5DB]" aria-hidden="true">·</span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-[#22C55E]" aria-hidden="true" />
                  Workspace live
                </span>
              </span>
              <span className="w-px h-5 bg-[#E5E7EB] mx-1.5 hidden sm:block" aria-hidden="true" />
              <button type="button" onClick={() => setNewReportOpen(true)} className={cx(L.btn, L.btnPrimary, L.btnSm)} title="Start a new report entry">
                <Plus className="w-4 h-4" strokeWidth={1.75} />
                <span className="hidden sm:inline">New report</span>
              </button>
              <ModeToggle className="ml-1.5 !w-8 !h-8" />
              <button type="button" onClick={() => setThemeOpen(true)} className={cx(L.iconBtnSm, 'ml-1', themeOpen && 'bg-[#F3F4F6] text-[#111827]')} aria-label="Appearance" title="Appearance · colour mode and primary colour">
                <Paintbrush className="w-4 h-4" strokeWidth={1.75} />
              </button>
              <Kebab
                size="sm"
                className="ml-1.5"
                items={[
                  { label: exporting ? 'Exporting…' : 'Export my reports (CSV)', onClick: () => { void handleExport() } },
                  { label: "Today's schedule", onClick: () => setScheduleOpen(true) },
                  { label: 'Help center', onClick: () => gotoPage('help') },
                ]}
              />
              <button type="button" onClick={() => gotoPage('settings')} className={cx(L.iconGhost, 'ml-1', activePage === 'settings' && 'bg-[#F3F4F6] text-[#111827]')} aria-label="Settings" title="Settings">
                <Settings className="w-4 h-4" strokeWidth={1.75} />
              </button>
            </div>
          </header>

          {/* Scrollable page content */}
          <main className="relative flex-1 min-h-0 overflow-y-auto overscroll-contain bg-[#F9FAFB] px-4 sm:px-6 pt-5 pb-8">
          {/* Keyed on the page so each switch re-mounts the wrapper and plays
              the rise-in once. */}
          <div key={activePage} className="nerve-page-in">
            {/* No page heading: the breadcrumb in the top bar names the page. */}

            {activePage === 'dashboard' && (
              <DashboardPage profile={profile} users={users} onNavigate={setActivePage}
                hasTeamPage={isLead} />
            )}
            {activePage === 'daily-reports' && (
              <DailyReportsPage profile={profile} users={users} reportVersion={reportVersion} />
            )}
            {activePage === 'analytics' && (
              <AnalyticsPage userId={profile?.id || ''} users={users} />
            )}
            {activePage === 'self-appraisal' && (
              <SelfAppraisalPage profile={profile} users={users} />
            )}
            {activePage === 'gallery' && <BrandingBrowse embedded />}
            {activePage === 'team' && <BrandingKanban embedded />}
            {activePage === 'members' && <BrandingTeamPanel />}
            {activePage === 'settings' && <SettingsPage profile={profile} />}
            {activePage === 'help' && <HelpPage onNavigate={setActivePage} />}
            {activePage === 'notifications' && (
              <div className={cx(L.card, 'overflow-hidden')}>
                <div className="flex items-center justify-between gap-2 px-4 h-12 border-b border-[#C5CAD1] bg-[#F9FAFB]">
                  <p className="text-[13px] font-semibold text-[#111827] flex items-center gap-2">
                    {showHistory ? 'History' : 'Unread'}
                    {!showHistory && unreadCount > 0 && <Badge hue="amber">{unreadCount}</Badge>}
                  </p>
                  <span className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => setShowHistory(v => !v)}
                      aria-pressed={showHistory}
                      className={cx(L.iconGhost, showHistory && 'bg-white border border-[#C5CAD1] text-[#111827]')}
                      aria-label={showHistory ? 'Back to unread' : 'Show history'}
                      title={showHistory ? 'Back to unread' : 'History · everything, including read items'}
                    >
                      <History className="w-4 h-4" strokeWidth={1.75} />
                    </button>
                    <button
                      type="button"
                      onClick={markAllRead}
                      disabled={unreadCount === 0}
                      className={cx(L.btn, L.btnPrimary, L.btnSm, 'disabled:opacity-50 disabled:cursor-default')}
                    >
                      <CheckCheck className="w-3.5 h-3.5" strokeWidth={1.75} /> Mark all as read
                    </button>
                  </span>
                </div>
                <div className="divide-y divide-[#C5CAD1]">
                  {visibleNotifs.length === 0 && (
                    <p className="px-4 py-10 text-center text-[12px] text-[#6B7280]">
                      {showHistory ? 'No notifications yet.' : 'All caught up. Open history to see earlier items.'}
                    </p>
                  )}
                  {visibleNotifs.map(n => (
                    <button
                      key={n.id}
                      type="button"
                      onClick={() => { if (n.page) setActivePage(n.page) }}
                      className={cx('w-full text-left flex items-start gap-3 px-4 py-3.5 hover:bg-[#F9FAFB] transition-colors', n.page ? 'cursor-pointer' : 'cursor-default', readIds.has(n.id) && 'opacity-60')}
                    >
                      <IconTile
                        icon={n.type === 'warning' ? AlertCircle : n.type === 'success' ? CheckCircle2 : Info}
                        hue={n.type === 'warning' ? 'amber' : n.type === 'success' ? 'green' : 'blue'}
                      />
                      <div className="min-w-0">
                        <p className="text-[13px] font-semibold text-[#111827]">{n.title}</p>
                        <p className="text-[12px] text-[#6B7280] mt-0.5 leading-snug break-words">{n.body}</p>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
          </main>
        </div>
      </div>

      {/* ── New Report sheet ─────────────────────────────────────────────── */}
      {/* Pick the work, describe it, start the clock. The row is written to
          today's report immediately, so it is on the Daily Reports table
          before the page even opens — the sheet is a shortcut into that
          table, not a second place where work is recorded. */}
      {newReportOpen && (
        <Modal
          size="lg"
          title="New daily report"
          subtitle="Adds a row to today's report."
          onClose={closeNewReport}
          footer={
            <>
              <button
                type="button"
                onClick={() => void createQuickReport('draft')}
                disabled={nrSaving || !nrType || !nrWork.trim()}
                className={cx(L.btn, L.btnSecondary)}
              >
                Save draft
              </button>
              <button
                type="button"
                onClick={() => void createQuickReport('start')}
                disabled={nrSaving || !nrType || !nrWork.trim()}
                className={cx(L.btn, L.btnPrimary)}
              >
                {nrSaving ? 'Saving…' : 'Start working'}
              </button>
            </>
          }
        >
          {/* Two columns for the short fields, one for the description —
              the shape the form actually has, rather than a single stack
              that made a four-field form scroll. */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-4">
            <div>
              <label htmlFor="nr-date" className={L.label}>Work date</label>
              {/* Reports are locked to today — a date you cannot change is
                  shown rather than hidden, so the row's date is never a
                  guess. */}
              <input
                id="nr-date"
                type="date"
                value={today()}
                disabled
                readOnly
                className={cx(L.input, 'cursor-not-allowed')}
              />
            </div>

            <div>
              <label htmlFor="nr-type" className={L.label}>
                Work category <span className="text-[#DC2626]">*</span>
              </label>
              <select
                id="nr-type"
                value={nrType}
                onChange={e => { setNrType(e.target.value); setNrSub('') }}
                className={L.select}
              >
                <option value="">{nrCats.length === 0 ? 'Loading…' : 'Select a category…'}</option>
                {nrCats.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
              </select>
            </div>

            <div>
              <label htmlFor="nr-sub" className={L.label}>Sub category</label>
              <select
                id="nr-sub"
                value={nrSub}
                onChange={e => setNrSub(e.target.value)}
                disabled={nrSubOptions.length === 0}
                className={L.select}
              >
                <option value="">
                  {!nrType ? 'Pick a category first…' : nrSubOptions.length === 0 ? 'None for this category' : 'Select…'}
                </option>
                {nrSubOptions.map(sub => <option key={sub.id} value={sub.name}>{sub.name}</option>)}
              </select>
            </div>

            <div className="sm:col-span-2">
              <label htmlFor="nr-work" className={L.label}>
                What did you work on? <span className="text-[#DC2626]">*</span>
              </label>
              <textarea
                id="nr-work"
                rows={4}
                value={nrWork}
                onChange={e => setNrWork(e.target.value)}
                placeholder="Briefly describe the deliverable and progress"
                className={L.textarea}
              />
            </div>
          </div>

          {/* Says which of the two buttons will do what, before you
              press one. */}
          <p className={cx(L.hint, 'mt-3')}>
            <span className="font-medium text-[#111827]">Start working</span> adds the row and starts its
            timer in today&rsquo;s report. <span className="font-medium text-[#111827]">Save draft</span> adds
            it paused, ready to start later. Hours are measured by the timer, so there is nothing to type.
          </p>
        </Modal>
      )}

      {/* ── Search Modal ──────────────────────────────────────────────────── */}
      {themeOpen && <ThemeModal onClose={() => setThemeOpen(false)} />}
      {searchOpen && (
        <div
          className={L.overlay}
          onClick={() => { setSearchOpen(false); setSearchQuery('') }}
          role="dialog"
          aria-modal="true"
          aria-label="Search"
        >
          <div
            className={cx(L.dialog, 'max-w-xl overflow-hidden')}
            onClick={e => e.stopPropagation()}
          >
            {/* Search input */}
            <div className="flex items-center gap-3 px-4 h-12 border-b border-[#C5CAD1]">
              <Search className="w-4 h-4 text-[#6B7280] shrink-0" strokeWidth={1.75} />
              <input
                autoFocus
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder="Search reports, projects, work types…"
                className="flex-1 text-[13px] bg-transparent outline-none text-[#111827] placeholder:text-[#9CA3AF]"
              />
              {searchQuery && (
                <button onClick={() => setSearchQuery('')} className={cx(L.iconGhost, '!w-7 !h-7')} aria-label="Clear">
                  <X className="w-3.5 h-3.5" strokeWidth={1.75} />
                </button>
              )}
              <kbd className="text-[11px] font-medium text-[#6B7280] bg-[#F3F4F6] border border-[#C5CAD1] rounded-[5px] px-1.5 py-0.5">ESC</kbd>
            </div>

            {/* Results */}
            <div className="max-h-96 overflow-y-auto">
              {searchLoading ? (
                <p className="text-[13px] text-[#6B7280] text-center py-8 animate-pulse">Loading…</p>
              ) : (
                <>
                  {/* Reports */}
                  {searchResults.reports.length > 0 && (
                    <div>
                      <p className={cx(L.eyebrow, 'px-4 pt-3 pb-1')}>Reports</p>
                      {searchResults.reports.map(r => (
                        <button
                          key={r.id}
                          onClick={() => { setSearchOpen(false); setSearchQuery(''); setActivePage('daily-reports') }}
                          className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-[#F9FAFB] text-left transition-colors cursor-pointer"
                        >
                          <IconTile icon={ClipboardList} hue={r.is_locked ? 'green' : 'amber'} size="sm" />
                          <div className="flex-1 min-w-0">
                            <p className="text-[13px] font-medium text-[#111827]">{new Date(r.report_date).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}</p>
                            <p className="text-[12px] text-[#6B7280] truncate">
                              {r.rows?.slice(0, 2).map(row => row.type_of_work).filter(Boolean).join(' · ') || 'No entries'}
                            </p>
                          </div>
                          <Badge hue={r.is_locked ? 'green' : 'amber'}>{r.is_locked ? 'Submitted' : 'Draft'}</Badge>
                        </button>
                      ))}
                    </div>
                  )}

                  {/* Projects */}
                  {searchResults.projects.length > 0 && (
                    <div>
                      <p className={cx(L.eyebrow, 'px-4 pt-3 pb-1')}>Projects</p>
                      {searchResults.projects.map(p => (
                        <button
                          key={p.id}
                          onClick={() => { setSearchOpen(false); setSearchQuery(''); setActivePage('daily-reports') }}
                          className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-[#F9FAFB] text-left transition-colors cursor-pointer"
                        >
                          <IconTile icon={LayoutGrid} hue="blue" size="sm" />
                          <div className="flex-1 min-w-0">
                            <p className="text-[13px] font-medium text-[#111827] truncate">{p.name}</p>
                            <p className="text-[12px] text-[#6B7280] truncate">{p.description || 'No description'}</p>
                          </div>
                          <Badge hue={p.status === 'active' ? 'green' : p.status === 'completed' ? 'grey' : 'amber'}>
                            {p.status === 'active' ? 'Running' : p.status === 'completed' ? 'Done' : 'On Hold'}
                          </Badge>
                        </button>
                      ))}
                    </div>
                  )}

                  {!searchLoading && searchResults.reports.length === 0 && searchResults.projects.length === 0 && (
                    <EmptyState icon={Search} title={searchQuery ? `No results for "${searchQuery}"` : 'Start typing to search'} />
                  )}
                </>
              )}
            </div>

            <div className="px-4 py-2.5 border-t border-[#C5CAD1] flex items-center gap-4 text-[11px] text-[#9CA3AF]">
              <span><kbd className="border border-[#C5CAD1] rounded-[5px] px-1">↑↓</kbd> navigate</span>
              <span><kbd className="border border-[#C5CAD1] rounded-[5px] px-1">↵</kbd> open</span>
              <span><kbd className="border border-[#C5CAD1] rounded-[5px] px-1">ESC</kbd> close</span>
            </div>
          </div>
        </div>
      )}

      {/* ── Today's Schedule Center Popup Modal ────────────────────────────── */}
      <TodayScheduleModal
        isOpen={scheduleOpen}
        onClose={() => setScheduleOpen(false)}
        todayReport={todayReport}
        onNavigate={gotoPage}
        profile={profile}
        users={users}
      />
    </div>
  )
}
