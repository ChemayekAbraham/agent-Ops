import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Loader2, History } from 'lucide-react';
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
  const { data, isLoading, error } = useQuery({
    queryKey: ['landlord-float-allocations-detail', agentId],
    queryFn: async (): Promise<AllocationRow[]> => {
      const { data: rows, error } = await supabase
        .from('agent_landlord_float_allocations')
        .select(
          'id, tenant_id, landlord_id, landlord_name, landlord_phone, allocated_amount, paid_out_amount, remaining_amount, status, created_at',
        )
        .eq('agent_id', agentId)
        .order('created_at', { ascending: false })
        .limit(300);
      if (error) throw error;
      const list = (rows ?? []) as any[];

      const tenantIds = [...new Set(list.map((r) => r.tenant_id).filter(Boolean))] as string[];
      const landlordIds = [...new Set(list.map((r) => r.landlord_id).filter(Boolean))] as string[];

      const [tenantsRes, landlordsRes] = await Promise.all([
        tenantIds.length
          ? supabase.rpc('ops_get_profiles_lite', { p_ids: tenantIds })
          : Promise.resolve({ data: [] as any[] }),
        landlordIds.length
          ? supabase
              .from('landlords')
              .select('id, name, mobile_money_number, phone')
              .in('id', landlordIds)
          : Promise.resolve({ data: [] as any[] }),
      ]);

      const tenantById = new Map<string, string>(
        (((tenantsRes as any).data ?? []) as any[]).map((t) => [t.id, t.full_name]),
      );
      const landlordById = new Map<string, any>(
        (((landlordsRes as any).data ?? []) as any[]).map((l) => [l.id, l]),
      );

      return list.map((r) => {
        const live = r.landlord_id ? landlordById.get(r.landlord_id) : null;
        return {
          id: r.id,
          landlord_id: r.landlord_id ?? null,
          landlord_name: live?.name || r.landlord_name || 'Unknown landlord',
          landlord_phone: live?.mobile_money_number || live?.phone || r.landlord_phone || null,
          tenant_name: (r.tenant_id ? tenantById.get(r.tenant_id) : null) ?? 'Unassigned tenant',
          allocated_amount: Number(r.allocated_amount ?? 0),
          paid_out_amount: Number(r.paid_out_amount ?? 0),
          remaining_amount: Number(r.remaining_amount ?? 0),
          status: r.status ?? 'open',
          created_at: r.created_at,
        };
      });
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
  const rows = data ?? [];
  if (rows.length === 0) {
    return (
      <div className="px-4 py-4 text-xs text-muted-foreground bg-muted/20">
        No landlord earmarks recorded for this agent.
      </div>
    );
  }

  return (
    <div className="bg-muted/20 px-3 sm:px-4 py-3 space-y-2">
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
        Landlord earmarks — who the money is for and when it landed
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="py-1.5 pr-3 font-medium">Landlord</th>
              <th className="py-1.5 pr-3 font-medium">Tenant</th>
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
                <td className="py-2 pr-3 text-foreground">{r.tenant_name}</td>
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

      {historyFor && (
        <LandlordWithdrawalHistoryDialog
          open
          onOpenChange={(v) => !v && setHistoryFor(null)}
          landlordId={historyFor.id}
          landlordName={historyFor.name}
          landlordPhone={historyFor.phone}
        />
      )}
    </div>
  );
}
