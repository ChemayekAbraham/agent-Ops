import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Activity, AlertTriangle, CheckCircle2, RefreshCw, Zap, Wand2 } from 'lucide-react';
import { toast } from 'sonner';
import { formatDistanceToNow } from 'date-fns';

interface Health {
  status: 'healthy' | 'degraded' | 'unhealthy';
  pending: number;
  processing: number;
  retrying: number;
  dead_letter: number;
  delivered_24h: number;
  failed_24h: number;
  success_rate: number;
  average_latency_ms: number;
  oldest_pending_at: string | null;
  last_delivered_at: string | null;
  open_gap_alerts: number;
  checked_at: string;
}

const statusVariant = (s: Health['status']): 'default' | 'secondary' | 'destructive' =>
  s === 'healthy' ? 'default' : s === 'degraded' ? 'secondary' : 'destructive';

function Kpi({ label, value, tone }: { label: string; value: string | number; tone?: 'good' | 'warn' | 'bad' }) {
  const color =
    tone === 'good' ? 'text-emerald-600'
    : tone === 'warn' ? 'text-amber-600'
    : tone === 'bad' ? 'text-destructive'
    : 'text-foreground';
  return (
    <div className="rounded-lg border p-3 bg-card">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`text-xl font-semibold mt-1 ${color}`}>{value}</div>
    </div>
  );
}

