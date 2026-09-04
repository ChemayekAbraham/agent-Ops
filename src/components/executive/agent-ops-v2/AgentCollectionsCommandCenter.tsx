import { useMemo, useState, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/rentCalculations';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';
import {
  ResponsiveContainer, AreaChart, Area, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, Cell,
} from 'recharts';
import {
  CalendarIcon, Clock, TrendingUp, Users, Banknote, Target, RefreshCw, Activity, Search, FileDown, AlertTriangle,
} from 'lucide-react';
import { ComprehensiveReportButton } from './ComprehensiveReportButton';
import { NextSevenDaysExpected } from './NextSevenDaysExpected';
import { TenantsOwingDialog } from './TenantsOwingDialog';
import { format, parseISO, startOfDay, endOfDay, subDays, startOfMonth, startOfYear, addDays } from 'date-fns';
import type { DateRange } from 'react-day-picker';
import { toast } from 'sonner';
import { generateAgentCollectionsStatementPdf } from '@/lib/agentCollectionsStatementPdf';

type PresetKey = 'today' | 'yesterday' | 'five' | 'next7' | 'weekend' | 'month' | 'year' | 'custom';

const PRESETS: { key: PresetKey; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: 'five', label: 'Last 5 days' },
  { key: 'next7', label: 'Next 7 days' },
  { key: 'weekend', label: 'Weekend' },
  { key: 'month', label: 'This month' },
  { key: 'year', label: 'This year' },
  { key: 'custom', label: 'Custom range' },
];

/** Most recent Saturday + Sunday pair (inclusive), based on local device date. */
function lastWeekend(now: Date): { start: Date; end: Date } {
  // Walk back to the most recent Saturday (day 6)
  let sat = startOfDay(now);
  while (sat.getDay() !== 6) sat = subDays(sat, 1);
  return { start: sat, end: endOfDay(addDays(sat, 1)) };
}

function resolveRange(preset: PresetKey, custom?: DateRange): { start: Date; end: Date; bucket: string } {
  const now = new Date();
  switch (preset) {
    case 'today':
      return { start: startOfDay(now), end: endOfDay(now), bucket: 'hour' };
    case 'yesterday': {
      const y = subDays(now, 1);
      return { start: startOfDay(y), end: endOfDay(y), bucket: 'hour' };
    }
    case 'five':
      return { start: startOfDay(subDays(now, 4)), end: endOfDay(now), bucket: 'day' };
    case 'next7':
      // Forward-looking tab: the window is tomorrow → +7 days. The command
      // center RPC is not queried for it; NextSevenDaysExpected renders instead.
      return { start: startOfDay(addDays(now, 1)), end: endOfDay(addDays(now, 7)), bucket: 'day' };
    case 'weekend': {
      const w = lastWeekend(now);
      return { start: w.start, end: w.end, bucket: 'hour' };
    }
    case 'month':
      return { start: startOfMonth(now), end: endOfDay(now), bucket: 'day' };
    case 'year':
      return { start: startOfYear(now), end: endOfDay(now), bucket: 'month' };
    case 'custom': {
      const from = custom?.from ? startOfDay(custom.from) : startOfDay(now);
      const to = custom?.to ? endOfDay(custom.to) : endOfDay(custom?.from ?? now);
      const days = Math.max(1, Math.round((to.getTime() - from.getTime()) / 86400000));
      const bucket = days <= 1 ? 'hour' : days <= 62 ? 'day' : 'month';
      return { start: from, end: to, bucket };
    }
  }
}

interface CommandCenterData {
  range: { start: string; end: string; bucket: string };
  totals: {
    collected: number; collections_count: number; active_agents: number; tenants_paid: number;
    avg_collection: number; requests_count: number; requests_amount: number; days: number;
    expected_due: number; defaulted_to_date: number; defaulted_plans: number; defaulted_as_of: string; span_days: number;
  };
  series: { bucket: string; collected: number; collections_count: number; requests_amount: number; requests_count: number }[];
  peak_hours: { hour: number; amount: number; count: number }[];
  agents: {
    agent_id: string; name: string; phone: string | null; avatar_url: string | null;
    collected: number; collections_count: number; tenants_paid: number; active_tenants: number;
    expected_daily: number; expected: number; expected_source: 'history' | 'projected';
    last_collection_at: string | null;
  }[];
  expected_daily: { day: string; expected_ugx: number; plans: number; elapsed: boolean }[];
  generated_at: string;
}

