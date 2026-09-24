/* ═══════════════════════════════════════════════════════════════════════════
   GOVERNANCE MANIFEST VALIDATOR — the gate between a human decision and a
   database mutation.

   READ ONLY. It opens the database with the session set READ ONLY, reads the
   reviewed workbook, and answers exactly one question:

       READY_FOR_MIGRATION   or   BLOCKED

   It never writes, never infers a scope, never invents a serial, and never
   resolves an ambiguity on anybody's behalf. A blank decision is a block, not
   a default.

   Usage:  npx tsx scripts/validate-governance-manifest.mjs [workbook.xlsx]
   ═══════════════════════════════════════════════════════════════════════════ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import * as XLSX from 'xlsx';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WB   = process.argv[2] ?? path.join(ROOT, 'docs/governance/Asset_Reconciliation_Workbook.xlsx');

const MIGRATABLE = new Set(['CONFIRM_EXISTING', 'CONFIRM_NEW', 'CONFIRM_POOLED']);
const BLOCKING   = new Set(['IDENTITY_DECISION_REQUIRED', 'PHYSICAL_VERIFICATION',
                            'SCOPE_DECISION_REQUIRED', 'PENDING', 'REQUIRES_REVIEW']);
/* Values seen in the source sequence column that are NOT manufacturer serials
   unless a human says otherwise, in writing. */
const NEVER_A_SERIAL = /^(manav|jovian|tour)$/i;

const blocks = [];
const block = (row, item, reason, action) => blocks.push({ row, item, reason, action });
const txt = v => String(v ?? '').trim();

/* ── load ─────────────────────────────────────────────────────────────────── */
if (!fs.existsSync(WB)) { console.error(`workbook not found: ${WB}`); process.exit(2); }
const wb = XLSX.read(fs.readFileSync(WB), { type: 'buffer' });
const sheet = n => XLSX.utils.sheet_to_json(wb.Sheets[n] ?? {}, { defval: '' });
const master = sheet('01_Master_Reconciliation');
const scopes = sheet('08_Scope_Approval');
const dupes  = sheet('02_Duplicate_Risks');
const poss   = sheet('03_Possible_Matches');

