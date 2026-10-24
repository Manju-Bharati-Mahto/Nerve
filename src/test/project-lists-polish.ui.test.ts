/* ═══════════════════════════════════════════════════════════════════════════
   UI — the project page, the lists, dispatch and Activity say only what
   counts, and offer only what can be done.

     · finished work (delivered, dispatched, archived) keeps its dates: no
       due-date field and no ◷ Schedule on its row, as it keeps its owner;
     · '＋ Add deliverable' and '＋ Assign work' appear once on the
       Deliverables tab;
     · the Coordinator sees no scheduling hint and no ⋯ that only repeats the
       row's own click;
     · Activity drops values that were never set and the actor repeated, and a
       Drive link reads as a Drive link;
     · the dispatch queue says it is oldest first, and since when each waits;
     · My Day's Delivered outputs say dispatched / archived;
     · a column's "17/8" says what the 8 is;
     · delivering review-exempt work not yet started says to start it.

   The real public/media-ops/index.html, in jsdom, with the server replaced by
   a recording fetch. The server's half (dates on finished work, the /deliver
   wording) is in server/mediaops-crew-workflow.integration.test.ts.
   ═══════════════════════════════════════════════════════════════════════════ */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const HTML = readFileSync("public/media-ops/index.html", "utf8");

/* 921 Lead Alpha (Event Team)   922 Emp Anika   926 Coord Chitra   927 Admin Dev */
const FIXTURES = `
  const P=(id,n,r)=>DB.users.unshift({id,real_id:'zpl-'+id,role:r,full_name:n,initials:'ZZ',color:'#888',is_active:true,designation:''});
  P(921,'Lead Alpha','team_lead'); P(922,'Emp Anika','employee'); P(926,'Coord Chitra','coordinator'); P(927,'Admin Dev','admin');
  DB.teams=[{id:9201,name:'Event Team',lead_user_id:921,is_active:true,sort_order:1}];
  DB.team_members=[{team_id:9201,user_id:922}];
  const T=DB.deliverable_types.find(t=>!t.review_exempt), X=DB.deliverable_types.find(t=>t.review_exempt);
  window.__X=X;
  DB.projects.push({id:7201,name:'Annual Cultural Festival',code:'MC-7201',team_id:9201,owner_id:921,created_by:926,
    project_type_id:DB.project_types[0].id,status:'in_production',priority:'high',academic_unit_id:null,academic_year_id:3,
    start_date:TODAY,end_date:TODAY,description:'',tags:[],deleted_at:null});
  DB.project_assignments.push({id:99201,project_id:7201,user_id:922,is_project_manager:false,removed_at:null});
  const dl=(id,title,status,extra)=>DB.deliverables.push(Object.assign({id,project_id:7201,deliverable_type_id:T.id,title,
    owner_id:922,scheduled_date:null,due_date:'2026-10-30',status,priority:'normal',deleted_at:null,weight:1,
    approval_status:'pending',dispatch_status:'none',unit:'',quantity_target:null,quantity_delivered:null,completed_at:null},extra||{}));
  const v=(id,did)=>DB.deliverable_versions.push({id,deliverable_id:did,version_no:1,review_status:'approved',
    submitted_by:922,submitted_at:'2026-10-20T09:00:00Z',drive_url:'https://drive.google.com/'+id,
    reviewed_by:921,reviewed_at:'2026-10-21T09:00:00Z',review_comment:''});
  dl(8201,'Reel','in_progress');
  dl(8202,'Highlights','delivered',{completed_at:'2026-10-22'}); v(88202,8202);
  dl(8203,'Edited Photos','approved',{dispatch_status:'delivered',dispatched_at:'2026-10-24T09:30:00Z',
    dispatch_recipient:'registrar@example.invalid'}); v(88203,8203);
  dl(8204,'Aftermovie','delivered',{completed_at:'2026-10-21',dispatch_status:'archived',
    dispatched_at:'2026-10-22T09:30:00Z',dispatch_recipient:'dean@example.invalid'}); v(88204,8204);
  dl(8205,'Stage Photos','approved',{dispatch_status:'queued',queued_at:'2026-10-23T08:00:00Z'}); v(88205,8205);
  dl(8206,'Group Photo','approved',{dispatch_status:'queued',queued_at:'2026-10-19T08:00:00Z'}); v(88206,8206);
  dl(8207,'Raw Footage','not_started',{deliverable_type_id:X.id});
`;

