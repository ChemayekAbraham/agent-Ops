import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type {
  AwarenessCallResult, AwarenessSubject,
} from '@/lib/awarenessCallLabels';

/**
 * The signed-in caller's own awareness calls: a summary and a short recent list for "Your awareness calls".
 * Read-only; the reports only ever return the caller's own calls (auth.uid()), counted on Kampala days.
 */
const anyDb = supabase as any;

export interface MyAwarenessSummary {
  window: { start_day: string; end_day: string; days: number; timezone: string };
  totals: {
    calls: number; answered: number; no_answer: number; phone_off: number; wrong_number: number; answered_pct: number | null;
    people_called: number; people_reached: number; rent_plans_called: number;
    answered_tenant_agent?: number; answered_landlord?: number;
  };
}

export interface MyAwarenessLogRow {
  id: string; rent_request_id: string; plan_code: string; subject_type: AwarenessSubject; subject_name: string; subject_phone: string;
  pipeline_stage: string; current_status: string; call_result: AwarenessCallResult;
  aware_30m?: string | null; aware_merchant_codes?: string | null; landlord_consent?: string | null; aware_payout_otp?: string | null;
  explained?: string | null;
  note: string | null; day: string; dial_started_at: string; recorded_at: string;
}
export interface MyAwarenessLog { total: number; limit: number; offset: number; rows: MyAwarenessLogRow[] }

export const myAwarenessCallsKey = ['my-awareness-calls'] as const;

export function useMyAwarenessSummary(from: string, to: string) {
  return useQuery({
    queryKey: [...myAwarenessCallsKey, 'summary', from, to],
    staleTime: 30_000,
    retry: false,
    queryFn: async (): Promise<MyAwarenessSummary> => {
      const { data, error } = await anyDb.rpc('my_awareness_calls_summary', { p_from: from, p_to: to });
      if (error) throw error;
      return data as MyAwarenessSummary;
    },
  });
}

export function useMyAwarenessLog(from: string, to: string, limit = 5) {
  return useQuery({
    queryKey: [...myAwarenessCallsKey, 'log', from, to, limit],
    staleTime: 30_000,
    retry: false,
    queryFn: async (): Promise<MyAwarenessLog> => {
      const { data, error } = await anyDb.rpc('my_awareness_calls_log', { p_from: from, p_to: to, p_limit: limit, p_offset: 0 });
      if (error) throw error;
      return data as MyAwarenessLog;
    },
  });
}
