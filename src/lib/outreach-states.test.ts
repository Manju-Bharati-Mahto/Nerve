import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import * as client from './outreach-states'
import * as server from '../../server/outreach-states'
import { normaliseState, outreachStates, sameState, stateKey as groupKey } from './outreach-data'
import {
  OUTREACH_STATES, OUTREACH_STATE_NAMES, PAN_INDIA,
  canonicalGeography, canonicalState, isCanonicalState, stateKey,
  geographyKey, geographyOptions, preferredGeographySpelling, sameGeography,
} from './outreach-states'

// PRD 6.4 — one master list and one matching rule, the same in the browser and on the server.

describe('the two copies', () => {
  it('are byte-for-byte the same file', () => {
    // The server stores and scopes by this rule and the browser groups by it;
    // if they drift, a State User sees one thing and the filters say another.
    const root = path.resolve(__dirname, '../..')
    const a = readFileSync(path.join(root, 'src/lib/outreach-states.ts'), 'utf8')
    const b = readFileSync(path.join(root, 'server/outreach-states.ts'), 'utf8')
    expect(a).toBe(b)
  })

  it('export the same list and give the same answers', () => {
    expect(client.OUTREACH_STATES).toEqual(server.OUTREACH_STATES)
    for (const v of ['Tamilnadu', 'J&K', 'Orissa', 'Guj', 'गुजरात', '', '  ', 'New Delhi']) {
      expect(client.canonicalState(v), v).toBe(server.canonicalState(v))
      expect(client.canonicalGeography(v), v).toBe(server.canonicalGeography(v))
    }
  })
})

describe('the master list', () => {
  it('has the 28 states, the 8 union territories and Pan India — no duplicates', () => {
    expect(OUTREACH_STATES.filter(s => s.kind === 'state')).toHaveLength(28)
    expect(OUTREACH_STATES.filter(s => s.kind === 'ut')).toHaveLength(8)
    expect(OUTREACH_STATES.filter(s => s.kind === 'national').map(s => s.name)).toEqual([PAN_INDIA])
    expect(new Set(OUTREACH_STATE_NAMES).size).toBe(OUTREACH_STATE_NAMES.length)
  })

  it('uses the Government of India spellings', () => {
    for (const name of ['Tamil Nadu', 'Jammu and Kashmir', 'Delhi', 'Dadra and Nagar Haveli and Daman and Diu',
      'Andaman and Nicobar Islands', 'Puducherry', 'Ladakh', 'Lakshadweep', 'Chandigarh', 'Arunachal Pradesh']) {
      expect(OUTREACH_STATE_NAMES, name).toContain(name)
    }
    expect(OUTREACH_STATE_NAMES.some(n => n.includes('&'))).toBe(false)
  })

  it('gives no two names the same matching key', () => {
    // Otherwise one would silently swallow the other.
    const keys = OUTREACH_STATE_NAMES.map(stateKey)
    expect(new Set(keys).size).toBe(keys.length)
    expect(keys.every(Boolean)).toBe(true)
  })
})

