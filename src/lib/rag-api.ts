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

export interface RagSession {
  id: string
  title: string
  createdAt?: string
}

export interface RagMessage {
  role: 'user' | 'assistant'
  content: string
  sources?: RagSource[]
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
}

/** Tolerant to id/session_id, title, created_at naming across the API. */
function toSession(v: unknown): RagSession {
  const o = asRecord(v)
  const id = o.id ?? o.session_id ?? o.sessionId
  return {
    id: id == null ? '' : String(id),
    title: typeof o.title === 'string' && o.title.trim() ? o.title : 'New chat',
    createdAt:
      typeof o.created_at === 'string' ? o.created_at
        : typeof o.createdAt === 'string' ? o.createdAt : undefined,
  }
}

function toMessage(v: unknown): RagMessage {
  const o = asRecord(v)
  const content = typeof o.content === 'string' ? o.content
    : typeof o.message === 'string' ? o.message : ''
  return {
    role: o.role === 'assistant' ? 'assistant' : 'user',
    content,
    sources: Array.isArray(o.sources) ? (o.sources as RagSource[]) : undefined,
  }
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

/** An authenticated RAG request with one 401 retry (refresh the token once). */
async function authed(path: string, init: RequestInit): Promise<Response> {
  const call = (token: string): Promise<Response> =>
    fetchOrExplain(`${RAG_BASE_URL}${path}`, {
      ...init,
      credentials: 'include',
      headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` },
    })
  let res = await call(await getToken())
  if (res.status === 401) {
    cachedToken = null
    res = await call(await getToken(true))
  }
  return res
}

/**
 * Ask the knowledge base a question within a chat session. Retries once with a
 * fresh token if the cached one has expired (401).
 */
export async function askSession(question: string, sessionId = 'default'): Promise<RagAnswer> {
  const res = await authed('/ask-session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question, session_id: sessionId }),
  })
  const payload = await readJson(res)
  if (!res.ok) throw ragError(res, payload, 'The AI assistant could not answer that.')
  return {
    answer: typeof payload.answer === 'string' ? payload.answer : '',
    sources: Array.isArray(payload.sources) ? (payload.sources as RagSource[]) : [],
    question: typeof payload.question === 'string' ? payload.question : question,
  }
}

/** List the signed-in user's saved chat sessions. */
export async function listSessions(): Promise<RagSession[]> {
  const res = await authed('/sessions', { method: 'GET' })
  const payload = await readJson(res)
  if (!res.ok) throw ragError(res, payload, 'Could not load your chats.')
  const list = Array.isArray(payload.sessions) ? payload.sessions : []
  return list.map(toSession).filter(s => s.id)
}

/** Create a new chat session and return it with its server-assigned id. */
export async function createSession(title = 'New chat'): Promise<RagSession> {
  const res = await authed('/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  })
  const payload = await readJson(res)
  if (!res.ok) throw ragError(res, payload, 'Could not start a new chat.')
  return toSession(payload)
}

/** Delete a chat session and its messages. */
export async function deleteSession(id: string): Promise<void> {
  const res = await authed(`/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' })
  if (!res.ok) throw ragError(res, await readJson(res), 'Could not delete that chat.')
}

/** Load a saved session's messages, to reopen and continue it. */
export async function sessionHistory(id: string): Promise<RagMessage[]> {
  const res = await authed(`/sessions/${encodeURIComponent(id)}/history`, { method: 'GET' })
  const payload = await readJson(res)
  if (!res.ok) throw ragError(res, payload, 'Could not load that chat.')
  const list = Array.isArray(payload.messages) ? payload.messages : []
  return list.map(toMessage)
}
