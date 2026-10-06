import { Link } from 'react-router-dom'
import { AlertCircle, HardDrive } from 'lucide-react'
import type { DriveErrorCode } from '@/lib/outreach-video-data'
import { useAuth } from '@/hooks/useAuth'

/** The roles the Google Drive page lets in (its RoleGuard in App.tsx). */
const CAN_OPEN_DRIVE_PAGE = ['super_admin', 'admin', 'outreach_manager']

/**
 * A failed load, said plainly — and, when the cause is the outreach Google
 * Drive, a way to the page that fixes it.
 *
 * Every outreach video screen reads from Drive, so a revoked Drive sign-in
 * breaks all of them at once. Without this the Users page said "No users
 * registered yet." over a list it had simply failed to read, which sends
 * people looking for a data problem when the remedy is one reconnect.
 *
 * Only the roles that can open the Drive page get a link to it; an editor or
 * publisher would follow it into an access-denied screen, so they are told
 * who can fix it instead.
 */
export default function DriveProblemNotice({ message, code }: { message: string; code: DriveErrorCode | null }) {
  const { role } = useAuth()
  const canReconnect = !!role && CAN_OPEN_DRIVE_PAGE.includes(role)
  return (
    <div className="hub-card bg-rose-50 border-rose-200 flex items-start gap-2 text-sm text-rose-900">
      <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
      <div className="space-y-2 min-w-0">
        <p>{message}</p>
        {code && canReconnect && (
          <Link to="/outreach/video/drive"
            className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg bg-rose-600 text-white hover:opacity-90">
            <HardDrive className="w-3.5 h-3.5" /> Open Video Workflow → Google Drive
          </Link>
        )}
        {code && !canReconnect && (
          <p className="text-xs">Ask an outreach Admin or Manager to reconnect Google Drive.</p>
        )}
      </div>
    </div>
  )
}