export function DepositBridgeHealthPanel() {
  const qc = useQueryClient();
  const [tab, setTab] = useState<'dlq' | 'gaps' | 'recent'>('dlq');
  const [selected, setSelected] = useState<Record<string, boolean>>({});

  const health = useQuery({
    queryKey: ['bridge-health'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_deposit_bridge_health');
      if (error) throw error;
      return data as unknown as Health;
    },
    refetchInterval: 15_000,
  });

  const metrics = useQuery({
    queryKey: ['bridge-metrics'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_deposit_bridge_metrics');
      if (error) throw error;
      return data as unknown as Record<string, number>;
    },
    refetchInterval: 30_000,
  });

  const dlq = useQuery({
    queryKey: ['bridge-dlq'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('deposit_bridge_events')
        .select('id, source, source_id, transaction_id, user_id, amount, attempt, last_error, dead_lettered_at, created_at')
        .eq('status', 'DEAD_LETTER')
        .order('dead_lettered_at', { ascending: false })
        .limit(50);
      if (error) throw error;
      return data ?? [];
    },
    refetchInterval: 30_000,
  });

  const gaps = useQuery({
    queryKey: ['bridge-gaps'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('deposit_bridge_gap_alerts')
        .select('*')
        .is('resolved_at', null)
        .order('detected_at', { ascending: false })
        .limit(50);
      if (error) throw error;
      return data ?? [];
    },
    refetchInterval: 30_000,
  });

  const bulkRecover = useMutation({
    mutationFn: async (ids: string[]) => {
      const { data, error } = await supabase.rpc('bulk_recover_gap_alerts', { p_alert_ids: ids });
      if (error) throw error;
      return data as { recovered: number; duplicate: number; skipped: number; errors: unknown[] };
    },
    onSuccess: (res) => {
      const errCount = Array.isArray(res?.errors) ? res.errors.length : 0;
      toast.success(
        `Recovered ${res?.recovered ?? 0} · Duplicates closed ${res?.duplicate ?? 0} · Skipped ${res?.skipped ?? 0}${errCount ? ` · Errors ${errCount}` : ''}`
      );
      setSelected({});
      qc.invalidateQueries({ queryKey: ['bridge-gaps'] });
      qc.invalidateQueries({ queryKey: ['bridge-health'] });
      qc.invalidateQueries({ queryKey: ['bridge-recent'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const gapRows = (gaps.data ?? []) as Array<{ id: string; transaction_id?: string | null; amount?: number | null; user_id?: string | null; severity: string; alert_reason: string; detected_at: string }>;
  const selectableIds = gapRows.map((g) => g.id);
  const selectedIds = selectableIds.filter((id) => selected[id]);
  const allSelected = selectableIds.length > 0 && selectedIds.length === selectableIds.length;

  const recent = useQuery({
    queryKey: ['bridge-recent'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('deposit_bridge_events')
        .select('id, source, transaction_id, amount, status, attempt, delivered_at, created_at')
        .order('created_at', { ascending: false })
        .limit(30);
      if (error) throw error;
      return data ?? [];
    },
    refetchInterval: 30_000,
  });

  const replay = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.rpc('replay_deposit_bridge_event', { p_event_id: id });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Event re-queued for delivery');
      qc.invalidateQueries({ queryKey: ['bridge-dlq'] });
      qc.invalidateQueries({ queryKey: ['bridge-health'] });
      qc.invalidateQueries({ queryKey: ['bridge-recent'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const drainNow = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.functions.invoke('bridge-worker', { body: {} });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Worker drained the queue');
      qc.invalidateQueries({ queryKey: ['bridge-health'] });
      qc.invalidateQueries({ queryKey: ['bridge-dlq'] });
      qc.invalidateQueries({ queryKey: ['bridge-recent'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const h = health.data;
  const overall = useMemo(() => {
    if (!h) return { label: 'Loading…', variant: 'secondary' as const };
    return {
      label: h.status.toUpperCase(),
      variant: statusVariant(h.status),
    };
  }, [h]);

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Activity className="h-5 w-5" />
              Deposit Bridge — Financial Event Delivery
            </CardTitle>
            <p className="text-xs text-muted-foreground mt-1">
              Durable outbox between Financial Ops and the wallet ledger. Retries with exponential backoff, DLQs after 5 attempts, gap-detects every 5 minutes.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant={overall.variant}>{overall.label}</Badge>
            <Button size="sm" variant="outline" onClick={() => drainNow.mutate()} disabled={drainNow.isPending}>
              <Zap className="h-4 w-4 mr-1" /> Drain now
            </Button>
            <Button size="sm" variant="ghost" onClick={() => health.refetch()}>
              <RefreshCw className="h-4 w-4" />
            </Button>
          </div>
        </CardHeader>
        <CardContent className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Kpi label="Pending" value={h?.pending ?? '—'} />
          <Kpi label="Retrying" value={h?.retrying ?? '—'} tone={h && h.retrying > 0 ? 'warn' : undefined} />
          <Kpi label="Dead Letter" value={h?.dead_letter ?? '—'} tone={h && h.dead_letter > 0 ? 'bad' : 'good'} />
          <Kpi label="Open Gap Alerts" value={h?.open_gap_alerts ?? '—'} tone={h && h.open_gap_alerts > 0 ? 'bad' : 'good'} />
          <Kpi label="Success Rate (24h)" value={h ? `${h.success_rate}%` : '—'} tone={h && h.success_rate >= 99.9 ? 'good' : 'warn'} />
          <Kpi label="Avg Latency" value={h ? `${Math.round(h.average_latency_ms)} ms` : '—'} />
          <Kpi label="Delivered (24h)" value={h?.delivered_24h ?? '—'} />
          <Kpi
            label="Oldest Pending"
            value={h?.oldest_pending_at ? formatDistanceToNow(new Date(h.oldest_pending_at), { addSuffix: true }) : '—'}
            tone={h?.oldest_pending_at && new Date(h.oldest_pending_at) < new Date(Date.now() - 10 * 60_000) ? 'warn' : undefined}
          />
        </CardContent>
      </Card>

      {metrics.data && (
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Metrics</CardTitle></CardHeader>
          <CardContent className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
            {Object.entries(metrics.data).map(([k, v]) => (
              <div key={k} className="flex justify-between gap-2 border rounded px-2 py-1">
                <span className="text-muted-foreground truncate">{k}</span>
                <span className="font-mono">{v ?? 0}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <div className="flex gap-2 flex-wrap">
        <Button size="sm" variant={tab === 'dlq' ? 'default' : 'outline'} onClick={() => setTab('dlq')}>
          <AlertTriangle className="h-4 w-4 mr-1" /> Dead Letter ({dlq.data?.length ?? 0})
        </Button>
        <Button size="sm" variant={tab === 'gaps' ? 'default' : 'outline'} onClick={() => setTab('gaps')}>
          Gap Alerts ({gaps.data?.length ?? 0})
        </Button>
        <Button size="sm" variant={tab === 'recent' ? 'default' : 'outline'} onClick={() => setTab('recent')}>
          <CheckCircle2 className="h-4 w-4 mr-1" /> Recent Events
        </Button>
      </div>

      {tab === 'dlq' && (
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Dead Letter Queue</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {(dlq.data ?? []).length === 0 && (
              <div className="text-sm text-muted-foreground py-4 text-center">No dead-lettered events. 🎉</div>
            )}
            {(dlq.data ?? []).map((e: any) => (
              <div key={e.id} className="flex items-start justify-between gap-3 border rounded p-3 text-sm">
                <div className="min-w-0 flex-1">
                  <div className="font-mono text-xs truncate">{e.source} · {e.transaction_id ?? e.source_id}</div>
                  <div className="text-xs text-muted-foreground mt-0.5">
                    UGX {Number(e.amount).toLocaleString()} · attempt {e.attempt} · {formatDistanceToNow(new Date(e.dead_lettered_at ?? e.created_at), { addSuffix: true })}
                  </div>
                  {e.last_error && <div className="text-xs text-destructive mt-1 line-clamp-2">{e.last_error}</div>}
                </div>
                <Button size="sm" variant="outline" onClick={() => replay.mutate(e.id)} disabled={replay.isPending}>
                  Replay
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {tab === 'gaps' && (
        <Card>
          <CardHeader className="pb-2 flex flex-row items-center justify-between gap-2 space-y-0">
            <CardTitle className="text-sm">Gap Detector Alerts (unresolved)</CardTitle>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={selectableIds.length === 0}
                onClick={() =>
                  setSelected(allSelected ? {} : Object.fromEntries(selectableIds.map((id) => [id, true])))
                }
              >
                {allSelected ? 'Clear all' : 'Select all'}
              </Button>
              <Button
                size="sm"
                disabled={selectedIds.length === 0 || bulkRecover.isPending}
                onClick={() => {
                  if (!confirm(`Recover ${selectedIds.length} selected gap alert(s)? A production float credit will be posted for each, and any TID already reconciled will be closed without double credit.`)) return;
                  bulkRecover.mutate(selectedIds);
                }}
              >
                <Wand2 className="h-4 w-4 mr-1" />
                Bulk recover ({selectedIds.length || 'none'})
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={selectableIds.length === 0 || bulkRecover.isPending}
                onClick={() => {
                  if (!confirm(`Recover ALL ${selectableIds.length} open gap alert(s)?`)) return;
                  bulkRecover.mutate(selectableIds);
                }}
              >
                Recover all
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-2">
            {gapRows.length === 0 && (
              <div className="text-sm text-muted-foreground py-4 text-center">No open gaps.</div>
            )}
            {gapRows.map((g) => {
              const recoverable = !!(g.user_id && g.amount && Number(g.amount) > 0);
              return (
                <div key={g.id} className="border rounded p-3 text-sm flex items-start gap-3">
                  <Checkbox
                    className="mt-1"
                    checked={!!selected[g.id]}
                    onCheckedChange={(v) =>
                      setSelected((s) => ({ ...s, [g.id]: !!v }))
                    }
                    aria-label="Select gap alert for bulk recovery"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <Badge variant={g.severity === 'critical' ? 'destructive' : 'secondary'}>{g.severity}</Badge>
                      <span className="text-xs text-muted-foreground">
                        {formatDistanceToNow(new Date(g.detected_at), { addSuffix: true })}
                      </span>
                    </div>
                    <div className="mt-1 font-mono text-xs truncate">{g.transaction_id ?? '(no TID)'}</div>
                    <div className="text-xs text-muted-foreground">
                      UGX {Number(g.amount ?? 0).toLocaleString()} · {g.alert_reason}
                      {!recoverable && <span className="ml-2 text-amber-600">· needs manual data</span>}
                    </div>
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      {tab === 'recent' && (
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Recent Events</CardTitle></CardHeader>
          <CardContent className="space-y-1.5">
            {(recent.data ?? []).map((e: any) => (
              <div key={e.id} className="flex items-center justify-between text-xs border-b py-1.5 gap-2">
                <div className="font-mono truncate">{e.transaction_id ?? e.id.slice(0, 8)}</div>
                <div className="text-muted-foreground">UGX {Number(e.amount).toLocaleString()}</div>
                <Badge
                  variant={
                    e.status === 'DELIVERED' ? 'default'
                    : e.status === 'DEAD_LETTER' ? 'destructive'
                    : 'secondary'
                  }
                  className="text-[10px]"
                >
                  {e.status}
                </Badge>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}