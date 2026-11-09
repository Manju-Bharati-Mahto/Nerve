/**
 * Branding portal design system — Nerve Light edition.
 *
 * The admin, lead, Kanban, team, gallery and project pages were built on an
 * older "Salesa" look (navy sidebar, slate text, bold weights, blue-flood
 * cards). This module keeps that API surface — the same `DS` tokens and the
 * same component names — but every value now comes from the Nerve Light
 * language the branding user dashboard established in ./ds2.tsx:
 *
 *   · canvas      #F9FAFB behind white cards; #F3F4F6 sidebar
 *   · ink         #111827 headings, #6B7280 support text, #9CA3AF faint
 *   · surfaces    white, 1px #C5CAD1 hairline, 6px radius, no heavy shadows,
 *                 hairline turns the primary colour on hover
 *   · controls    36px tall (32px small), 6px radius, hairline, 13px/500
 *   · accent      the user's chosen primary colour via --nerve-primary and the
 *                 derived --bp-* ramp (see ./theme.ts), never a fixed blue
 *   · status      amber = pending, green = done, red = problem, primary = info
 *   · type        Inter, 500/600 weights only; uppercase 11px eyebrows
 *
 * Nothing here knows about data. Pages import the class strings for raw
 * elements and the components for the recurring shapes.
 */
import type { ReactNode, ElementType, MouseEvent } from 'react'
import { ArrowUpRight, ArrowRight, Calendar, Info, X } from 'lucide-react'

// ── Class tokens ──────────────────────────────────────────────────────────

const INPUT_BASE = 'bg-white text-[13px] rounded-[6px] border border-[#C5CAD1] text-[#111827] placeholder:text-[#9CA3AF] focus:outline-none focus:border-[#9CA3AF] focus:ring-2 focus:ring-[#111827]/5 transition-colors disabled:bg-[#F9FAFB] disabled:text-[#9CA3AF] disabled:cursor-not-allowed'

