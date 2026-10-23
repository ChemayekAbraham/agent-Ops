import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  ccErrorText,
  type CcCallingHub,
  type CcOutcome,
  type CcRow,
} from '@/hooks/useCcCallingHub';
import {
  isTerminalCallState,
  useCrmVoiceCall,
  useHumanCallingPaused,
  type CallState,
} from '@/hooks/useCrmVoiceCall';
import { hangupVoiceCall } from '@/lib/atVoiceClient';
import { fetchLandlordRegistryEntry, type LandlordRegistryRecord } from './useLandlordRegistryBatch';

export type AutoMode = 'off' | 'running' | 'paused' | 'awaiting_outcome' | 'finished';

export const AUTO_CAP_CHOICES = [5, 10, 25, 50];
export const DEFAULT_AUTO_CAP = 10;

export interface LandlordDialSubject {
  rowId: string;
  cycleRowId: string;
  subjectId: string;
  landlordId: string | null;
  userId: string | null;
  handsetOnly: boolean;
  name: string;
  district: string | null;
  region: string | null;
  agentName: string | null;
  metricValue: number | null;
  attemptId: string;
  phone: string | null;
  row: CcRow;
  registry: LandlordRegistryRecord | null;
}

export function suggestedOutcome(state: CallState): CcOutcome | null {
  switch (state) {
    case 'no_answer':
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

export function useLandlordCallCenterDialer(hub: CcCallingHub) {
  const call = useCrmVoiceCall();
  const { data: pauseData } = useHumanCallingPaused();
  const callingPaused = !!pauseData?.paused;

  const [current, setCurrent] = useState<LandlordDialSubject | null>(null);
  const [starting, setStarting] = useState(false);
  const [needsOutcome, setNeedsOutcome] = useState(false);
  const [autoAdvance, setAutoAdvance] = useState(false);

  const [mode, setMode] = useState<AutoMode>('off');
  const [queue, setQueue] = useState<CcRow[]>([]);
  const [index, setIndex] = useState(0);
  const [cap, setCap] = useState(DEFAULT_AUTO_CAP);

  const modeRef = useRef<AutoMode>('off');
  modeRef.current = mode;
  const settledRef = useRef(false);
  const abortRef = useRef(false);
  const dropTimersRef = useRef<number[]>([]);
  const stateRef = useRef<CallState>('idle');
  stateRef.current = call.state;

  const cancelDropRetries = useCallback(() => {
    dropTimersRef.current.forEach((t) => window.clearTimeout(t));
    dropTimersRef.current = [];
  }, []);

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

  useEffect(() => cancelDropRetries, [cancelDropRetries]);

  useEffect(() => {
    if (!abortRef.current || starting || !call.callId) return;
    abortRef.current = false;
    call.end();
    insistHangup();
  }, [call, starting, insistHangup]);

  const openAttemptIds = useMemo(
    () => new Set((hub.openAttempts ?? []).map((a) => a.id)),
    [hub.openAttempts],
  );

  useEffect(() => {
    if (!current || !needsOutcome) return;
    if (!openAttemptIds.has(current.attemptId)) setNeedsOutcome(false);
  }, [openAttemptIds, current, needsOutcome]);

  useEffect(() => {
    if (mode !== 'awaiting_outcome' || needsOutcome || !current) return;
    setIndex((i) => i + 1);
    setMode('running');
  }, [mode, needsOutcome, current]);

  const dial = useCallback(
    async (row: CcRow, opts?: { handsetOnly?: boolean }) => {
      if (starting) return null;
      if (!opts?.handsetOnly && callingPaused) {
        toast.warning('Calling from the app is paused.');
        return null;
      }

      setStarting(true);
      settledRef.current = false;
      abortRef.current = false;
      cancelDropRetries();

      try {
        const [{ attemptId, phone }, registry] = await Promise.all([
          hub.reveal.mutateAsync({ id: row.id }),
          fetchLandlordRegistryEntry(row.subject_id),
        ]);

        const resolvedUserId = registry?.user_id ?? null;
        const resolvedLandlordId = registry?.landlord_id ?? row.subject_id;
        const handsetOnly = Boolean(opts?.handsetOnly || !resolvedUserId || callingPaused);

        const subject: LandlordDialSubject = {
          rowId: row.id,
          cycleRowId: row.id,
          subjectId: row.subject_id,
          landlordId: resolvedLandlordId,
          userId: resolvedUserId,
          handsetOnly,
          name: row.name || registry?.full_name || 'Landlord',
          district: row.district ?? registry?.district ?? null,
          region: registry?.region ?? null,
          agentName: row.linked_agent ?? registry?.registering_agent_name ?? null,
          metricValue: row.metric_value ?? registry?.plan_rent_total ?? null,
          attemptId,
          phone,
          row,
          registry,
        };

        setCurrent(subject);

        if (!resolvedUserId) {
          // No linked user account in registry: offer handset / WhatsApp only
          setNeedsOutcome(true);
          toast.info('No linked user account for this landlord — dial via Handset or WhatsApp.');
          return subject;
        }

        if (handsetOnly) {
          setNeedsOutcome(true);
          return subject;
        }

        setNeedsOutcome(false);
        call.reset();
        await call.start({
          calleeId: resolvedUserId,
          name: subject.name,
          phone,
          role: 'landlord',
          location: subject.district,
        });
        return subject;
      } catch (e) {
        toast.error(ccErrorText(e));
        if (modeRef.current === 'running') setMode('paused');
        return null;
      } finally {
        setStarting(false);
      }
    },
    [call, hub.reveal, starting, callingPaused, cancelDropRetries],
  );

  useEffect(() => {
    if (!current || !isTerminalCallState(call.state) || settledRef.current) return;
    settledRef.current = true;

    const answered = call.state === 'completed';
    const suggestion = suggestedOutcome(call.state);

    if (answered) {
      setNeedsOutcome(true);
      if (modeRef.current === 'running') setMode('awaiting_outcome');
      return;
    }

    if (modeRef.current === 'running' && suggestion) {
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [call.state, current]);

  const dialNextPending = useCallback(async () => {
    const rows = (hub.rows ?? []) as CcRow[];
    const next = rows.find(
      (r) =>
        (r.state === 'to_call' || r.state === 'callback' || r.state === 'unreachable') &&
        r.id !== current?.rowId,
    );
    if (!next) {
      toast.success('No more pending landlords on this page.');
      return null;
    }
    return dial(next);
  }, [hub.rows, current?.rowId, dial]);

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

  const advanceAfterOutcome = useCallback(() => {
    setNeedsOutcome(false);
    setIndex((i) => i + 1);
    setMode((m) => (m === 'awaiting_outcome' ? 'running' : m));
    if (autoAdvance && !callingPaused) {
      setTimeout(() => {
        void dialNextPending();
      }, 350);
    }
  }, [autoAdvance, callingPaused, dialNextPending]);

  const startAuto = useCallback((rows: CcRow[], nextCap: number) => {
    const list = rows.filter((r) => r.state === 'to_call' || r.state === 'callback');
    if (!list.length) {
      toast.error('No callable landlords in the current list.');
      return;
    }
    setQueue(list);
    setCap(nextCap);
    setIndex(0);
    setNeedsOutcome(false);
    setCurrent(null);
    setMode('running');
  }, []);

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

  const live = !!current && !isTerminalCallState(call.state) && call.state !== 'idle';

  return {
    call,
    callingPaused,
    current,
    live,
    starting,
    isRevealing: hub.reveal.isPending || starting,
    needsOutcome,
    autoAdvance,
    setAutoAdvance,
    suggestion: suggestedOutcome(call.state),
    dial,
    dialNextPending,
    hangUp,
    clearCurrent,
    completeCurrent: clearCurrent,
    cancelCurrent: clearCurrent,
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

export type LandlordCallCenterDialer = ReturnType<typeof useLandlordCallCenterDialer>;
