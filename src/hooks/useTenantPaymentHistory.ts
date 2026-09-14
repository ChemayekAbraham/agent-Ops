import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export interface TenantPaymentEntry {
  id: string;
  type: 'credit' | 'debit';
  amount: number;
  label: string;
  date: string;
  status?: 'completed' | 'pending' | 'failed';
}

/**
 * The signed-in tenant's own rent payment history (server-side, self only).
 * Read-only — no wallet or ledger writes happen here.
 */
export function useTenantPaymentHistory(limit = 20) {
  return useQuery<TenantPaymentEntry[]>({
    queryKey: ['tenant-payment-history', limit],
    staleTime: 30_000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('tenant_payment_history' as any, {
        p_limit: limit,
      });
      if (error) throw error;
      const rows: any[] = Array.isArray(data) ? data : [];
      return rows.map((r) => ({
        id: String(r.id),
        type: 'debit' as const,
        amount: Number(r.amount) || 0,
        label: r.method || 'Rent payment',
        date: r.paid_at,
        status: 'completed' as const,
      }));
    },
  });
}
