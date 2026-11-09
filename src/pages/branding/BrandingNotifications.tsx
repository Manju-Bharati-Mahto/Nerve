/**
 * Notifications for the admin shell: the same panel users and leads get on
 * their dashboard (mark all as read, history behind the clock icon), filled
 * with what an admin acts on. Every item is derived from live data, so it only
 * exists while it is true; read state lives per user in localStorage.
 */
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AlertCircle, CheckCheck, CheckCircle2, History, Info, X } from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'
import { useAppData } from '@/hooks/useAppData'
import { brandingApi } from '@/lib/branding-api'
import { MONTHS } from '@/lib/branding-types'
import type { BrandingLeave, BrandingProject } from '@/lib/branding-types'
import { Badge, cx } from './ds'
import { L, IconTile } from './ds2'

export interface AdminNotification {
  id: string
  title: string
  body: string
  type: 'warning' | 'info' | 'success'
  to: string
}

const dayOf = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })

export function useBrandingNotifications(isFullAdmin: boolean) {
  const { profile } = useAuth()
  const { users } = useAppData()
  const [leaves, setLeaves] = useState<BrandingLeave[]>([])
  const [projects, setProjects] = useState<BrandingProject[]>([])
  const [filedToday, setFiledToday] = useState<Set<string>>(() => new Set())

  useEffect(() => {
    const load = () => {
      brandingApi.getProjects().then(r => setProjects(r.projects)).catch(() => {})
      if (!isFullAdmin) return
      brandingApi.getLeaves('pending').then(r => setLeaves(r.leaves.filter(l => l.status === 'pending'))).catch(() => {})
      const today = dayOf(new Date())
      brandingApi.getAllReports({ dateFrom: today, dateTo: today, lockedOnly: true })
        .then(r => setFiledToday(new Set(r.reports.map(x => x.user_id))))
        .catch(() => {})
    }
    load()
    const id = setInterval(load, 30_000)
    return () => clearInterval(id)
  }, [isFullAdmin])

  const notifications = useMemo(() => {
    const now = new Date()
    const today = dayOf(now)
    const items: AdminNotification[] = []

    // People waiting on a decision come first.
    for (const l of leaves) {
      const dates = [shortDate(l.start_at), shortDate(l.end_at)]
      items.push({
        id: `leave-${l.id}`,
        title: `Leave request: ${l.user_name || 'Team member'}`,
        body: `${dates[0] === dates[1] ? dates[0] : `${dates[0]} – ${dates[1]}`}${l.reason ? ` · ${l.reason}` : ''}`,
        type: 'warning',
        to: '/branding/leaves',
      })
    }

    const overdue = projects.filter(p => p.status !== 'completed' && p.deadline && p.deadline.slice(0, 10) < today)
    if (overdue.length > 0) {
      const names = overdue.slice(0, 2).map(p => p.name).join(', ')
      items.push({
        id: `overdue-${today}`,
        title: `${overdue.length} project${overdue.length === 1 ? '' : 's'} overdue`,
        body: overdue.length > 2 ? `${names} and ${overdue.length - 2} more` : names,
        type: 'warning',
        to: '/branding/team',
      })
    }

    // Finished work waiting for approval on the Kanban board.
    const weekMs = 7 * 86_400_000
    const waiting = projects
      .filter(p => p.board_status === 'review' && p.board_moved_at
        && p.board_moved_by !== profile?.id
        && now.getTime() - new Date(p.board_moved_at).getTime() <= weekMs)
      .sort((a, b) => new Date(b.board_moved_at!).getTime() - new Date(a.board_moved_at!).getTime())
      .slice(0, 5)
    for (const p of waiting) {
      const who = users.find(u => u.id === p.board_moved_by)
      items.push({
        id: `review-${p.id}-${dayOf(new Date(p.board_moved_at!))}`,
        title: `Waiting for approval: ${p.name}`,
        body: who ? `Finished by ${who.full_name}` : 'Moved to the review column',
        type: 'info',
        to: '/branding/team',
      })
    }

    if (isFullAdmin) {
      const team = users.filter(u => u.team === 'branding' && u.role !== 'admin' && u.role !== 'super_admin' && u.role !== 'branding_reports_admin')
      const missing = team.filter(u => !filedToday.has(u.id)).length
      if (missing > 0) {
        items.push({
          id: `unfiled-${today}`,
          title: `${missing} team member${missing === 1 ? '' : 's'} yet to file today`,
          body: 'See who has not submitted a report',
          type: 'info',
          to: '/branding/dashboard',
        })
      }
      if (now.getDate() >= 20) {
        items.push({
          id: `kra-${now.getFullYear()}-${now.getMonth() + 1}`,
          title: 'KRA appraisal window open',
          body: `Publish ${MONTHS[now.getMonth()]} ${now.getFullYear()} scores`,
          type: 'info',
          to: '/branding/kra',
        })
      }
    }

    const rank = { warning: 0, info: 1, success: 2 }
    return items.sort((a, b) => rank[a.type] - rank[b.type])
  }, [leaves, projects, filedToday, users, isFullAdmin, profile?.id])

  // The same key the user dashboard uses, so read state follows the person.
  const readKey = `nerve.notif.read.${profile?.id ?? 'anon'}`
  const [readIds, setReadIds] = useState<Set<string>>(() => new Set())
  useEffect(() => {
    try {
      const raw = localStorage.getItem(readKey)
      setReadIds(new Set(raw ? (JSON.parse(raw) as string[]) : []))
    } catch { setReadIds(new Set()) }
  }, [readKey])

  const markAllRead = () => {
    const next = new Set(readIds)
    for (const n of notifications) next.add(n.id)
    setReadIds(next)
    try { localStorage.setItem(readKey, JSON.stringify([...next])) } catch { /* lasts the session */ }
  }

  const unread = notifications.filter(n => !readIds.has(n.id))
  return { notifications, unread, unreadCount: unread.length, readIds, markAllRead }
}

