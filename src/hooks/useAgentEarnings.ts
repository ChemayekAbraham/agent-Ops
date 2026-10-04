import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { fetchOpsWallet } from '@/hooks/ops/useOpsDataLayer';
import { useAuth } from './useAuth';
import { getCachedDashboardData, cacheDashboardData } from '@/lib/offlineDataStorage';
import { applyCustomerWalletLedgerFilters, isCustomerWalletLedgerEntryVisible } from '@/lib/customerWalletHistory';

interface Earning {
  id: string;
  amount: number;
  earning_type: string;
  description: string | null;
  created_at: string;
  source_user_id: string | null;
  rent_request_id: string | null;
}

export interface LedgerEntry {
  id: string;
  agent_id: string;
  tenant_id: string | null;
  source_type: string;
  event_type: string | null;
  commission_role: string | null;
  percentage: number | null;
  repayment_amount: number | null;
  amount: number;
  description: string | null;
  status: string;
  earned_at: string;
  rent_request_id: string | null;
  tenant_name: string | null;
}

export interface DetailedEarning extends Earning {
  sourceName: string | null;
  ledger: LedgerEntry | null;
}

const EARNINGS_CACHE_KEY = 'agent_earnings';
const LS_KEY_PREFIX = 'lf_agent_earnings_';

function readLocalCache(userId: string): { earnings: Earning[]; paidOut: number; walletBalance: number } | null {
  try {
    const raw = localStorage.getItem(LS_KEY_PREFIX + userId);
    if (raw) return JSON.parse(raw).data;
  } catch {}
  return null;
}

function writeLocalCache(userId: string, data: { earnings: Earning[]; paidOut: number; walletBalance: number }): void {
  try {
    localStorage.setItem(LS_KEY_PREFIX + userId, JSON.stringify({ data, timestamp: Date.now() }));
  } catch {}
}

export interface EarningBreakdown {
  rentCommission: number;
  investmentCommission: number;
  subagentCommission: number;
  registrationBonus: number;
  verificationBonus: number;
  facilitationBonus: number;
  listingBonus: number;
  approvalBonus: number;
  referralBonus: number;
  other: number;
}

const EARNING_CATEGORIES: Record<string, keyof EarningBreakdown> = {
  commission: 'rentCommission',
  rent_commission: 'rentCommission',
  investment_commission: 'investmentCommission',
  subagent_commission: 'subagentCommission',
  subagent_override: 'subagentCommission',
  registration: 'registrationBonus',
  registration_bonus: 'registrationBonus',
  verification_bonus: 'verificationBonus',
  rent_funded_bonus: 'facilitationBonus',
  facilitation_bonus: 'facilitationBonus',
  listing_bonus: 'listingBonus',
  approval_bonus: 'approvalBonus',
  referral_bonus: 'referralBonus',
  referral: 'referralBonus',
};

/**
 * Ledger-derived earnings.
 *
 * The `general_ledger` (wallet scope) is the source of truth for every UGX an
 * agent actually earned. The legacy `agent_earnings` table is populated
 * inconsistently — for ~230 agents it is empty even though the ledger holds
 * hundreds of commission legs — so agents saw "0 commission" while their wallet
 * history clearly showed the credits. We now build the earnings feed straight
 * from the ledger so what agents see matches their wallet history exactly.
 *
 * Maps a ledger `category` → the UI `earning_type` used by EARNING_CATEGORIES.
 */
const LEDGER_EARNING_CATEGORIES: Record<string, string> = {
  agent_commission_earned: 'commission',
  agent_commission: 'commission',
  agent_investment_commission: 'investment_commission',
  investment_commission: 'investment_commission',
  proxy_investment_commission: 'investment_commission',
  partner_commission: 'investment_commission',
  subagent_commission: 'subagent_commission',
  subagent_override: 'subagent_commission',
  referral_bonus: 'referral_bonus',
  registration_bonus: 'registration_bonus',
  verification_bonus: 'verification_bonus',
  rent_funded_bonus: 'rent_funded_bonus',
  facilitation_bonus: 'facilitation_bonus',
  listing_bonus: 'listing_bonus',
  approval_bonus: 'approval_bonus',
  agent_bonus: 'other',
};
const LEDGER_EARNING_CATEGORY_LIST = Object.keys(LEDGER_EARNING_CATEGORIES);

