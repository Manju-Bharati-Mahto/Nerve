/* ═══════════════════════════════════════════════════════════════════════════
   UI — what a project says about its work, in plain words.

     · Activity tells each version's story: "submitted v2 of …",
       "requested changes on v1 of …" with the comment, "approved v2 of …" —
       from the server's feed, for versions the page never loaded;
     · Activity names people, never their ids, and leaves out role codes;
     · the Deliverables tab and the drawer say when work was dispatched, to
       whom, and when it was archived;
     · New project's Type picker is in the catalogue's order.

   The real public/media-ops/index.html, in jsdom, with the server replaced by
   a recording fetch. The feed itself is proven against a real database in
   server/mediaops-activity-notices.integration.test.ts.
   ═══════════════════════════════════════════════════════════════════════════ */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const HTML = readFileSync("public/media-ops/index.html", "utf8");

/* 951 Lead Alpha   952 Emp Anika   953 Coord Chitra — ids far from the seed. */
const FIXTURES = `
  const P=(id,n,r)=>DB.users.unshift({id,real_id:'zq3-'+id,role:r,full_name:n,initials:'ZZ',color:'#888',is_active:true,designation:''});
  P(951,'Lead Alpha','team_lead'); P(952,'Emp Anika','employee'); P(953,'Coord Chitra','coordinator');
  DB.teams.push({id:9501,name:'Event Team',lead_user_id:951,is_active:true,sort_order:1});
  const T=DB.deliverable_types.find(t=>!t.review_exempt)||DB.deliverable_types[0];
  DB.projects.push({id:7501,name:'Annual Cultural Festival',code:'MC-7501',team_id:9501,owner_id:951,created_by:953,
    project_type_id:DB.project_types[0].id,status:'in_production',priority:'high',academic_unit_id:null,academic_year_id:3,
    start_date:TODAY,end_date:TODAY,description:'',tags:[],deleted_at:null});
  const dl=(id,title,extra)=>DB.deliverables.push(Object.assign({id,project_id:7501,deliverable_type_id:T.id,title,
    owner_id:952,scheduled_date:null,due_date:TODAY,status:'delivered',priority:'normal',deleted_at:null,
    approval_status:'approved',unit:'',quantity_target:null,quantity_delivered:null,weight:1,dispatch_status:'none'},extra));
  dl(8501,'Edited Photos',{dispatch_status:'delivered',dispatched_at:'2026-10-24T09:30:00Z',dispatch_recipient:'registrar@example.invalid'});
  dl(8502,'Aftermovie',{dispatch_status:'archived',dispatched_at:'2026-10-22T09:30:00Z',dispatch_recipient:'dean@example.invalid'});
  dl(8503,'Stage Video',{status:'approved',approval_status:'pending',dispatch_status:'queued'});
  dl(8504,'Reel',{status:'in_progress',approval_status:'pending'});
`;

async function boot(me: number) {
  const dom = new JSDOM(HTML, { url: "http://localhost/api/media-ops/#/media/home",
    runScripts: "dangerously", pretendToBeVisual: true });
  const w = dom.window as unknown as { fetch: unknown; eval: (s: string) => unknown };
  w.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) }) as Response;
  await new Promise((r) => setTimeout(r, 300));
  const ev = <T,>(e: string) => w.eval(e) as T;
  ev(FIXTURES);
  ev(`S.me=${me}; window.__MO_LIVE__=true;`);
  return { ev, doc: dom.window.document };
}
const text = (html: string) => html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ");

describe("project Activity — a version's story", () => {
  /* Rows as GET /projects/:id/activity sends them: the version is not in DB. */
  const row = (action: string, version: number, after: Record<string, unknown>) =>
    `({action:'${action}',entity_type:'deliverable_version',entity_id:99${version},actor:'Lead Alpha',
       version_no:${version},deliverable_title:'Photos — Edited',before:null,after:${JSON.stringify(after)},
       occurred_at:TODAY+'T09:00:00Z'})`;

  it("names the version and its deliverable, and says the verdict", async () => {
    const h = await boot(951);
    expect(h.ev<string>(`auditText(${row("deliverable.version_submitted", 2, { version_no: 2 })})`))
      .toBe("submitted v2 of Photos — Edited");
    expect(h.ev<string>(`auditText(${row("deliverable.version_reviewed", 1,
      { review_status: "changes_requested", review_comment: "Brighten the stage shots" })})`))
      .toBe("requested changes on v1 of Photos — Edited");
    expect(h.ev<string>(`auditText(${row("deliverable.version_reviewed", 2, { review_status: "approved" })})`))
      .toBe("approved v2 of Photos — Edited");
  });

  it("a send-back shows what to change, and nothing the sentence already says", async () => {
    const h = await boot(951);
    expect(h.ev<string[]>(`auditChanges(${row("deliverable.version_reviewed", 1,
      { review_status: "changes_requested", review_comment: "Brighten the stage shots" })})`))
      .toEqual(["Comment: Brighten the stage shots"]);
    expect(h.ev<string[]>(`auditChanges(${row("deliverable.version_submitted", 2, { version_no: 2 })})`)).toEqual([]);
  });

  it("the Activity tab shows them from the server's feed", async () => {
    const h = await boot(951);
    h.ev(`S._projActs={7501:{rows:[${row("deliverable.version_reviewed", 2, { review_status: "approved" })},
      ${row("deliverable.version_submitted", 2, { version_no: 2 })}]}}`);
    const t = text(h.ev<string>("projActivityTab(proj(7501))"));
    expect(t).toContain("approved v2 of Photos — Edited");
    expect(t).toContain("submitted v2 of Photos — Edited");
  });
});

