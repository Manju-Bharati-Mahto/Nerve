import { useState, useRef, useEffect, useCallback } from 'react'
import { useAppData } from '@/hooks/useAppData'
import type { Entry } from '@/lib/app-types'
import { DEPARTMENTS } from '@/lib/constants'
import { ragHealth, askSession, listSessions, createSession, deleteSession, sessionHistory,
  type RagSource, type RagSession } from '@/lib/rag-api'
import { HttpError } from '@/lib/http'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Send, Sparkles, Copy, Check, Wifi, WifiOff, RefreshCw, Plus, MessageSquare, Trash2, PanelLeft } from 'lucide-react'

const QUICK_PROMPTS = [
  { label: 'Physiotherapy summary', q: 'Summarize all Physiotherapy updates and achievements' },
  { label: 'Engineering brochure',  q: 'Generate brochure content for the Engineering department' },
  { label: 'All key highlights',    q: 'List all key highlights across all departments' },
  { label: 'MOUs & partnerships',   q: 'What are all MOUs and partnerships signed recently?' },
  { label: 'All placements',        q: 'Summarize all placement and industry connection updates' },
  { label: 'Research & faculty',    q: 'List all research projects and faculty achievements' },
  { label: 'Student achievements',  q: 'List all notable student achievements and activities' },
]

type Msg = { role: 'user' | 'assistant'; content: string; sources?: RagSource[]; error?: boolean }

function buildLocalAnswer(question: string, entries: Entry[]): string {
  const q = question.toLowerCase()

  const relevant = entries.filter(e =>
    e.title?.toLowerCase().includes(q.split(' ').find(w => w.length > 4) || '') ||
    e.dept?.toLowerCase().includes(q) ||
    e.type?.toLowerCase().includes(q) ||
    e.body?.toLowerCase().includes(q.split(' ').find(w => w.length > 4) || '')
  ).slice(0, 8)

  if (relevant.length === 0) {
    const all = entries.slice(0, 5)
    return `No entries directly match your query. Here are the 5 most recent entries:\n\n` +
      all.map(e => `• [${e.dept}] ${e.title} (${e.entry_date})`).join('\n')
  }

  return `Found ${relevant.length} relevant entries:\n\n` +
    relevant.map(e =>
      `**${e.title}**\n` +
      `Department: ${e.dept} | Type: ${e.type} | Priority: ${e.priority}\n` +
      `Date: ${e.entry_date}\n` +
      `${e.body?.slice(0, 300)}${(e.body?.length || 0) > 300 ? '…' : ''}`
    ).join('\n\n---\n\n') +
    '\n\n*(AI responses are unavailable — this is a local search result from the knowledge base.)*'
}

/** A readable one-line label for a retrieved source chunk, tolerant of field shape. */
function sourceLabel(s: RagSource): string {
  const name =
    (typeof s.source === 'string' && s.source) ||
    (typeof s.title === 'string' && s.title) ||
    (typeof s.filename === 'string' && (s.filename as string)) ||
    'Document'
  const page = typeof s.page === 'number' ? `, p.${s.page}` : ''
  return `${name}${page}`
}

/** Collapse duplicate source+page pairs so a multi-chunk answer lists each file once. */
function dedupeSources(sources: RagSource[]): RagSource[] {
  const seen = new Set<string>()
  const out: RagSource[] = []
  for (const s of sources) {
    const key = sourceLabel(s)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(s)
  }
  return out
}

/**
 * Renders an assistant answer as GitHub-flavored Markdown (headings, bold,
 * lists, tables, code, links) instead of showing the raw `*`, `#`, `|` syntax.
 * Styled with the typography plugin's `prose`, tuned compact and dark-aware.
 * react-markdown does not render raw HTML, so model output can't inject markup.
 */
function Markdown({ children }: { children: string }) {
  return (
    <div className="prose prose-sm max-w-none dark:prose-invert leading-relaxed
                    prose-headings:font-serif prose-headings:mt-3 prose-headings:mb-1.5
                    prose-p:my-2 prose-pre:my-2 prose-ul:my-2 prose-ol:my-2 prose-li:my-0.5
                    prose-table:my-2 prose-th:px-2 prose-th:py-1 prose-td:px-2 prose-td:py-1
                    prose-code:before:content-none prose-code:after:content-none
                    prose-code:rounded prose-code:bg-muted prose-code:px-1 prose-code:py-0.5
                    prose-a:text-primary">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </div>
  )
}

