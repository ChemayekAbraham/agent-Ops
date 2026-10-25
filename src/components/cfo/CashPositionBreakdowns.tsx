import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { cfoReportRetry } from '@/hooks/cfoReportRetry';
import { formatUGX } from '@/lib/creditFeeCalculations';
import { ArrowDownLeft, ArrowUpRight, ChevronRight } from 'lucide-react';
import { allTime, type DrilldownPreset } from '@/components/cfo/MoneyDrilldownReport';
import { MoneyReceivedReport } from '@/components/cfo/MoneyReceivedReport';
import { MoneyPaidOutReport } from '@/components/cfo/MoneyPaidOutReport';

const METHODS = [
  { key: 'mobile_money', label: 'Mobile Money' },
  { key: 'bank_transfer', label: 'Bank Transfer' },
  { key: 'cash', label: 'Cash' },
] as const;

type MethodTotal = { key: string; label: string; amount: number; count: number };

const rangeArgs = () => {
  const range = allTime();
  const end = new Date(`${range.to}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + 1);
  return {
    range,
    p_from: new Date(`${range.from}T00:00:00+03:00`).toISOString(),
    p_to: new Date(`${end.toISOString().slice(0, 10)}T00:00:00+03:00`).toISOString(),
  };
};

function useMethodBreakdown(kind: 'received' | 'paid_out', status: 'approved' | 'confirmed') {
  return useQuery({
    queryKey: ['cfo-cash-position-method-breakdown', kind],
    retry: cfoReportRetry,
    queryFn: async (): Promise<MethodTotal[]> => {
      const { p_from, p_to } = rangeArgs();
      const results = await Promise.all(
        METHODS.map(m => (supabase.rpc as any)('get_cfo_money_drilldown_totals', {
          p_kind: kind, p_from, p_to, p_status: status, p_method: m.key, p_type: null, p_person: null,
        })),
      );
      return results.map((result, index) => {
        if (result.error) throw result.error;
        const row = (result.data ?? [])[0] ?? {};
        return {
          key: METHODS[index].key,
          label: METHODS[index].label,
          amount: Number(row.confirmed_amount ?? 0),
          count: Number(row.confirmed_count ?? 0),
        };
      });
    },
    staleTime: 60_000,
  });
}

function BreakdownPanel({ title, icon, tone, query, onSelect }: {
  title: string;
  icon: React.ReactNode;
  tone: string;
  query: ReturnType<typeof useMethodBreakdown>;
  onSelect: (row: MethodTotal) => void;
}) {
  const rows = query.data ?? [];
  const total = rows.reduce((s, r) => s + r.amount, 0);
  return (
    <section className="cash-panel" aria-label={title}>
      <div className="mb-3 flex items-center gap-2.5">
        <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${tone}`}>{icon}</span>
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">{title}</h2>
          <p className="text-[11px] text-muted-foreground">
            {query.isLoading ? 'Loading…' : query.error ? 'Could not load breakdown' : `${formatUGX(total)} all time`}
          </p>
        </div>
      </div>
      <div className="divide-y divide-border/60">
        {rows.map(row => (
          <button key={row.key} type="button" onClick={() => onSelect(row)}
            className="flex w-full items-center gap-3 py-2.5 text-left">
            <span className="min-w-0 flex-1">
              <span className="block text-xs font-semibold">{row.label}</span>
              <span className="block text-[11px] text-muted-foreground">{row.count.toLocaleString()} transactions</span>
            </span>
            <span className="text-xs font-medium tabular-nums">{formatUGX(row.amount)}</span>
            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
          </button>
        ))}
      </div>
    </section>
  );
}

/** Read-only "Received by" / "Paid by" payment-method breakdowns for the Cash Position page. */
export function CashPositionBreakdowns() {
  const received = useMethodBreakdown('received', 'approved');
  const paidOut = useMethodBreakdown('paid_out', 'confirmed');
  const [receivedOpen, setReceivedOpen] = useState(false);
  const [paidOpen, setPaidOpen] = useState(false);
  const [preset, setPreset] = useState<DrilldownPreset | null>(null);

  const open = (kind: 'received' | 'paid_out', status: 'approved' | 'confirmed') => (row: MethodTotal) => {
    setPreset({
      label: `${row.label} — all time`,
      ...allTime(),
      status,
      method: row.key,
      expected: { amount: row.amount, count: row.count, basis: 'confirmed' },
    });
    if (kind === 'received') setReceivedOpen(true); else setPaidOpen(true);
  };

  return (
    <>
      <div className="cash-breakdowns">
        <BreakdownPanel title="Received by" icon={<ArrowDownLeft className="h-4 w-4" />}
          tone="bg-success/10 text-success" query={received} onSelect={open('received', 'approved')} />
        <BreakdownPanel title="Paid by" icon={<ArrowUpRight className="h-4 w-4" />}
          tone="bg-destructive/10 text-destructive" query={paidOut} onSelect={open('paid_out', 'confirmed')} />
      </div>
      <MoneyReceivedReport open={receivedOpen} onOpenChange={setReceivedOpen} preset={preset} />
      <MoneyPaidOutReport open={paidOpen} onOpenChange={setPaidOpen} preset={preset} />
    </>
  );
}
