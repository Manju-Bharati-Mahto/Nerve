/* ═══════════════════════════════════════════════════════════════════════════
   UI — Projects, its menus and forms, as the live browser test found them.

     · assignment lists name people by their team or Media Ops role — never a
       free-text job title that says "Coordinator" — and tell two people with
       the same name apart; who is listed follows the server's rule;
     · a project's ⋯ menu holds only what this person can use, and the status
       pill offers a menu (▾) only when there is a move to make;
     · an Admin deletes a project from List, Table and Calendar alike;
     · an employee's own project names them its Owner, and its work is theirs;
     · New project and Assign work speak plain words, once.

   The real public/media-ops/index.html, in jsdom, with the server replaced by
   a recording fetch. The server's half of the eligibility rule is proven in
   server/mediaops-add-deliverable.integration.test.ts.
   ═══════════════════════════════════════════════════════════════════════════ */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const HTML = readFileSync("public/media-ops/index.html", "utf8");

/*   901 Lead A (Event Team)   902 Emp A1 (Event Team)   906 Coordinator   907 Admin
     908 a Team Lead whose job title is "Media Operations Coordinator", on no team
     910, 911 two employees with the same name                                 */
const FIXTURES = `
  const P=(id,n,r,x)=>DB.users.unshift(Object.assign({id,real_id:'zpc-'+id,role:r,full_name:n,initials:'ZZ',color:'#888',
    is_active:true,designation:''},x||{}));
  P(901,'Lead Alpha','team_lead'); P(902,'Emp Anika','employee');
  P(906,'Coord Chitra','coordinator'); P(907,'Admin Dev','admin');
  P(908,'Ishita Probe','team_lead',{designation:'Media Operations Coordinator'});
  P(910,'Priya Twin','employee',{email:'priya.one@x.invalid'}); P(911,'Priya Twin','employee',{email:'priya.two@x.invalid'});
  DB.teams=[{id:9001,name:'Event Team',lead_user_id:901,is_active:true,sort_order:1}];
  DB.team_members=[{team_id:9001,user_id:902}];
  const T=DB.deliverable_types.find(t=>t.is_active!==false&&!t.archived_at)||DB.deliverable_types[0];
  window.__T=T;
  const proj=(id,name,team,owner)=>DB.projects.push({id,name,code:'MC-'+id,team_id:team,owner_id:owner,created_by:906,
    project_type_id:DB.project_types[0].id,status:'in_production',priority:'high',academic_unit_id:null,academic_year_id:3,
    start_date:TODAY,end_date:TODAY,description:'',tags:[],deleted_at:null});
  proj(7001,'Annual Cultural Festival',9001,901);
  proj(7005,'Anika Reel',null,902);
  DB.project_assignments.push({id:99001,project_id:7001,user_id:901,is_project_manager:true,removed_at:null},
                              {id:99005,project_id:7005,user_id:902,is_project_manager:true,removed_at:null});
  DB.deliverables.push({id:8001,project_id:7001,deliverable_type_id:T.id,title:T.name,owner_id:902,
    due_date:TODAY,status:'not_started',priority:'normal',deleted_at:null,unit:'',quantity_target:null,quantity_delivered:null});
`;

async function boot(me: number) {
  const dom = new JSDOM(HTML, { url: "http://localhost/api/media-ops/#/media/home",
    runScripts: "dangerously", pretendToBeVisual: true });
  const w = dom.window as unknown as { fetch: unknown; eval: (s: string) => unknown; confirm: unknown };
  w.confirm = () => true;
  w.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) }) as Response;
  await new Promise((r) => setTimeout(r, 300));
  const ev = <T,>(e: string) => w.eval(e) as T;
  ev(FIXTURES);
  ev(`S.me=${me}; window.__MO_LIVE__=true;`);
  const as = (id: number) => ev(`S.me=${id}`);
  /** A view's HTML, parsed so it can be queried. */
  const view = (js: string) => {
    const el = dom.window.document.createElement("div");
    el.innerHTML = ev<string>(js);
    return el;
  };
  return { ev, as, view, doc: dom.window.document };
}

