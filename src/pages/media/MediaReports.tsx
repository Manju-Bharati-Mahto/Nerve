/**
 * Daily Reports — exception-based review (D2, J4): leads/admin see the queue
 * (flagged first, with age) + today's team grid; everyone sees their own
 * history. Approve / Return with comment per FR-2.6.
 */
import { useEffect, useState } from 'react'
import { ClipboardList, Check, CornerUpLeft, ChevronDown, ChevronUp } from 'lucide-react'
import { toast } from 'sonner'
import { mediaApi } from '@/lib/media-api'
import { useMedia } from './MediaShell'
import { MEDIA_GREEN, REPORT_STATUS_META, fmtMinutes, todayISO, type MediaDailyReport } from '@/lib/media-types'

export default function MediaReports() {
  const { mediaRole } = useMedia()
  const isLead = mediaRole !== 'employee'
  const [tab, setTab] = useState<'queue' | 'today' | 'mine'>(isLead ? 'queue' : 'mine')

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: MEDIA_GREEN }}>
          <ClipboardList className="w-5 h-5 text-white" />
        </div>
        <div>
          <h1 className="text-lg font-extrabold font-serif" style={{ color: MEDIA_GREEN }}>Daily Reports</h1>
          <p className="text-sm text-gray-500">{isLead ? 'Exception-based review: flags first, everything else auto-approves in 48h.' : 'Your submission history.'}</p>
        </div>
      </div>

      {isLead && (
        <div className="flex gap-1 bg-white rounded-2xl border border-gray-100 shadow-sm p-1.5 max-w-md">
          {([['queue', 'Review queue'], ['today', "Today's team"], ['mine', 'My history']] as const).map(([k, label]) => (
            <button key={k} onClick={() => setTab(k)}
              className={`flex-1 py-2 rounded-xl text-xs font-bold transition-colors ${tab === k ? 'text-white' : 'text-gray-500 hover:bg-gray-50'}`}
              style={tab === k ? { background: MEDIA_GREEN } : undefined}>
              {label}
            </button>
          ))}
        </div>
      )}

      {tab === 'queue' && isLead && <ReviewQueue />}
      {tab === 'today' && isLead && <TodayGrid />}
      {tab === 'mine' && <MyHistory />}
    </div>
  )
}

function ReviewQueue() {
  const [queue, setQueue] = useState<MediaDailyReport[]>([])
  const load = () => { mediaApi.reviewQueue().then(r => setQueue(r.queue)) }
  useEffect(load, [])

  return queue.length === 0 ? (
    <div className="bg-white rounded-2xl border border-gray-100 p-10 text-center text-sm text-gray-400">
      Queue is clear — unflagged reports auto-approve 48h after submission.
    </div>
  ) : (
    <div className="space-y-3">
      {queue.map(r => <ReportCard key={r.id} report={r} reviewable onChanged={load} />)}
    </div>
  )
}

function TodayGrid() {
  const [reports, setReports] = useState<MediaDailyReport[]>([])
  const [date, setDate] = useState(todayISO())
  useEffect(() => { mediaApi.reportsForDate(date).then(r => setReports(r.reports)) }, [date])

  return (
    <div className="space-y-3">
      <input type="date" value={date} max={todayISO()} onChange={e => setDate(e.target.value)}
        className="text-sm border border-gray-200 rounded-xl px-3 py-2 bg-white" />
      {reports.length === 0 ? (
        <div className="bg-white rounded-2xl border border-gray-100 p-10 text-center text-sm text-gray-400">No reports for {date} yet.</div>
      ) : (
        <div className="space-y-3">
          {reports.map(r => <ReportCard key={r.id} report={r} reviewable={['submitted', 'flagged'].includes(r.status)} onChanged={() => mediaApi.reportsForDate(date).then(x => setReports(x.reports))} />)}
        </div>
      )}
    </div>
  )
}

