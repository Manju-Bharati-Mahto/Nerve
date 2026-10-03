/* ═══════════════════════════════════════════════════════════════════════════
   The service worker, driven the way a browser drives it.

   A worker fails in the one situation nobody is watching: the network is down,
   or a proxy answered 502, or the session expired mid-navigation. Every rule
   here exists because getting it wrong leaves the INSTALLED app broken in a way
   a reload cannot fix — a gateway error page cached as the shell is served from
   disk forever after, and respondWith(undefined) kills the navigation outright.

   sw.js is a plain script with listeners on `self`, so it is evaluated in a
   sandbox with a minimal Cache Storage and the listeners are called directly.
   ═══════════════════════════════════════════════════════════════════════════ */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const SRC = readFileSync("public/media-ops/sw.js", "utf8");
const PAGE = "/api/media-ops/index.html";

type Res = { ok: boolean; type: string; status?: number; headers: { get(k: string): string | null };
             clone(): Res; body?: string };

const res = (over: Partial<Res> & { ct?: string } = {}): Res => {
  const ct = over.ct ?? "text/html";
  const r: Res = {
    ok: over.ok ?? true, type: over.type ?? "basic", status: over.status ?? 200,
    headers: { get: (k: string) => (k.toLowerCase() === "content-type" ? ct : null) },
    body: over.body, clone: () => r,
  };
  return r;
};

/** A Cache Storage good enough for the worker: named caches of url → response. */
function makeCaches() {
  const store = new Map<string, Map<string, Res>>();
  const key = (req: unknown) => (typeof req === "string" ? req : (req as { url: string }).url);
  return {
    store,
    api: {
      open: async (name: string) => {
        if (!store.has(name)) store.set(name, new Map());
        const c = store.get(name)!;
        return {
          addAll: async (urls: string[]) => { for (const u of urls) c.set(u, res()); },
          put: async (req: unknown, r: Res) => { c.set(key(req), r); },
        };
      },
      keys: async () => [...store.keys()],
      delete: async (name: string) => store.delete(name),
      match: async (req: unknown) => {
        for (const c of store.values()) { const hit = c.get(key(req)); if (hit) return hit; }
        return undefined;
      },
    },
  };
}

function load(fetchImpl: (req: unknown) => Promise<Res>) {
  const listeners: Record<string, ((e: unknown) => void)[]> = {};
  const c = makeCaches();
  const sandbox = {
    self: {
      addEventListener: (t: string, fn: (e: unknown) => void) => { (listeners[t] ??= []).push(fn); },
      skipWaiting: () => Promise.resolve(),
      clients: { claim: () => Promise.resolve() },
    },
    caches: c.api,
    fetch: fetchImpl,
    URL,
    Response: class { status: number; body: string; headers: Map<string, string>;
      constructor(body: string, init?: { status?: number; headers?: Record<string, string> }) {
        this.body = body; this.status = init?.status ?? 200;
        this.headers = new Map(Object.entries(init?.headers ?? {}));
      } },
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);

  /* Drive one event and hand back whatever the worker responded with. */
  const fire = async (type: string, event: Record<string, unknown>) => {
    let waited: Promise<unknown> | undefined, responded: Promise<unknown> | undefined;
    const e = { ...event,
      waitUntil: (p: Promise<unknown>) => { waited = p; },
      respondWith: (p: Promise<unknown>) => { responded = p; } };
    for (const fn of listeners[type] ?? []) fn(e);
    if (waited) await waited;
    return responded ? await responded : undefined;
  };
  return { fire, caches: c };
}

const navEvent = (url = `http://x.test${PAGE}`) =>
  ({ request: { method: "GET", mode: "navigate", url }, });

describe("install", () => {
  it("caches the shell, including every icon the manifest names", async () => {
    const { fire, caches } = load(async () => res());
    await fire("install", {});
    const cache = [...caches.store.values()][0];
    const urls = [...cache.keys()];
    expect(urls).toContain(PAGE);
    for (const icon of ["icon-192.png", "icon-512.png", "icon-maskable-512.png", "apple-touch-icon.png"])
      expect(urls, `${icon} is missing from SHELL — addAll is atomic, so install fails silently`)
        .toContain(`/api/media-ops/${icon}`);
  });
});

describe("activate", () => {
  it("drops its own old caches and leaves everyone else's alone", async () => {
    const { fire, caches } = load(async () => res());
    caches.store.set("mo-v3", new Map());
    caches.store.set("mo-v2", new Map());
    caches.store.set("mo-v1", new Map());
    caches.store.set("workbox-precache", new Map());   // somebody else on the origin
    caches.store.set("mo-v4", new Map());
    await fire("activate", {});
    expect([...caches.store.keys()].sort()).toEqual(["mo-v4", "workbox-precache"]);
  });
});

describe("a navigation", () => {
  let cached: Res | undefined;
  beforeEach(() => { cached = undefined; });

  it("serves the network and caches it when the answer really is the shell", async () => {
    const { fire, caches } = load(async () => res());
    await fire("fetch", navEvent());
    await new Promise((r) => setTimeout(r, 0));          // the put is not awaited by the handler
    cached = await caches.api.match(PAGE);
    expect(cached).toBeDefined();
  });

  for (const [name, bad] of [
    ["a 502 from a proxy", res({ ok: false, status: 502 })],
    ["a redirect to a login page on another origin", res({ type: "opaqueredirect" })],
    ["a navigation that landed on the manifest", res({ ct: "application/manifest+json" })],
  ] as [string, Res][]) {
    it(`does not overwrite the shell with ${name}`, async () => {
      const { fire, caches } = load(async () => bad);
      await (await load(async () => bad)).fire("install", {});
      await fire("fetch", navEvent());
      await new Promise((r) => setTimeout(r, 0));
      const hit = await caches.api.match(PAGE);
      expect(hit, "a non-shell response was cached as the shell").toBeUndefined();
    });
  }

  it("falls back to the cached shell when the network is gone", async () => {
    const { fire } = load(async () => { throw new Error("offline"); });
    await fire("install", {});                            // shell is in the cache
    const out = await fire("fetch", navEvent());
    expect(out).toBeDefined();
    expect((out as Res).headers.get("content-type")).toBe("text/html");
  });

  it("still answers with a page when the cache is empty too", async () => {
    const { fire } = load(async () => { throw new Error("offline"); });
    const out = await fire("fetch", navEvent()) as { status: number; body: string };
    /* Never undefined: respondWith(undefined) throws and the navigation dies. */
    expect(out).toBeDefined();
    expect(out.status).toBe(503);
    expect(out.body).toContain("offline");
  });
});

describe("icons and the manifest", () => {
  it("come from the cache immediately, and refresh behind you", async () => {
    let hits = 0;
    const { fire, caches } = load(async () => { hits++; return res({ ct: "image/png" }); });
    const url = "http://x.test/api/media-ops/icon-192.png";
    (await caches.api.open("mo-v4")).put(url, res({ ct: "image/png", body: "old" }));
    const out = await fire("fetch", { request: { method: "GET", mode: "no-cors", url } }) as Res;
    expect(out.body, "served from the network instead of the cache").toBe("old");
    await new Promise((r) => setTimeout(r, 0));
    expect(hits, "no background refresh was started").toBe(1);
  });
});
