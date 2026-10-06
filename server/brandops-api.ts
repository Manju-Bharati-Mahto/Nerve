/**
 * HTTP surface for BrandOps, mounted at /api/brandops.
 *
 * Access has two layers, both enforced here rather than in the UI:
 *
 *   1. Who may reach the module at all — branding admins, super admins, and
 *      users holding the `inventory_manager` role on the branding team.
 *   2. Which modules that person may use — per-user capability grants, so an
 *      admin can hand someone Frame Inventory without handing them Approvals.
 *
 * A branding admin implicitly holds every BrandOps capability; otherwise
 * granting the admin their own permissions before they could grant anyone
 * else's would be a chicken-and-egg problem on first setup.
 */
import type express from "express";
import type multer from "multer";
import { promises as fsp } from "node:fs";
import path from "node:path";

import { listUserCapabilities } from "./db.js";
import { BO_CAPABILITIES, type BoCapability } from "./capabilities.js";
import {
  BoError, type Actor,
  listInstitutes, createInstitute, updateInstitute, deleteInstitute,
  listVendors, createVendor, updateVendor, deleteVendor,
  listFrames, getFrame, frameSizes, nextAssetId, createFrame, updateFrame, retireFrame,
  listAllocations, allocateFrame, returnFrame,
  listRequests, createRequest, setRequestStatus, updateRequest, completeRequest, reopenRequest,
  removeRequest, requestSizes, type RequestInput,
  listQuotations, createQuotation, createQuotationWithNewRequest, updateQuotation, removeQuotation,
  quotationHistory, quoteSummaries, decideQuotation,
  listWorkOrders, getWorkOrder, createWorkOrder, setWorkOrderStatus,
  listVisits, checkIn, checkOut,
  listPhotos, addPhoto, deletePhoto,
  listDeliveries, createDelivery, addDeliveryImage, advanceDelivery, notifyDelivery,
  listActivity, clearActivity, kpis, sizeBreakdown,
} from "./brandops-queries.js";

interface CurrentUser {
  id: string; role: string; team: string | null;
  full_name?: string | null; email?: string | null;
}

interface Deps {
  asyncHandler: (fn: (req: express.Request, res: express.Response) => Promise<unknown>) => express.RequestHandler;
  sendError: (res: express.Response, status: number, message: string) => void;
  getSingleParam: (value: string | string[]) => string;
  upload: multer.Multer;
  uploadsDir: string;
}

