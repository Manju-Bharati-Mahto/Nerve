import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DirectUploadBlockedError, uploadToDrive } from './drive-upload'

/**
 * A stand-in for Google's resumable upload endpoint, behind a fake
 * XMLHttpRequest. Each PUT is handed to `answer`, which says what Google
 * would have said: a status, an optional Range header and a body — or
 * status 0 for "no answer at all".
 */
interface Put { contentRange: string; size: number | null }
type Answer = { status: number; range?: string | null; body?: string }
let puts: Put[] = []
let answer: (put: Put, index: number) => Answer

class FakeXhr {
  status = 0
  responseText = ''
  withCredentials = true
  upload: { onprogress: ((e: { loaded: number }) => void) | null } = { onprogress: null }
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  onabort: (() => void) | null = null
  ontimeout: (() => void) | null = null
  private headers: Record<string, string> = {}
  private range: string | null = null
  open() { /* the URL is not interesting here */ }
  setRequestHeader(name: string, value: string) { this.headers[name] = value }
  getResponseHeader(name: string) { return name === 'Range' ? this.range : null }
  abort() { this.onabort?.() }
  send(body: Blob | null) {
    const put = { contentRange: this.headers['Content-Range'], size: body ? body.size : null }
    const res = answer(put, puts.length)
    puts.push(put)
    queueMicrotask(() => {
      if (res.status === 0) return this.onerror?.()
      if (body) this.upload.onprogress?.({ loaded: body.size })
      this.status = res.status
      this.range = res.range ?? null
      this.responseText = res.body ?? ''
      this.onload?.()
    })
  }
}

const KIB256 = 256 * 1024
const fileOf = (bytes: number) => new Blob([new Uint8Array(bytes)])

beforeEach(() => {
  puts = []
  vi.stubGlobal('XMLHttpRequest', FakeXhr)
})
afterEach(() => { vi.unstubAllGlobals() })

/** The empty status query: Google's "where are we?" */
const isProbe = (put: Put) => put.size === null && put.contentRange.startsWith('bytes */')
/** A fresh session: Google has nothing yet, so a 308 with no Range header. */
const FRESH: Answer = { status: 308 }

