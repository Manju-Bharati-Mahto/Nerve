/* ═══════════════════════════════════════════════════════════════════════════
   UI — handing PID equipment to a student.

   ONE CHECKOUT DIALOG, NOT A PID ONE. The only thing this phase changed in the
   browser is who the holder picker offers, and it offers students exactly when
   the asset's inventory says it lends to them.

   THE TWO ROSTERS STAY APART. DB.users is the Media Crew roster and every
   assignment picker in the app iterates it; merging the SMC roster into it
   would offer a student as crew everywhere else. They are concatenated here,
   in separate labelled groups, and nowhere else.
   ═══════════════════════════════════════════════════════════════════════════ */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const HTML = readFileSync("public/media-ops/index.html", "utf8");

const PID = { id: 12, code: "pid", name: "PID", code_prefix: "PID",
              lends_to_students: true, assets: 4 };
const MC  = { id: 11, code: "media_crew", name: "Media Crew", code_prefix: "MC",
              lends_to_students: false, assets: 7 };

async function openCheckout(o: { scopeId: number } ) {
  const dom = new JSDOM(HTML, { url: "http://localhost/api/media-ops/#/media/equipment",
    runScripts: "dangerously", pretendToBeVisual: true });
  const w = dom.window as unknown as { fetch: unknown; eval: (s: string) => unknown };
  w.fetch = async (input: RequestInfo | URL) => {
    const url = String(input);
    const reply = (s: number, b: unknown) => ({ ok: s < 400, status: s, json: async () => b }) as Response;
    if (url.includes("/equipment/inventories")) return reply(200, {
      inventories: [MC, PID], legacy: { code: "legacy", name: "Not Assigned", assets: 0 },
      scope_level: "all" });
    return reply(200, {});
  };
  await new Promise((r) => setTimeout(r, 300));
  const ev = <T,>(e: string) => w.eval(e) as T;
  ev("window.can = () => true; can = window.can;");
  /* The two rosters as the app holds them: crew in DB.users, students in
     DB.smc_people, never merged. */
  ev(`DB.users = [{id:'u-me',full_name:'Me',is_active:true},
                  {id:'u-crew',full_name:'Asha Rao',is_active:true}];
      DB.smc_people = [{id:'smc-1',full_name:'Priya Student',status:'active',institute:'Faculty of Design'},
                       {id:'smc-2',full_name:'Neel Gone',status:'inactive',institute:'Faculty of Design'}];
      S.me='u-me';
      EQ_INV.rows = [${JSON.stringify(MC)}, ${JSON.stringify(PID)}];`);
  /* equip() reads the live cache only when the page believes it is live;
     offline it reads the seed array instead, and the dialog would open on an
     empty asset. */
  ev("window.__MO_LIVE__ = true;");
  ev(`ASSETS.byId.set(9, {id:9, asset_tag:'EQ-CAM-009', internal_code:'PID-0004',
        make:'SONY', model:'FX3', scope_id:${o.scopeId}, inventory_name:'X',
        condition:'good', status:'available',
        state:{lifecycle:{status:'available'},custody:{status:'not_held'}}});`);
  ev("ACTIONS.checkout({eid:9})");
  await new Promise((r) => setTimeout(r, 240));
  return { dom, ev,
    layer: () => dom.window.document.getElementById("modal-layer")?.innerHTML ?? "" };
}

describe("handing PID equipment to a student", () => {
  it("offers students for a PID asset, in their own labelled group", async () => {
    const m = (await openCheckout({ scopeId: PID.id })).layer();
    expect(m).toContain("Priya Student");
    expect(m).toMatch(/<optgroup label="Students — PID">/);
    expect(m).toMatch(/<optgroup label="Media Crew">/);
    /* Crew and students are both there, and they are not the same list. */
    expect(m).toContain("Asha Rao");
    expect(m).toMatch(/recorded as handing it over/i);
  });

  it("offers no students for a Media Crew asset", async () => {
    const m = (await openCheckout({ scopeId: MC.id })).layer();
    expect(m).toContain("Asha Rao");
    expect(m, "a student was offered for a Media Crew asset").not.toContain("Priya Student");
    expect(m).not.toMatch(/<optgroup label="Students/);
  });

  it("leaves out a student whose account is not active", async () => {
    const m = (await openCheckout({ scopeId: PID.id })).layer();
    expect(m).toContain("Priya Student");
    expect(m, "an inactive student was offered").not.toContain("Neel Gone");
  });

  it("keeps the two rosters apart everywhere else", async () => {
    /* The fix is a concatenation in ONE picker, not a merge. If DB.users ever
       grows the SMC roster, every assignment picker in the app starts offering
       students as crew. */
    const src = readFileSync("public/media-ops/index.html", "utf8");
    expect(src, "the SMC roster was merged into the crew roster")
      .not.toMatch(/DB\.users\s*=\s*\[?\s*\.\.\.\s*DB\.users\s*,\s*\.\.\.\s*\(?DB\.smc_people/);
    const dialog = src.slice(src.indexOf("const mayLend=can('equipment.manage');"));
    expect(dialog.slice(0, 1200)).toContain("DB.smc_people");
  });
});
