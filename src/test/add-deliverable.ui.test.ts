/* ═══════════════════════════════════════════════════════════════════════════
   UI — "＋ Add deliverable" on an existing project, the labelled deliverable
   row it shares with New project, and who the assignment pickers offer.

   The real public/media-ops/index.html, in jsdom, with the server replaced by
   a recording fetch. The authority is proven against a real database in
   server/mediaops-add-deliverable.integration.test.ts; what is pinned here is
   that the page offers the same thing the server honours.
   ═══════════════════════════════════════════════════════════════════════════ */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const HTML = readFileSync("public/media-ops/index.html", "utf8");

/*   901 Lead A (Event Team)   902 Emp A1   903 Emp A2
     904 Lead B (Video Team)   906 Coordinator   907 Admin                     */
const FIXTURES = `
  const P=(id,n,r)=>DB.users.unshift({id,real_id:'zdl-'+id,role:r,full_name:n,initials:'ZZ',color:'#888',is_active:true,designation:''});
  P(901,'Lead Alpha','team_lead'); P(902,'Emp Anika','employee'); P(903,'Emp Arjun','employee');
  P(904,'Lead Bravo','team_lead'); P(906,'Coord Chitra','coordinator'); P(907,'Admin Dev','admin');
  DB.teams=[{id:9001,name:'Event Team',lead_user_id:901,is_active:true,sort_order:1},
            {id:9002,name:'Video Team',lead_user_id:904,is_active:true,sort_order:2}];
  DB.team_members=[{team_id:9001,user_id:902},{team_id:9001,user_id:903}];
  const T=DB.deliverable_types.find(t=>t.is_active!==false&&!t.archived_at)||DB.deliverable_types[0];
  window.__T=T;
  const proj=(id,name,team,owner,status)=>DB.projects.push({id,name,code:'MC-'+id,team_id:team,owner_id:owner,created_by:906,
    project_type_id:DB.project_types[0].id,status:status||'in_production',priority:'high',academic_unit_id:null,academic_year_id:3,
    start_date:TODAY,end_date:TODAY,description:'',tags:[],deleted_at:null});
  proj(7001,'Annual Cultural Festival',9001,901);
  proj(7004,'Last Year Recap',9001,901,'completed');
  proj(7005,'Anika Reel',null,902);
  DB.project_assignments.push({id:99001,project_id:7001,user_id:901,is_project_manager:true,removed_at:null},
                              {id:99003,project_id:7001,user_id:903,is_project_manager:false,removed_at:null});
  DB.deliverables.push({id:8001,project_id:7001,deliverable_type_id:T.id,title:T.name,owner_id:902,
    due_date:TODAY,status:'not_started',priority:'normal',deleted_at:null,unit:'',quantity_target:null,quantity_delivered:null});
`;

async function boot(me: number) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const dom = new JSDOM(HTML, { url: "http://localhost/api/media-ops/#/media/home",
    runScripts: "dangerously", pretendToBeVisual: true });
  const w = dom.window as unknown as { fetch: unknown; eval: (s: string) => unknown };
  w.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), method: String(init?.method ?? "GET"),
                 body: init?.body ? JSON.parse(String(init.body)) : null });
    return { ok: true, status: 200, json: async () => ({}) } as Response;
  };
  await new Promise((r) => setTimeout(r, 300));
  const ev = <T,>(e: string) => w.eval(e) as T;
  ev(FIXTURES);
  ev(`S.me=${me}; window.__MO_LIVE__=true;`);
  const writes = () => calls.filter((c) => c.method !== "GET");
  return { ev, writes, doc: dom.window.document };
}

