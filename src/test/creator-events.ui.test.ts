/* ═══════════════════════════════════════════════════════════════════════════
   UI — opening an event from the Creator Network Events table.

   THE BUG THIS FILE EXISTS FOR. Clicking a row in the Events table did nothing
   visible. The detail view then appeared the NEXT time anything forced a
   render — so leaving for Tasks and coming back showed the event you had
   clicked a minute earlier, which read as the tab being stale rather than as
   the click being lost.

   WHY IT HAPPENED. render() is wired to 'hashchange' and to nothing else:

       addEventListener('hashchange', render)

   cnViewEvent set CN_EVENT.id and then called cnGo('events'). cnGo assigned
   location.hash — but on the Events page that hash was ALREADY the current
   value, and assigning an unchanged hash fires no hashchange. cnGo still
   returned true, so `if(!cnGo('events'))render()` skipped its own render too.
   State moved, nothing redrew, and no error was raised anywhere.

   Two sibling handlers, cnViewPayout and cnViewComp, call render() directly and
   were never affected — which is why this was Events only, and why the fix
   belongs in cnGo rather than in the one caller that noticed.

   WHAT IS ASSERTED. The real public/media-ops/index.html is booted in jsdom
   with a scripted server behind it, the click is delivered the way a person
   delivers it, and the assertion is on what is on screen AFTERWARDS with no
   second navigation and no extra render() call from the test.
   ═══════════════════════════════════════════════════════════════════════════ */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const HTML = readFileSync("public/media-ops/index.html", "utf8");

const EVENTS = [
  { id: 41, title: "Convocation 2026", event_date: "2026-10-12", venue: "Main Auditorium",
    unit_name: "University-wide", status: "open", opportunity_count: 2, filled_count: 0 },
  { id: 42, title: "Founders Day", event_date: "2026-11-03", venue: "Open Air Theatre",
    unit_name: "University-wide", status: "draft", opportunity_count: 1, filled_count: 0 },
];

/** The one event the detail endpoint knows about, plus its requirements. */
const DETAIL = {
  event: { id: 41, title: "Convocation 2026", event_date: "2026-10-12",
           venue: "Main Auditorium", unit_name: "University-wide", status: "open",
           description: "Full-day coverage across three stages." },
  opportunities: [],
};

/** An event with requirements, in whatever pair of states a test needs. */
function detail(eventStatus: string, oppStatuses: string[]) {
  return {
    event: { ...DETAIL.event, status: eventStatus },
    opportunities: oppStatuses.map((st, i) => ({
      id: 900 + i, event_id: 41, title: `Reel Creator ${i + 1}`, creator_type: "reel",
      description: "", required_count: 2, status: st, interested: 0, assigned: 0,
      point_rule_id: null, point_rule_name: null, task_deadline: null,
    })),
  };
}

type Ev = <T>(expr: string) => T;

/** Boot as a Creator Admin, already standing on the Events page. */
async function boot(detailBody: unknown = DETAIL) {
  const dom = new JSDOM(HTML, {
    url: "http://localhost/api/media-ops/?as=creator#/media/creator/events",
    runScripts: "dangerously", pretendToBeVisual: true,
  });
  const w = dom.window as unknown as { fetch: unknown; eval: (s: string) => unknown };
  const calls: string[] = [];
  w.fetch = async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const reply = (status: number, body: unknown) =>
      ({ ok: status < 400, status, json: async () => body }) as Response;
    if (url.includes("/api/v1/media/state"))
      return reply(403, { message: "Media Ops is not available for your role." });
    if (url.includes("/creator/state"))
      return reply(200, {
        profile: { user_id: "ui-admin", full_name: "Creator Admin", display_name: "Creator Admin",
                   email: "ca@x.invalid", creator_role: "creator_admin", status: "active",
                   joined_on: "2026-01-01", team: null, lead: null },
        me: { id: "ui-admin" }, teams: [], scope: "all", can_manage_network: true,
        counts: { active: 12, inactive: 0, suspended: 0, archived: 0 },
      });
    if (/\/creator\/events\/\d+/.test(url)) return reply(200, detailBody);
    if (url.includes("/creator/events")) return reply(200, { events: EVENTS });
    if (url.includes("/creator/interests")) return reply(200, { interests: [] });
    return reply(200, {});
  };
  await new Promise((r) => setTimeout(r, 120));
  const ev: Ev = (expr) => w.eval(expr) as never;
  const page = () => (dom.window.document.querySelector("#page") as HTMLElement)?.innerHTML ?? "";
  const settle = () => new Promise((r) => setTimeout(r, 60));
  /* The shell resolves its own landing page on boot, which is the overview.
     Walk to Events the way the sidebar does — a hash change — so the tests
     start standing exactly where the bug was reported. */
  dom.window.location.hash = "#/media/creator/events";
  await settle();
  await settle();
  return { dom, ev, page, calls, settle };
}

