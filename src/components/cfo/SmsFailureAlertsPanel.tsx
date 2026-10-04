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
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { AlertTriangle, Loader2, ShieldCheck, Settings, ScanLine, CheckCircle2, BellRing } from 'lucide-react';
import { format } from 'date-fns';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

interface TopRef {
  reference?: string;
  source?: string;
  failed_count?: number;
  sample_error?: string;
  sample_phone?: string;
}

interface AlertRow {
  id: string;
  window_date: string;
  window_start: string;
  window_end: string;
  total_count: number;
  sent_count: number;
  failed_count: number;
  failure_rate_pct: number;
  severity: string;
  top_failed_references: TopRef[];
  status: string;
  acknowledged_at: string | null;
  email_sent: boolean;
  created_at: string;
}

interface ConfigRow {
  id: number;
  enabled: boolean;
  failure_count_threshold: number;
  failure_rate_threshold_pct: number;
  min_sample_size: number;
  email_enabled: boolean;
  email_recipients: string[];
}

export function SmsFailureAlertsPanel() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [configOpen, setConfigOpen] = useState(false);
  const [scanning, setScanning] = useState(false);

  const { data: alerts, isLoading } = useQuery({
    queryKey: ['sms-failure-alerts'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('sms_failure_alerts')
        .select('*')
        .order('window_date', { ascending: false })
        .limit(30);
      if (error) throw error;
      return (data || []) as unknown as AlertRow[];
    },
    staleTime: 30_000,
  });

  const { data: config } = useQuery({
    queryKey: ['sms-failure-alert-config'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('sms_failure_alert_config')
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
        .from('sms_failure_alerts')
        .update({ status: 'acknowledged', acknowledged_by: user?.id, acknowledged_at: new Date().toISOString() })
        .eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['sms-failure-alerts'] }); toast.success('Alert acknowledged'); },
    onError: (e: any) => toast.error(e.message || 'Failed to acknowledge'),
  });

  const runScan = async () => {
    setScanning(true);
    try {
      const { data, error } = await supabase.functions.invoke('sms-failure-daily-alert');
      if (error) throw error;
      const r = data as Record<string, any>;
      if (r?.triggered) {
        toast.warning(`Alert raised: ${r.failed} failed of ${r.total} (${r.failure_rate_pct}%)`);
      } else if (r?.enabled === false) {
        toast.info('Alerting is disabled in settings');
      } else {
        toast.success(`No alert — ${r?.failed ?? 0} failed of ${r?.total ?? 0} in last 24h`);
      }
      qc.invalidateQueries({ queryKey: ['sms-failure-alerts'] });
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
              <BellRing className="h-3.5 w-3.5" />
              SMS Failure Alerts
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
                <>Daily scan active · alert when failures ≥ <b>{config.failure_count_threshold}</b> or rate ≥ <b>{config.failure_rate_threshold_pct}%</b> (min {config.min_sample_size} sends).
                {config.email_enabled ? ` Email: on (${config.email_recipients.length} recipient${config.email_recipients.length === 1 ? '' : 's'})` : ' Email: off'}</>
              ) : <span className="text-destructive">Alerting is disabled.</span>}
            </p>
          )}

          {isLoading ? (
            <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
          ) : !(alerts || []).length ? (
            <div className="text-center py-6">
              <CheckCircle2 className="h-8 w-8 mx-auto mb-2 text-emerald-600" />
              <p className="text-sm text-muted-foreground">No SMS failure alerts. All within threshold.</p>
            </div>
          ) : (
            <div className="space-y-2 max-h-[460px] overflow-y-auto">
              {(alerts || []).map((a) => {
                const critical = a.severity === 'critical';
                const isOpen = a.status === 'open';
                return (
                  <div
                    key={a.id}
                    className={cn(
                      'rounded-xl border p-3',
                      isOpen
                        ? critical ? 'border-destructive/40 bg-destructive/5' : 'border-amber-500/40 bg-amber-500/5'
                        : 'border-border/50',
                    )}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-start gap-2 min-w-0">
                        <AlertTriangle className={cn('h-4 w-4 mt-0.5 shrink-0', critical ? 'text-destructive' : 'text-amber-600')} />
                        <div className="min-w-0">
                          <p className="text-sm font-semibold">
                            {a.failed_count} failed of {a.total_count} sends · {a.failure_rate_pct}%
                          </p>
                          <p className="text-[11px] text-muted-foreground">
                            {format(new Date(a.window_date), 'MMM d, yyyy')} · last 24h window
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

                    {a.top_failed_references?.length > 0 && (
                      <div className="mt-2 pl-6 space-y-1">
                        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Top failed references</p>
                        {a.top_failed_references.slice(0, 5).map((r, i) => (
                          <div key={i} className="text-[11px] flex items-center gap-2 flex-wrap">
                            <span className="font-mono text-primary">{r.reference || '(no reference)'}</span>
                            <Badge variant="outline" className="text-[9px] py-0">{r.source || 'unknown'}</Badge>
                            <span className="text-destructive font-semibold">{r.failed_count}×</span>
                            {r.sample_error && <span className="text-muted-foreground truncate">— {r.sample_error}</span>}
                          </div>
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

      <ThresholdConfigDialog open={configOpen} onOpenChange={setConfigOpen} config={config} userId={user?.id} />
    </>
  );
}

function ThresholdConfigDialog({
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
    id: 1, enabled: true, failure_count_threshold: 5, failure_rate_threshold_pct: 20,
    min_sample_size: 10, email_enabled: false, email_recipients: [],
  };

  const update = (patch: Partial<ConfigRow>) => setForm({ ...current, ...patch });

  const save = useMutation({
    mutationFn: async () => {
      const { error } = await supabase
        .from('sms_failure_alert_config')
        .update({
          enabled: current.enabled,
          failure_count_threshold: Number(current.failure_count_threshold) || 0,
          failure_rate_threshold_pct: Number(current.failure_rate_threshold_pct) || 0,
          min_sample_size: Number(current.min_sample_size) || 0,
          email_enabled: current.email_enabled,
          email_recipients: current.email_recipients,
          updated_at: new Date().toISOString(),
          updated_by: userId,
        })
        .eq('id', 1);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sms-failure-alert-config'] });
      toast.success('Alert thresholds saved');
      onOpenChange(false);
    },
    onError: (e: any) => toast.error(e.message || 'Failed to save'),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Settings className="h-4 w-4" /> SMS Alert Thresholds
          </DialogTitle>
          <DialogDescription>Tune when the daily SMS failure alert fires and who gets emailed.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 text-sm">
          <div className="flex items-center justify-between">
            <Label htmlFor="enabled">Alerting enabled</Label>
            <Switch id="enabled" checked={current.enabled} onCheckedChange={(v) => update({ enabled: v })} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">Failure count threshold</Label>
              <Input type="number" min={1} value={current.failure_count_threshold}
                onChange={(e) => update({ failure_count_threshold: Number(e.target.value) })} className="h-8" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Failure rate % threshold</Label>
              <Input type="number" min={1} max={100} value={current.failure_rate_threshold_pct}
                onChange={(e) => update({ failure_rate_threshold_pct: Number(e.target.value) })} className="h-8" />
            </div>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Minimum sample size (sends in 24h before alerting)</Label>
            <Input type="number" min={1} value={current.min_sample_size}
              onChange={(e) => update({ min_sample_size: Number(e.target.value) })} className="h-8" />
          </div>
          <div className="flex items-center justify-between border-t pt-3">
            <Label htmlFor="email-enabled">Also send email alert</Label>
            <Switch id="email-enabled" checked={current.email_enabled} onCheckedChange={(v) => update({ email_enabled: v })} />
          </div>
          {current.email_enabled && (
            <div className="space-y-1">
              <Label className="text-xs">Email recipients (comma-separated)</Label>
              <Input
                placeholder="ops@welile.com, cfo@welile.com"
                value={current.email_recipients.join(', ')}
                onChange={(e) => update({ email_recipients: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })}
                className="h-8"
              />
            </div>
          )}
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