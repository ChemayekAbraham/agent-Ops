/** Follow-ups on short Rent Plans: reads the latest one per plan (tops_shortfall_followups_latest) and records a new one (tops_record_shortfall_followup). The log is append-only; nothing here touches money. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

const anyDb = supabase as any;

export type ShortfallFollowupOutcome =
  | 'reached_will_pay'
  | 'reached_refused'
  | 'no_answer'
  | 'wrong_number'
  | 'agent_informed';

/** Side-panel filter. Applied by the server (tops_shortfall_detail_v3) so paging and totals stay correct. */
export type ShortfallFollowupFilter = 'all' | 'not_followed_up' | 'promised' | 'promise_passed';

export interface ShortfallFollowupLatest {
  rent_request_id: string;
  followup_id: string;
  outcome: ShortfallFollowupOutcome;
  note: string;
  /** yyyy-MM-dd, only ever set for reached_will_pay. */
  promised_date: string | null;
  created_at: string;
  actor_id: string;
  actor_name: string | null;
  followup_count: number;
}

export interface RecordShortfallFollowupInput {
  rentRequestId: string;
  outcome: ShortfallFollowupOutcome;
  note: string;
  /** yyyy-MM-dd; only valid with reached_will_pay. */
  promisedDate?: string | null;
}

/** tops_shortfall_followups_latest accepts at most this many Rent Plan ids per call. */
export const FOLLOWUP_LOOKUP_CHUNK = 1000;

const QUERY_ROOT = ['tenantOpsWorkspace', 'shortfallFollowups'] as const;

function mapLatest(r: Record<string, any>): ShortfallFollowupLatest {
  return {
    rent_request_id: String(r.rent_request_id),
    followup_id: String(r.followup_id),
    outcome: r.outcome as ShortfallFollowupOutcome,
    note: String(r.note ?? ''),
    promised_date: r.promised_date ?? null,
    created_at: String(r.created_at),
    actor_id: String(r.actor_id),
    actor_name: r.actor_name ?? null,
    followup_count: Number(r.followup_count ?? 1),
  };
}

/** Latest follow-up per Rent Plan, keyed by rent_request_id. Plans never followed up are absent. */
export async function fetchShortfallFollowupsLatest(
  rentRequestIds: string[],
): Promise<Record<string, ShortfallFollowupLatest>> {
  const unique = Array.from(new Set(rentRequestIds));
  const out: Record<string, ShortfallFollowupLatest> = {};
  for (let i = 0; i < unique.length; i += FOLLOWUP_LOOKUP_CHUNK) {
    const { data, error } = await anyDb.rpc('tops_shortfall_followups_latest', {
      p_rent_request_ids: unique.slice(i, i + FOLLOWUP_LOOKUP_CHUNK),
    });
    if (error) throw error;
    for (const raw of (data ?? []) as Record<string, any>[]) {
      const row = mapLatest(raw);
      out[row.rent_request_id] = row;
    }
  }
  return out;
}

export function useShortfallFollowupsLatest(rentRequestIds: string[], enabled = true) {
  const key = [...rentRequestIds].sort().join(',');
  return useQuery({
    queryKey: [...QUERY_ROOT, key],
    queryFn: () => fetchShortfallFollowupsLatest(rentRequestIds),
    enabled: enabled && rentRequestIds.length > 0,
    staleTime: 30_000,
  });
}

export function useRecordShortfallFollowup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: RecordShortfallFollowupInput) => {
      const { data, error } = await anyDb.rpc('tops_record_shortfall_followup', {
        p_rent_request_id: input.rentRequestId,
        p_outcome: input.outcome,
        p_note: input.note,
        p_promised_date: input.promisedDate ?? null,
      });
      if (error) throw error;
      return data as Record<string, any>;
    },
    onSuccess: () => {
      // The latest-follow-up line, and any list filtered by follow-up state, are now stale.
      void qc.invalidateQueries({ queryKey: QUERY_ROOT });
      void qc.invalidateQueries({ queryKey: ['tenantOpsWorkspace', 'shortfallDetail'] });
    },
  });
}
