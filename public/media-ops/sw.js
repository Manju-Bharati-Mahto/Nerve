/* Nerve Media Ops — service worker (Phase 4: PWA / offline).
   Served under /api/media-ops/, so this worker's scope is /api/media-ops/ and it only
   controls its own shell + assets. /api/v1/media/* data calls are outside scope and
   always hit the network. The shell is cached so the app opens offline; writes still
   require connectivity.

   Bump CACHE whenever the shell list, the manifest or the icons change. */
const CACHE = "mo-v3";
const PAGE = "/api/media-ops/index.html";
const SHELL = [
  PAGE,
  "/api/media-ops/manifest.webmanifest",
  "/api/media-ops/icon.svg",
  "/api/media-ops/icon-192.png",
  "/api/media-ops/icon-512.png",
  "/api/media-ops/icon-maskable-512.png",
  "/api/media-ops/apple-touch-icon.png",
];

/* addAll is atomic: one missing file fails the whole install, and silently,
   because the registration error is swallowed at the call site. Every path
   above must exist — scripts/generate-media-ops-icons.mjs writes the PNGs. */
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

/* Only this worker's own caches are dropped. A bare `k !== CACHE` would also
   delete caches belonging to anything else on the origin. */
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((ks) => Promise.all(ks.filter((k) => k.startsWith("mo-") && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

/* The shell is replaced only by something that IS the shell: a 200, from this
   origin, and HTML. Otherwise a 502 from a proxy, a 401 redirect, or a
   navigation that lands on the manifest gets written over index.html — and the
   app then opens offline showing a gateway error. A stale cached shell is
   recoverable; a wrong one is not. */
const cacheable = (r) =>
  !!r && r.ok && r.type === "basic" && (r.headers.get("content-type") || "").startsWith("text/html");

/* Never respondWith(undefined): when the cache misses too, that throws and the
   navigation dies as a browser network error instead of a page. */
const offlinePage = () =>
  caches.match(PAGE).then((c) => c || new Response(
    "<!doctype html><meta charset=utf-8><title>Offline</title>"
    + "<body style=\"font:16px system-ui;padding:24px\"><h1>You're offline</h1>"
    + "<p>Media Ops could not be loaded. Reconnect and try again.</p>",
    { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } }));

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);

  // Navigations → network first, cached shell when the network cannot answer.
  if (e.request.mode === "navigate" || url.pathname === PAGE) {
    e.respondWith(fetch(e.request)
      .then((r) => {
        if (cacheable(r)) { const cp = r.clone(); caches.open(CACHE).then((c) => c.put(PAGE, cp)); }
        return r;
      })
      .catch(offlinePage));
    return;
  }

  // Manifest and icons → stale-while-revalidate: instant, refreshed behind you.
  if (/\/(manifest\.webmanifest|icon[\w.-]*\.(?:png|svg)|apple-touch-icon\.png)$/.test(url.pathname)) {
    e.respondWith(caches.match(e.request).then((hit) => {
      const net = fetch(e.request).then((r) => {
        if (r && r.ok) { const cp = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, cp)); }
        return r;
      }).catch(() => hit);
      return hit || net;
    }));
    return;
  }

  // Own static assets → cache-first.
  if (url.pathname.startsWith("/api/media-ops/")) {
    e.respondWith(caches.match(e.request).then((c) => c || fetch(e.request)
      .then((r) => {
        if (r && r.ok) { const cp = r.clone(); caches.open(CACHE).then((cc) => cc.put(e.request, cp)); }
        return r;
      })));
  }
});
