import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Loader2, Landmark, Users, Phone, CheckCircle2, Wallet } from 'lucide-react';
import { format } from 'date-fns';

const fmt = (n: number) =>
  new Intl.NumberFormat('en-UG', { style: 'currency', currency: 'UGX', maximumFractionDigits: 0 }).format(n || 0);

interface AgentFloatRow {
  agent_id: string;
  balance: number;
  total_funded: number;
  total_paid_out: number;
  updated_at: string;
  region: string | null;
}

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
  created_at: string;
}

interface AgentGroup {
  agent_id: string;
  agent_name: string;
  agent_phone: string | null;
  balance: number;
  total_funded: number;
  total_paid_out: number;
  region: string | null;
  updated_at: string;
  allocations: (AllocationRow & { tenant_name: string })[];
  outstanding_allocated: number;
}

/**
 * Tenant Ops view: per-agent landlord-payout float wallets.
 * READ-ONLY. Surfaces:
 *   - Current balance + lifetime funded / paid-out per agent (from `agent_landlord_float`)
 *   - Open & partially-paid per-tenant earmarks (from `agent_landlord_float_allocations`)
 * Lets Tenant Ops trace which agent holds float earmarked for which tenant→landlord pair.
 * No wallet mutations — pure visibility.
 */
export function TenantOpsLandlordFloatPanel() {
  const { data, isLoading } = useQuery({
    queryKey: ['tenant-ops-agent-landlord-float'],
    queryFn: async () => {
      // Paginated: hard limits truncated the fleet (760 float rows vs a 500 cap),
      // so totals and per-agent rows silently under-reported.
      const PAGE = 1000;
      const fetchAll = async (build: (from: number) => any) => {
        const rows: any[] = [];
        for (let from = 0; ; from += PAGE) {
          const { data, error } = await build(from);
          if (error) return { data: rows, error };
          rows.push(...(data || []));
          if (!data || data.length < PAGE) break;
        }
        return { data: rows, error: null as any };
      };
      const [floatRes, allocRes] = await Promise.all([
        fetchAll((from) => supabase
          .from('agent_landlord_float' as any)
          .select('agent_id, balance, total_funded, total_paid_out, updated_at, region')
          .order('balance', { ascending: false })
          .range(from, from + PAGE - 1)),
        fetchAll((from) => supabase
          .from('agent_landlord_float_allocations' as any)
          .select('id, agent_id, tenant_id, landlord_id, landlord_name, landlord_phone, mobile_money_provider, allocated_amount, paid_out_amount, remaining_amount, status, created_at')
          .in('status', ['open', 'partially_paid'])
          .order('created_at', { ascending: false })
          .range(from, from + PAGE - 1)),
      ]);
      if (floatRes.error) throw floatRes.error;
      if (allocRes.error) throw allocRes.error;

      const floats: AgentFloatRow[] = ((floatRes.data ?? []) as any[]).map((r) => ({
        agent_id: r.agent_id,
        balance: Number(r.balance) || 0,
        total_funded: Number(r.total_funded) || 0,
        total_paid_out: Number(r.total_paid_out) || 0,
        updated_at: r.updated_at,
        region: r.region ?? null,
      }));
      const allocations: AllocationRow[] = ((allocRes.data ?? []) as any[]).map((r) => ({
        ...r,
        allocated_amount: Number(r.allocated_amount) || 0,
        paid_out_amount: Number(r.paid_out_amount) || 0,
        remaining_amount: Number(r.remaining_amount) || 0,
      }));

      // Name lookup
      const agentIds = new Set<string>([
        ...floats.map((f) => f.agent_id),
        ...allocations.map((a) => a.agent_id),
      ]);
      const tenantIds = new Set<string>(
        allocations.map((a) => a.tenant_id).filter(Boolean) as string[],
      );
      const ids = [...new Set([...agentIds, ...tenantIds])];
      const nameMap = new Map<string, { name: string; phone: string | null }>();
      if (ids.length) {
        const { data: profiles } = await supabase
          .from('profiles')
          .select('id, full_name, phone')
          .in('id', ids);
        for (const p of profiles || []) {
          nameMap.set(p.id, { name: p.full_name || 'Unknown', phone: p.phone ?? null });
        }
      }

      // Build per-agent groups (union of float rows + allocation-only agents)
      const groups = new Map<string, AgentGroup>();
      for (const f of floats) {
        const prof = nameMap.get(f.agent_id);
        groups.set(f.agent_id, {
          agent_id: f.agent_id,
          agent_name: prof?.name || 'Unknown Agent',
          agent_phone: prof?.phone ?? null,
          balance: f.balance,
          total_funded: f.total_funded,
          total_paid_out: f.total_paid_out,
          region: f.region,
          updated_at: f.updated_at,
          allocations: [],
          outstanding_allocated: 0,
        });
      }
      for (const a of allocations) {
        let g = groups.get(a.agent_id);
        if (!g) {
          const prof = nameMap.get(a.agent_id);
          g = {
            agent_id: a.agent_id,
            agent_name: prof?.name || 'Unknown Agent',
            agent_phone: prof?.phone ?? null,
            balance: 0,
            total_funded: 0,
            total_paid_out: 0,
            region: null,
            updated_at: a.created_at,
            allocations: [],
            outstanding_allocated: 0,
          };
          groups.set(a.agent_id, g);
        }
        g.allocations.push({
          ...a,
          tenant_name: a.tenant_id ? nameMap.get(a.tenant_id)?.name || 'Unknown Tenant' : '—',
        });
        g.outstanding_allocated += a.remaining_amount;
      }

      const list = [...groups.values()].sort(
        (x, y) => y.balance + y.outstanding_allocated - (x.balance + x.outstanding_allocated),
      );
      return list;
    },
    staleTime: 30_000,
  });

  const rows = data || [];

  const totals = useMemo(() => {
    let balance = 0, funded = 0, paid = 0, outstanding = 0, allocations = 0;
    for (const r of rows) {
      balance += r.balance;
      funded += r.total_funded;
      paid += r.total_paid_out;
      outstanding += r.outstanding_allocated;
      allocations += r.allocations.length;
    }
    return { balance, funded, paid, outstanding, allocations, agents: rows.length };
  }, [rows]);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <Landmark className="h-4 w-4 text-[#9234EA]" />
          Agent Landlord-Float Wallets
          {rows.length > 0 && (
            <Badge variant="outline" className="text-[10px] ml-1 bg-[#9234EA]/10 text-[#9234EA] border-[#9234EA]/30">
              {totals.agents} agents · {totals.allocations} earmarks
            </Badge>
          )}
        </CardTitle>
        <p className="text-xs text-muted-foreground mt-1">
          Read-only view of every agent's landlord-payout float balance and the per-tenant landlord earmarks sitting on their card. Money already left treasury, waiting for the agent to pay the landlord via MoMo.
        </p>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        ) : rows.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            <CheckCircle2 className="h-10 w-10 mx-auto mb-2 text-emerald-500" />
            <p className="font-medium">No agent landlord float on record</p>
            <p className="text-xs">CFO has not yet disbursed any landlord-payout float to agents.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {/* Totals strip */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 rounded-lg border-2 border-[#9234EA]/20 bg-[#9234EA]/5 p-3 text-center">
              <div>
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider">On Cards Now</p>
                <p className="font-bold text-sm text-[#9234EA]">{fmt(totals.balance)}</p>
              </div>
              <div>
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Earmarked Outstanding</p>
                <p className="font-bold text-sm text-orange-600">{fmt(totals.outstanding)}</p>
              </div>
              <div>
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Lifetime Funded</p>
                <p className="font-bold text-sm text-foreground">{fmt(totals.funded)}</p>
              </div>
              <div>
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Lifetime Paid Out</p>
                <p className="font-bold text-sm text-emerald-600">{fmt(totals.paid)}</p>
              </div>
            </div>

            {/* Grouped by agent */}
            <div className="space-y-3 max-h-[600px] overflow-y-auto">
              {rows.map((g) => (
                <div key={g.agent_id} className="rounded-lg border">
                  <div className="flex items-start justify-between gap-2 px-3 py-2 bg-muted/40 rounded-t-lg">
                    <div className="flex items-start gap-2 min-w-0">
                      <Users className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-0.5" />
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="font-semibold text-sm truncate">{g.agent_name}</p>
                          {g.region && (
                            <Badge variant="outline" className="text-[9px] px-1.5 py-0">{g.region}</Badge>
                          )}
                          {g.allocations.length > 0 && (
                            <Badge variant="outline" className="text-[9px] px-1.5 py-0">
                              {g.allocations.length} earmark{g.allocations.length === 1 ? '' : 's'}
                            </Badge>
                          )}
                        </div>
                        {g.agent_phone && (
                          <p className="text-[10px] text-muted-foreground inline-flex items-center gap-1 mt-0.5">
                            <Phone className="h-2.5 w-2.5" />{g.agent_phone}
                          </p>
                        )}
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="font-bold text-sm text-[#9234EA] inline-flex items-center gap-1 justify-end">
                        <Wallet className="h-3 w-3" />{fmt(g.balance)}
                      </p>
                      <p className="text-[10px] text-muted-foreground">
                        funded {fmt(g.total_funded)} · paid {fmt(g.total_paid_out)}
                      </p>
                    </div>
                  </div>
                  {g.allocations.length === 0 ? (
                    <div className="px-3 py-2 text-[11px] text-muted-foreground italic">
                      No open per-tenant earmarks. Balance is free float awaiting CFO assignment.
                    </div>
                  ) : (
                    <div className="divide-y">
                      {g.allocations.map((r) => (
                        <div key={r.id} className="flex items-start gap-2 px-3 py-2 text-xs">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <p className="font-medium truncate">{r.tenant_name}</p>
                              <span className="text-[10px] text-muted-foreground">→</span>
                              <p className="font-medium truncate text-[#9234EA]">{r.landlord_name || 'Unknown Landlord'}</p>
                            </div>
                            <div className="flex items-center gap-2 flex-wrap mt-0.5 text-[10px] text-muted-foreground">
                              {r.landlord_phone && (
                                <span className="inline-flex items-center gap-1">
                                  <Phone className="h-2.5 w-2.5" />{r.landlord_phone}
                                  {r.mobile_money_provider ? ` · ${r.mobile_money_provider}` : ''}
                                </span>
                              )}
                              <span>{format(new Date(r.created_at), 'dd MMM yyyy')}</span>
                              <Badge
                                variant="outline"
                                className={
                                  r.status === 'partially_paid'
                                    ? 'text-[9px] px-1.5 py-0 bg-amber-100 text-amber-700 border-amber-200'
                                    : 'text-[9px] px-1.5 py-0 bg-blue-100 text-blue-700 border-blue-200'
                                }
                              >
                                {r.status === 'partially_paid' ? 'Partially Paid' : 'Open'}
                              </Badge>
                            </div>
                          </div>
                          <div className="text-right shrink-0">
                            <p className="font-bold text-sm text-orange-600">{fmt(r.remaining_amount)}</p>
                            {r.paid_out_amount > 0 && (
                              <p className="text-[10px] text-muted-foreground">
                                paid {fmt(r.paid_out_amount)} / {fmt(r.allocated_amount)}
                              </p>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}