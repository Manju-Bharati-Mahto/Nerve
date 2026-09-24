/* ═══════════════════════════════════════════════════════════════════════════
   UNIT — asset import parsing, classification and matching (Phase 17L).

   Pure functions, no database. What is asserted here is the judgement the
   importer makes BEFORE a human sees it: what it proposes, what it refuses to
   propose, and which question it asks. The Phase 16B audit is the specification
   for half of this file — every inference error it found has a test.
   ═══════════════════════════════════════════════════════════════════════════ */
import { describe, it, expect } from "vitest";
import {
  normalizeName, proposeCategory, proposeScope, proposeQuantity,
  findCandidates, classify, normalizeRow, rowsFromRecords,
  type CategoryRef, type ScopeRef, type AssetRef, type SourceRow,
} from "./asset-import.js";

const CATS: CategoryRef[] = [
  { id: 1, name: "Camera Body" }, { id: 2, name: "Lens" }, { id: 3, name: "Light" },
  { id: 4, name: "Microphone" }, { id: 5, name: "Audio Recorder" }, { id: 6, name: "Tripod / Support" },
  { id: 7, name: "Battery" }, { id: 8, name: "Memory Card" }, { id: 9, name: "Accessory" },
  { id: 10, name: "Drone" }, { id: 11, name: "Gimbal" },
];
const SCOPES: ScopeRef[] = [
  { id: 101, code: "media_crew", name: "Media Crew" }, { id: 102, code: "pid", name: "PID" },
];
const src = (o: Partial<SourceRow> = {}): SourceRow =>
  ({ row: 2, name: "SONY FX3", inventory: "Media Crew", srNo: null,
     quantity: null, serial: null, ...o });

describe("category proposal repeats none of the Phase 16B inference errors", () => {
  it("calls a charger an accessory, not a camera", async () => {
    /* The audit's own example: the model name is in the string and the thing
       is a charger. A matcher that scores the model first is confidently
       wrong, which is worse than declining. */
    expect(proposeCategory("Canon 1500DII charger", CATS)?.name).toBe("Accessory");
    expect(proposeCategory("SONY FX3 battery charger", CATS)?.name).toBe("Accessory");
  });

  it("calls a battery a battery even when a camera is named beside it", () => {
    expect(proposeCategory("Canon EOS spare battery", CATS)?.name).toBe("Battery");
    expect(proposeCategory("SONY FX3 battery pack", CATS)?.name).toBe("Battery");
  });

  it("DECLINES a misspelling rather than guessing what was meant", () => {
    /* "BATTRAY S3 1" is one of the audit's own rows. The complaint was that it
       was classified as a Camera Body — not that a matcher should work out it
       means "battery". Guessing at spelling is how "SONY C2" came to match
       three lenses. Declining sends it to a person, which is correct. */
    expect(proposeCategory("BATTRAY S3 1", CATS)).toBeNull();
  });

  it("recognises a lens by its focal length", () => {
    expect(proposeCategory("SONY 24-70mm", CATS)?.name).toBe("Lens");
    expect(proposeCategory("50mm f/1.8 prime", CATS)?.name).toBe("Lens");
  });

  it("recognises the ordinary kinds", () => {
    expect(proposeCategory("SONY FX3", CATS)?.name).toBe("Camera Body");
    expect(proposeCategory("Manfrotto tripod", CATS)?.name).toBe("Tripod / Support");
    expect(proposeCategory("Rode shotgun mic", CATS)?.name).toBe("Microphone");
    expect(proposeCategory("DJI Mavic 3 drone", CATS)?.name).toBe("Drone");
  });

  it("DECLINES rather than guessing, and never invents a category", () => {
    expect(proposeCategory("MANAV", CATS)).toBeNull();
    expect(proposeCategory("TOUR", CATS)).toBeNull();
    expect(proposeCategory("misc item 7", CATS)).toBeNull();
  });
});

