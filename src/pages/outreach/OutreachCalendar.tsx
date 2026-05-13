import { useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Calendar as CalendarIcon, ChevronLeft, ChevronRight, Upload, X, AlertCircle, CheckCircle,
} from 'lucide-react'
import {
  useOutreachData, addPostsBulk, slug, formatLocalDate,
  type PostType, type PostStatus, type Post,
} from '@/lib/outreach-data'

// Stable hash → palette (one color per campaign). With the campaign-only
// filter on the grid every tile has a campaignId, but `colorFor` still tolerates
// nulls so it stays safe if the filter is ever relaxed.
const PALETTE = ['#f97316', '#3b82f6', '#10b981', '#8b5cf6', '#ec4899', '#f59e0b', '#06b6d4', '#ef4444', '#84cc16', '#a855f7', '#0ea5e9', '#facc15']

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

const UNATTRIBUTED_COLOR = '#94a3b8'
function colorFor(id: string | null): string {
  if (!id) return UNATTRIBUTED_COLOR
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return PALETTE[h % PALETTE.length]
}

export default function OutreachCalendar() {
  const { posts, campaigns, pages, creators } = useOutreachData()
  const [view, setView] = useState<'month' | 'week'>('month')
  const [cursor, setCursor] = useState(() => new Date())
  const [uploadOpen, setUploadOpen] = useState(false)

  const month = cursor.getMonth()
  const year = cursor.getFullYear()
  // Local date string — must NOT use toISOString (UTC) since cell dates are
  // local calendar days; in IST that would shift every cell by one.
  const today = formatLocalDate(new Date())

  const cells = useMemo(() => {
    if (view === 'month') {
      const firstDay = new Date(year, month, 1).getDay()
      const daysInMonth = new Date(year, month + 1, 0).getDate()
      const out: { date: string | null; isToday: boolean }[] = []
      for (let i = 0; i < firstDay; i++) out.push({ date: null, isToday: false })
      for (let d = 1; d <= daysInMonth; d++) {
        const iso = formatLocalDate(new Date(year, month, d))
        out.push({ date: iso, isToday: iso === today })
      }
      while (out.length % 7 !== 0) out.push({ date: null, isToday: false })
      return out
    } else {
      const start = new Date(cursor)
      start.setDate(cursor.getDate() - cursor.getDay())
      return Array.from({ length: 7 }, (_, i) => {
        const d = new Date(start)
        d.setDate(start.getDate() + i)
        const iso = formatLocalDate(d)
        return { date: iso, isToday: iso === today }
      })
    }
  }, [view, year, month, cursor, today])

  // Calendar only surfaces posts that belong to a campaign. Standalone /
  // unattributed posts (e.g. creator-side ad-hoc adds) stay out of view so
  // the grid stays a campaign-planning surface.
  const postsByDate = useMemo(() => {
    const out = new Map<string, Post[]>()
    for (const p of posts) {
      if (!p.campaignId) continue
      const arr = out.get(p.date) ?? []
      arr.push(p)
      out.set(p.date, arr)
    }
    return out
  }, [posts])

  const monthLabel = cursor.toLocaleString('en-US', { month: 'long', year: 'numeric' })

  function shift(dir: -1 | 1) {
    const d = new Date(cursor)
    if (view === 'month') d.setMonth(d.getMonth() + dir)
    else d.setDate(d.getDate() + dir * 7)
    setCursor(d)
  }

  return (
    <div className="animate-fade-in space-y-5">

      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-orange-100 flex items-center justify-center">
            <CalendarIcon className="w-5 h-5 text-orange-600" />
          </div>
          <div>
            <h1 className="text-2xl font-serif text-foreground">Calendar</h1>
            <p className="text-sm text-muted-foreground">Schedule and track outreach activity. Each event is colored by campaign.</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="inline-flex bg-card border border-border rounded-lg overflow-hidden text-xs">
            {(['month', 'week'] as const).map(v => (
              <button key={v} onClick={() => setView(v)}
                className={`px-3 py-1.5 transition-colors capitalize ${view === v ? 'bg-orange-100 text-orange-700 font-medium' : 'text-muted-foreground hover:bg-accent'}`}>
                {v}
              </button>
            ))}
          </div>
          <button onClick={() => setUploadOpen(true)}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium bg-orange-600 text-white hover:opacity-90 transition-opacity">
            <Upload className="w-4 h-4" /> Import CSV
          </button>
        </div>
      </div>

      <div className="hub-card">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-foreground">{monthLabel}</h2>
          <div className="flex items-center gap-1">
            <button onClick={() => shift(-1)} className="p-1.5 rounded-lg hover:bg-accent text-muted-foreground"><ChevronLeft className="w-4 h-4" /></button>
            <button onClick={() => setCursor(new Date())} className="text-xs px-2 py-1 rounded-lg hover:bg-accent text-muted-foreground">Today</button>
            <button onClick={() => shift(1)} className="p-1.5 rounded-lg hover:bg-accent text-muted-foreground"><ChevronRight className="w-4 h-4" /></button>
          </div>
        </div>

        <div className="grid grid-cols-7 gap-1 mb-2">
          {WEEKDAYS.map(d => (
            <div key={d} className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground text-center py-1">{d}</div>
          ))}
        </div>

        <div className={`grid grid-cols-7 gap-1 ${view === 'week' ? 'auto-rows-[200px]' : 'auto-rows-[120px]'}`}>
          {cells.map((c, i) => {
            const events = c.date ? (postsByDate.get(c.date) ?? []) : []
            return (
              <div key={i}
                className={`rounded-lg border p-1.5 overflow-hidden flex flex-col gap-0.5 ${
                  c.date === null ? 'border-transparent'
                    : c.isToday ? 'border-orange-300 bg-orange-50' : 'border-border'
                }`}>
                {c.date && (
                  <div className="text-[11px] font-medium text-foreground/80 mb-0.5">
                    {parseInt(c.date.slice(8, 10), 10)}
                  </div>
                )}
                <div className="flex-1 overflow-y-auto space-y-0.5">
                  {events.slice(0, view === 'week' ? 12 : 4).map(p => {
                    // Every event here has a campaignId (filtered above), and
                    // clicking the tile always opens the campaign dashboard so
                    // the calendar acts as a navigator into campaign details.
                    const camp = campaigns.find(c => c.id === p.campaignId)
                    const page = p.pageId ? pages.find(pp => pp.id === p.pageId) : null
                    const creator = p.creatorId ? creators.find(cc => cc.id === p.creatorId) : null
                    const subjectHandle = page?.handle ?? creator?.handle ?? null
                    const color = colorFor(p.campaignId)
                    const label = camp?.name ?? (subjectHandle ? `@${subjectHandle}` : 'post')
                    const title = `${camp?.name ?? 'Campaign'} — @${subjectHandle ?? '?'} — ${p.type}`
                    const cls = "block px-1.5 py-0.5 rounded text-[10px] truncate text-white"
                    return (
                      <Link key={p.id} to={camp ? `/outreach/campaigns/${camp.id}` : '#'}
                        title={title}
                        className={cls}
                        style={{ backgroundColor: color }}>
                        {label}
                      </Link>
                    )
                  })}
                  {events.length > (view === 'week' ? 12 : 4) && (
                    <p className="text-[10px] text-muted-foreground px-1">+{events.length - (view === 'week' ? 12 : 4)} more</p>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {uploadOpen && <ImportModal onClose={() => setUploadOpen(false)} />}

    </div>
  )
}

// ── CSV import with column mapping ─────────────────────────────────────────

type Field = 'date' | 'page' | 'campaign' | 'type' | 'variant' | 'caption' | 'ignore'
const FIELDS: { id: Field; label: string; required: boolean }[] = [
  { id: 'date',     label: 'Date',           required: true },
  { id: 'page',     label: 'Page handle',    required: true },
  { id: 'campaign', label: 'Campaign',       required: true },
  { id: 'type',     label: 'Type',           required: false },
  { id: 'variant',  label: 'Creative variant', required: false },
  { id: 'caption',  label: 'Caption',        required: false },
  { id: 'ignore',   label: 'Ignore',         required: false },
]

function ImportModal({ onClose }: { onClose: () => void }) {
  const { pages, campaigns } = useOutreachData()
  const fileRef = useRef<HTMLInputElement>(null)
  const [step, setStep] = useState<'file' | 'map' | 'confirm' | 'done'>('file')
  const [headers, setHeaders] = useState<string[]>([])
  const [rows, setRows] = useState<string[][]>([])
  const [mapping, setMapping] = useState<Record<string, Field>>({})
  const [createdCount, setCreatedCount] = useState(0)
  const [skipped, setSkipped] = useState<string[]>([])

  function parseCSV(text: string): string[][] {
    // Minimal CSV parser handling quoted fields with commas
    const rows: string[][] = []
    let row: string[] = []
    let field = ''
    let inQuote = false
    for (let i = 0; i < text.length; i++) {
      const ch = text[i]
      if (inQuote) {
        if (ch === '"' && text[i + 1] === '"') { field += '"'; i++ }
        else if (ch === '"') inQuote = false
        else field += ch
      } else {
        if (ch === '"') inQuote = true
        else if (ch === ',') { row.push(field); field = '' }
        else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = '' }
        else if (ch === '\r') { /* skip */ }
        else field += ch
      }
    }
    if (field.length || row.length) { row.push(field); rows.push(row) }
    return rows.filter(r => r.some(c => c.trim()))
  }

  function autoMap(hdrs: string[]): Record<string, Field> {
    const out: Record<string, Field> = {}
    for (const h of hdrs) {
      const lc = h.toLowerCase().trim()
      if (/(^|\W)(date|day|published|scheduled)/.test(lc))     out[h] = 'date'
      else if (/page|handle|account|profile/.test(lc))         out[h] = 'page'
      else if (/campaign|brief|project/.test(lc))              out[h] = 'campaign'
      else if (/type|format/.test(lc))                          out[h] = 'type'
      else if (/variant|creative|set/.test(lc))                 out[h] = 'variant'
      else if (/caption|copy|text/.test(lc))                    out[h] = 'caption'
      else                                                       out[h] = 'ignore'
    }
    return out
  }

  function onFile(file: File) {
    const reader = new FileReader()
    reader.onload = () => {
      const text = String(reader.result ?? '')
      const parsed = parseCSV(text)
      if (parsed.length < 2) return
      const hdrs = parsed[0].map(s => s.trim())
      setHeaders(hdrs)
      setRows(parsed.slice(1, 101))   // preview up to 100 rows
      setMapping(autoMap(hdrs))
      setStep('map')
    }
    reader.readAsText(file)
  }

  function findField(field: Field): number {
    return headers.findIndex(h => mapping[h] === field)
  }

  function commitImport() {
    const dateIdx = findField('date')
    const pageIdx = findField('page')
    const campIdx = findField('campaign')
    const typeIdx = findField('type')
    const varIdx = findField('variant')
    const capIdx = findField('caption')

    const created: Omit<Post, 'id'>[] = []
    const skip: string[] = []

    for (const row of rows) {
      const dateRaw = row[dateIdx] ?? ''
      const pageRaw = (row[pageIdx] ?? '').trim()
      const campRaw = (row[campIdx] ?? '').trim()

      if (!dateRaw || !pageRaw || !campRaw) {
        skip.push(`missing required field: ${row.join(' | ')}`)
        continue
      }

      const date = normalizeDate(dateRaw)
      if (!date) { skip.push(`bad date "${dateRaw}"`); continue }

      const pageMatch = pages.find(p => p.handle.toLowerCase() === pageRaw.toLowerCase() || p.id === slug(pageRaw))
      if (!pageMatch) { skip.push(`unknown page "${pageRaw}"`); continue }

      const campMatch = campaigns.find(c => c.name.toLowerCase() === campRaw.toLowerCase() || c.id === slug(campRaw))
      if (!campMatch) { skip.push(`unknown campaign "${campRaw}"`); continue }

      const typeRaw = (row[typeIdx] ?? '').toLowerCase().trim()
      const type: PostType = typeRaw === 'reel' ? 'reel' : typeRaw === 'story' ? 'story' : typeRaw === 'carousel' ? 'carousel' : 'static'
      const variant = varIdx >= 0 ? (row[varIdx] ?? '').trim() || null : null
      const caption = capIdx >= 0 ? (row[capIdx] ?? '').trim() : ''
      const status: PostStatus = new Date(date).getTime() < Date.now() ? 'published' : 'scheduled'

      created.push({
        date, pageId: pageMatch.id, creatorId: null, campaignId: campMatch.id, type,
        creativeVariant: variant, caption, status,
        likes: 0, comments: 0, views: 0, saves: 0, shares: 0,
      })
    }

    addPostsBulk(created)
    setCreatedCount(created.length)
    setSkipped(skip)
    setStep('done')
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4 animate-fade-in">
      <div className="bg-card rounded-xl border border-border w-full max-w-3xl max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between p-4 border-b border-border">
          <div>
            <h2 className="text-base font-serif text-foreground">Import scheduled posts</h2>
            <p className="text-xs text-muted-foreground">CSV with columns of your choice — map them in the next step.</p>
          </div>
          <button onClick={onClose} className="p-2 rounded-lg hover:bg-accent text-muted-foreground"><X className="w-4 h-4" /></button>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {step === 'file' && (
            <div className="text-center py-8">
              <Upload className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
              <p className="text-sm text-foreground mb-1">Choose a CSV file to upload</p>
              <p className="text-xs text-muted-foreground mb-4">Column names can be anything; you'll map them in the next step.</p>
              <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden"
                onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f) }} />
              <button onClick={() => fileRef.current?.click()}
                className="px-4 py-2 rounded-lg bg-orange-600 text-white text-sm font-medium hover:opacity-90">
                Select file
              </button>
            </div>
          )}

          {step === 'map' && (
            <div className="space-y-4">
              <div className="hub-card bg-blue-50 border-blue-200 text-xs text-blue-900 py-2">
                Detected {headers.length} columns and {rows.length} preview rows. Map each column to a field below — required fields are marked.
              </div>
              <div className="space-y-2">
                {headers.map(h => (
                  <div key={h} className="flex items-center gap-3">
                    <p className="flex-1 text-sm text-foreground font-mono truncate">{h}</p>
                    <span className="text-xs text-muted-foreground">→</span>
                    <select value={mapping[h] ?? 'ignore'}
                      onChange={e => setMapping(m => ({ ...m, [h]: e.target.value as Field }))}
                      className="hub-input py-1.5 text-xs w-48">
                      {FIELDS.map(f => <option key={f.id} value={f.id}>{f.label}{f.required ? ' *' : ''}</option>)}
                    </select>
                  </div>
                ))}
              </div>
              <div className="border border-border rounded-lg overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-muted/50 text-left">
                      {headers.map(h => (
                        <th key={h} className="px-2 py-1.5 font-medium">{h} <span className="text-muted-foreground">({mapping[h] ?? 'ignore'})</span></th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.slice(0, 5).map((r, i) => (
                      <tr key={i} className="border-t border-border">
                        {r.map((c, j) => <td key={j} className="px-2 py-1.5 truncate max-w-[180px]">{c}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {step === 'confirm' && (
            <div className="hub-card bg-orange-50 border-orange-200 text-sm text-orange-900">
              About to import <strong>{rows.length}</strong> rows. Unknown pages or campaigns will be skipped — you'll see a list afterward.
            </div>
          )}

          {step === 'done' && (
            <div className="space-y-3">
              <div className="hub-card bg-emerald-50 border-emerald-200 text-sm text-emerald-900 flex items-center gap-2">
                <CheckCircle className="w-4 h-4" /> Created {createdCount} scheduled posts.
              </div>
              {skipped.length > 0 && (
                <div className="hub-card bg-amber-50 border-amber-200 text-xs text-amber-900">
                  <p className="flex items-center gap-1.5 font-semibold mb-2"><AlertCircle className="w-4 h-4" /> Skipped {skipped.length} rows</p>
                  <ul className="space-y-0.5 max-h-40 overflow-y-auto font-mono">
                    {skipped.slice(0, 30).map((s, i) => <li key={i}>· {s}</li>)}
                    {skipped.length > 30 && <li className="text-amber-700">…and {skipped.length - 30} more</li>}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between p-4 border-t border-border">
          <button onClick={() => step === 'map' ? setStep('file') : step === 'confirm' ? setStep('map') : onClose()}
            className="px-4 py-2 rounded-lg border border-border text-sm text-muted-foreground hover:bg-accent">
            {step === 'done' ? 'Close' : step === 'file' ? 'Cancel' : 'Back'}
          </button>
          {step === 'map' && (
            <button onClick={() => {
              const ok = FIELDS.filter(f => f.required).every(f => Object.values(mapping).includes(f.id))
              if (ok) setStep('confirm')
            }}
              className="px-4 py-2 rounded-lg bg-orange-600 text-white text-sm font-medium hover:opacity-90">
              Continue
            </button>
          )}
          {step === 'confirm' && (
            <button onClick={commitImport}
              className="px-4 py-2 rounded-lg bg-orange-600 text-white text-sm font-medium hover:opacity-90">
              Import {rows.length} posts
            </button>
          )}
          {step === 'done' && (
            <button onClick={onClose}
              className="px-4 py-2 rounded-lg bg-orange-600 text-white text-sm font-medium hover:opacity-90">
              Done
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// Accept "DD/MM/YYYY", "DD-MM-YYYY", "YYYY-MM-DD" — normalize to ISO YYYY-MM-DD.
function normalizeDate(raw: string): string | null {
  const s = raw.trim()
  if (!s) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  const m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/)
  if (!m) return null
  const [, d, mo, y] = m
  const yyyy = y.length === 2 ? `20${y}` : y
  const dd = d.padStart(2, '0')
  const mm = mo.padStart(2, '0')
  const date = new Date(`${yyyy}-${mm}-${dd}`)
  if (Number.isNaN(date.getTime())) return null
  return `${yyyy}-${mm}-${dd}`
}
