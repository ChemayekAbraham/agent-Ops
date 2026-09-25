import { useEffect, useMemo, useState } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { format, subDays, startOfMonth, startOfYear, differenceInCalendarDays, startOfDay, endOfDay, isSameDay, isSameMonth } from 'date-fns';
import { toast } from 'sonner';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid,
} from 'recharts';
import {
  ArrowDownRight, ArrowUpRight, CalendarIcon, ChevronDown, FileText, Loader2, Minus, RefreshCw, Search,
} from 'lucide-react';

import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { useServiceCentres, SERVICE_CENTRE_BONUS } from '@/hooks/useServiceCentres';
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
import type { AgentPopulation } from '@/lib/agentOpsComprehensiveReport';


const PAGE_SIZE = 15;

/** Reusable percentage tiles: each metric shown as a share or a growth rate. */
function PctSummary({ items }: {
  items: {
    label: string;
    /** Share of a base, 0-100. */
    pct: number | null;
    /** Optional growth pair: renders +X% instead of a share. */
    growth?: { current: number; previous: number };
    hint?: string;
    invert?: boolean;
  }[];
}) {
  return (
    <div className="grid gap-2 grid-cols-2 lg:grid-cols-4">
      {items.map(it => {
        const g = it.growth ? apsPctChange(it.growth.current, it.growth.previous) : null;
        const value = it.growth
          ? apsPctLabel(it.growth.current, it.growth.previous)
          : it.pct === null ? '—' : `${it.pct.toFixed(1)}%`;
        const dir = it.growth ? g : null;
        const tone = dir === null || dir === 0
          ? ''
          : (it.invert ? dir < 0 : dir > 0) ? 'text-emerald-600' : 'text-destructive';
        return (
          <div key={it.label} className="rounded-xl border bg-card p-3">
            <p className="text-[11px] text-muted-foreground">{it.label}</p>
            <p className={cn('text-lg font-bold', tone)}>{value}</p>
            {it.hint && <p className="text-[10px] text-muted-foreground">{it.hint}</p>}
          </div>
        );
      })}
    </div>
  );
}

