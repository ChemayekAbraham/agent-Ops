import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Activity, AlertTriangle, CheckCircle2, Gauge, History, Loader2, RefreshCw, ShieldCheck } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { format } from 'date-fns';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';

type Category =
  | 'financial_integrity'
  | 'business_rule'
  | 'operational'
  | 'comparator'
  | 'presentation'
  | 'monitoring';

interface AlertState {
  check_key: string;
  label: string;
  category: Category | string;
  channel: string;
  state: string;
  severity: string;
  item_count: number;
  exposure: number;
  first_seen_at: string;
  last_seen_at: string;
  last_changed_at: string;
  acknowledged_at: string | null;
}

interface ScanRow {
  id: string;
  scanned_at: string;
  trigger_source: string;
  financial_severity: string;
  financial_count: number;
  financial_exposure: number;
  anomaly_count: number;
  notify_channel: string;
  notification_reason: string | null;
  alert_fingerprint: string | null;
  fingerprint_repeat: boolean;
  notified: boolean;
}

const SECTIONS: { key: string; title: string; blurb: string; categories: string[]; financial?: boolean }[] = [
  {
    key: 'financial',
    title: 'Financial Integrity',
    blurb: 'Genuine money risk. Only this section can page an executive by SMS.',
    categories: ['financial_integrity'],
    financial: true,
  },
  {
    key: 'operational',
    title: 'Operational Quality',
    blurb: 'Business-rule and operational hygiene. Reported by email.',
    categories: ['business_rule', 'operational'],
  },
  {
    key: 'comparator',
    title: 'Comparator Health',
    blurb: 'Cache vs projection comparison. Never counted as financial exposure.',
    categories: ['comparator'],
  },
  {
    key: 'monitoring',
    title: 'Monitoring Health',
    blurb: 'Defects in the monitoring views and alert calculations themselves.',
    categories: ['monitoring'],
  },
  {
    key: 'presentation',
    title: 'Presentation',
    blurb: 'Display and dashboard reporting differences only.',
    categories: ['presentation'],
  },
];

const severityClass = (s: string) => {
  if (s === 'critical') return 'bg-destructive/10 text-destructive border-destructive/30';
  if (s === 'high') return 'bg-amber-500/10 text-amber-600 border-amber-500/30';
  if (s === 'medium') return 'bg-yellow-500/10 text-yellow-700 border-yellow-500/30';
  if (s === 'low') return 'bg-muted text-muted-foreground border-border';
  return 'bg-emerald-500/10 text-emerald-600 border-emerald-500/30';
};

const stateClass = (s: string) => {
  if (s === 'RESOLVED') return 'text-emerald-600';
  if (s === 'ACKNOWLEDGED') return 'text-blue-600';
  if (s === 'HISTORICAL') return 'text-muted-foreground';
  return 'text-foreground';
};

