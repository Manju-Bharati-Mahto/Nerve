import express from "express";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import { z } from "zod";
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

const app = express();
const PgStore = connectPgSimple(session);

app.set("trust proxy", 1);
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

  (req as SessionRequest).session.userId = user.id;
  res.json({ user: { ...user, password_hash: undefined } });
}));

app.post("/api/auth/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("connect.sid");
    res.json({ ok: true });
  });
});

app.use("/api", asyncHandler(async (req, res, next) => {
  if (req.path === "/health" || req.path.startsWith("/auth/")) return next();
  const user = await getSessionUser(req as SessionRequest);
  if (!user) return sendError(res, 401, "Authentication required.");
  res.locals.currentUser = user;
  return next();
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

app.patch("/api/users/:id", asyncHandler(async (req, res) => {
  const userId = getSingleParam(req.params.id);
  const currentUser = res.locals.currentUser;
  if (currentUser.role !== "super_admin") {
    return sendError(res, 403, "Only the super admin can modify users.");
  }

  const parsed = updateUserSchema.safeParse(req.body);
  if (!parsed.success) return sendError(res, 400, "Invalid user update payload.");

  const updated = await updateUser(userId, parsed.data);
  if (!updated) return sendError(res, 404, "User not found.");
  res.json({ user: updated });
}));

app.delete("/api/users/:id", asyncHandler(async (req, res) => {
  const userId = getSingleParam(req.params.id);
  const currentUser = res.locals.currentUser;
  if (currentUser.role !== "super_admin") {
    return sendError(res, 403, "Only the super admin can delete users.");
  }
  if (currentUser.id === userId) {
    return sendError(res, 400, "You cannot delete the currently logged-in super admin.");
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

bootstrapDatabase()
  .then(() => {
    app.listen(config.apiPort, () => {
      console.log(`Nerve API listening on ${config.apiPort}`);
    });
  })
  .catch((error) => {
    console.error("Failed to start API", error);
    process.exit(1);
  });
