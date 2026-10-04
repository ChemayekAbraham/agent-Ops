import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Shield, TrendingUp, AlertTriangle, Activity, PiggyBank, BarChart3 } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { cn } from '@/lib/utils';
import { Skeleton } from '@/components/ui/skeleton';
import { BufferTrendChart } from './BufferTrendChart';
import { ReserveAllocationPanel } from './ReserveAllocationPanel';

interface BufferMetrics {
  totalCashIn: number;
  totalCashOut: number;
  netBuffer: number;
  totalRentFacilitated: number;
  totalRepaid: number;
  totalOutstanding: number;
  defaultCount: number;
  totalFundedRequests: number;
  coverageRatio: number;
  capitalUtilization: number;
  defaultRate: number;
  repaymentRate: number;
  liquidityRatio: number;
}

const SAFETY_THRESHOLDS = {
  coverageRatio: { safe: 1.2, warning: 1.05, label: 'Coverage Ratio' },
  capitalUtilization: { safe: 0.85, warning: 0.95, label: 'Capital Utilization' },
  defaultRate: { safe: 0.05, warning: 0.10, label: 'Default Rate' },
  repaymentRate: { safe: 0.80, warning: 0.60, label: 'Repayment Rate' },
  liquidityRatio: { safe: 0.30, warning: 0.15, label: 'Liquidity Buffer' },
};

function getHealthColor(value: number, threshold: typeof SAFETY_THRESHOLDS.coverageRatio, inverse = false) {
  if (inverse) {
    if (value <= threshold.safe) return 'text-success';
    if (value <= threshold.warning) return 'text-warning';
    return 'text-destructive';
  }
  if (value >= threshold.safe) return 'text-success';
  if (value >= threshold.warning) return 'text-warning';
  return 'text-destructive';
}

function getHealthBadge(value: number, threshold: typeof SAFETY_THRESHOLDS.coverageRatio, inverse = false) {
  if (inverse) {
    if (value <= threshold.safe) return { label: 'Healthy', variant: 'bg-success/10 text-success border-success/30' };
    if (value <= threshold.warning) return { label: 'Caution', variant: 'bg-warning/10 text-warning border-warning/30' };
    return { label: 'Critical', variant: 'bg-destructive/10 text-destructive border-destructive/30' };
  }
  if (value >= threshold.safe) return { label: 'Healthy', variant: 'bg-success/10 text-success border-success/30' };
  if (value >= threshold.warning) return { label: 'Caution', variant: 'bg-warning/10 text-warning border-warning/30' };
  return { label: 'Critical', variant: 'bg-destructive/10 text-destructive border-destructive/30' };
}

