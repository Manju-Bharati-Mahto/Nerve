/**
 * BrandOps domain operations.
 *
 * The rules that matter live here rather than in the HTTP layer, so they hold
 * however they're reached. Three in particular:
 *
 *   1. A frame can be in one place at a time. Allocation is guarded by a
 *      partial unique index AND a transaction, not by a status check that two
 *      concurrent requests could both pass.
 *   2. Approving a quotation rejects its siblings. "Approved" means chosen,
 *      and leaving the others pending would let two be approved in sequence.
 *   3. A work order exists only downstream of an approved quotation, and
 *      cannot be verified before the work is marked complete.
 *
 * Every mutation writes an activity row. That is deliberate duplication of
 * effort at each call site rather than a trigger, because the log is meant to
 * read in human terms ("PU-BR-014 allocated to PIET for Orientation"), which
 * the database cannot compose.
 */
import { pool } from "./db.js";
import {
  boId, assetIdFor, DEFAULT_STORE_LOCATION,
  type FrameStatus, type RequestStatus, type QuoteStatus,
  type WorkOrderStatus, type PhotoPhase, type DeliveryStatus, type Priority,
} from "./brandops-db.js";

export class BoError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "BoError";
  }
}
const bad = (m: string) => new BoError(400, m);
const missing = (m: string) => new BoError(404, m);
const conflict = (m: string) => new BoError(409, m);

export interface Actor { id: string; full_name?: string | null; email?: string | null }

// ── Activity ───────────────────────────────────────────────────────────────

export async function logActivity(
  actor: Actor | null,
  module: string,
  action: string,
  details: string,
  entity: { type?: string; id?: string } = {},
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO bo_activity (id, actor_id, actor_name, actor_email, module, action, details, entity_type, entity_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [boId("act"), actor?.id ?? null, actor?.full_name ?? "", actor?.email ?? "",
        module, action, details, entity.type ?? "", entity.id ?? ""],
    );
  } catch {
    // The log must never break the action it is describing.
  }
}

export interface ActivityRow {
  id: string; actor_name: string; actor_email: string; module: string;
  action: string; details: string; entity_type: string; entity_id: string; created_at: string;
}

export async function listActivity(filter: {
  module?: string; q?: string; from?: string; to?: string; limit?: number;
} = {}): Promise<ActivityRow[]> {
  const where: string[] = [];
  const args: unknown[] = [];
  if (filter.module) { args.push(filter.module); where.push(`module = $${args.length}`); }
  if (filter.q) { args.push(`%${filter.q.toLowerCase()}%`); where.push(`(LOWER(action) LIKE $${args.length} OR LOWER(details) LIKE $${args.length} OR LOWER(actor_name) LIKE $${args.length})`); }
  if (filter.from) { args.push(filter.from); where.push(`created_at >= $${args.length}::date`); }
  if (filter.to) { args.push(filter.to); where.push(`created_at < ($${args.length}::date + INTERVAL '1 day')`); }
  args.push(Math.min(Math.max(filter.limit ?? 200, 1), 1000));
  const { rows } = await pool.query<ActivityRow>(
    `SELECT id, actor_name, actor_email, module, action, details, entity_type, entity_id, created_at
       FROM bo_activity ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY created_at DESC LIMIT $${args.length}`, args);
  return rows;
}

export async function clearActivity(actor: Actor): Promise<number> {
  const { rowCount } = await pool.query(`DELETE FROM bo_activity`);
  await logActivity(actor, "Activity", "Activity log cleared", `${rowCount ?? 0} entries removed`);
  return rowCount ?? 0;
}

// ── Institutes ─────────────────────────────────────────────────────────────

export interface Institute {
  id: string; name: string; faculty: string; active: boolean;
  created_at: string; frames_in_use: number;
}

export async function listInstitutes(): Promise<Institute[]> {
  const { rows } = await pool.query<Institute>(
    `SELECT i.id, i.name, i.faculty, i.active, i.created_at,
            COALESCE(f.c, 0)::int AS frames_in_use
       FROM bo_institutes i
       LEFT JOIN (
         SELECT institute_id, COUNT(*) AS c FROM bo_frames
          WHERE status = 'in_use' GROUP BY institute_id
       ) f ON f.institute_id = i.id
      ORDER BY i.faculty, i.name`);
  return rows;
}

export async function createInstitute(actor: Actor, name: string, faculty: string): Promise<Institute> {
  const trimmed = name.trim();
  if (!trimmed) throw bad("An institute name is required.");
  const exists = await pool.query(`SELECT 1 FROM bo_institutes WHERE LOWER(name) = LOWER($1)`, [trimmed]);
  if (exists.rowCount) throw conflict("That institute already exists.");
  const id = boId("inst");
  await pool.query(`INSERT INTO bo_institutes (id, name, faculty) VALUES ($1,$2,$3)`,
    [id, trimmed, faculty.trim() || "Parul University"]);
  await logActivity(actor, "Institutes", "Institute added", trimmed, { type: "institute", id });
  return (await listInstitutes()).find(i => i.id === id) as Institute;
}

export async function updateInstitute(actor: Actor, id: string, patch: { name?: string; faculty?: string; active?: boolean }): Promise<void> {
  const cur = await pool.query<{ name: string }>(`SELECT name FROM bo_institutes WHERE id = $1`, [id]);
  if (!cur.rowCount) throw missing("That institute was not found.");
  await pool.query(
    `UPDATE bo_institutes SET name = COALESCE($2, name), faculty = COALESCE($3, faculty), active = COALESCE($4, active)
      WHERE id = $1`,
    [id, patch.name?.trim() || null, patch.faculty?.trim() || null, patch.active ?? null]);
  await logActivity(actor, "Institutes", "Institute updated", patch.name?.trim() || cur.rows[0].name, { type: "institute", id });
}

/**
 * Refuses while frames are out. Removing an institute that still physically
 * holds branding assets would orphan them — the frames are the point.
 */
