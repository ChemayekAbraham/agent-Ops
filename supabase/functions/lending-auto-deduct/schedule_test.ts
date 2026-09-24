import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  firstDeductionDate,
  overdueAmount,
  scheduledDatesThrough,
  unpaidScheduledDates,
} from "./schedule.ts";

Deno.test("daily arrears remain due after a missed day", () => {
  const dates = scheduledDatesThrough("2026-09-20", "2026-09-24", "2026-09-30", "daily");
  assertEquals(dates, ["2026-09-20", "2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24"]);
  assertEquals(unpaidScheduledDates(dates, 100, 150, 500), ["2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24"]);
  assertEquals(overdueAmount(dates.length, 100, 150, 500), 350);
});

Deno.test("weekly, monthly and one-time schedules use their original anchor", () => {
  assertEquals(firstDeductionDate("2026-09-01T12:00:00Z", "2026-10-01", "weekly"), "2026-09-08");
  assertEquals(firstDeductionDate("2026-09-01T12:00:00Z", "2026-10-01", "monthly"), "2026-10-01");
  assertEquals(firstDeductionDate("2026-09-01T12:00:00Z", "2026-10-01", "once"), "2026-10-01");
});

Deno.test("contract end prevents invented future installments", () => {
  assertEquals(
    scheduledDatesThrough("2026-09-20", "2026-09-30", "2026-09-22", "daily"),
    ["2026-09-20", "2026-09-21", "2026-09-22"],
  );
});