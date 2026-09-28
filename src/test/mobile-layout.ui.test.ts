/* ═══════════════════════════════════════════════════════════════════════════
   UI — the layout switch: which presentation a device gets, and when it may
   change.

   The switch is a small script in <head> that sets <html data-layout> before
   first paint. These tests boot the real public/media-ops/index.html in jsdom
   with a scripted matchMedia, so each device class can be stated exactly:
   a phone, a mouse-driven desktop squeezed narrow, an iPad rotating. The real
   browser half — that Chromium's touch emulation matches the query at all, and
   that there is no flash — lives in e2e/layout-switch.pw.ts.
   ═══════════════════════════════════════════════════════════════════════════ */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const HTML = readFileSync("public/media-ops/index.html", "utf8");
const LAYOUT_Q = "(max-width: 820px) and (hover: none) and (pointer: coarse), (hover: none) and (pointer: coarse) and (max-height: 500px)";

interface Device { touch: boolean; phone: boolean; width?: number }
interface Boot {
  dom: JSDOM;
  ev: <T = unknown>(s: string) => T;
  layout: () => string | null;
  /** Every value written to data-layout, in order — a flash would show as two. */
  writes: string[];
  events: string[];
  /** Change the device and fire the media-query listeners, as a rotation would. */
  become: (d: Partial<Device>) => void;
}

async function boot(opts: { device?: Device; pref?: string; query?: string } = {}): Promise<Boot> {
  const writes: string[] = [], events: string[] = [];
  const state: Device = { touch: false, phone: false, ...(opts.device ?? {}) };
  const listeners: Array<() => void> = [];
  const dom = new JSDOM(HTML, {
    url: `http://localhost/api/media-ops/${opts.query ?? ""}#/media/home`,
    runScripts: "dangerously", pretendToBeVisual: true,
    beforeParse(w) {
      if (opts.pref) w.localStorage.setItem("mo_layout", opts.pref);
      if (opts.device?.width) Object.defineProperty(w, "innerWidth", { value: opts.device.width, configurable: true });
      if (opts.device) {
        (w as unknown as { matchMedia: unknown }).matchMedia = (q: string) => ({
          media: q,
          get matches() {
            if (q === LAYOUT_Q) return state.touch && state.phone;
            if (q === "(hover: none) and (pointer: coarse)") return state.touch;
            return false;
          },
          addEventListener: (_: string, fn: () => void) => listeners.push(fn),
          removeEventListener() {}, addListener: (fn: () => void) => listeners.push(fn), removeListener() {},
        });
      }
      const set = w.Element.prototype.setAttribute;
      w.Element.prototype.setAttribute = function (this: Element, n: string, v: string) {
        if (this === w.document.documentElement && n === "data-layout") writes.push(v);
        return set.call(this, n, v);
      };
      w.addEventListener("mo:layout-before", () => events.push("before"));
      w.addEventListener("mo:layout", () => events.push("after"));
    },
  });
  const w = dom.window as unknown as { fetch: unknown; eval: (s: string) => unknown };
  w.fetch = async () => { throw new Error("offline"); };
  await new Promise((r) => setTimeout(r, 90));
  return {
    dom, writes, events,
    ev: (s) => w.eval(s) as never,
    layout: () => dom.window.document.documentElement.getAttribute("data-layout"),
    become: (d) => { Object.assign(state, d); listeners.forEach((fn) => fn()); },
  };
}

const PHONE: Device = { touch: true, phone: true, width: 390 };
const MOUSE_NARROW: Device = { touch: false, phone: false, width: 700 };
const IPAD_LANDSCAPE: Device = { touch: true, phone: false, width: 1180 };

describe("which presentation a device gets", () => {
  it("is desktop where matchMedia does not exist — every older jsdom suite", async () => {
    const b = await boot();
    expect(b.layout()).toBe("desktop");
    expect(b.dom.window.document.documentElement.getAttribute("data-layout-pref")).toBe("auto");
  });

  it("is mobile on a touch phone", async () => {
    expect((await boot({ device: PHONE })).layout()).toBe("mobile");
  });

  it("stays desktop in a narrow MOUSE window — width alone never decides", async () => {
    expect((await boot({ device: MOUSE_NARROW })).layout()).toBe("desktop");
  });

  it("is desktop on a touch device wider than a phone", async () => {
    expect((await boot({ device: IPAD_LANDSCAPE })).layout()).toBe("desktop");
  });

  it("is set once, before the app runs — no desktop frame first", async () => {
    const b = await boot({ device: PHONE });
    expect(b.writes, "data-layout was written more than once during boot").toEqual(["mobile"]);
    expect(b.events, "a boot is not a flip").toEqual([]);
    /* The app's own script saw the final value from its first line. */
    expect(b.ev("isMobileLayout()")).toBe(true);
  });
});

