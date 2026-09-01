/**
 * CRM outbound voice — the live call lifecycle.
 *
 * Architecture (deliberate, and different from the old REST bridge):
 *
 *   browser  →  `crm-voice-capability-token` (server holds the API key)
 *           →  Africa's Talking WebRTC client (one singleton instance)
 *           →  `client.call("+256…")`  — the CRM user talks from the browser
 *           →  `client.hangup()`       — ends the REAL telephone leg
 *
 * Two independent authorities end a call, and whichever arrives first wins:
 *   A. the SDK's `hangup` event (immediate, browser-side)
 *   B. the `crm_call_sessions` row, updated by `crm-voice-callback` from the
 *      Africa's Talking Events URL and streamed here over Supabase Realtime
 *      (`isActive = 0` / `callSessionState = Completed` are authoritative)
 *
 * Finalisation is idempotent in both the UI (`settledRef`) and the database
 * (`crm_finalize_call_from_client` only writes when `ended_at IS NULL`), so
 * duplicate provider callbacks cannot create a second outcome or a second row.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import {
  getVoiceClient,
  hangupVoiceCall,
  muteVoiceCall,
  onVoiceEvent,
  readHangupCause,
  toE164,
} from '@/lib/atVoiceClient';
import type { CalleeRole } from '@/lib/callCentre';

export type CallState =
  | 'idle'
  | 'initializing'
  | 'calling'
  | 'ringing'
  | 'connected'
  | 'ending'
  | 'completed'
  | 'cancelled'
  | 'rejected'
  | 'busy'
  | 'no_answer'
  | 'failed';

const TERMINAL: CallState[] = ['completed', 'cancelled', 'rejected', 'busy', 'no_answer', 'failed'];
export const isTerminalCallState = (s: CallState) => TERMINAL.includes(s);

export interface VoiceCallTarget {
  calleeId: string | null;
  name: string;
  /** Masked or raw — the server resolves and returns the true E.164 number. */
  phone: string | null;
  role: CalleeRole;
  location: string | null;
}

/** DB status → UI state. Mirrors the mapping in `crm-voice-callback`. */
function stateFromDbStatus(status: string, answered: boolean): CallState {
  switch (status) {
    case 'initiating':
      return 'calling';
    case 'ringing':
    case 'ringing_staff':
      return 'ringing';
    case 'active':
    case 'bridged':
    case 'in_progress':
      return 'connected';
    case 'busy':
      return 'busy';
    case 'rejected':
      return 'rejected';
    case 'not_answered':
    case 'notanswered':
      return 'no_answer';
    case 'cancelled':
      return 'cancelled';
    case 'completed':
      return answered ? 'completed' : 'no_answer';
    case 'expired':
    case 'failed':
    case 'bridge_failed':
      return 'failed';
    default:
      return answered ? 'completed' : 'failed';
  }
}

/** Browser hangup cause → UI state. */
function stateFromCause(cause: string | null, answered: boolean): CallState {
  switch ((cause ?? '').toUpperCase()) {
    case 'CALL_REJECTED':
      return 'rejected';
    case 'USER_BUSY':
      return 'busy';
    case 'NO_ANSWER':
    case 'NO_USER_RESPONSE':
    case 'SUBSCRIBER_ABSENT':
      return 'no_answer';
    case 'ORIGINATOR_CANCEL':
      return answered ? 'completed' : 'cancelled';
    case 'SERVICE_UNAVAILABLE':
    case 'USER_NOT_REGISTERED':
    case 'UNALLOCATED_NUMBER':
    case 'NORMAL_TEMPORARY_FAILURE':
    case 'RECOVERY_ON_TIMER_EXPIRE':
      return 'failed';
    default:
      return answered ? 'completed' : 'no_answer';
  }
}

interface TokenBundle {
  token: string;
  clientName: string;
  expiresAt: number;
}

let cachedToken: TokenBundle | null = null;

/** Fetch (or reuse) a capability token. Never logged, never persisted. */
async function fetchCapabilityToken(): Promise<TokenBundle> {
  if (cachedToken && cachedToken.expiresAt - Date.now() > 60_000) return cachedToken;

  const { data, error } = await supabase.functions.invoke('crm-voice-capability-token', { body: {} });
  if (error) {
    const ctx = (error as { context?: Response }).context;
    if (ctx && typeof ctx.json === 'function') {
      const body = (await ctx.json().catch(() => null)) as { message?: string; error?: string } | null;
      if (body?.message || body?.error) throw new Error(body.message ?? body.error!);
    }
    throw error;
  }

  const payload = data as { token?: string; clientName?: string; expiresInSeconds?: number } | null;
  if (!payload?.token) throw new Error('Could not get a voice token.');

  cachedToken = {
    token: payload.token,
    clientName: payload.clientName ?? '',
    expiresAt: Date.now() + Math.max(60, payload.expiresInSeconds ?? 3600) * 1000,
  };
  return cachedToken;
}

