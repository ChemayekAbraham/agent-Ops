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
  CalendarIcon, Clock, TrendingUp, Users, Banknote, Target, RefreshCw, Activity, Search, FileDown, Receipt, AlertTriangle,
} from 'lucide-react';
import { ComprehensiveReportButton } from './ComprehensiveReportButton';
import { AgentCollectionsAgentTable } from './AgentCollectionsAgentTable';
import { TenantsOwingDialog } from './TenantsOwingDialog';
import { DormantAgentsDialog } from './DormantAgentsDialog';

import { NextSevenDaysExpected } from './NextSevenDaysExpected';
import { CollectionsDailyHistory } from './CollectionsDailyHistory';
import { SilentCollectorsPanel } from './SilentCollectorsPanel';
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

/**
 * Uganda (EAT, UTC+3) day boundaries.
 *
 * The Home page snaps its window to Kampala calendar days server-side, so the
 * device's local midnight must never be sent as the window edge — on any
 * non-EAT device it shifts the window and the two pages stop reconciling.
 */
const EAT_OFFSET_MS = 3 * 60 * 60 * 1000;

/** Today's Kampala calendar date, expressed as a local-midnight Date for calendar maths. */
function kampalaToday(): Date {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Kampala', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  const [y, m, d] = parts.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** Instant of 00:00 Kampala on the calendar date carried by `d`. */
function eatDayStart(d: Date): Date {
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0) - EAT_OFFSET_MS);
}

/** Exclusive end: 00:00 Kampala on the day after the calendar date carried by `d`. */
function eatDayEnd(d: Date): Date {
  return new Date(eatDayStart(d).getTime() + 86_400_000);
}

