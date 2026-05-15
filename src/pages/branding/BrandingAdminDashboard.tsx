import { useState, useEffect, useCallback, useMemo } from 'react'
import { useLocation } from 'react-router-dom'
import { useAuth } from '@/hooks/useAuth'
import { useAppData } from '@/hooks/useAppData'
import { brandingApi } from '@/lib/branding-api'
import { MONTHS, timeToHours } from '@/lib/branding-types'
import type {
  WorkCategory, DailyReport, KraParameter, KraReport,
  AdminKraScore, PeerMarking, BrandingLeave,
} from '@/lib/branding-types'
import {
  Palette, Plus, Trash2, Edit3,
  ChevronDown, ChevronUp, Check, AlertTriangle, Lock,
  Download, Users, Filter, ToggleLeft, ToggleRight, X,
  ArrowUp, ArrowDown, CalendarOff,
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
                <button onClick={() => setExpanded(p => { const s = new Set(p); if (s.has(cat.id)) s.delete(cat.id); else s.add(cat.id); return s })}
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

function defaultDailyReportFilters() {
  const today = new Date()
  const weekAgo = new Date(today)
  weekAgo.setDate(today.getDate() - 7)
  const fmt = (d: Date) => d.toISOString().split('T')[0]
  return {
    userIds: [] as string[],
    dateFrom: fmt(weekAgo),
    dateTo: fmt(today),
    typeOfWork: '',
    subCategory: '',
    lockedOnly: false,
  }
}

function DailyReportsTab({ brandingUsers }: { brandingUsers: { id: string; full_name: string; email: string }[] }) {
  const [reports, setReports] = useState<DailyReport[]>([])
  const [loading, setLoading] = useState(false)
  const [filters, setFilters] = useState(defaultDailyReportFilters)
  const [userDropOpen, setUserDropOpen] = useState(false)
  const [categories, setCategories] = useState<WorkCategory[]>([])
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [viewMode, setViewMode] = useState<'all' | 'user' | 'category' | 'summary' | 'collab'>('all')

  useEffect(() => {
    brandingApi.getCategories().then(r => setCategories(r.categories)).catch(() => {})
  }, [])

  const toggleUser = (id: string) =>
    setFilters(p => ({ ...p, userIds: p.userIds.includes(id) ? p.userIds.filter(u => u !== id) : [...p.userIds, id] }))

  const loadReports = useCallback(() => {
    setLoading(true)
    brandingApi.getAllReports({
      userIds:     filters.userIds.length > 0 ? filters.userIds : undefined,
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

  // ID → display name map for collaborator chips. Falls back to the raw id if
  // the user is no longer in the branding list (e.g. moved teams or deleted).
  const userNameById = useMemo(() => {
    const m: Record<string, string> = {}
    for (const u of brandingUsers) m[u.id] = u.full_name || u.email || u.id
    return m
  }, [brandingUsers])
  const labelCollab = (id: string) => userNameById[id] || id

  // Sort: most recent report_date first, then most recent submit (drafts last).
  // Surfaces today's submits at the top of the list.
  const sortedReports = useMemo(() => {
    return [...reports].sort((a, b) => {
      if (a.report_date !== b.report_date) return a.report_date < b.report_date ? 1 : -1
      const aT = a.submitted_at ? Date.parse(a.submitted_at) : 0
      const bT = b.submitted_at ? Date.parse(b.submitted_at) : 0
      return bT - aT
    })
  }, [reports])

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
          const collabName = userNameById[c] || c
          map[name][collabName] = (map[name][collabName] || 0) + 1
        }
      }
    }
    return map
  }, [reports, userNameById])

  function exportCSV() {
    const rows: string[][] = [['Date', 'User', 'Sr', 'Type of Work', 'Sub Category', 'Specific Work', 'Time Taken', 'Collaborators']]
    for (const r of reports)
      for (const row of r.rows)
        rows.push([r.report_date, r.user_name || '', String(row.sr_no), row.type_of_work, row.sub_category, row.specific_work, row.time_taken, row.collaborative_colleagues.map(labelCollab).join('; ')])
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
          <button onClick={() => { setFilters(defaultDailyReportFilters()); setUserDropOpen(false) }}
            className="text-xs text-muted-foreground hover:text-foreground">Reset all</button>
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
          {/* Multi-select user/designer */}
          <div className="relative">
            <label className="text-xs text-muted-foreground block mb-1">User / Designer</label>
            <button type="button" onClick={() => setUserDropOpen(o => !o)}
              className={SEL + ' w-full flex items-center justify-between gap-2'}>
              <span className="truncate text-sm">
                {filters.userIds.length === 0
                  ? 'All users'
                  : filters.userIds.length === 1
                    ? (brandingUsers.find(u => u.id === filters.userIds[0])?.full_name || 'Unknown')
                    : `${filters.userIds.length} selected`}
              </span>
              <ChevronDown className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
            </button>
            {userDropOpen && (
              <div className="absolute z-50 top-full mt-1 left-0 w-full min-w-[200px] bg-background border border-border rounded-lg shadow-lg py-1 max-h-52 overflow-y-auto">
                <label className="flex items-center gap-2 px-3 py-1.5 hover:bg-muted/40 cursor-pointer">
                  <input type="checkbox" checked={filters.userIds.length === 0}
                    onChange={() => setFilters(p => ({ ...p, userIds: [] }))}
                    className="w-3.5 h-3.5 accent-pink-500" />
                  <span className="text-sm">All users</span>
                </label>
                <div className="border-t border-border my-1" />
                {brandingUsers.map(u => (
                  <label key={u.id} className="flex items-center gap-2 px-3 py-1.5 hover:bg-muted/40 cursor-pointer">
                    <input type="checkbox" checked={filters.userIds.includes(u.id)}
                      onChange={() => toggleUser(u.id)}
                      className="w-3.5 h-3.5 accent-pink-500" />
                    <span className="text-sm truncate">{u.full_name || u.email}</span>
                  </label>
                ))}
                <div className="border-t border-border mt-1 pt-1 px-2 pb-1">
                  <button type="button" onClick={() => setUserDropOpen(false)}
                    className="w-full text-xs text-center text-muted-foreground hover:text-foreground py-0.5">Done</button>
                </div>
              </div>
            )}
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
              {sortedReports.length === 0 && <p className="text-sm text-muted-foreground text-center py-8">No reports found.</p>}
              {sortedReports.map(r => (
                <div key={r.id} className="hub-card p-0 overflow-hidden border border-border">
                  <div className="flex items-center gap-3 px-4 py-3 bg-muted/20 border-b border-border cursor-pointer"
                    onClick={() => setExpanded(p => { const s = new Set(p); if (s.has(r.id)) s.delete(r.id); else s.add(r.id); return s })}>
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
                              <td className="px-3 py-1.5 text-muted-foreground">{row.collaborative_colleagues.map(labelCollab).join(', ') || '—'}</td>
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
  const [userPeerMarkings, setUserPeerMarkings] = useState<PeerMarking[]>([])
  const [userPeerLoading, setUserPeerLoading] = useState(false)
  const [detailTab, setDetailTab] = useState<'admin' | 'self' | 'peer'>('admin')
  // Manual penalty modal state
  const [penaltyOpen, setPenaltyOpen] = useState(false)
  const [penaltyPct, setPenaltyPct] = useState('0')
  const [penaltyReason, setPenaltyReason] = useState('')
  const [penaltySaving, setPenaltySaving] = useState(false)
  // Total-penalty override modal state
  const [overrideOpen, setOverrideOpen] = useState(false)
  const [overrideEnabled, setOverrideEnabled] = useState(false)
  const [overridePct, setOverridePct] = useState('0')
  const [overrideReason, setOverrideReason] = useState('')
  const [overrideSaving, setOverrideSaving] = useState(false)

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

  // Load admin scores + peer markings when selecting a user
  useEffect(() => {
    if (!selectedUser) return
    brandingApi.getAdminScore(selectedUser, month, year)
      .then(r => setAdminScores(r.score?.scores || Object.fromEntries(params.map(p => [p.id, 5]))))
      .catch(() => {})
    setUserPeerLoading(true)
    brandingApi.getUserPeerMarkings(selectedUser, month, year)
      .then(r => setUserPeerMarkings(r.markings))
      .catch(() => {})
      .finally(() => setUserPeerLoading(false))
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

  function openPenaltyModal() {
    if (!selectedUser) return
    const cur = dashboard.find(d => d.user_id === selectedUser)
    setPenaltyPct(String(cur?.manual_penalty_percent ?? 0))
    setPenaltyReason(cur?.manual_penalty_reason ?? '')
    setPenaltyOpen(true)
  }

  async function saveManualPenalty() {
    if (!selectedUser) return
    const pct = Number(penaltyPct)
    if (Number.isNaN(pct) || pct < 0 || pct > 100) {
      toast.error('Penalty must be between 0 and 100.')
      return
    }
    setPenaltySaving(true)
    try {
      await brandingApi.setAdminPenalty(selectedUser, month, year, pct, penaltyReason.trim())
      await load()
      toast.success(pct === 0 ? 'Penalty cleared.' : `Penalty of −${pct}% applied.`)
      setPenaltyOpen(false)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed')
    } finally {
      setPenaltySaving(false)
    }
  }

  function openOverrideModal() {
    if (!selectedUser) return
    const cur = dashboard.find(d => d.user_id === selectedUser)
    const ov = cur?.total_penalty_override ?? null
    setOverrideEnabled(ov !== null)
    setOverridePct(String(ov ?? cur?.total_penalty_percent ?? 0))
    setOverrideReason(cur?.total_penalty_override_reason ?? '')
    setOverrideOpen(true)
  }

  async function saveTotalOverride() {
    if (!selectedUser) return
    const pct = overrideEnabled ? Number(overridePct) : null
    if (overrideEnabled && (Number.isNaN(pct as number) || (pct as number) < 0 || (pct as number) > 100)) {
      toast.error('Total penalty must be between 0 and 100.')
      return
    }
    setOverrideSaving(true)
    try {
      await brandingApi.setTotalPenaltyOverride(selectedUser, month, year, pct, overrideReason.trim())
      await load()
      toast.success(pct === null
        ? 'Total-penalty override removed. Reverted to auto + manual.'
        : `Total penalty set to −${pct}%.`)
      setOverrideOpen(false)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed')
    } finally {
      setOverrideSaving(false)
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
    const rows: string[][] = [['User', 'Self Score', 'Peer Score', 'Admin Score', 'Composite', 'Missed Days', 'Auto Penalty %', 'Manual Penalty %', 'Total Penalty %', 'Final Score', 'Status']]
    for (const r of dashboard) {
      const self  = scoreAvg(r.self_appraisal?.scores || null, params)
      const peer  = scoreAvg(r.peer_average, params)
      const admin = scoreAvg(r.admin_score?.scores || null, params)
      rows.push([
        r.user_name,
        self?.toFixed(1) ?? '—',
        peer?.toFixed(1) ?? '—',
        admin?.toFixed(1) ?? '—',
        r.composite_score?.toFixed(1) ?? '—',
        String(r.missed_report_days ?? 0),
        `-${r.penalty_percent ?? 0}%`,
        `-${r.manual_penalty_percent ?? 0}%`,
        `-${r.total_penalty_percent ?? 0}%`,
        r.composite_score_after_penalty?.toFixed(1) ?? '—',
        r.is_final_pushed ? 'Published' : 'Pending',
      ])
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
          {(() => {
            const now = new Date()
            const curYear = now.getFullYear()
            const curMonth = now.getMonth() + 1
            const years = Array.from({ length: curYear - 2023 }, (_, i) => 2024 + i)
            return (
              <>
                <select value={month} onChange={e => {
                  const m = parseInt(e.target.value)
                  if (year === curYear && m > curMonth) return
                  setMonth(m)
                }} className={SEL}>
                  {MONTHS.map((m, i) => (
                    <option key={m} value={i + 1} disabled={year === curYear && i + 1 > curMonth}>{m}</option>
                  ))}
                </select>
                <select value={year} onChange={e => {
                  const y = parseInt(e.target.value)
                  setYear(y)
                  if (y === curYear && month > curMonth) setMonth(curMonth)
                }} className={SEL}>
                  {years.map(y => <option key={y} value={y}>{y}</option>)}
                </select>
              </>
            )
          })()}
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
              const final = r.composite_score_after_penalty
              return (
                <button key={r.user_id}
                  onClick={() => { setSelectedUser(r.user_id); setFinalPushState('idle'); setDetailTab('admin') }}
                  className={`w-full flex items-center gap-3 p-3 rounded-xl border text-left transition-all ${selectedUser === r.user_id ? 'border-pink-400 bg-pink-50/40' : 'border-border hover:border-pink-200 hover:bg-muted/20'}`}>
                  <div className="w-8 h-8 rounded-full bg-pink-100 flex items-center justify-center shrink-0">
                    <span className="text-xs font-semibold text-pink-700">{r.user_name[0]?.toUpperCase()}</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-foreground truncate">{r.user_name}</p>
                    <p className="text-xs text-muted-foreground">
                      {r.self_appraisal ? '✓ Self' : '○ Self'} · {r.peer_count > 0 ? `✓ ${r.peer_count} peers` : '○ Peers'}
                      {(r.total_penalty_percent ?? 0) > 0 && (
                        <span className="ml-1 text-red-600 font-semibold">· −{r.total_penalty_percent}%</span>
                      )}
                    </p>
                  </div>
                  <div className="text-right shrink-0">
                    {composite !== null && (
                      <p className="text-sm font-semibold text-pink-600">
                        {final !== null && final !== composite
                          ? <><span className="line-through text-gray-400 text-[11px] mr-1">{composite}</span>{final}</>
                          : composite}
                      </p>
                    )}
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

                {/* Score overview cards */}
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

                {/* Penalty bar — auto + manual combined */}
                {(selectedReport.expected_report_days > 0 || selectedReport.manual_penalty_percent > 0) && (
                  <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 space-y-2">
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                      <span className="font-bold text-amber-800">Daily Report Attendance</span>
                      <span className="text-amber-700">
                        Submitted <span className="font-semibold">{selectedReport.submitted_report_days}</span>
                        {' / '}
                        Expected <span className="font-semibold">{selectedReport.expected_report_days}</span>
                      </span>
                      <span className="text-amber-700">
                        Missed: <span className="font-semibold">{selectedReport.missed_report_days}</span> day(s)
                      </span>
                      <span className="text-red-700 font-semibold">
                        Auto: −{selectedReport.penalty_percent}%
                      </span>
                      {selectedReport.manual_penalty_percent > 0 && (
                        <span className="text-red-700 font-semibold">
                          Manual: −{selectedReport.manual_penalty_percent}%
                        </span>
                      )}
                      <span className="text-red-800 font-bold">
                        Total: −{selectedReport.total_penalty_percent}%
                      </span>
                      {selectedReport.total_penalty_override !== null && (
                        <span className="text-[10px] font-semibold uppercase tracking-wider bg-amber-200 text-amber-900 px-1.5 py-0.5 rounded">
                          Admin Override
                        </span>
                      )}
                      <span className="ml-auto text-green-800 font-bold">
                        Final: {selectedReport.composite_score_after_penalty?.toFixed(1) ?? '—'}<span className="text-[10px] font-normal opacity-60">/10</span>
                      </span>
                    </div>
                    {selectedReport.manual_penalty_reason && (
                      <p className="text-[11px] text-amber-700 italic">
                        Manual penalty reason: {selectedReport.manual_penalty_reason}
                      </p>
                    )}
                    {selectedReport.total_penalty_override !== null && selectedReport.total_penalty_override_reason && (
                      <p className="text-[11px] text-amber-700 italic">
                        Override reason: {selectedReport.total_penalty_override_reason}
                      </p>
                    )}
                  </div>
                )}

                {/* Detail sub-tabs */}
                <div className="flex gap-1 bg-muted/30 p-1 rounded-lg w-fit">
                  {([
                    { key: 'admin', label: 'Admin Score' },
                    { key: 'self',  label: 'Self Score' },
                    { key: 'peer',  label: `Peer Scores (${userPeerMarkings.length})` },
                  ] as const).map(t => (
                    <button key={t.key} onClick={() => setDetailTab(t.key)}
                      className={`px-3 py-1 rounded-md text-xs font-medium transition-all ${detailTab === t.key ? 'bg-white text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>
                      {t.label}
                    </button>
                  ))}
                </div>

                {/* Admin Scoring */}
                {detailTab === 'admin' && !selectedReport.is_final_pushed && params.length > 0 && (
                  <div>
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
                    {/* Manual penalty — applied on top of the auto missed-report penalty */}
                    <button onClick={openPenaltyModal}
                      className="mt-2 w-full py-2 rounded-lg border border-red-300 text-red-700 text-sm font-medium hover:bg-red-50 transition-colors flex items-center justify-center gap-2">
                      <AlertTriangle className="w-4 h-4" />
                      {selectedReport.manual_penalty_percent > 0
                        ? `Edit Penalty (currently −${selectedReport.manual_penalty_percent}%)`
                        : 'Add Penalty'}
                    </button>
                    <button onClick={openOverrideModal}
                      className="mt-2 w-full py-2 rounded-lg border border-amber-300 text-amber-700 text-sm font-medium hover:bg-amber-50 transition-colors flex items-center justify-center gap-2">
                      <Edit3 className="w-4 h-4" />
                      Modify Penalty
                      {selectedReport.total_penalty_override !== null ? (
                        <span className="text-[11px] font-normal text-muted-foreground">
                          (override: −{selectedReport.total_penalty_override}%)
                        </span>
                      ) : (selectedReport.total_penalty_percent ?? 0) > 0 && (
                        <span className="text-[11px] font-normal text-muted-foreground">
                          (total currently −{selectedReport.total_penalty_percent}%)
                        </span>
                      )}
                    </button>
                  </div>
                )}
                {detailTab === 'admin' && selectedReport.is_final_pushed && (
                  <p className="text-xs text-muted-foreground text-center py-4">KRA is final-published. Admin scores are locked.</p>
                )}

                {/* Self Score Detail */}
                {detailTab === 'self' && (
                  <div>
                    {!selectedReport.self_appraisal ? (
                      <p className="text-sm text-muted-foreground text-center py-6">Member has not submitted self-appraisal yet.</p>
                    ) : (
                      <div className="space-y-3">
                        {params.map(p => {
                          const score = selectedReport.self_appraisal?.scores[p.id] ?? null
                          return (
                            <div key={p.id} className="flex items-center gap-3">
                              <div className="flex-1 min-w-0">
                                <p className="text-xs font-medium text-foreground">{p.name}</p>
                                {p.description && <p className="text-[10px] text-muted-foreground">{p.description}</p>}
                              </div>
                              <div className="w-32 h-2 bg-muted rounded-full shrink-0">
                                <div className="h-full bg-pink-500 rounded-full transition-all"
                                  style={{ width: score !== null ? `${(score / (p.max_score || 5)) * 100}%` : '0%' }} />
                              </div>
                              <span className="text-sm font-semibold text-pink-600 w-10 text-right shrink-0">
                                {score ?? '—'}<span className="text-xs text-muted-foreground font-normal">/{p.max_score}</span>
                              </span>
                            </div>
                          )
                        })}
                        <p className="text-[10px] text-muted-foreground pt-1">
                          Submitted: {new Date(selectedReport.self_appraisal.submitted_at).toLocaleDateString()}
                        </p>
                      </div>
                    )}
                  </div>
                )}

                {/* Peer Scores Detail */}
                {detailTab === 'peer' && (
                  <div>
                    {userPeerLoading ? (
                      <p className="text-sm text-muted-foreground text-center py-6 animate-pulse">Loading peer markings…</p>
                    ) : userPeerMarkings.length === 0 ? (
                      <p className="text-sm text-muted-foreground text-center py-6">No peer markings received for this period.</p>
                    ) : (
                      <div className="space-y-4">
                        {userPeerMarkings.map(pm => (
                          <div key={pm.id} className="border border-border rounded-xl p-3 space-y-2">
                            <p className="text-xs font-semibold text-foreground">
                              From: {pm.reviewer_name || pm.reviewer_id}
                              <span className="ml-2 text-muted-foreground font-normal">
                                · Avg: {(Object.values(pm.scores).reduce((a, b) => a + b, 0) / Math.max(Object.keys(pm.scores).length, 1)).toFixed(1)}
                              </span>
                            </p>
                            {params.map(p => {
                              const score = pm.scores[p.id] ?? null
                              return (
                                <div key={p.id} className="flex items-center gap-3">
                                  <span className="text-xs text-muted-foreground flex-1 truncate">{p.name}</span>
                                  <div className="w-24 h-1.5 bg-muted rounded-full shrink-0">
                                    <div className="h-full bg-blue-500 rounded-full transition-all"
                                      style={{ width: score !== null ? `${(score / (p.max_score || 5)) * 100}%` : '0%' }} />
                                  </div>
                                  <span className="text-xs font-semibold text-blue-600 w-8 text-right shrink-0">
                                    {score ?? '—'}
                                  </span>
                                </div>
                              )
                            })}
                          </div>
                        ))}
                        <p className="text-[10px] text-muted-foreground">
                          Average peer score shown in the summary card above is averaged across all {userPeerMarkings.length} reviewer{userPeerMarkings.length !== 1 ? 's' : ''}.
                        </p>
                      </div>
                    )}
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

      {/* Manual penalty modal */}
      {penaltyOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.45)' }}
          onClick={() => setPenaltyOpen(false)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6 space-y-4" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold text-foreground flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-red-600" /> Add Manual Penalty
              </h3>
              <button onClick={() => setPenaltyOpen(false)} className="p-1.5 rounded-lg hover:bg-muted text-muted-foreground"><X className="w-4 h-4" /></button>
            </div>
            <p className="text-xs text-muted-foreground">
              Applied on top of the auto missed-report penalty. Final score = composite × (1 − total %).
              Set to 0 to clear.
            </p>
            <div>
              <label className="text-xs font-bold uppercase tracking-wide mb-1 block text-foreground">Penalty (%)</label>
              <input type="number" min={0} max={100} step={0.5}
                value={penaltyPct}
                onChange={e => setPenaltyPct(e.target.value)}
                className={INP} autoFocus />
            </div>
            <div>
              <label className="text-xs font-bold uppercase tracking-wide mb-1 block text-foreground">Reason (optional)</label>
              <textarea value={penaltyReason} onChange={e => setPenaltyReason(e.target.value)}
                rows={3} placeholder="e.g. Repeated late submissions, missed deadline on Project X…"
                className={INP + ' resize-none'} />
            </div>
            <div className="flex gap-3 pt-1">
              <button onClick={() => void saveManualPenalty()} disabled={penaltySaving}
                className="flex-1 py-2 rounded-lg bg-red-600 text-white text-sm font-semibold hover:bg-red-700 disabled:opacity-50">
                {penaltySaving ? 'Saving…' : 'Apply Penalty'}
              </button>
              <button onClick={() => setPenaltyOpen(false)}
                className="px-4 py-2 rounded-lg border border-border text-sm text-muted-foreground hover:bg-muted">
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Total-penalty override modal */}
      {overrideOpen && selectedReport && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.45)' }}
          onClick={() => setOverrideOpen(false)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6 space-y-4" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold text-foreground flex items-center gap-2">
                <Edit3 className="w-4 h-4 text-amber-600" /> Modify Total Penalty
              </h3>
              <button onClick={() => setOverrideOpen(false)} className="p-1.5 rounded-lg hover:bg-muted text-muted-foreground"><X className="w-4 h-4" /></button>
            </div>
            <p className="text-xs text-muted-foreground">
              Replaces the auto (late-submission) and manual penalties with a single total you choose.
              Final score = composite × (1 − total %).
            </p>

            <div className="rounded-lg bg-muted/40 p-3 text-xs space-y-0.5">
              <div className="flex justify-between"><span className="text-muted-foreground">Auto (late submissions)</span><span className="font-semibold text-red-700">−{selectedReport.penalty_percent}%</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Manual</span><span className="font-semibold text-red-700">−{selectedReport.manual_penalty_percent}%</span></div>
              <div className="flex justify-between border-t border-border pt-1 mt-1"><span className="text-foreground font-medium">Current total</span><span className="font-bold text-red-800">−{selectedReport.total_penalty_percent}%</span></div>
            </div>

            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input type="checkbox" checked={overrideEnabled}
                onChange={e => setOverrideEnabled(e.target.checked)}
                className="accent-amber-500 w-4 h-4" />
              <span>Override total penalty</span>
            </label>

            <div className={overrideEnabled ? '' : 'opacity-50 pointer-events-none'}>
              <label className="text-xs font-bold uppercase tracking-wide mb-1 block text-foreground">Total Penalty (%)</label>
              <input type="number" min={0} max={100} step={0.5}
                value={overridePct}
                onChange={e => setOverridePct(e.target.value)}
                disabled={!overrideEnabled}
                className={INP} autoFocus />
              <div className="mt-3">
                <label className="text-xs font-bold uppercase tracking-wide mb-1 block text-foreground">Reason (optional)</label>
                <textarea value={overrideReason} onChange={e => setOverrideReason(e.target.value)}
                  rows={3} placeholder="e.g. Overriding to account for approved leave on missed days…"
                  className={INP + ' resize-none'} />
              </div>
            </div>

            {!overrideEnabled && selectedReport.total_penalty_override !== null && (
              <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-2">
                Unchecking and saving will remove the override; auto + manual will be used again.
              </p>
            )}

            <div className="flex gap-3 pt-1">
              <button onClick={() => void saveTotalOverride()} disabled={overrideSaving}
                className="flex-1 py-2 rounded-lg bg-amber-600 text-white text-sm font-semibold hover:bg-amber-700 disabled:opacity-50">
                {overrideSaving ? 'Saving…' : (overrideEnabled ? 'Save Override' : 'Clear Override')}
              </button>
              <button onClick={() => setOverrideOpen(false)}
                className="px-4 py-2 rounded-lg border border-border text-sm text-muted-foreground hover:bg-muted">
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Leave Management Tab ───────────────────────────────────────────────────

function LeaveManagementTab() {
  const [leaves, setLeaves] = useState<BrandingLeave[]>([])
  const [loading, setLoading] = useState(false)
  const [statusFilter, setStatusFilter] = useState<'all' | 'pending' | 'approved' | 'rejected'>('pending')
  const [transferEdit, setTransferEdit] = useState<string | null>(null)
  const [transferVal, setTransferVal] = useState('')

  const load = useCallback(() => {
    setLoading(true)
    brandingApi.getLeaves(statusFilter === 'all' ? undefined : statusFilter)
      .then(r => setLeaves(r.leaves))
      .catch(() => toast.error('Failed to load leaves'))
      .finally(() => setLoading(false))
  }, [statusFilter])

  useEffect(() => { load() }, [load])

  async function handleReview(id: string, status: 'approved' | 'rejected') {
    try {
      const res = await brandingApi.reviewLeave(id, status)
      setLeaves(prev => prev.map(l => l.id === id ? res.leave : l).filter(l => statusFilter === 'all' || l.status === statusFilter || l.id === id))
      // Reload to reflect filter
      load()
      toast.success(status === 'approved' ? 'Leave approved.' : 'Leave rejected.')
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed') }
  }

  async function handleTransferSave(id: string) {
    try {
      const res = await brandingApi.updateLeaveTransfer(id, transferVal || null)
      setLeaves(prev => prev.map(l => l.id === id ? res.leave : l))
      setTransferEdit(null)
      toast.success('Transfer date updated.')
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed') }
  }

  const today = new Date().toISOString().split('T')[0]

  return (
    <div className="space-y-5">
      {/* Filter bar */}
      <div className="hub-card flex items-center gap-3 flex-wrap">
        <span className="text-sm font-semibold text-foreground flex items-center gap-2">
          <CalendarOff className="w-4 h-4 text-muted-foreground" /> Leave Requests
        </span>
        <div className="flex gap-1 bg-muted/40 p-1 rounded-xl ml-auto">
          {(['pending', 'approved', 'rejected', 'all'] as const).map(s => (
            <button key={s} onClick={() => setStatusFilter(s)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium capitalize transition-all ${statusFilter === s ? 'bg-white text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>
              {s === 'all' ? 'All' : s}
            </button>
          ))}
        </div>
      </div>

      {loading && <p className="text-sm text-muted-foreground text-center py-10 animate-pulse">Loading…</p>}

      {!loading && leaves.length === 0 && (
        <p className="text-sm text-muted-foreground text-center py-10">
          No {statusFilter === 'all' ? '' : statusFilter} leave requests.
        </p>
      )}

      {!loading && leaves.length > 0 && (
        <div className="space-y-3">
          {leaves.map(lv => (
            <div key={lv.id} className="hub-card p-4 flex items-start gap-4 border border-border">
              {/* Avatar */}
              <div className="w-9 h-9 rounded-full bg-pink-100 flex items-center justify-center shrink-0">
                <span className="text-xs font-semibold text-pink-700">
                  {(lv.user_name || lv.user_email || '?')[0].toUpperCase()}
                </span>
              </div>

              <div className="flex-1 min-w-0 space-y-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-semibold text-foreground">{lv.user_name || lv.user_email || lv.user_id}</span>
                  <span className="text-sm text-muted-foreground">{lv.leave_date}</span>
                  {lv.is_half_day && lv.half_day_period && (
                    <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-50 text-amber-700">
                      {lv.half_day_period === 'first' ? 'First half' : 'Second half'}
                    </span>
                  )}
                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                    lv.status === 'approved' ? 'bg-green-50 text-green-700' :
                    lv.status === 'rejected' ? 'bg-red-50 text-red-600' :
                    'bg-amber-50 text-amber-700'
                  }`}>
                    {lv.status.charAt(0).toUpperCase() + lv.status.slice(1)}
                  </span>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  {new Date(lv.start_at).toLocaleString([], { hour: 'numeric', minute: '2-digit', hour12: true })}
                  {' – '}
                  {new Date(lv.end_at).toLocaleString([], { hour: 'numeric', minute: '2-digit', hour12: true })}
                </p>
                <p className="text-xs text-muted-foreground">{lv.reason || '—'}</p>

                {/* Transfer date — admin editable */}
                <div className="flex items-center gap-2 mt-1">
                  <span className="text-xs text-muted-foreground">Transfer day:</span>
                  {transferEdit === lv.id ? (
                    <div className="flex items-center gap-1.5">
                      <input type="date" value={transferVal} min={today}
                        onChange={e => setTransferVal(e.target.value)}
                        className={SEL + ' py-0.5 px-2 text-xs'} />
                      <button onClick={() => void handleTransferSave(lv.id)}
                        className="text-xs font-bold text-green-700 hover:text-green-900">Save</button>
                      <button onClick={() => setTransferEdit(null)}
                        className="text-xs text-muted-foreground hover:text-foreground">Cancel</button>
                    </div>
                  ) : (
                    <span className="text-xs font-medium text-foreground">
                      {lv.transfer_date || 'Not set'}
                      <button onClick={() => { setTransferEdit(lv.id); setTransferVal(lv.transfer_date || '') }}
                        className="ml-2 text-[10px] text-muted-foreground underline hover:text-foreground">edit</button>
                    </span>
                  )}
                </div>
              </div>

              {/* Approve / Reject — only for pending */}
              {lv.status === 'pending' && (
                <div className="flex gap-2 shrink-0">
                  <button onClick={() => void handleReview(lv.id, 'approved')}
                    className="px-3 py-1.5 text-xs font-bold text-white rounded-lg bg-green-700 hover:bg-green-800 transition-colors">
                    Approve
                  </button>
                  <button onClick={() => void handleReview(lv.id, 'rejected')}
                    className="px-3 py-1.5 text-xs font-bold text-red-600 border border-red-200 rounded-lg hover:bg-red-50 transition-colors">
                    Reject
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Main Component ─────────────────────────────────────────────────────────

type AdminSection = 'reports' | 'kra' | 'leaves' | 'categories'

const SECTION_BY_PATH: Record<string, AdminSection> = {
  '/branding/dashboard':  'reports',
  '/branding/kra':        'kra',
  '/branding/leaves':     'leaves',
  '/branding/categories': 'categories',
}

const SECTION_META: Record<AdminSection, { title: string; subtitle: string }> = {
  reports:    { title: 'Daily Reports',     subtitle: 'Team activity, hours and collaboration' },
  kra:        { title: 'KRA Management',    subtitle: 'Self, peer and admin scoring with final publish' },
  leaves:     { title: 'Leave Requests',    subtitle: 'Approve, reject and reassign team leaves' },
  categories: { title: 'Manage Categories', subtitle: 'Work categories and sub-categories' },
}

export default function BrandingAdminDashboard() {
  const { profile } = useAuth()
  const { users } = useAppData()
  const location = useLocation()
  const section: AdminSection = SECTION_BY_PATH[location.pathname] ?? 'reports'
  const meta = SECTION_META[section]

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
          <h1 className="text-2xl font-serif text-foreground">{meta.title}</h1>
          <p className="text-sm text-muted-foreground">
            {profile?.full_name ? `${profile.full_name} · ` : ''}{meta.subtitle}
          </p>
        </div>
      </div>

      {section === 'reports'    && <DailyReportsTab    brandingUsers={brandingUsers} />}
      {section === 'kra'        && <KraManagementTab   brandingUsers={brandingUsers} />}
      {section === 'leaves'     && <LeaveManagementTab />}
      {section === 'categories' && <ManageCategoriesTab />}
    </div>
  )
}
