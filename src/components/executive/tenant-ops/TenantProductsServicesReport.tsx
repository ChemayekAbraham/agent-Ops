import { Suspense, lazy, useEffect, useMemo, useState } from 'react';
import { lazyNamed } from '@/lib/lazyWithRetry';
import { useQuery } from '@tanstack/react-query';
import { format, subDays, startOfMonth } from 'date-fns';
import { toast } from 'sonner';
import * as XLSX from 'xlsx';
import {
  ResponsiveContainer, BarChart, Bar, LineChart, Line, XAxis, YAxis, Tooltip,
  CartesianGrid, PieChart, Pie, Cell, Legend,
} from 'recharts';
import {
  ArrowDownRight, ArrowUpRight, CalendarIcon, Download, FileSpreadsheet,
  FileText, Loader2, Minus, Printer, RefreshCw, Search, Users,
} from 'lucide-react';

import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import {
  generateTenantProductsServicesPdf, pctChange, pctLabel, tpsUgx,
  type TpsReport, type TpsTenantRow,
} from '@/lib/generateTenantProductsServicesPdf';

const TenantProductsProjections = lazyNamed(() => import('./TenantProductsProjections'), 'TenantProductsProjections');
const CollectionsProjectionPanel = lazyNamed(() => import('./CollectionsProjectionPanel'), 'CollectionsProjectionPanel');

const PAGE_SIZE = 25;
const CHART_COLORS = ['#7c3aed', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#6366f1', '#ec4899', '#14b8a6'];

const toDateKey = (d: Date) => format(d, 'yyyy-MM-dd');
const num = (n: any) => Math.round(Number(n) || 0).toLocaleString();

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

function TrendPill({ current, previous, invert = false }: { current: number; previous: number; invert?: boolean }) {
  const v = pctChange(current, previous);
  const label = pctLabel(current, previous);
  const up = v !== null && v > 0;
  const flat = v === null || v === 0;
  const good = invert ? !up : up;
  const Icon = flat ? Minus : up ? ArrowUpRight : ArrowDownRight;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-semibold',
        flat
          ? 'bg-muted text-muted-foreground'
          : good
            ? 'bg-emerald-500/10 text-emerald-600'
            : 'bg-destructive/10 text-destructive',
      )}
    >
      <Icon className="h-3 w-3" />
      {label}
    </span>
  );
}

function KpiTile({
  label, value, current, previous, previousLabel, invert, tone,
}: {
  label: string;
  value: string;
  current: number;
  previous: number;
  previousLabel: string;
  invert?: boolean;
  tone?: string;
}) {
  return (
    <Card className="border">
      <CardContent className="p-3 space-y-1">
        <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground leading-tight">{label}</p>
        <p className={cn('text-lg font-bold leading-tight break-words', tone)}>{value}</p>
        <div className="flex items-center gap-1.5 flex-wrap">
          <TrendPill current={current} previous={previous} invert={invert} />
          <span className="text-[10px] text-muted-foreground">prev {previousLabel}</span>
        </div>
      </CardContent>
    </Card>
  );
}

