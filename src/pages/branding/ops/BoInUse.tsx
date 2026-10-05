import { Radio } from 'lucide-react'
import { boAllocations, boIsOverdue } from '@/lib/brandops-api'
import { BoPage, BoError, BoLoading, BoEmpty, BoKpi, useBoData } from './ui'

/** §"In Use Frames": which size is deployed, where, and for how long. */
export default function BoInUse() {
  const { data, error, loading } = useBoData(() => boAllocations({ open: true }), [])
  const list = data?.allocations ?? []
  const overdue = list.filter(a => boIsOverdue(a.until_date))

  return (
    <BoPage title="In Use Frames" icon={Radio}
      subtitle="Every deployed frame, where it is and the period it is out for.">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <BoKpi label="Deployed" value={list.length} />
        <BoKpi label="Overdue back" value={overdue.length} accent={overdue.length > 0} />
        <BoKpi label="Institutes holding" value={new Set(list.map(a => a.institute_id)).size} />
        <BoKpi label="Sizes out" value={new Set(list.map(a => a.size)).size} />
      </div>

      <BoError message={error} />

      {loading ? <BoLoading /> : list.length === 0 ? (
        <BoEmpty>No frames are currently in use.</BoEmpty>
      ) : (
        <div className="space-y-3">
          {list.map(a => {
            const late = boIsOverdue(a.until_date)
            return (
              <div key={a.id} className={`hub-card ${late ? 'border-rose-300 bg-rose-50/40' : ''}`}>
                <div className="flex items-start justify-between gap-3 flex-wrap mb-3">
                  <div>
                    <span className="text-sm font-semibold text-foreground">{a.asset_id}</span>
                    <span className="text-xs text-muted-foreground ml-2">{a.size}</span>
                  </div>
                  <span className={`hub-badge ${late ? 'bg-rose-100 text-rose-700' : 'bg-rose-100 text-rose-700'}`}>
                    {late ? 'Overdue' : 'In Use'}
                  </span>
                </div>
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                  <Cell label="Institute" value={a.institute_name} />
                  <Cell label="Exact location" value={a.location} />
                  <Cell label="Usage period" value={`${a.from_date} → ${a.until_date}`} />
                  <Cell label="Event" value={a.event || '—'} />
                </div>
              </div>
            )
          })}
        </div>
      )}
    </BoPage>
  )
}

function Cell({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-muted/40 rounded-lg px-3 py-2">
      <div className="text-[10px] text-muted-foreground">{label}</div>
      <div className="text-xs font-medium text-foreground break-words">{value}</div>
    </div>
  )
}
