import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';

/**
 * Statement of Cash Flows — corporate presentation (Operating / Investing / Financing).
 *
 * Read-only. Every figure comes from `public.get_statement_of_cash_flows(p_from, p_to)`,
 * which derives cash from the General Ledger cash accounts (A1 Cash & Bank + A2 Float
 * with Agents) using `ledger_account_map` and `cash_flow_line_map`. No wallet cache,
 * no operational table and no hard-coded figure feeds any total here.
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
}

const ALL_TIME_START = new Date('2000-01-01T00:00:00Z');

export function useStatementOfCashFlows(start: Date | null, end: Date | null) {
  const [data, setData] = useState<StatementOfCashFlows | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fromIso = (start ?? ALL_TIME_START).toISOString();
  const toIso = (end ?? new Date()).toISOString();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data: rpc, error: rpcError } = await supabase.rpc('get_statement_of_cash_flows', {
      p_from: fromIso,
      p_to: toIso,
    });
    if (rpcError) {
      setError(rpcError.message);
      setData(null);
    } else {
      setData(rpc as unknown as StatementOfCashFlows);
    }
    setLoading(false);
  }, [fromIso, toIso]);

  useEffect(() => { void load(); }, [load]);

  return { data, loading, error, reload: load };
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
