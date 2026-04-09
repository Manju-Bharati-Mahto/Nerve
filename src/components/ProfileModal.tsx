import { useState, useRef, useEffect } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useAuth } from '@/hooks/useAuth'
import { api } from '@/lib/api'
import { Camera, Shield, User, ArrowLeft, CheckCircle2, Eye, EyeOff } from 'lucide-react'
import { toast } from 'sonner'

// ── Shared input style ─────────────────────────────────────────────────────
const INP = 'w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary transition'

// ── 6-box OTP input ────────────────────────────────────────────────────────
function OtpInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const refs = useRef<(HTMLInputElement | null)[]>([])
  const digits = value.padEnd(6, ' ').split('').slice(0, 6)

  function handleChange(i: number, raw: string) {
    const d = raw.replace(/\D/g, '').slice(-1)
    const next = [...digits]
    next[i] = d || ' '
    onChange(next.join('').trimEnd())
    if (d && i < 5) refs.current[i + 1]?.focus()
  }

  function handleKeyDown(i: number, e: React.KeyboardEvent) {
    if (e.key === 'Backspace' && digits[i].trim() === '' && i > 0) {
      const next = [...digits]; next[i - 1] = ' '
      onChange(next.join('').trimEnd())
      refs.current[i - 1]?.focus()
    }
  }

  function handlePaste(e: React.ClipboardEvent) {
    const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6)
    onChange(pasted)
    refs.current[Math.min(pasted.length, 5)]?.focus()
    e.preventDefault()
  }

  return (
    <div className="flex gap-2 justify-center" onPaste={handlePaste}>
      {[0, 1, 2, 3, 4, 5].map(i => (
        <input
          key={i}
          ref={el => { refs.current[i] = el }}
          type="text"
          inputMode="numeric"
          maxLength={1}
          value={digits[i].trim()}
          onChange={e => handleChange(i, e.target.value)}
          onKeyDown={e => handleKeyDown(i, e)}
          className="w-11 h-12 text-center text-lg font-bold border border-border rounded-lg bg-background focus:outline-none focus:ring-2 focus:ring-primary transition-all"
        />
      ))}
    </div>
  )
}

// ── Password change sub-flow ───────────────────────────────────────────────
type PwStep = 'idle' | 'otp-sent' | 'new-password' | 'done'

