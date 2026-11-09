/**
 * Primary-colour theming for the Nerve Light user dashboard.
 *
 * The design system paints every accent (primary buttons, active pills,
 * highlighted bars, links, the intro banner) with CSS variables instead of a
 * fixed blue. `applyPrimary` derives the whole family from one hex:
 *
 *   --nerve-primary             the colour itself
 *   --nerve-primary-dark        hover / pressed, and the intro banner
 *   --nerve-primary-soft        10% tint on white — tiles, hover fills
 *   --nerve-primary-soft-border 30% tint — borders around soft fills
 *   --nerve-primary-text        the colour pushed until it reads on the page (4.5:1)
 *   --nerve-primary-ink         the same against white, for white controls on the banner
 *   --nerve-on-primary          white or near-black, whichever reads on the colour
 *   --nerve-on-primary-muted    the same at ~80% for secondary text on the colour
 *
 * The choice is kept in localStorage so it survives reloads and applies on
 * every page of the dashboard.
 */

export const DEFAULT_PRIMARY = '#0077B6'
const STORAGE_KEY = 'nerve.primary'
const MODE_KEY = 'nerve.mode'

// ── Light / dark mode ─────────────────────────────────────────────────────
// The choice is a `dark` class on <html> (Tailwind's `darkMode: 'class'`).
// src/dark.css remaps every fixed colour the portal paints with, and
// `applyPrimary` below mixes the accent family against the dark surface
// instead of white, so tints and link text stay readable on both.

export type ThemeMode = 'light' | 'dark' | 'system'
/** Card surface in dark mode; tints and text contrast are computed against it. */
export const DARK_SURFACE = '#171B24'

export function loadMode(): ThemeMode {
  try {
    const v = localStorage.getItem(MODE_KEY)
    if (v === 'light' || v === 'dark' || v === 'system') return v
  } catch { /* ignore */ }
  return 'light'
}

export function saveMode(mode: ThemeMode): void {
  try {
    if (mode === 'light') localStorage.removeItem(MODE_KEY)
    else localStorage.setItem(MODE_KEY, mode)
  } catch { /* storage unavailable: the choice just lasts the session */ }
  persistForUser({ mode })
}

function systemPrefersDark(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-color-scheme: dark)').matches
}

export function resolveMode(mode: ThemeMode): 'light' | 'dark' {
  return mode === 'system' ? (systemPrefersDark() ? 'dark' : 'light') : mode
}

export function isDark(): boolean {
  return typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
}

/** Sets the <html> class for `mode` and re-derives the accent family for it. */
export function applyMode(mode: ThemeMode): 'light' | 'dark' {
  const resolved = resolveMode(mode)
  const root = document.documentElement
  root.classList.toggle('dark', resolved === 'dark')
  root.style.colorScheme = resolved
  applyPrimary(loadPrimary())
  window.dispatchEvent(new CustomEvent('nerve-mode', { detail: resolved }))
  return resolved
}

let systemListener: (() => void) | null = null

/** Call once at boot: applies the saved mode and follows the OS while on `system`. */
export function applySavedMode(): 'light' | 'dark' {
  const mode = loadMode()
  if (!systemListener && typeof window !== 'undefined' && window.matchMedia) {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    systemListener = () => { if (loadMode() === 'system') applyMode('system') }
    mq.addEventListener?.('change', systemListener)
  }
  return applyMode(mode)
}

export const PRIMARY_PRESETS: { id: string; label: string; hex: string }[] = [
  { id: 'blue',   label: 'Brand blue', hex: DEFAULT_PRIMARY },
  { id: 'teal',   label: 'Teal',       hex: '#0F766E' },
  { id: 'green',  label: 'Green',      hex: '#15803D' },
  { id: 'violet', label: 'Violet',     hex: '#6D28D9' },
  { id: 'rose',   label: 'Rose',       hex: '#BE123C' },
  { id: 'orange', label: 'Orange',     hex: '#C2410C' },
  { id: 'amber',  label: 'Amber',      hex: '#D97706' },
  { id: 'slate',  label: 'Slate',      hex: '#334155' },
]

type RGB = [number, number, number]

export function isHex(v: string): boolean {
  return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v.trim())
}