describe('uploadToDrive', () => {
  it('asks where the session stands, then sends the file in chunks and returns the Drive file id', async () => {
    const total = KIB256 * 2 + 100
    answer = (put) => {
      if (isProbe(put)) return FRESH
      const last = Number(put.contentRange.match(/-(\d+)\//)?.[1])
      return last === total - 1
        ? { status: 200, body: JSON.stringify({ id: 'drive-file-1' }) }
        : { status: 308, range: `bytes=0-${last}` }
    }
    const progress: number[] = []
    const id = await uploadToDrive({
      file: fileOf(total), uploadUrl: 'https://upload', chunkBytes: KIB256,
      onProgress: sent => progress.push(sent),
    })
    expect(id).toBe('drive-file-1')
    expect(puts.map(p => p.contentRange)).toEqual([
      `bytes */${total}`,
      `bytes 0-${KIB256 - 1}/${total}`,
      `bytes ${KIB256}-${KIB256 * 2 - 1}/${total}`,
      `bytes ${KIB256 * 2}-${total - 1}/${total}`,
    ])
    expect(puts[0].size).toBeNull()
    expect(progress.at(-1)).toBe(total)
  })

  it('carries on from what Google says it has, not from what was sent', async () => {
    const total = KIB256 * 2
    answer = (put, i) => isProbe(put) ? FRESH : i === 1
      ? { status: 308, range: `bytes=0-${KIB256 - 11}` } // 10 bytes short
      : { status: 201, body: JSON.stringify({ id: 'f' }) }
    await uploadToDrive({ file: fileOf(total), uploadUrl: 'u', chunkBytes: KIB256 })
    expect(puts[2].contentRange).toBe(`bytes ${KIB256 - 10}-${KIB256 * 2 - 11}/${total}`)
  })

  it('starts from where the probe says Google already is', async () => {
    const total = KIB256 * 2
    answer = (put) => isProbe(put)
      ? { status: 308, range: `bytes=0-${KIB256 - 1}` }
      : { status: 200, body: '{"id":"f"}' }
    await uploadToDrive({ file: fileOf(total), uploadUrl: 'u', chunkBytes: KIB256 })
    expect(puts[1].contentRange).toBe(`bytes ${KIB256}-${total - 1}/${total}`)
  })

  it('returns straight away when the probe finds the upload already complete', async () => {
    answer = () => ({ status: 200, body: '{"id":"already"}' })
    const progress: number[] = []
    const id = await uploadToDrive({
      file: fileOf(10), uploadUrl: 'u', chunkBytes: KIB256, onProgress: sent => progress.push(sent),
    })
    expect(id).toBe('already')
    expect(puts).toHaveLength(1)
    expect(progress).toEqual([10])
  })

  it('assumes a chunk arrived when the Range header is not readable', async () => {
    const total = KIB256 * 2
    answer = (put, i) => isProbe(put) ? FRESH
      : i === 1 ? { status: 308, range: null } : { status: 200, body: '{"id":"f"}' }
    await uploadToDrive({ file: fileOf(total), uploadUrl: 'u', chunkBytes: KIB256 })
    expect(puts[2].contentRange).toBe(`bytes ${KIB256}-${total - 1}/${total}`)
  })

  it('reports a browser that cannot reach Google at all as blocked, from the probe alone', async () => {
    answer = () => ({ status: 0 })
    await expect(uploadToDrive({ file: fileOf(10), uploadUrl: 'u', chunkBytes: KIB256 }))
      .rejects.toBeInstanceOf(DirectUploadBlockedError)
    expect(puts).toEqual([{ contentRange: 'bytes */10', size: null }])
  })

  it('treats a dropped first chunk after a good probe as a dropped connection, not a block', async () => {
    const total = KIB256
    answer = (put, i) => {
      if (isProbe(put)) return FRESH
      if (i === 1) return { status: 0 }
      return { status: 200, body: '{"id":"resumed"}' }
    }
    const id = await uploadToDrive({ file: fileOf(total), uploadUrl: 'u', chunkBytes: KIB256 })
    expect(id).toBe('resumed')
    expect(puts.map(p => p.contentRange)).toEqual([
      `bytes */${total}`, `bytes 0-${total - 1}/${total}`, `bytes */${total}`, `bytes 0-${total - 1}/${total}`,
    ])
  }, 10_000)

  it('after a dropped chunk, asks Google where it got to and resumes from there', async () => {
    const total = KIB256 * 2
    answer = (put, i) => {
      if (i === 0) return FRESH
      if (i === 1) return { status: 308, range: `bytes=0-${KIB256 - 1}` }
      if (i === 2) return { status: 0 } // the connection drops mid-upload
      if (isProbe(put)) return { status: 308, range: `bytes=0-${KIB256 - 1}` }
      return { status: 200, body: '{"id":"resumed"}' }
    }
    const id = await uploadToDrive({ file: fileOf(total), uploadUrl: 'u', chunkBytes: KIB256 })
    expect(id).toBe('resumed')
    expect(puts[3]).toEqual({ contentRange: `bytes */${total}`, size: null })
    expect(puts[4].contentRange).toBe(`bytes ${KIB256}-${total - 1}/${total}`)
  }, 10_000)

  describe('with retries', () => {
    beforeEach(() => { vi.useFakeTimers() })
    afterEach(() => { vi.useRealTimers() })

    it('gives up when every chunk fails though every status query answers', async () => {
      const total = KIB256 * 2
      let data = 0
      answer = (put) => isProbe(put) ? FRESH : { status: data++ % 2 ? 503 : 0 }
      const result = uploadToDrive({ file: fileOf(total), uploadUrl: 'u', chunkBytes: KIB256 })
      const settled = expect(result).rejects.toThrow(/stopped accepting the upload \((no connection|error 503)\) after 5 attempts/)
      await vi.runAllTimersAsync()
      await settled
      expect(puts.filter(p => !isProbe(p))).toHaveLength(5)
    })

    it('keeps going while each failure is followed by real progress', async () => {
      const chunks = 8
      const total = KIB256 * chunks
      const failedOnce = new Set<string>()
      let stored = -1 // last byte Google has
      answer = (put) => {
        if (isProbe(put)) return stored < 0 ? FRESH : { status: 308, range: `bytes=0-${stored}` }
        if (!failedOnce.has(put.contentRange)) { failedOnce.add(put.contentRange); return { status: 0 } }
        stored = Number(put.contentRange.match(/-(\d+)\//)?.[1])
        return stored === total - 1 ? { status: 200, body: '{"id":"patient"}' } : { status: 308, range: `bytes=0-${stored}` }
      }
      const result = uploadToDrive({ file: fileOf(total), uploadUrl: 'u', chunkBytes: KIB256 })
      const settled = expect(result).resolves.toBe('patient')
      await vi.runAllTimersAsync()
      await settled
      expect(failedOnce.size).toBe(chunks) // eight failures in all, never two in a row
    })
  })

  it('does not retry a request Google refused outright', async () => {
    answer = (put, i) => isProbe(put) ? FRESH : i === 1
      ? { status: 308, range: `bytes=0-${KIB256 - 1}` }
      : { status: 400, body: JSON.stringify({ error: { message: 'Bad range' } }) }
    await expect(uploadToDrive({ file: fileOf(KIB256 * 2), uploadUrl: 'u', chunkBytes: KIB256 }))
      .rejects.toThrow(/Bad range/)
    expect(puts).toHaveLength(3)
  })

  it('reports an expired session found by the probe', async () => {
    answer = () => ({ status: 404 })
    await expect(uploadToDrive({ file: fileOf(10), uploadUrl: 'u', chunkBytes: KIB256 }))
      .rejects.toThrow(/session expired/)
  })

  it('stops when cancelled', async () => {
    const controller = new AbortController()
    answer = () => { controller.abort(); return { status: 308 } }
    await expect(uploadToDrive({
      file: fileOf(KIB256 * 2), uploadUrl: 'u', chunkBytes: KIB256, signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' })
  })
})
