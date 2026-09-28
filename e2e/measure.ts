/* ═══════════════════════════════════════════════════════════════════════════
   What "broken on a phone" and "changed on desktop" mean, as numbers.

   OVERFLOW. A document-scroll check always passes here: body and #content
   hide horizontal overflow, so the page never scrolls sideways — content is
   silently cut off instead, which is worse. So the check is per element: any
   visible element whose box extends past the viewport, unless it sits inside
   a container that scrolls sideways ON PURPOSE (a table wrapper, a kanban
   board, a tab strip). #content itself does not count as such a container.

   TAP TARGETS. Every visible interactive element smaller than 44×44 CSS px,
   the minimum a thumb hits reliably.

   DESKTOP FINGERPRINT. A hash of the rendered markup of the page and its
   chrome. Pixel baselines catch what users see; this catches what they would
   see below the fold, in text, cheaply enough to commit. Hooks the phone
   layer is allowed to add to shared markup (elements with .m-only, data-m*
   and data-fb* attributes) are removed first, so adding an inert hook does
   not count as a desktop change — anything else does.
   ═══════════════════════════════════════════════════════════════════════════ */
import { createHash } from "node:crypto";
import type { Page } from "@playwright/test";

export interface PhoneScan {
  contentOverflow: number;
  offenders: number;
  worst: Array<{ el: string; past: number }>;
  taps: number;
  smallTaps: number;
}

export async function scanPhone(page: Page): Promise<PhoneScan> {
  return await page.evaluate(() => {
    const W = window.innerWidth;
    const content = document.querySelector("#content") as HTMLElement | null;
    const contentOverflow = content ? Math.max(0, content.scrollWidth - content.clientWidth) : 0;
    const shown = (el: Element) => {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return false;
      const cs = getComputedStyle(el);
      return cs.visibility !== "hidden" && cs.display !== "none" && cs.opacity !== "0";
    };
    const inScroller = (el: Element) => {
      for (let a = el.parentElement; a && a !== content && a !== document.body; a = a.parentElement) {
        const ox = getComputedStyle(a).overflowX;
        if (ox === "auto" || ox === "scroll") return true;
      }
      return false;
    };
    const roots = ["#page", "#topbar", "#mobilebar"].map((s) => document.querySelector(s)).filter(Boolean) as Element[];
    const hits: Element[] = [];
    for (const root of roots) for (const el of root.querySelectorAll("*")) {
      if (!shown(el)) continue;
      const r = el.getBoundingClientRect();
      if ((r.right > W + 1 || r.left < -1) && !inScroller(el)) hits.push(el);
    }
    const outer = hits.filter((e) => !hits.some((o) => o !== e && o.contains(e)));
    const name = (el: Element) => el.tagName.toLowerCase() + (el.id ? "#" + el.id : "")
      + (el.classList.length ? "." + [...el.classList].slice(0, 2).join(".") : "");
    const taps = [...document.querySelectorAll(
      "button, a[href], input:not([type=hidden]), select, textarea, [role=button], [data-act], [data-go], [data-drawer], label.chk",
    )].filter((el) => shown(el) && roots.some((r) => r.contains(el)));
    const small = taps.filter((el) => { const r = el.getBoundingClientRect(); return r.width < 44 || r.height < 44; });
    return {
      contentOverflow, offenders: outer.length,
      worst: outer.slice(0, 3).map((e) => ({ el: name(e), past: Math.round(e.getBoundingClientRect().right - W) })),
      taps: taps.length, smallTaps: small.length,
    };
  });
}

/** Normalised markup of the page and its chrome, hashed. */
export async function desktopFingerprint(page: Page): Promise<string> {
  const html = await page.evaluate(() => {
    const parts = ["#topbar", "#sidebar", "#mobilebar", "#page"].map((sel) => {
      const node = document.querySelector(sel);
      if (!node) return `${sel}:absent`;
      const c = node.cloneNode(true) as Element;
      c.querySelectorAll(".m-only").forEach((n) => n.remove());
      for (const el of [c, ...c.querySelectorAll("*")])
        for (const a of [...el.attributes])
          if (/^data-(m|fb)(-|$)|^data-filterbar$/.test(a.name)) el.removeAttribute(a.name);
      return `${sel}:${c.innerHTML}`;
    });
    return parts.join("\n");
  });
  return createHash("sha1").update(html).digest("hex");
}
