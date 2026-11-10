import { AlertTriangle, CheckCircle2, Info, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatDynamic as formatUGX } from '@/lib/currencyFormat';
import { buildFinIncomeRows, type FinIncomeStatement } from '@/hooks/useFinIncomeStatement';

const money = (v: number) => (v < 0 ? `(${formatUGX(Math.abs(v))})` : formatUGX(v));

/**
 * Income Statement rendered from `fin_income_statement` (revenue and expense accounts only).
 * Presentation only: every amount comes from the server.
 */
export default function FinIncomeStatementSection({ d, error }: { d: FinIncomeStatement | null; error?: string | null }) {
  if (error) {
    return (
      <div className="flex items-start gap-2 rounded-md border border-destructive/40 p-3 text-xs text-destructive">
        <AlertTriangle className="h-4 w-4 shrink-0" />
        <span>Could not build the income statement: {error}</span>
      </div>
    );
  }
  if (!d) {
    return (
      <div className="flex items-center gap-2 py-8 justify-center text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Building income statement…
      </div>
    );
  }

  const rows = buildFinIncomeRows(d);
  return (
    <div className="space-y-1">
      <p className="text-[10px] text-muted-foreground">{d.basis}</p>
      <div className="mt-2">
        {rows.map((r, i) => {
          if (r.kind === 'section') {
            return (
              <h4 key={`${r.label}-${i}`} className="text-xs font-semibold text-primary uppercase tracking-wider mt-4 mb-1">
                {r.label}
              </h4>
            );
          }
          const strong = r.kind !== 'line';
          return (
            <div
              key={`${r.label}-${i}`}
              className={cn(
                'flex justify-between gap-3 py-1 text-xs',
                r.kind === 'line' && 'pl-3',
                strong && 'font-semibold border-t border-border/60',
                r.kind === 'result' && 'text-sm',
              )}
            >
              <span className="min-w-0">
                {r.label}
                {r.flag ? (
                  <span className="mt-0.5 flex items-start gap-1 text-[10px] font-normal text-amber-700 dark:text-amber-400">
                    <Info className="h-3 w-3 mt-px shrink-0" />
                    {r.flag}
                  </span>
                ) : null}
              </span>
              <span className={cn('font-mono tabular-nums shrink-0', (r.amount ?? 0) < 0 && 'text-destructive')}>
                {money(r.amount ?? 0)}
              </span>
            </div>
          );
        })}
      </div>

      <div className={cn('flex items-center gap-1.5 pt-3 text-[11px]', d.reconciliation.ties_to_ledger ? 'text-success' : 'text-destructive')}>
        {d.reconciliation.ties_to_ledger ? <CheckCircle2 className="h-3.5 w-3.5" /> : <AlertTriangle className="h-3.5 w-3.5" />}
        <span>
          {d.reconciliation.ties_to_ledger
            ? `Ties to the ledger: revenue ${formatUGX(d.reconciliation.ledger_revenue)} less expenses ${formatUGX(d.reconciliation.ledger_expenses)}.`
            : `Differs from the ledger by ${formatUGX(Math.abs(d.reconciliation.difference))} — review the line map.`}
        </span>
      </div>

      {d.months.length > 1 && (
        <div className="pt-4">
          <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide mb-1">By month</p>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-muted-foreground border-b border-border">
                  <th className="py-1.5 font-medium">Month</th>
                  <th className="py-1.5 font-medium text-right">Revenue</th>
                  <th className="py-1.5 font-medium text-right">Expenses</th>
                  <th className="py-1.5 font-medium text-right">Net result</th>
                </tr>
              </thead>
              <tbody>
                {d.months.map((m) => (
                  <tr key={m.month} className="border-b border-border/50 last:border-0">
                    <td className="py-1.5">{m.month}</td>
                    <td className="py-1.5 text-right font-mono tabular-nums">{formatUGX(m.revenue)}</td>
                    <td className="py-1.5 text-right font-mono tabular-nums">{formatUGX(m.expenses)}</td>
                    <td className={cn('py-1.5 text-right font-mono tabular-nums', m.net_result < 0 && 'text-destructive')}>{money(m.net_result)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
