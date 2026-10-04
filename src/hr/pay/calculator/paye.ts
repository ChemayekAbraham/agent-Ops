import type { RuleVersion, TaxBand } from './types';
import { roundAmount } from './index';

export function selectBand(chargeableIncome: number, rule: RuleVersion): TaxBand | null {
  const band = rule.bands.find(
    (b) =>
      chargeableIncome > b.lowerBound &&
      (b.upperBound === null || chargeableIncome <= b.upperBound),
  );
  return band ?? null;
}

export function computePaye(chargeableIncome: number, rule: RuleVersion): number {
  if (chargeableIncome <= 0) return 0;

  const band = selectBand(chargeableIncome, rule);
  if (!band) return 0;

  return roundAmount(
    band.fixedAmount + band.rate * (chargeableIncome - band.lowerBound),
    rule.roundingRule,
  );
}