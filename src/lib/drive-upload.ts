/**
 * Sends a file from the browser straight into Google Drive.
 *
 * The server opens a Drive "resumable upload" session for the file and hands
 * back its URL; from there the bytes go browser → Google and never touch
 * Nerve. That is the whole point: a 2 GB video does not have to fit through
 * nginx's body limit, sit on Nerve's disk, or be paid for twice in bandwidth.
 *
 * The protocol (https://developers.google.com/drive/api/guides/manage-uploads#resumable):
 *   - PUT a chunk with `Content-Range: bytes first-last/total`;
 *   - 308 means "got it, send more", with a `Range: bytes=0-n` header saying
 *     how much Google really has;
 *   - 200/201 on the last chunk carries the new file's JSON;
 *   - an empty PUT with `Content-Range: bytes *\/total` asks where things
 *     stand. One is sent first, before any data, to learn whether this
 *     browser can reach Google at all; after a dropped connection, another
 *     says where to carry on from.
 *
 * XMLHttpRequest rather than fetch, because only XHR reports upload progress.
 */

/** The upload could not reach Google at all, which is what a CSP or CORS block looks like. */
export class DirectUploadBlockedError extends Error {
  constructor() {
    super('This browser could not send the file to Google Drive directly.')
    this.name = 'DirectUploadBlockedError'
  }
}

export interface DriveUploadOptions {
  file: Blob
  uploadUrl: string
  chunkBytes: number
  onProgress?: (sent: number, total: number) => void
  signal?: AbortSignal
}

/** Google requires every chunk but the last to be a multiple of 256 KiB. */
const CHUNK_UNIT = 256 * 1024
/** How many times in a row a failed chunk is retried before giving up. */
const MAX_ATTEMPTS = 5

interface PutResult { status: number; range: string | null; text: string }

/** Uploads `file` and returns the id of the Drive file it became. */
export async function uploadToDrive({ file, uploadUrl, chunkBytes, onProgress, signal }: DriveUploadOptions): Promise<string> {
  const total = file.size
  /* Guard the server's number rather than trust it: a chunk size Google
     refuses would fail on the second chunk, a long way into the upload. */
  const chunk = Math.max(CHUNK_UNIT, Math.floor(chunkBytes / CHUNK_UNIT) * CHUNK_UNIT)

  /* First, an empty status query. Nothing about it can be a flaky chunk, so
     "no answer at all" here is the browser refusing to talk to Google — a
     Content-Security-Policy without googleapis.com, or a CORS refusal — and
     the caller falls back to uploading through Nerve. Any status 0 after this
     probe has succeeded is a dropped connection, and is resumed. */
  const probe = await put(uploadUrl, null, `bytes */${total}`, signal)
  if (probe.status === 0) throw new DirectUploadBlockedError()
  let start: { offset: number } | { fileId: string }
  if (probe.status === 200 || probe.status === 201) start = { fileId: fileIdFrom(probe) }
  /* For a status query, no Range header means Google has nothing yet. */
  else if (probe.status === 308) start = { offset: storedUpTo(probe.range) ?? 0 }
  else if (retryable(probe.status)) start = await recover(uploadUrl, total, signal, 1)
  else throw new Error(describe(probe))
  if ('fileId' in start) {
    onProgress?.(total, total)
    return start.fileId
  }
  let offset = start.offset
  onProgress?.(offset, total)

  /* Failed chunks in a row. Only real progress — Google holding bytes beyond
     where the failed chunk started — clears it, so a session that keeps
     taking the status query but dropping every chunk cannot loop forever. */
  let failures = 0
  let failedFrom = -1
  const advanced = () => {
    if (failures > 0 && offset > failedFrom) { failures = 0; failedFrom = -1 }
  }

  while (true) {
    const end = Math.min(offset + chunk, total)
    const base = offset
    const res = await put(uploadUrl, file.slice(base, end), `bytes ${base}-${end - 1}/${total}`, signal,
      loaded => onProgress?.(Math.min(base + loaded, total), total))

    if (res.status === 200 || res.status === 201) {
      onProgress?.(total, total)
      return fileIdFrom(res)
    }
    if (res.status === 308) {
      /* The Range header is only readable when Google exposes it to this
         origin. Without it, a 308 for a chunk still means the chunk arrived. */
      offset = storedUpTo(res.range) ?? end
      advanced()
      onProgress?.(offset, total)
      continue
    }
    if (!retryable(res.status)) throw new Error(describe(res))

    failures++
    failedFrom = Math.max(failedFrom, base)
    if (failures >= MAX_ATTEMPTS) throw stopped(failureLabel(res.status))

    const state = await recover(uploadUrl, total, signal, failures)
    if ('fileId' in state) {
      onProgress?.(total, total)
      return state.fileId
    }
    offset = state.offset
    advanced()
    onProgress?.(offset, total)
  }
}

