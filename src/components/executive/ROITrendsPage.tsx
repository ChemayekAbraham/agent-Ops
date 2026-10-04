import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ArrowLeft, TrendingUp, CalendarDays, Banknote, Target } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { format, subDays, addDays, parseISO, startOfDay } from 'date-fns';
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from '@/components/ui/chart';
import {
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Line,
  ComposedChart,
  ReferenceLine,
} from 'recharts';

interface DailyROI {
  date: string;
  total: number;
  count: number;
}

const chartConfig = {
  actual: { label: 'Actual Payout', color: 'hsl(var(--primary))' },
  projected: { label: 'Projected', color: 'hsl(var(--muted-foreground))' },
  average: { label: '7-Day Avg', color: 'hsl(142 76% 36%)' },
};

export default function ROITrendsPage() {
  const navigate = useNavigate();

  const { data: roiPayments, isLoading } = useQuery({
    queryKey: ['roi-trends-history'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('supporter_roi_payments')
        .select('roi_amount, paid_at, status, due_date')
        .eq('status', 'paid')
        .order('paid_at', { ascending: true })
        .limit(200);
      if (error) throw error;
      return data || [];
    },
    staleTime: 300000,
  });

  // Aggregate by day
  const dailyMap = new Map<string, { total: number; count: number }>();
  (roiPayments || []).forEach((p) => {
    const dateStr = p.paid_at
      ? format(parseISO(p.paid_at), 'yyyy-MM-dd')
      : null;
    if (!dateStr) return;
    const existing = dailyMap.get(dateStr) || { total: 0, count: 0 };
    existing.total += Number(p.roi_amount || 0);
    existing.count += 1;
    dailyMap.set(dateStr, existing);
  });

  // Build sorted daily array for last 60 days
  const today = startOfDay(new Date());
  const actualData: DailyROI[] = [];
  for (let i = 59; i >= 0; i--) {
    const d = format(subDays(today, i), 'yyyy-MM-dd');
    const entry = dailyMap.get(d);
    actualData.push({ date: d, total: entry?.total || 0, count: entry?.count || 0 });
  }

  // Calculate 7-day rolling average
  const withAvg = actualData.map((item, idx) => {
    const window = actualData.slice(Math.max(0, idx - 6), idx + 1);
    const avg = window.reduce((s, w) => s + w.total, 0) / window.length;
    return { ...item, average: Math.round(avg) };
  });

  // Projection: use last 14 days average to project next 30 days
  const last14 = actualData.slice(-14);
  const avgDaily = last14.reduce((s, d) => s + d.total, 0) / (last14.length || 1);
  const avgCount = last14.reduce((s, d) => s + d.count, 0) / (last14.length || 1);

  // Simple linear trend from last 14 days
  const trendSlope = last14.length >= 2
    ? (last14[last14.length - 1].total - last14[0].total) / (last14.length - 1)
    : 0;

  const projectionData = Array.from({ length: 30 }, (_, i) => {
    const d = format(addDays(today, i + 1), 'yyyy-MM-dd');
    const projected = Math.max(0, Math.round(avgDaily + trendSlope * (i + 1)));
    return { date: d, projected, projectedCount: Math.round(avgCount) };
  });

  // Combined chart data
  const chartData = [
    ...withAvg.map((d) => ({
      date: d.date,
      actual: d.total,
      average: d.average,
      projected: null as number | null,
      label: format(parseISO(d.date), 'dd MMM'),
    })),
    // Bridge point: last actual day also starts projection
    ...projectionData.map((d) => ({
      date: d.date,
      actual: null as number | null,
      average: null as number | null,
      projected: d.projected,
      label: format(parseISO(d.date), 'dd MMM'),
    })),
  ];

  // KPIs
  const totalPaidAll = (roiPayments || []).reduce((s, p) => s + Number(p.roi_amount || 0), 0);
  const last7Total = actualData.slice(-7).reduce((s, d) => s + d.total, 0);
  const last30Total = actualData.slice(-30).reduce((s, d) => s + d.total, 0);
  const projected30 = projectionData.reduce((s, d) => s + d.projected, 0);

  const fmt = (n: number) =>
    n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}K` : n.toLocaleString();

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-30 bg-card/95 backdrop-blur border-b border-border px-4 py-3">
        <div className="max-w-7xl mx-auto flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => navigate('/executive-hub?tab=partners-ops')} className="shrink-0">
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div className="min-w-0 flex-1">
            <h1 className="text-lg font-bold truncate">ROI Payout Trends</h1>
            <p className="text-xs text-muted-foreground">Daily distribution history & 30-day projection</p>
          </div>
          <Badge variant="secondary" className="gap-1 text-xs">
            <TrendingUp className="h-3 w-3 text-emerald-500" />
            Live Data
          </Badge>
        </div>
      </header>

      <div className="max-w-7xl mx-auto p-4 space-y-5">
        {/* KPI Strip */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <Card className="border-emerald-500/20 bg-emerald-500/5">
            <CardContent className="p-3">
              <div className="flex items-center gap-2 mb-1">
                <Banknote className="h-4 w-4 text-emerald-600" />
                <span className="text-xs text-muted-foreground">Total All-Time</span>
              </div>
              <p className="text-lg font-black text-emerald-600">UGX {fmt(totalPaidAll)}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-3">
              <div className="flex items-center gap-2 mb-1">
                <CalendarDays className="h-4 w-4 text-primary" />
                <span className="text-xs text-muted-foreground">Last 7 Days</span>
              </div>
              <p className="text-lg font-black">UGX {fmt(last7Total)}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-3">
              <div className="flex items-center gap-2 mb-1">
                <CalendarDays className="h-4 w-4 text-blue-600" />
                <span className="text-xs text-muted-foreground">Last 30 Days</span>
              </div>
              <p className="text-lg font-black text-blue-600">UGX {fmt(last30Total)}</p>
            </CardContent>
          </Card>
          <Card className="border-amber-500/20 bg-amber-500/5">
            <CardContent className="p-3">
              <div className="flex items-center gap-2 mb-1">
                <Target className="h-4 w-4 text-amber-600" />
                <span className="text-xs text-muted-foreground">Projected Next 30d</span>
              </div>
              <p className="text-lg font-black text-amber-600">UGX {fmt(projected30)}</p>
            </CardContent>
          </Card>
        </div>

        {/* Main Chart */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <TrendingUp className="h-4 w-4 text-primary" />
              Daily ROI Payouts — Last 60 Days + 30-Day Projection
            </CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="h-72 flex items-center justify-center text-sm text-muted-foreground">Loading trend data…</div>
            ) : (
              <ChartContainer config={chartConfig} className="h-72 w-full">
                <ComposedChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-border/30" />
                  <XAxis
                    dataKey="label"
                    tick={{ fontSize: 10 }}
                    interval={Math.floor(chartData.length / 8)}
                    className="fill-muted-foreground"
                  />
                  <YAxis
                    tick={{ fontSize: 10 }}
                    tickFormatter={(v) => fmt(v)}
                    className="fill-muted-foreground"
                    width={50}
                  />
                  <ChartTooltip
                    content={
                      <ChartTooltipContent
                        labelFormatter={(_, payload) => {
                          const item = payload?.[0]?.payload;
                          return item?.date ? format(parseISO(item.date), 'dd MMM yyyy') : '';
                        }}
                        formatter={(value, name) => {
                          const label = name === 'actual' ? 'Payout' : name === 'projected' ? 'Projected' : '7d Avg';
                          return (
                            <span>
                              {label}: <strong>UGX {Number(value).toLocaleString()}</strong>
                            </span>
                          );
                        }}
                      />
                    }
                  />
                  <ReferenceLine
                    x={format(today, 'dd MMM')}
                    stroke="hsl(var(--muted-foreground))"
                    strokeDasharray="4 4"
                    label={{ value: 'Today', position: 'top', fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                  />
                  {/* Actual area */}
                  <Area
                    type="monotone"
                    dataKey="actual"
                    stroke="hsl(var(--primary))"
                    fill="hsl(var(--primary) / 0.15)"
                    strokeWidth={2}
                    connectNulls={false}
                    dot={false}
                  />
                  {/* 7-day rolling average */}
                  <Line
                    type="monotone"
                    dataKey="average"
                    stroke="hsl(142 76% 36%)"
                    strokeWidth={1.5}
                    strokeDasharray="4 2"
                    dot={false}
                    connectNulls={false}
                  />
                  {/* Projection area */}
                  <Area
                    type="monotone"
                    dataKey="projected"
                    stroke="hsl(var(--muted-foreground))"
                    fill="hsl(var(--muted-foreground) / 0.08)"
                    strokeWidth={2}
                    strokeDasharray="6 3"
                    connectNulls={false}
                    dot={false}
                  />
                </ComposedChart>
              </ChartContainer>
            )}
          </CardContent>
        </Card>

        {/* Projection Details */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <Target className="h-4 w-4 text-amber-600" />
              Projection Methodology
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground space-y-2">
            <p>
              Projections are based on a <strong className="text-foreground">14-day trailing average</strong> of daily payouts
              with a linear trend adjustment. The model uses actual payout data to estimate future distribution patterns.
            </p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-2">
              <div className="rounded-lg border border-border p-3 bg-muted/30">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Avg Daily Payout</p>
                <p className="text-base font-bold text-foreground">UGX {fmt(Math.round(avgDaily))}</p>
              </div>
              <div className="rounded-lg border border-border p-3 bg-muted/30">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Avg Payouts/Day</p>
                <p className="text-base font-bold text-foreground">{avgCount.toFixed(1)}</p>
              </div>
              <div className="rounded-lg border border-border p-3 bg-muted/30">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Daily Trend</p>
                <p className={`text-base font-bold ${trendSlope >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                  {trendSlope >= 0 ? '↑' : '↓'} UGX {fmt(Math.abs(Math.round(trendSlope)))}/day
                </p>
              </div>
              <div className="rounded-lg border border-border p-3 bg-muted/30">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">30-Day Projection</p>
                <p className="text-base font-bold text-amber-600">UGX {fmt(projected30)}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
