/**
 * The Drive-backed data stores (PRD §6) and the read-modify-write discipline
 * that keeps them consistent (PRD §24).
 *
 * Drive is the database here — there is no Postgres table behind any of this
 * (§28). That makes the write path the critical piece of the module, so it is
 * deliberately the most carefully built part:
 *
 *   1. Writes to a given store are serialised in-process by a promise chain, so
 *      two concurrent requests can never interleave their read-modify-write.
 *      Nerve runs a single API container, so this covers the real deployment.
 *   2. Every write still carries the revision id the data was read at, and the
 *      client re-checks it immediately before writing. If anything changed
 *      underneath (another process, someone editing the JSON in Drive by hand)
 *      the write is rejected and the whole mutation is retried against fresh
 *      data — never merged blindly over the top (§24 "never blindly overwrite
 *      stale data").
 *   3. Reads are served from an in-memory cache that this process keeps in step
 *      on every write, with a short TTL so out-of-band edits still get picked
 *      up. Without it, §20's KPI dashboard would re-download the whole workflow
 *      document on every page load.
 *
 * The folder layout created on first use matches §6 exactly.
 */
import {
  getDriveClient, RevisionMismatchError, type DriveClient,
} from "./drive-client.js";
import {
  EMPTY_EVENT_STORE, EMPTY_USER_STORE, EMPTY_WORKFLOW_STORE,
  type EventStoreDoc, type UserStoreDoc, type WorkflowStoreDoc,
} from "./types.js";

/** §6 — the documented tree beneath "Agency Video Workflow/". */
export const STORE_FILES = {
  users: "user-data-store.json",
  workflow: "workflow-data-store.json",
  events: "event-data-store.json",
} as const;

export const VIDEOS_FOLDER = "Videos";
export const THUMBNAILS_FOLDER = "Thumbnails";
export const REPORTS_FOLDER = "Reports";

export type StoreName = keyof typeof STORE_FILES;

interface CacheEntry<T> { doc: T; revisionId: string; fileId: string; fetchedAt: number }

/**
 * How long a cached document is trusted without re-checking Drive. Short enough
 * that an out-of-band edit surfaces quickly, long enough that a dashboard
 * rendering a dozen KPI cards doesn't re-download the store for each one.
 * Writes made by this process update the cache directly, so this TTL only ever
 * governs staleness from *other* writers.
 */
const CACHE_TTL_MS = 10_000;

/** Bounded retries for a losing optimistic write before surfacing the conflict. */
const MAX_WRITE_ATTEMPTS = 4;

const cache = new Map<StoreName, CacheEntry<unknown>>();
/** Per-store promise chain: the serialisation described in the header. */
const writeQueues = new Map<StoreName, Promise<unknown>>();
let folderIdsPromise: Promise<Record<string, string>> | null = null;

function emptyDoc(store: StoreName): unknown {
  if (store === "users") return EMPTY_USER_STORE;
  if (store === "workflow") return EMPTY_WORKFLOW_STORE;
  return EMPTY_EVENT_STORE;
}

/**
 * Creates the §6 folder structure if absent and returns the folder ids. Runs at
 * most once per process — concurrent callers share the same in-flight promise.
 */
export function ensureDriveStructure(): Promise<Record<string, string>> {
  if (folderIdsPromise) return folderIdsPromise;
  folderIdsPromise = (async () => {
    const { client, rootId } = getDriveClient();
    const videos = await client.ensureFolder(VIDEOS_FOLDER, rootId);
    const thumbnails = await client.ensureFolder(THUMBNAILS_FOLDER, rootId);
    const reports = await client.ensureFolder(REPORTS_FOLDER, rootId);
    return { root: rootId, videos, thumbnails, reports };
  })().catch(err => {
    // Don't cache a failed bootstrap — a transient Drive outage must not wedge
    // the module for the life of the process (§29 "allow retry").
    folderIdsPromise = null;
    throw err;
  });
  return folderIdsPromise;
}

/** Resolves a store's Drive file, creating it empty on first use. */
async function locate(client: DriveClient, store: StoreName): Promise<{ fileId: string }> {
  const { rootId } = getDriveClient();
  const name = STORE_FILES[store];
  const existing = await client.findChild(name, rootId);
  if (existing) return { fileId: existing.id };
  const created = await client.createTextFile(name, rootId, JSON.stringify(emptyDoc(store), null, 2));
  return { fileId: created.id };
}

