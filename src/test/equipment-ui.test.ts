/* ═══════════════════════════════════════════════════════════════════════════
   UI REGRESSION — the two equipment surfaces that lied to the person using them.

   Both bugs were visual, so a passing endpoint test would not have caught
   either. This file boots the REAL Media Ops page in jsdom and drives its own
   kiosk and label code.

     THE PIN PAD advanced on `S.kiosk.pin.length >= 4`. Any four digits opened
     the cupboard flow, nothing was sent anywhere, and the loan was then written
     against whichever account the tablet happened to be signed into.

     THE QR LABEL drew `(i*7 + e.id*13) % 3` as an 11x11 grid, with a Print
     button under it. It encoded nothing at all.
   ═══════════════════════════════════════════════════════════════════════════ */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const HTML = readFileSync("public/media-ops/index.html", "utf8");

type Ev = <T>(expr: string) => T;
let dom: JSDOM;
let ev: Ev;
/** Every request the page made, so the tests can see what was and was not sent. */
let calls: { url: string; body: unknown }[] = [];
/** Scripted replies, keyed by a substring of the URL. */
let replies: Record<string, { status: number; body: unknown }> = {};

beforeAll(async () => {
  dom = new JSDOM(HTML, {
    url: "http://localhost/api/media-ops/#/media/equipment",
    runScripts: "dangerously", pretendToBeVisual: true,
  });
  const w = dom.window as unknown as { fetch: unknown; eval: (s: string) => unknown };
  w.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const key = Object.keys(replies).find((k) => url.includes(k));
    if (!key && url.includes("/creator/state")) {
      /* A REJECTION, not a 404 — the difference decides whether this page has a
         shell to render into. An unscripted 404 carries a status, which the app
         reads as "the server answered, and the answer was no", and it replaces
         #app with the creator dead-end screen: #page stops existing, and the
         next asynchronous re-render writes innerHTML on null. A transport
         failure is the documented standalone-run path, so the seed fallback
         boots the ordinary Media Ops shell — which is the page a kiosk test is
         supposed to be driving. The kiosk overlay sits outside #app, so these
         tests passed either way; they were just passing against a shell that
         was no longer there. */
      throw new Error("offline");
    }
    const r = key ? replies[key] : { status: 404, body: { message: "not scripted" } };
    return { ok: r.status < 400, status: r.status, json: async () => r.body } as Response;
  };
  // Boot on the seed department, then mark the session live so the code paths
  // that talk to a server are the ones under test.
  await new Promise((r) => setTimeout(r, 90));
  ev = (expr) => w.eval(expr) as never;
  ev("window.__MO_LIVE__ = true;");
}, 30_000);

/* hydrateFromServer() flips __MO_LIVE__ off when a scripted /state reply is
   not a real payload, and these tests share one booted page — so each one
   re-declares the mode it is testing rather than inheriting the last one's.
   Toasts stack up in the same container, so they are cleared too: otherwise a
   test reads the previous test's message and passes for the wrong reason. */
beforeEach(() => {
  ev("window.__MO_LIVE__ = true;");
  const t = dom.window.document.getElementById("toasts");
  if (t) t.innerHTML = "";
});
const toastText = () => dom.window.document.getElementById("toasts")?.textContent ?? "";

const K = () => ev<Record<string, unknown>>("S.kiosk");
const press = (key: string) => {
  const btn = [...dom.window.document.querySelectorAll("#kiosk [data-k]")]
    .find((b) => (b as HTMLElement).dataset.k === key) as HTMLElement | undefined;
  if (!btn) throw new Error(`no kiosk key ${key}`);
  btn.click();
};
/** Open the kiosk and get as far as the PIN pad, with a person chosen. */
const atPinPad = () => {
  ev("openKiosk()");
  (dom.window.document.querySelector("#kiosk [data-kwho]") as HTMLElement).click();
};
const typePin = async (pin: string) => {
  for (const d of pin) press(d);
  await new Promise((r) => setTimeout(r, 300));
};

describe("the page these tests drive", () => {
  /* The kiosk overlay is a sibling of #app, not a child, so every test below
     would still pass if the boot had thrown the shell away. This asserts the
     shell is there, so a boot that quietly fails cannot go on looking green. */
  it("boots the ordinary Media Ops shell, with a page to render into", () => {
    expect(dom.window.document.getElementById("app")).not.toBeNull();
    expect(dom.window.document.getElementById("page")).not.toBeNull();
  });
});

