// @vitest-environment node
/**
 * What a Drive failure is called, and what the Drive dialog's health check
 * reports. The dialog used to say "Connected" for as long as a token was
 * stored, even after Google had stopped honouring it — so health is the
 * result of actually asking Google.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  DRIVE_FOLDER_MIME, DriveAuthError, DriveNotConfiguredError, DriveUnavailableError, type DriveClient, type DriveFileMeta,
} from "./drive-client.js";
import {
  cachedDriveHealth, driveErrorResponse, probeDrive, resetDriveHealth, DRIVE_RECONNECT_MESSAGE,
} from "./drive-errors.js";

describe("the answer for each Drive failure", () => {
  it("maps a dead grant, an unanswering Drive and no Drive at all", () => {
    expect(driveErrorResponse(new DriveAuthError("invalid_grant"))).toEqual({ status: 503, message: DRIVE_RECONNECT_MESSAGE, code: "drive_reconnect" });
    expect(driveErrorResponse(new DriveUnavailableError("x", 429))).toMatchObject({ status: 502, code: "drive_unavailable", message: expect.stringContaining("HTTP 429") });
    expect(driveErrorResponse(new DriveUnavailableError("Google Drive could not be reached (ECONNRESET).")))
      .toMatchObject({ status: 502, message: expect.stringContaining("(ECONNRESET)") });
    expect(driveErrorResponse(new DriveNotConfiguredError())).toMatchObject({ status: 503, code: "drive_not_connected" });
  });
  it("is null for anything that is not a Drive failure", () => {
    expect(driveErrorResponse(new Error("Drive is mentioned but this is a bug"))).toBeNull();
    expect(driveErrorResponse("nope")).toBeNull();
  });
});

/** A client whose getMeta does whatever the test says. */
function clientWith(getMeta: () => Promise<DriveFileMeta>): DriveClient {
  return { getMeta } as unknown as DriveClient;
}
const folder: DriveFileMeta = { id: "root", name: "Outreach", revisionId: "1", mimeType: DRIVE_FOLDER_MIME, modifiedTime: "" };

describe("the health probe", () => {
  beforeEach(() => resetDriveHealth());

  it("is healthy when the root folder answers as a folder", async () => {
    expect(await probeDrive(clientWith(async () => folder), "root")).toEqual({ healthy: true, problem: null, problemMessage: null });
  });
  it("says expired when Google refuses the grant", async () => {
    expect(await probeDrive(clientWith(async () => { throw new DriveAuthError("invalid_grant"); }), "root"))
      .toMatchObject({ healthy: false, problem: "expired" });
  });
  it("says folder_missing for a 404, or a root that is not a folder", async () => {
    expect(await probeDrive(clientWith(async () => { throw new DriveUnavailableError("gone", 404); }), "root"))
      .toMatchObject({ healthy: false, problem: "folder_missing" });
    expect(await probeDrive(clientWith(async () => ({ ...folder, mimeType: "text/plain" })), "root"))
      .toMatchObject({ healthy: false, problem: "folder_missing" });
  });
  it("says unreachable for an outage, or no answer within the timeout", async () => {
    expect(await probeDrive(clientWith(async () => { throw new DriveUnavailableError("x", 503); }), "root"))
      .toMatchObject({ healthy: false, problem: "unreachable", problemMessage: expect.stringContaining("HTTP 503") });
    expect(await probeDrive(clientWith(() => new Promise(() => {})), "root", 20))
      .toMatchObject({ healthy: false, problem: "unreachable", problemMessage: expect.stringContaining("timed out") });
  });
  it("is remembered for a minute per Drive, and forgotten on reset", async () => {
    let probes = 0;
    const probe = async () => { probes++; return { healthy: true, problem: null, problemMessage: null }; };
    await cachedDriveHealth("app:root", probe);
    await cachedDriveHealth("app:root", probe);
    expect(probes).toBe(1);
    await cachedDriveHealth("app:other", probe);
    expect(probes).toBe(2);
    resetDriveHealth();
    await cachedDriveHealth("app:other", probe);
    expect(probes).toBe(3);
  });
});
