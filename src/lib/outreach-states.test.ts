import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import * as client from './outreach-states'
import * as server from '../../server/outreach-states'
import { normaliseState, outreachStates, sameState, stateKey as groupKey } from './outreach-data'
import {
  OUTREACH_STATES, OUTREACH_STATE_NAMES, PAN_INDIA,
  canonicalGeography, canonicalState, isCanonicalState, stateKey,
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

  it('never applies the aliases — a city is not its state', () => {
    expect(canonicalGeography('New Delhi')).toBe('New Delhi')
    expect(canonicalGeography('Pondicherry')).toBe('Pondicherry')
    expect(canonicalGeography('UP')).toBe('UP')
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