export interface UseCrmVoiceCall {
  state: CallState;
  callId: string | null;
  /** Connected talk time in seconds. Only counts from pick-up. */
  elapsed: number;
  hangupCause: string | null;
  error: string | null;
  muted: boolean;
  isEnding: boolean;
  start: (target: VoiceCallTarget) => Promise<void>;
  end: () => void;
  toggleMute: () => void;
  reset: () => void;
}

export function useCrmVoiceCall(): UseCrmVoiceCall {
  const [state, setState] = useState<CallState>('idle');
  const [callId, setCallId] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [hangupCause, setHangupCause] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);

  const callIdRef = useRef<string | null>(null);
  /** Wall-clock mark: a throttled background tab cannot under-count talk time. */
  const connectedAtRef = useRef<number | null>(null);
  const answeredRef = useRef(false);
  /** Guarantees the UI finalises once, whichever signal arrives first. */
  const settledRef = useRef(false);
  const endRequestedRef = useRef(false);
  const readyRef = useRef(false);

  /* ---------------- finalisation (idempotent) ---------------- */
  const finalize = useCallback(
    (next: CallState, cause: string | null, durationOverride?: number | null) => {
      if (settledRef.current) return;
      settledRef.current = true;

      const seconds =
        durationOverride != null && durationOverride > 0
          ? durationOverride
          : connectedAtRef.current != null
            ? Math.floor((Date.now() - connectedAtRef.current) / 1000)
            : 0;

      connectedAtRef.current = null;
      setElapsed(seconds);
      setHangupCause(cause);
      setState(next);

      const id = callIdRef.current;
      if (!id) return;
      // The DB write is itself idempotent: it is a no-op once `ended_at` is set,
      // so a webhook that already finalised the row is never overwritten.
      void supabase
        .rpc('crm_finalize_call_from_client', {
          p_session_id: id,
          p_hangup_cause: cause,
          p_duration: seconds,
        })
        .then(({ error: rpcErr }) => {
          if (rpcErr) console.error('[useCrmVoiceCall] finalize failed', rpcErr.message);
        });
    },
    [],
  );

  /* ---------------- SDK events ---------------- */
  useEffect(() => {
    const offReady = onVoiceEvent('ready', () => {
      readyRef.current = true;
    });
    const offNotReady = onVoiceEvent('notready', () => {
      readyRef.current = false;
    });

    const offCalling = onVoiceEvent('calling', () => {
      if (settledRef.current || !callIdRef.current) return;
      setState((prev) => (prev === 'connected' ? prev : 'ringing'));
    });

    const offAccepted = onVoiceEvent('callaccepted', () => {
      if (settledRef.current || !callIdRef.current) return;
      answeredRef.current = true;
      connectedAtRef.current = Date.now();
      setElapsed(0);
      setState('connected');
      void supabase.rpc('crm_mark_call_answered', { p_session_id: callIdRef.current });
    });

    // THE authoritative browser-side end-of-call signal. Fires for our own
    // hangup() AND for the customer hanging up their handset.
    const offHangup = onVoiceEvent('hangup', (payload) => {
      if (!callIdRef.current) return;
      const { reason } = readHangupCause(payload);
      const cause = reason ?? (endRequestedRef.current ? 'ORIGINATOR_CANCEL' : 'NORMAL_CLEARING');
      finalize(stateFromCause(cause, answeredRef.current), cause);
    });

    const offOffline = onVoiceEvent('offline', () => {
      readyRef.current = false;
      cachedToken = null; // token expired — force a fresh one next call
      if (callIdRef.current && !settledRef.current) {
        finalize('failed', 'SERVICE_UNAVAILABLE');
        setError('The voice connection expired. Try the call again.');
      }
    });

    const offClosed = onVoiceEvent('closed', () => {
      readyRef.current = false;
      if (callIdRef.current && !settledRef.current) {
        finalize('failed', 'SERVICE_UNAVAILABLE');
        setError('Lost the connection to the voice service.');
      }
    });

    return () => {
      offReady();
      offNotReady();
      offCalling();
      offAccepted();
      offHangup();
      offOffline();
      offClosed();
    };
  }, [finalize]);

  /* ---------------- Realtime: the backend is the second authority ---------- */
  useEffect(() => {
    if (!callId) return;

    const channel = supabase
      .channel(`crm-call-${callId}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'crm_call_sessions', filter: `id=eq.${callId}` },
        (payload) => {
          const row = payload.new as {
            status: string | null;
            is_active: boolean | null;
            hangup_cause: string | null;
            duration_seconds: number | null;
            answered_at: string | null;
            ended_at: string | null;
          };

          if (row.answered_at && !answeredRef.current && !settledRef.current) {
            answeredRef.current = true;
            connectedAtRef.current = Date.now() - (row.duration_seconds ?? 0) * 1000;
            setState('connected');
          }

          const status = (row.status ?? '').toLowerCase();
          const ended = row.ended_at != null || row.is_active === false;
          if (!ended) {
            if (!settledRef.current && (status === 'ringing' || status === 'ringing_staff')) {
              setState((prev) => (prev === 'connected' ? prev : 'ringing'));
            }
            return;
          }

          // Authoritative end (Completed / isActive=0) — even if the browser
          // hangup event never arrived.
          finalize(
            stateFromDbStatus(status, answeredRef.current || (row.duration_seconds ?? 0) > 0),
            row.hangup_cause,
            row.duration_seconds,
          );
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [callId, finalize]);

  /* ---------------- talk-time ticker ---------------- */
  useEffect(() => {
    if (state !== 'connected') return;
    const id = window.setInterval(() => {
      if (connectedAtRef.current != null) {
        setElapsed(Math.floor((Date.now() - connectedAtRef.current) / 1000));
      }
    }, 250);
    return () => window.clearInterval(id);
  }, [state]);

  /* ---------------- start ---------------- */
  const start = useCallback(async (target: VoiceCallTarget) => {
    settledRef.current = false;
    endRequestedRef.current = false;
    answeredRef.current = false;
    connectedAtRef.current = null;
    callIdRef.current = null;
    setCallId(null);
    setElapsed(0);
    setHangupCause(null);
    setError(null);
    setMuted(false);
    setState('initializing');

    try {
      const bundle = await fetchCapabilityToken();
      // One client for the whole app: constructing per render would kill the call.
      const client = getVoiceClient(bundle.token);

      // Wait briefly for registration; the SDK cannot dial before it is ready.
      if (!readyRef.current) {
        await new Promise<void>((resolve) => {
          const off = onVoiceEvent('ready', () => {
            off();
            window.clearTimeout(timer);
            resolve();
          });
          const timer = window.setTimeout(() => {
            off();
            resolve(); // dial anyway — the SDK queues, and a hangup event will tell us
          }, 8000);
        });
      }

      const { data, error: rpcErr } = await supabase.rpc('crm_start_webrtc_call', {
        p_target_user_id: target.calleeId && !target.calleeId.startsWith('unknown-') ? target.calleeId : null,
        p_target_name: target.name,
        p_target_role: target.role,
        p_target_location: target.location,
        p_client_name: bundle.clientName,
        p_target_phone: toE164(target.phone) ?? null,
      });
      if (rpcErr) throw new Error(rpcErr.message);

      const row = data as { session_id?: string; target_phone?: string } | null;
      const dest = toE164(row?.target_phone ?? null);
      if (!row?.session_id || !dest) throw new Error('That number cannot be dialled.');

      callIdRef.current = row.session_id;
      setCallId(row.session_id);
      setState('calling');

      // The real call. Africa's Talking rings the customer; our callback URL
      // bridges the browser leg to them.
      client.call(dest);
    } catch (e) {
      const message =
        e instanceof Error && e.message
          ? e.message === 'not_authorized'
            ? 'You are not authorised to place CRM calls.'
            : e.message
          : 'Could not start the call.';
      settledRef.current = true;
      setError(message);
      setState('failed');
    }
  }, []);

  /* ---------------- end (the real hangup) ---------------- */
  const end = useCallback(() => {
    if (settledRef.current || endRequestedRef.current) return;
    endRequestedRef.current = true;
    setState('ending');

    // Flag the row first: the callback then refuses to bridge, and the row is
    // attributable to the CRM user even if the SDK event is delayed.
    if (callIdRef.current) {
      void supabase.rpc('crm_cancel_call', { p_session_id: callIdRef.current });
    }

    // THE actual telephone hangup — the SDK's own method on the live leg.
    const invoked = hangupVoiceCall();

    if (!invoked) {
      // No live client (e.g. the leg never registered): finalise locally so the
      // row cannot be stranded as in-progress.
      finalize(answeredRef.current ? 'completed' : 'cancelled', 'ORIGINATOR_CANCEL');
      return;
    }

    // Otherwise wait for confirmation — the SDK `hangup` event or the Events
    // webhook. A safety net closes the UI if neither arrives.
    window.setTimeout(() => {
      if (!settledRef.current) {
        finalize(answeredRef.current ? 'completed' : 'cancelled', 'ORIGINATOR_CANCEL');
      }
    }, 6000);
  }, [finalize]);

  const toggleMute = useCallback(() => {
    setMuted((prev) => {
      const next = !prev;
      muteVoiceCall(next);
      return next;
    });
  }, []);

  const reset = useCallback(() => {
    settledRef.current = false;
    endRequestedRef.current = false;
    answeredRef.current = false;
    connectedAtRef.current = null;
    callIdRef.current = null;
    setCallId(null);
    setState('idle');
    setElapsed(0);
    setHangupCause(null);
    setError(null);
    setMuted(false);
  }, []);

  /* --- Never leave a live call running when the screen goes away. --- */
  useEffect(
    () => () => {
      if (callIdRef.current && !settledRef.current) {
        const id = callIdRef.current;
        hangupVoiceCall();
        void supabase.rpc('crm_finalize_call_from_client', {
          p_session_id: id,
          p_hangup_cause: 'ORIGINATOR_CANCEL',
          p_duration:
            connectedAtRef.current != null
              ? Math.floor((Date.now() - connectedAtRef.current) / 1000)
              : 0,
        });
      }
    },
    [],
  );

  return {
    state,
    callId,
    elapsed,
    hangupCause,
    error,
    muted,
    isEnding: state === 'ending',
    start,
    end,
    toggleMute,
    reset,
  };
}
