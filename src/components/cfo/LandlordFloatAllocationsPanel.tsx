import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import {
  Loader2,
  Landmark,
  Users,
  Phone,
  CheckCircle2,
  Search,
  Wallet,
  Clock,
  ArrowRight,
  TrendingUp,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { format } from 'date-fns';

const fmt = (n: number) =>
  new Intl.NumberFormat('en-UG', { style: 'currency', currency: 'UGX', maximumFractionDigits: 0 }).format(n || 0);

interface AllocationRow {
  id: string;
  agent_id: string;
  tenant_id: string | null;
  landlord_id: string | null;
  landlord_name: string | null;
  landlord_phone: string | null;
  mobile_money_provider: string | null;
  allocated_amount: number;
  paid_out_amount: number;
  remaining_amount: number;
  status: string;
  source: string | null;
  created_at: string;
  agent_name?: string;
  tenant_name?: string;
}

/**
 * CFO view: every CFO-disbursed Landlord Payout Float allocation that is
 * currently sitting on an agent's card (open or partially_paid).
 * This is the downstream side of the Landlord Payout Float tab — what has
 * already left treasury and is now earmarked on agent wallets, waiting for
 * the agent to pay the landlord via MoMo.
 */
export function LandlordFloatAllocationsPanel() {
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'open' | 'partially_paid'>('all');
  const [expandedAgents, setExpandedAgents] = useState<Record<string, boolean>>({});

  const { data: rows = [], isLoading } = useQuery({
    queryKey: ['cfo-landlord-float-allocations'],
    queryFn: async (): Promise<AllocationRow[]> => {
      const { data, error } = await supabase
        .from('agent_landlord_float_allocations' as any)
        .select('id, agent_id, tenant_id, landlord_id, landlord_name, landlord_phone, mobile_money_provider, allocated_amount, paid_out_amount, remaining_amount, status, source, created_at')
        .in('status', ['open', 'partially_paid'])
        .order('created_at', { ascending: false })
        .limit(500);
      if (error) throw error;
      const list = ((data ?? []) as any[]).map((r) => ({
        ...r,
        allocated_amount: Number(r.allocated_amount) || 0,
        paid_out_amount: Number(r.paid_out_amount) || 0,
        remaining_amount: Number(r.remaining_amount) || 0,
      })) as AllocationRow[];

      const agentIds = [...new Set(list.map((r) => r.agent_id).filter(Boolean))];
      const tenantIds = [...new Set(list.map((r) => r.tenant_id).filter(Boolean) as string[])];
      const allIds = [...new Set([...agentIds, ...tenantIds])];
      const nameMap = new Map<string, string>();
      if (allIds.length) {
        const { data: profiles } = await supabase
          .from('profiles')
          .select('id, full_name')
          .in('id', allIds);
        for (const p of profiles || []) nameMap.set(p.id, p.full_name || 'Unknown');
      }
      return list.map((r) => ({
        ...r,
        agent_name: nameMap.get(r.agent_id) || 'Unknown Agent',
        tenant_name: r.tenant_id ? nameMap.get(r.tenant_id) || 'Unknown Tenant' : '—',
      }));
    },
    staleTime: 15_000,
  });

  const totals = useMemo(() => {
    const allocated = rows.reduce((s, r) => s + r.allocated_amount, 0);
    const remaining = rows.reduce((s, r) => s + r.remaining_amount, 0);
    const paid = rows.reduce((s, r) => s + r.paid_out_amount, 0);
    const agents = new Set(rows.map((r) => r.agent_id)).size;
    return { allocated, remaining, paid, agents };
  }, [rows]);

  const filteredRows = useMemo(() => {
    return rows.filter((r) => {
      if (statusFilter !== 'all' && r.status !== statusFilter) return false;
      if (searchTerm.trim()) {
        const q = searchTerm.toLowerCase();
        const agent = (r.agent_name ?? '').toLowerCase();
        const tenant = (r.tenant_name ?? '').toLowerCase();
        const landlord = (r.landlord_name ?? '').toLowerCase();
        const phone = (r.landlord_phone ?? '').toLowerCase();
        if (!agent.includes(q) && !tenant.includes(q) && !landlord.includes(q) && !phone.includes(q)) {
          return false;
        }
      }
      return true;
    });
  }, [rows, statusFilter, searchTerm]);

  // Group by agent
  const grouped = useMemo(() => {
    const map = new Map<string, { agent_name: string; rows: AllocationRow[]; remaining: number; allocated: number; paid: number }>();
    for (const r of filteredRows) {
      const g = map.get(r.agent_id) ?? {
        agent_name: r.agent_name || 'Unknown Agent',
        rows: [],
        remaining: 0,
        allocated: 0,
        paid: 0,
      };
      g.rows.push(r);
      g.remaining += r.remaining_amount;
      g.allocated += r.allocated_amount;
      g.paid += r.paid_out_amount;
      map.set(r.agent_id, g);
    }
    return [...map.entries()]
      .map(([agent_id, v]) => ({ agent_id, ...v }))
      .sort((a, b) => b.remaining - a.remaining);
  }, [filteredRows]);

  const toggleAgent = (agentId: string) => {
    setExpandedAgents((prev) => ({
      ...prev,
      [agentId]: prev[agentId] === undefined ? false : !prev[agentId],
    }));
  };

  const isExpanded = (agentId: string) => expandedAgents[agentId] !== false;

  return (
    <Card className="shadow-sm">
      <CardHeader className="p-4 sm:p-5 border-b border-border/60">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <CardTitle className="text-base font-bold flex items-center gap-2">
                <Landmark className="h-4 w-4 text-primary" />
                Live Float in Agent Custody
              </CardTitle>
              {rows.length > 0 && (
                <Badge variant="outline" className="text-xs font-mono font-medium">
                  {rows.length} {rows.length === 1 ? 'allocation' : 'allocations'} · {totals.agents} agents
                </Badge>
              )}
            </div>
            <CardDescription className="text-xs mt-0.5">
              Funds disbursed from company treasury, earmarked per tenant→landlord on agent cards awaiting MoMo payout.
            </CardDescription>
          </div>
        </div>

        {/* 3-Card Summary Strip */}
        {!isLoading && rows.length > 0 && (
          <div className="grid grid-cols-1 gap-2 pt-2 sm:grid-cols-3">
            <div className="rounded-lg border border-border/80 bg-card p-3 shadow-xs">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Total Disbursed</p>
              <p className="mt-0.5 text-base font-bold text-foreground sm:text-lg">{fmt(totals.allocated)}</p>
              <p className="text-[10px] text-muted-foreground">Original earmarked principal</p>
            </div>
            <div className="rounded-lg border border-border/80 bg-card p-3 shadow-xs">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Already Paid Out</p>
              <p className="mt-0.5 text-base font-bold text-emerald-700 dark:text-emerald-400 sm:text-lg">{fmt(totals.paid)}</p>
              <p className="text-[10px] text-muted-foreground">Sent to landlords via MoMo</p>
            </div>
            <div className="rounded-lg border border-border/80 bg-card p-3 shadow-xs">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Outstanding on Cards</p>
              <p className="mt-0.5 text-base font-bold text-amber-700 dark:text-amber-400 sm:text-lg">{fmt(totals.remaining)}</p>
              <p className="text-[10px] text-muted-foreground">Currently held by {totals.agents} agents</p>
            </div>
          </div>
        )}

        {/* Filter and Search Bar */}
        <div className="flex flex-col gap-2 pt-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-1.5 overflow-x-auto">
            <Button
              size="sm"
              variant={statusFilter === 'all' ? 'default' : 'ghost'}
              className={`h-7 px-3 text-xs font-medium rounded-full ${
                statusFilter === 'all' ? 'shadow-sm' : 'text-muted-foreground'
              }`}
              onClick={() => setStatusFilter('all')}
            >
              All ({rows.length})
            </Button>
            <Button
              size="sm"
              variant={statusFilter === 'open' ? 'default' : 'ghost'}
              className={`h-7 px-3 text-xs font-medium rounded-full ${
                statusFilter === 'open' ? 'shadow-sm' : 'text-muted-foreground'
              }`}
              onClick={() => setStatusFilter('open')}
            >
              Open ({rows.filter((r) => r.status === 'open').length})
            </Button>
            <Button
              size="sm"
              variant={statusFilter === 'partially_paid' ? 'default' : 'ghost'}
              className={`h-7 px-3 text-xs font-medium rounded-full ${
                statusFilter === 'partially_paid' ? 'shadow-sm' : 'text-muted-foreground'
              }`}
              onClick={() => setStatusFilter('partially_paid')}
            >
              Partially Paid ({rows.filter((r) => r.status === 'partially_paid').length})
            </Button>
          </div>

          <div className="relative w-full sm:w-64">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search agent, tenant, or landlord..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="h-8 pl-8 text-xs"
            />
          </div>
        </div>
      </CardHeader>

      <CardContent className="p-4 sm:p-5">
        {isLoading ? (
          <div className="flex flex-col items-center justify-center py-12 text-center text-muted-foreground">
            <Loader2 className="h-6 w-6 animate-spin text-primary mb-2" />
            <p className="text-sm font-medium">Loading agent float allocations…</p>
          </div>
        ) : rows.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground">
            <CheckCircle2 className="h-10 w-10 mx-auto mb-2 text-emerald-600" />
            <p className="font-semibold text-foreground">No outstanding float on agent cards</p>
            <p className="text-xs text-muted-foreground mt-0.5">All disbursed landlord float has been fully delivered to landlords.</p>
          </div>
        ) : grouped.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground">
            <Search className="h-10 w-10 mx-auto mb-2 text-muted-foreground/40" />
            <p className="font-semibold text-foreground">No allocations match filters</p>
            <p className="text-xs text-muted-foreground mt-0.5">Try clearing the search query or status filter.</p>
          </div>
        ) : (
          <div className="space-y-3.5">
            {grouped.map((g) => {
              const open = isExpanded(g.agent_id);
              const pct = g.allocated > 0 ? Math.round((g.paid / g.allocated) * 100) : 0;
              return (
                <div
                  key={g.agent_id}
                  className="rounded-xl border border-border/80 bg-card overflow-hidden shadow-xs transition-colors hover:border-border"
                >
                  {/* Agent Header */}
                  <div
                    className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 bg-muted/30 cursor-pointer select-none border-b border-border/60"
                    onClick={() => toggleAgent(g.agent_id)}
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary shrink-0">
                        <Users className="h-4 w-4" />
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="font-semibold text-sm truncate text-foreground">{g.agent_name}</p>
                          <Badge variant="outline" className="text-[10px] px-1.5 py-0 font-mono">
                            {g.rows.length} {g.rows.length === 1 ? 'tenant' : 'tenants'}
                          </Badge>
                        </div>
                        <div className="flex items-center gap-2 mt-0.5 text-[11px] text-muted-foreground">
                          <span>Paid: {fmt(g.paid)}</span>
                          <span>·</span>
                          <span>{pct}% complete</span>
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-3">
                      <div className="text-right">
                        <p className="text-[10px] uppercase font-semibold text-muted-foreground">Outstanding</p>
                        <p className="font-bold text-sm font-mono text-amber-700 dark:text-amber-400">
                          {fmt(g.remaining)}
                        </p>
                      </div>
                      <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-muted-foreground">
                        {open ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                      </Button>
                    </div>
                  </div>

                  {/* Allocation Details */}
                  {open && (
                    <div className="divide-y divide-border/60 bg-card">
                      {g.rows.map((r) => {
                        const paidPct = r.allocated_amount > 0 ? Math.round((r.paid_out_amount / r.allocated_amount) * 100) : 0;
                        return (
                          <div key={r.id} className="p-3 sm:px-4 text-xs transition-colors hover:bg-muted/15 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                            <div className="space-y-1 min-w-0 flex-1">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="font-semibold text-foreground text-sm">{r.tenant_name}</span>
                                <ArrowRight className="h-3 w-3 text-muted-foreground" />
                                <span className="font-semibold text-primary text-sm">{r.landlord_name || 'Landlord'}</span>
                                <Badge
                                  variant="outline"
                                  className={
                                    r.status === 'partially_paid'
                                      ? 'text-[10px] px-1.5 py-0 bg-amber-50 text-amber-800 border-amber-300 dark:bg-amber-950/40 dark:text-amber-300'
                                      : 'text-[10px] px-1.5 py-0 bg-blue-50 text-blue-800 border-blue-300 dark:bg-blue-950/40 dark:text-blue-300'
                                  }
                                >
                                  {r.status === 'partially_paid' ? 'Partially Paid' : 'Open'}
                                </Badge>
                              </div>

                              <div className="flex items-center gap-3 text-[11px] text-muted-foreground flex-wrap">
                                {r.landlord_phone && (
                                  <span className="inline-flex items-center gap-1 font-mono">
                                    <Phone className="h-3 w-3 text-muted-foreground" />
                                    {r.landlord_phone}
                                    {r.mobile_money_provider ? ` (${r.mobile_money_provider})` : ''}
                                  </span>
                                )}
                                <span>Disbursed: {format(new Date(r.created_at), 'dd MMM yyyy')}</span>
                              </div>
                            </div>

                            <div className="flex items-center justify-between sm:justify-end gap-4 shrink-0 border-t border-border/40 pt-2 sm:border-0 sm:pt-0">
                              <div className="text-left sm:text-right">
                                <p className="text-[10px] text-muted-foreground uppercase">Remaining</p>
                                <p className="font-bold text-sm font-mono text-amber-700 dark:text-amber-400">
                                  {fmt(r.remaining_amount)}
                                </p>
                              </div>

                              <div className="w-24 sm:w-28 space-y-1">
                                <div className="flex justify-between text-[10px] text-muted-foreground font-mono">
                                  <span>{paidPct}%</span>
                                  <span>{fmt(r.allocated_amount)}</span>
                                </div>
                                <Progress value={paidPct} className="h-1.5" />
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
