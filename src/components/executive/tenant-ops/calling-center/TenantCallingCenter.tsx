/**
 * Tenant Calling Center — Tenant Ops → Classic.
 *
 * Deliberately a *sibling* of the Tenant Calling Hub, not a replacement:
 *  - the workflow data (queue, states, outcomes, notes, follow-ups, tickets) is
 *    the same `cc_*` spine, read through the same unmodified `useCcCallingHub`
 *    hook, so both surfaces always agree;
 *  - the calling capability is the CRM Calling Centre's browser voice stack,
 *    reused through `useTenantCallCenterDialer`;
 *  - nothing under `src/components/ops/calling/*` is changed. The shared
 *    `RecordOutcomeDialog` is reused as-is for engaged / callback outcomes.
 */
import { useEffect, useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  AlertTriangle,
  CalendarClock,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  Eye,
  Headphones,
  History,
  PhoneIncoming,
  LayoutDashboard,
  ListChecks,
  Pause,
  Phone,
  PhoneCall,
  PhoneOutgoing,
  Play,
  Search,
  Settings2,
  SlidersHorizontal,
  Square,
} from 'lucide-react';
import { KPICard } from '../../KPICard';
import { useCcCallingHub, type CcFilterSelection, type CcRow } from '@/hooks/useCcCallingHub';
import { CALLING_TABS, type CallingTabKey, type CallingColumnKey } from '@/components/ops/calling/callingHubColumns';
import { CallingHubTable } from '@/components/ops/calling/CallingHubTable';
import { RecordOutcomeDialog } from '@/components/ops/calling/RecordOutcomeDialog';
import { CallingFilterBar } from '@/components/ops/calling/CallingFilterBar';
import { FollowupsDuePanel } from '@/components/ops/calling/FollowupsDuePanel';
import { OpenAttemptQueue } from '@/components/ops/calling/OpenAttemptQueue';
import { LiveCallPanel } from './LiveCallPanel';
import { TenantCallCenterHistory } from './TenantCallCenterHistory';
import { TenantCallsReport } from './TenantCallsReport';
import { WeeklyStaffForwardingReport } from './WeeklyStaffForwardingReport';

import { ReceivedCallsTab } from './ReceivedCallsTab';
import { ConcernsReviewTab } from './ConcernsReviewTab';

import { TenantCallDetailsDialog } from './TenantCallDetailsDialog';
import {
  AUTO_CAP_CHOICES,
  DEFAULT_AUTO_CAP,
  useTenantCallCenterDialer,
} from './useTenantCallCenterDialer';

type CenterTab = 'overview' | 'queue' | 'live' | 'received' | 'concerns' | 'history' | 'settings';

const AUTO_LABEL: Record<string, string> = {
  off: 'Idle',
  running: 'Running',
  paused: 'Paused',
  awaiting_outcome: 'Waiting for outcome',
  finished: 'Run finished',
};

/** Presentation-only: the Center's primary action opens the tenant details modal. */
const CALL_ACTION_LABELS = {
  compact: 'Open',
  full: 'Open',
  compactOpen: 'Open',
  fullOpen: 'Open tenant details',
  title: 'Open tenant details and call',
};

/**
 * Declutter: the Center's list carries only what is needed to pick the next
 * tenant. Everything else about that tenant lives in the details modal.
 */
const CENTER_COLUMNS = new Set<CallingColumnKey>([
  'name',
  'phone',
  'metric',
  'attempts',
  'callback_due',
  'feedback_category',
  'park_reason',
  'actions',
]);

/** Tenant Ops palette per queue state — colour only, order unchanged. */
const TAB_ACCENT: Record<string, string> = {
  to_call: 'bg-primary/10 text-primary',
  in_progress: 'bg-amber-500/10 text-amber-600',
  callback: 'bg-sky-500/10 text-sky-600',
  parked: 'bg-muted text-muted-foreground',
  done: 'bg-emerald-500/10 text-emerald-600',
};
const TAB_ICON: Record<string, typeof Phone> = {
  to_call: PhoneOutgoing,
  in_progress: PhoneCall,
  callback: CalendarClock,
  parked: AlertTriangle,
  done: ListChecks,
};



