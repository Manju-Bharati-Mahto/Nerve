/* ═══════════════════════════════════════════════════════════════════════════
   UI — notifications, people and copy, as the round-3 browser test found them.

     · relative times read "3 min ago" / "2 h ago", not "3m ago";
     · the Coordinator's Activity timeline and a project's Next deadlines name
       people in full, and a row about a deliverable says which project;
     · a notice's tag fits it: an outcome reads "Approved" / "Changes
       requested", and a submission already reviewed reads "Reviewed";
     · "Deliverable added" by the Coordinator is filed with the Coordinator;
     · only an Admin is pointed at Settings → Work Types;
     · the start-up notice never lands on top of an open dialog;
     · counts are pluralised — "1 deliverable", "4 deliverables", never "(s)";
     · a project New project has only drawn asks the server nothing about it.

   The real public/media-ops/index.html, in jsdom, with the server replaced by
   a recording fetch. The server's half (stored text, the feed's read-time
   fields) is proven in server/mediaops-notices-copy.integration.test.ts.
   ═══════════════════════════════════════════════════════════════════════════ */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const HTML = readFileSync("public/media-ops/index.html", "utf8");

/*   901 Lead A (Event Team)   902 Emp A1 (Event Team)   906 Coordinator   907 Admin */
const FIXTURES = `
  const P=(id,n,r)=>DB.users.unshift({id,real_id:'znp-'+id,role:r,full_name:n,initials:'ZZ',color:'#888',is_active:true,designation:''});
  P(901,'Lead Alpha','team_lead'); P(902,'Emp Anika','employee'); P(906,'Coord Chitra','coordinator'); P(907,'Admin Dev','admin');
  DB.teams=[{id:9001,name:'Event Team',lead_user_id:901,is_active:true,sort_order:1}];
  DB.team_members=[{team_id:9001,user_id:902}];
  const T=DB.deliverable_types.find(t=>!t.review_exempt)||DB.deliverable_types[0];
  DB.projects.push({id:7001,name:'Annual Cultural Festival',code:'MC-7001',team_id:9001,owner_id:901,created_by:906,
    project_type_id:DB.project_types[0].id,status:'in_production',priority:'high',academic_unit_id:null,academic_year_id:3,
    start_date:TODAY,end_date:TODAY,description:'',tags:[],deleted_at:null});
  DB.project_assignments.push({id:99001,project_id:7001,user_id:901,is_project_manager:true,removed_at:null});
  DB.deliverables.push({id:8001,project_id:7001,deliverable_type_id:T.id,title:'Raw Archive',owner_id:902,
    due_date:TODAY,status:'in_progress',priority:'normal',deleted_at:null,approval_status:'pending',unit:'',
    quantity_target:null,quantity_delivered:null});
`;

async function boot(me: number) {
  const calls: Array<{ url: string; method: string }> = [];
  const dom = new JSDOM(HTML, { url: "http://localhost/api/media-ops/#/media/home",
    runScripts: "dangerously", pretendToBeVisual: true });
  const w = dom.window as unknown as { fetch: unknown; eval: (s: string) => unknown; confirm: unknown };
  w.confirm = () => true;
  w.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), method: String(init?.method ?? "GET") });
    return { ok: true, status: 200, json: async () => ({}) } as Response;
  };
  await new Promise((r) => setTimeout(r, 300));
  const ev = <T,>(e: string) => w.eval(e) as T;
  ev(FIXTURES);
  ev(`S.me=${me}; window.__MO_LIVE__=true;`);
  return { dom, ev, calls, doc: dom.window.document };
}

describe("Relative times are words", () => {
  it("reads 'n min ago', 'n h ago' and 'n days ago'", async () => {
    const h = await boot(902);
    const ago = (min: number) => h.ev<string>(`D.since(new Date(Date.now()-${min}*60000).toISOString())`);
    expect(ago(3)).toBe("3 min ago");
    expect(ago(125)).toBe("2 h ago");
    expect(ago(60 * 24 + 5)).toBe("1 day ago");
    expect(ago(60 * 24 * 3 + 5)).toBe("3 days ago");
  });
});

describe("People are named in full, and a row says which project", () => {
  it("the Coordinator's Activity timeline names the actor in full and the deliverable's project", async () => {
    const h = await boot(906);
    h.ev(`DB.my_activity=[
      {id:1,actor_id:906,action:'deliverable.archived',entity_type:'deliverable',entity_id:8001,before:null,after:{},occurred_at:new Date().toISOString()},
      {id:2,actor_id:906,action:'deliverable.dispatched',entity_type:'deliverable',entity_id:4242,before:null,
       after:{title:'Teaser Cut'},project_name:'Sports Week',occurred_at:new Date().toISOString()}]`);
    const card = h.ev<string>("coordActivityCard()");
    expect(card).toContain("Raw Archive on Annual Cultural Festival");
    // A deliverable the page does not hold: the server names its project.
    expect(card).toContain("Teaser Cut on Sports Week");
    expect(card).toContain("Coord Chitra");
    expect(card).not.toMatch(/·\s*Coord<\/span>/);
  });

  it("a project's Next deadlines names each owner in full", async () => {
    const h = await boot(901);
    const page = h.ev<string>("viewProject(7001,'overview')");
    expect(page).toContain("Emp Anika · ");
    expect(page).not.toMatch(/<span>Emp · /);
  });
});

