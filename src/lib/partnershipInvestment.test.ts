import { describe, it, expect } from "vitest";
import {
  MIN_INVEST,
  MAX_INVEST,
  effectiveMaxInvest,
  investBounds,
  isInvestAmountValid,
  investHelperRange,
  defaultUGXFormatter,
} from "./partnershipInvestment";

describe("partnership investment limits", () => {
  it("uses UGX 1,000 minimum and UGX 500,000,000 maximum", () => {
    expect(MIN_INVEST).toBe(1000);
    expect(MAX_INVEST).toBe(500_000_000);
  });

  describe("effectiveMaxInvest", () => {
    it("returns the absolute max when there is no balance cap", () => {
      expect(effectiveMaxInvest()).toBe(MAX_INVEST);
      expect(effectiveMaxInvest(null)).toBe(MAX_INVEST);
      expect(effectiveMaxInvest(undefined)).toBe(MAX_INVEST);
      expect(effectiveMaxInvest(NaN)).toBe(MAX_INVEST);
      expect(effectiveMaxInvest(Infinity)).toBe(MAX_INVEST);
    });

    it("caps to the balance when it is below the absolute max", () => {
      expect(effectiveMaxInvest(250_000)).toBe(250_000);
      expect(effectiveMaxInvest(1000)).toBe(1000);
    });

    it("never exceeds the absolute max", () => {
      expect(effectiveMaxInvest(900_000_000)).toBe(MAX_INVEST);
    });

    it("clamps negative balances to 0", () => {
      expect(effectiveMaxInvest(-500)).toBe(0);
    });
  });

  describe("isInvestAmountValid", () => {
    it("rejects amounts below the minimum", () => {
      expect(isInvestAmountValid(999)).toBe(false);
      expect(isInvestAmountValid(0)).toBe(false);
      expect(isInvestAmountValid(-1)).toBe(false);
    });

    it("accepts amounts within the absolute range", () => {
      expect(isInvestAmountValid(MIN_INVEST)).toBe(true);
      expect(isInvestAmountValid(50_000)).toBe(true);
      expect(isInvestAmountValid(MAX_INVEST)).toBe(true);
    });

    it("rejects amounts above the absolute maximum", () => {
      expect(isInvestAmountValid(MAX_INVEST + 1)).toBe(false);
    });

    it("respects a balance cap", () => {
      expect(isInvestAmountValid(100_000, 100_000)).toBe(true);
      expect(isInvestAmountValid(100_001, 100_000)).toBe(false);
    });

    it("rejects non-finite amounts", () => {
      expect(isInvestAmountValid(NaN)).toBe(false);
      expect(isInvestAmountValid(Infinity)).toBe(false);
    });
  });

  describe("investHelperRange", () => {
    it("renders the absolute UGX range with no cap", () => {
      expect(investHelperRange()).toBe(
        "Allowed range: UGX 1,000 – UGX 500,000,000. Amounts outside this range will disable submission.",
      );
    });

    it("renders a capped max when a balance is provided", () => {
      expect(investHelperRange(250_000)).toBe(
        "Allowed range: UGX 1,000 – UGX 250,000. Amounts outside this range will disable submission.",
      );
    });

    it("accepts a custom formatter", () => {
      const raw = (n: number) => String(n);
      expect(investHelperRange(undefined, raw)).toContain("1000");
      expect(investHelperRange(undefined, raw)).toContain("500000000");
    });
  });

  // The core invariant: the numbers shown in the helper text are EXACTLY the
  // boundaries at which validation flips. This is what keeps the displayed
  // range and the validation "perfectly in sync" across every dialog.
  describe("helper range stays perfectly in sync with validation", () => {
    const caps: (number | null | undefined)[] = [
      undefined,
      null,
      1000,
      50_000,
      250_000,
      MAX_INVEST,
      900_000_000, // above absolute max → should clamp to MAX_INVEST
    ];

    it.each(caps)("range endpoints match validity flips for cap=%s", (cap) => {
      // Extract the numeric endpoints straight from the displayed helper text.
      const text = investHelperRange(cap, (n) => String(n));
      const match = text.match(/Allowed range: (\d+) – (\d+)\./);
      expect(match).not.toBeNull();
      const shownMin = Number(match![1]);
      const shownMax = Number(match![2]);

      // Endpoints must equal the canonical bounds.
      const { min, max } = investBounds(cap);
      expect(shownMin).toBe(min);
      expect(shownMax).toBe(max);

      // Displayed min: invalid just below, valid at the value.
      expect(isInvestAmountValid(shownMin - 1, cap)).toBe(false);
      expect(isInvestAmountValid(shownMin, cap)).toBe(true);

      // Displayed max: valid at the value, invalid just above.
      expect(isInvestAmountValid(shownMax, cap)).toBe(true);
      expect(isInvestAmountValid(shownMax + 1, cap)).toBe(false);
    });
  });

  describe("defaultUGXFormatter", () => {
    it("formats with the UGX prefix and grouped thousands", () => {
      expect(defaultUGXFormatter(1000)).toBe("UGX 1,000");
      expect(defaultUGXFormatter(500_000_000)).toBe("UGX 500,000,000");
    });
  });
});
