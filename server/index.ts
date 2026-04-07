import express from "express";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import { z } from "zod";
import {
  bootstrapSettingsDatabase,
  getAllSettings,
  setSettings,
  getSetting,
  createPasswordResetToken,
  consumePasswordResetToken,
  createEmailVerificationToken,
  consumeEmailVerificationToken,
} from "./settings-db.js";
import {
  sendMail,
  passwordResetEmail,
  emailVerificationMail,
} from "./mailer.js";
import { config } from "./config.js";
import {
  bootstrapDatabase,
  createBrandingRow,
  createEntry,
  createTeam,
  createUser,
  deleteBrandingRow,
  deleteEntry,
  deleteTeam,
  deleteUser,
  getBootstrapData,
  getUserByEmail,
  getUserById,
  listBrandingRows,
  listEntries,
  listTeams,
  listUsers,
  pool,
  updateBrandingRow,
  updateUser,
  type AppRole,
} from "./db.js";
import { verifyPassword } from "./password.js";
import {
  bootstrapBrandingDatabase,
  listWorkCategories,
  createWorkCategory,
  updateWorkCategory,
  deleteWorkCategory,
  createWorkSubCategory,
  updateWorkSubCategory,
  deleteWorkSubCategory,
  reorderWorkCategories,
  getOrCreateDailyReport,
  saveReportRows,
  submitDailyReport,
  listAllDailyReports,
  getUserAnalytics,
  listKraParameters,
  getPeerMarkingEnabled,
  togglePeerMarking,
  getSelfAppraisal,
  submitSelfAppraisal,
  getCompletedPeerMarkings,
  submitPeerMarking,
  getPeerMarkingsForUser,
  getAllPeerMarkings,
  getAdminKraScore,
  setAdminKraScore,
  finalPushKra,
  getKraReport,
  getAdminKraDashboard,
  listBrandingProjects,
  createBrandingProject,
  updateBrandingProject,
  deleteBrandingProject,
  getTeamReportStatus,
  getBrandingPortalStats,
  listBrandingDesigns,
  createBrandingDesign,
  deleteBrandingDesign,
  getBrandingDesignById,
  castDesignVote,
  getDesignVoters,
  applyLeave,
  getUserLeaves,
  getAllLeaves,
  reviewLeave,
  updateLeaveTransfer,
  cancelLeave,
  getLeaveForDate,
} from "./branding-db.js";

const app = express();
const PgStore = connectPgSimple(session);

// ── File upload setup ──────────────────────────────────────────────────────
const UPLOADS_DIR = path.resolve("uploads/branding");
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const AVATARS_DIR = path.resolve("uploads/avatars");
fs.mkdirSync(AVATARS_DIR, { recursive: true });

const avatarUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, AVATARS_DIR),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
    },
  }),
  limits: { fileSize: 3 * 1024 * 1024 }, // 3 MB
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith("image/")) cb(null, true);
    else cb(new Error("Only image files are allowed."));
  },
});

const designUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith("image/")) cb(null, true);
    else cb(new Error("Only image files are allowed."));
  },
});

app.set("trust proxy", 1);
app.use("/uploads", express.static(path.resolve("uploads")));
app.use(express.json());
app.use(
  session({
    store: new PgStore({
      pool,
      tableName: "session",
      createTableIfMissing: true,
    }),
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: config.cookieSecure,
      maxAge: 1000 * 60 * 60 * 24 * 7,
    },
  }),
);

type SessionRequest = express.Request & {
  session: express.Request["session"] & { userId?: string };
};

const roles = ["super_admin", "admin", "sub_admin", "user"] as const;

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const entrySchema = z.object({
  title: z.string().min(1),
  dept: z.string().min(1),
  type: z.string().min(1),
  body: z.string().min(1),
  priority: z.enum(["Normal", "High", "Key highlight"]),
  entry_date: z.string().min(1),
  created_by: z.string().nullable(),
  tags: z.array(z.string()).default([]),
  author_name: z.string().default(""),
  academic_year: z.string().default(""),
  student_count: z.number().int().nullable(),
  external_link: z.string().default(""),
  collaborating_org: z.string().default(""),
});

const createUserSchema = z.object({
  full_name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(1),
  department: z.string().default(""),
  role: z.enum(roles),
  team: z.string().nullable(),
  managed_by: z.string().nullable(),
});

const updateUserSchema = z.object({
  full_name: z.string().min(1).optional(),
  email: z.string().email().optional(),
  password: z.string().min(1).optional(),
  department: z.string().optional(),
  role: z.enum(roles).optional(),
  team: z.string().nullable().optional(),
  managed_by: z.string().nullable().optional(),
});

const teamSchema = z.object({
  name: z.string().min(1),
  color: z.string().min(1),
});

const brandingRowSchema = z.object({
  category: z.string().optional(),
  sub_category: z.string().optional(),
  time_taken: z.string().optional(),
  team_member: z.string().optional(),
  project_name: z.string().optional(),
  additional_info: z.string().optional(),
});

function sendError(res: express.Response, status: number, message: string) {
  return res.status(status).json({ message });
}

function asyncHandler(
  handler: (req: express.Request, res: express.Response, next: express.NextFunction) => Promise<unknown>,
): express.RequestHandler {
  return (req, res, next) => {
    void handler(req, res, next).catch(next);
  };
}

