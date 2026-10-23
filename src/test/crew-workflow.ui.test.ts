/* ═══════════════════════════════════════════════════════════════════════════
   UI — the crew production workflow, as each person sees it.

     Coordinator → Project → Team → Team Lead → Deliverable.owner_id → Employee
       → My Day → Submit → the project's Team Lead reviews

   The real public/media-ops/index.html, in jsdom, with the server replaced by
   a recording fetch. The authority itself is proven against a real database in
   server/mediaops-crew-workflow.integration.test.ts; what is pinned here is
   that the page offers each person exactly what the server will honour:

     · an employee's deliverable reaches their My Day through owner_id alone —
       "My deliverables" always, "Today's assignments" on its scheduled day;
     · a Team Lead is offered their own team, their own team's projects to
       allocate on, and their own team's reviews — not every lead's;
     · nobody is offered a review of their own work, and the board will not
       approve without a version or deliver without an approval.
   ═══════════════════════════════════════════════════════════════════════════ */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const HTML = readFileSync("public/media-ops/index.html", "utf8");

/* People, teams, projects and work — ids far from the seed so nothing collides.
     901 Lead A (Event Team)   902 Emp A1   903 Emp A2
     904 Lead B (Video Team)   905 Emp B1   906 Coordinator   907 Admin        */
const FIXTURES = `
  const P=(id,n,r)=>DB.users.unshift({id,real_id:'zcw-'+id,role:r,full_name:n,initials:'ZZ',color:'#888',is_active:true,designation:''});
  P(901,'Lead Alpha','team_lead'); P(902,'Emp Anika','employee'); P(903,'Emp Arjun','employee');
  P(904,'Lead Bravo','team_lead'); P(905,'Emp Bela','employee'); P(906,'Coord Chitra','coordinator'); P(907,'Admin Dev','admin');
  DB.teams=[{id:9001,name:'Event Team',lead_user_id:901,is_active:true,sort_order:1},
            {id:9002,name:'Video Team',lead_user_id:904,is_active:true,sort_order:2}];
  DB.team_members=[{team_id:9001,user_id:902},{team_id:9001,user_id:903},{team_id:9002,user_id:905}];
  const T=DB.deliverable_types.find(t=>!t.review_exempt)||DB.deliverable_types[0];
  window.__T=T.id;
  const proj=(id,name,team,owner)=>DB.projects.push({id,name,code:'MC-'+id,team_id:team,owner_id:owner,created_by:906,
    project_type_id:DB.project_types[0].id,status:'in_production',priority:'high',academic_unit_id:null,academic_year_id:3,
    start_date:TODAY,end_date:TODAY,description:'',tags:[],deleted_at:null});
  proj(7001,'Annual Cultural Festival',9001,901);
  proj(7002,'Sports Week Teaser',9002,904);
  proj(7003,'Legacy Convocation',null,901);
  DB.project_assignments.push({id:99001,project_id:7001,user_id:901,is_project_manager:true,removed_at:null},
                              {id:99002,project_id:7002,user_id:904,is_project_manager:true,removed_at:null});
  const dl=(id,pid,title,owner,sched,status)=>DB.deliverables.push({id,project_id:pid,deliverable_type_id:T.id,title,
    owner_id:owner,scheduled_date:sched,due_date:TODAY,status:status||'not_started',priority:'normal',deleted_at:null,
    approval_status:'pending',unit:'',quantity_target:null,quantity_delivered:null});
  dl(8001,7001,'Edited Photos',902,TODAY,'in_review');
  dl(8002,7001,'Aftermovie',902,null);
  dl(8003,7001,'Instagram Reel',null,null);
  dl(8004,7002,'Teaser Cut',905,null,'in_review');
  dl(8005,7001,'Archive Data',901,null,'in_review');
  DB.deliverable_versions.push(
    {id:88001,deliverable_id:8001,version_no:1,review_status:'pending',submitted_by:902,submitted_at:TODAY+'T09:00:00Z',drive_url:'https://drive.google.com/a'},
    {id:88004,deliverable_id:8004,version_no:1,review_status:'pending',submitted_by:905,submitted_at:TODAY+'T09:00:00Z',drive_url:'https://drive.google.com/b'},
    {id:88005,deliverable_id:8005,version_no:1,review_status:'pending',submitted_by:907,submitted_at:TODAY+'T09:00:00Z',drive_url:'https://drive.google.com/c'});
`;

async function boot(me: number) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const dom = new JSDOM(HTML, { url: "http://localhost/api/media-ops/#/media/home",
    runScripts: "dangerously", pretendToBeVisual: true });
  const w = dom.window as unknown as { fetch: unknown; eval: (s: string) => unknown; confirm: unknown };
  w.confirm = () => true;
  w.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), method: String(init?.method ?? "GET"),
                 body: init?.body ? JSON.parse(String(init.body)) : null });
    return { ok: true, status: 200, json: async () => ({}) } as Response;
  };
  await new Promise((r) => setTimeout(r, 300));
  const ev = <T,>(e: string) => w.eval(e) as T;
  ev(FIXTURES);
  ev(`S.me=${me}; window.__MO_LIVE__=true;`);
  const as = (id: number) => ev(`S.me=${id}`);
  const writes = () => calls.filter((c) => c.method !== "GET");
  return { dom, ev, as, writes, doc: dom.window.document };
}

describe("My Day — the deliverable IS the work item", () => {
  it("an assigned deliverable is in its owner's My deliverables, scheduled or not", async () => {
    const h = await boot(902);
    const page = h.ev<string>("viewMyDay()");
    expect(page).toContain("Edited Photos");
    expect(page).toContain("Aftermovie");
  });

  it("only the deliverable scheduled for today is in Today's assignments", async () => {
    const h = await boot(902);
    const ids = h.ev<string[]>("myAssignments(902).map(a=>a.id)");
    expect(ids).toContain("d8001");
    expect(ids).not.toContain("d8002");
  });

  it("is nobody else's work — a teammate and an unassigned deliverable stay out", async () => {
    const h = await boot(903);
    expect(h.ev<string[]>("myAssignments(903).map(a=>a.id)").filter((i) => i.startsWith("d80"))).toEqual([]);
    const page = h.ev<string>("viewMyDay()");
    expect(page).not.toContain("Edited Photos");
    expect(page).not.toContain("Instagram Reel");
  });

  it("an employee can open the project of a deliverable they hold", async () => {
    const h = await boot(902);
    expect(h.ev<number[]>("visibleProjects().map(p=>p.id)")).toContain(7001);
    expect(h.ev<number[]>("visibleProjects().map(p=>p.id)")).not.toContain(7002);
  });
});

describe("Team Lead — their own team, their own team's projects", () => {
  it("leads the projects routed to their team, and a legacy project they own", async () => {
    const h = await boot(901);
    expect(h.ev<boolean[]>("[7001,7002,7003].map(id=>leadsProject(proj(id)))")).toEqual([true, false, true]);
    h.as(904);
    expect(h.ev<boolean[]>("[7001,7002,7003].map(id=>leadsProject(proj(id)))")).toEqual([false, true, false]);
  });

  it("New project offers a lead only their own team, already chosen", async () => {
    const h = await boot(901);
    h.ev("openNewProject()");
    const opts = [...h.doc.querySelectorAll("#np-team option")].map((o) => (o as HTMLOptionElement).value);
    expect(opts).toEqual(["9001"]);
  });

  it("New project offers the Coordinator every team, and does not create one without a team", async () => {
    const h = await boot(906);
    h.ev("openNewProject()");
    const sel = h.doc.querySelector("#np-team") as HTMLSelectElement;
    const opts = [...sel.options].map((o) => o.value);
    expect(opts).toEqual(["", "9001", "9002"]);
    expect(sel.value, "a team (or no team) was chosen for the Coordinator").toBe("");
    expect(sel.options[0].disabled, "'no team' is still a choice").toBe(true);
    (h.doc.querySelector("#np-name") as HTMLInputElement).value = "Convocation 2026";
    h.ev("ACTIONS.createProject()");
    expect(h.writes().some((c) => c.url.endsWith("/projects")), "created with no team").toBe(false);
    expect(h.doc.querySelector("#np-team-err")?.textContent).toBe("Choose the team this project is for.");
    sel.value = "9002";
    h.ev("ACTIONS.createProject()");
    const post = h.writes().find((c) => c.url.endsWith("/projects"));
    expect(post?.body).toMatchObject({ team_id: 9002, academic_year_id: expect.any(Number) });
  });

  it("New project asks Admin for a team too, with 'no team' as a deliberate choice", async () => {
    const h = await boot(907);
    h.ev("openNewProject()");
    const sel = h.doc.querySelector("#np-team") as HTMLSelectElement;
    expect([...sel.options].map((o) => o.value)).toEqual(["", "9001", "9002", "none"]);
    expect(sel.value).toBe("");
    (h.doc.querySelector("#np-name") as HTMLInputElement).value = "Convocation 2026";
    h.ev("ACTIONS.createProject()");
    expect(h.writes().some((c) => c.url.endsWith("/projects"))).toBe(false);
    sel.value = "none";
    h.ev("ACTIONS.createProject()");
    expect(h.writes().find((c) => c.url.endsWith("/projects"))?.body).toMatchObject({ team_id: null });
  });

  it("New project: one help line per role, no internal codes, types in catalogue order, priorities most urgent first", async () => {
    const h = await boot(906);
    const help = () => { h.ev("openNewProject()"); return h.doc.querySelector("#modal-layer .mo-head p")!.textContent; };
    expect(help()).toMatch(/team’s lead .* assigns the work/);
    h.as(901); expect(help()).toBe("It is for your team. You assign the work after creating it.");
    h.as(902); expect(help()).toBe("It is your own project. You assign the work after creating it.");
    h.as(906); help();
    h.ev("ACTIONS.npAddDeliverable(); ACTIONS.npAddDeliverable()");
    const layer = h.doc.getElementById("modal-layer")!;
    expect(layer.textContent).not.toMatch(/Team Lead will assign|Team Lead’s call|lead will assign/);
    const typeIds = [...layer.querySelectorAll(".np-d-type option")].slice(0, 99).map((o) => +(o as HTMLOptionElement).value);
    const order = h.ev<number[]>("DB.deliverable_types.filter(t=>t.is_active!==false&&!t.archived_at).sort((a,b)=>(a.sort_order??0)-(b.sort_order??0)||a.id-b.id).map(t=>t.id)");
    expect(typeIds.slice(0, order.length)).toEqual(order);
    expect([...layer.querySelectorAll("#np-pri option")].map((o) => (o as HTMLOptionElement).value)).toEqual(["urgent", "high", "normal", "low"]);
    expect((layer.querySelector("#np-pri") as HTMLSelectElement).value).toBe("normal");
    const name = layer.querySelector("#np-name") as HTMLInputElement;
    name.value = "Annual Cultural Festival";
    h.ev("ACTIONS.dupCheck({},document.querySelector('#np-name'))");
    const warn = layer.querySelector("#np-dup")!.textContent!;
    expect(warn).toContain("Annual Cultural Festival");
    expect(warn).not.toMatch(/AUTO-\d/);
  });

  it("New project is offered to an employee, assigned to them, with no team to pick", async () => {
    const h = await boot(902);
    expect(h.ev<boolean>("can('project.create')")).toBe(true);
    h.ev("openNewProject()");
    expect(h.doc.querySelectorAll("#np-team option").length, "an employee was offered teams").toBe(0);
    expect((h.doc.getElementById("np-team") as HTMLInputElement).value).toBe("");
    const layer = h.doc.getElementById("modal-layer")!.innerHTML;
    expect(layer).toContain("your own project");
    expect(layer).not.toContain("Pending Approval");
  });

  /* Assigning is not limited by team (product decision, Oct 2026): a lead picks
     from the whole crew, on any project. Running another team's project —
     its schedule and dates — is still that team's lead's. */
  it("allocates a deliverable to anyone in the crew — another team included — and can reassign it", async () => {
    const h = await boot(901);
    const cell = h.ev<string>("delivOwnerCell(proj(7001),deliv(8003))");
    for (const id of ["902", "903", "905"]) expect(cell).toContain(`value="${id}"`);
    expect(h.ev<string>("delivOwnerCell(proj(7001),deliv(8002))")).toMatch(/value="902" selected/);
  });

  it("assigns on another team's project, but does not run it", async () => {
    const h = await boot(904);
    expect(h.ev<string>("delivOwnerCell(proj(7001),deliv(8003))")).toContain("<select");
    expect(h.ev<boolean>("canAssignOn(proj(7001))")).toBe(true);
    expect(h.ev<boolean>("canScheduleWork(proj(7001))")).toBe(false);
    expect(h.ev<boolean>("canEditDueDates(proj(7001))")).toBe(false);
  });

  it("'My team' narrows Projects to the team's projects", async () => {
    const h = await boot(901);
    h.ev("projectFilters().mine=true; projectFilters().year=null;");
    const ids = h.ev<number[]>("filteredProjects().map(p=>p.id)");
    expect(ids).toContain(7001);
    expect(ids).not.toContain(7002);
  });
});

