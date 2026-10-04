import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import {
  AlertTriangle, Loader2, ShieldCheck, Settings, ScanLine, CheckCircle2,
  ShieldAlert, User, Receipt,
} from 'lucide-react';
import { format } from 'date-fns';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

// ── Human-readable labels for the validation failure codes ──────────────────
const CODE_LABELS: Record<string, string> = {
  sms_tid_mismatch: 'TID mismatch',
  sms_amount_mismatch: 'Amount mismatch',
  sms_amount_unreadable: 'Amount unreadable',
  unknown: 'Other',
};
const codeLabel = (c: string) => CODE_LABELS[c] ?? c;

interface CodeCount { code: string; n: number }
interface ApproverCount { approver_id: string; label: string | null; failed: number }
interface RequestCount { withdrawal_request_id: string; failed: number }
interface Metrics {
  window_hours: number;
  total_attempts: number;
  matched_count: number;
  failed_count: number;
  failure_rate_pct: number;
  by_code: CodeCount[];
  top_approvers: ApproverCount[];
  top_requests: RequestCount[];
}

interface AlertRow {
  id: string;
  subject_type: string;
  subject_id: string;
  subject_label: string | null;
  window_start: string;
  window_end: string;
  total_attempts: number;
  failed_count: number;
  matched_count: number;
  failure_rate_pct: number;
  top_failure_codes: CodeCount[];
  severity: string;
  status: string;
  acknowledged_at: string | null;
  created_at: string;
}

interface ConfigRow {
  id: number;
  enabled: boolean;
  window_minutes: number;
  failure_count_threshold: number;
  min_attempts: number;
}

