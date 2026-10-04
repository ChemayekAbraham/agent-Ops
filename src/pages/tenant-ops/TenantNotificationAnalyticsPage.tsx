import { useState } from 'react';
import { Helmet } from 'react-helmet-async';
import { subDays, format } from 'date-fns';
import {
  useTenantSmartphoneOverview,
  useTenantNotificationPerformance,
  useTenantChannelPerformance,
} from '@/hooks/useTenantNotificationAnalytics';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { UgDistrictSelect, type UgDistrictValue } from '@/components/location/UgDistrictSelect';
import {
  Smartphone,
  Phone,
  HelpCircle,
  CheckCircle2,
  Bell,
  MessageSquare,
  Radio,
  Filter,
  RefreshCw,
  TrendingUp,
  AlertTriangle,
} from 'lucide-react';
import { cn } from '@/lib/utils';

/** Compact label/value tile matching the Tenant Ops home KPI strip. */
function StatTile({
  label,
  value,
  tone = 'muted',
  loading,
}: {
  label: string;
  value: string | number | undefined;
  tone?: 'muted' | 'primary' | 'success' | 'warning' | 'destructive';
  loading?: boolean;
}) {
  const shell: Record<string, string> = {
    muted: 'border-border/50 bg-muted/40',
    primary: 'border-primary/20 bg-primary/10',
    success: 'border-success/20 bg-success/10',
    warning: 'border-warning/20 bg-warning/10',
    destructive: 'border-destructive/20 bg-destructive/10',
  };
  const text: Record<string, string> = {
    muted: 'text-foreground',
    primary: 'text-primary',
    success: 'text-success',
    warning: 'text-warning',
    destructive: 'text-destructive',
  };
  return (
    <div className={cn('rounded-2xl border p-3', shell[tone])}>
      <p className="text-[10px] font-semibold uppercase leading-tight tracking-wider text-muted-foreground">
        {label}
      </p>
      {loading ? (
        <Skeleton className="mt-2 h-5 w-14" />
      ) : (
        <p className={cn('mt-1.5 text-lg font-bold tabular-nums leading-none', text[tone])}>
          {typeof value === 'number' ? value.toLocaleString('en-US') : (value ?? '—')}
        </p>
      )}
    </div>
  );
}

/** Icon + label + count row used inside the device and source cards. */
function BreakdownRow({
  icon: Icon,
  label,
  value,
  tone = 'muted',
  loading,
}: {
  icon: typeof Smartphone;
  label: string;
  value: number | undefined;
  tone?: 'muted' | 'success' | 'warning' | 'destructive';
  loading?: boolean;
}) {
  const shell: Record<string, string> = {
    muted: 'border-border/50 bg-muted/50',
    success: 'border-success/20 bg-success/10',
    warning: 'border-warning/20 bg-warning/10',
    destructive: 'border-destructive/20 bg-destructive/10',
  };
  const accent: Record<string, string> = {
    muted: 'text-muted-foreground',
    success: 'text-success',
    warning: 'text-warning',
    destructive: 'text-destructive',
  };
  return (
    <div className={cn('flex items-center justify-between gap-2 rounded-xl border px-3 py-2.5', shell[tone])}>
      <div className="flex min-w-0 items-center gap-2">
        <Icon className={cn('h-4 w-4 shrink-0', accent[tone])} aria-hidden="true" />
        <span className="truncate text-xs font-semibold text-foreground">{label}</span>
      </div>
      {loading ? (
        <Skeleton className="h-4 w-10" />
      ) : (
        <span className={cn('text-sm font-bold tabular-nums', accent[tone])}>
          {(value ?? 0).toLocaleString('en-US')}
        </span>
      )}
    </div>
  );
}

/** Consistent inline error notice for a failed card query. */
function CardError({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-xs text-destructive">
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0 break-words">{message}</span>
    </div>
  );
}

/**
 * Smartphone & notification analytics.
 *
 * `embedded` renders the page inside the Tenant Ops Classic shell (the sidebar
 * and top bar stay visible), so the page supplies no full-screen chrome of its
 * own. Every query, filter and figure is unchanged in either mode.
 */
