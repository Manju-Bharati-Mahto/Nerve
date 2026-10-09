/**
 * Outreach geography — the master list of states and the ONE rule for matching
 * whatever somebody typed ("Tamilnadu", "TAMIL NADU", "tamil-nadu") to it.
 *
 * WHY THIS EXISTS. State was free text everywhere in outreach: the server
 * stored it exactly as sent, so the database held "gujarat", "Gujarat" and
 * "  gujarat  " as three states, the Dashboard offered all three, and a filter
 * on one hid the pages filed under the others. The client grew its own
 * case-insensitive fix (normaliseState / sameState in outreach-data.ts), but it
 * kept inner spaces — so "Tamilnadu" and "Tamil Nadu" stayed two states — and
 * knew only 22 states. State-wise access (a State User sees only their states)
 * makes a wrong match a wrong ANSWER, not just an untidy dropdown, so there is
 * now one list and one rule, applied by the server on every write and used by
 * the client to group and compare.
 *
 * TWO COPIES, ONE TEXT. server/outreach-states.ts and src/lib/outreach-states.ts
 * are byte-identical: the server and the browser are separate builds and do not
 * import each other. outreach-states.test.ts fails the moment they differ, so
 * edit one and copy it over the other.
 *
 * NO IMPORTS AND NO TOP-LEVEL WORK beyond building two lookup maps: the shared
 * sidebar loads outreach-data.ts (and so this file) for every department, so
 * nothing here may throw or assert at load time. The checks live in the tests.
 */

export type OutreachStateKind = "state" | "ut" | "national";

export interface OutreachStateEntry {
  name: string;
  kind: OutreachStateKind;
}

/** For national / university-wide accounts that belong to no one state. */
export const PAN_INDIA = "Pan India";

/**
 * The 28 states and 8 union territories with the Government of India's
 * spellings ("and", never "&"), then the one non-state entry.
 */
export const OUTREACH_STATES: readonly OutreachStateEntry[] = [
  { name: "Andhra Pradesh", kind: "state" },
  { name: "Arunachal Pradesh", kind: "state" },
  { name: "Assam", kind: "state" },
  { name: "Bihar", kind: "state" },
  { name: "Chhattisgarh", kind: "state" },
  { name: "Goa", kind: "state" },
  { name: "Gujarat", kind: "state" },
  { name: "Haryana", kind: "state" },
  { name: "Himachal Pradesh", kind: "state" },
  { name: "Jharkhand", kind: "state" },
  { name: "Karnataka", kind: "state" },
  { name: "Kerala", kind: "state" },
  { name: "Madhya Pradesh", kind: "state" },
  { name: "Maharashtra", kind: "state" },
  { name: "Manipur", kind: "state" },
  { name: "Meghalaya", kind: "state" },
  { name: "Mizoram", kind: "state" },
  { name: "Nagaland", kind: "state" },
  { name: "Odisha", kind: "state" },
  { name: "Punjab", kind: "state" },
  { name: "Rajasthan", kind: "state" },
  { name: "Sikkim", kind: "state" },
  { name: "Tamil Nadu", kind: "state" },
  { name: "Telangana", kind: "state" },
  { name: "Tripura", kind: "state" },
  { name: "Uttar Pradesh", kind: "state" },
  { name: "Uttarakhand", kind: "state" },
  { name: "West Bengal", kind: "state" },
  { name: "Andaman and Nicobar Islands", kind: "ut" },
  { name: "Chandigarh", kind: "ut" },
  { name: "Dadra and Nagar Haveli and Daman and Diu", kind: "ut" },
  { name: "Delhi", kind: "ut" },
  { name: "Jammu and Kashmir", kind: "ut" },
  { name: "Ladakh", kind: "ut" },
  { name: "Lakshadweep", kind: "ut" },
  { name: "Puducherry", kind: "ut" },
  { name: PAN_INDIA, kind: "national" },
];

/** Every canonical name, in list order. */
export const OUTREACH_STATE_NAMES: readonly string[] = OUTREACH_STATES.map(s => s.name);

/**
 * The matching key: case, spacing, punctuation and the word "and" (or "&")
 * ignored. "Tamil Nadu", "Tamilnadu", "TAMIL NADU" and "tamil-nadu" all give
 * "tamilnadu"; "Jammu & Kashmir" and "Jammu and Kashmir" both give
 * "jammukashmir". "and" goes only as a whole word, so "Andhra" and "Nagaland"
 * keep theirs. A value written in another script keys to "" — callers decide
 * blankness from the raw text, never from the key, so such a value is
 * "unrecognised", not "blank".
 */
export function stateKey(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/&/g, " ")
    .replace(/\band\b/g, " ")
    .replace(/[^a-z]/g, "");
}

/**
 * Old names and abbreviations that can only mean one place. "AP" is left out
 * on purpose: Andhra Pradesh or Arunachal Pradesh — a guess would file pages
 * under the wrong state, and with state-wise access, show them to the wrong
 * people.
 */
const STATE_ALIASES: ReadonlyArray<readonly [alias: string, canonical: string]> = [
  ["J&K", "Jammu and Kashmir"],
  ["JK", "Jammu and Kashmir"],
  ["UP", "Uttar Pradesh"],
  ["MP", "Madhya Pradesh"],
  ["WB", "West Bengal"],
  ["Orissa", "Odisha"],
  ["Pondicherry", "Puducherry"],
  ["NCT of Delhi", "Delhi"],
  ["New Delhi", "Delhi"],
  ["Uttaranchal", "Uttarakhand"],
];

const CANONICAL_BY_KEY = new Map<string, string>(OUTREACH_STATE_NAMES.map(n => [stateKey(n), n]));
const ALIAS_BY_KEY = new Map<string, string>(STATE_ALIASES.map(([alias, name]) => [stateKey(alias), name]));

/** Trimmed, with every run of whitespace collapsed to one space. */
export function tidyText(value: string | null | undefined): string {
  return (value ?? "").trim().replace(/\s+/g, " ");
}

/**
 * The canonical name for a typed state; "" for a blank value; null for
 * anything that matches no state, union territory, alias or "Pan India".
 */
export function canonicalState(value: string | null | undefined): string | null {
  const text = tidyText(value);
  if (!text) return "";
  const key = stateKey(text);
  if (!key) return null;
  return CANONICAL_BY_KEY.get(key) ?? ALIAS_BY_KEY.get(key) ?? null;
}

/** True when `value` is exactly one of the canonical names. */
export function isCanonicalState(value: string): boolean {
  return CANONICAL_BY_KEY.get(stateKey(value)) === value;
}

/**
 * Geography is a city or region ("Vadodara", "North-East"), so it stays free
 * text. It is tidied, and when it IS a state name it takes that state's
 * spelling ("gujarat" → "Gujarat"), which is what merged the duplicate
 * sections. Only the canonical names match here, never the aliases: "New
 * Delhi" is a city and must not become "Delhi", "Pondicherry" must not become
 * "Puducherry".
 */
export function canonicalGeography(value: string | null | undefined): string {
  const text = tidyText(value);
  return CANONICAL_BY_KEY.get(stateKey(text)) ?? text;
}
