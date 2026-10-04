import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Loader2, Clock, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

interface CronJob {
  jobname: string;
  schedule: string;
  active: boolean;
  last_run_at: string | null;
  last_status: string | null;
  is_stale: boolean;
}

/**
 * CFO/CTO diagnostic — surfaces inactive or stale pg_cron jobs so a silent
 * outage (e.g. auto-charge-wallets being disabled, freezing all agent rent
 * commissions) gets noticed within a single dashboard load.
 */
export function CronJobsHealthPanel() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['cron-jobs-health'],
    queryFn: async (): Promise<CronJob[]> => {
      const { data, error } = await supabase.rpc('cron_jobs_health');
      if (error) throw error;
      return (data ?? []) as CronJob[];
    },
    refetchInterval: 60_000,
  });

  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex justify-center py-8">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <CardContent className="py-4 text-sm text-destructive">
          Failed to load cron health: {(error as Error).message}
        </CardContent>
      </Card>
    );
  }

  const stale = (data ?? []).filter(j => j.is_stale);
  const healthy = (data ?? []).filter(j => !j.is_stale);

  return (
    <Card className={stale.length > 0 ? 'border-destructive/50' : ''}>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2">
          <Clock className="h-4 w-4 text-primary" />
          Scheduled Jobs Health
          {stale.length > 0 ? (
            <Badge variant="destructive" className="ml-auto">{stale.length} STALE</Badge>
          ) : (
            <Badge variant="outline" className="ml-auto text-emerald-600 border-emerald-600/40">
              <CheckCircle2 className="h-3 w-3 mr-1" /> All healthy
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {stale.length > 0 && (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
            <div className="flex items-center gap-1 font-semibold mb-1">
              <AlertTriangle className="h-3 w-3" /> Action required
            </div>
            These jobs are inactive or haven't run in &gt; 24h. Agent commission, debt
            recovery, ROI accrual and other automations may be silently frozen.
          </div>
        )}
        <div className="space-y-1.5">
          {[...stale, ...healthy].map(j => (
            <div
              key={j.jobname}
              className={`flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-xs ${
                j.is_stale ? 'border-destructive/30 bg-destructive/5' : 'border-border'
              }`}
            >
              <div className="min-w-0 flex-1">
                <div className="font-mono font-semibold truncate">{j.jobname}</div>
                <div className="text-muted-foreground text-[10px] tabular-nums">
                  {j.schedule} · last: {j.last_run_at ? new Date(j.last_run_at).toLocaleString() : 'never'}
                  {j.last_status ? ` · ${j.last_status}` : ''}
                </div>
              </div>
              <Badge variant={j.active ? 'outline' : 'destructive'} className="text-[10px]">
                {j.active ? 'active' : 'INACTIVE'}
              </Badge>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}