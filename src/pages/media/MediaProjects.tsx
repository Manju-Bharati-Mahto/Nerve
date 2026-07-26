/** Projects — list/table + create (FR-3.1/3.3 subset, FR-3.6 approval gate). */
import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { FolderKanban, Plus, Search, X } from 'lucide-react'
import { toast } from 'sonner'
import { mediaApi } from '@/lib/media-api'
import { useMedia } from './MediaShell'
import { MEDIA_GREEN, PROJECT_STATUS_META, fmtMinutes, type MediaProject } from '@/lib/media-types'

const inputCls = 'w-full text-sm border border-gray-200 rounded-xl px-3 py-2.5 bg-white focus:outline-none focus:ring-2 focus:ring-green-200'
const labelCls = 'text-xs font-bold uppercase tracking-wide mb-1 block'

export default function MediaProjects() {
  const { lookups, mediaRole } = useMedia()
  const [searchParams, setSearchParams] = useSearchParams()
  const [projects, setProjects] = useState<MediaProject[]>([])
  const [q, setQ] = useState('')
  const [status, setStatus] = useState('')
  const [type, setType] = useState('')
  const [creating, setCreating] = useState(searchParams.get('new') === '1')

  const load = () => { mediaApi.listProjects().then(r => setProjects(r.projects)) }
  useEffect(load, [])

  const typeById = useMemo(() => new Map(lookups.project_types.map(t => [t.id, t])), [lookups])

  const filtered = useMemo(() => projects.filter(p => {
    if (status && p.status !== status) return false
    if (type && p.project_type_id !== type) return false
    if (q && !`${p.name} ${p.code} ${p.faculty_served}`.toLowerCase().includes(q.toLowerCase())) return false
    return true
  }), [projects, q, status, type])

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: MEDIA_GREEN }}>
            <FolderKanban className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-lg font-extrabold font-serif" style={{ color: MEDIA_GREEN }}>Projects</h1>
            <p className="text-sm text-gray-500">Every event, tour, and campaign — one pipeline.</p>
          </div>
        </div>
        <button onClick={() => setCreating(true)}
          className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-sm font-semibold text-white hover:opacity-90" style={{ background: MEDIA_GREEN }}>
          <Plus className="w-4 h-4" /> New Project{mediaRole === 'employee' ? ' (proposal)' : ''}
        </button>
      </div>

      {/* Filters */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-3 flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search name, code, faculty…" className={`${inputCls} pl-9 py-2`} />
        </div>
        <select value={status} onChange={e => setStatus(e.target.value)} className={`${inputCls} w-40 py-2`}>
          <option value="">Any status</option>
          {Object.entries(PROJECT_STATUS_META).map(([k, m]) => <option key={k} value={k}>{m.label}</option>)}
        </select>
        <select value={type} onChange={e => setType(e.target.value)} className={`${inputCls} w-44 py-2`}>
          <option value="">Any type</option>
          {lookups.project_types.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        <span className="text-xs text-gray-400 ml-auto">{filtered.length} project{filtered.length === 1 ? '' : 's'}</span>
      </div>

      {/* Table */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-widest text-gray-400 border-b border-gray-100">
                <th className="px-4 py-2.5">Project</th>
                <th className="px-4 py-2.5">Type</th>
                <th className="px-4 py-2.5">Status</th>
                <th className="px-4 py-2.5 text-right">Progress</th>
                <th className="px-4 py-2.5 text-right">Logged</th>
                <th className="px-4 py-2.5">Dates</th>
                <th className="px-4 py-2.5">Priority</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr><td colSpan={7} className="px-4 py-12 text-center text-sm text-gray-400">No projects match.</td></tr>
              ) : filtered.map(p => {
                const t = typeById.get(p.project_type_id)
                const sm = PROJECT_STATUS_META[p.status]
                return (
                  <tr key={p.id} className="border-b border-gray-50 last:border-0 hover:bg-gray-50/60">
                    <td className="px-4 py-3">
                      <Link to={`/media/projects/${p.id}`} className="text-xs font-semibold text-gray-800 hover:underline">{p.name}</Link>
                      <p className="text-[10px] text-gray-400 font-mono">{p.code}{p.faculty_served ? ` · ${p.faculty_served}` : ''}</p>
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full" style={{ background: `${t?.color ?? '#6b7280'}18`, color: t?.color ?? '#6b7280' }}>{t?.name ?? '—'}</span>
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded-full" style={{ background: sm.bg, color: sm.fg }}>{sm.label}</span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="inline-flex items-center gap-1.5">
                        <div className="h-1.5 w-16 rounded-full bg-gray-100 overflow-hidden">
                          <div className="h-full rounded-full" style={{ width: `${p.progress ?? 0}%`, background: MEDIA_GREEN }} />
                        </div>
                        <span className="text-[10px] text-gray-400 font-mono tabular-nums">{p.progress ?? 0}%</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right text-[11px] text-gray-500 font-mono tabular-nums">{fmtMinutes(p.logged_minutes ?? 0)}</td>
                    <td className="px-4 py-3 text-[11px] text-gray-500">{p.start_date ?? '—'}{p.end_date ? ` → ${p.end_date}` : ''}</td>
                    <td className="px-4 py-3">
                      <span className={`text-[10px] font-bold uppercase ${p.priority === 'urgent' ? 'text-rose-600' : p.priority === 'high' ? 'text-amber-600' : 'text-gray-400'}`}>{p.priority}</span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {creating && (
        <CreateProjectModal onClose={() => { setCreating(false); setSearchParams({}) }} onCreated={() => { setCreating(false); setSearchParams({}); load() }} />
      )}
    </div>
  )
}

function CreateProjectModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { lookups, mediaRole } = useMedia()
  const currentYear = lookups.academic_years.find(y => y.is_current) ?? lookups.academic_years[0]
  const [form, setForm] = useState({
    name: '', project_type_id: '', academic_year_id: currentYear?.id ?? '',
    faculty_served: '', priority: 'normal', start_date: '', end_date: '', description: '',
  })
  const [saving, setSaving] = useState(false)

  async function save() {
    if (form.name.trim().length < 3) { toast.error('Name must be at least 3 characters.'); return }
    if (!form.project_type_id) { toast.error('Pick a project type.'); return }
    if (form.start_date && form.end_date && form.end_date < form.start_date) { toast.error('End date must be on or after the start date.'); return }
    setSaving(true)
    try {
      await mediaApi.createProject({
        ...form,
        start_date: form.start_date || null,
        end_date: form.end_date || null,
      })
      toast.success(mediaRole === 'employee'
        ? 'Proposal submitted — a lead will approve it before it becomes reportable.'
        : 'Project created with its template deliverables.')
      onCreated()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to create project.')
    } finally { setSaving(false) }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl w-full max-w-lg max-h-[92vh] overflow-y-auto p-5 space-y-3" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-base font-extrabold font-serif" style={{ color: MEDIA_GREEN }}>
            {mediaRole === 'employee' ? 'Propose a project' : 'New project'}
          </h2>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400"><X className="w-4 h-4" /></button>
        </div>

        <div>
          <label className={labelCls} style={{ color: MEDIA_GREEN }}>Name *</label>
          <input className={inputCls} value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Convocation 2026" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelCls} style={{ color: MEDIA_GREEN }}>Type *</label>
            <select className={inputCls} value={form.project_type_id} onChange={e => setForm(f => ({ ...f, project_type_id: e.target.value }))}>
              <option value="">Select…</option>
              {lookups.project_types.filter(t => t.is_active).map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </div>
          <div>
            <label className={labelCls} style={{ color: MEDIA_GREEN }}>Academic year *</label>
            <select className={inputCls} value={form.academic_year_id} onChange={e => setForm(f => ({ ...f, academic_year_id: e.target.value }))}>
              {lookups.academic_years.map(y => <option key={y.id} value={y.id}>{y.label}</option>)}
            </select>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelCls} style={{ color: MEDIA_GREEN }}>Start date</label>
            <input type="date" className={inputCls} value={form.start_date} onChange={e => setForm(f => ({ ...f, start_date: e.target.value }))} />
          </div>
          <div>
            <label className={labelCls} style={{ color: MEDIA_GREEN }}>End date</label>
            <input type="date" className={inputCls} value={form.end_date} min={form.start_date || undefined} onChange={e => setForm(f => ({ ...f, end_date: e.target.value }))} />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelCls} style={{ color: MEDIA_GREEN }}>Faculty / dept served</label>
            <input className={inputCls} value={form.faculty_served} onChange={e => setForm(f => ({ ...f, faculty_served: e.target.value }))} placeholder="e.g. Faculty of Engineering" />
          </div>
          <div>
            <label className={labelCls} style={{ color: MEDIA_GREEN }}>Priority</label>
            <select className={inputCls} value={form.priority} onChange={e => setForm(f => ({ ...f, priority: e.target.value }))}>
              <option value="urgent">Urgent</option><option value="high">High</option>
              <option value="normal">Normal</option><option value="low">Low</option>
            </select>
          </div>
        </div>
        <div>
          <label className={labelCls} style={{ color: MEDIA_GREEN }}>Description</label>
          <textarea className={`${inputCls} resize-none`} rows={2} value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} />
        </div>
        <p className="text-[11px] text-gray-400">The type's template auto-creates its standard deliverable set (e.g. Annual Event → Edited Photos, Aftermovie, Highlight Reel, Social Posts, Raw Archive).</p>

        <div className="flex gap-2 pt-1">
          <button onClick={onClose} className="flex-1 py-2.5 rounded-xl border border-gray-200 text-sm font-semibold text-gray-600 hover:bg-gray-50">Cancel</button>
          <button onClick={save} disabled={saving} className="flex-1 py-2.5 rounded-xl text-sm font-bold text-white disabled:opacity-50" style={{ background: MEDIA_GREEN }}>
            {saving ? 'Creating…' : mediaRole === 'employee' ? 'Submit proposal' : 'Create project'}
          </button>
        </div>
      </div>
    </div>
  )
}
