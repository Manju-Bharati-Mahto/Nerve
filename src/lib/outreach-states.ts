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
const STATE_ALIASES: ReadonlyArray<readonly [alias: string, canonical: string, scope: "state" | "both"]> = [
  ["J&K", "Jammu and Kashmir", "both"],
  ["JK", "Jammu and Kashmir", "both"],
  ["UP", "Uttar Pradesh", "both"],
  ["MP", "Madhya Pradesh", "both"],
  ["WB", "West Bengal", "both"],
  ["Orissa", "Odisha", "both"],
  ["Uttaranchal", "Uttarakhand", "both"],
  ["NCT of Delhi", "Delhi", "both"],
  /* Misspellings seen in the live ledger. "Rajsthan" sat in the All Pages
     geography list as a state of its own. */
  ["Rajsthan", "Rajasthan", "both"],
  /* State only. As a GEOGRAPHY these are cities — New Delhi is a district of
     Delhi, Pondicherry the town in Puducherry — and filing a page there under
     the whole state would lose the detail somebody wrote down on purpose. */
  ["Pondicherry", "Puducherry", "state"],
  ["New Delhi", "Delhi", "state"],
];

const CANONICAL_BY_KEY = new Map<string, string>(OUTREACH_STATE_NAMES.map(n => [stateKey(n), n]));
const ALIAS_BY_KEY = new Map<string, string>(STATE_ALIASES.map(([alias, name]) => [stateKey(alias), name]));
const GEOGRAPHY_ALIAS_BY_KEY = new Map<string, string>(
  STATE_ALIASES.filter(([, , scope]) => scope === "both").map(([alias, name]) => [stateKey(alias), name]));

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
 * Geography is free text — a state, a city ("Surat", "Kolkata") or a grouping
 * the team uses ("North-East", "Startup", "Law") — so there is no master list
 * to snap it to. What makes two spellings the same geography is the rule the
 * product owner set: capitals and spaces do not count. "Start up" and
 * "Startup", "Tamil Nadu" and "tamilnadu" are one entry each.
 *
 * This function settles everything that can be settled from one value alone:
 *   - a state or union territory name, or an unambiguous abbreviation or
 *     misspelling of one ("MP", "Rajsthan"), takes the state's spelling;
 *   - anything else is tidied, and written entirely in lower case it gets
 *     capitals ("kolkata" → "Kolkata") — a name typed in a hurry, not a
 *     spelling anybody chose. Mixed or upper case ("MBA", "North-East") is
 *     kept as written.
 * Choosing between two spellings of the SAME non-state geography ("Start up"
 * vs "Startup") needs every spelling in use — see preferredGeographySpelling.
 */
export function canonicalGeography(value: string | null | undefined): string {
  const text = tidyText(value);
  const key = stateKey(text);
  const state = CANONICAL_BY_KEY.get(key) ?? GEOGRAPHY_ALIAS_BY_KEY.get(key);
  if (state) return state;
  if (text && text === text.toLowerCase() && /[a-z]/.test(text)) {
    return text.replace(/(^|[\s\-/(])([a-z])/g, (_m, sep: string, ch: string) => sep + ch.toUpperCase());
  }
  return text;
}

/**
 * The matching key for a geography: two values with the same key are the same
 * geography. Built on canonicalGeography first, so "MP" and "Madhya pradesh"
 * agree, then on stateKey, so case, spaces and punctuation do not count.
 */
export function geographyKey(value: string | null | undefined): string {
  const canonical = canonicalGeography(value);
  return stateKey(canonical) || canonical.toLowerCase();
}

/** Whether two geographies are the same place by the rule above. */
export function sameGeography(a: string | null | undefined, b: string | null | undefined): boolean {
  return geographyKey(a) === geographyKey(b);
}

/**
 * Which spelling a group of same-key geographies is shown and stored as.
 * Deterministic, so the server's migration, its write path and the browser's
 * dropdown always land on the same one:
 *   1. a state's canonical name, whenever the group is a state;
 *   2. otherwise the spelling the most rows use;
 *   3. on a tie, one that is not all lower case, then the one with fewer
 *      spaces ("Startup" over "Start up"), then alphabetical.
 * `counts` maps each spelling in use to how many rows carry it.
 */
export function preferredGeographySpelling(counts: ReadonlyMap<string, number> | Record<string, number>): string {
  const entries = (counts instanceof Map ? [...counts.entries()] : Object.entries(counts))
    .map(([spelling, n]) => [canonicalGeography(spelling), n] as const)
    .filter(([spelling]) => spelling !== "");
  if (!entries.length) return "";
  const merged = new Map<string, number>();
  for (const [spelling, n] of entries) merged.set(spelling, (merged.get(spelling) ?? 0) + n);
  const state = [...merged.keys()].find(sp => CANONICAL_BY_KEY.get(stateKey(sp)) === sp);
  if (state) return state;
  const spaces = (x: string) => (x.match(/\s/g) ?? []).length;
  return [...merged.entries()].sort(([a, na], [b, nb]) =>
    nb - na
    || Number(a === a.toLowerCase()) - Number(b === b.toLowerCase())
    || spaces(a) - spaces(b)
    || a.localeCompare(b),
  )[0][0];
}

/**
 * The geography choices for a dropdown or a grouping: one entry per geography
 * however many spellings it has, labelled with its preferred spelling, sorted
 * without regard to case (a plain sort put "kolkata" after "Vadodara" and "MP"
 * before "Madhya pradesh").
 */
export function geographyOptions(values: Iterable<string | null | undefined>): Array<{ key: string; label: string }> {
  const groups = new Map<string, Map<string, number>>();
  for (const raw of values) {
    const text = tidyText(raw);
    if (!text) continue;
    const key = geographyKey(text);
    const group = groups.get(key) ?? new Map<string, number>();
    group.set(text, (group.get(text) ?? 0) + 1);
    groups.set(key, group);
  }
  return [...groups.entries()]
    .map(([key, counts]) => ({ key, label: preferredGeographySpelling(counts) }))
    .sort((a, b) => a.label.localeCompare(b.label, "en", { sensitivity: "base" }));
}
