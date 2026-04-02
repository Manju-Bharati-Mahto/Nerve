import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import {
  Settings, Database, Shield, Globe, Bell, Lock,
  Save, ToggleLeft, ToggleRight, Eye, EyeOff, RefreshCw,
  Palette, Image, ClipboardList, GraduationCap,
} from 'lucide-react'

// ── helpers ────────────────────────────────────────────────────────────────

function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button type="button" onClick={() => onChange(!value)}
      className={`flex items-center gap-1.5 text-sm font-medium transition-colors ${value ? 'text-green-600' : 'text-muted-foreground'}`}>
      {value
        ? <ToggleRight className="w-5 h-5 text-green-600" />
        : <ToggleLeft className="w-5 h-5 text-muted-foreground" />}
      {value ? 'Enabled' : 'Disabled'}
    </button>
  )
}

function TextInput({ value, onChange, placeholder, type = 'text' }: {
  value: string; onChange: (v: string) => void; placeholder?: string; type?: string
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      className="border border-border rounded-lg px-3 py-1.5 text-sm bg-background w-44 focus:outline-none focus:ring-2 focus:ring-pink-400/40"
    />
  )
}

function NumberInput({ value, onChange, min, max }: {
  value: string; onChange: (v: string) => void; min?: number; max?: number
}) {
  return (
    <input
      type="number"
      value={value}
      onChange={e => onChange(e.target.value)}
      min={min}
      max={max}
      className="border border-border rounded-lg px-3 py-1.5 text-sm bg-background w-24 focus:outline-none focus:ring-2 focus:ring-pink-400/40"
    />
  )
}

function SelectInput({ value, onChange, options }: {
  value: string; onChange: (v: string) => void; options: { label: string; value: string }[]
}) {
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      className="border border-border rounded-lg px-3 py-1.5 text-sm bg-background focus:outline-none focus:ring-2 focus:ring-pink-400/40"
    >
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  )
}