function ChangePasswordSection({ email }: { email: string }) {
  const [step, setStep] = useState<PwStep>('idle')
  const [loading, setLoading] = useState(false)
  const [otp, setOtp] = useState('')
  const [token, setToken] = useState('')
  const [newPw, setNewPw] = useState('')
  const [confirmPw, setConfirmPw] = useState('')
  const [showPw, setShowPw] = useState(false)
  const [countdown, setCountdown] = useState(0)

  useEffect(() => {
    if (countdown <= 0) return
    const t = setTimeout(() => setCountdown(c => c - 1), 1000)
    return () => clearTimeout(t)
  }, [countdown])

  async function sendOtp() {
    setLoading(true)
    try {
      await api.sendChangeOtp()
      setStep('otp-sent')
      setCountdown(60)
      toast.success(`OTP sent to ${email}`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to send OTP')
    } finally {
      setLoading(false)
    }
  }

  async function verifyOtp() {
    if (otp.replace(/\s/g, '').length !== 6) {
      toast.error('Enter the 6-digit OTP')
      return
    }
    setLoading(true)
    try {
      const res = await api.verifyChangeOtp(otp.replace(/\s/g, ''))
      setToken(res.token)
      setStep('new-password')
      setOtp('')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Invalid or expired OTP')
    } finally {
      setLoading(false)
    }
  }

  async function savePassword() {
    if (newPw.length < 8) { toast.error('Minimum 8 characters required'); return }
    if (newPw !== confirmPw) { toast.error('Passwords do not match'); return }
    setLoading(true)
    try {
      await api.resetPassword(token, newPw)
      setStep('done')
      toast.success('Password updated successfully!')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to update password')
    } finally {
      setLoading(false)
    }
  }

  if (step === 'done') {
    return (
      <div className="flex flex-col items-center gap-3 py-6 text-center">
        <CheckCircle2 className="w-12 h-12 text-green-500" />
        <p className="font-semibold text-foreground">Password updated!</p>
        <p className="text-sm text-muted-foreground">Your new password is now active.</p>
        <button onClick={() => { setStep('idle'); setNewPw(''); setConfirmPw('') }}
          className="text-sm text-primary underline underline-offset-2">
          Change again
        </button>
      </div>
    )
  }

  if (step === 'idle') {
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          We'll send a one-time code to <span className="font-medium text-foreground">{email}</span> to verify your identity before changing your password.
        </p>
        <button onClick={() => void sendOtp()} disabled={loading}
          className="flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-semibold bg-primary text-primary-foreground disabled:opacity-50 transition-colors">
          <Shield className="w-4 h-4" />
          {loading ? 'Sending…' : 'Send Verification Code'}
        </button>
      </div>
    )
  }

  if (step === 'otp-sent') {
    return (
      <div className="space-y-4">
        <div className="text-center space-y-1">
          <p className="text-sm font-medium text-foreground">Enter the 6-digit code</p>
          <p className="text-xs text-muted-foreground">Sent to {email} · expires in 10 min</p>
        </div>
        <OtpInput value={otp} onChange={setOtp} />
        <button onClick={() => void verifyOtp()} disabled={loading || otp.replace(/\s/g, '').length !== 6}
          className="w-full py-2.5 rounded-lg text-sm font-semibold bg-primary text-primary-foreground disabled:opacity-50 transition-colors">
          {loading ? 'Verifying…' : 'Verify Code'}
        </button>
        <div className="text-center">
          {countdown > 0
            ? <span className="text-xs text-muted-foreground">Resend in {countdown}s</span>
            : (
              <button onClick={() => void sendOtp()} disabled={loading}
                className="text-xs text-primary underline underline-offset-2 disabled:opacity-50">
                Resend code
              </button>
            )
          }
        </div>
        <button onClick={() => { setStep('idle'); setOtp('') }}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors">
          <ArrowLeft className="w-3 h-3" /> Back
        </button>
      </div>
    )
  }

  // new-password
  return (
    <div className="space-y-4">
      <p className="text-sm font-medium text-foreground">Set your new password</p>
      <div className="space-y-3">
        <div>
          <label className="text-xs font-semibold text-muted-foreground block mb-1">New Password</label>
          <div className="relative">
            <input type={showPw ? 'text' : 'password'} value={newPw} onChange={e => setNewPw(e.target.value)}
              className={`${INP} pr-10`} placeholder="Min. 8 characters" autoFocus />
            <button type="button" onClick={() => setShowPw(v => !v)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors">
              {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
        </div>
        <div>
          <label className="text-xs font-semibold text-muted-foreground block mb-1">Confirm New Password</label>
          <input type={showPw ? 'text' : 'password'} value={confirmPw} onChange={e => setConfirmPw(e.target.value)}
            className={INP} placeholder="Repeat new password" />
        </div>
        {newPw && confirmPw && newPw !== confirmPw && (
          <p className="text-xs text-red-500">Passwords do not match</p>
        )}
      </div>
      <button onClick={() => void savePassword()}
        disabled={loading || !newPw || !confirmPw || newPw !== confirmPw}
        className="w-full py-2.5 rounded-lg text-sm font-semibold bg-primary text-primary-foreground disabled:opacity-50 transition-colors">
        {loading ? 'Saving…' : 'Update Password'}
      </button>
      <button onClick={() => { setStep('idle'); setToken('') }}
        className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors">
        <ArrowLeft className="w-3 h-3" /> Back
      </button>
    </div>
  )
}

// ── Main modal ─────────────────────────────────────────────────────────────
type Tab = 'profile' | 'security'

interface ProfileModalProps {
  open: boolean
  onClose: () => void
}

export default function ProfileModal({ open, onClose }: ProfileModalProps) {
  const { profile, refreshProfile } = useAuth()
  const [tab, setTab] = useState<Tab>('profile')
  const [editMode, setEditMode] = useState(false)
  const [fullName, setFullName] = useState('')
  const [department, setDepartment] = useState('')
  const [avatarUrl, setAvatarUrl] = useState('')
  const [avatarUploading, setAvatarUploading] = useState(false)
  const [saving, setSaving] = useState(false)

  // Sync local state from profile when modal opens
  useEffect(() => {
    if (open && profile) {
      setFullName(profile.full_name || '')
      setDepartment(profile.department || '')
      setAvatarUrl(profile.avatar_url || '')
      setEditMode(false)
      setTab('profile')
    }
  }, [open, profile])

  const initials = (profile?.full_name || profile?.email || 'U')
    .split(' ').map((n: string) => n[0]).join('').slice(0, 2).toUpperCase()

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
    setSaving(true)
    try {
      await api.updateMe({ full_name: fullName, department })
      await refreshProfile()
      toast.success('Profile updated!')
      setEditMode(false)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save profile')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={v => { if (!v) onClose() }}>
      <DialogContent className="max-w-md p-0 overflow-hidden">
        <div className="flex flex-col">
          {/* Header with avatar */}
          <div className="bg-accent/30 px-6 pt-6 pb-4">
            <DialogHeader>
              <DialogTitle className="sr-only">Your Profile</DialogTitle>
            </DialogHeader>
            <div className="flex items-center gap-4">
              <div className="relative shrink-0">
                {avatarUrl
                  ? <img src={avatarUrl} alt="avatar" className="w-16 h-16 rounded-2xl object-cover" />
                  : (
                    <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center text-xl font-bold text-primary">
                      {initials}
                    </div>
                  )
                }
                <label className={`absolute -bottom-1 -right-1 w-6 h-6 rounded-full bg-background border border-border shadow flex items-center justify-center cursor-pointer hover:bg-accent transition-colors ${avatarUploading ? 'opacity-60 pointer-events-none' : ''}`}>
                  {avatarUploading
                    ? <div className="w-3 h-3 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                    : <Camera className="w-3 h-3 text-muted-foreground" />
                  }
                  <input type="file" accept="image/*" className="hidden" onChange={handleAvatarChange} disabled={avatarUploading} />
                </label>
              </div>
              <div className="min-w-0">
                <p className="font-semibold text-foreground truncate">{profile?.full_name || 'Your Name'}</p>
                <p className="text-sm text-muted-foreground truncate">{profile?.email}</p>
                {profile?.department && (
                  <p className="text-xs text-muted-foreground truncate">{profile.department}</p>
                )}
              </div>
            </div>
          </div>

          {/* Tabs */}
          <div className="flex border-b border-border">
            {([['profile', 'Profile'], ['security', 'Change Password']] as const).map(([t, label]) => (
              <button key={t} onClick={() => setTab(t)}
                className={`flex-1 py-2.5 text-sm font-semibold transition-colors border-b-2 -mb-px ${
                  tab === t
                    ? 'border-primary text-primary'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                }`}>
                {label}
              </button>
            ))}
          </div>

          {/* Content */}
          <div className="px-6 py-5">
            {tab === 'profile' && (
              <div className="space-y-4">
                {!editMode ? (
                  <>
                    <div className="space-y-3">
                      {[
                        { label: 'Full Name', value: profile?.full_name || '—' },
                        { label: 'Designation / Department', value: profile?.department || '—' },
                        { label: 'Email Address', value: profile?.email || '—' },
                      ].map(item => (
                        <div key={item.label} className="rounded-lg bg-accent/30 px-3 py-2.5">
                          <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide mb-0.5">{item.label}</p>
                          <p className="text-sm font-medium text-foreground">{item.value}</p>
                        </div>
                      ))}
                    </div>
                    <button onClick={() => setEditMode(true)}
                      className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold border border-border hover:bg-accent transition-colors">
                      <User className="w-4 h-4" /> Edit Profile
                    </button>
                  </>
                ) : (
                  <div className="space-y-4">
                    <div className="space-y-3">
                      <div>
                        <label className="text-xs font-semibold text-muted-foreground block mb-1">Full Name</label>
                        <input value={fullName} onChange={e => setFullName(e.target.value)}
                          className={INP} placeholder="Your full name" autoFocus />
                      </div>
                      <div>
                        <label className="text-xs font-semibold text-muted-foreground block mb-1">Designation / Department</label>
                        <input value={department} onChange={e => setDepartment(e.target.value)}
                          className={INP} placeholder="e.g. Content Writer" />
                      </div>
                      <div>
                        <label className="text-xs font-semibold text-muted-foreground block mb-1">Email Address</label>
                        <div className="relative">
                          <input value={profile?.email || ''} readOnly
                            className={`${INP} bg-accent/30 cursor-not-allowed text-muted-foreground pr-28`} />
                          <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-amber-600 bg-amber-50 px-1.5 py-0.5 rounded font-medium">
                            Contact admin
                          </span>
                        </div>
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <button onClick={() => void saveProfile()} disabled={saving}
                        className="px-4 py-2 rounded-lg text-sm font-semibold bg-primary text-primary-foreground disabled:opacity-50 transition-colors">
                        {saving ? 'Saving…' : 'Save Changes'}
                      </button>
                      <button onClick={() => { setEditMode(false); setFullName(profile?.full_name || ''); setDepartment(profile?.department || '') }}
                        className="px-4 py-2 rounded-lg text-sm font-semibold border border-border hover:bg-accent transition-colors">
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {tab === 'security' && (
              <ChangePasswordSection email={profile?.email || ''} />
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