export const DS = {
  /** Page canvas behind every card. */
  canvas: 'bg-[#F9FAFB]',

  /** A white surface. */
  card: 'bg-white rounded-[6px] border border-[#C5CAD1] transition-colors duration-150 hover:border-[var(--nerve-primary)]',
  cardHover: 'hover:border-[var(--nerve-primary)] transition-colors duration-150',
  cardPad: 'p-4',

  /** Small caps label above a block or column. */
  eyebrow: 'text-[11px] font-medium uppercase tracking-[0.06em] text-[#6B7280]',
  /** Card / section heading. */
  h2: 'text-[14px] font-semibold text-[#111827] tracking-[-0.005em] leading-tight',
  h3: 'text-[13px] font-semibold text-[#111827] tracking-[-0.005em]',
  sub: 'text-[13px] text-[#6B7280] leading-snug',
  muted: 'text-[12px] text-[#9CA3AF]',

  /** Form bits. */
  label: 'block text-[12px] font-medium text-[#111827] mb-1.5',
  input: `h-9 w-full px-3 ${INPUT_BASE}`,
  select: `h-9 w-full pl-3 pr-8 appearance-none select-chevron cursor-pointer ${INPUT_BASE}`,
  textarea: `w-full px-3 py-2 resize-y ${INPUT_BASE}`,
  hint: 'text-[12px] text-[#6B7280] mt-1.5 leading-snug',
  /** In-table cell editor. */
  inputCell: 'h-8 w-full bg-white text-[13px] px-2 rounded-[6px] border border-[#C5CAD1] hover:border-[#9CA3AF] focus:border-[#9CA3AF] focus:outline-none focus:ring-2 focus:ring-[#111827]/5 transition-colors placeholder:text-[#9CA3AF]',

  /** Buttons. */
  btn: 'inline-flex items-center justify-center gap-1.5 h-9 px-3.5 rounded-[6px] text-[13px] font-medium transition-colors cursor-pointer whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed',
  btnPrimary: 'bg-[var(--nerve-primary)] text-[var(--nerve-on-primary)] hover:bg-[var(--nerve-primary-dark)]',
  btnSecondary: 'bg-white border border-[#C5CAD1] text-[#111827] hover:bg-[#F9FAFB] hover:border-[#9CA3AF]',
  btnDark: 'bg-[#111827] text-white hover:bg-[#1F2937]',
  btnDanger: 'bg-white border border-[#FECACA] text-[#DC2626] hover:bg-[#FEF2F2]',
  btnSuccess: 'bg-[#16A34A] text-white hover:bg-[#15803D]',
  btnGhost: 'text-[#6B7280] hover:bg-[#F3F4F6] hover:text-[#111827]',
  btnOutline: 'bg-white border border-[var(--nerve-primary)] text-[var(--nerve-primary-text)] hover:bg-[var(--nerve-primary-soft)]',
  btnOutlineDanger: 'bg-white border border-[#FECACA] text-[#DC2626] hover:bg-[#FEF2F2]',
  btnSoft: '!h-8 !px-3 !text-[12px] bg-[#F3F4F6] text-[#111827] hover:bg-[#E5E7EB]',
  btnSm: '!h-8 !px-3 !text-[12px]',
  btnXs: '!h-7 !px-2.5 !text-[12px]',

  /** Square icon buttons, hairline. */
  iconBtn: 'inline-flex items-center justify-center w-9 h-9 rounded-[6px] border border-[#C5CAD1] bg-white text-[#6B7280] hover:text-[#111827] hover:bg-[#F9FAFB] transition-colors cursor-pointer shrink-0 disabled:opacity-50 disabled:cursor-not-allowed',
  iconBtnSm: 'inline-flex items-center justify-center w-8 h-8 rounded-[6px] border border-[#C5CAD1] bg-white text-[#6B7280] hover:text-[#111827] hover:bg-[#F9FAFB] transition-colors cursor-pointer shrink-0 disabled:opacity-50',

  /** Pill row (range pickers): filled primary on, hairline off. */
  pill: 'inline-flex items-center h-8 px-3 rounded-[6px] text-[12px] font-medium border transition-colors cursor-pointer whitespace-nowrap',
  pillOn: 'bg-[var(--nerve-primary)] text-[var(--nerve-on-primary)] border-[var(--nerve-primary)]',
  pillOff: 'bg-white text-[#374151] border-[#C5CAD1] hover:bg-[#F9FAFB]',
  /** Small primary-tinted chip ("Current month", "Avg 7.5 hr"). */
  chip: 'inline-flex items-center h-6 px-2 rounded-[5px] bg-[var(--nerve-primary-soft)] text-[var(--nerve-primary-text)] text-[12px] font-medium shrink-0 whitespace-nowrap',
  chipOutline: 'inline-flex items-center h-6 px-2 rounded-[5px] bg-[var(--nerve-primary-soft)] text-[var(--nerve-primary-text)] border border-[var(--nerve-primary-soft-border)] text-[12px] font-medium whitespace-nowrap',
  /** Text link action ("All reports →"). */
  link: 'inline-flex items-center gap-1 text-[13px] font-medium text-[var(--nerve-primary-text)] hover:underline transition-colors cursor-pointer',

  /** Tabs under a page title. */
  tab: 'inline-flex items-center h-8 px-3 rounded-[6px] text-[13px] font-medium border transition-colors cursor-pointer whitespace-nowrap',
  tabOn: 'bg-white text-[#111827] border-[#C5CAD1] shadow-[0_1px_2px_rgba(16,24,40,0.04)]',
  tabOff: 'text-[#6B7280] border-transparent hover:bg-[#F3F4F6] hover:text-[#111827]',

  /** Tables: grey head, hairline rows. */
  table: 'w-full text-[13px]',
  thead: 'bg-[#F9FAFB] border-b border-[#C5CAD1]',
  th: 'text-left px-4 h-10 text-[12px] font-medium text-[#6B7280] whitespace-nowrap',
  tbody: 'divide-y divide-[#C5CAD1]',
  td: 'px-4 py-3 text-[#111827] align-top',
  trHover: 'hover:bg-[#F9FAFB] transition-colors',
  /** Soft table: no head fill, hairline rows. */
  tableSoft: 'w-full text-left text-[13px]',
  thSoft: 'pb-2 px-4 text-[12px] font-medium text-[#6B7280] select-none',
  trSoftEven: 'border-t border-[#C5CAD1] hover:bg-[#F9FAFB] transition-colors',
  trSoftOdd: 'border-t border-[#C5CAD1] hover:bg-[#F9FAFB] transition-colors',
  tdSoft: 'py-3 px-4 text-[13px] text-[#111827]',

  /** Overlays. */
  overlay: 'fixed inset-0 !m-0 bg-[#111827]/30 z-50 flex items-start justify-center pt-16 sm:pt-24 px-4 overflow-y-auto nerve-overlay-in',
  dialog: 'w-full bg-white rounded-[8px] border border-[#C5CAD1] shadow-[0_24px_48px_-12px_rgba(16,24,40,0.25)] mb-16 animate-scale-in',

  /** Divider. */
  divider: 'border-t border-[#C5CAD1]',
} as const

/** Join class fragments, skipping falsy ones. */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

// ── Status tones ──────────────────────────────────────────────────────────

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'accent'

export const TONE: Record<Tone, { badge: string; dot: string; soft: string; text: string }> = {
  neutral: { badge: 'bg-[#F3F4F6] text-[#374151] border-[#E5E7EB]', dot: 'bg-[#9CA3AF]', soft: 'bg-[#F9FAFB]', text: 'text-[#6B7280]' },
  info:    { badge: 'bg-[var(--nerve-primary-soft)] text-[var(--nerve-primary-text)] border-[var(--nerve-primary-soft-border)]', dot: 'bg-[var(--nerve-primary)]', soft: 'bg-[var(--nerve-primary-soft)]', text: 'text-[var(--nerve-primary-text)]' },
  accent:  { badge: 'bg-[var(--nerve-primary)] text-[var(--nerve-on-primary)] border-[var(--nerve-primary)]', dot: 'bg-[var(--nerve-primary)]', soft: 'bg-[var(--nerve-primary-soft)]', text: 'text-[var(--nerve-primary-text)]' },
  success: { badge: 'bg-[#ECFDF5] text-[#047857] border-[#A7F3D0]', dot: 'bg-[#10B981]', soft: 'bg-[#ECFDF5]', text: 'text-[#047857]' },
  warning: { badge: 'bg-[#FFFBEB] text-[#B45309] border-[#FDE68A]', dot: 'bg-[#F59E0B]', soft: 'bg-[#FFFBEB]', text: 'text-[#B45309]' },
  danger:  { badge: 'bg-[#FEF2F2] text-[#B91C1C] border-[#FECACA]', dot: 'bg-[#EF4444]', soft: 'bg-[#FEF2F2]', text: 'text-[#B91C1C]' },
}

