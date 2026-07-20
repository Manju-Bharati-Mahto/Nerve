/**
 * FR-DR-09 + FR-DR-06 — lead/admin team view: per-date grid of who submitted /
 * who didn't, open any report, approve or send back with a one-line comment.
 */
import { useEffect, useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight, CheckCircle, Undo2, Clock } from 'lucide-react'
import { mediaApi } from '@/lib/media-api'
import type { MediaDailyReport, MediaMember, MediaMaster } from '@/lib/media-types'

const GREEN = '#1a472a'

function dayString(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export default function MediaTeamReports() {
  const [date, setDate] = useState(() => dayString(new Date()))
  const [members, setMembers] = useState<MediaMember[]>([])
  const [taskCategories, setTaskCategories] = useState<MediaMaster[]>([])
  const [reports, setReports] = useState<MediaDailyReport[]>([])
  const [openId, setOpenId] = useState<string | null>(null)
  const [comment, setComment] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    mediaApi.getTeam().then(r => setMembers(r.members)).catch(() => {})
    mediaApi.getMasters().then(m => setTaskCategories(m.task_categories)).catch(() => {})
  }, [])

  useEffect(() => {
    mediaApi.getTeamReports(date).then(r => setReports(r.reports)).catch(e => setError(e instanceof Error ? e.message : 'Failed to load.'))
  }, [date])

  const byUser = useMemo(() => new Map(reports.map(r => [r.user_id, r])), [reports])
  const catName = useMemo(() => new Map(taskCategories.map(c => [c.id, c.name])), [taskCategories])
  const open = openId ? reports.find(r => r.id === openId) ?? null : null
  const openMember = open ? members.find(m => m.id === open.user_id) : null

  function shift(days: number) {
    const d = new Date(date + 'T00:00:00')
    d.setDate(d.getDate() + days)
    setDate(dayString(d))
    setOpenId(null)
  }

  async function review(action: 'approve' | 'send_back') {
    if (!open || busy) return
    if (action === 'send_back' && !comment.trim()) { setError('A one-line comment is required when sending back.'); return }
    setBusy(true)
    setError(null)
    try {
      const { report } = await mediaApi.reviewReport(open.id, action, comment.trim())
      setReports(rs => rs.map(r => r.id === report.id ? report : r))
      setComment('')
      if (action === 'approve') setOpenId(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed.')
    } finally {
      setBusy(false)
    }
  }

  const submitted = reports.filter(r => r.status !== 'draft').length
  const awaiting = reports.filter(r => r.status === 'submitted').length

  const badge = (s: MediaDailyReport['status'] | 'none') =>
    s === 'approved' ? { label: 'Approved', cls: 'bg-emerald-100 text-emerald-700' }
    : s === 'submitted' ? { label: 'Awaiting review', cls: 'bg-blue-100 text-blue-700' }
    : s === 'sent_back' ? { label: 'Sent back', cls: 'bg-amber-100 text-amber-800' }
    : s === 'draft' ? { label: 'Draft', cls: 'bg-gray-100 text-gray-600' }
    : { label: 'Not submitted', cls: 'bg-rose-100 text-rose-700' }

  return (
    <div className="max-w-5xl mx-auto space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-extrabold font-serif" style={{ color: GREEN }}>Team Reports</h1>
          <p className="text-sm text-gray-500">{submitted} of {members.length} submitted · {awaiting} awaiting review</p>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={() => shift(-1)} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-500"><ChevronLeft className="w-4 h-4" /></button>
          <input type="date" value={date} onChange={e => { setDate(e.target.value); setOpenId(null) }}
            className="text-sm border border-gray-200 rounded-xl px-3 py-1.5 bg-white" />
          <button onClick={() => shift(1)} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-500"><ChevronRight className="w-4 h-4" /></button>
        </div>
      </div>

      {error && <div className="bg-rose-50 border border-rose-200 rounded-xl px-4 py-2.5 text-sm text-rose-700">{error}</div>}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4 space-y-1.5">
          {members.length === 0 && <p className="text-sm text-gray-400 py-8 text-center">No Media Crew members yet — add them in Manage Users.</p>}
          {members.map(m => {
            const r = byUser.get(m.id)
            const b = badge(r?.status ?? 'none')
            return (
              <button key={m.id} type="button"
                onClick={() => r && setOpenId(r.id === openId ? null : r.id)}
                className={`w-full flex items-center justify-between gap-2 px-3 py-2.5 rounded-xl text-left transition-colors ${
                  r ? 'hover:bg-gray-50 cursor-pointer' : 'cursor-default'
                } ${open?.user_id === m.id ? 'bg-green-50' : ''}`}>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-gray-800 truncate">{m.full_name || m.email}</p>
                  <p className="text-[11px] text-gray-400">{m.role === 'admin' ? 'MediaOps Admin' : m.role === 'sub_admin' ? 'Team Lead' : m.role === 'social_media' ? 'Social Media' : 'Member'}</p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {r && <span className="text-[11px] font-mono text-gray-400 inline-flex items-center gap-1"><Clock className="w-3 h-3" />{r.total_hours}h</span>}
                  <span className={`text-[10px] px-2 py-0.5 rounded-full font-semibold ${b.cls}`}>{b.label}</span>
                </div>
              </button>
            )
          })}
        </div>

        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4">
          {!open ? (
            <p className="text-sm text-gray-400 py-12 text-center">Select a submitted report to review it.</p>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-bold text-gray-800">{openMember?.full_name || open.user_id}</p>
                  <p className="text-[11px] text-gray-400">{open.tasks.length} task{open.tasks.length === 1 ? '' : 's'} · {open.total_hours}h</p>
                </div>
                <span className={`text-[10px] px-2 py-0.5 rounded-full font-semibold ${badge(open.status).cls}`}>{badge(open.status).label}</span>
              </div>

              <div className="space-y-2 max-h-[45vh] overflow-y-auto">
                {open.tasks.map(t => (
                  <div key={t.id} className="border border-gray-100 rounded-xl p-3">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-xs font-semibold" style={{ color: GREEN }}>{catName.get(t.task_category_id) ?? 'Task'}</p>
                      <span className="text-[11px] font-mono text-gray-400">{t.start_time}–{t.end_time} · {t.hours}h</span>
                    </div>
                    <p className="text-sm text-gray-700 mt-1">{t.description}</p>
                    {(t.progress_before != null || t.progress_after != null) && (
                      <p className="text-[11px] text-gray-400 mt-0.5">Progress {t.progress_before ?? '—'}% → {t.progress_after ?? '—'}%</p>
                    )}
                    {t.evidence_link && (
                      <a href={t.evidence_link} target="_blank" rel="noreferrer" className="text-[11px] text-blue-600 hover:underline break-all">{t.evidence_link}</a>
                    )}
                  </div>
                ))}
              </div>

              {open.summary && <p className="text-xs text-gray-500"><strong>Summary:</strong> {open.summary}</p>}
              {open.blockers && <p className="text-xs text-amber-700"><strong>Blockers:</strong> {open.blockers}</p>}
              {open.tomorrow_priority && <p className="text-xs text-gray-500"><strong>Tomorrow:</strong> {open.tomorrow_priority}</p>}

              {open.status === 'submitted' && (
                <div className="pt-2 border-t border-gray-100 space-y-2">
                  <input value={comment} onChange={e => setComment(e.target.value)}
                    placeholder="One-line comment (required for send back)"
                    className="w-full text-sm border border-gray-200 rounded-xl px-3 py-2" />
                  <div className="flex items-center gap-2">
                    <button onClick={() => void review('approve')} disabled={busy}
                      className="flex-1 py-2 rounded-xl text-sm font-semibold text-white disabled:opacity-50 inline-flex items-center justify-center gap-1.5"
                      style={{ background: GREEN }}>
                      <CheckCircle className="w-4 h-4" /> Approve
                    </button>
                    <button onClick={() => void review('send_back')} disabled={busy}
                      className="flex-1 py-2 rounded-xl text-sm font-semibold border border-amber-300 text-amber-700 hover:bg-amber-50 disabled:opacity-50 inline-flex items-center justify-center gap-1.5">
                      <Undo2 className="w-4 h-4" /> Send Back
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
