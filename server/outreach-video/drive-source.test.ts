// @vitest-environment node
/**
 * Where the video workflow's Drive comes from.
 *
 * It used to come from the environment or nowhere, so connecting Drive with
 * the "Sign in with Google" button in Casting Management did nothing for the
 * video workflow — getting it working meant editing the server's env file and
 * minting a refresh token by hand, even with that same Drive already
 * connected in the app.
 *
 * The rules being tested are about precedence, and each one protects
 * something specific:
 *
 *   - the ENVIRONMENT wins, because what a deployer set explicitly for this
 *     workflow must never be overridden from a dialog;
 *   - the APP CONNECTION beats DRIVE_LOCAL_ROOT, so a leftover dev setting can
 *     never redirect production onto the server's disk;
 *   - the workflow gets ITS OWN FOLDER, never the casting folder, which holds
 *     applicant photos;
 *   - that folder is remembered PER ACCOUNT, so reconnecting a different
 *     Google account does not reuse a folder the new account cannot see.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

/* ── The app connection, as casting-drive.ts would return it ─────────────── */
let connection: null | {
  clientId: string; clientSecret: string; refreshToken: string;
  folderId: string; accountEmail: string | null;
} = null;
let connectionReads = 0;
vi.mock("../casting-drive.js", () => ({
  loadCastingDriveConnection: async () => { connectionReads++; return connection; },
}));

/* ── The settings table ──────────────────────────────────────────────────── */
const settings = new Map<string, string>();
vi.mock("../settings-db.js", () => ({
  getSetting: async (k: string) => settings.get(k) ?? null,
  setSetting: async (k: string, v: string) => { settings.set(k, v); },
}));

/* ── Google itself: record which folders get made, and where ─────────────── */
const madeFolders: Array<{ name: string; parent: string; token: string }> = [];
vi.mock("../integrations/google-drive.js", async () => {
  const real = await vi.importActual<typeof import("../integrations/google-drive.js")>(
    "../integrations/google-drive.js");
  class FakeGoogleDriveClient {
    constructor(readonly oauth?: { refreshToken: string }) {}
    async ensureFolder(name: string, parent: string) {
      madeFolders.push({ name, parent, token: this.oauth?.refreshToken ?? "env" });
      return `folder-for-${this.oauth?.refreshToken ?? "env"}`;
    }
  }
  return { ...real, GoogleDriveClient: FakeGoogleDriveClient };
});

import { config } from "../config.js";
import {
  APP_CONNECTION_ROOT_FOLDER, driveIsConfigured, driveIsLocal, driveSource,
  ensureDriveResolved, getDriveClient, resetAppDriveConnection, resetDriveClient,
} from "./drive-client.js";

const drive = config.drive as Record<string, string>;

function noEnv() {
  drive.rootFolderId = "";
  drive.serviceAccountEmail = ""; drive.serviceAccountKey = "";
  drive.oauthClientId = ""; drive.oauthClientSecret = ""; drive.oauthRefreshToken = "";
  drive.localRoot = "";
}

const connected = (account: string, token = `rt-${account}`) => ({
  clientId: "cid.apps.googleusercontent.com", clientSecret: "secret",
  refreshToken: token, folderId: "CASTING-FOLDER", accountEmail: account,
});

beforeEach(() => {
  noEnv();
  connection = null;
  connectionReads = 0;
  settings.clear();
  madeFolders.length = 0;
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

describe("the app connection (the Casting 'Sign in with Google' button)", () => {
  it("is used when the environment configures no Drive", async () => {
    connection = connected("orm@paruluniversity.ac.in");
    await ensureDriveResolved();
    expect(driveIsConfigured()).toBe(true);
    expect(driveSource()).toBe("app");
    expect(driveIsLocal()).toBe(false);
  });

  it("gives the workflow its own folder in My Drive — never the casting folder", async () => {
    connection = connected("orm@paruluniversity.ac.in");
    await ensureDriveResolved();

    expect(madeFolders).toEqual([
      { name: APP_CONNECTION_ROOT_FOLDER, parent: "root", token: "rt-orm@paruluniversity.ac.in" },
    ]);
    const { rootId } = getDriveClient();
    expect(rootId).not.toBe("CASTING-FOLDER");
    expect(rootId).toBe("folder-for-rt-orm@paruluniversity.ac.in");
  });

  it("remembers that folder, so the next start does not go looking again", async () => {
    connection = connected("orm@paruluniversity.ac.in");
    await ensureDriveResolved();
    resetAppDriveConnection();
    madeFolders.length = 0;

    await ensureDriveResolved();
    expect(madeFolders).toEqual([]);
    expect(getDriveClient().rootId).toBe("folder-for-rt-orm@paruluniversity.ac.in");
  });

  it("does not reuse one account's folder for a different account", async () => {
    connection = connected("first@paruluniversity.ac.in");
    await ensureDriveResolved();

    connection = connected("second@paruluniversity.ac.in");
    resetAppDriveConnection();
    madeFolders.length = 0;
    await ensureDriveResolved();

    expect(madeFolders).toHaveLength(1);
    expect(getDriveClient().rootId).toBe("folder-for-rt-second@paruluniversity.ac.in");
  });

  it("beats DRIVE_LOCAL_ROOT, so a leftover dev setting cannot take production onto disk", async () => {
    drive.localRoot = "/tmp/leftover";
    connection = connected("orm@paruluniversity.ac.in");
    await ensureDriveResolved();
    expect(driveSource()).toBe("app");
    expect(driveIsLocal()).toBe(false);
  });
});

describe("the environment", () => {
  it("wins over the app connection, and the database is never consulted", async () => {
    drive.rootFolderId = "ENV-ROOT";
    drive.oauthClientId = "x"; drive.oauthClientSecret = "y"; drive.oauthRefreshToken = "z";
    connection = connected("orm@paruluniversity.ac.in");

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
    connection = connected("orm@paruluniversity.ac.in");
    await ensureDriveResolved();
    await ensureDriveResolved();
    await ensureDriveResolved();
    expect(connectionReads).toBe(1);
  });

  it("reads exactly once when many requests arrive together", async () => {
    connection = connected("orm@paruluniversity.ac.in");
    await Promise.all([ensureDriveResolved(), ensureDriveResolved(), ensureDriveResolved()]);
    expect(connectionReads).toBe(1);
    expect(madeFolders).toHaveLength(1);
  });

  it("picks up a connection made later, once reset", async () => {
    await ensureDriveResolved();
    expect(driveIsConfigured()).toBe(false);

    connection = connected("orm@paruluniversity.ac.in");
    resetAppDriveConnection();
    await ensureDriveResolved();
    expect(driveIsConfigured()).toBe(true);
  });
});

describe("when Drive misbehaves", () => {
  it("never throws out of the check — the module just reports not connected", async () => {
    connection = connected("orm@paruluniversity.ac.in");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    settings.set("outreach_video.drive_root", "{not json");
    // An unreadable saved setting is recovered from by finding the folder again.
    await expect(ensureDriveResolved()).resolves.toBeUndefined();
    expect(driveIsConfigured()).toBe(true);
    spy.mockRestore();
  });
});
