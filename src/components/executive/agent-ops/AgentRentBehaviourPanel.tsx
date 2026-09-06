import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { format } from 'date-fns';
import {
  ChevronLeft,
  ChevronRight,
  Clock3,
  Download,
  Eye,
  FileText,
  AlertTriangle,
  Loader2,
  RefreshCw,
  Search,
  TrendingUp,
  Users,
  Wallet,
  X,
} from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Table,

  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

import { UserAvatar } from '@/components/UserAvatar';
import { downloadAuditPdf } from '@/lib/pdfAuditReport';
import { formatUGX } from '@/lib/rentCalculations';
import { CollectionsRhythmCharts } from '@/components/executive/agent-ops-v2/CollectionsRhythmCharts';

const PAGE_SIZE = 15;

type RentBehaviourKpis = {
  tenants_tracked: number;
  total_collected: number;
  on_time_rate: number;
  remaining_balance: number;
  collection_count: number;
  paid_today: number;
  paid_in_period: number;
  expected_today: number;
  expected_in_period: number;
  missed_days: number;
};


type RentBehaviourRow = {
  tenant_id: string;
  agent_id: string;
  tenant_name: string;
  tenant_avatar_url: string | null;
  tenant_phone: string | null;
  tenant_email: string | null;
  tenant_created_at: string | null;
  agent_name: string;
  agent_avatar_url: string | null;
  agent_phone: string | null;
  agent_email: string | null;
  last_collection_at: string | null;
  last_collection_amount: number;
  amount_collected: number;
  remaining_balance: number;
  total_to_collect: number;
  total_repaid: number;
  daily_expected: number;
  paid_today: number;
  paid_in_period: number;
  period_collection_count: number;
  expected_today: number;
  expected_in_period: number;
  missed_days: number;
  paid_days: number;
  collection_count: number;
  rent_request_count: number;
  agent_commission_total: number;
  on_time_count: number;
  gap_checked_count: number;
  collection_mode: 'Daily' | 'Weekly' | 'Monthly' | string;
  pays_in_time: boolean;
  on_time_rate: number;
  avg_gap_hours: number;
  avg_payment_hour: number;
  last_payment_method: string | null;
};

type RentBehaviourResponse = {
  limit: number;
  offset: number;
  total: number;
  from: string | null;
  to: string | null;
  days: number;
  kpis: RentBehaviourKpis;
  rows: RentBehaviourRow[];
};


type DetailCollection = {
  id: string;
  created_at: string;
  amount: number;
  payment_method: string | null;
  tracking_id: string | null;
  momo_transaction_id: string | null;
  rent_request_id: string | null;
  float_before: number;
  float_after: number;
  hours_since_previous: number | null;
  within_two_day_window: boolean;
};

type DetailRentRequest = {
  id: string;
  status: string | null;
  created_at: string | null;
  funded_at: string | null;
  rent_amount: number;
  daily_repayment: number;
  total_repayment: number;
  amount_repaid: number;
  remaining_balance: number;
  house_category: string | null;
  request_city: string | null;
  request_country: string | null;
};

type ProfileMeta = {
  id?: string;
  full_name?: string | null;
  phone?: string | null;
  email?: string | null;
  avatar_url?: string | null;
  created_at?: string | null;
  verified?: boolean | null;
  territory?: string | null;
  country?: string | null;
  region?: string | null;
  district?: string | null;
  city?: string | null;
  village?: string | null;
};

type RentBehaviourDetail = {
  tenant: ProfileMeta;
  agent: ProfileMeta;
  summary: {
    rent_request_count: number;
    total_to_collect: number;
    total_repaid: number;
    remaining_balance: number;
    daily_expected: number;
    collection_count: number;
    total_collected: number;
    agent_commission_total: number;
  };
  collections: DetailCollection[];
  rent_requests: DetailRentRequest[];
};

function num(value: unknown): number {
  return Number(value ?? 0) || 0;
}

function asRows(value: unknown): RentBehaviourResponse {
  const payload = (value ?? {}) as Partial<RentBehaviourResponse>;
  const kpis = (payload.kpis ?? {}) as Partial<RentBehaviourKpis>;
  return {
    limit: num(payload.limit),
    offset: num(payload.offset),
    total: num(payload.total),
    from: payload.from ?? null,
    to: payload.to ?? null,
    days: num(payload.days),
    kpis: {
      tenants_tracked: num(kpis.tenants_tracked),
      total_collected: num(kpis.total_collected),
      on_time_rate: num(kpis.on_time_rate),
      remaining_balance: num(kpis.remaining_balance),
      collection_count: num(kpis.collection_count),
      paid_today: num(kpis.paid_today),
      paid_in_period: num(kpis.paid_in_period),
      expected_today: num(kpis.expected_today),
      expected_in_period: num(kpis.expected_in_period),
      missed_days: num(kpis.missed_days),
    },
    rows: Array.isArray(payload.rows) ? payload.rows as RentBehaviourRow[] : [],

  };
}

