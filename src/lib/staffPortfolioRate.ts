// Staff portfolio forms: what a create request says about the Returns rate (design v2 §6.1, staff
// form contract; server side §3.1.0). The database gate decides the stored rate; a form only says
// whether staff TYPED one, and which switch state the screen saw.
import { typedRate } from './partnerReturnPolicy';

export interface StaffRateRequestInput {
  /** The rate field's current text. */
  value: string | number | null | undefined;
  /** Staff changed the field themselves (not the prefill). */
  edited: boolean;
  /** usePartnerReturnPolicy({ fresh: true }).enabled */
  policyEnabled: boolean | null;
  /** usePartnerReturnPolicy({ fresh: true }).fromNetwork */
  policyFromNetwork: boolean;
}

export type StaffRateRequestFields = { roi_percentage?: number; policy_enabled_seen: boolean };

/**
 * The rate fields of a create request, or an error for an invalid typed rate.
 *  * Switch seen OFF on a fresh network read: send the field as today (prefilled or typed); blank
 *    sends nothing (the gate stores the public rate).
 *  * Switch on or unknown: send roi_percentage only when staff edited the field (a different rate
 *    then waits for the CFO); otherwise the gate stores the person's own rate.
 *  * Always policy_enabled_seen = (enabled === true): the server refuses a typed rate with 409
 *    POLICY_CHANGED when the screen did not see the switch on and it is on (or unreadable).
 */
export function staffRateRequestFields(input: StaffRateRequestInput): { fields: StaffRateRequestFields } | { error: string } {
  const policy_enabled_seen = input.policyEnabled === true;
  const switchOffSeen = input.policyFromNetwork && input.policyEnabled === false;
  const sends = switchOffSeen || input.edited;
  if (!sends) return { fields: { policy_enabled_seen } };
  const t = typedRate(typeof input.value === 'string' ? input.value.trim() : input.value);
  if (t === 'invalid') return { error: 'Monthly Returns rate must be above 0% and at most 100%' };
  return { fields: t === null ? { policy_enabled_seen } : { roi_percentage: t, policy_enabled_seen } };
}

export const POLICY_LOADING_MESSAGE = 'The Returns rate is still loading. Try again in a moment.';
export const POLICY_UNKNOWN_MESSAGE = 'The Returns rate could not be checked. Reload the page.';

/** The parts of useStaffPortfolioRate() that decide whether a create form may submit. */
export interface StaffRateSubmitState {
  isLoading: boolean;
  /** true = on, false = off, null = unknown (this mount's own policy read failed or has not run). */
  policyEnabled: boolean | null;
  edited: boolean;
}

/**
 * Why a staff create form must not submit yet, or null when it may.
 *  * The form's own policy read is still running -> wait (POLICY_LOADING_MESSAGE).
 *  * The read finished but the switch state is unknown (it failed) and staff did not type a rate ->
 *    refuse (POLICY_UNKNOWN_MESSAGE). Sending nothing would let the gate store the public rate,
 *    while with the switch actually off today's form sends its own prefill (20 or 15).
 *  * A typed rate may go: the server refuses it with 409 POLICY_CHANGED unless the switch is off.
 */
export function staffRateSubmitBlock(rate: StaffRateSubmitState): string | null {
  if (rate.isLoading) return POLICY_LOADING_MESSAGE;
  if (rate.policyEnabled === null && !rate.edited) return POLICY_UNKNOWN_MESSAGE;
  return null;
}

export const POLICY_CHANGED_MESSAGE ='The Returns policy changed. Reload the page and check the rate.';

/**
 * True when a supabase.functions.invoke error is the server's 409 POLICY_CHANGED answer. Reads the
 * response body (a Response body can be read once: pass the error here before reading it elsewhere).
 */
export async function isPolicyChangedError(error: unknown): Promise<boolean> {
  const ctx = (error as { context?: { status?: number; clone?: () => Response; json?: () => Promise<unknown> } } | null)?.context;
  if (!ctx || ctx.status !== 409) return false;
  try {
    const res = typeof ctx.clone === 'function' ? ctx.clone() : null;
    const body = (res ? await res.json() : await ctx.json?.()) as { code?: unknown } | null;
    return body?.code === 'POLICY_CHANGED';
  } catch {
    return false;
  }
}
