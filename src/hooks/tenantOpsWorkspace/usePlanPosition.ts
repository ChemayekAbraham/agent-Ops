/**
 * Reads tops_plan_position() (docs/TOPS_RULES.md: new tops_* RPCs, no
 * arithmetic in the client). total_repayment/duration_days/daily_repayment
 * aren't part of that RPC's return shape (a prior task's scope), so this
 * hook additionally reads those three static, non-computed columns straight
 * from rent_requests — a plain read, not a derived money figure.
 */
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

const anyDb = supabase as any;

export interface TopsPlanPosition {
  rent_request_id: string;
  cadence: 'daily' | 'weekly' | 'unknown';
  cadence_source: 'explicit' | 'unknown';
  clock_start: string | null;
  clock_source: 'landlord_receipt' | 'funded_at' | 'override' | null;
  term_end_date: string | null;
  expected_to_date_ugx: number | null;
  paid_to_date_ugx: number | null;
  position_ugx: number | null;
  periods_due: number | null;
  days_past_due: number | null;
  days_behind: number | null;
  days_ahead: number | null;
  outstanding_ugx: number | null;
  catch_up_daily_ugx: number | null;
  term_expired: boolean | null;
  as_at: string;
  basis: string;
}

export interface PlanTerms {
  total_repayment: number;
  duration_days: number;
  daily_repayment: number;
}

export interface PlanPositionResult extends TopsPlanPosition {
  terms: PlanTerms | null;
}

async function fetchPlanPosition(rentRequestId: string, asAt?: string): Promise<PlanPositionResult> {
  const [{ data: posRows, error: posError }, { data: rr, error: rrError }] = await Promise.all([
    anyDb.rpc('tops_plan_position', { p_rent_request_id: rentRequestId, p_as_at: asAt ?? null }),
    supabase
      .from('rent_requests')
      .select('total_repayment, duration_days, daily_repayment')
      .eq('id', rentRequestId)
      .maybeSingle(),
  ]);

  if (posError) throw posError;
  if (rrError) throw rrError;

  const position: TopsPlanPosition | undefined = Array.isArray(posRows) ? posRows[0] : posRows;
  if (!position) {
    throw new Error('No plan position returned for this rent_request_id');
  }

  return {
    ...position,
    terms: rr
      ? {
          total_repayment: rr.total_repayment,
          duration_days: rr.duration_days,
          daily_repayment: rr.daily_repayment,
        }
      : null,
  };
}

export function usePlanPosition(rentRequestId: string | undefined, asAt?: string) {
  return useQuery({
    queryKey: ['tenantOpsWorkspace', 'planPosition', rentRequestId, asAt ?? null],
    queryFn: () => fetchPlanPosition(rentRequestId as string, asAt),
    enabled: !!rentRequestId,
    staleTime: 60_000,
  });
}