describe("a saved preference beats Auto", () => {
  it("forces mobile on a desktop", async () => {
    expect((await boot({ device: MOUSE_NARROW, pref: "mobile" })).layout()).toBe("mobile");
    expect((await boot({ pref: "mobile" })).layout()).toBe("mobile");
  });

  it("forces the real desktop on a phone, by widening the viewport", async () => {
    const b = await boot({ device: PHONE, pref: "desktop" });
    expect(b.layout()).toBe("desktop");
    expect(b.dom.window.document.querySelector("meta[name=viewport]")!.getAttribute("content"))
      .toBe("width=1280, viewport-fit=cover");
  });

  it("never rewrites the viewport on a desktop, so choosing Desktop never reloads one", async () => {
    const b = await boot({ device: MOUSE_NARROW, pref: "desktop" });
    expect(b.dom.window.document.querySelector("meta[name=viewport]")!.getAttribute("content"))
      .toBe("width=device-width, initial-scale=1, viewport-fit=cover");
  });

  it("ignores anything in storage that is not a known value", async () => {
    expect((await boot({ device: PHONE, pref: "tablet" })).layout()).toBe("mobile");
  });

  it("takes ?layout= for one load and saves nothing", async () => {
    const b = await boot({ query: "?layout=mobile" });
    expect(b.layout()).toBe("mobile");
    expect(b.dom.window.localStorage.getItem("mo_layout")).toBeNull();
  });

  it("saves through moLayout.set, and Auto removes the key rather than storing 'auto'", async () => {
    const b = await boot();
    b.ev("moLayout.set('mobile')");
    expect(b.dom.window.localStorage.getItem("mo_layout")).toBe("mobile");
    expect(b.layout()).toBe("mobile");
    b.ev("moLayout.set('auto')");
    expect(b.dom.window.localStorage.getItem("mo_layout")).toBeNull();
    expect(b.layout()).toBe("desktop");
  });
});

describe("a live change never tears anything down", () => {
  it("does not flip a mouse window however it is resized", async () => {
    const b = await boot({ device: { touch: false, phone: false, width: 1440 } });
    b.become({ width: 600 });      // the query still says no: no touch
    expect(b.layout()).toBe("desktop");
    expect(b.events).toEqual([]);
  });

  it("flips a touch device at once when nothing is open", async () => {
    const b = await boot({ device: IPAD_LANDSCAPE });
    b.become({ phone: true });     // rotated to portrait
    expect(b.layout()).toBe("mobile");
    expect(b.events).toEqual(["before", "after"]);
  });

  it("waits for an open modal to close, and keeps what was typed until then", async () => {
    const b = await boot({ device: IPAD_LANDSCAPE });
    b.ev(`modal('<div class="mo-body"><input id="typed" value="half a task"></div>')`);
    b.become({ phone: true });
    expect(b.layout(), "flipped under an open modal").toBe("desktop");
    expect(b.events).toEqual([]);
    expect((b.dom.window.document.getElementById("typed") as HTMLInputElement).value).toBe("half a task");

    b.ev("closeModal()");
    expect(b.layout()).toBe("mobile");
    expect(b.events).toEqual(["before", "after"]);
  });

  it("applies a postponed flip on the next route change too", async () => {
    const b = await boot({ device: IPAD_LANDSCAPE });
    b.ev(`openDrawer('<div class="dr-head"><h2>x</h2></div>')`);
    b.become({ phone: true });
    expect(b.layout()).toBe("desktop");
    /* The drawer is closed by the route change's own teardown in later phases;
       here, what matters is that the flip waits for it. */
    b.ev("closeDrawer()");
    expect(b.layout()).toBe("mobile");
  });

  it("puts the off-canvas nav away before switching", async () => {
    const b = await boot({ device: IPAD_LANDSCAPE });
    b.dom.window.document.body.classList.add("nav-open");
    b.become({ phone: true });
    expect(b.dom.window.document.body.classList.contains("nav-open")).toBe(false);
  });
});

describe("signing out keeps how this device shows Nerve", () => {
  it("clears everything else and keeps the layout preference", async () => {
    const b = await boot({ pref: "mobile" });
    b.dom.window.localStorage.setItem("mo_crud_filter", "{}");
    await b.ev("clearClientAuth()");
    expect(b.dom.window.localStorage.getItem("mo_layout")).toBe("mobile");
    expect(b.dom.window.localStorage.getItem("mo_crud_filter")).toBeNull();
  });

  it("does not invent a preference that was never chosen", async () => {
    const b = await boot();
    await b.ev("clearClientAuth()");
    expect(b.dom.window.localStorage.length).toBe(0);
  });
});
