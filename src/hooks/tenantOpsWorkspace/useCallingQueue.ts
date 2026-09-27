/**
 * Reads the EXISTING calling engine through its existing RPCs, called with
 * the exact same parameter shape src/hooks/useCcCallingHub.ts already uses
 * (cc_call_queue_page, cc_state_counts) — no cc_ object is touched. The one
 * addition is re-ordering the already-fetched page by money at risk
 * (tops_plan_position, via the new batched tops_calling_money_at_risk), since
 * the existing RPC's own sort options don't know that concept. This reorders
 * only the rows already on this page — it does not change what the server's
 * own search/state/pagination decided belongs on it.
 */
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

const anyDb = supabase as any;

export type CcRowState = 'to_call' | 'engaged' | 'unreachable' | 'callback' | 'parked';

export interface CallingQueueRow {
  cycleRowId: string;
  tenantId: string;
  state: CcRowState;
  name: string;
  district: string | null;
  linkedAgentName: string | null;
  attemptsMade: number;
  lastAttemptAt: string | null;
  callbackDueAt: string | null;
  metricLabel: string;
  metricValue: number | null;
  rentRequestId: string | null;
  moneyAtRiskUgx: number | null;
}

const PAGE_SIZE = 50;

async function fetchQueuePage(state: CcRowState, search: string, page: number): Promise<{ rows: CallingQueueRow[]; total: number }> {
  const { data, error } = await anyDb.rpc('cc_call_queue_page', {
    p_subject_type: 'tenant',
    p_state: state,
    p_sort_key: null,
    p_search: search.trim() || null,
    p_limit: PAGE_SIZE,
    p_offset: page * PAGE_SIZE,
    p_filters: null,
  });
  if (error) throw error;

  const list = (data ?? []) as Record<string, any>[];
  const total = list.length ? Number(list[0].total_count ?? 0) : 0;

  const tenantIds = list.map((r) => String(r.subject_id));
  let riskByTenant = new Map<string, { rentRequestId: string | null; moneyAtRiskUgx: number | null }>();
  if (tenantIds.length > 0) {
    const { data: risk, error: riskError } = await anyDb.rpc('tops_calling_money_at_risk', { p_tenant_ids: tenantIds });
    if (riskError) throw riskError;
    riskByTenant = new Map(
      (risk ?? []).map((r: any) => [
        String(r.tenant_id),
        { rentRequestId: r.rent_request_id ?? null, moneyAtRiskUgx: r.money_at_risk_ugx != null ? Number(r.money_at_risk_ugx) : null },
      ]),
    );
  }

  const rows: CallingQueueRow[] = list.map((r) => {
    const risk = riskByTenant.get(String(r.subject_id));
    return {
      cycleRowId: String(r.cycle_row_id),
      tenantId: String(r.subject_id),
      state: r.state as CcRowState,
      name: (r.name as string) || 'Unnamed',
      district: (r.district as string) ?? null,
      linkedAgentName: (r.linked_agent_name as string) ?? null,
      attemptsMade: Number(r.attempts_made ?? 0),
      lastAttemptAt: (r.last_attempt_at as string) ?? null,
      callbackDueAt: (r.callback_due_at as string) ?? null,
      metricLabel: (r.metric_label as string) || 'Metric',
      metricValue: r.metric_value != null ? Number(r.metric_value) : null,
      rentRequestId: risk?.rentRequestId ?? null,
      moneyAtRiskUgx: risk?.moneyAtRiskUgx ?? null,
    };
  });

  // Reorder this page only — highest money at risk first.
  rows.sort((a, b) => (b.moneyAtRiskUgx ?? -1) - (a.moneyAtRiskUgx ?? -1));

  return { rows, total };
}

export function useCallingQueue(state: CcRowState, search: string, page: number) {
  return useQuery({
    queryKey: ['tenantOpsWorkspace', 'callingQueue', state, search, page],
    queryFn: () => fetchQueuePage(state, search, page),
    staleTime: 15_000,
  });
}

export async function fetchCallingStateCounts(search: string): Promise<Record<string, number>> {
  const { data, error } = await anyDb.rpc('cc_state_counts', {
    p_subject_type: 'tenant',
    p_filters: null,
    p_search: search.trim() || null,
  });
  if (error) throw error;
  const out: Record<string, number> = {};
  for (const r of (data ?? []) as Record<string, unknown>[]) {
    out[String(r.state)] = Number(r.row_count ?? 0);
  }
  return out;
}

export function useCallingStateCounts(search: string) {
  return useQuery({
    queryKey: ['tenantOpsWorkspace', 'callingStateCounts', search],
    queryFn: () => fetchCallingStateCounts(search),
    staleTime: 15_000,
  });
}
