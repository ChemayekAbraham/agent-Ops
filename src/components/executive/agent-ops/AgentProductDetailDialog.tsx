import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { format } from 'date-fns';
import { Loader2, Phone, Mail, MapPin } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { ScrollArea } from '@/components/ui/scroll-area';
import { UserAvatar } from '@/components/UserAvatar';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/rentCalculations';

interface AgentDetail {
  agent: {
    id: string;
    full_name: string | null;
    avatar_url: string | null;
    phone: string | null;
    email: string | null;
    territory: string | null;
    district: string | null;
    centre: string | null;
    roles: string[] | null;
  } | null;
  totals: {
    items: number;
    orders: number;
    billed: number;
    repaid: number;
    outstanding: number;
  } | null;
  items: Array<{
    sale_id: string;
    item_name: string | null;
    brand: string | null;
    model_type: string | null;
    quantity: number | null;
    amount: number | null;
    repaid: number | null;
    outstanding: number | null;
    order_status: string | null;
    payment_plan: string | null;
    advance_period_months: number | null;
    access_repayment_days: number | null;
    schedule_days: number | null;
    scheduled_daily_amount: number | null;
    repayment_starts_on: string | null;
    sale_date: string | null;
    created_at: string | null;
  }>;
  plans: Array<{
    id: string;
    item_name: string | null;
    original_amount: number | null;
    amount_recovered: number | null;
    outstanding_balance: number | null;
    daily_deduction_amount: number | null;
    advance_period_months: number | null;
    access_repayment_days: number | null;
    schedule_days: number | null;
    scheduled_daily_amount: number | null;
    status: string | null;
    starts_on: string | null;
    last_recovery_at: string | null;
  }>;
  deductions: Array<{
    id: string;
    item_name: string | null;
    amount: number | null;
    outstanding_after: number | null;
    transaction_ref: string | null;
    created_at: string | null;
  }>;
}

const dt = (v: string | null | undefined, pattern = 'dd MMM yyyy') => {
  if (!v) return '—';
  const d = new Date(String(v).length <= 10 ? `${String(v).slice(0, 10)}T00:00:00` : v);
  return Number.isNaN(d.getTime()) ? '—' : format(d, pattern);
};

interface Props {
  agentId: string | null;
  category?: string;
  onClose: () => void;
}

