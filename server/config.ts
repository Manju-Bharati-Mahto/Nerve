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
  /* AI provider (Phase 1). Entirely optional, and deliberately NOT read through
     requireEnv(): with none of these set the AI layer reports itself disabled and
     Nerve boots and runs exactly as it did before. Nothing here may throw.
     AI_API_KEY is server-only — it must never gain a VITE_ prefix, which would
     inline it into the browser bundle. */
  ai: {
    provider: process.env.AI_PROVIDER?.trim() || "openai-compatible",
    baseUrl: process.env.AI_BASE_URL?.trim() || "",
    apiKey: process.env.AI_API_KEY?.trim() || "",
    model: process.env.AI_MODEL?.trim() || "",
    timeoutMs: Number(process.env.AI_TIMEOUT_MS || 30000),
    maxOutputTokens: Number(process.env.AI_MAX_OUTPUT_TOKENS || 1024),
    /* Per-user requests per Nerve calendar day. The per-minute limiter stops a
       runaway loop; this stops a determined user running up a bill over hours,
       which a per-minute limit cannot. Deliberately conservative — it is far
       easier to raise once real usage is understood than to explain an invoice. */
    dailyRequestLimit: Number(process.env.AI_DAILY_REQUEST_LIMIT || 50),
    /* Optional per-model rates, as JSON. Unset by default — no price for any
       model is assumed, so estimated_cost stays NULL until an operator supplies
       figures from their own billing page. See server/ai/pricing.ts. */
    pricing: process.env.AI_PRICING?.trim() || "",
  },
  /* Google Drive — the storage AND live data source for the Outreach video
     workflow (PRD §6, §23, §28: "no external database may be introduced").
     Entirely optional and never read through requireEnv(): with nothing set the
     video workflow reports itself unconfigured and the rest of Nerve boots
     exactly as before.

     Two auth shapes are supported; whichever is configured wins:
       1. Service account (preferred) — set GOOGLE_SA_CLIENT_EMAIL and
          GOOGLE_SA_PRIVATE_KEY. A service account has no Drive storage quota of
          its own, so GOOGLE_DRIVE_ROOT_FOLDER_ID must live in a Shared Drive the
          account has Content-manager access to.
       2. OAuth refresh token — set GOOGLE_OAUTH_CLIENT_ID, _CLIENT_SECRET and
          _REFRESH_TOKEN to act as one agency Google account. Works with an
          ordinary My Drive folder.

     GOOGLE_DRIVE_ROOT_FOLDER_ID is the "Agency Video Workflow/" folder; the
     store creates the documented sub-structure beneath it on first use.

     With DRIVE_LOCAL_ROOT set instead, a filesystem adapter with identical
     semantics is used — same JSON layout, same revision guards — so the module
     is fully runnable in dev and tests without Google credentials. */
  drive: {
    rootFolderId: process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID?.trim() || "",
    serviceAccountEmail: process.env.GOOGLE_SA_CLIENT_EMAIL?.trim() || "",
    // Stored with literal "\n" escapes in .env; unescape to a real PEM.
    serviceAccountKey: (process.env.GOOGLE_SA_PRIVATE_KEY || "").replace(/\\n/g, "\n").trim(),
    oauthClientId: process.env.GOOGLE_OAUTH_CLIENT_ID?.trim() || "",
    oauthClientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim() || "",
    oauthRefreshToken: process.env.GOOGLE_OAUTH_REFRESH_TOKEN?.trim() || "",
    /* Dev/test filesystem adapter. Ignored whenever real Google credentials are
       present, so it can never silently shadow production Drive. */
    localRoot: process.env.DRIVE_LOCAL_ROOT?.trim() || "",
  },
  apify: {
    token: process.env.APIFY_TOKEN?.trim() || "",
    profileActor: process.env.APIFY_PROFILE_ACTOR?.trim() || "apify~instagram-profile-scraper",
    postActor: process.env.APIFY_POST_ACTOR?.trim() || "apify~instagram-post-scraper",
    // Facebook Posts Scraper — used both for page-level batch sync (startUrls =
    // page URLs, returns recent posts) and specific-URL metric refresh
    // (startUrls = post/reel URLs). One actor, two call shapes, same as how
    // apify/instagram-post-scraper is reused for both modes on the IG side.
    facebookPostActor: process.env.APIFY_FACEBOOK_ACTOR?.trim() || "apify~facebook-posts-scraper",
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
