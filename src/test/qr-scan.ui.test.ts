/* ═══════════════════════════════════════════════════════════════════════════
   UI — Scan to asset (QR identification).

   A QR IDENTIFIES AND DECIDES NOTHING, and most of what is worth asserting
   here follows from that one sentence.

   The screen sends the scanned string to the resolve endpoint and renders the
   SERVER'S answer. It never takes the asset id, the inventory, the holder or
   the lifecycle from the code, because a sticker is a thing anybody can
   photograph and reprint. The tests below check that a forged payload changes
   nothing about what is asked for or what is shown.

   THE TYPED BOX AND THE CAMERA ARE ONE PATH. Both call the same endpoint with
   the same string; a second lookup would be a second place for the
   authorization rules to drift.
   ═══════════════════════════════════════════════════════════════════════════ */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const HTML = readFileSync("public/media-ops/index.html", "utf8");

const ITEM = (o: Record<string, unknown> = {}) => ({
  id: 7, asset_tag: "EQ-CAM-007", internal_code: "MC-0024", make: "SONY", model: "FX3",
  category_name: "Camera Body", inventory_name: "Media Crew",
  condition: "good", status: "available", verification_state: "active",
  state: {
    lifecycle: { status: "available" },
    custody: { status: "not_held", holder_name: null, due_at: null },
    verification: { state: "active" }, maintenance: { active: false, open_count: 0 },
    reservation: null, derived: { overdue: false }, conflicts: [],
  }, ...o,
});

async function open(o: { resolve?: (url: string) => { status: number; body: unknown };
                         detector?: boolean } = {}) {
  const calls: string[] = [];
  const dom = new JSDOM(HTML, { url: "http://localhost/api/media-ops/#/media/equipment",
    runScripts: "dangerously", pretendToBeVisual: true });
  const w = dom.window as unknown as { fetch: unknown; eval: (s: string) => unknown;
                                       BarcodeDetector?: unknown };
  if (o.detector) w.BarcodeDetector = function () { /* present but unused in jsdom */ };
  w.fetch = async (input: RequestInfo | URL) => {
    const url = String(input); calls.push(url);
    const reply = (s: number, b: unknown) => ({ ok: s < 400, status: s, json: async () => b }) as Response;
    if (url.includes("/api/v1/media/state")) return reply(200, {});
    if (url.includes("/equipment/resolve/")) {
      const r = o.resolve ? o.resolve(url) : { status: 200, body: { item: ITEM(),
        matched: { kind: "qr", value: "AT-DEADBEEF" } } };
      return reply(r.status, r.body);
    }
    if (url.includes("/equipment/inventories")) return reply(200, { inventories: [], legacy: null,
      scope_level: "all" });
    return reply(200, { items: [], total: 0, limit: 50, offset: 0 });
  };
  await new Promise((r) => setTimeout(r, 300));
  const ev = <T,>(e: string) => w.eval(e) as T;
  ev("window.can = () => true; can = window.can;");
  ev("ACTIONS.eqScan()");
  await new Promise((r) => setTimeout(r, 200));
  const type = async (code: string) => {
    ev(`$('#modal-layer').querySelector('#scan-code').value = ${JSON.stringify(code)};`);
    ev("$('#modal-layer').querySelector('#scan-go').click();");
    await new Promise((r) => setTimeout(r, 240));
  };
  return { dom, ev, calls, type,
    layer: () => dom.window.document.getElementById("modal-layer")?.innerHTML ?? "" };
}

