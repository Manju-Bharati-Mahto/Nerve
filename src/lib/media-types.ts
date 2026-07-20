/**
 * PU MediaOps (Media Crew department) — client types mirroring server/media-db.ts.
 */

export const MEDIA_PROJECT_CATEGORIES = [
  'academic_cultural',
  'educational_tour',
  'branding_content',
  'monthly',
] as const
export type MediaProjectCategory = (typeof MEDIA_PROJECT_CATEGORIES)[number]

export const MEDIA_CATEGORY_META: Record<MediaProjectCategory, { label: string; short: string; color: string; bg: string }> = {
  academic_cultural: { label: 'Academic & Cultural Events', short: 'Events', color: 'text-emerald-700', bg: 'bg-emerald-100' },
  educational_tour: { label: 'Educational Tours', short: 'Tours', color: 'text-blue-700', bg: 'bg-blue-100' },
  branding_content: { label: 'Branding Content', short: 'Branding', color: 'text-violet-700', bg: 'bg-violet-100' },
  monthly: { label: 'Monthly Productions', short: 'Monthly', color: 'text-orange-700', bg: 'bg-orange-100' },
}

export type MediaProjectStatus = 'upcoming' | 'running' | 'completed' | 'archived'
export type MediaDeliverableStatus = 'pending' | 'in_progress' | 'done'
export type MediaReportStatus = 'draft' | 'submitted' | 'approved' | 'sent_back'

export interface MediaMaster {
  id: string
  name: string
  is_active: boolean
  sort_order: number
}

export interface MediaDeliverable {
  id: string
  project_id: string
  type_id: string
  status: MediaDeliverableStatus
  drive_link: string
  quantity: number | null
  assigned_user_ids: string[]
  completed_at: string | null
}

export interface MediaSocialPost {
  id: string
  project_id: string
  platform: string
  is_posted: boolean
  post_link: string
  posted_by: string | null
  posted_at: string | null
}

export interface MediaProject {
  id: string
  category: MediaProjectCategory
  name: string
  month: string
  faculty_or_department: string
  event_type: string
  organization: string
  city: string
  occasion: string
  shoot_type: string
  creative_concept: string
  hooks: string
  output: string
  date_label: string
  start_date: string | null
  end_date: string | null
  status: MediaProjectStatus
  remarks: string
  academic_year: string
  created_by: string | null
  member_ids: string[]
  deliverables: MediaDeliverable[]
  social_posts: MediaSocialPost[]
  created_at: string
  updated_at: string
}

export interface MediaProjectInput {
  category: MediaProjectCategory
  name: string
  month?: string
  faculty_or_department?: string
  event_type?: string
  organization?: string
  city?: string
  occasion?: string
  shoot_type?: string
  creative_concept?: string
  hooks?: string
  output?: string
  date_label?: string
  start_date?: string | null
  end_date?: string | null
  status?: MediaProjectStatus
  remarks?: string
  member_ids?: string[]
}

export interface MediaReportTask {
  id: string
  report_id: string
  project_id: string | null
  task_category_id: string
  description: string
  start_time: string
  end_time: string
  hours: number
  progress_before: number | null
  progress_after: number | null
  deliverable_type_id: string | null
  quantity: number | null
  evidence_link: string
  sort_order: number
}

export interface MediaTaskInput {
  project_id?: string | null
  task_category_id: string
  description: string
  start_time: string
  end_time: string
  progress_before?: number | null
  progress_after?: number | null
  deliverable_type_id?: string | null
  quantity?: number | null
  evidence_link?: string
}

export interface MediaDailyReport {
  id: string
  user_id: string
  report_date: string
  summary: string
  blockers: string
  tomorrow_priority: string
  status: MediaReportStatus
  submitted_at: string | null
  approved_by: string | null
  approved_at: string | null
  approver_comment: string
  total_hours: number
  tasks: MediaReportTask[]
}

export interface MediaMember {
  id: string
  full_name: string
  email: string
  role: string
  avatar_url: string | null
}

/** Seed options for the Branding Content shoot-type dropdown (Appendix B). */
export const MEDIA_SHOOT_TYPES = [
  'Brand Film', 'Reel', 'TVC', 'Cinematic', 'Drone', 'Campaign', 'Feature', 'Film', 'Recap', 'Tribute',
]

/** Seed options for the Academic & Cultural event-type dropdown (Appendix B). */
export const MEDIA_EVENT_TYPES = [
  'Academic Event', 'Cultural', 'Cultural / Festival', 'Cultural / Fine Arts', 'National Day',
  'CIRR / International', 'University Event',
]

export const MEDIA_ORGANIZATIONS = ['Gyansthan', 'IIMUN', 'In-house', 'Other']
