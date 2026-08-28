import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { format, subDays, startOfMonth, startOfYear, differenceInCalendarDays } from 'date-fns';
import { toast } from 'sonner';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid,
} from 'recharts';
import {
  ArrowDownRight, ArrowUpRight, CalendarIcon, ChevronDown, FileText, Loader2, Minus, RefreshCw, Search,
} from 'lucide-react';

import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import {
  generateAgentProductsServicesPdf, apsPctChange, apsPctLabel, apsUgx, type ApsReport,
  apsWindowLabel, apsCompareLabel, apsExpectedTotal, apsAgentExpectedTotal, type ApsCumulative,
} from '@/lib/agentProductsServicesPdf';

const PAGE_SIZE = 15;
const num = (n: any) => Math.round(Number(n) || 0).toLocaleString();
const title = (s: any) => String(s ?? '—').replace(/_/g, ' ');
const toDateKey = (d: Date) => format(d, 'yyyy-MM-dd');

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function TrendPill({ current, previous, invert = false, compareLabel }: {
  current: number; previous: number; invert?: boolean; compareLabel?: string;
}) {
  const v = apsPctChange(current, previous);
  const up = v !== null && v > 0;
  const flat = v === null || v === 0;
  const good = invert ? !up : up;
  const Icon = flat ? Minus : up ? ArrowUpRight : ArrowDownRight;
  return (
    <span className={cn(
      'inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-semibold',
      flat ? 'bg-muted text-muted-foreground' : good ? 'bg-emerald-500/10 text-emerald-600' : 'bg-destructive/10 text-destructive',
    )} title={compareLabel ? `${apsPctLabel(current, previous)} ${compareLabel}` : undefined}>
      <Icon className="h-3 w-3" />
      {apsPctLabel(current, previous)}
    </span>
  );
}

function Kpi({ label, value, hint, current, previous, invert, compareLabel }: {
  label: string; value: string; hint?: string;
  current?: number; previous?: number; invert?: boolean; compareLabel?: string;
}) {
  return (
    <Card className="border">
      <CardContent className="p-3 space-y-1">
        <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground leading-tight">{label}</p>
        <p className="text-base sm:text-lg font-bold leading-tight break-words">{value}</p>
        <div className="flex items-center gap-1.5 flex-wrap">
          {current !== undefined && previous !== undefined && (
            <TrendPill current={current} previous={previous} invert={invert} compareLabel={compareLabel} />
          )}
          {current !== undefined && previous !== undefined && compareLabel && (
            <span className="text-[10px] text-muted-foreground">{compareLabel}</span>
          )}
          {hint && <span className="text-[10px] text-muted-foreground">{hint}</span>}
        </div>
      </CardContent>
    </Card>
  );
}

