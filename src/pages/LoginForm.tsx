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
import { L, cx } from '@/pages/branding/ds2'
import { applyAppearanceForEmail } from '@/pages/branding/theme'

const DEMO_BUILD = import.meta.env.VITE_DEMO_MODE === 'true'

type View = 'login' | 'forgot' | 'otp' | 'new-password' | 'resend-verify'

/** The multicolour Google "G". */
function GoogleMark({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" className={className} aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  )
}

// 6-box OTP input
function OtpInput({ value, onChange, dark, nerve }: { value: string; onChange: (v: string) => void; dark?: boolean; nerve?: boolean }) {
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
  const boxCls = nerve
    ? 'w-11 h-12 text-center text-lg font-semibold rounded-[6px] bg-white border border-[#C5CAD1] text-[#111827] focus:outline-none focus:border-[var(--nerve-primary)] focus:ring-2 focus:ring-[var(--nerve-primary-soft-border)] transition-colors'
    : dark
    ? `${boxBase} bg-white/70 border border-slate-200 text-slate-900 focus:bg-white focus:ring-bp-500/30 focus:border-bp-500`
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
  /** 'nerve' renders with the Nerve Light design system (ds2) — plain
   *  fields on a white card, the primary-colour button. Used by /login. */
  variant?: 'nerve'
}

export default function LoginForm({ dark = false, variant }: LoginFormProps) {
  const nerve = variant === 'nerve'
  const [email, setEmail]     = useState('')
  // A returning person's saved colour and mode come up as soon as their
  // e-mail is entered, so the sign-in page already looks like their dashboard.
  useEffect(() => {
    const t = setTimeout(() => { applyAppearanceForEmail(email) }, 250)
    return () => clearTimeout(t)
  }, [email])
  const [password, setPassword] = useState('')
  const [showPw, setShowPw]   = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState('')
  const [view, setView]       = useState<View>('login')
  const [googleNote, setGoogleNote] = useState(false)

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
  // "dark" now means "over the dark aurora", not "dark card". The card itself
  // is frosted white: a sheet of glass lit from the top-left, with the blue
  // behind it showing through and blurred. Dark-on-light also gives the form
  // the contrast a login screen ought to have — the previous smoked-glass
  // panel put white labels on a mid-blue field at roughly 3:1.
  const cardCls = nerve
    ? 'space-y-4'
    : dark
    ? 'rounded-2xl p-6 bg-gradient-to-b from-white/95 via-white/88 to-white/80 backdrop-blur-2xl border border-white/70 ring-1 ring-white/20 shadow-[0_35px_80px_-25px_rgba(2,12,27,0.85)] space-y-4'
    : 'hub-card space-y-4'

  const labelCls = nerve
    ? L.label
    : dark
    ? 'block mb-1.5 text-[11px] font-bold text-slate-500 uppercase tracking-wider'
    : 'hub-label'

  const inputCls = nerve
    ? L.input
    : dark
    ? 'w-full px-3.5 py-2.5 rounded-xl bg-white/70 border border-slate-200 text-slate-900 placeholder-slate-400 focus:outline-none focus:bg-white focus:border-bp-500 focus:ring-2 focus:ring-bp-500/25 hover:border-slate-300 transition-colors'
    : 'hub-input'

  const subtleCls = nerve ? 'text-[#6B7280]' : dark ? 'text-slate-500' : 'text-muted-foreground'
  const ink = nerve ? 'text-[#111827]' : dark ? 'text-slate-900' : 'text-foreground'

  const linkCls = nerve ? 'text-[var(--nerve-primary-text)] hover:underline font-medium' : dark ? 'text-bp-700 hover:text-bp-800 font-bold' : 'text-primary hover:underline'

  // The one filled element on the card, in the same gradient the dashboard's
  // KPI cards take on hover.
  const buttonCls = nerve
    ? cx(L.btn, L.btnPrimary, 'w-full')
    : dark
    ? 'w-full py-2.5 rounded-xl bg-gradient-to-br from-bp-500 via-bp-600 to-bp-800 text-white text-sm font-bold tracking-wide shadow-[0_12px_28px_-10px_rgba(0,119,182,0.95)] hover:brightness-110 active:translate-y-px transition-all disabled:opacity-50 disabled:hover:brightness-100'
    : 'w-full py-2.5 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-brand-dark transition-colors disabled:opacity-50'

  const errorCls = nerve
    ? 'text-[12px] text-[#B91C1C] bg-[#FEF2F2] border border-[#FECACA] px-3 py-2 rounded-[6px]'
    : dark
    ? 'text-xs font-semibold text-rose-700 bg-rose-50 border border-rose-200 px-3 py-2 rounded-xl'
    : 'text-xs text-destructive bg-destructive/10 px-3 py-2 rounded-lg'

  const eyeBtn = nerve ? 'absolute right-3 top-1/2 -translate-y-1/2 text-[#9CA3AF] hover:text-[#111827] transition-colors' : dark ? 'absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700 transition-colors' : 'absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground'

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
            <div className="flex items-center justify-between mb-1.5">
              <label className={`${labelCls} !mb-0`}>Password</label>
              <button type="button" className={`${nerve ? 'text-[12px]' : 'text-xs'} ${linkCls}`}
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

          {nerve && (
            <>
              <div className="flex items-center gap-3 text-[11px] uppercase tracking-[0.06em] text-[#9CA3AF]" aria-hidden="true">
                <span className="flex-1 border-t border-[#C5CAD1]" />
                or
                <span className="flex-1 border-t border-[#C5CAD1]" />
              </div>
              {/* Google sign-in is not wired to the API yet; the button is
                  here so the flow is in place, and says so when pressed. */}
              <button
                type="button"
                onClick={() => setGoogleNote(true)}
                className={cx(L.btn, 'w-full bg-white border border-[#C5CAD1] text-[#111827] hover:bg-[#F9FAFB] hover:border-[#9CA3AF]')}
              >
                <GoogleMark className="w-4 h-4" />
                Login with Google
              </button>
              {googleNote && (
                <p className="text-[12px] text-[#6B7280] text-center" role="status">
                  Google sign-in isn’t enabled for this workspace yet. Use your Parul email and password, or ask your Super Admin.
                </p>
              )}

              {/* Demo builds only (VITE_DEMO_MODE=true): a production build has no
                  demo sign-in UI. Test accounts are listed for developers in
                  HANDOFF-README.md instead. */}
              {DEMO_BUILD && <div className="pt-2 border-t border-[#E5E7EB] text-[12px]">
                <p className="text-[#6B7280] mb-1.5">Quick fill a demo account:</p>
                <div className="flex items-center gap-1.5 flex-wrap">
                  {([
                    ['Ananya Rao', 'ananya.rao.demo@paruluniversity.ac.in', 'Demo@12345'],
                    ['Branding Lead', 'brand-lead@parul.ac.in', 'brandlead123'],
                    ['Branding Admin', 'brand-admin@parul.ac.in', 'brand123'],
                  ] as const).map(([label, mail, pw]) => (
                    <button
                      key={mail}
                      type="button"
                      onClick={() => { setEmail(mail); setPassword(pw); setError('') }}
                      className={cx(L.btn, L.btnSecondary, L.btnSm, email === mail && '!border-[var(--nerve-primary)] !text-[var(--nerve-primary-text)]')}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>}
            </>
          )}
        </form>
      )}

      {/* Step 1 — enter email */}
      {view === 'forgot' && (
        <div className={cardCls}>
          <div className="flex items-center gap-2">
            <button onClick={back} className={subtleCls}><ArrowLeft className="w-4 h-4" /></button>
            <h2 className={`text-sm font-bold ${ink}`}>Forgot password</h2>
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
            <h2 className={`text-sm font-bold ${ink}`}>Enter OTP</h2>
          </div>
          <div className="text-center">
            <div className={`w-12 h-12 rounded-full flex items-center justify-center mx-auto mb-3 ${nerve ? 'bg-[var(--nerve-primary-soft)] border border-[var(--nerve-primary-soft-border)] !rounded-[8px]' : dark ? 'bg-bp-50 border border-bp-100' : 'bg-primary/10'}`}>
              <Mail className={`w-6 h-6 ${nerve ? 'text-[var(--nerve-primary-text)]' : dark ? 'text-bp-600' : 'text-primary'}`} />
            </div>
            <p className={`text-xs ${subtleCls}`}>
              We sent a 6-digit code to <strong className={ink}>{forgotEmail}</strong>.<br />
              It expires in 10 minutes.
            </p>
          </div>
          <form onSubmit={handleVerifyOtp} className="space-y-4">
            <OtpInput value={otp} onChange={setOtp} dark={dark} nerve={nerve} />
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
            <h2 className={`text-sm font-bold ${ink}`}>Set new password</h2>
          </div>
          <div className="flex justify-center">
            <div className={`w-12 h-12 rounded-full flex items-center justify-center ${nerve ? 'bg-[#F0FDF4] border border-[#BBF7D0] !rounded-[8px]' : dark ? 'bg-emerald-50 border border-emerald-100' : 'bg-green-100'}`}>
              <KeyRound className={`w-6 h-6 ${nerve ? 'text-[#16A34A]' : dark ? 'text-emerald-600' : 'text-green-600'}`} />
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
            <h2 className={`text-sm font-bold ${ink}`}>Email not verified</h2>
          </div>
          <p className={`text-xs ${subtleCls}`}>
            Your email hasn't been verified yet. Click below to resend the link to <strong className={ink}>{email}</strong>.
          </p>
          {subError && <p className={errorCls}>{subError}</p>}
          {!subError && subLoading === false && (
            <p className={`text-xs font-medium ${nerve ? 'text-[#15803D]' : dark ? 'text-emerald-700' : 'text-green-600'}`}>Verification email sent — check your inbox.</p>
          )}
          <button onClick={() => void handleResendVerify()} disabled={subLoading} className={buttonCls}>
            {subLoading ? 'Sending…' : 'Resend verification email'}
          </button>
        </div>
      )}
    </>
  )
}
