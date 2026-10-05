/* ═══════════════════════════════════════════════════════════════════════════
   §5's four calendar statuses — Upcoming, Running/Scheduled, Pending,
   Completed — and how the workflow's finer statuses fold into them.

   The rule a Manager relies on is the third one: anything whose date has
   passed without being done is PENDING, not still "upcoming". A missed slot
   is what someone looks at a calendar to find, and it must not look the same
   as next week's plans.
   ═══════════════════════════════════════════════════════════════════════════ */
import { describe, expect, it } from 'vitest'
import { calendarStatusOf } from '@/lib/outreach-video-data'

const NOW = new Date('2027-01-15T12:00:00')

describe('events', () => {
  it('is Upcoming on or after today', () => {
    expect(calendarStatusOf({ kind: 'event', status: 'open', date: '2027-01-20' }, NOW)).toBe('upcoming')
    expect(calendarStatusOf({ kind: 'event', status: 'unassigned', date: '2027-01-15' }, NOW)).toBe('upcoming')
  })

  it('is Pending once its day has passed without being completed', () => {
    expect(calendarStatusOf({ kind: 'event', status: 'open', date: '2027-01-14' }, NOW)).toBe('pending')
    expect(calendarStatusOf({ kind: 'event', status: 'unassigned', date: '2026-12-01' }, NOW)).toBe('pending')
  })

  it('is Completed when completed, whatever the date', () => {
    expect(calendarStatusOf({ kind: 'event', status: 'completed', date: '2026-12-01' }, NOW)).toBe('completed')
    expect(calendarStatusOf({ kind: 'event', status: 'completed', date: '2027-02-01' }, NOW)).toBe('completed')
  })
})

describe('postings', () => {
  it('is Running/Scheduled while its slot is still ahead', () => {
    expect(calendarStatusOf({ kind: 'posting', status: 'scheduled', when: '2027-01-15T18:00:00' }, NOW)).toBe('scheduled')
  })

  it('is Pending once its slot has passed and it has not gone out', () => {
    expect(calendarStatusOf({ kind: 'posting', status: 'scheduled', when: '2027-01-15T09:00:00' }, NOW)).toBe('pending')
  })

  it('is Completed once published', () => {
    expect(calendarStatusOf({ kind: 'posting', status: 'published', when: '2027-01-10T09:00:00' }, NOW)).toBe('completed')
  })
})
