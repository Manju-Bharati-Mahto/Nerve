import { useState, useMemo, useCallback } from 'react'
import { DEPARTMENTS, ENTRY_TYPES } from '@/lib/constants'
import { useAppData } from '@/hooks/useAppData'
import { ChevronDown, ChevronUp, Trash2, ExternalLink, Paperclip } from 'lucide-react'

export default function BrowsePage() {
  const { entries, deleteEntry: removeEntry } = useAppData()
  const [search, setSearch]           = useState('')
  const [filterDept, setFilterDept]   = useState('')
  const [filterType, setFilterType]   = useState('')
  const [filterPriority, setFilterPriority] = useState('')
  const [expanded, setExpanded]       = useState<string | null>(null)

  const filtered = useMemo(() => {
    let r = entries
    if (filterDept)     r = r.filter(e => e.dept === filterDept)
    if (filterType)     r = r.filter(e => e.type === filterType)
    if (filterPriority) r = r.filter(e => e.priority === filterPriority)
    if (search.trim()) {
      const q = search.toLowerCase()
      r = r.filter(e =>
        e.title?.toLowerCase().includes(q) ||
        e.body?.toLowerCase().includes(q)
      )
    }
    return r
  }, [entries, filterDept, filterType, filterPriority, search])

  const deleteEntry = useCallback(async (id: string) => {
    if (!confirm('Delete this entry?')) return
    await removeEntry(id)
  }, [removeEntry])

  const priorityColor: Record<string, string> = {
    'Normal': 'bg-muted text-muted-foreground',
    'High': 'bg-orange-50 text-orange-700',
    'Key highlight': 'bg-amber-50 text-amber-700',
  }

  return (
    <div className="animate-fade-in">
      <div className="mb-6">
        <h1 className="text-2xl font-serif text-foreground">Browse entries</h1>
        <p className="text-sm text-muted-foreground mt-1">{filtered.length} entries</p>
      </div>

      <div className="hub-card mb-6">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <input className="hub-input" placeholder="Search..." value={search}
            onChange={e => setSearch(e.target.value)} />
          <select className="hub-input" value={filterDept} onChange={e => setFilterDept(e.target.value)}>
            <option value="">All departments</option>
            {DEPARTMENTS.map(d => <option key={d}>{d}</option>)}
          </select>
          <select className="hub-input" value={filterType} onChange={e => setFilterType(e.target.value)}>
            <option value="">All types</option>
            {ENTRY_TYPES.map(t => <option key={t}>{t}</option>)}
          </select>
          <select className="hub-input" value={filterPriority} onChange={e => setFilterPriority(e.target.value)}>
            <option value="">All priorities</option>
            <option>Normal</option><option>High</option><option>Key highlight</option>
          </select>
        </div>
      </div>

      {!filtered.length && (
        <p className="text-sm text-muted-foreground py-8 text-center">No entries found.</p>
      )}

      <div className="space-y-3">
        {filtered.map(e => (
          <div key={e.id} className="hub-card">
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1 min-w-0">
                <p className="font-medium text-foreground text-sm">{e.title}</p>
                <div className="flex flex-wrap gap-1.5 mt-2">
                  <span className="hub-badge bg-blue-50 text-blue-700">{e.dept}</span>
                  <span className="hub-badge bg-green-50 text-green-700">{e.type}</span>
                  <span className={`hub-badge ${priorityColor[e.priority]}`}>{e.priority}</span>
                  {(e.attachments || []).length > 0 && (
                    <span className="hub-badge bg-purple-50 text-purple-700 flex items-center gap-1">
                      <Paperclip className="w-3 h-3" />
                      {e.attachments.length}
                    </span>
                  )}
                  <span className="text-xs text-muted-foreground self-center">{e.entry_date}</span>
                </div>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <button onClick={() => setExpanded(expanded === e.id ? null : e.id)}
                  className="p-2 rounded-lg text-muted-foreground hover:bg-accent transition-colors">
                  {expanded === e.id ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                </button>
                <button onClick={() => void deleteEntry(e.id)}
                  className="p-2 rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors">
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>

            {expanded === e.id && (
              <div className="mt-4 pt-4 border-t border-border space-y-3 animate-fade-in">
                <p className="text-sm text-foreground/80 whitespace-pre-wrap leading-relaxed">{e.body}</p>
                {e.collaborating_org && <p className="text-xs text-muted-foreground"><span className="font-medium">Collaborating org:</span> {e.collaborating_org}</p>}
                {e.student_count && <p className="text-xs text-muted-foreground"><span className="font-medium">Students involved:</span> {e.student_count}</p>}
                {e.academic_year && <p className="text-xs text-muted-foreground"><span className="font-medium">Academic year:</span> {e.academic_year}</p>}
                {e.external_link && (
                  <a href={e.external_link} target="_blank" rel="noreferrer"
                    className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
                    <ExternalLink className="w-3 h-3" /> {e.external_link}
                  </a>
                )}
                {(e.tags || []).length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {e.tags.map((t: string) => <span key={t} className="text-xs text-muted-foreground">#{t}</span>)}
                  </div>
                )}
                <p className="text-xs text-muted-foreground">Added by {e.author_name || 'Unknown'}</p>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
