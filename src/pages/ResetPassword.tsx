/**
 * /reset-password — landing point after a user clicks the password-reset
 * link from their email. Token comes in via ?token=<jwt>. Uses the clean
 * Nerve-Light chrome (same as the /login page): one centred white card on
 * the grey canvas with the Parul University wordmark above it.
 */
import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams, Link } from 'react-router-dom'
import { api } from '@/lib/api'
import { Eye, EyeOff, CheckCircle2 } from 'lucide-react'
import { L, cx } from '@/pages/branding/ds2'
import { applySavedPrimary } from '@/pages/branding/theme'
import BrandLogo from '@/components/BrandLogo'
import { ModeToggle } from '@/pages/branding/ThemeModal'

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

  // Match the dashboard's chosen primary colour on this page too.
  useEffect(() => { applySavedPrimary() }, [])

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

  const errorCls = 'text-[12px] text-[#DC2626] bg-[#FEF2F2] border border-[#FEE2E2] rounded-[6px] px-3 py-2'
  const linkCls  = 'text-[13px] text-[var(--nerve-primary)] hover:underline'

  let heading = 'Set new password'
  let sub: string = 'Choose a new password for your account'
  if (!token) { heading = 'Reset link invalid'; sub = 'Request a new one from the sign-in page' }
  else if (done) { heading = 'Password updated'; sub = 'Redirecting you to sign in…' }

  const year = new Date().getFullYear()

  return (
    <div className="nerve-light relative min-h-screen bg-[#F9FAFB] text-[#111827] flex flex-col">
      <div className="absolute top-3 right-3 sm:top-4 sm:right-4">
        <ModeToggle />
      </div>
      <main className="flex-1 flex items-center justify-center px-4 py-10">
        <div className="w-full max-w-[400px] flex flex-col items-center nerve-page-in">
          <BrandLogo variant="parul" className="w-[300px] sm:w-[340px] max-w-full mb-7" />

          <section className={cx(L.card, 'w-full p-6 sm:p-7')}>
            <div className="text-center">
              <h1 className={L.greeting}>{heading}</h1>
              <p className={L.pageSub}>{sub}</p>
            </div>

            <div className="mt-5">
              {!token ? (
                <div className="text-center space-y-4">
                  <p className="text-[13px] text-[#6B7280]">This reset link is invalid or missing a token.</p>
                  <Link to="/login" className={linkCls}>Back to sign in</Link>
                </div>
              ) : done ? (
                <div className="text-center space-y-3">
                  <div className="w-12 h-12 rounded-full bg-[var(--nerve-primary-soft)] flex items-center justify-center mx-auto">
                    <CheckCircle2 className="w-6 h-6 text-[var(--nerve-primary)]" />
                  </div>
                  <p className="text-[13px] font-medium text-[#374151]">Your password has been updated.</p>
                </div>
              ) : (
                <form onSubmit={handleSubmit} className="space-y-4">
                  <div>
                    <label className={L.label}>New password</label>
                    <div className="relative">
                      <input
                        className={cx(L.input, 'pr-10')}
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
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-[#9CA3AF] hover:text-[#374151]"
                      >
                        {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                    </div>
                  </div>
                  <div>
                    <label className={L.label}>Confirm password</label>
                    <input
                      className={L.input}
                      type={showPw ? 'text' : 'password'}
                      value={confirm}
                      onChange={e => setConfirm(e.target.value)}
                      required
                      placeholder="Repeat password"
                    />
                  </div>
                  {error && <p className={errorCls}>{error}</p>}
                  <button type="submit" disabled={loading} className={cx(L.btn, L.btnPrimary, 'w-full')}>
                    {loading ? 'Saving…' : 'Update password'}
                  </button>
                  <p className="text-center">
                    <Link to="/login" className={linkCls}>Back to sign in</Link>
                  </p>
                </form>
              )}
            </div>
          </section>
        </div>
      </main>

      <footer className="h-10 shrink-0 flex items-center justify-center px-4 text-[11px] text-[#9CA3AF]">
        © {year} Parul University · Access is granted by your Super Admin.
      </footer>
    </div>
  )
}
