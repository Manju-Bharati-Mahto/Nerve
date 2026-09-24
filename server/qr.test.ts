// @vitest-environment node
/* ═══════════════════════════════════════════════════════════════════════════
   UNIT — the QR encoder.

   THE THING THIS REPLACED was `(i*7 + asset.id*13) % 3` rendered as a grid,
   with a Print button under it. So "it looks like a QR code" is precisely the
   standard this file must not accept.

   The strong test here is ROUND TRIP. `decode()` below walks the symbol back
   to its payload: it locates the function patterns from the standard's rules,
   reads the format information, un-masks, follows the zig-zag, de-interleaves
   the blocks and parses the byte-mode header. It is written from the spec
   rather than from qr.ts's internals, so a placement, masking or interleaving
   bug in the encoder shows up here as a payload that does not come back.

   Error correction is deliberately NOT exercised on the way back — the data
   codewords alone are enough to prove the payload survived, and checking the
   Reed–Solomon output against itself would prove nothing.
   ═══════════════════════════════════════════════════════════════════════════ */
import { describe, it, expect } from "vitest";
import { qrMatrix, qrSvg } from "./qr.js";

/* ── An independent reading of the symbol ────────────────────────────────── */

const ALIGN: Record<number, number[]> = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
  6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
};
const EC_M: Record<number, [number, number, number, number, number]> = {
  1: [10, 1, 16, 0, 0],   2: [16, 1, 28, 0, 0],   3: [26, 1, 44, 0, 0],
  4: [18, 2, 32, 0, 0],   5: [24, 2, 43, 0, 0],   6: [16, 4, 27, 0, 0],
  7: [18, 4, 31, 0, 0],   8: [22, 2, 38, 2, 39],  9: [22, 3, 36, 2, 37],
  10: [26, 4, 43, 1, 44],
};
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

/** Every module a symbol of this version reserves for function patterns. */
function reservedMask(version: number): boolean[][] {
  const n = version * 4 + 17;
  const res = Array.from({ length: n }, () => new Array(n).fill(false));
  const block = (r0: number, c0: number, h: number, w: number) => {
    for (let r = r0; r < r0 + h; r++)
      for (let c = c0; c < c0 + w; c++)
        if (r >= 0 && c >= 0 && r < n && c < n) res[r][c] = true;
  };
  block(0, 0, 9, 9);                       // finder TL + separators + format
  block(0, n - 8, 9, 8);                   // finder TR + format
  block(n - 8, 0, 8, 9);                   // finder BL + format
  for (let i = 0; i < n; i++) { res[6][i] = true; res[i][6] = true; }   // timing
  for (const r of ALIGN[version])
    for (const c of ALIGN[version]) {
      if ((r === 6 && c === 6) || (r === 6 && c === n - 7) || (r === n - 7 && c === 6)) continue;
      block(r - 2, c - 2, 5, 5);
    }
  if (version >= 7) { block(n - 11, 0, 3, 6); block(0, n - 11, 6, 3); }
  return res;
}

/** The 15 format bits, in the standard's order: index i is format bit i. */
function formatValue(m: boolean[][]): number {
  const bits = [
    ...[0, 1, 2, 3, 4, 5].map((i) => (m[8][i] ? 1 : 0)),
    m[8][7] ? 1 : 0, m[8][8] ? 1 : 0, m[7][8] ? 1 : 0,
    ...[5, 4, 3, 2, 1, 0].map((i) => (m[i][8] ? 1 : 0)),
  ];
  // bits[i] IS bit i, so it is weighted 1<<i — folding it MSB-first would
  // read the whole field backwards.
  return bits.reduce((acc, b, i) => acc | (b << i), 0);
}
/** Read the format information and return the mask id it names. */
function readMask(m: boolean[][]): number {
  return ((formatValue(m) ^ 0x5412) >>> 10) & 0b111;
}

/** Walk a finished symbol back to the string it carries. */
function decode(m: boolean[][]): string {
  const n = m.length;
  const version = (n - 17) / 4;
  const reserved = reservedMask(version);
  const mask = MASKS[readMask(m)];

  // Un-mask and follow the zig-zag in the same order the writer used.
  const stream: number[] = [];
  let upward = true;
  for (let right = n - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let step = 0; step < n; step++) {
      const r = upward ? n - 1 - step : step;
      for (const c of [right, right - 1]) {
        if (reserved[r][c]) continue;
        stream.push((m[r][c] !== mask(r, c)) ? 1 : 0);
      }
    }
    upward = !upward;
  }

  const codewords: number[] = [];
  for (let i = 0; i + 8 <= stream.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | stream[i + j];
    codewords.push(b);
  }

  // De-interleave: the writer emitted column-major across blocks.
  const [, b1, d1, b2, d2] = EC_M[version];
  const sizes = [...Array(b1).fill(d1), ...Array(b2).fill(d2)] as number[];
  const blocks: number[][] = sizes.map(() => []);
  let at = 0;
  for (let i = 0; i < Math.max(d1, d2); i++)
    for (let b = 0; b < sizes.length; b++)
      if (i < sizes[b]) blocks[b].push(codewords[at++]);

  const data = blocks.flat();
  const bits: number[] = [];
  for (const b of data) for (let i = 7; i >= 0; i--) bits.push((b >>> i) & 1);

  const take = (count: number) => {
    let v = 0;
    for (let i = 0; i < count; i++) v = (v << 1) | bits.shift()!;
    return v;
  };
  const mode = take(4);
  if (mode !== 0b0100) throw new Error(`expected byte mode, got ${mode.toString(2)}`);
  const len = take(version <= 9 ? 8 : 16);
  const bytes: number[] = [];
  for (let i = 0; i < len; i++) bytes.push(take(8));
  return new TextDecoder().decode(Uint8Array.from(bytes));
}

