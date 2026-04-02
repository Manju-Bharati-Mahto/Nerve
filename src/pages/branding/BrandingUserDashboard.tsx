import { useState, useEffect, useCallback, useMemo } from 'react'
import { useAuth } from '@/hooks/useAuth'
import { useAppData } from '@/hooks/useAppData'
import { brandingApi } from '@/lib/branding-api'
import { TIME_OPTIONS, timeToHours, MONTHS } from '@/lib/branding-types'
import type {
  WorkCategory, DailyReport, DraftRow, KraParameter,
  SelfAppraisal,
} from '@/lib/branding-types'
import {
  Palette, CalendarDays, BarChart2, ClipboardList, Award,
  Plus, Trash2, Send, Lock, ChevronDown, X, Check, Info,
  Download, Users, TrendingUp, AlertCircle,
} from 'lucide-react'
import {
  PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis, Tooltip,
  ResponsiveContainer, Legend, CartesianGrid,
} from 'recharts'
import { toast } from 'sonner'

// ── Helpers ────────────────────────────────────────────────────────────────

const today = () => new Date().toISOString().split('T')[0]

const SEL = 'w-full bg-transparent text-sm px-2 py-1.5 rounded-lg border border-border focus:border-primary focus:outline-none focus:ring-1 focus:ring-ring/30 transition-all cursor-pointer'
const INP = 'w-full bg-transparent text-sm px-2 py-1.5 rounded-lg border border-border focus:border-primary focus:outline-none focus:ring-1 focus:ring-ring/30 transition-all placeholder:text-muted-foreground/50'

const COLORS = ['#ec4899','#8b5cf6','#3b82f6','#10b981','#f59e0b','#ef4444','#6366f1','#14b8a6','#f97316']

function blankRow(sr: number): DraftRow {
  return { _key: `${Date.now()}-${sr}`, sr_no: sr, type_of_work: '', sub_category: '', specific_work: '', time_taken: '', collaborative_colleagues: [] }
}

// ── Multi-select colleagues dropdown ──────────────────────────────────────

function ColleaguesSelect({
  options, value, onChange,
}: {
  options: { id: string; label: string }[]
  value: string[]
  onChange: (v: string[]) => void
}) {
  const [open, setOpen] = useState(false)

  const toggle = (id: string) => {
    onChange(value.includes(id) ? value.filter(v => v !== id) : [...value, id])
  }
  const labels = value.map(id => options.find(o => o.id === id)?.label || id)

  return (
    <div className="relative w-full min-w-[150px]">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between gap-1 text-sm px-2 py-1.5 rounded-lg border border-border hover:border-primary/60 transition-colors text-left bg-transparent"
      >
        <span className="truncate text-xs text-muted-foreground">
          {labels.length === 0 ? 'None' : labels.join(', ')}
        </span>
        <ChevronDown className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
      </button>
      {open && (
        <div className="absolute z-50 top-full mt-1 left-0 min-w-full w-48 bg-card border border-border rounded-lg shadow-lg py-1 max-h-52 overflow-y-auto">
          {options.length === 0 && (
            <p className="text-xs text-muted-foreground px-3 py-2">No other members</p>
          )}
          {options.map(opt => (
            <label key={opt.id} className="flex items-center gap-2 px-3 py-1.5 hover:bg-accent cursor-pointer">
              <input
                type="checkbox"
                checked={value.includes(opt.id)}
                onChange={() => toggle(opt.id)}
                className="w-3.5 h-3.5 accent-pink-500"
              />
              <span className="text-sm truncate">{opt.label}</span>
            </label>
          ))}
          <div className="border-t border-border mt-1 pt-1 px-2 pb-1">
            <button type="button" onClick={() => setOpen(false)} className="w-full text-xs text-center text-muted-foreground hover:text-foreground py-0.5">Done</button>
          </div>
        </div>
      )}
    </div>
  )
}

// ── KRA Form ───────────────────────────────────────────────────────────────

function KraForm({
  params, scores, onChange, readOnly = false,
}: {
  params: KraParameter[]
  scores: Record<string, number>
  onChange?: (scores: Record<string, number>) => void
  readOnly?: boolean
}) {
  return (
    <div className="space-y-4">
      {params.map(p => (
        <div key={p.id}>
          <div className="flex items-start justify-between mb-1">
            <div>
              <p className="text-sm font-medium text-foreground">{p.name}</p>
              <p className="text-xs text-muted-foreground">{p.description}</p>
            </div>
            <span className="text-sm font-semibold text-pink-600 w-10 text-right shrink-0">
              {scores[p.id] ?? '—'}<span className="text-muted-foreground font-normal">/{p.max_score}</span>
            </span>
          </div>
          {readOnly ? (
            <div className="h-2 bg-muted rounded-full overflow-hidden">
              <div
                className="h-full bg-pink-400 rounded-full transition-all"
                style={{ width: `${((scores[p.id] ?? 0) / p.max_score) * 100}%` }}
              />
            </div>
          ) : (
            <input
              type="range"
              min={0}
              max={p.max_score}
              step={1}
              value={scores[p.id] ?? 0}
              onChange={e => onChange?.({ ...scores, [p.id]: parseInt(e.target.value) })}
              className="w-full accent-pink-500"
            />
          )}
        </div>
      ))}
    </div>
  )
}

