import { createContext, useContext, useEffect, useState, ReactNode } from 'react'
import { api } from '@/lib/api'
import type { AppRole, AppTeam } from '@/lib/constants'
import type { AppUser } from '@/lib/app-types'

// ── Types ──────────────────────────────────────────────────────────────────

export interface Profile {
  id: string
  full_name: string
  department: string
  email: string
}

interface AuthContextType {
  user: Profile | null
  profile: Profile | null
  role: AppRole | null
  team: AppTeam | null
  loading: boolean
  signIn: (email: string, password: string) => Promise<void>
  signUp: (email: string, password: string, fullName: string) => Promise<void>
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthContextType>({} as AuthContextType)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser]       = useState<Profile | null>(null)
  const [role, setRole]       = useState<AppRole | null>(null)
  const [team, setTeam]       = useState<AppTeam | null>(null)
  const [loading, setLoading] = useState(true)

  function applyRecord(record: AppUser | null) {
    if (!record) return
    setUser({ id: record.id, full_name: record.full_name, email: record.email, department: record.department })
    setRole(record.role)
    setTeam(record.team)
  }

  useEffect(() => {
    let active = true

    async function restoreSession() {
      try {
        const { user: me } = await api.getMe()
        if (!active) return
        if (me) applyRecord(me)
      } finally {
        if (active) setLoading(false)
      }
    }

    void restoreSession()
    return () => {
      active = false
    }
  }, [])

  async function signIn(email: string, password: string) {
    const { user: me } = await api.login(email, password)
    applyRecord(me)
  }

  async function signUp(_e: string, _p: string, _n: string) {
    throw new Error('Registration is by invitation only.')
  }

  async function signOut() {
    await api.logout()
    setUser(null); setRole(null); setTeam(null)
  }

  return (
    <AuthContext.Provider value={{ user, profile: user, role, team, loading, signIn, signUp, signOut }}>
      {children}
    </AuthContext.Provider>
  )
}

export const useAuth = () => useContext(AuthContext)

/** Home route based on role + team */
export function getRoleDashboard(role: AppRole | null, team: AppTeam | null): string {
  if (role === 'super_admin') return '/super-admin/dashboard'
  if (role === 'admin')       return team === 'content' ? '/content/dashboard'   : '/branding/dashboard'
  if (role === 'sub_admin')   return team === 'content' ? '/content/sub-admin'   : '/branding/sub-admin'
  if (role === 'user')        return team === 'content' ? '/content/user'        : '/branding/user'
  return '/login'
}