/**
 * After a failed request: wait, ask Google how much it has, and say where to
 * carry on from. Gives up after MAX_ATTEMPTS failed status queries in a row.
 * `failuresSoFar` lengthens the first wait when chunks keep failing.
 */
async function recover(
  uploadUrl: string, total: number, signal: AbortSignal | undefined, failuresSoFar: number,
): Promise<{ offset: number } | { fileId: string }> {
  let last = ''
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    await wait(backoff(failuresSoFar + attempt - 1), signal)
    const res = await put(uploadUrl, null, `bytes */${total}`, signal)
    if (res.status === 200 || res.status === 201) return { fileId: fileIdFrom(res) }
    /* For a status query, no Range header means Google has nothing yet. */
    if (res.status === 308) return { offset: storedUpTo(res.range) ?? 0 }
    if (res.status === 404 || res.status === 410) {
      throw new Error('The Google Drive upload session expired. Please start the upload again.')
    }
    if (!retryable(res.status)) throw new Error(describe(res))
    last = failureLabel(res.status)
  }
  throw stopped(last)
}

function stopped(last: string): Error {
  return new Error(`Google Drive stopped accepting the upload (${last}) after ${MAX_ATTEMPTS} attempts. Check your connection and try again.`)
}

function failureLabel(status: number): string {
  return status === 0 ? 'no connection' : `error ${status}`
}

/** One PUT. Resolves for every answer including "no answer" (status 0); rejects only when aborted. */
function put(
  url: string, body: Blob | null, contentRange: string, signal?: AbortSignal,
  onUploaded?: (loaded: number) => void,
): Promise<PutResult> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError())
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', url)
    /* The session URL is the credential. Sending Nerve's cookies to Google
       would be pointless, and would make the CORS check stricter. */
    xhr.withCredentials = false
    xhr.setRequestHeader('Content-Range', contentRange)
    if (onUploaded) xhr.upload.onprogress = e => onUploaded(e.loaded)
    const onAbort = () => xhr.abort()
    signal?.addEventListener('abort', onAbort, { once: true })
    const done = () => signal?.removeEventListener('abort', onAbort)
    xhr.onabort = () => { done(); reject(abortError()) }
    xhr.onerror = () => { done(); resolve({ status: 0, range: null, text: '' }) }
    xhr.ontimeout = xhr.onerror
    xhr.onload = () => {
      done()
      let range: string | null = null
      try { range = xhr.getResponseHeader('Range') } catch { /* not exposed to this origin */ }
      resolve({ status: xhr.status, range, text: xhr.responseText })
    }
    xhr.send(body)
  })
}

/** `bytes=0-1048575` → 1048576, the offset to send next. */
function storedUpTo(range: string | null): number | null {
  const m = range?.match(/bytes=\d+-(\d+)/)
  return m ? Number(m[1]) + 1 : null
}

function fileIdFrom(res: PutResult): string {
  try {
    const parsed = JSON.parse(res.text) as { id?: unknown }
    if (typeof parsed.id === 'string' && parsed.id) return parsed.id
  } catch { /* fall through */ }
  throw new Error('Google Drive accepted the file but did not say what it was called. Please try again.')
}

/* A dropped connection, rate limiting and Google's own 5xx are worth waiting
   out; a 4xx is the request itself and will not get better by repeating it. */
function retryable(status: number): boolean {
  return status === 0 || status === 429 || status >= 500
}

function describe(res: PutResult): string {
  let reason = ''
  try {
    const parsed = JSON.parse(res.text) as { error?: { message?: string } }
    reason = parsed.error?.message ?? ''
  } catch { /* not JSON */ }
  if (res.status === 401 || res.status === 403) {
    return `Google Drive refused the upload${reason ? ` (${reason})` : ''}. Please try again; if it keeps happening, the Drive connection may need reconnecting.`
  }
  if (res.status === 404 || res.status === 410) {
    return 'The Google Drive upload session expired. Please start the upload again.'
  }
  return `Google Drive rejected the upload (error ${res.status}${reason ? `: ${reason}` : ''}).`
}

/** 1s, 2s, 4s, 8s, 16s (and 16s from then on) — with a little jitter so retries do not land in step. */
function backoff(attempt: number): number {
  return 1000 * 2 ** (Math.min(Math.max(attempt, 1), 5) - 1) + Math.floor(Math.random() * 500)
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError())
    const timer = window.setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve() }, ms)
    const onAbort = () => { window.clearTimeout(timer); reject(abortError()) }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function abortError(): DOMException {
  return new DOMException('Upload cancelled.', 'AbortError')
}
