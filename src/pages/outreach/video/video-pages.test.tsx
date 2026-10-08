/* ═══════════════════════════════════════════════════════════════════════════
   The outreach video screens, as each role sees them.

   THE DRIVE DEAD END. All workflow data lives in Google Drive, so with no
   Drive connected every screen fails at once. Only Users and My Videos used
   to say so with the way to fix it; the rest showed a bare message — and
   then, underneath it, an empty state that contradicted it: "Nothing is
   waiting for review.", "Nothing published yet.", "No videos were uploaded
   in ." (no month, because the month comes from the response that failed).
   Every page here is mounted against an API that answers exactly as
   production does without Drive, and must show the notice and nothing that
   claims the list is empty.

   BUTTONS THE API REFUSES. A Manager was offered Schedule and Mark as
   published on the queue and the upload form on My Videos, each ending in
   "Your role cannot perform that action."

   AND TWO SMALLER ONES. A posting time in the activity log read
   "2026-10-20T05:00:00.000Z", and a published video's live links could
   never be added after the fact.
   ═══════════════════════════════════════════════════════════════════════════ */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'

let AUTH: Record<string, unknown> = {}
vi.mock('@/hooks/useAuth', async () => {
  const actual = await vi.importActual<typeof import('@/hooks/useAuth')>('@/hooks/useAuth')
  return { ...actual, useAuth: () => AUTH }
})

import VideoActivity from './VideoActivity'
import VideoCalendar from './VideoCalendar'
import VideoDashboard from './VideoDashboard'
import VideoEditorLog from './VideoEditorLog'
import VideoMyVideos from './VideoMyVideos'
import VideoNotifications from './VideoNotifications'
import VideoPublished from './VideoPublished'
import VideoQueue from './VideoQueue'
import VideoReview from './VideoReview'
import VideoScheduled from './VideoScheduled'
import VideoSearch from './VideoSearch'
import VideoSocialPages from './VideoSocialPages'
import VideoTodo from './VideoTodo'

const NOT_CONNECTED = 'The video workflow is not connected to Google Drive yet. An outreach Admin or Manager can connect it under Video Workflow → Google Drive.'

type Handler = (path: string, init?: RequestInit) => { status: number; body: unknown } | undefined
let handler: Handler = () => undefined
const calls: Array<{ path: string; method: string; body: unknown }> = []

beforeEach(() => {
  calls.length = 0
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).replace(/^.*\/api\/outreach\/video/, '')
    calls.push({ path, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null })
    const answer = handler(path, init) ?? { status: 503, body: { message: NOT_CONNECTED, code: 'drive_not_connected' } }
    return new Response(JSON.stringify(answer.body), {
      status: answer.status, headers: { 'Content-Type': 'application/json' },
    })
  }))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  handler = () => undefined
})

function mount(node: React.ReactNode) {
  return render(<MemoryRouter>{node}</MemoryRouter>)
}

const as = (role: string) => { AUTH = { role, team: 'outreach', loading: false, profile: { capabilities: [] } } }

/* Each page, the empty state it used to draw over the failure, and who opens it. */
const PAGES: Array<[string, () => React.ReactNode, RegExp, string]> = [
  ['Review queue', () => <VideoReview />, /Nothing is waiting for review/i, 'outreach_manager'],
  ['Dashboard', () => <VideoDashboard />, /No videos uploaded yet/i, 'outreach_manager'],
  ['Editor Video Log', () => <VideoEditorLog />, /No videos were uploaded in/i, 'outreach_manager'],
  ['Published', () => <VideoPublished />, /Nothing published yet/i, 'outreach_manager'],
  ['Publishing Queue', () => <VideoQueue />, /Nothing waiting/i, 'outreach_publisher'],
  ['Activity', () => <VideoActivity />, /No activity recorded yet/i, 'outreach_manager'],
  ['Calendar', () => <VideoCalendar />, /Click a day to add an event/i, 'outreach_manager'],
  ['All Videos', () => <VideoSearch />, /No videos match/i, 'outreach_manager'],
  ['Social Pages', () => <VideoSocialPages />, /No pages have been added yet/i, 'outreach_manager'],
  ['Notifications', () => <VideoNotifications />, /No notifications yet|Nothing unread/i, 'outreach_manager'],
  ['Scheduled', () => <VideoScheduled />, /Nothing is scheduled/i, 'outreach_manager'],
  ['To-Do List', () => <VideoTodo />, /Nothing assigned to you yet/i, 'outreach_editor'],
]

