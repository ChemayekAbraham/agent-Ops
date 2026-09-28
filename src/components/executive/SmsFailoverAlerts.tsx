import { useEffect, useMemo, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { AlertTriangle, ShieldAlert, Radio, CheckCircle2, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';

// Detection window + thresholds
const WINDOW_MINUTES = 60;
const AT_FALLBACK_WARN = 10; // unusual fallback volume in window
const AT_FALLBACK_CRITICAL = 25;
const YOOLA_FAIL_RATE_CRITICAL = 0.5; // >50% of Yoola attempts failing
const YOOLA_MIN_SAMPLE = 5;

type SmsLog = {
  id: string;
  created_at: string;
  status: string;
  provider: string;
  provider_response: any;
};

function isSuccess(status: string) {
  const s = (status || '').toLowerCase();
  return s === 'sent' || s === 'success' || s === 'delivered' || s === 'accepted';
}

// Analyse a single log row for Yoola attempt/failure and AT fallback signals.
function analyse(log: SmsLog) {
  const attempts: any[] = Array.isArray(log.provider_response?.attempts) ? log.provider_response.attempts : [];
  let yoolaAttempted = false;
  let yoolaFailed = false;
  let atFallback = false;

  if (attempts.length > 0) {
    const yoola = attempts.find((a) => (a.provider || '').toLowerCase() === 'yoola' && a.attempted !== false);
    if (yoola) {
      yoolaAttempted = true;
      if (!yoola.accepted) yoolaFailed = true;
    }
    const atAccepted = attempts.some((a) => (a.provider || '').toLowerCase().includes('africa') && a.accepted);
    // Fallback = Yoola was tried & failed, and AT then delivered
    if (yoolaFailed && atAccepted) atFallback = true;
  } else {
    // No structured attempts — infer from final provider (Yoola is the primary by policy)
    const p = (log.provider || '').toLowerCase();
    if (p === 'yoola') {
      yoolaAttempted = true;
      if (!isSuccess(log.status)) yoolaFailed = true;
    } else if (p.includes('africa') && isSuccess(log.status)) {
      // AT delivered while Yoola is primary => fallback engaged
      atFallback = true;
    }
  }
  return { yoolaAttempted, yoolaFailed, atFallback };
}

export function SmsFailoverAlerts() {
  const lastToastRef = useRef<number>(0);
  // Newest created_at already analysed for toasts; null until the first load
  // so the initial window never toasts.
  const seenUntilRef = useRef<string | null>(null);

  const { data: logs = [], isLoading, dataUpdatedAt, refetch } = useQuery({
    queryKey: ['cto-sms-failover-alerts'],
    queryFn: async () => {
      const since = new Date(Date.now() - WINDOW_MINUTES * 60_000).toISOString();
      const { data, error } = await supabase
        .from('sms_delivery_log')
        .select('id, created_at, status, provider, provider_response')
        .gte('created_at', since)
        .order('created_at', { ascending: false })
        .limit(500);
      if (error) throw error;
      return (data || []) as SmsLog[];
    },
    staleTime: 15_000,
    refetchInterval: 60_000,
  });

  // Polled every 60s (refetchInterval above) instead of a Realtime INSERT
  // listener on sms_delivery_log — one of the busiest published tables, and
  // the listener was unfiltered (doc 147). Failover toasts still fire: each
  // poll analyses only rows newer than the previous poll.
  useEffect(() => {
    if (logs.length === 0) return;
    const newest = logs[0].created_at;
    const seenUntil = seenUntilRef.current;
    seenUntilRef.current = seenUntil && seenUntil > newest ? seenUntil : newest;
    if (!seenUntil) return;
    let yoolaFailed = false;
    let atFallback = false;
    for (const row of logs) {
      if (row.created_at <= seenUntil) break;
      const a = analyse(row);
      yoolaFailed ||= a.yoolaFailed;
      atFallback ||= a.atFallback;
    }
    const now = Date.now();
    if ((yoolaFailed || atFallback) && now - lastToastRef.current > 4000) {
      lastToastRef.current = now;
      if (yoolaFailed) {
        toast.warning('Yoola SMS failure detected', {
          description: "Welile OTP routed to Africa's Talking fallback.",
        });
      } else {
        toast.warning("Africa's Talking fallback engaged", {
          description: 'Welile OTP delivered via backup gateway.',
        });
      }
    }
  }, [logs]);

  // For the auto-refresh indicator / refresh button (UI owned by Gemini).
  const lastUpdatedAt = dataUpdatedAt ? new Date(dataUpdatedAt) : null;
  const refresh = async () => { await refetch(); };
  // Interim: keeps the existing "Live" badge rendering until it is replaced
  // with the auto-refresh indicator.
  const isLive = lastUpdatedAt !== null;

  const stats = useMemo(() => {
    let yoolaAttempts = 0;
    let yoolaFailures = 0;
    let atFallbacks = 0;
    for (const log of logs) {
      const a = analyse(log);
      if (a.yoolaAttempted) yoolaAttempts++;
      if (a.yoolaFailed) yoolaFailures++;
      if (a.atFallback) atFallbacks++;
    }
    const failRate = yoolaAttempts > 0 ? yoolaFailures / yoolaAttempts : 0;
    return { yoolaAttempts, yoolaFailures, atFallbacks, failRate };
  }, [logs]);

  const alerts = useMemo(() => {
    const list: { id: string; severity: 'critical' | 'warning'; title: string; detail: string }[] = [];

    if (stats.yoolaFailures > 0) {
      const critical = stats.yoolaAttempts >= YOOLA_MIN_SAMPLE && stats.failRate >= YOOLA_FAIL_RATE_CRITICAL;
      list.push({
        id: 'yoola-fail',
        severity: critical ? 'critical' : 'warning',
        title: critical ? 'Yoola failing at high rate' : 'Yoola delivery failures',
        detail: `${stats.yoolaFailures} of ${stats.yoolaAttempts} Yoola attempts failed (${Math.round(stats.failRate * 100)}%) in the last ${WINDOW_MINUTES} min — Welile OTPs are falling back to Africa's Talking.`,
      });
    }

    if (stats.atFallbacks >= AT_FALLBACK_WARN) {
      const critical = stats.atFallbacks >= AT_FALLBACK_CRITICAL;
      list.push({
        id: 'at-fallback-spike',
        severity: critical ? 'critical' : 'warning',
        title: critical ? "Africa's Talking fallback surge" : "Unusual Africa's Talking fallback volume",
        detail: `${stats.atFallbacks} Welile messages routed to the Africa's Talking backup in the last ${WINDOW_MINUTES} min — Yoola may be degraded or unreachable.`,
      });
    }

    return list;
  }, [stats]);

  return (
    <Card className="border-l-4 border-l-primary/60">
      <CardContent className="p-3 sm:p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold flex items-center gap-2">
            <ShieldAlert className="h-4 w-4 text-primary" />
            Failover Alerts
            <span className="text-[10px] font-normal text-muted-foreground">last {WINDOW_MINUTES} min</span>
          </h3>
          <Badge variant="outline" className={cn('text-[10px] gap-1', isLive ? 'text-emerald-600 border-emerald-500/30' : 'text-muted-foreground')}>
            <Radio className={cn('h-3 w-3', isLive && 'animate-pulse')} /> {isLive ? 'Live' : 'Connecting…'}
          </Badge>
        </div>

        <div className="grid grid-cols-3 gap-2">
          <div className="rounded-lg bg-muted/40 p-2 text-center">
            <p className="text-lg font-bold">{stats.yoolaAttempts}</p>
            <p className="text-[10px] text-muted-foreground">Yoola attempts</p>
          </div>
          <div className={cn('rounded-lg p-2 text-center', stats.yoolaFailures > 0 ? 'bg-destructive/10' : 'bg-muted/40')}>
            <p className={cn('text-lg font-bold', stats.yoolaFailures > 0 && 'text-destructive')}>{stats.yoolaFailures}</p>
            <p className="text-[10px] text-muted-foreground">Yoola failures</p>
          </div>
          <div className={cn('rounded-lg p-2 text-center', stats.atFallbacks >= AT_FALLBACK_WARN ? 'bg-amber-500/10' : 'bg-muted/40')}>
            <p className={cn('text-lg font-bold', stats.atFallbacks >= AT_FALLBACK_WARN && 'text-amber-600')}>{stats.atFallbacks}</p>
            <p className="text-[10px] text-muted-foreground">AT fallbacks</p>
          </div>
        </div>

        {isLoading ? (
          <div className="flex justify-center py-3"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>
        ) : alerts.length === 0 ? (
          <div className="flex items-center gap-2 rounded-lg bg-emerald-500/5 border border-emerald-500/20 p-2.5">
            <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0" />
            <p className="text-xs text-muted-foreground">Yoola is healthy — no unusual Africa's Talking fallback activity.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {alerts.map((a) => (
              <div
                key={a.id}
                className={cn(
                  'flex items-start gap-2.5 rounded-lg border p-2.5',
                  a.severity === 'critical' ? 'border-destructive/40 bg-destructive/5' : 'border-amber-500/40 bg-amber-500/5'
                )}
              >
                <AlertTriangle className={cn('h-4 w-4 mt-0.5 shrink-0', a.severity === 'critical' ? 'text-destructive' : 'text-amber-600')} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium">{a.title}</p>
                    <Badge variant={a.severity === 'critical' ? 'destructive' : 'secondary'} className="text-[9px] px-1 py-0">{a.severity}</Badge>
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">{a.detail}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
