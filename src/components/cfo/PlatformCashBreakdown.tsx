import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Loader2, TrendingUp, TrendingDown, Landmark, Users, Home, Briefcase, MoreHorizontal } from 'lucide-react';
import { CompactAmount } from '@/components/ui/CompactAmount';
import { cn } from '@/lib/utils';

interface BreakdownEntry {
  category: string;
  direction: string;
  entry_count: number;
  total_amount: number;
}

// Priority 1: Partner Funding
const PRIORITY_1_CATEGORIES = [
  'partner_funding',
];

// Priority 2: Shareholders Capital (Share Capital + Angel Pool)
const PRIORITY_2_CATEGORIES = [
  'share_capital', 'angel_pool_investment', 'angel_pool_commission',
];

// Priority 3: Rent Collections (principal, access fee, registration fee)
const PRIORITY_3_CATEGORIES = [
  'rent_principal_collected', 'access_fee_collected', 'registration_fee_collected',
];

// Priority 4: Salary Advance Repayments
const PRIORITY_4_CATEGORIES = [
  'salary_advance_repayment',
];

// Priority 5: Others (catch-all for items not in other groups)
// Dynamically computed — no fixed list

// Priority 6: Corrections
const PRIORITY_6_CATEGORIES = [
  'system_balance_correction', 'orphan_reassignment', 'orphan_reversal',
];

// Priority 7: Penalties
const PRIORITY_7_CATEGORIES = [
  'penalty_fee', 'late_payment_penalty',
];

const ALL_NAMED = [
  ...PRIORITY_1_CATEGORIES,
  ...PRIORITY_2_CATEGORIES,
  ...PRIORITY_3_CATEGORIES,
  ...PRIORITY_4_CATEGORIES,
  ...PRIORITY_6_CATEGORIES,
  ...PRIORITY_7_CATEGORIES,
];

const CATEGORY_LABELS: Record<string, string> = {
  partner_funding: 'Partner / Funder Capital',
  share_capital: 'Share Capital',
  angel_pool_investment: 'Angel Pool Investments',
  angel_pool_commission: 'Angel Pool Commissions',
  tenant_repayment: 'Tenant Repayments (Wallets)',
  tenant_repayment_collected: 'Tenant Repayments (Agent Collections)',
  agent_repayment: 'Agent Repayments (Field Collections)',
  rent_principal_collected: 'Rent Principal Collected',
  salary_advance_repayment: 'Salary Advance Repayments',
  wallet_deduction: 'Wallet Retractions & Deductions',
  system_balance_correction: 'System Corrections',
  orphan_reassignment: 'Orphan Reassignments',
  orphan_reversal: 'Orphan Reversals',
  access_fee_collected: 'Access Fees',
  registration_fee_collected: 'Registration Fees',
  wallet_deposit: 'Wallet Deposits',
  roi_expense: 'ROI Payouts',
  roi_wallet_credit: 'ROI Wallet Credits',
  roi_reinvestment: 'ROI Reinvestments',
  agent_commission_earned: 'Agent Commissions',
  agent_commission_withdrawal: 'Commission Withdrawals',
  agent_commission_used_for_rent: 'Commission Used for Rent',
  rent_disbursement: 'Rent Disbursements',
  rent_receivable_created: 'Rent Receivables Created',
  wallet_withdrawal: 'Wallet Withdrawals',
  supporter_platform_rewards: 'Supporter Rewards',
  operational_expenses: 'Operational Expenses',
  transaction_platform_expenses: 'Transaction Expenses',
  platform_service_income: 'Platform Service Income',
  agent_commission_payout: 'Agent Commission Payouts',
  pending_portfolio_topup: 'Pending Portfolio Top-ups',
  agent_float_deposit: 'Agent Float Deposits',
  agent_float_used_for_rent: 'Agent Float Used for Rent',
  wallet_transfer: 'Wallet Transfers',
};