export type BrandingNotificationState = ReturnType<typeof useBrandingNotifications>

/** Header, list and "Mark all as read". `variant="drawer"` is the slide-out
    panel on desktop; `variant="page"` is the phone page. */
export function NotificationPanel({ state, variant, onClose }: {
  state: BrandingNotificationState
  variant: 'drawer' | 'page'
  onClose?: () => void
}) {
  const { notifications, unread, unreadCount, readIds, markAllRead } = state
  const [showHistory, setShowHistory] = useState(false)
  const navigate = useNavigate()
  const visible = showHistory ? notifications : unread
  const isDrawer = variant === 'drawer'

  const history = (
    <button
      type="button"
      onClick={() => setShowHistory(v => !v)}
      aria-pressed={showHistory}
      className={cx(L.iconGhost, showHistory && 'bg-[#F3F4F6] text-[#111827]')}
      aria-label={showHistory ? 'Back to unread' : 'Show history'}
      title={showHistory ? 'Back to unread' : 'History · everything, including read items'}
    >
      <History className="w-3.5 h-3.5" strokeWidth={1.75} />
    </button>
  )
  const markAll = (extra?: string) => (
    <button
      type="button"
      onClick={markAllRead}
      disabled={unreadCount === 0}
      className={cx(L.btn, L.btnPrimary, L.btnSm, 'disabled:opacity-50 disabled:cursor-default', extra)}
    >
      <CheckCheck className="w-3.5 h-3.5" strokeWidth={1.75} /> Mark all as read
    </button>
  )

  return (
    <>
      <div className={cx('flex items-center justify-between gap-2 px-4 h-12 border-b border-[#C5CAD1] shrink-0', !isDrawer && 'bg-[#F9FAFB]')}>
        <p className="text-[13px] font-semibold text-[#111827] flex items-center gap-2">
          {showHistory ? 'History' : isDrawer ? 'Notifications' : 'Unread'}
          {!showHistory && unreadCount > 0 && <Badge tone="warning">{unreadCount}</Badge>}
        </p>
        <span className="flex items-center gap-1">
          {history}
          {isDrawer
            ? <button type="button" onClick={onClose} className={L.iconGhost} aria-label="Close"><X className="w-3.5 h-3.5" strokeWidth={1.75} /></button>
            : markAll()}
        </span>
      </div>

      <div className={cx('divide-y divide-[#C5CAD1]', isDrawer && 'overflow-y-auto flex-1 min-h-0')}>
        {visible.length === 0 && (
          <p className="px-4 py-10 text-center text-[12px] text-[#6B7280]">
            {showHistory ? 'No notifications yet.' : 'All caught up. Open history to see earlier items.'}
          </p>
        )}
        {visible.map(n => (
          <button
            key={n.id}
            type="button"
            onClick={() => { onClose?.(); navigate(n.to) }}
            className={cx('w-full text-left flex items-start gap-3 px-4 py-3 hover:bg-[#F9FAFB] transition-colors cursor-pointer', readIds.has(n.id) && 'opacity-60')}
          >
            <IconTile
              icon={n.type === 'warning' ? AlertCircle : n.type === 'success' ? CheckCircle2 : Info}
              hue={n.type === 'warning' ? 'amber' : n.type === 'success' ? 'green' : 'blue'}
            />
            <div className="min-w-0">
              <p className="text-[13px] font-semibold text-[#111827]">{n.title}</p>
              <p className="text-[12px] text-[#6B7280] mt-0.5 leading-snug break-words">{n.body}</p>
            </div>
          </button>
        ))}
      </div>

      {isDrawer && (
        <div className="px-4 py-3 border-t border-[#C5CAD1] bg-[#F9FAFB] shrink-0">
          {markAll('w-full')}
        </div>
      )}
    </>
  )
}
