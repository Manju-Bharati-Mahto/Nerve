/**
 * The one way a state is entered on the influencer side (PRD 6.4): a dropdown
 * of the master list, never free text.
 *
 * Free text is how the ledger came to hold "gujarat", "Gujarat" and
 * "  gujarat  " as three states, and with state-wise access a misspelt state
 * is no longer untidy, it is a page the right State User cannot see. The
 * server refuses anything off the list; this keeps people from typing it.
 *
 * A value that is not on the list — a legacy row the migration could not
 * place, or a state read from a spreadsheet — is still SHOWN, as a disabled
 * "unrecognised" option, so the person sees what is stored and replaces it,
 * rather than the select silently showing some other state.
 */
import { OUTREACH_STATES, canonicalState } from '@/lib/outreach-states'

const STATES = OUTREACH_STATES.filter(s => s.kind === 'state').map(s => s.name)
const UNION_TERRITORIES = OUTREACH_STATES.filter(s => s.kind === 'ut').map(s => s.name)
const NATIONAL = OUTREACH_STATES.filter(s => s.kind === 'national').map(s => s.name)

export interface StateSelectProps {
  /** The stored or typed state. Anything matching the list shows as its canonical name. */
  value: string
  /** Always called with a canonical name, or '' for the empty choice. */
  onChange: (state: string) => void
  /**
   * Label for an empty choice, e.g. "Not tied to one state" for a campaign.
   * Without it the placeholder can't be picked again once a state is chosen.
   */
  allowEmpty?: string
  placeholder?: string
  disabled?: boolean
  required?: boolean
  className?: string
  id?: string
  'aria-label'?: string
}

export default function StateSelect({
  value, onChange, allowEmpty, placeholder = 'Choose a state…', disabled, required, className = 'hub-input', id,
  'aria-label': ariaLabel,
}: StateSelectProps) {
  const canonical = canonicalState(value)
  const unrecognised = canonical === null
  // The legacy text is the option's value, so the select shows it as chosen.
  const selected = unrecognised ? value : canonical

  return (
    <select
      id={id}
      aria-label={ariaLabel}
      className={`${className}${unrecognised ? ' border-amber-400 bg-amber-50 text-amber-900' : ''}`}
      value={selected}
      disabled={disabled}
      required={required}
      aria-invalid={unrecognised || undefined}
      onChange={e => onChange(e.target.value)}
    >
      {allowEmpty !== undefined
        ? <option value="">{allowEmpty}</option>
        : <option value="" disabled>{placeholder}</option>}
      {unrecognised && (
        <option value={value} disabled>⚠ {value.trim()} (unrecognised — pick a state)</option>
      )}
      <optgroup label="States">
        {STATES.map(s => <option key={s} value={s}>{s}</option>)}
      </optgroup>
      <optgroup label="Union territories">
        {UNION_TERRITORIES.map(s => <option key={s} value={s}>{s}</option>)}
      </optgroup>
      <optgroup label="Not one state">
        {NATIONAL.map(s => <option key={s} value={s}>{s}</option>)}
      </optgroup>
    </select>
  )
}
