/**
 * Tenant Calling Center — the dialer adapter.
 *
 * This file adds NO new calling infrastructure and NO new call/tenant data:
 *
 *  - the queue, statuses, comments, follow-ups, WIP guard and outcome writes all
 *    come from `useCcCallingHub('tenant', …)` — the very hook the existing Tenant
 *    Calling Hub uses. Nothing in that hook (or the Hub) is modified.
 *  - the real telephone leg comes from `useCrmVoiceCall` — the CRM Calling
 *    Centre's browser WebRTC stack — used unchanged. Phone numbers are resolved
 *    server-side by `crm_start_webrtc_call` from the tenant's user id; the
 *    provider key never reaches the browser.
 *
 * The only thing this hook owns is the *sequence*: which tenant is on the line,
 * and (in attended auto mode) who is next.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  ccErrorText,
  type CcCallingHub,
  type CcOutcome,
  type CcRow,
} from '@/hooks/useCcCallingHub';
import { isTerminalCallState, useCrmVoiceCall, type CallState } from '@/hooks/useCrmVoiceCall';
import { hangupVoiceCall } from '@/lib/atVoiceClient';

/** Attended sequential run states. Nothing dials without an officer starting it. */
export type AutoMode = 'off' | 'running' | 'paused' | 'awaiting_outcome' | 'finished';

export const AUTO_CAP_CHOICES = [5, 10, 25, 50];
export const DEFAULT_AUTO_CAP = 10;

export interface DialSubject {
  rowId: string;
  subjectId: string;
  name: string;
  district: string | null;
  attemptId: string;
  /** Revealed by the same `cc_reveal_phone` path the Hub uses. */
  phone: string | null;
  /** The queue row exactly as the shared hub returned it (context only). */
  row: CcRow;
}

/**
 * Suggested cc outcome for a call that never became a conversation. It is only a
 * suggestion: the officer can record any outcome the Hub allows.
 * `null` means "do not assume anything" (e.g. the officer cancelled).
 */
export function suggestedOutcome(state: CallState): CcOutcome | null {
  switch (state) {
    case 'no_answer':
      return 'no_answer';
    case 'busy':
      return 'no_answer';
    case 'rejected':
      return 'refused';
    case 'failed':
      return 'phone_off';
    default:
      return null;
  }
}

