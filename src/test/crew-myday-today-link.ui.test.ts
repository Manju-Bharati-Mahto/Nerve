/* ═══════════════════════════════════════════════════════════════════════════
   UI — Today's assignments and My deliverables are one piece of work.

     · work Assign work put on a deliverable is on every assignee's day from
       its start until one of them submits the Drive link — past its due date
       too, marked overdue — and back, with the reviewer's comment, when
       changes are asked for;
     · plain work stays until it is done; logging it today does not hide it;
     · the Today's assignment card submits the version itself, through the
       same modal and endpoint My deliverables uses, and the work moves to
       My deliverables as Awaiting review at once.

   The real public/media-ops/index.html, in jsdom, with the server replaced by
   a recording fetch. The server's half (the work rows follow the versions) is
   in server/mediaops-crew-workflow.integration.test.ts.
   ═══════════════════════════════════════════════════════════════════════════ */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const HTML = readFileSync("public/media-ops/index.html", "utf8");

/*   901 Lead Alpha (Event Team)   902 Emp Anika   903 Emp Arjun
     Aftermovie (8201): owned by 902, worked on by 902 and 903, started six
     days ago and due two days ago. A plain task (77202) for 902, due yesterday. */
const FIXTURES = `
  const P=(id,n,r)=>DB.users.unshift({id,real_id:'ztl-'+id,role:r,full_name:n,initials:'ZZ',color:'#888',is_active:true,designation:''});
  P(901,'Lead Alpha','team_lead'); P(902,'Emp Anika','employee'); P(903,'Emp Arjun','employee');
  DB.teams=[{id:9001,name:'Event Team',lead_user_id:901,is_active:true,sort_order:1}];
  DB.team_members=[{team_id:9001,user_id:902},{team_id:9001,user_id:903}];
  const T=DB.deliverable_types.find(t=>!t.review_exempt)||DB.deliverable_types[0];
  window.__day=n=>new Date(Date.parse(TODAY)+n*864e5).toISOString().slice(0,10);
  DB.projects.push({id:7001,name:'Annual Cultural Festival',code:'MC-7001',team_id:9001,owner_id:901,created_by:901,
    project_type_id:DB.project_types[0].id,status:'in_production',priority:'high',academic_unit_id:null,academic_year_id:3,
    start_date:__day(-6),end_date:TODAY,description:'',tags:[],deleted_at:null});
  DB.project_assignments.push({id:99001,project_id:7001,user_id:901,is_project_manager:true,removed_at:null});
  DB.deliverables.push({id:8201,project_id:7001,deliverable_type_id:T.id,title:'Aftermovie',owner_id:902,
    scheduled_date:null,due_date:__day(-2),status:'not_started',priority:'normal',deleted_at:null,weight:1,
    approval_status:'pending',dispatch_status:'none',unit:'',quantity_target:null,quantity_delivered:null,completed_at:null});
  DB.assignments.push({id:77201,project_id:7001,work_type_id:DB.work_types[0].id,deliverable_id:8201,
    title:'Edit the aftermovie',assigned_by:901,priority:'normal',status:'not_started',
    start_date:__day(-6),due_date:__day(-2),assignees:[902,903]},
    {id:77202,project_id:7001,work_type_id:DB.work_types[0].id,deliverable_id:null,
    title:'Back up the cards',assigned_by:901,priority:'normal',status:'in_progress',
    start_date:__day(-5),due_date:__day(-1),assignees:[902]});
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
  const html = (s: string) => { const d = dom.window.document.createElement("div"); d.innerHTML = s; return d; };
  return { dom, ev, as, writes, html, doc: dom.window.document };
}
type H = Awaited<ReturnType<typeof boot>>;
const card = (h: H, title: string) => [...h.html(h.ev<string>("viewMyDay()")).querySelectorAll(".card")]
  .find((c) => c.querySelector("h3")?.textContent === title) as HTMLElement;
const today = (h: H) => card(h, "Today’s assignments");
const ids = (h: H, uid: number, day = "TODAY") => h.ev<unknown[]>(`myAssignments(${uid},${day}).map(a=>a.id)`);
/* The Today's assignment card for one row, as the page draws it. */
const row = (h: H, title: string) => [...today(h).querySelectorAll(".asg")]
  .find((c) => c.querySelector(".asg-title")?.textContent === title) as HTMLElement | undefined;

describe("Today's assignments — work on a deliverable stays until it is submitted", () => {
  it("is on both assignees' day from its start, through its due date and after it", async () => {
    const h = await boot(902);
    for (const uid of [902, 903]) {
      expect(ids(h, uid, "__day(-7)"), `${uid} before start`).not.toContain(77201);
      for (const d of ["__day(-6)", "__day(-4)", "__day(-2)", "TODAY"])
        expect(ids(h, uid, d), `${uid} on ${d}`).toContain(77201);
      h.as(uid);
      const r = row(h, "Edit the aftermovie")!;
      expect(r.querySelector(".chip.overdue")?.textContent).toMatch(/^⚑ Overdue · due /);
    }
  });

  it("leaves once submitted or approved, and is back with the comment after changes are asked for", async () => {
    const h = await boot(903);
    for (const st of ["in_review", "approved", "delivered", "not_required", "cancelled"]) {
      h.ev(`deliv(8201).status='${st}'`);
      expect(ids(h, 902), st).not.toContain(77201);
      expect(ids(h, 903), st).not.toContain(77201);
    }
    h.ev(`deliv(8201).status='changes_requested';
      DB.deliverable_versions.push({id:88201,deliverable_id:8201,version_no:1,review_status:'changes_requested',
        submitted_by:902,submitted_at:TODAY,drive_url:'https://drive.google.com/x',reviewed_by:901,reviewed_at:TODAY,
        review_comment:'Too dark'})`);
    for (const uid of [902, 903]) {
      h.as(uid);
      const r = row(h, "Edit the aftermovie")!;
      expect(r.textContent).toContain("Lead Alpha asked for changes to v1: Too dark");
      // Submitting is done from ✎ Log (Log a task), not from the card itself.
      expect(r.querySelector('[data-act="submitVersion"]')).toBeNull();
    }
  });

  it("plain work stays, overdue, until it is done", async () => {
    const h = await boot(902);
    expect(ids(h, 902)).toContain(77202);
    expect(row(h, "Back up the cards")!.querySelector(".chip.overdue")).not.toBeNull();
    // Plain work has no deliverable, so nothing to submit.
    expect(row(h, "Back up the cards")!.querySelector('[data-act="submitVersion"]')).toBeNull();
    h.ev("DB.assignments.find(a=>a.id===77202).status='done'");
    expect(ids(h, 902)).not.toContain(77202);
  });

  it("work logged today stays, marked logged today, and the ring counts it", async () => {
    const h = await boot(902);
    h.ev(`DB.daily_reports.push({id:99501,user_id:902,report_date:TODAY,status:'draft'});
      DB.report_tasks.push({id:99502,daily_report_id:99501,project_id:7001,deliverable_id:8201,minutes:60,
        description:'Rough cut',status:'in_progress',task_category_id:DB.task_categories[0].id,start_time:'10:00'})`);
    const r = row(h, "Edit the aftermovie")!;
    expect(r.querySelector(".chip.logged")?.textContent).toBe("✓ Logged today");
    expect(h.ev<{ done: number; total: number }>("dayProgress(902)")).toMatchObject({ done: 2, total: 2 });
    // A teammate who has not logged it sees it unmarked.
    h.as(903);
    expect(row(h, "Edit the aftermovie")!.querySelector(".chip.logged")).toBeNull();
    expect(h.ev<{ done: number; total: number }>("dayProgress(903)")).toMatchObject({ done: 0, total: 1 });
  });
});

describe("the Today's assignment card submits the Drive link through ✎ Log", () => {
  const mount = (h: H) => h.ev("location.hash='#/media/my-day'; render()");
  const live = (h: H, title: string) => [...h.doc.querySelectorAll(".card")]
    .find((c) => c.querySelector("h3")?.textContent === title) as HTMLElement;

  it("the card has no Submit of its own; ✎ Log's Submit for review posts the version and the work moves to My deliverables", async () => {
    const h = await boot(903);
    mount(h);
    const card = row(h, "Edit the aftermovie")!;
    expect(card.querySelector('[data-act="submitVersion"]'), "no Submit button on the card").toBeNull();
    // My deliverables keeps its own Submit.
    const mineBefore = [...live(h, "My deliverables").querySelectorAll(".dlv")]
      .find((d) => d.querySelector(".dlv-title")?.textContent === "Aftermovie") as HTMLElement;
    expect(mineBefore.querySelector('[data-act="submitVersion"][data-did="8201"]')).not.toBeNull();
    // ✎ Log opens Log a task with the deliverable linked; its Submit for review opens the form on top.
    h.ev("ACTIONS.logWork({pid:7001,did:8201})");
    await new Promise((r) => setTimeout(r, 10));
    (h.doc.getElementById("tl-submit") as HTMLElement).click();
    (h.doc.querySelector("#sv-layer #sv-url") as HTMLInputElement).value = "https://drive.google.com/file/d/aftermovie";
    (h.doc.querySelector('#sv-layer [data-act="confirmVersion"], #sv-layer button.primary') as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 10));
    const post = h.writes().find((c) => /\/deliverables\/8201\/versions$/.test(c.url));
    expect(post?.method).toBe("POST");
    expect(post?.body).toMatchObject({ drive_url: "https://drive.google.com/file/d/aftermovie" });
    // The work is closed for everyone on it, at once.
    expect(h.ev<string>("DB.assignments.find(a=>a.id===77201).status")).toBe("done");
    expect(live(h, "Today’s assignments").textContent).not.toContain("Edit the aftermovie");
    const mine = [...live(h, "My deliverables").querySelectorAll(".dlv")]
      .find((d) => d.querySelector(".dlv-title")?.textContent === "Aftermovie") as HTMLElement;
    expect(mine.textContent).toContain("Awaiting review");
    h.as(902);
    expect(ids(h, 902)).not.toContain(77201);

    // The lead asks for changes: back on both days, with the comment.
    h.as(901);
    h.ev("ACTIONS.requestChanges({did:'8201'})");
    (h.doc.getElementById("rc-note") as HTMLTextAreaElement).value = "Too dark";
    h.ev("ACTIONS.confirmChanges({did:'8201'})");
    expect(h.ev<string>("DB.assignments.find(a=>a.id===77201).status")).toBe("in_progress");
    h.as(902);
    const back = row(h, "Edit the aftermovie")!;
    expect(back.textContent).toContain("Too dark");
    expect(back.querySelector('[data-act="submitVersion"]')).toBeNull();
  });

  it("submitting from My deliverables clears Today's assignments too", async () => {
    const h = await boot(902);
    // Not overdue this time: it is on the day only because it is open.
    h.ev("DB.assignments.find(a=>a.id===77201).due_date=__day(2)");
    expect(ids(h, 903)).toContain(77201);
    h.ev("ACTIONS.submitVersion({did:'8201'})");
    (h.doc.getElementById("sv-url") as HTMLInputElement).value = "https://docs.google.com/document/d/x";
    h.ev("ACTIONS.confirmVersion({did:'8201',v:'1'})");
    expect(ids(h, 902)).not.toContain(77201);
    expect(ids(h, 903)).not.toContain(77201);
  });

  it("a link that is not Google Drive is refused at the field, and nothing changes", async () => {
    const h = await boot(902);
    mount(h);
    h.ev("ACTIONS.submitVersion({did:'8201'})");
    const url = h.doc.getElementById("sv-url") as HTMLInputElement;
    url.value = "https://example.com/aftermovie";
    (h.doc.querySelector('#modal-layer [data-act="confirmVersion"]') as HTMLElement).click();
    expect(url.classList.contains("err")).toBe(true);
    expect(h.doc.getElementById(url.getAttribute("aria-describedby")!)?.textContent)
      .toBe("Use a Google Drive or Google Docs link.");
    expect(h.writes()).toEqual([]);
    expect(ids(h, 902)).toContain(77201);
  });
});
