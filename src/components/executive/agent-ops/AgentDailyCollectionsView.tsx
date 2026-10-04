import { useMemo, useState } from 'react';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend,
} from 'recharts';
import {
  HandCoins, Users, UserCheck, MapPin, RefreshCw, Loader2, Search, TrendingUp,
} from 'lucide-react';
import { format } from 'date-fns';
import { formatUGX } from '@/lib/rentCalculations';
import {
  useAgentDailyCollections,
  PERIOD_LABELS,
  type CollectionsPeriod,
} from '@/hooks/useAgentDailyCollections';

const PERIODS: CollectionsPeriod[] = ['today', 'tomorrow', '5d', '7d', 'month', 'year'];

const initials = (name: string) =>
  (name || '?')
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join('') || '?';

function Kpi({
  icon: Icon,
  label,
  value,
  sub,
  tone = 'primary',
}: {
  icon: any;
  label: string;
  value: string;
  sub?: string;
  tone?: 'primary' | 'success' | 'warning' | 'foreground';
}) {
  const toneClass =
    tone === 'success'
      ? 'text-success'
      : tone === 'warning'
        ? 'text-warning'
        : tone === 'foreground'
          ? 'text-foreground'
          : 'text-primary';
  return (
    <Card className="p-3 min-w-0">
      <div className="flex items-center gap-2">
        <Icon className={`h-4 w-4 shrink-0 ${toneClass}`} />
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground truncate">
          {label}
        </p>
      </div>
      <p className={`mt-1 font-mono text-lg font-extrabold tabular-nums ${toneClass} truncate`}>
        {value}
      </p>
      {sub && <p className="text-[10px] text-muted-foreground truncate">{sub}</p>}
    </Card>
  );
}

/**
 * Daily Rent Collections — Agent Ops view.
 *
 * All figures come from one server-side call per period (see
 * `useAgentDailyCollections`): headline KPIs, the per-agent bar chart, the
 * collection lines table and the top-12 ranking are all slices of the same
 * payload, so the numbers on screen can never disagree with each other.
 */
