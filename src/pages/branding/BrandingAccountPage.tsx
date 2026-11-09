/**
 * Account Settings: Profile, Security and Team. One page for everyone, shown
 * inside the user and lead dashboard and at /branding/account in the admin
 * shell, so the details and role text stay the same on both sides.
 */
import { useState } from 'react'
import { toast } from 'sonner'
import { useAuth } from '@/hooks/useAuth'
import { AlertCircle, ArrowUpRight, Camera, Phone, Shield } from 'lucide-react'
import { api } from '@/lib/api'
import { L, cx, Badge, Spinner } from './ds2'

const INP = L.input

export default function SettingsPage({ profile }: { profile: ReturnType<typeof useAuth>['profile'] }) {
  const { role, refreshProfile } = useAuth()
  const isAdmin = role === 'super_admin' || role === 'admin' || role === 'branding_reports_admin'
  const isLead = role === 'sub_admin' || role === 'task_owner' || role === 'task_manager'
  const roleLabel = role === 'super_admin' ? 'Super Admin'
    : role === 'branding_reports_admin' ? 'Reports Admin'
    : role === 'admin' ? 'Admin'
    : isLead ? 'Team Lead'
    : 'Member'
  const permissions = isAdmin
    ? ['Review daily reports across the team', 'Score KRAs and publish final results', 'Approve or reject leave requests', 'Manage categories, projects and members']
    : isLead
      ? ['Submit daily work reports', 'Run your team\u2019s Kanban board', 'See your team\u2019s reports and projects', 'Upload and browse design gallery']
      : ['Submit daily work reports', 'Upload and browse design gallery', 'Submit monthly self-appraisal', 'Peer-mark team members (when enabled)']
  const [fullName, setFullName] = useState(profile?.full_name || '')
  const [designation, setDesignation] = useState(profile?.department || '')
  const [phone, setPhone] = useState(() => localStorage.getItem(`phone_${profile?.id}`) || '')
  const [avatarUrl, setAvatarUrl] = useState<string>(
    () => profile?.avatar_url || localStorage.getItem(`avatar_${profile?.id}`) || ''
  )
  const [avatarUploading, setAvatarUploading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [editMode, setEditMode] = useState(false)
  const [newPwd, setNewPwd] = useState('')
  const [confirmPwd, setConfirmPwd] = useState('')
  const [pwdSaving, setPwdSaving] = useState(false)
  const [section, setSection] = useState<'profile' | 'security' | 'team'>('profile')

  async function handleAvatarChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    if (file.size > 3 * 1024 * 1024) { toast.error('Image must be under 3 MB.'); return }
    setAvatarUploading(true)
    try {
      const res = await api.uploadAvatar(file)
      setAvatarUrl(res.avatar_url)
      await refreshProfile()
      toast.success('Profile photo updated!')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to upload photo')
    } finally {
      setAvatarUploading(false)
    }
  }

  async function saveProfile() {
    if (!profile?.id) return
    setSaving(true)
    try {
      if (profile?.id) localStorage.setItem(`phone_${profile.id}`, phone)
      await api.updateMe({ full_name: fullName, department: designation })
      await refreshProfile()
      toast.success('Profile updated!')
      setEditMode(false)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save profile')
    } finally {
      setSaving(false)
    }
  }

  async function changePassword() {
    if (!newPwd) { toast.error('Enter a new password.'); return }
    if (newPwd !== confirmPwd) { toast.error('Passwords do not match.'); return }
    if (newPwd.length < 8) { toast.error('Minimum 8 characters required.'); return }
    if (!profile?.id) return
    setPwdSaving(true)
    try {
      await api.updateUser(profile.id, { password: newPwd })
      toast.success('Password changed!')
      setNewPwd(''); setConfirmPwd('')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to change password')
    } finally {
      setPwdSaving(false)
    }
  }

  const initials = (profile?.full_name || profile?.email || 'U')
    .split(' ').map((n: string) => n[0]).join('').slice(0, 2).toUpperCase()

  return (
    <div className="space-y-4">
      {/* Section tabs */}
      <div role="tablist" className="inline-flex items-center gap-1 p-1 rounded-[6px] border border-[#C5CAD1] bg-[#F9FAFB] w-full max-w-md">
        {(['profile', 'security', 'team'] as const).map(sec => {
          const on = section === sec
          return (
            <button key={sec} type="button" role="tab" aria-selected={on} onClick={() => setSection(sec)}
              className={cx(
                'flex-1 h-8 rounded-[5px] text-[13px] font-medium transition-colors cursor-pointer',
                on ? 'bg-[var(--nerve-primary)] text-[var(--nerve-on-primary)]' : 'text-[#6B7280] hover:text-[#111827] hover:bg-white',
              )}>
              {sec === 'profile' ? 'Profile' : sec === 'security' ? 'Security' : 'Team'}
            </button>
          )
        })}
      </div>

      {section === 'profile' && (
        <div className={cx(L.card, 'p-4 space-y-4')}>
          {/* Avatar + name row */}
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-4">
              <div className="relative shrink-0 group">
                {avatarUrl
                  ? <img src={avatarUrl} alt="avatar" className="w-14 h-14 rounded-full object-cover border border-[#C5CAD1]" />
                  : (
                    <div className="w-14 h-14 rounded-full bg-[var(--nerve-primary)] flex items-center justify-center text-[18px] font-semibold text-[var(--nerve-on-primary)]">
                      {initials}
                    </div>
                  )
                }
                {/* Always-visible camera button — user can change photo any time */}
                <label className={cx('absolute -bottom-0.5 -right-0.5 w-7 h-7 rounded-full bg-white border border-[#C5CAD1] shadow-[0_1px_2px_rgba(16,24,40,0.08)] flex items-center justify-center cursor-pointer hover:bg-[#F9FAFB] transition-colors', avatarUploading && 'opacity-60 pointer-events-none')}>
                  {avatarUploading
                    ? <Spinner className="!w-3.5 !h-3.5" />
                    : <Camera className="w-3.5 h-3.5 text-[#6B7280]" strokeWidth={1.75} />
                  }
                  <input type="file" accept="image/*" className="hidden" onChange={handleAvatarChange} disabled={avatarUploading} />
                </label>
              </div>
              <div>
                <p className="text-[14px] font-semibold text-[#111827]">{profile?.full_name || 'Your Name'}</p>
                <p className="text-[13px] text-[#6B7280]">{profile?.email}</p>
                <p className="text-[12px] text-[#9CA3AF] mt-1">Click the camera icon to change your photo</p>
              </div>
            </div>
            {/* Edit / Cancel toggle */}
            {!editMode ? (
              <button type="button" onClick={() => setEditMode(true)} className={cx(L.btn, L.btnSecondary)}>
                <ArrowUpRight className="w-3.5 h-3.5" strokeWidth={1.75} /> Edit Profile
              </button>
            ) : (
              <button
                type="button"
                onClick={() => { setEditMode(false); setFullName(profile?.full_name || ''); setDesignation(profile?.department || '') }}
                className={cx(L.btn, L.btnSecondary)}
              >
                Cancel
              </button>
            )}
          </div>

          {/* Read-only view */}
          {!editMode && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {[
                { label: 'Full Name', value: profile?.full_name || '—' },
                { label: 'Designation / Role', value: profile?.department || '—' },
                { label: 'Email Address', value: profile?.email || '—' },
                { label: 'Phone Number', value: phone || '—' },
              ].map(item => (
                <div key={item.label} className="rounded-[6px] bg-[#F9FAFB] border border-[#C5CAD1] px-3.5 py-3">
                  <p className={cx(L.eyebrow, 'mb-1')}>{item.label}</p>
                  <p className="text-[13px] font-medium truncate text-[#111827]">{item.value}</p>
                </div>
              ))}
            </div>
          )}

          {/* Edit form */}
          {editMode && (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className={L.label}>Full Name</label>
                  <input value={fullName} onChange={e => setFullName(e.target.value)} className={INP} placeholder="Your full name" autoFocus />
                </div>
                <div>
                  <label className={L.label}>Designation / Role</label>
                  <input value={designation} onChange={e => setDesignation(e.target.value)} className={INP} placeholder="e.g. Graphic Designer" />
                </div>
                <div>
                  <label className={L.label}>Email Address</label>
                  <div className="relative">
                    <input value={profile?.email || ''} readOnly className={cx(INP, '!bg-[#F9FAFB] cursor-not-allowed !text-[#9CA3AF] !pr-28')} />
                    <Badge hue="amber" className="absolute right-2 inset-y-0 my-auto !h-5 !text-[11px]">Contact admin</Badge>
                  </div>
                </div>
                <div>
                  <label className={L.label}>
                    <span className="flex items-center gap-1"><Phone className="w-3 h-3" strokeWidth={1.75} /> Phone Number</span>
                  </label>
                  <input value={phone} onChange={e => setPhone(e.target.value)} className={INP} placeholder="+91 98765 43210" type="tel" />
                </div>
              </div>
              <button type="button" onClick={() => void saveProfile()} disabled={saving} className={cx(L.btn, L.btnPrimary)}>
                {saving ? 'Saving…' : 'Save Changes'}
              </button>
            </>
          )}
        </div>
      )}

      {section === 'security' && (
        <div className={cx(L.card, 'p-4 space-y-4')}>
          <div>
            <h3 className={L.cardTitle}>
              <Shield className="w-4 h-4 text-[#6B7280]" strokeWidth={1.75} /> Change Password
            </h3>
            <p className={cx(L.meta, 'mt-0.5')}>Use at least 8 characters with a mix of letters and numbers.</p>
          </div>
          <div className="space-y-3 max-w-md">
            <div>
              <label className={L.label}>New Password</label>
              <input type="password" value={newPwd} onChange={e => setNewPwd(e.target.value)}
                className={INP} placeholder="Min. 8 characters" />
            </div>
            <div>
              <label className={L.label}>Confirm New Password</label>
              <input type="password" value={confirmPwd} onChange={e => setConfirmPwd(e.target.value)}
                className={INP} placeholder="Repeat new password" />
            </div>
            {newPwd && confirmPwd && newPwd !== confirmPwd && (
              <p className="text-[12px] text-[#DC2626] flex items-center gap-1">
                <AlertCircle className="w-3 h-3" strokeWidth={1.75} /> Passwords do not match
              </p>
            )}
          </div>
          <button type="button" onClick={() => void changePassword()}
            disabled={pwdSaving || !newPwd || !confirmPwd || newPwd !== confirmPwd}
            className={cx(L.btn, L.btnPrimary)}>
            <Shield className="w-4 h-4" strokeWidth={1.75} /> {pwdSaving ? 'Updating…' : 'Update Password'}
          </button>
        </div>
      )}

      {section === 'team' && (
        <div className={cx(L.card, 'p-4 space-y-4')}>
          <h3 className={L.cardTitle}>Team Information</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {[
              { label: 'Team', value: 'Branding Team' },
              { label: 'Role', value: roleLabel },
              { label: 'Department', value: profile?.department || '—' },
              { label: 'Account ID', value: profile?.id?.slice(0, 8).toUpperCase() + '…' || '—' },
            ].map(item => (
              <div key={item.label} className="rounded-[6px] bg-[#F9FAFB] border border-[#C5CAD1] px-3.5 py-3">
                <p className={cx(L.eyebrow, 'mb-1')}>{item.label}</p>
                <p className="text-[13px] font-medium text-[#111827]">{item.value}</p>
              </div>
            ))}
          </div>
          <div className="rounded-[6px] bg-[var(--nerve-primary-soft)] border border-[var(--nerve-primary-soft-border)] p-4">
            <p className={cx(L.eyebrow, '!text-[var(--nerve-primary-text)] mb-1.5')}>Team Permissions</p>
            <ul className="text-[12px] text-[#374151] space-y-1 list-disc list-inside">
              {permissions.map(item => <li key={item}>{item}</li>)}
            </ul>
          </div>
        </div>
      )}
    </div>
  )
}