export function BufferAccountPanel() {
  const [metrics, setMetrics] = useState<BufferMetrics | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchMetrics();
  }, []);

  const fetchMetrics = async () => {
    setLoading(true);

    // Use server-side RPC instead of fetching all rows
    const { data, error } = await supabase.rpc('get_buffer_metrics');

    if (error || !data) {
      setLoading(false);
      return;
    }

    const d = data as any;
    const totalCashIn = Number(d.totalCashIn) || 0;
    const totalCashOut = Number(d.totalCashOut) || 0;
    const totalRentFacilitated = Number(d.totalRentFacilitated) || 0;
    const totalRepaid = Number(d.totalRepaid) || 0;
    const totalOutstanding = Number(d.totalOutstanding) || 0;
    const defaultCount = Number(d.defaultCount) || 0;
    const totalFundedRequests = Number(d.totalFundedRequests) || 0;

    const netBuffer = totalCashIn - totalCashOut;
    const coverageRatio = totalCashOut > 0 ? totalCashIn / totalCashOut : totalCashIn > 0 ? 999 : 1;
    const capitalUtilization = totalCashIn > 0 ? totalRentFacilitated / totalCashIn : 0;
    const defaultRate = totalFundedRequests > 0 ? defaultCount / totalFundedRequests : 0;
    const repaymentRate = totalRentFacilitated > 0 ? totalRepaid / totalRentFacilitated : 0;
    const liquidityRatio = totalOutstanding > 0 ? netBuffer / totalOutstanding : netBuffer > 0 ? 999 : 0;

    setMetrics({
      totalCashIn, totalCashOut, netBuffer, totalRentFacilitated, totalRepaid,
      totalOutstanding, defaultCount, totalFundedRequests,
      coverageRatio, capitalUtilization, defaultRate, repaymentRate, liquidityRatio,
    });
    setLoading(false);
  };

  if (loading) {
    return (
      <div className="space-y-3">
        {[1, 2, 3].map(i => <Skeleton key={i} className="h-32 w-full rounded-xl" />)}
      </div>
    );
  }

  if (!metrics) return null;

  const overallSolvent = metrics.netBuffer >= 0;
  const hasCritical =
    metrics.coverageRatio < SAFETY_THRESHOLDS.coverageRatio.warning ||
    metrics.defaultRate > SAFETY_THRESHOLDS.defaultRate.warning ||
    metrics.liquidityRatio < SAFETY_THRESHOLDS.liquidityRatio.warning;

  const indicators = [
    {
      label: 'Coverage Ratio', subtitle: 'Cash In ÷ Cash Out',
      value: metrics.coverageRatio === 999 ? '∞' : `${metrics.coverageRatio.toFixed(2)}x`,
      color: getHealthColor(metrics.coverageRatio, SAFETY_THRESHOLDS.coverageRatio),
      badge: getHealthBadge(metrics.coverageRatio, SAFETY_THRESHOLDS.coverageRatio),
      icon: Shield, progress: Math.min(metrics.coverageRatio / 2 * 100, 100),
    },
    {
      label: 'Capital Utilization', subtitle: 'Facilitated ÷ Cash In',
      value: `${(metrics.capitalUtilization * 100).toFixed(1)}%`,
      color: getHealthColor(metrics.capitalUtilization, SAFETY_THRESHOLDS.capitalUtilization, true),
      badge: getHealthBadge(metrics.capitalUtilization, SAFETY_THRESHOLDS.capitalUtilization, true),
      icon: BarChart3, progress: metrics.capitalUtilization * 100,
    },
    {
      label: 'Default Rate', subtitle: `${metrics.defaultCount} of ${metrics.totalFundedRequests} funded`,
      value: `${(metrics.defaultRate * 100).toFixed(1)}%`,
      color: getHealthColor(metrics.defaultRate, SAFETY_THRESHOLDS.defaultRate, true),
      badge: getHealthBadge(metrics.defaultRate, SAFETY_THRESHOLDS.defaultRate, true),
      icon: AlertTriangle, progress: Math.min(metrics.defaultRate * 100 * 5, 100),
    },
    {
      label: 'Repayment Rate', subtitle: 'Repaid ÷ Facilitated',
      value: `${(metrics.repaymentRate * 100).toFixed(1)}%`,
      color: getHealthColor(metrics.repaymentRate, SAFETY_THRESHOLDS.repaymentRate),
      badge: getHealthBadge(metrics.repaymentRate, SAFETY_THRESHOLDS.repaymentRate),
      icon: TrendingUp, progress: metrics.repaymentRate * 100,
    },
    {
      label: 'Liquidity Buffer', subtitle: 'Buffer ÷ Outstanding',
      value: metrics.liquidityRatio === 999 ? '∞' : `${(metrics.liquidityRatio * 100).toFixed(0)}%`,
      color: getHealthColor(metrics.liquidityRatio, SAFETY_THRESHOLDS.liquidityRatio),
      badge: getHealthBadge(metrics.liquidityRatio, SAFETY_THRESHOLDS.liquidityRatio),
      icon: PiggyBank, progress: Math.min(metrics.liquidityRatio * 100, 100),
    },
  ];

  return (
    <div className="space-y-3">
      {/* Solvency Alert Banner */}
      {hasCritical && (
        <Card className="border-2 border-destructive/50 bg-destructive/5 animate-pulse">
          <CardContent className="p-4 flex items-center gap-3">
            <AlertTriangle className="h-6 w-6 text-destructive shrink-0" />
            <div>
              <p className="text-sm font-bold text-destructive">⚠️ Solvency Alert</p>
              <p className="text-xs text-destructive/80">One or more safety thresholds are breached. Investigate immediately.</p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Net Buffer Hero */}
      <Card className="border-2 border-amber-500/40 shadow-lg overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-br from-amber-500/10 via-amber-500/5 to-transparent pointer-events-none" />
        <CardContent className="relative p-5 space-y-4">
          <div className="flex items-center gap-3">
            <div className="p-3 rounded-2xl bg-amber-500 text-white shadow-lg">
              <Shield className="h-7 w-7" />
            </div>
            <div className="flex-1">
              <h3 className="text-lg font-black">Platform Safety Net</h3>
              <p className="text-xs text-muted-foreground">Solvency is more important than growth</p>
            </div>
            <Badge variant="outline" className={cn(
              "text-xs font-bold px-2 py-0.5",
              overallSolvent
                ? 'bg-success/10 text-success border-success/30'
                : 'bg-destructive/10 text-destructive border-destructive/30'
            )}>
              {overallSolvent ? '✅ Solvent' : '🚨 Deficit'}
            </Badge>
          </div>

          <div className="grid grid-cols-3 gap-2">
            <div className="p-3 rounded-xl bg-success/10 border border-success/20 text-center">
              <p className="text-[9px] text-muted-foreground uppercase tracking-wide font-medium">Cash In</p>
              <p className="text-sm font-black text-success mt-0.5">{formatUGX(metrics.totalCashIn)}</p>
            </div>
            <div className="p-3 rounded-xl bg-destructive/10 border border-destructive/20 text-center">
              <p className="text-[9px] text-muted-foreground uppercase tracking-wide font-medium">Cash Out</p>
              <p className="text-sm font-black text-destructive mt-0.5">{formatUGX(metrics.totalCashOut)}</p>
            </div>
            <div className={cn("p-3 rounded-xl border text-center", overallSolvent ? 'bg-success/5 border-success/20' : 'bg-destructive/5 border-destructive/20')}>
              <p className="text-[9px] text-muted-foreground uppercase tracking-wide font-medium">Net Buffer</p>
              <p className={cn("text-sm font-black mt-0.5", overallSolvent ? 'text-success' : 'text-destructive')}>{formatUGX(metrics.netBuffer)}</p>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-2">
            <div className="p-2.5 rounded-xl bg-muted/50 border border-border/40 text-center">
              <p className="text-[9px] text-muted-foreground uppercase tracking-wide font-medium">Facilitated</p>
              <p className="text-xs font-black mt-0.5">{formatUGX(metrics.totalRentFacilitated)}</p>
            </div>
            <div className="p-2.5 rounded-xl bg-muted/50 border border-border/40 text-center">
              <p className="text-[9px] text-muted-foreground uppercase tracking-wide font-medium">Repaid</p>
              <p className="text-xs font-black text-success mt-0.5">{formatUGX(metrics.totalRepaid)}</p>
            </div>
            <div className="p-2.5 rounded-xl bg-muted/50 border border-border/40 text-center">
              <p className="text-[9px] text-muted-foreground uppercase tracking-wide font-medium">Outstanding</p>
              <p className="text-xs font-black text-warning mt-0.5">{formatUGX(metrics.totalOutstanding)}</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Safety Indicators */}
      <h3 className="text-sm font-bold flex items-center gap-2 px-1">
        <Activity className="h-4 w-4 text-primary" />
        Safety Indicators
      </h3>

      {indicators.map((ind) => {
        const Icon = ind.icon;
        return (
          <Card key={ind.label} className="border border-border/60">
            <CardContent className="p-3.5 space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 min-w-0">
                  <Icon className={cn("h-4 w-4 shrink-0", ind.color)} />
                  <div className="min-w-0">
                    <p className="text-sm font-bold truncate">{ind.label}</p>
                    <p className="text-[10px] text-muted-foreground">{ind.subtitle}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <p className={cn("text-lg font-black", ind.color)}>{ind.value}</p>
                  <Badge variant="outline" className={cn("text-[9px] px-1.5 py-0", ind.badge.variant)}>
                    {ind.badge.label}
                  </Badge>
                </div>
              </div>
              <Progress value={ind.progress} className="h-1.5" />
            </CardContent>
          </Card>
        );
      })}

      <h3 className="text-sm font-bold flex items-center gap-2 px-1 mt-4">
        <TrendingUp className="h-4 w-4 text-primary" />
        Trends & Forecast
      </h3>
      <BufferTrendChart />

      <h3 className="text-sm font-bold flex items-center gap-2 px-1 mt-4">
        <Shield className="h-4 w-4 text-amber-500" />
        Reserve Allocation
      </h3>
      <ReserveAllocationPanel />
    </div>
  );
}
