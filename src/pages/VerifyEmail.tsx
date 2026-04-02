import { useEffect, useState } from 'react'
import { useSearchParams, Link } from 'react-router-dom'
import { api } from '@/lib/api'
import { BookOpen, CheckCircle2, XCircle, Loader2 } from 'lucide-react'

export default function VerifyEmailPage() {
  const [params] = useSearchParams()
  const token = params.get('token') ?? ''
  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading')
  const [msg, setMsg] = useState('')

  useEffect(() => {
    if (!token) { setStatus('error'); setMsg('Missing verification token.'); return }
    api.verifyEmail(token)
      .then(() => setStatus('success'))
      .catch(e => { setStatus('error'); setMsg(e instanceof Error ? e.message : 'Verification failed.') })
  }, [token])

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

        <div className="hub-card text-center space-y-4">
          {status === 'loading' && (
            <>
              <Loader2 className="w-8 h-8 text-primary animate-spin mx-auto" />
              <p className="text-sm text-muted-foreground">Verifying your email…</p>
            </>
          )}
          {status === 'success' && (
            <>
              <div className="w-12 h-12 rounded-full bg-green-100 flex items-center justify-center mx-auto">
                <CheckCircle2 className="w-6 h-6 text-green-600" />
              </div>
              <div>
                <h2 className="text-sm font-semibold text-foreground">Email verified!</h2>
                <p className="text-xs text-muted-foreground mt-1">Your account is now active. You can sign in.</p>
              </div>
              <Link to="/login" className="inline-block px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-brand-dark transition-colors">
                Sign in
              </Link>
            </>
          )}
          {status === 'error' && (
            <>
              <div className="w-12 h-12 rounded-full bg-red-100 flex items-center justify-center mx-auto">
                <XCircle className="w-6 h-6 text-red-600" />
              </div>
              <div>
                <h2 className="text-sm font-semibold text-foreground">Verification failed</h2>
                <p className="text-xs text-muted-foreground mt-1">{msg || 'The link may be expired or already used.'}</p>
              </div>
              <Link to="/login" className="text-xs text-primary hover:underline">Back to sign in</Link>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