function isPgUniqueViolation(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

function getSingleParam(value: string | string[]) {
  return Array.isArray(value) ? value[0] : value;
}

async function getSessionUser(req: SessionRequest) {
  if (!req.session.userId) return null;
  return getUserById(req.session.userId);
}

function isBrandingManager(role: AppRole, team: string | null) {
  return role === "super_admin" || (team === "branding" && (role === "admin" || role === "sub_admin" || role === "user"));
}

function canCreateManagedUser(
  actor: Awaited<ReturnType<typeof getUserById>>,
  payload: z.infer<typeof createUserSchema>,
) {
  if (!actor) return false;
  if (actor.role === "super_admin") return true;
  if (actor.role !== "admin") return false;
  return actor.team !== null && payload.team === actor.team && ["sub_admin", "user"].includes(payload.role);
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "nerve-api" });
});

app.get("/api/auth/me", asyncHandler(async (req, res) => {
  const user = await getSessionUser(req as SessionRequest);
  res.json({ user: user ? { ...user, password_hash: undefined } : null });
}));

app.post("/api/auth/login", asyncHandler(async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return sendError(res, 400, "Invalid login payload.");

  const user = await getUserByEmail(parsed.data.email);
  if (!user) return sendError(res, 401, "Invalid email or password.");

  const valid = await verifyPassword(parsed.data.password, user.password_hash);
  if (!valid) return sendError(res, 401, "Invalid email or password.");

  // Check email verification if enabled
  const emailVerificationRequired = (await getSetting("auth.email_verification")) === "true";
  if (emailVerificationRequired && !user.email_verified && user.role !== "super_admin") {
    return sendError(res, 403, "EMAIL_NOT_VERIFIED");
  }

  (req as SessionRequest).session.userId = user.id;
  res.json({ user: { ...user, password_hash: undefined } });
}));

app.post("/api/auth/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("connect.sid");
    res.json({ ok: true });
  });
});

// ── Forgot / Reset password (public) ──────────────────────────────────────

app.post("/api/auth/forgot-password", asyncHandler(async (req, res) => {
  const { email } = req.body as { email?: string };
  if (!email?.trim()) return sendError(res, 400, "Email is required.");
  // Always return 200 to prevent email enumeration
  const user = await getUserByEmail(email.trim());
  if (user) {
    const raw = await createPasswordResetToken(user.id);
    const resetUrl = `${(process.env.APP_BASE_URL || "http://localhost:8080")}/reset-password?token=${raw}`;
    await sendMail({
      to: user.email,
      subject: "Password Reset — Parul University Knowledge Hub",
      html: passwordResetEmail(user.full_name, resetUrl),
    });
  }
  res.json({ ok: true });
}));

app.post("/api/auth/reset-password", asyncHandler(async (req, res) => {
  const { token, password } = req.body as { token?: string; password?: string };
  if (!token || !password) return sendError(res, 400, "Token and new password are required.");
  if (password.length < 6) return sendError(res, 400, "Password must be at least 6 characters.");
  const userId = await consumePasswordResetToken(token);
  if (!userId) return sendError(res, 400, "Reset link is invalid or has expired.");
  const { hashPassword } = await import("./password.js");
  await updateUser(userId, { password });
  res.json({ ok: true });
}));

// ── Email verification (public) ────────────────────────────────────────────

app.post("/api/auth/send-verification", asyncHandler(async (req, res) => {
  const { email } = req.body as { email?: string };
  if (!email?.trim()) return sendError(res, 400, "Email required.");
  const user = await getUserByEmail(email.trim());
  if (!user) return res.json({ ok: true }); // silent
  const raw = await createEmailVerificationToken(user.id);
  const verifyUrl = `${(process.env.APP_BASE_URL || "http://localhost:8080")}/verify-email?token=${raw}`;
  await sendMail({
    to: user.email,
    subject: "Verify your email — Parul University Knowledge Hub",
    html: emailVerificationMail(user.full_name, verifyUrl),
  });
  res.json({ ok: true });
}));

app.get("/api/auth/verify-email", asyncHandler(async (req, res) => {
  const token = getSingleParam((req.query as Record<string, string>).token ?? "");
  if (!token) return sendError(res, 400, "Token required.");
  const userId = await consumeEmailVerificationToken(token);
  if (!userId) return sendError(res, 400, "Verification link is invalid or has expired.");
  res.json({ ok: true });
}));

app.use("/api", asyncHandler(async (req, res, next) => {
  if (req.path === "/health" || req.path.startsWith("/auth/")) return next();
  const user = await getSessionUser(req as SessionRequest);
  if (!user) return sendError(res, 401, "Authentication required.");
  res.locals.currentUser = user;
  return next();
}));

// ── App settings (super admin) ─────────────────────────────────────────────

app.get("/api/settings", asyncHandler(async (_req, res) => {
  if (res.locals.currentUser.role !== "super_admin") return sendError(res, 403, "Super admin only.");
  res.json({ settings: await getAllSettings() });
}));

