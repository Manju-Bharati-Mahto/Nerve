/* ═══════════════════════════════════════════════════════════════════════════
   The outreach administrator's ceiling, and the role mapping underneath it.

   Two properties, both of which fail silently when broken.

   THE CEILING. A Manager administers the outreach team but cannot mint an
   Admin. The rule is enforced on the server in two places; this file covers
   the third statement of it — the one the dialog reads to decide what to
   offer. A UI that offers a choice the API refuses is a worse bug than one
   that offers nothing, because the person only finds out after filling the
   form in.

   THE MAPPING. A workflow role is derived from the Nerve role at request
   time, so creating an account means choosing the Nerve role that will come
   back out as the workflow role the administrator picked. The mapping here
   must therefore be the exact inverse of videoRoleForNerveRole() on the
   server. Get it wrong and the account is created successfully and signs in
   as the wrong role — or, for an unmapped role, as nobody at all. The last
   test reads the server's own function and checks the two agree, rather than
   trusting that a comment stayed true.
   ═══════════════════════════════════════════════════════════════════════════ */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  ALL_VIDEO_ROLES, MANAGER_GRANTABLE_ROLES, NERVE_ROLE_FOR_VIDEO_ROLE, PUBLISH_ROLES, UPLOAD_ROLES,
  grantableVideoRoles, mayAssignVideoRole, mayPublishVideos, mayUploadVideos, videoRoleOf,
} from './workflow-roles'

describe("what an outreach manager may hand out", () => {
  it("offers Editor, Publisher and Manager — and not Admin", () => {
    const roles = grantableVideoRoles('outreach_manager')
    expect([...roles].sort()).toEqual(['editor', 'manager', 'publisher'])
    expect(roles).not.toContain('admin')
  })

  it("refuses to assign Admin, whatever route the question arrives by", () => {
    expect(mayAssignVideoRole('outreach_manager', 'admin')).toBe(false)
    for (const r of MANAGER_GRANTABLE_ROLES) {
      expect(mayAssignVideoRole('outreach_manager', r)).toBe(true)
    }
  })

  it("lets an admin and a super admin assign every role", () => {
    for (const actor of ['admin', 'super_admin'] as const) {
      expect([...grantableVideoRoles(actor)].sort()).toEqual([...ALL_VIDEO_ROLES].sort())
      expect(mayAssignVideoRole(actor, 'admin')).toBe(true)
    }
  })
})

describe("the workflow role a new account will actually sign in as", () => {
  it("maps every workflow role to a Nerve role", () => {
    for (const role of ALL_VIDEO_ROLES) {
      expect(NERVE_ROLE_FOR_VIDEO_ROLE[role], `no Nerve role for ${role}`).toBeTruthy()
    }
  })

  it("gives each workflow role a distinct Nerve role", () => {
    const mapped = ALL_VIDEO_ROLES.map(r => NERVE_ROLE_FOR_VIDEO_ROLE[r])
    expect(new Set(mapped).size).toBe(mapped.length)
  })

  it("is the exact inverse of the server's videoRoleForNerveRole()", () => {
    /* Read the server's mapping rather than restating it: a copy would agree
       with itself forever and prove nothing. */
    const src = readFileSync('server/outreach-video/users.ts', 'utf8')
    const body = src.slice(src.indexOf('export function videoRoleForNerveRole'))
      .slice(0, src.slice(src.indexOf('export function videoRoleForNerveRole')).indexOf('\n}'))

    const serverMap = new Map<string, string>()
    for (const m of body.matchAll(/role === "([a-z_]+)"\s*(?:\|\|\s*role === "([a-z_]+)"\s*)?\)\s*return "([a-z]+)"/g)) {
      serverMap.set(m[1], m[3])
      if (m[2]) serverMap.set(m[2], m[3])
    }
    expect(serverMap.size, 'parsed no mapping out of the server function').toBeGreaterThan(0)

    for (const videoRole of ALL_VIDEO_ROLES) {
      const nerveRole = NERVE_ROLE_FOR_VIDEO_ROLE[videoRole]
      expect(serverMap.get(nerveRole), `the server does not read ${nerveRole} as ${videoRole}`)
        .toBe(videoRole)
    }
  })

  it("never maps a role the server would reject outright", () => {
    const src = readFileSync('server/outreach-video/users.ts', 'utf8')
    for (const videoRole of ALL_VIDEO_ROLES) {
      expect(src).toContain(`"${NERVE_ROLE_FOR_VIDEO_ROLE[videoRole]}"`)
    }
  })
})

