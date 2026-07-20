import type {
  MediaMaster, MediaProject, MediaProjectInput, MediaProjectCategory,
  MediaDeliverable, MediaDeliverableStatus, MediaSocialPost,
  MediaDailyReport, MediaTaskInput, MediaMember,
} from './media-types'

const BASE = (import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/$/, '')
const P = `${BASE}/media`

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${P}${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
    ...init,
  })
  const payload = await res.json().catch(() => ({})) as { message?: string } & Record<string, unknown>
  if (!res.ok) throw new Error(payload.message || 'Request failed.')
  return payload as T
}

export const mediaApi = {
  // Masters
  getMasters: () =>
    req<{ task_categories: MediaMaster[]; deliverable_types: MediaMaster[] }>('/masters'),
  createMaster: (kind: 'task_category' | 'deliverable_type', name: string) =>
    req<{ master: MediaMaster }>(`/masters/${kind}`, { method: 'POST', body: JSON.stringify({ name }) }),
  updateMaster: (kind: 'task_category' | 'deliverable_type', id: string, patch: { name?: string; is_active?: boolean }) =>
    req<{ master: MediaMaster }>(`/masters/${kind}/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),

  // Team roster
  getTeam: () => req<{ members: MediaMember[] }>('/team'),

  // Projects
  getProjects: (category?: MediaProjectCategory) =>
    req<{ projects: MediaProject[] }>(`/projects${category ? `?category=${category}` : ''}`),
  getProject: (id: string) => req<{ project: MediaProject }>(`/projects/${id}`),
  createProject: (input: MediaProjectInput) =>
    req<{ project: MediaProject }>('/projects', { method: 'POST', body: JSON.stringify(input) }),
  updateProject: (id: string, patch: Partial<MediaProjectInput>) =>
    req<{ project: MediaProject }>(`/projects/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteProject: (id: string) => req<{ ok: boolean }>(`/projects/${id}`, { method: 'DELETE' }),

  // Deliverables
  addDeliverable: (projectId: string, typeId: string) =>
    req<{ deliverable: MediaDeliverable }>(`/projects/${projectId}/deliverables`, {
      method: 'POST', body: JSON.stringify({ type_id: typeId }),
    }),
  updateDeliverable: (id: string, patch: {
    status?: MediaDeliverableStatus; drive_link?: string; quantity?: number | null; assigned_user_ids?: string[]
  }) =>
    req<{ deliverable: MediaDeliverable }>(`/deliverables/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteDeliverable: (id: string) => req<{ ok: boolean }>(`/deliverables/${id}`, { method: 'DELETE' }),

  // Social posting
  addSocial: (projectId: string, platform: string) =>
    req<{ social: MediaSocialPost }>(`/projects/${projectId}/social`, {
      method: 'POST', body: JSON.stringify({ platform }),
    }),
  updateSocial: (id: string, patch: { is_posted?: boolean; post_link?: string; platform?: string }) =>
    req<{ social: MediaSocialPost }>(`/social/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteSocial: (id: string) => req<{ ok: boolean }>(`/social/${id}`, { method: 'DELETE' }),

  // Daily reports
  getMyReport: (date: string) =>
    req<{ report: MediaDailyReport | null }>(`/reports/mine?date=${date}`),
  saveMyReport: (input: {
    date: string; summary?: string; blockers?: string; tomorrow_priority?: string; tasks: MediaTaskInput[]
  }) =>
    req<{ report: MediaDailyReport }>('/reports/mine', { method: 'PUT', body: JSON.stringify(input) }),
  submitMyReport: (date: string) =>
    req<{ report: MediaDailyReport }>('/reports/mine/submit', { method: 'POST', body: JSON.stringify({ date }) }),
  getTeamReports: (date: string) =>
    req<{ reports: MediaDailyReport[] }>(`/reports?date=${date}`),
  reviewReport: (id: string, action: 'approve' | 'send_back', comment: string) =>
    req<{ report: MediaDailyReport }>(`/reports/${id}/review`, {
      method: 'POST', body: JSON.stringify({ action, comment }),
    }),
}
