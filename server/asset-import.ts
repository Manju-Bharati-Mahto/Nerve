/* ═══════════════════════════════════════════════════════════════════════════
   ASSET IMPORT — PARSING, NORMALISATION, CLASSIFICATION AND MATCHING
   Phase 17L.

   THE SPREADSHEET IS NOT AUTHORITATIVE. Everything in this module produces
   PROPOSALS: a category it thinks a row means, an inventory it thinks a heading
   names, a list of assets a row might already be. Nothing here decides
   anything, and nothing here writes to the database. A human decides, and the
   endpoint records what they decided.

   That distinction is the whole phase. The Phase 16B audit found what happens
   when inference is trusted: a "Canon 1500DII charger" classified as a camera
   body because the model matched first, and "SONY C2" matched against three
   lenses on a shared digit. Those are not bugs in a regex, they are what
   guessing looks like when it is allowed to be the answer.

   Pure functions, no I/O, so the rules can be tested without a database.
   ═══════════════════════════════════════════════════════════════════════════ */

/** A row exactly as the sheet gave it, before anything is interpreted. */
export interface SourceRow {
  row: number;                 // 1-based line in the source, for provenance
  name: string;
  inventory: string | null;
  srNo: string | null;         // the sheet's own sequence column — NEVER a serial
  quantity: string | null;
  serial: string | null;       // only when the sheet really carries one
}

export interface CategoryRef { id: number; name: string }
export interface ScopeRef { id: number; code: string; name: string }

/** What an existing asset looks like to the matcher. */
export interface AssetRef {
  id: number; asset_tag: string; internal_code: string | null;
  make: string | null; model: string | null; serial_no: string | null;
  category_id: number | null; scope_id: number | null;
}

export type Confidence = "EXACT" | "HIGH" | "POSSIBLE" | "NONE";
export interface Candidate { asset_id: number; asset_tag: string; confidence: Confidence; why: string }

export type RowState =
  | "pending_review" | "identity_decision_required" | "physical_verification"
  | "pooled_review" | "scope_decision_required" | "category_review_required";

export interface NormalizedRow {
  source: SourceRow;
  normalizedName: string;
  categoryId: number | null;
  scopeId: number | null;
  trackingMode: "individual" | "pooled" | null;
  quantity: number | null;
  serialNo: string | null;
  warnings: string[];
  candidates: Candidate[];
  state: RowState;
}

/* ── Normalisation ────────────────────────────────────────────────────────
   Whitespace, case and the punctuation people type differently on different
   days. Nothing that changes meaning. */
