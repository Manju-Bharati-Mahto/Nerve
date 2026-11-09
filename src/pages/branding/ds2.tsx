/**
 * Nerve Light — design system 2 for the branding portal.
 *
 * Extracted from the "Kravio" dashboard reference. Everything below is the
 * look only; data, features and copy stay what Nerve already has.
 *
 * ── Canvas ────────────────────────────────────────────────────────────────
 *   page            white, edge to edge (no outer padding)
 *   app frame       none: sidebar and content sit directly on the viewport; the
 *                   sidebar and the content both sit inside this one frame
 *   sidebar         #F3F4F6 (grey-100), 224px, 1px right border; content canvas white
 *
 * ── Type ──────────────────────────────────────────────────────────────────
 *   family          Inter (fallback system-ui)
 *   greeting        24px / 600 / -0.01em, ink
 *   page sub        13px / 400, grey-500
 *   card title      14px / 600, ink
 *   stat figure     28px / 600 / -0.02em, tabular
 *   body            13px / 400–500, ink or grey-600
 *   meta            12px / 400, grey-500
 *   eyebrow         11px / 500 / uppercase / 0.06em, grey-500
 *
 * ── Colour ────────────────────────────────────────────────────────────────
 *   ink             #111827      secondary #6B7280   tertiary #9CA3AF
 *   border          #C5CAD1 (a touch darker than grey-300; grey-200 read too faint)   muted bg #F9FAFB
 *   accent (brand blue) var(--nerve-primary), hover var(--nerve-primary-dark) — active pill, highlighted bar, primary button, avatar fallback
 *   success         #16A34A on #ECFDF5    danger #DC2626 on #FEF2F2
 *   info            #3B82F6 on #EFF6FF    violet #8B5CF6 on #F5F3FF
 *   amber           #F59E0B on #FFFBEB    cyan   #06B6D4 on #ECFEFF
 *   chart           bars #E5E7EB, highlight var(--nerve-primary), dashed guide #9CA3AF,
 *                   sparkline up #22C55E / down #EF4444
 *
 * ── Shape ─────────────────────────────────────────────────────────────────
 *   cards 6px, controls 4px, pills 4px, icon tiles 4px, avatars round (near-square, slightly softened corners)
 *   borders 1px, shadows ≤ 0 1px 2px rgba(16,24,40,.04)
 *   card padding 16px, grid gap 16px, control height 36px, icon tile 32px
 *
 * ── Icons ─────────────────────────────────────────────────────────────────
 *   lucide, 16px, stroke 1.75, grey-500; in tinted 32px tiles for lists
 */
import { useEffect, useState, type ReactNode, type ElementType } from 'react'
import { ChevronDown, MoreVertical, Search, Check, ArrowUpDown, Calendar } from 'lucide-react'

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

// ── Tokens ────────────────────────────────────────────────────────────────

