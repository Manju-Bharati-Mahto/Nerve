// @vitest-environment node
/* ═══════════════════════════════════════════════════════════════════════════
   UNIT — the Google Drive client against a fake Google.

   Two things are pinned here, both learnt the hard way in production.

   WHAT A FAILURE IS. A revoked refresh token used to come back as a plain
   Error from deep inside the token refresh, indistinguishable from a bug, so
   every outreach screen answered a bare 500. The client now says which of two
   things went wrong — the grant is dead (DriveAuthError: someone must sign in
   again) or Google did not answer (DriveUnavailableError: try again) — and
   the routes turn each into a message naming who can fix it.

   HOW A BIG FILE IS SENT. The whole video used to be read into memory and
   sent in one PUT. Now it goes in chunks from the file handle, and a chunk
   that fails is resent from whatever Google says it actually stored.
   ═══════════════════════════════════════════════════════════════════════════ */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DriveAuthError, DriveUnavailableError, GoogleDriveClient, LocalDriveClient, UPLOAD_GRANULARITY,
  driveFailure, isDriveFileId, storedBytes, tokenFailure,
} from "./google-drive.js";

const OAUTH = { clientId: "id.apps.googleusercontent.com", clientSecret: "secret", refreshToken: "refresh" };
const TOKEN_OK = () => new Response(JSON.stringify({ access_token: "at", expires_in: 3600 }), { status: 200 });
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

type Call = { url: string; method: string; headers: Headers; body: Uint8Array | null };
let calls: Call[];

/** Installs a fake fetch that answers token requests itself and the rest from `drive`. */
function fakeGoogle(drive: (call: Call) => Response | Promise<Response>, token: () => Response | Promise<Response> = TOKEN_OK) {
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    const body = init.body == null ? null
      : typeof init.body === "string" ? new TextEncoder().encode(init.body)
      : new Uint8Array(init.body as ArrayBuffer | Uint8Array).slice();
    const call: Call = { url, method: init.method ?? "GET", headers: new Headers(init.headers), body };
    if (url.startsWith("https://oauth2.googleapis.com/token")) return token();
    calls.push(call);
    return drive(call);
  }));
}

beforeEach(() => { calls = []; });
afterEach(() => { vi.unstubAllGlobals(); });

describe("classifying a refused token request", () => {
  it("calls a dead grant an auth failure", () => {
    expect(tokenFailure(400, '{"error":"invalid_grant","error_description":"Token has been expired or revoked."}')).toBeInstanceOf(DriveAuthError);
    expect(tokenFailure(401, '{"error":"invalid_client"}')).toBeInstanceOf(DriveAuthError);
    expect(tokenFailure(400, '{"error":"unauthorized_client"}')).toBeInstanceOf(DriveAuthError);
    expect(tokenFailure(400, '{"error":"admin_policy_enforced"}')).toBeInstanceOf(DriveAuthError);
  });
  it("calls Google being down unavailable, not dead", () => {
    expect(tokenFailure(503, "Service Unavailable")).toBeInstanceOf(DriveUnavailableError);
    expect(tokenFailure(429, "")).toBeInstanceOf(DriveUnavailableError);
    expect(tokenFailure(400, '{"error":"invalid_request"}')).toBeInstanceOf(DriveUnavailableError);
  });
  it("classifies Drive API statuses", () => {
    expect(driveFailure(401, "x", "")).toBeInstanceOf(DriveAuthError);
    for (const s of [403, 404, 429, 500, 503]) expect(driveFailure(s, "x", ""), String(s)).toBeInstanceOf(DriveUnavailableError);
    const plain = driveFailure(400, "x", "bad");
    expect(plain).not.toBeInstanceOf(DriveAuthError);
    expect(plain).not.toBeInstanceOf(DriveUnavailableError);
  });
});

