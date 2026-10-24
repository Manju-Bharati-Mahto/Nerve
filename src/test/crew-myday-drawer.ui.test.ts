/* ═══════════════════════════════════════════════════════════════════════════
   UI — My Day, the deliverable drawer and Pending approvals, as the crew
   read them after a live run through the workflow.

     · Delivered outputs: newest first, every row reachable, approved work
       carries ✔ Mark delivered, delivered work says Delivered;
     · the drawer's Assignment names the owner and their team, offers SMC only
       where it applies, and never offers to reassign finished work;
     · one name per thing: the deliverable once, people by full name, and one
       label for submitting a version;
     · a bad Drive link is said at the field; the board's hint says what this
       person can do, and a column they cannot drop on is not a drop target.

   The real public/media-ops/index.html, in jsdom, with the server replaced by
   a recording fetch. The server's half (finished work keeps its owner) is in
   server/mediaops-crew-workflow.integration.test.ts.
   ═══════════════════════════════════════════════════════════════════════════ */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const HTML = readFileSync("public/media-ops/index.html", "utf8");

/*   901 Lead Alpha (Event Team)   902 Emp Anika   903 Emp Arjun
     904 Lead Bravo (Video Team)   906 Coordinator   907 Admin               */
const FIXTURES = `
  const P=(id,n,r)=>DB.users.unshift({id,real_id:'zmd-'+id,role:r,full_name:n,initials:'ZZ',color:'#888',is_active:true,designation:''});
  P(901,'Lead Alpha','team_lead'); P(902,'Emp Anika','employee'); P(903,'Emp Arjun','employee');
  P(904,'Lead Bravo','team_lead'); P(906,'Coord Chitra','coordinator'); P(907,'Admin Dev','admin');
  DB.teams=[{id:9001,name:'Event Team',lead_user_id:901,is_active:true,sort_order:1},
            {id:9002,name:'Video Team',lead_user_id:904,is_active:true,sort_order:2}];
  DB.team_members=[{team_id:9001,user_id:902},{team_id:9001,user_id:903}];
  const T=DB.deliverable_types.find(t=>!t.review_exempt)||DB.deliverable_types[0];
  window.__TN=T.name;
  DB.projects.push({id:7001,name:'Annual Cultural Festival',code:'MC-7001',team_id:9001,owner_id:901,created_by:906,
    project_type_id:DB.project_types[0].id,status:'in_production',priority:'high',academic_unit_id:null,academic_year_id:3,
    start_date:TODAY,end_date:TODAY,description:'',tags:[],deleted_at:null});
  DB.project_assignments.push({id:99001,project_id:7001,user_id:901,is_project_manager:true,removed_at:null});
  window.__dl=(id,title,status,extra)=>DB.deliverables.push(Object.assign({id,project_id:7001,deliverable_type_id:T.id,title,
    owner_id:902,scheduled_date:null,due_date:TODAY,status,priority:'normal',deleted_at:null,weight:1,
    approval_status:'pending',dispatch_status:'none',unit:'',quantity_target:null,quantity_delivered:null,completed_at:null},extra||{}));
  window.__v=(id,did,no,st,at,by)=>DB.deliverable_versions.push({id,deliverable_id:did,version_no:no,review_status:st,
    submitted_by:902,submitted_at:'2026-10-01T09:00:00Z',drive_url:'https://drive.google.com/'+id,
    reviewed_by:st==='pending'?null:(by||904),reviewed_at:st==='pending'?null:at,review_comment:''});
  __dl(8101,T.name,'in_progress');
  __dl(8102,'Aftermovie','in_review'); __v(88102,8102,1,'pending');
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

describe("My Day — Delivered outputs", () => {
  it("lists the newest first, by when it was approved or delivered", async () => {
    const h = await boot(902);
    h.ev(`__dl(8110,'Old delivered','delivered',{completed_at:'2026-10-18'}); __v(88110,8110,1,'approved','2026-10-17');
          __dl(8111,'Approved today','approved'); __v(88111,8111,2,'approved','2026-10-24T11:00:00Z');
          __dl(8112,'Delivered yesterday','delivered',{completed_at:'2026-10-23T16:00:00Z'}); __v(88112,8112,1,'approved','2026-10-22');`);
    const titles = [...card(h, "Delivered outputs").querySelectorAll(".dlv-title")].map((n) => n.textContent);
    expect(titles).toEqual(["Approved today", "Delivered yesterday", "Old delivered"]);
  });

  it("approved work carries ✔ Mark delivered for the people on it, and it delivers", async () => {
    const h = await boot(902);
    h.ev(`__dl(8111,'Approved today','approved'); __v(88111,8111,2,'approved','2026-10-24');`);
    const btn = card(h, "Delivered outputs").querySelector('[data-act="markDelivered"][data-did="8111"]');
    expect(btn?.textContent).toContain("✔ Mark delivered");
    // Work still waiting on its review is not offered it.
    expect(card(h, "Delivered outputs").querySelector('[data-act="markDelivered"][data-did="8102"]')).toBeNull();
    h.ev("ACTIONS.markDelivered({did:'8111'})");
    expect(h.writes().map((c) => c.url)).toEqual([expect.stringMatching(/\/deliverables\/8111\/deliver$/)]);
  });

  it("delivered work says Delivered, not Approved v2", async () => {
    const h = await boot(902);
    h.ev(`__dl(8112,'Delivered yesterday','delivered',{completed_at:'2026-10-23'}); __v(88112,8112,2,'approved','2026-10-22');`);
    const row = card(h, "Delivered outputs").querySelector(".dlv") as HTMLElement;
    expect(row.querySelector(".dlv-top .status")?.textContent).toContain("Delivered");
    expect(row.textContent).not.toContain("Approved v2");
    expect(row.querySelector('[data-act="markDelivered"]')).toBeNull();
  });

  it("names the reviewer in full", async () => {
    const h = await boot(902);
    h.ev(`__dl(8111,'Approved today','approved'); __v(88111,8111,1,'approved','2026-10-24',904);`);
    expect(card(h, "Delivered outputs").textContent).toContain("by Lead Bravo");
  });

  it("past eight rows, See all N reaches every one the badge counts", async () => {
    const h = await boot(902);
    h.ev(`for(let i=0;i<11;i++){__dl(8200+i,'Out '+i,'delivered',{completed_at:'2026-10-'+String(10+i)});}`);
    let c = card(h, "Delivered outputs");
    expect(c.querySelector(".chip")?.textContent).toBe("11");
    expect(c.querySelectorAll(".dlv")).toHaveLength(8);
    const all = c.querySelector('[data-act="myDelivAll"]');
    expect(all?.textContent).toContain("See all 11");
    h.ev("ACTIONS.myDelivAll()");
    c = card(h, "Delivered outputs");
    expect(c.querySelectorAll(".dlv")).toHaveLength(11);
  });
});

describe("My Day — people by full name, one name for submitting", () => {
  it("'with <owner>' and the change-request note name people in full", async () => {
    const h = await boot(903);
    h.ev(`deliv(8101).status='changes_requested'; __v(88101,8101,1,'changes_requested','2026-10-24',904);
          DB.deliverable_versions.find(v=>v.id===88101).review_comment='Too dark';
          DB.assignments.push({id:99501,project_id:7001,deliverable_id:8101,title:'Edit',status:'assigned',is_smc:false,
            assigned_by:901,due_date:TODAY,start_date:TODAY,assignees:[902,903]});`);
    const day = card(h, "My deliverables").textContent!;
    expect(day).toContain("with Emp Anika");
    expect(day).toContain("Lead Bravo asked for changes to v1: Too dark");
  });

  it("the drawer and My Day both say ⤴ Submit v2 for review", async () => {
    const h = await boot(902);
    h.ev(`deliv(8101).status='changes_requested'; __v(88101,8101,1,'changes_requested','2026-10-24');`);
    expect(card(h, "My deliverables").querySelector('[data-act="submitVersion"][data-did="8101"]')?.textContent)
      .toBe("⤴ Submit v2 for review");
    h.ev("drawerDeliverable(8101)");
    expect(h.doc.querySelector('#drawer [data-act="submitVersion"]')?.textContent).toBe("⤴ Submit v2 for review");
    h.ev(`DB.deliverable_versions=DB.deliverable_versions.filter(v=>v.deliverable_id!==8101); deliv(8101).status='in_progress'`);
    expect(card(h, "My deliverables").querySelector('[data-act="submitVersion"][data-did="8101"]')?.textContent)
      .toBe("⤴ Submit for review");
  });

  it("a bad Drive link is marked at the field in a full sentence, and nothing is sent", async () => {
    const h = await boot(902);
    h.ev("ACTIONS.submitVersion({did:'8101'})");
    const url = h.doc.getElementById("sv-url") as HTMLInputElement;
    url.value = "https://example.com/x";
    h.ev("ACTIONS.confirmVersion({did:'8101',v:'1'})");
    expect(url.classList.contains("err")).toBe(true);
    expect(url.getAttribute("aria-invalid")).toBe("true");
    expect(h.doc.getElementById(url.getAttribute("aria-describedby")!)?.textContent)
      .toBe("Use a Google Drive or Google Docs link.");
    expect(h.doc.querySelector("#toasts")!.textContent).not.toContain("must be a Google");
    expect(h.writes()).toEqual([]);
  });
});

describe("the deliverable drawer", () => {
  const drawer = (h: H, id: number) => { h.ev(`drawerDeliverable(${id})`); return h.doc.querySelector("#drawer") as HTMLElement; };

  it("Assignment names the owner in full with their team, under its own gap", async () => {
    const h = await boot(901);
    h.ev("DASG.byDeliv[8102]={crew:{user_id:'zmd-902',full_name:'Emp Anika'},team:[],smc:null}");
    const sec = drawer(h, 8102).querySelector("[data-dasg]") as HTMLElement;
    expect(sec.classList.contains("mt4")).toBe(true);
    expect(sec.querySelector("dl")!.textContent).toMatch(/Owner\s*Emp Anika\s*Event Team/);
    // The owner is named once in the drawer, and nothing is "Not assigned".
    expect(h.doc.querySelector("#drawer")!.innerHTML.match(/<dt>Owner<\/dt>/g)).toHaveLength(1);
    expect(sec.textContent).not.toContain("Not assigned");
  });

  it("SMC shows only when someone covers it, or a lead may still add one to open work", async () => {
    const h = await boot(902);
    h.ev("DASG.byDeliv[8102]={crew:{user_id:'zmd-902',full_name:'Emp Anika'},team:[],smc:null}");
    let sec = drawer(h, 8102).querySelector("[data-dasg]") as HTMLElement;
    expect(sec.textContent).not.toContain("SMC");
    h.ev("DASG.byDeliv[8102].smc={user_id:'s1',full_name:'Smc Sana',institute:'PIET'}");
    sec = drawer(h, 8102).querySelector("[data-dasg]") as HTMLElement;
    expect(sec.textContent).toMatch(/SMC member\s*Smc Sana\s*PIET/);
    h.as(904);
    h.ev("DASG.byDeliv[8102].smc=null");
    expect(drawer(h, 8102).querySelector('[data-act="dasgOpen"][data-kind="smc"]')).not.toBeNull();
    h.ev("deliv(8102).status='delivered'");
    expect(drawer(h, 8102).querySelector('[data-act="dasgOpen"][data-kind="smc"]')).toBeNull();
  });

  it("finished work offers no reassignment — drawer, owner cell or schedule", async () => {
    const h = await boot(901);
    h.ev("DASG.byDeliv[8102]={crew:{user_id:'zmd-902',full_name:'Emp Anika'},team:[],smc:null}");
    expect(drawer(h, 8102).querySelector('[data-kind="crew"]')?.textContent).toContain("Reassign deliverable");
    expect(h.ev<string>("delivOwnerCell(proj(7001),deliv(8102))")).toContain("<select");
    for (const finish of ["deliv(8102).status='delivered'",
                          "deliv(8102).status='approved'; deliv(8102).dispatch_status='delivered'",
                          "deliv(8102).status='delivered'; deliv(8102).dispatch_status='archived'"]) {
      h.ev(`deliv(8102).status='in_review'; deliv(8102).dispatch_status='none'; ${finish}`);
      expect(drawer(h, 8102).querySelector('[data-kind="crew"]'), finish).toBeNull();
      expect(h.ev<string>("delivOwnerCell(proj(7001),deliv(8102))"), finish).not.toContain("<select");
      h.ev("ACTIONS.scheduleDeliv({did:'8102'})");
      expect((h.doc.getElementById("sd-owner") as HTMLSelectElement).disabled, finish).toBe(true);
      h.ev("closeModal()");
    }
  });

  it("names the deliverable once and shows no internal weight", async () => {
    const h = await boot(901);
    const head = drawer(h, 8101).querySelector(".dh-meta") as HTMLElement;
    expect(head.textContent).not.toMatch(/weight/i);
    expect(head.textContent).not.toContain(h.ev<string>("__TN"));
    // A title that is not the type still says the type beside it.
    expect((drawer(h, 8102).querySelector(".dh-meta") as HTMLElement).textContent).toContain(h.ev<string>("__TN"));
    const row = h.html(h.ev<string>("delivRow(deliv(8101))")).querySelector(".lr-main > span") as HTMLElement;
    expect(row.textContent!.trim()).toBe("owner Emp Anika");
  });

  it("the owner select leaves room for its chevron", async () => {
    const h = await boot(901);
    const sel = h.html(h.ev<string>("delivOwnerCell(proj(7001),deliv(8101))")).querySelector("select") as HTMLSelectElement;
    expect(sel.style.paddingRight).toBe("26px");
    expect(sel.style.textOverflow).toBe("ellipsis");
  });
});

describe("Home and the board", () => {
  it("Pending approvals names the deliverable by its title, and keeps the project on a phone card", async () => {
    const h = await boot(904);
    h.ev("deliv(8102).title='Photos — Edited'");
    const t = h.html(h.ev<string>("pendingApprovalsWidget()"));
    const row = t.querySelector('tr[data-drawer="deliverable:8102"]') as HTMLElement;
    expect(row.querySelector("td")!.textContent!.trim()).toBe("Photos — Edited · v1");
    expect(t.querySelector("table")!.classList.contains("pa-cards")).toBe(true);
    expect(row.querySelector('td[data-m="meta"]')!.textContent).toContain("Annual Cultural Festival");
    expect(row.querySelector('td[data-m="actions"] button')!.textContent).toBe("Review");
    const phone = HTML.slice(HTML.indexOf("/* ==== PHONE LAYER ===="), HTML.indexOf("/* ==== END PHONE LAYER ==== */"));
    expect(phone).toContain('html[data-layout="mobile"] table.pa-cards td.hide-sm{display:block!important}');
  });

  it("a phone sheet clears the passing start-up toast first", async () => {
    const h = await boot(907);
    h.doc.documentElement.setAttribute("data-layout", "mobile");
    h.ev("toast('Live · 3 projects. Signed in as Admin Dev.','ok',null,{passing:true})");
    expect(h.doc.querySelector("#toasts [data-passing]")).not.toBeNull();
    h.ev("menu(document.body,MENUS.delivMenu({did:'8102'}))");
    expect(h.doc.querySelector(".menu.as-sheet")).not.toBeNull();
    expect(h.doc.querySelector("#toasts [data-passing]")).toBeNull();
  });

  it("the board's hint says what this person can do", async () => {
    const h = await boot(907);
    expect(h.ev<string>("viewPipeline()")).toContain("Drag a card to change its status.");
    h.as(902);
    const emp = h.ev<string>("viewPipeline()");
    expect(emp).toContain("Drag your cards to In progress; reviewers approve from the drawer.");
    expect(emp).not.toContain("Drag a card to change its status.");
    expect(HTML).toContain(".kb-card:not([draggable]){cursor:pointer}");
  });

  it("dragging onto a column this person may not move it to is not a drop", async () => {
    const h = await boot(902);
    h.ev("location.hash='#/media/pipeline'; render()");
    await new Promise((r) => setTimeout(r, 50));
    const over = (status: string) => {
      const col = h.doc.querySelector(`[data-drop="delivstatus:${status}"]`) as HTMLElement;
      const e = new h.dom.window.Event("dragover", { cancelable: true, bubbles: true });
      col.dispatchEvent(e);
      return e.defaultPrevented;
    };
    h.ev("S.dragging='deliverable:8101'");   // in progress, Emp Anika's own
    expect(over("approved"), "an employee approving by drag").toBe(false);
    expect(over("in_review")).toBe(true);
  });
});
