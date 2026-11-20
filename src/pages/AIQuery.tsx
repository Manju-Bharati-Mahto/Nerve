import { useState, useRef, useEffect, useCallback } from 'react'
import { useAppData } from '@/hooks/useAppData'
import type { Entry } from '@/lib/app-types'
import { DEPARTMENTS } from '@/lib/constants'
import { ragHealth, askSession, type RagSource } from '@/lib/rag-api'
import { Send, Sparkles, Copy, Check, Wifi, WifiOff, RefreshCw } from 'lucide-react'

const QUICK_PROMPTS = [
  { label: 'Physiotherapy summary', q: 'Summarize all Physiotherapy updates and achievements' },
  { label: 'Engineering brochure',  q: 'Generate brochure content for the Engineering department' },
  { label: 'All key highlights',    q: 'List all key highlights across all departments' },
  { label: 'MOUs & partnerships',   q: 'What are all MOUs and partnerships signed recently?' },
  { label: 'All placements',        q: 'Summarize all placement and industry connection updates' },
  { label: 'Research & faculty',    q: 'List all research projects and faculty achievements' },
  { label: 'Student achievements',  q: 'List all notable student achievements and activities' },
]

type Msg = { role: 'user' | 'assistant'; content: string; sources?: RagSource[] }

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

export default function AIQueryPage() {
  const { entries: allEntries } = useAppData()
  const [question, setQuestion]   = useState('')
  const [deptFilter, setDeptFilter] = useState('')
  const [messages, setMessages]   = useState<Msg[]>([])
  const [loading, setLoading]     = useState(false)
  const [copied, setCopied]       = useState(false)
  // null = still checking, true = RAG reachable, false = offline (local fallback)
  const [online, setOnline]       = useState<boolean | null>(null)
  const outputRef = useRef<HTMLDivElement>(null)

  const checkHealth = useCallback(() => {
    setOnline(null)
    ragHealth().then(setOnline)
  }, [])

  useEffect(() => { checkHealth() }, [checkHealth])

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

    try {
      // Skip the network round-trip when we already know the RAG is down.
      if (online === false) throw new Error('offline')
      const prompt = deptFilter ? `${q}\n\n(Focus on the ${deptFilter} department.)` : q
      const res = await askSession(prompt)
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: res.answer || 'The assistant returned an empty answer.',
        sources: res.sources,
      }])
      if (online !== true) setOnline(true)
    } catch {
      // Degrade to local keyword search and let the banner reflect reality.
      setOnline(false)
      let entries = allEntries
      if (deptFilter) entries = entries.filter(e => e.dept === deptFilter)
      setMessages(prev => [...prev, { role: 'assistant', content: buildLocalAnswer(q, entries) }])
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
    <div className="animate-fade-in flex flex-col h-[calc(100vh-4rem)]">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-serif text-foreground">Ask AI</h1>
          <p className="text-sm text-muted-foreground mt-1">Query your knowledge base</p>
        </div>
        {online === true && (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs bg-emerald-50 border border-emerald-200 text-emerald-700 shrink-0">
            <Wifi className="w-3.5 h-3.5" /> AI connected
          </span>
        )}
      </div>

      {online === null && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-muted/50 border border-border text-muted-foreground text-xs mb-4">
          <RefreshCw className="w-3.5 h-3.5 shrink-0 animate-spin" />
          Connecting to the AI knowledge base…
        </div>
      )}

      {online === false && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-50 border border-amber-200 text-amber-700 text-xs mb-4">
          <WifiOff className="w-3.5 h-3.5 shrink-0" />
          <span className="flex-1">AI backend disconnected. Showing local keyword search results instead.</span>
          <button onClick={checkHealth}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md border border-amber-300 hover:bg-amber-100 transition-colors">
            <RefreshCw className="w-3 h-3" /> Retry
          </button>
        </div>
      )}

      {messages.length === 0 && (
        <div className="mb-4">
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

      <div ref={outputRef} className="flex-1 overflow-auto space-y-4 mb-4">
        {messages.map((m, i) => (
          <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[80%] rounded-xl px-4 py-3 text-sm ${
              m.role === 'user' ? 'bg-primary text-primary-foreground' : 'hub-card'
            }`}>
              {m.role === 'assistant' ? (
                <>
                  <div className="whitespace-pre-wrap leading-relaxed">{m.content}</div>
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
        <div className="flex justify-end mb-2">
          <button onClick={copyLast}
            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors">
            {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
            {copied ? 'Copied!' : 'Copy last response'}
          </button>
        </div>
      )}

      <div className="hub-card flex items-center gap-3">
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
  )
}
