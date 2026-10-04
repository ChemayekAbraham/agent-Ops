import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Loader2, Landmark, Users, Phone, CheckCircle2 } from 'lucide-react';
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

  // Group by agent
  const grouped = useMemo(() => {
    const map = new Map<string, { agent_name: string; rows: AllocationRow[]; remaining: number }>();
    for (const r of rows) {
      const g = map.get(r.agent_id) ?? { agent_name: r.agent_name || 'Unknown Agent', rows: [], remaining: 0 };
      g.rows.push(r);
      g.remaining += r.remaining_amount;
      map.set(r.agent_id, g);
    }
    return [...map.entries()]
      .map(([agent_id, v]) => ({ agent_id, ...v }))
      .sort((a, b) => b.remaining - a.remaining);
  }, [rows]);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <Landmark className="h-4 w-4 text-[#9234EA]" />
          Live Landlord Payout Float on Agent Cards
          {rows.length > 0 && (
            <Badge variant="outline" className="text-[10px] ml-1 bg-[#9234EA]/10 text-[#9234EA] border-[#9234EA]/30">
              {rows.length} allocations · {totals.agents} agents
            </Badge>
          )}
        </CardTitle>
        <p className="text-xs text-muted-foreground mt-1">
          Money already disbursed by CFO and earmarked per tenant→landlord on agent cards. Waits for agent to pay landlord via MoMo (OTP + GPS gated).
        </p>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        ) : rows.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            <CheckCircle2 className="h-10 w-10 mx-auto mb-2 text-emerald-500" />
            <p className="font-medium">No outstanding float on agent cards</p>
            <p className="text-xs">All disbursed landlord float has been paid out.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {/* Totals strip */}
            <div className="grid grid-cols-3 gap-2 rounded-lg border-2 border-[#9234EA]/20 bg-[#9234EA]/5 p-3 text-center">
              <div>
                <p className="text-[10px] text-muted-foreground">Total Disbursed</p>
                <p className="font-bold text-sm text-[#9234EA]">{fmt(totals.allocated)}</p>
              </div>
              <div>
                <p className="text-[10px] text-muted-foreground">Already Paid Out</p>
                <p className="font-bold text-sm text-emerald-600">{fmt(totals.paid)}</p>
              </div>
              <div>
                <p className="text-[10px] text-muted-foreground">Outstanding on Cards</p>
                <p className="font-bold text-sm text-orange-600">{fmt(totals.remaining)}</p>
              </div>
            </div>

            {/* Grouped by agent */}
            <div className="space-y-3 max-h-[500px] overflow-y-auto">
              {grouped.map((g) => (
                <div key={g.agent_id} className="rounded-lg border">
                  <div className="flex items-center justify-between px-3 py-2 bg-muted/40 rounded-t-lg">
                    <div className="flex items-center gap-2 min-w-0">
                      <Users className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                      <p className="font-semibold text-sm truncate">{g.agent_name}</p>
                      <Badge variant="outline" className="text-[9px] px-1.5 py-0">{g.rows.length}</Badge>
                    </div>
                    <p className="font-bold text-sm text-[#9234EA] shrink-0">{fmt(g.remaining)}</p>
                  </div>
                  <div className="divide-y">
                    {g.rows.map((r) => (
                      <div key={r.id} className="flex items-start gap-2 px-3 py-2 text-xs">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
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
                            <p className="text-[10px] text-muted-foreground">paid {fmt(r.paid_out_amount)} / {fmt(r.allocated_amount)}</p>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}