describe("a call through the client", () => {
  it("throws DriveAuthError when the refresh token was revoked", async () => {
    fakeGoogle(() => json({}), () => json({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, 400));
    const err = await new GoogleDriveClient(OAUTH).getMeta("root").catch(e => e);
    expect(err).toBeInstanceOf(DriveAuthError);
    expect(err.message).toMatch(/invalid_grant/);
  });

  it("throws DriveUnavailableError when Google cannot be reached at all", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND") }); }));
    const err = await new GoogleDriveClient(OAUTH).getMeta("root").catch(e => e);
    expect(err).toBeInstanceOf(DriveUnavailableError);
    expect(err.status).toBeNull();
    expect(err.message).toMatch(/ENOTFOUND/);
  });

  it("retries a 401 once with a fresh token, then calls it an auth failure", async () => {
    let tokens = 0;
    const client = new GoogleDriveClient(OAUTH);
    // Warm the token so the first 401 is the "cached token went stale" case.
    fakeGoogle(() => json({ id: "root", name: "R", mimeType: "application/vnd.google-apps.folder" }), () => { tokens++; return TOKEN_OK(); });
    await client.getMeta("root");
    calls = [];
    fakeGoogle(() => json({ error: { code: 401 } }, 401), () => { tokens++; return TOKEN_OK(); });
    const err = await client.getMeta("root").catch(e => e);
    expect(err).toBeInstanceOf(DriveAuthError);
    expect(calls).toHaveLength(2);
    expect(tokens).toBe(2);
  });

  it("calls a 404, 403 or 5xx from Drive unavailable, with the status", async () => {
    for (const status of [403, 404, 500]) {
      fakeGoogle(() => json({ error: { message: "nope" } }, status));
      const err = await new GoogleDriveClient(OAUTH).getMeta("gone").catch(e => e);
      expect(err, String(status)).toBeInstanceOf(DriveUnavailableError);
      expect(err.status).toBe(status);
    }
  });

  it("reads parents and size with the metadata", async () => {
    fakeGoogle(() => json({ id: "f1", name: "v.mp4", mimeType: "video/mp4", parents: ["folder"], size: "1234" }));
    const meta = await new GoogleDriveClient(OAUTH).getMeta("f1");
    expect(meta.parents).toEqual(["folder"]);
    expect(meta.size).toBe(1234);
  });
});

describe("file ids in request URLs", () => {
  it("knows what a Drive file id looks like", () => {
    expect(isDriveFileId("1AbC_dEf-GhIjKlMn")).toBe(true);
    for (const bad of ["", "short", "../x/abcdefgh", "abcdefghij?alt=media", "abcdefghij#x", "a".repeat(201)]) {
      expect(isDriveFileId(bad), bad).toBe(false);
    }
  });

  it("encodes the id in every /files/<id> path, so it can never change the path or query", async () => {
    const odd = "a/b?c=d#e";
    fakeGoogle(call => {
      if (call.url.includes("fields=parents")) return json({ parents: ["p"] });
      if (call.url.includes("alt=media")) return new Response("x", { status: 200 });
      return json({ id: odd, name: "n", headRevisionId: "r1" });
    });
    const client = new GoogleDriveClient(OAUTH);
    await client.getMeta(odd);
    await client.setDescription(odd, "d");
    await client.moveFile(odd, "q");
    await client.openStream(odd);
    await client.readTextFile(odd);
    await client.updateTextFile(odd, "{}", "r1");
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c.url, c.url).toContain(`/files/${encodeURIComponent(odd)}?`);
      expect(c.url).not.toContain("/files/a/b");
    }
  });
});

describe("opening an upload session for a browser", () => {
  it("names the browser's origin and the file's type and size", async () => {
    fakeGoogle(() => new Response(null, { status: 200, headers: { Location: "https://upload.example/session-1" } }));
    const url = await new GoogleDriveClient(OAUTH).createUploadSession("A - Video 1.mp4", "videos", "video/mp4", 5_000_000, "https://nerve.example");
    expect(url).toBe("https://upload.example/session-1");
    const [call] = calls;
    expect(call.url).toContain("uploadType=resumable");
    expect(call.headers.get("origin")).toBe("https://nerve.example");
    expect(call.headers.get("x-upload-content-type")).toBe("video/mp4");
    expect(call.headers.get("x-upload-content-length")).toBe("5000000");
    expect(JSON.parse(new TextDecoder().decode(call.body!))).toEqual({ name: "A - Video 1.mp4", parents: ["videos"], mimeType: "video/mp4" });
  });
});

