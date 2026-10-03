/* Generate the Media Ops app icons.
 *
 *   node scripts/generate-media-ops-icons.mjs
 *
 * Writes public/media-ops/{icon.svg,icon-192.png,icon-512.png,
 * icon-maskable-512.png,apple-touch-icon.png}. Re-run it after changing the
 * brand colours or the mark, then bump CACHE in sw.js.
 *
 * WHY A SCRIPT AND NOT FIVE HAND-DRAWN FILES: every variant is the same mark at
 * a different size, bleed and safe area. Drawn by hand they drift — which is
 * how the shipped icon ended up green while the app's brand was blue. Here the
 * gradient and the glyph are written once and every file is derived.
 *
 * No image library is available (no sharp, resvg or ImageMagick), so the PNGs
 * are screenshots of the SVG taken with the Chromium that Playwright already
 * installs for the e2e suite.
 */
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "media-ops");

/* The brand, from --brand-400 and --brand-700, and .brand-mark's 145deg. */
const FROM = "#60A5FA", TO = "#1D4ED8";
/* A 145deg CSS gradient line, expressed as objectBoundingBox coordinates:
   direction (sin145, -cos145), through the centre, half-length (|sin|+|cos|)/2. */
const G1 = { x: 0.1005, y: -0.0705 }, G2 = { x: 0.8995, y: 1.0705 };

/* The Nerve mark: the same stroked path the topbar draws (ICONS.nerve), in a
   24 viewBox. Stroked, so its INKED box is the path box grown by half the
   stroke on each side — that, not the path box, is what has to fit a safe area. */
const PATH = "M5 20V5.6L19 20V4", SW = 2.6;
const INK = { x: 5 - SW / 2, y: 4 - SW / 2, w: 14 + SW, h: 16 + SW };
const INK_MAX = Math.max(INK.w, INK.h);                    // 18.6
const INK_CX = INK.x + INK.w / 2, INK_CY = INK.y + INK.h / 2;

/** One icon as an SVG string.
 *  size   px, square.
 *  glyph  the mark's inked size in px — the number the safe area constrains.
 *  radius corner radius in px (0 = full bleed, for masked and iOS icons).       */
function svg(size, glyph, radius) {
  const k = glyph / INK_MAX;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs><linearGradient id="g" x1="${G1.x}" y1="${G1.y}" x2="${G2.x}" y2="${G2.y}">
    <stop offset="0" stop-color="${FROM}"/><stop offset="1" stop-color="${TO}"/></linearGradient></defs>
  <rect width="${size}" height="${size}"${radius ? ` rx="${radius}"` : ""} fill="url(#g)"/>
  <g transform="translate(${size / 2} ${size / 2}) scale(${k}) translate(${-INK_CX} ${-INK_CY})">
    <path d="${PATH}" fill="none" stroke="#fff" stroke-width="${SW}"
      stroke-linecap="round" stroke-linejoin="round"/></g>
</svg>`;
}

/* A maskable icon is cropped to a CIRCLE of radius 40% by some launchers, so the
   mark must fit the square inscribed in that circle: side = 0.8*size/√2 ≈ 56.5%.
   280 of 512 leaves a little room rather than touching the limit. */
const VARIANTS = [
  { file: "icon-512.png", size: 512, glyph: 300, radius: 112 },
  { file: "icon-192.png", size: 192, glyph: 113, radius: 42 },
  { file: "icon-maskable-512.png", size: 512, glyph: 280, radius: 0 },
  /* iOS masks the corners itself; an icon with its own rx leaves white corners. */
  { file: "apple-touch-icon.png", size: 180, glyph: 106, radius: 0 },
];

const browser = await chromium.launch();
const page = await browser.newPage();
for (const v of VARIANTS) {
  const markup = svg(v.size, v.glyph, v.radius);
  await page.setViewportSize({ width: v.size, height: v.size });
  await page.setContent(
    `<style>html,body{margin:0;padding:0}svg{display:block}</style>${markup}`,
    { waitUntil: "load" });
  await page.screenshot({
    path: join(OUT, v.file), omitBackground: false,
    clip: { x: 0, y: 0, width: v.size, height: v.size },
  });
  console.log(`✓ ${v.file}  ${v.size}×${v.size}  mark ${v.glyph}px${v.radius ? "" : "  full-bleed"}`);
}
await browser.close();

/* The SVG the favicon and the manifest's vector entry both use. */
writeFileSync(join(OUT, "icon.svg"), svg(512, 300, 112) + "\n");
console.log("✓ icon.svg   512×512  mark 300px");
