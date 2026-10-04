/**
 * ROI-cycle date gate for the top-up merge loop.
 *
 * The implementation now lives in ../_shared/roiCycleDates.ts so the renewal
 * jobs can reuse the exact same date logic. Re-exported here to keep existing
 * imports and unit tests stable.
 */
export {
  kampalaTodayDateOnly,
  effectiveNextRoiDateOnly,
  isPortfolioRoiDue,
  roiCycleKey,
} from "../_shared/roiCycleDates.ts";
