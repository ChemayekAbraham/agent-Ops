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
import { useInvalidateCallViews } from '@/hooks/useCrmCallCentre';
import { useCriticalFlow, useLeavePageWarning } from '@/hooks/useCriticalFlow';
import { reportClientError } from '@/lib/errorReporting';
import {
  getVoiceClient,
  isVoiceClientReady,
  resetVoiceClient,
  stopVoiceMedia,
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

/**
 * Confirm the browser will actually give us a microphone.
 *
 * The SDK needs one to register. Without this check a denied or missing mic
 * surfaces as "the call just never connected" - which is exactly how it
 * presented: a session row, no provider session, and nothing on screen to
 * explain it. Asking first turns that into a sentence the agent can act on.
 *
 * The track is stopped immediately; this is a permission probe, not a capture.
 */
async function assertMicrophone(): Promise<void> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('This browser cannot place calls - it has no microphone support.');
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
  } catch (err) {
    const name = (err as { name?: string })?.name ?? '';
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      throw new Error(
        'Microphone access is blocked. Allow the microphone for this site in your browser settings, then try again.',
      );
    }
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
      throw new Error('No microphone was found. Plug one in, then try again.');
    }
    throw new Error('Could not access the microphone, so the call cannot be placed.');
  }
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

  /* ---------------- finalisation (idempotent) ---------------- */
  const invalidateCallViews = useInvalidateCallViews();

  const finalize = useCallback(
    (next: CallState, cause: string | null, durationOverride?: number | null) => {
      if (settledRef.current) return;
      settledRef.current = true;

      // Whatever ended this call - our cancel, their hang-up, a failure - the
      // audio stops HERE. Doing it in `end()` alone missed every path where
      // the far side or the network ended the call first.
      stopVoiceMedia();

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
          // The row has changed; the lists showing it have not been told.
          // Without this the call still reads as in progress until the page is
          // reloaded, which is exactly how it was reported.
          invalidateCallViews();
        });
    },
    [invalidateCallViews],
  );

  /* ---------------- SDK events ---------------- */
  useEffect(() => {
    // `ready` / `notready` now update module-level state inside atVoiceClient,
    // so nothing needs mirroring here.
    const offNotReady = onVoiceEvent('notready', () => {
      // Registration dropped. Discarding the instance is what makes the next
      // call rebuild instead of dialling into a dead socket.
      resetVoiceClient();
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
      cachedToken = null; // token expired — force a fresh one next call
      // A client that went offline never recovers on its own, and it would
      // otherwise be handed back by token match for the rest of the hour.
      resetVoiceClient();
      if (callIdRef.current && !settledRef.current) {
        finalize('failed', 'SERVICE_UNAVAILABLE');
        setError('The voice connection expired. Try the call again.');
      }
    });

    const offClosed = onVoiceEvent('closed', () => {
      resetVoiceClient();
      if (callIdRef.current && !settledRef.current) {
        finalize('failed', 'SERVICE_UNAVAILABLE');
        setError('Lost the connection to the voice service.');
      }
    });

    return () => {
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
      // A missing microphone is the cheapest failure to detect and the one that
      // otherwise looks identical to every other silent failure.
      await assertMicrophone();

      const bundle = await fetchCapabilityToken();
      // One client for the whole app: constructing per render would kill the call.
      const client = getVoiceClient(bundle.token);

      // Wait for registration. Readiness is read from the client itself rather
      // than a per-mount ref, so a remount no longer waits on a `ready` event
      // that already fired and will never be re-emitted.
      if (!isVoiceClientReady()) {
        await new Promise<void>((resolve) => {
          const off = onVoiceEvent('ready', () => {
            off();
            window.clearTimeout(timer);
            resolve();
          });
          const timer = window.setTimeout(() => {
            off();
            resolve();
          }, 8000);
        });
      }

      // THE GATE. This used to fall through and dial anyway, on the assumption
      // that the SDK would queue the call and a hangup event would report any
      // problem. Neither holds when the client never registered: nothing is
      // queued and no event ever arrives. What it did produce was a session row
      // - created below, before the dial - that stayed 'initiating' forever
      // while the callee's phone never rang. 101 sessions were sitting like
      // that, the oldest for three weeks.
      //
      // Refusing here means the row is never written and the agent is told
      // immediately, instead of watching a call that was never placed.
      if (!isVoiceClientReady()) {
        // The instance is unusable; discard it so the next attempt builds a
        // fresh one rather than reusing this for the rest of the token's hour.
        resetVoiceClient();
        throw new Error(
          'Your browser is not connected to the voice service. Reload the page and try again.',
        );
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
  /* ---------------- the server as a second witness ---------------- */
  /**
   * Watch the telephony row while a call is live.
   *
   * The SDK's `hangup` event was the ONLY way this hook learned a call had
   * ended, and it is not dependable. When the person being called rejects,
   * Africa's Talking reports it to `crm-voice-callback`, the row is updated -
   * and the screen carried on saying "ringing", because nothing here was
   * reading the row. There was no timeout either, so it said "ringing" until
   * the page was reloaded.
   *
   * The two signals are independent on purpose: the browser hears about a
   * hangup over the WebRTC socket, the server hears about it over the
   * provider's webhook. Either one is now enough to settle the call, and
   * `finalize` is idempotent so whichever arrives first wins and the other is
   * a no-op.
   */
  useEffect(() => {
    if (!callId || settledRef.current) return;

    let cancelled = false;
    const LIVE_STATUSES = new Set([
      'initiating', 'queued', 'ringing', 'ringing_staff', 'bridged', 'in_progress', 'active',
    ]);

    const tick = async () => {
      if (cancelled || settledRef.current) return;
      const { data, error: qErr } = await supabase
        .from('crm_call_sessions')
        .select('status, hangup_cause, duration_seconds, answered_at')
        .eq('id', callId)
        .maybeSingle();
      if (cancelled || qErr || !data || settledRef.current) return;

      const status = (data.status ?? '').toLowerCase();

      // ANSWERED, FROM WHICHEVER SIDE NOTICES FIRST.
      //
      // `answered_at` was only ever written by the browser, off the SDK's
      // `callaccepted` event, and that event runs late - measured at 24s and
      // 38s after dialling on two calls today. The person picks up and talks
      // while the Call Centre still shows it ringing.
      //
      // `crm-voice-callback` already records the answer the moment the provider
      // bridges the legs; nothing was reading it. Now it is, within one poll.
      if (data.answered_at && !answeredRef.current) {
        answeredRef.current = true;
        // Anchor the talk timer on the SERVER's answer time, not on when this
        // poll happened to notice. Otherwise every second of polling lag is a
        // second of conversation missing from the duration.
        const answeredMs = new Date(data.answered_at).getTime();
        connectedAtRef.current =
          Number.isFinite(answeredMs) && answeredMs > 0 ? answeredMs : Date.now();
        setState((prev) => (prev === 'connected' ? prev : 'connected'));
      }

      if (!LIVE_STATUSES.has(status)) {
        // The provider has reported an outcome. Take its cause over a guess.
        const cause = data.hangup_cause ?? 'NORMAL_CLEARING';
        finalize(
          stateFromCause(cause, Boolean(data.answered_at) || answeredRef.current),
          cause,
          data.duration_seconds ?? null,
        );
      }
    };

    const id = window.setInterval(tick, 2000);
    void tick();
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [callId, finalize]);

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

    // Brief grace for the SDK's `hangup` event, which carries the true cause.
    // It used to be six seconds, on the assumption the event would arrive. When
    // it does not - and with this integration it frequently does not - the user
    // stares at a call that says "ending" and reaches for the reload button.
    //
    // 1.5s is long enough for a healthy event and short enough not to read as
    // broken. The user asked to hang up, so ORIGINATOR_CANCEL is the right
    // answer anyway; the event only ever supplied a more precise one.
    window.setTimeout(() => {
      if (!settledRef.current) {
        finalize(answeredRef.current ? 'completed' : 'cancelled', 'ORIGINATOR_CANCEL');
      }
    }, 1500);
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

  /* --- A call that is connecting, ringing or connected is live work. ---
   * While it is, nothing may interrupt the screen it is on (the "new version" prompt, the install nag), and the
   * browser asks "leave this page?" before a reload, a tab close or a pull-down refresh. */
  const live = state !== 'idle' && !isTerminalCallState(state);
  useCriticalFlow('voice-call', live);
  useLeavePageWarning(live);

  /* --- Never leave a live call running when the screen goes away. --- */
  useEffect(
    () => () => {
      if (callIdRef.current && !settledRef.current) {
        const id = callIdRef.current;
        const seconds =
          connectedAtRef.current != null ? Math.floor((Date.now() - connectedAtRef.current) / 1000) : 0;
        // Record WHY it ended, so the cases where a screen being removed hung a call up can be counted. The call
        // record's own rules are untouched: this is a separate note, never part of the outcome.
        void reportClientError({
          source: 'manual',
          label: 'call-screen-removed',
          message: 'A live call was hung up because its screen was removed (reason: screen_removed)',
          extra: {
            reason: 'screen_removed',
            call_session_id: id,
            answered: answeredRef.current,
            talk_seconds: seconds,
          },
        });
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
