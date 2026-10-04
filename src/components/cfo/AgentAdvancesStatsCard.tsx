import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { HandCoins, TrendingUp, AlertTriangle, Users, Percent, Loader2 } from 'lucide-react';
import { formatUGX } from '@/lib/agentAdvanceCalculations';
import { format, subDays, startOfDay } from 'date-fns';
import {
  ResponsiveContainer,
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
  Legend,
} from 'recharts';

/**
 * Full-width CFO overview card summarising every agent advance in one glance:
 * headline stats + a 30-day chart of daily disbursements vs recoveries.
 * Data comes from `agent_advances` (portfolio state) and `agent_advance_ledger`
 * (daily deductions).
 */
function useAgentAdvancesPortfolioData() {
  const { data: advances = [], isLoading: loadingAdvances } = useQuery({
    queryKey: ['cfo-overview-advances'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('agent_advances')
        .select('id, agent_id, principal, outstanding_balance, arrears_balance, access_fee, registration_fee, status, issued_at')
        .order('issued_at', { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
    refetchOnWindowFocus: false,
  });

  const since = useMemo(() => startOfDay(subDays(new Date(), 29)), []);

  const { data: ledger = [], isLoading: loadingLedger } = useQuery({
    queryKey: ['cfo-overview-advances-ledger', since.toISOString()],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('agent_advance_ledger')
        .select('date, amount_deducted, interest_accrued')
        .gte('date', format(since, 'yyyy-MM-dd'))
        .order('date', { ascending: true });
      if (error) throw error;
      return data ?? [];
    },
    refetchOnWindowFocus: false,
  });

  const stats = useMemo(() => {
    let issued = 0, outstanding = 0, arrears = 0, accessFees = 0, regFees = 0;
    let active = 0, overdue = 0, completed = 0;
    const agents = new Set<string>();
    for (const a of advances as any[]) {
      issued += Number(a.principal || 0);
      outstanding += Number(a.outstanding_balance || 0);
      arrears += Number(a.arrears_balance || 0);
      accessFees += Number(a.access_fee || 0);
      regFees += Number(a.registration_fee || 0);
      if (a.status === 'active') active += 1;
      else if (a.status === 'overdue') overdue += 1;
      else if (a.status === 'completed') completed += 1;
      if (a.status !== 'completed') agents.add(a.agent_id);
    }
    const recovered = Math.max(0, issued - outstanding);
    const recoveryRate = issued > 0 ? (recovered / issued) * 100 : 0;
    return {
      issued, outstanding, arrears, recovered, recoveryRate,
      accessFees, regFees, feeRevenue: accessFees + regFees,
      active, overdue, completed, agentsOwing: agents.size,
      totalAdvances: advances.length,
    };
  }, [advances]);

  const chartData = useMemo(() => {
    // Build 30-day dense series so gaps still render.
    const days: Record<string, { day: string; disbursed: number; recovered: number; interest: number }> = {};
    for (let i = 29; i >= 0; i--) {
      const d = format(subDays(new Date(), i), 'yyyy-MM-dd');
      days[d] = { day: format(subDays(new Date(), i), 'MMM d'), disbursed: 0, recovered: 0, interest: 0 };
    }
    for (const a of advances as any[]) {
      const d = (a.issued_at || '').slice(0, 10);
      if (days[d]) days[d].disbursed += Number(a.principal || 0);
    }
    for (const l of ledger as any[]) {
      const d = (l.date || '').slice(0, 10);
      if (days[d]) {
        days[d].recovered += Number(l.amount_deducted || 0);
        days[d].interest += Number(l.interest_accrued || 0);
      }
    }
    return Object.values(days);
  }, [advances, ledger]);

  const loading = loadingAdvances || loadingLedger;

  return { stats, chartData, loading };
}

/**
 * The 30-day "Disbursed vs Recovered" chart exactly as rendered inside
 * `AgentAdvancesStatsCard`, reusable standalone (same queries, same data).
 */
export function AgentAdvancesTrendChart({ hideHeader = false }: { hideHeader?: boolean }) {
  const { chartData, loading } = useAgentAdvancesPortfolioData();

  const chart = (
    <div className="h-64 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart
          data={chartData}
          margin={{ top: 8, right: 12, left: 0, bottom: 0 }}
          barCategoryGap="20%"
          barGap={2}
        >
          <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
          <XAxis dataKey="day" tick={{ fontSize: 10 }} interval={4} />
          <YAxis tick={{ fontSize: 10 }} tickFormatter={(v) => v >= 1_000_000 ? `${(v / 1_000_000).toFixed(1)}M` : v >= 1000 ? `${(v / 1000).toFixed(0)}k` : String(v)} />
          <RechartsTooltip
            formatter={(v: number, name: string) => [formatUGX(v), name]}
            contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: 8, fontSize: 12 }}
          />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          <Bar dataKey="disbursed" name="Disbursed" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} barSize={22} />
          <Bar dataKey="recovered" name="Recovered" fill="#10b981" radius={[4, 4, 0, 0]} barSize={22} />
          <Line dataKey="interest" name="Interest accrued" stroke="#f59e0b" strokeWidth={2} dot={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );

  if (hideHeader) {
    return chart;
  }

  return (
    <div className="rounded-xl border border-border bg-muted/20 p-3 sm:p-4">
      <div className="flex items-center justify-between mb-3">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Last 30 days · Disbursed vs Recovered</p>
        {loading && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
      </div>
      {chart}
    </div>
  );
}

export function AgentAdvancesStatsCard() {
  const { stats } = useAgentAdvancesPortfolioData();

  return (
    <Card className="w-full rounded-2xl shadow-sm">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2 flex-wrap">
          <div>
            <CardTitle className="flex items-center gap-2.5 text-base">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-purple-50 dark:bg-purple-950/40">
                <HandCoins className="h-4 w-4 text-purple-600" />
              </span>
              Agent Advances — Full Portfolio
            </CardTitle>
            <p className="text-xs text-muted-foreground mt-1.5">
              Every advance ever disbursed, plus the last 30 days of daily disbursements and recoveries.
            </p>
          </div>
          <div className="flex gap-1.5 flex-wrap">
            <Badge variant="outline" className="text-[10px]">{stats.active} active</Badge>
            <Badge variant="outline" className="text-[10px] border-destructive/40 text-destructive">
              {stats.overdue} overdue
            </Badge>
            <Badge variant="outline" className="text-[10px] border-emerald-500/40 text-emerald-600">
              {stats.completed} completed
            </Badge>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Stats strip */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          <StatTile icon={<HandCoins className="h-3.5 w-3.5" />} label="Total Issued" value={formatUGX(stats.issued)} tone="text-primary" />
          <StatTile icon={<TrendingUp className="h-3.5 w-3.5" />} label="Recovered" value={formatUGX(stats.recovered)} tone="text-emerald-600" hint={`${stats.recoveryRate.toFixed(1)}% of issued`} />
          <StatTile icon={<HandCoins className="h-3.5 w-3.5" />} label="Outstanding" value={formatUGX(stats.outstanding)} tone="text-amber-600" />
          <StatTile icon={<AlertTriangle className="h-3.5 w-3.5" />} label="Arrears" value={formatUGX(stats.arrears)} tone="text-destructive" hint={`${stats.overdue} overdue`} />
          <StatTile icon={<Percent className="h-3.5 w-3.5" />} label="Fee Revenue" value={formatUGX(stats.feeRevenue)} tone="text-emerald-700" hint="access + registration" />
          <StatTile icon={<Users className="h-3.5 w-3.5" />} label="Agents Owing" value={String(stats.agentsOwing)} tone="text-foreground" hint={`${stats.totalAdvances} advances all-time`} />
        </div>

        {/* Chart */}
        <AgentAdvancesTrendChart />
      </CardContent>
    </Card>
  );
}

function StatTile({ icon, label, value, tone, hint }: { icon: React.ReactNode; label: string; value: string; tone: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-3">
      <div className="flex items-center gap-1.5 text-muted-foreground text-[10px] uppercase font-semibold tracking-wider">
        <span className="shrink-0">{icon}</span>
        <span className="truncate">{label}</span>
      </div>
      <p className={`text-base font-bold font-mono tabular-nums mt-1 ${tone}`}>{value}</p>
      {hint && <p className="text-[10px] text-muted-foreground mt-0.5">{hint}</p>}
    </div>
  );
}