export async function deleteInstitute(actor: Actor, id: string): Promise<void> {
  const inst = await pool.query<{ name: string }>(`SELECT name FROM bo_institutes WHERE id = $1`, [id]);
  if (!inst.rowCount) throw missing("That institute was not found.");
  const held = await pool.query<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM bo_frames WHERE institute_id = $1 AND status = 'in_use'`, [id]);
  const n = Number(held.rows[0]?.c ?? "0");
  if (n > 0) throw conflict(`${inst.rows[0].name} still holds ${n} frame${n === 1 ? "" : "s"}. Receive them back first.`);
  try {
    await pool.query(`DELETE FROM bo_institutes WHERE id = $1`, [id]);
  } catch {
    throw conflict("That institute is referenced by existing requirements or deliveries, so it can't be deleted. Mark it inactive instead.");
  }
  await logActivity(actor, "Institutes", "Institute removed", inst.rows[0].name, { type: "institute", id });
}

// ── Vendors ────────────────────────────────────────────────────────────────

export interface Vendor { id: string; name: string; phone: string; address: string; active: boolean; created_at: string }

export async function listVendors(): Promise<Vendor[]> {
  const { rows } = await pool.query<Vendor>(`SELECT * FROM bo_vendors ORDER BY name`);
  return rows;
}

export async function createVendor(actor: Actor, v: { name: string; phone: string; address: string }): Promise<Vendor> {
  const name = v.name.trim();
  if (!name) throw bad("A vendor name is required.");
  if (!v.phone.trim()) throw bad("A phone number is required.");
  const id = boId("ven");
  await pool.query(`INSERT INTO bo_vendors (id, name, phone, address) VALUES ($1,$2,$3,$4)`,
    [id, name, v.phone.trim(), v.address.trim()]);
  await logActivity(actor, "Vendors", "Vendor added", name, { type: "vendor", id });
  const { rows } = await pool.query<Vendor>(`SELECT * FROM bo_vendors WHERE id = $1`, [id]);
  return rows[0];
}

export async function updateVendor(actor: Actor, id: string, patch: Partial<{ name: string; phone: string; address: string; active: boolean }>): Promise<void> {
  const cur = await pool.query(`SELECT 1 FROM bo_vendors WHERE id = $1`, [id]);
  if (!cur.rowCount) throw missing("That vendor was not found.");
  await pool.query(
    `UPDATE bo_vendors SET name = COALESCE($2,name), phone = COALESCE($3,phone),
            address = COALESCE($4,address), active = COALESCE($5,active) WHERE id = $1`,
    [id, patch.name?.trim() || null, patch.phone?.trim() || null, patch.address?.trim() ?? null, patch.active ?? null]);
  await logActivity(actor, "Vendors", "Vendor updated", patch.name?.trim() ?? id, { type: "vendor", id });
}

export async function deleteVendor(actor: Actor, id: string): Promise<void> {
  const v = await pool.query<{ name: string }>(`SELECT name FROM bo_vendors WHERE id = $1`, [id]);
  if (!v.rowCount) throw missing("That vendor was not found.");
  try {
    await pool.query(`DELETE FROM bo_vendors WHERE id = $1`, [id]);
  } catch {
    throw conflict("That vendor appears on existing quotations or work orders, so it can't be deleted. Mark it inactive instead.");
  }
  await logActivity(actor, "Vendors", "Vendor removed", v.rows[0].name, { type: "vendor", id });
}

// ── Frames ─────────────────────────────────────────────────────────────────

export interface Frame {
  id: string; asset_id: string; size: string; status: FrameStatus; condition: string;
  location: string; institute_id: string | null; institute_name: string | null;
  notes: string; created_at: string; updated_at: string;
  event: string | null; from_date: string | null; until_date: string | null;
}

const FRAME_SELECT = `
  SELECT f.id, f.asset_id, f.size, f.status, f.condition, f.location, f.institute_id,
         i.name AS institute_name, f.notes, f.created_at, f.updated_at,
         a.event, a.from_date::text AS from_date, a.until_date::text AS until_date
    FROM bo_frames f
    LEFT JOIN bo_institutes i ON i.id = f.institute_id
    LEFT JOIN bo_frame_allocations a ON a.frame_id = f.id AND a.returned_at IS NULL`;

export async function listFrames(filter: { q?: string; status?: FrameStatus; size?: string; instituteId?: string } = {}): Promise<Frame[]> {
  const where: string[] = [`f.status <> 'retired'`];
  const args: unknown[] = [];
  if (filter.status) { args.push(filter.status); where.push(`f.status = $${args.length}`); }
  if (filter.size) { args.push(filter.size); where.push(`f.size = $${args.length}`); }
  if (filter.instituteId) { args.push(filter.instituteId); where.push(`f.institute_id = $${args.length}`); }
  if (filter.q) {
    args.push(`%${filter.q.toLowerCase()}%`);
    where.push(`(LOWER(f.asset_id) LIKE $${args.length} OR LOWER(f.size) LIKE $${args.length}
      OR LOWER(f.location) LIKE $${args.length} OR LOWER(COALESCE(i.name,'')) LIKE $${args.length}
      OR LOWER(COALESCE(a.event,'')) LIKE $${args.length})`);
  }
  const { rows } = await pool.query<Frame>(
    `${FRAME_SELECT} WHERE ${where.join(" AND ")} ORDER BY f.asset_id`, args);
  return rows;
}

export async function getFrame(id: string): Promise<Frame | null> {
  const { rows } = await pool.query<Frame>(`${FRAME_SELECT} WHERE f.id = $1 OR f.asset_id = $1`, [id]);
  return rows[0] ?? null;
}

export async function frameSizes(): Promise<string[]> {
  const { rows } = await pool.query<{ size: string }>(
    `SELECT DISTINCT size FROM bo_frames WHERE status <> 'retired' ORDER BY size`);
  return rows.map(r => r.size);
}

/** Next free PU-BR-nnn, so the UI can suggest one without the user guessing. */
export async function nextAssetId(): Promise<string> {
  const { rows } = await pool.query<{ max: string | null }>(
    `SELECT MAX(NULLIF(regexp_replace(asset_id, '\\D', '', 'g'), '')::int)::text AS max FROM bo_frames`);
  return assetIdFor(Number(rows[0]?.max ?? "0") + 1);
}

export async function createFrame(actor: Actor, input: { assetId?: string; size: string; location?: string; condition?: string; notes?: string }): Promise<Frame> {
  const size = input.size.trim();
  if (!size) throw bad("A frame size is required.");
  const assetId = (input.assetId?.trim() || await nextAssetId()).toUpperCase();
  const clash = await pool.query(`SELECT 1 FROM bo_frames WHERE UPPER(asset_id) = $1`, [assetId]);
  if (clash.rowCount) throw conflict(`Asset ID ${assetId} already exists.`);
  const id = boId("frm");
  await pool.query(
    `INSERT INTO bo_frames (id, asset_id, size, location, condition, notes)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [id, assetId, size, input.location?.trim() || DEFAULT_STORE_LOCATION,
      input.condition?.trim() || "Good", input.notes?.trim() ?? ""]);
  await logActivity(actor, "Frame Inventory", "Frame added", `${assetId} (${size})`, { type: "frame", id });
  return await getFrame(id) as Frame;
}

export async function updateFrame(actor: Actor, id: string, patch: Partial<{ size: string; condition: string; location: string; notes: string }>): Promise<void> {
  const f = await getFrame(id);
  if (!f) throw missing("That frame was not found.");
  if (f.status === "in_use" && patch.location !== undefined) {
    throw conflict("This frame is deployed. Change its location by receiving it back first.");
  }
  await pool.query(
    `UPDATE bo_frames SET size = COALESCE($2,size), condition = COALESCE($3,condition),
            location = COALESCE($4,location), notes = COALESCE($5,notes), updated_at = NOW()
      WHERE id = $1`,
    [f.id, patch.size?.trim() || null, patch.condition?.trim() || null,
      patch.location?.trim() || null, patch.notes ?? null]);
  await logActivity(actor, "Frame Inventory", "Frame updated", f.asset_id, { type: "frame", id: f.id });
}

/**
 * Retires rather than deletes. The frame's allocation history is a record of
 * where university property has been, and a DELETE would take it with them.
 * Retired frames drop out of every list but the history survives.
 */
export async function retireFrame(actor: Actor, id: string): Promise<void> {
  const f = await getFrame(id);
  if (!f) throw missing("That frame was not found.");
  if (f.status === "in_use") throw conflict(`${f.asset_id} is deployed at ${f.institute_name ?? "an institute"}. Receive it back before removing it.`);
  await pool.query(`UPDATE bo_frames SET status = 'retired', retired_at = NOW(), updated_at = NOW() WHERE id = $1`, [f.id]);
  await logActivity(actor, "Frame Inventory", "Frame removed", `${f.asset_id} (${f.size})`, { type: "frame", id: f.id });
}

// ── Allocation and return ──────────────────────────────────────────────────

export interface Allocation {
  id: string; frame_id: string; asset_id: string; size: string;
  institute_id: string; institute_name: string; location: string; event: string;
  from_date: string; until_date: string; allocated_at: string; returned_at: string | null;
  return_condition: string; return_location: string; return_remarks: string;
}

/**
 * Every DATE column is cast to text in SQL rather than fixed up after the
 * fact. node-postgres turns DATE into a JS Date at local midnight, which
 * serialises to the previous day for any timezone ahead of UTC — in IST a
 * frame allocated on the 5th comes back as the 4th. Casting means the value
 * is never a Date, so there is no per-call-site helper to forget.
 */
const ALLOC_SELECT = `
  SELECT a.id, a.frame_id, f.asset_id, f.size, a.institute_id, i.name AS institute_name,
         a.location, a.event, a.from_date::text AS from_date, a.until_date::text AS until_date,
         a.allocated_at, a.returned_at,
         a.return_condition, a.return_location, a.return_remarks
    FROM bo_frame_allocations a
    JOIN bo_frames f ON f.id = a.frame_id
    JOIN bo_institutes i ON i.id = a.institute_id`;

export async function listAllocations(filter: { open?: boolean; frameId?: string; instituteId?: string; limit?: number } = {}): Promise<Allocation[]> {
  const where: string[] = [];
  const args: unknown[] = [];
  if (filter.open === true) where.push(`a.returned_at IS NULL`);
  if (filter.open === false) where.push(`a.returned_at IS NOT NULL`);
  if (filter.frameId) { args.push(filter.frameId); where.push(`a.frame_id = $${args.length}`); }
  if (filter.instituteId) { args.push(filter.instituteId); where.push(`a.institute_id = $${args.length}`); }
  args.push(Math.min(Math.max(filter.limit ?? 300, 1), 1000));
  const { rows } = await pool.query<Allocation>(
    `${ALLOC_SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY a.allocated_at DESC LIMIT $${args.length}`, args);
  return rows;
}

/**
 * Transactional on purpose. Two people allocating the same frame at the same
 * moment would both pass a plain status check; the partial unique index turns
 * the loser into a conflict instead of a silent double-booking.
 */