describe('every video page with no Google Drive connected', () => {
  for (const [name, page, emptyState, role] of PAGES) {
    it(`${name}: says why, offers the way to the fix, and claims nothing is empty`, async () => {
      as(role)
      mount(page())
      expect(await screen.findByText(NOT_CONNECTED)).toBeTruthy()
      if (role === 'outreach_manager') {
        expect(screen.getByRole('link', { name: /Open Video Workflow → Google Drive/ })
          .getAttribute('href')).toBe('/outreach/video/drive')
      } else {
        expect(screen.queryByRole('link', { name: /Google Drive/ })).toBeNull()
        expect(screen.getByText('Ask an outreach Admin or Manager to connect Google Drive.')).toBeTruthy()
      }
      expect(screen.queryByText(emptyState)).toBeNull()
    })
  }

  it('the Dashboard keeps its heading over the notice', async () => {
    as('outreach_manager')
    mount(<VideoDashboard />)
    await screen.findByText(NOT_CONNECTED)
    expect(screen.getByRole('heading', { name: 'Workflow Dashboard' })).toBeTruthy()
  })

  it("My Videos gives an editor one answer, not two contradictory ones", async () => {
    as('outreach_editor')
    handler = path => path === '/config'
      ? { status: 200, body: { configured: false, directUpload: false } } : undefined
    mount(<VideoMyVideos />)
    await screen.findByText(NOT_CONNECTED)
    expect(screen.getByText('Ask an outreach Admin or Manager to connect Google Drive.')).toBeTruthy()
    expect(screen.queryByText(/reconnect/i)).toBeNull()
    expect(screen.queryByText(/An administrator/i)).toBeNull()
  })

  it('a revoked Drive still asks for a reconnect', async () => {
    as('outreach_editor')
    handler = () => ({ status: 503, body: { message: 'The connection has expired.', code: 'drive_reconnect' } })
    mount(<VideoTodo />)
    expect(await screen.findByText('Ask an outreach Admin or Manager to reconnect Google Drive.')).toBeTruthy()
  })
})

const video = (o: Record<string, unknown> = {}) => ({
  id: 'v1', title: 'FIX clip - Video 1', editorTitle: 'FIX clip', client: 'FIX client', caption: 'cap',
  status: 'approved', createdAt: '2026-10-01T00:00:00Z', submittedAt: '2026-10-02T00:00:00Z',
  activity: [], liveUrls: {}, ...o,
})

describe('the publishing queue', () => {
  beforeEach(() => {
    handler = path => {
      if (path === '/queue') return { status: 200, body: { videos: [video()] } }
      if (path.startsWith('/videos?')) return { status: 200, body: { videos: [] } }
      return undefined
    }
  })

  it('is read-only for a Manager, whom the API does not let schedule or publish', async () => {
    as('outreach_manager')
    mount(<VideoQueue />)
    await screen.findByText('FIX clip - Video 1')
    expect(screen.queryByRole('button', { name: /Schedule/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Mark as published/ })).toBeNull()
  })

  it('still lets a Publisher and an Admin schedule and publish', async () => {
    for (const role of ['outreach_publisher', 'admin', 'super_admin']) {
      as(role)
      mount(<VideoQueue />)
      await screen.findByText('FIX clip - Video 1')
      expect(screen.getByRole('button', { name: /Schedule/ })).toBeTruthy()
      expect(screen.getByRole('button', { name: /Mark as published/ })).toBeTruthy()
      cleanup()
    }
  })
})

