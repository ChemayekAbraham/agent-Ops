import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { formatUGX } from '@/lib/rentCalculations';
import { format } from 'date-fns';
import {
  AlertTriangle, CheckCircle2, Shield, Users, Zap,
  Smartphone, Building2, Banknote, RefreshCw, Bell,
  TrendingUp, TrendingDown, Activity, Eye
} from 'lucide-react';
import { toast } from 'sonner';

// ─── Anomaly Alerts Panel ───
function AnomalyAlerts() {
  const queryClient = useQueryClient();
  const { data: anomalies = [], isLoading } = useQuery({
    queryKey: ['financial-anomalies'],
    queryFn: async () => {
      const { data } = await (supabase as any)
        .from('financial_anomalies')
        .select('*')
        .eq('acknowledged', false)
        .order('created_at', { ascending: false })
        .limit(20);
      return (data || []) as any[];
    },
    staleTime: 300_000,
    refetchOnWindowFocus: false,
  });

  const acknowledge = async (id: string) => {
    const { data: { user } } = await supabase.auth.getUser();
    await (supabase as any).from('financial_anomalies').update({
      acknowledged: true, acknowledged_by: user?.id, acknowledged_at: new Date().toISOString()
    }).eq('id', id);
    queryClient.invalidateQueries({ queryKey: ['financial-anomalies'] });
    toast.success('Alert acknowledged');
  };

  const severityColor: Record<string, string> = {
    critical: 'bg-destructive text-destructive-foreground',
    high: 'bg-amber-500 text-white',
    medium: 'bg-amber-400/20 text-amber-700',
    low: 'bg-muted text-muted-foreground',
  };

  const typeIcon: Record<string, typeof AlertTriangle> = {
    duplicate_tid: Shield,
    velocity_abuse: Zap,
    amount_spike: TrendingUp,
    recon_mismatch: AlertTriangle,
    channel_outage: Activity,
  };

  if (anomalies.length === 0 && !isLoading) {
    return (
      <Card className="border-emerald-500/20">
        <CardContent className="p-4 flex items-center gap-3">
          <CheckCircle2 className="h-5 w-5 text-emerald-600 shrink-0" />
          <div>
            <p className="text-sm font-semibold text-emerald-700">All Clear</p>
            <p className="text-xs text-muted-foreground">No active anomalies detected</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className={anomalies.some((a: any) => a.severity === 'critical') ? 'border-destructive/40' : 'border-amber-500/30'}>
      <CardHeader className="pb-2 px-3 sm:px-4">
        <CardTitle className="text-sm flex items-center gap-2">
          <Bell className="h-4 w-4 text-amber-600" />
          Anomaly Alerts
          <Badge variant="destructive" className="text-[10px] ml-auto">{anomalies.length}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="px-3 sm:px-4">
        <ScrollArea className="max-h-[220px]">
          <div className="space-y-2">
            {anomalies.map((a: any) => {
              const Icon = typeIcon[a.anomaly_type] || AlertTriangle;
              return (
                <div key={a.id} className="flex items-start gap-2 p-2 rounded-lg bg-muted/30 border border-border">
                  <Badge className={`text-[9px] px-1.5 shrink-0 ${severityColor[a.severity]}`}>
                    {a.severity.toUpperCase()}
                  </Badge>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1">
                      <Icon className="h-3 w-3 text-muted-foreground shrink-0" />
                      <p className="text-xs font-medium truncate">{a.title}</p>
                    </div>
                    <p className="text-[10px] text-muted-foreground truncate">{a.description}</p>
                    <p className="text-[9px] text-muted-foreground/60 mt-0.5">
                      {format(new Date(a.created_at), 'MMM d, HH:mm')}
                    </p>
                  </div>
                  <Button variant="ghost" size="sm" className="h-6 text-[10px] px-2 shrink-0" onClick={() => acknowledge(a.id)}>
                    <Eye className="h-3 w-3 mr-0.5" /> Ack
                  </Button>
                </div>
              );
            })}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}

// ─── Channel Health Monitor ───
function ChannelHealth() {
  const { data, isLoading } = useQuery({
    queryKey: ['channel-health-live'],
    queryFn: async () => {
      const { data, error } = await (supabase.rpc as any)('get_channel_health_live');
      if (error) throw error;
      return data as any;
    },
    staleTime: 300_000,
    refetchOnWindowFocus: false,
  });

  const channels = [
    { key: 'mtn', label: 'MTN', icon: Smartphone, color: 'text-amber-600', bgColor: 'bg-amber-500/10' },
    { key: 'airtel', label: 'Airtel', icon: Smartphone, color: 'text-destructive', bgColor: 'bg-destructive/10' },
    { key: 'bank', label: 'Bank', icon: Building2, color: 'text-primary', bgColor: 'bg-primary/10' },
  ];

  return (
    <Card>
      <CardHeader className="pb-2 px-3 sm:px-4">
        <CardTitle className="text-sm flex items-center gap-2">
          <Activity className="h-4 w-4 text-primary" /> Channel Health
        </CardTitle>
      </CardHeader>
      <CardContent className="px-3 sm:px-4">
        <div className="grid grid-cols-3 gap-2">
          {channels.map(ch => {
            const chData = data?.[ch.key];
            const Icon = ch.icon;
            return (
              <div key={ch.key} className="rounded-lg border p-2 space-y-1">
                <div className="flex items-center gap-1">
                  <div className={`p-1 rounded ${ch.bgColor}`}>
                    <Icon className={`h-3 w-3 ${ch.color}`} />
                  </div>
                  <span className="text-[10px] font-semibold">{ch.label}</span>
                </div>
                <div className="space-y-0.5">
                  <div className="flex justify-between text-[9px]">
                    <span className="text-muted-foreground">Pending</span>
                    <span className="font-bold">{isLoading ? '—' : chData?.deposits_pending || 0}</span>
                  </div>
                  <div className="flex justify-between text-[9px]">
                    <span className="text-muted-foreground">Today</span>
                    <span className="font-bold text-emerald-600">{isLoading ? '—' : chData?.deposits_today || 0}</span>
                  </div>
                  <div className="flex justify-between text-[9px]">
                    <span className="text-muted-foreground">Volume</span>
                    <span className="font-mono text-[8px]">{isLoading ? '—' : formatUGX(chData?.amount_today || 0)}</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        {data?.withdrawals && (
          <div className="mt-2 grid grid-cols-4 gap-1">
            {[
              { label: 'MTN W/D', value: data.withdrawals.mtn_pending, icon: '📱' },
              { label: 'Airtel W/D', value: data.withdrawals.airtel_pending, icon: '📱' },
              { label: 'Bank W/D', value: data.withdrawals.bank_pending, icon: '🏦' },
              { label: 'Cash W/D', value: data.withdrawals.cash_pending, icon: '💵' },
            ].map(wd => (
              <div key={wd.label} className="text-center p-1.5 rounded border bg-muted/20">
                <p className="text-[9px] text-muted-foreground">{wd.label}</p>
                <p className="text-sm font-black">{wd.value || 0}</p>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Agent Workload Balancer ───
function AgentWorkload() {
  const { data: agents = [], isLoading } = useQuery({
    queryKey: ['agent-workload'],
    queryFn: async () => {
      const { data, error } = await (supabase.rpc as any)('get_agent_workload_summary');
      if (error) throw error;
      return (data as any[]) || [];
    },
    staleTime: 300_000,
    refetchOnWindowFocus: false,
  });

  if (agents.length === 0 && !isLoading) {
    return (
      <Card>
        <CardContent className="p-4 text-center text-xs text-muted-foreground">
          <Users className="h-5 w-5 mx-auto mb-1 text-muted-foreground/50" />
          No cashout agents assigned yet
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-2 px-3 sm:px-4">
        <CardTitle className="text-sm flex items-center gap-2">
          <Users className="h-4 w-4 text-primary" /> Agent Workload
        </CardTitle>
      </CardHeader>
      <CardContent className="px-3 sm:px-4">
        <ScrollArea className="max-h-[200px]">
          <div className="space-y-1.5">
            {agents.map((agent: any) => {
              const utilization = agent.max_daily_payouts > 0
                ? Math.round((agent.current_queue_count / agent.max_daily_payouts) * 100)
                : 0;
              const isOverloaded = utilization > 80;
              return (
                <div key={agent.agent_id} className={`flex items-center gap-2 p-2 rounded-lg border ${isOverloaded ? 'border-amber-500/40 bg-amber-500/5' : 'bg-muted/20'}`}>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium truncate">{agent.agent_name}</p>
                    <div className="flex gap-1 mt-0.5">
                      {agent.handles_mtn && <Badge variant="outline" className="text-[8px] px-1 py-0">MTN</Badge>}
                      {agent.handles_airtel && <Badge variant="outline" className="text-[8px] px-1 py-0">Airtel</Badge>}
                      {agent.handles_bank && <Badge variant="outline" className="text-[8px] px-1 py-0">Bank</Badge>}
                      {agent.handles_cash && <Badge variant="outline" className="text-[8px] px-1 py-0">Cash</Badge>}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="flex items-center gap-1">
                      <span className="text-xs font-bold">{agent.pending_payouts}</span>
                      <span className="text-[9px] text-muted-foreground">queue</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <span className="text-[10px] font-semibold text-emerald-600">{agent.completed_today}</span>
                      <span className="text-[9px] text-muted-foreground">done</span>
                    </div>
                  </div>
                  <div className="w-12 shrink-0">
                    <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all ${isOverloaded ? 'bg-amber-500' : 'bg-emerald-500'}`}
                        style={{ width: `${Math.min(utilization, 100)}%` }}
                      />
                    </div>
                    <p className="text-[8px] text-center text-muted-foreground mt-0.5">{utilization}%</p>
                  </div>
                </div>
              );
            })}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}

// ─── Batch Processing Status ───
function BatchStatus() {
  const { data: runs = [] } = useQuery({
    queryKey: ['batch-runs'],
    queryFn: async () => {
      const { data } = await (supabase as any)
        .from('batch_processing_runs')
        .select('*')
        .order('started_at', { ascending: false })
        .limit(5);
      return (data || []) as any[];
    },
    staleTime: 300_000,
    refetchOnWindowFocus: false,
  });

  const triggerBatch = async () => {
    toast.info('Running batch processor…');
    const { error } = await supabase.functions.invoke('batch-process-financials');
    if (error) {
      toast.error('Batch failed: ' + error.message);
    } else {
      toast.success('Batch processing complete');
    }
  };

  return (
    <Card>
      <CardHeader className="pb-2 px-3 sm:px-4">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm flex items-center gap-2">
            <Zap className="h-4 w-4 text-amber-600" /> Batch Engine
          </CardTitle>
          <Button variant="outline" size="sm" className="h-7 text-[10px] gap-1" onClick={triggerBatch}>
            <RefreshCw className="h-3 w-3" /> Run Now
          </Button>
        </div>
      </CardHeader>
      <CardContent className="px-3 sm:px-4">
        <div className="space-y-1.5">
          {runs.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-3">No batch runs yet</p>
          ) : runs.map((run: any) => (
            <div key={run.id} className="flex items-center justify-between p-2 rounded-lg bg-muted/20 border">
              <div>
                <p className="text-[10px] font-medium">{run.run_type.replace(/_/g, ' ')}</p>
                <p className="text-[9px] text-muted-foreground">
                  {format(new Date(run.started_at), 'HH:mm:ss')}
                  {run.completed_at && ` · ${Math.round((new Date(run.completed_at).getTime() - new Date(run.started_at).getTime()) / 1000)}s`}
                </p>
              </div>
              <div className="flex gap-2 text-[10px]">
                {run.records_approved > 0 && (
                  <Badge className="bg-emerald-500/10 text-emerald-700 text-[9px]">✓ {run.records_approved}</Badge>
                )}
                {run.records_flagged > 0 && (
                  <Badge className="bg-amber-500/10 text-amber-700 text-[9px]">⚠ {run.records_flagged}</Badge>
                )}
                {run.records_dispatched > 0 && (
                  <Badge className="bg-primary/10 text-primary text-[9px]">→ {run.records_dispatched}</Badge>
                )}
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Auto Reconciliation ───
function AutoRecon() {
  const { data, isLoading } = useQuery({
    queryKey: ['recon-summary-server'],
    queryFn: async () => {
      const { data, error } = await (supabase.rpc as any)('get_reconciliation_summary', { p_days: 7 });
      if (error) throw error;
      return data as any;
    },
    staleTime: 60000,
  });

  const totals = data?.totals || { cash_in: 0, cash_out: 0, tx_count: 0 };
  const net = totals.cash_in - totals.cash_out;
  const isHealthy = net >= 0;

  return (
    <Card className={isHealthy ? 'border-emerald-500/20' : 'border-destructive/20'}>
      <CardHeader className="pb-2 px-3 sm:px-4">
        <CardTitle className="text-sm flex items-center gap-2">
          {isHealthy ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : <AlertTriangle className="h-4 w-4 text-destructive" />}
          7-Day Reconciliation
        </CardTitle>
      </CardHeader>
      <CardContent className="px-3 sm:px-4">
        <div className="grid grid-cols-3 gap-2">
          <div className="text-center">
            <TrendingUp className="h-3 w-3 text-emerald-600 mx-auto" />
            <p className="text-[9px] text-muted-foreground">Cash In</p>
            <p className="text-xs font-bold text-emerald-600">{isLoading ? '—' : formatUGX(totals.cash_in)}</p>
          </div>
          <div className="text-center">
            <TrendingDown className="h-3 w-3 text-destructive mx-auto" />
            <p className="text-[9px] text-muted-foreground">Cash Out</p>
            <p className="text-xs font-bold text-destructive">{isLoading ? '—' : formatUGX(totals.cash_out)}</p>
          </div>
          <div className="text-center">
            <Banknote className="h-3 w-3 text-primary mx-auto" />
            <p className="text-[9px] text-muted-foreground">Net</p>
            <p className={`text-xs font-bold ${isHealthy ? 'text-emerald-600' : 'text-destructive'}`}>
              {isLoading ? '—' : `${isHealthy ? '+' : ''}${formatUGX(net)}`}
            </p>
          </div>
        </div>
        <p className="text-[9px] text-muted-foreground text-center mt-2">
          {isLoading ? '—' : `${totals.tx_count?.toLocaleString()} transactions processed`}
        </p>
      </CardContent>
    </Card>
  );
}

// ─── Main Export ───
export function ScaleDashboard() {
  return (
    <div className="space-y-3">
      <AnomalyAlerts />
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <ChannelHealth />
        <AgentWorkload />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <BatchStatus />
        <AutoRecon />
      </div>
    </div>
  );
}
