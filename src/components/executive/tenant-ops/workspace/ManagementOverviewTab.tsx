import { useMemo, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import {
  Loader2,
  Filter,
  X,
  Users,
  UserCog,
  Wallet,
  AlertTriangle,
  ShieldAlert,
  SearchX,
  FileDown,
  FileSpreadsheet,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { formatUGX } from '@/lib/rentCalculations';
import { TOPUP_TIER_LABELS } from '@/hooks/useTenantTopupEligibility';
import { useTenantOpsManagementOverview } from '@/hooks/useTenantOpsManagementOverview';
import { useAuth } from '@/hooks/useAuth';
import {
  TenantQuickActions,
  AgentQuickActions,
} from '@/components/executive/tenant-ops/workspace/TenantOpsQuickActions';
import { KPICard } from '@/components/executive/KPICard';
import { WorkspaceEmptyState } from '@/components/executive/tenant-ops/workspace/WorkspaceEmptyState';
import { WorkspaceMobileRow } from '@/components/executive/tenant-ops/workspace/WorkspaceMobileRow';
import {
  generateManagementOverviewPdf,
  exportManagementOverviewXlsx,
} from '@/lib/tenantOpsManagementOverviewReport';

const CYCLE_LABELS: Record<string, string> = {
  in_cycle: 'Still inside the cycle',
  within_one_month: 'Up to a month past the cycle',
  within_two_months: 'One to two months past the cycle',
  beyond_two_months: 'Over two months past the cycle',
  completed: 'Fully paid',
};

/** Bar colour per eligibility tier — success/primary for the best standing,
 * warning/muted for the middle ground, destructive for not eligible. */
const TIER_COLORS: Record<string, string> = {
  within_cycle: 'hsl(var(--success))',
  within_one_month: 'hsl(var(--primary))',
  within_two_months: 'hsl(var(--warning))',
  beyond_two_months: 'hsl(var(--warning))',
  same_amount_only: 'hsl(var(--muted-foreground))',
  not_eligible: 'hsl(var(--destructive))',
};

type ArrearsFilter = 'all' | 'with' | 'without';
type PerfFilter = 'all' | 'above80' | 'below80' | 'below50';

export default function ManagementOverviewTab() {
  const { user } = useAuth() as any;
  const [search, setSearch] = useState('');
  const [agentId, setAgentId] = useState<string>('all');
  const [tier, setTier] = useState<string>('all');
  const [cycle, setCycle] = useState<string>('all');
  const [arrears, setArrears] = useState<ArrearsFilter>('all');
  const [perf, setPerf] = useState<PerfFilter>('all');
  const [agentSearch, setAgentSearch] = useState('');
  const [regFilter, setRegFilter] = useState<'all' | 'blocked' | 'allowed'>('all');
  const [shownTenants, setShownTenants] = useState(150);
  const [generatingPdf, setGeneratingPdf] = useState(false);
  const [generatingXlsx, setGeneratingXlsx] = useState(false);

  const {
    tenants,
    agents,
    rules,
    registrationRules,
    asOf,
    totalTenants,
    isLoading,
    error,
  } = useTenantOpsManagementOverview({
    search,
    agentId: agentId === 'all' ? null : agentId,
    tier: tier === 'all' ? null : tier,
  });

  const agentOptions = useMemo(
    () =>
      agents
        .filter((a) => a.agent_name)
        .sort((a, b) => (a.agent_name ?? '').localeCompare(b.agent_name ?? ''))
        .map((a) => ({ id: a.agent_id, name: a.agent_name as string })),
    [agents],
  );

  const visibleTenants = useMemo(
    () =>
      tenants.filter((t) => {
        if (cycle !== 'all' && t.cycle_status !== cycle) return false;
        if (arrears === 'with' && t.arrears <= 0) return false;
        if (arrears === 'without' && t.arrears > 0) return false;
        if (perf === 'above80' && (t.pct_covered ?? 0) < 80) return false;
        if (perf === 'below80' && (t.pct_covered ?? 0) >= 80) return false;
        if (perf === 'below50' && (t.pct_covered ?? 0) >= 50) return false;
        return true;
      }),
    [tenants, cycle, arrears, perf],
  );

  const visibleAgents = useMemo(
    () =>
      agents.filter((a) => {
        const q = agentSearch.trim().toLowerCase();
        if (q && !(a.agent_name ?? '').toLowerCase().includes(q)) return false;
        if (regFilter === 'blocked' && !a.blocked) return false;
        if (regFilter === 'allowed' && a.blocked) return false;
        if (perf === 'above80' && a.portfolio_pct < 80) return false;
        if (perf === 'below80' && a.portfolio_pct >= 80) return false;
        if (perf === 'below50' && a.portfolio_pct >= 50) return false;
        if (arrears === 'with' && a.total_arrears <= 0) return false;
        if (arrears === 'without' && a.total_arrears > 0) return false;
        return true;
      }),
    [agents, agentSearch, regFilter, perf, arrears],
  );

  // Tenant-eligibility-tier chart — counts the full in-view tenant array
  // (not just the 150 rows rendered in the table), grouped by the same
  // `tier_key` classification the table already shows.
  const tierChartData = useMemo(
    () =>
      Object.entries(TOPUP_TIER_LABELS).map(([key, label]) => ({
        name: label.length > 22 ? `${label.slice(0, 21)}…` : label,
        count: visibleTenants.filter((t) => t.tier_key === key).length,
        color: TIER_COLORS[key] ?? 'hsl(var(--muted-foreground))',
      })),
    [visibleTenants],
  );

  // Agent-performance-band chart — counts the full in-view agent array by
  // portfolio %, the same headline figure already shown in the agents table.
  const performanceChartData = useMemo(() => {
    const bands = [
      { name: '80% and above', color: 'hsl(var(--success))', test: (p: number) => p >= 80 },
      { name: '50% – 79%', color: 'hsl(var(--warning))', test: (p: number) => p >= 50 && p < 80 },
      { name: 'Below 50%', color: 'hsl(var(--destructive))', test: (p: number) => p < 50 },
    ];
    return bands.map((b) => ({
      name: b.name,
      count: visibleAgents.filter((a) => b.test(a.portfolio_pct)).length,
      color: b.color,
    }));
  }, [visibleAgents]);

  // ---- Active-filters strip (Tenants sub-tab) ----
  type ActiveFilter = { key: string; label: string; value: string; onClear: () => void };
  const activeFilters = useMemo<ActiveFilter[]>(() => {
    const list: ActiveFilter[] = [];
    if (search.trim()) {
      list.push({ key: 'search', label: 'Search', value: search.trim(), onClear: () => setSearch('') });
    }
    if (agentId !== 'all') {
      const name = agentOptions.find((a) => a.id === agentId)?.name ?? agentId;
      list.push({ key: 'agent', label: 'Agent', value: name, onClear: () => setAgentId('all') });
    }
    if (tier !== 'all') {
      list.push({
        key: 'tier',
        label: 'Eligibility',
        value: TOPUP_TIER_LABELS[tier] ?? tier,
        onClear: () => setTier('all'),
      });
    }
    if (cycle !== 'all') {
      list.push({
        key: 'cycle',
        label: 'Cycle',
        value: CYCLE_LABELS[cycle] ?? cycle,
        onClear: () => setCycle('all'),
      });
    }
    if (arrears !== 'all') {
      list.push({
        key: 'arrears',
        label: 'Arrears',
        value: arrears === 'with' ? 'In arrears' : 'No arrears',
        onClear: () => setArrears('all'),
      });
    }
    if (perf !== 'all') {
      list.push({
        key: 'perf',
        label: 'Paid',
        value: perf === 'above80' ? '80% and above' : perf === 'below80' ? 'Below 80%' : 'Below 50%',
        onClear: () => setPerf('all'),
      });
    }
    return list;
  }, [search, agentId, tier, cycle, arrears, perf, agentOptions]);

  const clearAllTenantFilters = () => {
    setSearch('');
    setAgentId('all');
    setTier('all');
    setCycle('all');
    setArrears('all');
    setPerf('all');
  };

  // ---- Reporting (combined, whole-book — uses the FULL arrays regardless
  // of which sub-tab is active or what's currently filtered on screen) ----
  const handleGeneratePdf = async () => {
    setGeneratingPdf(true);
    const toastId = toast.loading('Generating the management overview PDF — this can take a moment for a large book…');
    try {
      await generateManagementOverviewPdf(tenants, agents, { generatedByUserId: user?.id });
      toast.success('Management overview PDF ready.', { id: toastId });
    } catch (err) {
      console.error('[ManagementOverviewTab] PDF export failed', err);
      toast.error('Could not generate the PDF. Please try again.', { id: toastId });
    } finally {
      setGeneratingPdf(false);
    }
  };

  const handleExportXlsx = async () => {
    setGeneratingXlsx(true);
    const toastId = toast.loading('Building the Excel workbook — this can take a moment for a large book…');
    try {
      await exportManagementOverviewXlsx(tenants, agents);
      toast.success('Management overview Excel file ready.', { id: toastId });
    } catch (err) {
      console.error('[ManagementOverviewTab] Excel export failed', err);
      toast.error('Could not build the Excel file. Please try again.', { id: toastId });
    } finally {
      setGeneratingXlsx(false);
    }
  };

  if (error) {
    return (
      <Card>
        <CardContent className="py-10">
          <WorkspaceEmptyState
            icon={ShieldAlert}
            title="Not available"
            hint="This overview is only available to management and operations users."
            tone="destructive"
          />
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle className="text-base">Management overview</CardTitle>
              <CardDescription>
                One view of tenants and agents, using the same figures as the top-up eligibility and
                registration control reports.
                {rules
                  ? ` Qualifying level ${rules.qualifying_pct}% paid, same-amount level ${rules.same_amount_pct}%.`
                  : ''}
                {registrationRules
                  ? ` Registration needs ${registrationRules.required_prev_month_pct}% last month once an agent carries ${registrationRules.min_active_tenants}+ tenants.`
                  : ''}
                {asOf ? ` As at ${new Date(asOf).toLocaleString()}.` : ''}
              </CardDescription>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => void handleGeneratePdf()}
                disabled={isLoading || generatingPdf}
                className="gap-1.5"
              >
                {generatingPdf ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileDown className="h-4 w-4" />}
                Professional PDF
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void handleExportXlsx()}
                disabled={isLoading || generatingXlsx}
                className="gap-1.5"
              >
                {generatingXlsx ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileSpreadsheet className="h-4 w-4" />}
                Export Excel
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <KPICard
            title="Tenants in view"
            value={isLoading ? '—' : `${visibleTenants.length} of ${totalTenants}`}
            icon={Users}
            color="bg-primary/10 text-primary"
            loading={isLoading}
          />
          <KPICard
            title="Agents in view"
            value={isLoading ? '—' : visibleAgents.length}
            icon={UserCog}
            color="bg-primary/10 text-primary"
            loading={isLoading}
          />
          <KPICard
            title="Outstanding in view"
            value={isLoading ? '—' : formatUGX(visibleTenants.reduce((s, t) => s + Number(t.outstanding ?? 0), 0))}
            icon={Wallet}
            color="bg-warning/10 text-warning"
            loading={isLoading}
          />
          <KPICard
            title="Arrears in view"
            value={isLoading ? '—' : formatUGX(visibleTenants.reduce((s, t) => s + t.arrears, 0))}
            icon={AlertTriangle}
            color="bg-destructive/10 text-destructive"
            loading={isLoading}
          />
        </CardContent>
      </Card>

      <Tabs defaultValue="tenants">
        <TabsList>
          <TabsTrigger value="tenants">Tenants</TabsTrigger>
          <TabsTrigger value="agents">Agents</TabsTrigger>
        </TabsList>

        <TabsContent value="tenants" className="mt-3 space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Tenants by eligibility tier</CardTitle>
              <CardDescription>
                Every tenant currently in view, grouped by the same top-up eligibility tier shown in the
                table below.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <div className="flex h-64 items-center justify-center text-muted-foreground">
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading…
                </div>
              ) : (
                <div className="h-64 w-full sm:h-72">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={tierChartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" className="stroke-border/50" vertical={false} />
                      <XAxis dataKey="name" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
                      <YAxis tick={{ fontSize: 10 }} width={44} allowDecimals={false} />
                      <Tooltip
                        contentStyle={{
                          backgroundColor: 'hsl(var(--card))',
                          border: '1px solid hsl(var(--border))',
                          borderRadius: '8px',
                          fontSize: '12px',
                        }}
                      />
                      <Bar dataKey="count" radius={[3, 3, 0, 0]}>
                        {tierChartData.map((d) => (
                          <Cell key={d.name} fill={d.color} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Tenant position</CardTitle>
              <CardDescription>
                Rent, dues, payments, arrears, cycle position and what each tenant can access now.
              </CardDescription>
              <div className="mt-3 grid gap-2 md:grid-cols-3 lg:grid-cols-5">
                <Input
                  placeholder="Search tenant name or phone"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                <Select value={agentId} onValueChange={setAgentId}>
                  <SelectTrigger><SelectValue placeholder="Agent" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All agents</SelectItem>
                    {agentOptions.map((a) => (
                      <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select value={tier} onValueChange={setTier}>
                  <SelectTrigger><SelectValue placeholder="Eligibility" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All eligibility levels</SelectItem>
                    {Object.entries(TOPUP_TIER_LABELS).map(([k, label]) => (
                      <SelectItem key={k} value={k}>{label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select value={cycle} onValueChange={setCycle}>
                  <SelectTrigger><SelectValue placeholder="Payment cycle" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Any cycle position</SelectItem>
                    {Object.entries(CYCLE_LABELS).map(([k, label]) => (
                      <SelectItem key={k} value={k}>{label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <div className="grid grid-cols-2 gap-2">
                  <Select value={arrears} onValueChange={(v) => setArrears(v as ArrearsFilter)}>
                    <SelectTrigger><SelectValue placeholder="Arrears" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">Any arrears</SelectItem>
                      <SelectItem value="with">In arrears</SelectItem>
                      <SelectItem value="without">No arrears</SelectItem>
                    </SelectContent>
                  </Select>
                  <Select value={perf} onValueChange={(v) => setPerf(v as PerfFilter)}>
                    <SelectTrigger><SelectValue placeholder="Paid" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">Any level paid</SelectItem>
                      <SelectItem value="above80">80% and above</SelectItem>
                      <SelectItem value="below80">Below 80%</SelectItem>
                      <SelectItem value="below50">Below 50%</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              {activeFilters.length > 0 && (
                <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg bg-muted/60 px-2 py-1.5">
                  <Filter className="h-3 w-3 text-primary" />
                  <span className="text-[11px] font-semibold">
                    {activeFilters.length} filter{activeFilters.length === 1 ? '' : 's'} active
                  </span>
                  <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
                    {visibleTenants.length.toLocaleString()} tenants
                  </Badge>
                  {activeFilters.map((f) => (
                    <Badge
                      key={f.key}
                      variant="outline"
                      className="max-w-full gap-1 whitespace-normal break-words px-1.5 py-0 text-left text-[10px]"
                    >
                      {f.label}: {f.value}
                      <button type="button" onClick={f.onClear} aria-label={`Clear ${f.label}`}>
                        <X className="h-2.5 w-2.5" />
                      </button>
                    </Badge>
                  ))}
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 px-2 text-[11px] sm:ml-auto"
                    onClick={clearAllTenantFilters}
                  >
                    Clear all
                  </Button>
                </div>
              )}
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <div className="flex items-center justify-center py-10 text-muted-foreground">
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading tenants…
                </div>
              ) : (
                <>
                  <div className="hidden lg:block overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Tenant</TableHead>
                          <TableHead>Agent</TableHead>
                          <TableHead className="text-right">Initial rent</TableHead>
                          <TableHead className="text-right">Current rent</TableHead>
                          <TableHead className="text-right">Expected</TableHead>
                          <TableHead className="text-right">Paid</TableHead>
                          <TableHead className="text-right">Remaining</TableHead>
                          <TableHead className="text-right">Paid %</TableHead>
                          <TableHead className="text-right">Left %</TableHead>
                          <TableHead className="text-right">Arrears</TableHead>
                          <TableHead>Cycle</TableHead>
                          <TableHead>Eligibility</TableHead>
                          <TableHead className="text-right">Can access</TableHead>
                          <TableHead className="text-right">Needed for next level</TableHead>
                          <TableHead className="text-right">Actions</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {visibleTenants.slice(0, shownTenants).map((t) => {
                          const nextLevel = t.levels?.find((l) => !l.reached && l.amount_required > 0);
                          return (
                            <TableRow key={t.rent_request_id}>
                              <TableCell>
                                <div className="font-medium">{t.tenant_name ?? 'Unnamed tenant'}</div>
                                <div className="text-xs text-muted-foreground">{t.tenant_phone ?? '—'}</div>
                              </TableCell>
                              <TableCell className="text-sm">{t.agent_name ?? '—'}</TableCell>
                              <TableCell className="text-right">
                                {t.initial_rent == null ? '—' : formatUGX(t.initial_rent)}
                              </TableCell>
                              <TableCell className="text-right">{formatUGX(Number(t.rent_amount))}</TableCell>
                              <TableCell className="text-right">{formatUGX(Number(t.total_amount))}</TableCell>
                              <TableCell className="text-right">{formatUGX(Number(t.amount_repaid))}</TableCell>
                              <TableCell className="text-right">{formatUGX(Number(t.outstanding))}</TableCell>
                              <TableCell className="text-right">{Math.round(t.pct_covered ?? 0)}%</TableCell>
                              <TableCell className="text-right">{Math.round(t.pct_remaining)}%</TableCell>
                              <TableCell className="text-right">
                                {t.arrears > 0 ? (
                                  <span className="font-medium text-destructive">{formatUGX(t.arrears)}</span>
                                ) : (
                                  '—'
                                )}
                              </TableCell>
                              <TableCell className="text-xs">
                                {CYCLE_LABELS[t.cycle_status]}
                                {t.cycle_status === 'in_cycle' && t.days_left_in_cycle > 0 && (
                                  <div className="text-muted-foreground">{t.days_left_in_cycle} days left</div>
                                )}
                              </TableCell>
                              <TableCell className="text-xs">
                                <Badge variant={t.eligible ? 'secondary' : 'outline'}>
                                  {TOPUP_TIER_LABELS[t.tier_key] ?? t.tier_key}
                                </Badge>
                              </TableCell>
                              <TableCell className="text-right">
                                {formatUGX(Number(t.max_accessible_rent ?? 0))}
                              </TableCell>
                              <TableCell className="text-right text-xs">
                                {nextLevel ? (
                                  <>
                                    <div>{formatUGX(nextLevel.amount_required)}</div>
                                    <div className="text-muted-foreground">
                                      for up to {formatUGX(nextLevel.max_accessible_rent)}
                                    </div>
                                  </>
                                ) : (
                                  '—'
                                )}
                              </TableCell>
                              <TableCell className="text-right">
                                <TenantQuickActions tenant={t} agentOptions={agentOptions} />
                              </TableCell>
                            </TableRow>
                          );
                        })}
                        {visibleTenants.length === 0 && (
                          <TableRow>
                            <TableCell colSpan={15} className="py-8 text-center text-sm text-muted-foreground">
                              No tenants match these filters.
                            </TableCell>
                          </TableRow>
                        )}
                      </TableBody>
                    </Table>
                  </div>

                  <div className="space-y-2 lg:hidden">
                    {visibleTenants.slice(0, shownTenants).map((t) => (
                      <WorkspaceMobileRow
                        key={t.rent_request_id}
                        title={t.tenant_name ?? 'Unnamed tenant'}
                        badge={
                          <Badge variant={t.eligible ? 'secondary' : 'outline'} className="text-[10px]">
                            {TOPUP_TIER_LABELS[t.tier_key] ?? t.tier_key}
                          </Badge>
                        }
                        fields={[
                          { label: 'Agent', value: t.agent_name ?? '—' },
                          { label: 'Current rent', value: formatUGX(Number(t.rent_amount)) },
                          { label: 'Paid %', value: `${Math.round(t.pct_covered ?? 0)}%` },
                          {
                            label: 'Arrears',
                            value: t.arrears > 0 ? (
                              <span className="font-medium text-destructive">{formatUGX(t.arrears)}</span>
                            ) : '—',
                          },
                        ]}
                        actions={<TenantQuickActions tenant={t} agentOptions={agentOptions} />}
                      />
                    ))}
                    {visibleTenants.length === 0 && (
                      <WorkspaceEmptyState
                        icon={SearchX}
                        title="No tenants match these filters"
                        hint="Try clearing a filter or broadening the search."
                        tone="muted"
                      />
                    )}
                  </div>
                </>
              )}
              {!isLoading && visibleTenants.length > 0 && (
                <div className="mt-3 flex items-center justify-between gap-3 text-xs text-muted-foreground">
                  <span>
                    Showing {Math.min(shownTenants, visibleTenants.length)} of {visibleTenants.length} tenants
                  </span>
                  {shownTenants < visibleTenants.length && (
                    <Button variant="outline" size="sm" onClick={() => setShownTenants((n) => n + 150)}>
                      Show more
                    </Button>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="agents" className="mt-3 space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Agents by performance band</CardTitle>
              <CardDescription>
                Every agent currently in view, grouped by portfolio % — the same headline figure shown in
                the table below.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <div className="flex h-64 items-center justify-center text-muted-foreground">
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading…
                </div>
              ) : (
                <div className="h-64 w-full sm:h-72">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={performanceChartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" className="stroke-border/50" vertical={false} />
                      <XAxis dataKey="name" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
                      <YAxis tick={{ fontSize: 10 }} width={44} allowDecimals={false} />
                      <Tooltip
                        contentStyle={{
                          backgroundColor: 'hsl(var(--card))',
                          border: '1px solid hsl(var(--border))',
                          borderRadius: '8px',
                          fontSize: '12px',
                        }}
                      />
                      <Bar dataKey="count" radius={[3, 3, 0, 0]}>
                        {performanceChartData.map((d) => (
                          <Cell key={d.name} fill={d.color} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Agent portfolios</CardTitle>
              <CardDescription>
                Totals built from each agent's own tenants above, with last month's performance and
                registration standing.
              </CardDescription>
              <div className="mt-3 grid gap-2 md:grid-cols-3">
                <Input
                  placeholder="Search agent name"
                  value={agentSearch}
                  onChange={(e) => setAgentSearch(e.target.value)}
                />
                <Select value={regFilter} onValueChange={(v) => setRegFilter(v as typeof regFilter)}>
                  <SelectTrigger><SelectValue placeholder="Registration" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All agents</SelectItem>
                    <SelectItem value="blocked">Cannot register</SelectItem>
                    <SelectItem value="allowed">Can register</SelectItem>
                  </SelectContent>
                </Select>
                <Select value={perf} onValueChange={(v) => setPerf(v as PerfFilter)}>
                  <SelectTrigger><SelectValue placeholder="Performance" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Any performance</SelectItem>
                    <SelectItem value="above80">80% and above</SelectItem>
                    <SelectItem value="below80">Below 80%</SelectItem>
                    <SelectItem value="below50">Below 50%</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <div className="flex items-center justify-center py-10 text-muted-foreground">
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading agents…
                </div>
              ) : (
                <>
                  <div className="hidden lg:block overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Agent</TableHead>
                          <TableHead className="text-right">Active tenants</TableHead>
                          <TableHead className="text-right">Total expected</TableHead>
                          <TableHead className="text-right">Total collected</TableHead>
                          <TableHead className="text-right">Portfolio</TableHead>
                          <TableHead className="text-right">Average tenant</TableHead>
                          <TableHead className="text-right">Arrears</TableHead>
                          <TableHead className="text-right">Last month</TableHead>
                          <TableHead>New registrations</TableHead>
                          <TableHead className="text-right">Actions</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {visibleAgents.map((a) => (
                          <TableRow key={a.agent_id}>
                            <TableCell className="font-medium">{a.agent_name ?? a.agent_id}</TableCell>
                            <TableCell className="text-right">{a.active_tenants}</TableCell>
                            <TableCell className="text-right">{formatUGX(a.total_expected)}</TableCell>
                            <TableCell className="text-right">{formatUGX(a.total_collected)}</TableCell>
                            <TableCell className="text-right">{a.portfolio_pct}%</TableCell>
                            <TableCell className="text-right">{a.avg_pct_covered}%</TableCell>
                            <TableCell className="text-right">
                              {a.total_arrears > 0 ? formatUGX(a.total_arrears) : '—'}
                            </TableCell>
                            <TableCell className="text-right">
                              {a.prev_month_pct == null ? '—' : `${a.prev_month_pct}%`}
                              <div className="text-xs text-muted-foreground">
                                {a.prev_month_expected > 0
                                  ? `${formatUGX(a.prev_month_collected)} of ${formatUGX(a.prev_month_expected)}`
                                  : 'Nothing was due last month'}
                              </div>
                            </TableCell>
                            <TableCell>
                              {a.blocked ? (
                                <Badge variant="destructive">Cannot register</Badge>
                              ) : a.override_active ? (
                                <Badge variant="secondary">Allowed by override</Badge>
                              ) : a.restricted ? (
                                <Badge variant="outline">Watch — below required level</Badge>
                              ) : (
                                <Badge variant="outline">Can register</Badge>
                              )}
                            </TableCell>
                            <TableCell className="text-right">
                              <AgentQuickActions agentId={a.agent_id} agentName={a.agent_name} />
                            </TableCell>
                          </TableRow>
                        ))}
                        {visibleAgents.length === 0 && (
                          <TableRow>
                            <TableCell colSpan={10} className="py-8 text-center text-sm text-muted-foreground">
                              No agents match these filters.
                            </TableCell>
                          </TableRow>
                        )}
                      </TableBody>
                    </Table>
                  </div>

                  <div className="space-y-2 lg:hidden">
                    {visibleAgents.map((a) => (
                      <WorkspaceMobileRow
                        key={a.agent_id}
                        title={a.agent_name ?? a.agent_id}
                        badge={
                          a.blocked ? (
                            <Badge variant="destructive" className="text-[10px]">Cannot register</Badge>
                          ) : a.override_active ? (
                            <Badge variant="secondary" className="text-[10px]">Override</Badge>
                          ) : a.restricted ? (
                            <Badge variant="outline" className="text-[10px]">Watch</Badge>
                          ) : (
                            <Badge variant="outline" className="text-[10px]">Can register</Badge>
                          )
                        }
                        fields={[
                          { label: 'Active tenants', value: a.active_tenants },
                          { label: 'Portfolio %', value: `${a.portfolio_pct}%` },
                          {
                            label: 'Arrears',
                            value: a.total_arrears > 0 ? formatUGX(a.total_arrears) : '—',
                          },
                          {
                            label: 'Last month (performance)',
                            value: a.prev_month_pct == null ? '—' : `${a.prev_month_pct}%`,
                          },
                        ]}
                        actions={<AgentQuickActions agentId={a.agent_id} agentName={a.agent_name} />}
                      />
                    ))}
                    {visibleAgents.length === 0 && (
                      <WorkspaceEmptyState
                        icon={SearchX}
                        title="No agents match these filters"
                        hint="Try clearing a filter or broadening the search."
                        tone="muted"
                      />
                    )}
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
