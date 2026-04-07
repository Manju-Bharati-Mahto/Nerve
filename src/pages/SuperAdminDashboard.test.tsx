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
})
