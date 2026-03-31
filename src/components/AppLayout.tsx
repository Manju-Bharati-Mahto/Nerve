import { useEffect } from 'react'
import { useNavigate, Outlet } from 'react-router-dom'
import { useAuth } from '@/hooks/useAuth'
import { useAppData } from '@/hooks/useAppData'
import AppSidebar from './AppSidebar'

export default function AppLayout() {
  const { user, loading } = useAuth()
  const { loading: dataLoading, error } = useAppData()
  const navigate = useNavigate()

  useEffect(() => {
    if (!loading && !user) navigate('/login')
  }, [user, loading, navigate])

  if (loading || dataLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-sm text-muted-foreground animate-pulse">Loading...</div>
      </div>
    )
  }

  if (!user) return null

  return (
    <div className="flex min-h-screen bg-background">
      <AppSidebar />
      <main className="flex-1 overflow-auto">
        <div className="px-6 py-8 w-full">
          {error && (
            <div className="mb-6 rounded-xl border border-destructive/20 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {error}
            </div>
          )}
          <Outlet />
        </div>
      </main>
    </div>
  )
}
