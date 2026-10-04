/**
 * Tenant Ops → Agent Monitoring → Rent Analysis.
 *
 * Read-only. Active Rent Plans are read exactly as the other Agent Monitoring
 * tabs read them (`v_tenant_daily_eligibility` + funded/disbursed/repaying
 * `rent_requests`), schedule position comes from `describePlanSchedule` and
 * receipts from `agent_collections` plus unmatched `repayments`. No new payment
 * rule, no writes.
 */

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { eachDayOfInterval, format, startOfDay, subDays } from 'date-fns';
import { AlertTriangle, Download, FileBarChart2, Loader2, Search } from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/rentCalculations';
import { cn } from '@/lib/utils';
import { unmatchedRepayments } from '@/lib/rentReceipts';
import {
  CUSTOM_BAND_KEY,
  RENT_BANDS,
  bandLabel,
  buildDailyTrend,
  buildTenantRows,
  summariseBand,
  type RentAnalysisPlan,
  type RentAnalysisReceipt,
  type RentBand,
  type TenantRentRow,
} from '@/lib/rentAnalysis';
import { generateRentAnalysisPdf } from '@/lib/rentAnalysisPdf';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { toast } from 'sonner';

const PAGE_SIZE = 1000;
const ROWS_PER_PAGE = 25;
const ALL_KEY = 'all';

async function fetchAll<T>(
  query: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
) {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const result = await query(from, from + PAGE_SIZE - 1);
    if (result.error) throw new Error(result.error.message);
    const page = result.data ?? [];
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
  }
}

function rangeBounds(start: Date, end: Date) {
  const from = new Date(`${format(start, 'yyyy-MM-dd')}T00:00:00+03:00`);
  const to = new Date(`${format(end, 'yyyy-MM-dd')}T23:59:59.999+03:00`);
  return { from: from.toISOString(), to: to.toISOString() };
}

interface ProfileRow {
  id: string;
  full_name: string | null;
  phone: string | null;
}

interface CollectionRow {
  rent_request_id: string | null;
  amount: number | null;
  created_at: string;
}

function StatTile({ label, value, hint, accent }: { label: string; value: string; hint?: string; accent?: 'danger' | 'success' | 'primary' }) {
  return (
    <Card className="border-border/70 shadow-sm">
      <CardContent className="p-3 sm:p-4">
        <p className="truncate text-[10px] font-semibold uppercase tracking-wide text-muted-foreground sm:text-[11px]">{label}</p>
        <p
          className={cn(
            'mt-1.5 break-words text-lg font-bold leading-tight tabular-nums sm:text-xl',
            accent === 'danger' && 'text-destructive',
            accent === 'success' && 'text-emerald-600 dark:text-emerald-400',
            accent === 'primary' && 'text-primary',
          )}
        >
          {value}
        </p>
        {hint && <p className="mt-1 break-words text-[10px] leading-snug text-muted-foreground sm:text-xs">{hint}</p>}
      </CardContent>
    </Card>
  );
}

