import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { cfoReportRetry } from '@/hooks/cfoReportRetry';
import { formatUGX } from '@/lib/creditFeeCalculations';
import { ArrowDownLeft, ArrowUpRight, ChevronRight } from 'lucide-react';
import { allTime, type DrilldownPreset } from '@/components/cfo/MoneyDrilldownReport';
import { MoneyReceivedReport } from '@/components/cfo/MoneyReceivedReport';
import { MoneyPaidOutReport } from '@/components/cfo/MoneyPaidOutReport';

/** Money sources for each report — must stay in sync with the `types` lists in MoneyReceivedReport / MoneyPaidOutReport. */
export const RECEIVED_SOURCES = [
  { key: 'operational_float', label: 'Operational float', type: 'Operational float' },
  { key: 'personal_deposit', label: 'Personal deposit', type: 'Personal deposit' },
  { key: 'partnership_deposit', label: 'Partnership deposit', type: 'Partnership deposit' },
  { key: 'rent_repayment', label: 'Rent repayment', type: 'Rent repayment' },
  { key: 'other', label: 'Other', type: 'Other' },
] as const;

export const PAID_OUT_SOURCES = [
  { key: 'wallet_withdrawal', label: 'Wallet withdrawal', type: 'Wallet withdrawal' },
  { key: 'supporter_returns', label: 'Supporter returns', type: 'Supporter returns' },
  { key: 'commission', label: 'Agent commission', type: 'Commission' },
  { key: 'landlord', label: 'Landlord float', type: 'Landlord' },
  { key: 'salary', label: 'Salary', type: 'Salary' },
] as const;

export type SourceTotal = { key: string; label: string; type: string; amount: number; count: number };
/** Kept for existing imports (download reports dialog, tests). */
export type MethodTotal = SourceTotal;

export const sourcesFor = (kind: 'received' | 'paid_out') =>
  kind === 'received' ? RECEIVED_SOURCES : PAID_OUT_SOURCES;

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

/** All-time confirmed totals per money source, from the same server aggregate the reports use. */
export function useSourceBreakdown(kind: 'received' | 'paid_out', status: 'approved' | 'confirmed') {
  const sources = sourcesFor(kind);
  return useQuery({
    queryKey: ['cfo-cash-position-source-breakdown', kind],
    retry: cfoReportRetry,
    queryFn: async (): Promise<SourceTotal[]> => {
      const { p_from, p_to } = rangeArgs();
      const callRpc = supabase.rpc as unknown as (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: Error | null }>;
      const results = await Promise.all(
        sources.map((s) =>
          callRpc('get_cfo_money_drilldown_totals', {
            p_kind: kind,
            p_from,
            p_to,
            p_status: status,
            p_method: null,
            p_type: s.type,
            p_person: null,
          })
        )
      );
      return results.map((result, index) => {
        if (result.error) throw result.error;
        const row = (result.data ?? [])[0] ?? {};
        return {
          key: sources[index].key,
          label: sources[index].label,
          type: sources[index].type,
          amount: Number(row.confirmed_amount ?? 0),
          count: Number(row.confirmed_count ?? 0),
        };
      });
    },
    staleTime: 60_000,
  });
}

/** @deprecated Use useSourceBreakdown — kept so existing imports keep working. */
export const useMethodBreakdown = useSourceBreakdown;

