#!/usr/bin/env node
/**
 * Writes src/dark.css: a dark-mode value for every fixed colour utility the
 * portal paints with (`text-[#111827]`, `hover:bg-[#F9FAFB]`, `bg-white`,
 * `text-rose-700`, …). The design systems use literal hex classes rather than
 * semantic tokens, so instead of touching ~2000 class names this scans the
 * source, maps each colour to its dark counterpart and emits one override per
 * (variant, utility, colour) under `:where(.dark)`.
 *
 * `:where()` keeps each override at the same specificity as the Tailwind rule
 * it replaces, so hover/focus variants still beat base classes exactly as they
 * do in light mode; the sheet only has to come after Tailwind's (main.tsx).
 *
 *   node scripts/gen-dark-css.mjs        (also runs before every build)
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import colors from 'tailwindcss/colors.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
// Nerve uses LandingPage.tsx (no Landing.tsx). Scan only the branding portal
// and the shared auth/landing pages this theme actually styles.
const SCAN = ['src/pages/branding', 'src/components', 'src/pages/Login.tsx', 'src/pages/LoginForm.tsx', 'src/pages/ResetPassword.tsx', 'src/pages/VerifyEmail.tsx', 'src/pages/LandingPage.tsx']
const OUT = join(ROOT, 'src/dark.css')

// ── Palette ──────────────────────────────────────────────────────────────
// Light → dark, by hand for the neutrals the design systems are built on.
const SURFACE = '#171B24'   // cards, inputs, dialogs (was white)
const CANVAS = '#0F1218'    // page behind the cards (was #F9FAFB)
const RAISED = '#1C212B'    // sidebar, hover fills, table heads (was #F3F4F6)
const NEUTRALS = {
  '#FFFFFF': SURFACE,
  '#F9FAFB': CANVAS,
  '#F8F9FC': CANVAS,
  '#F5F6FA': CANVAS,
  '#F3F4F6': RAISED,
  '#F1F5F9': RAISED,
  '#E5E7EB': '#262D39',
  '#E2E8F0': '#262D39',
  '#D9DDE3': '#323A48',
  '#D1D5DB': '#323A48',
  '#CBD5E1': '#323A48',
  '#C5CAD1': '#2B3340',   // the hairline border
  '#9CA3AF': '#7F899B',   // tertiary text
  '#94A3B8': '#7F899B',
  '#6B7280': '#A2ACBD',   // secondary text
  '#64748B': '#A2ACBD',
  '#374151': '#CBD3DF',
  '#1B1F54': '#DDE3EE',   // logo wordmark navy
  '#111827': '#E8ECF3',   // ink
  '#0F172A': '#E8ECF3',
  '#000000': '#000000',
}

const hexToRgb = h => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255] }
const rgbToHex = ([r, g, b]) => '#' + [r, g, b].map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('').toUpperCase()
const mix = (a, b, t) => { const x = hexToRgb(a), y = hexToRgb(b); return rgbToHex([x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t]) }
const lum = h => { const [r, g, b] = hexToRgb(h).map(v => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 }); return 0.2126 * r + 0.7152 * g + 0.0722 * b }
const contrast = (a, b) => { const la = lum(a), lb = lum(b); const [hi, lo] = la > lb ? [la, lb] : [lb, la]; return (hi + 0.05) / (lo + 0.05) }
function hue(h) {
  const [r, g, b] = hexToRgb(h).map(v => v / 255)
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  if (max === min) return 0
  const d = max - min
  let x
  if (max === r) x = ((g - b) / d + (g < b ? 6 : 0)) / 6
  else if (max === g) x = ((b - r) / d + 2) / 6
  else x = ((r - g) / d + 4) / 6
  return x * 360
}
function hslToHex(h, s, l) {
  const k = n => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
  return rgbToHex([f(0) * 255, f(8) * 255, f(4) * 255])
}
function hsl(h) {
  const [r, g, b] = hexToRgb(h).map(v => v / 255)
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2
  let s = 0
  if (max !== min) { const d = max - min; s = l > 0.5 ? d / (2 - max - min) : d / (max + min) }
  return { s, l }
}

/**
 * Status colours (greens, reds, ambers, …) follow one rule so the whole
 * family stays consistent:
 *   pale tints (bg/border fills)  → the same hue mixed into the dark surface
 *   deep shades (text on white)   → lightened until they read on the surface
 *   the mid-tones (icons, dots)   → unchanged
 */
