import { fetchOrExplain, readJson, HttpError, statusMessage } from './http'

/**
 * Client for the Parul RAG service (FastAPI, port 8002).
 *
 * In production, nginx proxies `/api/rag/` → 127.0.0.1:8002, so these calls are
 * same-origin and the Nerve session cookie rides along automatically. In local
 * dev there is usually no RAG running, so calls fail cleanly and the Ask AI page
 * falls back to local keyword search.
 *
 * Auth is JWT bearer. The browser already holds the Nerve session cookie, so
 * GET /session-token exchanges it for a short-lived RAG token (8h), which we
 * cache in memory and refresh once on a 401.
 */
export const RAG_BASE_URL = (import.meta.env.VITE_RAG_BASE_URL || '/api/rag').replace(/\/$/, '')

export interface RagSource {
  source?: string
  page?: number
  [key: string]: unknown
}

export interface RagAnswer {
  answer: string
  sources: RagSource[]
  question: string
}

/** The RAG (FastAPI) reports errors as `{ detail }`, unlike the Node API's `{ message }`. */
function ragError(res: Response, payload: Record<string, unknown>, fallback: string): HttpError {
  const detail =
    typeof payload.detail === 'string' && payload.detail.trim()
      ? payload.detail
      : statusMessage(res.status, fallback)
  return new HttpError(detail, res.status)
}

/** True when the RAG service answers its health check. Never throws. */
export async function ragHealth(): Promise<boolean> {
  try {
    const res = await fetchOrExplain(`${RAG_BASE_URL}/health`, { credentials: 'include' })
    if (!res.ok) return false
    const body = await readJson(res)
    return body.status === 'ok'
  } catch {
    return false
  }
}

let cachedToken: string | null = null

async function fetchSessionToken(): Promise<string> {
  const res = await fetchOrExplain(`${RAG_BASE_URL}/session-token`, { credentials: 'include' })
  const payload = await readJson(res)
  if (!res.ok) throw ragError(res, payload, 'Could not authorize the AI assistant.')
  const token = typeof payload.access_token === 'string' ? payload.access_token : ''
  if (!token) throw new HttpError('The AI assistant did not return a session token.', res.status)
  cachedToken = token
  return token
}

async function getToken(forceRefresh = false): Promise<string> {
  if (!forceRefresh && cachedToken) return cachedToken
  return fetchSessionToken()
}

/** Drop the cached RAG token — call on logout so the next user re-authorizes. */
export function resetRagToken(): void {
  cachedToken = null
}

/**
 * Ask the knowledge base a question. Retries once with a fresh token if the
 * cached one has expired (401).
 */
export async function askSession(question: string, sessionId = 'default'): Promise<RagAnswer> {
  const ask = (token: string): Promise<Response> =>
    fetchOrExplain(`${RAG_BASE_URL}/ask-session`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ question, session_id: sessionId }),
    })

  let res = await ask(await getToken())
  if (res.status === 401) {
    cachedToken = null
    res = await ask(await getToken(true))
  }

  const payload = await readJson(res)
  if (!res.ok) throw ragError(res, payload, 'The AI assistant could not answer that.')

  return {
    answer: typeof payload.answer === 'string' ? payload.answer : '',
    sources: Array.isArray(payload.sources) ? (payload.sources as RagSource[]) : [],
    question: typeof payload.question === 'string' ? payload.question : question,
  }
}
