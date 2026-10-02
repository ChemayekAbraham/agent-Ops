import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { HeroCard } from '@/components/cfo/HeroCard';
import { formatUGX } from '@/lib/creditFeeCalculations';
import { ArrowUpRight } from 'lucide-react';
import { useState } from 'react';
import { allTime, kampalaDate, monthStart, type DrilldownPreset } from '@/components/cfo/MoneyDrilldownReport';
import { MoneyPaidOutReport } from '@/components/cfo/MoneyPaidOutReport';
type Row = {
  total_paid: number; total_count: number; today_paid: number; today_count: number;
  month_paid: number; month_count: number; pending_amount: number; pending_count: number;
};

/** Actual external payouts (completed/paid withdrawals). Read-only. */
export function MoneyPaidOutCard({ moneyWeHaveTotal }: { moneyWeHaveTotal: number }) {
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
  const [report, setReport] = useState(false);
  const [preset, setPreset] = useState<DrilldownPreset | null>(null);
  const conf = 'confirmed';
  const drill = (p: DrilldownPreset | null) => { setPreset(p); setReport(true); };
  const n = (v?: number) => Number(v ?? 0);
  const daysAgo = (k: number) => { const dt = new Date(); dt.setDate(dt.getDate() - k); return kampalaDate(dt); };
  const total = () => d && drill({ label: 'All time', ...allTime(), status: conf, expected: { amount: n(d.total_paid), count: n(d.total_count), basis: 'confirmed' } });
  return (
    <>
    <HeroCard


      icon={<ArrowUpRight className="h-5 w-5" />}
      tone="destructive"
      title="Money Paid Out"
      value={q.isLoading || q.error || !d ? '—' : formatUGX(n(d.total_paid))}
      percentageLabel={q.isLoading || q.error || !d || moneyWeHaveTotal <= 0
        ? '—'
        : `${((n(d.total_paid) / moneyWeHaveTotal) * 100).toFixed(1)}% of Money We Have`}
      percentageDirection="down"
      percentageValue={!q.isLoading && !q.error && d ? n(d.total_paid) : undefined}
      percentageTotal={moneyWeHaveTotal}
      items={d ? [
        { dot: 'bg-rose-500', label: `Paid out today (${n(d.today_count).toLocaleString()})`, value: formatUGX(n(d.today_paid)), onSelect: () => drill({ label: 'Today', from: kampalaDate(), to: kampalaDate(), status: conf, expected: { amount: n(d.today_paid), count: n(d.today_count), basis: 'confirmed' } }) },
        { dot: 'bg-rose-400', label: `Paid out this month (${n(d.month_count).toLocaleString()})`, value: formatUGX(n(d.month_paid)), onSelect: () => drill({ label: 'This month', from: monthStart(), to: kampalaDate(), status: conf, expected: { amount: n(d.month_paid), count: n(d.month_count), basis: 'confirmed' } }) },
        { dot: 'bg-slate-400', label: 'Number of payouts', value: n(d.total_count).toLocaleString(), onSelect: total },
        { dot: 'bg-amber-500', label: `Pending payouts (${n(d.pending_count).toLocaleString()})`, value: formatUGX(n(d.pending_amount)), onSelect: () => drill({ label: 'Pending', ...allTime(), status: 'pending', expected: { amount: n(d.pending_amount), count: n(d.pending_count), basis: 'pending' } }) },
      ] : []}
      onClick={() => { total(); }}
      footer={q.error ? 'Could not load payouts' : 'Completed payouts to mobile money, bank & cash'}
    />
    <MoneyPaidOutReport open={report} onOpenChange={setReport} preset={preset} />
    </>

  );
}
