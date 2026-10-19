// @vitest-environment node
/**
 * Where the video workflow's Drive comes from.
 *
 * The outreach team connects its own Google account from inside the video
 * workflow (drive-connection.ts). It is NOT the Casting connection in Media
 * Ops — those are different teams with different accounts, and the outreach
 * workflow must never end up in the casting account's Drive.
 *
 * The rules being tested are about precedence, and each one protects
 * something specific:
 *
 *   - the ENVIRONMENT wins, because what a deployer set explicitly for this
 *     workflow must never be overridden from a dialog;
 *   - the OUTREACH CONNECTION beats DRIVE_LOCAL_ROOT, so a leftover dev
 *     setting can never redirect production onto the server's disk;
 *   - the workflow's root is the folder chosen when the account connected.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

/* ── The outreach connection, as drive-connection.ts would return it ─────── */
let connection: null | {
  clientId: string; clientSecret: string; refreshToken: string;
  folderId: string; accountEmail: string | null;
} = null;
let connectionReads = 0;
vi.mock("./drive-connection.js", () => ({
  loadOutreachDriveConnection: async () => { connectionReads++; return connection; },
}));

/* Proves the casting module is never consulted. */
const castingRead = vi.fn();
vi.mock("../casting-drive.js", () => ({ loadCastingDriveConnection: castingRead }));

/* ── Google itself: which credentials each client was built with ────────── */
const builtWith: string[] = [];
vi.mock("../integrations/google-drive.js", async () => {
  const real = await vi.importActual<typeof import("../integrations/google-drive.js")>(
    "../integrations/google-drive.js");
  class FakeGoogleDriveClient {
    constructor(readonly oauth?: { refreshToken: string }) { builtWith.push(oauth?.refreshToken ?? "env"); }
  }
  return { ...real, GoogleDriveClient: FakeGoogleDriveClient };
});

import { config } from "../config.js";
import {
  driveIsConfigured, driveIsLocal, driveSource, ensureDriveResolved, getDriveClient,
  resetAppDriveConnection, resetDriveClient,
} from "./drive-client.js";

const drive = config.drive as Record<string, string>;

function noEnv() {
  drive.rootFolderId = "";
  drive.serviceAccountEmail = ""; drive.serviceAccountKey = "";
  drive.oauthClientId = ""; drive.oauthClientSecret = ""; drive.oauthRefreshToken = "";
  drive.localRoot = "";
}

const OUTREACH = "outreach.socialintern@paruluniversity.ac.in";
const connected = (account = OUTREACH, folderId = "OUTREACH-ROOT") => ({
  clientId: "cid.apps.googleusercontent.com", clientSecret: "secret",
  refreshToken: `rt-${account}`, folderId, accountEmail: account,
});

beforeEach(() => {
  noEnv();
  connection = null;
  connectionReads = 0;
  builtWith.length = 0;
  castingRead.mockReset();
  resetDriveClient();
});

describe("nothing configured", () => {
  it("reports not configured, and says so rather than failing", async () => {
    await ensureDriveResolved();
    expect(driveIsConfigured()).toBe(false);
    expect(driveSource()).toBe("none");
    expect(() => getDriveClient()).toThrow(/not configured/i);
  });
});

describe("the outreach connection (Video Workflow → Google Drive)", () => {
  it("is used when the environment configures no Drive", async () => {
    connection = connected();
    await ensureDriveResolved();
    expect(driveIsConfigured()).toBe(true);
    expect(driveSource()).toBe("app");
    expect(driveIsLocal()).toBe(false);
  });

  it("uses the folder chosen when the account connected as the workflow's root", async () => {
    connection = connected(OUTREACH, "OUTREACH-ROOT");
    await ensureDriveResolved();
    expect(getDriveClient().rootId).toBe("OUTREACH-ROOT");
  });

  it("acts as the connected outreach account", async () => {
    connection = connected();
    await ensureDriveResolved();
    expect(builtWith).toEqual([`rt-${OUTREACH}`]);
  });

  it("never reads the Casting connection in Media Ops", async () => {
    await ensureDriveResolved();
    connection = connected();
    resetAppDriveConnection();
    await ensureDriveResolved();
    expect(castingRead).not.toHaveBeenCalled();
  });

  it("beats DRIVE_LOCAL_ROOT, so a leftover dev setting cannot take production onto disk", async () => {
    drive.localRoot = "/tmp/leftover";
    connection = connected();
    await ensureDriveResolved();
    expect(driveSource()).toBe("app");
    expect(driveIsLocal()).toBe(false);
  });

  it("follows a reconnection to a different folder once reset", async () => {
    connection = connected(OUTREACH, "FIRST");
    await ensureDriveResolved();
    expect(getDriveClient().rootId).toBe("FIRST");

    connection = connected(OUTREACH, "SECOND");
    resetAppDriveConnection();
    await ensureDriveResolved();
    expect(getDriveClient().rootId).toBe("SECOND");
  });
});

describe("the environment", () => {
  it("wins over the outreach connection, and the database is never consulted", async () => {
    drive.rootFolderId = "ENV-ROOT";
    drive.oauthClientId = "x"; drive.oauthClientSecret = "y"; drive.oauthRefreshToken = "z";
    connection = connected();

    await ensureDriveResolved();
    expect(driveSource()).toBe("env");
    expect(getDriveClient().rootId).toBe("ENV-ROOT");
    expect(connectionReads).toBe(0);
  });

  it("still falls back to DRIVE_LOCAL_ROOT with no connection, as before", async () => {
    drive.localRoot = "/tmp/dev-drive";
    await ensureDriveResolved();
    expect(driveSource()).toBe("local");
    expect(driveIsLocal()).toBe(true);
  });
});

describe("cost on every request", () => {
  it("reads the database at most once a minute while nothing is connected", async () => {
    await ensureDriveResolved();
    await ensureDriveResolved();
    await ensureDriveResolved();
    expect(connectionReads).toBe(1);
  });

  it("stops reading the database once a connection has been found", async () => {
    connection = connected();
    await ensureDriveResolved();
    await ensureDriveResolved();
    await ensureDriveResolved();
    expect(connectionReads).toBe(1);
  });

  it("reads exactly once when many requests arrive together", async () => {
    connection = connected();
    await Promise.all([ensureDriveResolved(), ensureDriveResolved(), ensureDriveResolved()]);
    expect(connectionReads).toBe(1);
  });

  it("picks up a connection made later, once reset", async () => {
    await ensureDriveResolved();
    expect(driveIsConfigured()).toBe(false);

    connection = connected();
    resetAppDriveConnection();
    await ensureDriveResolved();
    expect(driveIsConfigured()).toBe(true);
  });
});