describe("the kiosk asks who, then proves it with the server", () => {
  it("opens on the identity step, not on a PIN pad", () => {
    calls = [];
    ev("openKiosk()");
    expect(K().step).toBe(0.5);
    expect(dom.window.document.querySelectorAll("#kiosk [data-kwho]").length).toBeGreaterThan(0);
    expect(dom.window.document.querySelectorAll("#kiosk [data-k]").length).toBe(0);
  });

  it("moves to the PIN pad once a person is chosen", () => {
    const who = dom.window.document.querySelector("#kiosk [data-kwho]") as HTMLElement;
    who.click();
    expect(K().step).toBe(1);
    expect(K().who).toBeTruthy();
    expect(dom.window.document.querySelectorAll("#kiosk [data-k]").length).toBe(12);
  });

  /* THE REGRESSION. Four digits used to BE the authentication. */
  it("does not advance on four digits — it asks the server, and a refusal stays put", async () => {
    atPinPad();
    replies = { "/equipment/kiosk/session": { status: 401, body: { message: "That PIN was not recognised." } } };
    calls = [];
    await typePin("1234");

    expect(calls.some((c) => c.url.includes("/equipment/kiosk/session"))).toBe(true);
    expect(K().step).toBe(1);                      // still on the pad
    expect(K().token).toBeFalsy();                 // no session was established
    expect(String(K().err)).toMatch(/not recognised/i);
    expect(K().pin).toBe("");                      // and the pad was cleared
  });

  it("advances only when the server issues a session, and remembers whose it is", async () => {
    atPinPad();
    replies = {
      "/equipment/kiosk/session": {
        status: 201,
        body: { kiosk_token: "tok-abc", expires_at: "2099-01-01T00:00:00Z",
                holder: { id: "mo-u8", full_name: "Verified Person" } },
      },
    };
    calls = [];
    await typePin("8317");

    expect(K().step).toBe(2);
    expect(K().token).toBe("tok-abc");
    expect(K().holder).toBe("mo-u8");
    // The PIN went to the server and was not kept on the device.
    const sent = calls.find((c) => c.url.includes("/equipment/kiosk/session"))!;
    expect((sent.body as { pin: string }).pin).toBe("8317");
    expect(K().pin).toBe("");
  });

  it("sends the session token with a kiosk checkout, so the holder is not the tablet", async () => {
    /* The scan step is what puts an asset in the cache; this test jumps
       straight to the confirm step, so it stands in for that. Committing
       against an asset the session never confirmed is refused — covered
       separately below. */
    ev(`assetPut({id:1, asset_tag:'EQ-CAM-001', make:'Sony', model:'A7', condition:'good', status:'available', category_id:1});
        S.kiosk = {...S.kiosk, step:4, mode:'check_out', items:[1], ret:'2026-12-31', token:'tok-abc', holder:'mo-u8'};`);
    replies = {
      "/equipment/1/checkout": { status: 201, body: { transaction: { id: 1 } } },
      "/api/v1/media/state": { status: 200, body: {} },
      "/equipment/kiosk/session/end": { status: 200, body: { ok: true } },
    };
    calls = [];
    ev("commitKiosk()");
    await new Promise((r) => setTimeout(r, 150));

    const co = calls.find((c) => c.url.includes("/equipment/1/checkout"));
    expect(co).toBeTruthy();
    expect((co!.body as { kiosk_token: string }).kiosk_token).toBe("tok-abc");
    expect((co!.body as { recorded_via: string }).recorded_via).toBe("kiosk");
    /* Deliberately absent: the browser does not get to name the holder. */
    expect((co!.body as Record<string, unknown>).holder_id).toBeUndefined();
  });

  it("writes nothing at all when there is no verified session", async () => {
    ev("window.__MO_LIVE__ = true; openKiosk(); S.kiosk.mode='check_out'; S.kiosk.items=[1]; S.kiosk.token=null;");
    calls = [];
    ev("commitKiosk()");
    await new Promise((r) => setTimeout(r, 80));
    expect(calls.filter((c) => c.url.includes("/checkout"))).toHaveLength(0);
    expect(K().step).toBe(0.5);        // sent back to identify themselves
  });
});