/* ═══════════════════════════════════════════════════════════════════════════ */

describe("the symbol is structurally a QR code", () => {
  const m = qrMatrix("NERVE");

  it("is 21×21 for version 1, and grows four modules per version", () => {
    expect(m.length).toBe(21);
    expect(qrMatrix("x".repeat(30)).length).toBe(29);    // version 3
    expect(qrMatrix("x".repeat(60)).length).toBe(33);    // version 4
    expect(qrMatrix("x".repeat(120)).length).toBe(45);   // version 7 — adds version info
  });

  it("carries three finder patterns", () => {
    const finder = (top: number, left: number) => {
      for (let r = 0; r < 7; r++)
        for (let c = 0; c < 7; c++) {
          const want = r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4);
          if (m[top + r][left + c] !== want) return false;
        }
      return true;
    };
    expect(finder(0, 0)).toBe(true);
    expect(finder(0, m.length - 7)).toBe(true);
    expect(finder(m.length - 7, 0)).toBe(true);
  });

  it("carries unbroken timing patterns and the dark module", () => {
    for (let i = 8; i < m.length - 8; i++) {
      expect(m[6][i], `timing row at ${i}`).toBe(i % 2 === 0);
      expect(m[i][6], `timing col at ${i}`).toBe(i % 2 === 0);
    }
    expect(m[m.length - 8][8]).toBe(true);
  });

  it("declares error-correction level M in its format information", () => {
    expect(((formatValue(m) ^ 0x5412) >>> 13) & 0b11).toBe(0b00);   // 00 = level M
  });
});

describe("the symbol actually carries its payload", () => {
  /* If placement, masking or interleaving were wrong, none of these would
     come back — which is exactly what the checkerboard could not do. */
  const cases = [
    "A",
    "NERVE",
    "https://nerve.parul.ac.in/a/AT-7K3F9QX2",
    "x".repeat(40),                                        // multi-block, version 3
    "y".repeat(100),                                       // two groups, version 6
    "z".repeat(150),                                       // version 8: unequal groups
    "asset/AT-0001?v=1",
  ];
  for (const text of cases)
    it(`round-trips ${text.length === 1 ? "a single character" : `${text.length} bytes`}`, () => {
      expect(decode(qrMatrix(text))).toBe(text);
    });

  it("round-trips a URL containing characters that need two bytes", () => {
    const text = "https://nerve.test/a/AT-ÉÑ-01";
    expect(decode(qrMatrix(text))).toBe(text);
  });
});

describe("it behaves like a function, not like decoration", () => {
  it("is deterministic — the same payload always gives the same modules", () => {
    const a = qrMatrix("https://nerve.test/a/AT-ABC123");
    const b = qrMatrix("https://nerve.test/a/AT-ABC123");
    expect(a).toEqual(b);
  });

  it("gives different symbols to payloads that differ by one character", () => {
    expect(qrMatrix("AT-000001")).not.toEqual(qrMatrix("AT-000002"));
  });

  it("refuses a payload it cannot encode rather than truncating it", () => {
    expect(() => qrMatrix("y".repeat(400))).toThrow(/too long/i);
  });
});

describe("the SVG is printable", () => {
  const svg = qrSvg("https://nerve.test/a/AT-ABC123", { scale: 4, quiet: 4 });

  it("is a standalone SVG document with a white ground and black modules", () => {
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg.endsWith("</svg>")).toBe(true);
    expect(svg).toContain('fill="#fff"');
    expect(svg).toContain('fill="#000"');
  });

  it("includes the four-module quiet zone the standard requires", () => {
    const n = qrMatrix("https://nerve.test/a/AT-ABC123").length;
    expect(svg).toContain(`width="${(n + 8) * 4}"`);
  });

  it("scales without changing what it encodes", () => {
    const big = qrSvg("https://nerve.test/a/AT-ABC123", { scale: 8 });
    expect(big).toContain(`width="${(qrMatrix("https://nerve.test/a/AT-ABC123").length + 8) * 8}"`);
  });
});
