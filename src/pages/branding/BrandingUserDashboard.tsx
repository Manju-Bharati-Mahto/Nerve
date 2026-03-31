import { useMemo } from 'react'
import { useAuth } from '@/hooks/useAuth'
import { useAppData } from '@/hooks/useAppData'
import type { BrandingTableRow } from '@/lib/app-types'
import { BRANDING_TYPES, DEPARTMENTS } from '@/lib/constants'
import { Palette, Plus, Trash2 } from 'lucide-react'

const TIME_OPTIONS = [
  '< 1 hour', '1–2 hours', '3–4 hours', 'Half day',
  '1 day', '2 days', '3 days', '1 week',
  '2 weeks', '1 month', '2 months', '3+ months',
]

const TH = 'text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground px-3 py-3 whitespace-nowrap'
const SEL = 'w-full min-w-[130px] bg-transparent text-sm px-2 py-1 rounded border border-transparent hover:border-input focus:border-primary focus:outline-none focus:ring-1 focus:ring-ring/30 transition-all cursor-pointer'
const INP = 'w-full min-w-[160px] bg-transparent text-sm px-2 py-1 rounded border border-transparent hover:border-input focus:border-primary focus:outline-none focus:ring-1 focus:ring-ring/30 transition-all placeholder:text-muted-foreground/50'

function blankRow(): BrandingTableRow {
  return {
    id: '',
    category: '',
    sub_category: '',
    time_taken: '',
    team_member: '',
    project_name: '',
    additional_info: '',
    created_at: '',
    updated_at: '',
  }
}

export default function BrandingUserDashboard() {
  const { profile } = useAuth()
  const { brandingRows: rows, users, addBrandingRow, updateBrandingRow, deleteBrandingRow } = useAppData()

  const brandingMembers = useMemo(
    () => users.filter(u => u.team === 'branding' && u.role !== 'super_admin' && u.role !== 'admin'),
    [users]
  )

  async function addRow() {
    await addBrandingRow(blankRow())
  }

  async function updateRow(id: string, field: keyof BrandingTableRow, value: string) {
    await updateBrandingRow(id, { [field]: value })
  }

  async function deleteRow(id: string) {
    await deleteBrandingRow(id)
  }

  return (
    <div className="animate-fade-in space-y-5">

      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-pink-100 flex items-center justify-center shrink-0">
            <Palette className="w-5 h-5 text-pink-600" />
          </div>
          <div>
            <h1 className="text-2xl font-serif text-foreground">
              Welcome{profile?.full_name ? `, ${profile.full_name}` : ''}
            </h1>
            <p className="text-sm text-muted-foreground">Branding Team · Project Tracker</p>
          </div>
        </div>
        <button onClick={() => void addRow()}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-brand-dark transition-colors">
          <Plus className="w-4 h-4" /> Add Row
        </button>
      </div>

      {/* Table */}
      <div className="hub-card p-0 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="bg-pink-50 border-b border-border">
                <th className={`${TH} w-12 text-center`}>Sr</th>
                <th className={TH}>Category</th>
                <th className={TH}>Sub Category</th>
                <th className={TH}>Time Taken</th>
                <th className={TH}>Team Member</th>
                <th className={TH}>Project / Event Name</th>
                <th className={TH}>Additional Information</th>
                <th className="w-10" />
              </tr>
            </thead>

            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={8} className="text-center text-sm text-muted-foreground py-14">
                    No entries yet. Click <strong>Add Row</strong> to get started.
                  </td>
                </tr>
              )}

              {rows.map((row, i) => (
                <tr key={row.id}
                  className={`border-b border-border last:border-0 group transition-colors hover:bg-pink-50/30 ${i % 2 === 1 ? 'bg-muted/20' : ''}`}>

                  {/* Sr — auto */}
                  <td className="px-3 py-2 text-xs text-muted-foreground font-medium text-center">{i + 1}</td>

                  {/* Category — dropdown */}
                  <td className="px-1.5 py-1.5">
                    <select value={row.category} onChange={e => void updateRow(row.id, 'category', e.target.value)} className={SEL}>
                      <option value="">Select…</option>
                      {BRANDING_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                    </select>
                  </td>

                  {/* Sub Category — dropdown */}
                  <td className="px-1.5 py-1.5">
                    <select value={row.sub_category} onChange={e => void updateRow(row.id, 'sub_category', e.target.value)} className={SEL}>
                      <option value="">Select…</option>
                      {DEPARTMENTS.map(d => <option key={d} value={d}>{d}</option>)}
                    </select>
                  </td>

                  {/* Time Taken — dropdown */}
                  <td className="px-1.5 py-1.5">
                    <select value={row.time_taken} onChange={e => void updateRow(row.id, 'time_taken', e.target.value)} className={SEL}>
                      <option value="">Select…</option>
                      {TIME_OPTIONS.map(t => <option key={t} value={t}>{t}</option>)}
                    </select>
                  </td>

                  {/* Team Member — dropdown from branding team */}
                  <td className="px-1.5 py-1.5">
                    <select value={row.team_member} onChange={e => void updateRow(row.id, 'team_member', e.target.value)} className={SEL}>
                      <option value="">Select…</option>
                      {brandingMembers.map(m => (
                        <option key={m.id} value={m.full_name || m.email}>
                          {m.full_name || m.email}
                        </option>
                      ))}
                    </select>
                  </td>

                  {/* Project / Event Name — text */}
                  <td className="px-1.5 py-1.5">
                    <input
                      type="text"
                      value={row.project_name}
                      onChange={e => void updateRow(row.id, 'project_name', e.target.value)}
                      className={INP}
                      placeholder="Project or event name"
                    />
                  </td>

                  {/* Additional Information — text */}
                  <td className="px-1.5 py-1.5">
                    <input
                      type="text"
                      value={row.additional_info}
                      onChange={e => void updateRow(row.id, 'additional_info', e.target.value)}
                      className={INP}
                      placeholder="Additional details"
                    />
                  </td>

                  {/* Delete */}
                  <td className="px-2 py-1.5">
                    <button
                      onClick={() => void deleteRow(row.id)}
                      className="opacity-0 group-hover:opacity-100 p-1 rounded text-muted-foreground hover:text-destructive transition-all"
                      title="Delete row"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Footer */}
        <div className="px-4 py-2.5 bg-muted/30 border-t border-border flex items-center justify-between">
          <span className="text-xs text-muted-foreground">
            {rows.length} {rows.length === 1 ? 'entry' : 'entries'} · Changes saved automatically
          </span>
          <button onClick={() => void addRow()}
            className="flex items-center gap-1 text-xs font-medium text-pink-600 hover:text-pink-700 transition-colors">
            <Plus className="w-3.5 h-3.5" /> Add Row
          </button>
        </div>
      </div>
    </div>
  )
}