/** Map the strings the API uses for state onto a tone. */
export function toneForStatus(status?: string | null): Tone {
  switch ((status ?? '').toLowerCase()) {
    case 'approved': case 'completed': case 'submitted': case 'finished': case 'published': case 'active': case 'done':
      return 'success'
    case 'pending': case 'running': case 'in_progress': case 'in-progress': case 'draft': case 'paused':
      return 'warning'
    case 'rejected': case 'overdue': case 'cancelled': case 'canceled': case 'inactive': case 'failed': case 'missing':
      return 'danger'
    case 'idle': case 'open':
      return 'info'
    default:
      return 'neutral'
  }
}

// ── Components ────────────────────────────────────────────────────────────

export function Badge({ tone = 'neutral', children, className, dot }: {
  tone?: Tone; children: ReactNode; className?: string; dot?: boolean
}) {
  return (
    <span className={cx('inline-flex items-center gap-1.5 h-6 px-2 rounded-[5px] border text-[12px] font-medium leading-none whitespace-nowrap', TONE[tone].badge, className)}>
      {dot && <span className={cx('w-1.5 h-1.5 rounded-full shrink-0', TONE[tone].dot)} aria-hidden="true" />}
      {children}
    </span>
  )
}

/** A white surface with an optional titled header row (hairline beneath). */
export function Card({ title, subtitle, eyebrow, action, children, className, bodyClassName, padded = true, hover, onClick }: {
  title?: ReactNode
  subtitle?: ReactNode
  eyebrow?: ReactNode
  action?: ReactNode
  children?: ReactNode
  className?: string
  bodyClassName?: string
  padded?: boolean
  hover?: boolean
  onClick?: (e: MouseEvent<HTMLDivElement>) => void
}) {
  const hasHead = title || subtitle || action || eyebrow
  return (
    <div
      onClick={onClick}
      className={cx(DS.card, hover && DS.cardHover, onClick && 'cursor-pointer', 'flex flex-col min-w-0', className)}
    >
      {hasHead && (
        <div className="flex items-start justify-between gap-3 flex-wrap px-4 py-3 border-b border-[#C5CAD1]">
          <div className="min-w-0">
            {eyebrow && <p className={cx(DS.eyebrow, 'mb-1')}>{eyebrow}</p>}
            {title && <h2 className={DS.h2}>{title}</h2>}
            {subtitle && <p className={cx(DS.sub, 'mt-0.5 text-[12px]')}>{subtitle}</p>}
          </div>
          {action && <div className="shrink-0 flex items-center gap-2">{action}</div>}
        </div>
      )}
      {children !== undefined && (
        <div className={cx(padded && DS.cardPad, 'min-w-0', bodyClassName)}>{children}</div>
      )}
    </div>
  )
}

/** Title block used at the top of a page section (not the page itself —
    the shell header owns that). */
export function SectionHeader({ title, subtitle, eyebrow, action, className }: {
  title: ReactNode; subtitle?: ReactNode; eyebrow?: ReactNode; action?: ReactNode; className?: string
}) {
  return (
    <div className={cx('flex items-end justify-between gap-3 flex-wrap', className)}>
      <div className="min-w-0">
        {eyebrow && <p className={cx(DS.eyebrow, 'mb-1')}>{eyebrow}</p>}
        <h2 className="text-[16px] font-semibold text-[#111827] tracking-[-0.01em] leading-tight">{title}</h2>
        {subtitle && <p className={cx(DS.sub, 'mt-0.5')}>{subtitle}</p>}
      </div>
      {action && <div className="shrink-0 flex items-center gap-2">{action}</div>}
    </div>
  )
}

/**
 * KPI tile — the same card the user dashboard's "At a glance" row uses:
 * title with an icon on the right, a 28px figure, one line of context, and
 * an optional thin meter.
 */