describe("opening an event from the Events table", () => {
  it("lists the events once the fetch lands", async () => {
    const h = await boot();
    expect(h.page()).toContain("Convocation 2026");
    expect(h.page()).toContain("Founders Day");
  });

  it("shows the event detail on the click, with no further navigation", async () => {
    const h = await boot();
    /* Clicked the way a person clicks it: the row's own data-act, dispatched
       through the page's delegated handler. Nothing else is touched — in
       particular the test never calls render() or moves the hash. */
    const row = h.dom.window.document.querySelector('[data-act="cnViewEvent"]') as HTMLElement | null;
    expect(row, "the events table rendered no clickable row").not.toBeNull();
    row!.click();
    await h.settle();

    const after = h.page();
    expect(after, "the click left the page on the events list")
      .toContain("Full-day coverage across three stages.");
    expect(after, "the detail view did not render its way back")
      .toContain("← All events");
  });

  it("asked the server for the event it was told to open", async () => {
    const h = await boot();
    (h.dom.window.document.querySelector('[data-act="cnViewEvent"]') as HTMLElement).click();
    await h.settle();
    expect(h.calls.some((u) => /\/creator\/events\/41\b/.test(u)),
      "the detail fetch never went out").toBe(true);
  });

  it("does not need a detour through another tab to catch up", async () => {
    /* The symptom, stated directly: BEFORE the fix the assertion below passed
       only after a trip to Tasks and back. The detail must be on screen without
       that, so the page is never showing a click from a minute ago. */
    const h = await boot();
    (h.dom.window.document.querySelector('[data-act="cnViewEvent"]') as HTMLElement).click();
    await h.settle();
    const straightAway = h.page();

    h.ev("ACTIONS.cnBackToEvents()");
    await h.settle();
    (h.dom.window.document.querySelector('[data-act="cnViewEvent"]') as HTMLElement).click();
    await h.settle();

    expect(h.page(), "a second open behaves differently from the first")
      .toContain("Full-day coverage across three stages.");
    expect(straightAway).toContain("Full-day coverage across three stages.");
  });
});

