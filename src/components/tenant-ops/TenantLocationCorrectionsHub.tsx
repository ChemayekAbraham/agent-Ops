/**
 * Tenant Location Corrections — Tenant Ops management dashboard.
 *
 * Every figure comes from one aggregate RPC (`tenant_location_correction_dashboard`)
 * built on the existing tenant / rent-request population and the correction audit
 * trail written by `correct_tenant_location`. Selecting an agent re-scopes every
 * card, chart and the tenant list to that agent's tenants. Nothing but the
 * location is ever written, and only through the existing correction dialog.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Badge } from '@/components/ui/badge';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { KPICard } from '@/components/executive/KPICard';
import {
  MapPin,
  Search,
  Loader2,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  CheckCircle2,
  Check,
  User,
  Users,
  Phone,
  Pencil,
  X,
  AlertCircle,
  CalendarDays,
  CalendarRange,
  Percent,
  Trophy,
  ListChecks,
  Activity,
  Sigma,
} from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import {
  legacyLocationLabel,
  useTenantLocationCorrections,
  useTenantLocationDashboard,
  type TenantLocationCorrectionRow,
  useTenantLocationActiveMetrics,
  type TenantLocationDashboardAgent,
} from '@/hooks/useTenantLocationCorrections';
import CorrectTenantLocationDialog from '@/components/location/CorrectTenantLocationDialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import UserLocationCorrectionsPanel from '@/components/tenant-ops/UserLocationCorrectionsPanel';

const PAGE_SIZE = 25;

const pctOf = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0);
const shortDay = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

function AgentProgressList({
  title,
  icon: Icon,
  rows,
  emphasis,
  onPick,
  loading,
}: {
  title: string;
  icon: typeof Trophy;
  rows: TenantLocationDashboardAgent[];
  emphasis: 'progress' | 'outstanding';
  onPick: (id: string) => void;
  loading: boolean;
}) {
  return (
    <Card>
      <CardHeader className="p-3 pb-1">
        <CardTitle className="flex items-center gap-2 text-xs font-bold">
          <Icon className="h-4 w-4 text-primary" /> {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="p-3 pt-2 space-y-2">
        {loading && (
          <div className="flex items-center gap-2 py-6 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
          </div>
        )}
        {!loading && rows.length === 0 && <p className="py-6 text-center text-xs text-muted-foreground">No agents to show</p>}
        {rows.map((a) => (
          <button
            key={a.agent_id}
            type="button"
            onClick={() => onPick(a.agent_id)}
            className="w-full rounded-lg border bg-card p-2 text-left hover:border-primary/50 hover:bg-accent/40 transition-colors"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate text-xs font-semibold">{a.agent_name || 'Unnamed agent'}</span>
              {emphasis === 'progress' ? (
                <span className="shrink-0 text-xs font-bold tabular-nums text-emerald-600">{a.pct}%</span>
              ) : (
                <span className="shrink-0 text-xs font-bold tabular-nums text-destructive">{a.outstanding} left</span>
              )}
            </div>
            <Progress value={a.pct} className="mt-1.5 h-1.5" />
            <p className="mt-1 text-[10px] text-muted-foreground tabular-nums">
              {a.corrected} corrected · {a.outstanding} outstanding · {a.required} needed fixing
            </p>
          </button>
        ))}
      </CardContent>
    </Card>
  );
}

function TenantCorrectionsPanel() {
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<TenantLocationCorrectionRow | null>(null);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [agentOpen, setAgentOpen] = useState(false);
  const [agentQuery, setAgentQuery] = useState('');
  const [selectedDay, setSelectedDay] = useState<string>('');

  useEffect(() => {
    const t = setTimeout(() => {
      setDebounced(search);
      setPage(0);
    }, 300);
    return () => clearTimeout(t);
  }, [search]);

  // Whole-system view is always loaded: it feeds the agent picker (agents with outstanding OR completed work).
  const overall = useTenantLocationDashboard(null);
  const scoped = useTenantLocationDashboard(agentId, !!agentId);
  const dash = agentId ? scoped : overall;
  const d = dash.data;

  const agentOptions = useMemo(() => {
    const all = overall.data?.agents ?? [];
    const q = agentQuery.trim().toLowerCase();
    if (!q) return all;
    return all.filter(
      (a) => (a.agent_name ?? '').toLowerCase().includes(q) || (a.agent_phone ?? '').toLowerCase().includes(q),
    );
  }, [overall.data, agentQuery]);
  const selectedAgent = useMemo(
    () => (overall.data?.agents ?? []).find((a) => a.agent_id === agentId) ?? null,
    [overall.data, agentId],
  );

  const list = useTenantLocationCorrections({ agentId, search: debounced, page, pageSize: PAGE_SIZE });
  const rows = list.data?.rows ?? [];
  const total = list.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const daily = d?.daily ?? [];
  useEffect(() => {
    if (!selectedDay && d?.as_of_day) setSelectedDay(d.as_of_day);
  }, [d?.as_of_day, selectedDay]);
  const dayRow = daily.find((x) => x.day === selectedDay);

  const correctionPct = pctOf(d?.corrected ?? 0, d?.required ?? 0);
  const outstandingPct = pctOf(d?.outstanding ?? 0, d?.required ?? 0);
  const populationPct = pctOf(d?.required ?? 0, d?.total_tenants ?? 0);

  // Active tenants = existing system definition (rent request funded / disbursed / repaying).
  const activeQ = useTenantLocationActiveMetrics(agentId);
  const am = activeQ.data;
  const activeLoading = activeQ.isLoading;
  const activeOutstandingPct = pctOf(am?.active_outstanding ?? 0, am?.active_tenants ?? 0);
  const activeSplit = am
    ? [
        { name: 'Correct location', value: am.active_corrected, fill: 'hsl(var(--primary))' },
        { name: 'Requires correction', value: am.active_outstanding, fill: 'hsl(var(--destructive))' },
      ]
    : [];

  const trend = useMemo(() => {
    let cum = 0;
    return daily.slice(-30).map((x) => {
      cum += x.tenants;
      return { day: shortDay(x.day), corrections: x.tenants, agents: x.agents, cumulative: cum };
    });
  }, [daily]);

  const split = d
    ? [
        { name: 'Corrected', value: d.corrected, fill: 'hsl(var(--primary))' },
        { name: 'Outstanding', value: d.outstanding, fill: 'hsl(var(--destructive))' },
      ]
    : [];

  const agentBars = useMemo(
    () =>
      (d?.agents ?? [])
        .slice()
        .sort((a, b) => b.required - a.required)
        .slice(0, 12)
        .map((a) => ({
          name: (a.agent_name || 'Unnamed').split(' ')[0],
          corrected: a.corrected,
          outstanding: a.outstanding,
        })),
    [d?.agents],
  );

  const pickAgent = (id: string | null) => {
    setAgentId(id);
    setPage(0);
    setAgentOpen(false);
  };

  const loading = dash.isLoading;

  return (
    <div className="space-y-4">
      {/* Header + agent filter */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base sm:text-lg">
            <MapPin className="h-4 w-4 text-primary" />
            Tenant Location Corrections
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Tenants saved before the approved location list. Once a tenant is matched they leave the outstanding list
            automatically. Counts reflect saved corrections only.
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Popover open={agentOpen} onOpenChange={setAgentOpen}>
              <PopoverTrigger asChild>
                <Button variant="outline" role="combobox" aria-expanded={agentOpen} className="w-full justify-between gap-2 sm:max-w-sm">
                  <span className="flex min-w-0 items-center gap-2">
                    <User className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="truncate">
                      {selectedAgent ? selectedAgent.agent_name || 'Unnamed agent' : agentId ? 'Selected agent' : 'All agents'}
                    </span>
                  </span>
                  <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-50" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-[min(22rem,calc(100vw-2rem))] p-0" align="start">
                <Command shouldFilter={false}>
                  <CommandInput value={agentQuery} onValueChange={setAgentQuery} placeholder="Search agent by name or phone" />
                  <CommandList>
                    {overall.isLoading ? (
                      <div className="flex items-center justify-center gap-2 py-6 text-xs text-muted-foreground">
                        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading agents…
                      </div>
                    ) : (
                      <>
                        <CommandEmpty>No agent found</CommandEmpty>
                        <CommandGroup>
                          <CommandItem value="__all__" onSelect={() => pickAgent(null)}>
                            <Check className={agentId ? 'mr-2 h-4 w-4 opacity-0' : 'mr-2 h-4 w-4'} />
                            All agents
                          </CommandItem>
                          {agentOptions.map((a) => (
                            <CommandItem key={a.agent_id} value={a.agent_id} onSelect={() => pickAgent(a.agent_id)}>
                              <Check className={agentId === a.agent_id ? 'mr-2 h-4 w-4' : 'mr-2 h-4 w-4 opacity-0'} />
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-sm">{a.agent_name || 'Unnamed agent'}</span>
                                <span className="block truncate text-[11px] text-muted-foreground">{a.agent_phone || '—'}</span>
                              </span>
                              <Badge
                                variant="outline"
                                className={`ml-2 shrink-0 text-[10px] ${a.outstanding === 0 ? 'text-emerald-600' : ''}`}
                              >
                                {a.outstanding === 0 ? 'Done' : `${a.outstanding.toLocaleString()} left`}
                              </Badge>
                            </CommandItem>
                          ))}
                        </CommandGroup>
                      </>
                    )}
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>

            {agentId && (
              <Button variant="ghost" size="sm" className="w-full gap-1.5 sm:w-auto" onClick={() => pickAgent(null)}>
                <X className="h-3.5 w-3.5" /> Clear agent
              </Button>
            )}
          </div>

          {agentId && (
            <p className="text-xs text-muted-foreground">
              Showing only tenants handled by{' '}
              <span className="font-semibold text-foreground">{selectedAgent?.agent_name || 'the selected agent'}</span>
              {selectedAgent?.agent_phone ? ` · ${selectedAgent.agent_phone}` : ''}.
            </p>
          )}

          {dash.isError && (
            <p className="flex items-center gap-1.5 text-xs text-destructive">
              <AlertCircle className="h-3.5 w-3.5" /> Could not load correction statistics.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Population */}
      <div className="grid grid-cols-2 gap-2.5 md:grid-cols-3 xl:grid-cols-6">
        <KPICard title="Total tenants" value={(d?.total_tenants ?? 0).toLocaleString()} icon={Users} loading={loading} />
        <KPICard
          title="Requiring correction"
          value={(d?.required ?? 0).toLocaleString()}
          icon={MapPin}
          loading={loading}
          color="bg-amber-500/10 text-amber-600"
          subtitle={`${populationPct}% of all tenants`}
        />
        <KPICard
          title="Corrected"
          value={(d?.corrected ?? 0).toLocaleString()}
          icon={CheckCircle2}
          loading={loading}
          color="bg-emerald-500/10 text-emerald-600"
        />
        <KPICard
          title="Still outstanding"
          value={(d?.outstanding ?? 0).toLocaleString()}
          icon={AlertCircle}
          loading={loading}
          color="bg-destructive/10 text-destructive"
        />
        <KPICard title="Correction %" value={`${correctionPct}%`} icon={Percent} loading={loading} color="bg-emerald-500/10 text-emerald-600" />
        <KPICard title="Outstanding %" value={`${outstandingPct}%`} icon={Percent} loading={loading} color="bg-destructive/10 text-destructive" />
      </div>

      {/* Active tenants — tenants with a live rent relationship (funded, disbursed or repaying) */}
      <div className="grid grid-cols-2 gap-2.5 md:grid-cols-3 xl:grid-cols-6">
        <KPICard
          title="Active tenants"
          value={(am?.active_tenants ?? 0).toLocaleString()}
          icon={Activity}
          loading={activeLoading}
          subtitle={`${am?.active_share_of_population ?? 0}% of all tenants`}
        />
        <KPICard
          title="Active corrected"
          value={(am?.active_corrected ?? 0).toLocaleString()}
          icon={CheckCircle2}
          loading={activeLoading}
          color="bg-emerald-500/10 text-emerald-600"
        />
        <KPICard
          title="Active outstanding"
          value={(am?.active_outstanding ?? 0).toLocaleString()}
          icon={AlertCircle}
          loading={activeLoading}
          color="bg-destructive/10 text-destructive"
        />
        <KPICard
          title="Active correction %"
          value={`${am?.active_pct_corrected ?? 0}%`}
          icon={Percent}
          loading={activeLoading}
          color="bg-emerald-500/10 text-emerald-600"
        />
        <KPICard
          title="Active share of outstanding"
          value={`${am?.active_share_of_outstanding ?? 0}%`}
          icon={Sigma}
          loading={activeLoading}
          color="bg-amber-500/10 text-amber-600"
          subtitle="of all tenants still to fix"
        />
        <KPICard
          title="Active tenants % of base"
          value={`${am?.active_share_of_population ?? 0}%`}
          icon={Users}
          loading={activeLoading}
        />
      </div>

      <Card>
        <CardHeader className="p-3 pb-1">
          <CardTitle className="flex items-center gap-2 text-xs font-bold">
            <Activity className="h-4 w-4 text-primary" /> Active tenants — location status
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 p-3 pt-2 lg:grid-cols-[minmax(0,260px)_1fr] lg:items-center">
          <div className="h-[220px]">
            {activeLoading ? (
              <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> Loading…
              </div>
            ) : (am?.active_tenants ?? 0) === 0 ? (
              <div className="flex h-full items-center justify-center text-xs text-muted-foreground">No active tenants</div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={activeSplit} dataKey="value" nameKey="name" innerRadius={55} outerRadius={85} paddingAngle={2}>
                    {activeSplit.map((s) => (
                      <Cell key={s.name} fill={s.fill} />
                    ))}
                  </Pie>
                  <Tooltip />
                </PieChart>
              </ResponsiveContainer>
            )}
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2 rounded-lg border bg-card p-2.5">
              <span className="flex min-w-0 items-center gap-2 text-xs font-semibold">
                <span className="h-2 w-2 shrink-0 rounded-full bg-primary" /> Correct location
              </span>
              <span className="shrink-0 text-xs font-bold tabular-nums text-emerald-600">
                {(am?.active_corrected ?? 0).toLocaleString()} · {am?.active_pct_corrected ?? 0}%
              </span>
            </div>
            <div className="flex items-center justify-between gap-2 rounded-lg border bg-card p-2.5">
              <span className="flex min-w-0 items-center gap-2 text-xs font-semibold">
                <span className="h-2 w-2 shrink-0 rounded-full bg-destructive" /> Still requiring correction
              </span>
              <span className="shrink-0 text-xs font-bold tabular-nums text-destructive">
                {(am?.active_outstanding ?? 0).toLocaleString()} · {activeOutstandingPct}%
              </span>
            </div>
            <Progress value={am?.active_pct_corrected ?? 0} className="h-2" />
            <p className="text-[11px] text-muted-foreground">
              {(am?.active_corrected ?? 0).toLocaleString()} of {(am?.active_tenants ?? 0).toLocaleString()} active tenants are
              matched to the approved Uganda location list. Active tenants are {am?.active_share_of_population ?? 0}% of all
              tenants and hold {am?.active_share_of_outstanding ?? 0}% of everything still to fix.
            </p>
          </div>
        </CardContent>
      </Card>



      <Card>
        <CardContent className="p-3 sm:p-4 space-y-1.5">
          <div className="flex items-center justify-between text-xs font-semibold">
            <span>
              {(d?.corrected ?? 0).toLocaleString()} of {(d?.required ?? 0).toLocaleString()} corrections done
            </span>
            <span className="text-muted-foreground">{correctionPct}%</span>
          </div>
          <Progress value={correctionPct} className="h-2" />
          <p className="text-[11px] text-muted-foreground">
            Correction population is {(d?.required ?? 0).toLocaleString()} of {(d?.total_tenants ?? 0).toLocaleString()} tenants (
            {populationPct}%). The rest were registered with the approved picker and never needed fixing.
          </p>
        </CardContent>
      </Card>

      {/* Agents + activity */}
      <div className="grid grid-cols-2 gap-2.5 md:grid-cols-3 xl:grid-cols-6">
        <KPICard
          title="Agents with outstanding"
          value={(d?.agents_outstanding ?? 0).toLocaleString()}
          icon={Users}
          loading={loading}
          color="bg-destructive/10 text-destructive"
        />
        <KPICard
          title="Agents completed"
          value={(d?.agents_completed ?? 0).toLocaleString()}
          icon={ListChecks}
          loading={loading}
          color="bg-emerald-500/10 text-emerald-600"
        />
        <KPICard title="Corrected today" value={(d?.corrected_today ?? 0).toLocaleString()} icon={CalendarDays} loading={loading} />
        <KPICard
          title="This week"
          value={(d?.corrected_week ?? 0).toLocaleString()}
          icon={CalendarRange}
          loading={loading}
          subtitle={`${(d?.corrected_month ?? 0).toLocaleString()} this month`}
        />
        <KPICard
          title="Avg per agent"
          value={(d?.avg_corrections_per_agent ?? 0).toLocaleString()}
          icon={Sigma}
          loading={loading}
          subtitle={`${(d?.agents_involved ?? 0).toLocaleString()} agents involved`}
        />
        <Card className="rounded-2xl">
          <CardContent className="p-3 sm:p-4 space-y-1.5">
            <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
              <div className="rounded-xl bg-primary/10 p-1.5 text-primary">
                <Activity className="h-4 w-4" />
              </div>
              Agents active on day
            </div>
            <Input
              type="date"
              value={selectedDay}
              min={daily[0]?.day}
              max={d?.as_of_day}
              onChange={(e) => setSelectedDay(e.target.value)}
              className="h-8 text-xs"
            />
            <p className="text-xl font-bold tabular-nums leading-tight">
              {loading ? '…' : dayRow ? dayRow.actors.toLocaleString() : '0'}
            </p>
            <p className="text-[10px] text-muted-foreground">
              {dayRow ? `${dayRow.tenants} tenants corrected` : 'Outside the 90-day window'}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Charts */}
      <div className="grid gap-3 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="p-3 pb-1">
            <CardTitle className="flex items-center gap-2 text-xs font-bold">
              <Activity className="h-4 w-4 text-primary" /> Corrections over time (30 days)
            </CardTitle>
          </CardHeader>
          <CardContent className="p-3 pt-2">
            <div className="h-[220px]">
              {loading ? (
                <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                  <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> Loading…
                </div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={trend} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                    <XAxis dataKey="day" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
                    <YAxis tick={{ fontSize: 10 }} allowDecimals={false} />
                    <Tooltip />
                    <Area type="monotone" dataKey="cumulative" name="Cumulative" stroke="hsl(var(--primary))" fill="hsl(var(--primary) / 0.15)" strokeWidth={2} />
                    <Area type="monotone" dataKey="corrections" name="Per day" stroke="hsl(var(--chart-2, var(--primary)))" fill="hsl(var(--primary) / 0.35)" strokeWidth={1.5} />
                  </AreaChart>
                </ResponsiveContainer>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="p-3 pb-1">
            <CardTitle className="flex items-center gap-2 text-xs font-bold">
              <Percent className="h-4 w-4 text-primary" /> Corrected vs outstanding
            </CardTitle>
          </CardHeader>
          <CardContent className="p-3 pt-2">
            <div className="h-[220px]">
              {loading ? (
                <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                  <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> Loading…
                </div>
              ) : (d?.required ?? 0) === 0 ? (
                <div className="flex h-full items-center justify-center text-xs text-muted-foreground">Nothing needed fixing</div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={split} dataKey="value" nameKey="name" innerRadius={55} outerRadius={85} paddingAngle={2}>
                      {split.map((s) => (
                        <Cell key={s.name} fill={s.fill} />
                      ))}
                    </Pie>
                    <Tooltip />
                  </PieChart>
                </ResponsiveContainer>
              )}
            </div>
            <div className="mt-1 flex justify-center gap-4 text-[11px]">
              <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-primary" /> Corrected {correctionPct}%</span>
              <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-destructive" /> Outstanding {outstandingPct}%</span>
            </div>
          </CardContent>
        </Card>
      </div>

      {!agentId && (
        <Card>
          <CardHeader className="p-3 pb-1">
            <CardTitle className="flex items-center gap-2 text-xs font-bold">
              <Users className="h-4 w-4 text-primary" /> Agent progress (largest workloads)
            </CardTitle>
          </CardHeader>
          <CardContent className="p-3 pt-2">
            <div className="h-[240px]">
              {loading ? (
                <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                  <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> Loading…
                </div>
              ) : agentBars.length === 0 ? (
                <div className="flex h-full items-center justify-center text-xs text-muted-foreground">No agent workload</div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={agentBars} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                    <XAxis dataKey="name" tick={{ fontSize: 10 }} />
                    <YAxis tick={{ fontSize: 10 }} allowDecimals={false} />
                    <Tooltip />
                    <Bar dataKey="corrected" name="Corrected" stackId="a" fill="hsl(var(--primary))" />
                    <Bar dataKey="outstanding" name="Outstanding" stackId="a" fill="hsl(var(--destructive))" radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {!agentId && (
        <div className="grid gap-3 md:grid-cols-2">
          <AgentProgressList title="Highest progress" icon={Trophy} rows={d?.top_progress ?? []} emphasis="progress" onPick={pickAgent} loading={loading} />
          <AgentProgressList title="Highest outstanding workload" icon={AlertCircle} rows={d?.top_outstanding ?? []} emphasis="outstanding" onPick={pickAgent} loading={loading} />
        </div>
      )}

      {/* Outstanding tenant list */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-bold">Outstanding tenants{agentId ? ' for this agent' : ''}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search tenant, phone, old district or agent" className="pl-9" />
          </div>

          {list.isLoading && (
            <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading tenants…
            </div>
          )}

          {!list.isLoading && rows.length === 0 && (
            <div className="flex flex-col items-center gap-2 py-12 text-center">
              <CheckCircle2 className="h-6 w-6 text-emerald-600" />
              <p className="text-sm font-semibold">
                {debounced ? 'No tenants match that search' : agentId ? 'This agent has no tenants left to correct' : 'Every tenant is on the approved list'}
              </p>
            </div>
          )}

          {rows.length > 0 && (
            <>
              {/* Mobile / tablet cards */}
              <div className="space-y-2 lg:hidden">
                {rows.map((row) => (
                  <div key={row.tenant_id} className="rounded-xl border bg-card p-3 space-y-2">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-sm font-semibold truncate">{row.tenant_name || 'Unnamed tenant'}</p>
                        {row.tenant_phone && (
                          <p className="mt-0.5 flex items-center gap-1 text-[11px] text-muted-foreground">
                            <Phone className="h-3 w-3" /> {row.tenant_phone}
                          </p>
                        )}
                      </div>
                      {row.request_status && (
                        <Badge variant="outline" className="shrink-0 text-[10px]">
                          {row.request_status.replace(/_/g, ' ')}
                        </Badge>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground break-words">
                      <span className="font-medium text-foreground">On record: </span>
                      {legacyLocationLabel(row)}
                    </p>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                      <span className="flex items-center gap-1">
                        <User className="h-3 w-3" /> {row.agent_name || 'No agent'}
                        {row.agent_phone ? ` · ${row.agent_phone}` : ''}
                      </span>
                      {row.monthly_rent != null && <span>{formatUGX(row.monthly_rent)}</span>}
                    </div>
                    <Button size="sm" className="w-full gap-1.5" onClick={() => setSelected(row)}>
                      <Pencil className="h-3.5 w-3.5" /> Correct location
                    </Button>
                  </div>
                ))}
              </div>

              {/* Desktop table */}
              <div className="hidden lg:block overflow-x-auto rounded-xl border">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50">
                    <tr className="text-left">
                      <th className="p-2.5 font-semibold">Tenant</th>
                      <th className="p-2.5 font-semibold">Location on record</th>
                      <th className="p-2.5 font-semibold">Agent</th>
                      <th className="p-2.5 font-semibold">Rent</th>
                      <th className="p-2.5 font-semibold">Status</th>
                      <th className="p-2.5 font-semibold text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.tenant_id} className="border-t hover:bg-accent/30">
                        <td className="p-2.5">
                          <p className="font-medium">{row.tenant_name || 'Unnamed tenant'}</p>
                          <p className="text-[11px] text-muted-foreground">{row.tenant_phone || '—'}</p>
                        </td>
                        <td className="p-2.5 max-w-[22rem] text-muted-foreground">{legacyLocationLabel(row)}</td>
                        <td className="p-2.5">
                          <p>{row.agent_name || 'No agent'}</p>
                          <p className="text-[11px] text-muted-foreground">{row.agent_phone || '—'}</p>
                        </td>
                        <td className="p-2.5 whitespace-nowrap">{row.monthly_rent != null ? formatUGX(row.monthly_rent) : '—'}</td>
                        <td className="p-2.5">
                          {row.request_status ? (
                            <Badge variant="outline" className="text-[10px]">
                              {row.request_status.replace(/_/g, ' ')}
                            </Badge>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td className="p-2.5 text-right">
                          <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setSelected(row)}>
                            <Pencil className="h-3.5 w-3.5" /> Correct
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="flex flex-col sm:flex-row items-center justify-between gap-2 pt-1">
                <p className="text-xs text-muted-foreground">
                  Showing {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} of {total.toLocaleString()}
                </p>
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="outline" className="gap-1" disabled={page === 0 || list.isFetching} onClick={() => setPage((p) => Math.max(0, p - 1))}>
                    <ChevronLeft className="h-3.5 w-3.5" /> Previous
                  </Button>
                  <span className="text-xs text-muted-foreground">
                    Page {page + 1} of {pageCount}
                  </span>
                  <Button size="sm" variant="outline" className="gap-1" disabled={page + 1 >= pageCount || list.isFetching} onClick={() => setPage((p) => p + 1)}>
                    Next <ChevronRight className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <CorrectTenantLocationDialog
        open={!!selected}
        onOpenChange={(v) => !v && setSelected(null)}
        tenant={
          selected
            ? {
                id: selected.tenant_id,
                name: selected.tenant_name,
                phone: selected.tenant_phone,
                legacyLabel: legacyLocationLabel(selected),
                districtHint: null,
              }
            : null
        }
        onCorrected={() => setSelected(null)}
      />
    </div>
  );
}

/**
 * Two monitoring surfaces over the SAME correction system and the same approved
 * Uganda dataset: tenants (unchanged) and all other authenticated system users.
 */
export function TenantLocationCorrectionsHub() {
  return (
    <Tabs defaultValue="tenants" className="space-y-4">
      <TabsList className="w-full sm:w-auto grid grid-cols-2 sm:inline-flex">
        <TabsTrigger value="tenants" className="text-xs sm:text-sm">
          Tenant Location Corrections
        </TabsTrigger>
        <TabsTrigger value="users" className="text-xs sm:text-sm">
          User Location Corrections
        </TabsTrigger>
      </TabsList>
      <TabsContent value="tenants" className="mt-0">
        <TenantCorrectionsPanel />
      </TabsContent>
      <TabsContent value="users" className="mt-0">
        <UserLocationCorrectionsPanel />
      </TabsContent>
    </Tabs>
  );
}

export default TenantLocationCorrectionsHub;
