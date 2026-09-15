import { useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip, Legend, LineChart, Line, XAxis, YAxis, CartesianGrid } from 'recharts';
import {
  ClipboardList,
  CalendarCheck,
  Users,
  Activity,
  Download,
  CalendarX2,
  ChevronRight,
  ShieldCheck,
  TrendingUp,
  Wallet,
  UserPlus,
  UserCheck,
  UserX,
  CheckCircle2,
  XCircle,
  CalendarDays,
  MapPin,
} from 'lucide-react';
import { HubEntryCard } from '@/components/ops/HubEntryCard';
import { RepaymentTrendChart } from '@/components/executive/RepaymentTrendChart';
import { TenantRepaymentForecastPanel } from './TenantRepaymentForecastPanel';
import { useTenantOpsToolCounts } from '@/hooks/useTenantOpsToolCounts';
import { useTenantRepaymentReliability } from '@/hooks/useTenantRepaymentReliability';
import { useTenantOpsAcquisition } from '@/hooks/useTenantOpsAcquisition';
import { useTenantOpsAcquisitionRange } from '@/hooks/useTenantOpsAcquisitionRange';
import { useTenantOpsHomeRange } from '@/hooks/useTenantOpsHomeRange';
import { OpsDateRangeFilter, resolveRange, rangePhrase, type PresetKey } from '@/components/executive/shared/OpsDateRangeFilter';
import type { DateRange } from 'react-day-picker';
import { format } from 'date-fns';
import { formatUGX } from '@/lib/rentCalculations';
import { cn } from '@/lib/utils';
import type { TenantOpsActionKey, TenantOpsViewKey } from './tenantOpsNav';

/**
 * Landing page for Tenant Ops → Classic.
 *
 * Read-only. Period-scoped summary values come from the range helper while the
 * 7-day trend reuses the shared `RepaymentTrendChart`, and the reliability mix
 * reuses `get_tenant_repayment_reliability`. Every number on this page is a link
 * into an existing Classic view — no client-side business rules are re-derived.
 */
