import express from "express";
import rateLimit from "express-rate-limit";
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
  createPasswordOtp,
  verifyPasswordOtp,
} from "./settings-db.js";
import {
  sendMail,
  passwordResetEmail,
  emailVerificationMail,
  passwordOtpEmail,
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
  listUserCapabilities,
  listCapabilitiesByUserIds,
  setUserCapabilities,
  type AppRole,
} from "./db.js";
import { isValidCapability } from "./capabilities.js";
import {
  bootstrapOutreach,
  listPages as listOutreachPages,
  createPage as createOutreachPage,
  updatePage as updateOutreachPage,
  deletePage as deleteOutreachPage,
  listCreators as listOutreachCreators,
  createCreator as createOutreachCreator,
  updateCreator as updateOutreachCreator,
  deleteCreator as deleteOutreachCreator,
  listCampaigns as listOutreachCampaigns,
  createCampaign as createOutreachCampaign,
  updateCampaign as updateOutreachCampaign,
  deleteCampaign as deleteOutreachCampaign,
  listPosts as listOutreachPosts,
  createPostsBulk as createOutreachPostsBulk,
  deletePost as deleteOutreachPost,
  PAGE_TYPES as OUTREACH_PAGE_TYPES,
  FOLLOWER_TIERS as OUTREACH_FOLLOWER_TIERS,
  CAMPAIGN_STATUSES as OUTREACH_CAMPAIGN_STATUSES,
  POST_TYPES as OUTREACH_POST_TYPES,
  POST_STATUSES as OUTREACH_POST_STATUSES,
} from "./outreach-db.js";
import { syncOutreach, addLivePosts, maybeRunScheduledSync, refreshLivePostMetrics } from "./outreach-sync.js";
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
  autoSubmitOverdueReports,
  autoPauseRunningStopwatches,
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
  setAdminManualPenalty,
  setAdminTotalPenaltyOverride,
  finalPushKra,
  getKraReport,
  getAdminKraDashboard,
  listBrandingProjects,
  createBrandingProject,
  updateBrandingProject,
  deleteBrandingProject,
  createAssignedReportRow,
  completeProjectAssignment,
  listRowComments,
  createRowComment,
  updateRowComment,
  deleteRowComment,
  getRowOwner,
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

// ── Security headers (VAPT TDL-003: missing headers, TDL-005: clickjacking) ─
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  next();
});

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

// task_manager mirrors task_owner exactly (same dashboard + lead powers); it
// exists so the branding head can hand out the role under a distinct title.
const roles = ["super_admin", "admin", "sub_admin", "user", "outreach_manager", "branding_reports_admin", "task_owner", "task_manager"] as const;

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

// ── Rate limiters (VAPT TDL-001: OTP brute-force / login throttling) ───────
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { message: "Too many login attempts. Please try again in 15 minutes." },
});

const otpSendLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { message: "Too many OTP requests. Please try again in 15 minutes." },
});

const otpVerifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { message: "Too many verification attempts. Please try again in 15 minutes." },
});

async function getSessionUser(req: SessionRequest) {
  if (!req.session.userId) return null;
  return getUserById(req.session.userId);
}

function isBrandingManager(role: AppRole, team: string | null) {
  return role === "super_admin" || (team === "branding" && (role === "admin" || role === "sub_admin" || role === "user" || role === "task_owner" || role === "task_manager"));
}

function canCreateManagedUser(
  actor: Awaited<ReturnType<typeof getUserById>>,
  payload: z.infer<typeof createUserSchema>,
) {
  if (!actor) return false;
  if (actor.role === "super_admin") return true;
  if (actor.role !== "admin") return false;
  return actor.team !== null && payload.team === actor.team && ["sub_admin", "user", "task_owner", "task_manager"].includes(payload.role);
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "nerve-api" });
});

app.get("/api/auth/me", asyncHandler(async (req, res) => {
  const user = await getSessionUser(req as SessionRequest);
  if (!user) return res.json({ user: null });
  const capabilities = await listUserCapabilities(user.id);
  res.json({ user: { ...user, password_hash: undefined, capabilities } });
}));

