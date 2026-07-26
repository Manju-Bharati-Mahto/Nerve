/**
 * Production pipeline board (FR-4.6, W6): department-wide Kanban of
 * deliverables by status. Moves use an accessible move-to menu (the §10
 * tap-alternative); permission and state rules are enforced server-side.
 */
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { KanbanSquare, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { mediaApi } from '@/lib/media-api'
import { useMedia } from './MediaShell'
import {
  MEDIA_GREEN, DELIVERABLE_STATUS_META, MEDIA_DELIVERABLE_STATUSES, todayISO,
  type MediaDeliverable, type MediaDeliverableStatus,
} from '@/lib/media-types'

const COLUMNS: MediaDeliverableStatus[] = [
  'not_started', 'in_progress', 'in_review', 'changes_requested', 'approved', 'delivered',
]

export default function MediaPipeline() {
  const { lookups, team } = useMedia()
  const [items, setItems] = useState<MediaDeliverable[]>([])
  const [typeFilter, setTypeFilter] = useState('')
  const [ownerFilter, setOwnerFilter] = useState('')
  const [loading, setLoading] = useState(true)

  const load = () => {
    setLoading(true)
    mediaApi.listDeliverables().then(r => setItems(r.deliverables)).finally(() => setLoading(false))
  }
  useEffect(load, [])

  const filtered = useMemo(() => items.filter(d => {
    if (typeFilter && d.deliverable_type_id !== typeFilter) return false
    if (ownerFilter && d.owner_id !== ownerFilter) return false
    return true
  }), [items, typeFilter, ownerFilter])

  const byStatus = useMemo(() => {
    const m = new Map<string, MediaDeliverable[]>()
    for (const c of MEDIA_DELIVERABLE_STATUSES) m.set(c, [])
    for (const d of filtered) m.get(d.status)?.push(d)
    return m
  }, [filtered])

  const typeById = useMemo(() => new Map(lookups.deliverable_types.map(t => [t.id, t.name])), [lookups])
  const userById = useMemo(() => new Map(team.map(u => [u.id, u.full_name])), [team])
  const today = todayISO()

  async function move(d: MediaDeliverable, to: string) {
    try {
      if (to === 'delivered') await mediaApi.markDelivered(d.id)
      else await mediaApi.updateDeliverable(d.id, { status: to })
      load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Move not allowed — review states go through the version workflow.')
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: MEDIA_GREEN }}>
            <KanbanSquare className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-lg font-extrabold font-serif" style={{ color: MEDIA_GREEN }}>Production Pipeline</h1>
            <p className="text-sm text-gray-500">Every deliverable in the department, by status.</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <select value={typeFilter} onChange={e => setTypeFilter(e.target.value)}
            className="text-sm border border-gray-200 rounded-xl px-3 py-2 bg-white">
            <option value="">All types</option>
            {lookups.deliverable_types.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <select value={ownerFilter} onChange={e => setOwnerFilter(e.target.value)}
            className="text-sm border border-gray-200 rounded-xl px-3 py-2 bg-white">
            <option value="">All owners</option>
            {team.map(u => <option key={u.id} value={u.id}>{u.full_name}</option>)}
          </select>
          <button onClick={load} className="p-2 rounded-xl border border-gray-200 text-gray-500 hover:bg-gray-50">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      <div className="overflow-x-auto pb-2">
        <div className="flex gap-3 min-w-[1100px]">
          {COLUMNS.map(col => {
            const meta = DELIVERABLE_STATUS_META[col]
            const cards = byStatus.get(col) ?? []
            return (
              <div key={col} className="flex-1 min-w-[180px]">
                <div className="flex items-center justify-between px-2 py-2">
                  <span className="text-[11px] font-bold uppercase tracking-wide" style={{ color: meta.fg }}>{meta.label}</span>
                  <span className="text-[10px] font-mono text-gray-400">{cards.length}</span>
                </div>
                <div className="space-y-2 min-h-[60px]">
                  {cards.map(d => {
                    const overdue = d.due_date && d.due_date < today && !['delivered', 'not_required', 'cancelled'].includes(d.status)
                    return (
                      <div key={d.id} className="bg-white rounded-xl border border-gray-100 shadow-sm p-3">
                        <Link to={`/media/projects/${d.project_id}`} className="block">
                          <p className="text-[10px] font-mono text-gray-400">{d.project_code}</p>
                          <p className="text-xs font-semibold text-gray-800 leading-snug">{d.title}</p>
                          <p className="text-[10px] text-gray-400 mt-1">
                            {typeById.get(d.deliverable_type_id)}
                            {d.owner_id ? ` · ${userById.get(d.owner_id) ?? ''}` : ' · unowned'}
                          </p>
                          {d.due_date && (
                            <p className={`text-[10px] mt-0.5 font-semibold ${overdue ? 'text-rose-600' : 'text-gray-400'}`}>
                              due {d.due_date}{overdue ? ' · OVERDUE' : ''}
                            </p>
                          )}
                        </Link>
                        <select className="mt-2 w-full text-[10px] border border-gray-100 rounded-lg px-1.5 py-1 text-gray-500 bg-gray-50"
                          value={d.status} onChange={e => move(d, e.target.value)} title="Move to…">
                          {MEDIA_DELIVERABLE_STATUSES.map(s => (
                            <option key={s} value={s}>{DELIVERABLE_STATUS_META[s].label}</option>
                          ))}
                        </select>
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>
      </div>
      <p className="text-[11px] text-gray-400">
        Review states (In Review → Approved) move through the version workflow on the project page — submitting a version or reviewing it moves the card automatically. Delivered requires an approved version (raw types exempt).
      </p>
    </div>
  )
}
