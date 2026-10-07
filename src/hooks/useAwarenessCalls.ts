import { useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type {
  AwarenessCallResult, AwarenessChoice, AwarenessSubject, AwarenessTeam, ExplainedChoice,
} from '@/lib/awarenessCallLabels';

/**
 * Awareness calls on the rent pipeline: staff phone the tenant or landlord on a Rent Plan and record what they
 * heard. Storage only (rent_pipeline_awareness_calls); the pipeline's own statuses and approve/reject functions are
 * never touched. Writes go through record_awareness_call, reads through get_awareness_calls_for_request.
 */

export interface AwarenessCall {
  id: string;
  rent_request_id: string;
  subject_type: AwarenessSubject;
  subject_user_id: string | null;
  subject_phone: string;
  caller_id: string;
  caller_team: AwarenessTeam;
  caller_name: string;
  pipeline_stage: string;
  dial_started_at: string;
  recorded_at: string;
  call_result: AwarenessCallResult;
  aware_30m: AwarenessChoice | null;
  aware_merchant_codes: AwarenessChoice | null;
  explained: ExplainedChoice | null;
  note: string | null;
}

export interface AwarenessCallsResult {
  rent_request_id: string;
  total: number;
  rows: AwarenessCall[];
}

export interface RecordAwarenessCallInput {
  rentRequestId: string;
  subject: AwarenessSubject;
  phone: string;
  /** ISO time the dial started. */
  dialStartedAt: string;
  result: AwarenessCallResult;
  /** The person's user id when they have one (a tenant does; a landlord record does not). */
  subjectUserId?: string | null;
  aware30m?: AwarenessChoice | null;
  awareMerchantCodes?: AwarenessChoice | null;
  explained?: ExplainedChoice | null;
  note?: string | null;
}

const anyDb = supabase as any;

export const awarenessCallsKey = (rentRequestId: string | null | undefined) => ['awareness-calls', rentRequestId ?? null] as const;

/** Every awareness call on one Rent Plan. A caller without access gets an error, which the section treats as "hide". */
export function useAwarenessCalls(rentRequestId: string | null | undefined, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: awarenessCallsKey(rentRequestId),
    enabled: Boolean(rentRequestId) && options.enabled !== false,
    staleTime: 15_000,
    retry: false,
    queryFn: async (): Promise<AwarenessCallsResult> => {
      const { data, error } = await anyDb.rpc('get_awareness_calls_for_request', { p_rent_request_id: rentRequestId });
      if (error) throw error;
      return data as AwarenessCallsResult;
    },
  });
}

/** Saves one call and then reads the list again, so the screen always shows what the server holds. */
export function useRecordAwarenessCall() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: RecordAwarenessCallInput) => {
      const answered = input.result === 'answered';
      const { data, error } = await anyDb.rpc('record_awareness_call', {
        p_rent_request_id: input.rentRequestId,
        p_subject_type: input.subject,
        p_subject_phone: input.phone,
        p_dial_started_at: input.dialStartedAt,
        p_call_result: input.result,
        p_subject_user_id: input.subjectUserId ?? null,
        p_aware_30m: answered ? input.aware30m ?? null : null,
        p_aware_merchant_codes: answered ? input.awareMerchantCodes ?? null : null,
        p_explained: answered ? input.explained ?? null : null,
        p_note: input.note?.trim() ? input.note.trim() : null,
      });
      if (error) throw error;
      return data as AwarenessCall & { already_recorded: boolean };
    },
    onSuccess: async (_data, input) => {
      await qc.invalidateQueries({ queryKey: awarenessCallsKey(input.rentRequestId) });
      // the list badges and "Your awareness calls" read the same log
      void qc.invalidateQueries({ queryKey: ['awareness-call-status'] });
      void qc.invalidateQueries({ queryKey: ['my-awareness-calls'] });
    },
  });
}

// ─── The call in progress ────────────────────────────────────────────────────

export interface DialSession {
  subject: AwarenessSubject;
  phone: string;
  /** ISO time the person tapped the call button. */
  dialStartedAt: string;
}

const SESSION_PREFIX = 'awareness-dial:';
/** A dial older than this is forgotten: the call is over and the notes would be a guess. */
const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const sessionKey = (rentRequestId: string) => `${SESSION_PREFIX}${rentRequestId}`;

/** sessionStorage can throw (private windows, blocked storage); the page works without it. */
export function readDialSession(rentRequestId: string, now: number = Date.now()): DialSession | null {
  try {
    const raw = window.sessionStorage.getItem(sessionKey(rentRequestId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<DialSession>;
    const started = parsed.dialStartedAt ? new Date(parsed.dialStartedAt).getTime() : NaN;
    if (!parsed.subject || !parsed.phone || Number.isNaN(started) || now - started > SESSION_MAX_AGE_MS || started > now + 5 * 60_000) {
      window.sessionStorage.removeItem(sessionKey(rentRequestId));
      return null;
    }
    return { subject: parsed.subject, phone: parsed.phone, dialStartedAt: parsed.dialStartedAt! };
  } catch {
    return null;
  }
}

export function writeDialSession(rentRequestId: string, session: DialSession) {
  try { window.sessionStorage.setItem(sessionKey(rentRequestId), JSON.stringify(session)); } catch { /* storage unavailable */ }
}

export function clearDialSession(rentRequestId: string) {
  try { window.sessionStorage.removeItem(sessionKey(rentRequestId)); } catch { /* storage unavailable */ }
}

/**
 * Calls `onReturn` when the person comes back to this page after leaving it (the phone's dialler took over, or they
 * switched app or window). Only listens while `active`, i.e. while a call has been started and not yet recorded.
 */
export function useReturnFromCall(active: boolean, onReturn: () => void) {
  const callback = useRef(onReturn);
  callback.current = onReturn;

  useEffect(() => {
    if (!active) return undefined;
    let away = false;
    const leave = () => { away = true; };
    const back = () => {
      if (away) {
        away = false;
        callback.current();
      }
    };
    const onVisibility = () => (document.visibilityState === 'hidden' ? leave() : back());
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('blur', leave);
    window.addEventListener('focus', back);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('blur', leave);
      window.removeEventListener('focus', back);
    };
  }, [active]);
}
