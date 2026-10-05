import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { History, Sparkles } from 'lucide-react';

interface Props {
  tenantId: string | null | undefined;
  /** Current request under review — excluded from the history list. */
  currentRequestId?: string | null;
}

interface PriorPlan {
  id: string;
  rent_amount: number | null;
  total_repayment: number | null;
  amount_repaid: number | null;
  daily_repayment: number | null;
  status: string | null;
  created_at: string;
}

const ugx = (n: number) => `UGX ${Math.round(n || 0).toLocaleString()}`;

/**
 * Read-only context strip for the officer's rent-request review sheet.
 * Surfaces the tenant's existing rent plans and how much they have repaid,
 * or flags them as a brand-new tenant. No business logic, no writes.
 */
export function TenantPaymentHistoryCard({ tenantId, currentRequestId }: Props) {
  const { data, isLoading } = useQuery({
    queryKey: ['tenant-payment-history', tenantId, currentRequestId],
    enabled: !!tenantId,
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('rent_requests')
        .select('id, rent_amount, total_repayment, amount_repaid, daily_repayment, status, created_at')
        .eq('tenant_id', tenantId as string)
        .order('created_at', { ascending: false })
        .limit(20);
      if (error) throw error;
      return ((data || []) as PriorPlan[]).filter(r => r.id !== currentRequestId);
    },
  });

  if (!tenantId) return null;

  if (isLoading) {
    return <Skeleton className="h-20 w-full rounded-xl" />;
  }

  const plans = data || [];
  const settled = plans.filter(p => p.status && ['funded', 'repaying', 'completed', 'closed'].includes(p.status));
  const totalRepaid = plans.reduce((s, p) => s + (Number(p.amount_repaid) || 0), 0);
  const totalObligation = settled.reduce((s, p) => s + (Number(p.total_repayment) || 0), 0);
  const outstanding = Math.max(totalObligation - totalRepaid, 0);
  const isNew = plans.length === 0;

  if (isNew) {
    return (
      <div className="rounded-xl border-2 border-blue-500/30 bg-blue-500/5 p-3 flex items-start gap-2">
        <Sparkles className="h-4 w-4 text-blue-600 mt-0.5 shrink-0" />
        <div className="text-xs">
          <p className="font-bold text-blue-800 dark:text-blue-300">New Tenant</p>
          <p className="text-muted-foreground mt-0.5">
            No previous rent plans or payment history on the platform.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border bg-muted/30 p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-sm font-semibold flex items-center gap-1.5">
          <History className="h-4 w-4 text-primary" />
          Tenant Payment History
        </h4>
        <Badge variant="secondary" className="text-[10px]">
          Existing tenant · {plans.length} previous {plans.length === 1 ? 'plan' : 'plans'}
        </Badge>
      </div>

      <div className="grid grid-cols-3 gap-2 text-center">
        <div className="rounded-lg bg-card border p-2">
          <p className="text-[10px] text-muted-foreground">Total Repaid</p>
          <p className="text-sm font-bold text-emerald-600">{ugx(totalRepaid)}</p>
        </div>
        <div className="rounded-lg bg-card border p-2">
          <p className="text-[10px] text-muted-foreground">Total Obligation</p>
          <p className="text-sm font-bold">{ugx(totalObligation)}</p>
        </div>
        <div className="rounded-lg bg-card border p-2">
          <p className="text-[10px] text-muted-foreground">Outstanding</p>
          <p className={`text-sm font-bold ${outstanding > 0 ? 'text-amber-600' : 'text-muted-foreground'}`}>
            {ugx(outstanding)}
          </p>
        </div>
      </div>

      <div className="space-y-1">
        {plans.slice(0, 5).map(p => (
          <div key={p.id} className="flex items-center justify-between gap-2 text-xs rounded-lg bg-card border px-2 py-1.5">
            <div className="min-w-0">
              <p className="font-medium truncate">{ugx(Number(p.rent_amount) || 0)} rent</p>
              <p className="text-[10px] text-muted-foreground">
                {new Date(p.created_at).toLocaleDateString()} · {(p.status || 'unknown').replace(/_/g, ' ')}
              </p>
            </div>
            <div className="text-right shrink-0">
              <p className="font-semibold text-emerald-600">{ugx(Number(p.amount_repaid) || 0)}</p>
              <p className="text-[10px] text-muted-foreground">repaid of {ugx(Number(p.total_repayment) || 0)}</p>
            </div>
          </div>
        ))}
        {plans.length > 5 && (
          <p className="text-[10px] text-muted-foreground text-center">
            +{plans.length - 5} older {plans.length - 5 === 1 ? 'plan' : 'plans'}
          </p>
        )}
      </div>
    </div>
  );
}

export default TenantPaymentHistoryCard;
