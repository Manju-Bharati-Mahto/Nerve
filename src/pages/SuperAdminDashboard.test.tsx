import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import SuperAdminDashboard from './SuperAdminDashboard'

const mockGetSuperAdminStats = vi.fn(async () => ({
  designs_count: 2,
  projects_count: 1,
  today_submitted: 1,
  today_total: 2,
  recent_designs: [],
}))

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    profile: { id: 'me', full_name: 'Opsa', email: 'opsa@example.com', department: 'Ops' },
  }),
}))

vi.mock('@/hooks/useAppData', () => ({
  useAppData: () => ({
    users: [
      {
        id: 'branding-admin',
        full_name: 'Branding Admin',
        email: 'branding@example.com',
        department: 'Branding',
        avatar_url: null,
        role: 'admin',
        team: 'branding',
        managed_by: null,
        created_at: '2026-04-07T00:00:00.000Z',
        updated_at: '2026-04-07T00:00:00.000Z',
      },
      {
        id: 'content-admin',
        full_name: 'Content Admin',
        email: 'content@example.com',
        department: 'Content',
        avatar_url: null,
        role: 'admin',
        team: 'content',
        managed_by: null,
        created_at: '2026-04-07T00:00:00.000Z',
        updated_at: '2026-04-07T00:00:00.000Z',
      },
      {
        id: 'outreach-manager',
        full_name: 'Outreach Manager',
        email: 'manager@example.com',
        department: 'Outreach',
        avatar_url: null,
        role: 'outreach_manager',
        team: 'outreach',
        managed_by: null,
        created_at: '2026-04-07T00:00:00.000Z',
        updated_at: '2026-04-07T00:00:00.000Z',
      },
      {
        id: 'outreach-editor',
        full_name: 'Vid Editor',
        email: 'editor@example.com',
        department: 'Outreach',
        avatar_url: null,
        role: 'outreach_editor',
        team: 'outreach',
        managed_by: null,
        created_at: '2026-04-07T00:00:00.000Z',
        updated_at: '2026-04-07T00:00:00.000Z',
      },
      {
        id: 'outreach-publisher',
        full_name: 'Vid Publisher',
        email: 'publisher@example.com',
        department: 'Outreach',
        avatar_url: null,
        role: 'outreach_publisher',
        team: 'outreach',
        managed_by: null,
        created_at: '2026-04-07T00:00:00.000Z',
        updated_at: '2026-04-07T00:00:00.000Z',
      },
    ],
    entries: [
      {
        id: 'entry-1',
        title: 'Campus update',
        dept: 'Content',
        type: 'Article',
        body: 'Update body',
        priority: 'Normal',
        entry_date: '2026-04-07',
        created_by: 'content-admin',
        tags: [],
        author_name: 'Content Admin',
        academic_year: '2025-2026',
        student_count: null,
        external_link: '',
        collaborating_org: '',
        created_at: '2026-04-07T00:00:00.000Z',
        attachments: [],
      },
    ],
  }),
}))

vi.mock('@/lib/branding-api', () => ({
  brandingApi: {
    getSuperAdminStats: () => mockGetSuperAdminStats(),
  },
}))

vi.mock('@/lib/outreach-data', () => ({
  useOutreachData: () => ({
    pages: [], creators: [], campaigns: [], posts: [], loaded: true, error: null,
  }),
  campaignMetrics: () => ({ totalReach: 0 }),
}))

const mockGetKpis = vi.fn(async () => ({
  totalVideos: 7, draftVideos: 1, submittedVideos: 2, publishedVideos: 4,
  avgDraftToSubmittedHours: 6, avgSubmittedToPublishedHours: 30,
  publishedThisWeek: 3, publishedThisMonth: 4,
  videosByEditor: [], videosByClient: [],
  totalEvents: 5, upcomingEvents: 2, pastEvents: 3,
  unassignedEvents: 1, completedEvents: 2, eventsByEditor: [],
}))

vi.mock('@/lib/outreach-video-data', () => ({
  getKpis: () => mockGetKpis(),
  formatHours: (h: number | null) => (h === null ? '—' : `${h} h`),
}))

/** The stat card carrying a given label, so a number is read against its own card. */
function statCard(label: string): HTMLElement {
  const el = screen.getByText(label).closest('.hub-card')
  if (!el) throw new Error(`No stat card found for "${label}"`)
  return el as HTMLElement
}

