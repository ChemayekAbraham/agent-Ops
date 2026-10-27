/**
 * Special Advance — repayment PREVIEW. Mirrors the authoritative server engine
 * `_special_advance_schedule` (supabase/migrations/20261028150000_special_advances_calc_engine.sql) exactly; the
 * server recalculates everything and never trusts these figures. Parity is tested on thousands of random agreements
 * (src/test/specialAdvanceServerEngine.test.ts).
 *
 * Approved options (CFO, 2026-10-27):
 *   - rate presets: 1% per day, 15% per month, 28% per month, or an individually agreed custom rate whose basis
 *     (per day / per month) must be chosen explicitly — never assumed. Custom: > 0 and at most 1% per day or 28% per
 *     month; 0% is not permitted; at most 2 decimal places;
 *   - terms: 7, 14 or 30 days, or a custom whole number of days from 1 to 90;
 *   - principal: whole UGX, at least 10,000;
 *   - the term and due dates run from the PAYOUT date (`issueYmd`), not the approval date; monthly = every 30 days.
 *
 * Calculation (the fee is never charged as a full month on a short term; exact integer arithmetic, half up):
 *   monthly basis: access fee = round(principal × monthly rate × days / 30)   (simple pro-rata, as existing advances)
 *   daily basis:   access fee = round(principal × daily rate × days)          (simple, not compounded)
 *   registration fee  = 10,000 if principal ≤ 200,000, else 20,000          (unchanged, applies to Special Advances)
 *   total repayable   = principal + access fee + registration fee
 *   instalments       = max(1, ceil(term days / period days))   daily 1 · weekly 7 · monthly 30
 *   instalment amount = ceil(total / instalments); the final instalment is whatever remains
 *   due dates         = payout day + min(k × period days, term) (Kampala calendar)
 *   split             = Late Fee → Access Fee → Registration Fee → Principal, assuming on-time payment (no late fee)
 *
 * Nothing here issues, approves or posts anything.
 */
import {
  calculateRegistrationFee,
  installmentCount,
  periodDays,
  type RepaymentFrequency,
} from '@/lib/agentAdvanceCalculations';
import { shiftKampalaDays } from '@/lib/kampalaDays';

/** Repayment frequencies offered for Special Advances (the server also accepts bi-weekly; not offered here). */
export const SPECIAL_ADVANCE_FREQUENCIES = [
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
] as const satisfies ReadonlyArray<{ value: RepaymentFrequency; label: string }>;
export type SpecialAdvanceFrequency = (typeof SPECIAL_ADVANCE_FREQUENCIES)[number]['value'];

/** The period a rate is quoted over. */
export type RateBasis = 'daily' | 'monthly';
export const RATE_BASIS_LABEL: Record<RateBasis, string> = { daily: 'per day', monthly: 'per month' };

/** Approved rate presets. A custom rate needs an explicit basis and value. */
export const SPECIAL_ADVANCE_RATE_PRESETS = [
  { id: 'daily-1', basis: 'daily', ratePercent: 1 },
  { id: 'monthly-15', basis: 'monthly', ratePercent: 15 },
  { id: 'monthly-28', basis: 'monthly', ratePercent: 28 },
] as const satisfies ReadonlyArray<{ id: string; basis: RateBasis; ratePercent: number }>;

/** Approved term presets (days). A custom whole number of days is also allowed. */
export const SPECIAL_ADVANCE_TERMS = [7, 14, 30] as const;

/** Limits (CFO 2026-10-27), identical to `_special_advance_term_errors` on the server. */
export const RATE_MAX_BY_BASIS: Record<RateBasis, number> = { daily: 1, monthly: 28 };
/** Highest rate on any basis (input guard only; the per-basis limit above is the rule). */
export const RATE_MAX_PERCENT = 28;
export const TERM_MIN_DAYS = 1;
export const TERM_MAX_DAYS = 90;
export const PRINCIPAL_MIN = 10_000;
/** Technical overflow bound only, not a policy limit. */
export const PRINCIPAL_MAX = 1_000_000_000_000;

/** Rate in hundredths of a percent (28% → 2800), or null when it has more than 2 decimal places. */
function rateHundredths(ratePercent: number): number | null {
  const h = Math.round(ratePercent * 100);
  return Math.abs(ratePercent * 100 - h) < 1e-9 ? h : null;
}

/** round(numerator / denominator), half up, for non-negative integers, exactly (no floating point). */
function roundDiv(numerator: bigint, denominator: bigint): number {
  return Number((2n * numerator + denominator) / (2n * denominator));
}

export interface SpecialAdvanceInput {
  principal: number;
  ratePercent: number;
  rateBasis: RateBasis;
  termDays: number;
  frequency: SpecialAdvanceFrequency;
  /** Kampala YYYY-MM-DD the advance would be issued. */
  issueYmd: string;
}

