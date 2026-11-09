import { useEffect, useState } from 'react'
import { Check, RotateCcw, Layers, Sun, Moon, Monitor } from 'lucide-react'
import { L, cx, Modal, Badge, IconTile, Segmented } from './ds2'
import {
  DEFAULT_PRIMARY, PRIMARY_PRESETS, applyPrimary, derivePalette, isHex, loadPrimary, savePrimary,
  applyMode, loadMode, saveMode, resolveMode, type ThemeMode,
} from './theme'

/** The saved colour mode and what it currently resolves to; setting it
    applies the change live, saves it and re-derives the accent family. */
export function useThemeMode(): { mode: ThemeMode; resolved: 'light' | 'dark'; setMode: (m: ThemeMode) => void } {
  const [mode, setModeState] = useState<ThemeMode>(() => loadMode())
  const [resolved, setResolved] = useState<'light' | 'dark'>(() => resolveMode(loadMode()))
  useEffect(() => {
    const sync = () => { setModeState(loadMode()); setResolved(resolveMode(loadMode())) }
    window.addEventListener('nerve-mode', sync)
    return () => window.removeEventListener('nerve-mode', sync)
  }, [])
  const setMode = (m: ThemeMode) => {
    saveMode(m)
    setModeState(m)
    setResolved(applyMode(m))
  }
  return { mode, resolved, setMode }
}

/** Sun/moon button for the top bar: flips between light and dark. */
export function ModeToggle({ className }: { className?: string }) {
  const { resolved, setMode } = useThemeMode()
  const dark = resolved === 'dark'
  return (
    <button
      type="button"
      onClick={() => setMode(dark ? 'light' : 'dark')}
      className={cx(L.iconGhost, className)}
      aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
      title={dark ? 'Light mode' : 'Dark mode'}
      aria-pressed={dark}
    >
      {dark ? <Sun className="w-4 h-4" strokeWidth={1.75} /> : <Moon className="w-4 h-4" strokeWidth={1.75} />}
    </button>
  )
}

/**
 * "Appearance" popup behind the paintbrush in the top bar. Pick a preset or
 * any custom colour; the change applies live across the dashboard and is
 * remembered for next time. Text and button colours are derived from the
 * pick so everything stays legible.
 */
export default function ThemeModal({ onClose }: { onClose: () => void }) {
  const [hex, setHex] = useState(() => loadPrimary())
  const [draft, setDraft] = useState(hex)
  const { mode, resolved, setMode } = useThemeMode()
  const palette = derivePalette(hex, resolved === 'dark')

  const choose = (next: string) => {
    if (!isHex(next)) return
    const v = next.toUpperCase()
    setHex(v)
    setDraft(v)
    applyPrimary(v)
    savePrimary(v)
  }

  const activePreset = PRIMARY_PRESETS.find(p => p.hex.toUpperCase() === hex.toUpperCase())

  return (
    <Modal
      size="sm"
      title="Appearance"
      subtitle="Choose light or dark and a primary colour. Buttons, highlights and links follow it; text adjusts itself to stay readable."
      onClose={onClose}
      footer={
        <div className="flex items-center justify-between gap-2 w-full">
          <button
            type="button"
            onClick={() => choose(DEFAULT_PRIMARY)}
            disabled={hex.toUpperCase() === DEFAULT_PRIMARY}
            className={cx(L.btn, L.btnGhost, L.btnSm, 'disabled:opacity-50 disabled:cursor-default')}
          >
            <RotateCcw className="w-3.5 h-3.5" strokeWidth={1.75} /> Reset to brand blue
          </button>
          <button type="button" onClick={onClose} className={cx(L.btn, L.btnPrimary, L.btnSm)}>Done</button>
        </div>
      }
    >
      <p className={cx(L.eyebrow, 'mb-2')}>Mode</p>
      <Segmented<ThemeMode>
        size="sm"
        value={mode}
        onChange={setMode}
        options={[
          { id: 'light', label: <span className="inline-flex items-center gap-1.5"><Sun className="w-3.5 h-3.5" strokeWidth={1.75} /> Light</span> },
          { id: 'dark', label: <span className="inline-flex items-center gap-1.5"><Moon className="w-3.5 h-3.5" strokeWidth={1.75} /> Dark</span> },
          { id: 'system', label: <span className="inline-flex items-center gap-1.5"><Monitor className="w-3.5 h-3.5" strokeWidth={1.75} /> System</span> },
        ]}
      />
      {mode === 'system' && <p className={cx(L.hint)}>Following your device: currently {resolved}.</p>}

      <p className={cx(L.eyebrow, 'mt-5 mb-2')}>Primary colour</p>
      <div className="grid grid-cols-4 gap-2">
        {PRIMARY_PRESETS.map(p => {
          const on = p.hex.toUpperCase() === hex.toUpperCase()
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => choose(p.hex)}
              aria-pressed={on}
              title={p.label}
              className={cx(
                'flex flex-col items-center gap-1.5 p-2 rounded-[6px] border bg-white cursor-pointer',
                on ? 'border-[var(--nerve-primary)] ring-1 ring-[var(--nerve-primary)]' : 'border-[#C5CAD1] hover:border-[#9CA3AF]',
              )}
            >
              <span
                className="w-8 h-8 rounded-full grid place-items-center shadow-[inset_0_0_0_1px_rgba(16,24,40,0.08)]"
                style={{ background: p.hex }}
                aria-hidden="true"
              >
                {on && <Check className="w-4 h-4" strokeWidth={2.5} style={{ color: derivePalette(p.hex).onPrimary }} />}
              </span>
              <span className="text-[11px] text-[#374151] leading-none">{p.label}</span>
            </button>
          )
        })}
      </div>

      <p className={cx(L.eyebrow, 'mt-5 mb-2')}>Custom colour</p>
      <div className="flex items-center gap-2">
        <label className="relative w-10 h-9 rounded-[6px] border border-[#C5CAD1] overflow-hidden cursor-pointer shrink-0" title="Pick any colour">
          <input
            type="color"
            value={hex}
            onChange={e => choose(e.target.value)}
            className="absolute -inset-2 w-[calc(100%+16px)] h-[calc(100%+16px)] cursor-pointer border-0 p-0"
            aria-label="Pick a colour"
          />
        </label>
        <input
          type="text"
          value={draft}
          onChange={e => { setDraft(e.target.value); if (isHex(e.target.value)) choose(e.target.value) }}
          onBlur={() => { if (!isHex(draft)) setDraft(hex) }}
          spellCheck={false}
          maxLength={7}
          className={cx(L.input, 'h-9 w-28 font-mono text-[13px] uppercase')}
          aria-label="Hex colour"
        />
        <span className={L.meta}>{activePreset ? activePreset.label : 'Custom'}</span>
      </div>

      <p className={cx(L.eyebrow, 'mt-5 mb-2')}>Preview</p>
      <div className="rounded-[6px] border border-[#C5CAD1] p-3 flex items-center gap-3 flex-wrap bg-[#F9FAFB]">
        <button type="button" className={cx(L.btn, L.btnPrimary, L.btnSm)} tabIndex={-1}>Primary button</button>
        <Badge hue="blue" dot>In progress</Badge>
        <IconTile icon={Layers} hue="blue" />
        <span className="text-[13px] font-medium" style={{ color: palette.text }}>Link text</span>
      </div>
    </Modal>
  )
}
