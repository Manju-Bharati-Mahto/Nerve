/* ═══════════════════════════════════════════════════════════════════════════
   UI — equipment export, and the metric that stopped claiming to be one.

   EXPORT IS A SERVER READ. The browser asks for a file; the server builds it
   from the same query, scope and filters as the screen. A client-side CSV
   would be a second implementation of every report — free to drift from the
   one on screen, and limited to whichever page happened to be loaded.

   AND NOTHING CALLS ITSELF UTILISATION. The analytics table used to show
   min(100, checkouts × 14) as a percentage under a tooltip promising
   "checked-out days ÷ available days". Available days are not recorded, so
   that number could not exist. These tests pin its absence.
   ═══════════════════════════════════════════════════════════════════════════ */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const HTML = readFileSync("public/media-ops/index.html", "utf8");

describe("equipment export", () => {
  const action = HTML.slice(HTML.indexOf("eqExport:(d)=>{"),
                            HTML.indexOf("eqExport:(d)=>{") + 1400);

  it("asks the server for the file rather than building one in the browser", () => {
    expect(action).toContain("/equipment/export?");
    expect(action).toContain("MO_API.base");
    /* No Blob, no client-side CSV assembly, no second copy of the report. */
    expect(action, "the browser built the CSV itself").not.toMatch(/new Blob|join\(','\)/);
  });

  it("sends the screen's own filters, so the file matches what was on screen", () => {
    expect(action).toContain("inventory");
    expect(action).toContain("category_id");
    expect(action).toContain("dataset");
  });

  it("offers exactly the four datasets, each on the tab that owns that report", () => {
    /* Three are literal buttons; custody's is emitted by the dashboard's
       sectionHead helper, so it is checked at the call site instead. */
    for (const set of ["transactions", "assurance", "maintenance"])
      expect(HTML, `no export for ${set}`).toContain(`data-act="eqExport" data-set="${set}"`);
    expect(HTML, "the dashboard lost its custody export")
      .toContain("sectionHead('Out now','custody')");
    expect(HTML).toContain("Last physically seen");
    expect(HTML).toContain("Maintenance &amp; damage");
    /* And no fifth tab was invented to hold them. */
    expect(HTML).not.toMatch(/\['reports','Reports'/);
  });
});

describe("the analytics table no longer claims a utilisation it cannot compute", () => {
  const section = HTML.slice(HTML.indexOf("Checkout activity") - 1200,
                             HTML.indexOf("Checkout activity") + 3000);

  it("does not multiply a count by an unexplained constant", () => {
    expect(section, "the checkouts × 14 percentage is back").not.toMatch(/checkouts\s*\*\s*14/);
    expect(HTML, "the category chart still plots checkouts × 2")
      .not.toMatch(/v:\s*c\.checkouts\s*\*\s*2/);
  });

  it("does not promise a formula it has not implemented", () => {
    expect(HTML, "the tooltip still claims checked-out days ÷ available days")
      .not.toContain("Checked-out days ÷ available days, per item/category");
    expect(section).toMatch(/This is not utilisation/i);
  });

  it("compares each item with the busiest one shown, which needs no denominator", () => {
    expect(section).toMatch(/busiest/);
    expect(section).toContain("Relative activity");
    /* An item that has never gone out says so in words rather than showing 0%,
       which would read as a measurement rather than an absence. */
    expect(section).toContain("never out");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   The derived figures, on the tab that already holds historical analytics.

   Phase 17N computed four things the ledger can genuinely answer — average
   loan, average repair, reservations kept, coverage — and for a while they had
   no screen at all: the endpoint existed and nothing read it. An analytics
   figure nobody can see is not reporting.

   No new tab was created to hold them, and nothing here recomputes anything:
   the panel renders what the server derived, including the server's own
   statement of what each figure is based on.
   ═══════════════════════════════════════════════════════════════════════════ */
describe("the derived figures reach a screen", () => {
  const panel = HTML.slice(HTML.indexOf("function eqInsights()"),
                           HTML.indexOf("function eqAnalytics()"));

  it("reads them from the server rather than deriving them in the browser", () => {
    expect(HTML).toContain("MO_API.get('/equipment/insights')");
    /* Nothing here averages, divides by a duration, or pairs a checkout with a
       check-in. The one arithmetic the panel does is a share of a total, and
       both numbers come from the same response. */
    expect(panel, "the browser paired transactions itself").not.toMatch(/check_out|check_in/);
    expect(panel, "the browser computed a duration").not.toMatch(/86400|getTime\(\)/);
  });

  it("shows all four, on the existing Analytics tab and not a new one", () => {
    for (const label of ["Average loan", "Average repair", "Reservations kept", "In an inventory"])
      expect(panel, `${label} is not shown`).toContain(label);
    expect(HTML, "a Reports tab was invented").not.toMatch(/\['reports','Reports'/);
    /* Composed into the analytics view, so opening Analytics shows it. */
    expect(HTML).toContain("const head=eqInsights();");
  });

  it("passes the server's statement of what each figure means through to the reader", () => {
    /* `basis` is the server saying "closed loans only" and "whole days". The
       panel must not paraphrase it into something friendlier and wronger. */
    for (const k of ["L.basis", "M.basis", "R.basis"])
      expect(panel, `${k} is not shown to the reader`).toContain(k);
  });

  it("says nothing rather than zero when there is nothing to average", () => {
    /* No closed loans yet means there is no average. "0 days" would be a claim
       about the estate; "—" is the absence of one. */
    expect(panel).toMatch(/v==null\?'—'/);
  });

  it("fails on its own, without taking the analytics table down with it", () => {
    expect(panel).toContain('data-act="eqInRetry"');
    expect(HTML).toContain("eqInRetry:()=>{");
    /* Its own state object, cleared by the same invalidation as the charts. */
    expect(HTML).toContain("const EQ_IN = {loaded:false");
    expect(HTML).toContain("EQ_IN.loaded=false; EQ_IN.loading=false;");
  });

  it("counts what the records are missing without creating any of it", () => {
    expect(panel).toContain("Without an internal code");
    expect(panel).toContain("Without a QR label");
    expect(panel).toContain("Never physically inspected");
    /* Reporting only: no POST, no identifier minting, no QR generation. */
    expect(panel, "the coverage panel writes").not.toMatch(/MO_API\.(post|patch|put|del)/);
  });
});
