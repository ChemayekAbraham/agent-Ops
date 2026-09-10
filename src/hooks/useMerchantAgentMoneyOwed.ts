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
  claimed_pending_total: number;
  claimed_pending_count: number;
  still_held: number;
  email_sent_count: number;
  email_returned_count: number;
  last_sent_at: string | null;
}

export interface MerchantAgentMoneyOwed {
  /** Money still sitting with merchant agents, from the extracted MTN/Airtel emails. */
  merchantAgentTotal: number;
  /** Bayo Mercy account balance from the same email extractor. */
  bayoMercyTotal: number;
  /** merchantAgentTotal + bayoMercyTotal */
  total: number;
  agents: MerchantAgentOwedRow[];
  definition: string;
}

/**
 * Read-only reporting view of money that has left our provider lines and is now
 * held outside the platform: merchant agent float (matched from the extracted
 * MTN / Airtel emails) plus the Bayo Mercy account balance.
 *
 * Per agent: money emailed out to their number, less money they sent back, less
 * payouts they have already completed for us — floored at zero.
 */
export function useMerchantAgentMoneyOwed(enabled = true) {
  return useQuery({
    queryKey: ['cfo-merchant-agent-money-owed'],
    enabled,
    staleTime: 30_000,
    refetchInterval: 60_000,
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
          paid_out_total: Number(a.paid_out_total ?? 0),
          claimed_pending_total: Number(a.claimed_pending_total ?? 0),
          claimed_pending_count: Number(a.claimed_pending_count ?? 0),
          still_held: Number(a.still_held ?? 0),
          email_sent_count: Number(a.email_sent_count ?? 0),
          email_returned_count: Number(a.email_returned_count ?? 0),
          last_sent_at: a.last_sent_at ?? null,
        })),
        definition: String(d.definition ?? ''),
      };
    },
  });
}