export function StatCard({ title, value, sub, meter, icon: Icon = ArrowUpRight, onClick, className }: {
  title: string
  value: string | number
  sub?: string
  meter?: { done: number; total: number; label: string }
  icon?: ElementType
  onClick?: () => void
  className?: string
}) {
  const s = String(value)
  const split = Math.max(s.indexOf('.'), s.indexOf('/'))
  const mainPart = split === -1 ? s : s.slice(0, split)
  const decPart = split === -1 ? '' : s.slice(split)
  return (
    <div
      onClick={onClick}
      className={cx(DS.card, 'flex flex-col', onClick && 'cursor-pointer', className)}
    >
      <div className="flex items-center justify-between gap-3 px-4 pt-3.5 pb-2">
        <p className="text-[14px] font-semibold text-[#111827]">{title}</p>
        <Icon className="w-4 h-4 text-[#6B7280] shrink-0" strokeWidth={1.75} />
      </div>
      <div className="px-4 pb-4 mt-auto">
        <p className="text-[28px] font-semibold text-[#111827] tracking-[-0.02em] tabular-nums leading-none whitespace-nowrap">
          {mainPart}
          {decPart && <span className="text-[#9CA3AF] font-medium">{decPart}</span>}
        </p>
        {meter && meter.total > 0 && (
          <div className="mt-3">
            <div className="h-1.5 rounded-full bg-[#F3F4F6] overflow-hidden">
              <div className="h-full rounded-full bg-[var(--nerve-primary)] transition-[width] duration-500 ease-out" style={{ width: `${Math.round((meter.done / meter.total) * 100)}%` }} />
            </div>
            <p className="mt-1.5 text-[12px] text-[#6B7280] leading-snug">{meter.label}</p>
          </div>
        )}
        {sub && <p className="mt-2 text-[12px] text-[#6B7280] leading-snug">{sub}</p>}
      </div>
    </div>
  )
}

/** Avatar: photo if there is one, otherwise the initial on the primary colour. */
export function Avatar({ url, name, email, size = 'md', className }: {
  url?: string | null; name?: string | null; email?: string | null
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl'; className?: string
}) {
  const dims = { xs: 'w-6 h-6 text-[10px]', sm: 'w-8 h-8 text-[12px]', md: 'w-10 h-10 text-[13px]', lg: 'w-12 h-12 text-[15px]', xl: 'w-16 h-16 text-[20px]' }[size]
  const initial = (name?.trim() || email || 'U').charAt(0).toUpperCase()
  return url ? (
    <img src={url} alt={name || 'avatar'} className={cx(dims, 'rounded-full object-cover shrink-0 border border-[#C5CAD1]', className)} />
  ) : (
    <div className={cx(dims, 'rounded-full bg-[var(--nerve-primary)] text-[var(--nerve-on-primary)] font-semibold grid place-items-center shrink-0 uppercase', className)} aria-hidden="true">{initial}</div>
  )
}

