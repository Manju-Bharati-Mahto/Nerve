/**
 * /verify-email — landing point after a user clicks the email-verification
 * link. Token comes in via ?token=<jwt>. Themed to match the landing
 * page's pearl-pink AuthShell.
 */
import { useEffect, useState } from 'react'
import { useSearchParams, Link } from 'react-router-dom'
import { api } from '@/lib/api'
import { CheckCircle2, XCircle, Loader2 } from 'lucide-react'
import AuthShell from '@/components/AuthShell'

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

  const cardCls    = 'rounded-2xl p-6 bg-[#ffe4f2]/[0.16] backdrop-blur-xl border-2 border-[#ffe4f2] ring-2 ring-[#ffe4f2]/35 space-y-4 text-center'
  const buttonCls  = 'inline-block px-5 py-2.5 rounded-lg bg-gradient-to-br from-white via-[#ffe4f2] to-[#f5b8d5] text-[#5a2b3e] text-sm font-bold tracking-wide shadow-[0_8px_30px_rgba(255,228,242,0.65),inset_0_1px_0_rgba(255,255,255,0.85)] hover:from-[#fff7fb] hover:via-white hover:to-[#ffe4f2] active:translate-y-px transition-all'
  const linkCls    = 'text-xs text-[#ffe4f2] hover:text-white font-bold'

  let heading = 'Verifying your email'
  let sub: string | undefined = 'One moment while we confirm your link…'
  if (status === 'success') { heading = 'Email verified'; sub = 'Your account is now active' }
  else if (status === 'error') { heading = 'Verification failed'; sub = 'The link may be expired or already used' }

  return (
    <AuthShell heading={heading} subheading={sub}>
      <div className={cardCls}>
        {status === 'loading' && (
          <>
            <Loader2 className="w-8 h-8 text-[#ffe4f2] animate-spin mx-auto" />
            <p className="text-sm font-semibold text-[#ffe4f2]/85">Verifying your email…</p>
          </>
        )}
        {status === 'success' && (
          <>
            <div className="w-12 h-12 rounded-full bg-[#ffe4f2]/20 flex items-center justify-center mx-auto">
              <CheckCircle2 className="w-6 h-6 text-[#ffe4f2]" />
            </div>
            <p className="text-xs font-semibold text-[#ffe4f2]/85">You can now sign in to your workspace.</p>
            <Link to="/login" className={buttonCls}>Sign in</Link>
          </>
        )}
        {status === 'error' && (
          <>
            <div className="w-12 h-12 rounded-full bg-rose-500/20 flex items-center justify-center mx-auto">
              <XCircle className="w-6 h-6 text-rose-300" />
            </div>
            <p className="text-xs font-semibold text-[#ffe4f2]/80">{msg || 'The link may be expired or already used.'}</p>
            <Link to="/login" className={linkCls}>Back to sign in</Link>
          </>
        )}
      </div>
    </AuthShell>
  )
}