describe("＋ Add deliverable on an existing project", () => {
  it("is offered to the Coordinator, the project's lead, an Admin and an employee on their own project — no one else", async () => {
    const h = await boot(906);
    const offered = (me: number, pid: number) => {
      h.ev(`S.me=${me}`);
      return h.ev<string>(`projDeliverablesTab(proj(${pid}),[])`).includes('data-act="addDeliverable"');
    };
    expect(offered(906, 7001)).toBe(true);
    expect(offered(901, 7001)).toBe(true);
    expect(offered(907, 7001)).toBe(true);
    expect(offered(902, 7005)).toBe(true);
    expect(offered(904, 7001), "another team's lead").toBe(false);
    expect(offered(903, 7001), "a crew employee").toBe(false);
    expect(offered(906, 7004), "a completed project").toBe(false);
  });

  /* "Day" is there only for a multi-day event (an event-day test covers it). */
  it("opens New project's row, with a visible label on every field", async () => {
    const h = await boot(906);
    h.ev("openAddDeliverable(7001)");
    const layer = h.doc.getElementById("modal-layer")!;
    const rows = layer.querySelectorAll(".np-d");
    expect(rows.length).toBe(1);
    const labels = [...rows[0].querySelectorAll("label:not([hidden]) > span")].map((s) => s.textContent);
    expect(labels).toEqual(["Type", "Priority", "Due (optional)", "Effort h (optional)"]);
    expect((rows[0].querySelector(".np-d-pri") as HTMLSelectElement).value).toBe("normal");
    // New project draws the same row.
    h.ev("closeModal(); openNewProject(); ACTIONS.npAddDeliverable()");
    const np = [...h.doc.querySelectorAll("#np-delivs .np-d label:not([hidden]) > span")].map((s) => s.textContent);
    // New project starts as a week-long run, so its days are offered.
    expect(np).toEqual(["Type", "Assigned to", "Day", "Due (optional)", "Effort h (optional)"]);
  });

  it("sends each row unassigned, titled by its type and numbered after what the project has", async () => {
    const h = await boot(906);
    h.ev("openAddDeliverable(7001); ACTIONS.npAddDeliverable()");
    h.ev(`document.querySelectorAll('#np-delivs .np-d-type').forEach(s=>s.value=String(__T.id))`);
    h.ev(`ACTIONS.saveDeliverables({pid:'7001'})`);
    await new Promise((r) => setTimeout(r, 50));
    const posts = h.writes().filter((c) => c.url.endsWith("/projects/7001/deliverables"));
    const name = h.ev<string>("__T.name");
    expect(posts.map((c) => (c.body as Record<string, unknown>).title)).toEqual([`${name} (2)`, `${name} (3)`]);
    for (const c of posts) {
      expect(c.body).toMatchObject({ priority: "normal", due_date: null, estimated_hours: null });
      expect(c.body).not.toHaveProperty("owner_id");
    }
  });

  /* Owner's decision (24 Oct 2026): whoever may assign on the project names
     who makes each row in place of its priority, and that person has it in
     My deliverables and Today's assignments, due on the row's date. */
  it("asks whoever may assign who makes each row, and gives it as Assign work does", async () => {
    const h = await boot(901);
    h.ev("openAddDeliverable(7001); ACTIONS.npAddDeliverable()");
    const layer = h.doc.getElementById("modal-layer")!;
    expect(layer.querySelector(".mo-head p")!.textContent).toMatch(/Today’s assignments/);
    const rows = layer.querySelectorAll(".np-d");
    expect([...rows[0].querySelectorAll("label:not([hidden]) > span")].map((s) => s.textContent))
      .toEqual(["Type", "Assigned to", "Due (optional)", "Effort h (optional)"]);
    expect(rows[0].querySelector(".np-d-pri"), "priority is replaced by an assignee").toBeNull();
    h.ev(`document.querySelectorAll('#np-delivs .np-d-type').forEach(s=>s.value=String(__T.id))`);
    const own = rows[0].querySelector(".np-d-owner") as HTMLSelectElement;
    own.value = "903";
    (rows[0].querySelector(".np-d-due") as HTMLInputElement).value = "2026-11-02";
    (rows[0].querySelector(".np-d-est") as HTMLInputElement).value = "3";
    h.ev(`ACTIONS.saveDeliverables({pid:'7001'})`);
    await new Promise((r) => setTimeout(r, 50));
    const name = h.ev<string>("__T.name");
    const work = h.writes().filter((c) => c.url.endsWith("/projects/7001/work"));
    expect(work.length).toBe(1);
    expect(work[0].body).toMatchObject({ title: `${name} (2)`, assignees: ["zdl-903"], owner_id: "zdl-903",
      due_date: "2026-11-02", priority: "normal",
      new_deliverable: { deliverable_type_id: h.ev<number>("__T.id"), title: `${name} (2)`,
        due_date: "2026-11-02", estimated_hours: 3 } });
    const plain = h.writes().filter((c) => c.url.endsWith("/projects/7001/deliverables"));
    expect(plain.map((c) => (c.body as Record<string, unknown>).owner_id), "the untouched row stays unassigned")
      .toEqual([undefined]);
    // Straight away: theirs, in their day, due when the row said.
    const did = h.ev<number>(`DB.deliverables.find(d=>d.title===${JSON.stringify(`${name} (2)`)}).id`);
    expect(h.ev<number>(`deliv(${did}).owner_id`)).toBe(903);
    expect(h.ev<number[]>("openDeliverables(903).map(d=>d.id)")).toContain(did);
    expect(h.ev<Array<{ deliverable_id: number; due_date: string }>>(
      "myAssignments(903).map(a=>({deliverable_id:a.deliverable_id,due_date:a.due_date}))"))
      .toContainEqual({ deliverable_id: did, due_date: "2026-11-02" });
  });

  it("keeps the Coordinator's rows unassigned, with a priority", async () => {
    const h = await boot(906);
    h.ev("openAddDeliverable(7001)");
    const layer = h.doc.getElementById("modal-layer")!;
    expect(layer.querySelector(".np-d-owner"), "the Coordinator never names individuals").toBeNull();
    expect(layer.querySelector(".mo-head p")!.textContent).toMatch(/added unassigned/);
  });
});

describe("assignment pickers list production workers", () => {
  it("leave out Admins and the Coordinator until an Admin gives them the production_worker duty", async () => {
    const h = await boot(901);
    const ids = () => h.ev<number[]>("assignableMembers().map(u=>u.id)");
    expect(ids()).toContain(902);
    expect(ids()).not.toContain(907);
    expect(ids()).not.toContain(906);
    h.ev(`DB.duty_flags.push({id:95,code:'production_worker',name:'Production worker'});
          DB.user_duties.push({user_id:907,duty_flag_id:95},{user_id:906,duty_flag_id:95})`);
    expect(ids()).toContain(907);
    expect(ids()).toContain(906);
    // The Admin's own list follows the same rule.
    h.ev("S.me=907; DB.user_duties=DB.user_duties.filter(d=>d.user_id!==907)");
    expect(ids()).not.toContain(907);
    expect(ids()).toContain(906);
  });
});