export const L = {
  font: 'font-[Inter,system-ui,sans-serif]',
  page: 'bg-[#F3F4F6]',
  /** Edge-to-edge: the app fills the viewport with no outer frame. */
  frame: 'bg-white overflow-hidden',

  ink: 'text-[#111827]',
  sub: 'text-[#6B7280]',
  faint: 'text-[#9CA3AF]',
  border: 'border-[#C5CAD1]',

  /** Card surface: white, hairline, 12px. */
  card: 'bg-white border border-[#C5CAD1] rounded-[6px] transition-colors duration-150 hover:border-[var(--nerve-primary)]',
  cardPad: 'p-4',
  /** Header row inside a card: title left, controls right, hairline below. */
  cardHead: 'flex items-center justify-between gap-3 px-4 py-3 border-b border-[#C5CAD1]',
  cardTitle: 'text-[14px] font-semibold text-[#111827] tracking-[-0.005em] flex items-center gap-2',

  greeting: 'text-[24px] font-semibold text-[#111827] tracking-[-0.01em] leading-tight',
  pageSub: 'text-[13px] text-[#6B7280] mt-1',
  eyebrow: 'text-[11px] font-medium uppercase tracking-[0.06em] text-[#6B7280]',
  figure: 'text-[28px] font-semibold text-[#111827] tracking-[-0.02em] tabular-nums leading-none',
  body: 'text-[13px] text-[#111827]',
  meta: 'text-[12px] text-[#6B7280]',

  /** Controls — 36px tall, 8px radius, hairline. */
  input: 'h-9 w-full bg-white text-[13px] px-3 rounded-[6px] border border-[#C5CAD1] text-[#111827] placeholder:text-[#9CA3AF] focus:outline-none focus:border-[#9CA3AF] focus:ring-2 focus:ring-[#111827]/5 transition-colors disabled:bg-[#F9FAFB] disabled:text-[#9CA3AF]',
  select: 'h-9 w-full bg-white text-[13px] pl-3 pr-8 rounded-[6px] border border-[#C5CAD1] text-[#111827] appearance-none select-chevron focus:outline-none focus:border-[#9CA3AF] focus:ring-2 focus:ring-[#111827]/5 transition-colors cursor-pointer disabled:bg-[#F9FAFB] disabled:text-[#9CA3AF]',
  textarea: 'w-full bg-white text-[13px] px-3 py-2 rounded-[6px] border border-[#C5CAD1] text-[#111827] placeholder:text-[#9CA3AF] focus:outline-none focus:border-[#9CA3AF] focus:ring-2 focus:ring-[#111827]/5 transition-colors resize-y',
  label: 'block text-[12px] font-medium text-[#111827] mb-1.5',
  hint: 'text-[12px] text-[#6B7280] mt-1.5',

  btn: 'inline-flex items-center justify-center gap-1.5 h-9 px-3.5 rounded-[6px] text-[13px] font-medium transition-colors cursor-pointer whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed',
  btnPrimary: 'bg-[var(--nerve-primary)] text-[var(--nerve-on-primary)] hover:bg-[var(--nerve-primary-dark)]',
  btnSecondary: 'bg-white border border-[#C5CAD1] text-[#111827] hover:bg-[#F9FAFB]',
  btnGhost: 'text-[#6B7280] hover:bg-[#F3F4F6] hover:text-[#111827]',
  btnDanger: 'bg-white border border-[#FECACA] text-[#DC2626] hover:bg-[#FEF2F2]',
  btnSuccess: 'bg-[#16A34A] text-white hover:bg-[#15803D]',
  btnSm: '!h-8 !px-3 !text-[12px]',
  /** Square icon button, hairline. */
  iconBtn: 'inline-flex items-center justify-center w-9 h-9 rounded-[6px] border border-[#C5CAD1] bg-white text-[#6B7280] hover:text-[#111827] hover:bg-[#F9FAFB] transition-colors cursor-pointer disabled:opacity-50',
  iconBtnSm: 'inline-flex items-center justify-center w-8 h-8 rounded-[6px] border border-[#C5CAD1] bg-white text-[#6B7280] hover:text-[#111827] hover:bg-[#F9FAFB] transition-colors cursor-pointer disabled:opacity-50',
  /** Bare icon button (top bar bell / gear). */
  iconGhost: 'inline-flex items-center justify-center w-8 h-8 rounded-[6px] text-[#6B7280] hover:text-[#111827] hover:bg-[#F3F4F6] transition-colors cursor-pointer',

  /** Sidebar nav item. */
  nav: 'w-full flex items-center gap-2.5 h-9 px-3 rounded-[6px] text-[13px] font-medium transition-colors text-left cursor-pointer',
  navOn: 'bg-white text-[#111827] border border-[#C5CAD1] shadow-[0_1px_2px_rgba(16,24,40,0.04)]',
  navOff: 'text-[#374151] hover:bg-[#E5E7EB] border border-transparent',
  navIcon: 'w-4 h-4 shrink-0 text-[#6B7280]',
  navIconOn: 'w-4 h-4 shrink-0 text-[#111827]',
  navGroup: 'text-[11px] font-medium uppercase tracking-[0.06em] text-[#6B7280] px-3 mt-5 mb-2',

  /** Tables. */
  table: 'w-full text-[13px]',
  thead: 'bg-[#F9FAFB]',
  th: 'text-left px-4 h-10 text-[12px] font-medium text-[#6B7280] whitespace-nowrap',
  td: 'px-4 py-3 text-[#111827] border-t border-[#C5CAD1] align-middle',
  trHover: 'hover:bg-[#F9FAFB] transition-colors',

  divider: 'border-t border-[#C5CAD1]',
  overlay: 'fixed inset-0 !m-0 bg-[#111827]/30 z-50 flex items-start justify-center pt-16 sm:pt-24 px-4 overflow-y-auto nerve-overlay-in',
  dialog: 'w-full bg-white rounded-[8px] border border-[#C5CAD1] shadow-[0_24px_48px_-12px_rgba(16,24,40,0.25)] mb-16 animate-scale-in',
} as const