async function boot(me: number) {
  const calls: Array<{ url: string; method: string }> = [];
  const dom = new JSDOM(HTML, { url: "http://localhost/api/media-ops/#/media/home",
    runScripts: "dangerously", pretendToBeVisual: true });
  const w = dom.window as unknown as { fetch: unknown; eval: (s: string) => unknown };
  w.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), method: String(init?.method ?? "GET") });
    return { ok: true, status: 200, json: async () => ({}) } as Response;
  };
  await new Promise((r) => setTimeout(r, 300));
  const ev = <T,>(e: string) => w.eval(e) as T;
  ev(FIXTURES);
  ev(`S.me=${me}; window.__MO_LIVE__=true;`);
  const html = (s: string) => { const d = dom.window.document.createElement("div"); d.innerHTML = s; return d; };
  const writes = () => calls.filter((c) => c.method !== "GET");
  return { ev, html, writes, doc: dom.window.document, as: (id: number) => ev(`S.me=${id}`) };
}
type H = Awaited<ReturnType<typeof boot>>;
const tab = (h: H) => h.html(h.ev<string>("projDeliverablesTab(proj(7201),projectDeliverables(7201))"));
const row = (el: HTMLElement, id: number) => el.querySelector(`tr[data-drawer="deliverable:${id}"]`) as HTMLElement;

describe("Deliverables tab — finished work keeps its dates", () => {
  it("delivered, dispatched and archived rows show the due date as text, with no ◷ Schedule", async () => {
    const h = await boot(921);
    const t = tab(h);
    expect(row(t, 8201).querySelector("input.due-inline"), "open work lost its due date").not.toBeNull();
    expect(row(t, 8201).querySelector('[data-act="scheduleDeliv"]')).not.toBeNull();
    for (const id of [8202, 8203, 8204]) {
      expect(row(t, id).querySelector("input.due-inline"), String(id)).toBeNull();
      expect(row(t, id).querySelector('[data-act="scheduleDeliv"]'), String(id)).toBeNull();
      expect(row(t, id).textContent, String(id)).toContain("30 Oct 26");
    }
  });

  it("the actions themselves refuse finished work, in the server's words, and send nothing", async () => {
    const h = await boot(921);
    h.ev("ACTIONS.scheduleDeliv({did:'8203'})");
    expect(h.doc.getElementById("sd-owner")).toBeNull();
    h.ev("window.__el={value:'2026-11-02'}; ACTIONS.saveDueDate({did:'8204'},window.__el)");
    expect(h.ev<string>("deliv(8204).due_date")).toBe("2026-10-30");
    expect(h.ev<string>("window.__el.value")).toBe("2026-10-30");
    expect(h.ev<string>("datesLockedMsg(deliv(8202))"))
      .toBe("“Highlights” has already been delivered, so its schedule and due date can't be changed.");
    expect(h.writes()).toEqual([]);
  });
});

describe("Deliverables tab — one of each action, and only usable ones", () => {
  it("'＋ Add deliverable' and '＋ Assign work' appear once on the Deliverables tab", async () => {
    const h = await boot(921);
    const page = h.html(h.ev<string>("viewProject(7201,'deliverables')"));
    expect(page.querySelectorAll('[data-act="addDeliverable"]').length).toBe(1);
    expect(page.querySelectorAll('[data-act="assignWork"]').length).toBe(1);
    expect(page.querySelector('.page-actions [data-act="assignWork"]')).toBeNull();
    // Other tabs keep them in the page header.
    const over = h.html(h.ev<string>("viewProject(7201,'overview')"));
    expect(over.querySelector('.page-actions [data-act="assignWork"]')).not.toBeNull();
  });

  it("the Coordinator sees no scheduling hint and no ⋯ that only opens the drawer", async () => {
    const h = await boot(926);
    const t = tab(h);
    expect(t.querySelector(".card-foot")).toBeNull();
    expect(t.querySelectorAll('[data-act="delivAction"]').length).toBe(0);
    expect(t.querySelectorAll('[data-act="scheduleDeliv"]').length).toBe(0);
  });

  it("the project's lead keeps both, and ⋯ only where it holds a scope move", async () => {
    const h = await boot(921);
    const t = tab(h);
    expect(t.querySelector(".card-foot")?.textContent).toContain("Schedule a deliverable");
    expect(row(t, 8201).querySelector('[data-act="delivAction"]')).not.toBeNull();
    expect(row(t, 8202).querySelector('[data-act="delivAction"]'), "delivered work has no scope move").toBeNull();
  });
});

