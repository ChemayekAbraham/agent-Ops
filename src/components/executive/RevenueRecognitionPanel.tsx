import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { KPICard } from './KPICard';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { formatUGX } from '@/lib/rentCalculations';
import { toast } from '@/hooks/use-toast';
import {
  RefreshCw, CheckCircle2, AlertTriangle, Clock, Play, TrendingUp, Gauge, CalendarClock,
} from 'lucide-react';
import { formatDistanceToNow, format } from 'date-fns';
import { FeeRevenueReconciliationCheck } from './FeeRevenueReconciliationCheck';

const db = supabase as any;

interface RecognitionRun {
  id: string;
  status: string;
  trigger_source: string;
  rows_scanned: number;
  rows_updated: number;
  recognized_delta: number;
  total_recognized_after: number;
  total_deferred_after: number;
  error_message: string | null;
  started_at: string;
  finished_at: string | null;
}

const FEE_LABELS: Record<string, string> = {
  access_fee: 'Access Fee',
  platform_fee: 'Platform Fee',
  request_fee: 'Request Fee',
  service_fee: 'Service Fee',
};

/**
 * ASC 606 Revenue Recognition Pipeline
 * - Job / cron status (last run health, schedule, throughput)
 * - Recognised vs Deferred reconciliation (totals, rate, per-fee breakdown)
 * - Manual "Run now" trigger + recent run history
 */