function TenantProductsServicesDailyReport() {
  const { user } = useAuth();
  const today = useMemo(() => new Date(), []);
  const [from, setFrom] = useState<Date>(today);
  const [to, setTo] = useState<Date>(today);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [district, setDistrict] = useState('all');
  const [status, setStatus] = useState('all');
  const [payment, setPayment] = useState('all');
  const [page, setPage] = useState(1);
  const [exporting, setExporting] = useState<null | 'pdf' | 'csv' | 'xlsx' | 'print'>(null);
  const [actorName, setActorName] = useState<string>('');

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 350);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => { setPage(1); }, [debouncedSearch, district, status, payment, from, to]);

  useEffect(() => {
    if (!user?.id) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase.from('profiles').select('full_name').eq('id', user.id).maybeSingle();
      if (!cancelled) setActorName(data?.full_name || user.email || 'Tenant Ops user');
    })();
    return () => { cancelled = true; };
  }, [user?.id, user?.email]);

  const fromKey = toDateKey(from);
  const toKey = toDateKey(to);

  const reportQuery = useQuery({
    queryKey: ['tps-report', fromKey, toKey],
    queryFn: async (): Promise<TpsReport> => {
      const { data, error } = await supabase.rpc('ops_tenant_products_services_report' as any, {
        p_from: fromKey,
        p_to: toKey,
      });
      if (error) throw error;
      return data as unknown as TpsReport;
    },
    staleTime: 60_000,
  });

  const rowsQuery = useQuery({
    queryKey: ['tps-rows', fromKey, toKey, debouncedSearch, district, status, payment, page],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('ops_tenant_products_services_rows' as any, {
        p_from: fromKey,
        p_to: toKey,
        p_search: debouncedSearch || null,
        p_district: district,
        p_agent: null,
        p_status: status,
        p_payment: payment,
        p_limit: PAGE_SIZE,
        p_offset: (page - 1) * PAGE_SIZE,
      });
      if (error) throw error;
      return (data || []) as any[];
    },
    staleTime: 30_000,
  });

  const report = reportQuery.data;
  const rows = rowsQuery.data || [];
  const totalRows = rows.length ? Number(rows[0].total_count) || 0 : 0;
  const totalPages = Math.max(1, Math.ceil(totalRows / PAGE_SIZE));

  const periodLabel = fromKey === toKey
    ? format(from, 'dd MMM yyyy')
    : `${format(from, 'dd MMM yyyy')} → ${format(to, 'dd MMM yyyy')}`;
  const prevLabel = report
    ? (report.period.previous_from === report.period.previous_to
      ? format(new Date(`${report.period.previous_from}T00:00:00`), 'dd MMM')
      : `${format(new Date(`${report.period.previous_from}T00:00:00`), 'dd MMM')}–${format(new Date(`${report.period.previous_to}T00:00:00`), 'dd MMM')}`)
    : '—';

  const districtOptions = useMemo(
    () => (report?.districts || []).map(d => d.district).filter(Boolean),
    [report],
  );

  const setPreset = (kind: 'today' | 'yesterday' | 'last7' | 'last30' | 'month') => {
    const now = new Date();
    if (kind === 'today') { setFrom(now); setTo(now); }
    if (kind === 'yesterday') { const d = subDays(now, 1); setFrom(d); setTo(d); }
    if (kind === 'last7') { setFrom(subDays(now, 6)); setTo(now); }
    if (kind === 'last30') { setFrom(subDays(now, 29)); setTo(now); }
    if (kind === 'month') { setFrom(startOfMonth(now)); setTo(now); }
  };

  /** Pull every filtered row (server-side paged, never truncated) for exports. */
  const fetchAllRows = async (): Promise<TpsTenantRow[]> => {
    const out: any[] = [];
    const PAGE = 1000;
    for (let offset = 0; ; offset += PAGE) {
      const { data, error } = await supabase.rpc('ops_tenant_products_services_rows' as any, {
        p_from: fromKey,
        p_to: toKey,
        p_search: debouncedSearch || null,
        p_district: district,
        p_agent: null,
        p_status: status,
        p_payment: payment,
        p_limit: PAGE,
        p_offset: offset,
      });
      if (error) throw error;
      const batch = (data || []) as any[];
      out.push(...batch);
      if (batch.length < PAGE) break;
      if (out.length >= 50_000) break;
    }
    return out as TpsTenantRow[];
  };

  const exportRowsToSheet = (all: TpsTenantRow[]) => all.map(r => ({
    Tenant: r.tenant_name,
    Phone: r.tenant_phone || '',
    District: r.district || '',
    Agent: r.agent_name || '',
    'Application status': (r.application_status || '').replace(/_/g, ' '),
    'New in period': r.is_new_in_period ? 'Yes' : 'No',
    'Collected (UGX)': Math.round(Number(r.paid_in_period) || 0),
    Payments: Number(r.payments_in_period) || 0,
    'Landlord payables (UGX)': Math.round(Number(r.payables_in_period) || 0),
    'Outstanding (UGX)': Math.round(Number(r.outstanding) || 0),
  }));

  const auditRows = (kind: string) => ([
    { Field: 'Report', Value: 'Tenant Products & Services — Daily Report' },
    { Field: 'Reporting period', Value: periodLabel },
    { Field: 'Timezone', Value: report?.period.timezone || 'Africa/Kampala' },
    { Field: 'Generated at', Value: format(new Date(), 'dd MMM yyyy HH:mm:ss') },
    { Field: 'Reported by', Value: actorName || 'Tenant Ops user' },
    { Field: 'Export type', Value: kind },
    { Field: 'Source', Value: 'profiles + user_roles (tenants), rent_requests (applications), agent_collections (collections), landlord_payouts (payables)' },
  ]);

  const handleExport = async (kind: 'pdf' | 'csv' | 'xlsx' | 'print') => {
    if (!report) return;
    setExporting(kind);
    try {
      const all = await fetchAllRows();
      const stamp = fromKey === toKey ? fromKey : `${fromKey}_to_${toKey}`;

      if (kind === 'pdf' || kind === 'print') {
        const blob = generateTenantProductsServicesPdf({
          report,
          rows: all,
          actor: actorName || 'Tenant Ops user',
          exportType: kind === 'print' ? 'Print' : 'PDF',
        });
        if (kind === 'print') {
          const url = URL.createObjectURL(blob);
          const win = window.open(url, '_blank');
          if (!win) toast.error('Allow pop-ups to print the report');
          setTimeout(() => URL.revokeObjectURL(url), 60_000);
        } else {
          downloadBlob(blob, `tenant-products-services-${stamp}.pdf`);
        }
      } else {
        const summary = [
          { Metric: 'New Tenants Added', Value: report.current.new_tenants, Previous: report.previous.new_tenants, Change: pctLabel(report.current.new_tenants, report.previous.new_tenants) },
          { Metric: 'Active Tenants (paid in period)', Value: report.current.active_tenants, Previous: report.previous.active_tenants, Change: pctLabel(report.current.active_tenants, report.previous.active_tenants) },
          { Metric: 'Total Tenants (register)', Value: report.current.total_tenants, Previous: report.previous.total_tenants, Change: pctLabel(report.current.total_tenants, report.previous.total_tenants) },
          { Metric: 'Applications', Value: report.current.applications, Previous: report.previous.applications, Change: pctLabel(report.current.applications, report.previous.applications) },
          { Metric: 'Accepted', Value: report.current.accepted, Previous: report.previous.accepted, Change: pctLabel(report.current.accepted, report.previous.accepted) },
          { Metric: 'Rejected', Value: report.current.rejected, Previous: report.previous.rejected, Change: pctLabel(report.current.rejected, report.previous.rejected) },
          { Metric: 'Total Rent Collected (receivables, UGX)', Value: Math.round(Number(report.current.collected) || 0), Previous: Math.round(Number(report.previous.collected) || 0), Change: pctLabel(report.current.collected, report.previous.collected) },
          { Metric: 'Landlord Payables (UGX)', Value: Math.round(Number(report.current.payables) || 0), Previous: Math.round(Number(report.previous.payables) || 0), Change: pctLabel(report.current.payables, report.previous.payables) },
        ];
        const detail = exportRowsToSheet(all);

        if (kind === 'csv') {
          const ws = XLSX.utils.json_to_sheet(detail);
          const csv = XLSX.utils.sheet_to_csv(ws);
          const head = [
            'Tenant Products & Services — Daily Report',
            `Period,${periodLabel}`,
            `Generated,${format(new Date(), 'dd MMM yyyy HH:mm:ss')}`,
            `Reported by,${actorName || 'Tenant Ops user'}`,
            ...summary.map(s => `${s.Metric},${s.Value},prev ${s.Previous},${s.Change}`),
            '',
          ].join('\n');
          downloadBlob(new Blob([`${head}\n${csv}`], { type: 'text/csv;charset=utf-8' }), `tenant-products-services-${stamp}.csv`);
        } else {
          const wb = XLSX.utils.book_new();
          XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summary), 'Summary');
          XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(report.series), 'Daily');
          XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(detail), 'Tenants');
          XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(auditRows('XLSX')), 'Audit');
          const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
          downloadBlob(
            new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
            `tenant-products-services-${stamp}.xlsx`,
          );
        }
      }
      toast.success(`Report exported (${all.length.toLocaleString()} tenant record${all.length === 1 ? '' : 's'})`);
    } catch (err: any) {
      toast.error(err?.message || 'Export failed');
    } finally {
      setExporting(null);
    }
  };

  const series = (report?.series || []).map(s => ({
    ...s,
    label: format(new Date(`${s.day}T00:00:00`), 'dd MMM'),
    collected: Number(s.collected) || 0,
    payables: Number(s.payables) || 0,
  }));

  const funnel = report ? [
    { stage: 'Applications', value: report.current.applications },
    { stage: 'Accepted', value: report.current.accepted },
    { stage: 'Rejected', value: report.current.rejected },
  ] : [];

  const statusPie = (report?.application_status || []).map(a => ({
    name: String(a.status || '—').replace(/_/g, ' '),
    value: Number(a.n) || 0,
  }));

  return (
    <div className="space-y-3">
      {/* ===== Header + filters ===== */}
      <Card className="border-purple-200">
        <CardHeader className="p-3 pb-2">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <CardTitle className="text-sm font-bold">Tenant Products &amp; Services — Daily Report</CardTitle>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                {periodLabel} · {report?.period.timezone || 'Africa/Kampala'} · compared with {prevLabel}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <Button size="sm" variant="outline" className="h-8 text-[11px]" onClick={() => { void reportQuery.refetch(); void rowsQuery.refetch(); }}>
                <RefreshCw className={cn('h-3.5 w-3.5 mr-1', (reportQuery.isFetching || rowsQuery.isFetching) && 'animate-spin')} />
                Refresh
              </Button>
              <Button size="sm" className="h-8 text-[11px]" disabled={!report || exporting !== null} onClick={() => void handleExport('pdf')}>
                {exporting === 'pdf' ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <FileText className="h-3.5 w-3.5 mr-1" />}
                PDF
              </Button>
              <Button size="sm" variant="outline" className="h-8 text-[11px]" disabled={!report || exporting !== null} onClick={() => void handleExport('csv')}>
                {exporting === 'csv' ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Download className="h-3.5 w-3.5 mr-1" />}
                CSV
              </Button>
              <Button size="sm" variant="outline" className="h-8 text-[11px]" disabled={!report || exporting !== null} onClick={() => void handleExport('xlsx')}>
                {exporting === 'xlsx' ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <FileSpreadsheet className="h-3.5 w-3.5 mr-1" />}
                XLSX
              </Button>
              <Button size="sm" variant="outline" className="h-8 text-[11px]" disabled={!report || exporting !== null} onClick={() => void handleExport('print')}>
                {exporting === 'print' ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Printer className="h-3.5 w-3.5 mr-1" />}
                Print
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-3 pt-0 space-y-2">
          <div className="flex flex-wrap items-center gap-1.5">
            {([['today', 'Today'], ['yesterday', 'Yesterday'], ['last7', 'Last 7 days'], ['last30', 'Last 30 days'], ['month', 'This month']] as const).map(([k, l]) => (
              <Button key={k} size="sm" variant="secondary" className="h-7 text-[11px]" onClick={() => setPreset(k)}>{l}</Button>
            ))}
            <Popover>
              <PopoverTrigger asChild>
                <Button size="sm" variant="outline" className="h-7 text-[11px]">
                  <CalendarIcon className="h-3.5 w-3.5 mr-1" />From: {format(from, 'dd MMM yyyy')}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0 z-[200]" align="start">
                <Calendar mode="single" selected={from} onSelect={(d) => d && setFrom(d)} initialFocus />
              </PopoverContent>
            </Popover>
            <Popover>
              <PopoverTrigger asChild>
                <Button size="sm" variant="outline" className="h-7 text-[11px]">
                  <CalendarIcon className="h-3.5 w-3.5 mr-1" />To: {format(to, 'dd MMM yyyy')}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0 z-[200]" align="start">
                <Calendar mode="single" selected={to} onSelect={(d) => d && setTo(d)} initialFocus />
              </PopoverContent>
            </Popover>
          </div>
          <p className="text-[10px] text-muted-foreground">
            Every KPI, chart, table row and export below is driven by this single date window — dashboard and exports can never disagree.
          </p>
        </CardContent>
      </Card>

      {/* ===== Core mandatory metrics ===== */}
      {reportQuery.isLoading ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2.5">
          {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-[86px] rounded-xl" />)}
        </div>
      ) : reportQuery.error ? (
        <Card className="border-destructive/30">
          <CardContent className="p-4 text-sm text-destructive">
            {(reportQuery.error as any)?.message || 'Could not load the report.'}
          </CardContent>
        </Card>
      ) : report ? (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2.5">
            <KpiTile label="New Tenants Added" value={num(report.current.new_tenants)} current={report.current.new_tenants} previous={report.previous.new_tenants} previousLabel={prevLabel} />
            <KpiTile label="Active Tenants (paid rent)" value={num(report.current.active_tenants)} current={report.current.active_tenants} previous={report.previous.active_tenants} previousLabel={prevLabel} tone="text-emerald-600" />
            <KpiTile label="Total Tenants" value={num(report.current.total_tenants)} current={report.current.total_tenants} previous={report.previous.total_tenants} previousLabel={prevLabel} />
            <KpiTile label="Applications" value={num(report.current.applications)} current={report.current.applications} previous={report.previous.applications} previousLabel={prevLabel} />
            <KpiTile label="Accepted" value={num(report.current.accepted)} current={report.current.accepted} previous={report.previous.accepted} previousLabel={prevLabel} tone="text-emerald-600" />
            <KpiTile label="Rejected" value={num(report.current.rejected)} current={report.current.rejected} previous={report.previous.rejected} previousLabel={prevLabel} invert tone="text-destructive" />
            <KpiTile label="Rent Collected / Receivables" value={tpsUgx(report.current.collected)} current={Number(report.current.collected)} previous={Number(report.previous.collected)} previousLabel={prevLabel} tone="text-emerald-600" />
            <KpiTile label="Landlord Payables" value={tpsUgx(report.current.payables)} current={Number(report.current.payables)} previous={Number(report.previous.payables)} previousLabel={prevLabel} invert tone="text-amber-600" />
          </div>

          {/* ===== Financial detail ===== */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-2.5">
            <Card>
              <CardHeader className="p-3 pb-1"><CardTitle className="text-xs font-bold">Receivables — money collected from tenants</CardTitle></CardHeader>
              <CardContent className="p-3 pt-0 space-y-1.5 text-[12px]">
                <div className="flex justify-between"><span className="text-muted-foreground">Total rent collected</span><span className="font-bold">{tpsUgx(report.current.collected)}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Paying tenants</span><span className="font-semibold">{num(report.current.active_tenants)}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Payments recorded</span><span className="font-semibold">{num(report.current.payments)}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Average per paying tenant</span><span className="font-semibold">{tpsUgx(report.current.active_tenants ? Number(report.current.collected) / report.current.active_tenants : 0)}</span></div>
                <div className="flex justify-between items-center"><span className="text-muted-foreground">vs previous period ({tpsUgx(report.previous.collected)})</span><TrendPill current={Number(report.current.collected)} previous={Number(report.previous.collected)} /></div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="p-3 pb-1"><CardTitle className="text-xs font-bold">Payables — money due to landlords</CardTitle></CardHeader>
              <CardContent className="p-3 pt-0 space-y-1.5 text-[12px]">
                <div className="flex justify-between"><span className="text-muted-foreground">Landlord payables raised</span><span className="font-bold">{tpsUgx(report.current.payables)}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Tenants / houses affected</span><span className="font-semibold">{num(report.current.payable_tenants)}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Outstanding payables (all time)</span><span className="font-semibold">{tpsUgx(report.outstanding_payables)}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Outstanding payout count</span><span className="font-semibold">{num(report.outstanding_payables_count)}</span></div>
                <div className="flex justify-between items-center"><span className="text-muted-foreground">vs previous period ({tpsUgx(report.previous.payables)})</span><TrendPill current={Number(report.current.payables)} previous={Number(report.previous.payables)} invert /></div>
              </CardContent>
            </Card>
          </div>

          {/* ===== Charts ===== */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-2.5">
            <Card>
              <CardHeader className="p-3 pb-1"><CardTitle className="text-xs font-bold">Tenant growth &amp; activity</CardTitle></CardHeader>
              <CardContent className="p-2 pt-0 h-[210px]">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={series} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                    <XAxis dataKey="label" tick={{ fontSize: 10 }} />
                    <YAxis tick={{ fontSize: 10 }} />
                    <Tooltip contentStyle={{ fontSize: 11 }} />
                    <Legend wrapperStyle={{ fontSize: 10 }} />
                    <Line type="monotone" dataKey="new_tenants" name="New tenants" stroke="#7c3aed" strokeWidth={2} dot={false} />
                    <Line type="monotone" dataKey="paid_tenants" name="Paid tenants" stroke="#10b981" strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="p-3 pb-1"><CardTitle className="text-xs font-bold">Receivables vs payables</CardTitle></CardHeader>
              <CardContent className="p-2 pt-0 h-[210px]">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={series} margin={{ top: 8, right: 8, left: -8, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                    <XAxis dataKey="label" tick={{ fontSize: 10 }} />
                    <YAxis tick={{ fontSize: 9 }} tickFormatter={(v) => `${Math.round(Number(v) / 1000)}k`} />
                    <Tooltip contentStyle={{ fontSize: 11 }} formatter={(v: any) => tpsUgx(v)} />
                    <Legend wrapperStyle={{ fontSize: 10 }} />
                    <Bar dataKey="collected" name="Collected" fill="#10b981" radius={[3, 3, 0, 0]} />
                    <Bar dataKey="payables" name="Payables" fill="#f59e0b" radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="p-3 pb-1"><CardTitle className="text-xs font-bold">Applications funnel</CardTitle></CardHeader>
              <CardContent className="p-2 pt-0 h-[210px]">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={funnel} layout="vertical" margin={{ top: 8, right: 16, left: 24, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                    <XAxis type="number" tick={{ fontSize: 10 }} />
                    <YAxis type="category" dataKey="stage" tick={{ fontSize: 10 }} width={72} />
                    <Tooltip contentStyle={{ fontSize: 11 }} />
                    <Bar dataKey="value" name="Requests" radius={[0, 3, 3, 0]}>
                      {funnel.map((_, i) => <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="p-3 pb-1"><CardTitle className="text-xs font-bold">Application status distribution</CardTitle></CardHeader>
              <CardContent className="p-2 pt-0 h-[210px]">
                {statusPie.length ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie data={statusPie} dataKey="value" nameKey="name" outerRadius={72} label={{ fontSize: 9 }}>
                        {statusPie.map((_, i) => <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
                      </Pie>
                      <Tooltip contentStyle={{ fontSize: 11 }} />
                      <Legend wrapperStyle={{ fontSize: 10 }} />
                    </PieChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="h-full grid place-items-center text-[11px] text-muted-foreground">No applications in this period</div>
                )}
              </CardContent>
            </Card>
          </div>

          {/* ===== Tenant table ===== */}
          <Card>
            <CardHeader className="p-3 pb-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <CardTitle className="text-xs font-bold flex items-center gap-1.5">
                  <Users className="h-3.5 w-3.5" />
                  Tenant activity in period
                  <Badge variant="secondary" className="text-[10px]">{num(totalRows)} record{totalRows === 1 ? '' : 's'}</Badge>
                </CardTitle>
                <div className="flex flex-wrap items-center gap-1.5">
                  <div className="relative">
                    <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                    <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Tenant, phone, agent, district" className="h-8 pl-7 text-[11px] w-full sm:w-56" />
                  </div>
                  <Select value={district} onValueChange={setDistrict}>
                    <SelectTrigger className="h-8 w-[130px] text-[11px]"><SelectValue placeholder="District" /></SelectTrigger>
                    <SelectContent className="z-[200]">
                      <SelectItem value="all">All districts</SelectItem>
                      {districtOptions.map(d => <SelectItem key={d} value={d}>{d}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <Select value={status} onValueChange={setStatus}>
                    <SelectTrigger className="h-8 w-[140px] text-[11px]"><SelectValue placeholder="Application status" /></SelectTrigger>
                    <SelectContent className="z-[200]">
                      <SelectItem value="all">All statuses</SelectItem>
                      {(report.application_status || []).map(a => (
                        <SelectItem key={a.status} value={a.status}>{String(a.status).replace(/_/g, ' ')}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select value={payment} onValueChange={setPayment}>
                    <SelectTrigger className="h-8 w-[120px] text-[11px]"><SelectValue placeholder="Payment" /></SelectTrigger>
                    <SelectContent className="z-[200]">
                      <SelectItem value="all">Paid &amp; unpaid</SelectItem>
                      <SelectItem value="paid">Paid in period</SelectItem>
                      <SelectItem value="unpaid">No payment</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              {rowsQuery.isLoading ? (
                <div className="p-3 space-y-2">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-9" />)}</div>
              ) : rows.length === 0 ? (
                <p className="p-6 text-center text-[12px] text-muted-foreground">No tenant activity matches these filters for {periodLabel}.</p>
              ) : (
                <>
                  {/* Desktop table */}
                  <div className="hidden md:block overflow-x-auto">
                    <table className="w-full text-[11.5px]">
                      <thead className="bg-muted/60">
                        <tr className="text-left">
                          <th className="p-2 font-bold">Tenant</th>
                          <th className="p-2 font-bold">District</th>
                          <th className="p-2 font-bold">Agent</th>
                          <th className="p-2 font-bold">Status</th>
                          <th className="p-2 font-bold text-right">Collected</th>
                          <th className="p-2 font-bold text-right">Payables</th>
                          <th className="p-2 font-bold text-right">Outstanding</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((r: any) => (
                          <tr key={r.tenant_id} className="border-t">
                            <td className="p-2">
                              <span className="font-semibold">{r.tenant_name}</span>
                              {r.is_new_in_period && <Badge className="ml-1.5 text-[9px] px-1 py-0 bg-purple-500 text-white">new</Badge>}
                              <span className="block text-[10px] text-muted-foreground">{r.tenant_phone || '—'}</span>
                            </td>
                            <td className="p-2">{r.district || '—'}</td>
                            <td className="p-2">{r.agent_name || '—'}</td>
                            <td className="p-2 capitalize">{String(r.application_status || '—').replace(/_/g, ' ')}</td>
                            <td className="p-2 text-right font-semibold text-emerald-600">{tpsUgx(r.paid_in_period)}</td>
                            <td className="p-2 text-right">{tpsUgx(r.payables_in_period)}</td>
                            <td className="p-2 text-right">{tpsUgx(r.outstanding)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {/* Mobile cards */}
                  <div className="md:hidden divide-y">
                    {rows.map((r: any) => (
                      <div key={r.tenant_id} className="p-3 space-y-1">
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <p className="text-[12.5px] font-semibold leading-tight">{r.tenant_name}</p>
                            <p className="text-[10.5px] text-muted-foreground">{r.tenant_phone || '—'} · {r.district || '—'}</p>
                          </div>
                          {r.is_new_in_period && <Badge className="text-[9px] px-1 py-0 bg-purple-500 text-white">new</Badge>}
                        </div>
                        <div className="grid grid-cols-2 gap-1 text-[10.5px]">
                          <span className="text-muted-foreground">Agent</span><span className="text-right">{r.agent_name || '—'}</span>
                          <span className="text-muted-foreground">Status</span><span className="text-right capitalize">{String(r.application_status || '—').replace(/_/g, ' ')}</span>
                          <span className="text-muted-foreground">Collected</span><span className="text-right font-semibold text-emerald-600">{tpsUgx(r.paid_in_period)}</span>
                          <span className="text-muted-foreground">Payables</span><span className="text-right">{tpsUgx(r.payables_in_period)}</span>
                          <span className="text-muted-foreground">Outstanding</span><span className="text-right">{tpsUgx(r.outstanding)}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="flex items-center justify-between gap-2 p-2.5 border-t">
                    <p className="text-[10.5px] text-muted-foreground">
                      Page {page} of {totalPages} · {num(totalRows)} matching tenants (server-side paged, nothing truncated)
                    </p>
                    <div className="flex gap-1.5">
                      <Button size="sm" variant="outline" className="h-7 text-[11px]" disabled={page <= 1} onClick={() => setPage(p => Math.max(1, p - 1))}>Prev</Button>
                      <Button size="sm" variant="outline" className="h-7 text-[11px]" disabled={page >= totalPages} onClick={() => setPage(p => Math.min(totalPages, p + 1))}>Next</Button>
                    </div>
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          {/* ===== Audit trail ===== */}
          <Card className="bg-muted/40">
            <CardContent className="p-3 text-[10.5px] text-muted-foreground space-y-0.5">
              <p><span className="font-semibold text-foreground">Report:</span> Tenant Products &amp; Services — Daily Report</p>
              <p><span className="font-semibold text-foreground">Reporting period:</span> {periodLabel} ({report.period.timezone}) · previous comparison {prevLabel}</p>
              <p><span className="font-semibold text-foreground">Generated:</span> {format(new Date(report.generated_at), 'dd MMM yyyy HH:mm:ss')}</p>
              <p><span className="font-semibold text-foreground">Reported by:</span> {actorName || 'Tenant Ops user'}</p>
              <p><span className="font-semibold text-foreground">Sources:</span> tenant register (profiles + tenant role) · applications (rent_requests) · collections (agent_collections) · payables (landlord_payouts)</p>
              <p><span className="font-semibold text-foreground">Tenant register total:</span> {num(report.tenant_register_total)} tenant accounts — the report is never capped to a page of records.</p>
              <p>A system-generated copy of this report is emailed every midnight (Africa/Kampala) with the PDF attached.</p>
            </CardContent>
          </Card>
        </>
      ) : null}
    </div>
  );
}

export function TenantProductsServicesReport() {
  const [tab, setTab] = useState<'daily' | 'projections' | 'collections-forecast'>('daily');

  return (
    <Tabs value={tab} onValueChange={(v) => setTab(v as 'daily' | 'projections' | 'collections-forecast')} className="space-y-3">
      <TabsList className="h-8">
        <TabsTrigger value="daily" className="h-7 text-[11px]">Daily Report</TabsTrigger>
        <TabsTrigger value="projections" className="h-7 text-[11px]">Projections</TabsTrigger>
        <TabsTrigger value="collections-forecast" className="h-7 text-[11px]">Collections Forecast</TabsTrigger>
      </TabsList>
      <TabsContent value="daily" className="mt-0">
        <TenantProductsServicesDailyReport />
      </TabsContent>
      <TabsContent value="projections" className="mt-0">
        {tab === 'projections' && (
          <Suspense fallback={<Skeleton className="h-[320px] rounded-xl" />}>
            <TenantProductsProjections />
          </Suspense>
        )}
      </TabsContent>
      <TabsContent value="collections-forecast" className="mt-0">
        {tab === 'collections-forecast' && (
          <Suspense fallback={<Skeleton className="h-[320px] rounded-xl" />}>
            <CollectionsProjectionPanel />
          </Suspense>
        )}
      </TabsContent>
    </Tabs>
  );
}

export default TenantProductsServicesReport;
