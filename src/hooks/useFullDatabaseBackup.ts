import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';

export interface FullBackupRun {
  status: string;
  table_count: number | null;
  row_count: number | null;
  size_bytes: number | null;
  error_message: string | null;
}

export interface FullBackupProgress {
  tablesDone: number;
  tablesLeft: number;
  current: string | null;
  ageSeconds: number;
}

// 'stalled' = the run stopped checkpointing (an invocation was killed); resume() can continue it.
export type FullBackupPhase = 'idle' | 'starting' | 'running' | 'stalled' | 'finished' | 'error';

const POLL_MS = 15_000;
// A full run is a chain of short invocations over 860 tables; give up polling after 3 h
// (the run itself keeps going, and its backup_runs row still lands).
const POLL_GIVE_UP_MS = 3 * 60 * 60 * 1000;

/**
 * Starts the paged full-table backup (every public table, row counts verified), polls until its
 * backup_runs row appears, and exposes progress. Replaces the capped weekly-database-backup call on
 * the CTO dashboard. `tables` restricts the run to a subset (use for the first test run).
 */
export function useFullDatabaseBackup() {
  const [phase, setPhase] = useState<FullBackupPhase>('idle');
  const [folder, setFolder] = useState<string | null>(null);
  const [run, setRun] = useState<FullBackupRun | null>(null);
  const [progress, setProgress] = useState<FullBackupProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const timers = useRef<{ poll?: ReturnType<typeof setInterval>; tick?: ReturnType<typeof setInterval> }>({});

  const stop = useCallback(() => {
    clearInterval(timers.current.poll);
    clearInterval(timers.current.tick);
  }, []);

  useEffect(() => stop, [stop]);

  const beginPolling = useCallback((runFolder: string) => {
    stop();
    const t0 = Date.now();
    setPhase('running');
    timers.current.tick = setInterval(() => setElapsed(Math.floor((Date.now() - t0) / 1000)), 1000);
    timers.current.poll = setInterval(async () => {
      if (Date.now() - t0 > POLL_GIVE_UP_MS) {
        stop();
        setPhase('error');
        setError('Still running after 3 hours; check backup_runs later.');
        return;
      }
      // `tables: []` is a safety net: a deployed version WITHOUT the status action would treat this
      // call as "start a run", and an empty table list makes that run a no-op instead of a full export.
      const { data: st, error: stErr } = await supabase.functions.invoke('full-table-backup', {
        body: { action: 'status', folder: runFolder, tables: [] },
      });
      if (st?.accepted) {
        // Old deployment answered with a run ticket, not a status: stop before it repeats every poll.
        stop();
        setPhase('error');
        setError('The deployed full-table-backup is out of date (no status action). Redeploy it.');
        return;
      }
      if (stErr || !st) return; // transient; keep polling
      if (st.progress) setProgress(st.progress as FullBackupProgress);
      if (st.finished) {
        stop();
        setRun(st.run as FullBackupRun);
        setPhase(st.run?.status === 'failed' ? 'error' : 'finished');
        if (st.run?.status === 'failed') setError(st.run.error_message ?? 'Backup failed');
        return;
      }
      if (st.stalled) {
        stop();
        const at = st.progress?.current ? ` while on ${st.progress.current}` : '';
        setPhase('stalled');
        setError(`Backup stopped making progress${at}. Resume continues from the last saved part.`);
      }
    }, POLL_MS);
  }, [stop]);

  const start = useCallback(async (tables?: string[]) => {
    stop();
    setPhase('starting');
    setRun(null);
    setProgress(null);
    setError(null);
    setElapsed(0);
    try {
      const { data, error: invokeErr } = await supabase.functions.invoke('full-table-backup', {
        body: tables?.length ? { tables } : {},
      });
      if (invokeErr) throw invokeErr;
      if (!data?.accepted || !data?.folder) throw new Error(data?.error || 'Backup was not accepted');
      setFolder(data.folder);
      beginPolling(data.folder);
    } catch (e) {
      stop();
      setPhase('error');
      setError((e as Error)?.message || 'Backup failed');
    }
  }, [stop, beginPolling]);

  /** Continue a stalled run from its last checkpoint. Refused by the server while the run still looks alive. */
  const resume = useCallback(async () => {
    if (!folder) return;
    setError(null);
    try {
      const { data, error: invokeErr } = await supabase.functions.invoke('full-table-backup', {
        body: { action: 'resume', folder },
      });
      if (invokeErr) throw invokeErr;
      if (!data?.accepted) throw new Error(data?.error || 'Resume was not accepted');
      beginPolling(folder);
    } catch (e) {
      setPhase('stalled');
      setError((e as Error)?.message || 'Resume failed');
    }
  }, [folder, beginPolling]);

  return { phase, folder, run, progress, error, elapsed, start, resume };
}
