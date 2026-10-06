/**
 * Client for the BrandOps API.
 *
 * Mirrors the server's row shapes rather than re-modelling them, so a column
 * rename shows up as a type error here instead of an empty cell in the UI.
 */
const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/$/, '')
const BASE = `${API_BASE_URL}/brandops`

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    credentials: 'include',
    headers: init?.body instanceof FormData
      ? (init?.headers ?? {})
      : { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    ...init,
  })
  const payload = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((payload as { message?: string }).message || 'Request failed.')
  return payload as T
}

const qs = (params: Record<string, string | undefined>) => {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v) q.set(k, v)
  const s = q.toString()
  return s ? `?${s}` : ''
}

// ── Shared vocabulary ──────────────────────────────────────────────────────

export type FrameStatus = 'available' | 'in_use' | 'retired'
export type RequestStatus = 'pending' | 'quoted' | 'approved' | 'in_progress' | 'completed' | 'closed' | 'rejected'
export type QuoteStatus = 'pending' | 'approved' | 'rejected'
export type WorkOrderStatus = 'assigned' | 'checked_in' | 'in_progress' | 'completed' | 'verified' | 'closed'
export type DeliveryStatus = 'awaiting' | 'ready' | 'collected'
export type PhotoPhase = 'before' | 'during' | 'after'
export type Priority = 'normal' | 'high' | 'urgent'

export interface Institute {
  id: string; name: string; faculty: string; active: boolean
  created_at: string; frames_in_use: number
}
export interface Vendor { id: string; name: string; phone: string; address: string; active: boolean; created_at: string }
export interface Frame {
  id: string; asset_id: string; size: string; status: FrameStatus; condition: string
  location: string; institute_id: string | null; institute_name: string | null
  notes: string; created_at: string; updated_at: string
  event: string | null; from_date: string | null; until_date: string | null
}
export interface Allocation {
  id: string; frame_id: string; asset_id: string; size: string
  institute_id: string; institute_name: string; location: string; event: string
  from_date: string; until_date: string; allocated_at: string; returned_at: string | null
  return_condition: string; return_location: string; return_remarks: string
}
export interface BrandingRequest {
  id: string; reference: string; institute_id: string; institute_name: string
  required_date: string; work_type: string; priority: Priority; description: string
  location: string; quantity: number; status: RequestStatus; created_at: string
  /** Free text — a frame size or anything new. Empty when not given. */
  size: string
  completed_at: string | null; completion_note: string
  /** Quotations still standing (removed ones are history, not counted). */
  quote_count: number; approved_amount: string | null
  /** The cheapest quotation still standing. */
  lowest_amount: string | null
}
export interface Quotation {
  id: string; reference: string; request_id: string; request_reference: string
  institute_name: string; vendor_id: string; vendor_name: string; amount: string
  quote_date: string; status: QuoteStatus; notes: string; decision_note: string
  decided_at: string | null; created_at: string
  /** 1 for an unedited quotation; each edit adds one. */
  revision: number; updated_at: string | null
  removed_at: string | null; removal_reason: string
  work_type: string; request_size: string
  /** Set when the requirement itself was removed — the quotation is then history only. */
  request_removed_at: string | null
}
/** One earlier version of a quotation, kept when it was edited. */
export interface QuotationRevision {
  revision: number; vendor_name: string; amount: string; quote_date: string
  notes: string; replaced_at: string; replaced_by_name: string | null
}
export interface QuotationWithHistory extends Quotation { revisions: QuotationRevision[] }
/** A quotation as the Dashboard's ⓘ shows it. */
export interface QuoteSummary {
  id: string; reference: string; vendor_name: string; amount: string
  quote_date: string; status: QuoteStatus; revision: number
}
/** A requirement as the forms send it. */
export interface RequestForm {
  institute_id: string; required_date: string; work_type: string
  priority: Priority; description: string; location: string; quantity: number; size: string
}
export interface WorkOrder {
  id: string; reference: string; request_id: string; request_reference: string
  institute_name: string; quotation_id: string | null; amount: string | null
  vendor_id: string; vendor_name: string; assigned_date: string; description: string
  status: WorkOrderStatus; verified_at: string | null; closed_at: string | null
  created_at: string; photo_count: number; open_visit_id: string | null
}
export interface VendorVisit {
  id: string; work_order_id: string; work_order_reference: string; vendor_name: string
  institute_name: string; check_in_at: string; check_out_at: string | null; notes: string
}
export interface WorkPhoto {
  id: string; work_order_id: string; phase: PhotoPhase; file_path: string
  original_name: string; caption: string; uploaded_at: string
}
export interface Delivery {
  id: string; reference: string; institute_id: string; institute_name: string
  material_type: string; description: string; quantity: number
  vendor_id: string | null; vendor_name: string | null; expected_date: string | null
  status: DeliveryStatus; received_at: string | null; notified_at: string | null
  collected_at: string | null; collected_by_name: string; remarks: string; created_at: string
  images: { id: string; file_path: string; original_name: string }[]
}
export interface ActivityRow {
  id: string; actor_name: string; actor_email: string; module: string
  action: string; details: string; entity_type: string; entity_id: string; created_at: string
}
export interface Kpis {
  totalFrames: number; available: number; inUse: number; retired: number
  distinctSizes: number; overdue: number
  pendingRequests: number; openQuotations: number; activeWorkOrders: number
  vendorsOnSite: number; deliveriesAwaiting: number; deliveriesReady: number
  institutesHoldingFrames: number; totalInstitutes: number; totalVendors: number
  sheetLineTotal: number; sheetStatedTotal: number
}
export interface SizeBreakdown { size: string; total: number; available: number; in_use: number }