export function TenantOpsHome({ onNavigate }: { onNavigate: (view: TenantOpsViewKey | TenantOpsActionKey) => void }) {
  const [preset, setPreset] = useState<PresetKey>('today');
  const [custom, setCustom] = useState<DateRange | undefined>();
  const { start, end } = useMemo(() => resolveRange(preset, custom), [preset, custom]);
  const startIso = start.toISOString();
  const endIso = end.toISOString();
  const phrase = useMemo(() => rangePhrase(preset, start, end), [preset, start, end]);

  const { data: counts } = useTenantOpsToolCounts();
  const { data: reliability, isLoading: loadingReliability } = useTenantRepaymentReliability(800);
  const { data: acquisition, isLoading: loadingAcquisition } = useTenantOpsAcquisition();
  const { data: periodStats, isLoading: loadingPeriod } = useTenantOpsAcquisitionRange(startIso, endIso);
  const { data: homeRange, isLoading: loadingHomeRange } = useTenantOpsHomeRange(startIso, endIso);
  const c = counts;

  // The selected-period values drive every non-chart card. The existing live
  // expected amount remains dedicated to the unchanged repayment trend chart.
  const expected = homeRange?.expected ?? 0;
  const collected = homeRange?.collected ?? 0;
  const chartExpected = c?.expected_today ?? 0;
  const coverage = expected > 0 ? Math.min(100, Math.round((collected / expected) * 100)) : 0;
  const shortfall = Math.max(0, expected - collected);

  const reliabilityData = useMemo(() => {
    const s = reliability?.summary;
    if (!s) return [];
    return [
      { name: 'Reliable', value: s.reliable, color: 'hsl(var(--success))' },
      { name: 'Watch', value: s.watch, color: 'hsl(var(--warning))' },
      { name: 'At risk', value: s.risk, color: 'hsl(var(--destructive))' },
    ].filter((d) => d.value > 0);
  }, [reliability]);

  const num = (v: number | undefined) => (v ?? 0).toLocaleString('en-US');
  const inactiveTenants = Math.max(0, (homeRange?.tenant_count ?? 0) - (homeRange?.active_tenants ?? 0));
  const growthPct = acquisition?.growthPct;
  const growthLabel =
    growthPct == null ? '—' : `${growthPct >= 0 ? '+' : ''}${growthPct.toFixed(1)}%`;

  const stats: { label: string; value: string; hint: string; icon: typeof Users; view: TenantOpsViewKey; tone?: string }[] = [
    {
      label: 'Total Tenants',
      value: num(homeRange?.tenant_count),
      hint: `${num(homeRange?.active_tenants)} active ${phrase}`,
      icon: Users,
      view: 'all-tenants-hub',
      tone: 'bg-primary/10 text-primary',
    },
    {
      label: `New Tenants ${phrase}`,
      value: num(periodStats?.newTenants),
      hint: 'Registrations in selected period',
      icon: UserPlus,
      view: 'all-tenants-hub',
      tone: 'bg-success/10 text-success',
    },
    {
      label: `Registrations ${phrase}`,
      value: num(periodStats?.newTenants),
      hint: `Growth ${growthLabel}`,
      icon: CalendarDays,
      view: 'all-tenants-hub',
      tone: 'bg-success/10 text-success',
    },
    {
      label: 'Active Tenants',
      value: num(homeRange?.active_tenants),
      hint: `${num(homeRange?.paid_tenants)} paid ${phrase}`,
      icon: UserCheck,
      view: 'all-tenants-hub',
      tone: 'bg-primary/10 text-primary',
    },
    {
      label: 'Inactive Tenants',
      value: num(inactiveTenants),
      hint: `No active rent plan ${phrase}`,
      icon: UserX,
      view: 'all-tenants-hub',
      tone: 'bg-muted text-muted-foreground',
    },
    {
      label: `Applications ${phrase}`,
      value: num(periodStats?.applications),
      hint: `${num(homeRange?.review_requests)} awaiting review ${phrase}`,
      icon: ClipboardList,
      view: 'pipeline',
      tone: 'bg-warning/10 text-warning',
    },
    {
      label: `Applications Approved ${phrase}`,
      value: num(periodStats?.applicationsApproved),
      hint: `${num(homeRange?.approvals)} approved ${phrase}`,
      icon: CheckCircle2,
      view: 'pipeline-hub',
      tone: 'bg-success/10 text-success',
    },
    {
      label: `Applications Rejected ${phrase}`,
      value: num(periodStats?.applicationsRejected),
      hint: `${num(homeRange?.rejected)} rejected ${phrase}`,
      icon: XCircle,
      view: 'pipeline',
      tone: 'bg-destructive/10 text-destructive',
    },
  ];

  const attention: { label: string; description: string; value: number; view: TenantOpsViewKey; tone: string }[] = [
    {
      label: `Requests in review ${phrase}`,
      description: 'Vet, approve or return incoming rent requests',
      value: homeRange?.review_requests ?? 0,
      view: 'pipeline',
      tone: 'text-warning',
    },
    {
      label: `Unpaid tenants ${phrase}`,
      description: 'Tenants with no payment recorded in the selected period',
      value: homeRange?.unpaid_tenants ?? 0,
      view: 'daily',
      tone: 'text-warning',
    },
    {
      label: `Tenants with missed days ${phrase}`,
      description: 'Behind on the daily repayment schedule',
      value: homeRange?.missed_days_tenants ?? 0,
      view: 'missed',
      tone: 'text-destructive',
    },
    {
      label: `Critical behaviour ${phrase}`,
      description: `${num(homeRange?.warning_behaviour)} on warning`,
      value: homeRange?.critical_behaviour ?? 0,
      view: 'behavior',
      tone: 'text-destructive',
    },
    {
      label: `Service centre review ${phrase}`,
      description: 'Requests parked with the service centre',
      value: homeRange?.service_center_review ?? 0,
      view: 'pipeline-hub',
      tone: 'text-muted-foreground',
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h2 className="text-base font-bold tracking-tight">Tenant Operations</h2>
          <p className="text-xs text-muted-foreground">
            {format(start, 'dd MMM yyyy')} → {format(end, 'dd MMM yyyy')} · live position across requests, repayments and tenants.
          </p>
        </div>
        <OpsDateRangeFilter
          preset={preset}
          custom={custom}
          onPresetChange={setPreset}
          onCustomChange={setCustom}
        />
      </div>

      {/* Prominent "Review Rent Requests" action — first thing an operator sees. */}
      <div className="space-y-2">
        <button
          type="button"
          onClick={() => onNavigate('pipeline')}
          aria-label={`Open Review Rent Requests queue — ${homeRange?.review_requests ?? 0} pending`}
          className="group relative w-full overflow-hidden rounded-2xl border border-primary/20 bg-gradient-to-br from-primary/15 via-card to-card p-4 sm:p-5 text-left shadow-sm transition-all hover:border-primary/40 hover:shadow-md active:scale-[0.99] touch-manipulation focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
        >
          <div className="flex items-start gap-3 sm:gap-4">
            <div className="rounded-2xl bg-primary p-3 sm:p-3.5 text-primary-foreground shadow-sm">
              <ClipboardList className="h-6 w-6 sm:h-7 sm:w-7" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-base sm:text-lg font-bold text-foreground leading-tight">Review Rent Requests</h3>
                {(homeRange?.review_requests ?? 0) > 0 ? (
                  <span className="rounded-full bg-destructive px-2.5 py-0.5 text-xs font-bold text-destructive-foreground">
                    {homeRange?.review_requests} pending
                  </span>
                ) : (
                  <span className="rounded-full bg-muted px-2.5 py-0.5 text-xs font-bold text-muted-foreground">
                    0 pending
                  </span>
                )}
              </div>
              <p className="mt-1 text-xs sm:text-sm text-muted-foreground">
                Vet, approve or return incoming rent requests
              </p>
              <div className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-primary px-3.5 sm:px-4 py-1.5 sm:py-2 text-xs sm:text-sm font-bold text-primary-foreground shadow-sm group-hover:bg-primary/90 transition-colors">
                Open queue
                <ArrowRight className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
              </div>
            </div>
          </div>
        </button>
      </div>

       {/* Selected-period collection hero + KPI strip */}
       <div className="grid gap-3 lg:grid-cols-3">
         <Card className="lg:col-span-1 border-primary/30 bg-gradient-to-br from-primary/10 via-card to-card shadow-sm">
           <CardContent className="p-4">
             <div className="flex items-center gap-2">
               <div className="rounded-xl bg-primary/15 p-2">
                 <Wallet className="h-4 w-4 text-primary" />
               </div>
               <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                 Collected {phrase}
               </p>
             </div>
             <p className="mt-3 text-2xl font-bold tabular-nums leading-none">
               {loadingHomeRange ? '—' : formatUGX(collected)}
             </p>
             <p className="mt-1 text-xs text-muted-foreground">
               of {formatUGX(expected)} expected {phrase}
             </p>
            <Progress value={coverage} className="mt-3 h-2" />
            <div className="mt-2 flex items-center justify-between text-[11px]">
              <span className="font-semibold text-foreground">{coverage}% covered</span>
              <span className={cn(shortfall > 0 ? 'text-destructive' : 'text-success', 'font-semibold')}>
                {shortfall > 0 ? `${formatUGX(shortfall)} short` : 'Target met'}
              </span>
            </div>
            <button
              type="button"
              onClick={() => onNavigate('daily-collections')}
              className="mt-3 inline-flex items-center gap-1 text-[11px] font-bold text-primary hover:underline"
            >
              Open collection monitoring
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </CardContent>
        </Card>

        <div className="lg:col-span-2 space-y-2">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Executive summary
          </p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4">
            {stats.map((s) => (
              <button
                key={s.label}
                type="button"
                onClick={() => onNavigate(s.view)}
                className="group rounded-2xl border border-border/60 bg-card p-3.5 text-left shadow-sm transition-all hover:border-primary/50 hover:shadow-md active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
              >
                <div className="flex items-center gap-2">
                  <div className={cn('rounded-xl p-2 shrink-0', s.tone)}>
                    <s.icon className="h-4 w-4" />
                  </div>
                  <p className="min-w-0 text-[10px] font-semibold uppercase leading-tight tracking-wider text-muted-foreground break-words line-clamp-2">
                    {s.label}
                  </p>
                </div>
                <p className="mt-2 text-xl font-bold tabular-nums leading-none">
                   {loadingHomeRange || loadingPeriod ? '—' : s.value}
                 </p>
                <p className="mt-1 text-[11px] leading-snug text-muted-foreground break-words line-clamp-2">{s.hint}</p>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Tenant Acquisition */}
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-bold tracking-tight flex items-center gap-2">
              <MapPin className="h-4 w-4 text-primary" />
              Tenant Acquisition
            </h3>
            <p className="text-[11px] text-muted-foreground">
              Registrations and distribution across locations, service centres and agents.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5 text-[11px] font-semibold">
            <span className="rounded-full bg-muted px-2.5 py-1">
              Today: <span className="text-foreground">{loadingAcquisition ? '—' : num(acquisition?.newToday)}</span>
            </span>
            <span className="rounded-full bg-muted px-2.5 py-1">
              This week: <span className="text-foreground">{loadingAcquisition ? '—' : num(acquisition?.newThisWeek)}</span>
            </span>
            <span className="rounded-full bg-muted px-2.5 py-1">
              This month: <span className="text-foreground">{loadingAcquisition ? '—' : num(acquisition?.newThisMonth)}</span>
            </span>
            <span className={cn(
              'rounded-full px-2.5 py-1',
              growthPct != null && growthPct < 0 ? 'bg-destructive/10 text-destructive' : 'bg-success/10 text-success'
            )}>
              Growth: {loadingAcquisition ? '—' : growthLabel}
            </span>
          </div>
        </div>

        <Card className="border shadow-sm">
          <CardHeader className="pb-2 px-3 sm:px-4">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <TrendingUp className="h-4 w-4 text-primary" />
              New Tenant Registrations (30 Days)
            </CardTitle>
          </CardHeader>
          <CardContent className="px-2 sm:px-4 pb-3">
            <div className="h-[220px]">
              {loadingAcquisition ? (
                <div className="h-full w-full animate-pulse rounded-xl bg-muted" />
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={acquisition?.trend ?? []} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-border/50" />
                    <XAxis
                      dataKey="date"
                      tick={{ fontSize: 10 }}
                      className="fill-muted-foreground"
                      interval="preserveStartEnd"
                      minTickGap={40}
                    />
                    <YAxis
                      tick={{ fontSize: 10 }}
                      className="fill-muted-foreground"
                      allowDecimals={false}
                    />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: 'hsl(var(--card))',
                        border: '1px solid hsl(var(--border))',
                        borderRadius: '8px',
                        fontSize: '12px',
                      }}
                      formatter={(value: number) => [`${value} new tenants`, 'Registrations']}
                      labelFormatter={(label, payload) => payload?.[0]?.payload?.fullDate || label}
                    />
                    <Line
                      type="monotone"
                      dataKey="count"
                      stroke="hsl(var(--primary))"
                      strokeWidth={2}
                      dot={false}
                      activeDot={{ r: 4 }}
                    />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </div>
          </CardContent>
        </Card>

        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          <BreakdownBars
            title="Active tenants by location"
            bars={acquisition?.byLocation ?? []}
            loading={loadingAcquisition}
          />
          <BreakdownBars
            title="Active tenants by service centre"
            bars={acquisition?.byServiceCentre ?? []}
            loading={loadingAcquisition}
          />
          <BreakdownBars
            title="Active tenants by agent"
            bars={acquisition?.byAgent ?? []}
            loading={loadingAcquisition}
          />
        </div>
      </div>

      {/* Forward planning is separate from the existing dashboard charts. */}
      <TenantRepaymentForecastPanel />

      {/* Charts */}
      <div className="grid gap-3 lg:grid-cols-3">
        <div className="lg:col-span-2">
           <RepaymentTrendChart dailyExpected={chartExpected} />
        </div>
        <Card className="border shadow-sm">
          <CardHeader className="pb-2 px-3 sm:px-4">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-primary" />
              Repayment Reliability Mix
            </CardTitle>
          </CardHeader>
          <CardContent className="px-2 sm:px-4 pb-3">
            <div className="h-[220px]">
              {loadingReliability ? (
                <div className="h-full w-full animate-pulse rounded-xl bg-muted" />
              ) : reliabilityData.length === 0 ? (
                <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                  No reliability data yet
                </div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={reliabilityData} dataKey="value" nameKey="name" innerRadius={48} outerRadius={78} paddingAngle={2}>
                      {reliabilityData.map((d) => (
                        <Cell key={d.name} fill={d.color} />
                      ))}
                    </Pie>
                    <Tooltip
                      contentStyle={{
                        backgroundColor: 'hsl(var(--card))',
                        border: '1px solid hsl(var(--border))',
                        borderRadius: '8px',
                        fontSize: '12px',
                      }}
                      formatter={(value: number, name: string) => [`${value} tenants`, name]}
                    />
                    <Legend wrapperStyle={{ fontSize: '11px' }} />
                  </PieChart>
                </ResponsiveContainer>
              )}
            </div>
            <button
              type="button"
              onClick={() => onNavigate('reliability-hub')}
              className="mt-1 inline-flex items-center gap-1 px-1 text-[11px] font-bold text-primary hover:underline"
            >
              Open reliability score
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </CardContent>
        </Card>
      </div>

      {/* Needs attention */}
      <Card className="border shadow-sm">
        <CardHeader className="pb-2 px-3 sm:px-4">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <Activity className="h-4 w-4 text-primary" />
            Needs attention
          </CardTitle>
        </CardHeader>
        <CardContent className="px-2 sm:px-3 pb-3">
          <div className="divide-y">
            {attention.map((a) => (
              <button
                key={a.label}
                type="button"
                onClick={() => onNavigate(a.view)}
                className="group flex w-full items-center gap-2.5 rounded-lg px-2 py-2.5 sm:gap-3 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
              >
                <span className={cn('w-10 shrink-0 text-base font-bold tabular-nums sm:w-12 sm:text-lg', a.tone)}>
                   {loadingHomeRange ? '—' : a.value}
                 </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-xs font-bold leading-snug text-foreground break-words">{a.label}</span>
                  <span className="block text-[11px] leading-snug text-muted-foreground break-words line-clamp-2">
                    {a.description}
                  </span>
                </span>
                <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-primary" />
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

       {/* Quick actions */}
       <div className="space-y-2">
         <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Quick actions · {phrase}</p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <HubEntryCard
              title="Daily Payments"
             description={`Who paid ${phrase} and who still owes`}
             icon={CalendarCheck}
             stats={[{ label: 'unpaid', value: homeRange?.unpaid_tenants ?? 0 }]}
             onClick={() => onNavigate('daily')}
           />
           <HubEntryCard
             title="Missed Days"
             description="Tenants behind on their daily repayment"
             icon={CalendarX2}
             stats={[{ label: 'tenants', value: homeRange?.missed_days_tenants ?? 0 }]}
             onClick={() => onNavigate('missed')}
           />
          <HubEntryCard
            title="Reports & Exports"
            description="Extracts, statements and date-ranged reports"
            icon={Download}
            onClick={() => onNavigate('reports-hub')}
          />
           <HubEntryCard
             title="Portfolio Performance"
             description="Rent collections and rent requests, daily, weekly and monthly."
             icon={TrendingUp}
             onClick={() => onNavigate('action.portfolio-performance')}
           />
        </div>
      </div>
    </div>
  );
}

/**
 * Compact horizontal-bar breakdown card (top 8 rows + overflow note),
 * styled to match the rest of the Classic Home cards.
 */
function BreakdownBars({
  title,
  bars,
  loading,
}: {
  title: string;
  bars: { label: string; value: number }[];
  loading?: boolean;
}) {
  const top = bars.slice(0, 8);
  const max = top.reduce((m, b) => Math.max(m, b.value), 0);
  return (
    <Card className="border shadow-sm">
      <CardHeader className="pb-2 px-3 sm:px-4">
        <CardTitle className="text-sm font-semibold">{title}</CardTitle>
      </CardHeader>
      <CardContent className="px-3 sm:px-4 pb-3">
        {loading ? (
          <div className="h-[180px] w-full animate-pulse rounded-xl bg-muted" />
        ) : top.length === 0 ? (
          <div className="flex h-[180px] items-center justify-center text-xs text-muted-foreground">
            No data yet
          </div>
        ) : (
          <div className="space-y-2">
            {top.map((b) => (
              <div key={b.label} className="space-y-1">
                <div className="flex items-center justify-between gap-2 text-[11px]">
                  <span className="min-w-0 truncate font-medium text-foreground">{b.label}</span>
                  <span className="shrink-0 font-bold tabular-nums text-foreground">
                    {b.value.toLocaleString('en-US')}
                  </span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-primary"
                    style={{ width: max > 0 ? `${Math.max(3, (b.value / max) * 100)}%` : '0%' }}
                  />
                </div>
              </div>
            ))}
            {bars.length > top.length && (
              <p className="pt-1 text-[10px] text-muted-foreground">
                +{bars.length - top.length} more
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
