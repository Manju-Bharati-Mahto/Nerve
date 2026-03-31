import { useState, useMemo } from 'react'
import { useAuth } from '@/hooks/useAuth'
import { useAppData } from '@/hooks/useAppData'
import { CONTENT_TYPES, DEPARTMENTS } from '@/lib/constants'
import { FileText, Search, BookOpen, PlusCircle, MessageSquare, Newspaper, Download } from 'lucide-react'
import { Link } from 'react-router-dom'

export default function ContentUserDashboard() {
  const { profile } = useAuth()
  const { entries: allEntries } = useAppData()
  const [search, setSearch] = useState('')
  const [type, setType]     = useState('')
  const [dept, setDept]     = useState('')

  const contentEntries = useMemo(
    () => allEntries.filter(e => (CONTENT_TYPES as readonly string[]).includes(e.type)),
    [allEntries]
  )

  const filtered = useMemo(() => {
    let r = contentEntries
    if (type) r = r.filter(e => e.type === type)
    if (dept) r = r.filter(e => e.dept === dept)
    if (search.trim()) {
      const q = search.toLowerCase()
      r = r.filter(e => e.title?.toLowerCase().includes(q) || e.body?.toLowerCase().includes(q))
    }
    return r
  }, [contentEntries, type, dept, search])

  const researchHighlights = useMemo(
    () => contentEntries.filter(e => e.type === 'Research' && e.priority === 'Key highlight').slice(0, 3),
    [contentEntries]
  )

  const tools = [
    { to: '/add',           icon: PlusCircle,    label: 'Add Entry',    desc: 'Log a content update',     accent: 'bg-blue-50 text-blue-700 hover:bg-blue-100' },
    { to: '/browse',        icon: Search,        label: 'Browse',       desc: 'Search all content',       accent: 'bg-muted text-foreground hover:bg-accent' },
    { to: '/ai/query',      icon: MessageSquare, label: 'Ask AI',       desc: 'Query the knowledge base', accent: 'bg-violet-50 text-violet-700 hover:bg-violet-100' },
    { to: '/ai/newsletter', icon: Newspaper,     label: 'Newsletter',   desc: 'Generate AI newsletter',   accent: 'bg-teal-50 text-teal-700 hover:bg-teal-100' },
    { to: '/admin/export',  icon: Download,      label: 'Export',       desc: 'Download content data',    accent: 'bg-amber-50 text-amber-700 hover:bg-amber-100' },
  ]

  return (
    <div className="animate-fade-in space-y-6">

      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-blue-100 flex items-center justify-center">
            <FileText className="w-5 h-5 text-blue-600" />
          </div>
          <div>
            <h1 className="text-2xl font-serif text-foreground">
              Welcome{profile?.full_name ? `, ${profile.full_name}` : ''}
            </h1>
            <p className="text-sm text-muted-foreground">Content Team · Research, Programs & Updates</p>
          </div>
        </div>
      </div>

      {/* Tools strip */}
      <div className="grid grid-cols-5 gap-3">
        {tools.map(({ to, icon: Icon, label, desc, accent }) => (
          <Link key={to} to={to}
            className={`flex flex-col items-center gap-2 p-4 rounded-xl border border-border text-center transition-colors ${accent}`}>
            <Icon className="w-5 h-5" />
            <div>
              <p className="text-sm font-semibold leading-tight">{label}</p>
              <p className="text-[11px] text-muted-foreground mt-0.5 leading-tight">{desc}</p>
            </div>
          </Link>
        ))}
      </div>

      {/* Research highlights */}
      {!search && !type && !dept && researchHighlights.length > 0 && (
        <div className="hub-card">
          <div className="flex items-center gap-2 mb-3">
            <BookOpen className="w-4 h-4 text-blue-500" />
            <h2 className="text-sm font-semibold text-foreground">Research highlights</h2>
          </div>
          <div className="space-y-2">
            {researchHighlights.map(e => (
              <div key={e.id} className="flex items-start gap-3 p-3 rounded-lg bg-blue-50 border border-blue-100">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-foreground">{e.title}</p>
                  <div className="flex gap-1.5 mt-1 flex-wrap">
                    <span className="hub-badge bg-blue-100 text-blue-700">{e.dept}</span>
                    {e.collaborating_org && (
                      <span className="hub-badge bg-blue-50 text-blue-600">+ {e.collaborating_org}</span>
                    )}
                  </div>
                </div>
                <span className="text-xs text-muted-foreground shrink-0">{e.entry_date}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Search & filter */}
      <div className="hub-card space-y-3">
        <div className="flex gap-3 flex-wrap">
          <div className="relative flex-1 min-w-48">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
            <input className="hub-input pl-9" placeholder="Search content entries..."
              value={search} onChange={e => setSearch(e.target.value)} />
          </div>
          <select className="hub-input w-44 shrink-0" value={type} onChange={e => setType(e.target.value)}>
            <option value="">All types</option>
            {CONTENT_TYPES.map(t => <option key={t}>{t}</option>)}
          </select>
          <select className="hub-input w-44 shrink-0" value={dept} onChange={e => setDept(e.target.value)}>
            <option value="">All departments</option>
            {DEPARTMENTS.map(d => <option key={d}>{d}</option>)}
          </select>
        </div>
        <p className="text-xs text-muted-foreground">{filtered.length} entries</p>
      </div>

      {/* Entry list */}
      <div className="hub-card">
        {filtered.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-8">No entries match your search.</p>
        ) : (
          <div className="grid grid-cols-2 gap-x-6">
            {filtered.slice(0, 20).map(e => (
              <div key={e.id} className="flex items-start justify-between gap-4 py-3 border-b border-border last:border-0">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-foreground truncate">{e.title}</p>
                  {e.body && <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">{e.body}</p>}
                  <div className="flex gap-1.5 mt-1.5 flex-wrap">
                    <span className="hub-badge bg-blue-50 text-blue-700">{e.type}</span>
                    <span className="hub-badge bg-primary/5 text-primary/70">{e.dept}</span>
                    {e.priority !== 'Normal' && (
                      <span className="hub-badge bg-amber-50 text-amber-700">{e.priority}</span>
                    )}
                  </div>
                </div>
                <span className="text-xs text-muted-foreground shrink-0 pt-0.5">{e.entry_date}</span>
              </div>
            ))}
          </div>
        )}
      </div>

    </div>
  )
}
