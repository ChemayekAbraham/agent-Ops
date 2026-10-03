import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { HeroCard } from '@/components/cfo/HeroCard';
import { formatUGX } from '@/lib/creditFeeCalculations';
import { ArrowDownLeft } from 'lucide-react';
import { useState } from 'react';
import { allTime, type DrilldownPreset } from '@/components/cfo/MoneyDrilldownReport';
import { MoneyReceivedReport } from '@/components/cfo/MoneyReceivedReport';

type Row = {
  total_received: number; total_count: number; today_received: number; today_count: number;
  month_received: number; month_count: number; pending_amount: number; pending_count: number;
};

const RECEIPT_SOURCES = ['Operational float', 'Personal deposit', 'Partnership deposit', 'Rent repayment', 'Other'] as const;
type SourceTotal = { label: string; amount: number; count: number };

/** Actual external money received (approved deposits). Read-only. */
export function MoneyReceivedCard({ moneyWeHaveTotal }: { moneyWeHaveTotal: number }) {
  const q = useQuery({
    queryKey: ['cfo-money-received'],
    queryFn: async () => {
      const range = allTime();
      const end = new Date(`${range.to}T00:00:00Z`);
      end.setUTCDate(end.getUTCDate() + 1);
      const p_from = new Date(`${range.from}T00:00:00+03:00`).toISOString();
      const p_to = new Date(`${end.toISOString().slice(0, 10)}T00:00:00+03:00`).toISOString();
      const [summaryResult, ...sourceResults] = await Promise.all([
        (supabase.rpc as any)('get_cfo_money_received'),
        ...RECEIPT_SOURCES.map(p_type => (supabase.rpc as any)('get_cfo_money_drilldown_totals', {
          p_kind: 'received', p_from, p_to, p_status: 'approved', p_method: null, p_type, p_person: null,
        })),
      ]);
      if (summaryResult.error) throw summaryResult.error;
      const sources = sourceResults.map((result, index): SourceTotal => {
        if (result.error) throw result.error;
        const row = (result.data ?? [])[0] ?? {};
        return {
          label: RECEIPT_SOURCES[index],
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
      items={d ? sources.filter(source => source.count > 0).map((source, index) => ({
        dot: ['bg-success', 'bg-info', 'bg-primary', 'bg-warning', 'bg-muted-foreground'][index],
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
      footer={q.error ? 'Could not load receipts' : 'Confirmed deposits by mobile money, bank & cash'}
    />
    <MoneyReceivedReport open={report} onOpenChange={setReport} preset={preset} />
    </>

  );
}
