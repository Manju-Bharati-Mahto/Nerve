import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth, getRoleDashboard } from '@/hooks/useAuth'
import { getErrorMessage } from '@/lib/error-utils'
import { BookOpen } from 'lucide-react'

export default function LoginPage() {
  const [email, setEmail]     = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState('')
  const { signIn, user, role } = useAuth()
  const navigate = useNavigate()

  useEffect(() => {
    if (user && role) navigate(getRoleDashboard(role))
    else if (user) navigate('/dashboard')
  }, [user, role, navigate])

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError('')
    try {
      await signIn(email, password)
    } catch (err: unknown) {
      setError(getErrorMessage(err, 'Login failed.'))
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
            <label className="hub-label">Password</label>
            <input
              className="hub-input"
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              required
              placeholder="••••••••"
            />
          </div>
          {error && (
            <p className="text-xs text-destructive bg-destructive/10 px-3 py-2 rounded-lg">{error}</p>
          )}
          <button
            type="submit"
            disabled={loading}
            className="w-full py-2.5 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-brand-dark transition-colors disabled:opacity-50"
          >
            {loading ? 'Signing in...' : 'Sign in'}
          </button>
        </form>

        <p className="text-center text-xs text-muted-foreground mt-6">
          Access is granted by your Super Admin.
        </p>
      </div>
    </div>
  )
}
