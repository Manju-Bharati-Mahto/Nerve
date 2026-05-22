/**
 * /reset-password — landing point after a user clicks the password-reset
 * link from their email. Token comes in via ?token=<jwt>. Themed to match
 * the landing page's pearl-pink AuthShell.
 */
import { useState } from 'react'
import { useNavigate, useSearchParams, Link } from 'react-router-dom'
import { api } from '@/lib/api'
import { Eye, EyeOff, CheckCircle2 } from 'lucide-react'
import AuthShell from '@/components/AuthShell'

export default function ResetPasswordPage() {
  const [params] = useSearchParams()
  const token = params.get('token') ?? ''
  const navigate = useNavigate()

  const [password, setPassword]   = useState('')
  const [confirm, setConfirm]     = useState('')
  const [showPw, setShowPw]       = useState(false)
  const [loading, setLoading]     = useState(false)
  const [error, setError]         = useState('')
  const [done, setDone]           = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (password.length < 6) { setError('Password must be at least 6 characters.'); return }
    if (password !== confirm) { setError('Passwords do not match.'); return }
    setLoading(true); setError('')
    try {
      await api.resetPassword(token, password)
      setDone(true)
      setTimeout(() => navigate('/login'), 3000)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Reset failed.')
    }
    setLoading(false)
  }

  // ── Dark pearl-pink form tokens (mirror LoginForm's `dark` variant) ────
  const cardCls   = 'rounded-2xl p-6 bg-[#ffe4f2]/[0.16] backdrop-blur-xl border-2 border-[#ffe4f2] ring-2 ring-[#ffe4f2]/35 space-y-4'
  const labelCls  = 'text-xs font-bold text-[#ffe4f2] uppercase tracking-wider'
  const inputCls  = 'w-full px-3 py-2.5 rounded-lg bg-white/[0.08] border-2 border-[#ffe4f2]/55 text-white placeholder-white/45 focus:outline-none focus:ring-2 focus:ring-[#ffe4f2] focus:border-[#ffe4f2] transition-all'
  const buttonCls = 'w-full py-2.5 rounded-lg bg-gradient-to-br from-white via-[#ffe4f2] to-[#f5b8d5] text-[#5a2b3e] text-sm font-bold tracking-wide shadow-[0_8px_30px_rgba(255,228,242,0.65),inset_0_1px_0_rgba(255,255,255,0.85)] hover:from-[#fff7fb] hover:via-white hover:to-[#ffe4f2] active:translate-y-px transition-all disabled:opacity-50'
  const errorCls  = 'text-xs text-rose-200 bg-rose-500/15 border border-rose-400/40 px-3 py-2 rounded-lg'
  const linkCls   = 'text-xs text-[#ffe4f2] hover:text-white font-bold'

  let heading = 'Set new password'
  let sub: string | undefined = 'Choose a new password for your account'
  if (!token) { heading = 'Reset link invalid'; sub = 'Request a new one from the sign-in page' }
  else if (done) { heading = 'Password updated'; sub = 'Redirecting you to sign in…' }

  return (
    <AuthShell heading={heading} subheading={sub}>
      {!token ? (
        <div className={`${cardCls} text-center`}>
          <p className="text-sm text-[#ffe4f2]/80">This reset link is invalid or missing a token.</p>
          <Link to="/login" className={linkCls}>Back to sign in</Link>
        </div>
      ) : done ? (
        <div className={`${cardCls} text-center`}>
          <div className="w-12 h-12 rounded-full bg-[#ffe4f2]/20 flex items-center justify-center mx-auto">
            <CheckCircle2 className="w-6 h-6 text-[#ffe4f2]" />
          </div>
          <p className="text-xs font-semibold text-[#ffe4f2]/85">Your password has been updated.</p>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className={cardCls}>
          <div>
            <label className={labelCls}>New password</label>
            <div className="relative">
              <input
                className={`${inputCls} pr-10`}
                type={showPw ? 'text' : 'password'}
                value={password}
                onChange={e => setPassword(e.target.value)}
                required
                autoFocus
                placeholder="Min 6 characters"
              />
              <button
                type="button"
                tabIndex={-1}
                onClick={() => setShowPw(v => !v)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-white/55 hover:text-white"
              >
                {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>
          <div>
            <label className={labelCls}>Confirm password</label>
            <input
              className={inputCls}
              type={showPw ? 'text' : 'password'}
              value={confirm}
              onChange={e => setConfirm(e.target.value)}
              required
              placeholder="Repeat password"
            />
          </div>
          {error && <p className={errorCls}>{error}</p>}
          <button type="submit" disabled={loading} className={buttonCls}>
            {loading ? 'Saving…' : 'Update password'}
          </button>
          <p className="text-center">
            <Link to="/login" className={linkCls}>Back to sign in</Link>
          </p>
        </form>
      )}
    </AuthShell>
  )
}
