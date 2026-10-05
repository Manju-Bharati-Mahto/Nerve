/**
 * §14 — the two notices nobody's action triggers.
 *
 * Most notifications in this module are raised by somebody doing something:
 * submitting, approving, assigning. These two are different. "Approaching
 * deadlines" and "campaign deadlines" are raised by time passing, so there is
 * nothing to hang them off except a clock.
 *
 * THE SPAM PROBLEM IS THE WHOLE DESIGN. This runs on the same few-minute tick
 * as the rest of Nerve's automations, and a campaign ending on Friday is
 * equally "approaching its deadline" on every one of those ticks between now
 * and then. Raising the notice each time would bury the recipient and make
 * every notification worth ignoring. So each notice is raised at most once per
 * subject per day, checked against the notifications the recipient already
 * holds — there is no separate "already sent" store to keep in step, because
 * the sent notifications ARE the record.
 *
 * Nothing here posts anything or changes a status. A scheduled video whose
 * time has come is still published by a person; this only makes sure somebody
 * is told it is due.
 */
import { alreadyNotified, notify } from "./notifications.js";
import { listActiveUsers } from "./users.js";
import { listCampaigns } from "./campaigns.js";
import { listVideos } from "./videos.js";
import { driveIsConfigured, ensureDriveResolved } from "./drive-client.js";

/** How close to its end date a campaign has to be before anyone is told. */
const CAMPAIGN_DEADLINE_DAYS = 3;

export interface AutomationResult {
  postingDue: number;
  campaignDeadlines: number;
  skipped?: string;
}

function daysUntil(dateIso: string, now: Date): number {
  const end = new Date(`${dateIso}T23:59:59`);
  return Math.ceil((end.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
}

export async function runOutreachVideoAutomations(now = new Date()): Promise<AutomationResult> {
  // Drive is this module's database. With no Drive there is nothing to read,
  // and the tick should be quiet rather than noisy about it.
  await ensureDriveResolved();
  if (!driveIsConfigured()) return { postingDue: 0, campaignDeadlines: 0, skipped: "drive not configured" };

  const [users, videos, campaigns] = await Promise.all([
    listActiveUsers(), listVideos(), listCampaigns(),
  ]);
  const publishers = users.filter(u => u.role === "publisher" || u.role === "admin");
  const managers = users.filter(u => u.role === "manager" || u.role === "admin");

  let postingDue = 0;
  let campaignDeadlines = 0;

  /* §14 Publisher — "approaching deadlines". A scheduled video whose posting
     time has arrived and which is still not published. */
  for (const v of videos) {
    if (v.status !== "scheduled" || !v.scheduledFor) continue;
    if (new Date(v.scheduledFor).getTime() > now.getTime()) continue;
    for (const p of publishers) {
      if (await alreadyNotified(p.id, "posting_due", v.id)) continue;
      await notify([p.id], "posting_due", { type: "video", id: v.id }, `“${v.title}”`);
      postingDue++;
    }
  }

  /* §14 Manager — "campaign deadlines". A campaign nearing its end date that
     nobody has marked completed. Overdue ones keep notifying: a campaign
     past its end date with posts outstanding is more worth saying, not less. */
  for (const c of campaigns) {
    if (c.status === "completed") continue;
    const left = daysUntil(c.endDate, now);
    if (left > CAMPAIGN_DEADLINE_DAYS) continue;
    const detail = left < 0
      ? `“${c.name}” ended ${Math.abs(left)} day${Math.abs(left) === 1 ? "" : "s"} ago`
      : left === 0
        ? `“${c.name}” ends today`
        : `“${c.name}” ends in ${left} day${left === 1 ? "" : "s"}`;
    for (const m of managers) {
      if (await alreadyNotified(m.id, "campaign_deadline", c.id)) continue;
      /* The subject is what makes this recognisable as a repeat on the next
         tick. Without it the notice has nothing to match on and goes out
         again every few minutes. */
      await notify([m.id], "campaign_deadline", { type: "campaign", id: c.id }, detail);
      campaignDeadlines++;
    }
  }

  return { postingDue, campaignDeadlines };
}