export async function allocateFrame(actor: Actor, input: {
  frameId: string; instituteId: string; location: string; event: string; from: string; until: string;
}): Promise<Allocation> {
  const location = input.location.trim();
  if (!location) throw bad("An exact location is required.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.from) || !/^\d{4}-\d{2}-\d{2}$/.test(input.until)) {
    throw bad("Both a From and an Until date are required.");
  }
  if (input.until < input.from) throw bad("The Until date cannot be before the From date.");

  const client = await pool.connect();
  /* Captured inside the transaction, used after the connection goes back to
     the pool — see the note on the post-commit block below. */
  let committed = { frameId: "", assetId: "", institute: "" };
  try {
    await client.query("BEGIN");
    const f = await client.query<{ id: string; asset_id: string; status: FrameStatus }>(
      `SELECT id, asset_id, status FROM bo_frames WHERE id = $1 OR asset_id = $1 FOR UPDATE`, [input.frameId]);
    if (!f.rowCount) throw missing("That frame was not found.");
    const frame = f.rows[0];
    if (frame.status === "retired") throw conflict(`${frame.asset_id} has been removed from inventory.`);
    if (frame.status === "in_use") throw conflict(`${frame.asset_id} is already deployed.`);

    const inst = await client.query<{ name: string }>(`SELECT name FROM bo_institutes WHERE id = $1`, [input.instituteId]);
    if (!inst.rowCount) throw missing("Pick an institute to allocate this frame to.");

    const allocId = boId("alc");
    await client.query(
      `INSERT INTO bo_frame_allocations (id, frame_id, institute_id, location, event, from_date, until_date, allocated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [allocId, frame.id, input.instituteId, location, input.event.trim(), input.from, input.until, actor.id]);
    await client.query(
      `UPDATE bo_frames SET status = 'in_use', institute_id = $2, location = $3, updated_at = NOW() WHERE id = $1`,
      [frame.id, input.instituteId, location]);
    await client.query("COMMIT");
    committed = { frameId: frame.id, assetId: frame.asset_id, institute: inst.rows[0].name };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    if (err instanceof BoError) throw err;
    if (String(err).includes("bo_alloc_one_open_per_frame")) throw conflict("That frame was allocated by someone else a moment ago.");
    throw err;
  } finally {
    client.release();
  }

  /* After release, deliberately. The activity write and the read-back each take
     a connection of their own, and asking for a second one while still holding
     the transaction's client is how a busy pool deadlocks: every connection
     held by a caller waiting for a connection nobody will free. */
  await logActivity(actor, "Frame Allocation", "Frame allocated",
    `${committed.assetId} → ${committed.institute} (${location}) ${input.from} to ${input.until}`,
    { type: "frame", id: committed.frameId });
  const [row] = await listAllocations({ frameId: committed.frameId, open: true });
  return row;
}

export async function returnFrame(actor: Actor, input: {
  frameId: string; condition?: string; location?: string; remarks?: string; returnedAt?: string;
}): Promise<void> {
  const client = await pool.connect();
  let done = { frameId: "", assetId: "", instituteId: "", store: "", condition: "" };
  try {
    await client.query("BEGIN");
    const f = await client.query<{ id: string; asset_id: string; status: FrameStatus }>(
      `SELECT id, asset_id, status FROM bo_frames WHERE id = $1 OR asset_id = $1 FOR UPDATE`, [input.frameId]);
    if (!f.rowCount) throw missing("That frame was not found.");
    const frame = f.rows[0];

    const open = await client.query<{ id: string; institute_id: string }>(
      `SELECT id, institute_id FROM bo_frame_allocations WHERE frame_id = $1 AND returned_at IS NULL FOR UPDATE`, [frame.id]);
    if (!open.rowCount) throw conflict(`${frame.asset_id} is not currently deployed.`);

    const storeLocation = input.location?.trim() || DEFAULT_STORE_LOCATION;
    const condition = input.condition?.trim() || "Good";
    await client.query(
      `UPDATE bo_frame_allocations
          SET returned_at = COALESCE($2::timestamptz, NOW()), returned_by = $3,
              return_condition = $4, return_location = $5, return_remarks = $6
        WHERE id = $1`,
      [open.rows[0].id, input.returnedAt || null, actor.id, condition, storeLocation, input.remarks?.trim() ?? ""]);
    await client.query(
      `UPDATE bo_frames SET status = 'available', institute_id = NULL, location = $2,
              condition = $3, updated_at = NOW() WHERE id = $1`,
      [frame.id, storeLocation, condition]);
    await client.query("COMMIT");
    done = { frameId: frame.id, assetId: frame.asset_id, instituteId: open.rows[0].institute_id,
             store: storeLocation, condition };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  // After release — both of these take a connection of their own.
  const inst = await pool.query<{ name: string }>(`SELECT name FROM bo_institutes WHERE id = $1`, [done.instituteId]);
  await logActivity(actor, "Frame Return", "Frame returned",
    `${done.assetId} received back from ${inst.rows[0]?.name ?? "an institute"} → ${done.store} (${done.condition})`,
    { type: "frame", id: done.frameId });
}

// ── Branding requirements ──────────────────────────────────────────────────

/** Anything pool.query-shaped: the pool itself, or a client in a transaction. */
type Queryable = Pick<typeof pool, "query">;

/** A requirement's statuses that still have work ahead of them. */
const OPEN_REQUEST_STATUSES: RequestStatus[] = ["pending", "quoted", "approved", "in_progress"];

/** One quotation as the requirement's summary shows it. */
export interface QuoteSummary {
  id: string; reference: string; vendor_name: string; amount: string;
  quote_date: string; status: QuoteStatus; revision: number;
}

export interface BrandingRequest {
  id: string; reference: string; institute_id: string; institute_name: string;
  required_date: string; work_type: string; priority: Priority; description: string;
  location: string; quantity: number; size: string; status: RequestStatus; created_at: string;
  completed_at: string | null; completion_note: string;
  /** Quotations that have not been removed. */
  quote_count: number;
  approved_amount: string | null;
  /** The cheapest quotation still standing — what the team compares against. */
  lowest_amount: string | null;
}

/* Removed quotations are history: they are kept, but they no longer count
   towards a requirement's quotes or its lowest price. */
const REQ_SELECT = `
  SELECT r.id, r.reference, r.institute_id, i.name AS institute_name, r.required_date::text AS required_date,
         r.work_type, r.priority, r.description, r.location, r.quantity, r.size, r.status, r.created_at,
         r.completed_at, r.completion_note,
         COALESCE(q.c,0)::int AS quote_count, q.approved_amount, q.lowest_amount
    FROM bo_requests r
    JOIN bo_institutes i ON i.id = r.institute_id
    LEFT JOIN (
      SELECT request_id, COUNT(*) AS c,
             MAX(CASE WHEN status='approved' THEN amount END)::text AS approved_amount,
             MIN(CASE WHEN status <> 'rejected' THEN amount END)::text AS lowest_amount
        FROM bo_quotations WHERE removed_at IS NULL GROUP BY request_id
    ) q ON q.request_id = r.id`;

export async function listRequests(filter: { status?: RequestStatus; instituteId?: string; q?: string } = {}): Promise<BrandingRequest[]> {
  // A removed requirement leaves every list. Its row stays for the record.
  const where: string[] = ["r.removed_at IS NULL"];
  const args: unknown[] = [];
  if (filter.status) { args.push(filter.status); where.push(`r.status = $${args.length}`); }
  if (filter.instituteId) { args.push(filter.instituteId); where.push(`r.institute_id = $${args.length}`); }
  if (filter.q) {
    args.push(`%${filter.q.toLowerCase()}%`);
    where.push(`(LOWER(r.reference) LIKE $${args.length} OR LOWER(r.description) LIKE $${args.length}
      OR LOWER(r.work_type) LIKE $${args.length} OR LOWER(i.name) LIKE $${args.length}
      OR LOWER(r.size) LIKE $${args.length} OR LOWER(r.location) LIKE $${args.length})`);
  }
  const { rows } = await pool.query<BrandingRequest>(
    `${REQ_SELECT} WHERE ${where.join(" AND ")} ORDER BY r.created_at DESC`, args);
  return rows;
}

/**
 * The next reference in a series ("REQ-0012").
 *
 * Taken from the highest number already issued, not from the row count. A
 * count only works while rows are never removed: once one is, the count
 * falls behind the highest reference and the next "new" number is one that
 * already exists — and the UNIQUE constraint then refuses every creation from
 * that point on.
 */
async function nextReference(table: string, prefix: string, db: Queryable = pool): Promise<string> {
  const { rows } = await db.query<{ n: string | null }>(
    `SELECT MAX(NULLIF(regexp_replace(reference, '^.*-', ''), '')::int)::text AS n
       FROM ${table} WHERE reference ~ ('^' || $1 || '-[0-9]+$')`, [prefix]);
  return `${prefix}-${String(Number(rows[0]?.n ?? "0") + 1).padStart(4, "0")}`;
}

export interface RequestInput {
  instituteId: string; requiredDate: string; workType: string; priority: Priority;
  description: string; location?: string; quantity?: number; size?: string;
}

function validateRequest(input: RequestInput): void {
  if (!input.instituteId) throw bad("Pick an institute.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.requiredDate)) throw bad("A required date is needed.");
  if (!input.workType.trim()) throw bad("Pick a work type.");
  if (!input.description.trim()) throw bad("Describe the branding work required.");
  if (!["normal", "high", "urgent"].includes(input.priority)) throw bad("Pick a priority.");
}

/** Inserts a requirement on `db` and returns its id and reference. No logging. */
async function insertRequest(db: Queryable, actor: Actor, input: RequestInput): Promise<{ id: string; reference: string; institute: string }> {
  validateRequest(input);
  const inst = await db.query<{ name: string }>(`SELECT name FROM bo_institutes WHERE id = $1`, [input.instituteId]);
  if (!inst.rowCount) throw missing("That institute was not found.");
  const id = boId("req");
  const reference = await nextReference("bo_requests", "REQ", db);
  await db.query(
    `INSERT INTO bo_requests (id, reference, institute_id, required_date, work_type, priority, description, location, quantity, size, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [id, reference, input.instituteId, input.requiredDate, input.workType.trim(), input.priority,
      input.description.trim(), input.location?.trim() ?? "", Math.max(1, input.quantity ?? 1),
      input.size?.trim() ?? "", actor.id]);
  return { id, reference, institute: inst.rows[0].name };
}

export async function getRequest(id: string): Promise<BrandingRequest | null> {
  const { rows } = await pool.query<BrandingRequest>(`${REQ_SELECT} WHERE r.id = $1 AND r.removed_at IS NULL`, [id]);
  return rows[0] ?? null;
}

export async function createRequest(actor: Actor, input: RequestInput): Promise<BrandingRequest> {
  const made = await insertRequest(pool, actor, input);
  await logActivity(actor, "Branding Requests", "Requirement created",
    `${made.reference} — ${input.workType.trim()}${input.size?.trim() ? ` (${input.size.trim()})` : ""} for ${made.institute}`,
    { type: "request", id: made.id });
  return (await getRequest(made.id)) as BrandingRequest;
}

/** Edits a requirement's details. Status is changed by its own actions, not here. */
export async function updateRequest(actor: Actor, id: string, input: RequestInput): Promise<BrandingRequest> {
  validateRequest(input);
  const r = await pool.query<{ reference: string; removed_at: string | null }>(
    `SELECT reference, removed_at FROM bo_requests WHERE id = $1`, [id]);
  if (!r.rowCount || r.rows[0].removed_at) throw missing("That requirement was not found.");
  const inst = await pool.query(`SELECT 1 FROM bo_institutes WHERE id = $1`, [input.instituteId]);
  if (!inst.rowCount) throw missing("That institute was not found.");
  await pool.query(
    `UPDATE bo_requests SET institute_id = $2, required_date = $3, work_type = $4, priority = $5,
            description = $6, location = $7, quantity = $8, size = $9, updated_at = NOW()
      WHERE id = $1`,
    [id, input.instituteId, input.requiredDate, input.workType.trim(), input.priority,
      input.description.trim(), input.location?.trim() ?? "", Math.max(1, input.quantity ?? 1), input.size?.trim() ?? ""]);
  await logActivity(actor, "Branding Requests", "Requirement edited", r.rows[0].reference, { type: "request", id });
  return (await getRequest(id)) as BrandingRequest;
}

export async function setRequestStatus(actor: Actor, id: string, status: RequestStatus): Promise<void> {
  const r = await pool.query<{ reference: string; removed_at: string | null }>(
    `SELECT reference, removed_at FROM bo_requests WHERE id = $1`, [id]);
  if (!r.rowCount || r.rows[0].removed_at) throw missing("That requirement was not found.");
  await pool.query(`UPDATE bo_requests SET status = $2, updated_at = NOW() WHERE id = $1`, [id, status]);
  await logActivity(actor, "Branding Requests", "Requirement status changed",
    `${r.rows[0].reference} → ${status}`, { type: "request", id });
}

/**
 * Marks a requirement Completed — the work is finished.
 *
 * Allowed from any status with work still ahead of it, not only once a work
 * order has run its course: small jobs are often done without one, and the
 * team needs a way to say "this one is done" either way. Recorded with who
 * and when.
 */
export async function completeRequest(actor: Actor, id: string, note = ""): Promise<void> {
  const r = await pool.query<{ reference: string; status: RequestStatus; removed_at: string | null }>(
    `SELECT reference, status, removed_at FROM bo_requests WHERE id = $1`, [id]);
  if (!r.rowCount || r.rows[0].removed_at) throw missing("That requirement was not found.");
  const { reference, status } = r.rows[0];
  if (status === "completed") throw conflict(`${reference} is already completed.`);
  if (!OPEN_REQUEST_STATUSES.includes(status)) throw conflict(`${reference} is ${status} — it can't be marked completed.`);
  await pool.query(
    `UPDATE bo_requests SET status = 'completed', completed_at = NOW(), completed_by = $2,
            completion_note = $3, updated_at = NOW() WHERE id = $1`,
    [id, actor.id, note.trim()]);
  await logActivity(actor, "Branding Requests", "Requirement completed",
    `${reference}${note.trim() ? ` — ${note.trim()}` : ""}`, { type: "request", id });
}

/**
 * Undoes "Completed" — for a requirement marked done by mistake. It returns
 * to whatever its quotations and work order say it is.
 */
export async function reopenRequest(actor: Actor, id: string): Promise<RequestStatus> {
  const r = await pool.query<{ reference: string; status: RequestStatus; removed_at: string | null }>(
    `SELECT reference, status, removed_at FROM bo_requests WHERE id = $1`, [id]);
  if (!r.rowCount || r.rows[0].removed_at) throw missing("That requirement was not found.");
  if (r.rows[0].status !== "completed") throw conflict(`${r.rows[0].reference} is not completed.`);

  const facts = await pool.query<{ wo_open: boolean; approved: boolean; quoted: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM bo_work_orders WHERE request_id = $1 AND status <> 'closed') AS wo_open,
            EXISTS (SELECT 1 FROM bo_quotations WHERE request_id = $1 AND status = 'approved' AND removed_at IS NULL) AS approved,
            EXISTS (SELECT 1 FROM bo_quotations WHERE request_id = $1 AND removed_at IS NULL) AS quoted`, [id]);
  const f = facts.rows[0];
  const back: RequestStatus = f.wo_open ? "in_progress" : f.approved ? "approved" : f.quoted ? "quoted" : "pending";
  await pool.query(
    `UPDATE bo_requests SET status = $2, completed_at = NULL, completed_by = NULL, completion_note = '', updated_at = NOW()
      WHERE id = $1`, [id, back]);
  await logActivity(actor, "Branding Requests", "Requirement reopened",
    `${r.rows[0].reference} → ${back}`, { type: "request", id });
  return back;
}

/**
 * Removes a requirement from Branding Requests and the Dashboard alike —
 * both read this same row, so removing it in one place removes it from both.
 *
 * Soft: the row, its quotations and its history stay. Refused while a work
 * order on it is still open, because removing the requirement would leave a
 * vendor's live job with nothing above it.
 */
export async function removeRequest(actor: Actor, id: string, reason = ""): Promise<void> {
  const r = await pool.query<{ reference: string; removed_at: string | null }>(
    `SELECT reference, removed_at FROM bo_requests WHERE id = $1`, [id]);
  if (!r.rowCount || r.rows[0].removed_at) throw missing("That requirement was not found.");
  const wo = await pool.query<{ reference: string; status: string }>(
    `SELECT reference, status FROM bo_work_orders WHERE request_id = $1 AND status <> 'closed'`, [id]);
  if (wo.rowCount) {
    throw conflict(`${r.rows[0].reference} has an open work order (${wo.rows[0].reference}, ${wo.rows[0].status.replace("_", " ")}). Close the work order first.`);
  }
  // Guarded on removed_at so two simultaneous removals record one.
  const done = await pool.query(
    `UPDATE bo_requests SET removed_at = NOW(), removed_by = $2, removal_reason = $3, updated_at = NOW()
      WHERE id = $1 AND removed_at IS NULL`, [id, actor.id, reason.trim()]);
  if (!done.rowCount) throw missing("That requirement was not found.");
  await logActivity(actor, "Branding Requests", "Requirement removed",
    `${r.rows[0].reference}${reason.trim() ? ` — ${reason.trim()}` : ""}`, { type: "request", id });
}

/**
 * Sizes to suggest when entering a requirement: every frame size, and every
 * size typed on a requirement before. Free text is still accepted — this is a
 * list to pick from, not a list to be limited to.
 */
export async function requestSizes(): Promise<string[]> {
  const { rows } = await pool.query<{ size: string }>(
    `SELECT DISTINCT size FROM (
       SELECT size FROM bo_frames WHERE status <> 'retired'
       UNION SELECT size FROM bo_requests WHERE removed_at IS NULL
     ) s WHERE size <> '' ORDER BY size`);
  return rows.map(r => r.size);
}

// ── Quotations and approvals ───────────────────────────────────────────────

export interface Quotation {
  id: string; reference: string; request_id: string; request_reference: string;
  institute_name: string; vendor_id: string; vendor_name: string; amount: string;
  quote_date: string; status: QuoteStatus; notes: string; decision_note: string;
  decided_at: string | null; created_at: string;
  /** 1 for an unedited quotation; each edit adds one. */
  revision: number; updated_at: string | null;
  removed_at: string | null; removal_reason: string;
  /** The requirement's work and size, so a list of quotations reads on its own. */
  work_type: string; request_size: string;
  /**
   * Set when the REQUIREMENT was removed. Such quotations only appear in lists
   * that ask for removed things, and can't be edited, removed or decided.
   */
  request_removed_at: string | null;
}

const QUOTE_SELECT = `
  SELECT q.id, q.reference, q.request_id, r.reference AS request_reference, i.name AS institute_name,
         q.vendor_id, v.name AS vendor_name, q.amount::text, q.quote_date::text AS quote_date, q.status, q.notes,
         q.decision_note, q.decided_at, q.created_at, q.revision, q.updated_at, q.removed_at, q.removal_reason,
         r.work_type, r.size AS request_size, r.removed_at AS request_removed_at
    FROM bo_quotations q
    JOIN bo_requests r ON r.id = q.request_id
    JOIN bo_institutes i ON i.id = r.institute_id
    JOIN bo_vendors v ON v.id = q.vendor_id`;

export async function listQuotations(filter: { status?: QuoteStatus; requestId?: string; includeRemoved?: boolean } = {}): Promise<Quotation[]> {
  /* By default a list shows live quotations on live requirements: removing a
     requirement must take its quotations off Quotations and Approvals too, or
     someone could approve a price for work nobody wants any more. */
  const where: string[] = filter.includeRemoved ? [] : ["q.removed_at IS NULL", "r.removed_at IS NULL"];
  const args: unknown[] = [];
  if (filter.status) { args.push(filter.status); where.push(`q.status = $${args.length}`); }
  if (filter.requestId) { args.push(filter.requestId); where.push(`q.request_id = $${args.length}`); }
  const { rows } = await pool.query<Quotation>(
    `${QUOTE_SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY q.created_at DESC`, args);
  return rows;
}

export interface QuoteInput { vendorId: string; amount: number; quoteDate: string; notes?: string }

function validateQuote(input: QuoteInput): void {
  if (!(Number.isFinite(input.amount) && input.amount >= 0)) throw bad("Enter the quotation amount.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.quoteDate)) throw bad("A quotation date is required.");
  if (!input.vendorId) throw bad("Pick a vendor.");
}

/** A requirement that can still take a quotation, or the reason it can't. */
async function quotableRequest(db: Queryable, requestId: string): Promise<{ reference: string }> {
  const r = await db.query<{ reference: string; status: RequestStatus; removed_at: string | null }>(
    `SELECT reference, status, removed_at FROM bo_requests WHERE id = $1`, [requestId]);
  if (!r.rowCount || r.rows[0].removed_at) throw missing("That requirement was not found.");
  const { reference, status } = r.rows[0];
  if (status === "rejected" || status === "closed" || status === "completed") {
    throw conflict(`${reference} is ${status} — it can't take new quotations.`);
  }
  return { reference };
}

async function insertQuotation(db: Queryable, actor: Actor, requestId: string, input: QuoteInput): Promise<{ id: string; reference: string; vendor: string }> {
  const v = await db.query<{ name: string }>(`SELECT name FROM bo_vendors WHERE id = $1`, [input.vendorId]);
  if (!v.rowCount) throw missing("Pick a vendor.");
  const id = boId("qt");
  const reference = await nextReference("bo_quotations", "QT", db);
  await db.query(
    `INSERT INTO bo_quotations (id, reference, request_id, vendor_id, amount, quote_date, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, reference, requestId, input.vendorId, input.amount, input.quoteDate, input.notes?.trim() ?? "", actor.id]);
  // A requirement with a quotation on it is no longer merely pending.
  await db.query(`UPDATE bo_requests SET status = 'quoted', updated_at = NOW() WHERE id = $1 AND status = 'pending'`, [requestId]);
  return { id, reference, vendor: v.rows[0].name };
}

export async function createQuotation(actor: Actor, input: QuoteInput & { requestId: string }): Promise<Quotation> {
  validateQuote(input);
  const req = await quotableRequest(pool, input.requestId);
  const made = await insertQuotation(pool, actor, input.requestId, input);
  await logActivity(actor, "Quotations", "Quotation added",
    `${made.reference} — ${made.vendor} quoted ₹${input.amount} on ${req.reference}`, { type: "quotation", id: made.id });
  return (await listQuotations({ requestId: input.requestId })).find(q => q.id === made.id) as Quotation;
}

/**
 * Adds a quotation for a requirement typed into the quotation form rather
 * than picked from the list — creating the requirement and the quotation
 * together.
 *
 * One transaction, so a quotation that fails (an unknown vendor, say) never
 * leaves behind a half-made requirement nobody asked for.
 */
export async function createQuotationWithNewRequest(
  actor: Actor, request: RequestInput, quote: QuoteInput,
): Promise<Quotation> {
  validateRequest(request);
  validateQuote(quote);
  const client = await pool.connect();
  let made = { requestId: "", requestRef: "", institute: "", quoteId: "", quoteRef: "", vendor: "" };
  try {
    await client.query("BEGIN");
    const r = await insertRequest(client, actor, request);
    const q = await insertQuotation(client, actor, r.id, quote);
    await client.query("COMMIT");
    made = { requestId: r.id, requestRef: r.reference, institute: r.institute, quoteId: q.id, quoteRef: q.reference, vendor: q.vendor };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  // After release — logActivity takes a connection of its own.
  await logActivity(actor, "Branding Requests", "Requirement created",
    `${made.requestRef} — ${request.workType.trim()} for ${made.institute} (from a quotation)`, { type: "request", id: made.requestId });
  await logActivity(actor, "Quotations", "Quotation added",
    `${made.quoteRef} — ${made.vendor} quoted ₹${quote.amount} on ${made.requestRef}`, { type: "quotation", id: made.quoteId });
  return (await listQuotations({ requestId: made.requestId })).find(q => q.id === made.quoteId) as Quotation;
}

/**
 * Edits a quotation, keeping the version it replaces.
 *
 * The replaced vendor, amount, date and notes go into bo_quotation_revisions
 * first, so every price a vendor ever gave stays on record and can be set
 * beside the new one. An APPROVED quotation is locked: the decision and any
 * work order were made on that figure, and quietly changing it afterwards
 * would rewrite what was agreed.
 */
export async function updateQuotation(actor: Actor, id: string, patch: Partial<QuoteInput>): Promise<Quotation> {
  const client = await pool.connect();
  let summary = { reference: "", requestId: "", changes: [] as string[] };
  try {
    await client.query("BEGIN");
    const cur = await client.query<{
      reference: string; request_id: string; status: QuoteStatus; vendor_id: string; vendor: string;
      amount: string; quote_date: string; notes: string; revision: number; removed_at: string | null; request_removed: string | null;
    }>(
      `SELECT q.reference, q.request_id, q.status, q.vendor_id, v.name AS vendor, q.amount::text AS amount,
              q.quote_date::text AS quote_date, q.notes, q.revision, q.removed_at, r.removed_at AS request_removed
         FROM bo_quotations q JOIN bo_vendors v ON v.id = q.vendor_id JOIN bo_requests r ON r.id = q.request_id
        WHERE q.id = $1 FOR UPDATE OF q`, [id]);
    if (!cur.rowCount || cur.rows[0].removed_at || cur.rows[0].request_removed) throw missing("That quotation was not found.");
    const before = cur.rows[0];
    if (before.status === "approved") {
      throw conflict(`${before.reference} was approved — it is locked, because the decision was made on that figure.`);
    }

    const next = {
      vendorId: patch.vendorId ?? before.vendor_id,
      amount: patch.amount ?? Number(before.amount),
      quoteDate: patch.quoteDate ?? before.quote_date,
      notes: patch.notes ?? before.notes,
    };
    validateQuote(next);
    let vendorName = before.vendor;
    if (next.vendorId !== before.vendor_id) {
      const v = await client.query<{ name: string }>(`SELECT name FROM bo_vendors WHERE id = $1`, [next.vendorId]);
      if (!v.rowCount) throw missing("Pick a vendor.");
      vendorName = v.rows[0].name;
    }

    const changes: string[] = [];
    if (vendorName !== before.vendor) changes.push(`vendor ${before.vendor} → ${vendorName}`);
    if (Number(before.amount) !== next.amount) changes.push(`₹${Number(before.amount)} → ₹${next.amount}`);
    if (before.quote_date !== next.quoteDate) changes.push(`dated ${before.quote_date} → ${next.quoteDate}`);
    if (before.notes.trim() !== next.notes.trim()) changes.push("notes edited");

    if (changes.length) {
      await client.query(
        `INSERT INTO bo_quotation_revisions (id, quotation_id, revision, vendor_id, vendor_name, amount, quote_date, notes, replaced_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [boId("qrev"), id, before.revision, before.vendor_id, before.vendor, before.amount, before.quote_date, before.notes, actor.id]);
      await client.query(
        `UPDATE bo_quotations SET vendor_id = $2, amount = $3, quote_date = $4, notes = $5,
                revision = revision + 1, updated_at = NOW() WHERE id = $1`,
        [id, next.vendorId, next.amount, next.quoteDate, next.notes.trim()]);
    }
    await client.query("COMMIT");
    summary = { reference: before.reference, requestId: before.request_id, changes };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  if (summary.changes.length) {
    await logActivity(actor, "Quotations", "Quotation edited",
      `${summary.reference} — ${summary.changes.join("; ")}`, { type: "quotation", id });
  }
  return (await listQuotations({ requestId: summary.requestId })).find(q => q.id === id) as Quotation;
}

/**
 * Removes a quotation from the lists. Soft, like a requirement: it stays in
 * the requirement's quotation history, marked removed, so it can still be
 * compared against. An approved quotation can't be removed, for the same
 * reason it can't be edited.
 */
export async function removeQuotation(actor: Actor, id: string, reason = ""): Promise<void> {
  const client = await pool.connect();
  let removed = { reference: "", requestRef: "" };
  try {
    await client.query("BEGIN");
    const cur = await client.query<{ reference: string; request_id: string; status: QuoteStatus; removed_at: string | null; request_ref: string }>(
      `SELECT q.reference, q.request_id, q.status, q.removed_at, r.reference AS request_ref
         FROM bo_quotations q JOIN bo_requests r ON r.id = q.request_id
        WHERE q.id = $1 FOR UPDATE OF q`, [id]);
    if (!cur.rowCount || cur.rows[0].removed_at) throw missing("That quotation was not found.");
    const q = cur.rows[0];
    if (q.status === "approved") {
      throw conflict(`${q.reference} was approved — it can't be removed, because the decision was made on it.`);
    }
    await client.query(
      `UPDATE bo_quotations SET removed_at = NOW(), removed_by = $2, removal_reason = $3 WHERE id = $1`,
      [id, actor.id, reason.trim()]);
    /* A requirement only counts as "quoted" while it has a quotation. If this
       was the last one standing, it is back to waiting for one. */
    await client.query(
      `UPDATE bo_requests SET status = 'pending', updated_at = NOW()
        WHERE id = $1 AND status = 'quoted'
          AND NOT EXISTS (SELECT 1 FROM bo_quotations WHERE request_id = $1 AND removed_at IS NULL)`,
      [q.request_id]);
    await client.query("COMMIT");
    removed = { reference: q.reference, requestRef: q.request_ref };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  await logActivity(actor, "Quotations", "Quotation removed",
    `${removed.reference} on ${removed.requestRef}${reason.trim() ? ` — ${reason.trim()}` : ""}`, { type: "quotation", id });
}

export interface QuotationRevision {
  revision: number; vendor_name: string; amount: string; quote_date: string;
  notes: string; replaced_at: string; replaced_by_name: string | null;
}

export interface QuotationWithHistory extends Quotation {
  /** Earlier versions of this quotation, oldest first. */
  revisions: QuotationRevision[];
}

/**
 * Every quotation a requirement has had — standing, rejected and removed —
 * each with the versions it replaced. What the ⓘ view and the comparison read.
 */
export async function quotationHistory(requestId: string): Promise<{ request: BrandingRequest | null; quotations: QuotationWithHistory[] }> {
  const request = await getRequest(requestId);
  const quotations = (await listQuotations({ requestId, includeRemoved: true }))
    // pg returns TIMESTAMPTZ as a Date, not a string — compare the instants.
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  if (!quotations.length) return { request, quotations: [] };
  const { rows } = await pool.query<QuotationRevision & { quotation_id: string }>(
    `SELECT qr.quotation_id, qr.revision, qr.vendor_name, qr.amount::text AS amount, qr.quote_date::text AS quote_date,
            qr.notes, qr.replaced_at, u.full_name AS replaced_by_name
       FROM bo_quotation_revisions qr LEFT JOIN users u ON u.id = qr.replaced_by
      WHERE qr.quotation_id = ANY($1::text[]) ORDER BY qr.revision ASC`,
    [quotations.map(q => q.id)]);
  const byQuote = new Map<string, QuotationRevision[]>();
  for (const { quotation_id, ...rev } of rows) byQuote.set(quotation_id, [...(byQuote.get(quotation_id) ?? []), rev]);
  return { request, quotations: quotations.map(q => ({ ...q, revisions: byQuote.get(q.id) ?? [] })) };
}

/**
 * The quotations behind each listed requirement, for the Dashboard's ⓘ view
 * — one query for all of them rather than one per row.
 */
export async function quoteSummaries(requestIds: string[]): Promise<Record<string, QuoteSummary[]>> {
  if (!requestIds.length) return {};
  const { rows } = await pool.query<QuoteSummary & { request_id: string }>(
    `SELECT q.request_id, q.id, q.reference, v.name AS vendor_name, q.amount::text AS amount,
            q.quote_date::text AS quote_date, q.status, q.revision
       FROM bo_quotations q JOIN bo_vendors v ON v.id = q.vendor_id
      WHERE q.request_id = ANY($1::text[]) AND q.removed_at IS NULL
      ORDER BY q.amount ASC`, [requestIds]);
  const out: Record<string, QuoteSummary[]> = {};
  for (const { request_id, ...summary } of rows) (out[request_id] ??= []).push(summary);
  return out;
}

/**
 * Approving one quotation rejects the others on that requirement. "Approved"
 * means chosen; leaving the rest pending would allow a second approval later
 * and leave two vendors both believing they won the job.
 */
export async function decideQuotation(actor: Actor, id: string, decision: "approved" | "rejected", note = ""): Promise<void> {
  const client = await pool.connect();
  let decided = { reference: "", vendor: "", amount: "" };
  try {
    await client.query("BEGIN");
    const q = await client.query<{
      reference: string; request_id: string; status: QuoteStatus; vendor: string; amount: string;
      removed_at: string | null; request_removed: string | null; request_status: RequestStatus;
    }>(
      `SELECT q.reference, q.request_id, q.status, v.name AS vendor, q.amount::text AS amount,
              q.removed_at, r.removed_at AS request_removed, r.status AS request_status
         FROM bo_quotations q JOIN bo_vendors v ON v.id = q.vendor_id JOIN bo_requests r ON r.id = q.request_id
        WHERE q.id = $1 FOR UPDATE OF q`, [id]);
    // A removed quotation, or one on a removed requirement, is not there to decide.
    if (!q.rowCount || q.rows[0].removed_at || q.rows[0].request_removed) throw missing("That quotation was not found.");
    const quote = q.rows[0];
    if (quote.status !== "pending") throw conflict(`That quotation has already been ${quote.status}.`);
    if (decision === "approved" && (quote.request_status === "completed" || quote.request_status === "closed")) {
      throw conflict(`That requirement is ${quote.request_status} — reopen it before approving a quotation.`);
    }

    await client.query(
      `UPDATE bo_quotations SET status = $2, decided_by = $3, decided_at = NOW(), decision_note = $4 WHERE id = $1`,
      [id, decision, actor.id, note.trim()]);

    if (decision === "approved") {
      await client.query(
        `UPDATE bo_quotations SET status = 'rejected', decided_by = $2, decided_at = NOW(),
                decision_note = 'Another quotation was approved for this requirement.'
          WHERE request_id = $1 AND id <> $3 AND status = 'pending' AND removed_at IS NULL`,
        [quote.request_id, actor.id, id]);
      await client.query(`UPDATE bo_requests SET status = 'approved', updated_at = NOW() WHERE id = $1`, [quote.request_id]);
    }
    await client.query("COMMIT");
    decided = { reference: quote.reference, vendor: quote.vendor, amount: quote.amount };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  // After release — logActivity takes a connection of its own.
  await logActivity(actor, "Approvals", decision === "approved" ? "Quotation approved" : "Quotation rejected",
    `${decided.reference} — ${decided.vendor} ₹${decided.amount}${note.trim() ? ` (${note.trim()})` : ""}`,
    { type: "quotation", id });
}

// ── Work orders ────────────────────────────────────────────────────────────

export interface WorkOrder {
  id: string; reference: string; request_id: string; request_reference: string;
  institute_name: string; quotation_id: string | null; amount: string | null;
  vendor_id: string; vendor_name: string; assigned_date: string; description: string;
  status: WorkOrderStatus; verified_at: string | null; closed_at: string | null; created_at: string;
  photo_count: number; open_visit_id: string | null;
}

const WO_SELECT = `
  SELECT w.id, w.reference, w.request_id, r.reference AS request_reference, i.name AS institute_name,
         w.quotation_id, q.amount::text AS amount, w.vendor_id, v.name AS vendor_name,
         w.assigned_date::text AS assigned_date, w.description, w.status, w.verified_at, w.closed_at, w.created_at,
         COALESCE(p.c,0)::int AS photo_count, vis.id AS open_visit_id
    FROM bo_work_orders w
    JOIN bo_requests r ON r.id = w.request_id
    JOIN bo_institutes i ON i.id = r.institute_id
    JOIN bo_vendors v ON v.id = w.vendor_id
    LEFT JOIN bo_quotations q ON q.id = w.quotation_id
    LEFT JOIN (SELECT work_order_id, COUNT(*) AS c FROM bo_work_photos GROUP BY work_order_id) p ON p.work_order_id = w.id
    LEFT JOIN bo_vendor_visits vis ON vis.work_order_id = w.id AND vis.check_out_at IS NULL`;

export async function listWorkOrders(filter: { status?: WorkOrderStatus; q?: string } = {}): Promise<WorkOrder[]> {
  const where: string[] = [];
  const args: unknown[] = [];
  if (filter.status) { args.push(filter.status); where.push(`w.status = $${args.length}`); }
  if (filter.q) {
    args.push(`%${filter.q.toLowerCase()}%`);
    where.push(`(LOWER(w.reference) LIKE $${args.length} OR LOWER(v.name) LIKE $${args.length}
      OR LOWER(i.name) LIKE $${args.length} OR LOWER(w.description) LIKE $${args.length})`);
  }
  const { rows } = await pool.query<WorkOrder>(
    `${WO_SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY w.created_at DESC`, args);
  return rows;
}

export async function getWorkOrder(id: string): Promise<WorkOrder | null> {
  const { rows } = await pool.query<WorkOrder>(`${WO_SELECT} WHERE w.id = $1`, [id]);
  return rows[0] ?? null;
}

/**
 * Only from an approved quotation. A work order is the instruction to spend
 * money that somebody signed off; creating one from thin air would route
 * around the approval step entirely.
 */
export async function createWorkOrder(actor: Actor, input: { requestId: string; assignedDate: string; description?: string }): Promise<WorkOrder> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.assignedDate)) throw bad("An assigned date is required.");
  const q = await pool.query<{ id: string; vendor_id: string; vendor: string; reference: string }>(
    `SELECT q.id, q.vendor_id, v.name AS vendor, r.reference
       FROM bo_quotations q JOIN bo_vendors v ON v.id = q.vendor_id JOIN bo_requests r ON r.id = q.request_id
      WHERE q.request_id = $1 AND q.status = 'approved' AND q.removed_at IS NULL AND r.removed_at IS NULL`, [input.requestId]);
  if (!q.rowCount) throw conflict("That requirement has no approved quotation yet. Approve one first.");

  const existing = await pool.query(`SELECT 1 FROM bo_work_orders WHERE request_id = $1`, [input.requestId]);
  if (existing.rowCount) throw conflict("A work order already exists for that requirement.");

  const id = boId("wo");
  const reference = await nextReference("bo_work_orders", "WO");
  await pool.query(
    `INSERT INTO bo_work_orders (id, reference, request_id, quotation_id, vendor_id, assigned_date, description, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, reference, input.requestId, q.rows[0].id, q.rows[0].vendor_id, input.assignedDate, input.description?.trim() ?? "", actor.id]);
  await pool.query(`UPDATE bo_requests SET status = 'in_progress', updated_at = NOW() WHERE id = $1`, [input.requestId]);
  await logActivity(actor, "Work Orders", "Work order created",
    `${reference} — ${q.rows[0].vendor} on ${q.rows[0].reference}`, { type: "work_order", id });
  return await getWorkOrder(id) as WorkOrder;
}

const WO_FLOW: Record<WorkOrderStatus, WorkOrderStatus[]> = {
  assigned: ["checked_in", "in_progress"],
  checked_in: ["in_progress"],
  in_progress: ["completed"],
  completed: ["verified"],
  verified: ["closed"],
  closed: [],
};

export async function setWorkOrderStatus(actor: Actor, id: string, next: WorkOrderStatus): Promise<void> {
  const wo = await getWorkOrder(id);
  if (!wo) throw missing("That work order was not found.");
  if (!WO_FLOW[wo.status].includes(next)) {
    const was = wo.status.replace("_", " ");
    throw conflict(`${/^[aeiou]/.test(was) ? "An" : "A"} ${was} work order can't move straight to ${next.replace("_", " ")}.`);
  }
  // §"Photos Uploaded → Verified": verifying work nobody photographed defeats
  // the point of the photo step, so the evidence is required, not assumed.
  if (next === "verified" && wo.photo_count === 0) {
    throw conflict("Upload at least one photo of the completed work before verifying it.");
  }
  await pool.query(
    `UPDATE bo_work_orders SET status = $2, updated_at = NOW(),
            verified_by = CASE WHEN $2 = 'verified' THEN $3 ELSE verified_by END,
            verified_at = CASE WHEN $2 = 'verified' THEN NOW() ELSE verified_at END,
            closed_at   = CASE WHEN $2 = 'closed'   THEN NOW() ELSE closed_at END
      WHERE id = $1`, [id, next, actor.id]);

  if (next === "completed") await pool.query(`UPDATE bo_requests SET status = 'completed', updated_at = NOW() WHERE id = $1`, [wo.request_id]);
  if (next === "closed") await pool.query(`UPDATE bo_requests SET status = 'closed', updated_at = NOW() WHERE id = $1`, [wo.request_id]);

  await logActivity(actor, "Work Orders", `Work order ${next.replace("_", " ")}`,
    `${wo.reference} — ${wo.vendor_name} at ${wo.institute_name}`, { type: "work_order", id });
}

// ── Vendor visits ──────────────────────────────────────────────────────────

export interface VendorVisit {
  id: string; work_order_id: string; work_order_reference: string; vendor_name: string;
  institute_name: string; check_in_at: string; check_out_at: string | null; notes: string;
}

export async function listVisits(filter: { workOrderId?: string; open?: boolean } = {}): Promise<VendorVisit[]> {
  const where: string[] = [];
  const args: unknown[] = [];
  if (filter.workOrderId) { args.push(filter.workOrderId); where.push(`vis.work_order_id = $${args.length}`); }
  if (filter.open) where.push(`vis.check_out_at IS NULL`);
  const { rows } = await pool.query<VendorVisit>(
    `SELECT vis.id, vis.work_order_id, w.reference AS work_order_reference, v.name AS vendor_name,
            i.name AS institute_name, vis.check_in_at, vis.check_out_at, vis.notes
       FROM bo_vendor_visits vis
       JOIN bo_work_orders w ON w.id = vis.work_order_id
       JOIN bo_vendors v ON v.id = w.vendor_id
       JOIN bo_requests r ON r.id = w.request_id
       JOIN bo_institutes i ON i.id = r.institute_id
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY vis.check_in_at DESC LIMIT 300`, args);
  return rows;
}

/** The timestamp is the server's, not the client's — it's an attendance record. */
export async function checkIn(actor: Actor, workOrderId: string, notes = ""): Promise<void> {
  const wo = await getWorkOrder(workOrderId);
  if (!wo) throw missing("That work order was not found.");
  if (wo.status === "closed") throw conflict("That work order is closed.");
  if (wo.open_visit_id) throw conflict(`${wo.vendor_name} is already checked in.`);
  await pool.query(
    `INSERT INTO bo_vendor_visits (id, work_order_id, notes, recorded_by) VALUES ($1,$2,$3,$4)`,
    [boId("vis"), workOrderId, notes.trim(), actor.id]);
  if (wo.status === "assigned") {
    await pool.query(`UPDATE bo_work_orders SET status = 'checked_in', updated_at = NOW() WHERE id = $1`, [workOrderId]);
  }
  await logActivity(actor, "Vendor Visits", "Vendor checked in",
    `${wo.vendor_name} arrived at ${wo.institute_name} for ${wo.reference}`, { type: "work_order", id: workOrderId });
}

export async function checkOut(actor: Actor, workOrderId: string, notes = ""): Promise<void> {
  const wo = await getWorkOrder(workOrderId);
  if (!wo) throw missing("That work order was not found.");
  if (!wo.open_visit_id) throw conflict(`${wo.vendor_name} is not checked in.`);
  await pool.query(
    `UPDATE bo_vendor_visits SET check_out_at = NOW(),
            notes = CASE WHEN $2 = '' THEN notes ELSE notes || CASE WHEN notes = '' THEN '' ELSE ' — ' END || $2 END
      WHERE id = $1`, [wo.open_visit_id, notes.trim()]);
  await logActivity(actor, "Vendor Visits", "Vendor checked out",
    `${wo.vendor_name} left ${wo.institute_name} (${wo.reference})`, { type: "work_order", id: workOrderId });
}

// ── Work photos ────────────────────────────────────────────────────────────

export interface WorkPhoto {
  id: string; work_order_id: string; phase: PhotoPhase; file_path: string;
  original_name: string; caption: string; uploaded_at: string;
}

export async function listPhotos(workOrderId: string): Promise<WorkPhoto[]> {
  const { rows } = await pool.query<WorkPhoto>(
    `SELECT id, work_order_id, phase, file_path, original_name, caption, uploaded_at
       FROM bo_work_photos WHERE work_order_id = $1 ORDER BY uploaded_at`, [workOrderId]);
  return rows;
}

export async function addPhoto(actor: Actor, input: {
  workOrderId: string; phase: PhotoPhase; filePath: string; originalName: string; caption?: string;
}): Promise<WorkPhoto> {
  const wo = await getWorkOrder(input.workOrderId);
  if (!wo) throw missing("That work order was not found.");
  const id = boId("pho");
  await pool.query(
    `INSERT INTO bo_work_photos (id, work_order_id, phase, file_path, original_name, caption, uploaded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, input.workOrderId, input.phase, input.filePath, input.originalName, input.caption?.trim() ?? "", actor.id]);
  await logActivity(actor, "Work Completion", "Photo uploaded",
    `${input.phase} photo on ${wo.reference}`, { type: "work_order", id: input.workOrderId });
  return (await listPhotos(input.workOrderId)).find(p => p.id === id) as WorkPhoto;
}

export async function deletePhoto(actor: Actor, id: string): Promise<string | null> {
  const { rows } = await pool.query<{ file_path: string; work_order_id: string }>(
    `DELETE FROM bo_work_photos WHERE id = $1 RETURNING file_path, work_order_id`, [id]);
  if (!rows.length) throw missing("That photo was not found.");
  await logActivity(actor, "Work Completion", "Photo removed", "", { type: "work_order", id: rows[0].work_order_id });
  return rows[0].file_path;
}

// ── Material delivery ──────────────────────────────────────────────────────

export interface Delivery {
  id: string; reference: string; institute_id: string; institute_name: string;
  material_type: string; description: string; quantity: number;
  vendor_id: string | null; vendor_name: string | null; expected_date: string | null;
  status: DeliveryStatus; received_at: string | null; notified_at: string | null;
  collected_at: string | null; collected_by_name: string; remarks: string; created_at: string;
  images: { id: string; file_path: string; original_name: string }[];
}

export async function listDeliveries(filter: { status?: DeliveryStatus; instituteId?: string } = {}): Promise<Delivery[]> {
  const where: string[] = [];
  const args: unknown[] = [];
  if (filter.status) { args.push(filter.status); where.push(`d.status = $${args.length}`); }
  if (filter.instituteId) { args.push(filter.instituteId); where.push(`d.institute_id = $${args.length}`); }
  const { rows } = await pool.query<Delivery>(
    `SELECT d.id, d.reference, d.institute_id, i.name AS institute_name, d.material_type, d.description,
            d.quantity, d.vendor_id, v.name AS vendor_name, d.expected_date::text AS expected_date, d.status, d.received_at,
            d.notified_at, d.collected_at, d.collected_by_name, d.remarks, d.created_at,
            COALESCE(
              (SELECT json_agg(json_build_object('id', im.id, 'file_path', im.file_path, 'original_name', im.original_name)
                        ORDER BY im.uploaded_at)
                 FROM bo_delivery_images im WHERE im.delivery_id = d.id), '[]'::json) AS images
       FROM bo_deliveries d
       JOIN bo_institutes i ON i.id = d.institute_id
       LEFT JOIN bo_vendors v ON v.id = d.vendor_id
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY d.created_at DESC`, args);
  return rows;
}

export async function createDelivery(actor: Actor, input: {
  instituteId: string; materialType: string; description: string; quantity: number;
  vendorId?: string | null; expectedDate?: string | null; remarks?: string;
}): Promise<Delivery> {
  if (!input.instituteId) throw bad("Pick an institute.");
  if (!input.materialType.trim()) throw bad("Pick a material type.");
  if (!input.description.trim()) throw bad("Describe the material.");
  const inst = await pool.query<{ name: string }>(`SELECT name FROM bo_institutes WHERE id = $1`, [input.instituteId]);
  if (!inst.rowCount) throw missing("That institute was not found.");

  const id = boId("del");
  const reference = await nextReference("bo_deliveries", "DEL");
  await pool.query(
    `INSERT INTO bo_deliveries (id, reference, institute_id, material_type, description, quantity, vendor_id, expected_date, remarks, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [id, reference, input.instituteId, input.materialType.trim(), input.description.trim(),
      Math.max(1, input.quantity || 1), input.vendorId || null, input.expectedDate || null,
      input.remarks?.trim() ?? "", actor.id]);
  await logActivity(actor, "Material Delivery", "Delivery logged",
    `${reference} — ${input.materialType.trim()} for ${inst.rows[0].name}`, { type: "delivery", id });
  return (await listDeliveries()).find(d => d.id === id) as Delivery;
}

export async function addDeliveryImage(deliveryId: string, filePath: string, originalName: string): Promise<void> {
  await pool.query(
    `INSERT INTO bo_delivery_images (id, delivery_id, file_path, original_name) VALUES ($1,$2,$3,$4)`,
    [boId("dim"), deliveryId, filePath, originalName]);
}

const DELIVERY_FLOW: Record<DeliveryStatus, DeliveryStatus[]> = {
  awaiting: ["ready"],
  ready: ["collected"],
  collected: [],
};

export async function advanceDelivery(actor: Actor, id: string, next: DeliveryStatus, collectedBy = ""): Promise<void> {
  const d = await pool.query<{ reference: string; status: DeliveryStatus; institute: string }>(
    `SELECT d.reference, d.status, i.name AS institute FROM bo_deliveries d
       JOIN bo_institutes i ON i.id = d.institute_id WHERE d.id = $1`, [id]);
  if (!d.rowCount) throw missing("That delivery was not found.");
  const cur = d.rows[0];
  if (!DELIVERY_FLOW[cur.status].includes(next)) {
    throw conflict(`A delivery that is "${cur.status}" can't move to "${next}".`);
  }
  await pool.query(
    `UPDATE bo_deliveries SET status = $2,
            received_at  = CASE WHEN $2 = 'ready'     THEN NOW() ELSE received_at END,
            collected_at = CASE WHEN $2 = 'collected' THEN NOW() ELSE collected_at END,
            collected_by_name = CASE WHEN $2 = 'collected' THEN $3 ELSE collected_by_name END
      WHERE id = $1`, [id, next, collectedBy.trim()]);
  await logActivity(actor, "Material Delivery",
    next === "ready" ? "Material received" : "Material collected",
    `${cur.reference} — ${cur.institute}${collectedBy.trim() ? ` (collected by ${collectedBy.trim()})` : ""}`,
    { type: "delivery", id });
}

export async function notifyDelivery(actor: Actor, id: string): Promise<void> {
  const d = await pool.query<{ reference: string; status: DeliveryStatus; institute: string }>(
    `SELECT d.reference, d.status, i.name AS institute FROM bo_deliveries d
       JOIN bo_institutes i ON i.id = d.institute_id WHERE d.id = $1`, [id]);
  if (!d.rowCount) throw missing("That delivery was not found.");
  if (d.rows[0].status !== "ready") throw conflict("Mark the material received before notifying the institute.");
  await pool.query(`UPDATE bo_deliveries SET notified_at = NOW() WHERE id = $1`, [id]);
  await logActivity(actor, "Material Delivery", "Institute notified",
    `${d.rows[0].institute} told ${d.rows[0].reference} is ready for collection`, { type: "delivery", id });
}

// ── Dashboard and reports ──────────────────────────────────────────────────

export interface Kpis {
  totalFrames: number; available: number; inUse: number; retired: number;
  distinctSizes: number; overdue: number;
  pendingRequests: number; openQuotations: number; activeWorkOrders: number;
  vendorsOnSite: number; deliveriesAwaiting: number; deliveriesReady: number;
  institutesHoldingFrames: number; totalInstitutes: number; totalVendors: number;
  sheetLineTotal: number; sheetStatedTotal: number;
}

export async function kpis(): Promise<Kpis> {
  const { rows } = await pool.query<Record<string, string>>(`
    SELECT
      (SELECT COUNT(*) FROM bo_frames WHERE status <> 'retired')                          AS total_frames,
      (SELECT COUNT(*) FROM bo_frames WHERE status = 'available')                         AS available,
      (SELECT COUNT(*) FROM bo_frames WHERE status = 'in_use')                            AS in_use,
      (SELECT COUNT(*) FROM bo_frames WHERE status = 'retired')                           AS retired,
      (SELECT COUNT(DISTINCT size) FROM bo_frames WHERE status <> 'retired')              AS distinct_sizes,
      (SELECT COUNT(*) FROM bo_frame_allocations
        WHERE returned_at IS NULL AND until_date < CURRENT_DATE)                          AS overdue,
      (SELECT COUNT(*) FROM bo_requests
        WHERE status IN ('pending','quoted') AND removed_at IS NULL)                     AS pending_requests,
      (SELECT COUNT(*) FROM bo_quotations q JOIN bo_requests r ON r.id = q.request_id
        WHERE q.status = 'pending' AND q.removed_at IS NULL AND r.removed_at IS NULL)    AS open_quotations,
      (SELECT COUNT(*) FROM bo_work_orders WHERE status NOT IN ('closed'))                AS active_work_orders,
      (SELECT COUNT(*) FROM bo_vendor_visits WHERE check_out_at IS NULL)                  AS vendors_on_site,
      (SELECT COUNT(*) FROM bo_deliveries WHERE status = 'awaiting')                      AS deliveries_awaiting,
      (SELECT COUNT(*) FROM bo_deliveries WHERE status = 'ready')                         AS deliveries_ready,
      (SELECT COUNT(DISTINCT institute_id) FROM bo_frames WHERE status = 'in_use')        AS institutes_holding,
      (SELECT COUNT(*) FROM bo_institutes)                                                AS total_institutes,
      (SELECT COUNT(*) FROM bo_vendors)                                                   AS total_vendors
  `);
  const r = rows[0];
  const n = (k: string) => Number(r[k] ?? "0");
  const { FRAME_SHEET_LINE_TOTAL, FRAME_SHEET_STATED_TOTAL } = await import("./brandops-db.js");
  return {
    totalFrames: n("total_frames"), available: n("available"), inUse: n("in_use"),
    retired: n("retired"), distinctSizes: n("distinct_sizes"), overdue: n("overdue"),
    pendingRequests: n("pending_requests"), openQuotations: n("open_quotations"),
    activeWorkOrders: n("active_work_orders"), vendorsOnSite: n("vendors_on_site"),
    deliveriesAwaiting: n("deliveries_awaiting"), deliveriesReady: n("deliveries_ready"),
    institutesHoldingFrames: n("institutes_holding"), totalInstitutes: n("total_institutes"),
    totalVendors: n("total_vendors"),
    sheetLineTotal: FRAME_SHEET_LINE_TOTAL, sheetStatedTotal: FRAME_SHEET_STATED_TOTAL,
  };
}

export interface SizeBreakdown { size: string; total: number; available: number; in_use: number }

export async function sizeBreakdown(): Promise<SizeBreakdown[]> {
  const { rows } = await pool.query<SizeBreakdown>(`
    SELECT size,
           COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE status = 'available')::int AS available,
           COUNT(*) FILTER (WHERE status = 'in_use')::int AS in_use
      FROM bo_frames WHERE status <> 'retired'
     GROUP BY size ORDER BY COUNT(*) DESC, size`);
  return rows;
}
