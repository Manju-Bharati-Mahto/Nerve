// @vitest-environment node
/* ═══════════════════════════════════════════════════════════════════════════
   UNIT — the in-app Google Drive connection: the pure parts.

   No database, no Google. What a pasted folder link resolves to, what the
   signed `state` on the OAuth round trip protects against, where Google is
   told to send the browser back, and that a sealed secret opens only under the
   key it was sealed with.
   ═══════════════════════════════════════════════════════════════════════════ */
import { afterEach, describe, expect, it } from "vitest";
import { config } from "./config.js";
import { openSecret, sealSecret } from "./secret-box.js";
import {
  castingDriveRedirectUri, parseDriveFolderId, signDriveState, verifyDriveState,
} from "./casting-drive.js";

describe("a pasted folder", () => {
  it("is understood as a link in any of Drive's shapes, or as the bare id", () => {
    expect(parseDriveFolderId("https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOp?usp=sharing")).toBe("1AbCdEfGhIjKlMnOp");
    expect(parseDriveFolderId("https://drive.google.com/drive/u/0/folders/1AbCdEfGhIjKlMnOp")).toBe("1AbCdEfGhIjKlMnOp");
    expect(parseDriveFolderId("https://drive.google.com/open?id=1AbCdEfGhIjKlMnOp")).toBe("1AbCdEfGhIjKlMnOp");
    expect(parseDriveFolderId("  1AbCdEfGhIjKlMnOp  ")).toBe("1AbCdEfGhIjKlMnOp");
  });
  it("is refused when it is a file link, another site, or nothing", () => {
    expect(parseDriveFolderId("https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view")).toBeNull();
    expect(parseDriveFolderId("https://example.com/drive/folders/1AbCdEfGhIjKlMnOp")).toBeNull();
    expect(parseDriveFolderId("javascript:alert(1)")).toBeNull();
    expect(parseDriveFolderId("")).toBeNull();
    expect(parseDriveFolderId("short")).toBeNull();
  });
});

describe("the signed state on the OAuth round trip", () => {
  it("verifies for the admin who started it, within ten minutes", () => {
    const st = signDriveState("u-admin", 1_000_000);
    expect(verifyDriveState(st, "u-admin", 1_000_000 + 9 * 60 * 1000)).toBe(true);
  });
  it("is nobody else's, does not outlive its window, and cannot be edited", () => {
    const st = signDriveState("u-admin", 1_000_000);
    expect(verifyDriveState(st, "u-other", 1_000_000 + 1000)).toBe(false);
    expect(verifyDriveState(st, "u-admin", 1_000_000 + 11 * 60 * 1000)).toBe(false);
    const [payload, mac] = st.split(".");
    expect(verifyDriveState(`${payload}x.${mac}`, "u-admin", 1_000_000 + 1000)).toBe(false);
    expect(verifyDriveState(`${payload}.${mac.slice(0, -2)}AA`, "u-admin", 1_000_000 + 1000)).toBe(false);
    expect(verifyDriveState("garbage", "u-admin")).toBe(false);
    expect(verifyDriveState("", "u-admin")).toBe(false);
  });
  it("differs every time, so one cannot be replayed as another", () => {
    expect(signDriveState("u-admin", 1_000_000)).not.toBe(signDriveState("u-admin", 1_000_000));
  });
});

describe("where Google sends the browser back", () => {
  const saved = config.appBaseUrl;
  afterEach(() => { (config as { appBaseUrl: string }).appBaseUrl = saved; });
  it("is the API's callback under APP_BASE_URL, with no doubled slash", () => {
    (config as { appBaseUrl: string }).appBaseUrl = "https://nerve.paruluniversity.ac.in/";
    expect(castingDriveRedirectUri()).toBe("https://nerve.paruluniversity.ac.in/api/v1/media/casting-drive/callback");
  });
});

describe("a sealed secret", () => {
  it("opens to what was sealed, under the same purpose", () => {
    const sealed = sealSecret("1//0gRefreshToken-abc", "casting-drive");
    expect(sealed.startsWith("v1.")).toBe(true);
    expect(sealed).not.toContain("RefreshToken");
    expect(openSecret(sealed, "casting-drive")).toBe("1//0gRefreshToken-abc");
  });
  it("is null — never garbage — when tampered with, under another purpose, or not a sealed value", () => {
    const sealed = sealSecret("secret", "casting-drive");
    const parts = sealed.split(".");
    parts[3] = parts[3].slice(0, -1) + (parts[3].endsWith("A") ? "B" : "A");
    expect(openSecret(parts.join("."), "casting-drive")).toBeNull();
    expect(openSecret(sealed, "something-else")).toBeNull();
    expect(openSecret("plain text", "casting-drive")).toBeNull();
    expect(openSecret(null, "casting-drive")).toBeNull();
  });
});