describe("project Activity — people by name, no codes", () => {
  it("Assign work's new deliverable names who it went to", async () => {
    const h = await boot(951);
    expect(h.ev<string[]>(`auditChanges({action:'deliverable.created',entity_type:'deliverable',entity_id:8504,before:null,
      after:{title:'Reel',owner_id:'zq3-952',team:['zq3-952'],via:'assign_work'}})`))
      .toEqual(["Owner: Emp Anika", "Assigned to: Emp Anika", "How: Assign work"]);
  });

  it("a due-date change names who changed it", async () => {
    const h = await boot(951);
    expect(h.ev<string[]>(`auditChanges({action:'deliverable.due_date_changed',entity_type:'deliverable',entity_id:8504,
      before:{due_date:null},after:{due_date:'2026-10-29',due_date_source:'manual',changed_by:'zq3-951',via:'assign_work'}})`))
      .toEqual(["Due: none → 29 Oct 26", "Changed by: Lead Alpha", "How: Assign work"]);
  });

  it("a sign-off names the person, not the role they acted in", async () => {
    const h = await boot(951);
    const ch = h.ev<string[]>(`auditChanges({action:'deliverable.approval_changed',entity_type:'deliverable',entity_id:8501,
      before:{approval_status:'pending',status:'delivered'},
      after:{approval_status:'approved',approved_by:'zq3-951',approved_by_role:'team_lead',note:''}})`);
    expect(ch).toContain("Approved by: Lead Alpha");
    expect(ch.join(" ")).not.toMatch(/team_lead|role/i);
  });
});

describe("dispatch and archive — on the project and in the drawer", () => {
  it("the Deliverables tab says when each went out, to whom, and what is archived", async () => {
    const h = await boot(953);
    const tab = h.ev<string>("projDeliverablesTab(proj(7501),projectDeliverables(7501))");
    const rowOf = (id: number) => text(tab.split(`data-drawer="deliverable:${id}"`)[1].split("</tr>")[0]);
    expect(rowOf(8501)).toContain("Dispatched 24 Oct 26 to registrar@example.invalid");
    expect(rowOf(8502)).toContain("Dispatched 22 Oct 26 to dean@example.invalid · Archived");
    expect(rowOf(8503)).toContain("Queued for dispatch");
    expect(rowOf(8504)).not.toMatch(/Dispatch|Archived|Queued/);
  });

  it("the drawer says it too", async () => {
    const h = await boot(953);
    h.ev("drawerDeliverable(8501)");
    expect(h.doc.querySelector("#drawer [data-dispatch]")?.textContent)
      .toBe("Dispatched 24 Oct 26 to registrar@example.invalid");
    h.ev("drawerDeliverable(8504)");
    expect(h.doc.querySelector("#drawer [data-dispatch]")).toBeNull();
  });
});

describe("New project — Type in the catalogue's order", () => {
  it("lists project types by sort_order, whatever order they arrived in", async () => {
    const h = await boot(953);
    h.ev(`DB.project_types=[
      {id:7,name:'Internal',icon:'',is_active:true,sort_order:7},{id:8,name:'Other',icon:'',is_active:true,sort_order:8},
      {id:1,name:'Annual University Event',icon:'',is_active:true,sort_order:1},
      {id:2,name:'Educational Tour',icon:'',is_active:true,sort_order:2}]`);
    h.ev("openNewProject()");
    const opts = [...h.doc.querySelectorAll("#np-type option")].map((o) => (o as HTMLOptionElement).value).filter(Boolean);
    expect(opts).toEqual(["1", "2", "7", "8"]);
  });
});
