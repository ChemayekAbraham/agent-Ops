import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

/**
 * Per-merchant-agent float allocation report — read only.
 *
 * Backed by `merchant_agent_float_allocation_report(p_days)`, which reuses the
 * ledger-verified reliability backbone (`merchant_payout_success_matrix`) and
 * the ledger-truth float position instead of re-deriving either. Every money
 * figure comes from `general_ledger` legs tied to the payout, never from
 * `withdrawal_requests.amount` or the cached `wallets.float_balance`. Cached
 * float is clamped to the ledger figure (drift can only ever reduce spendable
 * float, never inflate it) — the same rule MoneyWithAgentsCard applies.
 *
 * Visibility is enforced in the database (CFO / Financial Ops / COO / manager /
 * super admin).
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
  channels: string | null;
  isActive: boolean;
  isOnline: boolean;
  windowDays: number;

  // Reliability (from merchant_payout_success_matrix — ledger-verified)
  attempts: number;
  actioned: number;
  paid: number;
  payoutsVerified: number;
  pctPaid: number | null;
  pctCustomerDebited: number | null;
  pctFullyRecorded: number | null;
  strandedProcessing: number;
  grade: MerchantFloatAllocationGrade;

  // Money (general_ledger legs, windowed)
  totalPaid: number;
  totalTelecom: number;
  totalFloatConsumed: number;
  totalCommission: number;
  commissionAwards: number;
  floatDelivered: number;
  floatTurnover: number | null;

  // Shortfall / under-floating signal
  shortfallCount: number;
  shortfallAmount: number;
  needsReviewCount: number;
  needsReviewAmount: number;
  pendingReimbursementCount: number;
  pendingReimbursementAmount: number;
  openDisputes: number;

  // Current position (cache clamped to ledger)
  floatCache: number;
  floatLedger: number;
  floatSpendable: number;
  reservedFloat: number;
  availableFloat: number;
  outOfPocketOutstanding: number;
  netPosition: number;
  state: 'OWED' | 'FUNDED';

  // Settlement cleanliness
  settlementCleanPct: number | null;
  settledCount: number;
  unsettledCount: number;
  failedSettlements: number;

  // Capacity
  maxDailyPayouts: number | null;
  currentQueueCount: number | null;
  capacityUtilizationPct: number | null;

  allocationScore: number;
  recommendation: MerchantFloatAllocationRecommendation;
  reason: string;
  blocker: string | null;
}

export interface MerchantFloatAllocationEvidenceRow {
  withdrawalId: string;
  createdAt: string;
  status: string;
  settlementState: string | null;
  requestAmount: number;
  customerDebit: number;
  floatPrincipal: number;
  floatTelecom: number;
  commissionAmount: number;
  hasDebitLeg: boolean;
  hasFundingRecord: boolean;
  hasCommissionAward: boolean;
  shortfallAmount: number;
  shortfallKind: string | null;
  shortfallStatus: string | null;
  ledgerLegIds: string[];
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
        channels: r.channels ?? null,
        isActive: !!r.is_active,
        isOnline: !!r.is_online,
        windowDays: Number(r.window_days ?? days),
        attempts: Number(r.attempts ?? 0),
        actioned: Number(r.actioned ?? 0),
        paid: Number(r.paid ?? 0),
        payoutsVerified: Number(r.payouts_verified ?? 0),
        pctPaid: r.pct_paid == null ? null : Number(r.pct_paid),
        pctCustomerDebited: r.pct_customer_debited == null ? null : Number(r.pct_customer_debited),
        pctFullyRecorded: r.pct_fully_recorded == null ? null : Number(r.pct_fully_recorded),
        strandedProcessing: Number(r.stranded_processing ?? 0),
        grade: (r.grade ?? 'no_payouts') as MerchantFloatAllocationGrade,
        totalPaid: Number(r.total_paid ?? 0),
        totalTelecom: Number(r.total_telecom ?? 0),
        totalFloatConsumed: Number(r.total_float_consumed ?? 0),
        totalCommission: Number(r.total_commission ?? 0),
        commissionAwards: Number(r.commission_awards ?? 0),
        floatDelivered: Number(r.float_delivered ?? 0),
        floatTurnover: r.float_turnover == null ? null : Number(r.float_turnover),
        shortfallCount: Number(r.shortfall_count ?? 0),
        shortfallAmount: Number(r.shortfall_amount ?? 0),
        needsReviewCount: Number(r.needs_review_count ?? 0),
        needsReviewAmount: Number(r.needs_review_amount ?? 0),
        pendingReimbursementCount: Number(r.pending_reimbursement_count ?? 0),
        pendingReimbursementAmount: Number(r.pending_reimbursement_amount ?? 0),
        openDisputes: Number(r.open_disputes ?? 0),
        floatCache: Number(r.float_cache ?? 0),
        floatLedger: Number(r.float_ledger ?? 0),
        floatSpendable: Number(r.float_spendable ?? 0),
        reservedFloat: Number(r.reserved_float ?? 0),
        availableFloat: Number(r.available_float ?? 0),
        outOfPocketOutstanding: Number(r.out_of_pocket_outstanding ?? 0),
        netPosition: Number(r.net_position ?? 0),
        state: (r.state === 'OWED' ? 'OWED' : 'FUNDED') as 'OWED' | 'FUNDED',
        settlementCleanPct: r.settlement_clean_pct == null ? null : Number(r.settlement_clean_pct),
        settledCount: Number(r.settled_count ?? 0),
        unsettledCount: Number(r.unsettled_count ?? 0),
        failedSettlements: Number(r.failed_settlements ?? 0),
        maxDailyPayouts: r.max_daily_payouts == null ? null : Number(r.max_daily_payouts),
        currentQueueCount: r.current_queue_count == null ? null : Number(r.current_queue_count),
        capacityUtilizationPct:
          r.capacity_utilization_pct == null ? null : Number(r.capacity_utilization_pct),
        allocationScore: Number(r.allocation_score ?? 0),
        recommendation: (r.recommendation ?? 'insufficient_data') as MerchantFloatAllocationRecommendation,
        reason: String(r.reason ?? ''),
        blocker: r.blocker ?? null,
      }));
    },
  });
}

/**
 * Evidence trail behind one agent's numbers — the exact payout rows plus the
 * general_ledger legs (customer debit, float settlement, telecom) attached to
 * each one, so a float decision can be audited rather than trusted.
 */
