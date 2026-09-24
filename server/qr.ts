/* ═══════════════════════════════════════════════════════════════════════════
   QR ENCODER — ISO/IEC 18004, byte mode, error-correction level M.

   WHY THIS EXISTS. The Equipment screen had a "QR label" dialog with a Print
   button that rendered `(i*7 + asset.id*13) % 3` as an 11×11 checkerboard. It
   encoded nothing. Labels printed from it and stuck to a camera are unreadable
   by every scanner that will ever be pointed at them.

   WHY IT IS WRITTEN HERE rather than installed. A label glued to a ₹2,00,000
   lens has to keep resolving for years, so the thing that generates it should
   be readable, pinned and tested in this repository rather than floating on a
   version range. The algorithm is fixed by the standard and does not change.
   It is ~250 lines and every step is covered by qr.test.ts.

   SCOPE. Byte mode, level M (≈15% recovery — the usual choice for printed
   labels), versions 1–10, which carries up to 213 bytes. An asset URL is ~40.
   Anything longer than version 10 throws rather than silently truncating.

   The output is a boolean matrix. Rendering is the caller's problem: the API
   turns it into SVG, and nothing here knows about assets, Nerve or HTTP.
   ═══════════════════════════════════════════════════════════════════════════ */

/** [ecCodewordsPerBlock, blocksInGroup1, dataPerBlock1, blocksInGroup2, dataPerBlock2] */
const EC_M: Record<number, [number, number, number, number, number]> = {
  1: [10, 1, 16, 0, 0],   2: [16, 1, 28, 0, 0],   3: [26, 1, 44, 0, 0],
  4: [18, 2, 32, 0, 0],   5: [24, 2, 43, 0, 0],   6: [16, 4, 27, 0, 0],
  7: [18, 4, 31, 0, 0],   8: [22, 2, 38, 2, 39],  9: [22, 3, 36, 2, 37],
  10: [26, 4, 43, 1, 44],
};

/** Row/column centres of the alignment patterns, by version. */
const ALIGN: Record<number, number[]> = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
  6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
};

const MAX_VERSION = 10;
const dataCapacity = (v: number) => {
  const [, b1, d1, b2, d2] = EC_M[v];
  return b1 * d1 + b2 * d2;
};

/* ── GF(256), primitive polynomial 0x11D ─────────────────────────────────── */
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}
const gfMul = (a: number, b: number) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