app.patch("/api/settings", asyncHandler(async (req, res) => {
  if (res.locals.currentUser.role !== "super_admin") return sendError(res, 403, "Super admin only.");
  const patch = req.body as Record<string, string>;
  if (typeof patch !== "object" || Array.isArray(patch)) return sendError(res, 400, "Invalid payload.");
  // Sanitise: only allow known keys (don't write arbitrary data)
  const ALLOWED_KEYS = new Set([
    "site.name", "site.timezone",
    "auth.session_timeout_hours", "auth.max_login_attempts", "auth.email_verification",
    "branding.delete_window_mins",
    "smtp.host", "smtp.port", "smtp.user", "smtp.from",
    "smtp.pass",
    "design_gallery.enabled", "daily_reports.enabled", "kra_appraisal.enabled",
  ]);
  const filtered: Record<string, string> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (ALLOWED_KEYS.has(k) && typeof v === "string") filtered[k] = v;
  }
  await setSettings(filtered);
  res.json({ ok: true, settings: await getAllSettings() });
}));

app.get("/api/bootstrap", asyncHandler(async (_req, res) => {
  const currentUser = res.locals.currentUser;
  const data = await getBootstrapData(isBrandingManager(currentUser.role, currentUser.team));
  res.json(data);
}));

app.get("/api/entries", asyncHandler(async (_req, res) => {
  res.json({ entries: await listEntries() });
}));

app.post("/api/entries", asyncHandler(async (req, res) => {
  const parsed = entrySchema.safeParse(req.body);
  if (!parsed.success) return sendError(res, 400, "Invalid entry payload.");

  const currentUser = res.locals.currentUser;
  const entry = await createEntry({
    ...parsed.data,
    created_by: currentUser.id,
  });
  res.status(201).json({ entry });
}));

app.delete("/api/entries/:id", asyncHandler(async (req, res) => {
  await deleteEntry(getSingleParam(req.params.id));
  res.json({ ok: true });
}));

app.get("/api/users", asyncHandler(async (_req, res) => {
  res.json({ users: await listUsers() });
}));

app.post("/api/users", asyncHandler(async (req, res) => {
  const parsed = createUserSchema.safeParse(req.body);
  if (!parsed.success) return sendError(res, 400, "Invalid user payload.");

  const currentUser = res.locals.currentUser;
  if (!canCreateManagedUser(currentUser, parsed.data)) {
    return sendError(res, 403, "You do not have permission to create that user.");
  }

  const existing = await getUserByEmail(parsed.data.email);
  if (existing) return sendError(res, 409, "An account with this email already exists.");

  const user = await createUser(parsed.data);
  res.status(201).json({ user });
}));