export default function TenantNotificationAnalyticsPage({ embedded = false }: { embedded?: boolean } = {}) {
  // Supported server-side filters:
  // - date range (startDate/endDate) — performance + channel cards
  // - district — smartphone overview + performance card
  // - agentId — smartphone overview only
  // - eventKey — performance + channel cards
  const [startDate, setStartDate] = useState(() =>
    format(subDays(new Date(), 30), 'yyyy-MM-dd'),
  );
  const [endDate, setEndDate] = useState(() =>
    format(new Date(), 'yyyy-MM-dd'),
  );
  const [districtValue, setDistrictValue] = useState<UgDistrictValue | null>(null);
  const [agentId, setAgentId] = useState('');
  const [eventKey, setEventKey] = useState('');

  const overviewQuery = useTenantSmartphoneOverview({
    district: districtValue?.name ?? null,
    agentId: agentId.trim() || null,
  });

  const perfQuery = useTenantNotificationPerformance({
    startDate,
    endDate,
    eventKey: eventKey.trim() || null,
    district: districtValue?.name ?? null,
  });

  const channelsQuery = useTenantChannelPerformance({
    startDate,
    endDate,
    eventKey: eventKey.trim() || null,
  });

  const handleRefresh = () => {
    overviewQuery.refetch();
    perfQuery.refetch();
    channelsQuery.refetch();
  };

  const overview = overviewQuery.data;
  const perf = perfQuery.data;
  const channels = channelsQuery.data;

  const refreshing = overviewQuery.isFetching || perfQuery.isFetching || channelsQuery.isFetching;
  const loadingOverview = overviewQuery.isLoading;
  const loadingPerf = perfQuery.isLoading;
  const loadingChannels = channelsQuery.isLoading;

  // Group channel rows by event_key
  const channelGroups = (channels?.rows || []).reduce<
    Record<string, Array<(typeof channels.rows)[0]>>
  >((acc, row) => {
    if (!acc[row.event_key]) acc[row.event_key] = [];
    acc[row.event_key].push(row);
    return acc;
  }, {});

  const getActedLabel = (key: string) => {
    if (key === 'MERCHANT_CODE_REMINDER') return 'Payment after reminder';
    if (key === 'FIVE_DAY_AGENT_OPPORTUNITY') return 'Became agent after opportunity SMS';
    return 'Sent → later acted';
  };

  const body = (
    <div className="space-y-4">
      {/* Page header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-primary">
            <Smartphone className="h-4 w-4 shrink-0" aria-hidden="true" />
            <p className="text-[11px] font-semibold uppercase tracking-wider">Tenant Ops · devices</p>
          </div>
          <h2 className={cn('mt-1 font-bold tracking-tight text-foreground', embedded ? 'text-base' : 'text-xl sm:text-2xl')}>
            Smartphone &amp; Notification Analytics
          </h2>
          <p className="mt-1 max-w-2xl text-xs text-muted-foreground">
            Device segmentation, dashboard adoption and multi-channel notification performance for tenant Rent Plans.
          </p>
        </div>

        <Button
          variant="outline"
          size="sm"
          onClick={handleRefresh}
          disabled={refreshing}
          className="h-9 shrink-0 gap-2 self-start rounded-lg"
        >
          <RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} />
          Refresh Data
        </Button>
      </div>

      {/* Server-supported filters */}
      <Card className="rounded-2xl border-border/60 shadow-sm">
        <CardHeader className="px-4 py-3 pb-2">
          <CardTitle className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            <Filter className="h-3.5 w-3.5" aria-hidden="true" />
            Supported Filters
          </CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-3 p-4 pt-1 sm:grid-cols-2 lg:grid-cols-5">
          <div>
            <Label className="text-[11px] font-semibold text-muted-foreground">Start Date</Label>
            <Input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="mt-1 h-9 rounded-lg text-xs"
            />
          </div>
          <div>
            <Label className="text-[11px] font-semibold text-muted-foreground">End Date</Label>
            <Input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="mt-1 h-9 rounded-lg text-xs"
            />
          </div>
          <div>
            <div className="flex items-center justify-between gap-2">
              <Label className="text-[11px] font-semibold text-muted-foreground">District (overview &amp; perf)</Label>
              {districtValue && (
                <button
                  type="button"
                  onClick={() => setDistrictValue(null)}
                  className="text-[10px] font-semibold text-muted-foreground underline hover:text-foreground"
                >
                  Clear
                </button>
              )}
            </div>
            <UgDistrictSelect
              value={districtValue}
              onChange={setDistrictValue}
              placeholder="All districts"
              className="mt-1 [&>label]:hidden [&_button]:h-9 [&_button]:rounded-lg [&_button]:text-xs"
            />
          </div>
          <div>
            <Label className="text-[11px] font-semibold text-muted-foreground">Agent ID (overview only)</Label>
            <Input
              placeholder="Agent UUID"
              value={agentId}
              onChange={(e) => setAgentId(e.target.value)}
              className="mt-1 h-9 rounded-lg text-xs"
            />
          </div>
          <div>
            <Label className="text-[11px] font-semibold text-muted-foreground">Event Key (perf &amp; channels)</Label>
            <Input
              placeholder="e.g. PAYMENT_MISSED"
              value={eventKey}
              onChange={(e) => setEventKey(e.target.value)}
              className="mt-1 h-9 rounded-lg text-xs"
            />
          </div>
        </CardContent>
      </Card>

      {/* Overview cards */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        {/* CARD 1 — Device access */}
        <Card className="flex flex-col rounded-2xl border-border/60 shadow-sm">
          <CardHeader className="px-4 py-4 pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-bold">
              <span className="rounded-xl bg-primary/10 p-1.5 text-primary">
                <Smartphone className="h-4 w-4" aria-hidden="true" />
              </span>
              Device Access
            </CardTitle>
            <CardDescription className="text-xs">
              Smartphone vs feature phone segmentation across active tenants
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-1 flex-col gap-3 p-4 pt-1">
            {overviewQuery.isError ? (
              <CardError message={(overviewQuery.error as Error)?.message ?? 'Could not load device segmentation.'} />
            ) : (
              <>
                <div className="flex items-baseline justify-between gap-2 rounded-2xl border border-primary/20 bg-gradient-to-br from-primary/10 via-card to-card p-3">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Total Active Tenants
                  </span>
                  {loadingOverview ? (
                    <Skeleton className="h-7 w-16" />
                  ) : (
                    <span className="text-2xl font-bold tabular-nums leading-none text-foreground">
                      {overview?.active_tenants?.toLocaleString('en-US') ?? '—'}
                    </span>
                  )}
                </div>

                <div className="space-y-2">
                  <BreakdownRow
                    icon={Smartphone}
                    label="Confirmed Smartphone"
                    value={overview?.device.confirmed_smartphone}
                    tone="success"
                    loading={loadingOverview}
                  />
                  <BreakdownRow
                    icon={Phone}
                    label="Confirmed Feature Phone"
                    value={overview?.device.confirmed_feature_phone}
                    tone="warning"
                    loading={loadingOverview}
                  />
                  <BreakdownRow
                    icon={HelpCircle}
                    label="Device Unknown"
                    value={overview?.device.unknown}
                    loading={loadingOverview}
                  />
                </div>
              </>
            )}
          </CardContent>
        </Card>

        {/* CARD 2 — Dashboard adoption */}
        <Card className="flex flex-col rounded-2xl border-border/60 shadow-sm">
          <CardHeader className="px-4 py-4 pb-2">
            <div className="flex items-start justify-between gap-2">
              <CardTitle className="flex items-center gap-2 text-sm font-bold">
                <span className="rounded-xl bg-primary/10 p-1.5 text-primary">
                  <TrendingUp className="h-4 w-4" aria-hidden="true" />
                </span>
                Dashboard Adoption
              </CardTitle>
              <Badge variant="secondary" className="shrink-0 bg-primary/10 text-sm font-bold tabular-nums text-primary">
                {overview?.dashboard?.activation_rate_pct != null
                  ? `${Math.round(overview.dashboard.activation_rate_pct)}%`
                  : '—'}
              </Badge>
            </div>
            <CardDescription className="text-xs">
              Portal engagement among tenants with active Rent Plans
            </CardDescription>
          </CardHeader>
          <CardContent className="flex-1 space-y-3 p-4 pt-1">
            {overviewQuery.isError ? (
              <CardError message={(overviewQuery.error as Error)?.message ?? 'Could not load dashboard adoption.'} />
            ) : (
              <>
                <div className="grid grid-cols-2 gap-2">
                  <StatTile label="Activated" value={overview?.dashboard.activated ?? 0} loading={loadingOverview} />
                  <StatTile label="Never Activated" value={overview?.dashboard.never_activated ?? 0} loading={loadingOverview} />
                  <StatTile
                    label="Smartphone & Activated"
                    value={overview?.dashboard.smartphone_and_activated ?? 0}
                    tone="success"
                    loading={loadingOverview}
                  />
                  <StatTile
                    label="Smartphone Not Activated"
                    value={overview?.dashboard.smartphone_not_activated ?? 0}
                    tone="warning"
                    loading={loadingOverview}
                  />
                </div>

                <div className="grid grid-cols-4 gap-2 border-t border-border/50 pt-3 text-center">
                  {[
                    { label: 'Opened 1x', value: overview?.dashboard.opened_once, accent: 'text-foreground' },
                    { label: 'Opened 2+', value: overview?.dashboard.opened_2_plus, accent: 'text-foreground' },
                    { label: 'Last 7d', value: overview?.dashboard.opened_last_7d, accent: 'text-primary' },
                    { label: 'Last 30d', value: overview?.dashboard.opened_last_30d, accent: 'text-primary' },
                  ].map((item) => (
                    <div key={item.label}>
                      <span className="block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                        {item.label}
                      </span>
                      {loadingOverview ? (
                        <Skeleton className="mx-auto mt-1 h-4 w-8" />
                      ) : (
                        <span className={cn('text-sm font-bold tabular-nums', item.accent)}>
                          {(item.value ?? 0).toLocaleString('en-US')}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              </>
            )}
          </CardContent>
        </Card>

        {/* CARD 3 — How is the Unknown population being resolved */}
        <Card className="flex flex-col rounded-2xl border-border/60 shadow-sm">
          <CardHeader className="px-4 py-4 pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-bold">
              <span className="rounded-xl bg-primary/10 p-1.5 text-primary">
                <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
              </span>
              Unknown Resolution Sources
            </CardTitle>
            <CardDescription className="text-xs">
              Channels identifying device capability across the tenant base
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-1 flex-col justify-between gap-3 p-4 pt-1">
            {overviewQuery.isError ? (
              <CardError message={(overviewQuery.error as Error)?.message ?? 'Could not load resolution sources.'} />
            ) : (
              <>
                <div>
                  {[
                    { label: 'Onboarding Registration', value: overview?.source.onboarding },
                    { label: 'Call Centre Confirmation', value: overview?.source.call_centre },
                    { label: 'Dashboard Link Access', value: overview?.source.dashboard_access },
                    { label: 'Field Agent', value: overview?.source.agent },
                    { label: 'System Detection', value: overview?.source.system_detection },
                  ].map((row) => (
                    <div
                      key={row.label}
                      className="flex items-center justify-between gap-2 border-b border-border/40 py-2 last:border-0"
                    >
                      <span className="min-w-0 truncate text-xs text-muted-foreground">{row.label}</span>
                      {loadingOverview ? (
                        <Skeleton className="h-4 w-10" />
                      ) : (
                        <span className="text-xs font-bold tabular-nums text-foreground">
                          {(row.value ?? 0).toLocaleString('en-US')}
                        </span>
                      )}
                    </div>
                  ))}
                </div>

                <div className="flex items-center justify-between gap-2 rounded-2xl border border-destructive/20 bg-destructive/10 p-3">
                  <div className="min-w-0">
                    <span className="block text-xs font-bold text-foreground">Still Unresolved</span>
                    <span className="text-[11px] text-muted-foreground">Pending discovery or verification</span>
                  </div>
                  {loadingOverview ? (
                    <Skeleton className="h-6 w-12" />
                  ) : (
                    <span className="text-lg font-bold tabular-nums text-destructive">
                      {(overview?.source.unresolved ?? 0).toLocaleString('en-US')}
                    </span>
                  )}
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      {/* CARD 4 — SMS/notification performance */}
      <Card className="rounded-2xl border-border/60 shadow-sm">
        <CardHeader className="px-4 py-4 pb-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <CardTitle className="flex items-center gap-2 text-sm font-bold">
                <span className="rounded-xl bg-primary/10 p-1.5 text-primary">
                  <MessageSquare className="h-4 w-4" aria-hidden="true" />
                </span>
                SMS &amp; Notification Performance
              </CardTitle>
              <CardDescription className="text-xs">
                Aggregate delivery and action rates from {startDate} to {endDate}
              </CardDescription>
            </div>

            {perf?.totals && (
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline" className="text-[11px] font-semibold tabular-nums">
                  Unique Tenants: {perf.totals.unique_tenants?.toLocaleString('en-US') ?? 0}
                </Badge>
                <Badge variant="secondary" className="bg-primary/10 text-[11px] font-bold tabular-nums text-primary">
                  Sent → Later Acted: {Math.round(perf.totals.conversion_rate_pct ?? 0)}%
                </Badge>
              </div>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-3 p-4 pt-0">
          {perfQuery.isError ? (
            <CardError message={(perfQuery.error as Error)?.message ?? 'Could not load notification performance.'} />
          ) : (
            <>
              {/* Totals summary strip */}
              {(loadingPerf || perf?.totals) && (
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
                  <StatTile label="Total Sent" value={perf?.totals?.sent ?? 0} loading={loadingPerf} />
                  <StatTile label="Delivered" value={perf?.totals?.delivered ?? 0} tone="success" loading={loadingPerf} />
                  <StatTile label="Failed" value={perf?.totals?.failed ?? 0} tone="destructive" loading={loadingPerf} />
                  <StatTile label="Suppressed" value={perf?.totals?.suppressed ?? 0} loading={loadingPerf} />
                  <StatTile label="Later Acted" value={perf?.totals?.acted ?? 0} tone="primary" loading={loadingPerf} />
                  <StatTile
                    label="Action Rate"
                    value={`${Math.round(perf?.totals?.conversion_rate_pct ?? 0)}%`}
                    tone="primary"
                    loading={loadingPerf}
                  />
                </div>
              )}

              {/* Per-event breakdown table */}
              <div className="overflow-x-auto rounded-2xl border border-border/60">
                <table className="w-full text-left text-xs">
                  <thead className="border-b border-border/60 bg-muted/50 text-[10px] uppercase tracking-wider text-muted-foreground">
                    <tr>
                      <th className="px-4 py-2.5 font-semibold">Event Key</th>
                      <th className="px-3 py-2.5 text-right font-semibold">Sent</th>
                      <th className="px-3 py-2.5 text-right font-semibold">Delivered</th>
                      <th className="px-3 py-2.5 text-right font-semibold">Failed</th>
                      <th className="px-3 py-2.5 text-right font-semibold">Suppressed</th>
                      <th className="px-3 py-2.5 text-right font-semibold">Tenants</th>
                      <th className="px-4 py-2.5 text-right font-semibold">Sent → Later Acted</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/40">
                    {loadingPerf ? (
                      Array.from({ length: 4 }).map((_, i) => (
                        <tr key={i}>
                          {Array.from({ length: 7 }).map((__, j) => (
                            <td key={j} className="px-3 py-3">
                              <Skeleton className={cn('h-3.5', j === 0 ? 'w-40' : 'ml-auto w-10')} />
                            </td>
                          ))}
                        </tr>
                      ))
                    ) : (perf?.by_event || []).length === 0 ? (
                      <tr>
                        <td colSpan={7} className="px-4 py-10 text-center">
                          <Bell className="mx-auto h-5 w-5 text-muted-foreground/60" aria-hidden="true" />
                          <p className="mt-2 text-xs font-semibold text-foreground">No notification events</p>
                          <p className="mt-0.5 text-[11px] text-muted-foreground">
                            Nothing matches the selected filters — widen the dates or clear the event key.
                          </p>
                        </td>
                      </tr>
                    ) : (
                      perf?.by_event.map((ev) => (
                        <tr key={ev.event_key} className="transition-colors hover:bg-muted/30">
                          <td className="px-4 py-3">
                            <div className="font-semibold text-foreground">{ev.event_key}</div>
                            <span className="text-[10px] font-normal text-muted-foreground">
                              {getActedLabel(ev.event_key)}
                            </span>
                          </td>
                          <td className="px-3 py-3 text-right tabular-nums">{ev.sent?.toLocaleString('en-US')}</td>
                          <td className="px-3 py-3 text-right font-medium tabular-nums text-success">
                            {ev.delivered?.toLocaleString('en-US')}
                          </td>
                          <td className="px-3 py-3 text-right font-medium tabular-nums text-destructive">
                            {ev.failed?.toLocaleString('en-US')}
                          </td>
                          <td className="px-3 py-3 text-right tabular-nums text-muted-foreground">
                            {ev.suppressed?.toLocaleString('en-US')}
                          </td>
                          <td className="px-3 py-3 text-right font-medium tabular-nums">
                            {ev.unique_tenants?.toLocaleString('en-US')}
                          </td>
                          <td className="px-4 py-3 text-right font-semibold tabular-nums">
                            <span className="text-foreground">{ev.acted?.toLocaleString('en-US')}</span>
                            <span className="ml-1 font-normal text-muted-foreground">
                              ({Math.round(ev.conversion_rate_pct ?? 0)}%)
                            </span>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>

              <p className="text-[11px] italic text-muted-foreground">
                Note: sequence ≠ causation. "Sent → later acted" tracks whether a tenant completed the specified milestone after receiving the notification.
              </p>
            </>
          )}
        </CardContent>
      </Card>

      {/* CARD 5 — Channel breakdown (SMS vs push vs in-app) */}
      <Card className="rounded-2xl border-border/60 shadow-sm">
        <CardHeader className="px-4 py-4 pb-3">
          <CardTitle className="flex items-center gap-2 text-sm font-bold">
            <span className="rounded-xl bg-primary/10 p-1.5 text-primary">
              <Radio className="h-4 w-4" aria-hidden="true" />
            </span>
            Channel Breakdown (SMS vs Push vs In-App)
          </CardTitle>
          <CardDescription className="text-xs">
            Delivery metrics grouped by event. Channels are shown side by side and never summed to prevent duplicate counting.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 p-4 pt-0">
          {channelsQuery.isError ? (
            <CardError message={(channelsQuery.error as Error)?.message ?? 'Could not load channel performance.'} />
          ) : loadingChannels ? (
            <div className="space-y-3">
              {Array.from({ length: 2 }).map((_, i) => (
                <div key={i} className="rounded-2xl border border-border/60 bg-muted/20 p-4">
                  <Skeleton className="h-4 w-44" />
                  <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
                    {Array.from({ length: 3 }).map((__, j) => (
                      <Skeleton key={j} className="h-24 rounded-xl" />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : Object.keys(channelGroups).length === 0 ? (
            <div className="rounded-2xl border border-dashed border-border/60 px-4 py-10 text-center">
              <Radio className="mx-auto h-5 w-5 text-muted-foreground/60" aria-hidden="true" />
              <p className="mt-2 text-xs font-semibold text-foreground">No channel rows</p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                No channel performance is available for the selected filters.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {Object.entries(channelGroups).map(([event_key, rows]) => (
                <div key={event_key} className="space-y-3 rounded-2xl border border-border/60 bg-muted/20 p-4">
                  <div className="flex items-center justify-between gap-2 border-b border-border/50 pb-2">
                    <h3 className="min-w-0 truncate text-sm font-bold text-foreground">{event_key}</h3>
                    <span className="shrink-0 rounded-full bg-muted px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                      {rows.length} channel{rows.length === 1 ? '' : 's'}
                    </span>
                  </div>

                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                    {rows.map((row) => {
                      const channelName =
                        row.channel === 'sms'
                          ? 'SMS'
                          : row.channel === 'push'
                          ? 'Push Notification'
                          : 'In-App Message';

                      const ChannelIcon =
                        row.channel === 'sms'
                          ? MessageSquare
                          : row.channel === 'push'
                          ? Bell
                          : Radio;

                      return (
                        <div
                          key={row.channel}
                          className="space-y-2 rounded-xl border border-border/60 bg-card p-3 shadow-sm"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="flex min-w-0 items-center gap-1.5 text-xs font-bold text-foreground">
                              <ChannelIcon className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
                              <span className="truncate">{channelName}</span>
                            </span>
                            <Badge variant="outline" className="shrink-0 text-[10px] uppercase">
                              {row.channel}
                            </Badge>
                          </div>

                          <div className="grid grid-cols-2 gap-2 pt-0.5">
                            <div>
                              <span className="block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                                Sent/Created
                              </span>
                              <span className="text-sm font-bold tabular-nums text-foreground">
                                {row.sent?.toLocaleString('en-US') ?? 0}
                              </span>
                            </div>
                            <div>
                              <span className="block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                                Delivered
                              </span>
                              <span className="text-sm font-bold tabular-nums text-success">
                                {row.delivered?.toLocaleString('en-US') ?? 0}
                              </span>
                            </div>
                            <div>
                              <span className="block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                                Failed
                              </span>
                              <span className="text-sm font-bold tabular-nums text-destructive">
                                {row.failed?.toLocaleString('en-US') ?? 0}
                              </span>
                            </div>
                            <div>
                              <span className="block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                                Opened/Acted
                              </span>
                              <span className="text-sm font-bold tabular-nums text-primary">
                                {row.opened_or_acted?.toLocaleString('en-US') ?? 0}
                              </span>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );

  if (embedded) return body;

  return (
    <>
      <Helmet>
        <title>Tenant Smartphone & Notification Analytics | Welile Ops</title>
      </Helmet>

      <div className="mx-auto min-h-screen max-w-7xl bg-background p-4 text-foreground sm:p-6">{body}</div>
    </>
  );
}
