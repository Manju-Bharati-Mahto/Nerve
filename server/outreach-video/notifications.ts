/**
 * §19 — in-app workflow notifications.
 *
 * Each notification is written onto its recipient's user record, so there is no
 * fourth Drive store beyond the three §6 documents. The list is capped: an
 * agency generates these steadily and forever, and the users document is read
 * on every authenticated request, so it must not grow without bound.
 *
 * Raising a notification never fails the action that caused it. Someone not
 * being told about a submitted video is a nuisance; a submission being rejected
 * because the telling failed is a bug.
 */
import { randomUUID } from "node:crypto";
import { mutateUsers, readUsers } from "./drive-store.js";
import type { NotificationKind, WorkflowNotification } from "./types.js";

/** Kept per user. Well beyond what anyone reads, small enough to stay cheap. */
const MAX_PER_USER = 50;

/** §19's exact wording, so the UI doesn't reinvent it per screen. */
export const NOTIFICATION_TEXT: Record<NotificationKind, string> = {
  video_submitted: "New video ready for publishing.",
  event_assigned: "A new event has been added to your To-Do List.",
  event_reassigned: "An event has been reassigned to you.",
  event_completed: "An assigned event has been marked Completed.",
  // §14 — the review outcomes and the two deadline notices.
  video_approved: "Your video was approved.",
  video_rejected: "Your video needs changes.",
  posting_due: "Scheduled content is due to be posted.",
  campaign_deadline: "A campaign is approaching its end date.",
  campaign_completed: "A campaign has reached its posting target.",
  user_created: "A new member has joined the outreach team.",
  system_issue: "Something in the video workflow needs attention.",
  video_review_requested: "A video was submitted for review.",
};

/**
 * Whether this person has already been told this exact thing recently.
 *
 * The deadline notices are raised by a timer that runs every few minutes, so
 * without this a campaign ending on Friday would notify its manager a few
 * hundred times before Friday. Keyed on the subject rather than the text,
 * because the text carries a changing day count.
 */
export async function alreadyNotified(
  userId: string, kind: NotificationKind, subjectId: string, withinHours = 20,
): Promise<boolean> {
  const doc = await readUsers();
  const user = doc.users.find(u => u.id === userId);
  if (!user?.notifications?.length) return false;
  const cutoff = Date.now() - withinHours * 60 * 60 * 1000;
  return user.notifications.some(n =>
    n.kind === kind && n.subject?.id === subjectId && new Date(n.createdAt).getTime() >= cutoff);
}

export async function notify(
  userIds: string | string[],
  kind: NotificationKind,
  subject?: { type: "video" | "event" | "campaign" | "system"; id: string } | null,
  detail?: string,
): Promise<void> {
  const targets = (Array.isArray(userIds) ? userIds : [userIds]).filter(Boolean);
  if (targets.length === 0) return;
  try {
    await mutateUsers<void>(doc => {
      for (const id of targets) {
        const user = doc.users.find(u => u.id === id && !u.deletedAt);
        if (!user) continue;
        const list = user.notifications ?? (user.notifications = []);
        list.unshift({
          id: randomUUID(),
          kind,
          // The detail (a title, usually) is appended so the recipient knows
          // which item it concerns without opening it.
          message: detail ? `${NOTIFICATION_TEXT[kind]} ${detail}` : NOTIFICATION_TEXT[kind],
          createdAt: new Date().toISOString(),
          readAt: null,
          subject: subject ?? null,
        });
        if (list.length > MAX_PER_USER) list.length = MAX_PER_USER;
      }
      return { doc, result: undefined };
    });
  } catch (err) {
    // Deliberately swallowed — see the note at the top of the file.
    console.warn("[outreach-video] could not raise a notification:", err instanceof Error ? err.message : err);
  }
}

export async function listNotifications(userId: string): Promise<WorkflowNotification[]> {
  const doc = await readUsers();
  return doc.users.find(u => u.id === userId)?.notifications ?? [];
}

export async function unreadCount(userId: string): Promise<number> {
  return (await listNotifications(userId)).filter(n => !n.readAt).length;
}

/** Marks specific notifications read, or all of them when no ids are given. */
export async function markRead(userId: string, ids?: string[]): Promise<number> {
  return mutateUsers<number>(doc => {
    const user = doc.users.find(u => u.id === userId);
    if (!user?.notifications) return { doc, result: 0 };
    const now = new Date().toISOString();
    let changed = 0;
    for (const n of user.notifications) {
      if (n.readAt) continue;
      if (ids && !ids.includes(n.id)) continue;
      n.readAt = now;
      changed++;
    }
    return { doc, result: changed };
  });
}