// ── Calls ──────────────────────────────────────────────────────────────────

export const boMe = () => request<{ admin: boolean; capabilities: string[] }>('/me')

export const boDashboard = () => request<{
  kpis: Kpis; sizes: SizeBreakdown[]; allocations: Allocation[]; requests: BrandingRequest[]
  /** The quotations behind each listed requirement, by requirement id. */
  quotes: Record<string, QuoteSummary[]>
}>('/dashboard')

export const boReports = () => request<{
  kpis: Kpis; sizes: SizeBreakdown[]; institutes: Institute[]; sheet: [string, number][]
}>('/reports')

export const boInstitutes = () => request<{ institutes: Institute[] }>('/institutes')
export const boAddInstitute = (name: string, faculty: string) =>
  request<{ institute: Institute }>('/institutes', { method: 'POST', body: JSON.stringify({ name, faculty }) })
export const boUpdateInstitute = (id: string, patch: Partial<{ name: string; faculty: string; active: boolean }>) =>
  request<{ ok: true }>(`/institutes/${id}`, { method: 'PATCH', body: JSON.stringify(patch) })
export const boDeleteInstitute = (id: string) =>
  request<{ deleted: true }>(`/institutes/${id}`, { method: 'DELETE' })

export const boVendors = () => request<{ vendors: Vendor[] }>('/vendors')
export const boAddVendor = (v: { name: string; phone: string; address: string }) =>
  request<{ vendor: Vendor }>('/vendors', { method: 'POST', body: JSON.stringify(v) })
export const boUpdateVendor = (id: string, patch: Partial<Vendor>) =>
  request<{ ok: true }>(`/vendors/${id}`, { method: 'PATCH', body: JSON.stringify(patch) })
export const boDeleteVendor = (id: string) =>
  request<{ deleted: true }>(`/vendors/${id}`, { method: 'DELETE' })

export const boFrames = (p: { q?: string; status?: FrameStatus; size?: string; institute_id?: string } = {}) =>
  request<{ frames: Frame[]; sizes: string[]; next_asset_id: string }>(`/frames${qs(p)}`)
export const boFrame = (id: string) =>
  request<{ frame: Frame; history: Allocation[] }>(`/frames/${id}`)
export const boAddFrame = (f: { asset_id?: string; size: string; location?: string; condition?: string; notes?: string }) =>
  request<{ frame: Frame }>('/frames', { method: 'POST', body: JSON.stringify(f) })
export const boUpdateFrame = (id: string, patch: Partial<{ size: string; condition: string; location: string; notes: string }>) =>
  request<{ ok: true }>(`/frames/${id}`, { method: 'PATCH', body: JSON.stringify(patch) })
export const boRetireFrame = (id: string) =>
  request<{ deleted: true }>(`/frames/${id}`, { method: 'DELETE' })

export const boAllocations = (p: { open?: boolean; frame_id?: string; institute_id?: string } = {}) =>
  request<{ allocations: Allocation[] }>(`/allocations${qs({
    open: p.open === undefined ? undefined : String(p.open),
    frame_id: p.frame_id, institute_id: p.institute_id,
  })}`)
export const boAllocate = (a: {
  frame_id: string; institute_id: string; location: string; event: string; from_date: string; until_date: string
}) => request<{ allocation: Allocation }>('/allocations', { method: 'POST', body: JSON.stringify(a) })
export const boReturnFrame = (id: string, r: { condition?: string; location?: string; remarks?: string; returned_at?: string }) =>
  request<{ ok: true }>(`/frames/${id}/return`, { method: 'POST', body: JSON.stringify(r) })

export const boRequests = (p: { status?: RequestStatus; institute_id?: string; q?: string } = {}) =>
  request<{ requests: BrandingRequest[]; sizes: string[] }>(`/requests${qs(p)}`)
export const boAddRequest = (r: RequestForm) =>
  request<{ request: BrandingRequest }>('/requests', { method: 'POST', body: JSON.stringify(r) })
