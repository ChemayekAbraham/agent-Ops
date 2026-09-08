import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { addDays, format, startOfDay, subDays } from 'date-fns';
import {
  AlertTriangle,
  CalendarDays,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleDot,
  Loader2,
  Phone,
  Search,
  Users,
} from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/rentCalculations';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { UserDrilldownDrawer } from '@/components/ops/UserDrilldownDrawer';
import { AgentPaymentPosition } from './AgentPaymentPosition';

interface ActiveRentRequest {
  id: string;
  tenant_id: string;
  agent_id: string | null;
  landlord_id: string | null;
  daily_repayment: number | null;
  total_repayment: number | null;
  amount_repaid: number | null;
  status: string;
  created_at: string;
  house_category: string | null;
  landlord_name?: string | null;
  property_address?: string | null;
  repayment_frequency: string | null;
  repayment_starts_on: string | null;
}

interface Profile {
  id: string;
  full_name: string | null;
  phone: string | null;
  created_at: string | null;
}

interface Collection {
  id: string;
  agent_id: string;
  tenant_id: string;
  amount: number | null;
  created_at: string;
}

interface AgentRow {
  id: string;
  name: string;
  phone: string | null;
  tenantCount: number;
  expected: number;
  collected: number;
  requestCount: number;
  tenants: ActiveRentRequest[];
}

const PAGE_SIZE = 1000;

const getErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : 'Unable to load agent monitoring data.';

async function fetchAll<T>(query: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>) {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const result = await query(from, from + PAGE_SIZE - 1);
    if (result.error) throw new Error(result.error.message);
    const page = result.data ?? [];
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
  }
}

function dayBounds(day: Date) {
  const date = format(day, 'yyyy-MM-dd');
  const from = new Date(`${date}T00:00:00+03:00`);
  const to = new Date(`${format(addDays(day, 1), 'yyyy-MM-dd')}T00:00:00+03:00`);
  return { from: from.toISOString(), to: to.toISOString() };
}

function collectionStatus(expected: number, collected: number) {
  if (expected > 0 && collected >= expected) return 'full' as const;
  if (collected > 0) return 'partial' as const;
  return 'critical' as const;
}

type CollectionStatus = ReturnType<typeof collectionStatus>;

function StatusIndicator({ status }: { status: CollectionStatus }) {
  if (status === 'full') {
    return (
      <Badge className="gap-1 bg-success text-success-foreground hover:bg-success/90">
        <CircleCheck className="h-3 w-3" /> Full
      </Badge>
    );
  }
  if (status === 'partial') {
    return (
      <Badge className="gap-1 bg-warning text-warning-foreground hover:bg-warning/90">
        <CircleDot className="h-3 w-3" /> Partial
      </Badge>
    );
  }
  return (
    <Badge variant="destructive" className="gap-1">
      <CircleAlert className="h-3 w-3" /> Critical
    </Badge>
  );
}

