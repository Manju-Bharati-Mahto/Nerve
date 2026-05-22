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
import { useNavigate } from 'react-router-dom'
import { useAuth, getRoleDashboard } from '@/hooks/useAuth'
import AuthShell from '@/components/AuthShell'
import LoginForm from './LoginForm'

export default function LoginPage() {
  const { user, role } = useAuth()
  const navigate = useNavigate()

  useEffect(() => {
    if (user && role) navigate(getRoleDashboard(role, null))
  }, [user, role, navigate])

  return (
    <AuthShell>
      <LoginForm dark />
    </AuthShell>
  )
}
