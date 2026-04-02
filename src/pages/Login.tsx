import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth, getRoleDashboard } from '@/hooks/useAuth'
import { api } from '@/lib/api'
import { getErrorMessage } from '@/lib/error-utils'
import { BookOpen, Eye, EyeOff, ArrowLeft, Mail } from 'lucide-react'

type View = 'login' | 'forgot' | 'forgot-sent' | 'resend-verify'

export default function LoginPage() {
  const [email, setEmail]       = useState('')
  const [password, setPassword] = useState('')
  const [showPw, setShowPw]     = useState(false)
  const [loading, setLoading]   = useState(false)
  const [error, setError]       = useState('')
  const [view, setView]         = useState<View>('login')
  const [forgotEmail, setForgotEmail] = useState('')
  const [forgotLoading, setForgotLoading] = useState(false)
  const [forgotError, setForgotError]     = useState('')

  const { signIn, user, role } = useAuth()
  const navigate = useNavigate()

  useEffect(() => {
    if (user && role) navigate(getRoleDashboard(role, null))
  }, [user, role, navigate])

  // ── Login ──────────────────────────────────────────────────────────────

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true); setError('')
    try {
      await signIn(email, password)
    } catch (err: unknown) {
      const msg = getErrorMessage(err, 'Login failed.')
      if (msg === 'EMAIL_NOT_VERIFIED') {
        setView('resend-verify')
      } else {
        setError(msg)
      }
    }
    setLoading(false)
  }

  // ── Forgot password ────────────────────────────────────────────────────

  async function handleForgot(e: React.FormEvent) {
    e.preventDefault()
    setForgotLoading(true); setForgotError('')
    try {
      await api.forgotPassword(forgotEmail.trim())
      setView('forgot-sent')
    } catch (err: unknown) {
      setForgotError(getErrorMessage(err, 'Failed to send reset email.'))
    }
    setForgotLoading(false)
  }

  // ── Resend verification ────────────────────────────────────────────────

  async function handleResendVerify() {
    setForgotLoading(true); setForgotError('')
    try {
      await api.sendVerification(email.trim())
      setForgotError('') // clear
      setView('forgot-sent') // reuse "check your email" screen
    } catch (err: unknown) {
      setForgotError(getErrorMessage(err, 'Failed to send verification email.'))
    }
    setForgotLoading(false)
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

        {/* ── Login form ── */}
        {view === 'login' && (
          <form onSubmit={handleLogin} className="hub-card space-y-4">
            <div>
              <label className="hub-label">Email</label>
              <input
                className="hub-input"
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                required
                autoFocus
                placeholder="your@parul.ac.in"
              />
            </div>
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="hub-label mb-0">Password</label>
                <button
                  type="button"
                  onClick={() => { setForgotEmail(email); setView('forgot') }}
                  className="text-xs text-primary hover:underline"
                >
                  Forgot password?
                </button>
              </div>
              <div className="relative">
                <input
                  className="hub-input pr-10"
                  type={showPw ? 'text' : 'password'}
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  required
                  placeholder="••••••••"
                />
                <button
                  type="button"
                  onClick={() => setShowPw(v => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                  tabIndex={-1}
                >
                  {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>
            {error && (
              <p className="text-xs text-destructive bg-destructive/10 px-3 py-2 rounded-lg">{error}</p>
            )}
            <button
              type="submit"
              disabled={loading}
              className="w-full py-2.5 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-brand-dark transition-colors disabled:opacity-50"
            >
              {loading ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        )}

        {/* ── Forgot password form ── */}
        {view === 'forgot' && (
          <div className="hub-card space-y-4">
            <div className="flex items-center gap-2 mb-1">
              <button onClick={() => setView('login')} className="text-muted-foreground hover:text-foreground">
                <ArrowLeft className="w-4 h-4" />
              </button>
              <h2 className="text-sm font-semibold text-foreground">Reset password</h2>
            </div>
            <p className="text-xs text-muted-foreground">
              Enter your registered email and we'll send a reset link.
            </p>
            <form onSubmit={handleForgot} className="space-y-3">
              <div>
                <label className="hub-label">Email</label>
                <input
                  className="hub-input"
                  type="email"
                  value={forgotEmail}
                  onChange={e => setForgotEmail(e.target.value)}
                  required
                  autoFocus
                  placeholder="your@parul.ac.in"
                />
              </div>
              {forgotError && (
                <p className="text-xs text-destructive bg-destructive/10 px-3 py-2 rounded-lg">{forgotError}</p>
              )}
              <button
                type="submit"
                disabled={forgotLoading}
                className="w-full py-2.5 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-brand-dark transition-colors disabled:opacity-50"
              >
                {forgotLoading ? 'Sending…' : 'Send reset link'}
              </button>
            </form>
          </div>
        )}

        {/* ── Check your email ── */}
        {(view === 'forgot-sent') && (
          <div className="hub-card text-center space-y-4">
            <div className="w-12 h-12 rounded-full bg-green-100 flex items-center justify-center mx-auto">
              <Mail className="w-6 h-6 text-green-600" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-foreground">Check your email</h2>
              <p className="text-xs text-muted-foreground mt-1">
                If an account exists for that address, we've sent the link. Check your inbox (and spam folder).
              </p>
            </div>
            <button
              onClick={() => { setView('login'); setForgotError('') }}
              className="text-xs text-primary hover:underline"
            >
              Back to sign in
            </button>
          </div>
        )}

        {/* ── Email not verified ── */}
        {view === 'resend-verify' && (
          <div className="hub-card space-y-4">
            <div className="flex items-center gap-2 mb-1">
              <button onClick={() => setView('login')} className="text-muted-foreground hover:text-foreground">
                <ArrowLeft className="w-4 h-4" />
              </button>
              <h2 className="text-sm font-semibold text-foreground">Email not verified</h2>
            </div>
            <p className="text-xs text-muted-foreground">
              Your email address hasn't been verified yet. Click below to resend the verification link to <strong>{email}</strong>.
            </p>
            {forgotError && (
              <p className="text-xs text-destructive bg-destructive/10 px-3 py-2 rounded-lg">{forgotError}</p>
            )}
            <button
              onClick={handleResendVerify}
              disabled={forgotLoading}
              className="w-full py-2.5 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-brand-dark transition-colors disabled:opacity-50"
            >
              {forgotLoading ? 'Sending…' : 'Resend verification email'}
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