describe("cnGo, which is where the redraw was lost", () => {
  it("renders when the page asked for is the page already open", async () => {
    const h = await boot();
    /* The precondition for the bug: same hash in, same hash out, so no
       hashchange is coming and cnGo itself has to redraw. */
    const before = h.dom.window.location.hash;
    h.ev("CN_EVENT.id=41; CN_EVENT.loaded=false; cnGo('events')");
    await h.settle();
    expect(h.dom.window.location.hash, "the hash moved, so this is not the no-op case")
      .toBe(before);
    expect(h.page()).toContain("Full-day coverage across three stages.");
  });

  it("still reports whether the page exists for this viewer", async () => {
    const h = await boot();
    /* The return value is what three callers branch on, and it answers "may
       this viewer open that page" — not "did the hash change". */
    expect(h.ev<boolean>("cnGo('events')")).toBe(true);
    expect(h.ev<boolean>("cnGo('no-such-page')")).toBe(false);
  });

  it("navigates normally when the page asked for is a different one", async () => {
    const h = await boot();
    h.ev("cnGo('tasks')");
    await h.settle();
    expect(h.dom.window.location.hash).toMatch(/creator\/tasks$/);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   WHY A REQUIREMENT NOBODY CAN SEE HAS TO SAY SO.

   GET /creator/opportunities applies two independent gates:

       WHERE e.status IN ('open','closed')   -- the event is published
         AND o.status = 'open'               -- the requirement is opened

   Events and requirements are BOTH created 'draft'. An admin who creates an
   event, adds two requirements and stops has built something no creator can
   see, and every chip on the page reads as though the work is done. These tests
   pin the sentence that says otherwise, and the two buttons that resolve it.
   ═══════════════════════════════════════════════════════════════════════════ */
describe("telling the admin whether creators can see a requirement", () => {
  const openEvent = async (h: Awaited<ReturnType<typeof boot>>) => {
    (h.dom.window.document.querySelector('[data-act="cnViewEvent"]') as HTMLElement).click();
    await h.settle();
    return h.page();
  };

  it("says so when the event is still a draft, and points at the event", async () => {
    const h = await boot(detail("draft", ["open", "open"]));
    const p = await openEvent(h);
    expect(p).toMatch(/No creator can see these requirements yet/i);
    expect(p, "an open requirement inside a draft event looked publishable")
      .toMatch(/still draft/i);
  });

  it("says so when the event is published but the requirement is not", async () => {
    const h = await boot(detail("open", ["draft", "draft"]));
    const p = await openEvent(h);
    expect(p).toMatch(/No creator can see these requirements yet/i);
    expect(p).toMatch(/Each requirement has to be opened on its own/i);
    expect(p).toMatch(/Not visible to creators/i);
  });

  it("counts the mixed case rather than calling it all or nothing", async () => {
    const h = await boot(detail("open", ["open", "draft"]));
    const p = await openEvent(h);
    expect(p).toMatch(/1 of 2 requirements are visible to creators/i);
  });

  it("confirms it plainly once every requirement is reachable", async () => {
    const h = await boot(detail("open", ["open", "open"]));
    const p = await openEvent(h);
    expect(p).toMatch(/Creators can see all 2 requirements/i);
    expect(p, "a warning survived a fully published event").not.toMatch(/Not visible to creators/i);
  });

  it("treats a closed event as published, because the server does", async () => {
    /* e.status IN ('open','closed') — a closed event still shows its open
       requirements. The admin view must not contradict the endpoint. */
    const h = await boot(detail("closed", ["open"]));
    const p = await openEvent(h);
    expect(p).toMatch(/Creators can see this requirement/i);
  });

  it("offers a way back from a closed requirement and a closed event", async () => {
    /* OPP_FLOW.closed and EVENT_FLOW.closed both allow 'open', and neither had
       a control — so closing either one was a dead end in the UI. */
    const h = await boot(detail("closed", ["closed"]));
    const p = await openEvent(h);
    expect(p, "no way to reopen the requirement").toMatch(/data-to="open"/);
    expect(p).toMatch(/Reopen event/i);
    expect(p).toMatch(/Reopen</i);
  });

  it("asks for a requirement before it warns about one", async () => {
    const h = await boot(detail("draft", []));
    const p = await openEvent(h);
    expect(p).toMatch(/No requirements yet/i);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   THE CREATOR'S OPPORTUNITIES PANEL, GROUPED BY EVENT.

   WHAT THIS REPLACED. One card per REQUIREMENT, in a two-column grid, each
   repeating its event name as a subtitle. Two roles on the same shoot appeared
   as two unrelated tiles, the event name was printed twice, and the only count
   on offer was "0/2 filled" — which read as a fraction of something unstated.

   The unit a creator decides about is the EVENT: is this worth my Saturday, and
   then which role on it. So the card is the event, and each requirement is a
   row inside it carrying its own interest count and its own button.
   ═══════════════════════════════════════════════════════════════════════════ */
const OPPS = [
  { id: 71, event_id: 3686, event_title: "Rahul Birthday", event_date: "2026-09-26",
    event_venue: "Main Auditorium", event_status: "closed", title: "Real creator",
    creator_type: "reel", description: "Two reels, same day.", required_count: 2,
    interested: 3, assigned: 0, task_deadline: "2026-09-28",
    my_interest: null, my_assignment: null },
  { id: 72, event_id: 3686, event_title: "Rahul Birthday", event_date: "2026-09-26",
    event_venue: "Main Auditorium", event_status: "closed", title: "Reeler",
    creator_type: null, description: "", required_count: 2,
    interested: 1, assigned: 2, task_deadline: null,
    my_interest: null, my_assignment: null },
  { id: 73, event_id: 3267, event_title: "TechFest 2026", event_date: "2026-09-12",
    event_venue: "Auditorium", event_status: "open", title: "Photo Set",
    creator_type: "photo", description: "", required_count: 3,
    interested: 4, assigned: 1, task_deadline: null,
    my_interest: "interested", my_assignment: null },
];

async function bootOpps(rows: unknown[] = OPPS) {
  const dom = new JSDOM(HTML, {
    url: "http://localhost/api/media-ops/?as=creator#/media/creator/opportunities",
    runScripts: "dangerously", pretendToBeVisual: true,
  });
  const w = dom.window as unknown as { fetch: unknown; eval: (s: string) => unknown };
  w.fetch = async (input: RequestInfo | URL) => {
    const url = String(input);
    const reply = (status: number, body: unknown) =>
      ({ ok: status < 400, status, json: async () => body }) as Response;
    if (url.includes("/api/v1/media/state")) return reply(403, { message: "no" });
    if (url.includes("/creator/state"))
      return reply(200, {
        profile: { user_id: "ui-c", full_name: "Misha Patel", display_name: "Misha Patel",
                   email: "m@x.invalid", creator_role: "creator", status: "active",
                   joined_on: "2026-01-01", team: null, lead: null },
        me: { id: "ui-c" }, teams: [], scope: "self", can_manage_network: false,
      });
    if (url.includes("/creator/opportunities")) return reply(200, { opportunities: rows });
    return reply(200, {});
  };
  await new Promise((r) => setTimeout(r, 120));
  const settle = () => new Promise((r) => setTimeout(r, 60));
  dom.window.location.hash = "#/media/creator/opportunities";
  await settle(); await settle();
  const d = dom.window.document;
  return { dom, d, settle, page: () => (d.querySelector("#page") as HTMLElement)?.innerHTML ?? "" };
}

describe("opportunities grouped by event", () => {
  it("draws one card per event, not one per requirement", async () => {
    const h = await bootOpps();
    /* Three requirements across two events => two cards. */
    expect(h.d.querySelectorAll("#page .card").length).toBe(2);
    expect(h.d.querySelectorAll("#page .opp-row").length).toBe(3);
  });

  it("puts the event name in the card header, once", async () => {
    const h = await bootOpps();
    const heads = [...h.d.querySelectorAll("#page .card-head h3")].map((n) => n.textContent?.trim());
    expect(heads).toEqual(["Rahul Birthday", "TechFest 2026"]);
    /* The old layout printed it again under every requirement. */
    expect((h.page().match(/Rahul Birthday/g) || []).length,
      "the event name is repeated per requirement again").toBe(1);
  });

  it("lists every requirement of an event inside that event's card", async () => {
    const h = await bootOpps();
    const first = h.d.querySelectorAll("#page .card")[0];
    const titles = [...first.querySelectorAll(".opp-row .lr-main b")].map((n) => n.textContent);
    expect(titles).toEqual(["Real creator", "Reeler"]);
  });

  it("shows how many creators are already interested, labelled", async () => {
    const h = await bootOpps();
    const row = h.d.querySelectorAll("#page .opp-row")[0];
    expect(row.textContent).toMatch(/3 interested/);
    /* "0/2" on its own was a fraction of something unstated. */
    expect(row.textContent).toMatch(/0 of 2 filled/);
  });

  it("puts the interest button on the requirement's own line", async () => {
    const h = await bootOpps();
    const rows = h.d.querySelectorAll("#page .opp-row");
    const btn = rows[0].querySelector('[data-act="cnInterest"]') as HTMLElement | null;
    expect(btn, "no interest button on the requirement row").not.toBeNull();
    expect(btn!.getAttribute("data-oid")).toBe("71");
  });

  it("offers no button on a requirement that is already full", async () => {
    const h = await bootOpps();
    const full = h.d.querySelectorAll("#page .opp-row")[1];
    expect(full.textContent).toMatch(/2 of 2 filled/);
    expect(full.querySelector('[data-act="cnInterest"]')).toBeNull();
    expect(full.textContent).toMatch(/Fully assigned/i);
  });

  it("keeps each requirement's own state, inside one shared card", async () => {
    const h = await bootOpps();
    const tech = h.d.querySelectorAll("#page .card")[1];
    expect(tech.textContent).toMatch(/Interested/);
    expect(tech.querySelector('[data-act="cnWithdraw"]')).not.toBeNull();
  });

  it("counts the roles still open in the card header", async () => {
    const h = await bootOpps();
    const cards = h.d.querySelectorAll("#page .card");
    // Rahul Birthday: one of two requirements still has room.
    expect(cards[0].querySelector(".card-head .chip")?.textContent).toMatch(/1 role open/);
  });

  it("says so plainly when an event has no room left anywhere", async () => {
    const h = await bootOpps([{ ...OPPS[1], id: 81, interested: 0, assigned: 2, required_count: 2 }]);
    expect(h.d.querySelector("#page .card-head .chip")?.textContent).toMatch(/All roles filled/i);
  });

  it("still shows the empty state when nothing is published", async () => {
    const h = await bootOpps([]);
    expect(h.page()).toMatch(/Nothing open right now/i);
  });
});
