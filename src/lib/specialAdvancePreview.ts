/**
 * Special Advance — repayment PREVIEW only.
 *
 * Approved rate/term options (user, 2026-10-27):
 *   - rate presets: 1% per day, 15% per month, 28% per month, or an individually agreed custom rate whose basis
 *     (per day / per month) must be chosen explicitly — never assumed;
 *   - terms: 7, 14 or 30 days, or a custom whole number of days.
 *
 * Calculation (approved 2026-10-27 — the fee is never charged as a full month on a short term):
 *   monthly basis: access fee = round(principal × monthly rate × days / 30)   (simple pro-rata, as existing advances;
 *                  this is `calculateAccessFeeSimple`, the same formula `cfo_create_advance` /
 *                  `disburse_agent_advance_request` use)
 *   daily basis:   access fee = round(principal × daily rate × days)          (simple, not compounded)
 *   registration fee  = 10,000 if principal ≤ 200,000, else 20,000          (unchanged, applies to Special Advances)
 *   total repayable   = principal + access fee + registration fee
 *   instalments       = max(1, ceil(term days / period days))   daily 1 · weekly 7 · monthly 30
 *   instalment amount = ceil(total / instalments)
 *
 * Nothing here issues, approves or posts anything. Server-side validation and storage of the agreed terms, and the
 * exemption of Special Advances from the tier rate reset, are pending (see the handoff spec) — until then the server
 * remains the authority.
 *
 * Presentation-only derivations (not stored by the server, labelled "indicative" in the UI):
 *   - due dates: issue day + k × period days (Kampala calendar), the last capped at the term end;
 *   - the final instalment is whatever remains;
 *   - the per-instalment split follows the approved waterfall Late Fee → Access Fee → Registration Fee → Principal,
 *     assuming every instalment is paid in full and on time (so no late fee).
 */
import {
  calculateAccessFeeSimple,
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

/**
 * Preview input bounds. These only stop obviously invalid entries in the browser; the server bounds for custom
 * Special Advance terms are still to be confirmed and enforced server-side (handoff spec).
 */
export const RATE_MAX_PERCENT = 100;
export const TERM_MIN_DAYS = 1;
export const TERM_MAX_DAYS = 365;

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
  if (!Number.isInteger(i.principal) || (i.principal ?? 0) <= 0) errs.push('principal');
  if (!Number.isFinite(i.ratePercent) || (i.ratePercent ?? -1) < 0 || (i.ratePercent ?? 0) > RATE_MAX_PERCENT) errs.push('rate');
  if (i.rateBasis !== 'daily' && i.rateBasis !== 'monthly') errs.push('rateBasis');
  if (!Number.isInteger(i.termDays) || (i.termDays ?? 0) < TERM_MIN_DAYS || (i.termDays ?? 0) > TERM_MAX_DAYS) errs.push('term');
  if (!SPECIAL_ADVANCE_FREQUENCIES.some((f) => f.value === i.frequency)) errs.push('frequency');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(i.issueYmd ?? '')) errs.push('issueDate');
  return errs;
}

/** Access fee for the agreed rate and basis (simple, prorated by days — approved 2026-10-27). */
export function specialAdvanceAccessFee(principal: number, ratePercent: number, rateBasis: RateBasis, termDays: number): number {
  const rate = ratePercent / 100;
  return rateBasis === 'monthly'
    ? calculateAccessFeeSimple(principal, termDays, rate)
    : Math.round(principal * rate * termDays);
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
