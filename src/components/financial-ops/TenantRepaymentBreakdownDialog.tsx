import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Loader2 } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';

type Collection = {
  id: string;
  agent_id: string | null;
  agentName: string;
  amount: number;
  method: string;
  created_at: string;
  notes: string | null;
  isAllocation: boolean;
  isReversed: boolean;
};

type Plan = {
  id: string;
  rent_amount: number;
  daily_repayment: number;
  total_repayment: number;
  status: string;
  started_at: string | null;
};

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

async function loadTenantBreakdown(tenantId: string) {
  const [plansRes, colsRes] = await Promise.all([
    supabase
      .from('rent_requests')
      .select(
        'id, rent_amount, daily_repayment, total_repayment, amount_repaid, status, disbursed_at, created_at',
      )
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false })
      .limit(50),
    supabase
      .from('agent_collections')
      .select('id, agent_id, amount, payment_method, created_at, notes').is('reversed_at', null)
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false })
      .limit(500),
  ]);
  if (plansRes.error) throw plansRes.error;
  if (colsRes.error) throw colsRes.error;

  const rawCols = (colsRes.data ?? []) as any[];
  const agentIds = [...new Set(rawCols.map((r) => r.agent_id).filter(Boolean))] as string[];
  const namesRes = agentIds.length
    ? await supabase.rpc('ops_get_profiles_lite', { p_ids: agentIds })
    : { data: [] as any[] };
  const nameById = new Map<string, string>(
    (((namesRes as any).data ?? []) as any[]).map((p) => [p.id, p.full_name ?? 'Unknown agent']),
  );

  const collections: Collection[] = rawCols.map((r) => {
    const notes = String(r.notes ?? '');
    return {
      id: r.id,
      agent_id: r.agent_id ?? null,
      agentName: (r.agent_id ? nameById.get(r.agent_id) : null) ?? 'Unassigned agent',
      amount: Number(r.amount ?? 0),
      method: String(r.payment_method ?? 'cash'),
      created_at: r.created_at,
      notes: r.notes ?? null,
      isAllocation: /float allocation/i.test(notes),
      isReversed: /\[reversed/i.test(notes),
    };
  });

  const plans: Plan[] = ((plansRes.data ?? []) as any[]).map((p) => ({
    id: p.id,
    rent_amount: Number(p.rent_amount ?? 0),
    daily_repayment: Number(p.daily_repayment ?? 0),
    total_repayment: Number(p.total_repayment ?? 0),
    status: p.status ?? 'pending',
    started_at: p.disbursed_at ?? p.created_at ?? null,
  }));

  return { plans, collections };
}

/**
 * Repayment breakdown for ONE tenant, seen from the agent-allocation angle:
 * every collection/allocation an agent recorded against the tenant, plus the
 * tenant's rent plan totals. Opened by clicking a tenant name inside the
 * Landlord Float drilldown or a landlord withdrawal history.
 */
