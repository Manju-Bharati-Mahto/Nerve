/**
 * What to tell someone when a request fails, whatever answered it.
 *
 * The API always answers an error with JSON `{ message }`, and that message is
 * shown as-is. But not every response comes from the API: nginx answers a body
 * over its limit with an HTML 413 page, and a restarting or slow API with an
 * HTML 502/504. Parsing those as JSON yields nothing, which is how a too-large
 * photo used to surface as a bare "Request failed." — this turns the status
 * into something a person can act on instead.
 */

/** A request that failed, carrying the HTTP status so a page can tell a 503 from a 400. */
export class HttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = 'HttpError'
  }
}

/** The message for a status the API itself did not explain. */
export function statusMessage(status: number, fallback: string): string {
  if (status === 413) return 'That file is larger than the server accepts. Choose a smaller file, or fewer files at once.'
  if (status === 401) return 'Your session has expired. Please sign in again.'
  if (status === 502 || status === 503) return 'Nerve is restarting or unreachable. Please try again in a minute.'
  if (status === 504) return 'The server took too long to respond. Please try again; on a slow connection, try a smaller file.'
  return `${fallback} (error ${status})`
}

/** Shown when the request never got an answer at all (offline, connection dropped). */
export const NETWORK_ERROR_MESSAGE = 'Could not reach Nerve. Check your connection and try again.'

/**
 * Reads a response body as JSON when it is JSON, and nothing otherwise — the
 * HTML error pages nginx sends must not throw a parse error of their own.
 */
export async function readJson(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text().catch(() => '')
  if (!text) return {}
  try {
    const parsed: unknown = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

/** The error to throw for a non-OK response: the API's own message if it sent one. */
export function errorFor(res: Response, payload: Record<string, unknown>, fallback: string): HttpError {
  const message = typeof payload.message === 'string' && payload.message.trim()
    ? payload.message
    : statusMessage(res.status, fallback)
  return new HttpError(message, res.status)
}

/** `fetch`, but a dropped connection becomes a readable message instead of "Failed to fetch". */
export async function fetchOrExplain(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(input, init)
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err
    throw new HttpError(NETWORK_ERROR_MESSAGE, 0)
  }
}
