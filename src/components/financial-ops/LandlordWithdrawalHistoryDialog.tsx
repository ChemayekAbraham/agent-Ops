import { useMemo, useState } from 'react';
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
import { ChevronDown, ChevronRight, Loader2, Receipt } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { TenantRepaymentBreakdownDialog } from './TenantRepaymentBreakdownDialog';

type PayoutRow = {
  id: string;
  agentId: string;
  agentName: string;
  tenantId: string | null;
  tenantName: string;
  amount: number;
  status: string;
  when: string | null;
  reference: string | null;
};

type AgentGroup = {
  agentId: string;
  agentName: string;
  total: number;
  rows: PayoutRow[];
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

async function loadLandlordHistory(landlordId: string): Promise<AgentGroup[]> {
  const { data, error } = await supabase
    .from('landlord_payouts')
    .select(
      'id, agent_id, tenant_id, amount, status, created_at, disbursed_at, finops_disbursed_at, receipt_number, finops_momo_reference',
    )
    .eq('landlord_id', landlordId)
    .order('created_at', { ascending: false })
    .limit(500);
  if (error) throw error;
  const list = (data ?? []) as any[];

  const ids = [
    ...new Set([
      ...list.map((r) => r.agent_id).filter(Boolean),
      ...list.map((r) => r.tenant_id).filter(Boolean),
    ]),
  ] as string[];

  const res = ids.length
    ? await supabase.rpc('ops_get_profiles_lite', { p_ids: ids })
    : { data: [] as any[] };
  const nameById = new Map<string, string>(
    (((res as any).data ?? []) as any[]).map((p) => [p.id, p.full_name ?? 'Unknown']),
  );

  const byAgent = new Map<string, AgentGroup>();
  for (const r of list) {
    const agentId = r.agent_id ?? 'none';
    const row: PayoutRow = {
      id: r.id,
      agentId,
      agentName: (r.agent_id ? nameById.get(r.agent_id) : null) ?? 'Unassigned agent',
      tenantId: r.tenant_id ?? null,
      tenantName: (r.tenant_id ? nameById.get(r.tenant_id) : null) ?? 'Unknown tenant',
      amount: Number(r.amount ?? 0),
      status: r.status ?? 'pending',
      when: r.finops_disbursed_at ?? r.disbursed_at ?? r.created_at ?? null,
      reference: r.finops_momo_reference ?? r.receipt_number ?? null,
    };
    let g = byAgent.get(agentId);
    if (!g) {
      g = { agentId, agentName: row.agentName, total: 0, rows: [] };
      byAgent.set(agentId, g);
    }
    g.total += row.amount;
    g.rows.push(row);
  }

  return [...byAgent.values()].sort((a, b) => b.total - a.total);
}

/**
 * Withdrawal history for ONE landlord: every payout an agent made on their
 * behalf, grouped by agent, with tenant, amount, status and exact date/time.
 * Opened by clicking a landlord name in the Landlord Float drilldown.
 */
export function LandlordWithdrawalHistoryDialog({
  open,
  onOpenChange,
  landlordId,
  landlordName,
  landlordPhone,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  landlordId: string;
  landlordName: string;
  landlordPhone?: string | null;
}) {
  const [openAgent, setOpenAgent] = useState<string | null>(null);
  const [tenantFor, setTenantFor] = useState<{
    id: string;
    name: string;
    agentId: string | null;
    agentName: string | null;
  } | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ['landlord-withdrawal-history', landlordId],
    queryFn: () => loadLandlordHistory(landlordId),
    enabled: open && !!landlordId,
    staleTime: 30_000,
  });

  const groups = data ?? [];
  const total = useMemo(() => groups.reduce((s, g) => s + g.total, 0), [groups]);
  const count = useMemo(() => groups.reduce((s, g) => s + g.rows.length, 0), [groups]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base font-bold tracking-tight">
            {landlordName} — withdrawal history
          </DialogTitle>
          <DialogDescription className="text-xs">
            {landlordPhone ? `${landlordPhone} • ` : ''}
            Withdrawals agents made on behalf of this landlord, with exact date and time.
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin inline mr-2" /> Loading withdrawals…
          </div>
        ) : error ? (
          <div className="py-8 text-center text-sm text-destructive">
            Could not load withdrawal history.
          </div>
        ) : groups.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            No withdrawals recorded for this landlord yet.
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center justify-between rounded-lg border border-border bg-muted/30 px-3 py-2">
              <p className="text-xs text-muted-foreground">
                {count} {count === 1 ? 'withdrawal' : 'withdrawals'} • {groups.length}{' '}
                {groups.length === 1 ? 'agent' : 'agents'}
              </p>
              <p className="font-mono tabular-nums text-sm font-bold text-primary">
                {formatUGX(total)}
              </p>
            </div>

            <div className="space-y-2">
              {groups.map((g) => {
                const isOpen = openAgent === g.agentId;
                return (
                  <div
                    key={g.agentId}
                    className="rounded-lg border border-border overflow-hidden bg-background"
                  >
                    <button
                      type="button"
                      onClick={() => setOpenAgent(isOpen ? null : g.agentId)}
                      className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-muted/40 transition-colors"
                    >
                      {isOpen ? (
                        <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                      ) : (
                        <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                      )}
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-semibold truncate">{g.agentName}</p>
                        <p className="text-[11px] text-muted-foreground">
                          {g.rows.length} {g.rows.length === 1 ? 'withdrawal' : 'withdrawals'}
                        </p>
                      </div>
                      <p className="font-mono tabular-nums text-xs font-bold shrink-0">
                        {formatUGX(g.total)}
                      </p>
                    </button>

                    {isOpen && (
                      <div className="overflow-x-auto border-t border-border">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="text-left text-muted-foreground bg-muted/30">
                              <th className="py-1.5 px-3 font-medium">Date & time</th>
                              <th className="py-1.5 px-3 font-medium">Tenant</th>
                              <th className="py-1.5 px-3 font-medium text-right">Amount</th>
                              <th className="py-1.5 px-3 font-medium">Status</th>
                              <th className="py-1.5 px-3 font-medium">Reference</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-border/60">
                            {g.rows.map((r) => (
                              <tr key={r.id}>
                                <td className="py-2 px-3 whitespace-nowrap text-foreground">
                                  {fmtWhen(r.when)}
                                </td>
                                <td className="py-2 px-3">
                                  {r.tenantId ? (
                                    <button
                                      type="button"
                                      onClick={() =>
                                        setTenantFor({
                                          id: r.tenantId as string,
                                          name: r.tenantName,
                                          agentId: r.agentId === 'none' ? null : r.agentId,
                                          agentName: r.agentName,
                                        })
                                      }
                                      className="font-semibold text-primary hover:underline inline-flex items-center gap-1 text-left"
                                      title="View this tenant's repayment breakdown"
                                    >
                                      {r.tenantName}
                                      <Receipt className="h-3 w-3 opacity-70" />
                                    </button>
                                  ) : (
                                    r.tenantName
                                  )}
                                </td>
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

        {tenantFor && (
          <TenantRepaymentBreakdownDialog
            open
            onOpenChange={(v) => !v && setTenantFor(null)}
            tenantId={tenantFor.id}
            tenantName={tenantFor.name}
            focusAgentId={tenantFor.agentId}
            focusAgentName={tenantFor.agentName}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
