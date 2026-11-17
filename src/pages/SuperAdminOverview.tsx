/**
 * /super-admin/overview — a read-only, cross-department overview for the
 * super admin, in the Nerve-Light design language (ds.tsx). It only READS
 * existing hooks/endpoints (useAppData, branding/design super-admin stats,
 * the outreach store) and aggregates them client-side — it writes nothing and
 * changes no department's behaviour. The existing /super-admin/dashboard is
 * untouched; this is an additive, at-a-glance companion.
 */
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Users, FileText, Palette, Megaphone, Video, Image as ImageIcon,
  FolderKanban, ClipboardCheck, Send,
} from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'
import { useAppData } from '@/hooks/useAppData'
import { CONTENT_TYPES } from '@/lib/constants'
import { brandingApi } from '@/lib/branding-api'
import { designApi } from '@/lib/design-api'
import type { BrandingPortalStats } from '@/lib/branding-types'
import type { DesignPortalStats } from '@/lib/design-types'
import { useOutreachData } from '@/lib/outreach-data'
import { HeroBanner, StatCard, SectionHeader, Card, DotItem } from '@/pages/branding/ds'

export default function SuperAdminOverview() {
  const { profile } = useAuth()
  const navigate = useNavigate()
  const { users, entries } = useAppData()

  // Branding + Design portal stats — read-only GETs already authorized for the
  // super admin; degrade gracefully to null so the page never hard-fails.
  const [branding, setBranding] = useState<BrandingPortalStats | null>(null)
  const [design, setDesign] = useState<DesignPortalStats | null>(null)
  useEffect(() => {
    let alive = true
    brandingApi.getSuperAdminStats().then(s => { if (alive) setBranding(s) }).catch(() => {})
    designApi.getSuperAdminStats().then(s => { if (alive) setDesign(s) }).catch(() => {})
    return () => { alive = false }
  }, [])

  // Outreach store (same source the existing dashboard uses).
  const { pages, creators, campaigns, loaded: outreachLoaded } = useOutreachData()

  // Headline counts — identical definitions to SuperAdminDashboard's `stats`.
  const counts = useMemo(() => ({
    totalUsers:   users.filter(u => u.role !== 'super_admin').length,
    totalEntries: entries.length,
    contentEntries: entries.filter(e => (CONTENT_TYPES as readonly string[]).includes(e.type)).length,
    branding:     users.filter(u => u.team === 'branding').length,
    content:      users.filter(u => u.team === 'content').length,
    outreach:     users.filter(u => u.team === 'outreach' || u.role.startsWith('outreach_')).length,
    design:       users.filter(u => u.team === 'design').length,
    media:        users.filter(u => u.team === 'media').length,
  }), [users, entries])

  const headline = [
    { title: 'Total users',   value: counts.totalUsers,     icon: Users,      sub: 'excluding super admin' },
    { title: 'Branding team', value: counts.branding,       icon: Palette,    sub: 'members on branding' },
    { title: 'Design team',   value: counts.design,         icon: ImageIcon,  sub: 'members on design' },
    { title: 'Content team',  value: counts.content,        icon: FileText,   sub: 'members on content' },
    { title: 'Outreach team', value: counts.outreach,       icon: Megaphone,  sub: 'members on outreach' },
    { title: 'Media crew',    value: counts.media,          icon: Video,      sub: 'members on media' },
    { title: 'Knowledge entries', value: counts.totalEntries, icon: FileText, sub: `${counts.contentEntries} content` },
  ]

  const num = (v: number | undefined) => (v === undefined ? '—' : v)

  return (
    <div className="nerve-page-in space-y-4">
      <HeroBanner
        eyebrow="Super Admin · Cross-department"
        title={`Everything, in one view${profile?.full_name ? `, ${profile.full_name.split(' ')[0]}` : ''}.`}
        body="Live counts across every department — users, work and output — aggregated from the same sources each team's own dashboard reads."
        primary={{ label: 'Open full dashboard', onClick: () => navigate('/super-admin/dashboard') }}
        secondary={{ label: 'Manage users', onClick: () => navigate('/super-admin/users') }}
      />

      <SectionHeader eyebrow="At a glance" title="People across the platform" />
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {headline.map(s => (
          <StatCard key={s.title} title={s.title} value={s.value} sub={s.sub} icon={s.icon} />
        ))}
      </div>

      <SectionHeader eyebrow="By department" title="Work &amp; output" className="pt-2" />
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">

        {/* Branding */}
        <Card title="Branding" subtitle="Designs, projects and today's reporting" action={<Palette className="w-4 h-4 text-[#6B7280]" strokeWidth={1.75} />}>
          <div className="grid grid-cols-3 gap-3">
            <Mini label="Designs"  value={num(branding?.designs_count)}  icon={ImageIcon} />
            <Mini label="Projects" value={num(branding?.projects_count)} icon={FolderKanban} />
            <Mini label="Filed today" value={branding ? `${branding.today_submitted}/${branding.today_total}` : '—'} icon={ClipboardCheck} />
          </div>
        </Card>

        {/* Design */}
        <Card title="Design" subtitle="Designs, projects and today's reporting" action={<ImageIcon className="w-4 h-4 text-[#6B7280]" strokeWidth={1.75} />}>
          <div className="grid grid-cols-3 gap-3">
            <Mini label="Designs"  value={num(design?.designs_count)}  icon={ImageIcon} />
            <Mini label="Projects" value={num(design?.projects_count)} icon={FolderKanban} />
            <Mini label="Filed today" value={design ? `${design.today_submitted}/${design.today_total}` : '—'} icon={ClipboardCheck} />
          </div>
        </Card>

        {/* Outreach */}
        <Card title="Outreach" subtitle="Influencer network and campaigns" action={<Megaphone className="w-4 h-4 text-[#6B7280]" strokeWidth={1.75} />}>
          <div className="grid grid-cols-3 gap-3">
            <Mini label="Campaigns" value={outreachLoaded ? campaigns.length : '—'} icon={Send} />
            <Mini label="Pages"     value={outreachLoaded ? pages.length : '—'}     icon={FileText} />
            <Mini label="Creators"  value={outreachLoaded ? creators.length : '—'}  icon={Users} />
          </div>
        </Card>

        {/* Content */}
        <Card title="Content" subtitle="Knowledge Hub entries" action={<FileText className="w-4 h-4 text-[#6B7280]" strokeWidth={1.75} />}>
          <div className="grid grid-cols-3 gap-3">
            <Mini label="Entries"  value={counts.totalEntries}   icon={FileText} />
            <Mini label="Content"  value={counts.contentEntries} icon={FileText} />
            <Mini label="Team"     value={counts.content}        icon={Users} />
          </div>
        </Card>
      </div>

      {/* Recent branding designs (read-only, from the already-fetched stats). */}
      {branding?.recent_designs?.length ? (
        <Card title="Recent designs" subtitle="Latest uploads across the branding gallery">
          <ul>
            {branding.recent_designs.slice(0, 5).map((d, i) => (
              <DotItem
                key={d.id}
                title={d.title || 'Untitled'}
                meta={`${d.uploader_name} · ▲ ${d.upvotes} ▼ ${d.downvotes}`}
                trailing={<span className="text-[11px] text-[#9CA3AF] tabular-nums">#{i + 1}</span>}
              />
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  )
}

/** Compact labelled figure used inside the per-department cards. */
function Mini({ label, value, icon: Icon }: { label: string; value: string | number; icon: React.ElementType }) {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1.5 text-[12px] text-[#6B7280]">
        <Icon className="w-3.5 h-3.5 shrink-0" strokeWidth={1.75} />
        <span className="truncate">{label}</span>
      </div>
      <p className="mt-1 text-[22px] font-semibold text-[#111827] tracking-[-0.02em] tabular-nums leading-none">{value}</p>
    </div>
  )
}
