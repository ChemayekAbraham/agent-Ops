import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { HeroCard } from '@/components/cfo/HeroCard';
import { formatUGX } from '@/lib/creditFeeCalculations';
import { ArrowDownLeft, FileText } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { MoneyReceivedReport } from '@/components/cfo/MoneyReceivedReport';

type Row = {
  total_received: number; total_count: number; today_received: number; today_count: number;
  month_received: number; month_count: number; pending_amount: number; pending_count: number;
};

/** Actual external money received (approved deposits). Read-only. */
export function MoneyReceivedCard() {
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
  const n = (v?: number) => Number(v ?? 0);
  return (
    <div className="flex flex-col gap-2">
    <HeroCard
      icon={<ArrowDownLeft className="h-5 w-5 text-emerald-50" />}
      iconBg="bg-emerald-600"
      title="Money Paid Out"
      value={q.isLoading || q.error || !d ? '—' : formatUGX(n(d.total_received))}
      percentageLabel="Confirmed deposits by mobile money, bank & cash"
      items={d ? [
        { dot: 'bg-emerald-500', label: `Received today (${n(d.today_count).toLocaleString()})`, value: formatUGX(n(d.today_received)) },
        { dot: 'bg-emerald-400', label: `Received this month (${n(d.month_count).toLocaleString()})`, value: formatUGX(n(d.month_received)) },
        { dot: 'bg-slate-400', label: 'Number of receipts', value: n(d.total_count).toLocaleString() },
        { dot: 'bg-amber-500', label: `Pending / unconfirmed (${n(d.pending_count).toLocaleString()})`, value: formatUGX(n(d.pending_amount)) },
      ] : []}
      footer={q.error ? 'Could not load receipts' : 'Excludes internal transfers and accounting corrections'}
    />
    <Button variant="outline" size="sm" onClick={() => setReport(true)}><FileText className="h-4 w-4 mr-1" /> View Report</Button>
    <MoneyReceivedReport open={report} onOpenChange={setReport} />
    </div>
  );
}
