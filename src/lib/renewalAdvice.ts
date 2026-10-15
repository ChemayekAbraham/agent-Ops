// Types and small pure helpers for renewing a Rent Plan at a different rent and/or number of days.
//
// The advice, the fees, the total and the daily payment all come from the server (get_renewal_advice,
// preview_renewal_amount, renew_rent_request). Nothing here computes them: the only arithmetic is the
// difference between two figures the server already returned, shown to the agent as "Above suggestion by UGX X (N%)".

export interface RenewalAdvice {
  prev_request_id: string;
  current_days: number;
  chosen_days: number;
  allowed_days: number[];
  current_rent: number;
  on_time_pct: number | null;
  fully_repaid: boolean;
  longest_missed_streak: number;
  band: string;
  suggested_step_pct: number;
  avg_daily_paid: number;
  affordability_rent: number;
  access_limit: number;
  suggested_max_rent: number;
  reasons: string[];
  computed_at: string;
}

export interface RenewalPreview {
  prev_request_id: string;
  current_rent: number;
  current_days: number;
  new_rent: number;
  new_days: number;
  access_fee: number;
  request_fee: number;
  total_repayment: number;
  daily_repayment: number;
  repayment_frequency: 'daily' | 'weekly';
  changed: boolean;
  explanation_required: boolean;
  min_explanation_length: number;
  reason_codes: RenewalReasonCode[];
}

export type RenewalReasonCode = 'landlord_raised' | 'moved_house' | 'tenant_requested_lower' | 'other';

export const RENEWAL_REASONS: ReadonlyArray<{ code: RenewalReasonCode; label: string }> = [
  { code: 'landlord_raised', label: 'Landlord raised rent' },
  { code: 'moved_house', label: 'Moved house' },
  { code: 'tenant_requested_lower', label: 'Tenant asked for less' },
  { code: 'other', label: 'Other' },
];

export const RENEWAL_REASON_LABEL: Record<RenewalReasonCode, string> = Object.fromEntries(
  RENEWAL_REASONS.map((r) => [r.code, r.label]),
) as Record<RenewalReasonCode, string>;

/** Shown when the server's own minimum is not known yet; the server value (rent_renewal_advice_params) wins once the preview loads. */
export const DEFAULT_MIN_EXPLANATION = 10;

/** What the agent chose, and what is sent to renew_rent_request. */
export interface RenewalChoice {
  newRent: number;
  newDays: number;
  /** from the last server preview, shown again to the tenant with their code */
  dailyRepayment: number;
  totalRepayment: number;
  changed: boolean;
  reasonCode: RenewalReasonCode | null;
  explanation: string;
  evidenceUrl: string | null;
}

export type RenewalHintKind = 'lower' | 'within' | 'above';

export interface RenewalHint {
  kind: RenewalHintKind;
  /** UGX above the server's suggested maximum (0 unless kind is "above") */
  aboveBy: number;
  /** that amount as a whole percent of the suggested maximum (0 unless kind is "above") */
  abovePct: number;
}

/**
 * Compares the rent the agent typed with the two figures the server returned. Lower than the current rent is "lower";
 * otherwise at or under the suggested maximum is "within", and anything above it is "above". Never blocks anything.
 */
export function renewalHint(newRent: number, currentRent: number, suggestedMax: number): RenewalHint {
  if (newRent < currentRent) return { kind: 'lower', aboveBy: 0, abovePct: 0 };
  if (newRent > suggestedMax) {
    const aboveBy = newRent - suggestedMax;
    return { kind: 'above', aboveBy, abovePct: suggestedMax > 0 ? Math.round((aboveBy / suggestedMax) * 100) : 0 };
  }
  return { kind: 'within', aboveBy: 0, abovePct: 0 };
}

/** Whole percent change from the old rent to the new one, for the reviewer's "old -> new" line. Signed. */
export function percentChange(oldValue: number, newValue: number): number {
  if (!(oldValue > 0)) return 0;
  return Math.round(((newValue - oldValue) / oldValue) * 100);
}

export function renewalChanged(newRent: number, newDays: number, currentRent: number, currentDays: number): boolean {
  return newRent !== currentRent || newDays !== currentDays;
}

