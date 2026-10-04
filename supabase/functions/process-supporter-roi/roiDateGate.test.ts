import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  effectiveNextRoiDateOnly,
  isPortfolioRoiDue,
  kampalaTodayDateOnly,
} from "./roiDateGate.ts";

// Anchor "now" so the tests are deterministic regardless of when they run.
// 2026-06-05 09:00 UTC -> Africa/Kampala (UTC+3) is 2026-06-05 12:00, date 2026-06-05.
const NOW = Date.parse("2026-06-05T09:00:00Z");

Deno.test("kampala today is date-only YYYY-MM-DD", () => {
  assertEquals(kampalaTodayDateOnly(NOW), "2026-06-05");
});

Deno.test("stored future next_roi_date is NOT due (the 15 reverted portfolios)", () => {
  // e.g. WPF-1798 future-dated to 2026-06-07 / 2026-07-10
  assertEquals(
    isPortfolioRoiDue(
      { next_roi_date: "2026-06-07", created_at: "2026-05-07T00:00:00Z", payout_day: 7 },
      NOW,
    ),
    false,
  );
  assertEquals(
    isPortfolioRoiDue(
      { next_roi_date: "2026-07-10", created_at: "2026-06-10T00:00:00Z", payout_day: 10 },
      NOW,
    ),
    false,
  );
});

Deno.test("stored past next_roi_date IS due (the 2 genuinely overdue portfolios)", () => {
  // WPF-4065 due 2026-04-12, WIP2603114075 due 2026-05-12
  assertEquals(
    isPortfolioRoiDue(
      { next_roi_date: "2026-04-12", created_at: "2026-03-12T00:00:00Z", payout_day: 12 },
      NOW,
    ),
    true,
  );
  assertEquals(
    isPortfolioRoiDue(
      { next_roi_date: "2026-05-12", created_at: "2026-04-12T00:00:00Z", payout_day: 12 },
      NOW,
    ),
    true,
  );
});

Deno.test("stored next_roi_date exactly today IS due", () => {
  assertEquals(
    isPortfolioRoiDue(
      { next_roi_date: "2026-06-05", created_at: "2026-05-05T00:00:00Z", payout_day: 5 },
      NOW,
    ),
    true,
  );
});

Deno.test("ISO timestamp next_roi_date is truncated to date-only", () => {
  assertEquals(
    effectiveNextRoiDateOnly("2026-06-07T23:30:00.000Z", "2026-05-07T00:00:00Z", 7, NOW),
    "2026-06-07",
  );
});

Deno.test("null next_roi_date derives from created_at + payout_day, walking forward", () => {
  // Created 2026-01-20, payout day 20 -> next future cycle on/after today is 2026-06-20.
  assertEquals(
    effectiveNextRoiDateOnly(null, "2026-01-20T00:00:00Z", 20, NOW),
    "2026-06-20",
  );
  // 2026-06-20 > today 2026-06-05 -> not due yet.
  assertEquals(
    isPortfolioRoiDue({ next_roi_date: null, created_at: "2026-01-20T00:00:00Z", payout_day: 20 }, NOW),
    false,
  );
});

Deno.test("null next_roi_date where derived cycle lands today IS due", () => {
  // Created 2026-05-05, payout day 5 -> first cycle 2026-06-05 == today.
  assertEquals(
    isPortfolioRoiDue({ next_roi_date: null, created_at: "2026-05-05T00:00:00Z", payout_day: 5 }, NOW),
    true,
  );
});

Deno.test("payout_day clamped to 28 to stay month-safe", () => {
  assertEquals(
    effectiveNextRoiDateOnly(null, "2026-01-31T00:00:00Z", 31, NOW),
    "2026-06-28",
  );
});