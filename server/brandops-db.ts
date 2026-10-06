/**
 * BrandOps — the Branding department's physical-asset and vendor-work system.
 *
 * Two halves that meet at the institute:
 *
 *   1. Frames. Physical branding assets (boards, standees, pillars, T-stands)
 *      that get allocated to an institute for an event and come back. The
 *      point of the system is that identical frames are tracked individually:
 *      "four 10x10 frames, two deployed" is useless without knowing WHICH two.
 *      So every frame is its own row with its own asset id, and allocation is
 *      an append-only history rather than a mutable field.
 *
 *   2. Branding work. An institute raises a requirement, vendors quote, a
 *      quote is approved, that becomes a work order, the vendor visits and
 *      checks in/out, photographs the work, and it is verified and closed.
 *
 * Plus material delivery (printed matter arriving from a vendor and being
 * collected by an institute) and an activity log over everything.
 *
 * Naming: every table is prefixed `bo_` so this module's tables are obvious
 * next to branding's existing ones, which it does not touch.
 */
import { randomBytes } from "node:crypto";
import { pool } from "./db.js";

export function boId(prefix: string): string {
  return `${prefix}-${Date.now()}-${randomBytes(3).toString("hex")}`;
}

// ── Statuses ───────────────────────────────────────────────────────────────

export const FRAME_STATUSES = ["available", "in_use", "retired"] as const;
export type FrameStatus = typeof FRAME_STATUSES[number];

export const REQUEST_STATUSES = ["pending", "quoted", "approved", "in_progress", "completed", "closed", "rejected"] as const;
export type RequestStatus = typeof REQUEST_STATUSES[number];

export const QUOTE_STATUSES = ["pending", "approved", "rejected"] as const;
export type QuoteStatus = typeof QUOTE_STATUSES[number];

/**
 * §"Status flow" in the prototype: Assigned → Vendor Checked In → Work Started
 * → Work Completed → Photos Uploaded → Verified → Closed. Photos-uploaded is
 * not a state here — it's a fact about the photo table, and making it a state
 * would let a work order claim photos it doesn't have.
 */
export const WORK_ORDER_STATUSES = ["assigned", "checked_in", "in_progress", "completed", "verified", "closed"] as const;
export type WorkOrderStatus = typeof WORK_ORDER_STATUSES[number];

export const PHOTO_PHASES = ["before", "during", "after"] as const;
export type PhotoPhase = typeof PHOTO_PHASES[number];

export const DELIVERY_STATUSES = ["awaiting", "ready", "collected"] as const;
export type DeliveryStatus = typeof DELIVERY_STATUSES[number];

export const PRIORITIES = ["normal", "high", "urgent"] as const;
export type Priority = typeof PRIORITIES[number];

// ── Seed data ──────────────────────────────────────────────────────────────

/**
 * The branding frame sheet, as line items rather than 214 literal rows.
 *
 * The source spreadsheet's own Total row says 206 while its line items add up
 * to 214. The line items are the detail and the Total is the summary, so the
 * line items win and the discrepancy is surfaced in the UI rather than being
 * silently reconciled — somebody has to decide which number is wrong, and it
 * isn't this file.
 */
export const FRAME_SHEET: ReadonlyArray<readonly [string, number]> = [
  ["8x8", 9], ["10x10", 15], ["12x8 (medical audi frame)", 7], ["12x8 (self standing)", 1],
  ["10x12", 6], ["4x12", 13], ["4x8", 5], ["6x11", 7], ["5x10", 13], ["10x2", 23],
  ["6x2.5", 15], ["8x10", 1], ["3x5 (standy)", 9], ["8x7", 3], ["7x11", 8], ["6x12", 2],
  ["6x14", 2], ["8x3", 6], ["10x2.5 (pillers)", 4], ["20x2.5 (pillers)", 4],
  ["12x2.5 (pillers)", 2], ["2x7 (pillers)", 2], ["20x2 (pillers)", 1], ["10x2 (pillers)", 4],
  ["Box standy", 28], ["Insta booth", 4], ["T stands", 20],
];

