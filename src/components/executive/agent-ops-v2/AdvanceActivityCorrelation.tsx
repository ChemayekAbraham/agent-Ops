import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Loader2, TrendingUp, Activity } from 'lucide-react';
import { formatUGX } from '@/lib/agentAdvanceCalculations';
import {
  ResponsiveContainer, ScatterChart, Scatter, XAxis, YAxis, ZAxis, CartesianGrid,
  Tooltip, ComposedChart, Line, Bar, Legend,
} from 'recharts';

type Row = {
  agent_id: string;
  full_name: string;
  advance_count: number;
  advance_principal: number;
  approved_count: number;
  collections_count: number;
  collections_amount: number;
  tenants_count: number;
  listings_count: number;
  subagents_count: number;
  visits_count: number;
  activity_score: number;
};

type TrendRow = {
  month_start: string;
  advance_requests: number;
  advance_principal: number;
  collections_count: number;
  collections_amount: number;
  active_agents: number;
};

const WINDOWS = [30, 60, 90, 180] as const;

function pearson(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 3) return 0;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx, b = ys[i] - my;
    num += a * b; dx += a * a; dy += b * b;
  }
  const den = Math.sqrt(dx * dy);
  return den === 0 ? 0 : num / den;
}

function strengthLabel(r: number) {
  const a = Math.abs(r);
  if (a >= 0.7) return 'Strong';
  if (a >= 0.4) return 'Moderate';
  if (a >= 0.2) return 'Weak';
  return 'Negligible';
}

