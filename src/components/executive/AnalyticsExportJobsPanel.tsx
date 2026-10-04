import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Loader2, Download, Rocket, CheckCircle2, XCircle, RefreshCw } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { useToast } from '@/hooks/use-toast';

interface Job {
  id: string;
  kind: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  progress: number;
  params: { start?: string; end?: string; label?: string };
  file_path: string | null;
  row_count: number | null;
  error: string | null;
  created_at: string;
  completed_at: string | null;
}

interface Props {
  start: Date;
  end: Date;
  rangeLabel: string;
}

export function AnalyticsExportJobsPanel({ start, end, rangeLabel }: Props) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [starting, setStarting] = useState(false);

  const { data: jobs, refetch } = useQuery({
    queryKey: ['analytics-export-jobs'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('analytics_export_jobs')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(10);
      if (error) throw error;
      return (data || []) as Job[];
    },
    refetchInterval: (q) => {
      const rows = (q.state.data as Job[] | undefined) || [];
      return rows.some((j) => j.status === 'queued' || j.status === 'running') ? 3000 : false;
    },
  });

  // No Realtime listener: analytics_export_jobs is not in the publication, so
  // it never fired. The query's refetchInterval (3s while a job is active)
  // covers progress (doc 147).

  const startExport = async () => {
    try {
      setStarting(true);
      const { data: userRes } = await supabase.auth.getUser();
      const uid = userRes?.user?.id;
      if (!uid) throw new Error('Not signed in');

      const { data: job, error } = await supabase
        .from('analytics_export_jobs')
        .insert({
          requested_by: uid,
          kind: 'user_analytics_csv',
          status: 'queued',
          progress: 0,
          params: {
            start: start.toISOString(),
            end: end.toISOString(),
            label: rangeLabel,
          },
        })
        .select()
        .single();
      if (error) throw error;

      // Fire-and-forget: don't await — the worker updates the row.
      supabase.functions.invoke('generate-user-analytics-export', {
        body: { job_id: job.id },
      }).catch((e) => console.error('invoke failed', e));

      toast({ title: 'Export started', description: 'You can leave this page — we\'ll keep going in the background.' });
      qc.invalidateQueries({ queryKey: ['analytics-export-jobs'] });
    } catch (e) {
      toast({
        title: 'Could not start export',
        description: e instanceof Error ? e.message : String(e),
        variant: 'destructive',
      });
    } finally {
      setStarting(false);
    }
  };

  const downloadFile = async (job: Job) => {
    if (!job.file_path) return;
    const { data, error } = await supabase.storage
      .from('analytics-exports')
      .createSignedUrl(job.file_path, 300);
    if (error || !data) {
      toast({ title: 'Download failed', description: error?.message, variant: 'destructive' });
      return;
    }
    window.open(data.signedUrl, '_blank');
  };

  return (
    <div className="rounded-2xl border border-border bg-card p-3 sm:p-4 space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          <h3 className="text-sm font-semibold flex items-center gap-2">
            <Rocket className="w-4 h-4 text-primary" /> Background exports
          </h3>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            Use this for large ranges. Runs on the server and includes full signup + login row-level data.
          </p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" className="text-xs" onClick={() => refetch()}>
            <RefreshCw className="w-3.5 h-3.5 mr-1" /> Refresh
          </Button>
          <Button size="sm" onClick={startExport} disabled={starting} className="text-xs">
            {starting ? <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> : <Rocket className="w-3.5 h-3.5 mr-1" />}
            Generate CSV in background
          </Button>
        </div>
      </div>

      <div className="space-y-2">
        {(jobs || []).map((j) => {
          const p = Math.max(0, Math.min(100, j.progress));
          const running = j.status === 'queued' || j.status === 'running';
          return (
            <div key={j.id} className="rounded-lg border border-border/60 p-2.5">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-xs font-medium truncate">
                    {j.params?.label || `${j.params?.start?.slice(0, 10)} → ${j.params?.end?.slice(0, 10)}`}
                  </div>
                  <div className="text-[10px] text-muted-foreground">
                    {formatDistanceToNow(new Date(j.created_at), { addSuffix: true })}
                    {j.row_count != null && ` · ${j.row_count.toLocaleString()} rows`}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {j.status === 'succeeded' && (
                    <>
                      <CheckCircle2 className="w-4 h-4 text-green-600" />
                      <Button size="sm" variant="outline" className="text-xs h-7" onClick={() => downloadFile(j)}>
                        <Download className="w-3.5 h-3.5 mr-1" /> Download
                      </Button>
                    </>
                  )}
                  {j.status === 'failed' && <XCircle className="w-4 h-4 text-destructive" />}
                  {running && <Loader2 className="w-4 h-4 animate-spin text-primary" />}
                </div>
              </div>
              {running && (
                <div className="mt-2 h-1.5 w-full rounded-full bg-muted overflow-hidden">
                  <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${p}%` }} />
                </div>
              )}
              {j.status === 'failed' && j.error && (
                <p className="mt-1 text-[10px] text-destructive break-words">{j.error}</p>
              )}
            </div>
          );
        })}
        {(!jobs || jobs.length === 0) && (
          <p className="text-xs text-muted-foreground">No background exports yet.</p>
        )}
      </div>
    </div>
  );
}