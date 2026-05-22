/**
 * The login form extracted from the standalone Login page so it can be
 * embedded inside the landing page (where it fades in over the neuron
 * animation at the end of scroll). Owns the full forgot-password / OTP /
 * verify-resend flow. The standalone Login page wraps this in its own
 * page chrome; the landing page wraps it in a glass card over the canvas.
 */
import { useState, useEffect, useRef } from 'react'
import { useAuth } from '@/hooks/useAuth'
import { api } from '@/lib/api'
import { getErrorMessage } from '@/lib/error-utils'
import { Eye, EyeOff, ArrowLeft, Mail, KeyRound, ShieldCheck } from 'lucide-react'

type View = 'login' | 'forgot' | 'otp' | 'new-password' | 'resend-verify'

// 6-box OTP input
function OtpInput({ value, onChange, dark }: { value: string; onChange: (v: string) => void; dark?: boolean }) {
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
  const boxBase = 'w-11 h-12 text-center text-lg font-bold rounded-lg focus:outline-none focus:ring-2 transition-all'
  const boxCls = dark
    ? `${boxBase} bg-white/5 border border-white/20 text-white focus:ring-[#ffe4f2] focus:border-[#ffe4f2]`
    : `${boxBase} bg-background border border-border focus:ring-primary`
  return (
    <div className="flex gap-2 justify-center" onPaste={handlePaste}>
      {[0, 1, 2, 3, 4, 5].map(i => (
        <input key={i} ref={el => { refs.current[i] = el }}
          type="text" inputMode="numeric" maxLength={1}
          value={digits[i].trim()}
          onChange={e => handleChange(i, e.target.value)}
          onKeyDown={e => handleKeyDown(i, e)}
          className={boxCls} />
      ))}
    </div>
  )
}

export interface LoginFormProps {
  /** When true, render with a transparent / dark-themed look so the
   *  form sits on top of the landing-page neuron canvas. */
  dark?: boolean
}

