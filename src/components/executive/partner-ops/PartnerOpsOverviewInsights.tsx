import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ResponsiveContainer, BarChart, Bar, LineChart, Line, PieChart, Pie, Cell, XAxis, YAxis, Tooltip, Legend, CartesianGrid } from 'recharts';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { TrendingUp, ArrowUpFromLine, Users, PieChart as PieChartIcon } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { cn } from '@/lib/utils';

/* ─────────────── shared range presets ─────────────── */
type RangeKey = 'today' | 'tomorrow' | 'five' | 'weekend' | 'seven' | 'monthly';

const RANGES: { key: RangeKey; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: 'tomorrow', label: 'Tomorrow' },
  { key: 'five', label: '5 days' },
  { key: 'weekend', label: 'Weekend' },
  { key: 'seven', label: '7 days' },
  { key: 'monthly', label: 'Monthly' },
];

/** Days of forward window a preset needs (always counted from today). */
function rangeDays(key: RangeKey): number {
  const today = new Date();
  switch (key) {
    case 'today': return 1;
    case 'tomorrow': return 2;
    case 'five': return 5;
    case 'weekend': {
      // days from today through the coming Sunday (Sat+Sun inclusive)
      const dow = today.getDay(); // 0 Sun … 6 Sat
      return dow === 0 ? 1 : 8 - dow;
    }
    case 'seven': return 7;
    case 'monthly': return 30;
  }
}

/** Only the days a preset actually displays (tomorrow / weekend are slices). */
function sliceDays(key: RangeKey, rows: ProjectionRow[]): ProjectionRow[] {
  if (key === 'tomorrow') return rows.slice(1, 2);
  if (key === 'weekend') {
    return rows.filter((r) => {
      const d = new Date(`${r.day}T00:00:00`);
      const dow = d.getDay();
      return dow === 6 || dow === 0;
    });
  }
  return rows;
}

interface ProjectionRow {
  day: string;
  roi_payout: number;
  compounding: number;
}

function RangeFilter({ value, onChange }: { value: RangeKey; onChange: (v: RangeKey) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {RANGES.map((r) => (
        <Button
          key={r.key}
          size="sm"
          variant={value === r.key ? 'default' : 'outline'}
          className="h-7 px-2.5 text-[11px]"
          onClick={() => onChange(r.key)}
        >
          {r.label}
        </Button>
      ))}
    </div>
  );
}

const shortDay = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { day: '2-digit', month: 'short' });

