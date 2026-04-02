import { DEFAULT_SUPER_ADMIN_EMAIL, LEGACY_SUPER_ADMIN_PASSWORD } from "./seed.js";

function requireEnv(key: string) {
  const value = process.env[key]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

const databaseUrl = requireEnv("DATABASE_URL");
const sessionSecret = requireEnv("SESSION_SECRET");
const superAdminPassword = requireEnv("SUPER_ADMIN_PASSWORD");

if (superAdminPassword === LEGACY_SUPER_ADMIN_PASSWORD) {
  throw new Error("SUPER_ADMIN_PASSWORD must not use the legacy default password.");
}

export const config = {
  apiPort: Number(process.env.API_PORT || 3001),
  appBaseUrl: process.env.APP_BASE_URL || "http://127.0.0.1",
  cookieSecure: process.env.COOKIE_SECURE === "true",
  databaseUrl,
  sessionSecret,
  superAdminEmail: process.env.SUPER_ADMIN_EMAIL?.trim() || DEFAULT_SUPER_ADMIN_EMAIL,
  superAdminPassword,
  smtp: {
    host: process.env.SMTP_HOST || "smtp.gmail.com",
    port: Number(process.env.SMTP_PORT || 587),
    user: process.env.SMTP_USER || "",
    pass: process.env.SMTP_PASS || "",
    from: process.env.SMTP_FROM || "noreply@parul.ac.in",
  },
};
