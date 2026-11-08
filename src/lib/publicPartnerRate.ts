import { supabase } from '@/integrations/supabase/client';
import { parsePublicPolicy } from '@/lib/partnerReturnPolicy';

/**
 * The public new-partner Returns rate for code that runs outside React (the in-app Nexa hooks
 * build their guide replies in the browser, design v2 §3.5.9). One get_partner_return_policy RPC
 * per page load, shared by every caller; null on any error or a malformed answer (the replies then
 * carry no figure). A failure is not remembered, so a later call can try again.
 */
let inFlight: Promise<number | null> | null = null;

export function getPublicPartnerRate(): Promise<number | null> {
  if (!inFlight) {
    inFlight = (async () => {
      try {
        const { data, error } = await (supabase.rpc as unknown as (fn: string) => Promise<{ data: unknown; error: unknown }>)(
          'get_partner_return_policy',
        );
        if (error) return null;
        return parsePublicPolicy(data)?.newContractRate ?? null;
      } catch {
        return null;
      }
    })();
    void inFlight.then((rate) => {
      if (rate === null) inFlight = null;
    });
  }
  return inFlight;
}

export function _resetPublicPartnerRateForTests(): void {
  inFlight = null;
}