function buildBreakdown(data: Earning[]): EarningBreakdown {
  const b: EarningBreakdown = {
    rentCommission: 0, investmentCommission: 0, subagentCommission: 0,
    registrationBonus: 0, verificationBonus: 0, facilitationBonus: 0,
    listingBonus: 0, approvalBonus: 0, referralBonus: 0, other: 0,
  };
  data.forEach(e => {
    const cat = EARNING_CATEGORIES[e.earning_type] || 'other';
    b[cat] += Number(e.amount);
  });
  return b;
}

const ROLE_LABELS: Record<string, string> = {
  source_agent: 'Source Agent',
  tenant_manager: 'Tenant Manager',
  recruiter_override: 'Recruiter Override',
  event_bonus: 'Event Bonus',
};

function matchLedgerToEarning(earning: Earning, ledgerEntries: LedgerEntry[]): LedgerEntry | null {
  // Match by rent_request_id + closest timestamp
  const candidates = ledgerEntries.filter(l => {
    if (earning.rent_request_id && l.rent_request_id && earning.rent_request_id === l.rent_request_id) return true;
    // Fallback: amount match + close timestamp (within 60s)
    const timeDiff = Math.abs(new Date(earning.created_at).getTime() - new Date(l.earned_at).getTime());
    return Math.abs(Number(earning.amount) - Number(l.amount)) < 1 && timeDiff < 60000;
  });
  if (candidates.length === 0) return null;
  // Pick closest by time
  candidates.sort((a, b) =>
    Math.abs(new Date(earning.created_at).getTime() - new Date(a.earned_at).getTime()) -
    Math.abs(new Date(earning.created_at).getTime() - new Date(b.earned_at).getTime())
  );
  return candidates[0];
}

