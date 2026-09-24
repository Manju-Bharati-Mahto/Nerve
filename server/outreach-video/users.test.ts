// @vitest-environment node
/**
 * §4 Admin Module behaviour, with particular attention to §4.5/§4.6: disabling
 * or deleting a user must never destroy workflow history. Those are the rules
 * most easily broken by a naive "delete the row" implementation, so they are
 * tested directly rather than assumed.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { config } from "../config.js";
import { resetDriveClient } from "./drive-client.js";
import { resetStoreState } from "./drive-store.js";
import {
  addUser, deleteUser, findUserByEmail, findUserById, listActiveEditors,
  listActiveUsers, listUsers, setUserActive, setUserRole, touchLastActivity,
  activityEntry, videoRoleForNerveRole, UserExistsError,
} from "./users.js";

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nerve-users-"));
  (config.drive as { localRoot: string }).localRoot = tmpRoot;
  (config.drive as { rootFolderId: string }).rootFolderId = "";
  (config.drive as { serviceAccountEmail: string }).serviceAccountEmail = "";
  (config.drive as { oauthClientId: string }).oauthClientId = "";
  resetDriveClient();
  resetStoreState();
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  resetDriveClient();
  resetStoreState();
});

describe("§3 role mapping", () => {
  it("maps each Nerve role onto its workflow role", () => {
    expect(videoRoleForNerveRole("super_admin")).toBe("admin");
    expect(videoRoleForNerveRole("admin")).toBe("admin");
    expect(videoRoleForNerveRole("outreach_manager")).toBe("manager");
    expect(videoRoleForNerveRole("outreach_editor")).toBe("editor");
    expect(videoRoleForNerveRole("outreach_publisher")).toBe("publisher");
  });

  it("returns null for roles with no place in this workflow", () => {
    expect(videoRoleForNerveRole("branding_reports_admin")).toBeNull();
    expect(videoRoleForNerveRole("user")).toBeNull();
  });
});

describe("§4.3 add user", () => {
  it("registers a user and normalises the email that will be matched at sign-in", async () => {
    const user = await addUser({ name: "Editor One", email: "  Editor1@Agency.com ", role: "editor" });
    expect(user.email).toBe("editor1@agency.com");
    expect(user.active).toBe(true);
    expect(await findUserByEmail("EDITOR1@AGENCY.COM")).toMatchObject({ id: user.id });
  });

  it("refuses a duplicate email rather than creating a second identity", async () => {
    await addUser({ name: "Editor One", email: "e1@agency.com", role: "editor" });
    await expect(addUser({ name: "Impostor", email: "E1@agency.com", role: "publisher" }))
      .rejects.toBeInstanceOf(UserExistsError);
  });
});

describe("§4.4 role change", () => {
  it("changes the role while keeping the same identity and record", async () => {
    const user = await addUser({ name: "Person", email: "p@agency.com", role: "editor" });
    const updated = await setUserRole(user.id, "publisher");
    expect(updated?.role).toBe("publisher");
    expect(updated?.id).toBe(user.id);
    expect((await findUserById(user.id))?.role).toBe("publisher");
  });
});

describe("§4.5 disable / reactivate", () => {
  it("removes a disabled user from active listings but keeps the record", async () => {
    const user = await addUser({ name: "Person", email: "p@agency.com", role: "editor" });
    await setUserActive(user.id, false);

    expect((await listActiveUsers()).map(u => u.id)).not.toContain(user.id);
    // Still present in the Admin table (§4.2), just not active.
    expect((await listUsers()).map(u => u.id)).toContain(user.id);
    expect((await findUserById(user.id))?.active).toBe(false);
  });

  it("can be reactivated later, as §4.5 requires", async () => {
    const user = await addUser({ name: "Person", email: "p@agency.com", role: "editor" });
    await setUserActive(user.id, false);
    await setUserActive(user.id, true);
    expect((await listActiveUsers()).map(u => u.id)).toContain(user.id);
  });
});

describe("§4.6 delete user — history must survive", () => {
  it("drops the user from every listing", async () => {
    const user = await addUser({ name: "Person", email: "p@agency.com", role: "editor" });
    expect(await deleteUser(user.id)).toBe(true);
    expect((await listUsers()).map(u => u.id)).not.toContain(user.id);
    expect((await listActiveUsers()).map(u => u.id)).not.toContain(user.id);
  });

  it("keeps the record resolvable so historical references still show a name and email", async () => {
    const user = await addUser({ name: "Gone Person", email: "gone@agency.com", role: "editor" });
    await deleteUser(user.id);
    const tombstone = await findUserById(user.id);
    expect(tombstone).not.toBeNull();
    expect(tombstone?.name).toBe("Gone Person");
    expect(tombstone?.email).toBe("gone@agency.com");
    expect(tombstone?.deletedAt).toBeTruthy();
  });

  it("frees the email for a genuinely new person, without resurrecting the old record", async () => {
    const first = await addUser({ name: "First", email: "shared@agency.com", role: "editor" });
    await deleteUser(first.id);
    const second = await addUser({ name: "Second", email: "shared@agency.com", role: "publisher" });
    expect(second.id).not.toBe(first.id);
    // The old record is untouched — its history stays attributed to the old id.
    expect((await findUserById(first.id))?.name).toBe("First");
  });

  it("reports false when the user is already gone", async () => {
    expect(await deleteUser("no-such-id")).toBe(false);
  });
});

describe("§11.2 editor dropdown", () => {
  it("offers only active editors", async () => {
    const keep = await addUser({ name: "Active Editor", email: "a@agency.com", role: "editor" });
    const disabled = await addUser({ name: "Disabled Editor", email: "b@agency.com", role: "editor" });
    await setUserActive(disabled.id, false);
    await addUser({ name: "A Publisher", email: "c@agency.com", role: "publisher" });

    expect((await listActiveEditors()).map(u => u.id)).toEqual([keep.id]);
  });
});

describe("§16 activity entries", () => {
  it("snapshots the actor's name and email inline so the entry outlives the account", async () => {
    const user = await addUser({ name: "Editor One", email: "e1@agency.com", role: "editor" });
    const entry = activityEntry(user, "video.submitted", { previousStatus: "draft", newStatus: "submitted" });

    await deleteUser(user.id);

    // The entry is self-contained — nothing about it needed the live user record.
    expect(entry.userName).toBe("Editor One");
    expect(entry.userEmail).toBe("e1@agency.com");
    expect(entry.userRole).toBe("editor");
    expect(entry.previousStatus).toBe("draft");
    expect(entry.newStatus).toBe("submitted");
    expect(entry.timestamp).toBeTruthy();
  });
});

describe("§4.2 last activity", () => {
  it("records when a user last acted", async () => {
    const user = await addUser({ name: "Person", email: "p@agency.com", role: "editor" });
    expect(user.lastActivityAt).toBeNull();
    await touchLastActivity(user.id);
    expect((await findUserById(user.id))?.lastActivityAt).toBeTruthy();
  });

  it("never throws for an unknown user — recording it must not break the real action", async () => {
    await expect(touchLastActivity("no-such-id")).resolves.toBeUndefined();
  });
});