export function SmsVerificationMonitorPanel() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [configOpen, setConfigOpen] = useState(false);
  const [scanning, setScanning] = useState(false);

  const { data: metrics, isLoading: metricsLoading } = useQuery({
    queryKey: ['sms-verification-metrics'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_sms_verification_metrics', { p_hours: 24 });
      if (error) throw error;
      return data as unknown as Metrics;
    },
    staleTime: 30_000,
  });

  const { data: alerts, isLoading } = useQuery({
    queryKey: ['sms-verification-alerts'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('sms_verification_failure_alerts')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(40);
      if (error) throw error;
      return (data || []) as unknown as AlertRow[];
    },
    staleTime: 30_000,
  });

  const { data: config } = useQuery({
    queryKey: ['sms-verification-alert-config'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('sms_verification_alert_config')
        .select('*')
        .eq('id', 1)
        .maybeSingle();
      if (error) throw error;
      return data as unknown as ConfigRow | null;
    },
    staleTime: 60_000,
  });

  const acknowledge = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from('sms_verification_failure_alerts')
        .update({ status: 'acknowledged', acknowledged_by: user?.id, acknowledged_at: new Date().toISOString() })
        .eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['sms-verification-alerts'] }); toast.success('Alert acknowledged'); },
    onError: (e: any) => toast.error(e.message || 'Failed to acknowledge'),
  });

  const runScan = async () => {
    setScanning(true);
    try {
      const { data, error } = await supabase.rpc('detect_sms_verification_failures');
      if (error) throw error;
      const r = data as Record<string, any>;
      if (r?.enabled === false) {
        toast.info('Monitoring is disabled in settings');
      } else if ((r?.raised ?? 0) > 0) {
        toast.warning(`${r.raised} alert${r.raised === 1 ? '' : 's'} raised for repeated failures`);
      } else {
        toast.success('No repeated-failure alerts in the current window');
      }
      qc.invalidateQueries({ queryKey: ['sms-verification-alerts'] });
      qc.invalidateQueries({ queryKey: ['sms-verification-metrics'] });
    } catch (e: any) {
      toast.error(e.message || 'Scan failed');
    } finally {
      setScanning(false);
    }
  };

  const openAlerts = (alerts || []).filter((a) => a.status === 'open');

  return (
    <>
      <Card className="rounded-2xl">
        <CardContent className="p-4">
          <div className="flex items-center justify-between gap-2 mb-3 flex-wrap">
            <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground flex items-center gap-2">
              <ShieldAlert className="h-3.5 w-3.5" />
              Payout SMS Verification Monitor
              {openAlerts.length > 0 && (
                <Badge variant="destructive" className="text-[10px]">{openAlerts.length} open</Badge>
              )}
            </p>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" className="h-7 text-xs gap-1" onClick={runScan} disabled={scanning}>
                {scanning ? <Loader2 className="h-3 w-3 animate-spin" /> : <ScanLine className="h-3 w-3" />} Run scan
              </Button>
              <Button variant="ghost" size="sm" className="h-7 text-xs gap-1" onClick={() => setConfigOpen(true)}>
                <Settings className="h-3 w-3" /> Thresholds
              </Button>
            </div>
          </div>

          {config && (
            <p className="text-[11px] text-muted-foreground mb-3">
              {config.enabled ? (
                <>Auto-scan every 15 min · alert when a merchant or a withdrawal has ≥ <b>{config.failure_count_threshold}</b> failed
                verifications within <b>{config.window_minutes} min</b> (min {config.min_attempts} attempts).</>
              ) : <span className="text-destructive">Monitoring is disabled.</span>}
            </p>
          )}

          {/* ── Metrics (last 24h) ─────────────────────────────────────── */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
            <MetricTile label="Attempts (24h)" value={metrics?.total_attempts ?? 0} loading={metricsLoading} />
            <MetricTile label="Matched" value={metrics?.matched_count ?? 0} tone="ok" loading={metricsLoading} />
            <MetricTile label="Failed" value={metrics?.failed_count ?? 0} tone={metrics && metrics.failed_count > 0 ? 'bad' : undefined} loading={metricsLoading} />
            <MetricTile label="Failure rate" value={`${metrics?.failure_rate_pct ?? 0}%`} tone={metrics && metrics.failure_rate_pct >= 20 ? 'bad' : undefined} loading={metricsLoading} />
          </div>

          {(metrics?.by_code?.length ?? 0) > 0 && (
            <div className="mb-3 flex flex-wrap items-center gap-1.5">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">By reason:</span>
              {metrics!.by_code.map((c) => (
                <Badge key={c.code} variant="outline" className="text-[10px]">
                  {codeLabel(c.code)} · <span className="text-destructive font-semibold ml-1">{c.n}</span>
                </Badge>
              ))}
            </div>
          )}

          {(metrics?.top_approvers?.length ?? 0) > 0 && (
            <div className="mb-3 rounded-xl border border-border/50 p-3">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5 flex items-center gap-1">
                <User className="h-3 w-3" /> Top merchants by failures (24h)
              </p>
              <div className="space-y-1">
                {metrics!.top_approvers.slice(0, 5).map((a) => (
                  <div key={a.approver_id} className="text-[11px] flex items-center justify-between gap-2">
                    <span className="truncate">{a.label || a.approver_id}</span>
                    <span className="text-destructive font-semibold shrink-0">{a.failed}×</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── Alerts feed ────────────────────────────────────────────── */}
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">Repeated-failure alerts</p>
          {isLoading ? (
            <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
          ) : !(alerts || []).length ? (
            <div className="text-center py-6">
              <CheckCircle2 className="h-8 w-8 mx-auto mb-2 text-emerald-600" />
              <p className="text-sm text-muted-foreground">No repeated-failure alerts. Everything within threshold.</p>
            </div>
          ) : (
            <div className="space-y-2 max-h-[460px] overflow-y-auto">
              {(alerts || []).map((a) => {
                const critical = a.severity === 'critical';
                const high = a.severity === 'high';
                const isOpen = a.status === 'open';
                return (
                  <div
                    key={a.id}
                    className={cn(
                      'rounded-xl border p-3',
                      isOpen
                        ? critical ? 'border-destructive/40 bg-destructive/5'
                          : high ? 'border-orange-500/40 bg-orange-500/5'
                          : 'border-amber-500/40 bg-amber-500/5'
                        : 'border-border/50',
                    )}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-start gap-2 min-w-0">
                        <AlertTriangle className={cn('h-4 w-4 mt-0.5 shrink-0', critical ? 'text-destructive' : high ? 'text-orange-600' : 'text-amber-600')} />
                        <div className="min-w-0">
                          <p className="text-sm font-semibold flex items-center gap-1.5">
                            {a.subject_type === 'approver' ? <User className="h-3.5 w-3.5" /> : <Receipt className="h-3.5 w-3.5" />}
                            <span className="truncate">
                              {a.subject_type === 'approver' ? 'Merchant' : 'Withdrawal'}: {a.subject_label || a.subject_id}
                            </span>
                          </p>
                          <p className="text-[11px] text-muted-foreground">
                            {a.failed_count} failed of {a.total_attempts} attempts · {a.failure_rate_pct}% · {format(new Date(a.created_at), 'MMM d, HH:mm')}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <Badge variant={critical ? 'destructive' : 'secondary'} className="text-[10px] capitalize">{a.severity}</Badge>
                        {isOpen ? (
                          <Button size="sm" variant="outline" className="h-7 text-xs gap-1" onClick={() => acknowledge.mutate(a.id)} disabled={acknowledge.isPending}>
                            <ShieldCheck className="h-3 w-3" /> Ack
                          </Button>
                        ) : (
                          <Badge variant="outline" className="text-[10px] text-muted-foreground gap-1">
                            <CheckCircle2 className="h-3 w-3" /> Acked
                          </Badge>
                        )}
                      </div>
                    </div>

                    {a.top_failure_codes?.length > 0 && (
                      <div className="mt-2 pl-6 flex flex-wrap gap-1.5">
                        {a.top_failure_codes.slice(0, 5).map((c, i) => (
                          <Badge key={i} variant="outline" className="text-[10px]">
                            {codeLabel(c.code)} · <span className="text-destructive font-semibold ml-1">{c.n}×</span>
                          </Badge>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <VerificationThresholdDialog open={configOpen} onOpenChange={setConfigOpen} config={config} userId={user?.id} />
    </>
  );
}

function MetricTile({
  label, value, tone, loading,
}: {
  label: string;
  value: number | string;
  tone?: 'ok' | 'bad';
  loading?: boolean;
}) {
  return (
    <div className="rounded-xl border border-border/50 p-2.5">
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className={cn(
        'text-lg font-bold tabular-nums',
        tone === 'bad' && 'text-destructive',
        tone === 'ok' && 'text-emerald-600',
      )}>
        {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : value}
      </p>
    </div>
  );
}

function VerificationThresholdDialog({
  open, onOpenChange, config, userId,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  config: ConfigRow | null | undefined;
  userId?: string;
}) {
  const qc = useQueryClient();
  const [form, setForm] = useState<ConfigRow | null>(null);

  const current = form || config || {
    id: 1, enabled: true, window_minutes: 60, failure_count_threshold: 3, min_attempts: 3,
  };
  const update = (patch: Partial<ConfigRow>) => setForm({ ...current, ...patch });

  const save = useMutation({
    mutationFn: async () => {
      const { error } = await supabase
        .from('sms_verification_alert_config')
        .update({
          enabled: current.enabled,
          window_minutes: Number(current.window_minutes) || 60,
          failure_count_threshold: Number(current.failure_count_threshold) || 1,
          min_attempts: Number(current.min_attempts) || 1,
          updated_at: new Date().toISOString(),
          updated_by: userId,
        })
        .eq('id', 1);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sms-verification-alert-config'] });
      toast.success('Monitoring thresholds saved');
      onOpenChange(false);
    },
    onError: (e: any) => toast.error(e.message || 'Failed to save'),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Settings className="h-4 w-4" /> Verification Monitor Thresholds
          </DialogTitle>
          <DialogDescription>Tune when repeated SMS verification failures raise a fraud/error alert.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 text-sm">
          <div className="flex items-center justify-between">
            <Label htmlFor="v-enabled">Monitoring enabled</Label>
            <Switch id="v-enabled" checked={current.enabled} onCheckedChange={(v) => update({ enabled: v })} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">Failure count threshold</Label>
              <Input type="number" min={1} value={current.failure_count_threshold}
                onChange={(e) => update({ failure_count_threshold: Number(e.target.value) })} className="h-8" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Window (minutes)</Label>
              <Input type="number" min={5} value={current.window_minutes}
                onChange={(e) => update({ window_minutes: Number(e.target.value) })} className="h-8" />
            </div>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Minimum attempts before alerting</Label>
            <Input type="number" min={1} value={current.min_attempts}
              onChange={(e) => update({ min_attempts: Number(e.target.value) })} className="h-8" />
          </div>
          <p className="text-[11px] text-muted-foreground">
            Severity escalates automatically: <b>high</b> at 2× and <b>critical</b> at 3× the failure threshold.
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending && <Loader2 className="h-4 w-4 animate-spin mr-1" />} Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}