/* ═══════════════════════════════════════════════════════════════════════════
   UI — Log a task submits the work for review.

   The owner's rule: in My Day, a Today's assignment card's "✎ Log" opens Log a
   task with the project and deliverable filled in. There is no Evidence field
   to paste a link into. In its place, "Submit for review" opens the same
   Submit dialog the rest of the app uses, over Log a task (which stays open,
   as typed). Once the Drive link is sent the button turns green with a check,
   Status becomes Done (In progress until then), and Log task saves the log
   with that submitted link as its evidence.

   The real public/media-ops/index.html, in jsdom, with the server replaced by
   a recording fetch.
   ═══════════════════════════════════════════════════════════════════════════ */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const HTML = readFileSync("public/media-ops/index.html", "utf8");

/*   901 Lead Alpha (Event Team)   902 Emp Anika   903 Emp Arjun
     Aftermovie (8201): owned by 902, worked on by 902 and 903.
     Highlights reel (8202): owned by 903 alone — 902 is not on it. */
const FIXTURES = `
  const P=(id,n,r)=>DB.users.unshift({id,real_id:'ztl-'+id,role:r,full_name:n,initials:'ZZ',color:'#888',is_active:true,designation:''});
  P(901,'Lead Alpha','team_lead'); P(902,'Emp Anika','employee'); P(903,'Emp Arjun','employee');
  DB.teams=[{id:9001,name:'Event Team',lead_user_id:901,is_active:true,sort_order:1}];
  DB.team_members=[{team_id:9001,user_id:902},{team_id:9001,user_id:903}];
  const T=DB.deliverable_types.find(t=>!t.review_exempt)||DB.deliverable_types[0];
  window.__day=n=>new Date(Date.parse(TODAY)+n*864e5).toISOString().slice(0,10);
  DB.projects.push({id:7001,name:'Annual Cultural Festival',code:'MC-7001',team_id:9001,owner_id:901,created_by:901,
    project_type_id:DB.project_types[0].id,status:'in_production',priority:'high',academic_unit_id:null,academic_year_id:3,
    start_date:__day(-6),end_date:__day(6),description:'',tags:[],deleted_at:null});
  DB.project_assignments.push({id:99001,project_id:7001,user_id:901,is_project_manager:true,removed_at:null});
  const D0={project_id:7001,deliverable_type_id:T.id,scheduled_date:null,due_date:__day(2),status:'not_started',
    priority:'normal',deleted_at:null,weight:1,approval_status:'pending',dispatch_status:'none',unit:'',
    quantity_target:null,quantity_delivered:null,completed_at:null};
  DB.deliverables.push({...D0,id:8201,title:'Aftermovie',owner_id:902},{...D0,id:8202,title:'Highlights reel',owner_id:903});
  DB.assignments.push({id:77201,project_id:7001,work_type_id:DB.work_types[0].id,deliverable_id:8201,
    title:'Edit the aftermovie',assigned_by:901,priority:'normal',status:'not_started',
    start_date:__day(-1),due_date:__day(2),assignees:[902,903]});
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
  ev(`S.me=${me}; window.__MO_LIVE__=true; location.hash='#/media/my-day'; render()`);
  const doc = dom.window.document;
  const writes = () => calls.filter((c) => c.method !== "GET");
  const $ = <E extends Element = HTMLElement>(s: string) => doc.querySelector(s) as E | null;
  return { dom, ev, writes, doc, $ };
}
type H = Awaited<ReturnType<typeof boot>>;
const tick = () => new Promise((r) => setTimeout(r, 0));

/* "✎ Log" on the Today's assignment card for the aftermovie, as the person clicks it. */
async function logFromCard(h: H) {
  const btn = [...h.doc.querySelectorAll("#app .asg")]
    .find((c) => c.querySelector(".asg-title")?.textContent === "Edit the aftermovie")
    ?.querySelector('button[onclick*="logWork"]') as HTMLElement;
  expect(btn?.textContent).toContain("Log");
  btn.click();
  await tick();
  expect(h.$("#modal-layer")!.classList.contains("on")).toBe(true);
}
const review = (h: H) => h.$("#tl-review")!;
const status = (h: H) => h.$("#tl-status button.on")?.getAttribute("data-st");
const pickDeliv = (h: H, did: number | "") => {
  const s = h.$<HTMLSelectElement>("#tl-deliv")!;
  s.value = String(did);
  s.dispatchEvent(new h.dom.window.Event("change"));
};
const addVersion = (h: H, did: number, st: string, dst: string) => h.ev(`
  DB.deliverable_versions.push({id:80000+${did},deliverable_id:${did},version_no:1,review_status:'${st}',submitted_by:903,
    submitted_at:TODAY,drive_url:'https://drive.google.com/file/d/v1-${did}',note:'',reviewed_by:null,reviewed_at:null,review_comment:''});
  deliv(${did}).status='${dst}';`);

describe("Log a task — the Review field", () => {
  it("has no Evidence field; the card fills in the project and deliverable and offers Submit for review", async () => {
    const h = await boot(902);
    await logFromCard(h);
    expect(h.$("#tl-link")).toBeNull();
    expect(h.$("#modal-layer")!.textContent).not.toMatch(/Evidence|drive\.google\.com|Attachments/);
    expect(h.$<HTMLSelectElement>("#tl-project")!.value).toBe("7001");
    expect(h.$<HTMLSelectElement>("#tl-deliv")!.value).toBe("8201");
    expect(review(h).closest(".field")!.querySelector(".lbl")!.textContent).toBe("Submit for review");
    expect(h.$("#tl-submit")?.textContent).toBe("⤴ Submit for review");
    // Linked and not yet submitted: In progress.
    expect(status(h)).toBe("in_progress");
  });

  it("shows each state of the linked deliverable", async () => {
    const h = await boot(902);
    h.ev("openTaskLog()");
    h.ev("$('#tl-project').value='7001'; $('#tl-project').onchange()");
    // No deliverable linked.
    expect(review(h).textContent!.trim()).toBe("Link a deliverable to submit this work for review.");
    expect(status(h)).toBe("done");
    // Someone else's deliverable.
    pickDeliv(h, 8202);
    expect(review(h).textContent!.trim()).toBe("Only people working on this deliverable can submit it.");
    expect(h.$("#tl-submit")).toBeNull();
    // Changes asked for on v1: the button names v2.
    addVersion(h, 8201, "changes_requested", "changes_requested");
    pickDeliv(h, 8201);
    expect(h.$("#tl-submit")?.textContent).toBe("⤴ Submit v2 for review");
    expect(status(h)).toBe("in_progress");
    // Waiting for review: green, with the version and its link, and Done.
    h.ev("DB.deliverable_versions.find(v=>v.id===88201).review_status='pending'; deliv(8201).status='in_review'");
    pickDeliv(h, "");
    pickDeliv(h, 8201);
    const sent = review(h).querySelector(".tl-sent")!;
    expect(sent.textContent).toContain("✔ v1 submitted for review");
    expect(sent.querySelector("a")!.getAttribute("href")).toBe("https://drive.google.com/file/d/v1-8201");
    expect(h.$("#tl-submit")).toBeNull();
    expect(status(h)).toBe("done");
    // Approved.
    h.ev("DB.deliverable_versions.find(v=>v.id===88201).review_status='approved'; deliv(8201).status='approved'");
    pickDeliv(h, "");
    pickDeliv(h, 8201);
    expect(review(h).querySelector(".tl-sent")!.textContent).toContain("✔ v1 approved");
    expect(status(h)).toBe("done");
  });

  it("a status the person picks is kept when the deliverable changes; an edited log keeps its own", async () => {
    const h = await boot(902);
    await logFromCard(h);
    expect(status(h)).toBe("in_progress");
    (h.$('#tl-status [data-st="blocked"]') as HTMLElement).click();
    pickDeliv(h, "");
    pickDeliv(h, 8201);
    expect(status(h)).toBe("blocked");
    h.ev(`closeModal(); DB.daily_reports.push({id:99501,user_id:902,report_date:TODAY,status:'draft'});
      DB.report_tasks.push({id:99502,daily_report_id:99501,project_id:7001,deliverable_id:8201,minutes:60,
        description:'Rough cut',status:'done',task_category_id:DB.task_categories[0].id,start_time:'10:00',end_time:'11:00',evidence:[]});
      openTaskLog(99502)`);
    await tick();
    expect(h.$<HTMLSelectElement>("#tl-deliv")!.value).toBe("8201");
    expect(status(h)).toBe("done");
  });
});

describe("Log a task — Submit for review opens over it", () => {
  it("opens the same Submit form on top, with Log a task still open as typed", async () => {
    const h = await boot(902);
    await logFromCard(h);
    h.$<HTMLInputElement>("#tl-desc")!.value = "Colour pass on the aftermovie";
    h.$("#tl-submit")!.click();
    const layer = h.$("#sv-layer")!;
    expect(layer).not.toBeNull();
    expect(layer.querySelector("h2")!.textContent).toBe("Submit v1 for review");
    expect(layer.querySelector("#sv-url")).not.toBeNull();
    expect(layer.querySelector("#sv-note")).not.toBeNull();
    expect(h.$("#modal-layer")!.classList.contains("on")).toBe(true);
    expect(h.$<HTMLInputElement>("#modal-layer #tl-desc")!.value).toBe("Colour pass on the aftermovie");
    // Above the Log a task dialog.
    const z = (s: string) => +h.dom.window.getComputedStyle(h.$(s)!).zIndex;
    expect(z("#sv-layer")).toBeGreaterThan(z("#modal-layer"));
  });

  it("Escape, ✕ and Cancel close only the Submit form", async () => {
    const h = await boot(902);
    await logFromCard(h);
    h.$<HTMLInputElement>("#tl-desc")!.value = "Typed before";
    const close = [
      () => h.doc.dispatchEvent(new h.dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
      () => (h.$('#sv-layer .icon-btn[data-sv="no"]') as HTMLElement).click(),
      () => (h.$('#sv-layer .mo-foot [data-sv="no"]') as HTMLElement).click(),
    ];
    for (const c of close) {
      h.$("#tl-submit")!.click();
      expect(h.$("#sv-layer")).not.toBeNull();
      c();
      expect(h.$("#sv-layer")).toBeNull();
      expect(h.$("#modal-layer")!.classList.contains("on")).toBe(true);
      expect(h.$<HTMLInputElement>("#tl-desc")!.value).toBe("Typed before");
      expect(h.doc.activeElement?.id).toBe("tl-submit");
    }
    expect(h.writes()).toEqual([]);
  });

  it("a link that is not Google Drive is refused at the field, and nothing is posted", async () => {
    const h = await boot(902);
    await logFromCard(h);
    h.$("#tl-submit")!.click();
    const url = h.$<HTMLInputElement>("#sv-layer #sv-url")!;
    url.value = "https://example.com/aftermovie";
    (h.$('#sv-layer [data-sv="yes"]') as HTMLElement).click();
    expect(url.classList.contains("err")).toBe(true);
    expect(h.doc.getElementById(url.getAttribute("aria-describedby")!)?.textContent)
      .toBe("Use a Google Drive or Google Docs link.");
    expect(h.$("#sv-layer")).not.toBeNull();
    expect(h.writes()).toEqual([]);
    expect(h.ev<string>("deliv(8201).status")).toBe("not_started");
  });

  it("a Drive link posts the version once, closes only the form, turns the field green and sets Done", async () => {
    const h = await boot(902);
    await logFromCard(h);
    h.$<HTMLInputElement>("#tl-desc")!.value = "Colour pass on the aftermovie";
    h.$("#tl-submit")!.click();
    h.$<HTMLInputElement>("#sv-url")!.value = "https://drive.google.com/file/d/aftermovie-v1";
    h.$<HTMLTextAreaElement>("#sv-note")!.value = "First cut";
    (h.$('#sv-layer [data-sv="yes"]') as HTMLElement).click();
    const posts = h.writes().filter((c) => /\/deliverables\/8201\/versions$/.test(c.url));
    expect(posts).toHaveLength(1);
    expect(posts[0].method).toBe("POST");
    expect(posts[0].body).toEqual({ drive_url: "https://drive.google.com/file/d/aftermovie-v1", note: "First cut" });
    expect(h.$("#sv-layer")).toBeNull();
    expect(h.$("#modal-layer")!.classList.contains("on")).toBe(true);
    expect(h.$<HTMLInputElement>("#tl-desc")!.value).toBe("Colour pass on the aftermovie");
    const sent = review(h).querySelector(".tl-sent")!;
    expect(sent.textContent).toContain("✔ v1 submitted for review");
    expect(sent.querySelector("a")!.getAttribute("href")).toBe("https://drive.google.com/file/d/aftermovie-v1");
    expect(h.$("#tl-submit")).toBeNull();
    expect(status(h)).toBe("done");
    expect(h.$("#tl-stwarn")!.textContent).toBe("");
    // Same optimistic update as the ordinary dialog: waiting for review, the work closed.
    expect(h.ev<string>("deliv(8201).status")).toBe("in_review");
    expect(h.ev<string>("DB.assignments.find(a=>a.id===77201).status")).toBe("done");
    expect(h.doc.querySelector("#toasts, .toasts, body")!.textContent).toContain("v1 submitted.");
  });

  it("Log task then saves the log with the submitted link as its evidence", async () => {
    const h = await boot(902);
    await logFromCard(h);
    h.$<HTMLInputElement>("#tl-desc")!.value = "Colour pass on the aftermovie";
    h.$("#tl-submit")!.click();
    h.$<HTMLInputElement>("#sv-url")!.value = "https://drive.google.com/file/d/aftermovie-v1";
    (h.$('#sv-layer [data-sv="yes"]') as HTMLElement).click();
    (h.$('#modal-layer [data-act="saveTask"]') as HTMLElement).click();
    const task = h.writes().filter((c) => /\/reports\/[^/]+\/tasks$/.test(c.url));
    expect(task).toHaveLength(1);
    expect(task[0].body).toMatchObject({ project_id: 7001, deliverable_id: 8201, status: "done",
      description: "Colour pass on the aftermovie", evidence: ["https://drive.google.com/file/d/aftermovie-v1"] });
    expect(h.$("#modal-layer")!.classList.contains("on")).toBe(false);
  });

  it("Done with nothing submitted warns under Status, and still saves, without evidence", async () => {
    const h = await boot(902);
    await logFromCard(h);
    expect(h.$("#tl-stwarn")!.textContent).toBe("");
    (h.$('#tl-status [data-st="done"]') as HTMLElement).click();
    expect(h.$("#tl-stwarn")!.textContent).toContain("Not submitted yet — submit it for review, or log it as In progress.");
    (h.$('#tl-status [data-st="in_progress"]') as HTMLElement).click();
    expect(h.$("#tl-stwarn")!.textContent).toBe("");
    (h.$('#tl-status [data-st="done"]') as HTMLElement).click();
    h.$<HTMLInputElement>("#tl-desc")!.value = "Rough cut";
    (h.$('#modal-layer [data-act="saveTask"]') as HTMLElement).click();
    const task = h.writes().filter((c) => /\/reports\/[^/]+\/tasks$/.test(c.url));
    expect(task).toHaveLength(1);
    expect(task[0].body).toMatchObject({ deliverable_id: 8201, status: "done", evidence: [] });
  });
});

describe("the ordinary Submit dialog is unchanged", () => {
  it("from a My Day card it posts once and closes", async () => {
    const h = await boot(903);
    const btn = h.$('#app [data-act="submitVersion"][data-did="8201"]')!;
    btn.click();
    expect(h.$("#sv-layer")).toBeNull();
    expect(h.$("#modal-layer h2")!.textContent).toBe("Submit v1 for review");
    h.$<HTMLInputElement>("#modal-layer #sv-url")!.value = "https://docs.google.com/document/d/x";
    (h.$('#modal-layer [data-act="confirmVersion"]') as HTMLElement).click();
    const posts = h.writes().filter((c) => /\/deliverables\/8201\/versions$/.test(c.url));
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toEqual({ drive_url: "https://docs.google.com/document/d/x", note: "" });
    expect(h.$("#modal-layer")!.classList.contains("on")).toBe(false);
    expect(h.ev<string>("deliv(8201).status")).toBe("in_review");
  });
});
