import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { selfSupportFeeErrorMessage } from '@/lib/selfSupportFeeMessages';
import type { FunderNewSelectionItem } from '@/components/funder-new/types';

/** Server floor for house support (partner_support_houses raises below it). */
export const HOUSE_MIN_FUNDING = 50_000;

/**
 * What the Supporter can put into support right now: operational float only.
 * Both support RPCs check this figure, never the withdrawable balance, so the
 * pay step must show the same number the server will enforce.
 */
export function useSupportCapacity(userId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ['funder-preview-support-capacity', userId],
    enabled: !!userId && enabled,
    staleTime: 15_000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('funder_support_capacity', { p_user_id: userId! });
      if (error) throw error;
      return Number(data ?? 0);
    },
  });
}

export interface SupportSubmitResult {
  reference: string | null;
}

/**
 * A failed submit. `nothingTaken` is true only when the server answered with
 * an error: every money movement happens inside one RPC transaction, so a
 * rejected call moved nothing. A dropped connection gives no such guarantee.
 */
export class SupportSubmitError extends Error {
  nothingTaken: boolean;
  constructor(message: string, nothingTaken: boolean) {
    super(message);
    this.nothingTaken = nothingTaken;
  }
}

function describeSupportError(raw: string): string {
  const careMsg = selfSupportFeeErrorMessage(raw);
  if (careMsg) return careMsg;
  if (raw.includes('AGREEMENT_REQUIRED')) return 'Sign your partnership agreement first, then try again.';
  if (raw.includes('HOUSES_UNAVAILABLE') || raw.includes('BOOKING_NOT_FOUND'))
    return 'Some homes in your plan are no longer available. Remove them and try again.';
  if (raw.includes('PARTNER_FUNDS_SHORT') || raw.includes('DEPOSIT_DATE_REQUIRED'))
    return 'Your support balance does not cover this plan any more.';
  if (raw.includes('Minimum funding')) return raw.replace(/^.*?(Minimum funding)/, '$1');
  if (raw.includes('Not authorised') || raw.includes('not authorized'))
    return 'This account cannot support homes yet.';
  return raw;
}

interface Submitter {
  fullName: string;
  phone: string;
  email: string;
}

/**
 * Same two paths as the Supporter dashboard's house listings
 * (FunderHouseListingsSection): empty homes are booked on a promissory note and
 * then funded; tenant-ready Rent Plans are claimed and then supported directly.
 * All money movement stays inside the SECURITY DEFINER RPCs.
 */
export async function submitPreviewSupport(
  items: FunderNewSelectionItem[],
  who: Submitter,
): Promise<SupportSubmitResult> {
  const ids = items.map((item) => item.id);
  if (ids.length === 0) throw new SupportSubmitError('Your plan is empty.', true);
  const total = items.reduce((sum, item) => sum + item.amount, 0);
  try {
    if (items[0].category === 'empty') {
      const { data, error } = await supabase.rpc('agent_create_promissory_note_for_houses', {
        p_payload: {
          partner_name: who.fullName.trim(),
          whatsapp_number: who.phone.trim(),
          phone_number: who.phone.trim() || null,
          email: who.email.trim() || null,
          amount: total,
          contribution_type: 'once_off',
        },
        p_house_ids: ids,
      });
      if (error) throw error;
      const note = ((data ?? {}) as { note?: { id: string } }).note;
      if (!note) throw new SupportSubmitError('The booking was not created.', true);
      const { error: fundErr } = await supabase.rpc('funder_fund_booked_houses', {
        p_house_ids: ids,
        p_idempotency_key: `fund-${note.id}`,
      });
      if (fundErr) throw fundErr;
      void supabase.functions.invoke('notify-house-booking', { body: { note_id: note.id } }).catch(() => {});
      return { reference: note.id };
    }

    const { error: claimError } = await supabase.rpc('partner_self_claim_plans', { p_rent_request_ids: ids });
    if (claimError) throw claimError;
    const { data, error } = await supabase.rpc('funder_support_tenant_direct', {
      p_rent_request_ids: ids,
      p_promised_deposit_date: null,
    });
    if (error) throw error;
    const payload = (data ?? {}) as { commitment_id?: string; portfolio_id?: string };
    return { reference: payload.commitment_id ?? payload.portfolio_id ?? null };
  } catch (err) {
    if (err instanceof SupportSubmitError) throw err;
    const e = err as { message?: string; code?: string };
    const answeredByServer = typeof e?.code === 'string' && e.code.length > 0;
    throw new SupportSubmitError(describeSupportError(String(e?.message || 'Support could not be sent.')), answeredByServer);
  }
}
