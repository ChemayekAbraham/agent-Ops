import type { RuleVersion } from './types';
import { roundAmount } from './index';

export function computeNssfEmployee(nssfableGross: number, rule: RuleVersion): number {
  return roundAmount(nssfableGross * rule.nssfEmployeeRate, rule.roundingRule);
}

export function computeNssfEmployer(nssfableGross: number, rule: RuleVersion): number {
  return roundAmount(nssfableGross * rule.nssfEmployerRate, rule.roundingRule);
}