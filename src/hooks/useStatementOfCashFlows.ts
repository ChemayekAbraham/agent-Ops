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
 * Statement of Cash Flows — corporate presentation (Operating / Investing / Financing).
 *
 * Read-only. Every figure comes from `public.fin_cash_flow(p_from, p_to)`: direct method on the cash accounts
 * listed in `fin_cash_accounts` (cash and bank, cash collected not yet banked, and the restricted Landlord Float
 * Pool). Internal moves between those accounts are eliminated. There is no balancing line: any movement the
 * counterpart entries do not explain is reported as `unexplained_difference` with its ledger groups.
 */
export interface CashFlowLine {
  label: string;
  amount: number;
}

export interface CashFlowGroup {
  label: string;
  total: number;
  lines: CashFlowLine[];
}

/**
 * Signed General Ledger trial-balance value of a cash account (debits less
 * credits) — the identical basis the Statement of Financial Position uses.
 * Published so closing cash can be tied to the Balance Sheet cash accounts
 * without re-deriving signs by hand (taking A1 as a positive figure when its
 * ledger balance is a credit is what produced the earlier 2 x A2 discrepancy).
 */
export interface CashFlowAccountBalance {
  code: string;
  label: string;
  opening: number;
  closing: number;
}

export interface CashFlowStatementSection {
  total: number;
  groups: CashFlowGroup[];
}

export interface StatementOfCashFlows {
  from: string;
  to: string;
  currency: string;
  cash_definition: string;
  operating: CashFlowStatementSection;
  investing: CashFlowStatementSection;
  financing: CashFlowStatementSection;
  exchange_rate_effect: number;
  net_change: number;
  opening_cash: number;
  closing_cash: number;
  cash_accounts: CashFlowAccountBalance[];
  balance_sheet_cash: number;
  ties_to_balance_sheet: boolean;
  unreconciled_residual: number;
  reconciles: boolean;
  /** fin_cash_flow only: movement not explained by counterpart entries (never added to a line). */
  unexplained_difference?: number;
  unexplained_groups_count?: number;
  unexplained_groups?: { group: string; cash_effect: number; counterparts: number; gap: number }[];
  explained_net_change?: number;
}

const ALL_TIME_START = new Date('2000-01-01T00:00:00Z');

export function useStatementOfCashFlows(
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
  const [blockedKey, setBlockedKey] = useState<string | null>(null);

  const query = useQuery({
    queryKey: heavyFinanceReportQueryKey('fin_cash_flow', args),
    enabled: enabled && blockedKey !== argsKey,
    ...heavyFinanceReportQueryOptions,
    queryFn: async ({ signal, client, queryKey }) => {
      const data = await runHeavyFinanceReport<StatementOfCashFlows>('fin_cash_flow', args, { active: true, signal });
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

/** Flattens the statement into label/amount rows for CSV and PDF export. */
export function flattenCashFlowStatement(d: StatementOfCashFlows): { label: string; amount: number | null; level: 'section' | 'group' | 'line' | 'total' }[] {
  const rows: { label: string; amount: number | null; level: 'section' | 'group' | 'line' | 'total' }[] = [];
  const push = (section: CashFlowStatementSection, title: string) => {
    rows.push({ label: title, amount: null, level: 'section' });
    for (const g of section.groups) {
      rows.push({ label: g.label, amount: null, level: 'group' });
      for (const l of g.lines) rows.push({ label: l.label, amount: l.amount, level: 'line' });
      rows.push({ label: `Total ${g.label}`, amount: g.total, level: 'group' });
    }
    rows.push({ label: `Net cash provided by (used in) ${title.toLowerCase()}`, amount: section.total, level: 'total' });
  };
  push(d.operating, 'Cash Flows from Operating Activities');
  push(d.investing, 'Cash Flows from Investing Activities');
  push(d.financing, 'Cash Flows from Financing Activities');
  rows.push({ label: 'Effect of exchange rate changes on cash and cash equivalents', amount: d.exchange_rate_effect, level: 'line' });
  rows.push({ label: 'Net increase / (decrease) in cash and cash equivalents', amount: d.net_change, level: 'total' });
  rows.push({ label: 'Cash and cash equivalents at beginning of period', amount: d.opening_cash, level: 'line' });
  rows.push({ label: 'Cash and cash equivalents at end of period', amount: d.closing_cash, level: 'total' });
  rows.push({ label: 'Reconciliation to Balance Sheet cash accounts', amount: null, level: 'section' });
  for (const a of d.cash_accounts ?? []) {
    rows.push({ label: `${a.code} ${a.label}`, amount: a.closing, level: 'line' });
  }
  rows.push({ label: 'Total Balance Sheet cash accounts (A1 + A2)', amount: d.balance_sheet_cash, level: 'total' });
  rows.push({
    label: 'Difference: closing cash less Balance Sheet cash accounts',
    amount: Number((d.closing_cash - d.balance_sheet_cash).toFixed(2)),
    level: 'total',
  });
  return rows;
}
