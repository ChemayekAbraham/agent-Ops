import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { formatUGX } from '@/lib/rentCalculations';
import {
  Users, Banknote, UserPlus, ShieldCheck, PackageCheck, Loader2,
  TrendingUp, TrendingDown, Target, RefreshCw, CalendarDays,
} from 'lucide-react';
import { cn } from '@/lib/utils';

interface MonthlyRaw {
  month: string;
  month_start: string;
  is_current_month: boolean;
  total_agents: number;
  adv_agents_current: number;
  adv_agents_current_prev: number;
  adv_agents_month: number;
  adv_agents_prev: number;
  new_adv_agents_month: number;
  new_adv_agents_prev: number;
  volume_month: number;
  volume_prev: number;
  principal_total: number;
  outstanding_total: number;
  principal_total_prev: number;
  outstanding_total_prev: number;
  deliveries_month: number;
  deliveries_prev: number;
}

interface Pillar {
  key: string;
  label: string;
  weight: number;
  icon: React.ComponentType<{ className?: string }>;
  color: string;
  ring: string;
  /** headline value shown big */
  display: string;
  /** 0..100 attainment toward goal */
  attainment: number;
  /** small helper line */
  detail: string;
  /** month-over-month delta % (optional) */
  changePct?: number;
}

const clampPct = (n: number) => Math.max(0, Math.min(100, n));
const growth = (curr: number, prev: number) => (prev <= 0 ? (curr > 0 ? 100 : 0) : ((curr - prev) / prev) * 100);