/** Small client-side paginated table (data already fetched in one RPC round trip). */
function PagedTable<T extends Record<string, any>>({
  rows, columns, searchKeys, emptyLabel,
}: {
  rows: T[];
  columns: { key: string; label: string; align?: 'left' | 'right'; render?: (r: T) => any }[];
  searchKeys?: string[];
  emptyLabel: string;
}) {
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim().toLowerCase()), 300);
    return () => clearTimeout(t);
  }, [q]);
  useEffect(() => { setPage(1); }, [debounced, rows]);

  const filtered = useMemo(() => {
    if (!debounced || !searchKeys?.length) return rows;
    return rows.filter(r => searchKeys.some(k => String(r[k] ?? '').toLowerCase().includes(debounced)));
  }, [rows, debounced, searchKeys]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const slice = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <div className="space-y-2">
      {searchKeys?.length ? (
        <div className="relative max-w-xs">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input value={q} onChange={e => setQ(e.target.value)} placeholder="Search…" className="h-8 pl-7 text-xs" />
        </div>
      ) : null}
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-xs">
          <thead className="bg-muted/50">
            <tr>
              {columns.map(c => (
                <th key={c.key} className={cn('px-2 py-2 font-semibold whitespace-nowrap', c.align === 'right' ? 'text-right' : 'text-left')}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {slice.length === 0 && (
              <tr><td colSpan={columns.length} className="px-2 py-6 text-center text-muted-foreground">{emptyLabel}</td></tr>
            )}
            {slice.map((r, i) => (
              <tr key={r.id || r.agent_id || i} className="border-t">
                {columns.map(c => (
                  <td key={c.key} className={cn('px-2 py-1.5 whitespace-nowrap', c.align === 'right' ? 'text-right' : 'text-left')}>
                    {c.render ? c.render(r) : String(r[c.key] ?? '—')}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex items-center justify-between gap-2">
        <p className="text-[10px] text-muted-foreground">
          {filtered.length ? `${(page - 1) * PAGE_SIZE + 1}–${Math.min(page * PAGE_SIZE, filtered.length)} of ${num(filtered.length)}` : '0 records'}
        </p>
        <div className="flex items-center gap-1.5">
          <Button size="sm" variant="outline" className="h-7 text-[11px]" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>Prev</Button>
          <span className="text-[10px] text-muted-foreground">Page {page} / {totalPages}</span>
          <Button size="sm" variant="outline" className="h-7 text-[11px]" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>Next</Button>
        </div>
      </div>
    </div>
  );
}

export function AgentProductsServicesReport() {
  const { user } = useAuth();
  // `day` is the cumulative window START. Every window runs from `day` up to today.
  const [day, setDay] = useState<Date>(() => new Date());
  const [activePreset, setActivePreset] = useState<string>('today');
  const [exporting, setExporting] = useState(false);
  const [actorName, setActorName] = useState('');

  useEffect(() => {
    if (!user?.id) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase.from('profiles').select('full_name').eq('id', user.id).maybeSingle();
      if (!cancelled) setActorName(data?.full_name || user.email || 'Agent Ops user');
    })();
    return () => { cancelled = true; };
  }, [user?.id, user?.email]);

  const dayKey = toDateKey(day);
  const today = useMemo(() => new Date(), []);
  const todayKey = toDateKey(today);
  const rangeDays = Math.max(1, differenceInCalendarDays(today, day) + 1);
  const isRange = rangeDays > 1;
  const periodLabel = isRange
    ? `${format(day, 'dd MMM yyyy')} – ${format(today, 'dd MMM yyyy')} · ${num(rangeDays)} days cumulative`
    : format(today, 'dd MMM yyyy');

  const reportQuery = useQuery({
    queryKey: ['agent-products-services-report', dayKey, todayKey],
    queryFn: async (): Promise<ApsReport> => {
      const { data, error } = await supabase.rpc('get_agent_products_services_report' as any, {
        p_date: todayKey,
        p_from: dayKey,
      });
      if (error) throw error;
      return data as unknown as ApsReport;
    },
    staleTime: 60_000,
  });

  const rawReport = reportQuery.data;

  /** Actual commission EARNED in the window (ledger-backed) — not the wallet balance. */
  const commissionQuery = useQuery({
    queryKey: ['agent-commission-earned', dayKey, todayKey],
    queryFn: async (): Promise<Record<string, number>> => {
      const { data, error } = await supabase.rpc('get_agent_commission_earned' as any, {
        p_from: dayKey,
        p_to: todayKey,
      });
      if (error) throw error;
      const map: Record<string, number> = {};
      for (const row of (data as any[]) || []) map[row.agent_id] = Number(row.commission_earned) || 0;
      return map;
    },
    staleTime: 60_000,
  });

  const report = useMemo(() => {
    if (!rawReport) return rawReport;
    const map = commissionQuery.data;
    if (!map) return rawReport;
    return {
      ...rawReport,
      agent_float_rows: (rawReport.agent_float_rows || []).map(r => ({
        ...r,
        commission_balance: Number(map[(r as any).agent_id] ?? 0),
      })),
    };
  }, [rawReport, commissionQuery.data]);

  const cumulativeQuery = useQuery({
    queryKey: ['agent-products-cumulative', todayKey],
    queryFn: async (): Promise<ApsCumulative> => {
      const { data, error } = await supabase.rpc('get_agent_products_cumulative' as any, { p_date: todayKey });
      if (error) throw error;
      return data as unknown as ApsCumulative;
    },
    staleTime: 60_000,
  });

  const cumulative = cumulativeQuery.data ?? null;

  // ===== Dynamic period-over-period baseline: the equal-length window immediately before =====
  const prevFrom = useMemo(() => subDays(day, rangeDays), [day, rangeDays]);
  const prevTo = useMemo(() => subDays(day, 1), [day]);
  const prevFromKey = toDateKey(prevFrom);
  const prevToKey = toDateKey(prevTo);
  const compareLabel = apsCompareLabel(rangeDays);

  const prevQuery = useQuery({
    queryKey: ['agent-products-services-report-prev', prevFromKey, prevToKey],
    queryFn: async (): Promise<ApsReport> => {
      const { data, error } = await supabase.rpc('get_agent_products_services_report' as any, {
        p_date: prevToKey,
        p_from: prevFromKey,
      });
      if (error) throw error;
      return data as unknown as ApsReport;
    },
    staleTime: 60_000,
  });

  const prevReport = prevQuery.data ?? null;

  /** Previous-period values for every KPI (falls back to the RPC's day-over-day fields). */
  const pop = useMemo(() => {
    const p = prevReport;
    return {
      newAgents: p ? Number(p.agents.new_today) : Number(report?.agents.new_prev ?? 0),
      totalAgents: Number(report?.agents.base ?? 0),
      activeAgents: p ? Number(p.agents.active_today) : undefined,
      collected: p ? Number(p.rent.collected_today) : Number(report?.rent.collected_prev ?? 0),
      dailyReceivable: p ? Number(p.rent.daily_receivable) : undefined,
      expectedTotal: p ? apsExpectedTotal(p) : undefined,
      outstanding: p ? Number(p.rent.outstanding) : undefined,
      advIssued: p ? Number(p.advances.issued_today) : undefined,
      advOutstanding: p ? Number(p.advances.outstanding) : undefined,
      advApproved: p ? Number(p.advances.approved) : undefined,
      scActive: p ? Number(p.service_centres.active_total) : undefined,
      scPending: p ? Number(p.service_centres.pending_total) : undefined,
      bikes: p ? Number(p.bikes?.outstanding ?? 0) : undefined,
      phones: p ? Number(p.phones?.outstanding ?? 0) : undefined,
    };
  }, [prevReport, report]);

  const trend = useMemo(
    () => [...(report?.trend || [])]
      .sort((a, b) => a.day.localeCompare(b.day))
      .map(t => ({ ...t, label: format(new Date(`${t.day}T00:00:00`), 'dd MMM'), collected: Number(t.collected) || 0 })),
    [report],
  );

  /** Cumulative expected collections across the selected window (sum of daily dues per live day). */
  const expectedTotal = report ? apsExpectedTotal(report) : 0;
  const expectedDays = Math.max(
    1,
    Math.round(Number(report?.rent.expected_days ?? report?.range_days) || 1),
  );

  const handlePdf = () => {
    if (!report) return;
    setExporting(true);
    try {
      const blob = generateAgentProductsServicesPdf({
        report,
        actor: actorName || 'Agent Ops user',
        cumulative,
        prev: prevReport,
      });
      downloadBlob(blob, isRange ? `agent-products-services-${dayKey}_to_${todayKey}.pdf` : `agent-products-services-${todayKey}.pdf`);
      toast.success(isRange ? 'Cumulative report downloaded' : 'Daily report downloaded');
    } catch (err: any) {
      toast.error(err?.message || 'Could not generate the report');
    } finally {
      setExporting(false);
    }
  };

  type PresetKind = 'today' | 'yesterday' | 'd7' | 'd14' | 'd30' | 'd90' | 'y1' | 'month' | 'year' | 'all';
  const setPreset = (kind: PresetKind) => {
    setActivePreset(kind);
    const now = new Date();
    if (kind === 'today') setDay(now);
    if (kind === 'yesterday') setDay(subDays(now, 1));
    if (kind === 'd7') setDay(subDays(now, 7));
    if (kind === 'd14') setDay(subDays(now, 14));
    if (kind === 'd30') setDay(subDays(now, 30));
    if (kind === 'd90') setDay(subDays(now, 90));
    if (kind === 'y1') setDay(subDays(now, 365));
    if (kind === 'month') setDay(startOfMonth(now));
    if (kind === 'year') setDay(startOfYear(now));
    if (kind === 'all') setDay(new Date(2015, 0, 1));
  };

  const longPresets = [
    ['d7', 'Last 7 days'],
    ['d14', 'Last 14 days'],
    ['d30', 'Last 30 days'],
    ['d90', 'Last 90 days'],
    ['y1', 'Last 1 year'],
    ['month', 'This month'],
    ['year', 'This year'],
    ['all', 'All time'],
  ] as const;
  const activeLongLabel = longPresets.find(([k]) => k === activePreset)?.[1];

  const bikes = report?.bikes;
  const phones = report?.phones;
  const scTarget = Number(report?.service_centres.monthly_target) || 0;

  return (
    <div className="space-y-3">
      {/* Header + date selector */}
      <Card className="border-purple-200">
        <CardHeader className="p-3 pb-2">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <CardTitle className="text-sm font-bold">
                Agent Products &amp; Services — {isRange ? 'Cumulative Report' : 'Daily Report'}
              </CardTitle>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                {periodLabel} · {report?.timezone || 'Africa/Kampala'} ·{' '}
                {isRange ? `compared with the preceding ${num(rangeDays)} days` : 'compared with the previous day'}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <Button size="sm" variant="outline" className="h-8 text-[11px]" onClick={() => { void reportQuery.refetch(); void commissionQuery.refetch(); }}>
                <RefreshCw className={cn('h-3.5 w-3.5 mr-1', reportQuery.isFetching && 'animate-spin')} />
                Refresh
              </Button>
              <Button size="sm" className="h-8 text-[11px]" disabled={!report || exporting} onClick={handlePdf}>
                {exporting ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <FileText className="h-3.5 w-3.5 mr-1" />}
                {isRange ? 'Generate Cumulative Report (PDF)' : 'Generate Daily Report (PDF)'}
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-3 pt-0">
          <div className="flex flex-wrap items-center gap-1.5">
            {([['today', 'Today'], ['yesterday', 'Yesterday']] as const).map(([k, l]) => (
              <Button
                key={k}
                size="sm"
                variant={activePreset === k ? 'default' : 'secondary'}
                className="h-7 text-[11px]"
                onClick={() => setPreset(k)}
              >{l}</Button>
            ))}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant={activeLongLabel ? 'default' : 'secondary'} className="h-7 text-[11px]">
                  {activeLongLabel || 'Select Period'}
                  <ChevronDown className="h-3.5 w-3.5 ml-1" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="z-[200]">
                {longPresets.map(([k, l]) => (
                  <DropdownMenuItem key={k} className="text-[12px]" onClick={() => setPreset(k)}>{l}</DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <Popover>
              <PopoverTrigger asChild>
                <Button size="sm" variant="outline" className="h-7 text-[11px]">
                  <CalendarIcon className="h-3.5 w-3.5 mr-1" />From {format(day, 'dd MMM yyyy')}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0 z-[200]" align="start">
                <Calendar mode="single" selected={day} onSelect={(d) => d && setDay(d)} disabled={(d) => d > today} initialFocus className="p-3 pointer-events-auto" />
              </PopoverContent>
            </Popover>
            <span className="text-[10px] text-muted-foreground">
              {isRange ? `Totals accumulate from ${format(day, 'dd MMM yyyy')} to today` : 'Showing today only'}
            </span>
          </div>
        </CardContent>
      </Card>

      {reportQuery.isLoading && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
          {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-20 rounded-xl" />)}
        </div>
      )}

      {reportQuery.error && (
        <Card><CardContent className="p-4 text-xs text-destructive">
          {(reportQuery.error as any)?.message || 'Could not load the report'}
        </CardContent></Card>
      )}

      {report && (
        <>
          {/* KPI strip */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
            <Kpi label="New agents added" value={num(report.agents.new_today)}
              current={report.agents.new_today} previous={pop.newAgents} compareLabel={compareLabel}
              hint={`${num(report.new_agent_rows.filter(r => r.agent_type === 'main agent').length)} main · ${num(report.new_agent_rows.filter(r => r.agent_type === 'sub-agent').length)} sub`} />
            <Kpi label="Total agents" value={num(report.agents.total)}
              current={report.agents.total} previous={pop.totalAgents} compareLabel={compareLabel}
              hint={`${num(report.agents.active_today)} active`} />
            <Kpi label="Rent collected" value={apsUgx(report.rent.collected_today)}
              current={report.rent.collected_today} previous={pop.collected} compareLabel={compareLabel} />
            <Kpi label="Expected target (period)" value={apsUgx(expectedTotal)}
              current={pop.expectedTotal === undefined ? undefined : expectedTotal}
              previous={pop.expectedTotal} compareLabel={compareLabel}
              hint={`${num(report.rent.live_plans)} live plans · ${apsUgx(report.rent.daily_receivable)}/day over ${num(expectedDays)} day${expectedDays === 1 ? '' : 's'}`} />
            <Kpi label="Collection rate vs expected"
              value={`${expectedTotal > 0 ? ((Number(report.rent.collected_today) / expectedTotal) * 100).toFixed(1) : '0.0'}%`}
              hint={`collected ${apsUgx(report.rent.collected_today)} of ${apsUgx(expectedTotal)}`} />
            <Kpi label="Outstanding receivable" value={apsUgx(report.rent.outstanding)}
              current={pop.outstanding === undefined ? undefined : report.rent.outstanding}
              previous={pop.outstanding} invert compareLabel={compareLabel}
              hint={`avg ${num(report.rent.avg_days_outstanding)} days outstanding`} />
            <Kpi label="Advances issued" value={apsUgx(report.advances.issued_today)}
              current={pop.advIssued === undefined ? undefined : report.advances.issued_today}
              previous={pop.advIssued} compareLabel={compareLabel}
              hint={`${num(report.advances.issued_count)} issued · ${num(report.advances.submitted)} requested`} />
            <Kpi label="Advance outstanding" value={apsUgx(report.advances.outstanding)}
              current={pop.advOutstanding === undefined ? undefined : report.advances.outstanding}
              previous={pop.advOutstanding} invert compareLabel={compareLabel}
              hint={`${num(report.advances.active_count)} active · ${apsUgx(report.advances.deducted_today)} recovered`} />
            <Kpi label="Active service centres" value={num(report.service_centres.active_total)}
              current={pop.scActive === undefined ? report.service_centres.new_today : report.service_centres.active_total}
              previous={pop.scActive === undefined ? report.service_centres.new_prev : pop.scActive}
              compareLabel={compareLabel}
              hint={`${num(report.service_centres.new_this_month)} this month${scTarget > 0 ? ` / target ${num(scTarget)}` : ''}`} />
            <Kpi label="Bikes outstanding" value={apsUgx(bikes?.outstanding)}
              current={pop.bikes === undefined ? undefined : Number(bikes?.outstanding) || 0}
              previous={pop.bikes} invert compareLabel={compareLabel}
              hint={`${num(bikes?.issued_total)} issued · ${apsUgx(bikes?.daily_receivable)} due daily`} />
            <Kpi label="Smartphones outstanding" value={apsUgx(phones?.outstanding)}
              current={pop.phones === undefined ? undefined : Number(phones?.outstanding) || 0}
              previous={pop.phones} invert compareLabel={compareLabel}
              hint={`${num(phones?.issued_total)} issued · ${apsUgx(phones?.daily_receivable)} due daily`} />
            <Kpi label="Requests approved / rejected" value={`${num(report.advances.approved)} / ${num(report.advances.rejected)}`}
              current={pop.advApproved === undefined ? undefined : report.advances.approved}
              previous={pop.advApproved} compareLabel={compareLabel}
              hint="advance decisions" />
            <Kpi label="Pending service centres" value={num(report.service_centres.pending_total)}
              current={pop.scPending === undefined ? undefined : report.service_centres.pending_total}
              previous={pop.scPending} invert compareLabel={compareLabel}
              hint="awaiting verification" />
          </div>

          {/* Cumulative build-up */}
          <Card>
            <CardHeader className="p-3 pb-1">
              <CardTitle className="text-xs font-bold">
                Cumulative build-up to {format(today, 'dd MMM yyyy')}
              </CardTitle>
              <p className="text-[10px] text-muted-foreground">
                Totals accumulated from 7, 30, 90 and 365 days ago up to the reporting date
              </p>
            </CardHeader>
            <CardContent className="p-3 pt-1">
              {cumulativeQuery.isLoading ? (
                <Skeleton className="h-28 rounded-lg" />
              ) : cumulativeQuery.error ? (
                <p className="text-xs text-destructive">
                  {(cumulativeQuery.error as any)?.message || 'Could not load the cumulative comparison'}
                </p>
              ) : (
                <div className="overflow-x-auto rounded-lg border">
                  <table className="w-full text-xs">
                    <thead className="bg-muted/50">
                      <tr>
                        <th className="px-2 py-2 text-left font-semibold whitespace-nowrap">Window</th>
                        <th className="px-2 py-2 text-left font-semibold whitespace-nowrap">From</th>
                        <th className="px-2 py-2 text-right font-semibold whitespace-nowrap">Rent collected</th>
                        <th className="px-2 py-2 text-right font-semibold whitespace-nowrap">Collections</th>
                        <th className="px-2 py-2 text-right font-semibold whitespace-nowrap">New agents</th>
                        <th className="px-2 py-2 text-right font-semibold whitespace-nowrap">Advances issued</th>
                        <th className="px-2 py-2 text-right font-semibold whitespace-nowrap">Advances recovered</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(cumulative?.windows ?? []).length === 0 && (
                        <tr><td colSpan={7} className="px-2 py-6 text-center text-muted-foreground">No cumulative data</td></tr>
                      )}
                      {(cumulative?.windows ?? []).map(w => (
                        <tr key={w.days} className="border-t">
                          <td className="px-2 py-1.5 whitespace-nowrap font-medium">{apsWindowLabel(w.days)}</td>
                          <td className="px-2 py-1.5 whitespace-nowrap text-muted-foreground">
                            {format(new Date(`${w.from_date}T00:00:00`), 'dd MMM yyyy')}
                          </td>
                          <td className="px-2 py-1.5 text-right whitespace-nowrap">{apsUgx(w.rent_collected)}</td>
                          <td className="px-2 py-1.5 text-right whitespace-nowrap">
                            {num(w.collections_count)}
                            <span className="text-muted-foreground"> · {num(w.collecting_agents)} agents</span>
                          </td>
                          <td className="px-2 py-1.5 text-right whitespace-nowrap">{num(w.new_agents)}</td>
                          <td className="px-2 py-1.5 text-right whitespace-nowrap">
                            {apsUgx(w.advances_issued)}
                            <span className="text-muted-foreground"> · {num(w.advances_count)}</span>
                          </td>
                          <td className="px-2 py-1.5 text-right whitespace-nowrap">{apsUgx(w.advances_recovered)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Trend */}
          <Card>
            <CardHeader className="p-3 pb-1"><CardTitle className="text-xs font-bold">Rent collected — last 14 days</CardTitle></CardHeader>
            <CardContent className="p-3 pt-0 h-56">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={trend}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="label" tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 10 }} tickFormatter={(v) => `${Math.round(Number(v) / 1000)}k`} />
                  <Tooltip formatter={(v: any) => apsUgx(v)} />
                  <Bar dataKey="collected" fill="#7c3aed" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          {/* Detail tabs */}
          <Card>
            <CardContent className="p-3">
              <Tabs defaultValue="agents">
                <TabsList className="flex flex-wrap h-auto gap-1">
                  <TabsTrigger value="agents" className="text-[11px]">Agent performance</TabsTrigger>
                  <TabsTrigger value="new" className="text-[11px]">New agents</TabsTrigger>
                  <TabsTrigger value="rent" className="text-[11px]">Rent receivables</TabsTrigger>
                  <TabsTrigger value="advances" className="text-[11px]">Advances</TabsTrigger>
                  <TabsTrigger value="sc" className="text-[11px]">Service centres</TabsTrigger>
                  <TabsTrigger value="bikes" className="text-[11px]">Motor bikes</TabsTrigger>
                  <TabsTrigger value="phones" className="text-[11px]">Smartphones</TabsTrigger>
                </TabsList>

                <TabsContent value="agents" className="mt-3">
                  <PagedTable
                    rows={report.agent_float_rows}
                    searchKeys={['agent_name', 'phone', 'location']}
                    emptyLabel="No agent float or collection activity for this day"
                    columns={[
                      { key: 'agent_name', label: 'Agent' },
                      { key: 'phone', label: 'Phone' },
                      { key: 'location', label: 'Location' },
                      { key: 'float_received', label: 'Float received', align: 'right', render: r => apsUgx(r.float_received) },
                      { key: 'float_paid_out', label: 'Paid out', align: 'right', render: r => apsUgx(r.float_paid_out) },
                      { key: 'closing_float', label: 'Closing float', align: 'right', render: r => apsUgx(r.closing_float) },
                      { key: 'commission_balance', label: 'Commission', align: 'right', render: r => apsUgx(r.commission_balance) },
                      { key: 'collections_amount', label: 'Collected', align: 'right', render: r => apsUgx(r.collections_amount) },
                      { key: 'collections_count', label: 'Txns', align: 'right', render: r => num(r.collections_count) },
                    ]}
                  />
                </TabsContent>

                <TabsContent value="new" className="mt-3">
                  <PagedTable
                    rows={report.new_agent_rows}
                    searchKeys={['name', 'phone', 'location', 'agent_type', 'parent_name']}
                    emptyLabel="No new agents registered today"
                    columns={[
                      { key: 'name', label: 'Agent' },
                      { key: 'phone', label: 'Phone' },
                      { key: 'location', label: 'Location' },
                      { key: 'agent_type', label: 'Type', render: r => (
                        <Badge variant="outline" className={cn('text-[10px]', r.agent_type === 'sub-agent' && 'border-purple-400 text-purple-600')}>
                          {title(r.agent_type)}
                        </Badge>
                      ) },
                      { key: 'parent_name', label: 'Parent agent' },
                      { key: 'created_at', label: 'Added', render: r => r.created_at ? format(new Date(r.created_at), 'dd MMM yy HH:mm') : '—' },
                    ]}
                  />
                </TabsContent>

                <TabsContent value="rent" className="mt-3">
                  <PagedTable
                    rows={report.rent_rows}
                    searchKeys={['agent_name', 'phone', 'location']}
                    emptyLabel="No live rent receivables"
                    columns={[
                      { key: 'agent_name', label: 'Agent' },
                      { key: 'phone', label: 'Phone' },
                      { key: 'live_plans', label: 'Plans', align: 'right', render: r => num(r.live_plans) },
                      { key: 'daily_receivable', label: 'Daily due', align: 'right', render: r => apsUgx(r.daily_receivable) },
                      { key: 'expected_cumulative', label: 'Expected (period)', align: 'right', render: r => apsUgx(apsAgentExpectedTotal(r, expectedDays)) },
                      { key: 'collected_today', label: 'Collected today', align: 'right', render: r => apsUgx(r.collected_today) },
                      { key: 'repaid_to_date', label: 'Repaid to date', align: 'right', render: r => apsUgx(r.repaid_to_date) },
                      { key: 'outstanding', label: 'Outstanding', align: 'right', render: r => apsUgx(r.outstanding) },
                      { key: 'avg_days_outstanding', label: 'Avg days', align: 'right', render: r => num(r.avg_days_outstanding) },
                    ]}
                  />
                </TabsContent>

                <TabsContent value="advances" className="mt-3">
                  <PagedTable
                    rows={report.advance_rows}
                    searchKeys={['agent_name', 'phone', 'status']}
                    emptyLabel="No active or newly issued advances"
                    columns={[
                      { key: 'agent_name', label: 'Agent' },
                      { key: 'phone', label: 'Phone' },
                      { key: 'status', label: 'Status', render: r => <Badge variant="outline" className="text-[10px]">{title(r.status)}</Badge> },
                      { key: 'principal', label: 'Principal', align: 'right', render: r => apsUgx(r.principal) },
                      { key: 'recovered', label: 'Recovered', align: 'right', render: r => apsUgx(r.recovered) },
                      { key: 'outstanding', label: 'Outstanding', align: 'right', render: r => apsUgx(r.outstanding) },
                      { key: 'installment', label: 'Installment', align: 'right', render: r => apsUgx(r.installment) },
                      { key: 'deducted_today', label: 'Deducted today', align: 'right', render: r => apsUgx(r.deducted_today) },
                    ]}
                  />
                </TabsContent>

                <TabsContent value="sc" className="mt-3">
                  <PagedTable
                    rows={report.service_centre_rows}
                    searchKeys={['agent_name', 'agent_phone', 'location_name', 'status']}
                    emptyLabel="No service centre records"
                    columns={[
                      { key: 'agent_name', label: 'Agent' },
                      { key: 'agent_phone', label: 'Phone' },
                      { key: 'location_name', label: 'Location' },
                      { key: 'status', label: 'Status', render: r => <Badge variant="outline" className="text-[10px]">{title(r.status)}</Badge> },
                      { key: 'created_at', label: 'Created', render: r => r.created_at ? format(new Date(r.created_at), 'dd MMM yy') : '—' },
                      { key: 'verified_at', label: 'Verified', render: r => r.verified_at ? format(new Date(r.verified_at), 'dd MMM yy') : '—' },
                      { key: 'approved_at', label: 'Approved', render: r => r.approved_at ? format(new Date(r.approved_at), 'dd MMM yy') : '—' },
                    ]}
                  />
                </TabsContent>

                {(['bike', 'smartphone'] as const).map(kind => (
                  <TabsContent key={kind} value={kind === 'bike' ? 'bikes' : 'phones'} className="mt-3">
                    <PagedTable
                      rows={report.product_rows.filter(r => r.product === kind)}
                      searchKeys={['client_name', 'client_phone', 'item_name', 'payment_status']}
                      emptyLabel={kind === 'bike' ? 'No motor bikes issued' : 'No smartphones issued'}
                      columns={[
                        { key: 'client_name', label: 'Holder' },
                        { key: 'client_phone', label: 'Phone' },
                        { key: 'item_name', label: 'Item' },
                        { key: 'issued_date', label: 'Issued', render: r => {
                          if (!r.is_issued) return <span className="text-muted-foreground">Not issued</span>;
                          const d = r.issued_date ?? r.sale_date;
                          return d ? format(new Date(`${d}T00:00:00`), 'dd MMM yy') : '—';
                        } },
                        { key: 'value', label: 'Value', align: 'right', render: r => apsUgx(r.value) },
                        { key: 'paid', label: 'Paid', align: 'right', render: r => apsUgx(r.paid) },
                        { key: 'outstanding', label: 'Outstanding', align: 'right', render: r => apsUgx(r.outstanding) },
                        { key: 'daily_rate', label: 'Daily rate', align: 'right', render: r => apsUgx(r.daily_rate) },
                        { key: 'repayment_rate', label: '% repaid', align: 'right', render: r => `${num(r.repayment_rate)}%` },
                        { key: 'repayment_position', label: 'Position', render: r => (
                          <Badge variant="outline" className={cn('text-[10px]',
                            r.repayment_position === 'cleared' && 'border-emerald-500 text-emerald-600',
                            r.repayment_position === 'pending_issue' && 'border-amber-500 text-amber-600',
                            r.repayment_position === 'behind' && 'border-destructive text-destructive')}>
                            {r.repayment_position === 'pending_issue' ? 'Pending issue' : title(r.repayment_position)}
                          </Badge>
                        ) },
                      ]}
                    />
                  </TabsContent>
                ))}
              </Tabs>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
