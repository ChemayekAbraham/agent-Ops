import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  addDays,
  addMonths,
  endOfMonth,
  format,
  startOfDay,
  startOfMonth,
  subDays,
  subMonths,
} from 'date-fns';
import {
  AlertTriangle,
  CalendarDays,
  ChevronRight,
  CircleAlert,
  Download,
  Loader2,
  Phone,
  Scale,
  Search,
} from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/rentCalculations';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { UserDrilldownDrawer } from '@/components/ops/UserDrilldownDrawer';

type Granularity = 'day' | 'week' | 'month' | 'custom';

type PositionBand =
  | 'ahead'
  | 'on_track'
  | 'behind'
  | 'overdue'
  | 'cleared'
  | 'not_due_yet'
  | 'unattributed';

interface PositionRow {
  rent_request_id: string | null;
  agent_id: string | null;
  tenant_id: string | null;
  frequency: string | null;
  instalment_amount: number | null;
  term_start: string | null;
  term_end: string | null;
  obligation_end: string | null;
  total_repayment: number | null;
  expected_in_period: number | null;
  due_dates_in_period: number | null;
  paid_in_period_agent: number | null;
  paid_in_period_self: number | null;
  expected_to_date: number | null;
  paid_to_date: number | null;
  arrears: number | null;
  credit_ahead: number | null;
  covered_through: string | null;
  outstanding: number | null;
  position_band: PositionBand | string;
  is_eligible: boolean | null;
  exclusion_reason: string | null;
}

interface Profile {
  id: string;
  full_name: string | null;
  phone: string | null;
}

interface PlanRow extends PositionRow {
  tenantName: string;
  tenantPhone: string | null;
}

interface AgentPositionRow {
  id: string;
  name: string;
  phone: string | null;
  tenantCount: number;
  expected: number;
  paidAgent: number;
  paidSelf: number;
  paidTotal: number;
  arrears: number;
  creditAhead: number;
  unattributed: number;
  bands: Record<string, number>;
  plans: PlanRow[];
}

const BAND_LABELS: Record<string, string> = {
  ahead: 'Ahead',
  on_track: 'On track',
  behind: 'Behind',
  overdue: 'Overdue',
  cleared: 'Cleared',
  not_due_yet: 'Not due yet',
  unattributed: 'Unattributed',
};

const BAND_ORDER: PositionBand[] = [
  'ahead',
  'on_track',
  'behind',
  'overdue',
  'cleared',
  'not_due_yet',
];

const num = (value: number | null | undefined) => Number(value ?? 0);

const iso = (date: Date) => format(date, 'yyyy-MM-dd');

const getErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : 'Unable to load payment positions.';

function BandBadge({ band }: { band: string }) {
  const label = BAND_LABELS[band] ?? band;
  if (band === 'ahead') {
    return <Badge className="bg-success text-success-foreground hover:bg-success/90">{label}</Badge>;
  }
  if (band === 'cleared') {
    return <Badge variant="secondary">{label}</Badge>;
  }
  if (band === 'on_track') {
    return <Badge className="bg-primary/15 text-primary hover:bg-primary/20">{label}</Badge>;
  }
  if (band === 'behind') {
    return <Badge className="bg-warning text-warning-foreground hover:bg-warning/90">{label}</Badge>;
  }
  if (band === 'overdue') {
    return <Badge variant="destructive">{label}</Badge>;
  }
  return <Badge variant="outline">{label}</Badge>;
}

/** Resolve the reporting window for the chosen granularity. */
function resolveRange(granularity: Granularity, anchor: Date, custom: { from: string; to: string }) {
  if (granularity === 'day') return { from: iso(anchor), to: iso(anchor) };
  if (granularity === 'week') return { from: iso(subDays(anchor, 6)), to: iso(anchor) };
  if (granularity === 'month') return { from: iso(startOfMonth(anchor)), to: iso(endOfMonth(anchor)) };
  const from = custom.from || iso(anchor);
  const to = custom.to || iso(anchor);
  return from <= to ? { from, to } : { from: to, to: from };
}

