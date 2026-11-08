import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { PlanDetail, RepaymentPlanRow } from '@/lib/tenantRepaymentTracker';

// The tracker's database functions (migration 20261108090000) are newer than the generated types.
const db = supabase as any;

const num = (v: unknown) => (v === null || v === undefined || v === '' ? 0 : Number(v));
const numOrNull = (v: unknown) => (v === null || v === undefined || v === '' ? null : Number(v));

/** Postgres numerics arrive as strings; make every money field a number once, here. */
export function normaliseRow(r: Record<string, unknown>): RepaymentPlanRow {
  return {
    ...(r as unknown as RepaymentPlanRow),
    principal: num(r.principal), access_fee: num(r.access_fee), request_fee: num(r.request_fee), fees: num(r.fees),
    obligation: num(r.obligation), disbursed: numOrNull(r.disbursed), verified_collected: num(r.verified_collected),
    money_in_collected: num(r.money_in_collected), pre_cutoff_collected: num(r.pre_cutoff_collected),
    receipts_count: num(r.receipts_count), reversed_amount: num(r.reversed_amount), reversed_count: num(r.reversed_count),
    ledger_backed_amount: num(r.ledger_backed_amount), unverified_amount: num(r.unverified_amount), unverified_count: num(r.unverified_count),
    stored_repaid: num(r.stored_repaid), stored_outstanding: num(r.stored_outstanding), calc_outstanding: num(r.calc_outstanding),
    progress_pct: numOrNull(r.progress_pct), repaid_without_receipts: num(r.repaid_without_receipts),
    manual_reduction_total: num(r.manual_reduction_total), manual_reduction_count: num(r.manual_reduction_count),
    unreceipted_repaid_increase: num(r.unreceipted_repaid_increase), obligation_reduced: num(r.obligation_reduced),
    books_receivable: numOrNull(r.books_receivable), receipts_not_posted: num(r.receipts_not_posted),
    expected_to_date: numOrNull(r.expected_to_date), arrears: numOrNull(r.arrears), days_behind: numOrNull(r.days_behind),
    duration_days: numOrNull(r.duration_days), is_legacy: Boolean(r.is_legacy),
    exceptions: Array.isArray(r.exceptions) ? (r.exceptions as string[]) : [],
  };
}

/** The register: one row per funded Rent Plan. Read-only; loaded on demand and cached for 5 minutes. */
export function useTenantRepaymentRegister() {
  return useQuery({
    queryKey: ['cfo-tenant-repayment-register'],
    staleTime: 5 * 60_000,
    retry: false,
    queryFn: async () => {
      const { data, error } = await db.rpc('get_cfo_tenant_repayment_register');
      if (error) throw error;
      return { asAt: new Date(), rows: ((data ?? []) as Record<string, unknown>[]).map(normaliseRow) };
    },
  });
}

/** One plan: receipts, repayment records, balance adjustments and ledger entries. */
export function useTenantRepaymentDetail(rentRequestId: string | null) {
  return useQuery({
    queryKey: ['cfo-tenant-repayment-detail', rentRequestId],
    enabled: !!rentRequestId,
    staleTime: 60_000,
    retry: false,
    queryFn: async () => {
      const { data, error } = await db.rpc('get_cfo_tenant_repayment_detail', { p_rent_request_id: rentRequestId });
      if (error) throw error;
      const d = data as PlanDetail;
      return { ...d, money_in: d.money_in ?? [], plan: normaliseRow(d.plan as unknown as Record<string, unknown>) } as PlanDetail;
    },
  });
}