/** Nothing-here state for lists, tables and panels. */
export function EmptyState({ icon: Icon, title, body, action, className, compact }: {
  icon?: ElementType; title: ReactNode; body?: ReactNode; action?: ReactNode; className?: string; compact?: boolean
}) {
  return (
    <div className={cx('flex flex-col items-center justify-center text-center', compact ? 'py-6 px-4' : 'py-12 px-6', className)}>
      {Icon && (
        <div className="w-10 h-10 rounded-[6px] bg-[#F3F4F6] border border-[#C5CAD1] text-[#6B7280] grid place-items-center mb-3">
          <Icon className="w-4 h-4" strokeWidth={1.75} />
        </div>
      )}
      <p className="text-[13px] font-semibold text-[#111827]">{title}</p>
      {body && <p className="text-[12px] text-[#6B7280] mt-1 max-w-sm leading-relaxed">{body}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}

/** Centred dialog on a dimmed canvas. Click outside or Esc-key handling is the caller's. */
export function Modal({ title, subtitle, onClose, children, footer, size = 'md', className, bodyClassName }: {
  title?: ReactNode; subtitle?: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode
  size?: 'sm' | 'md' | 'lg' | 'xl' | '2xl'; className?: string; bodyClassName?: string
}) {
  const width = { sm: 'max-w-md', md: 'max-w-xl', lg: 'max-w-2xl', xl: 'max-w-4xl', '2xl': 'max-w-6xl' }[size]
  return (
    <div className={DS.overlay} onClick={onClose} role="dialog" aria-modal="true">
      <div className={cx(DS.dialog, width, 'flex flex-col max-h-[calc(100vh-6rem)]', className)} onClick={e => e.stopPropagation()}>
        {(title || subtitle) && (
          <div className="flex items-start justify-between gap-4 px-5 pt-5 pb-4 border-b border-[#C5CAD1] shrink-0">
            <div className="min-w-0">
              {title && <h2 className="text-[16px] font-semibold text-[#111827] tracking-[-0.01em] leading-tight">{title}</h2>}
              {subtitle && <p className={cx(DS.sub, 'mt-1')}>{subtitle}</p>}
            </div>
            <button type="button" onClick={onClose} className="inline-flex items-center justify-center w-8 h-8 shrink-0 rounded-[6px] text-[#6B7280] hover:text-[#111827] hover:bg-[#F3F4F6] transition-colors cursor-pointer" aria-label="Close">
              <X className="w-4 h-4" strokeWidth={1.75} />
            </button>
          </div>
        )}
        <div className={cx('relative px-5 overflow-y-auto min-h-0 py-5', bodyClassName)}>{children}</div>
        {footer && <div className="px-5 py-3.5 border-t border-[#C5CAD1] bg-[#F9FAFB] rounded-b-[8px] flex items-center justify-end gap-2 flex-wrap shrink-0">{footer}</div>}
      </div>
    </div>
  )
}

/** A key/value row for detail panels. */
export function KV({ label, children, className }: { label: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cx('flex items-start justify-between gap-4 py-2.5 border-b border-[#C5CAD1] last:border-0', className)}>
      <span className={cx(DS.eyebrow, 'shrink-0 pt-0.5')}>{label}</span>
      <span className="text-[13px] font-medium text-[#111827] text-right min-w-0 break-words">{children}</span>
    </div>
  )
}

/** Thin horizontal progress, primary by default. */
export function Meter({ value, max = 100, tone = 'accent', className, label }: {
  value: number; max?: number; tone?: Tone; className?: string; label?: ReactNode
}) {
  const pct = max > 0 ? Math.min(100, Math.max(0, Math.round((value / max) * 100))) : 0
  const fill = { neutral: 'bg-[#9CA3AF]', info: 'bg-[var(--nerve-primary)]', accent: 'bg-[var(--nerve-primary)]', success: 'bg-[#10B981]', warning: 'bg-[#F59E0B]', danger: 'bg-[#EF4444]' }[tone]
  return (
    <div className={className}>
      <div className="h-1.5 rounded-full bg-[#F3F4F6] overflow-hidden">
        <div className={cx('h-full rounded-full transition-[width] duration-500 ease-out', fill)} style={{ width: `${pct}%` }} />
      </div>
      {label && <p className="mt-1.5 text-[12px] text-[#6B7280] leading-snug">{label}</p>}
    </div>
  )
}

/** Inline spinner for loading rows. */
export function Spinner({ className }: { className?: string }) {
  return <span className={cx('inline-block w-4 h-4 rounded-full border-2 border-[#C5CAD1] border-t-[var(--nerve-primary)] animate-spin', className)} aria-label="Loading" />
}

// ── Reference parts ───────────────────────────────────────────────────────
// Shapes the user dashboard uses, so the admin, lead and shared pages are
// made of the same things.

/** Heading row above a block of cards: title, quiet subtitle, chip. */
export function BlockHeader({ title, subtitle, chip, action, className }: {
  title: ReactNode; subtitle?: ReactNode; chip?: ReactNode; action?: ReactNode; className?: string
}) {
  return (
    <div className={cx('flex items-end justify-between gap-3 flex-wrap mb-3', className)}>
      <div className="min-w-0">
        <h2 className="text-[14px] font-semibold text-[#111827] tracking-[-0.005em]">{title}</h2>
        {subtitle && <p className="text-[12px] text-[#6B7280] mt-0.5">{subtitle}</p>}
      </div>
      {chip && <span className={DS.chip}>{chip}</span>}
      {action && <div className="shrink-0 flex items-center gap-2">{action}</div>}
    </div>
  )
}

/** Card title row used inside a card: title, subtitle and a text link on the right. */
export function CardHead({ title, subtitle, link, onLink, action, icon: Icon, className }: {
  title: ReactNode; subtitle?: ReactNode; link?: ReactNode; onLink?: () => void; action?: ReactNode
  icon?: ElementType; className?: string
}) {
  return (
    <div className={cx('flex items-start justify-between gap-3', className)}>
      <div className="min-w-0">
        <h3 className="text-[14px] font-semibold text-[#111827] tracking-[-0.005em] flex items-center gap-2">
          {Icon && <Icon className="w-4 h-4 text-[#6B7280] shrink-0" strokeWidth={1.75} />}
          {title}
        </h3>
        {subtitle && <p className="text-[12px] text-[#6B7280] mt-0.5">{subtitle}</p>}
      </div>
      {link && (
        <button type="button" onClick={onLink} className={cx(DS.link, 'shrink-0')}>
          {link} <ArrowRight className="w-3.5 h-3.5" strokeWidth={1.75} />
        </button>
      )}
      {action && <div className="shrink-0 flex items-center gap-2">{action}</div>}
    </div>
  )
}

/** Formerly the one dark figure of a stat row; now the same white card as
    its neighbours, because the user dashboard's "At a glance" row has four
    identical cards. Kept as a named export so callers need not change. */
export function DarkStatCard({ title, value, sub, icon: Icon = ArrowUpRight, onClick, className }: {
  title: string; value: ReactNode; sub?: ReactNode; icon?: ElementType; onClick?: () => void; className?: string
}) {
  return (
    <div onClick={onClick} className={cx(DS.card, 'flex flex-col', onClick && 'cursor-pointer', className)}>
      <div className="flex items-center justify-between gap-3 px-4 pt-3.5 pb-2">
        <p className="text-[14px] font-semibold text-[#111827]">{title}</p>
        <Icon className="w-4 h-4 text-[#6B7280] shrink-0" strokeWidth={1.75} />
      </div>
      <div className="px-4 pb-4 mt-auto">
        <p className="text-[28px] font-semibold text-[#111827] tracking-[-0.02em] tabular-nums leading-none whitespace-nowrap">{value}</p>
        {sub && <p className="mt-2 text-[12px] text-[#6B7280] leading-snug">{sub}</p>}
      </div>
    </div>
  )
}

/** Opening banner: the user dashboard's intro card — primary-dark, eyebrow, headline, two actions. */
export function HeroBanner({ eyebrow, title, body, primary, secondary, art, className }: {
  eyebrow: ReactNode; title: ReactNode; body?: ReactNode
  primary?: { label: ReactNode; onClick: () => void }
  secondary?: { label: ReactNode; onClick: () => void }
  /** Optional right-hand artwork, shown from lg up. */
  art?: ReactNode
  className?: string
}) {
  return (
    <section className={cx('relative overflow-hidden rounded-[6px] bg-[var(--nerve-primary-dark)] p-4 sm:p-7', className)}>
      <div className="relative z-10 max-w-xl">
        <p className={cx(DS.eyebrow, '!text-[var(--nerve-on-primary-muted)]')}>{eyebrow}</p>
        <h2 className="mt-2 text-[22px] sm:text-[24px] font-semibold text-[var(--nerve-on-primary)] tracking-[-0.01em] leading-tight">{title}</h2>
        {body && <p className="mt-2 text-[13px] text-[var(--nerve-on-primary-muted)] leading-relaxed">{body}</p>}
        {(primary || secondary) && (
          <div className="mt-5 flex flex-wrap items-center gap-2">
            {primary && (
              <button type="button" onClick={primary.onClick} className={cx(DS.btn, 'bg-[var(--nv-white)] text-[var(--nerve-primary-ink)] hover:bg-[var(--nv-white-hover)]')}>
                {primary.label} <ArrowRight className="w-4 h-4" strokeWidth={1.75} />
              </button>
            )}
            {secondary && (
              <button type="button" onClick={secondary.onClick} className={cx(DS.btn, 'bg-transparent border border-[var(--nerve-on-primary-muted)] text-[var(--nerve-on-primary)] hover:bg-[var(--nerve-primary)]')}>
                {secondary.label}
              </button>
            )}
          </div>
        )}
      </div>
      {art && <div className="hidden lg:block absolute right-6 xl:right-10 top-1/2 -translate-y-1/2 opacity-90" aria-hidden="true">{art}</div>}
    </section>
  )
}

/** Segmented control: hairline pills, the active one filled with the primary colour. */
export function Segmented<T extends string>({ value, onChange, options, round = true, className, ariaLabel }: {
  value: T; onChange: (v: T) => void
  options: { id: T; label: ReactNode }[]
  round?: boolean; className?: string; ariaLabel?: string
}) {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={cx(round ? 'inline-flex items-center gap-1 flex-wrap' : 'flex gap-1', className)}
    >
      {options.map(o => {
        const on = o.id === value
        return (
          <button
            key={o.id}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => onChange(o.id)}
            className={cx(
              'rounded-[6px] font-medium border transition-colors cursor-pointer whitespace-nowrap',
              round ? 'h-8 px-3 text-[12px]' : 'flex-1 h-9 px-3 text-[13px]',
              on ? 'bg-[var(--nerve-primary)] text-[var(--nerve-on-primary)] border-[var(--nerve-primary)]' : 'bg-white text-[#374151] border-[#C5CAD1] hover:bg-[#F9FAFB]',
            )}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

/** Period picker strip: calendar icon, "Period:", month and year selects. */
export function PeriodBar({ month, year, onMonth, onYear, months, years, trailing, className }: {
  month: number; year: number
  onMonth: (m: number) => void; onYear: (y: number) => void
  months: readonly string[]; years: number[]
  trailing?: ReactNode; className?: string
}) {
  const sel = cx(DS.select, '!h-8 !w-auto')
  return (
    <div className={cx(DS.card, 'p-3 flex items-center gap-3 flex-wrap')}>
      <Calendar className="w-4 h-4 text-[#6B7280] shrink-0" strokeWidth={1.75} />
      <label className="text-[13px] font-medium text-[#111827]">Period:</label>
      <select value={month} onChange={e => onMonth(Number(e.target.value))} className={sel}>
        {months.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
      </select>
      <select value={year} onChange={e => onYear(Number(e.target.value))} className={sel}>
        {years.map(y => <option key={y} value={y}>{y}</option>)}
      </select>
      {trailing && <div className={cx('ml-auto flex items-center gap-2 flex-wrap', className)}>{trailing}</div>}
    </div>
  )
}

/** Selectable tile with icon, label and one-line description. */
export function ChoiceTile({ active, icon: Icon, label, desc, onClick, trailing, className }: {
  active: boolean; icon?: ElementType; label: ReactNode; desc?: ReactNode; onClick: () => void; trailing?: ReactNode; className?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cx(
        'rounded-[6px] p-4 text-left border transition-colors w-full cursor-pointer',
        active ? 'border-[var(--nerve-primary)] bg-[var(--nerve-primary-soft)] ring-1 ring-[var(--nerve-primary)]' : 'bg-white border-[#C5CAD1] hover:border-[#9CA3AF]',
        className,
      )}
    >
      <div className="flex items-center gap-2 mb-1">
        {Icon && <Icon className={cx('w-4 h-4 shrink-0', active ? 'text-[var(--nerve-primary-text)]' : 'text-[#6B7280]')} strokeWidth={1.75} />}
        <span className={cx('text-[13px] font-semibold truncate', active ? 'text-[#111827]' : 'text-[#374151]')}>{label}</span>
        {trailing && <span className="ml-auto shrink-0">{trailing}</span>}
      </div>
      {desc && <p className="text-[12px] text-[#6B7280]">{desc}</p>}
    </button>
  )
}

/** Read-only field: grey tile, eyebrow label, value. */
export function FieldTile({ label, value, className }: { label: ReactNode; value: ReactNode; className?: string }) {
  return (
    <div className={cx('rounded-[6px] bg-[#F9FAFB] border border-[#C5CAD1] p-3', className)}>
      <p className={cx(DS.eyebrow, 'mb-0.5')}>{label}</p>
      <p className="text-[13px] font-medium truncate text-[#111827]">{value}</p>
    </div>
  )
}

/** Small figure tile with a colour dot. */
export function MiniStat({ dot, n, label, sub, className }: { dot: string; n: ReactNode; label: ReactNode; sub?: ReactNode; className?: string }) {
  return (
    <div className={cx('rounded-[6px] border border-[#C5CAD1] bg-[#F9FAFB] p-3', className)}>
      <div className="flex items-center gap-1.5">
        <span className={cx('w-2 h-2 rounded-full shrink-0', dot)} />
        <span className="text-[18px] font-semibold text-[#111827] tabular-nums leading-none">{n}</span>
      </div>
      <p className="mt-1.5 text-[12px] font-medium text-[#374151] leading-tight">{label}</p>
      {sub && <p className="text-[12px] text-[#9CA3AF] tabular-nums">{sub}</p>}
    </div>
  )
}

/** Numbered row for a "Needs your attention" list. */
export function NumberedItem({ n, title, body, action, onAction, className }: {
  n: number; title: ReactNode; body?: ReactNode; action?: ReactNode; onAction?: () => void; className?: string
}) {
  return (
    <li className={cx('flex items-center justify-between gap-4 py-3.5 first:pt-0 last:pb-0', className)}>
      <div className="flex items-start gap-3 min-w-0">
        <span className="w-7 h-7 rounded-[6px] bg-[var(--nerve-primary-soft)] border border-[var(--nerve-primary-soft-border)] text-[var(--nerve-primary-text)] text-[11px] font-semibold grid place-items-center shrink-0 tabular-nums">
          {String(n).padStart(2, '0')}
        </span>
        <div className="min-w-0">
          <p className="text-[13px] font-semibold text-[#111827]">{title}</p>
          {body && <p className="text-[12px] text-[#6B7280] mt-0.5">{body}</p>}
        </div>
      </div>
      {action && (
        <button type="button" onClick={onAction} className={cx(DS.link, 'shrink-0')}>
          {action} <ArrowRight className="w-3.5 h-3.5" strokeWidth={1.75} />
        </button>
      )}
    </li>
  )
}

/** Dot-led list row: bullet, title, meta, trailing badge. */
export function DotItem({ title, meta, trailing, onClick, className }: {
  title: ReactNode; meta?: ReactNode; trailing?: ReactNode; onClick?: () => void; className?: string
}) {
  return (
    <li
      onClick={onClick}
      className={cx('flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0', onClick && 'cursor-pointer', className)}
    >
      <div className="flex items-start gap-3 min-w-0">
        <span className="w-2 h-2 rounded-full bg-[var(--nerve-primary)] shrink-0 mt-1.5" aria-hidden="true" />
        <div className="min-w-0">
          <p className="text-[13px] font-semibold text-[#111827] truncate">{title}</p>
          {meta && <p className="text-[12px] text-[#6B7280] mt-0.5">{meta}</p>}
        </div>
      </div>
      {trailing && <span className="shrink-0">{trailing}</span>}
    </li>
  )
}

/** Outlined status pill. */
export function StatusPill({ tone = 'info', children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  const ring = {
    neutral: 'border-[#C5CAD1] text-[#6B7280]', info: 'border-[var(--nerve-primary)] text-[var(--nerve-primary-text)]', accent: 'border-[var(--nerve-primary)] text-[var(--nerve-primary-text)]',
    success: 'border-[#10B981] text-[#047857]', warning: 'border-[#F59E0B] text-[#B45309]', danger: 'border-[#EF4444] text-[#B91C1C]',
  }[tone]
  return (
    <span className={cx('inline-flex items-center justify-center h-6 px-2.5 rounded-[5px] text-[12px] font-medium border bg-white whitespace-nowrap', ring, className)}>
      {children}
    </span>
  )
}

/** Note strip with an info icon. */
export function InfoNote({ children, tone = 'info', className }: { children: ReactNode; tone?: 'info' | 'warning' | 'danger'; className?: string }) {
  const t = {
    info: 'bg-[var(--nerve-primary-soft)] border-[var(--nerve-primary-soft-border)] text-[#111827]', warning: 'bg-[#FFFBEB] border-[#FDE68A] text-[#92400E]', danger: 'bg-[#FEF2F2] border-[#FECACA] text-[#991B1B]',
  }[tone]
  const ic = { info: 'text-[var(--nerve-primary-text)]', warning: 'text-[#D97706]', danger: 'text-[#DC2626]' }[tone]
  return (
    <div className={cx('p-3.5 border rounded-[6px] text-[12px] flex items-start gap-2 leading-relaxed', t, className)}>
      <Info className={cx('w-4 h-4 shrink-0 mt-0.5', ic)} strokeWidth={1.75} />
      <div className="min-w-0">{children}</div>
    </div>
  )
}

/** Score-level tones shared by KRA surfaces: index 0 = 1/5 … index 4 = 5/5. */
export const KRA_LEVEL_TONES = [
  { solid: 'bg-[#DC2626] border-[#DC2626] text-white', trail: 'bg-[#FEF2F2] border-[#FECACA] text-[#B91C1C]', ring: 'ring-[#FECACA]', score: 'text-[#DC2626]', card: 'bg-[#FEF2F2] border-[#FECACA] hover:border-[#FCA5A5]' },
  { solid: 'bg-[#F97316] border-[#F97316] text-white', trail: 'bg-[#FFF7ED] border-[#FED7AA] text-[#C2410C]', ring: 'ring-[#FED7AA]', score: 'text-[#EA580C]', card: 'bg-[#FFF7ED] border-[#FED7AA] hover:border-[#FDBA74]' },
  { solid: 'bg-[#F59E0B] border-[#F59E0B] text-white', trail: 'bg-[#FFFBEB] border-[#FDE68A] text-[#B45309]', ring: 'ring-[#FDE68A]', score: 'text-[#D97706]', card: 'bg-[#FFFBEB] border-[#FDE68A] hover:border-[#FCD34D]' },
  { solid: 'bg-[#65A30D] border-[#65A30D] text-white', trail: 'bg-[#F7FEE7] border-[#D9F99D] text-[#4D7C0F]', ring: 'ring-[#D9F99D]', score: 'text-[#65A30D]', card: 'bg-[#F7FEE7] border-[#D9F99D] hover:border-[#BEF264]' },
  { solid: 'bg-[#16A34A] border-[#16A34A] text-white', trail: 'bg-[#ECFDF5] border-[#A7F3D0] text-[#047857]', ring: 'ring-[#A7F3D0]', score: 'text-[#16A34A]', card: 'bg-[#ECFDF5] border-[#A7F3D0] hover:border-[#6EE7B7]' },
] as const

/** Tone for a 1–5 score (values on a 10-scale are mapped down); undefined when unscored. */
export function kraTone(v: number | null | undefined, scale = 5) {
  if (!v || v < 1) return undefined
  const level = scale === 5 ? Math.round(v) : Math.round((v / scale) * 5)
  return KRA_LEVEL_TONES[Math.min(Math.max(level, 1), 5) - 1]
}

/** Five numbered circles, filled up to the score; read-only unless onSelect is given. */
export function ScorePips({ value, onSelect, label, scale = 5 }: {
  value: number | undefined; onSelect?: (v: number) => void; label?: string; scale?: number
}) {
  const filled = value ?? 0
  const sel = kraTone(value, scale)
  return (
    <div className="flex items-center gap-1.5" role={onSelect ? 'radiogroup' : undefined} aria-label={label}>
      {Array.from({ length: 5 }, (_, i) => {
        const step = i + 1
        const on = filled >= step
        const isCurrent = Math.round(filled) === step
        const base = 'w-8 h-8 rounded-full grid place-items-center text-[12px] font-semibold tabular-nums transition-colors select-none border'
        const tone = isCurrent && sel ? sel.solid : on && sel ? sel.trail : 'bg-white border-[#C5CAD1] text-[#9CA3AF]'
        const ring = isCurrent && sel ? ` ring-2 ${sel.ring}` : ''
        if (!onSelect) return <span key={step} className={`${base} ${tone}${ring}`}>{step}</span>
        return (
          <button key={step} type="button" role="radio" aria-checked={isCurrent} onClick={() => onSelect(step)}
            className={`${base} ${tone}${ring} cursor-pointer hover:border-[var(--nerve-primary)] focus:outline-none focus:ring-2 focus:ring-[#C5CAD1]`}>
            {step}
          </button>
        )
      })}
    </div>
  )
}

/** Chart palette for Recharts fills and strokes. */
export const CHART = {
  primary: 'var(--bp-600)',
  primaryLight: 'var(--bp-500)',
  primaryDeep: 'var(--bp-800)',
  soft: 'var(--bp-200)',
  tint: 'var(--bp-50)',
  grid: 'var(--nv-raised)',
  tick: 'var(--nv-sub)',
  muted: 'var(--nv-line-strong)',
  mutedSoft: 'var(--nv-raised)',
  success: '#10B981',
  warning: '#F59E0B',
  danger: '#EF4444',
  ramp: ['var(--bp-800)', 'var(--bp-700)', 'var(--bp-600)', 'var(--bp-500)', 'var(--bp-400)', 'var(--bp-300)', 'var(--bp-200)', 'var(--bp-100)'],
} as const

/** `<defs>` for the bar gradient and the empty-day hatch. Render once inside a Recharts chart. */
export function ChartDefs({ gradientId = 'ds-bar-gradient', hatchId = 'ds-hatch' }: { gradientId?: string; hatchId?: string }) {
  return (
    <defs>
      <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor={CHART.primary} />
        <stop offset="100%" stopColor={CHART.primary} />
      </linearGradient>
      <pattern id={hatchId} patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)">
        <line x1="0" y1="0" x2="0" y2="6" stroke={CHART.muted} strokeWidth="1.5" />
      </pattern>
    </defs>
  )
}
