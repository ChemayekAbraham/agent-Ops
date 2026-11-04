import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

/**
 * Merchandise receivables as the balance sheet carries them (A12 + A13), per order, from
 * get_merchandise_receivables_reconciliation (migration 20261104180000). Read-only.
 *
 * - ledger_receivable: what the ledger carries for the order (principal) - the figure that is on the balance sheet.
 * - plan_balance: what the agent still owes on the plan, future monthly charges included. The difference is not yet a
 *   receivable (charges are income when collected) or is company stock awaiting recognition.
 */
export interface MerchReconOrder {
  sale_id: string;
  item_name: string;
  category: 'boutique' | 'smart_phone' | 'motor_bike' | 'signage' | string;
  order_status: string;
  issued: boolean;
  customer_id: string | null;
  customer: string | null;
  phone: string | null;
  quantity: number;
  price: number;
  paid: number;
  sale_date: string;
  account: 'A12' | 'A13';
  ledger_receivable: number;
  plan_balance: number;
  not_in_ledger: number;
  awaiting_recognition: number;
  no_customer_account: boolean;
  note: 'awaiting_recognition' | 'bike_paid_differs_from_value' | 'future_charges' | 'ledger_above_plan' | 'not_issued_ledger_balance' | null;
}

export interface MerchReconOrphanPlan {
  plan_id: string;
  item_name: string | null;
  customer_id: string | null;
  customer: string | null;
  status: string;
  plan_balance: number;
  ledger_receivable: number;
  account: 'A12' | 'A13';
}

export interface MerchReconTotals {
  issued_orders: number;
  issued_value: number;
  plan_balance_issued: number;
  ledger_issued: number;
  awaiting_recognition: number;
  not_in_ledger_other: number;
  ledger_not_issued: number;
  ledger_orphan_plans: number;
  ledger_total: number;
}

export interface MerchRecon {
  as_at: string;
  orders: MerchReconOrder[];
  orphan_plans: MerchReconOrphanPlan[];
  awaiting_issue: { count: number; value: number };
  totals: MerchReconTotals;
  balance_sheet: { a12: number; a13: number; total: number; difference: number } | null;
}

const num = (v: unknown) => Number(v ?? 0) || 0;

function normalise(raw: unknown): MerchRecon {
  const r = (raw ?? {}) as Record<string, any>;
  const t = (r.totals ?? {}) as Record<string, unknown>;
  return {
    as_at: String(r.as_at ?? ''),
    orders: ((r.orders ?? []) as any[]).map((o) => ({
      ...o,
      quantity: num(o.quantity), price: num(o.price), paid: num(o.paid),
      ledger_receivable: num(o.ledger_receivable), plan_balance: num(o.plan_balance),
      not_in_ledger: num(o.not_in_ledger), awaiting_recognition: num(o.awaiting_recognition),
      no_customer_account: Boolean(o.no_customer_account), issued: Boolean(o.issued),
    })),
    orphan_plans: ((r.orphan_plans ?? []) as any[]).map((p) => ({
      ...p, plan_balance: num(p.plan_balance), ledger_receivable: num(p.ledger_receivable),
    })),
    awaiting_issue: { count: num(r.awaiting_issue?.count), value: num(r.awaiting_issue?.value) },
    totals: {
      issued_orders: num(t.issued_orders), issued_value: num(t.issued_value), plan_balance_issued: num(t.plan_balance_issued),
      ledger_issued: num(t.ledger_issued), awaiting_recognition: num(t.awaiting_recognition),
      not_in_ledger_other: num(t.not_in_ledger_other), ledger_not_issued: num(t.ledger_not_issued),
      ledger_orphan_plans: num(t.ledger_orphan_plans), ledger_total: num(t.ledger_total),
    },
    balance_sheet: r.balance_sheet
      ? { a12: num(r.balance_sheet.a12), a13: num(r.balance_sheet.a13), total: num(r.balance_sheet.total), difference: num(r.balance_sheet.difference) }
      : null,
  };
}

async function fetchRecon(withBalanceSheet: boolean): Promise<MerchRecon> {
  const { data, error } = await supabase.rpc('get_merchandise_receivables_reconciliation' as any, { p_with_balance_sheet: withBalanceSheet });
  if (error) throw error;
  return normalise(data);
}

/** Per-order figures (fast). */
export function useMerchandiseReceivablesReconciliation(enabled = true) {
  return useQuery({
    queryKey: ['merchandise-receivables-reconciliation'],
    queryFn: () => fetchRecon(false),
    enabled,
    staleTime: 60_000,
  });
}

/** The same, tied to A12 + A13 on the Statement of Financial Position (slow: runs the balance-sheet resolver). */
export function useMerchandiseReceivablesBalanceSheetTie(enabled = true) {
  return useQuery({
    queryKey: ['merchandise-receivables-reconciliation', 'balance-sheet'],
    queryFn: () => fetchRecon(true),
    enabled,
    staleTime: 5 * 60_000,
  });
}
