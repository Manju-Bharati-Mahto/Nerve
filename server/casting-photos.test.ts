// @vitest-environment node
/* ═══════════════════════════════════════════════════════════════════════════
   UNIT — casting registration photos: where they go and what they are called.

   No database, no HTTP, no Google. The filesystem adapter stands in for Drive
   with the same semantics, which is enough to prove the folder-per-request
   layout, the naming, the type rules and the refusal of anything that is not a
   request code — the one input that becomes a path under the adapter.
   ═══════════════════════════════════════════════════════════════════════════ */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "./config.js";
import {
  CASTING_PHOTO_MIME, CastingPhotosNotConfiguredError, LOCAL_CASTING_FOLDER,
  castingPhotoExtension, castingPhotoFileName, castingPhotosConfigured, castingPhotoSource,
  driveFileUrl, driveFolderUrl, openCastingPhoto, resetCastingPhotoClient, storeCastingPhoto,
  useCastingDriveLoader,
} from "./casting-photos.js";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489", "hex");

let tmp = "";
let saved: typeof config.drive;
const blank = () => Object.assign(config.drive, {
  rootFolderId: "", castingFolderId: "", localRoot: "",
  serviceAccountEmail: "", serviceAccountKey: "",
  oauthClientId: "", oauthClientSecret: "", oauthRefreshToken: "",
});
const oauth = () => Object.assign(config.drive, { oauthClientId: "id", oauthClientSecret: "secret", oauthRefreshToken: "rt" });

beforeEach(async () => {
  saved = { ...config.drive };
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "nerve-casting-photos-"));
  blank();
  useCastingDriveLoader(async () => null);     // no Admin-connected Drive unless a test says so
  resetCastingPhotoClient();
});
afterEach(async () => {
  Object.assign(config.drive, saved);
  useCastingDriveLoader(null);
  resetCastingPhotoClient();
  await fs.rm(tmp, { recursive: true, force: true });
});

const appConnection = { clientId: "id", clientSecret: "secret", refreshToken: "rt", folderId: "app-folder" };

describe("whether the form offers an upload", () => {
  it("does not, with nothing configured", async () => {
    expect(await castingPhotosConfigured()).toBe(false);
    expect(await castingPhotoSource()).toBe("none");
  });
  it("does, on the local adapter alone", async () => {
    config.drive.localRoot = tmp;
    expect(await castingPhotosConfigured()).toBe(true);
    expect(await castingPhotoSource()).toBe("local");
  });
  it("with real credentials, needs the casting folder — the video root is not it", async () => {
    oauth();
    config.drive.rootFolderId = "video-root";
    expect(await castingPhotosConfigured()).toBe(false);
    resetCastingPhotoClient();
    config.drive.castingFolderId = "casting-root";
    expect(await castingPhotosConfigured()).toBe(true);
    expect(await castingPhotoSource()).toBe("env");
  });
  it("a leftover local root cannot stand in once real credentials exist", async () => {
    oauth();
    config.drive.localRoot = tmp;
    expect(await castingPhotosConfigured()).toBe(false);
  });
  it("the Drive an Admin connected in the app comes before everything else", async () => {
    useCastingDriveLoader(async () => appConnection);
    config.drive.localRoot = tmp;
    oauth(); config.drive.castingFolderId = "casting-root";
    expect(await castingPhotoSource()).toBe("app");
  });
  it("a connection that cannot be read falls back for now and is asked for again next time", async () => {
    let calls = 0;
    useCastingDriveLoader(async () => { calls++; if (calls === 1) throw new Error("db down"); return appConnection; });
    config.drive.localRoot = tmp;
    expect(await castingPhotoSource()).toBe("local");      // this once
    expect(await castingPhotoSource()).toBe("app");        // not memoised: the row is read again
    expect(await castingPhotoSource()).toBe("app");        // and now it is
    expect(calls).toBe(2);
  });
});

