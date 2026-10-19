/* ═══════════════════════════════════════════════════════════════════════════
   A video-workflow sidebar link must open for the role whose sidebar it is in.

   The publisher's sidebar listed "Social Media Pages", the API served the
   publisher that list, and the route guard in App.tsx left the publisher out
   — so the link quietly bounced back to the Publishing Queue. Nothing looked
   broken except the destination. This reads both files and checks every
   /outreach/video link in each outreach role's sidebar against the `allowed`
   list of the route it points at.
   ═══════════════════════════════════════════════════════════════════════════ */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const SIDEBAR = readFileSync('src/components/AppSidebar.tsx', 'utf8')
const APP = readFileSync('src/App.tsx', 'utf8')

/** The /outreach/video paths listed in one role's sidebar config. */
function sidebarPaths(key: string): string[] {
  const at = SIDEBAR.indexOf(`'${key}': cfg(`)
  expect(at, `no sidebar for ${key}`).toBeGreaterThan(-1)
  const next = SIDEBAR.indexOf(': cfg(', at + key.length + 10)
  const block = SIDEBAR.slice(at, next === -1 ? undefined : next)
  return [...block.matchAll(/path: '(\/outreach\/video\/[^']+)'/g)].map(m => m[1])
}

/** The roles the route for `path` admits by role. */
function allowedFor(path: string): string[] {
  const at = APP.indexOf(`<Route path="${path}"`)
  expect(at, `no route for ${path}`).toBeGreaterThan(-1)
  const m = /allowed=\{\[([^\]]*)\]\}/.exec(APP.slice(at, at + 400))
  expect(m, `no allowed list on ${path}`).toBeTruthy()
  return [...m![1].matchAll(/'([a-z_]+)'/g)].map(x => x[1])
}

describe('the video workflow sidebar against its route guards', () => {
  for (const role of ['admin', 'outreach_manager', 'outreach_editor', 'outreach_publisher']) {
    it(`opens every link in the ${role} sidebar`, () => {
      const paths = sidebarPaths(`${role}:outreach`)
      expect(paths.length).toBeGreaterThan(0)
      for (const path of paths) {
        expect(allowedFor(path), `${role} is offered ${path} but its route refuses them`).toContain(role)
      }
    })
  }
})
