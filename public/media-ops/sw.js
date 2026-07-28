/* Nerve Media Ops — service worker (Phase 4: PWA / offline).
   Shell + last-good /state are cached so the app opens and shows the most recent
   data with no network; writes still require connectivity (they queue in the UI). */
const CACHE = "mo-v1";
const SHELL = ["/media-ops/index.html", "/media-ops/manifest.webmanifest", "/media-ops/icon.svg"];

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
  if (e.request.mode === "navigate" || url.pathname.endsWith("/media-ops/index.html")) {
    e.respondWith(fetch(e.request)
      .then((r) => { const cp = r.clone(); caches.open(CACHE).then((c) => c.put("/media-ops/index.html", cp)); return r; })
      .catch(() => caches.match("/media-ops/index.html")));
    return;
  }
  // Live state → network-first, cache last-good for offline reads.
  if (url.pathname.endsWith("/api/v1/media/state")) {
    e.respondWith(fetch(e.request)
      .then((r) => { const cp = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, cp)); return r; })
      .catch(() => caches.match(e.request)));
    return;
  }
  // Own static assets → cache-first.
  if (url.pathname.startsWith("/media-ops/")) {
    e.respondWith(caches.match(e.request).then((c) => c || fetch(e.request)
      .then((r) => { const cp = r.clone(); caches.open(CACHE).then((cc) => cc.put(e.request, cp)); return r; })));
  }
});