describe("the QR label is a real code from the server", () => {
  it("asks the server for it and renders what comes back", async () => {
    replies = {
      "/equipment/1/qr": {
        status: 200,
        body: { asset_tag: "EQ-CAM-001", token: "AT-DEADBEEF",
                svg: '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1v1h-1z"/></svg>' },
      },
    };
    calls = [];
    ev("ACTIONS.showQR({eid:'1'})");
    await new Promise((r) => setTimeout(r, 120));

    expect(calls.some((c) => c.url.includes("/equipment/1/qr"))).toBe(true);
    const html = dom.window.document.getElementById("modal-layer")?.innerHTML ?? "";
    expect(html).toContain("<svg");
    expect(html).toContain("AT-DEADBEEF");
  });

  /* The checkerboard was drawn from the row id with an arithmetic expression;
     nothing in the page should be generating a label locally any more. */
  it("no longer contains the arithmetic that drew the fake code", () => {
    expect(HTML).not.toContain("(i*7+e.id*13)%3");
    expect(HTML).not.toContain("i*7+e.id*13");
  });

  it("offers no Print button when the label could not be fetched", async () => {
    replies = { "/equipment/2/qr": { status: 500, body: { message: "boom" } } };
    ev("ACTIONS.showQR({eid:'2'})");
    await new Promise((r) => setTimeout(r, 120));
    const html = dom.window.document.getElementById("modal-layer")?.innerHTML ?? "";
    expect(html).toContain("Label unavailable");
    expect(html).not.toContain("Print label");
  });
});

describe("checkout and check-in defer to the server", () => {
  it("sends a checkout and does not decide BR-7 for itself", async () => {
    /* The asset is in the cache because a registry or detail page put it
       there, which is how these actions are reached in the app. */
    ev("assetPut({id:1, asset_tag:'EQ-CAM-001', make:'Sony', model:'A7', condition:'good', status:'available', category_id:1});");
    replies = {
      "/checkout": { status: 409, body: { message: "BR-7: blocked — you hold an item 9 days overdue." } },
    };
    calls = [];
    /* PHASE 17F — checkout is a confirmed act now, not a click. The modal has
       to be opened and agreed to; the property under test is unchanged, which
       is that the BROWSER does not decide BR-7 for itself. */
    ev("ACTIONS.checkout({eid:'1'})");
    await new Promise((r) => setTimeout(r, 120));
    expect(calls.some((c) => c.url.includes("/checkout")),
      "the browser posted before anybody confirmed").toBe(false);
    ev("document.querySelector('#co-go').click()");
    await new Promise((r) => setTimeout(r, 160));
    expect(calls.some((c) => c.url.includes("/checkout"))).toBe(true);
    // The refusal came from the server; the browser did not pre-empt it.
    expect(dom.window.document.getElementById("modal-layer")?.innerHTML ?? "").toContain("BR-7");
  });

  it("will not send a checkout without an expected return date", async () => {
    /* The field is required by the server, and the form must not post an empty
       one just to find that out. */
    ev("assetPut({id:1, asset_tag:'EQ-CAM-001', make:'Sony', model:'A7', condition:'good', status:'available', category_id:1});");
    calls = [];
    ev("ACTIONS.checkout({eid:'1'})");
    await new Promise((r) => setTimeout(r, 120));
    ev("document.querySelector('#co-due').value=''");
    ev("document.querySelector('#co-go').click()");
    await new Promise((r) => setTimeout(r, 160));
    expect(calls.some((c) => c.url.includes("/checkout"))).toBe(false);
  });

  it("shows the loan before it is agreed to", async () => {
    ev("assetPut({id:1, asset_tag:'EQ-CAM-001', make:'Sony', model:'A7', condition:'good', status:'available', category_id:1, internal_code:'MC-0024', inventory_name:'Media Crew'});");
    ev("ACTIONS.checkout({eid:'1'})");
    await new Promise((r) => setTimeout(r, 120));
    const m = dom.window.document.getElementById("modal-layer")?.innerHTML ?? "";
    expect(m).toContain("EQ-CAM-001");
    expect(m).toContain("MC-0024");
    expect(m).toContain("Media Crew");
    expect(m).toMatch(/Expected return date/i);
  });

  it("reports BR-8 from the server's answer rather than recomputing it", async () => {
    /* The asset is in the cache because a registry or detail page put it
       there, which is how these actions are reached in the app. */
    ev("assetPut({id:1, asset_tag:'EQ-CAM-001', make:'Sony', model:'A7', condition:'good', status:'available', category_id:1});");

    replies = {
      "/checkin": { status: 201, body: { transaction: { id: 9 }, damaged: true } },
      "/api/v1/media/state": { status: 200, body: { users: [], equipment_items: [], me: { id: 1 } } },
    };
    // Open the real check-in dialog so the condition control under test is the
    // page's own, then pick a condition the way a person would.
    ev("ACTIONS.checkin({eid:'1'})");
    const good = dom.window.document.querySelector('#ci-cond [data-c="good"]') as HTMLElement | null;
    good?.click();
    calls = [];
    ev("ACTIONS.confirmCheckin({eid:'1'})");
    await new Promise((r) => setTimeout(r, 140));
    const sent = calls.find((c) => c.url.includes("/checkin"))!;
    expect((sent.body as { condition_noted: string }).condition_noted).toBe("good");
    /* The message reports the SERVER's verdict — the browser no longer works
       out for itself whether the condition dropped. */
    expect(toastText()).toContain("BR-8");
  });
});