/* ─────────────── 1. ROI projection graph ─────────────── */
export function PartnerRoiProjectionChart() {
  const [range, setRange] = useState<RangeKey>('today');
  const days = rangeDays(range);

  const { data, isLoading } = useQuery({
    queryKey: ['partner-ops-roi-projection', days],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_partner_forward_schedule', {
        p_days: days,
        p_streams: ['roi_payout', 'compounding'],
      });
      if (error) throw error;
      return (data as any)?.rows as ProjectionRow[] ?? [];
    },
    staleTime: 60_000,
  });

  const rows = useMemo(() => sliceDays(range, (data ?? []).map((r) => ({
    day: String(r.day),
    roi_payout: Number(r.roi_payout) || 0,
    compounding: Number(r.compounding) || 0,
  }))), [data, range]);

  const totalPayout = rows.reduce((s, r) => s + r.roi_payout, 0);
  const totalCompound = rows.reduce((s, r) => s + r.compounding, 0);

  return (
    <Card>
      <CardHeader className="pb-2 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-sm font-bold">
            <TrendingUp className="h-4 w-4 text-primary" /> Returns projection
          </CardTitle>
          <span className="text-[10px] uppercase tracking-widest text-muted-foreground">Payout vs compounded</span>
        </div>
        <RangeFilter value={range} onChange={setRange} />
        <div className="flex flex-wrap gap-4 pt-1">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">To be paid out</p>
            <p className="text-lg font-black tabular-nums text-primary">{formatUGX(totalPayout)}</p>
          </div>
          <div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">To be compounded</p>
            <p className="text-lg font-black tabular-nums text-emerald-600">{formatUGX(totalCompound)}</p>
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        {isLoading ? (
          <Skeleton className="h-56 w-full" />
        ) : rows.length === 0 ? (
          <p className="py-12 text-center text-xs text-muted-foreground">No returns fall in this window.</p>
        ) : (
          <div className="h-56 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={rows} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" vertical={false} />
                <XAxis dataKey="day" tickFormatter={shortDay} tick={{ fontSize: 10 }} />
                <YAxis tick={{ fontSize: 10 }} tickFormatter={(v) => `${Math.round(Number(v) / 1000)}k`} width={44} />
                <Tooltip
                  formatter={(v: number, n: string) => [formatUGX(Number(v)), n === 'roi_payout' ? 'Paid out' : 'Compounded']}
                  labelFormatter={(l) => shortDay(String(l))}
                />
                <Legend formatter={(v) => (v === 'roi_payout' ? 'Paid out' : 'Compounded')} wrapperStyle={{ fontSize: 11 }} />
                <Bar dataKey="roi_payout" stackId="a" fill="hsl(var(--primary))" radius={[0, 0, 0, 0]} />
                <Bar dataKey="compounding" stackId="a" fill="hsl(var(--chart-2, var(--primary)))" fillOpacity={0.55} radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/* ─────────── 1b. Self-supported vs company-supported portfolio mix ─────────── */
interface SupportMixSlice {
  name: string;
  count: number;
  amount: number;
  color: string;
}

export function PartnerSupportMixChart() {
  const { data, isLoading } = useQuery({
    queryKey: ['partner-ops-support-mix'],
    queryFn: async () => {
      const [portfoliosRes, linesRes] = await Promise.all([
        supabase
          .from('investor_portfolios')
          .select('id, investor_id, investment_amount, status')
          .eq('status', 'active')
          .limit(5000),
        supabase
          .from('partner_self_funding_lines')
          .select('partner_id, status')
          .in('status', ['idle', 'active', 'completed'])
          .limit(10000),
      ]);
      if (portfoliosRes.error) throw portfoliosRes.error;
      if (linesRes.error) throw linesRes.error;

      const selfPartners = new Set(
        ((linesRes.data ?? []) as { partner_id: string }[]).map((l) => l.partner_id),
      );

      let selfCount = 0;
      let selfAmount = 0;
      let companyCount = 0;
      let companyAmount = 0;

      for (const p of (portfoliosRes.data ?? []) as {
        investor_id: string | null;
        investment_amount: number | string;
      }[]) {
        const amount = Number(p.investment_amount) || 0;
        if (p.investor_id && selfPartners.has(p.investor_id)) {
          selfCount += 1;
          selfAmount += amount;
        } else {
          companyCount += 1;
          companyAmount += amount;
        }
      }

      return { selfCount, selfAmount, companyCount, companyAmount };
    },
    staleTime: 60_000,
  });

  const slices: SupportMixSlice[] = useMemo(
    () => [
      {
        name: 'Self supported',
        count: data?.selfCount ?? 0,
        amount: data?.selfAmount ?? 0,
        color: 'hsl(var(--primary))',
      },
      {
        name: 'Company supported',
        count: data?.companyCount ?? 0,
        amount: data?.companyAmount ?? 0,
        color: 'hsl(var(--muted-foreground))',
      },
    ],
    [data],
  );

  const totalCount = slices.reduce((s, x) => s + x.count, 0);
  const selfPct = totalCount > 0 ? Math.round((slices[0].count / totalCount) * 100) : 0;

  return (
    <Card>
      <CardHeader className="pb-2 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-sm font-bold">
            <PieChartIcon className="h-4 w-4 text-primary" /> Portfolio support mix
          </CardTitle>
          <span className="text-[10px] uppercase tracking-widest text-muted-foreground">Self vs company</span>
        </div>
        <div className="flex flex-wrap gap-4 pt-1">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Self supported</p>
            <p className="text-lg font-black tabular-nums text-primary">{slices[0].count}</p>
            <p className="text-[10px] text-muted-foreground tabular-nums">{formatUGX(slices[0].amount)}</p>
          </div>
          <div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Company supported</p>
            <p className="text-lg font-black tabular-nums">{slices[1].count}</p>
            <p className="text-[10px] text-muted-foreground tabular-nums">{formatUGX(slices[1].amount)}</p>
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        {isLoading ? (
          <Skeleton className="h-56 w-full" />
        ) : totalCount === 0 ? (
          <p className="py-12 text-center text-xs text-muted-foreground">No active portfolios to classify yet.</p>
        ) : (
          <div className="relative h-56 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={slices}
                  dataKey="count"
                  nameKey="name"
                  innerRadius="58%"
                  outerRadius="82%"
                  paddingAngle={2}
                  stroke="none"
                >
                  {slices.map((s) => (
                    <Cell key={s.name} fill={s.color} fillOpacity={s.name === 'Self supported' ? 1 : 0.45} />
                  ))}
                </Pie>
                <Tooltip
                  formatter={(v: number, n: string) => {
                    const slice = slices.find((s) => s.name === n);
                    return [`${v} portfolios · ${formatUGX(slice?.amount ?? 0)}`, n];
                  }}
                />
                <Legend wrapperStyle={{ fontSize: 11 }} />
              </PieChart>
            </ResponsiveContainer>
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center pb-6">
              <p className="text-xl font-black tabular-nums">{selfPct}%</p>
              <p className="text-[10px] uppercase tracking-widest text-muted-foreground">Self supported</p>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}



/* ─────────────── 2. Recent portfolio withdrawals ─────────────── */
interface WithdrawalRow {
  id: string;
  partner_name: string;
  amount: number;
  status: string;
  requested_at: string | null;
  processing_date: string | null;
  portfolio_code: string | null;
  portfolio_name: string | null;
  roi_amount: number | null;
  roi_percentage: number | null;
  proxy_agent_name: string | null;
}

const STATUS_STYLE: Record<string, string> = {
  pending: 'bg-amber-500/10 text-amber-600 border-amber-500/20',
  partner_ops_approved: 'bg-blue-500/10 text-blue-600 border-blue-500/20',
  coo_approved: 'bg-indigo-500/10 text-indigo-600 border-indigo-500/20',
  processed: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20',
  completed: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20',
  rejected: 'bg-destructive/10 text-destructive border-destructive/20',
};

const prettyStatus = (s: string) => s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
const dateLabel = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' }) : '—';

export function PartnerRecentWithdrawals() {
  const { data, isLoading } = useQuery({
    queryKey: ['partner-ops-recent-withdrawals'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_partner_ops_recent_withdrawals', { p_limit: 10 });
      if (error) throw error;
      return ((data as any)?.rows ?? []) as WithdrawalRow[];
    },
    staleTime: 30_000,
  });

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-bold">
          <ArrowUpFromLine className="h-4 w-4 text-primary" /> Recent portfolio withdrawals
          <span className="ml-auto text-[10px] font-normal uppercase tracking-widest text-muted-foreground">Last 10 by status</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        {isLoading ? (
          <Skeleton className="h-40 w-full" />
        ) : !data?.length ? (
          <p className="py-8 text-center text-xs text-muted-foreground">No portfolio withdrawals recorded yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-[10px] uppercase">Portfolio</TableHead>
                  <TableHead className="text-[10px] uppercase">Partner</TableHead>
                  <TableHead className="text-right text-[10px] uppercase">Amount</TableHead>
                  <TableHead className="text-right text-[10px] uppercase">Returns</TableHead>
                  <TableHead className="text-[10px] uppercase">Status</TableHead>
                  <TableHead className="text-[10px] uppercase">Proxy agent</TableHead>
                  <TableHead className="text-[10px] uppercase">Processing date</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="text-xs font-semibold">
                      {r.portfolio_name || r.portfolio_code || '—'}
                      {r.portfolio_code && r.portfolio_name && (
                        <span className="block text-[10px] font-normal text-muted-foreground">{r.portfolio_code}</span>
                      )}
                    </TableCell>
                    <TableCell className="text-xs">{r.partner_name}</TableCell>
                    <TableCell className="text-right text-xs font-bold tabular-nums">{formatUGX(Number(r.amount) || 0)}</TableCell>
                    <TableCell className="text-right text-xs tabular-nums">
                      {r.roi_amount != null ? formatUGX(Number(r.roi_amount)) : '—'}
                      {r.roi_percentage != null && (
                        <span className="block text-[10px] text-muted-foreground">{Number(r.roi_percentage)}%</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className={cn('text-[10px]', STATUS_STYLE[r.status] ?? '')}>
                        {prettyStatus(r.status || 'unknown')}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs">{r.proxy_agent_name || '—'}</TableCell>
                    <TableCell className="text-xs whitespace-nowrap">{dateLabel(r.processing_date ?? r.requested_at)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/* ─────────────── 3. Total partners trend (historical only) ─────────────── */
type PartnerTrendPreset = 'today' | 'yesterday' | 'week' | 'monthly' | 'yearly';

const PARTNER_TREND_PRESETS: { key: PartnerTrendPreset; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: 'week', label: 'This week' },
  { key: 'monthly', label: 'Monthly' },
  { key: 'yearly', label: 'Yearly' },
];

interface TotalTrendRow {
  bucket: string;
  new_count: number;
  total_count: number;
}

export function PartnerNewTrend() {
  const [preset, setPreset] = useState<PartnerTrendPreset>('today');

  const { data, isLoading } = useQuery({
    queryKey: ['partner-ops-total-trend', preset],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_partner_total_trend', { p_preset: preset });
      if (error) throw error;
      return data as any;
    },
    staleTime: 60_000,
  });

  const granularity: 'hour' | 'day' | 'month' = data?.granularity ?? 'hour';

  const rows = useMemo(
    () =>
      ((data?.rows ?? []) as TotalTrendRow[]).map((r) => ({
        bucket: String(r.bucket),
        new_count: Number(r.new_count) || 0,
        total_count: Number(r.total_count) || 0,
      })),
    [data],
  );

  const formatBucket = (iso: string) => {
    const d = new Date(iso);
    if (granularity === 'hour') return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    if (granularity === 'month') return d.toLocaleDateString(undefined, { month: 'short' });
    return d.toLocaleDateString(undefined, { day: '2-digit', month: 'short' });
  };

  const totalPartners = Number(data?.total_partners) || 0;
  const newInWindow = Number(data?.new_in_window) || 0;
  const opening = Number(data?.opening_total) || 0;
  const pct = opening > 0 ? Math.round((newInWindow / opening) * 100) : newInWindow > 0 ? 100 : 0;
  const periodLabel = PARTNER_TREND_PRESETS.find((p) => p.key === preset)?.label ?? '';

  return (
    <Card>
      <CardHeader className="pb-2 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-sm font-bold">
            <Users className="h-4 w-4 text-primary" /> Total partners trend
          </CardTitle>
          <span className="text-[10px] uppercase tracking-widest text-muted-foreground">
            {totalPartners} partners total
          </span>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {PARTNER_TREND_PRESETS.map((p) => (
            <Button
              key={p.key}
              size="sm"
              variant={preset === p.key ? 'default' : 'outline'}
              className="h-7 px-2.5 text-[11px]"
              onClick={() => setPreset(p.key)}
            >
              {p.label}
            </Button>
          ))}
        </div>
        <div className="flex items-end gap-3 pt-1">
          <p className="text-2xl font-black tabular-nums">{rows.length ? rows[rows.length - 1].total_count : totalPartners}</p>
          <span className="mb-1 rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-600">
            +{newInWindow} new ({pct}%) · {periodLabel}
          </span>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        {isLoading ? (
          <Skeleton className="h-40 w-full" />
        ) : rows.length === 0 ? (
          <p className="py-10 text-center text-xs text-muted-foreground">No partner data for this period.</p>
        ) : (
          <div className="h-40 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={rows} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" vertical={false} />
                <XAxis dataKey="bucket" tickFormatter={formatBucket} tick={{ fontSize: 10 }} minTickGap={16} />
                <YAxis allowDecimals={false} tick={{ fontSize: 10 }} width={36} domain={['dataMin', 'dataMax']} />
                <Tooltip
                  formatter={(v: number, n: string) => [`${v}`, n === 'total_count' ? 'Total partners' : 'New partners']}
                  labelFormatter={(l) => formatBucket(String(l))}
                />
                <Line
                  type="monotone"
                  dataKey="total_count"
                  stroke="hsl(var(--primary))"
                  strokeWidth={2.5}
                  dot={false}
                  activeDot={{ r: 4 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