async function fetchFresh<T>(store: StoreName): Promise<CacheEntry<T>> {
  const { client } = getDriveClient();
  const { fileId } = await locate(client, store);
  const { content, revisionId } = await client.readTextFile(fileId);
  let doc: T;
  try {
    doc = JSON.parse(content) as T;
  } catch {
    // A corrupt store is never silently reset — that would destroy history,
    // which §28 forbids. Surface it so it can be repaired from Drive's own
    // version history instead.
    throw new Error(`The ${store} data store in Google Drive is not valid JSON. Restore it from Drive's version history rather than overwriting it.`);
  }
  const entry: CacheEntry<T> = { doc, revisionId, fileId, fetchedAt: Date.now() };
  cache.set(store, entry as CacheEntry<unknown>);
  return entry;
}

/**
 * Reads a store, serving a recent cache entry when one exists. Callers get a
 * structured clone so a consumer mutating the result can't corrupt the cache.
 */
export async function readStore<T>(store: StoreName): Promise<T> {
  const cached = cache.get(store) as CacheEntry<T> | undefined;
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return structuredClone(cached.doc);
  }
  const fresh = await fetchFresh<T>(store);
  return structuredClone(fresh.doc);
}

/** Forces the next read to go to Drive. */
export function invalidateStore(store?: StoreName): void {
  if (store) cache.delete(store); else cache.clear();
}

/**
 * The single write path: applies `mutate` to the latest document and persists
 * the result, retrying from fresh data if the revision moved underneath.
 *
 * `mutate` must be pure with respect to the document it is handed — it may be
 * called more than once, on different data, if a write loses a race.
 */
export async function mutateStore<T, R = void>(
  store: StoreName,
  mutate: (doc: T) => { doc: T; result: R } | Promise<{ doc: T; result: R }>,
): Promise<R> {
  // Chain onto this store's queue so mutations never interleave in-process.
  const previous = writeQueues.get(store) ?? Promise.resolve();
  const run = previous.then(async () => {
    const { client } = getDriveClient();
    let lastConflict: unknown = null;

    for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
      // Always start from data known-fresh enough to write against: on a retry,
      // go all the way back to Drive rather than trusting the cache we just lost
      // a race against.
      const entry = attempt === 0 && cache.has(store)
        && Date.now() - (cache.get(store) as CacheEntry<T>).fetchedAt < CACHE_TTL_MS
        ? cache.get(store) as CacheEntry<T>
        : await fetchFresh<T>(store);

      const { doc, result } = await mutate(structuredClone(entry.doc));
      const serialised = JSON.stringify(doc, null, 2);

      try {
        const meta = await client.updateTextFile(entry.fileId, serialised, entry.revisionId);
        // Keep this process's cache authoritative after its own write.
        cache.set(store, { doc, revisionId: meta.revisionId, fileId: entry.fileId, fetchedAt: Date.now() });
        return result;
      } catch (err) {
        if (!(err instanceof RevisionMismatchError)) throw err;
        lastConflict = err;
        invalidateStore(store);
      }
    }
    throw new Error(`Could not save the ${store} data store — it kept changing underneath (${MAX_WRITE_ATTEMPTS} attempts). Try again. (${String(lastConflict)})`);
  });

  // Keep the queue alive regardless of this mutation's outcome, so one failed
  // write can't deadlock every subsequent write to the same store.
  writeQueues.set(store, run.then(() => undefined, () => undefined));
  return run;
}

// ── Typed convenience wrappers ─────────────────────────────────────────────

export const readUsers = () => readStore<UserStoreDoc>("users");
export const readWorkflow = () => readStore<WorkflowStoreDoc>("workflow");
export const readEvents = () => readStore<EventStoreDoc>("events");

export const mutateUsers = <R>(fn: (d: UserStoreDoc) => { doc: UserStoreDoc; result: R }) =>
  mutateStore<UserStoreDoc, R>("users", fn);
export const mutateWorkflow = <R>(fn: (d: WorkflowStoreDoc) => { doc: WorkflowStoreDoc; result: R }) =>
  mutateStore<WorkflowStoreDoc, R>("workflow", fn);
export const mutateEvents = <R>(fn: (d: EventStoreDoc) => { doc: EventStoreDoc; result: R }) =>
  mutateStore<EventStoreDoc, R>("events", fn);

/** Test seam — clears cache, queues and the memoised folder bootstrap. */
export function resetStoreState(): void {
  cache.clear();
  writeQueues.clear();
  folderIdsPromise = null;
}
