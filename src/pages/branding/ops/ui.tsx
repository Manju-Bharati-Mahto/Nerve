/**
 * Shared furniture for the BrandOps pages.
 *
 * Sixteen screens that each fetch, filter, show a table and open a dialog
 * would otherwise be sixteen copies of the same scaffolding; this is that
 * scaffolding, so each page is left holding only what makes it different.
 */
import { useCallback, useEffect, useState } from 'react'
import { AlertCircle, X, Search } from 'lucide-react'

export function BoPage({ title, subtitle, icon: Icon, actions, children }: {
  title: string; subtitle?: string; icon?: React.ElementType
  actions?: React.ReactNode; children: React.ReactNode
}) {
  return (
    <div className="animate-fade-in space-y-5">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          {Icon && (
            <div className="w-10 h-10 rounded-xl bg-blue-100 flex items-center justify-center shrink-0">
              <Icon className="w-5 h-5 text-[#0047AB]" />
            </div>
          )}
          <div>
            <h1 className="text-2xl font-serif text-foreground">{title}</h1>
            {subtitle && <p className="text-sm text-muted-foreground">{subtitle}</p>}
          </div>
        </div>
        {actions && <div className="flex items-center gap-2 flex-wrap">{actions}</div>}
      </div>
      {children}
    </div>
  )
}

export function BoError({ message }: { message: string | null }) {
  if (!message) return null
  return (
    <div className="hub-card bg-rose-50 border-rose-200 flex items-start gap-2 text-sm text-rose-900">
      <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" /> <span>{message}</span>
    </div>
  )
}

export function BoLoading() {
  return <div className="hub-card text-center py-12 text-sm text-muted-foreground">Loading…</div>
}

export function BoEmpty({ children }: { children: React.ReactNode }) {
  return <div className="hub-card text-center py-12 text-sm text-muted-foreground">{children}</div>
}

export function BoKpi({ label, value, accent, onClick }: {
  label: string; value: React.ReactNode; accent?: boolean; onClick?: () => void
}) {
  const cls = `hub-card py-3 ${accent ? 'border-amber-300 bg-amber-50/50' : ''} ${onClick ? 'cursor-pointer hover:border-[#0047AB] transition-colors' : ''}`
  return (
    <div className={cls} onClick={onClick} role={onClick ? 'button' : undefined} tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? e => { if (e.key === 'Enter' || e.key === ' ') onClick() } : undefined}>
      <div className="text-2xl font-serif text-foreground leading-none">{value}</div>
      <div className="text-[11px] text-muted-foreground mt-1.5">{label}</div>
    </div>
  )
}

export function BoBadge({ style }: { style: { label: string; cls: string } }) {
  return <span className={`hub-badge ${style.cls}`}>{style.label}</span>
}

export function BoSearch({ value, onChange, placeholder }: {
  value: string; onChange: (v: string) => void; placeholder: string
}) {
  return (
    <div className="relative flex-1 min-w-[200px]">
      <Search className="w-4 h-4 text-muted-foreground absolute left-3 top-1/2 -translate-y-1/2" />
      <input className="hub-input pl-9" placeholder={placeholder} value={value}
        onChange={e => onChange(e.target.value)} />
    </div>
  )
}