describe("scan to asset", () => {
  it("always offers a typed code, camera or no camera", async () => {
    /* jsdom has no BarcodeDetector, which is the same situation as Safari or a
       locked-down tablet — and the box still has to be there. */
    const h = await open();
    expect(h.layer()).toContain('id="scan-code"');
    expect(h.layer()).toMatch(/cannot use the camera/i);
    expect(h.layer(), "the fallback was not explained").toMatch(/resolves exactly the same way/i);
  });

  it("resolves a typed code through the existing endpoint and nothing else", async () => {
    const h = await open();
    /* Measured from the moment the code is entered. The equipment page loads
       its own catalogue at boot, which is not what this is about — the claim
       is that RESOLVING one code costs one request. */
    const before = h.calls.length;
    await h.type("MC-0024");
    const during = h.calls.slice(before);
    expect(during.filter((u) => u.includes("/equipment/resolve/MC-0024")).length).toBe(1);
    expect(during.length, `resolving one code made ${during.length} requests: ${during.join(", ")}`)
      .toBe(1);
  });

  it("shows what the server returned, including where it matched", async () => {
    const h = await open();
    await h.type("AT-DEADBEEF");
    const m = h.layer();
    expect(m).toContain("SONY FX3");
    expect(m).toContain("MC-0024");
    expect(m).toContain("Media Crew");
    expect(m).toContain("Camera Body");
    expect(m).toMatch(/matched on qr/i);
    expect(m).toMatch(/on the shelf/i);
  });

  it("offers the actions the SERVER'S state allows, not the ones the code claims", async () => {
    const avail = await open();
    await avail.type("X");
    expect(avail.layer()).toMatch(/Check out/);
    expect(avail.layer()).toMatch(/Reserve/);
    expect(avail.layer(), "a shelved asset offered check-in").not.toMatch(/Check in/);

    const out = await open({ resolve: () => ({ status: 200, body: { item: ITEM({
      status: "checked_out",
      state: { lifecycle: { status: "checked_out" },
               custody: { status: "held", holder_name: "Asha Rao", due_at: "2026-10-01" },
               verification: { state: "active" }, maintenance: { active: false, open_count: 0 },
               reservation: null, derived: { overdue: false }, conflicts: [] } }),
      matched: { kind: "qr", value: "X" } } }) });
    await out.type("X");
    expect(out.layer()).toMatch(/Check in/);
    expect(out.layer(), "a held asset offered checkout").not.toMatch(/Check out/);
    expect(out.layer()).toContain("Asha Rao");
    expect(out.layer()).toContain("2026-10-01");
  });

  it("ignores an id, an inventory and a holder forged into the QR payload", async () => {
    /* The screen asks the server about the STRING and renders the reply. A
       code carrying its own JSON is just a long string to look up. */
    const forged = JSON.stringify({ id: 999, inventory_name: "PID", holder: "somebody",
                                    status: "available" });
    const h = await open({ resolve: () => ({ status: 404,
      body: { message: "No asset carries that identifier." } }) });
    await h.type(forged);
    expect(h.calls.some((u) => u.includes("/equipment/resolve/")),
      "the forged payload did not go to the server for adjudication").toBe(true);
    expect(h.calls.some((u) => u.includes("/equipment/999")),
      "the id inside the QR was used directly").toBe(false);
    expect(h.layer()).toMatch(/No asset found for that code/i);
    expect(h.layer(), "a forged inventory was displayed").not.toContain("PID");
  });

  it("does not distinguish an unknown code from one in another inventory", async () => {
    /* The API answers both with the same 404 on purpose. The screen must not
       reintroduce the difference in its wording. */
    const h = await open({ resolve: () => ({ status: 404,
      body: { message: "No asset carries that identifier." } }) });
    await h.type("EQ-PID-001");
    const m = h.layer();
    expect(m).toMatch(/No asset found for that code/i);
    for (const leak of [/another scope/i, /not authorised/i, /not authorized/i,
                        /permission/i, /exists/i])
      expect(m, `the error hinted at existence: ${leak}`).not.toMatch(leak);
  });

  it("explains a retired label without implying the asset is gone", async () => {
    const h = await open({ resolve: () => ({ status: 410,
      body: { message: "That identifier has been retired. The label should be replaced." } }) });
    await h.type("OLD-TOKEN");
    expect(h.layer()).toMatch(/label has been retired/i);
    expect(h.layer()).toMatch(/print a fresh label/i);
  });

  it("says the network failed without pretending anything was recorded", async () => {
    const h = await open({ resolve: () => { throw new Error("Failed to fetch"); } });
    await h.type("MC-0024");
    expect(h.layer()).toMatch(/Unable to connect to Nerve/i);
    expect(h.layer()).toMatch(/Nothing has been recorded/i);
  });

  it("sends an empty box nowhere", async () => {
    const h = await open();
    const before = h.calls.length;
    await h.type("   ");
    expect(h.calls.length, "an empty code was sent to the server").toBe(before);
  });

  it("leads to Asset 360 rather than to a second detail screen", async () => {
    const h = await open();
    await h.type("MC-0024");
    expect(h.layer()).toContain('href="#/media/equipment/EQ-CAM-007"');
    /* Everything the card shows is a summary; nothing here is a history, a
       timeline or an audit trail — those live on the page it links to. */
    for (const dup of [/timeline/i, /audit trail/i, /history/i])
      expect(h.layer(), `the scan card grew a second Asset 360: ${dup}`).not.toMatch(dup);
  });

  it("hands checkout and check-in to the flows that already own them", async () => {
    const h = await open();
    await h.type("MC-0024");
    /* The buttons call the existing dialogs. If they ever posted directly,
       this would be a second custody path with its own idea of validation. */
    const src = readFileSync("public/media-ops/index.html", "utf8");
    const scan = src.slice(src.indexOf("eqScan:()=>{"), src.indexOf("newEquipment:()=>{"));
    /* The SERVER dialogs. offlineCheckout is the legacy seed-data path that
       writes to a browser array and never contacts Nerve — wiring the scanner
       to it would have produced a checkout that looked fine and existed
       nowhere. */
    expect(scan).toContain("ACTIONS.checkout({eid:id})");
    expect(scan, "the scanner used the offline seed-data path")
      .not.toContain("ACTIONS.offlineCheckout");
    expect(scan).toContain("ACTIONS.checkin({eid:id})");
    expect(scan, "the scanner posted custody of its own accord")
      .not.toMatch(/MO_API\.post\(['"`]\/equipment\/[^'"`]*\/(checkout|checkin)/);
    expect(scan, "a QR-specific endpoint was invented").not.toMatch(/\/qr\/(checkout|return|reserve)/);
  });

  it("turns the camera off when the dialog closes", async () => {
    /* A modal that closes with the stream live leaves the recording light on. */
    const src = readFileSync("public/media-ops/index.html", "utf8");
    const scan = src.slice(src.indexOf("eqScan:()=>{"), src.indexOf("newEquipment:()=>{"));
    expect(scan).toMatch(/getTracks\(\)\.forEach\(t=>t\.stop\(\)\)/);
    expect(scan).toMatch(/cancelAnimationFrame/);
    expect(scan, "close did not stop the stream").toMatch(/const close=\(\)=>\{ stop\(\);/);
  });
});