/** Status/tint palette for icons tiles, badges and dots. */
export type Hue = 'blue' | 'green' | 'violet' | 'red' | 'amber' | 'cyan' | 'grey' | 'dark'
export const HUE: Record<Hue, { tile: string; icon: string; text: string; dot: string; badge: string }> = {
  blue:   { tile: 'bg-[var(--nerve-primary-soft)] border-[var(--nerve-primary-soft-border)]', icon: 'text-[var(--nerve-primary-text)]', text: 'text-[var(--nerve-primary-text)]', dot: 'bg-[var(--nerve-primary)]', badge: 'bg-[var(--nerve-primary-soft)] text-[var(--nerve-primary-text)] border-[var(--nerve-primary-soft-border)]' },
  green:  { tile: 'bg-[#ECFDF5] border-[#D1FAE5]', icon: 'text-[#10B981]', text: 'text-[#16A34A]', dot: 'bg-[#22C55E]', badge: 'bg-[#ECFDF5] text-[#047857] border-[#D1FAE5]' },
  violet: { tile: 'bg-[#F5F3FF] border-[#EDE9FE]', icon: 'text-[#8B5CF6]', text: 'text-[#7C3AED]', dot: 'bg-[#8B5CF6]', badge: 'bg-[#F5F3FF] text-[#6D28D9] border-[#EDE9FE]' },
  red:    { tile: 'bg-[#FEF2F2] border-[#FEE2E2]', icon: 'text-[#EF4444]', text: 'text-[#DC2626]', dot: 'bg-[#EF4444]', badge: 'bg-[#FEF2F2] text-[#B91C1C] border-[#FEE2E2]' },
  amber:  { tile: 'bg-[#FFFBEB] border-[#FEF3C7]', icon: 'text-[#F59E0B]', text: 'text-[#B45309]', dot: 'bg-[#F59E0B]', badge: 'bg-[#FFFBEB] text-[#B45309] border-[#FEF3C7]' },
  cyan:   { tile: 'bg-[#ECFEFF] border-[#CFFAFE]', icon: 'text-[#06B6D4]', text: 'text-[#0E7490]', dot: 'bg-[#06B6D4]', badge: 'bg-[#ECFEFF] text-[#0E7490] border-[#CFFAFE]' },
  grey:   { tile: 'bg-[#F9FAFB] border-[#C5CAD1]', icon: 'text-[#6B7280]', text: 'text-[#6B7280]', dot: 'bg-[#9CA3AF]', badge: 'bg-[#F9FAFB] text-[#374151] border-[#C5CAD1]' },
  dark:   { tile: 'bg-[var(--nerve-primary)] border-[var(--nerve-primary)]', icon: 'text-[var(--nerve-on-primary)]',     text: 'text-[#111827]', dot: 'bg-[var(--nerve-primary)]', badge: 'bg-[var(--nerve-primary)] text-[var(--nerve-on-primary)] border-[var(--nerve-primary)]' },
}