function mapColour(hex, util) {
  const H = hex.toUpperCase()
  if (NEUTRALS[H]) return NEUTRALS[H]
  const { s, l } = hsl(H)
  if (l >= 0.78) {
    // Tinted fill: keep the hue, drop the lightness to just above the surface.
    // Mixing the pale colour into the surface would only give grey, because a
    // pale tint is mostly white; rebuilding it from its hue keeps it coloured.
    const edge = util === 'border' || util === 'divide' || util === 'ring'
    const lDark = (l >= 0.93 ? 0.19 : l >= 0.86 ? 0.24 : 0.31) + (edge ? 0.06 : 0)
    return hslToHex(hue(H), Math.min(s, edge ? 0.42 : 0.38), lDark)
  }
  if (l <= 0.42 || (util === 'text' && contrast(H, SURFACE) < 4.5)) {
    // Deep shade used as text or a filled control: lift until it reads.
    let c = H
    for (let i = 0; i < 30 && contrast(c, SURFACE) < 4.5; i++) c = mix(c, '#FFFFFF', 0.07)
    return c
  }
  return H
}

// Named Tailwind colours → hex (white, slate-200, rose-700, …)
function namedToHex(name) {
  if (name === 'white') return '#FFFFFF'
  if (name === 'black') return '#000000'
  const m = name.match(/^([a-z]+)-(\d+)$/)
  if (!m) return null
  const fam = colors[m[1]]
  return fam && typeof fam === 'object' && fam[m[2]] ? fam[m[2]].toUpperCase() : null
}

