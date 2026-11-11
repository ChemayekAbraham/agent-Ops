import { useQuery } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { formatDynamic } from '@/lib/currencyFormat';

type ReleasedRow = {
  rent_request_id: string;
  plan_label: string;
  amount: number;
  agent_name: string;
  landlord_name: string;
  allocation_status: string;
  flags: string[] | null;
};

function isMissingRpc(error: unknown): boolean {
  const blob = `${(error as { code?: string; message?: string })?.code ?? ''} ${(error as { message?: string })?.message ?? ''}`.toLowerCase();
  return blob.includes('pgrst202') || blob.includes('could not find the function') || blob.includes('42883');
}

/**
 * Read-only list from cfo_partner_released_today. The server decides who may
 * see it and which rows count. This panel does not recompute the day or the flags.
 */
export function PartnerReleasedToday() {
  const query = useQuery({
    queryKey: ['cfo-partner-released-today'],
    queryFn: async (): Promise<ReleasedRow[]> => {
      const { data, error } = await supabase.rpc('cfo_partner_released_today');
      if (error) throw error;
      return (data ?? []) as ReleasedRow[];
    },
    staleTime: 30_000,
    retry: false,
  });

  return (
    <section className="rounded-2xl border border-border bg-card p-4 shadow-2xs space-y-3">
      <div>
        <h2 className="text-sm font-semibold">Released by partners today</h2>
        <p className="text-xs text-muted-foreground">
          Rent that partners released straight to an agent today. The agent pays the landlord within 24 hours.
        </p>
      </div>
      {query.isLoading ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading
        </p>
      ) : query.isError ? (
        <p className="text-xs text-muted-foreground">
          {isMissingRpc(query.error) ? 'This report is not available yet.' : 'This report could not be loaded.'}
        </p>
      ) : (query.data ?? []).length === 0 ? (
        <p className="text-xs text-muted-foreground">No partner releases today.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b text-muted-foreground">
                <th className="py-2 pr-3 font-medium">Plan</th>
                <th className="py-2 pr-3 font-medium">Amount</th>
                <th className="py-2 pr-3 font-medium">Agent</th>
                <th className="py-2 pr-3 font-medium">Landlord</th>
                <th className="py-2 pr-3 font-medium">Status</th>
                <th className="py-2 font-medium">Flags</th>
              </tr>
            </thead>
            <tbody>
              {(query.data ?? []).map((row) => (
                <tr key={row.rent_request_id} className="border-b border-border/60">
                  <td className="py-2 pr-3">{row.plan_label}</td>
                  <td className="py-2 pr-3 whitespace-nowrap">{formatDynamic(Number(row.amount || 0))}</td>
                  <td className="py-2 pr-3">{row.agent_name}</td>
                  <td className="py-2 pr-3">{row.landlord_name}</td>
                  <td className="py-2 pr-3">{row.allocation_status}</td>
                  <td className="py-2">{(row.flags ?? []).length > 0 ? (row.flags ?? []).join(', ') : 'None'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