function resolveRange(preset: PresetKey, custom?: DateRange): { start: Date; end: Date; bucket: string } {
  const now = kampalaToday();
  const win = (from: Date, to: Date, bucket: string) => ({ start: eatDayStart(from), end: eatDayEnd(to), bucket });
  switch (preset) {
    case 'today':
      return win(now, now, 'hour');
    case 'yesterday': {
      const y = subDays(now, 1);
      return win(y, y, 'hour');
    }
    case 'five':
      return win(subDays(now, 4), now, 'day');
    case 'next7':
      // Forward-looking tab: the window is tomorrow → +7 days. The command
      // center RPC is not queried for it; NextSevenDaysExpected renders instead.
      return win(addDays(now, 1), addDays(now, 7), 'day');
    case 'weekend': {
      const w = lastWeekend(now);
      return win(w.start, w.end, 'hour');
    }
    case 'month':
      return win(startOfMonth(now), now, 'day');
    case 'year':
      return win(startOfYear(now), now, 'month');
    case 'custom': {
      const from = custom?.from ? startOfDay(custom.from) : now;
      const to = custom?.to ? startOfDay(custom.to) : startOfDay(custom?.from ?? now);
      const days = Math.max(1, Math.round((to.getTime() - from.getTime()) / 86400000) + 1);
      const bucket = days <= 1 ? 'hour' : days <= 62 ? 'day' : 'month';
      return win(from, to, bucket);
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

/**
 * Collected split by whether the plan was on this window's pinned bill.
 *
 * `totals.collected` above is all cash received in the window, and tenants
 * clear older bills every day — so dividing it by `expected_due` counts money
 * the denominator never billed and roughly doubles the apparent coverage
 * (2026-09-08: 93% that way, 41.8% honestly). Coverage is computed from
 * `collected_on_schedule`; `collected_arrears` is the rest, and it is real
 * money that deserves its own line rather than being hidden inside a ratio.
 */
interface CoverageData {
  expected_due: number;
  expected_basis: string;
  expected_as_of: string;
  collected_total: number;
  collected_on_schedule: number;
  collected_arrears: number;
  /** Token/QR collections carry no rent_request_id, so they match nothing. */
  collected_unattributed: number;
  coverage_pct: number | null;
  /** Capped at what each plan was billed — the figure Tenant Ops Home reports. */
  collected_on_schedule_capped: number;
  pending_capped: number;
  coverage_pct_capped: number | null;
  coverage_basis: string;
  agents: { agent_id: string; collected: number; collected_on_schedule: number; collected_on_schedule_capped: number }[];
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
  const [dormantOpen, setDormantOpen] = useState(false);
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

  const totals = data?.totals;

  const { data: coverageData } = useQuery({
    queryKey: ['agent-collections-coverage', start.toISOString(), end.toISOString()],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_agent_collections_coverage', {
        p_start: start.toISOString(),
        p_end: end.toISOString(),
      });
      if (error) throw error;
      return data as unknown as CoverageData;
    },
    enabled: preset !== 'next7',
    refetchInterval: 60_000,
    staleTime: 20_000,
  });

  /**
   * Per-agent collected on the window's own bills, CAPPED at what each plan was
   * billed — the same definition Tenant Ops Home reports, so the agent figures
   * sum to the headline and attainment can never exceed 100%.
   */
  const onScheduleByAgent = useMemo(() => {
    const map = new Map<string, number>();
    (coverageData?.agents ?? []).forEach(a => map.set(a.agent_id, num(a.collected_on_schedule_capped)));
    return map;
  }, [coverageData]);

  const { data: target } = useQuery({
    queryKey: ['agent-ops-collection-target', totals?.defaulted_as_of ?? 'today'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('agent_ops_collection_target', {
        p_as_of: totals?.defaulted_as_of ?? format(new Date(), 'yyyy-MM-dd'),
      });
      if (error) throw error;
      return data as any;
    },
    enabled: preset !== 'next7',
    staleTime: 60_000,
  });


  // Live refresh when collections or rent requests change. The coverage split
  // reads the same rows, so it has to be invalidated alongside the main query
  // or the tile and its percentage drift apart.
  useEffect(() => {
    const refresh = () => {
      qc.invalidateQueries({ queryKey: ['agent-collections-command-center'] });
      qc.invalidateQueries({ queryKey: ['agent-collections-coverage'] });
    };
    const channel = supabase
      .channel('agent-collections-command-center')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'agent_collections' }, refresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'rent_requests' }, refresh)
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [qc]);
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
    const list = (data?.agents ?? []).map(a => {
      // Attainment must compare like with like. `collected` includes arrears an
      // agent cleared on plans this window never billed, which on a normal day
      // pushes the best collectors past 200% and makes the column meaningless.
      const cash = num(a.collected);
      const onSchedule = onScheduleByAgent.get(a.agent_id) ?? 0;
      const expected = num(a.expected);
      return {
        ...a,
        // "Collected" is the Home definition: money against this window's own
        // bills, capped at what each plan was billed. Arrears stay visible on
        // their own line instead of being folded into attainment.
        collected: onSchedule,
        collectedCash: cash,
        collectedOnSchedule: onSchedule,
        collectedArrears: Math.max(0, cash - onSchedule),
        expected,
        pct: expected > 0 ? Math.round((onSchedule / expected) * 100) : null,
      };
    });
    return list.sort((a, b) => b.collected - a.collected);
  }, [data, onScheduleByAgent]);

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
          // Same definition as the screen and as Tenant Ops Home.
          collected: num(coverageData?.collected_on_schedule_capped),
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

  // Single definition of "Collected", shared with Tenant Ops → Classic → Home:
  // money received against this window's own bills, capped at what each plan was
  // billed (`capped` in the coverage RPC, `collected` in ops_tenant_ops_home_range).
  // Everything else received in the window — older bills, plans this window never
  // billed, and token payments with no plan attached — is arrears and gets its own
  // line rather than being folded into attainment.
  const collectedOnSchedule = num(coverageData?.collected_on_schedule_capped);
  const collectedTotal = collectedOnSchedule;
  const cashReceived = num(coverageData?.collected_total);
  const arrearsCollected = Math.max(0, cashReceived - collectedOnSchedule);
  const coverage = expectedTotal > 0 ? Math.round((collectedOnSchedule / expectedTotal) * 100) : null;

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
                  defaultMonth={custom?.from ?? subDays(new Date(), 30)}
                  fromYear={2023}
                  toDate={new Date()}
                  disabled={{ after: new Date() }}
                  initialFocus
                  className="p-3 pointer-events-auto"
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
      <div className="grid grid-cols-2 lg:grid-cols-6 gap-3">
        <Card className="p-3">
          <div className="flex items-center gap-2 text-xs text-muted-foreground"><Banknote className="h-3.5 w-3.5" /> Collected</div>
          <p className="text-lg font-bold mt-1">{formatUGX(collectedTotal)}</p>
          <p className="text-[11px] text-muted-foreground">On this period's bills{arrearsCollected > 0 ? ` · ${formatUGX(arrearsCollected)} arrears` : ''}</p>
        </Card>
        <Card className="p-3">
          <div className="flex items-center gap-2 text-xs text-muted-foreground"><Receipt className="h-3.5 w-3.5" /> Total collections</div>
          <p className="text-lg font-bold mt-1">{num(totals?.collections_count).toLocaleString()}</p>
          <p className="text-[11px] text-muted-foreground">{formatUGX(cashReceived)} cash received · avg {formatUGX(num(totals?.avg_collection))}</p>
        </Card>
        <Card className="p-3">
          <div className="flex items-center gap-2 text-xs text-muted-foreground"><Target className="h-3.5 w-3.5" /> Expected</div>
          <p className="text-lg font-bold mt-1">{formatUGX(expectedTotal)}</p>
          <div className="mt-1.5">
            <Progress value={Math.min(100, coverage ?? 0)} className="h-1.5" />
            <p className="text-[11px] text-muted-foreground mt-1">{coverage === null ? 'No expectation on record' : `${coverage}% of expected${arrearsCollected > 0 ? ` · ${formatUGX(arrearsCollected)} arrears` : ''}`}</p>
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
          <Button size="sm" variant="outline" className="h-7 mt-1 text-[11px] w-full min-h-11 sm:min-h-7" onClick={() => setOwingOpen(true)}>
            View all tenants owing
          </Button>
          <Button size="sm" variant="outline" className="h-7 mt-1 text-[11px] w-full min-h-11 sm:min-h-7" onClick={() => setDormantOpen(true)}>
            Agents gone quiet
          </Button>
        </Card>
      </div>

      {/* Field collection target */}
      {target && (
        <Card className="p-3">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <Banknote className="h-4 w-4 text-primary" />
              <h3 className="text-sm font-semibold">Field collection target today</h3>
            </div>
            <Badge variant="outline" className="text-[10px]">Separate from Expected</Badge>
          </div>
          <p className="text-2xl font-bold tabular-nums">{formatUGX(num(target.collectible_today))}</p>
          <p className="text-[11px] text-muted-foreground">
            {num(target.collectible_plans)} tenants in arrears · their combined daily instalment rate
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-2">
            <div className="rounded-md border px-3 py-2">
              <p className="text-xs text-muted-foreground">On their agreed schedule</p>
              <p className="text-sm font-semibold tabular-nums">{formatUGX(num(target.on_schedule_daily))}</p>
              <p className="text-[11px] text-muted-foreground">{num(target.on_schedule_plans)} tenants · still inside their term</p>
              <p className="text-[11px] text-muted-foreground mt-1">
                Behind by <span className="font-semibold tabular-nums">{formatUGX(num(target.on_schedule_arrears))}</span>
              </p>
            </div>
            <div className="rounded-md border px-3 py-2">
              <p className="text-xs text-muted-foreground">Past their agreed end date</p>
              <p className="text-sm font-semibold tabular-nums text-destructive">{formatUGX(num(target.past_term_daily))}</p>
              <p className="text-[11px] text-muted-foreground">{num(target.past_term_plans)} tenants · plan has run out, balance still owed</p>
              <p className="text-[11px] text-muted-foreground mt-1">
                Still owed <span className="font-semibold tabular-nums text-destructive">{formatUGX(num(target.past_term_arrears))}</span>
              </p>
            </div>
          </div>
          <div className="rounded-md border border-warning/40 bg-warning/5 px-3 py-2 mt-2">
            <p className="text-xs text-muted-foreground">Total arrears owed</p>
            <p className="text-lg font-bold tabular-nums">{formatUGX(num(target.arrears_to_date))}</p>
            <p className="text-[11px] text-muted-foreground">
              What tenants are behind by, across {num(target.collectible_plans)} plans. This is a balance owed, not a
              target for today — and it is <span className="font-semibold">not</span> part of Expected.
            </p>
          </div>
          <p className="text-[11px] text-muted-foreground mt-2">
            Expected above is {formatUGX(num(target.scheduled_today))} — only what the agreed payment plans schedule for today,
            across {num(target.scheduled_today_plans)} plans. The other two figures are different measures. The target adds the
            daily rate of every tenant already in arrears, including those whose plan has passed its end date and schedules
            nothing further. Total arrears owed is the accumulated balance behind those tenants, not a day's work. Use Expected
            to judge plan performance, the target to set what the field teams chase, and arrears owed to size the recovery book.
            Never add any of them together.
          </p>
        </Card>
      )}


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

      {/* Collections trend and peak payment hours now live in Agent Ops → Rent Behaviour */}



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

      {/* Why the number is what it is: agents with tenants due today who have
          stopped collecting. Sits above the history because it is the acting
          list, not the reading list. */}
      <SilentCollectorsPanel />

      {/* Day by day, from the frozen snapshot rather than recomputed live —
          a recomputed history restates itself whenever the data is corrected. */}
      <CollectionsDailyHistory />

      {/* Agents by collections vs expected */}
      <AgentCollectionsAgentTable
        agents={filteredAgents}
        isLoading={isLoading}
        start={start}
        end={end}
        exporting={exporting}
        onExportStatement={exportStatementPdf}
      />

      <TenantsOwingDialog asOf={totals?.defaulted_as_of ?? format(new Date(), 'yyyy-MM-dd')} open={owingOpen} onOpenChange={setOwingOpen} />
      <DormantAgentsDialog asOf={totals?.defaulted_as_of ?? format(new Date(), 'yyyy-MM-dd')} open={dormantOpen} onOpenChange={setDormantOpen} />

        </>
      )}
    </div>
  );
}

export default AgentCollectionsCommandCenter;