function formatStatus(status: string) {
  return status.replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

type AgentMonitoringTab = 'all' | 'after-aug-2026' | 'position';

export function AgentMonitoring() {
  const [tab, setTab] = useState<AgentMonitoringTab>('all');
  const [day, setDay] = useState(() => startOfDay(new Date()));
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | CollectionStatus>('all');
  const [selectedAgent, setSelectedAgent] = useState<AgentRow | null>(null);
  const [selectedTenant, setSelectedTenant] = useState<string | null>(null);
  const bounds = useMemo(() => dayBounds(day), [day]);
  const createdAfter = tab === 'after-aug-2026' ? '2026-08-02T00:00:00+03:00' : undefined;

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['tenant-ops-agent-monitoring', format(day, 'yyyy-MM-dd')],
    queryFn: async () => {
      const eligibility = await fetchAll<{ rent_request_id: string }>((from, to) =>
        supabase.from('v_tenant_daily_eligibility').select('rent_request_id').range(from, to),
      );
      const eligibleIds = new Set(eligibility.map((row) => row.rent_request_id));
      if (eligibleIds.size === 0) return { requests: [], collections: [], profiles: [] as Profile[], requestCounts: new Map<string, number>() };

      const requests = await fetchAll<ActiveRentRequest>((from, to) =>
        supabase
          .from('rent_requests')
          .select('id, tenant_id, agent_id, landlord_id, daily_repayment, total_repayment, amount_repaid, status, created_at, house_category')
          .in('status', ['funded', 'disbursed', 'repaying'])
          .range(from, to),
      );
      const activeRequests = requests.filter((request) => eligibleIds.has(request.id) && request.agent_id);
      const { data: collections, error: collectionsError } = await supabase
        .from('agent_collections')
        .select('id, agent_id, tenant_id, amount, created_at')
        .gte('created_at', bounds.from)
        .lt('created_at', bounds.to)
        .not('agent_id', 'is', null);
      if (collectionsError) throw collectionsError;

      const agentIds = new Set<string>(activeRequests.map((request) => request.agent_id).filter((id): id is string => Boolean(id)));
      const requestCounts = new Map<string, number>();
      const allRequests = await fetchAll<{ agent_id: string | null }>((from, to) =>
        supabase.from('rent_requests').select('agent_id').not('agent_id', 'is', null).range(from, to),
      );
      allRequests.forEach((request) => {
        if (request.agent_id) requestCounts.set(request.agent_id, (requestCounts.get(request.agent_id) ?? 0) + 1);
      });
      (collections ?? []).forEach((collection) => agentIds.add(collection.agent_id));

      const ids = Array.from(new Set([
        ...Array.from(agentIds),
        ...activeRequests.map((request) => request.tenant_id),
      ]));
      const profiles: Profile[] = [];
      const CHUNK = 300;
      for (let index = 0; index < ids.length; index += CHUNK) {
        const { data: batch, error: profileError } = await supabase
          .from('profiles')
          .select('id, full_name, phone, created_at')
          .in('id', ids.slice(index, index + CHUNK));
        if (profileError) throw profileError;
        profiles.push(...((batch ?? []) as Profile[]));
      }

      return { requests: activeRequests, collections: (collections ?? []) as Collection[], profiles, requestCounts };
    },
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });

  const profileMap = useMemo(() => new Map((data?.profiles ?? []).map((profile) => [profile.id, profile])), [data?.profiles]);
  const collectionMap = useMemo(() => {
    const totals = new Map<string, number>();
    (data?.collections ?? []).forEach((collection) => {
      const key = `${collection.agent_id}:${collection.tenant_id}`;
      totals.set(key, (totals.get(key) ?? 0) + Number(collection.amount ?? 0));
    });
    return totals;
  }, [data?.collections]);

  const agents = useMemo<AgentRow[]>(() => {
    const grouped = new Map<string, ActiveRentRequest[]>();
    (data?.requests ?? []).forEach((request) => {
      if (!request.agent_id) return;
      const rows = grouped.get(request.agent_id) ?? [];
      rows.push(request);
      grouped.set(request.agent_id, rows);
    });
    (data?.collections ?? []).forEach((collection) => {
      if (!grouped.has(collection.agent_id)) grouped.set(collection.agent_id, []);
    });

    return Array.from(grouped.entries())
      .map(([agentId, tenants]) => {
        const expected = tenants.reduce((sum, request) => sum + Number(request.daily_repayment ?? 0), 0);
        const collected = tenants.reduce(
          (sum, request) => sum + (collectionMap.get(`${agentId}:${request.tenant_id}`) ?? 0),
          0,
        );
        const profile = profileMap.get(agentId);
        return {
          id: agentId,
          name: profile?.full_name || 'Unnamed agent',
          phone: profile?.phone ?? null,
          tenantCount: new Set(tenants.map((request) => request.tenant_id)).size,
          expected,
          collected,
          requestCount: data?.requestCounts.get(agentId) ?? 0,
          tenants,
        };
      })
      .filter((agent) => {
        if (!createdAfter) return true;
        const profile = profileMap.get(agent.id);
        return !!profile?.created_at && new Date(profile.created_at) >= new Date(createdAfter);
      })
      .sort((a, b) => b.expected - a.expected || a.name.localeCompare(b.name));
  }, [collectionMap, createdAfter, data?.collections, data?.requests, data?.requestCounts, profileMap]);

  const filteredAgents = useMemo(() => {
    const query = search.trim().toLowerCase();
    return agents.filter((agent) => {
      const matchesSearch = !query || `${agent.name} ${agent.phone ?? ''}`.toLowerCase().includes(query);
      const status = collectionStatus(agent.expected, agent.collected);
      return matchesSearch && (statusFilter === 'all' || statusFilter === status);
    });
  }, [agents, search, statusFilter]);

  const totals = useMemo(() => filteredAgents.reduce(
    (sum, agent) => ({ expected: sum.expected + agent.expected, collected: sum.collected + agent.collected }),
    { expected: 0, collected: 0 },
  ), [filteredAgents]);

  const selectedAgentRows = useMemo(() => {
    if (!selectedAgent) return [];
    return selectedAgent.tenants.map((request) => ({
      request,
      tenant: profileMap.get(request.tenant_id),
      collected: collectionMap.get(`${selectedAgent.id}:${request.tenant_id}`) ?? 0,
    }));
  }, [collectionMap, profileMap, selectedAgent]);

  const renderAgentRow = (agent: AgentRow, compact = false) => {
    const rate = agent.expected > 0 ? Math.min(100, (agent.collected / agent.expected) * 100) : null;
    const callHref = agent.phone ? `tel:${agent.phone.replace(/[^\d+]/g, '')}` : null;

    if (compact) {
      return (
        <div key={agent.id} className="rounded-lg border p-3">
          <button
            type="button"
            className="flex w-full items-start justify-between gap-3 text-left"
            onClick={() => setSelectedAgent(agent)}
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold">{agent.name}</p>
              <p className="truncate text-xs text-muted-foreground">{agent.phone || 'No phone number'} · {agent.tenantCount} tenants</p>
              <p className="mt-1 break-words text-xs tabular-nums text-muted-foreground">
                {formatUGX(agent.collected)} / {formatUGX(agent.expected)} · {rate === null ? '—' : `${rate.toFixed(1)}%`}
              </p>
            </div>
            <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" />
          </button>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <StatusIndicator status={collectionStatus(agent.expected, agent.collected)} />
            {callHref && (
              <Button asChild size="sm" variant="outline" className="h-8 gap-1.5 text-xs">
                <a href={callHref}><Phone className="h-3.5 w-3.5" /> Call</a>
              </Button>
            )}
          </div>
        </div>
      );
    }

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
        <TableCell className="text-right tabular-nums">{formatUGX(agent.collected)}</TableCell>
        <TableCell className="text-right tabular-nums font-semibold">
          {rate === null ? '—' : `${rate.toFixed(1)}%`}
        </TableCell>
        <TableCell className="text-right tabular-nums">{agent.requestCount}</TableCell>
        <TableCell><StatusIndicator status={collectionStatus(agent.expected, agent.collected)} /></TableCell>
        <TableCell className="text-right">
          <div className="flex items-center justify-end gap-1">
            {callHref && (
              <Button
                asChild
                size="icon"
                variant="ghost"
                className="h-8 w-8"
                aria-label={`Call ${agent.name}`}
                onClick={(event) => event.stopPropagation()}
              >
                <a href={callHref}><Phone className="h-4 w-4" /></a>
              </Button>
            )}
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          </div>
        </TableCell>
      </TableRow>
    );
  };


  const body = (
    <>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10">
              <Users className="h-4.5 w-4.5 text-primary" />
            </div>
            <div>
              <h1 className="text-lg font-bold leading-tight">Agent Monitoring</h1>
              <p className="text-[11px] text-muted-foreground">Daily expected collections and field performance</p>
            </div>
          </div>
        </div>
        <div className="flex w-full flex-wrap items-center gap-1 rounded-lg border p-1 sm:w-auto">
          <Button variant="ghost" size="sm" onClick={() => setDay((value) => subDays(value, 1))} aria-label="Previous day">←</Button>
          <div className="flex-1 min-w-[110px] text-center text-xs font-medium tabular-nums sm:flex-none sm:min-w-[128px]">{format(day, 'dd MMM yyyy')}</div>
          <Button variant="ghost" size="sm" onClick={() => setDay((value) => addDays(value, 1))} aria-label="Next day">→</Button>
          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setDay(startOfDay(new Date()))}>
            <CalendarDays className="h-3.5 w-3.5" /> Today
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Card><CardContent className="p-3.5"><p className="text-xs text-muted-foreground">Agents monitored</p><p className="mt-1 text-xl font-bold tabular-nums">{filteredAgents.length}</p></CardContent></Card>
        <Card><CardContent className="p-3.5"><p className="text-xs text-muted-foreground">Daily expected</p><p className="mt-1 text-xl font-bold tabular-nums">{formatUGX(totals.expected)}</p></CardContent></Card>
        <Card><CardContent className="p-3.5"><p className="text-xs text-muted-foreground">Collected so far</p><p className="mt-1 text-xl font-bold tabular-nums">{formatUGX(totals.collected)}</p></CardContent></Card>
      </div>

      <Card>
        <CardHeader className="flex flex-col gap-3 pb-3 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle className="text-base">Collection performance</CardTitle>
          <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
              <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search agent or phone" className="h-8 w-full pl-8 text-xs sm:w-56" />
            </div>
            <div className="flex flex-wrap gap-1" role="group" aria-label="Collection status filter">
              {(['all', 'full', 'partial', 'critical'] as const).map((value) => (
                <Button key={value} variant={statusFilter === value ? 'secondary' : 'ghost'} size="sm" className="h-8 px-2 text-xs capitalize" onClick={() => setStatusFilter(value)}>
                  {value}
                </Button>
              ))}
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="flex items-center justify-center gap-2 p-10 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading agent collections…</div>
          ) : isError ? (
            <div className="flex flex-col items-center gap-3 p-10 text-center"><AlertTriangle className="h-5 w-5 text-destructive" /><p className="text-sm text-muted-foreground">{getErrorMessage(error)}</p><Button variant="outline" size="sm" onClick={() => void refetch()}>Try again</Button></div>
          ) : filteredAgents.length === 0 ? (
            <div className="flex flex-col items-center gap-2 p-10 text-center"><CircleAlert className="h-5 w-5 text-muted-foreground" /><p className="text-sm font-medium">No agents match this view</p><p className="text-xs text-muted-foreground">Try clearing the search or status filter.</p></div>
          ) : (
            <>
              <div className="hidden overflow-x-auto md:block">
                <Table>
                  <TableHeader><TableRow><TableHead>Agent name / phone</TableHead><TableHead className="text-right">Tenants</TableHead><TableHead className="text-right">Daily expected</TableHead><TableHead className="text-right">Collected</TableHead><TableHead className="text-right">Collection %</TableHead><TableHead className="text-right">Requests submitted</TableHead><TableHead>Status</TableHead><TableHead /></TableRow></TableHeader>
                  <TableBody>{filteredAgents.map((agent) => renderAgentRow(agent))}</TableBody>
                </Table>
              </div>
              <div className="space-y-2 p-3 md:hidden">{filteredAgents.map((agent) => renderAgentRow(agent, true))}</div>
            </>
          )}
        </CardContent>
      </Card>

      <Dialog open={Boolean(selectedAgent)} onOpenChange={(open) => { if (!open) setSelectedAgent(null); }}>
        <DialogContent className="max-h-[90vh] w-[calc(100vw-2rem)] max-w-4xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="break-words pr-6 text-base sm:text-lg">{selectedAgent?.name || 'Agent'} — collection details</DialogTitle>
            <DialogDescription className="break-words">{selectedAgent?.phone || 'No phone number'} · {format(day, 'dd MMM yyyy')}</DialogDescription>
          </DialogHeader>
          {selectedAgent && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Card><CardContent className="p-3"><p className="text-xs text-muted-foreground">Tenants</p><p className="mt-1 font-bold tabular-nums">{selectedAgent.tenantCount}</p></CardContent></Card>
                <Card><CardContent className="p-3"><p className="text-xs text-muted-foreground">Expected</p><p className="mt-1 font-bold tabular-nums">{formatUGX(selectedAgent.expected)}</p></CardContent></Card>
                <Card><CardContent className="p-3"><p className="text-xs text-muted-foreground">Paid today</p><p className="mt-1 font-bold tabular-nums">{formatUGX(selectedAgent.collected)}</p></CardContent></Card>
                <Card><CardContent className="p-3"><p className="text-xs text-muted-foreground">Requests submitted</p><p className="mt-1 font-bold tabular-nums">{selectedAgent.requestCount}</p></CardContent></Card>
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
                <div className="flex items-center justify-between"><h3 className="text-sm font-semibold">Active tenants</h3><StatusIndicator status={collectionStatus(selectedAgent.expected, selectedAgent.collected)} /></div>
                {selectedAgentRows.length === 0 ? <p className="py-6 text-center text-sm text-muted-foreground">No active daily-collection tenants for this agent.</p> : (
                  <div className="space-y-2">
                    {selectedAgentRows.map(({ request, tenant, collected }) => {
                      const expected = Number(request.daily_repayment ?? 0);
                      const outstanding = Math.max(0, Number(request.total_repayment ?? 0) - Number(request.amount_repaid ?? 0));
                      return (
                        <div key={request.id} className="border p-3">
                          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                            <div className="min-w-0">
                              <Button variant="link" className="h-auto p-0 text-left font-semibold" onClick={() => setSelectedTenant(request.tenant_id)}>{tenant?.full_name || 'Unknown tenant'}</Button>
                              <p className="text-xs text-muted-foreground">
                                {tenant?.phone ? (
                                  <a href={`tel:${tenant.phone.replace(/[^\d+]/g, '')}`} className="underline underline-offset-2">{tenant.phone}</a>
                                ) : 'No phone number'}{request.house_category ? ` · ${request.house_category}` : ''}
                              </p>
                              <p className="mt-1 text-xs text-muted-foreground">Rent Plan: {formatStatus(request.status)} · Started {format(new Date(request.created_at), 'dd MMM yyyy')}</p>
                            </div>
                            <StatusIndicator status={collectionStatus(expected, collected)} />
                          </div>
                          <div className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
                            <div><Label className="text-[10px] text-muted-foreground">Expected</Label><p className="font-semibold tabular-nums">{formatUGX(expected)}</p></div>
                            <div><Label className="text-[10px] text-muted-foreground">Paid today</Label><p className="font-semibold tabular-nums">{formatUGX(collected)}</p></div>
                            <div><Label className="text-[10px] text-muted-foreground">Outstanding plan</Label><p className="font-semibold tabular-nums">{formatUGX(outstanding)}</p></div>
                            <div><Label className="text-[10px] text-muted-foreground">Request status</Label><p className="font-semibold">{formatStatus(request.status)}</p></div>
                          </div>
                        </div>
                      );
                    })}
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
    </>
  );

  return (
    <Tabs value={tab} onValueChange={(value) => setTab(value as AgentMonitoringTab)} className="space-y-4">
      <div className="overflow-x-auto scrollbar-hide -mx-1 px-1">
        <TabsList variant="pills" className="w-max">
          <TabsTrigger value="all" variant="pills" className="text-xs">All agents</TabsTrigger>
          <TabsTrigger value="after-aug-2026" variant="pills" className="text-xs">After 1 Aug 2026</TabsTrigger>
          <TabsTrigger value="position" variant="pills" className="text-xs">Expected vs paid</TabsTrigger>
        </TabsList>
      </div>
      <TabsContent value="all" className="space-y-4">{body}</TabsContent>
      <TabsContent value="after-aug-2026" className="space-y-4">{body}</TabsContent>
      <TabsContent value="position" className="space-y-4"><AgentPaymentPosition /></TabsContent>
    </Tabs>
  );
}

export default AgentMonitoring;
