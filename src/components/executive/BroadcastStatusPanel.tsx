import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { KPICard } from './KPICard';
import { Progress } from '@/components/ui/progress';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Megaphone, Send, XCircle, Clock, RefreshCw, CheckCircle2, Loader2, Radio, RotateCw,
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { toast } from 'sonner';

interface CampaignStatus {
  campaign_key: string;
  message: string | null;
  audiences: string[] | null;
  total_recipients: number;
  run_count: number;
  status: string;
  sent: number;
  failed: number;
  last_activity: string | null;
  last_run_at: string | null;
  created_at: string;
  updated_at: string;
}

const BROADCAST_RETRY_DISABLED = true;

const num = (n: number) => new Intl.NumberFormat('en-US').format(Math.max(0, n));

function StatusBadge({ status, queued }: { status: string; queued: number }) {
  if (status === 'complete' && queued <= 0) {
    return (
      <Badge className="bg-green-500/15 text-green-600 border-green-500/30 gap-1">
        <CheckCircle2 className="h-3 w-3" /> Complete
      </Badge>
    );
  }
  if (status === 'running' || queued > 0) {
    return (
      <Badge className="bg-blue-500/15 text-blue-600 border-blue-500/30 gap-1">
        <span className="relative flex h-2 w-2">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-500 opacity-75" />
          <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500" />
        </span>
        Sending
      </Badge>
    );
  }
  return <Badge variant="secondary" className="gap-1">{status}</Badge>;
}

function CampaignCard({ c }: { c: CampaignStatus }) {
  const queryClient = useQueryClient();
  const [retrying, setRetrying] = useState(false);
  const processed = c.sent + c.failed;
  const queued = Math.max(0, c.total_recipients - processed);
  const retries = Math.max(0, c.run_count - 1);
  const pct = c.total_recipients > 0 ? Math.min(100, (processed / c.total_recipients) * 100) : 0;
  const failRate = processed > 0 ? (c.failed / processed) * 100 : 0;
  const outstanding = c.failed + queued;

  const handleRetry = async () => {
    // Standing order (Josh, 2026-10-01): no engineer retries a broadcast from this
    // page. A retry re-sends SMS (credit, provider rate limits) and rewrites the
    // campaign row. Doc 181. Flip only on an explicit instruction to re-send.
    if (BROADCAST_RETRY_DISABLED) {
      toast.error('Retry is switched off. Do not re-send broadcasts from this page.');
      return;
    }
    if (retrying) return;
    if (!c.message || !c.audiences || c.audiences.length === 0) {
      toast.error('Cannot retry — campaign is missing its message or audience.');
      return;
    }
    setRetrying(true);
    try {
      const { error } = await supabase.functions.invoke('broadcast-audience-sms', {
        body: {
          campaign_key: c.campaign_key,
          audiences: c.audiences,
          message: c.message,
        },
      });
      if (error) throw error;
      toast.success(`Retry started — re-firing ${num(outstanding)} outstanding recipient${outstanding === 1 ? '' : 's'}.`);
      queryClient.invalidateQueries({ queryKey: ['sms-broadcast-status'] });
    } catch (e) {
      toast.error(`Retry failed: ${(e as Error)?.message ?? 'unknown error'}`);
    } finally {
      setRetrying(false);
    }
  };

  return (
    <div className="rounded-2xl border border-border bg-card p-4 sm:p-5 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="font-semibold text-sm break-all">{c.campaign_key}</p>
            <StatusBadge status={c.status} queued={queued} />
          </div>
          {c.audiences && c.audiences.length > 0 && (
            <p className="text-xs text-muted-foreground mt-1 capitalize">
              {c.audiences.join(' · ')}
            </p>
          )}
        </div>
        <div className="text-right">
          <p className="text-2xl font-bold tabular-nums">{pct.toFixed(1)}%</p>
          <p className="text-[10px] text-muted-foreground">
            {num(processed)} / {num(c.total_recipients)} processed
          </p>
        </div>
      </div>

      <Progress value={pct} className="h-2" />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KPICard
          title="Queued"
          value={num(queued)}
          icon={Clock}
          color="bg-amber-500/10 text-amber-600"
        />
        <KPICard
          title="Sent"
          value={num(c.sent)}
          icon={Send}
          color="bg-green-500/10 text-green-600"
        />
        <KPICard
          title="Failed"
          value={num(c.failed)}
          icon={XCircle}
          color="bg-red-500/10 text-red-600"
          subtitle={processed > 0 ? `${failRate.toFixed(1)}% fail rate` : undefined}
        />
        <KPICard
          title="Retry passes"
          value={num(retries)}
          icon={RefreshCw}
          color="bg-blue-500/10 text-blue-600"
          subtitle={`${c.run_count} total run${c.run_count === 1 ? '' : 's'}`}
        />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
          {c.last_activity && (
            <span className="inline-flex items-center gap-1">
              <Radio className="h-3 w-3" /> Last delivery {formatDistanceToNow(new Date(c.last_activity), { addSuffix: true })}
            </span>
          )}
          {c.last_run_at && (
            <span className="inline-flex items-center gap-1">
              <RefreshCw className="h-3 w-3" /> Last run {formatDistanceToNow(new Date(c.last_run_at), { addSuffix: true })}
            </span>
          )}
        </div>
        <Button
          size="sm"
          variant={outstanding > 0 ? 'default' : 'outline'}
          onClick={handleRetry}
          disabled={retrying || outstanding === 0}
          className="gap-1.5"
        >
          {retrying ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCw className="h-3.5 w-3.5" />}
          {retrying
            ? 'Retrying…'
            : outstanding > 0
              ? `Retry failed (${num(outstanding)})`
              : 'All delivered'}
        </Button>
      </div>

      {c.message && (
        <p className="text-xs text-muted-foreground bg-muted/40 rounded-lg p-3 line-clamp-3">
          {c.message}
        </p>
      )}
    </div>
  );
}

