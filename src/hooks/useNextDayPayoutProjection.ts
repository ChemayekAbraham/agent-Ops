/**
 * Read-only next-day payout projection for the CEO dashboard / CFO Overview.
 * Same RPC (`get_next_day_payout_projection`) that feeds the 18:00 EAT CEO
 * email, so the screen and the email can never disagree. Executive roles only
 * (enforced server-side). Nothing here writes or derives money client-side.
 */
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export interface ProjectionRoiItem {
  portfolio_id: string;
  portfolio_code: string;
  partner_name: string;
  amount: number;
  principal: number;
  roi_percentage: number;
  compounding: boolean;
  payment_method: string | null;
  /** Bank name, "<NETWORK> MOBILE MONEY", "COMPOUNDING" or "DESTINATION NOT SET". */
  channel: string;
  destination_name: string | null;
  destination_number: string | null;
  funded_on: string;
  /** First payout < 25 days after funding — likely a hand-edited payout date. */
  early_first_payout: boolean;
}

export interface ProjectionLandlordItem {
  source: 'landlord_payout' | 'funded_rent_plan';
  id: string;
  status: string;
  landlord_name: string | null;
  landlord_phone: string | null;
  provider: string | null;
  amount: number;
  queued_at: string;
}

export interface ProjectionWithdrawalItem {
  id: string;
  status: string;
  name: string | null;
  amount: number;
  payout_method: string | null;
  channel: string;
  destination_name: string | null;
  destination_number: string | null;
  requested_at: string;
}

export interface ProjectionPartnerCapitalItem {
  id: string;
  status: string;
  name: string | null;
  amount: number;
  earliest_process_date: string;
  requested_at: string;
}

interface CountAmount { count: number; amount: number }

export interface NextDayPayoutProjection {
  date: string;
  generated_at: string;
  roi: {
    items: ProjectionRoiItem[];
    cash_count: number;
    cash_total: number;
    compounding_count: number;
    compounding_total: number;
  };
  landlord: { items: ProjectionLandlordItem[]; count: number; total: number };
  withdrawals: { items: ProjectionWithdrawalItem[]; count: number; total: number };
  partner_capital: { items: ProjectionPartnerCapitalItem[]; count: number; total: number };
  /** Older items kept OUT of the totals. */
  backlog: {
    roi_past_due: CountAmount;
    withdrawals_approved_stale: CountAmount;
    landlord_payouts_failed: CountAmount;
  };
}

/** Total cash leaving on `date` (compounding excluded — it is reinvested). */
export function projectionCashTotal(p: NextDayPayoutProjection): number {
  return Number(p.roi.cash_total) + Number(p.landlord.total) + Number(p.withdrawals.total) + Number(p.partner_capital.total);
}

/** @param date YYYY-MM-DD; omit for tomorrow in Africa/Kampala. */
export function useNextDayPayoutProjection(date?: string) {
  return useQuery({
    queryKey: ['next-day-payout-projection', date ?? 'tomorrow'],
    queryFn: async () => {
      const { data, error } = await (supabase.rpc as any)('get_next_day_payout_projection', { p_date: date ?? null });
      if (error) throw error;
      return data as NextDayPayoutProjection;
    },
    staleTime: 60_000,
  });
}