export function FinanceMonitoringHealthPanel() {
  const qc = useQueryClient();
  const [scanning, setScanning] = useState(false);

  const { data: states, isLoading } = useQuery({
    queryKey: ['finance-anomaly-alert-states'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('finance_anomaly_alert_states')
        .select('*')
        .order('category', { ascending: true });
      if (error) throw error;
      return (data || []) as unknown as AlertState[];
    },
    staleTime: 60_000,
  });

  const { data: scans } = useQuery({
    queryKey: ['finance-anomaly-scan-audit'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('finance_anomaly_scans')
        .select('id, scanned_at, trigger_source, financial_severity, financial_count, financial_exposure, anomaly_count, notify_channel, notification_reason, alert_fingerprint, fingerprint_repeat, notified')
        .order('scanned_at', { ascending: false })
        .limit(15);
      if (error) throw error;
      return (data || []) as unknown as ScanRow[];
    },
    staleTime: 60_000,
  });

  const acknowledge = useMutation({
    mutationFn: async (checkKey: string) => {
      const { error } = await supabase.rpc('acknowledge_finance_anomaly_alert', {
        p_check_key: checkKey,
        p_note: null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['finance-anomaly-alert-states'] });
      toast.success('Alert acknowledged');
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const runScan = async () => {
    setScanning(true);
    try {
      const { data, error } = await supabase.functions.invoke('finance-anomaly-scan', {
        body: { trigger_source: 'manual' },
      });
      if (error) throw error;
      const channel = (data as { notify_channel?: string })?.notify_channel ?? 'none';
      toast.success(`Scan complete — channel: ${channel}`);
      qc.invalidateQueries({ queryKey: ['finance-anomaly-alert-states'] });
      qc.invalidateQueries({ queryKey: ['finance-anomaly-scan-audit'] });
    } catch (e) {
      toast.error((e as Error).message || 'Scan failed');
    } finally {
      setScanning(false);
    }
  };

  const latest = scans?.[0];

  const grouped = useMemo(() => {
    const map = new Map<string, AlertState[]>();
    for (const section of SECTIONS) {
      map.set(
        section.key,
        (states || []).filter((s) => section.categories.includes(String(s.category))),
      );
    }
    return map;
  }, [states]);

  const historical = useMemo(
    () => (states || []).filter((s) => s.state === 'HISTORICAL' && s.item_count > 0),
    [states],
  );

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Gauge className="h-4 w-4 text-primary" />
            Finance monitoring health
          </CardTitle>
          <Button size="sm" variant="outline" onClick={runScan} disabled={scanning}>
            {scanning ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5 mr-1" />}
            Run scan
          </Button>
        </div>
        {latest && (
          <p className="text-xs text-muted-foreground">
            Last scan {format(new Date(latest.scanned_at), 'dd MMM HH:mm')} · trigger {latest.trigger_source} ·
            channel <span className="font-medium">{latest.notify_channel}</span>
            {latest.fingerprint_repeat ? ' (heartbeat — no executive notification)' : ''}
          </p>
        )}
      </CardHeader>
      <CardContent className="space-y-5">
        {isLoading ? (
          <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        ) : (
          <>
            {latest && (
              <div
                className={cn(
                  'rounded-xl border p-3 flex items-start gap-3',
                  latest.financial_count > 0
                    ? 'border-destructive/30 bg-destructive/5'
                    : 'border-emerald-500/30 bg-emerald-500/5',
                )}
              >
                {latest.financial_count > 0
                  ? <AlertTriangle className="h-4 w-4 text-destructive mt-0.5" />
                  : <ShieldCheck className="h-4 w-4 text-emerald-600 mt-0.5" />}
                <div className="text-sm">
                  <p className="font-semibold">
                    {latest.financial_count > 0
                      ? `${latest.financial_count} financial integrity finding(s) · ${formatUGX(latest.financial_exposure)}`
                      : 'No active financial integrity incidents'}
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {latest.anomaly_count} total findings across all categories. Comparator, monitoring and
                    presentation findings carry no financial exposure.
                  </p>
                </div>
              </div>
            )}

            {SECTIONS.map((section) => {
              const rows = grouped.get(section.key) || [];
              const active = rows.filter((r) => r.item_count > 0);
              const count = active.reduce((s, r) => s + Number(r.item_count || 0), 0);
              const exposure = active.reduce((s, r) => s + Number(r.exposure || 0), 0);
              const severity = active.length
                ? (['critical', 'high', 'medium', 'low'].find((sv) => active.some((r) => r.severity === sv)) ?? 'clean')
                : 'clean';
              return (
                <div key={section.key} className="rounded-xl border overflow-hidden">
                  <div className="px-3 py-2 bg-muted/40 flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="text-sm font-semibold flex items-center gap-2">
                        {section.financial ? <Activity className="h-3.5 w-3.5 text-primary" /> : null}
                        {section.title}
                      </p>
                      <p className="text-[11px] text-muted-foreground">{section.blurb}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="text-[10px]">{count} finding{count === 1 ? '' : 's'}</Badge>
                      <Badge variant="outline" className="text-[10px]">
                        {section.financial ? 'Exposure' : 'Reported'} {formatUGX(exposure)}
                      </Badge>
                      <Badge variant="outline" className={cn('text-[10px] uppercase', severityClass(severity))}>{severity}</Badge>
                    </div>
                  </div>
                  <div className="divide-y">
                    {rows.length === 0 ? (
                      <p className="px-3 py-3 text-xs text-muted-foreground">No checks registered yet — run a scan.</p>
                    ) : rows.map((r) => (
                      <div key={r.check_key} className="px-3 py-2 flex flex-wrap items-center gap-2">
                        {r.item_count === 0
                          ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 shrink-0" />
                          : <AlertTriangle className="h-3.5 w-3.5 text-amber-600 shrink-0" />}
                        <div className="flex-1 min-w-[220px]">
                          <p className="text-sm">{r.label}</p>
                          <p className="text-[11px] text-muted-foreground">
                            <span className={stateClass(r.state)}>{r.state}</span> · {r.channel} ·
                            {' '}first seen {format(new Date(r.first_seen_at), 'dd MMM')} ·
                            {' '}changed {format(new Date(r.last_changed_at), 'dd MMM HH:mm')}
                          </p>
                        </div>
                        <span className="text-xs tabular-nums">{r.item_count}</span>
                        <span className="text-xs tabular-nums text-muted-foreground">
                          {r.item_count > 0 ? formatUGX(r.exposure) : '—'}
                        </span>
                        <Badge variant="outline" className={cn('text-[10px] uppercase', severityClass(r.severity))}>{r.severity}</Badge>
                        {r.item_count > 0 && r.state !== 'ACKNOWLEDGED' && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-xs h-7"
                            onClick={() => acknowledge.mutate(r.check_key)}
                            disabled={acknowledge.isPending}
                          >
                            Ack
                          </Button>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}

            <div className="rounded-xl border overflow-hidden">
              <div className="px-3 py-2 bg-muted/40 flex items-center gap-2">
                <History className="h-3.5 w-3.5 text-muted-foreground" />
                <p className="text-sm font-semibold">Historical artifacts</p>
                <Badge variant="outline" className="text-[10px]">{historical.length}</Badge>
              </div>
              {historical.length === 0 ? (
                <p className="px-3 py-3 text-xs text-muted-foreground">No historical artifacts.</p>
              ) : (
                <div className="divide-y">
                  {historical.map((r) => (
                    <div key={r.check_key} className="px-3 py-2 flex items-center gap-2 text-xs">
                      <span className="flex-1">{r.label}</span>
                      <span className="tabular-nums">{r.item_count}</span>
                      <span className="tabular-nums text-muted-foreground">{formatUGX(r.exposure)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="rounded-xl border overflow-hidden">
              <div className="px-3 py-2 bg-muted/40">
                <p className="text-sm font-semibold">Scan audit trail</p>
                <p className="text-[11px] text-muted-foreground">
                  Every scan is retained with its fingerprint and the reason a notification was or was not sent.
                </p>
              </div>
              <div className="divide-y max-h-72 overflow-y-auto">
                {(scans || []).map((s) => (
                  <div key={s.id} className="px-3 py-2 text-xs flex flex-wrap items-center gap-2">
                    <span className="tabular-nums w-28">{format(new Date(s.scanned_at), 'dd MMM HH:mm')}</span>
                    <Badge variant="outline" className="text-[10px]">{s.trigger_source}</Badge>
                    <Badge variant="outline" className={cn('text-[10px] uppercase', severityClass(s.financial_severity))}>
                      {s.financial_severity}
                    </Badge>
                    <span className="tabular-nums">{formatUGX(s.financial_exposure)}</span>
                    <Badge variant="outline" className="text-[10px]">{s.notify_channel}</Badge>
                    <span className="text-muted-foreground flex-1 min-w-[180px]">{s.notification_reason}</span>
                    <span className="font-mono text-[10px] text-muted-foreground">
                      {s.alert_fingerprint?.slice(0, 8)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