app.post("/api/auth/login", loginLimiter, asyncHandler(async (req, res) => {
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

app.post("/api/auth/forgot-password", otpSendLimiter, asyncHandler(async (req, res) => {
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

// ── OTP password reset — public (forgot password on login page) ───────────

// Step 1: send OTP to email
app.post("/api/auth/send-otp", otpSendLimiter, asyncHandler(async (req, res) => {
  const { email } = req.body as { email?: string };
  if (!email?.trim()) return sendError(res, 400, "Email is required.");
  const user = await getUserByEmail(email.trim());
  if (user) {
    const otp = await createPasswordOtp(user.id);
    await sendMail({
      to: user.email,
      subject: "Your password reset code — Parul University",
      html: passwordOtpEmail(user.full_name, otp),
    });
  }
  res.json({ ok: true }); // always 200 to avoid email enumeration
}));

// Step 2: verify OTP → returns short-lived reset token
app.post("/api/auth/verify-otp", otpVerifyLimiter, asyncHandler(async (req, res) => {
  const { email, otp } = req.body as { email?: string; otp?: string };
  if (!email?.trim() || !otp?.trim()) return sendError(res, 400, "Email and OTP are required.");
  const user = await getUserByEmail(email.trim());
  if (!user) return sendError(res, 400, "Invalid OTP.");
  const resetToken = await verifyPasswordOtp(user.id, otp.trim());
  if (!resetToken) return sendError(res, 400, "OTP is incorrect or has expired.");
  res.json({ ok: true, token: resetToken });
}));

// ── OTP password change — authenticated (profile settings) ────────────────

// Send OTP to currently logged-in user's own email
app.post("/api/auth/send-change-otp", asyncHandler(async (req, res) => {
  const user = await getSessionUser(req as SessionRequest);
  if (!user) return sendError(res, 401, "Authentication required.");
  const otp = await createPasswordOtp(user.id);
  await sendMail({
    to: user.email,
    subject: "Your password change code — Parul University",
    html: passwordOtpEmail(user.full_name, otp),
  });
  res.json({ ok: true });
}));

// Verify OTP → returns reset token
app.post("/api/auth/verify-change-otp", asyncHandler(async (req, res) => {
  const user = await getSessionUser(req as SessionRequest);
  if (!user) return sendError(res, 401, "Authentication required.");
  const { otp } = req.body as { otp?: string };
  if (!otp?.trim()) return sendError(res, 400, "OTP is required.");
  const resetToken = await verifyPasswordOtp(user.id, otp.trim());
  if (!resetToken) return sendError(res, 400, "OTP is incorrect or has expired.");
  res.json({ ok: true, token: resetToken });
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
  const users = await listUsers();
  // Bulk-hydrate capabilities so the admin UI can show what each user has
  // been granted without an N+1 query per row.
  const capsByUser = await listCapabilitiesByUserIds(users.map(u => u.id));
  const hydrated = users.map(u => ({ ...u, capabilities: capsByUser.get(u.id) ?? [] }));
  res.json({ users: hydrated });
}));

// ── Per-user capability grants ─────────────────────────────────────────────
// Admin / super_admin only. Branding admin may only manage capabilities for
// members of their own team.

app.get("/api/users/:id/capabilities", asyncHandler(async (req, res) => {
  const currentUser = res.locals.currentUser;
  const isSuperAdmin = currentUser.role === "super_admin";
  const isBrandingAdmin = currentUser.role === "admin" && currentUser.team === "branding";
  if (!isSuperAdmin && !isBrandingAdmin) return sendError(res, 403, "Admin access required.");

  const userId = getSingleParam(req.params.id);
  const target = await getUserById(userId);
  if (!target) return sendError(res, 404, "User not found.");
  if (isBrandingAdmin && target.team !== "branding") {
    return sendError(res, 403, "You can only inspect members of your own team.");
  }
  res.json({ capabilities: await listUserCapabilities(userId) });
}));

app.put("/api/users/:id/capabilities", asyncHandler(async (req, res) => {
  const currentUser = res.locals.currentUser;
  const isSuperAdmin = currentUser.role === "super_admin";
  const isBrandingAdmin = currentUser.role === "admin" && currentUser.team === "branding";
  if (!isSuperAdmin && !isBrandingAdmin) return sendError(res, 403, "Admin access required.");

  const userId = getSingleParam(req.params.id);
  const target = await getUserById(userId);
  if (!target) return sendError(res, 404, "User not found.");
  if (isBrandingAdmin && target.team !== "branding") {
    return sendError(res, 403, "You can only modify members of your own team.");
  }

  const schema = z.object({ capabilities: z.array(z.string()).max(50) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return sendError(res, 400, "Invalid capabilities payload.");

  // Validate every key against the server-side catalog. Anything unknown is
  // dropped so the picker UI can evolve independently of the backend.
  const valid = parsed.data.capabilities.filter(isValidCapability);

  const finalSet = await setUserCapabilities(userId, valid, currentUser.id);
  res.json({ capabilities: finalSet });
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
    if (parsed.data.role && !["user", "sub_admin", "task_owner", "task_manager"].includes(parsed.data.role)) {
      return sendError(res, 403, "You can only assign the designer, lead, task-owner or task-manager role.");
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
// Daily-reports + category management can be delegated to the
// `branding_reports_admin` role. KRA, leaves, peer-marking etc. stay
// admin-only.
function isBrandingReportsAdminOrAdminOrSuper(role: AppRole, team: string | null) {
  return isBrandingAdminOrSuper(role, team)
    || (team === "branding" && role === "branding_reports_admin");
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
// For Daily Reports + Category endpoints — accepts branding_reports_admin too,
// plus any user with the `branding:manage_categories` capability grant. The
// capability check lets an admin delegate category management to a regular
// user without promoting them to admin.
function requireBrandingReportsAdmin(res: express.Response): boolean {
  const u = res.locals.currentUser;
  if (!isBrandingReportsAdminOrAdminOrSuper(u.role, u.team)) {
    sendError(res, 403, "Branding admin or reports-admin access only.");
    return false;
  }
  return true;
}
async function requireBrandingCategoryManager(res: express.Response): Promise<boolean> {
  const u = res.locals.currentUser;
  if (isBrandingReportsAdminOrAdminOrSuper(u.role, u.team)) return true;
  // Fallback: explicit capability grant on a branding-team member.
  if (u.team === "branding") {
    const caps = await listUserCapabilities(u.id);
    if (caps.includes("branding:manage_categories")) return true;
  }
  sendError(res, 403, "You need the 'Manage Categories' capability to do that.");
  return false;
}
// Project assignment: full branding admins always, plus any branding-team
// member the head has granted the 'assign_projects' capability to.
async function requireBrandingProjectAssigner(res: express.Response): Promise<boolean> {
  const u = res.locals.currentUser;
  if (isBrandingAdminOrSuper(u.role, u.team)) return true;
  // Task owners are leads with built-in assign rights.
  if (u.team === "branding" && (u.role === "task_owner" || u.role === "task_manager")) return true;
  if (u.team === "branding") {
    const caps = await listUserCapabilities(u.id);
    if (caps.includes("branding:assign_projects")) return true;
  }
  sendError(res, 403, "You need the 'Assign Projects' capability to do that.");
  return false;
}
// Branding "lead" roles: team leads (sub_admin) and task owners (a lead variant
// with built-in project-assign rights). Used wherever lead-level access applies.
function isBrandingLeadRole(role: AppRole, team: string | null): boolean {
  return team === "branding" && (role === "sub_admin" || role === "task_owner" || role === "task_manager");
}
function requireBrandingLead(res: express.Response): boolean {
  const u = res.locals.currentUser;
  const ok = u.role === "super_admin" ||
    (u.team === "branding" && u.role === "admin") ||
    isBrandingLeadRole(u.role, u.team);
  if (!ok) { sendError(res, 403, "Branding lead or admin access only."); return false; }
  return true;
}

// ── Category routes ────────────────────────────────────────────────────────

app.get("/api/branding/portal/categories", asyncHandler(async (_req, res) => {
  if (!requireBranding(res)) return;
  res.json({ categories: await listWorkCategories() });
}));

app.post("/api/branding/portal/categories", asyncHandler(async (req, res) => {
  if (!(await requireBrandingCategoryManager(res))) return;
  const { name } = z.object({ name: z.string().min(1) }).parse(req.body);
  const category = await createWorkCategory(name);
  res.status(201).json({ category });
}));

app.patch("/api/branding/portal/categories/:id", asyncHandler(async (req, res) => {
  if (!(await requireBrandingCategoryManager(res))) return;
  const { name } = z.object({ name: z.string().min(1) }).parse(req.body);
  const ok = await updateWorkCategory(getSingleParam(req.params.id), name);
  if (!ok) return sendError(res, 404, "Category not found.");
  res.json({ ok: true });
}));

app.delete("/api/branding/portal/categories/:id", asyncHandler(async (req, res) => {
  if (!(await requireBrandingCategoryManager(res))) return;
  const result = await deleteWorkCategory(getSingleParam(req.params.id));
  res.json({ ok: true, usageCount: result.usageCount });
}));

app.post("/api/branding/portal/categories/reorder", asyncHandler(async (req, res) => {
  if (!(await requireBrandingCategoryManager(res))) return;
  const { orderedIds } = z.object({ orderedIds: z.array(z.string()) }).parse(req.body);
  await reorderWorkCategories(orderedIds);
  res.json({ ok: true });
}));

app.post("/api/branding/portal/categories/:id/sub", asyncHandler(async (req, res) => {
  if (!(await requireBrandingCategoryManager(res))) return;
  const { name } = z.object({ name: z.string().min(1) }).parse(req.body);
  const sub = await createWorkSubCategory(getSingleParam(req.params.id), name);
  res.status(201).json({ sub });
}));

app.patch("/api/branding/portal/sub-categories/:id", asyncHandler(async (req, res) => {
  if (!(await requireBrandingCategoryManager(res))) return;
  const { name } = z.object({ name: z.string().min(1) }).parse(req.body);
  const ok = await updateWorkSubCategory(getSingleParam(req.params.id), name);
  if (!ok) return sendError(res, 404, "Sub-category not found or is a protected 'Others' entry.");
  res.json({ ok: true });
}));

app.delete("/api/branding/portal/sub-categories/:id", asyncHandler(async (req, res) => {
  if (!(await requireBrandingCategoryManager(res))) return;
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
    stopwatch_status: z.enum(['idle', 'running', 'paused', 'finished']).optional(),
    elapsed_seconds: z.number().int().min(0).optional(),
    stopwatch_started_at: z.string().nullable().optional(),
    carried_over_from_row_id: z.string().nullable().optional(),
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
  if (!rows) return sendError(res, 403, "Report not found, already submitted, or past the 9 PM IST edit window.");
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
  const q = req.query as Record<string, string | string[]>;
  const user = res.locals.currentUser;
  // Treat branding_reports_admin like an admin for the purposes of fetching
  // all team reports — that role's whole point is read-access to everyone's
  // daily submissions. A user explicitly granted `branding:view_team_dashboard`
  // gets the same broad read access without role escalation.
  let isAdmin = isBrandingReportsAdminOrAdminOrSuper(user.role, user.team);
  if (!isAdmin && user.team === "branding") {
    const caps = await listUserCapabilities(user.id);
    if (caps.includes("branding:view_team_dashboard")) isAdmin = true;
  }
  const teamScope = q["scope"] === "team"; // non-admin members may opt-in for live-collab UI

  // Parse userIds: supports ?userId=id1&userId=id2 (array) or ?userId=id1 (single)
  let userIds: string[] | undefined;
  let userId: string | undefined;
  if (isAdmin || teamScope) {
    const raw = q["userId"];
    if (Array.isArray(raw) && raw.length > 0) {
      userIds = raw;
    } else if (typeof raw === "string" && raw) {
      userIds = [raw];
    }
    // If no filter, userIds stays undefined → fetches all branding team
  } else {
    userId = user.id;
  }

  const reports = await listAllDailyReports({
    userId,
    userIds,
    dateFrom:    typeof q["dateFrom"]    === "string" ? q["dateFrom"]    : undefined,
    dateTo:      typeof q["dateTo"]      === "string" ? q["dateTo"]      : undefined,
    typeOfWork:  typeof q["typeOfWork"]  === "string" ? q["typeOfWork"]  : undefined,
    subCategory: typeof q["subCategory"] === "string" ? q["subCategory"] : undefined,
    collaborator: typeof q["collaborator"] === "string" ? q["collaborator"] : undefined,
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
    return res.json({
      report: {
        ...report,
        peer_average: {},
        admin_score: null,
        composite_score: null,
        composite_score_after_penalty: null,
      },
    });
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

app.post("/api/branding/portal/kra/admin/penalty", asyncHandler(async (req, res) => {
  if (!requireBrandingAdmin(res)) return;
  const { userId, month, year, penalty_percent, reason } = z.object({
    userId: z.string(),
    month:  z.number().int().min(1).max(12),
    year:   z.number().int().min(2020),
    penalty_percent: z.number().min(0).max(100),
    reason: z.string().optional().default(''),
  }).parse(req.body);
  const existing = await getAdminKraScore(userId, month, year);
  if (existing?.is_final_pushed) return sendError(res, 403, "KRA is already final-pushed and locked.");
  const score = await setAdminManualPenalty(userId, month, year, penalty_percent, reason);
  res.json({ score });
}));

// Full TOTAL penalty override — replaces both auto (missed-report) and manual
// penalties. Pass percent=null to clear the override.
app.post("/api/branding/portal/kra/admin/penalty-override", asyncHandler(async (req, res) => {
  if (!requireBrandingAdmin(res)) return;
  const { userId, month, year, percent, reason } = z.object({
    userId: z.string(),
    month:  z.number().int().min(1).max(12),
    year:   z.number().int().min(2020),
    percent: z.number().min(0).max(100).nullable(),
    reason: z.string().optional().default(''),
  }).parse(req.body);
  const existing = await getAdminKraScore(userId, month, year);
  if (existing?.is_final_pushed) return sendError(res, 403, "KRA is already final-pushed and locked.");
  const score = await setAdminTotalPenaltyOverride(userId, month, year, percent, reason);
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

// Get peer markings for a specific user (admin view of individual reviewer scores)
app.get("/api/branding/portal/kra/admin/user-peer-markings/:userId", asyncHandler(async (req, res) => {
  if (!requireBrandingAdmin(res)) return;
  const { month, year } = req.query as { month: string; year: string };
  const userId = getSingleParam(req.params.userId);
  const markings = await getPeerMarkingsForUser(userId, parseInt(month), parseInt(year));
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
  // Access restriction (req 5): admins/head see all projects; designers, leads
  // and task owners see only projects they're assigned to, supervise, or created.
  const u = res.locals.currentUser;
  const seesAll = isBrandingReportsAdminOrAdminOrSuper(u.role, u.team);
  res.json({ projects: await listBrandingProjects(seesAll ? undefined : u.id) });
}));

// When a lead (sub_admin) creates/updates a project, they can only assign it
// to members they manage. Admin/super_admin can assign to anyone.
async function scopeAssignmentsForActor(
  actor: { id: string; role: string; team: string | null },
  ids: string[],
): Promise<string[]> {
  const isAdmin = actor.role === "super_admin" ||
    (actor.team === "branding" && actor.role === "admin");
  if (isAdmin) return ids;
  // sub_admin: filter to managed users (also allow self).
  const filtered: string[] = [];
  for (const id of ids) {
    const u = await getUserById(id);
    if (u && (u.managed_by === actor.id || u.id === actor.id)) filtered.push(id);
  }
  return filtered;
}

app.post("/api/branding/portal/projects", asyncHandler(async (req, res) => {
  if (!requireBrandingLead(res)) return;
  const { name, description, deadline, assigned_user_ids, type_of_work, sub_category, specific_work } = req.body as {
    name: string; description?: string; deadline?: string; assigned_user_ids?: string[];
    type_of_work?: string; sub_category?: string; specific_work?: string;
  };
  if (!name?.trim()) return sendError(res, 400, "Project name is required.");
  const actor = res.locals.currentUser;
  const scoped = await scopeAssignmentsForActor(actor, assigned_user_ids ?? []);
  const project = await createBrandingProject(
    name.trim(),
    description?.trim() ?? "",
    deadline || null,
    actor.id,
    scoped,
    {
      typeOfWork: type_of_work?.trim() ?? "",
      subCategory: sub_category?.trim() ?? "",
      specificWork: specific_work?.trim() ?? "",
    },
  );
  res.status(201).json({ project });
}));

app.put("/api/branding/portal/projects/:id", asyncHandler(async (req, res) => {
  if (!requireBrandingLead(res)) return;
  const id = getSingleParam(req.params.id);
  const { name, description, deadline, status, assigned_user_ids, type_of_work, sub_category, specific_work } = req.body as {
    name: string; description?: string; deadline?: string;
    status?: "active" | "completed" | "on_hold"; assigned_user_ids?: string[];
    type_of_work?: string; sub_category?: string; specific_work?: string;
  };
  if (!name?.trim()) return sendError(res, 400, "Project name is required.");
  const actor = res.locals.currentUser;
  const scoped = await scopeAssignmentsForActor(actor, assigned_user_ids ?? []);
  const project = await updateBrandingProject(
    id,
    name.trim(),
    description?.trim() ?? "",
    deadline || null,
    status ?? "active",
    scoped,
    actor.id,
    {
      typeOfWork: type_of_work?.trim(),
      subCategory: sub_category?.trim(),
      specificWork: specific_work?.trim(),
    },
  );
  if (!project) return sendError(res, 404, "Project not found.");
  res.json({ project });
}));

// Assign a project to designers (capability-gated). Creates the project with
// its work classification, assigns the chosen designers, and seeds a row into
// each designer's daily report for the given work date. (Spec: leads granted
// the 'Assign Projects' capability assign work that lands in the designer's
// daily report.)
app.post("/api/branding/portal/projects/assign", asyncHandler(async (req, res) => {
  if (!(await requireBrandingProjectAssigner(res))) return;
  const { name, description, deadline, type_of_work, sub_category, specific_work, assigned_user_ids, assign_lead_id, work_date } = req.body as {
    name: string; description?: string; deadline?: string;
    type_of_work?: string; sub_category?: string; specific_work?: string;
    assigned_user_ids?: string[]; assign_lead_id?: string | null; work_date?: string;
  };
  if (!name?.trim()) return sendError(res, 400, "Project name is required.");
  const typeOfWork = type_of_work?.trim() ?? "";
  const subCategory = sub_category?.trim() ?? "";
  const specificWork = specific_work?.trim() ?? "";
  if (!typeOfWork || !subCategory || !specificWork) {
    return sendError(res, 400, "Type of work, sub-category and specific work are required.");
  }
  if (!work_date || !/^\d{4}-\d{2}-\d{2}$/.test(work_date)) {
    return sendError(res, 400, "A valid work date (YYYY-MM-DD) is required.");
  }
  const actor = res.locals.currentUser;
  // "Assign to designers" now accepts designers AND leads; each gets a report row.
  const scoped = await scopeAssignmentsForActor(actor, assigned_user_ids ?? []);
  if (scoped.length === 0) {
    return sendError(res, 400, "Assign the project to at least one designer or lead you manage.");
  }
  // "Assign Lead" (optional, supervisory) — must be a lead-role branding member
  // and does NOT get a daily-report row (req 4).
  let leadId: string | null = null;
  if (assign_lead_id) {
    const lead = await getUserById(assign_lead_id);
    if (lead && lead.team === "branding" && (lead.role === "admin" || lead.role === "sub_admin" || lead.role === "task_owner" || lead.role === "task_manager")) {
      leadId = lead.id;
    }
  }
  const project = await createBrandingProject(
    name.trim(), description?.trim() ?? "", deadline || null, actor.id, scoped,
    { typeOfWork, subCategory, specificWork, assignedLeadId: leadId },
  );
  // Seed a daily-report row for each "assign to designers" assignee (designers
  // and leads picked there) — but NOT for the supervisory Assign-Lead.
  for (const designerId of scoped) {
    await createAssignedReportRow({ designerId, workDate: work_date, typeOfWork, subCategory, specificWork });
  }
  res.status(201).json({ project });
}));

// Mark the current user's assignment on a project complete (req 6).
app.post("/api/branding/portal/projects/:id/complete", asyncHandler(async (req, res) => {
  if (!requireBranding(res)) return;
  const id = getSingleParam(req.params.id);
  const project = await completeProjectAssignment(id, res.locals.currentUser.id);
  if (!project) return sendError(res, 404, "You have no assignment on this project.");
  res.json({ project });
}));

app.delete("/api/branding/portal/projects/:id", asyncHandler(async (req, res) => {
  if (!requireBrandingLead(res)) return;
  const id = getSingleParam(req.params.id);
  const ok = await deleteBrandingProject(id);
  if (!ok) return sendError(res, 404, "Project not found.");
  res.json({ ok: true });
}));

// ── Report row comments ────────────────────────────────────────────────────
// Leads/admins post per-row feedback on a managed member's daily report; the
// member sees the thread on their own dashboard.

// Read: any branding member can fetch comments for rows they're allowed to see.
// We trust the row-id allowlist: the client only sends rows they already have
// access to via /reports (their own) or as a lead/admin viewing managed reports.
app.get("/api/branding/portal/report-row-comments", asyncHandler(async (req, res) => {
  if (!requireBranding(res)) return;
  const raw = req.query["row_ids"];
  const rowIds = typeof raw === "string"
    ? raw.split(",").filter(Boolean)
    : Array.isArray(raw)
      ? raw.flatMap(v => String(v).split(",")).filter(Boolean)
      : [];
  if (rowIds.length === 0) return res.json({ comments: [] });
  const comments = await listRowComments(rowIds);
  res.json({ comments });
}));

// Write: lead managing the row's owner, or admin/super_admin.
app.post("/api/branding/portal/report-row-comments", asyncHandler(async (req, res) => {
  if (!requireBrandingLead(res)) return;
  const { row_id, body } = req.body as { row_id?: string; body?: string };
  if (!row_id || !body?.trim()) return sendError(res, 400, "row_id and body are required.");
  const owner = await getRowOwner(row_id);
  if (!owner) return sendError(res, 404, "Row not found.");
  const actor = res.locals.currentUser;
  const isAdmin = actor.role === "super_admin" ||
    (actor.team === "branding" && actor.role === "admin");
  if (!isAdmin) {
    // sub_admin: only on managed members' rows (or their own).
    const target = await getUserById(owner.ownerUserId);
    if (!target || (target.managed_by !== actor.id && target.id !== actor.id)) {
      return sendError(res, 403, "You can only comment on rows of members you manage.");
    }
  }
  const comment = await createRowComment(row_id, actor.id, body.trim());
  res.status(201).json({ comment });
}));

// Edit/delete: author only.
app.patch("/api/branding/portal/report-row-comments/:id", asyncHandler(async (req, res) => {
  if (!requireBrandingLead(res)) return;
  const id = getSingleParam(req.params.id);
  const { body } = req.body as { body?: string };
  if (!body?.trim()) return sendError(res, 400, "body is required.");
  const comment = await updateRowComment(id, res.locals.currentUser.id, body.trim());
  if (!comment) return sendError(res, 404, "Comment not found or not yours to edit.");
  res.json({ comment });
}));

app.delete("/api/branding/portal/report-row-comments/:id", asyncHandler(async (req, res) => {
  if (!requireBrandingLead(res)) return;
  const id = getSingleParam(req.params.id);
  const ok = await deleteRowComment(id, res.locals.currentUser.id);
  if (!ok) return sendError(res, 404, "Comment not found or not yours to delete.");
  res.json({ ok: true });
}));

// ── Leave routes ───────────────────────────────────────────────────────────

// Apply for leave (any branding member, today or future only)
app.post("/api/branding/portal/leave", asyncHandler(async (req, res) => {
  if (!requireBranding(res)) return;
  const user = res.locals.currentUser;
  const body = req.body as {
    start_at?: string; end_at?: string;
    leave_date?: string;       // legacy clients (single full-day leave)
    reason?: string; transfer_date?: string;
  };
  let startAt = body.start_at;
  let endAt = body.end_at;
  if (!startAt || !endAt) {
    if (!body.leave_date) return sendError(res, 400, "start_at and end_at (or leave_date) are required.");
    startAt = `${body.leave_date}T09:00:00.000Z`;
    endAt   = `${body.leave_date}T17:00:00.000Z`;
  }
  const startDate = startAt.split("T")[0];
  const today = new Date().toISOString().split("T")[0];
  if (startDate < today) return sendError(res, 400, "Cannot apply leave for a past date.");
  try {
    const leave = await applyLeave(user.id, startAt, endAt, body.reason || "", body.transfer_date || undefined);
    res.status(201).json({ leave });
  } catch (e) {
    return sendError(res, 400, e instanceof Error ? e.message : "Invalid leave window.");
  }
}));

// Get leaves — user sees own; admins (or holders of the leave-calendar
// capability) see the whole team's.
app.get("/api/branding/portal/leaves", asyncHandler(async (req, res) => {
  if (!requireBranding(res)) return;
  const user = res.locals.currentUser;
  let canViewAll = isBrandingAdminOrSuper(user.role, user.team);
  if (!canViewAll && user.team === "branding") {
    const caps = await listUserCapabilities(user.id);
    canViewAll = caps.includes("branding:leave_calendar");
  }
  if (canViewAll) {
    const status = typeof req.query["status"] === "string" ? req.query["status"] : undefined;
    res.json({ leaves: await getAllLeaves(status) });
  } else {
    res.json({ leaves: await getUserLeaves(user.id) });
  }
}));

// Review a leave (admin: approve/reject + update transfer_date); users can only cancel pending
app.patch("/api/branding/portal/leave/:id", asyncHandler(async (req, res) => {
  if (!requireBranding(res)) return;
  const user = res.locals.currentUser;
  const leaveId = getSingleParam(req.params.id);
  if (!isBrandingAdminOrSuper(user.role, user.team)) {
    return sendError(res, 403, "Only admins can modify leave records.");
  }
  const { status, transfer_date } = req.body as { status?: string; transfer_date?: string | null };
  if (status) {
    if (status !== "approved" && status !== "rejected") return sendError(res, 400, "status must be approved or rejected.");
    const leave = await reviewLeave(leaveId, user.id, status);
    if (!leave) return sendError(res, 404, "Leave not found.");
    res.json({ leave });
  } else {
    // Admin updating transfer_date (no status change)
    const leave = await updateLeaveTransfer(leaveId, user.id, transfer_date ?? null);
    if (!leave) return sendError(res, 404, "Leave not found.");
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

// ── Outreach routes ────────────────────────────────────────────────────────

function requireOutreach(res: express.Response): boolean {
  const role = res.locals.currentUser?.role;
  if (role === "outreach_manager" || role === "super_admin") return true;
  sendError(res, 403, "Outreach manager only.");
  return false;
}

const outreachPageSchema = z.object({
  handle: z.string().min(1),
  geography: z.string().min(1),
  state: z.string().min(1),
  type: z.enum(OUTREACH_PAGE_TYPES),
  follower_tier: z.enum(OUTREACH_FOLLOWER_TIERS),
  content_types: z.array(z.enum(["static", "reel", "carousel"])).optional(),
  followers: z.number().int().nonnegative().optional(),
  inventory_posts: z.number().int().nonnegative(),
  inventory_stories: z.number().int().nonnegative(),
  notes: z.string().optional(),
});

// Creators share the page payload shape today; defined separately so they can
// diverge later without rippling through the page schema.
const outreachCreatorSchema = outreachPageSchema;

const outreachCampaignSchema = z.object({
  name: z.string().min(1),
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  // Optional — campaigns are open-ended; '' or absent means no end date.
  end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).or(z.literal("")).optional(),
  state: z.string().optional(),
  goal: z.string().optional(),
  status: z.enum(OUTREACH_CAMPAIGN_STATUSES),
  budget_posts: z.number().int().nonnegative(),
  budget_stories: z.number().int().nonnegative(),
  budget_reels: z.number().int().nonnegative(),
  approvers: z.array(z.string()),
  creative_variants: z.array(z.string()),
  assigned_page_ids: z.array(z.string()),
  assigned_creator_ids: z.array(z.string()).optional(),
});

// Pages

app.get("/api/outreach/pages", asyncHandler(async (_req, res) => {
  if (!requireOutreach(res)) return;
  res.json({ pages: await listOutreachPages() });
}));

app.post("/api/outreach/pages", asyncHandler(async (req, res) => {
  if (!requireOutreach(res)) return;
  const parsed = outreachPageSchema.safeParse(req.body);
  if (!parsed.success) return sendError(res, 400, "Invalid page payload.");
  const page = await createOutreachPage(parsed.data);
  res.status(201).json({ page });
}));

app.patch("/api/outreach/pages/:id", asyncHandler(async (req, res) => {
  if (!requireOutreach(res)) return;
  const parsed = outreachPageSchema.partial().safeParse(req.body);
  if (!parsed.success) return sendError(res, 400, "Invalid patch payload.");
  const page = await updateOutreachPage(getSingleParam(req.params.id), parsed.data);
  if (!page) return sendError(res, 404, "Page not found.");
  res.json({ page });
}));

app.delete("/api/outreach/pages/:id", asyncHandler(async (req, res) => {
  if (!requireOutreach(res)) return;
  await deleteOutreachPage(getSingleParam(req.params.id));
  res.json({ ok: true });
}));

// Creators — same shape as pages but stored separately. They don't appear in
// the All Pages ledger and aren't auto-synced by Apify.

app.get("/api/outreach/creators", asyncHandler(async (_req, res) => {
  if (!requireOutreach(res)) return;
  res.json({ creators: await listOutreachCreators() });
}));

app.post("/api/outreach/creators", asyncHandler(async (req, res) => {
  if (!requireOutreach(res)) return;
  const parsed = outreachCreatorSchema.safeParse(req.body);
  if (!parsed.success) return sendError(res, 400, "Invalid creator payload.");
  const creator = await createOutreachCreator(parsed.data);
  res.status(201).json({ creator });
}));

app.patch("/api/outreach/creators/:id", asyncHandler(async (req, res) => {
  if (!requireOutreach(res)) return;
  const parsed = outreachCreatorSchema.partial().safeParse(req.body);
  if (!parsed.success) return sendError(res, 400, "Invalid patch payload.");
  const creator = await updateOutreachCreator(getSingleParam(req.params.id), parsed.data);
  if (!creator) return sendError(res, 404, "Creator not found.");
  res.json({ creator });
}));

app.delete("/api/outreach/creators/:id", asyncHandler(async (req, res) => {
  if (!requireOutreach(res)) return;
  await deleteOutreachCreator(getSingleParam(req.params.id));
  res.json({ ok: true });
}));

// Campaigns

app.get("/api/outreach/campaigns", asyncHandler(async (_req, res) => {
  if (!requireOutreach(res)) return;
  res.json({ campaigns: await listOutreachCampaigns() });
}));

app.post("/api/outreach/campaigns", asyncHandler(async (req, res) => {
  if (!requireOutreach(res)) return;
  const parsed = outreachCampaignSchema.safeParse(req.body);
  if (!parsed.success) return sendError(res, 400, "Invalid campaign payload.");
  const campaign = await createOutreachCampaign(parsed.data);
  res.status(201).json({ campaign });
}));

app.patch("/api/outreach/campaigns/:id", asyncHandler(async (req, res) => {
  if (!requireOutreach(res)) return;
  const parsed = outreachCampaignSchema.partial().safeParse(req.body);
  if (!parsed.success) return sendError(res, 400, "Invalid patch payload.");
  const campaign = await updateOutreachCampaign(getSingleParam(req.params.id), parsed.data);
  if (!campaign) return sendError(res, 404, "Campaign not found.");
  res.json({ campaign });
}));

app.delete("/api/outreach/campaigns/:id", asyncHandler(async (req, res) => {
  if (!requireOutreach(res)) return;
  await deleteOutreachCampaign(getSingleParam(req.params.id));
  res.json({ ok: true });
}));

// Posts

app.get("/api/outreach/posts", asyncHandler(async (req, res) => {
  if (!requireOutreach(res)) return;
  const pageId = typeof req.query.page_id === "string" ? req.query.page_id : undefined;
  const creatorId = typeof req.query.creator_id === "string" ? req.query.creator_id : undefined;
  const campaignId = typeof req.query.campaign_id === "string" ? req.query.campaign_id : undefined;
  res.json({ posts: await listOutreachPosts({ pageId, creatorId, campaignId }) });
}));

const outreachPlannedPostSchema = z.object({
  page_id: z.string().min(1).optional(),
  creator_id: z.string().min(1).optional(),
  campaign_id: z.string().nullable().optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  type: z.enum(OUTREACH_POST_TYPES),
  creative_variant: z.string().nullable().optional(),
  caption: z.string().optional(),
  status: z.enum(OUTREACH_POST_STATUSES),
}).refine(
  d => Boolean(d.page_id) !== Boolean(d.creator_id),
  { message: "Provide exactly one of page_id or creator_id." },
);

app.post("/api/outreach/posts", asyncHandler(async (req, res) => {
  if (!requireOutreach(res)) return;
  const parsed = z.object({ posts: z.array(outreachPlannedPostSchema).min(1) }).safeParse(req.body);
  if (!parsed.success) return sendError(res, 400, "Invalid posts payload.");
  const created = await createOutreachPostsBulk(parsed.data.posts);
  res.status(201).json({ posts: created });
}));

app.delete("/api/outreach/posts/:id", asyncHandler(async (req, res) => {
  if (!requireOutreach(res)) return;
  await deleteOutreachPost(getSingleParam(req.params.id));
  res.json({ ok: true });
}));

// Fetch metrics for specific Instagram post/reel URLs and persist them as
// posts under (campaign, page). Used by the "add live posts" dialog.

const outreachLivePostsSchema = z.object({
  campaign_id: z.string().min(1).optional(),
  page_id: z.string().min(1).optional(),
  creator_id: z.string().min(1).optional(),
  urls: z.array(z.string().min(1)).min(1).max(20),
  /** Optional set/creative variant — must be one of the campaign's variants when set. */
  creative_variant: z.string().min(1).optional(),
}).refine(
  d => Boolean(d.page_id) !== Boolean(d.creator_id),
  { message: "Provide exactly one of page_id or creator_id." },
);

app.post("/api/outreach/posts/fetch-by-urls", asyncHandler(async (req, res) => {
  if (!requireOutreach(res)) return;
  const parsed = outreachLivePostsSchema.safeParse(req.body);
  if (!parsed.success) return sendError(res, 400, parsed.error.issues[0]?.message ?? "Invalid payload.");
  try {
    const result = await addLivePosts({
      campaignId: parsed.data.campaign_id,
      pageId: parsed.data.page_id,
      creatorId: parsed.data.creator_id,
      urls: parsed.data.urls,
      creativeVariant: parsed.data.creative_variant,
    });
    res.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to fetch posts.";
    // Treat validation errors (campaign / page / creator / membership) as 400;
    // Apify or network errors bubble up as 502.
    const status = /not found|not assigned|required|exactly one/i.test(msg) ? 400 : 502;
    return sendError(res, status, msg);
  }
}));

// Sync — pulls latest profile + posts from Apify for all pages (or a subset)

app.post("/api/outreach/sync", asyncHandler(async (req, res) => {
  if (!requireOutreach(res)) return;
  const handlesRaw = req.body?.handles;
  const handles = Array.isArray(handlesRaw)
    ? handlesRaw.filter((h: unknown): h is string => typeof h === "string")
    : undefined;
  try {
    const result = await syncOutreach({ handles });
    res.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Sync failed.";
    return sendError(res, 502, msg);
  }
}));

// Refresh reach — re-scrapes every tracked live post (across all pages) by
// permalink and updates its metrics. This is the on-demand equivalent of what
// the scheduled 9AM/5PM runs do, without the profile scrape. Paid Apify calls.
app.post("/api/outreach/refresh-reach", asyncHandler(async (req, res) => {
  if (!requireOutreach(res)) return;
  try {
    const result = await refreshLivePostMetrics();
    res.json({ ok: true, ...result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Refresh failed.";
    return sendError(res, 502, msg);
  }
}));

// ── Start server ───────────────────────────────────────────────────────────

bootstrapDatabase()
  .then(() => bootstrapBrandingDatabase())
  .then(() => bootstrapSettingsDatabase())
  .then(() => bootstrapOutreach())
  .then(async () => {
    // Catch up on any reports whose 21:00 IST submit cutoff or 17:00 IST
    // auto-pause cutoff already passed while the server was down, then keep an
    // interval running so future cutoffs fire even if no user action triggers
    // the API.
    try {
      const caught = await autoSubmitOverdueReports();
      if (caught > 0) console.log(`Auto-submitted ${caught} overdue daily report(s) on startup.`);
    } catch (e) {
      console.error('Initial auto-submit pass failed:', e);
    }
    try {
      const paused = await autoPauseRunningStopwatches();
      if (paused > 0) console.log(`Auto-paused ${paused} overdue running stopwatch(es) on startup.`);
    } catch (e) {
      console.error('Initial auto-pause pass failed:', e);
    }
    setInterval(() => {
      autoSubmitOverdueReports()
        .then(n => { if (n > 0) console.log(`Auto-submitted ${n} overdue daily report(s).`); })
        .catch(e => console.error('Periodic auto-submit failed:', e));
      autoPauseRunningStopwatches()
        .then(n => { if (n > 0) console.log(`Auto-paused ${n} overdue running stopwatch(es).`); })
        .catch(e => console.error('Periodic auto-pause failed:', e));
      // Outreach metrics auto-refresh at 9:00 AM and 5:00 PM IST. Self-gated so
      // it fires at most once per slot per day; the manual "Sync now" button is
      // unaffected. (Spec: Data & Sync Behaviour → Automatic Data Refresh.)
      maybeRunScheduledSync()
        .then(r => { if (r) console.log(`Outreach auto-sync (${r.slot} IST): ${r.result.synced_pages} pages, ${r.result.upserted_posts} posts, ${r.result.refreshed_live_posts} live posts refreshed.`); })
        .catch(e => console.error('Outreach auto-sync failed:', e));
    }, 5 * 60 * 1000).unref();

    app.listen(config.apiPort, () => {
      console.log(`Nerve API listening on ${config.apiPort}`);
    });
  })
  .catch((error) => {
    console.error("Failed to start API", error);
    process.exit(1);
  });
