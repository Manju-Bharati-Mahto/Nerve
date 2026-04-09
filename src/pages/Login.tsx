import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth, getRoleDashboard } from '@/hooks/useAuth'
import { api } from '@/lib/api'
import { getErrorMessage } from '@/lib/error-utils'
import { BookOpen, Eye, EyeOff, ArrowLeft, Mail, KeyRound, ShieldCheck } from 'lucide-react'

type View = 'login' | 'forgot' | 'otp' | 'new-password' | 'resend-verify'

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

// ── Main page ──────────────────────────────────────────────────────────────
export default function LoginPage() {
  const [email, setEmail]     = useState('')
  const [password, setPassword] = useState('')
  const [showPw, setShowPw]   = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState('')
  const [view, setView]       = useState<View>('login')

  const [forgotEmail, setForgotEmail]         = useState('')
  const [otp, setOtp]                         = useState('')
  const [resetToken, setResetToken]           = useState('')
  const [newPw, setNewPw]                     = useState('')
  const [confirmPw, setConfirmPw]             = useState('')
  const [showNewPw, setShowNewPw]             = useState(false)
  const [subLoading, setSubLoading]           = useState(false)
  const [subError, setSubError]               = useState('')
  const [resendCountdown, setResendCountdown] = useState(0)

  const { signIn, user, role } = useAuth()
  const navigate = useNavigate()

  useEffect(() => {
    if (user && role) navigate(getRoleDashboard(role, null))
  }, [user, role, navigate])

  useEffect(() => {
    if (resendCountdown <= 0) return
    const t = setTimeout(() => setResendCountdown(c => c - 1), 1000)
    return () => clearTimeout(t)
  }, [resendCountdown])

  // ── Login ──────────────────────────────────────────────────────────────
  async function handleLogin(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true); setError('')
    try {
      await signIn(email, password)
    } catch (err: unknown) {
      const msg = getErrorMessage(err, 'Login failed.')
      if (msg === 'EMAIL_NOT_VERIFIED') setView('resend-verify')
      else setError(msg)
    }
    setLoading(false)
  }

  // ── Step 1: send OTP ───────────────────────────────────────────────────
  async function handleSendOtp(e: React.FormEvent) {
    e.preventDefault()
    setSubLoading(true); setSubError('')
    try {
      await api.sendOtp(forgotEmail.trim())
      setOtp(''); setView('otp'); setResendCountdown(60)
    } catch (err: unknown) {
      setSubError(getErrorMessage(err, 'Failed to send OTP.'))
    }
    setSubLoading(false)
  }

  // ── Step 2: verify OTP ─────────────────────────────────────────────────
  async function handleVerifyOtp(e: React.FormEvent) {
    e.preventDefault()
    const code = otp.replace(/\s/g, '')
    if (code.length < 6) { setSubError('Enter the full 6-digit code.'); return }
    setSubLoading(true); setSubError('')
    try {
      const res = await api.verifyOtp(forgotEmail.trim(), code)
      setResetToken(res.token); setNewPw(''); setConfirmPw('')
      setView('new-password')
    } catch (err: unknown) {
      setSubError(getErrorMessage(err, 'OTP is incorrect or expired.'))
    }
    setSubLoading(false)
  }

  // ── Step 3: set new password ───────────────────────────────────────────
  async function handleNewPassword(e: React.FormEvent) {
    e.preventDefault()
    if (newPw.length < 6) { setSubError('Password must be at least 6 characters.'); return }
    if (newPw !== confirmPw) { setSubError('Passwords do not match.'); return }
    setSubLoading(true); setSubError('')
    try {
      await api.resetPassword(resetToken, newPw)
      await signIn(forgotEmail.trim(), newPw)
    } catch (err: unknown) {
      setSubError(getErrorMessage(err, 'Failed to reset password.'))
    }
    setSubLoading(false)
  }

  async function handleResendOtp() {
    if (resendCountdown > 0 || subLoading) return
    setSubLoading(true); setSubError('')
    try {
      await api.sendOtp(forgotEmail.trim())
      setOtp(''); setResendCountdown(60)
    } catch (err: unknown) {
      setSubError(getErrorMessage(err, 'Failed to resend OTP.'))
    }
    setSubLoading(false)
  }

  async function handleResendVerify() {
    setSubLoading(true); setSubError('')
    try {
      await api.sendVerification(email.trim())
    } catch (err: unknown) {
      setSubError(getErrorMessage(err, 'Failed to send verification email.'))
    }
    setSubLoading(false)
  }

  function back() {
    setSubError(''); setOtp('')
    if (view === 'otp') setView('forgot')
    else if (view === 'new-password') setView('otp')
    else setView('login')
  }

  // ── Render ─────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm animate-fade-in">

        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-14 h-14 bg-primary rounded-2xl mb-4 shadow-lg">
            <BookOpen className="w-7 h-7 text-primary-foreground" />
          </div>
          <h1 className="text-2xl font-serif text-foreground">Parul University</h1>
          <p className="text-sm text-muted-foreground mt-1">Knowledge Hub</p>
        </div>

        {/* Login */}
        {view === 'login' && (
          <form onSubmit={handleLogin} className="hub-card space-y-4">
            <div>
              <label className="hub-label">Email</label>
              <input className="hub-input" type="email" value={email}
                onChange={e => setEmail(e.target.value)} required autoFocus
                placeholder="your@parul.ac.in" />
            </div>
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="hub-label mb-0">Password</label>
                <button type="button" className="text-xs text-primary hover:underline"
                  onClick={() => { setForgotEmail(email); setSubError(''); setView('forgot') }}>
                  Forgot password?
                </button>
              </div>
              <div className="relative">
                <input className="hub-input pr-10" type={showPw ? 'text' : 'password'}
                  value={password} onChange={e => setPassword(e.target.value)}
                  required placeholder="••••••••" />
                <button type="button" tabIndex={-1} onClick={() => setShowPw(v => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                  {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>
            {error && <p className="text-xs text-destructive bg-destructive/10 px-3 py-2 rounded-lg">{error}</p>}
            <button type="submit" disabled={loading}
              className="w-full py-2.5 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-brand-dark transition-colors disabled:opacity-50">
              {loading ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        )}

        {/* Step 1 — enter email */}
        {view === 'forgot' && (
          <div className="hub-card space-y-4">
            <div className="flex items-center gap-2">
              <button onClick={back} className="text-muted-foreground hover:text-foreground"><ArrowLeft className="w-4 h-4" /></button>
              <h2 className="text-sm font-semibold text-foreground">Forgot password</h2>
            </div>
            <p className="text-xs text-muted-foreground">Enter your registered email and we'll send a 6-digit OTP.</p>
            <form onSubmit={handleSendOtp} className="space-y-3">
              <div>
                <label className="hub-label">Email</label>
                <input className="hub-input" type="email" value={forgotEmail}
                  onChange={e => setForgotEmail(e.target.value)} required autoFocus
                  placeholder="your@parul.ac.in" />
              </div>
              {subError && <p className="text-xs text-destructive bg-destructive/10 px-3 py-2 rounded-lg">{subError}</p>}
              <button type="submit" disabled={subLoading}
                className="w-full py-2.5 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-brand-dark transition-colors disabled:opacity-50">
                {subLoading ? 'Sending…' : 'Send OTP'}
              </button>
            </form>
          </div>
        )}

        {/* Step 2 — enter OTP */}
        {view === 'otp' && (
          <div className="hub-card space-y-5">
            <div className="flex items-center gap-2">
              <button onClick={back} className="text-muted-foreground hover:text-foreground"><ArrowLeft className="w-4 h-4" /></button>
              <h2 className="text-sm font-semibold text-foreground">Enter OTP</h2>
            </div>
            <div className="text-center">
              <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-3">
                <Mail className="w-6 h-6 text-primary" />
              </div>
              <p className="text-xs text-muted-foreground">
                We sent a 6-digit code to <strong className="text-foreground">{forgotEmail}</strong>.<br />
                It expires in 10 minutes.
              </p>
            </div>
            <form onSubmit={handleVerifyOtp} className="space-y-4">
              <OtpInput value={otp} onChange={setOtp} />
              {subError && <p className="text-xs text-destructive bg-destructive/10 px-3 py-2 rounded-lg text-center">{subError}</p>}
              <button type="submit" disabled={subLoading || otp.replace(/\s/g, '').length < 6}
                className="w-full py-2.5 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-brand-dark transition-colors disabled:opacity-50 flex items-center justify-center gap-2">
                <ShieldCheck className="w-4 h-4" />
                {subLoading ? 'Verifying…' : 'Verify OTP'}
              </button>
            </form>
            <div className="text-center">
              {resendCountdown > 0
                ? <p className="text-xs text-muted-foreground">Resend in {resendCountdown}s</p>
                : <button onClick={() => void handleResendOtp()} disabled={subLoading}
                    className="text-xs text-primary hover:underline">Resend OTP</button>}
            </div>
          </div>
        )}

        {/* Step 3 — new password */}
        {view === 'new-password' && (
          <div className="hub-card space-y-4">
            <div className="flex items-center gap-2">
              <button onClick={back} className="text-muted-foreground hover:text-foreground"><ArrowLeft className="w-4 h-4" /></button>
              <h2 className="text-sm font-semibold text-foreground">Set new password</h2>
            </div>
            <div className="flex justify-center">
              <div className="w-12 h-12 rounded-full bg-green-100 flex items-center justify-center">
                <KeyRound className="w-6 h-6 text-green-600" />
              </div>
            </div>
            <p className="text-xs text-muted-foreground text-center">OTP verified! Choose a new password.</p>
            <form onSubmit={handleNewPassword} className="space-y-3">
              <div>
                <label className="hub-label">New Password</label>
                <div className="relative">
                  <input className="hub-input pr-10" type={showNewPw ? 'text' : 'password'}
                    value={newPw} onChange={e => setNewPw(e.target.value)}
                    required autoFocus minLength={6} placeholder="Min 6 characters" />
                  <button type="button" tabIndex={-1} onClick={() => setShowNewPw(v => !v)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                    {showNewPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>
              <div>
                <label className="hub-label">Confirm Password</label>
                <input className="hub-input" type={showNewPw ? 'text' : 'password'}
                  value={confirmPw} onChange={e => setConfirmPw(e.target.value)}
                  required placeholder="Repeat password" />
              </div>
              {subError && <p className="text-xs text-destructive bg-destructive/10 px-3 py-2 rounded-lg">{subError}</p>}
              <button type="submit" disabled={subLoading}
                className="w-full py-2.5 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-brand-dark transition-colors disabled:opacity-50">
                {subLoading ? 'Saving & signing in…' : 'Save & Sign in'}
              </button>
            </form>
          </div>
        )}

        {/* Email not verified */}
        {view === 'resend-verify' && (
          <div className="hub-card space-y-4">
            <div className="flex items-center gap-2">
              <button onClick={back} className="text-muted-foreground hover:text-foreground"><ArrowLeft className="w-4 h-4" /></button>
              <h2 className="text-sm font-semibold text-foreground">Email not verified</h2>
            </div>
            <p className="text-xs text-muted-foreground">
              Your email hasn't been verified yet. Click below to resend the link to <strong>{email}</strong>.
            </p>
            {subError && <p className="text-xs text-destructive bg-destructive/10 px-3 py-2 rounded-lg">{subError}</p>}
            {!subError && subLoading === false && (
              <p className="text-xs text-green-600">Verification email sent — check your inbox.</p>
            )}
            <button onClick={() => void handleResendVerify()} disabled={subLoading}
              className="w-full py-2.5 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-brand-dark transition-colors disabled:opacity-50">
              {subLoading ? 'Sending…' : 'Resend verification email'}
            </button>
          </div>
        )}

        <p className="text-center text-xs text-muted-foreground mt-6">
          Access is granted by your Super Admin.
        </p>
      </div>
    </div>
  )
}
