/**
 * How the API receives a file, and how it says no.
 *
 * Left to itself, multer hands every refusal — a 12 MB photo, an SVG, an
 * eleventh file — to the next error handler, which only knows how to say
 * "Internal server error." (and, for routes registered after it, Express's
 * HTML 500 page, which the client cannot read at all). Every one of those is
 * really someone picking the wrong file, so each becomes a JSON answer with a
 * status the client can act on and a sentence a person can act on.
 *
 * Kept apart from server/index.ts so the mapping can be unit-tested without
 * booting the API.
 */
import type express from "express";
import multer from "multer";

// ── Images ────────────────────────────────────────────────────────────────

/* Hardened image handling (security): allowlist RASTER image types only —
   `image/svg+xml` is a stored-XSS vector when served same-origin — and derive
   the on-disk extension from the validated MIME, never from the
   attacker-controlled originalname (which could carry `.html`/`.svg` while
   claiming an image mimetype).

   image/jpg and image/pjpeg are not real types, but some Android galleries and
   older Windows browsers send them for an ordinary JPEG; refusing those told
   people their photo was "not an image". They are stored as .jpg like any
   other JPEG. */
export const SAFE_IMAGE_EXT: Record<string, string> = {
  "image/jpeg": ".jpg", "image/jpg": ".jpg", "image/pjpeg": ".jpg",
  "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif",
};

/* An iPhone photo picked through a plain file input arrives as HEIC unless the
   page restricts `accept` to JPEG/PNG (then iOS converts it). No browser outside
   Safari can display HEIC, so storing one would show a broken image to everyone
   else — refuse it with the fix rather than "Only JPG, PNG…", which reads as if
   the photo were not a photo. Checked by name too: several browsers send HEIC
   as application/octet-stream. */
export const HEIC_MESSAGE =
  "iPhone HEIC photos are not supported. Choose JPG or PNG (on iPhone: Settings → Camera → Formats → Most Compatible).";

export function isHeic(file: { mimetype: string; originalname: string }): boolean {
  return /^image\/hei[cf](-sequence)?$/i.test(file.mimetype) || /\.hei[cf]$/i.test(file.originalname);
}

export const imageFileFilter: NonNullable<multer.Options["fileFilter"]> = (_req, file, cb) => {
  if (isHeic(file)) return cb(new Error(HEIC_MESSAGE));
  if (SAFE_IMAGE_EXT[file.mimetype]) return cb(null, true);
  cb(new Error("Only JPG, PNG, WEBP or GIF images are allowed."));
};

export const safeImageName = (file: Express.Multer.File) =>
  `${Date.now()}-${Math.random().toString(36).slice(2)}${SAFE_IMAGE_EXT[file.mimetype] || ".bin"}`;

// ── Refusals ──────────────────────────────────────────────────────────────

export interface UploadLimits {
  /** The size limit as a person reads it, e.g. "10 MB". */
  sizeLabel: string;
  /** How many files the field takes; 1 for a `.single()` upload. */
  maxFiles?: number;
  /** The field the files must arrive in, so a wrong field is not reported as "too many". */
  field?: string;
  /** What the file is called in the message — "photo" for an avatar. */
  noun?: string;
}

export interface Refusal { status: number; message: string }

/**
 * A disk that is full or unwritable is OUR fault, not the uploader's, and must
 * stay a logged 500 rather than be read back to them as if their file were
 * wrong. Node marks those errors with `syscall`/`errno`; a fileFilter refusal
 * or a malformed multipart body has neither.
 */
function isSystemError(err: unknown): boolean {
  return typeof err === "object" && err !== null && ("syscall" in err || "errno" in err);
}

function tooMany(maxFiles: number): string {
  return maxFiles <= 1
    ? "Too many files — upload one at a time."
    : `Too many files — upload at most ${maxFiles} at a time.`;
}

/**
 * The answer for an upload multer refused, or null when the failure is the
 * server's own (the caller logs it and answers 500).
 */
