/**
 * The Manager's event calendar and the assignment workflow that replaced the
 * old approval gate (§11, §12).
 *
 * The shape of it: a Manager creates an event (Unassigned), assigns it to an
 * editor (Open, and it appears in that editor's To-Do List), and the editor
 * marks it Completed. Creation, assignment, reassignment and completion each
 * leave an activity entry (§12 step 15) and, except for creation, raise a
 * notification (§19).
 *
 * Lives in the §6.3 Event Data Store on Drive, like everything else here.
 */
import { randomUUID } from "node:crypto";
import { mutateEvents, readEvents } from "./drive-store.js";
import { notify } from "./notifications.js";
import { activityEntry, findUserById } from "./users.js";
import type { EventRecord, EventStatus, VideoUser } from "./types.js";

export class EventNotFoundError extends Error {
  constructor(id: string) {
    super(`Event ${id} was not found.`);
    this.name = "EventNotFoundError";
  }
}

export class NotYourEventError extends Error {
  constructor() {
    super("Editors can only complete events assigned to them.");
    this.name = "NotYourEventError";
  }
}

/** A state conflict rather than a bad request — the caller sent nothing wrong. */
export class EventNotOpenError extends Error {
  constructor() {
    super("Only an open, assigned event can be completed.");
    this.name = "EventNotOpenError";
  }
}

type Actor = Pick<VideoUser, "id" | "name" | "email" | "role">;

async function updateEvent<R>(id: string, apply: (event: EventRecord) => R): Promise<R> {
  return mutateEvents<R>(doc => {
    const event = doc.events.find(e => e.id === id);
    if (!event) throw new EventNotFoundError(id);
    const result = apply(event);
    event.updatedAt = new Date().toISOString();
    return { doc, result };
  });
}

