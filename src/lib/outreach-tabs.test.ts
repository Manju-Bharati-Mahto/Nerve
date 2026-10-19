import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import * as client from './outreach-tabs'
import * as server from '../../server/outreach-tabs'
import {
  OUTREACH_TABS, cleanTabLevels, defaultTabLevels, levelAtLeast, outreachTabForPath,
} from './outreach-tabs'
import { canUseTab, firstOpenTab, isOutreachAdminRole, type OutreachAccess } from './outreach-access'

/* The Account Tabs requirements' list, as the PDF names them. Every one must
   be in the grid, Off / View / Edit. */
const PDF_TABS = [
  'Dashboard', 'Campaigns', 'Calendar', 'Analytics', 'Alerts', 'State', 'Creators',
  'Video Dashboard', 'Users', 'Google Drive', 'Video Campaigns', 'Review Queue', 'Event Calendar',
  'All Videos', 'Publishing Queue', 'Published', 'Editor Video Log', 'Activity', 'Notifications',
]

describe('the outreach tab list', () => {
  it('is the same file in the browser and on the server', () => {
    // The server refuses by this list and the grid is drawn from it; if they
    // drift, the grid offers a tab the API does not know.
    const root = path.resolve(__dirname, '../..')
    const a = readFileSync(path.join(root, 'src/lib/outreach-tabs.ts'), 'utf8')
    const b = readFileSync(path.join(root, 'server/outreach-tabs.ts'), 'utf8')
    expect(a).toBe(b)
    expect(client.OUTREACH_TAB_IDS).toEqual(server.OUTREACH_TAB_IDS)
  })

  it('has every tab the requirements name, plus All Pages', () => {
    const labels = OUTREACH_TABS.map(t => t.label)
    for (const name of [...PDF_TABS, 'All Pages']) expect(labels, name).toContain(name)
  })

  it('has unique ids and paths', () => {
    expect(new Set(OUTREACH_TABS.map(t => t.id)).size).toBe(OUTREACH_TABS.length)
    expect(new Set(OUTREACH_TABS.map(t => t.path)).size).toBe(OUTREACH_TABS.length)
  })

  it('finds the tab a detail page belongs to', () => {
    expect(outreachTabForPath('/outreach/pages/abc')?.id).toBe('pages')
    expect(outreachTabForPath('/outreach/video/queue')?.id).toBe('queue')
    expect(outreachTabForPath('/outreach/states')?.id).toBe('states')
  })
})

describe('cleanTabLevels — what a saved grid can hold', () => {
  it('drops unknown tabs and unknown levels', () => {
    expect(cleanTabLevels({ nope: 'edit', pages: 'admin', analytics: 'view' }, 'outreach_editor'))
      .toEqual({ analytics: 'view' })
  })

  it('turns Edit into View on a tab with nothing to edit', () => {
    expect(cleanTabLevels({ analytics: 'edit', pages: 'edit' }, 'outreach_editor'))
      .toEqual({ analytics: 'view', pages: 'edit' })
  })

  it('gives a State User no video workflow tab', () => {
    expect(cleanTabLevels({ queue: 'edit', my_videos: 'view', pages: 'edit' }, 'outreach_state_user'))
      .toEqual({ pages: 'edit' })
  })
})

describe('defaultTabLevels — the grid before anyone saves it', () => {
  it('is what each role had: a publisher keeps the queue at Edit', () => {
    const d = defaultTabLevels('outreach_publisher')
    expect(d.queue).toBe('edit')
    expect(d.my_videos).toBeUndefined()
    expect(d.pages).toBeUndefined()
  })

  it('reads an old single-tab grant as View', () => {
    expect(defaultTabLevels('outreach_editor', ['outreach:review']).review).toBe('view')
  })

  it('gives a State User nothing until chosen', () => {
    expect(defaultTabLevels('outreach_state_user')).toEqual({})
  })
})

describe('canUseTab — Off / View / Edit', () => {
  const access = (tabs: OutreachAccess['tabs']): OutreachAccess =>
    ({ admin: false, configured: true, tabs, scope: { kind: 'states', states: ['Gujarat'] } })

  it('Edit includes View; View is not Edit; Off is neither', () => {
    const a = access({ pages: 'edit', analytics: 'view' })
    expect(canUseTab(a, 'pages', 'edit')).toBe(true)
    expect(canUseTab(a, 'pages')).toBe(true)
    expect(canUseTab(a, 'analytics')).toBe(true)
    expect(canUseTab(a, 'analytics', 'edit')).toBe(false)
    expect(canUseTab(a, 'campaigns')).toBe(false)
    expect(levelAtLeast(undefined, 'view')).toBe(false)
  })

  it('an admin reaches every tab; nobody without access reaches any', () => {
    const admin: OutreachAccess = { admin: true, configured: false, tabs: {}, scope: { kind: 'all' } }
    for (const t of OUTREACH_TABS) expect(canUseTab(admin, t.id, 'edit')).toBe(true)
    expect(canUseTab(null, 'pages')).toBe(false)
  })

  it('sends someone to the first tab they have, in sidebar order', () => {
    expect(firstOpenTab(access({ creators: 'view', analytics: 'view' }))).toBe('/outreach/analytics')
    expect(firstOpenTab(access({}))).toBeNull()
  })

  it('treats only the super admin and outreach manager as admins', () => {
    expect(isOutreachAdminRole('super_admin')).toBe(true)
    expect(isOutreachAdminRole('outreach_manager')).toBe(true)
    for (const r of ['admin', 'outreach_editor', 'outreach_publisher', 'outreach_state_user', null]) {
      expect(isOutreachAdminRole(r)).toBe(false)
    }
  })
})