export function useTenantCallCenterDialer(hub: CcCallingHub) {
  const call = useCrmVoiceCall();

  const [current, setCurrent] = useState<DialSubject | null>(null);
  const [starting, setStarting] = useState(false);
  /** True once the leg has settled and no outcome has been written yet. */
  const [needsOutcome, setNeedsOutcome] = useState(false);

  const [mode, setMode] = useState<AutoMode>('off');
  const [queue, setQueue] = useState<CcRow[]>([]);
  const [index, setIndex] = useState(0);
  const [cap, setCap] = useState(DEFAULT_AUTO_CAP);

  const modeRef = useRef<AutoMode>('off');
  modeRef.current = mode;
  const settledRef = useRef(false);
  /** Set when End Call is pressed before the telephone leg exists. */
  const abortRef = useRef(false);

  /** Pending hang-up retries, so they can never land on a LATER call. */
  const dropTimersRef = useRef<number[]>([]);
  /** Live view of the leg state, so a retry chain stops the moment it really ends. */
  const stateRef = useRef<CallState>('idle');
  stateRef.current = call.state;

  const cancelDropRetries = useCallback(() => {
    dropTimersRef.current.forEach((t) => window.clearTimeout(t));
    dropTimersRef.current = [];
  }, []);

  /**
   * Insist on the real telephone hang-up.
   *
   * `hangup()` is a no-op while the SDK has not yet attached the outbound leg —
   * the moment right after `client.call()` — which is exactly when an officer's
   * End Call used to be swallowed and the tenant's phone kept ringing. So it is
   * re-issued a few times, and each retry stops as soon as the leg is genuinely
   * terminal.
   *
   * The voice client is an app-wide singleton, so the retries MUST be
   * cancellable: a chain left running would hang up whichever call is live next
   * (the sequential run's following tenant). They are cleared here and again
   * whenever a new dial starts.
   *
   * NOTE: this deliberately does NOT close the session row. Writing `ended_at`
   * early is what broke termination: `crm-voice-callback` only answers the
   * provider with `<Hangup/>` while the row is NOT already ended, so closing the
   * row first told the UI "ended" and simultaneously threw away the one
   * instruction that drops the live leg. Closing the row stays with the voice
   * hook's own confirmed finalise (SDK `hangup` event, provider webhook, or its
   * safety net) — the same path the CRM dialer uses.
   */
  const insistHangup = useCallback(() => {
    cancelDropRetries();
    hangupVoiceCall();
    [300, 700, 1400, 2500, 4000].forEach((delay) => {
      dropTimersRef.current.push(
        window.setTimeout(() => {
          if (isTerminalCallState(stateRef.current) || stateRef.current === 'idle') return;
          hangupVoiceCall();
        }, delay),
      );
    });
  }, [cancelDropRetries]);

  /** Nothing may keep hanging up after the screen goes away. */
  useEffect(() => cancelDropRetries, [cancelDropRetries]);

  /**
   * The pending dial has become a real session after an End Call press: drop it
   * now. Without this the tenant's phone rings on after the officer hung up.
   * `end()` raises the provider cancel flag (so the callback answers `<Hangup/>`)
   * and finalises once, on confirmation.
   */
  useEffect(() => {
    if (!abortRef.current || starting || !call.callId) return;
    abortRef.current = false;
    call.end();
    insistHangup();
  }, [call, starting, insistHangup]);

  const openAttemptIds = useMemo(
    () => new Set(hub.openAttempts.map((a) => a.id)),
    [hub.openAttempts],
  );

  /** The Hub's own open-attempt list is the authority on "outcome recorded". */
  useEffect(() => {
    if (!current || !needsOutcome) return;
    if (!openAttemptIds.has(current.attemptId)) setNeedsOutcome(false);
  }, [openAttemptIds, current, needsOutcome]);

  /**
   * An attended run resumes only once the outcome has actually landed in the
   * spine (the Hub's open-attempt list is what proves it), so a dismissed
   * outcome dialog never silently skips a tenant.
   */
  useEffect(() => {
    if (mode !== 'awaiting_outcome' || needsOutcome || !current) return;
    setIndex((i) => i + 1);
    setMode('running');
  }, [mode, needsOutcome, current]);

  /* ------------------------------------------------------------------ dial */
  const dial = useCallback(
    async (row: CcRow) => {
      if (starting) return;
      setStarting(true);
      settledRef.current = false;
      abortRef.current = false;
      // A previous hang-up's retries must never reach this new leg.
      cancelDropRetries();
      try {
        // Same reveal path as the Hub: opens (or reuses) the attempt row, then
        // asks the server for the number. No table read, no new attempt logic.
        const { attemptId, phone } = await hub.reveal.mutateAsync({ id: row.id });
        const subject: DialSubject = {
          rowId: row.id,
          subjectId: row.subject_id,
          name: row.name || 'Unnamed',
          district: row.district,
          attemptId,
          phone,
          row,
        };
        setCurrent(subject);
        setNeedsOutcome(false);
        call.reset();
        await call.start({
          calleeId: row.subject_id,
          name: subject.name,
          phone,
          role: 'tenant',
          location: row.district,
        });
      } catch (e) {
        toast.error(ccErrorText(e));
        if (modeRef.current === 'running') setMode('paused');
      } finally {
        setStarting(false);
      }
    },
    [call, hub.reveal, starting],
  );

  /* ------------------------------------------------- terminal-state handling */
  useEffect(() => {
    if (!current || !isTerminalCallState(call.state) || settledRef.current) return;
    settledRef.current = true;

    const answered = call.state === 'completed';
    const suggestion = suggestedOutcome(call.state);

    if (answered) {
      // A conversation happened: only the officer can classify it.
      setNeedsOutcome(true);
      if (modeRef.current === 'running') setMode('awaiting_outcome');
      return;
    }

    if (modeRef.current === 'running' && suggestion) {
      // Unanswered in an attended run: record the honest outcome and move on.
      hub.recordQuick.mutate(
        { attemptId: current.attemptId, outcome: suggestion },
        {
          onSuccess: () => {
            setNeedsOutcome(false);
            setIndex((i) => i + 1);
          },
          onError: (e) => {
            toast.error(ccErrorText(e));
            setNeedsOutcome(true);
            setMode('paused');
          },
        },
      );
      return;
    }

    setNeedsOutcome(true);
    if (modeRef.current === 'running') setMode('paused');
    // `hub.recordQuick` is a stable mutation object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [call.state, current]);

  /* ---------------------------------------------------- sequential advancing */
  useEffect(() => {
    if (mode !== 'running') return;
    if (starting || (current && !isTerminalCallState(call.state) && call.state !== 'idle')) return;
    if (needsOutcome) return;

    if (index >= Math.min(cap, queue.length)) {
      setMode('finished');
      return;
    }
    const next = queue[index];
    if (!next) {
      setMode('finished');
      return;
    }
    if (current?.rowId === next.id && settledRef.current) return;
    if (current?.rowId === next.id && !settledRef.current) return;
    void dial(next);
    // dial() is stable enough for this driver; guarded by the checks above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, index, queue, cap, needsOutcome, starting, call.state]);

  const startAuto = useCallback(
    (rows: CcRow[], nextCap: number) => {
      const list = rows.filter((r) => r.state === 'to_call' || r.state === 'callback');
      if (!list.length) {
        toast.error('No callable rows in the current list.');
        return;
      }
      setQueue(list);
      setCap(nextCap);
      setIndex(0);
      setNeedsOutcome(false);
      setCurrent(null);
      setMode('running');
    },
    [],
  );

  const pauseAuto = useCallback(() => {
    setMode((m) => (m === 'running' ? 'paused' : m));
  }, []);

  const resumeAuto = useCallback(() => {
    setMode((m) => (m === 'paused' || m === 'awaiting_outcome' ? 'running' : m));
  }, []);

  const stopAuto = useCallback(() => {
    setMode('off');
    setQueue([]);
    setIndex(0);
  }, []);

  /** Called after an outcome has been written, to release the run. */
  const advanceAfterOutcome = useCallback(() => {
    setNeedsOutcome(false);
    setIndex((i) => i + 1);
    setMode((m) => (m === 'awaiting_outcome' ? 'running' : m));
  }, []);

  /**
   * End Call.
   *
   * One path only, exactly as the CRM Calling Centre does it:
   *  - `end()` raises the cancel flag on the session (`crm_cancel_call`), which is
   *    what makes the provider callback answer `<Hangup/>` and refuse to bridge,
   *    issues the SDK hang-up on the real leg, holds the UI at "Ending…" and
   *    finalises once — on the SDK hangup event, the provider webhook, or its own
   *    safety net. It keeps the talk time of an answered call.
   *  - `insistHangup()` re-issues the SDK hang-up across the attach window, so a
   *    press made while the leg is still being set up is not swallowed.
   *
   * When the leg is still being set up (token, registration,
   * `crm_start_webrtc_call`) there is no session id yet, so the abort flag makes
   * that pending start cancel itself the moment it becomes a real session.
   * Repeat presses are absorbed by `end()`'s own single-shot guard.
   */
  const hangUp = useCallback(() => {
    if (isTerminalCallState(call.state) || call.state === 'idle') return;
    if (starting || !call.callId) abortRef.current = true;

    call.end();
    insistHangup();
  }, [call, starting, insistHangup]);

  const clearCurrent = useCallback(() => {
    hangUp();
    call.reset();
    setCurrent(null);
    setNeedsOutcome(false);
  }, [call, hangUp]);

  const live = !!current && !isTerminalCallState(call.state) && call.state !== 'idle';

  return {
    call,
    current,
    live,
    starting,
    needsOutcome,
    suggestion: suggestedOutcome(call.state),
    dial,
    hangUp,
    clearCurrent,
    advanceAfterOutcome,
    auto: {
      mode,
      index,
      cap,
      total: Math.min(cap, queue.length),
      queueLength: queue.length,
      startAuto,
      pauseAuto,
      resumeAuto,
      stopAuto,
      setCap,
    },
  };
}

export type TenantCallCenterDialer = ReturnType<typeof useTenantCallCenterDialer>;
