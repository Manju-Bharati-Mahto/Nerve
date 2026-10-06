// @vitest-environment node
/* ═══════════════════════════════════════════════════════════════════════════
   UNIT — how the API says no to a file.

   THE BUG THIS ENCODES. A refused upload (too big, wrong type, one file too
   many) reached the error handler as a 500 "Internal server error." — or, for
   routes registered after that handler, Express's HTML error page, which the
   client could not parse and reported as a bare "Upload failed.". Both are
   wrong answers to someone who simply picked the wrong photo.

   The mapping is checked directly, and then through a real Express app with a
   real multer instance, because the shape of multer's errors (which code, which
   field) is exactly what a unit test against hand-made errors could get wrong.
   No database, no disk: the app uses memory storage on an ephemeral port.
   ═══════════════════════════════════════════════════════════════════════════ */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import multer from "multer";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import {
  uploadRefusal, errorResponse, imageFileFilter, acceptUpload, jsonErrorHandler,
  HEIC_MESSAGE, SAFE_IMAGE_EXT,
} from "./upload-guard.js";

function filter(mimetype: string, originalname: string): Promise<{ err: Error | null; ok?: boolean }> {
  return new Promise(resolve => {
    imageFileFilter({} as express.Request, { mimetype, originalname } as Express.Multer.File,
      ((err: Error | null, ok?: boolean) => resolve({ err, ok })) as multer.FileFilterCallback);
  });
}

describe("imageFileFilter", () => {
  it("accepts the raster types and the JPEG aliases browsers really send", async () => {
    for (const t of ["image/jpeg", "image/jpg", "image/pjpeg", "image/png", "image/webp", "image/gif"]) {
      expect((await filter(t, "x")).ok, t).toBe(true);
    }
    expect(SAFE_IMAGE_EXT["image/jpg"]).toBe(".jpg");
    expect(SAFE_IMAGE_EXT["image/pjpeg"]).toBe(".jpg");
  });

  it("refuses HEIC by type or by name, with the way out", async () => {
    expect((await filter("image/heic", "IMG_1.HEIC")).err?.message).toBe(HEIC_MESSAGE);
    expect((await filter("image/heif", "x")).err?.message).toBe(HEIC_MESSAGE);
    expect((await filter("application/octet-stream", "IMG_2.heic")).err?.message).toBe(HEIC_MESSAGE);
  });

  it("still refuses SVG and everything else with the old message", async () => {
    expect((await filter("image/svg+xml", "a.svg")).err?.message).toBe("Only JPG, PNG, WEBP or GIF images are allowed.");
    expect((await filter("text/html", "a.jpg")).err?.message).toBe("Only JPG, PNG, WEBP or GIF images are allowed.");
  });
});

describe("uploadRefusal", () => {
  it("answers a file over the limit with 413 and the limit", () => {
    expect(uploadRefusal(new multer.MulterError("LIMIT_FILE_SIZE", "image"), { sizeLabel: "10 MB" }))
      .toEqual({ status: 413, message: "That file is larger than 10 MB." });
    expect(uploadRefusal(new multer.MulterError("LIMIT_FILE_SIZE", "avatar"), { sizeLabel: "3 MB", noun: "photo" }))
      .toEqual({ status: 413, message: "That photo is larger than 3 MB." });
  });

  it("tells one file too many from a file in the wrong field", () => {
    const limits = { sizeLabel: "10 MB", maxFiles: 10, field: "photos" };
    expect(uploadRefusal(new multer.MulterError("LIMIT_UNEXPECTED_FILE", "photos"), limits))
      .toEqual({ status: 400, message: "Too many files — upload at most 10 at a time." });
    expect(uploadRefusal(new multer.MulterError("LIMIT_FILE_COUNT"), limits))
      .toEqual({ status: 400, message: "Too many files — upload at most 10 at a time." });
    expect(uploadRefusal(new multer.MulterError("LIMIT_UNEXPECTED_FILE", "image"), limits)?.message)
      .toBe('Unexpected file field "image" — expected "photos".');
  });

  it("passes a fileFilter refusal through as a 400 with its own words", () => {
    expect(uploadRefusal(new Error("Choose a .csv, .xlsx or .xls file."), { sizeLabel: "5 MB" }))
      .toEqual({ status: 400, message: "Choose a .csv, .xlsx or .xls file." });
  });

  it("leaves a full or unwritable disk to the server's own 500", () => {
    const enospc = Object.assign(new Error("ENOSPC: no space left on device"), { errno: -28, syscall: "write" });
    expect(uploadRefusal(enospc, { sizeLabel: "10 MB" })).toBeNull();
  });
});

