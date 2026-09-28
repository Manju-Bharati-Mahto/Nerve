/* ═══════════════════════════════════════════════════════════════════════════
   The PHONE LAYER cannot reach the desktop.

   Every phone style lives between two markers at the end of the Media Ops
   stylesheet, and every selector there must start with
   html[data-layout="mobile"]. That single rule is what lets the phone
   presentation be built without a desktop regression: a rule that forgets the
   prefix applies to every desktop user the moment it ships, and nothing about
   it looks wrong in review.

   Allowed, and nothing else:
     html[data-layout="mobile"] …           (including html[data-layout="mobile"].kb-open …)
     html:not([data-layout="mobile"]) .m-only    — hides phone-only markup on desktop
     @keyframes m-…                          — phone animations, namespaced
   Forbidden: @media inside the layer (the attribute is the only switch).
   ═══════════════════════════════════════════════════════════════════════════ */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const HTML = readFileSync("public/media-ops/index.html", "utf8");
const START = "/* ==== PHONE LAYER ====";
const END = "/* ==== END PHONE LAYER ==== */";

const SCOPED = /^html\[data-layout="mobile"\](?=[\s.:#[>+~]|$)/;
const DESKTOP_HIDE = 'html:not([data-layout="mobile"]) .m-only';

/** Split on commas that are not inside (), [] or quotes. */
function splitSelectors(list: string): string[] {
  const out: string[] = []; let depth = 0, cur = "", q = "";
  for (const ch of list) {
    if (q) { cur += ch; if (ch === q) q = ""; continue; }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
    if (ch === "(" || ch === "[") depth++;
    if (ch === ")" || ch === "]") depth--;
    if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Every violation in a block of CSS, as human-readable strings. */
export function violations(css: string): string[] {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const bad: string[] = [];
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf("{", i);
    if (open < 0) { if (src.slice(i).trim()) bad.push(`stray text: ${src.slice(i).trim().slice(0, 60)}`); break; }
    const prelude = src.slice(i, open).trim();
    /* Find the matching close brace. */
    let depth = 1, j = open + 1;
    for (; j < src.length && depth; j++) { if (src[j] === "{") depth++; else if (src[j] === "}") depth--; }
    if (prelude.startsWith("@media")) bad.push(`@media inside the phone layer: ${prelude}`);
    else if (prelude.startsWith("@keyframes")) {
      if (!/^@keyframes\s+m-[\w-]+$/.test(prelude)) bad.push(`keyframes must be named m-…: ${prelude}`);
    } else if (prelude.startsWith("@")) bad.push(`at-rule not allowed: ${prelude}`);
    else for (const sel of splitSelectors(prelude))
      if (!SCOPED.test(sel) && sel !== DESKTOP_HIDE) bad.push(`unscoped selector: ${sel}`);
    i = j;
  }
  return bad;
}

describe("the phone layer is scoped to the phone", () => {
  it("exists exactly once, inside the stylesheet", () => {
    expect(HTML.split(START).length - 1).toBe(1);
    expect(HTML.split(END).length - 1).toBe(1);
    const start = HTML.indexOf(START), end = HTML.indexOf(END);
    expect(end).toBeGreaterThan(start);
    /* The main stylesheet ends right after it — it is the last word on specificity. */
    expect(HTML.slice(end + END.length).trimStart().startsWith("</style>")).toBe(true);
  });

  it("contains nothing a desktop browser would apply", () => {
    const body = HTML.slice(HTML.indexOf(START), HTML.indexOf(END));
    const css = body.slice(body.indexOf("*/") + 2);   // drop the opening marker comment
    expect(violations(css)).toEqual([]);
  });
});

/* The checker has to be proven on bad input, or an empty layer proves nothing. */
describe("the scope checker itself", () => {
  it("accepts every allowed form", () => {
    expect(violations(`
      html[data-layout="mobile"] #mobilebar{display:block}
      html[data-layout="mobile"].kb-open #toasts{top:0}
      html[data-layout="mobile"] .a, html[data-layout="mobile"] :is(.b,.c){gap:0}
      html:not([data-layout="mobile"]) .m-only{display:none!important}
      @keyframes m-slide{from{transform:translateY(100%)}to{transform:none}}
    `)).toEqual([]);
  });

  it("rejects an unscoped selector, even one hiding in a list", () => {
    expect(violations(`html[data-layout="mobile"] .a, .b{color:red}`)).toEqual(["unscoped selector: .b"]);
    expect(violations(`#sidebar{display:none}`)).toHaveLength(1);
  });

  it("rejects a prefix that only looks right", () => {
    expect(violations(`html[data-layout="mobile-x"] .a{color:red}`)).toHaveLength(1);
    expect(violations(`html[data-layout="desktop"] .a{color:red}`)).toHaveLength(1);
  });

  it("rejects @media and un-namespaced keyframes", () => {
    expect(violations(`@media (max-width:400px){html[data-layout="mobile"] .a{color:red}}`)).toHaveLength(1);
    expect(violations(`@keyframes slide{to{opacity:1}}`)).toHaveLength(1);
  });
});