describe("inventory headings map only to approved inventories", () => {
  it("maps the two that exist, by name or code", () => {
    expect(proposeScope("Media Crew", SCOPES)?.id).toBe(101);
    expect(proposeScope("media_crew", SCOPES)?.id).toBe(101);
    expect(proposeScope("  PID  ", SCOPES)?.id).toBe(102);
  });

  it("refuses to invent one", () => {
    expect(proposeScope("Design Cell", SCOPES)).toBeNull();
    expect(proposeScope(null, SCOPES)).toBeNull();
    expect(proposeScope("", SCOPES)).toBeNull();
  });
});

describe("quantity", () => {
  it("accepts a whole count and rejects anything else", () => {
    expect(proposeQuantity("48")).toEqual({ quantity: 48, bad: false });
    expect(proposeQuantity(null)).toEqual({ quantity: null, bad: false });
    for (const bad of ["0", "-2", "2.5", "many", "48 units"])
      expect(proposeQuantity(bad).bad, bad).toBe(true);
  });
});

describe("matching is advisory and graded", () => {
  const assets: AssetRef[] = [
    { id: 1, asset_tag: "EQ-CAM-001", internal_code: "MC-0001", make: "SONY", model: "FX3",
      serial_no: "SN-FX3-0091", category_id: 1, scope_id: 101 },
    { id: 2, asset_tag: "EQ-CAM-002", internal_code: "MC-0002", make: "SONY", model: "FX3",
      serial_no: null, category_id: 1, scope_id: 101 },
    { id: 3, asset_tag: "EQ-LEN-001", internal_code: "MC-0003", make: "SONY", model: "24-70",
      serial_no: null, category_id: 2, scope_id: 101 },
  ];

  it("calls an exact manufacturer serial EXACT", () => {
    const c = findCandidates(src({ serial: "SN-FX3-0091" }), "SONY FX3", assets);
    expect(c[0].confidence).toBe("EXACT");
    expect(c[0].asset_id).toBe(1);
  });

  it("calls an exact make and model HIGH, never EXACT", () => {
    const c = findCandidates(src(), "SONY FX3", assets);
    expect(c.every((x) => x.confidence !== "EXACT")).toBe(true);
    expect(c.filter((x) => x.confidence === "HIGH").length).toBe(2);
  });

  it("calls a shared model POSSIBLE and nothing stronger", () => {
    const c = findCandidates(src({ name: "SONY FX3 spare" }), "SONY FX3 spare", assets);
    expect(c.length).toBeGreaterThan(0);
    expect(c.every((x) => x.confidence === "POSSIBLE")).toBe(true);
  });

  it("returns nothing for something the estate has never seen", () => {
    expect(findCandidates(src({ name: "Blackmagic 6K" }), "Blackmagic 6K", assets)).toEqual([]);
  });
});

describe("classification asks the right question", () => {
  const base = { source: src(), normalizedName: "SONY FX3", categoryId: 1, scopeId: 101,
                 trackingMode: "individual" as const, quantity: null, serialNo: null,
                 warnings: [], candidates: [] };

  it("asks about the inventory first, because nothing else can be decided without it", () => {
    expect(classify({ ...base, scopeId: null, categoryId: null })).toBe("scope_decision_required");
  });

  it("asks about the category when the inventory is known", () => {
    expect(classify({ ...base, categoryId: null })).toBe("category_review_required");
  });

  it("forces an identity decision when a strong candidate exists", () => {
    expect(classify({ ...base, candidates: [
      { asset_id: 1, asset_tag: "EQ-CAM-001", confidence: "EXACT", why: "serial" }] }))
      .toBe("identity_decision_required");
  });

  it("sends a row with SEVERAL possible matches to physical verification", () => {
    /* Two cameras of the same name: the sheet cannot say which, and neither
       can any amount of string comparison. */
    expect(classify({ ...base, candidates: [
      { asset_id: 1, asset_tag: "EQ-CAM-001", confidence: "POSSIBLE", why: "model" },
      { asset_id: 2, asset_tag: "EQ-CAM-002", confidence: "POSSIBLE", why: "model" }] }))
      .toBe("physical_verification");
  });

  it("sends a quantity above one to pooled review rather than deciding", () => {
    expect(classify({ ...base, quantity: 48, trackingMode: "pooled" })).toBe("pooled_review");
  });

  it("leaves a clean new row pending", () => {
    expect(classify(base)).toBe("pending_review");
  });
});

