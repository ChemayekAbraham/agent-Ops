import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';

export interface FullBackupRun {
  status: string;
  table_count: number | null;
  row_count: number | null;
  size_bytes: number | null;
  error_message: string | null;
}

export type FullBackupPhase = 'idle' | 'starting' | 'running' | 'finished' | 'error';

const POLL_MS = 15_000;
// A full run is a chain of ~100 s invocations over 860 tables; give up polling after 3 h
// (the run itself keeps going, and its backup_runs row still lands).
const POLL_GIVE_UP_MS = 3 * 60 * 60 * 1000;

/**
 * Starts the paged full-table backup (every public table, row counts verified) and polls until
 * its backup_runs row appears. Replaces the capped weekly-database-backup call on the CTO dashboard.
 * `tables` restricts the run to a subset (use for the first test run).
 */
export function useFullDatabaseBackup() {
  const [phase, setPhase] = useState<FullBackupPhase>('idle');
  const [folder, setFolder] = useState<string | null>(null);
  const [run, setRun] = useState<FullBackupRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const timers = useRef<{ poll?: ReturnType<typeof setInterval>; tick?: ReturnType<typeof setInterval> }>({});

  const stop = useCallback(() => {
    clearInterval(timers.current.poll);
    clearInterval(timers.current.tick);
  }, []);

  useEffect(() => stop, [stop]);

  const start = useCallback(async (tables?: string[]) => {
    stop();
    setPhase('starting');
    setRun(null);
    setError(null);
    setElapsed(0);
    const t0 = Date.now();
    try {
      const { data, error: invokeErr } = await supabase.functions.invoke('full-table-backup', {
        body: tables?.length ? { tables } : {},
      });
      if (invokeErr) throw invokeErr;
      if (!data?.accepted || !data?.folder) throw new Error(data?.error || 'Backup was not accepted');
      const runFolder: string = data.folder;
      setFolder(runFolder);
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
        if (stErr || !st?.finished) return; // transient or not done yet; keep polling
        stop();
        setRun(st.run as FullBackupRun);
        setPhase(st.run?.status === 'failed' ? 'error' : 'finished');
        if (st.run?.status === 'failed') setError(st.run.error_message ?? 'Backup failed');
      }, POLL_MS);
    } catch (e) {
      stop();
      setPhase('error');
      setError((e as Error)?.message || 'Backup failed');
    }
  }, [stop]);

  return { phase, folder, run, error, elapsed, start };
}