const num = (v: any) => Number(v ?? 0);
const compact = (v: number) =>
  v >= 1_000_000 ? `${(v / 1_000_000).toFixed(1)}M` : v >= 1_000 ? `${Math.round(v / 1_000)}K` : `${v}`;
/** EAT hour in 12-hour format, e.g. 0 -> "12 AM", 13 -> "1 PM" */
const hourLabel = (h: number) => {
  const suffix = h < 12 ? 'AM' : 'PM';
  const base = h % 12 === 0 ? 12 : h % 12;
  return `${base} ${suffix}`;
};

/** Convert an RPC bucket string to a friendly, EAT-aware label. */
function bucketLabel(bucketStr: string, bucket: string): string {
  if (bucket === 'hour') {
    const h = Number(bucketStr.slice(11, 13));
    return Number.isFinite(h) ? hourLabel(h) : bucketStr.slice(11, 16);
  }
  if (bucket === 'month') {
    const d = new Date(`${bucketStr.slice(0, 7)}-01T00:00:00`);
    return isNaN(d.getTime()) ? bucketStr : format(d, 'MMM yyyy');
  }
  const d = new Date(`${bucketStr.slice(0, 10)}T00:00:00`);
  return isNaN(d.getTime()) ? bucketStr : format(d, 'EEEE d MMM');
}

