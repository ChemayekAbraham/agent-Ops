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
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Loader2, Search } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';

interface Row {
  id: string;
  created_at: string;
  agent_id: string | null;
  tenant_id: string | null;
  landlord_name: string | null;
  allocated_amount: number;
  paid_out_amount: number;
  remaining_amount: number;
  status: string;
  funding_reference: string | null;
  agent_name: string;
  tenant_name: string;
}

const STATUS_TONE: Record<string, string> = {
  open: 'bg-amber-500/10 text-amber-600 border-amber-500/20',
  partially_paid: 'bg-blue-500/10 text-blue-600 border-blue-500/20',
  fully_paid: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20',
  cancelled: 'bg-muted text-muted-foreground border-border',
};

/**
 * Full history of landlord float funded by COMPANY money (CFO disbursements).
 * Every earmark ever created from company float, not just the open ones the
 * counter card totals.
 */
export function CompanyFloatDisbursementHistoryDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const [search, setSearch] = useState('');

  const { data, isLoading, error } = useQuery({
    queryKey: ['company-float-disbursement-history'],
    enabled: open,
    staleTime: 30_000,
    queryFn: async (): Promise<Row[]> => {
      const { data, error } = await supabase
        .from('agent_landlord_float_allocations' as any)
        .select(
          'id, created_at, agent_id, tenant_id, landlord_name, allocated_amount, paid_out_amount, remaining_amount, status, source, funding_reference',
        )
        .neq('source', 'partner_self_funding')
        .order('created_at', { ascending: false })
        .limit(1000);
      if (error) throw error;
      const rows = (data ?? []) as any[];
      const ids = [
        ...new Set(rows.flatMap((r) => [r.agent_id, r.tenant_id]).filter(Boolean)),
      ] as string[];
      let pmap = new Map<string, { full_name: string | null }>();
      if (ids.length) {
        const { data: profs } = await supabase.rpc('ops_get_profiles_lite', { p_ids: ids });
        pmap = new Map(((profs ?? []) as any[]).map((p) => [p.id, { full_name: p.full_name }]));
      }
      return rows.map((r) => ({
        ...r,
        allocated_amount: Number(r.allocated_amount) || 0,
        paid_out_amount: Number(r.paid_out_amount) || 0,
        remaining_amount: Number(r.remaining_amount) || 0,
        agent_name: (r.agent_id && pmap.get(r.agent_id)?.full_name) || 'Unknown agent',
        tenant_name: (r.tenant_id && pmap.get(r.tenant_id)?.full_name) || '—',
      })) as Row[];
    },
  });

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = data ?? [];
    if (!q) return list;
    return list.filter((r) =>
      `${r.agent_name} ${r.tenant_name} ${r.landlord_name ?? ''} ${r.funding_reference ?? ''}`
        .toLowerCase()
        .includes(q),
    );
  }, [data, search]);

  const totals = useMemo(
    () =>
      rows.reduce(
        (acc, r) => ({
          disbursed: acc.disbursed + r.allocated_amount,
          paid: acc.paid + r.paid_out_amount,
          remaining: acc.remaining + r.remaining_amount,
        }),
        { disbursed: 0, paid: 0, remaining: 0 },
      ),
    [rows],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Company float — CFO disbursement history</DialogTitle>
          <DialogDescription>
            Every landlord float earmark funded from company money, newest first. Shows the agent
            who received it, the landlord and tenant it was reserved for, and how much has been
            paid out since.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 sm:grid-cols-3">
          <Card>
            <CardContent className="p-3">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Total disbursed
              </p>
              <p className="font-mono tabular-nums text-base font-bold">
                {formatUGX(totals.disbursed)}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-3">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Paid to landlords
              </p>
              <p className="font-mono tabular-nums text-base font-bold text-emerald-600 dark:text-emerald-400">
                {formatUGX(totals.paid)}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-3">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Still held
              </p>
              <p className="font-mono tabular-nums text-base font-bold text-purple-600 dark:text-purple-400">
                {formatUGX(totals.remaining)}
              </p>
            </CardContent>
          </Card>
        </div>

        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search agent, landlord, tenant or reference"
            className="pl-8"
          />
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-10 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : error ? (
          <p className="text-sm text-destructive py-6">
            Could not load disbursement history: {(error as Error).message}
          </p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground py-6">No company float disbursements found.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-wider text-muted-foreground border-b">
                  <th className="py-2 pr-3">Disbursed</th>
                  <th className="py-2 pr-3">Agent</th>
                  <th className="py-2 pr-3">Landlord</th>
                  <th className="py-2 pr-3">Tenant</th>
                  <th className="py-2 pr-3 text-right">Amount</th>
                  <th className="py-2 pr-3 text-right">Paid out</th>
                  <th className="py-2 pr-3 text-right">Remaining</th>
                  <th className="py-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b last:border-0 align-top">
                    <td className="py-2 pr-3 whitespace-nowrap text-xs text-muted-foreground">
                      {new Date(r.created_at).toLocaleString('en-GB', {
                        day: '2-digit',
                        month: 'short',
                        year: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                      {r.funding_reference && (
                        <span className="block font-mono text-[10px]">{r.funding_reference}</span>
                      )}
                    </td>
                    <td className="py-2 pr-3">{r.agent_name}</td>
                    <td className="py-2 pr-3">{r.landlord_name || '—'}</td>
                    <td className="py-2 pr-3">{r.tenant_name}</td>
                    <td className="py-2 pr-3 text-right font-mono tabular-nums">
                      {formatUGX(r.allocated_amount)}
                    </td>
                    <td className="py-2 pr-3 text-right font-mono tabular-nums">
                      {formatUGX(r.paid_out_amount)}
                    </td>
                    <td className="py-2 pr-3 text-right font-mono tabular-nums">
                      {formatUGX(r.remaining_amount)}
                    </td>
                    <td className="py-2">
                      <Badge
                        variant="outline"
                        className={STATUS_TONE[r.status] ?? 'bg-muted text-muted-foreground'}
                      >
                        {r.status.replace(/_/g, ' ')}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
