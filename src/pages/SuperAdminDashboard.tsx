import { useEffect, useMemo, useState } from 'react'
import { useAuth } from '@/hooks/useAuth'
import { useAppData } from '@/hooks/useAppData'
import type { AppUser, Entry } from '@/lib/app-types'
import {
  Crown, Users, FileText, Palette, Settings, Database, Search,
  Shield, UserCheck, User, Image, FolderKanban, ClipboardCheck,
  ThumbsUp, ThumbsDown, Clock,
} from 'lucide-react'
import { Link, useSearchParams } from 'react-router-dom'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { CONTENT_TYPES } from '@/lib/constants'
import { brandingApi } from '@/lib/branding-api'
import type { BrandingPortalStats } from '@/lib/branding-types'

const DASHBOARD_TABS = ['overview', 'branding', 'content'] as const

type DashboardTab = (typeof DASHBOARD_TABS)[number]

function isDashboardTab(value: string | null): value is DashboardTab {
  return value !== null && DASHBOARD_TABS.includes(value as DashboardTab)
}

function getDashboardTab(value: string | null): DashboardTab {
  return isDashboardTab(value) ? value : 'overview'
}

// ── Content team section (unchanged) ──────────────────────────────────────

const CONTENT_STYLE = {
  bg50: 'bg-blue-50', bg100: 'bg-blue-100',
  text600: 'text-blue-600', text700: 'text-blue-700',
  bar: 'bg-blue-500', badge: 'bg-blue-100 text-blue-700',
}