describe('canonicalState', () => {
  it('ignores case, spacing and punctuation', () => {
    for (const v of ['Tamilnadu', 'Tamil Nadu', 'TAMIL NADU', 'tamil-nadu', ' tamil  nadu ', 'Tamil.Nadu']) {
      expect(canonicalState(v), v).toBe('Tamil Nadu')
    }
    for (const v of ['  gujarat  ', 'gujarat', 'GUJARAT']) expect(canonicalState(v), v).toBe('Gujarat')
    expect(canonicalState('ladakh')).toBe('Ladakh')
    expect(canonicalState('pan-india')).toBe('Pan India')
  })

  it('reads "&" as "and", and removes "and" only as a whole word', () => {
    for (const v of ['Jammu & Kashmir', 'Jammu and Kashmir', 'jammu-kashmir', 'J&K', 'JK']) {
      expect(canonicalState(v), v).toBe('Jammu and Kashmir')
    }
    expect(canonicalState('Andhra Pradesh')).toBe('Andhra Pradesh')
    expect(canonicalState('Nagaland')).toBe('Nagaland')
    expect(canonicalState('Andaman & Nicobar Islands')).toBe('Andaman and Nicobar Islands')
    expect(canonicalState('Dadra & Nagar Haveli & Daman & Diu')).toBe('Dadra and Nagar Haveli and Daman and Diu')
  })

  it('maps the unambiguous old names and abbreviations', () => {
    expect(canonicalState('UP')).toBe('Uttar Pradesh')
    expect(canonicalState('MP')).toBe('Madhya Pradesh')
    expect(canonicalState('WB')).toBe('West Bengal')
    expect(canonicalState('Orissa')).toBe('Odisha')
    expect(canonicalState('Pondicherry')).toBe('Puducherry')
    expect(canonicalState('NCT of Delhi')).toBe('Delhi')
    expect(canonicalState('New Delhi')).toBe('Delhi')
    expect(canonicalState('Uttaranchal')).toBe('Uttarakhand')
  })

  it('does not guess', () => {
    // AP is Andhra Pradesh or Arunachal Pradesh; the rest are not places on the list.
    for (const v of ['AP', 'Guj', 'efef', 'Global', 'North-East', 'Tamilnad', 'Gujarat India']) {
      expect(canonicalState(v), v).toBeNull()
    }
  })

  it('treats blank as blank, and another script as unrecognised — not blank', () => {
    expect(canonicalState('')).toBe('')
    expect(canonicalState('   ')).toBe('')
    expect(canonicalState(null)).toBe('')
    // Its key is "" — deciding blankness from the key would store it as "no state".
    expect(canonicalState('गुजरात')).toBeNull()
  })

  it('isCanonicalState accepts only the exact listed spelling', () => {
    expect(isCanonicalState('Gujarat')).toBe(true)
    expect(isCanonicalState('gujarat')).toBe(false)
    expect(isCanonicalState('Orissa')).toBe(false)
  })
})

describe('canonicalGeography', () => {
  it('gives a state-name geography its spelling and only tidies the rest', () => {
    expect(canonicalGeography('gujarat')).toBe('Gujarat')
    expect(canonicalGeography('Tamilnadu')).toBe('Tamil Nadu')
    expect(canonicalGeography('  Vadodara   city ')).toBe('Vadodara city')
    expect(canonicalGeography('North-East')).toBe('North-East')
    expect(canonicalGeography('')).toBe('')
  })

  /* UPDATED: this used to assert canonicalGeography('UP') === 'UP' — aliases
     were never applied to geography. The product owner asked for "MP" and
     "Madhya pradesh" to be one entry, so the unambiguous abbreviations and the
     "Rajsthan" misspelling now apply to geography too. The two aliases that are
     also city names still do not. */
  it('applies the abbreviations and misspellings, but never turns a city into its state', () => {
    expect(canonicalGeography('UP')).toBe('Uttar Pradesh')
    expect(canonicalGeography('MP')).toBe('Madhya Pradesh')
    expect(canonicalGeography('Rajsthan')).toBe('Rajasthan')
    expect(canonicalGeography('New Delhi')).toBe('New Delhi')
    expect(canonicalGeography('Pondicherry')).toBe('Pondicherry')
  })

  it('capitalises a name typed all in lower case, and keeps any other casing', () => {
    expect(canonicalGeography('kolkata')).toBe('Kolkata')
    expect(canonicalGeography('north-east')).toBe('North-East')
    expect(canonicalGeography('MBA')).toBe('MBA')
    expect(canonicalGeography('Start up')).toBe('Start up')
  })
})

