import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { isEatWeekend, nextLunchWeekdaySlot } from "./lunchWeekdays.ts";

// Fri 6 Nov 2026 00:00 EAT = Thu 5 Nov 21:00 UTC
Deno.test("Friday is followed by Monday", () => {
  const fri = new Date("2026-11-05T21:00:00Z");
  assertEquals(nextLunchWeekdaySlot(fri).toISOString(), "2026-11-08T21:00:00.000Z"); // Mon 9 Nov 00:00 EAT
});

Deno.test("Monday to Thursday advance one day", () => {
  const mon = new Date("2026-11-08T21:00:00Z");
  assertEquals(nextLunchWeekdaySlot(mon).toISOString(), "2026-11-09T21:00:00.000Z");
});

Deno.test("no weekend slot is ever produced", () => {
  let t = new Date("2026-11-01T00:00:00Z");
  for (let i = 0; i < 60; i++) {
    t = nextLunchWeekdaySlot(t);
    assertEquals(isEatWeekend(t), false);
  }
});

Deno.test("Saturday and Sunday 00:00 EAT are weekend", () => {
  assertEquals(isEatWeekend(new Date("2026-11-06T21:00:00Z")), true); // Sat
  assertEquals(isEatWeekend(new Date("2026-11-07T21:00:00Z")), true); // Sun
  assertEquals(isEatWeekend(new Date("2026-11-08T21:00:00Z")), false); // Mon
});

Deno.test("resume after a long pause skips to next weekday, no catch-up", () => {
  // Resumed Sat 7 Nov 10:00 EAT -> Mon 9 Nov 00:00 EAT
  assertEquals(nextLunchWeekdaySlot(new Date("2026-11-07T07:00:00Z")).toISOString(), "2026-11-08T21:00:00.000Z");
});
