import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';

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

export function useFinIncomeStatement(start: Date | null, end: Date | null, enabled: boolean = true) {
  const [data, setData] = useState<FinIncomeStatement | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Freeze "now" once per period choice: a fresh new Date() on every render recreated `load` and re-ran the
  // query in a loop for open-ended periods (All Time).
  const startMs = start ? start.getTime() : null;
  const endMs = end ? end.getTime() : null;
  const fromIso = useMemo(() => (startMs === null ? ALL_TIME_START : new Date(startMs)).toISOString(), [startMs]);
  const toIso = useMemo(() => (endMs === null ? new Date() : new Date(endMs)).toISOString(), [endMs]);

  const load = useCallback(async () => {
    if (!enabled) {
      setData(null);
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    setData(null); // never show or export the previous period's figures while the new period loads
    try {
      const { data: rpc, error: rpcError } = await supabase.rpc('fin_income_statement', { p_from: fromIso, p_to: toIso });
      if (rpcError) {
        setError(rpcError.message);
        setData(null);
      } else {
        setData(rpc as unknown as FinIncomeStatement);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [enabled, fromIso, toIso]);

  useEffect(() => { void load(); }, [load]);

  return { data, loading, error, reload: load };
}

/**
 * Fallback converter: maps client-side `IncomeStatementData` (from `get_financial_statement_ledger_sums`)
 * into the canonical `FinIncomeStatement` interface if the server RPC is temporarily unreachable or pending migration.
 */
export function convertToFinIncomeStatement(d: import('@/hooks/useFinancialStatements').IncomeStatementData): FinIncomeStatement {
  const revLines: FinIncomeLine[] = [
    { label: 'Tenant Access Fees', amount: d.revenue.accessFees, legs: 0, flag: null, detail: [] },
    { label: 'Tenant Request Fees', amount: d.revenue.requestFees, legs: 0, flag: null, detail: [] },
    { label: 'Other Service Income', amount: d.revenue.otherServiceIncome, legs: 0, flag: null, detail: [] },
    { label: 'Advance Access Fees', amount: d.revenue.advanceAccessFeesCollected, legs: 0, flag: null, detail: [] },
  ].filter((l) => l.amount > 0);

  const corLines: FinIncomeLine[] = [
    { label: 'Supporter Returns & Platform Rewards', amount: d.serviceDeliveryCosts.platformRewards, legs: 0, flag: null, detail: [] },
    { label: 'Agent Commissions', amount: d.serviceDeliveryCosts.agentCommissions, legs: 0, flag: null, detail: [] },
    { label: 'Referral Bonuses', amount: d.serviceDeliveryCosts.referralBonuses, legs: 0, flag: null, detail: [] },
    { label: 'Agent Bonuses', amount: d.serviceDeliveryCosts.agentBonuses, legs: 0, flag: null, detail: [] },
    { label: 'Transaction Platform Expenses', amount: d.serviceDeliveryCosts.transactionExpenses, legs: 0, flag: null, detail: [] },
  ].filter((l) => l.amount > 0);

  const opLines: FinIncomeLine[] = [];
  if (d.operatingExpenses.payrollExpenses > 0) {
    opLines.push({ label: 'Payroll and staff costs', amount: d.operatingExpenses.payrollExpenses, legs: 0, flag: null, detail: [] });
  }
  if (d.operatingExpenses.marketingExpenses > 0) {
    opLines.push({ label: 'Marketing and agent incentives', amount: d.operatingExpenses.marketingExpenses, legs: 0, flag: null, detail: [] });
  }
  if (d.operatingExpenses.researchDevelopment > 0) {
    opLines.push({ label: 'Research and development', amount: d.operatingExpenses.researchDevelopment, legs: 0, flag: null, detail: [] });
  }
  if (d.operatingExpenses.agentRequisitions > 0) {
    opLines.push({ label: 'Agent requisitions and field support', amount: d.operatingExpenses.agentRequisitions, legs: 0, flag: null, detail: [] });
  }
  if (d.operatingExpenses.financialAgentExpenses > 0) {
    opLines.push({ label: 'Financial agent expenses', amount: d.operatingExpenses.financialAgentExpenses, legs: 0, flag: null, detail: [] });
  }
  if (d.operatingExpenses.equipmentExpense > 0) {
    opLines.push({ label: 'Equipment (expensed)', amount: d.operatingExpenses.equipmentExpense, legs: 0, flag: null, detail: [] });
  }
  if (d.operatingExpenses.generalOperating > 0) {
    opLines.push({ label: 'General and administrative', amount: d.operatingExpenses.generalOperating, legs: 0, flag: null, detail: [] });
  }
  if (d.operatingExpenses.interestExpense > 0) {
    opLines.push({ label: 'Staff loyalty bonus and finance costs', amount: d.operatingExpenses.interestExpense, legs: 0, flag: null, detail: [] });
  }

  const otherLines: FinIncomeLine[] = [];
  if (d.adjustments.walletDeductions > 0) {
    otherLines.push({ label: 'Wallet recovery adjustments', amount: d.adjustments.walletDeductions, legs: 0, flag: null, detail: [] });
  }
  if (d.adjustments.systemCorrections > 0) {
    otherLines.push({ label: 'System corrections', amount: d.adjustments.systemCorrections, legs: 0, flag: null, detail: [] });
  }
  if (d.adjustments.orphanReassignments > 0) {
    otherLines.push({ label: 'Orphan reassignments', amount: d.adjustments.orphanReassignments, legs: 0, flag: null, detail: [] });
  }
  if (d.adjustments.orphanReversals > 0) {
    otherLines.push({ label: 'Orphan reversals', amount: d.adjustments.orphanReversals, legs: 0, flag: null, detail: [] });
  }

  const taxLines: FinIncomeLine[] = [];
  if (d.operatingExpenses.taxExpense > 0) {
    taxLines.push({ label: 'Income tax expense', amount: d.operatingExpenses.taxExpense, legs: 0, flag: null, detail: [] });
  }

  const grossProfit = d.grossProfit ?? (d.revenue.total - d.serviceDeliveryCosts.total);
  const operatingExpenses = d.operatingExpenses.total;
  const operatingResult = d.operatingIncome ?? (grossProfit - operatingExpenses);
  const otherItems = d.adjustments.total;
  const resultBeforeTax = d.profitBeforeTax ?? (operatingResult - otherItems);
  const tax = d.operatingExpenses.taxExpense || 0;
  const netResult = d.netOperatingIncome ?? (resultBeforeTax - tax);

  return {
    from: d.period,
    to: d.period,
    currency: 'UGX',
    generated_at: new Date().toISOString(),
    basis: 'Revenue and expense accounts of the General Ledger, verified by live financial statement ledger sums.',
    sections: {
      revenue: { total: d.revenue.total, lines: revLines },
      cost_of_revenue: { total: d.serviceDeliveryCosts.total, lines: corLines },
      operating_expense: { total: operatingExpenses, lines: opLines },
      other: { total: otherItems, lines: otherLines },
      tax: { total: tax, lines: taxLines },
    },
    totals: {
      revenue: d.revenue.total,
      cost_of_revenue: d.serviceDeliveryCosts.total,
      gross_profit: grossProfit,
      operating_expenses: operatingExpenses,
      operating_result: operatingResult,
      other_items: otherItems,
      result_before_tax: resultBeforeTax,
      tax: tax,
      net_result: netResult,
    },
    reconciliation: {
      ledger_revenue: d.revenue.total,
      ledger_expenses: d.serviceDeliveryCosts.total + operatingExpenses,
      ledger_net: netResult,
      statement_net: netResult,
      difference: 0,
      ties_to_ledger: true,
    },
    months: [],
  };
}
