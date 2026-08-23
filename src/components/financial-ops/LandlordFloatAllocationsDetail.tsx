import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Loader2, History, Receipt } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { LandlordWithdrawalHistoryDialog } from './LandlordWithdrawalHistoryDialog';
import { TenantRepaymentBreakdownDialog } from './TenantRepaymentBreakdownDialog';

type AllocationRow = {
  landlord_id: string | null;
  id: string;
  landlord_name: string;
  landlord_phone: string | null;
  tenant_id: string | null;
  tenant_name: string;
  allocated_amount: number;
  paid_out_amount: number;
  remaining_amount: number;
  status: string;
  created_at: string;
  funder_id: string | null;
  funder_name: string | null;
  proxy_agent_name: string | null;
  proxy_is_managed: boolean;
};

type ReceivableRow = {
  id: string;
  landlord_name: string;
  tenant_id: string | null;
  tenant_name: string;
  funder_id: string | null;
  funder_name: string | null;
  amount: number;
  promised_deposit_date: string | null;
  status: string;
  created_at: string;
};

/**
 * Per-tenant breakdown of a single agent's landlord float:
 * which landlord the money is earmarked for, which tenant it belongs to,
 * how much, and when it was disbursed into that agent's wallet.
 */
export function LandlordFloatAllocationsDetail({ agentId }: { agentId: string }) {
  const [historyFor, setHistoryFor] = useState<{
    id: string;
    name: string;
    phone: string | null;
  } | null>(null);
  const [tenantFor, setTenantFor] = useState<{ id: string; name: string } | null>(null);
  const { data, isLoading, error } = useQuery({
    queryKey: ['landlord-float-allocations-detail', agentId],
    queryFn: async (): Promise<{ allocations: AllocationRow[]; receivables: ReceivableRow[] }> => {
      const [allocRes, recvRes] = await Promise.all([
        supabase
          .from('agent_landlord_float_allocations')
          .select(
            'id, tenant_id, landlord_id, landlord_name, landlord_phone, allocated_amount, paid_out_amount, remaining_amount, status, created_at, funded_by_partner_id',
          )
          .eq('agent_id', agentId)
          .order('created_at', { ascending: false })
          .limit(300),
        supabase
          .from('landlord_float_receivables')
          .select(
            'id, landlord_name, tenant_id, funder_id, amount, promised_deposit_date, status, created_at',
          )
          .eq('agent_id', agentId)
          .order('created_at', { ascending: false })
          .limit(200),
      ]);
      if (allocRes.error) throw allocRes.error;
      const list = (allocRes.data ?? []) as any[];
      const recvList = (recvRes.error ? [] : ((recvRes.data ?? []) as any[])) as any[];

      const tenantIds = [
        ...new Set([...list, ...recvList].map((r) => r.tenant_id).filter(Boolean)),
      ] as string[];
      const landlordIds = [...new Set(list.map((r) => r.landlord_id).filter(Boolean))] as string[];
      const funderIds = [
        ...new Set([
          ...list.map((r) => r.funded_by_partner_id).filter(Boolean),
          ...recvList.map((r) => r.funder_id).filter(Boolean),
        ]),
      ] as string[];

      const [tenantsRes, landlordsRes, fundersRes, proxyRes] = await Promise.all([
        tenantIds.length
          ? supabase.rpc('ops_get_profiles_lite', { p_ids: tenantIds })
          : Promise.resolve({ data: [] as any[] }),
        landlordIds.length
          ? supabase
              .from('landlords')
              .select('id, name, mobile_money_number, phone')
              .in('id', landlordIds)
          : Promise.resolve({ data: [] as any[] }),
        funderIds.length
          ? supabase.rpc('ops_get_profiles_lite', { p_ids: funderIds })
          : Promise.resolve({ data: [] as any[] }),
        funderIds.length
          ? supabase
              .from('proxy_agent_assignments')
              .select('beneficiary_id, agent_id, is_managed_account, created_at')
              .in('beneficiary_id', funderIds)
              .eq('is_active', true)
              .eq('approval_status', 'approved')
              .order('is_managed_account', { ascending: false })
              .order('created_at', { ascending: false })
          : Promise.resolve({ data: [] as any[] }),
      ]);

      const tenantById = new Map<string, string>(
        (((tenantsRes as any).data ?? []) as any[]).map((t) => [t.id, t.full_name]),
      );
      const landlordById = new Map<string, any>(
        (((landlordsRes as any).data ?? []) as any[]).map((l) => [l.id, l]),
      );
      const funderById = new Map<string, string>(
        (((fundersRes as any).data ?? []) as any[]).map((f) => [f.id, f.full_name]),
      );

      // Live proxy link per funder: managed rows first, newest first (mirrors
      // the server rule) — a stale row must never shadow the live managed link.
      const proxyByFunder = new Map<string, { agent_id: string; is_managed: boolean }>();
      for (const row of (((proxyRes as any).data ?? []) as any[])) {
        if (!proxyByFunder.has(row.beneficiary_id)) {
          proxyByFunder.set(row.beneficiary_id, {
            agent_id: row.agent_id,
            is_managed: !!row.is_managed_account,
          });
        }
      }
      const proxyAgentIds = [...new Set([...proxyByFunder.values()].map((p) => p.agent_id))];
      const proxyNamesRes = proxyAgentIds.length
        ? await supabase.rpc('ops_get_profiles_lite', { p_ids: proxyAgentIds })
        : { data: [] as any[] };
      const proxyNameById = new Map<string, string>(
        (((proxyNamesRes as any).data ?? []) as any[]).map((p) => [p.id, p.full_name]),
      );

      const allocations: AllocationRow[] = list.map((r) => {
        const live = r.landlord_id ? landlordById.get(r.landlord_id) : null;
        const funderId = r.funded_by_partner_id ?? null;
        const proxy = funderId ? proxyByFunder.get(funderId) : null;
        return {
          id: r.id,
          landlord_id: r.landlord_id ?? null,
          landlord_name: live?.name || r.landlord_name || 'Unknown landlord',
          landlord_phone: live?.mobile_money_number || live?.phone || r.landlord_phone || null,
          tenant_id: r.tenant_id ?? null,
          tenant_name: (r.tenant_id ? tenantById.get(r.tenant_id) : null) ?? 'Unassigned tenant',
          allocated_amount: Number(r.allocated_amount ?? 0),
          paid_out_amount: Number(r.paid_out_amount ?? 0),
          remaining_amount: Number(r.remaining_amount ?? 0),
          status: r.status ?? 'open',
          created_at: r.created_at,
          funder_id: funderId,
          funder_name: funderId ? (funderById.get(funderId) ?? null) : null,
          proxy_agent_name: proxy ? (proxyNameById.get(proxy.agent_id) ?? 'Proxy agent') : null,
          proxy_is_managed: !!proxy?.is_managed,
        };
      });

      const receivables: ReceivableRow[] = recvList.map((r) => ({
        id: r.id,
        landlord_name: r.landlord_name || 'Unknown landlord',
        tenant_id: r.tenant_id ?? null,
        tenant_name: (r.tenant_id ? tenantById.get(r.tenant_id) : null) ?? 'Unassigned tenant',
        funder_id: r.funder_id ?? null,
        funder_name: r.funder_id ? (funderById.get(r.funder_id) ?? null) : null,
        amount: Number(r.amount ?? 0),
        promised_deposit_date: r.promised_deposit_date ?? null,
        status: r.status ?? 'pending',
        created_at: r.created_at,
      }));

      return { allocations, receivables };
    },
    staleTime: 30_000,
  });

  if (isLoading) {
    return (
      <div className="px-4 py-4 text-xs text-muted-foreground bg-muted/20">
        <Loader2 className="h-3.5 w-3.5 animate-spin inline mr-2" /> Loading landlord earmarks…
      </div>
    );
  }
  if (error) {
    return (
      <div className="px-4 py-4 text-xs text-destructive bg-muted/20">
        Could not load landlord earmarks.
      </div>
    );
  }
  const rows = data?.allocations ?? [];
  const receivables = data?.receivables ?? [];
  const receivableTotal = receivables
    .filter((r) => r.status !== 'settled' && r.status !== 'cancelled')
    .reduce((sum, r) => sum + r.amount, 0);
  if (rows.length === 0 && receivables.length === 0) {
    return (
      <div className="px-4 py-4 text-xs text-muted-foreground bg-muted/20">
        No landlord earmarks recorded for this agent.
      </div>
    );
  }

  return (
    <div className="bg-muted/20 px-3 sm:px-4 py-3 space-y-4">
      <div className="space-y-2">
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
        Landlord earmarks — who the money is for and when it landed
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="py-1.5 pr-3 font-medium">Landlord</th>
              <th className="py-1.5 pr-3 font-medium">Tenant</th>
              <th className="py-1.5 pr-3 font-medium">Funder</th>
              <th className="py-1.5 pr-3 font-medium">Proxy agent</th>
              <th className="py-1.5 pr-3 font-medium text-right">Amount</th>
              <th className="py-1.5 pr-3 font-medium text-right">Remaining</th>
              <th className="py-1.5 font-medium">Disbursed</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/60">
            {rows.map((r) => (
              <tr key={r.id} className="align-top">
                <td className="py-2 pr-3">
                  {r.landlord_id ? (
                    <button
                      type="button"
                      onClick={() =>
                        setHistoryFor({
                          id: r.landlord_id as string,
                          name: r.landlord_name,
                          phone: r.landlord_phone,
                        })
                      }
                      className="font-semibold text-primary hover:underline inline-flex items-center gap-1 text-left"
                      title="View withdrawal history for this landlord"
                    >
                      {r.landlord_name}
                      <History className="h-3 w-3 opacity-70" />
                    </button>
                  ) : (
                    <p className="font-semibold text-foreground">{r.landlord_name}</p>
                  )}
                  <p className="text-muted-foreground">{r.landlord_phone || '—'}</p>
                </td>
                <td className="py-2 pr-3 text-foreground">
                  {r.tenant_id ? (
                    <button
                      type="button"
                      onClick={() =>
                        setTenantFor({ id: r.tenant_id as string, name: r.tenant_name })
                      }
                      className="font-semibold text-primary hover:underline inline-flex items-center gap-1 text-left"
                      title="View this tenant's repayment breakdown"
                    >
                      {r.tenant_name}
                      <Receipt className="h-3 w-3 opacity-70" />
                    </button>
                  ) : (
                    r.tenant_name
                  )}
                </td>
                <td className="py-2 pr-3">
                  {r.funder_name ? (
                    <span className="text-foreground">{r.funder_name}</span>
                  ) : (
                    <span className="text-muted-foreground">Company float</span>
                  )}
                </td>
                <td className="py-2 pr-3">
                  {r.proxy_agent_name ? (
                    <span className="text-foreground">
                      {r.proxy_agent_name}
                      {r.proxy_is_managed && (
                        <span className="block text-[10px] text-muted-foreground">
                          Managed account
                        </span>
                      )}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
                <td className="py-2 pr-3 text-right font-mono tabular-nums">
                  {formatUGX(r.allocated_amount)}
                </td>
                <td className="py-2 pr-3 text-right font-mono tabular-nums font-semibold">
                  {formatUGX(r.remaining_amount)}
                </td>
                <td className="py-2 text-muted-foreground whitespace-nowrap">
                  {new Date(r.created_at).toLocaleString('en-GB', {
                    day: '2-digit',
                    month: 'short',
                    year: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                  <span className="block capitalize">{r.status.replace(/_/g, ' ')}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      </div>

      <div className="space-y-2 border-t border-border/60 pt-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
            Landlord float receivable — funder pledges not yet deposited
          </p>
          {receivableTotal > 0 && (
            <span className="text-xs font-semibold font-mono tabular-nums text-amber-600 dark:text-amber-400">
              {formatUGX(receivableTotal)} outstanding
            </span>
          )}
        </div>
        {receivables.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No receivable pledges on this agent's landlord float.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="py-1.5 pr-3 font-medium">Landlord</th>
                  <th className="py-1.5 pr-3 font-medium">Tenant</th>
                  <th className="py-1.5 pr-3 font-medium">Funder</th>
                  <th className="py-1.5 pr-3 font-medium text-right">Amount</th>
                  <th className="py-1.5 pr-3 font-medium">Promised deposit</th>
                  <th className="py-1.5 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {receivables.map((r) => (
                  <tr key={r.id} className="align-top">
                    <td className="py-2 pr-3 font-semibold text-foreground">{r.landlord_name}</td>
                    <td className="py-2 pr-3">
                      {r.tenant_id ? (
                        <button
                          type="button"
                          onClick={() =>
                            setTenantFor({ id: r.tenant_id as string, name: r.tenant_name })
                          }
                          className="font-semibold text-primary hover:underline inline-flex items-center gap-1 text-left"
                          title="View this tenant's repayment breakdown"
                        >
                          {r.tenant_name}
                          <Receipt className="h-3 w-3 opacity-70" />
                        </button>
                      ) : (
                        r.tenant_name
                      )}
                    </td>
                    <td className="py-2 pr-3 text-foreground">{r.funder_name || 'Unknown funder'}</td>
                    <td className="py-2 pr-3 text-right font-mono tabular-nums font-semibold">
                      {formatUGX(r.amount)}
                    </td>
                    <td className="py-2 pr-3 whitespace-nowrap">
                      {r.promised_deposit_date
                        ? new Date(r.promised_deposit_date).toLocaleDateString('en-GB', {
                            day: '2-digit',
                            month: 'short',
                            year: 'numeric',
                          })
                        : '—'}
                    </td>
                    <td className="py-2 capitalize text-muted-foreground">
                      {r.status.replace(/_/g, ' ')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {historyFor && (
        <LandlordWithdrawalHistoryDialog
          open
          onOpenChange={(v) => !v && setHistoryFor(null)}
          landlordId={historyFor.id}
          landlordName={historyFor.name}
          landlordPhone={historyFor.phone}
        />
      )}

      {tenantFor && (
        <TenantRepaymentBreakdownDialog
          open
          onOpenChange={(v) => !v && setTenantFor(null)}
          tenantId={tenantFor.id}
          tenantName={tenantFor.name}
          focusAgentId={agentId}
        />
      )}
    </div>
  );
}
