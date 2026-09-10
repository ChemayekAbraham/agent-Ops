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
import { UgDistrictSelect, type UgDistrictValue } from '@/components/location/UgDistrictSelect';
import {
  Smartphone,
  Phone,
  HelpCircle,
  Users,
  CheckCircle2,
  Bell,
  MessageSquare,
  Radio,
  Calendar,
  Filter,
  RefreshCw,
  TrendingUp,
  AlertTriangle,
  ArrowRight,
  ShieldAlert,
} from 'lucide-react';
import { cn } from '@/lib/utils';

export default function TenantNotificationAnalyticsPage() {
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

  return (
    <>
      <Helmet>
        <title>Tenant Smartphone & Notification Analytics | Welile Ops</title>
      </Helmet>

      <div className="min-h-screen bg-background text-foreground p-4 sm:p-6 max-w-7xl mx-auto space-y-6">
        {/* Page Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-border/60 pb-5">
          <div>
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="text-[11px] font-semibold text-primary border-primary/30">
                Tenant Ops
              </Badge>
              <h1 className="text-2xl font-bold tracking-tight">Smartphone & Notification Analytics</h1>
            </div>
            <p className="text-xs sm:text-sm text-muted-foreground mt-1">
              Device segmentation, dashboard adoption, and multi-channel notification performance for tenant Rent Plans.
            </p>
          </div>

          <Button
            variant="outline"
            size="sm"
            onClick={handleRefresh}
            disabled={overviewQuery.isFetching || perfQuery.isFetching || channelsQuery.isFetching}
            className="h-9 gap-2 shrink-0 self-start sm:self-auto"
          >
            <RefreshCw
              className={cn(
                'h-3.5 w-3.5',
                (overviewQuery.isFetching || perfQuery.isFetching || channelsQuery.isFetching) &&
                  'animate-spin',
              )}
            />
            Refresh Data
          </Button>
        </div>

        {/* Server-Supported Filters Toolbar */}
        <Card className="rounded-xl border border-border/70 shadow-sm bg-card/60 backdrop-blur-sm">
          <CardHeader className="py-3 px-4 pb-2">
            <CardTitle className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-2">
              <Filter className="h-3.5 w-3.5" />
              Supported Filters
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-1 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
            <div>
              <Label className="text-[11px] text-muted-foreground">Start Date</Label>
              <Input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="h-9 text-xs mt-1"
              />
            </div>
            <div>
              <Label className="text-[11px] text-muted-foreground">End Date</Label>
              <Input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="h-9 text-xs mt-1"
              />
            </div>
            <div>
              <div className="flex items-center justify-between">
                <Label className="text-[11px] text-muted-foreground">District (overview & perf)</Label>
                {districtValue && (
                  <button
                    type="button"
                    onClick={() => setDistrictValue(null)}
                    className="text-[10px] text-muted-foreground hover:text-foreground underline"
                  >
                    Clear
                  </button>
                )}
              </div>
              <UgDistrictSelect
                value={districtValue}
                onChange={setDistrictValue}
                placeholder="All districts"
                className="[&>label]:hidden [&_button]:h-9 [&_button]:text-xs mt-1"
              />
            </div>
            <div>
              <Label className="text-[11px] text-muted-foreground">Agent ID (overview only)</Label>
              <Input
                placeholder="Agent UUID"
                value={agentId}
                onChange={(e) => setAgentId(e.target.value)}
                className="h-9 text-xs mt-1"
              />
            </div>
            <div>
              <Label className="text-[11px] text-muted-foreground">Event Key (perf & channels)</Label>
              <Input
                placeholder="e.g. PAYMENT_MISSED"
                value={eventKey}
                onChange={(e) => setEventKey(e.target.value)}
                className="h-9 text-xs mt-1"
              />
            </div>
          </CardContent>
        </Card>

        {/* Top 3 Overview Cards */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
          {/* CARD 1 — Device access */}
          <Card className="rounded-xl border border-border/70 shadow-sm flex flex-col">
            <CardHeader className="py-4 px-5 pb-2">
              <CardTitle className="text-base font-semibold flex items-center gap-2">
                <Smartphone className="h-4 w-4 text-primary" />
                Device Access
              </CardTitle>
              <CardDescription className="text-xs">
                Smartphone vs feature phone segmentation across active tenants
              </CardDescription>
            </CardHeader>
            <CardContent className="p-5 pt-2 flex-1 flex flex-col justify-between space-y-4">
              <div className="flex items-baseline justify-between border-b border-border/40 pb-3">
                <span className="text-xs text-muted-foreground">Total Active Tenants</span>
                <span className="text-2xl font-bold text-foreground">
                  {overview?.active_tenants?.toLocaleString() ?? '—'}
                </span>
              </div>

              <div className="space-y-2.5 text-xs">
                <div className="flex items-center justify-between p-2.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
                  <div className="flex items-center gap-2">
                    <Smartphone className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                    <span className="font-medium text-emerald-800 dark:text-emerald-300">
                      Confirmed Smartphone
                    </span>
                  </div>
                  <span className="font-bold text-emerald-700 dark:text-emerald-400">
                    {overview?.device.confirmed_smartphone?.toLocaleString() ?? 0}
                  </span>
                </div>

                <div className="flex items-center justify-between p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/20">
                  <div className="flex items-center gap-2">
                    <Phone className="h-4 w-4 text-amber-600 dark:text-amber-400" />
                    <span className="font-medium text-amber-800 dark:text-amber-300">
                      Confirmed Feature Phone
                    </span>
                  </div>
                  <span className="font-bold text-amber-700 dark:text-amber-400">
                    {overview?.device.confirmed_feature_phone?.toLocaleString() ?? 0}
                  </span>
                </div>

                <div className="flex items-center justify-between p-2.5 rounded-lg bg-muted/60 border border-border/50">
                  <div className="flex items-center gap-2">
                    <HelpCircle className="h-4 w-4 text-muted-foreground" />
                    <span className="font-medium text-muted-foreground">Device Unknown</span>
                  </div>
                  <span className="font-bold text-foreground">
                    {overview?.device.unknown?.toLocaleString() ?? 0}
                  </span>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* CARD 2 — Dashboard adoption */}
          <Card className="rounded-xl border border-border/70 shadow-sm flex flex-col">
            <CardHeader className="py-4 px-5 pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base font-semibold flex items-center gap-2">
                  <TrendingUp className="h-4 w-4 text-primary" />
                  Dashboard Adoption
                </CardTitle>
                <Badge variant="secondary" className="font-bold text-sm text-primary bg-primary/10">
                  {overview?.dashboard?.activation_rate_pct != null
                    ? `${Math.round(overview.dashboard.activation_rate_pct)}%`
                    : '—'}
                </Badge>
              </div>
              <CardDescription className="text-xs">
                Portal engagement among tenants with active Rent Plans
              </CardDescription>
            </CardHeader>
            <CardContent className="p-5 pt-2 flex-1 space-y-4">
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="p-2.5 rounded-lg bg-muted/40 border border-border/40">
                  <span className="text-muted-foreground block text-[11px]">Activated</span>
                  <span className="text-base font-bold text-foreground mt-0.5 block">
                    {overview?.dashboard.activated?.toLocaleString() ?? 0}
                  </span>
                </div>
                <div className="p-2.5 rounded-lg bg-muted/40 border border-border/40">
                  <span className="text-muted-foreground block text-[11px]">Never Activated</span>
                  <span className="text-base font-bold text-foreground mt-0.5 block">
                    {overview?.dashboard.never_activated?.toLocaleString() ?? 0}
                  </span>
                </div>
                <div className="p-2.5 rounded-lg bg-muted/40 border border-border/40">
                  <span className="text-muted-foreground block text-[11px]">Smartphone & Activated</span>
                  <span className="text-base font-bold text-emerald-600 dark:text-emerald-400 mt-0.5 block">
                    {overview?.dashboard.smartphone_and_activated?.toLocaleString() ?? 0}
                  </span>
                </div>
                <div className="p-2.5 rounded-lg bg-muted/40 border border-border/40">
                  <span className="text-muted-foreground block text-[11px]">Smartphone Not Activated</span>
                  <span className="text-base font-bold text-amber-600 dark:text-amber-400 mt-0.5 block">
                    {overview?.dashboard.smartphone_not_activated?.toLocaleString() ?? 0}
                  </span>
                </div>
              </div>

              <div className="border-t border-border/40 pt-3 grid grid-cols-4 gap-2 text-center text-xs">
                <div>
                  <span className="text-[10px] text-muted-foreground block">Opened 1x</span>
                  <span className="font-semibold text-foreground">
                    {overview?.dashboard.opened_once?.toLocaleString() ?? 0}
                  </span>
                </div>
                <div>
                  <span className="text-[10px] text-muted-foreground block">Opened 2+</span>
                  <span className="font-semibold text-foreground">
                    {overview?.dashboard.opened_2_plus?.toLocaleString() ?? 0}
                  </span>
                </div>
                <div>
                  <span className="text-[10px] text-muted-foreground block">Last 7d</span>
                  <span className="font-semibold text-primary">
                    {overview?.dashboard.opened_last_7d?.toLocaleString() ?? 0}
                  </span>
                </div>
                <div>
                  <span className="text-[10px] text-muted-foreground block">Last 30d</span>
                  <span className="font-semibold text-primary">
                    {overview?.dashboard.opened_last_30d?.toLocaleString() ?? 0}
                  </span>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* CARD 3 — How is the Unknown population being resolved */}
          <Card className="rounded-xl border border-border/70 shadow-sm flex flex-col">
            <CardHeader className="py-4 px-5 pb-2">
              <CardTitle className="text-base font-semibold flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-primary" />
                Unknown Resolution Sources
              </CardTitle>
              <CardDescription className="text-xs">
                Channels identifying device capability across the tenant base
              </CardDescription>
            </CardHeader>
            <CardContent className="p-5 pt-2 flex-1 flex flex-col justify-between space-y-2 text-xs">
              <div className="space-y-1.5">
                <div className="flex justify-between py-1.5 border-b border-border/30">
                  <span className="text-muted-foreground">Onboarding Registration</span>
                  <span className="font-semibold">{overview?.source.onboarding?.toLocaleString() ?? 0}</span>
                </div>
                <div className="flex justify-between py-1.5 border-b border-border/30">
                  <span className="text-muted-foreground">Call Centre Confirmation</span>
                  <span className="font-semibold">{overview?.source.call_centre?.toLocaleString() ?? 0}</span>
                </div>
                <div className="flex justify-between py-1.5 border-b border-border/30">
                  <span className="text-muted-foreground">Dashboard Link Access</span>
                  <span className="font-semibold">{overview?.source.dashboard_access?.toLocaleString() ?? 0}</span>
                </div>
                <div className="flex justify-between py-1.5 border-b border-border/30">
                  <span className="text-muted-foreground">Field Agent</span>
                  <span className="font-semibold">{overview?.source.agent?.toLocaleString() ?? 0}</span>
                </div>
                <div className="flex justify-between py-1.5 border-b border-border/30">
                  <span className="text-muted-foreground">System Detection</span>
                  <span className="font-semibold">{overview?.source.system_detection?.toLocaleString() ?? 0}</span>
                </div>
              </div>

              <div className="flex items-center justify-between p-2.5 rounded-lg bg-muted/60 border border-border/60 mt-2">
                <div>
                  <span className="font-medium text-foreground block">Still Unresolved</span>
                  <span className="text-[11px] text-muted-foreground">Pending discovery or verification</span>
                </div>
                <span className="text-base font-bold text-destructive">
                  {overview?.source.unresolved?.toLocaleString() ?? 0}
                </span>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* CARD 4 — SMS/notification performance */}
        <Card className="rounded-xl border border-border/70 shadow-sm">
          <CardHeader className="py-4 px-5 pb-3">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div>
                <CardTitle className="text-base font-semibold flex items-center gap-2">
                  <MessageSquare className="h-4 w-4 text-primary" />
                  SMS & Notification Performance
                </CardTitle>
                <CardDescription className="text-xs">
                  Aggregate delivery and action rates from {startDate} to {endDate}
                </CardDescription>
              </div>

              {perf?.totals && (
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className="text-xs font-semibold">
                    Unique Tenants: {perf.totals.unique_tenants?.toLocaleString() ?? 0}
                  </Badge>
                  <Badge variant="secondary" className="text-xs font-bold bg-primary/10 text-primary">
                    Sent → Later Acted: {Math.round(perf.totals.conversion_rate_pct ?? 0)}%
                  </Badge>
                </div>
              )}
            </div>
          </CardHeader>
          <CardContent className="p-5 pt-0 space-y-4">
            {/* Totals Summary Strip */}
            {perf?.totals && (
              <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-2 text-xs">
                <div className="p-3 rounded-lg bg-muted/40 border border-border/40">
                  <span className="text-muted-foreground block text-[11px]">Total Sent</span>
                  <span className="text-base font-bold text-foreground mt-0.5 block">
                    {perf.totals.sent?.toLocaleString() ?? 0}
                  </span>
                </div>
                <div className="p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
                  <span className="text-emerald-700 dark:text-emerald-400 block text-[11px]">Delivered</span>
                  <span className="text-base font-bold text-emerald-700 dark:text-emerald-400 mt-0.5 block">
                    {perf.totals.delivered?.toLocaleString() ?? 0}
                  </span>
                </div>
                <div className="p-3 rounded-lg bg-destructive/10 border border-destructive/20">
                  <span className="text-destructive block text-[11px]">Failed</span>
                  <span className="text-base font-bold text-destructive mt-0.5 block">
                    {perf.totals.failed?.toLocaleString() ?? 0}
                  </span>
                </div>
                <div className="p-3 rounded-lg bg-muted/40 border border-border/40">
                  <span className="text-muted-foreground block text-[11px]">Suppressed</span>
                  <span className="text-base font-bold text-foreground mt-0.5 block">
                    {perf.totals.suppressed?.toLocaleString() ?? 0}
                  </span>
                </div>
                <div className="p-3 rounded-lg bg-primary/10 border border-primary/20">
                  <span className="text-primary block text-[11px]">Later Acted</span>
                  <span className="text-base font-bold text-primary mt-0.5 block">
                    {perf.totals.acted?.toLocaleString() ?? 0}
                  </span>
                </div>
                <div className="p-3 rounded-lg bg-primary/10 border border-primary/20">
                  <span className="text-primary block text-[11px]">Action Rate</span>
                  <span className="text-base font-bold text-primary mt-0.5 block">
                    {Math.round(perf.totals.conversion_rate_pct ?? 0)}%
                  </span>
                </div>
              </div>
            )}

            {/* Per-event breakdown table */}
            <div className="overflow-x-auto border border-border/50 rounded-xl">
              <table className="w-full text-xs text-left">
                <thead className="bg-muted/60 text-muted-foreground uppercase text-[10px] tracking-wider border-b border-border/50">
                  <tr>
                    <th className="px-4 py-2.5">Event Key</th>
                    <th className="px-3 py-2.5 text-right">Sent</th>
                    <th className="px-3 py-2.5 text-right">Delivered</th>
                    <th className="px-3 py-2.5 text-right">Failed</th>
                    <th className="px-3 py-2.5 text-right">Suppressed</th>
                    <th className="px-3 py-2.5 text-right">Tenants</th>
                    <th className="px-4 py-2.5 text-right">Sent → Later Acted</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/40">
                  {(perf?.by_event || []).length === 0 ? (
                    <tr>
                      <td colSpan={7} className="text-center py-6 text-muted-foreground text-xs">
                        No notification event data matching the selected filters.
                      </td>
                    </tr>
                  ) : (
                    perf?.by_event.map((ev) => (
                      <tr key={ev.event_key} className="hover:bg-muted/30 transition-colors">
                        <td className="px-4 py-3 font-semibold text-foreground">
                          <div>{ev.event_key}</div>
                          <span className="text-[10px] text-muted-foreground font-normal">
                            {getActedLabel(ev.event_key)}
                          </span>
                        </td>
                        <td className="px-3 py-3 text-right">{ev.sent?.toLocaleString()}</td>
                        <td className="px-3 py-3 text-right text-emerald-600 dark:text-emerald-400">
                          {ev.delivered?.toLocaleString()}
                        </td>
                        <td className="px-3 py-3 text-right text-destructive">
                          {ev.failed?.toLocaleString()}
                        </td>
                        <td className="px-3 py-3 text-right text-muted-foreground">
                          {ev.suppressed?.toLocaleString()}
                        </td>
                        <td className="px-3 py-3 text-right font-medium">
                          {ev.unique_tenants?.toLocaleString()}
                        </td>
                        <td className="px-4 py-3 text-right font-semibold">
                          <span className="text-foreground">{ev.acted?.toLocaleString()}</span>
                          <span className="text-muted-foreground ml-1 font-normal">
                            ({Math.round(ev.conversion_rate_pct ?? 0)}%)
                          </span>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            <p className="text-[11px] text-muted-foreground italic">
              Note: sequence ≠ causation. "Sent → later acted" tracks whether a tenant completed the specified milestone after receiving the notification.
            </p>
          </CardContent>
        </Card>

        {/* CARD 5 — Channel breakdown (SMS vs push vs in-app) */}
        <Card className="rounded-xl border border-border/70 shadow-sm">
          <CardHeader className="py-4 px-5 pb-3">
            <CardTitle className="text-base font-semibold flex items-center gap-2">
              <Radio className="h-4 w-4 text-primary" />
              Channel Breakdown (SMS vs Push vs In-App)
            </CardTitle>
            <CardDescription className="text-xs">
              Delivery metrics grouped by event. Channels are shown side by side and never summed to prevent duplicate counting.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-5 pt-0 space-y-4">
            {Object.keys(channelGroups).length === 0 ? (
              <div className="text-center py-8 text-muted-foreground text-xs">
                No channel performance rows available for the selected filters.
              </div>
            ) : (
              <div className="space-y-4">
                {Object.entries(channelGroups).map(([event_key, rows]) => (
                  <div
                    key={event_key}
                    className="border border-border/60 rounded-xl p-4 bg-muted/20 space-y-3"
                  >
                    <div className="flex items-center justify-between border-b border-border/40 pb-2">
                      <h3 className="font-bold text-sm text-foreground">{event_key}</h3>
                      <span className="text-[11px] text-muted-foreground">
                        {rows.length} active channel{rows.length === 1 ? '' : 's'}
                      </span>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
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
                            className="p-3 rounded-lg bg-card border border-border/50 text-xs space-y-1.5 shadow-sm"
                          >
                            <div className="flex items-center justify-between">
                              <span className="font-semibold flex items-center gap-1.5 text-foreground">
                                <ChannelIcon className="h-3.5 w-3.5 text-primary" />
                                {channelName}
                              </span>
                              <Badge variant="outline" className="text-[10px] uppercase">
                                {row.channel}
                              </Badge>
                            </div>

                            <div className="grid grid-cols-2 gap-1 text-[11px] pt-1">
                              <div>
                                <span className="text-muted-foreground">Sent/Created:</span>{' '}
                                <span className="font-medium text-foreground">{row.sent?.toLocaleString() ?? 0}</span>
                              </div>
                              <div>
                                <span className="text-muted-foreground">Delivered:</span>{' '}
                                <span className="font-medium text-emerald-600 dark:text-emerald-400">
                                  {row.delivered?.toLocaleString() ?? 0}
                                </span>
                              </div>
                              <div>
                                <span className="text-muted-foreground">Failed:</span>{' '}
                                <span className="font-medium text-destructive">{row.failed?.toLocaleString() ?? 0}</span>
                              </div>
                              <div>
                                <span className="text-muted-foreground">Opened/Acted:</span>{' '}
                                <span className="font-medium text-primary">
                                  {row.opened_or_acted?.toLocaleString() ?? 0}
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
    </>
  );
}
