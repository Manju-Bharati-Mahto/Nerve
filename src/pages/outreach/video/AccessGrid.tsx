import { OUTREACH_TABS, type OutreachTabLevel } from '@/lib/outreach-tabs'
import { OUTREACH_STATE_NAMES } from '@/lib/outreach-states'

/**
 * The tab grid in Add / Edit User (Account Tabs requirements §1): every
 * outreach tab, each Off / View / Edit. Edit is offered only on tabs that have
 * something to change; the row says what it allows. Video workflow tabs are
 * unavailable for a State User, who has no workflow role.
 */
export function AccessGrid({ tabs, onChange, stateUser }: {
  tabs: Record<string, OutreachTabLevel>
  onChange: (next: Record<string, OutreachTabLevel>) => void
  stateUser: boolean
}) {
  const set = (id: string, level: OutreachTabLevel | 'off') => {
    const next = { ...tabs }
    if (level === 'off') delete next[id]; else next[id] = level
    onChange(next)
  }
  const usable = OUTREACH_TABS.filter(t => !(stateUser && t.needsVideoRole))
  const setAll = (level: OutreachTabLevel | 'off') => {
    if (level === 'off') return onChange({})
    onChange(Object.fromEntries(usable.map(t => [t.id, level === 'edit' && t.edit ? 'edit' : 'view'])))
  }

  const group = (name: 'influencer' | 'video', heading: string, note: string) => (
    <div className="space-y-1">
      <p className="text-[11px] uppercase tracking-widest text-muted-foreground mt-2">{heading}</p>
      <p className="text-[11px] text-muted-foreground -mt-0.5 mb-1">{note}</p>
      {OUTREACH_TABS.filter(t => t.group === name).map(t => {
        const disabled = stateUser && !!t.needsVideoRole
        const level = disabled ? 'off' : (tabs[t.id] ?? 'off')
        return (
          <div key={t.id} className={`flex items-center gap-3 px-2.5 py-1.5 rounded-lg border border-border ${disabled ? 'opacity-50' : ''}`}>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold text-foreground">{t.label}</p>
              {t.edit && <p className="text-[10px] text-muted-foreground">Edit: {t.edit}</p>}
            </div>
            <div className="inline-flex rounded-lg border border-border overflow-hidden shrink-0" role="radiogroup" aria-label={t.label}>
              {(['off', 'view', 'edit'] as const).map(opt => {
                const unavailable = disabled || (opt === 'edit' && !t.edit)
                return (
                  <button key={opt} type="button" role="radio" aria-checked={level === opt}
                    disabled={unavailable}
                    title={opt === 'edit' && !t.edit ? 'This tab only shows information — there is nothing to edit.' : undefined}
                    onClick={() => set(t.id, opt)}
                    className={`px-2.5 py-1 text-[11px] font-medium capitalize border-l first:border-l-0 border-border ${
                      level === opt ? 'bg-orange-600 text-white' : 'bg-card text-muted-foreground hover:bg-accent'
                    } disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-card`}>
                    {opt}
                  </button>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )

  return (
    <div>
      <div className="flex items-center justify-between gap-2 mb-1">
        <label className="hub-label mb-0">Tabs and permissions</label>
        <div className="flex gap-2 text-[11px] font-semibold text-orange-700">
          <button type="button" onClick={() => setAll('view')} className="hover:underline">All view</button>
          <button type="button" onClick={() => setAll('edit')} className="hover:underline">All edit</button>
          <button type="button" onClick={() => setAll('off')} className="hover:underline">Clear</button>
        </div>
      </div>
      <p className="text-[11px] text-muted-foreground">
        Only the tabs switched on here appear for this person. View shows a tab; Edit also lets them make its changes.
      </p>
      <div>
        {group('influencer', 'Outreach', 'Limited to the states chosen below.')}
        {group('video', 'Video workflow', stateUser ? 'Not available to a State User, who has no video workflow role.' : 'Not limited by state.')}
      </div>
    </div>
  )
}

/** The states half (Account Tabs requirements §2): All States, or one or more states. */
export function StatesPicker({ allStates, states, onChange }: {
  allStates: boolean
  states: string[]
  onChange: (next: { allStates: boolean; states: string[] }) => void
}) {
  const toggle = (s: string) => onChange({
    allStates: false,
    states: states.includes(s) ? states.filter(x => x !== s) : [...states, s],
  })
  return (
    <div>
      <label className="hub-label">States whose pages and analytics they see</label>
      <div className="space-y-1.5">
        <label className="flex items-center gap-2 text-sm text-foreground">
          <input type="radio" name="states-scope" checked={allStates} onChange={() => onChange({ allStates: true, states: [] })} />
          All States
        </label>
        <label className="flex items-center gap-2 text-sm text-foreground">
          <input type="radio" name="states-scope" checked={!allStates} onChange={() => onChange({ allStates: false, states })} />
          Only these states
        </label>
      </div>
      {!allStates && (
        <>
          <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 max-h-44 overflow-y-auto border border-border rounded-lg p-2 mt-2">
            {OUTREACH_STATE_NAMES.map(s => (
              <label key={s} className="flex items-center gap-2 text-xs text-foreground py-0.5 cursor-pointer">
                <input type="checkbox" checked={states.includes(s)} onChange={() => toggle(s)} />
                {s}
              </label>
            ))}
          </div>
          {states.length === 0 && (
            <p className="text-[11px] text-amber-700 mt-1">With no state ticked, they see no pages or analytics in any Outreach tab.</p>
          )}
        </>
      )}
    </div>
  )
}