export function hueForStatus(status?: string | null): Hue {
  switch ((status ?? '').toLowerCase()) {
    case 'approved': case 'completed': case 'submitted': case 'finished': case 'published': case 'delivered': case 'done': case 'success': return 'green'
    case 'pending': case 'running': case 'in_progress': case 'in-progress': case 'in progress': case 'draft': case 'paused': return 'amber'
    case 'rejected': case 'overdue': case 'cancelled': case 'canceled': case 'failed': case 'missing': case 'blocked': return 'red'
    case 'review': case 'in review': case 'idle': case 'open': return 'blue'
    default: return 'grey'
  }
}

/** Chart colours for Recharts. */
export const CHART2 = {
  bar: 'var(--nv-line)',
  barHover: 'var(--nv-line-strong)',
  highlight: 'var(--nerve-primary)',
  guide: 'var(--nv-faint)',
  grid: 'var(--nv-raised)',
  tick: 'var(--nv-sub)',
  up: '#22C55E',
  down: '#EF4444',
  upFill: 'rgba(34,197,94,0.10)',
  downFill: 'rgba(239,68,68,0.10)',
  ramp: ['var(--nerve-primary)', '#374151', 'var(--nv-sub)', 'var(--nv-faint)', 'var(--nv-line-strong)', 'var(--nv-line)'],
  series: ['var(--nerve-primary)', '#10B981', '#8B5CF6', '#F59E0B', '#EF4444', '#06B6D4', '#EC4899', '#84CC16'],
} as const

// ── Components ────────────────────────────────────────────────────────────

/** Small tinted square holding an icon (activity rows, card titles). */
export function IconTile({ icon: Icon, hue = 'grey', size = 'md', className }: { icon: ElementType; hue?: Hue; size?: 'sm' | 'md'; className?: string }) {
  return (
    <span className={cx('inline-flex items-center justify-center rounded-[6px] border shrink-0', size === 'sm' ? 'w-7 h-7' : 'w-8 h-8', HUE[hue].tile, className)}>
      <Icon className={cx(size === 'sm' ? 'w-3.5 h-3.5' : 'w-4 h-4', HUE[hue].icon)} strokeWidth={1.75} />
    </span>
  )
}

/** Hairline pill badge. */
export function Badge({ hue = 'grey', children, className, dot }: { hue?: Hue; children: ReactNode; className?: string; dot?: boolean }) {
  return (
    <span className={cx('inline-flex items-center gap-1.5 h-6 px-2 rounded-[5px] border text-[12px] font-medium whitespace-nowrap', HUE[hue].badge, className)}>
      {dot && <span className={cx('w-1.5 h-1.5 rounded-full', HUE[hue].dot)} />}
      {children}
    </span>
  )
}

/** Status with a leading icon, as in the table ("In Review", "Delivered"). */
export function StatusText({ icon: Icon, hue = 'grey', children, className }: { icon: ElementType; hue?: Hue; children: ReactNode; className?: string }) {
  return (
    <span className={cx('inline-flex items-center gap-1.5 text-[13px] text-[#111827] whitespace-nowrap', className)}>
      <Icon className={cx('w-4 h-4', HUE[hue].icon)} strokeWidth={1.75} /> {children}
    </span>
  )
}

/** Three signal bars for priority: high = 3 red, medium = 2 amber, low = 1 green. */
export function PriorityBars({ level, label, className }: { level: 'high' | 'medium' | 'low'; label?: string; className?: string }) {
  const n = level === 'high' ? 3 : level === 'medium' ? 2 : 1
  const color = level === 'high' ? 'bg-[#EF4444]' : level === 'medium' ? 'bg-[#F59E0B]' : 'bg-[#22C55E]'
  return (
    <span className={cx('inline-flex items-center gap-2 text-[13px] text-[#111827]', className)}>
      <span className="inline-flex items-end gap-[2px] h-3.5" aria-hidden="true">
        {[1, 2, 3].map(i => <span key={i} className={cx('w-[3px] rounded-[3px]', i <= n ? color : 'bg-[#E5E7EB]')} style={{ height: `${4 + i * 3}px` }} />)}
      </span>
      {label ?? (level[0].toUpperCase() + level.slice(1))}
    </span>
  )
}