export function AgentDailyCollectionsView() {
  const [period, setPeriod] = useState<CollectionsPeriod>('today');
  const [search, setSearch] = useState('');
  const { data, isLoading, isFetching, refetch, error } = useAgentDailyCollections(period);

  const kpis = data?.kpis;
  const isForecast = data?.mode === 'forecast';

  const agentBars = useMemo(
    () =>
      (data?.agents ?? []).slice(0, 20).map((a) => ({
        name: a.agent_name,
        collected: Math.round(isForecast ? a.expected : a.collected),
        expected: Math.round(a.expected),
      })),
    [data?.agents, isForecast],
  );

  const topLine = useMemo(
    () =>
      (data?.top_agents ?? []).map((a) => ({
        name: a.agent_name.split(' ')[0] || a.agent_name,
        fullName: a.agent_name,
        amount: Math.round(isForecast ? a.expected : a.collected),
        successRate: Number(a.success_rate) || 0,
        payments: a.payments,
      })),
    [data?.top_agents, isForecast],
  );

  const rows = useMemo(() => {
    const list = data?.rows ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return list;
    return list.filter((r) =>
      `${r.agent_name} ${r.tenant_name} ${r.tenant_phone ?? ''} ${r.address} ${r.landlord_name}`
        .toLowerCase()
        .includes(q),
    );
  }, [data?.rows, search]);

  const rowTotals = useMemo(
    () =>
      rows.reduce(
        (acc, r) => ({
          collected: acc.collected + Number(r.collected || 0),
          remaining: acc.remaining + Number(r.remaining || 0),
          balance: acc.balance + Number(r.balance || 0),
          expected: acc.expected + Number(r.expected || 0),
        }),
        { collected: 0, remaining: 0, balance: 0, expected: 0 },
      ),
    [rows],
  );

  return (
    <div className="space-y-4 min-w-0">
      {/* Universal period filter */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1.5">
          {PERIODS.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setPeriod(p)}
              className={`rounded-full border px-3 py-1.5 text-[11px] font-semibold transition ${
                period === p
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border bg-background text-muted-foreground hover:text-foreground'
              }`}
            >
              {PERIOD_LABELS[p]}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          {data && (
            <span className="text-[10px] text-muted-foreground">
              {data.from === data.to
                ? format(new Date(`${data.from}T00:00:00`), 'd MMM yyyy')
                : `${format(new Date(`${data.from}T00:00:00`), 'd MMM')} – ${format(new Date(`${data.to}T00:00:00`), 'd MMM yyyy')}`}
            </span>
          )}
          <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
            {isFetching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            <span className="ml-1.5 hidden sm:inline">Refresh</span>
          </Button>
        </div>
      </div>

      {isForecast && (
        <p className="rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-[11px] text-muted-foreground">
          Forecast for tomorrow — every figure below is what active repaying tenants are due to pay,
          not money already collected.
        </p>
      )}

      {error && (
        <Card className="p-3 text-xs text-destructive">
          {(error as any)?.message || 'Could not load collections'}
        </Card>
      )}

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
        <Kpi
          icon={HandCoins}
          label={isForecast ? 'Expected tomorrow' : 'Total collected'}
          value={isLoading ? '—' : formatUGX(isForecast ? (kpis?.total_expected ?? 0) : (kpis?.total_collected ?? 0))}
          sub={
            isForecast
              ? 'from active repaying tenants'
              : `of ${formatUGX(kpis?.total_expected ?? 0)} expected`
          }
          tone="success"
        />
        <Kpi
          icon={Users}
          label={isForecast ? 'Tenants due' : 'Tenants collected from'}
          value={isLoading ? '—' : String(kpis?.tenants_count ?? 0)}
          sub="active repaying tenants"
        />
        <Kpi
          icon={UserCheck}
          label={isForecast ? 'Agents with tenants due' : 'Agents who collected'}
          value={isLoading ? '—' : String(kpis?.agents_count ?? 0)}
          sub="field agents in this period"
          tone="foreground"
        />
        <Kpi
          icon={MapPin}
          label="Areas covered"
          value={isLoading ? '—' : String(kpis?.areas_count ?? 0)}
          sub="tenant addresses reached"
          tone="warning"
        />
      </div>

      {/* Per-agent bar chart */}
      <Card className="p-3 min-w-0">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          {isForecast ? 'Expected by agent' : 'Collected by agent'} · {PERIOD_LABELS[period]}
        </p>
        {isLoading ? (
          <p className="py-8 text-center text-xs text-muted-foreground">Loading…</p>
        ) : agentBars.length === 0 ? (
          <p className="py-8 text-center text-xs text-muted-foreground">Nothing recorded for this period.</p>
        ) : (
          <div className="mt-2 h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={agentBars} margin={{ top: 5, right: 8, left: 0, bottom: 40 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" vertical={false} />
                <XAxis
                  dataKey="name"
                  interval={0}
                  angle={-35}
                  textAnchor="end"
                  height={60}
                  tick={{ fontSize: 10 }}
                />
                <YAxis tickFormatter={(v) => `${Math.round(Number(v) / 1000)}k`} tick={{ fontSize: 10 }} />
                <Tooltip formatter={(v: any) => formatUGX(Number(v))} />
                <Bar
                  dataKey="collected"
                  name={isForecast ? 'Expected' : 'Collected'}
                  fill="hsl(var(--primary))"
                  radius={[4, 4, 0, 0]}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </Card>

      {/* Agent collections table */}
      <Card className="p-3 min-w-0">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Agent collections · {rows.length} line{rows.length === 1 ? '' : 's'}
          </p>
          <div className="relative w-full sm:w-64">
            <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search agent, tenant, phone, address"
              className="h-9 pl-7 text-xs"
            />
          </div>
        </div>

        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[900px] text-xs">
            <thead>
              <tr className="border-b border-border text-left text-[10px] uppercase tracking-wider text-muted-foreground">
                <th className="py-2 pr-3 font-semibold">Agent</th>
                <th className="py-2 pr-3 font-semibold">Tenant</th>
                <th className="py-2 pr-3 font-semibold">Location / Address</th>
                <th className="py-2 pr-3 font-semibold">Landlord</th>
                <th className="py-2 pr-3 text-right font-semibold">Collected</th>
                <th className="py-2 pr-3 text-right font-semibold">Remaining</th>
                <th className="py-2 pr-3 text-right font-semibold">Balance</th>
                <th className="py-2 text-right font-semibold">
                  Expected {period === 'today' ? 'today' : `(${PERIOD_LABELS[period].toLowerCase()})`}
                </th>
              </tr>
            </thead>
            <tbody>
              {isLoading && (
                <tr>
                  <td colSpan={8} className="py-8 text-center text-muted-foreground">Loading…</td>
                </tr>
              )}
              {!isLoading && rows.length === 0 && (
                <tr>
                  <td colSpan={8} className="py-8 text-center text-muted-foreground">
                    No collection lines for this period.
                  </td>
                </tr>
              )}
              {rows.map((r) => (
                <tr key={r.key} className="border-b border-border/60 align-top">
                  <td className="py-2 pr-3">
                    <div className="flex items-center gap-2 min-w-0">
                      <Avatar className="h-6 w-6 shrink-0">
                        <AvatarFallback className="text-[9px]">{initials(r.agent_name)}</AvatarFallback>
                      </Avatar>
                      <span className="truncate font-medium">{r.agent_name}</span>
                    </div>
                  </td>
                  <td className="py-2 pr-3">
                    <div className="flex items-center gap-2 min-w-0">
                      <Avatar className="h-6 w-6 shrink-0">
                        <AvatarFallback className="text-[9px]">{initials(r.tenant_name)}</AvatarFallback>
                      </Avatar>
                      <div className="min-w-0">
                        <p className="truncate font-medium">{r.tenant_name}</p>
                        <p className="truncate text-[10px] text-muted-foreground">
                          {r.tenant_phone || '—'}
                        </p>
                      </div>
                    </div>
                  </td>
                  <td className="py-2 pr-3">
                    <p className="max-w-[220px] truncate">{r.address}</p>
                    {r.area !== r.address && (
                      <p className="truncate text-[10px] text-muted-foreground">{r.area}</p>
                    )}
                  </td>
                  <td className="py-2 pr-3">
                    <p className="max-w-[160px] truncate">{r.landlord_name}</p>
                  </td>
                  <td className="py-2 pr-3 text-right font-mono tabular-nums text-success">
                    {formatUGX(r.collected)}
                  </td>
                  <td className="py-2 pr-3 text-right font-mono tabular-nums text-warning">
                    {formatUGX(r.remaining)}
                  </td>
                  <td className="py-2 pr-3 text-right font-mono tabular-nums">
                    {formatUGX(r.balance)}
                  </td>
                  <td className="py-2 text-right font-mono tabular-nums text-muted-foreground">
                    {formatUGX(r.expected)}
                  </td>
                </tr>
              ))}
            </tbody>
            {rows.length > 0 && (
              <tfoot>
                <tr className="border-t border-border font-semibold">
                  <td className="py-2 pr-3" colSpan={4}>Total shown</td>
                  <td className="py-2 pr-3 text-right font-mono tabular-nums text-success">
                    {formatUGX(rowTotals.collected)}
                  </td>
                  <td className="py-2 pr-3 text-right font-mono tabular-nums text-warning">
                    {formatUGX(rowTotals.remaining)}
                  </td>
                  <td className="py-2 pr-3 text-right font-mono tabular-nums">
                    {formatUGX(rowTotals.balance)}
                  </td>
                  <td className="py-2 text-right font-mono tabular-nums">
                    {formatUGX(rowTotals.expected)}
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </Card>

      {/* Top 12 agents — amount + success rate */}
      <Card className="p-3 min-w-0">
        <div className="flex items-center gap-2">
          <TrendingUp className="h-4 w-4 text-primary" />
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Top 12 agents · {isForecast ? 'expected' : 'amount collected'} and success rate
          </p>
        </div>
        {isLoading ? (
          <p className="py-8 text-center text-xs text-muted-foreground">Loading…</p>
        ) : topLine.length === 0 ? (
          <p className="py-8 text-center text-xs text-muted-foreground">No agents to rank yet.</p>
        ) : (
          <>
            <div className="mt-2 h-64 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={topLine} margin={{ top: 5, right: 8, left: 0, bottom: 40 }}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-border" vertical={false} />
                  <XAxis
                    dataKey="name"
                    interval={0}
                    angle={-35}
                    textAnchor="end"
                    height={60}
                    tick={{ fontSize: 10 }}
                  />
                  <YAxis
                    yAxisId="amt"
                    tickFormatter={(v) => `${Math.round(Number(v) / 1000)}k`}
                    tick={{ fontSize: 10 }}
                  />
                  <YAxis
                    yAxisId="rate"
                    orientation="right"
                    domain={[0, 100]}
                    tickFormatter={(v) => `${v}%`}
                    tick={{ fontSize: 10 }}
                  />
                  <Tooltip
                    formatter={(v: any, name: any) =>
                      name === 'Success rate' ? `${Number(v).toFixed(1)}%` : formatUGX(Number(v))
                    }
                  />
                  <Legend wrapperStyle={{ fontSize: 10 }} />
                  <Line
                    yAxisId="amt"
                    type="monotone"
                    dataKey="amount"
                    name={isForecast ? 'Expected' : 'Amount collected'}
                    stroke="hsl(var(--primary))"
                    strokeWidth={2}
                    dot={{ r: 3 }}
                  />
                  <Line
                    yAxisId="rate"
                    type="monotone"
                    dataKey="successRate"
                    name="Success rate"
                    stroke="hsl(var(--warning))"
                    strokeWidth={2}
                    dot={{ r: 3 }}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <div className="mt-2 overflow-x-auto">
              <table className="w-full min-w-[520px] text-xs">
                <thead>
                  <tr className="border-b border-border text-left text-[10px] uppercase tracking-wider text-muted-foreground">
                    <th className="py-2 pr-3 font-semibold">Agent name</th>
                    <th className="py-2 pr-3 text-right font-semibold">Collections</th>
                    <th className="py-2 pr-3 text-right font-semibold">Amount collected</th>
                    <th className="py-2 text-right font-semibold">Success rate</th>
                  </tr>
                </thead>
                <tbody>
                  {topLine.map((a) => (
                    <tr key={a.fullName} className="border-b border-border/60">
                      <td className="py-2 pr-3 truncate">{a.fullName}</td>
                      <td className="py-2 pr-3 text-right font-mono tabular-nums">{a.payments}</td>
                      <td className="py-2 pr-3 text-right font-mono tabular-nums text-success">
                        {formatUGX(a.amount)}
                      </td>
                      <td className="py-2 text-right font-mono tabular-nums">
                        {a.successRate.toFixed(1)}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