/** First day (YYYY-MM-01) of the month `offset` months before now. */
function monthStart(offset: number): string {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - offset);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}-01`;
}

function monthLabel(iso: string): string {
  const [y, m] = iso.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

export function AgentMonthlyKpis() {
  const thisMonth = monthStart(0);
  const lastMonth = monthStart(1);
  const [selected, setSelected] = useState<string>(thisMonth);

  // Months of the current calendar year up to (and including) the current month.
  const monthOptions = useMemo(() => {
    const now = new Date();
    const opts: string[] = [];
    for (let m = now.getMonth(); m >= 0; m--) {
      const iso = `${now.getFullYear()}-${String(m + 1).padStart(2, '0')}-01`;
      opts.push(iso);
    }
    return opts;
  }, []);

  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ['agent-ops-monthly-kpis', selected],
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
    queryFn: async () => {
      const { data, error } = await (supabase.rpc as any)('get_agent_ops_monthly_kpis', { _month: selected });
      if (error) throw error;
      return data as MonthlyRaw;
    },
  });

  const d = data;
  const trackingShare = d && d.total_agents > 0 ? (d.adv_agents_current / d.total_agents) * 100 : 0;
  const trackingSharePrev = d && d.total_agents > 0 ? (d.adv_agents_current_prev / d.total_agents) * 100 : 0;
  const repayRate = d && d.principal_total > 0
    ? ((d.principal_total - d.outstanding_total) / d.principal_total) * 100
    : 0;
  const repayRatePrev = d && d.principal_total_prev > 0
    ? ((d.principal_total_prev - d.outstanding_total_prev) / d.principal_total_prev) * 100
    : 0;

  const pillars: Pillar[] = d
    ? [
        {
          key: 'tracking',
          label: 'Active Agents Tracking Advances',
          weight: 30,
          icon: Users,
          color: 'text-primary',
          ring: 'stroke-primary',
          display: `${trackingShare.toFixed(1)}%`,
          attainment: clampPct((trackingShare / 30) * 100),
          detail: `${d.adv_agents_current.toLocaleString()} of ${d.total_agents.toLocaleString()} agents · goal 30%`,
          changePct: growth(trackingShare, trackingSharePrev),
        },
        {
          key: 'volume',
          label: 'Monthly Advance Volume',
          weight: 25,
          icon: Banknote,
          color: 'text-emerald-600 dark:text-emerald-400',
          ring: 'stroke-emerald-500',
          display: formatUGX(d.volume_month),
          attainment: clampPct(growth(d.volume_month, d.volume_prev) >= 0 ? 100 : (d.volume_month / Math.max(d.volume_prev, 1)) * 100),
          detail: `vs ${formatUGX(d.volume_prev)} last month · goal 25%`,
          changePct: growth(d.volume_month, d.volume_prev),
        },
        {
          key: 'new-agents',
          label: 'New Active Advance Agents',
          weight: 20,
          icon: UserPlus,
          color: 'text-sky-600 dark:text-sky-400',
          ring: 'stroke-sky-500',
          display: d.new_adv_agents_month.toLocaleString(),
          attainment: clampPct(growth(d.new_adv_agents_month, d.new_adv_agents_prev) >= 0 ? 100 : (d.new_adv_agents_month / Math.max(d.new_adv_agents_prev, 1)) * 100),
          detail: `vs ${d.new_adv_agents_prev.toLocaleString()} last month · goal 20%`,
          changePct: growth(d.new_adv_agents_month, d.new_adv_agents_prev),
        },
        {
          key: 'repayment',
          label: 'Repayment Performance',
          weight: 15,
          icon: ShieldCheck,
          color: 'text-violet-600 dark:text-violet-400',
          ring: 'stroke-violet-500',
          display: `${repayRate.toFixed(1)}%`,
          attainment: clampPct(repayRate),
          detail: `${formatUGX(Math.max(d.principal_total - d.outstanding_total, 0))} repaid of ${formatUGX(d.principal_total)} · goal 15%`,
          changePct: growth(repayRate, repayRatePrev),
        },
        {
          key: 'delivery',
          label: 'Platform Delivery & Execution',
          weight: 10,
          icon: PackageCheck,
          color: 'text-amber-600 dark:text-amber-400',
          ring: 'stroke-amber-500',
          display: d.deliveries_month.toLocaleString(),
          attainment: clampPct(growth(d.deliveries_month, d.deliveries_prev) >= 0 && d.deliveries_month > 0 ? 100 : (d.deliveries_month / Math.max(d.deliveries_prev, 1)) * 100),
          detail: `deliveries confirmed this month · goal 10%`,
          changePct: growth(d.deliveries_month, d.deliveries_prev),
        },
      ]
    : [];

  const overall = pillars.reduce((s, p) => s + (p.weight / 100) * p.attainment, 0);

  const isThisMonth = selected === thisMonth;
  const isLastMonth = selected === lastMonth;

  return (
    <Card className="rounded-2xl border-border/50 p-3 sm:p-4">
      <div className="flex items-start justify-between gap-2 mb-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-foreground flex items-center gap-1.5">
            <Target className="h-4 w-4 text-primary" />
            Monthly KPIs — Advance Program
          </h3>
          <p className="text-[11px] text-muted-foreground">
            Live weighted scorecard · {d?.month ?? '—'} vs last month
          </p>
        </div>
        <div className="text-right shrink-0">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Overall</p>
          <p className={cn('text-xl font-bold tabular-nums leading-none',
            overall >= 75 ? 'text-emerald-600 dark:text-emerald-400' : overall >= 50 ? 'text-amber-600 dark:text-amber-400' : 'text-destructive')}>
            {isLoading ? <Loader2 className="h-5 w-5 animate-spin inline" /> : `${overall.toFixed(0)}%`}
          </p>
        </div>
      </div>

      {/* Month filter controls */}
      <div className="flex flex-wrap items-center gap-1.5 mb-3">
        <Button
          size="sm"
          variant={isThisMonth ? 'default' : 'outline'}
          className="h-7 text-[11px] px-2.5"
          onClick={() => setSelected(thisMonth)}
        >
          This Month
        </Button>
        <Button
          size="sm"
          variant={isLastMonth ? 'default' : 'outline'}
          className="h-7 text-[11px] px-2.5"
          onClick={() => setSelected(lastMonth)}
        >
          Last Month
        </Button>
        <Select value={selected} onValueChange={setSelected}>
          <SelectTrigger className="h-7 text-[11px] w-[150px]">
            <CalendarDays className="h-3 w-3 mr-1 shrink-0" />
            <SelectValue placeholder="Pick a month" />
          </SelectTrigger>
          <SelectContent>
            {monthOptions.map((iso) => (
              <SelectItem key={iso} value={iso} className="text-xs">
                {monthLabel(iso)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 text-[11px] px-2 ml-auto"
          onClick={() => refetch()}
          disabled={isFetching}
        >
          <RefreshCw className={cn('h-3 w-3 mr-1', isFetching && 'animate-spin')} />
          Refresh
        </Button>
      </div>

      {isLoading ? (
        <div className="h-40 flex items-center justify-center">
          <Loader2 className="h-5 w-5 text-muted-foreground animate-spin" />
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2.5">
          {pillars.map((p) => {
            const Icon = p.icon;
            const up = (p.changePct ?? 0) >= 0;
            return (
              <div key={p.key} className="rounded-xl border border-border/50 bg-card/60 p-3 flex flex-col gap-2">
                <div className="flex items-start justify-between gap-2">
                  <span className={cn('h-8 w-8 rounded-lg bg-muted flex items-center justify-center shrink-0')}>
                    <Icon className={cn('h-4 w-4', p.color)} />
                  </span>
                  <Badge variant="outline" className="text-[10px] gap-1 shrink-0">
                    <Target className="h-2.5 w-2.5" /> {p.weight}% weight
                  </Badge>
                </div>
                <div className="min-w-0">
                  <p className="text-[11px] font-medium text-muted-foreground leading-tight line-clamp-1">{p.label}</p>
                  <div className="flex items-baseline gap-2 flex-wrap">
                    <span className="text-lg font-bold tabular-nums text-foreground leading-tight">{p.display}</span>
                    {p.changePct !== undefined && (
                      <span className={cn('inline-flex items-center gap-0.5 text-[10px] font-semibold',
                        up ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400')}>
                        {up ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
                        {Math.abs(p.changePct).toFixed(0)}%
                      </span>
                    )}
                  </div>
                  <p className="text-[10px] text-muted-foreground/80 leading-tight mt-0.5 line-clamp-1">{p.detail}</p>
                </div>
                <div>
                  <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                    <div
                      className={cn('h-full rounded-full transition-all',
                        p.attainment >= 75 ? 'bg-emerald-500' : p.attainment >= 50 ? 'bg-amber-500' : 'bg-primary')}
                      style={{ width: `${p.attainment}%` }}
                    />
                  </div>
                  <p className="text-[9px] text-muted-foreground mt-1 text-right tabular-nums">
                    {p.attainment.toFixed(0)}% to goal
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
