/* PRD 6.3 — a State User reads influencer data for their states and has no
   video workflow, so they land on the influencer Dashboard; the outreach roles
   that were already there land where they always did. */
import { describe, it, expect } from 'vitest'
import { getRoleDashboard } from './useAuth'
import { ROLES } from '@/lib/constants'

describe('where an outreach person lands after signing in', () => {
  it('sends a State User to the outreach Dashboard', () => {
    expect(ROLES).toContain('outreach_state_user')
    expect(getRoleDashboard('outreach_state_user', 'outreach')).toBe('/outreach/dashboard')
  })

  it('leaves the existing outreach roles where they were', () => {
    expect(getRoleDashboard('outreach_manager', 'outreach')).toBe('/outreach/dashboard')
    expect(getRoleDashboard('outreach_publisher', 'outreach')).toBe('/outreach/video/queue')
    expect(getRoleDashboard('outreach_editor', 'outreach')).toBe('/outreach/video/my-videos')
  })
})