describe("errorResponse", () => {
  it("keeps body-parser's 4xx instead of calling it a server error", () => {
    expect(errorResponse({ type: "entity.too.large", status: 413, expose: true, message: "request entity too large" }))
      .toEqual({ status: 413, message: "That request is too large.", log: false });
    expect(errorResponse({ type: "entity.parse.failed", status: 400, expose: true, message: "Unexpected token" }))
      .toEqual({ status: 400, message: "The request was not valid JSON.", log: false });
  });

  it("passes a 4xx through only for body-parser / http-errors errors", () => {
    /* A Google API or SDK error carrying status 401/403/404 is OUR call
       failing, not the client's request — it must not tell the browser it is
       logged out. */
    const upstream401 = Object.assign(new Error("invalid_grant"), { status: 401 });
    expect(errorResponse(upstream401)).toEqual({ status: 500, message: "Internal server error.", log: true });
    expect(errorResponse(Object.assign(new Error("Not Found"), { statusCode: 404 })))
      .toEqual({ status: 500, message: "Internal server error.", log: true });
    // An http-errors error (boolean expose) keeps its status; its message only when exposed.
    expect(errorResponse(Object.assign(new Error("Unsupported charset"), { status: 415, expose: true })))
      .toEqual({ status: 415, message: "Unsupported charset", log: false });
    expect(errorResponse(Object.assign(new Error("secret detail"), { status: 400, expose: false })))
      .toEqual({ status: 400, message: "The request could not be read.", log: false });
    // body-parser's entity.too.large, identified by its type.
    expect(errorResponse(Object.assign(new Error("request entity too large"), { type: "entity.too.large", status: 413 })))
      .toEqual({ status: 413, message: "That request is too large.", log: false });
    // A 5xx stays a 500 even from body-parser.
    expect(errorResponse({ type: "stream.not.readable", status: 500, expose: false }).status).toBe(500);
  });

  it("maps a stray multer error and logs only real faults", () => {
    expect(errorResponse(new multer.MulterError("LIMIT_FILE_SIZE")).status).toBe(413);
    expect(errorResponse(new Error("boom"))).toEqual({ status: 500, message: "Internal server error.", log: true });
  });
});

/* ── Through a real Express app ───────────────────────────────────────────── */

let server: Server;
let base = "";

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 }, fileFilter: imageFileFilter });
  app.post("/one", acceptUpload(upload.single("image"), { sizeLabel: "1 KB", field: "image" }),
    (req, res) => { res.json({ got: req.file?.originalname }); });
  app.post("/many", acceptUpload(upload.array("photos", 2), { sizeLabel: "1 KB", maxFiles: 2, field: "photos" }),
    (req, res) => { res.json({ got: (req.files as Express.Multer.File[]).length }); });
  app.post("/json", (req, res) => { res.json({ ok: true, body: req.body }); });
  app.post("/throws", () => { throw new Error("database exploded"); });
  app.post("/throws401", () => { throw Object.assign(new Error("invalid_grant"), { status: 401 }); });
  app.use(jsonErrorHandler);
  await new Promise<void>(resolve => { server = app.listen(0, "127.0.0.1", () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
});

function form(field: string, files: { name: string; type: string; bytes: number }[]): FormData {
  const fd = new FormData();
  for (const f of files) fd.append(field, new Blob([new Uint8Array(f.bytes)], { type: f.type }), f.name);
  return fd;
}

async function post(path: string, body: FormData | string, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, { method: "POST", body, headers });
  return { status: res.status, type: res.headers.get("content-type") ?? "", json: await res.json() as Record<string, unknown> };
}

describe("acceptUpload through Express and multer", () => {
  it("lets a good file through", async () => {
    const r = await post("/one", form("image", [{ name: "a.jpg", type: "image/jpeg", bytes: 10 }]));
    expect(r).toMatchObject({ status: 200, json: { got: "a.jpg" } });
  });

  it("answers an oversized file with JSON 413", async () => {
    const r = await post("/one", form("image", [{ name: "a.png", type: "image/png", bytes: 4096 }]));
    expect(r.status).toBe(413);
    expect(r.type).toMatch(/json/);
    expect(r.json.message).toBe("That file is larger than 1 KB.");
  });

  it("answers HEIC and SVG with their reasons", async () => {
    expect((await post("/one", form("image", [{ name: "IMG.HEIC", type: "image/heic", bytes: 10 }]))).json.message)
      .toBe(HEIC_MESSAGE);
    expect((await post("/one", form("image", [{ name: "x.svg", type: "image/svg+xml", bytes: 10 }]))).status).toBe(400);
  });

  it("answers one file too many with the limit", async () => {
    const files = [1, 2, 3].map(i => ({ name: `${i}.jpg`, type: "image/jpeg", bytes: 10 }));
    const r = await post("/many", form("photos", files));
    expect(r).toMatchObject({ status: 400, json: { message: "Too many files — upload at most 2 at a time." } });
  });
});

describe("jsonErrorHandler", () => {
  it("answers a JSON body over the limit with 413, not 500", async () => {
    const r = await post("/json", JSON.stringify({ x: "y".repeat(200 * 1024) }), { "Content-Type": "application/json" });
    expect(r).toMatchObject({ status: 413, json: { message: "That request is too large." } });
  });

  it("keeps a real fault a 500, as JSON", async () => {
    const original = console.error;
    console.error = () => {};
    try {
      const r = await post("/throws", "", {});
      expect(r).toMatchObject({ status: 500, json: { message: "Internal server error." } });
      expect(r.type).toMatch(/json/);
      const r401 = await post("/throws401", "", {});
      expect(r401).toMatchObject({ status: 500, json: { message: "Internal server error." } });
    } finally {
      console.error = original;
    }
  });
});
