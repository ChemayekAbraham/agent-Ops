/** Reads tops_plan_schedule_ledger(p_rent_request_id, p_limit, p_offset) — one page of instalments, plus tops_plan_schedule_ledger_count() for the total. No client-side arithmetic. */
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

const anyDb = supabase as any;

export interface PlanScheduleSettlement {
  collection_id: string;
  date: string;
  channel: string;
}

export interface PlanScheduleLedgerRow {
  seq: number;
  due_date: string;
  amount_ugx: number;
  settled_ugx: number;
  outstanding_ugx: number;
  running_arrears_ugx: number;
  settled_by: PlanScheduleSettlement[];
  never_billed: boolean;
}

async function fetchPlanScheduleLedgerPage(
  rentRequestId: string,
  limit: number,
  offset: number,
): Promise<{ rows: PlanScheduleLedgerRow[]; totalRowCount: number }> {
  const [{ data, error }, { data: count, error: countError }] = await Promise.all([
    anyDb.rpc('tops_plan_schedule_ledger', { p_rent_request_id: rentRequestId, p_limit: limit, p_offset: offset }),
    anyDb.rpc('tops_plan_schedule_ledger_count', { p_rent_request_id: rentRequestId }),
  ]);
  if (error) throw error;
  if (countError) throw countError;
  return { rows: (data ?? []) as PlanScheduleLedgerRow[], totalRowCount: Number(count ?? 0) };
}

export function usePlanScheduleLedger(rentRequestId: string | undefined, limit: number, offset: number) {
  return useQuery({
    queryKey: ['tenantOpsWorkspace', 'planScheduleLedger', rentRequestId, limit, offset],
    queryFn: () => fetchPlanScheduleLedgerPage(rentRequestId as string, limit, offset),
    enabled: !!rentRequestId,
    staleTime: 60_000,
  });
}
