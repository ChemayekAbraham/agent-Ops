/**
 * "Weekly Performance" tab — Tenant Ops Weekly Performance dashboard.
 *
 * Presentation only. Every figure comes from useTenantOpsWeeklyPerformance /
 * useTenantOpsWeeklyHistory (Prompt 1's weekly snapshot ledger) and
 * TenantSelfPaymentWeeklyTrend (Prompt 3). No client-side arithmetic beyond
 * formatting and delta-sign coloring.
 *
 * Visual language matched to the rest of Tenant Ops -> Classic: KPICard's
 * rounded-2xl stat-tile shape, the success/warning/destructive/primary
 * semantic color tokens (TenantOpsHome.tsx, ManagementOverviewTab.tsx), and
 * the standard recharts Tooltip style used by RepaymentTrendChart /
 * TenantOpsPipelineTrendChart.
 */
import { useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { CalendarClock, ClipboardList, History, LucideIcon, TrendingUp } from 'lucide-react';
import { cn } from '@/lib/utils';
import { WorkspaceEmptyState } from '@/components/executive/tenant-ops/workspace/WorkspaceEmptyState';
import { WorkspaceMobileRow } from '@/components/executive/tenant-ops/workspace/WorkspaceMobileRow';
import { TenantSelfPaymentWeeklyTrend } from '@/components/executive/tenant-ops/workspace/TenantSelfPaymentWeeklyTrend';
import {
  useTenantOpsWeeklyHistory,
  useTenantOpsWeeklyPerformance,
} from '@/hooks/useTenantOpsWeeklyPerformance';

const dayLabel = (iso: string) => {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
};

const chartTooltipStyle = {
  backgroundColor: 'hsl(var(--card))',
  border: '1px solid hsl(var(--border))',
  borderRadius: '8px',
  fontSize: '12px',
};

/**
 * Same rounded-2xl stat-tile shape as KPICard, with a trend line that can be
 * inverted — KPICard itself always treats a rise as "good" (green), which is
 * wrong for a count where more is worse (20+ Days No Payment).
 */
function WeeklySummaryStat({
  title,
  value,
  icon: Icon,
  color,
  delta,
  goodDirection = 'up',
}: {
  title: string;
  value: string;
  icon: LucideIcon;
  color: string;
  delta: number;
  goodDirection?: 'up' | 'down';
}) {
  const rose = delta > 0;
  const fell = delta < 0;
  const good = goodDirection === 'up' ? rose : fell;
  const bad = goodDirection === 'up' ? fell : rose;
  const tone = delta === 0 ? 'text-muted-foreground' : good ? 'text-success' : bad ? 'text-destructive' : 'text-muted-foreground';
  const arrow = rose ? '↑' : fell ? '↓' : '·';

  return (
    <div className="flex w-full min-w-0 flex-col gap-2 rounded-2xl border border-border bg-card p-3 sm:p-4">
      <div className="flex min-w-0 items-center gap-2 sm:gap-2.5">
        <div className={cn('shrink-0 rounded-xl p-1.5 sm:p-2', color)}>
          <Icon className="h-4 w-4 sm:h-5 sm:w-5" />
        </div>
        <p className="min-w-0 line-clamp-2 break-words text-xs font-medium leading-tight text-muted-foreground">
          {title}
        </p>
      </div>
      <div className="min-w-0">
        <p className="break-words text-xl font-bold leading-tight tracking-tight tabular-nums sm:text-2xl">{value}</p>
        <p className={cn('mt-1.5 text-xs font-medium', tone)}>
          {arrow} {Math.abs(delta)} vs last week
        </p>
      </div>
    </div>
  );
}

export function WeeklyPerformanceTab() {
  const { data, isLoading } = useTenantOpsWeeklyPerformance();
  const { data: history, isLoading: historyLoading } = useTenantOpsWeeklyHistory(12);

  const chartData = useMemo(
    () =>
      (history ?? [])
        .slice()
        .reverse()
        .map((w) => ({
          week: dayLabel(w.week_start),
          'Payment Rate %': w.payment_rate_pct,
          'Active Tenants': w.total_active_tenants,
        })),
    [history],
  );

  if (isLoading || !data) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  const { current, delta, week_start, week_end, is_current_week_open } = data;

  return (
    <div className="space-y-5">
      <Card className="border shadow-sm">
        <CardHeader className="px-3 pb-2 sm:px-4">
          <CardTitle className="flex items-center gap-2 text-sm font-semibold">
            <ClipboardList className="h-4 w-4 text-primary" />
            Management Summary
          </CardTitle>
          <p className="text-[11px] text-muted-foreground">
            Reporting week{' '}
            <span className="font-semibold text-foreground">
              {dayLabel(week_start)} – {dayLabel(week_end)}
            </span>{' '}
            ({is_current_week_open ? 'in progress' : 'closed'}), compared with the week before.
          </p>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-2 px-3 sm:px-4 md:grid-cols-3 lg:grid-cols-5">
          <WeeklySummaryStat
            title="Active Tenants"
            value={String(current.total_active_tenants)}
            icon={TrendingUp}
            color="bg-primary/10 text-primary"
            delta={delta.total_active_tenants}
          />
          <WeeklySummaryStat
            title="Paying Tenants"
            value={String(current.paying_tenants)}
            icon={TrendingUp}
            color="bg-success/10 text-success"
            delta={delta.paying_tenants}
          />
          <WeeklySummaryStat
            title="Payment Rate"
            value={`${current.payment_rate_pct}%`}
            icon={TrendingUp}
            color="bg-success/10 text-success"
            delta={delta.payment_rate_pct}
          />
          <WeeklySummaryStat
            title="New Tenants"
            value={String(current.new_tenants_added)}
            icon={TrendingUp}
            color="bg-primary/10 text-primary"
            delta={delta.new_tenants_added}
          />
          <WeeklySummaryStat
            title="20+ Days No Payment"
            value={String(current.dormant_20_plus_count)}
            icon={CalendarClock}
            color="bg-warning/10 text-warning"
            delta={delta.dormant_20_plus_count}
            goodDirection="down"
          />
        </CardContent>
      </Card>

      <TenantSelfPaymentWeeklyTrend />

      <Card className="border shadow-sm">
        <CardHeader className="px-3 pb-2 sm:px-4">
          <CardTitle className="flex items-center gap-2 text-sm font-semibold">
            <History className="h-4 w-4 text-primary" />
            Historical Weekly Records
          </CardTitle>
        </CardHeader>
        <CardContent className="px-2 pb-3 sm:px-4">
          {historyLoading ? (
            <Skeleton className="h-64 w-full" />
          ) : !history || history.length === 0 ? (
            <WorkspaceEmptyState
              icon={CalendarClock}
              title="No closed weeks recorded yet"
              hint="A week's figures are frozen once it closes on Tuesday night — check back after the first full reporting week."
            />
          ) : (
            <div className="space-y-4">
              <div className="h-[220px]">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={chartData} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-border/50" vertical={false} />
                    <XAxis dataKey="week" tick={{ fontSize: 10 }} className="fill-muted-foreground" />
                    <YAxis tick={{ fontSize: 10 }} className="fill-muted-foreground" allowDecimals={false} />
                    <Tooltip contentStyle={chartTooltipStyle} />
                    <Line type="monotone" dataKey="Payment Rate %" stroke="hsl(var(--success))" strokeWidth={2} dot={false} />
                    <Line type="monotone" dataKey="Active Tenants" stroke="hsl(var(--primary))" strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>

              <div className="space-y-2 lg:hidden">
                {history.map((w) => (
                  <WorkspaceMobileRow
                    key={w.week_start}
                    title={`${dayLabel(w.week_start)} – ${dayLabel(w.week_end)}`}
                    fields={[
                      { label: 'Active', value: w.total_active_tenants },
                      { label: 'Paying', value: w.paying_tenants },
                      { label: 'Rate', value: `${w.payment_rate_pct}%` },
                      { label: 'New', value: w.new_tenants_added },
                      { label: '20+ days', value: w.dormant_20_plus_count },
                      { label: 'Self-paid', value: w.self_payment_tenants },
                    ]}
                  />
                ))}
              </div>

              <div className="hidden overflow-auto rounded-lg border lg:block">
                <Table>
                  <TableHeader className="bg-muted/50">
                    <TableRow>
                      <TableHead className="text-xs">Week</TableHead>
                      <TableHead className="text-xs">Active Tenants</TableHead>
                      <TableHead className="text-xs">Paying Tenants</TableHead>
                      <TableHead className="text-xs">Payment Rate</TableHead>
                      <TableHead className="text-xs">New Tenants</TableHead>
                      <TableHead className="text-xs">20+ Days No Payment</TableHead>
                      <TableHead className="text-xs">Self-Paid via Merchant</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {history.map((w) => (
                      <TableRow key={w.week_start}>
                        <TableCell className="whitespace-nowrap text-xs font-medium">
                          {dayLabel(w.week_start)} – {dayLabel(w.week_end)}
                        </TableCell>
                        <TableCell className="text-xs">{w.total_active_tenants}</TableCell>
                        <TableCell className="text-xs">{w.paying_tenants}</TableCell>
                        <TableCell className="text-xs">{w.payment_rate_pct}%</TableCell>
                        <TableCell className="text-xs">{w.new_tenants_added}</TableCell>
                        <TableCell className="text-xs">{w.dormant_20_plus_count}</TableCell>
                        <TableCell className="text-xs">{w.self_payment_tenants}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default WeeklyPerformanceTab;