describe("Notifications — clickable, routed and segmented for leads", () => {
  it("notifTarget routes every entity_type the server writes", async () => {
    const h = await boot(901);
    // Server-side entity_types we must route: project, deliverable, deliverable_version,
    // shoot, equipment, maintenance, daily_report, report, leave_request, request,
    // casting_request, assignment, team, kra, user.
    const cases: Array<[string, number | null, string | ((t: string) => boolean)]> = [
      ["project", 7001, "#/media/projects/7001"],
      ["deliverable", 8001, (t) => t.includes("drawer")],
      ["shoot", 1, (t) => t.includes("drawer")],
      ["daily_report", 1, "#/media/reports"],
      ["report", 1, "#/media/reports"],
      ["leave_request", 1, "#/media/leave"],
      ["request", 1, "#/media/requests"],
      ["casting_request", 1, "#/media/casting"],
      ["team", 9001, "#/media/team"],
      ["kra", 1, "#/media/performance"],
      ["maintenance", 1, "#/media/equipment"],
    ];
    for (const [entity_type, entity_id, expected] of cases) {
      const t = h.ev<Record<string, unknown> | null>(`notifTarget({entity_type:'${entity_type}',entity_id:${entity_id}})`);
      expect(t, `${entity_type} returned no target`).toBeTruthy();
      if (typeof expected === "string") expect(t!.hash).toBe(expected);
      else expect(expected(Object.keys(t!).join(","))).toBe(true);
    }
  });

  it("notifSource classifies notifications by role of their sender", async () => {
    const h = await boot(901);
    const assign = (nk: string, et: string, title = "") =>
      h.ev<string>(`notifSource({kind:'${nk}',entity_type:'${et}',title:'${title}'})`);
    expect(assign("assignment", "project", "You are leading a new project")).toBe("coord");
    // Being put on a project's crew is a lead's or teammate's doing — the Coordinator never assigns.
    expect(assign("assignment", "project", "You are on a project")).toBe("team");
    expect(assign("assignment", "team")).toBe("coord");
    expect(assign("assignment", "deliverable")).toBe("team");  // from a teammate (the lead)
    expect(assign("review", "deliverable")).toBe("team");
    expect(assign("overdue", "deliverable")).toBe("auto");
    expect(assign("reminder", "deliverable")).toBe("auto");
    expect(assign("approval", "deliverable")).toBe("auto");
    expect(assign("casting", "casting_request")).toBe("coord");
    expect(assign("deliverable", "deliverable")).toBe("coord");  // dispatched
  });

  it("a Team Lead's notifications are segmented into Admin/Coordinator vs team vs automations", async () => {
    const h = await boot(901);
    // Seed three notifications for leadA, one in each source bucket.
    h.ev(`DB.notifications=[
      {id:1,user_id:901,kind:'assignment',entity_type:'project',entity_id:7001,title:'You are leading a new project',body:'routed to you',created_at:TODAY+'T09:00:00Z',is_read:false},
      {id:2,user_id:901,kind:'review',entity_type:'deliverable',entity_id:8001,title:'Version submitted',body:'empA1 submitted v1',created_at:TODAY+'T10:00:00Z',is_read:false},
      {id:3,user_id:901,kind:'overdue',entity_type:'deliverable',entity_id:8002,title:'Deliverable overdue',body:'Aftermovie was due',created_at:TODAY+'T11:00:00Z',is_read:false},
    ];`);
    const page = h.ev<string>("viewNotifications()");
    expect(page).toContain("From Admin");    // ampersand is HTML-escaped as &amp; — match on the prefix
    expect(page).toContain("Coordinator");
    expect(page).toContain("From your team");
    expect(page).toContain("Automations");
    // The three cards each hold their own notification.
    expect(page).toContain("You are leading a new project");
    expect(page).toContain("Version submitted");
    expect(page).toContain("Deliverable overdue");
    // Today's brief line names the coord bucket's count.
    expect(page).toContain("Today's brief");
  });

  it("employees see one list (no segmentation), because employees only receive one or two kinds", async () => {
    const h = await boot(902);
    h.ev(`DB.notifications=[
      {id:9,user_id:902,kind:'assignment',entity_type:'deliverable',entity_id:8001,title:'New assignment',body:'Edited Photos was assigned to you',created_at:TODAY+'T09:00:00Z',is_read:false},
    ];`);
    const page = h.ev<string>("viewNotifications()");
    expect(page).not.toContain("From Admin");
    expect(page).toContain("New assignment");
  });

  it("clicking a notification marks it read and navigates", async () => {
    const h = await boot(901);
    h.ev(`DB.notifications=[
      {id:1,user_id:901,kind:'assignment',entity_type:'project',entity_id:7001,title:'go',body:'',created_at:TODAY+'T09:00:00Z',is_read:false},
    ];`);
    h.ev(`ACTIONS.openNotif({nid:1})`);
    expect(h.dom.window.location.hash).toBe("#/media/projects/7001");
    expect(h.ev<boolean>("DB.notifications[0].is_read")).toBe(true);
    // And one write back to the server.
    expect(h.writes().some((c) => c.url.endsWith("/notifications/read"))).toBe(true);
  });

  it("a notification with the server's string ids still opens, and is marked read", async () => {
    const h = await boot(902);
    // pg sends BIGINT columns as strings; /state hands them over as they come.
    const n = h.ev<{ id: unknown; entity_id: unknown; user_id: unknown }>(
      `normNotif({id:'43534',user_id:902,kind:'assignment',entity_type:'deliverable',entity_id:'8001',title:'Editing assigned to you',body:'',created_at:TODAY+'T09:00:00Z',is_read:false})`);
    expect(n).toMatchObject({ id: 43534, entity_id: 8001, user_id: 902 });
    // And a raw string row (an older server, or anything not normalised) is still found by its id.
    h.ev(`DB.notifications=[{id:'43534',user_id:902,kind:'assignment',entity_type:'deliverable',entity_id:'8001',title:'Editing assigned to you',body:'',created_at:TODAY+'T09:00:00Z',is_read:false}]`);
    h.ev(`ACTIONS.openNotif({nid:'43534'})`);
    expect(h.ev<boolean>("DB.notifications[0].is_read")).toBe(true);
    expect(h.doc.getElementById("drawer")!.classList.contains("on")).toBe(true);
    expect(h.doc.getElementById("drawer")!.textContent).toContain("Edited Photos");
    const read = h.writes().find((c) => c.url.endsWith("/notifications/read"));
    expect(read?.body).toEqual({ id: "43534" });
  });

  it("each notice opens what it is about: the deliverable its work is on, or its project", async () => {
    const h = await boot(901);
    h.ev(`DB.assignments=[{id:'61',project_id:'7001',deliverable_id:8002,title:'Edit'},{id:'62',project_id:'7002',deliverable_id:null,title:'Recce'}]`);
    const keys = (e: string) => Object.keys(h.ev<Record<string, unknown>>(`notifTarget(${e})`) || {}).join(",");
    expect(keys(`{entity_type:'assignment',entity_id:'61'}`)).toBe("drawer");
    expect(h.ev<string>(`notifTarget({entity_type:'assignment',entity_id:'62'}).hash`)).toBe("#/media/projects/7002");
    // A deliverable this page has not loaded goes to its project when the notice names one.
    expect(h.ev<string>(`notifTarget({entity_type:'deliverable',entity_id:999999,project_id:7001}).hash`)).toBe("#/media/projects/7001");
    h.ev(`DB.notifications=[{id:5,user_id:901,kind:'assignment',entity_type:'assignment',entity_id:'61',title:'Edit assigned to you',body:'',created_at:TODAY+'T09:00:00Z',is_read:false}]`);
    h.ev(`ACTIONS.openNotif({nid:'5'})`);
    expect(h.doc.getElementById("drawer")!.textContent).toContain("Aftermovie");
  });

  it("says minutes or hours ago for today, and 'Yesterday' only for the day before", async () => {
    const h = await boot(902);
    const tz = process.env.TZ;
    process.env.TZ = "Asia/Kolkata";   // 05:30 ahead of the server's UTC stamps
    try {
      // 00:01 here today is 18:31 UTC yesterday — the stamp the old label read as "Yesterday".
      const when = (localExpr: string) =>
        h.ev<string>(`(()=>{const t=new Date();${localExpr};return notifWhen({created_at:t.toISOString()});})()`);
      const earlyToday = when("t.setHours(0,1,0,0)");
      expect(earlyToday).toMatch(/^(just now|\d+m ago|\d+h ago)$/);
      expect(when("t.setMinutes(t.getMinutes()-11)")).toMatch(/^(11m ago|Yesterday, \d\d:\d\d)$/);
      expect(when("t.setDate(t.getDate()-1);t.setHours(23,0,0,0)")).toBe("Yesterday, 23:00");
      expect(when("t.setDate(t.getDate()-2);t.setHours(12,0,0,0)")).not.toContain("Yesterday");
    } finally {
      if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz;
    }
  });

  it("the bell shows the server's unread count, and each row names its project", async () => {
    const h = await boot(902);
    h.ev(`DB.notifications=[
      {id:1,user_id:902,kind:'assignment',entity_type:'deliverable',entity_id:8001,project_name:'Annual Cultural Festival',title:'Photos assigned to you',body:'',created_at:TODAY+'T09:00:00Z',is_read:false},
      {id:2,user_id:902,kind:'assignment',entity_type:'deliverable',entity_id:8004,title:'Photos assigned to you',body:'',created_at:TODAY+'T09:00:00Z',is_read:false}];
      DB.notifications_unread=120; paintBell();`);
    expect(h.doc.getElementById("bell-count")!.textContent).toBe("120");
    h.ev(`ACTIONS.openNotif({nid:1})`);
    expect(h.doc.getElementById("bell-count")!.textContent).toBe("119");
    // Without the server's count, the rows held are counted.
    h.ev(`DB.notifications_unread=null; paintBell();`);
    expect(h.doc.getElementById("bell-count")!.textContent).toBe("1");
    const page = h.ev<string>("viewNotifications()");
    expect(page).toContain("Annual Cultural Festival");
    expect(page).toContain("Sports Week Teaser");   // named from the deliverable this page holds
  });

  it("the page offers no switches that do nothing, and promises no push or email", async () => {
    const h = await boot(901);
    h.ev(`DB.notifications=[{id:1,user_id:901,kind:'review',entity_type:'deliverable',entity_id:8001,title:'Version submitted',body:'',created_at:TODAY+'T09:00:00Z',is_read:false}]`);
    const page = h.ev<string>("viewNotifications()");
    expect(page).not.toMatch(/class="switch/);
    expect(page).not.toMatch(/push|e-?mail|WhatsApp/i);
  });

  it("new notices reach the bell without a reload — on returning to the window", async () => {
    const h = await boot(902);
    const w = h.dom.window as unknown as { fetch: unknown };
    const gets: string[] = [];
    w.fetch = async (input: RequestInfo | URL) => {
      gets.push(String(input));
      return { ok: true, status: 200, json: async () => (String(input).endsWith("/notifications")
        ? { notifications: [{ id: "77", user_id: "real-uuid", kind: "review", entity_type: "deliverable", entity_id: "8001",
            title: "Changes requested", body: "", created_at: new Date().toISOString(), is_read: false }], unread: 3 }
        : {}) } as Response;
    };
    h.dom.window.dispatchEvent(new h.dom.window.Event("focus"));
    await new Promise((r) => setTimeout(r, 20));
    expect(gets.some((u) => u.endsWith("/notifications"))).toBe(true);
    expect(h.ev<unknown>("DB.notifications[0].id")).toBe(77);
    expect(h.ev<unknown>("DB.notifications[0].user_id")).toBe(902);
    expect(h.doc.getElementById("bell-count")!.textContent).toBe("3");
  });
});

/* Product decision (Oct 2026): ANY Team Lead approves, on any project. The
   Coordinator and employees never do, and nobody approves their own work. */
describe("Review — any Team Lead, never your own work", () => {
  it("every lead's queue holds every team's submissions — except their own", async () => {
    const h = await boot(901);
    let q = h.ev<number[]>("pendingVersionReviews().map(x=>x.d.id)");
    expect(q).toContain(8001);
    expect(q).toContain(8004);            // Team B's
    expect(q).not.toContain(8005);        // their own
    h.as(904);
    q = h.ev<number[]>("pendingVersionReviews().map(x=>x.d.id)");
    for (const id of [8001, 8004, 8005]) expect(q).toContain(id);   // Team A's, their own team's, 901's
    h.as(902);
    expect(h.ev<number[]>("pendingVersionReviews().map(x=>x.d.id)")).toEqual([]);
    h.as(906);
    expect(h.ev<number[]>("pendingVersionReviews().map(x=>x.d.id)")).toEqual([]);
  });

  it("the drawer offers Approve to every Team Lead — not to employees or the Coordinator", async () => {
    const h = await boot(901);
    h.ev("drawerDeliverable(8001)");
    expect(h.doc.getElementById("drawer")!.innerHTML).toContain('data-act="approveVersion"');
    h.as(904);
    h.ev("drawerDeliverable(8001)");
    expect(h.doc.getElementById("drawer")!.innerHTML, "another team's lead was not offered Approve").toContain('data-act="approveVersion"');
    for (const who of [902, 906]) {
      h.as(who);
      h.ev("drawerDeliverable(8001)");
      expect(h.doc.getElementById("drawer")!.innerHTML, `user ${who} was offered Approve`).not.toContain('data-act="approveVersion"');
    }
  });

  it("a lead is not offered Approve on a deliverable they own", async () => {
    const h = await boot(901);
    h.ev("drawerDeliverable(8005)");
    expect(h.doc.getElementById("drawer")!.innerHTML).not.toContain('data-act="approveVersion"');
  });

  it("the board refuses the Coordinator, an owner, a missing version and an unapproved delivery", async () => {
    const h = await boot(906);
    expect(h.ev<boolean>("applyDelivStatus(deliv(8001),'approved')")).toBe(false);
    h.as(901);
    expect(h.ev<boolean>("applyDelivStatus(deliv(8005),'approved')")).toBe(false);   // own deliverable
    h.ev("deliv(8003).status='in_review'");
    expect(h.ev<boolean>("applyDelivStatus(deliv(8003),'approved')")).toBe(false);   // no version
    h.as(902);
    h.ev("deliv(8002).status='in_progress'");
    expect(h.ev<boolean>("applyDelivStatus(deliv(8002),'delivered')")).toBe(false);  // never reviewed
    expect(h.writes().filter((c) => c.url.includes("/status")), "a refused move still reached the server").toEqual([]);
  });

  it("the board lets any Team Lead approve a submitted version — another team's included", async () => {
    const h = await boot(904);
    expect(h.ev<boolean>("applyDelivStatus(deliv(8001),'approved')")).toBe(true);
    // The board's Approved is the approve path itself — the version is approved, not just the status.
    const w = h.writes().find((c) => c.url.endsWith("/deliverables/8001/review"));
    expect(w?.body).toEqual({ outcome: "approved" });
  });

  it("the project status menu lets another team's lead approve a proposal — and nothing else", async () => {
    const h = await boot(904);
    h.ev("proj(7001).status='proposed'");
    expect(h.ev<string[]>("MENUS.projStatus({pid:'7001'}).filter(i=>i.label).map(i=>i.label)")).toEqual(["Approved"]);
    h.ev("proj(7001).status='in_production'");
    expect(h.ev<string[]>("MENUS.projStatus({pid:'7001'}).filter(i=>i.label).map(i=>i.label)")).toEqual([]);
    h.as(901);   // the project's own lead runs it
    expect(h.ev<string[]>("MENUS.projStatus({pid:'7001'}).filter(i=>i.label).length")).toBeGreaterThan(0);
  });
});

/* ── Assign work is where deliverables are made ──────────────────────────────
   One button on a project, not two. Assign work creates the deliverable the
   work produces (or takes on one already on the project), and everyone the lead
   picks works on it: it is in each of their My Days, not only the owner's. */
describe("Assign work — creates the deliverable and shares it with everyone assigned", () => {
  /* Fill and submit the dialog the way a lead would. */
  async function openFor(h: Awaited<ReturnType<typeof boot>>, pid: number) {
    h.ev(`openAssignWork(${pid})`);
    const doc = h.doc;
    const pick = (uid: number) => (doc.querySelector(`#aw-users .chip[data-uid="${uid}"]`) as HTMLElement).click();
    return { doc, pick };
  }

  it("the project offers Assign work only — no separate + Deliverable button", async () => {
    const h = await boot(901);
    const page = h.ev<string>("viewProject(7001,'overview')");
    expect(page).toContain('data-act="assignWork"');
    expect(page, "the project header still offers + Deliverable").not.toContain("Deliverable</button>");
    const tab = h.ev<string>("viewProject(7001,'deliverables')");
    expect(tab).not.toContain('data-act="newDeliverable"');
    expect(tab).toContain('data-act="assignWork"');
    expect(h.ev<boolean>("typeof openNewDeliverable==='undefined'")).toBe(true);
  });

  it("is offered to every Team Lead and to employees on the project — not the Coordinator, not someone off it", async () => {
    const h = await boot(904);   // another team's lead
    expect(h.ev<string>("viewProject(7001,'overview')")).toContain('data-act="assignWork"');
    h.as(906);                   // the Coordinator routes, never assigns
    expect(h.ev<string>("viewProject(7001,'overview')")).not.toContain('data-act="assignWork"');
    h.as(905);                   // an employee who is not on 7001
    expect(h.ev<boolean>("canAssignOn(proj(7001))")).toBe(false);
    h.ev("DB.project_assignments.push({id:99009,project_id:7001,user_id:905,is_project_manager:false,removed_at:null})");
    expect(h.ev<boolean>("canAssignOn(proj(7001))")).toBe(true);   // now on its crew
    expect(h.ev<string>("viewProject(7001,'overview')")).toContain('data-act="assignWork"');
  });

  it("an employee on a project picks from the whole crew; the Coordinator picks nobody but themselves", async () => {
    const h = await boot(903);
    const ids = h.ev<number[]>("assignableMembers().map(u=>u.id)");
    for (const id of [901, 902, 904, 905]) expect(ids).toContain(id);
    h.as(906);
    expect(h.ev<number[]>("assignableMembers().map(u=>u.id)")).toEqual([906]);
  });

  it("crew buttons: another team's lead may add crew, but removing crew and editing shoots stay with the project's lead", async () => {
    const h = await boot(904);
    const page = h.ev<string>("viewProject(7001,'overview')");
    expect(page).toContain('data-act="assignCrew"');
    expect(page, "another team's lead was offered Remove from project").not.toContain("Remove from project");
    h.as(901);
    expect(h.ev<string>("viewProject(7001,'overview')")).toContain('data-act="assignCrew"');
  });

  it("'Assign to project' on a person's page now works: it adds them to the chosen project", async () => {
    const h = await boot(901);
    const page = h.ev<string>("viewTeamMember(905)");
    expect(page).toMatch(/data-act="assignMemberToProject" data-uid="905"/);
    h.ev("ACTIONS.assignMemberToProject({uid:'905'})");
    const sel = h.doc.querySelector("#amp-project") as HTMLSelectElement;
    expect(sel, "no project picker opened").not.toBeNull();
    sel.value = "7001";
    h.ev("ACTIONS.confirmMemberToProject({uid:'905'})");
    const post = h.writes().find((c) => c.url.endsWith("/projects/7001/assignments"));
    expect(post?.body).toEqual({ user_id: "zcw-905" });
  });

  it("opened from a project, the project is fixed and a new deliverable is the default", async () => {
    const h = await boot(901);
    const { doc } = await openFor(h, 7001);
    const projField = doc.querySelector("#aw-project") as HTMLInputElement;
    expect(projField.type).toBe("hidden");
    expect(projField.value).toBe("7001");
    expect(doc.querySelector("#modal-layer select#aw-project"), "the project is still a choice").toBeNull();
    expect((doc.querySelector("#aw-dmode button.on") as HTMLElement).dataset.m).toBe("new");
    expect((doc.querySelector("#aw-dnew") as HTMLElement).hidden).toBe(false);
    expect(doc.querySelector("#aw-dtype")).not.toBeNull();
    // The Drive link follows the form convention: a URL keyboard, the type untouched.
    const drive = doc.querySelector("#aw-ddrive") as HTMLInputElement;
    expect(drive.getAttribute("inputmode")).toBe("url");
    expect(drive.type).not.toBe("url");
  });

  it("the owner is one of the people picked, and follows the selection", async () => {
    const h = await boot(901);
    const { doc, pick } = await openFor(h, 7001);
    const owner = () => doc.querySelector("#aw-owner") as HTMLSelectElement;
    expect(owner().disabled).toBe(true);
    pick(902); pick(903);
    expect([...owner().options].map((o) => o.value)).toEqual(["902", "903"]);
    expect(owner().value).toBe("902");
    owner().value = "903";
    pick(902);   // un-pick the first: the owner they chose stays
    expect(owner().value).toBe("903");
    expect([...owner().options].map((o) => o.value)).toEqual(["903"]);
  });

  it("sends one request that creates the deliverable, owned by the pick, for everyone assigned", async () => {
    const h = await boot(901);
    const { doc, pick } = await openFor(h, 7001);
    (doc.querySelector("#aw-title") as HTMLInputElement).value = "Edit the aftermovie";
    (doc.querySelector("#aw-ddrive") as HTMLInputElement).value = "https://drive.google.com/folder";
    pick(902); pick(903);
    (doc.querySelector("#aw-owner") as HTMLSelectElement).value = "903";
    h.ev("ACTIONS.createWork()");
    const post = h.writes().find((c) => c.url.endsWith("/projects/7001/work"));
    expect(post, "no Assign work request").toBeTruthy();
    const body = post!.body as Record<string, unknown>;
    expect(body.assignees).toEqual(["zcw-902", "zcw-903"]);
    expect(body.owner_id).toBe("zcw-903");
    expect(body.new_deliverable).toEqual({ deliverable_type_id: expect.any(Number), drive_url: "https://drive.google.com/folder" });
    expect(doc.querySelector("#aw-dtitle"), "a second title field for the deliverable").toBeNull();
    expect(body.deliverable_id).toBeUndefined();
    expect(h.writes().some((c) => c.url.includes("/deliverables") && c.method === "POST"
      && c.url.endsWith("/projects/7001/deliverables")), "a second, separate create was sent").toBe(false);
  });

  it("refuses a Drive link that is not Google Drive, before asking the server", async () => {
    const h = await boot(901);
    const { doc, pick } = await openFor(h, 7001);
    (doc.querySelector("#aw-title") as HTMLInputElement).value = "Edit";
    (doc.querySelector("#aw-ddrive") as HTMLInputElement).value = "https://example.com/x";
    pick(902);
    h.ev("ACTIONS.createWork()");
    expect(h.writes().some((c) => c.url.endsWith("/work"))).toBe(false);
  });

  it("can take on a deliverable already on the project instead of making a second one", async () => {
    const h = await boot(901);
    const { doc, pick } = await openFor(h, 7001);
    h.ev("ACTIONS.awDelivMode({m:'existing'})");
    expect((doc.querySelector("#aw-dnew") as HTMLElement).hidden).toBe(true);
    (doc.querySelector("#aw-deliv") as HTMLSelectElement).value = "8003";   // Instagram Reel, unassigned
    (doc.querySelector("#aw-title") as HTMLInputElement).value = "Cut the reel";
    pick(903);
    h.ev("ACTIONS.createWork()");
    const body = h.writes().find((c) => c.url.endsWith("/projects/7001/work"))!.body as Record<string, unknown>;
    expect(body.deliverable_id).toBe(8003);
    expect(body.new_deliverable).toBeUndefined();
    expect(body.owner_id).toBe("zcw-903");
  });

  it("taking on an existing deliverable starts at its due date and says who owns it now", async () => {
    const h = await boot(901);
    h.ev("deliv(8002).due_date='2026-12-05'");
    const { doc, pick } = await openFor(h, 7001);
    h.ev("ACTIONS.awDelivMode({m:'existing'})");
    const sel = doc.querySelector("#aw-deliv") as HTMLSelectElement;
    sel.value = "8002";
    h.ev("ACTIONS.awDelivPick()");
    expect((doc.querySelector("#aw-due") as HTMLInputElement).value).toBe("2026-12-05");
    expect(doc.querySelector("#aw-dcur")!.textContent).toContain("Emp Anika · Event Team");
    sel.value = "8003";   // unowned, no due date of its own
    h.ev("deliv(8003).due_date=null; ACTIONS.awDelivPick()");
    expect((doc.querySelector("#aw-due") as HTMLInputElement).value).toBe("");
    expect(doc.querySelector("#aw-dcur")!.textContent).toBe("No owner yet.");
    // A date the lead typed is theirs: picking another deliverable keeps it.
    (doc.querySelector("#aw-due") as HTMLInputElement).value = "2026-11-30";
    sel.value = "8002"; h.ev("ACTIONS.awDelivPick()");
    expect((doc.querySelector("#aw-due") as HTMLInputElement).value).toBe("2026-11-30");
    (doc.querySelector("#aw-title") as HTMLInputElement).value = "Cut it";
    pick(903);
    // Emp Arjun in Emp Anika's place is a reassignment, confirmed first.
    const done = h.ev<Promise<unknown>>("ACTIONS.createWork()");
    (doc.querySelector('#rsg-layer [data-rsg="yes"]') as HTMLElement).click();
    await done;
    expect(h.ev<string>("deliv(8002).due_date"), "the deliverable is due when the work is due").toBe("2026-11-30");
  });

  it("people are told apart by their team, and priorities run most urgent first", async () => {
    const h = await boot(901);
    h.ev("DB.users.unshift({id:908,real_id:'zcw-908',role:'employee',full_name:'Emp Anika',initials:'ZZ',color:'#888',is_active:true,designation:''}); DB.team_members.push({team_id:9002,user_id:908})");
    const { doc, pick } = await openFor(h, 7001);
    const chip = (uid: number) => doc.querySelector(`#aw-users .chip[data-uid="${uid}"]`)!.textContent;
    expect(chip(902)).toBe("Emp Anika · Event Team");
    expect(chip(908)).toBe("Emp Anika · Video Team");
    pick(902); pick(908);
    expect([...(doc.querySelector("#aw-owner") as HTMLSelectElement).options].map((o) => o.text))
      .toEqual(["Emp Anika · Event Team", "Emp Anika · Video Team"]);
    expect([...doc.querySelectorAll("#aw-pri option")].map((o) => (o as HTMLOptionElement).value)).toEqual(["urgent", "high", "normal", "low"]);
    expect((doc.querySelector("#aw-pri") as HTMLSelectElement).value).toBe("normal");
    const cell = h.ev<string>("delivOwnerCell(proj(7001),deliv(8002))");
    expect(cell).toContain("Emp Anika · Event Team");
    expect(cell).toContain("Emp Anika · Video Team");
    expect(cell).not.toMatch(/your team/);
  });

  it("a completed project is not offered Assign work, and never opens on another project", async () => {
    const h = await boot(901);
    h.ev("proj(7001).status='completed'");
    for (const tab of ["overview", "deliverables", "shoots"])
      expect(h.ev<string>(`viewProject(7001,'${tab}')`), tab).not.toContain('data-act="assignWork" data-pid');
    h.ev("openAssignWork(7001)");
    expect(h.doc.querySelector("#aw-project"), "the dialog opened on a different project").toBeNull();
    h.ev("proj(7001).status='in_production'");
    expect(h.ev<string>("viewProject(7001,'overview')")).toContain('data-act="assignWork" data-pid="7001"');
  });

  it("from the Shoots tab, Assign work opens on a shoot", async () => {
    const h = await boot(901);
    expect(h.ev<string>("viewProject(7001,'shoots')")).toMatch(/data-act="assignWork" data-pid="7001" data-tpl="shoot"/);
    h.ev("ACTIONS.assignWork({pid:'7001',tpl:'shoot'})");
    const type = h.doc.querySelector("#aw-type") as HTMLSelectElement;
    expect(h.ev<string>(`workType(${type.value}).form_template`)).toBe("shoot");
    expect(h.doc.querySelector("#aw-date"), "the shoot fields are not shown").not.toBeNull();
  });

  it("the owner picker stays when the owner has been deactivated", async () => {
    const h = await boot(901);
    h.ev("user(902).is_active=false");
    const cell = h.ev<string>("delivOwnerCell(proj(7001),deliv(8002))");
    expect(cell).toContain('class="inp deliv-owner"');
    expect(cell).toMatch(/value="902" selected disabled>Emp Anika · Event Team \(inactive\)/);
  });

  it("saving a schedule never makes someone the owner by default", async () => {
    const h = await boot(901);
    h.ev("ACTIONS.scheduleDeliv({did:'8003'})");   // Instagram Reel, unowned
    const sel = h.doc.querySelector("#sd-owner") as HTMLSelectElement;
    expect(sel.value, "a person was preselected").toBe("");
    (h.doc.querySelector("#sd-date") as HTMLInputElement).value = "2026-11-02";
    h.ev("ACTIONS.confirmSchedule({did:'8003'})");
    expect(h.writes().some((c) => c.url.endsWith("/schedule")), "scheduled with nobody to do it").toBe(false);
    expect(h.ev<unknown>("deliv(8003).owner_id")).toBeNull();
    // With no date it saves, and still names nobody.
    (h.doc.querySelector("#sd-date") as HTMLInputElement).value = "";
    h.ev("ACTIONS.confirmSchedule({did:'8003'})");
    const body = h.writes().find((c) => c.url.endsWith("/deliverables/8003/schedule"))!.body as Record<string, unknown>;
    expect(body.owner_id).toBeUndefined();
    expect(h.ev<unknown>("deliv(8003).owner_id")).toBeNull();
    // An owned one keeps its owner without sending it again.
    h.ev("ACTIONS.scheduleDeliv({did:'8002'})");
    (h.doc.querySelector("#sd-date") as HTMLInputElement).value = "2026-11-02";
    h.ev("ACTIONS.confirmSchedule({did:'8002'})");
    const b2 = h.writes().find((c) => c.url.endsWith("/deliverables/8002/schedule"))!.body as Record<string, unknown>;
    expect(b2).toMatchObject({ scheduled_date: "2026-11-02" });
    expect(b2.owner_id).toBeUndefined();
  });

  it("with No deliverable, it is plain work and names no owner", async () => {
    const h = await boot(901);
    const { doc, pick } = await openFor(h, 7001);
    h.ev("ACTIONS.awDelivMode({m:'none'})");
    expect((doc.querySelector("#aw-ownerf") as HTMLElement).hidden).toBe(true);
    (doc.querySelector("#aw-title") as HTMLInputElement).value = "Team meeting";
    pick(902);
    h.ev("ACTIONS.createWork()");
    const body = h.writes().find((c) => c.url.endsWith("/projects/7001/work"))!.body as Record<string, unknown>;
    expect(body.new_deliverable).toBeUndefined();
    expect(body.deliverable_id).toBeUndefined();
    expect(body.owner_id).toBeUndefined();
  });

  /* A deliverable worked on by two people: 8002 is owned by 902, and the work
     row assigned by the lead names both 902 and 903. */
  const SHARED = `DB.assignments.push({id:77001,project_id:7001,work_type_id:DB.work_types[0].id,deliverable_id:8002,
    title:'Edit the aftermovie',assigned_by:901,priority:'normal',status:'not_started',start_date:TODAY,due_date:TODAY,
    assignees:[902,903]});`;

  it("is in a teammate's My Day, marked whose it is, with Submit — not only the owner's", async () => {
    const h = await boot(903);
    h.ev(SHARED);
    const day = h.ev<string>("viewMyDay()");
    expect(day).toContain("Aftermovie");
    expect(day).toContain("with Emp");
    expect(day).toMatch(/data-act="submitVersion" data-did="8002"/);
    expect(h.ev<boolean>("teamDelivIds(903).has(8002)")).toBe(true);
    // …and the owner sees how many are on it.
    h.as(902);
    expect(h.ev<string>("viewMyDay()")).toContain("＋1 on it");
  });

  it("puts the work in Today's assignments for each assignee, once — even when the deliverable is also scheduled today", async () => {
    const h = await boot(902);
    h.ev(SHARED);
    h.ev("deliv(8002).scheduled_date=TODAY");
    const today = h.ev<Array<Record<string, unknown>>>("myAssignments(902)").filter((a) => a.deliverable_id === 8002);
    expect(today).toHaveLength(1);
    expect(today[0]._deliverable).toBeFalsy();   // the work row, which carries the deliverable
    h.as(903);
    expect(h.ev<Array<Record<string, unknown>>>("myAssignments(903)").filter((a) => a.deliverable_id === 8002)).toHaveLength(1);
  });

  it("an old drawer row that never named the owner gives nobody the deliverable", async () => {
    const h = await boot(903);
    h.ev(`DB.assignments.push({id:77002,project_id:7001,work_type_id:DB.work_types[0].id,deliverable_id:8002,
      title:'Aftermovie',assigned_by:901,priority:'normal',status:'not_started',start_date:TODAY,due_date:TODAY,assignees:[903]});`);
    expect(h.ev<boolean>("teamDelivIds(903).has(8002)")).toBe(false);
    expect(h.ev<string>("viewMyDay()")).not.toMatch(/data-did="8002"/);
    expect(h.ev<Array<Record<string, unknown>>>("myAssignments(903)").some((a) => a.deliverable_id === 8002)).toBe(false);
  });

  it("nobody on the deliverable is offered its review — a lead on the team included", async () => {
    const h = await boot(901);
    h.ev(`DB.assignments.push({id:77003,project_id:7001,work_type_id:DB.work_types[0].id,deliverable_id:8001,
      title:'Photos',assigned_by:901,priority:'normal',status:'not_started',start_date:TODAY,due_date:TODAY,assignees:[902,901]});`);
    expect(h.ev<boolean>("onDelivTeam(deliv(8001))")).toBe(true);
    expect(h.ev<number[]>("pendingVersionReviews().map(x=>x.d.id)")).not.toContain(8001);
    expect(h.ev<boolean>("applyDelivStatus(deliv(8001),'approved')")).toBe(false);
  });
});

/* ── Offered exactly what the server allows ───────────────────────────────────
   One helper per server gate, asked by every control that ends at that route:
   a control nobody can use is not shown, and one the rules allow is reachable.
   8002 "Aftermovie" is on Lead Alpha's project 7001 and owned by Emp Anika. */
describe("Controls — offered exactly what the server allows", () => {
  const moves = "MENUS.delivMenu({did:'8002'}).filter(i=>i.fn&&String(i.label).startsWith('→')).map(i=>i.label)";

  it("the deliverable ⋯ menu offers each person only the moves the server accepts", async () => {
    const h = await boot(906);
    expect(h.ev<string[]>(moves), "the Coordinator was offered a move").toEqual([]);
    h.as(904);
    expect(h.ev<string[]>(moves), "another team's lead was offered scope moves").toEqual([]);
    h.as(902);
    expect(h.ev<string[]>(moves)).toEqual(["→ In Progress"]);
    h.as(901);
    expect(h.ev<string[]>(moves)).toEqual(["→ In Progress", "→ Not Required", "→ Cancelled"]);
    // The project table's ⋯ (Cancel / Not required) follows the same rule.
    h.as(902);
    expect(h.ev<string[]>("(()=>{let it=[];const m=window.menu;window.menu=(n,x)=>{it=x;};"
      + "ACTIONS.delivAction({did:'8002'},null);window.menu=m;return it.map(i=>i.label);})()")).toEqual(["Open drawer"]);
  });

  it("a refused move never reaches the server", async () => {
    const h = await boot(904);
    expect(h.ev<boolean>("applyDelivStatus(deliv(8002),'cancelled')")).toBe(false);
    h.as(906);
    expect(h.ev<boolean>("applyDelivStatus(deliv(8002),'in_progress')")).toBe(false);
    expect(h.writes()).toEqual([]);
  });

  it("the pipeline lets only someone with a move drag the card", async () => {
    const h = await boot(906);
    expect(h.ev<string>("viewPipeline()")).not.toContain('data-drag="deliverable:8002"');
    h.as(901);
    expect(h.ev<string>("viewPipeline()")).toContain('data-drag="deliverable:8002"');
  });

  it("→ In review opens Submit a version; it never sets the status alone", async () => {
    const h = await boot(902);
    h.ev("deliv(8002).status='in_progress'");
    expect(h.ev<string[]>(moves)).toContain("→ In Review");
    h.ev("applyDelivStatus(deliv(8002),'in_review')");
    expect(h.doc.getElementById("modal-layer")!.innerHTML).toContain("Submit v1 for review");
    expect(h.doc.getElementById("modal-layer")!.innerHTML).toContain("Any Team Lead or Admin");
    expect(h.writes()).toEqual([]);
  });

  it("→ Changes requested asks the reviewer what to change, and sends it", async () => {
    const h = await boot(904);
    expect(h.ev<string[]>("MENUS.delivMenu({did:'8001'}).filter(i=>i.fn&&String(i.label).startsWith('→')).map(i=>i.label)"))
      .toEqual(expect.arrayContaining(["→ Approved", "→ Changes Requested"]));
    h.ev("applyDelivStatus(deliv(8001),'changes_requested')");
    const modal = h.doc.getElementById("modal-layer")!;
    expect(modal.innerHTML).not.toMatch(/P4|version trail/);
    h.ev("ACTIONS.confirmChanges({did:'8001'})");
    expect(h.writes(), "sent with no note").toEqual([]);
    (h.doc.getElementById("rc-note") as HTMLTextAreaElement).value = "Colour is off in the second half";
    h.ev("ACTIONS.confirmChanges({did:'8001'})");
    expect(h.writes().find((c) => c.url.endsWith("/deliverables/8001/review"))?.body)
      .toEqual({ outcome: "changes_requested", comment: "Colour is off in the second half" });
    // …and the team reads it in My Day, with who asked.
    h.as(902);
    expect(h.ev<string>("viewMyDay()")).toContain("Lead asked for changes to v1: Colour is off in the second half");
  });

  it("a status changed from the drawer shows in the drawer at once", async () => {
    const h = await boot(901);
    h.ev("drawerDeliverable(8002)");
    h.ev("applyDelivStatus(deliv(8002),'not_required')");
    expect(h.doc.querySelector("#drawer .dr-head")!.innerHTML).toContain("Not Required");
  });

  it("✔ Mark delivered is offered to the people on it and the project's lead — not the Coordinator or another lead", async () => {
    const h = await boot(902);
    h.ev(`deliv(8002).status='approved';DB.deliverable_versions.push({id:88002,deliverable_id:8002,version_no:1,
      review_status:'approved',submitted_by:902,submitted_at:TODAY+'T08:00:00Z',drive_url:'https://drive.google.com/d'});`);
    for (const [who, offered] of [[902, true], [901, true], [907, true], [904, false], [906, false]] as const) {
      h.as(who);
      h.ev("drawerDeliverable(8002)");
      expect(h.doc.getElementById("drawer")!.innerHTML.includes('data-act="markDelivered"'), `user ${who}`).toBe(offered);
    }
  });

  it("delivered work: ✔ Approve / ↩ Revise in the drawer for a lead off its team; Revise needs a note and reopens it in My Day", async () => {
    const h = await boot(904);
    h.ev(`deliv(8002).status='delivered';deliv(8002).approval_status='pending';DB.deliverable_versions.push({id:88002,
      deliverable_id:8002,version_no:1,review_status:'approved',submitted_by:902,submitted_at:TODAY+'T08:00:00Z',drive_url:'https://drive.google.com/d'});`);
    for (const [who, offered] of [[904, true], [907, true], [902, false], [906, false]] as const) {
      h.as(who);
      h.ev("drawerDeliverable(8002)");
      expect(h.doc.getElementById("drawer")!.innerHTML.includes('data-act="reviewDelivered"'), `user ${who}`).toBe(offered);
    }
    h.as(904);
    h.ev("ACTIONS.reviewDelivered({did:'8002',v:'changes_requested'})");
    h.ev("ACTIONS.confirmSignOff({did:'8002',v:'changes_requested'})");
    expect(h.writes(), "sent back with no note").toEqual([]);
    (h.doc.getElementById("rd-note") as HTMLTextAreaElement).value = "Wrong logo at the end";
    h.ev("ACTIONS.confirmSignOff({did:'8002',v:'changes_requested'})");
    expect(h.writes().find((c) => c.url.endsWith("/deliverables/8002/approval"))?.body)
      .toEqual({ approval_status: "changes_requested", note: "Wrong logo at the end" });
    h.as(902);
    expect(h.ev<boolean>("isDeliveredOutput(deliv(8002))")).toBe(false);
    expect(h.ev<string>("viewMyDay()")).toContain("Lead sent it back after delivery: Wrong logo at the end");
    /* After a reload the note comes from the version the server sent back. */
    h.ev(`delete deliv(8002).approval_note;Object.assign(DB.deliverable_versions.find(v=>v.id===88002),
      {review_status:'changes_requested',review_comment:'Logo from the server',reviewed_by:904});`);
    expect(h.ev<string>("viewMyDay()")).toContain("Lead sent it back after delivery: Logo from the server");
  });

  it("project ⋯: another team's lead runs nothing; the Coordinator edits details and can re-route", async () => {
    const h = await boot(904);
    const state = () => Object.fromEntries(h.ev<Array<{ label: string; disabled?: boolean }>>("MENUS.projMore({pid:'7001'})")
      .filter((i) => i.label).map((i) => [i.label, !i.disabled]));
    expect(state()).toMatchObject({ "Edit details": false, "Delete project": false, "Cancel project": false });
    expect(h.ev<string>("projList(visibleProjects())")).not.toContain("ACTIONS.deleteProject({pid:7001})");
    h.as(901);
    // The lead runs it — and cancels it — but only an Admin deletes a project.
    expect(state()).toMatchObject({ "Edit details": true, "Delete project": false, "Cancel project": true });
    expect(h.ev<string>("projList(visibleProjects())")).not.toContain("ACTIONS.deleteProject({pid:7001})");
    h.as(907);
    expect(state()).toMatchObject({ "Delete project": true });
    expect(h.ev<string>("projList(visibleProjects())")).toContain("ACTIONS.deleteProject({pid:7001})");
    h.as(901);
    h.ev("ACTIONS.editProject({pid:'7001'})");
    expect(h.doc.getElementById("ep-team"), "a lead was offered re-routing").toBeNull();
    h.ev("closeModal()");
    h.as(906);
    expect(state()).toMatchObject({ "Edit details": true, "Delete project": false, "Cancel project": false });
    h.ev("ACTIONS.editProject({pid:'7001'})");
    const team = h.doc.getElementById("ep-team") as HTMLSelectElement;
    expect(team, "the Coordinator has no Team field").not.toBeNull();
    team.value = "9002";
    h.ev("ACTIONS.saveProjectEdit({pid:'7001'})");
    expect(h.writes().find((c) => c.url.endsWith("/projects/7001") && c.method === "PATCH")?.body)
      .toMatchObject({ team_id: 9002 });
    // Re-routed: the new team's lead now owns it.
    expect(h.ev<number>("proj(7001).owner_id")).toBe(904);
  });

  it("the Projects board lets only those who run a project drag it", async () => {
    const h = await boot(904);
    expect(h.ev<string>("projKanban([proj(7001)])")).not.toContain('data-drag="project:7001"');
    h.as(901);
    expect(h.ev<string>("projKanban([proj(7001)])")).toContain('data-drag="project:7001"');
  });

  it("Assign to SMC member is not offered to the Coordinator or a crew employee", async () => {
    const h = await boot(906);
    h.ev("DASG.byDeliv[8002]={crew:null,smc:null,team:[]}");
    expect(h.ev<string>("delivAssignSection(8002)")).not.toContain('data-kind="smc"');
    h.as(903);
    expect(h.ev<string>("delivAssignSection(8002)")).not.toContain('data-kind="smc"');
    h.as(904);
    expect(h.ev<string>("delivAssignSection(8002)")).toContain('data-kind="smc"');
  });

  it("a Production Board card: only leads and Admins move it, and a synced move obeys the review", async () => {
    const h = await boot(902);
    h.ev(`DB.boards.push({id:9901,name:'Edit board',description:'',sync_status:true});
      DB.board_columns.push({id:9910,board_id:9901,name:'Doing',sort_order:1,maps_to_status:null},
                            {id:9911,board_id:9901,name:'Approved',sort_order:2,maps_to_status:'approved'});
      DB.cards.push({id:9921,board_id:9901,column_id:9910,title:'Photos',labels:[],checklist:[],sort_order:1,
                     linked_entity_type:'deliverable',linked_entity_id:8005});`);
    h.ev("moveCardToColumn(9921,9911)");
    expect(h.ev<number>("DB.cards.find(c=>c.id===9921).column_id"), "an employee moved a card").toBe(9910);
    h.as(901);   // 8005 is Lead Alpha's own deliverable: they may not approve it
    h.ev("moveCardToColumn(9921,9911)");
    expect(h.ev<number>("DB.cards.find(c=>c.id===9921).column_id")).toBe(9910);
    expect(h.ev<string>("deliv(8005).status")).toBe("in_review");
    expect(h.writes()).toEqual([]);
    h.as(904);
    h.ev("moveCardToColumn(9921,9911)");
    expect(h.ev<number>("DB.cards.find(c=>c.id===9921).column_id")).toBe(9911);
  });

  it("Home's Pending Approvals: only for reviewers, every waiting version, newest first, and 'View all' opens In review", async () => {
    const h = await boot(902);
    h.ev("DB.project_assignments.push({id:99009,project_id:7001,user_id:902,is_project_manager:true,removed_at:null})");
    expect(h.ev<string>("viewDashboard()"), "an employee PM was shown an approvals queue").not.toContain("Pending Approvals");
    h.as(906);
    expect(h.ev<string>("viewDashboard()")).not.toContain("Pending Approvals");
    h.as(904);
    // Five more submissions, the newest last: none may be cut off, and cancelled work drops out.
    h.ev(`for(let i=0;i<5;i++){DB.deliverables.push({id:8100+i,project_id:7001,deliverable_type_id:window.__T,title:'Clip '+i,
      owner_id:903,due_date:TODAY,status:'in_review',deleted_at:null,approval_status:'pending'});
      DB.deliverable_versions.push({id:88100+i,deliverable_id:8100+i,version_no:1,review_status:'pending',submitted_by:903,
      submitted_at:TODAY+'T1'+i+':00:00Z',drive_url:'https://drive.google.com/x'});}
      deliv(8104).status='cancelled';`);
    const ids = h.ev<number[]>("pendingVersionReviews().map(x=>x.d.id)");
    expect(ids).toEqual(expect.arrayContaining([8001, 8004, 8005, 8100, 8101, 8102, 8103]));
    expect(ids).not.toContain(8104);
    expect(ids.indexOf(8103)).toBeLessThan(ids.indexOf(8100));
    const html = h.ev<string>("pendingApprovalsWidget()");
    for (const id of [8001, 8100, 8103]) expect(html).toContain(`deliverable:${id}`);
    h.ev("ACTIONS.viewApprovals()");
    expect(h.ev<string[]>("S.filters.pipe.status")).toEqual(["in_review"]);
    const pipe = h.ev<string>("viewPipeline()");
    expect(pipe).not.toContain("deliverable:8002");
    // The tile counts what is on the board, not one reviewer's own queue.
    const all = h.ev<number>("pendingVersions(DB.deliverables).length");
    expect(pipe).toContain(`${all} versions pending`);
    expect(all).toBeGreaterThanOrEqual(ids.length);
  });
});

describe("My Day, the drawer, lists and crew — one answer per question", () => {
  const WORK = `DB.assignments.push({id:77101,project_id:7001,work_type_id:DB.work_types[0].id,deliverable_id:8002,
    title:'Edit the aftermovie',assigned_by:901,priority:'normal',status:'not_started',start_date:TODAY,due_date:TODAY,
    assignees:[902,903]}); deliv(8002).status='in_review';`;

  it("work on a deliverable shows the deliverable's status, with no second status select", async () => {
    const h = await boot(902);
    h.ev(WORK);
    const card = h.ev<string>("assignmentCard(myAssignments(902).find(a=>a.id===77101))");
    expect(card).toContain("In Review");
    expect(card).not.toContain("asg-sel");
    expect(card).not.toContain("Not started");
  });

  it("Today's assignments drops work whose deliverable is approved, delivered, not required or cancelled", async () => {
    const h = await boot(902);
    h.ev(WORK);
    for (const st of ["approved", "delivered", "not_required", "cancelled"]) {
      h.ev(`deliv(8002).status='${st}'`);
      expect(h.ev<unknown[]>("myAssignments(902).map(a=>a.id)"), st).not.toContain(77101);
    }
    h.ev("deliv(8002).status='changes_requested'");
    expect(h.ev<unknown[]>("myAssignments(902).map(a=>a.id)")).toContain(77101);
    // A deliverable scheduled for today and already approved is not today's work either.
    h.ev("deliv(8001).status='approved'");
    expect(h.ev<unknown[]>("myAssignments(902).map(a=>a.id)")).not.toContain("d8001");
  });

  it("the drawer says 'No due date' and 'No owner yet', never NaN, and names the owner once", async () => {
    const h = await boot(901);
    h.ev("deliv(8003).due_date=null; DASG.byDeliv[8003]={crew:null,team:[],smc:null}; drawerDeliverable(8003)");
    const dr = h.doc.querySelector("#drawer")!;
    expect(dr.textContent).toContain("No due date");
    expect(dr.textContent).not.toContain("NaN");
    expect(dr.textContent).toContain("No owner yet");
    expect(dr.innerHTML.match(/<dt>Owner<\/dt>/g)).toHaveLength(1);
    expect(h.ev<string>("D.rel(null)")).toBe("");
    h.ev("DASG.byDeliv[8002]={crew:{user_id:'zcw-902',full_name:'Emp Anika'},team:[],smc:null}; drawerDeliverable(8002)");
    expect(dr.innerHTML.match(/<dt>Owner<\/dt>/g)).toHaveLength(1);
    expect(dr.textContent).toContain("Emp Anika");
  });

  it("no toast carries an internal rule code", () => {
    const toasts = HTML.split("\n").filter((l) => /toast\(/.test(l));
    expect(toasts.filter((l) => /\b(AUTO|BR|FR)-\d/.test(l))).toEqual([]);
  });

  it("My projects lists the newest first and links to all of them", async () => {
    const h = await boot(902);
    h.ev(`for(let i=0;i<7;i++){DB.projects.push({id:7100+i,name:'Proj '+i,code:'MC-'+(7100+i),team_id:9001,owner_id:901,
      project_type_id:DB.project_types[0].id,status:'in_production',priority:'normal',academic_year_id:2,deleted_at:null,tags:[]});
      DB.project_assignments.push({id:99100+i,project_id:7100+i,user_id:902,is_project_manager:false,removed_at:null});}`);
    const page = h.ev<string>("viewMyDay()");
    expect(page.indexOf("MC-7106")).toBeGreaterThan(-1);
    expect(page.indexOf("MC-7106")).toBeLessThan(page.indexOf("MC-7105"));
    expect(page).not.toContain("MC-7100<");
    expect(page).toContain('data-act="myProjectsAll"');
    h.ev("ACTIONS.myProjectsAll()");
    expect(h.ev<boolean>("projectFilters().mine")).toBe(true);
    // Every year: a project from another academic year is still one of mine.
    expect(h.ev<number[]>("filteredProjects().map(p=>p.id)")).toEqual(expect.arrayContaining([7100, 7106]));
  });

  it("the start-up notice is short-lived and leaves when a dialog or drawer opens", async () => {
    const h = await boot(902);
    h.ev("document.querySelector('#toasts').innerHTML=''");
    h.ev("toast('Signed in','ok',null,{passing:true}); toast('Saved','ok')");
    expect(h.doc.querySelectorAll("#toasts .toast")).toHaveLength(2);
    h.ev("modal('<div class=\"mo-head\"><h2>x</h2></div><div class=\"mo-foot\"><button class=\"btn\">Cancel</button></div>')");
    const left = [...h.doc.querySelectorAll("#toasts .toast")].map((n) => n.textContent);
    expect(left.join(" ")).toContain("Saved");
    expect(left.join(" ")).not.toContain("Signed in");
    h.ev("closeModal(); toast('Signed in','ok',null,{passing:true}); drawerDeliverable(8001)");
    expect(h.doc.querySelector("#toasts [data-passing]")).toBeNull();
  });

  it("the Deliverables tab has one Deliverable column and an Actions cell that wraps", async () => {
    const h = await boot(901);
    h.ev("deliv(8002).title=dtype(deliv(8002).deliverable_type_id).name");
    const tab = h.ev<string>("projDeliverablesTab(proj(7001),projectDeliverables(7001))");
    expect(tab).not.toContain("<th>Title</th>");
    expect(tab).not.toContain("<th>Type</th>");
    expect(tab).toContain("<th>Deliverable</th>");
    expect(tab).not.toMatch(/class="num nowrap" data-stop data-m="actions"/);
    // A row titled after its type does not print the type a second time.
    const name = h.ev<string>("dtype(deliv(8002).deliverable_type_id).name");
    const row = tab.slice(tab.indexOf("deliverable:8002"), tab.indexOf("</tr>", tab.indexOf("deliverable:8002")));
    expect(row.split(`>${name}<`).length - 1).toBe(1);
  });

  it("Pending approvals names who asked for the review", async () => {
    const h = await boot(904);
    expect(h.ev<string>("pendingApprovalsWidget()")).toMatch(/>Emp Anika</);
  });

  it("Overview's Latest activity and the Activity tab read the same rows, with names not ids", async () => {
    const h = await boot(906);
    h.ev(`window.__MO_LIVE__=false; DB.audit_logs.unshift({id:66001,actor_id:906,action:'project.team_assigned',entity_type:'project',
      entity_id:7001,before:null,after:{team_id:9001,team:'Event Team',lead:'zcw-901'},occurred_at:TODAY+'T08:00:00Z'})`);
    const over = h.ev<string>("viewProject(7001,'overview')");
    const act = h.ev<string>("projActivityTab(proj(7001))");
    for (const html of [over, act]) {
      expect(html).toContain("Lead Alpha");
      expect(html).not.toContain("zcw-901");
    }
    // Live: the Overview shows the server's feed, the same one the Activity tab does.
    h.ev(`window.__MO_LIVE__=true; S._projActs={7001:{rows:[{action:'project.created',actor:'Coord Chitra',
      entity_type:'project',entity_id:7001,before:null,after:{},occurred_at:TODAY+'T07:00:00Z'}]}}`);
    expect(h.ev<string>("viewProject(7001,'overview')")).toContain("Coord Chitra");
    expect(h.ev<string>("projActivityTab(proj(7001))")).toContain("Coord Chitra");
  });

  it("the crew trash is on everyone but the owner and PM, for whoever runs the project", async () => {
    const h = await boot(907);
    h.ev(`DB.project_assignments.push({id:99201,project_id:7001,user_id:903,is_project_manager:false,removed_at:null});
      DB.assignments.push({id:77201,project_id:7001,deliverable_id:8003,work_type_id:DB.work_types[0].id,title:'x',
        status:'not_started',assignees:[905]})`);
    const page = h.ev<string>("viewProject(7001,'overview')");
    expect(page).toContain("removeAssignment({pid:7001,uid:903})");
    // On it only through a deliverable: taken off through the same dialog, not left listed.
    expect(page).toContain("removeAssignment({pid:7001,uid:905})");
    expect(page, "the owner/PM").not.toContain("removeAssignment({pid:7001,uid:901})");
    h.as(904);   // another team's lead assigns here but does not run it
    expect(h.ev<string>("viewProject(7001,'overview')")).not.toContain("removeAssignment(");
  });

  it("whoever runs the project edits a shoot and takes people off it; deleting it stays with the lead", async () => {
    const h = await boot(903);
    h.ev(`DB.shoots.push({id:9502,project_id:7001,title:'Prize night',shoot_date:TODAY,call_time:'18:00',end_time:'21:00',
      location:'Hall',location_url:'',status:'planned',deleted_at:null});
      DB.shoot_crew.push({shoot_id:9502,user_id:902,capacity_role_id:null});
      DB.project_assignments.find(a=>a.id===99001).is_project_manager=false;
      DB.project_assignments.push({id:99202,project_id:7001,user_id:903,is_project_manager:true,removed_at:null})`);
    const tab = h.ev<string>("projShootsTab(proj(7001),DB.shoots.filter(s=>s.project_id===7001))");
    expect(tab).toContain("ACTIONS.editShoot({sid:9502})");
    expect(tab, "the PM deletes no shoot").not.toContain("ACTIONS.deleteShoot({sid:9502})");
    h.ev("drawerShoot(9502)");
    expect(h.doc.querySelector("#drawer [data-act=removeShootCrew]")).not.toBeNull();
    h.as(901);
    expect(h.ev<string>("projShootsTab(proj(7001),DB.shoots.filter(s=>s.project_id===7001))"))
      .toContain("ACTIONS.deleteShoot({sid:9502})");
    h.as(902);   // on the shoot, not running the project
    expect(h.ev<string>("projShootsTab(proj(7001),DB.shoots.filter(s=>s.project_id===7001))"))
      .not.toContain("ACTIONS.editShoot({sid:9502})");
  });

  it("the project's lead or an Admin can take someone off a shoot; another lead cannot", async () => {
    const h = await boot(904);
    h.ev(`DB.shoots.push({id:9501,project_id:7001,title:'Festival day',shoot_date:TODAY,call_time:'09:00',end_time:'12:00',
      location:'Main ground',location_url:'',status:'scheduled',deleted_at:null});
      DB.shoot_crew.push({shoot_id:9501,user_id:902,capacity_role_id:null})`);
    h.ev("drawerShoot(9501)");
    expect(h.doc.querySelector("#drawer [data-act=removeShootCrew]")).toBeNull();
    h.as(901);
    h.ev("drawerShoot(9501)");
    const btn = h.doc.querySelector<HTMLElement>("#drawer [data-act=removeShootCrew]");
    expect(btn).not.toBeNull();
    btn!.click();
    await new Promise((r) => setTimeout(r, 30));
    expect(h.writes().some((c) => c.method === "DELETE" && c.url.endsWith("/shoots/9501/crew/zcw-902"))).toBe(true);
    expect(h.ev<number>("DB.shoot_crew.filter(c=>c.shoot_id===9501).length")).toBe(0);
  });

  it("the pipeline Owner filter lists only people who own something on that board", async () => {
    const h = await boot(902);
    const names = h.ev<string[]>("MENUS.pipeOwner().map(i=>i.label)");
    expect(names).toContain("Emp Anika");
    expect(names).not.toContain("Emp Bela");
    expect(names).not.toContain("Coord Chitra");
    h.as(907);
    expect(h.ev<string[]>("MENUS.pipeOwner().map(i=>i.label)")).toContain("Emp Bela");
  });
});

/* ── Pass-2 review follow-ups: every control offered works for that person ── */
describe("review follow-ups — what the page offers matches what the server honours", () => {
  const card = `(()=>{const b=DB.boards[0], col=DB.board_columns.find(c=>c.board_id===b.id);
    DB.cards.push({id:99901,board_id:b.id,column_id:col.id,title:'Poster run',description:'',labels:[],assignees:[],
      checklist:[{text:'Proof',is_done:false}],priority:'normal',due_date:null,created_by:901,archived_at:null});})()`;

  it("the card drawer offers Edit, Archive and the checklist only to a Team Lead or an Admin", async () => {
    const h = await boot(906);
    h.ev(card);
    h.ev("drawerCard(99901)");
    const drawer = () => h.doc.getElementById("drawer")!.innerHTML;
    expect(drawer()).not.toContain('data-act="editCard"');
    expect(drawer()).not.toContain('data-act="archiveCard"');
    expect(drawer()).not.toContain("toggleCheck");
    // Reached anyway, nothing is changed and nothing is posted.
    h.ev("ACTIONS.toggleCheck({cid:99901,ix:0}); ACTIONS.archiveCard({cid:'99901'})");
    expect(h.ev<boolean>("DB.cards.find(c=>c.id===99901).checklist[0].is_done")).toBe(false);
    expect(h.ev<unknown>("DB.cards.find(c=>c.id===99901).archived_at")).toBeNull();
    expect(h.writes().some((c) => c.url.includes("/cards/"))).toBe(false);
    h.as(901);
    h.ev("drawerCard(99901)");
    expect(drawer()).toContain('data-act="editCard"');
    expect(drawer()).toContain('data-act="archiveCard"');
    expect(drawer()).toContain("toggleCheck");
  });

  it("whoever marked work delivered is not offered its sign-off", async () => {
    const h = await boot(904);
    h.ev("Object.assign(deliv(8002),{status:'delivered',approval_status:'pending',delivered_by:904})");
    expect(h.ev<boolean>("canSignOff(deliv(8002))")).toBe(false);
    h.ev("deliv(8002).delivered_by=902");
    expect(h.ev<boolean>("canSignOff(deliv(8002))")).toBe(true);
  });

  it("a project's activity is asked for once, says so when it fails, and tries again on request", async () => {
    const h = await boot(907);
    let asks = 0;
    (h.dom.window as unknown as { fetch: unknown }).fetch = async (input: RequestInfo | URL) => {
      if (!/\/projects\/\d+\/activity$/.test(String(input)))
        return { ok: true, status: 200, json: async () => ({}) } as Response;
      asks++;
      if (asks === 1) return { ok: false, status: 500, json: async () => ({ message: "Server error." }) } as Response;
      return { ok: true, status: 200, json: async () => ({ activity: [{ action: "project.created", actor: "Coord Chitra",
        entity_type: "project", entity_id: 7001, before: null, after: {}, occurred_at: "2026-01-01T07:00:00Z" }] }) } as Response;
    };
    const settle = () => new Promise((r) => setTimeout(r, 50));
    h.ev("viewProject(7001,'overview')");
    await settle();
    expect(h.ev<string>("viewProject(7001,'overview')")).toContain("Could not load activity");
    expect(h.ev<string>("projActivityTab(proj(7001))")).toContain("retryProjActivity");
    expect(asks).toBe(1);
    // Try again re-renders the page it is on — here, the project's Overview.
    h.ev("ACTIONS.retryProjActivity({pid:'7001'}); viewProject(7001,'overview')");
    await settle();
    expect(asks).toBe(2);
    expect(h.ev<string>("viewProject(7001,'overview')")).toContain("Coord Chitra");
    // Another project and back: the first is not asked for again until a write.
    h.ev("viewProject(7002,'overview')");
    await settle();
    h.ev("viewProject(7001,'overview')");
    expect(asks).toBe(3);
    h.ev("Object.values(S._projActs).forEach(e=>{e.stale=true;}); viewProject(7001,'overview')");
    await settle();
    expect(asks).toBe(4);
  });

  it("a 'You now lead' notice opens that team on Teams & duties, not a person's page", async () => {
    const h = await boot(901);
    h.ev(`DB.notifications=[{id:7,user_id:901,kind:'assignment',entity_type:'team',entity_id:9002,
      title:'You now lead Video Team',body:'',created_at:TODAY+'T09:00:00Z',is_read:false}]`);
    h.ev("ACTIONS.openNotif({nid:'7'})");
    expect(h.dom.window.location.hash).toBe("#/media/team");
    expect(h.ev<string>("S.tab.team")).toBe("structure");
    const page = h.ev<string>("viewTeam()");
    expect(page).toMatch(/data-tid="9002"[^>]*outline/);
    expect(page).not.toMatch(/data-tid="9001"[^>]*outline/);
  });

  it("My Day's Awaiting review chip says who reviews: any Team Lead or Admin, not the PM", () => {
    expect(HTML).not.toContain("the project PM must review it");
    expect(HTML).toContain("Any Team Lead or Admin who is not working on it reviews it. You cannot approve your own version.");
  });
});

describe("taking someone off a project — nothing they carry is stranded", () => {
  const tick = () => new Promise((r) => setTimeout(r, 30));
  const removal = (h: Awaited<ReturnType<typeof boot>>) =>
    h.writes().filter((c) => c.method === "DELETE" && c.url.includes("/projects/7001/assignments/"));

  it("each open deliverable needs an answer before Remove is offered, and the answers are sent", async () => {
    const h = await boot(907);
    h.ev("ACTIONS.removeAssignment({pid:7001,uid:902})");
    const go = () => h.doc.getElementById("rm-go") as HTMLButtonElement;
    const pick = (id: string, v: string) => {
      const sel = h.doc.getElementById(id) as HTMLSelectElement;
      sel.value = v; sel.dispatchEvent(new h.dom.window.Event("change"));
    };
    // Emp Anika owns Edited Photos (in review) and Aftermovie (not started).
    expect(h.doc.getElementById("rm-902-8001")).not.toBeNull();
    expect(h.doc.getElementById("rm-902-8002")).not.toBeNull();
    expect(go().disabled).toBe(true);
    const inReview = [...(h.doc.getElementById("rm-902-8001") as HTMLSelectElement).options].map((o) => o.value);
    expect(inReview).toContain("st:cancelled");
    expect(inReview, "in review cannot become not required").not.toContain("st:not_required");
    expect(inReview, "nobody hands work back to the person leaving").not.toContain("to:902");
    expect(inReview, "an owner is handed on, not dropped").not.toContain("drop");
    pick("rm-902-8001", "to:903");
    expect(go().disabled).toBe(true);
    pick("rm-902-8002", "st:not_required");
    expect(go().disabled).toBe(false);
    go().click();
    await tick();
    const [call] = removal(h);
    expect(call.url).toMatch(/\/projects\/7001\/assignments\/zcw-902$/);
    expect(call.body).toEqual({ resolutions: [
      { deliverable_id: 8001, reassign_to: "zcw-903" }, { deliverable_id: 8002, status: "not_required" }] });
  });

  it("a team member may simply come off the team; someone with nothing open is removed at once", async () => {
    const h = await boot(901);
    h.ev(`DB.project_assignments.push({id:99203,project_id:7001,user_id:905,is_project_manager:false,removed_at:null});
      DB.assignments.push({id:77202,project_id:7001,deliverable_id:8002,work_type_id:DB.work_types[0].id,title:'cut',
        status:'in_progress',assignees:[902,903]})`);
    h.ev("ACTIONS.removeAssignment({pid:7001,uid:903})");
    const sel = h.doc.getElementById("rm-903-8002") as HTMLSelectElement;
    expect([...sel.options].map((o) => o.value)).toContain("drop");
    h.ev("closeModal()");
    h.ev("ACTIONS.removeAssignment({pid:7001,uid:905})");
    expect(h.doc.querySelector("#modal-layer select")).toBeNull();
    (h.doc.getElementById("rm-go") as HTMLButtonElement).click();
    await tick();
    expect(removal(h).map((c) => c.body)).toEqual([{ resolutions: [] }]);
  });

  it("the server's list replaces the page's guess when it answers", async () => {
    const h = await boot(907);
    h.ev(`window.fetch=async(u,i)=>({ok:true,status:200,json:async()=>String(u).endsWith('/impact')
      ?{blocking:[{id:8003,title:'Instagram Reel',status:'in_progress',role:'team'}]}:{}})`);
    h.ev("ACTIONS.removeAssignment({pid:7001,uid:903})");
    await tick();
    expect(h.doc.getElementById("rm-903-8003")).not.toBeNull();
    expect((h.doc.getElementById("rm-go") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("Assign crew — ticking adds, unticking removes", () => {
  it("posts only people added, sends people unticked through removal, and names each person's team", async () => {
    const h = await boot(907);
    h.ev(`DB.project_assignments.push({id:99204,project_id:7001,user_id:903,is_project_manager:false,removed_at:null})`);
    h.ev("ACTIONS.assignProject({pid:'7001'})");
    const chip = (uid: number) => h.doc.querySelector(`#pa-crew .chip[data-uid="${uid}"]`) as HTMLButtonElement;
    expect(chip(905).textContent).toContain("Video Team");
    expect(chip(903).classList.contains("sel")).toBe(true);
    expect(chip(901).disabled, "the owner/PM cannot be unticked").toBe(true);
    chip(903).click();               // untick someone already on it
    chip(905).click();               // tick someone new
    h.ev("ACTIONS.confirmAssign({pid:'7001'})");
    await new Promise((r) => setTimeout(r, 30));
    const posts = h.writes().filter((c) => c.method === "POST" && c.url.endsWith("/projects/7001/assignments"));
    expect(posts.map((c) => c.body)).toEqual([{ user_id: "zcw-905" }]);
    // The unticked person is not removed silently: the removal dialog asks first.
    expect(h.doc.querySelector("#modal-layer h2")?.textContent).toContain("Emp Arjun");
    expect(h.writes().some((c) => c.method === "DELETE")).toBe(false);
    // The toast counts real additions only: one person, not everyone ticked.
    expect(h.doc.querySelector("#toasts")?.textContent ?? "").toContain("Emp Bela added to the crew");
  });

  it("someone who assigns without running the project cannot untick anyone", async () => {
    const h = await boot(904);
    h.ev(`DB.project_assignments.push({id:99205,project_id:7001,user_id:903,is_project_manager:false,removed_at:null})`);
    h.ev("ACTIONS.assignProject({pid:'7001'})");
    expect((h.doc.querySelector('#pa-crew .chip[data-uid="903"]') as HTMLButtonElement).disabled).toBe(true);
    expect((h.doc.querySelector('#pa-crew .chip[data-uid="905"]') as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("Reassign deliverable — the current owner is named, and it is asked first", () => {
  const tick = () => new Promise((r) => setTimeout(r, 30));
  const dialog = (h: Awaited<ReturnType<typeof boot>>) => h.doc.getElementById("rsg-layer");
  const answer = (h: Awaited<ReturnType<typeof boot>>, yes: boolean) =>
    (h.doc.querySelector(`#rsg-layer [data-rsg="${yes ? "yes" : "no"}"]`) as HTMLElement).click();
  const sent = (h: Awaited<ReturnType<typeof boot>>, tail: string) =>
    h.writes().filter((c) => c.url.endsWith(tail)).map((c) => c.body as Record<string, unknown>);

  it("the owner select says Reassign deliverable; Cancel puts it back, Reassign sends it confirmed", async () => {
    const h = await boot(901);
    const cell = h.ev<string>("delivOwnerCell(proj(7001),deliv(8002))");
    expect(cell).toContain('title="Reassign deliverable — owned by Emp Anika · Event Team"');
    h.doc.body.insertAdjacentHTML("beforeend", cell);
    const sel = h.doc.querySelector('select.deliv-owner[data-did="8002"]') as HTMLSelectElement;
    sel.value = "903";
    sel.dispatchEvent(new h.dom.window.Event("change"));
    expect(dialog(h)!.textContent).toContain("Current owner: Emp Anika · Event Team");
    expect(dialog(h)!.textContent).toContain("→ New owner: Emp Arjun · Event Team");
    answer(h, false);
    await tick();
    expect(dialog(h)).toBeNull();
    expect(sel.value, "the select still shows who owns it").toBe("902");
    expect(h.ev<number>("deliv(8002).owner_id")).toBe(902);
    expect(sent(h, "/deliverables/8002")).toEqual([]);
    sel.value = "903";
    sel.dispatchEvent(new h.dom.window.Event("change"));
    answer(h, true);
    await tick();
    expect(sent(h, "/deliverables/8002")).toEqual([{ owner_id: "zcw-903", confirm_reassign: true }]);
  });

  it("a first assignment is not asked about and sends no confirmation", async () => {
    const h = await boot(901);
    expect(h.ev<string>("delivOwnerCell(proj(7001),deliv(8003))")).toContain('title="Assign this deliverable');
    h.ev("ACTIONS.assignDeliverable({did:8003},{value:'903'})");
    await tick();
    expect(dialog(h)).toBeNull();
    expect(sent(h, "/deliverables/8003")).toEqual([{ owner_id: "zcw-903" }]);
  });

  it("the drawer offers Reassign deliverable and asks before it posts", async () => {
    const h = await boot(901);
    h.ev(`DASG.byDeliv[8002]={crew:{user_id:'zcw-902',full_name:'Emp Anika'},smc:null,team:[]};
          DASG.list={crew:[{id:'zcw-903',full_name:'Emp Arjun'}],smc:[]}; DASG.pick[8002]='zcw-903';`);
    expect(h.ev<string>("delivAssignSection(8002)")).toContain("Reassign deliverable");
    const done = h.ev<Promise<unknown>>("ACTIONS.dasgSave({did:'8002',kind:'crew'})");
    expect(dialog(h)!.textContent).toMatch(/Current owner: Emp Anika\s*→ New owner: Emp Arjun/);
    answer(h, false);
    await done;
    expect(sent(h, "/deliverables/8002/assignee")).toEqual([]);
    const again = h.ev<Promise<unknown>>("ACTIONS.dasgSave({did:'8002',kind:'crew'})");
    answer(h, true);
    await again;
    expect(sent(h, "/deliverables/8002/assignee")).toEqual([{ kind: "crew", user_id: "zcw-903", confirm_reassign: true }]);
  });

  it("Assign work names the reassignment, keeps the form on Cancel and sends it confirmed", async () => {
    const h = await boot(901);
    h.ev("openAssignWork(7001); ACTIONS.awDelivMode({m:'existing'})");
    (h.doc.querySelector("#aw-deliv") as HTMLSelectElement).value = "8002";
    h.ev("ACTIONS.awDelivPick()");
    (h.doc.querySelector("#aw-title") as HTMLInputElement).value = "Grade it";
    (h.doc.querySelector('#aw-users .chip[data-uid="903"]') as HTMLElement).click();
    const hint = h.doc.querySelector("#aw-reassign") as HTMLElement;
    expect(hint.hidden).toBe(false);
    expect(hint.textContent).toContain("Reassign deliverable — Current owner: Emp Anika · Event Team → New owner: Emp Arjun");
    const first = h.ev<Promise<unknown>>("ACTIONS.createWork()");
    answer(h, false);
    await first;
    expect(h.doc.querySelector("#aw-title"), "Assign work closed on Cancel").not.toBeNull();
    expect(sent(h, "/projects/7001/work")).toEqual([]);
    const second = h.ev<Promise<unknown>>("ACTIONS.createWork()");
    answer(h, true);
    await second;
    expect(sent(h, "/projects/7001/work")[0]).toMatchObject({ deliverable_id: 8002, owner_id: "zcw-903", confirm_reassign: true });
  });

  it("Schedule with a new owner asks too", async () => {
    const h = await boot(901);
    h.ev("ACTIONS.scheduleDeliv({did:'8002'})");
    (h.doc.querySelector("#sd-owner") as HTMLSelectElement).value = "903";
    const done = h.ev<Promise<unknown>>("ACTIONS.confirmSchedule({did:'8002'})");
    expect(dialog(h)!.textContent).toContain("Current owner: Emp Anika");
    answer(h, true);
    await done;
    expect(sent(h, "/deliverables/8002/schedule")[0]).toMatchObject({ owner_id: "zcw-903", confirm_reassign: true });
  });

  it("an owner the page did not know about: the server's answer is asked about, then sent confirmed", async () => {
    const h = await boot(901);
    const calls: Array<Record<string, unknown>> = [];
    (h.dom.window as unknown as { fetch: unknown }).fetch = async (input: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      if (String(input).endsWith("/deliverables/8003")) {
        calls.push(body);
        if (!body.confirm_reassign)
          return { ok: false, status: 409, json: async () => ({ code: "reassign_confirm",
            message: "Already owned.", current_owner: { id: "zcw-905", full_name: "Emp Bela" } }) } as Response;
      }
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    };
    h.ev("ACTIONS.assignDeliverable({did:8003},{value:'903'})");
    await tick();
    expect(dialog(h)!.textContent).toContain("Current owner: Emp Bela");
    answer(h, true);
    await tick();
    expect(calls).toEqual([{ owner_id: "zcw-903" }, { owner_id: "zcw-903", confirm_reassign: true }]);
  });
});
