import { useState, useEffect, useCallback, useMemo } from 'react'
import { useAuth } from '@/hooks/useAuth'
import { useAppData } from '@/hooks/useAppData'
import { brandingApi } from '@/lib/branding-api'
import { MONTHS, timeToHours } from '@/lib/branding-types'
import type {
  WorkCategory, DailyReport, KraParameter, KraReport,
  AdminKraScore, PeerMarking,
} from '@/lib/branding-types'
import {
  Palette, BarChart2, Award, Settings2, Plus, Trash2, Edit3,
  ChevronDown, ChevronUp, Check, AlertTriangle, Lock,
  Download, Users, Filter, ToggleLeft, ToggleRight, X,
  ArrowUp, ArrowDown,
} from 'lucide-react'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  CartesianGrid, Legend,
} from 'recharts'
import { toast } from 'sonner'

// ── Helpers ────────────────────────────────────────────────────────────────

const INP = 'w-full text-sm px-3 py-2 rounded-lg border border-border bg-background focus:outline-none focus:ring-2 focus:ring-pink-300 transition-all'
const SEL = 'text-sm px-3 py-2 rounded-lg border border-border bg-background focus:outline-none focus:ring-2 focus:ring-pink-300 transition-all cursor-pointer'

function scoreAvg(scores: Record<string, number> | null | undefined, params: KraParameter[]): number | null {
  if (!scores || params.length === 0) return null
  const vals = params.map(p => scores[p.id]).filter(v => v !== undefined) as number[]
  if (vals.length === 0) return null
  return Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10
}

// ── Manage Categories Tab ─────────────────────────────────────────────────

