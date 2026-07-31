/**
 * Standalone /login route — used when a logged-out user clicks a "Sign in"
 * link from anywhere other than the landing page (e.g. a deep link to a
 * protected route that bounced them here). Wears the same dark pearl-pink
 * AuthShell aesthetic as the landing page's final scroll state, so both
 * entry points feel like the same app.
 *
 * The actual form (with forgot-password / OTP / resend-verify flow) lives
 * in LoginForm.tsx so both this page and the landing page can render it.
 */
import { useEffect } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useAuth, getRoleDashboard } from '@/hooks/useAuth'
import AuthShell from '@/components/AuthShell'
import LoginForm from './LoginForm'

export default function LoginPage() {
  const { user, role } = useAuth()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const expired = params.get('expired') === '1'

  useEffect(() => {
    if (user && role) navigate(getRoleDashboard(role, null))
  }, [user, role, navigate])

  return (
    <AuthShell>
      {expired && (
        <div
          role="alert"
          style={{
            marginBottom: 16, padding: '10px 14px', borderRadius: 10,
            background: 'rgba(245,158,11,.14)', border: '1px solid rgba(245,158,11,.4)',
            color: '#fbbf24', fontSize: 14, textAlign: 'center',
          }}
        >
          Your session has expired. Please log in again.
        </div>
      )}
      <LoginForm dark />
    </AuthShell>
  )
}
