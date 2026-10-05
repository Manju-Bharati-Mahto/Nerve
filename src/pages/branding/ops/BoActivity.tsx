import { useState } from 'react'
import { History, Trash2 } from 'lucide-react'
import { boActivity, boClearActivity, boMe, boWhen } from '@/lib/brandops-api'
import {
  BoPage, BoError, BoLoading, BoEmpty, BoButton, BoSearch, BoSelect, useBoData, useBoAction,
} from './ui'

const MODULES = [
  'Frame Inventory', 'Frame Allocation', 'Frame Return', 'Institutes', 'Vendors',
  'Branding Requests', 'Quotations', 'Approvals', 'Work Orders', 'Vendor Visits',
  'Work Completion', 'Material Delivery', 'Activity',
]

/** Everything that happened, who did it, and when. */
export default function BoActivity() {
  const [q, setQ] = useState('')
  const [module, setModule] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')

  const { data, error, loading, refresh, setError } = useBoData(async () => {
    const [activity, me] = await Promise.all([
      boActivity({ q: q.trim() || undefined, module: module || undefined, from: from || undefined, to: to || undefined }),
      boMe(),
    ])
    return { activity: activity.activity, admin: me.admin }
  }, [q, module, from, to])
  const { busy, act } = useBoAction(refresh, setError)

  const rows = data?.activity ?? []

  return (
    <BoPage title="Activity Log" icon={History}
      subtitle="Every BrandOps action across all modules, newest first."
      actions={data?.admin ? (
        <BoButton variant="danger" disabled={busy}
          onClick={() => { if (confirm('Clear the entire activity log? This cannot be undone.')) void act(() => boClearActivity()) }}>
          <Trash2 className="w-3.5 h-3.5" /> Clear log
        </BoButton>
      ) : undefined}>

      <div className="hub-card flex flex-wrap items-center gap-2">
        <BoSearch value={q} onChange={setQ} placeholder="Search action, detail or person…" />
        <BoSelect label="All modules" value={module} onChange={setModule}
          options={MODULES.map(m => [m, m] as [string, string])} />
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          From <input type="date" className="hub-input py-1.5 text-xs w-auto" value={from}
            onChange={e => setFrom(e.target.value)} />
        </label>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          To <input type="date" className="hub-input py-1.5 text-xs w-auto" value={to}
            onChange={e => setTo(e.target.value)} />
        </label>
      </div>

      <BoError message={error} />

      {loading ? <BoLoading /> : rows.length === 0 ? (
        <BoEmpty>No activity recorded yet.</BoEmpty>
      ) : (
        <div className="hub-card">
          <ol className="space-y-3.5">
            {rows.map(a => (
              <li key={a.id} className="flex gap-3">
                <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-[#0047AB] shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-foreground">
                    <span className="font-medium">{a.action}</span>
                    {a.details && <span className="text-muted-foreground"> — {a.details}</span>}
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    {a.actor_name || 'System'} · {boWhen(a.created_at)}
                  </p>
                </div>
                <span className="text-[11px] text-muted-foreground shrink-0 whitespace-nowrap">{a.module}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </BoPage>
  )
}
