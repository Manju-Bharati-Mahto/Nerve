/**
 * Standalone /login route, in the Nerve Light design system (ds2): one
 * centred white card on the grey canvas, the Parul University logo above
 * it, and the same inputs and primary
 * button the dashboard uses. The landing page still embeds LoginForm in its
 * own dark chrome; this page is what a bounced deep link or a logout lands on.
 *
 * The form (with forgot-password / OTP / resend-verify flow and the Google
 * option) lives in LoginForm.tsx; this page only supplies the chrome.
 */
import { useEffect } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Clock } from 'lucide-react'
import { useAuth, getRoleDashboard } from '@/hooks/useAuth'
import { L, cx } from '@/pages/branding/ds2'
import { applySavedPrimary } from '@/pages/branding/theme'
import BrandLogo from '@/components/BrandLogo'
import LoginForm from './LoginForm'
import { ModeToggle } from '@/pages/branding/ThemeModal'

export default function LoginPage() {
  const { user, role, team } = useAuth()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const expired = params.get('expired') === '1'

  useEffect(() => {
    // Keep our team + Creator-Network routing: passing null here sent an
    // already-signed-in media/creator user to the branding dashboard.
    if (user && role) navigate(getRoleDashboard(role, team, user.creator))
  }, [user, role, team, navigate])

  // The user's chosen primary colour applies here too, so the button on the
  // sign-in page matches the dashboard they are about to see.
  useEffect(() => { applySavedPrimary() }, [])

  const year = new Date().getFullYear()

  return (
    <div className="nerve-light relative min-h-screen bg-[#F9FAFB] text-[#111827] flex flex-col">
      <div className="absolute top-3 right-3 sm:top-4 sm:right-4">
        <ModeToggle />
      </div>
      <main className="flex-1 flex items-center justify-center px-4 py-10">
        <div className="w-full max-w-[400px] flex flex-col items-center nerve-page-in">
          {/* Institution mark above the card (490×61 wordmark). */}
          <BrandLogo variant="parul" className="w-[300px] sm:w-[340px] max-w-full mb-7" />

          <section className={cx(L.card, 'w-full p-6 sm:p-7')}>
            <div className="text-center">
              <h1 className={L.greeting}>Welcome back</h1>
              <p className={L.pageSub}>Sign in to your workspace</p>
            </div>

            {expired && (
              <div role="alert" className="mt-4 flex items-start gap-2 text-[12px] text-[#92400E] bg-[#FFFBEB] border border-[#FDE68A] rounded-[6px] px-3 py-2">
                <Clock className="w-3.5 h-3.5 mt-0.5 shrink-0" strokeWidth={1.75} />
                Your session has expired. Please sign in again.
              </div>
            )}

            <div className="mt-5">
              <LoginForm variant="nerve" />
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
