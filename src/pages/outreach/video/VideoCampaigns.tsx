import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Megaphone, Plus, AlertCircle, Loader2, X, Pencil, Trash2,
} from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'
import {
  listCampaigns, createCampaign, updateCampaign, deleteCampaign, driveProblemOf,
  CAMPAIGN_STATUS_LABEL, type Campaign, type DriveErrorCode,
} from '@/lib/outreach-video-data'
import DriveProblemNotice from './DriveProblemNotice'

/**
 * §7 campaign management and the §5 progress a Manager monitors.
 *
 * The totals at the top are §5's "Total / Running / Upcoming / Completed
 * campaigns", and each row carries what §5 asks for per campaign: the posts
 * required, the posts published, and what remains. Those are computed from the
 * videos on the server rather than stored, so they cannot drift.
 *
 * A campaign with no target shows "no target" rather than 0 remaining, because
 * the two mean different things and reading one as the other makes a campaign
 * nobody has planned look finished.
 */
export default function VideoCampaigns() {
  const { role } = useAuth()
  const canManage = role === 'super_admin' || role === 'admin' || role === 'outreach_manager'

  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  /* Set when the list could not be read because Google Drive is missing or
     broken. Video campaigns are STORED in Drive, so without it there is
     nothing to list and nowhere to save one — the page says so, links to the
     fix, and stops offering a form that can only fail at the last step. */
  const [driveProblem, setDriveProblem] = useState<DriveErrorCode | null>(null)
  const [editing, setEditing] = useState<Campaign | 'new' | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const { campaigns } = await listCampaigns()
      setCampaigns(campaigns)
      setError(null)
      setDriveProblem(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load campaigns.')
      setDriveProblem(driveProblemOf(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const totals = useMemo(() => ({
    total: campaigns.length,
    running: campaigns.filter(c => c.status === 'running').length,
    upcoming: campaigns.filter(c => c.status === 'upcoming').length,
    completed: campaigns.filter(c => c.status === 'completed').length,
  }), [campaigns])

  /* Counted from a list that was never read, the tiles would say "0 Running"
     over a notice saying the campaigns could not be read. Only the load sets
     driveProblem, so a failed delete (which also sets error) keeps them. */
  const known = !loading && !driveProblem && !(error && campaigns.length === 0)

  async function remove(c: Campaign) {
    if (!confirm(`Delete “${c.name}”? This is only possible while it has no videos.`)) return
    setBusyId(c.id)
    setError(null)
    try {
      await deleteCampaign(c.id)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete that campaign.')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="animate-fade-in space-y-5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-orange-100 flex items-center justify-center">
            <Megaphone className="w-5 h-5 text-orange-600" />
          </div>
          <div>
            <h1 className="text-xl font-serif text-foreground">Campaigns</h1>
            <p className="text-sm text-muted-foreground">
              Everything a campaign owns lives together — its videos, its pages and its progress.
            </p>
          </div>
        </div>
        {canManage && !driveProblem && (
          <button onClick={() => setEditing('new')}
            className="px-4 py-2 rounded-lg bg-orange-600 text-white text-sm font-medium hover:opacity-90 inline-flex items-center gap-2">
            <Plus className="w-4 h-4" /> New campaign
          </button>
        )}
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Stat label="Total campaigns" value={known ? totals.total : null} />
        <Stat label="Running" value={known ? totals.running : null} />
        <Stat label="Upcoming" value={known ? totals.upcoming : null} />
        <Stat label="Completed" value={known ? totals.completed : null} />
      </div>

      {error && driveProblem && <DriveProblemNotice message={error} code={driveProblem} />}
      {error && !driveProblem && (
        <div className="hub-card flex items-start gap-2 text-sm text-rose-600">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" /> {error}
        </div>
      )}

      {/* With a Drive problem there is no list to show — "No campaigns yet"
          under it would claim something nobody knows. */}
      {driveProblem ? null : loading ? (
        <div className="hub-card text-center py-12 text-sm text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin inline mr-2" /> Loading…
        </div>
      ) : campaigns.length === 0 ? (
        <div className="hub-card text-center py-12">
          <Megaphone className="w-8 h-8 text-muted-foreground/40 mx-auto mb-2" />
          <p className="text-sm text-muted-foreground">No campaigns yet.</p>
        </div>
      ) : (
        <div className="hub-card overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-widest text-muted-foreground border-b border-border">
                <th className="px-3 py-2.5 font-medium">Campaign</th>
                <th className="px-3 py-2.5 font-medium">Dates</th>
                <th className="px-3 py-2.5 font-medium">Status</th>
                <th className="px-3 py-2.5 font-medium">Progress</th>
                {canManage && <th className="px-3 py-2.5 font-medium text-right">Actions</th>}
              </tr>
            </thead>
            <tbody>
              {campaigns.map(c => (
                <tr key={c.id} className="border-b border-border/60 last:border-0">
                  <td className="px-3 py-2.5">
                    <p className="text-foreground">{c.name}</p>
                    {c.description && (
                      <p className="text-[11px] text-muted-foreground truncate max-w-xs">{c.description}</p>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-muted-foreground whitespace-nowrap">
                    {c.startDate} → {c.endDate}
                  </td>
                  <td className="px-3 py-2.5">
                    <span className="hub-badge bg-slate-100 text-slate-700">
                      {CAMPAIGN_STATUS_LABEL[c.status]}
                    </span>
                  </td>
                  <td className="px-3 py-2.5">
                    <Progress campaign={c} />
                  </td>
                  {canManage && (
                    <td className="px-3 py-2.5 text-right whitespace-nowrap">
                      <button onClick={() => setEditing(c)} disabled={busyId === c.id}
                        className="text-xs px-2 py-1 rounded-lg border border-border text-muted-foreground hover:bg-accent disabled:opacity-40 inline-flex items-center gap-1">
                        <Pencil className="w-3 h-3" /> Edit
                      </button>
                      <button onClick={() => remove(c)} disabled={busyId === c.id}
                        title={c.progress && c.progress.published > 0 ? 'Campaigns with videos cannot be deleted' : undefined}
                        className="ml-1.5 text-xs px-2 py-1 rounded-lg border border-rose-200 text-rose-600 hover:bg-rose-50 disabled:opacity-40 inline-flex items-center gap-1">
                        <Trash2 className="w-3 h-3" /> Delete
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <CampaignDialog
          campaign={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onDone={async () => { setEditing(null); await refresh() }} />
      )}
    </div>
  )
}

/** `null` is "not known": a dash, never a zero. */
function Stat({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="hub-card">
      <p className="text-[11px] uppercase tracking-widest text-muted-foreground">{label}</p>
      <p className="text-2xl font-serif text-foreground mt-1">{value ?? '—'}</p>
    </div>
  )
}

/** §5 — required, published and remaining, for one campaign. */
function Progress({ campaign }: { campaign: Campaign }) {
  const p = campaign.progress
  if (!p) return <span className="text-muted-foreground">—</span>
  if (p.required === 0) {
    return (
      <span className="text-muted-foreground text-xs">
        {p.published} published · no target set
      </span>
    )
  }
  const pct = Math.min(100, Math.round((p.published / p.required) * 100))
  return (
    <div className="min-w-40">
      <div className="flex items-center justify-between text-[11px] text-muted-foreground mb-1">
        <span>{p.published} / {p.required} posts</span>
        <span>{p.remaining} left</span>
      </div>
      <div className="h-1.5 rounded-full bg-muted overflow-hidden">
        <div className="h-full bg-orange-500" style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

/** §7 — the campaign's own fields. */
function CampaignDialog({ campaign, onClose, onDone }: {
  campaign: Campaign | null; onClose: () => void; onDone: () => Promise<void>
}) {
  const [name, setName] = useState(campaign?.name ?? '')
  const [description, setDescription] = useState(campaign?.description ?? '')
  const [startDate, setStartDate] = useState(campaign?.startDate ?? '')
  const [endDate, setEndDate] = useState(campaign?.endDate ?? '')
  const [status, setStatus] = useState<Campaign['status']>(campaign?.status ?? 'upcoming')
  const [requiredPosts, setRequiredPosts] = useState(String(campaign?.requiredPosts ?? 0))
  const [notes, setNotes] = useState(campaign?.notes ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [driveProblem, setDriveProblem] = useState<DriveErrorCode | null>(null)

  async function save() {
    setBusy(true)
    setError(null)
    const payload = {
      name: name.trim(), description: description.trim(),
      startDate, endDate, status,
      requiredPosts: Number(requiredPosts) || 0,
      notes: notes.trim(),
    }
    try {
      if (campaign) await updateCampaign(campaign.id, payload)
      else await createCampaign(payload)
      await onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save that campaign.')
      setDriveProblem(driveProblemOf(err))
      setBusy(false)
    }
  }

  const ready = name.trim() && startDate && endDate

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4 animate-fade-in">
      <div className="bg-card rounded-xl border border-border w-full max-w-md max-h-full flex flex-col">
        <div className="flex items-start justify-between p-4 border-b border-border shrink-0">
          <h2 className="text-base font-serif text-foreground">
            {campaign ? 'Edit campaign' : 'New campaign'}
          </h2>
          <button onClick={onClose} disabled={busy}
            className="p-2 rounded-lg hover:bg-accent text-muted-foreground disabled:opacity-40">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-4 space-y-3 overflow-y-auto">
          <div>
            <label className="hub-label">Campaign name *</label>
            <input className="hub-input" value={name} onChange={e => setName(e.target.value)}
              placeholder="VLF 2027" />
            <p className="text-[11px] text-muted-foreground mt-1">
              This names the campaign's folder in Drive and every file inside it.
            </p>
          </div>
          <div>
            <label className="hub-label">Description</label>
            <textarea className="hub-input min-h-20" value={description}
              onChange={e => setDescription(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="hub-label">Start date *</label>
              <input className="hub-input" type="date" value={startDate}
                onChange={e => setStartDate(e.target.value)} />
            </div>
            <div>
              <label className="hub-label">End date *</label>
              <input className="hub-input" type="date" value={endDate}
                onChange={e => setEndDate(e.target.value)} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="hub-label">Status</label>
              <select className="hub-input" value={status}
                onChange={e => setStatus(e.target.value as Campaign['status'])}>
                {(Object.keys(CAMPAIGN_STATUS_LABEL) as Campaign['status'][]).map(s => (
                  <option key={s} value={s}>{CAMPAIGN_STATUS_LABEL[s]}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="hub-label">Posts required</label>
              <input className="hub-input" type="number" min={0} value={requiredPosts}
                onChange={e => setRequiredPosts(e.target.value)} />
              <p className="text-[11px] text-muted-foreground mt-1">0 means no target.</p>
            </div>
          </div>
          <div>
            <label className="hub-label">Notes</label>
            <textarea className="hub-input min-h-16" value={notes}
              onChange={e => setNotes(e.target.value)} />
          </div>
          {error && driveProblem && <DriveProblemNotice message={error} code={driveProblem} />}
          {error && !driveProblem && <p className="text-xs text-rose-600">{error}</p>}
        </div>
        <div className="flex items-center justify-end gap-2 p-4 border-t border-border shrink-0">
          <button onClick={onClose} disabled={busy}
            className="px-4 py-2 rounded-lg border border-border text-sm text-muted-foreground hover:bg-accent disabled:opacity-40">
            Cancel
          </button>
          <button onClick={save} disabled={busy || !ready}
            className="px-4 py-2 rounded-lg bg-orange-600 text-white text-sm font-medium hover:opacity-90 disabled:opacity-40">
            {busy ? 'Saving…' : campaign ? 'Save changes' : 'Create campaign'}
          </button>
        </div>
      </div>
    </div>
  )
}