/* ══════════════════════════════════════════════════════════════════════════
   PHASE 8 — the kiosk will not commit against an asset it could not confirm.
   ══════════════════════════════════════════════════════════════════════════ */
describe("the kiosk refuses an unconfirmed asset", () => {
  it("writes nothing when a scanned item is not in the cache", () => {
    ev("assetClear();");
    ev("S.kiosk = {...S.kiosk, step:4, mode:'check_out', items:[9999], ret:'2026-12-31', token:'tok-abc', holder:'mo-u8'};");
    calls = [];
    ev("commitKiosk()");
    expect(calls.filter((c) => c.url.includes("/checkout")),
      "a checkout was sent for an asset the server never confirmed").toEqual([]);
    expect(toastText()).toContain("Could not confirm");
  });

  it("commits once the asset is confirmed", () => {
    ev(`assetPut({id:4242, asset_tag:'EQ-CAM-042', make:'Sony', model:'A7', condition:'good'});
        S.kiosk = {...S.kiosk, step:4, mode:'check_out', items:[4242], ret:'2026-12-31', token:'tok-abc', holder:'mo-u8'};`);
    replies = { "/equipment/4242/checkout": { status: 201, body: { transaction: { id: 9 } } },
                "/api/v1/media/state": { status: 200, body: {} },
                "/equipment/kiosk/session/end": { status: 200, body: { ok: true } } };
    calls = [];
    ev("commitKiosk()");
    expect(calls.some((c) => c.url.includes("/equipment/4242/checkout"))).toBe(true);
  });
});

describe("an action will not run against an asset the server cannot confirm", () => {
  it("sends no checkout, and says so, when the asset cannot be fetched", async () => {
    ev("assetClear();");
    replies = { "/equipment/7777": { status: 404, body: { message: "Asset not found." } } };
    calls = [];
    ev("ACTIONS.checkout({eid:'7777'})");
    await new Promise((r) => setTimeout(r, 150));
    expect(calls.filter((c) => c.url.includes("/checkout")),
      "a checkout was sent for an unconfirmed asset").toEqual([]);
    expect(toastText()).toContain("could not be confirmed");
  });

  it("fetches the asset once, then runs the action", async () => {
    ev("assetClear();");
    replies = {
      "/equipment/8888": { status: 200, body: { item: { id: 8888, asset_tag: "EQ-CAM-888",
        make: "Sony", model: "A7", condition: "good", status: "available", category_id: 1 } } },
      "/equipment/8888/checkout": { status: 201, body: { transaction: { id: 3 } } },
    };
    calls = [];
    ev("ACTIONS.checkout({eid:'8888'})");
    await new Promise((r) => setTimeout(r, 180));
    expect(calls.filter((c) => /\/equipment\/8888$/.test(c.url.split("?")[0])).length,
      "the asset was fetched more than once").toBe(1);
    /* The action still runs — it just asks first now (Phase 17F). */
    ev("document.querySelector('#co-go').click()");
    await new Promise((r) => setTimeout(r, 160));
    expect(calls.some((c) => c.url.includes("/equipment/8888/checkout"))).toBe(true);
  });
});
