import { useState } from 'react'
import { useNavigate, useSearchParams, Link } from 'react-router-dom'
import { api } from '@/lib/api'
import { BookOpen, Eye, EyeOff, CheckCircle2 } from 'lucide-react'

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

        {!token ? (
          <div className="hub-card text-center space-y-3">
            <p className="text-sm text-muted-foreground">Invalid or missing reset link.</p>
            <Link to="/login" className="text-xs text-primary hover:underline">Back to sign in</Link>
          </div>
        ) : done ? (
          <div className="hub-card text-center space-y-4">
            <div className="w-12 h-12 rounded-full bg-green-100 flex items-center justify-center mx-auto">
              <CheckCircle2 className="w-6 h-6 text-green-600" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-foreground">Password updated!</h2>
              <p className="text-xs text-muted-foreground mt-1">Redirecting you to sign in…</p>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="hub-card space-y-4">
            <div>
              <h2 className="text-sm font-semibold text-foreground mb-3">Set new password</h2>
            </div>
            <div>
              <label className="hub-label">New password</label>
              <div className="relative">
                <input
                  className="hub-input pr-10"
                  type={showPw ? 'text' : 'password'}
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  required
                  autoFocus
                  placeholder="Min 6 characters"
                />
                <button type="button" onClick={() => setShowPw(v => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  tabIndex={-1}>
                  {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>
            <div>
              <label className="hub-label">Confirm password</label>
              <input
                className="hub-input"
                type={showPw ? 'text' : 'password'}
                value={confirm}
                onChange={e => setConfirm(e.target.value)}
                required
                placeholder="Repeat password"
              />
            </div>
            {error && (
              <p className="text-xs text-destructive bg-destructive/10 px-3 py-2 rounded-lg">{error}</p>
            )}
            <button type="submit" disabled={loading}
              className="w-full py-2.5 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-brand-dark transition-colors disabled:opacity-50">
              {loading ? 'Saving…' : 'Update password'}
            </button>
            <p className="text-center">
              <Link to="/login" className="text-xs text-muted-foreground hover:text-primary">Back to sign in</Link>
            </p>
          </form>
        )}
      </div>
    </div>
  )
}