/** Generator polynomial of degree `n`, as coefficients high→low. */
function generatorPoly(n: number): number[] {
  let poly = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

/** Reed–Solomon remainder: the `n` error-correction codewords for `data`. */
function ecCodewords(data: number[], n: number): number[] {
  const gen = generatorPoly(n);
  const rem = new Array(n).fill(0);
  for (const byte of data) {
    const factor = byte ^ rem[0];
    rem.shift();
    rem.push(0);
    if (factor !== 0) for (let i = 0; i < n; i++) rem[i] ^= gfMul(gen[i + 1], factor);
  }
  return rem;
}

/* ── Bit buffer ──────────────────────────────────────────────────────────── */
class Bits {
  readonly bits: number[] = [];
  push(value: number, length: number) {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  }
  get length() { return this.bits.length; }
}

/* ── Format information: BCH(15,5), masked with 0x5412 ───────────────────── */
function formatBits(maskId: number): number[] {
  // Level M is 0b00 in the format's EC field.
  let value = (0b00 << 3) | maskId;
  let rem = value;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  value = ((value << 10) | rem) ^ 0x5412;
  const out: number[] = [];
  for (let i = 14; i >= 0; i--) out.push((value >>> i) & 1);
  return out;
}

/** Version information: BCH(18,6), versions 7+ only. */
function versionBits(version: number): number[] {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  const value = (version << 12) | rem;
  const out: number[] = [];
  for (let i = 17; i >= 0; i--) out.push((value >>> i) & 1);
  return out;
}

type Grid = { m: (boolean | null)[][]; reserved: boolean[][]; size: number };

function blankGrid(version: number): Grid {
  const size = version * 4 + 17;
  return {
    size,
    m: Array.from({ length: size }, () => new Array<boolean | null>(size).fill(null)),
    reserved: Array.from({ length: size }, () => new Array<boolean>(size).fill(false)),
  };
}

function place(g: Grid, r: number, c: number, dark: boolean, reserve = true) {
  if (r < 0 || c < 0 || r >= g.size || c >= g.size) return;
  g.m[r][c] = dark;
  if (reserve) g.reserved[r][c] = true;
}

/** Finder patterns, separators, timing, alignment, the dark module. */
function drawFunctionPatterns(g: Grid, version: number) {
  const n = g.size;
  const finder = (top: number, left: number) => {
    for (let r = -1; r <= 7; r++)
      for (let c = -1; c <= 7; c++) {
        const rr = top + r, cc = left + c;
        if (rr < 0 || cc < 0 || rr >= n || cc >= n) continue;
        const inRing = r >= 0 && r <= 6 && c >= 0 && c <= 6 &&
          (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4));
        place(g, rr, cc, inRing);
      }
  };
  finder(0, 0); finder(0, n - 7); finder(n - 7, 0);

  for (let i = 8; i < n - 8; i++) {
    const dark = i % 2 === 0;
    place(g, 6, i, dark);
    place(g, i, 6, dark);
  }

  const centres = ALIGN[version];
  for (const r of centres)
    for (const c of centres) {
      // Skip the three that would collide with a finder pattern.
      if ((r === 6 && c === 6) || (r === 6 && c === n - 7) || (r === n - 7 && c === 6)) continue;
      for (let dr = -2; dr <= 2; dr++)
        for (let dc = -2; dc <= 2; dc++)
          place(g, r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
    }

  place(g, n - 8, 8, true);                                  // the dark module

  /* Reserve the format areas so data placement skips them; the values are
     written later, once a mask has been chosen. Index 6 is SKIPPED in both
     strips: (6,8) and (8,6) belong to the timing patterns, not to the format
     information, and reserving them here overwrote the timing line. */
  for (let i = 0; i < 9; i++) {
    if (i !== 6) { place(g, 8, i, false); place(g, i, 8, false); }
  }
  for (let i = 0; i < 8; i++) { place(g, 8, n - 1 - i, false); place(g, n - 1 - i, 8, false); }
  place(g, n - 8, 8, true);

  if (version >= 7) {
    const vb = versionBits(version);
    for (let i = 0; i < 18; i++) {
      const bit = vb[17 - i] === 1;
      const a = Math.floor(i / 3), b = i % 3;
      place(g, n - 11 + b, a, bit);
      place(g, a, n - 11 + b, bit);
    }
  }
}

function writeFormat(g: Grid, maskId: number) {
  const n = g.size, f = formatBits(maskId);
  // f[0] is the most significant bit; the standard places bit 14 first.
  const bit = (i: number) => f[14 - i] === 1;
  for (let i = 0; i <= 5; i++) place(g, 8, i, bit(i));
  place(g, 8, 7, bit(6));
  place(g, 8, 8, bit(7));
  place(g, 7, 8, bit(8));
  for (let i = 9; i <= 14; i++) place(g, 14 - i, 8, bit(i));

  for (let i = 0; i <= 7; i++) place(g, n - 1 - i, 8, bit(i));
  for (let i = 8; i <= 14; i++) place(g, 8, n - 15 + i, bit(i));
  place(g, n - 8, 8, true);
}

const MASKS: ((r: number, c: number) => boolean)[] = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

/** ISO 18004 §8.8.2 penalty score — lower is better. */
function penalty(m: boolean[][]): number {
  const n = m.length;
  let score = 0;

  const runScore = (line: boolean[]) => {
    let s = 0, run = 1;
    for (let i = 1; i < n; i++) {
      if (line[i] === line[i - 1]) run++;
      else { if (run >= 5) s += 3 + (run - 5); run = 1; }
    }
    if (run >= 5) s += 3 + (run - 5);
    return s;
  };
  for (let r = 0; r < n; r++) score += runScore(m[r]);
  for (let c = 0; c < n; c++) score += runScore(m.map((row) => row[c]));

  for (let r = 0; r < n - 1; r++)
    for (let c = 0; c < n - 1; c++)
      if (m[r][c] === m[r][c + 1] && m[r][c] === m[r + 1][c] && m[r][c] === m[r + 1][c + 1]) score += 3;

  const pat = [true, false, true, true, true, false, true];
  const hasAt = (line: boolean[], i: number, arr: boolean[]) =>
    arr.every((v, k) => line[i + k] === v);
  const four = [false, false, false, false];
  const check = (line: boolean[]) => {
    let s = 0;
    for (let i = 0; i + 7 <= n; i++) {
      if (!hasAt(line, i, pat)) continue;
      const before = i >= 4 && hasAt(line, i - 4, four);
      const after = i + 11 <= n && hasAt(line, i + 7, four);
      if (before || after) s += 40;
    }
    return s;
  };
  for (let r = 0; r < n; r++) score += check(m[r]);
  for (let c = 0; c < n; c++) score += check(m.map((row) => row[c]));

  const dark = m.flat().filter(Boolean).length;
  const pct = (dark * 100) / (n * n);
  score += Math.floor(Math.abs(pct - 50) / 5) * 10;
  return score;
}

/**
 * Encode `text` as a QR symbol and return the module matrix.
 * `true` is a dark module. Deterministic: same input, same matrix, always.
 */
export function qrMatrix(text: string): boolean[][] {
  const data = Array.from(new TextEncoder().encode(text));

  let version = 0;
  for (let v = 1; v <= MAX_VERSION; v++) {
    const countBits = v <= 9 ? 8 : 16;
    if (4 + countBits + data.length * 8 <= dataCapacity(v) * 8) { version = v; break; }
  }
  if (!version)
    throw new Error(`QR payload too long: ${data.length} bytes exceeds version ${MAX_VERSION} at level M.`);

  const [ecPer, b1, d1, b2, d2] = EC_M[version];
  const totalData = dataCapacity(version);

  const bits = new Bits();
  bits.push(0b0100, 4);                                    // byte mode
  bits.push(data.length, version <= 9 ? 8 : 16);
  for (const b of data) bits.push(b, 8);
  bits.push(0, Math.min(4, totalData * 8 - bits.length));  // terminator
  while (bits.length % 8 !== 0) bits.push(0, 1);

  const codewords: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits.bits[i + j];
    codewords.push(byte);
  }
  for (let pad = 0; codewords.length < totalData; pad++)
    codewords.push(pad % 2 === 0 ? 0xec : 0x11);

  // Split into blocks, compute EC per block, then interleave both.
  const blocks: number[][] = [];
  const ecBlocks: number[][] = [];
  let at = 0;
  for (let i = 0; i < b1; i++) { const blk = codewords.slice(at, at + d1); at += d1; blocks.push(blk); ecBlocks.push(ecCodewords(blk, ecPer)); }
  for (let i = 0; i < b2; i++) { const blk = codewords.slice(at, at + d2); at += d2; blocks.push(blk); ecBlocks.push(ecCodewords(blk, ecPer)); }

  const stream: number[] = [];
  const maxData = Math.max(d1, d2);
  for (let i = 0; i < maxData; i++) for (const blk of blocks) if (i < blk.length) stream.push(blk[i]);
  for (let i = 0; i < ecPer; i++) for (const blk of ecBlocks) stream.push(blk[i]);

  const g = blankGrid(version);
  drawFunctionPatterns(g, version);

  // Zig-zag placement, two columns at a time, skipping the vertical timing line.
  const streamBits: number[] = [];
  for (const byte of stream) for (let i = 7; i >= 0; i--) streamBits.push((byte >>> i) & 1);
  let idx = 0, upward = true;
  for (let right = g.size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;                            // the timing column
    for (let step = 0; step < g.size; step++) {
      const r = upward ? g.size - 1 - step : step;
      for (const c of [right, right - 1]) {
        if (g.reserved[r][c]) continue;
        g.m[r][c] = idx < streamBits.length ? streamBits[idx++] === 1 : false;
      }
    }
    upward = !upward;
  }

  // Try all eight masks, keep the least penalised — as the standard requires.
  let best: boolean[][] | null = null, bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const cand: boolean[][] = Array.from({ length: g.size }, (_, r) =>
      Array.from({ length: g.size }, (_, c) =>
        g.reserved[r][c] ? !!g.m[r][c] : !!g.m[r][c] !== MASKS[mask](r, c)));
    const probe: Grid = { m: cand, reserved: g.reserved, size: g.size };
    writeFormat(probe, mask);
    const score = penalty(cand);
    if (score < bestScore) { bestScore = score; best = cand; }
  }
  return best!;
}

/**
 * Render `text` as a standalone SVG. `scale` is module size in px and `quiet`
 * the mandatory light border, in modules (the standard requires 4).
 */
export function qrSvg(text: string, opts: { scale?: number; quiet?: number; title?: string } = {}): string {
  const { scale = 4, quiet = 4, title } = opts;
  const m = qrMatrix(text);
  const n = m.length;
  const dim = (n + quiet * 2) * scale;

  // One path for every dark module keeps the file small and printer-friendly.
  let d = "";
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++)
      if (m[r][c]) d += `M${(c + quiet) * scale} ${(r + quiet) * scale}h${scale}v${scale}h-${scale}z`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${dim}" height="${dim}" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges" role="img"${title ? ` aria-label="${title.replace(/"/g, "&quot;")}"` : ""}>`
    + `<rect width="${dim}" height="${dim}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}