/* ── database, read only ──────────────────────────────────────────────────── */
const env = Object.fromEntries(fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8')
  .split('\n').filter(l => l.includes('=') && !l.trim().startsWith('#'))
  .map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).replace(/^["']|["']$/g, '')]));
const pool = new pg.Pool({ connectionString: env.DATABASE_URL, connectionTimeoutMillis: 5000, max: 2 });
const db = await pool.connect();
await db.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY');
const countsSql = `SELECT
  (SELECT COUNT(*)::int FROM mo_equipment_items) a, (SELECT COUNT(*)::int FROM mo_equipment_transactions) t,
  (SELECT COUNT(*)::int FROM mo_equipment_bookings) b, (SELECT COUNT(*)::int FROM mo_maintenance_records) m,
  (SELECT COUNT(*)::int FROM mo_inventory_scopes) s, (SELECT COUNT(*)::int FROM mo_user_inventory_scopes) u,
  (SELECT COUNT(*)::int FROM mo_audit_logs) l`;
const before = (await db.query(countsSql)).rows[0];

const assets = new Map();
for (const r of (await db.query(
  `SELECT id, asset_tag, make, model, status, retired_at, deleted_at FROM mo_equipment_items`)).rows)
  assets.set(String(r.id), r);
const tags = new Set([...assets.values()].map(a => a.asset_tag));
const pooledCats = (await db.query(
  `SELECT name FROM mo_equipment_categories WHERE tracking_mode='pooled'`)).rows.map(r => r.name);

/* ── GATE A — the inventories must be approved, explicitly ────────────────── */
const approved = new Set();
if (!scopes.length) block('08', 'Scope approval sheet', 'sheet 08_Scope_Approval is missing or empty',
  'restore the workbook produced by Phase 16C');
for (const s of scopes) {
  const name = txt(s['Proposed Scope']);
  const ok = /^(yes|approved)$/i.test(txt(s['Approved?']));
  const by = txt(s['Approved By']), on = txt(s['Date']);
  if (!ok) block('08', name, `scope approval is "${txt(s['Approved?']) || '(blank)'}", not an explicit approval`,
    'Media Ops leadership must set Approved? = YES on sheet 08 (decision P-1)');
  else if (!by || !on) block('08', name,
    `approved without ${!by ? 'an approver' : ''}${!by && !on ? ' or ' : ''}${!on ? 'a date' : ''}`,
    'record Approved By and Date on sheet 08');
  else approved.add(name);
}

/* ── GATE B — every row must carry a final human decision ─────────────────── */
const decided = [];
for (const r of master) {
  const row = txt(r['Source Row']), name = txt(r['Source Equipment Name']);
  const d = txt(r['Decision']).toUpperCase();
  const proposal = txt(r['PRIMARY DECISION STATE']);
  if (!d) {
    block(row, name, `no human decision recorded (machine proposal was ${proposal})`,
      proposal === 'PHYSICAL_VERIFICATION' ? 'verify the physical item on sheet 02/03, then write CONFIRM_EXISTING or CONFIRM_NEW in Decision'
      : proposal === 'IDENTITY_DECISION_REQUIRED' ? 'settle identity on sheet 04/05, then write a decision in Decision'
      : 'confirm on sheet 06/07, then write the decision in Decision');
    continue;
  }
  if (BLOCKING.has(d)) { block(row, name, `decision is "${d}", which blocks migration`,
    'replace with CONFIRM_EXISTING, CONFIRM_NEW or CONFIRM_POOLED once settled'); continue; }
  if (!MIGRATABLE.has(d)) { block(row, name, `decision "${d}" is not a recognised final state`,
    'use exactly one of CONFIRM_EXISTING, CONFIRM_NEW, CONFIRM_POOLED'); continue; }
  if (!txt(r['Decided By']) || !txt(r['Decision Date']))
    block(row, name, 'decision recorded without a decider or a date', 'fill Decided By and Decision Date');
  decided.push({ r, row, name, d });
}

/* ── GATE H — approved scope on every migrating row ───────────────────────── */
for (const { r, row, name } of decided) {
  const sc = txt(r['Proposed Scope']);
  if (!sc) block(row, name, 'no scope on the row', 'set the inventory on sheet 01');
  else if (!approved.has(sc))
    block(row, name, `scope "${sc}" is not an approved inventory`, 'approve it on sheet 08, or correct the row');
}

/* ── GATE C — CONFIRM_EXISTING ────────────────────────────────────────────── */
const claimed = new Map();
for (const { r, row, name, d } of decided.filter(x => x.d === 'CONFIRM_EXISTING')) {
  const raw = txt(r['Candidate Nerve Asset ID']);
  if (!raw) { block(row, name, 'CONFIRM_EXISTING without an existing Nerve asset id',
    'name the asset on sheet 02/03 and copy its id into Candidate Nerve Asset ID'); continue; }
  if (raw.includes('|')) { block(row, name, `several candidate ids still listed (${raw}) — the unit was never chosen`,
    'resolve to exactly one asset id after physical verification'); continue; }
  const a = assets.get(raw);
  if (!a) { block(row, name, `asset id ${raw} does not exist`, 'correct the id'); continue; }
  if (a.deleted_at || a.retired_at)
    block(row, name, `asset ${a.asset_tag} is ${a.deleted_at ? 'deleted' : 'retired'}`,
      'confirm this is intended, or choose the live unit');
  if (!claimed.has(raw)) claimed.set(raw, []);
  claimed.get(raw).push({ row, name });
}
for (const [id, rows] of claimed)
  if (rows.length > 1)
    block(rows.map(x => x.row).join(', '), assets.get(id)?.asset_tag ?? id,
      `${rows.length} source rows claim the same physical asset (${rows.map(x => x.name).join(' / ')})`,
      'one physical asset can be claimed by exactly one source row');

/* ── GATE D — CONFIRM_NEW ─────────────────────────────────────────────────── */
const newCodes = new Map();
for (const { r, row, name } of decided.filter(x => x.d === 'CONFIRM_NEW')) {
  const code = txt(r['Proposed Internal Asset Code']);
  for (const [field, val] of [['inventory', txt(r['Inventory'])], ['equipment name', name],
                              ['tracking model', txt(r['Tracking Model'])], ['internal asset code', code]])
    if (!val) block(row, name, `CONFIRM_NEW missing ${field}`, `supply ${field} on sheet 01/06`);
  if (code) {
    if (!newCodes.has(code)) newCodes.set(code, []);
    newCodes.get(code).push(row);
    if (tags.has(code)) block(row, name, `internal asset code ${code} collides with an existing asset tag`,
      'choose a code that is not already an asset tag');
  }
  if (txt(r['Candidate Nerve Asset ID']))
    block(row, name, 'CONFIRM_NEW still names an existing asset id',
      'clear Candidate Nerve Asset ID, or change the decision to CONFIRM_EXISTING');
  const serial = txt(r['Manufacturer Serial']);
  if (serial && NEVER_A_SERIAL.test(serial))
    block(row, name, `"${serial}" was written into Manufacturer Serial`,
      'this is a source reference, not a serial — clear it unless a human has confirmed otherwise in Notes');
  if (serial && serial === txt(r['Source Sequence']))
    block(row, name, `Manufacturer Serial equals the source sequence ("${serial}")`,
      'the Sr. No column is a sequence, not a serial');
}
for (const [code, rows] of newCodes)
  if (rows.length > 1) block(rows.join(', '), code, `${rows.length} approved NEW rows share the internal asset code ${code}`,
    'internal asset codes must be unique');

/* ── GATE E — CONFIRM_POOLED ──────────────────────────────────────────────── */
if (!pooledCats.length && decided.some(x => x.d === 'CONFIRM_POOLED'))
  block('—', 'pooled inventory', 'no equipment category has tracking_mode = pooled',
    'these rows cannot be represented safely — migrate them separately once a pooled category exists');
for (const { r, row, name } of decided.filter(x => x.d === 'CONFIRM_POOLED')) {
  const q = Number(txt(r['Quantity']));
  if (!txt(r['Quantity']) || !Number.isFinite(q) || q <= 0)
    block(row, name, `pooled row with quantity "${txt(r['Quantity']) || '(blank)'}"`,
      'confirm the count on sheet 07');
  if (txt(r['Tracking Model']).toUpperCase() !== 'POOLED')
    block(row, name, `decision is CONFIRM_POOLED but tracking model is "${txt(r['Tracking Model'])}"`,
      'set tracking model to POOLED');
}

/* ── GATE F — the duplicate cases must be named and resolved ──────────────── */
const unresolvedDupes = dupes.filter(d => !/^(existing asset|new physical asset)$/i.test(txt(d['Verification Result'])));
for (const d of unresolvedDupes)
  block(txt(d['Source Row']), txt(d['Source Name']),
    `duplicate identity unresolved against ${txt(d['Candidate Nerve Asset Tag'])}`,
    `physical verification against ${txt(d['Candidate Nerve Asset Tag'])} (${txt(d['Candidate Current Status'])})`);
const unresolvedPoss = poss.filter(d => !/^(existing asset|new physical asset)$/i.test(txt(d['Verification Result'])));
for (const d of unresolvedPoss)
  block(txt(d['Source Row']), txt(d['Source Name']),
    `possible match unresolved against ${txt(d['Candidate Nerve Asset Tag'])}`,
    `confirm EXISTING ASSET or NEW PHYSICAL ASSET on sheet 03`);

/* ── report ───────────────────────────────────────────────────────────────── */
const after = (await db.query(countsSql)).rows[0];
const mutations = Object.keys(before).filter(k => before[k] !== after[k]);
db.release(); await pool.end();

const verdict = blocks.length === 0 && mutations.length === 0 ? 'READY_FOR_MIGRATION' : 'BLOCKED';
const out = {
  verdict, workbook: WB, checked_at: new Date().toISOString(),
  rows_in_manifest: master.length,
  approved_inventories: [...approved],
  decisions: decided.reduce((m, x) => (m[x.d] = (m[x.d] ?? 0) + 1, m), {}),
  rows_without_a_decision: master.length - decided.length,
  block_count: blocks.length,
  blocks,
  database_mutations: mutations.length,
  counts_before: before, counts_after: after,
  pooled_categories_available: pooledCats,
};
fs.writeFileSync(path.join(ROOT, 'docs/governance/Asset_Governance_Validation_Result.json'),
  JSON.stringify(out, null, 2), 'utf8');

console.log(`\n${verdict}\n`);
console.log(`  workbook                 ${path.basename(WB)}`);
console.log(`  rows in manifest         ${master.length}`);
console.log(`  approved inventories     ${[...approved].join(', ') || '(none)'}`);
console.log(`  rows with a decision     ${decided.length}`);
console.log(`  rows without a decision  ${master.length - decided.length}`);
console.log(`  database mutations       ${mutations.length}`);
console.log(`  blocking findings        ${blocks.length}`);
if (blocks.length) {
  const grouped = new Map();
  for (const b of blocks) {
    const k = b.reason.replace(/\d+/g, 'N').replace(/"[^"]*"/g, '"…"');
    if (!grouped.has(k)) grouped.set(k, []);
    grouped.get(k).push(b);
  }
  console.log('\n  BLOCKING REASONS, grouped:');
  for (const [k, list] of [...grouped].sort((a, b) => b[1].length - a[1].length))
    console.log(`    ${String(list.length).padStart(4)}  ${k}`);
}
process.exit(verdict === 'READY_FOR_MIGRATION' ? 0 : 1);