describe('My Videos', () => {
  beforeEach(() => {
    handler = path => {
      if (path === '/config') return { status: 200, body: { configured: true, directUpload: false } }
      if (path === '/videos') return { status: 200, body: { videos: [
        video({ id: 'a', title: 'FIX draft', status: 'uploaded' }),
        video({ id: 'b', title: 'FIX rejected', status: 'rejected' }),
      ] } }
      return undefined
    }
  })

  it('offers a Manager no upload, submit or revision, which the API would refuse', async () => {
    as('outreach_manager')
    mount(<VideoMyVideos />)
    await screen.findByText('FIX draft')
    expect(screen.queryByRole('button', { name: /Upload video/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Submit/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Start revision/ })).toBeNull()
  })

  it('still offers them to an Editor', async () => {
    as('outreach_editor')
    mount(<VideoMyVideos />)
    await screen.findByText('FIX draft')
    expect(screen.getByRole('button', { name: /Upload video/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Submit/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Start revision/ })).toBeTruthy()
  })
})

describe('live links after publishing', () => {
  let stored: Record<string, string>
  beforeEach(() => {
    stored = { instagram: 'https://instagram.com/p/old' }
    handler = (path, init) => {
      if (path.startsWith('/videos?')) {
        return { status: 200, body: { videos: [video({ status: 'published', publishedAt: '2026-10-05T00:00:00Z', liveUrls: stored })] } }
      }
      if (path === '/videos/v1/live-urls' && init?.method === 'PATCH') {
        const sent = JSON.parse(String(init.body)).live_urls as Record<string, string>
        stored = Object.fromEntries(Object.entries(sent).filter(([, v]) => v))
        return { status: 200, body: { video: video({ status: 'published', liveUrls: stored }) } }
      }
      return undefined
    }
  })

  it('lets a Publisher add one, correct one and clear one', async () => {
    as('outreach_publisher')
    mount(<VideoPublished />)
    fireEvent.click(await screen.findByRole('button', { name: /Edit links/ }))
    fireEvent.change(screen.getByLabelText('Instagram link'), { target: { value: '' } })
    fireEvent.change(screen.getByLabelText('Facebook link'), { target: { value: ' https://facebook.com/x ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save links' }))

    await waitFor(() => expect(screen.queryByRole('button', { name: 'Save links' })).toBeNull())
    /* Both platforms are sent: an empty one is how the API removes a link. */
    expect(calls.find(c => c.method === 'PATCH')?.body)
      .toEqual({ live_urls: { instagram: '', facebook: 'https://facebook.com/x' } })
    expect(await screen.findByRole('link', { name: /facebook/i })).toBeTruthy()
    expect(screen.queryByRole('link', { name: /instagram/i })).toBeNull()
  })

  it('is not offered to an Editor, whom the API refuses', async () => {
    as('outreach_editor')
    mount(<VideoPublished />)
    await screen.findByText('FIX clip - Video 1')
    expect(screen.queryByRole('button', { name: /links/ })).toBeNull()
  })
})

describe('the activity log', () => {
  it('shows a scheduled posting time as a time, not as an ISO string', async () => {
    as('outreach_manager')
    const iso = '2026-10-20T05:00:00.000Z'
    handler = path => {
      if (path.startsWith('/activity/actors')) return { status: 200, body: { actors: [] } }
      if (path.startsWith('/activity')) return { status: 200, body: { entries: [{
        id: 'e1', userName: 'FIX Publisher', userRole: 'publisher', action: 'video.scheduled',
        timestamp: '2026-10-08T12:53:00Z', previousStatus: 'approved', newStatus: 'scheduled', notes: iso,
        subject: { type: 'video', id: 'v1', title: 'FIX clip - Video 1' },
      }] } }
      return undefined
    }
    mount(<VideoActivity />)
    await screen.findByText('FIX clip - Video 1')
    expect(screen.queryByText(iso)).toBeNull()
    const expected = new Date(iso).toLocaleString(undefined, {
      day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
    })
    expect(screen.getByText(`For ${expected}`)).toBeTruthy()
  })
})