export function RentAnalysis() {
  const today = useMemo(() => startOfDay(new Date()), []);
  const [rangeStart, setRangeStart] = useState(() => format(subDays(new Date(), 29), 'yyyy-MM-dd'));
  const [rangeEnd, setRangeEnd] = useState(() => format(new Date(), 'yyyy-MM-dd'));
  const [search, setSearch] = useState('');
  const [selectedBandKey, setSelectedBandKey] = useState<string>(ALL_KEY);
  const [customMin, setCustomMin] = useState('');
  const [customMax, setCustomMax] = useState('');
  const [customApplied, setCustomApplied] = useState<RentBand | null>(null);
  const [page, setPage] = useState(0);

  const periodStart = useMemo(() => new Date(`${rangeStart}T00:00:00`), [rangeStart]);
  const periodEnd = useMemo(() => new Date(`${rangeEnd}T00:00:00`), [rangeEnd]);

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['tenant-ops-rent-analysis', rangeStart, rangeEnd],
    staleTime: 60_000,
    queryFn: async () => {
      const eligibility = await fetchAll<{ rent_request_id: string }>((from, to) =>
        supabase.from('v_tenant_daily_eligibility').select('rent_request_id').range(from, to),
      );
      const eligibleIds = new Set(eligibility.map((row) => row.rent_request_id));
      if (eligibleIds.size === 0) {
        return { plans: [] as RentAnalysisPlan[], receipts: [] as RentAnalysisReceipt[], profiles: [] as ProfileRow[] };
      }

      const requests = await fetchAll<RentAnalysisPlan>((from, to) =>
        supabase
          .from('rent_requests')
          .select(
            'id, tenant_id, agent_id, status, rent_amount, house_category, daily_repayment, total_repayment, amount_repaid, repayment_frequency, repayment_starts_on, created_at',
          )
          .in('status', ['funded', 'disbursed', 'repaying'])
          .range(from, to),
      );
      const plans = requests.filter((request) => eligibleIds.has(request.id));
      const planIds = plans.map((plan) => plan.id);

      const bounds = rangeBounds(periodStart, periodEnd);
      const collections: CollectionRow[] = [];
      const selfPayments: CollectionRow[] = [];
      const CHUNK = 200;
      for (let index = 0; index < planIds.length; index += CHUNK) {
        const slice = planIds.slice(index, index + CHUNK);
        const [collected, repaid] = await Promise.all([
          supabase
            .from('agent_collections')
            .select('rent_request_id, amount, created_at').is('reversed_at', null)
            .in('rent_request_id', slice)
            .gte('created_at', bounds.from)
            .lte('created_at', bounds.to),
          supabase
            .from('repayments')
            .select('rent_request_id, amount, created_at')
            .in('rent_request_id', slice)
            .gte('created_at', bounds.from)
            .lte('created_at', bounds.to),
        ]);
        if (collected.error) throw collected.error;
        if (repaid.error) throw repaid.error;
        collections.push(...((collected.data ?? []) as CollectionRow[]));
        selfPayments.push(...((repaid.data ?? []) as CollectionRow[]));
      }

      const receipts: RentAnalysisReceipt[] = [...collections, ...unmatchedRepayments(selfPayments, collections)]
        .filter((row): row is CollectionRow & { rent_request_id: string } => Boolean(row.rent_request_id))
        .map((row) => ({
          rent_request_id: row.rent_request_id,
          amount: Number(row.amount ?? 0),
          created_at: row.created_at,
        }));

      const ids = Array.from(
        new Set([
          ...plans.map((plan) => plan.tenant_id),
          ...plans.map((plan) => plan.agent_id).filter((id): id is string => Boolean(id)),
        ]),
      );
      const profiles: ProfileRow[] = [];
      for (let index = 0; index < ids.length; index += 300) {
        const { data: batch, error: profileError } = await supabase
          .from('profiles')
          .select('id, full_name, phone')
          .in('id', ids.slice(index, index + 300));
        if (profileError) throw profileError;
        profiles.push(...((batch ?? []) as ProfileRow[]));
      }

      return { plans, receipts, profiles };
    },
  });

  const profileMap = useMemo(
    () => new Map((data?.profiles ?? []).map((profile) => [profile.id, profile])),
    [data?.profiles],
  );

  const rows = useMemo(
    () =>
      buildTenantRows({
        plans: data?.plans ?? [],
        receipts: data?.receipts ?? [],
        referenceDay: today,
        nameFor: (id) => (id ? profileMap.get(id)?.full_name || 'Unnamed' : 'Unassigned'),
        phoneFor: (id) => (id ? profileMap.get(id)?.phone ?? null : null),
      }),
    [data?.plans, data?.receipts, profileMap, today],
  );

  const bands = useMemo(() => (customApplied ? [...RENT_BANDS, customApplied] : RENT_BANDS), [customApplied]);

  const searchedRows = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return rows;
    return rows.filter((row) =>
      `${row.tenantName} ${row.tenantPhone ?? ''} ${row.agentName} ${row.agentPhone ?? ''} ${row.houseCategory ?? ''}`
        .toLowerCase()
        .includes(query),
    );
  }, [rows, search]);

  const summaries = useMemo(
    () =>
      bands.map((band) =>
        summariseBand(
          band,
          searchedRows.filter((row) => row.rent >= band.min && (band.max === null || row.rent < band.max)),
        ),
      ),
    [bands, searchedRows],
  );

  const selectedBand = useMemo(
    () => (selectedBandKey === ALL_KEY ? null : bands.find((band) => band.key === selectedBandKey) ?? null),
    [bands, selectedBandKey],
  );

  const detailRows = useMemo(() => {
    const scoped = selectedBand
      ? searchedRows.filter((row) => row.rent >= selectedBand.min && (selectedBand.max === null || row.rent < selectedBand.max))
      : searchedRows;
    return [...scoped].sort((a, b) => b.schedule.arrears - a.schedule.arrears || b.rent - a.rent);
  }, [searchedRows, selectedBand]);

  const pageRows = detailRows.slice(page * ROWS_PER_PAGE, page * ROWS_PER_PAGE + ROWS_PER_PAGE);
  const pageCount = Math.max(1, Math.ceil(detailRows.length / ROWS_PER_PAGE));

  /** Headline figures always describe exactly the rows on screen. */
  const overall = useMemo(
    () =>
      summariseBand(
        { key: 'total', label: selectedBand ? selectedBand.label : 'All categories', min: 0, max: null },
        detailRows,
      ),
    [detailRows, selectedBand],
  );

  const periodDays = useMemo(() => {
    if (periodEnd < periodStart) return [] as string[];
    return eachDayOfInterval({ start: periodStart, end: periodEnd }).map((day) => format(day, 'yyyy-MM-dd'));
  }, [periodEnd, periodStart]);

  /** Daily receipts for exactly the tenants in scope. */
  const trend = useMemo(
    () => buildDailyTrend(data?.receipts ?? [], new Set(detailRows.map((row) => row.planId)), periodDays),
    [data?.receipts, detailRows, periodDays],
  );

  const trendChart = useMemo(
    () => trend.map((point) => ({ ...point, label: format(new Date(`${point.day}T00:00:00`), 'dd MMM') })),
    [trend],
  );

  /** Distribution across rent categories, respecting search + custom range. */
  const distribution = useMemo(
    () =>
      summaries.map((summary) => ({
        key: summary.band.key,
        label: summary.band.label,
        tenants: summary.tenantCount,
        arrears: summary.arrearsCount,
        totalRent: summary.totalRent,
      })),
    [summaries],
  );

  const behaviour = useMemo(() => {
    const arrears = detailRows.filter((row) => row.schedule.arrears > 0).length;
    const ahead = detailRows.filter((row) => row.schedule.arrears === 0 && row.schedule.periodsAhead > 0).length;
    return { arrears, ahead, onSchedule: Math.max(0, detailRows.length - arrears - ahead) };
  }, [detailRows]);

  const scopeLines = useMemo(
    () => [
      `Population: active Rent Plans (funded, disbursed or repaying) on the daily eligibility list — ${searchedRows.length} tenant${searchedRows.length === 1 ? '' : 's'} of ${rows.length} active.`,
      `Rent category: ${selectedBand ? selectedBand.label : 'all categories'}${customApplied ? ` · custom range applied: ${customApplied.label}` : ''}.`,
      `Search filter: ${search.trim() ? `"${search.trim()}"` : 'none'}.`,
      `Receipt figures cover ${format(periodStart, 'dd MMM yyyy')} to ${format(periodEnd, 'dd MMM yyyy')}; arrears and outstanding balances are the position as at ${format(today, 'dd MMM yyyy')}.`,
    ],
    [customApplied, periodEnd, periodStart, rows.length, search, searchedRows.length, selectedBand, today],
  );

  const applyCustom = () => {
    const min = Number(customMin.replace(/[^\d]/g, ''));
    const max = customMax.trim() ? Number(customMax.replace(/[^\d]/g, '')) : null;
    if (!Number.isFinite(min) || (max !== null && (!Number.isFinite(max) || max <= min))) {
      toast.error('Enter a valid rent range — the upper figure must be higher than the lower figure.');
      return;
    }
    const band: RentBand = { key: CUSTOM_BAND_KEY, label: `Custom · ${bandLabel(min, max)}`, min, max };
    setCustomApplied(band);
    setSelectedBandKey(CUSTOM_BAND_KEY);
    setPage(0);
  };

  const exportPdf = () => {
    if (rows.length === 0) {
      toast.error('Nothing to export yet.');
      return;
    }
    const blob = generateRentAnalysisPdf({
      periodStart,
      periodEnd,
      positionDay: today,
      generatedAt: new Date(),
      scopeLines,
      summaries: selectedBand ? summaries.filter((summary) => summary.band.key === selectedBand.key) : summaries,
      rows: detailRows,
      selectedLabel: selectedBand ? selectedBand.label : 'All categories',
      headline: overall,
      behaviour,
      distribution,
      trend,
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `welile-rent-analysis-${format(periodStart, 'yyyyMMdd')}-${format(periodEnd, 'yyyyMMdd')}.pdf`;
    link.click();
    URL.revokeObjectURL(url);
    toast.success('Rent analysis report downloaded.');
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center gap-2 p-10 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading rent analysis…
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex flex-col items-center gap-3 p-10 text-center">
        <AlertTriangle className="h-5 w-5 text-destructive" />
        <p className="text-sm text-muted-foreground">
          {error instanceof Error ? error.message : 'Unable to load rent analysis.'}
        </p>
        <Button variant="outline" size="sm" onClick={() => void refetch()}>Try again</Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 rounded-2xl border bg-card p-4 shadow-sm sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-primary/10">
            <FileBarChart2 className="h-5 w-5 text-primary" />
          </div>
          <div className="min-w-0">
            <h2 className="truncate text-lg font-bold leading-tight tracking-tight sm:text-xl">Rent Analysis</h2>
            <p className="truncate text-xs text-muted-foreground">
              Active Rent Plans grouped by monthly rent · receipts {format(periodStart, 'dd MMM')} – {format(periodEnd, 'dd MMM yyyy')}
            </p>
          </div>
        </div>
        <Button size="sm" variant="outline" className="gap-1.5" onClick={exportPdf}>
          <Download className="h-4 w-4" /> Export PDF
        </Button>
      </div>

      <Card className="border-border/70 shadow-sm">
        <CardContent className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="space-y-1">
            <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Period start</Label>
            <Input type="date" value={rangeStart} max={rangeEnd} onChange={(event) => { setRangeStart(event.target.value); setPage(0); }} className="h-8 text-xs" />
          </div>
          <div className="space-y-1">
            <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Period end</Label>
            <Input type="date" value={rangeEnd} min={rangeStart} onChange={(event) => { setRangeEnd(event.target.value); setPage(0); }} className="h-8 text-xs" />
          </div>
          <div className="space-y-1">
            <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Search tenant, agent or phone</Label>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
              <Input value={search} onChange={(event) => { setSearch(event.target.value); setPage(0); }} placeholder="Search" className="h-8 pl-8 text-xs" />
            </div>
          </div>
          <div className="space-y-1">
            <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Custom rent range (UGX)</Label>
            <div className="flex items-center gap-1.5">
              <Input value={customMin} onChange={(event) => setCustomMin(event.target.value)} placeholder="From" inputMode="numeric" className="h-8 text-xs" />
              <Input value={customMax} onChange={(event) => setCustomMax(event.target.value)} placeholder="To" inputMode="numeric" className="h-8 text-xs" />
              <Button size="sm" variant="secondary" className="h-8 shrink-0 text-xs" onClick={applyCustom}>Apply</Button>
              {customApplied && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-8 shrink-0 text-xs"
                  onClick={() => { setCustomApplied(null); setCustomMin(''); setCustomMax(''); setSelectedBandKey(ALL_KEY); }}
                >
                  Clear
                </Button>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          size="sm"
          variant={selectedBandKey === ALL_KEY ? 'secondary' : 'outline'}
          className="h-8 text-xs"
          onClick={() => { setSelectedBandKey(ALL_KEY); setPage(0); }}
        >
          All categories
        </Button>
        {bands.map((band) => (
          <Button
            key={band.key}
            size="sm"
            variant={selectedBandKey === band.key ? 'secondary' : 'outline'}
            className="h-8 text-xs"
            onClick={() => { setSelectedBandKey(band.key); setPage(0); }}
          >
            {band.label}
          </Button>
        ))}
      </div>

      <p className="text-xs text-muted-foreground">
        Analysing <span className="font-semibold text-foreground">{detailRows.length}</span> active tenant
        {detailRows.length === 1 ? '' : 's'} · {selectedBand ? selectedBand.label : 'all rent categories'} · receipts{' '}
        {format(periodStart, 'dd MMM yyyy')} – {format(periodEnd, 'dd MMM yyyy')} · position as at {format(today, 'dd MMM yyyy')}
      </p>

      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 xl:grid-cols-6">
        <StatTile label="Active tenants" value={String(overall.tenantCount)} hint={`${overall.dailyCount} daily / ${overall.weeklyCount} weekly`} />
        <StatTile label="Total monthly rent" value={formatUGX(overall.totalRent)} hint={`avg ${formatUGX(overall.averageRent)}`} accent="primary" />
        <StatTile label="Collected in period" value={formatUGX(overall.paidInPeriod)} hint={`${overall.paymentsInPeriod} receipts`} accent="success" />
        <StatTile label="Tenants in arrears" value={String(overall.arrearsCount)} hint={formatUGX(overall.arrearsAmount)} accent={overall.arrearsCount > 0 ? 'danger' : undefined} />
        <StatTile label="Paid in period" value={`${overall.paymentRate.toFixed(1)}%`} hint={`${overall.payingCount} of ${overall.tenantCount} tenants`} />
        <StatTile label="Outstanding balances" value={formatUGX(overall.outstanding)} hint="remaining on active plans" />
      </div>

      <div className="grid gap-3 lg:grid-cols-5">
        <Card className="overflow-hidden border-border/70 shadow-sm lg:col-span-2">
          <CardHeader className="border-b bg-muted/30 pb-3">
            <CardTitle className="text-sm font-semibold tracking-tight">Tenants by rent category</CardTitle>
            <p className="text-[11px] text-muted-foreground">Tap a bar to filter every figure below to that category.</p>
          </CardHeader>
          <CardContent className="p-3">
            <div className="h-56 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={distribution} margin={{ top: 4, right: 8, bottom: 4, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                  <XAxis dataKey="label" tick={{ fontSize: 9 }} interval={0} angle={-18} textAnchor="end" height={46} />
                  <YAxis tick={{ fontSize: 10 }} allowDecimals={false} width={28} />
                  <Tooltip
                    contentStyle={{ fontSize: 11, borderRadius: 8 }}
                    formatter={(value: number, name) => [String(value), name === 'tenants' ? 'Tenants' : 'In arrears']}
                  />
                  <Bar dataKey="tenants" radius={[4, 4, 0, 0]} onClick={(entry: { key?: string }) => { if (entry?.key) { setSelectedBandKey(entry.key); setPage(0); } }}>
                    {distribution.map((item) => (
                      <Cell
                        key={item.key}
                        cursor="pointer"
                        fill={selectedBandKey === item.key ? 'hsl(var(--primary))' : 'hsl(var(--primary) / 0.35)'}
                      />
                    ))}
                  </Bar>
                  <Bar dataKey="arrears" radius={[4, 4, 0, 0]} fill="hsl(var(--destructive) / 0.55)" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

        <Card className="overflow-hidden border-border/70 shadow-sm lg:col-span-3">
          <CardHeader className="flex flex-col gap-1 border-b bg-muted/30 pb-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <CardTitle className="text-sm font-semibold tracking-tight">Collections over the period</CardTitle>
              <p className="text-[11px] text-muted-foreground">
                {selectedBand ? selectedBand.label : 'All categories'} · {format(periodStart, 'dd MMM')} – {format(periodEnd, 'dd MMM yyyy')}
              </p>
            </div>
            <div className="flex flex-wrap gap-1.5">
              <Badge variant="outline" className="border-emerald-500/40 bg-emerald-500/10 text-[10px] text-emerald-600 dark:text-emerald-400">
                On schedule {behaviour.onSchedule}
              </Badge>
              <Badge variant="outline" className="border-primary/40 bg-primary/10 text-[10px] text-primary">Ahead {behaviour.ahead}</Badge>
              <Badge variant="outline" className="border-destructive/40 bg-destructive/10 text-[10px] text-destructive">
                In arrears {behaviour.arrears}
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="p-3">
            <div className="h-56 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={trendChart} margin={{ top: 4, right: 8, bottom: 4, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                  <XAxis dataKey="label" tick={{ fontSize: 9 }} minTickGap={16} />
                  <YAxis yAxisId="amount" tick={{ fontSize: 9 }} width={44} tickFormatter={(value: number) => `${Math.round(value / 1000)}k`} />
                  <YAxis yAxisId="count" orientation="right" tick={{ fontSize: 9 }} width={26} allowDecimals={false} />
                  <Tooltip
                    contentStyle={{ fontSize: 11, borderRadius: 8 }}
                    formatter={(value: number, name) =>
                      name === 'amount' ? [formatUGX(value), 'Collected'] : [String(value), 'Receipts']
                    }
                  />
                  <Bar yAxisId="amount" dataKey="amount" radius={[3, 3, 0, 0]} fill="hsl(var(--primary) / 0.5)" />
                  <Line yAxisId="count" type="monotone" dataKey="count" dot={false} strokeWidth={2} stroke="hsl(var(--primary))" />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
      </div>


      <Card className="overflow-hidden border-border/70 shadow-sm">
        <CardHeader className="border-b bg-muted/30 pb-3">
          <CardTitle className="text-sm font-semibold tracking-tight sm:text-base">Rent categories</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader className="[&_th]:whitespace-nowrap [&_th]:text-[11px] [&_th]:font-semibold [&_th]:uppercase [&_th]:tracking-wide">
                <TableRow className="bg-muted/20">
                  <TableHead>Rent category</TableHead>
                  <TableHead className="text-right">Tenants</TableHead>
                  <TableHead className="text-right">Total rent</TableHead>
                  <TableHead className="text-right">Average rent</TableHead>
                  <TableHead className="text-right">In arrears</TableHead>
                  <TableHead className="text-right">Arrears</TableHead>
                  <TableHead className="text-right">Collected in period</TableHead>
                  <TableHead className="text-right">Receipts</TableHead>
                  <TableHead className="text-right">Paying</TableHead>
                  <TableHead className="text-right">Schedule adherence</TableHead>
                  <TableHead className="text-right">Avg gap</TableHead>
                  <TableHead className="text-right">Outstanding</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {summaries.map((summary) => (
                  <TableRow
                    key={summary.band.key}
                    className={cn('cursor-pointer transition-colors hover:bg-muted/40', selectedBandKey === summary.band.key && 'bg-muted/40')}
                    onClick={() => { setSelectedBandKey(summary.band.key); setPage(0); }}
                  >
                    <TableCell className="font-semibold">{summary.band.label}</TableCell>
                    <TableCell className="text-right tabular-nums">{summary.tenantCount}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatUGX(summary.totalRent)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatUGX(summary.averageRent)}</TableCell>
                    <TableCell className="text-right tabular-nums">{summary.arrearsCount}</TableCell>
                    <TableCell className={cn('text-right tabular-nums', summary.arrearsAmount > 0 && 'font-semibold text-destructive')}>
                      {formatUGX(summary.arrearsAmount)}
                    </TableCell>
                    <TableCell className="text-right font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">
                      {formatUGX(summary.paidInPeriod)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{summary.paymentsInPeriod}</TableCell>
                    <TableCell className="text-right tabular-nums">{summary.paymentRate.toFixed(1)}%</TableCell>
                    <TableCell className="text-right tabular-nums">{summary.scheduleAdherence.toFixed(1)}%</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {summary.averageGapDays === null ? '—' : `${summary.averageGapDays.toFixed(1)}d`}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{formatUGX(summary.outstanding)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Card className="overflow-hidden border-border/70 shadow-sm">
        <CardHeader className="flex flex-col gap-2 border-b bg-muted/30 pb-3 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle className="text-sm font-semibold tracking-tight sm:text-base">
            Tenant detail — {selectedBand ? selectedBand.label : 'all categories'}
          </CardTitle>
          <div className="flex items-center gap-2">
            <span className="text-xs tabular-nums text-muted-foreground">
              Page {page + 1} of {pageCount}
            </span>
            <Button size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={page === 0} onClick={() => setPage((value) => value - 1)}>
              Previous
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2 text-xs"
              disabled={page + 1 >= pageCount}
              onClick={() => setPage((value) => value + 1)}
            >
              Next
            </Button>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {detailRows.length === 0 ? (
            <p className="p-10 text-center text-sm text-muted-foreground">No active tenants match this view.</p>
          ) : (
            <>
              <div className="hidden overflow-x-auto md:block">
                <Table>
                  <TableHeader className="[&_th]:whitespace-nowrap [&_th]:text-[11px] [&_th]:font-semibold [&_th]:uppercase [&_th]:tracking-wide">
                    <TableRow className="bg-muted/20">
                      <TableHead>Tenant</TableHead>
                      <TableHead>Agent</TableHead>
                      <TableHead className="text-right">Rent</TableHead>
                      <TableHead className="text-right">Per period</TableHead>
                      <TableHead className="text-right">Arrears</TableHead>
                      <TableHead className="text-right">Collected in period</TableHead>
                      <TableHead className="text-right">Receipts</TableHead>
                      <TableHead className="text-right">Avg gap</TableHead>
                      <TableHead className="text-right">Last payment</TableHead>
                      <TableHead className="text-right">Outstanding</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {pageRows.map((row: TenantRentRow) => (
                      <TableRow key={row.planId}>
                        <TableCell>
                          <p className="font-semibold leading-tight">{row.tenantName}</p>
                          <p className="text-xs text-muted-foreground">{row.tenantPhone || 'No phone number'}</p>
                        </TableCell>
                        <TableCell className="text-xs">{row.agentName}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatUGX(row.rent)}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatUGX(row.schedule.periodAmount)}
                          <span className="block text-[10px] text-muted-foreground">per {row.schedule.unit}</span>
                        </TableCell>
                        <TableCell className={cn('text-right tabular-nums', row.schedule.arrears > 0 && 'font-semibold text-destructive')}>
                          {formatUGX(row.schedule.arrears)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{formatUGX(row.paidInPeriod)}</TableCell>
                        <TableCell className="text-right tabular-nums">{row.paymentsInPeriod}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {row.averageGapDays === null ? '—' : `${row.averageGapDays.toFixed(1)}d`}
                        </TableCell>
                        <TableCell className="text-right text-xs tabular-nums">
                          {row.lastPaymentAt ? format(new Date(row.lastPaymentAt), 'dd MMM yyyy') : '—'}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{formatUGX(row.schedule.outstandingPlan)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <div className="space-y-2 p-3 md:hidden">
                {pageRows.map((row) => (
                  <div key={row.planId} className="rounded-xl border border-border/70 bg-card p-3 shadow-sm">
                    <p className="truncate text-sm font-semibold leading-tight">{row.tenantName}</p>
                    <p className="truncate text-xs text-muted-foreground">{row.tenantPhone || 'No phone number'} · {row.agentName}</p>
                    <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
                      <div><span className="text-muted-foreground">Rent</span><p className="font-semibold tabular-nums">{formatUGX(row.rent)}</p></div>
                      <div><span className="text-muted-foreground">Per {row.schedule.unit}</span><p className="font-semibold tabular-nums">{formatUGX(row.schedule.periodAmount)}</p></div>
                      <div><span className="text-muted-foreground">Collected in period</span><p className="font-semibold tabular-nums">{formatUGX(row.paidInPeriod)}</p></div>
                      <div><span className="text-muted-foreground">Outstanding</span><p className="font-semibold tabular-nums">{formatUGX(row.schedule.outstandingPlan)}</p></div>
                    </div>
                    {row.schedule.arrears > 0 && (
                      <Badge variant="outline" className="mt-2 border-destructive/40 bg-destructive/10 text-[10px] font-medium text-destructive">
                        Arrears {formatUGX(row.schedule.arrears)}
                      </Badge>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default RentAnalysis;
