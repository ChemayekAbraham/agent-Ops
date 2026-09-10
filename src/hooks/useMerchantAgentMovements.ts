import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export interface MerchantAgentMovement {
  id: string;
  desk_id: string;
  agent_name: string;
  direction: 'in' | 'out';
  amount: number;
  channel: string;
  at: string | null;
  transaction_id: string | null;
  counterparty: string | null;
  subject: string | null;
  snippet: string | null;
}

/**
 * Read-only movement-level detail behind the merchant agent figure on the CFO
 * Money We Owe card: every MTN / Airtel email transfer matched to an active
 * merchant desk phone. Nothing is written.
 */
export function useMerchantAgentMovements(enabled = true) {
  return useQuery({
    queryKey: ['cfo-merchant-agent-movements'],
    enabled,
    staleTime: 30_000,
    queryFn: async (): Promise<MerchantAgentMovement[]> => {
      const { data, error } = await supabase.rpc('get_merchant_agent_movements' as any, {
        p_desk_id: null,
      } as any);
      if (error) throw error;
      const rows = ((data as any)?.movements ?? []) as any[];
      return rows.map((m) => ({
        id: String(m.id),
        desk_id: String(m.desk_id),
        agent_name: String(m.agent_name ?? 'Merchant agent'),
        direction: m.direction === 'out' ? 'out' : 'in',
        amount: Number(m.amount ?? 0),
        channel: String(m.channel ?? ''),
        at: m.at ?? null,
        transaction_id: m.transaction_id ?? null,
        counterparty: m.counterparty ?? null,
        subject: m.subject ?? null,
        snippet: m.snippet ?? null,
      }));
    },
  });
}

export interface BayoMercyMovement {
  id: string;
  direction: 'in' | 'out';
  amount: number;
  at: string | null;
  transaction_id: string | null;
  counterparty: string | null;
  note: string | null;
}

/** Read-only movement detail behind the Bayo Mercy bank account figure. */
export function useBayoMercyMovements(enabled = true) {
  return useQuery({
    queryKey: ['cfo-bayo-mercy-movements'],
    enabled,
    staleTime: 30_000,
    queryFn: async (): Promise<BayoMercyMovement[]> => {
      const { data, error } = await supabase.rpc('get_money_at_bank_reconciliation' as any);
      if (error) throw error;
      const rows = ((data as any)?.qualifying_emails ?? []) as any[];
      return rows.map((t) => ({
        id: String(t.id),
        direction: t.direction === 'out' ? 'out' : 'in',
        amount: Number(t.amount ?? 0),
        at: t.extracted_at ?? null,
        transaction_id: t.transaction_id ?? null,
        counterparty: t.counterparty ?? null,
        note: t.snippet ? String(t.snippet).slice(0, 200) : (t.subject ?? null),
      }));
    },
  });
}

export interface FlaggedTransfer {
  id: string;
  amount: number;
  channel: string;
  at: string | null;
  transaction_id: string | null;
  counterparty: string | null;
  subject: string | null;
  snippet: string | null;
  recipient_phone: string | null;
  profile_name: string | null;
  profile_email: string | null;
  profile_id: string | null;
  reason: string | null;
  reason_code: string | null;
  merchant_match_status: string | null;
  matched_desk_id: string | null;
}


/**
 * Read-only flag: money-out mobile money email transfers whose recipient number
 * is not on any active merchant agent desk.
 */
export function useUnregisteredRecipientTransfers(enabled = true, days = 120) {
  return useQuery({
    queryKey: ['cfo-unregistered-recipient-transfers', days],
    enabled,
    staleTime: 30_000,
    queryFn: async (): Promise<{ transfers: FlaggedTransfer[]; total: number }> => {
      const { data, error } = await supabase.rpc('get_unregistered_recipient_transfers' as any, {
        p_days: days,
      } as any);
      if (error) throw error;
      const rows = ((data as any)?.transfers ?? []) as any[];
      return {
        total: Number((data as any)?.total ?? 0),
        transfers: rows.map((t) => ({
          id: String(t.id),
          amount: Number(t.amount ?? 0),
          channel: String(t.channel ?? ''),
          at: t.at ?? null,
          transaction_id: t.transaction_id ?? null,
          counterparty: t.counterparty ?? null,
          subject: t.subject ?? null,
          snippet: t.snippet ?? null,
          recipient_phone: t.recipient_phone ?? null,
          profile_name: t.profile_name ?? null,
          profile_email: t.profile_email ?? null,
          profile_id: t.profile_id ?? null,
          reason: t.reason ?? null,
          reason_code: t.reason_code ?? null,
          merchant_match_status: t.merchant_match_status ?? null,
          matched_desk_id: t.matched_desk_id ?? null,
        })),
      };
    },
  });
}