function MyHistory() {
  const [reports, setReports] = useState<MediaDailyReport[]>([])
  useEffect(() => { mediaApi.myReportHistory().then(r => setReports(r.reports)) }, [])

  return reports.length === 0 ? (
    <div className="bg-white rounded-2xl border border-gray-100 p-10 text-center text-sm text-gray-400">No reports yet — log your first task from My Day.</div>
  ) : (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-[10px] uppercase tracking-widest text-gray-400 border-b border-gray-100">
            <th className="px-4 py-2.5">Date</th>
            <th className="px-4 py-2.5">Status</th>
            <th className="px-4 py-2.5 text-right">Hours</th>
            <th className="px-4 py-2.5">Submitted</th>
            <th className="px-4 py-2.5">Feedback</th>
          </tr>
        </thead>
        <tbody>
          {reports.map(r => {
            const m = REPORT_STATUS_META[r.status]
            return (
              <tr key={r.id} className="border-b border-gray-50 last:border-0">
                <td className="px-4 py-2.5 text-xs font-semibold text-gray-800">{r.report_date}</td>
                <td className="px-4 py-2.5"><span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded-full" style={{ background: m.bg, color: m.fg }}>{m.label}</span></td>
                <td className="px-4 py-2.5 text-right text-xs font-mono tabular-nums text-gray-500">{fmtMinutes(r.total_minutes)}</td>
                <td className="px-4 py-2.5 text-[11px] text-gray-400">{r.submitted_at ? new Date(r.submitted_at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'}</td>
                <td className="px-4 py-2.5 text-[11px] text-gray-500">{r.review_comment || r.flagged_reason || '—'}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function ReportCard({ report, reviewable, onChanged }: { report: MediaDailyReport; reviewable: boolean; onChanged: () => void }) {
  const [open, setOpen] = useState(false)
  const [full, setFull] = useState<MediaDailyReport | null>(null)
  const [comment, setComment] = useState('')
  const m = REPORT_STATUS_META[report.status]
  const age = report.submitted_at ? Math.round((Date.now() - new Date(report.submitted_at).getTime()) / 3600_000) : 0

  useEffect(() => {
    if (open && !full) mediaApi.getReport(report.id).then(r => setFull(r.report)).catch(() => {})
  }, [open, full, report.id])

  async function act(action: 'approve' | 'return') {
    if (action === 'return' && !comment.trim()) { toast.error('A return needs a comment for the member.'); return }
    try {
      await mediaApi.reviewReport(report.id, { action, comment: comment || undefined })
      toast.success(action === 'approve' ? 'Approved.' : 'Returned for edits.')
      onChanged()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed.') }
  }

  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4">
      <button className="w-full flex items-center justify-between gap-3 text-left" onClick={() => setOpen(o => !o)}>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-gray-800">{report.user_name ?? 'Me'} · {report.report_date}</p>
          <p className="text-[11px] text-gray-400">
            {fmtMinutes(report.total_minutes)}
            {report.submitted_at && ` · submitted ${age}h ago`}
            {report.flagged_reason && <span className="text-rose-600 font-semibold"> · {report.flagged_reason}</span>}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded-full" style={{ background: m.bg, color: m.fg }}>{m.label}</span>
          {open ? <ChevronUp className="w-4 h-4 text-gray-400" /> : <ChevronDown className="w-4 h-4 text-gray-400" />}
        </div>
      </button>

      {open && (
        <div className="mt-3 pt-3 border-t border-gray-50 space-y-3">
          <div className="space-y-1.5">
            {(full?.tasks ?? []).map(t => (
              <div key={t.id} className="text-xs text-gray-600 flex items-start justify-between gap-3">
                <p className="min-w-0">
                  <span className="font-semibold text-gray-800">{t.project_code}</span> · {t.description}
                  {t.quantity ? <span className="text-gray-400"> · {t.quantity} {t.unit}</span> : null}
                  {t.status === 'blocked' && <span className="text-rose-600 font-semibold"> · Blocked</span>}
                </p>
                <span className="font-mono tabular-nums text-gray-400 shrink-0">{fmtMinutes(t.minutes)}</span>
              </div>
            ))}
            {full?.note && <p className="text-[11px] text-gray-500 italic">Note: {full.note}</p>}
          </div>
          {reviewable && (
            <div className="flex gap-2">
              <input value={comment} onChange={e => setComment(e.target.value)} placeholder="Comment (required to return)…"
                className="flex-1 text-xs border border-gray-200 rounded-xl px-3 py-2 focus:outline-none focus:ring-2 focus:ring-green-200" />
              <button onClick={() => act('approve')} className="flex items-center gap-1 px-3 py-2 rounded-xl text-xs font-bold text-white" style={{ background: MEDIA_GREEN }}>
                <Check className="w-3.5 h-3.5" /> Approve
              </button>
              <button onClick={() => act('return')} className="flex items-center gap-1 px-3 py-2 rounded-xl text-xs font-bold bg-amber-100 text-amber-800 hover:bg-amber-200">
                <CornerUpLeft className="w-3.5 h-3.5" /> Return
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