export function normalizeName(raw: string): string {
  return String(raw ?? "")
    .replace(/[‘’“”]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}
const key = (s: string) => normalizeName(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/* ── Category ─────────────────────────────────────────────────────────────
   ACCESSORY WORDS ARE CHECKED FIRST, and that order is the entire lesson of
   the Phase 16B audit. "Canon 1500DII charger" contains a camera model and is
   a charger; "battery grip" contains a battery and is an accessory. A matcher
   that scores the model name first gets both wrong, confidently.

   A row that does not match a REGISTERED category is flagged, never invented:
   the registry is the product's list of what kinds of thing exist, and adding
   to it is a decision, not a side effect of an upload. */
const ACCESSORY_FIRST: [RegExp, string[]][] = [
  [/\b(charger|adapter|adaptor|power\s*supply|psu)\b/i,       ["Accessory"]],
  [/\b(battery|batteries|batt|cell)\b/i,                      ["Battery", "Accessory"]],
  [/\b(memory\s*card|sd\s*card|cf\s*card|xqd|cfexpress)\b/i,  ["Memory Card", "Accessory"]],
  [/\b(bag|case|pouch|strap|cable|cord|clamp|plate|mount)\b/i,["Accessory"]],
];
const BY_KIND: [RegExp, string[]][] = [
  /* `\bmm\b` does not match "24-70mm": the m is preceded by a digit, so there
     is no word boundary. A focal length is a number followed by mm, which is
     what this says. */
  [/\blens\b|\d\s*mm\b|\bf\/?\d|\bprime\b|\bzoom\b/i,             ["Lens"]],
  [/\b(tripod|monopod|gimbal|stabili[sz]er|slider|rig)\b/i,   ["Tripod / Support", "Gimbal"]],
  [/\b(mic|microphone|lav|lavalier|shotgun|boom)\b/i,         ["Microphone"]],
  [/\b(recorder|audio\s*recorder|zoom\s*h\d)\b/i,             ["Audio Recorder"]],
  [/\b(light|led|softbox|flash|strobe|reflector)\b/i,         ["Light"]],
  [/\b(drone|mavic|phantom|air\s*\d)\b/i,                     ["Drone"]],
  [/\b(camera|body|dslr|mirrorless|fx\d|a7|alpha|eos|α)\b/i, ["Camera Body"]],
];

export function proposeCategory(name: string, registry: CategoryRef[]): CategoryRef | null {
  const find = (names: string[]) =>
    registry.find((c) => names.some((n) => key(c.name) === key(n))) ?? null;
  for (const [re, names] of ACCESSORY_FIRST) if (re.test(name)) { const c = find(names); if (c) return c; }
  for (const [re, names] of BY_KIND)         if (re.test(name)) { const c = find(names); if (c) return c; }
  return null;
}

/* ── Inventory ────────────────────────────────────────────────────────────
   Only headings that name an EXISTING approved inventory map to one. An
   unknown heading is a question for a person, not a new scope. */
export function proposeScope(heading: string | null, scopes: ScopeRef[]): ScopeRef | null {
  if (!heading) return null;
  const k = key(heading);
  return scopes.find((s) => key(s.name) === k || key(s.code) === k
    || key(s.code).replace(/ /g, "") === k.replace(/ /g, "")) ?? null;
}

/* ── Quantity and tracking ────────────────────────────────────────────────
   A quantity above one is a POOL CANDIDATE, not a pool: forty-eight batteries
   might be one pooled row or forty-eight tracked units, and only somebody who
   has seen them knows. It is flagged for review either way. */
export function proposeQuantity(raw: string | null): { quantity: number | null; bad: boolean } {
  if (raw == null || String(raw).trim() === "") return { quantity: null, bad: false };
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) return { quantity: null, bad: true };
  return { quantity: n, bad: false };
}

/* ── Matching ─────────────────────────────────────────────────────────────
   ADVISORY. Every candidate is a reason to look, never a reason to merge.
   A manufacturer serial names one physical unit worldwide, so an exact serial
   match is EXACT; everything else is weaker, and POSSIBLE means "these share a
   name" — which in this estate is true of eleven cameras. */
export function findCandidates(row: SourceRow, normalized: string, assets: AssetRef[]): Candidate[] {
  const out: Candidate[] = [];
  const nk = key(normalized);
  const serial = row.serial?.trim() || null;

  for (const a of assets) {
    if (serial && a.serial_no && key(a.serial_no) === key(serial)) {
      out.push({ asset_id: a.id, asset_tag: a.asset_tag, confidence: "EXACT",
                 why: "Manufacturer serial matches exactly" });
      continue;
    }
    if (a.internal_code && key(a.internal_code) === nk) {
      out.push({ asset_id: a.id, asset_tag: a.asset_tag, confidence: "EXACT",
                 why: "Internal code matches exactly" });
      continue;
    }
    const full = key(`${a.make ?? ""} ${a.model ?? ""}`);
    if (full && full === nk) {
      out.push({ asset_id: a.id, asset_tag: a.asset_tag, confidence: "HIGH",
                 why: "Make and model match exactly" });
      continue;
    }
    /* A shared MODEL is a reason to look. It is never more than that: the
       estate holds several of most things. */
    if (a.model && nk.includes(key(a.model)) && key(a.model).length >= 3) {
      out.push({ asset_id: a.id, asset_tag: a.asset_tag, confidence: "POSSIBLE",
                 why: `Name contains the model “${a.model}”` });
    }
  }
  const rank: Record<Confidence, number> = { EXACT: 0, HIGH: 1, POSSIBLE: 2, NONE: 3 };
  return out.sort((x, y) => rank[x.confidence] - rank[y.confidence]).slice(0, 8);
}

/* ── Classification ───────────────────────────────────────────────────────
   Which question the row poses to a reviewer. The states are ordered by how
   blocking they are: an unknown inventory cannot be resolved by deciding the
   category, so it is asked first. */
export function classify(n: Omit<NormalizedRow, "state">): RowState {
  if (!n.scopeId) return "scope_decision_required";
  if (!n.categoryId) return "category_review_required";
  const exactOrHigh = n.candidates.filter((c) => c.confidence === "EXACT" || c.confidence === "HIGH");
  if (exactOrHigh.length) return "identity_decision_required";
  /* More than one asset shares this name, so the sheet cannot say which — or
     whether it is a new one. Somebody has to look at the shelf. */
  if (n.candidates.filter((c) => c.confidence === "POSSIBLE").length > 1) return "physical_verification";
  if (n.candidates.length === 1 && n.candidates[0].confidence === "POSSIBLE")
    return "identity_decision_required";
  if (n.trackingMode === "pooled" || (n.quantity ?? 1) > 1) return "pooled_review";
  return "pending_review";
}

/** One source row, interpreted. Proposals and questions; no decisions. */
export function normalizeRow(
  src: SourceRow, categories: CategoryRef[], scopes: ScopeRef[], assets: AssetRef[],
): NormalizedRow {
  const warnings: string[] = [];
  const normalizedName = normalizeName(src.name);
  if (!normalizedName) warnings.push("The equipment name is empty.");

  const scope = proposeScope(src.inventory, scopes);
  if (!scope) warnings.push(src.inventory
    ? `“${src.inventory}” is not an approved inventory.`
    : "No inventory was given for this row.");

  const category = proposeCategory(normalizedName, categories);
  if (!category) warnings.push("No category could be proposed with confidence.");

  const { quantity, bad } = proposeQuantity(src.quantity);
  if (bad) warnings.push(`“${src.quantity}” is not a whole quantity.`);

  /* THE SEQUENCE COLUMN IS NOT A SERIAL. It is preserved as provenance and
     never becomes manufacturer_serial — the identity contract is explicit, and
     this is the single line where that rule would otherwise be broken. */
  const serialNo = src.serial?.trim() ? src.serial.trim() : null;
  if (!serialNo && src.srNo) warnings.push("No manufacturer serial in the source (the Sr. No column is a row counter).");

  const candidates = findCandidates(src, normalizedName, assets);
  const base = {
    source: src, normalizedName,
    categoryId: category?.id ?? null, scopeId: scope?.id ?? null,
    trackingMode: (quantity != null && quantity > 1 ? "pooled" : "individual") as "individual" | "pooled",
    quantity, serialNo, warnings, candidates,
  };
  return { ...base, state: classify(base) };
}

/* ── Parsing ──────────────────────────────────────────────────────────────
   HEADERS ARE MATCHED, NOT TRUSTED. The sheet the team actually keeps has
   headings that vary by who last edited it, so a small set of accepted spellings
   is recognised and anything else is ignored rather than guessed at. */
const HEADER_ALIASES: Record<keyof Omit<SourceRow, "row">, string[]> = {
  name:      ["equipment name", "equipment", "item", "name", "particulars", "description"],
  inventory: ["inventory", "section", "department", "location", "scope"],
  srNo:      ["sr no", "sr. no", "srno", "sl no", "s no", "serial no.", "sequence"],
  quantity:  ["quantity", "qty", "nos", "count", "units"],
  serial:    ["manufacturer serial", "serial number", "machine serial", "device serial"],
};

export interface ParseResult { rows: SourceRow[]; headers: string[]; error: string | null }

/** Turn header-keyed objects into source rows. The caller does the file I/O. */
export function rowsFromRecords(records: Record<string, unknown>[]): ParseResult {
  if (!records.length) return { rows: [], headers: [], error: "The file has no rows." };
  const headers = Object.keys(records[0]);
  const lookup: Partial<Record<keyof Omit<SourceRow, "row">, string>> = {};
  for (const [field, aliases] of Object.entries(HEADER_ALIASES) as [keyof Omit<SourceRow, "row">, string[]][]) {
    const hit = headers.find((h) => aliases.includes(key(h)));
    if (hit) lookup[field] = hit;
  }
  if (!lookup.name)
    return { rows: [], headers, error: "No equipment-name column was found. Expected one of: "
      + HEADER_ALIASES.name.join(", ") + "." };

  /* CELLS ARE DATA. A value beginning with = is a formula to a spreadsheet and
     a string here; nothing is evaluated, and the text is kept as written so a
     reviewer sees exactly what the sheet contains. */
  const cell = (r: Record<string, unknown>, h?: string) => {
    if (!h) return null;
    const v = r[h];
    if (v == null) return null;
    const t = String(v).trim();
    return t === "" ? null : t.slice(0, 500);
  };
  const rows: SourceRow[] = [];
  records.forEach((r, i) => {
    const name = cell(r, lookup.name);
    if (!name) return;                       // blank spacer lines are not rows
    rows.push({ row: i + 2,                  // +2: 1-based, and the header is line 1
      name, inventory: cell(r, lookup.inventory), srNo: cell(r, lookup.srNo),
      quantity: cell(r, lookup.quantity), serial: cell(r, lookup.serial) });
  });
  if (!rows.length) return { rows: [], headers, error: "No rows carried an equipment name." };
  return { rows, headers, error: null };
}