describe("Activity — only what the headline does not say", () => {
  it("a sign-off drops 'Note: none' and the approver who is the actor", async () => {
    const h = await boot(921);
    const ch = h.ev<string[]>(`auditChanges({action:'deliverable.approval_changed',entity_type:'deliverable',entity_id:8202,
      actor:'Lead Alpha',before:{approval_status:'pending'},
      after:{approval_status:'approved',approved_by:'zpl-921',approved_by_role:'team_lead',note:null}})`);
    expect(ch.join(" | ")).not.toMatch(/Note|Approved by/);
    expect(ch.length).toBe(1);
    // Someone else's name is news, and stays.
    expect(h.ev<string[]>(`auditChanges({action:'deliverable.approval_changed',entity_type:'deliverable',entity_id:8202,
      actor:'Admin Dev',before:{approval_status:'pending'},after:{approval_status:'approved',approved_by:'zpl-921'}})`))
      .toContain("Approved by: Lead Alpha");
  });

  it("an assignment with no deliverable has no 'Owner: none'", async () => {
    const h = await boot(921);
    const ch = h.ev<string[]>(`auditChanges({action:'work.assigned',entity_type:'assignment',entity_id:70,
      actor:'Lead Alpha',before:null,after:{title:'Lighting check',owner_id:null,assignees:['zpl-922']}})`);
    expect(ch.join(" | ")).not.toContain("none");
  });

  it("adding a project Drive link reads 'added a Drive link to <project>', with the link", async () => {
    const h = await boot(921);
    const a = `({action:'drive_link.added',entity_type:'project',entity_id:7201,actor:'Lead Alpha',before:null,
      after:{url:'https://drive.google.com/drive/folders/zpl'}})`;
    expect(h.ev<string>(`auditText(${a})`)).toBe("added a Drive link to Annual Cultural Festival");
    expect(h.ev<string[]>(`auditChanges(${a})`)).toEqual(["Link: https://drive.google.com/drive/folders/zpl"]);
  });
});

describe("Dispatch queue — oldest first, and it says so", () => {
  it("each row says since when it has waited, oldest at the top, with a note saying so", async () => {
    const h = await boot(926);
    const page = h.html(h.ev<string>("viewDispatch()"));
    const ids = [...page.querySelectorAll("[data-dispatch-did]")].map((n) => (n as HTMLElement).dataset.dispatchDid);
    expect(ids.indexOf("8206")).toBeLessThan(ids.indexOf("8205"));
    expect(page.querySelector("[data-queue-order]")?.textContent).toMatch(/^Oldest first/);
    const since = (id: string) => page.querySelector(`[data-dispatch-did="${id}"] [data-waiting]`)?.textContent;
    expect(since("8206")).toBe("Waiting since 19 Oct 26");
    expect(since("8205")).toBe("Waiting since 23 Oct 26");
  });
});

describe("My Day — Delivered outputs say where the work went", () => {
  it("dispatched and archived rows say so; work not yet out says nothing more", async () => {
    const h = await boot(922);
    const card = [...h.html(h.ev<string>("viewMyDay()")).querySelectorAll(".card")]
      .find((c) => c.querySelector("h3")?.textContent === "Delivered outputs") as HTMLElement;
    const r = (title: string) => [...card.querySelectorAll(".dlv")]
      .find((n) => n.querySelector(".dlv-title")?.textContent === title) as HTMLElement;
    expect(r("Edited Photos").querySelector("[data-dispatch]")?.textContent)
      .toBe("Dispatched 24 Oct 26 to registrar@example.invalid");
    expect(r("Aftermovie").querySelector("[data-dispatch]")?.textContent)
      .toBe("Dispatched 22 Oct 26 to dean@example.invalid · Archived");
    expect(r("Highlights").querySelector("[data-dispatch]")).toBeNull();
  });
});

describe("Boards — a column's limit is labelled", () => {
  it("the pipeline's In review count says what its limit is", async () => {
    const h = await boot(927);
    const kc = [...h.html(h.ev<string>("viewPipeline()")).querySelectorAll(".kb-col")]
      .find((c) => c.getAttribute("data-drop") === "delivstatus:in_review")!.querySelector(".kc") as HTMLElement;
    const n = Number(kc.textContent!.split("/")[0]);
    expect(kc.textContent).toBe(`${n}/8`);
    expect(kc.getAttribute("title")).toBe(`${n} in review — limit 8`);
    expect(kc.getAttribute("aria-label")).toBe(`${n} in review — limit 8`);
  });

  it("a management board column with a limit says so; one without has a plain count", async () => {
    const h = await boot(927);
    h.ev("S.board=1");
    const cols = [...h.html(h.ev<string>("viewBoards()")).querySelectorAll(".kb-col .kc")] as HTMLElement[];
    const limited = cols.find((c) => c.textContent!.includes("/"))!;
    expect(limited.getAttribute("title")).toMatch(/^\d+ cards? — limit 6$/);
    expect(cols.find((c) => !c.textContent!.includes("/"))!.hasAttribute("title")).toBe(false);
  });
});

describe("Mark delivered — review-exempt work not yet started", () => {
  it("is told to start it first, as the server says", async () => {
    const h = await boot(922);
    expect(h.ev<boolean>("canMarkDelivered(deliv(8207))")).toBe(false);
    expect(h.ev<string>("delivMoveRefusal(deliv(8207),'delivered')"))
      .toBe("Start it first — raw footage can be delivered once it is in progress.");
  });
});