export default function AIQueryPage() {
  const { entries: allEntries } = useAppData()
  const [question, setQuestion]   = useState('')
  const [deptFilter, setDeptFilter] = useState('')
  const [messages, setMessages]   = useState<Msg[]>([])
  const [loading, setLoading]     = useState(false)
  const [copied, setCopied]       = useState(false)
  // null = still checking, true = RAG reachable, false = offline (local fallback)
  const [online, setOnline]       = useState<boolean | null>(null)
  // Chat history (RAG sessions). activeSessionId null = a fresh, unsaved chat.
  const [sessions, setSessions]   = useState<RagSession[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [sessionsLoading, setSessionsLoading] = useState(false)
  const [railOpen, setRailOpen]   = useState(true)
  const outputRef = useRef<HTMLDivElement>(null)

  const checkHealth = useCallback(() => {
    setOnline(null)
    ragHealth().then(setOnline)
  }, [])

  const loadSessions = useCallback(() => {
    setSessionsLoading(true)
    listSessions().then(setSessions).catch(() => { /* leave the list as-is */ })
      .finally(() => setSessionsLoading(false))
  }, [])

  useEffect(() => { checkHealth() }, [checkHealth])
  // Load saved chats once the RAG is reachable.
  useEffect(() => { if (online === true) loadSessions() }, [online, loadSessions])

  function newChat() {
    setActiveSessionId(null)
    setMessages([])
    setQuestion('')
  }

  async function openSession(id: string) {
    if (loading || id === activeSessionId) return
    setActiveSessionId(id)
    setLoading(true)
    try {
      const msgs = await sessionHistory(id)
      setMessages(msgs.map(m => ({ role: m.role, content: m.content, sources: m.sources })))
    } catch {
      setMessages([])
    } finally {
      setLoading(false)
    }
  }

  async function removeSession(id: string, e: React.MouseEvent) {
    e.stopPropagation()
    setSessions(prev => prev.filter(s => s.id !== id))
    if (activeSessionId === id) newChat()
    try { await deleteSession(id) } catch { loadSessions() }
  }

  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight
    }
  }, [messages])

  async function run(input?: string) {
    const q = (input ?? question).trim()
    if (!q || loading) return
    setQuestion('')
    setLoading(true)
    setMessages(prev => [...prev, { role: 'user', content: q }])

    const localAnswer = () => {
      const entries = deptFilter ? allEntries.filter(e => e.dept === deptFilter) : allEntries
      return buildLocalAnswer(q, entries)
    }

    try {
      // Known-offline (health failed): the banner already explains it, so just
      // serve local search without an extra per-message error.
      if (online === false) {
        setMessages(prev => [...prev, { role: 'assistant', content: localAnswer() }])
        return
      }
      // Lazily create a saved session on the first message so the chat appears
      // in history; fall back to the shared "default" session if creation fails.
      let sid = activeSessionId
      if (!sid) {
        try {
          const s = await createSession(q.slice(0, 60))
          sid = s.id || 'default'
          if (s.id) setActiveSessionId(s.id)
        } catch {
          sid = 'default'
        }
      }
      const prompt = deptFilter ? `${q}\n\n(Focus on the ${deptFilter} department.)` : q
      const res = await askSession(prompt, sid)
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: res.answer || 'The assistant returned an empty answer.',
        sources: res.sources,
      }])
      if (online !== true) setOnline(true)
      loadSessions()  // pick up the new chat / its auto-generated title
    } catch (err) {
      // A real RAG attempt failed: surface the backend's actual status/detail
      // (e.g. "401: Invalid or expired token" vs "500: Internal Server Error")
      // instead of hiding it, then still fall back to local search. The status
      // alone distinguishes an auth failure (401) from a retrieval/generation
      // failure (5xx), so the page is self-diagnosing.
      const status = err instanceof HttpError ? err.status : 0
      const detail = err instanceof Error ? err.message : String(err)
      const head = status === 0
        ? 'Could not reach the AI backend (network).'
        : `The AI backend returned an error — ${status}${detail ? `: ${detail}` : ''}.`
      setMessages(prev => [...prev, {
        role: 'assistant', error: true,
        content: `${head}\n\nShowing local keyword search instead:\n\n${localAnswer()}`,
      }])
      setOnline(false)
    } finally {
      setLoading(false)
    }
  }

  function copyLast() {
    const last = messages.filter(m => m.role === 'assistant').pop()
    if (last) {
      navigator.clipboard.writeText(last.content)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  return (
    <div className="animate-fade-in flex gap-3 h-[calc(100vh-7rem)]">
      {/* Chat-history rail — the signed-in user's saved RAG sessions. */}
      {railOpen && (
        <aside className="w-56 shrink-0 hidden sm:flex flex-col hub-card p-2 overflow-hidden">
          <button onClick={newChat}
            className="flex items-center justify-center gap-1.5 w-full px-3 py-2 mb-2 rounded-lg bg-primary text-primary-foreground text-sm hover:bg-brand-dark transition-colors shrink-0">
            <Plus className="w-4 h-4" /> New chat
          </button>
          <div className="flex-1 min-h-0 overflow-auto space-y-0.5">
            {sessionsLoading && sessions.length === 0 ? (
              <p className="text-xs text-muted-foreground px-2 py-2">Loading chats…</p>
            ) : sessions.length === 0 ? (
              <p className="text-xs text-muted-foreground px-2 py-2">No saved chats yet.</p>
            ) : sessions.map(s => (
              <div key={s.id} onClick={() => openSession(s.id)}
                className={`group flex items-center gap-1.5 px-2 py-1.5 rounded-lg cursor-pointer text-sm ${
                  s.id === activeSessionId ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/50'
                }`}>
                <MessageSquare className="w-3.5 h-3.5 shrink-0 opacity-70" />
                <span className="flex-1 truncate" title={s.title}>{s.title}</span>
                <button onClick={e => removeSession(s.id, e)}
                  className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-opacity shrink-0"
                  title="Delete chat" aria-label="Delete chat">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        </aside>
      )}

      <div className="flex-1 min-w-0 flex flex-col">
        <div className="mb-4 flex items-start justify-between gap-3 shrink-0">
          <div className="flex items-start gap-2 min-w-0">
            <button onClick={() => setRailOpen(o => !o)}
              className="mt-1.5 p-1.5 rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground transition-colors shrink-0"
              title={railOpen ? 'Hide chats' : 'Show chats'} aria-label="Toggle chat history">
              <PanelLeft className="w-4 h-4" />
            </button>
            <div className="min-w-0">
              <h1 className="text-2xl font-serif text-foreground">Ask AI</h1>
              <p className="text-sm text-muted-foreground mt-1">Query your knowledge base</p>
            </div>
          </div>
        {online === true && (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs bg-emerald-50 border border-emerald-200 text-emerald-700 shrink-0">
            <Wifi className="w-3.5 h-3.5" /> AI connected
          </span>
        )}
      </div>

      {online === null && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-muted/50 border border-border text-muted-foreground text-xs mb-4 shrink-0">
          <RefreshCw className="w-3.5 h-3.5 shrink-0 animate-spin" />
          Connecting to the AI knowledge base…
        </div>
      )}

      {online === false && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-50 border border-amber-200 text-amber-700 text-xs mb-4 shrink-0">
          <WifiOff className="w-3.5 h-3.5 shrink-0" />
          <span className="flex-1">AI backend disconnected. Showing local keyword search results instead.</span>
          <button onClick={checkHealth}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md border border-amber-300 hover:bg-amber-100 transition-colors">
            <RefreshCw className="w-3 h-3" /> Retry
          </button>
        </div>
      )}

      {messages.length === 0 && (
        <div className="mb-4 shrink-0">
          <p className="text-xs text-muted-foreground mb-2">Quick prompts:</p>
          <div className="flex flex-wrap gap-2">
            {QUICK_PROMPTS.map(p => (
              <button key={p.label} onClick={() => run(p.q)}
                className="px-3 py-1.5 rounded-full text-xs border border-border text-muted-foreground hover:bg-accent hover:text-foreground transition-colors">
                {p.label}
              </button>
            ))}
          </div>
        </div>
      )}

      <div ref={outputRef} className="flex-1 min-h-0 overflow-auto space-y-4 mb-4">
        {messages.map((m, i) => (
          <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[80%] rounded-xl px-4 py-3 text-sm ${
              m.role === 'user' ? 'bg-primary text-primary-foreground'
                : m.error ? 'bg-amber-50 border border-amber-200 text-amber-900'
                : 'hub-card'
            }`}>
              {m.role === 'assistant' ? (
                <>
                  {m.error ? (
                    <div className="whitespace-pre-wrap leading-relaxed">
                      <WifiOff className="inline w-3.5 h-3.5 mr-1.5 -mt-0.5 text-amber-600" />
                      {m.content}
                    </div>
                  ) : (
                    <Markdown>{m.content}</Markdown>
                  )}
                  {m.sources && m.sources.length > 0 && (
                    <div className="mt-3 pt-2 border-t border-border/60">
                      <p className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">Sources</p>
                      <ul className="space-y-0.5">
                        {dedupeSources(m.sources).map((s, j) => (
                          <li key={j} className="text-xs text-muted-foreground">• {sourceLabel(s)}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </>
              ) : m.content}
            </div>
          </div>
        ))}
        {loading && (
          <div className="flex justify-start">
            <div className="hub-card px-4 py-3">
              <Sparkles className="w-4 h-4 text-primary animate-pulse" />
            </div>
          </div>
        )}
      </div>

      {messages.some(m => m.role === 'assistant') && (
        <div className="flex justify-end mb-2 shrink-0">
          <button onClick={copyLast}
            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors">
            {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
            {copied ? 'Copied!' : 'Copy last response'}
          </button>
        </div>
      )}

      <div className="hub-card flex items-center gap-3 shrink-0">
        <select className="hub-input w-40 shrink-0" value={deptFilter} onChange={e => setDeptFilter(e.target.value)}>
          <option value="">All depts</option>
          {DEPARTMENTS.map(d => <option key={d}>{d}</option>)}
        </select>
        <input className="hub-input flex-1" placeholder="Search the knowledge base..."
          value={question} onChange={e => setQuestion(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && !loading && run()} disabled={loading} />
        <button onClick={() => run()} disabled={loading || !question.trim()}
          className="p-2.5 rounded-lg bg-primary text-primary-foreground hover:bg-brand-dark transition-colors disabled:opacity-50">
          <Send className="w-4 h-4" />
        </button>
      </div>
      </div>
    </div>
  )
}
