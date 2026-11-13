import { useQuery } from '@tanstack/react-query';
import { rpc } from './reviewApi';
import type { ReviewSheet, Stage } from './reviewTypes';

/**
 * An answered call already on file for this desk's subject (the tenant at
 * Tenant Ops, the landlord at Landlord Ops), read from
 * `get_awareness_calls_for_request`: the same `rent_pipeline_awareness_calls`
 * rows `pipeline_record_review` checks before it takes a pass.
 *
 * The rule is the server's own: an answered call to the subject recorded no
 * earlier than one day before the request reached this desk (the previous
 * desk's review, or the request's creation). The server checks again on pass.
 */

export type AwarenessCall = {
  subject_type: string | null;
  call_result: string | null;
  recorded_at: string | null;
  caller_name: string | null;
};

export type CallOnFile = { at: string; by: string | null };

/** The desk before each call desk: its review is when the request reached this one. */
const PREVIOUS: Partial<Record<Stage, Stage>> = { tenant_ops: 'agent_ops', landlord_ops: 'tenant_ops' };
const DAY_MS = 24 * 60 * 60 * 1000;

/** When the request reached this desk, from the review sheet: the previous desk's last review, else its creation. */
export function stageSince(sheet: ReviewSheet | undefined, stage: Stage): string | null {
  const prev = PREVIOUS[stage];
  const reviews = (sheet?.history ?? []).filter((h) => h.stage === prev && h.at).map((h) => h.at);
  if (reviews.length > 0) return reviews.sort()[reviews.length - 1];
  return sheet?.request?.created_at ?? null;
}

/** The latest answered call to `subject` the server would count, or null. */
export function answeredCallOnFile(rows: AwarenessCall[], subject: 'tenant' | 'landlord', since: string | null): CallOnFile | null {
  const from = since ? Date.parse(since) - DAY_MS : Number.NEGATIVE_INFINITY;
  const hit = rows
    .filter((c) => c.subject_type === subject && c.call_result === 'answered' && !!c.recorded_at && Date.parse(c.recorded_at) >= from)
    .sort((a, b) => Date.parse(b.recorded_at as string) - Date.parse(a.recorded_at as string))[0];
  return hit ? { at: hit.recorded_at as string, by: hit.caller_name } : null;
}

export const awarenessCallsKey = (requestId: string) => ['desk-feed', 'awareness-calls', requestId] as const;

export function useAwarenessCalls(requestId: string, enabled: boolean) {
  return useQuery({
    queryKey: awarenessCallsKey(requestId),
    enabled,
    queryFn: async (): Promise<AwarenessCall[]> => {
      const { data, error } = await rpc('get_awareness_calls_for_request', { p_rent_request_id: requestId });
      if (error) throw error;
      return ((data as { rows?: AwarenessCall[] } | null)?.rows ?? []) as AwarenessCall[];
    },
    staleTime: 30_000,
    retry: false,
  });
}

/** "10 Nov, 10:58" in Kampala time, as the call history prints it. */
export function callTime(at: string): string {
  return new Date(at).toLocaleString('en-GB', { timeZone: 'Africa/Kampala', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}
