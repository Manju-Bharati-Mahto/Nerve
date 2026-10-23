/* ═══════════════════════════════════════════════════════════════════════════
   UI — a project's status, as the page shows it and offers to change it.

     · the project status 'delivered' reads "Ready to dispatch" wherever it is
       shown — the work is approved, not yet out;
     · projProgress() mirrors the server's forward-only rule for display, over
       mixed and incomplete sets of deliverables;
     · Completed is offered only when every deliverable is out or signed off,
       or to an Admin, who must give a reason (sent as override_reason);
     · nothing proposes a project any more: the Kanban shows a Proposed column
       only while a legacy one is waiting, and the permissions matrix says so.

   The real public/media-ops/index.html, in jsdom, with the server replaced by
   a recording fetch. The rule itself is proven against a real database in
   server/mediaops-project-progress.integration.test.ts.
   ═══════════════════════════════════════════════════════════════════════════ */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const HTML = readFileSync("public/media-ops/index.html", "utf8");

/*   911 Lead Alpha (Event Team)   912 Emp Anika   913 Lead Bravo   917 Admin Dev
     7101 a project ready to dispatch: one dispatched, one approved and queued   */
const FIXTURES = `
  const P=(id,n,r)=>DB.users.unshift({id,real_id:'zpg-'+id,role:r,full_name:n,initials:'ZZ',color:'#888',is_active:true,designation:''});
  P(911,'Lead Alpha','team_lead'); P(912,'Emp Anika','employee'); P(913,'Lead Bravo','team_lead'); P(917,'Admin Dev','admin');
  DB.teams=[{id:9101,name:'Event Team',lead_user_id:911,is_active:true,sort_order:1},
            {id:9102,name:'Video Team',lead_user_id:913,is_active:true,sort_order:2}];
  DB.team_members=[{team_id:9101,user_id:912}];
  const T=DB.deliverable_types.find(t=>!t.review_exempt)||DB.deliverable_types[0];
  DB.projects.push({id:7101,name:'Convocation Film',code:'MC-7101',team_id:9101,owner_id:911,created_by:911,
    project_type_id:DB.project_types[0].id,status:'delivered',priority:'normal',academic_unit_id:null,academic_year_id:3,
    start_date:TODAY,end_date:TODAY,description:'',tags:[],deleted_at:null});
  DB.project_assignments.push({id:99101,project_id:7101,user_id:911,is_project_manager:true,removed_at:null});
  window.__dl=(id,status,extra)=>DB.deliverables.push(Object.assign({id,project_id:7101,deliverable_type_id:T.id,
    title:'Cut '+id,owner_id:912,scheduled_date:null,due_date:TODAY,status,priority:'normal',deleted_at:null,weight:1,
    approval_status:'pending',dispatch_status:'none',unit:'',quantity_target:null,quantity_delivered:null},extra||{}));
  __dl(8101,'approved',{dispatch_status:'delivered'});
  __dl(8102,'approved',{dispatch_status:'queued'});
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
  const writes = () => calls.filter((c) => c.method !== "GET");
  return { dom, ev, writes, doc: dom.window.document };
}

/** Replace project 7101's deliverables, then ask what the page would show. */
const shown = (h: Awaited<ReturnType<typeof boot>>, from: string, rows: string) => h.ev<string>(`
  DB.deliverables=DB.deliverables.filter(d=>d.project_id!==7101); ${rows}
  proj(7101).status='${from}'; projProgress(proj(7101))`);

describe("the project status 'delivered' reads Ready to dispatch", () => {
  it("in the status map, on the project page and in the list", async () => {
    const h = await boot(911);
    expect(h.ev<string>("PROJ_STATUS.delivered.l")).toBe("Ready to dispatch");
    const page = h.ev<string>("viewProject(7101,'overview')");
    expect(page).toContain("Ready to dispatch");
    expect(h.ev<string>("projList([proj(7101)])")).toContain("Ready to dispatch");
  });
});

describe("projProgress — the server's forward-only rule, for display", () => {
  it("leaves a project alone while nothing has started", async () => {
    const h = await boot(911);
    expect(shown(h, "planning", "__dl(1,'not_started');__dl(2,'not_started');")).toBe("planning");
    expect(shown(h, "planning", "")).toBe("planning");
  });

  it("puts started work in production, even beside approved work", async () => {
    const h = await boot(911);
    expect(shown(h, "planning", "__dl(1,'in_review');__dl(2,'not_started');")).toBe("in_production");
    expect(shown(h, "planning", "__dl(1,'approved',{dispatch_status:'queued'});__dl(2,'in_progress');")).toBe("in_production");
  });

  it("all approved is ready to dispatch; a delivered item waiting for sign-off keeps it there", async () => {
    const h = await boot(911);
    expect(shown(h, "in_production", "__dl(1,'approved',{dispatch_status:'queued'});__dl(2,'approved',{dispatch_status:'delivered'});"))
      .toBe("delivered");
    expect(shown(h, "in_production", "__dl(1,'delivered',{dispatch_status:'delivered'});__dl(2,'approved',{dispatch_status:'delivered'});"))
      .toBe("delivered");
  });

  it("everything out or signed off is completed; cancelled and not-needed work is left out", async () => {
    const h = await boot(911);
    expect(shown(h, "delivered", "__dl(1,'approved',{dispatch_status:'archived'});__dl(2,'delivered',{approval_status:'approved'});"
      + "__dl(3,'cancelled');__dl(4,'not_required');")).toBe("completed");
    expect(shown(h, "planning", "__dl(1,'cancelled');__dl(2,'not_required');")).toBe("planning");
  });

  it("a send-back returns a ready-to-dispatch project to production, but never moves in review back", async () => {
    const h = await boot(911);
    expect(shown(h, "delivered", "__dl(1,'changes_requested',{approval_status:'changes_requested'});__dl(2,'approved');"))
      .toBe("in_production");
    expect(shown(h, "in_review", "__dl(1,'in_progress');")).toBe("in_review");
  });

  it("never touches on hold, cancelled, archived, proposed or completed", async () => {
    const h = await boot(911);
    for (const held of ["on_hold", "cancelled", "archived", "proposed", "completed"])
      expect(shown(h, held, "__dl(1,'approved',{dispatch_status:'delivered'});")).toBe(held);
  });
});

describe("Completed — offered only when the work is out, or to an Admin with a reason", () => {
  it("the project's lead is not offered Completed while an item is still queued", async () => {
    const h = await boot(911);
    expect(h.ev<string[]>("projectStatusMoves(proj(7101))")).not.toContain("completed");
    expect(h.ev<string[]>("projectClosureBlockers(proj(7101)).map(x=>x.d.title+' '+x.why)"))
      .toEqual(["Cut 8102 has not been dispatched yet"]);
    h.ev("DB.deliverables.find(d=>d.id===8102).dispatch_status='delivered'");
    expect(h.ev<string[]>("projectStatusMoves(proj(7101))")).toContain("completed");
  });

  it("an Admin is offered it, and must say why before anything is sent", async () => {
    const h = await boot(917);
    const items = h.ev<Array<{ label?: string }>>("MENUS.projStatus({pid:7101})");
    const i = items.findIndex((x) => x.label === "Completed");
    expect(i).toBeGreaterThan(-1);
    h.ev(`MENUS.projStatus({pid:7101})[${i}].fn()`);
    expect(h.doc.querySelector("#cp-open")?.textContent).toContain("Cut 8102");
    (h.doc.querySelector("#cp-go") as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 20));
    expect(h.writes()).toEqual([]);
    expect(h.ev<string>("proj(7101).status")).toBe("delivered");
    (h.doc.querySelector("#cp-reason") as HTMLTextAreaElement).value = "Client took the rest in person";
    (h.doc.querySelector("#cp-go") as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 20));
    const w = h.writes().find((c) => c.url.endsWith("/projects/7101/status"));
    expect(w?.body).toEqual({ status: "completed", override_reason: "Client took the rest in person" });
  });

  it("with nothing open, Completed is a plain move with no reason asked", async () => {
    const h = await boot(911);
    h.ev("DB.deliverables.find(d=>d.id===8102).dispatch_status='delivered'");
    const items = h.ev<Array<{ label?: string }>>("MENUS.projStatus({pid:7101})");
    const i = items.findIndex((x) => x.label === "Completed");
    h.ev(`MENUS.projStatus({pid:7101})[${i}].fn()`);
    await new Promise((r) => setTimeout(r, 20));
    expect(h.doc.querySelector("#cp-reason")).toBeNull();
    expect(h.writes().find((c) => c.url.endsWith("/projects/7101/status"))?.body).toEqual({ status: "completed" });
  });
});

describe("no new proposals", () => {
  it("the Kanban shows a Proposed column only while a proposed project exists", async () => {
    const h = await boot(917);
    expect(h.ev<string>("projKanban([proj(7101)])")).not.toContain('data-drop="projstatus:proposed"');
    h.ev("proj(7101).status='proposed'");
    expect(h.ev<string>("projKanban([proj(7101)])")).toContain('data-drop="projstatus:proposed"');
  });

  it("the permissions matrix no longer sends a new project for approval", async () => {
    const h = await boot(917);
    const m = h.ev<string>("admPermissions()");
    expect(m).not.toContain("→ approval");
    expect(m).not.toContain("Approve proposed projects");
  });
});

describe("a sign-off send-back is answered by the next approval", () => {
  it("approving the resubmitted version clears the send-back, so the item is ready to dispatch again", async () => {
    const h = await boot(913);
    h.ev(`__dl(8103,'in_review',{approval_status:'changes_requested'});
      DB.deliverable_versions.push({id:98103,deliverable_id:8103,version_no:2,review_status:'pending',
        submitted_by:912,submitted_at:TODAY,drive_url:'https://drive.google.com/zpg-8103'})`);
    h.ev("ACTIONS.approveVersion({did:'8103'})");
    expect(h.ev<string>("deliv(8103).approval_status")).toBe("pending");
    expect(h.ev<string>("deliv(8103).dispatch_status")).toBe("queued");
    expect(h.ev<string>("delivClosureBlocker(deliv(8103))")).toBe("has not been dispatched yet");
    expect(h.writes().find((c) => c.url.endsWith("/deliverables/8103/review"))?.body).toEqual({ outcome: "approved" });
  });

  it("work already dispatched and then sent back is out of the dispatched state, and is queued again on approval", async () => {
    const h = await boot(913);
    h.ev(`__dl(8104,'delivered',{dispatch_status:'delivered',delivered_by:912});
      DB.deliverable_versions.push({id:98104,deliverable_id:8104,version_no:1,review_status:'approved',
        submitted_by:912,submitted_at:TODAY,drive_url:'https://drive.google.com/zpg-8104'})`);
    h.ev("ACTIONS.reviewDelivered({did:'8104',v:'changes_requested'})");
    h.ev("document.querySelector('#rd-note').value='Wrong logo'");
    h.ev("ACTIONS.confirmSignOff({did:'8104',v:'changes_requested'})");
    expect(h.ev<string>("deliv(8104).dispatch_status")).toBe("none");
    expect(h.ev<string>("delivClosureBlocker(deliv(8104))")).toBe("was sent back for changes");
    h.ev(`DB.deliverable_versions.push({id:98105,deliverable_id:8104,version_no:2,review_status:'pending',
        submitted_by:912,submitted_at:TODAY,drive_url:'https://drive.google.com/zpg-8104b'}); deliv(8104).status='in_review'`);
    h.ev("ACTIONS.approveVersion({did:'8104'})");
    expect(h.ev<string>("deliv(8104).dispatch_status")).toBe("queued");
    expect(h.ev<string>("delivClosureBlocker(deliv(8104))")).toBe("has not been dispatched yet");
  });
});
