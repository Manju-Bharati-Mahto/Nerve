import { afterEach, describe, expect, it, vi } from 'vitest'
import { PENDING_TTL_MS, loadPendingFinish, storePendingFinish } from './outreach-video-data'

/** "Finish saving" for a file already in Drive, remembered across a closed dialog. */
describe('pending finish storage', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    window.sessionStorage.clear()
  })

  it('round-trips per user', () => {
    storePendingFinish('u1', { sessionId: 's', fileId: 'f', title: 'Cut 3' }, 1000)
    expect(loadPendingFinish('u1', 2000)).toEqual({ sessionId: 's', fileId: 'f', title: 'Cut 3' })
    expect(loadPendingFinish('u2', 2000)).toBeNull()
  })

  it('forgets an entry older than a day, which the server no longer honours', () => {
    storePendingFinish('u1', { sessionId: 's', fileId: 'f' }, 0)
    expect(loadPendingFinish('u1', PENDING_TTL_MS + 1)).toBeNull()
    expect(window.sessionStorage.length).toBe(0)
  })

  it('clears on null and ignores a malformed entry', () => {
    storePendingFinish('u1', { sessionId: 's', fileId: 'f' })
    storePendingFinish('u1', null)
    expect(loadPendingFinish('u1')).toBeNull()
    window.sessionStorage.setItem('outreach-video:pending-finish:u1', '{not json')
    expect(loadPendingFinish('u1')).toBeNull()
  })

  it('does nothing without a user, and survives storage that throws', () => {
    storePendingFinish(null, { sessionId: 's', fileId: 'f' })
    expect(window.sessionStorage.length).toBe(0)
    /* What a browser with site data blocked does: reading the property throws. */
    vi.spyOn(window, 'sessionStorage', 'get').mockImplementation(() => { throw new DOMException('blocked', 'SecurityError') })
    expect(() => storePendingFinish('u1', { sessionId: 's', fileId: 'f' })).not.toThrow()
    expect(loadPendingFinish('u1')).toBeNull()
  })
})