/** Percentage view of agent additions: growth vs the previous period and per-type share. */
function NewAgentPercentages({ rows, newCount, prevCount, totalAgents, compareLabel }: {
  rows: { agent_type: string }[]; newCount: number; prevCount: number;
  totalAgents: number; compareLabel?: string;
}) {
  const added = newCount || rows.length;
  const main = rows.filter(r => r.agent_type === 'main agent').length;
  const sub = rows.filter(r => r.agent_type === 'sub-agent').length;
  const denom = main + sub || added;
  const share = (n: number) => (denom > 0 ? (n / denom) * 100 : 0);
  const growth = apsPctChange(added, prevCount);
  const baseShare = totalAgents > 0 ? (added / totalAgents) * 100 : 0;
  const pct = (n: number) => `${n.toFixed(1)}%`;

  return (
    <div className="grid gap-2 sm:grid-cols-3">
      <div className="rounded-xl border bg-card p-3">
        <p className="text-[11px] text-muted-foreground">Growth vs previous period</p>
        <p className={cn('text-lg font-bold',
          growth === null || growth === 0 ? 'text-muted-foreground'
            : growth > 0 ? 'text-emerald-600' : 'text-destructive')}>
          {apsPctLabel(added, prevCount)}
        </p>
      </div>

      <div className="rounded-xl border bg-card p-3">
        <p className="text-[11px] text-muted-foreground">Share of total agent base</p>
        <p className="text-lg font-bold">{pct(baseShare)}</p>
      </div>

      <div className="rounded-xl border bg-card p-3">
        <p className="text-[11px] text-muted-foreground">Breakdown by agent type</p>
        <div className="mt-1 space-y-1.5">
          {[
            { label: 'Main agents', count: main, cls: 'bg-primary' },
            { label: 'Sub-agents', count: sub, cls: 'bg-purple-500' },
          ].map(t => (
            <div key={t.label}>
              <div className="flex items-baseline justify-between text-[10px]">
                <span className="text-muted-foreground">{t.label}</span>
                <span className="font-semibold">{pct(share(t.count))}</span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div className={cn('h-full rounded-full', t.cls)} style={{ width: `${share(t.count)}%` }} />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * Composition of the canonical operational agent population: main vs sub-agents,
 * and active (rent collecting) vs inactive / onboarding agents.
 */
function TotalAgentsComposition({ population, asOf }: {
  population: AgentPopulation; asOf: string;
}) {
  const total = Math.max(0, Number(population.total) || 0);
  const share = (v: number) => (total > 0 ? (v / total) * 100 : 0);
  const fmtPct = (v: number) => `${share(v).toFixed(1)}%`;
  const g = (v: unknown) => Math.max(0, Number(v) || 0);

  const structure = [
    { label: 'Main agents', count: g(population.primary_total), cls: 'bg-primary',
      hint: `${num(g(population.primary_active))} active · ${num(g(population.primary_inactive))} inactive` },
    { label: 'Sub-agents', count: g(population.sub_total), cls: 'bg-purple-500',
      hint: `${num(g(population.sub_active))} active · ${num(g(population.sub_inactive))} inactive` },
  ];

  const activity = [
    { label: 'Active rent collecting agents', count: g(population.active), cls: 'bg-emerald-500',
      hint: 'Collected in the last 30 days or carries a live plan' },
    { label: 'Inactive / onboarding agents', count: g(population.inactive), cls: 'bg-amber-500',
      hint: 'No collection in 30 days and no live plan' },
  ];

  const Bar = ({ segments }: { segments: { label: string; count: number; cls: string }[] }) => (
    <div className="flex h-3 w-full overflow-hidden rounded-full bg-muted">
      {segments.map(s => (
        <div key={s.label} className={cn('h-full', s.cls)}
          style={{ width: `${share(s.count)}%` }} title={`${s.label}: ${num(s.count)} (${fmtPct(s.count)})`} />
      ))}
    </div>
  );

  const Legend = ({ segments }: { segments: { label: string; count: number; cls: string; hint?: string }[] }) => (
    <div className="grid gap-2 sm:grid-cols-2">
      {segments.map(s => (
        <div key={s.label} className="rounded-xl border bg-card p-3">
          <div className="flex items-center gap-1.5">
            <span className={cn('h-2 w-2 rounded-full', s.cls)} />
            <p className="text-[11px] text-muted-foreground">{s.label}</p>
          </div>
          <p className="text-lg font-bold">{num(s.count)}
            <span className="ml-1.5 text-xs font-semibold text-muted-foreground">{fmtPct(s.count)}</span>
          </p>
          {s.hint && <p className="text-[10px] text-muted-foreground">{s.hint}</p>}
        </div>
      ))}
    </div>
  );

  const rows = [
    { group: 'Network structure', ...structure[0] },
    { group: 'Network structure', ...structure[1] },
    { group: 'Collection activity', ...activity[0] },
    { group: 'Collection activity', ...activity[1] },
  ];

  return (
    <Card>
      <CardHeader className="p-3 pb-1">
        <CardTitle className="text-xs font-bold">Total Agents Composition &amp; Sources</CardTitle>
        <p className="text-[10px] text-muted-foreground">
          How the total of {num(total)} operational agents as at {asOf} is made up. An operational agent has
          recorded at least one rent collection or carries a live rent plan.
        </p>
      </CardHeader>
      <CardContent className="p-3 pt-1 space-y-3">
        <div className="rounded-xl border bg-card p-3">
          <div className="flex items-baseline justify-between">
            <p className="text-[11px] text-muted-foreground">Total agents</p>
            <p className="text-lg font-bold">{num(total)}</p>
          </div>
        </div>

        <div className="space-y-1.5">
          <p className="text-[11px] font-semibold">By network structure</p>
          <Bar segments={structure} />
          <Legend segments={structure} />
        </div>

        <div className="space-y-1.5">
          <p className="text-[11px] font-semibold">By collection activity</p>
          <Bar segments={activity} />
          <Legend segments={activity} />
        </div>

        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-xs">
            <thead className="bg-muted/50">
              <tr>
                <th className="px-2 py-2 text-left font-semibold whitespace-nowrap">Source</th>
                <th className="px-2 py-2 text-left font-semibold whitespace-nowrap">Grouping</th>
                <th className="px-2 py-2 text-right font-semibold whitespace-nowrap">Agents</th>
                <th className="px-2 py-2 text-right font-semibold whitespace-nowrap">% of total</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={`${r.group}-${r.label}`} className={cn('border-t', i % 2 ? 'bg-muted/20' : '')}>
                  <td className="px-2 py-1.5 whitespace-nowrap">
                    <span className="inline-flex items-center gap-1.5">
                      <span className={cn('h-2 w-2 rounded-full', r.cls)} />{r.label}
                    </span>
                  </td>
                  <td className="px-2 py-1.5 text-muted-foreground whitespace-nowrap">{r.group}</td>
                  <td className="px-2 py-1.5 text-right whitespace-nowrap">{num(r.count)}</td>
                  <td className="px-2 py-1.5 text-right whitespace-nowrap">{fmtPct(r.count)}</td>
                </tr>
              ))}
              <tr className="border-t bg-muted/40 font-semibold">
                <td className="px-2 py-1.5 whitespace-nowrap">Total agents</td>
                <td className="px-2 py-1.5 text-muted-foreground whitespace-nowrap">Each grouping sums to total</td>
                <td className="px-2 py-1.5 text-right whitespace-nowrap">{num(total)}</td>
                <td className="px-2 py-1.5 text-right whitespace-nowrap">100.0%</td>
              </tr>
            </tbody>
          </table>
        </div>

        <p className="text-[10px] text-muted-foreground">
          Main + sub-agents = total agents. Active + inactive = total agents. The two groupings are two
          independent views of the same population, so they are not added together.
        </p>
      </CardContent>
    </Card>
  );
}



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

/** Unified SERVICE CENTRES summary card matching the Service Centers Overview item. */
function ServiceCentreConsolidatedCard({ report, compareLabel, previous }: {
  report: ApsReport; compareLabel?: string;
  previous?: { scActive?: number; scPending?: number; scApprovedVolume?: number; scRejected?: number };
}) {
  const sc = report.service_centres;
  const total = Number((sc as any).total ?? sc.active_total ?? 0);
  const live = Math.max(0, Number(sc.active_total) || 0);
  const pending = Math.max(0, Number(sc.pending_total) || 0);
  const awaitingPayout = Math.max(0, Number((sc as any).awaiting_payout ?? 0));
  const rejected = Math.max(0, Number(sc.rejected_count) || 0);
  const approvedVolume = Math.max(0, Number(sc.approved_volume) || 0);
  const target = Math.max(0, Number(sc.monthly_target) || 0);
  const targetPct = target > 0 ? (total / target) * 100 : 0;

  const subItems = [
    { label: 'Awaiting verification', value: num(pending), current: pending, previous: previous?.scPending, invert: true },
    { label: 'Awaiting payout', value: `${num(awaitingPayout)} (${apsUgx(approvedVolume)})`, current: awaitingPayout },
    { label: 'Live centres', value: num(live), current: live, previous: previous?.scActive },
    { label: 'Rejected', value: num(rejected), current: rejected, previous: previous?.scRejected, invert: true },
  ];

  return (
    <Card className="border sm:col-span-2 lg:col-span-2">
      <CardContent className="p-3 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Service centres</p>
            <p className="text-2xl font-bold">{num(total)}</p>
            <p className="text-[10px] text-muted-foreground">
              {num(live)} live &amp; paid · {num(awaitingPayout)} awaiting payout
            </p>
          </div>
          {target > 0 && (
            <div className="text-right">
              <p className="text-[10px] text-muted-foreground">Monthly target</p>
              <p className="text-sm font-bold">{num(target)}</p>
              <p className="text-[10px] font-semibold text-emerald-600">{targetPct.toFixed(1)}%</p>
            </div>
          )}
        </div>

        <div className="grid grid-cols-2 gap-2">
          {subItems.map(it => (
            <div key={it.label} className="rounded-lg border bg-card/50 p-2">
              <p className="text-[10px] text-muted-foreground">{it.label}</p>
              <p className="text-sm font-bold">{it.value}</p>
              {it.current !== undefined && it.previous !== undefined && (
                <TrendPill current={it.current} previous={it.previous} invert={it.invert} compareLabel={compareLabel} />
              )}
            </div>
          ))}
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
  const [mode, setMode] = useState<'single' | 'range'>('single');
  const [singleDate, setSingleDate] = useState<Date>(() => new Date());
  const [rangeFrom, setRangeFrom] = useState<Date>(() => subDays(new Date(), 6));
  const [rangeTo, setRangeTo] = useState<Date>(() => new Date());
  const [activeRangePreset, setActiveRangePreset] = useState<string | null>(null);
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

  const startDate = mode === 'single' ? singleDate : rangeFrom;
  const endDate = mode === 'single' ? singleDate : rangeTo;

  const dayKey = toDateKey(startDate);
  const endDateKey = toDateKey(endDate);
  const rangeDays = Math.max(1, differenceInCalendarDays(endDate, startDate) + 1);
  const isRange = mode === 'range' || rangeDays > 1;
  const periodLabel = isRange
    ? `${format(startDate, 'dd MMM yyyy')} – ${format(endDate, 'dd MMM yyyy')} · ${num(rangeDays)} days cumulative`
    : format(startDate, 'dd MMM yyyy');

  const reportQuery = useQuery({
    queryKey: ['agent-products-services-report', dayKey, endDateKey],
    queryFn: async (): Promise<ApsReport> => {
      const { data, error } = await supabase.rpc('get_agent_products_services_report' as any, {
        p_date: endDateKey,
        p_from: dayKey,
      });
      if (error) throw error;
      return data as unknown as ApsReport;
    },
    placeholderData: keepPreviousData,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });

  const rawReport = reportQuery.data;

  /** Fetch canonical schedule expectations from command center RPC (which derives from v_rent_plan_schedule). */
  const commandCenterQuery = useQuery({
    queryKey: ['agent-collections-command-center-aps', startOfDay(startDate).toISOString(), endOfDay(endDate).toISOString()],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_agent_collections_command_center', {
        p_start: startOfDay(startDate).toISOString(),
        p_end: endOfDay(endDate).toISOString(),
        p_bucket: 'day',
      });
      if (error) throw error;
      return data as any;
    },
    placeholderData: keepPreviousData,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });

  /** Actual commission EARNED in the window (ledger-backed) — not the wallet balance. */
  const commissionQuery = useQuery({
    queryKey: ['agent-commission-earned', dayKey, endDateKey],
    queryFn: async (): Promise<Record<string, number>> => {
      const { data, error } = await supabase.rpc('get_agent_commission_earned' as any, {
        p_from: dayKey,
        p_to: endDateKey,
      });
      if (error) throw error;
      const map: Record<string, number> = {};
      for (const row of (data as any[]) || []) map[row.agent_id] = Number(row.commission_earned) || 0;
      return map;
    },
    placeholderData: keepPreviousData,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });

  /** Fetch overview metrics from the canonical get_agent_ops_overview RPC */
  const overviewQuery = useQuery({
    queryKey: ['agent-ops-overview', 'aps-sync', startOfDay(startDate).toISOString(), endOfDay(endDate).toISOString()],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_agent_ops_overview' as any, {
        p_range_start: startOfDay(startDate).toISOString(),
        p_range_end: endOfDay(endDate).toISOString(),
      });
      if (error) throw error;
      return data as any;
    },
    placeholderData: keepPreviousData,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });

  /** Fetch active agents breakdown from overview */
  const activeBreakdownQuery = useQuery({
    queryKey: ['agent-ops-overview', 'active-breakdown-aps', startOfDay(startDate).toISOString(), endOfDay(endDate).toISOString()],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_agent_active_breakdown' as any, {
        p_range_start: startOfDay(startDate).toISOString(),
        p_range_end: endOfDay(endDate).toISOString(),
      });
      if (error) throw error;
      return data as any;
    },
    placeholderData: keepPreviousData,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });

  /** Single source of truth for Service Centres (same as Service Centres main item) */
  const { data: serviceCentresData, refetch: refetchServiceCentres } = useServiceCentres();

  const report = useMemo(() => {
    if (!rawReport) return rawReport;
    const map = commissionQuery.data;
    const cc = commandCenterQuery.data;
    const ok = overviewQuery.data?.kpis;
    const ab = activeBreakdownQuery.data;

    let rent = rawReport.rent;
    let rent_rows = rawReport.rent_rows || [];
    let agents = rawReport.agents;
    let service_centres = rawReport.service_centres;
    let service_centre_rows = rawReport.service_centre_rows || [];

    if (serviceCentresData) {
      const scRows = serviceCentresData;
      const byStatus = (s: string) => scRows.filter(r => r.status === s);
      const paid = byStatus('paid');
      const approved = byStatus('approved');
      const verified = byStatus('verified');
      const pending = byStatus('pending');
      const rejected = byStatus('rejected');
      const live = [...paid, ...approved];
      const newThisMonth = scRows.filter(r => r.created_at && isSameMonth(new Date(r.created_at), new Date())).length;
      const committedBonus = verified.length * SERVICE_CENTRE_BONUS;

      service_centres = {
        ...rawReport.service_centres,
        total: scRows.length,
        active_total: live.length,
        pending_total: pending.length,
        awaiting_payout: verified.length,
        rejected_count: rejected.length,
        new_this_month: newThisMonth,
        approved_volume: committedBonus,
      } as any;

      service_centre_rows = scRows.map(r => ({
        id: r.id,
        agent_name: r.agent_name || 'Unknown agent',
        agent_phone: r.agent_phone || null,
        location_name: r.location_name || null,
        status: r.status,
        created_at: r.created_at,
        verified_at: r.verified_at || null,
        approved_at: r.approved_at || null,
      }));
    }

    if (ok) {
      const totalAgents = (ok.total_agents || 0) + (ok.total_subagents || 0);
      const newAgents = (ok.new_agents_curr || 0) + (ok.new_subagents_curr || 0);
      const activeAgents = ab?.total_curr ?? (ok.active_agents_curr !== undefined ? ok.active_agents_curr : agents.active_today);
      agents = {
        ...rawReport.agents,
        total: totalAgents || rawReport.agents.total,
        base: totalAgents || rawReport.agents.base,
        new_today: newAgents !== undefined ? newAgents : rawReport.agents.new_today,
        active_today: activeAgents !== undefined ? activeAgents : rawReport.agents.active_today,
      };
    }

    if (cc?.totals && Number(cc.totals.expected_due) !== undefined) {
      const ccAgentMap: Record<string, { expected: number; expected_daily: number }> = {};
      for (const a of cc.agents || []) {
        ccAgentMap[a.agent_id] = {
          expected: Number(a.expected) || 0,
          expected_daily: Number(a.expected_daily) || 0,
        };
      }

      const expectedDue = Number(cc.totals.expected_due) || 0;
      const days = Math.max(1, rangeDays);
      const dailyReceivable = rangeDays === 1 ? expectedDue : (expectedDue / days);

      rent = {
        ...rawReport.rent,
        expected_cumulative: expectedDue,
        daily_receivable: dailyReceivable,
        expected_days: rangeDays,
      };

      rent_rows = rent_rows.map(r => {
        const agentExp = ccAgentMap[r.agent_id];
        if (!agentExp) return r;
        return {
          ...r,
          expected_cumulative: agentExp.expected,
          daily_receivable: rangeDays === 1 ? agentExp.expected : (agentExp.expected_daily || agentExp.expected / days),
        };
      });
    }

    return {
      ...rawReport,
      agents,
      service_centres,
      service_centre_rows,
      rent,
      rent_rows,
      agent_float_rows: (rawReport.agent_float_rows || []).map(r => ({
        ...r,
        commission_balance: Number(map?.[(r as any).agent_id] ?? 0),
      })),
    };
  }, [rawReport, commissionQuery.data, commandCenterQuery.data, overviewQuery.data, activeBreakdownQuery.data, serviceCentresData, rangeDays]);

  const cumulativeQuery = useQuery({
    queryKey: ['agent-products-cumulative', endDateKey],
    queryFn: async (): Promise<ApsCumulative> => {
      const { data, error } = await supabase.rpc('get_agent_products_cumulative' as any, { p_date: endDateKey });
      if (error) throw error;
      return data as unknown as ApsCumulative;
    },
    placeholderData: keepPreviousData,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });

  const cumulative = cumulativeQuery.data ?? null;

  /** Canonical operational agent population (main vs sub, active vs inactive). */
  const populationQuery = useQuery({
    queryKey: ['agent-operational-population', dayKey, endDateKey],
    queryFn: async (): Promise<AgentPopulation> => {
      const { data, error } = await supabase.rpc('get_agent_operational_population' as any, {
        p_as_of: endDateKey,
        p_from: dayKey,
      });
      if (error) throw error;
      return data as unknown as AgentPopulation;
    },
    placeholderData: keepPreviousData,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });


  // ===== Dynamic period-over-period baseline: the equal-length window immediately before =====
  const prevFrom = useMemo(() => subDays(startDate, rangeDays), [startDate, rangeDays]);
  const prevTo = useMemo(() => subDays(startDate, 1), [startDate]);
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
    placeholderData: keepPreviousData,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });

  const prevCommandCenterQuery = useQuery({
    queryKey: ['agent-collections-command-center-aps-prev', startOfDay(prevFrom).toISOString(), endOfDay(prevTo).toISOString()],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_agent_collections_command_center', {
        p_start: startOfDay(prevFrom).toISOString(),
        p_end: endOfDay(prevTo).toISOString(),
        p_bucket: 'day',
      });
      if (error) throw error;
      return data as any;
    },
    placeholderData: keepPreviousData,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });

  const prevOverviewQuery = useQuery({
    queryKey: ['agent-ops-overview', 'aps-sync-prev', startOfDay(prevFrom).toISOString(), endOfDay(prevTo).toISOString()],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_agent_ops_overview' as any, {
        p_range_start: startOfDay(prevFrom).toISOString(),
        p_range_end: endOfDay(prevTo).toISOString(),
      });
      if (error) throw error;
      return data as any;
    },
    placeholderData: keepPreviousData,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });

  const prevActiveBreakdownQuery = useQuery({
    queryKey: ['agent-ops-overview', 'active-breakdown-aps-prev', startOfDay(prevFrom).toISOString(), endOfDay(prevTo).toISOString()],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_agent_active_breakdown' as any, {
        p_range_start: startOfDay(prevFrom).toISOString(),
        p_range_end: endOfDay(prevTo).toISOString(),
      });
      if (error) throw error;
      return data as any;
    },
    placeholderData: keepPreviousData,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });

  const prevReport = useMemo(() => {
    const rawPrev = prevQuery.data;
    if (!rawPrev) return null;
    const prevCc = prevCommandCenterQuery.data;
    const prevOk = prevOverviewQuery.data?.kpis;
    const prevAb = prevActiveBreakdownQuery.data;

    let prevAgents = rawPrev.agents;
    if (prevOk) {
      const totalAgents = (prevOk.total_agents || 0) + (prevOk.total_subagents || 0);
      const newAgents = (prevOk.new_agents_curr || 0) + (prevOk.new_subagents_curr || 0);
      const activeAgents = prevAb?.total_curr ?? (prevOk.active_agents_curr !== undefined ? prevOk.active_agents_curr : prevAgents.active_today);
      prevAgents = {
        ...rawPrev.agents,
        total: totalAgents || rawPrev.agents.total,
        base: totalAgents || rawPrev.agents.base,
        new_today: newAgents !== undefined ? newAgents : rawPrev.agents.new_today,
        active_today: activeAgents !== undefined ? activeAgents : rawPrev.agents.active_today,
      };
    }

    if (!prevCc?.totals || Number(prevCc.totals.expected_due) === undefined) {
      return {
        ...rawPrev,
        agents: prevAgents,
      };
    }

    const expectedDue = Number(prevCc.totals.expected_due) || 0;
    const days = Math.max(1, rangeDays);
    const dailyReceivable = rangeDays === 1 ? expectedDue : (expectedDue / days);

    return {
      ...rawPrev,
      agents: prevAgents,
      rent: {
        ...rawPrev.rent,
        expected_cumulative: expectedDue,
        daily_receivable: dailyReceivable,
        expected_days: rangeDays,
      },
    };
  }, [prevQuery.data, prevCommandCenterQuery.data, prevOverviewQuery.data, prevActiveBreakdownQuery.data, rangeDays]);

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
      scApprovedVolume: p ? Number(p.service_centres.approved_volume) : undefined,
      scRejected: p ? Number(p.service_centres.rejected_count) : undefined,
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
      downloadBlob(blob, isRange ? `agent-products-services-${dayKey}_to_${endDateKey}.pdf` : `agent-products-services-${dayKey}.pdf`);
      toast.success(isRange ? 'Cumulative report downloaded' : 'Daily report downloaded');
    } catch (err: any) {
      toast.error(err?.message || 'Could not generate the report');
    } finally {
      setExporting(false);
    }
  };

  type RangePresetKind = 'd7' | 'd14' | 'd30' | 'd90' | 'y1' | 'month' | 'year' | 'all';
  const rangePresets: [RangePresetKind, string][] = [
    ['d7', 'Last 7 days'],
    ['d14', 'Last 14 days'],
    ['d30', 'Last 30 days'],
    ['d90', 'Last 90 days'],
    ['y1', 'Last 1 year'],
    ['month', 'This month'],
    ['year', 'This year'],
    ['all', 'All time'],
  ];

  const applyRangePreset = (kind: RangePresetKind) => {
    setActiveRangePreset(kind);
    const now = new Date();
    setRangeTo(now);
    if (kind === 'd7') setRangeFrom(subDays(now, 6));
    if (kind === 'd14') setRangeFrom(subDays(now, 13));
    if (kind === 'd30') setRangeFrom(subDays(now, 29));
    if (kind === 'd90') setRangeFrom(subDays(now, 89));
    if (kind === 'y1') setRangeFrom(subDays(now, 364));
    if (kind === 'month') setRangeFrom(startOfMonth(now));
    if (kind === 'year') setRangeFrom(startOfYear(now));
    if (kind === 'all') setRangeFrom(new Date(2015, 0, 1));
  };

  const activeRangePresetLabel = rangePresets.find(([k]) => k === activeRangePreset)?.[1];

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
              <Button size="sm" variant="outline" className="h-8 text-[11px]" onClick={() => {
                void reportQuery.refetch();
                void commissionQuery.refetch();
                void overviewQuery.refetch();
                void activeBreakdownQuery.refetch();
                void prevOverviewQuery.refetch();
                void prevActiveBreakdownQuery.refetch();
                void refetchServiceCentres();
              }}>
                <RefreshCw className={cn('h-3.5 w-3.5 mr-1', (reportQuery.isFetching || overviewQuery.isFetching) && 'animate-spin')} />
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
          <div className="flex flex-wrap items-center gap-2">
            {/* Mode Selector */}
            <div className="inline-flex items-center rounded-lg bg-muted/60 p-0.5 border">
              <Button
                type="button"
                size="sm"
                variant={mode === 'single' ? 'default' : 'ghost'}
                className="h-7 px-2.5 text-[11px] font-medium"
                onClick={() => setMode('single')}
              >
                Single Day
              </Button>
              <Button
                type="button"
                size="sm"
                variant={mode === 'range' ? 'default' : 'ghost'}
                className="h-7 px-2.5 text-[11px] font-medium"
                onClick={() => {
                  setMode('range');
                  if (!activeRangePreset) {
                    applyRangePreset('d7');
                  }
                }}
              >
                Cumulative / Range
              </Button>
            </div>

            <div className="h-4 w-px bg-border hidden sm:block" />

            {/* Controls for Single Day mode */}
            {mode === 'single' && (
              <div className="flex flex-wrap items-center gap-1.5">
                <Button
                  size="sm"
                  variant={isSameDay(singleDate, new Date()) ? 'default' : 'secondary'}
                  className="h-7 text-[11px]"
                  onClick={() => setSingleDate(new Date())}
                >
                  Today
                </Button>
                <Button
                  size="sm"
                  variant={isSameDay(singleDate, subDays(new Date(), 1)) ? 'default' : 'secondary'}
                  className="h-7 text-[11px]"
                  onClick={() => setSingleDate(subDays(new Date(), 1))}
                >
                  Yesterday
                </Button>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button size="sm" variant="outline" className="h-7 text-[11px] font-medium">
                      <CalendarIcon className="h-3.5 w-3.5 mr-1" />
                      {format(singleDate, 'dd MMM yyyy')}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0 z-[200]" align="start">
                    <Calendar
                      mode="single"
                      selected={singleDate}
                      onSelect={(d) => d && setSingleDate(d)}
                      disabled={(d) => d > new Date()}
                      initialFocus
                      className="p-3 pointer-events-auto"
                    />
                  </PopoverContent>
                </Popover>
                <span className="text-[10px] text-muted-foreground">
                  Showing single daily report for {format(singleDate, 'dd MMM yyyy')}
                </span>
              </div>
            )}

            {/* Controls for Range / Cumulative mode */}
            {mode === 'range' && (
              <div className="flex flex-wrap items-center gap-1.5">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button size="sm" variant={activeRangePreset ? 'default' : 'secondary'} className="h-7 text-[11px]">
                      {activeRangePresetLabel || 'Select Period'}
                      <ChevronDown className="h-3.5 w-3.5 ml-1" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="z-[200]">
                    {rangePresets.map(([k, l]) => (
                      <DropdownMenuItem
                        key={k}
                        className="text-[12px]"
                        onClick={() => applyRangePreset(k)}
                      >
                        {l}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>

                <Popover>
                  <PopoverTrigger asChild>
                    <Button size="sm" variant="outline" className="h-7 text-[11px]">
                      <CalendarIcon className="h-3.5 w-3.5 mr-1" />
                      From {format(rangeFrom, 'dd MMM yyyy')}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0 z-[200]" align="start">
                    <Calendar
                      mode="single"
                      selected={rangeFrom}
                      onSelect={(d) => {
                        if (d) {
                          setRangeFrom(d);
                          if (d > rangeTo) setRangeTo(d);
                          setActiveRangePreset(null);
                        }
                      }}
                      disabled={(d) => d > new Date()}
                      initialFocus
                      className="p-3 pointer-events-auto"
                    />
                  </PopoverContent>
                </Popover>

                <Popover>
                  <PopoverTrigger asChild>
                    <Button size="sm" variant="outline" className="h-7 text-[11px]">
                      <CalendarIcon className="h-3.5 w-3.5 mr-1" />
                      To {format(rangeTo, 'dd MMM yyyy')}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0 z-[200]" align="start">
                    <Calendar
                      mode="single"
                      selected={rangeTo}
                      onSelect={(d) => {
                        if (d) {
                          setRangeTo(d);
                          if (d < rangeFrom) setRangeFrom(d);
                          setActiveRangePreset(null);
                        }
                      }}
                      disabled={(d) => d > new Date()}
                      initialFocus
                      className="p-3 pointer-events-auto"
                    />
                  </PopoverContent>
                </Popover>

                <span className="text-[10px] text-muted-foreground">
                  Totals accumulate from {format(rangeFrom, 'dd MMM yyyy')} to {format(rangeTo, 'dd MMM yyyy')} ({num(rangeDays)} days)
                </span>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {reportQuery.isLoading && !report && (
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
              current={report.agents.new_today} previous={pop.newAgents} compareLabel={compareLabel} />
            <Kpi label="Total agents" value={num(report.agents.total)}
              current={report.agents.total} previous={pop.totalAgents} compareLabel={compareLabel}
              hint={report.agents.main_agents != null
                ? `${num(report.agents.main_agents)} main · ${num(report.agents.sub_agents)} sub-agents`
                : undefined} />
            <Kpi label="Active agents" value={num(report.agents.active_today)}
              current={report.agents.active_today} previous={pop.activeAgents} compareLabel={compareLabel}
              hint={report.agents.total > 0 ? `${((Number(report.agents.active_today) / Number(report.agents.total)) * 100).toFixed(1)}% of total network` : undefined} />
            <Kpi label="Rent collected" value={apsUgx(report.rent.collected_today)}
              current={report.rent.collected_today} previous={pop.collected} compareLabel={compareLabel} />
            <Kpi label="Expected target (period)" value={apsUgx(expectedTotal)}
              current={pop.expectedTotal === undefined ? undefined : expectedTotal}
              previous={pop.expectedTotal} compareLabel={compareLabel}
              hint={`${apsUgx(report.rent.daily_receivable)}/day`} />
            <Kpi label="Collection rate vs expected"
              value={`${expectedTotal > 0 ? ((Number(report.rent.collected_today) / expectedTotal) * 100).toFixed(1) : '0.0'}%`}
              hint={`${apsUgx(report.rent.collected_today)} of ${apsUgx(expectedTotal)}`} />
            <Kpi label="Outstanding receivable" value={apsUgx(report.rent.outstanding)}
              current={pop.outstanding === undefined ? undefined : report.rent.outstanding}
              previous={pop.outstanding} invert compareLabel={compareLabel} />
            <Kpi label="Advances issued" value={apsUgx(report.advances.issued_today)}
              current={pop.advIssued === undefined ? undefined : report.advances.issued_today}
              previous={pop.advIssued} compareLabel={compareLabel} />
            <Kpi label="Advance outstanding" value={apsUgx(report.advances.outstanding)}
              current={pop.advOutstanding === undefined ? undefined : report.advances.outstanding}
              previous={pop.advOutstanding} invert compareLabel={compareLabel}
              hint={`${apsUgx(report.advances.deducted_today)} recovered`} />
            <ServiceCentreConsolidatedCard report={report} previous={pop} compareLabel={compareLabel} />
            <Kpi label="Bikes outstanding" value={apsUgx(bikes?.outstanding)}
              current={pop.bikes === undefined ? undefined : Number(bikes?.outstanding) || 0}
              previous={pop.bikes} invert compareLabel={compareLabel}
              hint={`${apsUgx(bikes?.daily_receivable)} due daily · ${num(bikes?.pending_total ?? 0)} pending issue (${apsUgx(bikes?.pending_value ?? 0)})`} />
            <Kpi label="Smartphones outstanding" value={apsUgx(phones?.outstanding)}
              current={pop.phones === undefined ? undefined : Number(phones?.outstanding) || 0}
              previous={pop.phones} invert compareLabel={compareLabel}
              hint={`${apsUgx(phones?.daily_receivable)} due daily · ${num(phones?.pending_total ?? 0)} pending issue (${apsUgx(phones?.pending_value ?? 0)})`} />
            <Kpi label="Requests approved / rejected" value={`${num(report.advances.approved)} / ${num(report.advances.rejected)}`}
              current={pop.advApproved === undefined ? undefined : report.advances.approved}
              previous={pop.advApproved} compareLabel={compareLabel}
              hint="advance decisions" />
          </div>

          {/* Total agents composition & sources */}
          {populationQuery.isLoading ? (
            <Skeleton className="h-64 rounded-xl" />
          ) : populationQuery.error ? (
            <Card><CardContent className="p-4 text-xs text-destructive">
              {(populationQuery.error as any)?.message || 'Could not load the agent population composition'}
            </CardContent></Card>
          ) : populationQuery.data ? (
            <TotalAgentsComposition
              population={populationQuery.data}
              asOf={format(endDate, 'dd MMM yyyy')}
            />
          ) : null}

          {/* Cumulative build-up */}

          <Card>
            <CardHeader className="p-3 pb-1">
              <CardTitle className="text-xs font-bold">
                Cumulative build-up to {format(endDate, 'dd MMM yyyy')}
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

          {/* Detail tabs — ordered dynamically by record volume: smallest/empty sections first, high-volume sections last */}
          <Card>
            <CardContent className="p-3">
              {(() => {
                const counts: Record<string, number> = {
                  agents: (report.agent_float_rows || []).length,
                  new: (report.new_agent_rows || []).length,
                  rent: (report.rent_rows || []).length,
                  advances: (report.advance_rows || []).length,
                  sc: (report.service_centre_rows || []).length,
                  bikes: (report.product_rows || []).filter(r => r.product === 'bike').length,
                  phones: (report.product_rows || []).filter(r => r.product === 'smartphone').length,
                };
                const labels: Record<string, string> = {
                  agents: 'Agent performance',
                  new: 'New agents',
                  rent: 'Rent receivables',
                  advances: 'Advances',
                  sc: 'Service centres',
                  bikes: 'Motor bikes',
                  phones: 'Smartphones',
                };
                const tieBreak = ['sc', 'bikes', 'phones', 'new', 'advances', 'rent', 'agents'];
                const orderedTabs = Object.keys(labels).sort(
                  (a, b) => counts[a] - counts[b] || tieBreak.indexOf(a) - tieBreak.indexOf(b),
                );
                return (
              <Tabs defaultValue={orderedTabs[0]}>
                <TabsList className="flex flex-wrap h-auto gap-1">
                  {orderedTabs.map(v => (
                    <TabsTrigger key={v} value={v} className="text-[11px]">
                      {labels[v]}
                      <span className="ml-1 text-[10px] opacity-60">({counts[v]})</span>
                    </TabsTrigger>
                  ))}
                </TabsList>

                <TabsContent value="agents" className="mt-3 space-y-3">
                  {(() => {
                    const rows = report.agent_float_rows || [];
                    const total = rows.length;
                    const collecting = rows.filter(r => Number(r.collections_count) > 0).length;
                    const floatIn = rows.reduce((a, r) => a + (Number(r.float_received) || 0), 0);
                    const floatOut = rows.reduce((a, r) => a + (Number(r.float_paid_out) || 0), 0);
                    const collected = rows.reduce((a, r) => a + (Number(r.collections_amount) || 0), 0);
                    const top = [...rows].sort((a, b) => Number(b.collections_amount) - Number(a.collections_amount))[0];
                    const share = (n: number, d: number) => (d > 0 ? (n / d) * 100 : null);
                    return (
                      <PctSummary items={[
                        { label: 'Agents that collected', pct: share(collecting, total) },
                        { label: 'Float deployed to landlords', pct: share(floatOut, floatIn), hint: 'Paid out as share of float received' },
                        { label: 'Top agent concentration', pct: share(Number(top?.collections_amount) || 0, collected), hint: top ? `${top.agent_name}` : 'No collections' },
                        { label: 'Collections growth', pct: null, growth: { current: collected, previous: Number(pop.collected) || 0 }, hint: compareLabel },
                      ]} />
                    );
                  })()}
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

                <TabsContent value="new" className="mt-3 space-y-3">
                  <NewAgentPercentages
                    rows={report.new_agent_rows}
                    newCount={Number(report.agents.new_today) || 0}
                    prevCount={Number(pop.newAgents) || 0}
                    totalAgents={Number(report.agents.total) || 0}
                    compareLabel={compareLabel}
                  />
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

                <TabsContent value="rent" className="mt-3 space-y-3">
                  {(() => {
                    const rows = report.rent_rows || [];
                    const collected = Number(report.rent.collected_today) || 0;
                    const repaid = rows.reduce((a, r) => a + (Number(r.repaid_to_date) || 0), 0);
                    const outstanding = Number(report.rent.outstanding) || 0;
                    const paying = rows.filter(r => Number(r.collected_today) > 0).length;
                    const share = (n: number, d: number) => (d > 0 ? (n / d) * 100 : null);
                    return (
                      <PctSummary items={[
                        { label: 'Collection rate vs expected', pct: share(collected, expectedTotal), hint: 'Collected as share of period target' },
                        { label: 'Portfolio repaid to date', pct: share(repaid, repaid + outstanding), hint: 'Repaid vs repaid + outstanding' },
                        { label: 'Agents collecting today', pct: share(paying, rows.length) },
                        { label: 'Outstanding growth', pct: null, growth: { current: outstanding, previous: Number(pop.outstanding) || 0 }, invert: true, hint: compareLabel },
                      ]} />
                    );
                  })()}
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

                <TabsContent value="advances" className="mt-3 space-y-3">
                  {(() => {
                    const a = report.advances;
                    const submitted = Number(a.submitted) || 0;
                    const approved = Number(a.approved) || 0;
                    const rejected = Number(a.rejected) || 0;
                    const decided = approved + rejected;
                    const recovered = (report.advance_rows || []).reduce((s2, r) => s2 + (Number(r.recovered) || 0), 0);
                    const outstanding = Number(a.outstanding) || 0;
                    const share = (n: number, d: number) => (d > 0 ? (n / d) * 100 : null);
                    return (
                      <PctSummary items={[
                        { label: 'Approval rate', pct: share(approved, decided || submitted) },
                        { label: 'Rejection rate', pct: share(rejected, decided || submitted) },
                        { label: 'Recovery rate', pct: share(recovered, recovered + outstanding), hint: 'Recovered vs recovered + outstanding' },
                        { label: 'Issued growth', pct: null, growth: { current: Number(a.issued_today) || 0, previous: Number(pop.advIssued) || 0 }, hint: compareLabel },
                      ]} />
                    );
                  })()}
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
                );
              })()}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
