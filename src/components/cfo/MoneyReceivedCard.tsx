import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { HeroCard } from '@/components/cfo/HeroCard';
import { formatUGX } from '@/lib/creditFeeCalculations';
import { ArrowDownLeft } from 'lucide-react';
import { useState } from 'react';
import { allTime, kampalaDate, monthStart, type DrilldownPreset } from '@/components/cfo/MoneyDrilldownReport';
import { MoneyReceivedReport } from '@/components/cfo/MoneyReceivedReport';

type Row = {
  total_received: number; total_count: number; today_received: number; today_count: number;
  month_received: number; month_count: number; pending_amount: number; pending_count: number;
};

/** Actual external money received (approved deposits). Read-only. */
export function MoneyReceivedCard({ moneyWeHaveTotal }: { moneyWeHaveTotal: number }) {
  const q = useQuery({
    queryKey: ['cfo-money-received'],
    queryFn: async () => {
      const { data, error } = await (supabase.rpc as any)('get_cfo_money_received');
      if (error) throw error;
      return ((data ?? [])[0] ?? null) as Row | null;
    },
    refetchInterval: 60000,
  });
  const d = q.data;
  const [report, setReport] = useState(false);
  const [preset, setPreset] = useState<DrilldownPreset | null>(null);
  const conf = 'approved';
  const drill = (p: DrilldownPreset | null) => { setPreset(p); setReport(true); };
  const total = () => d && drill({ label: 'All time', ...allTime(), status: conf, expected: { amount: n(d.total_received), count: n(d.total_count), basis: 'confirmed' } });
  const n = (v?: number) => Number(v ?? 0);
  return (
    <>
    <HeroCard


      icon={<ArrowDownLeft className="h-5 w-5" />}
      tone="success"
      title="Money Received"
      value={q.isLoading || q.error || !d ? '—' : formatUGX(n(d.total_received))}
      percentageLabel={q.isLoading || q.error || !d || moneyWeHaveTotal <= 0
        ? '—'
        : `${((n(d.total_received) / moneyWeHaveTotal) * 100).toFixed(1)}% of Money We Have`}
      percentageDirection="up"
      percentageValue={!q.isLoading && !q.error && d ? n(d.total_received) : undefined}
      percentageTotal={moneyWeHaveTotal}
      items={d ? [
        { dot: 'bg-emerald-500', label: `Received today (${n(d.today_count).toLocaleString()})`, value: formatUGX(n(d.today_received)), onSelect: () => drill({ label: 'Today', from: kampalaDate(), to: kampalaDate(), status: conf, expected: { amount: n(d.today_received), count: n(d.today_count), basis: 'confirmed' } }) },
        { dot: 'bg-emerald-400', label: `Received this month (${n(d.month_count).toLocaleString()})`, value: formatUGX(n(d.month_received)), onSelect: () => drill({ label: 'This month', from: monthStart(), to: kampalaDate(), status: conf, expected: { amount: n(d.month_received), count: n(d.month_count), basis: 'confirmed' } }) },
        { dot: 'bg-slate-400', label: 'Number of receipts', value: n(d.total_count).toLocaleString(), onSelect: total },
        { dot: 'bg-amber-500', label: `Pending / unconfirmed (${n(d.pending_count).toLocaleString()})`, value: formatUGX(n(d.pending_amount)), onSelect: () => drill({ label: 'Pending', ...allTime(), status: 'pending', expected: { amount: n(d.pending_amount), count: n(d.pending_count), basis: 'pending' } }) },
      ] : []}
      onClick={() => { total(); }}
      footer={q.error ? 'Could not load receipts' : 'Confirmed deposits by mobile money, bank & cash'}
    />
    <MoneyReceivedReport open={report} onOpenChange={setReport} preset={preset} />
    </>

  );
}
