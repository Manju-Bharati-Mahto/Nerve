/**
 * Standalone /login route — used when a logged-out user clicks a "Sign in"
 * link from anywhere other than the landing page (e.g. a deep link to a
 * protected route that bounced them here). Themed to match the landing
 * page's dark/emerald aesthetic so it doesn't feel like a different app.
 *
 * The actual form (with forgot-password / OTP / resend-verify flow) lives
 * in LoginForm.tsx so both this page and the landing page can render it.
 */
import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth, getRoleDashboard } from '@/hooks/useAuth'
import LoginForm from './LoginForm'

export default function LoginPage() {
  const { user, role } = useAuth()
  const navigate = useNavigate()

  useEffect(() => {
    if (user && role) navigate(getRoleDashboard(role, null))
  }, [user, role, navigate])

  return (
    <div
      className="min-h-screen flex items-center justify-center px-4 text-white"
      style={{
        background:
          'radial-gradient(ellipse at center, #0b1411 0%, #050807 70%, #000 100%)',
      }}
    >
      <div className="w-full max-w-sm animate-fade-in">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl mb-4 bg-emerald-500/15 border border-emerald-400/30 shadow-[0_8px_30px_rgba(16,185,129,0.25)]">
            <span className="font-serif text-2xl text-emerald-300">P</span>
          </div>
          <h1 className="text-2xl font-serif text-white">Parul University</h1>
          <p className="text-sm text-emerald-200/70 mt-1">Knowledge Hub</p>
        </div>

        <LoginForm dark />

        <p className="text-center text-xs text-white/40 mt-6">
          Access is granted by your Super Admin.
        </p>
      </div>
    </div>
  )
}