describe("Assignment lists — who is in them, and how they are named", () => {
  it("a Team Lead titled 'Coordinator' is listed as a Team Lead; the Coordinator and the Admin are left out", async () => {
    const h = await boot(901);
    const ids = h.ev<number[]>("assignableMembers().map(u=>u.id)");
    expect(ids).toContain(908);
    expect(ids).not.toContain(906);
    expect(ids).not.toContain(907);
    expect(h.ev<string>("personLabel(908)")).toBe("Ishita Probe · Team Lead");
    h.ev("openAssignWork(7001)");
    const chip = h.doc.querySelector('#aw-users .chip[data-uid="908"]')!.textContent;
    expect(chip).toBe("Ishita Probe · Team Lead");
    expect(h.doc.getElementById("aw-users")!.textContent).not.toMatch(/Coordinator/);
  });

  it("the Coordinator is listed only with the production worker duty — the server's rule", async () => {
    const h = await boot(901);
    h.ev(`DB.duty_flags=[{id:77,code:'production_worker',is_active:true}]; DB.user_duties=[{user_id:906,duty_flag_id:77}]`);
    expect(h.ev<number[]>("assignableMembers().map(u=>u.id)")).toContain(906);
    expect(h.ev<string>("personLabel(906)")).toBe("Coord Chitra · Coordinator");
  });

  it("two people with the same name are told apart by their email — both with the same kind of tag", async () => {
    const h = await boot(901);
    const a = h.ev<string>("personLabel(910)"), b = h.ev<string>("personLabel(911)");
    // Neither is on a team: both say so, then their email — never a role for one of them.
    expect(a).toBe("Priya Twin · No team · priya.one@x.invalid");
    expect(b).toBe("Priya Twin · No team · priya.two@x.invalid");
    // One of them joins a team: the pair still reads team, then email.
    h.ev("DB.team_members.push({team_id:9001,user_id:910})");
    expect(h.ev<string>("personLabel(910)")).toBe("Priya Twin · Event Team · priya.one@x.invalid");
    expect(h.ev<string>("personLabel(911)")).toBe("Priya Twin · No team · priya.two@x.invalid");
    // Every people picker labels them the same way — the card form's assignees included.
    h.ev("openAssignWork(7001)");
    expect(h.doc.querySelector('#aw-users .chip[data-uid="911"]')!.textContent).toBe("Priya Twin · No team · priya.two@x.invalid");
    h.ev("closeModal(); openNewCard(DB.boards[0].id)");
    // A board card's assignees were first names only ("Priya", twice).
    expect(h.doc.querySelector('#nc-assign .chip[data-uid="911"]')!.textContent!.trim()).toBe("Priya Twin · No team · priya.two@x.invalid");
    // Someone whose name is theirs alone keeps the short label.
    expect(h.ev<string>("personLabel(902)")).toBe("Emp Anika · Event Team");
  });
});

describe("Project ⋯ menu and status pill — only what this person can use", () => {
  const menu = (h: Awaited<ReturnType<typeof boot>>) =>
    h.ev<Array<{ label?: string; sep?: boolean; disabled?: boolean }>>("MENUS.projMore({pid:'7001'})");

  it("the Coordinator is offered no Assign crew, Delete, Archive or Cancel — hidden, not greyed out", async () => {
    const h = await boot(906);
    const items = menu(h);
    expect(items.map((i) => i.label)).toEqual(["Edit details", "Add Drive link"]);
    expect(items.some((i) => i.disabled)).toBe(false);
  });

  it("the project's lead keeps assigning, editing and cancelling; the Admin also deletes and archives", async () => {
    const h = await boot(901);
    expect(menu(h).map((i) => i.label ?? "—")).toEqual(
      ["Assign crew", "Edit details", "Add Drive link", "—", "Cancel project"]);
    h.as(907);
    expect(menu(h).map((i) => i.label)).toContain("Delete project");
  });

  it("the status pill carries ▾ only when there is a move to make", async () => {
    const h = await boot(906);
    const pill = () => h.view("viewProject(7001,'overview')").querySelector('[data-menu="projStatus"]')!;
    expect(pill().textContent).not.toContain("▾");
    expect(pill().hasAttribute("disabled")).toBe(true);
    h.as(901);
    expect(pill().textContent).toContain("▾");
  });
});

describe("Delete project — the Admin's, in every view", () => {
  it("the Table row and the Calendar card offer it to the Admin, as the List row does", async () => {
    const h = await boot(907);
    expect(h.ev<string>("projTable(visibleProjects())")).toContain("ACTIONS.deleteProject({pid:7001})");
    const card = h.view("pcEvHTML(TODAY,'po:7001',false)");
    const del = card.querySelector('[data-pc="del"]') as HTMLElement;
    expect(del.textContent).toContain("Delete project");
    expect(del.dataset.pid).toBe("7001");
  });

  it("no one else is offered it", async () => {
    const h = await boot(901);
    expect(h.ev<string>("projTable(visibleProjects())")).not.toContain("deleteProject");
    expect(h.view("pcEvHTML(TODAY,'po:7001',false)").querySelector('[data-pc="del"]')).toBeNull();
  });
});

