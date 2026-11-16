/**
 * Landlord referral codes (E107). A landlord shares a link with ?ref=CODE; the code is
 * "L" + 8 letters/numbers. The tenant self-apply flow and the agent rent request form
 * take it as an optional field, prefilled from the link, and record it after the rent
 * request exists with landlord_referral_record. A code that is wrong or unknown never
 * blocks the request.
 *
 * `?ref=` is also used for agent invite links (an agent's user id, a UUID). Only a value
 * shaped like a landlord code is read as one, so both kinds of link keep working.
 */
import { supabase } from '@/integrations/supabase/client';

type UntypedRpc = (fn: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: { message?: string } | null }>;
const rpc: UntypedRpc = (fn, args) => (supabase.rpc as unknown as UntypedRpc).call(supabase, fn, args);

export const LANDLORD_REFERRAL_RE = /^L[A-Z0-9]{8}$/;
export const LANDLORD_CODE_UNKNOWN = 'Code not recognised';

/** Upper-case, without spaces or dashes: " l1a2-b3c4d " → "L1A2B3C4D". Max 9 characters. */
export const normalizeLandlordCode = (v: string): string => (v || '').toUpperCase().replace(/[\s-]/g, '').slice(0, 9);

export const isLandlordReferralCode = (v: string | null | undefined): boolean =>
  LANDLORD_REFERRAL_RE.test(normalizeLandlordCode(v ?? ''));

/** The landlord code in a link's query string (?ref=CODE), or '' when ref is something else. */
export function landlordCodeFromSearch(search: string): string {
  const ref = new URLSearchParams(search || '').get('ref') ?? '';
  return isLandlordReferralCode(ref) ? normalizeLandlordCode(ref) : '';
}

export type LandlordReferralOutcome = { ok: true } | { ok: false; message: string };

/**
 * Records the code on a rent request that already exists. Never throws. Returns null when
 * there was no code. An unknown code comes back as "Code not recognised"; any other
 * refusal as the server wrote it. The request itself is never affected.
 */
export async function recordLandlordReferral(requestId: string, code: string): Promise<LandlordReferralOutcome | null> {
  const c = normalizeLandlordCode(code);
  if (!c || !requestId) return null;
  try {
    const { data, error } = await rpc('landlord_referral_record', { p_rent_request_id: requestId, p_code: c });
    if (error) return { ok: false, message: error.message || LANDLORD_CODE_UNKNOWN };
    const r = (data && typeof data === 'object' ? data : {}) as { ok?: boolean; reason?: string; message?: string };
    if (r.ok === false) {
      if (r.reason === 'unknown_code') return { ok: false, message: LANDLORD_CODE_UNKNOWN };
      return { ok: false, message: r.message || r.reason || LANDLORD_CODE_UNKNOWN };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e instanceof Error && e.message ? e.message : LANDLORD_CODE_UNKNOWN };
  }
}