/** Signed delta: "+7.1% vs last week". */
export function Delta({ value, suffix = 'vs last period', className, unit = '%' }: { value: number; suffix?: string; className?: string; unit?: string }) {
  const up = value >= 0
  return (
    <span className={cx('inline-flex items-baseline gap-1 text-[12px]', className)}>
      <span className={cx('font-medium', up ? 'text-[#16A34A]' : 'text-[#DC2626]')}>{up ? '+' : ''}{Number.isInteger(value) ? value : value.toFixed(1)}{unit}</span>
      <span className="text-[#6B7280]">{suffix}</span>
    </span>
  )
}

/** Tiny line chart with a soft fill, green when rising, red when falling. */
export function Sparkline({ data, width = 96, height = 36, tone, className }: { data: number[]; width?: number; height?: number; tone?: 'up' | 'down'; className?: string }) {
  if (data.length < 2) return <span className={cx('inline-block', className)} style={{ width, height }} />
  const max = Math.max(...data), min = Math.min(...data)
  const span = max - min || 1
  const pts = data.map((v, i) => [ (i / (data.length - 1)) * (width - 2) + 1, height - 3 - ((v - min) / span) * (height - 6) ] as const)
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ')
  const area = `${d} L${pts[pts.length - 1][0].toFixed(1)},${height} L${pts[0][0].toFixed(1)},${height} Z`
  const dir = tone ?? (data[data.length - 1] >= data[0] ? 'up' : 'down')
  const stroke = dir === 'up' ? CHART2.up : CHART2.down
  const fill = dir === 'up' ? CHART2.upFill : CHART2.downFill
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className={cx('shrink-0', className)} aria-hidden="true">
      <path d={area} fill={fill} />
      <path d={d} fill="none" stroke={stroke} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}

/** KPI card: title + icon, figure, delta, sparkline on the right. */
export function StatCard({ title, icon: Icon, value, delta, deltaSuffix, spark, sub, onClick, className }: {
  title: string; icon?: ElementType; value: ReactNode
  delta?: number; deltaSuffix?: string; spark?: number[]; sub?: ReactNode
  onClick?: () => void; className?: string
}) {
  return (
    <div onClick={onClick} className={cx(L.card, 'flex flex-col', onClick && 'cursor-pointer', className)}>
      <div className="flex items-center justify-between gap-3 px-4 pt-3.5 pb-2">
        <p className="text-[14px] font-semibold text-[#111827]">{title}</p>
        {Icon && <Icon className="w-4 h-4 text-[#6B7280]" strokeWidth={1.75} />}
      </div>
      <div className="flex items-end justify-between gap-3 px-4 pb-4 mt-auto">
        <div className="min-w-0">
          <p className={L.figure}>{value}</p>
          <div className="mt-2 min-h-[16px]">
            {delta !== undefined ? <Delta value={delta} suffix={deltaSuffix} /> : sub ? <p className={L.meta}>{sub}</p> : null}
          </div>
        </div>
        {spark && spark.length > 1 && <Sparkline data={spark} />}
      </div>
    </div>
  )
}

