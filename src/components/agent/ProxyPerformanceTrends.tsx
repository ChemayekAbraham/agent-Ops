import { useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { formatDynamic } from '@/lib/currencyFormat';
import { BarChart3 } from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  ComposedChart,
} from 'recharts';
import {
  monthStartISO,
  recentMonths,
  useProxyAgentPvMonthly,
  type ProxyPvReport,
} from '@/hooks/useProxyAgentPerformance';

const money = (v: unknown) => formatDynamic(v);
const shortMoney = (v: number) =>
  v >= 1_000_000 ? `${(v / 1_000_000).toFixed(v % 1_000_000 === 0 ? 0 : 1)}M` : v >= 1_000 ? `${Math.round(v / 1_000)}K` : `${v}`;

type View = 'daily' | 'monthly';

interface Props {
  report: ProxyPvReport;
  agentId?: string | null;
  month: string;
  onMonthChange: (month: string) => void;
}

/**
 * Drilldown trends for the PV dashboard: a Daily view (this month's per-day PV
 * vs daily target) and a Monthly view (6-month PV vs monthly target). Month
 * chips switch the whole dashboard's month; clicking a monthly bar drills into
 * that month's daily view.
 */
export function ProxyPerformanceTrends({ report, agentId, month, onMonthChange }: Props) {
  const [view, setView] = useState<View>('daily');
  const monthly = useProxyAgentPvMonthly(agentId ?? null, 6);
  const months = recentMonths(6);

  const dailyData = report.daily.map((d) => ({
    label: new Date(`${d.day}T00:00:00`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }),
    pv: d.total_pv,
    target: d.daily_target,
  }));

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center gap-2">
          <BarChart3 className="h-4 w-4 text-primary" />
          <p className="text-xs font-black">Performance trends</p>
          <div className="ml-auto flex rounded-lg border border-border/60 p-0.5">
            {(['daily', 'monthly'] as View[]).map((v) => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={cn(
                  'rounded-md px-2.5 py-1 text-[10px] font-bold capitalize transition-colors',
                  view === v ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {v}
              </button>
            ))}
          </div>
        </div>

        {/* Month range chips */}
        <div className="flex flex-wrap gap-1.5">
          {months.map((m) => (
            <Button
              key={m}
              size="sm"
              variant={m === month ? 'default' : 'outline'}
              className="h-7 px-2.5 text-[10px] font-bold"
              onClick={() => onMonthChange(m)}
            >
              {new Date(`${m}T00:00:00`).toLocaleDateString('en-GB', { month: 'short', year: '2-digit' })}
            </Button>
          ))}
        </div>

        {view === 'daily' ? (
          dailyData.length === 0 ? (
            <p className="py-6 text-center text-[11px] text-muted-foreground">
              No daily PV recorded for this month yet.
            </p>
          ) : (
            <div className="h-52">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={dailyData} margin={{ top: 8, right: 4, left: -18, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-border/50" vertical={false} />
                  <XAxis dataKey="label" tick={{ fontSize: 9 }} className="text-muted-foreground" />
                  <YAxis tick={{ fontSize: 9 }} tickFormatter={shortMoney} className="text-muted-foreground" />
                  <Tooltip
                    formatter={(value: number, name: string) => [money(value), name === 'pv' ? 'PV earned' : 'Daily target']}
                    contentStyle={{ fontSize: 11, borderRadius: 12 }}
                  />
                  <Bar dataKey="pv" radius={[4, 4, 0, 0]} className="fill-primary" />
                  <Line type="monotone" dataKey="target" strokeWidth={1.5} dot={false} strokeDasharray="4 3" className="stroke-muted-foreground" />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          )
        ) : monthly.isLoading ? (
          <Skeleton className="h-52 w-full rounded-xl" />
        ) : monthly.points.length === 0 ? (
          <p className="py-6 text-center text-[11px] text-muted-foreground">No monthly history available yet.</p>
        ) : (
          <div className="h-52">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={monthly.points} margin={{ top: 8, right: 4, left: -18, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border/50" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 9 }} className="text-muted-foreground" />
                <YAxis tick={{ fontSize: 9 }} tickFormatter={shortMoney} className="text-muted-foreground" />
                <Tooltip
                  formatter={(value: number, name: string) => [money(value), name === 'total_pv' ? 'Total PV' : 'Monthly target']}
                  contentStyle={{ fontSize: 11, borderRadius: 12 }}
                />
                <ReferenceLine
                  y={monthly.points[monthly.points.length - 1]?.monthly_target ?? 0}
                  strokeDasharray="4 3"
                  className="stroke-muted-foreground"
                />
                <Bar
                  dataKey="total_pv"
                  radius={[4, 4, 0, 0]}
                  className="fill-primary cursor-pointer"
                  onClick={(data: { month?: string }) => {
                    if (data?.month) {
                      onMonthChange(data.month);
                      setView('daily');
                    }
                  }}
                >
                  {monthly.points.map((p) => (
                    <Cell key={p.month} className={cn(p.month === month ? 'fill-primary' : 'fill-primary/40')} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}

        <p className="text-[10px] text-muted-foreground">
          {view === 'daily'
            ? 'Bars are PV earned per working day; the dashed line is the daily target.'
            : 'Bars are total PV per month against the monthly target (dashed line). Tap a month to drill into its daily view.'}
        </p>
      </CardContent>
    </Card>
  );
}