export interface ScheduledInstalment {
  number: number;
  dueYmd: string;
  amount: number;
  accessFee: number;
  registrationFee: number;
  principal: number;
  balanceAfter: number;
}

export interface SpecialAdvancePreview {
  principal: number;
  ratePercent: number;
  rateBasis: RateBasis;
  termDays: number;
  frequency: SpecialAdvanceFrequency;
  accessFee: number;
  registrationFee: number;
  totalRepayable: number;
  instalments: number;
  instalmentAmount: number;
  finalInstalmentAmount: number;
  firstDueYmd: string;
  finalDueYmd: string;
  schedule: ScheduledInstalment[];
}

export type SpecialAdvanceInputError = 'principal' | 'rate' | 'rateBasis' | 'term' | 'frequency' | 'issueDate';

export function validateSpecialAdvanceInput(i: Partial<SpecialAdvanceInput>): SpecialAdvanceInputError[] {
  const errs: SpecialAdvanceInputError[] = [];
  const p = i.principal;
  if (typeof p !== 'number' || !Number.isInteger(p) || p < PRINCIPAL_MIN || p > PRINCIPAL_MAX) errs.push('principal');
  const r = i.ratePercent;
  const maxRate = i.rateBasis === 'daily' ? RATE_MAX_BY_BASIS.daily : RATE_MAX_BY_BASIS.monthly;
  if (typeof r !== 'number' || !Number.isFinite(r) || r <= 0 || r > maxRate || rateHundredths(r) === null) errs.push('rate');
  if (i.rateBasis !== 'daily' && i.rateBasis !== 'monthly') errs.push('rateBasis');
  const d = i.termDays;
  if (typeof d !== 'number' || !Number.isInteger(d) || d < TERM_MIN_DAYS || d > TERM_MAX_DAYS) errs.push('term');
  if (!SPECIAL_ADVANCE_FREQUENCIES.some((f) => f.value === i.frequency)) errs.push('frequency');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(i.issueYmd ?? '')) errs.push('issueDate');
  return errs;
}

/** Access fee for the agreed rate and basis (simple, prorated by days, exact half-up rounding to whole UGX). */
export function specialAdvanceAccessFee(principal: number, ratePercent: number, rateBasis: RateBasis, termDays: number): number {
  const h = rateHundredths(ratePercent) ?? Math.round(ratePercent * 100);
  const numerator = BigInt(principal) * BigInt(h) * BigInt(termDays);
  return roundDiv(numerator, rateBasis === 'monthly' ? 300_000n : 10_000n);
}

/** Human label for an agreed rate, e.g. "28% per month". */
export function rateLabel(ratePercent: number, rateBasis: RateBasis): string {
  return `${ratePercent}% ${RATE_BASIS_LABEL[rateBasis]}`;
}

/** Repayment preview for a Special Advance. Returns null when the input is invalid. */
export function previewSpecialAdvance(input: SpecialAdvanceInput): SpecialAdvancePreview | null {
  if (validateSpecialAdvanceInput(input).length > 0) return null;
  const { principal, ratePercent, rateBasis, termDays, frequency, issueYmd } = input;

  const accessFee = specialAdvanceAccessFee(principal, ratePercent, rateBasis, termDays);
  const registrationFee = calculateRegistrationFee(principal);
  const totalRepayable = principal + accessFee + registrationFee;
  const instalments = installmentCount(termDays, frequency);
  const instalmentAmount = Math.ceil(totalRepayable / instalments);
  const step = periodDays(frequency);

  // Waterfall buckets (no late fee on an on-time schedule).
  let accessLeft = accessFee;
  let regLeft = registrationFee;
  let principalLeft = principal;
  let remaining = totalRepayable;

  const schedule: ScheduledInstalment[] = [];
  for (let n = 1; n <= instalments && remaining > 0; n++) {
    const amount = n === instalments ? remaining : Math.min(instalmentAmount, remaining);
    let left = amount;
    const toAccess = Math.min(left, accessLeft); left -= toAccess; accessLeft -= toAccess;
    const toReg = Math.min(left, regLeft); left -= toReg; regLeft -= toReg;
    const toPrincipal = Math.min(left, principalLeft); principalLeft -= toPrincipal;
    remaining -= amount;
    schedule.push({
      number: n,
      dueYmd: shiftKampalaDays(issueYmd, Math.min(n * step, termDays)),
      amount,
      accessFee: toAccess,
      registrationFee: toReg,
      principal: toPrincipal,
      balanceAfter: remaining,
    });
  }

  return {
    principal,
    ratePercent,
    rateBasis,
    termDays,
    frequency,
    accessFee,
    registrationFee,
    totalRepayable,
    instalments,
    instalmentAmount,
    finalInstalmentAmount: schedule[schedule.length - 1]?.amount ?? 0,
    firstDueYmd: schedule[0]?.dueYmd ?? issueYmd,
    finalDueYmd: schedule[schedule.length - 1]?.dueYmd ?? issueYmd,
    schedule,
  };
}