export function RevenueRecognitionPanel() {
  const qc = useQueryClient();
  const [running, setRunning] = useState(false);

  const { data: runs, isLoading: loadingRuns } = useQuery({
    queryKey: ['revenue-recognition-runs'],
    staleTime: 60000,
    queryFn: async (): Promise<RecognitionRun[]> => {
      const { data, error } = await db
        .from('revenue_recognition_runs')
        .select('*')
        .order('started_at', { ascending: false })
        .limit(20);
      if (error) throw error;
      return (data || []) as RecognitionRun[];
    },
  });

  const { data: recon, isLoading: loadingRecon } = useQuery({
    queryKey: ['revenue-recognition-recon'],
    staleTime: 60000,
    queryFn: async () => {
      // Exact totals + by-type come from the server-aggregated RPC (the Data API
      // caps row fetches at 1,000, which under-counts once the ledger grows).
      const { data: summary, error: sumErr } = await db.rpc('get_fee_revenue_summary', { p_months: 6 });
      if (sumErr) throw sumErr;
      const s = (summary || {}) as any;
      const total = Number(s.billed || 0);
      const recognized = Number(s.recognized || 0);
      const deferred = Number(s.deferred || 0);
      const count = Number(s.row_count || 0);
      const byType: Record<string, { total: number; recognized: number; deferred: number }> = {};
      Object.entries(s.by_type || {}).forEach(([k, v]: [string, any]) => {
        byType[k] = {
          total: Number(v.billed || 0),
          recognized: Number(v.recognized || 0),
          deferred: Number(v.deferred || 0),
        };
      });
      // Status counts (recognized / partial / deferred) still need per-row status;
      // fetch just the status column (lightweight) — capped at 1,000 is acceptable
      // here since these are display-only tallies, not financial totals.
      const { data: statusRows } = await db
        .from('fee_revenue_ledger')
        .select('status')
        .limit(1000);
      let fullyCount = 0, partialCount = 0, deferredCount = 0;
      for (const r of (statusRows || []) as any[]) {
        if (r.status === 'recognized') fullyCount++;
        else if (r.status === 'partial') partialCount++;
        else deferredCount++;
      }
      return { total, recognized, deferred, fullyCount, partialCount, deferredCount, byType, count };
    },
  });

  const runNow = async () => {
    setRunning(true);
    try {
      const { data, error } = await db.rpc('run_fee_revenue_recognition');
      if (error) throw error;
      toast({
        title: 'Recognition run complete',
        description: `${(data?.rows_updated ?? 0).toLocaleString()} records updated · ${formatUGX(Number(data?.recognized_delta || 0))} newly recognised`,
      });
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['revenue-recognition-runs'] }),
        qc.invalidateQueries({ queryKey: ['revenue-recognition-recon'] }),
        qc.invalidateQueries({ queryKey: ['ceo-rev-fee-ledger'] }),
      ]);
    } catch (e: any) {
      toast({ title: 'Run failed', description: e?.message || 'Could not run recognition', variant: 'destructive' });
    } finally {
      setRunning(false);
    }
  };

  const lastRun = runs?.[0];
  const rate = recon && recon.total > 0 ? (recon.recognized / recon.total) * 100 : 0;

  const statusBadge = (status: string) => {
    if (status === 'success') return <Badge className="bg-emerald-500/10 text-emerald-700 border-emerald-500/30" variant="outline">Success</Badge>;
    if (status === 'error') return <Badge className="bg-red-500/10 text-red-700 border-red-500/30" variant="outline">Error</Badge>;
    return <Badge className="bg-amber-500/10 text-amber-700 border-amber-500/30" variant="outline">Running</Badge>;
  };

  return (
    <div className="space-y-6">
      {/* Header + run now */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex items-start gap-2.5">
          <div className="p-2 rounded-lg bg-primary/10 text-primary shrink-0">
            <Gauge className="h-4 w-4" />
          </div>
          <div>
            <h3 className="text-base font-bold leading-tight">ASC 606 Recognition Pipeline</h3>
            <p className="text-xs text-muted-foreground">Deferred fee revenue recognised over each rent plan's financing period</p>
          </div>
        </div>
        <Button size="sm" onClick={runNow} disabled={running} className="gap-1.5">
          {running ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
          {running ? 'Running…' : 'Run now'}
        </Button>
      </div>

      {/* Job / cron status */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <CalendarClock className="h-4 w-4 text-muted-foreground" />
          <h4 className="text-sm font-semibold">Job Status</h4>
          <Badge variant="outline" className="text-[10px]">Daily · 01:00 UTC</Badge>
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 sm:gap-3">
          <div className="rounded-2xl border border-border bg-card p-4">
            <div className="flex items-center gap-1.5 text-muted-foreground mb-1">
              {lastRun?.status === 'success' ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
                : lastRun?.status === 'error' ? <AlertTriangle className="h-3.5 w-3.5 text-red-600" />
                : <Clock className="h-3.5 w-3.5" />}
              <span className="text-xs">Last Run</span>
            </div>
            {loadingRuns ? <div className="h-6 w-20 bg-muted animate-pulse rounded" /> : lastRun ? (
              <>
                <div className="mb-1">{statusBadge(lastRun.status)}</div>
                <p className="text-[11px] text-muted-foreground">
                  {formatDistanceToNow(new Date(lastRun.started_at), { addSuffix: true })} · {lastRun.trigger_source}
                </p>
              </>
            ) : <p className="text-sm text-muted-foreground">Never run</p>}
          </div>
          <KPICard title="Records Updated (last run)" value={(lastRun?.rows_updated ?? 0).toLocaleString()} icon={RefreshCw}
            loading={loadingRuns} subtitle={`of ${(lastRun?.rows_scanned ?? 0).toLocaleString()} scanned`} />
          <KPICard title="Recognised (last run)" value={formatUGX(Number(lastRun?.recognized_delta || 0))} icon={TrendingUp}
            loading={loadingRuns} color="bg-emerald-500/10 text-emerald-600" subtitle="New revenue earned" />
          <KPICard title="Recognition Rate" value={`${rate.toFixed(1)}%`} icon={Gauge}
            loading={loadingRecon} color="bg-primary/10 text-primary" subtitle="Recognised ÷ billed" />
        </div>
        {lastRun?.status === 'error' && lastRun.error_message && (
          <div className="mt-2 rounded-xl border border-red-500/30 bg-red-500/5 p-3 text-xs text-red-700">
            <strong>Last error:</strong> {lastRun.error_message}
          </div>
        )}
      </div>

      {/* Recognised vs Deferred reconciliation */}
      <div>
        <h4 className="text-sm font-semibold mb-3">Recognised vs Deferred Reconciliation</h4>
        <div className="grid grid-cols-3 gap-2 sm:gap-3 mb-3">
          <KPICard title="Total Billed" value={formatUGX(recon?.total || 0)} icon={Gauge} loading={loadingRecon}
            subtitle={`${(recon?.count || 0).toLocaleString()} fee records`} />
          <KPICard title="Recognised" value={formatUGX(recon?.recognized || 0)} icon={CheckCircle2} loading={loadingRecon}
            color="bg-emerald-500/10 text-emerald-600" subtitle={`${recon?.fullyCount ?? 0} full · ${recon?.partialCount ?? 0} partial`} />
          <KPICard title="Deferred" value={formatUGX(recon?.deferred || 0)} icon={Clock} loading={loadingRecon}
            color="bg-amber-500/10 text-amber-600" subtitle={`${recon?.deferredCount ?? 0} awaiting`} />
        </div>

        {/* Balance check */}
        <div className="rounded-xl border border-border bg-muted/30 p-3 flex items-center justify-between text-xs mb-3">
          <span className="text-muted-foreground">Recognised + Deferred</span>
          <span className="font-semibold">
            {formatUGX((recon?.recognized || 0) + (recon?.deferred || 0))}
            {recon && Math.abs((recon.recognized + recon.deferred) - recon.total) < 1
              ? <CheckCircle2 className="inline h-3.5 w-3.5 text-emerald-600 ml-1.5 -mt-0.5" />
              : <AlertTriangle className="inline h-3.5 w-3.5 text-red-600 ml-1.5 -mt-0.5" />}
          </span>
        </div>

        {/* Progress bar */}
        <div className="rounded-2xl border border-border bg-card p-4">
          <div className="flex justify-between text-xs mb-2">
            <span className="text-emerald-600 font-medium">Recognised {rate.toFixed(1)}%</span>
            <span className="text-amber-600 font-medium">Deferred {(100 - rate).toFixed(1)}%</span>
          </div>
          <div className="h-3 rounded-full bg-amber-500/20 overflow-hidden">
            <div className="h-full bg-emerald-500 transition-all" style={{ width: `${Math.min(100, rate)}%` }} />
          </div>

          {/* Per fee-type breakdown */}
          <div className="mt-4 space-y-3">
            {Object.entries(recon?.byType || {}).sort((a, b) => b[1].total - a[1].total).map(([type, v]) => {
              const pct = v.total > 0 ? (v.recognized / v.total) * 100 : 0;
              return (
                <div key={type}>
                  <div className="flex justify-between text-xs mb-1">
                    <span className="font-medium">{FEE_LABELS[type] || type}</span>
                    <span className="text-muted-foreground">
                      {formatUGX(v.recognized)} / {formatUGX(v.total)} · {pct.toFixed(0)}%
                    </span>
                  </div>
                  <div className="h-2 rounded-full bg-amber-500/20 overflow-hidden">
                    <div className="h-full bg-emerald-500" style={{ width: `${Math.min(100, pct)}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Server vs client fallback reconciliation (row-cap guard) */}
      <FeeRevenueReconciliationCheck />

      {/* Recent runs */}
      <div>
        <h4 className="text-sm font-semibold mb-3">Recent Runs</h4>
        <div className="rounded-2xl border border-border bg-card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-muted/40 text-muted-foreground">
                <tr>
                  <th className="text-left font-medium px-3 py-2">Started</th>
                  <th className="text-left font-medium px-3 py-2">Status</th>
                  <th className="text-left font-medium px-3 py-2">Source</th>
                  <th className="text-right font-medium px-3 py-2">Updated</th>
                  <th className="text-right font-medium px-3 py-2">Recognised Δ</th>
                </tr>
              </thead>
              <tbody>
                {loadingRuns ? (
                  <tr><td colSpan={5} className="text-center py-6 text-muted-foreground">Loading…</td></tr>
                ) : (runs || []).length === 0 ? (
                  <tr><td colSpan={5} className="text-center py-6 text-muted-foreground">No runs yet</td></tr>
                ) : (runs || []).map((r) => (
                  <tr key={r.id} className="border-t border-border">
                    <td className="px-3 py-2">{format(new Date(r.started_at), 'dd MMM, HH:mm')}</td>
                    <td className="px-3 py-2">{statusBadge(r.status)}</td>
                    <td className="px-3 py-2 capitalize">{r.trigger_source}</td>
                    <td className="px-3 py-2 text-right">{r.rows_updated.toLocaleString()}</td>
                    <td className="px-3 py-2 text-right text-emerald-600 font-medium">{formatUGX(Number(r.recognized_delta || 0))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}