export function AgentCollectionsCommandCenter() {
  const [preset, setPreset] = useState<PresetKey>('today');
  const [custom, setCustom] = useState<DateRange | undefined>();
  const [search, setSearch] = useState('');
  const [visibleAgents, setVisibleAgents] = useState(10);
  const [owingOpen, setOwingOpen] = useState(false);
  const qc = useQueryClient();

  const { start, end, bucket } = useMemo(() => resolveRange(preset, custom), [preset, custom]);
  const key = ['agent-collections-command-center', start.toISOString(), end.toISOString(), bucket];

  const { data, isLoading, isFetching, error, refetch } = useQuery({
    queryKey: key,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_agent_collections_command_center', {
        p_start: start.toISOString(),
        p_end: end.toISOString(),
        p_bucket: bucket,
      });
      if (error) throw error;
      return data as unknown as CommandCenterData;
    },
    enabled: preset !== 'next7',
    refetchInterval: 60_000,
    staleTime: 20_000,
  });

  // Live refresh when collections or rent requests change
  useEffect(() => {
    const channel = supabase
      .channel('agent-collections-command-center')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'agent_collections' }, () => {
        qc.invalidateQueries({ queryKey: ['agent-collections-command-center'] });
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'rent_requests' }, () => {
        qc.invalidateQueries({ queryKey: ['agent-collections-command-center'] });
      })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [qc]);

  const totals = data?.totals;
  const series = (data?.series ?? []).map(s => ({
    label: bucketLabel(s.bucket, bucket),
    collected: num(s.collected),
    requests: num(s.requests_amount),
    collectionsCount: num(s.collections_count),
    requestsCount: num(s.requests_count),
  }));
  const peak = (data?.peak_hours ?? []).map(h => ({ ...h, amount: num(h.amount), count: num(h.count), label: hourLabel(h.hour) }));
  const peakMax = Math.max(1, ...peak.map(p => p.amount));
  const topHour = peak.reduce((a, b) => (b.amount > (a?.amount ?? -1) ? b : a), peak[0]);

  const agents = useMemo(() => {
    const list = (data?.agents ?? []).map(a => ({
      ...a,
      collected: num(a.collected),
      expected: num(a.expected),
      pct: num(a.expected) > 0 ? Math.round((num(a.collected) / num(a.expected)) * 100) : null,
    }));
    return list.sort((a, b) => b.collected - a.collected);
  }, [data]);

  /** Agents visible in the "collections vs expected" list — search only affects this list. */
  const filteredAgents = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q
      ? agents.filter(a => (a.name || '').toLowerCase().includes(q) || (a.phone || '').includes(q))
      : agents;
  }, [agents, search]);

  // Reset pagination when the range or search changes
  useEffect(() => { setVisibleAgents(10); }, [search, preset, custom, bucket]);

  /** Bar chart: only agents achieving at least 5% of their expected target. */
  const agentBars = useMemo(
    () =>
      agents
        .filter(a => a.pct !== null && a.pct >= 5 && a.collected > 0)
        .slice(0, 15)
        .map(a => ({
          name: (a.name || 'Agent').split(' ').slice(0, 2).join(' '),
          collected: a.collected,
          expected: a.expected,
          pct: a.pct as number,
        })),
    [agents],
  );

  const expectedTotal = num(totals?.expected_due);
  const [exporting, setExporting] = useState(false);

  const exportStatementPdf = async () => {
    if (!data) return;
    setExporting(true);
    try {
      const blob = await generateAgentCollectionsStatementPdf({
        periodLabel: PRESETS.find(p => p.key === preset)?.label ?? 'Custom range',
        rangeStart: start,
        rangeEnd: end,
        bucket,
        generatedAt: data.generated_at,
        totals: {
          collected: num(data.totals?.collected),
          expected: num(data.totals?.expected_due),
          collections_count: num(data.totals?.collections_count),
          avg_collection: num(data.totals?.avg_collection),
          active_agents: num(data.totals?.active_agents),
          tenants_paid: num(data.totals?.tenants_paid),
          requests_count: num(data.totals?.requests_count),
          requests_amount: num(data.totals?.requests_amount),
        },
        series,
        peak: peak.map(p => ({ label: p.label, amount: p.amount, count: p.count })),
        agents: filteredAgents.map(a => ({
          name: a.name,
          phone: a.phone,
          collected: a.collected,
          expected: a.expected,
          collections_count: a.collections_count,
          tenants_paid: a.tenants_paid,
          active_tenants: a.active_tenants,
          expected_source: a.expected_source,
          last_collection_at: a.last_collection_at,
          pct: a.pct,
        })),
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `welile-agent-collections-statement-${format(start, 'yyyyMMdd')}-${format(end, 'yyyyMMdd')}.pdf`;
      link.click();
      URL.revokeObjectURL(url);
      toast.success('Financial statement exported');
    } catch (e: any) {
      toast.error(e?.message || 'Could not generate the statement');
    } finally {
      setExporting(false);
    }
  };

  const collectedTotal = num(totals?.collected);
  const coverage = expectedTotal > 0 ? Math.round((collectedTotal / expectedTotal) * 100) : null;

  return (
    <div className="space-y-4">
      {/* Header + filters */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-2 mr-auto">
          <Activity className="h-4 w-4 text-primary" />
          <h2 className="text-base font-semibold">Collections Command Center</h2>
          {isFetching && <RefreshCw className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
        </div>
        <ComprehensiveReportButton />
        <div className="flex flex-wrap gap-1.5">
          {PRESETS.map(p => (
            <Button
              key={p.key}
              size="sm"
              variant={preset === p.key ? 'default' : 'outline'}
              className="h-8 text-xs"
              onClick={() => setPreset(p.key)}
            >
              {p.label}
            </Button>
          ))}
          {preset === 'custom' && (
            <Popover>
              <PopoverTrigger asChild>
                <Button size="sm" variant="secondary" className="h-8 text-xs">
                  <CalendarIcon className="h-3.5 w-3.5 mr-1" />
                  {custom?.from
                    ? `${format(custom.from, 'dd MMM')}${custom.to ? ` – ${format(custom.to, 'dd MMM')}` : ''}`
                    : 'Pick dates'}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="end">
                <Calendar
                  mode="range"
                  numberOfMonths={2}
                  selected={custom}
                  onSelect={setCustom}
                  disabled={{ after: new Date() }}
                  initialFocus
                />
              </PopoverContent>
            </Popover>
          )}
          <Button size="sm" variant="ghost" className="h-8 text-xs" onClick={() => refetch()}>
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <p className="text-[11px] text-muted-foreground">
        {format(start, 'dd MMM yyyy h:mm a')} → {format(end, 'dd MMM yyyy h:mm a')} · {preset === 'next7' ? 'forecast per day' : `grouped by ${bucket}`} · East Africa Time
        {data?.generated_at ? ` · updated ${format(new Date(data.generated_at), 'h:mm:ss a')}` : ''}
      </p>

      {error && (
        <Card className="p-4 border-destructive/40">
          <p className="text-sm text-destructive">Could not load collections data: {(error as any).message}</p>
        </Card>
      )}

      {preset === 'next7' ? (
        <NextSevenDaysExpected />
      ) : (
        <>
      {/* KPI strip */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <Card className="p-3">
          <div className="flex items-center gap-2 text-xs text-muted-foreground"><Banknote className="h-3.5 w-3.5" /> Collected</div>
          <p className="text-lg font-bold mt-1">{formatUGX(collectedTotal)}</p>
          <p className="text-[11px] text-muted-foreground">{num(totals?.collections_count)} payments · avg {formatUGX(num(totals?.avg_collection))}</p>
        </Card>
        <Card className="p-3">
          <div className="flex items-center gap-2 text-xs text-muted-foreground"><Target className="h-3.5 w-3.5" /> Expected</div>
          <p className="text-lg font-bold mt-1">{formatUGX(expectedTotal)}</p>
          <div className="mt-1.5">
            <Progress value={Math.min(100, coverage ?? 0)} className="h-1.5" />
            <p className="text-[11px] text-muted-foreground mt-1">{coverage === null ? 'No expectation on record' : `${coverage}% of expected`}</p>
          </div>
        </Card>
        <Card className="p-3">
          <div className="flex items-center gap-2 text-xs text-muted-foreground"><Users className="h-3.5 w-3.5" /> Active agents</div>
          <p className="text-lg font-bold mt-1">{num(totals?.active_agents)}</p>
          <p className="text-[11px] text-muted-foreground">{num(totals?.tenants_paid)} tenants paid</p>
        </Card>
        <Card className="p-3">
          <div className="flex items-center gap-2 text-xs text-muted-foreground"><TrendingUp className="h-3.5 w-3.5" /> New rent requests</div>
          <p className="text-lg font-bold mt-1">{num(totals?.requests_count)}</p>
          <p className="text-[11px] text-muted-foreground">{formatUGX(num(totals?.requests_amount))} requested</p>
        </Card>
        <Card className="p-3">
          <div className="flex items-center gap-2 text-xs text-muted-foreground"><AlertTriangle className="h-3.5 w-3.5" /> Defaulted</div>
          <p className="text-lg font-bold mt-1 text-destructive">{formatUGX(num(totals?.defaulted_to_date))}</p>
          <p className="text-[11px] text-muted-foreground">{num(totals?.defaulted_plans)} plans · as at {totals?.defaulted_as_of}</p>
          <Button size="sm" variant="outline" className="h-7 mt-2 text-[11px] w-full" onClick={() => setOwingOpen(true)}>
            View all tenants owing
          </Button>
        </Card>
      </div>

      {/* Expected collections per day */}
      {data?.expected_daily && data.expected_daily.length > 0 && (
        <Card className="p-3">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-semibold">Expected collections per day</h3>
            <Badge variant="outline" className="text-[10px]">Per the agreed payment plans</Badge>
          </div>
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data.expected_daily}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis
                  dataKey="day"
                  tickFormatter={(d: string) => format(parseISO(d), 'dd MMM')}
                  tick={{ fontSize: 10 }}
                  stroke="hsl(var(--muted-foreground))"
                />
                <YAxis tickFormatter={compact} tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" />
                <Tooltip formatter={(v: any) => formatUGX(Number(v))} labelFormatter={(l: any) => format(parseISO(l), 'EEEE dd MMM')} />
                <Bar dataKey="expected_ugx" name="Expected" fill="hsl(var(--primary))" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="mt-3 space-y-1">
            {data.expected_daily.slice(0, 31).map((row) => (
              <div
                key={row.day}
                className="flex items-center justify-between rounded-md border px-2 py-1.5"
              >
                <div>
                  <p className="text-xs font-medium">{format(parseISO(row.day), 'EEE dd MMM')}</p>
                  <p className="text-[10px] text-muted-foreground">{row.plans} plans due</p>
                </div>
                <div className="flex items-center gap-2">
                  {!row.elapsed && (
                    <Badge variant="outline" className="text-[10px]">Upcoming</Badge>
                  )}
                  <p className="text-sm font-semibold tabular-nums">{formatUGX(row.expected_ugx)}</p>
                </div>
              </div>
            ))}
            {data.expected_daily.length > 31 && (
              <p className="text-[11px] text-muted-foreground">
                {data.expected_daily.length - 31} further days not shown.
              </p>
            )}
          </div>
        </Card>
      )}

      {/* Trend */}
      <Card className="p-3">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold">Collections trend</h3>
          <Badge variant="outline" className="text-[10px]">per {bucket}</Badge>
        </div>
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={series}>
              <defs>
                <linearGradient id="collGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.5} />
                  <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0.05} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis dataKey="label" tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" />
              <YAxis tickFormatter={compact} tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" />
              <Tooltip formatter={(v: any, n: any) => [formatUGX(Number(v)), n === 'collected' ? 'Collected' : n]} />
              <Area type="monotone" dataKey="collected" stroke="hsl(var(--primary))" fill="url(#collGrad)" strokeWidth={2} name="Collected" />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </Card>

      {/* Peak hours */}
      <Card className="p-3">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <Clock className="h-4 w-4 text-amber-600" />
            <h3 className="text-sm font-semibold">Peak payment hours</h3>
          </div>
          {topHour && topHour.amount > 0 && (
            <Badge className="text-[10px] bg-amber-500/15 text-amber-700 border-amber-500/30">
              Peak {hourLabel(topHour.hour)} · {formatUGX(topHour.amount)}
            </Badge>
          )}
        </div>
        <div className="h-56">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={peak}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis dataKey="label" tick={{ fontSize: 9 }} interval={1} stroke="hsl(var(--muted-foreground))" />
              <YAxis tickFormatter={compact} tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" />
              <Tooltip
                formatter={(v: any) => formatUGX(Number(v))}
                labelFormatter={(l: any) => `${l} (EAT)`}
              />
              <Bar dataKey="amount" name="Collected" radius={[3, 3, 0, 0]}>
                {peak.map(p => (
                  <Cell key={p.hour} fill={p.amount >= peakMax * 0.75 ? 'hsl(38 92% 50%)' : 'hsl(var(--primary))'} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
        <p className="text-[11px] text-muted-foreground mt-1">
          Hour of day when tenants' rent payments are recorded, in East Africa Time.
        </p>
      </Card>

      {/* Collections vs rent requests */}
      <Card className="p-3 bg-muted/30">
        <div className="flex flex-wrap items-center gap-2 mb-2">
          <h3 className="text-sm font-semibold mr-auto">Collections vs new rent requests</h3>
          <Badge variant="outline" className="text-[10px] gap-1">
            <span className="inline-block h-2 w-2 rounded-full" style={{ background: 'hsl(160 84% 39%)' }} /> Collected
          </Badge>
          <Badge variant="outline" className="text-[10px] gap-1">
            <span className="inline-block h-2 w-2 rounded-full" style={{ background: 'hsl(262 83% 58%)' }} /> Rent requested
          </Badge>
        </div>
        <div className="h-64 rounded-lg bg-background/70 p-2">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={series}>
              <defs>
                <linearGradient id="vsCollected" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="hsl(160 84% 39%)" stopOpacity={0.35} />
                  <stop offset="95%" stopColor="hsl(160 84% 39%)" stopOpacity={0.02} />
                </linearGradient>
                <linearGradient id="vsRequests" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="hsl(262 83% 58%)" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="hsl(262 83% 58%)" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis dataKey="label" tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" />
              <YAxis tickFormatter={compact} tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" />
              <Tooltip
                formatter={(v: any) => formatUGX(Number(v))}
                contentStyle={{ background: 'hsl(var(--popover))', border: '1px solid hsl(var(--border))', borderRadius: 8, fontSize: 11 }}
              />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Area type="monotone" dataKey="collected" name="Collected" stroke="hsl(160 84% 39%)" fill="url(#vsCollected)" strokeWidth={2} />
              <Area type="monotone" dataKey="requests" name="Rent requested" stroke="hsl(262 83% 58%)" fill="url(#vsRequests)" strokeWidth={2} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </Card>

      {/* Agent collections bar chart (>= 5% of expected only) */}
      <Card className="p-3">
        <div className="flex flex-wrap items-center gap-2 mb-2">
          <h3 className="text-sm font-semibold mr-auto">Agent collections (performing agents)</h3>
          <Badge variant="outline" className="text-[10px]">≥ 5% of expected</Badge>
        </div>
        {agentBars.length === 0 ? (
          <p className="text-sm text-muted-foreground py-6 text-center">
            No agent has reached 5% of their expected target in this range.
          </p>
        ) : (
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={agentBars} layout="vertical" margin={{ left: 8, right: 12 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" horizontal={false} />
                <XAxis type="number" tickFormatter={compact} tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" />
                <YAxis type="category" dataKey="name" width={110} tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" />
                <Tooltip
                  formatter={(v: any, n: any) => [formatUGX(Number(v)), n]}
                  contentStyle={{ background: 'hsl(var(--popover))', border: '1px solid hsl(var(--border))', borderRadius: 8, fontSize: 11 }}
                />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar dataKey="expected" name="Expected" fill="hsl(var(--muted))" radius={[0, 3, 3, 0]} />
                <Bar dataKey="collected" name="Collected" radius={[0, 3, 3, 0]}>
                  {agentBars.map(b => (
                    <Cell
                      key={b.name}
                      fill={b.pct >= 90 ? 'hsl(160 84% 39%)' : b.pct >= 50 ? 'hsl(38 92% 50%)' : 'hsl(var(--primary))'}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
        <p className="text-[11px] text-muted-foreground mt-1">
          Agents below 5% coverage are hidden to keep the chart free of empty data.
        </p>
      </Card>

      {/* Agents by collections vs expected */}
      <Card className="p-3">
        <div className="flex flex-wrap items-center gap-2 mb-2">
          <h3 className="text-sm font-semibold mr-auto">Agents by collections vs expected</h3>
          <Badge variant="outline" className="text-[10px]">{filteredAgents.length} agents</Badge>
          <Button
            size="sm"
            variant="outline"
            className="h-8 text-xs"
            disabled={!data || exporting || isLoading}
            onClick={exportStatementPdf}
          >
            <FileDown className="h-3.5 w-3.5 mr-1" />
            {exporting ? 'Preparing…' : 'Financial statement (PDF)'}
          </Button>
          <div className="relative">
            <Search className="absolute left-2 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search agent"
              className="h-8 pl-7 text-xs w-48"
            />
          </div>
        </div>

        {isLoading ? (
          <p className="text-sm text-muted-foreground py-6 text-center">Loading collections…</p>
        ) : filteredAgents.length === 0 ? (
          <p className="text-sm text-muted-foreground py-6 text-center">No agents match this range.</p>
        ) : (
          <>
            <div className="space-y-2">
              {filteredAgents.slice(0, visibleAgents).map((a, i) => (
                <div
                  key={a.agent_id}
                  className="rounded-lg border bg-card/60 p-2.5 flex items-start gap-3 hover:bg-accent/40 transition-colors"
                >
                  <div className="h-7 w-7 shrink-0 rounded-full bg-muted grid place-items-center text-[11px] font-semibold text-muted-foreground">
                    {i + 1}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate">{a.name}</p>
                        <p className="text-[11px] text-muted-foreground truncate">
                          {a.phone ? `${a.phone} · ` : ''}{a.collections_count} payments · {a.tenants_paid}/{a.active_tenants} tenants paid
                        </p>
                      </div>
                      <div className="text-right shrink-0">
                        <p className="text-sm font-bold">{formatUGX(a.collected)}</p>
                        <p className="text-[11px] text-muted-foreground">of {formatUGX(a.expected)}</p>
                      </div>
                    </div>
                    <div className="mt-2 flex items-center gap-2">
                      <Progress value={Math.min(100, a.pct ?? 0)} className="h-2 flex-1" />
                      <span
                        className={cn(
                          'text-[11px] font-semibold w-12 text-right',
                          a.pct === null ? 'text-muted-foreground'
                            : a.pct >= 90 ? 'text-emerald-600'
                            : a.pct >= 50 ? 'text-amber-600' : 'text-destructive',
                        )}
                      >
                        {a.pct === null ? '—' : `${a.pct}%`}
                      </span>
                    </div>
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      {a.last_collection_at && (
                        <Badge variant="outline" className="text-[10px]">
                          Last {format(new Date(a.last_collection_at), 'dd MMM h:mm a')}
                        </Badge>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
            {visibleAgents < filteredAgents.length && (
              <div className="pt-3 text-center">
                <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => setVisibleAgents(v => v + 10)}>
                  Load more · {filteredAgents.length - visibleAgents} remaining
                </Button>
              </div>
            )}
          </>
        )}
        <p className="text-[11px] text-muted-foreground mt-2">
          Expected is the sum of the instalments each tenant's agreed payment plan schedules inside this period. Plans that have run past their agreed end date, or that are already settled, raise no further expectation — their balances appear under Defaulted.
        </p>
      </Card>
        </>
      )}
    </div>
  );
}

export default AgentCollectionsCommandCenter;
