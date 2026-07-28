/* Nerve Media Ops — service worker (Phase 4: PWA / offline).
   Served under /api/media-ops/, so this worker's scope is /api/media-ops/ and it only
   controls its own shell + assets. /api/v1/media/* data calls are outside scope and
   always hit the network. The shell is cached so the app opens offline; writes still
   require connectivity. */
const CACHE = "mo-v2";
const SHELL = ["/api/media-ops/index.html", "/api/media-ops/manifest.webmanifest", "/api/media-ops/icon.svg"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);

  // App shell / navigations → network-first, fall back to cached shell offline.
  if (e.request.mode === "navigate" || url.pathname.endsWith("/api/media-ops/index.html")) {
    e.respondWith(fetch(e.request)
      .then((r) => { const cp = r.clone(); caches.open(CACHE).then((c) => c.put("/api/media-ops/index.html", cp)); return r; })
      .catch(() => caches.match("/api/media-ops/index.html")));
    return;
  }
  // Own static assets → cache-first.
  if (url.pathname.startsWith("/api/media-ops/")) {
    e.respondWith(caches.match(e.request).then((c) => c || fetch(e.request)
      .then((r) => { const cp = r.clone(); caches.open(CACHE).then((cc) => cc.put(e.request, cp)); return r; })));
  }
});