export function BroadcastStatusPanel() {
  const { data, isLoading, isError, error, isFetching, dataUpdatedAt } = useQuery({
    queryKey: ['sms-broadcast-status'],
    queryFn: async (): Promise<CampaignStatus[]> => {
      const { data, error } = await supabase.rpc('get_sms_broadcast_status');
      if (error) throw error;
      return (data ?? []) as CampaignStatus[];
    },
    refetchInterval: 4000,
    refetchOnWindowFocus: true,
  });

  const campaigns = data ?? [];
  const totals = campaigns.reduce(
    (acc, c) => {
      const processed = c.sent + c.failed;
      acc.queued += Math.max(0, c.total_recipients - processed);
      acc.sent += c.sent;
      acc.failed += c.failed;
      acc.retries += Math.max(0, c.run_count - 1);
      return acc;
    },
    { queued: 0, sent: 0, failed: 0, retries: 0 },
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-bold flex items-center gap-2">
            <Megaphone className="h-5 w-5 text-primary" /> Broadcast Status
          </h2>
          <p className="text-xs text-muted-foreground">
            Live SMS campaign delivery — queued, sent, failed and retry counts.
          </p>
        </div>
        <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
          {isFetching ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <span className="h-2 w-2 rounded-full bg-green-500" />
          )}
          Auto-refresh 4s
          {dataUpdatedAt ? ` · updated ${formatDistanceToNow(new Date(dataUpdatedAt), { addSuffix: true })}` : ''}
        </span>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KPICard title="Total Queued" value={num(totals.queued)} icon={Clock} color="bg-amber-500/10 text-amber-600" loading={isLoading} />
        <KPICard title="Total Sent" value={num(totals.sent)} icon={Send} color="bg-green-500/10 text-green-600" loading={isLoading} />
        <KPICard title="Total Failed" value={num(totals.failed)} icon={XCircle} color="bg-red-500/10 text-red-600" loading={isLoading} />
        <KPICard title="Retry Passes" value={num(totals.retries)} icon={RefreshCw} color="bg-blue-500/10 text-blue-600" loading={isLoading} />
      </div>

      {isError && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-600">
          Failed to load broadcast status: {(error as Error)?.message}
        </div>
      )}

      {isLoading ? (
        <div className="space-y-3">
          {[0, 1].map((i) => (
            <div key={i} className="h-40 rounded-2xl border border-border bg-muted/30 animate-pulse" />
          ))}
        </div>
      ) : campaigns.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
          <Megaphone className="h-8 w-8 mx-auto mb-2 opacity-40" />
          No broadcast campaigns yet.
        </div>
      ) : (
        <div className="space-y-4">
          {campaigns.map((c) => (
            <CampaignCard key={c.campaign_key} c={c} />
          ))}
        </div>
      )}
    </div>
  );
}

export default BroadcastStatusPanel;