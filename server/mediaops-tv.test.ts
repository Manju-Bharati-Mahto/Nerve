// @vitest-environment node
/* ═══════════════════════════════════════════════════════════════════════════
   TV OPERATIONS BOARD — the two rules that can lie on a wall.

   Everything else on the board is a COUNT: if the SQL is wrong the number looks
   wrong and somebody says so. These two are different, because both can be
   confidently wrong in a way nobody in the room can check:

     classifyEvent()   — decides whether "LIVE" appears next to an event.
     nerveMinutesNow() — decides what "now" means, in Asia/Kolkata, not UTC.

   A board that misses a live shoot is a nuisance. One that shows LIVE beside a
   shoot that ended at noon is a lie that management acts on, so the failure
   direction matters and is asserted below.
   ═══════════════════════════════════════════════════════════════════════════ */
import { describe, expect, it } from "vitest";
import { classifyEvent, nerveMinutesNow } from "./mediaops-tv.js";

const at = (h: number, m = 0) => h * 60 + m;

describe("classifyEvent — the clock", () => {
  it("is live between call time and end time", () => {
    expect(classifyEvent("confirmed", "09:00", "18:00", at(13, 30))).toBe("live");
  });

  it("is live exactly on both boundaries", () => {
    expect(classifyEvent("confirmed", "09:00", "18:00", at(9))).toBe("live");
    expect(classifyEvent("confirmed", "09:00", "18:00", at(18))).toBe("live");
  });

  it("is upcoming before the call time and completed after the end", () => {
    expect(classifyEvent("planned", "09:00", "18:00", at(8, 59))).toBe("upcoming");
    expect(classifyEvent("planned", "09:00", "18:00", at(18, 1))).toBe("completed");
  });

  it("stays live with no end time once it has started", () => {
    expect(classifyEvent("confirmed", "09:00", null, at(22))).toBe("live");
  });
});

describe("classifyEvent — a person outranks the clock", () => {
  it("reads a shoot marked done as completed even during its window", () => {
    expect(classifyEvent("done", "09:00", "18:00", at(13))).toBe("completed");
  });

  it("reads submitted and reviewed SMC coverage as completed", () => {
    expect(classifyEvent("submitted", "09:00", "18:00", at(13))).toBe("completed");
    expect(classifyEvent("reviewed", "09:00", "18:00", at(13))).toBe("completed");
  });

  it("does not treat in-progress or accepted as terminal", () => {
    expect(classifyEvent("in_progress", "09:00", "18:00", at(13))).toBe("live");
    expect(classifyEvent("accepted", "09:00", "18:00", at(13))).toBe("live");
  });
});

describe("classifyEvent — fails safe on unusable times", () => {
  /* call_time / end_time are TEXT columns. Anything the parser cannot read must
     never become "live": these all assert the safe direction, not a nicety. */
  const junk = [null, undefined, "", "  ", "TBC", "morning", "9am", "25:00", "09:75", "-1:00"];

  it.each(junk)("treats %o as no start time, so never live", (bad) => {
    expect(classifyEvent("confirmed", bad, "18:00", at(13))).toBe("scheduled");
  });

  it.each(junk)("ignores %o as an end time rather than ending the event", (bad) => {
    expect(classifyEvent("confirmed", "09:00", bad, at(13))).toBe("live");
  });

  it("accepts padded and seconds-bearing times the DB may hold", () => {
    expect(classifyEvent("confirmed", " 09:00 ", "18:00:00", at(13))).toBe("live");
    expect(classifyEvent("confirmed", "9:05", "18:00", at(9))).toBe("upcoming");
  });
});

describe("nerveMinutesNow — the application's timezone, not the server's", () => {
  /* The whole codebase treats Asia/Kolkata as the working day (see nerveToday).
     A server in UTC must still report the office wall clock, or every event on
     the board shifts by 5.5 hours. */
  it("reads the wall clock in Asia/Kolkata", () => {
    // 2026-08-25T04:00:00Z is 09:30 in Kolkata (UTC+5:30).
    const t = new Date("2026-08-25T04:00:00.000Z");
    expect(nerveMinutesNow("Asia/Kolkata", t)).toBe(at(9, 30));
  });

  it("differs from UTC by the offset, proving it is not reading the server clock", () => {
    const t = new Date("2026-08-25T04:00:00.000Z");
    expect(nerveMinutesNow("Asia/Kolkata", t) - nerveMinutesNow("UTC", t)).toBe(330);
  });

  it("handles midnight without wrapping to 1440", () => {
    // 18:30Z is 00:00 next day in Kolkata.
    const t = new Date("2026-08-24T18:30:00.000Z");
    expect(nerveMinutesNow("Asia/Kolkata", t)).toBe(0);
  });
});