describe("uploading a file in chunks", () => {
  let dir: string;
  let file: string;
  const CHUNK = UPLOAD_GRANULARITY;
  const SIZE = CHUNK * 2 + 100;
  const bytes = Buffer.alloc(SIZE);
  for (let i = 0; i < SIZE; i++) bytes[i] = i % 251;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "nerve-gd-"));
    file = path.join(dir, "v.mp4");
    await fs.writeFile(file, bytes);
  });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  const client = () => new GoogleDriveClient(OAUTH, { chunkBytes: CHUNK, retryDelayMs: 0 });

  /** A resumable session that stores what it is sent, honestly. */
  function session(options: { failChunkOnce?: number } = {}) {
    const stored: number[] = [];
    let failed = false;
    let put = 0;
    fakeGoogle(call => {
      if (call.method === "POST") return new Response(null, { status: 200, headers: { Location: "https://upload.example/s" } });
      const range = call.headers.get("content-range") ?? "";
      if (range.startsWith("bytes */")) {
        return stored.length ? new Response(null, { status: 308, headers: { Range: `bytes=0-${stored.length - 1}` } }) : new Response(null, { status: 308 });
      }
      const n = put++;
      if (options.failChunkOnce === n && !failed) { failed = true; throw new TypeError("fetch failed", { cause: new Error("ECONNRESET") }); }
      const m = /bytes (\d+)-(\d+)\/(\d+)/.exec(range)!;
      const first = Number(m[1]);
      expect(first).toBe(stored.length);
      for (const b of call.body!) stored.push(b);
      if (stored.length === Number(m[3])) return json({ id: "file-1", name: "v.mp4", mimeType: "video/mp4", size: String(stored.length) });
      return new Response(null, { status: 308, headers: { Range: `bytes=0-${stored.length - 1}` } });
    });
    return stored;
  }

  it("sends 256 KiB-aligned chunks with Content-Range and returns Drive's file", async () => {
    const stored = session();
    const meta = await client().uploadBinaryFile("v.mp4", "videos", file, "video/mp4");
    expect(meta.id).toBe("file-1");
    const ranges = calls.filter(c => c.method === "PUT").map(c => c.headers.get("content-range"));
    expect(ranges).toEqual([`bytes 0-${CHUNK - 1}/${SIZE}`, `bytes ${CHUNK}-${2 * CHUNK - 1}/${SIZE}`, `bytes ${2 * CHUNK}-${SIZE - 1}/${SIZE}`]);
    expect(Buffer.from(stored).equals(bytes)).toBe(true);
  });

  it("asks where it got to after a dropped chunk, and resumes from there", async () => {
    const stored = session({ failChunkOnce: 1 });
    const meta = await client().uploadBinaryFile("v.mp4", "videos", file, "video/mp4");
    expect(meta.id).toBe("file-1");
    const ranges = calls.filter(c => c.method === "PUT").map(c => c.headers.get("content-range"));
    expect(ranges).toContain(`bytes */${SIZE}`);
    expect(Buffer.from(stored).equals(bytes)).toBe(true);
  });

  it("follows a 308 that stored less than was sent", async () => {
    const stored: number[] = [];
    let first = true;
    fakeGoogle(call => {
      if (call.method === "POST") return new Response(null, { status: 200, headers: { Location: "https://upload.example/s" } });
      const m = /bytes (\d+)-(\d+)\/(\d+)/.exec(call.headers.get("content-range") ?? "")!;
      expect(Number(m[1])).toBe(stored.length);
      // Keep only half of the first chunk, as Google may.
      const keep = first ? call.body!.subarray(0, 1000) : call.body!;
      first = false;
      for (const b of keep) stored.push(b);
      if (stored.length === SIZE) return json({ id: "file-2", name: "v.mp4" });
      return new Response(null, { status: 308, headers: { Range: `bytes=0-${stored.length - 1}` } });
    });
    const meta = await client().uploadBinaryFile("v.mp4", "videos", file, "video/mp4");
    expect(meta.id).toBe("file-2");
    expect(Buffer.from(stored).equals(bytes)).toBe(true);
  });

  it("gives up after three failed retries with DriveUnavailableError", async () => {
    fakeGoogle(call => {
      if (call.method === "POST") return new Response(null, { status: 200, headers: { Location: "https://upload.example/s" } });
      if ((call.headers.get("content-range") ?? "").startsWith("bytes */")) return new Response(null, { status: 308 });
      return new Response("busy", { status: 503 });
    });
    const err = await client().uploadBinaryFile("v.mp4", "videos", file, "video/mp4").catch(e => e);
    expect(err).toBeInstanceOf(DriveUnavailableError);
    expect(calls.filter(c => c.method === "PUT" && !(c.headers.get("content-range") ?? "").startsWith("bytes */"))).toHaveLength(4);
  });

  it("counts a 308 that stored nothing new as a failed attempt, and gives up", async () => {
    // A session that answers every chunk with "still nothing stored".
    fakeGoogle(call => {
      if (call.method === "POST") return new Response(null, { status: 200, headers: { Location: "https://upload.example/s" } });
      return new Response(null, { status: 308 });
    });
    const err = await client().uploadBinaryFile("v.mp4", "videos", file, "video/mp4").catch(e => e);
    expect(err).toBeInstanceOf(DriveUnavailableError);
    const chunks = calls.filter(c => c.method === "PUT" && !(c.headers.get("content-range") ?? "").startsWith("bytes */"));
    expect(chunks).toHaveLength(4);
    for (const c of chunks) expect(c.headers.get("content-range")).toBe(`bytes 0-${CHUNK - 1}/${SIZE}`);
  });

  it("asks for the file, rather than sending an empty range, when a 308 says it has every byte", async () => {
    let put = 0;
    fakeGoogle(call => {
      if (call.method === "POST") return new Response(null, { status: 200, headers: { Location: "https://upload.example/s" } });
      const range = call.headers.get("content-range") ?? "";
      if (range.startsWith("bytes */")) return json({ id: "file-3", name: "v.mp4", size: String(SIZE) });
      // The first chunk "stores" the whole file.
      put++;
      return new Response(null, { status: 308, headers: { Range: `bytes=0-${SIZE - 1}` } });
    });
    const meta = await client().uploadBinaryFile("v.mp4", "videos", file, "video/mp4");
    expect(meta.id).toBe("file-3");
    expect(put).toBe(1);
    const ranges = calls.filter(c => c.method === "PUT").map(c => c.headers.get("content-range"));
    expect(ranges).toEqual([`bytes 0-${CHUNK - 1}/${SIZE}`, `bytes */${SIZE}`]);
  });

  it("treats a busy status answer as retryable, and resends from where it was", async () => {
    let failedOnce = false;
    let statusAsked = 0;
    const stored: number[] = [];
    fakeGoogle(call => {
      if (call.method === "POST") return new Response(null, { status: 200, headers: { Location: "https://upload.example/s" } });
      const range = call.headers.get("content-range") ?? "";
      if (range.startsWith("bytes */")) { statusAsked++; return new Response("busy", { status: 503 }); }
      if (!failedOnce) { failedOnce = true; return new Response("busy", { status: 503 }); }
      for (const b of call.body!) stored.push(b);
      if (stored.length === SIZE) return json({ id: "file-4", name: "v.mp4" });
      return new Response(null, { status: 308, headers: { Range: `bytes=0-${stored.length - 1}` } });
    });
    const meta = await client().uploadBinaryFile("v.mp4", "videos", file, "video/mp4");
    expect(meta.id).toBe("file-4");
    expect(statusAsked).toBe(1);
    expect(Buffer.from(stored).equals(bytes)).toBe(true);
  });

  it("stops at once when the status answer says the session is gone", async () => {
    for (const gone of [404, 410]) {
      calls = [];
      fakeGoogle(call => {
        if (call.method === "POST") return new Response(null, { status: 200, headers: { Location: "https://upload.example/s" } });
        if ((call.headers.get("content-range") ?? "").startsWith("bytes */")) return new Response("gone", { status: gone });
        return new Response("busy", { status: 503 });
      });
      const err = await client().uploadBinaryFile("v.mp4", "videos", file, "video/mp4").catch(e => e);
      expect(err, String(gone)).toBeInstanceOf(Error);
      expect(err.message).toMatch(new RegExp(`upload status failed \\(HTTP ${gone}\\)`));
      expect(calls.filter(c => c.method === "PUT" && !(c.headers.get("content-range") ?? "").startsWith("bytes */"))).toHaveLength(1);
    }
  });

  it("reads Range headers the way Google writes them", () => {
    expect(storedBytes({ headers: new Headers({ Range: "bytes=0-524287" }) })).toBe(524288);
    expect(storedBytes({ headers: new Headers() })).toBe(0);
  });
});

describe("the local adapter", () => {
  it("reports parents and size, and keeps a description with the file through a move", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nerve-local-"));
    try {
      const local = new LocalDriveClient(root);
      const src = path.join(root, "..", `${path.basename(root)}-src.mp4`);
      await fs.writeFile(src, "12345");
      const videos = await local.ensureFolder("Videos", "root");
      const published = await local.ensureFolder("Published", "root");
      const up = await local.uploadBinaryFile("a.mp4", videos, src, "video/mp4");
      const meta = await local.getMeta(up.id);
      expect(meta.parents).toEqual([videos]);
      expect(meta.size).toBe(5);
      await local.setDescription(up.id, "remarks");
      const moved = await local.moveFile(up.id, published);
      expect(await local.readDescription(moved.id)).toBe("remarks");
      await fs.rm(src, { force: true });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