export const boUpdateRequest = (id: string, r: RequestForm) =>
  request<{ request: BrandingRequest }>(`/requests/${id}`, { method: 'PATCH', body: JSON.stringify(r) })
export const boSetRequestStatus = (id: string, status: RequestStatus) =>
  request<{ ok: true }>(`/requests/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) })
/** Marks the work finished. */
export const boCompleteRequest = (id: string, note = '') =>
  request<{ ok: true }>(`/requests/${id}/complete`, { method: 'POST', body: JSON.stringify({ note }) })
/** Undoes "Completed"; returns the status it went back to. */
export const boReopenRequest = (id: string) =>
  request<{ status: RequestStatus }>(`/requests/${id}/reopen`, { method: 'POST' })
/** Removes a requirement from Requests and the Dashboard alike. Kept on record. */
export const boRemoveRequest = (id: string, reason = '') =>
  request<{ removed: true }>(`/requests/${id}`, { method: 'DELETE', body: JSON.stringify({ reason }) })
/** Every quotation a requirement has had, each with its earlier versions. */
export const boRequestQuotations = (id: string) =>
  request<{ request: BrandingRequest | null; quotations: QuotationWithHistory[] }>(`/requests/${id}/quotations`)

export const boQuotations = (p: { status?: QuoteStatus; request_id?: string; include_removed?: '1' } = {}) =>
  request<{ quotations: Quotation[] }>(`/quotations${qs(p)}`)
/**
 * Adds a quotation — against a requirement from the list (`request_id`), or a
 * new one typed into the form (`new_requirement`), created in the same step.
 */
export const boAddQuotation = (q: {
  request_id?: string; new_requirement?: RequestForm
  vendor_id: string; amount: number; quote_date: string; notes?: string
}) => request<{ quotation: Quotation }>('/quotations', { method: 'POST', body: JSON.stringify(q) })
/** Edits a quotation; the version it replaces is kept. */
export const boUpdateQuotation = (id: string, patch: {
  vendor_id?: string; amount?: number; quote_date?: string; notes?: string
}) => request<{ quotation: Quotation }>(`/quotations/${id}`, { method: 'PATCH', body: JSON.stringify(patch) })
/** Removes a quotation from the lists; it stays in the requirement's history. */
export const boRemoveQuotation = (id: string, reason = '') =>
  request<{ removed: true }>(`/quotations/${id}`, { method: 'DELETE', body: JSON.stringify({ reason }) })
export const boApprovals = () => request<{ quotations: Quotation[] }>('/approvals')
export const boDecideQuotation = (id: string, decision: 'approved' | 'rejected', note = '') =>
  request<{ ok: true }>(`/quotations/${id}/decision`, { method: 'POST', body: JSON.stringify({ decision, note }) })

export const boWorkOrders = (p: { status?: WorkOrderStatus; q?: string } = {}) =>
  request<{ work_orders: WorkOrder[] }>(`/work-orders${qs(p)}`)
export const boWorkOrder = (id: string) =>
  request<{ work_order: WorkOrder; visits: VendorVisit[]; photos: WorkPhoto[] }>(`/work-orders/${id}`)
export const boAddWorkOrder = (w: { request_id: string; assigned_date: string; description?: string }) =>
  request<{ work_order: WorkOrder }>('/work-orders', { method: 'POST', body: JSON.stringify(w) })
export const boSetWorkOrderStatus = (id: string, status: WorkOrderStatus) =>
  request<{ ok: true }>(`/work-orders/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) })

export const boVisits = (p: { work_order_id?: string; open?: boolean } = {}) =>
  request<{ visits: VendorVisit[]; work_orders: WorkOrder[] }>(`/visits${qs({
    work_order_id: p.work_order_id, open: p.open ? 'true' : undefined,
  })}`)
export const boCheckIn = (workOrderId: string, notes = '') =>
  request<{ ok: true }>(`/work-orders/${workOrderId}/check-in`, { method: 'POST', body: JSON.stringify({ notes }) })
export const boCheckOut = (workOrderId: string, notes = '') =>
  request<{ ok: true }>(`/work-orders/${workOrderId}/check-out`, { method: 'POST', body: JSON.stringify({ notes }) })

export const boCompletion = () => request<{ work_orders: WorkOrder[] }>('/completion')
export const boUploadPhotos = (workOrderId: string, form: FormData) =>
  request<{ photos: WorkPhoto[] }>(`/work-orders/${workOrderId}/photos`, { method: 'POST', body: form })
export const boDeletePhoto = (id: string) =>
  request<{ deleted: true }>(`/photos/${id}`, { method: 'DELETE' })

export const boDeliveries = (p: { status?: DeliveryStatus; institute_id?: string } = {}) =>
  request<{ deliveries: Delivery[] }>(`/deliveries${qs(p)}`)