function BreakdownPanel({
  title,
  icon,
  tone,
  query,
  onSelect,
  onSelectTotal,
}: {
  title: string;
  icon: React.ReactNode;
  tone: string;
  query: ReturnType<typeof useSourceBreakdown>;
  onSelect: (row: SourceTotal) => void;
  onSelectTotal: (total: { amount: number; count: number }) => void;
}) {
  const rows = query.data ?? [];
  const total = rows.reduce((s, r) => s + r.amount, 0);
  const totalCount = rows.reduce((s, r) => s + r.count, 0);

  return (
    <section className="cash-panel rounded-xl border border-border/80 bg-card p-4 shadow-xs min-w-0" aria-label={title}>
      {/* Header */}
      <div className="mb-3.5 flex items-center justify-between gap-2 border-b border-border/40 pb-2.5">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${tone}`}>
            {icon}
          </span>
          <div className="min-w-0">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-foreground truncate">{title}</h2>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              {query.isLoading ? 'Loading…' : query.error ? 'Could not load breakdown' : `${formatUGX(total)} all time`}
            </p>
          </div>
        </div>
        <span className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider hidden sm:block">
          All Time Aggregate
        </span>
      </div>

      {/* Rows */}
      <div className="divide-y divide-border/40">
        {rows.map((row) => (
          <button
            key={row.key}
            type="button"
            onClick={() => onSelect(row)}
            className="group flex w-full items-center justify-between gap-3 py-2.5 px-1 text-left rounded-lg hover:bg-muted/40 transition-colors"
          >
            <span className="min-w-0 flex-1">
              <span className="block text-xs font-medium text-foreground group-hover:text-primary transition-colors">
                {row.label}
              </span>
              <span className="block text-[11px] text-muted-foreground tabular-nums">
                {row.count.toLocaleString()} transactions
              </span>
            </span>
            <span className="text-xs font-semibold tabular-nums text-foreground whitespace-nowrap">
              {formatUGX(row.amount)}
            </span>
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/40 group-hover:text-primary group-hover:translate-x-0.5 transition-all" />
          </button>
        ))}

        {/* Total Summary Row (Matches Test Signature) */}
        {!query.isLoading && !query.error && rows.length > 0 && (
          <button
            type="button"
            onClick={() => onSelectTotal({ amount: total, count: totalCount })}
            className="group flex w-full items-center justify-between gap-3 pt-3 pb-1.5 px-1 text-left border-t-2 border-border/80 font-bold hover:bg-muted/40 rounded-b-lg transition-colors"
          >
            <span className="min-w-0 flex-1">
              <span className="block text-xs font-bold text-foreground">Total</span>
              <span className="block text-[11px] font-normal text-muted-foreground tabular-nums">
                {totalCount.toLocaleString()} transactions
              </span>
            </span>
            <span className="text-sm font-extrabold tabular-nums text-foreground whitespace-nowrap">
              {formatUGX(total)}
            </span>
            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/60 group-hover:text-primary group-hover:translate-x-0.5 transition-all" />
          </button>
        )}
      </div>
    </section>
  );
}

/** Read-only "Received by" / "Paid by" money-source breakdowns for the Cash Position page. */
export function CashPositionBreakdowns() {
  const received = useSourceBreakdown('received', 'approved');
  const paidOut = useSourceBreakdown('paid_out', 'confirmed');
  const [receivedOpen, setReceivedOpen] = useState(false);
  const [paidOpen, setPaidOpen] = useState(false);
  const [preset, setPreset] = useState<DrilldownPreset | null>(null);

  const open = (kind: 'received' | 'paid_out', status: 'approved' | 'confirmed') => (row: SourceTotal) => {
    setPreset({
      label: `${row.label} — all time`,
      ...allTime(),
      status,
      type: row.type,
      expected: { amount: row.amount, count: row.count, basis: 'confirmed' },
    });
    if (kind === 'received') setReceivedOpen(true);
    else setPaidOpen(true);
  };

  const openAll =
    (kind: 'received' | 'paid_out', status: 'approved' | 'confirmed') =>
    (total: { amount: number; count: number }) => {
      setPreset({
        label: 'All sources — all time',
        ...allTime(),
        status,
        expected: { amount: total.amount, count: total.count, basis: 'confirmed' },
      });
      if (kind === 'received') setReceivedOpen(true);
      else setPaidOpen(true);
    };

  return (
    <>
      <div className="cash-breakdowns grid grid-cols-1 md:grid-cols-2 gap-4">
        <BreakdownPanel
          title="Received by"
          icon={<ArrowDownLeft className="h-4 w-4" />}
          tone="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
          query={received}
          onSelect={open('received', 'approved')}
          onSelectTotal={openAll('received', 'approved')}
        />
        <BreakdownPanel
          title="Paid by"
          icon={<ArrowUpRight className="h-4 w-4" />}
          tone="bg-rose-500/10 text-rose-600 dark:text-rose-400"
          query={paidOut}
          onSelect={open('paid_out', 'confirmed')}
          onSelectTotal={openAll('paid_out', 'confirmed')}
        />
      </div>
      <MoneyReceivedReport open={receivedOpen} onOpenChange={setReceivedOpen} preset={preset} />
      <MoneyPaidOutReport open={paidOpen} onOpenChange={setPaidOpen} preset={preset} />
    </>
  );
}
