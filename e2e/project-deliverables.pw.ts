/* ═══════════════════════════════════════════════════════════════════════════
   A project's Deliverables table fits its card on a normal desktop.

   At 1440px the table ran 67px past its card: ◷ Schedule read "◷ Schedu" and
   a delivered row's sign-off buttons sat out of view until you scrolled
   sideways. Every column, and every row action, has to be visible without a
   horizontal scroll — on open work (owner picker, due date, Schedule, ⋯) and
   on delivered work waiting for its sign-off (Sign off, Send back, Copy).
   ═══════════════════════════════════════════════════════════════════════════ */
import { test, expect } from "@playwright/test";
import { bootStaff, go } from "./harness";

const FIXTURE = `(()=>{
  const T=DB.deliverable_types.find(t=>!t.review_exempt), owner=DB.users.find(u=>u.id===4);
  owner.full_name='Dummy Employee Kumarswamy Ramanathan';
  const team=DB.teams[0];
  DB.projects.push({id:97001,name:'Annual Cultural Festival 2026',code:'MC-2627-1882',team_id:team.id,
    owner_id:team.lead_user_id,created_by:1,project_type_id:DB.project_types[0].id,status:'in_production',
    priority:'high',academic_unit_id:DB.projects[0].academic_unit_id,academic_year_id:DB.projects[0].academic_year_id,
    start_date:TODAY,end_date:TODAY,description:'',tags:[],deleted_at:null});
  const dl=(id,title,status,extra)=>DB.deliverables.push(Object.assign({id,project_id:97001,deliverable_type_id:T.id,
    title,owner_id:owner.id,scheduled_date:TODAY,due_date:TODAY,due_date_source:'manual',status,priority:'normal',
    deleted_at:null,weight:1,approval_status:'pending',dispatch_status:'none',unit:'photos',quantity_target:120,
    quantity_delivered:40,completed_at:null},extra||{}));
  const v=(id,did,st)=>DB.deliverable_versions.push({id,deliverable_id:did,version_no:3,review_status:st,
    submitted_by:owner.id,submitted_at:TODAY+'T09:00:00Z',drive_url:'https://drive.google.com/'+id,
    reviewed_by:st==='pending'?null:2,reviewed_at:st==='pending'?null:TODAY+'T10:00:00Z',review_comment:''});
  dl(97101,'Photos — Edited, stage and crowd','in_progress'); v(97901,97101,'changes_requested');
  /* Dispatched while it waits for its sign-off: the recipient is one long word. */
  dl(97102,'Story / Post for the main stage','delivered',{completed_at:TODAY,delivered_by:owner.id,
    dispatch_status:'delivered',dispatched_at:TODAY+'T11:00:00Z',dispatch_recipient:'student.affairs@paruluniversity.ac.in'});
  v(97902,97102,'approved');
  DB.drive_links.push({id:97801,entity_type:'deliverable',entity_id:97102,url:'https://drive.google.com/x',label:'Final'});
})()`;

test.describe("at 1440 × 900", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("the Deliverables table fits its card, every row action in view", async ({ page }) => {
    await bootStaff(page, "admin");
    await page.evaluate(FIXTURE);
    await go(page, "#/media/projects/97001/deliverables");
    const m = await page.evaluate(() => {
      const wrap = document.querySelector("#page .pj-cards")!.closest(".tbl-wrap") as HTMLElement;
      const box = wrap.getBoundingClientRect();
      const acts = [...wrap.querySelectorAll("td.pj-acts .btn")].map((b) => {
        const r = b.getBoundingClientRect();
        return { t: (b.textContent || "").trim(), right: Math.round(r.right), clipped: b.scrollWidth > b.clientWidth + 1 };
      });
      return { table: wrap.scrollWidth, wrap: wrap.clientWidth, right: Math.round(box.right), acts };
    });
    expect(m.table, JSON.stringify(m)).toBeLessThanOrEqual(m.wrap);
    expect(m.acts.map((a) => a.t)).toEqual(expect.arrayContaining(["◷ Schedule", "✔ Sign off", "↩ Send back", "⧉ Copy"]));
    for (const a of m.acts) {
      expect(a.right, `${a.t} runs past the card`).toBeLessThanOrEqual(m.right);
      expect(a.clipped, `${a.t} is cut off`).toBe(false);
    }
  });
});
