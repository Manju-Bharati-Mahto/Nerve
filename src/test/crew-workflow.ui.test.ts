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
    approval_status:'pending',social_status:'na',mail_status:'na',unit:'',quantity_target:null,quantity_delivered:null});
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

  it("New project offers the Coordinator every team, and leaving it unrouted", async () => {
    const h = await boot(906);
    h.ev("openNewProject()");
    const opts = [...h.doc.querySelectorAll("#np-team option")].map((o) => (o as HTMLOptionElement).value);
    expect(opts).toEqual(["", "9001", "9002"]);
  });

  it("New project is offered to an employee, assigned to them, with no team to pick", async () => {
    const h = await boot(902);
    expect(h.ev<boolean>("can('project.create')")).toBe(true);
    h.ev("openNewProject()");
    expect(h.doc.querySelectorAll("#np-team option").length, "an employee was offered teams").toBe(0);
    expect((h.doc.getElementById("np-team") as HTMLInputElement).value).toBe("");
    const layer = h.doc.getElementById("modal-layer")!.innerHTML;
    expect(layer).toContain("assigned to you");
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
      ["team", 9001, "#/media/team/9001"],
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
    const assign = (nk: string, et: string) => h.ev<string>(`notifSource({kind:'${nk}',entity_type:'${et}'})`);
    expect(assign("assignment", "project")).toBe("coord");
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
    expect(h.writes().some((c) => c.url.endsWith("/deliverables/8001/status"))).toBe(true);
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
    (doc.querySelector("#aw-dtitle") as HTMLInputElement).value = "Festival aftermovie";
    (doc.querySelector("#aw-ddrive") as HTMLInputElement).value = "https://drive.google.com/folder";
    pick(902); pick(903);
    (doc.querySelector("#aw-owner") as HTMLSelectElement).value = "903";
    h.ev("ACTIONS.createWork()");
    const post = h.writes().find((c) => c.url.endsWith("/projects/7001/work"));
    expect(post, "no Assign work request").toBeTruthy();
    const body = post!.body as Record<string, unknown>;
    expect(body.assignees).toEqual(["zcw-902", "zcw-903"]);
    expect(body.owner_id).toBe("zcw-903");
    expect(body.new_deliverable).toMatchObject({ title: "Festival aftermovie", drive_url: "https://drive.google.com/folder" });
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
