/**
 * Admin — lookup-driven configuration (NFR-10): project types, deliverable
 * types, task categories, capacity roles (add / rename / deactivate — VR-11
 * deactivation, never delete), project templates (FR-3.2), and the audit
 * browser (FR-13.3).
 */
import { useEffect, useState } from 'react'
import { Settings2, Plus, Power } from 'lucide-react'
import { toast } from 'sonner'
import { mediaApi } from '@/lib/media-api'
import { useMedia } from './MediaShell'
import { MEDIA_GREEN, type MediaTemplateRow } from '@/lib/media-types'

const LOOKUPS: Array<{ type: string; label: string; hint: string }> = [
  { type: 'project_types', label: 'Project types', hint: 'Annual Event, Tour, Deputation…' },
  { type: 'deliverable_types', label: 'Deliverable types', hint: 'Aftermovie, Reel, Photos…' },
  { type: 'task_categories', label: 'Task categories', hint: 'Shooting, Editing, Travel…' },
  { type: 'capacity_roles', label: 'Capacity roles', hint: 'Photographer, Editor…' },
]

export default function MediaAdmin() {
  const { lookups, refresh } = useMedia()
  const [tab, setTab] = useState<'lookups' | 'templates' | 'audit'>('lookups')

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: MEDIA_GREEN }}>
          <Settings2 className="w-5 h-5 text-white" />
        </div>
        <div>
          <h1 className="text-lg font-extrabold font-serif" style={{ color: MEDIA_GREEN }}>Media Ops Admin</h1>
          <p className="text-sm text-gray-500">Lookups, project templates and the audit trail — all configurable without deployments.</p>
        </div>
      </div>

      <div className="flex gap-1 bg-white rounded-2xl border border-gray-100 shadow-sm p-1.5 max-w-md">
        {([['lookups', 'Lookups'], ['templates', 'Templates'], ['audit', 'Audit log']] as const).map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)}
            className={`flex-1 py-2 rounded-xl text-xs font-bold transition-colors ${tab === k ? 'text-white' : 'text-gray-500 hover:bg-gray-50'}`}
            style={tab === k ? { background: MEDIA_GREEN } : undefined}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'lookups' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          {LOOKUPS.map(cfg => (
            <LookupPanel key={cfg.type} {...cfg}
              items={(lookups as unknown as Record<string, Array<{ id: string; name: string; is_active: boolean }>>)[cfg.type] ?? []}
              onChanged={refresh} />
          ))}
        </div>
      )}
      {tab === 'templates' && <TemplatesPanel />}
      {tab === 'audit' && <AuditPanel />}
    </div>
  )
}

function LookupPanel({ type, label, hint, items, onChanged }: {
  type: string; label: string; hint: string
  items: Array<{ id: string; name: string; is_active: boolean }>
  onChanged: () => void
}) {
  const [name, setName] = useState('')

  async function add() {
    if (!name.trim()) return
    try {
      await mediaApi.createLookup(type, name.trim())
      setName(''); onChanged(); toast.success('Added.')
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed.') }
  }

  async function toggle(id: string, active: boolean) {
    try { await mediaApi.updateLookup(type, id, { is_active: !active }); onChanged() }
    catch (e) { toast.error(e instanceof Error ? e.message : 'Failed.') }
  }

  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4">
      <h2 className="text-sm font-bold" style={{ color: MEDIA_GREEN }}>{label}</h2>
      <p className="text-[11px] text-gray-400 mb-3">{hint}</p>
      <div className="flex gap-2 mb-3">
        <input value={name} onChange={e => setName(e.target.value)} onKeyDown={e => e.key === 'Enter' && add()}
          placeholder={`New ${label.toLowerCase().replace(/s$/, '')}…`}
          className="flex-1 text-sm border border-gray-200 rounded-xl px-3 py-2 focus:outline-none focus:ring-2 focus:ring-green-200" />
        <button onClick={add} className="px-3 py-2 rounded-xl text-white" style={{ background: MEDIA_GREEN }}><Plus className="w-4 h-4" /></button>
      </div>
      <div className="space-y-1 max-h-56 overflow-y-auto">
        {items.map(i => (
          <div key={i.id} className={`flex items-center justify-between px-2 py-1.5 rounded-lg ${i.is_active ? '' : 'opacity-40'}`}>
            <span className="text-xs text-gray-700">{i.name}</span>
            <button onClick={() => toggle(i.id, i.is_active)} title={i.is_active ? 'Deactivate' : 'Reactivate'}
              className="p-1 rounded-md text-gray-400 hover:text-gray-700 hover:bg-gray-100"><Power className="w-3.5 h-3.5" /></button>
          </div>
        ))}
      </div>
    </div>
  )
}

