import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export interface MerchantAgentOwedRow {
  desk_id: string;
  agent_id: string;
  agent_name: string;
  label: string | null;
  phone: string | null;
  email_sent_total: number;
  email_returned_total: number;
  paid_out_total: number;
  /** Company money sitting in this desk's float bucket (wallet float_balance). */
  float_balance: number;
  claimed_pending_total: number;
  claimed_pending_count: number;
  /** Amount deducted from the float bucket because the desk claimed those payouts. */
  claim_reduction_total: number;
  /** Owed figure for this desk = float bucket balance less claimed payouts. */
  still_held: number;
  /** Email-derived sent-minus-returned trail, kept as supporting detail. */
  email_still_held: number;
  email_sent_count: number;
  email_returned_count: number;
  last_sent_at: string | null;
}

export interface MerchantAgentMoneyOwed {
  /** Merchant float bucket: company money held in active merchant agents' float wallets. */
  merchantAgentTotal: number;
  /** Bayo Mercy account balance from the email extractor. */
  bayoMercyTotal: number;
  /** merchantAgentTotal + bayoMercyTotal */
  total: number;
  agents: MerchantAgentOwedRow[];
  definition: string;
}

/**
 * Read-only reporting view of Money We Owe: the merchant float bucket (the
 * float balance on each active merchant agent's wallet — the same figure the
 * Financial Ops wallet-bucket board shows) plus the Bayo Mercy account
 * balance. The email-derived sent-minus-returned trail stays beside each
 * desk as supporting detail only.
 */
export function useMerchantAgentMoneyOwed(enabled = true) {
  return useQuery({
    queryKey: ['cfo-merchant-agent-money-owed'],
    enabled,
    // Same cadence as the Financial Ops wallet-bucket board, so the two screens
    // never show different ages of the same merchant float figure.
    staleTime: 15_000,
    refetchInterval: 30_000,
    queryFn: async (): Promise<MerchantAgentMoneyOwed> => {
      const { data, error } = await supabase.rpc('get_merchant_agent_money_owed' as any);
      if (error) throw error;
      const d = (data ?? {}) as any;
      return {
        merchantAgentTotal: Number(d.merchant_agent_total ?? 0),
        bayoMercyTotal: Number(d.bayo_mercy_total ?? 0),
        total: Number(d.total ?? 0),
        agents: ((d.agents ?? []) as any[]).map((a) => ({
          desk_id: String(a.desk_id),
          agent_id: String(a.agent_id),
          agent_name: String(a.agent_name ?? 'Merchant agent'),
          label: a.label ?? null,
          phone: a.phone ?? null,
          email_sent_total: Number(a.email_sent_total ?? 0),
          email_returned_total: Number(a.email_returned_total ?? 0),
          float_balance: Number(a.float_balance ?? a.still_held ?? 0),
          paid_out_total: Number(a.paid_out_total ?? 0),
          claimed_pending_total: Number(a.claimed_pending_total ?? 0),
          claimed_pending_count: Number(a.claimed_pending_count ?? 0),
          claim_reduction_total: Number(a.claim_reduction_total ?? 0),
          still_held: Number(a.still_held ?? a.float_balance ?? 0),
          email_still_held: Number(a.email_still_held ?? 0),
          email_sent_count: Number(a.email_sent_count ?? 0),
          email_returned_count: Number(a.email_returned_count ?? 0),
          last_sent_at: a.last_sent_at ?? null,
        })),
        definition: String(d.definition ?? ''),
      };
    },
  });
}
