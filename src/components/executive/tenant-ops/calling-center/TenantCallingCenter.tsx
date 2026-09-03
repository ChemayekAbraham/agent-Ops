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
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  ChevronLeft,
  ChevronRight,
  Headphones,
  Pause,
  Phone,
  Play,
  Settings2,
  Square,
} from 'lucide-react';
import { useCcCallingHub, type CcFilterSelection, type CcRow } from '@/hooks/useCcCallingHub';
import { CALLING_TABS, type CallingTabKey } from '@/components/ops/calling/callingHubColumns';
import { CallingHubTable } from '@/components/ops/calling/CallingHubTable';
import { RecordOutcomeDialog } from '@/components/ops/calling/RecordOutcomeDialog';
import { CallingFilterBar } from '@/components/ops/calling/CallingFilterBar';
import { FollowupsDuePanel } from '@/components/ops/calling/FollowupsDuePanel';
import { OpenAttemptQueue } from '@/components/ops/calling/OpenAttemptQueue';
import { LiveCallPanel } from './LiveCallPanel';
import { TenantCallCenterHistory } from './TenantCallCenterHistory';
import {
  AUTO_CAP_CHOICES,
  DEFAULT_AUTO_CAP,
  useTenantCallCenterDialer,
} from './useTenantCallCenterDialer';

type CenterTab = 'overview' | 'queue' | 'live' | 'history' | 'settings';

