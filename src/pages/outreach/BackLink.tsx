import { useNavigate } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'

/**
 * FR-01 — a history-aware Back control for the Outreach detail screens.
 *
 * When there is a previous in-app screen, it goes back to it with
 * `navigate(-1)` — which restores the prior route, its scroll position and any
 * URL-based filters (AC-01). On a fresh entry (deep link or browser refresh),
 * React Router's history `idx` is 0, so instead it navigates to `fallback`, a
 * defined landing page, avoiding a dead end or redirect loop (AC-02).
 *
 * The styling matches the links it replaces so no page needs restyling.
 */
export function BackLink({
  fallback,
  label = 'Back',
  className = 'inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground',
}: {
  fallback: string
  label?: string
  className?: string
}) {
  const navigate = useNavigate()

  function goBack() {
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0
    if (idx > 0) navigate(-1)
    else navigate(fallback)
  }

  return (
    <button type="button" onClick={goBack} className={className}>
      <ArrowLeft className="w-4 h-4" /> {label}
    </button>
  )
}
