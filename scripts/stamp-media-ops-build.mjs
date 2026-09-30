/* Stamp the built Media Ops page with a build id.
 *
 *   node scripts/stamp-media-ops-build.mjs [dir]      (default: dist/media-ops)
 *
 * An installed app keeps running the shell its service worker cached, so it
 * cannot tell that a deploy has happened. It compares the `mo-build` meta of
 * the running page with the one the server is serving now — which only works if
 * that value changes when the page does.
 *
 * The id is a hash of the page with the meta itself blanked, so stamping is
 * idempotent: the same content always yields the same id, and re-running this
 * never produces a spurious "new version" notice.
 *
 * It runs on the BUILD OUTPUT, not on public/, so the file in the repo keeps
 * its "dev" placeholder and does not churn on every commit. With "dev" on both
 * sides the check compares equal and never fires locally.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

const dir = process.argv[2] || join("dist", "media-ops");
const file = join(dir, "index.html");

if (!existsSync(file)) {
  /* Not an error: a server-only build, or a client build that did not emit the
     static folder. Saying so beats failing the build. */
  console.log(`· stamp-media-ops-build: ${file} not found, nothing to stamp`);
  process.exit(0);
}

/* [\w.-]* not [^"]*: the page's own JavaScript contains this same pattern (the
   update check parses the tag), and a looser class would match that source
   text instead of the tag in the head. */
const TAG = /(<meta name="mo-build" content=")([\w.-]*)(">)/;
const html = readFileSync(file, "utf8");
if (!TAG.test(html)) {
  console.error(`✗ stamp-media-ops-build: no <meta name="mo-build"> in ${file}`);
  process.exit(1);
}

const id = createHash("sha1").update(html.replace(TAG, "$1$3")).digest("hex").slice(0, 12);
writeFileSync(file, html.replace(TAG, `$1${id}$3`));
console.log(`✓ stamp-media-ops-build: ${file} → ${id}`);