export function AgentPaymentPosition() {
  const today = useMemo(() => startOfDay(new Date()), []);
  const [granularity, setGranularity] = useState<Granularity>('day');
  const [anchor, setAnchor] = useState(today);
  const [custom, setCustom] = useState({ from: iso(subDays(today, 29)), to: iso(today) });
  const [includeSelf, setIncludeSelf] = useState(true);
  const [search, setSearch] = useState('');
  const [bandFilter, setBandFilter] = useState<'all' | PositionBand>('all');
  const [frequencyFilter, setFrequencyFilter] = useState<string>('all');
  const [selectedAgent, setSelectedAgent] = useState<AgentPositionRow | null>(null);
  const [selectedTenant, setSelectedTenant] = useState<string | null>(null);

  const range = useMemo(() => resolveRange(granularity, anchor, custom), [anchor, custom, granularity]);

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['agent-payment-position', range.from, range.to, includeSelf],
    queryFn: async () => {
      const { data: rows, error: rpcError } = await supabase.rpc('get_agent_monitoring_positions', {
        p_from: range.from,
        p_to: range.to,
        p_include_self_payments: includeSelf,
      });
      if (rpcError) throw rpcError;
      const positions = (rows ?? []) as PositionRow[];

      const ids = Array.from(
        new Set(
          positions
            .flatMap((row) => [row.agent_id, row.tenant_id])
            .filter((id): id is string => Boolean(id)),
        ),
      );
      const profiles: Profile[] = [];
      const CHUNK = 300;
      for (let index = 0; index < ids.length; index += CHUNK) {
        const { data: batch, error: profileError } = await supabase
          .from('profiles')
          .select('id, full_name, phone')
          .in('id', ids.slice(index, index + CHUNK));
        if (profileError) throw profileError;
        profiles.push(...((batch ?? []) as Profile[]));
      }
      return { positions, profiles };
    },
    staleTime: 30_000,
  });

  const profileMap = useMemo(
    () => new Map((data?.profiles ?? []).map((profile) => [profile.id, profile])),
    [data?.profiles],
  );

  const frequencies = useMemo(() => {
    const set = new Set<string>();
    (data?.positions ?? []).forEach((row) => {
      if (row.frequency) set.add(row.frequency);
    });
    return Array.from(set).sort();
  }, [data?.positions]);

  const agents = useMemo<AgentPositionRow[]>(() => {
    const grouped = new Map<string, PositionRow[]>();
    (data?.positions ?? []).forEach((row) => {
      if (!row.agent_id) return;
      const rows = grouped.get(row.agent_id) ?? [];
      rows.push(row);
      grouped.set(row.agent_id, rows);
    });

    return Array.from(grouped.entries())
      .map(([agentId, rows]) => {
        const profile = profileMap.get(agentId);
        const plans: PlanRow[] = rows
          .filter((row) => row.rent_request_id)
          .filter((row) => frequencyFilter === 'all' || row.frequency === frequencyFilter)
          .filter((row) => bandFilter === 'all' || row.position_band === bandFilter)
          .map((row) => {
            const tenant = row.tenant_id ? profileMap.get(row.tenant_id) : undefined;
            return {
              ...row,
              tenantName: tenant?.full_name || 'Unknown tenant',
              tenantPhone: tenant?.phone ?? null,
            };
          })
          .sort((a, b) => num(b.arrears) - num(a.arrears));

        const bands: Record<string, number> = {};
        plans.forEach((plan) => {
          bands[plan.position_band] = (bands[plan.position_band] ?? 0) + 1;
        });

        const unattributed = rows
          .filter((row) => !row.rent_request_id)
          .reduce((sum, row) => sum + num(row.paid_in_period_agent), 0);

        const paidAgent = plans.reduce((sum, plan) => sum + num(plan.paid_in_period_agent), 0);
        const paidSelf = plans.reduce((sum, plan) => sum + num(plan.paid_in_period_self), 0);

        return {
          id: agentId,
          name: profile?.full_name || 'Unnamed agent',
          phone: profile?.phone ?? null,
          tenantCount: new Set(plans.map((plan) => plan.tenant_id)).size,
          expected: plans.reduce((sum, plan) => sum + num(plan.expected_in_period), 0),
          paidAgent,
          paidSelf,
          paidTotal: paidAgent + paidSelf,
          arrears: plans.reduce((sum, plan) => sum + num(plan.arrears), 0),
          creditAhead: plans.reduce((sum, plan) => sum + num(plan.credit_ahead), 0),
          unattributed,
          bands,
          plans,
        };
      })
      .filter((agent) => agent.plans.length > 0 || agent.unattributed > 0)
      .sort((a, b) => b.arrears - a.arrears || b.expected - a.expected || a.name.localeCompare(b.name));
  }, [bandFilter, data?.positions, frequencyFilter, profileMap]);

  const filteredAgents = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return agents;
    return agents.filter((agent) =>
      `${agent.name} ${agent.phone ?? ''}`.toLowerCase().includes(query) ||
      agent.plans.some((plan) => plan.tenantName.toLowerCase().includes(query)),
    );
  }, [agents, search]);

  const totals = useMemo(() => {
    const base = filteredAgents.reduce(
      (sum, agent) => ({
        expected: sum.expected + agent.expected,
        paid: sum.paid + agent.paidTotal,
        paidSelf: sum.paidSelf + agent.paidSelf,
        arrears: sum.arrears + agent.arrears,
        ahead: sum.ahead + agent.creditAhead,
        unattributed: sum.unattributed + agent.unattributed,
        tenants: sum.tenants + agent.tenantCount,
      }),
      { expected: 0, paid: 0, paidSelf: 0, arrears: 0, ahead: 0, unattributed: 0, tenants: 0 },
    );
    const bands: Record<string, number> = {};
    filteredAgents.forEach((agent) => {
      Object.entries(agent.bands).forEach(([band, count]) => {
        bands[band] = (bands[band] ?? 0) + count;
      });
    });
    return { ...base, bands, difference: base.paid - base.expected };
  }, [filteredAgents]);

  const shiftPeriod = (direction: -1 | 1) => {
    setAnchor((value) => {
      if (granularity === 'month') return startOfMonth(direction === 1 ? addMonths(value, 1) : subMonths(value, 1));
      if (granularity === 'week') return direction === 1 ? addDays(value, 7) : subDays(value, 7);
      return direction === 1 ? addDays(value, 1) : subDays(value, 1);
    });
  };

  const exportCsv = () => {
    const header = [
      'Agent', 'Agent phone', 'Tenant', 'Frequency', 'Instalment', 'Due dates in period',
      'Expected in period', 'Paid by agent', 'Paid by tenant', 'Expected vs paid',
      'Expected to date', 'Paid to date', 'Arrears', 'Ahead credit', 'Covered through',
      'Outstanding', 'Position', 'Exclusion reason',
    ];
    const lines = filteredAgents.flatMap((agent) =>
      agent.plans.map((plan) => [
        agent.name,
        agent.phone ?? '',
        plan.tenantName,
        plan.frequency ?? '',
        num(plan.instalment_amount),
        num(plan.due_dates_in_period),
        num(plan.expected_in_period),
        num(plan.paid_in_period_agent),
        num(plan.paid_in_period_self),
        num(plan.paid_in_period_agent) + num(plan.paid_in_period_self) - num(plan.expected_in_period),
        num(plan.expected_to_date),
        num(plan.paid_to_date),
        num(plan.arrears),
        num(plan.credit_ahead),
        plan.covered_through ?? '',
        num(plan.outstanding),
        BAND_LABELS[plan.position_band] ?? plan.position_band,
        plan.exclusion_reason ?? '',
      ]),
    );
    const csv = [header, ...lines]
      .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','))
      .join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `agent-payment-position-${range.from}_${range.to}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const periodLabel =
    range.from === range.to
      ? format(new Date(`${range.from}T00:00:00`), 'dd MMM yyyy')
      : `${format(new Date(`${range.from}T00:00:00`), 'dd MMM')} – ${format(new Date(`${range.to}T00:00:00`), 'dd MMM yyyy')}`;

  const renderAgentCard = (agent: AgentPositionRow) => {
    const difference = agent.paidTotal - agent.expected;
    return (
      <div key={agent.id} className="rounded-lg border p-3">
        <button
          type="button"
          className="flex w-full items-start justify-between gap-3 text-left"
          onClick={() => setSelectedAgent(agent)}
        >
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold">{agent.name}</p>
            <p className="truncate text-xs text-muted-foreground">
              {agent.phone || 'No phone number'} · {agent.tenantCount} tenants
            </p>
            <p className="mt-1 break-words text-xs tabular-nums text-muted-foreground">
              {formatUGX(agent.paidTotal)} paid / {formatUGX(agent.expected)} expected
            </p>
            <p className="mt-0.5 break-words text-xs tabular-nums text-muted-foreground">
              Arrears {formatUGX(agent.arrears)} · Ahead {formatUGX(agent.creditAhead)}
            </p>
          </div>
          <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" />
        </button>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <Badge variant={difference >= 0 ? 'secondary' : 'destructive'} className="tabular-nums">
            {difference >= 0 ? '+' : '−'}{formatUGX(Math.abs(difference))}
          </Badge>
          {BAND_ORDER.filter((band) => agent.bands[band]).map((band) => (
            <span key={band} className="text-[10px] text-muted-foreground">
              {agent.bands[band]} {BAND_LABELS[band].toLowerCase()}
            </span>
          ))}
        </div>
      </div>
    );
  };

  const renderAgentRow = (agent: AgentPositionRow) => {
    const difference = agent.paidTotal - agent.expected;
    const rate = agent.expected > 0 ? (agent.paidTotal / agent.expected) * 100 : null;
    return (
      <TableRow key={agent.id} className="cursor-pointer" onClick={() => setSelectedAgent(agent)}>
        <TableCell>
          <div className="min-w-[170px]">
            <p className="font-semibold">{agent.name}</p>
            <p className="text-xs text-muted-foreground">{agent.phone || 'No phone number'}</p>
          </div>
        </TableCell>
        <TableCell className="text-right tabular-nums">{agent.tenantCount}</TableCell>
        <TableCell className="text-right tabular-nums">{formatUGX(agent.expected)}</TableCell>
        <TableCell className="text-right tabular-nums">{formatUGX(agent.paidTotal)}</TableCell>
        <TableCell className={`text-right tabular-nums font-semibold ${difference < 0 ? 'text-destructive' : 'text-success'}`}>
          {difference >= 0 ? '+' : '−'}{formatUGX(Math.abs(difference))}
        </TableCell>
        <TableCell className="text-right tabular-nums">{formatUGX(agent.creditAhead)}</TableCell>
        <TableCell className="text-right tabular-nums">{formatUGX(agent.arrears)}</TableCell>
        <TableCell className="text-right tabular-nums">{rate === null ? '—' : `${rate.toFixed(1)}%`}</TableCell>
        <TableCell>
          <div className="flex flex-wrap gap-1">
            {BAND_ORDER.filter((band) => agent.bands[band]).map((band) => (
              <Badge key={band} variant="outline" className="text-[10px] font-normal">
                {agent.bands[band]} {BAND_LABELS[band].toLowerCase()}
              </Badge>
            ))}
          </div>
        </TableCell>
        <TableCell className="text-right">
          <ChevronRight className="ml-auto h-4 w-4 text-muted-foreground" />
        </TableCell>
      </TableRow>
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex items-center gap-2.5">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10">
            <Scale className="h-4.5 w-4.5 text-primary" />
          </div>
          <div>
            <h1 className="text-lg font-bold leading-tight">Expected vs actual paid</h1>
            <p className="text-[11px] text-muted-foreground">
              Schedule-aware expectation per tenant · {periodLabel}
            </p>
          </div>
        </div>

        <div className="flex w-full flex-col gap-2 lg:w-auto lg:flex-row lg:items-center">
          <div className="flex flex-wrap gap-1 rounded-lg border p-1" role="group" aria-label="Reporting period">
            {(['day', 'week', 'month', 'custom'] as const).map((value) => (
              <Button
                key={value}
                variant={granularity === value ? 'secondary' : 'ghost'}
                size="sm"
                className="h-8 flex-1 px-2.5 text-xs capitalize"
                onClick={() => setGranularity(value)}
              >
                {value}
              </Button>
            ))}
          </div>
          {granularity === 'custom' ? (
            <div className="flex flex-wrap items-center gap-2">
              <Input
                type="date"
                value={custom.from}
                onChange={(event) => setCustom((value) => ({ ...value, from: event.target.value }))}
                className="h-8 w-[150px] text-xs"
                aria-label="From date"
              />
              <Input
                type="date"
                value={custom.to}
                onChange={(event) => setCustom((value) => ({ ...value, to: event.target.value }))}
                className="h-8 w-[150px] text-xs"
                aria-label="To date"
              />
            </div>
          ) : (
            <div className="flex w-full flex-wrap items-center gap-1 rounded-lg border p-1 sm:w-auto">
              <Button variant="ghost" size="sm" onClick={() => shiftPeriod(-1)} aria-label="Previous period">←</Button>
              <div className="flex-1 min-w-[110px] text-center text-xs font-medium tabular-nums sm:flex-none sm:min-w-[150px]">
                {periodLabel}
              </div>
              <Button variant="ghost" size="sm" onClick={() => shiftPeriod(1)} aria-label="Next period">→</Button>
              <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setAnchor(today)}>
                <CalendarDays className="h-3.5 w-3.5" /> Today
              </Button>
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Card>
          <CardContent className="p-3.5">
            <p className="text-xs text-muted-foreground">Expected in period</p>
            <p className="mt-1 text-lg font-bold tabular-nums">{formatUGX(totals.expected)}</p>
            <p className="text-[10px] text-muted-foreground">{totals.tenants} tenants scheduled</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3.5">
            <p className="text-xs text-muted-foreground">Actual paid</p>
            <p className="mt-1 text-lg font-bold tabular-nums">{formatUGX(totals.paid)}</p>
            <p className="text-[10px] text-muted-foreground">{formatUGX(totals.paidSelf)} paid by tenants</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3.5">
            <p className="text-xs text-muted-foreground">Expected vs paid</p>
            <p className={`mt-1 text-lg font-bold tabular-nums ${totals.difference < 0 ? 'text-destructive' : 'text-success'}`}>
              {totals.difference >= 0 ? '+' : '−'}{formatUGX(Math.abs(totals.difference))}
            </p>
            <p className="text-[10px] text-muted-foreground">
              {totals.expected > 0 ? `${((totals.paid / totals.expected) * 100).toFixed(1)}% of expectation` : 'Nothing due'}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3.5">
            <p className="text-xs text-muted-foreground">Paid ahead (credit)</p>
            <p className="mt-1 text-lg font-bold tabular-nums text-success">{formatUGX(totals.ahead)}</p>
            <p className="text-[10px] text-muted-foreground">{totals.bands.ahead ?? 0} tenants ahead</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3.5">
            <p className="text-xs text-muted-foreground">Arrears at period end</p>
            <p className="mt-1 text-lg font-bold tabular-nums text-destructive">{formatUGX(totals.arrears)}</p>
            <p className="text-[10px] text-muted-foreground">
              {(totals.bands.behind ?? 0) + (totals.bands.overdue ?? 0)} tenants behind
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="flex flex-col gap-3 pb-3 lg:flex-row lg:items-center lg:justify-between">
          <CardTitle className="text-base">Payment position by agent</CardTitle>
          <div className="flex w-full flex-col gap-2 lg:w-auto lg:flex-row lg:items-center">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search agent, phone or tenant"
                className="h-8 w-full pl-8 text-xs lg:w-56"
              />
            </div>
            <Select value={frequencyFilter} onValueChange={setFrequencyFilter}>
              <SelectTrigger className="h-8 w-full text-xs lg:w-[140px]">
                <SelectValue placeholder="Frequency" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All frequencies</SelectItem>
                {frequencies.map((frequency) => (
                  <SelectItem key={frequency} value={frequency} className="capitalize">{frequency}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={bandFilter} onValueChange={(value) => setBandFilter(value as 'all' | PositionBand)}>
              <SelectTrigger className="h-8 w-full text-xs lg:w-[140px]">
                <SelectValue placeholder="Position" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All positions</SelectItem>
                {BAND_ORDER.map((band) => (
                  <SelectItem key={band} value={band}>{BAND_LABELS[band]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="flex items-center gap-2 rounded-lg border px-2.5 py-1.5">
              <Switch id="include-self" checked={includeSelf} onCheckedChange={setIncludeSelf} />
              <Label htmlFor="include-self" className="text-xs">Tenant self-payments</Label>
            </div>
            <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs" onClick={exportCsv} disabled={filteredAgents.length === 0}>
              <Download className="h-3.5 w-3.5" /> CSV
            </Button>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="flex items-center justify-center gap-2 p-10 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading payment positions…
            </div>
          ) : isError ? (
            <div className="flex flex-col items-center gap-3 p-10 text-center">
              <AlertTriangle className="h-5 w-5 text-destructive" />
              <p className="text-sm text-muted-foreground">{getErrorMessage(error)}</p>
              <Button variant="outline" size="sm" onClick={() => void refetch()}>Try again</Button>
            </div>
          ) : filteredAgents.length === 0 ? (
            <div className="flex flex-col items-center gap-2 p-10 text-center">
              <CircleAlert className="h-5 w-5 text-muted-foreground" />
              <p className="text-sm font-medium">No agents match this view</p>
              <p className="text-xs text-muted-foreground">Try a wider period or clear the filters.</p>
            </div>
          ) : (
            <>
              <div className="hidden overflow-x-auto lg:block">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Agent name / phone</TableHead>
                      <TableHead className="text-right">Tenants</TableHead>
                      <TableHead className="text-right">Expected</TableHead>
                      <TableHead className="text-right">Actual paid</TableHead>
                      <TableHead className="text-right">Difference</TableHead>
                      <TableHead className="text-right">Ahead</TableHead>
                      <TableHead className="text-right">Arrears</TableHead>
                      <TableHead className="text-right">Rate</TableHead>
                      <TableHead>Positions</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>{filteredAgents.map((agent) => renderAgentRow(agent))}</TableBody>
                </Table>
              </div>
              <div className="space-y-2 p-3 lg:hidden">{filteredAgents.map((agent) => renderAgentCard(agent))}</div>
            </>
          )}
          {totals.unattributed > 0 && (
            <p className="border-t p-3 text-[11px] text-muted-foreground">
              {formatUGX(totals.unattributed)} of agent cash in this period has no rent plan reference, so it cannot be
              matched to a tenant's schedule. It is excluded from the figures above.
            </p>
          )}
        </CardContent>
      </Card>

      <Dialog open={Boolean(selectedAgent)} onOpenChange={(open) => { if (!open) setSelectedAgent(null); }}>
        <DialogContent className="max-h-[90vh] w-[calc(100vw-2rem)] max-w-5xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="break-words pr-6 text-base sm:text-lg">
              {selectedAgent?.name || 'Agent'} — payment position
            </DialogTitle>
            <DialogDescription className="break-words">
              {selectedAgent?.phone || 'No phone number'} · {periodLabel}
            </DialogDescription>
          </DialogHeader>
          {selectedAgent && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Card><CardContent className="p-3"><p className="text-xs text-muted-foreground">Expected</p><p className="mt-1 font-bold tabular-nums">{formatUGX(selectedAgent.expected)}</p></CardContent></Card>
                <Card><CardContent className="p-3"><p className="text-xs text-muted-foreground">Collected by agent</p><p className="mt-1 font-bold tabular-nums">{formatUGX(selectedAgent.paidAgent)}</p></CardContent></Card>
                <Card><CardContent className="p-3"><p className="text-xs text-muted-foreground">Paid by tenants</p><p className="mt-1 font-bold tabular-nums">{formatUGX(selectedAgent.paidSelf)}</p></CardContent></Card>
                <Card><CardContent className="p-3"><p className="text-xs text-muted-foreground">Arrears</p><p className="mt-1 font-bold tabular-nums text-destructive">{formatUGX(selectedAgent.arrears)}</p></CardContent></Card>
              </div>
              {selectedAgent.phone && (
                <Button asChild variant="outline" size="sm" className="w-full gap-2 sm:w-auto">
                  <a href={`tel:${selectedAgent.phone.replace(/[^\d+]/g, '')}`}>
                    <Phone className="h-4 w-4" /> Call {selectedAgent.name}
                  </a>
                </Button>
              )}
              <Separator />
              <div className="space-y-2">
                <h3 className="text-sm font-semibold">Tenants ({selectedAgent.plans.length})</h3>
                {selectedAgent.plans.length === 0 ? (
                  <p className="py-6 text-center text-sm text-muted-foreground">No tenant plans match the current filters.</p>
                ) : (
                  <div className="space-y-2">
                    {selectedAgent.plans.map((plan) => (
                      <div key={plan.rent_request_id} className="rounded-lg border p-3">
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                          <div className="min-w-0">
                            <Button
                              variant="link"
                              className="h-auto p-0 text-left font-semibold"
                              onClick={() => plan.tenant_id && setSelectedTenant(plan.tenant_id)}
                            >
                              {plan.tenantName}
                            </Button>
                            <p className="text-xs text-muted-foreground">
                              {plan.tenantPhone ? (
                                <a href={`tel:${plan.tenantPhone.replace(/[^\d+]/g, '')}`} className="underline underline-offset-2">{plan.tenantPhone}</a>
                              ) : 'No phone number'}
                              {plan.frequency ? ` · ${plan.frequency} · ${formatUGX(num(plan.instalment_amount))} per instalment` : ''}
                            </p>
                            <p className="mt-1 text-xs text-muted-foreground">
                              {num(plan.due_dates_in_period)} due date(s) in period
                              {plan.covered_through ? ` · covered through ${format(new Date(`${plan.covered_through}T00:00:00`), 'dd MMM yyyy')}` : ' · nothing covered yet'}
                            </p>
                            {plan.exclusion_reason && (
                              <p className="mt-1 text-xs text-warning">{plan.exclusion_reason}</p>
                            )}
                          </div>
                          <BandBadge band={plan.position_band} />
                        </div>
                        <div className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4 lg:grid-cols-6">
                          <div><Label className="text-[10px] text-muted-foreground">Expected</Label><p className="font-semibold tabular-nums">{formatUGX(num(plan.expected_in_period))}</p></div>
                          <div><Label className="text-[10px] text-muted-foreground">Paid in period</Label><p className="font-semibold tabular-nums">{formatUGX(num(plan.paid_in_period_agent) + num(plan.paid_in_period_self))}</p></div>
                          <div><Label className="text-[10px] text-muted-foreground">Expected to date</Label><p className="font-semibold tabular-nums">{formatUGX(num(plan.expected_to_date))}</p></div>
                          <div><Label className="text-[10px] text-muted-foreground">Paid to date</Label><p className="font-semibold tabular-nums">{formatUGX(num(plan.paid_to_date))}</p></div>
                          <div><Label className="text-[10px] text-muted-foreground">Arrears</Label><p className="font-semibold tabular-nums text-destructive">{formatUGX(num(plan.arrears))}</p></div>
                          <div><Label className="text-[10px] text-muted-foreground">Ahead / outstanding</Label><p className="font-semibold tabular-nums">{formatUGX(num(plan.credit_ahead))} / {formatUGX(num(plan.outstanding))}</p></div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <UserDrilldownDrawer
        open={Boolean(selectedTenant)}
        onOpenChange={(open) => { if (!open) setSelectedTenant(null); }}
        tenantId={selectedTenant}
        agentId={selectedAgent?.id}
        defaultTab="tenant"
      />
    </div>
  );
}

export default AgentPaymentPosition;
