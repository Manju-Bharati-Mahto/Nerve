/* ═══════════════════════════════════════════════════════════════════════════
   P8 — a kanban on a phone.

   Two things were wrong. A board was a horizontal strip of 286px columns, each
   scrolling its own cards inside a 400px window, inside the scrolling page. And
   moving a card was drag-only, which does not exist on touch — so the board was
   read-only while its own note told you to drag a card.

   These tests cover the shape (one column per screen, a switcher built from the
   columns themselves) and the tap path, including that a move actually changes
   the data and still refuses a move the rules do not allow.
   ═══════════════════════════════════════════════════════════════════════════ */
import { test, expect, devices, type Page } from "@playwright/test";
import { bootStaff, go } from "./harness";

const { defaultBrowserType: _b, ...PHONE } = devices["iPhone 13"];

test.describe("on a phone", () => {
  test.use(PHONE);

  test("a column fills the screen, and nothing scrolls inside anything else", async ({ page }) => {
    await bootStaff(page, "admin");
    await go(page, "#/media/pipeline");
    const shape = await page.evaluate(() => {
      const kb = document.querySelector("#page .kb") as HTMLElement;
      const col = kb.querySelector(".kb-col") as HTMLElement;
      const cards = col.querySelector(".kb-cards") as HTMLElement;
      return { colW: Math.round(col.getBoundingClientRect().width), kbW: kb.clientWidth,
               colMaxH: getComputedStyle(col).maxHeight, cardsOverflowY: getComputedStyle(cards).overflowY };
    });
    expect(shape.colW).toBe(shape.kbW);            // one column per screen
    expect(shape.colMaxH).toBe("none");            // the page scrolls, not the column
    expect(shape.cardsOverflowY).toBe("visible");
  });

  test("the switcher is built from the columns, and moves the board to one", async ({ page }) => {
    await bootStaff(page, "admin");
    await go(page, "#/media/pipeline");
    const chips = page.locator("#page .kb-switch .kbs");
    const cols = page.locator("#page .kb .kb-col");
    expect(await chips.count()).toBe(await cols.count());
    /* The first chip names the first column, rather than a label invented here. */
    const first = await page.evaluate(() =>
      (document.querySelector("#page .kb .kb-col .kb-col-head .kt")?.textContent || "").trim());
    expect((await chips.first().innerText()).replace(/\s+/g, " ")).toContain(first.replace(/\s+/g, " "));

    await chips.nth(2).click();
    await page.waitForFunction(() => {
      const kb = document.querySelector("#page .kb") as HTMLElement;
      const col = kb.querySelectorAll(".kb-col")[2] as HTMLElement;
      return Math.abs(kb.scrollLeft - (col.offsetLeft - (kb.querySelector(".kb-col") as HTMLElement).offsetLeft)) < 4;
    }, null, { timeout: 4000 });
    await expect(chips.nth(2)).toHaveClass(/\bon\b/);
  });

  test("the note tells you to tap, because dragging is not a thing here", async ({ page }) => {
    await bootStaff(page, "admin");
    await go(page, "#/media/pipeline");
    const visible = await page.evaluate(() =>
      [...document.querySelectorAll("#page .note")]
        .map((n) => (n as HTMLElement).innerText).join(" | "));
    expect(visible).toContain("Tap");
    expect(visible).not.toContain("Drag a card");
  });

  test("a card's ⋯ moves it, and the deliverable really changes status", async ({ page }) => {
    await bootStaff(page, "admin");
    await go(page, "#/media/pipeline");
    /* Pick a real card and read its id and status from the page's own data. */
    const before = await page.evaluate(() => {
      const card = document.querySelector("#page .kb-card[data-drag^='deliverable:']") as HTMLElement;
      const id = +card.dataset.drag!.split(":")[1];
      return { id, status: (window as never as { deliv: (n: number) => { status: string } }), s: "" };
    }).then(async (x) => ({ id: x.id, status: await page.evaluate(`deliv(${x.id}).status`) as string }));

    await page.locator(`#page .kb-card[data-drag='deliverable:${before.id}'] .kc-move`).click();
    await expect(page.locator(".menu")).toBeVisible();
    /* The first real destination offered — the menu decides what is allowed. */
    const dest = page.locator(".menu-item").filter({ hasText: "→" }).first();
    const destText = (await dest.innerText()).replace(/^→\s*/, "").trim();
    await dest.click();

    const after = await page.evaluate(`deliv(${before.id}).status`) as string;
    expect(after, "the status did not change").not.toBe(before.status);
    /* And the label the menu offered is the status it actually set. */
    const label = await page.evaluate(`DELIV_STATUS[${JSON.stringify(after)}].l`);
    expect(destText).toContain(label as string);
  });

  test("a board card moves between that board's columns", async ({ page }) => {
    await bootStaff(page, "admin");
    await go(page, "#/media/boards");
    const id = await page.evaluate(() => {
      const c = document.querySelector("#page .kb-card[data-drag^='card:']") as HTMLElement;
      return +c.dataset.drag!.split(":")[1];
    });
    const from = await page.evaluate(`DB.cards.find(c=>c.id===${id}).column_id`);
    await page.locator(`#page .kb-card[data-drag='card:${id}'] .kc-move`).click();
    await expect(page.locator(".menu")).toBeVisible();
    /* Only other columns are selectable; the one it is in is disabled. */
    /* Not .menu-cancel: a phone sheet appends its own Cancel row. */
    await page.locator(".menu-item:not([disabled]):not(.menu-cancel)").last().click();
    const to = await page.evaluate(`DB.cards.find(c=>c.id===${id}).column_id`);
    expect(to).not.toBe(from);
    /* It belongs to the same board — the menu never offers another board's columns. */
    const sameBoard = await page.evaluate(
      `(()=>{const c=DB.cards.find(c=>c.id===${id});
        return DB.board_columns.find(x=>x.id===c.column_id).board_id===c.board_id;})()`);
    expect(sameBoard).toBe(true);
  });
});