describe("a normalised row keeps its provenance and invents no serial", () => {
  const assets: AssetRef[] = [];

  it("NEVER turns the sheet's sequence column into a manufacturer serial", () => {
    /* The single rule this file exists to protect. */
    const n = normalizeRow(src({ srNo: "7" }), CATS, SCOPES, assets);
    expect(n.serialNo, "the Sr. No column became a manufacturer serial").toBeNull();
    expect(n.source.srNo, "provenance was lost").toBe("7");
    expect(n.warnings.join(" ")).toMatch(/row counter/i);
  });

  it("keeps a real manufacturer serial when the sheet carries one", () => {
    expect(normalizeRow(src({ serial: "SN-1234" }), CATS, SCOPES, assets).serialNo).toBe("SN-1234");
  });

  it("carries the source row number through untouched", () => {
    expect(normalizeRow(src({ row: 42 }), CATS, SCOPES, assets).source.row).toBe(42);
  });

  it("warns rather than guessing when the inventory is unknown", () => {
    const n = normalizeRow(src({ inventory: "Design Cell" }), CATS, SCOPES, assets);
    expect(n.scopeId).toBeNull();
    expect(n.state).toBe("scope_decision_required");
    expect(n.warnings.join(" ")).toMatch(/not an approved inventory/i);
  });
});

describe("parsing is forgiving about headings and strict about content", () => {
  it("accepts the spellings the team actually uses", () => {
    for (const h of ["Equipment Name", "equipment", "Item", "Particulars"]) {
      const r = rowsFromRecords([{ [h]: "SONY FX3", Inventory: "Media Crew" }]);
      expect(r.error, h).toBeNull();
      expect(r.rows[0].name).toBe("SONY FX3");
    }
  });

  it("refuses a file with no equipment-name column, and says what it wanted", () => {
    const r = rowsFromRecords([{ Thing: "x", Other: "y" }]);
    expect(r.rows).toEqual([]);
    expect(r.error).toMatch(/No equipment-name column/i);
    expect(r.error).toMatch(/equipment name/i);
  });

  it("refuses an empty file", () => {
    expect(rowsFromRecords([]).error).toMatch(/no rows/i);
  });

  it("skips blank spacer lines rather than importing them", () => {
    const r = rowsFromRecords([
      { "Equipment Name": "SONY FX3" }, { "Equipment Name": "" }, { "Equipment Name": "  " },
      { "Equipment Name": "Lens 24-70mm" }]);
    expect(r.rows.map((x) => x.name)).toEqual(["SONY FX3", "Lens 24-70mm"]);
  });

  it("numbers rows from the source, counting the header line", () => {
    const r = rowsFromRecords([{ "Equipment Name": "A" }, { "Equipment Name": "B" }]);
    expect(r.rows.map((x) => x.row)).toEqual([2, 3]);
  });

  it("TREATS A FORMULA AS TEXT and never evaluates it", () => {
    const r = rowsFromRecords([{ "Equipment Name": "=1+1", Inventory: "=cmd|'/c calc'!A1" }]);
    expect(r.rows[0].name).toBe("=1+1");
    expect(r.rows[0].inventory).toBe("=cmd|'/c calc'!A1");
  });

  it("bounds a very long cell rather than storing a novel", () => {
    const r = rowsFromRecords([{ "Equipment Name": "x".repeat(5000) }]);
    expect(r.rows[0].name.length).toBeLessThanOrEqual(500);
  });

  it("tolerates a Sr. No column without treating it as a serial", () => {
    const r = rowsFromRecords([{ "Equipment Name": "SONY S3", "Sr. No": "2", Inventory: "PID" }]);
    expect(r.rows[0].srNo).toBe("2");
    expect(r.rows[0].serial).toBeNull();
  });
});

describe("normalizeName", () => {
  it("tidies whitespace and smart quotes without changing meaning", () => {
    expect(normalizeName("  SONY   FX3 \n")).toBe("SONY FX3");
    expect(normalizeName("Canon’s body")).toBe("Canon's body");
  });
});