function PasswordInput({ value, onChange, placeholder }: {
  value: string; onChange: (v: string) => void; placeholder?: string
}) {
  const [show, setShow] = useState(false)
  return (
    <div className="relative">
      <input
        type={show ? 'text' : 'password'}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className="border border-border rounded-lg px-3 py-1.5 pr-8 text-sm bg-background w-44 focus:outline-none focus:ring-2 focus:ring-pink-400/40"
      />
      <button type="button" onClick={() => setShow(v => !v)}
        className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
        {show ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
      </button>
    </div>
  )
}

function SectionHeader({ icon: Icon, title, color, bg }: {
  icon: React.ElementType; title: string; color: string; bg: string
}) {
  return (
    <div className="flex items-center gap-2.5 mb-4">
      <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${bg}`}>
        <Icon className={`w-4 h-4 ${color}`} />
      </div>
      <h2 className="text-sm font-semibold text-foreground">{title}</h2>
    </div>
  )
}

function Row({ label, desc, children }: { label: string; desc?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5 border-b border-border last:border-0">
      <div>
        <span className="text-sm text-foreground">{label}</span>
        {desc && <p className="text-[11px] text-muted-foreground mt-0.5">{desc}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

// ── Main ───────────────────────────────────────────────────────────────────

export default function SuperAdminSettings() {
  const [settings, setSettings] = useState<Record<string, string>>({})
  const [draft, setDraft]       = useState<Record<string, string>>({})
  const [loading, setLoading]   = useState(true)
  const [saving, setSaving]     = useState(false)
  const [saved, setSaved]       = useState(false)
  const [error, setError]       = useState('')

  useEffect(() => {
    api.getSettings()
      .then(r => { setSettings(r.settings); setDraft(r.settings) })
      .catch(e => setError(e instanceof Error ? e.message : 'Failed to load settings.'))
      .finally(() => setLoading(false))
  }, [])

  function set(key: string, value: string) {
    setDraft(d => ({ ...d, [key]: value }))
  }

  function bool(key: string) {
    return draft[key] === 'true'
  }

  const changed = Object.keys(draft).some(k => draft[k] !== settings[k])

  async function handleSave() {
    setSaving(true); setError(''); setSaved(false)
    try {
      const res = await api.updateSettings(draft)
      setSettings(res.settings)
      setDraft(res.settings)
      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to save.')
    }
    setSaving(false)
  }

  if (loading) {
    return (
      <div className="animate-fade-in space-y-6">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-muted flex items-center justify-center">
            <Settings className="w-5 h-5 text-muted-foreground animate-spin" />
          </div>
          <div>
            <h1 className="text-2xl font-serif text-foreground">System settings</h1>
            <p className="text-sm text-muted-foreground">Loading…</p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="animate-fade-in space-y-6">

      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-muted flex items-center justify-center">
            <Settings className="w-5 h-5 text-muted-foreground" />
          </div>
          <div>
            <h1 className="text-2xl font-serif text-foreground">System settings</h1>
            <p className="text-sm text-muted-foreground">Configure the platform</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {changed && (
            <button onClick={() => setDraft(settings)}
              className="flex items-center gap-1.5 px-3 py-2 text-sm rounded-lg border border-border text-muted-foreground hover:bg-accent">
              <RefreshCw className="w-3.5 h-3.5" />Discard
            </button>
          )}
          <button
            onClick={handleSave}
            disabled={saving || !changed}
            className="flex items-center gap-1.5 px-4 py-2 text-sm rounded-lg bg-primary text-primary-foreground hover:bg-brand-dark transition-colors disabled:opacity-40"
          >
            <Save className="w-3.5 h-3.5" />
            {saving ? 'Saving…' : saved ? 'Saved!' : 'Save changes'}
          </button>
        </div>
      </div>

      {error && <p className="text-xs text-destructive bg-destructive/10 px-3 py-2 rounded-lg">{error}</p>}
      {changed && !saved && <p className="text-xs text-amber-600 bg-amber-50 px-3 py-2 rounded-lg">You have unsaved changes.</p>}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">

        {/* ── Application ── */}
        <div className="hub-card">
          <SectionHeader icon={Globe} title="Application" color="text-green-600" bg="bg-green-50" />
          <Row label="Site name" desc="Shown in the browser tab and emails">
            <TextInput value={draft['site.name'] ?? ''} onChange={v => set('site.name', v)} placeholder="Knowledge Hub" />
          </Row>
          <Row label="Timezone" desc="Used for date display and report timestamps">
            <SelectInput
              value={draft['site.timezone'] ?? 'Asia/Kolkata'}
              onChange={v => set('site.timezone', v)}
              options={[
                { label: 'Asia/Kolkata (IST)',    value: 'Asia/Kolkata' },
                { label: 'UTC',                   value: 'UTC' },
                { label: 'America/New_York (EST)', value: 'America/New_York' },
                { label: 'Europe/London (GMT)',   value: 'Europe/London' },
                { label: 'Asia/Dubai (GST)',      value: 'Asia/Dubai' },
              ]}
            />
          </Row>
        </div>

        {/* ── Access control ── */}
        <div className="hub-card">
          <SectionHeader icon={Shield} title="Access control" color="text-purple-600" bg="bg-purple-50" />
          <Row label="Session timeout (hours)" desc="How long before users are logged out">
            <NumberInput value={draft['auth.session_timeout_hours'] ?? '168'} onChange={v => set('auth.session_timeout_hours', v)} min={1} max={720} />
          </Row>
          <Row label="Max login attempts" desc="Reject after this many consecutive failures">
            <NumberInput value={draft['auth.max_login_attempts'] ?? '5'} onChange={v => set('auth.max_login_attempts', v)} min={1} max={20} />
          </Row>
          <Row label="Require email verification" desc="Users must verify email before they can sign in">
            <Toggle value={bool('auth.email_verification')} onChange={v => set('auth.email_verification', String(v))} />
          </Row>
        </div>

        {/* ── SMTP / Email ── */}
        <div className="hub-card">
          <SectionHeader icon={Bell} title="SMTP / Email" color="text-amber-600" bg="bg-amber-50" />
          <Row label="SMTP host" desc="e.g. smtp.gmail.com">
            <TextInput value={draft['smtp.host'] ?? ''} onChange={v => set('smtp.host', v)} placeholder="smtp.gmail.com" />
          </Row>
          <Row label="SMTP port" desc="Usually 587 (TLS) or 465 (SSL)">
            <NumberInput value={draft['smtp.port'] ?? '587'} onChange={v => set('smtp.port', v)} min={1} max={65535} />
          </Row>
          <Row label="SMTP username">
            <TextInput value={draft['smtp.user'] ?? ''} onChange={v => set('smtp.user', v)} placeholder="user@gmail.com" type="email" />
          </Row>
          <Row label="SMTP password">
            <PasswordInput value={draft['smtp.pass'] ?? ''} onChange={v => set('smtp.pass', v)} placeholder="App password" />
          </Row>
          <Row label="From address" desc="Sender address for all outgoing emails">
            <TextInput value={draft['smtp.from'] ?? ''} onChange={v => set('smtp.from', v)} placeholder="noreply@parul.ac.in" type="email" />
          </Row>
        </div>

        {/* ── Security ── */}
        <div className="hub-card">
          <SectionHeader icon={Lock} title="Security" color="text-red-600" bg="bg-red-50" />
          <Row label="Auth provider">
            <span className="text-sm text-muted-foreground font-medium">Session-based (scrypt)</span>
          </Row>
          <Row label="Password policy">
            <span className="text-sm text-muted-foreground font-medium">Min 6 chars</span>
          </Row>
          <Row label="Invitation-only registration">
            <span className="text-sm text-muted-foreground font-medium">Always enabled</span>
          </Row>
        </div>

        {/* ── Branding Portal ── */}
        <div className="hub-card">
          <SectionHeader icon={Palette} title="Branding Portal" color="text-pink-600" bg="bg-pink-50" />
          <Row label="Daily reports" desc="Enable/disable the daily reporting feature for branding team">
            <Toggle value={bool('daily_reports.enabled')} onChange={v => set('daily_reports.enabled', String(v))} />
          </Row>
          <Row label="KRA appraisal" desc="Enable/disable self, peer and admin KRA scoring">
            <Toggle value={bool('kra_appraisal.enabled')} onChange={v => set('kra_appraisal.enabled', String(v))} />
          </Row>
          <Row label="Design gallery" desc="Enable/disable the Pinterest-style design gallery">
            <Toggle value={bool('design_gallery.enabled')} onChange={v => set('design_gallery.enabled', String(v))} />
          </Row>
          <Row label="Design deletion window (mins)" desc="How long users can delete their own uploads (currently 60 min)">
            <NumberInput value={draft['branding.delete_window_mins'] ?? '60'} onChange={v => set('branding.delete_window_mins', v)} min={1} max={1440} />
          </Row>
        </div>

        {/* ── Data management ── */}
        <div className="hub-card">
          <SectionHeader icon={Database} title="Data management" color="text-blue-600" bg="bg-blue-50" />
          <Row label="Knowledge base">
            <span className="text-sm text-muted-foreground font-medium">Active</span>
          </Row>
          <Row label="File upload limit">
            <span className="text-sm text-muted-foreground font-medium">10 MB / file</span>
          </Row>
          <Row label="Storage">
            <span className="text-sm text-muted-foreground font-medium">Local filesystem</span>
          </Row>
          <Row label="Database">
            <span className="text-sm text-muted-foreground font-medium">PostgreSQL 17</span>
          </Row>
        </div>

        {/* ── Branding features overview ── */}
        <div className="hub-card lg:col-span-2">
          <SectionHeader icon={GraduationCap} title="Feature overview — Branding Team" color="text-indigo-600" bg="bg-indigo-50" />
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 pt-1">
            {[
              { icon: ClipboardList, label: 'Daily Reports',   key: 'daily_reports.enabled',   color: 'text-amber-600',  bg: 'bg-amber-50' },
              { icon: GraduationCap, label: 'KRA Appraisal',  key: 'kra_appraisal.enabled',   color: 'text-indigo-600', bg: 'bg-indigo-50' },
              { icon: Image,         label: 'Design Gallery', key: 'design_gallery.enabled',  color: 'text-pink-600',   bg: 'bg-pink-50' },
              { icon: Lock,          label: 'Delete Window',  key: 'branding.delete_window_mins', color: 'text-red-600', bg: 'bg-red-50', unit: 'min' },
            ].map(f => {
              const Icon = f.icon
              const isToggle = !f.unit
              const active = isToggle ? bool(f.key) : true
              return (
                <div key={f.key} className={`rounded-xl p-3 border ${active ? 'border-border' : 'border-dashed border-border/50 opacity-50'}`}>
                  <div className={`w-8 h-8 rounded-lg ${f.bg} flex items-center justify-center mb-2`}>
                    <Icon className={`w-4 h-4 ${f.color}`} />
                  </div>
                  <p className="text-xs font-semibold text-foreground">{f.label}</p>
                  <p className="text-[11px] text-muted-foreground mt-0.5">
                    {f.unit
                      ? `${draft[f.key] ?? '60'} ${f.unit}`
                      : (active ? 'Enabled' : 'Disabled')}
                  </p>
                </div>
              )
            })}
          </div>
        </div>

      </div>

      {/* Bottom save bar */}
      {changed && (
        <div className="fixed bottom-6 right-6 flex items-center gap-2 bg-card border border-border shadow-lg rounded-xl px-4 py-3 animate-fade-in">
          <span className="text-sm text-foreground font-medium">Unsaved changes</span>
          <button onClick={() => setDraft(settings)}
            className="px-3 py-1.5 text-sm rounded-lg border border-border text-muted-foreground hover:bg-accent">
            Discard
          </button>
          <button onClick={handleSave} disabled={saving}
            className="px-3 py-1.5 text-sm rounded-lg bg-primary text-primary-foreground hover:bg-brand-dark disabled:opacity-50 flex items-center gap-1.5">
            <Save className="w-3.5 h-3.5" />{saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      )}
    </div>
  )
}