/* ═══════════════════════════════════════════════════════════════════════════
   The buttons a screen offers, against the roles the API accepts.

   The publishing queue offered a Manager Schedule and Mark as published, and
   My Videos offered a Manager the upload form, and every one of them ended in
   "Your role cannot perform that action." The screens now hide what the
   viewer cannot do — which is only right while their lists are the API's.
   So these read requireRole straight out of routes.ts for each endpoint.
   ═══════════════════════════════════════════════════════════════════════════ */
const ROUTES = readFileSync('server/outreach-video/routes.ts', 'utf8')

/** The roles requireRole admits on `METHOD path`, read from the handler. */
function rolesFor(method: string, path: string): string[] {
  const at = ROUTES.indexOf(`app.${method}(\`\${P}${path}\``)
  expect(at, `no ${method.toUpperCase()} ${path} in routes.ts`).toBeGreaterThan(-1)
  const m = /requireRole\(res, user, \[([^\]]*)\]\)/.exec(ROUTES.slice(at, at + 800))
  expect(m, `no requireRole in ${method.toUpperCase()} ${path}`).toBeTruthy()
  return [...m![1].matchAll(/"([a-z]+)"/g)].map(x => x[1]).sort()
}

describe('who the UI lets act on a video', () => {
  it('offers upload, caption, submit and revise to exactly the roles the API accepts', () => {
    for (const [method, path] of [
      ['post', '/videos'], ['post', '/videos/upload-session'], ['patch', '/videos/:id/caption'],
      ['post', '/videos/:id/submit'], ['post', '/videos/:id/revise'],
    ]) {
      expect(rolesFor(method, path), `${method} ${path}`).toEqual([...UPLOAD_ROLES].sort())
    }
  })

  it('offers schedule, publish and live links to exactly the roles the API accepts', () => {
    for (const [method, path] of [
      ['post', '/videos/:id/schedule'], ['post', '/videos/:id/publish'], ['patch', '/videos/:id/live-urls'],
    ]) {
      expect(rolesFor(method, path), `${method} ${path}`).toEqual([...PUBLISH_ROLES].sort())
    }
  })

  it('reads every Nerve role as the server does', () => {
    for (const videoRole of ALL_VIDEO_ROLES) {
      expect(videoRoleOf(NERVE_ROLE_FOR_VIDEO_ROLE[videoRole])).toBe(videoRole)
    }
    expect(videoRoleOf('super_admin')).toBe('admin')
    expect(videoRoleOf('user')).toBeNull()
    expect(videoRoleOf(null)).toBeNull()
  })

  it('keeps a Manager off uploading and publishing, and an Admin on both', () => {
    expect(mayUploadVideos('outreach_manager')).toBe(false)
    expect(mayPublishVideos('outreach_manager')).toBe(false)
    expect(mayUploadVideos('outreach_editor')).toBe(true)
    expect(mayPublishVideos('outreach_editor')).toBe(false)
    expect(mayPublishVideos('outreach_publisher')).toBe(true)
    expect(mayUploadVideos('outreach_publisher')).toBe(false)
    for (const r of ['admin', 'super_admin'] as const) {
      expect(mayUploadVideos(r)).toBe(true)
      expect(mayPublishVideos(r)).toBe(true)
    }
  })
})
