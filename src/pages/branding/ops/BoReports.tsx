import { FileBarChart, AlertTriangle } from 'lucide-react'
import { boReports } from '@/lib/brandops-api'
import { BoPage, BoError, BoLoading, BoKpi, BoTable, BoRow, BoCell, useBoData } from './ui'

/**
 * Inventory totals, and the reconciliation against the source spreadsheet.
 * The sheet disagrees with itself — that is shown rather than resolved,
 * because picking a number would be inventing data.
 */
export default function BoReports() {
  const { data, error, loading } = useBoData(() => boReports(), [])

  if (loading) return <BoLoading />
  if (error) return <BoError message={error} />
  if (!data) return null
  const { kpis: k, sizes, institutes, sheet } = data
  const holding = institutes.filter(i => i.frames_in_use > 0)

  return (
    <BoPage title="Reports" icon={FileBarChart} subtitle="Inventory totals by size and institute.">
      <div className="grid grid-cols-2 lg:grid-cols-6 gap-3">
        <BoKpi label="Total frames" value={k.totalFrames} />
        <BoKpi label="Available" value={k.available} />
        <BoKpi label="In use" value={k.inUse} />
        <BoKpi label="Removed" value={k.retired} />
        <BoKpi label="Tracked sizes" value={k.distinctSizes} />
        <BoKpi label="Institutes" value={k.totalInstitutes} />
      </div>

      {k.sheetLineTotal !== k.sheetStatedTotal && (
        <div className="hub-card bg-amber-50 border-amber-200 flex items-start gap-2 text-xs text-amber-900">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <div>
            <b>Source sheet disagrees with itself.</b> Its line-item quantities add up
            to {k.sheetLineTotal}, while its Total row says {k.sheetStatedTotal}. The line items were
            loaded, since they carry the detail. The {Math.abs(k.sheetLineTotal - k.sheetStatedTotal)}-frame
            difference needs a human decision — nothing here can tell which figure is the error.
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <div>
          <h2 className="text-[11px] uppercase tracking-widest text-muted-foreground mb-2">Stock by size</h2>
          <BoTable head={['Size', 'Total', 'Available', 'In use']}>
            {sizes.map(s => (
              <BoRow key={s.size}>
                <BoCell strong>{s.size}</BoCell>
                <BoCell nowrap>{s.total}</BoCell>
                <BoCell nowrap><span className="text-emerald-700">{s.available}</span></BoCell>
                <BoCell nowrap><span className={s.in_use ? 'text-rose-600' : ''}>{s.in_use}</span></BoCell>
              </BoRow>
            ))}
          </BoTable>
        </div>

        <div>
          <h2 className="text-[11px] uppercase tracking-widest text-muted-foreground mb-2">
            Institutes currently holding frames
          </h2>
          <BoTable head={['Institute', 'Faculty', 'Frames']} empty="No institute is holding frames.">
            {holding.map(i => (
              <BoRow key={i.id}>
                <BoCell strong>{i.name}</BoCell>
                <BoCell>{i.faculty}</BoCell>
                <BoCell nowrap>{i.frames_in_use}</BoCell>
              </BoRow>
            ))}
          </BoTable>
        </div>
      </div>

      <div>
        <h2 className="text-[11px] uppercase tracking-widest text-muted-foreground mb-2">
          Source sheet — as loaded
        </h2>
        <BoTable head={['Frame size', 'Quantity in sheet']}>
          {sheet.map(([size, qty]) => (
            <BoRow key={size}>
              <BoCell strong>{size}</BoCell>
              <BoCell nowrap>{qty}</BoCell>
            </BoRow>
          ))}
          <BoRow key="__total">
            <BoCell strong>Line-item total</BoCell>
            <BoCell strong nowrap>{k.sheetLineTotal}</BoCell>
          </BoRow>
        </BoTable>
      </div>
    </BoPage>
  )
}