function asDetail(value: unknown): RentBehaviourDetail {
  const payload = (value ?? {}) as Partial<RentBehaviourDetail>;
  const summary = (payload.summary ?? {}) as Partial<RentBehaviourDetail['summary']>;
  return {
    tenant: (payload.tenant ?? {}) as ProfileMeta,
    agent: (payload.agent ?? {}) as ProfileMeta,
    summary: {
      rent_request_count: num(summary.rent_request_count),
      total_to_collect: num(summary.total_to_collect),
      total_repaid: num(summary.total_repaid),
      remaining_balance: num(summary.remaining_balance),
      daily_expected: num(summary.daily_expected),
      collection_count: num(summary.collection_count),
      total_collected: num(summary.total_collected),
      agent_commission_total: num(summary.agent_commission_total),
    },
    collections: Array.isArray(payload.collections) ? payload.collections as DetailCollection[] : [],
    rent_requests: Array.isArray(payload.rent_requests) ? payload.rent_requests as DetailRentRequest[] : [],
  };
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return '—';
  try {
    return format(new Date(value), 'dd MMM yyyy · HH:mm');
  } catch {
    return '—';
  }
}

function formatHour(value: number) {
  const hour = Math.max(0, Math.min(23, Math.round(value || 0)));
  return `${String(hour).padStart(2, '0')}:00`;
}