describe("An employee's own project", () => {
  it("names the employee its Owner, and its team 'Own project'", async () => {
    const h = await boot(902);
    const html = h.ev<string>("viewProject(7005,'overview')");
    expect(html).toContain("Own project");
    expect(html).not.toContain("Not assigned");
    expect(html).not.toMatch(/>Team lead</);
    expect(html).toMatch(/>Owner<\/span>\s*<b>Emp Anika<\/b>/);
  });

  it("a routed project still names its Team lead", async () => {
    const h = await boot(901);
    expect(h.ev<string>("viewProject(7001,'overview')")).toMatch(/>Team lead<\/span>\s*<b>Lead Alpha<\/b>/);
  });

  it("creating one says the deliverables are the employee's", async () => {
    const h = await boot(902);
    h.ev("openNewProject()");
    (h.doc.getElementById("np-name") as HTMLInputElement).value = "My Reel Project";
    h.ev("ACTIONS.npAddDeliverable()");
    h.ev("document.querySelector('#toasts').innerHTML=''");
    h.ev("ACTIONS.createProject()");
    const said = h.doc.getElementById("toasts")!.textContent;
    expect(said).toContain("Created · 1 deliverable · assigned to you");
    expect(said).not.toContain("yours to assign");
  });
});

describe("New project and Add deliverable — plain words", () => {
  it("has no 'Duplicate scan' line", async () => {
    const h = await boot(906);
    h.ev("openNewProject()");
    expect(h.doc.getElementById("modal-layer")!.textContent).not.toMatch(/Duplicate scan/);
  });

  it("a repeated type shows the name it will be created with, as the rows change", async () => {
    const h = await boot(906);
    h.ev("openNewProject()");
    h.ev("ACTIONS.npAddDeliverable(); ACTIONS.npAddDeliverable();");
    const rows = () => [...h.doc.querySelectorAll("#np-delivs .np-d")];
    const setType = (i: number, id: number) => {
      const sel = rows()[i].querySelector(".np-d-type") as HTMLSelectElement;
      sel.value = String(id); sel.dispatchEvent(new h.doc.defaultView!.Event("change"));
    };
    const T = h.ev<{ id: number; name: string }>("window.__T");
    setType(0, T.id); setType(1, T.id);
    const name = (i: number) => rows()[i].querySelector(".np-d-name") as HTMLElement;
    expect(name(0).hidden).toBe(true);
    expect(name(1).hidden).toBe(false);
    expect(name(1).textContent).toBe(`Will be named “${T.name} (2)”`);
    // Another type on the second row: no number, no line.
    const other = h.ev<number>(`pickableDelivTypes().find(t=>t.id!==${T.id}).id`);
    setType(1, other);
    expect(name(1).hidden).toBe(true);
  });

  it("on an existing project the numbering counts what it already has", async () => {
    const h = await boot(906);
    h.ev("openAddDeliverable(7001)");
    const T = h.ev<{ id: number; name: string }>("window.__T");
    const sel = h.doc.querySelector("#np-delivs .np-d-type") as HTMLSelectElement;
    sel.value = String(T.id); sel.dispatchEvent(new h.doc.defaultView!.Event("change"));
    expect(h.doc.querySelector("#np-delivs .np-d-name")!.textContent).toBe(`Will be named “${T.name} (2)”`);
  });
});

describe("Assign work — one label, one hint", () => {
  it("says 'Deliverable' once, and one hint for the chosen mode", async () => {
    const h = await boot(901);
    h.ev("openAssignWork(7001)");
    const layer = h.doc.getElementById("modal-layer")!;
    const labels = () => [...layer.querySelectorAll(".lbl")]
      .filter((l) => !(l.closest("[hidden]"))).map((l) => l.textContent!.trim());
    const hints = () => [...layer.querySelectorAll("#aw-body .hint")]
      .filter((n) => !(n as HTMLElement).hidden && !n.closest("[hidden]") && n.textContent!.trim())
      .filter((n) => !n.closest("#aw-ownerf") && n.closest(".field")!.querySelector("#aw-dmode, #aw-dtype, #aw-deliv"));
    expect(labels().filter((l) => /^Deliverable/.test(l))).toEqual(["Deliverable"]);
    expect(hints()).toHaveLength(1);
    h.ev("ACTIONS.awDelivMode({m:'existing'})");
    expect(labels().filter((l) => /^Deliverable/.test(l))).toEqual(["Deliverable"]);
    expect(hints().map((n) => n.id)).toEqual(["aw-dcur"]);
    h.ev("ACTIONS.awDelivMode({m:'none'})");
    expect(hints().map((n) => n.textContent)).toEqual(["Plain work with no project output."]);
  });

  it("shows no internal form name under Work type", async () => {
    const h = await boot(901);
    h.ev("openAssignWork(7001)");
    const layer = h.doc.getElementById("modal-layer")!;
    expect(layer.querySelector("#aw-tplhint")).toBeNull();
    expect(layer.textContent).not.toMatch(/Form:/);
    h.ev("ACTIONS.awTypeChange()");
    expect(layer.textContent).not.toMatch(/Form:/);
  });
});