/** §11.1 / §12 step 10 — the Manager creates an event on the calendar. */
export async function createEvent(actor: Actor, input: {
  title: string; description?: string; date: string; client?: string | null;
  campaignId?: string | null; socialPageId?: string | null; contentType?: string | null;
  postingAt?: string | null; assignedPublisherId?: string | null;
}): Promise<EventRecord> {
  const title = input.title.trim();
  if (!title) throw new Error("An event title is required.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new Error("A valid event date is required.");

  const now = new Date().toISOString();
  const event: EventRecord = {
    id: randomUUID(),
    title,
    description: (input.description ?? "").trim(),
    date: input.date,
    client: input.client?.trim() || null,
    // §5 — the detail a calendar entry carries; any of it may still be undecided.
    campaignId: input.campaignId || null,
    socialPageId: input.socialPageId || null,
    contentType: input.contentType?.trim() || null,
    postingAt: input.postingAt || null,
    assignedPublisherId: input.assignedPublisherId || null,
    assignedEditorId: null,
    assignedBy: null,
    // §22.2 — an event starts Unassigned; assigning is what opens it.
    status: "unassigned",
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    activity: [activityEntry(actor, "event.created")],
  };
  return mutateEvents<EventRecord>(doc => {
    doc.events.push(event);
    return { doc, result: event };
  });
}

/**
 * §11.2 / §12 steps 11–12 — assigns (or reassigns) the event to an editor,
 * which is what puts it in their To-Do List.
 *
 * Reassignment is the same operation with a different notification (§19 gives
 * assign and reassign separate wording), and it is recorded distinctly in the
 * activity log so the history shows the event moving between people.
 */
export async function assignEvent(id: string, editorId: string, actor: Actor): Promise<EventRecord> {
  const editor = await findUserById(editorId);
  if (!editor || editor.deletedAt || !editor.active) {
    throw new Error("That editor is not available for assignment.");
  }
  if (editor.role !== "editor") throw new Error("Events can only be assigned to editors.");

  const { event, previousEditorId } = await updateEvent(id, event => {
    const previousEditorId = event.assignedEditorId ?? null;
    const reassigning = !!previousEditorId && previousEditorId !== editorId;
    event.assignedEditorId = editorId;
    event.assignedBy = actor.id;
    // A completed event being handed to someone else becomes open work again.
    event.status = "open";
    event.completedAt = null;
    event.activity.push(activityEntry(actor, reassigning ? "event.reassigned" : "event.assigned", {
      previousStatus: reassigning ? "open" : "unassigned",
      newStatus: "open",
      relatedEventId: event.id,
      notes: `Assigned to ${editor.name}`,
    }));
    return { event: { ...event }, previousEditorId };
  });

  const reassigned = !!previousEditorId && previousEditorId !== editorId;
  await notify(editorId, reassigned ? "event_reassigned" : "event_assigned", { type: "event", id }, `“${event.title}”`);
  return event;
}

/** §12 step 13 / §8.1 — the editor marks their assigned event done. */
export async function completeEvent(id: string, actor: Actor): Promise<EventRecord> {
  const event = await updateEvent(id, event => {
    // Admins can close out an event on someone's behalf; an editor can only
    // complete their own (§28 "Editors can mark their own assigned events").
    if (actor.role === "editor" && event.assignedEditorId !== actor.id) throw new NotYourEventError();
    if (event.status !== "open") throw new EventNotOpenError();
    event.status = "completed";
    event.completedAt = new Date().toISOString();
    event.activity.push(activityEntry(actor, "event.completed", {
      previousStatus: "open", newStatus: "completed", relatedEventId: event.id,
    }));
    return { ...event };
  });

  // §19 — the Manager who assigned it is the one who wants to know.
  if (event.assignedBy) {
    await notify(event.assignedBy, "event_completed", { type: "event", id }, `“${event.title}”`);
  }
  return event;
}

/**
 * Corrects an event's details. Not spelled out in §11, but a calendar whose
 * entries can't be fixed after a typo is one people stop trusting — and the
 * same gap ("no edit for existing records") was raised as a real complaint
 * during the media-ops review.
 */
export async function updateEventDetails(id: string, actor: Actor, patch: {
  title?: string; description?: string; date?: string; client?: string | null;
  campaignId?: string | null; socialPageId?: string | null; contentType?: string | null;
  postingAt?: string | null; assignedPublisherId?: string | null;
}): Promise<EventRecord> {
  return updateEvent(id, event => {
    if (patch.title !== undefined) {
      const title = patch.title.trim();
      if (!title) throw new Error("An event title is required.");
      event.title = title;
    }
    if (patch.description !== undefined) event.description = patch.description.trim();
    if (patch.date !== undefined) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(patch.date)) throw new Error("A valid event date is required.");
      /* The posting time travels with the date unless the caller set one.
         It used to stay on the old day: the calendar lists an event by its
         postingAt and the To-Do list by its date, so one edit left the two
         screens a day apart. Shifting by whole days keeps the time of day
         the manager chose. */
      if (patch.postingAt === undefined && event.postingAt) {
        event.postingAt = shiftByDays(event.postingAt, event.date, patch.date);
      }
      event.date = patch.date;
    }
    if (patch.client !== undefined) event.client = patch.client?.trim() || null;
    // §5 — each settable independently, because they are decided at different times.
    if (patch.campaignId !== undefined) event.campaignId = patch.campaignId || null;
    if (patch.socialPageId !== undefined) event.socialPageId = patch.socialPageId || null;
    if (patch.contentType !== undefined) event.contentType = patch.contentType?.trim() || null;
    if (patch.postingAt !== undefined) event.postingAt = patch.postingAt || null;
    if (patch.assignedPublisherId !== undefined) {
      event.assignedPublisherId = patch.assignedPublisherId || null;
    }
    event.activity.push(activityEntry(actor, "event.updated", { relatedEventId: event.id }));
    return { ...event };
  });
}

