import { LogIn, LogOut } from 'lucide-react'
import { boVisits, boCheckIn, boCheckOut, boWhen, WO_STATUS_STYLE } from '@/lib/brandops-api'
import {
  BoPage, BoError, BoLoading, BoEmpty, BoBadge, BoTable, BoRow, BoCell, BoButton,
  useBoData, useBoAction,
} from './ui'

/**
 * §"Date/time should be captured automatically when the vendor arrives and
 * leaves" — the timestamps come from the server, so this is an attendance
 * record rather than something anyone can type.
 */
export default function BoVisits() {
  const { data, error, loading, refresh, setError } = useBoData(() => boVisits(), [])
  const { busy, act } = useBoAction(refresh, setError)

  const open = (data?.work_orders ?? []).filter(w => w.status !== 'closed')

  return (
    <BoPage title="Vendor Visits" icon={LogIn}
      subtitle="Check vendors in and out on site. Times are recorded by the system.">
      <BoError message={error} />

      {loading ? <BoLoading /> : open.length === 0 ? (
        <BoEmpty>No open work orders to check a vendor in against.</BoEmpty>
      ) : (
        <div className="space-y-2">
          {open.map(w => (
            <div key={w.id} className="hub-card flex items-center justify-between gap-4 flex-wrap">
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">
                  {w.reference} · {w.vendor_name}
                </p>
                <p className="text-xs text-muted-foreground">
                  {w.institute_name} · assigned {w.assigned_date}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <BoBadge style={WO_STATUS_STYLE[w.status]} />
                {w.open_visit_id ? (
                  <BoButton variant="ghost" disabled={busy} onClick={() => void act(() => boCheckOut(w.id))}>
                    <LogOut className="w-3.5 h-3.5" /> Check out
                  </BoButton>
                ) : (
                  <BoButton disabled={busy} onClick={() => void act(() => boCheckIn(w.id))}>
                    <LogIn className="w-3.5 h-3.5" /> Check in
                  </BoButton>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <div>
        <h2 className="text-[11px] uppercase tracking-widest text-muted-foreground mb-2">Visit log</h2>
        <BoTable head={['Work order', 'Vendor', 'Institute', 'Checked in', 'Checked out', 'On site', 'Notes']}
          empty="No visits recorded yet.">
          {(data?.visits ?? []).map(v => {
            const mins = v.check_out_at
              ? Math.round((new Date(v.check_out_at).getTime() - new Date(v.check_in_at).getTime()) / 60000)
              : null
            return (
              <BoRow key={v.id}>
                <BoCell strong nowrap>{v.work_order_reference}</BoCell>
                <BoCell>{v.vendor_name}</BoCell>
                <BoCell>{v.institute_name}</BoCell>
                <BoCell nowrap>{boWhen(v.check_in_at)}</BoCell>
                <BoCell nowrap>{v.check_out_at ? boWhen(v.check_out_at) : <span className="text-emerald-700">On site now</span>}</BoCell>
                <BoCell nowrap>{mins === null ? '—' : mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)}h ${mins % 60}m`}</BoCell>
                <BoCell>{v.notes || '—'}</BoCell>
              </BoRow>
            )
          })}
        </BoTable>
      </div>
    </BoPage>
  )
}