function ContentTeamContent({ allUsers, allEntries }: { allUsers: AppUser[]; allEntries: Entry[] }) {
  const s = CONTENT_STYLE
  const teamUsers    = allUsers.filter(u => u.team === 'content')
  const admins       = teamUsers.filter(u => u.role === 'admin')
  const subAdmins    = teamUsers.filter(u => u.role === 'sub_admin')
  const members      = teamUsers.filter(u => u.role === 'user')
  const teamEntries  = allEntries.filter(e => (CONTENT_TYPES as readonly string[]).includes(e.type))

  const statCards = [
    { label: 'Admins',     value: admins.length,      icon: Shield,    bg: s.bg50,         color: s.text600 },
    { label: 'Team Leads', value: subAdmins.length,   icon: UserCheck, bg: 'bg-teal-50',   color: 'text-teal-600' },
    { label: 'Members',    value: members.length,     icon: User,      bg: 'bg-green-50',  color: 'text-green-600' },
    { label: 'Entries',    value: teamEntries.length, icon: FileText,  bg: s.bg50,         color: s.text600 },
  ]
  const groups = [
    { label: 'Admins',     items: admins,    badge: s.badge },
    { label: 'Team Leads', items: subAdmins, badge: 'bg-teal-100 text-teal-700' },
    { label: 'Members',    items: members,   badge: 'bg-green-100 text-green-700' },
  ]

  return (
    <div className="space-y-5 pt-4">
      <div className="grid grid-cols-4 gap-3">
        {statCards.map(card => {
          const Icon = card.icon
          return (
            <div key={card.label} className="hub-card flex items-center gap-3 py-3">
              <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${card.bg} shrink-0`}>
                <Icon className={`w-4 h-4 ${card.color}`} />
              </div>
              <div>
                <div className="text-2xl font-serif text-foreground leading-none">{card.value}</div>
                <div className="text-xs text-muted-foreground mt-0.5">{card.label}</div>
              </div>
            </div>
          )
        })}
      </div>

      <div className="grid grid-cols-5 gap-5">
        <div className="col-span-3 hub-card">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-foreground">Content Team Members</h2>
            <Link to="/content/team" className="text-xs text-primary hover:underline">View all</Link>
          </div>
          {groups.map(group => group.items.length > 0 && (
            <div key={group.label} className="mb-4 last:mb-0">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-2">{group.label}</p>
              {group.items.map(u => (
                <div key={u.id} className="flex items-center justify-between py-2 border-b border-border last:border-0">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div className={`w-7 h-7 rounded-full ${s.bg100} flex items-center justify-center shrink-0`}>
                      <span className={`text-xs font-semibold ${s.text700}`}>{(u.full_name || u.email)[0].toUpperCase()}</span>
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-foreground truncate">{u.full_name || 'Unnamed'}</p>
                      <p className="text-xs text-muted-foreground truncate">{u.email}</p>
                    </div>
                  </div>
                  <span className={`hub-badge shrink-0 ${group.badge}`}>{group.label.split(' ')[0]}</span>
                </div>
              ))}
            </div>
          ))}
          {teamUsers.length === 0 && <p className="text-sm text-muted-foreground text-center py-6">No members assigned yet.</p>}
        </div>

        <div className="col-span-2 hub-card">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-foreground">Recent entries</h2>
            <Link to="/browse" className="text-xs text-primary hover:underline">Browse all</Link>
          </div>
          {teamEntries.length === 0 && <p className="text-sm text-muted-foreground text-center py-6">No entries yet.</p>}
          {teamEntries.slice(0, 6).map(e => (
            <div key={e.id} className="py-2.5 border-b border-border last:border-0">
              <p className="text-sm font-medium text-foreground truncate leading-tight">{e.title}</p>
              <div className="flex gap-1.5 mt-1 flex-wrap">
                <span className={`hub-badge ${s.bg50} ${s.text700}`}>{e.type}</span>
                <span className="hub-badge bg-primary/5 text-primary/70">{e.dept}</span>
              </div>
              <p className="text-[11px] text-muted-foreground mt-0.5">{e.entry_date}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ── Branding team section (portal-aware) ───────────────────────────────────

function BrandingTeamContent({ allUsers }: { allUsers: AppUser[] }) {
  const [stats, setStats] = useState<BrandingPortalStats | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    brandingApi.getSuperAdminStats()
      .then(s => setStats(s))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  const teamUsers = allUsers.filter(u => u.team === 'branding')
  const admins    = teamUsers.filter(u => u.role === 'admin')
  const subAdmins = teamUsers.filter(u => u.role === 'sub_admin')
  const members   = teamUsers.filter(u => u.role === 'user')

  const reportPct = stats && stats.today_total > 0
    ? Math.round((stats.today_submitted / stats.today_total) * 100) : 0

  const statCards = [
    { label: 'Admins',     value: admins.length,               icon: Shield,         bg: 'bg-pink-50',   color: 'text-pink-600' },
    { label: 'Team Leads', value: subAdmins.length,            icon: UserCheck,      bg: 'bg-teal-50',   color: 'text-teal-600' },
    { label: 'Members',    value: members.length,              icon: User,           bg: 'bg-green-50',  color: 'text-green-600' },
    { label: 'Designs',    value: stats?.designs_count ?? '—', icon: Image,          bg: 'bg-pink-50',   color: 'text-pink-600' },
    { label: 'Projects',   value: stats?.projects_count ?? '—',icon: FolderKanban,   bg: 'bg-purple-50', color: 'text-purple-600' },
    {
      label: "Today's Reports",
      value: stats ? `${stats.today_submitted}/${stats.today_total}` : '—',
      icon: ClipboardCheck,
      bg: reportPct === 100 ? 'bg-green-50' : 'bg-amber-50',
      color: reportPct === 100 ? 'text-green-600' : 'text-amber-600',
    },
  ]

  const groups = [
    { label: 'Admins',     items: admins,    badge: 'bg-pink-100 text-pink-700' },
    { label: 'Team Leads', items: subAdmins, badge: 'bg-teal-100 text-teal-700' },
    { label: 'Members',    items: members,   badge: 'bg-green-100 text-green-700' },
  ]

  return (
    <div className="space-y-5 pt-4">
      {/* Stat cards — 6 across */}
      <div className="grid grid-cols-3 md:grid-cols-6 gap-3">
        {statCards.map(card => {
          const Icon = card.icon
          return (
            <div key={card.label} className="hub-card flex items-center gap-2.5 py-3">
              <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${card.bg} shrink-0`}>
                <Icon className={`w-4 h-4 ${card.color}`} />
              </div>
              <div>
                <div className={`text-xl font-serif leading-none ${loading && !stats ? 'text-muted-foreground' : 'text-foreground'}`}>
                  {card.value}
                </div>
                <div className="text-[10px] text-muted-foreground mt-0.5 leading-tight">{card.label}</div>
              </div>
            </div>
          )
        })}
      </div>

      <div className="grid grid-cols-5 gap-5">
        {/* Members list */}
        <div className="col-span-3 hub-card">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-foreground">Branding Team Members</h2>
            <Link to="/branding/team" className="text-xs text-primary hover:underline">Manage</Link>
          </div>
          {groups.map(group => group.items.length > 0 && (
            <div key={group.label} className="mb-4 last:mb-0">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-2">{group.label}</p>
              {group.items.map(u => (
                <div key={u.id} className="flex items-center justify-between py-2 border-b border-border last:border-0">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div className="w-7 h-7 rounded-full bg-pink-100 flex items-center justify-center shrink-0">
                      <span className="text-xs font-semibold text-pink-700">{(u.full_name || u.email)[0].toUpperCase()}</span>
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-foreground truncate">{u.full_name || 'Unnamed'}</p>
                      <p className="text-xs text-muted-foreground truncate">{u.email}</p>
                    </div>
                  </div>
                  <span className={`hub-badge shrink-0 ${group.badge}`}>{group.label.split(' ')[0]}</span>
                </div>
              ))}
            </div>
          ))}
          {teamUsers.length === 0 && <p className="text-sm text-muted-foreground text-center py-6">No members assigned yet.</p>}
        </div>

        {/* Right column */}
        <div className="col-span-2 space-y-4">
          {/* Today's report status */}
          <div className="hub-card">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-foreground">Daily Reports — Today</h2>
              <Link to="/branding/team" className="text-xs text-primary hover:underline">Details</Link>
            </div>
            {loading ? (
              <div className="h-2 rounded-full bg-muted animate-pulse" />
            ) : stats ? (
              <>
                <div className="flex items-center justify-between text-xs mb-1.5">
                  <span className="text-muted-foreground">{stats.today_submitted} of {stats.today_total} submitted</span>
                  <span className={`font-semibold ${reportPct === 100 ? 'text-green-600' : 'text-amber-600'}`}>{reportPct}%</span>
                </div>
                <div className="h-2 rounded-full bg-muted overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-500 ${reportPct === 100 ? 'bg-green-500' : 'bg-amber-500'}`}
                    style={{ width: `${reportPct}%` }}
                  />
                </div>
              </>
            ) : (
              <p className="text-xs text-muted-foreground">Could not load.</p>
            )}
          </div>

          {/* Recent designs */}
          <div className="hub-card">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-foreground">Recent Designs</h2>
              <Link to="/branding/browse" className="text-xs text-primary hover:underline">Gallery</Link>
            </div>
            {loading ? (
              <div className="space-y-2">
                {[1,2,3].map(i => <div key={i} className="h-10 rounded-lg bg-muted animate-pulse" />)}
              </div>
            ) : !stats || stats.recent_designs.length === 0 ? (
              <p className="text-xs text-muted-foreground text-center py-3">No designs uploaded yet.</p>
            ) : (
              <div className="space-y-2">
                {stats.recent_designs.map(d => (
                  <div key={d.id} className="flex items-center gap-2.5">
                    <img
                      src={d.image_url}
                      alt={d.title}
                      className="w-10 h-10 rounded-lg object-cover shrink-0 bg-muted"
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium text-foreground truncate">{d.title}</p>
                      <p className="text-[10px] text-muted-foreground truncate">{d.uploader_name}</p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0 text-[10px] text-muted-foreground">
                      <span className="flex items-center gap-0.5 text-green-600">
                        <ThumbsUp className="w-3 h-3" />{d.upvotes}
                      </span>
                      <span className="flex items-center gap-0.5 text-red-500">
                        <ThumbsDown className="w-3 h-3" />{d.downvotes}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Quick links */}
          <div className="hub-card">
            <h2 className="text-sm font-semibold text-foreground mb-2">Quick links</h2>
            {[
              { to: '/branding/dashboard', icon: Palette,       label: 'Admin Dashboard' },
              { to: '/branding/browse',    icon: Image,         label: 'Design Gallery' },
              { to: '/branding/team',      icon: Users,         label: 'Team & Projects' },
            ].map(({ to, icon: Icon, label }) => (
              <Link key={to} to={to}
                className="flex items-center gap-2.5 px-2 py-2 rounded-lg hover:bg-accent transition-colors text-sm text-foreground">
                <Icon className="w-4 h-4 text-pink-500 shrink-0" />{label}
              </Link>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Main Dashboard ─────────────────────────────────────────────────────────

export default function SuperAdminDashboard() {
  const { profile } = useAuth()
  const { users, entries } = useAppData()
  const [searchParams, setSearchParams] = useSearchParams()
  const rawTabs = searchParams.getAll('tab')
  const hasTabParam = rawTabs.length > 0
  const activeTab = getDashboardTab(rawTabs[0] ?? null)
  const shouldNormalizeTabParams =
    hasTabParam && (rawTabs.length !== 1 || rawTabs[0] !== activeTab)

  const stats = useMemo(() => ({
    totalUsers:   users.filter(u => u.role !== 'super_admin').length,
    totalEntries: entries.length,
    branding:     users.filter(u => u.team === 'branding').length,
    content:      users.filter(u => u.team === 'content').length,
  }), [users, entries])

  const contentEntries = useMemo(() =>
    entries.filter(e => (CONTENT_TYPES as readonly string[]).includes(e.type)), [entries])

  useEffect(() => {
    if (!shouldNormalizeTabParams) return

    const nextParams = new URLSearchParams(searchParams)
    nextParams.delete('tab')
    nextParams.set('tab', activeTab)
    setSearchParams(nextParams, { replace: true })
  }, [activeTab, searchParams, setSearchParams, shouldNormalizeTabParams])

  function handleTabChange(nextTab: string) {
    if (!isDashboardTab(nextTab) || nextTab === activeTab) return

    const nextParams = new URLSearchParams(searchParams)
    nextParams.set('tab', nextTab)
    setSearchParams(nextParams)
  }

  return (
    <div className="animate-fade-in space-y-5">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-purple-100 flex items-center justify-center shrink-0">
          <Crown className="w-5 h-5 text-purple-600" />
        </div>
        <div>
          <h1 className="text-2xl font-serif text-foreground">Super Admin Dashboard</h1>
          <p className="text-sm text-muted-foreground">
            Welcome{profile?.full_name ? `, ${profile.full_name}` : ''}. You hold full system control.
          </p>
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={handleTabChange} className="w-full">
        <TabsList className="w-full justify-start gap-1">
          <TabsTrigger value="overview" className="flex items-center gap-1.5">
            <Crown className="w-3.5 h-3.5" /> Overview
          </TabsTrigger>
          <TabsTrigger value="branding" className="flex items-center gap-1.5">
            <Palette className="w-3.5 h-3.5" /> Branding Team
          </TabsTrigger>
          <TabsTrigger value="content" className="flex items-center gap-1.5">
            <FileText className="w-3.5 h-3.5" /> Content Team
          </TabsTrigger>
        </TabsList>

        {/* ── Overview ── */}
        <TabsContent value="overview" className="space-y-5 pt-4">
          <div className="grid grid-cols-4 gap-3">
            {[
              { label: 'Total users',   value: stats.totalUsers,   icon: Users,    bg: 'bg-purple-50', color: 'text-purple-600' },
              { label: 'Total entries', value: stats.totalEntries, icon: FileText, bg: 'bg-green-50',  color: 'text-green-600' },
              { label: 'Branding team', value: stats.branding,     icon: Palette,  bg: 'bg-pink-50',   color: 'text-pink-600' },
              { label: 'Content team',  value: stats.content,      icon: FileText, bg: 'bg-blue-50',   color: 'text-blue-600' },
            ].map(s => {
              const Icon = s.icon
              return (
                <div key={s.label} className="hub-card flex items-center gap-3 py-3">
                  <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${s.bg} shrink-0`}>
                    <Icon className={`w-4 h-4 ${s.color}`} />
                  </div>
                  <div>
                    <div className="text-2xl font-serif text-foreground leading-none">{s.value}</div>
                    <div className="text-xs text-muted-foreground mt-0.5">{s.label}</div>
                  </div>
                </div>
              )
            })}
          </div>

          <div className="grid grid-cols-2 gap-5">
            <div className="hub-card">
              <h2 className="text-sm font-semibold text-foreground mb-4">Team overview</h2>
              <div className="space-y-5">
                {[
                  { team: 'branding', label: 'Branding Team', bar: 'bg-pink-500', count: stats.branding, link: '/branding/team' },
                  { team: 'content',  label: 'Content Team',  bar: 'bg-blue-500', count: stats.content,  link: '/content/team' },
                ].map(t => (
                  <div key={t.team} className="space-y-1.5">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-medium text-foreground">{t.label}</span>
                      <div className="flex items-center gap-3">
                        <span className="text-muted-foreground">{t.count} members</span>
                        <Link to={t.link} className="text-primary hover:underline">View team</Link>
                      </div>
                    </div>
                    <div className="h-2 rounded-full bg-muted overflow-hidden">
                      <div className={`h-full rounded-full ${t.bar} transition-all duration-500`}
                        style={{ width: stats.totalUsers > 0 ? `${(t.count / stats.totalUsers) * 100}%` : '0%' }} />
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="hub-card">
              <h2 className="text-sm font-semibold text-foreground mb-3">Quick actions</h2>
              {[
                { to: '/super-admin/users',    icon: Users,    label: 'Manage all users',   desc: 'Assign roles & teams' },
                { to: '/super-admin/settings', icon: Settings, label: 'System settings',    desc: 'Configure the platform' },
                { to: '/browse',               icon: Search,   label: 'Browse all entries', desc: 'Full knowledge base' },
                { to: '/admin/export',         icon: Database, label: 'Export data',         desc: 'Download CSV/JSON' },
              ].map(({ to, icon: Icon, label, desc }) => (
                <Link key={to} to={to}
                  className="flex items-center gap-3 p-3 rounded-lg hover:bg-accent transition-colors group">
                  <div className="w-8 h-8 rounded-lg bg-muted flex items-center justify-center shrink-0 group-hover:bg-purple-50 transition-colors">
                    <Icon className="w-4 h-4 text-muted-foreground group-hover:text-purple-600 transition-colors" />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-foreground">{label}</p>
                    <p className="text-xs text-muted-foreground">{desc}</p>
                  </div>
                </Link>
              ))}
            </div>
          </div>

          <div className="hub-card">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-semibold text-foreground">Recent entries (all teams)</h2>
              <Link to="/browse" className="text-xs text-primary hover:underline">Browse all</Link>
            </div>
            <div className="grid grid-cols-2 gap-x-8">
              {entries.slice(0, 8).map(e => (
                <div key={e.id} className="flex items-start justify-between gap-4 py-3 border-b border-border last:border-0">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-foreground truncate">{e.title}</p>
                    <div className="flex gap-1.5 mt-1 flex-wrap">
                      <span className="hub-badge bg-primary/10 text-primary">{e.dept}</span>
                      <span className="hub-badge bg-primary/5 text-primary/70">{e.type}</span>
                    </div>
                  </div>
                  <span className="text-xs text-muted-foreground shrink-0 pt-0.5">{e.entry_date}</span>
                </div>
              ))}
            </div>
          </div>
        </TabsContent>

        {/* ── Branding Team ── */}
        <TabsContent value="branding">
          <BrandingTeamContent allUsers={users} />
        </TabsContent>

        {/* ── Content Team ── */}
        <TabsContent value="content">
          <ContentTeamContent allUsers={users} allEntries={entries} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