function csvEscape(value: unknown) {
  const text = value == null ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function downloadCsv(filename: string, headers: string[], rows: (string | number | null | undefined)[][]) {
  const csv = [headers, ...rows].map((row) => row.map(csvEscape).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function exportRows(rows: RentBehaviourRow[]) {
  return rows.map((row) => [
    row.agent_name,
    row.agent_phone ?? '—',
    row.tenant_name,
    row.tenant_phone ?? '—',
    formatDateTime(row.last_collection_at),
    Math.round(num(row.last_collection_amount)),
    Math.round(num(row.paid_today)),
    Math.round(num(row.expected_today)),
    Math.round(num(row.paid_in_period)),
    Math.round(num(row.expected_in_period)),
    num(row.missed_days),
    num(row.paid_days),
    Math.round(num(row.amount_collected)),
    Math.round(num(row.remaining_balance)),
    row.collection_mode,
    row.collection_count,
    row.rent_request_count,
    Math.round(num(row.agent_commission_total)),
    `${num(row.on_time_rate)}%`,
    formatHour(num(row.avg_payment_hour)),
  ]);
}

const exportHeaders = [
  'Agent',
  'Agent Phone',
  'Tenant',
  'Tenant Phone',
  'Last Collection',
  'Last Amount (UGX)',
  'Paid Today (UGX)',
  'Expected Today (UGX)',
  'Paid In Period (UGX)',
  'Expected In Period (UGX)',
  'Days Missed',
  'Days Paid',
  'Total Collected (UGX)',
  'Remaining Balance (UGX)',
  'Collection Mode',
  'Collection Count',
  'Rent Requests',
  'Agent Commission (UGX)',
  'On-Time Rate',
  'Typical Payment Hour',
];


function modeVariant(mode: string) {
  if (mode === 'Daily') return 'success' as const;
  if (mode === 'Weekly') return 'warning' as const;
  return 'secondary' as const;
}

function KpiCard({ icon: Icon, label, value, hint }: { icon: typeof Users; label: string; value: string; hint: string }) {
  return (
    <Card className="p-4 min-h-[116px]">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1 min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
          <p className="text-2xl font-black tabular-nums text-foreground break-words">{value}</p>
        </div>
        <div className="h-10 w-10 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0">
          <Icon className="h-5 w-5" />
        </div>
      </div>
      <p className="mt-3 text-xs text-muted-foreground">{hint}</p>
    </Card>
  );
}

function MiniStat({ label, value, tone = 'default' }: { label: string; value: string; tone?: 'default' | 'success' | 'warning' }) {
  const toneClass =
    tone === 'success'
      ? 'text-success'
      : tone === 'warning'
        ? 'text-warning'
        : 'text-foreground';
  return (
    <div className="rounded-xl border border-border bg-card p-3">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={`mt-1 text-lg font-black tabular-nums break-words ${toneClass}`}>{value}</p>
    </div>
  );
}


function todayIso() {
  return format(new Date(), 'yyyy-MM-dd');
}

function isoDaysAgo(days: number) {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return format(date, 'yyyy-MM-dd');
}

type SortKey = 'recent' | 'missed' | 'paid_today' | 'remaining';

const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: 'recent', label: 'Most recent collection' },
  { value: 'missed', label: 'Most days missed' },
  { value: 'paid_today', label: 'Highest paid in period' },
  { value: 'remaining', label: 'Largest remaining balance' },
];

const RANGE_PRESETS: { label: string; days: number }[] = [
  { label: 'Today', days: 0 },
  { label: '7 days', days: 6 },
  { label: '30 days', days: 29 },
  { label: '90 days', days: 89 },
];

export function AgentRentBehaviourPanel() {
  const [page, setPage] = useState(0);
  const [data, setData] = useState<RentBehaviourResponse>(() => asRows(null));
  const [isLoading, setIsLoading] = useState(true);
  const [isFetching, setIsFetching] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<RentBehaviourRow | null>(null);
  const [detailTab, setDetailTab] = useState('overview');
  const [fromDate, setFromDate] = useState(() => todayIso());
  const [toDate, setToDate] = useState(() => todayIso());
  const [sortKey, setSortKey] = useState<SortKey>('recent');
  const [searchInput, setSearchInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => {
    const timer = setTimeout(() => setSearchQuery(searchInput.trim()), 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    if (!selected) return;
    const node = document.getElementById('rent-behaviour-drilldown');
    node?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [selected]);


  const offset = page * PAGE_SIZE;

  const loadRows = useCallback(async (nextOffset: number, range: { from: string; to: string; sort: SortKey; search: string }, silent = false) => {
    if (!silent) setIsLoading(true);
    setIsFetching(true);
    setLoadError(null);

    try {
      const { data: payload, error } = await supabase.rpc('get_agent_ops_rent_behaviour', {
        p_limit: PAGE_SIZE,
        p_offset: nextOffset,
        p_from: range.from,
        p_to: range.to,
        p_sort: range.sort,
        p_search: range.search || null,
      } as never);
      if (error) throw new Error(error.message);
      setData(asRows(payload));
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Rent behaviour failed to load.');
      setData(asRows(null));
    } finally {
      setIsLoading(false);
      setIsFetching(false);
    }
  }, []);

  useEffect(() => {
    void loadRows(offset, { from: fromDate, to: toDate, sort: sortKey, search: searchQuery });
  }, [loadRows, offset, fromDate, toDate, sortKey, searchQuery]);

  const refetch = () => loadRows(offset, { from: fromDate, to: toDate, sort: sortKey, search: searchQuery }, true);

  const applyPreset = (days: number) => {
    setPage(0);
    setFromDate(isoDaysAgo(days));
    setToDate(todayIso());
  };



  const detailQuery = useQuery({
    queryKey: ['agent-ops-rent-behaviour-detail', selected?.tenant_id, selected?.agent_id],
    enabled: Boolean(selected?.tenant_id && selected?.agent_id),
    queryFn: async () => {
      if (!selected) return asDetail(null);
      const { data: payload, error } = await supabase.rpc('get_agent_ops_rent_behaviour_detail', {
        p_tenant_id: selected.tenant_id,
        p_agent_id: selected.agent_id,
      });
      if (error) throw new Error(error.message);
      return asDetail(payload);
    },
    staleTime: 30_000,
  });

  const rows = data.rows;
  const totalPages = Math.max(1, Math.ceil(data.total / PAGE_SIZE));
  const canPrev = page > 0;
  const canNext = offset + PAGE_SIZE < data.total;
  const exportBody = useMemo(() => exportRows(rows), [rows]);

  const rangeLabel = `${fromDate} to ${toDate}`;
  const fileSlug = `${fromDate}_to_${toDate}`;

  const handleCsv = () => downloadCsv(`Welile_Rent-Behaviour_${fileSlug}_page-${page + 1}.csv`, exportHeaders, exportBody);

  const handlePdf = async () => {
    await downloadAuditPdf(
      `Welile_Rent-Behaviour_${fileSlug}_page-${page + 1}.pdf`,
      exportHeaders,
      exportBody,
      {
        title: 'Agent Ops Rent Behaviour',
        subtitle: 'Tenant repayment behaviour and two-day collection-gap monitoring',
        footerLabel: 'Welile · Agent Ops',
        filters: [
          `Period: ${rangeLabel}`,
          `Sort: ${SORT_OPTIONS.find((option) => option.value === sortKey)?.label ?? sortKey}`,
          `Page: ${page + 1} of ${totalPages}`,
          `Rows: ${rows.length} of ${data.total}`,
        ],
        kpis: [
          { label: 'Paid Today', value: formatUGX(data.kpis.paid_today), hint: `expected ${formatUGX(data.kpis.expected_today)}` },
          { label: 'Collected In Period', value: formatUGX(data.kpis.paid_in_period), hint: `expected ${formatUGX(data.kpis.expected_in_period)}` },
          { label: 'Days Missed', value: String(data.kpis.missed_days), hint: `${data.days} day window` },
          { label: 'Remaining Balance', value: formatUGX(data.kpis.remaining_balance), hint: 'still to collect' },
        ],
      },
    );
  };


  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
        <KpiCard icon={Wallet} label="Paid today" value={formatUGX(data.kpis.paid_today)} hint={`expected today ${formatUGX(data.kpis.expected_today)}`} />
        <KpiCard icon={TrendingUp} label="Collected in period" value={formatUGX(data.kpis.paid_in_period)} hint={`expected ${formatUGX(data.kpis.expected_in_period)}`} />
        <KpiCard icon={AlertTriangle} label="Days missed" value={data.kpis.missed_days.toLocaleString()} hint={`across ${data.days || 1} day window`} />
        <KpiCard icon={Users} label="Tenants tracked" value={data.kpis.tenants_tracked.toLocaleString()} hint={`${data.kpis.on_time_rate}% on time · ${formatUGX(data.kpis.remaining_balance)} left`} />
      </div>

      <Card className="p-3 sm:p-4 space-y-3">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <h3 className="text-sm font-bold text-foreground">Tenant repayment behaviour</h3>
            <p className="text-xs text-muted-foreground break-words">15 rows per fetch · {rangeLabel} · joined server-side.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
              {isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Refresh
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={handleCsv} disabled={rows.length === 0}>
              <Download className="h-4 w-4" />
              CSV
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={handlePdf} disabled={rows.length === 0}>
              <FileText className="h-4 w-4" />
              PDF
            </Button>
          </div>
        </div>

        <div className="flex flex-col gap-2 rounded-xl border border-border bg-muted/30 p-2 sm:p-3 xl:flex-row xl:items-end xl:justify-between">
          <div className="flex flex-wrap items-end gap-2">
            <div className="space-y-1">
              <label htmlFor="rent-behaviour-from" className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">From</label>
              <Input
                id="rent-behaviour-from"
                type="date"
                value={fromDate}
                max={toDate}
                onChange={(event) => { setPage(0); setFromDate(event.target.value || isoDaysAgo(29)); }}
                className="h-9 w-[9.5rem]"
              />
            </div>
            <div className="space-y-1">
              <label htmlFor="rent-behaviour-to" className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">To</label>
              <Input
                id="rent-behaviour-to"
                type="date"
                value={toDate}
                min={fromDate}
                max={todayIso()}
                onChange={(event) => { setPage(0); setToDate(event.target.value || todayIso()); }}
                className="h-9 w-[9.5rem]"
              />
            </div>
            <div className="flex flex-wrap items-center gap-1">
              {RANGE_PRESETS.map((preset) => (
                <Button
                  key={preset.label}
                  type="button"
                  size="sm"
                  variant={fromDate === isoDaysAgo(preset.days) && toDate === todayIso() ? 'default' : 'outline'}
                  className="h-9"
                  onClick={() => applyPreset(preset.days)}
                >
                  {preset.label}
                </Button>
              ))}
            </div>
          </div>
          <div className="space-y-1">
            <label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Sort by</label>
            <Select value={sortKey} onValueChange={(value) => { setPage(0); setSortKey(value as SortKey); }}>
              <SelectTrigger className="h-9 w-full xl:w-[15rem]">
                <SelectValue placeholder="Sort" />
              </SelectTrigger>
              <SelectContent>
                {SORT_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground pointer-events-none" />
          <Input
            type="text"
            placeholder="Search tenant or agent by name or phone"
            value={searchInput}
            onChange={(event) => { setPage(0); setSearchInput(event.target.value); }}
            className="h-10 pl-9 pr-9 w-full"
            aria-label="Search tenant or agent"
          />
          {searchInput && (
            <button
              type="button"
              onClick={() => { setPage(0); setSearchInput(''); }}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-1 text-muted-foreground hover:text-foreground hover:bg-muted"
              aria-label="Clear search"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>

        <CollectionsRhythmCharts from={fromDate} to={toDate} />




        {isLoading ? (
          <div className="h-64 flex items-center justify-center text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin mr-2" /> Loading rent behaviour
          </div>
        ) : loadError ? (
          <div className="min-h-64 flex flex-col items-center justify-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-center">
            <AlertTriangle className="h-6 w-6 text-destructive" />
            <div className="space-y-1">
              <p className="text-sm font-semibold text-foreground">Rent behaviour could not load.</p>
              <p className="text-xs text-muted-foreground">{loadError}</p>
            </div>
            <Button type="button" variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
              {isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Retry
            </Button>
          </div>
        ) : rows.length === 0 ? (
          <div className="h-64 flex items-center justify-center text-sm text-muted-foreground">No repayment behaviour rows found.</div>
        ) : (
          <>
            <div className="hidden md:block -mx-3 sm:mx-0 overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="whitespace-nowrap">Agent</TableHead>
                    <TableHead className="whitespace-nowrap">Tenant</TableHead>
                    <TableHead className="whitespace-nowrap">Last collection</TableHead>
                    <TableHead className="whitespace-nowrap">
                      <button type="button" className="font-semibold hover:text-primary" onClick={() => { setPage(0); setSortKey('paid_today'); }}>
                        Paid in period{sortKey === 'paid_today' ? ' ↓' : ''}
                      </button>
                    </TableHead>
                    <TableHead className="whitespace-nowrap">Expected in period</TableHead>
                    <TableHead className="whitespace-nowrap">
                      <button type="button" className="font-semibold hover:text-primary" onClick={() => { setPage(0); setSortKey('missed'); }}>
                        Days missed{sortKey === 'missed' ? ' ↓' : ''}
                      </button>
                    </TableHead>
                    <TableHead className="whitespace-nowrap">Collected</TableHead>
                    <TableHead className="whitespace-nowrap">
                      <button type="button" className="font-semibold hover:text-primary" onClick={() => { setPage(0); setSortKey('remaining'); }}>
                        Remaining{sortKey === 'remaining' ? ' ↓' : ''}
                      </button>
                    </TableHead>
                    <TableHead className="whitespace-nowrap">Mode</TableHead>
                    <TableHead className="text-right whitespace-nowrap">Open</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row) => (
                    <TableRow key={`${row.tenant_id}-${row.agent_id}`} className="cursor-pointer" onClick={() => setSelected(row)}>
                      <TableCell className="min-w-[200px]">
                        <div className="flex items-center gap-3">
                          <UserAvatar avatarUrl={row.agent_avatar_url} fullName={row.agent_name} size="md" />
                          <div className="min-w-0">
                            <p className="font-semibold text-foreground truncate">{row.agent_name}</p>
                            <p className="text-xs text-muted-foreground truncate">{row.agent_phone || 'No phone'}</p>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="min-w-[200px]">
                        <div className="flex items-center gap-3">
                          <UserAvatar avatarUrl={row.tenant_avatar_url} fullName={row.tenant_name} size="md" />
                          <div className="min-w-0">
                            <p className="font-semibold text-foreground truncate">{row.tenant_name}</p>
                            <p className="text-xs text-muted-foreground truncate">{row.tenant_phone || 'No phone'}</p>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="min-w-[150px]">
                        <p className="font-medium whitespace-nowrap">{formatDateTime(row.last_collection_at)}</p>
                        <p className="text-xs text-muted-foreground">typical {formatHour(row.avg_payment_hour)}</p>
                      </TableCell>
                      <TableCell className="min-w-[130px]">
                        <p className={`font-bold tabular-nums ${row.paid_in_period > 0 ? 'text-success' : 'text-muted-foreground'}`}>{formatUGX(row.paid_in_period)}</p>
                        <p className="text-xs text-muted-foreground whitespace-nowrap">today {formatUGX(row.paid_today)}</p>
                      </TableCell>
                      <TableCell className="min-w-[130px]">
                        <p className="font-bold tabular-nums">{formatUGX(row.expected_in_period)}</p>
                        <p className="text-xs text-muted-foreground whitespace-nowrap">today {formatUGX(row.expected_today)}</p>
                      </TableCell>
                      <TableCell className="min-w-[110px]">
                        <Badge variant={row.missed_days > 0 ? 'destructive' : 'success'}>{row.missed_days} missed</Badge>
                        <p className="mt-1 text-xs text-muted-foreground whitespace-nowrap">{row.paid_days} paid days</p>
                      </TableCell>
                      <TableCell className="min-w-[140px]">
                        <p className="font-bold tabular-nums">{formatUGX(row.amount_collected)}</p>
                        <p className="text-xs text-muted-foreground whitespace-nowrap">last {formatUGX(row.last_collection_amount)}</p>
                      </TableCell>
                      <TableCell className="min-w-[130px] font-bold tabular-nums">{formatUGX(row.remaining_balance)}</TableCell>
                      <TableCell>
                        <div className="space-y-1">
                          <Badge variant={modeVariant(row.collection_mode)}>{row.collection_mode}</Badge>
                          <p className="text-xs text-muted-foreground whitespace-nowrap">{row.on_time_rate}% on time</p>
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        <Button type="button" variant="ghost" size="icon" aria-label={`Open ${row.tenant_name}`} onClick={(event) => { event.stopPropagation(); setSelected(row); }}>
                          <Eye className="h-4 w-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            <div className="md:hidden space-y-2">
              {rows.map((row) => (
                <button
                  key={`m-${row.tenant_id}-${row.agent_id}`}
                  type="button"
                  onClick={() => setSelected(row)}
                  className="w-full rounded-xl border border-border bg-card p-3 text-left space-y-2"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <UserAvatar avatarUrl={row.tenant_avatar_url} fullName={row.tenant_name} size="sm" />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-bold text-foreground truncate">{row.tenant_name}</p>
                      <p className="text-[11px] text-muted-foreground truncate">{row.agent_name} · {row.agent_phone || 'No phone'}</p>
                    </div>
                    <Badge variant={row.missed_days > 0 ? 'destructive' : 'success'} className="shrink-0">{row.missed_days} missed</Badge>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Paid in period</p>
                      <p className={`text-sm font-bold tabular-nums ${row.paid_in_period > 0 ? 'text-success' : 'text-muted-foreground'}`}>{formatUGX(row.paid_in_period)}</p>
                      <p className="text-[11px] text-muted-foreground">today {formatUGX(row.paid_today)}</p>
                    </div>
                    <div>
                      <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Expected in period</p>
                      <p className="text-sm font-bold tabular-nums">{formatUGX(row.expected_in_period)}</p>
                      <p className="text-[11px] text-muted-foreground">today {formatUGX(row.expected_today)}</p>
                    </div>
                    <div>
                      <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Remaining</p>
                      <p className="text-sm font-bold tabular-nums">{formatUGX(row.remaining_balance)}</p>
                    </div>
                    <div>
                      <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Last collection</p>
                      <p className="text-xs font-medium">{formatDateTime(row.last_collection_at)}</p>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={modeVariant(row.collection_mode)}>{row.collection_mode}</Badge>
                    <span className="text-[11px] text-muted-foreground">{row.on_time_rate}% on time · {row.collection_count} collections</span>
                  </div>
                </button>
              ))}
            </div>
          </>
        )}


        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 pt-2">
          <p className="text-xs text-muted-foreground">
            Showing {data.total === 0 ? 0 : offset + 1}–{Math.min(offset + rows.length, data.total)} of {data.total}
          </p>
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" size="sm" disabled={!canPrev || isFetching} onClick={() => setPage((value) => Math.max(0, value - 1))}>
              <ChevronLeft className="h-4 w-4" />
              Prev
            </Button>
            <Badge variant="outline">Page {page + 1} / {totalPages}</Badge>
            <Button type="button" variant="outline" size="sm" disabled={!canNext || isFetching} onClick={() => setPage((value) => value + 1)}>
              Next
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </Card>

      {selected ? (
        <Card id="rent-behaviour-drilldown" className="overflow-hidden p-0">
          <div className="border-b border-border bg-gradient-to-br from-primary/10 via-card to-card px-4 py-4 sm:px-6 space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 className="text-base sm:text-lg font-black">Rent behaviour drilldown</h3>
                <p className="text-xs text-muted-foreground truncate">
                  {`${selected.tenant_name} · collected by ${selected.agent_name}`}
                </p>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Close drilldown"
                onClick={() => { setSelected(null); setDetailTab('overview'); }}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>

            <div className="flex items-center gap-3 rounded-xl border border-border bg-card/80 p-3 backdrop-blur">
              <UserAvatar avatarUrl={selected.tenant_avatar_url} fullName={selected.tenant_name} size="lg" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-bold truncate">{selected.tenant_name}</p>
                <p className="text-xs text-muted-foreground truncate">{selected.tenant_phone || 'No phone'}</p>
                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                  <Badge variant={modeVariant(selected.collection_mode)}>{selected.collection_mode}</Badge>
                  <Badge variant={selected.on_time_rate >= 60 ? 'success' : 'destructive'}>{selected.on_time_rate}% on time</Badge>
                  <Badge variant="outline">typical {formatHour(selected.avg_payment_hour)}</Badge>
                </div>
              </div>
              <div className="hidden sm:flex items-center gap-2 shrink-0">
                <UserAvatar avatarUrl={selected.agent_avatar_url} fullName={selected.agent_name} size="sm" />
                <div className="min-w-0">
                  <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Agent</p>
                  <p className="text-xs font-semibold truncate max-w-[140px]">{selected.agent_name}</p>
                </div>
              </div>
            </div>
          </div>

          <div className="max-h-[70vh] overflow-y-auto px-4 py-4 sm:px-6">

            {detailQuery.isLoading ? (
              <div className="h-64 flex items-center justify-center text-muted-foreground">
                <Loader2 className="h-5 w-5 animate-spin mr-2" /> Loading tenant statement
              </div>
            ) : detailQuery.isError ? (
              <div className="h-64 flex flex-col items-center justify-center gap-2 text-center text-muted-foreground">
                <AlertTriangle className="h-6 w-6 text-destructive" />
                <p className="text-sm font-semibold text-foreground">Tenant statement could not load.</p>
                <p className="text-xs">{detailQuery.error instanceof Error ? detailQuery.error.message : 'Refresh and try again.'}</p>
              </div>
            ) : (
              <Tabs value={detailTab} onValueChange={setDetailTab} className="space-y-4">
                <TabsList className="w-full grid grid-cols-4">
                  <TabsTrigger value="overview">Overview</TabsTrigger>
                  <TabsTrigger value="collections">Collections</TabsTrigger>
                  <TabsTrigger value="requests">Requests</TabsTrigger>
                  <TabsTrigger value="profile">Profile</TabsTrigger>
                </TabsList>

                <TabsContent value="overview" className="space-y-3 mt-0">
                  <div className="grid grid-cols-2 gap-2">
                    <MiniStat label="Rent requests" value={String(detailQuery.data?.summary.rent_request_count ?? 0)} />
                    <MiniStat label="Collected" value={formatUGX(detailQuery.data?.summary.total_collected ?? 0)} />
                    <MiniStat label="Remaining" value={formatUGX(detailQuery.data?.summary.remaining_balance ?? 0)} tone="warning" />
                    <MiniStat label="Agent commission" value={formatUGX(detailQuery.data?.summary.agent_commission_total ?? 0)} tone="success" />
                  </div>
                  <Card className="p-3 space-y-2">
                    <h4 className="text-sm font-bold">Repayment rhythm</h4>
                    <div className="grid grid-cols-2 gap-2 text-sm">
                      <div><span className="text-xs text-muted-foreground">Collections</span><p className="font-bold tabular-nums">{detailQuery.data?.summary.collection_count ?? 0}</p></div>
                      <div><span className="text-xs text-muted-foreground">Daily expected</span><p className="font-bold tabular-nums">{formatUGX(detailQuery.data?.summary.daily_expected ?? 0)}</p></div>
                      <div><span className="text-xs text-muted-foreground">Total to collect</span><p className="font-bold tabular-nums">{formatUGX(detailQuery.data?.summary.total_to_collect ?? 0)}</p></div>
                      <div><span className="text-xs text-muted-foreground">Total repaid</span><p className="font-bold tabular-nums">{formatUGX(detailQuery.data?.summary.total_repaid ?? 0)}</p></div>
                      <div><span className="text-xs text-muted-foreground">Last collection</span><p className="font-bold">{formatDateTime(selected?.last_collection_at)}</p></div>
                      <div><span className="text-xs text-muted-foreground">Average gap</span><p className="font-bold tabular-nums">{Math.round(num(selected?.avg_gap_hours))}h</p></div>
                    </div>
                  </Card>
                </TabsContent>

                <TabsContent value="collections" className="mt-0">
                  <Card className="p-3 space-y-2">
                    <h4 className="text-sm font-bold">Collection financial statement</h4>
                    {(detailQuery.data?.collections ?? []).length === 0 ? (
                      <p className="text-sm text-muted-foreground">No collection rows found.</p>
                    ) : (
                      <div className="overflow-y-auto">
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>Date</TableHead>
                              <TableHead>Amount</TableHead>
                              <TableHead>Method</TableHead>
                              <TableHead>2-day gap</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {(detailQuery.data?.collections ?? []).map((row) => (
                              <TableRow key={row.id}>
                                <TableCell className="min-w-[150px]">{formatDateTime(row.created_at)}</TableCell>
                                <TableCell className="font-bold tabular-nums">{formatUGX(row.amount)}</TableCell>
                                <TableCell>{row.payment_method || row.tracking_id || '—'}</TableCell>
                                <TableCell>
                                  <Badge variant={row.within_two_day_window ? 'success' : 'destructive'}>
                                    {row.within_two_day_window ? 'In time' : 'Late'}
                                  </Badge>
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    )}
                  </Card>
                </TabsContent>

                <TabsContent value="requests" className="mt-0">
                  <Card className="p-3 space-y-2">
                    <h4 className="text-sm font-bold">Rent requests posted</h4>
                    {(detailQuery.data?.rent_requests ?? []).length === 0 ? (
                      <p className="text-sm text-muted-foreground">No rent requests found.</p>
                    ) : (
                      <div className="space-y-2">
                        {(detailQuery.data?.rent_requests ?? []).map((request) => (
                          <div key={request.id} className="rounded-lg border border-border p-3 space-y-2">
                            <div className="flex items-center justify-between gap-2">
                              <Badge variant="outline">{request.status || 'unknown'}</Badge>
                              <span className="text-xs text-muted-foreground">{formatDateTime(request.created_at)}</span>
                            </div>
                            <div className="grid grid-cols-2 gap-2 text-sm">
                              <div><span className="text-muted-foreground">Rent</span><p className="font-bold">{formatUGX(request.rent_amount)}</p></div>
                              <div><span className="text-muted-foreground">Daily</span><p className="font-bold">{formatUGX(request.daily_repayment)}</p></div>
                              <div><span className="text-muted-foreground">Repaid</span><p className="font-bold">{formatUGX(request.amount_repaid)}</p></div>
                              <div><span className="text-muted-foreground">Remaining</span><p className="font-bold">{formatUGX(request.remaining_balance)}</p></div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </Card>
                </TabsContent>

                <TabsContent value="profile" className="mt-0">
                  <Card className="p-3 space-y-3">
                    <h4 className="text-sm font-bold">Tenant profile</h4>
                    <div className="grid grid-cols-2 gap-2 text-sm">
                      <div><span className="text-xs text-muted-foreground">Full name</span><p className="font-semibold">{detailQuery.data?.tenant.full_name || selected?.tenant_name || '—'}</p></div>
                      <div><span className="text-xs text-muted-foreground">Phone</span><p className="font-semibold">{detailQuery.data?.tenant.phone || selected?.tenant_phone || '—'}</p></div>
                      <div><span className="text-xs text-muted-foreground">Email</span><p className="font-semibold break-all">{detailQuery.data?.tenant.email || selected?.tenant_email || '—'}</p></div>
                      <div><span className="text-xs text-muted-foreground">Joined</span><p className="font-semibold">{formatDateTime(detailQuery.data?.tenant.created_at || selected?.tenant_created_at)}</p></div>
                      <div><span className="text-xs text-muted-foreground">District</span><p className="font-semibold">{detailQuery.data?.tenant.district || '—'}</p></div>
                      <div><span className="text-xs text-muted-foreground">Region</span><p className="font-semibold">{detailQuery.data?.tenant.region || '—'}</p></div>
                      <div><span className="text-xs text-muted-foreground">City / village</span><p className="font-semibold">{detailQuery.data?.tenant.city || detailQuery.data?.tenant.village || '—'}</p></div>
                      <div><span className="text-xs text-muted-foreground">Country</span><p className="font-semibold">{detailQuery.data?.tenant.country || '—'}</p></div>
                    </div>
                    <div className="rounded-lg border border-border p-3 space-y-1">
                      <p className="text-xs uppercase tracking-wide text-muted-foreground">Responsible agent</p>
                      <div className="flex items-center gap-2">
                        <UserAvatar avatarUrl={selected?.agent_avatar_url} fullName={selected?.agent_name} size="sm" />
                        <div className="min-w-0">
                          <p className="text-sm font-semibold truncate">{detailQuery.data?.agent.full_name || selected?.agent_name || '—'}</p>
                          <p className="text-xs text-muted-foreground truncate">{detailQuery.data?.agent.phone || selected?.agent_phone || 'No phone'}</p>
                        </div>
                      </div>
                    </div>
                  </Card>
                </TabsContent>
              </Tabs>
            )}
          </div>
        </Card>
      ) : null}

    </div>
  );
}

