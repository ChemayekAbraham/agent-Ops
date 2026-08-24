import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

/**
 * Per-merchant-agent float allocation report — read only.
 *
 * Backed by `merchant_agent_float_allocation_report(p_days)`, which reuses
 * the ledger-verified reliability backbone (`merchant_payout_success_matrix`)
 * and the ledger-truth float position (`get_merchant_float_positions`)
 * instead of re-deriving either. Money figures come from `general_ledger`,
 * never from `withdrawal_requests.amount` alone or the cached float balance.
 *
 * Use this to decide who gets MORE float and who gets LESS, based strictly
 * on measured withdrawal/payout history — never on a gut feel.
 */
export type MerchantFloatAllocationGrade =
  | 'healthy'
  | 'recording_gap'
  | 'money_risk'
  | 'stranded_claims'
  | 'no_payouts';

export type MerchantFloatAllocationRecommendation =
  | 'increase'
  | 'maintain'
  | 'reduce_or_freeze'
  | 'insufficient_data';

export interface MerchantFloatAllocationRow {
  agentId: string;
  merchantName: string;
  merchantPhone: string | null;
  label: string | null;
  isActive: boolean;
  isOnline: boolean;
  windowDays: number;

  // Reliability (from merchant_payout_success_matrix — ledger-verified)
  attempts: number;
  actioned: number;
  paid: number;
  pctPaid: number | null;
  pctCustomerDebited: number | null;
  pctFullyRecorded: number | null;
  strandedProcessing: number;
  grade: MerchantFloatAllocationGrade;

  // Money (from general_ledger, windowed)
  totalPaid: number;
  totalTelecom: number;
  totalFloatConsumed: number;
  totalCommission: number;
  floatDelivered: number;
  floatTurnover: number | null;

  // Risk signals
  shortfallCount: number;
  shortfallAmount: number;
  pendingReimbursementAmount: number;
  openDisputes: number;

  // Current position (lifetime, informational only — never used to pay anyone)
  ledgerFloatHeld: number | null;
  owedToAgent: number | null;
  companyCashWithAgent: number | null;
  payoutsWithoutFloatEvidence: number | null;

  // Capacity
  maxDailyPayouts: number | null;
  currentQueueCount: number | null;
  capacityUtilizationPct: number | null;

  allocationScore: number;
  recommendation: MerchantFloatAllocationRecommendation;
  reason: string;
}

export function useMerchantAgentFloatAllocation(days = 30, enabled = true) {
  return useQuery({
    queryKey: ['merchant-agent-float-allocation', days],
    enabled,
    retry: false,
    staleTime: 60_000,
    queryFn: async (): Promise<MerchantFloatAllocationRow[]> => {
      const { data, error } = await supabase.rpc(
        'merchant_agent_float_allocation_report' as any,
        { p_days: days },
      );
      if (error) throw error;
      return ((data ?? []) as any[]).map((r) => ({
        agentId: String(r.agent_id),
        merchantName: r.merchant_name ?? 'Unknown agent',
        merchantPhone: r.merchant_phone ?? null,
        label: r.label ?? null,
        isActive: !!r.is_active,
        isOnline: !!r.is_online,
        windowDays: Number(r.window_days ?? days),
        attempts: Number(r.attempts ?? 0),
        actioned: Number(r.actioned ?? 0),
        paid: Number(r.paid ?? 0),
        pctPaid: r.pct_paid == null ? null : Number(r.pct_paid),
        pctCustomerDebited: r.pct_customer_debited == null ? null : Number(r.pct_customer_debited),
        pctFullyRecorded: r.pct_fully_recorded == null ? null : Number(r.pct_fully_recorded),
        strandedProcessing: Number(r.stranded_processing ?? 0),
        grade: (r.grade ?? 'no_payouts') as MerchantFloatAllocationGrade,
        totalPaid: Number(r.total_paid ?? 0),
        totalTelecom: Number(r.total_telecom ?? 0),
        totalFloatConsumed: Number(r.total_float_consumed ?? 0),
        totalCommission: Number(r.total_commission ?? 0),
        floatDelivered: Number(r.float_delivered ?? 0),
        floatTurnover: r.float_turnover == null ? null : Number(r.float_turnover),
        shortfallCount: Number(r.shortfall_count ?? 0),
        shortfallAmount: Number(r.shortfall_amount ?? 0),
        pendingReimbursementAmount: Number(r.pending_reimbursement_amount ?? 0),
        openDisputes: Number(r.open_disputes ?? 0),
        ledgerFloatHeld: r.ledger_float_held == null ? null : Number(r.ledger_float_held),
        owedToAgent: r.owed_to_agent == null ? null : Number(r.owed_to_agent),
        companyCashWithAgent: r.company_cash_with_agent == null ? null : Number(r.company_cash_with_agent),
        payoutsWithoutFloatEvidence:
          r.payouts_without_float_evidence == null ? null : Number(r.payouts_without_float_evidence),
        maxDailyPayouts: r.max_daily_payouts == null ? null : Number(r.max_daily_payouts),
        currentQueueCount: r.current_queue_count == null ? null : Number(r.current_queue_count),
        capacityUtilizationPct:
          r.capacity_utilization_pct == null ? null : Number(r.capacity_utilization_pct),
        allocationScore: Number(r.allocation_score ?? 0),
        recommendation: (r.recommendation ?? 'insufficient_data') as MerchantFloatAllocationRecommendation,
        reason: String(r.reason ?? ''),
      }));
    },
  });
}
