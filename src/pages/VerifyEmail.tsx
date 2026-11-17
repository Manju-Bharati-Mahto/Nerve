/**
 * /verify-email — landing point after a user clicks the email-verification
 * link. Token comes in via ?token=<jwt>. Uses the clean Nerve-Light chrome
 * (same as the /login page).
 */
import { useEffect, useState } from 'react'
import { useSearchParams, Link } from 'react-router-dom'
import { api } from '@/lib/api'
import { CheckCircle2, XCircle, Loader2 } from 'lucide-react'
import { L, cx } from '@/pages/branding/ds2'
import { applySavedPrimary } from '@/pages/branding/theme'
import BrandLogo from '@/components/BrandLogo'
import { ModeToggle } from '@/pages/branding/ThemeModal'

export default function VerifyEmailPage() {
  const [params] = useSearchParams()
  const token = params.get('token') ?? ''
  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading')
  const [msg, setMsg] = useState('')

  // Match the dashboard's chosen primary colour on this page too.
  useEffect(() => { applySavedPrimary() }, [])

  useEffect(() => {
    if (!token) { setStatus('error'); setMsg('Missing verification token.'); return }
    api.verifyEmail(token)
      .then(() => setStatus('success'))
      .catch(e => { setStatus('error'); setMsg(e instanceof Error ? e.message : 'Verification failed.') })
  }, [token])

  const linkCls = 'text-[13px] text-[var(--nerve-primary)] hover:underline'

  let heading = 'Verifying your email'
  let sub: string = 'One moment while we confirm your link…'
  if (status === 'success') { heading = 'Email verified'; sub = 'Your account is now active' }
  else if (status === 'error') { heading = 'Verification failed'; sub = 'The link may be expired or already used' }

  const year = new Date().getFullYear()

  return (
    <div className="nerve-light relative min-h-screen bg-[#F9FAFB] text-[#111827] flex flex-col">
      <div className="absolute top-3 right-3 sm:top-4 sm:right-4">
        <ModeToggle />
      </div>
      <main className="flex-1 flex items-center justify-center px-4 py-10">
        <div className="w-full max-w-[400px] flex flex-col items-center nerve-page-in">
          <BrandLogo variant="parul" className="w-[300px] sm:w-[340px] max-w-full mb-7" />

          <section className={cx(L.card, 'w-full p-6 sm:p-7 text-center')}>
            <h1 className={L.greeting}>{heading}</h1>
            <p className={L.pageSub}>{sub}</p>

            <div className="mt-5 space-y-3">
              {status === 'loading' && (
                <>
                  <Loader2 className="w-8 h-8 text-[var(--nerve-primary)] animate-spin mx-auto" />
                  <p className="text-[13px] font-medium text-[#374151]">Verifying your email…</p>
                </>
              )}
              {status === 'success' && (
                <>
                  <div className="w-12 h-12 rounded-full bg-[var(--nerve-primary-soft)] flex items-center justify-center mx-auto">
                    <CheckCircle2 className="w-6 h-6 text-[var(--nerve-primary)]" />
                  </div>
                  <p className="text-[13px] font-medium text-[#374151]">You can now sign in to your workspace.</p>
                  <Link to="/login" className={cx(L.btn, L.btnPrimary, 'inline-flex')}>Sign in</Link>
                </>
              )}
              {status === 'error' && (
                <>
                  <div className="w-12 h-12 rounded-full bg-[#FEF2F2] flex items-center justify-center mx-auto">
                    <XCircle className="w-6 h-6 text-[#DC2626]" />
                  </div>
                  <p className="text-[13px] font-medium text-[#374151]">{msg || 'The link may be expired or already used.'}</p>
                  <Link to="/login" className={linkCls}>Back to sign in</Link>
                </>
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
