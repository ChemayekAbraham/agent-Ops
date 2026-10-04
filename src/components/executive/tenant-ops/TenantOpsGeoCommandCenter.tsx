import { useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Loader2, ChevronRight, Building2, Users, Search, RefreshCw, Trophy,
} from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import {
  useTenantOpsGeoMetrics, rollupGeoRows, deriveRatios, nextGeoLevel,
  GEO_LEVEL_LABEL, type GeoPath, type GeoMetricsRow,
} from '@/hooks/useTenantOpsAnalytics';
import { TenantOpsAgent360Panel } from './TenantOpsAgent360Panel';
import {
  BarChart, Bar, PieChart, Pie, Cell, ResponsiveContainer, XAxis, YAxis, Tooltip, Legend, CartesianGrid,
} from 'recharts';

const LEVEL_ICON = {
  district: Building2, agent: Users,
} as const;

type SortKey = 'collected' | 'collection_rate' | 'occupancy' | 'arrears' | 'tenants' | 'new_tenants' | 'landlords';

const SORTS: { key: SortKey; label: string }[] = [
  { key: 'collected', label: 'Revenue generated' },
  { key: 'collection_rate', label: 'Collection rate' },
  { key: 'occupancy', label: 'Occupancy rate' },
  { key: 'arrears', label: 'Lowest arrears' },
  { key: 'tenants', label: 'Portfolio size' },
  { key: 'new_tenants', label: 'New tenants acquired' },
  { key: 'landlords', label: 'Landlords acquired' },
];

function sortValue(r: GeoMetricsRow, k: SortKey): number {
  const d = deriveRatios(r);
  switch (k) {
    case 'collected': return r.collected_to_date;
    case 'collection_rate': return d.collectionRate;
    case 'occupancy': return d.occupancyRate;
    case 'arrears': return -r.overdue_amount;
    case 'tenants': return r.tenants_total;
    case 'new_tenants': return r.tenants_new_month;
    case 'landlords': return r.landlords_total;
  }
}

function Kpi({ label, value, sub, tone }: { label: string; value: string | number; sub?: string; tone?: 'good' | 'bad' | 'warn' }) {
  const toneCls = tone === 'good' ? 'text-emerald-600' : tone === 'bad' ? 'text-destructive' : tone === 'warn' ? 'text-amber-600' : 'text-foreground';
  return (
    <div className="rounded-xl border border-border bg-card p-3">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground truncate">{label}</p>
      <p className={`text-base font-black mt-0.5 ${toneCls}`}>{value}</p>
      {sub && <p className="text-[10px] text-muted-foreground mt-0.5">{sub}</p>}
    </div>
  );
}

/**
 * Tenant Operations — Operations Intelligence command center.
 * District → Agent drill-down; every figure is live from
 * get_tenant_ops_geo_metrics / get_tenant_ops_agent_360.
 */