describe("Notification tags fit the notice", () => {
  const N = (o: string) => `({id:1,user_id:901,entity_type:'deliverable',entity_id:8001,body:'',created_at:new Date().toISOString(),is_read:false,${o}})`;
  it("an outcome is tagged with the outcome; a reviewed submission reads 'Reviewed'", async () => {
    const h = await boot(901);
    const tag = (o: string) => h.ev<string>(`notifTag(${N(o)}).l`);
    expect(tag("kind:'review',title:'Approved: Raw Archive'")).toBe("Approved");
    expect(tag("kind:'review',title:'Changes requested on Raw Archive'")).toBe("Changes requested");
    expect(tag("kind:'review',title:'Version submitted for review',version_review_status:'pending'")).toBe("Review");
    expect(tag("kind:'review',title:'Version submitted for review',version_review_status:'approved'")).toBe("Reviewed");
    expect(tag("kind:'review',title:'Version submitted for review',version_review_status:'changes_requested'")).toBe("Reviewed");
    // An older server sends no status: the tag stays as it was.
    expect(tag("kind:'review',title:'Version submitted for review'")).toBe("Review");
    expect(tag("kind:'overdue',title:'Deliverable overdue'")).toBe("Overdue");
    h.ev(`DB.notifications=[${N("kind:'review',title:'Approved: Raw Archive'")}]`);
    const page = h.ev<string>("viewNotifications()");
    expect(page).toContain('<span class="chip">Approved</span>');
    expect(page).not.toContain('<span class="chip">Review</span>');
  });

  it("'Deliverable added' by an Admin or the Coordinator is filed with them, by a teammate with the team", async () => {
    const h = await boot(901);
    const src = (from: string) => h.ev<string>(
      `notifSource({kind:'assignment',entity_type:'deliverable',title:'Deliverable added'${from}})`);
    expect(src(",from_admin_or_coord:true")).toBe("coord");
    expect(src(",from_admin_or_coord:false")).toBe("team");
    expect(src("")).toBe("team");
  });
});

describe("Copy", () => {
  it("Assign work points only an Admin at Settings → Work Types", async () => {
    const h = await boot(901);
    h.ev("openAssignWork(7001)");
    expect(h.doc.getElementById("modal-layer")!.textContent).toContain("Pick the work type first.");
    expect(h.doc.getElementById("modal-layer")!.textContent).not.toContain("Settings → Work Types");
    h.ev("closeModal(); S.me=907; openAssignWork(7001)");
    expect(h.doc.getElementById("modal-layer")!.textContent).toContain("Settings → Work Types");
  });

  it("a start-up notice that arrives after a dialog opened is not shown over it", async () => {
    const h = await boot(906);
    h.ev("document.querySelector('#toasts').innerHTML=''; openNewProject()");
    h.ev("toast('Live · 63 projects','ok',null,{passing:true}); toast('Saved','ok')");
    const shown = [...h.doc.querySelectorAll("#toasts .toast")].map((n) => n.textContent).join(" ");
    expect(shown).toContain("Saved");
    expect(shown).not.toContain("Live · 63 projects");
    h.ev("closeModal(); toast('Live · 63 projects','ok',null,{passing:true})");
    expect(h.doc.querySelector("#toasts [data-passing]")).not.toBeNull();
  });

  it("counts are pluralised, and no '(s)' is left in what people read", async () => {
    const h = await boot(906);
    expect(h.ev<string>("plural(1,'deliverable')")).toBe("1 deliverable");
    expect(h.ev<string>("plural(4,'deliverable')")).toBe("4 deliverables");
    expect(h.ev<string>("plural(2,'person','people')")).toBe("2 people");
    /* Source scan: a word in text followed by "(s)" — " deliverable(s)", not
       code such as "fn(s)" or "if(s)" — outside comments. */
    const left = HTML.split("\n").map((l, i) => [i + 1, l] as const)
      .filter(([, l]) => /[\s>][a-z][a-z-]*\(s\)(?!\s*[{=])/.test(l) && !/^\s*(\/\*|\/\/|\*)/.test(l));
    expect(left.map(([n, l]) => `${n}: ${l.trim().slice(0, 100)}`)).toEqual([]);
  });
});

describe("Create project asks the server nothing about the project until it exists", () => {
  it("drawing the new project does not fetch its activity under a made-up id", async () => {
    const h = await boot(902);
    h.ev("openNewProject()");
    (h.doc.querySelector("#np-name") as HTMLInputElement).value = "Emp own reel";
    const before = h.calls.length;
    h.ev("ACTIONS.createProject()");
    const sent = h.calls.slice(before);
    expect(sent.some((c) => c.method === "POST" && c.url.endsWith("/projects"))).toBe(true);
    expect(sent.filter((c) => c.method === "GET" && /\/projects\/\d+\/activity/.test(c.url))).toEqual([]);
    // Once /state brings the real row back (no _optimistic mark), the feed is asked for.
    const id = h.ev<number>("DB.projects[DB.projects.length-1].id");
    h.ev(`delete DB.projects[DB.projects.length-1]._optimistic; S._projActs={}; projActivityRows(proj(${id}))`);
    expect(h.calls.some((c) => c.url.includes(`/projects/${id}/activity`))).toBe(true);
  });
});