/** What the sheet's own Total row claimed, kept so the UI can show both. */
export const FRAME_SHEET_STATED_TOTAL = 206;

export const FRAME_SHEET_LINE_TOTAL = FRAME_SHEET.reduce((sum, [, qty]) => sum + qty, 0);

/** The 38 institutes, with the faculty each belongs to. */
export const INSTITUTE_SEED: ReadonlyArray<readonly [string, string]> = [
  ["Faculty of Homoeopathy", "Ahmedabad Homoeopathic Medical College"],
  ["Faculty of Homoeopathy", "Rajkot Homoeopathic Medical College"],
  ["Faculty of Homoeopathy", "Jawaharlal Nehru Homoeopathic Medical College"],
  ["Faculty of Homoeopathy", "Parul Institute of Homoeopathy and Research"],
  ["Faculty of Engineering and Technology", "Parul Institute of Engineering and Technology"],
  ["Faculty of Engineering and Technology", "Parul Institute of Engineering and Technology (Diploma Studies)"],
  ["Faculty of Engineering and Technology", "Parul Polytechnic Institute"],
  ["Faculty of Engineering and Technology", "Parul Institute of Technology"],
  ["Faculty of Pharmacy", "Parul Institute of Pharmacy"],
  ["Faculty of Pharmacy", "Parul Institute of Pharmacy and Research"],
  ["Faculty of Pharmacy", "School of Pharmacy"],
  ["Faculty of Pharmacy", "Institute of Pharmaceutical Sciences, Parul University"],
  ["Faculty of Pharmacy", "Parul College of Pharmacy and Research, Bopal"],
  ["Faculty of Pharmacy", "Parul Institute of Pharmaceutical Education and Research"],
  ["Faculty of Ayurved", "Parul Institute of Ayurved"],
  ["Faculty of Ayurved", "Parul Institute of Ayurved and Research"],
  ["Faculty of Management Studies", "Parul Institute of Management and Research"],
  ["Faculty of Management Studies", "Parul Institute of Business Administration"],
  ["Faculty of Physiotherapy", "Parul Institute of Physiotherapy"],
  ["Faculty of Physiotherapy", "Ahmedabad Physiotherapy College"],
  ["Faculty of Physiotherapy", "Parul Institute of Physiotherapy and Research"],
  ["Faculty of Information Technology and Computer Science", "Parul Institute of Computer Application"],
  ["Faculty of Architecture and Planning", "Parul Institute of Architecture and Research"],
  ["Faculty of Nursing", "Parul Institute of Nursing"],
  ["Faculty of Social Work", "Parul Institute of Social Work"],
  ["Faculty of Fine Arts", "Parul Institute of Fine Arts"],
  ["Faculty of Library and Information Science", "Parul Institute of Library and Information Science"],
  ["Faculty of Applied Sciences", "Parul Institute of Applied Sciences"],
  ["Faculty of Medicine", "Parul Institute of Medical Sciences & Research"],
  ["Faculty of Medicine", "Parul Institute of Public Health"],
  ["Faculty of Medicine", "Parul Institute of Paramedical and Health Sciences"],
  ["Faculty of Design", "Parul Institute of Design"],
  ["Faculty of Law", "Parul Institute of Law"],
  ["Faculty of Agriculture", "College of Agriculture, Parul University"],
  ["Faculty of Commerce", "Parul Institute of Commerce"],
  ["Faculty of Arts", "Parul Institute of Arts"],
  ["Faculty of Hotel Management and Catering Technology", "Parul Institute of Hotel Management and Catering Technology"],
  ["Faculty of Performing Arts", "Parul Institute of Performing Arts"],
];

export const DEFAULT_STORE_LOCATION = "Store Room A";

// ── Schema ─────────────────────────────────────────────────────────────────