export function TenantOpsGeoCommandCenter() {
  const [path, setPath] = useState<GeoPath>({});
  const [agentId, setAgentId] = useState<string | null>(null);
  const [agentName, setAgentName] = useState<string | undefined>();
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('collected');
  const [status, setStatus] = useState<'all' | 'collecting' | 'arrears' | 'vacant'>('all');

  const level = nextGeoLevel(path);
  const { data: rows, isLoading, isFetching, refetch } = useTenantOpsGeoMetrics(path);

  const filtered = useMemo(() => {
    let list = (rows ?? []).filter((r) => r.label.toLowerCase().includes(search.trim().toLowerCase()));
    if (status === 'collecting') list = list.filter((r) => r.paid_month > 0);
    if (status === 'arrears') list = list.filter((r) => r.arrears_count > 0);
    if (status === 'vacant') list = list.filter((r) => r.vacant_units > 0);
    return [...list].sort((a, b) => sortValue(b, sortKey) - sortValue(a, sortKey));
  }, [rows, search, sortKey, status]);

  const total = useMemo(() => rollupGeoRows(rows), [rows]);
  const ratios = deriveRatios(total);

  const chartRows = filtered.slice(0, 12).map((r) => ({
    name: r.label.length > 14 ? `${r.label.slice(0, 13)}…` : r.label,
    Expected: Math.round(r.expected_to_date),
    Collected: Math.round(r.collected_to_date),
    Outstanding: Math.round(r.outstanding_total),
  }));

  /**
   * Today's collection funnel. Rent on this platform is repaid DAILY, so every
   * active plan with a balance is billable every single day — the funnel below,
   * not a calendar due-date match, is the correct operational picture.
   */
  const funnel = [
    { name: 'Settled today', value: total.settled_today, fill: 'hsl(142 71% 45%)' },
    { name: 'Part-paid today', value: total.partial_today, fill: 'hsl(38 92% 50%)' },
    { name: 'Covered by advance', value: total.covered_by_advance, fill: 'hsl(var(--primary))' },
    { name: 'Not collected yet', value: total.uncollected_today, fill: 'hsl(var(--destructive))' },
  ].filter((s) => s.value > 0);

  /** Arrears ageing — standard portfolio-at-risk buckets, measured in days behind. */
  const ageing = [
    { name: 'On schedule', count: total.par_current },
    { name: '1–7 days', count: total.par_1_7 },
    { name: '8–30 days', count: total.par_8_30 },
    { name: '31–60 days', count: total.par_31_60 },
    { name: '60+ days', count: total.par_60_plus },
  ];

  const crumbs: { label: string; onClick: () => void }[] = [
    { label: 'All districts', onClick: () => { setPath({}); setAgentId(null); } },
  ];
  if (path.district) crumbs.push({ label: path.district, onClick: () => setAgentId(null) });

  const drill = (r: GeoMetricsRow) => {
    if (level === 'agent') { setAgentId(r.agent_id); setAgentName(r.label); return; }
    setPath({ district: r.key });
  };

  const Icon = LEVEL_ICON[level];

  if (agentId) {
    return (
      <div className="space-y-3">
        <nav className="flex flex-wrap items-center gap-1 text-xs">
          {crumbs.map((c, i) => (
            <span key={i} className="flex items-center gap-1">
              {i > 0 && <ChevronRight className="h-3 w-3 text-muted-foreground" />}
              <button onClick={c.onClick} className="hover:text-primary text-muted-foreground">{c.label}</button>
            </span>
          ))}
          <ChevronRight className="h-3 w-3 text-muted-foreground" />
          <span className="font-semibold">{agentName}</span>
        </nav>
        <TenantOpsAgent360Panel agentId={agentId} agentName={agentName} onBack={() => setAgentId(null)} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Breadcrumb + controls */}
      <div className="flex flex-wrap items-center gap-2">
        <nav className="flex flex-wrap items-center gap-1 text-xs mr-auto">
          {crumbs.map((c, i) => (
            <span key={i} className="flex items-center gap-1">
              {i > 0 && <ChevronRight className="h-3 w-3 text-muted-foreground" />}
              <button
                onClick={c.onClick}
                className={i === crumbs.length - 1 ? 'font-semibold' : 'text-muted-foreground hover:text-primary'}
              >
                {c.label}
              </button>
            </span>
          ))}
        </nav>
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={`Search ${GEO_LEVEL_LABEL[level].toLowerCase()}`} className="h-8 pl-7 w-44 text-xs" />
        </div>
        <Select value={status} onValueChange={(v) => setStatus(v as any)}>
          <SelectTrigger className="h-8 w-36 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="collecting">Collecting</SelectItem>
            <SelectItem value="arrears">In arrears</SelectItem>
            <SelectItem value="vacant">Has vacancies</SelectItem>
          </SelectContent>
        </Select>
        <Select value={sortKey} onValueChange={(v) => setSortKey(v as SortKey)}>
          <SelectTrigger className="h-8 w-44 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            {SORTS.map((s) => <SelectItem key={s.key} value={s.key}>Rank by {s.label.toLowerCase()}</SelectItem>)}
          </SelectContent>
        </Select>
        <Button size="sm" variant="outline" className="h-8" onClick={() => refetch()} disabled={isFetching}>
          <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? 'animate-spin' : ''}`} />
        </Button>
      </div>

      {/* KPI band */}
      <div className="grid grid-cols-2 sm:grid-cols-4 xl:grid-cols-6 gap-2">
        <Kpi label="Total tenants" value={total.tenants_total.toLocaleString()} sub={`${total.tenants_active.toLocaleString()} active · ${total.tenants_inactive.toLocaleString()} inactive`} />
        <Kpi label="New this month" value={total.tenants_new_month.toLocaleString()} sub={`Growth ${ratios.growthRate.toFixed(1)}%`} tone={ratios.growthRate >= 0 ? 'good' : 'bad'} />
        <Kpi label="Billable today" value={total.billable_today.toLocaleString()} sub={`${formatUGX(total.expected_today)} expected today`} />
        <Kpi label="Collected today" value={formatUGX(total.collected_today)} sub={`${ratios.dailyCollectionRate.toFixed(1)}% of today's expectation`} tone={ratios.dailyCollectionRate >= 80 ? 'good' : 'warn'} />
        <Kpi label="Settled today" value={total.settled_today.toLocaleString()} sub={`${total.partial_today} part-paid · ${total.covered_by_advance} on advance`} tone="good" />
        <Kpi label="Not collected yet" value={total.uncollected_today.toLocaleString()} sub={`Touch rate ${ratios.dailyContactRate.toFixed(1)}%`} tone="bad" />
        <Kpi label="Behind schedule" value={total.overdue_count.toLocaleString()} sub={`${formatUGX(total.overdue_amount)} · avg ${total.avg_days_behind.toFixed(1)}d behind`} tone="bad" />
        <Kpi label="At risk 30d+" value={`${ratios.par30Rate.toFixed(1)}%`} sub={`${(total.par_31_60 + total.par_60_plus).toLocaleString()} tenants · ${formatUGX(total.par_amount_30_plus)}`} tone="warn" />
        <Kpi label="Paid week to date" value={formatUGX(total.paid_week)} sub={`Month ${formatUGX(total.paid_month)}`} tone="good" />
        <Kpi label="Monthly rent expected" value={formatUGX(total.rent_expected_monthly)} />
        <Kpi label="Collected this month" value={formatUGX(total.rent_collected_month)} sub={`${ratios.monthCollectionRate.toFixed(1)}% of expected`} tone="good" />
        <Kpi label="Collection rate (to date)" value={`${ratios.collectionRate.toFixed(1)}%`} sub={`${formatUGX(total.collected_to_date)} / ${formatUGX(total.expected_to_date)}`} />
        <Kpi label="Outstanding rent" value={formatUGX(total.outstanding_total)} tone="warn" />
        <Kpi label="Advance payments" value={formatUGX(total.advance_amount)} tone="good" />
        <Kpi label="Average rent" value={formatUGX(Math.round(total.avg_rent))} />
        <Kpi label="Properties" value={total.properties_total.toLocaleString()} sub={`${total.occupied_units} occupied · ${total.vacant_units} vacant`} />
        <Kpi label="Occupancy rate" value={`${ratios.occupancyRate.toFixed(1)}%`} sub={`Vacancy ${ratios.vacancyRate.toFixed(1)}%`} />
        <Kpi label="Landlords" value={total.landlords_total.toLocaleString()} sub={`${total.landlords_new} new this month`} />
        <Kpi label="Agents" value={total.agents_total.toLocaleString()} sub={`${total.agents_active} active`} />
        <Kpi label="Expiring leases (30d)" value={total.expiring_leases.toLocaleString()} sub={`${total.ended_leases} ended`} tone="warn" />
        <Kpi label="Tenant retention" value={`${ratios.retentionRate.toFixed(1)}%`} sub={`${total.regions_count} regions · ${total.districts_count} districts`} />
      </div>

      <Tabs defaultValue="nodes">
        <TabsList>
          <TabsTrigger value="nodes">{GEO_LEVEL_LABEL[level]}</TabsTrigger>
          <TabsTrigger value="charts">Charts</TabsTrigger>
          <TabsTrigger value="table">Performance table</TabsTrigger>
        </TabsList>

        <TabsContent value="nodes" className="mt-4">
          {isLoading ? (
            <div className="flex justify-center py-16"><Loader2 className="h-5 w-5 animate-spin text-primary" /></div>
          ) : filtered.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-12">No {GEO_LEVEL_LABEL[level].toLowerCase()} match the current filters.</p>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
              {filtered.map((r, idx) => {
                const d = deriveRatios(r);
                return (
                  <Card
                    key={r.key}
                    className="cursor-pointer hover:border-primary/50 transition-colors"
                    onClick={() => drill(r)}
                    onDoubleClick={() => drill(r)}
                  >
                    <CardHeader className="pb-2 flex-row items-center gap-2 space-y-0">
                      <Icon className="h-4 w-4 text-primary shrink-0" />
                      <CardTitle className="text-sm truncate">{r.label}</CardTitle>
                      {idx < 3 && sortKey && <Badge variant="secondary" className="ml-auto text-[10px] gap-1"><Trophy className="h-3 w-3" />#{idx + 1}</Badge>}
                    </CardHeader>
                    <CardContent className="grid grid-cols-3 gap-2 text-[11px]">
                      <div><p className="text-muted-foreground">Tenants</p><p className="font-bold">{r.tenants_total.toLocaleString()}</p></div>
                      <div><p className="text-muted-foreground">Active</p><p className="font-bold text-emerald-600">{r.tenants_active.toLocaleString()}</p></div>
                      <div><p className="text-muted-foreground">New (mo)</p><p className="font-bold">{r.tenants_new_month}</p></div>
                      <div><p className="text-muted-foreground">Collected</p><p className="font-bold">{formatUGX(r.collected_to_date)}</p></div>
                      <div><p className="text-muted-foreground">Coll. rate</p><p className="font-bold">{d.collectionRate.toFixed(1)}%</p></div>
                      <div><p className="text-muted-foreground">Outstanding</p><p className="font-bold text-amber-600">{formatUGX(r.outstanding_total)}</p></div>
                      <div><p className="text-muted-foreground">Billable today</p><p className="font-bold">{r.billable_today}</p></div>
                      <div><p className="text-muted-foreground">Not collected</p><p className="font-bold text-destructive">{r.uncollected_today}</p></div>
                      <div><p className="text-muted-foreground">Today %</p><p className="font-bold">{d.dailyCollectionRate.toFixed(0)}%</p></div>
                      <div><p className="text-muted-foreground">Behind</p><p className="font-bold text-destructive">{r.overdue_count}</p></div>
                      <div><p className="text-muted-foreground">Occupancy</p><p className="font-bold">{d.occupancyRate.toFixed(0)}%</p></div>
                      <div><p className="text-muted-foreground">Landlords</p><p className="font-bold">{r.landlords_total}</p></div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
          <p className="text-[11px] text-muted-foreground mt-3">
            Click a card to drill down{level === 'district' ? ' into the agents operating in that district' : ' into the agent 360 view'}.
          </p>
        </TabsContent>

        <TabsContent value="charts" className="mt-4 grid grid-cols-1 lg:grid-cols-2 gap-3">
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm">Expected vs collected vs outstanding</CardTitle></CardHeader>
            <CardContent className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartRows}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="name" tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" interval={0} angle={-25} textAnchor="end" height={60} />
                  <YAxis tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" width={70} />
                  <Tooltip formatter={(v: any) => formatUGX(Number(v))} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Bar dataKey="Expected" fill="hsl(var(--muted-foreground) / 0.5)" />
                  <Bar dataKey="Collected" fill="hsl(142 71% 45%)" />
                  <Bar dataKey="Outstanding" fill="hsl(var(--destructive))" />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Today's collection funnel</CardTitle>
              <p className="text-[11px] text-muted-foreground">
                Rent is repaid daily, so all {total.billable_today.toLocaleString()} live plans are billable today.
              </p>
            </CardHeader>
            <CardContent className="h-72">
              {funnel.length === 0 ? (
                <p className="text-xs text-muted-foreground text-center pt-24">No live repayment plans here yet.</p>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={funnel} dataKey="value" nameKey="name" innerRadius={55} outerRadius={95} paddingAngle={2}>
                      {funnel.map((s) => <Cell key={s.name} fill={s.fill} />)}
                    </Pie>
                    <Tooltip />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                  </PieChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>

          <Card className="lg:col-span-2">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Arrears ageing (days behind the daily schedule)</CardTitle>
              <p className="text-[11px] text-muted-foreground">
                Portfolio at risk. Days behind = arrears ÷ daily installment.
              </p>
            </CardHeader>
            <CardContent className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={ageing}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="name" tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" />
                  <YAxis tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" />
                  <Tooltip formatter={(v: any) => `${Number(v).toLocaleString()} tenants`} />
                  <Bar dataKey="count" name="Tenants" fill="hsl(38 92% 50%)" />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          <Card className="lg:col-span-2">
            <CardHeader className="pb-2"><CardTitle className="text-sm">Occupancy by {GEO_LEVEL_LABEL[level].toLowerCase().replace(/s$/, '')}</CardTitle></CardHeader>
            <CardContent className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={filtered.slice(0, 12).map((r) => ({
                  name: r.label.length > 14 ? `${r.label.slice(0, 13)}…` : r.label,
                  Occupied: r.occupied_units, Vacant: r.vacant_units,
                }))}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="name" tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" interval={0} angle={-25} textAnchor="end" height={60} />
                  <YAxis tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" />
                  <Tooltip />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Bar dataKey="Occupied" stackId="a" fill="hsl(var(--primary))" />
                  <Bar dataKey="Vacant" stackId="a" fill="hsl(var(--muted-foreground) / 0.4)" />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="table" className="mt-4">
          <Card>
            <CardContent className="p-0 overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-muted/50">
                  <tr>
                    {['#', GEO_LEVEL_LABEL[level].replace(/s$/, ''), 'Tenants', 'Active', 'New', 'Billable today', 'Settled today', 'Not collected', 'Today %', 'Behind', '30d+ risk', 'Expected', 'Collected', 'Coll. %', 'Outstanding', 'Occupancy', 'Landlords', 'Agents'].map((h) => (
                      <th key={h} className="text-left px-3 py-2 font-semibold whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((r, i) => {
                    const d = deriveRatios(r);
                    return (
                      <tr key={r.key} className="border-t border-border hover:bg-muted/30 cursor-pointer" onClick={() => drill(r)}>
                        <td className="px-3 py-2 text-muted-foreground">{i + 1}</td>
                        <td className="px-3 py-2 font-medium whitespace-nowrap">{r.label}</td>
                        <td className="px-3 py-2">{r.tenants_total.toLocaleString()}</td>
                        <td className="px-3 py-2">{r.tenants_active.toLocaleString()}</td>
                        <td className="px-3 py-2">{r.tenants_new_month}</td>
                        <td className="px-3 py-2">{r.billable_today}</td>
                        <td className="px-3 py-2 text-emerald-600">{r.settled_today}</td>
                        <td className="px-3 py-2 text-destructive">{r.uncollected_today}</td>
                        <td className="px-3 py-2">{d.dailyCollectionRate.toFixed(0)}%</td>
                        <td className="px-3 py-2 text-destructive">{r.overdue_count}</td>
                        <td className="px-3 py-2 text-amber-600">{r.par_31_60 + r.par_60_plus}</td>
                        <td className="px-3 py-2 whitespace-nowrap">{formatUGX(r.expected_to_date)}</td>
                        <td className="px-3 py-2 whitespace-nowrap text-emerald-600">{formatUGX(r.collected_to_date)}</td>
                        <td className="px-3 py-2">{d.collectionRate.toFixed(1)}%</td>
                        <td className="px-3 py-2 whitespace-nowrap text-amber-600">{formatUGX(r.outstanding_total)}</td>
                        <td className="px-3 py-2">{d.occupancyRate.toFixed(0)}%</td>
                        <td className="px-3 py-2">{r.landlords_total}</td>
                        <td className="px-3 py-2">{r.agents_total}</td>
                      </tr>
                    );
                  })}
                  {filtered.length === 0 && <tr><td colSpan={18} className="px-3 py-8 text-center text-muted-foreground">Nothing to show.</td></tr>}
                </tbody>
              </table>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