export function useAgentEarnings() {
  const { user } = useAuth();
  const [earnings, setEarnings] = useState<Earning[]>([]);
  const [detailedEarnings, setDetailedEarnings] = useState<DetailedEarning[]>([]);
  const [loading, setLoading] = useState(true);
  const [totalEarnings, setTotalEarnings] = useState(0);
  const [commissionTotal, setCommissionTotal] = useState(0);
  const [bonusTotal, setBonusTotal] = useState(0);
  const [totalPaidOut, setTotalPaidOut] = useState(0);
  const [availableToWithdraw, setAvailableToWithdraw] = useState(0);
  const [breakdown, setBreakdown] = useState<EarningBreakdown>({
    rentCommission: 0, investmentCommission: 0, subagentCommission: 0,
    registrationBonus: 0, verificationBonus: 0, facilitationBonus: 0,
    listingBonus: 0, approvalBonus: 0, referralBonus: 0, other: 0,
  });

  const computeTotals = (data: Earning[], paidOut: number, walletBalance: number) => {
    const total = data.reduce((sum, e) => sum + Number(e.amount), 0);
    const b = buildBreakdown(data);
    setTotalEarnings(total);
    setCommissionTotal(b.rentCommission + b.investmentCommission + b.subagentCommission);
    setBonusTotal(b.registrationBonus + b.verificationBonus + b.facilitationBonus + b.listingBonus + b.approvalBonus + b.referralBonus);
    setBreakdown(b);
    setTotalPaidOut(paidOut);
    setAvailableToWithdraw(Math.max(0, walletBalance));
  };

  // Load cached data immediately on init
  useEffect(() => {
    if (!user) return;
    const cached = readLocalCache(user.id);
    if (cached) {
      setEarnings(cached.earnings);
      computeTotals(cached.earnings, cached.paidOut, cached.walletBalance);
      setLoading(false);
    }
  }, [user?.id]);

  const fetchEarnings = useCallback(async () => {
    if (!user) return;

    // If offline, try IndexedDB cache
    if (!navigator.onLine) {
      try {
        const cached = await getCachedDashboardData(user.id, EARNINGS_CACHE_KEY);
        if (cached) {
          setEarnings(cached as Earning[]);
          computeTotals(cached as Earning[], 0, 0);
        }
      } catch {}
      setLoading(false);
      return;
    }

    // Fetch earnings (from the authoritative ledger), payouts, wallet, accrual
    // ledger, and source profiles in parallel. The ledger is the source of
    // truth — the legacy `agent_earnings` table is populated inconsistently.
    const [earningsRes, payoutsRes, walletRes, ledgerRes] = await Promise.all([
      applyCustomerWalletLedgerFilters(supabase
        .from('general_ledger')
        .select('id, amount, category, description, created_at, linked_party, classification, source_table, reference_id')
        .eq('user_id', user.id)
        .eq('ledger_scope', 'wallet')
        .in('category', LEDGER_EARNING_CATEGORY_LIST)
        .in('direction', ['credit', 'cash_in']))
        .order('created_at', { ascending: false })
        .limit(1000),
      supabase
        .from('agent_commission_payouts')
        .select('amount, status')
        .eq('agent_id', user.id)
        .in('status', ['pending', 'approved']),
      // Authoritative wallet RPC — avoids the heavy `wallets` view (517k calls/day at 264ms avg).
      fetchOpsWallet(user.id).then((w) => ({ data: w, error: null })).catch((error) => ({ data: null, error })),
      supabase
        .from('commission_accrual_ledger')
        .select('id, agent_id, tenant_id, source_type, event_type, commission_role, percentage, repayment_amount, amount, description, status, earned_at, rent_request_id')
        .eq('agent_id', user.id)
        .in('status', ['earned', 'approved', 'paid'])
        .order('earned_at', { ascending: false })
        .limit(500),
    ]);

    if (earningsRes.error) {
      console.error('Error fetching earnings:', earningsRes.error);
      setLoading(false);
      return;
    }

    // Map ledger rows → the Earning shape the UI consumes.
    const result: Earning[] = (earningsRes.data || []).filter(isCustomerWalletLedgerEntryVisible).map((r) => ({
      id: r.id,
      amount: Number(r.amount),
      earning_type: LEDGER_EARNING_CATEGORIES[r.category] || 'other',
      description: r.description,
      created_at: r.created_at,
      source_user_id: r.linked_party ?? null,
      rent_request_id: null,
    }));
    const paidOut = (payoutsRes.data || []).reduce((sum, p) => sum + Number(p.amount), 0);
    const walletBalance = walletRes.data ? Number(walletRes.data.withdrawable + walletRes.data.float + walletRes.data.advance) : 0;
    const ledgerData = ledgerRes.data || [];

    // Resolve tenant names and source names in batch
    const tenantIds = [...new Set(ledgerData.filter(l => l.tenant_id).map(l => l.tenant_id!))];
    const sourceIds = [...new Set(result.filter(e => e.source_user_id).map(e => e.source_user_id!))];
    const allProfileIds = [...new Set([...tenantIds, ...sourceIds])];

    let profileMap: Record<string, string> = {};
    if (allProfileIds.length > 0) {
      const { data: profiles } = await supabase
        .from('profiles')
        .select('id, full_name')
        .in('id', allProfileIds);
      if (profiles) {
        profiles.forEach(p => { profileMap[p.id] = p.full_name || 'Unknown'; });
      }
    }

    // Enrich ledger entries with tenant names
    const enrichedLedger: LedgerEntry[] = ledgerData.map(l => ({
      ...l,
      tenant_name: l.tenant_id ? (profileMap[l.tenant_id] || null) : null,
    }));

    // Build detailed earnings by matching each earning to its ledger entry
    const detailed: DetailedEarning[] = result.map(e => ({
      ...e,
      sourceName: e.source_user_id ? (profileMap[e.source_user_id] || null) : null,
      ledger: matchLedgerToEarning(e, enrichedLedger),
    }));

    setEarnings(result);
    setDetailedEarnings(detailed);
    computeTotals(result, paidOut, walletBalance);
    setLoading(false);

    // Cache for offline
    writeLocalCache(user.id, { earnings: result, paidOut, walletBalance });
    try { await cacheDashboardData(user.id, EARNINGS_CACHE_KEY, result); } catch {}
  }, [user]);

  useEffect(() => {
    if (user) {
      fetchEarnings();
    }
  }, [user, fetchEarnings]);

  return {
    earnings,
    detailedEarnings,
    loading,
    totalEarnings,
    commissionTotal,
    bonusTotal,
    breakdown,
    totalPaidOut,
    availableToWithdraw,
    refreshEarnings: fetchEarnings,
    ROLE_LABELS,
  };
}
