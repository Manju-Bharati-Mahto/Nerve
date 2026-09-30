/* Turn Lucide icon modules into the element markup ICONS holds.
 *
 *   node scripts/extract-lucide-icons.mjs eye=eye archive=archive undo=undo-2
 *
 * Each argument is `key=lucide-source`. It prints the ICONS lines to paste.
 *
 * Why a parser and not a regex: the P3 extraction used one, and it matched
 * `["` only — so an icon whose element spans several lines (Lucide wraps long
 * paths) had those elements silently dropped. inbox, send and wallet shipped as
 * a single stroke each, and nothing failed; it was caught by looking at a
 * screenshot. This walks the array instead, and asserts it found every element.
 *
 * Portions © Lucide Contributors (ISC); see node_modules/lucide-react/LICENSE.
 */
import { readFileSync, existsSync } from "node:fs";

const SRC = "node_modules/lucide-react/dist/esm/icons";

/** Every ["tag", {attrs}] pair in the createLucideIcon array, newlines and all. */
function parse(js) {
  const start = js.indexOf("createLucideIcon(");
  const open = js.indexOf("[", js.indexOf(",", start));
  if (open < 0) throw new Error("no icon array");
  /* Walk to the matching bracket so nested arrays cannot end it early. */
  let depth = 0, end = -1;
  for (let i = open; i < js.length; i++) {
    if (js[i] === "[") depth++;
    else if (js[i] === "]" && --depth === 0) { end = i; break; }
  }
  if (end < 0) throw new Error("unterminated icon array");
  const body = js.slice(open, end + 1);

  const els = [];
  /* Each element starts with a quoted tag name; take everything to its own
     closing brace. Whitespace and line breaks between tokens are irrelevant. */
  const re = /\[\s*"([a-zA-Z]+)"\s*,\s*\{([\s\S]*?)\}\s*\]/g;
  let m;
  while ((m = re.exec(body))) {
    const [, tag, attrsRaw] = m;
    const attrs = {};
    /* key: "value" pairs, values never contain an unescaped quote in Lucide. */
    const ar = /([a-zA-Z0-9-]+)\s*:\s*"([^"]*)"/g;
    let a;
    while ((a = ar.exec(attrsRaw))) if (a[1] !== "key") attrs[a[1]] = a[2];
    els.push({ tag, attrs });
  }
  /* Every top-level element in the array must have been captured. */
  const expected = (body.match(/\[\s*"[a-zA-Z]+"\s*,/g) || []).length;
  if (els.length !== expected)
    throw new Error(`parsed ${els.length} of ${expected} elements — the parser dropped some`);
  return els;
}

const out = [];
for (const arg of process.argv.slice(2)) {
  const [key, source] = arg.split("=");
  const file = `${SRC}/${source}.js`;
  if (!existsSync(file)) { console.error(`✗ ${key}: ${file} not found`); process.exitCode = 1; continue; }
  const els = parse(readFileSync(file, "utf8"));
  const markup = els.map(({ tag, attrs }) =>
    `<${tag} ${Object.entries(attrs).map(([k, v]) => `${k}="${v}"`).join(" ")}/>`).join("");
  out.push(` ${key}:'${markup}',`);
  console.error(`✓ ${key} ← ${source}  (${els.length} element${els.length === 1 ? "" : "s"})`);
}
console.log(out.join("\n"));
