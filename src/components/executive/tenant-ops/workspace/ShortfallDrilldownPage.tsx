/**
 * Collection shortfall drill-down.
 *
 * Every figure comes from an RPC: the grouped tables from tops_shortfall_breakdown,
 * the header totals and the per-group Rent Plan list from tops_shortfall_detail.
 * The header's coverage % and the "expected minus collected" cross-check reuse the
 * exact calculation Tenant Ops Home already shows for the same range (from
 * useTenantOpsHomeRange), so the two pages cannot disagree about it.
 *
 * Layout follows NoPaymentTab: a desktop table with WorkspaceMobileRow stacked rows
 * below `lg`, so nothing scrolls sideways on a phone.
 */
import { useMemo, useState } from 'react';
import type { DateRange } from 'react-day-picker';
import { useSearchParams } from 'react-router-dom';
import { format, isValid, parseISO } from 'date-fns';
import { toast } from 'sonner';
import {
  AlertTriangle, ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Download, FileText, Gauge,
  Loader2, RefreshCw, Search, TrendingDown, Users,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { formatUGX } from '@/lib/rentCalculations';
import { downloadCsv } from '@/lib/csvExport';
import { KPICard } from '@/components/executive/KPICard';
import {
  OpsDateRangeFilter, PRESETS, rangePhrase, resolveRange, type PresetKey,
} from '@/components/executive/shared/OpsDateRangeFilter';
import { WorkspaceEmptyState } from '@/components/executive/tenant-ops/workspace/WorkspaceEmptyState';
import { WorkspaceMobileRow } from '@/components/executive/tenant-ops/workspace/WorkspaceMobileRow';
import { useTenantOpsHomeRange } from '@/hooks/useTenantOpsHomeRange';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import type { AreaLevel } from '@/hooks/tenantOpsWorkspace/useAreaBook';
import {
  useShortfallBreakdown, type ShortfallBreakdownRow, type ShortfallGroup,
} from '@/hooks/tenantOpsWorkspace/useShortfallBreakdown';
import {
  fetchAllShortfallDetail, useShortfallDetail, type ShortfallSortKey,
} from '@/hooks/tenantOpsWorkspace/useShortfallDetail';

const TAB_TRIGGER_CLASS =
  'h-9 shrink-0 whitespace-nowrap rounded-lg px-2.5 text-xs font-semibold data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-sm';

const PAGE_SIZE = 25;

const AREA_LEVELS: { value: AreaLevel; label: string }[] = [
  { value: 'region', label: 'Region' },
  { value: 'district', label: 'District' },
  { value: 'county', label: 'County' },
  { value: 'subcounty', label: 'Sub-county' },
  { value: 'parish', label: 'Parish' },
  { value: 'village', label: 'Village' },
];

const SORT_OPTIONS: { value: ShortfallSortKey; label: string }[] = [
  { value: 'short_ugx', label: 'Shortfall' },
  { value: 'expected_ugx', label: 'Expected' },
  { value: 'collected_ugx', label: 'Collected' },
  { value: 'days_behind', label: 'Days behind' },
  { value: 'oldest_unpaid_due', label: 'Oldest unpaid' },
  { value: 'last_paid_at', label: 'Last paid' },
  { value: 'tenant_name', label: 'Tenant' },
  { value: 'agent_name', label: 'Agent' },
];

const GROUP_LABEL: Record<ShortfallGroup, string> = {
  tenant: 'Tenant',
  agent: 'Agent',
  service_centre: 'Service centre',
  area: 'Area',
  ageing: 'Ageing',
};

const CSV_HEADERS = [
  'Plan code', 'Tenant', 'Tenant phone', 'Agent', 'Agent phone', 'Service centre', 'District',
  'Expected (UGX)', 'Collected (UGX)', 'Short (UGX)', 'Behind', 'Days behind', 'Cadence',
  'Oldest unpaid due', 'Last paid', 'Rent Plan ID',
];

const fmtDate = (iso: string | null) => (iso ? format(parseISO(iso), 'dd MMM yyyy') : '—');
const fmtDateTime = (iso: string | null) => (iso ? format(parseISO(iso), 'dd MMM yyyy, HH:mm') : '—');
const fmtDays = (n: number | null) => (n === null ? '—' : String(n));
const fmtAvg = (n: number | null) => (n === null ? '—' : n.toFixed(1));
const fmtPct = (n: number | null) => (n === null ? '—' : `${n.toFixed(1)}%`);

// The date range travels in the URL (sf_range, plus sf_from / sf_to for a custom
// range) so the Tenant Ops Home card can open this page on the same range it shows.
const RANGE_PARAMS = ['sf_range', 'sf_from', 'sf_to'] as const;

function readRange(params: URLSearchParams): { preset: PresetKey; custom?: DateRange } {
  const range = params.get('sf_range');
  if (range === 'custom') {
    const fromRaw = params.get('sf_from');
    const toRaw = params.get('sf_to');
    const from = fromRaw ? parseISO(fromRaw) : null;
    const to = toRaw ? parseISO(toRaw) : null;
    if (from && isValid(from)) return { preset: 'custom', custom: { from, to: to && isValid(to) ? to : from } };
  }
  if (range && PRESETS.some((p) => p.key === range && p.key !== 'custom')) return { preset: range as PresetKey };
  return { preset: 'today' };
}

interface SelectedGroup {
  group: ShortfallGroup;
  key: string;
  name: string;
  level: AreaLevel;
}

// ─── Grouped table (one per tab) ─────────────────────────────────────────────

function BreakdownTab({
  group, level, startIso, endIso, enabled, nameLabel, parentLabel, onSelect,
}: {
  group: ShortfallGroup;
  level: AreaLevel;
  startIso: string;
  endIso: string;
  enabled: boolean;
  nameLabel: string;
  parentLabel: string | null;
  onSelect: (row: ShortfallBreakdownRow) => void;
}) {
  const { data, isLoading, isError } = useShortfallBreakdown(
    { startIso, endIso, group, areaLevel: level },
    enabled,
  );

  if (isLoading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }
  if (isError) {
    return (
      <WorkspaceEmptyState
        icon={AlertTriangle}
        tone="destructive"
        title="Could not load the shortfall"
        hint="Check your connection and try again."
      />
    );
  }
  const rows = data ?? [];
  if (rows.length === 0) {
    return (
      <WorkspaceEmptyState
        icon={Users}
        title="No Rent Plans are short for this range"
        hint="Every Rent Plan billed in this range has been collected in full."
      />
    );
  }

  return (
    <>
      <div className="space-y-2 lg:hidden">
        {rows.map((r) => (
          <WorkspaceMobileRow
            key={r.group_key}
            title={r.group_name}
            badge={<span className="text-sm font-bold tabular-nums text-destructive">{formatUGX(r.short_ugx)}</span>}
            onClick={() => onSelect(r)}
            fields={[
              { label: 'Rent Plans', value: r.plan_count },
              { label: 'Short %', value: fmtPct(r.short_pct) },
              { label: 'Expected', value: formatUGX(r.expected_ugx) },
              { label: 'Collected', value: formatUGX(r.collected_ugx) },
              { label: 'Avg days behind', value: fmtAvg(r.avg_days_behind) },
              { label: 'Max days behind', value: fmtDays(r.max_days_behind) },
              ...(parentLabel && r.parent_name ? [{ label: parentLabel, value: r.parent_name, full: true }] : []),
            ]}
          />
        ))}
      </div>

      <div className="hidden overflow-auto rounded-lg border lg:block">
        <Table>
          <TableHeader className="bg-muted/50">
            <TableRow>
              <TableHead className="text-xs">{nameLabel}</TableHead>
              <TableHead className="text-right text-xs">Rent Plans</TableHead>
              <TableHead className="text-right text-xs">Expected</TableHead>
              <TableHead className="text-right text-xs">Collected</TableHead>
              <TableHead className="text-right text-xs">Short</TableHead>
              <TableHead className="text-right text-xs">Short %</TableHead>
              <TableHead className="text-right text-xs">Avg days behind</TableHead>
              <TableHead className="text-right text-xs">Max days behind</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow
                key={r.group_key}
                tabIndex={0}
                aria-label={`Open Rent Plans for ${r.group_name}`}
                className="cursor-pointer"
                onClick={() => onSelect(r)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSelect(r);
                  }
                }}
              >
                <TableCell className="text-xs font-medium">
                  <div>{r.group_name}</div>
                  {parentLabel && r.parent_name && (
                    <div className="text-[11px] font-normal text-muted-foreground">{r.parent_name}</div>
                  )}
                </TableCell>
                <TableCell className="text-right text-xs tabular-nums">{r.plan_count}</TableCell>
                <TableCell className="text-right text-xs tabular-nums">{formatUGX(r.expected_ugx)}</TableCell>
                <TableCell className="text-right text-xs tabular-nums">{formatUGX(r.collected_ugx)}</TableCell>
                <TableCell className="text-right text-xs font-semibold tabular-nums text-destructive">
                  {formatUGX(r.short_ugx)}
                </TableCell>
                <TableCell className="text-right text-xs tabular-nums">{fmtPct(r.short_pct)}</TableCell>
                <TableCell className="text-right text-xs tabular-nums">{fmtAvg(r.avg_days_behind)}</TableCell>
                <TableCell className="text-right text-xs tabular-nums">{fmtDays(r.max_days_behind)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </>
  );
}