function LocationProbe() {
  const location = useLocation()
  return <div data-testid="location-search">{location.search}</div>
}

function renderDashboard(initialEntry = '/super-admin/dashboard') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route
          path="/super-admin/dashboard"
          element={
            <>
              <SuperAdminDashboard />
              <LocationProbe />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  )
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('SuperAdminDashboard', () => {
  it('restores the selected tab from the query string on load', async () => {
    renderDashboard('/super-admin/dashboard?tab=branding')

    expect(screen.getByRole('tab', { name: /branding team/i })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('Branding Team Members')).toBeInTheDocument()
    await waitFor(() => expect(mockGetSuperAdminStats).toHaveBeenCalled())
  })

  it('updates the query string when the active tab changes and restores it after reload', async () => {
    const { unmount } = renderDashboard()

    fireEvent.keyDown(screen.getByRole('tab', { name: /content team/i }), { key: 'Enter' })

    await waitFor(() => expect(screen.getByRole('tab', { name: /content team/i })).toHaveAttribute('aria-selected', 'true'))
    await waitFor(() => expect(screen.getByTestId('location-search')).toHaveTextContent('?tab=content'))

    unmount()
    renderDashboard('/super-admin/dashboard?tab=content')

    expect(screen.getByRole('tab', { name: /content team/i })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('Content Team Members')).toBeInTheDocument()
  })

  it('falls back to overview for an invalid tab query', async () => {
    renderDashboard('/super-admin/dashboard?tab=unknown')

    expect(screen.getByRole('tab', { name: /overview/i })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('Team overview')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByTestId('location-search')).toHaveTextContent('?tab=overview'))
  })

  it('normalizes empty tab query values to a single overview tab param', async () => {
    renderDashboard('/super-admin/dashboard?tab=')

    expect(screen.getByRole('tab', { name: /overview/i })).toHaveAttribute('aria-selected', 'true')
    await waitFor(() => expect(screen.getByTestId('location-search')).toHaveTextContent('?tab=overview'))
  })

  it('normalizes duplicate tab params to a single canonical value', async () => {
    renderDashboard('/super-admin/dashboard?tab=branding&tab=unknown')

    expect(screen.getByRole('tab', { name: /branding team/i })).toHaveAttribute('aria-selected', 'true')
    await waitFor(() => expect(screen.getByTestId('location-search')).toHaveTextContent('?tab=branding'))
  })

  it('counts the whole outreach department, not only its managers', async () => {
    renderDashboard('/super-admin/dashboard?tab=overview')

    // Manager + editor + publisher. Counting managers alone reported 1 and made
    // the other two look like nobody.
    expect(statCard('Outreach team')).toHaveTextContent('3')
    expect(screen.getByText(/3 members/)).toBeInTheDocument()
  })
})

describe('SuperAdminDashboard — video workflow', () => {
  it('shows the workflow team and its KPIs on the outreach tab', async () => {
    renderDashboard('/super-admin/dashboard?tab=outreach')

    expect(screen.getByText('Video workflow')).toBeInTheDocument()
    // The campaign half is still there — this is one department, not two tabs.
    expect(screen.getByText('Outreach Managers')).toBeInTheDocument()

    await waitFor(() => expect(mockGetKpis).toHaveBeenCalled())
    // Assert through each card's own label — a bare number matches several
    // cards and would pass for the wrong reason.
    await waitFor(() => expect(statCard('Videos')).toHaveTextContent('7'))
    expect(statCard('In queue')).toHaveTextContent('2')
    expect(statCard('Published')).toHaveTextContent('4')
    expect(statCard('Unassigned')).toHaveTextContent('1')

    expect(screen.getByText('Vid Editor')).toBeInTheDocument()
    expect(screen.getByText('Vid Publisher')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Workflow Dashboard/ })).toHaveAttribute('href', '/outreach/video/dashboard')
  })

  it('degrades to dashes when the workflow API is unreachable', async () => {
    mockGetKpis.mockRejectedValueOnce(new Error('Drive is not connected yet.'))
    renderDashboard('/super-admin/dashboard?tab=outreach')

    await waitFor(() => expect(screen.getByText(/Drive is not connected yet/)).toBeInTheDocument())
    // The roster is local data, so it survives the API being down.
    expect(screen.getByText('Vid Editor')).toBeInTheDocument()
  })
})