export function uploadRefusal(err: unknown, limits: UploadLimits): Refusal | null {
  const noun = limits.noun ?? "file";
  const maxFiles = limits.maxFiles ?? 1;
  if (err instanceof multer.MulterError) {
    switch (err.code) {
      case "LIMIT_FILE_SIZE":
        return { status: 413, message: `That ${noun} is larger than ${limits.sizeLabel}.` };
      case "LIMIT_FILE_COUNT":
        return { status: 400, message: tooMany(maxFiles) };
      case "LIMIT_UNEXPECTED_FILE":
        /* multer says "Unexpected field" both for one file too many in an
           array and for a file in a field it was not told about. Only the
           second is a client bug, and only it should say so. */
        if (limits.field && err.field && err.field !== limits.field) {
          return { status: 400, message: `Unexpected file field "${err.field}" — expected "${limits.field}".` };
        }
        return { status: 400, message: tooMany(maxFiles) };
      default:
        return { status: 400, message: `That upload could not be read (${err.message.toLowerCase()}).` };
    }
  }
  if (isSystemError(err)) return null;
  if (err instanceof Error && err.message) return { status: 400, message: err.message };
  return { status: 400, message: "That file could not be uploaded." };
}

/**
 * Runs a multer middleware and answers its refusals as JSON. Files multer had
 * already written are removed by multer itself before it reports the error.
 */
export function acceptUpload(middleware: express.RequestHandler, limits: UploadLimits): express.RequestHandler {
  return (req, res, next) => {
    middleware(req, res, (err?: unknown) => {
      if (!err) return next();
      if (res.headersSent) return next(err);
      const refusal = uploadRefusal(err, limits);
      if (!refusal) return next(err);
      res.status(refusal.status).json({ message: refusal.message });
    });
  };
}

// ── The last word on any error ────────────────────────────────────────────

/**
 * What the global error handler answers. Anything that reaches it is a server
 * fault and stays a logged 500 — except a body the client sent wrong (too
 * large, not JSON), which carries a 4xx from body-parser/http-errors, and an
 * upload refusal that slipped past acceptUpload, which is still the
 * uploader's problem, not ours.
 */
export function errorResponse(err: unknown): Refusal & { log: boolean } {
  if (err instanceof multer.MulterError) {
    const refusal = uploadRefusal(err, { sizeLabel: "the upload limit" }) as Refusal;
    return { ...refusal, log: false };
  }
  const e = (typeof err === "object" && err !== null ? err : {}) as {
    type?: unknown; status?: unknown; statusCode?: unknown; expose?: unknown; message?: unknown;
  };
  const status = typeof e.status === "number" ? e.status : typeof e.statusCode === "number" ? e.statusCode : 0;
  /* Only a body-parser / http-errors error is trusted to name its own 4xx:
     those always carry a boolean `expose` (http-errors) or a string `type`
     (body-parser's "entity.too.large" etc.). Any other error that happens to
     have a `status` — a Google API GaxiosError with 401/403/404, a pg or SDK
     error — is a fault in OUR call to someone else, not the client's request,
     and must stay a logged 500 rather than tell the browser it is
     unauthorised or that something it never asked for is missing. */
  const fromBodyParser = typeof e.expose === "boolean" || typeof e.type === "string";
  if (fromBodyParser && status >= 400 && status < 500) {
    if (e.type === "entity.too.large") return { status: 413, message: "That request is too large.", log: false };
    if (e.type === "entity.parse.failed") return { status: 400, message: "The request was not valid JSON.", log: false };
    if (e.type === "request.aborted") return { status: 400, message: "The request was interrupted. Please try again.", log: false };
    const message = e.expose === true && typeof e.message === "string" && e.message
      ? e.message
      : "The request could not be read.";
    return { status, message, log: false };
  }
  return { status: 500, message: "Internal server error.", log: true };
}

/** The JSON error handler, registered mid-file and again after every route. */
export const jsonErrorHandler: express.ErrorRequestHandler = (err, _req, res, next) => {
  if (res.headersSent) return next(err);
  const answer = errorResponse(err);
  if (answer.log) console.error("Unhandled API error", err);
  res.status(answer.status).json({ message: answer.message });
};