// ── Self-update: any logged-in user can update their own name/department ────
app.patch("/api/users/me", asyncHandler(async (req, res) => {
  const currentUser = res.locals.currentUser;
  const schema = z.object({
    full_name: z.string().min(1).optional(),
    department: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return sendError(res, 400, "Invalid payload.");
  const updated = await updateUser(currentUser.id, parsed.data);
  if (!updated) return sendError(res, 404, "User not found.");
  res.json({ user: updated });
}));

// ── Avatar upload: any logged-in user uploads their own photo ───────────────
app.post("/api/users/me/avatar", avatarUpload.single("avatar"), asyncHandler(async (req, res) => {
  const currentUser = res.locals.currentUser;
  if (!req.file) return sendError(res, 400, "No file uploaded.");
  const avatarUrl = `/uploads/avatars/${req.file.filename}`;
  const updated = await updateUser(currentUser.id, { avatar_url: avatarUrl });
  if (!updated) return sendError(res, 404, "User not found.");
  res.json({ user: updated, avatar_url: avatarUrl });
}));

app.patch("/api/users/:id", asyncHandler(async (req, res) => {
  const userId = getSingleParam(req.params.id);
  const currentUser = res.locals.currentUser;

  const isSuperAdmin = currentUser.role === "super_admin";
  const isBrandingAdmin = currentUser.role === "admin" && currentUser.team === "branding";

  if (!isSuperAdmin && !isBrandingAdmin) {
    return sendError(res, 403, "You do not have permission to modify users.");
  }

  const parsed = updateUserSchema.safeParse(req.body);
  if (!parsed.success) return sendError(res, 400, "Invalid user update payload.");

  // Branding admin may only update users on their own team, and may not promote to admin/super_admin
  if (isBrandingAdmin) {
    const target = await getUserById(userId);
    if (!target || target.team !== "branding") {
      return sendError(res, 403, "You can only modify members of your own team.");
    }
    if (parsed.data.role && !["user", "sub_admin"].includes(parsed.data.role)) {
      return sendError(res, 403, "You can only assign the user or team_lead role.");
    }
    if (parsed.data.team && parsed.data.team !== "branding") {
      return sendError(res, 403, "You cannot move users out of the branding team.");
    }
  }

  const updated = await updateUser(userId, parsed.data);
  if (!updated) return sendError(res, 404, "User not found.");
  res.json({ user: updated });
}));

app.delete("/api/users/:id", asyncHandler(async (req, res) => {
  const userId = getSingleParam(req.params.id);
  const currentUser = res.locals.currentUser;

  const isSuperAdmin = currentUser.role === "super_admin";
  const isBrandingAdmin = currentUser.role === "admin" && currentUser.team === "branding";

  if (!isSuperAdmin && !isBrandingAdmin) {
    return sendError(res, 403, "Only the super admin can delete users.");
  }
  if (currentUser.id === userId) {
    return sendError(res, 400, "You cannot delete your own account.");
  }

  // Branding admin may only delete their own team's non-admin members
  if (isBrandingAdmin) {
    const target = await getUserById(userId);
    if (!target || target.team !== "branding") {
      return sendError(res, 403, "You can only remove members of your own team.");
    }
    if (target.role === "admin") {
      return sendError(res, 403, "You cannot remove another admin.");
    }
  }

  await deleteUser(userId);
  res.json({ ok: true });
}));

app.get("/api/teams", asyncHandler(async (_req, res) => {
  res.json({ teams: await listTeams() });
}));

app.post("/api/teams", asyncHandler(async (req, res, next) => {
  const currentUser = res.locals.currentUser;
  if (currentUser.role !== "super_admin") {
    return sendError(res, 403, "Only the super admin can create teams.");
  }

  const parsed = teamSchema.safeParse(req.body);
  if (!parsed.success) return sendError(res, 400, "Invalid team payload.");

  try {
    const team = await createTeam(parsed.data);
    res.status(201).json({ team });
  } catch (error: unknown) {
    if (isPgUniqueViolation(error)) {
      return sendError(res, 409, "A team with this name already exists.");
    }
    return next(error);
  }
}));

app.delete("/api/teams/:id", asyncHandler(async (req, res) => {
  const teamId = getSingleParam(req.params.id);
  const currentUser = res.locals.currentUser;
  if (currentUser.role !== "super_admin") {
    return sendError(res, 403, "Only the super admin can delete teams.");
  }

  const users = await listUsers();
  if (users.some((user) => user.team === teamId)) {
    return sendError(res, 400, "Reassign users before deleting this team.");
  }

  await deleteTeam(teamId);
  res.json({ ok: true });
}));

app.get("/api/branding-rows", asyncHandler(async (_req, res) => {
  const currentUser = res.locals.currentUser;
  if (!isBrandingManager(currentUser.role, currentUser.team)) {
    return sendError(res, 403, "Branding rows are only available to the branding team.");
  }
  res.json({ brandingRows: await listBrandingRows() });
}));

app.post("/api/branding-rows", asyncHandler(async (req, res) => {
  const currentUser = res.locals.currentUser;
  if (!isBrandingManager(currentUser.role, currentUser.team)) {
    return sendError(res, 403, "Only the branding team can add branding rows.");
  }

  const parsed = brandingRowSchema.safeParse(req.body);
  if (!parsed.success) return sendError(res, 400, "Invalid branding row payload.");

  const brandingRow = await createBrandingRow(parsed.data);
  res.status(201).json({ brandingRow });
}));

app.patch("/api/branding-rows/:id", asyncHandler(async (req, res) => {
  const rowId = getSingleParam(req.params.id);
  const currentUser = res.locals.currentUser;
  if (!isBrandingManager(currentUser.role, currentUser.team)) {
    return sendError(res, 403, "Only the branding team can edit branding rows.");
  }

  const parsed = brandingRowSchema.safeParse(req.body);
  if (!parsed.success) return sendError(res, 400, "Invalid branding row update payload.");

  const brandingRow = await updateBrandingRow(rowId, parsed.data);
  if (!brandingRow) return sendError(res, 404, "Branding row not found.");
  res.json({ brandingRow });
}));

app.delete("/api/branding-rows/:id", asyncHandler(async (req, res) => {
  const rowId = getSingleParam(req.params.id);
  const currentUser = res.locals.currentUser;
  if (!isBrandingManager(currentUser.role, currentUser.team)) {
    return sendError(res, 403, "Only the branding team can delete branding rows.");
  }

  await deleteBrandingRow(rowId);
  res.json({ ok: true });
}));

app.use(((error: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (res.headersSent) return next(error);
  console.error("Unhandled API error", error);
  return sendError(res, 500, "Internal server error.");
}) as express.ErrorRequestHandler);

// ── Branding Portal middleware ─────────────────────────────────────────────

function isBrandingTeamMember(role: AppRole, team: string | null) {
  return role === "super_admin" || team === "branding";
}
function isBrandingAdminOrSuper(role: AppRole, team: string | null) {
  return role === "super_admin" || (team === "branding" && role === "admin");
}

function requireBranding(res: express.Response): boolean {
  const u = res.locals.currentUser;
  if (!isBrandingTeamMember(u.role, u.team)) {
    sendError(res, 403, "Branding team access only.");
    return false;
  }
  return true;
}
function requireBrandingAdmin(res: express.Response): boolean {
  const u = res.locals.currentUser;
  if (!isBrandingAdminOrSuper(u.role, u.team)) {
    sendError(res, 403, "Branding admin access only.");
    return false;
  }
  return true;
}
function requireBrandingLead(res: express.Response): boolean {
  const u = res.locals.currentUser;
  const ok = u.role === "super_admin" ||
    (u.team === "branding" && (u.role === "admin" || u.role === "sub_admin"));
  if (!ok) { sendError(res, 403, "Branding lead or admin access only."); return false; }
  return true;
}

// ── Category routes ────────────────────────────────────────────────────────

app.get("/api/branding/portal/categories", asyncHandler(async (_req, res) => {
  if (!requireBranding(res)) return;
  res.json({ categories: await listWorkCategories() });
}));

app.post("/api/branding/portal/categories", asyncHandler(async (req, res) => {
  if (!requireBrandingAdmin(res)) return;
  const { name } = z.object({ name: z.string().min(1) }).parse(req.body);
  const category = await createWorkCategory(name);
  res.status(201).json({ category });
}));

app.patch("/api/branding/portal/categories/:id", asyncHandler(async (req, res) => {
  if (!requireBrandingAdmin(res)) return;
  const { name } = z.object({ name: z.string().min(1) }).parse(req.body);
  const ok = await updateWorkCategory(getSingleParam(req.params.id), name);
  if (!ok) return sendError(res, 404, "Category not found.");
  res.json({ ok: true });
}));

app.delete("/api/branding/portal/categories/:id", asyncHandler(async (req, res) => {
  if (!requireBrandingAdmin(res)) return;
  const result = await deleteWorkCategory(getSingleParam(req.params.id));
  res.json({ ok: true, usageCount: result.usageCount });
}));

app.post("/api/branding/portal/categories/reorder", asyncHandler(async (req, res) => {
  if (!requireBrandingAdmin(res)) return;
  const { orderedIds } = z.object({ orderedIds: z.array(z.string()) }).parse(req.body);
  await reorderWorkCategories(orderedIds);
  res.json({ ok: true });
}));

app.post("/api/branding/portal/categories/:id/sub", asyncHandler(async (req, res) => {
  if (!requireBrandingAdmin(res)) return;
  const { name } = z.object({ name: z.string().min(1) }).parse(req.body);
  const sub = await createWorkSubCategory(getSingleParam(req.params.id), name);
  res.status(201).json({ sub });
}));

app.patch("/api/branding/portal/sub-categories/:id", asyncHandler(async (req, res) => {
  if (!requireBrandingAdmin(res)) return;
  const { name } = z.object({ name: z.string().min(1) }).parse(req.body);
  const ok = await updateWorkSubCategory(getSingleParam(req.params.id), name);
  if (!ok) return sendError(res, 404, "Sub-category not found or is a protected 'Others' entry.");
  res.json({ ok: true });
}));

app.delete("/api/branding/portal/sub-categories/:id", asyncHandler(async (req, res) => {
  if (!requireBrandingAdmin(res)) return;
  const result = await deleteWorkSubCategory(getSingleParam(req.params.id));
  res.json({ ok: true, usageCount: result.usageCount });
}));

// ── Daily Report routes ────────────────────────────────────────────────────

const saveRowsSchema = z.object({
  rows: z.array(z.object({
    sr_no: z.number().int().min(1),
    type_of_work: z.string(),
    sub_category: z.string(),
    specific_work: z.string(),
    time_taken: z.string(),
    collaborative_colleagues: z.array(z.string()).default([]),
  })),
});

app.get("/api/branding/portal/report", asyncHandler(async (req, res) => {
  if (!requireBranding(res)) return;
  const date = getSingleParam(req.query["date"] as string | string[]);
  if (!date) return sendError(res, 400, "date query param required (YYYY-MM-DD).");
  const user = res.locals.currentUser;
  const report = await getOrCreateDailyReport(user.id, date);
  res.json({ report });
}));

app.put("/api/branding/portal/report/:reportId/rows", asyncHandler(async (req, res) => {
  if (!requireBranding(res)) return;
  const parsed = saveRowsSchema.safeParse(req.body);
  if (!parsed.success) return sendError(res, 400, "Invalid rows payload.");
  const user = res.locals.currentUser;
  const rows = await saveReportRows(getSingleParam(req.params.reportId), user.id, parsed.data.rows);
  if (!rows) return sendError(res, 403, "Report not found or already locked.");
  res.json({ rows });
}));

app.post("/api/branding/portal/report/:reportId/submit", asyncHandler(async (req, res) => {
  if (!requireBranding(res)) return;
  const user = res.locals.currentUser;
  const report = await submitDailyReport(getSingleParam(req.params.reportId), user.id);
  if (!report) return sendError(res, 403, "Report not found or already submitted.");
  res.json({ report });
}));

app.get("/api/branding/portal/reports", asyncHandler(async (req, res) => {
  if (!requireBranding(res)) return;
  const q = req.query as Record<string, string>;
  const user = res.locals.currentUser;
  // Admins/super can query any userId; regular members can only see their own reports
  const targetUserId = isBrandingAdminOrSuper(user.role, user.team) && q["userId"]
    ? q["userId"]
    : user.id;
  const reports = await listAllDailyReports({
    userId:      targetUserId,
    dateFrom:    q["dateFrom"]    || undefined,
    dateTo:      q["dateTo"]      || undefined,
    typeOfWork:  q["typeOfWork"]  || undefined,
    subCategory: q["subCategory"] || undefined,
    collaborator: q["collaborator"] || undefined,
    lockedOnly:  q["lockedOnly"] === "true",
  });
  res.json({ reports });
}));

app.get("/api/branding/portal/analytics", asyncHandler(async (req, res) => {
  if (!requireBranding(res)) return;
  const q = req.query as Record<string, string>;
  const user = res.locals.currentUser;
  const now = new Date();
  const dateFrom = q["dateFrom"] || new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split("T")[0];
  const dateTo   = q["dateTo"]   || now.toISOString().split("T")[0];
  const targetId = isBrandingAdminOrSuper(user.role, user.team) && q["userId"] ? q["userId"] : user.id;
  const analytics = await getUserAnalytics(targetId, dateFrom, dateTo);
  res.json({ analytics });
}));

// ── KRA routes ─────────────────────────────────────────────────────────────

app.get("/api/branding/portal/kra/parameters", asyncHandler(async (_req, res) => {
  if (!requireBranding(res)) return;
  res.json({ parameters: await listKraParameters() });
}));

app.get("/api/branding/portal/kra/peer-marking-enabled", asyncHandler(async (_req, res) => {
  if (!requireBranding(res)) return;
  res.json({ enabled: await getPeerMarkingEnabled() });
}));

app.patch("/api/branding/portal/kra/peer-marking-toggle", asyncHandler(async (req, res) => {
  if (!requireBrandingAdmin(res)) return;
  const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
  await togglePeerMarking(enabled, res.locals.currentUser.id);
  res.json({ ok: true, enabled });
}));

app.get("/api/branding/portal/kra/self-appraisal", asyncHandler(async (req, res) => {
  if (!requireBranding(res)) return;
  const { month, year } = req.query as { month: string; year: string };
  const appraisal = await getSelfAppraisal(res.locals.currentUser.id, parseInt(month), parseInt(year));
  res.json({ appraisal });
}));

app.post("/api/branding/portal/kra/self-appraisal", asyncHandler(async (req, res) => {
  if (!requireBranding(res)) return;
  const { month, year, scores } = z.object({
    month:  z.number().int().min(1).max(12),
    year:   z.number().int().min(2020),
    scores: z.record(z.string(), z.number().min(0).max(10)),
  }).parse(req.body);
  const result = await submitSelfAppraisal(res.locals.currentUser.id, month, year, scores);
  if (result === "already_submitted") return sendError(res, 409, "Self appraisal already submitted for this month.");
  res.status(201).json({ appraisal: result });
}));

app.get("/api/branding/portal/kra/peer-marking/completed", asyncHandler(async (req, res) => {
  if (!requireBranding(res)) return;
  const { month, year } = req.query as { month: string; year: string };
  const completed = await getCompletedPeerMarkings(res.locals.currentUser.id, parseInt(month), parseInt(year));
  res.json({ completed });
}));

app.post("/api/branding/portal/kra/peer-marking", asyncHandler(async (req, res) => {
  if (!requireBranding(res)) return;
  const enabled = await getPeerMarkingEnabled();
  if (!enabled) return sendError(res, 403, "Peer marking is currently disabled.");
  const { revieweeId, month, year, scores } = z.object({
    revieweeId: z.string(),
    month:  z.number().int().min(1).max(12),
    year:   z.number().int().min(2020),
    scores: z.record(z.string(), z.number().min(0).max(10)),
  }).parse(req.body);
  const user = res.locals.currentUser;
  if (revieweeId === user.id) return sendError(res, 400, "Cannot mark yourself.");
  const result = await submitPeerMarking(user.id, revieweeId, month, year, scores);
  if (result === "already_submitted") return sendError(res, 409, "Already marked this colleague.");
  res.status(201).json({ marking: result });
}));

app.get("/api/branding/portal/kra/report/:userId/:month/:year", asyncHandler(async (req, res) => {
  if (!requireBranding(res)) return;
  const { userId, month, year } = req.params;
  const currentUser = res.locals.currentUser;
  // User can only see own report unless admin/super
  if (userId !== currentUser.id && !isBrandingAdminOrSuper(currentUser.role, currentUser.team)) {
    return sendError(res, 403, "Access denied.");
  }
  const report = await getKraReport(getSingleParam(userId), parseInt(getSingleParam(month)), parseInt(getSingleParam(year)));
  if (!report) return sendError(res, 404, "KRA report not found.");
  // Non-admins only see composite if final-pushed
  if (!isBrandingAdminOrSuper(currentUser.role, currentUser.team) && !report.is_final_pushed) {
    return res.json({ report: { ...report, peer_average: {}, admin_score: null, composite_score: null } });
  }
  res.json({ report });
}));

app.get("/api/branding/portal/kra/admin/dashboard", asyncHandler(async (req, res) => {
  if (!requireBrandingAdmin(res)) return;
  const { month, year } = req.query as { month: string; year: string };
  const dashboard = await getAdminKraDashboard(parseInt(month), parseInt(year));
  res.json({ dashboard });
}));

app.get("/api/branding/portal/kra/admin/score/:userId/:month/:year", asyncHandler(async (req, res) => {
  if (!requireBrandingAdmin(res)) return;
  const { userId, month, year } = req.params;
  const score = await getAdminKraScore(getSingleParam(userId), parseInt(getSingleParam(month)), parseInt(getSingleParam(year)));
  res.json({ score });
}));

app.post("/api/branding/portal/kra/admin/score", asyncHandler(async (req, res) => {
  if (!requireBrandingAdmin(res)) return;
  const { userId, month, year, scores } = z.object({
    userId: z.string(),
    month:  z.number().int().min(1).max(12),
    year:   z.number().int().min(2020),
    scores: z.record(z.string(), z.number().min(0).max(10)),
  }).parse(req.body);
  const adminScore = await getAdminKraScore(userId, month, year);
  if (adminScore?.is_final_pushed) return sendError(res, 403, "KRA is already final-pushed and locked.");
  const score = await setAdminKraScore(userId, month, year, scores, res.locals.currentUser.id);
  res.json({ score });
}));

app.post("/api/branding/portal/kra/admin/final-push", asyncHandler(async (req, res) => {
  if (!requireBrandingAdmin(res)) return;
  const { userId, month, year } = z.object({
    userId: z.string(),
    month:  z.number().int().min(1).max(12),
    year:   z.number().int().min(2020),
  }).parse(req.body);
  const result = await finalPushKra(userId, month, year, res.locals.currentUser.id);
  if (result === "not_found")     return sendError(res, 404, "Admin KRA score not set yet.");
  if (result === "already_pushed") return sendError(res, 409, "KRA already final-pushed.");
  res.json({ ok: true, score: result });
}));

app.get("/api/branding/portal/kra/admin/peer-markings", asyncHandler(async (req, res) => {
  if (!requireBrandingAdmin(res)) return;
  const { month, year } = req.query as { month: string; year: string };
  const markings = await getAllPeerMarkings(parseInt(month), parseInt(year));
  res.json({ markings });
}));

// ── Super admin branding stats ─────────────────────────────────────────────

app.get("/api/branding/portal/super-admin/stats", asyncHandler(async (req, res) => {
  const user = res.locals.currentUser;
  if (user.role !== "super_admin") return sendError(res, 403, "Super admin only.");
  res.json(await getBrandingPortalStats());
}));

// ── Team lead: report status ───────────────────────────────────────────────

app.get("/api/branding/portal/team/report-status", asyncHandler(async (req, res) => {
  if (!requireBrandingLead(res)) return;
  const date = getSingleParam((req.query as Record<string, string>).date ?? "");
  if (!date) return sendError(res, 400, "date query param required (YYYY-MM-DD).");
  const u = res.locals.currentUser;
  // sub_admin sees only their own managed members; admin/super_admin sees everyone
  const managedBy = u.role === "sub_admin" ? u.id : null;
  const statuses = await getTeamReportStatus(date, managedBy);
  res.json({ statuses });
}));

// ── Design gallery ────────────────────────────────────────────────────────

app.get("/api/branding/portal/designs", asyncHandler(async (req, res) => {
  if (!requireBranding(res)) return;
  const q = req.query as Record<string, string>;
  const designs = await listBrandingDesigns({
    search: q.search || undefined,
    category: q.category || undefined,
    uploaderId: q.uploaderId || undefined,
    dateFrom: q.dateFrom || undefined,
    dateTo: q.dateTo || undefined,
  }, res.locals.currentUser.id);
  res.json({ designs });
}));

app.post("/api/branding/portal/designs/:id/vote", asyncHandler(async (req, res) => {
  if (!requireBranding(res)) return;
  const id = getSingleParam(req.params.id);
  const { vote_type } = req.body as { vote_type: "up" | "down" | null };
  if (vote_type !== null && vote_type !== "up" && vote_type !== "down") {
    return sendError(res, 400, "vote_type must be 'up', 'down', or null.");
  }
  const result = await castDesignVote(id, res.locals.currentUser.id, vote_type);
  res.json(result);
}));

app.get("/api/branding/portal/designs/:id/voters", asyncHandler(async (req, res) => {
  if (!requireBrandingAdmin(res)) return;
  const id = getSingleParam(req.params.id);
  const voters = await getDesignVoters(id);
  res.json({ voters });
}));

app.post(
  "/api/branding/portal/designs",
  (req, res, next) => {
    if (!requireBranding(res)) return;
    next();
  },
  designUpload.single("image"),
  asyncHandler(async (req, res) => {
    const user = res.locals.currentUser;
    if (!req.file) return sendError(res, 400, "Image file is required.");
    const { title, description, category, tags } = req.body as {
      title?: string; description?: string; category?: string; tags?: string;
    };
    if (!title?.trim()) {
      fs.unlinkSync(req.file.path);
      return sendError(res, 400, "Title is required.");
    }
    const imageUrl = `/uploads/branding/${req.file.filename}`;
    const parsedTags = tags ? (tags as string).split(",").map((t: string) => t.trim()).filter(Boolean) : [];
    const design = await createBrandingDesign(
      title.trim(),
      description?.trim() ?? "",
      category?.trim() ?? "",
      parsedTags,
      imageUrl,
      user.id,
      user.full_name || user.email
    );
    res.status(201).json({ design });
  })
);

app.delete("/api/branding/portal/designs/:id", asyncHandler(async (req, res) => {
  if (!requireBranding(res)) return;
  const user = res.locals.currentUser;
  const id = getSingleParam(req.params.id);
  const design = await getBrandingDesignById(id);
  if (!design) return sendError(res, 404, "Design not found.");

  const isAdminLevel = isBrandingAdminOrSuper(user.role, user.team);

  if (!isAdminLevel) {
    // Non-admins can only delete their own design within 1 hour of upload
    if (design.uploader_id !== user.id) {
      return sendError(res, 403, "You can only delete your own designs.");
    }
    const ageMs = Date.now() - new Date(design.created_at).getTime();
    if (ageMs > 60 * 60 * 1000) {
      return sendError(res, 403, "The 1-hour deletion window has passed. Contact an admin to remove this design.");
    }
  }

  const imageUrl = await deleteBrandingDesign(id);
  if (imageUrl) {
    const filePath = path.resolve(imageUrl.replace(/^\//, ""));
    fs.unlink(filePath, () => {});
  }
  res.json({ ok: true });
}));

// ── Branding projects ──────────────────────────────────────────────────────

app.get("/api/branding/portal/projects", asyncHandler(async (_req, res) => {
  if (!requireBranding(res)) return;
  res.json({ projects: await listBrandingProjects() });
}));

app.post("/api/branding/portal/projects", asyncHandler(async (req, res) => {
  if (!requireBrandingAdmin(res)) return;
  const { name, description, deadline, assigned_user_ids } = req.body as {
    name: string; description?: string; deadline?: string; assigned_user_ids?: string[];
  };
  if (!name?.trim()) return sendError(res, 400, "Project name is required.");
  const project = await createBrandingProject(
    name.trim(),
    description?.trim() ?? "",
    deadline || null,
    res.locals.currentUser.id,
    assigned_user_ids ?? []
  );
  res.status(201).json({ project });
}));

app.put("/api/branding/portal/projects/:id", asyncHandler(async (req, res) => {
  if (!requireBrandingAdmin(res)) return;
  const id = getSingleParam(req.params.id);
  const { name, description, deadline, status, assigned_user_ids } = req.body as {
    name: string; description?: string; deadline?: string;
    status?: "active" | "completed" | "on_hold"; assigned_user_ids?: string[];
  };
  if (!name?.trim()) return sendError(res, 400, "Project name is required.");
  const project = await updateBrandingProject(
    id,
    name.trim(),
    description?.trim() ?? "",
    deadline || null,
    status ?? "active",
    assigned_user_ids ?? [],
    res.locals.currentUser.id
  );
  if (!project) return sendError(res, 404, "Project not found.");
  res.json({ project });
}));

app.delete("/api/branding/portal/projects/:id", asyncHandler(async (req, res) => {
  if (!requireBrandingAdmin(res)) return;
  const id = getSingleParam(req.params.id);
  const ok = await deleteBrandingProject(id);
  if (!ok) return sendError(res, 404, "Project not found.");
  res.json({ ok: true });
}));

// ── Leave routes ───────────────────────────────────────────────────────────

// Apply for leave (any branding member, today or future only)
app.post("/api/branding/portal/leave", asyncHandler(async (req, res) => {
  if (!requireBranding(res)) return;
  const user = res.locals.currentUser;
  const { leave_date, reason, transfer_date } = req.body as {
    leave_date?: string; reason?: string; transfer_date?: string;
  };
  if (!leave_date) return sendError(res, 400, "leave_date is required.");
  const today = new Date().toISOString().split("T")[0];
  if (leave_date < today) return sendError(res, 400, "Cannot apply leave for a past date.");
  const leave = await applyLeave(user.id, leave_date, reason || "", transfer_date || undefined);
  res.status(201).json({ leave });
}));

// Get leaves — user sees own; admin sees all (optionally filtered by status)
app.get("/api/branding/portal/leaves", asyncHandler(async (req, res) => {
  if (!requireBranding(res)) return;
  const user = res.locals.currentUser;
  if (isBrandingAdminOrSuper(user.role, user.team)) {
    const status = typeof req.query["status"] === "string" ? req.query["status"] : undefined;
    res.json({ leaves: await getAllLeaves(status) });
  } else {
    res.json({ leaves: await getUserLeaves(user.id) });
  }
}));

// Review a leave (admin: approve/reject) or update transfer_date (user: own pending leave)
app.patch("/api/branding/portal/leave/:id", asyncHandler(async (req, res) => {
  if (!requireBranding(res)) return;
  const user = res.locals.currentUser;
  const leaveId = getSingleParam(req.params.id);
  if (isBrandingAdminOrSuper(user.role, user.team)) {
    const { status } = req.body as { status?: string };
    if (status !== "approved" && status !== "rejected") return sendError(res, 400, "status must be approved or rejected.");
    const leave = await reviewLeave(leaveId, user.id, status);
    if (!leave) return sendError(res, 404, "Leave not found.");
    res.json({ leave });
  } else {
    const { transfer_date } = req.body as { transfer_date?: string | null };
    const leave = await updateLeaveTransfer(leaveId, user.id, transfer_date ?? null);
    if (!leave) return sendError(res, 404, "Leave not found or already reviewed.");
    res.json({ leave });
  }
}));

// Cancel own pending leave
app.delete("/api/branding/portal/leave/:id", asyncHandler(async (req, res) => {
  if (!requireBranding(res)) return;
  const user = res.locals.currentUser;
  const ok = await cancelLeave(getSingleParam(req.params.id), user.id);
  if (!ok) return sendError(res, 404, "Leave not found or already reviewed.");
  res.json({ ok: true });
}));

// Check leave status for a specific date (used by report page)
app.get("/api/branding/portal/leave/date/:date", asyncHandler(async (req, res) => {
  if (!requireBranding(res)) return;
  const user = res.locals.currentUser;
  const leave = await getLeaveForDate(user.id, getSingleParam(req.params.date));
  res.json({ leave });
}));

// ── Start server ───────────────────────────────────────────────────────────

bootstrapDatabase()
  .then(() => bootstrapBrandingDatabase())
  .then(() => bootstrapSettingsDatabase())
  .then(() => {
    app.listen(config.apiPort, () => {
      console.log(`Nerve API listening on ${config.apiPort}`);
    });
  })
  .catch((error) => {
    console.error("Failed to start API", error);
    process.exit(1);
  });