describe('geography grouping — the All Pages "Any geography" list', () => {
  /* Exactly the dropdown in the product owner's screenshot, in its order.
     A plain .sort() put "MP" before "Madhya pradesh" and "kolkata" last. */
  const SCREENSHOT = [
    'Andhra Pradesh', 'Bengaluru', 'Bihar', 'Chhattisgarh', 'Delhi', 'Goa', 'Gujarat', 'Haryana',
    'Hyderabad', 'Jammu', 'Karnataka', 'Kashmir', 'Kerala', 'Law', 'MP', 'Madhya pradesh',
    'Maharashtra', 'Nagpur', 'North-East', 'Puducherry', 'Punjab', 'Rajsthan', 'Srinagar', 'Start up',
    'Startup', 'Surat', 'Tamil Nadu', 'Tamilnadu', 'Telangana', 'Uttar Pradesh', 'Uttarakhand',
    'Vadodara', 'kolkata',
  ]

  it('lists each geography once — the highlighted duplicates and MP / Madhya pradesh merged', () => {
    const labels = geographyOptions(SCREENSHOT).map(o => o.label)
    expect(labels).toHaveLength(30)
    expect(new Set(labels.map(l => l.toLowerCase().replace(/\s/g, ''))).size).toBe(30)
    expect(labels).toContain('Startup')
    expect(labels).not.toContain('Start up')
    expect(labels).toContain('Tamil Nadu')
    expect(labels).not.toContain('Tamilnadu')
    expect(labels).toContain('Madhya Pradesh')
    expect(labels).not.toContain('MP')
    expect(labels).toContain('Rajasthan')
    expect(labels).toContain('Kolkata')
  })

  it('sorts without regard to case', () => {
    const labels = geographyOptions(SCREENSHOT).map(o => o.label)
    expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' })))
    expect(labels.indexOf('Kolkata')).toBeLessThan(labels.indexOf('Law'))
  })

  it('keeps cities and regions that only look related apart', () => {
    const labels = geographyOptions(SCREENSHOT).map(o => o.label)
    for (const kept of ['Jammu', 'Kashmir', 'Srinagar', 'Delhi', 'North-East', 'Law', 'Surat', 'Vadodara']) {
      expect(labels, kept).toContain(kept)
    }
  })

  it('treats the PDF\'s four spellings as one state', () => {
    const variants = ['Tamil Nadu', 'tamil nadu', 'TAMIL NADU', 'tamilnadu']
    expect(new Set(variants.map(geographyKey)).size).toBe(1)
    expect(geographyOptions(variants)).toEqual([{ key: geographyKey('Tamil Nadu'), label: 'Tamil Nadu' }])
    expect(sameGeography('Start up', 'STARTUP')).toBe(true)
    expect(sameGeography('Surat', 'Vadodara')).toBe(false)
  })

  it('picks one spelling deterministically: the state name, else the commonest, else the tidier', () => {
    expect(preferredGeographySpelling({ Tamilnadu: 9, 'Tamil Nadu': 1 })).toBe('Tamil Nadu')
    expect(preferredGeographySpelling({ 'Start up': 5, Startup: 2 })).toBe('Start up')
    expect(preferredGeographySpelling({ 'Start up': 2, Startup: 2 })).toBe('Startup')
    expect(preferredGeographySpelling({ startup: 1, Startup: 1 })).toBe('Startup')
  })
})

describe('the client helpers use the same rule', () => {
  it('makes "Tamilnadu" and "Tamil Nadu" one state — the PRD example the old key missed', () => {
    expect(normaliseState('Tamilnadu')).toBe('Tamil Nadu')
    expect(sameState('Tamilnadu', 'Tamil Nadu')).toBe(true)
    expect(sameState('Orissa', 'Odisha')).toBe(true)
    expect(outreachStates(
      [{ state: 'Tamilnadu' }, { state: 'TAMIL NADU' }, { state: '  gujarat ' }] as never[], [],
    )).toEqual(['Gujarat', 'Tamil Nadu'])
  })

  it('keeps an unrecognised legacy value visible, tidied, as its own group', () => {
    expect(normaliseState('  Guj ')).toBe('Guj')
    expect(sameState('Guj', 'Gujarat')).toBe(false)
    expect(groupKey('गुजरात')).not.toBe(groupKey(''))
  })
})
