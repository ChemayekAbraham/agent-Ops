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
      const results = await Promise.all(
        sources.map(s => (supabase.rpc as any)('get_cfo_money_drilldown_totals', {
          p_kind: kind, p_from, p_to, p_status: status, p_method: null, p_type: s.type, p_person: null,
        })),
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

function BreakdownPanel({ title, icon, tone, query, onSelect, onSelectTotal }: {
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
        {!query.isLoading && !query.error && rows.length > 0 && (
          <button type="button" onClick={() => onSelectTotal({ amount: total, count: totalCount })}
            className="flex w-full items-center gap-3 pt-3 pb-1 text-left">
            <span className="min-w-0 flex-1">
              <span className="block text-xs font-bold">Total</span>
              <span className="block text-[11px] text-muted-foreground">{totalCount.toLocaleString()} transactions</span>
            </span>
            <span className="text-sm font-bold tabular-nums">{formatUGX(total)}</span>
            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
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
    if (kind === 'received') setReceivedOpen(true); else setPaidOpen(true);
  };

  const openAll = (kind: 'received' | 'paid_out', status: 'approved' | 'confirmed') => (total: { amount: number; count: number }) => {
    setPreset({
      label: 'All sources — all time',
      ...allTime(),
      status,
      expected: { amount: total.amount, count: total.count, basis: 'confirmed' },
    });
    if (kind === 'received') setReceivedOpen(true); else setPaidOpen(true);
  };

  return (
    <>
      <div className="cash-breakdowns">
        <BreakdownPanel title="Received by" icon={<ArrowDownLeft className="h-4 w-4" />}
          tone="bg-success/10 text-success" query={received} onSelect={open('received', 'approved')}
          onSelectTotal={openAll('received', 'approved')} />
        <BreakdownPanel title="Paid by" icon={<ArrowUpRight className="h-4 w-4" />}
          tone="bg-destructive/10 text-destructive" query={paidOut} onSelect={open('paid_out', 'confirmed')}
          onSelectTotal={openAll('paid_out', 'confirmed')} />
      </div>
      <MoneyReceivedReport open={receivedOpen} onOpenChange={setReceivedOpen} preset={preset} />
      <MoneyPaidOutReport open={paidOpen} onOpenChange={setPaidOpen} preset={preset} />
    </>
  );
}
