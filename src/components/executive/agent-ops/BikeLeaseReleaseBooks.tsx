import { AlertTriangle } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { useMerchandiseReceivablesReconciliation } from '@/hooks/useMerchandiseReceivablesReconciliation';

/**
 * A released bike lease as the books carry it: what was paid out at release, the bike value the lease is priced on,
 * the receivable on the balance sheet (A13) and the plan balance the agent repays (future charges included).
 * Read-only; shown on the CFO Motorbikes view so a release that differs from the bike value is visible.
 */
export function bikeReleaseDifference(row: { disbursed_amount: number | null; valuation_amount: number | null; cfo_disbursed_at: string | null }) {
  const paid = Number(row.disbursed_amount || 0);
  const value = Number(row.valuation_amount || 0);
  if (!row.cfo_disbursed_at || paid <= 0 || value <= 0) return 0;
  return paid - value;
}

export function BikeLeaseReleaseBooks({ row }: {
  row: { id: string; disbursed_amount: number | null; valuation_amount: number | null; amount_outstanding: number | null; cfo_disbursed_at: string | null };
}) {
  const { data, isLoading, error } = useMerchandiseReceivablesReconciliation(!!row.cfo_disbursed_at);
  if (!row.cfo_disbursed_at) return null;
  const order = data?.orders.find((o) => o.sale_id === row.id);
  const paid = Number(row.disbursed_amount || 0);
  const value = Number(row.valuation_amount || 0);
  const diff = bikeReleaseDifference(row);

  return (
    <div className="rounded-lg border p-2 sm:p-3 space-y-1.5 text-xs">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Release and books</p>
      <div className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1">
        <span className="text-muted-foreground">Paid out at release</span>
        <span className="text-right font-semibold tabular-nums">{formatUGX(paid)}</span>
        <span className="text-muted-foreground">Bike value the lease is priced on</span>
        <span className="text-right tabular-nums">{formatUGX(value)}</span>
        <span className="text-muted-foreground">Receivable on the balance sheet (A13)</span>
        <span className="text-right font-semibold tabular-nums">
          {error ? '—' : isLoading || !data ? '…' : order ? formatUGX(order.ledger_receivable) : formatUGX(0)}
        </span>
        <span className="text-muted-foreground">Plan balance the agent repays (incl. future charges)</span>
        <span className="text-right tabular-nums">{formatUGX(Number(row.amount_outstanding || 0))}</span>
      </div>
      {diff !== 0 && (
        <p className="flex items-start gap-1.5 rounded-md bg-amber-500/10 p-2 text-amber-700 dark:text-amber-400">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            {formatUGX(Math.abs(diff))} {diff > 0 ? 'more' : 'less'} was paid out than the bike value. The lease is
            priced on {formatUGX(value)}; the books should carry the full amount paid out as the receivable (A13).
          </span>
        </p>
      )}
    </div>
  );
}
