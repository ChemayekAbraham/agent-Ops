import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  financeReportErrorMessage,
  heavyFinanceReportQueryKey,
  heavyFinanceReportQueryOptions,
  rememberHeavyReportResult,
  runHeavyFinanceReport,
} from '@/lib/heavyFinanceReportQueue';

/**
 * Income Statement from the General Ledger revenue (R) and expense (X) accounts.
 *
 * Read-only. Every figure comes from `public.fin_income_statement(p_from, p_to)`, which resolves legs with the
 * same resolver as the Balance Sheet. Nothing is calculated in the browser.
 */
export interface FinIncomeLineDetail { account: string; category: string; amount: number; legs: number }
export interface FinIncomeLine { label: string; amount: number; legs: number; flag: string | null; detail: FinIncomeLineDetail[] }
export interface FinIncomeSection { total: number; lines: FinIncomeLine[] }

export interface FinIncomeStatement {
  from: string;
  to: string;
  currency: string;
  generated_at: string;
  basis: string;
  sections: {
    revenue: FinIncomeSection;
    cost_of_revenue: FinIncomeSection;
    operating_expense: FinIncomeSection;
    other: FinIncomeSection;
    tax: FinIncomeSection;
  };
  totals: {
    revenue: number; cost_of_revenue: number; gross_profit: number; operating_expenses: number;
    operating_result: number; other_items: number; result_before_tax: number; tax: number; net_result: number;
  };
  reconciliation: {
    ledger_revenue: number; ledger_expenses: number; ledger_net: number; statement_net: number;
    difference: number; ties_to_ledger: boolean;
  };
  months: { month: string; revenue: number; expenses: number; net_result: number }[];
}

export interface FinIncomeRow {
  label: string;
  amount: number | null;
  kind: 'section' | 'line' | 'subtotal' | 'result';
  flag?: string | null;
}

const ALL_TIME_START = new Date('2000-01-01T00:00:00Z');

/** Flat presentation rows, shared by the screen and the CSV / PDF exports. Expenses are shown as negatives. */
export function buildFinIncomeRows(d: FinIncomeStatement): FinIncomeRow[] {
  const rows: FinIncomeRow[] = [];
  const section = (title: string, s: FinIncomeSection, sign: 1 | -1) => {
    rows.push({ label: title, amount: null, kind: 'section' });
    s.lines.forEach((l) => rows.push({ label: l.label, amount: sign * l.amount, kind: 'line', flag: l.flag }));
  };
  section('Revenue', d.sections.revenue, 1);
  rows.push({ label: 'Total revenue', amount: d.totals.revenue, kind: 'subtotal' });
  section('Cost of revenue', d.sections.cost_of_revenue, -1);
  rows.push({ label: 'Gross profit / (loss)', amount: d.totals.gross_profit, kind: 'result' });
  section('Operating expenses', d.sections.operating_expense, -1);
  rows.push({ label: 'Operating result', amount: d.totals.operating_result, kind: 'result' });
  if (d.sections.other.lines.length) {
    section('Write-offs and float adjustments', d.sections.other, -1);
  }
  rows.push({ label: 'Result before tax', amount: d.totals.result_before_tax, kind: 'subtotal' });
  if (d.sections.tax.lines.length) section('Tax', d.sections.tax, -1);
  rows.push({ label: 'Net profit / (loss)', amount: d.totals.net_result, kind: 'result' });
  return rows;
}

export function useFinIncomeStatement(
  start: Date | null,
  end: Date | null,
  options?: { enabled?: boolean },
) {
  const enabled = options?.enabled !== false;

  // Freeze "now" once per period choice: a fresh new Date() on every render recreated `load` and re-ran the
  // query in a loop for open-ended periods (All Time).
  const startMs = start ? start.getTime() : null;
  const endMs = end ? end.getTime() : null;
  const fromIso = useMemo(() => (startMs === null ? ALL_TIME_START : new Date(startMs)).toISOString(), [startMs]);
  const toIso = useMemo(() => (endMs === null ? new Date() : new Date(endMs)).toISOString(), [endMs]);
  const args = useMemo(() => ({ p_from: fromIso, p_to: toIso }), [fromIso, toIso]);
  const argsKey = `${fromIso}\0${toIso}`;
  // A failed read must not start again just because the tab is closed and opened.
  // Try again calls refetch() on purpose. A different period is a different key.
  const [blockedKey, setBlockedKey] = useState<string | null>(null);

  const query = useQuery({
    queryKey: heavyFinanceReportQueryKey('fin_income_statement', args),
    enabled: enabled && blockedKey !== argsKey,
    ...heavyFinanceReportQueryOptions,
    queryFn: async ({ signal, client, queryKey }) => {
      const data = await runHeavyFinanceReport<FinIncomeStatement>('fin_income_statement', args, { active: true, signal });
      return rememberHeavyReportResult(client, queryKey, signal, data);
    },
  });

  useEffect(() => {
    if (query.isError) setBlockedKey(argsKey);
  }, [query.isError, argsKey]);

  return {
    data: query.data ?? null,
    loading: enabled && query.isFetching && query.data === undefined,
    error: query.error ? financeReportErrorMessage(query.error) : null,
    reload: () => query.refetch(),
  };
}