test.describe("on a desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  const kbShape = (p: Page) => p.evaluate(() => {
    const kb = document.querySelector("#page .kb") as HTMLElement;
    const col = kb.querySelector(".kb-col") as HTMLElement;
    return { switcher: !!document.querySelector("#page .kb-switch"),
             colW: Math.round(col.getBoundingClientRect().width),
             moveVisible: [...document.querySelectorAll("#page .kc-move")]
               .some((b) => (b as HTMLElement).offsetParent !== null),
             draggable: col.querySelector(".kb-card")?.getAttribute("draggable") };
  });

  test("keeps its columns, its drag, and gains no phone furniture", async ({ page }) => {
    await bootStaff(page, "admin");
    await go(page, "#/media/pipeline");
    const s = await kbShape(page);
    expect(s.switcher, "a phone switcher was built on desktop").toBe(false);
    expect(s.colW).toBe(286);
    expect(s.moveVisible, "the phone move control is showing on desktop").toBe(false);
    expect(s.draggable).toBe("true");
  });

  test("still says to drag, because there you can", async ({ page }) => {
    await bootStaff(page, "admin");
    await go(page, "#/media/pipeline");
    const notes = await page.evaluate(() =>
      [...document.querySelectorAll("#page .note")].map((n) => (n as HTMLElement).innerText).join(" | "));
    expect(notes).toContain("Drag a card");
  });
});

/* ── Teams reorder ──────────────────────────────────────────────────────────
   The same gap as a kanban card: the order was set by dragging, which a finger
   cannot do. The tap path rebuilds the id list a drop would have produced and
   hands it to the existing action. */
test.describe("reordering teams", () => {
  test.use(PHONE);

  test("Move down actually changes the stored order", async ({ page }) => {
    await bootStaff(page, "admin");
    await go(page, "#/media/team");
    await page.evaluate("S.tab.team='structure'; render()");
    const before = await page.evaluate("activeTeams().map(t=>t.id)") as number[];
    expect(before.length, "need at least two teams to reorder").toBeGreaterThan(1);

    await page.locator(`#page .tm[data-tid="${before[0]}"] [data-menu="teamMenu"]`).click();
    await page.locator('.menu-item:has-text("Move down")').click();

    const after = await page.evaluate("activeTeams().map(t=>t.id)") as number[];
    expect(after[0]).toBe(before[1]);
    expect(after[1]).toBe(before[0]);
    /* Same set, only the order moved. */
    expect([...after].sort()).toEqual([...before].sort());
  });

  test("the ends of the list cannot move past themselves", async ({ page }) => {
    await bootStaff(page, "admin");
    await go(page, "#/media/team");
    await page.evaluate("S.tab.team='structure'; render()");
    const ids = await page.evaluate("activeTeams().map(t=>t.id)") as number[];
    await page.locator(`#page .tm[data-tid="${ids[0]}"] [data-menu="teamMenu"]`).click();
    await expect(page.locator('.menu-item:has-text("Move up")')).toBeDisabled();
    await page.keyboard.press("Escape");
    await page.locator(`#page .tm[data-tid="${ids[ids.length - 1]}"] [data-menu="teamMenu"]`).click();
    await expect(page.locator('.menu-item:has-text("Move down")')).toBeDisabled();
  });

  test("a phone does not advertise a drag it cannot do", async ({ page }) => {
    await bootStaff(page, "admin");
    await go(page, "#/media/team");
    await page.evaluate("S.tab.team='structure'; render()");
    expect(await page.evaluate(() =>
      document.querySelector("#page .tm")?.getAttribute("draggable"))).toBeNull();
    expect(await page.evaluate(() =>
      [...document.querySelectorAll("#page .tm-grip")].some((g) => (g as HTMLElement).offsetParent !== null)))
      .toBe(false);
  });
});

test("on a desktop, teams still reorder by dragging and offer no Move entries", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await bootStaff(page, "admin");
  await go(page, "#/media/team");
  await page.evaluate("S.tab.team='structure'; render()");
  expect(await page.evaluate(() =>
    document.querySelector("#page .tm")?.getAttribute("draggable"))).toBe("true");
  const id = await page.evaluate("activeTeams()[0].id");
  await page.locator(`#page .tm[data-tid="${id}"] [data-menu="teamMenu"]`).click();
  await expect(page.locator('.menu-item:has-text("Move down")')).toHaveCount(0);
});