export function TenantCallingCenter() {
  const [tab, setTab] = useState<CenterTab>('overview');
  const [queueState, setQueueState] = useState<CallingTabKey>('to_call');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [filters, setFilters] = useState<CcFilterSelection>({});
  const [autoCap, setAutoCap] = useState(DEFAULT_AUTO_CAP);
  const [formAttempt, setFormAttempt] = useState<{ id: string; cycle_row_id: string; name: string } | null>(null);
  /** Tenant chosen from the list — details first, calling from inside the modal. */
  const [detailsRow, setDetailsRow] = useState<CcRow | null>(null);
  const [showFilters, setShowFilters] = useState(false);
  /** Second heavy History read is opt-in, so visiting the tab costs one query. */
  const [fullHistoryOpen, setFullHistoryOpen] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 350);
    return () => clearTimeout(t);
  }, [search]);

  const filtersKey = useMemo(
    () =>
      Object.entries(filters)
        .filter(([, v]) => v)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
        .join('&'),
    [filters],
  );
  useEffect(() => setPage(0), [queueState, debouncedSearch, sortKey, filtersKey]);

  const hub = useCcCallingHub('tenant', {
    state: queueState,
    sortKey,
    search: debouncedSearch,
    page,
    filters,
  });
  const dialer = useTenantCallCenterDialer(hub);
  const { auto } = dialer;

  /**
   * A searched tenant must be findable whatever status they are sitting in.
   * The queue can only list one status at a time, so when the selected status
   * holds no match but another one does, move to the status that actually has
   * the tenant. Nothing about the row, its status or its history changes — this
   * is navigation only.
   */
  useEffect(() => {
    if (!debouncedSearch.trim()) return;
    if ((hub.counts[queueState] ?? 0) > 0) return;
    const hit = CALLING_TABS.find((t) => (hub.counts[t.key] ?? 0) > 0);
    if (hit && hit.key !== queueState) setQueueState(hit.key);
  }, [debouncedSearch, hub.counts, queueState]);

  /** Where else the current search matches, so nothing looks missing. */
  const otherMatches = useMemo(
    () =>
      debouncedSearch.trim()
        ? CALLING_TABS.filter((t) => t.key !== queueState && (hub.counts[t.key] ?? 0) > 0)
        : [],
    [debouncedSearch, hub.counts, queueState],
  );

  /** A live or settling call always belongs on the Live Call page. */
  useEffect(() => {
    if (dialer.current && (dialer.live || dialer.needsOutcome)) setTab('live');
  }, [dialer.current, dialer.live, dialer.needsOutcome]);

  const metricLabel = hub.rows[0]?.metric_label ?? 'Metric';
  const activeQueueTab = CALLING_TABS.find((t) => t.key === queueState) ?? CALLING_TABS[0];
  /**
   * The shared column contract is unchanged. The Engaged tab carries no action
   * column of its own, so the Center appends its own "Open details" control —
   * presentation only, no phone column and no change to the queue's data.
   */
  const leanColumns = useMemo(() => {
    const cols = activeQueueTab.columns.filter((c) => CENTER_COLUMNS.has(c));
    return cols.includes('actions') ? cols : [...cols, 'actions' as CallingColumnKey];
  }, [activeQueueTab]);
  const actionLabels = useMemo(
    () =>
      activeQueueTab.columns.includes('actions')
        ? CALL_ACTION_LABELS
        : {
            compact: 'Details',
            full: 'View details',
            compactOpen: 'Details',
            fullOpen: 'View details',
            title: 'View call details and recorded feedback',
          },
    [activeQueueTab],
  );

  /**
   * Background refresh without flicker: while a refetch is in flight the list
   * keeps showing what it already had, so the officer never loses their place.
   */
  const [stableRows, setStableRows] = useState<CcRow[]>([]);
  useEffect(() => {
    if (!hub.isLoading) setStableRows(hub.rows);
  }, [hub.isLoading, hub.rows]);
  const displayRows = hub.isLoading && stableRows.length ? stableRows : hub.rows;

  /** The list only opens details; the call itself starts inside the modal. */
  const openDetails = (row: CcRow) => setDetailsRow(row);
  const callFromDetails = (row: CcRow) => {
    setDetailsRow(null);
    void dialer.dial(row);
  };

  /**
   * Same shape the Hub feeds its table: the row currently on the line keeps its
   * revealed number visible until the outcome is recorded.
   */
  const revealedPhones = useMemo<Record<string, string | null>>(
    () =>
      dialer.current && (dialer.live || dialer.needsOutcome)
        ? { [dialer.current.rowId]: dialer.current.phone }
        : {},
    [dialer.current, dialer.live, dialer.needsOutcome],
  );
  const runBadge = (
    <Badge
      variant={auto.mode === 'running' ? 'default' : 'outline'}
      className={
        auto.mode === 'running'
          ? 'gap-1.5 text-[11px] font-semibold'
          : auto.mode === 'paused' || auto.mode === 'awaiting_outcome'
            ? 'gap-1.5 border-amber-500/40 bg-amber-500/10 text-[11px] font-semibold text-amber-700'
            : 'gap-1.5 text-[11px] font-semibold'
      }
    >
      <span
        className={
          auto.mode === 'running'
            ? 'h-1.5 w-1.5 animate-pulse rounded-full bg-primary-foreground'
            : 'h-1.5 w-1.5 rounded-full bg-muted-foreground'
        }
        aria-hidden
      />
      {AUTO_LABEL[auto.mode]}
      {auto.mode !== 'off' && auto.total > 0 ? ` · ${Math.min(auto.index, auto.total)}/${auto.total}` : ''}
    </Badge>
  );

  const autoControls = (
    <div className="flex flex-wrap items-center gap-1.5">
      <Select value={String(autoCap)} onValueChange={(v) => setAutoCap(Number(v))} disabled={auto.mode === 'running'}>
        <SelectTrigger className="h-9 w-[120px] text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {AUTO_CAP_CHOICES.map((c) => (
            <SelectItem key={c} value={String(c)} className="text-xs">
              {c} calls
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {auto.mode === 'running' ? (
        <Button size="sm" variant="outline" className="h-9 text-xs font-semibold" onClick={auto.pauseAuto}>
          <Pause className="mr-1.5 h-3.5 w-3.5" />
          Pause
        </Button>
      ) : auto.mode === 'paused' || auto.mode === 'awaiting_outcome' ? (
        <Button
          size="sm"
          className="h-9 text-xs font-semibold"
          onClick={auto.resumeAuto}
          disabled={dialer.needsOutcome}
        >
          <Play className="mr-1.5 h-3.5 w-3.5" />
          Resume
        </Button>
      ) : (
        <Button
          size="sm"
          className="h-9 text-xs font-semibold"
          onClick={() => auto.startAuto(hub.rows, autoCap)}
          disabled={!hub.rows.length || hub.wipBlocked}
        >
          <Play className="mr-1.5 h-3.5 w-3.5" />
          Start sequential run
        </Button>
      )}
      {auto.mode !== 'off' && (
        <Button size="sm" variant="outline" className="h-9 text-xs font-semibold" onClick={auto.stopAuto}>
          <Square className="mr-1.5 h-3.5 w-3.5" />
          Stop
        </Button>
      )}
    </div>
  );


  return (
    <div className="space-y-4 pb-32 sm:pb-28">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-border bg-gradient-to-r from-primary/10 via-primary/5 to-transparent p-3 sm:p-4">
        <div className="flex min-w-0 items-center gap-3">
          <div className="rounded-xl bg-primary/15 p-2 text-primary">
            <Headphones className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <h2 className="text-sm font-bold sm:text-base">Tenant Calling Center</h2>
            <p className="text-[11px] leading-snug text-muted-foreground">
              Same tenants, statuses and history as the Calling Hub, with attended sequential dialling.
            </p>
          </div>
        </div>
        {runBadge}
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as CenterTab)}>
        {/* Same tab chrome as the Calling Hub: wrap, never truncate. */}
        <TabsList className="flex h-auto w-full flex-wrap justify-start gap-1.5 rounded-xl border border-border bg-muted/30 p-1.5">
          {([
            ['overview', 'Overview', LayoutDashboard],
            ['queue', 'Work Queue', ListChecks],
            ['live', 'Live Call', PhoneCall],
            ['received', 'Received Calls', PhoneIncoming],
            ['concerns', 'Issues Review', ClipboardList],
            ['history', 'History', History],
            ['settings', 'Settings', Settings2],
          ] as [CenterTab, string, typeof Phone][]).map(([key, label, Icon]) => (
            <TabsTrigger
              key={key}
              value={key}
              className="h-9 shrink-0 gap-1.5 whitespace-nowrap rounded-lg px-2.5 text-xs font-semibold data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-sm"
            >
              <Icon className="h-3.5 w-3.5" />
              {label}
              {key === 'queue' && (
                <Badge
                  variant="secondary"
                  className="px-1.5 py-0 text-[10px] data-[state=active]:bg-primary-foreground/20"
                >
                  {hub.counts[queueState]}
                </Badge>
              )}
            </TabsTrigger>
          ))}
        </TabsList>

        {/* ------------------------------------------------------ Overview */}
        <TabsContent value="overview" className="mt-4 space-y-3">
          <div className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-5">
            {CALLING_TABS.map((t) => (
              <KPICard
                key={t.key}
                title={t.label}
                value={hub.totalCounts[t.key]}
                icon={TAB_ICON[t.key] ?? Phone}
                color={TAB_ACCENT[t.key] ?? 'bg-primary/10 text-primary'}
                onClick={() => {
                  setQueueState(t.key);
                  setTab('queue');
                }}
              />
            ))}
          </div>

          <p className="px-1 text-[11px] text-muted-foreground">
            Whole roster: {Object.values(hub.totalCounts).reduce((a, b) => a + b, 0).toLocaleString()} tenants in this
            calling round. Tap a card to work that status.
          </p>

          <Card className="overflow-hidden">
            <CardContent className="flex flex-wrap items-center justify-between gap-3 p-3 sm:p-4">
              <div className="flex min-w-0 items-center gap-3">
                <div className="rounded-xl bg-emerald-500/10 p-2 text-emerald-600">
                  <PhoneOutgoing className="h-4 w-4" />
                </div>
                <div className="min-w-0">
                  <p className="text-xs font-bold">
                    {hub.cycle ? `Cycle #${hub.cycle.cycle_no}` : 'No open calling cycle'}
                  </p>
                  <p className="text-[11px] leading-snug text-muted-foreground">
                    {hub.cycle
                      ? `Open attempts ${hub.openCount}${hub.wipLimit != null ? ` of ${hub.wipLimit}` : ''} · retry after ${hub.cycle.retry_after_days} days`
                      : 'Open a cycle from the Calling Hub cycle controls to start working the roster.'}
                  </p>
                </div>
              </div>
              <Button size="sm" className="h-9 text-xs" onClick={() => setTab('queue')}>
                Go to work queue
                <ChevronRight className="ml-1 h-3.5 w-3.5" />
              </Button>
            </CardContent>
          </Card>

          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <OpenAttemptQueue hub={hub} onOpenForm={setFormAttempt} />
            <FollowupsDuePanel hub={hub} />
          </div>
        </TabsContent>


        {/* --------------------------------------------------- Work Queue */}
        <TabsContent value="queue" className="mt-4 space-y-3">
          <div className="rounded-xl border border-border bg-muted/30 p-3">
            <div className="flex flex-wrap items-end gap-2">
              <div className="space-y-1">
                <Label className="text-[11px] font-semibold text-muted-foreground">Status</Label>
                <Select value={queueState} onValueChange={(v) => setQueueState(v as CallingTabKey)}>
                  <SelectTrigger className="h-9 w-full text-xs sm:w-[160px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CALLING_TABS.map((t) => (
                      <SelectItem key={t.key} value={t.key} className="text-xs">
                        {t.label} ({hub.counts[t.key]})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="text-[11px] font-semibold text-muted-foreground">Sort by</Label>
                <Select value={hub.effectiveSortKey ?? ''} onValueChange={setSortKey}>
                  <SelectTrigger className="h-9 w-full text-xs sm:w-[180px]">
                    <SelectValue placeholder="Default order" />
                  </SelectTrigger>
                  <SelectContent>
                    {hub.sortOptions.map((o) => (
                      <SelectItem key={o.key} value={o.key} className="text-xs">
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="min-w-[200px] flex-1 space-y-1">
                <Label className="text-[11px] font-semibold text-muted-foreground">Search</Label>
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search name or district"
                    className="h-9 w-full pl-9 text-xs"
                  />
                </div>
              </div>
              <div className="ml-auto space-y-1">
                <Label className="text-[11px] font-semibold text-muted-foreground">Sequential run</Label>
                {autoControls}
              </div>
            </div>

            <div className="mt-3 border-t border-border/60 pt-3">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-8 gap-1.5 px-2 text-[11px] font-semibold text-muted-foreground"
                onClick={() => setShowFilters((v) => !v)}
                aria-expanded={showFilters}
              >
                <SlidersHorizontal className="h-3.5 w-3.5 text-primary" />
                {showFilters ? 'Hide filters' : 'Filters'}
                {Object.keys(filters).length > 0 && (
                  <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
                    {Object.keys(filters).length}
                  </Badge>
                )}
              </Button>
              {showFilters && (
                <div className="mt-2">
                  <CallingFilterBar
                    options={hub.filterOptions}
                    loading={hub.filterOptionsLoading}
                    error={hub.filterOptionsError}
                    selection={filters}
                    filteredTotal={hub.total}
                    onChange={(key, value) =>
                      setFilters((prev) => {
                        const next = { ...prev };
                        if (value) next[key] = value;
                        else delete next[key];
                        return next;
                      })
                    }
                    onClearAll={() => setFilters({})}
                  />
                </div>
              )}
            </div>
          </div>


          {otherMatches.length > 0 && (
            <p className="rounded-lg border border-sky-500/30 bg-sky-500/10 px-2.5 py-2 text-[11px] font-semibold text-sky-700">
              Also matching “{debouncedSearch.trim()}” under{' '}
              {otherMatches.map((t) => `${t.label} (${hub.counts[t.key]})`).join(', ')} — switch Status to see them.
            </p>
          )}

          {hub.wipBlocked && (
            <p className="flex items-start gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-[11px] font-semibold text-amber-700">
              <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
              You are at the open-attempt limit. Record the outcome of your open calls before starting another.
            </p>
          )}

          <Card className="min-w-0 overflow-hidden">
            <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 border-b bg-muted/30 p-3">
              <CardTitle className="flex items-center gap-2 text-xs font-bold">
                <ListChecks className="h-4 w-4 text-primary" />
                {activeQueueTab.label}
              </CardTitle>
              <div className="flex items-center gap-1.5">
                {hub.isLoading && stableRows.length > 0 && (
                  <span className="text-[10px] font-medium text-muted-foreground">Updating…</span>
                )}
                <Badge variant="outline" className="text-[10px]">
                  {hub.total.toLocaleString()} rows
                </Badge>
                {hub.cycle && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 px-2 text-[10px]"
                    disabled={hub.syncQueue.isPending}
                    onClick={() => hub.syncQueue.mutate()}
                    title="Add tenants who became eligible after this cycle was opened"
                  >
                    {hub.syncQueue.isPending
                      ? 'Syncing…'
                      : hub.syncQueue.isSuccess
                        ? `Synced · ${hub.syncQueue.data ?? 0} added`
                        : 'Sync queue'}
                  </Button>
                )}
              </div>

            </CardHeader>
            <CardContent className="min-w-0 overflow-x-auto p-2 sm:p-3">
              {hub.error && (
                <p className="mb-2 flex items-start gap-1.5 rounded-lg border border-destructive/30 bg-destructive/10 px-2.5 py-2 text-xs font-semibold text-destructive">
                  <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
                  {hub.error}
                </p>
              )}
              {!hub.cycle ? (
                <div className="p-6 text-center">
                  <PhoneOutgoing className="mx-auto h-5 w-5 text-muted-foreground" />
                  <p className="mt-2 text-xs text-muted-foreground">No open calling cycle for tenants.</p>
                </div>
              ) : hub.isLoading && !displayRows.length ? (
                <div className="space-y-2">
                  <Skeleton className="h-8 w-full" />
                  <Skeleton className="h-8 w-full" />
                  <Skeleton className="h-8 w-full" />
                  <Skeleton className="h-8 w-2/3" />
                </div>
              ) : (
                /* The Hub's own table renderer, same columns contract, same look.
                   The action opens the tenant details modal; the call starts there. */
                <CallingHubTable
                  columns={leanColumns}
                  rows={displayRows}
                  metricLabel={metricLabel}
                  revealed={revealedPhones}
                  revealing={dialer.starting || hub.reveal.isPending}
                  /* Opening a finished (engaged) call is a read — the open-attempt
                     limit only guards revealing a new number to dial. */
                  wipBlocked={queueState === 'engaged' ? false : hub.wipBlocked}
                  onReveal={openDetails}
                  actionLabels={actionLabels}
                  actionIcon={queueState === 'engaged' ? Eye : Phone}
                />
              )}



              {hub.total > hub.pageSize && (
                <div className="mt-3 flex items-center justify-between border-t border-border/60 pt-2 text-[11px] font-medium text-muted-foreground">
                  <span className="tabular-nums">
                    {hub.pageFrom}–{hub.pageTo} of {hub.total.toLocaleString()}
                  </span>
                  <div className="flex gap-1">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-8 px-2.5"
                      disabled={page === 0}
                      onClick={() => setPage((p) => Math.max(0, p - 1))}
                      aria-label="Previous page"
                    >
                      <ChevronLeft className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-8 px-2.5"
                      disabled={hub.pageTo >= hub.total}
                      onClick={() => setPage((p) => p + 1)}
                      aria-label="Next page"
                    >
                      <ChevronRight className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ----------------------------------------------------- Live Call */}
        <TabsContent value="live" className="mt-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-muted/30 p-2.5">
            {runBadge}
            {autoControls}
          </div>
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
            <div className="lg:col-span-2">
              <LiveCallPanel hub={hub} dialer={dialer} onOpenForm={setFormAttempt} />
            </div>
            <div className="space-y-3">
              <OpenAttemptQueue hub={hub} onOpenForm={setFormAttempt} />
              <FollowupsDuePanel hub={hub} />
            </div>
          </div>
        </TabsContent>

        {/* ------------------------------------------------ Received Calls */}
        <TabsContent value="received" className="mt-4">
          <ReceivedCallsTab />
        </TabsContent>

        {/* ------------------------------------------------- Issues Review */}
        <TabsContent value="concerns" className="mt-4">
          <ConcernsReviewTab />
        </TabsContent>

        {/* ------------------------------------------------------- History */}
        <TabsContent value="history" className="mt-4 space-y-4">
          {/* The dated report is the primary read. The long rolling list is a
              second heavy read over the same spine, so it is fetched only when
              the officer actually asks for it instead of on every tab visit. */}
          <TenantCallsReport />
          {/* Additive, read-only weekly (Wed → Tue) staff forwarding report.
              Reads the same authoritative forwarding record the Combined Report
              reads; no existing report or filter is affected. */}
          <WeeklyStaffForwardingReport />

          {fullHistoryOpen ? (
            <TenantCallCenterHistory />
          ) : (
            <Button
              variant="outline"
              size="sm"
              className="h-9 text-xs font-semibold"
              onClick={() => setFullHistoryOpen(true)}
            >
              <History className="mr-1.5 h-3.5 w-3.5" />
              Show full rolling call history
            </Button>
          )}
        </TabsContent>



        {/* ------------------------------------------------------ Settings */}
        <TabsContent value="settings" className="mt-4 space-y-3">
          <Card className="overflow-hidden">
            <CardHeader className="border-b bg-muted/30 p-3">
              <CardTitle className="flex items-center gap-2 text-xs font-bold">
                <Settings2 className="h-4 w-4 text-primary" />
                Calling configuration
              </CardTitle>
            </CardHeader>
            <CardContent className="p-3 sm:p-4">
              <dl className="grid grid-cols-2 gap-2 text-[11px] lg:grid-cols-4">
                {[
                  ['Open cycle', hub.cycle ? `#${hub.cycle.cycle_no}` : 'None'],
                  ['Open-attempt limit', hub.wipLimit != null ? String(hub.wipLimit) : 'Set by ops'],
                  ['Retry window', hub.cycle ? `${hub.cycle.retry_after_days} days` : '—'],
                  ['Sequential run cap', `${autoCap} calls`],
                  ['Default sort', hub.sortOptions.find((o) => o.key === hub.defaultSortKey)?.label ?? '—'],
                  ['Filters available', String(hub.filterOptions.length)],
                  ['Outcome categories', String(hub.categories.length)],
                  ['Transport', 'Browser voice (headset)'],
                ].map(([k, v]) => (
                  <div key={k} className="rounded-xl border border-border/60 bg-muted/40 p-2.5">
                    <dt className="text-muted-foreground">{k}</dt>
                    <dd className="mt-0.5 text-xs font-bold">{v}</dd>
                  </div>
                ))}
              </dl>
              <p className="mt-3 text-[11px] leading-snug text-muted-foreground">
                Cycles, populations, filters, limits and outcome categories are owned by the calling
                spine and are changed from the Calling Hub cycle controls — the Calling Center reads
                exactly the same configuration so both surfaces stay consistent.
              </p>
            </CardContent>
          </Card>
        </TabsContent>

      </Tabs>

      <TenantCallDetailsDialog
        hub={hub}
        row={detailsRow}
        open={!!detailsRow}
        starting={dialer.starting || hub.reveal.isPending}
        /* A finished tenant (engaged/closed/etc.) can be called again from here.
           Duplicate/concurrent protection is unchanged: the reveal path reuses any
           open attempt and the dialer refuses while a call is starting. */
        canCall={!!detailsRow}
        wipBlocked={hub.wipBlocked}
        onCall={callFromDetails}
        onClose={() => setDetailsRow(null)}
      />

      <RecordOutcomeDialog
        hub={hub}
        attempt={formAttempt}
        onClose={() => setFormAttempt(null)}
      />
    </div>
  );
}
