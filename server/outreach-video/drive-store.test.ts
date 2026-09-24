// @vitest-environment node
/**
 * The Drive data stores are this module's database (PRD §28), so the properties
 * a database would normally give us for free have to be proven here instead.
 * These tests run against the filesystem adapter, which reproduces Drive's
 * revision-on-write semantics — the mechanism §24 is enforced with.
 *
 * The concurrency tests are the point of this file: "no external database"
 * means concurrent updates are our problem, and losing a write would silently
 * destroy workflow history.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { config } from "../config.js";
import {
  LocalDriveClient, RevisionMismatchError, resetDriveClient, driveIsLocal, driveIsConfigured,
} from "./drive-client.js";
import {
  ensureDriveStructure, mutateStore, readStore, resetStoreState, invalidateStore,
  STORE_FILES, VIDEOS_FOLDER, THUMBNAILS_FOLDER, REPORTS_FOLDER,
} from "./drive-store.js";
import { EMPTY_WORKFLOW_STORE, type WorkflowStoreDoc, type VideoRecord } from "./types.js";

let tmpRoot: string;

function video(id: string): VideoRecord {
  return {
    id, title: id, client: "Client A", editorId: "u1", caption: "",
    status: "draft", currentVersion: 1, driveFileId: `drive-${id}`, driveFileName: `${id}.mp4`,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), activity: [],
  };
}

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nerve-drive-"));
  // Point the module at the filesystem adapter for the duration of the test.
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

describe("Drive configuration", () => {
  it("reports itself configured when the local adapter is selected", () => {
    expect(driveIsConfigured()).toBe(true);
    expect(driveIsLocal()).toBe(true);
  });

  it("prefers real Google credentials over the local adapter, so dev config cannot shadow production", () => {
    (config.drive as { rootFolderId: string }).rootFolderId = "real-folder";
    (config.drive as { serviceAccountEmail: string }).serviceAccountEmail = "sa@example.com";
    (config.drive as { serviceAccountKey: string }).serviceAccountKey = "-----BEGIN PRIVATE KEY-----";
    resetDriveClient();
    expect(driveIsLocal()).toBe(false);
    // Reset for afterEach cleanup.
    (config.drive as { serviceAccountEmail: string }).serviceAccountEmail = "";
    (config.drive as { rootFolderId: string }).rootFolderId = "";
  });
});

describe("§6 Drive structure", () => {
  it("creates the documented folder tree on first use", async () => {
    await ensureDriveStructure();
    for (const folder of [VIDEOS_FOLDER, THUMBNAILS_FOLDER, REPORTS_FOLDER]) {
      const stat = await fs.stat(path.join(tmpRoot, folder));
      expect(stat.isDirectory()).toBe(true);
    }
  });

  it("is idempotent — a second call reuses the same folders", async () => {
    const first = await ensureDriveStructure();
    resetStoreState();
    const second = await ensureDriveStructure();
    expect(second).toEqual(first);
  });
});

describe("store reads", () => {
  it("auto-creates an empty document on first read rather than failing", async () => {
    const doc = await readStore<WorkflowStoreDoc>("workflow");
    expect(doc).toEqual(EMPTY_WORKFLOW_STORE);
    // And it was actually persisted, not just defaulted in memory.
    const onDisk = await fs.readFile(path.join(tmpRoot, STORE_FILES.workflow), "utf8");
    expect(JSON.parse(onDisk)).toEqual(EMPTY_WORKFLOW_STORE);
  });

  it("hands back a clone, so a caller mutating the result cannot corrupt the cache", async () => {
    await mutateStore<WorkflowStoreDoc>("workflow", d => {
      d.videos.push(video("v1"));
      return { doc: d, result: undefined };
    });
    const first = await readStore<WorkflowStoreDoc>("workflow");
    first.videos[0].title = "mutated by caller";
    const second = await readStore<WorkflowStoreDoc>("workflow");
    expect(second.videos[0].title).toBe("v1");
  });

  it("surfaces a corrupt store instead of silently resetting it (history must never be destroyed)", async () => {
    await readStore<WorkflowStoreDoc>("workflow");
    invalidateStore();
    await fs.writeFile(path.join(tmpRoot, STORE_FILES.workflow), "{ not json", "utf8");
    await expect(readStore<WorkflowStoreDoc>("workflow")).rejects.toThrow(/not valid JSON/i);
  });
});

describe("§24 concurrency — no write may be silently lost", () => {
  it("keeps every append when many mutations are issued in parallel", async () => {
    // The scenario that breaks a naive read-modify-write against a JSON file:
    // without serialisation + revision guards, most of these would be clobbered.
    const ids = Array.from({ length: 25 }, (_, i) => `v${i}`);
    await Promise.all(ids.map(id =>
      mutateStore<WorkflowStoreDoc>("workflow", d => {
        d.videos.push(video(id));
        return { doc: d, result: undefined };
      }),
    ));
    const doc = await readStore<WorkflowStoreDoc>("workflow");
    expect(doc.videos).toHaveLength(ids.length);
    expect(new Set(doc.videos.map(v => v.id))).toEqual(new Set(ids));
  });

  it("retries against fresh data when the file changed underneath, rather than overwriting it", async () => {
    await mutateStore<WorkflowStoreDoc>("workflow", d => {
      d.videos.push(video("original"));
      return { doc: d, result: undefined };
    });

    // Simulate an out-of-band edit (another process, or someone editing the JSON
    // in Drive directly) landing between this mutation's read and its write.
    let interfered = false;
    await mutateStore<WorkflowStoreDoc>("workflow", async d => {
      if (!interfered) {
        interfered = true;
        const client = new LocalDriveClient(tmpRoot);
        const fileId = STORE_FILES.workflow;
        const { content, revisionId } = await client.readTextFile(fileId);
        const outside = JSON.parse(content) as WorkflowStoreDoc;
        outside.videos.push(video("written-outside"));
        await client.updateTextFile(fileId, JSON.stringify(outside), revisionId);
        invalidateStore("workflow");
      }
      d.videos.push(video("mine"));
      return { doc: d, result: undefined };
    });

    const doc = await readStore<WorkflowStoreDoc>("workflow");
    const ids = doc.videos.map(v => v.id);
    // The retry must have rebased onto the outside write — all three survive.
    expect(ids).toContain("original");
    expect(ids).toContain("written-outside");
    expect(ids).toContain("mine");
  });

  it("rejects a stale write at the client level", async () => {
    const client = new LocalDriveClient(tmpRoot);
    const meta = await client.createTextFile("probe.json", "root", "{}");
    await client.updateTextFile("probe.json", `{"v":1}`, meta.revisionId);
    // Re-using the now-superseded revision must fail rather than overwrite.
    await expect(client.updateTextFile("probe.json", `{"v":2}`, meta.revisionId))
      .rejects.toBeInstanceOf(RevisionMismatchError);
  });

  it("does not wedge the write queue when one mutation throws", async () => {
    await expect(mutateStore<WorkflowStoreDoc>("workflow", () => { throw new Error("boom"); }))
      .rejects.toThrow("boom");
    // A subsequent write to the same store must still go through.
    await mutateStore<WorkflowStoreDoc>("workflow", d => {
      d.videos.push(video("after-failure"));
      return { doc: d, result: undefined };
    });
    const doc = await readStore<WorkflowStoreDoc>("workflow");
    expect(doc.videos.map(v => v.id)).toEqual(["after-failure"]);
  });

  it("returns the mutation's own result to its caller", async () => {
    const created = await mutateStore<WorkflowStoreDoc, string>("workflow", d => {
      const v = video("v-result");
      d.videos.push(v);
      return { doc: d, result: v.id };
    });
    expect(created).toBe("v-result");
  });
});

describe("local adapter safety", () => {
  it("refuses to read or write outside its root", async () => {
    const client = new LocalDriveClient(tmpRoot);
    await expect(client.readTextFile("../../etc/passwd")).rejects.toThrow(/outside the local Drive root/i);
  });
});
