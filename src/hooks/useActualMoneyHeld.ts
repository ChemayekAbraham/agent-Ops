import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export interface ActualMoneyHeld {
  /** Live MTN Mobile Money line balance parsed from provider alerts. */
  mtn: number;
  /** Live Airtel Money line balance parsed from provider alerts. */
  airtel: number;
  /** Verified cash deposits collected by agents but not yet banked. */
  cashAtHand: number;
  /** Verified cash deposits explicitly marked as banked by Financial Ops. */
  bankedCash: number;
  /** Email-derived Bayo Mercy account balance (reference/comparison only). */
  bankReconciliation: number;
  /** Sum of MTN + Airtel + cash at hand + banked cash. */
  total: number;
}

/**
 * Real money the platform holds right now, mirroring the "Actual Float"
 * bucket on the Financial Ops Wallet Buckets page.
 *
 * Banked cash is the verified deposit total where Financial Ops set
 * `purpose_audit.cash_location = 'bank'`, i.e. the real cash at bank.
 * The email-derived bank reconciliation is kept as a separate reference figure
 * and is never added to the headline.
 */
export function useActualMoneyHeld(enabled = true) {
  return useQuery({
    queryKey: ['cfo-actual-money-held'],
    enabled,
    staleTime: 15_000,
    refetchInterval: 30_000,
    queryFn: async (): Promise<ActualMoneyHeld> => {
      const [phoneRes, cashRes, bankRes] = await Promise.all([
        supabase.rpc('get_phone_platform_reconciliation' as any),
        supabase.rpc('get_cash_at_hand_total' as any),
        supabase.rpc('get_money_at_bank_reconciliation' as any),
      ]);
      if (phoneRes.error) throw phoneRes.error;
      if (cashRes.error) throw cashRes.error;
      if (bankRes.error) throw bankRes.error;

      const p = (phoneRes.data ?? {}) as any;
      const c = (cashRes.data ?? {}) as any;
      const b = (bankRes.data ?? {}) as any;

      const mtn = Number(p.mtn_balance ?? 0);
      const airtel = Number(p.airtel_balance ?? 0);
      const cashAtHand = Number(c.cash_at_hand_total ?? 0);
      const bankedCash = Number(b.banked_cash_reference ?? 0);
      const bankReconciliation = Number(b.money_at_bank_total ?? 0);

      return {
        mtn,
        airtel,
        cashAtHand,
        bankedCash,
        bankReconciliation,
        total: mtn + airtel + cashAtHand + bankedCash,
      };
    },
  });
}
