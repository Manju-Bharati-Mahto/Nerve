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

  it("allocates a deliverable among their own team — and can reassign it", async () => {
    const h = await boot(901);
    const cell = h.ev<string>("delivOwnerCell(proj(7001),deliv(8003))");
    expect(cell).toContain('value="902"');
    expect(cell).toContain('value="903"');
    expect(cell).not.toContain('value="905"');
    expect(h.ev<string>("delivOwnerCell(proj(7001),deliv(8002))")).toMatch(/value="902" selected/);
  });

  it("is offered nothing to allocate on another team's project", async () => {
    const h = await boot(904);
    expect(h.ev<string>("delivOwnerCell(proj(7001),deliv(8003))")).not.toContain("<select");
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

describe("Review — the project's lead, never your own work", () => {
  it("each lead's queue holds their own team's submissions only", async () => {
    const h = await boot(901);
    expect(h.ev<number[]>("pendingVersionReviews().map(x=>x.d.id)")).toEqual([8001]);   // 8005 is their own
    h.as(904);
    expect(h.ev<number[]>("pendingVersionReviews().map(x=>x.d.id)")).toEqual([8004]);
    h.as(902);
    expect(h.ev<number[]>("pendingVersionReviews().map(x=>x.d.id)")).toEqual([]);
  });

  it("the drawer offers Approve to the project's lead only", async () => {
    const h = await boot(901);
    h.ev("drawerDeliverable(8001)");
    expect(h.doc.getElementById("drawer")!.innerHTML).toContain('data-act="approveVersion"');
    for (const who of [904, 902, 906]) {
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

  it("the board refuses another team's lead, an owner, a missing version and an unapproved delivery", async () => {
    const h = await boot(904);
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

  it("the board lets the project's lead approve a submitted version", async () => {
    const h = await boot(901);
    expect(h.ev<boolean>("applyDelivStatus(deliv(8001),'approved')")).toBe(true);
    expect(h.writes().some((c) => c.url.endsWith("/deliverables/8001/status"))).toBe(true);
  });
});