/**
 * The events counterpart of claimNameOnlyVideos: an event planned under the
 * campaign's name with no campaign picked is tied to the campaign by id before
 * an edit, so a rename carries it along instead of leaving it filed under a
 * name nothing answers to any more.
 */
export async function claimNameOnlyEvents(campaignId: string, name: string): Promise<number> {
  const wanted = name.trim().toLowerCase();
  const loose = (events: EventRecord[]) =>
    events.filter(e => !e.campaignId && (e.client ?? "").trim().toLowerCase() === wanted);
  if (!wanted || loose((await readEvents()).events).length === 0) return 0;
  return mutateEvents<number>(doc => {
    const events = loose(doc.events);
    for (const e of events) e.campaignId = campaignId;
    return { doc, result: events.length };
  });
}

/**
 * The events counterpart of renameCampaignOnVideos: an event planned for a
 * campaign carries the campaign's current name as its `client`, which the
 * calendar's client filter and search compare by text. Writes only when
 * something differs.
 */
export async function renameCampaignOnEvents(campaignId: string, name: string): Promise<number> {
  const wanted = name.trim();
  const stale = (events: EventRecord[]) =>
    events.filter(e => e.campaignId === campaignId && e.client !== wanted);
  if (stale((await readEvents()).events).length === 0) return 0;
  return mutateEvents<number>(doc => {
    const events = stale(doc.events);
    for (const e of events) e.client = wanted;
    return { doc, result: events.length };
  });
}

/**
 * Moves an ISO instant by the whole days between two YYYY-MM-DD dates. A
 * timestamp that will not parse is left alone rather than replaced with a
 * guess.
 */
export function shiftByDays(iso: string, fromDate: string, toDate: string): string {
  const at = new Date(iso).getTime();
  const days = (Date.parse(`${toDate}T00:00:00Z`) - Date.parse(`${fromDate}T00:00:00Z`)) / 86_400_000;
  if (Number.isNaN(at) || !Number.isFinite(days) || days === 0) return iso;
  return new Date(at + days * 86_400_000).toISOString();
}

export async function getEvent(id: string): Promise<EventRecord> {
  const doc = await readEvents();
  const event = doc.events.find(e => e.id === id);
  if (!event) throw new EventNotFoundError(id);
  return event;
}

/**
 * §11.1 — every event with its date, upcoming and past both visible and
 * filterable; §18 adds assigned-editor and event-status as filters.
 */
export async function listEvents(filter: {
  editorId?: string; status?: EventStatus; from?: string; to?: string; client?: string;
} = {}): Promise<EventRecord[]> {
  const doc = await readEvents();
  return doc.events
    .filter(e => !filter.editorId || e.assignedEditorId === filter.editorId)
    .filter(e => !filter.status || e.status === filter.status)
    .filter(e => !filter.client || e.client === filter.client)
    .filter(e => !filter.from || e.date >= filter.from)
    .filter(e => !filter.to || e.date <= filter.to)
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** §8.1 — an editor's To-Do List is simply the events assigned to them. */
export async function todoFor(editorId: string): Promise<EventRecord[]> {
  const events = await listEvents({ editorId });
  // Open work first and soonest-first within that; completed items stay
  // visible (§8.1 shows both states) but drop below.
  return events.sort((a, b) => {
    if (a.status !== b.status) return a.status === "open" ? -1 : 1;
    return a.date.localeCompare(b.date);
  });
}

/** §11 KPI cards: upcoming, past, unassigned. */
export async function eventCounts(today: string): Promise<{
  total: number; upcoming: number; past: number; unassigned: number; completed: number;
}> {
  const doc = await readEvents();
  return {
    total: doc.events.length,
    upcoming: doc.events.filter(e => e.date >= today).length,
    past: doc.events.filter(e => e.date < today).length,
    unassigned: doc.events.filter(e => e.status === "unassigned").length,
    completed: doc.events.filter(e => e.status === "completed").length,
  };
}