export const boAddDelivery = (form: FormData) =>
  request<{ delivery: Delivery }>('/deliveries', { method: 'POST', body: form })
export const boDeliveryReceived = (id: string) => request<{ ok: true }>(`/deliveries/${id}/received`, { method: 'POST' })
export const boDeliveryNotify = (id: string) => request<{ ok: true }>(`/deliveries/${id}/notify`, { method: 'POST' })
export const boDeliveryCollected = (id: string, collected_by: string) =>
  request<{ ok: true }>(`/deliveries/${id}/collected`, { method: 'POST', body: JSON.stringify({ collected_by }) })

export const boActivity = (p: { module?: string; q?: string; from?: string; to?: string; limit?: string } = {}) =>
  request<{ activity: ActivityRow[] }>(`/activity${qs(p)}`)
export const boClearActivity = () => request<{ cleared: number }>('/activity', { method: 'DELETE' })

// ── Display helpers ────────────────────────────────────────────────────────

export const FRAME_STATUS_STYLE: Record<FrameStatus, { label: string; cls: string }> = {
  available: { label: 'Available', cls: 'bg-emerald-100 text-emerald-700' },
  in_use: { label: 'In Use', cls: 'bg-rose-100 text-rose-700' },
  retired: { label: 'Removed', cls: 'bg-slate-100 text-slate-600' },
}

export const REQUEST_STATUS_STYLE: Record<RequestStatus, { label: string; cls: string }> = {
  pending: { label: 'Pending', cls: 'bg-amber-100 text-amber-800' },
  quoted: { label: 'Quoted', cls: 'bg-blue-100 text-blue-700' },
  approved: { label: 'Approved', cls: 'bg-violet-100 text-violet-700' },
  in_progress: { label: 'In Progress', cls: 'bg-indigo-100 text-indigo-700' },
  completed: { label: 'Completed', cls: 'bg-teal-100 text-teal-700' },
  closed: { label: 'Closed', cls: 'bg-slate-100 text-slate-600' },
  rejected: { label: 'Rejected', cls: 'bg-rose-100 text-rose-700' },
}

export const QUOTE_STATUS_STYLE: Record<QuoteStatus, { label: string; cls: string }> = {
  pending: { label: 'Pending', cls: 'bg-amber-100 text-amber-800' },
  approved: { label: 'Approved', cls: 'bg-emerald-100 text-emerald-700' },
  rejected: { label: 'Rejected', cls: 'bg-rose-100 text-rose-700' },
}

export const WO_STATUS_STYLE: Record<WorkOrderStatus, { label: string; cls: string }> = {
  assigned: { label: 'Assigned', cls: 'bg-slate-100 text-slate-700' },
  checked_in: { label: 'Vendor On Site', cls: 'bg-blue-100 text-blue-700' },
  in_progress: { label: 'Work Started', cls: 'bg-indigo-100 text-indigo-700' },
  completed: { label: 'Work Completed', cls: 'bg-amber-100 text-amber-800' },
  verified: { label: 'Verified', cls: 'bg-teal-100 text-teal-700' },
  closed: { label: 'Closed', cls: 'bg-slate-100 text-slate-600' },
}

export const DELIVERY_STATUS_STYLE: Record<DeliveryStatus, { label: string; cls: string }> = {
  awaiting: { label: 'Awaiting Delivery', cls: 'bg-amber-100 text-amber-800' },
  ready: { label: 'Ready for Collection', cls: 'bg-emerald-100 text-emerald-700' },
  collected: { label: 'Collected', cls: 'bg-slate-100 text-slate-600' },
}

export const PRIORITY_STYLE: Record<Priority, { label: string; cls: string }> = {
  normal: { label: 'Normal', cls: 'bg-slate-100 text-slate-600' },
  high: { label: 'High', cls: 'bg-amber-100 text-amber-800' },
  urgent: { label: 'Urgent', cls: 'bg-rose-100 text-rose-700' },
}

/** The next legal statuses, so a UI never offers a transition the API refuses. */
export const WO_NEXT: Record<WorkOrderStatus, WorkOrderStatus[]> = {
  assigned: ['checked_in', 'in_progress'],
  checked_in: ['in_progress'],
  in_progress: ['completed'],
  completed: ['verified'],
  verified: ['closed'],
  closed: [],
}

export function boWhen(iso?: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString(undefined, {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

export function boMoney(amount?: string | null): string {
  if (amount == null) return '—'
  const n = Number(amount)
  return Number.isFinite(n) ? `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}` : `₹${amount}`
}

/** Local calendar day as YYYY-MM-DD — never via toISOString, which shifts. */
export function boToday(d: Date = new Date()): string {
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10)
}

export function boIsOverdue(until: string | null | undefined): boolean {
  return !!until && until < boToday()
}