function hexToRgb(hex: string): RGB {
  let h = hex.trim().replace('#', '')
  if (h.length === 3) h = h.split('').map(c => c + c).join('')
  const n = parseInt(h, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function rgbToHex([r, g, b]: RGB): string {
  return '#' + [r, g, b].map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('').toUpperCase()
}

/** Linear blend: t = 0 gives `a`, t = 1 gives `b`. */
function mix(a: string, b: string, t: number): string {
  const x = hexToRgb(a), y = hexToRgb(b)
  return rgbToHex([x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t])
}

/** WCAG relative luminance. */
function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map(v => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG contrast ratio between two colours. */
export function contrast(a: string, b: string): number {
  const la = luminance(a), lb = luminance(b)
  const [hi, lo] = la > lb ? [la, lb] : [lb, la]
  return (hi + 0.05) / (lo + 0.05)
}

export interface PrimaryPalette {
  primary: string
  dark: string
  soft: string
  softBorder: string
  text: string
  onPrimary: string
  onPrimaryMuted: string
}

export function derivePalette(hex: string, darkMode = false): PrimaryPalette {
  const primary = rgbToHex(hexToRgb(hex))
  // White text wherever it reaches 3:1 (large/bold UI text); otherwise ink.
  const whiteReads = contrast(primary, '#FFFFFF') >= 3
  const onPrimary = whiteReads ? '#FFFFFF' : '#111827'
  const onPrimaryMuted = whiteReads ? 'rgba(255,255,255,0.8)' : 'rgba(17,24,39,0.72)'
  // Hover: a step darker for deep colours, a touch darker for pale ones so
  // the change stays visible without going muddy. In dark mode hover goes
  // lighter instead, the way every other surface does.
  const dark = darkMode
    ? mix(primary, '#FFFFFF', 0.12)
    : mix(primary, '#000000', whiteReads ? 0.2 : 0.12)
  // Text on the page: push the colour until it reads at 4.5:1 (body-text
  // standard) — darker on white, lighter on the dark surface.
  const surface = darkMode ? DARK_SURFACE : '#FFFFFF'
  const towards = darkMode ? '#FFFFFF' : '#000000'
  let text = primary
  for (let i = 0; i < 24 && contrast(text, surface) < 4.5; i++) text = mix(text, towards, 0.08)
  return {
    primary,
    dark,
    soft: mix(primary, surface, darkMode ? 0.82 : 0.9),
    softBorder: mix(primary, surface, darkMode ? 0.6 : 0.7),
    text,
    onPrimary,
    onPrimaryMuted,
  }
}

/** Hex → "h s% l%" for the shadcn-style --brand-* variables. */
function hexToHslTriplet(hex: string): string {
  const [r, g, b] = hexToRgb(hex).map(v => v / 255)
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  const l = (max + min) / 2
  let h = 0, sat = 0
  if (max !== min) {
    const d = max - min
    sat = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6
    else if (max === g) h = ((b - r) / d + 2) / 6
    else h = ((r - g) / d + 4) / 6
  }
  return `${Math.round(h * 360)} ${Math.round(sat * 100)}% ${Math.round(l * 100)}%`
}

/**
 * Ten-step ramp around the chosen colour, in the same positions the original
 * brand-blue ramp used (600 = the colour itself). The Salesa design system
 * (ds.tsx: admin, lead Kanban, team pages, gallery) paints with `bp-*`
 * Tailwind classes that read `--bp-N-rgb`, and the shadcn `primary` reads
 * `--brand-600`, so setting these makes every page follow the pick.
 */
export function deriveRamp(hex: string, darkMode = false): Record<number, string> {
  const base = rgbToHex(hexToRgb(hex))
  if (darkMode) {
    // Pale steps become tints of the dark surface and the deep steps become
    // lighter, so `bg-bp-50` stays a quiet fill and `text-bp-700` still reads.
    return {
      50:  mix(base, DARK_SURFACE, 0.86),
      100: mix(base, DARK_SURFACE, 0.74),
      200: mix(base, DARK_SURFACE, 0.56),
      300: mix(base, DARK_SURFACE, 0.34),
      400: mix(base, DARK_SURFACE, 0.14),
      500: base,
      600: mix(base, '#FFFFFF', 0.12),
      700: mix(base, '#FFFFFF', 0.30),
      800: mix(base, '#FFFFFF', 0.48),
      900: mix(base, '#FFFFFF', 0.66),
    }
  }
  return {
    50:  mix(base, '#FFFFFF', 0.94),
    100: mix(base, '#FFFFFF', 0.86),
    200: mix(base, '#FFFFFF', 0.72),
    300: mix(base, '#FFFFFF', 0.52),
    400: mix(base, '#FFFFFF', 0.26),
    500: mix(base, '#FFFFFF', 0.10),
    600: base,
    700: mix(base, '#000000', 0.18),
    800: mix(base, '#000000', 0.34),
    900: mix(base, '#000000', 0.50),
  }
}

export function applyPrimary(hex: string): PrimaryPalette {
  const darkMode = isDark()
  const p = derivePalette(hex, darkMode)
  const s = document.documentElement.style
  for (const [step, value] of Object.entries(deriveRamp(hex, darkMode))) {
    s.setProperty(`--bp-${step}`, value)
    s.setProperty(`--bp-${step}-rgb`, hexToRgb(value).join(' '))
    s.setProperty(`--brand-${step}`, hexToHslTriplet(value))
  }
  s.setProperty('--nerve-primary', p.primary)
  s.setProperty('--nerve-primary-dark', p.dark)
  s.setProperty('--nerve-primary-soft', p.soft)
  s.setProperty('--nerve-primary-soft-border', p.softBorder)
  s.setProperty('--nerve-primary-text', p.text)
  // The colour as text on a white control (the hero banner buttons), in both modes.
  s.setProperty('--nerve-primary-ink', darkMode ? derivePalette(hex, false).text : p.text)
  s.setProperty('--nerve-on-primary', p.onPrimary)
  s.setProperty('--nerve-on-primary-muted', p.onPrimaryMuted)
  return p
}

export function savePrimary(hex: string): void {
  try {
    if (hex.toUpperCase() === DEFAULT_PRIMARY) localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, hex.toUpperCase())
  } catch { /* storage unavailable: the choice just lasts the session */ }
  persistForUser({ primary: hex.toUpperCase() })
}

// ── Per-user persistence ──────────────────────────────────────────────────
// `nerve.primary` / `nerve.mode` above are the "last look on this browser"
// (they make the pre-paint script and the sign-in page right). The choice a
// person makes is also saved against their account — on the server through
// PATCH /users/me, and under a per-user key here as a fallback (the demo has
// no server) — and put back whenever they sign in, on any device.

export interface UserAppearance { primary?: string; mode?: ThemeMode }
const USER_KEY = (id: string) => `nerve.appearance.${id}`
const EMAIL_KEY = (email: string) => `nerve.appearance.email.${email.trim().toLowerCase()}`
let currentUserId: string | null = null
let currentUserEmail: string | null = null
let remoteSave: ((a: UserAppearance) => void) | null = null

/** Lets useAuth hand over the API call without theme.ts importing the API. */
export function setAppearanceSaver(fn: ((a: UserAppearance) => void) | null): void {
  remoteSave = fn
}

function readUserAppearance(id: string): UserAppearance {
  try {
    const raw = localStorage.getItem(USER_KEY(id))
    if (raw) return JSON.parse(raw) as UserAppearance
  } catch { /* ignore */ }
  return {}
}

function persistForUser(patch: UserAppearance): void {
  if (!currentUserId) return
  const next = { ...readUserAppearance(currentUserId), ...patch }
  try {
    localStorage.setItem(USER_KEY(currentUserId), JSON.stringify(next))
    if (currentUserEmail) localStorage.setItem(EMAIL_KEY(currentUserEmail), JSON.stringify(next))
  } catch { /* ignore */ }
  remoteSave?.(next)
}

/** Puts a saved look on screen without touching any account. */
function showAppearance(a: UserAppearance): { primary: string; mode: ThemeMode } {
  const primary = a.primary && isHex(a.primary) ? a.primary.toUpperCase() : DEFAULT_PRIMARY
  const mode: ThemeMode = a.mode === 'dark' || a.mode === 'system' ? a.mode : 'light'
  try {
    if (primary === DEFAULT_PRIMARY) localStorage.removeItem(STORAGE_KEY); else localStorage.setItem(STORAGE_KEY, primary)
    if (mode === 'light') localStorage.removeItem(MODE_KEY); else localStorage.setItem(MODE_KEY, mode)
  } catch { /* ignore */ }
  applyMode(mode)   // also re-derives the primary family from `nerve.primary`
  return { primary, mode }
}

/**
 * Sign-in page: as soon as someone types an e-mail this browser has seen
 * sign in before, the page takes on that person's saved look, so the login
 * screen matches the dashboard they are about to open. Returns false when
 * the e-mail is unknown here (the look is then left as it is).
 */
export function applyAppearanceForEmail(email: string): boolean {
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) return false
  try {
    const raw = localStorage.getItem(EMAIL_KEY(email))
    if (!raw) return false
    showAppearance(JSON.parse(raw) as UserAppearance)
    return true
  } catch { return false }
}

/**
 * Called when a user signs in or a session is restored: applies the look
 * saved on their account (server copy first, then this browser's per-user
 * copy), so the dashboard opens the way they left it.
 */
export function applyUserAppearance(userId: string, fromServer: UserAppearance | null | undefined, email?: string | null): void {
  currentUserId = userId
  currentUserEmail = email ?? null
  const local = readUserAppearance(userId)
  const { primary, mode } = showAppearance({ ...local, ...(fromServer ?? {}) })
  try {
    localStorage.setItem(USER_KEY(userId), JSON.stringify({ primary, mode }))
    if (email) localStorage.setItem(EMAIL_KEY(email), JSON.stringify({ primary, mode }))
  } catch { /* ignore */ }
  if (fromServer === null || fromServer === undefined) remoteSave?.({ primary, mode })
}

/** Sign-out: stop saving against the account; the current look stays on screen. */
export function clearAppearanceUser(): void {
  currentUserId = null
  currentUserEmail = null
}

export function loadPrimary(): string {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    if (v && isHex(v)) return v
  } catch { /* ignore */ }
  return DEFAULT_PRIMARY
}

/** Call once when the dashboard mounts so a saved colour is in place. */
export function applySavedPrimary(): string {
  const hex = loadPrimary()
  applyPrimary(hex)
  return hex
}
