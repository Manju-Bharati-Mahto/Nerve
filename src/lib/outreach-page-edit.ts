/**
 * Editing an outreach page (PRD 6.5) — the two values a person types that the
 * rest of the system then relies on: the page's name (its handle) and its link.
 *
 * WHY THESE ARE CHECKED. The handle is not a label: the Instagram sync finds a
 * page's posts by it, and the Facebook sync builds the page's URL from it. A
 * renamed page whose handle is not a real account silently stops syncing, so a
 * rename must at least be a well-formed username — "my page" used to be cut to
 * "my" by the client and stored. The link had no check at all: any text was
 * accepted, including another platform's URL, and shown as "Open on Instagram".
 *
 * Pure functions, no database and no config: they are unit-tested on their
 * own and shared by the influencer page edit and the video workflow's page
 * details edit, so both paths apply one rule.
 *
 * TWO COPIES, ONE TEXT. server/outreach-page-edit.ts and
 * src/lib/outreach-page-edit.ts are byte-identical, so the Edit page dialog
 * says "will save as @x" or "not a link to this page" by exactly the rule the
 * server then applies. src/lib/outreach-page-edit.test.ts fails the moment
 * they differ: edit one and copy it over the other.
 */

export type PagePlatform = "instagram" | "facebook";

/* `problem` is on both arms so a caller can read it without narrowing first
   (the browser build does not narrow on a boolean literal). */
export type Checked<K extends string> =
  | ({ ok: true; problem: null } & Record<K, string>)
  | ({ ok: false; problem: string } & Partial<Record<K, undefined>>);

// Instagram's own username rule.
const INSTAGRAM_HANDLE = /^[A-Za-z0-9._]{1,30}$/;
// A Facebook vanity name: letters, digits, dots, hyphens, underscores.
const FACEBOOK_HANDLE = /^[A-Za-z0-9._-]{1,100}$/;

const INSTAGRAM_URL = /^(?:https?:\/\/)?(?:www\.|m\.)?instagram\.com\/([^/?#\s]+)/i;
const FACEBOOK_URL = /^(?:https?:\/\/)?(?:www\.|m\.|web\.)?(?:facebook\.com|fb\.com)\/([^/?#\s]+)/i;

const PLATFORM_NAME: Record<PagePlatform, string> = { instagram: "Instagram", facebook: "Facebook" };

/* The first path segment of these URLs is not an account: a pasted post link
   (instagram.com/p/…) or a numeric Facebook profile would otherwise be stored
   as the page "p" or "profile.php". */
const NOT_AN_ACCOUNT: Record<PagePlatform, ReadonlySet<string>> = {
  instagram: new Set(["p", "reel", "reels", "tv", "stories", "explore", "accounts"]),
  facebook: new Set(["profile.php", "pages", "groups", "watch", "share", "story.php", "permalink.php", "photo.php", "events"]),
};

/**
 * The handle to store for what somebody typed as a page's name: "@name",
 * "name", or the page's profile URL pasted in. Refuses anything that is not a
 * well-formed username for the platform, rather than storing a handle the
 * sync can never find.
 */
export function normalisePageHandle(platform: PagePlatform, raw: string): Checked<"handle"> {
  const text = raw.trim();
  if (!text) return { ok: false, problem: "Page name can't be blank." };
  const fromUrl = (platform === "facebook" ? FACEBOOK_URL : INSTAGRAM_URL).exec(text);
  const handle = (fromUrl ? fromUrl[1] : text).replace(/^@+/, "");
  const valid = platform === "facebook" ? FACEBOOK_HANDLE : INSTAGRAM_HANDLE;
  if (fromUrl && NOT_AN_ACCOUNT[platform].has(handle.toLowerCase())) {
    return { ok: false, problem: `That is a link to a post or a numeric profile, not the page — paste the page's own ${PLATFORM_NAME[platform]} address or type its username.` };
  }
  if (!valid.test(handle)) {
    return {
      ok: false,
      problem: platform === "facebook"
        ? `"${text}" is not a Facebook page name — use the part after facebook.com/ (letters, digits, dots, hyphens, underscores).`
        : `"${text}" is not an Instagram username — 1 to 30 letters, digits, dots or underscores, no spaces.`,
    };
  }
  return { ok: true, problem: null, handle };
}

/** The bare host a person means: "www.", "m." and "web." are the same site. */
function siteOf(hostname: string): string {
  return hostname.toLowerCase().replace(/^(?:www|m|web)\./, "");
}

/**
 * The page link to store: '' (clears it), or an http(s) URL on the page's own
 * platform that points at something past the bare site. A link typed without
 * a scheme ("instagram.com/name") gets https://.
 */
export function normalisePageLink(platform: PagePlatform, raw: string): Checked<"link"> {
  const text = raw.trim();
  if (!text) return { ok: true, problem: null, link: "" };
  const example = platform === "facebook" ? "https://www.facebook.com/<page>" : "https://www.instagram.com/<handle>/";
  const problem = `Page link must be ${platform === "instagram" ? "an" : "a"} ${PLATFORM_NAME[platform]} link to the page, e.g. ${example}`;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return { ok: false, problem };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false, problem };
  const site = siteOf(url.hostname);
  const allowed = platform === "facebook" ? site === "facebook.com" || site === "fb.com" : site === "instagram.com";
  if (!allowed || url.pathname.replace(/\/+$/, "") === "") return { ok: false, problem };
  return { ok: true, problem: null, link: url.href };
}

/** Handles compared the way the server's duplicate check reads them: no leading @, any case. */
export function handleKey(handle: string): string {
  return handle.trim().replace(/^@+/, "").toLowerCase();
}