function TemplatesPanel() {
  const { lookups } = useMedia()
  const [typeId, setTypeId] = useState('')
  const [rows, setRows] = useState<MediaTemplateRow[]>([])
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (typeId) mediaApi.templates(typeId).then(r => setRows(r.templates))
    else setRows([])
  }, [typeId])

  function addRow() {
    const first = lookups.deliverable_types[0]
    if (!first) return
    setRows(rs => [...rs, { id: `new-${rs.length}`, project_type_id: typeId, deliverable_type_id: first.id, default_weight: first.default_weight ?? 1, days_offset_due: null }])
  }

  async function save() {
    setSaving(true)
    try {
      const r = await mediaApi.setTemplates(typeId, rows.map(x => ({
        deliverable_type_id: x.deliverable_type_id, default_weight: x.default_weight, days_offset_due: x.days_offset_due,
      })))
      setRows(r.templates)
      toast.success('Template saved — new projects of this type get these deliverables.')
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed.') } finally { setSaving(false) }
  }

  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4 space-y-3">
      <h2 className="text-sm font-bold" style={{ color: MEDIA_GREEN }}>Project templates (FR-3.2)</h2>
      <select value={typeId} onChange={e => setTypeId(e.target.value)}
        className="text-sm border border-gray-200 rounded-xl px-3 py-2 bg-white">
        <option value="">Pick a project type…</option>
        {lookups.project_types.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
      </select>
      {typeId && (
        <>
          {rows.length === 0 ? <p className="text-xs text-gray-400 py-3">No template deliverables — new projects of this type start empty.</p> : (
            <div className="space-y-2">
              {rows.map((r, idx) => (
                <div key={r.id} className="flex items-center gap-2">
                  <select value={r.deliverable_type_id}
                    onChange={e => setRows(rs => rs.map((x, i) => i === idx ? { ...x, deliverable_type_id: e.target.value } : x))}
                    className="flex-1 text-xs border border-gray-200 rounded-xl px-2 py-1.5 bg-white">
                    {lookups.deliverable_types.map(dt => <option key={dt.id} value={dt.id}>{dt.name}</option>)}
                  </select>
                  <label className="text-[10px] text-gray-400">weight</label>
                  <input type="number" min={1} max={10} value={r.default_weight}
                    onChange={e => setRows(rs => rs.map((x, i) => i === idx ? { ...x, default_weight: parseInt(e.target.value, 10) || 1 } : x))}
                    className="w-14 text-xs border border-gray-200 rounded-xl px-2 py-1.5" />
                  <label className="text-[10px] text-gray-400">due +days</label>
                  <input type="number" value={r.days_offset_due ?? ''}
                    onChange={e => setRows(rs => rs.map((x, i) => i === idx ? { ...x, days_offset_due: e.target.value === '' ? null : parseInt(e.target.value, 10) } : x))}
                    className="w-16 text-xs border border-gray-200 rounded-xl px-2 py-1.5" placeholder="—" />
                  <button onClick={() => setRows(rs => rs.filter((_, i) => i !== idx))} className="text-xs text-rose-500 hover:underline">remove</button>
                </div>
              ))}
            </div>
          )}
          <div className="flex gap-2">
            <button onClick={addRow} className="text-xs font-semibold px-3 py-2 rounded-xl border border-gray-200 text-gray-600 hover:bg-gray-50">+ Add row</button>
            <button onClick={save} disabled={saving} className="text-xs font-bold px-4 py-2 rounded-xl text-white disabled:opacity-50" style={{ background: MEDIA_GREEN }}>
              {saving ? 'Saving…' : 'Save template'}
            </button>
          </div>
        </>
      )}
    </div>
  )
}

function AuditPanel() {
  const [logs, setLogs] = useState<Array<Record<string, unknown>>>([])
  useEffect(() => { mediaApi.auditLogs().then(r => setLogs(r.logs)) }, [])

  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-[10px] uppercase tracking-widest text-gray-400 border-b border-gray-100">
            <th className="px-4 py-2.5">When</th>
            <th className="px-4 py-2.5">Actor</th>
            <th className="px-4 py-2.5">Action</th>
            <th className="px-4 py-2.5">Entity</th>
          </tr>
        </thead>
        <tbody>
          {logs.length === 0 ? (
            <tr><td colSpan={4} className="px-4 py-10 text-center text-sm text-gray-400">No audit entries yet.</td></tr>
          ) : logs.map((l, i) => (
            <tr key={i} className="border-b border-gray-50 last:border-0">
              <td className="px-4 py-2 text-[11px] text-gray-400 whitespace-nowrap">{new Date(String(l.occurred_at)).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</td>
              <td className="px-4 py-2 text-xs text-gray-700">{String(l.actor_name ?? 'System')}</td>
              <td className="px-4 py-2 text-xs font-mono text-gray-600">{String(l.action)}</td>
              <td className="px-4 py-2 text-[11px] text-gray-400">{String(l.entity_type)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
