import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

/**
 * Actual money the company physically holds right now — the exact same figures
 * the Financial Ops "Wallet Buckets" page shows as bucket 5 (Actual Float /
 * Money We Hold), so the CFO card and Financial Ops can never disagree.
 *
 * Read-only: three existing reporting RPCs, no ledger or wallet writes.
 *   • get_phone_platform_reconciliation → MTN + Airtel line balances
 *   • get_cash_at_hand_total            → verified cash not yet banked
 *   • get_money_at_bank_reconciliation  → bank balance + cash marked as banked
 */
export interface ActualMoneyHeld {
  mtn: number;
  airtel: number;
  cash: number;
  bank: number;
  /** Real cash at bank = every verified cash deposit Financial Ops marked as banked. */
  bankedCash: number;
  bankedCashCount: number;
  /** Ledger-derived bank reconciliation figure (reference/comparison only). */
  bankLedger: number;
  bankReceived: number;
  bankSent: number;
  total: number;
  computedAt: string;
}

export function useActualMoneyHeld() {
  return useQuery({
    queryKey: ['cfo-actual-money-held'],
    queryFn: async (): Promise<ActualMoneyHeld> => {
      const [phoneRes, cashRes, bankRes] = await Promise.all([
        supabase.rpc('get_phone_platform_reconciliation' as any),
        supabase.rpc('get_cash_at_hand_total' as any),
        supabase.rpc('get_money_at_bank_reconciliation' as any),
      ]);
      if (phoneRes.error) throw phoneRes.error;
      if (bankRes.error) throw bankRes.error;

      const p = (phoneRes.data ?? {}) as any;
      const c = (cashRes.data ?? {}) as any;
      const b = (bankRes.data ?? {}) as any;

      const mtn = Number(p.mtn_balance ?? 0);
      const airtel = Number(p.airtel_balance ?? 0);
      const cash = Number(c.cash_at_hand_total ?? 0);
      // Real cash at bank = cash Financial Ops has marked as banked.
      const bank = Number(b.banked_cash_reference ?? 0);

      return {
        mtn,
        airtel,
        cash,
        bank,
        bankedCash: bank,
        bankedCashCount: Number(b.banked_cash_reference_count ?? 0),
        bankLedger: Number(b.money_at_bank_total ?? 0),
        bankReceived: Number(b.extracted_received ?? 0),
        bankSent: Number(b.extracted_sent ?? 0),
        total: Number(p.total_float ?? mtn + airtel) + cash + bank,
        computedAt: b.computed_at ?? new Date().toISOString(),
      };
    },
    staleTime: 15_000,
    refetchInterval: 30_000,
    retry: false,
  });
}
