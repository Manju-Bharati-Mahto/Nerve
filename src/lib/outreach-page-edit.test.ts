import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import * as client from './outreach-page-edit'
import * as server from '../../server/outreach-page-edit'

// PRD 6.5 — the Edit page dialog checks a name and a link by the server's own rule.

describe('the two copies', () => {
  it('are byte-for-byte the same file', () => {
    const root = path.resolve(__dirname, '../..')
    const a = readFileSync(path.join(root, 'src/lib/outreach-page-edit.ts'), 'utf8')
    const b = readFileSync(path.join(root, 'server/outreach-page-edit.ts'), 'utf8')
    expect(a).toBe(b)
  })

  it('give the same answers', () => {
    for (const platform of ['instagram', 'facebook'] as const) {
      for (const v of ['name', '@Name', 'two words', 'https://www.instagram.com/x/', 'https://www.facebook.com/x', 'instagram.com/p/abc', '', 'ftp://instagram.com/x']) {
        expect(client.normalisePageHandle(platform, v), `${platform} ${v}`).toEqual(server.normalisePageHandle(platform, v))
        expect(client.normalisePageLink(platform, v), `${platform} ${v}`).toEqual(server.normalisePageLink(platform, v))
      }
    }
  })
})