/** Segmented control with a dark active pill (Today / Yesterday / This week). */
export function Segmented<T extends string>({ value, onChange, options, className, size = 'md' }: {
  value: T; onChange: (v: T) => void; options: { id: T; label: ReactNode }[]; className?: string; size?: 'sm' | 'md'
}) {
  return (
    <div role="tablist" className={cx('inline-flex items-center gap-1', className)}>
      {options.map(o => {
        const on = o.id === value
        return (
          <button key={o.id} type="button" role="tab" aria-selected={on} onClick={() => onChange(o.id)}
            className={cx(
              'rounded-[6px] text-[13px] font-medium transition-colors cursor-pointer whitespace-nowrap border',
              size === 'sm' ? 'h-8 px-3 text-[12px]' : 'h-9 px-3.5',
              on ? 'bg-[var(--nerve-primary)] text-[var(--nerve-on-primary)] border-[var(--nerve-primary)]' : 'bg-white text-[#374151] border-[#C5CAD1] hover:bg-[#F9FAFB]',
            )}>
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

/** Hairline dropdown pill ("Last week ▾"). The menu is a simple list. */
export function DropdownPill<T extends string>({ value, onChange, options, icon: Icon = Calendar, className, align = 'right' }: {
  value: T; onChange: (v: T) => void; options: { id: T; label: ReactNode }[]; icon?: ElementType | null; className?: string; align?: 'left' | 'right'
}) {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!open) return
    const h = (e: MouseEvent) => { if (!(e.target as HTMLElement).closest('[data-dd]')) setOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [open])
  const current = options.find(o => o.id === value)
  return (
    <div className={cx('relative', className)} data-dd="">
      <button type="button" onClick={() => setOpen(o => !o)} aria-haspopup="listbox" aria-expanded={open}
        className={cx(L.btn, L.btnSecondary, 'gap-2')}>
        {Icon && <Icon className="w-4 h-4 text-[#6B7280]" strokeWidth={1.75} />}
        <span>{current?.label}</span>
        <ChevronDown className="w-3.5 h-3.5 text-[#6B7280]" />
      </button>
      {open && (
        <div role="listbox" className={cx('absolute top-10 w-44 bg-white rounded-[6px] border border-[#C5CAD1] shadow-[0_8px_24px_-8px_rgba(16,24,40,0.2)] z-40 py-1 animate-scale-in', align === 'right' ? 'right-0' : 'left-0')}>
          {options.map(o => (
            <button key={o.id} type="button" role="option" aria-selected={o.id === value} onClick={() => { onChange(o.id); setOpen(false) }}
              className="w-full flex items-center justify-between gap-2 px-3 h-9 text-[13px] text-[#111827] hover:bg-[#F9FAFB] text-left cursor-pointer">
              {o.label}{o.id === value && <Check className="w-3.5 h-3.5 text-[#6B7280]" />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** Kebab menu button with a list of actions. */
export function Kebab({ items, className, size = 'md' }: { items: { label: ReactNode; onClick: () => void; danger?: boolean }[]; className?: string; size?: 'sm' | 'md' }) {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!open) return
    const h = (e: MouseEvent) => { if (!(e.target as HTMLElement).closest('[data-kebab]')) setOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [open])
  return (
    <div className={cx('relative', className)} data-kebab="">
      <button type="button" onClick={() => setOpen(o => !o)} aria-label="More" className={size === 'sm' ? L.iconBtnSm : L.iconBtn}>
        <MoreVertical className="w-4 h-4" strokeWidth={1.75} />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-10 w-44 bg-white rounded-[6px] border border-[#C5CAD1] shadow-[0_8px_24px_-8px_rgba(16,24,40,0.2)] z-40 py-1 animate-scale-in">
          {items.map((it, i) => (
            <button key={i} type="button" role="menuitem" onClick={() => { setOpen(false); it.onClick() }}
              className={cx('w-full px-3 h-9 text-[13px] text-left hover:bg-[#F9FAFB] cursor-pointer', it.danger ? 'text-[#DC2626]' : 'text-[#111827]')}>
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** Search field with a leading icon (and optional ⌘K hint). */
export function SearchField({ value, onChange, placeholder = 'Search', hint, className, onFocus, readOnly }: {
  value?: string; onChange?: (v: string) => void; placeholder?: string; hint?: string; className?: string; onFocus?: () => void; readOnly?: boolean
}) {
  return (
    <div className={cx('relative', className)}>
      <Search className="w-4 h-4 text-[#6B7280] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" strokeWidth={1.75} />
      <input value={value ?? ''} onChange={e => onChange?.(e.target.value)} onFocus={onFocus} readOnly={readOnly} placeholder={placeholder}
        className={cx(L.input, '!pl-9', hint && '!pr-12', readOnly && 'cursor-pointer')} />
      {hint && <kbd className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[11px] font-medium text-[#6B7280] bg-[#F3F4F6] border border-[#C5CAD1] rounded-[5px] px-1.5 py-0.5">{hint}</kbd>}
    </div>
  )
}

/** Card with the standard header row. */
export function Card({ title, icon: Icon, action, children, className, bodyClassName, padded = true }: {
  title?: ReactNode; icon?: ElementType; action?: ReactNode; children?: ReactNode; className?: string; bodyClassName?: string; padded?: boolean
}) {
  return (
    <div className={cx(L.card, 'flex flex-col min-w-0', className)}>
      {(title || action) && (
        <div className={L.cardHead}>
          <h3 className={L.cardTitle}>{Icon && <Icon className="w-4 h-4 text-[#6B7280]" strokeWidth={1.75} />}{title}</h3>
          {action && <div className="flex items-center gap-2 shrink-0">{action}</div>}
        </div>
      )}
      {children !== undefined && <div className={cx(padded && L.cardPad, 'min-w-0', bodyClassName)}>{children}</div>}
    </div>
  )
}

/** Activity row: tinted icon tile, bold title, meta line, time on the right. */
export function ActivityItem({ icon, hue = 'blue', title, meta, time, onClick, className }: {
  icon: ElementType; hue?: Hue; title: ReactNode; meta?: ReactNode; time?: ReactNode; onClick?: () => void; className?: string
}) {
  const Tag: 'button' | 'div' = onClick ? 'button' : 'div'
  return (
    <Tag type={onClick ? 'button' : undefined} onClick={onClick}
      className={cx('w-full flex items-start gap-3 py-3 text-left', onClick && 'cursor-pointer hover:bg-[#F9FAFB] -mx-2 px-2 rounded-[6px] transition-colors', className)}>
      <IconTile icon={icon} hue={hue} />
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-3">
          <p className="text-[13px] font-semibold text-[#111827] truncate">{title}</p>
          {time && <span className="text-[12px] text-[#6B7280] shrink-0">{time}</span>}
        </div>
        {meta && <p className="text-[12px] text-[#6B7280] mt-0.5 truncate">{meta}</p>}
      </div>
    </Tag>
  )
}

/** Round avatar, initials fallback on dark. */
export function Avatar({ url, name, email, size = 'md', className }: { url?: string | null; name?: string | null; email?: string | null; size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl'; className?: string }) {
  const dims = { xs: 'w-5 h-5 text-[9px]', sm: 'w-7 h-7 text-[11px]', md: 'w-8 h-8 text-[12px]', lg: 'w-10 h-10 text-[14px]', xl: 'w-14 h-14 text-[18px]' }[size]
  const initials = (name?.trim() || email || 'U').split(/\s+/).map(s => s[0]).slice(0, 2).join('').toUpperCase()
  return url
    ? <img src={url} alt={name || 'avatar'} className={cx(dims, 'rounded-full object-cover shrink-0 border border-[#C5CAD1]', className)} />
    : <span className={cx(dims, 'rounded-full bg-[var(--nerve-primary)] text-[var(--nerve-on-primary)] font-semibold grid place-items-center shrink-0', className)} aria-hidden="true">{initials}</span>
}

/** Sortable table header cell label with the sort glyph. */
export function Th({ children, sortable, className, align = 'left' }: { children: ReactNode; sortable?: boolean; className?: string; align?: 'left' | 'right' | 'center' }) {
  return (
    <th className={cx(L.th, align === 'right' && 'text-right', align === 'center' && 'text-center', className)}>
      <span className="inline-flex items-center gap-1.5">{children}{sortable && <ArrowUpDown className="w-3 h-3 text-[#9CA3AF]" />}</span>
    </th>
  )
}

/** Checkbox styled like the table's. */
export function Checkbox({ checked, onChange, ariaLabel }: { checked: boolean; onChange: (v: boolean) => void; ariaLabel?: string }) {
  return (
    <button type="button" role="checkbox" aria-checked={checked} aria-label={ariaLabel} onClick={() => onChange(!checked)}
      className={cx('w-4 h-4 rounded-[5px] border grid place-items-center transition-colors cursor-pointer', checked ? 'bg-[var(--nerve-primary)] border-[var(--nerve-primary)] text-white' : 'bg-white border-[#C5CAD1] hover:border-[#9CA3AF]')}>
      {checked && <Check className="w-3 h-3" strokeWidth={3} />}
    </button>
  )
}

/** Centred dialog. */
export function Modal({ title, subtitle, onClose, children, footer, size = 'md', className }: {
  title?: ReactNode; subtitle?: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; size?: 'sm' | 'md' | 'lg' | 'xl'; className?: string
}) {
  const width = { sm: 'max-w-md', md: 'max-w-xl', lg: 'max-w-2xl', xl: 'max-w-4xl' }[size]
  return (
    <div className={L.overlay} onClick={onClose} role="dialog" aria-modal="true">
      <div className={cx(L.dialog, width, 'flex flex-col max-h-[calc(100vh-6rem)]', className)} onClick={e => e.stopPropagation()}>
        {(title || subtitle) && (
          <div className="px-5 pt-5 pb-4 border-b border-[#C5CAD1]">
            {title && <h2 className="text-[16px] font-semibold text-[#111827]">{title}</h2>}
            {subtitle && <p className={L.meta + ' mt-0.5'}>{subtitle}</p>}
          </div>
        )}
        <div className="relative px-5 py-4 overflow-y-auto min-h-0">{children}</div>
        {footer && <div className="px-5 py-3 border-t border-[#C5CAD1] flex items-center justify-end gap-2 flex-wrap">{footer}</div>}
      </div>
    </div>
  )
}

/** Empty state. */
export function EmptyState({ icon: Icon, title, body, action, className, compact }: { icon?: ElementType; title: ReactNode; body?: ReactNode; action?: ReactNode; className?: string; compact?: boolean }) {
  return (
    <div className={cx('flex flex-col items-center justify-center text-center', compact ? 'py-6' : 'py-12', className)}>
      {Icon && <IconTile icon={Icon} hue="grey" className="mb-3" />}
      <p className="text-[13px] font-semibold text-[#111827]">{title}</p>
      {body && <p className="text-[12px] text-[#6B7280] mt-1 max-w-sm">{body}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}

/** Thin progress bar in the dark accent. */
export function Meter({ value, max = 100, hue = 'dark', className, label }: { value: number; max?: number; hue?: Hue; className?: string; label?: ReactNode }) {
  const pct = max > 0 ? Math.min(100, Math.max(0, Math.round((value / max) * 100))) : 0
  return (
    <div className={className}>
      <div className="h-1.5 rounded-full bg-[#F3F4F6] overflow-hidden"><div className={cx('h-full rounded-full transition-[width] duration-500', HUE[hue].dot)} style={{ width: `${pct}%` }} /></div>
      {label && <p className={cx(L.meta, 'mt-1.5')}>{label}</p>}
    </div>
  )
}

export function Spinner({ className }: { className?: string }) {
  return <span className={cx('inline-block w-4 h-4 rounded-full border-2 border-[#C5CAD1] border-t-[var(--nerve-primary)] animate-spin', className)} aria-label="Loading" />
}

/** Evenly spaced axis ticks for a maximum. Recharts' own `tickCount` rounds
 *  each tick separately, which is how an axis ends up reading 0, 7, 14, 25. */
export function evenTicks(max: number): number[] {
  const steps = [1, 2, 3, 5, 10, 15, 20, 25, 50, 100, 200, 500, 1000, 2000, 5000]
  const top = Math.max(max, 1)
  const step = steps.find(st => top / st <= 5) ?? Math.ceil(top / 5)
  const ceiling = Math.ceil(top / step) * step
  return Array.from({ length: Math.round(ceiling / step) + 1 }, (_, i) => i * step)
}

/** Recharts helpers: bar shape with 6px top radius, dark when highlighted. */
export function barFill(active: boolean) { return active ? CHART2.highlight : CHART2.bar }

/** Dark tooltip pill like "Tue : 584". */
export function ChartTip({ label, value }: { label: ReactNode; value: ReactNode }) {
  return (
    <div className="bg-[var(--nerve-primary)] text-[var(--nerve-on-primary)] text-[12px] font-medium rounded-[5px] px-2.5 py-1 shadow-md whitespace-nowrap">
      {label} : {value}
    </div>
  )
}
