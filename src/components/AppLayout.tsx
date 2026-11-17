import { useEffect, useState } from 'react'
import { useNavigate, Outlet, useLocation } from 'react-router-dom'
import { Paintbrush } from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'
import { useAppData } from '@/hooks/useAppData'
import AppSidebar from './AppSidebar'
import { L, cx } from '@/pages/branding/ds2'
import ThemeModal, { ModeToggle } from '@/pages/branding/ThemeModal'

export default function AppLayout() {
  const { user, loading } = useAuth()
  const { loading: dataLoading, error } = useAppData()
  const navigate = useNavigate()
  const location = useLocation()
  const [themeOpen, setThemeOpen] = useState(false)

  useEffect(() => {
    if (!loading && !user) navigate('/login')
  }, [user, loading, navigate])

  if (loading || dataLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-sm text-muted-foreground animate-pulse">Loading...</div>
      </div>
    )
  }

  if (!user) return null

  // The redesigned Branding portal (and BrandOps) is a self-contained,
  // full-viewport shell — its own sidebar, top bar and drawers. Render it
  // edge-to-edge, without the Knowledge-Hub sidebar and the px-6/py-8 content
  // padding, so its h-full layout and fixed drawers resolve against the
  // viewport instead of a padded, overflow-auto box. (Mirrors how /media is
  // mounted outside this layout.)
  if (location.pathname.startsWith('/branding')) {
    return (
      <div className="h-screen overflow-hidden bg-background">
        <Outlet />
      </div>
    )
  }

  // The Design portal also ships its own full-height shell (DesignAdminShell),
  // but — unlike branding — its pages climb out of page padding with negative
  // margins, so they need the padding to remain. Drop only the global sidebar
  // (so a super-admin doesn't get two stacked sidebars) and keep px-6/py-8.
  if (location.pathname.startsWith('/design')) {
    return (
      <div className="flex min-h-screen bg-background">
        <main className="flex-1 overflow-auto min-w-0">
          <div className="px-6 py-8 w-full">
            <Outlet />
          </div>
        </main>
      </div>
    )
  }

  // Shared Knowledge-Hub chrome (Content, Outreach, Super Admin), reskinned to
  // the Nerve-Light design language: grey canvas, a slim top bar carrying the
  // colour-mode toggle + appearance (primary colour) control, and the branding
  // sidebar styling (in AppSidebar). Nav items, routes and guards are unchanged.
  // A few shared routes wrap themselves in a department shell that already owns a
  // top bar (e.g. /admin/export via MaybeBrandingAdminShell for a branding
  // admin). Skip our top bar there so we never stack two.
  const selfChromed = location.pathname === '/admin/export'

  // Self-chromed routes bring their own department shell (which climbs out of
  // page padding). Keep the original padded, auto-scroll layout for those so
  // that shell resolves exactly as before — just drop our top bar.
  if (selfChromed) {
    return (
      <div className="nerve-light flex min-h-screen bg-[#F9FAFB]">
        <AppSidebar />
        <main className="flex-1 overflow-auto min-w-0">
          <div className="px-6 py-8 w-full">
            {error && (
              <div className="mb-6 rounded-xl border border-destructive/20 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                {error}
              </div>
            )}
            <Outlet />
          </div>
        </main>
      </div>
    )
  }

  const now = new Date()
  const dateChip = `${now.toLocaleDateString('en-GB', { weekday: 'short' })} ${now.getDate()} ${now.toLocaleDateString('en-GB', { month: 'short' })}`

  // Fixed-viewport shell (matches the branding portal): the sidebar and top bar
  // stay put and only the content scrolls — no body scroll, no sidebar drift.
  return (
    <div className="nerve-light flex h-screen overflow-hidden bg-[#F9FAFB]">
      <AppSidebar />
      <main className="flex-1 min-w-0 flex flex-col overflow-hidden">
        <header className="h-12 shrink-0 flex items-center justify-between gap-3 px-4 sm:px-6 border-b border-[#C5CAD1] bg-white">
          <span className="text-[13px] font-medium text-[#6B7280] truncate">Workspace</span>
          <div className="flex items-center gap-0.5">
            <span className="hidden md:inline-flex items-center gap-2 text-[12px] text-[#6B7280] mr-2 whitespace-nowrap">
              <span>{dateChip}</span>
              <span className="text-[#D1D5DB]" aria-hidden="true">·</span>
              <span className="inline-flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-[#22C55E]" aria-hidden="true" />
                Workspace live
              </span>
            </span>
            <ModeToggle />
            <button
              type="button"
              onClick={() => setThemeOpen(true)}
              className={cx(L.iconGhost, themeOpen && 'bg-[#F3F4F6] text-[#111827]')}
              aria-label="Appearance"
              title="Appearance · colour mode and primary colour"
            >
              <Paintbrush className="w-4 h-4" strokeWidth={1.75} />
            </button>
          </div>
        </header>
        <div className="flex-1 overflow-y-auto overscroll-contain">
          <div className="px-6 py-8 w-full">
            {error && (
              <div className="mb-6 rounded-xl border border-destructive/20 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                {error}
              </div>
            )}
            <Outlet />
          </div>
        </div>
      </main>
      {themeOpen && <ThemeModal onClose={() => setThemeOpen(false)} />}
    </div>
  )
}