// ── Analytics section ──────────────────────────────────────────────────────

type DateFilter = 'week' | 'month' | '3months' | 'custom'

function AnalyticsSection({ userId }: { userId: string }) {
  const [filter, setFilter] = useState<DateFilter>('month')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')
  const [analytics, setAnalytics] = useState<{
    typeHours: Record<string, number>
    subCatHours: Record<string, Record<string, number>>
    collaboratorMap: Record<string, { hours: number; count: number }>
    totalReports: number
  } | null>(null)
  const [loading, setLoading] = useState(false)

  const getRange = useCallback((): { dateFrom: string; dateTo: string } => {
    const now = new Date()
    const fmt = (d: Date) => d.toISOString().split('T')[0]
    if (filter === 'week') {
      const start = new Date(now); start.setDate(now.getDate() - 6)
      return { dateFrom: fmt(start), dateTo: fmt(now) }
    }
    if (filter === 'month') {
      return { dateFrom: fmt(new Date(now.getFullYear(), now.getMonth(), 1)), dateTo: fmt(now) }
    }
    if (filter === '3months') {
      const start = new Date(now); start.setMonth(now.getMonth() - 3)
      return { dateFrom: fmt(start), dateTo: fmt(now) }
    }
    return { dateFrom: customFrom || fmt(new Date(now.getFullYear(), now.getMonth(), 1)), dateTo: customTo || fmt(now) }
  }, [filter, customFrom, customTo])

  useEffect(() => {
    if (filter === 'custom' && (!customFrom || !customTo)) return
    setLoading(true)
    const { dateFrom, dateTo } = getRange()
    brandingApi.getAnalytics({ dateFrom, dateTo, userId })
      .then(r => setAnalytics(r.analytics))
      .catch(() => toast.error('Failed to load analytics'))
      .finally(() => setLoading(false))
  }, [filter, customFrom, customTo, userId, getRange])

  const pieData = analytics
    ? Object.entries(analytics.typeHours).map(([name, value]) => ({ name, value: Math.round(value * 10) / 10 }))
    : []
  const collabData = analytics
    ? Object.entries(analytics.collaboratorMap)
        .sort((a, b) => b[1].hours - a[1].hours)
        .slice(0, 8)
        .map(([name, v]) => ({ name: name.split(' ')[0], hours: Math.round(v.hours * 10) / 10 }))
    : []

  const aiSuggestions = useMemo(() => {
    if (!analytics) return []
    const suggestions: string[] = []
    const entries = Object.entries(analytics.typeHours)
    const total = entries.reduce((s, [, v]) => s + v, 0)
    if (total === 0) return ['No data for the selected period. Start submitting daily reports to see insights.']
    const dominant = entries.sort((a, b) => b[1] - a[1])[0]
    if (dominant && dominant[1] / total > 0.6)
      suggestions.push(`${Math.round((dominant[1] / total) * 100)}% of your time is spent on "${dominant[0]}". Consider diversifying your work areas.`)
    if (Object.keys(analytics.collaboratorMap).length === 0)
      suggestions.push('No collaboration logged this period. Working with colleagues can improve output quality.')
    if (analytics.totalReports < 5 && filter === 'month')
      suggestions.push('Only ' + analytics.totalReports + ' reports submitted this month. Consistent daily reporting helps track your progress.')
    if (entries.length > 0 && entries.some(([, v]) => v === 0))
      suggestions.push('Some work categories have zero entries. Review if tasks in those areas are being captured.')
    if (suggestions.length === 0)
      suggestions.push('Great work! Your time distribution looks balanced across multiple categories.')
    return suggestions
  }, [analytics, filter])

  return (
    <div className="space-y-5 mt-6">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-foreground flex items-center gap-2">
          <BarChart2 className="w-4 h-4 text-pink-500" /> Analytics & Insights
        </h2>
        <div className="flex items-center gap-2 flex-wrap justify-end">
          {(['week', 'month', '3months', 'custom'] as DateFilter[]).map(f => (
            <button key={f} onClick={() => setFilter(f)}
              className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${filter === f ? 'bg-pink-100 text-pink-700' : 'bg-muted text-muted-foreground hover:bg-pink-50'}`}>
              {f === 'week' ? 'This Week' : f === 'month' ? 'This Month' : f === '3months' ? 'Last 3 Months' : 'Custom'}
            </button>
          ))}
          {filter === 'custom' && (
            <div className="flex items-center gap-1">
              <input type="date" value={customFrom} onChange={e => setCustomFrom(e.target.value)} className="text-xs border border-border rounded px-2 py-1" />
              <span className="text-xs text-muted-foreground">–</span>
              <input type="date" value={customTo} onChange={e => setCustomTo(e.target.value)} className="text-xs border border-border rounded px-2 py-1" />
            </div>
          )}
        </div>
      </div>

      {loading && <p className="text-sm text-muted-foreground py-4 text-center animate-pulse">Loading analytics…</p>}

      {!loading && analytics && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          {/* Time Distribution */}
          <div className="hub-card">
            <h3 className="text-sm font-semibold mb-3 text-foreground">Time Distribution</h3>
            {pieData.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">No data for this period.</p>
            ) : (
              <ResponsiveContainer width="100%" height={200}>
                <PieChart>
                  <Pie data={pieData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={75} label={({ name, percent }) => `${name.slice(0,10)} ${Math.round(percent * 100)}%`}>
                    {pieData.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                  </Pie>
                  <Tooltip formatter={(v: number) => [`${v} hrs`, 'Hours']} />
                </PieChart>
              </ResponsiveContainer>
            )}
          </div>

          {/* Collaboration */}
          <div className="hub-card">
            <h3 className="text-sm font-semibold mb-3 text-foreground flex items-center gap-2">
              <Users className="w-3.5 h-3.5 text-muted-foreground" /> Collaboration
            </h3>
            {collabData.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">No collaboration data.</p>
            ) : (
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={collabData} margin={{ top: 4, right: 0, left: -20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                  <XAxis dataKey="name" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
                  <YAxis tick={{ fontSize: 10 }} tickLine={false} axisLine={false} allowDecimals={false} />
                  <Tooltip formatter={(v: number) => [`${v} hrs`, 'Hours']} />
                  <Bar dataKey="hours" fill="#ec4899" radius={[4, 4, 0, 0]} maxBarSize={36} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>

          {/* Category Breakdown */}
          {Object.keys(analytics.subCatHours).length > 0 && (
            <div className="hub-card lg:col-span-2">
              <h3 className="text-sm font-semibold mb-3 text-foreground flex items-center gap-2">
                <TrendingUp className="w-3.5 h-3.5 text-muted-foreground" /> Category Breakdown
              </h3>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left">
                      <th className="pb-2 pr-4 text-xs font-semibold text-muted-foreground">Category</th>
                      <th className="pb-2 pr-4 text-xs font-semibold text-muted-foreground">Sub Category</th>
                      <th className="pb-2 text-xs font-semibold text-muted-foreground text-right">Hours</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(analytics.subCatHours).flatMap(([cat, subs]) =>
                      Object.entries(subs).map(([sub, hrs], si) => (
                        <tr key={`${cat}-${sub}`} className="border-b border-border/50 last:border-0">
                          <td className="py-1.5 pr-4 text-foreground">{si === 0 ? cat : ''}</td>
                          <td className="py-1.5 pr-4 text-muted-foreground">{sub || '—'}</td>
                          <td className="py-1.5 text-right font-medium text-pink-600">{Math.round(hrs * 10) / 10}h</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* AI Suggestions */}
          <div className="hub-card lg:col-span-2">
            <h3 className="text-sm font-semibold mb-3 text-foreground flex items-center gap-2">
              <Info className="w-3.5 h-3.5 text-muted-foreground" /> AI-Based Suggestions
            </h3>
            <div className="space-y-2">
              {aiSuggestions.map((s, i) => (
                <div key={i} className="flex items-start gap-2.5 p-3 rounded-lg bg-pink-50/60 border border-pink-100">
                  <AlertCircle className="w-4 h-4 text-pink-500 shrink-0 mt-0.5" />
                  <p className="text-sm text-foreground">{s}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Main Component ─────────────────────────────────────────────────────────

export default function BrandingUserDashboard() {
  const { profile } = useAuth()
  const { users } = useAppData()

  const [activeTab, setActiveTab] = useState<'reporting' | 'appraisal'>('reporting')

  // ── Daily Reporting state ──────────────────────────────────────────────
  const [selectedDate, setSelectedDate] = useState(today())
  const [categories, setCategories] = useState<WorkCategory[]>([])
  const [report, setReport] = useState<DailyReport | null>(null)
  const [rows, setRows] = useState<DraftRow[]>([blankRow(1)])
  const [saving, setSaving] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  const colleagueOptions = useMemo(() =>
    users
      .filter(u => u.team === 'branding' && u.id !== profile?.id)
      .map(u => ({ id: u.id, label: u.full_name || u.email })),
    [users, profile]
  )

  // Load categories once
  useEffect(() => {
    brandingApi.getCategories()
      .then(r => setCategories(r.categories))
      .catch(() => toast.error('Failed to load categories'))
  }, [])

  // Load report for selected date
  useEffect(() => {
    if (!selectedDate) return
    brandingApi.getReport(selectedDate)
      .then(r => {
        setReport(r.report)
        if (r.report.rows.length > 0) {
          setRows(r.report.rows.map(row => ({
            _key: row.id,
            sr_no: row.sr_no,
            type_of_work: row.type_of_work,
            sub_category: row.sub_category,
            specific_work: row.specific_work,
            time_taken: row.time_taken,
            collaborative_colleagues: row.collaborative_colleagues,
          })))
        } else if (!r.report.is_locked) {
          setRows([blankRow(1)])
        }
      })
      .catch(() => toast.error('Failed to load report'))
  }, [selectedDate])

  const subCatOptions = useCallback((typeOfWork: string) => {
    if (!typeOfWork) return []
    const cat = categories.find(c => c.name === typeOfWork)
    return cat?.sub_categories || []
  }, [categories])

  function updateRow(key: string, field: keyof DraftRow, value: unknown) {
    setRows(prev => prev.map(r => {
      if (r._key !== key) return r
      const updated = { ...r, [field]: value }
      // Reset sub_category when type_of_work changes
      if (field === 'type_of_work') updated.sub_category = ''
      return updated
    }))
  }

  function addRow() {
    setRows(prev => [...prev, blankRow(prev.length + 1)])
  }

  function deleteRow(key: string) {
    setRows(prev => {
      const filtered = prev.filter(r => r._key !== key)
      return filtered.map((r, i) => ({ ...r, sr_no: i + 1 }))
    })
  }

  async function saveDraft() {
    if (!report || report.is_locked) return
    setSaving(true)
    try {
      await brandingApi.saveRows(report.id, rows.map(r => ({
        sr_no: r.sr_no,
        type_of_work: r.type_of_work,
        sub_category: r.sub_category,
        specific_work: r.specific_work,
        time_taken: r.time_taken,
        collaborative_colleagues: r.collaborative_colleagues,
      })))
      toast.success('Draft saved')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  async function submitReport() {
    if (!report || report.is_locked) return
    // Validate mandatory fields
    const invalid = rows.filter(r => !r.type_of_work || !r.sub_category || !r.specific_work || !r.time_taken)
    if (invalid.length > 0) {
      toast.error('Please fill all mandatory fields (Type, Sub Category, Specific Work, Time Taken) before submitting.')
      return
    }
    if (rows.length === 0) {
      toast.error('Add at least one row before submitting.')
      return
    }
    setSubmitting(true)
    try {
      // Save rows then submit
      await brandingApi.saveRows(report.id, rows.map(r => ({
        sr_no: r.sr_no, type_of_work: r.type_of_work, sub_category: r.sub_category,
        specific_work: r.specific_work, time_taken: r.time_taken,
        collaborative_colleagues: r.collaborative_colleagues,
      })))
      const res = await brandingApi.submitReport(report.id)
      setReport(res.report)
      toast.success('Report submitted and locked!')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to submit')
    } finally {
      setSubmitting(false)
    }
  }

  // ── Appraisal state ────────────────────────────────────────────────────
  const [appraisalSection, setAppraisalSection] = useState<'self' | 'peer' | 'download' | null>(null)
  const [kraParams, setKraParams] = useState<KraParameter[]>([])
  const [appraisalMonth, setAppraisalMonth] = useState(new Date().getMonth() + 1)
  const [appraisalYear,  setAppraisalYear]  = useState(new Date().getFullYear())
  const [selfAppraisal,  setSelfAppraisal]  = useState<SelfAppraisal | null>(null)
  const [selfScores,     setSelfScores]     = useState<Record<string, number>>({})
  const [selfLoading,    setSelfLoading]    = useState(false)
  const [peerEnabled,    setPeerEnabled]    = useState(false)
  const [peerColleague,  setPeerColleague]  = useState('')
  const [peerScores,     setPeerScores]     = useState<Record<string, number>>({})
  const [completedPeers, setCompletedPeers] = useState<string[]>([])
  const [peerSubmitting, setPeerSubmitting] = useState(false)
  const [kraReport,      setKraReport]      = useState<import('@/lib/branding-types').KraReport | null>(null)
  const [confirmSubmit,  setConfirmSubmit]  = useState(false)

  // Load KRA params once
  useEffect(() => {
    brandingApi.getKraParameters().then(r => setKraParams(r.parameters)).catch(() => {})
    brandingApi.getPeerMarkingEnabled().then(r => setPeerEnabled(r.enabled)).catch(() => {})
  }, [])

  // Load self appraisal when section opens or month/year changes
  useEffect(() => {
    if (appraisalSection !== 'self') return
    setSelfLoading(true)
    brandingApi.getSelfAppraisal(appraisalMonth, appraisalYear)
      .then(r => {
        setSelfAppraisal(r.appraisal)
        if (r.appraisal) setSelfScores(r.appraisal.scores)
        else setSelfScores(Object.fromEntries(kraParams.map(p => [p.id, 5])))
      })
      .catch(() => toast.error('Failed to load appraisal'))
      .finally(() => setSelfLoading(false))
  }, [appraisalSection, appraisalMonth, appraisalYear, kraParams])

  // Load peer marking state when section opens
  useEffect(() => {
    if (appraisalSection !== 'peer') return
    brandingApi.getPeerMarkingCompleted(appraisalMonth, appraisalYear)
      .then(r => setCompletedPeers(r.completed))
      .catch(() => {})
  }, [appraisalSection, appraisalMonth, appraisalYear])

  // Load KRA report when download section opens
  useEffect(() => {
    if (appraisalSection !== 'download' || !profile) return
    brandingApi.getKraReport(profile.id, appraisalMonth, appraisalYear)
      .then(r => setKraReport(r.report))
      .catch(() => setKraReport(null))
  }, [appraisalSection, appraisalMonth, appraisalYear, profile])

  async function submitSelfAppraisal() {
    setSelfLoading(true)
    try {
      const res = await brandingApi.submitSelfAppraisal(appraisalMonth, appraisalYear, selfScores)
      setSelfAppraisal(res.appraisal)
      setConfirmSubmit(false)
      toast.success('Self appraisal submitted successfully!')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to submit')
    } finally {
      setSelfLoading(false)
    }
  }

  async function submitPeerMarking() {
    if (!peerColleague) { toast.error('Select a colleague first.'); return }
    setPeerSubmitting(true)
    try {
      await brandingApi.submitPeerMarking(peerColleague, appraisalMonth, appraisalYear, peerScores)
      setCompletedPeers(prev => [...prev, peerColleague])
      setPeerColleague('')
      setPeerScores(Object.fromEntries(kraParams.map(p => [p.id, 5])))
      toast.success('Peer marking submitted!')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to submit')
    } finally {
      setPeerSubmitting(false)
    }
  }

  const peerColleagueOptions = useMemo(() =>
    colleagueOptions.filter(o => !completedPeers.includes(o.id)),
    [colleagueOptions, completedPeers]
  )

  function printKraReport() {
    window.print()
  }

  // ── Locked report display ────────────────────────────────────────────────
  const displayRows = report?.is_locked ? report.rows : rows

  const totalHours = useMemo(() =>
    displayRows.reduce((s, r) => s + timeToHours(r.time_taken), 0),
    [displayRows]
  )

  return (
    <div className="animate-fade-in space-y-5">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-pink-100 flex items-center justify-center shrink-0">
          <Palette className="w-5 h-5 text-pink-600" />
        </div>
        <div>
          <h1 className="text-2xl font-serif text-foreground">
            Welcome{profile?.full_name ? `, ${profile.full_name}` : ''}
          </h1>
          <p className="text-sm text-muted-foreground">Branding Team · Work Portal</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-muted/40 p-1 rounded-xl w-fit">
        {[
          { key: 'reporting', icon: ClipboardList, label: 'Daily Reporting' },
          { key: 'appraisal', icon: Award,         label: 'Appraisal' },
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

      {/* ── TAB 1: DAILY REPORTING ─────────────────────────────────────────── */}
      {activeTab === 'reporting' && (
        <div className="space-y-5">
          {/* Date picker */}
          <div className="hub-card flex items-center gap-4 flex-wrap">
            <CalendarDays className="w-4 h-4 text-pink-500 shrink-0" />
            <div className="flex items-center gap-3">
              <label className="text-sm font-medium text-foreground">Report Date</label>
              <input
                type="date"
                value={selectedDate}
                max={today()}
                onChange={e => setSelectedDate(e.target.value)}
                className="text-sm border border-border rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-pink-300"
              />
            </div>
            {report?.is_locked && (
              <span className="flex items-center gap-1.5 text-xs font-medium text-amber-700 bg-amber-50 px-3 py-1.5 rounded-full">
                <Lock className="w-3 h-3" /> Submitted — read only
              </span>
            )}
            {!report?.is_locked && (
              <span className="text-xs text-muted-foreground">Draft — not yet submitted</span>
            )}
          </div>

          {/* Reporting table */}
          <div className="hub-card p-0 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm border-collapse min-w-[900px]">
                <thead>
                  <tr className="bg-pink-50 border-b border-border">
                    <th className="text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground px-3 py-3 w-12 text-center">Sr.</th>
                    <th className="text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground px-3 py-3 min-w-[160px]">Type of Work *</th>
                    <th className="text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground px-3 py-3 min-w-[160px]">Sub Category *</th>
                    <th className="text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground px-3 py-3 min-w-[200px]">Specific Work *</th>
                    <th className="text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground px-3 py-3 min-w-[120px]">Time Taken *</th>
                    <th className="text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground px-3 py-3 min-w-[160px]">Collaborative Work</th>
                    {!report?.is_locked && <th className="w-10" />}
                  </tr>
                </thead>
                <tbody>
                  {displayRows.length === 0 && (
                    <tr>
                      <td colSpan={7} className="text-center text-sm text-muted-foreground py-12">
                        No entries. Click <strong>Add Row</strong> to get started.
                      </td>
                    </tr>
                  )}
                  {(report?.is_locked ? report.rows : rows).map((row, i) => {
                    const isLocked = report?.is_locked
                    const key = (row as DraftRow)._key || (row as import('@/lib/branding-types').DailyReportRow).id
                    const subs = subCatOptions(row.type_of_work)
                    const showSubText = row.type_of_work === 'Others' ||
                      (subs.length > 0 && subs.find(s => s.name === row.sub_category)?.is_others)

                    return (
                      <tr key={key}
                        className={`border-b border-border last:border-0 group transition-colors hover:bg-pink-50/20 ${i % 2 === 1 ? 'bg-muted/10' : ''}`}>
                        <td className="px-3 py-2 text-xs text-muted-foreground font-medium text-center">{row.sr_no}</td>

                        {/* Type of Work */}
                        <td className="px-2 py-2">
                          {isLocked ? (
                            <span className="text-sm">{row.type_of_work}</span>
                          ) : (
                            <select value={row.type_of_work}
                              onChange={e => updateRow((row as DraftRow)._key, 'type_of_work', e.target.value)}
                              className={SEL}>
                              <option value="">Select…</option>
                              {categories.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
                            </select>
                          )}
                        </td>

                        {/* Sub Category */}
                        <td className="px-2 py-2">
                          {isLocked ? (
                            <span className="text-sm">{row.sub_category}</span>
                          ) : showSubText || row.type_of_work === 'Others' ? (
                            <input value={row.sub_category}
                              onChange={e => updateRow((row as DraftRow)._key, 'sub_category', e.target.value)}
                              placeholder="Type sub category…"
                              className={INP} />
                          ) : (
                            <select value={row.sub_category}
                              onChange={e => {
                                const v = e.target.value
                                updateRow((row as DraftRow)._key, 'sub_category', v)
                              }}
                              className={SEL}>
                              <option value="">Select…</option>
                              {subs.map(s => <option key={s.id} value={s.name}>{s.name}</option>)}
                            </select>
                          )}
                        </td>

                        {/* Specific Work */}
                        <td className="px-2 py-2">
                          {isLocked ? (
                            <span className="text-sm">{row.specific_work}</span>
                          ) : (
                            <input value={row.specific_work}
                              onChange={e => updateRow((row as DraftRow)._key, 'specific_work', e.target.value)}
                              placeholder="Describe the work done…"
                              className={INP} />
                          )}
                        </td>

                        {/* Time Taken */}
                        <td className="px-2 py-2">
                          {isLocked ? (
                            <span className="text-sm">{row.time_taken}</span>
                          ) : (
                            <select value={row.time_taken}
                              onChange={e => updateRow((row as DraftRow)._key, 'time_taken', e.target.value)}
                              className={SEL}>
                              <option value="">Select…</option>
                              {TIME_OPTIONS.map(t => <option key={t} value={t}>{t}</option>)}
                            </select>
                          )}
                        </td>

                        {/* Collaborative Colleagues */}
                        <td className="px-2 py-2">
                          {isLocked ? (
                            <span className="text-sm text-muted-foreground">
                              {row.collaborative_colleagues.length === 0
                                ? '—'
                                : row.collaborative_colleagues
                                    .map(id => colleagueOptions.find(o => o.id === id)?.label || id)
                                    .join(', ')}
                            </span>
                          ) : (
                            <ColleaguesSelect
                              options={colleagueOptions}
                              value={row.collaborative_colleagues}
                              onChange={v => updateRow((row as DraftRow)._key, 'collaborative_colleagues', v)}
                            />
                          )}
                        </td>

                        {/* Delete */}
                        {!isLocked && (
                          <td className="px-2 py-2">
                            <button onClick={() => deleteRow((row as DraftRow)._key)}
                              className="opacity-0 group-hover:opacity-100 p-1 rounded text-muted-foreground hover:text-destructive transition-all">
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </td>
                        )}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            {/* Table footer */}
            <div className="px-4 py-2.5 bg-muted/20 border-t border-border flex items-center justify-between flex-wrap gap-2">
              <span className="text-xs text-muted-foreground">
                {displayRows.length} {displayRows.length === 1 ? 'row' : 'rows'}
                {totalHours > 0 && ` · ${Math.round(totalHours * 10) / 10} hrs total`}
              </span>
              {!report?.is_locked && (
                <button onClick={addRow}
                  className="flex items-center gap-1 text-xs font-medium text-pink-600 hover:text-pink-700 transition-colors">
                  <Plus className="w-3.5 h-3.5" /> Add Row
                </button>
              )}
            </div>
          </div>

          {/* Action buttons */}
          {!report?.is_locked && (
            <div className="flex items-center gap-3">
              <button onClick={() => void saveDraft()} disabled={saving}
                className="px-4 py-2 rounded-lg border border-border text-sm font-medium text-foreground hover:bg-accent transition-colors disabled:opacity-50">
                {saving ? 'Saving…' : 'Save Draft'}
              </button>
              <button onClick={() => void submitReport()} disabled={submitting}
                className="flex items-center gap-2 px-5 py-2 rounded-lg bg-pink-600 text-white text-sm font-medium hover:bg-pink-700 transition-colors disabled:opacity-50">
                <Send className="w-4 h-4" />
                {submitting ? 'Submitting…' : 'Submit Report'}
              </button>
              <p className="text-xs text-muted-foreground">Once submitted, the report cannot be edited.</p>
            </div>
          )}

          {/* Analytics */}
          {profile && <AnalyticsSection userId={profile.id} />}
        </div>
      )}

      {/* ── TAB 2: APPRAISAL ──────────────────────────────────────────────── */}
      {activeTab === 'appraisal' && (
        <div className="space-y-5">
          {/* Section buttons */}
          <div className="grid grid-cols-3 gap-3">
            {[
              { key: 'self',     icon: ClipboardList, label: 'Self Appraisal',       desc: 'Evaluate your own KRA performance' },
              { key: 'peer',     icon: Users,          label: 'Staff KRA Marking',    desc: 'Anonymously mark your colleagues' },
              { key: 'download', icon: Download,       label: 'Download KRA Report',  desc: 'View & download your final KRA' },
            ].map(s => {
              const Icon = s.icon
              return (
                <button key={s.key} onClick={() => setAppraisalSection(prev => prev === s.key as typeof appraisalSection ? null : s.key as typeof appraisalSection)}
                  className={`hub-card text-left transition-all hover:shadow-md ${appraisalSection === s.key ? 'ring-2 ring-pink-400 bg-pink-50/40' : ''}`}>
                  <div className="flex items-center gap-3 mb-1">
                    <Icon className={`w-5 h-5 ${appraisalSection === s.key ? 'text-pink-600' : 'text-muted-foreground'}`} />
                    <span className="text-sm font-semibold text-foreground">{s.label}</span>
                  </div>
                  <p className="text-xs text-muted-foreground">{s.desc}</p>
                </button>
              )
            })}
          </div>

          {/* Month / Year selector (shared) */}
          {appraisalSection && (
            <div className="hub-card flex items-center gap-4 flex-wrap">
              <CalendarDays className="w-4 h-4 text-muted-foreground shrink-0" />
              <label className="text-sm font-medium">Period:</label>
              <select value={appraisalMonth} onChange={e => setAppraisalMonth(parseInt(e.target.value))}
                className="text-sm border border-border rounded-lg px-3 py-1.5 focus:outline-none">
                {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
              </select>
              <select value={appraisalYear} onChange={e => setAppraisalYear(parseInt(e.target.value))}
                className="text-sm border border-border rounded-lg px-3 py-1.5 focus:outline-none">
                {[2024, 2025, 2026, 2027].map(y => <option key={y} value={y}>{y}</option>)}
              </select>
            </div>
          )}

          {/* Self Appraisal */}
          {appraisalSection === 'self' && (
            <div className="hub-card space-y-5">
              <div className="flex items-center justify-between">
                <h2 className="text-base font-semibold text-foreground">Self Appraisal — {MONTHS[appraisalMonth - 1]} {appraisalYear}</h2>
                {selfAppraisal && <span className="flex items-center gap-1.5 text-xs font-medium text-green-700 bg-green-50 px-3 py-1 rounded-full"><Check className="w-3 h-3" /> Already Submitted</span>}
              </div>

              {selfLoading ? (
                <p className="text-sm text-muted-foreground text-center py-6 animate-pulse">Loading…</p>
              ) : kraParams.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-6">KRA parameters not configured.</p>
              ) : (
                <>
                  <KraForm params={kraParams} scores={selfScores} onChange={setSelfScores} readOnly={!!selfAppraisal} />

                  {!selfAppraisal && !confirmSubmit && (
                    <button onClick={() => setConfirmSubmit(true)}
                      className="w-full py-2.5 rounded-lg bg-pink-600 text-white text-sm font-medium hover:bg-pink-700 transition-colors">
                      Submit Self Appraisal
                    </button>
                  )}

                  {!selfAppraisal && confirmSubmit && (
                    <div className="p-4 bg-amber-50 border border-amber-200 rounded-xl space-y-3">
                      <p className="text-sm font-medium text-amber-800">
                        You are about to submit your Self Appraisal for {MONTHS[appraisalMonth - 1]} {appraisalYear}.
                        <strong className="block mt-1">This cannot be edited after submission. Are you sure?</strong>
                      </p>
                      <div className="flex gap-3">
                        <button onClick={() => void submitSelfAppraisal()} disabled={selfLoading}
                          className="flex-1 py-2 rounded-lg bg-amber-600 text-white text-sm font-medium hover:bg-amber-700 disabled:opacity-50">
                          Yes, submit
                        </button>
                        <button onClick={() => setConfirmSubmit(false)}
                          className="px-4 py-2 rounded-lg border border-border text-sm text-muted-foreground hover:bg-accent">
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {/* Peer KRA Marking */}
          {appraisalSection === 'peer' && (
            <div className="hub-card space-y-5">
              <h2 className="text-base font-semibold text-foreground">Anonymous Staff KRA Marking — {MONTHS[appraisalMonth - 1]} {appraisalYear}</h2>

              {!peerEnabled ? (
                <div className="flex items-start gap-3 p-4 bg-muted/40 rounded-xl">
                  <AlertCircle className="w-5 h-5 text-muted-foreground shrink-0 mt-0.5" />
                  <p className="text-sm text-muted-foreground">
                    This feature is currently not available. Please contact your Admin for support.
                  </p>
                </div>
              ) : (
                <>
                  <div>
                    <label className="text-sm font-medium text-foreground block mb-2">Select Colleague</label>
                    <select value={peerColleague} onChange={e => {
                      setPeerColleague(e.target.value)
                      setPeerScores(Object.fromEntries(kraParams.map(p => [p.id, 5])))
                    }} className={SEL + ' max-w-xs'}>
                      <option value="">Select a colleague…</option>
                      {peerColleagueOptions.map(o => (
                        <option key={o.id} value={o.id}>{o.label}</option>
                      ))}
                    </select>
                    {completedPeers.length > 0 && (
                      <p className="text-xs text-muted-foreground mt-1">
                        Already marked: {completedPeers
                          .map(id => colleagueOptions.find(o => o.id === id)?.label || id)
                          .join(', ')}
                      </p>
                    )}
                  </div>

                  {peerColleague && kraParams.length > 0 && (
                    <>
                      <div className="p-3 bg-blue-50 border border-blue-100 rounded-xl text-xs text-blue-700">
                        Your identity will remain anonymous. Once submitted, this marking is locked.
                      </div>
                      <KraForm params={kraParams} scores={peerScores} onChange={setPeerScores} />
                      <button onClick={() => void submitPeerMarking()} disabled={peerSubmitting}
                        className="w-full py-2.5 rounded-lg bg-pink-600 text-white text-sm font-medium hover:bg-pink-700 disabled:opacity-50">
                        {peerSubmitting ? 'Submitting…' : 'Submit Peer Marking'}
                      </button>
                    </>
                  )}

                  {peerColleagueOptions.length === 0 && (
                    <div className="flex items-center gap-2 p-3 bg-green-50 border border-green-100 rounded-xl">
                      <Check className="w-4 h-4 text-green-600" />
                      <p className="text-sm text-green-700">You have marked all your colleagues for this period.</p>
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {/* Download KRA Report */}
          {appraisalSection === 'download' && (
            <div className="hub-card space-y-5">
              <h2 className="text-base font-semibold text-foreground">KRA Report — {MONTHS[appraisalMonth - 1]} {appraisalYear}</h2>

              {!kraReport?.is_final_pushed ? (
                <div className="flex items-start gap-3 p-4 bg-muted/40 rounded-xl">
                  <Lock className="w-5 h-5 text-muted-foreground shrink-0 mt-0.5" />
                  <div>
                    <p className="text-sm font-medium text-foreground">Report not available yet</p>
                    <p className="text-sm text-muted-foreground">Your KRA is pending Admin review and approval.</p>
                  </div>
                </div>
              ) : kraReport && kraParams.length > 0 ? (
                <div className="space-y-5">
                  <div className="grid grid-cols-3 gap-3">
                    {[
                      { label: 'Self Score', value: kraReport.self_appraisal ? (Object.values(kraReport.self_appraisal.scores).reduce((a, b) => a + b, 0) / kraParams.length).toFixed(1) : '—', color: 'bg-pink-50 text-pink-700' },
                      { label: 'Peer Avg Score', value: Object.keys(kraReport.peer_average).length ? (Object.values(kraReport.peer_average).reduce((a, b) => a + b, 0) / kraParams.length).toFixed(1) : '—', color: 'bg-blue-50 text-blue-700' },
                      { label: 'Final Score', value: kraReport.composite_score?.toFixed(1) ?? '—', color: 'bg-green-50 text-green-700' },
                    ].map(s => (
                      <div key={s.label} className={`p-4 rounded-xl ${s.color}`}>
                        <p className="text-xs font-medium uppercase tracking-wider opacity-70">{s.label}</p>
                        <p className="text-3xl font-serif mt-1">{s.value}<span className="text-sm font-normal opacity-60">/10</span></p>
                      </div>
                    ))}
                  </div>

                  <div>
                    <h3 className="text-sm font-semibold text-foreground mb-3">Parameter Breakdown</h3>
                    <KraForm params={kraParams} scores={kraReport.self_appraisal?.scores || {}} readOnly />
                  </div>

                  <button onClick={printKraReport}
                    className="flex items-center gap-2 px-5 py-2.5 rounded-lg bg-pink-600 text-white text-sm font-medium hover:bg-pink-700 transition-colors">
                    <Download className="w-4 h-4" /> Download / Print PDF
                  </button>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground text-center py-6">No KRA data found for this period.</p>
              )}
            </div>
          )}
        </div>
      )}

      {/* Click-away for colleague dropdown */}
      {/* Dismiss handling done inside ColleaguesSelect */}
      <div className="h-4" />
    </div>
  )
}
