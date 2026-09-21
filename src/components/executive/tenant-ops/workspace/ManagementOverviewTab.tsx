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
import { Loader2 } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { TOPUP_TIER_LABELS } from '@/hooks/useTenantTopupEligibility';
import { useTenantOpsManagementOverview } from '@/hooks/useTenantOpsManagementOverview';

const CYCLE_LABELS: Record<string, string> = {
  in_cycle: 'Still inside the cycle',
  within_one_month: 'Up to a month past the cycle',
  within_two_months: 'One to two months past the cycle',
  beyond_two_months: 'Over two months past the cycle',
  completed: 'Fully paid',
};

type ArrearsFilter = 'all' | 'with' | 'without';
type PerfFilter = 'all' | 'above80' | 'below80' | 'below50';

export default function ManagementOverviewTab() {
  const [search, setSearch] = useState('');
  const [agentId, setAgentId] = useState<string>('all');
  const [tier, setTier] = useState<string>('all');
  const [cycle, setCycle] = useState<string>('all');
  const [arrears, setArrears] = useState<ArrearsFilter>('all');
  const [perf, setPerf] = useState<PerfFilter>('all');
  const [agentSearch, setAgentSearch] = useState('');
  const [regFilter, setRegFilter] = useState<'all' | 'blocked' | 'allowed'>('all');

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

  if (error) {
    return (
      <Card>
        <CardContent className="py-10 text-center text-sm text-muted-foreground">
          This overview is only available to management and operations users.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
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
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-4 md:grid-cols-4">
          {[
            { label: 'Tenants in view', value: isLoading ? '—' : `${visibleTenants.length} of ${totalTenants}` },
            { label: 'Agents in view', value: isLoading ? '—' : visibleAgents.length },
            {
              label: 'Outstanding in view',
              value: isLoading ? '—' : formatUGX(visibleTenants.reduce((s, t) => s + Number(t.outstanding ?? 0), 0)),
            },
            {
              label: 'Arrears in view',
              value: isLoading ? '—' : formatUGX(visibleTenants.reduce((s, t) => s + t.arrears, 0)),
            },
          ].map((t) => (
            <div key={t.label} className="rounded-xl border bg-muted/30 p-3">
              <div className="text-xl font-semibold">{t.value}</div>
              <div className="mt-1 text-xs text-muted-foreground">{t.label}</div>
            </div>
          ))}
        </CardContent>
      </Card>

      <Tabs defaultValue="tenants">
        <TabsList>
          <TabsTrigger value="tenants">Tenants</TabsTrigger>
          <TabsTrigger value="agents">Agents</TabsTrigger>
        </TabsList>

        <TabsContent value="tenants" className="mt-3">
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
            </CardHeader>
            <CardContent className="overflow-x-auto">
              {isLoading ? (
                <div className="flex items-center justify-center py-10 text-muted-foreground">
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading tenants…
                </div>
              ) : (
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
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {visibleTenants.map((t) => {
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
                        </TableRow>
                      );
                    })}
                    {visibleTenants.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={14} className="py-8 text-center text-sm text-muted-foreground">
                          No tenants match these filters.
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="agents" className="mt-3">
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
            <CardContent className="overflow-x-auto">
              {isLoading ? (
                <div className="flex items-center justify-center py-10 text-muted-foreground">
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading agents…
                </div>
              ) : (
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
                            {formatUGX(a.prev_month_collected)} of {formatUGX(a.prev_month_expected)}
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
                      </TableRow>
                    ))}
                    {visibleAgents.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={9} className="py-8 text-center text-sm text-muted-foreground">
                          No agents match these filters.
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
