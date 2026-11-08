import { supabase } from '@/integrations/supabase/client';

/** Limited row from agent_onboarded_portfolios. No bank, phone, PIN, or full portfolio code. */
export interface AgentPartnerPortfolioCard {
  portfolio_id: string | null;
  investor_id: string | null;
  partner_name: string;
  portfolio_code_masked: string | null;
  investment_amount: number;
  /** null from migration 4b unless the caller is the partner, partner staff or their approved
   *  proxy agent (creator-only rows): show "—", never 0. */
  total_roi_earned: number | null;
  /** Same rule as total_roi_earned. */
  roi_percentage: number | null;
  duration_months: number | null;
  status: string | null;
  created_at: string | null;
  next_roi_date: string | null;
  maturity_date: string | null;
}

export interface AgentPayoutRoute {
  route_key: string;
  portfolio_id: string | null;
  payout_mode: string;
  label: string;
}

/** Full destination of ONE route of a partner the caller is the assigned proxy for. Shown for confirmation. */
export interface AgentPayoutDestination {
  out_mode: string;
  out_provider: string | null;
  out_name: string | null;
  out_number: string | null;
  out_bank: string | null;
}

export async function fetchAgentPayoutDestination(partnerId: string, routeKey: string): Promise<AgentPayoutDestination | null> {
  const { data, error } = await supabase.rpc('agent_partner_payout_destination' as never, { p_partner_id: partnerId, p_route_key: routeKey } as never);
  if (error) throw error;
  const rows = (data ?? []) as AgentPayoutDestination[];
  return rows[0] ?? null;
}

export interface AgentProxyWithdrawalSummary {
  id: string;
  user_id: string | null;
  linked_party: string | null;
  proxy_partner_id: string | null;
  agent_id: string | null;
  amount: number;
  status: string;
  payout_method: string | null;
  reason: string | null;
  rejection_reason: string | null;
  created_at: string;
  updated_at: string | null;
  processed_at: string | null;
}

export async function fetchAgentOnboardedPortfolios(): Promise<AgentPartnerPortfolioCard[]> {
  const { data, error } = await supabase.rpc('agent_onboarded_portfolios' as never);
  if (error) throw error;
  return (data ?? []) as AgentPartnerPortfolioCard[];
}

export async function fetchAgentPayoutRoutes(partnerId: string): Promise<AgentPayoutRoute[]> {
  const { data, error } = await supabase.rpc('agent_partner_payout_routes' as never, { p_partner_id: partnerId } as never);
  if (error) throw error;
  return (data ?? []) as AgentPayoutRoute[];
}

export async function fetchAgentProxyWithdrawals(): Promise<AgentProxyWithdrawalSummary[]> {
  const { data, error } = await supabase.rpc('agent_proxy_withdrawal_summaries' as never);
  if (error) throw error;
  return (data ?? []) as AgentProxyWithdrawalSummary[];
}
