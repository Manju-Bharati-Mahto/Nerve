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
  apify: {
    token: process.env.APIFY_TOKEN?.trim() || "",
    profileActor: process.env.APIFY_PROFILE_ACTOR?.trim() || "apify~instagram-profile-scraper",
    postActor: process.env.APIFY_POST_ACTOR?.trim() || "apify~instagram-post-scraper",
    // Optional Instagram session cookie. When set, we forward it to Apify so
    // the scraper runs as a logged-in user, which returns live counts instead
    // of the stale logged-out snapshots Instagram serves to bots.
    //   - Easiest: paste just the `sessionid` cookie value from a logged-in
    //     browser (DevTools → Application → Cookies → instagram.com → sessionid).
    //   - Power user: paste a JSON array of cookie objects (we'll pass them
    //     through verbatim).
    instagramSessionCookie: process.env.APIFY_IG_SESSION_COOKIE?.trim() || "",
  },
};
