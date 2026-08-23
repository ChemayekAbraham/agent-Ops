import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ChevronDown, ChevronRight, Loader2, Search, Landmark } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';

type PayoutRow = {
  id: string;
  landlordId: string;
  landlordName: string;
  landlordPhone: string | null;
  agentId: string | null;
  agentName: string;
  tenantName: string;
  amount: number;
  status: string;
  when: string | null;
  reference: string | null;
};

type LandlordGroup = {
  landlordId: string;
  landlordName: string;
  landlordPhone: string | null;
  total: number;
  completed: number;
  rows: PayoutRow[];
  agents: { agentId: string; agentName: string; total: number; count: number; rows: PayoutRow[] }[];
};

const statusTone = (s: string) =>
  s === 'completed'
    ? 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20'
    : s === 'failed'
      ? 'bg-destructive/10 text-destructive border-destructive/20'
      : 'bg-amber-500/10 text-amber-600 border-amber-500/20';

const fmtWhen = (v: string | null) =>
  v
    ? new Date(v).toLocaleString('en-GB', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—';

async function loadHistory(): Promise<LandlordGroup[]> {
  const { data, error } = await supabase
    .from('landlord_payouts')
    .select(
      'id, landlord_id, landlord_name, landlord_phone, agent_id, tenant_id, amount, status, created_at, disbursed_at, finops_disbursed_at, receipt_number, finops_momo_reference',
    )
    .order('created_at', { ascending: false })
    .limit(1000);
  if (error) throw error;
  const list = (data ?? []) as any[];

  const agentIds = [...new Set(list.map((r) => r.agent_id).filter(Boolean))] as string[];
  const tenantIds = [...new Set(list.map((r) => r.tenant_id).filter(Boolean))] as string[];

  const [agentsRes, tenantsRes] = await Promise.all([
    agentIds.length
      ? supabase.rpc('ops_get_profiles_lite', { p_ids: agentIds })
      : Promise.resolve({ data: [] as any[] }),
    tenantIds.length
      ? supabase.rpc('ops_get_profiles_lite', { p_ids: tenantIds })
      : Promise.resolve({ data: [] as any[] }),
  ]);

  const nameOf = (res: any) =>
    new Map<string, string>(
      (((res as any).data ?? []) as any[]).map((p) => [p.id, p.full_name ?? 'Unknown']),
    );
  const agentName = nameOf(agentsRes);
  const tenantName = nameOf(tenantsRes);

  const rows: PayoutRow[] = list.map((r) => ({
    id: r.id,
    landlordId: r.landlord_id,
    landlordName: r.landlord_name || 'Unknown landlord',
    landlordPhone: r.landlord_phone ?? null,
    agentId: r.agent_id ?? null,
    agentName: (r.agent_id ? agentName.get(r.agent_id) : null) ?? 'Unassigned agent',
    tenantName: (r.tenant_id ? tenantName.get(r.tenant_id) : null) ?? 'Unknown tenant',
    amount: Number(r.amount ?? 0),
    status: r.status ?? 'pending',
    when: r.finops_disbursed_at ?? r.disbursed_at ?? r.created_at ?? null,
    reference: r.finops_momo_reference ?? r.receipt_number ?? null,
  }));

  const byLandlord = new Map<string, LandlordGroup>();
  for (const r of rows) {
    let g = byLandlord.get(r.landlordId);
    if (!g) {
      g = {
        landlordId: r.landlordId,
        landlordName: r.landlordName,
        landlordPhone: r.landlordPhone,
        total: 0,
        completed: 0,
        rows: [],
        agents: [],
      };
      byLandlord.set(r.landlordId, g);
    }
    g.rows.push(r);
    g.total += r.amount;
    if (r.status === 'completed') g.completed += r.amount;
  }

  for (const g of byLandlord.values()) {
    const byAgent = new Map<string, LandlordGroup['agents'][number]>();
    for (const r of g.rows) {
      const key = r.agentId ?? 'none';
      let a = byAgent.get(key);
      if (!a) {
        a = { agentId: key, agentName: r.agentName, total: 0, count: 0, rows: [] };
        byAgent.set(key, a);
      }
      a.total += r.amount;
      a.count += 1;
      a.rows.push(r);
    }
    g.agents = [...byAgent.values()].sort((a, b) => b.total - a.total);
  }

  return [...byLandlord.values()].sort((a, b) => b.total - a.total);
}

/**
 * Landlord withdrawal history — agents withdraw float on behalf of landlords.
 * Level 1: landlord (total withdrawn). Level 2: each agent's withdrawal history
 * for that landlord, with tenant, amount, date and time of the withdrawal.
 */
export function LandlordWithdrawalHistoryPanel() {
  const [search, setSearch] = useState('');
  const [openLandlord, setOpenLandlord] = useState<string | null>(null);
  const [openAgent, setOpenAgent] = useState<string | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ['landlord-withdrawal-history'],
    queryFn: loadHistory,
    staleTime: 30_000,
  });

  const groups = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = data ?? [];
    if (!q) return list;
    return list.filter((g) =>
      `${g.landlordName} ${g.landlordPhone ?? ''} ${g.agents.map((a) => a.agentName).join(' ')}`
        .toLowerCase()
        .includes(q),
    );
  }, [data, search]);

  const grandTotal = groups.reduce((s, g) => s + g.total, 0);

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg sm:text-xl font-bold tracking-tight flex items-center gap-2">
          <Landmark className="h-5 w-5 text-primary" />
          Landlord Withdrawal History
        </h2>
        <p className="text-sm text-muted-foreground mt-0.5 max-w-2xl">
          Agents withdraw on behalf of landlords. Tap a landlord to see every withdrawal made for
          them — which agent withdrew, for which tenant, how much, and the exact date and time.
        </p>
      </div>

      <Card>
        <CardContent className="p-3 sm:p-4 space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative flex-1 min-w-[200px]">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search landlord, phone or agent"
                className="pl-8"
              />
            </div>
            <div className="text-right">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                {groups.length} {groups.length === 1 ? 'landlord' : 'landlords'}
              </p>
              <p className="font-mono tabular-nums text-sm font-bold text-primary">
                {formatUGX(grandTotal)}
              </p>
            </div>
          </div>

          {isLoading ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin inline mr-2" /> Loading withdrawal history…
            </div>
          ) : error ? (
            <div className="py-8 text-center text-sm text-destructive">
              Could not load landlord withdrawal history.
            </div>
          ) : groups.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              No landlord withdrawals recorded.
            </div>
          ) : (
            <div className="divide-y divide-border rounded-lg border border-border overflow-hidden">
              {groups.map((g) => {
                const isOpen = openLandlord === g.landlordId;
                return (
                  <div key={g.landlordId}>
                    <button
                      type="button"
                      onClick={() => setOpenLandlord(isOpen ? null : g.landlordId)}
                      className="w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-muted/40 transition-colors"
                    >
                      {isOpen ? (
                        <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
                      ) : (
                        <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                      )}
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-semibold text-foreground truncate">
                          {g.landlordName}
                        </p>
                        <p className="text-xs text-muted-foreground truncate">
                          {g.landlordPhone || '—'} • {g.rows.length}{' '}
                          {g.rows.length === 1 ? 'withdrawal' : 'withdrawals'} •{' '}
                          {g.agents.length} {g.agents.length === 1 ? 'agent' : 'agents'} • paid{' '}
                          {formatUGX(g.completed)}
                        </p>
                      </div>
                      <div className="text-right shrink-0">
                        <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                          Total withdrawn
                        </p>
                        <p className="font-mono tabular-nums text-sm font-bold">
                          {formatUGX(g.total)}
                        </p>
                      </div>
                    </button>

                    {isOpen && (
                      <div className="bg-muted/20 px-3 sm:px-4 py-3 space-y-2">
                        <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                          Agents who withdrew for this landlord
                        </p>
                        <div className="space-y-2">
                          {g.agents.map((a) => {
                            const key = `${g.landlordId}:${a.agentId}`;
                            const agentOpen = openAgent === key;
                            return (
                              <div
                                key={key}
                                className="rounded-lg border border-border bg-background overflow-hidden"
                              >
                                <button
                                  type="button"
                                  onClick={() => setOpenAgent(agentOpen ? null : key)}
                                  className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-muted/40 transition-colors"
                                >
                                  {agentOpen ? (
                                    <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                                  ) : (
                                    <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                                  )}
                                  <div className="flex-1 min-w-0">
                                    <p className="text-xs font-semibold truncate">{a.agentName}</p>
                                    <p className="text-[11px] text-muted-foreground">
                                      {a.count} {a.count === 1 ? 'withdrawal' : 'withdrawals'}
                                    </p>
                                  </div>
                                  <p className="font-mono tabular-nums text-xs font-bold shrink-0">
                                    {formatUGX(a.total)}
                                  </p>
                                </button>

                                {agentOpen && (
                                  <div className="overflow-x-auto border-t border-border">
                                    <table className="w-full text-xs">
                                      <thead>
                                        <tr className="text-left text-muted-foreground bg-muted/30">
                                          <th className="py-1.5 px-3 font-medium">Date & time</th>
                                          <th className="py-1.5 px-3 font-medium">Tenant</th>
                                          <th className="py-1.5 px-3 font-medium text-right">
                                            Amount
                                          </th>
                                          <th className="py-1.5 px-3 font-medium">Status</th>
                                          <th className="py-1.5 px-3 font-medium">Reference</th>
                                        </tr>
                                      </thead>
                                      <tbody className="divide-y divide-border/60">
                                        {a.rows.map((r) => (
                                          <tr key={r.id}>
                                            <td className="py-2 px-3 whitespace-nowrap text-foreground">
                                              {fmtWhen(r.when)}
                                            </td>
                                            <td className="py-2 px-3">{r.tenantName}</td>
                                            <td className="py-2 px-3 text-right font-mono tabular-nums font-semibold">
                                              {formatUGX(r.amount)}
                                            </td>
                                            <td className="py-2 px-3">
                                              <Badge
                                                variant="outline"
                                                className={`text-[10px] capitalize ${statusTone(r.status)}`}
                                              >
                                                {r.status.replace(/_/g, ' ')}
                                              </Badge>
                                            </td>
                                            <td className="py-2 px-3 text-muted-foreground">
                                              {r.reference || '—'}
                                            </td>
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