// ── Scan ─────────────────────────────────────────────────────────────────
function* files(p) {
  const st = statSync(p)
  if (st.isDirectory()) for (const f of readdirSync(p)) yield* files(join(p, f))
  else if (/\.(tsx?|css)$/.test(p)) yield p
}
const UTILS = 'bg|text|border|divide|ring|placeholder'
const RE = new RegExp(`(?<![\\w-])((?:[a-z0-9-]+:)*)(${UTILS})-(?:\\[#([0-9A-Fa-f]{6})\\]|(white|black|(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\\d{2,3}))(?:/(\\d{1,3}))?(?![\\w-])`, 'g')
const found = new Map()
for (const base of SCAN) {
  for (const f of files(join(ROOT, base))) {
    const src = readFileSync(f, 'utf8')
    for (const m of src.matchAll(RE)) {
      const [, variants, util, hex, named, alpha] = m
      // `placeholder:text-[…]` is one utility (text) with the placeholder variant;
      // a bare `placeholder-[…]` is not used here.
      const colour = hex ? `#${hex.toUpperCase()}` : namedToHex(named)
      if (!colour) continue
      const key = `${variants}|${util}|${hex ? `[#${hex.toUpperCase()}]` : named}|${alpha ?? ''}`
      if (!found.has(key)) found.set(key, { variants, util, colour, token: hex ? `[#${hex.toUpperCase()}]` : named, alpha: alpha ? Number(alpha) / 100 : null })
    }
  }
}

// ── Emit ─────────────────────────────────────────────────────────────────
const esc = s => s.replace(/[^a-zA-Z0-9_-]/g, c => `\\${c}`)
const SCREENS = { sm: 640, md: 768, lg: 1024, xl: 1280, '2xl': 1536 }
const PSEUDO = {
  hover: ':hover', focus: ':focus', 'focus-visible': ':focus-visible', 'focus-within': ':focus-within',
  active: ':active', disabled: ':disabled', first: ':first-child', last: ':last-child', odd: ':nth-child(odd)', even: ':nth-child(even)',
  placeholder: '::placeholder', checked: ':checked',
}
const skipped = new Set()
const rules = []   // { media, selector, decl }
for (const { variants, util, colour, token, alpha } of found.values()) {
  const dark = alpha !== null && alpha <= 0.6 && util === 'bg' && lum(colour) < 0.05
    ? '#000000'                       // translucent ink overlays stay a shade, not a glow
    : mapColour(colour, util)
  if (dark === colour && alpha === null) continue
  const vlist = variants ? variants.slice(0, -1).split(':') : []
  let media = null, prefix = '', suffix = '', ok = true
  for (const v of vlist) {
    if (SCREENS[v]) media = `@media (min-width: ${SCREENS[v]}px)`
    else if (v === 'group-hover') prefix += '.group:hover '
    else if (v === 'peer-checked') prefix += '.peer:checked ~ '
    else if (PSEUDO[v]) suffix += PSEUDO[v]
    else { ok = false; skipped.add(v) }
  }
  if (!ok) continue
  const cls = `${variants}${util}-${token}${alpha !== null ? `/${Math.round(alpha * 100)}` : ''}`
  const [r, g, b] = hexToRgb(dark)
  const a = alpha !== null ? String(alpha) : null
  let selector = `:where(.dark) ${prefix}.${esc(cls)}${suffix}`
  let decl
  switch (util) {
    case 'bg': decl = `background-color: rgb(${r} ${g} ${b} / ${a ?? 'var(--tw-bg-opacity, 1)'})`; break
    case 'text': decl = `color: rgb(${r} ${g} ${b} / ${a ?? 'var(--tw-text-opacity, 1)'})`; break
    case 'border': decl = `border-color: rgb(${r} ${g} ${b} / ${a ?? 'var(--tw-border-opacity, 1)'})`; break
    case 'divide': selector += ' > :not([hidden]) ~ :not([hidden])'; decl = `border-color: rgb(${r} ${g} ${b} / ${a ?? 'var(--tw-divide-opacity, 1)'})`; break
    case 'ring': decl = `--tw-ring-color: rgb(${r} ${g} ${b} / ${a ?? 'var(--tw-ring-opacity, 1)'})`; break
    default: continue
  }
  rules.push({ media, selector, decl })
}
rules.sort((x, y) => (x.media ?? '').localeCompare(y.media ?? '') || x.selector.localeCompare(y.selector))

let css = `/* GENERATED by scripts/gen-dark-css.mjs — do not edit by hand.
   Dark-mode values for the fixed colour utilities used in the branding portal
   and the sign-in pages. Re-run the script after adding a new colour class. */

:where(.dark) .nerve-light { color-scheme: dark; }

/* Chart and inline-SVG colours read these; index.css holds the light values. */
.dark {
  --nv-surface: ${SURFACE};
  --nv-canvas: ${CANVAS};
  --nv-raised: ${RAISED};
  --nv-line: ${NEUTRALS['#E5E7EB']};
  --nv-line-strong: ${NEUTRALS['#D1D5DB']};
  --nv-border: ${NEUTRALS['#C5CAD1']};
  --nv-ink: ${NEUTRALS['#111827']};
  --nv-sub: ${NEUTRALS['#6B7280']};
  --nv-faint: ${NEUTRALS['#9CA3AF']};
  --nv-wordmark: ${NEUTRALS['#1B1F54']};
}
`
let current = null
for (const r of rules) {
  if (r.media !== current) {
    if (current !== null) css += '}\n'
    current = r.media
    if (current) css += `\n${current} {\n`
    else css += '\n'
  }
  css += `${current ? '  ' : ''}${r.selector} { ${r.decl}; }\n`
}
if (current) css += '}\n'
writeFileSync(OUT, css)
console.log(`dark.css: ${rules.length} overrides from ${found.size} colour utilities${skipped.size ? `; skipped variants: ${[...skipped].join(', ')}` : ''}`)