export function useMerchantFloatAllocationEvidence(
  agentId: string | null,
  days = 30,
  enabled = true,
) {
  return useQuery({
    queryKey: ['merchant-agent-float-allocation-evidence', agentId, days],
    enabled: enabled && !!agentId,
    retry: false,
    staleTime: 60_000,
    queryFn: async (): Promise<MerchantFloatAllocationEvidenceRow[]> => {
      const { data, error } = await supabase.rpc(
        'merchant_agent_float_allocation_evidence' as any,
        { p_agent_id: agentId, p_days: days },
      );
      if (error) throw error;
      return ((data ?? []) as any[]).map((r) => ({
        withdrawalId: String(r.withdrawal_id),
        createdAt: String(r.created_at),
        status: String(r.status ?? ''),
        settlementState: r.settlement_state ?? null,
        requestAmount: Number(r.request_amount ?? 0),
        customerDebit: Number(r.customer_debit ?? 0),
        floatPrincipal: Number(r.float_principal ?? 0),
        floatTelecom: Number(r.float_telecom ?? 0),
        commissionAmount: Number(r.commission_amount ?? 0),
        hasDebitLeg: !!r.has_debit_leg,
        hasFundingRecord: !!r.has_funding_record,
        hasCommissionAward: !!r.has_commission_award,
        shortfallAmount: Number(r.shortfall_amount ?? 0),
        shortfallKind: r.shortfall_kind ?? null,
        shortfallStatus: r.shortfall_status ?? null,
        ledgerLegIds: Array.isArray(r.ledger_leg_ids) ? r.ledger_leg_ids.map(String) : [],
      }));
    },
  });
}