function ManageCategoriesTab() {
  const [categories, setCategories] = useState<WorkCategory[]>([])
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [editingCat, setEditingCat] = useState<{ id: string; name: string } | null>(null)
  const [editingSub, setEditingSub] = useState<{ id: string; name: string } | null>(null)
  const [newCatName, setNewCatName] = useState('')
  const [newSubName, setNewSubName] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)

  const load = useCallback(() => {
    setLoading(true)
    brandingApi.getCategories()
      .then(r => setCategories(r.categories))
      .catch(() => toast.error('Failed to load categories'))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { load() }, [load])

  async function addCategory() {
    const name = newCatName.trim()
    if (!name) return
    try {
      await brandingApi.createCategory(name)
      setNewCatName('')
      load()
      toast.success('Category added')
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed') }
  }

  async function saveCategory(id: string, name: string) {
    try {
      await brandingApi.updateCategory(id, name)
      setEditingCat(null)
      load()
      toast.success('Category updated')
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed') }
  }

  async function deleteCategory(id: string, name: string) {
    if (!confirm(`Delete category "${name}"? Historical report data using this category will be preserved but it will not appear in new reports.`)) return
    try {
      await brandingApi.deleteCategory(id)
      load()
      toast.success('Category deleted')
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed') }
  }

  async function addSubCategory(catId: string) {
    const name = (newSubName[catId] || '').trim()
    if (!name) return
    try {
      await brandingApi.createSubCategory(catId, name)
      setNewSubName(p => ({ ...p, [catId]: '' }))
      load()
      toast.success('Sub-category added')
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed') }
  }

  async function saveSubCategory(id: string, name: string) {
    try {
      await brandingApi.updateSubCategory(id, name)
      setEditingSub(null)
      load()
      toast.success('Updated')
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed') }
  }

  async function deleteSubCategory(id: string, name: string) {
    if (!confirm(`Delete sub-category "${name}"?`)) return
    try {
      await brandingApi.deleteSubCategory(id)
      load()
      toast.success('Deleted')
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed') }
  }

  async function moveCategory(id: string, dir: 'up' | 'down') {
    const idx = categories.findIndex(c => c.id === id)
    if (idx < 0) return
    const newOrder = [...categories]
    const swapIdx = dir === 'up' ? idx - 1 : idx + 1
    if (swapIdx < 0 || swapIdx >= newOrder.length) return
    ;[newOrder[idx], newOrder[swapIdx]] = [newOrder[swapIdx], newOrder[idx]]
    setCategories(newOrder)
    await brandingApi.reorderCategories(newOrder.map(c => c.id))
  }

  if (loading) return <p className="text-sm text-muted-foreground text-center py-10 animate-pulse">Loading categories…</p>

  return (
    <div className="space-y-5">
      <div className="hub-card">
        <h2 className="text-sm font-semibold text-foreground mb-4">Add New Category</h2>
        <div className="flex gap-2">
          <input value={newCatName} onChange={e => setNewCatName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') void addCategory() }}
            placeholder="Category name…" className={INP + ' flex-1'} />
          <button onClick={() => void addCategory()}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-pink-600 text-white text-sm font-medium hover:bg-pink-700 transition-colors">
            <Plus className="w-4 h-4" /> Add
          </button>
        </div>
        <p className="text-xs text-muted-foreground mt-2">
          A default "Others" sub-category is automatically added to every new category.
        </p>
      </div>

      <div className="space-y-3">
        {categories.length === 0 && (
          <p className="text-sm text-muted-foreground text-center py-6">No categories yet.</p>
        )}
        {categories.map((cat, catIdx) => (
          <div key={cat.id} className="hub-card p-0 overflow-hidden border border-border">
            {/* Category header */}
            <div className="flex items-center gap-3 px-4 py-3 bg-pink-50/40 border-b border-border">
              <div className="flex items-center gap-1">
                <button onClick={() => void moveCategory(cat.id, 'up')} disabled={catIdx === 0}
                  className="p-1 rounded hover:bg-pink-100 disabled:opacity-30 transition-colors">
                  <ArrowUp className="w-3.5 h-3.5 text-muted-foreground" />
                </button>
                <button onClick={() => void moveCategory(cat.id, 'down')} disabled={catIdx === categories.length - 1}
                  className="p-1 rounded hover:bg-pink-100 disabled:opacity-30 transition-colors">
                  <ArrowDown className="w-3.5 h-3.5 text-muted-foreground" />
                </button>
              </div>

              {editingCat?.id === cat.id ? (
                <div className="flex items-center gap-2 flex-1">
                  <input value={editingCat.name}
                    onChange={e => setEditingCat(p => p ? { ...p, name: e.target.value } : p)}
                    onKeyDown={e => { if (e.key === 'Enter') void saveCategory(cat.id, editingCat.name) }}
                    className={INP + ' flex-1 py-1'} autoFocus />
                  <button onClick={() => void saveCategory(cat.id, editingCat.name)}
                    className="p-1.5 rounded-lg bg-green-100 text-green-700 hover:bg-green-200">
                    <Check className="w-3.5 h-3.5" />
                  </button>
                  <button onClick={() => setEditingCat(null)}
                    className="p-1.5 rounded-lg bg-muted text-muted-foreground hover:bg-accent">
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              ) : (
                <span className="text-sm font-semibold text-foreground flex-1">{cat.name}</span>
              )}

              <div className="flex items-center gap-1 shrink-0">
                <button onClick={() => setExpanded(p => { const s = new Set(p); s.has(cat.id) ? s.delete(cat.id) : s.add(cat.id); return s })}
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs text-muted-foreground hover:text-foreground hover:bg-accent transition-colors">
                  {cat.sub_categories.length} subs
                  {expanded.has(cat.id) ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                </button>
                {editingCat?.id !== cat.id && (
                  <button onClick={() => setEditingCat({ id: cat.id, name: cat.name })}
                    className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent transition-colors">
                    <Edit3 className="w-3.5 h-3.5" />
                  </button>
                )}
                <button onClick={() => void deleteCategory(cat.id, cat.name)}
                  className="p-1.5 rounded-lg text-muted-foreground hover:text-destructive hover:bg-red-50 transition-colors">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            {/* Sub-categories */}
            {expanded.has(cat.id) && (
              <div className="p-3 space-y-1">
                {cat.sub_categories.map(sub => (
                  <div key={sub.id} className="flex items-center gap-2 py-1 px-2 rounded-lg hover:bg-muted/30 group">
                    {editingSub?.id === sub.id ? (
                      <div className="flex items-center gap-2 flex-1">
                        <input value={editingSub.name}
                          onChange={e => setEditingSub(p => p ? { ...p, name: e.target.value } : p)}
                          onKeyDown={e => { if (e.key === 'Enter') void saveSubCategory(sub.id, editingSub.name) }}
                          className={INP + ' flex-1 py-1 text-xs'} autoFocus />
                        <button onClick={() => void saveSubCategory(sub.id, editingSub.name)}
                          className="p-1 rounded bg-green-100 text-green-700">
                          <Check className="w-3 h-3" />
                        </button>
                        <button onClick={() => setEditingSub(null)}
                          className="p-1 rounded bg-muted text-muted-foreground">
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    ) : (
                      <>
                        <span className="text-sm text-foreground flex-1">{sub.name}</span>
                        {sub.is_others ? (
                          <span className="text-[10px] text-muted-foreground bg-muted px-2 py-0.5 rounded-full">default · protected</span>
                        ) : (
                          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                            <button onClick={() => setEditingSub({ id: sub.id, name: sub.name })}
                              className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent">
                              <Edit3 className="w-3 h-3" />
                            </button>
                            <button onClick={() => void deleteSubCategory(sub.id, sub.name)}
                              className="p-1 rounded text-muted-foreground hover:text-destructive hover:bg-red-50">
                              <Trash2 className="w-3 h-3" />
                            </button>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                ))}

                {/* Add sub-category */}
                {cat.name !== 'Others' && (
                  <div className="flex gap-2 mt-2 pt-2 border-t border-border/50">
                    <input
                      value={newSubName[cat.id] || ''}
                      onChange={e => setNewSubName(p => ({ ...p, [cat.id]: e.target.value }))}
                      onKeyDown={e => { if (e.key === 'Enter') void addSubCategory(cat.id) }}
                      placeholder="New sub-category name…"
                      className={INP + ' flex-1 py-1 text-xs'} />
                    <button onClick={() => void addSubCategory(cat.id)}
                      className="flex items-center gap-1 px-3 py-1 rounded-lg bg-pink-50 text-pink-700 text-xs font-medium hover:bg-pink-100">
                      <Plus className="w-3.5 h-3.5" /> Add
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Daily Reports Tab ──────────────────────────────────────────────────────

function DailyReportsTab({ brandingUsers }: { brandingUsers: { id: string; full_name: string; email: string }[] }) {
  const [reports, setReports] = useState<DailyReport[]>([])
  const [loading, setLoading] = useState(false)
  const [filters, setFilters] = useState({
    userId: '', dateFrom: '', dateTo: '', typeOfWork: '', subCategory: '', lockedOnly: false,
  })
  const [categories, setCategories] = useState<WorkCategory[]>([])
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [viewMode, setViewMode] = useState<'all' | 'user' | 'category' | 'summary' | 'collab'>('all')

  useEffect(() => {
    brandingApi.getCategories().then(r => setCategories(r.categories)).catch(() => {})
  }, [])

  const loadReports = useCallback(() => {
    setLoading(true)
    brandingApi.getAllReports({
      userId:      filters.userId      || undefined,
      dateFrom:    filters.dateFrom    || undefined,
      dateTo:      filters.dateTo      || undefined,
      typeOfWork:  filters.typeOfWork  || undefined,
      subCategory: filters.subCategory || undefined,
      lockedOnly:  filters.lockedOnly  || undefined,
    })
      .then(r => setReports(r.reports))
      .catch(() => toast.error('Failed to load reports'))
      .finally(() => setLoading(false))
  }, [filters])

  useEffect(() => { loadReports() }, [loadReports])

  // Derived aggregates for summary view
  const summaryData = useMemo(() => {
    const map: Record<string, { name: string; hours: number; rows: number }> = {}
    for (const r of reports) {
      const uid = r.user_id
      if (!map[uid]) map[uid] = { name: r.user_name || uid, hours: 0, rows: 0 }
      for (const row of r.rows) {
        map[uid].hours += timeToHours(row.time_taken)
        map[uid].rows += 1
      }
    }
    return Object.values(map).sort((a, b) => b.hours - a.hours)
  }, [reports])

  const categoryData = useMemo(() => {
    const map: Record<string, number> = {}
    for (const r of reports)
      for (const row of r.rows)
        map[row.type_of_work] = (map[row.type_of_work] || 0) + timeToHours(row.time_taken)
    return Object.entries(map).map(([name, hours]) => ({ name, hours: Math.round(hours * 10) / 10 }))
      .sort((a, b) => b.hours - a.hours)
  }, [reports])

  const collabMatrix = useMemo(() => {
    const map: Record<string, Record<string, number>> = {}
    for (const r of reports) {
      const name = r.user_name || r.user_id
      for (const row of r.rows) {
        for (const c of row.collaborative_colleagues) {
          if (!map[name]) map[name] = {}
          map[name][c] = (map[name][c] || 0) + 1
        }
      }
    }
    return map
  }, [reports])

  function exportCSV() {
    const rows: string[][] = [['Date', 'User', 'Sr', 'Type of Work', 'Sub Category', 'Specific Work', 'Time Taken', 'Collaborators']]
    for (const r of reports)
      for (const row of r.rows)
        rows.push([r.report_date, r.user_name || '', String(row.sr_no), row.type_of_work, row.sub_category, row.specific_work, row.time_taken, row.collaborative_colleagues.join('; ')])
    const csv = rows.map(r => r.map(c => `"${c.replace(/"/g, '""')}"`).join(',')).join('\n')
    const a = document.createElement('a')
    a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv)
    a.download = `branding-reports-${new Date().toISOString().split('T')[0]}.csv`
    a.click()
    toast.success('CSV downloaded')
  }

  const subCatOptions = categories.find(c => c.name === filters.typeOfWork)?.sub_categories || []

  return (
    <div className="space-y-5">
      {/* Filters */}
      <div className="hub-card space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
            <Filter className="w-4 h-4 text-muted-foreground" /> Filters
          </h2>
          <button onClick={() => setFilters({ userId: '', dateFrom: '', dateTo: '', typeOfWork: '', subCategory: '', lockedOnly: false })}
            className="text-xs text-muted-foreground hover:text-foreground">Reset all</button>
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
          <div>
            <label className="text-xs text-muted-foreground block mb-1">User / Designer</label>
            <select value={filters.userId} onChange={e => setFilters(p => ({ ...p, userId: e.target.value }))} className={SEL + ' w-full'}>
              <option value="">All users</option>
              {brandingUsers.map(u => <option key={u.id} value={u.id}>{u.full_name || u.email}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs text-muted-foreground block mb-1">Date From</label>
            <input type="date" value={filters.dateFrom} onChange={e => setFilters(p => ({ ...p, dateFrom: e.target.value }))} className={INP} />
          </div>
          <div>
            <label className="text-xs text-muted-foreground block mb-1">Date To</label>
            <input type="date" value={filters.dateTo} onChange={e => setFilters(p => ({ ...p, dateTo: e.target.value }))} className={INP} />
          </div>
          <div>
            <label className="text-xs text-muted-foreground block mb-1">Type of Work</label>
            <select value={filters.typeOfWork} onChange={e => setFilters(p => ({ ...p, typeOfWork: e.target.value, subCategory: '' }))} className={SEL + ' w-full'}>
              <option value="">All types</option>
              {categories.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
            </select>
          </div>
          {filters.typeOfWork && (
            <div>
              <label className="text-xs text-muted-foreground block mb-1">Sub Category</label>
              <select value={filters.subCategory} onChange={e => setFilters(p => ({ ...p, subCategory: e.target.value }))} className={SEL + ' w-full'}>
                <option value="">All sub-categories</option>
                {subCatOptions.map(s => <option key={s.id} value={s.name}>{s.name}</option>)}
              </select>
            </div>
          )}
          <div className="flex items-center gap-2 mt-4">
            <input type="checkbox" id="lockedOnly" checked={filters.lockedOnly}
              onChange={e => setFilters(p => ({ ...p, lockedOnly: e.target.checked }))}
              className="accent-pink-500 w-4 h-4" />
            <label htmlFor="lockedOnly" className="text-sm text-muted-foreground cursor-pointer">Submitted only</label>
          </div>
        </div>
      </div>

      {/* View mode + export */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex gap-1 bg-muted/40 p-1 rounded-xl">
          {[
            { key: 'all', label: 'All Reports' },
            { key: 'summary', label: 'Team Summary' },
            { key: 'category', label: 'By Category' },
            { key: 'collab', label: 'Collaboration' },
          ].map(v => (
            <button key={v.key} onClick={() => setViewMode(v.key as typeof viewMode)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${viewMode === v.key ? 'bg-white text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>
              {v.label}
            </button>
          ))}
        </div>
        <button onClick={exportCSV}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-muted text-muted-foreground text-xs font-medium hover:bg-accent transition-colors">
          <Download className="w-3.5 h-3.5" /> Export CSV
        </button>
      </div>

      {loading && <p className="text-sm text-muted-foreground text-center py-10 animate-pulse">Loading…</p>}

      {!loading && (
        <>
          {/* All Reports */}
          {viewMode === 'all' && (
            <div className="space-y-3">
              {reports.length === 0 && <p className="text-sm text-muted-foreground text-center py-8">No reports found.</p>}
              {reports.map(r => (
                <div key={r.id} className="hub-card p-0 overflow-hidden border border-border">
                  <div className="flex items-center gap-3 px-4 py-3 bg-muted/20 border-b border-border cursor-pointer"
                    onClick={() => setExpanded(p => { const s = new Set(p); s.has(r.id) ? s.delete(r.id) : s.add(r.id); return s })}>
                    <div className="w-8 h-8 rounded-full bg-pink-100 flex items-center justify-center shrink-0">
                      <span className="text-xs font-semibold text-pink-700">
                        {(r.user_name || '?')[0].toUpperCase()}
                      </span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-foreground">{r.user_name || r.user_email || r.user_id}</p>
                      <p className="text-xs text-muted-foreground">{r.report_date} · {r.rows.length} row{r.rows.length !== 1 ? 's' : ''} · {Math.round(r.rows.reduce((s, rw) => s + timeToHours(rw.time_taken), 0) * 10) / 10}h total</p>
                    </div>
                    {r.is_locked
                      ? <span className="text-[10px] bg-green-50 text-green-700 font-medium px-2 py-0.5 rounded-full shrink-0">Submitted</span>
                      : <span className="text-[10px] bg-amber-50 text-amber-700 font-medium px-2 py-0.5 rounded-full shrink-0">Draft</span>}
                    {expanded.has(r.id) ? <ChevronUp className="w-4 h-4 text-muted-foreground shrink-0" /> : <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />}
                  </div>
                  {expanded.has(r.id) && (
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs border-collapse min-w-[700px]">
                        <thead>
                          <tr className="bg-muted/10 border-b border-border">
                            {['Sr', 'Type of Work', 'Sub Category', 'Specific Work', 'Time Taken', 'Collaborators'].map(h => (
                              <th key={h} className="text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground px-3 py-2">{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {r.rows.map(row => (
                            <tr key={row.id} className="border-b border-border/50 last:border-0 hover:bg-muted/10">
                              <td className="px-3 py-1.5 text-muted-foreground text-center">{row.sr_no}</td>
                              <td className="px-3 py-1.5">{row.type_of_work}</td>
                              <td className="px-3 py-1.5 text-muted-foreground">{row.sub_category || '—'}</td>
                              <td className="px-3 py-1.5">{row.specific_work}</td>
                              <td className="px-3 py-1.5 text-pink-600 font-medium">{row.time_taken}</td>
                              <td className="px-3 py-1.5 text-muted-foreground">{row.collaborative_colleagues.join(', ') || '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Team Summary */}
          {viewMode === 'summary' && (
            <div className="space-y-4">
              <div className="hub-card overflow-x-auto">
                <h3 className="text-sm font-semibold text-foreground mb-3">Team Output Summary</h3>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="text-left pb-2 pr-4 text-xs font-semibold text-muted-foreground">Team Member</th>
                      <th className="text-right pb-2 pr-4 text-xs font-semibold text-muted-foreground">Total Hours</th>
                      <th className="text-right pb-2 text-xs font-semibold text-muted-foreground">Total Rows</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summaryData.map(d => (
                      <tr key={d.name} className="border-b border-border/50 last:border-0">
                        <td className="py-2 pr-4 font-medium">{d.name}</td>
                        <td className="py-2 pr-4 text-right text-pink-600 font-medium">{Math.round(d.hours * 10) / 10}h</td>
                        <td className="py-2 text-right text-muted-foreground">{d.rows}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="hub-card">
                <h3 className="text-sm font-semibold text-foreground mb-3">Hours by Member</h3>
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={summaryData.slice(0, 10)} margin={{ top: 4, right: 0, left: -20, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                    <XAxis dataKey="name" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
                    <YAxis tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
                    <Tooltip />
                    <Bar dataKey="hours" fill="#ec4899" radius={[4, 4, 0, 0]} maxBarSize={40} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {/* Category */}
          {viewMode === 'category' && (
            <div className="hub-card">
              <h3 className="text-sm font-semibold text-foreground mb-3">Hours by Work Category</h3>
              {categoryData.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-6">No data.</p>
              ) : (
                <>
                  <ResponsiveContainer width="100%" height={240}>
                    <BarChart data={categoryData} layout="vertical" margin={{ top: 4, right: 20, left: 120, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" horizontal={false} />
                      <XAxis type="number" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
                      <YAxis type="category" dataKey="name" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} width={115} />
                      <Tooltip formatter={(v: number) => [`${v} hrs`, 'Hours']} />
                      <Bar dataKey="hours" fill="#8b5cf6" radius={[0, 4, 4, 0]} maxBarSize={24} />
                    </BarChart>
                  </ResponsiveContainer>
                </>
              )}
            </div>
          )}

          {/* Collaboration Matrix */}
          {viewMode === 'collab' && (
            <div className="hub-card overflow-x-auto">
              <h3 className="text-sm font-semibold text-foreground mb-3">Collaboration Map</h3>
              {Object.keys(collabMatrix).length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-6">No collaboration data.</p>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="text-left pb-2 pr-4 text-xs font-semibold text-muted-foreground">Member</th>
                      <th className="text-left pb-2 text-xs font-semibold text-muted-foreground">Collaborated With</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(collabMatrix).map(([name, collabs]) => (
                      <tr key={name} className="border-b border-border/50 last:border-0">
                        <td className="py-2 pr-4 font-medium align-top">{name}</td>
                        <td className="py-2">
                          <div className="flex flex-wrap gap-1.5">
                            {Object.entries(collabs).sort((a, b) => b[1] - a[1]).map(([c, cnt]) => (
                              <span key={c} className="text-xs bg-pink-50 text-pink-700 px-2 py-0.5 rounded-full">{c} ×{cnt}</span>
                            ))}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ── KRA Management Tab ─────────────────────────────────────────────────────

function KraManagementTab({ brandingUsers }: { brandingUsers: { id: string; full_name: string; email: string }[] }) {
  const { profile } = useAuth()
  const [month, setMonth] = useState(new Date().getMonth() + 1)
  const [year, setYear]   = useState(new Date().getFullYear())
  const [dashboard, setDashboard]     = useState<KraReport[]>([])
  const [params, setParams]           = useState<KraParameter[]>([])
  const [peerEnabled, setPeerEnabled] = useState(false)
  const [selectedUser, setSelectedUser] = useState<string | null>(null)
  const [adminScores, setAdminScores] = useState<Record<string, number>>({})
  const [adminSaving, setAdminSaving] = useState(false)
  const [loading, setLoading]         = useState(false)
  const [finalPushState, setFinalPushState] = useState<'idle' | 'confirm1' | 'confirm2'>('idle')
  const [peerMarkings, setPeerMarkings] = useState<PeerMarking[]>([])
  const [showPeerMarkings, setShowPeerMarkings] = useState(false)

  const load = useCallback(() => {
    setLoading(true)
    Promise.all([
      brandingApi.getAdminKraDashboard(month, year),
      brandingApi.getKraParameters(),
      brandingApi.getPeerMarkingEnabled(),
    ])
      .then(([d, p, e]) => {
        setDashboard(d.dashboard)
        setParams(p.parameters)
        setPeerEnabled(e.enabled)
      })
      .catch(() => toast.error('Failed to load KRA data'))
      .finally(() => setLoading(false))
  }, [month, year])

  useEffect(() => { load() }, [load])

  // Load admin scores when selecting a user
  useEffect(() => {
    if (!selectedUser) return
    brandingApi.getAdminScore(selectedUser, month, year)
      .then(r => setAdminScores(r.score?.scores || Object.fromEntries(params.map(p => [p.id, 5]))))
      .catch(() => {})
  }, [selectedUser, month, year, params])

  async function togglePeer(enabled: boolean) {
    try {
      await brandingApi.togglePeerMarking(enabled)
      setPeerEnabled(enabled)
      toast.success(enabled ? 'Peer marking enabled' : 'Peer marking disabled')
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed') }
  }

  async function saveAdminScore() {
    if (!selectedUser) return
    setAdminSaving(true)
    try {
      await brandingApi.setAdminScore(selectedUser, month, year, adminScores)
      load()
      toast.success('Admin score saved')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed')
    } finally {
      setAdminSaving(false)
    }
  }

  async function doFinalPush() {
    if (!selectedUser) return
    try {
      await brandingApi.finalPush(selectedUser, month, year)
      setFinalPushState('idle')
      setSelectedUser(null)
      load()
      toast.success('KRA Final Push completed! User can now download their report.')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed')
      setFinalPushState('idle')
    }
  }

  async function loadPeerMarkings() {
    brandingApi.getAllPeerMarkings(month, year)
      .then(r => { setPeerMarkings(r.markings); setShowPeerMarkings(true) })
      .catch(() => toast.error('Failed to load peer markings'))
  }

  const selectedReport = dashboard.find(r => r.user_id === selectedUser)

  function downloadKraCsv() {
    const rows: string[][] = [['User', 'Self Score', 'Peer Score', 'Admin Score', 'Final Score', 'Status']]
    for (const r of dashboard) {
      const self  = scoreAvg(r.self_appraisal?.scores || null, params)
      const peer  = scoreAvg(r.peer_average, params)
      const admin = scoreAvg(r.admin_score?.scores || null, params)
      rows.push([r.user_name, self?.toFixed(1) ?? '—', peer?.toFixed(1) ?? '—', admin?.toFixed(1) ?? '—', r.composite_score?.toFixed(1) ?? '—', r.is_final_pushed ? 'Published' : 'Pending'])
    }
    const csv = rows.map(r => r.map(c => `"${c}"`).join(',')).join('\n')
    const a = document.createElement('a')
    a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv)
    a.download = `kra-${MONTHS[month - 1]}-${year}.csv`
    a.click()
    toast.success('KRA CSV downloaded')
  }

  return (
    <div className="space-y-5">
      {/* Controls */}
      <div className="hub-card flex items-center justify-between flex-wrap gap-4">
        <div className="flex items-center gap-3">
          <select value={month} onChange={e => setMonth(parseInt(e.target.value))} className={SEL}>
            {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
          </select>
          <select value={year} onChange={e => setYear(parseInt(e.target.value))} className={SEL}>
            {[2024, 2025, 2026, 2027].map(y => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">Peer Marking:</span>
            <button onClick={() => void togglePeer(!peerEnabled)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${peerEnabled ? 'bg-green-100 text-green-700 hover:bg-green-200' : 'bg-muted text-muted-foreground hover:bg-accent'}`}>
              {peerEnabled ? <ToggleRight className="w-4 h-4" /> : <ToggleLeft className="w-4 h-4" />}
              {peerEnabled ? 'Enabled' : 'Disabled'}
            </button>
          </div>
          <button onClick={() => void loadPeerMarkings()}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-muted text-muted-foreground text-xs font-medium hover:bg-accent">
            <Users className="w-3.5 h-3.5" /> View Peer Markings
          </button>
          <button onClick={downloadKraCsv}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-muted text-muted-foreground text-xs font-medium hover:bg-accent">
            <Download className="w-3.5 h-3.5" /> Export CSV
          </button>
        </div>
      </div>

      {loading && <p className="text-sm text-muted-foreground text-center py-10 animate-pulse">Loading KRA data…</p>}

      {!loading && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
          {/* User list */}
          <div className="lg:col-span-1 space-y-2">
            <h3 className="text-sm font-semibold text-foreground">Team Members</h3>
            {dashboard.length === 0 && <p className="text-sm text-muted-foreground py-4">No team members found.</p>}
            {dashboard.map(r => {
              const composite = r.composite_score
              return (
                <button key={r.user_id}
                  onClick={() => { setSelectedUser(r.user_id); setFinalPushState('idle') }}
                  className={`w-full flex items-center gap-3 p-3 rounded-xl border text-left transition-all ${selectedUser === r.user_id ? 'border-pink-400 bg-pink-50/40' : 'border-border hover:border-pink-200 hover:bg-muted/20'}`}>
                  <div className="w-8 h-8 rounded-full bg-pink-100 flex items-center justify-center shrink-0">
                    <span className="text-xs font-semibold text-pink-700">{r.user_name[0]?.toUpperCase()}</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-foreground truncate">{r.user_name}</p>
                    <p className="text-xs text-muted-foreground">
                      {r.self_appraisal ? '✓ Self' : '○ Self'} · {r.peer_count > 0 ? `✓ ${r.peer_count} peers` : '○ Peers'}
                    </p>
                  </div>
                  <div className="text-right shrink-0">
                    {composite !== null && <p className="text-sm font-semibold text-pink-600">{composite}</p>}
                    {r.is_final_pushed
                      ? <p className="text-[10px] text-green-600 font-medium">Published</p>
                      : <p className="text-[10px] text-amber-600 font-medium">Pending</p>}
                  </div>
                </button>
              )
            })}
          </div>

          {/* KRA Detail Panel */}
          <div className="lg:col-span-2">
            {!selectedUser ? (
              <div className="hub-card flex items-center justify-center h-full min-h-[300px] text-sm text-muted-foreground">
                Select a team member to view and edit their KRA
              </div>
            ) : selectedReport && (
              <div className="hub-card space-y-5">
                <div className="flex items-center justify-between">
                  <h3 className="text-base font-semibold text-foreground">{selectedReport.user_name}</h3>
                  <div className="flex items-center gap-2">
                    {selectedReport.is_final_pushed && (
                      <span className="flex items-center gap-1 text-xs text-green-700 bg-green-50 px-3 py-1 rounded-full">
                        <Lock className="w-3 h-3" /> Final Published
                      </span>
                    )}
                  </div>
                </div>

                {/* Score overview */}
                <div className="grid grid-cols-4 gap-2">
                  {[
                    { label: 'Self Score',   value: scoreAvg(selectedReport.self_appraisal?.scores || null, params)?.toFixed(1) ?? '—', bg: 'bg-pink-50 text-pink-700' },
                    { label: 'Peer Score',   value: scoreAvg(selectedReport.peer_average, params)?.toFixed(1) ?? '—', bg: 'bg-blue-50 text-blue-700' },
                    { label: 'Admin Score',  value: scoreAvg(adminScores, params)?.toFixed(1) ?? '—', bg: 'bg-purple-50 text-purple-700' },
                    { label: 'Composite',    value: selectedReport.composite_score?.toFixed(1) ?? '—', bg: 'bg-green-50 text-green-700' },
                  ].map(s => (
                    <div key={s.label} className={`p-3 rounded-xl text-center ${s.bg}`}>
                      <p className="text-xs font-medium opacity-70">{s.label}</p>
                      <p className="text-2xl font-serif mt-0.5">{s.value}<span className="text-xs font-normal opacity-60">/10</span></p>
                    </div>
                  ))}
                </div>

                {/* Admin Scoring */}
                {!selectedReport.is_final_pushed && params.length > 0 && (
                  <div>
                    <h4 className="text-sm font-semibold text-foreground mb-3">Admin Score (Editable)</h4>
                    <div className="space-y-3">
                      {params.map(p => (
                        <div key={p.id} className="flex items-center gap-3">
                          <span className="text-xs text-foreground w-40 shrink-0">{p.name}</span>
                          <input type="range" min={0} max={p.max_score} step={1}
                            value={adminScores[p.id] ?? 5}
                            onChange={e => setAdminScores(prev => ({ ...prev, [p.id]: parseInt(e.target.value) }))}
                            className="flex-1 accent-purple-500" />
                          <span className="text-sm font-semibold text-purple-600 w-8 text-right">
                            {adminScores[p.id] ?? 5}
                          </span>
                        </div>
                      ))}
                    </div>
                    <button onClick={() => void saveAdminScore()} disabled={adminSaving}
                      className="mt-4 w-full py-2 rounded-lg bg-purple-600 text-white text-sm font-medium hover:bg-purple-700 disabled:opacity-50 transition-colors">
                      {adminSaving ? 'Saving…' : 'Save Admin Score'}
                    </button>
                  </div>
                )}

                {/* Final Push */}
                {!selectedReport.is_final_pushed && (
                  <div className="border-t border-border pt-4">
                    {finalPushState === 'idle' && (
                      <button onClick={() => setFinalPushState('confirm1')}
                        className="w-full py-2.5 rounded-lg bg-green-600 text-white text-sm font-medium hover:bg-green-700 transition-colors flex items-center justify-center gap-2">
                        <Check className="w-4 h-4" /> Proceed to Final Push
                      </button>
                    )}
                    {finalPushState === 'confirm1' && (
                      <div className="p-4 bg-amber-50 border border-amber-200 rounded-xl space-y-3">
                        <div className="flex items-start gap-2">
                          <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
                          <div>
                            <p className="text-sm font-semibold text-amber-800">Review all scores before proceeding</p>
                            <p className="text-xs text-amber-700 mt-1">
                              Self: {scoreAvg(selectedReport.self_appraisal?.scores || null, params)?.toFixed(1) ?? '—'} ·
                              Peer: {scoreAvg(selectedReport.peer_average, params)?.toFixed(1) ?? '—'} ·
                              Admin: {scoreAvg(adminScores, params)?.toFixed(1) ?? '—'} ·
                              Composite: {selectedReport.composite_score?.toFixed(1) ?? '—'}
                            </p>
                          </div>
                        </div>
                        <div className="flex gap-3">
                          <button onClick={() => setFinalPushState('confirm2')}
                            className="flex-1 py-2 rounded-lg bg-amber-600 text-white text-sm font-medium hover:bg-amber-700">
                            Proceed to Final Push
                          </button>
                          <button onClick={() => setFinalPushState('idle')}
                            className="px-4 py-2 rounded-lg border border-border text-sm text-muted-foreground hover:bg-accent">
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}
                    {finalPushState === 'confirm2' && (
                      <div className="p-4 bg-red-50 border border-red-200 rounded-xl space-y-3">
                        <div className="flex items-start gap-2">
                          <AlertTriangle className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
                          <div>
                            <p className="text-sm font-semibold text-red-800">FINAL CONFIRMATION — This action is irreversible</p>
                            <p className="text-xs text-red-700 mt-1">
                              Once you click "Yes, I have reviewed and approve this KRA", the KRA for <strong>{selectedReport.user_name}</strong> ({MONTHS[month - 1]} {year}) will be permanently locked and published to the user. No further edits possible.
                            </p>
                          </div>
                        </div>
                        <div className="flex gap-3">
                          <button onClick={() => void doFinalPush()}
                            className="flex-1 py-2 rounded-lg bg-red-600 text-white text-sm font-medium hover:bg-red-700">
                            Yes, I have reviewed and approve this KRA
                          </button>
                          <button onClick={() => setFinalPushState('idle')}
                            className="px-4 py-2 rounded-lg border border-border text-sm text-muted-foreground hover:bg-accent">
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Peer Markings Modal */}
      {showPeerMarkings && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <div className="bg-card border border-border rounded-2xl shadow-xl max-w-2xl w-full max-h-[80vh] flex flex-col">
            <div className="flex items-center justify-between p-4 border-b border-border">
              <h3 className="text-base font-semibold text-foreground">Peer Markings — {MONTHS[month - 1]} {year}</h3>
              <button onClick={() => setShowPeerMarkings(false)} className="p-1 rounded-lg hover:bg-accent">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="overflow-y-auto flex-1 p-4">
              {peerMarkings.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-6">No peer markings for this period.</p>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="text-left pb-2 pr-4 text-xs font-semibold text-muted-foreground">Reviewer</th>
                      <th className="text-left pb-2 pr-4 text-xs font-semibold text-muted-foreground">Reviewee</th>
                      <th className="text-right pb-2 text-xs font-semibold text-muted-foreground">Avg Score</th>
                    </tr>
                  </thead>
                  <tbody>
                    {peerMarkings.map(m => (
                      <tr key={m.id} className="border-b border-border/50 last:border-0">
                        <td className="py-2 pr-4">{m.reviewer_name || m.reviewer_id}</td>
                        <td className="py-2 pr-4">{m.reviewee_name || m.reviewee_id}</td>
                        <td className="py-2 text-right font-medium text-pink-600">
                          {(Object.values(m.scores).reduce((a, b) => a + b, 0) / Math.max(Object.keys(m.scores).length, 1)).toFixed(1)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Main Component ─────────────────────────────────────────────────────────

export default function BrandingAdminDashboard() {
  const { profile } = useAuth()
  const { users } = useAppData()
  const [activeTab, setActiveTab] = useState<'reports' | 'kra' | 'categories'>('reports')

  const brandingUsers = useMemo(() =>
    users.filter(u => u.team === 'branding' && u.role !== 'super_admin')
      .map(u => ({ id: u.id, full_name: u.full_name, email: u.email })),
    [users]
  )

  return (
    <div className="animate-fade-in space-y-5">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-pink-100 flex items-center justify-center shrink-0">
          <Palette className="w-5 h-5 text-pink-600" />
        </div>
        <div>
          <h1 className="text-2xl font-serif text-foreground">Branding Team — Admin</h1>
          <p className="text-sm text-muted-foreground">
            Welcome{profile?.full_name ? `, ${profile.full_name}` : ''} · Full system access
          </p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-muted/40 p-1 rounded-xl w-fit">
        {[
          { key: 'reports',    icon: BarChart2, label: 'Daily Reports' },
          { key: 'kra',        icon: Award,     label: 'KRA Management' },
          { key: 'categories', icon: Settings2, label: 'Manage Categories' },
        ].map(tab => {
          const Icon = tab.icon
          return (
            <button key={tab.key} onClick={() => setActiveTab(tab.key as typeof activeTab)}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                activeTab === tab.key
                  ? 'bg-white text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}>
              <Icon className="w-4 h-4" />
              {tab.label}
            </button>
          )
        })}
      </div>

      {activeTab === 'reports'    && <DailyReportsTab    brandingUsers={brandingUsers} />}
      {activeTab === 'kra'        && <KraManagementTab   brandingUsers={brandingUsers} />}
      {activeTab === 'categories' && <ManageCategoriesTab />}
    </div>
  )
}