describe("naming", () => {
  it("names the file after the request and the moment, with the extension from the MIME", () => {
    expect(castingPhotoFileName("CR-00012", "image/jpeg", new Date("2026-10-04T09:30:12.345Z")))
      .toBe("CR-00012-photo-20261004-093012.jpg");
    expect(castingPhotoFileName("CR-00012", "image/webp", new Date("2026-01-01T00:00:00Z")))
      .toBe("CR-00012-photo-20260101-000000.webp");
  });
  it("serves raster photo types only — no SVG, no GIF", () => {
    expect(castingPhotoExtension("image/jpeg")).toBe(".jpg");
    expect(castingPhotoExtension("image/png")).toBe(".png");
    expect(castingPhotoExtension("image/webp")).toBe(".webp");
    expect(castingPhotoExtension("image/svg+xml")).toBeNull();
    expect(castingPhotoExtension("image/gif")).toBeNull();
    expect(Object.keys(CASTING_PHOTO_MIME).sort()).toEqual(["image/jpeg", "image/png", "image/webp"]);
  });
  it("builds the Drive links an id resolves to", () => {
    expect(driveFileUrl("abc 123")).toBe("https://drive.google.com/file/d/abc%20123/view");
    expect(driveFolderUrl("f1")).toBe("https://drive.google.com/drive/folders/f1");
  });
});

describe("storing a photo (local adapter)", () => {
  const staged = async () => { const p = path.join(tmp, "staged.png"); await fs.writeFile(p, PNG); return p; };

  it("lands under <root>/casting-photos/<CR code>/ and streams back byte for byte", async () => {
    config.drive.localRoot = tmp; resetCastingPhotoClient();
    const r = await storeCastingPhoto({ requestCode: "CR-00007", localPath: await staged(), mimeType: "image/png" });
    expect(r.folderId).toBe(path.join(LOCAL_CASTING_FOLDER, "CR-00007"));
    expect(r.mimeType).toBe("image/png");
    // Ids are paths here, not Drive ids, so there is no link to hand out.
    expect(r.webViewUrl).toBeNull();
    expect(r.folderUrl).toBeNull();
    const files = await fs.readdir(path.join(tmp, LOCAL_CASTING_FOLDER, "CR-00007"));
    expect(files.filter((f) => /^CR-00007-photo-\d{8}-\d{6}\.png$/.test(f))).toHaveLength(1);
    const stream = await openCastingPhoto(r.fileId);
    expect(stream.status).toBe(200);
    expect(Buffer.from(await new Response(stream.body).arrayBuffer()).equals(PNG)).toBe(true);
  });

  it("a second photo for the same request sits beside the first — history, not replacement", async () => {
    config.drive.localRoot = tmp; resetCastingPhotoClient();
    const a = await storeCastingPhoto({ requestCode: "CR-00008", localPath: await staged(), mimeType: "image/png" });
    await new Promise((r) => setTimeout(r, 1100));          // the name carries seconds
    const b = await storeCastingPhoto({ requestCode: "CR-00008", localPath: await staged(), mimeType: "image/png" });
    expect(b.fileId).not.toBe(a.fileId);
    expect(await fs.readdir(path.join(tmp, LOCAL_CASTING_FOLDER, "CR-00008"))).toHaveLength(2 + 2); // + two .rev sidecars
  });

  it("refuses anything that is not a request code — it would become a path", async () => {
    config.drive.localRoot = tmp; resetCastingPhotoClient();
    const p = await staged();
    await expect(storeCastingPhoto({ requestCode: "../escape", localPath: p, mimeType: "image/png" })).rejects.toThrow(/request code/);
    await expect(storeCastingPhoto({ requestCode: "CR-00001/x", localPath: p, mimeType: "image/png" })).rejects.toThrow(/request code/);
    await expect(fs.stat(path.join(tmp, "escape"))).rejects.toThrow();
  });

  it("refuses a type it does not serve", async () => {
    config.drive.localRoot = tmp; resetCastingPhotoClient();
    await expect(storeCastingPhoto({ requestCode: "CR-00001", localPath: await staged(), mimeType: "image/svg+xml" }))
      .rejects.toThrow(/photo type/);
  });

  it("says so, by type, when nothing is configured", async () => {
    await expect(storeCastingPhoto({ requestCode: "CR-00001", localPath: await staged(), mimeType: "image/png" }))
      .rejects.toBeInstanceOf(CastingPhotosNotConfiguredError);
    await expect(openCastingPhoto("anything")).rejects.toBeInstanceOf(CastingPhotosNotConfiguredError);
  });
});