// ─── Paged Rent Plan list for one group (inside the side sheet) ──────────────

function ShortfallDetailBody({
  selected, startIso, endIso,
}: {
  selected: SelectedGroup;
  startIso: string;
  endIso: string;
}) {
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search, 300);
  const [sort, setSort] = useState<ShortfallSortKey>('short_ugx');
  const [dir, setDir] = useState<'asc' | 'desc'>('desc');
  const [page, setPage] = useState(0);
  const [exporting, setExporting] = useState(false);

  const filters = {
    startIso,
    endIso,
    group: selected.group,
    groupKey: selected.key,
    areaLevel: selected.level,
    search: debouncedSearch,
    sort,
    dir,
  };
  const { data, isLoading, isError, isFetching } = useShortfallDetail({
    ...filters,
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
  });

  const totalCount = data?.totalCount ?? 0;
  const pageCount = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  const exportCsv = async () => {
    setExporting(true);
    try {
      const all = await fetchAllShortfallDetail(filters);
      if (all.rows.length === 0) {
        toast.error('Nothing to export for this selection');
        return;
      }
      const slug = selected.name.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'group';
      const stamp = `${format(parseISO(startIso), 'yyyyMMdd')}-${format(parseISO(endIso), 'yyyyMMdd')}`;
      downloadCsv(
        `Welile_Shortfall_${GROUP_LABEL[selected.group].replace(/\s+/g, '-')}_${slug}_${stamp}.csv`,
        CSV_HEADERS,
        all.rows.map((r) => [
          r.plan_code, r.tenant_name, r.tenant_phone, r.agent_name, r.agent_phone, r.service_centre,
          r.district, r.expected_ugx, r.collected_ugx, r.short_ugx, r.cadence_label, r.days_behind,
          r.cadence, r.oldest_unpaid_due, r.last_paid_at, r.rent_request_id,
        ]),
      );
      toast.success(
        `Exported ${all.rows.length.toLocaleString('en-US')} Rent Plans${all.truncated ? ' (the first 10,000 only)' : ''}`,
      );
    } catch (e) {
      toast.error((e as { message?: string })?.message || 'Could not export the Rent Plans');
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="mt-4 min-w-0 space-y-3">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(0);
          }}
          placeholder="Search tenant, agent or phone"
          aria-label="Search Rent Plans"
          className="pl-9"
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={sort}
          onValueChange={(v) => {
            setSort(v as ShortfallSortKey);
            setPage(0);
          }}
        >
          <SelectTrigger className="h-9 w-40 text-xs" aria-label="Sort by">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SORT_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value} className="text-xs">{o.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="h-9 w-9"
          aria-label={dir === 'desc' ? 'Sorted high to low. Switch to low to high' : 'Sorted low to high. Switch to high to low'}
          onClick={() => {
            setDir((d) => (d === 'desc' ? 'asc' : 'desc'));
            setPage(0);
          }}
        >
          {dir === 'desc' ? <ArrowDown className="h-4 w-4" /> : <ArrowUp className="h-4 w-4" />}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="ml-auto h-9 gap-1.5 text-xs"
          disabled={exporting || totalCount === 0}
          onClick={() => void exportCsv()}
        >
          {exporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
          Export CSV
        </Button>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
        </div>
      ) : isError ? (
        <WorkspaceEmptyState
          icon={AlertTriangle}
          tone="destructive"
          title="Could not load these Rent Plans"
          hint="Check your connection and try again."
        />
      ) : (data?.rows.length ?? 0) === 0 ? (
        <WorkspaceEmptyState
          icon={Search}
          title="No Rent Plans match"
          hint={debouncedSearch ? 'Try a different name or phone number.' : 'Nothing is short for this selection.'}
        />
      ) : (
        <div className={`space-y-2 ${isFetching ? 'opacity-70' : ''}`}>
          {data!.rows.map((r) => (
            <WorkspaceMobileRow
              key={r.rent_request_id}
              title={r.tenant_name ?? 'Unnamed tenant'}
              badge={<span className="text-sm font-bold tabular-nums text-destructive">{formatUGX(r.short_ugx)}</span>}
              fields={[
                { label: 'Rent Plan', value: r.plan_code },
                { label: 'Behind', value: r.cadence_label ?? '—' },
                { label: 'Expected', value: formatUGX(r.expected_ugx) },
                { label: 'Collected', value: formatUGX(r.collected_ugx) },
                { label: 'Tenant phone', value: r.tenant_phone ?? '—' },
                { label: 'District', value: r.district ?? '—' },
                {
                  label: 'Agent',
                  value: [r.agent_name, r.agent_phone].filter(Boolean).join(' · ') || '—',
                  full: true,
                },
                { label: 'Service centre', value: r.service_centre ?? '—', full: true },
                { label: 'Oldest unpaid due', value: fmtDate(r.oldest_unpaid_due) },
                { label: 'Last paid', value: fmtDateTime(r.last_paid_at) },
              ]}
            />
          ))}
        </div>
      )}

      {totalCount > 0 && (
        <div className="flex items-center justify-between gap-2 pt-1">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 gap-1 text-xs"
            disabled={page === 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
          >
            <ChevronLeft className="h-3.5 w-3.5" /> Previous
          </Button>
          <span className="text-center text-[11px] text-muted-foreground">
            Page {page + 1} of {pageCount} · {totalCount.toLocaleString('en-US')} Rent Plans
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 gap-1 text-xs"
            disabled={page + 1 >= pageCount}
            onClick={() => setPage((p) => p + 1)}
          >
            Next <ChevronRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}
    </div>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function ShortfallDrilldownPage() {
  const [params, setParams] = useSearchParams();
  const [initialRange] = useState(() => readRange(params));
  const [preset, setPreset] = useState<PresetKey>(initialRange.preset);
  const [custom, setCustom] = useState<DateRange | undefined>(initialRange.custom);
  const { start, end } = useMemo(() => resolveRange(preset, custom), [preset, custom]);

  // Keep the URL truthful when the range is changed here (replace, so Back still
  // leaves the page rather than stepping through every preset click).
  const writeRange = (nextPreset: PresetKey, nextCustom: DateRange | undefined) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      RANGE_PARAMS.forEach((k) => next.delete(k));
      next.set('sf_range', nextPreset);
      if (nextPreset === 'custom' && nextCustom?.from) {
        next.set('sf_from', format(nextCustom.from, 'yyyy-MM-dd'));
        next.set('sf_to', format(nextCustom.to ?? nextCustom.from, 'yyyy-MM-dd'));
      }
      return next;
    }, { replace: true });
  };
  const changePreset = (p: PresetKey) => {
    setPreset(p);
    writeRange(p, custom);
  };
  const changeCustom = (c: DateRange | undefined) => {
    setCustom(c);
    writeRange(preset, c);
  };
  const startIso = start.toISOString();
  const endIso = end.toISOString();
  const phrase = useMemo(() => rangePhrase(preset, start, end), [preset, start, end]);

  const [tab, setTab] = useState<ShortfallGroup>('tenant');
  const [areaLevel, setAreaLevel] = useState<AreaLevel>('district');
  const [selected, setSelected] = useState<SelectedGroup | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);

  // Header: same range as Tenant Ops Home, plus the shortfall totals straight from the RPC.
  const home = useTenantOpsHomeRange(startIso, endIso);
  const totals = useShortfallDetail({ startIso, endIso, limit: 1 });
  const tenants = useShortfallBreakdown({ startIso, endIso, group: 'tenant' });

  // Same two lines Tenant Ops Home uses for this range.
  const expected = home.data?.expected ?? 0;
  const collected = home.data?.collected ?? 0;
  const coverage = expected > 0 ? Math.min(100, Math.round((collected / expected) * 100)) : 0;

  const homeReady = !home.isPlaceholderData && !home.isFetching;
  const totalsReady = !!totals.data && !totals.isPlaceholderData && !totals.isFetching;
  const totalShort = totals.data?.totalShortUgx ?? 0;
  const gap = expected - collected;
  const figuresDiffer = homeReady && totalsReady && Math.round(gap) !== Math.round(totalShort);

  const open = (group: ShortfallGroup) => (row: ShortfallBreakdownRow) => {
    setSelected({ group, key: row.group_key, name: row.group_name, level: areaLevel });
    setSheetOpen(true);
  };

  return (
    <div className="min-w-0 space-y-4">
      <Card className="min-w-0 border-border/60">
        <CardHeader className="space-y-3 px-3 pb-3 sm:px-6">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <TrendingDown className="h-4 w-4 text-primary" />
              Collection shortfall
            </CardTitle>
            <CardDescription>
              Rent Plans behind their expected collections {phrase}. Select a row to see the Rent Plans behind it.
            </CardDescription>
          </div>
          <OpsDateRangeFilter
            preset={preset}
            custom={custom}
            onPresetChange={changePreset}
            onCustomChange={changeCustom}
          />
        </CardHeader>
        <CardContent className="min-w-0 space-y-3 px-3 sm:px-6">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <KPICard
              title="Total short"
              value={totals.data ? formatUGX(totalShort) : '—'}
              icon={TrendingDown}
              color="bg-destructive/10 text-destructive"
              loading={totals.isLoading}
              subtitle={home.isPlaceholderData ? undefined : `Expected ${formatUGX(expected)}`}
            />
            <KPICard
              title="Coverage"
              value={home.isPlaceholderData ? '—' : `${coverage}%`}
              icon={Gauge}
              color="bg-warning/10 text-warning"
              loading={home.isPlaceholderData}
              subtitle={home.isPlaceholderData ? undefined : `${formatUGX(collected)} collected`}
            />
            <KPICard
              title="Rent Plans short"
              value={totals.data ? totals.data.totalCount.toLocaleString('en-US') : '—'}
              icon={FileText}
              loading={totals.isLoading}
            />
            <KPICard
              title="Tenants short"
              value={tenants.data ? tenants.data.length.toLocaleString('en-US') : '—'}
              icon={Users}
              loading={tenants.isLoading}
            />
          </div>

          {figuresDiffer && (
            <div
              role="alert"
              className="flex flex-wrap items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-foreground"
            >
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
              <p className="min-w-0 flex-1">
                Expected minus collected ({formatUGX(gap)}) differs from the shortfall total ({formatUGX(totalShort)}).
                The two are read separately and can differ for a moment while collections land.
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 gap-1 text-xs"
                onClick={() => {
                  void home.refetch();
                  void totals.refetch();
                }}
              >
                <RefreshCw className="h-3 w-3" /> Refresh
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="min-w-0 border-border/60">
        <CardContent className="min-w-0 px-3 pt-4 sm:px-6">
          <Tabs value={tab} onValueChange={(v) => setTab(v as ShortfallGroup)}>
            <TabsList className="flex h-auto w-full flex-wrap justify-start gap-1.5 rounded-xl border border-border bg-muted/30 p-1.5">
              <TabsTrigger value="tenant" className={TAB_TRIGGER_CLASS}>Tenants</TabsTrigger>
              <TabsTrigger value="agent" className={TAB_TRIGGER_CLASS}>Agents</TabsTrigger>
              <TabsTrigger value="service_centre" className={TAB_TRIGGER_CLASS}>Service centres</TabsTrigger>
              <TabsTrigger value="area" className={TAB_TRIGGER_CLASS}>Districts</TabsTrigger>
              <TabsTrigger value="ageing" className={TAB_TRIGGER_CLASS}>Ageing</TabsTrigger>
            </TabsList>

            <TabsContent value="tenant" className="mt-3">
              <BreakdownTab
                group="tenant" level={areaLevel} startIso={startIso} endIso={endIso}
                enabled={tab === 'tenant'} nameLabel="Tenant" parentLabel="Phone" onSelect={open('tenant')}
              />
            </TabsContent>
            <TabsContent value="agent" className="mt-3">
              <BreakdownTab
                group="agent" level={areaLevel} startIso={startIso} endIso={endIso}
                enabled={tab === 'agent'} nameLabel="Agent" parentLabel={null} onSelect={open('agent')}
              />
            </TabsContent>
            <TabsContent value="service_centre" className="mt-3">
              <BreakdownTab
                group="service_centre" level={areaLevel} startIso={startIso} endIso={endIso}
                enabled={tab === 'service_centre'} nameLabel="Service centre" parentLabel={null}
                onSelect={open('service_centre')}
              />
            </TabsContent>
            <TabsContent value="area" className="mt-3 space-y-3">
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">Group by</span>
                <Select value={areaLevel} onValueChange={(v) => setAreaLevel(v as AreaLevel)}>
                  <SelectTrigger className="h-9 w-40 text-xs" aria-label="Area level">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {AREA_LEVELS.map((l) => (
                      <SelectItem key={l.value} value={l.value} className="text-xs">{l.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <BreakdownTab
                group="area" level={areaLevel} startIso={startIso} endIso={endIso}
                enabled={tab === 'area'}
                nameLabel={AREA_LEVELS.find((l) => l.value === areaLevel)?.label ?? 'Area'}
                parentLabel={areaLevel === 'region' ? null : 'Region'}
                onSelect={open('area')}
              />
            </TabsContent>
            <TabsContent value="ageing" className="mt-3">
              <BreakdownTab
                group="ageing" level={areaLevel} startIso={startIso} endIso={endIso}
                enabled={tab === 'ageing'} nameLabel="Days behind" parentLabel={null} onSelect={open('ageing')}
              />
            </TabsContent>
          </Tabs>

          <p className="mt-3 text-[11px] leading-snug text-muted-foreground">
            Days behind shows a dash until a Rent Plan has a confirmed repayment schedule. Daily Rent Plans are
            shown in days and weekly Rent Plans in weeks.
          </p>
        </CardContent>
      </Card>

      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-xl">
          {selected && (
            <>
              <SheetHeader>
                <SheetTitle className="break-words pr-6">{selected.name}</SheetTitle>
                <SheetDescription>
                  {GROUP_LABEL[selected.group]} · Rent Plans behind their expected collections {phrase}
                </SheetDescription>
              </SheetHeader>
              <ShortfallDetailBody
                key={`${selected.group}:${selected.key}:${selected.level}:${startIso}:${endIso}`}
                selected={selected}
                startIso={startIso}
                endIso={endIso}
              />
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
