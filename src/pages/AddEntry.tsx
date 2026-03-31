import { useState } from 'react'
import { DEPARTMENTS, BRANDING_TYPES, CONTENT_TYPES, PRIORITIES } from '@/lib/constants'
import { useAuth } from '@/hooks/useAuth'
import { useAppData } from '@/hooks/useAppData'
import { getErrorMessage } from '@/lib/error-utils'
import { CheckCircle2, Palette, FileText } from 'lucide-react'

const BLANK = {
  dept: '', type: '', title: '', body: '',
  entry_date: new Date().toISOString().slice(0, 10),
  priority: 'Normal', tags: '', author_name: '',
  academic_year: '', student_count: '', external_link: '', collaborating_org: '',
}

export default function AddEntryPage() {
  const { user, team, role } = useAuth()
  const { addEntry } = useAppData()
  const [form, setForm]     = useState(BLANK)
  const [saving, setSaving] = useState(false)
  const [success, setSuccess] = useState(false)
  const [error, setError]   = useState('')

  // Super admin can choose either team's types; others are scoped to their team
  const allowedTypes = role === 'super_admin'
    ? [...BRANDING_TYPES, ...CONTENT_TYPES]
    : team === 'branding' ? [...BRANDING_TYPES] : [...CONTENT_TYPES]

  const teamLabel = team === 'branding' ? 'Branding' : team === 'content' ? 'Content' : null
  const TeamIcon  = team === 'branding' ? Palette : team === 'content' ? FileText : null

  function set(field: string, value: string) {
    setForm(f => ({ ...f, [field]: value }))
  }

  async function save(e: React.FormEvent) {
    e.preventDefault()
    if (!form.dept || !form.type || !form.title || !form.body) {
      setError('Please fill in Department, Type, Title and Details.')
      return
    }
    setSaving(true)
    setError('')

    try {
      await addEntry({
        ...form,
        tags: form.tags.split(',').map(t => t.trim()).filter(Boolean),
        student_count: form.student_count ? parseInt(form.student_count) : null,
        created_by: user?.id || null,
      })
      setSuccess(true)
      setForm(BLANK)
      setTimeout(() => setSuccess(false), 4000)
    } catch (err: unknown) {
      setError(getErrorMessage(err, 'Failed to save entry.'))
    } 
    setSaving(false)
  }

  return (
    <div className="animate-fade-in">
      <div className="mb-6">
        <div className="flex items-center gap-2">
          <h1 className="text-2xl font-serif text-foreground">Add entry</h1>
          {teamLabel && TeamIcon && (
            <span className={`hub-badge flex items-center gap-1 ${
              team === 'branding' ? 'bg-pink-100 text-pink-700' : 'bg-blue-100 text-blue-700'
            }`}>
              <TeamIcon className="w-3 h-3" /> {teamLabel} Team
            </span>
          )}
        </div>
        <p className="text-sm text-muted-foreground mt-1">Record a new knowledge update</p>
      </div>

      {success && (
        <div className="flex items-center gap-2 bg-green-50 border border-green-200 text-green-700 px-4 py-3 rounded-xl mb-6 text-sm">
          <CheckCircle2 className="w-4 h-4" />
          Entry saved successfully!
        </div>
      )}

      <form onSubmit={save} className="space-y-6">
        <div className="hub-card space-y-4">
          <h2 className="text-sm font-semibold text-foreground">Basic details</h2>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="hub-label">Department *</label>
              <select className="hub-input" value={form.dept} onChange={e => set('dept', e.target.value)} required>
                <option value="">Select...</option>
                {DEPARTMENTS.map(d => <option key={d}>{d}</option>)}
              </select>
            </div>
            <div>
              <label className="hub-label">Type *</label>
              <select className="hub-input" value={form.type} onChange={e => set('type', e.target.value)} required>
                <option value="">Select...</option>
                {allowedTypes.map(t => <option key={t}>{t}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label className="hub-label">Title *</label>
            <input className="hub-input" value={form.title} onChange={e => set('title', e.target.value)}
              placeholder="Brief descriptive title" required />
          </div>
          <div>
            <label className="hub-label">Details *</label>
            <textarea className="hub-input min-h-[120px]" value={form.body} onChange={e => set('body', e.target.value)}
              placeholder="Full description of the update..." required />
          </div>
        </div>

        <div className="hub-card space-y-4">
          <h2 className="text-sm font-semibold text-foreground">Additional info</h2>
          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className="hub-label">Date</label>
              <input className="hub-input" type="date" value={form.entry_date} onChange={e => set('entry_date', e.target.value)} />
            </div>
            <div>
              <label className="hub-label">Priority</label>
              <select className="hub-input" value={form.priority} onChange={e => set('priority', e.target.value)}>
                {PRIORITIES.map(p => <option key={p}>{p}</option>)}
              </select>
            </div>
            <div>
              <label className="hub-label">Academic year</label>
              <input className="hub-input" value={form.academic_year} onChange={e => set('academic_year', e.target.value)}
                placeholder="2024-25" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="hub-label">Author name</label>
              <input className="hub-input" value={form.author_name} onChange={e => set('author_name', e.target.value)}
                placeholder="Dr. Name" />
            </div>
            <div>
              <label className="hub-label">Student count</label>
              <input className="hub-input" type="number" value={form.student_count}
                onChange={e => set('student_count', e.target.value)} placeholder="0" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="hub-label">External link</label>
              <input className="hub-input" value={form.external_link} onChange={e => set('external_link', e.target.value)}
                placeholder="https://..." />
            </div>
            <div>
              <label className="hub-label">Collaborating org</label>
              <input className="hub-input" value={form.collaborating_org} onChange={e => set('collaborating_org', e.target.value)} />
            </div>
          </div>
          <div>
            <label className="hub-label">Tags (comma-separated)</label>
            <input className="hub-input" value={form.tags} onChange={e => set('tags', e.target.value)}
              placeholder="research, innovation, award" />
          </div>
        </div>

        {error && <p className="text-sm text-destructive bg-destructive/10 px-4 py-3 rounded-xl">{error}</p>}

        <button type="submit" disabled={saving}
          className="px-6 py-2.5 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-brand-dark transition-colors disabled:opacity-50">
          {saving ? 'Saving...' : 'Save entry'}
        </button>
      </form>
    </div>
  )
}