export default function LoginForm({ dark = false }: LoginFormProps) {
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

  const { signIn } = useAuth()

  useEffect(() => {
    if (resendCountdown <= 0) return
    const t = setTimeout(() => setResendCountdown(c => c - 1), 1000)
    return () => clearTimeout(t)
  }, [resendCountdown])

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

  // ── Themed style tokens ────────────────────────────────────────────────
  // Dark variant = the bold, solid pearl-pink (#ffe4f2) brand theme used
  // over the landing-page burst backdrop. Opaque pearl card, fully solid
  // border, saturated pink glow. "Solid" here means high opacities and
  // a flat-but-luminous look (not the airy translucent gradient before).
  const cardCls = dark
    ? 'rounded-2xl p-6 bg-[#ffe4f2]/[0.16] backdrop-blur-xl border-2 border-[#ffe4f2] ring-2 ring-[#ffe4f2]/35 space-y-4'
    : 'hub-card space-y-4'

  const labelCls = dark ? 'text-xs font-bold text-[#ffe4f2] uppercase tracking-wider' : 'hub-label'

  const inputCls = dark
    ? 'w-full px-3 py-2.5 rounded-lg bg-white/[0.08] border-2 border-[#ffe4f2]/55 text-white placeholder-white/45 focus:outline-none focus:ring-2 focus:ring-[#ffe4f2] focus:border-[#ffe4f2] transition-all'
    : 'hub-input'

  const subtleCls = dark ? 'text-[#ffe4f2]/85' : 'text-muted-foreground'

  const linkCls = dark ? 'text-[#ffe4f2] hover:text-white font-bold' : 'text-primary hover:underline'

  // Button: solid pearl-pink with a deep-rose text colour for contrast,
  // bright white top highlight + saturated pink outer glow for the bold
  // "polished/solid" finish.
  const buttonCls = dark
    ? 'w-full py-2.5 rounded-lg bg-gradient-to-br from-white via-[#ffe4f2] to-[#f5b8d5] text-[#5a2b3e] text-sm font-bold tracking-wide shadow-[0_8px_30px_rgba(255,228,242,0.65),inset_0_1px_0_rgba(255,255,255,0.85)] hover:from-[#fff7fb] hover:via-white hover:to-[#ffe4f2] active:translate-y-px transition-all disabled:opacity-50'
    : 'w-full py-2.5 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-brand-dark transition-colors disabled:opacity-50'

  const errorCls = dark
    ? 'text-xs text-rose-300 bg-rose-500/10 border border-rose-500/30 px-3 py-2 rounded-lg'
    : 'text-xs text-destructive bg-destructive/10 px-3 py-2 rounded-lg'

  const eyeBtn = dark ? 'absolute right-3 top-1/2 -translate-y-1/2 text-white/40 hover:text-white' : 'absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground'

  return (
    <>
      {/* Login */}
      {view === 'login' && (
        <form onSubmit={handleLogin} className={cardCls}>
          <div>
            <label className={labelCls}>Email</label>
            <input className={inputCls} type="email" value={email}
              onChange={e => setEmail(e.target.value)} required autoFocus
              placeholder="your@parul.ac.in" />
          </div>
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className={`${labelCls} mb-0`}>Password</label>
              <button type="button" className={`text-xs ${linkCls}`}
                onClick={() => { setForgotEmail(email); setSubError(''); setView('forgot') }}>
                Forgot password?
              </button>
            </div>
            <div className="relative">
              <input className={`${inputCls} pr-10`} type={showPw ? 'text' : 'password'}
                value={password} onChange={e => setPassword(e.target.value)}
                required placeholder="••••••••" />
              <button type="button" tabIndex={-1} onClick={() => setShowPw(v => !v)} className={eyeBtn}>
                {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>
          {error && <p className={errorCls}>{error}</p>}
          <button type="submit" disabled={loading} className={buttonCls}>
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      )}

      {/* Step 1 — enter email */}
      {view === 'forgot' && (
        <div className={cardCls}>
          <div className="flex items-center gap-2">
            <button onClick={back} className={subtleCls}><ArrowLeft className="w-4 h-4" /></button>
            <h2 className={`text-sm font-bold ${dark ? 'text-white' : 'text-foreground'}`}>Forgot password</h2>
          </div>
          <p className={`text-xs ${subtleCls}`}>Enter your registered email and we'll send a 6-digit OTP.</p>
          <form onSubmit={handleSendOtp} className="space-y-3">
            <div>
              <label className={labelCls}>Email</label>
              <input className={inputCls} type="email" value={forgotEmail}
                onChange={e => setForgotEmail(e.target.value)} required autoFocus
                placeholder="your@parul.ac.in" />
            </div>
            {subError && <p className={errorCls}>{subError}</p>}
            <button type="submit" disabled={subLoading} className={buttonCls}>
              {subLoading ? 'Sending…' : 'Send OTP'}
            </button>
          </form>
        </div>
      )}

      {/* Step 2 — enter OTP */}
      {view === 'otp' && (
        <div className={`${cardCls} space-y-5`}>
          <div className="flex items-center gap-2">
            <button onClick={back} className={subtleCls}><ArrowLeft className="w-4 h-4" /></button>
            <h2 className={`text-sm font-bold ${dark ? 'text-white' : 'text-foreground'}`}>Enter OTP</h2>
          </div>
          <div className="text-center">
            <div className={`w-12 h-12 rounded-full flex items-center justify-center mx-auto mb-3 ${dark ? 'bg-[#ffe4f2]/25' : 'bg-primary/10'}`}>
              <Mail className={`w-6 h-6 ${dark ? 'text-[#ffe4f2]' : 'text-primary'}`} />
            </div>
            <p className={`text-xs ${subtleCls}`}>
              We sent a 6-digit code to <strong className={dark ? 'text-white' : 'text-foreground'}>{forgotEmail}</strong>.<br />
              It expires in 10 minutes.
            </p>
          </div>
          <form onSubmit={handleVerifyOtp} className="space-y-4">
            <OtpInput value={otp} onChange={setOtp} dark={dark} />
            {subError && <p className={`${errorCls} text-center`}>{subError}</p>}
            <button type="submit" disabled={subLoading || otp.replace(/\s/g, '').length < 6} className={`${buttonCls} flex items-center justify-center gap-2`}>
              <ShieldCheck className="w-4 h-4" />
              {subLoading ? 'Verifying…' : 'Verify OTP'}
            </button>
          </form>
          <div className="text-center">
            {resendCountdown > 0
              ? <p className={`text-xs ${subtleCls}`}>Resend in {resendCountdown}s</p>
              : <button onClick={() => void handleResendOtp()} disabled={subLoading}
                  className={`text-xs ${linkCls}`}>Resend OTP</button>}
          </div>
        </div>
      )}

      {/* Step 3 — new password */}
      {view === 'new-password' && (
        <div className={cardCls}>
          <div className="flex items-center gap-2">
            <button onClick={back} className={subtleCls}><ArrowLeft className="w-4 h-4" /></button>
            <h2 className={`text-sm font-bold ${dark ? 'text-white' : 'text-foreground'}`}>Set new password</h2>
          </div>
          <div className="flex justify-center">
            <div className={`w-12 h-12 rounded-full flex items-center justify-center ${dark ? 'bg-[#ffe4f2]/25' : 'bg-green-100'}`}>
              <KeyRound className={`w-6 h-6 ${dark ? 'text-[#ffe4f2]' : 'text-green-600'}`} />
            </div>
          </div>
          <p className={`text-xs text-center ${subtleCls}`}>OTP verified! Choose a new password.</p>
          <form onSubmit={handleNewPassword} className="space-y-3">
            <div>
              <label className={labelCls}>New Password</label>
              <div className="relative">
                <input className={`${inputCls} pr-10`} type={showNewPw ? 'text' : 'password'}
                  value={newPw} onChange={e => setNewPw(e.target.value)}
                  required autoFocus minLength={6} placeholder="Min 6 characters" />
                <button type="button" tabIndex={-1} onClick={() => setShowNewPw(v => !v)} className={eyeBtn}>
                  {showNewPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>
            <div>
              <label className={labelCls}>Confirm Password</label>
              <input className={inputCls} type={showNewPw ? 'text' : 'password'}
                value={confirmPw} onChange={e => setConfirmPw(e.target.value)}
                required placeholder="Repeat password" />
            </div>
            {subError && <p className={errorCls}>{subError}</p>}
            <button type="submit" disabled={subLoading} className={buttonCls}>
              {subLoading ? 'Saving & signing in…' : 'Save & Sign in'}
            </button>
          </form>
        </div>
      )}

      {/* Email not verified */}
      {view === 'resend-verify' && (
        <div className={cardCls}>
          <div className="flex items-center gap-2">
            <button onClick={back} className={subtleCls}><ArrowLeft className="w-4 h-4" /></button>
            <h2 className={`text-sm font-bold ${dark ? 'text-white' : 'text-foreground'}`}>Email not verified</h2>
          </div>
          <p className={`text-xs ${subtleCls}`}>
            Your email hasn't been verified yet. Click below to resend the link to <strong className={dark ? 'text-white' : 'text-foreground'}>{email}</strong>.
          </p>
          {subError && <p className={errorCls}>{subError}</p>}
          {!subError && subLoading === false && (
            <p className={`text-xs ${dark ? 'text-[#ffe4f2]' : 'text-green-600'}`}>Verification email sent — check your inbox.</p>
          )}
          <button onClick={() => void handleResendVerify()} disabled={subLoading} className={buttonCls}>
            {subLoading ? 'Sending…' : 'Resend verification email'}
          </button>
        </div>
      )}
    </>
  )
}
