import { useEffect, useState } from 'react';
import { loginTelemetry, type PhaseEvent } from '@/lib/loginTelemetry';
import { Button } from '@/components/ui/button';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

/**
 * On-device viewer for the login phase telemetry ring buffer. Give the URL to
 * a specific user whose spinner hangs — they open it on the affected phone,
 * screenshot the timeline, and we see exactly which phase never completed.
 */
export default function LoginDiagnostics() {
  const [snapshot, setSnapshot] = useState(loginTelemetry.dump());
  const [flushing, setFlushing] = useState(false);
  const [remote, setRemote] = useState<PhaseEvent[] | null>(null);

  useEffect(() => {
    const id = setInterval(() => setSnapshot(loginTelemetry.dump()), 1000);
    return () => clearInterval(id);
  }, []);

  const flush = async () => {
    setFlushing(true);
    try {
      await loginTelemetry.flushNow();
      toast.success('Telemetry uploaded');
    } finally {
      setFlushing(false);
    }
  };

  const loadRemote = async () => {
    const { data, error } = await supabase
      .from('login_phase_events')
      .select('phase,status,ms_since_start,duration_ms,detail,created_at')
      .eq('session_trace_id', snapshot.traceId)
      .order('created_at', { ascending: true })
      .limit(500);
    if (error) { toast.error(error.message); return; }
    setRemote(
      (data || []).map((r: any) => ({
        phase: r.phase,
        status: r.status ?? undefined,
        ms_since_start: r.ms_since_start ?? 0,
        duration_ms: r.duration_ms ?? undefined,
        detail: r.detail ?? undefined,
        at: r.created_at ? new Date(r.created_at).getTime() : Date.now(),
      })),
    );
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(snapshot, null, 2));
      toast.success('Copied to clipboard');
    } catch { toast.error('Copy failed'); }
  };

  const events = remote ?? snapshot.events;

  return (
    <div className="min-h-screen bg-background text-foreground p-4 sm:p-6 space-y-4">
      <div className="space-y-1">
        <h1 className="text-xl font-bold">Login Diagnostics</h1>
        <p className="text-xs text-muted-foreground break-all">
          Trace: <span className="font-mono">{snapshot.traceId}</span>
        </p>
        <p className="text-xs text-muted-foreground">
          User: <span className="font-mono">{snapshot.userId ?? '—'}</span> · Started {snapshot.startedAt}
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={flush} disabled={flushing}>{flushing ? 'Uploading…' : 'Upload now'}</Button>
        <Button size="sm" variant="outline" onClick={loadRemote}>Load server copy</Button>
        <Button size="sm" variant="outline" onClick={copy}>Copy JSON</Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => { loginTelemetry.resetTrace(); setSnapshot(loginTelemetry.dump()); setRemote(null); }}
        >Reset</Button>
      </div>

      <div className="rounded-lg border border-border overflow-hidden">
        <table className="w-full text-xs">
          <thead className="bg-muted text-muted-foreground">
            <tr>
              <th className="text-left p-2 w-16">+ms</th>
              <th className="text-left p-2">phase</th>
              <th className="text-left p-2 w-16">status</th>
              <th className="text-left p-2 w-16">dur</th>
              <th className="text-left p-2">detail</th>
            </tr>
          </thead>
          <tbody>
            {events.length === 0 && (
              <tr><td colSpan={5} className="p-3 text-center text-muted-foreground">No events yet.</td></tr>
            )}
            {events.map((e, i) => (
              <tr key={i} className="border-t border-border align-top">
                <td className="p-2 font-mono">{e.ms_since_start}</td>
                <td className="p-2 font-mono">{e.phase}</td>
                <td className="p-2 font-mono">{e.status ?? ''}</td>
                <td className="p-2 font-mono">{e.duration_ms ?? ''}</td>
                <td className="p-2 font-mono whitespace-pre-wrap break-all">
                  {e.detail ? JSON.stringify(e.detail) : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-[10px] text-muted-foreground">
        Newest events at the bottom. Share the trace id with support so we can pull the server-side copy.
      </p>
    </div>
  );
}