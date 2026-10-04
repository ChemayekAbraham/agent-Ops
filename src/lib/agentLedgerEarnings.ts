import { supabase } from '@/integrations/supabase/client';
import {
  applyCustomerWalletLedgerFilters,
  isCustomerWalletLedgerEntryVisible,
} from '@/lib/customerWalletHistory';

/**
 * An agent's earnings, read from `general_ledger` (wallet scope, cash_in).
 *
 * The ledger is the only live source. `agent_earnings` has not been written
 * since 2026-07-20 (rent commission since April), and `commission_accrual_ledger`
 * now only receives `event_bonus` rows — the 10% rent commission and the 2%
 * recruiter override are posted straight to the ledger. Screens that still
 * summed either legacy table showed every agent "0 commission" while the money
 * was sitting in their wallet (agent Oscar Arnold, 2026-09-24).
 */
export type AgentLedgerEarningType =
  | 'commission'            // own rent-collection commission
  | 'subagent_commission'   // % override on a sub-agent's rent collection
  | 'investment_commission' // partner / proxy portfolio commission
  | 'bonus';                // every other agent credit (listing, verification, referral…)

export interface AgentLedgerEarning {
  id: string;
  amount: number;
  earning_type: AgentLedgerEarningType;
  description: string | null;
  created_at: string;
  /** Rent plan the credit came from (collection commissions/overrides only). */
  rent_request_id: string | null;
}

const EARNING_CATEGORIES = [
  'agent_commission_earned',
  'agent_commission',
  'partner_commission',
  'agent_investment_commission',
  'investment_commission',
  'proxy_investment_commission',
  'subagent_commission',
  'subagent_override',
  'referral_bonus',
  'registration_bonus',
  'verification_bonus',
  'rent_funded_bonus',
  'facilitation_bonus',
  'listing_bonus',
  'approval_bonus',
  'agent_bonus',
];

const INVESTMENT_CATEGORIES = new Set([
  'partner_commission',
  'agent_investment_commission',
  'investment_commission',
  'proxy_investment_commission',
]);

type LedgerRow = {
  id: string;
  amount: number | string;
  category: string;
  description: string | null;
  created_at: string;
  source_table: string | null;
  source_id: string | null;
  classification: string | null;
  reference_id: string | null;
};

export function classifyAgentLedgerEarning(row: {
  category: string;
  description: string | null;
  source_table: string | null;
}): AgentLedgerEarningType {
  const desc = (row.description || '').toLowerCase();
  if (row.source_table === 'agent_collections') {
    // "2% recruiter override on sub-agent rent collection allocation",
    // "Verified parent override 2% on tenant self-payment", …
    return desc.includes('override') ? 'subagent_commission' : 'commission';
  }
  if (row.category === 'subagent_commission' || row.category === 'subagent_override') {
    return 'subagent_commission';
  }
  if (INVESTMENT_CATEGORIES.has(row.category) || /portfolio .*commission|partner .*commission/.test(desc)) {
    return 'investment_commission';
  }
  return 'bonus';
}

/**
 * The caller's own sub-agent rent-override credits, grouped per sub-agent.
 * Server-side because rent_requests RLS hides most sub-agents' plans from the
 * parent, so a client-side ledger→plan→sub-agent join attributes nothing.
 */
export async function fetchMySubagentRentOverrides(
  opts: { from?: string; to?: string } = {},
): Promise<Array<{ sub_agent_id: string; amount: number }>> {
  // Not yet in the generated types (added 2026-09-24, migration 20260924160000).
  const { data, error } = await (supabase.rpc as unknown as (
    fn: string,
    args: Record<string, unknown>,
  ) => Promise<{ data: Array<{ sub_agent_id: string; amount: number | string }> | null; error: Error | null }>)(
    'get_my_subagent_rent_overrides',
    { p_from: opts.from ?? null, p_to: opts.to ?? null },
  );
  if (error) throw error;
  return (data || []).map((r) => ({ sub_agent_id: r.sub_agent_id, amount: Number(r.amount) || 0 }));
}

const PAGE = 1000;
const MAX_ROWS = 20000;

export async function fetchAgentLedgerEarnings(
  agentId: string,
  opts: { from?: string; to?: string; types?: AgentLedgerEarningType[] } = {},
): Promise<AgentLedgerEarning[]> {
  const out: AgentLedgerEarning[] = [];
  for (let offset = 0; offset < MAX_ROWS; offset += PAGE) {
    let q = applyCustomerWalletLedgerFilters(
      supabase
        .from('general_ledger')
        .select('id, amount, category, description, created_at, source_table, source_id, classification, reference_id')
        .eq('user_id', agentId)
        .in('category', EARNING_CATEGORIES)
        .in('direction', ['credit', 'cash_in']),
    );
    if (opts.from) q = q.gte('created_at', opts.from);
    if (opts.to) q = q.lte('created_at', opts.to);

    const { data, error } = await q
      .order('created_at', { ascending: false })
      .range(offset, offset + PAGE - 1);
    if (error) throw error;

    const rows = (data || []) as LedgerRow[];
    for (const r of rows) {
      if (!isCustomerWalletLedgerEntryVisible(r)) continue;
      const earning_type = classifyAgentLedgerEarning(r);
      if (opts.types && !opts.types.includes(earning_type)) continue;
      out.push({
        id: r.id,
        amount: Number(r.amount) || 0,
        earning_type,
        description: r.description,
        created_at: r.created_at,
        rent_request_id: r.source_table === 'agent_collections' ? r.source_id : null,
      });
    }
    if (rows.length < PAGE) break;
  }
  return out;
}
