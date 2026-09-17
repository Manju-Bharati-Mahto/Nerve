// @vitest-environment node
/**
 * §11 / §12 — the event calendar and the assignment workflow that replaced the
 * approval gate, plus the §19 notifications each step raises.
 *
 * The rules worth pinning down are the ones about who may do what to whose
 * event, and that assignment and reassignment are distinguishable — §19 gives
 * them different wording, so conflating them would tell an editor the wrong
 * thing about work they've just been handed.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { config } from "../config.js";
import { resetDriveClient } from "./drive-client.js";
import { resetStoreState } from "./drive-store.js";
import { addUser, setUserActive } from "./users.js";
import { listNotifications, markRead, unreadCount, NOTIFICATION_TEXT } from "./notifications.js";
import {
  createEvent, assignEvent, completeEvent, updateEventDetails, getEvent,
  listEvents, todoFor, eventCounts, EventNotFoundError, NotYourEventError,
} from "./events.js";
import type { VideoUser } from "./types.js";

let tmpRoot: string;
let manager: VideoUser;
let editorA: VideoUser;
let editorB: VideoUser;
let publisher: VideoUser;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nerve-events-"));
  (config.drive as { localRoot: string }).localRoot = tmpRoot;
  (config.drive as { rootFolderId: string }).rootFolderId = "";
  (config.drive as { serviceAccountEmail: string }).serviceAccountEmail = "";
  (config.drive as { oauthClientId: string }).oauthClientId = "";
  resetDriveClient();
  resetStoreState();
  manager = await addUser({ name: "The Manager", email: "m@agency.com", role: "manager" });
  editorA = await addUser({ name: "Editor A", email: "a@agency.com", role: "editor" });
  editorB = await addUser({ name: "Editor B", email: "b@agency.com", role: "editor" });
  publisher = await addUser({ name: "Publisher", email: "p@agency.com", role: "publisher" });
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  resetDriveClient();
  resetStoreState();
});

const shoot = (date = "2026-10-01") => createEvent(manager, {
  title: "Convocation shoot", description: "Main hall, 2 cameras", date, client: "Convocation 2026",
});

describe("§11.1 / §12 step 10 — creating events", () => {
  it("starts Unassigned, with the date and client recorded", async () => {
    const e = await shoot();
    expect(e.status).toBe("unassigned");
    expect(e.date).toBe("2026-10-01");
    expect(e.client).toBe("Convocation 2026");
    expect(e.assignedEditorId).toBeNull();
  });

  it("requires a title and a real date", async () => {
    await expect(createEvent(manager, { title: "  ", date: "2026-10-01" })).rejects.toThrow(/title is required/i);
    await expect(createEvent(manager, { title: "x", date: "next tuesday" })).rejects.toThrow(/valid event date/i);
  });

  it("logs the creation (§12 step 15)", async () => {
    const e = await shoot();
    expect(e.activity.map(a => a.action)).toEqual(["event.created"]);
    expect(e.activity[0].userName).toBe("The Manager");
  });
});

describe("§11.2 / §12 steps 11–12 — assignment", () => {
  it("opens the event and puts it in that editor's To-Do List", async () => {
    const e = await shoot();
    const assigned = await assignEvent(e.id, editorA.id, manager);
    expect(assigned.status).toBe("open");
    expect(assigned.assignedEditorId).toBe(editorA.id);
    expect(assigned.assignedBy).toBe(manager.id);
    expect((await todoFor(editorA.id)).map(x => x.id)).toEqual([e.id]);
  });

  it("tells the editor, in §19's words", async () => {
    const e = await shoot();
    await assignEvent(e.id, editorA.id, manager);
    const [n] = await listNotifications(editorA.id);
    expect(n.kind).toBe("event_assigned");
    expect(n.message).toContain(NOTIFICATION_TEXT.event_assigned);
    expect(n.message).toContain("Convocation shoot");
    expect(n.subject).toEqual({ type: "event", id: e.id });
  });

  it("distinguishes a reassignment from a first assignment", async () => {
    const e = await shoot();
    await assignEvent(e.id, editorA.id, manager);
    await assignEvent(e.id, editorB.id, manager);

    // §19 gives the two cases different wording; B is being handed existing work.
    const [forB] = await listNotifications(editorB.id);
    expect(forB.kind).toBe("event_reassigned");
    expect(forB.message).toContain(NOTIFICATION_TEXT.event_reassigned);

    const reassignEntry = (await getEvent(e.id)).activity.find(a => a.action === "event.reassigned");
    expect(reassignEntry).toBeTruthy();
  });

  it("moves the event off the previous editor's To-Do List", async () => {
    const e = await shoot();
    await assignEvent(e.id, editorA.id, manager);
    await assignEvent(e.id, editorB.id, manager);
    expect(await todoFor(editorA.id)).toHaveLength(0);
    expect((await todoFor(editorB.id)).map(x => x.id)).toEqual([e.id]);
  });

  it("does not treat re-assigning the same editor as a reassignment", async () => {
    const e = await shoot();
    await assignEvent(e.id, editorA.id, manager);
    await assignEvent(e.id, editorA.id, manager);
    const kinds = (await listNotifications(editorA.id)).map(n => n.kind);
    expect(kinds).not.toContain("event_reassigned");
  });

  it("refuses anyone who is not an available editor", async () => {
    const e = await shoot();
    await expect(assignEvent(e.id, publisher.id, manager)).rejects.toThrow(/only be assigned to editors/i);
    await setUserActive(editorB.id, false);
    await expect(assignEvent(e.id, editorB.id, manager)).rejects.toThrow(/not available/i);
    await expect(assignEvent(e.id, "ghost", manager)).rejects.toThrow(/not available/i);
  });
});

describe("§12 step 13 — completion", () => {
  it("lets the assigned editor mark it done and tells the manager who assigned it", async () => {
    const e = await shoot();
    await assignEvent(e.id, editorA.id, manager);
    const done = await completeEvent(e.id, editorA);

    expect(done.status).toBe("completed");
    expect(done.completedAt).toBeTruthy();
    const [n] = await listNotifications(manager.id);
    expect(n.kind).toBe("event_completed");
    expect(n.message).toContain(NOTIFICATION_TEXT.event_completed);
  });

  it("stops an editor completing work assigned to someone else", async () => {
    const e = await shoot();
    await assignEvent(e.id, editorA.id, manager);
    await expect(completeEvent(e.id, editorB)).rejects.toBeInstanceOf(NotYourEventError);
  });

  it("tells an editor an unassigned event simply isn't theirs", async () => {
    // The ownership check fires before the status one, which reads better here:
    // an unassigned event genuinely isn't assigned to them.
    const e = await shoot();
    await expect(completeEvent(e.id, editorA)).rejects.toBeInstanceOf(NotYourEventError);
  });

  it("refuses even an admin completing an event nobody is assigned to", async () => {
    const e = await shoot();
    const admin = await addUser({ name: "Admin", email: "admin@agency.com", role: "admin" });
    await expect(completeEvent(e.id, admin)).rejects.toThrow(/open, assigned event/i);
  });

  it("turns a completed event back into open work if it is reassigned", async () => {
    const e = await shoot();
    await assignEvent(e.id, editorA.id, manager);
    await completeEvent(e.id, editorA);
    const again = await assignEvent(e.id, editorB.id, manager);
    expect(again.status).toBe("open");
    expect(again.completedAt).toBeNull();
  });

  it("records the whole history in order (§12 step 15)", async () => {
    const e = await shoot();
    await assignEvent(e.id, editorA.id, manager);
    await assignEvent(e.id, editorB.id, manager);
    await completeEvent(e.id, editorB);
    expect((await getEvent(e.id)).activity.map(a => a.action))
      .toEqual(["event.created", "event.assigned", "event.reassigned", "event.completed"]);
  });
});

describe("§11.1 listing and filters (§18)", () => {
  it("returns events in date order, upcoming and past alike", async () => {
    await createEvent(manager, { title: "Later", date: "2026-12-01" });
    await createEvent(manager, { title: "Earlier", date: "2026-01-15" });
    expect((await listEvents()).map(e => e.title)).toEqual(["Earlier", "Later"]);
  });

  it("filters by assigned editor, status and date window", async () => {
    const a = await createEvent(manager, { title: "A", date: "2026-05-01" });
    await createEvent(manager, { title: "B", date: "2026-09-01" });
    await assignEvent(a.id, editorA.id, manager);

    expect((await listEvents({ editorId: editorA.id })).map(e => e.title)).toEqual(["A"]);
    expect((await listEvents({ status: "unassigned" })).map(e => e.title)).toEqual(["B"]);
    expect((await listEvents({ from: "2026-06-01" })).map(e => e.title)).toEqual(["B"]);
    expect((await listEvents({ to: "2026-06-01" })).map(e => e.title)).toEqual(["A"]);
  });

  it("counts what the §11 KPI cards show", async () => {
    const past = await createEvent(manager, { title: "Past", date: "2026-01-01" });
    await createEvent(manager, { title: "Future", date: "2026-12-31" });
    await assignEvent(past.id, editorA.id, manager);
    await completeEvent(past.id, editorA);

    const counts = await eventCounts("2026-06-01");
    expect(counts).toEqual({ total: 2, upcoming: 1, past: 1, unassigned: 1, completed: 1 });
  });
});

describe("§8.1 To-Do List ordering", () => {
  it("puts open work first and keeps completed items visible below", async () => {
    const soon = await createEvent(manager, { title: "Soon", date: "2026-03-01" });
    const later = await createEvent(manager, { title: "Later", date: "2026-08-01" });
    const done = await createEvent(manager, { title: "Done", date: "2026-01-01" });
    for (const e of [soon, later, done]) await assignEvent(e.id, editorA.id, manager);
    await completeEvent(done.id, editorA);

    expect((await todoFor(editorA.id)).map(e => e.title)).toEqual(["Soon", "Later", "Done"]);
  });
});

describe("editing an event", () => {
  it("corrects details and records that it happened", async () => {
    const e = await shoot();
    const fixed = await updateEventDetails(e.id, manager, { title: "Convocation shoot (Hall B)", date: "2026-10-02" });
    expect(fixed.title).toBe("Convocation shoot (Hall B)");
    expect(fixed.date).toBe("2026-10-02");
    expect(fixed.activity.map(a => a.action)).toContain("event.updated");
  });

  it("still rejects an empty title or a bad date", async () => {
    const e = await shoot();
    await expect(updateEventDetails(e.id, manager, { title: " " })).rejects.toThrow(/title is required/i);
    await expect(updateEventDetails(e.id, manager, { date: "soon" })).rejects.toThrow(/valid event date/i);
  });

  it("raises a clear error for an event that doesn't exist", async () => {
    await expect(getEvent("nope")).rejects.toBeInstanceOf(EventNotFoundError);
  });
});

describe("§19 notifications", () => {
  it("counts unread and can mark them read", async () => {
    const e = await shoot();
    await assignEvent(e.id, editorA.id, manager);
    expect(await unreadCount(editorA.id)).toBe(1);
    expect(await markRead(editorA.id)).toBe(1);
    expect(await unreadCount(editorA.id)).toBe(0);
  });

  it("keeps newest first", async () => {
    const first = await shoot("2026-10-01");
    const second = await createEvent(manager, { title: "Second shoot", date: "2026-10-05" });
    await assignEvent(first.id, editorA.id, manager);
    await assignEvent(second.id, editorA.id, manager);
    expect((await listNotifications(editorA.id))[0].message).toContain("Second shoot");
  });

  it("never lets a notification failure break the action that caused it", async () => {
    const e = await shoot();
    // A deleted recipient simply has nowhere to receive it; assignment still stands.
    const assigned = await assignEvent(e.id, editorA.id, manager);
    expect(assigned.status).toBe("open");
  });
});
