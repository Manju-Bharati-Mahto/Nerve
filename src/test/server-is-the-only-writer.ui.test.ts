/* ═══════════════════════════════════════════════════════════════════════════
   UI — the server is the only writer, and a failure says what it was.

   PHASE 17P. Two defects, found by chasing one screenshot.

   THE SCREENSHOT. A local run showed the Equipment page rendering and the
   Bookings tab saying "Bookings could not be loaded — HTTP 404". The route
   existed, the frontend called it correctly, and the process listening on the
   API port was three days old and had never heard of it. What the reader was
   told was a number that reads like "there are no bookings".

   THE WORSE ONE, FOUND ON THE WAY. window.__MO_LIVE__ is false whenever
   hydration fails, and in that state SIX equipment mutations went on working
   against the bundled sample data: checkout, check-in, reservation,
   cancellation, damage and the whole kiosk run each wrote a row into a browser
   array and reported success. A custodian could hand over a camera, read
   "checked out", and no record of the loan would exist anywhere.

   Two more did the opposite and were just as bad: Add item and the check-in
   submit closed their dialog and did nothing at all, silently.

   These tests pin both: every equipment write goes to the server or is
   refused out loud, and no failure is reported as a bare status code.
   ═══════════════════════════════════════════════════════════════════════════ */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const HTML = readFileSync("public/media-ops/index.html", "utf8");
/** The one script tag — the file is served verbatim, so this is what ships. */
const JS = HTML.slice(HTML.indexOf(">", HTML.indexOf("<script")) + 1, HTML.lastIndexOf("</script>"));

describe("no equipment mutation can be invented by the browser", () => {
  it("writes no equipment row into a client array, anywhere", () => {
    /* The seed renders; it does not record. A push into one of these arrays is
       a transaction, a reservation or a repair that exists in one tab and
       nowhere else. */
    const writes = JS.match(
      /DB\.(equipment_items|equipment_transactions|equipment_bookings|maintenance_records)\.(push|splice|unshift|pop|shift)/g);
    expect(writes, `client-side equipment writes: ${writes?.join(", ")}`).toBeNull();
  });

  it("has no offlineCheckout to wire a scanner to by mistake", () => {
    /* It existed for a whole phase, the QR scanner was pointed at it, and a
       scan that "checked out" an asset lost the loan. The fix then was to call
       the right function; the fix now is that there is only one. */
    expect(JS).not.toMatch(/offlineCheckout\s*[:(]/);
  });

  it("refuses every equipment write when the server cannot be reached", () => {
    /* Six mutations, each gated on the same helper, which says what was NOT
       saved rather than failing silently or pretending. */
    for (const act of ["A checkout", "A check-in", "A reservation",
                       "A cancellation", "A damage report",
                       "A kiosk checkout or check-in", "Adding an asset"])
      expect(JS, `${act} is not gated`).toContain(`liveWrite('${act}')`);
    expect(JS).toMatch(/function liveWrite\(what\)\{\s*if\(window\.__MO_LIVE__\) return true;/);
  });

  it("tells the person nothing was saved, rather than nothing at all", () => {
    const fn = JS.slice(JS.indexOf("function liveWrite(what)"),
                        JS.indexOf("function liveWrite(what)") + 500);
    expect(fn).toMatch(/Nothing was saved/i);
    expect(fn).toMatch(/sample data/i);
    /* It must not return true on the failure path — that would restore every
       defect this file exists to prevent. */
    expect(fn).toMatch(/return false;/);
  });

  it("lets the kiosk send the run home rather than drawing a Done screen", () => {
    const k = JS.slice(JS.indexOf("function commitKiosk()"),
                       JS.indexOf("function commitKiosk()") + 2200);
    /* The guard comes before anything that looks like success. */
    expect(k.indexOf("liveWrite(")).toBeLessThan(k.indexOf("S.kiosk.step=5"));
    expect(k).toContain("/checkout");
    expect(k).toContain("/checkin");
    /* BR-8 is the server's verdict; the browser's second copy is gone. */
    expect(k, "the kiosk recomputes BR-8").not.toMatch(/rank\[K\.cond\]/);
  });

  it("keeps BR-8 in one place — the server", () => {
    /* Two implementations of "is this condition worse than at checkout"
       disagreed in both directions and the user watched the screen change its
       mind after the re-hydrate. */
    expect(JS, "a browser-side BR-8 comparison is back")
      .not.toMatch(/rank\[cond\]\s*<\s*rank\[e\.condition\]/);
  });
});

describe("a failed request explains itself", () => {
  const req = JS.slice(JS.indexOf("const MO_API = {"), JS.indexOf("const MO_API = {") + 2000);

  it("does not report a bare status code when the server said nothing", () => {
    /* `HTTP 404` was the whole message on the screenshot that started 17P. */
    expect(req, "the bare 'HTTP '+status message is back").not.toMatch(/'HTTP '\s*\+\s*r\.status/);
    expect(req).toContain("moHttpMeaning(r.status)");
  });

  it("still prefers the server's own words whenever it has them", () => {
    /* Every refusal the API writes carries a message saying what happened, and
       that message is what the reader must see — the taxonomy is only for the
       cases where there is no body to read. */
    expect(req).toMatch(/\(j&&j\.message\)\|\|moHttpMeaning/);
  });

  it("distinguishes the outcomes the UI has to tell apart", () => {
    const table = JS.slice(JS.indexOf("const MO_HTTP_MEANING"),
                           JS.indexOf("const moHttpMeaning"));
    for (const code of [400, 401, 403, 404, 409, 422, 429])
      expect(table, `no wording for ${code}`).toMatch(new RegExp(`\\b${code}:`));
    expect(JS).toMatch(/st>=500 \?/);
    /* A 404 with no body means the endpoint is not there — which is a server
       that is out of date, not an empty list. */
    expect(table).toMatch(/does not have that endpoint/i);
  });

  it("separates 'never sent' from any status code at all", () => {
    /* fetch only rejects when nothing was answered: offline, DNS, a refused
       connection, a dev server that is not running. Reporting that as a status
       is how "the server is down" became "HTTP 404". */
    expect(req).toMatch(/err\.status=0;\s*err\.offline=true/);
    expect(req).toMatch(/could not be reached/i);
    expect(req).toMatch(/nothing was sent/i);
  });

  it("does not leak anything about the backend into those sentences", () => {
    const table = JS.slice(JS.indexOf("const MO_HTTP_MEANING"),
                           JS.indexOf("const moHttpMeaning"));
    for (const leak of ["postgres", "sql", "stack", "express", "node_modules", "/api/v1"])
      expect(table.toLowerCase(), `the wording leaks ${leak}`).not.toContain(leak);
  });
});
