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
  TrendingUp,
  Users,
  Wallet,
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { UserAvatar } from '@/components/UserAvatar';
import { downloadAuditPdf } from '@/lib/pdfAuditReport';
import { formatUGX } from '@/lib/rentCalculations';

const PAGE_SIZE = 15;

type RentBehaviourKpis = {
  tenants_tracked: number;
  total_collected: number;
  on_time_rate: number;
  remaining_balance: number;
  collection_count: number;
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
    kpis: {
      tenants_tracked: num(kpis.tenants_tracked),
      total_collected: num(kpis.total_collected),
      on_time_rate: num(kpis.on_time_rate),
      remaining_balance: num(kpis.remaining_balance),
      collection_count: num(kpis.collection_count),
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


export function AgentRentBehaviourPanel() {
  const [page, setPage] = useState(0);
  const [data, setData] = useState<RentBehaviourResponse>(() => asRows(null));
  const [isLoading, setIsLoading] = useState(true);
  const [isFetching, setIsFetching] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<RentBehaviourRow | null>(null);
  const [detailTab, setDetailTab] = useState('overview');

  const offset = page * PAGE_SIZE;

  const loadRows = useCallback(async (nextOffset: number, silent = false) => {
    if (!silent) setIsLoading(true);
    setIsFetching(true);
    setLoadError(null);

    try {
      const { data: payload, error } = await supabase.rpc('get_agent_ops_rent_behaviour', {
        p_limit: PAGE_SIZE,
        p_offset: nextOffset,
      });
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
    void loadRows(offset);
  }, [loadRows, offset]);

  const refetch = () => loadRows(offset, true);

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

  const handleCsv = () => downloadCsv(`agent-rent-behaviour-page-${page + 1}.csv`, exportHeaders, exportBody);

  const handlePdf = async () => {
    await downloadAuditPdf(
      `agent-rent-behaviour-page-${page + 1}.pdf`,
      exportHeaders,
      exportBody,
      {
        title: 'Agent Ops Rent Behaviour',
        subtitle: 'Tenant repayment behaviour and two-day collection-gap monitoring',
        footerLabel: 'Welile · Agent Ops',
        filters: [`Page: ${page + 1} of ${totalPages}`, `Rows: ${rows.length} of ${data.total}`],
        kpis: [
          { label: 'Tenants Tracked', value: String(data.kpis.tenants_tracked), hint: `${data.kpis.collection_count} collections` },
          { label: 'Total Collected', value: formatUGX(data.kpis.total_collected), hint: 'agent_collections' },
          { label: 'On-Time Rate', value: `${data.kpis.on_time_rate}%`, hint: 'within 2-day gap' },
          { label: 'Remaining Balance', value: formatUGX(data.kpis.remaining_balance), hint: 'still to collect' },
        ],
      },
    );
  };


  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
        <KpiCard icon={Users} label="Tenants tracked" value={String(data.kpis.tenants_tracked)} hint={`${data.kpis.collection_count} repayment events`} />
        <KpiCard icon={Wallet} label="Total collected" value={formatUGX(data.kpis.total_collected)} hint="from agent collections" />
        <KpiCard icon={Clock3} label="On-time rate" value={`${data.kpis.on_time_rate}%`} hint="paid within the 2-day gap" />
        <KpiCard icon={TrendingUp} label="Remaining balance" value={formatUGX(data.kpis.remaining_balance)} hint="amount still to be collected" />
      </div>

      <Card className="p-3 sm:p-4 space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h3 className="text-sm font-bold text-foreground">Tenant repayment behaviour</h3>
            <p className="text-xs text-muted-foreground">15 rows per fetch · agent and tenant data is joined server-side.</p>
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
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Agent</TableHead>
                <TableHead>Tenant</TableHead>
                <TableHead>Last collection</TableHead>
                <TableHead>Collected</TableHead>
                <TableHead>Remaining</TableHead>
                <TableHead>Mode</TableHead>
                <TableHead>Count</TableHead>
                <TableHead className="text-right">Open</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={`${row.tenant_id}-${row.agent_id}`} className="cursor-pointer" onClick={() => setSelected(row)}>
                  <TableCell className="min-w-[220px]">
                    <div className="flex items-center gap-3">
                      <UserAvatar avatarUrl={row.agent_avatar_url} fullName={row.agent_name} size="md" />
                      <div className="min-w-0">
                        <p className="font-semibold text-foreground truncate">{row.agent_name}</p>
                        <p className="text-xs text-muted-foreground truncate">{row.agent_phone || 'No phone'}</p>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="min-w-[210px]">
                    <div className="flex items-center gap-3">
                      <UserAvatar avatarUrl={row.tenant_avatar_url} fullName={row.tenant_name} size="md" />
                      <div className="min-w-0">
                        <p className="font-semibold text-foreground truncate">{row.tenant_name}</p>
                        <p className="text-xs text-muted-foreground truncate">{row.tenant_phone || 'No phone'}</p>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="min-w-[160px]">
                    <p className="font-medium">{formatDateTime(row.last_collection_at)}</p>
                    <p className="text-xs text-muted-foreground">typical {formatHour(row.avg_payment_hour)}</p>
                  </TableCell>
                  <TableCell className="min-w-[150px]">
                    <p className="font-bold tabular-nums">{formatUGX(row.amount_collected)}</p>
                    <p className="text-xs text-muted-foreground">last {formatUGX(row.last_collection_amount)}</p>
                  </TableCell>
                  <TableCell className="min-w-[140px] font-bold tabular-nums">{formatUGX(row.remaining_balance)}</TableCell>
                  <TableCell>
                    <div className="space-y-1">
                      <Badge variant={modeVariant(row.collection_mode)}>{row.collection_mode}</Badge>
                      <p className="text-xs text-muted-foreground">{row.on_time_rate}% on time</p>
                    </div>
                  </TableCell>
                  <TableCell className="font-bold tabular-nums">{row.collection_count}</TableCell>
                  <TableCell className="text-right">
                    <Button type="button" variant="ghost" size="icon" aria-label={`Open ${row.tenant_name}`} onClick={(event) => { event.stopPropagation(); setSelected(row); }}>
                      <Eye className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
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

