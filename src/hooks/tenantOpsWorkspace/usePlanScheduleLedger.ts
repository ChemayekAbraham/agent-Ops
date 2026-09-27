/** Reads tops_plan_schedule_ledger() — one row per instalment. No client-side arithmetic. */
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

async function fetchPlanScheduleLedger(rentRequestId: string): Promise<PlanScheduleLedgerRow[]> {
  const { data, error } = await anyDb.rpc('tops_plan_schedule_ledger', { p_rent_request_id: rentRequestId });
  if (error) throw error;
  return (data ?? []) as PlanScheduleLedgerRow[];
}

export function usePlanScheduleLedger(rentRequestId: string | undefined) {
  return useQuery({
    queryKey: ['tenantOpsWorkspace', 'planScheduleLedger', rentRequestId],
    queryFn: () => fetchPlanScheduleLedger(rentRequestId as string),
    enabled: !!rentRequestId,
    staleTime: 60_000,
  });
}