export function AdvanceActivityCorrelation() {
  const [days, setDays] = useState<number>(90);

  const { data: rows, isLoading } = useQuery({
    queryKey: ['advance-activity-correlation', days],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_agent_advance_activity_correlation', { p_days: days });
      if (error) throw error;
      return (data || []) as Row[];
    },
    staleTime: 5 * 60 * 1000,
  });

  const { data: trend } = useQuery({
    queryKey: ['advance-activity-trend'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_advance_activity_monthly_trend', { p_months: 12 });
      if (error) throw error;
      return (data || []) as TrendRow[];
    },
    staleTime: 10 * 60 * 1000,
  });

  const points = useMemo(() => {
    const list = (rows || []).filter(r => r.activity_score > 0 || r.advance_count > 0);
    return list.map(r => ({
      ...r,
      x: Number(r.activity_score),
      y: Number(r.advance_principal),
      z: Math.max(1, r.advance_count),
    }));
  }, [rows]);

  const stats = useMemo(() => {
    const withAdv = points.filter(p => p.advance_count > 0);
    const rAmount = pearson(points.map(p => p.x), points.map(p => p.y));
    const rCount = pearson(points.map(p => p.x), points.map(p => p.advance_count));
    const avgActivityWith = withAdv.length ? withAdv.reduce((s, p) => s + p.x, 0) / withAdv.length : 0;
    const noAdv = points.filter(p => p.advance_count === 0);
    const avgActivityWithout = noAdv.length ? noAdv.reduce((s, p) => s + p.x, 0) / noAdv.length : 0;
    return { rAmount, rCount, withAdv: withAdv.length, total: points.length, avgActivityWith, avgActivityWithout };
  }, [points]);

  const trendData = useMemo(() => (trend || []).map(t => ({
    month: new Date(t.month_start).toLocaleDateString('en-GB', { month: 'short', year: '2-digit' }),
    requests: t.advance_requests,
    principal: Number(t.advance_principal),
    collections: t.collections_count,
    activeAgents: t.active_agents,
  })), [trend]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {WINDOWS.map(w => (
          <Button key={w} size="sm" variant={days === w ? 'default' : 'outline'} onClick={() => setDays(w)}>
            Last {w}d
          </Button>
        ))}
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Card><CardContent className="p-3">
          <p className="text-[11px] text-muted-foreground">Correlation (activity ↔ advance amount)</p>
          <p className="text-xl font-bold">{stats.rAmount.toFixed(2)}</p>
          <Badge variant="secondary" className="mt-1 text-[10px]">{strengthLabel(stats.rAmount)} {stats.rAmount >= 0 ? 'positive' : 'negative'}</Badge>
        </CardContent></Card>
        <Card><CardContent className="p-3">
          <p className="text-[11px] text-muted-foreground">Correlation (activity ↔ requests)</p>
          <p className="text-xl font-bold">{stats.rCount.toFixed(2)}</p>
          <Badge variant="secondary" className="mt-1 text-[10px]">{strengthLabel(stats.rCount)}</Badge>
        </CardContent></Card>
        <Card><CardContent className="p-3">
          <p className="text-[11px] text-muted-foreground">Avg activity — requesters</p>
          <p className="text-xl font-bold">{stats.avgActivityWith.toFixed(0)}</p>
          <p className="text-[11px] text-muted-foreground">{stats.withAdv} of {stats.total} agents</p>
        </CardContent></Card>
        <Card><CardContent className="p-3">
          <p className="text-[11px] text-muted-foreground">Avg activity — non-requesters</p>
          <p className="text-xl font-bold">{stats.avgActivityWithout.toFixed(0)}</p>
        </CardContent></Card>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Activity className="h-4 w-4 text-primary" /> Advance appetite vs platform activity (per agent)
          </CardTitle>
        </CardHeader>
        <CardContent className="p-2 sm:p-4">
          {isLoading ? (
            <div className="h-72 flex items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
          ) : (
            <ResponsiveContainer width="100%" height={340}>
              <ScatterChart margin={{ top: 10, right: 12, bottom: 24, left: 4 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis
                  type="number" dataKey="x" name="Activity score" tick={{ fontSize: 11 }}
                  label={{ value: 'Activity score', position: 'insideBottom', offset: -12, fontSize: 11 }}
                />
                <YAxis
                  type="number" dataKey="y" name="Advance principal" tick={{ fontSize: 11 }}
                  tickFormatter={(v) => `${Math.round(Number(v) / 1000)}k`}
                />
                <ZAxis type="number" dataKey="z" range={[40, 320]} name="Requests" />
                <Tooltip
                  cursor={{ strokeDasharray: '3 3' }}
                  content={({ payload }) => {
                    const p = payload?.[0]?.payload as (Row & { x: number; y: number }) | undefined;
                    if (!p) return null;
                    return (
                      <div className="rounded-lg border border-border bg-popover p-2 text-xs shadow-md">
                        <p className="font-semibold">{p.full_name}</p>
                        <p>Advances: {p.advance_count} · {formatUGX(p.advance_principal)}</p>
                        <p>Activity score: {p.activity_score}</p>
                        <p className="text-muted-foreground">
                          {p.collections_count} collections · {p.tenants_count} tenants · {p.listings_count} listings · {p.subagents_count} sub-agents
                        </p>
                      </div>
                    );
                  }}
                />
                <Scatter name="Agents" data={points} fill="hsl(var(--primary))" fillOpacity={0.6} />
              </ScatterChart>
            </ResponsiveContainer>
          )}
          <p className="text-[11px] text-muted-foreground mt-2">
            Bubble size = number of advance requests. Activity score = collections + 2× tenants + 1.5× listings + 2× sub-agents + 0.5× field visits.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-primary" /> Monthly trend — advance requests vs collections
          </CardTitle>
        </CardHeader>
        <CardContent className="p-2 sm:p-4">
          <ResponsiveContainer width="100%" height={300}>
            <ComposedChart data={trendData} margin={{ top: 10, right: 12, bottom: 4, left: 4 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
              <XAxis dataKey="month" tick={{ fontSize: 11 }} />
              <YAxis yAxisId="left" tick={{ fontSize: 11 }} />
              <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 11 }} />
              <Tooltip
                formatter={(value: any, name: string) =>
                  name === 'Advance principal' ? formatUGX(Number(value)) : value
                }
              />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Bar yAxisId="left" dataKey="collections" name="Collections" fill="hsl(var(--chart-2))" radius={[4, 4, 0, 0]} />
              <Line yAxisId="right" type="monotone" dataKey="requests" name="Advance requests" stroke="hsl(var(--primary))" strokeWidth={2} dot={{ r: 3 }} />
              <Line yAxisId="right" type="monotone" dataKey="activeAgents" name="Active agents" stroke="hsl(var(--chart-4))" strokeWidth={2} strokeDasharray="4 3" dot={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>
    </div>
  );
}
