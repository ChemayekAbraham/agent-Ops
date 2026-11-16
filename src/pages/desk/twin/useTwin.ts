import { useCallback, useEffect, useRef, useState } from 'react';
import { msUntilNextEat0805, stopOfStatus, type HistoryDay, type Stop, type Twin } from './twinModel';
import { TwinError, type TwinSource } from './twinSource';

/**
 * Loading and keeping the twin current.
 *
 *  Live (default): ops_twin_now on open, every 5 minutes, and 30 s after a new
 *    stage event (staff only: realtime on rent_request_stage_events). Each event
 *    also sends one dot down the river straight away.
 *  Day: the saved run for that day, replayed; no automatic reload.
 *  A new saved run (realtime INSERT on ops_twin_run_signals: run_id, run_at,
 *    window_end, source; no payload) reloads the history through ops_twin_history,
 *    which feeds the day picker and the "what changed" ribbon. The page never reads
 *    ops_twin_runs directly; it is closed to everyone but the five full viewers.
 *  Boardroom display (no session, no realtime): reload every 15 minutes and at
 *    08:05 EAT, after the daily run has landed.
 */

export const LIVE_REFRESH_MS = 5 * 60_000;
export const BOARD_REFRESH_MS = 15 * 60_000;
export const EVENT_REFRESH_MS = 30_000;
export const HISTORY_DAYS = 60;
/** The realtime tables the twin listens to. Never ops_twin_runs. */
export const TWIN_STAGE_EVENTS = 'rent_request_stage_events';
export const TWIN_RUN_SIGNALS = 'ops_twin_run_signals';

export type TwinMode = { kind: 'live' } | { kind: 'day'; date: string };
export type LiveMove = { id: number; from: Stop; to: Stop; at: number };

type State = { twin: Twin | null; loading: boolean; error: TwinError | null; loadedAt: number | null };

export function useTwin(source: TwinSource, initialMode: TwinMode = { kind: 'live' }) {
  const [mode, setMode] = useState<TwinMode>(initialMode);
  const [state, setState] = useState<State>({ twin: null, loading: true, error: null, loadedAt: null });
  const [history, setHistory] = useState<HistoryDay[]>([]);
  const [nonce, setNonce] = useState(0);
  const [historyNonce, setHistoryNonce] = useState(0);
  const [liveMoves, setLiveMoves] = useState<LiveMove[]>([]);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  const modeKey = mode.kind === 'live' ? 'live' : mode.date;
  const modeRef = useRef(mode);
  modeRef.current = mode;

  // The twin itself.
  useEffect(() => {
    const controller = new AbortController();
    setState((s) => ({ ...s, loading: true }));
    const read = mode.kind === 'live' ? source.now(controller.signal) : source.day(mode.date, controller.signal);
    read
      .then((twin) => setState({ twin, loading: false, error: null, loadedAt: Date.now() }))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        const e = err instanceof TwinError ? err : new TwinError(err instanceof Error && err.message ? err.message : 'The twin could not be loaded.');
        // Keep what is on screen unless the server refused this viewer outright.
        setState((s) => ({ ...s, twin: e.notAllowed ? null : s.twin, loading: false, error: e }));
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- modeKey stands for mode
  }, [source, modeKey, nonce]);

  // The day list.
  useEffect(() => {
    const controller = new AbortController();
    source
      .history(HISTORY_DAYS, controller.signal)
      .then(setHistory)
      .catch(() => {
        /* the picker just shows Live */
      });
    return () => controller.abort();
  }, [source, historyNonce]);

  // Timed reloads.
  useEffect(() => {
    if (source.kind === 'board') {
      const every = window.setInterval(() => {
        refresh();
        setHistoryNonce((n) => n + 1);
      }, BOARD_REFRESH_MS);
      let morning: number;
      const arm = () => {
        morning = window.setTimeout(() => {
          refresh();
          setHistoryNonce((n) => n + 1);
          arm();
        }, msUntilNextEat0805(Date.now()));
      };
      arm();
      return () => {
        window.clearInterval(every);
        window.clearTimeout(morning);
      };
    }
    if (mode.kind !== 'live') return;
    const every = window.setInterval(refresh, LIVE_REFRESH_MS);
    const back = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    document.addEventListener('visibilitychange', back);
    return () => {
      window.clearInterval(every);
      document.removeEventListener('visibilitychange', back);
    };
  }, [source.kind, mode.kind, refresh]);

  // Realtime (staff only). Rows are used only as signals and for the two statuses; nothing else is kept.
  useEffect(() => {
    const client = source.realtime;
    if (!client) return;
    let pending: number | null = null;
    let seq = 0;
    const channel = client
      .channel(`ops-twin-${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: TWIN_STAGE_EVENTS }, (msg: { new?: Record<string, unknown> }) => {
        if (modeRef.current.kind !== 'live') return;
        const row = msg.new ?? {};
        const move: LiveMove = {
          id: ++seq,
          from: stopOfStatus(typeof row.from_status === 'string' ? row.from_status : null),
          to: stopOfStatus(typeof row.to_status === 'string' ? row.to_status : null),
          at: performance.now(),
        };
        setLiveMoves((m) => [...m.filter((x) => move.at - x.at < 5_000), move]);
        if (pending === null) {
          pending = window.setTimeout(() => {
            pending = null;
            if (modeRef.current.kind === 'live') refresh();
          }, EVENT_REFRESH_MS);
        }
      })
      // A saved run landed. The signal carries no payload; history comes back through the RPC.
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: TWIN_RUN_SIGNALS }, () => {
        setHistoryNonce((n) => n + 1);
      })
      .subscribe();
    return () => {
      if (pending !== null) window.clearTimeout(pending);
      void client.removeChannel(channel);
    };
  }, [source.realtime, refresh]);

  return { ...state, mode, setMode, refresh, history, liveMoves };
}