export function registerBrandOpsApi(app: express.Express, deps: Deps): void {
  const { asyncHandler, sendError, getSingleParam, upload, uploadsDir } = deps;
  const P = "/api/brandops";

  /** A branding admin runs the department, so they hold every module. */
  function isBrandOpsAdmin(u: CurrentUser): boolean {
    return u.role === "super_admin"
      || (u.role === "admin" && (u.team === "branding" || u.team === null))
      || (u.role === "sub_admin" && u.team === "branding");
  }

  function mayReachModule(u: CurrentUser): boolean {
    return isBrandOpsAdmin(u) || (u.role === "inventory_manager" && u.team === "branding");
  }

  async function requireUser(res: express.Response): Promise<CurrentUser | null> {
    const u = res.locals.currentUser as CurrentUser | undefined;
    if (!u) { sendError(res, 401, "Authentication required."); return null; }
    if (!mayReachModule(u)) { sendError(res, 403, "This area is for the branding team's inventory managers."); return null; }
    return u;
  }

  /**
   * Checks one capability. Admins pass everything; an inventory manager passes
   * only what they have been granted, so turning a tab off in the Team Panel
   * closes the API too and not merely the sidebar entry.
   */
  async function require(res: express.Response, capability: BoCapability): Promise<CurrentUser | null> {
    const u = await requireUser(res);
    if (!u) return null;
    if (isBrandOpsAdmin(u)) return u;
    const held = await listUserCapabilities(u.id);
    if (!held.includes(capability)) {
      sendError(res, 403, "You don't have access to that part of BrandOps.");
      return null;
    }
    return u;
  }

  /**
   * Passes anyone holding ANY of the listed capabilities. For reads that more
   * than one tab shows — a requirement's quotations appear behind the ⓘ on the
   * Dashboard as well as on Requests, Quotations and Approvals, and someone
   * given only the Dashboard must still be able to open it.
   */
  async function requireAny(res: express.Response, capabilities: BoCapability[]): Promise<CurrentUser | null> {
    const u = await requireUser(res);
    if (!u) return null;
    if (isBrandOpsAdmin(u)) return u;
    const held = await listUserCapabilities(u.id);
    if (!capabilities.some(c => held.includes(c))) {
      sendError(res, 403, "You don't have access to that part of BrandOps.");
      return null;
    }
    return u;
  }

  const actorOf = (u: CurrentUser): Actor => ({ id: u.id, full_name: u.full_name, email: u.email });

  function fail(res: express.Response, err: unknown): void {
    if (err instanceof BoError) return sendError(res, err.status, err.message);
    const msg = err instanceof Error ? err.message : "Something went wrong.";
    sendError(res, 400, msg);
  }

  /** Wraps a handler so domain errors land on the right status every time. */
  const handle = (cap: BoCapability, fn: (u: CurrentUser, req: express.Request, res: express.Response) => Promise<unknown>) =>
    asyncHandler(async (req, res) => {
      const u = await require(res, cap);
      if (!u) return;
      try { await fn(u, req, res); } catch (err) { fail(res, err); }
    });

  const body = (req: express.Request) => (req.body ?? {}) as Record<string, unknown>;
  const str = (v: unknown, fallback = "") => (typeof v === "string" ? v : fallback);
  const num = (v: unknown, fallback = 0) => (typeof v === "number" ? v : Number(v) || fallback);

  // ── Who am I / what can I see ────────────────────────────────────────────

  app.get(`${P}/me`, asyncHandler(async (_req, res) => {
    const u = await requireUser(res); if (!u) return;
    const admin = isBrandOpsAdmin(u);
    const granted = admin ? [...BO_CAPABILITIES] : (await listUserCapabilities(u.id)).filter(
      (k): k is BoCapability => (BO_CAPABILITIES as readonly string[]).includes(k));
    res.json({ admin, capabilities: granted });
  }));

  // ── Dashboard ────────────────────────────────────────────────────────────

  app.get(`${P}/dashboard`, handle("brandops:dashboard", async (_u, _req, res) => {
    const [k, sizes, open, pending] = await Promise.all([
      kpis(), sizeBreakdown(), listAllocations({ open: true, limit: 100 }),
      listRequests({}),
    ]);
    /* Outstanding = work still ahead of it. Completed, closed and rejected
       requirements are done one way or another; removed ones are already
       excluded by listRequests. */
    const outstanding = pending
      .filter(r => r.status !== "closed" && r.status !== "rejected" && r.status !== "completed")
      .slice(0, 50);
    res.json({
      kpis: k, sizes, allocations: open,
      requests: outstanding,
      // The quotations behind each row, for the amount and the ⓘ view.
      quotes: await quoteSummaries(outstanding.map(r => r.id)),
    });
  }));

  app.get(`${P}/reports`, handle("brandops:reports", async (_u, _req, res) => {
    const [k, sizes, institutes] = await Promise.all([kpis(), sizeBreakdown(), listInstitutes()]);
    res.json({ kpis: k, sizes, institutes, sheet: await import("./brandops-db.js").then(m => m.FRAME_SHEET) });
  }));

  // ── Institutes ───────────────────────────────────────────────────────────

  app.get(`${P}/institutes`, asyncHandler(async (_req, res) => {
    // Readable by anyone in the module: every form needs the dropdown.
    const u = await requireUser(res); if (!u) return;
    res.json({ institutes: await listInstitutes() });
  }));

  app.post(`${P}/institutes`, handle("brandops:institutes", async (u, req, res) => {
    const b = body(req);
    res.status(201).json({ institute: await createInstitute(actorOf(u), str(b.name), str(b.faculty)) });
  }));

  app.patch(`${P}/institutes/:id`, handle("brandops:institutes", async (u, req, res) => {
    const b = body(req);
    await updateInstitute(actorOf(u), getSingleParam(req.params.id), {
      name: b.name === undefined ? undefined : str(b.name),
      faculty: b.faculty === undefined ? undefined : str(b.faculty),
      active: b.active === undefined ? undefined : Boolean(b.active),
    });
    res.json({ ok: true });
  }));

  app.delete(`${P}/institutes/:id`, handle("brandops:institutes", async (u, req, res) => {
    await deleteInstitute(actorOf(u), getSingleParam(req.params.id));
    res.json({ deleted: true });
  }));

  // ── Vendors ──────────────────────────────────────────────────────────────

  app.get(`${P}/vendors`, asyncHandler(async (_req, res) => {
    const u = await requireUser(res); if (!u) return;
    res.json({ vendors: await listVendors() });
  }));

  app.post(`${P}/vendors`, handle("brandops:vendors", async (u, req, res) => {
    const b = body(req);
    res.status(201).json({ vendor: await createVendor(actorOf(u), {
      name: str(b.name), phone: str(b.phone), address: str(b.address),
    }) });
  }));

  app.patch(`${P}/vendors/:id`, handle("brandops:vendors", async (u, req, res) => {
    const b = body(req);
    await updateVendor(actorOf(u), getSingleParam(req.params.id), {
      name: b.name === undefined ? undefined : str(b.name),
      phone: b.phone === undefined ? undefined : str(b.phone),
      address: b.address === undefined ? undefined : str(b.address),
      active: b.active === undefined ? undefined : Boolean(b.active),
    });
    res.json({ ok: true });
  }));

  app.delete(`${P}/vendors/:id`, handle("brandops:vendors", async (u, req, res) => {
    await deleteVendor(actorOf(u), getSingleParam(req.params.id));
    res.json({ deleted: true });
  }));

  // ── Frames ───────────────────────────────────────────────────────────────

  app.get(`${P}/frames`, handle("brandops:frame_inventory", async (_u, req, res) => {
    const q = req.query as Record<string, string>;
    const [frames, sizes, nextId] = await Promise.all([
      listFrames({
        q: q.q || undefined,
        status: (q.status as never) || undefined,
        size: q.size || undefined,
        instituteId: q.institute_id || undefined,
      }),
      frameSizes(), nextAssetId(),
    ]);
    res.json({ frames, sizes, next_asset_id: nextId });
  }));

  app.get(`${P}/frames/:id`, handle("brandops:frame_inventory", async (_u, req, res) => {
    const id = getSingleParam(req.params.id);
    const frame = await getFrame(id);
    if (!frame) return sendError(res, 404, "That frame was not found.");
    res.json({ frame, history: await listAllocations({ frameId: frame.id }) });
  }));

  app.post(`${P}/frames`, handle("brandops:frame_inventory", async (u, req, res) => {
    const b = body(req);
    res.status(201).json({ frame: await createFrame(actorOf(u), {
      assetId: str(b.asset_id) || undefined, size: str(b.size),
      location: str(b.location) || undefined, condition: str(b.condition) || undefined,
      notes: str(b.notes) || undefined,
    }) });
  }));

  app.patch(`${P}/frames/:id`, handle("brandops:frame_inventory", async (u, req, res) => {
    const b = body(req);
    await updateFrame(actorOf(u), getSingleParam(req.params.id), {
      size: b.size === undefined ? undefined : str(b.size),
      condition: b.condition === undefined ? undefined : str(b.condition),
      location: b.location === undefined ? undefined : str(b.location),
      notes: b.notes === undefined ? undefined : str(b.notes),
    });
    res.json({ ok: true });
  }));

  app.delete(`${P}/frames/:id`, handle("brandops:frame_inventory", async (u, req, res) => {
    await retireFrame(actorOf(u), getSingleParam(req.params.id));
    res.json({ deleted: true });
  }));

  // ── In use / allocation / return ─────────────────────────────────────────

  app.get(`${P}/allocations`, asyncHandler(async (req, res) => {
    const u = await requireUser(res); if (!u) return;
    const q = req.query as Record<string, string>;
    const open = q.open === "true" ? true : q.open === "false" ? false : undefined;
    res.json({ allocations: await listAllocations({
      open, frameId: q.frame_id || undefined, instituteId: q.institute_id || undefined,
    }) });
  }));

  app.post(`${P}/allocations`, handle("brandops:allocate", async (u, req, res) => {
    const b = body(req);
    res.status(201).json({ allocation: await allocateFrame(actorOf(u), {
      frameId: str(b.frame_id), instituteId: str(b.institute_id), location: str(b.location),
      event: str(b.event), from: str(b.from_date), until: str(b.until_date),
    }) });
  }));

  app.post(`${P}/frames/:id/return`, handle("brandops:frame_return", async (u, req, res) => {
    const b = body(req);
    await returnFrame(actorOf(u), {
      frameId: getSingleParam(req.params.id),
      condition: str(b.condition) || undefined, location: str(b.location) || undefined,
      remarks: str(b.remarks) || undefined, returnedAt: str(b.returned_at) || undefined,
    });
    res.json({ ok: true });
  }));

  // ── Branding requirements ────────────────────────────────────────────────

  /** A requirement as the forms send it. */
  const requestInput = (b: Record<string, unknown>): RequestInput => ({
    instituteId: str(b.institute_id), requiredDate: str(b.required_date),
    workType: str(b.work_type), priority: (str(b.priority, "normal") as never),
    description: str(b.description), location: str(b.location), quantity: num(b.quantity, 1),
    size: str(b.size),
  });

  /* Readable from Quotations as well as Requests: adding a quotation means
     finding the requirement it is for, and someone given only the Quotations
     tab must be able to search them. Changing a requirement still needs the
     Requests capability — this is the list, read-only. */
  app.get(`${P}/requests`, asyncHandler(async (req, res) => {
    const u = await requireAny(res, ["brandops:requests", "brandops:quotations"]);
    if (!u) return;
    try {
      const q = req.query as Record<string, string>;
      const [requests, sizes] = await Promise.all([
        listRequests({
          status: (q.status as never) || undefined,
          instituteId: q.institute_id || undefined, q: q.q || undefined,
        }),
        requestSizes(),
      ]);
      res.json({ requests, sizes });
    } catch (err) { fail(res, err); }
  }));

  app.post(`${P}/requests`, handle("brandops:requests", async (u, req, res) => {
    res.status(201).json({ request: await createRequest(actorOf(u), requestInput(body(req))) });
  }));

  /**
   * Edits a requirement's details; or, sent `{ status }` alone, sets its
   * status the way it always has.
   */
  app.patch(`${P}/requests/:id`, handle("brandops:requests", async (u, req, res) => {
    const b = body(req);
    const id = getSingleParam(req.params.id);
    if (Object.keys(b).length === 1 && "status" in b) {
      await setRequestStatus(actorOf(u), id, str(b.status) as never);
      return void res.json({ ok: true });
    }
    res.json({ request: await updateRequest(actorOf(u), id, requestInput(b)) });
  }));

  /** Marks the work finished. */
  app.post(`${P}/requests/:id/complete`, handle("brandops:requests", async (u, req, res) => {
    await completeRequest(actorOf(u), getSingleParam(req.params.id), str(body(req).note));
    res.json({ ok: true });
  }));

  /** Undoes "Completed", for a requirement marked done by mistake. */
  app.post(`${P}/requests/:id/reopen`, handle("brandops:requests", async (u, req, res) => {
    res.json({ status: await reopenRequest(actorOf(u), getSingleParam(req.params.id)) });
  }));

  /**
   * Removes a requirement — from Branding Requests and the Dashboard alike,
   * since both read the same row. Requires the Requests capability wherever
   * the button is pressed: being able to SEE the Dashboard is not the same as
   * being allowed to delete work from it.
   */
  app.delete(`${P}/requests/:id`, handle("brandops:requests", async (u, req, res) => {
    await removeRequest(actorOf(u), getSingleParam(req.params.id), str(body(req).reason));
    res.json({ removed: true });
  }));

  /** A requirement's full quotation history — what the ⓘ view and comparison show. */
  app.get(`${P}/requests/:id/quotations`, asyncHandler(async (req, res) => {
    const u = await requireAny(res, ["brandops:dashboard", "brandops:requests", "brandops:quotations", "brandops:approvals"]);
    if (!u) return;
    try {
      const history = await quotationHistory(getSingleParam(req.params.id));
      if (!history.request && !history.quotations.length) return sendError(res, 404, "That requirement was not found.");
      res.json(history);
    } catch (err) { fail(res, err); }
  }));

  // ── Quotations ───────────────────────────────────────────────────────────

  app.get(`${P}/quotations`, handle("brandops:quotations", async (_u, req, res) => {
    const q = req.query as Record<string, string>;
    res.json({ quotations: await listQuotations({
      status: (q.status as never) || undefined, requestId: q.request_id || undefined,
      includeRemoved: q.include_removed === "1" || q.include_removed === "true",
    }) });
  }));

  /** The amount is required and must be a real number — a typo is not ₹0. */
  const amountOf = (v: unknown): number => {
    if (typeof v === "number") return v;
    if (typeof v === "string" && v.trim() !== "") return Number(v);
    return Number.NaN;
  };

  /**
   * Adds a quotation, against a requirement picked from the list
   * (`request_id`) or one typed into the form (`new_requirement`), which is
   * created in the same step.
   */
  app.post(`${P}/quotations`, handle("brandops:quotations", async (u, req, res) => {
    const b = body(req);
    const quote = { vendorId: str(b.vendor_id), amount: amountOf(b.amount), quoteDate: str(b.quote_date), notes: str(b.notes) };
    const typed = b.new_requirement;
    if (typed && typeof typed === "object" && !str(b.request_id)) {
      return void res.status(201).json({
        quotation: await createQuotationWithNewRequest(actorOf(u), requestInput(typed as Record<string, unknown>), quote),
      });
    }
    res.status(201).json({ quotation: await createQuotation(actorOf(u), { ...quote, requestId: str(b.request_id) }) });
  }));

  /** Edits a quotation, keeping the version it replaces. */
  app.patch(`${P}/quotations/:id`, handle("brandops:quotations", async (u, req, res) => {
    const b = body(req);
    res.json({ quotation: await updateQuotation(actorOf(u), getSingleParam(req.params.id), {
      vendorId: "vendor_id" in b ? str(b.vendor_id) : undefined,
      amount: "amount" in b ? amountOf(b.amount) : undefined,
      quoteDate: "quote_date" in b ? str(b.quote_date) : undefined,
      notes: "notes" in b ? str(b.notes) : undefined,
    }) });
  }));

  /** Removes a quotation from the lists; it stays in the requirement's history. */
  app.delete(`${P}/quotations/:id`, handle("brandops:quotations", async (u, req, res) => {
    await removeQuotation(actorOf(u), getSingleParam(req.params.id), str(body(req).reason));
    res.json({ removed: true });
  }));

  // ── Approvals ────────────────────────────────────────────────────────────

  /** Separate capability from Quotations: raising a price and agreeing to it
   *  are different jobs, and the prototype gives them separate tabs. */
  app.get(`${P}/approvals`, handle("brandops:approvals", async (_u, _req, res) => {
    res.json({ quotations: await listQuotations({ status: "pending" }) });
  }));

  app.post(`${P}/quotations/:id/decision`, handle("brandops:approvals", async (u, req, res) => {
    const b = body(req);
    const decision = str(b.decision);
    if (decision !== "approved" && decision !== "rejected") {
      return sendError(res, 400, "Decision must be approved or rejected.");
    }
    await decideQuotation(actorOf(u), getSingleParam(req.params.id), decision, str(b.note));
    res.json({ ok: true });
  }));

  // ── Work orders ──────────────────────────────────────────────────────────

  app.get(`${P}/work-orders`, handle("brandops:work_orders", async (_u, req, res) => {
    const q = req.query as Record<string, string>;
    res.json({ work_orders: await listWorkOrders({ status: (q.status as never) || undefined, q: q.q || undefined }) });
  }));

  app.get(`${P}/work-orders/:id`, handle("brandops:work_orders", async (_u, req, res) => {
    const id = getSingleParam(req.params.id);
    const wo = await getWorkOrder(id);
    if (!wo) return sendError(res, 404, "That work order was not found.");
    res.json({ work_order: wo, visits: await listVisits({ workOrderId: id }), photos: await listPhotos(id) });
  }));

  app.post(`${P}/work-orders`, handle("brandops:work_orders", async (u, req, res) => {
    const b = body(req);
    res.status(201).json({ work_order: await createWorkOrder(actorOf(u), {
      requestId: str(b.request_id), assignedDate: str(b.assigned_date), description: str(b.description),
    }) });
  }));

  app.patch(`${P}/work-orders/:id`, handle("brandops:work_orders", async (u, req, res) => {
    await setWorkOrderStatus(actorOf(u), getSingleParam(req.params.id), str(body(req).status) as never);
    res.json({ ok: true });
  }));

  // ── Vendor visits ────────────────────────────────────────────────────────

  app.get(`${P}/visits`, handle("brandops:vendor_visits", async (_u, req, res) => {
    const q = req.query as Record<string, string>;
    res.json({
      visits: await listVisits({ workOrderId: q.work_order_id || undefined, open: q.open === "true" }),
      work_orders: await listWorkOrders({}),
    });
  }));

  app.post(`${P}/work-orders/:id/check-in`, handle("brandops:vendor_visits", async (u, req, res) => {
    await checkIn(actorOf(u), getSingleParam(req.params.id), str(body(req).notes));
    res.json({ ok: true });
  }));

  app.post(`${P}/work-orders/:id/check-out`, handle("brandops:vendor_visits", async (u, req, res) => {
    await checkOut(actorOf(u), getSingleParam(req.params.id), str(body(req).notes));
    res.json({ ok: true });
  }));

  // ── Work completion and photos ───────────────────────────────────────────

  app.get(`${P}/completion`, handle("brandops:completion", async (_u, _req, res) => {
    const orders = await listWorkOrders({});
    res.json({ work_orders: orders.filter(w => w.status !== "closed") });
  }));

  app.post(`${P}/work-orders/:id/photos`, upload.array("photos", 10),
    asyncHandler(async (req, res) => {
      const u = await require(res, "brandops:completion"); if (!u) return;
      const files = (req.files as Express.Multer.File[] | undefined) ?? [];
      if (!files.length) return sendError(res, 400, "Choose at least one photo to upload.");
      const phase = String((req.body as Record<string, unknown>).phase ?? "after");
      if (!["before", "during", "after"].includes(phase)) {
        await Promise.all(files.map(f => fsp.rm(f.path, { force: true })));
        return sendError(res, 400, "Phase must be before, during or after.");
      }
      try {
        const id = getSingleParam(req.params.id);
        const added = [];
        for (const f of files) {
          added.push(await addPhoto({ id: u.id, full_name: u.full_name, email: u.email }, {
            workOrderId: id, phase: phase as never,
            filePath: `/uploads/brandops/${path.basename(f.path)}`,
            originalName: f.originalname,
            caption: String((req.body as Record<string, unknown>).caption ?? ""),
          }));
        }
        res.status(201).json({ photos: added });
      } catch (err) {
        await Promise.all(files.map(f => fsp.rm(f.path, { force: true })));
        fail(res, err);
      }
    }));

  app.delete(`${P}/photos/:id`, handle("brandops:completion", async (u, req, res) => {
    const filePath = await deletePhoto(actorOf(u), getSingleParam(req.params.id));
    if (filePath) await fsp.rm(path.join(uploadsDir, path.basename(filePath)), { force: true }).catch(() => {});
    res.json({ deleted: true });
  }));

  // ── Material delivery ────────────────────────────────────────────────────

  app.get(`${P}/deliveries`, handle("brandops:material_delivery", async (_u, req, res) => {
    const q = req.query as Record<string, string>;
    res.json({ deliveries: await listDeliveries({
      status: (q.status as never) || undefined, instituteId: q.institute_id || undefined,
    }) });
  }));

  app.post(`${P}/deliveries`, upload.array("images", 10), asyncHandler(async (req, res) => {
    const u = await require(res, "brandops:material_delivery"); if (!u) return;
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    const b = (req.body ?? {}) as Record<string, string>;
    try {
      const delivery = await createDelivery({ id: u.id, full_name: u.full_name, email: u.email }, {
        instituteId: b.institute_id ?? "", materialType: b.material_type ?? "",
        description: b.description ?? "", quantity: Number(b.quantity) || 1,
        vendorId: b.vendor_id || null, expectedDate: b.expected_date || null, remarks: b.remarks ?? "",
      });
      for (const f of files) {
        await addDeliveryImage(delivery.id, `/uploads/brandops/${path.basename(f.path)}`, f.originalname);
      }
      const [fresh] = await listDeliveries({});
      res.status(201).json({ delivery: fresh ?? delivery });
    } catch (err) {
      await Promise.all(files.map(f => fsp.rm(f.path, { force: true })));
      fail(res, err);
    }
  }));

  app.post(`${P}/deliveries/:id/received`, handle("brandops:material_delivery", async (u, req, res) => {
    await advanceDelivery(actorOf(u), getSingleParam(req.params.id), "ready");
    res.json({ ok: true });
  }));

  app.post(`${P}/deliveries/:id/notify`, handle("brandops:material_delivery", async (u, req, res) => {
    await notifyDelivery(actorOf(u), getSingleParam(req.params.id));
    res.json({ ok: true });
  }));

  app.post(`${P}/deliveries/:id/collected`, handle("brandops:material_delivery", async (u, req, res) => {
    await advanceDelivery(actorOf(u), getSingleParam(req.params.id), "collected", str(body(req).collected_by));
    res.json({ ok: true });
  }));

  // ── Activity ─────────────────────────────────────────────────────────────

  app.get(`${P}/activity`, handle("brandops:activity", async (_u, req, res) => {
    const q = req.query as Record<string, string>;
    res.json({ activity: await listActivity({
      module: q.module || undefined, q: q.q || undefined,
      from: q.from || undefined, to: q.to || undefined,
      limit: q.limit ? Number(q.limit) : undefined,
    }) });
  }));

  /** Clearing history is an admin act — §"no workflow action erases history"
   *  doesn't apply here, but an inventory manager shouldn't be able to cover
   *  their own tracks either. */
  app.delete(`${P}/activity`, asyncHandler(async (_req, res) => {
    const u = await requireUser(res); if (!u) return;
    if (!isBrandOpsAdmin(u)) return sendError(res, 403, "Only a branding admin can clear the activity log.");
    res.json({ cleared: await clearActivity(actorOf(u)) });
  }));
}