function formatCategory(cat: string): string {
  return CATEGORY_LABELS[cat] || cat.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

interface PriorityGroup {
  label: string;
  emoji: string;
  icon: typeof Landmark;
  items: BreakdownEntry[];
  total: number;
}

function groupByPriority(entries: BreakdownEntry[]): PriorityGroup[] {
  const groups: PriorityGroup[] = [];

  const p1 = entries.filter(e => PRIORITY_1_CATEGORIES.includes(e.category));
  if (p1.length > 0) {
    groups.push({
      label: 'Partner Funding',
      emoji: '🤝',
      icon: Landmark,
      items: p1,
      total: p1.reduce((s, e) => s + e.total_amount, 0),
    });
  }

  const p2 = entries.filter(e => PRIORITY_2_CATEGORIES.includes(e.category));
  if (p2.length > 0) {
    groups.push({
      label: 'Shareholders Capital',
      emoji: '🏦',
      icon: Users,
      items: p2,
      total: p2.reduce((s, e) => s + e.total_amount, 0),
    });
  }

  const p3 = entries.filter(e => PRIORITY_3_CATEGORIES.includes(e.category));
  if (p3.length > 0) {
    const order = PRIORITY_3_CATEGORIES;
    const sorted = [...p3].sort((a, b) => order.indexOf(a.category) - order.indexOf(b.category));
    groups.push({
      label: 'Rent Collections & Fees',
      emoji: '🏠',
      icon: Home,
      items: sorted,
      total: p3.reduce((s, e) => s + e.total_amount, 0),
    });
  }

  const p4 = entries.filter(e => PRIORITY_4_CATEGORIES.includes(e.category));
  if (p4.length > 0) {
    groups.push({
      label: 'Salary Advance Repayments',
      emoji: '💼',
      icon: Briefcase,
      items: p4,
      total: p4.reduce((s, e) => s + e.total_amount, 0),
    });
  }

  // Priority 5: Others — anything not in named groups
  const p5 = entries.filter(e => !ALL_NAMED.includes(e.category));
  if (p5.length > 0) {
    groups.push({
      label: 'Other Sources',
      emoji: '📦',
      icon: MoreHorizontal,
      items: p5,
      total: p5.reduce((s, e) => s + e.total_amount, 0),
    });
  }

  const p6 = entries.filter(e => PRIORITY_6_CATEGORIES.includes(e.category));
  if (p6.length > 0) {
    groups.push({
      label: 'Corrections',
      emoji: '🔄',
      icon: MoreHorizontal,
      items: p6,
      total: p6.reduce((s, e) => s + e.total_amount, 0),
    });
  }

  const p7 = entries.filter(e => PRIORITY_7_CATEGORIES.includes(e.category));
  if (p7.length > 0) {
    groups.push({
      label: 'Penalties',
      emoji: '⚠️',
      icon: MoreHorizontal,
      items: p7,
      total: p7.reduce((s, e) => s + e.total_amount, 0),
    });
  }

  return groups;
}

export function PlatformCashBreakdown() {
  const { data, isLoading } = useQuery({
    queryKey: ['platform-cash-breakdown'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_platform_cash_breakdown');
      if (error) throw error;
      return (data as unknown as BreakdownEntry[] | null) || [];
    },
    staleTime: 300_000,
  });

  if (isLoading) {
    return (
      <div className="flex justify-center py-4">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // Show all cash_in entries — groupByPriority handles the categorization
  const increases = data.filter(e => e.direction === 'cash_in');
  if (increases.length === 0) return null;

  

  const totalIn = increases.reduce((s, e) => s + e.total_amount, 0);

  const priorityGroups = groupByPriority(increases);

  return (
    <div className="space-y-4">
      {/* Where Our Money Comes From — grouped by priority */}
      <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-4">
        <div className="flex items-center gap-2 mb-4">
          <TrendingUp className="h-4 w-4 text-emerald-600" />
          <h3 className="text-sm font-bold text-emerald-700 dark:text-emerald-400">
            Where Our Money Comes From
          </h3>
          <span className="ml-auto text-xs font-mono font-bold text-emerald-600">
            +<CompactAmount value={totalIn} />
          </span>
        </div>

        <div className="space-y-3">
          {priorityGroups.map((group, idx) => (
            <div key={group.label}>
              {/* Group header */}
              <div className="flex items-center gap-2 mb-1.5">
                <span className="text-sm">{group.emoji}</span>
                <span className="text-[11px] font-bold uppercase tracking-wider text-emerald-700 dark:text-emerald-400">
                  {group.label}
                </span>
                <span className="ml-auto text-[11px] font-mono font-bold text-emerald-600">
                  <CompactAmount value={group.total} />
                </span>
              </div>
              {/* Group items */}
              <div className="space-y-1 pl-5">
                {group.items.map(e => (
                  <div key={`${e.category}-${e.direction}`} className="flex items-center justify-between text-xs gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" />
                      <span className="truncate text-foreground">{formatCategory(e.category)}</span>
                      <span className="text-muted-foreground shrink-0">({e.entry_count})</span>
                    </div>
                    <span className="font-mono font-semibold text-emerald-600 shrink-0">
                      +<CompactAmount value={e.total_amount} />
                    </span>
                  </div>
                ))}
              </div>
              {idx < priorityGroups.length - 1 && (
                <div className="border-b border-emerald-500/10 mt-2" />
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Total */}
      <div className="rounded-xl border-2 border-emerald-500/30 bg-emerald-500/5 p-3 text-center">
        <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Total Cash Sources</p>
        <p className="text-lg font-bold font-mono text-emerald-600">
          <CompactAmount value={totalIn} />
        </p>
      </div>
    </div>
  );
}
