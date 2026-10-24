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

  it("SMC shows only when someone covers it, or a lead may still add one to open work at an institute with SMC", async () => {
    const h = await boot(902);
    h.ev("DASG.byDeliv[8102]={crew:{user_id:'zmd-902',full_name:'Emp Anika'},team:[],smc:null}");
    let sec = drawer(h, 8102).querySelector("[data-dasg]") as HTMLElement;
    expect(sec.textContent).not.toContain("SMC");
    h.ev("DASG.byDeliv[8102].smc={user_id:'s1',full_name:'Smc Sana',institute:'PIET'}");
    sec = drawer(h, 8102).querySelector("[data-dasg]") as HTMLElement;
    expect(sec.textContent).toMatch(/SMC member\s*Smc Sana\s*PIET/);
    h.as(904);
    h.ev("DASG.byDeliv[8102].smc=null");
    // The project's institute has no Social Media Coordinator: nothing to offer.
    expect(drawer(h, 8102).querySelector('[data-act="dasgOpen"][data-kind="smc"]')).toBeNull();
    expect(drawer(h, 8102).querySelector("[data-dasg]")!.textContent).not.toContain("SMC");
    h.ev("DASG.byDeliv[8102].smc_available=true");
    const btn = drawer(h, 8102).querySelector('[data-act="dasgOpen"][data-kind="smc"]') as HTMLElement;
    expect(btn.title).toBe("Hand it to a Social Media Coordinator at the institute");
    expect(drawer(h, 8102).querySelector("[data-smc-hint]")!.textContent)
      .toBe("SMC: hand it to a Social Media Coordinator at the institute.");
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

/* ── The drawer after a live run: versions, delivery and sign-off ─────────────
   Who reviewed each version and when, in the display format; delivered work
   says Delivered (no countdown) and who signed it off; post-delivery wording
   is Sign off / Send back; status words in sentence case; the ⋯ menu holds
   only usable items; the people on it can start work from the footer. */
describe("the deliverable drawer — versions, delivery and sign-off", () => {
  const drawer = (h: H, id: number) => { h.ev(`drawerDeliverable(${id})`); return h.doc.querySelector("#drawer") as HTMLElement; };
  const kv = (h: H, id: number, dt: string) => [...drawer(h, id).querySelectorAll("dl.kv dt")]
    .find((n) => n.textContent === dt)?.nextElementSibling?.textContent?.replace(/\s+/g, " ").trim();
  const day = (h: H, ts: string) => h.ev<string>(`D.fmtDay('${ts}')`);
  const delivered = (h: H) => h.ev(`__dl(8120,'Photos edited','delivered',{completed_at:'2026-10-20',delivered_by:902,
    due_date:'2099-12-31'}); __v(88120,8120,1,'approved','2026-10-19T10:00:00Z');`);

  it("status words are sentence case — one spelling for pills, menus and the board", async () => {
    const h = await boot(901);
    expect(h.ev<string[]>("Object.values(DELIV_STATUS).map(s=>s.l)")).toEqual(
      ["Not started", "In progress", "In review", "Changes requested", "Approved", "Delivered", "Not required", "Cancelled"]);
    expect(h.ev<string>("viewPipeline()")).not.toMatch(/Not Started|In Progress|In Review|Changes Requested/);
  });

  it("each reviewed version says who reviewed it and when; no date is raw ISO", async () => {
    const h = await boot(902);
    h.ev(`__v(88103,8102,0,'changes_requested','2026-09-30T08:00:00Z');
          DB.deliverable_versions.find(v=>v.id===88103).review_comment='Brighten the night shots';
          DB.comments.push({id:99801,entity_type:'deliverable',entity_id:8102,user_id:901,body:'Looks good',created_at:'2026-10-02T07:00:00Z'});`);
    const d = drawer(h, 8102);
    const reviewed = [...d.querySelectorAll("[data-reviewed]")].map((n) => n.textContent!.replace(/\s+/g, " ").trim());
    expect(reviewed).toEqual([`Changes requested by Lead Bravo · ${day(h, "2026-09-30T08:00:00Z")}`]);
    h.ev("Object.assign(DB.deliverable_versions.find(v=>v.id===88102),{review_status:'approved',reviewed_by:904,reviewed_at:'2026-10-03T09:00:00Z'})");
    expect(drawer(h, 8102).querySelector("[data-reviewed]")!.textContent!.replace(/\s+/g, " ").trim())
      .toBe(`Approved by Lead Bravo · ${day(h, "2026-10-03T09:00:00Z")}`);
    const text = drawer(h, 8102).querySelector(".dr-body")!.textContent!;
    expect(text).not.toMatch(/\d{4}-\d\d-\d\d/);
    expect(text).toContain(day(h, "2026-10-02T07:00:00Z"));
  });

  it("a review note is not contradicted by 'No comments.'", async () => {
    const h = await boot(902);
    expect(drawer(h, 8102).textContent).toContain("No comments.");
    h.ev("Object.assign(DB.deliverable_versions.find(v=>v.id===88102),{review_status:'changes_requested',reviewed_by:904,reviewed_at:'2026-10-03',review_comment:'Too dark'})");
    const text = drawer(h, 8102).textContent!;
    expect(text).toContain("Review note: Too dark");
    expect(text).toContain("No other comments.");
    expect(text).not.toContain("No comments.");
  });

  it("delivered work says Delivered with no countdown, and waits for sign-off", async () => {
    const h = await boot(904);
    delivered(h);
    expect(kv(h, 8120, "Due date")).toBe(h.ev<string>("D.fmt('2099-12-31')"));
    expect(kv(h, 8120, "Delivered")).toBe(`${h.ev<string>("D.fmt('2026-10-20')")} by Emp Anika`);
    expect(kv(h, 8120, "Completed")).toBeUndefined();
    expect(kv(h, 8120, "Sign-off")).toBe("Awaiting sign-off");
    // Open work still counts down.
    h.ev("deliv(8101).due_date='2099-12-31'");
    expect(kv(h, 8101, "Due date")).toMatch(/\(in \d+d\)$/);
  });

  it("post-delivery is Sign off / Send back, and the drawer then says who signed it off or sent it back", async () => {
    const h = await boot(904);
    delivered(h);
    const foot = () => [...drawer(h, 8120).querySelectorAll('.dr-foot [data-act="reviewDelivered"]')].map((b) => b.textContent);
    expect(foot()).toEqual(["✔ Sign off", "↩ Send back"]);
    expect(h.ev<string>("projDeliverablesTab(proj(7001),projectDeliverables(7001))")).toContain("✔ Sign off");
    expect(h.ev<string[]>("Object.values(DELIV_APPROVAL).map(s=>s.l)").slice(0, 3))
      .toEqual(["Awaiting sign-off", "Signed off", "Sent back"]);
    h.ev("ACTIONS.confirmSignOff({did:'8120',v:'approved'})");
    expect(kv(h, 8120, "Sign-off")).toBe(`Signed off by Lead Bravo · ${h.ev<string>("D.fmtDay(deliv(8120).approved_at)")}`);
    expect(foot()).toEqual([]);
    expect(h.ev<string>(`auditText({action:'deliverable.approval_changed',entity_type:'deliverable',entity_id:8120,
      before:{approval_status:'pending'},after:{approval_status:'approved'}})`)).toBe("signed off Photos edited");
    // Sent back after delivery: who, and what to change.
    h.ev("deliv(8120).approval_status='pending'; deliv(8120).status='delivered'");
    h.ev("ACTIONS.reviewDelivered({did:'8120',v:'changes_requested'})");
    (h.doc.getElementById("rd-note") as HTMLTextAreaElement).value = "Wrong logo at the end";
    h.ev("ACTIONS.confirmSignOff({did:'8120',v:'changes_requested'})");
    expect(kv(h, 8120, "Sign-off")).toBe("Sent back after delivery by Lead Bravo: Wrong logo at the end");
    expect(h.ev<string>(`auditText({action:'deliverable.approval_changed',entity_type:'deliverable',entity_id:8120,
      before:{approval_status:'pending'},after:{approval_status:'changes_requested'}})`)).toBe("sent Photos edited back after delivery");
  });

  it("the ⋯ menu: moves carry no status glyph, approval reads → Approve…, and Copy Drive link only with a link", async () => {
    const h = await boot(904);
    const items = () => h.ev<Array<{ label?: string; icon?: string; fn?: unknown }>>("MENUS.delivMenu({did:'8102'})");
    const moves = items().filter((i) => String(i.label).startsWith("→"));
    expect(moves.map((i) => i.label)).toContain("→ Approve…");
    expect(moves.every((i) => !i.icon)).toBe(true);
    expect(items().map((i) => i.label)).not.toContain("Copy Drive link");
    h.ev("ACTIONS.copyLink({did:'8102'})");
    expect(h.doc.querySelector("#toasts")!.textContent).toContain("no Drive link yet");
    h.ev(`DB.drive_links.push({id:99701,entity_type:'deliverable',entity_id:8102,label:'Aftermovie',
      url:'https://drive.google.com/x',validation_status:'ok'})`);
    expect(items().map((i) => i.label)).toContain("Copy Drive link");
  });

  it("the Drive link row: a copy glyph, and no bare 'ok' pill — only a problem is named", async () => {
    const h = await boot(902);
    h.ev(`DB.drive_links.push({id:99701,entity_type:'deliverable',entity_id:8102,label:'Aftermovie',
      url:'https://drive.google.com/x',validation_status:'ok'})`);
    const row = () => [...drawer(h, 8102).querySelectorAll(".list-row")]
      .find((r) => r.textContent!.includes("drive.google.com/x")) as HTMLElement;
    expect(row().textContent).not.toMatch(/\bok\b|Valid/);
    expect(row().querySelector('[data-act="copyURL"]')!.textContent).toBe("⧉ Copy");
    expect(drawer(h, 8102).innerHTML).not.toContain("⛁");
    h.ev("DB.drive_links.find(l=>l.id===99701).validation_status='broken'");
    expect(row().textContent).toContain("Broken");
    h.as(901);
    expect(h.ev<string>("projDeliverablesTab(proj(7001),projectDeliverables(7001))")).toContain("⧉ Copy");
  });

  it("the people on it see ▶ Start work while Not started — the same move as ⋯ → In progress", async () => {
    const h = await boot(902);
    h.ev("__dl(8121,'Reel','not_started')");
    const start = () => drawer(h, 8121).querySelector('.dr-foot [data-act="startWork"]') as HTMLElement | null;
    expect(start()?.textContent).toBe("▶ Start work");
    h.as(906);
    expect(start(), "the Coordinator is not on it").toBeNull();
    h.as(902);
    start()!.click();
    expect(h.writes().find((c) => c.url.endsWith("/deliverables/8121/status"))?.body).toEqual({ status: "in_progress" });
    expect(start(), "gone once in progress").toBeNull();
  });

  it("work in review tells the Coordinator who acts next", async () => {
    const h = await boot(906);
    expect(drawer(h, 8102).querySelector(".dr-foot [data-next]")?.textContent).toBe("Waiting for a Team Lead to review.");
    h.as(904);
    expect(drawer(h, 8102).querySelector(".dr-foot [data-next]"), "the reviewer has the buttons").toBeNull();
    h.as(902);
    expect(drawer(h, 8102).querySelector(".dr-foot [data-next]"), "the submitter reads their own line").toBeNull();
  });
});
