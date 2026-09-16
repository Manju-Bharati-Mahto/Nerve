/**
 * The video workflow's user registry (PRD §4, §6.2) and activity primitives (§16).
 *
 * Relationship to Nerve's own users table: a person still signs into Nerve with
 * their Nerve account — that is authentication, and it is platform
 * infrastructure rather than video-workflow data. What lives in Drive is the
 * workflow's own view of that person: their workflow role, whether they are
 * active in this module, when they last acted, and — critically — a durable
 * name/email snapshot.
 *
 * That snapshot is what makes §4.6 work: "Deletion must not remove historical
 * workflow records. Historical records should retain the user's name and email
 * as a snapshot." Activity entries embed the actor's name and email at the time
 * they acted, so history stays readable even after the account is gone.
 */
import { randomUUID } from "node:crypto";
import { mutateUsers, readUsers } from "./drive-store.js";
import type { ActivityEntry, VideoRole, VideoUser } from "./types.js";

/** Maps a Nerve role onto the workflow role it acts as (§3). */
export function videoRoleForNerveRole(role: string): VideoRole | null {
  if (role === "super_admin" || role === "admin") return "admin";
  if (role === "outreach_manager") return "manager";
  if (role === "outreach_editor") return "editor";
  if (role === "outreach_publisher") return "publisher";
  return null;
}

/** Everyone still on the active list — tombstones and disabled users excluded. */
export async function listActiveUsers(): Promise<VideoUser[]> {
  const doc = await readUsers();
  return doc.users.filter(u => !u.deletedAt && u.active);
}

/** Everyone the Admin table should show: active and disabled, but not deleted (§4.2). */
export async function listUsers(): Promise<VideoUser[]> {
  const doc = await readUsers();
  return doc.users.filter(u => !u.deletedAt);
}

/** Active editors only — the dropdown the Manager assigns events from (§11.2). */
export async function listActiveEditors(): Promise<VideoUser[]> {
  return (await listActiveUsers()).filter(u => u.role === "editor");
}

/**
 * Resolves a user by email INCLUDING tombstones, so historical lookups still
 * find the person. Callers gating access must check `active`/`deletedAt`.
 */
export async function findUserByEmail(email: string): Promise<VideoUser | null> {
  const doc = await readUsers();
  const target = email.trim().toLowerCase();
  return doc.users.find(u => u.email.trim().toLowerCase() === target) ?? null;
}

export async function findUserById(id: string): Promise<VideoUser | null> {
  const doc = await readUsers();
  return doc.users.find(u => u.id === id) ?? null;
}

export class UserExistsError extends Error {
  constructor(email: string) {
    super(`A user with the email ${email} already exists in the video workflow.`);
    this.name = "UserExistsError";
  }
}

/** §4.3 — Admin registers a user. Email is the identity, matched at sign-in (§5). */
export async function addUser(input: { name: string; email: string; role: VideoRole; active?: boolean }): Promise<VideoUser> {
  const email = input.email.trim().toLowerCase();
  const now = new Date().toISOString();
  return mutateUsers<VideoUser>(doc => {
    const clash = doc.users.find(u => u.email.trim().toLowerCase() === email && !u.deletedAt);
    if (clash) throw new UserExistsError(email);
    // A previously deleted user re-added with the same email gets a fresh record
    // rather than resurrecting the tombstone, so old history stays attributed to
    // the old record exactly as it was.
    const user: VideoUser = {
      id: randomUUID(),
      name: input.name.trim(),
      email,
      role: input.role,
      active: input.active ?? true,
      createdAt: now,
      updatedAt: now,
      lastActivityAt: null,
      deletedAt: null,
    };
    doc.users.push(user);
    return { doc, result: user };
  });
}

/** §4.4 — role change. Takes effect on the user's next authenticated session. */
export async function setUserRole(id: string, role: VideoRole): Promise<VideoUser | null> {
  return mutateUsers<VideoUser | null>(doc => {
    const user = doc.users.find(u => u.id === id && !u.deletedAt);
    if (!user) return { doc, result: null };
    user.role = role;
    user.updatedAt = new Date().toISOString();
    return { doc, result: { ...user } };
  });
}

/** §4.5 — disable/reactivate. The record and all its history stay intact. */
export async function setUserActive(id: string, active: boolean): Promise<VideoUser | null> {
  return mutateUsers<VideoUser | null>(doc => {
    const user = doc.users.find(u => u.id === id && !u.deletedAt);
    if (!user) return { doc, result: null };
    user.active = active;
    user.updatedAt = new Date().toISOString();
    return { doc, result: { ...user } };
  });
}

/**
 * §4.6 — removes the user from the active list without destroying anything.
 * The record is tombstoned rather than spliced out, so any historical reference
 * to this user id still resolves to a name and email.
 */
export async function deleteUser(id: string): Promise<boolean> {
  return mutateUsers<boolean>(doc => {
    const user = doc.users.find(u => u.id === id && !u.deletedAt);
    if (!user) return { doc, result: false };
    user.deletedAt = new Date().toISOString();
    user.active = false;
    user.updatedAt = user.deletedAt;
    return { doc, result: true };
  });
}

/** §4.2 "Last Activity" — best-effort, never allowed to fail a request. */
export async function touchLastActivity(id: string): Promise<void> {
  try {
    await mutateUsers<void>(doc => {
      const user = doc.users.find(u => u.id === id);
      if (user) user.lastActivityAt = new Date().toISOString();
      return { doc, result: undefined };
    });
  } catch {
    // Recording "last seen" must never break the action the user came to do.
  }
}

/**
 * Builds an activity entry (§16) with the actor's identity snapshotted inline,
 * so the entry survives the user being deleted (§4.6).
 */
export function activityEntry(
  actor: Pick<VideoUser, "id" | "name" | "email" | "role">,
  action: string,
  extra: Partial<Pick<ActivityEntry, "previousStatus" | "newStatus" | "relatedEventId" | "notes">> = {},
): ActivityEntry {
  return {
    id: randomUUID(),
    userId: actor.id,
    userName: actor.name,
    userEmail: actor.email,
    userRole: actor.role,
    action,
    timestamp: new Date().toISOString(),
    previousStatus: extra.previousStatus ?? null,
    newStatus: extra.newStatus ?? null,
    relatedEventId: extra.relatedEventId ?? null,
    notes: extra.notes ?? null,
  };
}
