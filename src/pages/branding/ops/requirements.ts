/**
 * Plain helpers for the requirement and quotation screens — kept apart from
 * the components in requirements-ui.tsx so that file exports only components.
 */
import { boMoney, boToday, QUOTE_STATUS_STYLE, type BrandingRequest, type QuoteSummary, type RequestForm } from '@/lib/brandops-api'

export const WORK_TYPES = ['Frame / Branding', 'Signage', 'Banner', 'Printing', 'Installation', 'Repair / Maintenance', 'Other']

export function emptyRequestForm(): RequestForm {
  return {
    institute_id: '', required_date: boToday(), work_type: '', priority: 'normal',
    description: '', location: '', quantity: 1, size: '',
  }
}

export function requestFormOf(r: BrandingRequest): RequestForm {
  return {
    institute_id: r.institute_id, required_date: r.required_date, work_type: r.work_type,
    priority: r.priority, description: r.description, location: r.location,
    quantity: r.quantity, size: r.size ?? '',
  }
}

export const requestFormReady = (f: RequestForm) =>
  !!(f.institute_id && f.required_date && f.work_type && f.description.trim())

/** A quick hover preview of a requirement's quotations, for the Dashboard. */
export function quoteSummaryTitle(quotes: QuoteSummary[] | undefined): string {
  if (!quotes?.length) return 'No quotations yet'
  return quotes.map(q => `${q.vendor_name}: ${boMoney(q.amount)} (${QUOTE_STATUS_STYLE[q.status].label})`).join('\n')
}

