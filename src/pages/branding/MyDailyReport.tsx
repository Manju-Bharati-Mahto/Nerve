import { useAuth } from '@/hooks/useAuth'
import { useAppData } from '@/hooks/useAppData'
import { DailyReportsPage } from './BrandingUserDashboard'

/**
 * The member-style "file your own daily report" page, hosted inside the admin
 * shell so a manager, lead or anyone granted the `branding:file_daily_report`
 * capability can do their own daily reporting (timer rows, submit) even though
 * their main dashboard is the admin/manager one.
 */
export default function MyDailyReport() {
  const { profile } = useAuth()
  const { users } = useAppData()
  return <DailyReportsPage profile={profile} users={users} />
}