export function AgentProductDetailDialog({ agentId, category, onClose }: Props) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['agent-product-detail', agentId, category ?? 'all'],
    enabled: !!agentId,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_agent_product_detail' as any, {
        p_agent_id: agentId,
        p_category: category ?? null,
      });
      if (error) throw error;
      const d = (data ?? {}) as Partial<AgentDetail>;
      return {
        agent: d.agent ?? null,
        totals: d.totals ?? null,
        items: d.items ?? [],
        plans: d.plans ?? [],
        deductions: d.deductions ?? [],
      } as AgentDetail;
    },
  });

  // Company-owned bikes attached to the agent for operations (no recovery, no sale).
  const { data: fleetRows } = useQuery({
    queryKey: ['agent-fleet-assignments', agentId],
    enabled: !!agentId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('agent_fleet_assignments' as any)
        .select('id,item_name,plate_number,serial_number,assigned_on,status')
        .eq('agent_id', agentId!)
        .order('assigned_on', { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as Array<{
        id: string;
        item_name: string | null;
        plate_number: string | null;
        serial_number: string | null;
        assigned_on: string | null;
        status: string | null;
      }>;
    },
  });
  const fleet = fleetRows ?? [];

  const agent = data?.agent;
  const totals = data?.totals;

  // Only display actual items held (exclude rejected/cancelled applications)
  const items = useMemo(() => {
    return (data?.items ?? []).filter(
      (it) => !['rejected', 'cancelled', 'declined'].includes((it.order_status || '').toLowerCase()),
    );
  }, [data?.items]);

  // Only display valid active recovery plans matching actual active items
  const plans = useMemo(() => {
    return (data?.plans ?? []).filter((p) => {
      const st = (p.status || '').toLowerCase();
      if (['cancelled', 'terminated', 'inactive', 'rejected'].includes(st)) return false;
      // Exclude zero-deduction duplicate/abandoned plans from rejected attempts
      if (Number(p.daily_deduction_amount || 0) === 0 && Number(p.amount_recovered || 0) === 0) return false;
      if (items.length > 0) {
        const itemAmounts = new Set(items.map((it) => Number(it.amount || 0)));
        if (!itemAmounts.has(Number(p.original_amount || 0))) return false;
      }
      return true;
    });
  }, [data?.plans, items]);

  return (
    <Dialog open={!!agentId} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-2xl p-0 gap-0 max-h-[90vh] flex flex-col">
        <DialogHeader className="p-4 pb-3 border-b border-border">
          <DialogTitle className="text-base">Agent product profile</DialogTitle>
        </DialogHeader>

        {isLoading ? (
          <div className="p-10 flex items-center justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : error ? (
          <p className="p-6 text-sm text-destructive text-center">
            {(error as Error).message || 'Could not load this agent.'}
          </p>
        ) : (
          <ScrollArea className="flex-1">
            <div className="p-4 space-y-4">
              {/* Identity */}
              <div className="flex items-start gap-3">
                <UserAvatar avatarUrl={agent?.avatar_url} fullName={agent?.full_name || undefined} size="lg" />
                <div className="min-w-0 flex-1 space-y-1">
                  <p className="font-semibold truncate">{agent?.full_name || 'Unknown agent'}</p>
                  <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    {agent?.phone && (
                      <a href={`tel:${agent.phone}`} className="inline-flex items-center gap-1 hover:text-foreground">
                        <Phone className="h-3 w-3" />{agent.phone}
                      </a>
                    )}
                    {agent?.email && (
                      <span className="inline-flex items-center gap-1 truncate">
                        <Mail className="h-3 w-3" />{agent.email}
                      </span>
                    )}
                    {(agent?.centre || agent?.district || agent?.territory) && (
                      <span className="inline-flex items-center gap-1">
                        <MapPin className="h-3 w-3" />
                        {[agent?.centre, agent?.district, agent?.territory].filter(Boolean).join(' · ')}
                      </span>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-1 pt-0.5">
                    {(agent?.roles ?? []).length === 0 ? (
                      <Badge variant="outline" className="text-[10px]">
                        {agent?.email ? 'No role' : 'Profile not linked'}
                      </Badge>
                    ) : (
                      (agent?.roles ?? []).map((r) => (
                        <Badge key={r} variant="secondary" className="text-[10px] capitalize">
                          {r.replace(/_/g, ' ')}
                        </Badge>
                      ))
                    )}
                  </div>
                </div>
              </div>

              {/* Money summary */}
              <div className="grid grid-cols-3 gap-2">
                <div className="rounded-xl border border-border p-2.5">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Billed</p>
                  <p className="text-sm font-bold tabular-nums">{formatUGX(Number(totals?.billed || 0))}</p>
                  <p className="text-[11px] text-muted-foreground">
                    {Number(totals?.items || 0)} item(s) · {Number(totals?.orders || 0)} order(s)
                  </p>
                </div>
                <div className="rounded-xl border border-border p-2.5">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Repaid</p>
                  <p className="text-sm font-bold tabular-nums text-success">{formatUGX(Number(totals?.repaid || 0))}</p>
                </div>
                <div className="rounded-xl border border-border p-2.5">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Outstanding</p>
                  <p className="text-sm font-bold tabular-nums text-destructive">
                    {formatUGX(Number(totals?.outstanding || 0))}
                  </p>
                </div>
              </div>

              <Separator />

              {/* Company fleet bikes: assigned assets, no money involved */}
              <section className="space-y-2">
                <h3 className="text-sm font-semibold">Company fleet assets ({fleet.length})</h3>
                {fleet.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No company bike assigned to this agent.</p>
                ) : (
                  <div className="rounded-xl border border-border divide-y divide-border">
                    {fleet.map((f) => (
                      <div key={f.id} className="p-2.5 flex flex-wrap items-center gap-2">
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium truncate">{f.item_name || 'Company Fleet Bike'}</p>
                          <p className="text-[11px] text-muted-foreground">
                            {dt(f.assigned_on)}
                            {f.plate_number ? ` · Plate ${f.plate_number}` : ''}
                            {f.serial_number ? ` · SN ${f.serial_number}` : ''}
                          </p>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <span className="text-[11px] text-muted-foreground tabular-nums">{formatUGX(0)}</span>
                          <Badge variant="secondary" className="text-[10px] capitalize">
                            {(f.status || 'assigned').replace(/_/g, ' ')}
                          </Badge>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              <Separator />



              {/* Items held */}
              <section className="space-y-2">
                <h3 className="text-sm font-semibold">Items ({items.length})</h3>
                {items.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No items recorded for this agent.</p>
                ) : (
                  <div className="rounded-xl border border-border divide-y divide-border">
                    {items.map((it) => (
                      <div key={it.sale_id} className="p-2.5 flex flex-wrap items-center gap-2">
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium truncate">
                            {[it.brand, it.model_type].filter(Boolean).join(' ') || it.item_name || '—'}
                            {Number(it.quantity || 1) > 1 ? ` × ${it.quantity}` : ''}
                          </p>
                          <p className="text-[11px] text-muted-foreground">
                            {dt(it.sale_date || it.created_at)}
                            {it.payment_plan ? ` · ${it.payment_plan.replace(/_/g, ' ')}` : ''}
                          </p>
                        </div>
                        <div className="text-right shrink-0">
                          <p className="text-sm font-semibold tabular-nums">{formatUGX(Number(it.amount || 0))}</p>
                          <p className="text-[11px] text-destructive tabular-nums">
                            {formatUGX(Number(it.outstanding || 0))} left
                          </p>
                        </div>
                        <Badge variant="outline" className="text-[10px] capitalize shrink-0">
                          {(it.order_status || 'issued').replace(/_/g, ' ')}
                        </Badge>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              {/* Recovery plans */}
              <section className="space-y-2">
                <h3 className="text-sm font-semibold">Recovery plans ({plans.length})</h3>
                {plans.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No recovery plan attached.</p>
                ) : (
                  <div className="rounded-xl border border-border divide-y divide-border">
                    {plans.map((p) => (
                      <div key={p.id} className="p-2.5 space-y-1">
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-sm font-medium truncate">{p.item_name || '—'}</p>
                          <Badge variant="outline" className="text-[10px] capitalize shrink-0">
                            {(p.status || 'active').replace(/_/g, ' ')}
                          </Badge>
                        </div>
                        <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
                          <span>Plan: <span className="font-medium text-foreground tabular-nums">{formatUGX(Number(p.original_amount || 0))}</span></span>
                          <span>Recovered: <span className="font-medium text-success tabular-nums">{formatUGX(Number(p.amount_recovered || 0))}</span></span>
                          <span>Left: <span className="font-medium text-destructive tabular-nums">{formatUGX(Number(p.outstanding_balance || 0))}</span></span>
                          <span>Daily: <span className="font-medium text-foreground tabular-nums">{formatUGX(Number(p.daily_deduction_amount || 0))}</span></span>
                          <span>Started {dt(p.starts_on)}</span>
                          <span>Last recovery {dt(p.last_recovery_at, 'dd MMM yyyy HH:mm')}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              {/* Deductions */}
              <section className="space-y-2">
                <h3 className="text-sm font-semibold">Repayment history ({data?.deductions.length ?? 0})</h3>
                {(data?.deductions ?? []).length === 0 ? (
                  <p className="text-xs text-muted-foreground">No repayment recorded yet.</p>
                ) : (
                  <div className="rounded-xl border border-border divide-y divide-border max-h-64 overflow-y-auto">
                    {data?.deductions.map((d) => (
                      <div key={d.id} className="p-2.5 flex items-center gap-2">
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium truncate">{d.item_name || '—'}</p>
                          <p className="text-[11px] text-muted-foreground truncate">
                            {dt(d.created_at, 'dd MMM yyyy HH:mm')}
                            {d.transaction_ref ? ` · ${d.transaction_ref}` : ''}
                          </p>
                        </div>
                        <div className="text-right shrink-0">
                          <p className="text-sm font-semibold tabular-nums text-success">
                            {formatUGX(Number(d.amount || 0))}
                          </p>
                          <p className="text-[11px] text-muted-foreground tabular-nums">
                            {formatUGX(Number(d.outstanding_after || 0))} left
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </div>
          </ScrollArea>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default AgentProductDetailDialog;
