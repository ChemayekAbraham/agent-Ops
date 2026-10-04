import { supabase } from '@/integrations/supabase/client';
import { applyCustomerWalletLedgerFilters, isCustomerWalletLedgerEntryVisible } from '@/lib/customerWalletHistory';

export interface AgentLedgerEntry {
  id: string;
  user_id: string;
  amount: number;
  direction: string;
  category: string;
  description: string | null;
  created_at: string;
  transaction_group_id: string | null;
  linked_party: string | null;
  classification?: string | null;
  source_table?: string | null;
  reference_id?: string | null;
  tenant_name?: string;
  tenant_balance?: number;
}

export interface AgentWalletReportData {
  agentName: string;
  agentPhone: string;
  walletBalance: number;
  floatBalance: number;
  commissionBalance: number;
  totalDeposits: number;
  totalRentPaid: number;
  rentEntries: AgentLedgerEntry[];
  allEntries: AgentLedgerEntry[];
}

const COMMISSION_EARN_CATS = [
  'agent_commission_earned', 'agent_commission', 'agent_bonus',
  'referral_bonus', 'proxy_investment_commission',
];
const COMMISSION_SPEND_CATS = [
  'agent_commission_withdrawal', 'agent_commission_used_for_rent',
];

export async function fetchAgentWalletData(agentId: string): Promise<AgentWalletReportData> {
  // Fetch profile, wallet, and ledger in parallel
  const [profileRes, walletRes, ledgerRes] = await Promise.all([
    supabase.from('profiles').select('full_name, phone').eq('id', agentId).maybeSingle(),
    supabase.from('wallets').select('balance').eq('user_id', agentId).maybeSingle(),
    applyCustomerWalletLedgerFilters(supabase
      .from('general_ledger')
      .select('id, user_id, amount, direction, category, description, created_at, transaction_group_id, linked_party, classification, source_table, reference_id')
      .eq('user_id', agentId)
      .eq('ledger_scope', 'wallet'))
      .order('created_at', { ascending: false }),
  ]);

  const agentName = profileRes.data?.full_name || 'Unknown Agent';
  const agentPhone = profileRes.data?.phone || '';
  const walletBalance = walletRes.data?.balance ?? 0;
  const entries: AgentLedgerEntry[] = ((ledgerRes.data || []) as AgentLedgerEntry[]).filter(isCustomerWalletLedgerEntryVisible);

  // Resolve tenant names from linked_party UUIDs
  const tenantIds = [...new Set(entries.map(e => e.linked_party).filter(Boolean))] as string[];
  const tenantNameMap: Record<string, string> = {};
  const tenantBalanceMap: Record<string, number> = {};
  if (tenantIds.length > 0) {
    const [{ data: tenantProfiles }, { data: tenantWallets }] = await Promise.all([
      supabase.from('profiles').select('id, full_name').in('id', tenantIds),
      supabase.from('wallets').select('user_id, balance').in('user_id', tenantIds),
    ]);
    for (const p of tenantProfiles || []) {
      if (p.full_name) tenantNameMap[p.id] = p.full_name;
    }
    for (const w of tenantWallets || []) {
      tenantBalanceMap[w.user_id] = w.balance ?? 0;
    }
  }
  for (const e of entries) {
    if (e.linked_party) {
      if (tenantNameMap[e.linked_party]) e.tenant_name = tenantNameMap[e.linked_party];
      if (tenantBalanceMap[e.linked_party] !== undefined) e.tenant_balance = tenantBalanceMap[e.linked_party];
    }
  }
  // Compute commission balance
  let commEarned = 0;
  let commSpent = 0;
  let totalDeposits = 0;
  let totalRentPaid = 0;

  const rentEntries: AgentLedgerEntry[] = [];

  for (const e of entries) {
    const isPositive = e.direction === 'credit' || e.direction === 'cash_in';
    const signed = isPositive ? e.amount : -e.amount;

    if (COMMISSION_EARN_CATS.includes(e.category) && isPositive) commEarned += e.amount;
    if (COMMISSION_SPEND_CATS.includes(e.category) && !isPositive) commSpent += e.amount;

    if (e.category === 'wallet_deposit' && isPositive) totalDeposits += e.amount;

    if (e.category === 'rent_disbursement' || e.category === 'agent_float_used_for_rent' || e.category === 'agent_commission_used_for_rent') {
      if (!isPositive) totalRentPaid += e.amount;
      rentEntries.push(e);
    }
  }

  const commissionBalance = Math.max(0, commEarned - commSpent);
  const floatBalance = walletBalance - commissionBalance;

  return {
    agentName,
    agentPhone,
    walletBalance,
    floatBalance: Math.max(0, floatBalance),
    commissionBalance,
    totalDeposits,
    totalRentPaid,
    rentEntries,
    allEntries: entries,
  };
}
