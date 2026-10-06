import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { HeroCard } from '@/components/cfo/HeroCard';
import { formatUGX } from '@/lib/creditFeeCalculations';
import { ArrowUpRight } from 'lucide-react';
import { useState } from 'react';
import { allTime, type DrilldownPreset } from '@/components/cfo/MoneyDrilldownReport';
import { MoneyPaidOutReport } from '@/components/cfo/MoneyPaidOutReport';
type Row = {
  total_paid: number; total_count: number; today_paid: number; today_count: number;
  yesterday_paid: number; yesterday_count: number; last7_paid: number; last7_count: number;
  month_paid: number; month_count: number; pending_amount: number; pending_count: number;
};

const PAYOUT_SOURCES = ['Wallet withdrawal', 'Supporter returns', 'Commission', 'Landlord', 'Salary'] as const;
type SourceTotal = { label: string; amount: number; count: number };

/** Actual external payouts (completed/paid withdrawals). Read-only. */
export function MoneyPaidOutCard({ moneyWeHaveTotal }: { moneyWeHaveTotal: number }) {
  const q = useQuery({
    queryKey: ['cfo-money-paid-out'],
    queryFn: async () => {
      const range = allTime();
      const end = new Date(`${range.to}T00:00:00Z`);
      end.setUTCDate(end.getUTCDate() + 1);
      const p_from = new Date(`${range.from}T00:00:00+03:00`).toISOString();
      const p_to = new Date(`${end.toISOString().slice(0, 10)}T00:00:00+03:00`).toISOString();
      const [summaryResult, ...sourceResults] = await Promise.all([
        (supabase.rpc as any)('get_cfo_money_paid_out'),
        ...PAYOUT_SOURCES.map(p_type => (supabase.rpc as any)('get_cfo_money_drilldown_totals', {
          p_kind: 'paid_out', p_from, p_to, p_status: 'confirmed', p_method: null, p_type, p_person: null,
        })),
      ]);
      if (summaryResult.error) throw summaryResult.error;
      const sources = sourceResults.map((result, index): SourceTotal => {
        if (result.error) throw result.error;
        const row = (result.data ?? [])[0] ?? {};
        return {
          label: PAYOUT_SOURCES[index],
          amount: Number(row.confirmed_amount ?? 0),
          count: Number(row.confirmed_count ?? 0),
        };
      });
      return { summary: ((summaryResult.data ?? [])[0] ?? null) as Row | null, sources };
    },
    refetchInterval: 60000,
  });
  const d = q.data?.summary;
  const sources = q.data?.sources ?? [];
  const [report, setReport] = useState(false);
  const [preset, setPreset] = useState<DrilldownPreset | null>(null);
  const conf = 'confirmed';
  const drill = (p: DrilldownPreset | null) => { setPreset(p); setReport(true); };
  const n = (v?: number) => Number(v ?? 0);
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
      items={d ? sources.filter(source => source.count > 0).map((source, index) => ({
        dot: ['bg-rose-500', 'bg-amber-500', 'bg-success', 'bg-info', 'bg-primary'][index],
        label: `${source.label} (${source.count.toLocaleString()})`,
        value: formatUGX(source.amount),
        onSelect: () => {
          const range = allTime();
          drill({
            label: source.label,
            ...range,
            status: conf,
            type: source.label,
            expected: { amount: source.amount, count: source.count, basis: 'confirmed' },
          });
        },
      })) : []}
      onClick={() => drill(null)}
      footer={q.error ? 'Could not load payouts' : 'Completed payouts to mobile money, bank & cash'}
    />
    <MoneyPaidOutReport open={report} onOpenChange={setReport} preset={preset} />
    </>

  );
}