/** Why a "Continue" tap is stopped, in words, or null when the choice is complete. */
export function renewalChoiceProblem(c: {
  newRent: number;
  newDays: number | null;
  changed: boolean;
  reasonCode: RenewalReasonCode | null;
  explanation: string;
  minExplanation: number;
}): string | null {
  if (!Number.isFinite(c.newRent) || c.newRent <= 0) return 'Enter a new rent above UGX 0.';
  if (c.newDays === null) return 'Choose the number of days.';
  if (c.changed) {
    if (!c.reasonCode) return 'Pick a reason for the change.';
    if (c.explanation.trim().length < c.minExplanation) {
      return `Explain the change in at least ${c.minExplanation} characters so reviewers understand it.`;
    }
  }
  return null;
}

/** Arguments for supabase.rpc('renew_rent_request', ...). An unchanged renewal sends only the previous plan (and GPS), exactly as before. */
export function renewRpcArgs(
  prevRequestId: string,
  choice: RenewalChoice | null,
  gps?: { latitude: number; longitude: number },
) {
  return {
    p_prev_request_id: prevRequestId,
    ...(gps ? { p_latitude: gps.latitude, p_longitude: gps.longitude } : {}),
    ...(choice
      ? {
          p_new_rent_amount: choice.newRent,
          p_new_days: choice.newDays,
          ...(choice.changed
            ? {
                p_change_reason_code: choice.reasonCode,
                p_change_explanation: choice.explanation.trim(),
                ...(choice.evidenceUrl ? { p_evidence_url: choice.evidenceUrl } : {}),
              }
            : {}),
        }
      : {}),
  };
}

/** One plain line for an error from the renewal functions or the code (OTP) function. Never empty. */
export function renewalErrorMessage(raw: unknown, minExplanation = DEFAULT_MIN_EXPLANATION): string {
  const text = String((raw as { message?: string } | null)?.message ?? raw ?? '').trim();
  const has = (code: string) => text.includes(code);
  if (has('RENEWAL_EXPLANATION_REQUIRED')) {
    return `Pick a reason and explain the change in at least ${minExplanation} characters.`;
  }
  if (has('RENEWAL_DAYS_NOT_ALLOWED')) return 'That number of days is not offered. Choose one from the list.';
  if (has('RENEWAL_AMOUNT_INVALID')) return 'Enter a new rent above UGX 0.';
  if (has('RENEWAL_OTP_MISMATCH')) {
    return 'The tenant confirmed a different rent or number of days. Ask them to confirm this renewal with a new code.';
  }
  if (has('RENEWAL_OTP_REQUIRED')) return 'The tenant must confirm this renewal with the code sent to their phone.';
  if (has('NOT_YOUR_REQUEST')) return 'This tenant is handled by another agent. Ask Agent Ops to transfer them to you first.';
  if (has('PLAN_NOT_COMPLETED')) return 'Only a completed Rent Plan can be renewed.';
  if (has('PREVIOUS_REQUEST_NOT_FOUND')) return 'The previous Rent Plan could not be found.';
  if (has('NOT_AUTHENTICATED')) return 'Your session expired. Sign in again and retry.';
  if (has('NOTE_TOO_SHORT')) return 'A note needs at least 10 characters.';
  if (has('NOT_A_REVIEWER')) return 'Only reviewers can add a note to a request.';
  if (has('DAILY_ELIGIBILITY_BLOCKED')) {
    return 'Collect from your existing tenants first. You must reach 50% of your daily target before posting a new rent request.';
  }
  if (has('RENT_REQUEST_GPS_OUT_OF_RANGE')) return 'The captured location is not inside Uganda. Capture it again at the house.';
  // the code function already answers in plain words ("Wrong code. ...", "The code expired. ...")
  const first = text.split('\n')[0].replace(/^[A-Z_]{4,}:\s*/, '').trim();
  return first || 'Something went wrong. Please try again.';
}

/** Parses what the agent typed into the rent box ("1,200,000" or "1200000") into a whole number, or NaN. */
export function parseRentInput(raw: string): number {
  const digits = raw.replace(/[^\d]/g, '');
  return digits === '' ? NaN : Number(digits);
}