export function TenantRepaymentBreakdownDialog({
  open,
  onOpenChange,
  tenantId,
  tenantName,
  focusAgentId,
  focusAgentName,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  tenantId: string;
  tenantName: string;
  focusAgentId?: string | null;
  focusAgentName?: string | null;
}) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['tenant-repayment-breakdown', tenantId],
    queryFn: () => loadTenantBreakdown(tenantId),
    enabled: open && !!tenantId,
    staleTime: 30_000,
  });

  const collections = data?.collections ?? [];
  const plans = data?.plans ?? [];

  const totals = useMemo(() => {
    const live = collections.filter((c) => !c.isReversed);
    const repaid = live.reduce((s, c) => s + c.amount, 0);
    const byFocus = focusAgentId
      ? live.filter((c) => c.agent_id === focusAgentId).reduce((s, c) => s + c.amount, 0)
      : 0;
    const expected = plans.reduce((s, p) => s + p.total_repayment, 0);
    return { repaid, byFocus, expected, outstanding: Math.max(0, expected - repaid) };
  }, [collections, plans, focusAgentId]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base font-bold tracking-tight">
            {tenantName} — repayment breakdown
          </DialogTitle>
          <DialogDescription className="text-xs">
            Every payment an agent allocated for this tenant, with date, time, method and the agent
            who recorded it.
            {focusAgentName ? ` Highlighted: ${focusAgentName}.` : ''}
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin inline mr-2" /> Loading repayments…
          </div>
        ) : error ? (
          <div className="py-8 text-center text-sm text-destructive">
            Could not load repayment breakdown.
          </div>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {[
                { label: 'Total repaid', value: totals.repaid },
                { label: 'Expected total', value: totals.expected },
                { label: 'Outstanding', value: totals.outstanding },
                ...(focusAgentId
                  ? [{ label: 'By this agent', value: totals.byFocus }]
                  : [{ label: 'Payments', value: null as number | null }]),
              ].map((c) => (
                <div key={c.label} className="rounded-lg border border-border bg-muted/30 px-3 py-2">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    {c.label}
                  </p>
                  <p className="font-mono tabular-nums text-sm font-bold">
                    {c.value === null
                      ? collections.filter((x) => !x.isReversed).length
                      : formatUGX(c.value)}
                  </p>
                </div>
              ))}
            </div>

            {plans.length > 0 && (
              <div className="rounded-lg border border-border overflow-hidden">
                <p className="px-3 py-2 text-[10px] uppercase tracking-wider text-muted-foreground bg-muted/30">
                  Rent plans
                </p>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-left text-muted-foreground">
                        <th className="py-1.5 px-3 font-medium">Started</th>
                        <th className="py-1.5 px-3 font-medium text-right">Rent</th>
                        <th className="py-1.5 px-3 font-medium text-right">Daily</th>
                        <th className="py-1.5 px-3 font-medium text-right">Total due</th>
                        <th className="py-1.5 px-3 font-medium">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border/60">
                      {plans.map((p) => (
                        <tr key={p.id}>
                          <td className="py-2 px-3 whitespace-nowrap">{fmtWhen(p.started_at)}</td>
                          <td className="py-2 px-3 text-right font-mono tabular-nums">
                            {formatUGX(p.rent_amount)}
                          </td>
                          <td className="py-2 px-3 text-right font-mono tabular-nums">
                            {formatUGX(p.daily_repayment)}
                          </td>
                          <td className="py-2 px-3 text-right font-mono tabular-nums font-semibold">
                            {formatUGX(p.total_repayment)}
                          </td>
                          <td className="py-2 px-3 capitalize text-muted-foreground">
                            {p.status.replace(/_/g, ' ')}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            <div className="rounded-lg border border-border overflow-hidden">
              <p className="px-3 py-2 text-[10px] uppercase tracking-wider text-muted-foreground bg-muted/30">
                Agent allocations & collections
              </p>
              {collections.length === 0 ? (
                <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                  No payments recorded for this tenant yet.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-left text-muted-foreground">
                        <th className="py-1.5 px-3 font-medium">Date & time</th>
                        <th className="py-1.5 px-3 font-medium">Agent</th>
                        <th className="py-1.5 px-3 font-medium text-right">Amount</th>
                        <th className="py-1.5 px-3 font-medium">Type</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border/60">
                      {collections.map((c) => (
                        <tr
                          key={c.id}
                          className={
                            focusAgentId && c.agent_id === focusAgentId ? 'bg-primary/5' : undefined
                          }
                        >
                          <td className="py-2 px-3 whitespace-nowrap text-foreground">
                            {fmtWhen(c.created_at)}
                          </td>
                          <td className="py-2 px-3">{c.agentName}</td>
                          <td
                            className={`py-2 px-3 text-right font-mono tabular-nums font-semibold ${
                              c.isReversed ? 'line-through text-muted-foreground' : ''
                            }`}
                          >
                            {formatUGX(c.amount)}
                          </td>
                          <td className="py-2 px-3">
                            <div className="flex flex-wrap items-center gap-1">
                              <Badge variant="outline" className="text-[10px] capitalize">
                                {c.isAllocation ? 'Float allocation' : c.method.replace(/_/g, ' ')}
                              </Badge>
                              {c.isReversed && (
                                <Badge
                                  variant="outline"
                                  className="text-[10px] bg-destructive/10 text-destructive border-destructive/20"
                                >
                                  Reversed
                                </Badge>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