const AUTO_LABEL: Record<string, string> = {
  off: 'Idle',
  running: 'Running',
  paused: 'Paused',
  awaiting_outcome: 'Waiting for outcome',
  finished: 'Run finished',
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

  /** A live or settling call always belongs on the Live Call page. */
  useEffect(() => {
    if (dialer.current && (dialer.live || dialer.needsOutcome)) setTab('live');
  }, [dialer.current, dialer.live, dialer.needsOutcome]);

  const metricLabel = hub.rows[0]?.metric_label ?? 'Metric';
  const activeQueueTab = CALLING_TABS.find((t) => t.key === queueState) ?? CALLING_TABS[0];
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
    <Badge variant={auto.mode === 'running' ? 'default' : 'outline'} className="text-[10px]">
      {AUTO_LABEL[auto.mode]}
      {auto.mode !== 'off' && auto.total > 0 ? ` · ${Math.min(auto.index, auto.total)}/${auto.total}` : ''}
    </Badge>
  );

  const autoControls = (
    <div className="flex flex-wrap items-center gap-1.5">
      <Select value={String(autoCap)} onValueChange={(v) => setAutoCap(Number(v))} disabled={auto.mode === 'running'}>
        <SelectTrigger className="h-8 w-[120px] text-xs">
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
        <Button size="sm" variant="outline" className="h-8 text-xs" onClick={auto.pauseAuto}>
          <Pause className="mr-1 h-3 w-3" />
          Pause
        </Button>
      ) : auto.mode === 'paused' || auto.mode === 'awaiting_outcome' ? (
        <Button size="sm" className="h-8 text-xs" onClick={auto.resumeAuto} disabled={dialer.needsOutcome}>
          <Play className="mr-1 h-3 w-3" />
          Resume
        </Button>
      ) : (
        <Button
          size="sm"
          className="h-8 text-xs"
          onClick={() => auto.startAuto(hub.rows, autoCap)}
          disabled={!hub.rows.length || hub.wipBlocked}
        >
          <Play className="mr-1 h-3 w-3" />
          Start sequential run
        </Button>
      )}
      {auto.mode !== 'off' && (
        <Button size="sm" variant="outline" className="h-8 text-xs" onClick={auto.stopAuto}>
          <Square className="mr-1 h-3 w-3" />
          Stop
        </Button>
      )}
    </div>
  );

  return (
    <div className="space-y-3 pb-24">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-base font-bold">
          <Headphones className="h-4 w-4 text-primary" />
          Tenant Calling Center
        </h2>
        {runBadge}
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as CenterTab)}>
        <TabsList className="flex h-auto w-full flex-wrap justify-start gap-1 bg-transparent p-0">
          {([
            ['overview', 'Overview'],
            ['queue', 'Work Queue'],
            ['live', 'Live Call'],
            ['history', 'History'],
            ['settings', 'Settings'],
          ] as [CenterTab, string][]).map(([key, label]) => (
            <TabsTrigger
              key={key}
              value={key}
              className="h-8 shrink-0 px-2.5 text-xs data-[state=active]:bg-muted"
            >
              {label}
            </TabsTrigger>
          ))}
        </TabsList>

        {/* ------------------------------------------------------ Overview */}
        <TabsContent value="overview" className="mt-3 space-y-3">
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-5">
            {CALLING_TABS.map((t) => (
              <Card key={t.key} className="rounded-xl border-border/60 p-3">
                <p className="text-[11px] text-muted-foreground">{t.label}</p>
                <p className="text-lg font-bold tabular-nums">{hub.counts[t.key]}</p>
              </Card>
            ))}
          </div>

          <Card className="rounded-2xl border-border/60 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-xs font-bold">
                  {hub.cycle ? `Cycle #${hub.cycle.cycle_no}` : 'No open calling cycle'}
                </p>
                <p className="text-[11px] text-muted-foreground">
                  {hub.cycle
                    ? `Open attempts ${hub.openCount}${hub.wipLimit != null ? ` of ${hub.wipLimit}` : ''} · retry after ${hub.cycle.retry_after_days} days`
                    : 'Open a cycle from the Calling Hub cycle controls to start working the roster.'}
                </p>
              </div>
              <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => setTab('queue')}>
                Go to work queue
              </Button>
            </div>
          </Card>

          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <OpenAttemptQueue hub={hub} onOpenForm={setFormAttempt} />
            <FollowupsDuePanel hub={hub} />
          </div>
        </TabsContent>

        {/* --------------------------------------------------- Work Queue */}
        <TabsContent value="queue" className="mt-3 space-y-3">
          <Card className="rounded-2xl border-border/60 p-3">
            <div className="flex flex-wrap items-end gap-2">
              <div className="space-y-1">
                <Label className="text-[11px] text-muted-foreground">Status</Label>
                <Select value={queueState} onValueChange={(v) => setQueueState(v as CallingTabKey)}>
                  <SelectTrigger className="h-8 w-[150px] text-xs">
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
                <Label className="text-[11px] text-muted-foreground">Sort by</Label>
                <Select value={hub.effectiveSortKey ?? ''} onValueChange={setSortKey}>
                  <SelectTrigger className="h-8 w-[180px] text-xs">
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
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search name or district"
                className="h-8 w-full text-xs sm:max-w-[220px]"
              />
              <div className="ml-auto">{autoControls}</div>
            </div>

            <div className="mt-2 hidden lg:block">
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
          </Card>

          {hub.wipBlocked && (
            <p className="rounded-lg bg-muted px-2 py-1.5 text-[11px] text-muted-foreground">
              You are at the open-attempt limit. Record the outcome of your open calls before starting another.
            </p>
          )}

          <Card className="min-w-0 overflow-x-auto rounded-2xl border-border/60 p-2 sm:p-3">
            {hub.error && (
              <p className="mb-2 rounded-lg bg-destructive/10 px-2 py-1.5 text-xs font-semibold text-destructive">
                {hub.error}
              </p>
            )}
            {!hub.cycle ? (
              <p className="p-6 text-center text-xs text-muted-foreground">
                No open calling cycle for tenants.
              </p>
            ) : hub.isLoading ? (
              <div className="space-y-2">
                <Skeleton className="h-6 w-full" />
                <Skeleton className="h-6 w-full" />
                <Skeleton className="h-6 w-full" />
              </div>
            ) : (
              /* The Hub's own table renderer, same columns contract, same look.
                 "Reveal" here reveals *and* dials through the Center's dialer. */
              <CallingHubTable
                columns={activeQueueTab.columns}
                rows={hub.rows}
                metricLabel={metricLabel}
                revealed={revealedPhones}
                revealing={dialer.starting || hub.reveal.isPending}
                wipBlocked={hub.wipBlocked}
                onReveal={(row) => void dialer.dial(row)}
              />
            )}

            {hub.total > hub.pageSize && (
              <div className="mt-2 flex items-center justify-between text-[11px] text-muted-foreground">
                <span>
                  {hub.pageFrom}–{hub.pageTo} of {hub.total}
                </span>
                <div className="flex gap-1">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 px-2"
                    disabled={page === 0}
                    onClick={() => setPage((p) => Math.max(0, p - 1))}
                  >
                    <ChevronLeft className="h-3 w-3" />
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 px-2"
                    disabled={hub.pageTo >= hub.total}
                    onClick={() => setPage((p) => p + 1)}
                  >
                    <ChevronRight className="h-3 w-3" />
                  </Button>
                </div>
              </div>
            )}
          </Card>
        </TabsContent>

        {/* ----------------------------------------------------- Live Call */}
        <TabsContent value="live" className="mt-3 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
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

        {/* ------------------------------------------------------- History */}
        <TabsContent value="history" className="mt-3">
          <TenantCallCenterHistory />
        </TabsContent>

        {/* ------------------------------------------------------ Settings */}
        <TabsContent value="settings" className="mt-3 space-y-3">
          <Card className="rounded-2xl border-border/60 p-3">
            <p className="flex items-center gap-1.5 text-xs font-bold">
              <Settings2 className="h-3.5 w-3.5 text-primary" />
              Calling configuration
            </p>
            <dl className="mt-2 grid grid-cols-2 gap-2 text-[11px] lg:grid-cols-4">
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
                <div key={k} className="rounded-lg bg-muted/50 p-2">
                  <dt className="text-muted-foreground">{k}</dt>
                  <dd className="font-semibold">{v}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-2 text-[11px] leading-snug text-muted-foreground">
              Cycles, populations, filters, limits and outcome categories are owned by the calling
              spine and are changed from the Calling Hub cycle controls — the Calling Center reads
              exactly the same configuration so both surfaces stay consistent.
            </p>
          </Card>
        </TabsContent>
      </Tabs>

      <RecordOutcomeDialog
        hub={hub}
        attempt={formAttempt}
        onClose={() => setFormAttempt(null)}
      />
    </div>
  );
}
