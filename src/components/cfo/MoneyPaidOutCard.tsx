import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { HeroCard } from '@/components/cfo/HeroCard';
import { formatUGX } from '@/lib/creditFeeCalculations';
import { ArrowUpRight } from 'lucide-react';

type Row = {
  total_paid: number; total_count: number; today_paid: number; today_count: number;
  month_paid: number; month_count: number; pending_amount: number; pending_count: number;
};

/** Actual external payouts (completed/paid withdrawals). Read-only. */
export function MoneyPaidOutCard() {
  const q = useQuery({
    queryKey: ['cfo-money-paid-out'],
    queryFn: async () => {
      const { data, error } = await (supabase.rpc as any)('get_cfo_money_paid_out');
      if (error) throw error;
      return ((data ?? [])[0] ?? null) as Row | null;
    },
    refetchInterval: 60000,
  });
  const d = q.data;
  const n = (v?: number) => Number(v ?? 0);
  return (
    <HeroCard
      icon={<ArrowUpRight className="h-5 w-5 text-rose-50" />}
      iconBg="bg-rose-600"
      title="Money Paid Out"
      value={q.isLoading || q.error || !d ? '—' : formatUGX(n(d.total_paid))}
      percentageLabel="Completed payouts to mobile money, bank & cash"
      items={d ? [
        { dot: 'bg-rose-500', label: `Paid out today (${n(d.today_count).toLocaleString()})`, value: formatUGX(n(d.today_paid)) },
        { dot: 'bg-rose-400', label: `Paid out this month (${n(d.month_count).toLocaleString()})`, value: formatUGX(n(d.month_paid)) },
        { dot: 'bg-slate-400', label: 'Number of payouts', value: n(d.total_count).toLocaleString() },
        { dot: 'bg-amber-500', label: `Pending payouts (${n(d.pending_count).toLocaleString()})`, value: formatUGX(n(d.pending_amount)) },
      ] : []}
      footer={q.error ? 'Could not load payouts' : 'Excludes wallet credits and internal transfers'}
    />
  );
}
