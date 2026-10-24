/* ═══════════════════════════════════════════════════════════════════════════
   UI — the Coordinator's dispatch queue and the "Ready to dispatch" notice.

   Approved work is queued for dispatch, and a review-exempt type (raw
   footage, a recording) is ready once it is delivered — the server's
   /dispatch has always accepted it, but the page's queue left it out. The
   notice the server sends when something joins the queue opens the queue.
   The server half is in server/mediaops-dispatch-notice.integration.test.ts.
   ═══════════════════════════════════════════════════════════════════════════ */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const HTML = readFileSync("public/media-ops/index.html", "utf8");

/* 911 Lead, 912 Employee, 916 Coordinator — ids far from the seed. */
const FIXTURES = `
  const P=(id,n,r)=>DB.users.unshift({id,real_id:'zdq-'+id,role:r,full_name:n,initials:'ZZ',color:'#888',is_active:true,designation:''});
  P(911,'Lead Lata','team_lead'); P(912,'Emp Esha','employee'); P(916,'Coord Chitra','coordinator');
  DB.teams=[{id:9101,name:'Event Team',lead_user_id:911,is_active:true,sort_order:1}];
  DB.team_members=[{team_id:9101,user_id:912}];
  const R=DB.deliverable_types.find(t=>!t.review_exempt), X=DB.deliverable_types.find(t=>t.review_exempt);
  DB.projects.push({id:7101,name:'Convocation',code:'MC-7101',team_id:9101,owner_id:911,created_by:916,
    project_type_id:DB.project_types[0].id,status:'in_production',priority:'high',academic_unit_id:null,academic_year_id:3,
    start_date:TODAY,end_date:TODAY,description:'',tags:[],deleted_at:null});
  const dl=(id,type,title,status,dispatch)=>DB.deliverables.push({id,project_id:7101,deliverable_type_id:type.id,title,
    owner_id:912,due_date:TODAY,status,priority:'normal',deleted_at:null,approval_status:'pending',
    dispatch_status:dispatch,unit:'',quantity_target:null,quantity_delivered:null});
  dl(8101,R,'Edited Photos','approved','queued');
  dl(8102,X,'Raw Footage','delivered','none');
  dl(8103,X,'Stage Recording','in_progress','none');
  dl(8104,X,'Drone Clips','delivered','delivered');
  dl(8105,R,'Aftermovie','changes_requested','none');
  DB.deliverable_versions.push(
    {id:88101,deliverable_id:8101,version_no:1,review_status:'approved',submitted_by:912,reviewed_by:911,submitted_at:TODAY+'T09:00:00Z',drive_url:'https://drive.google.com/a'},
    {id:88105,deliverable_id:8105,version_no:1,review_status:'changes_requested',submitted_by:912,reviewed_by:911,submitted_at:TODAY+'T09:00:00Z',drive_url:'https://drive.google.com/b'});
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
  /** A view's HTML, parsed so it can be queried. */
  const view = (fn: string) => {
    const el = dom.window.document.createElement("div");
    el.innerHTML = ev<string>(`${fn}()`);
    return el;
  };
  return { ev, writes, view, doc: dom.window.document };
}

const queued = (h: Awaited<ReturnType<typeof boot>>) =>
  h.ev<number[]>(`dispatchQueue().map(d=>d.id)`).filter((id) => id >= 8101 && id <= 8105).sort();

describe("Dispatch queue — everything the server would dispatch, and nothing else", () => {
  it("holds approved work and delivered review-exempt work", async () => {
    const h = await boot(916);
    // 8103 is not delivered yet, 8104 went out already, 8105 was sent back.
    expect(queued(h)).toEqual([8101, 8102]);
  });

  it("the queue tab lists the review-exempt item, shown as queued", async () => {
    const h = await boot(916);
    const el = h.view("viewDispatch");
    const row = [...el.querySelectorAll(".dc")].find((r) => r.textContent!.includes("Raw Footage"));
    expect(row, "the delivered raw footage is not in the queue").toBeTruthy();
    expect(row!.textContent).toContain("Queued for dispatch");
    expect(el.textContent).not.toContain("Stage Recording");
  });

  it("Home's 'Ready for dispatch' counts the same queue", async () => {
    const h = await boot(916);
    const el = h.view("viewCoordDashboard");
    const card = [...el.querySelectorAll(".stat")].find((c) => c.textContent!.includes("Ready for dispatch"));
    expect(card).toBeTruthy();
    expect(card!.querySelector(".stat-val")!.textContent!.trim()).toBe(String(h.ev<number>(`dispatchQueue().length`)));
  });

  it("delivering a review-exempt item puts it in the queue straight away", async () => {
    const h = await boot(912);
    h.ev(`ACTIONS.markDelivered({did:8103})`);
    expect(queued(h)).toEqual([8101, 8102, 8103]);
    expect(h.ev<string>(`deliv(8103).dispatch_status`)).toBe("queued");
    expect(h.writes().some((c) => c.url.endsWith("/deliverables/8103/deliver"))).toBe(true);
  });
});

describe("The 'Ready to dispatch' notice", () => {
  it("opens the dispatch queue, not the item's drawer", async () => {
    const h = await boot(916);
    expect(h.ev<string>(`notifTarget({kind:'dispatch',entity_type:'deliverable',entity_id:8101,project_id:7101}).hash`))
      .toBe("#/media/dispatch");
    // Every other deliverable notice still opens the deliverable.
    expect(Object.keys(h.ev<Record<string, unknown>>(`notifTarget({kind:'review',entity_type:'deliverable',entity_id:8101})`)))
      .toContain("drawer");
  });

  it("is labelled in plain words", async () => {
    const h = await boot(916);
    expect(h.ev<string>(`notifKind('dispatch').l`)).toBe("Ready to dispatch");
  });
});

describe("Dispatch page — one word per meaning", () => {
  it("the tab, figure and columns for what the Coordinator sent say 'Dispatched'", async () => {
    const h = await boot(916);
    const tabs = [...h.view("viewDispatch").querySelectorAll('.tabs [data-tabkey="dispatch"]')].map((b) => b.textContent);
    expect(tabs.some((t) => /^Dispatched/.test(t!))).toBe(true);
    expect(tabs.some((t) => /^Delivered/.test(t!))).toBe(false);
    expect(h.ev<string>("DISPATCH.delivered.l")).toBe("Dispatched");
    h.ev("S.tab.dispatch='delivered'");
    const heads = [...h.view("viewDispatch").querySelectorAll("thead th")].map((t) => t.textContent);
    expect(heads).toContain("Dispatched by");
    expect(heads).not.toContain("Delivered by");
    // The Coordinator's My Day uses the same word.
    const home = h.ev<string>("viewCoordMyDay()");
    expect(home).toContain("Dispatched today");
    expect(home).not.toMatch(/Delivered today|Email sent → Delivered/);
  });

  it("a queued item's main action is a labelled Dispatch… button", async () => {
    const h = await boot(916);
    const btn = h.view("viewDispatch").querySelector('[data-act="markSent"][data-did="8101"]')!;
    expect(btn.textContent).toContain("Dispatch…");
  });

  it("Confirm dispatch says what happens: it is recorded, not archived", async () => {
    const h = await boot(916);
    h.ev("ACTIONS.markSent({did:'8101'})");
    const text = h.doc.getElementById("modal-layer")!.textContent!;
    expect(text).not.toMatch(/archive entry|operational loop/);
    expect(text).toContain("Archive it from there afterwards");
  });

  it("Archive asks first, naming the item, and does nothing when declined", async () => {
    const h = await boot(916);
    const asked: string[] = [];
    h.ev("window.__answer=false");
    (h.doc.defaultView as unknown as { confirm: (m: string) => boolean }).confirm =
      (m: string) => { asked.push(m); return h.ev<boolean>("window.__answer"); };
    h.ev("ACTIONS.archiveDeliv({did:'8104'})");
    expect(asked[0]).toContain("Drone Clips");
    expect(h.writes().some((c) => c.url.endsWith("/deliverables/8104/archive"))).toBe(false);
    h.ev("window.__answer=true");
    h.ev("ACTIONS.archiveDeliv({did:'8104'})");
    expect(h.writes().some((c) => c.url.endsWith("/deliverables/8104/archive"))).toBe(true);
  });
});

describe("The 'Ready to dispatch' notice — opens on its item", () => {
  it("picks out the item it names on the queue, for this visit", async () => {
    const h = await boot(916);
    h.ev("S.tab.dispatch='archive'");
    h.ev("window.__t=notifTarget({kind:'dispatch',entity_type:'deliverable',entity_id:8101,project_id:7101}); window.__t.before()");
    expect(h.ev<string>("window.__t.scrollTo")).toBe('[data-dispatch-did="8101"]');
    expect(h.ev<string>("S.tab.dispatch")).toBe("queue");
    const page = h.view("viewDispatch");
    expect((page.querySelector('[data-dispatch-did="8101"]') as HTMLElement).style.outline).toContain("2px");
    expect((page.querySelector('[data-dispatch-did="8102"]') as HTMLElement).style.outline).toBe("");
  });

  it("an item already dispatched opens on the Dispatched tab", async () => {
    const h = await boot(916);
    h.ev("notifTarget({kind:'dispatch',entity_type:'deliverable',entity_id:8104}).before()");
    expect(h.ev<string>("S.tab.dispatch")).toBe("delivered");
    expect(h.view("viewDispatch").querySelector('tr[data-dispatch-did="8104"]')).not.toBeNull();
  });
});
