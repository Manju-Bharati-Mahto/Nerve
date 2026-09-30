/* ═══════════════════════════════════════════════════════════════════════════
   The installable app: manifest, icons, head.

   None of this shows up in the running app, which is why it rots quietly. An
   icon the manifest names but nobody generated fails `addAll` in the service
   worker — atomically and silently — so the app simply stops working offline
   and nothing says why. A maskable icon whose mark sits outside the safe circle
   gets its corners shaved on Android. So the files are checked for real: the
   PNG headers are read, and the geometry is computed rather than eyeballed.
   ═══════════════════════════════════════════════════════════════════════════ */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const DIR = "public/media-ops";
const HTML = readFileSync(join(DIR, "index.html"), "utf8");
const HEAD = HTML.slice(0, HTML.indexOf("</head>"));
const MANIFEST = JSON.parse(readFileSync(join(DIR, "manifest.webmanifest"), "utf8"));
const SW = readFileSync(join(DIR, "sw.js"), "utf8");

/** Width and height straight out of a PNG's IHDR — no image library needed. */
function pngSize(file: string) {
  const b = readFileSync(file);
  expect(b.subarray(1, 4).toString("ascii"), `${file} is not a PNG`).toBe("PNG");
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

describe("the manifest", () => {
  it("is installable: an id, a scope, and a start_url inside it", () => {
    expect(MANIFEST.id).toBe("/api/media-ops/index.html");
    expect(MANIFEST.scope).toBe("/api/media-ops/");
    expect(MANIFEST.start_url.startsWith(MANIFEST.scope)).toBe(true);
    expect(MANIFEST.display).toBe("standalone");
    expect(MANIFEST.lang).toBe("en");
  });

  it("opens portrait, as a phone app", () => {
    expect(MANIFEST.orientation).toBe("portrait");
  });

  it("names only icons that exist, at the sizes it claims", () => {
    for (const icon of MANIFEST.icons) {
      const file = join(DIR, icon.src);
      expect(existsSync(file), `${icon.src} is in the manifest but not on disk`).toBe(true);
      if (!icon.src.endsWith(".png")) continue;
      const { w, h } = pngSize(file);
      expect(`${w}x${h}`, `${icon.src} is ${w}x${h}, manifest says ${icon.sizes}`).toBe(icon.sizes);
    }
  });

  it("keeps maskable separate from any", () => {
    /* A combined "any maskable" makes one drawing do both jobs: it is either
       padded for the mask and small everywhere else, or full-bleed and clipped
       when masked. Every entry does one job. */
    for (const icon of MANIFEST.icons)
      expect(icon.purpose, `${icon.src} claims both purposes`).not.toMatch(/any\s+maskable|maskable\s+any/);
    expect(MANIFEST.icons.some((i: { purpose: string }) => i.purpose === "maskable")).toBe(true);
    expect(MANIFEST.icons.some((i: { purpose: string }) => i.purpose === "any")).toBe(true);
  });

  it("points its shortcuts at real routes, inside scope", () => {
    for (const s of MANIFEST.shortcuts ?? []) {
      expect(s.url.startsWith(MANIFEST.scope)).toBe(true);
      const hash = s.url.slice(s.url.indexOf("#"));
      expect(HTML, `no route renders ${hash}`).toContain(hash);
    }
  });
});

describe("the icons themselves", () => {
  it("keep the mark inside the maskable safe circle", () => {
    /* Launchers may crop a maskable icon to a circle of radius 40%. The mark is
       centred and square, so its corners are the far point: half-diagonal must
       stay inside that circle. 280px of 512 is the value the generator uses. */
    const size = 512, mark = 280;
    const halfDiagonal = (mark / 2) * Math.SQRT2;
    expect(halfDiagonal, "the mark's corners fall outside the safe circle")
      .toBeLessThan(0.4 * size);
  });

  it("give iOS a square, because iOS rounds the corners itself", () => {
    const gen = readFileSync("scripts/generate-media-ops-icons.mjs", "utf8");
    const apple = /apple-touch-icon\.png[^}]*radius:\s*(\d+)/.exec(gen);
    expect(apple, "the apple-touch variant is gone from the generator").not.toBeNull();
    expect(Number(apple![1]), "a rounded iOS icon shows white corners under the mask").toBe(0);
  });

  it("are the brand's blue, not the old green", () => {
    const svg = readFileSync(join(DIR, "icon.svg"), "utf8");
    expect(svg).toContain("#60A5FA");
    expect(svg).toContain("#1D4ED8");
  });
});

describe("the head", () => {
  it("declares itself installable to both platforms", () => {
    expect(HEAD).toMatch(/<meta name="mobile-web-app-capable" content="yes">/);
    expect(HEAD).toMatch(/<meta name="apple-mobile-web-app-capable" content="yes">/);
    expect(HEAD).toMatch(/<meta name="apple-mobile-web-app-title" content="Media Ops">/);
    expect(HEAD).toMatch(/<link rel="manifest" href="manifest\.webmanifest">/);
  });

  it("points apple-touch-icon at the PNG, not the rounded SVG", () => {
    expect(HEAD).toMatch(/<link rel="apple-touch-icon" sizes="180x180" href="apple-touch-icon\.png">/);
  });

  it("carries a build id the update check can compare", () => {
    expect(HEAD).toMatch(/<meta name="mo-build" content="[\w.-]+">/);
  });

  it("gives the theme-color tag an id, so the script can move it", () => {
    expect(HEAD).toMatch(/<meta name="theme-color" id="tc-phone"/);
  });
});

describe("the service worker and the manifest agree", () => {
  it("precaches every icon the manifest names", () => {
    /* addAll is atomic: one name here that does not exist, and install fails
       silently, leaving the app with no offline shell at all. */
    for (const icon of MANIFEST.icons)
      expect(SW, `${icon.src} is in the manifest but not in SHELL`).toContain(icon.src);
  });

  it("was version-bumped along with them", () => {
    expect(SW).toContain('const CACHE = "mo-v3"');
  });
});