export function BoSelect({ label, value, onChange, options, className = '' }: {
  label: string; value: string; onChange: (v: string) => void
  options: [string, string][]; className?: string
}) {
  return (
    <select className={`hub-input py-1.5 text-xs w-auto ${className}`} value={value}
      onChange={e => onChange(e.target.value)}>
      <option value="">{label}</option>
      {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </select>
  )
}

/** A scrollable table wrapper — BrandOps tables are wide by nature. */
export function BoTable({ head, children, empty }: {
  head: string[]; children: React.ReactNode; empty?: string
}) {
  const rows = Array.isArray(children) ? children.flat() : children
  const isEmpty = Array.isArray(rows) ? rows.length === 0 : !rows
  return (
    <div className="hub-card overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-muted-foreground border-b border-border">
            {head.map(h => <th key={h} className="py-2 pr-3 font-medium whitespace-nowrap">{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {isEmpty
            ? <tr><td colSpan={head.length} className="py-10 text-center text-muted-foreground">{empty ?? 'Nothing here yet.'}</td></tr>
            : rows}
        </tbody>
      </table>
    </div>
  )
}

export function BoRow({ children }: { children: React.ReactNode }) {
  return <tr className="border-b border-border/60 last:border-0 align-top">{children}</tr>
}

export function BoCell({ children, strong, nowrap }: {
  children: React.ReactNode; strong?: boolean; nowrap?: boolean
}) {
  return (
    <td className={`py-2.5 pr-3 ${strong ? 'text-foreground font-medium' : 'text-muted-foreground'} ${nowrap ? 'whitespace-nowrap' : ''}`}>
      {children}
    </td>
  )
}

export function BoButton({ onClick, children, variant = 'primary', disabled, type = 'button' }: {
  onClick?: () => void; children: React.ReactNode
  variant?: 'primary' | 'ghost' | 'danger' | 'success'; disabled?: boolean
  type?: 'button' | 'submit'
}) {
  const styles = {
    primary: 'bg-[#0047AB] text-white hover:opacity-90',
    ghost: 'border border-border text-muted-foreground hover:bg-accent',
    danger: 'border border-rose-200 text-rose-600 hover:bg-rose-50',
    success: 'bg-emerald-600 text-white hover:opacity-90',
  }[variant]
  return (
    <button type={type} onClick={onClick} disabled={disabled}
      className={`text-xs px-3 py-1.5 rounded-lg font-medium disabled:opacity-40 inline-flex items-center gap-1.5 ${styles}`}>
      {children}
    </button>
  )
}

export function BoDialog({ title, onClose, children, footer, wide }: {
  title: string; onClose: () => void; children: React.ReactNode
  footer?: React.ReactNode; wide?: boolean
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4 animate-fade-in"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className={`bg-card rounded-xl border border-border w-full ${wide ? 'max-w-3xl' : 'max-w-lg'} max-h-[88vh] flex flex-col`}>
        <div className="flex items-start justify-between p-4 border-b border-border shrink-0">
          <h2 className="text-base font-serif text-foreground">{title}</h2>
          <button onClick={onClose} className="p-2 rounded-lg hover:bg-accent text-muted-foreground">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-4 space-y-3 overflow-y-auto">{children}</div>
        {footer && <div className="flex items-center justify-end gap-2 p-4 border-t border-border shrink-0">{footer}</div>}
      </div>
    </div>
  )
}

export function BoField({ label, children, hint }: {
  label: string; children: React.ReactNode; hint?: string
}) {
  return (
    <div>
      <label className="hub-label">{label}</label>
      {children}
      {hint && <p className="text-[11px] text-muted-foreground mt-1">{hint}</p>}
    </div>
  )
}

/**
 * The fetch-render-refetch loop every page runs. Returns the data, a refetch,
 * and the error — rather than each page reimplementing loading state and
 * forgetting one of the three.
 */
export function useBoData<T>(load: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  // The loader closes over page state, so it is intentionally re-created each
  // render and pinned by the caller's dependency list instead.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(load, deps)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      setData(await run())
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load this page.')
    } finally {
      setLoading(false)
    }
  }, [run])

  useEffect(() => { void refresh() }, [refresh])
  return { data, error, loading, refresh, setError }
}

/** Runs a mutation, surfaces its error, and refreshes on success. */
export function useBoAction(refresh: () => Promise<void>, setError: (m: string | null) => void) {
  const [busy, setBusy] = useState(false)
  const act = useCallback(async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
      await refresh()
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That action did not complete.')
      return false
    } finally {
      setBusy(false)
    }
  }, [refresh, setError])
  return { busy, act }
}