export async function bootstrapBrandOpsDatabase(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bo_institutes (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      faculty TEXT NOT NULL DEFAULT 'Parul University',
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS bo_vendors (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT NOT NULL DEFAULT '',
      address TEXT NOT NULL DEFAULT '',
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  /**
   * One row per physical frame. `asset_id` is the human-facing label
   * (PU-BR-014) and is what everyone outside this table calls it, so it is
   * unique and used in every UI; `id` stays internal.
   *
   * Current location/institute are denormalised here for the common read
   * ("where is PU-BR-014 right now"), but the authority for history is
   * bo_frame_allocations — these columns are derived from the open allocation.
   */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bo_frames (
      id TEXT PRIMARY KEY,
      asset_id TEXT NOT NULL UNIQUE,
      size TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available','in_use','retired')),
      condition TEXT NOT NULL DEFAULT 'Good',
      location TEXT NOT NULL DEFAULT '${DEFAULT_STORE_LOCATION}',
      institute_id TEXT REFERENCES bo_institutes(id) ON DELETE SET NULL,
      notes TEXT NOT NULL DEFAULT '',
      retired_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS bo_frames_status_idx ON bo_frames(status)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS bo_frames_size_idx ON bo_frames(size)`);

  /**
   * Append-only. An open allocation (returned_at IS NULL) is what makes a
   * frame "in use"; returning sets returned_at rather than deleting the row,
   * so the movement history survives and "where was this frame in September"
   * stays answerable.
   */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bo_frame_allocations (
      id TEXT PRIMARY KEY,
      frame_id TEXT NOT NULL REFERENCES bo_frames(id) ON DELETE CASCADE,
      institute_id TEXT NOT NULL REFERENCES bo_institutes(id) ON DELETE RESTRICT,
      location TEXT NOT NULL,
      event TEXT NOT NULL DEFAULT '',
      from_date DATE NOT NULL,
      until_date DATE NOT NULL,
      allocated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      allocated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      returned_at TIMESTAMPTZ,
      returned_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      return_condition TEXT NOT NULL DEFAULT '',
      return_location TEXT NOT NULL DEFAULT '',
      return_remarks TEXT NOT NULL DEFAULT ''
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS bo_alloc_frame_idx ON bo_frame_allocations(frame_id)`);
  /**
   * The rule that makes double-allocation impossible at the database level
   * rather than only in the handler: one open allocation per frame, ever.
   */
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS bo_alloc_one_open_per_frame
      ON bo_frame_allocations(frame_id) WHERE returned_at IS NULL
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS bo_requests (
      id TEXT PRIMARY KEY,
      reference TEXT NOT NULL UNIQUE,
      institute_id TEXT NOT NULL REFERENCES bo_institutes(id) ON DELETE RESTRICT,
      required_date DATE NOT NULL,
      work_type TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal','high','urgent')),
      description TEXT NOT NULL DEFAULT '',
      location TEXT NOT NULL DEFAULT '',
      quantity INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','quoted','approved','in_progress','completed','closed','rejected')),
      created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS bo_quotations (
      id TEXT PRIMARY KEY,
      reference TEXT NOT NULL UNIQUE,
      request_id TEXT NOT NULL REFERENCES bo_requests(id) ON DELETE CASCADE,
      vendor_id TEXT NOT NULL REFERENCES bo_vendors(id) ON DELETE RESTRICT,
      amount NUMERIC(12,2) NOT NULL CHECK (amount >= 0),
      quote_date DATE NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
      notes TEXT NOT NULL DEFAULT '',
      decided_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      decided_at TIMESTAMPTZ,
      decision_note TEXT NOT NULL DEFAULT '',
      created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS bo_quotes_request_idx ON bo_quotations(request_id)`);
  /** At most one approved quotation per requirement — the one that becomes the work order. */
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS bo_quotes_one_approved_per_request
      ON bo_quotations(request_id) WHERE status = 'approved'
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS bo_work_orders (
      id TEXT PRIMARY KEY,
      reference TEXT NOT NULL UNIQUE,
      request_id TEXT NOT NULL REFERENCES bo_requests(id) ON DELETE CASCADE,
      quotation_id TEXT REFERENCES bo_quotations(id) ON DELETE SET NULL,
      vendor_id TEXT NOT NULL REFERENCES bo_vendors(id) ON DELETE RESTRICT,
      assigned_date DATE NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'assigned'
        CHECK (status IN ('assigned','checked_in','in_progress','completed','verified','closed')),
      verified_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      verified_at TIMESTAMPTZ,
      closed_at TIMESTAMPTZ,
      created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS bo_wo_one_per_request ON bo_work_orders(request_id)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS bo_vendor_visits (
      id TEXT PRIMARY KEY,
      work_order_id TEXT NOT NULL REFERENCES bo_work_orders(id) ON DELETE CASCADE,
      check_in_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      check_out_at TIMESTAMPTZ,
      notes TEXT NOT NULL DEFAULT '',
      recorded_by TEXT REFERENCES users(id) ON DELETE SET NULL
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS bo_visits_wo_idx ON bo_vendor_visits(work_order_id)`);
  /** A vendor can't be on site twice at once. */
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS bo_visits_one_open_per_wo
      ON bo_vendor_visits(work_order_id) WHERE check_out_at IS NULL
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS bo_work_photos (
      id TEXT PRIMARY KEY,
      work_order_id TEXT NOT NULL REFERENCES bo_work_orders(id) ON DELETE CASCADE,
      phase TEXT NOT NULL CHECK (phase IN ('before','during','after')),
      file_path TEXT NOT NULL,
      original_name TEXT NOT NULL DEFAULT '',
      caption TEXT NOT NULL DEFAULT '',
      uploaded_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS bo_photos_wo_idx ON bo_work_photos(work_order_id)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS bo_deliveries (
      id TEXT PRIMARY KEY,
      reference TEXT NOT NULL UNIQUE,
      institute_id TEXT NOT NULL REFERENCES bo_institutes(id) ON DELETE RESTRICT,
      material_type TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      quantity INTEGER NOT NULL DEFAULT 1,
      vendor_id TEXT REFERENCES bo_vendors(id) ON DELETE SET NULL,
      expected_date DATE,
      status TEXT NOT NULL DEFAULT 'awaiting' CHECK (status IN ('awaiting','ready','collected')),
      received_at TIMESTAMPTZ,
      notified_at TIMESTAMPTZ,
      collected_at TIMESTAMPTZ,
      collected_by_name TEXT NOT NULL DEFAULT '',
      remarks TEXT NOT NULL DEFAULT '',
      created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS bo_delivery_images (
      id TEXT PRIMARY KEY,
      delivery_id TEXT NOT NULL REFERENCES bo_deliveries(id) ON DELETE CASCADE,
      file_path TEXT NOT NULL,
      original_name TEXT NOT NULL DEFAULT '',
      uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS bo_delivery_images_idx ON bo_delivery_images(delivery_id)`);

  /**
   * The activity log. Actor name and email are snapshotted inline so an entry
   * still reads correctly after the user row is deleted — the same reason the
   * video workflow does it.
   */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bo_activity (
      id TEXT PRIMARY KEY,
      actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      actor_name TEXT NOT NULL DEFAULT '',
      actor_email TEXT NOT NULL DEFAULT '',
      module TEXT NOT NULL,
      action TEXT NOT NULL,
      details TEXT NOT NULL DEFAULT '',
      entity_type TEXT NOT NULL DEFAULT '',
      entity_id TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS bo_activity_created_idx ON bo_activity(created_at DESC)`);

  /* ── Requirements and quotations, as the branding team asked (Oct 2026) ──
     Additive only: every column has a default or is nullable, so the live
     database gains them on the next start with nothing to backfill. */

  // A size for each requirement — free text, so a new size can be typed.
  await pool.query(`ALTER TABLE bo_requests ADD COLUMN IF NOT EXISTS size TEXT NOT NULL DEFAULT ''`);

  /* "Completed" when the work is finished, recorded with who and when, so a
     requirement can be closed off without running a work order through every
     step. */
  await pool.query(`ALTER TABLE bo_requests ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE bo_requests ADD COLUMN IF NOT EXISTS completed_by TEXT REFERENCES users(id) ON DELETE SET NULL`);
  await pool.query(`ALTER TABLE bo_requests ADD COLUMN IF NOT EXISTS completion_note TEXT NOT NULL DEFAULT ''`);

  /* Removal is a soft delete. A removed requirement leaves every list and
     count, but its row, its quotations and its history stay, with who removed
     it and why. A hard delete would also break reference numbering: a
     "REQ-0007" freed by a delete would be handed out again. */
  await pool.query(`ALTER TABLE bo_requests ADD COLUMN IF NOT EXISTS removed_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE bo_requests ADD COLUMN IF NOT EXISTS removed_by TEXT REFERENCES users(id) ON DELETE SET NULL`);
  await pool.query(`ALTER TABLE bo_requests ADD COLUMN IF NOT EXISTS removal_reason TEXT NOT NULL DEFAULT ''`);

  /* Quotation history: a quotation can be edited and removed, and nothing is
     lost — each edit files the version it replaced in bo_quotation_revisions,
     and a removed quotation is kept, so old and new prices can be compared. */
  await pool.query(`ALTER TABLE bo_quotations ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 1`);
  await pool.query(`ALTER TABLE bo_quotations ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE bo_quotations ADD COLUMN IF NOT EXISTS removed_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE bo_quotations ADD COLUMN IF NOT EXISTS removed_by TEXT REFERENCES users(id) ON DELETE SET NULL`);
  await pool.query(`ALTER TABLE bo_quotations ADD COLUMN IF NOT EXISTS removal_reason TEXT NOT NULL DEFAULT ''`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bo_quotation_revisions (
      id TEXT PRIMARY KEY,
      quotation_id TEXT NOT NULL REFERENCES bo_quotations(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL,
      vendor_id TEXT REFERENCES bo_vendors(id) ON DELETE SET NULL,
      vendor_name TEXT NOT NULL DEFAULT '',
      amount NUMERIC(12,2) NOT NULL,
      quote_date DATE NOT NULL,
      notes TEXT NOT NULL DEFAULT '',
      replaced_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      replaced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (quotation_id, revision)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS bo_quote_revisions_quote_idx ON bo_quotation_revisions(quotation_id)`);

  await seedInstitutes();
  await seedFrames();
}

/** Idempotent: adds any institute from the seed list that isn't present yet. */
async function seedInstitutes(): Promise<void> {
  for (const [faculty, name] of INSTITUTE_SEED) {
    await pool.query(
      `INSERT INTO bo_institutes (id, name, faculty) VALUES ($1, $2, $3)
       ON CONFLICT (name) DO NOTHING`,
      [boId("inst"), name, faculty],
    );
  }
}

/**
 * Creates the frame rows from the sheet, once. Guarded on the table being
 * empty rather than per-asset-id: once the agency starts adding and retiring
 * frames, re-running the seed would resurrect assets they deliberately removed.
 */
async function seedFrames(): Promise<void> {
  const { rows } = await pool.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM bo_frames`);
  if (Number(rows[0]?.count ?? "0") > 0) return;

  let n = 0;
  for (const [size, qty] of FRAME_SHEET) {
    for (let i = 0; i < qty; i++) {
      n += 1;
      await pool.query(
        `INSERT INTO bo_frames (id, asset_id, size, status, location)
         VALUES ($1, $2, $3, 'available', $4) ON CONFLICT (asset_id) DO NOTHING`,
        [boId("frm"), assetIdFor(n), size, DEFAULT_STORE_LOCATION],
      );
    }
  }
}

export function assetIdFor(n: number): string {
  return `PU-BR-${String(n).padStart(3, "0")}`;
}
